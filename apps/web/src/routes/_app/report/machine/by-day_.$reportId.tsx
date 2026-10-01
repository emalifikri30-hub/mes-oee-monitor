import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import {
  periodReportProductsQueryOptions,
  periodMetricsStalenessQueryOptions,
  periodReportQueryOptions,
  reportWindowParams,
  shiftTimelineQueryOptions,
  usePeriodReport,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { DowntimeDetailsCard } from "@/components/report/downtime-details-card";
import { LossesCard } from "@/components/report/losses-card";
import { ReportHeader } from "@/components/report/report-header";
import { StaleMetricsBanner } from "@/components/report/stale-metrics-banner";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { SkuViewCard } from "@/components/report/sku-view-card";
import { SummaryOeeCard } from "@/components/report/summary-oee-card";
import { TimelineCard } from "@/components/report/timeline-card";
import { WaterfallCard } from "@/components/report/waterfall-card";

// The trailing underscore on `by-day_` opts this route out of nesting under
// by-day.tsx. Without it TanStack would promote the list page to a layout
// route, and the detail page would render inside the list's table card.
//
// HOW THIS DIFFERS FROM THE SHIFT DETAIL ROUTE, and each difference is the
// reference design's:
//
//   no StaleMetricsBanner  /metrics-staleness is shift-keyed; there is no day
//                          equivalent yet, and the day and month tables are
//                          stale after a category edit in exactly the way the
//                          shift table is (downtime-edit-trd.md). TODOS.md §50.
//   TimelineCard KEPT      a day is 24 hours, which the strip renders fine. The
//                          month route drops it — see there.
//   no approve/reopen      handled inside ReportHeader/ReportActions.
export const Route = createFileRoute("/_app/report/machine/by-day_/$reportId")({
  // Blocking rather than a background prefetch: awaiting here is what lets a 404
  // from core-api become the router's notFound state instead of an error banner
  // rendered inside an otherwise complete page.
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    // Mirrors the handler's own guard. A non-numeric id is a broken link, not a
    // server fault, so it should never reach the network.
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // Addressed by report id alone, so there is nothing to derive from the
    // report first — genuinely concurrent with the await below, and NOT awaited
    // so a failure stays card-local.
    void context.queryClient.prefetchQuery(periodReportProductsQueryOptions("day", id));

    // The stale-metrics signal, on the same terms: addressed by report id alone,
    // and NOT awaited. It scans the window's downtime rows, and the report below
    // IS awaited — folding it in would put that scan on the blocking path of every
    // page view for a banner absent on almost all of them. TODOS §50 shipped the
    // endpoint this reads.
    void context.queryClient.prefetchQuery(periodMetricsStalenessQueryOptions("day", id));

    const report = await context.queryClient
      .ensureQueryData(periodReportQueryOptions("day", id))
      .catch((err: unknown) => {
        // 404/400 mean the id names nothing — a broken link, not a fault. The
        // predicate lives in lib/route-error.ts and is shared with the shift
        // routes; 401s are already handled by the axios refresh interceptor.
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    // Cannot start any earlier: the window's parameters come off the report. At
    // this grain that is a plain read of `businessDate` rather than a zone
    // conversion — see reportWindowParams.
    const window = reportWindowParams(report);
    if (window !== undefined) {
      void context.queryClient.prefetchQuery(shiftTimelineQueryOptions(window));
    }
  },
  // The router default of 1000ms would let a cold load sit on a blank frame.
  pendingMs: 150,
  pendingComponent: ReportSkeleton,
  errorComponent: ReportError,
  // Declared on this route rather than inherited from __root, so the sidebar and
  // header survive a bad id instead of the whole shell being replaced.
  notFoundComponent: ReportNotFound,
  component: DayReportDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.machine" },
      { label: "nav.byDay", to: "/report/machine/by-day" },
      { label: "nav.detailReport" },
    ],
  },
});

function DayReportDetailRoute() {
  const { reportId } = Route.useParams();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = usePeriodReport("day", Number(reportId));

  if (!report) return <ReportSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      {/* ABOVE the header, and rendering nothing until it has an answer. It warns
          that the cards below disagree with an edit somebody made, so it has to
          precede them — and a skeleton here would push the whole page down and
          then let it snap back when the unawaited prefetch lands.

          THE DAY REPORT ROLLS UP THE SAME TIME a shift report does, so a
          category edit makes it stale in exactly the same way. Only the shift
          screen said so until TODOS §50 shipped this endpoint. */}
      <StaleMetricsBanner
        options={periodMetricsStalenessQueryOptions("day", report.id)}
        timeZone={report.timeZone ?? "UTC"}
      />
      <ReportHeader report={report} />
      <SummaryOeeCard report={report} />
      {/* Sits directly under the KPI row, as in the design: the numbers above
          say how much time went where, the strip says when. 24 hours here
          rather than 8. */}
      <TimelineCard params={reportWindowParams(report)} />
      <WaterfallCard report={report} />
      <LossesCard report={report} />
      {/* The records behind the strip above. The page reads summary -> when ->
          where the time went -> which stops. */}
      <DowntimeDetailsCard report={report} />
      {/* And finally what came out, per SKU — the other half of the drill-down:
          Downtime Details accounts for the time lost, this accounts for the
          product made. */}
      <SkuViewCard report={report} />
    </div>
  );
}

function ReportNotFound() {
  return (
    <EmptyState
      title="Report not found"
      body="This day report does not exist, or it is no longer available."
    />
  );
}

function ReportError() {
  return (
    <EmptyState
      title="Could not load this report"
      body="Something went wrong fetching the day report. Try again in a moment."
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/report/machine/by-day">Back to By Day</Link>
      </Button>
    </div>
  );
}
