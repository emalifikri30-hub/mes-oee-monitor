import { createFileRoute } from "@tanstack/react-router";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { findLineReportId, isListSettled } from "@/lib/oee-dashboard/selection";
import { isYearClosed, TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { lineEmptyState } from "@/lib/oee-dashboard/empty-state";
import { lineSubject } from "@/lib/oee-dashboard/subject";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { validateLineYearlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import {
  actionBreakdownQuery,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  useDowntimeActions,
  useDowntimeReasons,
  useLineYearOeeTrend,
  useLineYearRejects,
  useLineYearReport,
  useLineYearReports,
} from "@/lib/queries";
import {
  DashboardLineFilter,
  OeePerformanceFilterBar,
} from "@/components/oee-dashboard/oee-performance-filter-bar";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { ReportListShell } from "@/components/report/report-list-shell";
import { YearFilter } from "@/components/report/report-list-filters";

import type { DowntimeCategory } from "@/lib/types";
import type { LineYearlySearch } from "@/lib/oee-dashboard/oee-performance-search";

// OEE Performance → Line → Line Yearly.
//
// `oee.work_center_year_reports` (`0027`), which SHIPS EMPTY like its two siblings.
//
// SIX TILES, the same six the monthly screen draws, because `0014`'s rule holds at
// every grain: A LINE OWNS A CALENDAR — its own count points and its own wall clock
// — so both TEEP's and Utility's denominators exist. A line's year is ~8,760 hours
// regardless of how many machines are on it; that is NOT the area's
// line-milliseconds, and nothing here divides by a machine count.
export const Route = createFileRoute("/_app/oee-performance/line/yearly")({
  validateSearch: validateLineYearlySearch,
  component: LineYearlyRoute,
  staticData: {
    title: "nav.lineYearly",
    breadcrumbs: [
      { label: "nav.oeePerformance" },
      { label: "nav.line" },
      { label: "nav.lineYearly" },
    ],
  },
});

const REPORT_PAGE = { page: 1, size: 100, hideZero: false } as const;

function LineYearlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onFilter = (patch: Partial<LineYearlySearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  const { options: lineOptions, workCenterId: requestedLine } = useWorkCenterFilter(
    search.workCenterId,
  );
  const workCenterId = requestedLine ?? lineOptions[0]?.id;

  const reports = useLineYearReports(
    { ...REPORT_PAGE, year: search.year, workCenterId },
    workCenterId !== undefined,
  );

  const settled = isListSettled(reports);
  const reportId = findLineReportId(reports.data?.items, workCenterId);
  const hasReport = settled && reportId !== undefined;

  const empty = lineEmptyState({
    lineCount: lineOptions.length,
    workCenterId,
    settled,
    hasReport,
    periodNoun: "year",
  });

  // NO GRAIN NARROWING NEEDED HERE, unlike the monthly screen. That one calls
  // `useLineReport`, whose ONE fetcher serves all three report grains and therefore
  // returns the wide `LineReportDetail` union; this is a year-only fetcher, so its
  // return type is already the year arm.
  const { data: report, isPending: reportPending } = useLineYearReport(reportId ?? 0, hasReport);

  const closed = isYearClosed(report?.businessDate);

  const trend = useLineYearOeeTrend(reportId ?? 0, closed, hasReport);
  const rejects = useLineYearRejects(reportId ?? 0, hasReport);

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
          copy={DASHBOARD_PERIOD_COPY.year}
          axis={TREND_AXIS.year}
          // NULL: this line's reject buckets span every machine on it and carry
          // their own names.
          qualityMachineName={null}
        />
      )}
    </ReportListShell>
  );
}
