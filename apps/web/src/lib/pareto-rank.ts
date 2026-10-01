// The Pareto walk, once, for every family of bars on the Losses page.
//
// WHY THIS FILE EXISTS RATHER THAN A SECOND COPY OF THE LOOP
//
// This is lib/load-state.ts's move, made for the reason its header gives. That
// ladder was extracted out of lib/pareto.ts when a second surface needed the
// identical ordering, and it was generalised rather than copied because "the
// ORDER is the part that is wrong when this is wrong, and a second copy is a
// second chance to get the order wrong somewhere no test is looking."
//
// The three rules below are that same species. Each one, got wrong, produces a
// chart that looks entirely reasonable:
//
//   1. THE CUMULATIVE LINE ACCUMULATES THE MEASURE BEING RANKED. Ranking by
//      frequency while accumulating quantity draws a non-monotonic line, which is
//      the classic Pareto bug.
//   2. THE DENOMINATOR IS THE RESPONSE'S OWN TOTAL, never the sum of the bars.
//      They ARE NOW DIFFERENT on the downtime family: /downtimes/by-reason returns
//      the top N and a tail, so summing the bars would divide by a subset and draw
//      a cumulative line reaching 100% over a truncated chart.
//   3. A ZERO TOTAL YIELDS NULL PERCENTAGES, never NaN or Infinity. Every stop
//      still being open makes every duration zero; no counter being weighed makes
//      every weight zero. Those are real shifts, not bugs.
//
// The downtime Paretos rank by two measures and the Quality Loss Pareto by four,
// so there are now eight ways to get rule 1 wrong. Writing the walk once is what
// keeps that at zero.
//
// WHAT DELIBERATELY DOES NOT LIVE HERE: the measure unions, the bucket types and
// the formatters. Those differ per family and keeping them apart is what stops a
// quality measure being handed to a downtime chart — see the note on
// ParetoMeasure in lib/pareto.ts. This file knows only how to rank a list and
// walk a running total over it.
//
// NO TEST FILE OF ITS OWN, matching lib/load-state.ts: the exhaustive tests stay
// pointed at `buildPareto` and `buildQualityPareto`, which are what the cards
// actually call, so they keep guarding composed behaviour rather than a generic
// in isolation.

// The share of the total at or before which a bar counts as one of the "vital
// few" — the 80 in the 80/20 a Pareto exists to show. Lives here because the
// latch below is the only thing that reads it, and lib/pareto.ts re-exports it so
// the downtime chart's import is unchanged.
const VITAL_FEW_PCT = 80;

type ParetoRankInput<TBucket> = {
  buckets: readonly TBucket[];
  // Rule 2's denominator, straight off the response. Never summed here.
  total: number;
  // Rule 1's measure. An ABSENT measure must arrive as 0 from the caller: the
  // caller is the only place that still knows the difference between "zero" and
  // "not recorded", and it needs that difference for the cell it renders.
  valueOf: (bucket: TBucket) => number;
  // The stable tie-break. Two equal buckets must not swap places between
  // renders — the cumulative line is a function of the order, so an unstable sort
  // would make the chart move under a user who changed nothing.
  labelOf: (bucket: TBucket) => string;
  // THE TRUNCATED TAIL, if the caller has one. Optional, and absent for every
  // family that returns every bucket.
  //
  // It is not just another bucket, and two rules make it different:
  //
  //   PINNED LAST, whatever its size. A tail bigger than the top bar would
  //   otherwise sort to the front, and a Pareto opening with "Other" is not a
  //   Pareto — the chart's whole claim is that the bars to the left are what you
  //   fix first, and "Other" is the one bar nobody can act on.
  //
  //   NEVER VITAL FEW, for the same reason. When the shown bars cover less than
  //   VITAL_FEW_PCT the tail is the bar that crosses it, and highlighting it would
  //   say "and also fix the other thirty-seven reasons" — true, and not an action.
  //   The cumulative line still runs THROUGH it to 100, which is what makes the
  //   shortfall visible instead of hidden.
  isTail?: (bucket: TBucket) => boolean;
};

type ParetoRanked<TBucket> = {
  bucket: TBucket;
  // Position in the ranking. Handed back so an adapter can build a sentinel key
  // for an unlabelled bucket, which is the only legitimate use — a key that
  // embeds this moves the moment the measure toggle re-ranks.
  index: number;
  value: number;
  cumulativePct: number | null;
  isVitalFew: boolean;
};

// Ranks the buckets by `valueOf` descending and walks the cumulative line over
// THAT SAME ranking.
//
// Re-ranks unconditionally, even though every server here returns a deterministic
// order — it is a handful of elements, and a view that depends on the order should
// not also depend on the server having produced it.
//
// It does NOT re-rank a truncated response into a different measure's top N, and
// nothing here could: the buckets that did not come back are not in `buckets`.
// The downtime family sends its measure to the server for exactly that reason.
function rankPareto<TBucket>({
  buckets,
  total,
  valueOf,
  labelOf,
  isTail,
}: ParetoRankInput<TBucket>): ParetoRanked<TBucket>[] {
  const tailOf = (bucket: TBucket) => ((isTail?.(bucket) ?? false) ? 1 : 0);

  // Descending by the measure, then by label so two equal buckets cannot swap
  // places between renders — with the tail pinned last ahead of both.
  const ranked = [...buckets].sort((a, b) => {
    const tail = tailOf(a) - tailOf(b);
    if (tail !== 0) return tail;

    const delta = valueOf(b) - valueOf(a);
    if (delta !== 0) return delta;
    return labelOf(a).localeCompare(labelOf(b));
  });

  let running = 0;
  let crossed = false;

  const rows = ranked.map((bucket, index) => {
    const value = valueOf(bucket);
    running += value;

    // Rule 3. A zero total means every bucket is zero too — every stop still
    // open, or no counter weighed. Percentages are undefined rather than 100,
    // and a chart omits the line.
    const cumulativePct = total > 0 ? (running / total) * 100 : null;

    // Inclusive, and latched: once a bar has crossed, no later bar is vital few
    // even if a rounding step would put it back under. The tail is never vital
    // few whatever its size — see isTail.
    const isVitalFew = cumulativePct === null ? false : !crossed && tailOf(bucket) === 0;
    if (cumulativePct !== null && cumulativePct >= VITAL_FEW_PCT) crossed = true;

    return { bucket, index, value, cumulativePct, isVitalFew };
  });

  // Floating-point division leaves the last bar at 99.99999…, which draws a line
  // stopping a hair below the top gridline. It is pinned rather than rounded.
  //
  // ONLY WHEN IT IS ALREADY THERE, and that guard is the whole of rule 2 at the
  // last bar. This used to pin unconditionally, on the reasoning that "the last
  // bar IS the whole total by definition" — true while every bucket came back, and
  // false the moment an endpoint truncates. A shown set covering 55% of the total
  // would have been drawn as a line reaching 100%, which is the flattering reading
  // of a missing tail and precisely what the tail bucket exists to prevent.
  //
  // An epsilon rather than an equality test because the value being repaired is
  // itself float drift. A genuine shortfall is orders of magnitude larger than
  // this, so nothing real is ever rounded up into a lie.
  const last = rows.at(-1);
  if (last?.cumulativePct != null && Math.abs(100 - last.cumulativePct) < 1e-6) {
    last.cumulativePct = 100;
  }

  return rows;
}

type SortDir = "asc" | "desc";

type SortRowsOptions<TRow> = {
  labelOf: (row: TRow) => string;
  // Absent => sort by label alone. Returning NULL means the row has no value for
  // this column, which sorts LAST IN BOTH DIRECTIONS: absent is not "smallest",
  // and an ascending weight sort must not open with the counters that were never
  // weighed. That is the one rule this adds over the loop it was extracted from.
  valueOf?: (row: TRow) => number | null;
  dir: SortDir;
};

// How a Pareto's TABLE is ordered, which is independent of how its chart is
// ranked. The chart answers "what should I fix first"; the table is a list
// someone reads and sorts by whichever column they are looking at.
//
// Never mutates the array it was given.
function sortParetoRows<TRow>(
  rows: readonly TRow[],
  { labelOf, valueOf, dir }: SortRowsOptions<TRow>,
): TRow[] {
  const factor = dir === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (valueOf === undefined) {
      // Case-insensitive: "ganti film" and "Ganti Film" are the same reason to a
      // reader, and operators type them by hand.
      return factor * labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: "base" });
    }

    const left = valueOf(a);
    const right = valueOf(b);

    // Nulls last, whichever direction — see the note on `valueOf` above. Two
    // nulls fall through to the label so paging stays stable.
    if (left === null && right === null) return labelOf(a).localeCompare(labelOf(b));
    if (left === null) return 1;
    if (right === null) return -1;

    // NUMERIC, not lexicographic — 100 must sort above 9.
    const delta = left - right;
    // Ties fall back to the label so paging through the table is stable.
    return delta !== 0 ? factor * delta : labelOf(a).localeCompare(labelOf(b));
  });
}

export { rankPareto, sortParetoRows, VITAL_FEW_PCT };
export type { ParetoRanked, ParetoRankInput, SortDir };
