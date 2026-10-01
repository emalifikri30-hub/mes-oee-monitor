import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import { parseReasonSearch, toLossCategory, toReasonSelector } from "@/lib/reason-search";
import { periodReportQueryOptions, usePeriodReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { ReasonDetailCard } from "@/components/report/reason-detail-card";
import { Skeleton } from "@/components/ui/skeleton";

import type { ReasonSearch } from "@/lib/reason-search";
import type { SearchSchemaInput } from "@tanstack/react-router";

// A THIRD trailing underscore, on `losses_`. The Losses page renders no
// <Outlet />, so without it TanStack promotes that route to a layout and this
// page never appears. Same reason the two segments above it carry one.

// WHICH BUCKET, as two search params rather than one, plus WHICH LOSS as a third.
// The parse and its rationale live in lib/reason-search.ts — the bucket half is
// the trap TODOS.md §27 names, and both halves are covered exhaustively there as
// functions rather than through this route.
//
// `category` is absent for Availability Loss and explicit for the others, so the
// links that shipped before Schedule Loss existed still resolve unchanged. Note
// that a hand-edited `?category=SMALL_STOP` opens a real, servable page even
// though no tab links there — the endpoint serves it and the copy for it exists,
// so that is a working deep link rather than a hole.
function validateSearch(search: Partial<ReasonSearch> & SearchSchemaInput): ReasonSearch {
  return parseReasonSearch(search);
}

export const Route = createFileRoute("/_app/report/machine/by-day_/$reportId_/losses_/detail")({
  validateSearch,
  // VALIDATES ONLY — it deliberately does not prefetch the drill-down.
  //
  // The Losses page prefetches its breakdown because there is exactly one per
  // page. Here there is one query PER REASON, and `defaultPreload: "intent"`
  // runs this loader on hover: a mouse travelling down the actions column of a
  // 50-row reason table would fire 50 requests, each doing the endpoint's full
  // fan-out. The card fetches on mount instead, and its six-state ladder renders
  // the brief pending frame properly.
  //
  // The day report itself is still awaited: it is already in the cache from
  // the parent page, it costs nothing, and it is what turns a bad id into the
  // router's notFound state rather than an error banner on an otherwise
  // complete page.
  loader: async ({ context, params }) => {
    const id = Number(params.reportId);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    await context.queryClient
      .ensureQueryData(periodReportQueryOptions("day", id))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });
  },
  pendingMs: 150,
  pendingComponent: DetailSkeleton,
  errorComponent: DetailError,
  notFoundComponent: DetailNotFound,
  component: DetailRoute,
  staticData: {
    title: "nav.detailReport",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.machine" },
      { label: "nav.byDay", to: "/report/machine/by-day" },
      { label: "nav.detailReport", to: "/report/machine/by-day/$reportId" },
      // Parametrised like the crumb above it; app-header.tsx supplies reportId
      // from the active match.
      { label: "nav.losses", to: "/report/machine/by-day/$reportId/losses" },
      { label: "nav.detailReport" },
    ],
  },
});

function DetailRoute() {
  const { reportId } = Route.useParams();
  const search = Route.useSearch();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = usePeriodReport("day", Number(reportId));

  // A URL naming no bucket, or both, is a broken link — see validateSearch for
  // why this is thrown here rather than there.
  const selector = toReasonSelector(search);
  if (selector === undefined) throw notFound();

  if (!report) return <DetailSkeleton />;

  return <ReasonDetailCard report={report} selector={selector} category={toLossCategory(search)} />;
}

// This page's own shape — one card, no chart — so the layout does not jump when
// the real content lands.
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
// `reportId` lands on, where the category is noise anyway. The sentence's subject
// is "that reason", which is true whichever loss the link named.
function DetailNotFound() {
  return (
    <EmptyState
      title="Downtime reason not found"
      body="No downtime was recorded for that reason in this shift."
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

// Duplicated from the Losses page for the reason stated there: the only thing
// that differs between these empty states is where the back-link points, which
// is the whole content.
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
