import { useTranslation } from "react-i18next";

import { ACHIEVEMENT_CLASS_NAME, ACHIEVEMENT_PLACEHOLDER } from "@/lib/achievement";
import { formatDuration, formatPercent, formatQuantity } from "@/lib/format";
import { MetricsCard } from "@/components/report/metrics-card";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { AreaGrain, AreaReportDetail } from "@/lib/types";

// The AREA's headline figures. Same collapsible grid as the machine's Summary OEE
// and the line's overview (metrics-card.tsx); what is different is which figures
// exist, and in what.
//
// ─────────────────────────────────────────────────────────────────────────────
//  AN AREA HAS ONE UNIT, AND IT IS A MASS — BECAUSE ITS MEMBERS HAVE MANY
// ─────────────────────────────────────────────────────────────────────────────
//
// This inverts the line card's central fact rather than simplifying it, so read
// line-overview-card.tsx's diagram first and then this:
//
//        LINE                                   AREA
//     ┌──────────────────────────┐          ┌──────────────────────────┐
//     │ infeed side  (bags)      │          │  ONE side: MASS (kg)     │
//     │ output side  (cartons)   │  ──────▶ │  Total / Area / Finish   │
//     │ two triples, two CHECKs  │          │  Good, Reject, Rework    │
//     └──────────────────────────┘          └──────────────────────────┘
//
// A line has two count points in two units. An area's member lines disagree about
// BOTH of them — one ships cartons, another sacks — so the line's shape applied
// here would leave both triples NULL on almost every row and null every count with
// them. The Total Production tile would be a permanent em dash.
//
// Weight is the answer and it is the requirement's answer: every product package in
// mes-master-data carries `std_weight`, so a count in ANY packaging unit converts
// to a mass, and mass is the only unit that survives composition across an area.
// So ONE unit here, and every tile reads it from the same `weightUomName` — which
// is the opposite of the line card's rule that the unit must travel with each tile.
// It is safe here for exactly the reason it is unsafe there: there is one unit, and
// the CHECK on migration 0024 guarantees the counts are NULL whenever it is.
//
// `totalOut = goodOut + reject + rework` IS STILL NOT AN IDENTITY, and nothing on
// this card computes across the tiles. At line grain it is FALSE by unit (contract
// §16.4a); here the units agree, so the sum is well-formed and still not asserted —
// the figures come from different count points on N lines, and mass is neither
// conserved through a packing line nor measured at a single point.
//
// ─────────────────────────────────────────────────────────────────────────────
//  RUN TIME IS IN LINE-HOURS, AND IT WILL READ ABOVE 24 h
// ─────────────────────────────────────────────────────────────────────────────
//
// Migration 0024's consequence 1. An area has no clock of its own, so every
// duration on the row is summed across its lines: a five-line area's business day
// is ~120 hours of Run Time capacity, not ~24. That is the intended reading — an
// area that lost 3 h on line A and 2 h on line B has lost 5 h — and nothing here
// divides by a line count to make it look like a wall clock. The tooltip says so on
// screen, because a supervisor reading "97 h 12 m" against a one-day heading will
// otherwise assume a bug.
//
// EVERY RATE AND EVERY COUNT IS NULLABLE. 0/0 is real for an area whose every line
// sat in planned downtime, and a NULL count means the members could not be brought
// to a common mass. formatPercent and formatQuantity render both as an em dash;
// neither is ever coalesced to 0.
//
// WHAT THIS CARD DELIBERATELY DOES NOT HAVE
//
//   TEEP                  divides by CALENDAR time, which an area does not own in
//                         any sense a reader could name — is it 24 hours, or 24
//                         times the line count? Migration 0024 has no column.
//   Effective Production  the requirement's tile list stops at Finish Good, so
//                         0024 has no column rather than one that ships NULL
//                         forever (contract §23.1).
//   any member count      the requirement names none.
// THE RUN TIME NOTE, PER GRAIN, AND EXPORTED SO IT CAN BE TESTED.
//
// A Radix TooltipContent is NOT IN THE DOM while closed, so a component test
// cannot read the sentence it renders — only that the trigger exists. Which
// sentence is chosen is a pure decision, so it lives as a value and is asserted as
// one: the repo's rule is that a pure choice belongs somewhere a pure test can
// reach, and a component test covers only what a pure function cannot.
//
// THE TWO SENTENCES DIFFER BECAUSE THE MAGNITUDE DOES. A day is line-hours; a month
// is line-hours times ~30, so a five-line month reads ~3,600 h — and a note that
// mentioned only the line count would leave a reader dividing by five and still
// finding 720 hours against a one-month heading.
const RUNTIME_HINT: Record<AreaGrain, string> = {
  day: "Summed across every line in the area, so a multi-line day exceeds 24 hours. An area has no clock of its own.",
  month:
    "Summed across every line in the area AND every day of the month, so a multi-line month runs into the thousands of hours. An area has no clock of its own.",
};

function AreaOverviewCard({ report }: { report: AreaReportDetail }) {
  const { t } = useTranslation("oee");
  // The tile named after the area, exactly as the line card names its tile after
  // the line and the machine card after the work unit. `areaName` is NOT NULL on
  // this table (0024), so there is no fallback branch to write.
  const areaLabel = t("report.machineProduction", { name: report.areaName });

  // ONE LOCAL FOR THE UNIT, which line-overview-card.tsx explicitly forbids itself.
  // The prohibition there is about a subject with TWO count points, where a single
  // local renders cartons under a bag label. An area has one, and 0024's CHECK ties
  // every count to it — so a local here cannot mislabel anything, and repeating the
  // field five times would only invite a reader to wonder which tile has the other
  // unit.
  const unit = report.weightUomName;

  const tiles: MetricSpec[] = [
    { label: t("table.oee"), value: formatPercent(report.oee), valueClassName: "text-primary" },
    {
      label: t("report.a"),
      value: formatPercent(report.availability),
      valueClassName: "text-primary",
    },
    {
      label: t("report.p"),
      value: formatPercent(report.performance),
      valueClassName: "text-primary",
    },
    { label: t("report.q"), value: formatPercent(report.quality), valueClassName: "text-primary" },
    // Not a measurement — see lib/achievement.ts. The muted colour is the only
    // thing on screen distinguishing it from a figure that came from the database.
    {
      label: t("report.achievement"),
      value: ACHIEVEMENT_PLACEHOLDER,
      valueClassName: ACHIEVEMENT_CLASS_NAME,
    },

    // ---- the three production figures, all masses -------------------------
    { label: areaLabel, value: formatQuantity(report.areaOut, unit) },
    { label: t("report.totalProduction"), value: formatQuantity(report.totalOut, unit) },
    {
      label: t("report.finishGood"),
      value: formatQuantity(report.goodOut, unit),
      valueClassName: "text-primary",
    },

    // ---- and the two the Losses card also names ---------------------------
    // ADJACENT AND IN THE SAME UNIT as the three above, which is the whole
    // difference from the line card: there, reading down this column without the
    // per-tile units would suggest 5000 rejects against 789 finished goods. Here
    // the comparison is at least unit-consistent — and still not an identity, for
    // the reason in the header.
    { label: t("report.reject"), value: formatQuantity(report.reject, unit) },
    { label: t("report.rework"), value: formatQuantity(report.rework, unit) },

    {
      label: t("report.runTime"),
      value: formatDuration(report.runtime),
      valueClassName: "text-oee-value-added",
      // THE ONE TILE ON ANY OVERVIEW CARD THAT NEEDS A TOOLTIP, and this is why:
      // every other subject's Run Time is bounded by its own wall clock, so a
      // figure above 24 h on a day report reads as a bug. An area's is summed
      // across its lines and is meant to. The two sentences are RUNTIME_HINT's.
      hint: report.grain === "day" ? t("report.runTimeHintDay") : t("report.runTimeHintMonth"),
    },
  ];

  return (
    <MetricsCard
      title={t("report.areaOverview")}
      collapseLabel="overview"
      tiles={tiles}
      // Eleven tiles rather than the line card's twelve — no Effective Production —
      // so the widest breakpoint still takes six per row over two rows.
      gridClassName="grid grid-cols-2 gap-x-6 gap-y-4 pb-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
    />
  );
}

export { AreaOverviewCard, RUNTIME_HINT };
