// Integration coverage for the operator quality-entry ledger, against a REAL
// Postgres.
//
// WHY A CONTAINER, WHEN THE SERVICE SUITE ALREADY STUBS THE REPOSITORY
//
// Everything this table gets wrong, it gets wrong ARITHMETICALLY or in a
// constraint — neither of which a fake can reproduce, and neither of which
// throws where you can see it:
//
//   1. `target_qty` IS A GENERATED COLUMN. The conversion is Postgres's, not
//      TypeScript's, so the only way to know 10 CTN becomes 120 BAG is to ask
//      Postgres. A fake asserting the arithmetic would be asserting a second
//      implementation of it, which is the drift the generated column exists to
//      prevent.
//   2. THE APPEND-ONLY TRIGGER. It refuses a DELETE, a second void and any
//      UPDATE touching a non-void column. It also came within one test run of
//      refusing the ONE mutation the table exists to permit — generated columns
//      are computed AFTER before-triggers, so NEW.target_qty is NULL inside it
//      while OLD's is populated, and the whole-row comparison rejected every
//      void. Nothing but a real UPDATE finds that.
//   3. THE VOID/LIVE SPLIT. A voided row must vanish from the totals and stay in
//      the table. Both halves matter and they are opposite assertions.
//   4. IDEMPOTENCY. ON CONFLICT DO NOTHING plus a read-back is what makes a
//      double-submitted form a no-op rather than a doubled figure. The conflict
//      arm never runs against a fake.
//   5. THE OVERRIDE JOIN's self-protection (contract §18). A mixed-unit shift has
//      infeed_uom_id NULL and ck_wcsr_infeed_units nulls `reject` with it, so an
//      entry that matched it would make the pipeline write a non-NULL reject onto
//      that row and ABORT THE LOAD. The predicate is a plain equality precisely
//      so it cannot match — and that is a claim about NULL semantics that only
//      Postgres can settle.
//
//   docker run --rm -d --name oee-itest-pg18 -p 55434:5432 \
//     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gold_test postgres:18-alpine
//   GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api run db:migrate
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api exec vp test quality-entry-repository.integration
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "../../shared/database/postgres.js";
import { QualityEntryRepository } from "./quality-entry-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { InsertQualityEntry, TargetKey } from "./quality-entry-repository.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

const TZ = "Asia/Jakarta";
// Sentinel ids clear of every seed's range, so a populated dev database cannot
// collide with the fixture.
const LINE = 9301;
const OTHER_LINE = 9302;
const DAY = "2026-08-01";

// BAG is the line's infeed unit and the product's base; CTN is 12 BAG. That gap
// is what makes the conversion visible — a 1:1 pair would pass whether the factor
// were applied or ignored.
const BAG = { id: 41, code: "BAG" };
const CTN = { id: 42, code: "CTN" };

describe.skipIf(!url)("QualityEntryRepository (integration)", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo = new QualityEntryRepository({ goldDb: db });

  // The trigger refuses DELETE, so the fixture is cleared with it disabled. That
  // is the one place in this suite allowed to do so, and it is worth noting that
  // needing it IS the guarantee working.
  async function clean() {
    await db`ALTER TABLE oee.work_center_quality_entries DISABLE TRIGGER wcqe_append_only`;
    await db`DELETE FROM oee.work_center_quality_entries WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    await db`ALTER TABLE oee.work_center_quality_entries ENABLE TRIGGER wcqe_append_only`;
    await db`DELETE FROM oee.work_center_shift_reports WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
  }

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.end();
  });

  // One entry, in the line's own unit unless told otherwise.
  function entry(over: Partial<InsertQualityEntry> = {}): InsertQualityEntry {
    return {
      kind: "reject",
      workCenterId: LINE,
      businessDate: DAY,
      shift: 1,
      timeZone: TZ,
      workUnitId: 3,
      workUnitName: "Filler 2",
      productId: 4,
      productName: "Kacang Garuda 20g",
      productCode: "KG-20",
      reasonId: 7,
      reasonCode: "BURST",
      reasonName: "Burst seal",
      note: null,
      enteredQty: 140,
      enteredUomId: BAG.id,
      enteredUomCode: BAG.code,
      enteredUomName: "Bag",
      enteredFactorToBase: 1,
      targetUomId: BAG.id,
      targetUomCode: BAG.code,
      targetUomName: "Bag",
      targetFactorToBase: 1,
      baseUomId: BAG.id,
      baseUomCode: BAG.code,
      unitCheck: "verified",
      requestId: crypto.randomUUID(),
      enteredBy: "kc-sub-1",
      enteredByName: "Operator One",
      ...over,
    };
  }

  // `productId: null` is "every SKU on this line", which is what a LINE ledger
  // reads. The per-SKU narrowing has its own describe block at the end of this file.
  const window = {
    workCenterId: LINE,
    dateFrom: DAY,
    dateTo: "2026-08-02",
    shift: 1,
    productId: null,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // THE CONVERSION, which is the database's arithmetic and not this service's
  // ─────────────────────────────────────────────────────────────────────────────
  describe("target_qty", () => {
    // 10 CTN at 12 BAG each, against a line reporting in BAG. If the factor were
    // ignored this is 10; if it were inverted it is 0.833. Both are plausible
    // numbers on a screen, which is why the assertion is on the value and not on
    // "a number came back".
    it("converts through the product's base, and Postgres does the arithmetic", async () => {
      const saved = await repo.insert(
        entry({
          enteredQty: 10,
          enteredUomId: CTN.id,
          enteredUomCode: CTN.code,
          enteredFactorToBase: 12,
        }),
      );

      expect(saved.enteredQty).toBe(10);
      expect(saved.enteredUomCode).toBe("CTN");
      expect(saved.targetQty).toBe(120);
      expect(saved.targetUomCode).toBe("BAG");
    });

    // BOTH QUANTITIES TRAVEL, and this is why: an operator who typed 10 cartons
    // must be able to find their own entry in a ledger otherwise denominated in
    // bags. Losing `enteredQty` would make the trail unrecognisable to the person
    // who wrote it.
    it("keeps what the operator typed alongside what the report will move by", async () => {
      const saved = await repo.insert(
        entry({
          enteredQty: 3,
          enteredUomId: CTN.id,
          enteredUomCode: CTN.code,
          enteredFactorToBase: 12,
        }),
      );

      expect(saved.enteredQty).not.toBe(saved.targetQty);
      expect(saved.targetQty).toBe(36);
    });

    // The identity path: same unit, equal factors. ck_wcqe_identity forces the
    // ratio to be exactly 1 rather than 0.999 from two independently rounded
    // reads, so this must come back unchanged to the last decimal.
    it("leaves a quantity entered in the line's own unit exactly alone", async () => {
      const saved = await repo.insert(entry({ enteredQty: 140.125 }));

      expect(saved.targetQty).toBe(140.125);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // IDEMPOTENCY — the cheapest guard here, and the one with no visible symptom
  // ─────────────────────────────────────────────────────────────────────────────
  describe("request_id", () => {
    // A double-submitted form. Without this, two live rows and a DOUBLED reported
    // figure, with nothing anywhere to notice — no error, no duplicate warning,
    // just a number that is twice what a human counted.
    it("makes a resubmitted entry a no-op that returns the first row", async () => {
      const input = entry();

      const first = await repo.insert(input);
      const second = await repo.insert(input);

      expect(second.id).toBe(first.id);

      const rows = await repo.listForTarget(window, false);
      expect(rows).toHaveLength(1);
    });

    // The inverse guard: two DIFFERENT submissions of the same quantity are two
    // real entries. An operator who counted 140 twice has counted 280, and
    // deduplicating on the values would silently discard half of it.
    it("keeps two genuinely separate entries with the same values", async () => {
      await repo.insert(entry());
      await repo.insert(entry());

      const rows = await repo.listForTarget(window, false);
      expect(rows).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // THE VOID, and the append-only guarantee around it
  // ─────────────────────────────────────────────────────────────────────────────
  describe("void", () => {
    it("drops the entry from the totals and keeps the row", async () => {
      const saved = await repo.insert(entry({ enteredQty: 500 }));
      await repo.insert(entry({ enteredQty: 50 }));

      await repo.void({
        id: saved.id,
        workCenterId: LINE,
        voidedBy: "kc-sub-2",
        voidedByName: "Supervisor",
        reason: "typo",
      });

      // The figure the card shows, and the one contract §18's aggregate sums.
      const totals = await repo.totalsForTarget(window);
      expect(totals).toEqual([{ kind: "reject", uomCode: "BAG", qty: 50, entries: 1 }]);

      // The trail. "500, then that was wrong, then 50" — not "50" with no memory
      // of the 500 that sat on a report for a day.
      const all = await repo.listForTarget(window, true);
      expect(all).toHaveLength(2);
      expect(all.find((r) => r.id === saved.id)?.voidedAt).not.toBeNull();

      const live = await repo.listForTarget(window, false);
      expect(live).toHaveLength(1);
    });

    // A second void returns NO ROW rather than raising, so the service can answer
    // 409 instead of 500 — see the repository's note on why the WHERE clause
    // duplicates the trigger's check.
    it("returns undefined on a second void rather than raising", async () => {
      const saved = await repo.insert(entry());
      const args = {
        id: saved.id,
        workCenterId: LINE,
        voidedBy: "kc-sub-2",
        voidedByName: null,
        reason: null,
      };

      expect(await repo.void(args)).toBeDefined();
      expect(await repo.void(args)).toBeUndefined();
    });

    // SCOPED BY LINE. Six report tables with independent sequences makes a
    // plausible-looking wrong id cheap to produce, and voiding another line's
    // entry from this screen would change a figure nobody on this screen can see.
    it("refuses to void an entry belonging to another line", async () => {
      const saved = await repo.insert(entry());

      const voided = await repo.void({
        id: saved.id,
        workCenterId: OTHER_LINE,
        voidedBy: "kc-sub-2",
        voidedByName: null,
        reason: null,
      });

      expect(voided).toBeUndefined();
      expect((await repo.listForTarget(window, false))[0]?.voidedAt).toBeNull();
    });

    // THE TRIGGER, asserted directly rather than through the repository — nothing
    // in this service issues either statement, so these are guarantees against a
    // future writer that is not this code.
    it("refuses a DELETE outright", async () => {
      const saved = await repo.insert(entry());

      await expect(
        db`DELETE FROM oee.work_center_quality_entries WHERE id = ${saved.id}`,
      ).rejects.toThrow(/append-only/i);
    });

    it("refuses an UPDATE that touches anything but the void columns", async () => {
      const saved = await repo.insert(entry());

      await expect(
        db`UPDATE oee.work_center_quality_entries SET entered_qty = 9999 WHERE id = ${saved.id}`,
      ).rejects.toThrow(/only the void columns/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // THE PER-SKU NARROWING, AND THE RECONCILIATION IT PROMISES
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // A SKU day report's ledger is narrowed by `product_id`, and the claim that
  // makes that safe is written in three comments and asserted here: EVERY ROW THIS
  // SERVICE WRITES CARRIES A PRODUCT, because the create dto requires one — so the
  // per-SKU ledgers SUM to the line's and nothing is lost.
  //
  // TODOS.md §65 worried the other way ("an entry recorded without a SKU belongs to
  // no SKU report"), and it is the thing a supervisor will challenge when a per-SKU
  // "+140 BAG entered" line does not add up to the line report's. A comment cannot
  // hold that; a sum over real rows can.
  describe("listForTarget — narrowed to one SKU", () => {
    const forProduct = (productId: number) => ({ ...window, productId });

    it("returns only that SKU's entries", async () => {
      await repo.insert(entry({ productId: 4, enteredQty: 140 }));
      await repo.insert(entry({ productId: 5, enteredQty: 60 }));

      const four = await repo.listForTarget(forProduct(4), false);

      expect(four).toHaveLength(1);
      expect(four[0]?.productId).toBe(4);
    });

    // THE RECONCILIATION. Two SKUs, one line-day, and the narrowed totals must add
    // up to the unnarrowed one — which is only true because no live row can have a
    // NULL product.
    it("sums to the line's own total across its SKUs", async () => {
      await repo.insert(entry({ productId: 4, enteredQty: 140 }));
      await repo.insert(entry({ productId: 4, enteredQty: 60 }));
      await repo.insert(entry({ productId: 5, enteredQty: 25 }));

      const qty = async (target: TargetKey) =>
        (await repo.totalsForTarget(target))
          .filter((total) => total.kind === "reject")
          .reduce((sum, total) => sum + total.qty, 0);

      const line = await qty(window);
      const four = await qty(forProduct(4));
      const five = await qty(forProduct(5));

      expect(line).toBe(225);
      expect(four + five).toBe(line);
    });

    // A VOIDED ROW IS STILL EXCLUDED FROM THE FIGURE at either scope — the product
    // predicate must not accidentally re-admit one, which is the kind of thing an
    // extra AND in the wrong place does.
    it("keeps a voided entry out of the narrowed totals too", async () => {
      const saved = await repo.insert(entry({ productId: 4, enteredQty: 140 }));
      await repo.void({
        id: saved.id,
        workCenterId: LINE,
        voidedBy: "kc-sub-2",
        voidedByName: "Supervisor",
        reason: "miskeyed",
      });

      expect(await repo.totalsForTarget(forProduct(4))).toHaveLength(0);
      // ...but the FEED still shows it, because a void is an event.
      expect(await repo.listActivityForTarget(forProduct(4))).toHaveLength(1);
    });

    // THE FEED'S RANGE VARIANT, over all three shifts of one day and one SKU. A
    // shift-keyed read would report a third of the day; an unnarrowed one would
    // report the whole line's.
    it("widens over the day's shifts and stays on one SKU", async () => {
      await repo.insert(entry({ productId: 4, shift: 1 }));
      await repo.insert(entry({ productId: 4, shift: 3 }));
      await repo.insert(entry({ productId: 5, shift: 2 }));

      // `shift: null` IS THE WIDENING. `window` above pins shift 1 — a SKU DAY
      // report has no shift to pin, so its feed reads the whole day. Passing a
      // shift here would silently report a third of it.
      const feed = await repo.listActivityForTarget({ ...forProduct(4), shift: null });

      expect(feed.map((e) => e.shift).sort((a, b) => a - b)).toEqual([1, 3]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // THE LEDGER'S WINDOW — a coarse report shows a coarse span
  // ─────────────────────────────────────────────────────────────────────────────
  describe("listForTarget", () => {
    // The month screen's ledger spans the month; the shift screen's spans one
    // shift. Both read the same rows through a different window, which is what
    // makes the card's figure mean the same thing as the tile beside it.
    it("spans a month when the shift is not pinned, and one shift when it is", async () => {
      await repo.insert(entry({ businessDate: "2026-08-01", shift: 1 }));
      await repo.insert(entry({ businessDate: "2026-08-20", shift: 2 }));
      // Outside the month, and the boundary is HALF-OPEN so this must be excluded.
      await repo.insert(entry({ businessDate: "2026-09-01", shift: 1 }));

      const month = {
        workCenterId: LINE,
        dateFrom: "2026-08-01",
        dateTo: "2026-09-01",
        productId: null,
        shift: null,
      };
      expect(await repo.listForTarget(month, false)).toHaveLength(2);

      expect(await repo.listForTarget(window, false)).toHaveLength(1);
    });

    // TOTALS ARE PER UNIT, never summed across one. Two entries in different units
    // are two buckets — "500 BAG + 12 CTN = 512 <blank>" is the figure §16.4
    // refuses, and a single total would be exactly that.
    it("buckets the totals per unit rather than adding across them", async () => {
      await repo.insert(entry({ enteredQty: 500 }));
      await repo.insert(
        entry({
          targetUomId: CTN.id,
          targetUomCode: CTN.code,
          enteredUomId: CTN.id,
          enteredUomCode: CTN.code,
          enteredQty: 12,
          enteredFactorToBase: 12,
          targetFactorToBase: 12,
        }),
      );

      const totals = await repo.totalsForTarget(window);
      expect(totals).toHaveLength(2);
      expect(totals.map((t) => t.uomCode).sort()).toEqual(["BAG", "CTN"]);
    });

    // Reject and rework are separate figures on the card, so they are separate
    // buckets here — a single total would put rework into the reject tile.
    it("separates reject from rework", async () => {
      await repo.insert(entry({ kind: "reject", enteredQty: 500 }));
      await repo.insert(entry({ kind: "rework", enteredQty: 50, workUnitId: null }));

      const totals = await repo.totalsForTarget(window);
      expect(totals).toEqual([
        { kind: "reject", uomCode: "BAG", qty: 500, entries: 1 },
        { kind: "rework", uomCode: "BAG", qty: 50, entries: 1 },
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CONTRACT §18's OVERRIDE JOIN — the shape the PIPELINE will run
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // This service never executes this SQL. It is asserted here anyway, because the
  // contract asks the pipeline owner to run it and two of its properties are
  // claims about NULL semantics that only Postgres can settle — and one of them
  // is the difference between an excluded entry and an ABORTED LOAD.
  describe("the override join (contract §18)", () => {
    const TIMES = [
      "runtime",
      "availability_time",
      "production_time",
      "pdt_time",
      "operating_time",
      "updt_time",
      "net_time",
      "reduce_speed_time",
      "ms_time",
      "value_added_time",
      "rework_time",
      "reject_time",
      "anomaly_time",
      "up_speed_time",
      "schedule_loss_time",
      "availability_loss_time",
      "performance_loss_time",
      "ms_loss_time",
      "reduce_speed_loss_time",
      "quality_loss_time",
    ];

    async function seedReport(
      shift: number,
      unit: { id: number; code: string } | null,
      reject: number | null,
      rework: number | null,
    ) {
      await db`
        INSERT INTO oee.work_center_shift_reports ${db({
          work_center_id: LINE,
          business_date: DAY,
          shift,
          time_zone: TZ,
          work_center_name: "Line 8",
          work_unit_count: 4,
          infeed_uom_id: unit?.id ?? null,
          infeed_uom_code: unit?.code ?? null,
          reject,
          rework,
          ...Object.fromEntries(TIMES.map((t) => [t, 0])),
        })}
      `;
    }

    // The projection exactly as contract §18.4 states it.
    async function project() {
      return await db<
        { shift: number; reject: number | null; rework: number | null; add: number | null }[]
      >`
        WITH entry_shift AS (
          SELECT work_center_id, business_date, shift, target_uom_id,
                 sum(target_qty) FILTER (WHERE kind = 'reject') AS reject_add,
                 sum(target_qty) FILTER (WHERE kind = 'rework') AS rework_add
            FROM oee.work_center_quality_entries
           WHERE voided_at IS NULL
           GROUP BY 1, 2, 3, 4
        )
        SELECT r.shift,
               (CASE WHEN o.reject_add IS NULL THEN r.reject
                     ELSE coalesce(r.reject, 0) + o.reject_add END)::float8 AS reject,
               (CASE WHEN o.rework_add IS NULL THEN r.rework
                     ELSE coalesce(r.rework, 0) + o.rework_add END)::float8 AS rework,
               o.reject_add::float8 AS add
          FROM oee.work_center_shift_reports r
          LEFT JOIN entry_shift o
            ON  o.work_center_id = r.work_center_id
            AND o.business_date  = r.business_date
            AND o.shift          = r.shift
            AND o.target_uom_id  = r.infeed_uom_id
         WHERE r.work_center_id = ${LINE}
         ORDER BY r.shift
      `;
    }

    it("adds the live entries to the pipeline's own measured figure", async () => {
      await seedReport(1, BAG, 700, 10);
      await repo.insert(entry({ enteredQty: 500 }));

      const [row] = await project();
      expect(row?.reject).toBe(1200);
    });

    // sum() over an empty FILTER is NULL, and `700 + NULL` is NULL. A bare
    // addition here would WIPE the pipeline's own measured rework on any shift
    // carrying rejects and no rework — the likeliest silent-data-loss bug in §18,
    // because it only appears on that exact mix.
    it("does not wipe a measured figure when only the other kind was entered", async () => {
      await seedReport(1, BAG, 700, 10);
      await repo.insert(entry({ kind: "reject", enteredQty: 500 }));

      const [row] = await project();
      expect(row?.rework).toBe(10);
    });

    it("ignores a voided entry", async () => {
      await seedReport(1, BAG, 700, 10);
      const saved = await repo.insert(entry({ enteredQty: 500 }));
      await repo.void({
        id: saved.id,
        workCenterId: LINE,
        voidedBy: "kc-sub-2",
        voidedByName: null,
        reason: null,
      });

      const [row] = await project();
      expect(row?.reject).toBe(700);
      expect(row?.add).toBeNull();
    });

    // THE ONE THAT PREVENTS AN ABORTED LOAD.
    //
    // A mixed-unit shift has infeed_uom_id NULL, and ck_wcsr_infeed_units nulls
    // `reject` and `rework` along with it. If the join matched that NULL — which
    // `IS NOT DISTINCT FROM`, or a coalesce on either side, would do — the
    // projection would write a non-NULL reject onto the row and the CHECK would
    // FAIL THE MODEL. Plain `=` cannot match, because target_uom_id is NOT NULL
    // and NULL equals nothing.
    it("contributes nothing to a mixed-unit shift, so the load cannot fail", async () => {
      await seedReport(2, null, null, null);
      await repo.insert(entry({ shift: 2, enteredQty: 55 }));

      const [row] = await project();
      expect(row?.add).toBeNull();
      expect(row?.reject).toBeNull();

      // And the row the projection produces must still satisfy the constraint the
      // pipeline would be writing it back through.
      await expect(
        db`UPDATE oee.work_center_shift_reports
              SET reject = ${row?.reject}
            WHERE work_center_id = ${LINE} AND shift = 2`,
      ).resolves.toBeDefined();
    });

    // An entry whose unit no longer matches the report's is STRANDED — excluded
    // rather than added, which is the join working as designed. Contract §18.6
    // surfaces it as a `warn`-severity test rather than blocking the load.
    it("strands an entry whose unit no longer matches the report", async () => {
      await seedReport(1, BAG, 700, 10);
      await repo.insert(
        entry({
          enteredQty: 12,
          enteredUomId: CTN.id,
          enteredUomCode: CTN.code,
          enteredFactorToBase: 12,
          targetUomId: CTN.id,
          targetUomCode: CTN.code,
          targetFactorToBase: 12,
        }),
      );

      const [row] = await project();
      expect(row?.add).toBeNull();
      expect(row?.reject).toBe(700);
    });
  });
});

// ---------------------------------------------------------------------------
// findProductAtTarget — the fallback for a SKU master data has not linked
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, and it was found on real data rather than reasoned about. The
// entry dialog's SKU picker originally read the master-data catalogue alone, on
// the reasoning that a picklist is a CATALOGUE question and not a MEASUREMENT.
// The reasoning is fine; the result was a report whose SKU View showed a product
// and whose Add Reject dialog offered an EMPTY dropdown — because
// `product_work_centers` is a separate assignment upstream and a line routinely
// runs SKUs nobody has linked to it.
//
// The picker now offers what RAN, so the service has to resolve what ran. This is
// that lookup, and it reads SKU View's own source so the two cannot disagree.
describe.skipIf(!url)("QualityEntryRepository — findProductAtTarget", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo = new QualityEntryRepository({ goldDb: db });

  const LINE_P = 9501;

  async function clean() {
    await db`DELETE FROM oee.product_count_wc_shift WHERE work_center_id = ${LINE_P}`;
  }

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.end();
  });

  async function sku(productId: number, uom: { id: number; code: string }) {
    await db`
      INSERT INTO oee.product_count_wc_shift ${db({
        work_center_id: LINE_P,
        business_date: DAY,
        shift: 1,
        time_zone: TZ,
        work_center_name: "Line 8",
        product_id: productId,
        product_name: `SKU ${productId}`,
        product_code: `S-${productId}`,
        uom_id: uom.id,
        uom_name: uom.code,
        uom_code: uom.code,
        base_uom_id: uom.id,
        base_uom_name: uom.code,
        base_uom_code: uom.code,
        factor_to_base: 1,
        total_out: 100,
        good_out: 95,
        reject: 4,
        rework: 1,
      })}
    `;
  }

  it("resolves a SKU the line reported, with the unit it was counted in", async () => {
    await sku(7, BAG);

    const found = await repo.findProductAtTarget(LINE_P, DAY, 1, 7);

    expect(found).toMatchObject({ productName: "SKU 7", productCode: "S-7", uomCode: "BAG" });
    // The unit ID is what the service compares against the line's target unit —
    // the identity path has no factor to convert by, so those must match.
    expect(found?.uomId).toBe(BAG.id);
  });

  // SCOPED TO THE SHIFT, not just the line. A SKU that ran on shift 2 is not a
  // SKU that ran on shift 1, and an entry names one shift.
  it("does not resolve a SKU from a different shift", async () => {
    await sku(7, BAG);

    expect(await repo.findProductAtTarget(LINE_P, DAY, 2, 7)).toBeUndefined();
  });

  it("does not resolve a SKU from a different line", async () => {
    await sku(7, BAG);

    expect(await repo.findProductAtTarget(LINE, DAY, 1, 7)).toBeUndefined();
  });

  // A SKU counted in a unit the line does not report in is exactly the case the
  // service must REFUSE on this path — there is no package list to convert
  // through, and assuming 1.0 between two units is the silent wrong number the
  // whole feature is built to avoid. The repository's job is only to surface the
  // unit so the service can compare it.
  it("surfaces a unit that differs from the line's, rather than hiding it", async () => {
    await sku(8, CTN);

    const found = await repo.findProductAtTarget(LINE_P, DAY, 1, 8);

    expect(found?.uomCode).toBe("CTN");
  });
});

// ---------------------------------------------------------------------------
// findTargetByReport — the FIRST thing every route in this module calls
// ---------------------------------------------------------------------------
//
// It was uncovered, and a 500 on GET .../quality-entries was the result. Every
// other test in this file starts from a hand-built TargetKey, so the step that
// turns a report id into one had never run against Postgres.
//
// A LINE report ref, by grain. `ref("day")` and the SKU subject are different
// things even though both are day grain — see ReportRef.
const ref = (grain: "shift" | "day" | "month") => ({ subject: "work-center", grain }) as const;

describe.skipIf(!url)("QualityEntryRepository — findTargetByReport", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo = new QualityEntryRepository({ goldDb: db });

  const LINE_T = 9601;
  const TIMES = [
    "runtime",
    "availability_time",
    "production_time",
    "pdt_time",
    "operating_time",
    "updt_time",
    "net_time",
    "reduce_speed_time",
    "ms_time",
    "value_added_time",
    "rework_time",
    "reject_time",
    "anomaly_time",
    "up_speed_time",
    "schedule_loss_time",
    "availability_loss_time",
    "performance_loss_time",
    "ms_loss_time",
    "reduce_speed_loss_time",
    "quality_loss_time",
  ];

  async function clean() {
    for (const t of ["shift", "day", "month"]) {
      await db.unsafe(
        `DELETE FROM oee.work_center_${t}_reports WHERE work_center_id = ${String(LINE_T)}`,
      );
    }
  }

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.end();
  });

  async function report(grain: "shift" | "day" | "month", businessDate: string) {
    const base = {
      work_center_id: LINE_T,
      business_date: businessDate,
      time_zone: TZ,
      work_center_name: "Line 8",
      work_unit_count: 2,
      infeed_uom_id: BAG.id,
      infeed_uom_code: BAG.code,
      ...Object.fromEntries(TIMES.map((t) => [t, 0])),
    };
    const row = grain === "shift" ? { ...base, shift: 1 } : base;
    const rows = await db.unsafe(
      `INSERT INTO oee.work_center_${grain}_reports ${
        Object.keys(row).length > 0 ? "" : ""
      }(${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map((_, i) => `$${String(i + 1)}`)
        .join(",")}) RETURNING id`,
      Object.values(row) as never[],
    );
    return Number((rows[0] as unknown as { id: number }).id);
  }

  // A SHIFT report resolves to ONE day and its own shift.
  it("resolves a shift report to a one-day window and its shift", async () => {
    const id = await report("shift", "2026-08-09");

    const anchor = await repo.findTargetByReport(ref("shift"), id);

    expect(anchor).toMatchObject({
      workCenterId: LINE_T,
      dateFrom: "2026-08-09",
      // HALF-OPEN: the next day, so `business_date < dateTo` includes the 9th.
      dateTo: "2026-08-10",
      shift: 1,
      infeedUomCode: "BAG",
    });
  });

  // A DAY report spans the same window with NO shift, so the ledger shows all
  // three shifts' entries.
  it("resolves a day report to a one-day window with no shift", async () => {
    const id = await report("day", "2026-08-09");

    const anchor = await repo.findTargetByReport(ref("day"), id);

    expect(anchor).toMatchObject({ dateFrom: "2026-08-09", dateTo: "2026-08-10", shift: null });
  });

  // A MONTH report spans its whole month, and the end is computed in SQL so
  // February and a 31st are right without JS date arithmetic.
  it("resolves a month report to a whole-month window", async () => {
    const id = await report("month", "2026-08-01");

    const anchor = await repo.findTargetByReport(ref("month"), id);

    expect(anchor).toMatchObject({ dateFrom: "2026-08-01", dateTo: "2026-09-01", shift: null });
  });

  it("resolves February correctly rather than adding 30 days", async () => {
    const id = await report("month", "2026-02-01");

    expect(await repo.findTargetByReport(ref("month"), id)).toMatchObject({ dateTo: "2026-03-01" });
  });

  // An id that names nothing is a 404 at the handler, not a throw here.
  it("returns undefined for an id that names nothing", async () => {
    expect(await repo.findTargetByReport(ref("shift"), 987_654_321)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listActivityForMachine — a reject reaches the MACHINE's feed, a rework does not
// ---------------------------------------------------------------------------
//
// THE RULE, and it is a product decision rather than an implementation detail:
// an operator recording a reject PICKS A MACHINE, so that machine's report has
// something to show even though the quantity lands on the LINE. Where the number
// lands is a measurement question; what an operator recorded against a machine is
// an audit question, and they have different right answers.
//
// A rework names no machine — the dialog does not ask — so it cannot appear.
// That is STRUCTURAL rather than a filter: `work_unit_id` is null on a rework, so
// a machine-scoped read returns nothing. These pin it so that stays true if the
// dialog ever starts asking.
describe.skipIf(!url)("QualityEntryRepository — listActivityForMachine", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo = new QualityEntryRepository({ goldDb: db });

  const MACHINE = 9701;

  async function clean() {
    await db`ALTER TABLE oee.work_center_quality_entries DISABLE TRIGGER wcqe_append_only`;
    await db`DELETE FROM oee.work_center_quality_entries WHERE work_center_id = ${LINE}`;
    await db`ALTER TABLE oee.work_center_quality_entries ENABLE TRIGGER wcqe_append_only`;
  }

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.end();
  });

  function entry(over: Partial<InsertQualityEntry> = {}): InsertQualityEntry {
    return {
      kind: "reject",
      workCenterId: LINE,
      businessDate: DAY,
      shift: 1,
      timeZone: TZ,
      workUnitId: MACHINE,
      workUnitName: "Vertical Packer N",
      productId: 4,
      productName: "SKU B",
      productCode: "S-4",
      reasonId: 7,
      reasonCode: "BURST",
      reasonName: "Burst seal",
      note: null,
      enteredQty: 180,
      enteredUomId: BAG.id,
      enteredUomCode: BAG.code,
      enteredUomName: "Bag",
      enteredFactorToBase: 1,
      targetUomId: BAG.id,
      targetUomCode: BAG.code,
      targetUomName: "Bag",
      targetFactorToBase: 1,
      baseUomId: BAG.id,
      baseUomCode: BAG.code,
      unitCheck: "verified",
      requestId: crypto.randomUUID(),
      enteredBy: "kc-sub-1",
      enteredByName: "Operator One",
      ...over,
    };
  }

  it("returns a reject the operator attributed to this machine", async () => {
    await repo.insert(entry());

    const rows = await repo.listActivityForMachine(MACHINE, DAY, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "reject", targetQty: 180 });
    // THE NAME, not the id. The feed's fallback is `machine ${id}`, and a trail
    // that names the operator then identifies the machine by a database id is not
    // one a supervisor can read.
    expect(rows[0]?.workUnitName).toBe("Vertical Packer N");
  });

  // STRUCTURAL, not filtered: a rework carries no work_unit_id at all.
  it("never returns a rework, because a rework names no machine", async () => {
    await repo.insert(entry({ kind: "rework", workUnitId: null, workUnitName: null }));

    expect(await repo.listActivityForMachine(MACHINE, DAY, 1)).toHaveLength(0);
  });

  it("does not return another machine's reject", async () => {
    await repo.insert(entry({ workUnitId: MACHINE + 1 }));

    expect(await repo.listActivityForMachine(MACHINE, DAY, 1)).toHaveLength(0);
  });

  // Scoped to the shift the report covers, like every other read here.
  it("does not return a reject from another shift", async () => {
    await repo.insert(entry({ shift: 2 }));

    expect(await repo.listActivityForMachine(MACHINE, DAY, 1)).toHaveLength(0);
  });

  // A VOID IS AN EVENT. The machine's feed shows the retraction for the same
  // reason the line's does — hiding it would show the 180 and not the correction.
  it("includes a voided entry rather than hiding it", async () => {
    const saved = await repo.insert(entry());
    await repo.void({
      id: saved.id,
      workCenterId: LINE,
      voidedBy: "kc-sub-2",
      voidedByName: "Supervisor",
      reason: "double counted",
    });

    const rows = await repo.listActivityForMachine(MACHINE, DAY, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.voidedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // The RANGE variant, for the machine DAY and MONTH feeds (TODOS §64)
  // -------------------------------------------------------------------------
  //
  // WHAT ONLY A REAL POSTGRES SHOWS HERE. `machineScoped` carries the same
  // equal-ends inclusivity rule its line-side sibling does — `business_date <= $2`
  // when the two ends match, `< $2` otherwise — and BOTH halves fail silently:
  //
  //   always `<`   the SHIFT feed matches nothing, because its caller passes one
  //                day twice. Every machine shift report's quality arm goes empty
  //                and reads as "nobody entered a reject", which is a plausible
  //                screen.
  //   always `<=`  a day feed pulls in the NEXT day's entries, and a month feed the
  //                first of the following month. The panel is populated, correct
  //                for most rows, and wrong at exactly one boundary.
  //
  // A fakeSql suite cannot see either: it matches SQL text, and both variants are
  // "a query with a business_date comparison in it".
  describe("listActivityForMachineTarget", () => {
    const range = (dateFrom: string, dateTo: string) => ({
      workUnitId: MACHINE,
      dateFrom,
      dateTo,
      // EVERY SHIFT IN THE RANGE — the one field that differs from the shift-keyed
      // caller, and what widens three shifts' entries into a day's.
      shift: null,
    });

    // THE ASSERTION THE `shift: null` ARM EXISTS FOR. Three entries on three shifts
    // of one business day: the day feed sees all three, the shift feed one.
    it("covers every shift in the range", async () => {
      for (const shift of [1, 2, 3]) await repo.insert(entry({ shift }));

      expect(await repo.listActivityForMachineTarget(range(DAY, "2026-08-02"))).toHaveLength(3);
      expect(await repo.listActivityForMachine(MACHINE, DAY, 1)).toHaveLength(1);
    });

    // THE UPPER BOUND IS EXCLUSIVE when the ends differ. `<=` here would put the
    // 2nd's entries in the 1st's feed.
    it("excludes the day after a day range", async () => {
      await repo.insert(entry({ businessDate: "2026-08-02" }));

      expect(await repo.listActivityForMachineTarget(range(DAY, "2026-08-02"))).toHaveLength(0);
    });

    // A WHOLE MONTH, including its LAST day — which is what the exclusive first of
    // the next month buys. An off-by-one here drops the 31st silently.
    it("covers the last day of a month range", async () => {
      await repo.insert(entry({ businessDate: "2026-08-31" }));
      await repo.insert(entry({ businessDate: "2026-09-01" }));

      const rows = await repo.listActivityForMachineTarget(range("2026-08-01", "2026-09-01"));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.businessDate).toBe("2026-08-31");
    });

    // AND THE EQUAL-ENDS CASE DIRECTLY, because it is the shape the shift-keyed
    // caller builds and the one a "tidy up the comparison" change breaks first.
    it("is inclusive when the two ends are the same day", async () => {
      await repo.insert(entry());

      expect(
        await repo.listActivityForMachineTarget({ ...range(DAY, DAY), shift: 1 }),
      ).toHaveLength(1);
    });

    // THE MACHINE SCOPE STILL EXCLUDES A REWORK over a range, structurally. The
    // widening must not have turned a machine read into a line read.
    it("still returns no rework over a range", async () => {
      await repo.insert(entry({ kind: "rework", workUnitId: null, workUnitName: null }));

      expect(await repo.listActivityForMachineTarget(range(DAY, "2026-08-02"))).toHaveLength(0);
    });

    it("still excludes another machine's reject over a range", async () => {
      await repo.insert(entry({ workUnitId: MACHINE + 1 }));

      expect(await repo.listActivityForMachineTarget(range(DAY, "2026-08-02"))).toHaveLength(0);
    });
  });
});
