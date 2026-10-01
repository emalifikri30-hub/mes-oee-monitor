import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { selectLoadState } from "@/lib/load-state";
import { EM_DASH, formatQuantity } from "@/lib/format";
import { reportBusinessDay } from "@/lib/report-subject";
import { useAreaProductionUnits } from "@/lib/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { LoadState } from "@/lib/load-state";
import type { AreaReportDetail } from "@/lib/types";

// WHAT THE AREA CONSUMED AND SHIPPED, BROKEN OUT BY UNIT.
//
// ---------------------------------------------------------------------------
// WHY THIS CARD EXISTS BESIDE THE OVERVIEW, WHICH ALREADY HAS THREE TOTALS
// ---------------------------------------------------------------------------
//
// The requirement asks for two things that pull in opposite directions:
//
//   "{Area} Production, Total Production, and Finish Good use Weight Unit"
//   "Infeed unit on area it can be different, also the output unit. e.g. infeed:
//    bag/shot/etc; output: carton/bag/sack. user want to know sum of total
//    production in all infeed unit and sum of total output in all unit."
//
// One headline figure, and a breakdown across every unit the area's lines actually
// count in. The overview card answers the first — a MASS, because that is the only
// unit an area's members can all be expressed in. This answers the second, and it
// cannot be the same number: converting bags and sacks to kilograms and adding them
// is the right answer to "how much did the area make", and the wrong answer to "how
// many bags went in".
//
// ---------------------------------------------------------------------------
// WHY A TABLE AND NOT A CHART — THE RECOMMENDATION, STATED
// ---------------------------------------------------------------------------
//
// The requirement invited one ("you can give your recommendation for data
// visualization"), and the recommendation is deliberately the plainest thing:
// TWO SMALL TABLES, ONE PER SIDE, one row per unit.
//
// A bar chart is what this data most looks like and it is the one form that
// actively misleads here. Bars are read by COMPARING THEIR LENGTHS, and the
// quantities on this card are incommensurable by construction — 12,000 BAG beside
// 400 SACK says nothing about which is more material, and a chart would put them
// on one axis and invite exactly that reading. A stacked or grouped bar would be
// worse: it implies a total, and the total is the thing that does not exist in
// these units (that is what the overview card's mass figure is FOR).
//
// So: rows, each with its own unit label, sorted by unit code, with a count of the
// lines behind each. Nothing is totalled, no axis is shared, and there is nothing
// to compare by length. A reader who wants one number reads the card above.
//
// ---------------------------------------------------------------------------
// THE TWO SIDES ARE TWO TABLES, AND THAT IS NOT A LAYOUT CHOICE
// ---------------------------------------------------------------------------
//
// A line row carries an infeed unit AND an output unit, in two separate column
// groups (migration 0014), so "group by unit" is genuinely two questions over one
// row set. The payload keeps them apart and so does this card: one list with a
// side column would invite a reader to total it, and totalling across the two
// sides is the one arithmetic 0014 forbids — 100 bags in yielding 10 cartons out
// is not a 90% loss.
//
// The two tables also carry DIFFERENT MEASURES, which is why neither could be a
// parameterised render of the other: the infeed side has four (what was consumed,
// what the lines measured, reject, rework) and the output side two (what shipped,
// and that adjusted to standard).
//
// ---------------------------------------------------------------------------
// THE RESIDUALS ARE THE POINT OF THE FOOTNOTE
// ---------------------------------------------------------------------------
//
// A line whose unit the pipeline could not resolve has a NULL unit triple, and
// 0014's CHECK nulls its counts WITH it — so such a line contributes to NO bucket
// and is silently absent from this card. Without the two counts beside it, "this
// area's lines all count in BAG" and "half this area has no unit yet" are the same
// screen, and only the first is a statement about production. PER SIDE, because
// 0014's guards are per side: a line can be certain what it consumed and abstain
// about what it shipped.
//
// The six-state ladder is the one every other card on this screen uses, and it
// matters here for the usual reason: an area that genuinely counted nothing and one
// whose LINE reports have not loaded are opposite claims about an identical empty
// card, and `loadedThrough` — which names work_center_day_reports, not
// area_day_reports — is the only thing that separates them.
function emptyMessage(t: (key: string) => string, state: LoadState): string | undefined {
  switch (state) {
    case "error":
      return t("report.loadProductionBreakdown");
    case "empty-loaded":
      return t("report.noLineProduction");
    case "empty-stale":
      return t("report.productionBreakdownStale");
    case "pending":
    case "no-params":
    case "ready":
      return undefined;
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

function AreaProductionUnitsCard({ report }: { report: AreaReportDetail }) {
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = useAreaProductionUnits(report.grain, report.id);

  // ONE LADDER OVER BOTH SIDES. An area with an infeed unit and no output unit is
  // a POPULATED card with one empty table — not an empty card — so emptiness is
  // judged on the two lists together. Judging them separately would render the
  // "has not loaded yet" sentence inside a card that plainly had loaded.
  //
  // `hasParams: true` UNCONDITIONALLY, and that is honest rather than lazy: this
  // query is keyed on the report id alone, so there is nothing to derive and nothing
  // that can be missing. The `no-params` arm exists for the cards whose request is
  // built from a window — see selectLoadState's diagram, where a gated useQuery
  // reporting pending forever is the bug the ordering exists to prevent.
  const state = selectLoadState({
    hasParams: true,
    isPending,
    isError,
    data,
    reportDate: reportBusinessDay(report),
    isEmpty: (units) => units.infeed.length === 0 && units.output.length === 0,
  });

  const message = emptyMessage(t, state);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="py-4">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t("report.inputOutputProduction")}
          <Tooltip>
            <TooltipTrigger aria-label={t("report.aboutBreakdown")}>
              <InfoIcon className="text-muted-foreground size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t("report.unitsBreakdownHint")}</TooltipContent>
          </Tooltip>
        </CardTitle>
      </CardHeader>

      <CardContent className="pb-5">
        {/* `data === undefined` IS TESTED BESIDE `pending` RATHER THAN TRUSTED FROM
            THE LADDER. selectLoadState already returns "pending" for it, so this is
            redundant at runtime — and it is what narrows `data` for the ready arm
            below, which the compiler cannot get from `message !== undefined`. A
            non-null assertion would compile too and would be the version that
            breaks silently if the ladder's ordering ever changed. */}
        {state === "pending" || data === undefined ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-8 w-full" />
            ))}
          </div>
        ) : message !== undefined ? (
          <p className="text-muted-foreground py-6 text-center text-sm">{message}</p>
        ) : (
          <div className="grid grid-cols-1 gap-x-8 gap-y-6 xl:grid-cols-2">
            <UnitSection
              title={t("report.infeed")}
              caption={t("report.infeedCaption")}
              // The four infeed-side measures. `lineOut` is each line's own measured
              // production at its infeed count point (0015) and `totalOut` is what
              // it consumed; they answer different questions, and neither is derived
              // from the other.
              columns={[
                t("report.totalProduction"),
                t("report.lineProduction"),
                t("report.reject"),
                t("report.rework"),
              ]}
              rows={data.infeed.map((bucket) => ({
                key: bucket.uomId,
                unit: bucket.uomCode ?? bucket.uomName,
                lines: bucket.workCenterCount,
                values: [bucket.totalOut, bucket.lineOut, bucket.reject, bucket.rework],
              }))}
              unresolved={data.infeedUnresolved}
            />
            <UnitSection
              title={t("report.output")}
              caption={t("report.outputCaption")}
              columns={[t("report.finishGood"), t("report.effectiveProduction")]}
              rows={data.output.map((bucket) => ({
                key: bucket.uomId,
                unit: bucket.uomCode ?? bucket.uomName,
                lines: bucket.workCenterCount,
                values: [bucket.goodOut, bucket.effectiveOut],
              }))}
              unresolved={data.outputUnresolved}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type UnitRow = {
  key: number;
  unit: string | null;
  lines: number;
  values: number[];
};

// ONE SIDE'S TABLE. Takes its columns and rows as DATA — no `side` flag — so it
// cannot know which of the two it is rendering and cannot come to treat them
// differently. That is the rule losses-card-shell.tsx and metrics-card.tsx both
// state; here it also means the two column sets, which genuinely differ in length,
// are declared at the call site beside the fields they name.
function UnitSection({
  title,
  caption,
  columns,
  rows,
  unresolved,
}: {
  title: string;
  caption: string;
  columns: string[];
  rows: UnitRow[];
  unresolved: number;
}) {
  const { t } = useTranslation("oee");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-xs">{caption}</p>
      </div>

      {/* `overflow-x-auto` on the table's own wrapper, per the responsive rule: a
          table may be wider than the page, the page body may not scroll sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-xs">
              <th className="py-2 pr-4 text-left font-normal">{t("report.unit")}</th>
              <th className="py-2 pr-4 text-right font-normal">{t("report.lines")}</th>
              {columns.map((column) => (
                <th key={column} className="py-2 pr-4 text-right font-normal whitespace-nowrap">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 2}
                  className="text-muted-foreground py-4 text-center text-xs"
                >
                  {t("report.noUnitResolved")}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  {/* The unit is the row's IDENTITY, so it is rendered as the row
                      header rather than repeated into each cell — which is the
                      other half of why this is a table and not a chart. */}
                  <th scope="row" className="py-2 pr-4 text-left font-medium">
                    {row.unit ?? EM_DASH}
                  </th>
                  <td className="text-muted-foreground py-2 pr-4 text-right tabular-nums">
                    {row.lines}
                  </td>
                  {row.values.map((value, index) => (
                    <td
                      key={columns[index]}
                      className="py-2 pr-4 text-right tabular-nums whitespace-nowrap"
                    >
                      {/* `formatQuantity` WITH A NULL UNIT, so the number is
                          formatted by the same function every other figure in this
                          app goes through — the unit is the row's header here, and
                          repeating it in every cell is what makes a table read as a
                          chart's tooltip. */}
                      {formatQuantity(value, null)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* THE RESIDUAL, AND IT IS SAID ONLY WHEN IT IS NON-ZERO. Zero is the healthy
          state and a permanent "0 lines excluded" line would be noise that trains a
          reader to skip the place the real warning appears. */}
      {unresolved > 0 ? (
        <p className="text-muted-foreground text-xs">
          {unresolved === 1
            ? t("report.lineExcludedOne", { side: title.toLowerCase() })
            : t("report.linesExcluded", { count: unresolved, side: title.toLowerCase() })}
        </p>
      ) : null}
    </div>
  );
}

export { AreaProductionUnitsCard };
