import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import {
  lineReportQueryOptions,
  lineApprovalQueryOptions,
  lineMetricsStalenessQueryOptions,
  lineMachinesQueryOptions,
  lineProductsQueryOptions,
  reportWindowParams,
  shiftTimelineQueryOptions,
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
import { StaleMetricsBanner } from "@/components/report/stale-metrics-banner";
import { TimelineCard } from "@/components/report/timeline-card";
import { WaterfallCard } from "@/components/report/waterfall-card";

// The trailing underscore on `by-shift_` opts this route out of nesting under
// by-shift.tsx. Without it TanStack would promote the list page to a layout
// route, and the detail page would render inside the list's table card.
//
// THE SUBJECT IS AS LOAD-BEARING AS THE GRAIN. There are seven report tables with
// seven INDEPENDENT identity sequences, so this route's `$reportId` is meaningful
// only against oee.work_center_shift_reports. `lineReportQueryOptions` and
// `useLineReport` carry both axes; calling a /work-units/* query here compiles
// perfectly and renders a full page of MACHINE figures under a Line breadcrumb.
//
// SEVEN SECTIONS: the banner, header, overview, timeline and waterfall from part 1,
// then Losses, Downtime Details and SKU View from part 2. Every card below the
// waterfall is the MACHINE screen's component, widened to the union rather than
// duplicated — the four rules report-list-shell.tsx records as having drifted
// silently when they were copies.
//
// What is still deliberately absent:
//
//   no Machine View arrow      to a machine's report AT A DIFFERENT GRAIN. Each row
//                              links at the SAME grain, from the report id the
//                              endpoint returns — never interpolated from this
//                              line's id, which is the six-sequences hazard.
//   no Performance Trendline   on the Losses page, an empty state rather than a
//                              missing sub-tab. Contract §16.4a, TODOS §61.
//   no reject/rework entry     the Losses card's two Add buttons are shown and
//                              inert; there is nowhere to write yet. TODOS §59.
//
// SKU View renders EMPTY until Airflow fills oee.product_count_wc_* (0016), and
// says which kind of empty — the ladder §14 built. A roll-up over the machines is
// not the fallback: a line is measured, not summed, so it would contradict the
// overview card on this same screen.
export const Route = createFileRoute("/_app/report/line/by-shift_/$reportId")({
  // Blocking rather than a background prefetch: awaiting here is what lets a 404
  // from core-api become the router's notFound state instead of an error banner
  // rendered inside an otherwise complete page.
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    // Mirrors the handler's own guard. A non-numeric id is a broken link, not a
    // server fault, so it should never reach the network.
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // NOT AWAITED, and that is the whole reason the approval summary is a separate
    // endpoint. The server has to resolve the line's ROSTER from mes-master-data to
    // answer it, and that call is not cached — folding it into the report payload
    // would put an uncached upstream request on the blocking path of every page
    // view, for one tile. Exactly the argument /metrics-staleness shipped with.
    void context.queryClient.prefetchQuery(lineApprovalQueryOptions(id));

    // The stale-metrics signal, on the same terms and for the same reason: it
    // scans the window's downtime rows across the line's machines, and the report
    // below IS awaited. §50 one subject wider; the coarse grains are §60.
    void context.queryClient.prefetchQuery(lineMetricsStalenessQueryOptions(id));

    // The SKU rows, warmed on the same terms — not awaited, so the card owns its
    // own failure. THROUGH THE SAME OPTIONS OBJECT THE CARD SUBSCRIBES TO, which
    // is what stops this writing a cache entry nobody reads: the key carries both
    // the subject and the grain, and a mismatch on either would leave the warmed
    // entry unread while the card fetched a different one.
    void context.queryClient.prefetchQuery(lineProductsQueryOptions("shift", id));

    // The per-machine breakdown, same terms. At SHIFT grain the server has to
    // resolve the line's ROSTER from mes-master-data to answer this —
    // work_unit_shift_reports has no work_center_id — so it is the one card here
    // whose cost is an upstream call, and exactly why it is not awaited. At day and
    // month grain 0013's work_center_id makes it a plain predicate and no upstream
    // call at all.
    void context.queryClient.prefetchQuery(lineMachinesQueryOptions("shift", id));

    const report = await context.queryClient
      .ensureQueryData(lineReportQueryOptions("shift", id))
      .catch((err: unknown) => {
        // 404/400 mean the id names nothing — a broken link, not a fault. Note the
        // LIST endpoint answers 200-empty for an unknown line while the DETAIL one
        // 404s: a list request names a filter, a detail request names a row.
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    // Cannot start any earlier — the window comes from the report — so what this
    // buys is a request in flight before React renders rather than one that waits
    // for the card to mount. Unawaited, so a failure stays card-local.
    //
    // `reportWindowParams` resolves this to `scope: "work-center"` because a line
    // report has no `workUnitId`; core-api's SCOPE_COLUMN already maps that scope,
    // which is why the strip needs no API work at this subject.
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
  component: LineReportDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.line" },
      { label: "nav.byShift", to: "/report/line/by-shift" },
      { label: "nav.detailReport" },
    ],
  },
});

function LineReportDetailRoute() {
  const { reportId } = Route.useParams();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = useLineReport("shift", Number(reportId));

  if (!report) return <ReportSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      {/* ABOVE the header, rendering nothing until it has an answer — a skeleton
          here would push the page down and let it snap back when the unawaited
          prefetch lands. A LINE's aggregates are precomputed by the pipeline
          exactly as a machine's are, so a category edit on any of its machines'
          stops leaves the tiles, the strip and the waterfall showing the pre-edit
          split. */}
      <StaleMetricsBanner
        options={lineMetricsStalenessQueryOptions(report.id)}
        timeZone={report.timeZone}
      />
      <LineReportHeader report={report} />
      <LineOverviewCard report={report} />
      {/* Directly under the KPI row, as in the design: the numbers above say how
          much time went where, the strip says when. */}
      <TimelineCard params={reportWindowParams(report)} />
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
        <Link to="/report/line/by-shift">Back to By Shift</Link>
      </Button>
    </div>
  );
}
