import { describe, expect, it } from "vite-plus/test";

import {
  buildCalendarTimeSlices,
  buildOeeLossSlices,
  buildOeeTrendSeries,
  buildSixBigLosses,
  calendarTimeMs,
  isMonthClosed,
  isYearClosed,
  loadingTimeMs,
  TREND_AXIS,
  donutPct,
  donutTotal,
  lossWatermarkSkew,
  utility,
} from "./oee-performance";

import type { DowntimeReasonBreakdown, RejectReasonBreakdown } from "@/lib/types";

// The real figures from oee.work_unit_month_reports id 1 (Vertical Packer N,
// 2026-08). Using measured values rather than round numbers is the point: the
// identity below is the one the whole summary rests on, and a hand-tuned fixture
// could only prove itself self-consistent.
const PDT = 24_600_000;
const UPDT = 46_560_000;
const PERF_LOSS = 11_040_000;
const QUALITY_LOSS = 1_640_000;
const VALUE_ADDED = 434_560_000;
const CALENDAR = 518_400_000; // 144 h = 6 days x 24 h
const LOADING = 493_800_000;

const REPORT = {
  availabilityTime: CALENDAR,
  productionTime: LOADING,
  scheduleLossTime: PDT,
  availabilityLossTime: UPDT,
  performanceLossTime: PERF_LOSS,
  qualityLossTime: QUALITY_LOSS,
  valueAddedTime: VALUE_ADDED,
  teep: 83.827,
  oee: 88.003,
};

describe("the calendar-time identity", () => {
  // THE ASSERTION THE WHOLE DASHBOARD RESTS ON. The requirement defines Calendar
  // Time as the four losses plus value-added time; Gold has no such column. This
  // is the proof that `availabilityTime` IS that sum, which is what makes Utility
  // derivable at all.
  it("is the four losses plus value-added time", () => {
    const sum =
      REPORT.scheduleLossTime +
      REPORT.availabilityLossTime +
      REPORT.performanceLossTime +
      REPORT.qualityLossTime +
      REPORT.valueAddedTime;

    expect(sum).toBe(calendarTimeMs(REPORT));
  });

  it("maps Loading Time to productionTime, which is Calendar less the planned stop", () => {
    expect(loadingTimeMs(REPORT)).toBe(calendarTimeMs(REPORT) - REPORT.scheduleLossTime);
  });

  // TEEP = Utility x OEE. Both rates are stored, so this is a cross-check of the
  // derivation against two figures the pipeline computed independently.
  it("closes the loop: TEEP == Utility x OEE", () => {
    const u = utility(REPORT)!;

    expect((u / 100) * REPORT.oee).toBeCloseTo(REPORT.teep, 3);
  });
});

describe("utility", () => {
  it("is loading time over calendar time, as a percentage", () => {
    expect(utility(REPORT)).toBeCloseTo(95.2546, 4);
  });

  // NULL, NEVER NaN. formatPercent renders null as an em dash; NaN renders as
  // "NaN%", and a coalesced 0 would render a confident "0%" an operator acts on.
  it.each([
    ["a zero calendar time", 0],
    ["a negative calendar time", -1],
  ])("returns null for %s rather than NaN", (_label, availabilityTime) => {
    expect(utility({ availabilityTime, productionTime: 100 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const tail = { reasonCount: 37, frequency: 400, durationMs: 99_999_999 };

function downtime(
  buckets: { reason: string | null; durationMs: number }[],
  other: typeof tail | null = null,
): DowntimeReasonBreakdown {
  return {
    from: "",
    to: "",
    timeZone: "Asia/Jakarta",
    category: "UNPLANNED",
    buckets: buckets.map((b) => ({ ...b, workUnitNames: [], frequency: 1 })),
    other,
    totalFrequency: 0,
    totalDurationMs: 0,
    loadedThrough: "2026-08-31",
  } as DowntimeReasonBreakdown;
}

function rejects(buckets: { reason: string; durationMs: number }[]): RejectReasonBreakdown {
  return {
    timeZone: "Asia/Jakarta",
    buckets: buckets.map((b) => ({
      ...b,
      reasonCode: null,
      machineName: null,
      counterValue: 0,
      counterUnit: null,
      quantity: 0,
      convertedUnit: null,
      weightGram: null,
      frequency: 1,
    })),
    totalFrequency: 0,
    totalDurationMs: 0,
    totalQuantity: 0,
    totalWeightGram: null,
    convertedUnit: null,
    loadedThrough: "2026-08-31",
  } as RejectReasonBreakdown;
}

const EMPTY = {
  planned: undefined,
  unplanned: undefined,
  smallStop: undefined,
  rejects: undefined,
  reduceSpeedLossTime: undefined,
};

describe("buildSixBigLosses", () => {
  it("ranks across every source, longest first", () => {
    const rows = buildSixBigLosses({
      unplanned: downtime([{ reason: "Unknown", durationMs: 20_181_000 }]),
      planned: downtime([{ reason: "Scheduled Maintenance", durationMs: 3_160_000 }]),
      smallStop: downtime([{ reason: "Jam_Sensor", durationMs: 492_000 }]),
      rejects: rejects([{ reason: "Total_NG_Prod", durationMs: 4_805_000 }]),
      reduceSpeedLossTime: 770_000,
    });

    expect(rows.map((r) => [r.reason, r.badge])).toEqual([
      ["Unknown", "AL"],
      ["Total_NG_Prod", "QL"],
      ["Scheduled Maintenance", "SL"],
      ["Reduce Speed", "PL"],
      ["Jam_Sensor", "PL"],
    ]);
  });

  // THE EASIEST THING IN THIS FILE TO GET WRONG. `other` is the folded tail of
  // every reason past the top 20 — the Paretos label it "Other (37 reasons)".
  // Ranked as one reason it beats every genuine cause and takes a slot, producing
  // a card that is wrong and reads as correct.
  it("NEVER ranks the `other` tail, even when it dwarfs every bucket", () => {
    const rows = buildSixBigLosses({
      ...EMPTY,
      unplanned: downtime([{ reason: "Unknown", durationMs: 10 }], tail),
    });

    expect(rows).toEqual([{ reason: "Unknown", badge: "AL", durationMs: 10 }]);
  });

  // The label belongs in the browser: core-api deliberately never sends this
  // string, so a real reason of this exact text cannot merge into the bucket.
  it("labels a null reason Unspecified", () => {
    const rows = buildSixBigLosses({
      ...EMPTY,
      unplanned: downtime([{ reason: null, durationMs: 10 }]),
    });

    expect(rows[0]!.reason).toBe("Unspecified");
  });

  // A machine that outran its standard rate. Real data, and NOT made absolute —
  // Math.abs would promote the best hour of the month to the worst loss on screen.
  it("sorts a NEGATIVE reduce-speed loss last instead of taking its magnitude", () => {
    const rows = buildSixBigLosses({
      ...EMPTY,
      unplanned: downtime([{ reason: "Unknown", durationMs: 1 }]),
      reduceSpeedLossTime: -900_000,
    });

    expect(rows.map((r) => r.reason)).toEqual(["Unknown", "Reduce Speed"]);
    expect(rows[1]!.durationMs).toBe(-900_000);
  });

  it("caps at six even when every source is full", () => {
    const many = (prefix: string) =>
      downtime(Array.from({ length: 20 }, (_, i) => ({ reason: `${prefix}${i}`, durationMs: i })));

    expect(
      buildSixBigLosses({
        unplanned: many("a"),
        planned: many("b"),
        smallStop: many("c"),
        rejects: rejects(
          Array.from({ length: 20 }, (_, i) => ({ reason: `d${i}`, durationMs: i })),
        ),
        reduceSpeedLossTime: 0,
      }),
    ).toHaveLength(6);
  });

  it("omits the Reduce Speed row entirely while the report is still loading", () => {
    expect(buildSixBigLosses(EMPTY)).toEqual([]);
  });

  it("includes a zero reduce-speed loss once the report HAS loaded", () => {
    expect(buildSixBigLosses({ ...EMPTY, reduceSpeedLossTime: 0 })).toEqual([
      { reason: "Reduce Speed", badge: "PL", durationMs: 0 },
    ]);
  });
});

describe("lossWatermarkSkew", () => {
  it("is null when every source reaches the report's month", () => {
    expect(
      lossWatermarkSkew("2026-08-01", "Asia/Jakarta", ["2026-08-31", "2026-08-31"]),
    ).toBeNull();
  });

  // The distortion this exists to surface: downtime loaded to the 20th ranked
  // against rejects loaded to the 31st floats every quality loss up the list.
  it("reports the EARLIEST day when the sources disagree", () => {
    expect(lossWatermarkSkew("2026-09-01", "Asia/Jakarta", ["2026-08-20", "2026-08-31"])).toBe(
      "2026-08-20",
    );
  });

  // A never-stamped source cannot be given an earliest day. Reporting the
  // earliest of the others would claim more coverage than exists.
  it("is null when any source has never been stamped", () => {
    expect(lossWatermarkSkew("2026-09-01", "Asia/Jakarta", ["2026-08-20", null])).toBeNull();
  });
});

describe("buildOeeTrendSeries", () => {
  // Every point carries four rates now. `pt` fills the three this suite is not
  // asserting, so each case reads as the one thing it is about.
  const pt = (businessDate: string, oee: number | null, rest: number | null = 90) => ({
    businessDate,
    oee,
    availability: rest,
    performance: rest,
    quality: rest,
  });

  // The row is KEPT and its value dropped. Filtering the row out would close the
  // line over the gap and shift every later day one position left, so a month
  // with three idle days would draw as an unbroken good month.
  it("keeps a 0% day as a point with no value, so the line breaks", () => {
    const series = buildOeeTrendSeries([
      pt("2026-08-01", 88),
      pt("2026-08-02", 0),
      pt("2026-08-03", 91),
    ]);

    expect(series.map((point) => point.oee)).toEqual([88, undefined, 91]);
    expect(series.map((point) => point.businessDate)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });

  it("draws a null the same way — neither is a rate anybody can plot", () => {
    expect(buildOeeTrendSeries([pt("2026-08-02", null)])[0]!.oee).toBeUndefined();
  });

  it("drops no rows, so the x-axis keeps its shape", () => {
    expect(buildOeeTrendSeries([pt("2026-08-01", 0), pt("2026-08-02", 0)])).toHaveLength(2);
  });

  // PER SERIES, NOT PER POINT, and this is the case that says why. A machine that
  // ran and made nothing has an OEE of zero and a real availability — it WAS
  // available. Blanking the row on one zero would erase three measurements to hide
  // one, and the three factors are exactly what a reader opens this chart for.
  it("gaps only the series that is zero, keeping the others on the same day", () => {
    const [point] = buildOeeTrendSeries([
      { businessDate: "2026-08-02", oee: 0, availability: 90.5, performance: 0, quality: 99 },
    ]);

    expect(point).toEqual({
      businessDate: "2026-08-02",
      oee: undefined,
      availability: 90.5,
      performance: undefined,
      quality: 99,
    });
  });

  it("gaps every series on a day the pipeline could not compose at all", () => {
    const [point] = buildOeeTrendSeries([pt("2026-08-02", null, null)]);

    expect(point).toEqual({
      businessDate: "2026-08-02",
      oee: undefined,
      availability: undefined,
      performance: undefined,
      quality: undefined,
    });
  });
});

describe("isMonthClosed", () => {
  it("is true for a month that has ended", () => {
    expect(isMonthClosed("2026-08-01", new Date(2026, 8, 15))).toBe(true);
  });

  it("is false for the month in progress, which can still change", () => {
    expect(isMonthClosed("2026-09-01", new Date(2026, 8, 15))).toBe(false);
  });

  it("is false when the report has no business date to judge by", () => {
    expect(isMonthClosed(null, new Date(2026, 8, 15))).toBe(false);
  });

  it("handles the December/January boundary by string order", () => {
    expect(isMonthClosed("2026-12-01", new Date(2027, 0, 3))).toBe(true);
  });
});

describe("buildCalendarTimeSlices", () => {
  it("splits calendar time into losses and value-added", () => {
    expect(buildCalendarTimeSlices(REPORT)).toMatchObject([
      { key: "losses", label: "Losses", ms: CALENDAR - VALUE_ADDED },
      { key: "value-added", label: "VA Operating Time", ms: VALUE_ADDED },
    ]);
  });

  // A donut can only honestly show a whole split into parts. The losses slice is
  // the SUBTRACTION rather than a second sum of the four loss columns, so the two
  // slices sum to calendar time even on a row where the pipeline broke the
  // identity that those four plus value-added equal it.
  it("sums to calendar time exactly", () => {
    expect(donutTotal(buildCalendarTimeSlices(REPORT))).toBe(CALENDAR);
  });

  it("never draws a negative slice when value-added exceeds calendar time", () => {
    const broken = { availabilityTime: 100, valueAddedTime: 500 };

    expect(buildCalendarTimeSlices(broken)[0]!.ms).toBe(0);
  });

  it("fills each slice with a whole var() token, never a composed name", () => {
    for (const slice of buildCalendarTimeSlices(REPORT)) {
      expect(slice.fill).toMatch(/^var\(--color-oee-[a-z-]+\)$/);
    }
  });
});

describe("buildOeeLossSlices", () => {
  it("slices the four loss factors", () => {
    expect(buildOeeLossSlices(REPORT).map((s) => [s.key, s.ms])).toEqual([
      ["availability", UPDT],
      ["performance", PERF_LOSS],
      ["quality", QUALITY_LOSS],
      ["schedule", PDT],
    ]);
  });

  // SCHEDULE LOSS IS IN HERE even though it is not an OEE factor — planned time is
  // subtracted from calendar time rather than lost against production. Leaving it
  // out would draw three slices summing to a figure no tile on the screen shows.
  it("includes Scheduled Loss, so the donut totals the month's whole loss", () => {
    const slices = buildOeeLossSlices(REPORT);

    expect(slices.map((s) => s.label)).toContain("Scheduled Loss");
    expect(donutTotal(slices)).toBe(CALENDAR - VALUE_ADDED);
  });

  // Small Stop and Reduce Speed are the two HALVES of performance loss; slicing
  // them beside their parent would double-count.
  it("slices performance loss once, not alongside its two halves", () => {
    expect(buildOeeLossSlices(REPORT)).toHaveLength(4);
  });
});

describe("donutPct", () => {
  it("is each slice's share of the total", () => {
    const slices = buildCalendarTimeSlices(REPORT);

    expect(donutPct(slices[1]!, donutTotal(slices))).toBeCloseTo(83.827, 3);
  });

  // NULL, never 0%. A machine with no calendar time is a row the pipeline has not
  // filled in, and confident zeros would read as a month in which nothing was lost.
  it("is null on a zero total rather than zero percent", () => {
    const empty = buildCalendarTimeSlices({ availabilityTime: 0, valueAddedTime: 0 });

    expect(donutPct(empty[0]!, donutTotal(empty))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isYearClosed
// ─────────────────────────────────────────────────────────────────────────────
//
// A SIBLING of isMonthClosed rather than a parameterised isPeriodClosed(grain, …),
// because the parameterised version's only content is a SLICE LENGTH picked from a
// grain — and the two ways of getting that wrong are not symmetric.
describe("isYearClosed", () => {
  it("is false for a year still in progress, right up to its last day", () => {
    // THE CASE THAT CATCHES THE MONTH PREDICATE BEING PASTED IN HERE.
    // `isMonthClosed` slices SEVEN characters, so on this row it compares
    // "2026-01" < "2026-12" and answers TRUE — a live year cached forever, which is
    // a chart that stops updating with nothing on screen to say so.
    expect(isYearClosed("2026-01-01", new Date(2026, 11, 31))).toBe(false);
    expect(isMonthClosed("2026-01-01", new Date(2026, 11, 31))).toBe(true);
  });

  it("is true once the current year is strictly later", () => {
    expect(isYearClosed("2026-01-01", new Date(2027, 0, 1))).toBe(true);
  });

  it("is false for a missing business date, like its month sibling", () => {
    expect(isYearClosed(null)).toBe(false);
    expect(isYearClosed(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TREND_AXIS
// ─────────────────────────────────────────────────────────────────────────────
//
// ASSERTED AS A VALUE, NOT THROUGH THE CHART, and that is not a shortcut: recharts
// renders nothing measurable under happy-dom — `ResponsiveContainer` has zero size
// there — so a tick never reaches the DOM and a component test could not see these
// at all.
describe("TREND_AXIS", () => {
  it("ticks a month's points with the day of the month", () => {
    expect(TREND_AXIS.month.tick("2026-08-19")).toBe("19");
    expect(TREND_AXIS.month.tick("2026-08-01")).toBe("1");
  });

  it("ticks a year's points with the month name", () => {
    expect(TREND_AXIS.year.tick("2026-01-01")).toBe("Jan");
    expect(TREND_AXIS.year.tick("2026-08-01")).toBe("Aug");
    expect(TREND_AXIS.year.tick("2026-12-01")).toBe("Dec");
  });

  // THE ASSERTION THAT MATTERS MOST. A year's points are dated `YYYY-MM-01`, so the
  // raw string is a real date, correctly formatted, that reads as the point covering
  // ONE DAY — the `businessDate`-as-a-day trap in prose form. The label must name
  // the MONTH, and it must keep the year: the twelve points of 2025 and of 2026 are
  // one filter change apart.
  it("labels a year's point with its month AND year, never the raw date", () => {
    expect(TREND_AXIS.year.label("2026-08-01")).toBe("August 2026");
    expect(TREND_AXIS.year.label("2026-08-01")).not.toContain("01");
  });

  // NEVER A `Date`. Parsing `2026-08-01` reads it as UTC midnight, which lands on 31
  // July for any plant west of Greenwich — the right-looking wrong label on every
  // tick. Both formatters are string slices, and this is what pins that.
  it("reads the string rather than parsing it, so no zone can move a label", () => {
    // 1 January is the case a zone shift would move into the PREVIOUS year.
    expect(TREND_AXIS.year.tick("2026-01-01")).toBe("Jan");
    expect(TREND_AXIS.year.label("2026-01-01")).toBe("January 2026");
    expect(TREND_AXIS.month.tick("2026-01-01")).toBe("1");
  });
});
