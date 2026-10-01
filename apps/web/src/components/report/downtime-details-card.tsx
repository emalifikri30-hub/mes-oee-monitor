import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CATEGORY_TEXT_CLASS, unavailableReason } from "@/lib/downtime";
import { EM_DASH, formatDateTime, formatDuration } from "@/lib/format";
import { reportAddress } from "@/lib/report-subject";
import type { AnyReport } from "@/lib/report-subject";
import type {
  DowntimeListItem,
  DowntimeSortBy,
  DowntimeSortDir,
  TimelineSegmentKind,
} from "@/lib/types";
import { reportWindowParams, useDowntimes, useReportApproved } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DataTable } from "@/components/table/data-table";
import { DowntimeDetailSheet } from "@/components/report/downtime-detail-sheet";
import { DowntimeRowMenu } from "@/components/report/downtime-row-menu";
import { DowntimeEditDialog } from "@/components/report/downtime-edit-dialog";
import { indexColumn } from "@/components/table/index-column";
import { SortHeader } from "@/components/table/sort-header";
import { TablePagination } from "@/components/table/table-pagination";

import type { ColumnDef } from "@tanstack/react-table";

// The raw records behind the timeline strip above: one row per downtime, nothing
// merged, so two overlapping stops appear twice here and once there.
//
// MTTR and MTBF are NOT derived from these rows — they are the report's own
// columns, computed by the same ETL as the OEE figures. Deriving them from a
// single page would be wrong, and deriving them from every record would put a
// second definition of "failure" in the browser.
//
// SERVES BOTH SUBJECTS, and needed almost nothing to. Downtime is scoped by a
// query param rather than nested under a work unit — a stop belongs to a work
// unit, a work center, an area or the factory — so `reportWindowParams` already
// answers for a line, the Machine column already exists (and stops being a
// near-constant there, which is the point of it on this screen), and the Reason
// catalogue already takes a `workCenterId` the line report carries NOT NULL.
//
// Two things did change. `reportApproved` moved into `useReportApproved`, because
// a line report has no `approval` column to read and the line branch has to
// subscribe to the machine-approval summary instead. And the dialog now takes a
// `ReportAddress` rather than an id plus a grain, so the invalidation cannot
// target the machine table with a line report's id.

// Smaller steps than the full-page tables: this one is nested in a card, and the
// design shows five rows.
const DOWNTIME_PAGE_SIZES = [5, 10, 25, 50] as const;

type Sort = { by: DowntimeSortBy; dir: DowntimeSortDir };

const NUMERIC = { cellClassName: "tabular-nums" } as const;

function categoryLabel(t: (key: string) => string, category: TimelineSegmentKind): string {
  switch (category) {
    case "RUN_TIME":
      return t("report.categoryRuntime");
    case "SMALL_STOP":
      return t("report.categorySmallStop");
    case "PLANNED":
      return t("report.categoryPlanned");
    case "UNPLANNED":
      return t("report.categoryUnplanned");
    default: {
      const unhandled: never = category;
      return unhandled;
    }
  }
}

function DowntimeDetailsCard({ report }: { report: AnyReport }) {
  const { t } = useTranslation("oee");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(DOWNTIME_PAGE_SIZES[0]);
  // Newest first, matching the design's default ordering.
  const [sort, setSort] = useState<Sort>({ by: "startAt", dir: "desc" });
  // Which row the shared detail drawer is showing, or null when it is closed.
  // No fetch behind it — the row is already on this page.
  const [detailRow, setDetailRow] = useState<DowntimeListItem | null>(null);
  // Which row the edit dialog is showing. A SEPARATE piece of state from
  // detailRow, not a mode flag over one: the drawer is read-only and the dialog
  // captures a concurrency baseline when it opens, so sharing the slot would let
  // closing the drawer reset a baseline the dialog is still holding.
  const [editRow, setEditRow] = useState<DowntimeListItem | null>(null);

  const shift = reportWindowParams(report);
  const params = shift === undefined ? undefined : { ...shift, page, size, ...toQuery(sort) };

  // `reportWindowParams` returns undefined when `report.date` cannot be reduced
  // to a business day, and that gates the query off. A gated useQuery reports
  // `status: "pending"` FOREVER, so passing isPending straight through would
  // render skeleton rows that never resolve: no error, no empty state, no log.
  // Rendered as an empty state carrying its own message instead, which says
  // what actually went wrong.
  const unresolved = shift === undefined;

  // Whether this read is narrowed to ONE SKU, read off the params rather than off
  // a `subject` prop — `productId` is present iff the composer put it there, which
  // is the fact the empty state needs, and a flag would be a second statement of
  // it that could disagree. See the emptyMessage below.
  const perProduct = shift?.productId !== undefined;

  const { data, isPending, isError } = useDowntimes(params);

  // Clicking the active column flips direction; a new column starts descending,
  // which is the useful default for both a timestamp and a duration. Either way
  // paging restarts, or page 3 of the old order becomes page 3 of the new one.
  function toggleSort(column: DowntimeSortBy) {
    setSort((current) =>
      current.by === column
        ? { by: column, dir: current.dir === "asc" ? "desc" : "asc" }
        : { by: column, dir: "desc" },
    );
    setPage(1);
  }

  // Approving a report freezes its downtime, and the server enforces it — this is
  // only what stops the menu offering an action that would 409.
  //
  // FOUR OF THE SIX ADDRESSES ANSWER THIS APPROXIMATELY, and knowingly so — see
  // useReportApproved for all six and for why the alternative (a second copy of
  // SHIFT_WINDOWS in the browser) is worse than a recoverable 409. TODOS.md §49.
  const reportApproved = useReportApproved(report);

  const columns = useMemo(
    () => buildColumns(t, sort, toggleSort, setDetailRow, setEditRow, reportApproved),
    [t, sort, reportApproved],
  );

  const tableMeta = useMemo(() => ({ page, size }), [page, size]);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex-wrap items-center gap-3 py-4">
        <CardTitle className="text-sm">{t("report.downtimeDetails")}</CardTitle>
        <div className="col-start-2 row-start-1 flex flex-wrap items-center gap-2 justify-self-end text-xs">
          <span className="rounded-md border px-2.5 py-1.5">
            {t("report.downtimeFrequency")}
            {/* The count of records in the report's window, straight off the
                paging meta — not the number of rows on this page. */}
            <span className="text-primary font-semibold tabular-nums">
              {data?.meta?.totalElements ?? 0}
            </span>
          </span>
          <span className="flex items-center gap-3 rounded-md border px-2.5 py-1.5">
            <span>
              {t("report.mttr")}
              <span className="text-primary font-semibold tabular-nums">
                {formatDuration(report.mttr)}
              </span>
            </span>
            <span>
              {t("report.mtbf")}
              <span className="text-primary font-semibold tabular-nums">
                {formatDuration(report.mtbf)}
              </span>
            </span>
          </span>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-5">
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          getRowId={(row) => String(row.id)}
          isPending={!unresolved && isPending}
          isError={isError}
          errorMessage={t("report.loadDowntimeRecords")}
          emptyMessage={
            unresolved
              ? t("report.timelineNoParams")
              : perProduct
                ? // NOT "no downtime recorded". A product-filtered read is
                  // `product_id = X`, false for NULL rather than
                  // unknown-but-included, so every stop the pipeline has not
                  // attributed to a SKU is silently absent — and it has attributed
                  // none of them yet (TODOS.md §65). Saying "none recorded" here
                  // would be the §8 failure at a new axis: a claim about the SKU
                  // that the data cannot support.
                  t("report.noSkuDowntime")
                : t("report.noDowntimeWindow")
          }
          skeletonRows={size}
          meta={tableMeta}
        />
        <TablePagination
          page={page}
          size={size}
          meta={data?.meta}
          onPageChange={setPage}
          onSizeChange={(next) => {
            setSize(next);
            setPage(1);
          }}
          pageSizes={DOWNTIME_PAGE_SIZES}
        />

        {/* The SAME drawer the Availability Loss detail table opens. Both
            tables project the same columns server-side, so a record describes
            itself identically whichever screen it was opened from. */}
        <DowntimeDetailSheet
          row={detailRow}
          open={detailRow !== null}
          onOpenChange={(next) => {
            if (!next) setDetailRow(null);
          }}
        />

        <DowntimeEditDialog
          row={editRow}
          address={reportAddress(report)}
          // THE STOP'S LINE ON AN AREA REPORT, THE REPORT'S OWN EVERYWHERE ELSE.
          // An area spans N lines, so there is no report-level line to take and the
          // row is the only thing that knows which Reason catalogue applies. Every
          // other subject's report knows its own, and that is the better source —
          // the row's is whatever the pipeline denormalised. DowntimeEditDialog's
          // prop comment carries the full argument.
          //
          // Nullable on a MACHINE day or month report: 0013 added the column and
          // the pipeline does not fill it yet, so the dialog degrades to an
          // unscoped Reason picker rather than failing. A LINE report carries it
          // NOT NULL at every grain (0014), so the picker is always scoped there.
          workCenterId={
            report.subject === "area" ? (editRow?.workCenterId ?? null) : report.workCenterId
          }
          open={editRow !== null}
          onOpenChange={(next) => {
            if (!next) setEditRow(null);
          }}
        />
      </CardContent>
    </Card>
  );
}

function toQuery(sort: Sort) {
  return { sortBy: sort.by, sortDir: sort.dir };
}

// Plain objects rather than createColumnHelper, matching by-shift.tsx: the
// helper's inference fights `ColumnDef<T, unknown>[]`, and every cell here reads
// row.original anyway.
function buildColumns(
  t: (key: string) => string,
  sort: Sort,
  onSort: (column: DowntimeSortBy) => void,
  onViewDetail: (row: DowntimeListItem) => void,
  onEdit: (row: DowntimeListItem) => void,
  reportApproved: boolean,
): ColumnDef<DowntimeListItem, unknown>[] {
  return [
    indexColumn(),
    {
      id: "reason",
      header: t("report.reason"),
      meta: { headerClassName: "min-w-52" },
      cell: ({ row }) => <ReasonCell reasons={row.original.reason} />,
    },
    {
      id: "category",
      header: () => (
        <SortHeader label={t("report.category")} column="category" sort={sort} onSort={onSort} />
      ),
      cell: ({ row }) => (
        <span className={cn("font-medium", CATEGORY_TEXT_CLASS[row.original.category])}>
          {categoryLabel(t, row.original.category)}
        </span>
      ),
    },
    {
      id: "machine",
      header: t("table.machine"),
      cell: ({ row }) => row.original.workUnitName ?? EM_DASH,
    },
    {
      id: "actions",
      header: t("report.actions"),
      // Several actions read as a list; none reads as the app's usual em dash
      // rather than an "N/A" badge, which the design explicitly rejected.
      cell: ({ row }) =>
        row.original.actions.length === 0 ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          row.original.actions.join(", ")
        ),
    },
    {
      id: "startAt",
      header: () => (
        <SortHeader
          label={t("report.downtimeStart")}
          column="startAt"
          sort={sort}
          onSort={onSort}
        />
      ),
      meta: NUMERIC,
      cell: ({ row }) => formatDateTime(row.original.startAt, row.original.timeZone),
    },
    {
      id: "duration",
      header: () => (
        <SortHeader label={t("common.duration")} column="duration" sort={sort} onSort={onSort} />
      ),
      meta: NUMERIC,
      // Null while a stop is still open — the em dash says "still running", which
      // a zero would not.
      cell: ({ row }) => formatDuration(row.original.durationMs),
    },
    {
      id: "menu",
      header: "",
      meta: { headerClassName: "w-10" },
      cell: ({ row }) => (
        <DowntimeRowMenu
          onViewDetail={() => onViewDetail(row.original)}
          onEdit={() => onEdit(row.original)}
          unavailableReason={unavailableReason(row.original, reportApproved)}
        />
      ),
    },
  ];
}

// A record can carry several reasons, so the cell shows the first and folds the
// rest away rather than letting one row grow taller than the other four.
function ReasonCell({ reasons }: { reasons: string[] }) {
  const { t } = useTranslation("oee");
  const [open, setOpen] = useState(false);

  if (reasons.length === 0) return <span className="text-muted-foreground">{EM_DASH}</span>;
  if (reasons.length === 1) return <span>{reasons[0]}</span>;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col items-start gap-0.5">
      <span>{reasons[0]}</span>
      <CollapsibleContent className="flex flex-col gap-0.5">
        {reasons.slice(1).map((reason, i) => (
          <span key={`${reason}-${i}`}>{reason}</span>
        ))}
      </CollapsibleContent>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
        {open ? t("common.showLess") : t("report.moreN", { count: reasons.length - 1 })}
      </CollapsibleTrigger>
    </Collapsible>
  );
}

export { DowntimeDetailsCard };
