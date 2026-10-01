import { useTranslation } from "react-i18next";

import { ACHIEVEMENT_CLASS_NAME, ACHIEVEMENT_PLACEHOLDER } from "@/lib/achievement";
import { formatDuration, formatPercent, formatQuantity } from "@/lib/format";
import { MetricsCard } from "@/components/report/metrics-card";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { SkuReportDetail } from "@/lib/types";

// One SKU's headline figures, on one line, for one business day.
//
// THE TWO-UNIT RULE IS THE LINE'S, UNCHANGED — see line-overview-card.tsx for the
// diagram. A SKU inherits its line's two count points, so `totalOut` is in the
// INFEED unit and `goodOut` in the OUTPUT one, and
// `totalOut = goodOut + reject + rework` is FALSE here exactly as it is there
// (migration 0023, contract §16.4a). Every tile carries its own unit for that
// reason; a single `uom` local would render cartons under a bag label.
//
// WHAT THIS CARD HAS THAT THE LINE'S DOES NOT
//
// The SKU and the line, named together. A SKU report is one of several for the
// same date, distinguished only by which line ran it, so the line has to be on the
// card rather than only in the breadcrumb.
//
// WHAT IT DELIBERATELY DOES NOT HAVE
//
//   TEEP    divides by CALENDAR time, which a SKU does not own — the line does,
//           and shares it with every other SKU that ran that day. There is no
//           denominator anybody could name, so migration 0023 has no column and
//           this card has no tile. `oee` stays: it divides by the SKU's own
//           loading time.
//   Machine anything. A SKU ran on ONE line; there is no member count and no
//           "4 of 5 machines" badge to derive.
function SkuOverviewCard({ report }: { report: SkuReportDetail }) {
  const { t } = useTranslation("oee");
  // The line's name AND code. `workCenterName` is not unique — the dev world has
  // carried two lines called 'Line 1' for months (TODOS.md §77) — and this report
  // exists to say WHICH line, so a label that can repeat is not enough on its own.
  // The code is nullable, so the separator goes with it rather than leaving a
  // trailing dot.
  const lineLabel = report.workCenterCode
    ? `${report.workCenterName} · ${report.workCenterCode}`
    : report.workCenterName;

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

    { label: t("table.line"), value: lineLabel },

    // ---- infeed side: the unit the line CONSUMED in --------------------------
    {
      label: t("report.machineProduction", { name: report.workCenterName }),
      value: formatQuantity(report.lineOut, report.infeedUomName),
    },
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
    // exactly why each label carries its own.
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
      title={t("report.skuOverview")}
      collapseLabel="overview"
      tiles={tiles}
      gridClassName="grid grid-cols-2 gap-x-6 gap-y-4 pb-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
    />
  );
}

export { SkuOverviewCard };
