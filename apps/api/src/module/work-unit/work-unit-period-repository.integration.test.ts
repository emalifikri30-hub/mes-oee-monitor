// Integration coverage for the DAY and MONTH reads, against a REAL Postgres.
//
// WHY A CONTAINER, WHEN A fakeSql SUITE COULD ASSERT THE SQL TEXT
//
// Everything these queries get wrong, they get wrong QUIETLY:
//
//   1. `availability_loss_time` was misspelled `availablity_loss_time` on both
//      tables until 0013 renamed it. A projection naming the wrong one is a
//      "column does not exist" against the real database and an invisible typo
//      against a fake. This suite is the only thing that proves the rename and
//      the reader agree.
//   2. mttr/mtbf must arrive as NULL, not 0. The screens render an em dash for
//      one and "00 s" for the other, and only one of those is true before the
//      pipeline computes them. A `coalesce(mttr, 0)` slipped into the projection
//      changes nothing that any type or regex would notice.
//   3. `month` exists on one table and not the other, and is selected as a
//      literal NULL at day grain so both shapes match. Get that backwards and
//      the day query fails outright while the month query silently loses its
//      label.
//   4. summariseApprovalsInWindow counts three OTHER records. Off-by-one at
//      either window edge — including shift 3, which starts at 23:00 and ends
//      the next morning — renders "2 of 3 shifts approved" when the truth is
//      3 of 3. Plausible either way.
//   5. The business-date filter must be exact. The shift list's equivalent
//      compares against a timestamptz and misattributes both ends of a month
//      (TODOS.md §17); the whole point of 0013's column is that this one does
//      not, and only a real month boundary can show it.
//
// THE FIXTURE IS THREE REAL SHIFTS AND THE DAY ABOVE THEM, so the cross-check
// docs/gold-write-contract.md §15.6 asks the pipeline to assert as a dbt test is
// asserted here too: a day's totals equal the sum of its shift reports.
//
//   docker run --rm -d --name oee-itest-pg18 -p 55434:5432 \
//     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gold_test postgres:18-alpine
//   GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api run db:migrate
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api exec vp test work-unit-period
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "../../shared/database/postgres.js";
import { WorkUnitReportReaderRepository } from "./work-unit-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// Asia/Jakarta, UTC+7. Business day 2026-08-01 runs 07:00 local (00:00Z) to
// 07:00 local on the 2nd (00:00Z on the 2nd).
const TZ = "Asia/Jakarta";
const BUSINESS_DATE = "2026-08-01";
const DAY_START = "2026-08-01T00:00:00Z";

// The three shift-start INSTANTS of business day 2026-08-01, in a UTC+7 plant:
// 07:00, 15:00 and 23:00 local are 00:00Z, 08:00Z and 16:00Z.
//
// Shift 3 is the one that matters. It starts at 23:00 local on the 1st and ENDS
// at 07:00 local on the 2nd, so it belongs to business day 2026-08-01 despite
// most of it falling on the 2nd — the case a naive `date::date` gets wrong.
const SHIFT_STARTS = ["2026-08-01T00:00:00Z", "2026-08-01T08:00:00Z", "2026-08-01T16:00:00Z"];

// Sentinels well outside anything the dev seed writes, so this file cleans up
// after itself without touching another suite's rows.
const WORK_UNIT = 7373;
const SHIFT_REPORT_BASE = 737_300;
const DAY_REPORT_ID = 737_310;
const MONTH_REPORT_ID = 737_320;

// One shift's worth of measures, satisfying the waterfall identities so the
// summed day row is coherent rather than arbitrary. Scaled per shift by `n` so
// the three rows differ and a sum cannot accidentally equal one of them.
function measures(n: number) {
  const pdt = 1_000_000 * n;
  const updt = 2_000_000 * n;
  const ms = 300_000 * n;
  const rs = 400_000 * n;
  const rejectTime = 100_000 * n;
  const reworkTime = 50_000 * n;
  const availability = 28_800_000;
  const production = availability - pdt;
  const operating = production - updt;
  const net = operating - ms - rs;
  const valueAdded = net - rejectTime - reworkTime;

  return {
    pdt,
    updt,
    ms,
    rs,
    rejectTime,
    reworkTime,
    availability,
    production,
    operating,
    net,
    valueAdded,
  };
}

describe.skipIf(!url)("WorkUnitReportReaderRepository — day and month grains", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new WorkUnitReportReaderRepository({ goldDb: db });

  async function truncateFixtures() {
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = ${WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_day_reports WHERE work_unit_id = ${WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_month_reports WHERE work_unit_id = ${WORK_UNIT}`;
  }

  afterAll(async () => {
    await truncateFixtures();
    await db.end();
  });

  beforeEach(async () => {
    await truncateFixtures();

    for (const [i, start] of SHIFT_STARTS.entries()) {
      const m = measures(i + 1);
      await db`
        INSERT INTO oee.work_unit_shift_reports (
          id, shift, date, business_date, time_zone, work_unit_id, work_center_id, uom_id,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time,
          reject, rework, mttr, mtbf
        ) VALUES (
          ${SHIFT_REPORT_BASE + i}, ${i + 1}, ${start}::timestamptz, ${BUSINESS_DATE}::date, ${TZ},
          ${WORK_UNIT}, 1, 1,
          0, 0, 0, 0, 0,
          0, 0, 0,
          ${m.operating}, ${m.availability}, ${m.production}, ${m.pdt}, ${m.operating},
          ${m.updt}, ${m.net}, ${m.rs}, ${m.ms}, ${m.valueAdded},
          ${m.reworkTime}, ${m.rejectTime}, 0, 0,
          ${m.pdt}, ${m.updt}, ${m.ms + m.rs},
          ${m.ms}, ${m.rs}, ${m.rejectTime + m.reworkTime},
          0, 0, 0, 0
        )
      `;
    }
  });

  // The day row, summed from the three shifts above exactly as the seed script
  // and the dbt model must do it.
  async function insertDayReport(opts: { businessDate?: string; oee?: number } = {}) {
    const totals = [1, 2, 3].map(measures);
    const sum = (pick: (m: ReturnType<typeof measures>) => number) =>
      totals.reduce((t, m) => t + pick(m), 0);

    await db`
      INSERT INTO oee.work_unit_day_reports (
        id, date, business_date, time_zone, work_unit_id, work_unit_name,
        work_center_id, work_center_name, uom_id, uom_name,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework
      ) VALUES (
        ${DAY_REPORT_ID}, ${DAY_START}::timestamptz,
        ${opts.businessDate ?? BUSINESS_DATE}::date, ${TZ},
        ${WORK_UNIT}, 'Vertical Packer N', 1, 'Line 1', 1, 'Bag',
        70.5, ${opts.oee ?? 80.25}, 90.125, 95, 99,
        1000, 990, 990,
        ${sum((m) => m.operating)}, ${sum((m) => m.availability)}, ${sum((m) => m.production)},
        ${sum((m) => m.pdt)}, ${sum((m) => m.operating)},
        ${sum((m) => m.updt)}, ${sum((m) => m.net)}, ${sum((m) => m.rs)}, ${sum((m) => m.ms)},
        ${sum((m) => m.valueAdded)},
        ${sum((m) => m.reworkTime)}, ${sum((m) => m.rejectTime)}, 0, 0,
        ${sum((m) => m.pdt)}, ${sum((m) => m.updt)}, ${sum((m) => m.ms + m.rs)},
        ${sum((m) => m.ms)}, ${sum((m) => m.rs)},
        ${sum((m) => m.rejectTime + m.reworkTime)},
        12.5, 3.25
      )
    `;
  }

  async function approveShift(shift: number) {
    await db`
      INSERT INTO oee.work_unit_shift_report_approvals
        (work_unit_id, date, shift, status, closed_at, closed_by, closed_by_name, source)
      VALUES (${WORK_UNIT}, ${SHIFT_STARTS[shift - 1]!}::timestamptz, ${shift},
              'closed', now(), 'sub-1', 'Operator One', 'operator')
    `;
  }

  describe("getPeriodReport", () => {
    it("reads every measure, with the post-0013 spelling of availability_loss_time", async () => {
      await insertDayReport();

      const report = await repo.getPeriodReport("day", DAY_REPORT_ID);

      // Point 1 in the header: if the column were still misspelled, or the
      // projection named the old spelling, this query would not have run at all.
      expect(report?.availabilityLossTime).toBe(
        measures(1).updt + measures(2).updt + measures(3).updt,
      );
      expect(report?.grain).toBe("day");
      expect(report?.businessDate).toBe(BUSINESS_DATE);
      expect(report?.timeZone).toBe(TZ);
      expect(report?.workCenterId).toBe(1);
      expect(report?.oee).toBe(80.25);
      // numeric columns come back through round(...)::float8, so these are JS
      // numbers rather than the strings postgres.js gives for a raw numeric.
      expect(typeof report?.reject).toBe("number");
      expect(report?.reject).toBe(12.5);
    });

    // Point 2. The distinguishing case for commit 12a2781's rule, at the one
    // place in this feature where 0 and "not computed" are both plausible.
    it("returns mttr and mtbf as null, never 0, before the pipeline writes them", async () => {
      await insertDayReport();

      const report = await repo.getPeriodReport("day", DAY_REPORT_ID);

      expect(report?.mttr).toBeNull();
      expect(report?.mtbf).toBeNull();
    });

    // Point 3. `month` is a column on one table and a literal NULL on the other.
    it("selects month at month grain and null at day grain", async () => {
      await insertDayReport();
      await db`
        INSERT INTO oee.work_unit_month_reports (
          id, month, date, business_date, time_zone, work_unit_id, uom_id,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time, reject, rework
        ) VALUES (
          ${MONTH_REPORT_ID}, '2026-08', ${DAY_START}::timestamptz, ${BUSINESS_DATE}::date, ${TZ},
          ${WORK_UNIT}, 1,
          0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        )
      `;

      const day = await repo.getPeriodReport("day", DAY_REPORT_ID);
      const month = await repo.getPeriodReport("month", MONTH_REPORT_ID);

      expect(day?.month).toBeNull();
      expect(month?.month).toBe("2026-08");
      expect(month?.grain).toBe("month");
    });

    it("returns undefined for an id that names nothing", async () => {
      expect(await repo.getPeriodReport("day", 1)).toBeUndefined();
    });
  });

  // The invariant gold-write-contract §15.6 asks the pipeline to assert, checked
  // here against the same arithmetic the seed script uses.
  describe("the day-equals-its-shifts cross-check", () => {
    it("agrees with the sum of the shift reports on every duration", async () => {
      await insertDayReport();

      const day = await repo.getPeriodReport("day", DAY_REPORT_ID);
      const shiftSums = await db<
        { runtime: number; availabilityTime: number; updtTime: number; netTime: number }[]
      >`
        SELECT sum(runtime)::float8 AS runtime,
               sum(availability_time)::float8 AS availability_time,
               sum(updt_time)::float8 AS updt_time,
               sum(net_time)::float8 AS net_time
        FROM oee.work_unit_shift_reports
        WHERE work_unit_id = ${WORK_UNIT} AND business_date = ${BUSINESS_DATE}::date
      `;

      expect(day?.runtime).toBe(shiftSums[0]?.runtime);
      expect(day?.availabilityTime).toBe(shiftSums[0]?.availabilityTime);
      expect(day?.updtTime).toBe(shiftSums[0]?.updtTime);
      expect(day?.netTime).toBe(shiftSums[0]?.netTime);
    });

    // The waterfall reads each bar as the previous bar's base plus that step's
    // losses, and deliberately does not back-compute a band — so a row whose
    // parts do not add up renders ragged rather than being papered over.
    it("keeps the waterfall identities on the summed row", async () => {
      await insertDayReport();

      const r = await repo.getPeriodReport("day", DAY_REPORT_ID);

      expect(r!.productionTime + r!.pdtTime).toBe(r!.availabilityTime);
      expect(r!.operatingTime + r!.updtTime).toBe(r!.productionTime);
      expect(r!.netTime + r!.msTime + r!.reduceSpeedTime).toBe(r!.operatingTime);
      expect(r!.valueAddedTime + r!.rejectTime + r!.reworkTime).toBe(r!.netTime);
    });
  });

  // Point 4. The window runs 07:00 to 07:00 plant-local, so shift 3 — which
  // starts at 23:00 and ends the next morning — is inside it exactly once.
  describe("summariseApprovalsInWindow", () => {
    const window = {
      workUnitId: WORK_UNIT,
      from: new Date(DAY_START),
      to: new Date("2026-08-02T00:00:00Z"),
    };

    it("counts all three shifts of the business day, including shift 3", async () => {
      const summary = await repo.summariseApprovalsInWindow(window);

      expect(summary.shiftsTotal).toBe(3);
      expect(summary.shiftsClosed).toBe(0);
    });

    it("counts only the approved ones as closed", async () => {
      await approveShift(1);
      await approveShift(3);

      const summary = await repo.summariseApprovalsInWindow(window);

      expect(summary.shiftsTotal).toBe(3);
      expect(summary.shiftsClosed).toBe(2);
    });

    it("reports 3 of 3 once every shift is approved", async () => {
      await approveShift(1);
      await approveShift(2);
      await approveShift(3);

      const summary = await repo.summariseApprovalsInWindow(window);

      expect(summary).toEqual({ shiftsTotal: 3, shiftsClosed: 3 });
    });

    // THE HALF-OPEN BOUND, at the one instant it matters. Shift 1 starts at
    // exactly 07:00 local, which IS the instant the previous business day's
    // window ends. It must belong to this day and not to both.
    //
    // An inclusive upper bound would count it twice — once here and once in the
    // day before — and the symptom would be a day reporting "1 of 4 shifts
    // approved" on a plant that runs three.
    it("excludes a shift starting exactly at the previous window's end", async () => {
      const previousDay = await repo.summariseApprovalsInWindow({
        workUnitId: WORK_UNIT,
        from: new Date("2026-07-31T00:00:00Z"),
        to: new Date(DAY_START),
      });

      expect(previousDay.shiftsTotal).toBe(0);
    });

    it("reports zero for a machine with no shift reports in the window", async () => {
      const summary = await repo.summariseApprovalsInWindow({ ...window, workUnitId: 999_999 });

      expect(summary).toEqual({ shiftsTotal: 0, shiftsClosed: 0 });
    });
  });

  // Point 5. The filter compares a real `date` column, so it is exact — unlike
  // the shift list's, which compares against a timestamptz it cannot zone.
  describe("paginatePeriodReport", () => {
    it("finds the report by its month and year", async () => {
      await insertDayReport();

      const page = await repo.paginatePeriodReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { month: 8, year: 2026, workUnitIds: [WORK_UNIT] },
      });

      expect(page.totalElements).toBe(1);
      expect(page.items[0]?.id).toBe(DAY_REPORT_ID);
      expect(page.items[0]?.grain).toBe("day");
      expect(page.items[0]?.businessDate).toBe(BUSINESS_DATE);
    });

    // THE BOUNDARY THE SHIFT LIST GETS WRONG. 2026-08-31 is in August and
    // 2026-09-01 is not, and neither depends on a session time zone here.
    it("puts the last day of the month in that month and the first of the next in the next", async () => {
      await db`DELETE FROM oee.work_unit_day_reports WHERE work_unit_id = ${WORK_UNIT}`;
      await insertDayReport({ businessDate: "2026-08-31" });

      const august = await repo.paginatePeriodReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { month: 8, year: 2026, workUnitIds: [WORK_UNIT] },
      });
      const september = await repo.paginatePeriodReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { month: 9, year: 2026, workUnitIds: [WORK_UNIT] },
      });

      expect(august.totalElements).toBe(1);
      expect(september.totalElements).toBe(0);
    });

    it("hides zero-OEE rows only when asked", async () => {
      await db`DELETE FROM oee.work_unit_day_reports WHERE work_unit_id = ${WORK_UNIT}`;
      await insertDayReport({ oee: 0 });

      const shown = await repo.paginatePeriodReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { workUnitIds: [WORK_UNIT] },
      });
      const hidden = await repo.paginatePeriodReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { workUnitIds: [WORK_UNIT], isHideZero: true },
      });

      expect(shown.totalElements).toBe(1);
      expect(hidden.totalElements).toBe(0);
    });

    // An empty id list must contribute NO predicate rather than `IN ()`, which
    // is not valid SQL — the same guard the shift list has.
    it("treats an empty work-unit list as no filter rather than a syntax error", async () => {
      await insertDayReport();

      const page = await repo.paginatePeriodReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { workUnitIds: [] },
      });

      expect(page.totalElements).toBeGreaterThanOrEqual(1);
    });
  });

  // FAILURE MODE F2 in the plan, and the reason this needs a database: the wrong
  // arithmetic here renders a plausible SKU total, never an error.
  describe("listPeriodProductCount", () => {
    async function count(opts: {
      date: string;
      productId: number;
      uomCode: string;
      factor: number;
      totalOut: number;
      goodOut: number;
    }) {
      await db`
        INSERT INTO oee.product_count_wu_day (
          date, product_id, product_name, product_code,
          work_unit_id, work_unit_name, work_unit_code,
          uom_id, uom_name, uom_code,
          base_uom_id, base_uom_name, base_uom_code, factor_to_base,
          total_out, good_out, reject, rework
        ) VALUES (
          ${opts.date}::date, ${opts.productId}, ${"SKU " + String(opts.productId)},
          ${"SKU-" + String(opts.productId)},
          ${WORK_UNIT}, 'Vertical Packer N', 'VP-N',
          1, ${opts.uomCode}, ${opts.uomCode},
          1, 'Bag', 'BAG', ${opts.factor},
          ${opts.totalOut}, ${opts.goodOut}, 0, 0
        )
      `;
    }

    async function insertMonthReport(businessDate: string) {
      await db`
        INSERT INTO oee.work_unit_month_reports (
          id, month, date, business_date, time_zone, work_unit_id, uom_id,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time, reject, rework
        ) VALUES (
          ${MONTH_REPORT_ID}, '2026-08', ${DAY_START}::timestamptz, ${businessDate}::date, ${TZ},
          ${WORK_UNIT}, 1,
          0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
        )
      `;
    }

    beforeEach(async () => {
      await db`DELETE FROM oee.product_count_wu_day WHERE work_unit_id = ${WORK_UNIT}`;
    });

    it("reads a single day without any zone conversion", async () => {
      await insertDayReport();
      await count({
        date: BUSINESS_DATE,
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 100,
        goodOut: 90,
      });

      const items = await repo.listPeriodProductCount("day", DAY_REPORT_ID);

      expect(items).toHaveLength(1);
      expect(items[0]?.totalOut).toBe(100);
      expect(items[0]?.goodOut).toBe(90);
    });

    // THE SILENT ONE. 10 cartons of 12 is 120 bags; 10 bags is 10 bags. Summing
    // the raw counters gives 20 "units" of nothing and looks entirely reasonable.
    it("sums total_out in BASE units when factor_to_base differs across days", async () => {
      await insertMonthReport(BUSINESS_DATE);
      await count({
        date: "2026-08-01",
        productId: 1,
        uomCode: "CARTON",
        factor: 12,
        totalOut: 10,
        goodOut: 10,
      });
      await count({
        date: "2026-08-02",
        productId: 1,
        uomCode: "CARTON",
        factor: 12,
        totalOut: 10,
        goodOut: 10,
      });

      const items = await repo.listPeriodProductCount("month", MONTH_REPORT_ID);

      expect(items).toHaveLength(1);
      // 20 cartons x 12 = 240 bags, NOT 20.
      expect(items[0]?.totalOut).toBe(240);
    });

    // good_out is deliberately unscaled and labelled in uom_code, so it cannot be
    // summed across differing units at all. Two honest rows beat one wrong total.
    it("splits a product that changed pack size into one row per unit", async () => {
      await insertMonthReport(BUSINESS_DATE);
      await count({
        date: "2026-08-01",
        productId: 1,
        uomCode: "CARTON",
        factor: 12,
        totalOut: 10,
        goodOut: 10,
      });
      await count({
        date: "2026-08-02",
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 50,
        goodOut: 50,
      });

      const items = await repo.listPeriodProductCount("month", MONTH_REPORT_ID);

      expect(items).toHaveLength(2);
      expect(items.map((i) => i.uomCode).sort()).toEqual(["BAG", "CARTON"]);
      // Neither row's good_out has been added to the other's.
      expect(items.map((i) => i.goodOut).sort((a, b) => a - b)).toEqual([10, 50]);
    });

    // A month must reach its whole month and stop there.
    it("covers every day of the month and excludes the next month's first", async () => {
      await insertMonthReport(BUSINESS_DATE);
      await count({
        date: "2026-08-01",
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 1,
        goodOut: 1,
      });
      await count({
        date: "2026-08-31",
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 1,
        goodOut: 1,
      });
      await count({
        date: "2026-09-01",
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 1,
        goodOut: 1,
      });

      const items = await repo.listPeriodProductCount("month", MONTH_REPORT_ID);

      expect(items[0]?.totalOut).toBe(2);
    });

    // A day must NOT reach into the next one.
    it("covers exactly one day at day grain", async () => {
      await insertDayReport();
      await count({
        date: BUSINESS_DATE,
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 7,
        goodOut: 7,
      });
      await count({
        date: "2026-08-02",
        productId: 1,
        uomCode: "BAG",
        factor: 1,
        totalOut: 99,
        goodOut: 99,
      });

      const items = await repo.listPeriodProductCount("day", DAY_REPORT_ID);

      expect(items[0]?.totalOut).toBe(7);
    });
  });

  // FAILURE MODE F3 in the plan. The unit guards fire far more often over 30 days
  // than over 8 hours, and a wrong answer here is a plausible Pareto rather than
  // an error.
  describe("aggregatePeriodRejectReasons", () => {
    async function counter(opts: {
      shiftDate: string;
      shift: number;
      reason: string;
      uomCode: string;
      factor: number;
      counterValue: number;
      frequency?: number;
    }) {
      await db`
        INSERT INTO oee.reject_count_wu_shift (
          work_unit_id, shift_date, shift, product_id, reason,
          work_unit_name, work_unit_code, work_center_id, work_center_name,
          product_name, product_code,
          uom_id, uom_name, uom_code, counter_value,
          base_uom_id, base_uom_name, base_uom_code, factor_to_base,
          weight_gram, frequency, reject_time, time_zone
        ) VALUES (
          ${WORK_UNIT}, ${opts.shiftDate}::date, ${opts.shift}, 1, ${opts.reason},
          'Vertical Packer N', 'VP-N', 1, 'Line 1',
          'SKU A', 'SKU-A',
          1, ${opts.uomCode}, ${opts.uomCode}, ${opts.counterValue},
          1, 'Bag', 'BAG', ${opts.factor},
          NULL, ${opts.frequency ?? 1}, NULL, ${TZ}
        )
      `;
    }

    beforeEach(async () => {
      await db`DELETE FROM oee.reject_count_wu_shift WHERE work_unit_id = ${WORK_UNIT}`;
      await insertDayReport();
    });

    it("sums every shift of the day into one bucket", async () => {
      await counter({
        shiftDate: BUSINESS_DATE,
        shift: 1,
        reason: "Total_NG",
        uomCode: "BAG",
        factor: 1,
        counterValue: 10,
      });
      await counter({
        shiftDate: BUSINESS_DATE,
        shift: 2,
        reason: "Total_NG",
        uomCode: "BAG",
        factor: 1,
        counterValue: 15,
      });
      await counter({
        shiftDate: BUSINESS_DATE,
        shift: 3,
        reason: "Total_NG",
        uomCode: "BAG",
        factor: 1,
        counterValue: 5,
      });

      const agg = await repo.aggregatePeriodRejectReasons("day", DAY_REPORT_ID);

      expect(agg.buckets).toHaveLength(1);
      expect(agg.buckets[0]?.counterValue).toBe(30);
      expect(agg.buckets[0]?.counterUnit).toBe("BAG");
      // The bars must sum to their own denominator — the browser's cumulative
      // line divides by it.
      expect(agg.totalQuantity).toBe(30);
    });

    // THE GUARD DOING ITS JOB. Two units in one bucket cannot be labelled, and
    // the alternative — picking one — puts BAG and CARTON under one heading.
    it("reports a null unit when the window mixed two of them", async () => {
      await counter({
        shiftDate: BUSINESS_DATE,
        shift: 1,
        reason: "Total_NG",
        uomCode: "BAG",
        factor: 1,
        counterValue: 10,
      });
      await counter({
        shiftDate: BUSINESS_DATE,
        shift: 2,
        reason: "Total_NG",
        uomCode: "CARTON",
        factor: 12,
        counterValue: 2,
      });

      const agg = await repo.aggregatePeriodRejectReasons("day", DAY_REPORT_ID);

      expect(agg.buckets[0]?.counterUnit).toBeNull();
      // The CONVERTED total still adds up, because both sides were converted to
      // the base unit first: 10 BAG + 2x12 = 34.
      expect(agg.buckets[0]?.quantity).toBe(34);
      expect(agg.buckets[0]?.convertedUnit).toBe("BAG");
    });

    it("does not reach into the next day", async () => {
      await counter({
        shiftDate: BUSINESS_DATE,
        shift: 1,
        reason: "Total_NG",
        uomCode: "BAG",
        factor: 1,
        counterValue: 7,
      });
      await counter({
        shiftDate: "2026-08-02",
        shift: 1,
        reason: "Total_NG",
        uomCode: "BAG",
        factor: 1,
        counterValue: 99,
      });

      const agg = await repo.aggregatePeriodRejectReasons("day", DAY_REPORT_ID);

      expect(agg.buckets[0]?.counterValue).toBe(7);
    });
  });

  describe("aggregatePeriodDowntimeEventReasons", () => {
    async function event(opts: {
      eventId: string;
      shiftDate: string;
      shift: number;
      reasons: string[];
    }) {
      await db`
        INSERT INTO oee.downtime_log_events (
          event_id, work_unit_id, shift_date, shift, reasons, work_unit_name, time_zone
        ) VALUES (
          ${opts.eventId}, ${WORK_UNIT}, ${opts.shiftDate}::date, ${opts.shift},
          ${opts.reasons}::text[], 'Vertical Packer N', ${TZ}
        )
      `;
    }

    beforeEach(async () => {
      await db`DELETE FROM oee.downtime_log_events WHERE work_unit_id = ${WORK_UNIT}`;
      await insertDayReport();
    });

    it("counts every shift's events and keeps the totals consistent", async () => {
      await event({ eventId: "e1", shiftDate: BUSINESS_DATE, shift: 1, reasons: ["Jam"] });
      await event({ eventId: "e2", shiftDate: BUSINESS_DATE, shift: 3, reasons: ["Jam", "Film"] });

      const agg = await repo.aggregatePeriodDowntimeEventReasons("day", DAY_REPORT_ID);

      const sum = agg.buckets.reduce((t, b) => t + b.frequency, 0);
      // The bars sum to total_occurrences, and total_events is a DIFFERENT,
      // smaller number — swapping them draws a line that walks past 100%.
      expect(sum).toBe(agg.totalOccurrences);
      expect(agg.totalOccurrences).toBe(3);
      expect(agg.totalEvents).toBe(2);
    });

    // The DISTINCT does more work over a window than over a shift: it has to
    // deduplicate within an event no matter how many days the window spans.
    it("counts a reason repeated inside one event once", async () => {
      await event({ eventId: "e1", shiftDate: BUSINESS_DATE, shift: 1, reasons: ["Jam", "Jam"] });

      const agg = await repo.aggregatePeriodDowntimeEventReasons("day", DAY_REPORT_ID);

      expect(agg.buckets).toHaveLength(1);
      expect(agg.buckets[0]?.frequency).toBe(1);
    });

    // An event with no reasons is ONE unattributed bucket AND ONE event. An
    // inner join makes it neither, the bars still sum to their own total, and
    // only the sentence beside the chart is wrong.
    it("keeps an unattributed event as a bucket and as an event", async () => {
      await event({ eventId: "e1", shiftDate: BUSINESS_DATE, shift: 1, reasons: [] });

      const agg = await repo.aggregatePeriodDowntimeEventReasons("day", DAY_REPORT_ID);

      expect(agg.buckets).toHaveLength(1);
      expect(agg.buckets[0]?.reason).toBeNull();
      expect(agg.totalEvents).toBe(1);
    });
  });

  // THE MONTH PROFILE'S ARITHMETIC. §23 called this out and the schema solved
  // half of it with `ideal_out`; the other half is the denominator, and getting
  // it wrong understates the target — which SHRINKS performance loss, the
  // flattering direction, on a chart that reads perfectly.
  describe("listPerfHourProfile", () => {
    async function hour(opts: {
      businessDate: string;
      shift: number;
      hourOfDay: number;
      productId?: number;
      totalOut: number;
      runtimeMs: number;
      idealRate: number | null;
    }) {
      // bucket_start must be a distinct instant per row — it is in the primary
      // key — so it is derived from the business date and the clock hour.
      const start = `${opts.businessDate}T${String(opts.hourOfDay).padStart(2, "0")}:00:00Z`;
      const end = `${opts.businessDate}T${String(opts.hourOfDay).padStart(2, "0")}:59:59Z`;
      await db`
        INSERT INTO oee.product_perf_wu_hour (
          bucket_start, bucket_end, work_unit_id, product_id,
          business_date, shift, hour_of_day, shift_hour_seq, time_zone,
          work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
          product_name, product_code,
          uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
          total_out, good_out, effective_out, reject, rework, runtime, ideal_rate_per_hour
        ) VALUES (
          ${start}::timestamptz, ${end}::timestamptz, ${WORK_UNIT}, ${opts.productId ?? 1},
          ${opts.businessDate}::date, ${opts.shift}, ${opts.hourOfDay}, 0, ${TZ},
          'Vertical Packer N', 'VP-N', 1, 'Line 1', 'L1',
          ${"SKU " + String(opts.productId ?? 1)}, ${"SKU-" + String(opts.productId ?? 1)},
          1, 'Bag', 'BAG', 1, 'Bag', 'BAG', 1,
          ${opts.totalOut}, ${opts.totalOut}, ${opts.totalOut}, 0, 0,
          ${opts.runtimeMs}, ${opts.idealRate}
        )
      `;
    }

    beforeEach(async () => {
      await db`DELETE FROM oee.product_perf_wu_hour WHERE work_unit_id = ${WORK_UNIT}`;
    });

    const profile = () =>
      repo.listPerfHourProfile({
        workUnitId: WORK_UNIT,
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
        dayStartHour: 7,
      });

    it("collapses every occurrence of one clock hour into a single bucket", async () => {
      await hour({
        businessDate: "2026-08-01",
        shift: 1,
        hourOfDay: 9,
        totalOut: 100,
        runtimeMs: 3_600_000,
        idealRate: 120,
      });
      await hour({
        businessDate: "2026-08-02",
        shift: 1,
        hourOfDay: 9,
        totalOut: 140,
        runtimeMs: 3_600_000,
        idealRate: 120,
      });
      await hour({
        businessDate: "2026-08-03",
        shift: 1,
        hourOfDay: 9,
        totalOut: 60,
        runtimeMs: 3_600_000,
        idealRate: 120,
      });

      const rows = await profile();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.hourOfDay).toBe(9);
      expect(rows[0]?.totalOut).toBe(300);
      expect(rows[0]?.runtime).toBe(10_800_000);
      // Every hour carried the same standard, so the weighted mean is that
      // standard — and NOT the sum of three of them.
      expect(rows[0]?.idealRatePerHour).toBe(120);
    });

    // THE ONE THAT MATTERS. Two hours ran, one had a standard of 120 and one had
    // none. Dividing sum(ideal_out) by the WHOLE runtime gives 60 — half the real
    // standard, so the target halves and the performance loss vanishes.
    it("weights the standard by the runtime that HAD one, not by all runtime", async () => {
      await hour({
        businessDate: "2026-08-01",
        shift: 1,
        hourOfDay: 9,
        totalOut: 100,
        runtimeMs: 3_600_000,
        idealRate: 120,
      });
      await hour({
        businessDate: "2026-08-02",
        shift: 1,
        hourOfDay: 9,
        totalOut: 100,
        runtimeMs: 3_600_000,
        idealRate: null,
      });

      const rows = await profile();

      expect(rows[0]?.idealRatePerHour).toBe(120);
      // The output still counts both hours — an unknown standard must not drop
      // production that genuinely happened.
      expect(rows[0]?.totalOut).toBe(200);
    });

    // A runtime-weighted mean, not an arithmetic one: an hour that ran 15 minutes
    // at 200/h must not count as much as an hour that ran a full 60 at 100/h.
    it("weights by runtime rather than averaging the rates", async () => {
      await hour({
        businessDate: "2026-08-01",
        shift: 1,
        hourOfDay: 9,
        totalOut: 100,
        runtimeMs: 3_600_000,
        idealRate: 100,
      });
      await hour({
        businessDate: "2026-08-02",
        shift: 1,
        hourOfDay: 9,
        totalOut: 50,
        runtimeMs: 900_000,
        idealRate: 200,
      });

      const rows = await profile();

      // (100 x 1h + 200 x 0.25h) / 1.25h = 120. The arithmetic mean is 150.
      expect(rows[0]?.idealRatePerHour).toBe(120);
    });

    it("reports a null standard when the month never knew one", async () => {
      await hour({
        businessDate: "2026-08-01",
        shift: 1,
        hourOfDay: 9,
        totalOut: 100,
        runtimeMs: 3_600_000,
        idealRate: null,
      });

      const rows = await profile();

      expect(rows[0]?.idealRatePerHour).toBeNull();
      expect(rows[0]?.totalOut).toBe(100);
    });

    // BUSINESS-DAY ORDER, not clock order. 07:00 first, 06:00 last — otherwise
    // the night shift splits across both ends of the chart.
    it("orders the hours from the business day's start", async () => {
      for (const h of [23, 6, 7, 15, 0]) {
        await hour({
          businessDate: "2026-08-01",
          shift: 1,
          hourOfDay: h,
          totalOut: 1,
          runtimeMs: 3_600_000,
          idealRate: 10,
        });
      }

      const rows = await profile();

      expect(rows.map((r) => r.hourOfDay)).toEqual([7, 15, 23, 0, 6]);
    });

    it("keeps products in separate buckets", async () => {
      await hour({
        businessDate: "2026-08-01",
        shift: 1,
        hourOfDay: 9,
        productId: 1,
        totalOut: 10,
        runtimeMs: 3_600_000,
        idealRate: 10,
      });
      await hour({
        businessDate: "2026-08-01",
        shift: 1,
        hourOfDay: 9,
        productId: 2,
        totalOut: 20,
        runtimeMs: 3_600_000,
        idealRate: 20,
      });

      const rows = await profile();

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.productId).sort((a, b) => a - b)).toEqual([1, 2]);
    });

    it("excludes business days outside the month", async () => {
      await hour({
        businessDate: "2026-08-31",
        shift: 1,
        hourOfDay: 9,
        totalOut: 5,
        runtimeMs: 3_600_000,
        idealRate: 10,
      });
      await hour({
        businessDate: "2026-09-01",
        shift: 1,
        hourOfDay: 9,
        totalOut: 99,
        runtimeMs: 3_600_000,
        idealRate: 10,
      });

      const rows = await profile();

      expect(rows[0]?.totalOut).toBe(5);
    });
  });

  // The day and month Log Activity feed. What makes this worth a container is the
  // WINDOW: the events table is keyed (work_unit_id, date, shift), so a day's feed
  // is three keys and a bound on `date` is the only thing that gathers them.
  describe("listApprovalTransitionsInWindow", () => {
    async function transition(shiftIndex: number, from: string, to: string) {
      await db`
        INSERT INTO oee.work_unit_shift_report_approval_events
          (work_unit_id, date, shift, at, by_subject, by_name, from_status, to_status, source)
        VALUES (${WORK_UNIT}, ${SHIFT_STARTS[shiftIndex - 1]!}::timestamptz, ${shiftIndex},
                now(), 'sub-1', 'Operator One', ${from}, ${to}, 'operator')
      `;
    }

    const window = {
      workUnitId: WORK_UNIT,
      from: new Date(DAY_START),
      to: new Date("2026-08-02T00:00:00Z"),
    };

    beforeEach(async () => {
      await db`DELETE FROM oee.work_unit_shift_report_approval_events WHERE work_unit_id = ${WORK_UNIT}`;
    });

    it("gathers the transitions of every shift in the window", async () => {
      await transition(1, "open", "closed");
      await transition(2, "open", "closed");
      await transition(3, "open", "closed");

      const rows = await repo.listApprovalTransitionsInWindow(window);

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.shift).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    // THE FIELD THE SHIFT-GRAIN SIBLING DOES NOT RETURN. Without it three rows in
    // a day's feed are indistinguishable from three approvals of one report.
    it("labels every row with the shift it belongs to", async () => {
      await transition(2, "open", "closed");

      const rows = await repo.listApprovalTransitionsInWindow(window);

      expect(rows[0]?.shift).toBe(2);
      expect(rows[0]?.fromStatus).toBe("open");
      expect(rows[0]?.toStatus).toBe("closed");
    });

    // A reopen-then-reapprove is three rows against one report, and all three
    // belong in the feed — that is what reading the EVENT LOG rather than the
    // current-state row buys.
    it("keeps every transition of one shift, not just the latest", async () => {
      await transition(1, "open", "closed");
      await transition(1, "closed", "open");
      await transition(1, "open", "closed");

      const rows = await repo.listApprovalTransitionsInWindow(window);

      expect(rows).toHaveLength(3);
    });

    // The half-open upper bound, at the instant it matters: shift 1 starts at
    // exactly the previous day's window end, so its transition belongs to one day
    // and not both.
    it("excludes a transition whose shift starts at the window's end", async () => {
      await transition(1, "open", "closed");

      const previousDay = await repo.listApprovalTransitionsInWindow({
        workUnitId: WORK_UNIT,
        from: new Date("2026-07-31T00:00:00Z"),
        to: new Date(DAY_START),
      });

      expect(previousDay).toHaveLength(0);
    });

    it("returns nothing for a machine with no transitions", async () => {
      const rows = await repo.listApprovalTransitionsInWindow({ ...window, workUnitId: 999_999 });

      expect(rows).toHaveLength(0);
    });
  });

  describe("getPeriodReportScope", () => {
    it("reads the window inputs straight off the row, with no zone resolution", async () => {
      await insertDayReport();

      const scope = await repo.getPeriodReportScope("day", DAY_REPORT_ID);

      expect(scope).toEqual({
        workUnitId: WORK_UNIT,
        workCenterId: 1,
        businessDate: BUSINESS_DATE,
        timeZone: TZ,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The OEE Performance dashboard's daily trend — shared/oee-trend.ts
// ---------------------------------------------------------------------------
//
// SIXTH ENTRY IN THE LIST AT THE TOP OF THIS FILE, and the same kind of failure:
// every way this query goes wrong, it goes wrong as a chart that looks fine.
//
//   * A `BETWEEN` instead of the half-open `< first + 1 month` pulls the FIRST DAY
//     OF THE NEXT MONTH onto the right-hand edge of the curve. One extra point, at
//     the end, where a reader is least likely to count.
//   * Dropping a zero-OEE day instead of returning it closes the line over a day
//     the machine produced nothing — the curve then reads as uninterrupted good
//     running, which is the opposite of the truth and is FLATTERING, so nobody
//     reports it.
//   * Scoping on the wrong work unit returns somebody else's month at full
//     plausibility.
//
// THE CALENDAR-TIME IDENTITY IS ALSO PINNED HERE, and it is not this query's. It
// is the arithmetic the whole OEE Performance summary rests on:
//
//     availability_time == schedule_loss + availability_loss + performance_loss
//                        + quality_loss + value_added_time
//
// The browser divides by that to render Utility and never checks it. If a future
// pipeline model breaks the identity, every Utility figure on the dashboard is
// quietly wrong and nothing throws — so the assertion lives against real rows
// rather than against a fixture that can only prove itself self-consistent.
describe.skipIf(!url)("WorkUnitReportReaderRepository.listMonthOeeTrend — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new WorkUnitReportReaderRepository({ goldDb: db });

  // Its own sentinels, so this block cannot collide with the fixtures above.
  const TREND_WORK_UNIT = 7374;
  const TREND_MONTH_ID = 737_420;
  const TREND_DAY_BASE = 737_430;

  async function truncate() {
    await db`DELETE FROM oee.work_unit_day_reports WHERE work_unit_id IN (${TREND_WORK_UNIT}, ${TREND_WORK_UNIT + 1})`;
    await db`DELETE FROM oee.work_unit_month_reports WHERE work_unit_id IN (${TREND_WORK_UNIT}, ${TREND_WORK_UNIT + 1})`;
  }

  // A month row whose measures satisfy the calendar-time identity above, so the
  // identity assertion is testing the READ rather than a hand-tuned row.
  const PDT = 24_600_000;
  const UPDT = 46_560_000;
  const MS = 3_300_000;
  const RS = 7_740_000;
  const REJECT_TIME = 1_360_000;
  const REWORK_TIME = 280_000;
  const VALUE_ADDED = 434_560_000;
  const CALENDAR = PDT + UPDT + MS + RS + REJECT_TIME + REWORK_TIME + VALUE_ADDED;

  async function insertMonth(id: number, workUnitId: number, businessDate: string) {
    await db`
      INSERT INTO oee.work_unit_month_reports (
        id, month, date, business_date, time_zone, work_unit_id, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time, reject, rework
      ) VALUES (
        ${id}, '2026-08', ${`${businessDate}T00:00:00Z`}::timestamptz,
        ${businessDate}::date, ${TZ}, ${workUnitId}, 1,
        83.827, 88.003, 90.571, 97.532, 99.624,
        1000, 990, 990,
        ${CALENDAR - PDT - UPDT}, ${CALENDAR}, ${CALENDAR - PDT},
        ${PDT}, ${CALENDAR - PDT - UPDT},
        ${UPDT}, ${CALENDAR - PDT - UPDT - MS - RS}, ${RS}, ${MS}, ${VALUE_ADDED},
        ${REWORK_TIME}, ${REJECT_TIME}, 0, 0,
        ${PDT}, ${UPDT}, ${MS + RS},
        ${MS}, ${RS}, ${REJECT_TIME + REWORK_TIME}, 12.5, 3.25
      )
    `;
  }

  async function insertDay(id: number, workUnitId: number, businessDate: string, oee: number) {
    await db`
      INSERT INTO oee.work_unit_day_reports (
        id, date, business_date, time_zone, work_unit_id, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time, reject, rework
      ) VALUES (
        ${id}, ${`${businessDate}T00:00:00Z`}::timestamptz, ${businessDate}::date, ${TZ},
        ${workUnitId}, 1,
        70.5, ${oee}, 90.125, 95, 99,
        1000, 990, 990,
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0
      )
    `;
  }

  afterAll(async () => {
    await truncate();
    await db.end();
  });

  beforeEach(async () => {
    await truncate();
    await insertMonth(TREND_MONTH_ID, TREND_WORK_UNIT, "2026-08-01");
  });

  // The three rates beside `oee` are fixed by insertDay, so a point is fully
  // determined by its date and its OEE.
  const point = (businessDate: string, oee: number | null) => ({
    businessDate,
    oee,
    availability: 90.125,
    performance: 95,
    quality: 99,
  });

  it("returns one point per day, ascending, as bare business days", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-08-03", 91.5);
    await insertDay(TREND_DAY_BASE + 1, TREND_WORK_UNIT, "2026-08-01", 88.25);

    await expect(repo.listMonthOeeTrend(TREND_MONTH_ID)).resolves.toEqual([
      point("2026-08-01", 88.25),
      point("2026-08-03", 91.5),
    ]);
  });

  // ALL FOUR RATES REACH THE CALLER. The chart draws them on one axis, so a
  // projection that dropped one would render a missing line rather than throw.
  it("returns availability, performance and quality beside oee", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-08-01", 88.25);

    const [row] = await repo.listMonthOeeTrend(TREND_MONTH_ID);

    expect(row).toEqual(point("2026-08-01", 88.25));
  });

  // The rows are returned as inserted, gaps and all. Nothing interpolates a
  // missing day, because a day with no row is not a day with no production — it
  // is a day the pipeline has not written, and the browser draws the difference.
  it("leaves a missing day as a hole rather than filling it", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-08-01", 88.25);
    await insertDay(TREND_DAY_BASE + 1, TREND_WORK_UNIT, "2026-08-04", 91.5);

    const points = await repo.listMonthOeeTrend(TREND_MONTH_ID);

    expect(points.map((p) => p.businessDate)).toEqual(["2026-08-01", "2026-08-04"]);
  });

  // ZERO IS A MEASUREMENT and must survive the read. The browser renders it as a
  // gap so the curve does not dive to the axis, but that is a drawing decision the
  // browser owns — an endpoint that dropped the row would make the two cases
  // indistinguishable to every future consumer, including a BI tool pointed at
  // this schema (contract §23.3).
  it("returns a zero-OEE day rather than omitting it", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-08-01", 0);

    await expect(repo.listMonthOeeTrend(TREND_MONTH_ID)).resolves.toEqual([point("2026-08-01", 0)]);
  });

  // THE BOUNDARY. A `BETWEEN` or a `<=` puts 2026-09-01 on the end of an August
  // curve, and the chart still looks like a chart.
  it("excludes the first day of the NEXT month", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-08-31", 80);
    await insertDay(TREND_DAY_BASE + 1, TREND_WORK_UNIT, "2026-09-01", 99);

    const points = await repo.listMonthOeeTrend(TREND_MONTH_ID);

    expect(points.map((p) => p.businessDate)).toEqual(["2026-08-31"]);
  });

  // ...and the left edge, which the half-open rule includes.
  it("includes the first day of the month and excludes the one before it", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-07-31", 99);
    await insertDay(TREND_DAY_BASE + 1, TREND_WORK_UNIT, "2026-08-01", 80);

    const points = await repo.listMonthOeeTrend(TREND_MONTH_ID);

    expect(points.map((p) => p.businessDate)).toEqual(["2026-08-01"]);
  });

  // Another machine's days must not reach this curve. The join is on the report
  // row's own work_unit_id, so this is the assertion that the scope column was
  // wired to the right subject.
  it("never returns another work unit's days", async () => {
    await insertDay(TREND_DAY_BASE, TREND_WORK_UNIT, "2026-08-01", 80);
    await insertDay(TREND_DAY_BASE + 1, TREND_WORK_UNIT + 1, "2026-08-02", 99);

    await expect(repo.listMonthOeeTrend(TREND_MONTH_ID)).resolves.toEqual([
      point("2026-08-01", 80),
    ]);
  });

  it("answers an unknown report with an empty series rather than throwing", async () => {
    await expect(repo.listMonthOeeTrend(999_999)).resolves.toEqual([]);
  });

  // THE CALENDAR-TIME IDENTITY, read back through the real projection.
  it("reads a month row whose losses and value-added time sum to availability_time", async () => {
    const report = await repo.getPeriodReport("month", TREND_MONTH_ID);

    expect(report).toBeDefined();
    const sum =
      report!.scheduleLossTime +
      report!.availabilityLossTime +
      report!.performanceLossTime +
      report!.qualityLossTime +
      report!.valueAddedTime;

    // Calendar Time. The OEE Performance summary divides production_time by this
    // to render Utility, and TEEP x (1/Utility) must equal OEE — see the dashboard's
    // lib/oee-performance.ts, which asserts the same identity over its fixtures.
    expect(sum).toBe(report!.availabilityTime);
    expect(report!.availabilityTime).toBe(CALENDAR);

    // Loading Time is availability_time less the planned stop, and is OEE's
    // denominator. Utility is the ratio of the two.
    expect(report!.productionTime).toBe(CALENDAR - PDT);
  });
});
