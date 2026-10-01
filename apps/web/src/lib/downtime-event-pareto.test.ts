import { describe, expect, it } from "vite-plus/test";

import {
  buildDowntimeEventPareto,
  selectDowntimeEventParetoState,
  sortDowntimeEventRows,
  UNSPECIFIED_KEY,
} from "@/lib/downtime-event-pareto";

import type { DowntimeEventReasonBreakdown, DowntimeEventReasonBucket } from "@/lib/types";

// The Others Pareto's arithmetic. Everything a pure function can reach lives here
// rather than in the component test, per the split AGENTS.md states — this is the
// part that fails as plausible-looking wrong numbers rather than as an error.
//
// EVERY TEST IN THIS FILE RUNS AGAINST A PAYLOAD WHERE THE TWO TOTALS DIFFER, and
// that is deliberate. `breakdown()` defaults `totalOccurrences` to the total of the
// buckets and `totalEvents` to something smaller, because a fixture where they
// happened to be equal would let the single worst defect in this feature —
// dividing by the event count — pass every assertion below.

function bucket(reason: string | null, frequency: number): DowntimeEventReasonBucket {
  return { reason, frequency };
}

function breakdown(
  buckets: DowntimeEventReasonBucket[],
  overrides: Partial<DowntimeEventReasonBreakdown> = {},
): DowntimeEventReasonBreakdown {
  const totalOccurrences = buckets.reduce((n, b) => n + b.frequency, 0);
  return {
    timeZone: "Asia/Jakarta",
    buckets,
    totalOccurrences,
    // Smaller than the total by construction: some stop cited more than one
    // reason. Never equal, unless a test overrides it to say so.
    totalEvents: Math.max(1, Math.ceil(totalOccurrences / 2)),
    loadedThrough: "2026-08-10",
    ...overrides,
  };
}

describe("buildDowntimeEventPareto", () => {
  it("ranks by occurrences, descending", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket("Belt_Slip", 1), bucket("Material_Jam", 5), bucket("Machine_Stop", 3)]),
    );

    expect(model.bars.map((b) => b.label)).toEqual(["Material_Jam", "Machine_Stop", "Belt_Slip"]);
    expect(model.bars.map((b) => b.occurrences)).toEqual([5, 3, 1]);
  });

  it("walks a cumulative line that only rises and lands on exactly 100", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket("A", 5), bucket("B", 3), bucket("C", 2)]),
    );

    const cumulative = model.bars.map((b) => b.cumulativePct);
    expect(cumulative).toEqual([50, 80, 100]);
    for (let i = 1; i < cumulative.length; i += 1) {
      expect(cumulative[i]!).toBeGreaterThanOrEqual(cumulative[i - 1]!);
    }
  });

  // RULE 2 in lib/pareto-rank.ts: the denominator is the response's own total,
  // never the total of the bars.
  //
  // Asserts on `sharePct` and DELIBERATELY NOT on the last bar's `cumulativePct`.
  // rankPareto pins that to 100 unconditionally — correct here, where the bars are
  // the whole population by the endpoint's own definition of totalOccurrences, and
  // therefore the one field that CANNOT detect a truncated response. `sharePct` is
  // not pinned, so it can.
  it("divides by the response's own total rather than by the bars it drew", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket("A", 5), bucket("B", 5)], { totalOccurrences: 20 }),
    );

    expect(model.totalOccurrences).toBe(20);
    expect(model.bars[0]?.sharePct).toBe(25);
    expect(model.bars[1]?.sharePct).toBe(25);
  });

  // THE CASE THIS WHOLE FEATURE EXISTS FOR, and the assertion that would catch its
  // single worst defect.
  //
  // 142 reason occurrences across 97 downtime events. A plausible implementation
  // divides by 97, because a Pareto conventionally divides by its record count and
  // 97 is the number of records. It draws a chart that looks entirely reasonable
  // and whose cumulative line walks past 100%.
  it("does NOT divide by the event count", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket("Material_Jam", 71), bucket("Machine_Stop", 71)], {
        totalOccurrences: 142,
        totalEvents: 97,
      }),
    );

    expect(model.bars[0]?.sharePct).toBe(50);
    // 71 / 97 — the number a wrong implementation would produce.
    expect(model.bars[0]?.sharePct).not.toBeCloseTo(73.196, 3);
    // And the shares total 100, which is only true against 142.
    const shares = model.bars.reduce((n, b) => n + (b.sharePct ?? 0), 0);
    expect(shares).toBeCloseTo(100, 10);
  });

  // Carried through untouched, and used by nothing in this file.
  it("carries the event count without dividing by it", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket("A", 3)], { totalOccurrences: 142, totalEvents: 97 }),
    );

    expect(model.totalEvents).toBe(97);
    expect(model.totalOccurrences).toBe(142);
  });

  // RULE 3. Reachable if the server ever sends buckets whose every frequency is
  // zero. NaN and Infinity are both wrong answers that render as wrong-looking
  // charts rather than as errors.
  it("yields null percentages rather than NaN on a zero total", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket("A", 0), bucket("B", 0)], { totalOccurrences: 0 }),
    );

    for (const bar of model.bars) {
      expect(bar.sharePct).toBeNull();
      expect(bar.cumulativePct).toBeNull();
      expect(bar.isVitalFew).toBe(false);
      expect(Number.isNaN(bar.occurrences)).toBe(false);
    }
  });

  // ---- the Unspecified fold ---------------------------------------------

  it("labels a null reason Unspecified and keeps the raw value beside it", () => {
    const model = buildDowntimeEventPareto(breakdown([bucket(null, 4)]));

    expect(model.bars[0]?.label).toBe("Unspecified");
    expect(model.bars[0]?.reason).toBeNull();
    expect(model.bars[0]?.key).toBe(UNSPECIFIED_KEY);
  });

  // WHY THE FOLD EXISTS. This endpoint unnests a reason ARRAY, so "the stop cited
  // nothing" and "a cited reason failed to resolve" are two plausible SQL branches
  // that both land on NULL — unlike /downtimes/by-reason, which groups by a single
  // primary reason and cannot produce two null groups. Two adjacent bars both
  // labelled "Unspecified" read as a rendering bug and make every share look wrong.
  it("folds two null buckets into one bar whose occurrences are their total", () => {
    const model = buildDowntimeEventPareto(
      breakdown([bucket(null, 3), bucket("Machine_Stop", 2), bucket(null, 4)]),
    );

    const unattributed = model.bars.filter((b) => b.reason === null);
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]?.occurrences).toBe(7);
    // And the shares still total 100, so the fold did not lose or duplicate a
    // count on the way.
    expect(model.bars.reduce((n, b) => n + (b.sharePct ?? 0), 0)).toBeCloseTo(100, 10);
  });

  // The reason the label is applied HERE and never server-side: a genuine reason of
  // that exact text must not merge into the unattributed bucket.
  it("does not merge a genuine reason named Unspecified into the null bucket", () => {
    const model = buildDowntimeEventPareto(breakdown([bucket("Unspecified", 2), bucket(null, 3)]));

    expect(model.bars).toHaveLength(2);
    expect(new Set(model.bars.map((b) => b.key)).size).toBe(2);
    const genuine = model.bars.find((b) => b.reason === "Unspecified");
    expect(genuine?.occurrences).toBe(2);
  });

  // ---- stability ---------------------------------------------------------

  // The cumulative line is a function of the order, so an unstable sort would move
  // the chart under a user who changed nothing.
  it("breaks ties by label, identically across calls and across input order", () => {
    const buckets = [bucket("Zebra", 4), bucket("Alpha", 4), bucket("Mango", 4)];

    const first = buildDowntimeEventPareto(breakdown(buckets)).bars.map((b) => b.label);
    const shuffled = buildDowntimeEventPareto(breakdown([...buckets].reverse())).bars.map(
      (b) => b.label,
    );

    expect(first).toEqual(["Alpha", "Mango", "Zebra"]);
    expect(shuffled).toEqual(first);
  });

  // ---- empty -------------------------------------------------------------

  // ZEROED TOTALS rather than the response's own, which is what stops the card's
  // summary line reading "0 reason occurrences across 97 downtime events".
  it("reports empty with zeroed totals rather than the response's", () => {
    for (const input of [undefined, breakdown([], { totalOccurrences: 142, totalEvents: 97 })]) {
      const model = buildDowntimeEventPareto(input);
      expect(model.isEmpty).toBe(true);
      expect(model.bars).toEqual([]);
      expect(model.totalOccurrences).toBe(0);
      expect(model.totalEvents).toBe(0);
    }
  });
});

describe("sortDowntimeEventRows", () => {
  const bars = buildDowntimeEventPareto(
    breakdown([bucket("beta", 9), bucket("Alpha", 100), bucket("gamma", 9)]),
  ).bars;

  it("sorts by reason, case-insensitively, in both directions", () => {
    expect(sortDowntimeEventRows(bars, { by: "reason", dir: "asc" }).map((b) => b.label)).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
    expect(sortDowntimeEventRows(bars, { by: "reason", dir: "desc" }).map((b) => b.label)).toEqual([
      "gamma",
      "beta",
      "Alpha",
    ]);
  });

  // NUMERIC, not lexicographic — 100 must sort above 9.
  it("sorts by occurrences numerically", () => {
    expect(
      sortDowntimeEventRows(bars, { by: "occurrences", dir: "desc" }).map((b) => b.occurrences),
    ).toEqual([100, 9, 9]);
    expect(
      sortDowntimeEventRows(bars, { by: "occurrences", dir: "asc" }).map((b) => b.occurrences),
    ).toEqual([9, 9, 100]);
  });

  // Ties fall back to the label so paging through the table is stable.
  it("breaks occurrence ties on the label", () => {
    expect(
      sortDowntimeEventRows(bars, { by: "occurrences", dir: "desc" }).map((b) => b.label),
    ).toEqual(["Alpha", "beta", "gamma"]);
  });

  it("never mutates the array it was given", () => {
    const before = bars.map((b) => b.label);
    sortDowntimeEventRows(bars, { by: "reason", dir: "desc" });
    expect(bars.map((b) => b.label)).toEqual(before);
  });
});

// The six-state ladder, in the order lib/load-state.ts fixes. `no-params` first is
// not a preference: a gated useQuery reports `status: "pending"` FOREVER, so a
// ladder reading isPending first renders a skeleton that never resolves — the bug
// 2b33e1d fixed in two cards on this very page.
describe("selectDowntimeEventParetoState", () => {
  const REPORT_DATE = "2026-08-09T16:00:00Z";
  const data = breakdown([bucket("Machine_Stop", 1)]);
  const empty = breakdown([]);

  function select(overrides: Partial<Parameters<typeof selectDowntimeEventParetoState>[0]> = {}) {
    return selectDowntimeEventParetoState({
      hasParams: true,
      isPending: false,
      isError: false,
      data,
      reportDate: REPORT_DATE,
      ...overrides,
    });
  }

  it("puts no-params ahead of error and of pending", () => {
    expect(select({ hasParams: false, isError: true, isPending: true })).toBe("no-params");
  });

  it("puts error ahead of pending", () => {
    expect(select({ isError: true, isPending: true, data: undefined })).toBe("error");
  });

  it("reports pending while a real request is in flight", () => {
    expect(select({ isPending: true, data: undefined })).toBe("pending");
  });

  // A settled query with no data yet is still pending, not empty: reporting it as
  // an empty shift would be a claim the response has not made.
  it("reports pending when the query settled with no data", () => {
    expect(select({ isPending: false, data: undefined })).toBe("pending");
  });

  it("reports ready when buckets came back", () => {
    expect(select()).toBe("ready");
  });

  // THE SPLIT THAT MATTERS. The report's business day is 2026-08-09 in Jakarta
  // (16:00Z on the 9th is 23:00 local), so a watermark on or after it means the
  // pipeline has covered this shift.
  it("reports empty-loaded when the pipeline has reached this shift's day", () => {
    expect(select({ data: { ...empty, loadedThrough: "2026-08-09" } })).toBe("empty-loaded");
    expect(select({ data: { ...empty, loadedThrough: "2026-08-10" } })).toBe("empty-loaded");
  });

  // THE ONLY REACHABLE NON-ERROR STATE ON DAY ONE. oee.downtime_log_events ships
  // empty, so until the DAG runs every shift takes this path — and the flattering
  // reading, "nothing stopped this machine", is the wrong one (TODOS.md §8).
  it("reports empty-stale when the pipeline has not reached this shift's day", () => {
    expect(select({ data: { ...empty, loadedThrough: "2026-07-31" } })).toBe("empty-stale");
  });

  it("reports empty-stale when the log has never been loaded", () => {
    expect(select({ data: { ...empty, loadedThrough: null } })).toBe("empty-stale");
  });

  // Every failure to KNOW resolves to not-loaded, because the card must not claim
  // a clean shift it cannot vouch for.
  it("reports empty-stale when the report's date cannot be read", () => {
    expect(select({ data: empty, reportDate: null })).toBe("empty-stale");
  });
});
