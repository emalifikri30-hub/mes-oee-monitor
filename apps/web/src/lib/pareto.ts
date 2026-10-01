import { rankPareto, sortParetoRows, VITAL_FEW_PCT } from "@/lib/pareto-rank";
import { selectLoadState } from "@/lib/load-state";

import type { DowntimeReasonBreakdown, ReasonMeasure } from "@/lib/types";
import type { LoadState } from "@/lib/load-state";

// Everything a Loss tab's Pareto derives, as pure functions.
//
// Category-blind, all of it: Availability Loss and Schedule Loss are the same
// arithmetic over different rows, and the only thing that differs between them is
// the words — which is why those live in lib/loss-category.ts and not here.
//
// apps/web runs component tests in happy-dom now, but arithmetic is still far
// cheaper to cover exhaustively as a function than through a rendered tree — the
// convention vite.config.ts states, and the one lib/waterfall.ts,
// lib/product-count.ts and lib/perf-hourly.ts already follow.
//
// Three things live here because getting any of them wrong produces a chart that
// looks entirely reasonable and is wrong:
//
//   1. The cumulative line accumulates the measure being RANKED. Ranking by
//      frequency while accumulating duration draws a non-monotonic line, which
//      is the classic Pareto bug.
//   2. The denominator is the response's own total, not the sum of the bars.
//      Those are now DIFFERENT: the endpoint returns the top N and a tail.
//   3. A zero total yields null percentages, never NaN or Infinity. Every
//      unplanned stop still being open makes every duration zero, and that is a
//      real shift, not a bug.

// Which measure the chart ranks and accumulates by.
//
// AN ALIAS OF THE WIRE TYPE, not an independent union, and that changed when the
// endpoint started truncating: the toggle is no longer only a UI concern, because
// it decides WHICH buckets the server returns. Two copies of these two strings
// could drift into a request the endpoint rejects, so there is one.
//
// TWO MEMBERS, AND IT MUST STAY TWO. The Quality Loss Pareto ranks by four, and
// it has its own union in lib/quality-pareto.ts rather than widening this one.
// reason-pareto-chart.tsx picks its axis and its tooltip tail with
// `measure === "duration" ? … : …`, so a widened union would make "quantity"
// reachable there and fall silently through to the frequency branch. Disjoint
// unions make that a compile error instead — the same argument lib/types.ts makes
// for keeping DowntimeCategory and TimelineSegmentKind apart.
type ParetoMeasure = ReasonMeasure;

// What the server sends for a reason it could not name. Applied here rather than
// server-side so a genuine reason of this text cannot merge into the same bucket.
const UNSPECIFIED_LABEL = "Unspecified";

// The bar standing for every reason outside the top N.
//
// A SENTINEL KEY, not a reason, and `reason: null` would not do — that is the
// UNLABELLED bucket, a different thing entirely, and the two can appear on the
// same chart. The drill-down link is suppressed for this bar precisely because it
// names no bucket the detail endpoint could resolve.
const OTHER_KEY = "__other__";

type ParetoBar = {
  // Stable identity for React keys and recharts' x axis. The reason itself, or a
  // sentinel for the unlabelled bucket — the server sends at most one of those,
  // so it cannot collide with a real reason.
  key: string;
  // The RAW server value, kept alongside the display label. Null is the
  // unlabelled bucket. The drill-down link is built from this and never from
  // `label` or `key`: `label` is "Unspecified", which a genuine reason of that
  // text would collide with, and `key` embeds the bar's INDEX, so a URL built
  // from it would point somewhere else the moment the sort toggle moved.
  reason: string | null;
  label: string;
  // THE TRUNCATED TAIL, not a reason. Distinguishes this bar from the unlabelled
  // bucket, which also has `reason: null` — see buildPareto. Anything that would
  // open a drill-down, or treat the bar as something to act on, has to check it.
  isOther: boolean;
  // Joined, because the server can return several. Null renders as an em dash.
  machineName: string | null;
  frequency: number;
  durationMs: number;
  // The left axis is minutes; the tooltip formats `durationMs`. Both are carried
  // so neither has to re-derive the other and drift.
  durationMinutes: number;
  // Whichever measure is being ranked. What the bars are drawn from.
  value: number;
  // Running share of the grand total, 0-100. Null when the total is zero.
  cumulativePct: number | null;
  // At or before the bar that crosses VITAL_FEW_PCT. Inclusive: the bar that
  // does the crossing is part of what you fix.
  isVitalFew: boolean;
};

type ParetoModel = {
  bars: ParetoBar[];
  // The denominator, straight from the response.
  total: number;
  measure: ParetoMeasure;
  isEmpty: boolean;
};

function measureOf(bucket: { frequency: number; durationMs: number }, measure: ParetoMeasure) {
  return measure === "duration" ? bucket.durationMs : bucket.frequency;
}

// Ranks the buckets by `measure` and walks the cumulative line over that same
// ranking — both delegated to `rankPareto`, which is where the three rules and
// their rationale live. This function's job is the DOWNTIME shape: which total is
// the denominator for which measure, and what a bar carries.
// WHAT buildPareto NEEDS, structurally — not `DowntimeReasonBreakdown` itself.
//
// Pareto Actions sends the identical payload MINUS its `category` (an action is
// not an operation type), and this function never looks at one. Typing the
// parameter by what it reads rather than by one caller's payload is what lets both
// Paretos share every edge case that matters here: the "Other" tail, a zero
// denominator, and the unlabelled bucket.
type ParetoSource = Pick<
  DowntimeReasonBreakdown,
  "buckets" | "other" | "totalFrequency" | "totalDurationMs"
>;

function buildPareto(breakdown: ParetoSource | undefined, measure: ParetoMeasure): ParetoModel {
  if (breakdown === undefined || breakdown.buckets.length === 0) {
    return { bars: [], total: 0, measure, isEmpty: true };
  }

  const total = measure === "duration" ? breakdown.totalDurationMs : breakdown.totalFrequency;

  // THE TAIL BECOMES A BUCKET, here rather than on the wire, so one ranking walk
  // covers it and the cumulative line runs through it to 100 without a special
  // case. `other` is null whenever nothing was truncated, which is every machine
  // shift — the limit is set above what one produces.
  //
  // Its label carries the COUNT ("Other (37 reasons)") because "Other" alone does
  // not say whether one reason was folded in or two hundred, and that difference
  // is the whole reason a reader should care that the chart is truncated.
  const tail = breakdown.other;
  const buckets =
    tail === null
      ? breakdown.buckets
      : [
          ...breakdown.buckets,
          {
            reason: OTHER_KEY,
            workUnitNames: [],
            frequency: tail.frequency,
            durationMs: tail.durationMs,
          },
        ];

  const ranked = rankPareto({
    buckets,
    total,
    valueOf: (bucket) => measureOf(bucket, measure),
    labelOf: (bucket) => bucket.reason ?? UNSPECIFIED_LABEL,
    // Pinned last and never vital few — see the note on isTail in pareto-rank.ts.
    isTail: (bucket) => bucket.reason === OTHER_KEY,
  });

  const bars = ranked.map(({ bucket, index, value, cumulativePct, isVitalFew }) => {
    const isOther = bucket.reason === OTHER_KEY;
    const machineName = bucket.workUnitNames.length === 0 ? null : bucket.workUnitNames.join(", ");

    return {
      key: isOther ? OTHER_KEY : (bucket.reason ?? `__unspecified__${index}`),
      // NULL for the tail, which suppresses the drill-down link: it names no
      // single bucket, so there is nothing for the detail endpoint to resolve.
      // Null is also the unlabelled bucket's value, and `isOther` is what keeps
      // the two apart at every call site that cares.
      reason: isOther ? null : bucket.reason,
      isOther,
      label: isOther
        ? `Other (${tail === null ? 0 : tail.reasonCount} ${tail?.reasonCount === 1 ? "reason" : "reasons"})`
        : (bucket.reason ?? UNSPECIFIED_LABEL),
      machineName,
      frequency: bucket.frequency,
      durationMs: bucket.durationMs,
      durationMinutes: bucket.durationMs / 60_000,
      value,
      cumulativePct,
      isVitalFew,
    };
  });

  return { bars, total, measure, isEmpty: false };
}

// How the TABLE is ordered, which is independent of how the chart is ranked. The
// chart answers "what should I fix first"; the table is a list someone reads and
// sorts by whichever column they are looking at.
type ReasonSort = { by: "reason" | "duration"; dir: "asc" | "desc" };

function sortReasonRows(bars: ParetoBar[], sort: ReasonSort): ParetoBar[] {
  return sortParetoRows(bars, {
    labelOf: (bar) => bar.label,
    // Omitted for "reason", which sorts on the label alone. `durationMs` is never
    // null on a downtime bar, so the nulls-last rule in sortParetoRows is inert
    // here — it exists for the Quality Loss table's weight column.
    valueOf: sort.by === "duration" ? (bar) => bar.durationMs : undefined,
    dir: sort.dir,
  });
}

// Which of the card's six states to render.
//
// A thin delegate to `selectLoadState` in lib/load-state.ts, which is where the
// ladder and its rationale now live — the Availability Loss detail page renders
// the same six states from a different payload, and two copies of an ordering
// this subtle is how one of them silently drifts.
//
// The exhaustive tests below stay pointed at this function: it is the one every
// card on this page actually calls, so they keep guarding the composed
// behaviour rather than the generic helper in isolation.
type ParetoState = LoadState;

// `data` is typed by what this reads — `buckets`, plus the two fields the
// stale/loaded split needs — rather than by one caller's payload, for the reason
// ParetoSource above is. The action breakdown has no `category`, and the emptiness
// question is identical either way.
type ParetoStateData = Pick<DowntimeReasonBreakdown, "buckets" | "timeZone" | "loadedThrough">;

type ParetoStateInput = {
  hasParams: boolean;
  isPending: boolean;
  isError: boolean;
  data: ParetoStateData | undefined;
  reportDate: string | null | undefined;
};

function selectParetoState(input: ParetoStateInput): ParetoState {
  return selectLoadState({ ...input, isEmpty: (data) => data.buckets.length === 0 });
}

// The per-state sentences used to live here. They moved to lib/loss-category.ts
// when the card was generalised over `category`: every one of them named
// "unplanned downtime" specifically, so they are copy keyed by which loss rather
// than arithmetic, and this file is arithmetic.

export { buildPareto, selectParetoState, sortReasonRows, UNSPECIFIED_LABEL, VITAL_FEW_PCT };
export type { ParetoBar, ParetoMeasure, ParetoModel, ParetoSource, ParetoState, ReasonSort };
