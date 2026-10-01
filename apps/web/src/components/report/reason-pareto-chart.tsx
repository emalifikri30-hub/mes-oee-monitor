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

import { EM_DASH, formatDuration } from "@/lib/format";
import { ParetoTick } from "@/components/report/pareto-tick";
import { VITAL_FEW_PCT } from "@/lib/pareto";

import type { ParetoBar, ParetoMeasure, ParetoModel } from "@/lib/pareto";

// Bars are ranked downtime per reason; the line is the running share of the
// total. Reading them together is the whole point — the bars say what is
// biggest, the line says how few of them you have to fix.
//
// TWO-TONE, NOT ONE COLOUR PER REASON. Every bar in one chart is the same thing
// — unplanned downtime, or planned, or small stops — so N distinct hues would
// encode nothing and would fight index.css's rule that the oee-* tokens are
// "named for what each band means rather than for its hue". The vital-few /
// trivial-many split is the one thing a Pareto's colour CAN mean, and it still
// varies per bar via <Cell>.
//
// The HUE arrives as DATA (see ParetoAppearance), from the same tokens the
// waterfall bands and the Losses tiles read, so Schedule Loss is the blue it is
// everywhere else in the app rather than a second red chart the reader has to
// check the title of.
//
// THE TOKEN NAME MUST APPEAR LITERALLY IN SOURCE, which is why it arrives as a
// whole `var(...)` string from the caller and is never composed here as
// `var(--color-oee-${slug})`. index.css opens `@theme inline`, and with `inline`
// Tailwind does not define the `--color-*` properties — it emits one only where
// its scanner found the literal text. A composed name is a property that was
// never emitted, so `fill` resolves to nothing and the bar renders uncoloured
// with no error anywhere. Verified against the built CSS: exactly the eight band
// tokens written out in lib/waterfall.ts, performance-chart.tsx and
// lib/loss-category.ts survive, and the `-fg` ramp — used only through utility
// classes — does not appear as a custom property at all.

// WHAT THIS CHART NEEDS FROM ITS SUBJECT, as DATA rather than as a category flag.
//
// It used to take a `DowntimeCategory` and look both values up itself. Pareto
// Actions broke that: an action is not an operation type, so there is no category
// to pass and the honest options were a lie ("UNPLANNED", which would print
// "Unplanned stops" in the tooltip) or this. The rule apps/web/AGENTS.md states
// for every shared component applies exactly — a flag in here is how one chart
// ends up labelling another's rows.
//
// The reason Pareto passes `LOSS_CATEGORY_COPY[category]`, which already has both
// fields, so its call site is unchanged in meaning.
type ParetoAppearance = {
  // A WHOLE `var(...)` STRING, never composed here — see the note above.
  bandVar: string;
  // What the tooltip's frequency row counts: "Unplanned stops", "Planned stops",
  // "Small stops" — or, for actions, "Stops actioned".
  stopsLabel: string;
};

function fillsFor(bandVar: string) {
  return {
    vitalFew: bandVar,
    trivialMany: `color-mix(in oklch, ${bandVar} 38%, transparent)`,
  };
}

type TooltipProps = {
  active?: boolean;
  payload?: { payload: ParetoBar }[];
  measure: ParetoMeasure;
  appearance: ParetoAppearance;
};

// Props declared structurally rather than with recharts' own content types,
// which are loose enough to force an `any` — and oxlint errors on those. Same
// reasoning as waterfall-chart.tsx.
function ParetoTooltip({ active, payload, measure, appearance }: TooltipProps) {
  const { t } = useTranslation("oee");
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium">{bar.label}</p>
      <div className="flex flex-col gap-1">
        <Row label={t("table.machine")} value={bar.machineName ?? EM_DASH} />
        {/* "Unplanned stops" / "Planned stops" / "Small stops" / "Stops actioned"
            — the count is only meaningful once the reader knows what is being
            counted, and this chart now serves four questions. */}
        <Row label={appearance.stopsLabel} value={String(bar.frequency)} />
        {/* Off the raw milliseconds, never the rounded minutes the axis uses —
            the two would disagree on anything under a minute. */}
        <Row label={t("report.totalDurationLower")} value={formatDuration(bar.durationMs)} />
        <Row
          label={t("common.cumulative")}
          value={bar.cumulativePct === null ? EM_DASH : `${bar.cumulativePct.toFixed(1)}%`}
        />
      </div>
      <p className="text-muted-foreground mt-1.5">
        {bar.isVitalFew ? t("common.withinTop", { pct: VITAL_FEW_PCT }) : t("common.longTail")}
        {t("report.rankedByMeasure", {
          measure:
            measure === "frequency" ? t("report.rankByFrequency") : t("report.rankByDuration"),
        })}
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

function ReasonParetoChart({
  model,
  appearance,
}: {
  model: ParetoModel;
  appearance: ParetoAppearance;
}) {
  const { t } = useTranslation("oee");
  const { bars, measure } = model;
  const fills = fillsFor(appearance.bandVar);
  // The bars read minutes when ranked by duration and a plain count when ranked
  // by frequency, so the left axis has to relabel with the toggle.
  const barKey = measure === "duration" ? "durationMinutes" : "frequency";
  const barLabel = measure === "duration" ? t("common.minutes") : t("report.stops");

  // With a zero grand total every percentage is null, so the line has nothing to
  // draw and its axis would be a meaningless empty 0-100 scale.
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
          width={56}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
          label={{
            value: barLabel,
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
          content={<ParetoTooltip measure={measure} appearance={appearance} />}
        />
        <Bar yAxisId="measure" dataKey={barKey} isAnimationActive={false} maxBarSize={72}>
          {bars.map((bar) => (
            <Cell key={bar.key} fill={bar.isVitalFew ? fills.vitalFew : fills.trivialMany} />
          ))}
        </Bar>
        {hasCumulative ? (
          <Line
            yAxisId="cum"
            type="linear"
            dataKey="cumulativePct"
            // --color-foreground rather than a band token: --oee-neutral is far
            // too light to read as a 2px stroke, and every semantic band token
            // would be a lie on a line that is derived rather than measured.
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

export { ReasonParetoChart };
export type { ParetoAppearance };
