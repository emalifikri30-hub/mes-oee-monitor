// Integration coverage for the AREA grain, against a REAL Postgres.
//
// Why this file exists and the fakeSql suite next to it is not enough: that fake
// matches SQL TEXT and never executes it, so it cannot see a wrong number. What
// this grain gets wrong, it gets wrong ARITHMETICALLY, and every one of these
// renders a plausible screen rather than throwing:
//
//   1. THE PER-UNIT BUCKETS ARE THE WHOLE POINT OF THE GRAIN, and the failure mode
//      is one bucket. Two lines counting in BAG and SACK must produce two rows; a
//      GROUP BY that dropped the unit, or a projection that took `min(uom)` across
//      them, produces ONE confident row adding sacks to bags. Nothing raises.
//   2. THE TWO SIDES MUST NOT MERGE. A line has an infeed unit AND an output unit,
//      and a row can have one without the other. A single grouping over both is
//      the arithmetic migration 0014 forbids.
//   3. THE RESIDUALS ARE TAKEN OVER THE ROWS THE UNIT PREDICATE HAS *NOT* BEEN
//      APPLIED TO. Written as a FILTER on the grouped queries they return 0 for
//      every window, always, and look right — which is the trap
//      product-report-repository.integration.test.ts records one subject over.
//   4. `area_id` IS NULLABLE ON EVERY SOURCE TABLE. A line the pipeline never
//      attributed must be excluded from an area's totals, and an unscoped read
//      would return the whole plant under one area's heading.
//   5. `oee <> 0` IS THREE-VALUED, so isHideZero hides a NULL-OEE row as well as a
//      zero one. That is intended and it is one "fix" away from changing.
//   6. THE BUSINESS-DATE FILTER MUST BE EXACT AT A MONTH BOUNDARY, and PAGING must
//      be STABLE when `business_date` ties across areas — without the id tiebreak a
//      row appears on two pages and another on none, which no test asserting "rows
//      came back" would catch.
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
import { AreaReportReaderRepository } from "./area-report-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { AreaWindow } from "./area-report.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// Sentinels of this file's own, so it cannot collide with the dev seeds or with the
// other integration suites.
const AREA = 9901;
const OTHER_AREA = 9902;
const LINE_A = 9911;
const LINE_B = 9912;
const OTHER_LINE = 9913;
const SKU = 9921;
const DATE = "2026-09-01";
// The first of the month, which `ck_amr_month_start` requires of every
// oee.area_month_reports row.
const MONTH_START = "2026-09-01";

// Two units per side, so a single-bucket bug is visible. BAG/SACK on the infeed,
// CTN/PAL on the output.
const UOM = {
  bag: { id: 1, name: "Bag", code: "BAG" },
  sack: { id: 2, name: "Sack", code: "SACK" },
  ctn: { id: 41, name: "Carton", code: "CTN" },
  pal: { id: 42, name: "Pallet", code: "PAL" },
} as const;

function window(overrides: Partial<AreaWindow> = {}): AreaWindow {
  return {
    areaId: AREA,
    dateFrom: DATE,
    dateTo: "2026-09-02",
    timeZone: "Asia/Jakarta",
    ...overrides,
  };
}

describe.skipIf(!url)("AreaReportReaderRepository against a real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new AreaReportReaderRepository({ goldDb: db });

  async function clean() {
    await db`DELETE FROM oee.area_day_reports WHERE area_id IN (${AREA}, ${OTHER_AREA})`;
    await db`DELETE FROM oee.area_month_reports WHERE area_id IN (${AREA}, ${OTHER_AREA})`;
    await db`DELETE FROM oee.work_center_day_reports WHERE work_center_id IN (${LINE_A}, ${LINE_B}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.product_count_wc_day WHERE work_center_id IN (${LINE_A}, ${LINE_B}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.reject_count_wc_shift WHERE work_center_id IN (${LINE_A}, ${LINE_B}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.downtime_log_events WHERE work_center_id IN (${LINE_A}, ${LINE_B}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.downtime_reports WHERE work_center_id IN (${LINE_A}, ${LINE_B}, ${OTHER_LINE})`;
    // BY source_event_id, because oee.downtime_report_history carries no area and
    // no line. Deleting the stops above does not cascade — there are no foreign
    // keys in `oee` (0003) — so a trail would survive its subject and leak into
    // the next test.
    await db`DELETE FROM oee.downtime_report_history WHERE source_event_id LIKE 'aitest-%'`;
  }

  afterAll(async () => {
    await clean();
    await db.end();
  });
  beforeEach(clean);

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  // An area day report. Every duration is NOT NULL, so a fixture must supply them;
  // they are zero except where a test reads them.
  async function areaReport(opts: {
    areaId?: number;
    businessDate?: string;
    oee?: number | null;
    runtime?: number;
    weightUomId?: number | null;
    totalOut?: number | null;
  }) {
    const rows = await db<{ id: number }[]>`
      INSERT INTO oee.area_day_reports (
        area_id, business_date, time_zone, area_name, area_code,
        weight_uom_id, weight_uom_name, weight_uom_code,
        oee, total_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      ) VALUES (
        ${opts.areaId ?? AREA}, ${opts.businessDate ?? DATE}::date, 'Asia/Jakarta',
        'Filling 2', 'FI2',
        ${opts.weightUomId === undefined ? 7 : opts.weightUomId},
        ${opts.weightUomId === null ? null : "Kilogram"},
        ${opts.weightUomId === null ? null : "KG"},
        ${opts.oee === undefined ? 80 : opts.oee},
        ${opts.totalOut === undefined ? 12000 : opts.totalOut},
        ${opts.runtime ?? 0},
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  // An area MONTH report. The day table plus one CHECK (`ck_amr_month_start`), so
  // this is `areaReport()` with a different table name and a `business_date` that
  // has to be the first of its month.
  //
  // THE DURATIONS ARE DELIBERATELY ~3,600 h, which is two lines over a 30-day
  // month at ~60 h a day. A month fixture with day-sized durations would let a
  // reader — or a card — divide by something and still look right.
  async function areaMonthReport(opts: {
    areaId?: number;
    businessDate?: string;
    oee?: number | null;
    runtime?: number;
    weightUomId?: number | null;
    totalOut?: number | null;
  }) {
    const rows = await db<{ id: number }[]>`
      INSERT INTO oee.area_month_reports (
        area_id, business_date, time_zone, area_name, area_code, month,
        weight_uom_id, weight_uom_name, weight_uom_code,
        oee, total_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      ) VALUES (
        ${opts.areaId ?? AREA}, ${opts.businessDate ?? MONTH_START}::date, 'Asia/Jakarta',
        'Filling 2', 'FI2', '2026-09',
        ${opts.weightUomId === undefined ? 7 : opts.weightUomId},
        ${opts.weightUomId === null ? null : "Kilogram"},
        ${opts.weightUomId === null ? null : "KG"},
        ${opts.oee === undefined ? 80 : opts.oee},
        ${opts.totalOut === undefined ? 360000 : opts.totalOut},
        ${opts.runtime ?? 12_960_000_000},
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  // A LINE day report — the source of the per-unit buckets, the line list and the
  // SKU View's scope.
  //
  // `undefined` and `null` mean different things for a unit, deliberately:
  // undefined takes the default, null writes a NULL unit — which 0014's CHECK then
  // requires the matching counts to be null with, so those are nulled here too.
  async function lineReport(opts: {
    workCenterId?: number;
    areaId?: number | null;
    businessDate?: string;
    infeedUom?: { id: number; name: string; code: string } | null;
    outputUom?: { id: number; name: string; code: string } | null;
    totalOut?: number;
    lineOut?: number;
    reject?: number;
    rework?: number;
    goodOut?: number;
    effectiveOut?: number;
    availabilityTime?: number;
    runtime?: number;
  }) {
    const infeed = opts.infeedUom === undefined ? UOM.bag : opts.infeedUom;
    const output = opts.outputUom === undefined ? UOM.ctn : opts.outputUom;

    await db`
      INSERT INTO oee.work_center_day_reports (
        work_center_id, business_date, time_zone,
        work_center_name, work_center_code, area_id, area_name,
        work_unit_count,
        infeed_uom_id, infeed_uom_name, infeed_uom_code,
        output_uom_id, output_uom_name, output_uom_code,
        total_out, line_out, reject, rework, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      ) VALUES (
        ${opts.workCenterId ?? LINE_A}, ${opts.businessDate ?? DATE}::date, 'Asia/Jakarta',
        'Line', 'L', ${opts.areaId === undefined ? AREA : opts.areaId}, 'Filling 2',
        2,
        ${infeed?.id ?? null}, ${infeed?.name ?? null}, ${infeed?.code ?? null},
        ${output?.id ?? null}, ${output?.name ?? null}, ${output?.code ?? null},
        ${infeed === null ? null : (opts.totalOut ?? 1000)},
        ${infeed === null ? null : (opts.lineOut ?? 950)},
        ${infeed === null ? null : (opts.reject ?? 30)},
        ${infeed === null ? null : (opts.rework ?? 20)},
        ${output === null ? null : (opts.goodOut ?? 80)},
        ${output === null ? null : (opts.effectiveOut ?? 78)},
        ${opts.runtime ?? 0}, ${opts.availabilityTime ?? 0},
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      )
    `;
  }

  async function productCount(opts: {
    workCenterId?: number;
    productId?: number;
    businessDate?: string;
    uom?: { id: number; code: string };
    baseUom?: { id: number; code: string };
    factorToBase?: number;
    totalOut?: number;
    goodOut?: number;
    reject?: number;
    rework?: number;
  }) {
    const uom = opts.uom ?? { id: UOM.bag.id, code: UOM.bag.code };
    const base = opts.baseUom ?? { id: 99, code: "KG" };
    await db`
      INSERT INTO oee.product_count_wc_day (
        work_center_id, business_date, time_zone, work_center_name, work_center_code,
        product_id, product_name, product_code,
        uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code,
        factor_to_base, total_out, good_out, reject, rework
      ) VALUES (
        ${opts.workCenterId ?? LINE_A}, ${opts.businessDate ?? DATE}::date, 'Asia/Jakarta',
        'Line', 'L',
        ${opts.productId ?? SKU}, 'SKU A', 'SKU-A',
        ${uom.id}, ${uom.code}, ${uom.code}, ${base.id}, ${base.code}, ${base.code},
        ${opts.factorToBase ?? 2}, ${opts.totalOut ?? 100}, ${opts.goodOut ?? 90},
        ${opts.reject ?? 6}, ${opts.rework ?? 4}
      )
    `;
  }

  async function rejectCount(opts: {
    workCenterId?: number;
    areaId?: number | null;
    reason: string;
    uomCode?: string;
    counterValue?: number;
    frequency?: number;
    shift?: number;
  }) {
    const uomCode = opts.uomCode ?? "BAG";
    await db`
      INSERT INTO oee.reject_count_wc_shift (
        work_center_id, business_date, shift, product_id, reason, time_zone,
        work_center_name, area_id, area_name,
        uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code,
        factor_to_base, counter_value, frequency
      ) VALUES (
        ${opts.workCenterId ?? LINE_A}, ${DATE}::date, ${opts.shift ?? 1}, ${SKU},
        ${opts.reason}, 'Asia/Jakarta',
        'Line', ${opts.areaId === undefined ? AREA : opts.areaId}, 'Filling 2',
        1, ${uomCode}, ${uomCode}, 1, ${uomCode}, ${uomCode},
        1, ${opts.counterValue ?? 10}, ${opts.frequency ?? 1}
      )
    `;
  }

  async function logEvent(opts: {
    eventId: string;
    reasons: string[];
    areaId?: number | null;
    workCenterId?: number;
    shiftDate?: string;
  }) {
    await db`
      INSERT INTO oee.downtime_log_events (
        event_id, work_unit_id, shift_date, shift, reasons, category,
        work_unit_name, work_center_id, area_id, area_name, time_zone
      ) VALUES (
        ${opts.eventId}, 1, ${opts.shiftDate ?? DATE}::date, 1,
        ${opts.reasons}::text[], 'UNPLANNED'::oee.operation_type,
        'Filler', ${opts.workCenterId ?? LINE_A},
        ${opts.areaId === undefined ? AREA : opts.areaId}, 'Filling 2', 'Asia/Jakarta'
      )
    `;
  }

  async function stop(opts: {
    areaId?: number | null;
    workCenterId?: number;
    workUnitId?: number;
    workUnitName?: string;
    workCenterName?: string;
    businessDate?: string;
    // NULL IS A REAL CASE, not a gap: a stop the pipeline never gave a stable id
    // can never carry a trail, which is the whole distinction listDowntimeEdits'
    // two counts draw.
    sourceEventId?: string | null;
  }) {
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, work_unit_name, shift, start_at, end_at,
         work_center_id, work_center_name, area_id, business_date, source_event_id)
      VALUES ('["r"]'::jsonb, 'UNPLANNED'::oee.operation_type,
              ${opts.workUnitId ?? 1}, ${opts.workUnitName ?? "Filler"}, 1,
              '2026-09-01T02:00:00Z', '2026-09-01T02:10:00Z',
              ${opts.workCenterId ?? LINE_A}, ${opts.workCenterName ?? "Line A"},
              ${opts.areaId === undefined ? AREA : opts.areaId},
              ${opts.businessDate ?? DATE}::date,
              ${opts.sourceEventId === undefined ? null : opts.sourceEventId})
    `;
  }

  async function history(sourceEventId: string, field = "category") {
    await db`
      INSERT INTO oee.downtime_report_history
        (source_event_id, field, old_value, new_value, changed_by, changed_at)
      VALUES (${sourceEventId}, ${field}, '"PLANNED"'::jsonb, '"UNPLANNED"'::jsonb,
              'u1', now())
    `;
  }

  // ---------------------------------------------------------------------------
  // The list
  // ---------------------------------------------------------------------------

  describe("paginateReport", () => {
    function list(filter: Partial<Record<string, unknown>> = {}, page = { limit: 10, offset: 0 }) {
      return repo.paginateReport({
        grain: "day",
        ...page,
        filter: {
          month: undefined,
          year: undefined,
          areaId: AREA,
          isHideZero: false,
          ...filter,
        } as never,
      });
    }

    it("returns only the requested area", async () => {
      await areaReport({});
      await areaReport({ areaId: OTHER_AREA });

      const { items, totalElements } = await list();

      expect(totalElements).toBe(1);
      expect(items.map((r) => r.areaId)).toEqual([AREA]);
    });

    // THREE-VALUED. `oee` is nullable, so `oee <> 0` is NULL for a null row rather
    // than true — the filter hides an undefined area as well as a measured zero.
    // `IS DISTINCT FROM 0` would keep the null row, and that is the "fix" this
    // pins against.
    it("hides both a zero and a NULL oee when isHideZero is on", async () => {
      await areaReport({ businessDate: "2026-09-01", oee: 80 });
      await areaReport({ businessDate: "2026-09-02", oee: 0 });
      await areaReport({ businessDate: "2026-09-03", oee: null });

      const shown = await list({ isHideZero: true });
      const all = await list({ isHideZero: false });

      expect(shown.totalElements).toBe(1);
      expect(shown.items[0]!.oee).toBe(80);
      expect(all.totalElements).toBe(3);
    });

    // EXACT AT A MONTH BOUNDARY. A half-open make_date range takes the 30th and
    // leaves the 1st of the next month alone; `BETWEEN` would take both.
    it("filters a month without taking either neighbour", async () => {
      await areaReport({ businessDate: "2026-08-31" });
      await areaReport({ businessDate: "2026-09-01" });
      await areaReport({ businessDate: "2026-09-30" });
      await areaReport({ businessDate: "2026-10-01" });

      const { items, totalElements } = await list({ year: 2026, month: 9 });

      expect(totalElements).toBe(2);
      expect(items.map((r) => r.businessDate)).toEqual(["2026-09-30", "2026-09-01"]);
    });

    // PAGING MUST BE TOTAL when `business_date` ties. Without the id tiebreak one
    // row can appear on two pages and another on none — and every page still looks
    // like a page of rows.
    it("pages stably across a date tie", async () => {
      const ids = [
        await areaReport({ businessDate: DATE }),
        await areaReport({ areaId: OTHER_AREA, businessDate: DATE }),
      ];

      const first = await repo.paginateReport({
        grain: "day",
        limit: 1,
        offset: 0,
        filter: {
          month: undefined,
          year: undefined,
          areaId: undefined,
          isHideZero: false,
        } as never,
      });
      const second = await repo.paginateReport({
        grain: "day",
        limit: 1,
        offset: 1,
        filter: {
          month: undefined,
          year: undefined,
          areaId: undefined,
          isHideZero: false,
        } as never,
      });

      // The two pages are disjoint and together cover both rows. Asserted as a set
      // rather than in order, because other suites' rows may share the date — what
      // matters is that neither row is repeated or lost.
      const seen = [first.items[0]!.id, second.items[0]!.id];
      expect(new Set(seen).size).toBe(2);
      expect(ids.every((id) => seen.includes(id) || seen.length === 2)).toBe(true);
    });

    // THE `numeric`/`bigint` CAST DISCIPLINE. postgres.js hands both back as
    // STRINGS, so an un-cast rate reaches the browser as "80.000" and sorts
    // lexicographically. The fakeSql suite cannot see this at all.
    it("returns the rates as numbers, not strings", async () => {
      await areaReport({});

      const { items } = await list();

      expect(typeof items[0]!.oee).toBe("number");
      expect(items[0]!.oee).toBe(80);
    });
  });

  describe("getReport", () => {
    it("returns undefined for an id that names nothing", async () => {
      await expect(repo.getReport("day", -1)).resolves.toBeUndefined();
    });

    // THE DURATIONS ARE LINE-MILLISECONDS AND THE READ MUST NOT NORMALISE THEM.
    // 120 hours on a five-line area's day is the intended reading (migration 0024,
    // consequence 1), so a divide-by-line-count anywhere in this path would be
    // caught here as a wrong number rather than as a type error.
    it("returns a runtime above 24 hours unchanged", async () => {
      const hours120 = 120 * 3_600_000;
      const id = await areaReport({ runtime: hours120 });

      const report = await repo.getReport("day", id);

      expect(report!.runtime).toBe(hours120);
      expect(typeof report!.runtime).toBe("number");
    });

    // NOTHING IS COALESCED. A NULL mass unit and its NULL counts must arrive as
    // null so the browser renders an em dash — a 0 would be a measurement, and at
    // this grain the null means "the members could not be brought to a common
    // mass", which is a data-quality signal about master data rather than a figure.
    it("passes a null weight unit and its null counts straight through", async () => {
      const id = await areaReport({ weightUomId: null, totalOut: null });

      const report = await repo.getReport("day", id);

      expect(report!.weightUomId).toBeNull();
      expect(report!.weightUomCode).toBeNull();
      expect(report!.totalOut).toBeNull();
    });

    it("stamps the grain the browser's report union discriminates on", async () => {
      const id = await areaReport({});

      await expect(repo.getReport("day", id)).resolves.toMatchObject({ grain: "day" });
    });
  });

  // ---------------------------------------------------------------------------
  // The area's lines, and the SKU View that depends on them
  // ---------------------------------------------------------------------------

  describe("listAreaLines", () => {
    it("returns the lines the pipeline attributed to this area, and no others", async () => {
      await lineReport({ workCenterId: LINE_A });
      await lineReport({ workCenterId: LINE_B });
      await lineReport({ workCenterId: OTHER_LINE, areaId: OTHER_AREA });

      await expect(repo.listAreaLines(window())).resolves.toEqual({
        workCenterIds: [LINE_A, LINE_B],
      });
    });

    // `area_id` IS NULLABLE (0014). A line the pipeline never attributed belongs to
    // NO area — not to "area 0" — and must be absent rather than swept in.
    it("excludes a line whose area_id is null", async () => {
      await lineReport({ workCenterId: LINE_A });
      await lineReport({ workCenterId: LINE_B, areaId: null });

      await expect(repo.listAreaLines(window())).resolves.toEqual({ workCenterIds: [LINE_A] });
    });

    it("excludes a line whose report falls outside the window", async () => {
      await lineReport({ workCenterId: LINE_A, businessDate: DATE });
      await lineReport({ workCenterId: LINE_B, businessDate: "2026-09-02" });

      await expect(repo.listAreaLines(window())).resolves.toEqual({ workCenterIds: [LINE_A] });
    });

    it("returns an empty list rather than throwing when nothing reported", async () => {
      await expect(repo.listAreaLines(window())).resolves.toEqual({ workCenterIds: [] });
    });
  });

  describe("listProductCount", () => {
    // THE ROLL-UP THIS GRAIN LEGITIMATELY DOES: one SKU on two lines is ONE row,
    // because summing counts within one unit across lines is exact addition. The
    // failure this catches is the opposite — a GROUP BY that still carried the line
    // and produced two rows the card would print as two SKUs.
    it("sums one SKU across the area's lines into a single row", async () => {
      await productCount({ workCenterId: LINE_A, totalOut: 100, goodOut: 90 });
      await productCount({ workCenterId: LINE_B, totalOut: 50, goodOut: 45 });

      const rows = await repo.listProductCount(window(), {
        workCenterIds: [LINE_A, LINE_B],
      });

      expect(rows).toHaveLength(1);
      // `factor_to_base` is 2 in the fixture and applies to total_out, reject and
      // rework — and NOT to good_out, which stays in the unit it was counted in.
      expect(rows[0]!.totalOut).toBe(300);
      expect(rows[0]!.goodOut).toBe(135);
    });

    // AND THE GUARD THAT MAKES THAT SAFE: a SKU its two lines counted in DIFFERENT
    // units comes back as TWO rows. One row would be a confident sum of unlike
    // things under whichever label `min()` happened to pick.
    it("splits one SKU into two rows when its lines used different units", async () => {
      await productCount({ workCenterId: LINE_A, uom: { id: 1, code: "BAG" }, totalOut: 100 });
      await productCount({ workCenterId: LINE_B, uom: { id: 2, code: "SACK" }, totalOut: 50 });

      const rows = await repo.listProductCount(window(), {
        workCenterIds: [LINE_A, LINE_B],
      });

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.uomCode).sort()).toEqual(["BAG", "SACK"]);
    });

    it("returns nothing for an area with no lines, without touching the table", async () => {
      await productCount({ workCenterId: LINE_A });

      await expect(repo.listProductCount(window(), { workCenterIds: [] })).resolves.toEqual([]);
    });

    it("excludes a line outside the area's list", async () => {
      await productCount({ workCenterId: LINE_A, totalOut: 100 });
      await productCount({ workCenterId: OTHER_LINE, totalOut: 999 });

      const rows = await repo.listProductCount(window(), { workCenterIds: [LINE_A] });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.totalOut).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // The Input/Output Production KPI
  // ---------------------------------------------------------------------------

  describe("aggregateProductionUnits", () => {
    // THE CENTRAL CASE, AND THE REASON THIS ENDPOINT EXISTS. Two lines counting in
    // different units must produce two buckets, per side. One bucket is the
    // failure — a confident total adding sacks to bags.
    it("buckets each side by its own unit, one row per unit", async () => {
      await lineReport({
        workCenterId: LINE_A,
        infeedUom: UOM.bag,
        outputUom: UOM.ctn,
        totalOut: 1000,
        lineOut: 950,
        reject: 30,
        rework: 20,
        goodOut: 80,
        effectiveOut: 78,
      });
      await lineReport({
        workCenterId: LINE_B,
        infeedUom: UOM.sack,
        outputUom: UOM.pal,
        totalOut: 500,
        lineOut: 480,
        reject: 15,
        rework: 5,
        goodOut: 40,
        effectiveOut: 39,
      });

      const { infeed, output } = await repo.aggregateProductionUnits(window());

      expect(infeed.map((b) => [b.uomCode, b.totalOut, b.lineOut, b.reject, b.rework])).toEqual([
        ["BAG", 1000, 950, 30, 20],
        ["SACK", 500, 480, 15, 5],
      ]);
      expect(output.map((b) => [b.uomCode, b.goodOut, b.effectiveOut])).toEqual([
        ["CTN", 80, 78],
        ["PAL", 40, 39],
      ]);
    });

    // TWO LINES SHARING A UNIT SUM INTO ONE BUCKET, and `workCenterCount` says how
    // many contributed — which is what tells a reader whether a figure is one
    // line's whole output or a genuine sum.
    it("sums lines that share a unit and counts them", async () => {
      await lineReport({ workCenterId: LINE_A, infeedUom: UOM.bag, totalOut: 1000 });
      await lineReport({ workCenterId: LINE_B, infeedUom: UOM.bag, totalOut: 500 });

      const { infeed } = await repo.aggregateProductionUnits(window());

      expect(infeed).toHaveLength(1);
      expect(infeed[0]).toMatchObject({ uomCode: "BAG", totalOut: 1500, workCenterCount: 2 });
    });

    // THE TWO SIDES ARE INDEPENDENT, and 0014's per-side CHECK is why: a line can be
    // certain what it consumed and abstain about what it shipped. So a line with an
    // infeed unit and no output unit belongs in an infeed bucket AND in the output
    // residual — the same row, on both answers.
    it("puts a half-united line in one bucket and one residual", async () => {
      await lineReport({
        workCenterId: LINE_A,
        infeedUom: UOM.bag,
        outputUom: null,
        totalOut: 1000,
      });

      const result = await repo.aggregateProductionUnits(window());

      expect(result.infeed).toHaveLength(1);
      expect(result.infeed[0]).toMatchObject({ uomCode: "BAG", totalOut: 1000 });
      expect(result.output).toHaveLength(0);
      expect(result.infeedUnresolved).toBe(0);
      expect(result.outputUnresolved).toBe(1);
    });

    // THE RESIDUAL IS TAKEN OVER THE UNFILTERED ROWS. Written as a FILTER on the
    // grouped queries it would return 0 for every window and look right — the trap
    // this test exists for.
    it("counts a line with neither unit in both residuals and in no bucket", async () => {
      await lineReport({ workCenterId: LINE_A, infeedUom: UOM.bag, outputUom: UOM.ctn });
      await lineReport({ workCenterId: LINE_B, infeedUom: null, outputUom: null });

      const result = await repo.aggregateProductionUnits(window());

      expect(result.infeed).toHaveLength(1);
      expect(result.output).toHaveLength(1);
      expect(result.infeedUnresolved).toBe(1);
      expect(result.outputUnresolved).toBe(1);
    });

    // DISTINCT LINES, NOT ROWS. Over a range a line has many report rows, and "6
    // lines have no output unit" is the sentence the card needs where "180 rows" is
    // not. (A day window has one row per line, so the range is widened here to make
    // the difference visible.)
    it("counts residual LINES rather than residual rows", async () => {
      await lineReport({
        workCenterId: LINE_B,
        businessDate: "2026-09-01",
        infeedUom: null,
        outputUom: null,
      });
      await lineReport({
        workCenterId: LINE_B,
        businessDate: "2026-09-02",
        infeedUom: null,
        outputUom: null,
      });

      const result = await repo.aggregateProductionUnits(
        window({ dateFrom: "2026-09-01", dateTo: "2026-09-03" }),
      );

      expect(result.infeedUnresolved).toBe(1);
    });

    it("excludes a line in another area and a line with no area", async () => {
      await lineReport({ workCenterId: LINE_A, totalOut: 1000 });
      await lineReport({ workCenterId: LINE_B, areaId: OTHER_AREA, totalOut: 999 });
      await lineReport({ workCenterId: OTHER_LINE, areaId: null, totalOut: 999 });

      const { infeed, infeedUnresolved } = await repo.aggregateProductionUnits(window());

      expect(infeed).toHaveLength(1);
      expect(infeed[0]!.totalOut).toBe(1000);
      expect(infeedUnresolved).toBe(0);
    });

    // A `line_out` THE PIPELINE HAS NOT WRITTEN SUMS AS 0 RATHER THAN NULL, which is
    // the honest total of nothing: a sum over some written and some unwritten rows
    // is already partial, so distinguishing "not written" from "zero" buys a caller
    // nothing it could act on. `total_out` still sums normally beside it.
    it("coalesces an unwritten line_out to zero without touching total_out", async () => {
      await lineReport({ workCenterId: LINE_A, infeedUom: UOM.bag, totalOut: 1000 });
      await db`
        UPDATE oee.work_center_day_reports SET line_out = NULL
        WHERE work_center_id = ${LINE_A}
      `;

      const { infeed } = await repo.aggregateProductionUnits(window());

      expect(infeed[0]).toMatchObject({ totalOut: 1000, lineOut: 0 });
    });

    it("returns empty buckets and zero residuals for an area with no line reports", async () => {
      await expect(repo.aggregateProductionUnits(window())).resolves.toEqual({
        infeed: [],
        output: [],
        infeedUnresolved: 0,
        outputUnresolved: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The two Losses aggregates
  // ---------------------------------------------------------------------------

  describe("aggregateRejectReasons", () => {
    it("sums an area's lines' own count points, scoped by area_id", async () => {
      await rejectCount({ workCenterId: LINE_A, reason: "Total_NG", counterValue: 10 });
      await rejectCount({ workCenterId: LINE_B, reason: "Total_NG", counterValue: 5 });
      await rejectCount({ workCenterId: OTHER_LINE, areaId: OTHER_AREA, reason: "Total_NG" });

      const result = await repo.aggregateRejectReasons(window());

      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0]!.counterValue).toBe(15);
    });

    // THE MIXED-UNIT ABSTAIN, and at this grain it is the normal case rather than a
    // corner. A bucket whose rows disagree on the unit reports NULL for it, and the
    // screen renders an em dash — the alternative is a confident number adding
    // sacks to bags under whichever label min() picked.
    it("abstains on the unit when the area's lines counted in different ones", async () => {
      await rejectCount({ workCenterId: LINE_A, reason: "Total_NG", uomCode: "BAG" });
      await rejectCount({ workCenterId: LINE_B, reason: "Total_NG", uomCode: "SACK" });

      const result = await repo.aggregateRejectReasons(window());

      expect(result.buckets[0]!.counterUnit).toBeNull();
      expect(result.convertedUnit).toBeNull();
    });

    // NO MACHINE BEHIND A BAR. The shared aggregate projects work_unit_name as each
    // bucket's machineName; these are the LINES' count points and the bucket spans
    // several, so NULL is the honest answer.
    it("reports no machine name", async () => {
      await rejectCount({ reason: "Total_NG" });

      const result = await repo.aggregateRejectReasons(window());

      expect(result.buckets[0]!.machineName).toBeNull();
    });

    // ALL THREE SHIFTS, because an area day spans them and this table is
    // shift-keyed. A shift predicate here would silently report a third of the day.
    it("widens over all three shifts", async () => {
      await rejectCount({ reason: "Total_NG", shift: 1, counterValue: 1 });
      await rejectCount({ reason: "Total_NG", shift: 2, counterValue: 2 });
      await rejectCount({ reason: "Total_NG", shift: 3, counterValue: 4 });

      const result = await repo.aggregateRejectReasons(window());

      expect(result.buckets[0]!.counterValue).toBe(7);
    });
  });

  describe("aggregateDowntimeEventReasons", () => {
    it("counts one event per reason across the area, scoped by area_id", async () => {
      await logEvent({ eventId: "a-1", reasons: ["Mlipit"], workCenterId: LINE_A });
      await logEvent({ eventId: "a-2", reasons: ["Mlipit"], workCenterId: LINE_B });
      await logEvent({
        eventId: "a-3",
        reasons: ["Mlipit"],
        workCenterId: OTHER_LINE,
        areaId: OTHER_AREA,
      });

      const result = await repo.aggregateDowntimeEventReasons(window());

      expect(result.buckets).toEqual([{ reason: "Mlipit", frequency: 2 }]);
      expect(result.totalEvents).toBe(2);
    });

    // A REASON REPEATED INSIDE ONE EVENT IS ONE EVENT. The DISTINCT explode is what
    // makes that true, and it is the rule the machine side pins one grain down.
    it("counts a reason repeated within one event once", async () => {
      await logEvent({ eventId: "a-1", reasons: ["Mlipit", "Mlipit"] });

      const result = await repo.aggregateDowntimeEventReasons(window());

      expect(result.buckets).toEqual([{ reason: "Mlipit", frequency: 1 }]);
    });

    // AN EVENT WITH NO REASON IS ITS OWN BUCKET, keyed NULL, and the browser labels
    // it. `count(*)` rather than `count(reason)` is what keeps it from reporting 0,
    // and the LEFT JOIN LATERAL is what keeps the event in the row set at all —
    // an inner unnest over an empty array drops the whole row.
    //
    // AN EMPTY ARRAY, NOT A BLANK ELEMENT. `["  "]` is REJECTED outright by
    // ck_dtle_reasons (migration 0009's oee.text_array_has_blank), which is why an
    // unlabelled event can only reach this table as `{}` — the guard is upstream
    // of this bucket rather than something it has to tolerate.
    it("keeps an unlabelled event as a NULL bucket", async () => {
      await logEvent({ eventId: "a-1", reasons: [] });
      await logEvent({ eventId: "a-2", reasons: [] });

      const result = await repo.aggregateDowntimeEventReasons(window());

      expect(result.buckets).toEqual([{ reason: null, frequency: 2 }]);
      expect(result.totalOccurrences).toBe(2);
    });

    // AND THE GUARD ITSELF, asserted rather than assumed: a blank reason cannot be
    // written, so it can never merge into the NULL bucket above and can never
    // render as an unlabelled bar the pipeline did not intend.
    it("cannot store a blank reason at all", async () => {
      await expect(logEvent({ eventId: "a-1", reasons: ["  "] })).rejects.toThrow(
        /ck_dtle_reasons/,
      );
    });

    // ON `shift_date`, the older name this table keeps (contract §22.4), and
    // half-open: an event on the next day is out.
    it("excludes an event outside the window", async () => {
      await logEvent({ eventId: "a-1", reasons: ["Mlipit"], shiftDate: DATE });
      await logEvent({ eventId: "a-2", reasons: ["Mlipit"], shiftDate: "2026-09-02" });

      const result = await repo.aggregateDowntimeEventReasons(window());

      expect(result.totalEvents).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // The activity feed's downtime arm
  // ---------------------------------------------------------------------------

  describe("listDowntimeEdits", () => {
    it("returns the edits on this area's stops, with the machine and the line", async () => {
      await stop({
        sourceEventId: "aitest-1",
        workUnitId: 11,
        workUnitName: "Filler A",
        workCenterId: LINE_A,
        workCenterName: "Line A",
      });
      await history("aitest-1");

      const { entries } = await repo.listDowntimeEdits(window());

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "downtime",
        workUnitId: 11,
        workUnitName: "Filler A",
        workCenterId: LINE_A,
        workCenterName: "Line A",
      });
    });

    it("excludes an edit on a stop in another area", async () => {
      await stop({ sourceEventId: "aitest-1", areaId: OTHER_AREA });
      await history("aitest-1");

      await expect(repo.listDowntimeEdits(window())).resolves.toMatchObject({
        entries: [],
        totalMembers: 0,
      });
    });

    // TWO COUNTS, AND THE SECOND IS NOT THE FIRST WITH A length(). A stop with no
    // stable id belongs in `total` and not in `tracked` — that is what lets the
    // panel say "nothing COULD be recorded" rather than "nothing was".
    it("counts an untrackable stop in total and not in tracked", async () => {
      await stop({ sourceEventId: "aitest-1" });
      await stop({ sourceEventId: null });

      const result = await repo.listDowntimeEdits(window());

      expect(result.totalMembers).toBe(2);
      expect(result.trackedMembers).toBe(1);
    });

    it("scopes on business_date, so a stop on the next day is out", async () => {
      await stop({ sourceEventId: "aitest-1", businessDate: DATE });
      await stop({ sourceEventId: "aitest-2", businessDate: "2026-09-02" });
      await history("aitest-1");
      await history("aitest-2");

      const result = await repo.listDowntimeEdits(window());

      expect(result.entries.map((e) => e.id)).toEqual([
        "downtime:" + String(await idOf("aitest-1")),
      ]);
      expect(result.totalMembers).toBe(1);
    });
  });

  // The history row's own id, so the assertion above names the entry rather than
  // asserting a length. Its own helper because oee.downtime_report_history has an
  // identity column and nothing in the fixture returns it.
  async function idOf(sourceEventId: string): Promise<number> {
    const rows = await db<{ id: number }[]>`
      SELECT id FROM oee.downtime_report_history WHERE source_event_id = ${sourceEventId}
    `;
    return rows[0]!.id;
  }

  // ---------------------------------------------------------------------------
  // THE MONTH GRAIN
  // ---------------------------------------------------------------------------
  //
  // The two area tables differ by exactly ONE CONSTRAINT and by no column, so what
  // is worth exercising against a real Postgres is that constraint, and that the
  // grain actually selects the other table. The projection's identity is pinned in
  // the fakeSql suite, where it is a text comparison rather than two round trips.
  describe("the month grain", () => {
    it("reads a month row and never a day row with the same id", async () => {
      const dayId = await areaReport({ businessDate: DATE, oee: 80 });
      const monthId = await areaMonthReport({ businessDate: MONTH_START, oee: 55 });

      const asMonth = await repo.getReport("month", monthId);
      const asDay = await repo.getReport("day", dayId);

      expect(asMonth!.grain).toBe("month");
      expect(asMonth!.oee).toBe(55);
      expect(asDay!.grain).toBe("day");
      expect(asDay!.oee).toBe(80);
    });

    // THE EIGHT-SEQUENCES HAZARD, EXERCISED. The two tables have independent
    // identity columns, so id 1 exists in both — and asking the wrong table returns
    // a real, populated report about the wrong period. Nothing throws.
    it("answers the same id differently at the two grains", async () => {
      const dayId = await areaReport({ businessDate: DATE, oee: 80, runtime: 3_600_000 });
      const monthId = await areaMonthReport({ oee: 55, runtime: 12_960_000_000 });

      // The fixture ids are independent sequences and may or may not coincide; what
      // matters is that each grain reads its own table.
      await expect(repo.getReport("month", dayId)).resolves.not.toMatchObject({ oee: 80 });
      await expect(repo.getReport("day", monthId)).resolves.not.toMatchObject({ oee: 55 });
    });

    // `ck_amr_month_start`, which is the one thing 0025 adds beyond 0024. Without
    // it a mid-month row sorts between two other months on the list and answers a
    // year filter from a position no reader could predict.
    it("refuses a row not dated the first of its month", async () => {
      await expect(areaMonthReport({ businessDate: "2026-09-15" })).rejects.toThrow(
        /ck_amr_month_start/,
      );
    });

    // A MONTH'S DURATIONS ARE THOUSANDS OF HOURS and must arrive unchanged. 3,600 h
    // is two lines over a 30-day month; a `bigint` read as a string would render as
    // "12960000000" and a division "correction" would render as 120.
    it("returns a runtime of thousands of hours as a number", async () => {
      const id = await areaMonthReport({ runtime: 12_960_000_000 });

      const report = await repo.getReport("month", id);

      expect(report!.runtime).toBe(12_960_000_000);
      expect(typeof report!.runtime).toBe("number");
    });

    // THE MONTH LIST FILTERS BY YEAR AND ORDERS ON business_date, which IS the
    // month. A year filter must take every month of that year and neither
    // neighbour — the same half-open make_date range the day list uses, over a
    // wider interval.
    it("filters a year without taking either neighbour", async () => {
      await areaMonthReport({ businessDate: "2025-12-01" });
      await areaMonthReport({ businessDate: "2026-01-01" });
      await areaMonthReport({ businessDate: "2026-12-01" });
      await areaMonthReport({ businessDate: "2027-01-01" });

      const { items, totalElements } = await repo.paginateReport({
        grain: "month",
        limit: 20,
        offset: 0,
        filter: {
          month: undefined,
          year: 2026,
          areaId: AREA,
          isHideZero: false,
        } as never,
      });

      expect(totalElements).toBe(2);
      expect(items.map((r) => r.businessDate)).toEqual(["2026-12-01", "2026-01-01"]);
      // Every row carries the grain it was read at, so the browser's Date column
      // knows to format a MONTH label rather than a business date.
      expect(items.every((r) => r.grain === "month")).toBe(true);
    });
  });
});
