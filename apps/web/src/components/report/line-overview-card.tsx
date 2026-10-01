import { useTranslation } from "react-i18next";

import { ACHIEVEMENT_CLASS_NAME, ACHIEVEMENT_PLACEHOLDER } from "@/lib/achievement";
import { formatDuration, formatPercent, formatQuantity } from "@/lib/format";
import { MetricsCard } from "@/components/report/metrics-card";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { LineReportDetail } from "@/lib/types";

// The LINE's headline figures. Same collapsible grid as the machine's Summary OEE
// (metrics-card.tsx); what is different is which figures exist, and in what.
//
// ─────────────────────────────────────────────────────────────────────────────
//  A LINE HAS TWO COUNT POINTS, AND THEY ARE USUALLY IN DIFFERENT UNITS
// ─────────────────────────────────────────────────────────────────────────────
//
//        INFEED side  (infeedUom*)              OUTPUT side  (outputUom*)
//        what the line CONSUMED                 what the line SHIPPED
//     ┌──────────────────────────────┐       ┌──────────────────────────────┐
//     │ Total Production   totalOut  │       │ Effective Prod. effectiveOut │
//     │ <Line> Production  lineOut   │       │ Finish Good     goodOut      │
//     │ Reject             reject    │       │                              │
//     │ Rework             rework    │       │                              │
//     └──────────────────────────────┘       └──────────────────────────────┘
//              e.g. BAG                                e.g. CARTON
//
// `totalOut = goodOut + reject + rework` IS FALSE HERE, by construction rather
// than by defect (migration 0014's header, contract §16.4a). 100 bags in yielding
// 10 cartons out is not a 90% loss. NOTHING ON THIS CARD MAY COMPUTE ACROSS THE
// TWO SIDES, and nothing does — every tile is one column with its own unit label.
//
// THAT IS WHY THE UNIT TRAVELS WITH EVERY TILE rather than being read once into a
// local. A single `uom` variable here is the whole bug: it would render cartons
// under a bag label, which is a wrong number that looks completely ordinary. The
// machine card can hold one unit because a work unit has one count point; this one
// cannot, and the shared shell formats nothing precisely so the pairing stays in
// this file beside the figures it describes.
//
// EVERY RATE AND EVERY COUNT IS NULLABLE at this grain, unlike the machine's. 0/0
// is real for a line whose machines were all in planned downtime, and a NULL count
// means "the members disagreed" — the unit is nulled WITH its figures, because
// `500 BAG + 12 CARTON = 512 <blank>` is a wrong number with a missing label
// rather than a smaller truth. formatPercent and formatQuantity render both as an
// em dash; neither is ever coalesced to 0.
//

function LineOverviewCard({ report }: { report: LineReportDetail }) {
  const { t } = useTranslation("oee");
  // The tile named after the line, exactly as the machine card names its tile
  // after the work unit. `workCenterName` is NOT NULL on these tables (0014), so
  // there is no fallback branch to write.
  const lineLabel = t("report.machineProduction", { name: report.workCenterName });

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
    // Not TEEP-adjacent and not a measurement — see ACHIEVEMENT_PLACEHOLDER. The
    // muted colour is the only thing on screen distinguishing it from a figure
    // that came from the database.
    {
      label: t("report.achievement"),
      value: ACHIEVEMENT_PLACEHOLDER,
      valueClassName: ACHIEVEMENT_CLASS_NAME,
    },

    // ---- infeed side: the unit the line CONSUMED in --------------------------
    { label: lineLabel, value: formatQuantity(report.lineOut, report.infeedUomName) },
    {
      label: t("report.totalProduction"),
      value: formatQuantity(report.totalOut, report.infeedUomName),
    },

    // ---- output side: the unit the line SHIPPED in ---------------------------
    {
      label: t("report.effectiveProduction"),
      value: formatQuantity(report.effectiveOut, report.outputUomName),
    },
    {
      label: t("report.finishGood"),
      value: formatQuantity(report.goodOut, report.outputUomName),
      valueClassName: "text-primary",
    },

    // ---- back to the infeed side --------------------------------------------
    // Adjacent to the two output tiles above and in a DIFFERENT unit, which is
    // exactly why each label carries its own. Reading down this column without the
    // units would suggest 5000 rejects against 789 finished goods.
    { label: t("report.reject"), value: formatQuantity(report.reject, report.infeedUomName) },
    { label: t("report.rework"), value: formatQuantity(report.rework, report.infeedUomName) },

    {
      label: t("report.runTime"),
      value: formatDuration(report.runtime),
      valueClassName: "text-oee-value-added",
    },
  ];

  return (
    <MetricsCard
      title={t("report.lineOverview")}
      collapseLabel="overview"
      tiles={tiles}
      // Twelve tiles rather than the machine card's nine, so the widest breakpoint
      // takes six per row over two rows instead of trying to fit them all.
      gridClassName="grid grid-cols-2 gap-x-6 gap-y-4 pb-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
    />
  );
}

export { LineOverviewCard };
