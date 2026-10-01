import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTranslation } from "react-i18next";

import { formatPercent } from "@/lib/format";
import { TREND_SERIES } from "@/lib/oee-dashboard/oee-performance";

import type { OeeTrendAxis, OeeTrendDatum } from "@/lib/oee-dashboard/oee-performance";

// The daily rate curves. FOUR lines, one axis, a whole month.
//
// ONE CHART AND NOT FOUR. OEE is the product of availability, performance and
// quality, so the question a reader brings here is "OEE fell on the 19th — which
// of them moved?", and that is unanswerable one chart at a time: comparing four
// stacked cards means holding three shapes in your head while looking at the
// fourth. They share a unit and a 0-100 scale, which is the condition under which
// one axis is honest.
//
// THE GAPS ARE THE FEATURE. `connectNulls` is left at its default of FALSE and
// must stay there: buildOeeTrendSeries maps a 0% day and an uncomposable day to
// `undefined`, and recharts then BREAKS the line at that x position rather than
// drawing through it. Turning connectNulls on would draw a straight segment across
// an idle week and read as steady running — the single most flattering thing this
// chart could do wrong.
//
// The x positions are kept for the same reason: the day is still on the axis, so
// the break is visible as a gap rather than as a month that was three days short.
//
// Props are declared structurally rather than with recharts' own content types,
// which are loose enough to force an `any` — oxlint errors on those. Same
// reasoning as PerfTooltipProps.
type TrendTooltipProps = {
  active?: boolean;
  payload?: { payload: OeeTrendDatum }[];
  axis: OeeTrendAxis;
};

function TrendTooltip({ active, payload, axis }: TrendTooltipProps) {
  const { t } = useTranslation("oee");
  const point = payload?.[0]?.payload;
  if (active !== true || point === undefined) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      {/* FORMATTED, NOT RAW. This printed `point.businessDate` verbatim while the
          month screen was the only caller — "2026-08-19", which reads fine. At YEAR
          grain the points are dated `YYYY-MM-01`, so the raw string shows a real
          date, correctly formatted, that reads as one DAY of the year. */}
      <p className="mb-1.5 font-medium">{axis.label(point.businessDate)}</p>
      <div className="flex flex-col gap-1">
        {TREND_SERIES.map((series) => (
          <p key={series.key} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: series.color }}
              />
              <span className="text-muted-foreground">{series.label}</span>
            </span>
            {/* `undefined` reaches here as the gap it is. Saying "0%" would restate
                the exact claim the gap exists to avoid making. */}
            <span className="font-medium tabular-nums">
              {point[series.key] === undefined
                ? t("dashboard.notRecorded")
                : formatPercent(point[series.key])}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

// THE AXIS COMES IN AS DATA — `TREND_AXIS.month` or `TREND_AXIS.year`, picked by
// the route as a literal. It used to hold a local `dayOfMonth`, which was right
// while a month report was the only thing that could be trended; a year report
// trends MONTHS, and the tick is then a month name off positions 5-7.
//
// Both formatters are string slices rather than Dates, and they live in
// lib/oee-dashboard/oee-performance.ts because recharts renders nothing measurable
// under happy-dom — a tick never reaches the DOM, so the only way to assert them is
// to assert the record.
function OeeTrendChart({ data, axis }: { data: OeeTrendDatum[]; axis: OeeTrendAxis }) {
  return (
    <div className="flex flex-col gap-3">
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="businessDate"
            tickFormatter={axis.tick}
            tick={{ fontSize: 11 }}
            stroke="var(--color-muted-foreground)"
          />
          <YAxis
            // PINNED 0-100, not fitted to the data. A fitted axis would rescale
            // between machines and make a month at 88-91% look as volatile as one at
            // 10-90%, which is the comparison this chart exists to support.
            domain={[0, 100]}
            ticks={[0, 20, 40, 60, 80, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 11 }}
            stroke="var(--color-muted-foreground)"
            width={44}
          />
          <RechartsTooltip content={<TrendTooltip axis={axis} />} />
          {TREND_SERIES.map((series) => (
            <Line
              key={series.key}
              type="linear"
              dataKey={series.key}
              stroke={series.color}
              // OEE is the one being explained, so it is drawn heavier than the three
              // factors explaining it.
              strokeWidth={series.key === "oee" ? 2.5 : 1.5}
              dot={{ r: 2 }}
              // Off for the reason every chart in this app has it off: an animation
              // replays on every cache revalidation and reads as the data changing.
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>

      {/* A MARKUP LEGEND, not recharts', for performance-chart.tsx's reason: its
          own legend cannot be styled to match the rest of the app's chart chrome,
          and this one reads the same const the lines do. */}
      <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
        {TREND_SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: series.color }}
            />
            <span className="text-muted-foreground">{series.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { OeeTrendChart };
