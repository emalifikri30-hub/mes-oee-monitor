import { Suspense, lazy, useMemo, useState } from "react";
import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EM_DASH, formatQuantity } from "@/lib/format";
import {
  buildQualityPareto,
  selectQualityParetoState,
  sortQualityRows,
} from "@/lib/quality-pareto";
import { QUALITY_MEASURE_ORDER, QUALITY_MEASURES } from "@/lib/quality-loss";
import { useReportRejects } from "@/lib/queries";
import { isMachineReport, reportBusinessDay } from "@/lib/report-subject";
import type { AnyReport } from "@/lib/report-subject";
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
import type { QualityBar, QualityMeasure, QualitySort } from "@/lib/quality-pareto";

// SPLIT OUT OF THE ENTRY CHUNK, and NOT because autoCodeSplitting is off — it is
// on. recharts is the heaviest dependency in the app and only the report screens
// need it, but route-level splitting alone does not keep it out: the chart cards
// live in three different route chunks, so rolldown lifts recharts to their common
// ancestor, which IS the entry chunk. Measured — deleting these boundaries takes
// the entry from 395 kB back to 781 kB.
//
// This `lazy()` is what gives recharts an async chunk of its own. The reasoning
// lives once beside the flag in vite.config.ts; TODOS.md §26 has the numbers.
const QualityParetoChart = lazy(() =>
  import("@/components/report/quality-pareto-chart").then((m) => ({
    default: m.QualityParetoChart,
  })),
);

// Same ladder as reason-pareto-card.tsx and downtime-details-card.tsx: this table
// is nested in a card and the design shows a handful of rows.
const PAGE_SIZES = [5, 10, 25, 50] as const;

const NUMERIC = { cellClassName: "tabular-nums" } as const;

// The four measures, in the order lib/quality-loss.ts fixes. A module constant so
// the array identity is stable across renders.
function qualityMeasureOptions(
  t: (key: string) => string,
): readonly MeasureOption<QualityMeasure>[] {
  const labels: Record<QualityMeasure, string> = {
    quantity: t("report.rankByQuantity"),
    weight: t("report.rankByWeight"),
    frequency: t("report.rankByFrequency"),
    duration: t("report.rankByDuration"),
  };
  return QUALITY_MEASURE_ORDER.map((measure) => ({
    value: measure,
    label: labels[measure],
  }));
}

function qualityEmpty(
  t: (key: string) => string,
  state: "no-params" | "empty-loaded" | "empty-stale" | "error",
): string {
  switch (state) {
    case "no-params":
      return t("report.rejectsNoParams");
    case "empty-loaded":
      return t("report.noRejects");
    case "empty-stale":
      return t("report.rejectsStale");
    case "error":
      return t("report.rejectsError");
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

// The Quality Loss tab's Pareto: which machine, how to rank, the chart, and the
// table of the same rows.
//
// STRUCTURALLY ReasonParetoCard, and NOT a fourth `category` on it. Three things
// differ, and each is load-bearing rather than cosmetic:
//
//   * FOUR MEASURES against two, so four denominators and four formatters.
//   * TWO UNIT-BEARING COLUMNS for one fact — what the sensor counted, and the
//     same rejects converted — where every downtime row has one duration.
//   * NO DRILL-DOWN. The design shows no eye button and there is nothing behind
//     one: /rejects is a per-counter aggregate and the reporting database has no
//     per-reject record table, so the button would open a page that cannot exist.
//
// WHAT THIS CARD DELIBERATELY DOES NOT RENDER: a grand total. Same reasoning as
// its sibling, one step stronger. The figures it would be read against — the
// Losses card's Quality Loss, Reject and Rework tiles — come from the ETL's
// aggregate columns on the shift row, while every number here comes from the
// per-counter reject table scaled by each row's own conversion factor. They are
// independent sources and they will not reconcile. The cumulative line is a
// share, which claims nothing about the other source, and the footnote says so
// outright rather than hedging.
function QualityParetoCard({ report }: { report: AnyReport }) {
  const { t } = useTranslation("oee");
  // `quantity` first: this Pareto exists to rank how MUCH was rejected, and
  // `duration` is the one measure with no source behind it yet.
  const [measure, setMeasure] = useState<QualityMeasure>("quantity");
  const [sort, setSort] = useState<QualitySort>({ by: "quantity", dir: "desc" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const measureOptions = useMemo(() => qualityMeasureOptions(t), [t]);

  // No params composer, because there are no params: the report id is the whole
  // request. lib/api.ts says why that is worth noticing rather than merely being
  // simpler.
  // ONE HOOK, WHICH PICKS AMONG SIX ENDPOINTS — three grains times two
  // subjects. The choice lives in lib/queries.ts rather than here, because four
  // cards making it separately is four chances to make it differently; see the
  // note on useReportRejects there for what the wrong one returns (a populated payload
  // about a different report, not an error).
  const { data, isPending, isError } = useReportRejects(report);

  const state = selectQualityParetoState({
    // A LITERAL `true`, unlike the downtime cards. Their params derive from a
    // business day that can fail to parse, so they have a real "nothing to ask
    // for" state; this query is keyed on the report id, which the route has by
    // definition. `empty["no-params"]` is written-but-unreachable copy, kept for
    // the day the endpoint grows a parameter.
    hasParams: true,
    isPending,
    isError,
    data,
    // NOT `report.date`, which a line report does not have — see reportBusinessDay
    // for the three different places this day comes from.
    reportDate: reportBusinessDay(report),
  });

  const model = useMemo(
    // The report's own machine is the fallback for a bucket whose name did not
    // resolve — see buildQualityPareto, which explains why that is not a guess.
    // NULL AT LINE GRAIN, deliberately. This is the fallback machine name for a
    // bucket whose own rows disagree about it, and a line has no single machine to
    // fall back to — so the cell stays an em dash rather than naming an arbitrary
    // one of several. buildQualityPareto already treats null that way.
    () => buildQualityPareto(data, measure, isMachineReport(report) ? report.workUnitName : null),
    [data, measure, report],
  );

  // Sorted independently of the chart's ranking: the chart answers "what do I fix
  // first", the table is a list someone reads in whatever order they chose.
  const rows = useMemo(() => sortQualityRows(model.bars, sort), [model.bars, sort]);

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

  function toggleSort(column: QualitySort["by"]) {
    setSort((current) =>
      current.by === column
        ? { by: column, dir: current.dir === "asc" ? "desc" : "asc" }
        : { by: column, dir: "desc" },
    );
    setPage(1);
  }

  const columns = useMemo(
    () => buildColumns(t, sort, toggleSort, model.convertedUnit),
    [t, sort, model.convertedUnit],
  );
  const tableMeta = useMemo(() => ({ page, size }), [page, size]);

  // One sentence, shared by the chart area and the table, so the two can never
  // tell the reader two different stories about the same empty result.
  const message = state === "ready" || state === "pending" ? undefined : qualityEmpty(t, state);

  // Only worth saying once the rows are actually on screen.
  const showMixedUnitNote = state === "ready" && model.convertedUnit === null;

  return (
    <div className="flex flex-col gap-4">
      {/* MACHINE REPORTS ONLY — see the identical note in others-pareto-card.tsx.
          The control is built from the report's own machine, which a line does not
          have. */}
      {isMachineReport(report) ? <MachineFilter report={report} /> : null}

      <Card className="gap-0 py-0">
        <CardHeader className="flex-wrap items-center gap-3 py-4">
          <CardTitle className="flex items-center gap-1.5 text-sm">
            {t("report.qualityLossPareto")}
            <Tooltip>
              <TooltipTrigger>
                <InfoIcon className="text-muted-foreground size-3.5" />
              </TooltipTrigger>
              <TooltipContent>{t("report.qualityParetoHint")}</TooltipContent>
            </Tooltip>
          </CardTitle>
          <div className="col-start-2 row-start-1 justify-self-end">
            <MeasureToggle
              measure={measure}
              onChange={setMeasure}
              options={measureOptions}
              // "quality" is not a DowntimeCategory, so this cannot collide with
              // a downtime card's ids however many are mounted at once.
              idPrefix="pareto-quality"
              ariaLabel={t("report.rankRejectReasons")}
            />
          </div>
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

          {/* Said rather than hidden. The alternative considered and rejected was
              disabling the `quantity` radio when units are mixed — a disabled
              control with no explanation reads as broken, which is the argument
              MachineFilter already makes about rendering itself live. The
              cumulative line stays honest either way: it is a share of the
              response's own total, which the browser did not invent. */}
          {showMixedUnitNote ? (
            <p className="text-muted-foreground text-xs">{t("report.mixedUnitNote")}</p>
          ) : null}

          {state === "ready" ? (
            <Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
              <QualityParetoChart model={model} />
            </Suspense>
          ) : null}

          <DataTable
            columns={columns}
            rows={pageRows}
            getRowId={(row) => row.key}
            isPending={state === "pending"}
            isError={state === "error"}
            errorMessage={t("report.rejectsError")}
            emptyMessage={message ?? t("report.noRejects")}
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

          <p className="text-muted-foreground text-xs">{t("report.qualityFootnote")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// Plain objects rather than createColumnHelper, matching reason-pareto-card.tsx.
//
// Column order is the design's: the machine, then the counter, then what it
// weighed, then what it counted, then that converted, then how often.
function buildColumns(
  t: (key: string, options?: Record<string, string>) => string,
  sort: QualitySort,
  onSort: (column: QualitySort["by"]) => void,
  convertedUnit: string | null,
): ColumnDef<QualityBar, unknown>[] {
  return [
    indexColumn(),
    {
      // The design annotates this column "Should not empty", which is why
      // buildQualityPareto fills it from the report rather than em-dashing. The
      // em dash below is the last resort for a report whose own machine name did
      // not resolve either.
      id: "machine",
      header: t("report.machineName"),
      cell: ({ row }) => row.original.machineName ?? EM_DASH,
    },
    {
      id: "reason",
      header: () => (
        <SortHeader label={t("report.rejectReason")} column="reason" sort={sort} onSort={onSort} />
      ),
      meta: { headerClassName: "min-w-52" },
      // VERBATIM. `Total_NG_Prod` is the name on the machine's own HMI, and
      // prettifying it would break the one string a reader can match against it.
      cell: ({ row }) => row.original.label,
    },
    {
      id: "weight",
      header: () => (
        <SortHeader label={t("common.weight")} column="weight" sort={sort} onSort={onSort} />
      ),
      meta: NUMERIC,
      // Null renders as an em dash — "not weighed", as against a genuine `0 gr`.
      cell: ({ row }) => QUALITY_MEASURES.weight.format(row.original.weightGram, null),
    },
    {
      // NOT SORTABLE, and lib/quality-pareto.ts says why: counter units differ per
      // row, so ordering 48 CALENDER against 4776 BAG would rank unlike things and
      // give a column that looks sorted and is not. The Converted column beside it
      // is the one that can be ordered.
      id: "counter",
      header: t("report.counterUnit"),
      meta: NUMERIC,
      cell: ({ row }) =>
        row.original.counterUnit === null
          ? EM_DASH
          : formatQuantity(row.original.counterValue, row.original.counterUnit),
    },
    {
      id: "quantity",
      header: () => (
        <SortHeader
          // Names the unit when the shift has ONE, so the reader is not asked to
          // guess what "converted" converted to. Falls back to a bare label on a
          // mixed-unit shift, where the note above the chart carries the
          // explanation instead.
          label={
            convertedUnit === null
              ? t("report.converted")
              : t("report.convertedUnit", { unit: convertedUnit })
          }
          column="quantity"
          sort={sort}
          onSort={onSort}
        />
      ),
      meta: NUMERIC,
      cell: ({ row }) =>
        QUALITY_MEASURES.quantity.format(row.original.quantity, row.original.convertedUnit),
    },
    {
      // "Freq." per the design, matching the downtime Pareto's column.
      id: "frequency",
      header: () => (
        <SortHeader label={t("report.freq")} column="frequency" sort={sort} onSort={onSort} />
      ),
      meta: NUMERIC,
      cell: ({ row }) => row.original.frequency,
    },
  ];
}

export { QualityParetoCard };
