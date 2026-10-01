import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import { buildOeeTrendSeries } from "@/lib/oee-dashboard/oee-performance";
import { selectLoadState } from "@/lib/load-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import type { DashboardPeriodCopy } from "@/components/oee-dashboard/oee-performance-view";
import type { OeeTrendAxis } from "@/lib/oee-dashboard/oee-performance";
import type { MonthOeeTrend } from "@/lib/types";

// SPLIT OUT OF THE ENTRY CHUNK. autoCodeSplitting is on and does NOT subsume this:
// recharts is reachable from several route chunks, so rolldown lifts it to their
// common ancestor, which is the entry. Measured at 395 kB -> 781 kB when these
// boundaries are removed. Five other cards hand-roll the same thing; this is the
// sixth, and the reasoning lives once beside the flag in vite.config.ts.
const OeeTrendChart = lazy(() =>
  import("@/components/oee-dashboard/oee-trend-chart").then((m) => ({ default: m.OeeTrendChart })),
);

function OeeTrendCard({
  trend,
  isPending,
  isError,
  hasReport,
  reportBusinessDay,
  copy,
  axis,
}: {
  trend: MonthOeeTrend | undefined;
  isPending: boolean;
  isError: boolean;
  hasReport: boolean;
  reportBusinessDay: string | null | undefined;
  // THE THREE SENTENCES, PASSED IN — not a `grain` prop this card switches on.
  // A month report trends DAYS and a year report trends MONTHS, so "the daily
  // figures for this month" describes a chart the year screen is not drawing. The
  // shared-component rule says the card takes the DATA; which words apply is a fact
  // about the caller's grain, and the caller is the only thing that knows it as a
  // literal. See lib/oee-dashboard/period-copy.ts.
  copy: DashboardPeriodCopy;
  // Which grain's tick and tooltip formatters to draw with — `TREND_AXIS.month` or
  // `TREND_AXIS.year`, indexed by the route with a LITERAL. DATA, not a `grain`
  // prop this card switches on.
  axis: OeeTrendAxis;
}) {
  const { t } = useTranslation("oee");
  // The six-state ladder, and `hasParams` FIRST for the reason lib/load-state.ts
  // states at length: this query is gated until a report id exists, and a gated
  // useQuery pends forever.
  const state = selectLoadState<MonthOeeTrend>({
    hasParams: hasReport,
    isPending,
    isError,
    data: trend,
    reportDate: reportBusinessDay,
    isEmpty: (data) => data.items.length === 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard.oeeTrend")}</CardTitle>
      </CardHeader>
      <CardContent>
        {state === "pending" || state === "no-params" ? (
          <Skeleton className="h-[320px] w-full" />
        ) : state === "error" ? (
          <p className="text-muted-foreground py-24 text-center text-sm">{copy.trendError}</p>
        ) : state === "empty-stale" ? (
          // THE SPLIT THAT MATTERS, and the flattering reading is the wrong one: a
          // period with no sub-period rows loaded must not render as a period with
          // nothing to report.
          <p className="text-muted-foreground py-24 text-center text-sm">{copy.trendEmptyStale}</p>
        ) : state === "empty-loaded" ? (
          <p className="text-muted-foreground py-24 text-center text-sm">{copy.trendEmptyLoaded}</p>
        ) : (
          <Suspense fallback={<Skeleton className="h-[320px] w-full" />}>
            <OeeTrendChart data={buildOeeTrendSeries(trend!.items)} axis={axis} />
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}

export { OeeTrendCard };
