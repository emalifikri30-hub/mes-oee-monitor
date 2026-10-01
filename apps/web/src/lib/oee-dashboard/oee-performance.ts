import { formatBusinessDate, formatMonthLabel } from "@/lib/format";
import { isLoadedThrough } from "@/lib/watermark";

import type {
  DowntimeReasonBreakdown,
  OeeTrendPoint,
  RejectReasonBreakdown,
  ReportMeasures,
} from "@/lib/types";

// The OEE Performance dashboard's arithmetic, all of it, as pure functions.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE VOCABULARY, which is the single most load-bearing thing in this file
// ─────────────────────────────────────────────────────────────────────────────
//
// Neither `calendar_time` nor `loading_time` nor `utility` is a column in Gold.
// All three are asked for by the requirement, and all three are derivable — but
// only through a mapping nothing states except here and lib/waterfall.ts:
//
//     Calendar Time  ==  availabilityTime     TEEP's denominator
//     Loading Time   ==  productionTime       OEE's denominator
//     Utility        ==  Loading / Calendar
//
// Verified against oee.work_unit_month_reports, and every identity below holds to
// the millisecond on real rows:
//
//     availabilityTime == scheduleLoss + availabilityLoss + performanceLoss
//                       + qualityLoss  + valueAddedTime          <- the requirement's
//                                                                   own formula for
//                                                                   Calendar Time
//     teep == valueAddedTime / availabilityTime
//     oee  == valueAddedTime / productionTime
//     TEEP == Utility x OEE
//
// GETTING THIS WRONG PRODUCES A PERCENTAGE, NOT AN ERROR — which is why the
// identity is asserted twice: here over a fixture, and in
// work-unit-period-repository.integration.test.ts against real Gold rows, where
// it would catch the pipeline breaking it.
//
// `availabilityTime` is a badly named column for what it holds; the name is a
// public interface (contract §23.3) and is not ours to change. These two
// functions exist so the mapping is written down once rather than inlined at
// every call site as a bare field read.
function calendarTimeMs(report: Pick<ReportMeasures, "availabilityTime">): number {
  return report.availabilityTime;
}

function loadingTimeMs(report: Pick<ReportMeasures, "productionTime">): number {
  return report.productionTime;
}

// Loading Time / Calendar Time — how much of the clock was ever scheduled to run.
//
// NULL, NEVER NaN, on a zero denominator. A month with no calendar time is a
// report the pipeline has not filled in; `formatPercent` renders null as an em
// dash, where NaN renders as "NaN%" and 0/0 would render a confident "0%" — a
// figure an operator would act on.
function utility(
  report: Pick<ReportMeasures, "availabilityTime" | "productionTime">,
): number | null {
  const calendar = calendarTimeMs(report);
  if (calendar <= 0) return null;

  return (loadingTimeMs(report) / calendar) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO DONUTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Both split ONE total into slices that sum to it exactly, which is the only
// thing a donut can honestly show. They are built here rather than in the cards
// so the sum is a tested property rather than a hope.

type DonutSlice = {
  key: string;
  label: string;
  ms: number;
  // The token the slice is filled with. A WHOLE `var(...)` string, never composed
  // — index.css opens `@theme inline`, so Tailwind emits a `--color-*` property
  // only where its scanner found the literal text, and a composed name resolves
  // to nothing and renders uncoloured with no error. reason-pareto-chart.tsx's
  // header records the same trap at length.
  fill: string;
};

// CALENDAR TIME, split into what was lost and what was value-added.
//
// TWO SLICES AND NOT SIX. The month's losses are broken down by the donut beside
// it; this one answers the blunter question the requirement asks first — of all
// the time this machine existed, how much made product. `valueAddedTime` is the
// only part that did.
//
// The slices sum to `availabilityTime` BY CONSTRUCTION here, because the losses
// slice is the subtraction rather than a second sum of the four loss columns. The
// identity that those four plus value-added equal calendar time is asserted
// separately (see the header) — deriving one slice from the other is what keeps
// the donut whole even on a row where the pipeline broke it.
function buildCalendarTimeSlices(
  report: Pick<ReportMeasures, "availabilityTime" | "valueAddedTime">,
): DonutSlice[] {
  const calendar = calendarTimeMs(report);
  const valueAdded = report.valueAddedTime;

  return [
    {
      key: "losses",
      label: "Losses",
      // Never negative: a row whose value-added time exceeds its calendar time is
      // broken, and a negative slice draws as a wedge on the wrong side of the
      // circle rather than as the error it is.
      ms: Math.max(0, calendar - valueAdded),
      fill: "var(--color-oee-unplanned-downtime)",
    },
    {
      key: "value-added",
      label: "VA Operating Time",
      ms: Math.max(0, valueAdded),
      fill: "var(--color-oee-value-added)",
    },
  ];
}

type LossDurations = Pick<
  ReportMeasures,
  "scheduleLossTime" | "availabilityLossTime" | "performanceLossTime" | "qualityLossTime"
>;

// THE LOSSES, split by the OEE factor each one reduces.
//
// FOUR SLICES, and the fourth is the one to understand: Schedule Loss is in here
// even though it is NOT an OEE factor — planned time is subtracted from calendar
// time rather than lost against production, which is why losses-card-shell.tsx
// groups it apart. It belongs in this donut because the donut's total is the
// month's whole loss, and leaving it out would draw three slices that sum to
// something no tile on the screen shows.
//
// Performance Loss is the parent of Small Stop and Reduce Speed — the two are its
// halves, and slicing them separately here would double-count.
function buildOeeLossSlices(report: LossDurations): DonutSlice[] {
  return [
    {
      key: "availability",
      label: "Availability Loss",
      ms: Math.max(0, report.availabilityLossTime),
      fill: "var(--color-oee-unplanned-downtime)",
    },
    {
      key: "performance",
      label: "Performance Loss",
      ms: Math.max(0, report.performanceLossTime),
      fill: "var(--color-oee-small-stop)",
    },
    {
      key: "quality",
      label: "Quality Loss",
      ms: Math.max(0, report.qualityLossTime),
      fill: "var(--color-oee-quality)",
    },
    {
      key: "schedule",
      label: "Scheduled Loss",
      ms: Math.max(0, report.scheduleLossTime),
      fill: "var(--color-oee-planned-downtime)",
    },
  ];
}

// The donut's centre figure and each slice's share.
//
// NULL PERCENTAGES ON A ZERO TOTAL, never 0% — a machine with no calendar time is
// a row the pipeline has not filled in, and four confident zeros would read as a
// month in which nothing was lost.
function donutTotal(slices: readonly DonutSlice[]): number {
  return slices.reduce((sum, slice) => sum + slice.ms, 0);
}

function donutPct(slice: DonutSlice, total: number): number | null {
  return total <= 0 ? null : (slice.ms / total) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIX BIG LOSSES
// ─────────────────────────────────────────────────────────────────────────────
//
// The six largest losses on one machine-month, ranked across EVERY source that
// records one. Five sources, four of them lists and one a single figure:
//
//   AL  oee.downtime_reports  category=UNPLANNED   per-reason
//   SL  oee.downtime_reports  category=PLANNED     per-reason
//   PL  oee.downtime_reports  category=SMALL_STOP  per-reason
//   PL  report.reduceSpeedLossTime                 ONE synthetic row — there are
//                                                  no per-cause records for it
//                                                  anywhere in this system
//   QL  oee.reject_count_wu_shift                  per reject counter
//
// WHY MERGING FOUR INDEPENDENTLY-LIMITED LISTS IS EXACT, and the proof has to
// stay here or the next reader will "fix" this into a server-side merge:
//
//   the result holds 6 rows, so AT MOST 6 can come from any one source;
//   each source returns its own top 20 by duration, and 6 <= 20;
//   therefore every row that belongs in the global top 6 is in the slice we have.
//
// The alternative — one endpoint that ranks server-side — would have to read the
// downtime tables AND the reject table, crossing the module boundary core-api
// deliberately enforces, and would put a second definition of this ranking in the
// system.
type LossBadge = "AL" | "SL" | "PL" | "QL";

type SixBigLoss = {
  reason: string;
  badge: LossBadge;
  durationMs: number;
};

// The label for a downtime bucket with no reason recorded.
//
// APPLIED HERE, IN THE BROWSER, and core-api deliberately never sends this string
// — a real reason of this exact text would otherwise merge into the unattributed
// bucket and become invisible. Same rule the Paretos follow.
const UNSPECIFIED = "Unspecified";

const REDUCE_SPEED_LABEL = "Reduce Speed";

type LossSources = {
  planned: DowntimeReasonBreakdown | undefined;
  unplanned: DowntimeReasonBreakdown | undefined;
  smallStop: DowntimeReasonBreakdown | undefined;
  rejects: RejectReasonBreakdown | undefined;
  reduceSpeedLossTime: number | undefined;
};

const TOP_N = 6;

function downtimeRows(
  breakdown: DowntimeReasonBreakdown | undefined,
  badge: LossBadge,
): SixBigLoss[] {
  // `other` IS DELIBERATELY NOT INCLUDED, and this is the single easiest thing to
  // get wrong in this file. It is the folded tail of every reason past the top 20
  // — the Paretos render it as "Other (37 reasons)". Ranked here as though it
  // were one reason it would almost always beat a genuine single cause and take a
  // slot in the six, producing a card that is wrong and reads as correct.
  return (breakdown?.buckets ?? []).map((bucket) => ({
    reason: bucket.reason ?? UNSPECIFIED,
    badge,
    durationMs: bucket.durationMs,
  }));
}

function buildSixBigLosses({
  planned,
  unplanned,
  smallStop,
  rejects,
  reduceSpeedLossTime,
}: LossSources): SixBigLoss[] {
  const rows: SixBigLoss[] = [
    ...downtimeRows(unplanned, "AL"),
    ...downtimeRows(planned, "SL"),
    ...downtimeRows(smallStop, "PL"),
    // A reject counter's name — `Total_NG_Prod` — is never null and is rendered
    // VERBATIM: prettifying it breaks the one string a reader can match against
    // the machine in front of them.
    //
    // Its `durationMs` is zero until the pipeline writes per-counter reject time.
    // That is honest rather than hidden: a zero-duration loss sorts last and
    // simply never reaches the six, which is the right answer when nothing knows
    // how long it cost.
    ...(rejects?.buckets ?? []).map((bucket) => ({
      reason: bucket.reason,
      badge: "QL" as const,
      durationMs: bucket.durationMs,
    })),
  ];

  // REDUCE SPEED IS ONE ROW, not a breakdown, because no table in this system
  // records a per-cause reduce-speed loss — losses-card-shell.tsx says the same
  // thing one screen over. Included only when the report has loaded.
  //
  // IT MAY BE NEGATIVE, when the machine outran its standard rate, and that is
  // real data rather than a defect. It is NOT made absolute: a negative loss is a
  // bonus, it sorts last, and it correctly never appears in the six. Taking
  // Math.abs here would promote the best hour of the month to the worst.
  if (reduceSpeedLossTime !== undefined) {
    rows.push({ reason: REDUCE_SPEED_LABEL, badge: "PL", durationMs: reduceSpeedLossTime });
  }

  return rows.sort((a, b) => b.durationMs - a.durationMs).slice(0, TOP_N);
}

// ─────────────────────────────────────────────────────────────────────────────
// WATERMARK SKEW
// ─────────────────────────────────────────────────────────────────────────────
//
// The five sources above are loaded by DIFFERENT pipeline models and each carries
// its own `loadedThrough`. When they disagree, the ranking compares a PARTIAL
// month against a COMPLETE one — downtime loaded to the 20th ranked against
// rejects loaded to the 31st floats every quality loss up the list, and nothing
// on screen would say why.
//
// This returns the earliest business day every source can vouch for, or null when
// they all reach the report's own day. The card renders a note; it does not hide
// the ranking, because a partial answer labelled as partial is more useful than
// no answer.
function lossWatermarkSkew(
  reportBusinessDay: string | null | undefined,
  timeZone: string,
  loadedThrough: readonly (string | null | undefined)[],
): string | null {
  const known = loadedThrough.filter((d): d is string => typeof d === "string");

  // A source that has NEVER been stamped cannot be given an earliest day, so the
  // skew is reported as unknown rather than as the earliest of the others — which
  // would claim more coverage than exists.
  if (known.length !== loadedThrough.length) return null;
  if (known.length === 0) return null;

  // Lexicographic on YYYY-MM-DD, deliberately: parsing these into Dates would
  // reintroduce the zone ambiguity lib/watermark.ts exists to remove.
  const earliest = known.reduce((a, b) => (a < b ? a : b));

  return isLoadedThrough(reportBusinessDay, timeZone, earliest) ? null : earliest;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TREND
// ─────────────────────────────────────────────────────────────────────────────

type OeeTrendDatum = {
  businessDate: string;
  // `undefined`, not 0 and not omitted — recharts skips the point and leaves a
  // GAP, which is what `connectNulls={false}` then keeps open.
  oee: number | undefined;
  availability: number | undefined;
  performance: number | undefined;
  quality: number | undefined;
};

// The four series, in the order the legend reads them: the product first, then
// the three factors it is the product of.
//
// A CONST RATHER THAN FOUR LITERALS IN THE CHART, so the legend, the lines and the
// colours cannot fall out of step — and so a fifth rate would be one entry rather
// than four edits in three files.
const TREND_SERIES = [
  { key: "oee", label: "OEE", color: "var(--color-oee-value-added)" },
  { key: "availability", label: "Availability", color: "var(--color-oee-unplanned-downtime)" },
  { key: "performance", label: "Performance", color: "var(--color-oee-small-stop)" },
  { key: "quality", label: "Quality", color: "var(--color-oee-quality)" },
] as const satisfies readonly {
  key: keyof Omit<OeeTrendDatum, "businessDate">;
  label: string;
  color: string;
}[];

// "If OEE is 0%, remove it from the chart — prefer empty data instead of 0%."
//
// THE POINT IS KEPT AND ITS VALUE DROPPED, rather than the row being filtered
// out, and the difference is the x-axis: removing the row would close the line
// over the gap and shift every later day one position left, so a month with three
// idle days would draw as an unbroken good month.
//
// NULL IS FOLDED IN WITH ZERO HERE, and they arrive meaning different things — a
// null oee is a line or area day the pipeline could not compose (migration 0024),
// a zero is a subject that ran and produced nothing. Both draw as a gap because
// neither is a rate anybody can plot; the DISTINCTION survives on the wire, where
// a BI tool reading these tables can still tell them apart.
function buildOeeTrendSeries(points: readonly OeeTrendPoint[]): OeeTrendDatum[] {
  // PER SERIES, not per point. A day whose OEE is zero can still have a real
  // availability — a machine that ran and made nothing was AVAILABLE — so
  // blanking the whole row on one zero would erase three measurements to hide one.
  const gapped = (value: number | null) => (value === null || value === 0 ? undefined : value);

  return points.map((point) => ({
    businessDate: point.businessDate,
    oee: gapped(point.oee),
    availability: gapped(point.availability),
    performance: gapped(point.performance),
    quality: gapped(point.quality),
  }));
}

// Is the month over? A finished month's figures can never change, which is what
// lets every query on this screen cache it forever — the window-aware staleTime
// idiom queries.ts uses, reached through the report rather than through a `to`
// field this payload does not carry.
function isMonthClosed(businessDate: string | null | undefined, now: Date = new Date()): boolean {
  if (typeof businessDate !== "string") return false;

  // The report's business_date is the FIRST day of the month, so the month is
  // over once the CURRENT month is strictly later. String comparison on YYYY-MM
  // again, for lib/watermark.ts's reason.
  const reportMonth = businessDate.slice(0, 7);
  const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return reportMonth < nowMonth;
}

// Is the YEAR over? A SIBLING OF isMonthClosed RATHER THAN A PARAMETERISED
// isPeriodClosed(grain, …), and the parameterised version's only content would be
// A SLICE LENGTH PICKED FROM A GRAIN — which is the kind of configuration somebody
// gets off by one silently. The two failures are not symmetric either:
// `slice(0, 7)` applied to a year row compares "2026-01" < "2026-09" and reports a
// FINISHED year as open all year, which costs refetches; `slice(0, 4)` applied to a
// month row caches a LIVE month forever, which is a chart that stops updating with
// nothing on screen to say so.
//
// String comparison on YYYY again, for lib/watermark.ts's reason: parsing this into
// a Date would reintroduce the zone ambiguity a business date exists to be free of.
function isYearClosed(businessDate: string | null | undefined, now: Date = new Date()): boolean {
  if (typeof businessDate !== "string") return false;

  // The report's business_date is JANUARY 1 (ck_*_year_start), so the year is over
  // once the CURRENT year is strictly later.
  return businessDate.slice(0, 4) < String(now.getFullYear());
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TREND'S AXIS, PER GRAIN
// ─────────────────────────────────────────────────────────────────────────────
//
// A month report trends DAYS; a year report trends MONTHS. Same four series, same
// payload shape, same chart — and two different things to write on an x-axis tick
// and in a tooltip heading.
//
// A VALUE RATHER THAN A `grain` PROP THE CHART SWITCHES ON, following
// `ReasonParetoChart`'s `ParetoAppearance`: the chart takes what it READS. And a
// value rather than logic inside the chart because RECHARTS RENDERS NOTHING
// MEASURABLE UNDER happy-dom — `ResponsiveContainer` has zero size there, so a tick
// never reaches the DOM and the only way to assert these is to assert the record.
//
// BOTH FORMATTERS ARE STRING SLICES, NEVER A `Date`. `businessDate` is plant-local
// and already free of a zone; `new Date("2026-09-01")` reads as UTC midnight and
// lands on 31 August for any plant west of Greenwich — the right-looking wrong
// label on every tick. Same rule as lib/format.ts's formatBusinessDate.
type OeeTrendAxis = {
  // The x-axis tick: the day of the month, or a three-letter month name.
  tick: (businessDate: string) => string;
  // The tooltip heading. At year grain this MUST NOT be the raw `businessDate` —
  // a year's points are dated `YYYY-MM-01`, so printing one raw shows a real date,
  // correctly formatted, that reads as the point covering one day.
  label: (businessDate: string) => string;
};

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// KEYED BY THE REPORT'S OWN GRAIN, and indexed with a LITERAL at every call site.
// `TREND_AXIS[grain]` with a variable in scope is how a year screen's labels reach
// a month screen — the same reason the trend query options were taken out of the
// subject registry.
const TREND_AXIS = {
  month: {
    tick: (businessDate: string) => String(Number(businessDate.slice(8, 10))),
    label: (businessDate: string) => formatBusinessDate(businessDate),
  },
  year: {
    tick: (businessDate: string) =>
      MONTH_ABBREVIATIONS[Number(businessDate.slice(5, 7)) - 1] ?? businessDate,
    // `formatMonthLabel` already refuses to drop the year, which matters here: the
    // twelve points of 2025 and of 2026 are one filter change apart.
    label: (businessDate: string) => formatMonthLabel(businessDate),
  },
} as const satisfies Record<"month" | "year", OeeTrendAxis>;

export {
  buildCalendarTimeSlices,
  buildOeeLossSlices,
  buildOeeTrendSeries,
  buildSixBigLosses,
  calendarTimeMs,
  isMonthClosed,
  isYearClosed,
  TREND_AXIS,
  loadingTimeMs,
  lossWatermarkSkew,
  REDUCE_SPEED_LABEL,
  TREND_SERIES,
  TOP_N,
  UNSPECIFIED,
  donutPct,
  donutTotal,
  utility,
};
export type { OeeTrendAxis, DonutSlice, LossBadge, LossSources, OeeTrendDatum, SixBigLoss };
