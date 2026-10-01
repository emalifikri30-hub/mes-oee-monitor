import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { buildLineHourlyOutput, buildLineHourOfDayOutput } from "@/lib/perf-hourly";
import {
  HourlyProductionBody,
  HourlyProductionSkeleton,
} from "@/components/report/hourly-production-body";
import { useLineHourProfile, useLinePerformance } from "@/lib/queries";

import type { LineReportDetail } from "@/lib/types";

// The LINE's Trendline sub-tab on the Losses page.
//
// THIS REPLACED AN EMPTY STATE THAT HAD STOPPED BEING TRUE. Part 2 shipped a
// panel here reading "Hourly production is not available for a line yet — it
// needs per-product output rolled up to the line, which the data pipeline does
// not produce." That was accurate when written and became false the moment
// migration 0018 and its two endpoints landed: the panel was still rendering
// while the data behind it existed. A stale empty state is worse than a missing
// feature, because nobody files a bug against a sentence that sounds considered.
//
// ---------------------------------------------------------------------------
// THREE GRAINS, TWO SHAPES — the machine card's split, unchanged
// ---------------------------------------------------------------------------
//
// Shift and day return buckets keyed on an INSTANT; a month returns 24
// hour-of-DAY buckets keyed on a clock hour that occurred ~30 times, because
// ~720 hourly points is not a line chart. React forbids a conditional hook, so
// both are called and the one out of play is gated off.
//
// WHAT IT PLOTS is the output side only — see buildLineHourlyOutput. `totalOut`
// is infeed, a different unit, and drawing it against `effectiveOut` on one axis
// is the failure the two-unit rule exists to prevent.
function LineHourlyProductionCard({
  report,
  isActive,
}: {
  report: LineReportDetail;
  isActive: boolean;
}) {
  const { t } = useTranslation("oee");
  const isMonth = report.grain === "month";

  // `"shift"` is a placeholder when the query is gated off; TypeScript needs a
  // narrowed literal and a month never reaches this hook.
  const chronological = useLinePerformance(
    report.grain === "day" ? "day" : "shift",
    report.id,
    isActive && !isMonth,
  );
  const profile = useLineHourProfile(report.id, isActive && isMonth);

  const { data, isPending, isError } = isMonth ? profile : chronological;

  const model = useMemo(
    () =>
      data === undefined
        ? undefined
        : isMonth
          ? buildLineHourOfDayOutput(data)
          : buildLineHourlyOutput(data),
    [data, isMonth],
  );

  if (isPending) return <HourlyProductionSkeleton />;

  // Card-local, like every other drill-down on this page: the report is fine,
  // only this panel is not.
  if (isError) {
    return (
      <div className="bg-muted text-muted-foreground flex h-9 w-full items-center justify-center rounded-sm text-xs">
        {t("report.hourlyLoadLine")}
      </div>
    );
  }

  if (data === undefined || model === undefined) return null;

  return <HourlyProductionBody report={report} model={model} source={data} />;
}

export { LineHourlyProductionCard };
