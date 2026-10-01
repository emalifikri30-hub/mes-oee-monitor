import { describe, expect, it } from "vite-plus/test";

import { OEE_COLOR, SLOT_COUNT, buildWaterfallRows } from "@/lib/waterfall";
import { periodReport, shiftReport } from "@/test/fixtures";

// PINNING THE WATERFALL BEFORE ITS SIGNATURE WIDENS.
//
// `buildWaterfallRows` reads only the ~13 duration measures, so serving a Line
// report means narrowing its parameter from `ReportDetail` to a measures-only
// type. That is a change no existing test would have noticed: this file had NO
// coverage at all, and the failure mode of getting it wrong is silent — a measure
// dropped or renamed makes a band read 0, the bar shortens, and the chart still
// renders a perfectly plausible waterfall.
//
// So the assertions below are deliberately about the two things a reader of the
// chart trusts, and nothing else:
//
//   segment.ms   RAW SIGNED MILLISECONDS, straight from the report. This is what
//                the tooltip shows, so it is asserted exactly.
//   s0/s1/s2     the geometry. Positional stack slots, filled from the bottom up,
//                CLAMPED at zero — and `undefined` when unused, because recharts
//                skips a missing rectangle but drops the bands above an interior
//                0 onto the axis.
//
// Written BEFORE the refactor rather than after, which is the whole point: a test
// authored against the new code can only confirm what the new code already does.
// Commit 5fdca44 made the same move before the report-list refactor.

const MS_PER_HOUR = 3_600_000;

describe("buildWaterfallRows", () => {
  it("returns the five steps in left-to-right reading order", () => {
    const rows = buildWaterfallRows(shiftReport(), { showAnomaly: false });

    expect(rows.map((r) => r.key)).toEqual([
      "calendar",
      "loading",
      "operating",
      "net-operating",
      "value-added",
    ]);
  });

  it("labels each step as the chart's axis reads it", () => {
    const rows = buildWaterfallRows(shiftReport(), { showAnomaly: false });

    expect(rows.map((r) => r.category)).toEqual([
      "Calendar Time",
      "Loading Time",
      "Operating Time",
      "Net Operating Time",
      "Value Added Hours",
    ]);
    // Only the first two carry a parenthesised sublabel, which is what tells a
    // reader that "Calendar Time" IS availability_time.
    expect(rows.map((r) => r.sublabel)).toEqual([
      "(availability time)",
      "(Production Time)",
      undefined,
      undefined,
      undefined,
    ]);
  });

  // THE CORE ASSERTION. Each band's `ms` is taken straight from the report and
  // nothing is back-computed as "previous base minus this base" — a gold row whose
  // parts do not add up must render as a ragged chart rather than be papered over.
  it("takes every band's milliseconds straight from the report", () => {
    const report = shiftReport();
    const rows = buildWaterfallRows(report, { showAnomaly: false });

    expect(rows[0]!.segments).toEqual([
      { label: "Availability Time", ms: report.availabilityTime, color: OEE_COLOR.neutral },
    ]);
    expect(rows[1]!.segments).toEqual([
      { label: "Production Time", ms: report.productionTime, color: OEE_COLOR.neutral },
      { label: "Planned Downtime", ms: report.pdtTime, color: OEE_COLOR.plannedDowntime },
    ]);
    expect(rows[2]!.segments).toEqual([
      { label: "Operating Time", ms: report.operatingTime, color: OEE_COLOR.neutral },
      { label: "Unplanned Downtime", ms: report.updtTime, color: OEE_COLOR.unplannedDowntime },
    ]);
    expect(rows[3]!.segments).toEqual([
      { label: "Net Operating Time", ms: report.netTime, color: OEE_COLOR.neutral },
      { label: "Small Stop", ms: report.msTime, color: OEE_COLOR.smallStop },
      { label: "Reduce Speed", ms: report.reduceSpeedTime, color: OEE_COLOR.reduceSpeed },
    ]);
    expect(rows[4]!.segments).toEqual([
      { label: "Value Added Hour", ms: report.valueAddedTime, color: OEE_COLOR.valueAdded },
      { label: "Reject", ms: report.rejectTime, color: OEE_COLOR.smallStop },
      { label: "Rework", ms: report.reworkTime, color: OEE_COLOR.reduceSpeed },
    ]);
  });

  it("fills stack slots from the bottom up, in hours", () => {
    const report = shiftReport();
    const rows = buildWaterfallRows(report, { showAnomaly: false });

    expect(rows[3]).toMatchObject({
      s0: report.netTime / MS_PER_HOUR,
      s1: report.msTime / MS_PER_HOUR,
      s2: report.reduceSpeedTime / MS_PER_HOUR,
    });
  });

  // `undefined` and not 0: recharts skips a missing rectangle, where a 0 would
  // still be laid out. The single-band Calendar bar is the case that proves it.
  it("leaves unused slots undefined rather than zero", () => {
    const rows = buildWaterfallRows(shiftReport(), { showAnomaly: false });

    expect(rows[0]!.s0).toBeDefined();
    expect(rows[0]!.s1).toBeUndefined();
    expect(rows[0]!.s2).toBeUndefined();
  });

  // The two-band rows must NOT leave s1 undefined — an interior hole drops the
  // bands above it onto the axis.
  it("fills s1 on a two-band step", () => {
    const rows = buildWaterfallRows(shiftReport(), { showAnomaly: false });

    expect(rows[1]!.s0).toBeDefined();
    expect(rows[1]!.s1).toBeDefined();
    expect(rows[1]!.s2).toBeUndefined();
  });

  // A loss duration may be negative — the columns are signed. The GEOMETRY clamps
  // (a bar below the baseline breaks the "each bar totals the last one" reading)
  // while the TOOLTIP keeps the sign, so the number is never quietly corrected.
  it("clamps a negative band's geometry at zero but keeps its signed milliseconds", () => {
    const rows = buildWaterfallRows(shiftReport({ pdtTime: -600_000 }), { showAnomaly: false });

    expect(rows[1]!.segments[1]).toMatchObject({ label: "Planned Downtime", ms: -600_000 });
    expect(rows[1]!.s1).toBe(0);
  });

  it("adds the Finish Good step only when anomaly is shown", () => {
    const report = shiftReport({ anomalyTime: 900_000, upSpeedTime: 300_000 });

    expect(buildWaterfallRows(report, { showAnomaly: false })).toHaveLength(5);

    const rows = buildWaterfallRows(report, { showAnomaly: true });
    expect(rows).toHaveLength(6);
    expect(rows[5]!.key).toBe("finish-good");
    expect(rows[5]!.segments).toEqual([
      { label: "Value Added Hour", ms: report.valueAddedTime, color: OEE_COLOR.valueAdded },
      { label: "Anomaly", ms: 900_000, color: OEE_COLOR.anomaly },
      { label: "Up Speed", ms: 300_000, color: OEE_COLOR.upSpeed },
    ]);
  });

  it("never emits more than SLOT_COUNT bands per step", () => {
    const rows = buildWaterfallRows(shiftReport(), { showAnomaly: true });

    for (const row of rows) {
      expect(row.segments.length).toBeLessThanOrEqual(SLOT_COUNT);
    }
  });

  // The same arithmetic at a coarser grain, which is what makes the parameter
  // narrowing safe: this function has never read anything grain-specific, and a
  // day report proves it without a single `grain` check in the implementation.
  it("reads a period report identically", () => {
    const report = periodReport();
    const rows = buildWaterfallRows(report, { showAnomaly: false });

    expect(rows).toHaveLength(5);
    expect(rows[0]!.segments[0]!.ms).toBe(report.availabilityTime);
    expect(rows[4]!.s0).toBe(report.valueAddedTime / MS_PER_HOUR);
  });
});
