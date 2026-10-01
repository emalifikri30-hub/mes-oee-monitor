import { useTranslation } from "react-i18next";

import { DashboardParetoCard } from "@/components/oee-dashboard/dashboard-pareto-card";
import { DonutCard } from "@/components/oee-dashboard/donut-card";
import { LOSS_CATEGORY_COPY } from "@/lib/loss-category";
import { OeeSummaryCard } from "@/components/oee-dashboard/oee-summary-card";
import { OeeTrendCard } from "@/components/oee-dashboard/oee-trend-card";
import { QualityLossesCard } from "@/components/oee-dashboard/quality-losses-card";
import { SixBigLossesCard } from "@/components/oee-dashboard/six-big-losses-card";
import { buildCalendarTimeSlices, buildOeeLossSlices } from "@/lib/oee-dashboard/oee-performance";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { OeeTrendAxis } from "@/lib/oee-dashboard/oee-performance";
import type {
  DowntimeActionBreakdown,
  DowntimeReasonBreakdown,
  MonthOeeTrend,
  RejectReasonBreakdown,
  ReportMeasures,
} from "@/lib/types";

// THE DASHBOARD'S CARD GRID, once, for all six screens.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SHARES AND WHY THAT IS NOT THE FORBIDDEN SHAPE
// ─────────────────────────────────────────────────────────────────────────────
//
// apps/web/AGENTS.md forbids a component shared across subjects from taking a
// `subject` flag, and it is right: that is how a Line screen signs off a MACHINE
// report. NOTHING IN THIS FILE DECIDES WHICH ENDPOINT ANSWERED. It takes six
// already-resolved query states, a tile list and some prose, and it cannot reach an
// id, a grain, a subject or a route. The dispatch stays in the six route files,
// where every `to`, hook and report type is statically checked.
//
// WHAT IT PROTECTS IS THE WIRING THAT FAILS SILENTLY. Three properties below are
// invisible when broken:
//
//   * Schedule Loss draws the PLANNED breakdown the Six Big Losses card already
//     fetched — one request, two cards, and they provably cannot disagree. Swap it
//     for `unplanned` in one of six copies and you get a correct-looking Pareto of
//     the wrong category, on one screen.
//   * Pareto Quality Losses draws the SAME `rejects` payload, for the same reason.
//   * The Calendar Time donut derives its losses slice by SUBTRACTION, so the ring
//     stays whole even on a row where the pipeline broke the identity.
//
// Six copies of this grid would also be six copies of the Pareto Actions footnote —
// prose, and the cheapest thing in the app to let drift.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEASURES ARE A `Pick`, DELIBERATELY — losses-card-shell.tsx's trick
// ─────────────────────────────────────────────────────────────────────────────
//
// Narrowing to the seven durations the cards actually read is what makes the
// no-dispatch claim above CHECKABLE rather than a promise: this component cannot
// reach a unit, an id, a name or a rate, because the type does not carry them. All
// seven are `number` on the machine, line AND area payloads (only the RATES and
// COUNTS differ in nullability), so one Pick serves three report shapes with no
// union and no narrowing.
type DashboardMeasures = Pick<
  ReportMeasures,
  | "availabilityTime"
  | "valueAddedTime"
  | "scheduleLossTime"
  | "availabilityLossTime"
  | "performanceLossTime"
  | "qualityLossTime"
  | "reduceSpeedLossTime"
>;

// Just enough of a useQuery result to render a state ladder. Declared here rather
// than imported from @tanstack/react-query so a route cannot hand this component a
// refetch function and start driving it.
type CardQueryState<TData> = {
  data: TData | undefined;
  isPending: boolean;
  isError: boolean;
};

// The prose that varies with the GRAIN — the one axis the subject registry
// deliberately does not carry. See lib/oee-dashboard/period-copy.ts.
type DashboardPeriodCopy = {
  trendError: string;
  trendEmptyStale: string;
  trendEmptyLoaded: string;
  actionsFootnote: string;
};

function OeePerformanceView({
  tiles,
  measures,
  hasReport,
  reportPending,
  reportBusinessDay,
  timeZone,
  trend,
  rejects,
  planned,
  unplanned,
  smallStop,
  actions,
  subjectLabel,
  copy,
  axis,
  qualityMachineName,
}: {
  tiles: MetricSpec[];
  measures: DashboardMeasures | undefined;
  hasReport: boolean;
  reportPending: boolean;
  reportBusinessDay: string | null | undefined;
  timeZone: string;
  trend: CardQueryState<MonthOeeTrend>;
  rejects: CardQueryState<RejectReasonBreakdown>;
  planned: CardQueryState<DowntimeReasonBreakdown>;
  unplanned: CardQueryState<DowntimeReasonBreakdown>;
  smallStop: CardQueryState<DowntimeReasonBreakdown>;
  actions: CardQueryState<DowntimeActionBreakdown>;
  subjectLabel: string;
  copy: DashboardPeriodCopy;
  // Passed straight through to the trend card. The view holds it rather than
  // deriving it, for the same reason it holds `copy`: only the route knows its own
  // grain as a literal.
  axis: OeeTrendAxis;
  // NULL ON EVERY LINE AND AREA SCREEN, and that is a decision rather than a gap.
  // On a MACHINE screen the rejects endpoint is scoped to one machine, so the report
  // supplies the name a bucket's enrichment could not. A line's or an area's buckets
  // span many machines and carry their own names — passing the line's here would
  // label a whole line's rejects with one subject's name.
  qualityMachineName: string | null;
}) {
  const { t } = useTranslation("oee");
  return (
    <div className="flex flex-col gap-4">
      <OeeSummaryCard tiles={tiles} />

      {/* THE MOCK'S ROWS, and the pairing is deliberate rather than a grid that
          happened to fit. Each row is one question: what is the shape of the period
          (donuts), where did the time go (six losses / trend), and which causes are
          worth attacking (the three Paretos). */}
      <div className="grid gap-4 lg:grid-cols-2">
        <DonutCard
          title={t("dashboard.calendarTime")}
          slices={measures === undefined ? [] : buildCalendarTimeSlices(measures)}
          isPending={!hasReport || reportPending}
        />
        <DonutCard
          title={t("dashboard.oeeLosses")}
          slices={measures === undefined ? [] : buildOeeLossSlices(measures)}
          isPending={!hasReport || reportPending}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <SixBigLossesCard
          sources={{
            planned: planned.data,
            unplanned: unplanned.data,
            smallStop: smallStop.data,
            rejects: rejects.data,
            reduceSpeedLossTime: measures?.reduceSpeedLossTime,
          }}
          states={[planned, unplanned, smallStop, rejects]}
          // READ FIRST, and deliberately: the four queries above are gated on the
          // report, and a gated useQuery pends FOREVER. See the card.
          reportPending={!hasReport || reportPending}
          reportBusinessDay={reportBusinessDay}
          timeZone={timeZone}
          subjectLabel={subjectLabel}
        />

        <OeeTrendCard
          trend={trend.data}
          isPending={trend.isPending}
          isError={trend.isError}
          hasReport={hasReport}
          reportBusinessDay={reportBusinessDay}
          copy={copy}
          axis={axis}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* PARETO ACTIONS reuses the downtime Pareto chart with its own colours —
            an action is not an operation type, so there is no LOSS_CATEGORY_COPY
            entry to hand it. */}
        <DashboardParetoCard
          title={t("dashboard.paretoActions")}
          breakdown={actions.data}
          appearance={{
            bandVar: "var(--color-oee-anomaly)",
            stopsLabel: t("dashboard.stopsActioned"),
          }}
          isPending={actions.isPending}
          isError={actions.isError}
          hasParams={hasReport}
          reportBusinessDay={reportBusinessDay}
          // THE CAVEAT BELONGS ON THE CHART, not in a comment nobody reads: a stop
          // can carry several actions and only the first is counted, so a second
          // action recorded on a stop contributes nothing. See primaryAction.
          footnote={copy.actionsFootnote}
        />

        {/* SCHEDULE LOSS reuses the PLANNED breakdown the Six Big Losses card
            already fetched — one request, two cards, and they cannot disagree. */}
        <DashboardParetoCard
          title={t("dashboard.scheduleLoss")}
          breakdown={planned.data}
          appearance={LOSS_CATEGORY_COPY.PLANNED}
          isPending={planned.isPending}
          isError={planned.isError}
          hasParams={hasReport}
          reportBusinessDay={reportBusinessDay}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Also already fetched, for the Six Big Losses card's quality arm. */}
        <QualityLossesCard
          breakdown={rejects.data}
          isPending={rejects.isPending}
          isError={rejects.isError}
          hasParams={hasReport}
          reportBusinessDay={reportBusinessDay}
          machineName={qualityMachineName}
        />
      </div>
    </div>
  );
}

export { OeePerformanceView };
export type { CardQueryState, DashboardMeasures, DashboardPeriodCopy };
