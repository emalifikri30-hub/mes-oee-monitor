import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTranslation } from "react-i18next";

import { formatDuration, formatQuantity } from "@/lib/format";

import { qtyDomainFor } from "@/lib/perf-hourly";

import type { HourlyOutputModel, HourlyPoint, HourlySkuSeries } from "@/lib/perf-hourly";

// One chart per SKU. Four lines, two axes.
//
// WHY TWO Y AXES. Actual/Effective Production are quantities (BAG); Actual/Master
// Rate are rates (BAG per hour). In the reference design they look comparable only
// because every bucket there is a near-full hour, so qty-per-hour ≈ qty. The moment
// there is downtime — which is the entire subject of a losses drill-down — the
// quantity falls and the rate does not, and one shared axis hides exactly that:
//
//   10 000 BAG made in 15 minutes  ->  40 000 BAG/hour
//   on one axis those plot 4x apart for no reason a reader can use
//
// The usual objection to a dual axis is spurious correlation between unrelated
// series. It does not apply here: two lines per axis, and each is read against its
// own reference — effective against actual, achieved rate against the standard.
//
// WHY ONE CHART PER SKU rather than N x 4 lines on one. Five SKUs would be twenty
// lines in one legend. The strongest evidence this is the intended design is the
// reference tooltip itself: it has a single `SKU: <name>` line and one set of four
// values, which only makes sense per SKU. It also matches how sku-view-card.tsx
// already handles N products, and it needs no selection state.

// Props declared structurally rather than with recharts' own content types, which
// are loose enough to force an `any` — and oxlint errors on those. Same reasoning
// as WaterfallTooltipProps.
type PerfTooltipProps = {
  active?: boolean;
  payload?: { payload: HourlyPoint }[];
};

const SERIES = {
  actualOut: "var(--color-oee-value-added)",
  effectiveOut: "var(--color-oee-planned-downtime)",
  actualRate: "var(--color-oee-small-stop)",
  masterRate: "var(--color-oee-neutral)",
} as const;

// Recharts hands the whole row on payload[0].payload, so the per-Line entries are
// ignored — every field shown is already on the point, which is why
// lib/perf-hourly.ts puts productName and uomCode there.
//
// formatQuantity and formatDuration both return an em dash for null, so a gapped
// series needs no branching here: a bucket the SKU did not run reads as dashes
// rather than as zeroes.
function PerfTooltip({ active, payload }: PerfTooltipProps) {
  const { t } = useTranslation("oee");
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  const perHour = t("report.perHour", { unit: point.uomCode ?? "" });

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium">{point.label}</p>
      <p className="text-muted-foreground mb-1.5">
        {t("report.skuColon", { name: point.productName })}
      </p>
      <div className="flex flex-col gap-1">
        <TooltipRow
          label={t("report.actualProduction")}
          value={formatQuantity(point.totalOut, point.uomCode)}
          color={SERIES.actualOut}
        />
        <TooltipRow
          label={t("report.effectiveProduction")}
          value={formatQuantity(point.effectiveOut, point.uomCode)}
          color={SERIES.effectiveOut}
        />
        <TooltipRow
          label={t("report.runtimeDurationHour")}
          value={formatDuration(point.runtimeMs)}
        />
        <TooltipRow
          label={t("report.actualCycleTime")}
          value={formatQuantity(point.actualRatePerHour, perHour)}
          color={SERIES.actualRate}
        />
        <TooltipRow
          label={t("report.masterCycleTime")}
          value={formatQuantity(point.idealRatePerHour, perHour)}
          color={SERIES.masterRate}
        />
      </div>
    </div>
  );
}

function TooltipRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <p className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums" style={color ? { color } : undefined}>
        {value}
      </span>
    </p>
  );
}

// The legend is rendered as markup rather than through recharts' <Legend>, because
// it doubles as the block header: the reference design shows the SKU name and the
// four swatches on one line, which is exactly this.
function PerfLegend({ sku }: { sku: HourlySkuSeries }) {
  const { t } = useTranslation("oee");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="font-semibold">{sku.productName}</span>
      <Swatch color={SERIES.actualOut} label={t("report.actualProduction")} />
      <Swatch color={SERIES.effectiveOut} label={t("report.effectiveProduction")} />
      <Swatch color={SERIES.actualRate} label={t("report.actualCycleTime")} />
      {/* Omitted, not dimmed-and-drawn: there is no line to key against. */}
      {sku.hasMasterRate ? (
        <Swatch color={SERIES.masterRate} label={t("report.masterCycleTime")} dashed />
      ) : null}
    </div>
  );
}

function Swatch({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="text-muted-foreground flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-0 w-4 border-t-2"
        style={{ borderColor: color, borderTopStyle: dashed ? "dashed" : "solid" }}
      />
      {label}
    </span>
  );
}

function PerformanceChart({ sku, model }: { sku: HourlySkuSeries; model: HourlyOutputModel }) {
  const { t } = useTranslation("oee");
  // THIS BLOCK'S OWN UNIT'S DOMAIN, not one shared by every block. A domain shared
  // across units scales a CALENDER block by a BAG block's magnitude — the axis
  // said "Mixed units" while the shapes were still being drawn as comparable,
  // which is the half that actually misleads. See perf-hourly.ts's qtyDomains.
  const qtyDomain = qtyDomainFor(model, sku.uomCode);

  return (
    <div className="flex flex-col gap-2">
      <PerfLegend sku={sku} />

      {sku.isEmpty ? (
        <p className="text-muted-foreground text-xs">{t("report.noHourlyOutput")}</p>
      ) : null}

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={sku.points} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis
            // The label, but the ARRAY ORDER is the chronology — core-api orders by
            // bucket_start and lib/perf-hourly.ts preserves it. Recharts plots a
            // category axis in array order, so shift 3 reads 23:00 first without
            // this axis knowing anything about clocks.
            dataKey="label"
            interval={0}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border)" }}
            height={48}
            angle={-30}
            textAnchor="end"
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
          />
          <YAxis
            yAxisId="qty"
            domain={qtyDomain}
            width={56}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
            // THE AXIS NAMES ITS UNIT, or says it has none.
            //
            // A static "Units" is legible only while every series on the chart
            // shares one, and `model.uomCode` is ALREADY null when the shift's SKUs
            // do not (see buildHourlyOutput — BAG and CARTON do not average, so the
            // shift-wide figures go null with it). Those series were still being
            // drawn against one axis labelled as though they agreed.
            //
            // This does not make a mixed-unit chart correct; nothing here could.
            // It makes it VISIBLY mixed rather than plausibly single, which is the
            // difference between a reader distrusting the scale and a reader
            // comparing two numbers that cannot be compared. The two-Y-axis fix
            // the LINE grain will need is a different change and needs an endpoint
            // that does not exist — contract §16.4a and TODOS §52.
            label={{
              value: model.uomCode ?? t("common.mixedUnits"),
              angle: -90,
              position: "insideLeft",
              style: { fill: "var(--color-muted-foreground)", fontSize: 11 },
            }}
          />
          <YAxis
            yAxisId="rate"
            orientation="right"
            domain={model.rateDomain}
            width={64}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
            label={{
              value:
                model.uomCode === null
                  ? t("common.mixedUnitsPerHour")
                  : t("report.perHour", { unit: model.uomCode }),
              angle: 90,
              position: "insideRight",
              style: { fill: "var(--color-muted-foreground)", fontSize: 11 },
            }}
          />
          {/* Only when something is actually negative — a machine that outran its
              standard. Without a visible baseline the sign is not legible. */}
          {qtyDomain[0] < 0 ? (
            <ReferenceLine yAxisId="qty" y={0} stroke="var(--color-border)" />
          ) : null}
          <RechartsTooltip cursor={{ stroke: "var(--color-border)" }} content={<PerfTooltip />} />
          {/* connectNulls is deliberately OFF (its default). A null is an hour the
              SKU did not run; bridging it would draw production nobody made. */}
          <Line
            yAxisId="qty"
            type="linear"
            dataKey="totalOut"
            stroke={SERIES.actualOut}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
          <Line
            yAxisId="qty"
            type="linear"
            dataKey="effectiveOut"
            stroke={SERIES.effectiveOut}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
          <Line
            yAxisId="rate"
            type="linear"
            dataKey="actualRatePerHour"
            stroke={SERIES.actualRate}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
          {/* Dashed and neutral-grey because it is a TARGET, not an observation —
              the same reading --oee-neutral already carries in the waterfall. Not
              rendered at all when no bucket knew a standard: a zero line would
              draw a target of "make nothing". */}
          {sku.hasMasterRate ? (
            <Line
              yAxisId="rate"
              type="linear"
              dataKey="idealRatePerHour"
              stroke={SERIES.masterRate}
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={{ r: 2 }}
              isAnimationActive={false}
            />
          ) : null}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export { PerformanceChart };
