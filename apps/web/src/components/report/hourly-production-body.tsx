import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";

import { formatQuantity } from "@/lib/format";
import { isLoadedThrough } from "@/lib/watermark";
import { Skeleton } from "@/components/ui/skeleton";

import { reportBusinessDay } from "@/lib/report-subject";
import type { AnyReport } from "@/lib/report-subject";

import type { HourlyOutputModel } from "@/lib/perf-hourly";

// The hourly production profile, minus whatever is holding it.
//
// SHARED BY TWO SURFACES, which is the whole reason it is a file. The Losses
// card's `View` button opens it in a dialog on the shift report; the Losses
// page's Performance Loss → Trendline tab renders it in a card. TODOS.md §24
// warned that Performance Loss "already has a drill-down of a different shape…
// so the tab would need to say how it differs rather than duplicating it" — one
// body rendered in two frames is the answer: there is nothing to differ.
//
// The dialog and the card keep their own query, pending frame and error banner,
// because those are properties of the frame — a dialog gates its request on
// `open`, a tab gates it on being selected, and the two skeletons are different
// shapes.

// SPLIT OUT OF THE ENTRY CHUNK, and NOT because autoCodeSplitting is off — it is
// on. recharts is the heaviest dependency in the app and only the report screens
// need it, but route-level splitting alone does not keep it out: the chart cards
// live in three different route chunks, so rolldown lifts recharts to their common
// ancestor, which IS the entry chunk. Measured — deleting these boundaries takes
// the entry from 395 kB back to 781 kB.
//
// This `lazy()` is what gives recharts an async chunk of its own. The reasoning
// lives once beside the flag in vite.config.ts; TODOS.md §26 has the numbers.
const PerformanceChart = lazy(() =>
  import("@/components/report/performance-chart").then((m) => ({ default: m.PerformanceChart })),
);

// TAKES THE BUILT MODEL, not the payload. The two grains have two different
// payload shapes and two different builders — a chronological axis for shift and
// day, an hour-of-day profile for month — and everything drawn below is identical
// once the model exists. Building it here would mean this component knowing about
// both shapes for no gain.
function HourlyProductionBody({
  report,
  model,
  source,
}: {
  report: AnyReport;
  model: HourlyOutputModel;
  // The two fields the empty state needs, which BOTH payload shapes carry. Taken
  // as a narrow slice rather than as either full payload, so this component never
  // has to know which one it was handed.
  source: { timeZone: string; loadedThrough: string | null };
}) {
  if (model.skus.length === 0) return <EmptyState report={report} source={source} />;

  return (
    <div className="flex flex-col gap-4">
      <ShiftAverages model={model} />

      {model.skus.map((sku, index) => (
        <div key={sku.productId} className={index > 0 ? "border-t pt-4" : undefined}>
          <Suspense fallback={<Skeleton className="h-[240px] w-full" />}>
            <PerformanceChart sku={sku} model={model} />
          </Suspense>
        </div>
      ))}
    </div>
  );
}

// The header pair from the reference design.
//
// `Avg. Cycle Time` is RUNTIME-WEIGHTED, not the mean of the hourly rates — the two
// differ by a third on a shift with a short unrepresentative bucket, and the mean is
// wrong in the flattering direction. `Avg. Production Output` is divided by the
// buckets a SKU actually ran, not by the length of the axis. Both are computed in
// lib/perf-hourly.ts and pinned by its tests.
function ShiftAverages({ model }: { model: HourlyOutputModel }) {
  const { t } = useTranslation("oee");
  // BAG and CARTON do not average, so a mixed-unit shift says so rather than
  // rendering a plausible wrong figure.
  if (model.uomCode === null) {
    return <p className="text-muted-foreground text-xs">{t("report.mixedUnitsNoAverage")}</p>;
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 text-xs">
      <span>
        <span className="text-muted-foreground">{t("report.avgCycleTime")}</span>
        <span className="font-semibold tabular-nums">
          {formatQuantity(model.avgRatePerHour, t("report.perHour", { unit: model.uomCode }))}
        </span>
      </span>
      <span>
        <span className="text-muted-foreground">{t("report.avgProduction")}</span>
        <span className="font-semibold tabular-nums">
          {formatQuantity(model.avgOutPerRunBucket, model.uomCode)}
        </span>
      </span>
    </div>
  );
}

// The distinction the watermark exists for, and the reason it is on the response at
// all. An empty result has two completely different causes and they must not render
// alike:
//
//   watermark >= this shift's business day  ->  the pipeline HAS reached this day,
//                                               so the machine genuinely made nothing
//   watermark <  it, or null                ->  the rows have not loaded yet
//
// This is the failure the timeline strip and the SKU card still have — an unloaded
// shift renders as a flawless one — closed here before it shipped rather than after.
// See TODOS.md §8 and §14.
function EmptyState({
  report,
  source,
}: {
  report: AnyReport;
  source: { timeZone: string; loadedThrough: string | null };
}) {
  const { t } = useTranslation("oee");
  // The comparison itself lives in lib/watermark.ts, tested there and shared with
  // the Losses page's Pareto card — two cards drawing opposite conclusions from
  // the same watermark is exactly the failure this distinction exists to prevent.
  //
  // AT THE COARSE GRAINS THIS IS LENIENT, and knowingly so: `report.date` is the
  // period's START, so a watermark that reached the first of the month reads as
  // loaded even if the rest of the month has not arrived. It still separates the
  // case that matters — nothing loaded at all — from a machine that genuinely
  // made nothing. A stricter check wants the period's LAST business day, which is
  // a server fact this component does not have.
  // THROUGH reportBusinessDay, NOT `report.date` — a LINE report has no `date`
  // column at all (0014), and a machine SHIFT report's is an INSTANT rather than a
  // business day. That helper is the one place that knows which of the three
  // sources holds the covered day; passing an instant here would compare it
  // against a watermark's bare 'YYYY-MM-DD' and mis-decide near midnight.
  const loaded = isLoadedThrough(reportBusinessDay(report), source.timeZone, source.loadedThrough);

  if (loaded) {
    // The same sentence the SKU card uses, so the two cards agree.
    return <p className="text-muted-foreground text-xs">{t("report.noProductOutput")}</p>;
  }

  return <p className="text-muted-foreground text-xs">{t("report.hourlyNotLoaded")}</p>;
}

// The pending frame, shared for the same reason the body is: two surfaces, one
// shape, so the layout does not settle differently depending on which one you
// opened.
function HourlyProductionSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-[240px] w-full" />
    </div>
  );
}

export { HourlyProductionBody, HourlyProductionSkeleton };
