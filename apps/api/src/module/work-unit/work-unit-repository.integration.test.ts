// Integration coverage for the reject and downtime-event aggregates, against a
// REAL Postgres.
//
// Why this file exists, and why the fakeSql suite next to it is not enough:
// `fakeSql` can assert the SQL text and the bound parameters, but never a
// result. Everything this aggregate gets wrong, it gets wrong ARITHMETICALLY —
// a converted quantity that silently reports the raw counter, a weight sum that
// turns "not weighed" into zero, a mixed-unit bucket that adds BAG to CARTON and
// returns a plausible total. None of those throw. They render a Pareto that looks
// entirely reasonable, and no regex would notice.
//
// The three properties worth the price of a container:
//
//   1. converted_value IS the database's arithmetic. The reader must report
//      counter x factor, and must NOT be able to report the counter twice.
//   2. sum(weight_gram) over an all-NULL bucket is NULL, not 0. The screen
//      renders those two differently and only one of them is true.
//   3. The bars sum to their own denominator, for all four measures. The browser
//      divides by the response's totals, so a totals query that selects
//      different rows than the buckets query is a wrong cumulative line.
//
// THE OTHERS TAB'S AGGREGATE IS HERE FOR THE SAME REASON AND DIFFERENT
// PROPERTIES. aggregateDowntimeEventReasons explodes a text[] and counts events
// rather than summing measures, so its failure modes are its own:
//
//   4. The bars sum EXACTLY to total_occurrences, and total_events is a
//      DIFFERENT, smaller number. No regex can see either, and swapping them
//      draws a cumulative line that walks past 100%.
//   5. A reason repeated inside ONE row counts ONCE. Without the reader's
//      DISTINCT the bar is taller and can be RE-RANKED, so the bug renders a
//      different chart rather than merely a different number.
//   6. An event with reasons = '{}' is ONE unattributed bucket AND ONE event. Get
//      the join wrong — inner instead of left — and it is neither, the bars still
//      sum to their own total, the chart still looks right, and only the sentence
//      beside it is wrong. That is the quietest defect in the feature.
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
import {
  WorkUnitReportReaderRepository,
  WorkUnitReportWriterRepository,
} from "./work-unit-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// Shift 3 of business day 2026-08-01 at UTC+7: 23:00 local is 16:00Z the SAME
// day. The shift that crosses midnight, and therefore the one a naive
// business-day conversion gets wrong — which is exactly why the fixture uses it.
const SHIFT_3_START = "2026-08-01T16:00:00Z";
const BUSINESS_DATE = "2026-08-01";

// Sentinels, so this file cleans up after itself without touching seeded rows.
const WORK_UNIT = 4343;
const REPORT_ID = 434_300;

describe.skipIf(!url)(
  "WorkUnitReportReaderRepository.aggregateRejectReasons — real Postgres",
  () => {
    const db = createPostgresDb({
      connectionString: url!,
      max: 2,
      applicationName: "api-integration-test",
    }) as GoldDB;

    const repo = new WorkUnitReportReaderRepository({ goldDb: db });

    async function truncateFixtures() {
      await db`DELETE FROM oee.reject_count_wu_shift WHERE work_unit_id = ${WORK_UNIT}`;
      await db`DELETE FROM oee.work_unit_shift_reports WHERE id = ${REPORT_ID}`;
    }

    afterAll(async () => {
      await truncateFixtures();
      await db.end();
    });

    beforeEach(async () => {
      await truncateFixtures();
      // The report the aggregate joins through. Every measure is zero: this row
      // exists to supply work_unit_id, shift and the shift-start instant, and
      // nothing in this suite reads a figure off it.
      await db`
      INSERT INTO oee.work_unit_shift_reports (
        id, shift, date, work_unit_id, work_center_id, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework
      ) VALUES (
        ${REPORT_ID}, 3, ${SHIFT_3_START}::timestamptz, ${WORK_UNIT}, 1, 1,
        0, 0, 0, 0, 0,
        0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0,
        0, 0, 0,
        0, 0
      )
    `;
    });

    // One reject counter. Defaults describe the design's simplest row — one BAG
    // counting one-to-one — so each test overrides only what it is about.
    async function counter(opts: {
      reason: string;
      productId?: number;
      uomCode?: string;
      counterValue?: number;
      baseUomCode?: string;
      factorToBase?: number;
      weightGram?: number | null;
      frequency?: number;
      rejectTime?: number | null;
    }) {
      await db`
      INSERT INTO oee.reject_count_wu_shift (
        work_unit_id, shift_date, shift, product_id, reason,
        work_unit_name, uom_id, uom_code, counter_value,
        base_uom_id, base_uom_code, factor_to_base,
        weight_gram, frequency, reject_time, time_zone
      ) VALUES (
        ${WORK_UNIT}, ${BUSINESS_DATE}::date, 3, ${opts.productId ?? 1}, ${opts.reason},
        'Vertical Packer N', 1, ${opts.uomCode ?? "BAG"}, ${opts.counterValue ?? 10},
        1, ${opts.baseUomCode ?? "BAG"}, ${opts.factorToBase ?? 1},
        ${opts.weightGram ?? null}, ${opts.frequency ?? 1}, ${opts.rejectTime ?? null},
        ${JAKARTA}
      )
    `;
    }

    const aggregate = () => repo.aggregateRejectReasons(REPORT_ID, JAKARTA);

    // ── the business-day join ────────────────────────────────────────────────

    // THE TEST THAT WOULD CATCH A UTC READING. The report's instant is 16:00Z,
    // whose UTC date is 2026-08-01 and whose Jakarta date is also 2026-08-01 —
    // indistinguishable. So this asserts the OTHER direction: read in a zone where
    // the two differ, the rows must NOT be found.
    it("finds rows through the plant's business day", async () => {
      await counter({ reason: "Total_NG_Prod" });

      expect((await aggregate()).buckets).toHaveLength(1);
    });

    it("finds nothing when the zone puts the shift on another business day", async () => {
      await counter({ reason: "Total_NG_Prod" });

      // 16:00Z is 2026-08-02 01:00 in Tokyo, so the business day moves and the
      // rows keyed on 2026-08-01 must fall outside it.
      const out = await repo.aggregateRejectReasons(REPORT_ID, "Asia/Tokyo");

      expect(out.buckets).toEqual([]);
    });

    // ── the converted quantity ───────────────────────────────────────────────

    // PROPERTY 1. 48 CALENDER at 12 per BAG is 576 BAG, and the two figures must
    // both survive. A reader that reported the counter twice would give 48 and 48.
    it("reports the counter and the converted quantity as different numbers", async () => {
      await counter({
        reason: "NG_Over_Count",
        uomCode: "CALENDER",
        counterValue: 48,
        baseUomCode: "BAG",
        factorToBase: 12,
      });

      const [bucket] = (await aggregate()).buckets;

      expect(bucket?.counterValue).toBe(48);
      expect(bucket?.counterUnit).toBe("CALENDER");
      expect(bucket?.quantity).toBe(576);
      expect(bucket?.convertedUnit).toBe("BAG");
    });

    it("returns both figures as numbers, not the strings postgres sends for numeric", async () => {
      await counter({ reason: "Total_NG_Prod", counterValue: 4776, frequency: 4776 });

      const [bucket] = (await aggregate()).buckets;

      expect(typeof bucket?.counterValue).toBe("number");
      expect(typeof bucket?.quantity).toBe("number");
      expect(typeof bucket?.frequency).toBe("number");
      expect(typeof bucket?.durationMs).toBe("number");
    });

    // ── the weight, and the difference between NULL and 0 ────────────────────

    // PROPERTY 2, and the one most likely to be "fixed" into a bug. An all-NULL
    // bucket must report null so the UI can render an em dash; coalescing it would
    // claim the counter was weighed and found empty.
    it("reports an unweighed counter as null, never as zero", async () => {
      await counter({ reason: "Reject_Count", weightGram: null });

      const [bucket] = (await aggregate()).buckets;

      expect(bucket?.weightGram).toBeNull();
    });

    it("distinguishes a counter weighed at zero from one never weighed", async () => {
      await counter({ reason: "Weighed_Empty", weightGram: 0 });
      await counter({ reason: "Never_Weighed", weightGram: null });

      const out = await aggregate();
      const byReason = new Map(out.buckets.map((b) => [b.reason, b.weightGram]));

      expect(byReason.get("Weighed_Empty")).toBe(0);
      expect(byReason.get("Never_Weighed")).toBeNull();
    });

    // sum() skips nulls, so a bucket that mixes weighed and unweighed products
    // reports the weight it actually has rather than collapsing to null.
    it("sums only the weighed rows when a counter spans several products", async () => {
      await counter({ reason: "NG_Over_Count", productId: 1, weightGram: 15_232 });
      await counter({ reason: "NG_Over_Count", productId: 2, weightGram: null });

      const [bucket] = (await aggregate()).buckets;

      expect(bucket?.weightGram).toBe(15_232);
    });

    it("reports a null weight TOTAL when nothing in the shift was weighed", async () => {
      await counter({ reason: "Total_NG_Prod", weightGram: null });
      await counter({ reason: "Reject_Count", weightGram: null });

      expect((await aggregate()).totalWeightGram).toBeNull();
    });

    // ── the mixed-unit guards ────────────────────────────────────────────────

    // One reason, two products, two sensor units. Summing 48 CALENDER and 10 BAG
    // is meaningless, so the UNIT comes back null and the browser em-dashes the
    // cell rather than rendering a plausible 58.
    it("nulls the counter unit when a bucket's rows disagree about it", async () => {
      await counter({
        reason: "NG_Over_Count",
        productId: 1,
        uomCode: "CALENDER",
        factorToBase: 12,
      });
      await counter({ reason: "NG_Over_Count", productId: 2, uomCode: "BAG", factorToBase: 1 });

      const [bucket] = (await aggregate()).buckets;

      expect(bucket?.counterUnit).toBeNull();
    });

    // Different SENSOR units still convert to one base unit, which is the whole
    // point of the converted column — so `convertedUnit` must survive here.
    it("keeps the converted unit when only the sensor units differ", async () => {
      await counter({
        reason: "NG_Over_Count",
        productId: 1,
        uomCode: "CALENDER",
        factorToBase: 12,
      });
      await counter({ reason: "NG_Over_Count", productId: 2, uomCode: "BAG", factorToBase: 1 });

      const [bucket] = (await aggregate()).buckets;

      expect(bucket?.convertedUnit).toBe("BAG");
    });

    it("nulls the converted unit, per bucket and per shift, when base units differ", async () => {
      await counter({ reason: "NG_Over_Count", productId: 1, baseUomCode: "BAG" });
      await counter({ reason: "NG_Over_Count", productId: 2, baseUomCode: "CARTON" });

      const out = await aggregate();

      expect(out.buckets[0]?.convertedUnit).toBeNull();
      expect(out.convertedUnit).toBeNull();
    });

    it("keeps the shift's converted unit when every counter agrees", async () => {
      await counter({ reason: "Total_NG_Prod", baseUomCode: "BAG" });
      await counter({
        reason: "Reject_Count",
        uomCode: "CALENDER",
        factorToBase: 12,
        baseUomCode: "BAG",
      });

      expect((await aggregate()).convertedUnit).toBe("BAG");
    });

    // ── the totals ───────────────────────────────────────────────────────────

    // PROPERTY 3, for all four measures at once. The browser's cumulative line
    // divides by these totals rather than by the bars it drew, so a totals query
    // that selected different rows would draw a line that never reaches 100%.
    it("keeps every total equal to the sum of the buckets", async () => {
      await counter({
        reason: "NG_Over_Count",
        uomCode: "CALENDER",
        counterValue: 48,
        factorToBase: 12,
        weightGram: 15_232,
        frequency: 48,
        rejectTime: 96_000,
      });
      await counter({
        reason: "NG_Under_Count",
        uomCode: "CALENDER",
        counterValue: 17,
        factorToBase: 12,
        weightGram: 2571,
        frequency: 17,
        rejectTime: 33_000,
      });

      const out = await aggregate();
      const sum = (pick: (b: (typeof out.buckets)[number]) => number | null) =>
        out.buckets.reduce((n, b) => n + (pick(b) ?? 0), 0);

      expect(out.totalQuantity).toBe(sum((b) => b.quantity));
      expect(out.totalFrequency).toBe(sum((b) => b.frequency));
      expect(out.totalDurationMs).toBe(sum((b) => b.durationMs));
      expect(out.totalWeightGram).toBe(sum((b) => b.weightGram));
    });

    it("returns zeroed totals and a null weight rather than nulls when nothing matched", async () => {
      expect(await aggregate()).toEqual({
        buckets: [],
        totalFrequency: 0,
        totalDurationMs: 0,
        totalQuantity: 0,
        totalWeightGram: null,
        convertedUnit: null,
      });
    });

    // reject_time is unwritten everywhere until the DAG measures it, so this is the
    // state the duration ranking is actually in today: a column of zeros, which the
    // browser turns into null percentages rather than NaN.
    it("reports zero duration rather than null when reject_time is unwritten", async () => {
      await counter({ reason: "Total_NG_Prod", rejectTime: null });

      const out = await aggregate();

      expect(out.buckets[0]?.durationMs).toBe(0);
      expect(out.totalDurationMs).toBe(0);
    });

    // ── grouping and order ───────────────────────────────────────────────────

    it("groups one counter's several products into a single bucket", async () => {
      await counter({ reason: "NG_Over_Count", productId: 1, counterValue: 30, frequency: 30 });
      await counter({ reason: "NG_Over_Count", productId: 2, counterValue: 18, frequency: 18 });

      const out = await aggregate();

      expect(out.buckets).toHaveLength(1);
      expect(out.buckets[0]?.counterValue).toBe(48);
      expect(out.buckets[0]?.frequency).toBe(48);
    });

    // Ranked by the CONVERTED quantity, not the raw counter — which is the only
    // ordering that means anything once two counters use different units. Here the
    // raw counters rank the other way round, so a reader ordering by
    // `counter_value` would return these two backwards.
    it("ranks by converted quantity, not by the raw counter", async () => {
      await counter({
        reason: "Small_Counter",
        uomCode: "CALENDER",
        counterValue: 48,
        factorToBase: 12,
      });
      await counter({ reason: "Big_Counter", uomCode: "BAG", counterValue: 100, factorToBase: 1 });

      const out = await aggregate();

      expect(out.buckets.map((b) => b.reason)).toEqual(["Small_Counter", "Big_Counter"]);
      expect(out.buckets.map((b) => b.quantity)).toEqual([576, 100]);
    });

    // A TOTAL order. Without the reason tiebreak two equal counters could swap
    // between identical requests, and the cumulative line is a function of the
    // order — so the chart would move under a user who changed nothing.
    it("breaks ties on the reason, stably across calls", async () => {
      await counter({ reason: "Zebra", counterValue: 10 });
      await counter({ reason: "Alpha", counterValue: 10 });

      const first = (await aggregate()).buckets.map((b) => b.reason);
      const second = (await aggregate()).buckets.map((b) => b.reason);

      expect(first).toEqual(["Alpha", "Zebra"]);
      expect(second).toEqual(first);
    });

    it("carries the machine name onto every bucket", async () => {
      await counter({ reason: "Total_NG_Prod" });

      expect((await aggregate()).buckets[0]?.machineName).toBe("Vertical Packer N");
    });

    it("does not read another work unit's rows", async () => {
      await counter({ reason: "Total_NG_Prod" });
      await db`
      INSERT INTO oee.reject_count_wu_shift (
        work_unit_id, shift_date, shift, product_id, reason,
        work_unit_name, uom_id, uom_code, counter_value,
        base_uom_id, base_uom_code, factor_to_base, frequency, time_zone
      ) VALUES (
        ${WORK_UNIT + 1}, ${BUSINESS_DATE}::date, 3, 1, 'Someone_Else',
        'Other Machine', 1, 'BAG', 999, 1, 'BAG', 1, 999, ${JAKARTA}
      )
    `;

      const out = await aggregate();

      expect(out.buckets.map((b) => b.reason)).toEqual(["Total_NG_Prod"]);
      await db`DELETE FROM oee.reject_count_wu_shift WHERE work_unit_id = ${WORK_UNIT + 1}`;
    });

    it("does not read another shift's rows", async () => {
      await counter({ reason: "Total_NG_Prod" });
      await db`
      INSERT INTO oee.reject_count_wu_shift (
        work_unit_id, shift_date, shift, product_id, reason,
        work_unit_name, uom_id, uom_code, counter_value,
        base_uom_id, base_uom_code, factor_to_base, frequency, time_zone
      ) VALUES (
        ${WORK_UNIT}, ${BUSINESS_DATE}::date, 1, 1, 'Shift_One',
        'Vertical Packer N', 1, 'BAG', 999, 1, 'BAG', 1, 999, ${JAKARTA}
      )
    `;

      expect((await aggregate()).buckets.map((b) => b.reason)).toEqual(["Total_NG_Prod"]);
    });
  },
);

describe.skipIf(!url)("WorkUnitReportReaderRepository.getRejectWatermark — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new WorkUnitReportReaderRepository({ goldDb: db });

  afterAll(async () => {
    await db`DELETE FROM oee.etl_watermarks WHERE table_name = 'reject_count_wu_shift'`;
    await db.end();
  });

  beforeEach(async () => {
    await db`DELETE FROM oee.etl_watermarks WHERE table_name = 'reject_count_wu_shift'`;
  });

  // A MISSING ROW MEANS NEVER LOADED, and today that is every environment: the
  // table ships empty and nothing stamps the watermark until the DAG runs.
  it("answers null when the pipeline has never stamped the table", async () => {
    expect(await repo.getRejectWatermark()).toBeNull();
  });

  it("answers the business day the pipeline last loaded", async () => {
    await db`
      INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
      VALUES ('reject_count_wu_shift', now(), ${BUSINESS_DATE}::date, 4, 'integration-test')
    `;

    expect(await repo.getRejectWatermark()).toBe(BUSINESS_DATE);
  });

  // The CHECK added by 0008 is what makes a mis-named dbt model fail loudly
  // instead of writing a watermark under a key no reader looks at.
  it("rejects a watermark written under a mis-spelled table name", async () => {
    await expect(
      db`
        INSERT INTO oee.etl_watermarks (table_name, last_run_at, writer)
        VALUES ('reject_count_wu_shifts', now(), 'integration-test')
      `,
    ).rejects.toThrow(/ck_etl_watermarks_table/);
  });
});

// ---------------------------------------------------------------------------
// The Others tab's aggregate — the arithmetic, against a real Postgres
// ---------------------------------------------------------------------------
//
// OWN SENTINELS, and not the reject suite's. That suite's beforeEach deletes
// oee.work_unit_shift_reports WHERE id = 434300, so sharing the id would let the
// two blocks delete each other's join anchor mid-run.
const EVENT_WORK_UNIT = 4344;
const EVENT_REPORT_ID = 434_400;

describe.skipIf(!url)(
  "WorkUnitReportReaderRepository.aggregateDowntimeEventReasons — real Postgres",
  () => {
    const db = createPostgresDb({
      connectionString: url!,
      max: 2,
      applicationName: "api-integration-test",
    }) as GoldDB;

    const repo = new WorkUnitReportReaderRepository({ goldDb: db });

    async function truncateFixtures() {
      await db`DELETE FROM oee.downtime_log_events WHERE work_unit_id IN (${EVENT_WORK_UNIT}, ${EVENT_WORK_UNIT + 1})`;
      await db`DELETE FROM oee.work_unit_shift_reports WHERE id = ${EVENT_REPORT_ID}`;
    }

    afterAll(async () => {
      await truncateFixtures();
      await db.end();
    });

    beforeEach(async () => {
      await truncateFixtures();
      // The report the aggregate joins through — shift 3, so the fixture crosses
      // midnight at UTC+7 and a naive business-day conversion fails. Every measure
      // is zero: this row exists to supply work_unit_id, shift and the shift-start
      // instant, and nothing in this suite reads a figure off it.
      await db`
        INSERT INTO oee.work_unit_shift_reports (
          id, shift, date, work_unit_id, work_center_id, uom_id,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time,
          reject, rework
        ) VALUES (
          ${EVENT_REPORT_ID}, 3, ${SHIFT_3_START}::timestamptz, ${EVENT_WORK_UNIT}, 1, 1,
          0, 0, 0, 0, 0,
          0, 0, 0,
          0, 0, 0, 0, 0,
          0, 0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0,
          0, 0, 0,
          0, 0
        )
      `;
    });

    // One logged downtime event.
    //
    // `${opts.reasons}::text[]` — THE CAST IS NOT DECORATION. postgres.js has no
    // element to infer a type from when the array is empty, so an uncast `[]`
    // fails with "cannot determine type of empty array". That failure looks like a
    // migration problem and is not.
    async function event(opts: {
      eventId: string;
      reasons: string[];
      shift?: number;
      workUnitId?: number;
    }) {
      await db`
        INSERT INTO oee.downtime_log_events (
          event_id, work_unit_id, shift_date, shift, reasons, work_unit_name, time_zone
        ) VALUES (
          ${opts.eventId}, ${opts.workUnitId ?? EVENT_WORK_UNIT}, ${BUSINESS_DATE}::date,
          ${opts.shift ?? 3}, ${opts.reasons}::text[], 'Vertical Packer N', ${JAKARTA}
        )
      `;
    }

    function aggregate(timeZone = JAKARTA) {
      return repo.aggregateDowntimeEventReasons(EVENT_REPORT_ID, timeZone);
    }

    // ---- the business-day join -------------------------------------------

    it("finds the shift's events through the plant's business day", async () => {
      await event({ eventId: "it-e1", reasons: ["Machine_Stop"] });

      const out = await aggregate();

      expect(out.buckets).toEqual([{ reason: "Machine_Stop", frequency: 1 }]);
      expect(out.totalOccurrences).toBe(1);
      expect(out.totalEvents).toBe(1);
    });

    // THE SHIFT-3-CROSSING-MIDNIGHT CASE, and the assertion that would catch a UTC
    // reading. 16:00Z on 2026-08-01 is 2026-08-02 01:00 in Tokyo, so the same rows
    // must fall on a different business day and match nothing.
    it("finds nothing when another zone puts the shift on another business day", async () => {
      await event({ eventId: "it-e1", reasons: ["Machine_Stop"] });

      const out = await aggregate("Asia/Tokyo");

      expect(out.buckets).toEqual([]);
      expect(out.totalOccurrences).toBe(0);
      expect(out.totalEvents).toBe(0);
    });

    // ---- the arithmetic, which is why this file exists --------------------

    // The user's own worked example: {A,B} and {B,X,Y} give B a frequency of 2.
    it("counts a reason once per event that cited it", async () => {
      await event({ eventId: "it-e1", reasons: ["reason1", "reason2"] });
      await event({ eventId: "it-e2", reasons: ["reason2", "reasonX", "reasonY"] });

      const out = await aggregate();

      const byReason = new Map(out.buckets.map((b) => [b.reason, b.frequency]));
      expect(byReason.get("reason2")).toBe(2);
      expect(byReason.get("reason1")).toBe(1);
      expect(byReason.get("reasonX")).toBe(1);
      expect(byReason.get("reasonY")).toBe(1);
    });

    // PROPERTY 4. The browser divides by total_occurrences, so a totals statement
    // that selected different rows than the buckets statement is a wrong
    // cumulative line — and it would look entirely reasonable.
    it("makes the bars sum exactly to total_occurrences", async () => {
      await event({ eventId: "it-e1", reasons: ["A", "B"] });
      await event({ eventId: "it-e2", reasons: ["B", "C", "A"] });
      await event({ eventId: "it-e3", reasons: ["A"] });

      const out = await aggregate();

      expect(out.buckets.reduce((n, b) => n + b.frequency, 0)).toBe(out.totalOccurrences);
      expect(out.totalOccurrences).toBe(6);
    });

    // total_events is NOT the denominator, and this is the pair of cases that says
    // the relation is <= rather than <, so nobody "fixes" it into a strict
    // inequality later.
    it("reports fewer events than occurrences when stops cite several reasons", async () => {
      await event({ eventId: "it-e1", reasons: ["A", "B"] });
      await event({ eventId: "it-e2", reasons: ["B", "C", "A"] });
      await event({ eventId: "it-e3", reasons: ["A"] });

      const out = await aggregate();

      expect(out.totalEvents).toBe(3);
      expect(out.totalOccurrences).toBe(6);
      expect(out.totalEvents).toBeLessThan(out.totalOccurrences);
    });

    it("reports equal totals when every stop cites exactly one reason", async () => {
      await event({ eventId: "it-e1", reasons: ["A"] });
      await event({ eventId: "it-e2", reasons: ["B"] });

      const out = await aggregate();

      expect(out.totalEvents).toBe(2);
      expect(out.totalOccurrences).toBe(2);
    });

    // total_events counts the EVENT IDENTITY, not the rows of the explode.
    it("counts one event citing three reasons as one event", async () => {
      await event({ eventId: "it-e1", reasons: ["A", "B", "C"] });

      const out = await aggregate();

      expect(out.totalEvents).toBe(1);
      expect(out.totalOccurrences).toBe(3);
    });

    // PROPERTY 5, first half.
    it("counts a reason duplicated inside one row once", async () => {
      await event({ eventId: "it-e1", reasons: ["Material_Jam", "Material_Jam"] });

      const out = await aggregate();

      expect(out.buckets).toEqual([{ reason: "Material_Jam", frequency: 1 }]);
      expect(out.totalOccurrences).toBe(1);
      expect(out.totalEvents).toBe(1);
    });

    // PROPERTY 5, second half, AND THE ONE WORTH THE CONTAINER. Without the
    // reader's DISTINCT, Material_Jam scores 2, TIES with Machine_Stop, and the
    // reason tiebreak puts it FIRST — so the defect renders a different chart, not
    // merely a different number. A screenshot catches this; a total would not.
    it("does not let a duplicated reason outrank a genuinely more frequent one", async () => {
      await event({ eventId: "it-e1", reasons: ["Machine_Stop"] });
      await event({ eventId: "it-e2", reasons: ["Machine_Stop"] });
      await event({ eventId: "it-e3", reasons: ["Material_Jam", "Material_Jam"] });

      const out = await aggregate();

      expect(out.buckets).toEqual([
        { reason: "Machine_Stop", frequency: 2 },
        { reason: "Material_Jam", frequency: 1 },
      ]);
    });

    // PROPERTY 6. unnest('{}') yields zero rows, so an INNER join would drop these
    // events out of the unattributed bucket AND out of total_events — leaving a
    // chart that still sums to its own denominator and a sentence beside it that
    // lies. `reason` must be NULL and never the string "Unspecified": that label
    // is the browser's, so a genuine reason of that text cannot merge into it.
    it("lands empty reason arrays in one unattributed bucket that still counts as events", async () => {
      await event({ eventId: "it-e1", reasons: [] });
      await event({ eventId: "it-e2", reasons: [] });
      await event({ eventId: "it-e3", reasons: ["Machine_Stop"] });

      const out = await aggregate();

      const unattributed = out.buckets.filter((b) => b.reason === null);
      expect(unattributed).toHaveLength(1);
      expect(unattributed[0]?.frequency).toBe(2);
      expect(out.totalEvents).toBe(3);
      expect(out.totalOccurrences).toBe(3);
    });

    // The positive counterpart to the constraint cases below, so ck_dtle_reasons
    // cannot be tightened into rejecting '{}' without a red test. An unattributed
    // stop is a real stop.
    it("accepts an empty reason array", async () => {
      // not.toThrow(), NOT toBeDefined(): `event` returns Promise<void>, so
      // toBeDefined() asserted against `undefined` and could never pass however
      // the constraint behaved. What this test means is that the INSERT is
      // ACCEPTED, and that is what it now says.
      await expect(event({ eventId: "it-e1", reasons: [] })).resolves.not.toThrow();
    });

    // The blank-element fold in the reader is unreachable from a compliant
    // pipeline, so the honest test is of the thing that makes it unreachable.
    // ck_dtle_reasons calls oee.text_array_has_blank() because a CHECK admits no
    // subquery, and a whitespace-only element is the case the subquery-free
    // formulations miss.
    it("rejects a blank element rather than admitting a second unattributed bucket", async () => {
      await expect(
        event({ eventId: "it-blank", reasons: ["Machine_Stop", "   "] }),
      ).rejects.toThrow(/ck_dtle_reasons/);
    });

    it("rejects a NULL element", async () => {
      await expect(
        event({ eventId: "it-null", reasons: ["Machine_Stop", null as unknown as string] }),
      ).rejects.toThrow(/ck_dtle_reasons/);
    });

    // ---- order ------------------------------------------------------------

    it("ranks by frequency, descending", async () => {
      await event({ eventId: "it-e1", reasons: ["A", "B"] });
      await event({ eventId: "it-e2", reasons: ["A", "B"] });
      await event({ eventId: "it-e3", reasons: ["A"] });

      expect((await aggregate()).buckets.map((b) => b.reason)).toEqual(["A", "B"]);
    });

    // The cumulative line is a function of the order, so two equally frequent
    // reasons must not swap between identical requests.
    it("breaks ties on the reason, stably across identical requests", async () => {
      await event({ eventId: "it-e1", reasons: ["Zebra"] });
      await event({ eventId: "it-e2", reasons: ["Alpha"] });

      const first = (await aggregate()).buckets.map((b) => b.reason);
      const second = (await aggregate()).buckets.map((b) => b.reason);

      expect(first).toEqual(["Alpha", "Zebra"]);
      expect(second).toEqual(first);
    });

    // NULLS LAST is written out in the SQL so this is a decision rather than an
    // accident: among equally frequent reasons the unattributed bucket sorts last.
    it("sorts the unattributed bucket last among ties", async () => {
      await event({ eventId: "it-e1", reasons: [] });
      await event({ eventId: "it-e2", reasons: ["Machine_Stop"] });

      expect((await aggregate()).buckets.map((b) => b.reason)).toEqual(["Machine_Stop", null]);
    });

    // ---- scope ------------------------------------------------------------

    it("does not read another work unit's events", async () => {
      await event({ eventId: "it-other-wu", reasons: ["A"], workUnitId: EVENT_WORK_UNIT + 1 });

      expect((await aggregate()).buckets).toEqual([]);
    });

    it("does not read another shift's events", async () => {
      await event({ eventId: "it-other-shift", reasons: ["A"], shift: 1 });

      expect((await aggregate()).buckets).toEqual([]);
    });

    // ---- empty ------------------------------------------------------------

    // The assertion that count() needs no coalesce: over an empty row set it
    // returns a row containing 0, never NULL.
    it("returns zeroed totals when the shift logged nothing", async () => {
      expect(await aggregate()).toEqual({ buckets: [], totalOccurrences: 0, totalEvents: 0 });
    });
  },
);

describe.skipIf(!url)(
  "WorkUnitReportReaderRepository.getDowntimeEventWatermark — real Postgres",
  () => {
    const db = createPostgresDb({
      connectionString: url!,
      max: 2,
      applicationName: "api-integration-test",
    }) as GoldDB;

    const repo = new WorkUnitReportReaderRepository({ goldDb: db });

    afterAll(async () => {
      await db`DELETE FROM oee.etl_watermarks WHERE table_name = 'downtime_log_events'`;
      await db.end();
    });

    beforeEach(async () => {
      await db`DELETE FROM oee.etl_watermarks WHERE table_name = 'downtime_log_events'`;
    });

    // A MISSING ROW MEANS NEVER LOADED, and today that is every environment: the
    // table ships empty and nothing stamps the watermark until the DAG runs.
    it("answers null when the pipeline has never stamped the log", async () => {
      expect(await repo.getDowntimeEventWatermark()).toBeNull();
    });

    it("answers the business day the pipeline last loaded", async () => {
      await db`
      INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
      VALUES ('downtime_log_events', now(), ${BUSINESS_DATE}::date, 5, 'integration-test')
    `;

      expect(await repo.getDowntimeEventWatermark()).toBe(BUSINESS_DATE);
    });

    // The proof that 0009's widening landed. Without it a renamed-but-not-repointed
    // dbt model would write a watermark under a key no reader looks at, and nothing
    // would fail.
    it("rejects a watermark written under a mis-spelled table name", async () => {
      await expect(
        db`
        INSERT INTO oee.etl_watermarks (table_name, last_run_at, writer)
        VALUES ('downtime_log_event', now(), 'integration-test')
      `,
      ).rejects.toThrow(/ck_etl_watermarks_table/);
    });
  },
);

// The tripwire for the product decision, at the DDL level. No operator mutation
// may EVER target oee.downtime_log_events — an append-only log is the whole
// feature — and 0009's row-level trigger is what will say so if one ever does.
describe.skipIf(!url)("oee.downtime_log_events write audit — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const EVENT_ID = "it-audit-e1";

  afterAll(async () => {
    await db`DELETE FROM oee.downtime_log_events WHERE event_id = ${EVENT_ID}`;
    await db.end();
  });

  it("records the single-column key when a row is updated", async () => {
    await db`DELETE FROM oee.downtime_log_events WHERE event_id = ${EVENT_ID}`;
    await db`
      INSERT INTO oee.downtime_log_events (
        event_id, work_unit_id, shift_date, shift, reasons, work_unit_name, time_zone
      ) VALUES (
        ${EVENT_ID}, ${EVENT_WORK_UNIT}, ${BUSINESS_DATE}::date, 3,
        '{Machine_Stop}'::text[], 'Vertical Packer N', ${JAKARTA}
      )
    `;

    await db`
      UPDATE oee.downtime_log_events
      SET work_unit_name = 'Vertical Packer N (renamed)'
      WHERE event_id = ${EVENT_ID}
    `;

    const rows = await db<{ rowKey: Record<string, unknown> | null }[]>`
      SELECT row_key
      FROM oee.write_audit
      WHERE table_name = 'downtime_log_events' AND operation = 'UPDATE'
      ORDER BY at DESC
      LIMIT 1
    `;

    // `eventId`, NOT `event_id`, and this is a property of the CLIENT rather than
    // of the trigger. `oee.log_write` stores the key as jsonb {"event_id": ...},
    // which is what a psql session sees — but createPostgresDb configures
    // postgres.js with `transform: postgres.camel`, and that transform reaches
    // INTO jsonb values and camelCases their keys on the way out, not just column
    // names.
    //
    // Worth knowing beyond this test: every reader of oee.write_audit.row_key
    // through this client gets camelCased keys, so a query filtering on
    // `row_key ->> 'event_id'` in SQL and one comparing `row.rowKey.event_id` in
    // TypeScript disagree about the same row.
    expect(rows[0]?.rowKey).toEqual({ eventId: EVENT_ID });
  });
});

// ---------------------------------------------------------------------------
// The approval write path — the properties no fake can reach
// ---------------------------------------------------------------------------
//
// The fakeSql suite proves which statements are issued and with what parameters.
// It cannot prove anything about what Postgres DOES with them, and every
// property below is exactly that:
//
//   1. THE APPROVAL SURVIVES A PIPELINE RESTATEMENT. This is the single test
//      that justifies migration 0010's whole design. If approval state were
//      columns on oee.work_unit_shift_reports, a dbt delete+insert would destroy
//      it and re-mint the id, and the report would silently read "open" again.
//   2. A second approve writes ZERO rows and does not overwrite the first
//      approver. Row-count discrimination is what separates 409 from 200, and
//      the ON CONFLICT ... WHERE is what makes it true.
//   3. Two concurrent approves: exactly one wins, with no lock and no duplicate.
//   4. The approvals row and its event row COMMIT TOGETHER. A trail that can
//      disagree with the row it describes is worse than none (TODOS.md §21).
//   5. The CHECK constraints actually reject what 0010 says they reject.
//   6. application_name reverts after COMMIT — without SET LOCAL semantics the
//      pooled connection would mislabel the next read as an operator mutation.
//   7. Neither new table may take an etl_watermarks row. That omission IS the
//      enforcement that dbt must never model them.
const APPROVE_WORK_UNIT = 4344;
const APPROVE_REPORT_ID = 434_400;
const APPROVE_SHIFT_START = "2026-08-02T16:00:00Z";

describe.skipIf(!url)("WorkUnitReportWriterRepository.closeShiftReport — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 4,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const writer = new WorkUnitReportWriterRepository({ goldDb: db });
  const reader = new WorkUnitReportReaderRepository({ goldDb: db });

  async function clean(): Promise<void> {
    await db`DELETE FROM oee.work_unit_shift_report_approval_events WHERE work_unit_id = ${APPROVE_WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${APPROVE_WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = ${APPROVE_WORK_UNIT}`;
  }

  // Inserts the report row and returns its (possibly newly minted) id. Every
  // measure column on oee.work_unit_shift_reports is NOT NULL, so the fixture
  // has to supply them; they are all zero because nothing here reads them.
  async function seedReport(id: number): Promise<number> {
    const rows = await db<{ id: number }[]>`
      INSERT INTO oee.work_unit_shift_reports (
        id, shift, date, work_unit_id, work_unit_name, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework, work_center_id
      ) VALUES (
        ${id}, 3, ${APPROVE_SHIFT_START}::timestamptz, ${APPROVE_WORK_UNIT}, 'Approve Fixture', 1,
        0,0,0,0,0, 0,0,0,
        0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
        0,0,0, 0,0,0,
        0,0, 1
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  beforeEach(async () => {
    await clean();
    await seedReport(APPROVE_REPORT_ID);
  });

  afterAll(async () => {
    await clean();
    await db.end();
  });

  it("closes an open report and records the transition in the same commit", async () => {
    const out = await writer.closeShiftReport({
      reportId: APPROVE_REPORT_ID,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });

    expect(out.kind).toBe("closed");

    const events = await db<
      { fromStatus: string; toStatus: string; bySubject: string; byName: string }[]
    >`
      SELECT from_status, to_status, by_subject, by_name
      FROM oee.work_unit_shift_report_approval_events
      WHERE work_unit_id = ${APPROVE_WORK_UNIT}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: "open",
      toStatus: "closed",
      bySubject: "kc-sub-1",
      // The DISPLAY name has to land too, not just the subject: it is what the
      // Log Activity panel renders, and a row missing it shows a UUID.
      byName: "dewi",
    });
  });

  it("survives the report row being deleted and re-inserted with a NEW id", async () => {
    // THE TEST THIS DESIGN EXISTS FOR.
    //
    // contract §9 prescribes incremental_strategy='delete+insert' to the same DAG
    // for another table, and downtime_reports is already loaded that way. If that
    // ever points at work_unit_shift_reports, this is what happens — and with
    // approval state on the report row it would be silent data loss.
    await writer.closeShiftReport({
      reportId: APPROVE_REPORT_ID,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });

    // The pipeline restates the row. Same natural key, brand new serial id.
    await db`DELETE FROM oee.work_unit_shift_reports WHERE id = ${APPROVE_REPORT_ID}`;
    const rows = await db<{ id: number }[]>`
      INSERT INTO oee.work_unit_shift_reports (
        id, shift, date, work_unit_id, work_unit_name, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework, work_center_id
      ) VALUES (
        ${APPROVE_REPORT_ID + 1}, 3, ${APPROVE_SHIFT_START}::timestamptz, ${APPROVE_WORK_UNIT},
        'Approve Fixture', 1,
        0,0,0,0,0, 0,0,0,
        0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
        0,0,0, 0,0,0,
        0,0, 1
      )
      RETURNING id
    `;
    const newId = rows[0]!.id;
    expect(newId).not.toBe(APPROVE_REPORT_ID);

    // The approval reattaches to the new row, because it was never keyed on the id.
    const report = await reader.getShiftReport(newId);
    expect(report?.approval.status).toBe("closed");
    expect(report?.approval.closedBy).toBe("kc-sub-1");
  });

  it("refuses a second approve without overwriting the first approver", async () => {
    await writer.closeShiftReport({
      reportId: APPROVE_REPORT_ID,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });

    const second = await writer.closeShiftReport({
      reportId: APPROVE_REPORT_ID,
      closedBy: "kc-sub-2",
      closedByName: "bagus",
    });

    expect(second).toEqual({ kind: "already_closed" });

    const rows = await db<{ closedBy: string }[]>`
      SELECT closed_by FROM oee.work_unit_shift_report_approvals
      WHERE work_unit_id = ${APPROVE_WORK_UNIT}
    `;
    expect(rows[0]?.closedBy).toBe("kc-sub-1");

    // And no second event: the transition did not happen.
    const events = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM oee.work_unit_shift_report_approval_events
      WHERE work_unit_id = ${APPROVE_WORK_UNIT}
    `;
    expect(events[0]?.n).toBe(1);
  });

  it("lets exactly one of two concurrent approves win", async () => {
    // They serialise on pk_wu_shift_report_approvals: the loser blocks until the
    // winner commits, then takes the DO UPDATE path whose WHERE now sees
    // 'closed'. No advisory lock, no SELECT-then-INSERT race.
    const [a, b] = await Promise.all([
      writer.closeShiftReport({
        reportId: APPROVE_REPORT_ID,
        closedBy: "kc-sub-1",
        closedByName: "dewi",
      }),
      writer.closeShiftReport({
        reportId: APPROVE_REPORT_ID,
        closedBy: "kc-sub-2",
        closedByName: "bagus",
      }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["already_closed", "closed"]);
  });

  it("reports not_found for an id that names no report", async () => {
    const out = await writer.closeShiftReport({
      reportId: 999_999_999,
      closedBy: "kc-sub-1",
      closedByName: null,
    });
    expect(out).toEqual({ kind: "not_found" });
  });

  it("reverts application_name after the transaction commits", async () => {
    // SET LOCAL semantics. Without them the pooled connection keeps the operator
    // name and mislabels the next read in oee.write_audit.
    await writer.closeShiftReport({
      reportId: APPROVE_REPORT_ID,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });

    const rows = await db<{ name: string }[]>`
      SELECT current_setting('application_name') AS name
    `;
    expect(rows[0]?.name).toBe("api-integration-test");
  });

  it("audits the write under the operator application_name", async () => {
    await writer.closeShiftReport({
      reportId: APPROVE_REPORT_ID,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });

    // The payoff for the distinct name: one query returns every operator write.
    const rows = await db<{ tableName: string }[]>`
      SELECT table_name
      FROM oee.write_audit
      WHERE application_name = 'mes-oee-monitor-operator'
      ORDER BY at DESC
      LIMIT 2
    `;
    expect(rows.map((r) => r.tableName).sort()).toEqual([
      "work_unit_shift_report_approval_events",
      "work_unit_shift_report_approvals",
    ]);
  });
});

describe.skipIf(!url)("oee.work_unit_shift_report_approvals constraints — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const KEY = { wu: 4345, date: "2026-08-03T16:00:00Z", shift: 3 };

  async function insert(cols: Record<string, unknown>): Promise<void> {
    await db`
      INSERT INTO oee.work_unit_shift_report_approvals ${db({
        workUnitId: KEY.wu,
        date: KEY.date,
        shift: KEY.shift,
        ...cols,
      })}
    `;
  }

  beforeEach(async () => {
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${KEY.wu}`;
  });

  afterAll(async () => {
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${KEY.wu}`;
    await db.end();
  });

  it("rejects a status outside the vocabulary", async () => {
    await expect(insert({ status: "archived" })).rejects.toThrow(/ck_wusra_status/);
  });

  it("rejects a closed row that does not say when or how it closed", async () => {
    await expect(insert({ status: "closed" })).rejects.toThrow(/ck_wusra_closed/);
  });

  it("rejects an operator close with no subject", async () => {
    await expect(
      insert({ status: "closed", source: "operator", closedAt: KEY.date }),
    ).rejects.toThrow(/ck_wusra_operator/);
  });

  it("rejects a system close that names a person", async () => {
    // The deferred 14-day sweeper (TODOS.md §31) must not be able to invent an
    // operator to satisfy a NOT NULL.
    await expect(
      insert({ status: "closed", source: "system", closedAt: KEY.date, closedBy: "kc-sub-1" }),
    ).rejects.toThrow(/ck_wusra_system/);
  });

  it("accepts a system close with no subject", async () => {
    // not.toThrow() for the reason the empty-reason test above gives: `insert`
    // returns Promise<void>, so toBeDefined() could never pass. The claim is
    // that ck_wusra_system ADMITS this row, which is the positive counterpart to
    // the four rejections above it.
    await expect(
      insert({ status: "closed", source: "system", closedAt: KEY.date }),
    ).resolves.not.toThrow();
  });

  it("rejects an open row carrying closure facts", async () => {
    await expect(insert({ status: "open", closedBy: "kc-sub-1" })).rejects.toThrow(/ck_wusra_open/);
  });

  it("rejects a shift outside 1..3", async () => {
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${KEY.wu}`;
    await expect(
      db`
        INSERT INTO oee.work_unit_shift_report_approvals (work_unit_id, date, shift, status)
        VALUES (${KEY.wu}, ${KEY.date}::timestamptz, 4, 'open')
      `,
    ).rejects.toThrow(/ck_wusra_shift/);
  });

  it("rejects a transition event that moves nowhere", async () => {
    await expect(
      db`
        INSERT INTO oee.work_unit_shift_report_approval_events
          (work_unit_id, date, shift, by_subject, from_status, to_status, source)
        VALUES (${KEY.wu}, ${KEY.date}::timestamptz, 3, 'kc-sub-1', 'closed', 'closed', 'operator')
      `,
    ).rejects.toThrow(/ck_wusrae_moves/);
  });

  it("refuses an etl_watermarks row for either approval table", async () => {
    // THE OMISSION IS THE ENFORCEMENT. 0010 deliberately does NOT extend
    // ck_etl_watermarks_table, so a dbt model named after either table fails its
    // post-hook loudly rather than quietly writing a table this service owns.
    for (const table of [
      "work_unit_shift_report_approvals",
      "work_unit_shift_report_approval_events",
    ]) {
      // `last_run_at` IS SUPPLIED, and that is the whole correction here. It is
      // NOT NULL, so the previous version of this INSERT was rejected by the NOT
      // NULL constraint before it ever reached ck_etl_watermarks_table — the test
      // passed while proving nothing about the check it names. A dbt post-hook
      // always writes last_run_at (contract §4 quotes the statement), so this now
      // mirrors what the pipeline would actually send.
      await expect(
        db`
          INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, writer)
          VALUES (${table}, now(), '2026-08-01'::date, 'dbt')
        `,
      ).rejects.toThrow(/ck_etl_watermarks_table/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reopen, and the two reads the downtime edit added
// ─────────────────────────────────────────────────────────────────────────────
//
// THE MOST IMPORTANT ASSERTION IN THIS CHANGE IS IN HERE, and it is not the
// obvious one. The freeze resolves reports by OVERLAP and then looks their
// approvals up on (work_unit_id, date, shift). Both tables document `date` as the
// shift's START INSTANT — but if they ever disagreed by even a second, the
// approval would simply not be found, the report would read `open`, and an
// APPROVED REPORT WOULD BECOME SILENTLY EDITABLE. Nothing would error. No unit
// test could see it. So the cross-table match is asserted directly, over real
// rows, rather than assumed.
// 4346, NOT 4345: the approvals-constraints suite above already owns 4345, and
// its beforeEach deletes every approval row for that work unit. Sharing the id
// would let one suite's cleanup delete the other's fixture — the same collision
// the comment above EVENT_WORK_UNIT warns about for report ids.
const FREEZE_WORK_UNIT = 4346;
const FREEZE_REPORT_BASE = 434_600;
// Shift 2 (15:00-23:00 local, UTC+7) and shift 3 (23:00-07:00) on 2026-08-02, as
// START INSTANTS. Adjacent, so a stop crossing 23:00 local touches both.
const SHIFT2_START = "2026-08-02T08:00:00Z";
const SHIFT3_START = "2026-08-02T16:00:00Z";
const JAKARTA = "Asia/Jakarta";

describe.skipIf(!url)("the downtime-edit freeze, against a real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 4,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const reader = new WorkUnitReportReaderRepository({ goldDb: db });
  const writer = new WorkUnitReportWriterRepository({ goldDb: db });

  const EVENT = "evt-freeze-1";

  async function clean(): Promise<void> {
    await db`DELETE FROM oee.work_unit_shift_report_approval_events WHERE work_unit_id = ${FREEZE_WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${FREEZE_WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = ${FREEZE_WORK_UNIT}`;
    await db`DELETE FROM oee.downtime_reports WHERE work_unit_id = ${FREEZE_WORK_UNIT}`;
    await db`DELETE FROM oee.downtime_report_history WHERE source_event_id = ${EVENT}`;
  }

  // Both shifts of one day, so the straddle case has two reports to land on.
  async function seedShifts(): Promise<void> {
    for (const [offset, shift, start] of [
      [0, 2, SHIFT2_START],
      [1, 3, SHIFT3_START],
    ] as const) {
      await db`
        INSERT INTO oee.work_unit_shift_reports (
          id, shift, date, work_unit_id, work_unit_name, uom_id,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time,
          reject, rework, work_center_id
        ) VALUES (
          ${FREEZE_REPORT_BASE + offset}, ${shift}, ${start}::timestamptz,
          ${FREEZE_WORK_UNIT}, 'Freeze Fixture', 1,
          0,0,0,0,0, 0,0,0,
          0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
          0,0,0, 0,0,0,
          0,0, 1
        )
      `;
    }
  }

  // A stop crossing 23:00 local — 15:40Z to 16:20Z is 22:40 to 23:20 at UTC+7 —
  // so it belongs to shift 2 AND shift 3. `date` is shift 2's start instant,
  // which is what makes reading only the stop's own triple insufficient.
  async function seedStraddlingStop(): Promise<void> {
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, shift, start_at, end_at,
         work_center_id, source_event_id, actions)
      VALUES (
        ${db.json(["Machine_Stop"])}, 'UNPLANNED'::oee.operation_type,
        ${FREEZE_WORK_UNIT}, 2,
        '2026-08-02T15:40:00Z', '2026-08-02T16:20:00Z',
        1, ${EVENT}, ${db.json([])}
      )
    `;
  }

  async function approve(shift: number, start: string): Promise<void> {
    await db`
      INSERT INTO oee.work_unit_shift_report_approvals
        (work_unit_id, date, shift, status, source, closed_at, closed_by, closed_by_name)
      VALUES (
        ${FREEZE_WORK_UNIT}, ${start}::timestamptz, ${shift},
        'closed', 'operator', now(), 'kc-sub-1', 'dewi'
      )
    `;
  }

  function overlapping(endAt: Date | null = new Date("2026-08-02T16:20:00Z")) {
    return reader.listApprovalsOverlapping({
      workUnitId: FREEZE_WORK_UNIT,
      startAt: new Date("2026-08-02T15:40:00Z"),
      endAt,
      timeZone: JAKARTA,
    });
  }

  beforeEach(async () => {
    await clean();
    await seedShifts();
  });

  afterAll(async () => {
    await clean();
    await db.end();
  });

  // THE STRADDLE. Both shifts come back, because the stop covers both.
  it("returns EVERY shift a straddling stop overlaps", async () => {
    const rows = await overlapping();

    expect(rows.map((r) => r.shift)).toEqual([2, 3]);
  });

  // 0010: the ABSENCE of a row means open. Reading the approvals table alone
  // would return nothing here and the freeze would see no reports at all.
  it("reports a shift with no approval row as open", async () => {
    const rows = await overlapping();

    expect(rows.every((r) => r.status === "open")).toBe(true);
  });

  // THE CROSS-TABLE MATCH. If work_unit_shift_reports.date and the approvals
  // table's `date` disagreed by any amount, this would come back 'open' and an
  // approved report would be silently editable.
  it("finds the approval of the stop's OWN shift", async () => {
    await approve(2, SHIFT2_START);

    const rows = await overlapping();

    expect(rows.find((r) => r.shift === 2)?.status).toBe("closed");
  });

  // THE ASSERTION THAT WOULD HAVE FAILED UNDER THE REJECTED DESIGN. Shift 3 is
  // approved; the stop's own shift is 2 and is open. Resolving the report from the
  // stop's own (work_unit_id, date, shift) would report everything open and let
  // the edit rewrite a signed-off shift's availability loss.
  it("finds the approval of a shift the stop merely STRADDLES", async () => {
    await approve(3, SHIFT3_START);

    const rows = await overlapping();

    expect(rows.find((r) => r.shift === 2)?.status).toBe("open");
    expect(rows.find((r) => r.shift === 3)?.status).toBe("closed");
  });

  // The half-open rule, from the excluded side: a stop ending exactly at shift
  // 3's start does not reach into shift 3.
  it("excludes a shift the stop ends exactly at", async () => {
    const rows = await reader.listApprovalsOverlapping({
      workUnitId: FREEZE_WORK_UNIT,
      startAt: new Date("2026-08-02T15:40:00Z"),
      endAt: new Date(SHIFT3_START),
      timeZone: JAKARTA,
    });

    expect(rows.map((r) => r.shift)).toEqual([2]);
  });

  // An open stop is `infinity` to every read path. Bounded here, or one approval
  // anywhere would freeze it forever — and a long-open stop is the one most likely
  // to need its category corrected.
  it("includes later shifts for an open stop, but does not run away", async () => {
    const rows = await overlapping(null);

    // Both of the day's seeded shifts, and nothing invented beyond them.
    expect(rows.map((r) => r.shift)).toEqual([2, 3]);
  });

  // The staleness read, over the same stop set the activity feed uses.
  describe("getCategoryEditedAt", () => {
    // Shift 3's window in instants: 16:00Z to 2026-08-03T00:00Z.
    const SHIFT3_WINDOW = {
      workUnitId: FREEZE_WORK_UNIT,
      from: new Date(SHIFT3_START),
      to: new Date("2026-08-03T00:00:00Z"),
    };

    async function historyRow(field: string, at: string): Promise<void> {
      await db`
        INSERT INTO oee.downtime_report_history
          (source_event_id, changed_at, changed_by, field, old_value, new_value)
        VALUES (${EVENT}, ${at}::timestamptz, 'kc-sub-1', ${field},
                ${db.json("UNPLANNED")}, ${db.json("PLANNED")})
      `;
    }

    it("reports null when nothing has been edited", async () => {
      await seedStraddlingStop();

      expect(await reader.getCategoryEditedAt(SHIFT3_WINDOW)).toBeNull();
    });

    // THE STRADDLE, from the staleness side: the stop's `date` is shift 2's, but
    // it overlaps shift 3 — so shift 3's banner has to see the edit too. Getting
    // this wrong leaves the neighbouring report showing stale tiles with no
    // signal at all.
    it("sees an edit to a stop that merely straddles this shift", async () => {
      await seedStraddlingStop();
      await historyRow("category", "2026-08-02T17:00:00Z");

      const at = await reader.getCategoryEditedAt(SHIFT3_WINDOW);

      expect(at).toEqual(new Date("2026-08-02T17:00:00Z"));
    });

    // Only `category` can invalidate the precomputed aggregates. The other three
    // are read live, so an edit to them is already on screen.
    it("ignores edits to the three fields that are read live", async () => {
      await seedStraddlingStop();
      for (const field of ["reason", "actions", "detail_reason"]) {
        await historyRow(field, "2026-08-02T17:00:00Z");
      }

      expect(await reader.getCategoryEditedAt(SHIFT3_WINDOW)).toBeNull();
    });

    it("reports the LATEST category edit when there are several", async () => {
      await seedStraddlingStop();
      await historyRow("category", "2026-08-02T17:00:00Z");
      await historyRow("category", "2026-08-02T19:30:00Z");

      expect(await reader.getCategoryEditedAt(SHIFT3_WINDOW)).toEqual(
        new Date("2026-08-02T19:30:00Z"),
      );
    });
  });

  describe("reopenShiftReport", () => {
    const REPORT = FREEZE_REPORT_BASE + 1;

    function approvalRow() {
      return db<
        {
          status: string;
          closedAt: Date | null;
          closedBy: string | null;
          closedByName: string | null;
          source: string | null;
        }[]
      >`
        SELECT status, closed_at, closed_by, closed_by_name, source
        FROM oee.work_unit_shift_report_approvals
        WHERE work_unit_id = ${FREEZE_WORK_UNIT} AND shift = 3
      `;
    }

    it("clears all four closure columns and records the reverse transition", async () => {
      await approve(3, SHIFT3_START);

      const out = await writer.reopenShiftReport({
        reportId: REPORT,
        closedBy: "kc-sub-2",
        closedByName: "budi",
      });

      expect(out.kind).toBe("reopened");
      // ck_wusra_open would have REJECTED the row otherwise, so reaching this
      // assertion at all is most of the proof.
      expect((await approvalRow())[0]).toEqual({
        status: "open",
        closedAt: null,
        closedBy: null,
        closedByName: null,
        source: null,
      });

      const events = await db<{ fromStatus: string; toStatus: string; bySubject: string }[]>`
        SELECT from_status, to_status, by_subject
        FROM oee.work_unit_shift_report_approval_events
        WHERE work_unit_id = ${FREEZE_WORK_UNIT} AND shift = 3
      `;
      expect(events).toEqual([
        // The only durable record of who undid somebody else's sign-off.
        { fromStatus: "closed", toStatus: "open", bySubject: "kc-sub-2" },
      ]);
    });

    // Both "the row says open" and "there is no row at all" are the same claim —
    // 0010 — so both are this outcome, and neither writes an event.
    it.each([
      ["there is no approval row", false],
      ["the report is already open", true],
    ])("reports already_open when %s", async (_label, seedOpen) => {
      if (seedOpen) {
        await db`
          INSERT INTO oee.work_unit_shift_report_approvals (work_unit_id, date, shift, status)
          VALUES (${FREEZE_WORK_UNIT}, ${SHIFT3_START}::timestamptz, 3, 'open')
        `;
      }

      const out = await writer.reopenShiftReport({
        reportId: REPORT,
        closedBy: "kc-sub-2",
        closedByName: "budi",
      });

      expect(out).toEqual({ kind: "already_open" });
      const events = await db`
        SELECT 1 FROM oee.work_unit_shift_report_approval_events
        WHERE work_unit_id = ${FREEZE_WORK_UNIT}
      `;
      expect(events).toHaveLength(0);
    });

    it("reports not_found for an unknown report", async () => {
      const out = await writer.reopenShiftReport({
        reportId: 999_999,
        closedBy: "kc-sub-2",
        closedByName: "budi",
      });

      expect(out).toEqual({ kind: "not_found" });
    });

    // approve -> reopen -> approve, which is the loop the downtime-edit freeze
    // makes load-bearing: correcting a stop on a signed-off report REQUIRES it.
    it("round-trips: an approved report can be reopened and approved again", async () => {
      await approve(3, SHIFT3_START);
      await writer.reopenShiftReport({ reportId: REPORT, closedBy: "b", closedByName: null });

      const again = await writer.closeShiftReport({
        reportId: REPORT,
        closedBy: "kc-sub-3",
        closedByName: "sari",
      });

      expect(again.kind).toBe("closed");
      expect((await approvalRow())[0]).toMatchObject({ status: "closed", closedBy: "kc-sub-3" });
      // Every transition is in the trail, which is what makes an
      // edit-after-approval visible rather than merely permitted.
      const events = await db<{ toStatus: string }[]>`
        SELECT to_status FROM oee.work_unit_shift_report_approval_events
        WHERE work_unit_id = ${FREEZE_WORK_UNIT} AND shift = 3
        ORDER BY at ASC, id ASC
      `;
      expect(events.map((e) => e.toStatus)).toEqual(["open", "closed"]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// paginateShiftReport — the aliasing pass, and the status filter's polarity
// ─────────────────────────────────────────────────────────────────────────────
//
// THIS SUITE EXISTS BECAUSE fakeSql CANNOT SEE THE BUG IT GUARDS. TODOS.md §36
// stated the hazard before the work started and it was accurate: the status filter
// has to correlate a subquery against the report row, which forces an ALIAS onto
// oee.work_unit_shift_reports — and the moment that alias exists, every bare
// `shift`, `date`, `id` and `oee` reference in periodFilter, shiftSql, workUnitSql,
// hideZeroSql, the SELECT list and the ORDER BY is a runtime error waiting to fire.
// The month-only branch was worse than bare: it qualified with the FULL TABLE NAME
// (`work_unit_shift_reports.date`), which an alias replaces outright.
//
// fakeSql matches SQL TEXT and never executes it, so the whole unit suite stays
// green while the hottest page in the app 500s. Hence: one case per periodFilter
// branch, executed.
//
// THE POLARITY IS THE OTHER HALF, and it is not symmetric. 0010's rule is that the
// ABSENCE of an approval row means open, so `open` must be NOT EXISTS(closed) and
// never EXISTS(open) — the latter reads correctly, passes review, and hides every
// report nobody has ever touched, which is nearly all of them. Its failure is a
// SHORTER list, not an error.
const LIST_WORK_UNIT = 4347;
const LIST_REPORT_BASE = 434_700;

describe.skipIf(!url)("paginateShiftReport against a real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new WorkUnitReportReaderRepository({ goldDb: db });

  // Three reports on distinct months and years, so every periodFilter branch has
  // something to include AND something to exclude.
  //
  // `area` is on them for the same reason `shift` and `oee` are: so the area
  // filter has something to include AND something to exclude. Two of the three
  // sit in area 41 and one in 42, which is what makes an area-filtered page
  // distinguishable from an unfiltered one — a fixture where every row shared an
  // area would pass whether or not the predicate was applied at all.
  const REPORTS = [
    { offset: 0, shift: 1, at: "2026-08-09T00:00:00Z", oee: 82.5, area: 41 },
    { offset: 1, shift: 2, at: "2026-07-09T08:00:00Z", oee: 0, area: 41 },
    { offset: 2, shift: 3, at: "2025-08-09T16:00:00Z", oee: 91.25, area: 42 },
  ] as const;

  async function clean(): Promise<void> {
    await db`DELETE FROM oee.work_unit_shift_report_approvals WHERE work_unit_id = ${LIST_WORK_UNIT}`;
    await db`DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = ${LIST_WORK_UNIT}`;
  }

  beforeEach(async () => {
    await clean();
    for (const r of REPORTS) {
      await db`
        INSERT INTO oee.work_unit_shift_reports (
          id, shift, date, work_unit_id, work_unit_name, uom_id,
          teep, oee, availability, performance, quality,
          total_out, good_out, effective_out,
          runtime, availability_time, production_time, pdt_time, operating_time,
          updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
          rework_time, reject_time, anomaly_time, up_speed_time,
          schedule_loss_time, availability_loss_time, performance_loss_time,
          ms_loss_time, reduce_speed_loss_time, quality_loss_time,
          reject, rework, work_center_id, area_id
        ) VALUES (
          ${LIST_REPORT_BASE + r.offset}, ${r.shift}, ${r.at}::timestamptz,
          ${LIST_WORK_UNIT}, 'List Fixture', 1,
          0, ${r.oee}, 0, 0, 0, 0,0,0,
          0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
          0,0,0, 0,0,0,
          0,0, 1, ${r.area}
        )
      `;
    }
  });

  afterAll(async () => {
    await clean();
    await db.end();
  });

  async function approve(offset: number): Promise<void> {
    const r = REPORTS[offset]!;
    await db`
      INSERT INTO oee.work_unit_shift_report_approvals
        (work_unit_id, date, shift, status, source, closed_at, closed_by)
      VALUES (${LIST_WORK_UNIT}, ${r.at}::timestamptz, ${r.shift},
              'closed', 'operator', now(), 'kc-sub-1')
    `;
  }

  function page(filter: Record<string, unknown>) {
    return repo.paginateShiftReport({
      limit: 50,
      offset: 0,
      filter: { workUnitIds: [LIST_WORK_UNIT], ...filter },
    });
  }

  // An explicit comparator, not the default: Array.prototype.sort coerces to
  // string, so 434700 and 4347000 would order lexicographically. Harmless with
  // these three ids and wrong the moment somebody adds a fourth.
  const ids = (out: { items: { id: number }[] }) =>
    out.items.map((i) => i.id).sort((a, b) => a - b);

  // ---- the aliasing pass: one case per periodFilter branch --------------------
  //
  // Each of these would have thrown "invalid reference to FROM-clause entry" or
  // "column reference is ambiguous" against the pre-alias SQL, and none of them
  // would have failed in the unit suite.

  it("runs with no period filter at all", async () => {
    const out = await page({});
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 1, LIST_REPORT_BASE + 2]);
    expect(out.totalElements).toBe(3);
  });

  it("runs the month-AND-year branch", async () => {
    const out = await page({ month: 8, year: 2026 });
    expect(ids(out)).toEqual([LIST_REPORT_BASE]);
    expect(out.totalElements).toBe(1);
  });

  it("runs the year-only branch", async () => {
    const out = await page({ year: 2026 });
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 1]);
  });

  // THE ONE THAT WAS ACTUALLY BROKEN BY THE ALIAS. This branch used to read
  // `extract(month from work_unit_shift_reports.date)`, and aliasing the table
  // makes the full name an invalid reference — not ambiguous, outright rejected.
  it("runs the month-only branch, across years", async () => {
    const out = await page({ month: 8 });
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 2]);
  });

  // ---- the AREA filter, against the column 0028 added ------------------------
  //
  // WHY THIS IS HERE AND NOT ONLY IN THE UNIT SUITE. `fakeSql` matches SQL text
  // and never executes it, so it cannot tell `r.area_id` from a column that does
  // not exist, nor from one on a table this query does not join. Migration 0028
  // is what put `area_id` on oee.work_unit_shift_reports; before it, every
  // assertion in the unit file passed and this endpoint 500'd on the first
  // area-filtered request — which, since the browser now sends the filter on
  // EVERY report request, is every request.

  it("narrows the page and the count to one area", async () => {
    const out = await page({ areaId: 41 });
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 1]);
    // The count has to move WITH the page. A predicate applied to one and not the
    // other is a pager that promises three rows and shows two — which reads as a
    // list that ran out early rather than as a bug.
    expect(out.totalElements).toBe(2);
  });

  it("narrows to the other area, so the filter is not a no-op", async () => {
    const out = await page({ areaId: 42 });
    expect(ids(out)).toEqual([LIST_REPORT_BASE + 2]);
    expect(out.totalElements).toBe(1);
  });

  // AN UNKNOWN AREA IS AN EMPTY PAGE, NOT A 404 AND NOT AN UNFILTERED ONE.
  // `area_id` is a plain predicate here, exactly as `work_center_id` is on
  // /work-centers/* — there is no id list to be dropped as "no filter", so the
  // guard that motivates /work-units/*'s 404 (TODOS §54) has nothing to guard.
  it("answers an unknown area with an empty page", async () => {
    const out = await page({ areaId: 999 });
    expect(out.items).toEqual([]);
    expect(out.totalElements).toBe(0);
  });

  // THE SILENT EXCLUSION, PINNED AS CORRECT BEHAVIOUR — TODOS §78.
  //
  // A row the pipeline has not attributed to an area appears in an UNFILTERED
  // list and in NO area's list. That is denormalisation lag rather than an
  // attribution gap (the area IS derivable from work_unit_id, permanently), so
  // the fix is a backfill upstream and not an `unattributed` count on the
  // payload the way 0020's product_id needs one. It is pinned here because the
  // difference between "this area was idle" and "the label has not landed" is
  // invisible on screen, and a future edit that made NULLs fall through to every
  // area would look like an improvement.
  it("excludes a row with a NULL area_id from every area, but not from an unfiltered page", async () => {
    await db`
      INSERT INTO oee.work_unit_shift_reports (
        id, shift, date, work_unit_id, work_unit_name, uom_id,
        teep, oee, availability, performance, quality,
        total_out, good_out, effective_out,
        runtime, availability_time, production_time, pdt_time, operating_time,
        updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
        rework_time, reject_time, anomaly_time, up_speed_time,
        schedule_loss_time, availability_loss_time, performance_loss_time,
        ms_loss_time, reduce_speed_loss_time, quality_loss_time,
        reject, rework, work_center_id, area_id
      ) VALUES (
        ${LIST_REPORT_BASE + 3}, 1, '2026-08-10T00:00:00Z'::timestamptz,
        ${LIST_WORK_UNIT}, 'Unattributed Fixture', 1,
        0, 50, 0, 0, 0, 0,0,0,
        0,0,0,0,0, 0,0,0,0,0, 0,0,0,0,
        0,0,0, 0,0,0,
        0,0, 1, NULL
      )
    `;

    expect(ids(await page({}))).toContain(LIST_REPORT_BASE + 3);
    expect(ids(await page({ areaId: 41 }))).not.toContain(LIST_REPORT_BASE + 3);
    expect(ids(await page({ areaId: 42 }))).not.toContain(LIST_REPORT_BASE + 3);
  });

  // The two axes are independent: a page can be narrowed to one line inside the
  // selected area. `work_unit_id IN (...)` and `area_id = $` have to compose.
  it("applies the area filter alongside the work-unit id list and a period", async () => {
    const out = await page({ areaId: 41, year: 2026, month: 8 });
    expect(ids(out)).toEqual([LIST_REPORT_BASE]);
  });

  it("runs shift, work-unit and hide-zero together with a period", async () => {
    const out = await page({ year: 2026, shift: 1, isHideZero: true });
    expect(ids(out)).toEqual([LIST_REPORT_BASE]);
  });

  // hideZeroSql on its own: report +1 has oee = 0 and must drop out.
  it("runs hide-zero against the aliased column", async () => {
    const out = await page({ isHideZero: true });
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 2]);
  });

  // ---- the status filter, and its polarity ------------------------------------

  // THE ASSERTION THE WHOLE POLARITY ARGUMENT RESTS ON. No approval rows exist at
  // all, so every report is open — and `EXISTS (... status = 'open')` would return
  // NOTHING here while looking perfectly reasonable.
  it("treats a report with NO approval row as open", async () => {
    const out = await page({ status: "open" });
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 1, LIST_REPORT_BASE + 2]);
    expect(out.totalElements).toBe(3);
  });

  it("excludes an approved report from status=open", async () => {
    await approve(0);
    const out = await page({ status: "open" });
    expect(ids(out)).toEqual([LIST_REPORT_BASE + 1, LIST_REPORT_BASE + 2]);
    expect(out.totalElements).toBe(2);
  });

  it("returns only approved reports for status=closed", async () => {
    await approve(0);
    await approve(2);
    const out = await page({ status: "closed" });
    expect(ids(out)).toEqual([LIST_REPORT_BASE, LIST_REPORT_BASE + 2]);
    expect(out.totalElements).toBe(2);
  });

  // An explicitly-open row is the same as no row, which is what ck_wusra_open
  // makes possible — a reopened report keeps its row with status 'open'.
  it("treats an explicitly reopened row as open", async () => {
    await db`
      INSERT INTO oee.work_unit_shift_report_approvals (work_unit_id, date, shift, status)
      VALUES (${LIST_WORK_UNIT}, ${REPORTS[0].at}::timestamptz, ${REPORTS[0].shift}, 'open')
    `;

    expect(ids(await page({ status: "open" }))).toContain(LIST_REPORT_BASE);
    expect(ids(await page({ status: "closed" }))).not.toContain(LIST_REPORT_BASE);
  });

  it("omits the predicate entirely when no status is given", async () => {
    await approve(0);
    expect(ids(await page({}))).toHaveLength(3);
  });

  // The count query and the page query must agree — they share one fragment
  // instance each, and a semi-join that duplicated rows would break the count
  // without breaking the page.
  it("keeps totalElements in step with the filtered page", async () => {
    await approve(0);
    const out = await page({ status: "open", year: 2026 });
    expect(out.items).toHaveLength(1);
    expect(out.totalElements).toBe(1);
  });

  it("combines status with a period filter", async () => {
    await approve(0);
    expect(ids(await page({ status: "closed", year: 2026 }))).toEqual([LIST_REPORT_BASE]);
    expect(ids(await page({ status: "closed", year: 2025 }))).toEqual([]);
  });
});
