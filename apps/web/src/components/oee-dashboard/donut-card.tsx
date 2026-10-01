import { Suspense, lazy } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import type { DonutSlice } from "@/lib/oee-dashboard/oee-performance";

// SPLIT OUT OF THE ENTRY CHUNK. autoCodeSplitting does not subsume this — recharts
// is reachable from several route chunks, so rolldown lifts it to their common
// ancestor, which is the entry. See oee-trend-card.tsx and vite.config.ts.
const DonutChart = lazy(() =>
  import("@/components/oee-dashboard/donut-chart").then((m) => ({ default: m.DonutChart })),
);

// The shell BOTH donuts share: Calendar Time and OEE Losses.
//
// TAKES SLICES AND A TITLE, so it holds no arithmetic and knows nothing about a
// report — apps/web/AGENTS.md's shared-component rule. The two cards below it are
// one line each, which is the point: a second card that built its own slices would
// be a second place for a wedge to stop matching its label.
function DonutCard({
  title,
  slices,
  isPending,
}: {
  title: string;
  slices: DonutSlice[];
  isPending: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-[300px] w-full" />
        ) : (
          <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
            <DonutChart slices={slices} />
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}

export { DonutCard };
