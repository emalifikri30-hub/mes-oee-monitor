import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import {
  areaProductionUnitsQueryOptions,
  areaReportQueryOptions,
  reportWindowParams,
  shiftTimelineQueryOptions,
  useAreaReport,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { AreaLossesCard } from "@/components/report/area-losses-card";
import { AreaOverviewCard } from "@/components/report/area-overview-card";
import { AreaProductionUnitsCard } from "@/components/report/area-production-units-card";
import { AreaReportHeader } from "@/components/report/area-report-header";
import { DowntimeDetailsCard } from "@/components/report/downtime-details-card";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { SkuViewCard } from "@/components/report/sku-view-card";
import { TimelineCard } from "@/components/report/timeline-card";
import { WaterfallCard } from "@/components/report/waterfall-card";

// One area, one MONTH.
//
// The trailing underscore on `by-monthly_` opts this route out of nesting under
// by-monthly.tsx. Without it TanStack would promote the list page to a layout route
// and this page would render inside the list's table card.
//
// ---------------------------------------------------------------------------
// IT IS THE DAY SCREEN WITH ONE VALUE CHANGED, AND THAT IS THE POINT
// ---------------------------------------------------------------------------
//
// Every card below takes the report and reads its `grain`, so this file differs
// from its By Day sibling in exactly three places: the two query calls name
// `"month"`, and the breadcrumbs say By Monthly. Nothing in the card set branches.
//
// What that buys is the thing worth naming: the month's numbers are a DIFFERENT
// TABLE rather than a wider read of the same one (`oee.area_month_reports`, 0025),
// because a month's RATES cannot be got by widening a day's — §15.5's rule is that
// durations and counts SUM while rates are RECOMPUTED. So the grain has to travel,
// and it travels as data on the report rather than as a flag in a component.
//
// AND THE ID IS MEANINGFUL ONLY AGAINST THAT TABLE. Nine report tables, eight
// INDEPENDENT identity sequences — the two AREA ones included. `areaReportQueryOptions("day", 7)`
// on this page compiles, keys under a different prefix, and renders a real report
// about a single day under a month heading.
//
// THE SUBJECT IS AS LOAD-BEARING AS THE GRAIN, AND THERE ARE FOUR OF THEM NOW.
// Nine report tables, nine INDEPENDENT identity sequences, so this route's
// `$reportId` is meaningful only against oee.area_day_reports.
// `areaReportQueryOptions` keys on "area-day-report"; calling any of the other
// seven queries here compiles perfectly and renders a full page of another
// subject's figures under an Area breadcrumb.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCREEN HAS THAT NO OTHER DOES
// ---------------------------------------------------------------------------
//
//   INPUT/OUTPUT PRODUCTION. The overview card's three production figures are
//   MASSES, because that is the only unit an area's member lines can all be
//   expressed in. That answers "how much did the area make" and cannot answer "how
//   many bags went in" — so this card breaks the same window out per unit, one
//   table per side. See area-production-units-card.tsx, which also states why it is
//   a table and not a chart.
//
//   AT THIS GRAIN IT READS ~30 LINE-DAYS PER LINE, because it widens
//   oee.work_center_day_reports rather than reading the line MONTH rows. That is
//   deliberate and gives FINER unit resolution: a line whose unit changed mid-month
//   has a NULL unit on its month row and would land in the residual, where its day
//   rows give two honest buckets. It is also why the route only PREFETCHES it.
//
// ---------------------------------------------------------------------------
// WHAT IT REUSES UNCHANGED, AND WHY THAT WAS ALMOST FREE
// ---------------------------------------------------------------------------
//
//   TimelineCard          takes params, not a report, and `reportWindowParams`
//   DowntimeDetailsCard   resolves an area to `scope: "area"` — a column
//   the Losses Paretos     oee.downtime_reports has carried since migration 0007.
//                         Adding `area` to core-api's SCOPE_COLUMN is what made all
//                         four of these work with no new arithmetic anywhere.
//   WaterfallCard         reads thirteen DURATIONS and nothing subject-specific.
//                         Note the bars are in LINE-hours summed over the MONTH
//                         here — a five-line month runs into the thousands — which
//                         is the same fact the Run Time tile carries a tooltip for.
//   SkuViewCard           takes AnyReport and dispatches through
//                         `useReportProducts`. At this grain the rows are a
//                         ROLL-UP over the area's lines — legitimate here and
//                         forbidden one grain down, for contract §17.1's reason.
//
// ---------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT HAVE
// ---------------------------------------------------------------------------
//
//   no MachineViewCard   an area is made of LINES, not machines, and there is no
//                        per-line measures breakdown endpoint at this grain. The
//                        Input/Output card is the closest thing and answers a
//                        different question — per UNIT, not per line.
//   no hourly production there is no product_perf_area_hour table, and an
//                        area-summed curve off the line table would be the roll-up
//                        contract §19.1 refuses. The Performance Loss tab renders
//                        an empty state naming that.
//   no approve/reopen,   oee.work_unit_shift_report_approvals is keyed
//   no Status            (work_unit_id, date, shift). An area day has neither, and
//                        no cascade is defined for it — approving an area would
//                        close every machine shift report in it, which is not a
//                        permission any role variable grants.
//   no Add Reject/Rework by requirement, and by schema: an entry is keyed by LINE,
//                        so an area-level button would have to make the operator
//                        pick one. See area-losses-card.tsx.
export const Route = createFileRoute("/_app/report/area/by-monthly_/$reportId")({
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    // Mirrors the handler's own guard. A non-numeric id is a broken link, not a
    // server fault, so it should never reach the network.
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // AWAITED: this is what turns a 404 from core-api into the router's notFound
    // state rather than an error banner inside an otherwise complete page. The
    // LIST endpoint answers 200-empty for an unknown filter while the DETAIL one
    // 404s — a list names a filter, a detail names a row.
    const report = await context.queryClient
      .ensureQueryData(areaReportQueryOptions("month", id))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    // UNAWAITED, BOTH OF THEM, so a failure in either stays card-local rather than
    // replacing the page. The Input/Output read is three aggregates over every line
    // report in the window — which is exactly why it is prefetched here and not
    // folded into the report payload the loader blocks on.
    void context.queryClient.prefetchQuery(areaProductionUnitsQueryOptions("month", id));

    // Cannot start earlier — the window comes from the report — so what this buys
    // is a request in flight before React renders rather than one that waits for
    // the card to mount.
    const window = reportWindowParams(report);
    if (window !== undefined) {
      void context.queryClient.prefetchQuery(shiftTimelineQueryOptions(window));
    }
  },
  // The router default of 1000ms would let a cold load sit on a blank frame.
  pendingMs: 150,
  pendingComponent: ReportSkeleton,
  errorComponent: ReportError,
  // Declared here rather than inherited from __root, so the sidebar and header
  // survive a bad id instead of the whole shell being replaced.
  notFoundComponent: ReportNotFound,
  component: AreaReportDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.area" },
      { label: "nav.byMonthly", to: "/report/area/by-monthly" },
      { label: "nav.detailReport" },
    ],
  },
});

function AreaReportDetailRoute() {
  const { reportId } = Route.useParams();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = useAreaReport("month", Number(reportId));

  if (!report) return <ReportSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <AreaReportHeader report={report} />
      <AreaOverviewCard report={report} />
      {/* Directly under the KPI row, as on the other seven screens: the numbers
          above say how much time went where, the strip says when. At area scope it
          merges every stop on every line, which is what makes it a useful first
          look and why the table below it carries a Machine column. */}
      <TimelineCard params={reportWindowParams(report)} />
      <WaterfallCard report={report} />
      <AreaLossesCard report={report} />
      {/* The records behind the strip above. Same table, same read, same scope —
          DowntimeDetailsCard takes the report and derives its params through
          `reportWindowParams`, so it cannot disagree with the strip about which
          stops belong to this area. */}
      <DowntimeDetailsCard report={report} />
      <SkuViewCard report={report} />
      {/* LAST, and after SKU View deliberately. Both break the same window down,
          and this one is the coarser cut — a reader scanning for a product looks
          above it, a reader reconciling units looks here. */}
      <AreaProductionUnitsCard report={report} />
    </div>
  );
}

function ReportNotFound() {
  return (
    <EmptyState
      title="Report not found"
      body="This area report does not exist, or it is no longer available."
    />
  );
}

function ReportError() {
  return (
    <EmptyState
      title="Could not load this report"
      body="Something went wrong fetching this area report. Try again in a moment."
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/report/area/by-monthly">Back to By Monthly</Link>
      </Button>
    </div>
  );
}
