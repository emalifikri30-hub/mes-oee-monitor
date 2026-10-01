import { describe, expect, it } from "vite-plus/test";

import {
  buildQualityPareto,
  selectQualityParetoState,
  sortQualityRows,
} from "@/lib/quality-pareto";

import type { QualityMeasure } from "@/lib/quality-pareto";
import type { RejectReasonBreakdown, RejectReasonBucket } from "@/lib/types";

const MINUTE = 60_000;

function bucket(overrides: Partial<RejectReasonBucket> = {}): RejectReasonBucket {
  return {
    reason: "NG_Over_Count",
    reasonCode: null,
    machineName: "Vertical Packer N",
    counterValue: 48,
    counterUnit: "CALENDER",
    quantity: 576,
    convertedUnit: "BAG",
    weightGram: 15_232,
    frequency: 48,
    durationMs: MINUTE,
    ...overrides,
  };
}

// Totals default to the sum of the buckets, which is what the server sends today.
// Tests that care about the denominator override them.
function breakdown(
  buckets: RejectReasonBucket[],
  overrides: Partial<RejectReasonBreakdown> = {},
): RejectReasonBreakdown {
  const weights = buckets.map((b) => b.weightGram).filter((w): w is number => w !== null);

  return {
    timeZone: "Asia/Jakarta",
    buckets,
    totalFrequency: buckets.reduce((n, b) => n + b.frequency, 0),
    totalDurationMs: buckets.reduce((n, b) => n + b.durationMs, 0),
    totalQuantity: buckets.reduce((n, b) => n + b.quantity, 0),
    // Null when nothing was weighed, mirroring sum() over an all-NULL set.
    totalWeightGram: weights.length === 0 ? null : weights.reduce((n, w) => n + w, 0),
    convertedUnit: "BAG",
    loadedThrough: "2026-08-02",
    ...overrides,
  };
}

const MEASURES: QualityMeasure[] = ["quantity", "weight", "frequency", "duration"];

describe("buildQualityPareto", () => {
  // THE WHOLE JUSTIFICATION FOR FOUR RADIOS. If the measures produced the same
  // ranking the control would be decoration — so this payload is built so that
  // each one puts a different counter first.
  const FOUR_WAY = [
    bucket({ reason: "Biggest_Qty", quantity: 900, weightGram: 1, frequency: 1, durationMs: 1 }),
    bucket({ reason: "Heaviest", quantity: 1, weightGram: 900, frequency: 1, durationMs: 1 }),
    bucket({ reason: "Most_Often", quantity: 1, weightGram: 1, frequency: 900, durationMs: 1 }),
    bucket({ reason: "Longest", quantity: 1, weightGram: 1, frequency: 1, durationMs: 900 }),
  ];

  it.each([
    ["quantity", "Biggest_Qty"],
    ["weight", "Heaviest"],
    ["frequency", "Most_Often"],
    ["duration", "Longest"],
  ] as const)("ranks by %s, putting %s first", (measure, expected) => {
    const model = buildQualityPareto(breakdown(FOUR_WAY), measure, null);

    expect(model.bars[0]?.reason).toBe(expected);
  });

  it.each(MEASURES)(
    "accumulates the measure it ranked by, so the line only rises (%s)",
    (measure) => {
      const model = buildQualityPareto(breakdown(FOUR_WAY), measure, null);

      const pcts = model.bars.map((bar) => bar.cumulativePct ?? 0);
      for (let i = 1; i < pcts.length; i++) {
        expect(pcts[i]!).toBeGreaterThanOrEqual(pcts[i - 1]!);
      }
      expect(pcts.at(-1)).toBe(100);
    },
  );

  // Rule 2 from lib/pareto-rank.ts. Equal today; not equal the day the endpoint
  // grows a LIMIT and an "Other" bucket.
  it.each(MEASURES)("divides by the response's total, not the sum of the bars (%s)", (measure) => {
    const bars = [
      bucket({ reason: "Only", quantity: 50, weightGram: 50, frequency: 50, durationMs: 50 }),
    ];
    // Every denominator doubled, so one bar accounting for "everything" is 50%.
    const model = buildQualityPareto(
      breakdown(bars, {
        totalQuantity: 100,
        totalWeightGram: 100,
        totalFrequency: 100,
        totalDurationMs: 100,
      }),
      measure,
      null,
    );

    // The last bar is pinned to 100 by definition, so read the raw share instead.
    expect(model.total).toBe(100);
    expect(model.bars[0]?.value).toBe(50);
  });

  // The null-denominator case the downtime version cannot have: a shift where no
  // counter was weighed at all.
  it("yields null percentages rather than NaN when nothing was weighed", () => {
    const bars = [
      bucket({ reason: "A", weightGram: null }),
      bucket({ reason: "B", weightGram: null }),
    ];
    const model = buildQualityPareto(breakdown(bars), "weight", null);

    expect(model.total).toBe(0);
    for (const bar of model.bars) {
      expect(bar.cumulativePct).toBeNull();
      expect(bar.isVitalFew).toBe(false);
    }
  });

  // THE ASSERTION THIS FILE EXISTS FOR. An unweighed counter must rank as zero
  // AND keep its null, because the table renders null as "not weighed" and 0 as
  // `0 gr`. Conflating them is how one silently becomes the other.
  it("ranks an unweighed counter as zero while keeping its weight null", () => {
    const bars = [
      bucket({ reason: "Weighed", weightGram: 2571 }),
      bucket({ reason: "Never_Weighed", weightGram: null }),
    ];
    const model = buildQualityPareto(breakdown(bars), "weight", null);

    const unweighed = model.bars.find((bar) => bar.reason === "Never_Weighed");
    expect(unweighed?.value).toBe(0);
    expect(unweighed?.weightGram).toBeNull();
    // And it ranks last, since zero is the bottom of a descending sort.
    expect(model.bars.at(-1)?.reason).toBe("Never_Weighed");
  });

  it("distinguishes a counter weighed at zero from one never weighed", () => {
    const bars = [
      bucket({ reason: "Weighed_Empty", weightGram: 0 }),
      bucket({ reason: "Never_Weighed", weightGram: null }),
    ];
    const model = buildQualityPareto(breakdown(bars), "quantity", null);

    const byReason = new Map(model.bars.map((bar) => [bar.reason, bar.weightGram]));
    expect(byReason.get("Weighed_Empty")).toBe(0);
    expect(byReason.get("Never_Weighed")).toBeNull();
  });

  // `plotValue` is what the chart plots, so it must be in the axis's own terms.
  // Minutes for a duration; the raw figure for the other three.
  it("scales only the duration measure for the axis, keeping the raw value beside it", () => {
    const bars = [bucket({ reason: "A", durationMs: 5 * MINUTE })];

    const duration = buildQualityPareto(breakdown(bars), "duration", null);
    expect(duration.bars[0]?.value).toBe(5 * MINUTE);
    expect(duration.bars[0]?.plotValue).toBe(5);
    expect(duration.bars[0]?.durationMs).toBe(5 * MINUTE);

    for (const measure of ["quantity", "weight", "frequency"] as const) {
      const model = buildQualityPareto(breakdown(bars), measure, null);
      expect(model.bars[0]?.plotValue).toBe(model.bars[0]?.value);
    }
  });

  // A key that embedded the ranking index would point somewhere else the moment
  // the measure toggle moved — which is a React key changing identity under a row
  // that did not change.
  it("keeps a bar's key stable when the measure re-ranks", () => {
    const data = breakdown(FOUR_WAY);

    const byQuantity = buildQualityPareto(data, "quantity", null);
    const byWeight = buildQualityPareto(data, "weight", null);

    const keyOf = (model: typeof byQuantity, reason: string) =>
      model.bars.find((bar) => bar.reason === reason)?.key;

    for (const reason of ["Biggest_Qty", "Heaviest", "Most_Often", "Longest"]) {
      expect(keyOf(byQuantity, reason)).toBe(keyOf(byWeight, reason));
    }
  });

  it("pins the last bar to exactly 100", () => {
    const bars = [
      bucket({ reason: "A", quantity: 1 }),
      bucket({ reason: "B", quantity: 1 }),
      bucket({ reason: "C", quantity: 1 }),
    ];
    const model = buildQualityPareto(breakdown(bars), "quantity", null);

    expect(model.bars.at(-1)?.cumulativePct).toBe(100);
  });

  it("breaks ties on the reason, stably across calls", () => {
    const bars = [bucket({ reason: "Zebra" }), bucket({ reason: "Alpha" })];
    const data = breakdown(bars);

    const first = buildQualityPareto(data, "quantity", null).bars.map((bar) => bar.reason);
    const second = buildQualityPareto(data, "quantity", null).bars.map((bar) => bar.reason);

    expect(first).toEqual(["Alpha", "Zebra"]);
    expect(second).toEqual(first);
  });

  it("counts the bar that crosses 80% as one of the vital few", () => {
    const bars = [
      bucket({ reason: "Big", quantity: 80 }),
      bucket({ reason: "Tail", quantity: 20 }),
    ];
    const model = buildQualityPareto(breakdown(bars), "quantity", null);

    expect(model.bars[0]?.isVitalFew).toBe(true);
    expect(model.bars[1]?.isVitalFew).toBe(false);
  });

  // The design requires a populated Machine Name, and this endpoint is scoped to
  // one report — so the report's own machine is the right fallback rather than a
  // guess. See buildQualityPareto's header.
  it("falls back to the report's machine when a bucket's name did not resolve", () => {
    const bars = [bucket({ reason: "A", machineName: null })];
    const model = buildQualityPareto(breakdown(bars), "quantity", "Vertical Packer N");

    expect(model.bars[0]?.machineName).toBe("Vertical Packer N");
  });

  it("leaves a bucket's own machine name untouched", () => {
    const bars = [bucket({ reason: "A", machineName: "Real Machine" })];
    const model = buildQualityPareto(breakdown(bars), "quantity", "Fallback");

    expect(model.bars[0]?.machineName).toBe("Real Machine");
  });

  it("still reports null when neither the bucket nor the report names a machine", () => {
    const bars = [bucket({ reason: "A", machineName: null })];
    const model = buildQualityPareto(breakdown(bars), "quantity", null);

    expect(model.bars[0]?.machineName).toBeNull();
  });

  // Both units are carried per bar AND the converted one per model, because a cell
  // reads the bucket's own unit and the axis reads the shift's.
  it("carries both units through, nulls included", () => {
    const bars = [bucket({ reason: "A", counterUnit: null, convertedUnit: null })];
    const model = buildQualityPareto(breakdown(bars, { convertedUnit: null }), "quantity", null);

    expect(model.bars[0]?.counterUnit).toBeNull();
    expect(model.bars[0]?.convertedUnit).toBeNull();
    expect(model.convertedUnit).toBeNull();
  });

  it("keeps the counter figure and the converted figure as separate numbers", () => {
    const bars = [bucket({ reason: "A", counterValue: 48, quantity: 576 })];
    const model = buildQualityPareto(breakdown(bars), "quantity", null);

    expect(model.bars[0]?.counterValue).toBe(48);
    expect(model.bars[0]?.quantity).toBe(576);
  });

  it("returns an empty model rather than reaching a domain computation", () => {
    expect(buildQualityPareto(undefined, "quantity", null)).toEqual({
      bars: [],
      total: 0,
      measure: "quantity",
      convertedUnit: null,
      isEmpty: true,
    });
    expect(buildQualityPareto(breakdown([]), "quantity", null).isEmpty).toBe(true);
  });
});

describe("sortQualityRows", () => {
  const bars = () =>
    buildQualityPareto(
      breakdown([
        bucket({ reason: "beta", quantity: 100, weightGram: 9, frequency: 2 }),
        bucket({ reason: "Alpha", quantity: 9, weightGram: 100, frequency: 30 }),
        bucket({ reason: "gamma", quantity: 50, weightGram: null, frequency: 1 }),
      ]),
      "quantity",
      null,
    ).bars;

  it("sorts by reason case-insensitively", () => {
    const rows = sortQualityRows(bars(), { by: "reason", dir: "asc" });

    expect(rows.map((row) => row.reason)).toEqual(["Alpha", "beta", "gamma"]);
  });

  it("reverses on desc", () => {
    const rows = sortQualityRows(bars(), { by: "reason", dir: "desc" });

    expect(rows.map((row) => row.reason)).toEqual(["gamma", "beta", "Alpha"]);
  });

  it.each(["quantity", "weight", "frequency"] as const)(
    "sorts %s numerically, not lexicographically",
    (by) => {
      const rows = sortQualityRows(bars(), { by, dir: "desc" });
      const values = rows.map((row) =>
        by === "quantity" ? row.quantity : by === "weight" ? row.weightGram : row.frequency,
      );

      // Nulls last, so compare only the numbers that are present.
      const present = values.filter((v): v is number => v !== null);
      expect(present).toEqual([...present].sort((a, b) => b - a));
    },
  );

  // THE RULE sortParetoRows GAINED FOR THIS TABLE. Absent is not "smallest": an
  // ascending weight sort must not open with the counters nobody weighed.
  it("sorts a null weight last in BOTH directions", () => {
    for (const dir of ["asc", "desc"] as const) {
      const rows = sortQualityRows(bars(), { by: "weight", dir });
      expect(rows.at(-1)?.reason).toBe("gamma");
    }
  });

  it("does not mutate the array it was given", () => {
    const original = bars();
    const before = original.map((row) => row.reason);

    sortQualityRows(original, { by: "reason", dir: "desc" });

    expect(original.map((row) => row.reason)).toEqual(before);
  });
});

describe("selectQualityParetoState", () => {
  const base = {
    hasParams: true,
    isPending: false,
    isError: false,
    data: breakdown([bucket()]),
    reportDate: "2026-08-01T16:00:00.000Z",
  };

  it("renders the chart when there are buckets", () => {
    expect(selectQualityParetoState(base)).toBe("ready");
  });

  // The gated-query trap: `no-params` MUST be read before `isPending`, or a card
  // renders a skeleton that never resolves. Unreachable from this card today,
  // which is exactly why the delegate is still tested.
  it("reports no-params before pending, even though the query looks pending", () => {
    expect(selectQualityParetoState({ ...base, hasParams: false, isPending: true })).toBe(
      "no-params",
    );
  });

  it("reports an error ahead of an empty result", () => {
    expect(selectQualityParetoState({ ...base, isError: true, data: breakdown([]) })).toBe("error");
  });

  it("reports pending while the first request is in flight", () => {
    expect(selectQualityParetoState({ ...base, isPending: true })).toBe("pending");
  });

  it("reports pending when there is no data yet, whatever the flags say", () => {
    expect(selectQualityParetoState({ ...base, data: undefined })).toBe("pending");
  });

  // THE SPLIT THAT MATTERS, and on this tab the stale side is the normal case:
  // the Gold table ships empty, so nothing has been loaded for any shift yet.
  it("separates a genuinely clean shift from one that has not loaded", () => {
    const loaded = breakdown([], { loadedThrough: "2026-08-02" });
    const stale = breakdown([], { loadedThrough: "2026-07-31" });
    const never = breakdown([], { loadedThrough: null });

    expect(selectQualityParetoState({ ...base, data: loaded })).toBe("empty-loaded");
    expect(selectQualityParetoState({ ...base, data: stale })).toBe("empty-stale");
    expect(selectQualityParetoState({ ...base, data: never })).toBe("empty-stale");
  });

  it("treats an unreadable report date as not loaded rather than clean", () => {
    const data = breakdown([], { loadedThrough: "2026-08-02" });

    expect(selectQualityParetoState({ ...base, data, reportDate: undefined })).toBe("empty-stale");
  });
});
