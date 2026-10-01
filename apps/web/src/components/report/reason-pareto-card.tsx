import { Suspense, lazy, useMemo, useState } from "react";
import { EyeIcon, InfoIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatDuration } from "@/lib/format";
import { LOSS_CATEGORY_COPY } from "@/lib/loss-category";
import { buildPareto, selectParetoState, sortReasonRows } from "@/lib/pareto";
import { reasonDetailSearch } from "@/lib/reason-search";
import { reasonBreakdownParams, reasonBreakdownQuery, useDowntimeReasons } from "@/lib/queries";
import { isMachineReport, reportBusinessDay } from "@/lib/report-subject";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/table/data-table";
import { indexColumn } from "@/components/table/index-column";
import { MachineFilter } from "@/components/report/machine-filter";
import { MeasureToggle } from "@/components/report/measure-toggle";
import { Skeleton } from "@/components/ui/skeleton";
import { SortHeader } from "@/components/table/sort-header";
import { TablePagination } from "@/components/table/table-pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ColumnDef } from "@tanstack/react-table";
import type { MeasureOption } from "@/components/report/measure-toggle";
import type { ParetoBar, ParetoMeasure, ReasonSort } from "@/lib/pareto";
import type { DowntimeCategory } from "@/lib/types";
import type { LossCategoryCopy } from "@/lib/loss-category";
import type { LossesDetailTo, AnyReport } from "@/lib/report-subject";

// SPLIT OUT OF THE ENTRY CHUNK, and NOT because autoCodeSplitting is off — it is
// on. recharts is the heaviest dependency in the app and only the report screens
// need it, but route-level splitting alone does not keep it out: the chart cards
// live in three different route chunks, so rolldown lifts recharts to their common
// ancestor, which IS the entry chunk. Measured — deleting these boundaries takes
// the entry from 395 kB back to 781 kB.
//
// This `lazy()` is what gives recharts an async chunk of its own. The reasoning
// lives once beside the flag in vite.config.ts; TODOS.md §26 has the numbers.
const ReasonParetoChart = lazy(() =>
  import("@/components/report/reason-pareto-chart").then((m) => ({
    default: m.ReasonParetoChart,
  })),
);

// Smaller steps than the full-page tables: this one is nested in a card, and the
// design shows a handful of rows. Same ladder as downtime-details-card.tsx.
const PAGE_SIZES = [5, 10, 25, 50] as const;

const NUMERIC = { cellClassName: "tabular-nums" } as const;

// The two measures a DOWNTIME Pareto ranks by. A module constant rather than an
// inline literal, so the array identity is stable across renders and the toggle
// is not handed a new list every time this card re-renders.
//
// The Quality Loss Pareto has four, and its own list — see lib/quality-loss.ts
// and the note on ParetoMeasure in lib/pareto.ts for why the two unions stay
// apart.
function downtimeMeasures(t: (key: string) => string): readonly MeasureOption<ParetoMeasure>[] {
  return [
    { value: "duration", label: t("report.rankByDuration") },
    { value: "frequency", label: t("report.rankByFrequency") },
  ];
}

function lossCopy(t: (key: string) => string, category: DowntimeCategory): LossCategoryCopy {
  const bandVar = LOSS_CATEGORY_COPY[category].bandVar;
  switch (category) {
    case "UNPLANNED":
      return {
        lossName: t("report.availabilityLoss"),
        paretoTitle: t("report.unplannedDowntimePareto"),
        paretoHint: t("report.unplannedParetoHint"),
        stopsLabel: t("report.unplannedStops"),
        bandVar,
        empty: {
          "no-params": t("report.reasonNoParams"),
          "empty-loaded": t("report.noUnplannedDowntime"),
          "empty-stale": t("report.unplannedStale"),
          error: t("report.unplannedError"),
        },
      };
    case "PLANNED":
      return {
        lossName: t("report.scheduleLoss"),
        paretoTitle: t("report.plannedDowntimePareto"),
        paretoHint: t("report.plannedParetoHint"),
        stopsLabel: t("report.plannedStops"),
        bandVar,
        empty: {
          "no-params": t("report.reasonNoParams"),
          "empty-loaded": t("report.noPlannedDowntime"),
          "empty-stale": t("report.plannedStale"),
          error: t("report.plannedError"),
        },
      };
    case "SMALL_STOP":
      return {
        lossName: t("report.smallStop"),
        paretoTitle: t("report.smallStopPareto"),
        paretoHint: t("report.smallStopParetoHint"),
        stopsLabel: t("report.smallStops"),
        bandVar,
        empty: {
          "no-params": t("report.reasonNoParams"),
          "empty-loaded": t("report.noSmallStops"),
          "empty-stale": t("report.smallStopStale"),
          error: t("report.smallStopError"),
        },
      };
    default: {
      const unhandled: never = category;
      return unhandled;
    }
  }
}

// A whole Loss tab: which machine, how to rank, the Pareto, and the table of the
// same rows.
//
// ONE CARD OVER `category`, serving Availability Loss (UNPLANNED) and Schedule
// Loss (PLANNED) from the same endpoint — which is exactly why `category` is a
// query parameter on GET /downtimes/by-reason rather than a hardcoded literal;
// downtime-dto.ts says so where the default is set. The two tabs differ in three
// things and nothing else: which records the server returns, the band colour, and
// the words. All three come from `category` — the last two through
// LOSS_CATEGORY_COPY, so a tab cannot be given another tab's sentences.
//
// WHAT THIS CARD DELIBERATELY DOES NOT RENDER: a grand total. The figure it
// would be read against — the Losses card's `Availability Loss` or `Schedule
// Loss` tile — comes from the ETL's aggregate columns on
// oee.work_unit_shift_reports, while every number here comes from
// oee.downtime_reports. They are two independent sources and they will not
// reconcile. The timeline strip already refuses to render a total of its own for
// exactly this reason; the cumulative line is a share, which claims nothing about
// the other source, and the footnote below names the right tile and says so.
function ReasonParetoCard({
  report,
  category,
  detailTo,
}: {
  report: AnyReport;
  // The drill-down's route, per subject AND grain — see LossesDetailTo. Passed
  // rather than derived: the machine literal compiles on a line page and opens an
  // unrelated report.
  detailTo: LossesDetailTo;
  category: DowntimeCategory;
}) {
  const { t } = useTranslation("oee");
  const [measure, setMeasure] = useState<ParetoMeasure>("duration");
  const [sort, setSort] = useState<ReasonSort>({ by: "duration", dir: "desc" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);

  const copy = lossCopy(t, category);
  const measures = downtimeMeasures(t);

  // Via `reasonBreakdownParams`, NOT composed here. The Losses page's loader
  // prefetches through the same function, and if the two ever built the object
  // differently the prefetched entry would be one nobody reads — a second request
  // and a skeleton flash on a page that had already fetched, with nothing else to
  // show for it. `category` riding inside is also what puts it in the query key,
  // so the two tabs are two cache entries.
  const params = useMemo(() => reasonBreakdownParams(report, category), [report, category]);

  // THE MEASURE IS PART OF THE REQUEST NOW, not just of the rendering.
  //
  // It used to be pure UI state: the endpoint returned every bucket and this card
  // re-ranked them with a reduce over ten numbers, which is why the toggle cost
  // nothing. The endpoint is truncated now (TODOS §25) and returns the top N BY
  // THIS MEASURE, so the top ten by duration are a different ten from the top ten
  // by frequency — re-ranking a duration-limited set by frequency would draw the
  // wrong bars under a cumulative line that still looked right.
  //
  // So the toggle costs a round trip. Each measure is its own cache entry, so it
  // costs it once: toggling back is instant, and a closed shift is immutable and
  // cached for the session.
  const query = useMemo(() => reasonBreakdownQuery(params, measure), [params, measure]);
  const { data, isPending, isError } = useDowntimeReasons(query);

  const state = selectParetoState({
    hasParams: params !== undefined,
    isPending,
    isError,
    data,
    // NOT `report.date`, which a line report does not have — see reportBusinessDay.
    reportDate: reportBusinessDay(report),
  });

  const model = useMemo(() => buildPareto(data, measure), [data, measure]);

  // Sorted independently of the chart's ranking: the chart answers "what do I
  // fix first", the table is a list someone reads in whatever order they chose.
  const rows = useMemo(() => sortReasonRows(model.bars, sort), [model.bars, sort]);

  // Paged in the browser, because the response is the complete result set — the
  // endpoint is unpaged and scoped to one machine's shift.
  const pageRows = useMemo(() => rows.slice((page - 1) * size, page * size), [rows, page, size]);

  const meta = useMemo(
    () => ({
      page,
      size,
      totalElements: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / size)),
      first: page === 1,
      last: page >= Math.ceil(rows.length / size),
    }),
    [rows.length, page, size],
  );

  function toggleSort(column: ReasonSort["by"]) {
    setSort((current) =>
      current.by === column
        ? { by: column, dir: current.dir === "asc" ? "desc" : "asc" }
        : { by: column, dir: "desc" },
    );
    setPage(1);
  }

  const columns = useMemo(
    () => buildColumns(t, sort, toggleSort, report.id, category, detailTo),
    [t, sort, report.id, category, detailTo],
  );
  const tableMeta = useMemo(() => ({ page, size }), [page, size]);

  // One sentence, shared by the chart area and the table, so the two can never
  // tell the reader two different stories about the same empty result.
  const message = state === "ready" || state === "pending" ? undefined : copy.empty[state];

  return (
    <div className="flex flex-col gap-4">
      {/* MACHINE REPORTS ONLY — the same note others-pareto-card.tsx carries. The
          control offers "All Machine" plus THIS report's machine, read off the
          report; a line names no single machine. */}
      {isMachineReport(report) ? <MachineFilter report={report} /> : null}

      <Card className="gap-0 py-0">
        <CardHeader className="flex-wrap items-center gap-3 py-4">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            {copy.paretoTitle}
            <Tooltip>
              <TooltipTrigger>
                <InfoIcon className="text-muted-foreground size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{copy.paretoHint}</TooltipContent>
            </Tooltip>
          </CardTitle>
          <div className="col-start-2 row-start-1 justify-self-end">
            <MeasureToggle
              measure={measure}
              onChange={setMeasure}
              options={measures}
              // PREFIXED WITH THE CATEGORY, because these are `htmlFor` targets —
              // the reason the prop is required is written where the component is.
              idPrefix={`pareto-${category.toLowerCase()}`}
              ariaLabel={t("report.rankDowntimeReasons")}
            />
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 pb-5">
          {state === "pending" ? <Skeleton className="h-[340px] w-full" /> : null}

          {/* Card-local, never an error boundary and never notFound(): the page
              is fine, only this breakdown is not. */}
          {message !== undefined ? (
            <div className="bg-muted text-muted-foreground flex min-h-9 w-full items-center justify-center rounded-sm px-3 py-2 text-center text-xs">
              {message}
            </div>
          ) : null}

          {state === "ready" ? (
            <Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
              <ReasonParetoChart model={model} appearance={copy} />
            </Suspense>
          ) : null}

          <DataTable
            columns={columns}
            rows={pageRows}
            getRowId={(row) => row.key}
            isPending={state === "pending"}
            isError={state === "error"}
            errorMessage={copy.empty.error}
            emptyMessage={message ?? copy.empty["empty-loaded"]}
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

          {/* The reconciliation note. Without it, the obvious next question —
              "why do these minutes not add up to Availability Loss?" — has no
              answer on screen. It names the tile for THIS category, because
              pointing a Schedule Loss reader at the Availability Loss figure
              would invite exactly the arithmetic the note exists to head off. */}
          <p className="text-muted-foreground text-xs">
            {t("report.rankedFromDowntime", { loss: copy.lossName })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// Plain objects rather than createColumnHelper, matching downtime-details-card.tsx.
function buildColumns(
  t: (key: string, opts?: Record<string, string | number>) => string,
  sort: ReasonSort,
  onSort: (column: ReasonSort["by"]) => void,
  reportId: number,
  category: DowntimeCategory,
  detailTo: LossesDetailTo,
): ColumnDef<ParetoBar, unknown>[] {
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
      cell: ({ row }) => row.original.label,
    },
    {
      id: "machine",
      header: t("report.machineName"),
      cell: ({ row }) => row.original.machineName ?? EM_DASH,
    },
    {
      // "Freq." per the design. The card header says "unplanned stops" so this
      // cannot be confused with the Downtime Details card's "Downtime Frequency"
      // one click away, which counts all three categories and is legitimately a
      // different number.
      id: "frequency",
      header: t("report.freq"),
      meta: NUMERIC,
      cell: ({ row }) => row.original.frequency,
    },
    {
      id: "duration",
      header: () => (
        <SortHeader
          label={t("report.totalDuration")}
          column="duration"
          sort={sort}
          onSort={onSort}
        />
      ),
      meta: NUMERIC,
      cell: ({ row }) => formatDuration(row.original.durationMs),
    },
    {
      id: "actions",
      header: "",
      meta: { headerClassName: "w-10" },
      // Opens the individual stops behind this bar.
      //
      // The search is built by `reasonDetailSearch`, next to the parse that has to
      // read it back — which is where the two traps it avoids are written down:
      // the raw reason rather than the rendered label, and the category carried so
      // the drill-down cannot answer a different question than the bar was drawn
      // from (a planned reason listing unplanned stops, with nothing on screen
      // saying so).
      // NO DRILL-DOWN ON THE "OTHER" ROW, and this is the one branch here worth
      // reading twice. That row stands for every reason outside the top N, so it
      // names no bucket the detail endpoint could resolve — and its `reason` is
      // null, which is ALSO the unlabelled bucket's value and a perfectly valid
      // selector. A link built from it would therefore not fail: it would open
      // the UNSPECIFIED bucket's records under a heading saying "Other", which is
      // the quiet kind of wrong. `isOther` is the only thing that separates the
      // two, so it is what this reads.
      //
      // Inert rather than absent, following line-report-table.tsx's rule for a
      // cell with nowhere to go: aria-hidden and out of the tab order, so it is
      // not announced as an action that does nothing.
      cell: ({ row }) =>
        row.original.isOther ? (
          <span aria-hidden="true" className="text-muted-foreground/40 inline-flex px-2">
            <EyeIcon className="size-4" />
          </span>
        ) : (
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label={t("report.viewBucket", { label: row.original.label })}
          >
            <Link
              to={detailTo}
              params={{ reportId: String(reportId) }}
              search={reasonDetailSearch(row.original, category)}
            >
              <EyeIcon />
            </Link>
          </Button>
        ),
    },
  ];
}

export { ReasonParetoCard };
