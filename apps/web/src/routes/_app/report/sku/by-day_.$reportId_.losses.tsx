import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { isNotFoundError } from "@/lib/route-error";
import { skuReportQueryOptions, useSkuReport } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { LossesTabs, prefetchLossTab, validateLossesSearch } from "@/components/report/losses-tabs";
import { Skeleton } from "@/components/ui/skeleton";

// The SKU's Losses page, behind the Losses card's external-link icon.
//
// A trailing underscore on BOTH segments, for the reason the machine and line
// pages state: `by-day_` opts out of nesting under the list page, and `$reportId_`
// does the same against the detail page, which renders no <Outlet /> and would
// otherwise be promoted to a layout route and swallow this one.
//
// THE FIVE TABS ARE THE OTHER SUBJECTS', UNCHANGED — LossesTabs takes any of the
// three. Four of them work at SKU scope with no new arithmetic:
//
//   the three downtime Paretos  read /downtimes/by-reason, which now takes an
//                               optional `productId` alongside `scope=work-center`
//                               (migration 0020 — product is a FILTER beside a
//                               scope, never a scope of its own).
//   Quality Loss                reads the SKU's own /rejects, whose aggregate is
//                               shared/loss-aggregate.ts's over
//                               oee.reject_count_wc_shift narrowed by product_id —
//                               a column that has been in that table's primary key
//                               since it was created (0019).
//
// THE ONE THAT IS NOT HERE is Performance Loss's TRENDLINE sub-view, which renders
// an empty state saying why — the same one the line grain shows (TODOS §61). The
// sub-tab still appears, so the tab bar does not change shape between subjects.
export const Route = createFileRoute("/_app/report/sku/by-day_/$reportId_/losses")({
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
    // Re-running on a tab switch is free: `ensureQueryData` resolves from the
    // cache without revalidating, so it cannot put the pendingComponent back.
    const report = await context.queryClient
      .ensureQueryData(skuReportQueryOptions(id))
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
  component: SkuLossesRoute,
  staticData: {
    title: "nav.losses",
    breadcrumbs: [
      { label: "nav.report" },
      { label: "nav.sku" },
      { label: "nav.byDay", to: "/report/sku/by-day" },
      // Parametrised: app-header.tsx supplies `reportId` from the active match,
      // since staticData is evaluated once per route file and cannot know it.
      { label: "nav.detailReport", to: "/report/sku/by-day/$reportId" },
      { label: "nav.losses" },
    ],
  },
});

function SkuLossesRoute() {
  const { reportId } = Route.useParams();
  const { tab, view } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: report } = useSkuReport(Number(reportId));

  if (!report) return <LossesSkeleton />;

  return (
    <LossesTabs
      report={report}
      // A LITERAL. The other six COMPILE here — the param name is the same — and
      // would open an unrelated report at another subject.
      detailTo="/report/sku/by-day/$reportId/losses/detail"
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
      body="This SKU report does not exist, or it is no longer available."
    />
  );
}

function LossesError() {
  return (
    <EmptyState
      title="Could not load these losses"
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
