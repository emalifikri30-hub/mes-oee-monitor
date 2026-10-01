import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTranslation } from "react-i18next";

import { EM_DASH, formatQuantity } from "@/lib/format";
import { ParetoTick } from "@/components/report/pareto-tick";
import { QUALITY_LOSS_COPY, QUALITY_MEASURES } from "@/lib/quality-loss";
import { VITAL_FEW_PCT } from "@/lib/pareto-rank";

import type { QualityBar, QualityMeasure, QualityParetoModel } from "@/lib/quality-pareto";

// Bars are rejects per counter; the line is the running share of the total.
// Reading them together is the whole point — the bars say what is biggest, the
// line says how few of them you have to fix.
//
// TWO-TONE, NOT ONE COLOUR PER COUNTER, for the reason reason-pareto-chart.tsx
// gives: every bar here is the same thing — a reject — so N distinct hues would
// encode nothing. The vital-few / trivial-many split is the one thing a Pareto's
// colour CAN mean.
//
// A SEPARATE COMPONENT FROM ReasonParetoChart, deliberately. That chart's fills
// key off DowntimeCategory, its axis is minutes-or-stops, and its tooltip rows ARE
// downtime rows — a machine, a stop count, a duration. Threading a row spec, a
// fill and an axis spec through its props would produce one component that can
// render either family, and the failure mode is a quality tooltip captioned
// "Unplanned stops". What the two genuinely share, and what would rot if copied,
// is the tick rule and the vital-few arithmetic; the first is imported above and
// the second lives in lib/pareto-rank.ts. The nine lines of recharts geometry
// below hold no arithmetic at all.
//
// THE BAND TOKEN ARRIVES AS A WHOLE `var(...)` STRING from QUALITY_LOSS_COPY and
// is never composed here — see the note beside `bandVar` in lib/quality-loss.ts,
// and `fillsFor` in reason-pareto-chart.tsx where the same trap is verified
// against the built CSS.
const FILLS = {
  vitalFew: QUALITY_LOSS_COPY.bandVar,
  trivialMany: `color-mix(in oklch, ${QUALITY_LOSS_COPY.bandVar} 38%, transparent)`,
};

type TooltipProps = {
  active?: boolean;
  payload?: { payload: QualityBar }[];
  measure: QualityMeasure;
};

// Props declared structurally rather than with recharts' own content types, which
// are loose enough to force an `any` — and oxlint errors on those. Same reasoning
// as reason-pareto-chart.tsx and waterfall-chart.tsx.
function rankedByLabel(t: (key: string) => string, measure: QualityMeasure): string {
  switch (measure) {
    case "quantity":
      return t("report.rankedByConverted");
    case "weight":
      return t("report.rankByWeight");
    case "frequency":
      return t("report.rankByFrequency");
    case "duration":
      return t("report.rankByDuration");
    default: {
      const unhandled: never = measure;
      return unhandled;
    }
  }
}

function QualityTooltip({ active, payload, measure }: TooltipProps) {
  const { t } = useTranslation("oee");
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium">{bar.label}</p>
      <div className="flex flex-col gap-1">
        <Row label={t("table.machine")} value={bar.machineName ?? EM_DASH} />
        {/* BOTH FIGURES, in the tooltip as in the table. The counter is what the
            sensor read in its own unit; the converted figure is the same rejects
            in a unit that can be compared with the bar beside it. A tooltip
            showing only one of them would make the chart's own scale unreadable.
            A null unit means this bucket mixed units, so the cell em-dashes
            rather than showing a sum of unlike things. */}
        <Row
          label={t("report.counter")}
          value={
            bar.counterUnit === null ? EM_DASH : formatQuantity(bar.counterValue, bar.counterUnit)
          }
        />
        <Row
          label={t("report.converted")}
          value={QUALITY_MEASURES.quantity.format(bar.quantity, bar.convertedUnit)}
        />
        {/* Null renders as an em dash, which is "not weighed" rather than
            "weighed nothing" — the distinction lib/quality-pareto.ts keeps alive
            through the ranking. */}
        <Row
          label={t("common.weight")}
          value={QUALITY_MEASURES.weight.format(bar.weightGram, null)}
        />
        <Row
          label={t("report.rejectRecords")}
          value={QUALITY_MEASURES.frequency.format(bar.frequency, null)}
        />
        <Row
          label={t("common.cumulative")}
          value={bar.cumulativePct === null ? EM_DASH : `${bar.cumulativePct.toFixed(1)}%`}
        />
      </div>
      <p className="text-muted-foreground mt-1.5">
        {bar.isVitalFew ? t("common.withinTop", { pct: VITAL_FEW_PCT }) : t("common.longTail")}
        {/* A TABLE LOOKUP, not a ternary. With four measures a conditional here
            would silently read "ranked by duration" for whichever one it forgot,
            and every sentence would still be grammatical. */}
        {t("report.rankedByMeasure", { measure: rankedByLabel(t, measure) })}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </p>
  );
}

function qualityAxisLabel(
  t: (key: string, options?: Record<string, string>) => string,
  measure: QualityMeasure,
  convertedUnit: string | null,
): string {
  switch (measure) {
    case "quantity":
      return convertedUnit === null
        ? t("common.quantity")
        : t("report.quantityUnit", { unit: convertedUnit });
    case "weight":
      return t("report.weightGr");
    case "frequency":
      return t("report.rejectRecords");
    case "duration":
      return t("common.minutes");
    default: {
      const unhandled: never = measure;
      return unhandled;
    }
  }
}

function QualityParetoChart({ model }: { model: QualityParetoModel }) {
  const { t } = useTranslation("oee");
  const { bars, measure, convertedUnit } = model;

  // With a zero grand total every percentage is null, so the line has nothing to
  // draw and its axis would be a meaningless empty 0-100 scale. Reachable in two
  // ways here rather than one: a shift where nothing was weighed, and a shift
  // whose per-counter reject time is unwritten — which is every shift today.
  const hasCumulative = bars.some((bar) => bar.cumulativePct !== null);

  return (
    <ResponsiveContainer width="100%" height={340}>
      <ComposedChart data={bars} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="label"
          interval={0}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          height={48}
          tick={<ParetoTick labels={bars.map((bar) => bar.label)} />}
        />
        <YAxis
          yAxisId="measure"
          width={64}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
          label={{
            // Names the unit when the shift has one, so the reader is not asked to
            // guess what "quantity" is counted in.
            value: qualityAxisLabel(t, measure, convertedUnit),
            angle: -90,
            position: "insideLeft",
            style: { fill: "var(--color-muted-foreground)", fontSize: 11 },
          }}
        />
        {hasCumulative ? (
          <YAxis
            yAxisId="cum"
            orientation="right"
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            unit="%"
            width={56}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
          />
        ) : null}
        {/* The 80 in 80/20 — the line the vital-few shading is measured against,
            drawn so the split is verifiable rather than asserted. */}
        {hasCumulative ? (
          <ReferenceLine
            yAxisId="cum"
            y={VITAL_FEW_PCT}
            stroke="var(--color-border)"
            strokeDasharray="4 4"
          />
        ) : null}
        <RechartsTooltip
          cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
          content={<QualityTooltip measure={measure} />}
        />
        {/* ONE dataKey, UNCONDITIONALLY. `plotValue` is already in the axis's own
            terms — minutes for a duration, the raw number otherwise — so there is
            no measure-to-field map at render time and therefore no way to plot the
            wrong field. That is the one thing this chart does better than its
            sibling, whose `barKey` ternary would need a fourth arm here and would
            fall through silently without one. */}
        <Bar yAxisId="measure" dataKey="plotValue" isAnimationActive={false} maxBarSize={72}>
          {bars.map((bar) => (
            <Cell key={bar.key} fill={bar.isVitalFew ? FILLS.vitalFew : FILLS.trivialMany} />
          ))}
        </Bar>
        {hasCumulative ? (
          <Line
            yAxisId="cum"
            type="linear"
            dataKey="cumulativePct"
            // --color-foreground rather than a band token, for the reason the
            // downtime chart states: every semantic band token would be a lie on a
            // line that is derived rather than measured.
            stroke="var(--color-foreground)"
            strokeWidth={2}
            dot={{ r: 2, fill: "var(--color-foreground)" }}
            isAnimationActive={false}
          />
        ) : null}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export { QualityParetoChart };
