import { createFileRoute } from "@tanstack/react-router";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { findReportId, isListSettled, resolveSelection } from "@/lib/oee-dashboard/selection";
import { isYearClosed, TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { machineEmptyState } from "@/lib/oee-dashboard/empty-state";
import { machineSubject } from "@/lib/oee-dashboard/subject";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { validateMachineYearlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import {
  actionBreakdownQuery,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  useDowntimeActions,
  useDowntimeReasons,
  useMachineYearOeeTrend,
  useMachineYearRejects,
  useMachineYearReport,
  useMachineYearReports,
  useWorkUnits,
} from "@/lib/queries";
import {
  DashboardLineFilter,
  DashboardMachineFilter,
  OeePerformanceFilterBar,
} from "@/components/oee-dashboard/oee-performance-filter-bar";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { ReportListShell } from "@/components/report/report-list-shell";
import { YearFilter } from "@/components/report/report-list-filters";

import type { DowntimeCategory } from "@/lib/types";
import type { MachineYearlySearch } from "@/lib/oee-dashboard/oee-performance-search";

// OEE Performance → Machine → Machine Yearly.
//
// THE FIRST SCREEN IN THIS APP AT YEAR GRAIN. Migration `0027` added
// `oee.work_unit_year_reports` and contract §27 is the pipeline's ask for it; the
// table SHIPS EMPTY, so until Airflow writes it (or
// `apps/api/scripts/seed/0025_work_unit_year_reports_dev.sql` is run locally) this
// screen reaches "this machine has no report for the selected year" — the same
// reachable state a machine with no August report produces one grain down.
//
// WHY A TABLE RATHER THAN THE MONTH SCREEN WITH A WIDER RANGE: §15.5. Durations and
// counts SUM, RATES ARE RECOMPUTED — so a year's OEE is not the average of its
// months', and deriving it here would be a second definition of OEE one click from
// the month screen this drills into.
//
// EVERYTHING BELOW THE KPI ROW IS THE MONTHLY SCREEN'S, unchanged. `REPORT_GRAINS`
// carries "year" now, so `reportWindowParams` returns `grain: "year"` and all three
// downtime Paretos plus Pareto Actions serve this with no new arithmetic anywhere.
export const Route = createFileRoute("/_app/oee-performance/machine/yearly")({
  validateSearch: validateMachineYearlySearch,
  component: MachineYearlyRoute,
  staticData: {
    title: "nav.machineYearly",
    breadcrumbs: [
      { label: "nav.oeePerformance" },
      { label: "nav.machine" },
      { label: "nav.machineYearly" },
    ],
  },
});

// One page of year reports for the chosen line. `hideZero: false` for the monthly
// screen's reason: a machine whose year scored 0% still has a report, and hiding
// the row would make this screen claim it has none.
const REPORT_PAGE = { page: 1, size: 100, hideZero: false } as const;

function MachineYearlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onFilter = (patch: Partial<MachineYearlySearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  const { options: lineOptions, workCenterId: requestedLine } = useWorkCenterFilter(
    search.workCenterId,
  );
  const workCenterId = requestedLine ?? lineOptions[0]?.id;

  const { data: machineOptions } = useWorkUnits(workCenterId);
  const workUnitId = resolveSelection(search.workUnitId, machineOptions);

  // (line, year, machine) -> report id. NO `month` ANYWHERE: the year list
  // validator does not declare one and the endpoint refuses one.
  const reports = useMachineYearReports(
    { ...REPORT_PAGE, year: search.year, workCenterId },
    workCenterId !== undefined,
  );

  const settled = isListSettled(reports);
  const reportId = findReportId(reports.data?.items, workUnitId);
  const hasReport = settled && reportId !== undefined;

  const empty = machineEmptyState({
    lineCount: lineOptions.length,
    workCenterId,
    machineOptions,
    settled,
    workUnitId,
    hasReport,
    periodNoun: "year",
  });

  const { data: report, isPending: reportPending } = useMachineYearReport(reportId ?? 0, hasReport);

  // `isYearClosed`, NOT `isMonthClosed`. The month predicate compares the first
  // SEVEN characters, so on a year row it reads "2026-01" against the current
  // "2026-09" and reports a finished year as open all year — which only costs
  // refetches, where the reverse pairing caches a live period forever.
  const closed = isYearClosed(report?.businessDate);

  const trend = useMachineYearOeeTrend(reportId ?? 0, closed, hasReport);
  const rejects = useMachineYearRejects(reportId ?? 0, hasReport);

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
        {/* NO MonthFilter. A year screen carrying one would be a control that reads
            as applied and narrows nothing — the search validator drops the field
            and the endpoint refuses it. */}
        <YearFilter value={search.year} onChange={(year) => onFilter({ year })} />
        <DashboardLineFilter
          options={lineOptions}
          value={workCenterId}
          onChange={(nextLine) => onFilter({ workCenterId: nextLine, workUnitId: undefined })}
        />
        <DashboardMachineFilter
          options={machineOptions ?? []}
          value={workUnitId}
          onChange={(nextMachine) => onFilter({ workUnitId: nextMachine })}
        />
      </OeePerformanceFilterBar>

      {empty !== undefined ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{empty}</p>
      ) : (
        <OeePerformanceView
          tiles={report === undefined ? [] : machineSubject.tiles(report)}
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
          subjectLabel={machineSubject.label}
          copy={DASHBOARD_PERIOD_COPY.year}
          // TWELVE MONTHLY POINTS, so the ticks read Jan…Dec and the tooltip says
          // "August 2026" rather than a raw `2026-08-01` that reads as one day.
          axis={TREND_AXIS.year}
          qualityMachineName={report?.workUnitName ?? null}
        />
      )}
    </ReportListShell>
  );
}
