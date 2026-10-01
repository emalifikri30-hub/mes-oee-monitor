import { rankPareto, sortParetoRows } from "@/lib/pareto-rank";
import { selectLoadState } from "@/lib/load-state";
import { UNSPECIFIED_LABEL } from "@/lib/pareto";

import type { LoadState } from "@/lib/load-state";
import type { DowntimeEventReasonBreakdown, DowntimeEventReasonBucket } from "@/lib/types";

// What the Others Pareto derives, as pure functions.
//
// The third sibling of lib/pareto-rank.ts: lib/pareto.ts is the DOWNTIME REPORT
// adapter, lib/quality-pareto.ts is the REJECT adapter, and this is the DOWNTIME
// EVENT LOG adapter. The walk, and the three rules that make it correct, live in
// pareto-rank.ts and are stated there.
//
// WHAT IS GENUINELY DIFFERENT HERE, and why this is not another `category` on the
// downtime card:
//
//   * A DIFFERENT TABLE, and that is the feature. oee.downtime_log_events is
//     immutable; oee.downtime_reports is what operators edit. So these bars do
//     not move when a stop is corrected — and that is also why there is no
//     drill-down, since the detail page filters the mutable table by primary
//     reason and its rows would not be the rows behind a bar.
//   * ONE MEASURE, not two or four. There is no duration in the source, so there
//     is no measure union in this file and nothing to widen.
//   * THE BARS DO NOT SUM TO THE RECORD COUNT. One event cites several reasons,
//     so `totalOccurrences` (the denominator) exceeds `totalEvents` (the stops).
//     Both travel through to the card; only the first is ever divided by.
//
// NO MEASURE UNION, AND NOTHING TO WIDEN. TODOS.md §29 records why ParetoMeasure
// in lib/pareto.ts stays at two members: reason-pareto-chart.tsx picks its axis
// with `measure === "duration" ? … : …`, so a widened union would make a foreign
// member reachable in every downtime path and fall silently through to the
// frequency branch. This file avoids the problem by having no union at all — a
// count is already axis-ready, so there is no `plotValue` here either and
// therefore no measure-to-field map at render time.
//
// Arithmetic here rather than in the card for the reason vite.config.ts states:
// this is the part that fails as plausible-looking wrong numbers rather than as an
// error, and it is far cheaper to cover exhaustively as a function.

// The key for the single unattributed bar.
//
// A FIXED SENTINEL, unlike lib/pareto.ts's `__unspecified__${index}`. That file
// embeds the ranking index because it does not fold and could in principle see
// two null buckets; this one folds first, so there is exactly one and a stable key
// is both possible and better — an index-derived key moves whenever the ranking
// does.
const UNSPECIFIED_KEY = "__unspecified__";

type DowntimeEventBar = {
  key: string;
  // The RAW server value, kept alongside `label` even though nothing links out of
  // this card. It is what the label is NOT: `label` is "Unspecified", which a
  // genuine reason of that text would collide with, so any future export or
  // server-side filter has to read this field rather than the rendered one.
  reason: string | null;
  label: string;
  // How many stops cited this reason.
  occurrences: number;
  // occurrences / totalOccurrences * 100. Null on a zero total, never NaN.
  //
  // THE SAME DENOMINATOR THE CUMULATIVE LINE USES, and that is not a detail: if
  // the two differed, the shares would not add up to the last bar's cumulative
  // and the card would contradict itself in two adjacent columns.
  sharePct: number | null;
  cumulativePct: number | null;
  isVitalFew: boolean;
};

type DowntimeEventParetoModel = {
  bars: DowntimeEventBar[];
  // THE DENOMINATOR. Straight off the response, never summed here — rule 2 in
  // lib/pareto-rank.ts. It equals the total of the bars today BY DEFINITION, and
  // the definition is the endpoint's rather than this file's.
  totalOccurrences: number;
  // NOT A DENOMINATOR. Carried only so the card can state it beside the total and
  // say why the two differ. Nothing in this file divides by it, and nothing
  // should: it is smaller whenever a stop cited more than one reason.
  totalEvents: number;
  isEmpty: boolean;
};

// Merges every bucket whose reason is null into one.
//
// WHY FOLD RATHER THAN TRUST ONE NULL GROUP, which is what lib/pareto.ts does.
// /downtimes/by-reason groups by the PRIMARY reason, so its SQL cannot produce two
// null groups. This endpoint unnests a reason ARRAY, where "the stop cited
// nothing" and "a cited reason failed to resolve" are two plausible SQL branches
// that both land on NULL. Two adjacent bars both labelled "Unspecified" read as a
// rendering bug and make every share look wrong, so the invariant is enforced here
// rather than assumed of the server.
function foldUnspecified(
  buckets: readonly DowntimeEventReasonBucket[],
): DowntimeEventReasonBucket[] {
  const folded: DowntimeEventReasonBucket[] = [];
  let unattributed = 0;
  let sawUnattributed = false;

  for (const bucket of buckets) {
    if (bucket.reason === null) {
      unattributed += bucket.frequency;
      sawUnattributed = true;
      continue;
    }
    folded.push(bucket);
  }

  if (sawUnattributed) folded.push({ reason: null, frequency: unattributed });
  return folded;
}

function buildDowntimeEventPareto(
  breakdown: DowntimeEventReasonBreakdown | undefined,
): DowntimeEventParetoModel {
  // ZEROED TOTALS in the empty case, deliberately, rather than the response's own.
  // It is what keeps the card's summary line from reading "0 reason occurrences
  // across 97 downtime events" out of a payload whose buckets were truncated.
  if (!breakdown || breakdown.buckets.length === 0) {
    return { bars: [], totalOccurrences: 0, totalEvents: 0, isEmpty: true };
  }

  const total = breakdown.totalOccurrences;

  const ranked = rankPareto({
    buckets: foldUnspecified(breakdown.buckets),
    total,
    valueOf: (bucket) => bucket.frequency,
    labelOf: (bucket) => bucket.reason ?? UNSPECIFIED_LABEL,
  });

  const bars = ranked.map(({ bucket, value, cumulativePct, isVitalFew }) => ({
    key: bucket.reason ?? UNSPECIFIED_KEY,
    reason: bucket.reason,
    label: bucket.reason ?? UNSPECIFIED_LABEL,
    occurrences: value,
    // Rule 3 again, in the one place this file computes a percentage of its own: a
    // zero total yields null rather than NaN or Infinity. Reachable if the server
    // ever sends buckets whose every frequency is zero.
    sharePct: total > 0 ? (value / total) * 100 : null,
    cumulativePct,
    isVitalFew,
  }));

  return {
    bars,
    totalOccurrences: total,
    totalEvents: breakdown.totalEvents,
    isEmpty: false,
  };
}

// How the TABLE is ordered, independent of how the chart is ranked — the split
// lib/pareto.ts already draws.
//
// `share` IS DELIBERATELY NOT SORTABLE, and the card's columns say so too:
// ordering by share is IDENTICALLY the occurrences order, since both divide by one
// constant. A second sortable column that silently duplicates an existing sort
// looks independent and is not — the argument lib/quality-pareto.ts already makes
// for its non-sortable Counter column.
type DowntimeEventSort = {
  by: "reason" | "occurrences";
  dir: "asc" | "desc";
};

function sortDowntimeEventRows(
  bars: DowntimeEventBar[],
  sort: DowntimeEventSort,
): DowntimeEventBar[] {
  return sortParetoRows(bars, {
    labelOf: (bar) => bar.label,
    // sortParetoRows' nulls-last rule is inert here — an occurrence count is never
    // null — exactly as sortReasonRows notes it is inert for duration.
    valueOf: sort.by === "reason" ? undefined : (bar) => bar.occurrences,
    dir: sort.dir,
  });
}

// Which of the card's six states to render. A thin delegate to `selectLoadState`,
// matching `selectParetoState` and `selectQualityParetoState` — the ladder and its
// rationale live in lib/load-state.ts, and the reason it is not copied is stated
// there.
type DowntimeEventParetoStateInput = {
  hasParams: boolean;
  isPending: boolean;
  isError: boolean;
  data: DowntimeEventReasonBreakdown | undefined;
  reportDate: string | null | undefined;
};

function selectDowntimeEventParetoState(input: DowntimeEventParetoStateInput): LoadState {
  return selectLoadState({ ...input, isEmpty: (data) => data.buckets.length === 0 });
}

export {
  buildDowntimeEventPareto,
  selectDowntimeEventParetoState,
  sortDowntimeEventRows,
  UNSPECIFIED_KEY,
};
export type { DowntimeEventBar, DowntimeEventParetoModel, DowntimeEventSort };
