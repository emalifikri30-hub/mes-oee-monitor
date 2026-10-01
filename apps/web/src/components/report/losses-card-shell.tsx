import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatDuration } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricTile } from "@/components/report/metric-tile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ReactNode } from "react";
import type { ReportMeasures } from "@/lib/types";

// The Losses card's LAYOUT and its three groups. Nothing subject-specific.
//
// EXTRACTED FROM losses-card.tsx when the Line detail screen needed the same card
// with a different unit on two tiles, a different drill-down route and no hourly
// chart. Same call metrics-card.tsx and report-header-shell.tsx made, for the
// reason report-list-shell.tsx records: four rules were duplicated across the
// report screens before those existed, and none failed loudly when a copy drifted.
//
// THE GROUPING IS THE ARGUMENT, and it is the part that must not be parameterised.
// Group A is the three top-level OEE loss factors — the ones that multiply out to
// OEE. Group B is what Performance Loss above is made OF, which is why Small Stop
// and Reduce Speed sit behind a rule rather than beside it, and why the hourly
// drill-down belongs there rather than in the header: the chart it opens is the
// evidence for exactly those two figures. Group C is quality and its two counts.
//
// FULL WIDTH: a 9-column grid of three equal 3-column groups, matching
// metrics-card.tsx. This was a `flex flex-wrap` row, so eight short tiles shrank to
// fit and bunched at the left of a full-width card, wasting the right third.
//
// The figures come from the ETL's aggregate columns, NOT from the downtime records
// the timeline reads. They are two independent sources; these are the authoritative
// ones, which is why the strip never renders a total of its own — and why the
// Losses page behind the header icon renders no grand total either.
//
// COLOURS ARE THE `-fg` RAMP, not the band tokens. Label and value share one class
// so they match, which is what the design asserts; the band tokens they name are
// tuned to be read as filled bars and fail WCAG AA badly as small text (small-stop
// is 1.76:1 on the card). index.css carries the measured ratios.

// EXACTLY THE SIX DURATIONS THIS CARD READS. A `Pick` over ReportMeasures rather
// than a whole report, so the shell cannot reach a unit, an id or a grain — the
// three things that differ between the subjects it serves.
type LossDurations = Pick<
  ReportMeasures,
  | "scheduleLossTime"
  | "availabilityLossTime"
  | "performanceLossTime"
  | "msLossTime"
  | "reduceSpeedLossTime"
  | "qualityLossTime"
>;

function LossesCardShell({
  losses,
  reject,
  rework,
  detailLink,
  hourly,
  rejectAction,
  reworkAction,
}: {
  losses: LossDurations;
  // ALREADY FORMATTED, unit included — see the note beside the two tiles below.
  reject: string;
  rework: string;
  // The external-link button. Built by the caller because its `to` is a route
  // literal that differs per subject AND per grain, and a template string is one
  // TanStack cannot check.
  detailLink: ReactNode;
  // The hourly-chart affordance, or null where there is no chart to open.
  hourly: ReactNode;
  // Optional affordances under the two count tiles. The Line card and the SKU card
  // both put an Add Reject / Add Rework button here, plus the "+140 BAG entered"
  // ledger line beneath it — quality-action.tsx, shared between them. The machine
  // card passes neither: oee.work_center_quality_entries is keyed by work_center,
  // and a machine is provenance there, never a target.
  rejectAction?: ReactNode;
  reworkAction?: ReactNode;
}) {
  const { t } = useTranslation("oee");
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="py-4">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t("report.losses")}
          <Tooltip>
            <TooltipTrigger>
              <InfoIcon className="text-muted-foreground size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{t("report.lossesHint")}</TooltipContent>
          </Tooltip>
        </CardTitle>

        {/* NOT a duplicate of the hourly affordance in group B. The two point at
            different evidence: this opens the page that explains Availability
            Loss, while the other opens the hourly chart, which is the evidence for
            Small Stop and Reduce Speed specifically. */}
        <div className="col-start-2 row-start-1 justify-self-end">{detailLink}</div>
      </CardHeader>

      {/* `xl`, not `lg`, for the three-across layout. The app has a persistent 16rem
          sidebar, so at lg the content column is ~740px — about 85px per tile, while
          `03 h 27 m 14 s` at text-sm tabular-nums needs ~95px and every value would
          truncate. Below xl the three groups stack full-width, each with its own
          internal 2-up / 3-up grid. */}
      <CardContent className="grid grid-cols-1 gap-x-8 gap-y-5 pb-5 xl:grid-cols-9">
        {/* A — the three top-level OEE loss factors */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:col-span-3">
          <MetricTile
            label={t("report.scheduleLoss")}
            value={formatDuration(losses.scheduleLossTime)}
            labelClassName="text-oee-planned-downtime-fg"
            valueClassName="text-oee-planned-downtime-fg"
          />
          <MetricTile
            label={t("report.availabilityLoss")}
            value={formatDuration(losses.availabilityLossTime)}
            labelClassName="text-oee-unplanned-downtime-fg"
            valueClassName="text-oee-unplanned-downtime-fg"
          />
          <MetricTile
            label={t("report.performanceLoss")}
            value={formatDuration(losses.performanceLossTime)}
            labelClassName="text-oee-small-stop-fg"
            valueClassName="text-oee-small-stop-fg"
          />
        </div>

        {/* B — what Performance Loss is made of, plus its drill-down.
            The divider flips from a top rule to a left rule at xl: below that the
            groups stack, and a left border would draw a stub against nothing. */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-x-6 gap-y-5 border-t pt-5 xl:col-span-3 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-8">
          <MetricTile
            label={t("report.smallStop")}
            value={formatDuration(losses.msLossTime)}
            labelClassName="text-oee-small-stop-fg"
            valueClassName="text-oee-small-stop-fg"
          />
          {/* Reduce-speed loss goes negative when the machine outran its
              standard rate; that is real data, so it is shown as-is. */}
          <MetricTile
            label={t("report.reduceSpeed")}
            value={formatDuration(losses.reduceSpeedLossTime)}
            labelClassName="text-oee-small-stop-fg"
            valueClassName="text-oee-small-stop-fg"
          />
          {/* Sits on the LABEL row, not the value row: `items-start` above aligns
              it with "Reduce Speed" rather than with the figure underneath, which
              is what the design shows and what keeps this group consistent with
              groups A and C, neither of which aligns to a baseline.

              It stays inside group B rather than moving to the header because the
              hourly chart it opens is the evidence for exactly these two figures.
              The header icon is a different drill-down — see the comment there. */}
          {/* A SLOT, because WHETHER there is an hourly chart to open is a fact
              about the subject and the grain, not about this layout.
              
              The machine card passes a View button at shift and day grain and
              nothing at month: the month's equivalent is an hour-of-day PROFILE,
              which lives on the Losses page's Performance Loss -> Trendline
              sub-tab. The LINE card passes nothing at any grain — there is no line
              performance endpoint, for the reason contract §16.4a gives. */}
          {hourly}
        </div>

        {/* C — quality and its two counts */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 sm:grid-cols-3 xl:col-span-3 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-8">
          <MetricTile
            label={t("report.qualityLoss")}
            value={formatDuration(losses.qualityLossTime)}
            labelClassName="text-oee-quality-fg"
            valueClassName="text-oee-quality-fg"
          />
          {/* Reject and rework are COUNTS, not durations — the time equivalents are
              rejectTime / reworkTime — and they arrive ALREADY FORMATTED, unit
              included.
              
              That is not laziness about types: a machine has one unit of measure
              and a LINE HAS TWO (migration 0014 — bags in, cartons out), with
              reject and rework on the infeed side. A single `uomName` prop here
              would render cartons under a bag label on the line card, which is a
              wrong number that looks entirely ordinary. So the pairing stays with
              the caller that knows it, exactly as metrics-card.tsx does. */}
          <MetricTile
            label={t("report.reject")}
            value={reject}
            labelClassName="text-oee-quality-fg"
            valueClassName="text-oee-quality-fg"
          >
            {rejectAction}
          </MetricTile>
          <MetricTile
            label={t("report.rework")}
            value={rework}
            labelClassName="text-oee-quality-fg"
            valueClassName="text-oee-quality-fg"
          >
            {reworkAction}
          </MetricTile>
        </div>
      </CardContent>
    </Card>
  );
}

export { LossesCardShell };
export type { LossDurations };
