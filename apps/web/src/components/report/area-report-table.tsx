import { EyeIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatBusinessDate, formatMonthLabel, formatPercent } from "@/lib/format";
import { useAreaReports } from "@/lib/queries";
import { useSelectedArea } from "@/components/layout/area-context";
import { DataTable } from "@/components/table/data-table";
import { NUMERIC } from "@/components/report/report-list-columns";
import { TablePagination } from "@/components/table/table-pagination";
import { indexColumn } from "@/components/table/index-column";
import { HideZeroCheckbox, MonthFilter, YearFilter } from "@/components/report/report-list-filters";
import { ReportListFilterBar, ReportListShell } from "@/components/report/report-list-shell";

import type { ColumnDef } from "@tanstack/react-table";
import type { AreaDaySearch, AreaMonthSearch } from "@/lib/area-search";
import type { AreaGrain, AreaReportListItem } from "@/lib/types";

// The Area By Day and By Monthly lists.
//
// ONE COMPONENT FOR BOTH GRAINS, discriminated on a `search` UNION rather than on a
// `grain` prop beside it — which is the one design decision in this file worth
// reading before the rest.
//
// The two screens differ in exactly two places: the first column (a business DATE
// or a MONTH label) and the filter bar (Month + Year, or Year alone). A `grain`
// prop plus a widened search type would admit `{grain: "month", month: 9}` — a
// month filter on the month screen, which the requirement forbids in as many words
// ("Monthly Report (Show all month on selected year)") and which core-api's month
// list refuses outright. Discriminating on the search makes that combination
// unrepresentable instead of merely unused.
//
// The day grain shipped first with a note that the month "will be a second
// component beside this one rather than a parameter on it". It is one component,
// because the two turned out to share the filter bar, the table, the pager, the
// area cascade and eight of nine columns — and two copies of the nine-sequences
// eye-column rule is the duplication this repo's list screens exist not to have.
//
// ---------------------------------------------------------------------------
// THE HEADER'S AREA PICKER IS A REQUEST FILTER HERE, AND ON NO OTHER SCREEN
// ---------------------------------------------------------------------------
//
// This is the one thing to know before reading the filter bar. Every other report
// list reads the picker through `useWorkCenterFilter`, whose header says the area
// "never filters a request on its own — it only decides which work centers a page
// may offer (core-api has no areaId filter)". Both halves of that changed for this
// subject: the area IS what the report is about, and `/areas/day-reports` takes
// `areaId`.
//
// So the filter bar carries NO area control of its own. The requirement is explicit
// ("use existing filter area on the header layout"), and a second area picker on
// the page would be a control that either duplicates the header's or disagrees with
// it. What that costs is that the area is not in the URL — see lib/area-search.ts,
// which inherits area-context.tsx's decision rather than re-opening it.
//
// AN UNDEFINED AREA IS NOT AN ERROR AND MUST NOT GATE THE QUERY. `useSelectedArea`
// returns `undefined` until the area list resolves, and core-api reads an absent
// `areaId` as "every area" — so the first paint shows data and narrows a tick
// later, rather than showing a skeleton that waits on a second request. This is the
// inverse of `useWorkCenterFilter`'s stranded-id rule, and for the same underlying
// reason: whichever behaviour keeps a filtered list from silently widening.
//
// WHAT IT DOES NOT HAVE, and each absence is the schema's or the requirement's:
//
//   no Shift filter     no shift grain on this subject at all, and neither a day
//                       nor a month report narrows to one.
//   no Line filter      an area report is not scoped by a line. See above.
//   no Status column    oee.work_unit_shift_report_approvals is keyed
//                       (work_unit_id, date, shift); an area report has neither and
//                       is not approvable at all, so there is nothing to derive.
//   no Lines column     the requirement names no member count, so migration 0024
//                       has no column for one.

// THE DISCRIMINANT IS `grain` ON THE SEARCH ITSELF, so `search.month` is reachable
// only in the day arm. TypeScript narrows both the props and the handler's patch
// type from one check.
type AreaReportTableProps =
  | {
      grain: "day";
      search: AreaDaySearch;
      onFilter: (patch: Partial<AreaDaySearch>) => void;
      onPageChange: (page: number) => void;
    }
  | {
      grain: "month";
      search: AreaMonthSearch;
      onFilter: (patch: Partial<AreaMonthSearch>) => void;
      onPageChange: (page: number) => void;
    };

function AreaReportTable(props: AreaReportTableProps) {
  const { t } = useTranslation("oee");
  const { grain, search, onPageChange } = props;
  const { areaId } = useSelectedArea();

  const { data, isPending, isError } = useAreaReports(grain, {
    page: search.page,
    size: search.size,
    // DAY GRAIN ONLY, and the narrowing is what enforces it rather than a comment:
    // `search.month` does not exist on `AreaMonthSearch`, so this cannot be widened
    // into an unconditional read without a build error.
    ...(props.grain === "day" ? { month: props.search.month } : {}),
    year: search.year,
    areaId,
    hideZero: search.hideZero,
  });

  const columns = useMemo(() => buildColumns(t, grain), [t, grain]);

  const tableMeta = useMemo(
    () => ({ page: search.page, size: search.size }),
    [search.page, search.size],
  );

  return (
    <ReportListShell>
      <ReportListFilterBar
        left={
          <>
            {/* THE MONTH FILTER IS THE DAY SCREEN'S ALONE. Rendering it on the
                month screen would be a control whose value the request cannot
                carry — core-api's month list does not declare the param — so it
                would read as set and do nothing. The narrowing is what makes it
                impossible rather than merely absent. */}
            {props.grain === "day" ? (
              <MonthFilter
                value={props.search.month}
                onChange={(month) => props.onFilter({ month })}
              />
            ) : null}
            <YearFilter
              value={search.year}
              onChange={(year) => {
                // Narrowed per arm rather than called once, because the two
                // `onFilter`s take different patch types and a union of function
                // types is not callable.
                if (props.grain === "day") props.onFilter({ year });
                else props.onFilter({ year });
              }}
            />
          </>
        }
        right={
          <HideZeroCheckbox
            // PER GRAIN, because `id` is required rather than defaulted precisely
            // so two of these on one page cannot collide — and the two screens are
            // different pages but the same component.
            id={`hide-zero-area-${grain}`}
            checked={search.hideZero}
            onChange={(hideZero) => {
              if (props.grain === "day") props.onFilter({ hideZero });
              else props.onFilter({ hideZero });
            }}
          />
        }
      />

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(row) => String(row.id)}
        isPending={isPending}
        isError={isError}
        errorMessage={t("table.loadAreaReports")}
        emptyMessage={t("table.noAreaReports")}
        skeletonRows={search.size}
        meta={tableMeta}
      />

      <TablePagination
        page={search.page}
        size={search.size}
        meta={data?.meta}
        onPageChange={onPageChange}
        onSizeChange={(size) => {
          if (props.grain === "day") props.onFilter({ size });
          else props.onFilter({ size });
        }}
      />
    </ReportListShell>
  );
}

function buildColumns(
  t: (key: string, opts?: Record<string, string | number>) => string,
  grain: AreaGrain,
): ColumnDef<AreaReportListItem, unknown>[] {
  return [
    indexColumn<AreaReportListItem>(),
    {
      id: "period",
      header: grain === "day" ? t("table.date") : t("table.month"),
      // `businessDate` is plant-local and zone-free at BOTH grains (0024, 0025) —
      // there is no instant to reduce. It must NEVER go through formatReportDate,
      // which reads '2026-09-01' as UTC midnight and lands on 31 August for any
      // plant west of Greenwich: the right-looking wrong day, on every row.
      //
      // AND AT MONTH GRAIN IT IS THE FIRST DAY OF THE MONTH
      // (`ck_amr_month_start`), so `formatBusinessDate` would print "01/09/2026"
      // under a header that says Month — a reader would take every row as covering
      // one day. `formatMonthLabel` prints "September 2026" and builds no zoned
      // Date either.
      //
      // READ OFF THE GRAIN THE COLUMN WAS BUILT WITH, not off `row.grain`. The
      // server stamps both and they agree; using the column's keeps the HEADER and
      // the cells deciding from one value, so a mixed page — which cannot happen —
      // could not render a Month header over business dates.
      cell: ({ row }) =>
        grain === "day"
          ? formatBusinessDate(row.original.businessDate)
          : formatMonthLabel(row.original.businessDate),
    },
    {
      id: "area",
      header: t("table.area"),
      // Name AND code. `area_name` is NOT NULL in Gold, so the first fallback is
      // only for a row written before the pipeline honoured the contract; the code
      // is nullable and goes with its separator rather than leaving a trailing dot.
      cell: ({ row }) => {
        const { areaName, areaCode } = row.original;
        if (!areaName) return EM_DASH;
        return areaCode ? `${areaName} · ${areaCode}` : areaName;
      },
    },
    // formatPercent renders null as an em dash, which is what these four are when
    // every line in the area sat in planned downtime — 0/0, not a measured zero.
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
      // TWO ROUTE LITERALS PICKED BY GRAIN, not a template. TanStack can only check
      // a literal, and the machine, line and SKU routes all COMPILE here (the param
      // name is the same) — one of those would open an unrelated report at another
      // subject, under an Area breadcrumb, with a full page of plausible figures.
      //
      // AND THE TWO AREA ONES COMPILE IN EACH OTHER'S PLACE, which is the sharper
      // half at this subject: nine report tables, eight INDEPENDENT identity
      // sequences, so a day row's id opened at `/by-monthly` lands on a real MONTH
      // report about a different period — populated, plausible, and wrong.
      cell: ({ row }) =>
        grain === "day" ? (
          <Link
            to="/report/area/by-day/$reportId"
            params={{ reportId: String(row.original.id) }}
            className="text-muted-foreground hover:text-foreground inline-flex transition-colors"
            aria-label={t("report.viewReport", { id: row.original.id })}
          >
            <EyeIcon className="size-4" />
          </Link>
        ) : (
          <Link
            to="/report/area/by-monthly/$reportId"
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

export { AreaReportTable };
