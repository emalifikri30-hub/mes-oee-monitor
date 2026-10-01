import { EyeIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatBusinessDate, formatPercent } from "@/lib/format";
import { useSkuReports } from "@/lib/queries";
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
import type { PeriodSearch } from "@/lib/period-search";
import type { SkuReportListItem } from "@/lib/types";

// The SKU By Day list.
//
// ONE GRAIN, so no `grain` prop and no branching inside. The line table takes
// three and the machine coarse table two; this takes none, because
// oee.product_report_wc_day is the only table (0023).
//
// THE LINE COLUMN IS NOT DECORATION — IT IS THE SECOND HALF OF THE KEY.
//
// A row here is (business date, SKU, LINE). The same SKU on the same date
// produces one row per line it ran on, and those rows carry DIFFERENT numbers
// because a line is measured at its own count points. Without the Line column the
// list reads as duplicated rows:
//
//     Date         SKU     OEE
//     2026-08-19   SKU A   84.3%     <- which line?
//     2026-08-19   SKU A   82.1%     <- and why twice?
//
// So it renders the name AND the code. work_center_name is not unique — the dev
// world carried two lines called 'Line 1' for months (TODOS.md §77) — and a screen
// whose whole point is WHICH line cannot identify one by a label that repeats.
//
// WHAT IT DOES NOT HAVE, and each absence is the schema's rather than a choice:
//
//   no Shift filter     one grain, and a day report spans all three.
//   no Status column    oee.work_unit_shift_report_approvals is keyed
//                       (work_unit_id, date, shift); this grain has neither, so
//                       there is nothing to correlate and nothing to derive.
//   no Machines column  a SKU ran on ONE line. There is no member count.
type SkuReportTableProps = {
  search: PeriodSearch;
  onFilter: (patch: Partial<PeriodSearch>) => void;
  onPageChange: (page: number) => void;
};

function SkuReportTable({ search, onFilter, onPageChange }: SkuReportTableProps) {
  const { t } = useTranslation("oee");
  // `areaId` COMES OUT OF THE SAME HOOK AS THE LINE OPTIONS, and it is now part
  // of the REQUEST rather than only of the cascade above it. The header picker
  // scopes every report list; see hooks/use-work-center-filter.ts for why the two
  // returned ids are not interchangeable, and why an undefined area must NOT gate
  // the query — core-api reads an absent `areaId` as every area, so the first
  // paint shows data and narrows a tick later instead of flashing a skeleton.
  const { options: workCenters, workCenterId, areaId } = useWorkCenterFilter(search.workCenterId);

  const { data, isPending, isError } = useSkuReports({
    page: search.page,
    size: search.size,
    month: search.month,
    year: search.year,
    workCenterId,
    areaId,
    hideZero: search.hideZero,
  });

  const columns = useMemo(() => buildColumns(t), [t]);

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
            <LineFilter
              options={workCenters}
              value={workCenterId}
              onChange={(id) => onFilter({ workCenterId: id })}
            />
            <HideZeroCheckbox
              id="hide-zero-sku-day"
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
        errorMessage={t("table.loadSkuReports")}
        emptyMessage={t("table.noSkuReports")}
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

function buildColumns(
  t: (key: string, opts?: Record<string, string | number>) => string,
): ColumnDef<SkuReportListItem, unknown>[] {
  return [
    indexColumn<SkuReportListItem>(),
    {
      id: "period",
      header: t("table.date"),
      // `businessDate` is plant-local and zone-free (0023) — there is no instant
      // to reduce. It must NEVER go through formatReportDate, which reads
      // '2026-08-19' as UTC midnight and lands on the 18th for any plant west of
      // Greenwich: the right-looking wrong day, on every row.
      cell: ({ row }) => formatBusinessDate(row.original.businessDate),
    },
    {
      id: "sku",
      header: t("table.sku"),
      cell: ({ row }) => row.original.productName || EM_DASH,
    },
    {
      id: "skuCode",
      header: t("table.skuCode"),
      cell: ({ row }) => row.original.productCode || EM_DASH,
    },
    {
      id: "line",
      header: t("table.line"),
      // Name AND code — see the header. NOT NULL in Gold, so the fallback is only
      // for a row written before the pipeline honoured the contract.
      cell: ({ row }) => {
        const { workCenterName, workCenterCode } = row.original;
        if (!workCenterName) return EM_DASH;
        return workCenterCode ? `${workCenterName} · ${workCenterCode}` : workCenterName;
      },
    },
    // formatPercent renders null as an em dash, which is what these four are when
    // a SKU's whole run sat in planned downtime — 0/0, not a measured zero.
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
      // A ROUTE LITERAL, not a template, and not passed in. There is one detail
      // route at this grain, so there is nothing for a caller to choose — but it
      // is still written out rather than built, because TanStack can only check a
      // literal and the machine and line routes COMPILE here (the param name is
      // the same). One of those would open an unrelated report at another subject,
      // under a SKU breadcrumb, with a full page of plausible figures.
      //
      // SEVEN TABLES, SEVEN INDEPENDENT SEQUENCES: this row's id is meaningful
      // only against oee.product_report_wc_day.
      cell: ({ row }) => (
        <Link
          to="/report/sku/by-day/$reportId"
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

export { SkuReportTable };
