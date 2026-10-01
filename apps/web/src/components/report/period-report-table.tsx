import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatBusinessDate, formatMonthLabel, formatPercent } from "@/lib/format";
import { usePeriodReports } from "@/lib/queries";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { DataTable } from "@/components/table/data-table";
import { NUMERIC } from "@/components/report/report-list-columns";
import { TablePagination } from "@/components/table/table-pagination";
import { indexColumn } from "@/components/table/index-column";
import {
  HideZeroCheckbox,
  LineFilter,
  MonthFilter,
  YearFilter,
} from "@/components/report/report-list-filters";
import { ReportListFilterBar, ReportListShell } from "@/components/report/report-list-shell";

import type { ColumnDef } from "@tanstack/react-table";
import type { PeriodReportListItem } from "@/lib/types";
import type { PeriodSearch } from "@/lib/period-search";

// The By Day and By Monthly list screens, which are the same screen twice.
//
// WHY ONE COMPONENT AND NOT TWO ROUTE FILES WITH THE SAME 300 LINES
//
// The two lists differ in exactly three things: which grain they request, what
// the first column is called and how it is formatted, and where the eye icon
// goes. Everything else — the filter bar, the five measure columns, the paging,
// the empty and error states — is identical. Cloning by-shift.tsx twice would
// have put three copies of that in the repository, and the next fix would have
// been applied to one or two of them.
//
// The routes still own `validateSearch`, because TanStack requires it there and
// because the URL contract belongs to the URL's owner. They hand the validated
// object down.
//
// The filter bar, the ETL banner, the "#" column and the Area -> Line cascade are
// no longer here: they moved to report-list-shell.tsx, report-list-filters.tsx,
// table/index-column.tsx and hooks/use-work-center-filter.ts once a third list
// screen needed them.
//
// HOW THIS DIFFERS FROM THE BY SHIFT LIST, and both are decisions:
//
//   no Shift filter    There is no shift at these grains.
//   no Status column   There is no day or month approval to show. The DETAIL
//                      screen derives a count of the child shift reports; doing
//                      that per row here would be one window query per row, and
//                      a column that says "2 of 3" on thirty rows is noise
//                      rather than an answer.
//
// The month/year filter stays for BOTH grains and means the same thing in each:
// it filters `business_date`, which is the day itself at day grain and the first
// of the month at month grain. So By Monthly with August selected shows August's
// month reports, one per machine.

type PeriodReportTableProps = {
  grain: "day" | "month";
  search: PeriodSearch;
  // Applies a filter change AND resets to page 1 — page 7 of the old result set
  // is rarely page 7 of the new one, and is often past the end.
  onFilter: (patch: Partial<PeriodSearch>) => void;
  onPageChange: (page: number) => void;
  // Typed as the route literal by the caller, so a renamed route breaks the
  // build rather than producing a dead link.
  detailTo: "/report/machine/by-day/$reportId" | "/report/machine/by-monthly/$reportId";
};

function PeriodReportTable({
  grain,
  search,
  onFilter,
  onPageChange,
  detailTo,
}: PeriodReportTableProps) {
  const { t } = useTranslation("oee");
  // `areaId` COMES OUT OF THE SAME HOOK AS THE LINE OPTIONS, and it is now part
  // of the REQUEST rather than only of the cascade above it. The header picker
  // scopes every report list; see hooks/use-work-center-filter.ts for why the two
  // returned ids are not interchangeable, and why an undefined area must NOT gate
  // the query — core-api reads an absent `areaId` as every area, so the first
  // paint shows data and narrows a tick later instead of flashing a skeleton.
  const { options: workCenters, workCenterId, areaId } = useWorkCenterFilter(search.workCenterId);

  const { data, isPending, isError } = usePeriodReports(grain, {
    page: search.page,
    size: search.size,
    month: search.month,
    year: search.year,
    workCenterId,
    areaId,
    hideZero: search.hideZero,
  });

  const columns = useMemo(() => buildColumns(t, grain, detailTo), [t, grain, detailTo]);

  const tableMeta = useMemo(
    () => ({ page: search.page, size: search.size }),
    [search.page, search.size],
  );

  const noun = t(grain === "day" ? "report.grainDay" : "report.grainMonth");

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
            <LineFilter
              options={workCenters}
              value={workCenterId}
              onChange={(id) => onFilter({ workCenterId: id })}
            />
            <HideZeroCheckbox
              id={`hide-zero-${grain}`}
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
        errorMessage={t("table.loadReports", { noun })}
        emptyMessage={t("table.noReports", { noun })}
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
function buildColumns(
  t: (key: string, opts?: Record<string, string | number>) => string,
  grain: "day" | "month",
  detailTo: PeriodReportTableProps["detailTo"],
): ColumnDef<PeriodReportListItem, unknown>[] {
  return [
    indexColumn<PeriodReportListItem>(),
    {
      id: "period",
      header: grain === "day" ? t("table.date") : t("table.month"),
      // NO ZONE CONVERSION. `businessDate` is a plain 'YYYY-MM-DD' the server
      // already resolved in the plant's zone — unlike the By Shift list, whose
      // `date` is a shift-start instant and needs one. Using formatReportDate
      // here would read the string as UTC midnight and render the previous day
      // for any plant west of Greenwich. See lib/format.ts.
      cell: ({ row }) =>
        grain === "day"
          ? formatBusinessDate(row.original.businessDate)
          : formatMonthLabel(row.original.businessDate),
    },
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
      id: "action",
      header: t("table.action"),
      cell: ({ row }) => (
        <Link
          to={detailTo}
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

export { PeriodReportTable };
