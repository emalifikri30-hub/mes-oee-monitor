import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import {
  lineMachinesQueryOptions,
  lineProductsQueryOptions,
  lineReportQueryOptions,
  useLineReport,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { DowntimeDetailsCard } from "@/components/report/downtime-details-card";
import { LineLossesCard } from "@/components/report/line-losses-card";
import { LineOverviewCard } from "@/components/report/line-overview-card";
import { MachineViewCard } from "@/components/report/machine-view-card";
import { LineReportHeader } from "@/components/report/line-report-header";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { SkuViewCard } from "@/components/report/sku-view-card";
import { WaterfallCard } from "@/components/report/waterfall-card";

// The trailing underscore on `by-monthly_` opts this route out of nesting under
// by-monthly.tsx. Without it TanStack would promote the list page to a layout
// route, and the detail page would render inside the list's table card.
//
// THE SUBJECT IS AS LOAD-BEARING AS THE GRAIN. There are seven report tables with
// seven INDEPENDENT identity sequences, so this route's `$reportId` is meaningful
// only against oee.work_center_month_reports. `lineReportQueryOptions` and
// `useLineReport` carry both axes; calling a /work-units/* query here compiles
// perfectly and renders a full page of MACHINE figures under a Line breadcrumb.
//
// SAME AS THE DAY ROUTE, MINUS THE TIMELINE.
//
//   NO TimelineCard            a month of stops renders as sub-pixel slivers on a
//                              strip built for eight hours — the machine month
//                              route's reason, and it applies harder here: a LINE
//                              window unions every machine's stops, so the same
//                              pixel holds N times as many.
//   no approve / reopen        see the day route.
//   no StaleMetricsBanner      see the day route.
//   Add Reject / Add Rework    absent, see the day route.
export const Route = createFileRoute("/_app/report/line/by-monthly_/$reportId")({
  // Blocking rather than a background prefetch: awaiting here is what lets a 404
  // from core-api become the router's notFound state instead of an error banner
  // rendered inside an otherwise complete page.
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    // Mirrors the handler's own guard. A non-numeric id is a broken link, not a
    // server fault, so it should never reach the network.
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // The SKU rows, warmed unawaited so the card owns its own failure. THROUGH THE
    // SAME OPTIONS OBJECT THE CARD SUBSCRIBES TO, which is what stops this writing
    // a cache entry nobody reads: the key carries both the subject and the grain,
    // and a mismatch on either would leave the warmed entry unread while the card
    // fetched a different one.
    void context.queryClient.prefetchQuery(lineProductsQueryOptions("month", id));

    // The per-machine breakdown, same terms. At SHIFT grain the server has to
    // resolve the line's ROSTER from mes-master-data to answer this —
    // work_unit_shift_reports has no work_center_id — so it is the one card here
    // whose cost is an upstream call, and exactly why it is not awaited. At day and
    // month grain 0013's work_center_id makes it a plain predicate and no upstream
    // call at all.
    void context.queryClient.prefetchQuery(lineMachinesQueryOptions("month", id));

    const report = await context.queryClient
      .ensureQueryData(lineReportQueryOptions("month", id))
      .catch((err: unknown) => {
        // 404/400 mean the id names nothing — a broken link, not a fault. Note the
        // LIST endpoint answers 200-empty for an unknown line while the DETAIL one
        // 404s: a list request names a filter, a detail request names a row.
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    // No timeline to prefetch — see the header. `report` is still awaited above
    // for the 404 mapping.
    void report;
  },
  // The router default of 1000ms would let a cold load sit on a blank frame.
  pendingMs: 150,
  pendingComponent: ReportSkeleton,
  errorComponent: ReportError,
  // Declared on this route rather than inherited from __root, so the sidebar and
  // header survive a bad id instead of the whole shell being replaced.
  notFoundComponent: ReportNotFound,
  component: LineReportDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.line" },
      { label: "nav.byMonthly", to: "/report/line/by-monthly" },
      { label: "nav.detailReport" },
    ],
  },
});

function LineReportDetailRoute() {
  const { reportId } = Route.useParams();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = useLineReport("month", Number(reportId));

  if (!report) return <ReportSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <LineReportHeader report={report} />
      <LineOverviewCard report={report} />
      <WaterfallCard report={report} />
      <LineLossesCard report={report} />
      {/* The records behind the strip above. The page reads summary -> when ->
          where the time went -> which stops.

          THE MACHINE COLUMN EARNS ITS PLACE HERE in a way it does not on a machine
          report, where it repeats the header on every row. Downtime is scoped by a
          query param rather than nested under a work unit, so this is the same
          table and the same read — `reportWindowParams` resolves a line report to
          `scope: "work-center"`. */}
      <DowntimeDetailsCard report={report} />
      {/* WHICH MACHINE dragged the line down. Between the stops and the SKUs
          deliberately: the stops above say what happened, this says to whom, and
          the SKUs below say what came out anyway.

          Its rows do NOT add up to the overview card at the top of this page, and
          the card says so — a line is measured at its own count points. */}
      <MachineViewCard report={report} />
      {/* And finally what came out, per SKU. EMPTY UNTIL AIRFLOW FILLS
          oee.product_count_wc_* (migration 0016, contract §17) — and the card says
          which kind of empty it is, which is the whole reason §14's ladder exists.
          A roll-up over the machines is NOT the fallback: a line is measured, not
          summed, so it would print figures that contradict the overview card
          directly above. */}
      <SkuViewCard report={report} />
    </div>
  );
}

function ReportNotFound() {
  return (
    <EmptyState
      title="Report not found"
      body="This line report does not exist, or it is no longer available."
    />
  );
}

function ReportError() {
  return (
    <EmptyState
      title="Could not load this report"
      body="Something went wrong fetching the line report. Try again in a moment."
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/report/line/by-monthly">Back to By Monthly</Link>
      </Button>
    </div>
  );
}
