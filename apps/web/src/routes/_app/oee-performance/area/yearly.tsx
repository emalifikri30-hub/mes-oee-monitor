import { createFileRoute } from "@tanstack/react-router";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { areaEmptyState } from "@/lib/oee-dashboard/empty-state";
import { areaSubject } from "@/lib/oee-dashboard/subject";
import { findAreaYearReportId, isListSettled } from "@/lib/oee-dashboard/selection";
import { isYearClosed, TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { useSelectedArea } from "@/components/layout/area-context";
import { validateAreaYearlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import {
  actionBreakdownQuery,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  useAreaYearOeeTrend,
  useAreaYearRejects,
  useAreaYearReport,
  useAreaYearReports,
  useAreas,
  useDowntimeActions,
  useDowntimeReasons,
} from "@/lib/queries";
import { OeePerformanceFilterBar } from "@/components/oee-dashboard/oee-performance-filter-bar";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { ReportListShell } from "@/components/report/report-list-shell";
import { YearFilter } from "@/components/report/report-list-filters";

import type { AreaYearlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import type { DowntimeCategory } from "@/lib/types";

// OEE Performance → Area → Area Yearly.
//
// `oee.area_year_reports` (`0027`), and the screen where `0024`'s two inversions are
// LOUDEST rather than different:
//
//   * ITS DURATIONS ARE LINE-MILLISECONDS TIMES A YEAR. A five-line area's Calendar
//     Time is ~43,800 hours. That is the intended figure, and it is the one a
//     supervisor will report as a bug. Nothing here divides by the line count.
//   * ITS COUNTS ARE A MASS, in one unit, precisely because the member lines have
//     many.
//
// FOUR TILES, NOT SIX. An area has no `teep` column at any grain, because TEEP
// divides by a CALENDAR an area does not own — is a five-line area's year 8,760
// hours, or 43,800? Utility has the same denominator and the same problem. A blank
// tile would read as "not computed yet"; the truth is that neither figure exists
// for an area, which is why `tiles` is a LIST and never a six-tuple.
//
// NO AREA PICKER, and the list is GATED on a resolved area — the same two calls the
// monthly screen makes, and its header carries the argument for both.
export const Route = createFileRoute("/_app/oee-performance/area/yearly")({
  validateSearch: validateAreaYearlySearch,
  component: AreaYearlyRoute,
  staticData: {
    title: "nav.areaYearly",
    breadcrumbs: [
      { label: "nav.oeePerformance" },
      { label: "nav.area" },
      { label: "nav.areaYearly" },
    ],
  },
});

// ONE ROW PER AREA PER YEAR, and unlike the monthly screen the SERVER narrows it:
// `/areas/year-reports` takes a `year` where `/areas/month-reports` refuses a
// `month`. So this asks for the year it wants and `findAreaYearReportId` only has
// to confirm the row belongs to this area.
const REPORT_PAGE = { page: 1, size: 20, hideZero: false } as const;

function AreaYearlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onFilter = (patch: Partial<AreaYearlySearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  const { areaId } = useSelectedArea();
  const { data: areas } = useAreas();

  const reports = useAreaYearReports(
    { ...REPORT_PAGE, year: search.year, areaId },
    areaId !== undefined,
  );

  const settled = isListSettled(reports);
  const reportId = findAreaYearReportId(reports.data?.items, areaId);
  const hasReport = settled && reportId !== undefined;

  const empty = areaEmptyState({
    areaId,
    areasLoaded: areas !== undefined,
    settled,
    hasReport,
    periodNoun: "year",
  });

  const { data: report, isPending: reportPending } = useAreaYearReport(reportId ?? 0, hasReport);

  const closed = isYearClosed(report?.businessDate);

  const trend = useAreaYearOeeTrend(reportId ?? 0, closed, hasReport);
  const rejects = useAreaYearRejects(reportId ?? 0, hasReport);

  // AN AREA IS A SCOPE OF ITS OWN, and `REPORT_GRAINS` carries "year" since `0027`,
  // so `reportWindowParams` returns `{scope: "area", grain: "year"}` and all three
  // Paretos plus Pareto Actions serve this screen with no new arithmetic.
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
      </OeePerformanceFilterBar>

      {empty !== undefined ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{empty}</p>
      ) : (
        <OeePerformanceView
          tiles={report === undefined ? [] : areaSubject.tiles(report)}
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
          subjectLabel={areaSubject.label}
          copy={DASHBOARD_PERIOD_COPY.year}
          axis={TREND_AXIS.year}
          qualityMachineName={null}
        />
      )}
    </ReportListShell>
  );
}
