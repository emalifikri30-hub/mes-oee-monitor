import { rankPareto, sortParetoRows } from "@/lib/pareto-rank";
import { selectLoadState } from "@/lib/load-state";

import type { LoadState } from "@/lib/load-state";
import type { RejectReasonBreakdown, RejectReasonBucket } from "@/lib/types";

// What the Quality Loss Pareto derives, as pure functions.
//
// The sibling of lib/pareto.ts: that file is the DOWNTIME adapter over
// lib/pareto-rank.ts and this one is the REJECT adapter. The walk, and the three
// rules that make it correct, live in pareto-rank.ts and are stated there.
//
// What is genuinely different here, and why this is not just another `category`
// on the downtime card:
//
//   * FOUR MEASURES, not two — converted quantity, weight, frequency, duration —
//     so four denominators and four formatters.
//   * TWO NUMBERS PER ROW for one fact. `counterValue` is what the sensor counted
//     in its own unit; `quantity` is the same rejects converted to a comparable
//     one. Both are shown, in different columns.
//   * ABSENCE IS MEANINGFUL IN TWO PLACES. A null weight means the counter was
//     never weighed; a null unit means the bucket spans rows whose units
//     disagree. Both must survive the ranking so the cell can render an em dash.
//
// Arithmetic here rather than in the card for the reason vite.config.ts states:
// this is the part that fails as plausible-looking wrong numbers rather than as
// an error, and it is far cheaper to cover exhaustively as a function.

// Which measure the chart ranks and accumulates by.
//
// A SEPARATE UNION, not a widened ParetoMeasure, and deliberately so:
// reason-pareto-chart.tsx picks its axis and its tooltip tail with
// `measure === "duration" ? … : …`, so widening that union would make "quantity"
// reachable in every downtime path and fall silently through to the frequency
// branch. Disjoint unions make that a compile error instead.
type QualityMeasure = "quantity" | "weight" | "frequency" | "duration";

type QualityBar = {
  // Stable identity for React keys and recharts' x axis. Composed from the two
  // fields that identify a bucket and NOT from the ranking index, which moves
  // whenever the measure toggle does.
  key: string;
  // The counter's name, raw. Rendered verbatim — see the note on
  // RejectReasonBucket.reason.
  reason: string;
  reasonCode: string | null;
  // Kept alongside `reason` even though the two are equal today, so the tick, the
  // table and the tooltip all read one field. If a counter ever needs a friendlier
  // display name, this is the only place that changes.
  label: string;
  // Fallback already applied — see `fallbackMachineName` below.
  machineName: string | null;
  counterValue: number;
  counterUnit: string | null;
  quantity: number;
  convertedUnit: string | null;
  // NULL SURVIVES THE RANKING. The bar ranks as 0 in the weight measure (see
  // `valueFor`) but the field stays null, so the Weight cell renders an em dash
  // rather than `0 gr`. This is the one place in this file where an arithmetic
  // decision and a formatting decision meet, and conflating them is how "never
  // weighed" silently becomes "weighed nothing".
  weightGram: number | null;
  frequency: number;
  durationMs: number;
  // Whichever measure is being ranked, RAW. What the cumulative line was
  // accumulated from, and what the measure's own formatter is applied to.
  value: number;
  // The same measure, AXIS-READY: minutes for `duration`, the raw number
  // otherwise. The chart plots this key unconditionally, so no ternary at render
  // time can plot the wrong field — the trap reason-pareto-chart.tsx's `barKey`
  // still carries. Ranking still happens on `value` against the raw denominator,
  // so pareto-rank.ts's rule 2 is untouched: dividing both sides by 60 000 would
  // be a derived denominator.
  plotValue: number;
  cumulativePct: number | null;
  isVitalFew: boolean;
};

type QualityParetoModel = {
  bars: QualityBar[];
  // The denominator for `measure`, straight from the response.
  total: number;
  measure: QualityMeasure;
  // The SHIFT-level converted unit: non-null only when every bucket agrees. The
  // axis caption and any shift-wide statement read this; a per-ROW cell reads the
  // bucket's own unit. Null means mixed, and the card says so rather than adding
  // BAG to CARTON.
  convertedUnit: string | null;
  isEmpty: boolean;
};

// Which bucket field each measure ranks by.
//
// `weightGram ?? 0` IS THE ONLY `?? 0` IN THIS FILE, and it is the deliberate
// half of the null-survives-the-ranking rule above: an unweighed counter has to
// rank somewhere, and 0 is the only honest position — it contributed no weight.
// The bar keeps the null so the cell can still say "not weighed".
function valueFor(bucket: RejectReasonBucket, measure: QualityMeasure): number {
  switch (measure) {
    case "quantity":
      return bucket.quantity;
    case "weight":
      return bucket.weightGram ?? 0;
    case "frequency":
      return bucket.frequency;
    case "duration":
      return bucket.durationMs;
  }
}

// Which response total is the denominator for each measure.
//
// `totalWeightGram ?? 0` turns a shift where nothing was weighed into
// pareto-rank.ts's rule 3 — a zero total, hence null percentages — rather than a
// special case anywhere. That is why the wire type allows null there at all.
function totalFor(breakdown: RejectReasonBreakdown, measure: QualityMeasure): number {
  switch (measure) {
    case "quantity":
      return breakdown.totalQuantity;
    case "weight":
      return breakdown.totalWeightGram ?? 0;
    case "frequency":
      return breakdown.totalFrequency;
    case "duration":
      return breakdown.totalDurationMs;
  }
}

// Minutes for a duration, the raw number for everything else. The left axis reads
// minutes because a shift's stops are minutes; a quantity, a weight and a count
// are already in the units their axis is captioned with.
function plotValueFor(value: number, measure: QualityMeasure): number {
  return measure === "duration" ? value / 60_000 : value;
}

// `fallbackMachineName` IS THE REPORT'S OWN WORK UNIT, and passing it is not a
// guess: /rejects is scoped to one report and therefore to one machine, so a
// bucket with a null machineName is still THIS machine — master-data enrichment
// merely degraded. The design requires the Machine Name column to be populated,
// which is why this card diverges from ReasonParetoCard's bare em dash.
//
// MUST BE REVISITED if /rejects ever serves a wider scope, at which point buckets
// span machines and the fallback becomes a lie.
function buildQualityPareto(
  breakdown: RejectReasonBreakdown | undefined,
  measure: QualityMeasure,
  fallbackMachineName: string | null,
): QualityParetoModel {
  if (breakdown === undefined || breakdown.buckets.length === 0) {
    return { bars: [], total: 0, measure, convertedUnit: null, isEmpty: true };
  }

  const total = totalFor(breakdown, measure);

  const ranked = rankPareto({
    buckets: breakdown.buckets,
    total,
    valueOf: (bucket) => valueFor(bucket, measure),
    labelOf: (bucket) => bucket.reason,
  });

  const bars = ranked.map(({ bucket, value, cumulativePct, isVitalFew }) => ({
    // Identity, not position: the reason plus the machine it was counted on.
    // Never the ranking index, which moves with the measure toggle.
    key: `${bucket.reason}::${bucket.machineName ?? ""}`,
    reason: bucket.reason,
    reasonCode: bucket.reasonCode,
    label: bucket.reason,
    machineName: bucket.machineName ?? fallbackMachineName,
    counterValue: bucket.counterValue,
    counterUnit: bucket.counterUnit,
    quantity: bucket.quantity,
    convertedUnit: bucket.convertedUnit,
    weightGram: bucket.weightGram,
    frequency: bucket.frequency,
    durationMs: bucket.durationMs,
    value,
    plotValue: plotValueFor(value, measure),
    cumulativePct,
    isVitalFew,
  }));

  return { bars, total, measure, convertedUnit: breakdown.convertedUnit, isEmpty: false };
}

// How the TABLE is ordered, independent of how the chart is ranked — the split
// lib/pareto.ts already draws.
//
// `counter` IS DELIBERATELY NOT SORTABLE. Counter units differ per row, so
// ordering 48 CALENDER against 4776 BAG would rank unlike things and produce a
// column that looks sorted and is not. The converted column is the one that can
// be ordered, and it is.
type QualitySort = {
  by: "reason" | "weight" | "quantity" | "frequency";
  dir: "asc" | "desc";
};

function sortQualityRows(bars: QualityBar[], sort: QualitySort): QualityBar[] {
  return sortParetoRows(bars, {
    labelOf: (bar) => bar.label,
    // `weight` is the reason sortParetoRows has a nulls-last rule at all: an
    // unweighed counter has no weight, and ascending order must not open with the
    // rows that were never measured.
    valueOf:
      sort.by === "reason"
        ? undefined
        : (bar) =>
            sort.by === "weight"
              ? bar.weightGram
              : sort.by === "quantity"
                ? bar.quantity
                : bar.frequency,
    dir: sort.dir,
  });
}

// Which of the card's six states to render. A thin delegate to `selectLoadState`,
// matching `selectParetoState` — the ladder and its rationale live in
// lib/load-state.ts, and the reason it is not copied is stated there.
type QualityParetoStateInput = {
  hasParams: boolean;
  isPending: boolean;
  isError: boolean;
  data: RejectReasonBreakdown | undefined;
  reportDate: string | null | undefined;
};

function selectQualityParetoState(input: QualityParetoStateInput): LoadState {
  return selectLoadState({ ...input, isEmpty: (data) => data.buckets.length === 0 });
}

export { buildQualityPareto, selectQualityParetoState, sortQualityRows };
export type { QualityBar, QualityMeasure, QualityParetoModel, QualitySort };
