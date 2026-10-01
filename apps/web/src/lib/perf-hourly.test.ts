import { describe, it, expect } from "vite-plus/test";

import {
  buildHourlyOutput,
  buildHourOfDayOutput,
  buildLineHourOfDayOutput,
  buildLineHourlyOutput,
  qtyDomainFor,
  ratePerHour,
} from "./perf-hourly";

import type { LinePerfHourBucket } from "./types";

import type {
  HourOfDayProfile,
  HourProfileBucket,
  PerfHourBucket,
  ShiftPerformance,
} from "./types";

const JAKARTA = "Asia/Jakarta";
const CHICAGO = "America/Chicago";

// Shift 3 of business day 2026-08-01 at UTC+7: 23:00 local is 16:00Z the same day.
// The shift that crosses midnight, and the one every ordering bug shows up on.
const SHIFT_3_START = Date.parse("2026-08-01T16:00:00Z");
const HOUR = 3_600_000;

function bucket(overrides: Partial<PerfHourBucket> = {}): PerfHourBucket {
  const start = overrides.bucketStart ?? new Date(SHIFT_3_START).toISOString();
  return {
    bucketStart: start,
    bucketEnd: new Date(Date.parse(start) + HOUR).toISOString(),
    hourOfDay: 23,
    shiftHourSeq: 0,
    productId: 4,
    productName: "SKU Line 4",
    productCode: "SKU-4",
    uomCode: "BAG",
    totalOut: 34_304,
    effectiveOut: 34_140,
    runtime: 2_845_000,
    idealRatePerHour: 43_200,
    ...overrides,
  };
}

// `seq` hours after the shift start, so a whole shift can be written compactly.
function at(seq: number, overrides: Partial<PerfHourBucket> = {}): PerfHourBucket {
  const start = new Date(SHIFT_3_START + seq * HOUR).toISOString();
  return bucket({ bucketStart: start, shiftHourSeq: seq, ...overrides });
}

function payload(
  buckets: PerfHourBucket[],
  overrides: Partial<ShiftPerformance> = {},
): ShiftPerformance {
  return { timeZone: JAKARTA, buckets, loadedThrough: "2026-08-02", ...overrides };
}

describe("ratePerHour", () => {
  // The figure from the reference design, and it reproduces to 3 decimals against
  // the generated column in Postgres: 34304 BAG in 2 845 000 ms is 43407.522/hour.
  it("divides quantity by the hours actually run", () => {
    expect(ratePerHour(34_304, 2_845_000)).toBeCloseTo(43_407.522, 3);
  });

  // A rate is qty over RUNTIME, not over the bucket. This is the distinction the
  // whole drill-down exists for: it separates "we were slow" from "we were stopped".
  it("uses runtime rather than the bucket length", () => {
    // A quarter-hour run that made 10k is 40k/hour, not 10k/hour.
    expect(ratePerHour(10_000, HOUR / 4)).toBe(40_000);
  });

  // 0/0 and n/0 are both "no rate observed". Neither is 0 and neither is Infinity —
  // one would read as a stopped machine that made things, the other would blow the
  // y-axis domain to Infinity and render nothing at all.
  it("is null when nothing ran, never Infinity or zero", () => {
    expect(ratePerHour(0, 0)).toBeNull();
    expect(ratePerHour(100, 0)).toBeNull();
    expect(ratePerHour(100, -5)).toBeNull();
  });

  it("is null when the quantity is missing", () => {
    expect(ratePerHour(null, HOUR)).toBeNull();
    expect(ratePerHour(100, null)).toBeNull();
  });
});

describe("buildHourlyOutput axis", () => {
  // THE regression the ordering design exists for. The reference mock renders shift
  // 3 as 00:00-01:00 … 06:00-07:00 with 23:00-00:00 LAST, which is what sorting by
  // the clock label does. Shift 3 STARTS at 23:00.
  it("puts the 23:00 bucket first for shift 3, not last", () => {
    const model = buildHourlyOutput(payload([at(0), at(1), at(7)]));
    const labels = model.buckets.map((b) => b.label);

    expect(labels[0]).toBe("23:00:00 - 00:00:00");
    expect(labels.at(-1)).toBe("06:00:00 - 07:00:00");
    expect(labels.at(-1)).not.toBe("23:00:00 - 00:00:00");
  });

  // Not `24:00:00`, which some locales produce without hourCycle: "h23" — and which
  // would read as a 25th hour of the day.
  it("renders midnight as 00:00:00", () => {
    const model = buildHourlyOutput(payload([at(0)]));

    expect(model.buckets[0]?.label).toBe("23:00:00 - 00:00:00");
  });

  // The labels are the PLANT's clock, not the browser's and not UTC. At UTC-5 the
  // same instant is a different wall-clock hour.
  it("labels buckets in the plant's zone", () => {
    const model = buildHourlyOutput(payload([at(0)], { timeZone: CHICAGO }));

    expect(model.buckets[0]?.label).toBe("11:00:00 - 12:00:00");
  });

  // An idle hour produces NO ROW, so an axis taken from the rows would close the
  // gap and join hour 0 to hour 2 with a straight line implying production nobody
  // made. The axis is stepped, so the hole stays visible.
  it("fills an interior hour that returned no rows at all", () => {
    const model = buildHourlyOutput(payload([at(0), at(2)]));

    expect(model.buckets).toHaveLength(3);
    expect(model.buckets[1]?.label).toBe("00:00:00 - 01:00:00");
    // And the missing hour is a gap, not a zero.
    expect(model.skus[0]?.points[1]?.totalOut).toBeNull();
  });

  it("has one bucket per hour across a whole eight-hour shift", () => {
    const model = buildHourlyOutput(payload([0, 1, 2, 3, 4, 5, 6, 7].map((seq) => at(seq))));

    expect(model.buckets).toHaveLength(8);
  });

  it("is empty when the shift returned no rows", () => {
    const model = buildHourlyOutput(payload([]));

    expect(model.buckets).toEqual([]);
    expect(model.skus).toEqual([]);
  });
});

describe("buildHourlyOutput series", () => {
  // Dense: recharts needs one point per x tick per line, or the series silently
  // shifts left and every point lands under the wrong hour.
  it("gives every SKU one point per bucket, in axis order", () => {
    const model = buildHourlyOutput(
      payload([at(0), at(1), at(1, { productId: 9, productName: "SKU Other" })]),
    );

    for (const sku of model.skus) {
      expect(sku.points).toHaveLength(model.buckets.length);
      expect(sku.points.map((p) => p.key)).toEqual(model.buckets.map((b) => b.key));
    }
  });

  // Null, not 0. A 0 draws a line down to the axis and reads as "we ran this SKU
  // and it made nothing", which is a different and much worse claim.
  it("uses null for an hour a SKU did not run", () => {
    const model = buildHourlyOutput(
      payload([at(0), at(1, { productId: 9, productName: "SKU Other" })]),
    );

    const other = model.skus.find((s) => s.productId === 9);
    expect(other?.points[0]?.totalOut).toBeNull();
    expect(other?.points[0]?.actualRatePerHour).toBeNull();
    expect(other?.points[1]?.totalOut).toBe(34_304);
  });

  // A bucket CAN legitimately carry output with zero recorded runtime — the schema
  // forbids it, but bad data worth seeing should be seen. The quantity renders; only
  // the rate gaps.
  it("keeps the quantity but gaps the rate when a bucket recorded no runtime", () => {
    const model = buildHourlyOutput(payload([at(0, { totalOut: 500, runtime: 0 })]));
    const point = model.skus[0]?.points[0];

    expect(point?.totalOut).toBe(500);
    expect(point?.actualRatePerHour).toBeNull();
  });

  // Not drawn at zero: a zero standard is a target of "make nothing", and a
  // COALESCE to the actual rate would make the loss vanish entirely.
  it("reports hasMasterRate false when no bucket carried a standard", () => {
    const model = buildHourlyOutput(payload([at(0, { idealRatePerHour: null })]));

    expect(model.skus[0]?.hasMasterRate).toBe(false);
    expect(model.skus[0]?.points[0]?.idealRatePerHour).toBeNull();
  });

  it("reports hasMasterRate true when any bucket carried one", () => {
    const model = buildHourlyOutput(payload([at(0, { idealRatePerHour: null }), at(1)]));

    expect(model.skus[0]?.hasMasterRate).toBe(true);
  });

  it("flags a SKU whose every bucket is empty", () => {
    const model = buildHourlyOutput(
      payload([at(0), at(1, { productId: 9, productName: "SKU Other" })]),
    );

    expect(model.skus.find((s) => s.productId === 4)?.isEmpty).toBe(false);
    // SKU 9 ran in bucket 1, so it is not empty either — this pins that `isEmpty`
    // means "no output anywhere", not "missing from some bucket".
    expect(model.skus.find((s) => s.productId === 9)?.isEmpty).toBe(false);
  });

  // core-api orders by product_name then product_id; the browser must not re-sort
  // and risk a different answer from the same data.
  it("preserves core-api's SKU order", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { productId: 9, productName: "AAA" }),
        at(0, { productId: 4, productName: "ZZZ" }),
      ]),
    );

    expect(model.skus.map((s) => s.productId)).toEqual([9, 4]);
  });
});

describe("buildHourlyOutput averages", () => {
  // The headline correctness property. Two full hours at 1000/h plus a three-minute
  // sliver at 2000/h: the mean of rates is 1333.3, the truth is 1024.4. Both figures
  // were verified against Postgres 18.4 with the same rows.
  it("weights the average rate by runtime rather than averaging the rates", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { totalOut: 1000, runtime: HOUR, idealRatePerHour: 1200 }),
        at(1, { totalOut: 1000, runtime: HOUR, idealRatePerHour: 1200 }),
        at(2, { totalOut: 100, runtime: 180_000, idealRatePerHour: 1200 }),
      ]),
    );

    expect(model.avgRatePerHour).toBeCloseTo(1024.4, 1);
    // The wrong answer, named so nobody "fixes" the function into producing it.
    expect(model.avgRatePerHour).not.toBeCloseTo(1333.3, 1);
  });

  it("ignores buckets with no runtime when weighting", () => {
    const model = buildHourlyOutput(
      payload([at(0, { totalOut: 1000, runtime: HOUR }), at(1, { totalOut: 0, runtime: 0 })]),
    );

    expect(model.avgRatePerHour).toBe(1000);
  });

  it("has a null average rate when nothing ran at all", () => {
    const model = buildHourlyOutput(payload([at(0, { totalOut: 0, runtime: 0 })]));

    expect(model.avgRatePerHour).toBeNull();
  });

  // The denominator is the buckets the SKU RAN, not every bucket on the axis.
  // Dividing by all eight would make a SKU's average a function of the shift's
  // product mix rather than of its own output.
  it("divides average output by the buckets the SKU ran, not by the axis length", () => {
    const model = buildHourlyOutput(
      payload([at(0, { totalOut: 1000 }), at(1, { totalOut: 500 }), at(5, { totalOut: 300 })]),
    );

    // Axis spans 6 hours; the SKU ran in 3 of them.
    expect(model.buckets).toHaveLength(6);
    expect(model.avgOutPerRunBucket).toBeCloseTo(600, 6);
  });

  // BAG and CARTON do not average. A mixed shift reports nothing shift-wide rather
  // than a plausible wrong number; per-SKU figures are still fine, because each
  // block is single-unit.
  it("suppresses shift-wide averages when the SKUs mix units of measure", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { totalOut: 1000, runtime: HOUR }),
        at(0, {
          productId: 9,
          productName: "SKU Other",
          uomCode: "CARTON",
          totalOut: 5,
          runtime: HOUR,
        }),
      ]),
    );

    expect(model.uomCode).toBeNull();
    expect(model.avgRatePerHour).toBeNull();
    expect(model.avgOutPerRunBucket).toBeNull();
    // Per-SKU averages survive.
    expect(model.skus[0]?.avgRatePerHour).toBe(1000);
    expect(model.skus[1]?.avgRatePerHour).toBe(5);
  });

  it("reports the shared unit when every SKU agrees", () => {
    const model = buildHourlyOutput(
      payload([at(0), at(0, { productId: 9, productName: "SKU Other" })]),
    );

    expect(model.uomCode).toBe("BAG");
  });
});

// THE DEFECT THE PER-UNIT DOMAIN FIXES, and it is live at MACHINE grain today —
// it is not only groundwork for the line chart.
//
// A shift running two SKUs counted in different units gets one chart block each.
// With one shared domain, a block whose figures are in the hundreds is drawn
// against an axis scaled by a block whose figures are in the tens of thousands:
// its line sits flat along the bottom and reads as a machine that made almost
// nothing. `performance-chart.tsx` labelled the axis "Mixed units", which said the
// right thing over shapes that were still being drawn as comparable — and the
// shape is what a reader actually takes away from a chart.
describe("buildHourlyOutput domains — one per unit", () => {
  it("scales each unit's block by its own magnitude, not by the largest", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { totalOut: 50_000, effectiveOut: 40_000 }),
        at(0, {
          productId: 9,
          productName: "Other",
          uomCode: "CALENDER",
          totalOut: 300,
          effectiveOut: 250,
        }),
      ]),
    );

    expect(qtyDomainFor(model, "BAG")).toEqual([0, 50_000]);
    // 300, not 50000 — which is the whole point. Shared, the CALENDER block would
    // be drawn at 0.6% of its axis.
    expect(qtyDomainFor(model, "CALENDER")).toEqual([0, 300]);
  });

  // THE SINGLE-UNIT CASE MUST NOT CHANGE. It is the common one, and this reduces
  // to exactly the old behaviour for it.
  it("is unchanged when every SKU shares a unit", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { totalOut: 500, effectiveOut: 400 }),
        at(0, { productId: 9, productName: "Other", totalOut: 900, effectiveOut: 800 }),
      ]),
    );

    expect(Object.keys(model.qtyDomains)).toEqual(["BAG"]);
    expect(qtyDomainFor(model, "BAG")).toEqual([0, 900]);
  });

  // THE FALLBACK IS THE WIDEST, and the direction is deliberate: a series drawn
  // slightly small is readable, one drawn off the top of its block is not.
  it("falls back to the widest domain for an unknown unit", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { totalOut: 500, effectiveOut: 400 }),
        at(0, {
          productId: 9,
          productName: "Other",
          uomCode: "CALENDER",
          totalOut: 9000,
          effectiveOut: 8000,
        }),
      ]),
    );

    expect(qtyDomainFor(model, "PALLET")).toEqual([0, 9000]);
  });
});

describe("buildHourlyOutput domains", () => {
  // THROUGH qtyDomainFor, not off a shared field. There is a domain PER UNIT now:
  // one shared by every series scales a CALENDER block by a BAG block's
  // magnitude, and the axis label saying "Mixed units" did not stop the shapes
  // being drawn as comparable. The fixture is single-unit BAG, so these read the
  // same numbers they always did.
  it("always includes zero so the baseline is meaningful", () => {
    const model = buildHourlyOutput(payload([at(0, { totalOut: 500, effectiveOut: 400 })]));

    expect(qtyDomainFor(model, "BAG")[0]).toBe(0);
    expect(qtyDomainFor(model, "BAG")[1]).toBe(500);
  });

  // Negative values are real data — a machine that outran its standard — and are
  // shown as-is. This is the OPPOSITE of lib/waterfall.ts, which clamps deliberately.
  it("extends below zero rather than clamping a negative measure", () => {
    const model = buildHourlyOutput(payload([at(0, { totalOut: 500, effectiveOut: -120 })]));

    expect(qtyDomainFor(model, "BAG")[0]).toBe(-120);
    expect(model.skus[0]?.points[0]?.effectiveOut).toBe(-120);
  });

  // Quantities and rates get separate domains because they are different units —
  // BAG against BAG/hour. Sharing one axis only looks sensible when every bucket is
  // a near-full hour, which is exactly the case a losses drill-down is not about.
  it("keeps the quantity and rate domains separate", () => {
    const model = buildHourlyOutput(
      payload([at(0, { totalOut: 10_000, effectiveOut: 9_500, runtime: HOUR / 4 })]),
    );

    // 10 000 BAG made in a quarter of an hour: the quantity axis tops out at
    // 10 000, the rate axis at 43 200 (the standard beats the 40 000/h achieved).
    // On one shared axis these would sit 4x apart for no reason a reader could use.
    expect(qtyDomainFor(model, "BAG")[1]).toBe(10_000);
    expect(model.rateDomain[1]).toBe(43_200);
  });

  // Shared across blocks, so small multiples can be read against each other.
  it("spans every SKU so the blocks are comparable", () => {
    const model = buildHourlyOutput(
      payload([
        at(0, { totalOut: 100, effectiveOut: 90 }),
        at(0, { productId: 9, productName: "SKU Other", totalOut: 9000, effectiveOut: 8900 }),
      ]),
    );

    expect(qtyDomainFor(model, "BAG")[1]).toBe(9000);
  });

  it("is a zero range when there is nothing to draw", () => {
    const model = buildHourlyOutput(payload([]));

    // AN EMPTY MODEL HAS NO DOMAINS AT ALL now, not one zero-range domain — there
    // is no unit to key it under. `qtyDomainFor` answers [0, 0] for that, which is
    // what the axis needs; the map being empty is what says why.
    expect(model.qtyDomains).toEqual({});
    expect(qtyDomainFor(model, null)).toEqual([0, 0]);
    expect(model.rateDomain).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// The MONTH profile
// ---------------------------------------------------------------------------
//
// A month collapses ~720 hourly rows into 24 hour-of-day points, so the axis is
// built rather than derived from the rows. Three things are easy to get wrong and
// invisible on screen:
//
//   1. THE AXIS MUST BE ALL 24 HOURS whatever came back. Building it from the
//      rows present hides the hours a machine never ran — which on a performance
//      profile is the most interesting thing on the chart.
//   2. IT MUST BE ROTATED to the business day's start. An axis running 00..23
//      splits the night shift across both ends, so the chart reads as two
//      unrelated humps.
//   3. `hourOfDay` IS ALREADY PLANT-LOCAL. Formatting it through a time zone
//      would rotate every label by the plant's offset — and it would look fine.
function profileBucket(overrides: Partial<HourProfileBucket> = {}): HourProfileBucket {
  return {
    hourOfDay: 7,
    productId: 4,
    productName: "SKU Line 4",
    productCode: "SKU-4",
    uomCode: "BAG",
    totalOut: 1000,
    effectiveOut: 980,
    runtime: HOUR,
    idealRatePerHour: 1200,
    ...overrides,
  };
}

function profile(overrides: Partial<HourOfDayProfile> = {}): HourOfDayProfile {
  return {
    timeZone: JAKARTA,
    dayStartHour: 7,
    buckets: [profileBucket()],
    loadedThrough: "2026-08-31",
    ...overrides,
  };
}

describe("buildHourOfDayOutput", () => {
  it("always builds a complete 24-hour axis, however few hours came back", () => {
    const model = buildHourOfDayOutput(profile({ buckets: [profileBucket({ hourOfDay: 9 })] }));

    expect(model.buckets).toHaveLength(24);
  });

  // Point 2. 07:00 first and 06:00 last, because a business day starts at 07:00.
  it("rotates the axis to the business day's start", () => {
    const model = buildHourOfDayOutput(profile());

    expect(model.buckets[0]?.label).toBe("07:00 - 08:00");
    expect(model.buckets[8]?.label).toBe("15:00 - 16:00");
    expect(model.buckets[16]?.label).toBe("23:00 - 00:00");
    expect(model.buckets.at(-1)?.label).toBe("06:00 - 07:00");
  });

  it("honours a different day-start hour rather than hardcoding seven", () => {
    const model = buildHourOfDayOutput(profile({ dayStartHour: 0 }));

    expect(model.buckets[0]?.label).toBe("00:00 - 01:00");
    expect(model.buckets.at(-1)?.label).toBe("23:00 - 00:00");
  });

  // Point 3. Chicago is UTC-5; a zone-converting label would render 02:00 here.
  it("does not shift the labels through the plant's zone", () => {
    const model = buildHourOfDayOutput(profile({ timeZone: CHICAGO }));

    expect(model.buckets[0]?.label).toBe("07:00 - 08:00");
  });

  it("lands each bucket on its own hour", () => {
    const model = buildHourOfDayOutput(
      profile({
        buckets: [
          profileBucket({ hourOfDay: 7, totalOut: 100 }),
          profileBucket({ hourOfDay: 23, totalOut: 700 }),
        ],
      }),
    );

    const points = model.skus[0]?.points ?? [];
    expect(points[0]?.totalOut).toBe(100);
    expect(points[16]?.totalOut).toBe(700);
  });

  // Point 1's consequence: an hour with no row is a GAP, never a zero. A zero
  // draws a line to the axis and reads as "we ran and made nothing".
  it("leaves every unreported hour null rather than zero", () => {
    const model = buildHourOfDayOutput(profile({ buckets: [profileBucket({ hourOfDay: 7 })] }));

    const points = model.skus[0]?.points ?? [];
    expect(points[0]?.totalOut).toBe(1000);
    expect(points.slice(1).every((point) => point.totalOut === null)).toBe(true);
    expect(points.some((point) => point.totalOut === 0)).toBe(false);
  });

  // The rate arithmetic is the SHARED code path — the whole point of
  // parameterising only the axis and the join key. This asserts it is reached.
  it("derives the actual rate from output over runtime, as the shift chart does", () => {
    const model = buildHourOfDayOutput(
      profile({ buckets: [profileBucket({ totalOut: 600, runtime: HOUR / 2 })] }),
    );

    // 600 in half an hour is 1200/h.
    expect(model.skus[0]?.points[0]?.actualRatePerHour).toBe(1200);
  });

  it("omits the master rate line when the month never knew a standard", () => {
    const model = buildHourOfDayOutput(
      profile({ buckets: [profileBucket({ idealRatePerHour: null })] }),
    );

    expect(model.skus[0]?.hasMasterRate).toBe(false);
  });

  it("keeps two products as two chart blocks", () => {
    const model = buildHourOfDayOutput(
      profile({
        buckets: [
          profileBucket({ productId: 1, productName: "SKU A" }),
          profileBucket({ productId: 2, productName: "SKU B" }),
        ],
      }),
    );

    expect(model.skus).toHaveLength(2);
    // Both share the same 24-point axis, so the blocks are comparable.
    expect(model.skus.every((sku) => sku.points.length === 24)).toBe(true);
  });

  it("reports no month-wide average when two units are mixed", () => {
    const model = buildHourOfDayOutput(
      profile({
        buckets: [
          profileBucket({ productId: 1, uomCode: "BAG" }),
          profileBucket({ productId: 2, uomCode: "CARTON" }),
        ],
      }),
    );

    expect(model.uomCode).toBeNull();
    expect(model.avgRatePerHour).toBeNull();
  });

  it("returns no series for an empty month", () => {
    const model = buildHourOfDayOutput(profile({ buckets: [] }));

    expect(model.skus).toHaveLength(0);
    // The axis still exists, so the chart frame does not collapse.
    expect(model.buckets).toHaveLength(24);
  });
});

// ---------------------------------------------------------------------------
// buildLineHourlyOutput — the two-unit answer
// ---------------------------------------------------------------------------
//
// A line has two count points in two units (0014, §16.4a). The chart's answer is
// to plot the OUTPUT side only — `goodOut` and `effectiveOut`, which share a unit
// with each other and with the standard — and to leave `totalOut` (infeed) out
// entirely. These pin both halves, because the failure is silent: an infeed series
// on the same axis draws bags against cartons and looks completely ordinary.
describe("buildLineHourlyOutput", () => {
  function lineBucket(over: Partial<LinePerfHourBucket> = {}): LinePerfHourBucket {
    return {
      bucketStart: "2026-08-01T00:00:00.000Z",
      bucketEnd: "2026-08-01T01:00:00.000Z",
      hourOfDay: 7,
      shiftHourSeq: 0,
      productId: 4,
      productName: "Kacang Garuda 20g",
      productCode: "KG-20",
      infeedUomCode: "BAG",
      outputUomCode: "CTN",
      totalOut: 1000,
      goodOut: 80,
      effectiveOut: 75,
      runtime: 3_600_000,
      idealRatePerHour: 100,
      ...over,
    };
  }

  const linePayload = (buckets: LinePerfHourBucket[]) => ({
    timeZone: "Asia/Jakarta",
    buckets,
    loadedThrough: "2026-08-01",
    // Only the month profile reads it; carried at every grain so the payload has
    // one shape.
    dayStartHour: 7,
  });

  // THE BLOCK IS DENOMINATED IN THE OUTPUT UNIT, because that is what the plotted
  // series are in. Labelling it BAG while drawing cartons is the whole failure.
  it("denominates the block in the OUTPUT unit", () => {
    const model = buildLineHourlyOutput(linePayload([lineBucket()]));

    expect(model.skus[0]?.uomCode).toBe("CTN");
    expect(model.uomCode).toBe("CTN");
  });

  // THE RENAME. `goodOut` takes the slot the machine chart fills with `totalOut`,
  // so the legend's "Actual Production" means what came off the end of the line.
  // 80, never 1000 — 1000 is the infeed and is a different unit.
  it("plots the line's OUTPUT, not its infeed", () => {
    const model = buildLineHourlyOutput(linePayload([lineBucket()]));
    const point = model.skus[0]?.points[0];

    expect(point?.totalOut).toBe(80);
    expect(point?.effectiveOut).toBe(75);
    expect(qtyDomainFor(model, "CTN")).toEqual([0, 80]);
  });

  // THE ASSERTION THAT MATTERS MOST. If the infeed figure ever reached the
  // quantity domain, the axis would be scaled by 1000 cartons that do not exist
  // and every output series would sit flat along the bottom.
  it("keeps the infeed figure out of the quantity domain entirely", () => {
    const model = buildLineHourlyOutput(linePayload([lineBucket({ totalOut: 999_999 })]));

    expect(qtyDomainFor(model, "CTN")[1]).toBe(80);
    expect(Object.keys(model.qtyDomains)).toEqual(["CTN"]);
  });

  // The rate is output over runtime, commensurable with the output-side standard
  // it is drawn against (§19.2). 80 in one hour is 80/h.
  it("derives the actual rate from the output side", () => {
    const model = buildLineHourlyOutput(linePayload([lineBucket()]));

    expect(model.skus[0]?.points[0]?.actualRatePerHour).toBe(80);
    expect(model.skus[0]?.points[0]?.idealRatePerHour).toBe(100);
  });

  // A LINE THAT ABSTAINED on its output unit (0014: NULL means "the members
  // disagreed") falls back to the infeed code rather than to an empty label, so
  // the axis still names something a reader can check.
  it("falls back to the infeed code when the line abstained on its output unit", () => {
    const model = buildLineHourlyOutput(
      linePayload([lineBucket({ outputUomCode: null, goodOut: 80 })]),
    );

    expect(model.skus[0]?.uomCode).toBe("BAG");
  });

  // ---- the MONTH profile, over the other axis ----------------------------
  //
  // UNTESTED UNTIL A SECOND SURFACE REACHED IT. `buildLineHourOfDayOutput` served
  // only the Losses page's Trendline sub-tab, and the two things it can get wrong
  // are exactly the two the chronological builder above is pinned on — the
  // output-side RENAME and the UNIT the block is denominated in. Both now sit
  // behind a card button as well, so they are asserted over this axis too.
  //
  // The `buildHourOfDayOutput` block higher up covers the AXIS itself (24 points,
  // rotated to the business day's start, missing hours null and never 0); nothing
  // here re-tests that. What is line-specific is the mapping into it.
  describe("buildLineHourOfDayOutput", () => {
    // THE RENAME, OVER THE HOUR-OF-DAY AXIS. 80 cartons out, never the 1000 bags
    // in. A builder that took `totalOut` here while the chronological one took
    // `goodOut` would put two different definitions of "Actual Production" on two
    // surfaces of the same screen — and the month one would be scaled by an infeed
    // figure in a unit the axis does not name.
    it("plots the line's OUTPUT, not its infeed", () => {
      const model = buildLineHourOfDayOutput(linePayload([lineBucket({ hourOfDay: 9 })]));
      const point = model.skus[0]?.points.find((p) => p.totalOut !== null);

      expect(point?.totalOut).toBe(80);
      expect(point?.effectiveOut).toBe(75);
    });

    it("denominates the block in the OUTPUT unit", () => {
      const model = buildLineHourOfDayOutput(linePayload([lineBucket({ hourOfDay: 9 })]));

      expect(model.skus[0]?.uomCode).toBe("CTN");
      expect(model.uomCode).toBe("CTN");
    });

    // THE ASSERTION THAT MATTERS MOST, and the reason it is repeated here rather
    // than assumed from the chronological case: over a month the infeed figure is
    // ~30x larger, so an infeed value reaching the quantity domain scales the axis
    // by cartons that do not exist and flattens every output series along the
    // bottom. The bug would be more visible here and the code path is separate.
    it("keeps the infeed figure out of the quantity domain entirely", () => {
      const model = buildLineHourOfDayOutput(
        linePayload([lineBucket({ hourOfDay: 9, totalOut: 999_999 })]),
      );

      expect(qtyDomainFor(model, "CTN")[1]).toBe(80);
      expect(Object.keys(model.qtyDomains)).toEqual(["CTN"]);
    });

    it("derives the actual rate from the output side", () => {
      const model = buildLineHourOfDayOutput(linePayload([lineBucket({ hourOfDay: 9 })]));
      const point = model.skus[0]?.points.find((p) => p.totalOut !== null);

      expect(point?.actualRatePerHour).toBe(80);
      expect(point?.idealRatePerHour).toBe(100);
    });

    it("falls back to the infeed code when the line abstained on its output unit", () => {
      const model = buildLineHourOfDayOutput(
        linePayload([lineBucket({ hourOfDay: 9, outputUomCode: null })]),
      );

      expect(model.skus[0]?.uomCode).toBe("BAG");
    });

    // ONE BUCKET PER CLOCK HOUR is the SERVER's grouping — the ~720 rows are
    // collapsed in SQL — so the builder receives at most 24 and simply places
    // them. This pins that it places them on the RIGHT hour: a month's rows for
    // 09:00 must not land on the axis slot the day chart would have used for its
    // second point.
    it("places a bucket on its own clock hour", () => {
      const model = buildLineHourOfDayOutput(linePayload([lineBucket({ hourOfDay: 9 })]));
      const drawn = model.skus[0]?.points.filter((p) => p.totalOut !== null);

      expect(drawn).toHaveLength(1);
      // 07:00 is the business day's first slot, so 09:00 is the third.
      expect(model.skus[0]?.points.findIndex((p) => p.totalOut !== null)).toBe(2);
    });
  });
});
