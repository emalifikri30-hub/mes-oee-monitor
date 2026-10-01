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
import { OTHERS_LOSS_COPY } from "@/lib/others-loss";
import { ParetoTick } from "@/components/report/pareto-tick";
import { VITAL_FEW_PCT } from "@/lib/pareto-rank";

import type { DowntimeEventBar, DowntimeEventParetoModel } from "@/lib/downtime-event-pareto";

// Bars are the stops that cited each reason; the line is the running share of the
// total. Reading them together is the whole point — the bars say which reason
// comes up most, the line says how few of them account for most of the stopping.
//
// THREE WORDS THIS COMPONENT MUST NEVER CONTAIN: "stops" as a bare bar label,
// "duration", and "minutes". It was written from quality-pareto-chart.tsx and
// reason-pareto-chart.tsx, and between them those two contain all three. There is
// no duration in oee.downtime_log_events, and a bar is a count of stops that
// MENTIONED a reason rather than a count of stops — which is the distinction the
// whole tab turns on.
//
// TWO-TONE, NOT ONE COLOUR PER REASON, for the reason both siblings give: every
// bar here is the same thing, so N distinct hues would encode nothing. The
// vital-few / trivial-many split is the one thing a Pareto's colour CAN mean.
//
// A SEPARATE COMPONENT FROM ReasonParetoChart, and for a sharper reason than
// QualityParetoChart has. That chart's fills key off DowntimeCategory and its
// axis is minutes-or-stops; this one has no category and no minutes at all.
// Threading a spec through its props would produce one component that can render
// either family, and the failure mode is an Others tooltip captioned "Total
// Duration" over a table that has none.
//
// THE BAND TOKEN ARRIVES AS A WHOLE `var(...)` STRING from OTHERS_LOSS_COPY and is
// never composed here — see the note beside `bandVar` in lib/others-loss.ts, and
// `fillsFor` in reason-pareto-chart.tsx where the same trap is verified against
// the built CSS.
const FILLS = {
  vitalFew: OTHERS_LOSS_COPY.bandVar,
  trivialMany: `color-mix(in oklch, ${OTHERS_LOSS_COPY.bandVar} 38%, transparent)`,
};

type TooltipProps = {
  active?: boolean;
  payload?: { payload: DowntimeEventBar }[];
};

// Props declared structurally rather than with recharts' own content types, which
// are loose enough to force an `any` — and oxlint errors on those. Same reasoning
// as its two siblings and waterfall-chart.tsx.
function OthersTooltip({ active, payload }: TooltipProps) {
  const { t } = useTranslation("oee");
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium">{bar.label}</p>
      <div className="flex flex-col gap-1">
        {/* "Stops citing this", not "Stops". The label is where the multi-reason
            fact fits in three words, and without it a reader takes the number for
            a count of stops — which it is not, because one stop can appear in
            several bars. */}
        <Row label={t("report.stopsCiting")} value={formatQuantity(bar.occurrences, null)} />
        {/* The share of ALL occurrences, which is the same denominator the
            cumulative line below uses. Naming both rows lets a reader check the
            one against the other. */}
        <Row
          label={t("common.share")}
          value={bar.sharePct === null ? EM_DASH : `${bar.sharePct.toFixed(1)}%`}
        />
        <Row
          label={t("common.cumulative")}
          value={bar.cumulativePct === null ? EM_DASH : `${bar.cumulativePct.toFixed(1)}%`}
        />
      </div>
      <p className="text-muted-foreground mt-1.5">
        {bar.isVitalFew ? t("common.withinTop", { pct: VITAL_FEW_PCT }) : t("common.longTail")}
        {/* A CONSTANT, not a lookup and not a ternary. There is one measure, so
            there is one thing this sentence can say — which is why the sibling
            charts' measure maps have no counterpart here. */}
        {t("report.rankedByOccurrences")}
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

function OthersParetoChart({ model }: { model: DowntimeEventParetoModel }) {
  const { t } = useTranslation("oee");
  const { bars } = model;

  // With a zero grand total every percentage is null, so the line has nothing to
  // draw and its axis would be a meaningless empty 0-100 scale.
  //
  // BARELY REACHABLE HERE, and kept anyway. It needs a non-empty bucket list whose
  // every frequency is zero, which the endpoint should never send — every bar
  // exists because at least one stop cited it. One boolean is cheaper than the
  // alternative, which is an empty axis on a chart nobody can explain.
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
            // A CONSTANT caption. The sibling charts take a function because their
            // axis unit is not known until the response arrives; a count has no
            // unit to name.
            value: t("report.occurrences"),
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
          content={<OthersTooltip />}
        />
        {/* ONE dataKey, and no `plotValue` alias behind it: a count is already in
            the axis's own terms, so there is nothing to scale and no way to plot
            the wrong field. The sibling charts need the alias because minutes are
            not milliseconds; this one does not. */}
        <Bar yAxisId="measure" dataKey="occurrences" isAnimationActive={false} maxBarSize={72}>
          {bars.map((bar) => (
            <Cell key={bar.key} fill={bar.isVitalFew ? FILLS.vitalFew : FILLS.trivialMany} />
          ))}
        </Bar>
        {hasCumulative ? (
          <Line
            yAxisId="cum"
            type="linear"
            dataKey="cumulativePct"
            // --color-foreground rather than a band token, for the reason both
            // siblings state: every semantic band token would be a lie on a line
            // that is derived rather than measured.
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

export { OthersParetoChart };
