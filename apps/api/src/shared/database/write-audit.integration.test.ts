// Integration coverage for oee.write_audit's monthly partitioning (0012), against
// a REAL Postgres.
//
// WHY A fakeSql SUITE CANNOT COVER ANY OF THIS
//
// There is no TypeScript in the edit path that touches write_audit at all — the
// rows arrive from oee.log_write(), a plpgsql trigger, and the routing that puts
// each row in the right month is Postgres's own. So every claim 0012 makes is a
// claim about the DATABASE, and the only way to check one is to ask a database.
//
// WHAT IS ACTUALLY AT RISK HERE, and it is not the audit log
//
// A partitioned table REJECTS an insert with no matching partition. 0004 attached
// a trigger pair to twelve Gold tables, so if routing ever fails, the failure is
// not "the audit trail has a gap" — it is EVERY WRITE TO GOLD RAISING, including
// the pipeline's nightly loads and both operator mutations. 0012's DEFAULT
// partition is the guard, and `defaults to DEFAULT rather than raising` below is
// the single most consequential assertion in this file.
//
// ONE HAZARD THIS FILE IS DELIBERATELY SHAPED AROUND
//
// prune_write_audit() DROPS TABLES, in a database whose other integration suites
// are inserting into audited tables in parallel worker processes. Dropping a
// partition another file's trigger is about to target would fail that file's test
// for a reason nothing in it explains.
//
// It is safe here for a specific reason, and only for that reason: a live audited
// write gets `at = now()`, so it always targets the CURRENT month. Pruning only
// ever removes partitions strictly older than the cutoff, so with a retention
// window of a year or more no concurrent write can be aimed at anything dropped.
// Hence this file NEVER calls prune with a small retain_months, and asserts the
// current month survives — which is worth pinning on its own.
//
//   docker run -d --name oee-itest-pg -e POSTGRES_PASSWORD=postgres \
//     -e POSTGRES_USER=postgres -e POSTGRES_DB=gold_test -p 55433:5432 postgres:18-alpine
//   GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test \
//     node scripts/migrate.mjs
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test vp run api#test
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "./postgres.js";

import type { GoldDB } from "./postgres.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// Months far outside 0012's created window (13 back, 12 forward), so nothing this
// file creates or drops can collide with a partition a live write would target.
// Two distinct months, because the two cases are mutually exclusive: a month can
// have a partition, or be caught by DEFAULT, not both.
const PRUNABLE_MONTH = "2019_03";
const PRUNABLE_AT = "2019-03-15T00:00:00.000Z";
const UNPARTITIONED_AT = "2018-01-20T00:00:00.000Z";

// Tags the rows this file owns, so cleanup never touches another suite's.
const MARKER = "write-audit-itest";

describe.skipIf(!url)("oee.write_audit partitioning", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  async function cleanup() {
    await db`DELETE FROM oee.write_audit WHERE table_name = ${MARKER}`;

    // The drop is not optional: this partition is created per test, so a leftover
    // from a killed run would silently become a fixture and the routing and
    // pruning tests below would pass for the wrong reason.
    //
    // But it is guarded by a catalogue check rather than spelled `DROP TABLE IF
    // EXISTS`, which is the obvious way to write it. IF EXISTS makes Postgres
    // raise a NOTICE when the table is absent — the common case, since only four
    // tests create it — and postgres.js prints notices to stdout. That is eleven
    // lines of "does not exist, skipping" per run, in the log somebody reads when
    // something here actually fails. Same guarantee, quietly.
    const [existing] = await db<{ found: number }[]>`
      SELECT count(*)::int AS found
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'oee' AND c.relname = ${`write_audit_${PRUNABLE_MONTH}`}
    `;

    if ((existing?.found ?? 0) > 0) {
      await db.unsafe(`DROP TABLE oee.write_audit_${PRUNABLE_MONTH}`);
    }
  }

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  beforeEach(cleanup);

  // Inserted directly rather than through a trigger: `at` is what decides routing
  // and the trigger always stamps now(), so a direct insert is the only way to
  // place a row in a chosen month.
  async function auditRow(at: string) {
    const [row] = await db<{ partition: string }[]>`
      INSERT INTO oee.write_audit (at, table_name, operation, db_user)
      VALUES (${at}, ${MARKER}, 'INSERT', 'itest')
      RETURNING tableoid::regclass::text AS partition
    `;
    return row!.partition;
  }

  describe("the shape 0012 leaves behind", () => {
    it("partitions by range on `at`", async () => {
      const [row] = await db<{ strategy: string; key: string }[]>`
        SELECT p.partstrat AS strategy,
               pg_get_partkeydef(c.oid) AS key
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'oee' AND c.relname = 'write_audit'
      `;

      // 'r' for RANGE. LIST would mean somebody reshaped this to exempt operator
      // rows from retention, which 0012's header explains was decided against.
      expect(row).toEqual({ strategy: "r", key: "RANGE (at)" });
    });

    // Not cosmetic, and not negotiable: Postgres rejects a unique constraint on a
    // partitioned table that omits the partition key, so PRIMARY KEY (id) could
    // not have survived 0012. Pinned because a future migration "restoring" the
    // single-column key would fail in a way whose error text points at the
    // constraint rather than at partitioning.
    it("carries a composite primary key including the partition key", async () => {
      const [row] = await db<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE conname = 'write_audit_pkey'
      `;

      expect(row?.def).toBe("PRIMARY KEY (id, at)");
    });

    // Declared on the parent so Postgres propagates them to partitions created
    // later. If they were ever declared per-partition instead, a new month would
    // arrive unindexed and the two queries this table exists to answer would
    // silently turn into sequential scans over the newest, largest partition.
    it("propagates the parent's indexes to a partition created afterwards", async () => {
      await db.unsafe(`
        CREATE TABLE oee.write_audit_${PRUNABLE_MONTH}
        PARTITION OF oee.write_audit
        FOR VALUES FROM ('2019-03-01') TO ('2019-04-01')
      `);

      const rows = await db<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'oee'
          AND c.relname = ${`write_audit_${PRUNABLE_MONTH}`}
      `;

      // The primary key plus write_audit_ix_table_at plus write_audit_ix_row_key.
      expect(rows[0]?.n).toBe(3);
    });
  });

  describe("routing", () => {
    it("sends a row to the partition matching its month", async () => {
      await db.unsafe(`
        CREATE TABLE oee.write_audit_${PRUNABLE_MONTH}
        PARTITION OF oee.write_audit
        FOR VALUES FROM ('2019-03-01') TO ('2019-04-01')
      `);

      expect(await auditRow(PRUNABLE_AT)).toBe(`oee.write_audit_${PRUNABLE_MONTH}`);
    });

    // THE ONE THAT MATTERS. Without a DEFAULT partition this insert raises
    // "no partition of relation ... found for row", and because twelve tables'
    // triggers insert here, that error surfaces as every write to Gold failing —
    // the pipeline's loads included. The DEFAULT partition converts a missing
    // month from an outage into rows filed in the wrong place.
    it("defaults to DEFAULT rather than raising when no month matches", async () => {
      expect(await auditRow(UNPARTITIONED_AT)).toBe("oee.write_audit_default");
    });

    // The trigger is the only real writer, and it stamps now() — so this is the
    // assertion that the CURRENT month always has somewhere to go. It is what
    // makes the pruning test above safe to run beside other suites.
    it("routes a live trigger write into the current month", async () => {
      const workUnitId = -98_765;
      await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${workUnitId}`;

      await db`
        INSERT INTO oee.work_unit_shift_report_approvals
          (work_unit_id, date, shift, status, closed_at, closed_by, closed_by_name, source)
        VALUES (${workUnitId}, now(), 1, 'closed', now(), 'itest-sub', 'Itest', 'operator')
      `;

      const [row] = await db<{ partition: string }[]>`
        SELECT tableoid::regclass::text AS partition
        FROM oee.write_audit
        WHERE table_name = 'work_unit_shift_report_approvals'
        ORDER BY id DESC LIMIT 1
      `;

      const expected = await db<{ name: string }[]>`
        SELECT 'oee.write_audit_' || to_char(now(), 'YYYY_MM') AS name
      `;

      expect(row?.partition).toBe(expected[0]?.name);

      await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${workUnitId}`;
    });
  });

  describe("prune_write_audit", () => {
    // 24 rather than 12 throughout: it still puts the 2019 partition well past the
    // cutoff, while leaving a wider margin of recent months untouched for whatever
    // else is running against this database.
    const RETAIN_MONTHS = 24;

    it("drops an out-of-retention partition and reports what went with it", async () => {
      await db.unsafe(`
        CREATE TABLE oee.write_audit_${PRUNABLE_MONTH}
        PARTITION OF oee.write_audit
        FOR VALUES FROM ('2019-03-01') TO ('2019-04-01')
      `);
      await auditRow(PRUNABLE_AT);
      await auditRow(PRUNABLE_AT);

      const dropped = await db<{ droppedPartition: string; rowsDropped: string }[]>`
        SELECT dropped_partition, rows_dropped FROM oee.prune_write_audit(${RETAIN_MONTHS})
      `;

      // camelCase keys, not the snake_case the function returns: the pool is
      // built with postgres.js's column transform (shared/database/postgres.ts),
      // so every result key arrives converted no matter what SQL called it.
      //
      // rows_dropped is a bigint, which postgres.js hands back as a STRING rather
      // than a number — bigint does not fit a JS number safely, so the driver
      // refuses to guess. Asserted as "2" deliberately.
      expect(dropped).toContainEqual({
        droppedPartition: `write_audit_${PRUNABLE_MONTH}`,
        rowsDropped: "2",
      });

      const gone = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'oee' AND c.relname = ${`write_audit_${PRUNABLE_MONTH}`}
      `;
      expect(gone[0]?.n).toBe(0);
    });

    // Dropping DEFAULT would remove the guard the routing test above depends on,
    // and its contents are by definition rows whose month nobody created — the
    // one thing that must survive a prune, since it cannot be reconstructed.
    it("never drops the DEFAULT partition, nor the rows in it", async () => {
      await auditRow(UNPARTITIONED_AT);

      await db`SELECT * FROM oee.prune_write_audit(${RETAIN_MONTHS})`;

      const rows = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM oee.write_audit_default
        WHERE table_name = ${MARKER}
      `;
      expect(rows[0]?.n).toBe(1);
    });

    it("leaves the current month's partition in place", async () => {
      await db`SELECT * FROM oee.prune_write_audit(${RETAIN_MONTHS})`;

      const rows = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'oee'
          AND c.relname = 'write_audit_' || to_char(now(), 'YYYY_MM')
      `;
      expect(rows[0]?.n).toBe(1);
    });
  });

  // The reason to care about DEFAULT filling up: Postgres scans it when attaching
  // a new partition and REFUSES if any row would belong to the incoming range. So
  // rows accumulating here quietly turn a future CREATE PARTITION from one DDL
  // statement into a data move, and this function is how that gets noticed.
  describe("write_audit_default_backlog", () => {
    it("reports the months sitting in DEFAULT", async () => {
      await auditRow(UNPARTITIONED_AT);

      const rows = await db<{ month: string; rows: string }[]>`
        SELECT month, rows FROM oee.write_audit_default_backlog()
      `;

      expect(rows.some((r) => r.month === "2018_01")).toBe(true);
    });

    // Proves the hazard the function exists to warn about is real, rather than a
    // caution copied out of the documentation.
    it("blocks attaching a partition whose range overlaps rows in DEFAULT", async () => {
      await auditRow(UNPARTITIONED_AT);

      await expect(
        db.unsafe(`
          CREATE TABLE oee.write_audit_2018_01
          PARTITION OF oee.write_audit
          FOR VALUES FROM ('2018-01-01') TO ('2018-02-01')
        `),
      ).rejects.toThrow(/default partition/i);
    });
  });
});
