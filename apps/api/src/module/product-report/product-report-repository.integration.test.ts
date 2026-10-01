// Integration coverage for the SKU grain, against a REAL Postgres.
//
// Why this file exists and the fakeSql suite next to it is not enough: that fake
// matches SQL TEXT and never executes it, so it cannot see a wrong number. What
// this grain gets wrong, it gets wrong ARITHMETICALLY — an unattributed count
// taken over the wrong row set, a half-open range that is inclusive at both ends,
// a two-unit split that adds cartons to bags. None of those throw. They render a
// plausible screen.
//
// Runs only when GOLD_TEST_DATABASE_URL points at a throwaway database with the
// `oee` schema applied (scripts/migrate.mjs does that). Skipped otherwise, so a
// developer without Docker still gets a green `vp test`.
//
//   docker run -d --name oee-itest-pg -e POSTGRES_PASSWORD=postgres \
//     -e POSTGRES_USER=postgres -e POSTGRES_DB=gold_test -p 55433:5432 postgres:18-alpine
//   GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test \
//     node scripts/migrate.mjs
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test vp run api#test
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "../../shared/database/postgres.js";
import { ProductReportReaderRepository } from "./product-report-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { ProductWindow } from "./product-report.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// Sentinels of this file's own, so it cannot collide with the dev seeds or with
// the other integration suites.
const LINE = 8801;
const OTHER_LINE = 8802;
const SKU = 7701;
const OTHER_SKU = 7702;
const DATE = "2026-08-19";

function window(overrides: Partial<ProductWindow> = {}): ProductWindow {
  return {
    workCenterId: LINE,
    dateFrom: DATE,
    dateTo: "2026-08-20",
    shift: null,
    timeZone: "Asia/Jakarta",
    productId: SKU,
    ...overrides,
  };
}

describe.skipIf(!url)("ProductReportReaderRepository against a real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new ProductReportReaderRepository({ goldDb: db });

  async function clean() {
    await db`DELETE FROM oee.product_report_wc_day WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.reject_count_wc_shift  WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.downtime_reports       WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    // BY source_event_id, because oee.downtime_report_history carries no line.
    // Deleting the stops above does not cascade — there are no foreign keys in
    // `oee` (0003) — so a trail would survive its subject and leak into the next
    // test, which is exactly what the append-only design intends everywhere else.
    await db`DELETE FROM oee.downtime_report_history WHERE source_event_id LIKE 'itest-%'`;
    await db`DELETE FROM oee.work_unit_shift_reports  WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
  }

  afterAll(async () => {
    await clean();
    await db.end();
  });
  beforeEach(clean);

  // Every duration is NOT NULL, so a fixture must supply them; they are zero
  // because these tests read counts, units and ids rather than the waterfall.
  async function report(opts: {
    workCenterId?: number;
    productId?: number;
    businessDate?: string;
    totalOut?: number | null;
    goodOut?: number | null;
    infeedUomId?: number | null;
    outputUomId?: number | null;
    oee?: number | null;
  }) {
    const rows = await db<{ id: number }[]>`
      INSERT INTO oee.product_report_wc_day (
        work_center_id, business_date, product_id, time_zone,
        work_center_name, work_center_code, product_name, product_code,
        infeed_uom_id, infeed_uom_code, output_uom_id, output_uom_code,
        oee, total_out, good_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      ) VALUES (
        ${opts.workCenterId ?? LINE}, ${opts.businessDate ?? DATE}::date,
        ${opts.productId ?? SKU}, 'Asia/Jakarta',
        'Line X', 'LX', 'SKU X', 'SKU-X',
        ${opts.infeedUomId === undefined ? 1 : opts.infeedUomId}, 'BAG',
        ${opts.outputUomId === undefined ? 42 : opts.outputUomId}, 'CTN',
        ${opts.oee === undefined ? 80 : opts.oee},
        ${opts.totalOut === undefined ? 1000 : opts.totalOut},
        ${opts.goodOut === undefined ? 80 : opts.goodOut},
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async function stop(opts: {
    productId: number | null;
    workCenterId?: number;
    date?: string;
    // NULL is a REAL CASE, not a gap: 0007's dev seed leaves one stop without a
    // source_event_id so the disabled-Edit state is reachable, and a stop with no
    // stable id can never carry a trail — which is the whole distinction
    // listDowntimeEdits' two counts draw.
    sourceEventId?: string | null;
    workUnitId?: number;
    workUnitName?: string;
  }) {
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, work_unit_name, shift, start_at, end_at,
         work_center_id, business_date, product_id, source_event_id)
      VALUES ('["r"]'::jsonb, 'UNPLANNED'::oee.operation_type,
              ${opts.workUnitId ?? 1}, ${opts.workUnitName ?? null}, 1,
              '2026-08-19T02:00:00Z', '2026-08-19T02:10:00Z',
              ${opts.workCenterId ?? LINE}, ${opts.date ?? DATE}::date, ${opts.productId},
              ${opts.sourceEventId === undefined ? null : opts.sourceEventId})
    `;
  }

  // A recorded change to a stop, keyed on its source_event_id — the join
  // listDowntimeEdits makes. Nothing here writes oee.downtime_reports, so the two
  // are only ever related through that column.
  async function edit(sourceEventId: string, field = "category") {
    await db`
      INSERT INTO oee.downtime_report_history
        (source_event_id, field, old_value, new_value, changed_by, changed_at)
      VALUES (${sourceEventId}, ${field}, '"PLANNED"'::jsonb, '"UNPLANNED"'::jsonb,
              'kc-1', now())
    `;
  }

  // A machine shift report, for the roster read. `date` is the instant the shift
  // STARTED — the column that read scopes on, because business_date is nullable
  // and unbackfilled on this table (§46).
  async function machineShift(opts: {
    workUnitId: number;
    workUnitName: string;
    date: string;
    workCenterId?: number;
  }) {
    // EVERY MEASURE IS NOT NULL on this table, so a fixture has to supply them all.
    // They are zero because this read projects work_unit_id and work_unit_name and
    // nothing else — it is a ROSTER, not a breakdown.
    await db`
      INSERT INTO oee.work_unit_shift_reports (
        work_unit_id, work_unit_name, work_center_id, work_center_name,
        shift, date, time_zone, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out, reject, rework,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      ) VALUES (
        ${opts.workUnitId}, ${opts.workUnitName},
        ${opts.workCenterId ?? LINE}, 'Line X',
        1, ${opts.date}::timestamptz, 'Asia/Jakarta', 1,
        0,0,0,0,0,
        0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      )
    `;
  }

  describe("getReport", () => {
    it("returns undefined for an id that names nothing", async () => {
      // The service turns this into a 404. The LIST answers 200-empty instead —
      // an id names a row that exists or does not; a filter describes a set.
      expect(await repo.getReport(999_999_999)).toBeUndefined();
    });

    // The casts are the load-bearing part: postgres.js hands `numeric` back as a
    // STRING and `bigint` likewise. Without them the browser renders "80.000%"
    // and sorts it lexicographically, and durations concatenate rather than add.
    it("returns numbers, not the strings postgres.js hands back", async () => {
      const id = await report({});

      const found = (await repo.getReport(id))!;

      expect(typeof found.oee).toBe("number");
      expect(typeof found.totalOut).toBe("number");
      expect(typeof found.runtime).toBe("number");
    });

    // A NULL unit at this grain means "not known" — 0014's "the members
    // disagreed" has no analogue, because a SKU report has no members. Either way
    // it must arrive as null so the browser renders an em dash; a coalesce would
    // report a measurement of zero.
    it("carries a null unit and its null counts through uncoalesced", async () => {
      const id = await report({ infeedUomId: null, totalOut: null, oee: null });

      const found = (await repo.getReport(id))!;

      expect(found.infeedUomId).toBeNull();
      expect(found.totalOut).toBeNull();
      expect(found.oee).toBeNull();
    });
  });

  describe("paginateReport", () => {
    async function list(filter: Record<string, unknown>) {
      return await repo.paginateReport({
        limit: 20,
        offset: 0,
        filter: {
          month: undefined,
          year: undefined,
          workCenterId: undefined,
          productId: undefined,
          isHideZero: false,
          ...filter,
        } as never,
      });
    }

    it("answers an empty page for a line with no rows, rather than failing", async () => {
      expect(await list({ workCenterId: OTHER_LINE })).toEqual({ items: [], totalElements: 0 });
    });

    // THE CASE THE WHOLE REPORT EXISTS FOR: one SKU, one date, two lines.
    it("returns one row per line for the same SKU on the same date", async () => {
      await report({ workCenterId: LINE });
      await report({ workCenterId: OTHER_LINE });

      const { items, totalElements } = await list({ productId: SKU });

      expect(totalElements).toBe(2);
      expect(items.map((i) => i.workCenterId).sort((a, b) => a - b)).toEqual([LINE, OTHER_LINE]);
    });

    it("narrows to one SKU when asked", async () => {
      await report({ productId: SKU });
      await report({ productId: OTHER_SKU });

      const { items } = await list({ productId: OTHER_SKU });

      expect(items.map((i) => i.productId)).toEqual([OTHER_SKU]);
    });

    // THREE-VALUED LOGIC, DELIBERATE. `NULL <> 0` is NULL rather than true, so
    // hide-zero hides a NULL-OEE row as well as a zero one — which is right,
    // because an undefined row is an idle row. Do not "fix" this into
    // IS DISTINCT FROM 0.
    it("hides both the zero-OEE and the null-OEE rows when hiding zeroes", async () => {
      await report({ productId: SKU, oee: 0 });
      await report({ productId: OTHER_SKU, oee: null });
      await report({ productId: 7703, oee: 55 });

      const { items } = await list({ isHideZero: true });

      expect(items.map((i) => i.productId)).toEqual([7703]);
    });
  });

  // THE COUNT THAT WOULD BE 0 FOREVER IF IT SHARED THE PRODUCT PREDICATE.
  describe("countUnattributedDowntime", () => {
    it("counts only the stops with no SKU, on this line, in this window", async () => {
      await stop({ productId: null });
      await stop({ productId: null });
      await stop({ productId: SKU });
      // Another line's unattributed stop, and another date's — neither is this
      // report's business.
      await stop({ productId: null, workCenterId: OTHER_LINE });
      await stop({ productId: null, date: "2026-08-20" });

      expect(await repo.countUnattributedDowntime(window())).toEqual({ unattributed: 2 });
    });

    // The state the pipeline is actually in today: the column exists and nothing
    // writes it. Every stop is unattributed, the SKU's own downtime reads empty,
    // and the count is what stops the screen calling that "no stops".
    it("counts every stop when the pipeline has attributed none", async () => {
      await stop({ productId: null });
      await stop({ productId: null });
      await stop({ productId: null });

      expect(await repo.countUnattributedDowntime(window())).toEqual({ unattributed: 3 });
    });

    it("is zero once every stop carries a SKU", async () => {
      await stop({ productId: SKU });
      await stop({ productId: OTHER_SKU });

      expect(await repo.countUnattributedDowntime(window())).toEqual({ unattributed: 0 });
    });

    // HALF-OPEN. A stop on the 20th belongs to the 20th's report. `BETWEEN` here
    // would count it twice — once on each day — and the two reports would each
    // look right on their own.
    it("excludes a stop on the window's exclusive end date", async () => {
      await stop({ productId: null, date: "2026-08-20" });

      expect(await repo.countUnattributedDowntime(window())).toEqual({ unattributed: 0 });
    });
  });

  describe("aggregateRejectReasons", () => {
    async function reject(opts: { productId: number; reason: string; value: number }) {
      await db`
        INSERT INTO oee.reject_count_wc_shift
          (work_center_id, business_date, shift, product_id, reason,
           work_center_name, uom_id, uom_code, counter_value,
           base_uom_id, base_uom_code, factor_to_base, frequency, time_zone)
        VALUES (${LINE}, ${DATE}::date, 1, ${opts.productId}, ${opts.reason},
                'Line X', 1, 'BAG', ${opts.value}, 1, 'BAG', 1, 1, 'Asia/Jakarta')
      `;
    }

    // The SKU's own rejects, not the line's. Reading the line's would make the
    // Quality Pareto disagree with the Reject tile on the same screen — the
    // "two right answers to one question" 0019 was created to end.
    it("counts only this SKU's rejects", async () => {
      await reject({ productId: SKU, reason: "Seal_Leak", value: 40 });
      await reject({ productId: OTHER_SKU, reason: "Seal_Leak", value: 900 });

      const out = await repo.aggregateRejectReasons(window());

      expect(out.buckets.map((b) => [b.reason, b.quantity])).toEqual([["Seal_Leak", 40]]);
      expect(out.totalQuantity).toBe(40);
    });

    it("widens over all three shifts of the day", async () => {
      await reject({ productId: SKU, reason: "Seal_Leak", value: 10 });
      await db`
        INSERT INTO oee.reject_count_wc_shift
          (work_center_id, business_date, shift, product_id, reason,
           work_center_name, uom_id, uom_code, counter_value,
           base_uom_id, base_uom_code, factor_to_base, frequency, time_zone)
        VALUES (${LINE}, ${DATE}::date, 3, ${SKU}, 'Seal_Leak',
                'Line X', 1, 'BAG', 5, 1, 'BAG', 1, 1, 'Asia/Jakarta')
      `;

      const out = await repo.aggregateRejectReasons(window());

      expect(out.totalQuantity).toBe(15);
    });
  });

  // -------------------------------------------------------------------------
  // listDowntimeEdits — the activity feed's downtime arm
  // -------------------------------------------------------------------------
  //
  // THE ARITHMETIC-CLASS FAILURE THIS BLOCK EXISTS FOR is the unattributed stop
  // vanishing. `product_id = $` is FALSE for NULL rather than
  // unknown-but-included, so a stop the pipeline has not attributed is absent from
  // the entries AND from both member counts — and with 0020's column unwritten
  // that is EVERY stop. The panel then reads "no downtime edits" where the truth
  // is "no stop on this line belongs to any SKU", and the fakeSql suite cannot see
  // the difference because it never executes anything.
  describe("listDowntimeEdits", () => {
    it("returns only the trail of stops attributed to this SKU", async () => {
      await stop({ productId: SKU, sourceEventId: "itest-a", workUnitName: "Packer A" });
      await stop({ productId: OTHER_SKU, sourceEventId: "itest-b" });
      await stop({ productId: null, sourceEventId: "itest-c" });
      await edit("itest-a");
      await edit("itest-b");
      await edit("itest-c");

      const { entries } = await repo.listDowntimeEdits(window());

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "downtime",
        sourceEventId: "itest-a",
        field: "category",
        workUnitName: "Packer A",
      });
    });

    // The two counts are over THIS SKU's stops, not the line's — so the same
    // exclusion applies, and the residual is what
    // countUnattributedDowntime reports instead.
    it("counts only this SKU's stops, and the unattributed one is left to the residual", async () => {
      await stop({ productId: SKU, sourceEventId: "itest-a" });
      await stop({ productId: OTHER_SKU, sourceEventId: "itest-b" });
      await stop({ productId: null, sourceEventId: "itest-c" });

      const counts = await repo.listDowntimeEdits(window());
      const residual = await repo.countUnattributedDowntime(window());

      expect(counts.totalMembers).toBe(1);
      expect(residual.unattributed).toBe(1);
    });

    // count(*) VS count(source_event_id) — the whole distinction the pair exists
    // to draw. A stop with no stable id is a member that can NEVER carry a trail,
    // which is a different answer from "nobody has edited it".
    it("separates every member from the trackable half", async () => {
      await stop({ productId: SKU, sourceEventId: "itest-a" });
      await stop({ productId: SKU, sourceEventId: null });

      const { totalMembers, trackedMembers, entries } = await repo.listDowntimeEdits(window());

      expect(totalMembers).toBe(2);
      expect(trackedMembers).toBe(1);
      expect(entries).toHaveLength(0);
    });

    it("does not reach another line's stops", async () => {
      await stop({ productId: SKU, workCenterId: OTHER_LINE, sourceEventId: "itest-x" });
      await edit("itest-x");

      const { entries, totalMembers } = await repo.listDowntimeEdits(window());

      expect(entries).toHaveLength(0);
      expect(totalMembers).toBe(0);
    });

    // HALF-OPEN over business_date. A BETWEEN would pull the next day's first
    // stops into this report — the class of error that renders a plausible total.
    it("excludes the day after the window", async () => {
      await stop({ productId: SKU, date: "2026-08-20", sourceEventId: "itest-next" });
      await edit("itest-next");

      const { entries, totalMembers } = await repo.listDowntimeEdits(window());

      expect(entries).toHaveLength(0);
      expect(totalMembers).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // listMachineRoster — the reject dialog's Machine picker
  // -------------------------------------------------------------------------
  //
  // SCOPED ON `date`, THE SHIFT'S START INSTANT, and the boundary is what this
  // block is for: an off-by-one omits a machine from the picker, and the operator
  // then simply cannot name where they saw the rejects. Half-open, never an
  // equality — a row written a millisecond off the boundary would be skipped.
  describe("listMachineRoster", () => {
    const DAY = {
      from: new Date("2026-08-18T17:00:00.000Z"),
      to: new Date("2026-08-19T17:00:00.000Z"),
    };

    it("returns each machine on the line once, whatever it reported", async () => {
      await machineShift({
        workUnitId: 11,
        workUnitName: "Packer A",
        date: "2026-08-18T17:00:00Z",
      });
      await machineShift({
        workUnitId: 11,
        workUnitName: "Packer A",
        date: "2026-08-19T01:00:00Z",
      });
      await machineShift({
        workUnitId: 12,
        workUnitName: "Packer B",
        date: "2026-08-19T09:00:00Z",
      });

      const { machines } = await repo.listMachineRoster(DAY, LINE);

      expect(machines).toEqual([
        { workUnitId: 11, workUnitName: "Packer A" },
        { workUnitId: 12, workUnitName: "Packer B" },
      ]);
    });

    it("includes the row exactly on the lower bound and excludes the upper one", async () => {
      await machineShift({ workUnitId: 11, workUnitName: "In", date: "2026-08-18T17:00:00Z" });
      await machineShift({ workUnitId: 12, workUnitName: "Out", date: "2026-08-19T17:00:00Z" });

      const { machines } = await repo.listMachineRoster(DAY, LINE);

      expect(machines).toEqual([{ workUnitId: 11, workUnitName: "In" }]);
    });

    it("does not reach another line's machines", async () => {
      await machineShift({
        workUnitId: 13,
        workUnitName: "Elsewhere",
        date: "2026-08-19T01:00:00Z",
        workCenterId: OTHER_LINE,
      });

      const { machines } = await repo.listMachineRoster(DAY, LINE);

      expect(machines).toEqual([]);
    });
  });
});
