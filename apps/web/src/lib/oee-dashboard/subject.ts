import { formatLongDuration, formatPercent } from "@/lib/format";
import { calendarTimeMs, loadingTimeMs, utility } from "@/lib/oee-dashboard/oee-performance";

import type { MetricSpec } from "@/components/report/metrics-card";
import type {
  AreaReportDetail,
  AreaYearReportDetail,
  LinePeriodReportDetail,
  LineYearReportDetail,
  MachineYearReportDetail,
  PeriodReportDetail,
  ReportMeasures,
} from "@/lib/types";

// The OEE Performance dashboard's SUBJECT REGISTRY.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A REGISTRY, AND WHAT IT MAY NOT BECOME
// ─────────────────────────────────────────────────────────────────────────────
//
// Contract §23.2 names this dashboard for work unit, work center, area AND
// factory. THREE OF THE FOUR ARE HERE, and the fourth is not coming as an entry —
// see the note above OEE_DASHBOARD_SUBJECTS. The registry exists so the second and
// third subjects were an entry each rather than a fork of the route and its three
// cards — but it earns that only while it stays a description of what DIFFERS, and
// exactly one thing does:
//
//     WHICH TILES THE SUBJECT HAS.
//
// EACH ENTRY'S REPORT TYPE IS ITS SUBJECT'S TWO COARSE GRAINS — `PeriodReportDetail
// | MachineYearReportDetail`, and so on. That union IS the registry's central
// claim, stated in the types: the tile list is constant down the grain axis, so one
// entry serves both of its subject's dashboard screens. If a grain ever needed a
// different tile, this is where it would stop compiling.
//
// SIX SCREENS NOW READ IT AND IT STILL HAS THREE ENTRIES, which is the property to
// preserve. The grain axis (monthly / yearly) changes no tile on any subject, so it
// is carried by the ROUTES and never by a key in here.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE KPI ROW IS A LIST, NOT A FIXED SIX, AND THIS IS THE LOAD-BEARING PART
// ─────────────────────────────────────────────────────────────────────────────
//
// It is tempting to type `tiles` as a six-tuple, because the requirement names six
// and the mock draws six. It was wrong on arrival for the THIRD subject, and the
// area entry below is the proof rather than the prediction it used to be:
//
//   machine   TEEP  Utility  OEE  A  P  Q        six
//   line      TEEP  Utility  OEE  A  P  Q        six — work_center_* has teep, and
//                                                a LINE OWNS A CALENDAR (0014)
//   area            —        OEE  A  P  Q        FOUR. Migration 0024 omits `teep`
//                                                and its header says why: TEEP
//                                                divides by CALENDAR time and an
//                                                area owns no calendar a reader
//                                                could name — is a five-line area's
//                                                day 24 hours, or 120? Utility has
//                                                the SAME denominator and the same
//                                                problem, so it goes too.
//   factory                                      no Gold table, and SCOPE_COLUMN
//                                                has no factory_id to map — its
//                                                Paretos could not be drawn either.
//
// So an area's row is FOUR tiles, not six with two blanks — a blank TEEP would read
// as "not computed yet", which is a promise that it will be, when the truth is that
// the figure does not exist for an area.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY *NOT* HERE
// ─────────────────────────────────────────────────────────────────────────────
//
//   * the downtime scope. `reportWindowParams` already discriminates on subject
//     and returns the right `scope`, and a second statement of that mapping is
//     precisely the drift its own header warns about.
//   * the loss sources. All three subjects rank the same five; the Six Big Losses
//     card takes DATA and knows no subject (apps/web/AGENTS.md's shared-component
//     rule).
//   * anything about routes or breadcrumbs. Those belong to the route file, which
//     is where TanStack can typecheck a literal. With six screens this is the most
//     tempting addition and the worst: the moment a `to` is a VALUE rather than a
//     literal, TanStack stops checking it and a rename stops being a build failure.
//   * THE TREND QUERY OPTIONS, which were here and were REMOVED when the second
//     subject landed. `trendQueryOptions(id, closed)` was harmless at one entry;
//     at three subjects x two grains it becomes a (subject x grain) -> endpoint
//     dispatch TABLE that routes index by key, and
//     `subject.trendQueryOptions("year", id, closed)` on an area-MONTHLY screen
//     would compile, fetch a real twelve-point curve about a different period, and
//     draw it perfectly. Each screen names its own trend hook as a literal instead
//     — which is also the only thing that lets a test assert WHICH fetcher ran.
//   * the report fetcher, the rejects fetcher, the list params and the id matcher.
//     Every one of these six screens knows its subject AND its grain statically, so
//     a dispatcher here would exist only to lose that.
//
// A registry that grew any of those would stop describing a subject and start
// being a second router.
type OeeSubjectKey = "machine" | "line" | "area";

type OeeDashboardSubject<TReport> = {
  key: OeeSubjectKey;
  // The noun the screen calls its subject, for the picker's label and the empty
  // states. Not a route segment.
  label: string;
  tiles: (report: TReport) => MetricSpec[];
};

// The hint on the Utility tile.
//
// THIS IS WHERE "CALENDAR TIME" IS EXPLAINED TO A READER, and it is the reason the
// requirement's fourth feature needs no card of its own: the figure it defines is
// a denominator, and a denominator belongs beside the ratio it divides.
//
// It names BOTH durations because the ratio alone is not checkable — an operator
// who thinks 31% looks wrong can only tell from the two numbers which half they
// disagree with.
//
// `formatLongDuration`, NOT `formatDuration`, and that function's own header
// names this case: a month of calendar time prints "744 h 00 m 00 s" under the
// short formatter — correct, and a number nobody can size at a glance. Days are
// what make it readable, and the donut beside this tile already uses it.
//
// TAKES THE TWO DURATIONS, NOT A REPORT. It read `PeriodReportDetail` while the
// machine was the only subject; a line's durations are the same two `number`
// fields, so the Pick is what lets one hint serve both without the registry
// learning which subject asked. An AREA never reaches it — it has no Utility tile
// at all, because Utility divides by a calendar an area does not own.
function utilityHint(report: Pick<ReportMeasures, "availabilityTime" | "productionTime">): string {
  return `Loading Time / Calendar Time — ${formatLongDuration(
    loadingTimeMs(report),
  )} of ${formatLongDuration(calendarTimeMs(report))}.`;
}

const machineSubject: OeeDashboardSubject<PeriodReportDetail | MachineYearReportDetail> = {
  key: "machine",
  label: "Machine",
  tiles: (report) => [
    // TEEP FIRST, matching the mock, and it is the widest claim on the row: it
    // charges the machine for calendar time nobody ever scheduled, which is why it
    // sits well below OEE and is the figure most often read as a fault.
    { label: "TEEP", value: formatPercent(report.teep), valueClassName: "text-primary" },
    {
      label: "Utility",
      // NOT A COLUMN. Loading Time / Calendar Time, derived — see
      // lib/oee-dashboard/oee-performance.ts for the identity it rests on and the
      // integration test that guards it.
      value: formatPercent(utility(report)),
      valueClassName: "text-oee-value-added-fg",
      hint: utilityHint(report),
    },
    { label: "OEE", value: formatPercent(report.oee), valueClassName: "text-oee-small-stop-fg" },
    {
      label: "Availability",
      value: formatPercent(report.availability),
      valueClassName: "text-oee-value-added-fg",
    },
    {
      label: "Performance",
      value: formatPercent(report.performance),
      valueClassName: "text-oee-value-added-fg",
    },
    {
      label: "Quality",
      value: formatPercent(report.quality),
      valueClassName: "text-oee-value-added-fg",
    },
  ],
};

// THE LINE'S ROW IS THE MACHINE'S, TILE FOR TILE, and that is a fact about
// migration `0014` rather than a copy-paste. `oee.work_center_*` carries its own
// `teep`, because a LINE OWNS A CALENDAR — it has its own count points and its own
// wall clock (`0014`: "the durations are the line's own wall clock", 8 hours over a
// 4-machine shift, not 32). So both denominators Utility and TEEP divide by exist
// here, and there is nothing to withhold.
//
// It is written out rather than spread from `machineSubject.tiles` because the two
// take DIFFERENT REPORT TYPES and agree only today. A line's rates are
// `number | null` where a machine's are `number`, which `formatPercent` already
// renders as an em dash — and the day one of these rows gains or loses a tile, a
// spread would silently move the other subject's screen too.
const lineSubject: OeeDashboardSubject<LinePeriodReportDetail | LineYearReportDetail> = {
  key: "line",
  label: "Line",
  tiles: (report) => [
    { label: "TEEP", value: formatPercent(report.teep), valueClassName: "text-primary" },
    {
      label: "Utility",
      value: formatPercent(utility(report)),
      valueClassName: "text-oee-value-added-fg",
      hint: utilityHint(report),
    },
    { label: "OEE", value: formatPercent(report.oee), valueClassName: "text-oee-small-stop-fg" },
    {
      label: "Availability",
      value: formatPercent(report.availability),
      valueClassName: "text-oee-value-added-fg",
    },
    {
      label: "Performance",
      value: formatPercent(report.performance),
      valueClassName: "text-oee-value-added-fg",
    },
    {
      label: "Quality",
      value: formatPercent(report.quality),
      valueClassName: "text-oee-value-added-fg",
    },
  ],
};

// FOUR TILES, AND THE TWO THAT ARE MISSING ARE THE WHOLE POINT OF THIS ENTRY.
//
// No TEEP: migration `0024` gives `oee.area_day_reports` no such column, and its
// header says why — TEEP divides by CALENDAR time, and an area owns no calendar a
// reader could name. Is a five-line area's day 24 hours, or 120? Both readings are
// defensible, which is exactly why neither may be shipped as a percentage.
//
// No Utility either, and this is the half that gets "fixed" back: Utility is
// Loading Time / Calendar Time, so it has the SAME denominator and the same
// problem. The durations are on the row — an area's `availabilityTime` is real —
// but they are LINE-MILLISECONDS, so the ratio would divide a line-hour figure by
// a line-hour figure and print a plausible number whose denominator nobody can
// name. A zero-cost, always-wrong tile.
//
// FOUR TILES, NOT SIX WITH TWO BLANKS. A blank reads as "not computed yet", which
// is a promise that it will be; the truth is that these two figures do not exist
// for an area. This is why `tiles` is a LIST and must never become a six-tuple.
const areaSubject: OeeDashboardSubject<AreaReportDetail | AreaYearReportDetail> = {
  key: "area",
  label: "Area",
  tiles: (report) => [
    // OEE leads here, where TEEP leads on the other two. It is the widest claim an
    // area makes, and a row whose first tile differs by subject is the row saying
    // so.
    { label: "OEE", value: formatPercent(report.oee), valueClassName: "text-primary" },
    {
      label: "Availability",
      value: formatPercent(report.availability),
      valueClassName: "text-oee-value-added-fg",
    },
    {
      label: "Performance",
      value: formatPercent(report.performance),
      valueClassName: "text-oee-value-added-fg",
    },
    {
      label: "Quality",
      value: formatPercent(report.quality),
      valueClassName: "text-oee-value-added-fg",
    },
  ],
};

// THREE ENTRIES, AND THE REGISTRY IS NOW COMPLETE — there is no fourth subject to
// add. `factory` is not an `OeeSubjectKey` at all and must not become one on
// spec: it has no Gold table, and `SCOPE_COLUMN` has no `factory_id` to map, so
// its three Paretos could not be drawn even if a tile list were invented.
//
// KEYED BY SUBJECT ONLY, NEVER BY (SUBJECT x GRAIN). The tile list is constant
// down the grain axis — a line's month and a line's year print the same six
// figures — so a six-cell registry would be a description of what does NOT differ,
// which is the thing this header says forfeits its place.
const OEE_DASHBOARD_SUBJECTS = {
  machine: machineSubject,
  line: lineSubject,
  area: areaSubject,
} as const satisfies Record<OeeSubjectKey, OeeDashboardSubject<never>>;

export { areaSubject, lineSubject, machineSubject, OEE_DASHBOARD_SUBJECTS, utilityHint };
export type { OeeDashboardSubject, OeeSubjectKey };
