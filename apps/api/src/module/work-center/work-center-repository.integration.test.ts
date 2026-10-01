// Integration coverage for the LINE grain, against a REAL Postgres.
//
// WHY A CONTAINER, WHEN A fakeSql SUITE ALREADY ASSERTS THE SQL TEXT
//
// Everything this grain gets wrong, it gets wrong QUIETLY:
//
//   1. A line's DAY is the sum of its own line-SHIFTS. (NOT the sum of its
//      machines — a line is measured at its own count points and
//      `line <> sum(machines)`; see migration 0014's header. The fixture below
//      still builds line rows by summing machines, because there is nothing else
//      to build them from in a test, but that hop is a STAND-IN and is asserted
//      as such rather than as a contract invariant.)
//   2. The rates are RECOMPUTED, never averaged. avg() over machines is wrong in
//      the flattering direction and no type or regex can see the difference.
//   3. The unit is nullable and so are the five counts, TOGETHER. A row with a
//      count and no unit is `500 BAG + 12 CARTON = 512 <blank>` on screen;
//      ck_wcsr_infeed_units is the only thing that stops it, and a CHECK is exactly the
//      kind of guard that is decorative until something proves it fires.
//   4. `oee <> 0` is THREE-VALUED because oee is nullable. isHideZero therefore
//      hides NULL-OEE rows as well as zero ones. That is intended, and it is one
//      "fix" away from silently changing.
//   5. The business-date filter must be exact at a month boundary. The work_unit
//      SHIFT list's equivalent compares a timestamptz and misattributes both ends
//      (TODOS §17); this grain has no timestamptz, and only a real boundary can
//      show that the difference is real.
//   6. Paging must be STABLE when business_date ties. Without the id tiebreak a
//      row appears on two pages and another on none — which no test asserting
//      "rows came back" would catch.
//
// THE FIXTURE IS TWO MACHINES ON ONE LINE, which is the only shape under which
// the derived numbers differ from a single machine's at all — and therefore the
// only one that can show a recomputed rate parting company with an averaged one.
// It also carries the docs/gold-write-contract.md §16.8 cross-check the pipeline
// IS asked to assert: a line's day equals the sum of its own line-shifts.
//
//   docker run --rm -d --name oee-itest-pg18 -p 55434:5432 \
//     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gold_test postgres:18-alpine
//   GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api run db:migrate
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api exec vp test work-center-repository.integration
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "../../shared/database/postgres.js";
import {
  WorkCenterReportReaderRepository,
  WorkCenterReportWriterRepository,
} from "./work-center-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

const TZ = "Asia/Jakarta";
// Sentinel ids well clear of every seed's range, so a developer's populated dev
// database cannot collide with the fixture.
const LINE = 9101;
const OTHER_LINE = 9102;
const MACHINE_A = 9201;
const MACHINE_B = 9202;

// Two machines that differ SHARPLY in how much they ran. That gap is what makes
// the recomputed rate diverge from the naive average by an amount an assertion
// can see; two similar machines would agree to three decimals and prove nothing.
//
//   machine A  production 8h, operating 8h   -> availability 100%
//   machine B  production 8h, operating 2h   -> availability  25%
//
//   naive average        -> 62.5%
//   recomputed (correct) -> (8 + 2) / (8 + 8) = 62.5%   <- identical here, so
//   ... which is why the OEE case below uses value_added/production instead,
//   where the two genuinely part company.
const H = 3_600_000;

type MachineRow = {
  workUnitId: number;
  workCenterId?: number;
  businessDate: string;
  shift: number;
  // NOT optional and NOT nullable, because oee.work_unit_shift_reports declares
  // uom_id NOT NULL. A MACHINE always has a unit; only a LINE can abstain. That is
  // why the NULL-skipping trap below is tested on the second hop and cannot be
  // reproduced on the first.
  uomId: number;
  uomCode: string;
  productionTime: number;
  operatingTime: number;
  valueAddedTime: number;
  totalOut?: number;
};

describe.skipIf(!url)("WorkCenterReportReaderRepository (integration)", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo = new WorkCenterReportReaderRepository({ goldDb: db });
  const writer = new WorkCenterReportWriterRepository({ goldDb: db });

  async function cleanup() {
    await db`DELETE FROM oee.work_center_shift_reports WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.work_center_day_reports WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.work_center_month_reports WHERE work_center_id IN (${LINE}, ${OTHER_LINE})`;
    await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id IN (${MACHINE_A}, ${MACHINE_B})`;
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id IN (${MACHINE_A}, ${MACHINE_B})`;
    await db`DELETE FROM oee.work_unit_shift_report_approval_events WHERE work_unit_id IN (${MACHINE_A}, ${MACHINE_B})`;
  }

  // Inserts a MACHINE row. The line rows under test are then DERIVED from these
  // by rollUp() below, which is the same arithmetic
  // apps/api/scripts/seed/0015_work_center_reports_dev.sql performs — so this
  // suite tests the specification, not a hand-written copy of its output.
  async function machine(r: MachineRow) {
    const availability = r.productionTime; // no planned downtime in this fixture
    await db`
      INSERT INTO oee.work_unit_shift_reports (
        shift, date, business_date, time_zone,
        work_unit_id, work_unit_name, work_unit_code,
        work_center_id, work_center_name, work_center_code,
        uom_id, uom_name, uom_code,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework, mttr, mtbf
      ) VALUES (
        ${r.shift},
        ${`${r.businessDate}T00:00:00Z`}::timestamptz, ${r.businessDate}::date, ${TZ},
        ${r.workUnitId}, ${"M" + r.workUnitId}, ${"M" + r.workUnitId},
        ${r.workCenterId ?? LINE}, 'Molca Line 1', 'L1',
        ${r.uomId}, 'Bag', ${r.uomCode},
        0, 0, 0, 0, 0,
        ${r.totalOut ?? 0}, 0, 0,
        ${r.operatingTime}, ${availability}, ${r.productionTime}, 0, ${r.operatingTime},
        ${r.productionTime - r.operatingTime}, ${r.valueAddedTime}, 0, 0, ${r.valueAddedTime},
        0, 0, 0, 0,
        0, ${r.productionTime - r.operatingTime}, 0,
        0, 0, 0,
        0, 0, 0, 0
      )
    `;
  }

  // The roll-up from migration 0015's seed, verbatim in shape: durations SUM, the
  // rates are RECOMPUTED from those sums, and the unit gate has both halves.
  async function rollUp() {
    await db`
      INSERT INTO oee.work_center_shift_reports (
        work_center_id, business_date, shift, time_zone,
        work_center_name, work_center_code, work_unit_count,
        infeed_uom_id, infeed_uom_name, infeed_uom_code,
        output_uom_id, output_uom_name, output_uom_code,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out, reject, rework,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      )
      SELECT
        r.work_center_id, r.business_date, r.shift, min(r.time_zone),
        min(r.work_center_name), min(r.work_center_code), count(*)::int,
        CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
             THEN min(r.uom_id) END,
        CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
             THEN min(r.uom_name) END,
        CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
             THEN min(r.uom_code) END,
        -- output_uom_* stays NULL: which machine is the line's OUTFEED lives in
        -- ms_code.count_points, which this fixture cannot read. good_out and
        -- effective_out are NULL with it, which satisfies ck_*_output_units.
        NULL::integer, NULL::varchar, NULL::varchar,
        round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
        round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
        round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
        round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
        round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),
        CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
             THEN sum(r.total_out) END,
        NULL::numeric, NULL::numeric,
        CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
             THEN sum(r.reject) END,
        CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
             THEN sum(r.rework) END,
        sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
        sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
        sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
        sum(r.anomaly_time), sum(r.up_speed_time),
        sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
        sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time)
      FROM oee.work_unit_shift_reports r
      WHERE r.work_unit_id IN (${MACHINE_A}, ${MACHINE_B})
      GROUP BY r.work_center_id, r.business_date, r.shift
    `;
  }

  // The SECOND hop, from the line's shift rows to its day row. Two things differ
  // from rollUp() and both are in the seed for the same reasons: work_unit_count
  // is max() rather than sum(), and this is where the NULL-skipping gate earns its
  // second half.
  async function rollUpDay() {
    await db`
      INSERT INTO oee.work_center_day_reports (
        work_center_id, business_date, time_zone,
        work_center_name, work_center_code, work_unit_count,
        infeed_uom_id, infeed_uom_name, infeed_uom_code,
        output_uom_id, output_uom_name, output_uom_code,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out, reject, rework,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time
      )
      SELECT
        r.work_center_id, r.business_date, min(r.time_zone),
        min(r.work_center_name), min(r.work_center_code), max(r.work_unit_count)::int,
        CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
             THEN min(r.infeed_uom_id) END,
        CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
             THEN min(r.infeed_uom_name) END,
        CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
             THEN min(r.infeed_uom_code) END,
        -- output_uom_* stays NULL: which machine is the line's OUTFEED lives in
        -- ms_code.count_points, which this fixture cannot read. good_out and
        -- effective_out are NULL with it, which satisfies ck_*_output_units.
        NULL::integer, NULL::varchar, NULL::varchar,
        round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
        round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
        round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
        round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
        round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),
        CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
             THEN sum(r.total_out) END,
        NULL::numeric, NULL::numeric,
        CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
             THEN sum(r.reject) END,
        CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
             THEN sum(r.rework) END,
        sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
        sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
        sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
        sum(r.anomaly_time), sum(r.up_speed_time),
        sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
        sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time)
      FROM oee.work_center_shift_reports r
      WHERE r.work_center_id IN (${LINE}, ${OTHER_LINE})
      GROUP BY r.work_center_id, r.business_date
    `;
  }

  beforeEach(cleanup);

  describe("the roll-up arithmetic", () => {
    // A SELF-CHECK OF THE FIXTURE'S STAND-IN HOP, NOT A GOLD INVARIANT.
    //
    // The real pipeline measures a line at its own count points, so its line rows
    // will NOT equal the sum of the machines' — §16.8 deliberately no longer asks
    // for that, and an earlier version of this suite asserting it would have been
    // asserting something false about production. What this proves is narrower and
    // still worth having: rollUp() sums what it claims to, so the rate assertions
    // below are computed over the inputs they say they are.
    it("the fixture's stand-in hop sums the machines it claims to", async () => {
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await machine({
        workUnitId: MACHINE_B,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        productionTime: 8 * H,
        operatingTime: 2 * H,
        valueAddedTime: 1 * H,
      });
      await rollUp();

      const [line] = await db<
        { productionTime: string; operatingTime: string; workUnitCount: number }[]
      >`
        SELECT production_time, operating_time, work_unit_count
          FROM oee.work_center_shift_reports WHERE work_center_id = ${LINE}
      `;

      // 16 machine-hours across an 8h shift — which is exactly the artefact of
      // summing, and exactly what a real line row would NOT carry.
      expect(Number(line?.productionTime)).toBe(16 * H);
      expect(Number(line?.operatingTime)).toBe(10 * H);
      expect(line?.workUnitCount).toBe(2);
    });

    // THE HIGHEST-VALUE ASSERTION IN THIS FILE. avg() over machines is wrong in
    // the flattering direction and produces a number of exactly the right shape.
    it("recomputes the rates from the sums rather than averaging them", async () => {
      // A: value_added 6h of 8h production -> oee 75%
      // B: value_added 1h of 8h production -> oee 12.5%
      //   naive average          -> 43.75%
      //   recomputed (correct)   -> (6 + 1) / (8 + 8) = 43.75%  ... equal, so use
      // machines of DIFFERENT SIZE, which is the case avg() actually breaks on:
      // A: 6h of 8h; B: 1h of 2h (50%). avg = 62.5%, recomputed = 7/10 = 70%.
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await machine({
        workUnitId: MACHINE_B,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        productionTime: 2 * H,
        operatingTime: 2 * H,
        valueAddedTime: 1 * H,
      });
      await rollUp();

      const [line] = await db<{ oee: string }[]>`
        SELECT oee FROM oee.work_center_shift_reports WHERE work_center_id = ${LINE}
      `;

      // (6 + 1) / (8 + 2) = 70%. The naive average of 75% and 50% is 62.5%.
      expect(Number(line?.oee)).toBeCloseTo(70, 3);
      expect(Number(line?.oee)).not.toBeCloseTo(62.5, 1);
    });

    // 500 BAG + 12 CARTON = 512 <blank>. The unit AND the figure go, not just the
    // label — the same treatment the reject aggregation already gives a mixed
    // bucket. Durations are unaffected: time is time.
    it("nulls the unit AND the counts when the machines disagree, but still sums the time", async () => {
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        totalOut: 500,
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await machine({
        workUnitId: MACHINE_B,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 2,
        uomCode: "CARTON",
        totalOut: 12,
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await rollUp();

      const [line] = await db<
        { infeedUomId: number | null; totalOut: string | null; productionTime: string }[]
      >`
        SELECT infeed_uom_id, total_out, production_time
          FROM oee.work_center_shift_reports WHERE work_center_id = ${LINE}
      `;

      expect(line?.infeedUomId).toBeNull();
      expect(line?.totalOut).toBeNull();
      expect(Number(line?.productionTime)).toBe(16 * H);
    });

    // A line whose machines AGREE keeps its unit and its summed counts.
    it("keeps the unit and sums the counts when the machines agree", async () => {
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        totalOut: 500,
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await machine({
        workUnitId: MACHINE_B,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        totalOut: 300,
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await rollUp();

      const [line] = await db<{ infeedUomId: number; totalOut: string }[]>`
        SELECT infeed_uom_id, total_out FROM oee.work_center_shift_reports WHERE work_center_id = ${LINE}
      `;

      expect(line?.infeedUomId).toBe(1);
      expect(Number(line?.totalOut)).toBe(800);
    });

    // THE NULL-SKIPPING TRAP, ON THE HOP WHERE IT ACTUALLY LIVES.
    //
    // It CANNOT be reproduced on the first hop: oee.work_unit_shift_reports
    // declares uom_id NOT NULL, so every machine has a unit and the members can
    // only ever disagree, never abstain. The second hop is different — a line's
    // SHIFT row is allowed to be NULL-unit (that is what a mixed shift produces),
    // and a day rolling those up meets exactly the case count(DISTINCT) cannot
    // see.
    //
    // Without `count(uom_id) = count(*)`, this day reads as agreeing on BAG and
    // sums only shifts 2 and 3 — under-reporting its output by a whole shift,
    // under a confident label, with nothing failing anywhere.
    it("a day abstains when ONE of its line-shifts was mixed-unit", async () => {
      // shift 1 mixed -> the line shift row gets uom NULL and total_out NULL
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        totalOut: 500,
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await machine({
        workUnitId: MACHINE_B,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 2,
        uomCode: "CARTON",
        totalOut: 12,
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      // shifts 2 and 3 agree on BAG
      for (const shift of [2, 3]) {
        await machine({
          workUnitId: MACHINE_A,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          totalOut: 500,
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
        await machine({
          workUnitId: MACHINE_B,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          totalOut: 300,
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
      }
      await rollUp();
      await rollUpDay();

      const [day] = await db<
        { infeedUomId: number | null; totalOut: string | null; productionTime: string }[]
      >`
        SELECT infeed_uom_id, total_out, production_time
          FROM oee.work_center_day_reports WHERE work_center_id = ${LINE}
      `;

      expect(day?.infeedUomId).toBeNull();
      // NOT 1600 (shifts 2 + 3 alone). That is the number the missing half of the
      // gate produces, and it looks entirely plausible.
      expect(day?.totalOut).toBeNull();
      // The durations are unaffected: six machine-shifts of 8h.
      expect(Number(day?.productionTime)).toBe(48 * H);
    });

    // The same day, with every shift agreeing, keeps its unit and sums the counts.
    it("a day keeps the unit when all of its line-shifts agree", async () => {
      for (const shift of [1, 2, 3]) {
        await machine({
          workUnitId: MACHINE_A,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          totalOut: 500,
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
        await machine({
          workUnitId: MACHINE_B,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          totalOut: 300,
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
      }
      await rollUp();
      await rollUpDay();

      const [day] = await db<{ infeedUomId: number; totalOut: string; workUnitCount: number }[]>`
        SELECT infeed_uom_id, total_out, work_unit_count
          FROM oee.work_center_day_reports WHERE work_center_id = ${LINE}
      `;

      expect(day?.infeedUomId).toBe(1);
      expect(Number(day?.totalOut)).toBe(2400);
      // MAX over the day's shifts, NOT the sum: a two-machine line does not become
      // a six-machine one because it ran three shifts.
      expect(day?.workUnitCount).toBe(2);
    });
  });

  describe("the constraints actually fire", () => {
    async function insertLine(overrides: string) {
      return await db.unsafe(`
        INSERT INTO oee.work_center_shift_reports (
          work_center_id, business_date, shift, time_zone, work_center_name, work_unit_count,
          runtime, availability_time, production_time, pdt_time, operating_time, updt_time,
          net_time, reduce_speed_time, ms_time, value_added_time, rework_time, reject_time,
          anomaly_time, up_speed_time, schedule_loss_time, availability_loss_time,
          performance_loss_time, ms_loss_time, reduce_speed_loss_time, quality_loss_time
          ${overrides ? "," + overrides.split("=")[0] : ""}
        ) VALUES (
          ${LINE}, '2026-08-01', 1, '${TZ}', 'Molca Line 1', 2,
          0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
          ${overrides ? "," + overrides.split("=")[1] : ""}
        )`);
    }

    // A count with no unit renders as a wrong number with a missing label. This
    // CHECK is the only thing that stops the pipeline writing one, and a CHECK is
    // decorative until something proves it fires.
    it("ck_wcsr_infeed_units rejects a count written without a unit", async () => {
      await expect(insertLine("total_out=500")).rejects.toThrow(/ck_wcsr_infeed_units/);
    });

    it("ck_wcsr_shift rejects a shift outside 1-3", async () => {
      await expect(
        db`INSERT INTO oee.work_center_shift_reports (
             work_center_id, business_date, shift, time_zone, work_center_name, work_unit_count,
             runtime, availability_time, production_time, pdt_time, operating_time, updt_time,
             net_time, reduce_speed_time, ms_time, value_added_time, rework_time, reject_time,
             anomaly_time, up_speed_time, schedule_loss_time, availability_loss_time,
             performance_loss_time, ms_loss_time, reduce_speed_loss_time, quality_loss_time)
           VALUES (${LINE}, '2026-08-01', 4, ${TZ}, 'L', 2,
             0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)`,
      ).rejects.toThrow(/ck_wcsr_shift/);
    });

    // "The first business day of the month — not the last, and not midnight of the
    // first" was editorial in §15.3. Here it is mechanical.
    it("ck_wcmr_month_start rejects a month row dated mid-month", async () => {
      await expect(
        db`INSERT INTO oee.work_center_month_reports (
             work_center_id, business_date, time_zone, work_center_name, work_unit_count,
             runtime, availability_time, production_time, pdt_time, operating_time, updt_time,
             net_time, reduce_speed_time, ms_time, value_added_time, rework_time, reject_time,
             anomaly_time, up_speed_time, schedule_loss_time, availability_loss_time,
             performance_loss_time, ms_loss_time, reduce_speed_loss_time, quality_loss_time)
           VALUES (${LINE}, '2026-08-15', ${TZ}, 'L', 2,
             0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)`,
      ).rejects.toThrow(/ck_wcmr_month_start/);
    });

    // Without this the pipeline's post-hook fails on its first run, and the error
    // names a constraint rather than the missing migration.
    it("the watermark CHECK accepts the three new tables and rejects a fourth", async () => {
      for (const name of [
        "work_center_shift_reports",
        "work_center_day_reports",
        "work_center_month_reports",
      ]) {
        await db`DELETE FROM oee.etl_watermarks WHERE table_name = ${name}`;
        await db`INSERT INTO oee.etl_watermarks (table_name, last_run_at, writer)
                 VALUES (${name}, now(), 'itest')`;
        await db`DELETE FROM oee.etl_watermarks WHERE table_name = ${name}`;
      }

      await expect(
        db`INSERT INTO oee.etl_watermarks (table_name, last_run_at, writer)
           VALUES ('work_center_hour_reports', now(), 'itest')`,
      ).rejects.toThrow(/ck_etl_watermarks_table/);
    });
  });

  describe("the reader", () => {
    async function threeShifts() {
      for (const shift of [1, 2, 3]) {
        await machine({
          workUnitId: MACHINE_A,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
        await machine({
          workUnitId: MACHINE_B,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          productionTime: 8 * H,
          operatingTime: 4 * H,
          valueAddedTime: 3 * H,
        });
      }
      await rollUp();
    }

    it("reads a line row back with both machine counts and the plant zone", async () => {
      await threeShifts();

      const out = await repo.paginateReport({
        grain: "shift",
        limit: 10,
        offset: 0,
        filter: { workCenterId: LINE },
      });

      expect(out.totalElements).toBe(3);
      expect(out.items[0]).toMatchObject({
        grain: "shift",
        businessDate: "2026-08-01",
        timeZone: TZ,
        workCenterId: LINE,
        workCenterName: "Molca Line 1",
        workUnitCount: 2,
        // NULL because this fixture's roll-up does not write it, exactly as the
        // dev seed does not — §16.5 says it must never be a guess.
        expectedWorkUnitCount: null,
      });
    });

    // Descending shift within the day, so the newest shift reads first.
    it("orders shifts newest-first within a business date", async () => {
      await threeShifts();

      const out = await repo.paginateReport({
        grain: "shift",
        limit: 10,
        offset: 0,
        filter: { workCenterId: LINE },
      });

      expect(out.items.map((i) => i.shift)).toEqual([3, 2, 1]);
    });

    // Without the id tiebreak a row can land on two pages and another on none.
    it("pages stably when business_date and shift tie across lines", async () => {
      for (const shift of [1, 2, 3]) {
        await machine({
          workUnitId: MACHINE_A,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
        await machine({
          workUnitId: MACHINE_B,
          workCenterId: OTHER_LINE,
          businessDate: "2026-08-01",
          shift,
          uomId: 1,
          uomCode: "BAG",
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
      }
      await rollUp();

      const first = await repo.paginateReport({ grain: "shift", limit: 3, offset: 0, filter: {} });
      const second = await repo.paginateReport({ grain: "shift", limit: 3, offset: 3, filter: {} });
      const ids = [...first.items, ...second.items].map((i) => i.id);

      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(6);
    });

    // The month filter is a genuine date-to-date range. Shift 3 of 31 July belongs
    // to July's business month and must NOT appear in August — the exact
    // misattribution TODOS §17 records for the work_unit shift list.
    it("filters a month exactly at both boundaries", async () => {
      for (const [businessDate, shift] of [
        ["2026-07-31", 3],
        ["2026-08-01", 1],
        ["2026-08-31", 3],
        ["2026-09-01", 1],
      ] as const) {
        await machine({
          workUnitId: MACHINE_A,
          businessDate,
          shift,
          uomId: 1,
          uomCode: "BAG",
          productionTime: 8 * H,
          operatingTime: 8 * H,
          valueAddedTime: 6 * H,
        });
      }
      await rollUp();

      const out = await repo.paginateReport({
        grain: "shift",
        limit: 10,
        offset: 0,
        filter: { workCenterId: LINE, month: 8, year: 2026 },
      });

      expect(out.items.map((i) => i.businessDate).sort()).toEqual(["2026-08-01", "2026-08-31"]);
    });

    // THREE-VALUED ON PURPOSE. `oee` is nullable, `NULL <> 0` is NULL, so a
    // NULL-OEE row is hidden alongside a zero one. An idle line is an idle line.
    // Anyone "fixing" this to IS DISTINCT FROM 0 brings them back.
    it("hides a NULL-OEE row as well as a zero one when isHideZero is set", async () => {
      // production_time 0 -> the recomputed oee divides by nullif(0) -> NULL.
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-01",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        productionTime: 0,
        operatingTime: 0,
        valueAddedTime: 0,
      });
      await machine({
        workUnitId: MACHINE_A,
        businessDate: "2026-08-02",
        shift: 1,
        uomId: 1,
        uomCode: "BAG",
        productionTime: 8 * H,
        operatingTime: 8 * H,
        valueAddedTime: 6 * H,
      });
      await rollUp();

      const all = await repo.paginateReport({
        grain: "shift",
        limit: 10,
        offset: 0,
        filter: { workCenterId: LINE },
      });
      const hidden = await repo.paginateReport({
        grain: "shift",
        limit: 10,
        offset: 0,
        filter: { workCenterId: LINE, isHideZero: true },
      });

      expect(all.items).toHaveLength(2);
      expect(all.items.some((i) => i.oee === null)).toBe(true);
      expect(hidden.items).toHaveLength(1);
      expect(hidden.items[0]?.businessDate).toBe("2026-08-02");
    });

    // An unknown line is 200-empty here, where /work-units/* is 404. The 404 there
    // guards the id-list mechanism, which this grain does not use.
    it("returns an empty page for an unknown line rather than every line's rows", async () => {
      await threeShifts();

      const out = await repo.paginateReport({
        grain: "shift",
        limit: 10,
        offset: 0,
        filter: { workCenterId: 999_999 },
      });

      expect(out.items).toEqual([]);
      expect(out.totalElements).toBe(0);
    });

    // An explicit id must fail: the sequence is GENERATED ALWAYS, and a drifting
    // sequence collides later rather than now.
    it("refuses an explicit id", async () => {
      await expect(
        db`INSERT INTO oee.work_center_day_reports (
             id, work_center_id, business_date, time_zone, work_center_name, work_unit_count,
             runtime, availability_time, production_time, pdt_time, operating_time, updt_time,
             net_time, reduce_speed_time, ms_time, value_added_time, rework_time, reject_time,
             anomaly_time, up_speed_time, schedule_loss_time, availability_loss_time,
             performance_loss_time, ms_loss_time, reduce_speed_loss_time, quality_loss_time)
           VALUES (1, ${LINE}, '2026-08-01', ${TZ}, 'L', 2,
             0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)`,
      ).rejects.toThrow(/cannot insert a non-DEFAULT value into column "id"/i);
    });
  });

  // -------------------------------------------------------------------------
  // The detail read — GET /work-centers/{grain}-reports/:id
  // -------------------------------------------------------------------------
  //
  // WHAT ONLY A REAL POSTGRES CAN SHOW HERE, and it is all of the interesting
  // part. The fakeSql suite next door asserts the SQL TEXT — that both uom
  // triples are named, that line_out is projected, that nothing is coalesced. It
  // cannot execute any of it, so three failures pass silently there:
  //
  //   1. `numeric` and `bigint` ARRIVE AS STRINGS unless cast. A missed cast makes
  //      a percentage render "96.791" as text (sorted lexicographically) and a
  //      duration CONCATENATE instead of adding. fakeSql returns whatever the test
  //      wrote, so it agrees with itself.
  //   2. A COLUMN THAT DOES NOT EXIST is a 500 at runtime and a green unit test.
  //   3. A CHECK IS DECORATIVE UNTIL SOMETHING PROVES IT FIRES. 0015 widened
  //      ck_*_infeed_units to cover line_out; only a real INSERT can say so.
  //
  // THE FIXTURE IS A MIXED-UNIT ROW — infeed BAG, output CARTON — because that is
  // the shape the whole two-unit design exists for and the one a machine-grain
  // assumption renders wrong without complaining. Written directly rather than
  // through rollUp(): that helper cannot produce an output unit at all, since
  // which machine is the line's outfeed lives in ms_code.count_points upstream.
  describe("the detail read", () => {
    const BAG = 41;
    const CARTON = 42;

    // Every duration distinct and non-round, so a projection that crossed two of
    // them over fails on the value rather than passing on a coincidence.
    const DURATIONS = {
      runtime: 7_100_000,
      availabilityTime: 28_800_000,
      productionTime: 27_000_000,
      pdtTime: 1_800_000,
      operatingTime: 25_200_000,
      updtTime: 1_820_000,
      netTime: 24_100_000,
      reduceSpeedTime: 1_110_000,
      msTime: 1_120_000,
      valueAddedTime: 22_130_000,
      reworkTime: 1_140_000,
      rejectTime: 1_150_000,
      anomalyTime: 1_160_000,
      upSpeedTime: 1_170_000,
      scheduleLossTime: 1_180_000,
      availabilityLossTime: 1_190_000,
      performanceLossTime: 1_200_000,
      msLossTime: 1_210_000,
      reduceSpeedLossTime: -1_220_000,
      qualityLossTime: 1_230_000,
    };

    async function insertLine(
      table: "shift" | "day" | "month",
      over: Record<string, unknown> = {},
    ): Promise<number> {
      const v = {
        infeedUomId: BAG as number | null,
        infeedUomName: "Bag" as string | null,
        infeedUomCode: "BAG" as string | null,
        outputUomId: CARTON as number | null,
        outputUomName: "Carton" as string | null,
        outputUomCode: "CARTON" as string | null,
        totalOut: 70_811 as number | null,
        lineOut: 64_818 as number | null,
        reject: 5_000 as number | null,
        rework: 993 as number | null,
        goodOut: 789 as number | null,
        effectiveOut: 812.5 as number | null,
        teep: 61.5 as number | null,
        oee: 82.5 as number | null,
        availability: 90 as number | null,
        performance: 95 as number | null,
        quality: 96.5 as number | null,
        mttr: 600_000 as number | null,
        mtbf: 7_200_000 as number | null,
        businessDate: table === "month" ? "2026-08-01" : "2026-08-09",
        ...over,
      };

      // The shift table takes one extra column, so the two statements are written
      // out rather than assembled — an interpolated column list is the thing that
      // silently shifts every VALUES position by one.
      const rows =
        table === "shift"
          ? await db<{ id: number }[]>`
              INSERT INTO oee.work_center_shift_reports (
                work_center_id, business_date, shift, time_zone,
                work_center_name, work_center_code, area_id, area_name,
                work_unit_count, expected_work_unit_count,
                infeed_uom_id, infeed_uom_name, infeed_uom_code,
                output_uom_id, output_uom_name, output_uom_code,
                teep, oee, availability, performance, quality,
                total_out, good_out, effective_out, reject, rework, line_out,
                runtime, availability_time, production_time, pdt_time, operating_time,
                updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
                rework_time, reject_time, anomaly_time, up_speed_time,
                schedule_loss_time, availability_loss_time, performance_loss_time,
                ms_loss_time, reduce_speed_loss_time, quality_loss_time, mttr, mtbf
              ) VALUES (
                ${LINE}, ${v.businessDate}::date, 2, ${TZ},
                'Molca Line 8', 'L8', 5, 'Filling',
                4, 5,
                ${v.infeedUomId}, ${v.infeedUomName}, ${v.infeedUomCode},
                ${v.outputUomId}, ${v.outputUomName}, ${v.outputUomCode},
                ${v.teep}, ${v.oee}, ${v.availability}, ${v.performance}, ${v.quality},
                ${v.totalOut}, ${v.goodOut}, ${v.effectiveOut}, ${v.reject}, ${v.rework},
                ${v.lineOut},
                ${DURATIONS.runtime}, ${DURATIONS.availabilityTime},
                ${DURATIONS.productionTime}, ${DURATIONS.pdtTime}, ${DURATIONS.operatingTime},
                ${DURATIONS.updtTime}, ${DURATIONS.netTime}, ${DURATIONS.reduceSpeedTime},
                ${DURATIONS.msTime}, ${DURATIONS.valueAddedTime},
                ${DURATIONS.reworkTime}, ${DURATIONS.rejectTime},
                ${DURATIONS.anomalyTime}, ${DURATIONS.upSpeedTime},
                ${DURATIONS.scheduleLossTime}, ${DURATIONS.availabilityLossTime},
                ${DURATIONS.performanceLossTime}, ${DURATIONS.msLossTime},
                ${DURATIONS.reduceSpeedLossTime}, ${DURATIONS.qualityLossTime},
                ${v.mttr}, ${v.mtbf}
              ) RETURNING id
            `
          : await db<{ id: number }[]>`
              INSERT INTO ${table === "day" ? db`oee.work_center_day_reports` : db`oee.work_center_month_reports`} (
                work_center_id, business_date, time_zone,
                work_center_name, work_center_code, area_id, area_name,
                work_unit_count, expected_work_unit_count,
                infeed_uom_id, infeed_uom_name, infeed_uom_code,
                output_uom_id, output_uom_name, output_uom_code,
                teep, oee, availability, performance, quality,
                total_out, good_out, effective_out, reject, rework, line_out,
                runtime, availability_time, production_time, pdt_time, operating_time,
                updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
                rework_time, reject_time, anomaly_time, up_speed_time,
                schedule_loss_time, availability_loss_time, performance_loss_time,
                ms_loss_time, reduce_speed_loss_time, quality_loss_time, mttr, mtbf
              ) VALUES (
                ${LINE}, ${v.businessDate}::date, ${TZ},
                'Molca Line 8', 'L8', 5, 'Filling',
                4, 5,
                ${v.infeedUomId}, ${v.infeedUomName}, ${v.infeedUomCode},
                ${v.outputUomId}, ${v.outputUomName}, ${v.outputUomCode},
                ${v.teep}, ${v.oee}, ${v.availability}, ${v.performance}, ${v.quality},
                ${v.totalOut}, ${v.goodOut}, ${v.effectiveOut}, ${v.reject}, ${v.rework},
                ${v.lineOut},
                ${DURATIONS.runtime}, ${DURATIONS.availabilityTime},
                ${DURATIONS.productionTime}, ${DURATIONS.pdtTime}, ${DURATIONS.operatingTime},
                ${DURATIONS.updtTime}, ${DURATIONS.netTime}, ${DURATIONS.reduceSpeedTime},
                ${DURATIONS.msTime}, ${DURATIONS.valueAddedTime},
                ${DURATIONS.reworkTime}, ${DURATIONS.rejectTime},
                ${DURATIONS.anomalyTime}, ${DURATIONS.upSpeedTime},
                ${DURATIONS.scheduleLossTime}, ${DURATIONS.availabilityLossTime},
                ${DURATIONS.performanceLossTime}, ${DURATIONS.msLossTime},
                ${DURATIONS.reduceSpeedLossTime}, ${DURATIONS.qualityLossTime},
                ${v.mttr}, ${v.mtbf}
              ) RETURNING id
            `;

      return rows[0]!.id;
    }

    it("returns undefined for an id that names nothing", async () => {
      expect(await repo.getReport("shift", 2_147_483_600)).toBeUndefined();
    });

    // EVERY MEASURE AS A NUMBER. `typeof` and not a value comparison, because
    // "96.791" == 96.791 is false in TS but every assertion written with toEqual
    // against a string literal would still pass. This is the cast trap, and it is
    // invisible to the unit suite.
    it("returns every measure as a number, not a string", async () => {
      const id = await insertLine("shift");
      const report = (await repo.getReport("shift", id))!;

      for (const [key, value] of Object.entries(report)) {
        if (value === null) continue;
        if (["grain", "businessDate", "timeZone"].includes(key)) continue;
        if (key.endsWith("Name") || key.endsWith("Code")) continue;
        expect(typeof value, `${key} came back as ${typeof value}`).toBe("number");
      }
    });

    it("round-trips every duration exactly, including a negative loss", async () => {
      const id = await insertLine("shift");
      const report = (await repo.getReport("shift", id))!;

      expect(report).toMatchObject(DURATIONS);
      // Signed, not clamped. Losses may be negative and the browser's waterfall
      // clamps the GEOMETRY only — the number itself has to survive the wire.
      expect(report.reduceSpeedLossTime).toBe(-1_220_000);
    });

    // THE TWO SIDES STAY APART. This is the assertion the whole grain exists for:
    // total_out is in BAG and effective_out is in CARTON on the SAME row, so a
    // reader that collapsed them into one uom would put cartons under a bag label
    // and nothing would fail.
    it("keeps the infeed and output unit triples distinct on one row", async () => {
      const id = await insertLine("shift");
      const report = (await repo.getReport("shift", id))!;

      expect(report).toMatchObject({
        infeedUomId: BAG,
        infeedUomName: "Bag",
        infeedUomCode: "BAG",
        outputUomId: CARTON,
        outputUomName: "Carton",
        outputUomCode: "CARTON",
      });
      // And the counts they denominate, so the pairing is pinned rather than the
      // labels alone.
      expect(report).toMatchObject({
        totalOut: 70_811,
        lineOut: 64_818,
        reject: 5_000,
        rework: 993,
        goodOut: 789,
        effectiveOut: 812.5,
      });
    });

    // `total_out = good_out + reject + rework` IS FALSE HERE, by construction:
    // 70811 <> 789 + 5000 + 993. Asserted rather than merely documented, because
    // it is the invariant a reviewer keeps trying to restore.
    it("does not reconcile the infeed and output counts, and must not", async () => {
      const id = await insertLine("shift");
      const report = (await repo.getReport("shift", id))!;

      expect(report.totalOut).not.toBe(
        (report.goodOut ?? 0) + (report.reject ?? 0) + (report.rework ?? 0),
      );
    });

    // NULL SURVIVES AS NULL. A coalesce anywhere in the projection turns "the
    // members disagreed" and "the pipeline has not computed this" into a
    // measurement of zero.
    it("passes a fully abstaining row through as nulls", async () => {
      const id = await insertLine("shift", {
        infeedUomId: null,
        infeedUomName: null,
        infeedUomCode: null,
        outputUomId: null,
        outputUomName: null,
        outputUomCode: null,
        totalOut: null,
        lineOut: null,
        reject: null,
        rework: null,
        goodOut: null,
        effectiveOut: null,
        teep: null,
        oee: null,
        availability: null,
        performance: null,
        quality: null,
        mttr: null,
        mtbf: null,
      });

      expect(await repo.getReport("shift", id)).toMatchObject({
        totalOut: null,
        lineOut: null,
        goodOut: null,
        oee: null,
        mttr: null,
        mtbf: null,
      });
    });

    it("serves all three grains, with shift null at the coarse ones", async () => {
      const shiftId = await insertLine("shift");
      const dayId = await insertLine("day");
      const monthId = await insertLine("month");

      expect((await repo.getReport("shift", shiftId))?.shift).toBe(2);
      expect((await repo.getReport("day", dayId))?.shift).toBeNull();
      expect((await repo.getReport("month", monthId))?.shift).toBeNull();
    });

    // SIX TABLES, SIX SEQUENCES. The same integer is a valid id in more than one
    // of them, and reading the wrong table returns a complete, plausible report.
    // This is the hazard AGENTS.md states for the browser, proved at the source.
    it("reads a different row for the same id at a different grain", async () => {
      const dayId = await insertLine("day", { businessDate: "2026-08-09" });
      // Force a month row to exist; ids are independent, so if the day id happens
      // to be valid in the month table too, the two must not be the same row.
      await insertLine("month");

      const asDay = await repo.getReport("day", dayId);
      const asMonth = await repo.getReport("month", dayId);

      expect(asDay?.grain).toBe("day");
      expect(asMonth === undefined || asMonth.grain === "month").toBe(true);
    });

    // ---- the CHECK 0015 widened -------------------------------------------
    //
    // BOTH ARMS, because a constraint is decorative until something proves it
    // fires AND proves it does not fire on the legitimate case.

    it("refuses a line_out written without an infeed unit", async () => {
      await expect(
        insertLine("shift", {
          infeedUomId: null,
          infeedUomName: null,
          infeedUomCode: null,
          totalOut: null,
          reject: null,
          rework: null,
          // The whole point: every other infeed count abstains, but this one does
          // not — a number with no label, which is what ck_*_infeed_units exists
          // to stop. Before 0015 widened it, this INSERT succeeded.
          lineOut: 64_818,
        }),
      ).rejects.toThrow(/ck_wcsr_infeed_units/);
    });

    it("accepts a row that abstains on the whole infeed side, line_out included", async () => {
      const id = await insertLine("shift", {
        infeedUomId: null,
        infeedUomName: null,
        infeedUomCode: null,
        totalOut: null,
        reject: null,
        rework: null,
        lineOut: null,
      });

      // And the OUTPUT side is untouched by that abstention — the two guards are
      // separate so a line can be sure of what it shipped while abstaining on what
      // it consumed.
      expect(await repo.getReport("shift", id)).toMatchObject({
        lineOut: null,
        goodOut: 789,
        outputUomCode: "CARTON",
      });
    });

    it("enforces the same widened guard on the day and month tables", async () => {
      await expect(
        insertLine("day", {
          infeedUomId: null,
          infeedUomName: null,
          infeedUomCode: null,
          totalOut: null,
          reject: null,
          rework: null,
          lineOut: 1,
        }),
      ).rejects.toThrow(/ck_wcdr_infeed_units/);

      await expect(
        insertLine("month", {
          infeedUomId: null,
          infeedUomName: null,
          infeedUomCode: null,
          totalOut: null,
          reject: null,
          rework: null,
          lineOut: 1,
        }),
      ).rejects.toThrow(/ck_wcmr_infeed_units/);
    });
  });

  // -------------------------------------------------------------------------
  // The line approval — a cascade over N machine shift reports
  // -------------------------------------------------------------------------
  //
  // WHY THIS ONE HAS TO BE AN INTEGRATION TEST, more than anything else in this
  // file. The cascade is a single data-modifying CTE: a conditional upsert whose
  // RETURNING feeds an event insert. Almost every property that matters about it
  // is a property of POSTGRES rather than of the code:
  //
  //   * `WHERE a.status = 'open'` on the DO UPDATE is what makes the statement
  //     idempotent AND countable. That the already-closed rows drop out of
  //     RETURNING — and therefore write no duplicate event — is postgres's
  //     behaviour, not ours.
  //   * ck_wusra_open requires all four closure columns to be cleared on reopen.
  //     A partial clear is a constraint violation, which no unit test can raise.
  //   * The half-open window either does or does not cover a row. Only a real
  //     comparison against a real timestamptz can say.
  //
  //           machine A ──┐
  //           machine B ──┼── one line, one shift, one business date
  //           machine C ──┘
  //
  //   approve  →  3 approvals closed, 3 events (open→closed)
  //   approve  →  409 territory: 0 newly closed, NO further events
  //   reopen   →  3 approvals open,   3 more events (closed→open)
  describe("the line approval cascade", () => {
    const MACHINES = [MACHINE_A, MACHINE_B, 9203];
    const DATE = "2026-09-10";
    const SHIFT = 2;
    // Shift 2 at Asia/Jakarta is 15:00–23:00 local, i.e. 08:00–16:00Z.
    const FROM = new Date("2026-09-10T08:00:00.000Z");
    const TO = new Date("2026-09-10T16:00:00.000Z");

    // SCOPED BY THE LINE, not by a list of machine ids: every one of these tables
    // carries work_center_id, so nothing here needs the roster. The machine
    // fixtures below all write ${LINE} into that column.
    const key = () => ({ workCenterId: LINE, from: FROM, to: TO, shift: SHIFT });
    const input = () => ({ ...key(), closedBy: "kc-sub-1", closedByName: "dewi" });

    async function machineAt(workUnitId: number, at: string) {
      await db`
        INSERT INTO oee.work_unit_shift_reports (
          shift, date, business_date, time_zone,
          work_unit_id, work_unit_name, work_unit_code,
          work_center_id, work_center_name, work_center_code,
          uom_id, uom_name, uom_code,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time,
          reject, rework, mttr, mtbf
        ) VALUES (
          ${SHIFT}, ${at}::timestamptz, ${DATE}::date, ${TZ},
          ${workUnitId}, ${"M" + workUnitId}, ${"M" + workUnitId},
          ${LINE}, 'Molca Line 8', 'L8',
          1, 'Bag', 'BAG',
          0,0,0,0,0, 0,0,0,
          0,0,0,0,0, 0,0,0,0,0, 0,0,0,0, 0,0,0, 0,0,0, 0,0,0,0
        )
      `;
    }

    async function approvals() {
      return await db<{ workUnitId: number; status: string; closedBy: string | null }[]>`
        SELECT work_unit_id, status, closed_by
        FROM oee.work_unit_shift_report_approvals
        WHERE work_unit_id IN ${db(MACHINES)}
        ORDER BY work_unit_id
      `;
    }

    async function events() {
      return await db<{ workUnitId: number; fromStatus: string; toStatus: string }[]>`
        SELECT work_unit_id, from_status, to_status
        FROM oee.work_unit_shift_report_approval_events
        WHERE work_unit_id IN ${db(MACHINES)}
        ORDER BY id
      `;
    }

    beforeEach(async () => {
      await db`DELETE FROM oee.work_unit_shift_report_approval_events WHERE work_unit_id IN ${db(MACHINES)}`;
      await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id IN ${db(MACHINES)}`;
      await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id IN ${db(MACHINES)}`;
      // All three at the same instant, which is the ordinary case.
      for (const id of MACHINES) await machineAt(id, "2026-09-10T08:00:00Z");
    });

    it("closes every machine on the line and writes one event each", async () => {
      const out = await writer.closeLineShift(input());

      expect(out).toEqual({ machinesFound: 3, machinesClosed: 3 });
      expect(await approvals()).toEqual([
        { workUnitId: 9201, status: "closed", closedBy: "kc-sub-1" },
        { workUnitId: 9202, status: "closed", closedBy: "kc-sub-1" },
        { workUnitId: 9203, status: "closed", closedBy: "kc-sub-1" },
      ]);
      expect(await events()).toHaveLength(3);
      expect(
        (await events()).every((e) => e.fromStatus === "open" && e.toStatus === "closed"),
      ).toBe(true);
    });

    // IDEMPOTENT, AND NO DUPLICATE TRAIL. The second call must not write three
    // more events saying open→closed for rows that were already closed — that is
    // an audit trail asserting a transition that never happened.
    it("is idempotent, and writes no second event", async () => {
      await writer.closeLineShift(input());
      const out = await writer.closeLineShift(input());

      expect(out).toEqual({ machinesFound: 3, machinesClosed: 3 });
      expect(await events()).toHaveLength(3);
    });

    // A PARTIALLY APPROVED LINE — reachable the moment somebody approves one
    // machine from the machine screen. Only the open ones move, and only they get
    // an event.
    it("closes only the machines that are still open", async () => {
      await db`
        INSERT INTO oee.work_unit_shift_report_approvals
          (work_unit_id, date, shift, status, source, closed_at, closed_by)
        SELECT work_unit_id, date, shift, 'closed', 'operator', now(), 'someone-else'
        FROM oee.work_unit_shift_reports WHERE work_unit_id = ${MACHINE_A}
      `;

      const out = await writer.closeLineShift(input());

      expect(out).toEqual({ machinesFound: 3, machinesClosed: 3 });
      // Two events, not three: machine A was already closed and did not move.
      expect(await events()).toHaveLength(2);
      // And the existing approver is NOT overwritten — the DO UPDATE never fired
      // for that row.
      const rows = await approvals();
      expect(rows.find((r) => r.workUnitId === MACHINE_A)?.closedBy).toBe("someone-else");
    });

    // THE HALF-OPEN WINDOW, WHICH IS THE POINT OF [9A]. A machine row written even
    // slightly off the shift's start instant is still inside [from, to) and must
    // be approved. Under the equality match this replaced, this machine was
    // skipped and the cascade returned a perfectly plausible "2 of 3".
    it("covers a machine row written off the exact start instant", async () => {
      await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = ${9203}`;
      await machineAt(9203, "2026-09-10T08:00:00.001Z");

      const out = await writer.closeLineShift(input());

      expect(out.machinesFound).toBe(3);
      expect(out.machinesClosed).toBe(3);
    });

    // The other end of the same guard: a row belonging to the NEXT shift must not
    // be swept in. `to` is exclusive.
    it("excludes a row at the window's upper bound", async () => {
      await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = ${9203}`;
      await machineAt(9203, "2026-09-10T16:00:00Z");

      const out = await writer.closeLineShift(input());

      expect(out.machinesFound).toBe(2);
      expect((await approvals()).map((r) => r.workUnitId)).toEqual([9201, 9202]);
    });

    it("reports nothing found when no machine reported that shift", async () => {
      await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id IN ${db(MACHINES)}`;

      expect(await writer.closeLineShift(input())).toEqual({
        machinesFound: 0,
        machinesClosed: 0,
      });
    });

    // ---- summarise ---------------------------------------------------------

    it("summarises an untouched line as none closed", async () => {
      expect(await writer.summariseLineShift(key())).toEqual({
        machinesFound: 3,
        machinesClosed: 0,
      });
    });

    it("summarises a partially approved line", async () => {
      await db`
        INSERT INTO oee.work_unit_shift_report_approvals
          (work_unit_id, date, shift, status, source, closed_at, closed_by)
        SELECT work_unit_id, date, shift, 'closed', 'operator', now(), 'x'
        FROM oee.work_unit_shift_reports WHERE work_unit_id = ${MACHINE_A}
      `;

      expect(await writer.summariseLineShift(key())).toEqual({
        machinesFound: 3,
        machinesClosed: 1,
      });
    });

    // A row with status 'open' is NOT closed, and absence of a row is also open
    // (0010). count(a.status) FILTER would count an 'open' row if the filter were
    // dropped, which is the count(*)-not-count(column) rule pointing the other way.
    it("does not count an explicitly open approval row as closed", async () => {
      await db`
        INSERT INTO oee.work_unit_shift_report_approvals (work_unit_id, date, shift, status)
        SELECT work_unit_id, date, shift, 'open'
        FROM oee.work_unit_shift_reports WHERE work_unit_id = ${MACHINE_A}
      `;

      expect(await writer.summariseLineShift(key())).toEqual({
        machinesFound: 3,
        machinesClosed: 0,
      });
    });

    // ---- reopen ------------------------------------------------------------

    // ALL FOUR CLOSURE COLUMNS CLEARED. ck_wusra_open enforces it, so a partial
    // clear raises a constraint violation here rather than leaving a stale
    // approver on a reopened report — which is exactly why the constraint is
    // written that way, and why only a real database can prove it.
    it("reopens every closed machine and clears the whole closure", async () => {
      await writer.closeLineShift(input());

      const out = await writer.reopenLineShift(input());

      expect(out).toEqual({ machinesFound: 3, machinesClosed: 0 });
      const rows = await db<{ status: string; closedAt: Date | null; closedBy: string | null }[]>`
        SELECT status, closed_at, closed_by, closed_by_name, source
        FROM oee.work_unit_shift_report_approvals WHERE work_unit_id IN ${db(MACHINES)}
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({ status: "open", closedAt: null, closedBy: null });
      }
    });

    it("records the reopen in the trail, in the right direction", async () => {
      await writer.closeLineShift(input());
      await writer.reopenLineShift(input());

      const trail = await events();
      expect(trail).toHaveLength(6);
      expect(trail.slice(3).every((e) => e.fromStatus === "closed" && e.toStatus === "open")).toBe(
        true,
      );
    });

    it("is idempotent on reopen, and writes no second event", async () => {
      await writer.closeLineShift(input());
      await writer.reopenLineShift(input());
      const out = await writer.reopenLineShift(input());

      expect(out).toEqual({ machinesFound: 3, machinesClosed: 0 });
      expect(await events()).toHaveLength(6);
    });

    // THE FREEZE, WHICH IS THE PAYOFF OF THE CASCADE SHAPE. The downtime edit path
    // consults oee.work_unit_shift_report_approvals through listApprovalsOverlapping
    // — it knows nothing about lines. Because a line approval IS machine
    // approvals, a stop on this line is frozen with no change to that module at
    // all. Asserted here rather than described, because "no code changed" is
    // exactly the claim that rots.
    it("leaves the machine approvals the downtime freeze already reads", async () => {
      await writer.closeLineShift(input());

      const frozen = await db<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM oee.work_unit_shift_report_approvals
        WHERE work_unit_id IN ${db(MACHINES)} AND status = 'closed'
      `;

      expect(frozen[0]?.count).toBe(3);
    });

    // ---- the activity feed -------------------------------------------------

    // JOINED TO THE MACHINE REPORTS, NOT FILTERED ON work_unit_id ALONE. The
    // events table carries (work_unit_id, date, shift) and no work_center_id, so
    // the join is the only thing scoping the feed to THIS line shift — filtering
    // on the roster alone returns every transition those machines ever had.
    it("returns only the transitions belonging to this line shift", async () => {
      await writer.closeLineShift(input());

      // A transition on the same machine, a DIFFERENT shift. It must not appear.
      await db`
        INSERT INTO oee.work_unit_shift_report_approval_events
          (work_unit_id, date, shift, by_subject, from_status, to_status, source)
        VALUES (${MACHINE_A}, '2026-09-11T08:00:00Z'::timestamptz, 1,
                'someone', 'open', 'closed', 'operator')
      `;

      const entries = await repo.listApprovalTransitions(key());

      expect(entries).toHaveLength(3);
      expect(entries.every((e) => e.kind === "approval")).toBe(true);
    });

    // EACH ENTRY NAMES ITS MACHINE. A line shift's transitions all share one
    // shift and span N machines, so an unlabelled entry reads as an approval of
    // the line itself — which is the one thing there is no such thing as.
    it("labels each transition with the machine it moved", async () => {
      await writer.closeLineShift(input());

      const entries = await repo.listApprovalTransitions(key());

      // `?? 0` because LineActivityEntry's workUnitId went nullable when Part 3
      // added the quality arm — a rework entry carries no machine. An APPROVAL
      // always does, so a 0 appearing here would be a real regression rather than
      // a tolerated null, which is why the fallback is a value the assertion
      // rejects.
      expect(entries.map((e) => e.workUnitId ?? 0).sort((a, b) => a - b)).toEqual([
        9201, 9202, 9203,
      ]);
      // From the denormalised column on the report row, NOT from mes-master-data:
      // this read makes no upstream call.
      expect(entries.every((e) => e.workUnitName !== null)).toBe(true);
    });

    it("orders the feed newest first", async () => {
      await writer.closeLineShift(input());
      await writer.reopenLineShift(input());

      const entries = await repo.listApprovalTransitions(key());

      expect(entries).toHaveLength(6);
      // The reopens are the later pair of three.
      expect(entries.slice(0, 3).every((e) => e.kind === "approval" && e.toStatus === "open")).toBe(
        true,
      );
    });

    it("reports no stops and nothing trackable on a line with no downtime", async () => {
      expect(await repo.listDowntimeEdits(key())).toEqual({
        entries: [],
        totalMembers: 0,
        trackedMembers: 0,
      });
    });

    // count(*) FOR THE TOTAL AND count(source_event_id) FOR THE TRACKABLE HALF.
    // A stop the pipeline never gave a source_event_id cannot carry a trail at
    // all, and "2 stops, 1 trackable" is a different statement from "nobody
    // edited anything" — which is what the feed's `sources` has to be able to say.
    it("separates the stops that exist from the stops that could carry a trail", async () => {
      await db`
        INSERT INTO oee.downtime_reports
          (reason, category, work_unit_id, shift, start_at, end_at,
           work_center_id, source_event_id)
        VALUES
          ('[]'::jsonb, 'UNPLANNED', ${MACHINE_A}, ${SHIFT},
           '2026-09-10T09:00:00Z', '2026-09-10T09:30:00Z', ${LINE}, 'evt-1'),
          ('[]'::jsonb, 'UNPLANNED', ${MACHINE_B}, ${SHIFT},
           '2026-09-10T10:00:00Z', '2026-09-10T10:30:00Z', ${LINE}, NULL)
      `;

      const out = await repo.listDowntimeEdits(key());

      expect(out).toMatchObject({ totalMembers: 2, trackedMembers: 1 });

      await db`DELETE FROM oee.downtime_reports WHERE work_unit_id IN ${db(MACHINES)}`;
    });

    // ---- the feed at DAY and MONTH grain (TODOS §60) ------------------------
    //
    // WHAT ONLY A REAL POSTGRES SHOWS HERE. The one predicate that differs across
    // the three grains is `machineReports`'s shift narrowing, and it is now
    // conditional — interpolated as nothing when the window carries no shift. The
    // ways that goes wrong are all quiet:
    //
    //   `AND r.shift = NULL`  three-valued, so the join matches nothing and the
    //                         day feed's approval arm is silently EMPTY. No error,
    //                         and "nobody approved anything today" is a plausible
    //                         screen.
    //   predicate dropped at  a shift report's feed then shows all three shifts'
    //   shift grain           transitions, which is a populated panel about the
    //                         wrong span.
    //
    // A fakeSql suite cannot see either: it matches SQL TEXT without executing it,
    // so both variants are "a query mentioning work_unit_shift_reports".
    //
    // The window here is the WHOLE BUSINESS DAY — 07:00 to 07:00 plant-local, i.e.
    // 00:00Z to 00:00Z at Asia/Jakarta — which is what resolveReportWindow produces
    // at day grain and which contains all three shifts.
    const DAY_FROM = new Date("2026-09-10T00:00:00.000Z");
    const DAY_TO = new Date("2026-09-11T00:00:00.000Z");
    const dayWindow = () => ({ workCenterId: LINE, from: DAY_FROM, to: DAY_TO, shift: null });

    // Machine A on a THIRD shift inside the same day, so the day window genuinely
    // covers rows the shift window does not.
    async function machineOnShift(workUnitId: number, shift: number, at: string) {
      await db`
        INSERT INTO oee.work_unit_shift_reports (
          shift, date, business_date, time_zone,
          work_unit_id, work_unit_name, work_unit_code,
          work_center_id, work_center_name, work_center_code,
          uom_id, uom_name, uom_code,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time,
          reject, rework, mttr, mtbf
        ) VALUES (
          ${shift}, ${at}::timestamptz, ${DATE}::date, ${TZ},
          ${workUnitId}, ${"M" + workUnitId}, ${"M" + workUnitId},
          ${LINE}, 'Molca Line 8', 'L8',
          1, 'Bag', 'BAG',
          0,0,0,0,0, 0,0,0,
          0,0,0,0,0, 0,0,0,0,0, 0,0,0,0, 0,0,0, 0,0,0, 0,0,0,0
        )
      `;
    }

    // THE ASSERTION THE CONDITIONAL PREDICATE EXISTS FOR. Three machines on shift 2
    // plus one on shift 1: the day window must see four, and the shift window two
    // (A and B are already on shift 2, and so is 9203 — so shift 2 is three).
    it("covers every shift in the window at day grain, and only one at shift grain", async () => {
      // A second row for MACHINE_A on shift 1, inside the same business day.
      await machineOnShift(MACHINE_A, 1, "2026-09-10T00:00:00Z");

      expect(await repo.countMachineReports(dayWindow())).toBe(4);
      expect(await repo.countMachineReports(key())).toBe(3);
    });

    // AND THE COUNT AGREES WITH THE JOIN, which is the whole reason it goes through
    // the same fragment. The approval arm's `totalMembers` says how many records
    // COULD carry a transition; a second predicate here would let the panel report
    // "3 of 12" over a join that had looked at 9.
    it("counts exactly the reports the approval arm joins against", async () => {
      await machineOnShift(MACHINE_A, 1, "2026-09-10T00:00:00Z");
      // Close shift 2's three, then write a shift-1 transition by hand.
      await writer.closeLineShift(input());
      await db`
        INSERT INTO oee.work_unit_shift_report_approval_events
          (work_unit_id, date, shift, by_subject, from_status, to_status, source)
        VALUES (${MACHINE_A}, '2026-09-10T00:00:00Z'::timestamptz, 1,
                'someone', 'open', 'closed', 'operator')
      `;

      const entries = await repo.listApprovalTransitions(dayWindow());

      // Four transitions over four member reports — so the arm's two counts are
      // equal, which is what the service reports.
      expect(entries).toHaveLength(4);
      expect(await repo.countMachineReports(dayWindow())).toBe(4);
    });

    // THE SHIFT LABEL, which is what makes ~3N rows readable. A day feed spans
    // three shifts AND N machines, and without this half two transitions on one
    // machine are indistinguishable.
    it("labels each transition with its shift as well as its machine", async () => {
      await machineOnShift(MACHINE_A, 1, "2026-09-10T00:00:00Z");
      await writer.closeLineShift(input());
      await db`
        INSERT INTO oee.work_unit_shift_report_approval_events
          (work_unit_id, date, shift, by_subject, from_status, to_status, source)
        VALUES (${MACHINE_A}, '2026-09-10T00:00:00Z'::timestamptz, 1,
                'someone', 'open', 'closed', 'operator')
      `;

      const entries = await repo.listApprovalTransitions(dayWindow());
      const onMachineA = entries.filter((e) => e.workUnitId === MACHINE_A);

      // TWO ROWS FOR ONE MACHINE, separated only by the shift — which is exactly
      // the pair the label exists for.
      expect(onMachineA).toHaveLength(2);
      expect(
        onMachineA
          .map((e) => ("shift" in e ? e.shift : null))
          .sort((a, b) => Number(a) - Number(b)),
      ).toEqual([1, 2]);
    });

    // A transition on the NEXT business day must not appear, which is the half-open
    // upper bound doing its job. `BETWEEN` here would pull in the next day's 07:00
    // shift-1 report — the class of error that renders a plausible feed rather than
    // throwing.
    it("excludes the next business day at day grain", async () => {
      await machineOnShift(MACHINE_A, 1, "2026-09-11T00:00:00Z");

      expect(await repo.countMachineReports(dayWindow())).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2's four reads
// ---------------------------------------------------------------------------
//
// WHAT ONLY A REAL POSTGRES SHOWS HERE. The unit suite can assert which table a
// read names and that a cast is present; it cannot execute a `factor_to_base`
// multiplication, cannot prove a half-open range covers the row it is meant to,
// and cannot fire a CHECK. All three are what these cases are for.
describe.skipIf(!url)("WorkCenterReportReaderRepository — Part 2 reads", () => {
  const db2 = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo2 = new WorkCenterReportReaderRepository({ goldDb: db2 });

  const P_LINE = 9401;
  const P_MACHINE_A = 9411;
  const P_MACHINE_B = 9412;

  async function clean() {
    await db2`DELETE FROM oee.product_count_wc_shift WHERE work_center_id = ${P_LINE}`;
    await db2`DELETE FROM oee.product_count_wc_day WHERE work_center_id = ${P_LINE}`;
    await db2`DELETE FROM oee.reject_count_wu_shift WHERE work_unit_id IN (${P_MACHINE_A}, ${P_MACHINE_B})`;
    await db2`DELETE FROM oee.downtime_log_events WHERE work_unit_id IN (${P_MACHINE_A}, ${P_MACHINE_B})`;
    await db2`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id IN (${P_MACHINE_A}, ${P_MACHINE_B})`;
    await db2`DELETE FROM oee.work_unit_day_reports WHERE work_unit_id IN (${P_MACHINE_A}, ${P_MACHINE_B})`;
  }

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db2.end();
  });

  // Shift 1 at Asia/Jakarta is 07:00-15:00 local — 00:00Z to 08:00Z.
  const INSTANTS = {
    from: new Date("2026-08-09T00:00:00Z"),
    to: new Date("2026-08-09T08:00:00Z"),
  };
  const DAY_INSTANTS = {
    from: new Date("2026-08-09T00:00:00Z"),
    to: new Date("2026-08-10T00:00:00Z"),
  };

  const win = (over: Record<string, unknown> = {}) => ({
    workCenterId: P_LINE,
    dateFrom: "2026-08-09",
    dateTo: "2026-08-10",
    shift: 1 as number | null,
    timeZone: TZ,
    ...over,
  });

  // ---- SKU View -----------------------------------------------------------

  async function product(over: Record<string, unknown> = {}) {
    const v = {
      shift: 1,
      businessDate: "2026-08-09",
      productId: 1,
      uomCode: "CARTON",
      baseUomCode: "BAG",
      factor: 12,
      totalOut: 100,
      goodOut: 90,
      reject: 5,
      rework: 2,
      ...over,
    };
    await db2`
      INSERT INTO oee.product_count_wc_shift (
        work_center_id, business_date, shift, time_zone, work_center_name, work_center_code,
        product_id, product_name, product_code,
        uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
        total_out, good_out, reject, rework
      ) VALUES (
        ${P_LINE}, ${v.businessDate}::date, ${v.shift}, ${TZ}, 'Molca Line 8', 'L8',
        ${v.productId}, ${"SKU " + v.productId}, ${"P" + v.productId},
        1, ${v.uomCode}, ${v.uomCode}, 2, ${v.baseUomCode}, ${v.baseUomCode}, ${v.factor},
        ${v.totalOut}, ${v.goodOut}, ${v.reject}, ${v.rework}
      )
    `;
  }

  // FACTOR_TO_BASE IS APPLIED TO THREE OF THE FOUR, and this is the assertion that
  // matters most on this read: good_out must NOT be scaled, because Finish Good
  // stays in the unit it was counted in. Scaling it would multiply the one figure
  // an operator recognises by twelve.
  it("scales total_out, reject and rework but never good_out", async () => {
    await product({ totalOut: 100, goodOut: 90, reject: 5, rework: 2, factor: 12 });

    const [item] = await repo2.listProductCount("shift", win());

    expect(item).toMatchObject({
      totalOut: 1200,
      reject: 60,
      rework: 24,
      goodOut: 90,
      uomCode: "CARTON",
      baseUomCode: "BAG",
    });
  });

  // THE CONSEQUENCE OF THE ABOVE, asserted so nobody "fixes" it: the figures are
  // not additive on screen when factor_to_base <> 1.
  it("leaves the row deliberately non-additive", async () => {
    await product({ totalOut: 100, goodOut: 90, reject: 5, rework: 2, factor: 12 });

    const [item] = await repo2.listProductCount("shift", win());

    expect(item!.totalOut).not.toBe(item!.goodOut + item!.reject + item!.rework);
  });

  it("returns nothing for a line with no product rows", async () => {
    expect(await repo2.listProductCount("shift", win())).toEqual([]);
  });

  // THE SHIFT NARROWS; THE DATE RANGE DOES NOT. A shift-grain read must not pick up
  // the other two shifts of the same business day — the range is [day, day+1) for
  // all three grains and `shift` is the only thing separating them.
  it("narrows to one shift at shift grain", async () => {
    await product({ shift: 1, totalOut: 100 });
    await product({ shift: 2, totalOut: 700, productId: 2 });

    const items = await repo2.listProductCount("shift", win({ shift: 1 }));

    expect(items).toHaveLength(1);
    expect(items[0]?.totalOut).toBe(1200);
  });

  // A PRODUCT WHOSE UNIT CHANGED INSIDE THE WINDOW comes back as TWO rows rather
  // than one summing unlike things — the group key carries both unit codes for
  // exactly this. Rendering two rows is the honest answer; one merged row would be
  // a number in no unit at all.
  it("splits a product whose unit changed rather than summing across units", async () => {
    await db2`DELETE FROM oee.product_count_wc_day WHERE work_center_id = ${P_LINE}`;
    for (const [date, uom] of [
      ["2026-08-09", "CARTON"],
      ["2026-08-10", "PALLET"],
    ] as const) {
      await db2`
        INSERT INTO oee.product_count_wc_day (
          work_center_id, business_date, time_zone, work_center_name, work_center_code,
          product_id, product_name, product_code,
          uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
          total_out, good_out, reject, rework
        ) VALUES (
          ${P_LINE}, ${date}::date, ${TZ}, 'Molca Line 8', 'L8',
          7, 'SKU 7', 'P7',
          1, ${uom}, ${uom}, 2, 'BAG', 'BAG', 1,
          10, 9, 1, 0
        )
      `;
    }

    const items = await repo2.listProductCount(
      "day",
      win({ dateFrom: "2026-08-09", dateTo: "2026-08-11" }),
    );

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.uomCode).sort()).toEqual(["CARTON", "PALLET"]);
  });

  // THE DAY TABLE ANSWERS THE MONTH GRAIN, which is why 0016 creates two tables and
  // not three. A month read is the same projection over a wider range.
  it("sums the day table across a month range", async () => {
    for (const date of ["2026-08-01", "2026-08-15", "2026-08-31"]) {
      await db2`
        INSERT INTO oee.product_count_wc_day (
          work_center_id, business_date, time_zone, work_center_name, work_center_code,
          product_id, product_name, product_code,
          uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
          total_out, good_out, reject, rework
        ) VALUES (
          ${P_LINE}, ${date}::date, ${TZ}, 'Molca Line 8', 'L8',
          3, 'SKU 3', 'P3', 1, 'CARTON', 'CARTON', 2, 'BAG', 'BAG', 10,
          5, 4, 1, 0
        )
      `;
    }

    const [item] = await repo2.listProductCount(
      "month",
      win({ dateFrom: "2026-08-01", dateTo: "2026-09-01", shift: null }),
    );

    expect(item?.totalOut).toBe(150);
    expect(item?.goodOut).toBe(12);
  });

  // ---- the extended infeed CHECK from 0016 --------------------------------

  it("refuses a non-positive conversion factor", async () => {
    await expect(product({ factor: 0 })).rejects.toThrow(/ck_pcwcs_factor/);
  });

  it("refuses a negative count", async () => {
    await expect(product({ reject: -1 })).rejects.toThrow(/ck_pcwcs_nonneg/);
  });

  // ---- Machine View --------------------------------------------------------

  async function machineReport(workUnitId: number, over: Record<string, unknown> = {}) {
    const v = { shift: 1, businessDate: "2026-08-09", totalOut: 100, ...over };
    await db2`
      INSERT INTO oee.work_unit_shift_reports (
        shift, date, business_date, time_zone,
        work_unit_id, work_unit_name, work_unit_code, work_center_id, uom_id, uom_name, uom_code,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework, mttr, mtbf
      ) VALUES (
        ${v.shift}, ${`${v.businessDate}T00:00:00Z`}::timestamptz, ${v.businessDate}::date, ${TZ},
        ${workUnitId}, ${"Machine " + workUnitId}, ${"M" + workUnitId}, ${P_LINE}, 1, 'BAG', 'BAG',
        0,0,0,0,0, ${v.totalOut}, 90, 85,
        0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
        1000, 2000, 3000, 4000, -5000, 6000,
        7, 3, 0, 0
      )
    `;
  }

  it("returns one row per machine, carrying that machine's OWN report id", async () => {
    await machineReport(P_MACHINE_A);
    await machineReport(P_MACHINE_B, { totalOut: 200 });

    const rows = await repo2.listMachineBreakdown("shift", win(), INSTANTS);

    expect(rows).toHaveLength(2);
    // THE DEEP LINK'S TARGET. Every id must be a work_unit_shift_reports id, never
    // the line's — six report tables, six independent sequences.
    expect(rows.every((r) => r.reportId > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.reportId)).size).toBe(2);
    expect(rows.map((r) => r.workUnitId).sort((a, b) => a - b)).toEqual([P_MACHINE_A, P_MACHINE_B]);
  });

  it("carries the six losses and both counts, signs intact", async () => {
    await machineReport(P_MACHINE_A);

    const [row] = await repo2.listMachineBreakdown("shift", win(), INSTANTS);

    expect(row).toMatchObject({
      scheduleLossTime: 1000,
      availabilityLossTime: 2000,
      performanceLossTime: 3000,
      msLossTime: 4000,
      // Negative, and NOT clamped: a machine that outran its standard is real data.
      reduceSpeedLossTime: -5000,
      qualityLossTime: 6000,
      reject: 7,
      rework: 3,
      uomName: "BAG",
    });
  });

  // SCOPED BY THE REPORT ROW'S OWN work_center_id, which is the definition that
  // replaced a roster fetched from mes-master-data. A machine the pipeline
  // attributed to another line does not appear here even if master-data currently
  // lists it on this one — which is the correct answer, because this card is about
  // what rolled into THIS line's report.
  it("excludes a machine the pipeline attributed to another line", async () => {
    await machineReport(P_MACHINE_A);
    await db2`
      UPDATE oee.work_unit_shift_reports SET work_center_id = ${P_LINE + 1}
      WHERE work_unit_id = ${P_MACHINE_A}
    `;
    await machineReport(P_MACHINE_B);

    const rows = await repo2.listMachineBreakdown("shift", win(), INSTANTS);

    expect(rows.map((r) => r.workUnitId)).toEqual([P_MACHINE_B]);
  });

  // AT DAY GRAIN THE ROSTER IS IGNORED, because 0013 put work_center_id on that
  // table — the read is a plain predicate and the empty array below is the coarse
  // grain saying it needs no upstream call.
  it("reads the day table by work_center_id, exactly as the shift table does", async () => {
    await db2`
      INSERT INTO oee.work_unit_day_reports (
        date, business_date, time_zone, work_unit_id, work_unit_name, work_unit_code,
        work_center_id, uom_id, uom_name,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time, reject, rework
      ) VALUES (
        '2026-08-09T00:00:00Z'::timestamptz, '2026-08-09'::date, ${TZ},
        ${P_MACHINE_A}, 'Machine A', 'MA', ${P_LINE}, 1, 'BAG',
        0,0,0,0,0, 500, 480, 470,
        0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
        0,0,0,0,0,0, 0, 0
      )
    `;

    const rows = await repo2.listMachineBreakdown("day", win({ shift: null }), DAY_INSTANTS);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workUnitId: P_MACHINE_A, totalOut: 500 });
  });
});

// ---------------------------------------------------------------------------
// The Losses page's two aggregates, at line scope
// ---------------------------------------------------------------------------
//
// The arithmetic is shared/loss-aggregate.ts's and is covered against the machine
// grain already. WHAT IS NEW HERE IS THE ROW SET: these buckets span several
// machines, so the mixed-unit abstain — a guard that can barely fire at machine
// grain, where one work unit usually has one unit — becomes the ordinary case.
//
// Both tables carry work_center_id, so neither read needs the line's roster. That
// is asserted by the fixtures: nothing below inserts a roster or passes one.
// THIS SUITE MOVED TABLES. It used to insert into oee.reject_count_wu_shift and
// assert that the line's Pareto SUMMED ITS MACHINES — which is what the code did,
// and which was the defect: a line is MEASURED, not summed, so the machines'
// counters are a different measurement from the line's own count points, and the
// Pareto contradicted the Reject tile two cards above it on the same screen.
//
// Migration 0019 gives the line its own table and these now write it. The
// aggregate itself is untouched — it is shared with the machine side and
// parameterised BY A FRAGMENT, so swapping the source changed no arithmetic,
// which is exactly what these assertions still prove.
describe.skipIf(!url)("WorkCenterReportReaderRepository — the Losses aggregates", () => {
  const db3 = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo3 = new WorkCenterReportReaderRepository({ goldDb: db3 });

  const L_LINE = 9501;
  const L_A = 9511;
  const L_B = 9512;

  // EVENT IDS ARE NAMESPACED, because pk_downtime_log_events is `event_id` ALONE —
  // globally unique across the whole test database, which every suite in this repo
  // shares. A bare "e1" collides with work-unit-repository.integration.test.ts's
  // fixture, and the symptom is a duplicate-key error in whichever file runs
  // second. Deleting by id as well as by line covers the same hazard in reverse:
  // that row has no work_center_id, so a delete scoped to this line would miss it.
  const EVENT_IDS = ["wc-e1", "wc-e2"] as const;

  // CLEANED BY THE IDS THIS SUITE OWNS, not by work_center_id. Two cases make that
  // the wrong key: one test RE-PARENTS a row to another line to prove the predicate
  // excludes it, so a line-scoped delete would leave it behind and the next test
  // would hit a duplicate key; and the work-unit suite's own fixture rows carry no
  // work_center_id at all.
  async function clean3() {
    await db3`DELETE FROM oee.reject_count_wc_shift WHERE work_center_id IN (${L_LINE}, ${L_LINE + 1})`;
    await db3`DELETE FROM oee.downtime_log_events WHERE work_unit_id IN (${L_A}, ${L_B})`;
    await db3`DELETE FROM oee.downtime_log_events WHERE event_id IN ${db3(EVENT_IDS)}`;
  }

  beforeEach(clean3);
  afterAll(async () => {
    await clean3();
    await db3.end();
  });

  const w = (over: Record<string, unknown> = {}) => ({
    workCenterId: L_LINE,
    dateFrom: "2026-08-09",
    dateTo: "2026-08-10",
    shift: 1 as number | null,
    timeZone: TZ,
    ...over,
  });

  async function rejectRow(over: Record<string, unknown> = {}) {
    const v = {
      workUnitId: L_A,
      shift: 1,
      shiftDate: "2026-08-09",
      productId: 1,
      workCenterId: L_LINE,
      reason: "Total_NG_Prod",
      uomCode: "BAG",
      baseUomCode: "BAG",
      factor: 1,
      counterValue: 10,
      frequency: 2,
      ...over,
    };
    // THE LINE'S OWN TABLE (0019), not the machines'. `workUnitId` survives in the
    // fixture's shape only as a way to write two DISTINCT rows — this table has no
    // work_unit_id column, deliberately, so it maps to the product instead.
    await db3`
      INSERT INTO oee.reject_count_wc_shift (
        work_center_id, business_date, shift, product_id, reason,
        work_center_name, work_center_code, product_name, product_code, reason_code,
        uom_id, uom_name, uom_code,
        counter_value, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
        weight_gram, frequency, reject_time, time_zone
      ) VALUES (
        ${v.workCenterId}, ${v.shiftDate}::date, ${v.shift}, ${v.productId}, ${v.reason},
        'Molca Line 8', 'L8', 'SKU', 'P1', 'RC1',
        1, ${v.uomCode}, ${v.uomCode},
        ${v.counterValue}, 2, ${v.baseUomCode}, ${v.baseUomCode}, ${v.factor},
        NULL, ${v.frequency}, 0, ${TZ}
      )
    `;
  }

  // ONE REASON ACROSS THE LINE'S OWN COUNT POINTS — two SKUs here, where this
  // once meant two machines. The Pareto groups on the reason, so a reason
  // recorded against several products is one bar.
  it("groups one reason across the SKUs the line ran", async () => {
    await rejectRow({ counterValue: 10, frequency: 2 });
    await rejectRow({ counterValue: 5, frequency: 3, productId: 2 });

    const out = await repo3.aggregateRejectReasons(w());

    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0]).toMatchObject({ reason: "Total_NG_Prod", frequency: 5 });
    expect(out.totalFrequency).toBe(5);
  });

  // THE GUARD THAT ONLY REALLY FIRES AT THIS GRAIN. Two count points on the same
  // line recording the same reason in BAG and CALENDER: `counterValue` would be a
  // sum of unlike things, so the unit comes back NULL and the reader renders the whole
  // cell as an em dash rather than a plausible bare number.
  it("abstains on the counter unit when the line's count points disagree", async () => {
    await rejectRow({ uomCode: "BAG", productId: 1 });
    await rejectRow({ uomCode: "CALENDER", productId: 2 });

    const out = await repo3.aggregateRejectReasons(w());

    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0]?.counterUnit).toBeNull();
  });

  // And it does NOT abstain when they agree — the other half, without which the
  // guard could be "always null" and pass the case above.
  it("names the counter unit when they agree", async () => {
    await rejectRow({ uomCode: "BAG", productId: 1 });
    await rejectRow({ uomCode: "BAG", productId: 2 });

    const out = await repo3.aggregateRejectReasons(w());

    expect(out.buckets[0]?.counterUnit).toBe("BAG");
  });

  // `machineName` comes back as one name via min(), which at line grain names an
  // arbitrary machine out of several. The browser must not present that as "the"
  // machine — it renders the column only at machine grain.
  it("narrows to one shift, ignoring the day's other shifts", async () => {
    await rejectRow({ shift: 1, frequency: 2 });
    await rejectRow({ shift: 2, frequency: 9, productId: 2 });

    expect((await repo3.aggregateRejectReasons(w({ shift: 1 }))).totalFrequency).toBe(2);
  });

  it("widens across a month when no shift is given", async () => {
    await rejectRow({ shiftDate: "2026-08-01", frequency: 1 });
    await rejectRow({ shiftDate: "2026-08-20", frequency: 4, productId: 2 });

    const out = await repo3.aggregateRejectReasons(
      w({ dateFrom: "2026-08-01", dateTo: "2026-09-01", shift: null }),
    );

    expect(out.totalFrequency).toBe(5);
  });

  // WRITTEN DIRECTLY TO THE OTHER LINE now, rather than re-parented afterwards:
  // this table is keyed by work_center_id, so a row belonging to another line is
  // simply a row with a different key rather than a row that moved.
  it("excludes a row belonging to another line", async () => {
    await rejectRow({ workCenterId: L_LINE + 1, frequency: 2 });

    expect((await repo3.aggregateRejectReasons(w())).totalFrequency).toBe(0);
  });

  // ---- the Others tab ------------------------------------------------------

  async function event(eventId: string, reasons: string[], over: Record<string, unknown> = {}) {
    const v = { workUnitId: L_A, shift: 1, shiftDate: "2026-08-09", ...over };
    await db3`
      INSERT INTO oee.downtime_log_events (
        event_id, work_unit_id, shift_date, shift, reasons, category,
        work_unit_name, work_unit_code, work_center_id, work_center_name, time_zone
      ) VALUES (
        ${eventId}, ${v.workUnitId}, ${v.shiftDate}::date, ${v.shift},
        ${reasons}::text[], 'UNPLANNED',
        ${"M" + v.workUnitId}, ${"M" + v.workUnitId}, ${L_LINE}, 'Molca Line 8', ${TZ}
      )
    `;
  }

  it("counts each reason once per event, across the line's machines", async () => {
    await event("wc-e1", ["Mlipit", "Machine_Stop"], { workUnitId: L_A });
    await event("wc-e2", ["Mlipit"], { workUnitId: L_B });

    const out = await repo3.aggregateDowntimeEventReasons(w());

    const byReason = Object.fromEntries(out.buckets.map((b) => [b.reason, b.frequency]));
    expect(byReason.Mlipit).toBe(2);
    expect(byReason.Machine_Stop).toBe(1);
    // Three occurrences over TWO events — the pair of totals that exists precisely
    // because one event can cite several reasons.
    expect(out.totalOccurrences).toBe(3);
    expect(out.totalEvents).toBe(2);
  });

  // A reason repeated INSIDE one event is one event. The DISTINCT in the explode is
  // what enforces it, and the machine side pins the same rule.
  it("counts a reason repeated inside one event only once", async () => {
    await event("wc-e1", ["Mlipit", "Mlipit"]);

    const out = await repo3.aggregateDowntimeEventReasons(w());

    expect(out.buckets[0]).toMatchObject({ reason: "Mlipit", frequency: 1 });
    expect(out.totalEvents).toBe(1);
  });

  // An event with no reason lands in ONE unattributed bucket, keyed NULL — never
  // the string "Unspecified", which the browser applies so a genuine reason of that
  // text cannot merge into it.
  it("folds unattributed events into a single null bucket", async () => {
    await event("wc-e1", []);
    await event("wc-e2", [], { workUnitId: L_B });

    const out = await repo3.aggregateDowntimeEventReasons(w());

    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0]).toMatchObject({ reason: null, frequency: 2 });
  });

  // A BLANK REASON CANNOT EXIST IN THIS TABLE, which is worth pinning here because
  // the explode still wraps the element in `nullif(btrim(...))`. That guard is
  // belt-and-braces, not the thing keeping blanks out — ck_dtle_reasons (0011) is,
  // and this asserts it so nobody removes the guard on the grounds that it never
  // fires, or removes the CHECK on the grounds that the guard covers it.
  it("is refused by the database, not merely by the query, for a blank reason", async () => {
    await expect(event("wc-e1", ["  "])).rejects.toThrow(/ck_dtle_reasons/);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the hourly trendline's two reads (migration 0018)
// ---------------------------------------------------------------------------
//
// Both are arithmetic against a REAL Postgres, which is where the failures live:
//
//   1. THE MONTH PROFILE IS RUNTIME-WEIGHTED, over the runtime that CARRIED a
//      standard. avg() is wrong in the flattering direction, and a month where
//      half the days had no standard must not have its target halved.
//   2. THE UNIT ABSTAINS ON DISAGREEMENT, and count(DISTINCT x) SKIPS NULLs — so
//      the second half of each gate is what stops a confident BAG label over a sum
//      that silently dropped a mixed hour. §16.3(c)'s trap, one table over.
//   3. TWO UNITS PER ROW that must never be plotted against one axis. Nothing here
//      can enforce that, but the read has to CARRY both or the chart cannot.
describe.skipIf(!url)("WorkCenterReportReaderRepository — the hourly trendline", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;
  const repo = new WorkCenterReportReaderRepository({ goldDb: db });

  const PERF_LINE = 9401;

  async function clean() {
    await db`DELETE FROM oee.product_perf_wc_hour WHERE work_center_id = ${PERF_LINE}`;
  }

  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await db.end();
  });

  // One bucket. `hour` is the local clock hour and doubles as the instant offset,
  // which keeps the fixture readable without a second date to track.
  //
  // `=== undefined` THROUGHOUT, NEVER `??`. Every measure here is nullable and
  // NULL is a meaningful value — "the members disagreed", "no standard known" —
  // so `over.totalOut ?? 1000` would turn an explicit null into 1000 and quietly
  // test the opposite case. That cost three failing tests before it was spotted,
  // and the failure was a CHECK violation rather than a wrong assertion, which is
  // the lucky version.
  async function bucket(over: {
    day: string;
    hour: number;
    productId?: number;
    infeed?: string | null;
    output?: string | null;
    totalOut?: number | null;
    effectiveOut?: number | null;
    runtime?: number;
    ideal?: number | null;
  }) {
    const hh = String(over.hour).padStart(2, "0");
    await db`
      INSERT INTO oee.product_perf_wc_hour ${db({
        bucket_start: `${over.day}T${hh}:00:00Z`,
        bucket_end: `${over.day}T${String(over.hour + 1).padStart(2, "0")}:00:00Z`,
        work_center_id: PERF_LINE,
        product_id: over.productId === undefined ? 4 : over.productId,
        business_date: over.day,
        shift: 1,
        hour_of_day: over.hour,
        shift_hour_seq: 0,
        time_zone: "Asia/Jakarta",
        work_center_name: "Line 8",
        work_center_code: "L8",
        product_name: "Kacang",
        product_code: "KG",
        infeed_uom_id: over.infeed === null ? null : 41,
        infeed_uom_code: over.infeed === undefined ? "BAG" : over.infeed,
        output_uom_id: over.output === null ? null : 42,
        output_uom_code: over.output === undefined ? "CTN" : over.output,
        total_out: over.totalOut === undefined ? 1000 : over.totalOut,
        effective_out: over.effectiveOut === undefined ? 80 : over.effectiveOut,
        runtime: over.runtime === undefined ? 3_600_000 : over.runtime,
        ideal_rate_per_hour: over.ideal === undefined ? 100 : over.ideal,
      })}
    `;
  }

  const window = (from: string, to: string, shift: number | null = null) => ({
    workCenterId: PERF_LINE,
    dateFrom: from,
    dateTo: to,
    shift,
    timeZone: "Asia/Jakarta",
  });

  describe("listPerfHours", () => {
    // BOTH UNITS TRAVEL. `totalOut` is infeed and `effectiveOut` is output, and a
    // read that dropped either code would leave the chart unable to tell which
    // series belongs to which axis — which is the whole reason 0018 carries two
    // triples.
    it("carries both units, on the correct sides", async () => {
      await bucket({ day: "2026-08-01", hour: 7 });

      const [row] = await repo.listPerfHours(window("2026-08-01", "2026-08-02"));

      expect(row?.infeedUomCode).toBe("BAG");
      expect(row?.outputUomCode).toBe("CTN");
      expect(row?.totalOut).toBe(1000);
      expect(row?.effectiveOut).toBe(80);
    });

    // HALF-OPEN, so a day's last hour is in and the next day's first is out.
    it("excludes the day after the window", async () => {
      await bucket({ day: "2026-08-01", hour: 7 });
      await bucket({ day: "2026-08-02", hour: 7 });

      const rows = await repo.listPerfHours(window("2026-08-01", "2026-08-02"));

      expect(rows).toHaveLength(1);
    });

    // A NULL STANDARD IS NOT A ZERO. Rendering it as 0 would make the target "make
    // nothing"; the chart omits the series instead.
    it("reports a missing standard as null", async () => {
      await bucket({ day: "2026-08-01", hour: 7, ideal: null, output: null, effectiveOut: null });

      const [row] = await repo.listPerfHours(window("2026-08-01", "2026-08-02"));

      expect(row?.idealRatePerHour).toBeNull();
    });
  });

  describe("listHourProfile", () => {
    // THE WEIGHTING, and the assertion that separates it from an average.
    //
    //   hour 7 on day 1:  rate 100 over 1 hour
    //   hour 7 on day 2:  rate 200 over 3 hours
    //
    //   naive average -> 150
    //   runtime-weighted -> (100*1 + 200*3) / 4 = 175
    //
    // The two differ by 25, which no rounding explains.
    it("weights the standard by runtime rather than averaging it", async () => {
      await bucket({ day: "2026-08-01", hour: 7, ideal: 100, runtime: 3_600_000 });
      await bucket({ day: "2026-08-02", hour: 7, ideal: 200, runtime: 10_800_000 });

      const [row] = await repo.listHourProfile(window("2026-08-01", "2026-09-01"), 7);

      expect(row?.idealRatePerHour).toBe(175);
      expect(row?.idealRatePerHour).not.toBe(150);
    });

    // AND ONLY OVER THE RUNTIME THAT CARRIED ONE. An hour with no standard
    // contributes its output but must not dilute the target — halving it because
    // half the month had no standard is the flattering direction.
    it("ignores runtime that carried no standard", async () => {
      await bucket({ day: "2026-08-01", hour: 7, ideal: 100, runtime: 3_600_000 });
      await bucket({
        day: "2026-08-02",
        hour: 7,
        ideal: null,
        output: null,
        effectiveOut: null,
        runtime: 3_600_000,
      });

      const [row] = await repo.listHourProfile(window("2026-08-01", "2026-09-01"), 7);

      // 100, not 50: the second hour's runtime is out of the denominator.
      expect(row?.idealRatePerHour).toBe(100);
    });

    // THE NULL-SKIPPING TRAP, §16.3(c) one table over. `count(DISTINCT x)` skips
    // NULLs, so a profile hour mixing one abstaining bucket with a BAG one would
    // report a confident BAG over a sum that included both. The second half of the
    // gate — `count(x) = count(*)` — is what stops it.
    it("abstains on the unit when one bucket abstained", async () => {
      await bucket({ day: "2026-08-01", hour: 7, infeed: "BAG", totalOut: 1000 });
      await bucket({ day: "2026-08-02", hour: 7, infeed: null, totalOut: null });

      const [row] = await repo.listHourProfile(window("2026-08-01", "2026-09-01"), 7);

      expect(row?.infeedUomCode).toBeNull();
    });

    // And it abstains on genuine disagreement too — the first half of the gate.
    it("abstains when two buckets disagree on the unit", async () => {
      await bucket({ day: "2026-08-01", hour: 7, infeed: "BAG" });
      await bucket({ day: "2026-08-02", hour: 7, infeed: "CALENDER" });

      const [row] = await repo.listHourProfile(window("2026-08-01", "2026-09-01"), 7);

      expect(row?.infeedUomCode).toBeNull();
    });

    // ORDERED FROM THE PLANT'S DAY START, not from midnight: shift 3 runs
    // 23:00 -> 07:00, so a 0..23 ordering puts the day's first hour last.
    it("orders from the plant's day start rather than from midnight", async () => {
      for (const hour of [23, 7, 3]) await bucket({ day: "2026-08-01", hour });

      const rows = await repo.listHourProfile(window("2026-08-01", "2026-09-01"), 7);

      expect(rows.map((r) => r.hourOfDay)).toEqual([7, 23, 3]);
    });

    // The measures SUM across the days — a clock hour that occurred twice reports
    // both hours' output, which is what makes a profile a profile.
    it("sums the measures across the days that share a clock hour", async () => {
      await bucket({ day: "2026-08-01", hour: 7, totalOut: 1000 });
      await bucket({ day: "2026-08-02", hour: 7, totalOut: 500 });

      const [row] = await repo.listHourProfile(window("2026-08-01", "2026-09-01"), 7);

      expect(row?.totalOut).toBe(1500);
    });
  });
});
