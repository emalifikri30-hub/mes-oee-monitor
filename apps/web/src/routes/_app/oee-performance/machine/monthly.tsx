import { createFileRoute } from "@tanstack/react-router";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { findReportId, isListSettled, resolveSelection } from "@/lib/oee-dashboard/selection";
import { isMonthClosed, TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { machineEmptyState } from "@/lib/oee-dashboard/empty-state";
import { machineSubject } from "@/lib/oee-dashboard/subject";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { validateMachineMonthlySearch } from "@/lib/oee-dashboard/oee-performance-search";
import {
  actionBreakdownQuery,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  useDowntimeActions,
  useDowntimeReasons,
  useMachineMonthOeeTrend,
  usePeriodReport,
  usePeriodReports,
  usePeriodReportRejects,
  useWorkUnits,
} from "@/lib/queries";
import {
  DashboardLineFilter,
  DashboardMachineFilter,
  OeePerformanceFilterBar,
} from "@/components/oee-dashboard/oee-performance-filter-bar";
import { MonthFilter, YearFilter } from "@/components/report/report-list-filters";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { ReportListShell } from "@/components/report/report-list-shell";

import type { DowntimeCategory } from "@/lib/types";
import type { MachineMonthlySearch } from "@/lib/oee-dashboard/oee-performance-search";

// OEE Performance → Machine → Machine Monthly.
//
// THE PATH IS `monthly`, NOT `by-monthly`, and the difference is not cosmetic.
// Under /report, `by-monthly` names a LIST of reports grouped by month. This is
// one dashboard about one month, and the distinct spelling is what keeps the
// nine-sequences hazard's literal route unions unambiguous — every `to` in this
// app is a literal precisely so a rename is a build failure rather than a link to
// another subject's screen.
//
// A NEW TOP-LEVEL SEGMENT, which means TWO allow-lists had to move with it:
// `ALLOWED_PREFIXES` in apps/bff/src/module/auth/auth-service.ts (without it,
// signing in from a deep link here silently lands on `/`) and the sidebar node.
// `PROXY_ALLOWED_PREFIXES` needed nothing — every call is under /v1/. Its five
// siblings needed NEITHER change: one prefix covers a whole top-level segment.
//
// THE FIRST OF SIX, and what it no longer holds is the point. The card grid, the
// empty ladder, the settled-list rule and the filter chrome moved out when the line
// and area screens landed — see OeePerformanceView. What stays here is everything
// that DISPATCHES: the four fetchers, named as literals so a test can assert which
// ran, and the `machine` subject's own cascade.
export const Route = createFileRoute("/_app/oee-performance/machine/monthly")({
  validateSearch: validateMachineMonthlySearch,
  component: MachineMonthlyRoute,
  staticData: {
    title: "nav.machineMonthly",
    breadcrumbs: [
      // No `to` on the first two: "OEE Performance" is a nav group with no route
      // of its own, and "Machine" is a group rather than a page. A crumb pointing
      // at a route that does not exist is a build failure here, which is the point.
      { label: "nav.oeePerformance" },
      { label: "nav.machine" },
      { label: "nav.machineMonthly" },
    ],
  },
});

// One page of month reports for the chosen line. 100 is the API's hard cap and is
// comfortably above any real line's machine count.
//
// THIS IS NOT THE PICKER'S SOURCE — the picker reads /master-data/work-units, so
// its options do not change when the month does. This list exists only to turn
// (line, year, month, machine) into a REPORT ID, and `hideZero: false` matters for
// exactly that: a machine whose month scored 0% still has a report, and hiding the
// row would make the screen claim it has none.
const REPORT_PAGE = { page: 1, size: 100, hideZero: false } as const;

function MachineMonthlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const onFilter = (patch: Partial<MachineMonthlySearch>) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  };

  // AREA → LINE, through the shipped hook, which also owns the stranded-id rule:
  // a workCenterId left over from another area is dropped from the REQUEST while
  // staying in the URL, so a shared link does not flash unfiltered data.
  const { options: lineOptions, workCenterId: requestedLine } = useWorkCenterFilter(
    search.workCenterId,
  );

  // Fall back to the area's first line so the screen has something to show on a
  // bare /oee-performance/machine/monthly. Unlike a report LIST, there is no
  // useful "all lines" state here: the dashboard is about one machine.
  const workCenterId = requestedLine ?? lineOptions[0]?.id;

  // LINE → MACHINE. A catalogue, cached at REFERENCE_STALE_TIME, and stable across
  // months — which is the whole reason it is not derived from the report list.
  const { data: machineOptions } = useWorkUnits(workCenterId);

  // The same stranded-id rule one level down, stated as a tested function — see
  // resolveSelection for why the still-loading case must let the requested id
  // stand rather than falling back to the first option.
  const workUnitId = resolveSelection(search.workUnitId, machineOptions);

  // (line, year, month, machine) -> report id.
  // GATED ON A RESOLVED LINE. Unscoped, this asks for every machine in the plant
  // to answer a question about one of them — and the answer would be a page the
  // machine might not even be on.
  const reports = usePeriodReports(
    "month",
    { ...REPORT_PAGE, month: search.month, year: search.year, workCenterId },
    workCenterId !== undefined,
  );

  // PLACEHOLDER DATA IS NOT AN ANSWER — see isListSettled, which carries the whole
  // argument and the test that pins it.
  const settled = isListSettled(reports);

  // GATED ON SETTLED ROWS. A stale list plus a `workUnitId` still carried in the URL
  // can resolve to the PREVIOUS machine's report id, while the filter bar already
  // shows the new machine's name — a populated, plausible card about a different
  // machine, with nothing on screen to say so.
  const reportId = findReportId(reports.data?.items, workUnitId);
  const hasReport = settled && reportId !== undefined;

  const empty = machineEmptyState({
    lineCount: lineOptions.length,
    workCenterId,
    machineOptions,
    settled,
    workUnitId,
    hasReport,
    periodNoun: "month",
  });

  const { data: report, isPending: reportPending } = usePeriodReport(
    "month",
    reportId ?? 0,
    hasReport,
  );

  // A FINISHED MONTH CAN NEVER CHANGE, so every query below caches it forever.
  // Derived from the report rather than from a `to` on the payload, because these
  // payloads carry no window — see machineMonthOeeTrendQueryOptions.
  const closed = isMonthClosed(report?.businessDate);

  // NAMED LITERALLY, NOT LOOKED UP FROM THE SUBJECT REGISTRY. All three subjects'
  // trend endpoints return an identical envelope, so a wrong pick draws a plausible
  // curve about another subject — and naming the hook is the only thing that lets a
  // test assert WHICH fetcher ran. Same rule for the rejects hook below.
  const trend = useMachineMonthOeeTrend(reportId ?? 0, closed, hasReport);
  const rejects = usePeriodReportRejects("month", reportId ?? 0, hasReport);

  // THE THREE DOWNTIME CATEGORIES, through the SHARED composer. `reasonBreakdownParams`
  // discriminates on the report's own subject and grain and returns the right
  // scope, so there is no second statement of that mapping here — which is exactly
  // what its header warns against, and what `30faeed` had to fix one subject over.
  const params = (category: DowntimeCategory) =>
    report === undefined
      ? undefined
      : reasonBreakdownQuery(reasonBreakdownParams(report, category));

  const planned = useDowntimeReasons(params("PLANNED"));
  const unplanned = useDowntimeReasons(params("UNPLANNED"));
  const smallStop = useDowntimeReasons(params("SMALL_STOP"));

  // Pareto Actions — what was DONE about the stops, rather than why they happened.
  // The one query on this screen that no other card shares.
  const actions = useDowntimeActions(actionBreakdownQuery(report));

  return (
    <ReportListShell>
      <OeePerformanceFilterBar>
        <YearFilter value={search.year} onChange={(year) => onFilter({ year })} />
        <MonthFilter value={search.month} onChange={(month) => onFilter({ month })} />
        {/* CHANGING THE LINE CLEARS THE MACHINE. A work unit from the previous line
            is not on this one, so carrying it would either strand the screen on a
            machine the picker no longer offers or — worse — leave a stale id in the
            URL that resolves to another line's report. The route re-resolves a
            default machine from the new line's options. */}
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
          copy={DASHBOARD_PERIOD_COPY.month}
          axis={TREND_AXIS.month}
          // The rejects endpoint is scoped to ONE machine here, so the report knows
          // the name a bucket's enrichment could not supply. Null on the line and
          // area screens, where the buckets span many machines.
          qualityMachineName={report?.workUnitName ?? null}
        />
      )}
    </ReportListShell>
  );
}
