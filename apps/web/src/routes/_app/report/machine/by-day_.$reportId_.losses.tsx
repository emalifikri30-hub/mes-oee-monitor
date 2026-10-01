import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import { periodReportQueryOptions, usePeriodReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { LossesTabs, prefetchLossTab, validateLossesSearch } from "@/components/report/losses-tabs";
import { Skeleton } from "@/components/ui/skeleton";

// The trailing underscore on BOTH segments. `by-day_` opts out of nesting
// under the list page, for the reason by-day_.$reportId.tsx states; `$reportId_`
// does the same against the detail page, which renders no <Outlet /> and would
// otherwise be promoted to a layout route and swallow this one.
//
// app-sidebar.tsx matches its nav with `startsWith(to + "/")`, so "By Day"
// stays highlighted here with no sidebar change.
//
// THE FIVE TABS, THEIR URL CONTRACT AND THEIR PER-TAB PREFETCH MOVED to
// components/report/losses-tabs.tsx when the day and month grains got this page
// too. That dispatch's intricacy is load-bearing — the order of its checks is
// what makes `item.category` provably defined, and its `never` arm is what stops
// a sixth tab shipping without a prefetch — and three copies of it would be three
// places for that to drift silently.
//
// What stays here is what genuinely differs per grain: the breadcrumb trail, the
// back-link, and which report query the loader awaits.

export const Route = createFileRoute("/_app/report/machine/by-day_/$reportId_/losses")({
  validateSearch: validateLossesSearch,
  // Which tab is active, so the loader can warm THAT tab's breakdown. The router
  // re-runs the loader when a dep changes, which is what makes the gate right
  // rather than stale. `view` rides along because Performance Loss has two, and
  // only one of them reads a breakdown.
  loaderDeps: ({ search }) => ({ tab: search.tab, view: search.view }),
  loader: async ({ context, params, deps }) => {
    const id = Number(params.reportId);
    // Mirrors the handler's own guard. A non-numeric id is a broken link, not a
    // server fault, so it should never reach the network.
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // AWAITED, unlike the breakdown below. This is what turns a bad id into the
    // router's notFound state rather than an error banner inside an otherwise
    // complete page — and everything else on the page derives from it: the window
    // to request, the machine name in the filter, the page's whole reason to
    // exist.
    //
    // Re-running this loader on a tab switch is free: `ensureQueryData` resolves
    // straight from the cache without revalidating, so it cannot put this route's
    // page-wide pendingComponent back on screen.
    const report = await context.queryClient
      .ensureQueryData(periodReportQueryOptions("day", id))
      .catch((err: unknown) => {
        if (isNotFoundError(err)) throw notFound();
        throw err;
      });

    prefetchLossTab({ queryClient: context.queryClient, report, ...deps });
  },
  // The router default of 1000ms would let a cold load sit on a blank frame.
  pendingMs: 150,
  pendingComponent: LossesSkeleton,
  errorComponent: LossesError,
  // Declared here rather than inherited from __root, so the sidebar and header
  // survive a bad id instead of the whole shell being replaced.
  notFoundComponent: LossesNotFound,
  component: LossesRoute,
  staticData: {
    title: "nav.losses",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.machine" },
      { label: "nav.byDay", to: "/report/machine/by-day" },
      // Parametrised: app-header.tsx supplies `reportId` from the active match,
      // since staticData is evaluated once per route file and cannot know it.
      { label: "nav.detailReport", to: "/report/machine/by-day/$reportId" },
      { label: "nav.losses" },
    ],
  },
});

function LossesRoute() {
  const { reportId } = Route.useParams();
  const { tab, view } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Already warm: the loader put it in the cache before this component mounted.
  const { data: report } = usePeriodReport("day", Number(reportId));

  if (!report) return <LossesSkeleton />;

  return (
    <LossesTabs
      report={report}
      // The drill-down's route, as a literal. Passed rather than derived because the
      // LINE literal compiles here too — the param name is identical — and would
      // open an unrelated report: seven report tables, seven independent sequences.
      detailTo="/report/machine/by-day/$reportId/losses/detail"
      tab={tab}
      view={view}
      // `view` is carried through rather than reset: switching away from
      // Performance Loss and back should return the reader to the sub-tab they
      // left, and the param is inert on every other tab.
      onTabChange={(next) => void navigate({ search: { tab: next, view } })}
      onViewChange={(next) => void navigate({ search: { tab, view: next } })}
    />
  );
}

// This page's own shape, not ReportSkeleton: that renders seven card
// outlines against this page's one, so the layout would jump hard on load.
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
      body="This day report does not exist, or it is no longer available."
    />
  );
}

function LossesError() {
  return (
    <EmptyState
      title="Could not load this report"
      body="Something went wrong fetching the day report. Try again in a moment."
    />
  );
}

// Duplicated from by-day_.$reportId.tsx deliberately. Extracting it would make
// a fourth shared empty-state component in this codebase, and the only thing
// that differs is where the back-link points — which is the whole content.
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
