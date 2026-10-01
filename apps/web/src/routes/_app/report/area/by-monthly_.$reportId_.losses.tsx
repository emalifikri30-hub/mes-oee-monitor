import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import { areaReportQueryOptions, useAreaReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { LossesTabs, prefetchLossTab, validateLossesSearch } from "@/components/report/losses-tabs";
import { Skeleton } from "@/components/ui/skeleton";

// The AREA's MONTHLY Losses page, behind the Losses card's external-link icon.
//
// A trailing underscore on BOTH segments, for the reason the other three subjects'
// pages state: `by-monthly_` opts out of nesting under the list page, and
// `$reportId_` does the same against the detail page, which renders no <Outlet />
// and would otherwise be promoted to a layout route and swallow this one.
//
// THE FIVE TABS AND THE FOUR AGGREGATES ARE THE DAY SCREEN'S, WIDENED — the window
// comes off the report row and the row is a month, so every read below is the same
// query over a ~30x range. Two consequences worth knowing:
//
//   THE MIXED-UNIT ABSTAIN FIRES HARDER STILL. The Quality Pareto nulls a bucket's
//   unit when its rows disagree, and a month of an area's lines will disagree far
//   more often than a day of them. An em dash is the correct answer, not a degraded
//   one — the alternative is adding a month of sacks to a month of cartons.
//
//   THE DOWNTIME PARETOS ARE THE WIDEST READ IN THIS APP. TODOS §25 measured the
//   wide shape of /downtimes/by-reason at 2799 ms for a plant-year and named four
//   changes that had to land before an area could be served; all four shipped with
//   the line grain (a server-side LIMIT of 20, an "Other" tail derived from
//   `groupCount`, server-side ranking, and a paged drill-down). An area-MONTH window
//   is the widest thing those four have been asked to hold, and it is still
//   UNMEASURED against real data — §25 says so, and it is the one shape worth
//   re-measuring before a plant-year screen exists.
//
// THE FIVE TABS ARE THE OTHER SUBJECTS', UNCHANGED — LossesTabs takes any of the
// four. Four of them work at area scope with no new arithmetic:
//
//   the three downtime Paretos  read /downtimes/by-reason at `scope=area`.
//                               oee.downtime_reports has carried `area_id` since
//                               migration 0007, and core-api's SCOPE_COLUMN now
//                               maps it — CONTAINMENT, so a stop on a machine IS a
//                               stop on its area and no predicate beside the scope
//                               is involved.
//   Quality Loss                reads the area's own /rejects, whose aggregate is
//                               shared/loss-aggregate.ts's over
//                               oee.reject_count_wc_shift scoped by `area_id` — a
//                               column that table has carried since 0019. The
//                               mixed-unit ABSTAIN fires far more often here than
//                               at line grain, and that is the correct answer
//                               rather than a degraded one: an em dash beats
//                               adding sacks to cartons.
//
// TODOS.md §25 held the wide scopes back on COST and named four changes that had to
// land together first — a server-side LIMIT, an "Other" tail bucket, server-side
// ranking and a paged drill-down. All four shipped with the line grain, which is
// why this is the first caller the answer was built for rather than a re-opening of
// that question.
//
// THE ONE THAT IS NOT HERE is Performance Loss's TRENDLINE sub-view, which renders
// an empty state saying why. The requirement asked for this page "without
// performance loss -> trendline tab"; the SUB-TAB still appears, so the bar does not
// change shape between subjects (TODOS §61's argument, a fourth time) — and
// performance-loss-tab.tsx names the line to change if the intent was the chrome
// rather than the content.
export const Route = createFileRoute("/_app/report/area/by-monthly_/$reportId_/losses")({
  validateSearch: validateLossesSearch,
  // Which tab is active, so the loader can warm THAT tab's breakdown. The router
  // re-runs the loader when a dep changes, which is what makes the gate right
  // rather than stale. `view` rides along because Performance Loss has two, and
  // only one of them reads a breakdown.
  loaderDeps: ({ search }) => ({ tab: search.tab, view: search.view }),
  loader: async ({ context, params, deps }) => {
    const id = Number(params.reportId);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // AWAITED: a bad id becomes the router's notFound state rather than an error
    // banner inside an otherwise complete page — and everything else here derives
    // from it, including the window each tab requests.
    //
    // Re-running on a tab switch is free: `ensureQueryData` resolves from the cache
    // without revalidating, so it cannot put the pendingComponent back.
    const report = await context.queryClient
      .ensureQueryData(areaReportQueryOptions("month", id))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    prefetchLossTab({ queryClient: context.queryClient, report, ...deps });
  },
  pendingMs: 150,
  pendingComponent: LossesSkeleton,
  errorComponent: LossesError,
  notFoundComponent: LossesNotFound,
  component: AreaLossesRoute,
  staticData: {
    title: "nav.losses",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.area" },
      { label: "nav.byMonthly", to: "/report/area/by-monthly" },
      // Parametrised: app-header.tsx supplies `reportId` from the active match,
      // since staticData is evaluated once per route file and cannot know it.
      { label: "nav.detailReport", to: "/report/area/by-monthly/$reportId" },
      { label: "nav.losses" },
    ],
  },
});

function AreaLossesRoute() {
  const { reportId } = Route.useParams();
  const { tab, view } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: report } = useAreaReport("month", Number(reportId));

  if (!report) return <LossesSkeleton />;

  return (
    <LossesTabs
      report={report}
      // A LITERAL. The other seven COMPILE here — the param name is the same — and
      // would open an unrelated report at another subject.
      detailTo="/report/area/by-monthly/$reportId/losses/detail"
      tab={tab}
      view={view}
      onTabChange={(next) => void navigate({ search: { tab: next, view } })}
      onViewChange={(next) => void navigate({ search: { tab, view: next } })}
    />
  );
}

// This page's own shape, not ReportSkeleton: that renders several card outlines
// against this page's one, so the layout would jump hard on load.
function LossesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="mx-auto h-9 w-[32rem]" />
      <Skeleton className="h-9 w-72" />
      <div className="flex flex-col gap-4 rounded-xl border p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-[340px] w-full" />
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

function LossesNotFound() {
  return (
    <EmptyState
      title="Report not found"
      body="This area report does not exist, or it is no longer available."
    />
  );
}

function LossesError() {
  return (
    <EmptyState
      title="Could not load these losses"
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
