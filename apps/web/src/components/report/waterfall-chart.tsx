import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatDuration } from "@/lib/format";
import { SLOT_COUNT } from "@/lib/waterfall";

import type { WaterfallRow } from "@/lib/waterfall";

const SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i);

// Props are declared structurally rather than with recharts' own content types,
// which are loose enough to force an `any` — and oxlint errors on those.
type WaterfallTooltipProps = {
  active?: boolean;
  payload?: { payload: WaterfallRow }[];
};

// Recharts hands the whole row on payload[0].payload, so the per-Bar entries are
// ignored: listing `row.segments` shows the hovered bar's own bands, in the
// order they are stacked, and nothing from its neighbours.
function WaterfallTooltip({ active, payload }: WaterfallTooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium">{row.category}</p>
      <div className="flex flex-col gap-1">
        {row.segments.map((segment) => (
          <p key={segment.label} className="flex items-center justify-between gap-6">
            <span className="text-muted-foreground">{segment.label}</span>
            <span className="font-medium tabular-nums" style={{ color: segment.color }}>
              {formatDuration(segment.ms)}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

type TickProps = {
  x?: number;
  y?: number;
  index?: number;
};

// Two-line category label ("Loading Time" over "(Production Time)"), which a
// plain string tick cannot render.
function CategoryTick({ x, y, index, rows }: TickProps & { rows: WaterfallRow[] }) {
  const row = index === undefined ? undefined : rows[index];
  if (!row) return null;

  return (
    <text x={x} y={y} textAnchor="middle" fontSize={11} fill="var(--color-muted-foreground)">
      <tspan x={x} dy={14}>
        {row.category}
      </tspan>
      {row.sublabel ? (
        <tspan x={x} dy={13}>
          {row.sublabel}
        </tspan>
      ) : null}
    </text>
  );
}

function WaterfallChart({ rows }: { rows: WaterfallRow[] }) {
  const { t } = useTranslation("oee");
  return (
    <ResponsiveContainer width="100%" height={340}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="category"
          interval={0}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          height={44}
          tick={<CategoryTick rows={rows} />}
        />
        <YAxis
          width={52}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
          label={{
            value: t("common.hours"),
            angle: -90,
            position: "insideLeft",
            style: { fill: "var(--color-muted-foreground)", fontSize: 11 },
          }}
        />
        <RechartsTooltip
          cursor={{ fill: "var(--color-muted)", opacity: 0.4 }}
          content={<WaterfallTooltip />}
        />
        {/* One <Bar> per stack position, coloured per category with <Cell>. The
            count is fixed rather than derived from the data, so toggling the
            anomaly bar changes the category count without remounting the stack
            (which recharts would animate as a full redraw). */}
        {SLOTS.map((slot) => (
          <Bar
            key={slot}
            dataKey={`s${slot}`}
            stackId="waterfall"
            isAnimationActive={false}
            maxBarSize={110}
          >
            {rows.map((row) => (
              <Cell key={row.key} fill={row.segments[slot]?.color ?? "transparent"} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export { WaterfallChart };
