import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import { lineReportQueryOptions, useLineReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { LossesTabs, prefetchLossTab, validateLossesSearch } from "@/components/report/losses-tabs";
import { Skeleton } from "@/components/ui/skeleton";

// The LINE's Losses page, behind the Losses card's external-link icon.
//
// The trailing underscore on BOTH segments, for the reason the machine trio states:
// `by-shift_` opts out of nesting under the list page, and `$reportId_` does the same
// against the detail page, which renders no <Outlet /> and would otherwise be
// promoted to a layout route and swallow this one.
//
// THE FIVE TABS ARE THE MACHINE PAGE'S, UNCHANGED — LossesTabs takes either
// subject. Four of them work at line scope with no new arithmetic: the three
// downtime Paretos read /downtimes/by-reason, which accepts `scope=work-center`
// since TODOS §25, and Quality and Others read the two line sub-resources whose
// aggregates are shared/loss-aggregate.ts's.
//
// THE ONE THING THAT IS NOT HERE is Performance Loss's TRENDLINE sub-view, which
// renders an empty state saying why. It needs product_perf_wu_hour rolled up by
// work_center_id AND the line's two uom triples on those rows, so the browser can
// tell which series belongs to which axis — contract §16.4a. The sub-tab still
// appears, so the tab bar does not change shape between subjects.
export const Route = createFileRoute("/_app/report/line/by-shift_/$reportId_/losses")({
  validateSearch: validateLossesSearch,
  // Which tab is active, so the loader can warm THAT tab's breakdown. The router
  // re-runs the loader when a dep changes, which is what makes the gate right
  // rather than stale. `view` rides along because Performance Loss has two, and
  // only one of them reads a breakdown.
  loaderDeps: ({ search }) => ({ tab: search.tab, view: search.view }),
  loader: async ({ context, params, deps }) => {
    const id = Number(params.reportId);
    if (!Number.isInteger(id) || id <= 0) throw notFound();

    // AWAITED: this is what turns a bad id into the router's notFound state rather
    // than an error banner inside an otherwise complete page — and everything else
    // on the page derives from it, including the window each tab requests.
    //
    // Re-running on a tab switch is free: `ensureQueryData` resolves from the cache
    // without revalidating, so it cannot put the pendingComponent back on screen.
    const report = await context.queryClient
      .ensureQueryData(lineReportQueryOptions("shift", id))
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
  component: LineLossesRoute,
  staticData: {
    title: "nav.losses",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.line" },
      { label: "nav.byShift", to: "/report/line/by-shift" },
      // Parametrised: app-header.tsx supplies `reportId` from the active match,
      // since staticData is evaluated once per route file and cannot know it.
      { label: "nav.detailReport", to: "/report/line/by-shift/$reportId" },
      { label: "nav.losses" },
    ],
  },
});

function LineLossesRoute() {
  const { reportId } = Route.useParams();
  const { tab, view } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: report } = useLineReport("shift", Number(reportId));

  if (!report) return <LossesSkeleton />;

  return (
    <LossesTabs
      report={report}
      detailTo="/report/line/by-shift/$reportId/losses/detail"
      tab={tab}
      view={view}
      onTabChange={(next) => void navigate({ search: { tab: next, view } })}
      onViewChange={(next) => void navigate({ search: { tab, view: next } })}
    />
  );
}

// This page's own shape, not ReportSkeleton: that renders seven card outlines
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
      body="This line report does not exist, or it is no longer available."
    />
  );
}

function LossesError() {
  return (
    <EmptyState
      title="Could not load these losses"
      body="Something went wrong fetching this line report. Try again in a moment."
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
