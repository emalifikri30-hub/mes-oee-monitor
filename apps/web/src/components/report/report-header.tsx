import { CheckIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  EM_DASH,
  formatBusinessDate,
  formatDateTime,
  formatMonthLabel,
  formatReportDate,
} from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { DerivedApprovalBadge, ReportHeaderShell } from "@/components/report/report-header-shell";
import { ReportActions } from "@/components/report/report-actions";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { PeriodReportDetail, ReportDetail, ShiftReportDetail } from "@/lib/types";

// Identity strip for a MACHINE report.
//
// The layout and the derived-count badge moved to report-header-shell.tsx when
// the Line screen needed both. What stays here is which tiles a machine gets, and
// the Open/Closed badge — which is machine-only, because it renders a real row in
// oee.work_unit_shift_report_approvals and a line has no such row.
//
// The actions live in report-actions.tsx — see that file for why Download opens a
// dialog while Regenerate and Adjust calculation stay disabled.
//
// THREE GRAINS, THREE DIFFERENT LEFT-HAND SIDES, and the differences are the
// design's rather than incidental:
//
//   shift   Shift · Date · Machine · Status(badge)
//   day             Date · Machine · Status(count)
//   month           Month · Machine
//
// Written as a branch per grain rather than a pile of `grain === "shift" &&`
// conditionals inside one tile list. The three layouts are short, and a reader
// asking "what does the month header show" gets an answer in four lines instead
// of having to evaluate five predicates in their head.
function ReportHeader({ report }: { report: ReportDetail }) {
  const { t } = useTranslation("oee");
  const tiles = report.grain === "shift" ? shiftTiles(report, t) : periodTiles(report, t);

  return <ReportHeaderShell tiles={tiles} actions={<ReportActions report={report} />} />;
}

function shiftTiles(report: ShiftReportDetail, t: (key: string) => string): MetricSpec[] {
  return [
    { label: t("table.shift"), value: report.shift },
    // The plant's zone, not the browser's and not UTC: `date` is the instant
    // the shift began, so the calendar day depends on where the plant is.
    { label: t("table.date"), value: formatReportDate(report.date, report.timeZone) },
    { label: t("report.machineName"), value: report.workUnitName ?? EM_DASH },
    { label: t("table.status"), value: <StatusBadge report={report} /> },
  ];
}

// NOTHING IS DERIVED THROUGH A ZONE HERE, unlike the shift tiles above.
// `businessDate` is a plain 'YYYY-MM-DD' the server already resolved (migration
// 0013), so both labels are formatted from a date rather than from an instant.
//
// The month label comes from `businessDate` too, NOT from the `month` column
// that sits right beside it on the row. That column's format is unspecified
// upstream — gold-write-contract §15.7 asks the pipeline owner to settle it —
// so rendering it would put whatever a DAG happens to write in front of a
// supervisor.
function periodTiles(report: PeriodReportDetail, t: (key: string) => string): MetricSpec[] {
  const label = report.grain === "day" ? t("table.date") : t("common.month");
  const value =
    report.businessDate === null
      ? EM_DASH
      : report.grain === "day"
        ? // formatBusinessDate, NOT formatReportDate — see format.ts. That one
          // takes an instant and converts it into a zone; handing it a business
          // date makes `new Date` read '2026-08-01' as UTC midnight, which lands
          // on 31 July for any plant west of Greenwich.
          formatBusinessDate(report.businessDate)
        : formatMonthLabel(report.businessDate);

  const tiles: MetricSpec[] = [
    { label, value },
    { label: t("report.machineName"), value: report.workUnitName ?? EM_DASH },
  ];

  // MONTH HAS NO STATUS TILE AT ALL. A month spans ~90 shifts, and "58 of 90
  // shifts approved" is not a fact anybody acts on. The API returns
  // `approval: null` at that grain, so this is the payload's decision rendered
  // rather than a second one taken here.
  if (report.approval !== null) {
    tiles.push({
      label: t("table.status"),
      value: (
        <DerivedApprovalBadge
          total={report.approval.shiftsTotal}
          closed={report.approval.shiftsClosed}
          noun={t("common.shifts")}
          emptyLabel={t("table.noShiftReportsShort")}
        />
      ),
    });
  }

  return tiles;
}

// THE MACHINE SHIFT REPORT'S REAL APPROVAL, and the only badge in this app backed
// by an actual row. Open is `outline` and closed is `secondary`, both deliberately
// quiet.
//
// An open report is the normal state of nearly every row in the database, so a
// coloured badge would put an alarm on the unremarkable case. `default` would
// paint it in the brand rose, which on this page reads as "act on me" — the
// Approve button beside it already says that.
function StatusBadge({ report }: { report: ShiftReportDetail }) {
  const { t } = useTranslation("oee");
  const { status, closedAt, closedByName, closedBy } = report.approval;

  if (status === "open") {
    return (
      <Badge variant="outline" className="font-normal">
        {t("common.open")}
      </Badge>
    );
  }

  // `closedByName` is a display label captured at approval time and may be
  // absent; `closedBy` is the durable Keycloak subject and is always there for an
  // operator close. Falling back to it beats rendering "approved by undefined",
  // and a system close (the deferred auto-close) has neither.
  const who = closedByName ?? closedBy;

  return (
    <Badge
      variant="secondary"
      className="font-normal"
      title={
        closedAt === null
          ? undefined
          : who === null
            ? t("report.approvedAutomatically", {
                when: formatDateTime(closedAt, report.timeZone),
              })
            : t("report.approvedBy", {
                who,
                when: formatDateTime(closedAt, report.timeZone),
              })
      }
    >
      <CheckIcon />
      {t("common.closed")}
    </Badge>
  );
}

export { ReportHeader };
