import { describe, expect, it } from "vite-plus/test";

import { buildPareto, selectParetoState, sortReasonRows } from "@/lib/pareto";

import type { DowntimeReasonBreakdown, DowntimeReasonBucket } from "@/lib/types";

const MINUTE = 60_000;

function bucket(overrides: Partial<DowntimeReasonBucket> = {}): DowntimeReasonBucket {
  return {
    reason: "Mlipit",
    workUnitNames: ["Vertical Packer MJCL"],
    frequency: 1,
    durationMs: 10 * MINUTE,
    ...overrides,
  };
}

// Totals default to the sum of the buckets, which is what the server sends
// today. Tests that care about the denominator override them.
function breakdown(
  buckets: DowntimeReasonBucket[],
  overrides: Partial<DowntimeReasonBreakdown> = {},
): DowntimeReasonBreakdown {
  return {
    from: "2026-08-09T00:00:00.000Z",
    to: "2026-08-09T08:00:00.000Z",
    timeZone: "Asia/Jakarta",
    category: "UNPLANNED",
    buckets,
    // No tail: these fixtures return every bucket.
    other: null,
    totalFrequency: buckets.reduce((n, b) => n + b.frequency, 0),
    totalDurationMs: buckets.reduce((n, b) => n + b.durationMs, 0),
    loadedThrough: "2026-08-10",
    ...overrides,
  };
}

describe("buildPareto", () => {
  // THE WHOLE JUSTIFICATION FOR THE MEASURE TOGGLE. If both measures produced
  // the same ranking the control would be decoration.
  it("ranks by the chosen measure, not always by duration", () => {
    const rows = [
      bucket({ reason: "Long but rare", frequency: 1, durationMs: 40 * MINUTE }),
      bucket({ reason: "Short but constant", frequency: 9, durationMs: 9 * MINUTE }),
    ];

    expect(buildPareto(breakdown(rows), "duration").bars[0]?.label).toBe("Long but rare");
    expect(buildPareto(breakdown(rows), "frequency").bars[0]?.label).toBe("Short but constant");
  });

  it.each(["duration", "frequency"] as const)("orders %s descending", (measure) => {
    const rows = [
      bucket({ reason: "A", frequency: 2, durationMs: 5 * MINUTE }),
      bucket({ reason: "B", frequency: 9, durationMs: 40 * MINUTE }),
      bucket({ reason: "C", frequency: 5, durationMs: 20 * MINUTE }),
    ];

    const values = buildPareto(breakdown(rows), measure).bars.map((b) => b.value);

    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  // Accumulating a different measure than the one being ranked draws a
  // non-monotonic line, which is the classic Pareto bug.
  it("accumulates the measure it ranked by, so the line only ever rises", () => {
    const rows = [
      bucket({ reason: "A", frequency: 5, durationMs: 1 * MINUTE }),
      bucket({ reason: "B", frequency: 3, durationMs: 40 * MINUTE }),
      bucket({ reason: "C", frequency: 2, durationMs: 20 * MINUTE }),
    ];

    const pcts = buildPareto(breakdown(rows), "frequency").bars.map((b) => b.cumulativePct);

    expect(pcts).toEqual([50, 80, 100]);
  });

  it("gives a different cumulative line for each measure over one payload", () => {
    const rows = [
      bucket({ reason: "A", frequency: 5, durationMs: 1 * MINUTE }),
      bucket({ reason: "B", frequency: 3, durationMs: 40 * MINUTE }),
      bucket({ reason: "C", frequency: 2, durationMs: 20 * MINUTE }),
    ];

    const byFrequency = buildPareto(breakdown(rows), "frequency").bars.map((b) => b.cumulativePct);
    const byDuration = buildPareto(breakdown(rows), "duration").bars.map((b) => b.cumulativePct);

    expect(byFrequency).not.toEqual(byDuration);
  });

  // Floating-point division leaves the last bar a hair under 100, which draws a
  // line stopping just below the top gridline.
  it("pins the last bar to exactly 100", () => {
    const rows = [
      bucket({ reason: "A", durationMs: 1 * MINUTE }),
      bucket({ reason: "B", durationMs: 1 * MINUTE }),
      bucket({ reason: "C", durationMs: 1 * MINUTE }),
    ];

    const bars = buildPareto(breakdown(rows), "duration").bars;

    expect(bars.at(-1)?.cumulativePct).toBe(100);
  });

  // Every unplanned stop still being open is a real shift, not a bug.
  it("yields null percentages rather than NaN when the total is zero", () => {
    const rows = [
      bucket({ reason: "A", frequency: 1, durationMs: 0 }),
      bucket({ reason: "B", frequency: 1, durationMs: 0 }),
    ];

    const model = buildPareto(breakdown(rows), "duration");

    expect(model.total).toBe(0);
    for (const bar of model.bars) {
      expect(bar.cumulativePct).toBeNull();
      expect(bar.isVitalFew).toBe(false);
    }
  });

  // Equal today; not equal the day the endpoint grows a LIMIT and an "Other"
  // bucket, which is exactly when a silently wrong denominator would ship.
  it("divides by the response's total, not by the sum of the bars", () => {
    const rows = [bucket({ reason: "A", durationMs: 10 * MINUTE })];

    const model = buildPareto(breakdown(rows, { totalDurationMs: 20 * MINUTE }), "duration");

    expect(model.total).toBe(20 * MINUTE);
    // THE ONE BAR IS HALF THE SHIFT'S UNPLANNED TIME, AND THE LINE SAYS SO.
    //
    // This asserted 100 until the endpoint learned to truncate. The last bar was
    // pinned unconditionally, on the reasoning that it is the whole total by
    // definition — which held while every bucket came back and is false now. The
    // pin only absorbs float drift; a real shortfall reaches the chart intact,
    // which is what makes a truncated Pareto legible as one.
    expect(model.bars[0]?.cumulativePct).toBe(50);
  });

  it("returns an empty model rather than reaching a domain computation", () => {
    expect(buildPareto(breakdown([]), "duration")).toEqual({
      bars: [],
      total: 0,
      measure: "duration",
      isEmpty: true,
    });
    expect(buildPareto(undefined, "duration").isEmpty).toBe(true);
  });

  it("breaks ties alphabetically and stably across calls", () => {
    const rows = [
      bucket({ reason: "Zebra", durationMs: 10 * MINUTE }),
      bucket({ reason: "Apple", durationMs: 10 * MINUTE }),
    ];

    const once = buildPareto(breakdown(rows), "duration").bars.map((b) => b.label);
    const twice = buildPareto(breakdown(rows), "duration").bars.map((b) => b.label);

    expect(once).toEqual(["Apple", "Zebra"]);
    expect(twice).toEqual(once);
  });

  // Inclusive: the bar that crosses 80% is part of what you fix, not the start
  // of the tail you ignore.
  it("counts the bar that crosses 80% as one of the vital few", () => {
    const rows = [
      bucket({ reason: "A", durationMs: 50 * MINUTE }),
      bucket({ reason: "B", durationMs: 30 * MINUTE }),
      bucket({ reason: "C", durationMs: 20 * MINUTE }),
    ];

    const bars = buildPareto(breakdown(rows), "duration").bars;

    expect(bars.map((b) => b.cumulativePct)).toEqual([50, 80, 100]);
    expect(bars.map((b) => b.isVitalFew)).toEqual([true, true, false]);
  });

  it("marks a single reason accounting for everything as the vital few", () => {
    const model = buildPareto(breakdown([bucket({ durationMs: 30 * MINUTE })]), "duration");

    expect(model.bars[0]?.isVitalFew).toBe(true);
    expect(model.bars[0]?.cumulativePct).toBe(100);
  });

  // The axis reads minutes and the tooltip formats the raw ms. Deriving one from
  // the other at render time is how the two drift.
  it("carries minutes and raw milliseconds side by side", () => {
    const model = buildPareto(breakdown([bucket({ durationMs: 90_000 })]), "duration");

    expect(model.bars[0]?.durationMinutes).toBe(1.5);
    expect(model.bars[0]?.durationMs).toBe(90_000);
  });

  it("labels the unlabelled bucket without filtering or reordering it", () => {
    const rows = [
      bucket({ reason: null, durationMs: 40 * MINUTE }),
      bucket({ reason: "Mlipit", durationMs: 10 * MINUTE }),
    ];

    const bars = buildPareto(breakdown(rows), "duration").bars;

    expect(bars.map((b) => b.label)).toEqual(["Unspecified", "Mlipit"]);
  });

  it("joins several machine names and nulls an empty list", () => {
    const rows = [
      bucket({ reason: "A", workUnitNames: ["Packer N", "Packer S"] }),
      bucket({ reason: "B", workUnitNames: [] }),
    ];

    const bars = buildPareto(breakdown(rows), "duration").bars;

    expect(bars.find((b) => b.label === "A")?.machineName).toBe("Packer N, Packer S");
    expect(bars.find((b) => b.label === "B")?.machineName).toBeNull();
  });
});

describe("sortReasonRows", () => {
  const BARS = buildPareto(
    breakdown([
      bucket({ reason: "ganti film", durationMs: 9 * MINUTE }),
      bucket({ reason: "Camera Inspection", durationMs: 100 * MINUTE }),
      bucket({ reason: "Mlipit", durationMs: 47 * MINUTE }),
    ]),
    "duration",
  ).bars;

  it("sorts by reason case-insensitively", () => {
    const labels = sortReasonRows(BARS, { by: "reason", dir: "asc" }).map((b) => b.label);

    expect(labels).toEqual(["Camera Inspection", "ganti film", "Mlipit"]);
  });

  it("reverses on desc", () => {
    const asc = sortReasonRows(BARS, { by: "reason", dir: "asc" }).map((b) => b.label);
    const desc = sortReasonRows(BARS, { by: "reason", dir: "desc" }).map((b) => b.label);

    expect(desc).toEqual([...asc].reverse());
  });

  // Lexicographic ordering would put 100 before 9, which is the bug a naive
  // string sort on a formatted duration would produce.
  it("sorts duration numerically, not lexicographically", () => {
    const minutes = sortReasonRows(BARS, { by: "duration", dir: "asc" }).map(
      (b) => b.durationMinutes,
    );

    expect(minutes).toEqual([9, 47, 100]);
  });

  it("does not mutate the array it was given", () => {
    const before = BARS.map((b) => b.label);
    sortReasonRows(BARS, { by: "reason", dir: "desc" });

    expect(BARS.map((b) => b.label)).toEqual(before);
  });
});

describe("selectParetoState", () => {
  const DATA = breakdown([bucket()]);
  const BASE = {
    hasParams: true,
    isPending: false,
    isError: false,
    data: DATA,
    reportDate: "2026-08-09T00:00:00.000Z",
  };

  it("renders the chart when there are buckets", () => {
    expect(selectParetoState(BASE)).toBe("ready");
  });

  // THE ORDERING THAT MATTERS. A gated query reports pending forever, so reading
  // isPending first renders a skeleton that never resolves — the bug that
  // shipped in two other cards on this page.
  it("reports no-params before pending, even though the query looks pending", () => {
    expect(selectParetoState({ ...BASE, hasParams: false, isPending: true, data: undefined })).toBe(
      "no-params",
    );
  });

  it("reports an error ahead of an empty result", () => {
    expect(selectParetoState({ ...BASE, isError: true, data: undefined })).toBe("error");
  });

  it("reports pending while the first request is in flight", () => {
    expect(selectParetoState({ ...BASE, isPending: true, data: undefined })).toBe("pending");
  });

  // Data can be undefined without isPending during a refetch error recovery, and
  // treating that as "empty" would claim a clean shift on no evidence at all.
  it("reports pending when there is no data yet, whatever the flags say", () => {
    expect(selectParetoState({ ...BASE, data: undefined })).toBe("pending");
  });

  // The two empty states that must never be confused: one says the machine ran
  // clean, the other says the card cannot tell.
  it("separates a genuinely clean shift from one that has not loaded", () => {
    const empty = breakdown([], { loadedThrough: "2026-08-10" });
    const stale = breakdown([], { loadedThrough: "2026-08-08" });
    const never = breakdown([], { loadedThrough: null });

    expect(selectParetoState({ ...BASE, data: empty })).toBe("empty-loaded");
    expect(selectParetoState({ ...BASE, data: stale })).toBe("empty-stale");
    expect(selectParetoState({ ...BASE, data: never })).toBe("empty-stale");
  });

  it("treats an unreadable report date as not loaded rather than clean", () => {
    const empty = breakdown([], { loadedThrough: "2026-08-10" });

    expect(selectParetoState({ ...BASE, data: empty, reportDate: "" })).toBe("empty-stale");
  });
});

// ---------------------------------------------------------------------------
// The truncated tail (TODOS §25)
// ---------------------------------------------------------------------------
//
// The endpoint returns the top N by the requested measure and folds everything
// else into `other`. buildPareto turns that into one more bar, and the three
// rules below are what make a truncated Pareto readable rather than a lie:
//
//   1. It is PINNED LAST, whatever its size. A Pareto opening with "Other" is not
//      a Pareto — the bars to the left are the claim about what to fix first.
//   2. It is NEVER VITAL FEW. "And also fix the other 37 reasons" is true and is
//      not an action.
//   3. The cumulative line runs THROUGH it to 100, which is what makes a shown set
//      covering 55% of the total legible as covering 55%.
describe("buildPareto — the Other bar", () => {
  const TAIL = { reasonCount: 37, frequency: 40, durationMs: 60 * MINUTE };

  function truncated() {
    return breakdown(
      [
        bucket({ reason: "A", frequency: 5, durationMs: 30 * MINUTE }),
        bucket({ reason: "B", frequency: 3, durationMs: 10 * MINUTE }),
      ],
      {
        other: TAIL,
        // The whole window: the two shown buckets PLUS the tail.
        totalFrequency: 5 + 3 + 40,
        totalDurationMs: (30 + 10 + 60) * MINUTE,
      },
    );
  }

  it("adds no bar when nothing was truncated", () => {
    const model = buildPareto(breakdown([bucket({ reason: "A" })]), "duration");

    expect(model.bars).toHaveLength(1);
    expect(model.bars.some((bar) => bar.isOther)).toBe(false);
  });

  it("appends one bar carrying the tail's own figures", () => {
    const model = buildPareto(truncated(), "duration");

    expect(model.bars).toHaveLength(3);
    const other = model.bars.at(-1);
    expect(other).toMatchObject({
      isOther: true,
      frequency: TAIL.frequency,
      durationMs: TAIL.durationMs,
    });
  });

  // The count is the point of the label: "Other" alone does not say whether one
  // reason was folded in or two hundred.
  it("names how many reasons it stands for", () => {
    expect(buildPareto(truncated(), "duration").bars.at(-1)?.label).toBe("Other (37 reasons)");
  });

  it("says reason, singular, when it stands for one", () => {
    const model = buildPareto(
      breakdown([bucket({ reason: "A", durationMs: 30 * MINUTE })], {
        other: { reasonCount: 1, frequency: 1, durationMs: 10 * MINUTE },
        totalFrequency: 2,
        totalDurationMs: 40 * MINUTE,
      }),
      "duration",
    );

    expect(model.bars.at(-1)?.label).toBe("Other (1 reason)");
  });

  // RULE 1, and the case that proves it: a tail LARGER than every shown bar still
  // sorts last. Ranked purely by value it would open the chart.
  it("pins the tail last even when it is the biggest bar", () => {
    const model = buildPareto(truncated(), "duration");

    expect(model.bars.at(-1)?.isOther).toBe(true);
    expect(model.bars.at(-1)!.value).toBeGreaterThan(model.bars[0]!.value);
  });

  // RULE 2. Here the two shown bars cover 40% of the total, so the tail is the bar
  // that crosses 80% — and it must still not be highlighted.
  it("never marks the tail as vital few", () => {
    const model = buildPareto(truncated(), "duration");

    expect(model.bars.at(-1)?.isVitalFew).toBe(false);
    expect(model.bars[0]?.isVitalFew).toBe(true);
  });

  // RULE 3. 30 of 100 minutes, then 40, then the tail closes it.
  it("runs the cumulative line through the tail to 100", () => {
    const model = buildPareto(truncated(), "duration");

    expect(model.bars.map((bar) => bar.cumulativePct)).toEqual([30, 40, 100]);
  });

  // THE TAIL NAMES NO BUCKET, so it must not offer a drill-down. `reason: null` is
  // also the UNLABELLED bucket's value, which the detail endpoint CAN resolve — so
  // `isOther` is the only thing that separates them, and anything building a link
  // has to read it rather than the reason.
  it("carries no reason, so nothing can build a drill-down from it", () => {
    const model = buildPareto(truncated(), "duration");
    const other = model.bars.at(-1);

    expect(other?.reason).toBeNull();
    expect(other?.isOther).toBe(true);
    // The unlabelled bucket is the other null-reason bar, and it is NOT the tail.
    const unlabelled = buildPareto(breakdown([bucket({ reason: null })]), "duration").bars[0];
    expect(unlabelled?.reason).toBeNull();
    expect(unlabelled?.isOther).toBe(false);
  });

  // The tail's two figures are both real, so switching measure re-ranks it against
  // the shown bars on the new measure — and it stays last regardless.
  it("keeps the tail last under either measure", () => {
    for (const measure of ["duration", "frequency"] as const) {
      const model = buildPareto(truncated(), measure);
      expect(model.bars.at(-1)?.isOther, measure).toBe(true);
    }
  });
});
