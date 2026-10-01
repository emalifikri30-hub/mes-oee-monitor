import { useTranslation } from "react-i18next";

import { formatBusinessDate } from "@/lib/format";
import { ReportHeaderShell } from "@/components/report/report-header-shell";
import { SkuReportActions } from "@/components/report/sku-report-actions";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { SkuReportDetail } from "@/lib/types";

// The SKU report's header strip.
//
// THREE TILES, AND THE THIRD IS THE ONE THAT MATTERS. A SKU report is one of
// several for the same date — one per line the SKU ran on — so DATE and SKU alone
// do not identify it. The line does, and it is named by code as well as name
// because work_center_name is not unique (TODOS.md §77).
//
// NO STATUS TILE. oee.work_unit_shift_report_approvals is keyed
// (work_unit_id, date, shift); this grain has neither a work unit nor a shift, so
// there is nothing to sign and nothing to derive a badge from. That is a stronger
// absence than the line day header's, which at least has child reports it could
// count — it declines to (TODOS §48). Here there is nothing to count.
//
// ONE ACTION, AND IT IS A BUTTON. `actions` was null while this screen had nothing
// live to offer: the "…" menu's only item is Download, which downloads nothing on
// any of the six other screens (TODOS.md §67), and a seventh copy of a placeholder
// would make the feature look more shipped than it is. That argument is unchanged
// and Download is still absent. What arrived is Log Activity — see
// sku-report-actions.tsx for why one live action gets a button rather than a
// dropdown of one.
function SkuReportHeader({ report }: { report: SkuReportDetail }) {
  const { t } = useTranslation("oee");
  const tiles: MetricSpec[] = [
    // NEVER formatReportDate: `businessDate` is already plant-local and zone-free
    // (0023), and that formatter takes an INSTANT — it would read this as UTC
    // midnight and print the previous day for any plant west of Greenwich.
    { label: t("table.date"), value: formatBusinessDate(report.businessDate) },
    { label: t("common.sku"), value: `${report.productName} · ${report.productCode}` },
    {
      label: t("table.line"),
      value: report.workCenterCode
        ? `${report.workCenterName} · ${report.workCenterCode}`
        : report.workCenterName,
    },
  ];

  return <ReportHeaderShell tiles={tiles} actions={<SkuReportActions report={report} />} />;
}

export { SkuReportHeader };
