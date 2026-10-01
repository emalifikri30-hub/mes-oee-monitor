import { useTranslation } from "react-i18next";

import { formatDuration, formatPercent, formatQuantity } from "@/lib/format";
import { MetricsCard } from "@/components/report/metrics-card";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { ReportDetail } from "@/lib/types";

// The MACHINE's headline figures. OEE = A x P x Q; TEEP additionally charges the
// shift for calendar time it never scheduled, which is why it sits well below OEE.
//
// The card chrome — the collapsible, the grid, the tiles — moved to
// metrics-card.tsx when the Line detail screen needed the same shell. What stays
// here is the only part that is about a machine: WHICH nine figures, and which
// unit each one carries.
//
// ALL THREE COUNTS SHARE `uomName`, and that is true of a machine and ONLY of a
// machine. A work unit has one count point, so one unit covers what it made, what
// was good and what was effective. A line has two (migration 0014) — it consumes
// bags and ships cartons — which is why line-overview-card.tsx builds its own
// tiles rather than passing a different report through this function.
function SummaryOeeCard({ report }: { report: ReportDetail }) {
  const { t } = useTranslation("oee");
  const machine = report.workUnitName
    ? t("report.machineProduction", { name: report.workUnitName })
    : t("report.production");

  const tiles: MetricSpec[] = [
    { label: t("report.teep"), value: formatPercent(report.teep), valueClassName: "text-primary" },
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
    { label: machine, value: formatQuantity(report.totalOut, report.uomName) },
    { label: t("report.finishGood"), value: formatQuantity(report.goodOut, report.uomName) },
    {
      label: t("report.effectiveProd"),
      value: formatQuantity(report.effectiveOut, report.uomName),
    },
    {
      label: t("report.runTime"),
      value: formatDuration(report.runtime),
      valueClassName: "text-oee-value-added",
    },
  ];

  return (
    <MetricsCard
      title={t("report.summaryOee")}
      collapseLabel="summary"
      tiles={tiles}
      gridClassName="grid grid-cols-2 gap-x-6 gap-y-4 pb-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9"
    />
  );
}

export { SummaryOeeCard };
