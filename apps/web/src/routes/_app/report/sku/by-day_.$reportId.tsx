import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import {
  reportWindowParams,
  shiftTimelineQueryOptions,
  skuReportQueryOptions,
  useSkuReport,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { DowntimeDetailsCard } from "@/components/report/downtime-details-card";
import { ReportSkeleton } from "@/components/report/report-skeleton";
import { SkuLossesCard } from "@/components/report/sku-losses-card";
import { SkuOverviewCard } from "@/components/report/sku-overview-card";
import { SkuReportHeader } from "@/components/report/sku-report-header";
import { TimelineCard } from "@/components/report/timeline-card";
import { WaterfallCard } from "@/components/report/waterfall-card";

// One SKU, on one line, on one business day.
//
// The trailing underscore on `by-day_` opts this route out of nesting under
// by-day.tsx. Without it TanStack would promote the list page to a layout route
// and this page would render inside the list's table card.
//
// THE SUBJECT IS AS LOAD-BEARING AS THE GRAIN, AND THERE ARE THREE OF THEM NOW.
// Seven report tables, seven INDEPENDENT identity sequences, so this route's
// `$reportId` is meaningful only against oee.product_report_wc_day.
// `skuReportQueryOptions` keys on "sku-day-report"; calling a /work-centers/* or
// /work-units/* query here compiles perfectly and renders a full page of another
// subject's figures under a SKU breadcrumb.
//
// WHAT THIS SCREEN HAS THAT THE LINE'S DOES NOT
//
//   a SKU-SCOPED TIMELINE. `reportWindowParams` carries `productId`, so the strip
//   draws only this SKU's stops against a full-day axis — the gaps ARE the periods
//   it was not running. Every card on the page then answers the same question.
//
// WHAT IT DELIBERATELY DOES NOT HAVE
//
//   no MachineViewCard   a SKU ran on ONE line. There is no member breakdown, and
//                        summing a SKU across a line's machines needs a base-unit
//                        conversion those tables cannot supply (§15).
//   no SkuViewCard       the report IS one SKU. A per-SKU breakdown of a single
//                        SKU is one row repeating the card above it. (The SAME
//                        fact is what fixes the entry dialog's SKU field rather
//                        than offering a picker — see SkuLossesCard.)
//   no hourly production the requirement excludes it, so SkuLossesCard passes no
//                        `hourly` slot and the Performance Loss tab renders §61's
//                        empty state.
//   no approve/reopen,   oee.work_unit_shift_report_approvals is keyed
//   no Status            (work_unit_id, date, shift). This grain has neither, so
//                        there is nothing to sign and nothing to badge.
//
// AND ONE THING THAT ARRIVED AFTER THE ABOVE WAS WRITTEN: a LOG ACTIVITY panel.
// This block used to list the feed among the absences, on the reasoning that a SKU
// has no approval events — which is true and covers only ONE OF THE THREE ARMS a
// feed carries. The other two are real at this grain:
//
//   downtime edits   every recorded change to a stop attributed to THIS SKU.
//   quality entries  the reject and rework an operator recorded here by hand.
//
// So the panel exists, with two live arms and the approval one reported as
// `not-applicable` — the panel's whole job is to separate "nothing was recorded"
// from "nothing COULD be recorded", and a reader who knows the other six screens
// carry approvals deserves the answer rather than a gap. See sku-activity-sheet.tsx.
export const Route = createFileRoute("/_app/report/sku/by-day_/$reportId")({
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
      .ensureQueryData(skuReportQueryOptions(id))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    // Cannot start earlier — the window comes from the report — so what this buys
    // is a request in flight before React renders rather than one that waits for
    // the card to mount. Unawaited, so a failure stays card-local.
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
  component: SkuReportDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.sku" },
      { label: "nav.byDay", to: "/report/sku/by-day" },
      { label: "nav.detailReport" },
    ],
  },
});

function SkuReportDetailRoute() {
  const { reportId } = Route.useParams();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = useSkuReport(Number(reportId));

  if (!report) return <ReportSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <SkuReportHeader report={report} />
      <SkuOverviewCard report={report} />
      {/* Directly under the KPI row, as on the other six screens: the numbers
          above say how much time went where, the strip says when — and here, for
          which SKU. */}
      <TimelineCard params={reportWindowParams(report)} />
      <WaterfallCard report={report} />
      <SkuLossesCard report={report} />
      {/* The records behind the strip above. Same table, same read, narrowed by
          the same `productId` — DowntimeDetailsCard takes the report and derives
          its params through reportWindowParams, so it cannot disagree with the
          strip about which stops belong to this SKU. */}
      <DowntimeDetailsCard report={report} />
    </div>
  );
}

function ReportNotFound() {
  return (
    <EmptyState
      title="Report not found"
      body="This SKU report does not exist, or it is no longer available."
    />
  );
}

function ReportError() {
  return (
    <EmptyState
      title="Could not load this report"
      body="Something went wrong fetching this SKU report. Try again in a moment."
    />
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{body}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/report/sku/by-day">Back to By Day</Link>
      </Button>
    </div>
  );
}
