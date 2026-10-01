import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import { parseReasonSearch, toLossCategory, toReasonSelector } from "@/lib/reason-search";
import { lineReportQueryOptions, useLineReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { ReasonDetailCard } from "@/components/report/reason-detail-card";
import { Skeleton } from "@/components/ui/skeleton";

import type { ReasonSearch } from "@/lib/reason-search";
import type { SearchSchemaInput } from "@tanstack/react-router";

// The LINE's per-reason drill-down — what the Losses page's Pareto eye opens.
//
// A THIRD trailing underscore, on `losses_`. The Losses page renders no <Outlet />,
// so without it TanStack promotes that route to a layout and this page never
// appears. Same reason the two segments above it carry one.
//
// THE SEARCH CONTRACT IS THE MACHINE PAGE'S, REUSED VERBATIM — `parseReasonSearch`
// and its two traps (the unlabelled bucket that must not collapse into "no filter",
// and the category that must ride along so the drill-down cannot answer a different
// question than the bar was drawn from) are subject-agnostic, and lib/reason-search.ts
// covers them exhaustively as functions.
function validateSearch(search: Partial<ReasonSearch> & SearchSchemaInput): ReasonSearch {
  return parseReasonSearch(search);
}

export const Route = createFileRoute("/_app/report/line/by-shift_/$reportId_/losses_/detail")({
  validateSearch,
  // VALIDATES ONLY — it deliberately does not prefetch the drill-down, for the
  // reason the machine route states: `defaultPreload: "intent"` runs this loader on
  // hover, and there is one query PER REASON, so a mouse travelling down a 50-row
  // table would fire 50 of the endpoint's full fan-outs. The card fetches on mount
  // and its six-state ladder renders the brief pending frame properly.
  //
  // The line report itself is still awaited: it is already cached from the parent
  // page, costs nothing, and is what turns a bad id into the router's notFound state
  // rather than an error banner on an otherwise complete page.
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    await context.queryClient
      .ensureQueryData(lineReportQueryOptions("shift", id))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });
  },
  pendingMs: 150,
  pendingComponent: DetailSkeleton,
  errorComponent: DetailError,
  notFoundComponent: DetailNotFound,
  component: LineDetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.line" },
      { label: "nav.byShift", to: "/report/line/by-shift" },
      { label: "nav.detailReport", to: "/report/line/by-shift/$reportId" },
      { label: "nav.losses", to: "/report/line/by-shift/$reportId/losses" },
      { label: "nav.detailReport" },
    ],
  },
});

function LineDetailRoute() {
  const { reportId } = Route.useParams();
  const search = Route.useSearch();
  const { data: report } = useLineReport("shift", Number(reportId));

  // A URL naming no bucket, or both, is a broken link — see validateSearch for why
  // this is thrown here rather than there.
  const selector = toReasonSelector(search);
  if (selector === undefined) throw notFound();

  if (!report) return <DetailSkeleton />;

  return <ReasonDetailCard report={report} selector={selector} category={toLossCategory(search)} />;
}

// This page's own shape — one card, no chart — so the layout does not jump when the
// real content lands.
function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-32" />
      </div>
      <Skeleton className="h-16 w-full" />
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-8 w-full" />
      ))}
    </div>
  );
}

// CATEGORY-NEUTRAL wording, deliberately. A notFoundComponent renders INSTEAD of
// the component, so it cannot read a parsed search — and it is also what a bad
// `reportId` lands on, where the category is noise anyway.
function DetailNotFound() {
  return (
    <EmptyState
      title="Downtime reason not found"
      body="No downtime was recorded for that reason on this line."
    />
  );
}

function DetailError() {
  return (
    <EmptyState
      title="Could not load this breakdown"
      body="Something went wrong fetching the stops behind this reason. Try again in a moment."
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
