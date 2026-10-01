import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import { buildPareto, selectParetoState } from "@/lib/pareto";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import type { ParetoAppearance } from "@/components/report/reason-pareto-chart";
import type { ParetoMeasure, ParetoSource } from "@/lib/pareto";

const ReasonParetoChart = lazy(() =>
  import("@/components/report/reason-pareto-chart").then((m) => ({
    default: m.ReasonParetoChart,
  })),
);

// The Pareto shell the dashboard's three charts share — Pareto Actions, Schedule
// Loss and (through its own card) Quality Losses.
//
// CHART ONLY, NO TABLE AND NO DRILL-DOWN, which is what separates it from
// reason-pareto-card.tsx rather than a simplification of it. That card is the
// Losses PAGE's: it carries a measure toggle, a sortable table, pagination and an
// eye button into one bucket's stops, because that page exists to be worked
// through. A dashboard answers "what should I look at" and hands off; reusing the
// full card here would put four paginated tables on one screen and a drill-down
// link to a report the dashboard is not about.
//
// WHAT IT DOES REUSE IS EVERYTHING THAT COULD BE WRONG: buildPareto's ranking,
// its "Other" tail, its vital-few split and the chart itself. There is no second
// Pareto implementation in this app.
function DashboardParetoCard({
  title,
  breakdown,
  appearance,
  isPending,
  isError,
  hasParams,
  reportBusinessDay,
  measure = "duration",
  footnote,
}: {
  title: string;
  breakdown: (ParetoSource & { timeZone: string; loadedThrough: string | null }) | undefined;
  appearance: ParetoAppearance;
  isPending: boolean;
  isError: boolean;
  hasParams: boolean;
  reportBusinessDay: string | null | undefined;
  measure?: ParetoMeasure;
  // A caveat that belongs to THIS chart's data rather than to the shell — Pareto
  // Actions counts only a stop's first action, and a reader has to be told.
  footnote?: string;
}) {
  const { t } = useTranslation("oee");
  // `hasParams` FIRST, for the reason lib/load-state.ts states at length: these
  // queries are gated until the report resolves, and a gated useQuery reports
  // `status: "pending"` forever.
  const state = selectParetoState({
    hasParams,
    isPending,
    isError,
    data: breakdown,
    reportDate: reportBusinessDay,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {state === "pending" || state === "no-params" ? (
          <Skeleton className="h-[340px] w-full" />
        ) : state === "error" ? (
          <p className="text-muted-foreground py-32 text-center text-sm">
            {t("dashboard.breakdownError")}
          </p>
        ) : state === "empty-stale" ? (
          // The split that matters, and the flattering reading is the wrong one: a
          // month the pipeline has not reached must not render as a clean month.
          <p className="text-muted-foreground py-32 text-center text-sm">
            {t("dashboard.stopsNotLoaded")}
          </p>
        ) : state === "empty-loaded" ? (
          <p className="text-muted-foreground py-32 text-center text-sm">
            {t("dashboard.nothingRecorded")}
          </p>
        ) : (
          <>
            <Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
              <ReasonParetoChart model={buildPareto(breakdown, measure)} appearance={appearance} />
            </Suspense>
            {footnote !== undefined && (
              <p className="text-muted-foreground mt-2 text-xs">{footnote}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export { DashboardParetoCard };
