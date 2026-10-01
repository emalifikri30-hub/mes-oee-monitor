import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatBusinessDate, formatMonthLabel, formatPercent } from "@/lib/format";
import { useLineReports } from "@/lib/queries";
import { useWorkCenterFilter } from "@/hooks/use-work-center-filter";
import { DataTable } from "@/components/table/data-table";
import { NUMERIC } from "@/components/report/report-list-columns";
import { TablePagination } from "@/components/table/table-pagination";
import { indexColumn } from "@/components/table/index-column";
import {
  HideZeroCheckbox,
  LineFilter,
  MonthFilter,
  ShiftFilter,
  YearFilter,
} from "@/components/report/report-list-filters";
import { ReportListFilterBar, ReportListShell } from "@/components/report/report-list-shell";

import type { ColumnDef } from "@tanstack/react-table";
import type { LineGrain, LineReportListItem } from "@/lib/types";
import type { PeriodSearch } from "@/lib/period-search";

// The Line report lists — By Shift, By Day and By Monthly — which are the same
// screen three times.
//
// ONE COMPONENT OVER THREE GRAINS, where the machine screens need two components
// for their three. The reason is the data, not the styling: oee.work_center_*
// differ by exactly one column (`shift`), and none of the three has an approval.
// The machine By Shift screen genuinely diverges — it has an approval status to
// filter and to badge, which no other report in the app does.
//
// The routes own `validateSearch`, because TanStack requires it there and because
// the URL contract belongs to the URL's owner. They hand the validated object
// down.
//
// HOW THIS DIFFERS FROM THE MACHINE LISTS, and every difference is a decision:
//
//   no Machine column   the rows ARE lines. LineReportListItem has no `workUnit`
//                       field at all, so this is enforced by the type rather than
//                       by remembering.
//   no Status column,   oee.work_unit_shift_report_approvals is keyed
//   no status filter    (work_unit_id, date, shift) and the work_center_* tables
//                       have no work_unit_id, so there is no correlated subquery a
//                       column or a filter here could be built from. A line CAN be
//                       approved — the DETAIL screen offers it, as a cascade over
//                       the line's machine reports — but its status is DERIVED by
//                       counting those rows, which is one query per row on a list.
//                       TODOS §53 records the decision; a Status column here needs
//                       a set-based version of that count first.
//   a Machines column   which the machine lists have no use for, and which is the
//                       only thing that makes a PARTIAL line visible — see below.
//   the eye is a LINK   as of the Line detail screen (TODOS §52). It was inert
//                       while nothing existed to open; `detailTo` is typed as the
//                       three route literals so a wrong target is a build error
//                       rather than a MACHINE report opened under a Line
//                       breadcrumb — see the Action column.

type LineReportTableProps = {
  grain: LineGrain;
  // The two coarse grains use PeriodSearch verbatim; the shift grain adds `shift`.
  // Typed as the union so one component takes both, and read with a guard rather
  // than a cast.
  search: PeriodSearch & { shift?: string | undefined };
  // Applies a filter change AND resets to page 1 — page 7 of the old result set
  // is rarely page 7 of the new one, and is often past the end.
  onFilter: (patch: Partial<PeriodSearch & { shift: string | undefined }>) => void;
  onPageChange: (page: number) => void;
  // THE DETAIL ROUTE, AS A LITERAL, passed by the caller rather than derived from
  // `grain` in here. Derived, it would be a template string TanStack cannot check,
  // and the failure would be a dead link or — far worse — a valid MACHINE route
  // with the same `$reportId` param name. This way a renamed route breaks the
  // build. Same reason PeriodReportTable takes one.
  detailTo:
    | "/report/line/by-shift/$reportId"
    | "/report/line/by-day/$reportId"
    | "/report/line/by-monthly/$reportId";
};

function LineReportTable({
  grain,
  search,
  onFilter,
  onPageChange,
  detailTo,
}: LineReportTableProps) {
  const { t } = useTranslation("oee");
  // `areaId` COMES OUT OF THE SAME HOOK AS THE LINE OPTIONS, and it is now part
  // of the REQUEST rather than only of the cascade above it. The header picker
  // scopes every report list; see hooks/use-work-center-filter.ts for why the two
  // returned ids are not interchangeable, and why an undefined area must NOT gate
  // the query — core-api reads an absent `areaId` as every area, so the first
  // paint shows data and narrows a tick later instead of flashing a skeleton.
  const { options: workCenters, workCenterId, areaId } = useWorkCenterFilter(search.workCenterId);

  const { data, isPending, isError } = useLineReports(grain, {
    page: search.page,
    size: search.size,
    month: search.month,
    year: search.year,
    // Only ever sent at shift grain — getLineReports drops it at the others, and
    // passing it here at all would put a second cache key on the same server page.
    ...(grain === "shift" ? { shift: search.shift } : {}),
    workCenterId,
    areaId,
    hideZero: search.hideZero,
  });

  const columns = useMemo(() => buildColumns(t, grain, detailTo), [t, grain, detailTo]);

  const tableMeta = useMemo(
    () => ({ page: search.page, size: search.size }),
    [search.page, search.size],
  );

  const noun = t(
    grain === "shift"
      ? "report.grainShift"
      : grain === "day"
        ? "report.grainDay"
        : "report.grainMonth",
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
            {/* Shift grain only. Rendering it at day or month would offer a filter
                the server has no column to apply. */}
            {grain === "shift" ? (
              <ShiftFilter value={search.shift} onChange={(shift) => onFilter({ shift })} />
            ) : null}
            <LineFilter
              options={workCenters}
              value={workCenterId}
              onChange={(id) => onFilter({ workCenterId: id })}
            />
            <HideZeroCheckbox
              id={`hide-zero-line-${grain}`}
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

function buildColumns(
  t: (key: string, opts?: Record<string, string | number>) => string,
  grain: LineGrain,
  detailTo: LineReportTableProps["detailTo"],
): ColumnDef<LineReportListItem, unknown>[] {
  return [
    indexColumn<LineReportListItem>(),
    {
      id: "period",
      header: grain === "month" ? t("table.month") : t("table.date"),
      // NO ZONE CONVERSION AT ANY GRAIN, and this is the one place the Line lists
      // are simpler than the machine ones rather than merely different.
      //
      // oee.work_center_* have no `date timestamptz` column at all (migration
      // 0014), so every row carries only a plant-local business date. The machine
      // By Shift list has to reduce a shift-start INSTANT through the plant zone
      // and renders an em dash when that zone is missing; there is nothing to
      // reduce here.
      //
      // businessDate must NEVER go through formatReportDate: that reads
      // '2026-08-01' as UTC midnight and lands on 31 July for any plant west of
      // Greenwich — the right-looking wrong day, on every row.
      cell: ({ row }) =>
        row.original.grain === "month"
          ? formatMonthLabel(row.original.businessDate)
          : formatBusinessDate(row.original.businessDate),
    },
    // Shift grain only. The union's `shift` is `null` at the coarse grains, so a
    // column that reached them would render a blank rather than a value — which is
    // why the column is absent instead of conditional inside the cell.
    ...(grain === "shift"
      ? [
          {
            id: "shift",
            header: t("table.shift"),
            cell: ({ row }) => row.original.shift,
          } satisfies ColumnDef<LineReportListItem, unknown>,
        ]
      : []),
    {
      id: "line",
      header: t("table.line"),
      // `workCenterName`, FLAT — not a nested `workCenter.name`. The machine lists
      // nest it because core-api enriches those labels from mes-master-data; here
      // it is a Gold column and arrives flat. Reading the nested shape shipped
      // once and rendered an em dash on every row, silently. See lib/types.ts.
      //
      // NOT NULL in Gold, so the fallback is only for a row written before the
      // pipeline honoured the contract.
      cell: ({ row }) => row.original.workCenterName || EM_DASH,
    },
    {
      id: "machines",
      header: t("table.machines"),
      // THE ONLY THING THAT MAKES A PARTIAL LINE VISIBLE. If one machine's DAG
      // partition fails, the line row is written from three of four and renders a
      // plausible, slightly-lower OEE with no other signal anywhere.
      //
      // Both numbers are columns, so this costs no HTTP — see
      // docs/gold-write-contract.md §16.5 for why the roster is asked of the
      // pipeline rather than resolved here. When it could not be resolved the cell
      // reports the bare count: "3" is true on its own terms, and "3 of 4" would
      // be a guess.
      cell: ({ row }) => {
        const { workUnitCount, expectedWorkUnitCount } = row.original;
        return expectedWorkUnitCount == null
          ? workUnitCount
          : t("table.machinesOf", { found: workUnitCount, expected: expectedWorkUnitCount });
      },
      meta: NUMERIC,
    },
    // formatPercent renders null as an em dash, which is what these four are when
    // a line never ran — 0/0 recomputed, not a measured zero.
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
      // A REAL LINK NOW. This shipped as an inert <span> because no line detail
      // screen existed (TODOS §52); the four sections it was waiting for are here.
      //
      // WHAT MAKES IT SAFE IS THAT THE TARGET CARRIES BOTH AXES. The seven report
      // tables have seven INDEPENDENT identity sequences, so this row's id is
      // meaningful only against oee.work_center_{grain}_reports. A
      // `to="/report/machine/by-shift/$reportId"` here would COMPILE — the param
      // name is the same — and open an unrelated MACHINE report, rendering a full
      // page of plausible figures under a Line breadcrumb. Hence `detailTo` is
      // typed as the three route literals below and passed by the caller: a
      // renamed or wrong route is a build failure rather than a wrong page.
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

export { LineReportTable };
