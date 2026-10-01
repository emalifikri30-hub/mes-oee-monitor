import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatPercent, formatReportDate } from "@/lib/format";
import { useShiftReports } from "@/lib/queries";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/table/data-table";
import { NUMERIC } from "@/components/report/report-list-columns";
import { TablePagination } from "@/components/table/table-pagination";
import { indexColumn } from "@/components/table/index-column";
import {
  ALL,
  HideZeroCheckbox,
  LineFilter,
  MonthFilter,
  ShiftFilter,
  YearFilter,
} from "@/components/report/report-list-filters";
import { ReportListFilterBar, ReportListShell } from "@/components/report/report-list-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { ColumnDef } from "@tanstack/react-table";
import type { MachineShiftSearch } from "@/lib/shift-search";
import type { ShiftReportListItem } from "@/lib/types";

// The By Shift list screen.
//
// LIFTED OUT OF routes/_app/report/machine/by-shift.tsx, where it was the route's
// component body, so it can be rendered in a test without mounting a route. The
// route keeps what belongs to a URL: validateSearch, the breadcrumb, and the
// navigation callbacks.
//
// HOW THIS DIFFERS FROM PeriodReportTable AND LineReportTable, and each is a
// decision rather than an omission:
//
//   Shift filter + column   there IS a shift at this grain.
//   Status filter + column  oee.work_unit_shift_report_approvals is keyed
//                           (work_unit_id, date, shift), so a MACHINE shift
//                           report is the only thing in this app that has an
//                           approval to show or filter on.
//   Machine column          the rows are machines. A Line row has none.

// The two approval states, and the labels are deliberately not "Open" / "Closed".
// A supervisor reading this list is asking "what still needs signing off", and
// `closed` is a state name rather than an answer to that.
type ShiftReportTableProps = {
  search: MachineShiftSearch;
  // Applies a filter change AND resets to page 1 — page 7 of the old result set
  // is rarely page 7 of the new one, and is often past the end.
  onFilter: (patch: Partial<MachineShiftSearch>) => void;
  onPageChange: (page: number) => void;
};

function ShiftReportTable({ search, onFilter, onPageChange }: ShiftReportTableProps) {
  const { t } = useTranslation("oee");
  const statuses = [
    { value: "open" as const, label: t("table.needsApproval") },
    { value: "closed" as const, label: t("table.approved") },
  ];
  const columns = useMemo(() => shiftColumns(t), [t]);
  // `areaId` COMES OUT OF THE SAME HOOK AS THE LINE OPTIONS, and it is now part
  // of the REQUEST rather than only of the cascade above it. The header picker
  // scopes every report list; see hooks/use-work-center-filter.ts for why the two
  // returned ids are not interchangeable, and why an undefined area must NOT gate
  // the query — core-api reads an absent `areaId` as every area, so the first
  // paint shows data and narrows a tick later instead of flashing a skeleton.
  const { options: workCenters, workCenterId, areaId } = useWorkCenterFilter(search.workCenterId);

  const { data, isPending, isError } = useShiftReports({
    page: search.page,
    size: search.size,
    month: search.month,
    year: search.year,
    shift: search.shift,
    workCenterId,
    areaId,
    hideZero: search.hideZero,
    status: search.status,
  });

  const tableMeta = useMemo(
    () => ({ page: search.page, size: search.size }),
    [search.page, search.size],
  );

  return (
    <ReportListShell>
      <ReportListFilterBar
        left={
          <>
            <MonthFilter value={search.month} onChange={(month) => onFilter({ month })} />
            <YearFilter value={search.year} onChange={(year) => onFilter({ year })} />
          </>
        }
        right={
          <>
            <ShiftFilter value={search.shift} onChange={(shift) => onFilter({ shift })} />
            <LineFilter
              options={workCenters}
              value={workCenterId}
              onChange={(id) => onFilter({ workCenterId: id })}
            />

            {/* Beside the shift and line filters rather than with month/year: those
                two choose WHICH shifts, and these three narrow the set. Kept inline
                rather than extracted alongside the others — it has exactly one
                caller and no prospect of a second, because no other grain and no
                other dimension has an approval to filter on. */}
            <Select
              value={search.status ?? ALL}
              onValueChange={(v) =>
                onFilter({ status: v === ALL ? undefined : (v as "open" | "closed") })
              }
            >
              <SelectTrigger className="w-44" aria-label={t("table.approvalStatus")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("table.allStatuses")}</SelectItem>
                {statuses.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <HideZeroCheckbox
              id="hide-zero-shift"
              checked={search.hideZero}
              onChange={(hideZero) => onFilter({ hideZero })}
            />
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(row) => String(row.id)}
        isPending={isPending}
        isError={isError}
        errorMessage={t("table.loadShiftReports")}
        emptyMessage={t("table.noShiftReports")}
        skeletonRows={search.size}
        meta={tableMeta}
      />

      <TablePagination
        page={search.page}
        size={search.size}
        meta={data?.meta}
        onPageChange={onPageChange}
        onSizeChange={(size) => onFilter({ size })}
      />
    </ReportListShell>
  );
}

// Plain ColumnDef objects reading `row.original`, rather than createColumnHelper:
// a helper array mixes ColumnDef<T, string> with ColumnDef<T, number>, and that
// union does not assign to the single ColumnDef<T, unknown>[] the table takes.
function shiftColumns(
  t: (key: string, opts?: { id: number }) => string,
): ColumnDef<ShiftReportListItem, unknown>[] {
  return [
    indexColumn<ShiftReportListItem>(),
    {
      id: "date",
      header: t("table.date"),
      // `date` is the shift's start instant, so the calendar day it belongs to depends
      // on the plant's zone — which arrives per row and can be null if master-data was
      // unreachable, in which case this renders a dash rather than a guessed day.
      cell: ({ row }) => formatReportDate(row.original.date, row.original.timeZone),
    },
    { id: "shift", header: t("table.shift"), cell: ({ row }) => row.original.shift },
    // Both labels come from master-data enrichment, which the API lets degrade to
    // null rather than failing the whole page.
    {
      id: "line",
      header: t("table.line"),
      cell: ({ row }) => row.original.workCenter?.name ?? EM_DASH,
    },
    {
      id: "machine",
      header: t("table.machine"),
      cell: ({ row }) => row.original.workUnit?.name ?? EM_DASH,
    },
    {
      id: "oee",
      header: t("table.oee"),
      cell: ({ row }) => formatPercent(row.original.oee),
      meta: NUMERIC,
    },
    {
      id: "availability",
      header: t("table.availability"),
      cell: ({ row }) => formatPercent(row.original.availability),
      meta: NUMERIC,
    },
    {
      id: "performance",
      header: t("table.performance"),
      cell: ({ row }) => formatPercent(row.original.performance),
      meta: NUMERIC,
    },
    {
      id: "quality",
      header: t("table.quality"),
      cell: ({ row }) => formatPercent(row.original.quality),
      meta: NUMERIC,
    },
    {
      id: "status",
      header: t("table.status"),
      // Sits AFTER the measures and before the action, so the eye is read as
      // "these are the numbers, this is their state, here is the report".
      //
      // Reaches the row through a second query the service merges in — see
      // listApprovalsForPage — so `status` is never absent even though it is not a
      // column on oee.work_unit_shift_reports.
      cell: ({ row }) =>
        row.original.status === "closed" ? (
          <Badge variant="secondary" className="font-normal">
            {t("common.closed")}
          </Badge>
        ) : (
          <Badge variant="outline" className="font-normal">
            {t("common.open")}
          </Badge>
        ),
    },
    {
      id: "action",
      header: t("table.action"),
      cell: ({ row }) => (
        <Link
          to="/report/machine/by-shift/$reportId"
          params={{ reportId: String(row.original.id) }}
          className="text-muted-foreground hover:text-foreground inline-flex transition-colors"
          aria-label={t("report.viewReport", { id: row.original.id })}
        >
          <EyeIcon className="size-4" />
        </Link>
      ),
      meta: { headerClassName: "w-20", cellClassName: "w-20" },
    },
  ];
}

export { ShiftReportTable };
