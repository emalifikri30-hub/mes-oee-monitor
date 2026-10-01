import { createFileRoute } from "@tanstack/react-router";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { areaEmptyState } from "@/lib/oee-dashboard/empty-state";
import { areaSubject } from "@/lib/oee-dashboard/subject";
import { findAreaMonthReportId, isListSettled } from "@/lib/oee-dashboard/selection";
import { isMonthClosed, TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { useSelectedArea } from "@/components/layout/area-context";
import { validateAreaMonthlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import {
  actionBreakdownQuery,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  useAreaMonthOeeTrend,
  useAreaReport,
  useAreaReports,
  useAreaRejects,
  useAreas,
  useDowntimeActions,
  useDowntimeReasons,
} from "@/lib/queries";
import { MonthFilter, YearFilter } from "@/components/report/report-list-filters";
import { OeePerformanceFilterBar } from "@/components/oee-dashboard/oee-performance-filter-bar";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { ReportListShell } from "@/components/report/report-list-shell";

import type { AreaMonthlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import type { DowntimeCategory } from "@/lib/types";

// OEE Performance → Area → Area Monthly.
//
// THE THIRD SUBJECT, AND IT IS THE ONE THAT PROVES THE KPI ROW IS A LIST.
// `areaSubject` renders FOUR tiles — OEE, A, P, Q — and the two that are missing are
// the whole reason the registry types `tiles` as a list rather than a six-tuple.
// Migration `0024` gives `oee.area_day_reports` no `teep` column at all, because TEEP
// divides by CALENDAR time and an area owns no calendar a reader could name: is a
// five-line area's day 24 hours, or 120? Utility has the SAME denominator and the
// same problem, so it goes too. Four tiles, not six with two blanks — a blank reads
// as "not computed yet", which is a promise this figure will arrive.
//
// NO AREA PICKER ON THIS SCREEN, and that is the requirement's own call ("use
// existing filter area on the header layout"). It reads `useSelectedArea`, the
// app-wide header selection, exactly as the `Report > Area` list does — a second
// picker would either duplicate it or disagree with it.
//
// AND THE LIST IS GATED ON A RESOLVED AREA, WHICH INVERTS THAT LIST'S RULE. The
// Report Area list deliberately does NOT gate: core-api reads an absent `areaId` as
// EVERY area, so its first paint shows data and narrows a tick later, which is right
// for a table. Here the rows are not displayed, they are SEARCHED for one area's
// report id — so an ungated first response is a page of other areas' rows, and a
// match against it opens a stranger's report under this area's heading.
export const Route = createFileRoute("/_app/oee-performance/area/monthly")({
  validateSearch: validateAreaMonthlySearch,
  component: AreaMonthlyRoute,
  staticData: {
    title: "nav.areaMonthly",
    breadcrumbs: [
      { label: "nav.oeePerformance" },
      { label: "nav.area" },
      { label: "nav.areaMonthly" },
    ],
  },
});

// TWELVE ROWS, BECAUSE THE SERVER WILL NOT NARROW THIS ONE.
//
// `/areas/month-reports` accepts `year` and `areaId` and REFUSES `month` with a 400
// — area-report-dto.ts writes its month schema out as the day schema minus that
// field, because the requirement is "Monthly Report (Show all month on selected
// year)". So this asks for the whole year and `findAreaMonthReportId` picks the
// month, which is the one place on this surface where a filter is applied in the
// browser rather than on the wire.
const REPORT_PAGE = { page: 1, size: 12, hideZero: false } as const;

function AreaMonthlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onFilter = (patch: Partial<AreaMonthlySearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  // THE HEADER'S SELECTION, not a control of this screen's. `areaId` is undefined
  // only until the area catalogue resolves; `areas` is what tells the empty ladder
  // whether an undefined id means "still loading" or "this plant has no areas".
  const { areaId } = useSelectedArea();
  const { data: areas } = useAreas();

  const reports = useAreaReports(
    "month",
    { ...REPORT_PAGE, year: search.year, areaId },
    areaId !== undefined,
  );

  const settled = isListSettled(reports);

  const reportId = findAreaMonthReportId(reports.data?.items, areaId, search.month);
  const hasReport = settled && reportId !== undefined;

  const empty = areaEmptyState({
    areaId,
    areasLoaded: areas !== undefined,
    settled,
    hasReport,
    periodNoun: "month",
  });

  const { data: report, isPending: reportPending } = useAreaReport(
    "month",
    reportId ?? 0,
    hasReport,
  );

  const closed = isMonthClosed(report?.businessDate);

  // NAMED LITERALLY, like its two siblings. `/areas/month-reports/:id/oee-trend`
  // reads `oee.area_day_reports` and returns the SAME envelope the machine and line
  // endpoints do — which is exactly what makes a wrong pick invisible.
  const trend = useAreaMonthOeeTrend(reportId ?? 0, closed, hasReport);
  const rejects = useAreaRejects("month", reportId ?? 0, hasReport);

  // AN AREA IS A SCOPE OF ITS OWN — `reportWindowParams` returns `scope: "area"`,
  // which core-api's SCOPE_COLUMN has mapped since `0024`. So all three Paretos and
  // Pareto Actions serve this screen with NO new arithmetic anywhere: a stop on a
  // machine IS a stop on its area (CONTAINMENT), and no predicate beside the scope
  // is involved.
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
          copy={DASHBOARD_PERIOD_COPY.month}
          axis={TREND_AXIS.month}
          // NULL: this area's reject buckets span every machine on every line in it.
          qualityMachineName={null}
        />
      )}
    </ReportListShell>
  );
}
