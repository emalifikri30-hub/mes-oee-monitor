import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { buildHourlyOutput, buildHourOfDayOutput } from "@/lib/perf-hourly";
import {
  useMonthReportHourProfile,
  usePeriodReportPerformance,
  useShiftReportPerformance,
} from "@/lib/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  HourlyProductionBody,
  HourlyProductionSkeleton,
} from "@/components/report/hourly-production-body";

import type { HourOfDayProfile, ReportDetail, ShiftPerformance } from "@/lib/types";

// The Performance Loss tab's Trendline view: the same hourly production profile
// the Losses card's `View` button opens, in a card instead of a dialog.
//
// The body and its empty states are shared — see hourly-production-body.tsx.
// This file owns what the frame owns.
//
// `isActive` IS THE DIALOG'S `open`. `useShiftReportPerformance` gates its query
// on it, so the Pareto view neither issues this request nor pulls in the
// recharts chunk, exactly as a closed dialog does not. Without it, landing on
// Performance Loss would fetch two unrelated payloads to show one.
function HourlyProductionCard({ report, isActive }: { report: ReportDetail; isActive: boolean }) {
  const { t } = useTranslation("oee");
  // Shift or DAY, never month — the same rule PerformanceDialog enforces, stated
  // again here because this card has its own mount path through the Losses page.
  // ~720 hourly points is not a line chart, and the endpoint 404s that grain.
  //
  // Two hooks, one picked: React forbids calling a hook conditionally, so the
  // unused one is gated off and the two cache keys stay separate.
  // THREE GRAINS, TWO PAYLOAD SHAPES, ONE MODEL. Shift and day return hourly
  // buckets keyed on an instant; a month returns 24 hour-of-day buckets keyed on
  // a clock hour. The two builders differ only in the axis and the join key —
  // everything downstream, including all of the rate arithmetic, is shared.
  //
  // React forbids calling a hook conditionally, so all three queries are called
  // and the two that do not apply are gated off with `enabled: false`. That costs
  // nothing and keeps the three cache keys separate, which they must be: a shift
  // 7, a day 7 and a month 7 are different reports.
  const isShift = report.grain === "shift";
  const isMonth = report.grain === "month";
  const shiftQuery = useShiftReportPerformance(report.id, isActive && isShift);
  const dayQuery = usePeriodReportPerformance(report.id, isActive && !isShift && !isMonth);
  const monthQuery = useMonthReportHourProfile(report.id, isActive && isMonth);

  const { data, isPending, isError } = isMonth ? monthQuery : isShift ? shiftQuery : dayQuery;

  const model = useMemo(
    () =>
      data === undefined
        ? undefined
        : isMonth
          ? buildHourOfDayOutput(data as HourOfDayProfile)
          : buildHourlyOutput(data as ShiftPerformance),
    [data, isMonth],
  );

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="py-4">
        <CardTitle className="text-sm">{t("report.hourlyProduction")}</CardTitle>
        <p className="text-muted-foreground text-xs">{t("report.hourlyHintShift")}</p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pb-5">
        {isPending ? <HourlyProductionSkeleton /> : null}

        {/* Card-local, never an error boundary and never notFound(): the page is
            fine, only this view is not. Same sentence the dialog uses. */}
        {isError ? (
          <div className="bg-muted text-muted-foreground flex h-9 w-full items-center justify-center rounded-sm text-xs">
            {t("report.hourlyLoadShift")}
          </div>
        ) : null}

        {data !== undefined && model !== undefined ? (
          <HourlyProductionBody report={report} model={model} source={data} />
        ) : null}
      </CardContent>
    </Card>
  );
}

export { HourlyProductionCard };
