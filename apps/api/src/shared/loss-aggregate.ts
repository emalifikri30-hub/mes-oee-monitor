import { traced } from "./database/postgres.js";

import type { GoldDB } from "./database/postgres.js";
import type { Fragment } from "postgres";

// THE TWO LOSSES-PAGE AGGREGATES, once, for both subjects.
//
// LIFTED OUT OF work-unit-repository.ts when the LINE report's Losses page needed
// the identical arithmetic over a different row set. That is the rule this
// directory exists for and that shift-window.ts, actor.ts and report-filter-dto.ts
// each record: a thing moves here the moment a SECOND caller appears, because
// modules never import each other's internals — and a copy would be a second
// place for the guards below to drift.
//
// IT WAS ALREADY A MOVE RATHER THAN A REWRITE, and that is not luck. Both were
// written to take their row source AS A FRAGMENT — `scoped` and `pairs` — so the
// machine and the line differ only in a WHERE clause. Everything hard is in here
// and is untouched by the move:
//
//   * the mixed-unit abstain: a bucket whose rows disagree about a unit reports
//     NULL for the unit AND lets the caller render the whole cell as an em dash,
//     rather than summing unlike things into a plausible bare number. That guard
//     BITES FAR MORE OFTEN at line grain, where the rows come from several
//     machines, and that is correct rather than a regression.
//   * `count(*)` and not `count(reason)`: counting the column skips nulls and
//     reports 0 for the unattributed bucket.
//   * which sums are coalesced and which are not — `weight_gram` deliberately
//     stays NULL so "not weighed" and "weighed nothing" stay different answers.
//
// THE db IS A PARAMETER, not a closure over a repository. Both callers hold their
// own GoldDB, and a shared instance here would be a second connection pool in a
// file that has no reason to own one.

// ---------------------------------------------------------------------------
// The shapes, which moved with the functions
// ---------------------------------------------------------------------------
//
// These used to be derived FROM the HTTP payload types in work-unit.ts
// (`Omit<RejectReasonBreakdown, "timeZone" | "loadedThrough">`). The derivation is
// now the other way round: the aggregate is the primitive and each module's
// payload type adds its own envelope on top. Same result, and the dependency
// points from a module into shared/ rather than out of it.

type RejectReasonBucket = {
  // WHICH COUNTER recorded the rejects — `Total_NG_Prod`, `NG_Over_Count`. A
  // column name the plant uses, not operator free text, so unlike
  // DowntimeReasonBucket.reason it is never null.
  reason: string;
  // The master-data reject reason behind the counter, where one is mapped.
  // NULL when this bucket's rows disagree about it, for the same reason the two
  // units below can be null.
  reasonCode: string | null;
  // Which machine. Nullable because master-data enrichment can degrade — and at
  // LINE grain it is null for a second reason: the bucket spans several machines,
  // so there is no single one to name.
  machineName: string | null;
  // Rejects AS COUNTED, in `counterUnit`. Never scaled.
  counterValue: number;
  // NULL when this bucket's rows disagree about the sensor unit. `counterValue` is
  // then a sum of unlike things, so the reader must render the whole cell as an em
  // dash rather than a plausible bare number.
  counterUnit: string | null;
  // The same rejects converted to `convertedUnit`. Read from the GENERATED column,
  // never recomputed here.
  quantity: number;
  convertedUnit: string | null;
  // NULL, not 0, when nothing in this bucket was weighed — see the note on the
  // uncoalesced sum below.
  weightGram: number | null;
  frequency: number;
  durationMs: number;
};

type RejectAggregate = {
  buckets: RejectReasonBucket[];
  totalFrequency: number;
  totalDurationMs: number;
  totalQuantity: number;
  totalWeightGram: number | null;
  convertedUnit: string | null;
};

// The single row the totals statement returns. `::int` and `::float8` in the SQL
// are what make these numbers rather than the strings postgres.js hands back for
// bigint and numeric.
type RejectTotalsRow = {
  totalFrequency: number;
  totalDurationMs: number;
  totalQuantity: number;
  totalWeightGram: number | null;
  convertedUnit: string | null;
};

type DowntimeEventReasonBucket = {
  // NULL means NO REASON WAS RECORDED — a stop whose `reasons` array was empty, or
  // whose element was blank. Deliberately NOT the string "Unspecified": that label
  // is applied in the browser so a genuine reason of that text cannot merge into
  // the unattributed bucket.
  reason: string | null;
  // How many downtime EVENTS cited this reason. These sum to `totalOccurrences`
  // and NOT to `totalEvents` — one event can cite several reasons.
  frequency: number;
};

type DowntimeEventAggregate = {
  buckets: DowntimeEventReasonBucket[];
  totalOccurrences: number;
  totalEvents: number;
};

// The single row the totals statement returns. `::int` in the SQL is what makes
// these numbers rather than the strings postgres.js hands back for count().
type DowntimeEventTotalsRow = {
  totalOccurrences: number;
  totalEvents: number;
};

// THE SPAN'S TABLE NAME IS A PARAMETER, AND IT USED TO BE A CONSTANT THAT LIED.
//
// These two constants lived here:
//
//   const TABLE_REJECT_COUNT_WU_SHIFT = "oee.reject_count_wu_shift";
//   const TABLE_DOWNTIME_LOG_EVENTS   = "oee.downtime_log_events";
//
// under a comment asserting "the table named here is the one the fragment reads —
// which is the same table for both subjects". The second half was false from the
// day the line grain shipped: work-center-repository.ts passes a fragment reading
// `oee.reject_count_wc_shift`, so EVERY line-grain Quality Loss Pareto has been
// traced under the machine table's name. Nothing broke; the traces were simply
// wrong, which is the failure mode that survives longest.
//
// The whole design of these functions is that the CALLER chooses the rows. The
// span name is part of choosing the rows, so it comes from the caller too. A third
// subject would otherwise have been a third read filed under a name it never
// touches, and "which subject's Pareto is slow" would stay unanswerable at exactly
// the point it became worth asking.
//
// Pass the table the FRAGMENT reads, not the table the caller lives in.
async function aggregateRejectRows(
  db: GoldDB,
  table: string,
  scoped: Fragment,
): Promise<RejectAggregate> {
  return await traced("SELECT", table, async () => {
    // ONE fragment, interpolated into both statements below, so the buckets and
    // the totals can never be computed over different rows. Same arrangement
    // as DowntimeReaderRepository.clipped, and for the same reason.

    const [rows, totals] = await Promise.all([
      // Same numeric discipline as listProductCount: postgres.js returns
      // `numeric` as a string to protect precision, so every measure is
      // rounded and cast to float8 or it reaches the browser as "4776.000".
      db<RejectReasonBucket[]>`
        WITH scoped AS (${scoped})
        SELECT reason,
               CASE WHEN count(DISTINCT reason_code) = 1
                    THEN min(reason_code) END              AS reason_code,
               min(work_unit_name)                         AS machine_name,
               round(sum(counter_value), 3)::float8        AS counter_value,
               CASE WHEN count(DISTINCT uom_code) = 1
                    THEN min(uom_code) END                 AS counter_unit,
               -- READ from the GENERATED column, never recomputed here from
               -- the counter and its factor: the database owns that arithmetic,
               -- so this reader cannot drift from what a BI tool sees off the
               -- same row. work-unit-repository.test.ts pins that.
               round(sum(converted_value), 3)::float8      AS quantity,
               CASE WHEN count(DISTINCT base_uom_code) = 1
                    THEN min(base_uom_code) END            AS converted_unit,
               -- DELIBERATELY NOT coalesced. sum() over an all-NULL set is
               -- NULL, which is exactly the wanted semantics: a bucket where
               -- nothing was weighed reports "not weighed" rather than
               -- "weighed nothing", and the two render differently. Rows that
               -- DO carry a weight still sum, because sum() skips nulls.
               round(sum(weight_gram), 3)::float8          AS weight_gram,
               sum(frequency)::int                         AS frequency,
               -- Coalesced, unlike weight: the browser's duration measure is a
               -- number and reject_time is unwritten everywhere today, so this
               -- is a column of zeros until the DAG fills it. A zero grand
               -- total yields null percentages rather than NaN.
               coalesce(sum(reject_time), 0)::float8       AS duration_ms
        FROM scoped
        GROUP BY reason
        -- One deterministic order, not a caller-supplied one: the endpoint is
        -- unpaged and the browser re-ranks for its own four-way measure
        -- toggle, so a sort parameter would be a round trip for a reduce over
        -- a handful of numbers. The reason IS the group key and therefore
        -- unique, which makes this a TOTAL order — without the tiebreak two
        -- equal counters could swap places between identical requests, and the
        -- cumulative line is a function of the order.
        ORDER BY sum(converted_value) DESC NULLS LAST, reason ASC
      `,
      db<RejectTotalsRow[]>`
        WITH scoped AS (${scoped})
        SELECT coalesce(sum(frequency), 0)::int                     AS total_frequency,
               coalesce(sum(reject_time), 0)::float8                AS total_duration_ms,
               coalesce(round(sum(converted_value), 3), 0)::float8  AS total_quantity,
               -- The one denominator allowed to be null, for the reason above.
               round(sum(weight_gram), 3)::float8                   AS total_weight_gram,
               CASE WHEN count(DISTINCT base_uom_code) = 1
                    THEN min(base_uom_code) END                     AS converted_unit
        FROM scoped
      `,
    ]);

    return {
      buckets: [...rows],
      totalFrequency: totals[0]?.totalFrequency ?? 0,
      totalDurationMs: totals[0]?.totalDurationMs ?? 0,
      totalQuantity: totals[0]?.totalQuantity ?? 0,
      totalWeightGram: totals[0]?.totalWeightGram ?? null,
      convertedUnit: totals[0]?.convertedUnit ?? null,
    };
  });
}

// Same rule as aggregateRejectRows: the caller names the table its fragment reads.
async function aggregateEventPairs(
  db: GoldDB,
  table: string,
  pairs: Fragment,
): Promise<DowntimeEventAggregate> {
  return await traced("SELECT", table, async () => {
    const [rows, totals] = await Promise.all([
      db<DowntimeEventReasonBucket[]>`
        WITH pairs AS (${pairs})
        -- Counts ROWS, never the reason column. Counting the column instead
        -- would skip nulls and report 0 for the unattributed bucket — a
        -- zero-height bar that still occupies a table row — and the totals
        -- statement written the same way would stop equalling the total of the
        -- bars. work-unit-repository.test.ts asserts the anti-pattern is
        -- absent, which is also why this note does not spell it out: fakeSql
        -- records comments, so prose quoting it would defeat the guard.
        SELECT reason,
               count(*)::int AS frequency
        FROM pairs
        -- GROUP BY treats every NULL as one group, which is exactly what is
        -- wanted: every event with no reason recorded, and every event whose
        -- element was blank, lands in ONE unattributed bucket. The browser
        -- labels it (UNSPECIFIED_LABEL in lib/pareto.ts); this layer never
        -- emits that string, so a genuine reason of that text cannot merge into
        -- it.
        GROUP BY reason
        -- One deterministic order, not a caller-supplied one: the endpoint is
        -- unpaged and the browser re-ranks for itself. The reason IS the group
        -- key and therefore unique, which makes this a TOTAL order — the cumulative
        -- line is a function of the order, so without the tiebreak two equally
        -- frequent reasons could swap between identical requests and the chart
        -- would move under a user who changed nothing. NULLS LAST is the ASC
        -- default and is written out so the unattributed bucket's position
        -- among ties is a decision rather than an accident.
        ORDER BY count(*) DESC, reason ASC NULLS LAST
      `,
      db<DowntimeEventTotalsRow[]>`
        WITH pairs AS (${pairs})
        -- total_occurrences IS THE DENOMINATOR, and it is the total of the bars
        -- by construction: the same row set and the same count(*), one GROUP BY
        -- apart.
        --
        -- total_events is NOT the denominator. It is smaller whenever an event
        -- cited several reasons, and it ships so the card can say so in words.
        -- count(DISTINCT event_id) is exact only because event_id is the PRIMARY
        -- KEY and therefore NOT NULL — count(DISTINCT) skips nulls, so a
        -- nullable identity here would silently undercount the stops.
        --
        -- NO coalesce, on either, and unlike the summed measures in
        -- aggregateRejectReasons where the coalesce is load-bearing: count()
        -- over an empty row set returns a row containing 0, never NULL. One
        -- added "for symmetry" would be dead code asserting something false
        -- about count().
        SELECT count(*)::int                 AS total_occurrences,
               count(DISTINCT event_id)::int AS total_events
        FROM pairs
      `,
    ]);

    return {
      buckets: [...rows],
      totalOccurrences: totals[0]?.totalOccurrences ?? 0,
      totalEvents: totals[0]?.totalEvents ?? 0,
    };
  });
}

export { aggregateEventPairs, aggregateRejectRows };
export type {
  DowntimeEventAggregate,
  DowntimeEventReasonBucket,
  RejectAggregate,
  RejectReasonBucket,
};
