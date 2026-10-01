import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { useTranslation } from "react-i18next";

import { donutPct, donutTotal } from "@/lib/oee-dashboard/oee-performance";
import { formatLongDuration, formatPercent } from "@/lib/format";

import type { DonutSlice } from "@/lib/oee-dashboard/oee-performance";

// ONE DONUT, TWO CARDS. Calendar Time and OEE Losses differ only in their slices,
// and both answer the same shape of question: here is a whole, here is what it is
// made of. The slices arrive built and summed (lib/oee-dashboard/), so this file
// holds no arithmetic — it cannot be the place a wedge stops matching its label.
//
// A DONUT AND NOT A BAR, which is a choice worth defending because this repo
// refuses one elsewhere: area-production-units-card.tsx is "two tables and not a
// chart" because 12,000 BAG beside 400 SACK says nothing about which is more
// material. The difference is that these slices are the SAME UNIT and are PARTS OF
// ONE WHOLE that they sum to exactly — the two conditions under which an angle
// means something. Neither holds there.
//
// THE CENTRE IS THE TOTAL, in days. A month of calendar time is ~744 hours, which
// formatDuration renders correctly and unreadably; see formatLongDuration.

type DonutTooltipProps = {
  active?: boolean;
  payload?: { payload: DonutSlice & { pct: number | null } }[];
};

function DonutTooltip({ active, payload }: DonutTooltipProps) {
  const { t } = useTranslation("oee");
  const slice = payload?.[0]?.payload;
  if (active !== true || slice === undefined) return null;

  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{slice.label}</p>
      <p className="tabular-nums">
        {t("dashboard.durationColon", { value: formatLongDuration(slice.ms) })}
      </p>
      <p className="text-muted-foreground tabular-nums">{formatPercent(slice.pct)}</p>
    </div>
  );
}

function DonutChart({ slices }: { slices: DonutSlice[] }) {
  const total = donutTotal(slices);
  // The percentage rides ON the datum rather than being recomputed in the tooltip
  // and the legend, so the three can never disagree about one wedge.
  const data = slices.map((slice) => ({ ...slice, pct: donutPct(slice, total) }));

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={data}
              dataKey="ms"
              nameKey="label"
              innerRadius="58%"
              outerRadius="85%"
              // Off for the reason every chart in this app has it off: an animation
              // replays on every cache revalidation and reads as the data changing.
              isAnimationActive={false}
              stroke="var(--color-background)"
              strokeWidth={2}
            >
              {data.map((slice) => (
                <Cell key={slice.key} fill={slice.fill} />
              ))}
            </Pie>
            <RechartsTooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* ABSOLUTELY POSITIONED RATHER THAN A recharts <Label>, because the
            centre figure is long ("25 d 08 h 00 m 00 s") and recharts' label
            renders one SVG text node that cannot wrap. `pointer-events-none` so
            it never swallows a hover meant for the ring beneath it. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-semibold tabular-nums">{formatLongDuration(total)}</span>
        </div>
      </div>

      {/* A MARKUP LEGEND, not recharts', for the reason performance-chart.tsx
          states: its own legend cannot show a second value per entry, and the
          share is the thing a reader came for.
          THE SHARE SITS BESIDE ITS LABEL rather than right-aligned in a column.
          The mock runs leader lines from each wedge to its percentage; putting the
          figure in the legend says the same thing without four lines crossing the
          ring, but only if the two stay adjacent — pushed to opposite edges of a
          wide column, a reader has to track across whitespace to pair them. */}
      <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5">
        {data.map((slice) => (
          <li key={slice.key} className="flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: slice.fill }}
            />
            <span className="text-muted-foreground">{slice.label}</span>
            <span className="font-medium tabular-nums">{formatPercent(slice.pct)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { DonutChart };
