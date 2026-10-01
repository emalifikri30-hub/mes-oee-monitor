import { useMemo, useState } from "react";
import { HistoryIcon } from "lucide-react";
import { notFound } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CATEGORY_TEXT_CLASS } from "@/lib/downtime";
import { EM_DASH, formatDateTime, formatDuration } from "@/lib/format";
import { isNotFoundError } from "@/lib/route-error";
import { selectLoadState } from "@/lib/load-state";
import { reportWindowParams, useReasonDetail, useReportApproved } from "@/lib/queries";
import { reportAddress, reportBusinessDay } from "@/lib/report-subject";
import type { AnyReport } from "@/lib/report-subject";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangesHistorySheet } from "@/components/report/changes-history-sheet";
import { DataTable } from "@/components/table/data-table";
import { DowntimeDetailSheet } from "@/components/report/downtime-detail-sheet";
import { DowntimeRowMenu } from "@/components/report/downtime-row-menu";
import { DowntimeEditDialog } from "@/components/report/downtime-edit-dialog";
import { unavailableReason } from "@/lib/downtime";
import { indexColumn } from "@/components/table/index-column";
import { Skeleton } from "@/components/ui/skeleton";
import { SortHeader } from "@/components/table/sort-header";
import { TablePagination } from "@/components/table/table-pagination";

import type { ColumnDef } from "@tanstack/react-table";
import type { ReasonSelector } from "@/lib/api";
import type {
  DowntimeCategory,
  DowntimeListItem,
  DowntimeSortBy,
  DowntimeSortDir,
} from "@/lib/types";

// Same nested-card ladder as the Pareto table above it.
const PAGE_SIZES = [5, 10, 25, 50] as const;

const NUMERIC = { cellClassName: "tabular-nums" } as const;

type Sort = { by: DowntimeSortBy; dir: DowntimeSortDir };

// One sentence per non-ready state, so the summary card and the table beneath it
// can never tell the reader two different stories about the same empty result.
//
// LOCAL, and NOT per category, unlike the Pareto card's — which is not an
// oversight. Every sentence here is about "this reason", which the page's own
// heading has already scoped, so none of them names a category and none of them
// would change if it did. Only the footnote below reconciles against a figure,
// and that one does read LOSS_CATEGORY_COPY.
function emptyMessage(
  t: (key: string) => string,
  state: "no-params" | "empty-loaded" | "empty-stale" | "error",
): string {
  switch (state) {
    case "no-params":
      return t("report.reasonNoParams");
    case "empty-loaded":
      return t("report.reasonEmptyLoaded");
    case "empty-stale":
      return t("report.reasonEmptyStale");
    case "error":
      return t("report.reasonError");
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

function categoryLabel(t: (key: string) => string, category: DowntimeCategory): string {
  switch (category) {
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

function lossName(t: (key: string) => string, category: DowntimeCategory): string {
  switch (category) {
    case "UNPLANNED":
      return t("report.availabilityLoss");
    case "PLANNED":
      return t("report.scheduleLoss");
    case "SMALL_STOP":
      return t("report.smallStop");
    default: {
      const unhandled: never = category;
      return unhandled;
    }
  }
}

// The individual stops behind ONE Pareto bar.
//
// WHAT MAKES THIS PAGE CORRECT: the summary figures are not derived here. The
// server sends the same bucket object the Pareto drew its bar from, computed
// from one clipped row set, so Frequency and Total Duration cannot disagree with
// the chart this page was opened from. Summing the visible rows would have been
// the obvious implementation and would be wrong on page two.
//
// SERVER-PAGED, unlike the Pareto card. That card holds a complete result set
// bounded by the number of distinct reasons in a shift; the records behind one
// reason are not bounded by anything.
function ReasonDetailCard({
  report,
  selector,
  category,
}: {
  report: AnyReport;
  selector: ReasonSelector;
  category: DowntimeCategory;
}) {
  const { t } = useTranslation("oee");
  const [sort, setSort] = useState<Sort>({ by: "startAt", dir: "asc" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [detailRow, setDetailRow] = useState<DowntimeListItem | null>(null);
  // Separate state from detailRow, for the reason downtime-details-card.tsx gives:
  // the drawer is read-only, and the edit dialog holds a concurrency baseline that
  // closing the drawer must not disturb.
  const [editRow, setEditRow] = useState<DowntimeListItem | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const shift = reportWindowParams(report);

  const params = useMemo(
    () =>
      shift === undefined
        ? undefined
        : { ...shift, category, selector, page, size, ...toSortParams(sort) },
    [shift, category, selector, page, size, sort],
  );

  const { data, error, isPending, isError } = useReasonDetail(params);

  // A reason that names nothing is a BROKEN LINK, not a fault — core-api answers
  // it with a 404 — so it escalates to the route's notFoundComponent instead of
  // rendering this card's error banner. "Could not load the stops behind this
  // reason" invites a retry that can never succeed; "Downtime reason not found"
  // with a way back is the truthful answer.
  //
  // Thrown from the component rather than caught in the loader, because the
  // loader deliberately does not fetch: `defaultPreload: "intent"` runs it on
  // hover, and there is one query per reason. See the route file.
  //
  // Anything that is NOT a 404/400 falls through to `isError` below and stays on
  // this card, so a real outage cannot masquerade as a missing reason.
  if (isError && isNotFoundError(error)) throw notFound();

  // The same six-state ladder the Pareto uses, from the same tested function.
  // `no-params` first, because a query gated with `enabled: false` reports
  // pending forever and a ladder reading isPending first renders a skeleton that
  // never resolves.
  const state = selectLoadState({
    hasParams: params !== undefined,
    isPending,
    isError,
    data: data?.detail,
    // NOT `report.date`, which a line report does not have — see reportBusinessDay
    // for the three places this day comes from.
    reportDate: reportBusinessDay(report),
    // The BUCKET, not the current page. An empty page four of a real reason is
    // ordinary paging, not an empty result.
    isEmpty: (detail) => detail.bucket.frequency === 0,
  });

  const message = state === "ready" || state === "pending" ? undefined : emptyMessage(t, state);

  const bucket = data?.detail.bucket;
  const rows = data?.detail.items ?? [];
  const timeZone = data?.detail.timeZone ?? report.timeZone ?? "UTC";

  function toggleSort(column: DowntimeSortBy) {
    setSort((current) =>
      current.by === column
        ? { by: column, dir: current.dir === "asc" ? "desc" : "asc" }
        : { by: column, dir: "desc" },
    );
    setPage(1);
  }

  // The same derivation the Downtime Details card makes, and the same
  // approximation at the coarse grains: `approval` there is a COUNT of the
  // period's shift reports, so "frozen" can only mean all of them are closed.
  // A partially-approved day therefore offers an edit the server refuses with a
  // 409 the dialog surfaces. TODOS.md §49 records why the exact fix belongs on
  // the server rather than in a second copy of SHIFT_WINDOWS here.
  // ONE HOOK FOR SIX CASES — see useReportApproved for the three sources and the
  // day-grain approximation the server corrects with a 409.
  const reportApproved = useReportApproved(report);

  const columns = useMemo(
    () => buildColumns(t, sort, toggleSort, setDetailRow, setEditRow, reportApproved),
    [t, sort, reportApproved],
  );
  const tableMeta = useMemo(() => ({ page, size }), [page, size]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-0 py-0">
        <CardHeader className="flex-wrap items-center gap-3 py-4">
          <CardTitle className="text-sm">
            {selector.kind === "unlabelled" ? t("common.unspecified") : selector.reason}
          </CardTitle>
          <div className="col-start-2 row-start-1 flex items-center gap-3 justify-self-end">
            {/* "Last update" is the pipeline's LOAD time, not a row edit time —
                nothing on a downtime row records when it was last changed. The
                label says "data loaded" rather than "last update" so it cannot
                be read as the latter. */}
            <span className="text-muted-foreground text-xs">
              {t("report.dataLoadedThrough", { when: data?.detail.loadedThrough ?? EM_DASH })}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setHistoryOpen(true)}
              disabled={params === undefined}
            >
              <HistoryIcon />
              {t("report.viewHistory")}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 pb-5">
          {state === "pending" ? <Skeleton className="h-16 w-full" /> : null}

          {message !== undefined ? (
            <div className="bg-muted text-muted-foreground flex min-h-9 w-full items-center justify-center rounded-sm px-3 py-2 text-center text-xs">
              {message}
            </div>
          ) : null}

          {/* The summary, straight from the server's bucket. See the header
              comment: these are the bar's own numbers, not a re-derivation. */}
          {state === "ready" && bucket !== undefined ? (
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-md border px-4 py-3 sm:grid-cols-2">
              {/* The category the page was opened FOR, not one read off the rows:
                  every record here is that category by construction, since it is
                  what the query filtered on. It is also the only thing on screen
                  that says which loss this drill-down belongs to, which is what
                  makes a hand-edited `?category=` visible rather than silent. */}
              <Summary label={t("report.downtimeCategory")}>
                <span className={cn("font-medium", CATEGORY_TEXT_CLASS[category])}>
                  {categoryLabel(t, category)}
                </span>
              </Summary>
              <Summary label={t("report.machineName")}>
                {bucket.workUnitNames.length === 0 ? EM_DASH : bucket.workUnitNames.join(", ")}
              </Summary>
              <Summary label={t("common.frequency")}>{bucket.frequency}</Summary>
              <Summary label={t("report.totalDuration")}>
                <span className={cn("font-medium", CATEGORY_TEXT_CLASS[category])}>
                  {formatDuration(bucket.durationMs)}
                </span>
              </Summary>
            </dl>
          ) : null}

          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(row) => String(row.id)}
            isPending={state === "pending"}
            isError={state === "error"}
            errorMessage={t("report.reasonError")}
            emptyMessage={message ?? t("report.reasonEmptyLoaded")}
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
            pageSizes={PAGE_SIZES}
          />

          {/* The same reconciliation note the Pareto carries, for the same
              reason: these minutes are clipped to the shift and come from the
              downtime records, not from the report's own aggregate — and it names
              the tile for THIS category, so a Schedule Loss reader is not pointed
              at the Availability Loss figure. */}
          <p className="text-muted-foreground text-xs">
            {t("report.reasonDetailFootnote", { loss: lossName(t, category) })}
          </p>
        </CardContent>
      </Card>

      <DowntimeDetailSheet
        row={detailRow}
        open={detailRow !== null}
        onOpenChange={(next) => {
          if (!next) setDetailRow(null);
        }}
      />

      {/* Editing from HERE is what makes the Changes History button beside it
          useful: this is the only table that shows a stop's Downtime ID, so it is
          where somebody reconciling one stop actually works. */}
      <DowntimeEditDialog
        row={editRow}
        address={reportAddress(report)}
        // The stop's line on an AREA report, the report's own everywhere else —
        // the same rule downtime-details-card.tsx applies, and DowntimeEditDialog's
        // prop comment carries the argument. An area spans N lines, so there is no
        // report-level line to take.
        workCenterId={
          report.subject === "area" ? (editRow?.workCenterId ?? null) : report.workCenterId
        }
        open={editRow !== null}
        onOpenChange={(next) => {
          if (!next) setEditRow(null);
        }}
      />

      <ChangesHistorySheet
        params={shift === undefined ? undefined : { ...shift, category, selector }}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        timeZone={timeZone}
      />
    </div>
  );
}

function Summary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">: {children}</dd>
    </div>
  );
}

// The wire takes sortBy/sortDir; the component holds one object. Converted in
// one place so the two cannot drift.
function toSortParams(sort: Sort) {
  return { sortBy: sort.by, sortDir: sort.dir };
}

// Plain objects rather than createColumnHelper, matching the sibling cards.
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
      // The stop's PUBLIC id, not the surrogate `id`. Null on every row until
      // the pipeline writes it, so the em dash is the common case today.
      id: "downtimeId",
      header: t("report.downtimeId"),
      meta: { headerClassName: "min-w-52", cellClassName: "font-mono text-xs" },
      cell: ({ row }) =>
        row.original.sourceEventId ?? <span className="text-muted-foreground">{EM_DASH}</span>,
    },
    {
      id: "startAt",
      header: () => (
        <SortHeader label={t("common.start")} column="startAt" sort={sort} onSort={onSort} />
      ),
      meta: NUMERIC,
      cell: ({ row }) => formatDateTime(row.original.startAt, row.original.timeZone),
    },
    {
      id: "endAt",
      header: t("common.end"),
      meta: NUMERIC,
      // Null while a stop is still open — a normal state, not missing data.
      cell: ({ row }) =>
        row.original.endAt === null ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          formatDateTime(row.original.endAt, row.original.timeZone)
        ),
    },
    {
      id: "duration",
      header: () => (
        <SortHeader label={t("common.duration")} column="duration" sort={sort} onSort={onSort} />
      ),
      meta: NUMERIC,
      cell: ({ row }) => formatDuration(row.original.durationMs),
    },
    {
      id: "action",
      header: t("table.action"),
      cell: ({ row }) =>
        row.original.actions.length === 0 ? (
          <span className="text-muted-foreground">{EM_DASH}</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.original.actions.map((action, i) => (
              <Badge key={`${action}-${i}`} variant="action">
                {action}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      id: "inputBy",
      header: t("report.inputByCol"),
      cell: ({ row }) =>
        row.original.inputBy ?? <span className="text-muted-foreground">{EM_DASH}</span>,
    },
    {
      id: "maintainedBy",
      header: t("report.maintainedByCol"),
      cell: ({ row }) =>
        row.original.maintainedBy ?? <span className="text-muted-foreground">{EM_DASH}</span>,
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

export { ReasonDetailCard };
