import { createFileRoute } from "@tanstack/react-router";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { findLineReportId, isListSettled } from "@/lib/oee-dashboard/selection";
import { isMonthClosed, TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { lineEmptyState } from "@/lib/oee-dashboard/empty-state";
import { lineSubject } from "@/lib/oee-dashboard/subject";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { validateLineMonthlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import {
  actionBreakdownQuery,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  useDowntimeActions,
  useDowntimeReasons,
  useLineMonthOeeTrend,
  useLineReport,
  useLineReports,
  useLineRejects,
} from "@/lib/queries";
import {
  DashboardLineFilter,
  OeePerformanceFilterBar,
} from "@/components/oee-dashboard/oee-performance-filter-bar";
import { MonthFilter, YearFilter } from "@/components/report/report-list-filters";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { ReportListShell } from "@/components/report/report-list-shell";

import type {
  DowntimeCategory,
  LinePeriodReportDetail,
  LinePeriodReportListItem,
} from "@/lib/types";
import type { LineMonthlySearch } from "@/lib/oee-dashboard/oee-performance-search";

// OEE Performance → Line → Line Monthly.
//
// THE SECOND SUBJECT, AND IT COST A TILE LIST AND THIS FILE. Everything below the
// KPI row — both donuts, the Six Big Losses card, all three Paretos and the trend —
// was built over reads that already serve every subject: `reportWindowParams`
// resolves a line report to `scope: "work-center"`, which core-api's SCOPE_COLUMN
// has mapped since the line grain shipped, and `/work-centers/month-reports/:id/
// oee-trend` has been registered and untested-by-any-consumer since `e847dfc`.
//
// A LINE'S ROW IS SIX TILES, the same six a machine's is, and that is a fact about
// migration `0014` rather than a copy: `oee.work_center_month_reports` carries its
// own `teep`, because A LINE OWNS A CALENDAR — its own count points and its own wall
// clock. Both denominators TEEP and Utility divide by therefore exist. The AREA
// screens are where that stops being true.
//
// ONE MORE THING THIS SCREEN DOES NOT HAVE, and it is worth stating so nobody adds
// it: no Machine picker. A line dashboard that let you narrow to one machine would
// be the machine dashboard, reached by a path that says Line — and the figures would
// not even agree, because a line is MEASURED at its own count points and
// `line <> sum(machines)` is not a defect.
export const Route = createFileRoute("/_app/oee-performance/line/monthly")({
  validateSearch: validateLineMonthlySearch,
  component: LineMonthlyRoute,
  staticData: {
    title: "nav.lineMonthly",
    breadcrumbs: [
      { label: "nav.oeePerformance" },
      { label: "nav.line" },
      { label: "nav.lineMonthly" },
    ],
  },
});

// One page of line month reports for the chosen year and month. `hideZero: false`
// for the machine screen's reason: a line whose month scored 0% still has a report,
// and hiding the row would make this screen claim it has none.
//
// SIZE 100 rather than 1: this list is the id lookup, and it is narrowed by
// (year, month) but NOT by line — core-api's coarse line list takes a
// `workCenterId`, and we send it, but the page still has to be searched rather than
// assumed to hold exactly one row.
const REPORT_PAGE = { page: 1, size: 100, hideZero: false } as const;

function LineMonthlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onFilter = (patch: Partial<LineMonthlySearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  // AREA → LINE, and the cascade STOPS HERE. The shipped hook owns the stranded-id
  // rule: a workCenterId left over from another area is dropped from the REQUEST
  // while staying in the URL, so a shared link does not flash unfiltered data.
  const { options: lineOptions, workCenterId: requestedLine } = useWorkCenterFilter(
    search.workCenterId,
  );

  // Fall back to the area's first line, so a bare /oee-performance/line/monthly has
  // something to draw. There is no useful "all lines" state: this is one report.
  const workCenterId = requestedLine ?? lineOptions[0]?.id;

  // (line, year, month) -> report id. GATED ON A RESOLVED LINE, for the machine
  // screen's reason: unscoped, this asks for every line in the plant to answer a
  // question about one of them.
  const reports = useLineReports(
    "month",
    { ...REPORT_PAGE, month: search.month, year: search.year, workCenterId },
    workCenterId !== undefined,
  );

  const settled = isListSettled(reports);

  // A LINE ROW'S KEY IS FLAT AND NOT NULL — `workCenterId`, straight off the Gold
  // row (0014) — where a machine row's is the nested, nullable `workUnit` the
  // enriched payload carries. Hence its own matcher rather than a shared one taking
  // a key selector; see findLineReportId.
  //
  // The cast narrows the list union to its coarse arm: `useLineReports("month", …)`
  // can only return period rows, but the fetcher's return type spans all three
  // grains because one function serves them.
  const reportId = findLineReportId(
    reports.data?.items as LinePeriodReportListItem[] | undefined,
    workCenterId,
  );
  const hasReport = settled && reportId !== undefined;

  const empty = lineEmptyState({
    lineCount: lineOptions.length,
    workCenterId,
    settled,
    hasReport,
    periodNoun: "month",
  });

  const { data: lineReport, isPending: reportPending } = useLineReport(
    "month",
    reportId ?? 0,
    hasReport,
  );

  // NARROWED TO THE COARSE ARM, and the check is on `grain` rather than a cast.
  // `useLineReport` spans all three grains because ONE fetcher serves them, so its
  // return type is the wide `LineReportDetail` union — and `lineSubject.tiles` takes
  // the period arm, because a shift report has a `shift: number` no tile here reads.
  // Asserting the arm with `as` would compile and then hand a SHIFT report's forty
  // measures to a month screen's KPI row if the id ever resolved to one; testing
  // `grain` makes that case render the empty state instead.
  const report: LinePeriodReportDetail | undefined =
    lineReport !== undefined && lineReport.grain !== "shift" ? lineReport : undefined;

  const closed = isMonthClosed(report?.businessDate);

  // NAMED LITERALLY. `/work-centers/month-reports/:id/oee-trend` returns the same
  // envelope as the machine and area endpoints, so a wrong pick here draws a
  // populated, plausible curve about another subject with nothing to say so.
  const trend = useLineMonthOeeTrend(reportId ?? 0, closed, hasReport);
  const rejects = useLineRejects("month", reportId ?? 0, hasReport);

  const params = (category: DowntimeCategory) =>
    report === undefined
      ? undefined
      : reasonBreakdownQuery(reasonBreakdownParams(report, category));

  const planned = useDowntimeReasons(params("PLANNED"));
  const unplanned = useDowntimeReasons(params("UNPLANNED"));
  const smallStop = useDowntimeReasons(params("SMALL_STOP"));

  const actions = useDowntimeActions(actionBreakdownQuery(report));

  return (
    <ReportListShell>
      <OeePerformanceFilterBar>
        <YearFilter value={search.year} onChange={(year) => onFilter({ year })} />
        <MonthFilter value={search.month} onChange={(month) => onFilter({ month })} />
        <DashboardLineFilter
          options={lineOptions}
          value={workCenterId}
          onChange={(nextLine) => onFilter({ workCenterId: nextLine })}
        />
      </OeePerformanceFilterBar>

      {empty !== undefined ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{empty}</p>
      ) : (
        <OeePerformanceView
          tiles={report === undefined ? [] : lineSubject.tiles(report)}
          measures={report}
          hasReport={hasReport}
          reportPending={reportPending}
          reportBusinessDay={report?.businessDate}
          timeZone={report?.timeZone ?? "UTC"}
          trend={trend}
          rejects={rejects}
          planned={planned}
          unplanned={unplanned}
          smallStop={smallStop}
          actions={actions}
          subjectLabel={lineSubject.label}
          copy={DASHBOARD_PERIOD_COPY.month}
          axis={TREND_AXIS.month}
          // NULL, DELIBERATELY. This line's reject buckets span every machine on it
          // and carry their own names; filling in the LINE's name would label a
          // whole line's rejects as one machine's.
          qualityMachineName={null}
        />
      )}
    </ReportListShell>
  );
}
