import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import {
  metricsStalenessQueryOptions,
  shiftReportProductsQueryOptions,
  shiftReportQueryOptions,
  reportWindowParams,
  shiftTimelineQueryOptions,
  useShiftReport,
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

// The trailing underscore on `by-shift_` opts this route out of nesting under
// by-shift.tsx. Without it TanStack would promote the list page to a layout
// route, and the detail page would render inside the list's table card.
export const Route = createFileRoute("/_app/report/machine/by-shift_/$reportId")({
  // Blocking rather than a background prefetch: awaiting here is what lets a 404
  // from core-api become the router's notFound state instead of an error banner
  // rendered inside an otherwise complete page.
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    // Mirrors the handler's own guard. A non-numeric id is a broken link, not a
    // server fault, so it should never reach the network.
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // Started before the report is awaited, and genuinely concurrent with it: the
    // SKU breakdown is addressed by report id alone, so there is nothing to derive
    // from the report first. Contrast the timeline below.
    void context.queryClient.prefetchQuery(shiftReportProductsQueryOptions(id));

    // The stale-metrics signal, on the same terms: addressed by report id alone,
    // so it needs nothing from the report, and NOT awaited.
    //
    // Not awaiting it is the whole reason this is a separate endpoint rather than
    // a field on the report payload. It scans the shift's downtime rows, and the
    // report below IS awaited — folding it in would put that scan on the blocking
    // path of every page view, for a banner that is absent on almost all of them.
    void context.queryClient.prefetchQuery(metricsStalenessQueryOptions(id));

    const report = await context.queryClient
      .ensureQueryData(shiftReportQueryOptions(id))
      .catch((err: unknown) => {
        // 404/400 mean the id names nothing — a broken link, not a fault. The
        // predicate lives in lib/route-error.ts, shared with the Losses route
        // and tested there; 401s are already handled by the axios refresh
        // interceptor, and anything left belongs on the error boundary.
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    // Also not awaited, but for a different reason than the products call above.
    // The timeline's parameters come from the report, so this one genuinely cannot
    // start any earlier — what starting it here buys is a request in flight before
    // React renders the tree, rather than one that waits for the card to mount and
    // fire an effect.
    //
    // Not awaiting either of them is what keeps a failure card-local: an unawaited
    // rejection cannot reject the loader, so every other card still renders.
    const timeline = reportWindowParams(report);
    if (timeline !== undefined) {
      void context.queryClient.prefetchQuery(shiftTimelineQueryOptions(timeline));
    }
  },
  // The router default of 1000ms would let a cold load sit on a blank frame.
  pendingMs: 150,
  pendingComponent: ReportSkeleton,
  errorComponent: ReportError,
  // Declared on this route rather than inherited from __root, so the sidebar and
  // header survive a bad id instead of the whole shell being replaced.
  notFoundComponent: ReportNotFound,
  component: ShiftReportDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.machine" },
      { label: "nav.byShift", to: "/report/machine/by-shift" },
      { label: "nav.detailReport" },
    ],
  },
});

function ShiftReportDetailRoute() {
  const { reportId } = Route.useParams();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = useShiftReport(Number(reportId));

  if (!report) return <ReportSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      {/* ABOVE the header, and rendering nothing until it has an answer. It warns
          that the cards below disagree with an edit somebody made, so it has to
          precede them — and a skeleton here would push the whole page down and
          then let it snap back when the unawaited prefetch lands. */}
      <StaleMetricsBanner
        options={metricsStalenessQueryOptions(report.id)}
        timeZone={report.timeZone}
      />
      <ReportHeader report={report} />
      <SummaryOeeCard report={report} />
      {/* Sits directly under the KPI row, as in the design: the numbers above
          say how much time went where, the strip says when. */}
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
      body="This shift report does not exist, or it is no longer available."
    />
  );
}

function ReportError() {
  return (
    <EmptyState
      title="Could not load this report"
      body="Something went wrong fetching the shift report. Try again in a moment."
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/report/machine/by-shift">Back to By Shift</Link>
      </Button>
    </div>
  );
}
