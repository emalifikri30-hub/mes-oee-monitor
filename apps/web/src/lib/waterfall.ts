import { msToHours } from "@/lib/format";

import type { ReportMeasures } from "@/lib/types";

// The waterfall reads left to right: each bar's total is the previous bar's
// bottom band, with that step's losses stacked on top of what survives it.
// Calendar time is split into production + planned downtime, production into
// operating + unplanned downtime, and so on down to value-added time.
//
// Every band is taken straight from the report. Nothing here back-computes a
// band as "previous base minus this base" — a gold row whose parts do not add up
// must show as a ragged chart, not be quietly papered over.

const OEE_COLOR = {
  neutral: "var(--color-oee-neutral)",
  plannedDowntime: "var(--color-oee-planned-downtime)",
  unplannedDowntime: "var(--color-oee-unplanned-downtime)",
  smallStop: "var(--color-oee-small-stop)",
  reduceSpeed: "var(--color-oee-reduce-speed)",
  valueAdded: "var(--color-oee-value-added)",
  anomaly: "var(--color-oee-anomaly)",
  upSpeed: "var(--color-oee-up-speed)",
} as const;

type WaterfallSegment = {
  label: string;
  // Raw, signed milliseconds. The tooltip reads this, never the rounded hours
  // below, so what the user sees is exactly what the API said.
  ms: number;
  color: string;
};

// `s0`/`s1`/`s2` are positional stack slots, bottom to top. Recharts stacks by
// dataKey across every category, but each bar here needs different bands in the
// same position — so the keys are positions and the colour comes from a <Cell>
// per category.
type WaterfallRow = {
  key: string;
  category: string;
  sublabel?: string;
  segments: WaterfallSegment[];
  s0?: number;
  s1?: number;
  s2?: number;
};

// Recharts reads at most this many slots; the tallest bar has three bands.
const SLOT_COUNT = 3;

// EXACTLY THE THIRTEEN MEASURES THIS FILE READS, and nothing else.
//
// It used to take a whole `ReportDetail`, which was true but far wider than the
// truth: none of the identity fields, none of the rates and none of the counts
// are touched here. `Pick` over ReportMeasures rather than a hand-listed shape,
// so the names stay tied to the one canonical list of what a report measures.
//
// THE POINT OF NARROWING IT is that the same waterfall serves a LINE report,
// whose row has no `grain: "shift" | "day" | "month"` discriminant in common with
// a machine's, no `workUnitId`, and no single `uomName` — but has these thirteen
// durations under exactly these names (migration 0014). A function asking for
// only what it reads can serve both subjects without knowing either exists.
//
// Durations only, which is what makes that safe. The line grain's COUNTS are
// split across two units and are not comparable with a machine's; its time is
// just time.
type WaterfallMeasures = Pick<
  ReportMeasures,
  | "availabilityTime"
  | "productionTime"
  | "pdtTime"
  | "operatingTime"
  | "updtTime"
  | "netTime"
  | "msTime"
  | "reduceSpeedTime"
  | "valueAddedTime"
  | "rejectTime"
  | "reworkTime"
  | "anomalyTime"
  | "upSpeedTime"
>;

function row(
  key: string,
  category: string,
  sublabel: string | undefined,
  segments: WaterfallSegment[],
): WaterfallRow {
  const out: WaterfallRow = { key, category, sublabel, segments };

  for (let i = 0; i < Math.min(segments.length, SLOT_COUNT); i++) {
    // Clamped at zero for the geometry only. A negative contribution would be
    // drawn below the baseline and break the "each bar totals the last one"
    // reading; the tooltip still shows the signed value from `segments`.
    const hours = Math.max(0, msToHours(segments[i]!.ms));
    // Slots are filled from s0 upward and unused ones stay `undefined` rather
    // than 0 — recharts then skips the rectangle entirely. An *interior* hole
    // would drop the bands above it onto the axis, so never leave one.
    if (i === 0) out.s0 = hours;
    else if (i === 1) out.s1 = hours;
    else out.s2 = hours;
  }

  return out;
}

function buildWaterfallRows(
  report: WaterfallMeasures,
  { showAnomaly }: { showAnomaly: boolean },
): WaterfallRow[] {
  const rows: WaterfallRow[] = [
    row("calendar", "Calendar Time", "(availability time)", [
      { label: "Availability Time", ms: report.availabilityTime, color: OEE_COLOR.neutral },
    ]),
    row("loading", "Loading Time", "(Production Time)", [
      { label: "Production Time", ms: report.productionTime, color: OEE_COLOR.neutral },
      { label: "Planned Downtime", ms: report.pdtTime, color: OEE_COLOR.plannedDowntime },
    ]),
    row("operating", "Operating Time", undefined, [
      { label: "Operating Time", ms: report.operatingTime, color: OEE_COLOR.neutral },
      { label: "Unplanned Downtime", ms: report.updtTime, color: OEE_COLOR.unplannedDowntime },
    ]),
    row("net-operating", "Net Operating Time", undefined, [
      { label: "Net Operating Time", ms: report.netTime, color: OEE_COLOR.neutral },
      { label: "Small Stop", ms: report.msTime, color: OEE_COLOR.smallStop },
      { label: "Reduce Speed", ms: report.reduceSpeedTime, color: OEE_COLOR.reduceSpeed },
    ]),
    row("value-added", "Value Added Hours", undefined, [
      { label: "Value Added Hour", ms: report.valueAddedTime, color: OEE_COLOR.valueAdded },
      { label: "Reject", ms: report.rejectTime, color: OEE_COLOR.smallStop },
      { label: "Rework", ms: report.reworkTime, color: OEE_COLOR.reduceSpeed },
    ]),
  ];

  // Anomaly and up-speed time are corrections, not losses: they explain why
  // finished goods exceed what value-added time alone accounts for. Off by
  // default because they only matter when the numbers are being questioned.
  if (showAnomaly) {
    rows.push(
      row("finish-good", "Finish Good", undefined, [
        { label: "Value Added Hour", ms: report.valueAddedTime, color: OEE_COLOR.valueAdded },
        { label: "Anomaly", ms: report.anomalyTime, color: OEE_COLOR.anomaly },
        { label: "Up Speed", ms: report.upSpeedTime, color: OEE_COLOR.upSpeed },
      ]),
    );
  }

  return rows;
}

export { buildWaterfallRows, OEE_COLOR, SLOT_COUNT };
export type { WaterfallMeasures, WaterfallRow, WaterfallSegment };
