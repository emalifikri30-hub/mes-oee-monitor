import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import { buildQualityPareto, selectQualityParetoState } from "@/lib/quality-pareto";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import type { RejectReasonBreakdown } from "@/lib/types";

const QualityParetoChart = lazy(() =>
  import("@/components/report/quality-pareto-chart").then((m) => ({
    default: m.QualityParetoChart,
  })),
);

// Pareto Quality Losses — reject counters ranked by the time they cost.
//
// ITS OWN CARD RATHER THAN DashboardParetoCard'S THIRD CALLER, because the two
// draw different charts over different payloads. A reject bucket is a COUNT AT A
// COUNT POINT with a unit, a weight and a converted quantity; a downtime bucket is
// an interval. `buildQualityPareto` and `QualityParetoChart` exist for that
// difference, and forcing one shell over both would mean a shell that takes two
// builders and two charts — which is two cards wearing one name.
//
// MEASURED BY DURATION, matching the mock's "Minutes of Losses" axis and the
// donut beside it, so the Quality Loss wedge and this chart's total are the same
// figure. Note `reject_count_wu_shift.reject_time` is zero until the pipeline
// writes per-counter reject time — the bars are then a row of zeros, which the
// chart renders honestly rather than hiding.
function QualityLossesCard({
  breakdown,
  isPending,
  isError,
  hasParams,
  reportBusinessDay,
  machineName,
}: {
  breakdown: RejectReasonBreakdown | undefined;
  isPending: boolean;
  isError: boolean;
  hasParams: boolean;
  reportBusinessDay: string | null | undefined;
  // Filled in when a bucket's own `machineName` is null. This endpoint is scoped
  // to ONE report and therefore one machine, so the report knows the answer the
  // enrichment could not supply.
  machineName: string | null;
}) {
  const { t } = useTranslation("oee");
  // `hasParams` FIRST — a gated useQuery pends forever (lib/load-state.ts).
  const state = selectQualityParetoState({
    hasParams,
    isPending,
    isError,
    data: breakdown,
    reportDate: reportBusinessDay,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard.qualityLosses")}</CardTitle>
      </CardHeader>
      <CardContent>
        {state === "pending" || state === "no-params" ? (
          <Skeleton className="h-[340px] w-full" />
        ) : state === "error" ? (
          <p className="text-muted-foreground py-32 text-center text-sm">
            {t("report.qualityBreakdownError")}
          </p>
        ) : state === "empty-stale" ? (
          <p className="text-muted-foreground py-32 text-center text-sm">
            {t("report.rejectsNotLoadedMonth")}
          </p>
        ) : state === "empty-loaded" ? (
          <p className="text-muted-foreground py-32 text-center text-sm">
            {t("report.noRejectsMonth")}
          </p>
        ) : (
          <Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
            <QualityParetoChart model={buildQualityPareto(breakdown!, "duration", machineName)} />
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}

export { QualityLossesCard };
