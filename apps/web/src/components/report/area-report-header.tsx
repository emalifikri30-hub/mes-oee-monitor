import { useTranslation } from "react-i18next";

import { formatBusinessDate, formatMonthLabel } from "@/lib/format";
import { AreaReportActions } from "@/components/report/area-report-actions";
import { ReportHeaderShell } from "@/components/report/report-header-shell";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { AreaReportDetail } from "@/lib/types";

// The AREA report's header strip.
//
// TWO TILES, WHICH IS THE FEWEST OF ANY REPORT SCREEN, and that is the grain rather
// than an omission: an area report is uniquely identified by its PERIOD and its
// AREA, and nothing else. A SKU report needs three because the same SKU on the same
// date produces one row per line it ran on; a machine shift report needs a shift.
//
// THE FIRST TILE CHANGES ITS LABEL *AND* ITS FORMATTER WITH THE GRAIN, which is the
// line header's shape one subject over. `businessDate` at month grain is the FIRST
// DAY of the month (`ck_amr_month_start`, 0025), so `formatBusinessDate` would print
// "01/09/2026" under a heading that says Month — the right-looking wrong thing, and
// the one a reader would take as the report covering a single day.
//
// The area is named by CODE as well as name, because a denormalised name is not
// unique — the dev world carried two lines called 'Line 1' for months (TODOS.md
// §77) — and a report whose subject IS the area cannot identify one by a label that
// can repeat. The code is nullable, so the separator goes with it rather than
// leaving a trailing dot.
//
// NO STATUS TILE. oee.work_unit_shift_report_approvals is keyed
// (work_unit_id, date, shift); an area day has neither, and unlike the line day
// header — which at least has child reports it could count and declines to
// (TODOS §48) — there is no cascade defined at this grain at all. See
// area-report-actions.tsx.
//
// THE ACTIONS ARE A "…" MENU, per the requirement, and that is a different call
// from the SKU header's single button. Both reasons are in area-report-actions.tsx.
function AreaReportHeader({ report }: { report: AreaReportDetail }) {
  const { t } = useTranslation("oee");
  const tiles: MetricSpec[] = [
    // NEVER formatReportDate, at EITHER grain: `businessDate` is already
    // plant-local and zone-free (0024, 0025), and that formatter takes an INSTANT
    // — it would read this as UTC midnight and print the previous day for any
    // plant west of Greenwich. Both formatters below build no zoned Date at all.
    {
      label: report.grain === "day" ? t("table.date") : t("common.month"),
      value:
        report.grain === "day"
          ? formatBusinessDate(report.businessDate)
          : formatMonthLabel(report.businessDate),
    },
    {
      label: t("area.label"),
      value: report.areaCode ? `${report.areaName} · ${report.areaCode}` : report.areaName,
    },
  ];

  return <ReportHeaderShell tiles={tiles} actions={<AreaReportActions report={report} />} />;
}

export { AreaReportHeader };
