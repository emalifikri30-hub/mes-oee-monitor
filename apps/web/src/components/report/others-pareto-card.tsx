import { Suspense, lazy, useMemo, useState } from "react";
import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatQuantity, formatPercent } from "@/lib/format";
import {
  buildDowntimeEventPareto,
  selectDowntimeEventParetoState,
  sortDowntimeEventRows,
} from "@/lib/downtime-event-pareto";
import { useReportDowntimeEvents } from "@/lib/queries";
import { isMachineReport, reportBusinessDay } from "@/lib/report-subject";
import type { AnyReport } from "@/lib/report-subject";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/table/data-table";
import { indexColumn } from "@/components/table/index-column";
import { MachineFilter } from "@/components/report/machine-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { SortHeader } from "@/components/table/sort-header";
import { TablePagination } from "@/components/table/table-pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ColumnDef } from "@tanstack/react-table";
import type { DowntimeEventBar, DowntimeEventSort } from "@/lib/downtime-event-pareto";

// SPLIT OUT OF THE ENTRY CHUNK, and NOT because autoCodeSplitting is off — it is
// on. recharts is the heaviest dependency in the app and only the report screens
// need it, but route-level splitting alone does not keep it out: the chart cards
// live in three different route chunks, so rolldown lifts recharts to their common
// ancestor, which IS the entry chunk. Measured — deleting these boundaries takes
// the entry from 395 kB back to 781 kB.
//
// This `lazy()` is what gives recharts an async chunk of its own. The reasoning
// lives once beside the flag in vite.config.ts; TODOS.md §26 has the numbers.
const OthersParetoChart = lazy(() =>
  import("@/components/report/others-pareto-chart").then((m) => ({
    default: m.OthersParetoChart,
  })),
);

// Same ladder as its two siblings: this table is nested in a card and the design
// shows a handful of rows.
const PAGE_SIZES = [5, 10, 25, 50] as const;

const NUMERIC = { cellClassName: "tabular-nums" } as const;

function othersEmpty(
  t: (key: string) => string,
  state: "no-params" | "empty-loaded" | "empty-stale" | "error",
): string {
  switch (state) {
    case "no-params":
      return t("report.eventsNoParams");
    case "empty-loaded":
      return t("report.noDowntimeEvents");
    case "empty-stale":
      return t("report.eventsStale");
    case "error":
      return t("report.eventsError");
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

function occurrenceSummaryText(
  t: (key: string, options?: Record<string, string>) => string,
  totalOccurrences: number,
  totalEvents: number,
): string {
  return t("report.occurrenceSummary", {
    occurrences: formatQuantity(totalOccurrences, null),
    occurrenceNoun:
      totalOccurrences === 1 ? t("report.reasonOccurrence") : t("report.reasonOccurrences"),
    events: formatQuantity(totalEvents, null),
    eventNoun: totalEvents === 1 ? t("report.downtimeEvent") : t("report.downtimeEvents"),
  });
}

function occurrenceFootnoteText(
  t: (key: string, options?: Record<string, string>) => string,
  totalOccurrences: number | null,
  totalEvents: number | null,
): string {
  const counted =
    totalOccurrences === null || totalEvents === null
      ? t("report.othersFootnoteCounted")
      : t("report.othersFootnoteCountedNums", {
          occurrences: formatQuantity(totalOccurrences, null),
          events: formatQuantity(totalEvents, null),
        });
  return t("report.othersFootnote", { counted });
}

// The Others tab's Pareto: which downtime reason came up most often.
//
// THE WHOLE TAB, not a half of it. QualityLossTab exists because Quality Loss has
// a second, unrankable half (rework, a scalar on the shift row) that needs a
// LossSection beside the card; PerformanceLossTab exists because it owns a sub-tab
// bar and the Reduce Speed band. "Others" has neither — there is no othersLossTime
// on ReportDetail, no second source and no sub-tab — so a wrapper component
// would have `<OthersParetoCard report={report} />` for a body and tell a reader
// nothing. The route renders this directly, as Availability and Schedule Loss do.
//
// The trigger for adding one later, stated so it is a decision rather than an
// omission: a wrapper becomes worth writing the day this tab has to NAME a figure
// it cannot rank — an "unattributed downtime" total, say — because that is when
// there is a second thing on the tab.
//
// STRUCTURALLY QualityParetoCard, and three things differ. Each is load-bearing:
//
//   * ONE MEASURE, so NO MeasureToggle. See the header slot below.
//   * TWO TOTALS, and only one of them is a denominator. The bars sum to
//     `totalOccurrences` and NOT to `totalEvents`, because one stop can cite
//     several reasons — so the card has to say both numbers out loud.
//   * NO DRILL-DOWN, for a sharper reason than Quality Loss's. There the rows
//     behind an eye button did not exist; here they exist and are the WRONG rows.
//     /losses/detail filters oee.downtime_reports by primary reason — a mutable
//     table, and only its first reason — so the page would list stops that are not
//     the stops behind the bar. lib/reason-search.ts, the losses_.detail route and
//     ReasonDetail are untouched by this feature.
//
// WHAT IT DELIBERATELY DOES NOT RENDER: a grand total, same as both siblings. The
// figure a reader would reach for is the Downtime Details card's Downtime
// Frequency, which counts rows in the editable table across every category, and it
// will not reconcile. The cumulative line is a share, which claims nothing about
// that source, and the footnote says so outright.
function OthersParetoCard({ report }: { report: AnyReport }) {
  const { t } = useTranslation("oee");
  const [sort, setSort] = useState<DowntimeEventSort>({ by: "occurrences", dir: "desc" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);

  // No params composer, because there are no params: the report id is the whole
  // request. lib/api.ts says why that is worth noticing rather than merely being
  // simpler.
  // ONE HOOK, WHICH PICKS AMONG SIX ENDPOINTS — three grains times two
  // subjects. The choice lives in lib/queries.ts rather than here, because four
  // cards making it separately is four chances to make it differently; see the
  // note on useReportDowntimeEvents there for what the wrong one returns (a populated payload
  // about a different report, not an error).
  const { data, isPending, isError } = useReportDowntimeEvents(report);

  const state = selectDowntimeEventParetoState({
    // A LITERAL `true`, like quality-pareto-card.tsx and unlike the downtime
    // cards. Their params derive from a business day that can fail to parse, so
    // they have a real "nothing to ask for" state; this query is keyed on the
    // report id, which the route has by definition. `empty["no-params"]` is
    // written-but-unreachable copy, kept for the day the endpoint grows a
    // parameter — and the ladder keeps it FIRST regardless, because a gated
    // useQuery reports `status: "pending"` forever (lib/load-state.ts).
    hasParams: true,
    isPending,
    isError,
    data,
    // NOT `report.date`, which a line report does not have — see reportBusinessDay
    // for the three different places this day comes from.
    reportDate: reportBusinessDay(report),
  });

  const model = useMemo(() => buildDowntimeEventPareto(data), [data]);

  // Sorted independently of the chart's ranking: the chart answers "what do I fix
  // first", the table is a list someone reads in whatever order they chose.
  const rows = useMemo(() => sortDowntimeEventRows(model.bars, sort), [model.bars, sort]);

  // Paged in the browser, because the response is the complete result set — the
  // endpoint is unpaged and scoped to one machine's shift.
  const pageRows = useMemo(() => rows.slice((page - 1) * size, page * size), [rows, page, size]);

  const meta = useMemo(
    () => ({
      page,
      size,
      // THE THIRD COUNT ON THIS CARD, and it is neither of the other two.
      // `rows.length` is how many DISTINCT REASONS came back; `totalOccurrences`
      // is the total of the bars and `totalEvents` is the number of stops. Wiring
      // either of those in here would page a table by a number that is not its row
      // count.
      totalElements: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / size)),
      first: page === 1,
      last: page >= Math.ceil(rows.length / size),
    }),
    [rows.length, page, size],
  );

  function toggleSort(column: DowntimeEventSort["by"]) {
    setSort((current) =>
      current.by === column
        ? { by: column, dir: current.dir === "asc" ? "desc" : "asc" }
        : { by: column, dir: "desc" },
    );
    setPage(1);
  }

  const columns = useMemo(() => buildColumns(t, sort, toggleSort), [t, sort]);
  const tableMeta = useMemo(() => ({ page, size }), [page, size]);

  // One sentence, shared by the chart area and the table, so the two can never
  // tell the reader two different stories about the same empty result.
  const message = state === "ready" || state === "pending" ? undefined : othersEmpty(t, state);

  return (
    <div className="flex flex-col gap-4">
      {/* MACHINE REPORTS ONLY. The control offers "All Machine" plus THIS report's
          machine, which it reads off the report — a line report names no single
          machine, and building the list would need its roster. Omitted rather than
          rendered empty: a filter with one option that is also the only option is
          a control that does nothing. */}
      {isMachineReport(report) ? <MachineFilter report={report} /> : null}

      <Card className="gap-0 py-0">
        <CardHeader className="flex-wrap items-center gap-3 py-4">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            {t("report.othersParetoTitle")}
            <Tooltip>
              <TooltipTrigger>
                <InfoIcon className="text-muted-foreground size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("report.othersParetoHint")}</TooltipContent>
            </Tooltip>
          </CardTitle>

          {/* THE SLOT EVERY OTHER LOSS CARD GIVES TO ITS MeasureToggle, and there
              is deliberately no toggle in it.
              A one-option RadioGroup is a control that cannot change anything. It
              reads as either broken or as the first of several options that failed
              to render; it takes a tab stop and an aria-label ("Rank downtime
              reasons by") for a choice that does not exist; and MeasureToggle
              requires an `idPrefix` precisely because ids must not collide, so a
              decorative instance would put real ids in the document for no
              reader's benefit. Absence says "there is one measure". A single radio
              says "there is a choice", which is false. This is the same argument
              MachineFilter makes about rendering itself live rather than disabled.
              What occupies the slot instead is the sentence the whole tab turns on.
              One stop can cite several reasons, so THE BARS SUM TO OCCURRENCES AND
              NOT TO STOPS — and no arithmetic can convey that, because
              arithmetically the chart is simply correct. Only a sentence can. */}
          {state === "ready" ? (
            <p className="text-muted-foreground col-start-2 row-start-1 justify-self-end text-xs tabular-nums">
              {occurrenceSummaryText(t, model.totalOccurrences, model.totalEvents)}
            </p>
          ) : null}
        </CardHeader>

        <CardContent className="flex flex-col gap-4 pb-5">
          {state === "pending" ? <Skeleton className="h-[340px] w-full" /> : null}

          {/* Card-local, never an error boundary and never notFound(): the page is
              fine, only this breakdown is not. */}
          {message !== undefined ? (
            <div className="bg-muted text-muted-foreground flex min-h-9 w-full items-center justify-center rounded-sm px-3 py-2 text-center text-xs">
              {message}
            </div>
          ) : null}

          {state === "ready" ? (
            <Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
              <OthersParetoChart model={model} />
            </Suspense>
          ) : null}

          <DataTable
            columns={columns}
            rows={pageRows}
            getRowId={(row) => row.key}
            isPending={state === "pending"}
            isError={state === "error"}
            errorMessage={t("report.eventsError")}
            emptyMessage={message ?? t("report.noDowntimeEvents")}
            skeletonRows={size}
            meta={tableMeta}
          />

          <TablePagination
            page={page}
            size={size}
            meta={meta}
            onPageChange={setPage}
            onSizeChange={(next) => {
              setSize(next);
              setPage(1);
            }}
            pageSizes={PAGE_SIZES}
          />

          {/* Quotes the two numbers only when they are known, so an empty or failed
              card never footnotes "0 occurrences across 0 events" as if that were a
              finding. */}
          <p className="text-muted-foreground text-xs">
            {occurrenceFootnoteText(
              t,
              state === "ready" ? model.totalOccurrences : null,
              state === "ready" ? model.totalEvents : null,
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// Plain objects rather than createColumnHelper, matching its two siblings.
//
// FOUR COLUMNS AGAINST QUALITY LOSS'S SEVEN, and the omissions are the interesting
// part. Each one is named here so it is not "restored" from the card this was
// written from:
//
//   MACHINE NAME. Its two siblings carry it for reasons that do not hold here:
//     /downtimes/by-reason can span work units, so its bucket carries an ARRAY of
//     names, and the Quality design annotates the column "Should not empty". This
//     endpoint is report-scoped — one machine, always — so the column would repeat
//     one string on every row while MachineFilter directly above already names it.
//     DowntimeEventBar has no machineName field at all, which makes the decision
//     structural rather than a rendering choice.
//
//   CUMULATIVE %. It is a property of the CHART'S ranking, not of the table's
//     order. The table sorts independently — by reason ascending, say — and a
//     cumulative column under that sort shows a non-monotonic sequence that reads
//     as broken arithmetic. Neither sibling has one; the line on the chart is where
//     cumulative belongs.
//
//   TOTAL DURATION. There is no duration. oee.downtime_log_events records that a
//     reason was cited, not how long it lasted.
//
//   THE EYE BUTTON. See the note on the component above: the rows behind it would
//     be the wrong rows, which is more dangerous than Quality Loss's case, where
//     they simply did not exist.
function buildColumns(
  t: (key: string) => string,
  sort: DowntimeEventSort,
  onSort: (column: DowntimeEventSort["by"]) => void,
): ColumnDef<DowntimeEventBar, unknown>[] {
  return [
    indexColumn(),
    {
      id: "reason",
      header: () => (
        <SortHeader
          label={t("report.downtimeReason")}
          column="reason"
          sort={sort}
          onSort={onSort}
        />
      ),
      meta: { headerClassName: "min-w-52" },
      // The label rather than the raw reason, so the unattributed bucket reads
      // "Unspecified" instead of blank. lib/downtime-event-pareto.ts keeps the raw
      // value on the bar for anything that must not collide with that word.
      cell: ({ row }) => row.original.label,
    },
    {
      // "Occurrences", and NEVER "Freq." — which is what both sibling tables call
      // their count column. On those cards one record IS one stop, so "Freq."
      // reads correctly as a stop count. Here it does not: one stop appears in
      // several rows, so borrowing the abbreviation would import the wrong meaning
      // by association alone, in the one column a reader looks at first.
      id: "occurrences",
      header: () => (
        <SortHeader
          label={t("report.occurrences")}
          column="occurrences"
          sort={sort}
          onSort={onSort}
        />
      ),
      meta: NUMERIC,
      cell: ({ row }) => formatQuantity(row.original.occurrences, null),
    },
    {
      // NOT SORTABLE, and lib/downtime-event-pareto.ts says why: ordering by share
      // is IDENTICALLY the occurrences order, since both divide by one constant. A
      // second sortable column that silently duplicates an existing sort looks
      // independent and is not.
      //
      // It earns its place as the reader's own check on the denominator: these
      // shares total 100, which is only true against `totalOccurrences` and not
      // against the smaller event count beside it in the header.
      id: "share",
      header: t("common.share"),
      meta: NUMERIC,
      cell: ({ row }) =>
        row.original.sharePct === null ? EM_DASH : formatPercent(row.original.sharePct),
    },
  ];
}

export { OthersParetoCard };
