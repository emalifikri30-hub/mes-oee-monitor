import { useTranslation } from "react-i18next";

import { EM_DASH, formatBusinessDate, formatMonthLabel } from "@/lib/format";
import { useLineApproval } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { DerivedApprovalBadge, ReportHeaderShell } from "@/components/report/report-header-shell";
import { LineReportActions } from "@/components/report/line-report-actions";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { LineReportDetail } from "@/lib/types";

// Identity strip for a LINE report.
//
// The layout and the derived-count badge are shared with the machine header
// (report-header-shell.tsx). What differs is what a line IS:
//
//   shift   Shift · Date · Line · Status(count of machines)
//   day             Date · Line
//   month           Month · Line
//
// NO DATE IS DERIVED THROUGH A ZONE AT ANY GRAIN, which is the one way this
// header is simpler than the machine one. `businessDate` is a plain 'YYYY-MM-DD'
// the server resolved, and these tables have no `date timestamptz` column at all
// (migration 0014) — so formatReportDate, which takes an INSTANT, has nothing to
// be called on here. Handing it a business date makes `new Date("2026-08-01")`
// read as UTC midnight, which lands on 31 July for any plant west of Greenwich.
//
// `businessDate` IS NON-NULL on this grain, unlike the machine day and month
// reports where 0013 added the column nullable to already-populated tables. 0014
// declared it NOT NULL, so there is no em-dash branch to write.
function LineReportHeader({ report }: { report: LineReportDetail }) {
  const { t } = useTranslation("oee");
  const tiles: MetricSpec[] =
    report.grain === "shift" ? shiftTiles(report, t) : periodTiles(report, t);

  return <ReportHeaderShell tiles={tiles} actions={<LineReportActions report={report} />} />;
}

function shiftTiles(
  report: Extract<LineReportDetail, { grain: "shift" }>,
  t: (key: string) => string,
): MetricSpec[] {
  return [
    { label: t("table.shift"), value: report.shift },
    { label: t("table.date"), value: formatBusinessDate(report.businessDate) },
    // NON-NULL, straight off the Gold row — 0014 declares work_center_name NOT
    // NULL, following the rule 0008 set for work_unit_name: "a Pareto whose rows
    // cannot say which machine they came from is not one."
    { label: t("table.line"), value: report.workCenterName },
    { label: t("table.status"), value: <LineStatus reportId={report.id} /> },
  ];
}

function periodTiles(
  report: Extract<LineReportDetail, { grain: "day" | "month" }>,
  t: (key: string) => string,
): MetricSpec[] {
  return [
    {
      label: report.grain === "day" ? t("table.date") : t("common.month"),
      value:
        report.grain === "day"
          ? formatBusinessDate(report.businessDate)
          : formatMonthLabel(report.businessDate),
    },
    { label: t("table.line"), value: report.workCenterName },
    // NO STATUS TILE AT THE COARSE GRAINS, and no Approve button either. A line
    // day would be a cascade over three shifts as well as N machines — the
    // question TODOS §48 holds. Rendering a count here would state a fact about
    // ~3N other records that nobody asked for and nobody can act on.
  ];
}

// A COUNT OF OTHER RECORDS, NEVER A SIGNATURE.
//
// There is no line approval row and there cannot be one:
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift) and
// the work_center_* tables have no work_unit_id column at all. So "this line is
// approved" means "every machine shift report on it is closed", and the tile shows
// the fraction — the same treatment, from the same component, that the machine DAY
// header gives "2 of 3 shifts approved".
//
// ITS OWN SUBSCRIPTION rather than a field on the report payload, because the
// server runs two COUNT queries over the machine reports and their approvals to
// answer, and the route loader AWAITS the report while only prefetching this. So
// the tile arrives a beat after the rest of the header rather than delaying it.
//
// THE DISAGREEMENT ARM IS THE INTERESTING ONE. `machinesFound` is the machine shift
// reports that name THIS line for this date and shift; `workUnitCount` is what the
// pipeline wrote on the line row as having reported into it. Both come from the
// pipeline, so a disagreement is the pipeline disagreeing with ITSELF — and a
// fraction over the wrong denominator is a wrong answer rather than a smaller one.
// The tile abstains and names both numbers, which is the same call
// ck_wcsr_infeed_units makes for a count whose unit is unknown.
function LineStatus({ reportId }: { reportId: number }) {
  const { t } = useTranslation("oee");
  const { data } = useLineApproval(reportId);

  // Not a skeleton: the prefetch is unawaited, so this is the first paint of a
  // normal page load rather than an error state. An em dash says "not yet" without
  // moving the layout when it resolves.
  if (data === undefined) {
    return <span className="text-muted-foreground">{EM_DASH}</span>;
  }

  if (data.machinesFound !== data.workUnitCount) {
    return (
      <Badge
        variant="outline"
        className="font-normal"
        title={t("report.countsDisagreeTitle", {
          expected: data.workUnitCount,
          found: data.machinesFound,
        })}
      >
        {t("report.countsDisagree")}
      </Badge>
    );
  }

  return (
    <DerivedApprovalBadge
      total={data.machinesFound}
      closed={data.machinesClosed}
      noun={t("common.machines")}
      emptyLabel={t("table.noMachineReports")}
    />
  );
}

export { LineReportHeader };
