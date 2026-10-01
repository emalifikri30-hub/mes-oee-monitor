import { useTranslation } from "react-i18next";

import { formatDuration } from "@/lib/format";
import { CATEGORY_TEXT_CLASS } from "@/lib/downtime";
import { cn } from "@/lib/utils";
import { HourlyProductionCard } from "@/components/report/hourly-production-card";
import { LossSection } from "@/components/report/loss-section";
import { LineHourlyProductionCard } from "@/components/report/line-hourly-production-card";
import { ReasonParetoCard } from "@/components/report/reason-pareto-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { LossesDetailTo, AnyReport } from "@/lib/report-subject";

// WHICH VIEW, as a URL param. Same reasoning as the Losses page's `tab`: this is
// which question the page is ABOUT, so a shared link reopens the same chart.
const VIEWS = [
  { value: "pareto", labelKey: "report.pareto" },
  { value: "trendline", labelKey: "report.trendline" },
] as const;

type LossView = (typeof VIEWS)[number]["value"];

const DEFAULT_VIEW: LossView = "pareto";

// Underline tabs, not the pill list the loss tabs above use, per the design —
// and the design is right: a second pill bar directly under the first would read
// as two rows of one control. Achieved with className overrides on the shared
// primitives, which is how this codebase varies them elsewhere rather than by
// growing a variant prop.
const SUBTAB_LIST = "h-auto gap-6 rounded-none bg-transparent p-0";
const SUBTAB_TRIGGER =
  "flex-none rounded-none border-0 border-b-2 border-transparent px-1 pb-2 text-sm font-normal data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:shadow-none dark:data-[state=active]:bg-transparent";

// THE WHOLE PERFORMANCE LOSS TAB, and it is the one loss tab that is not a
// single Pareto — because Performance Loss is two halves answering to two
// different sources:
//
//   Small Stop    -> oee.downtime_reports, category = 'SMALL_STOP'. Per-cause,
//                    so it ranks: <ReasonParetoCard />, the same component
//                    Availability Loss and Schedule Loss render, with the
//                    drill-down behind every bar that comes with it.
//   Reduce Speed  -> oee.work_unit_shift_reports.reduce_speed_loss_time. ONE
//                    SCALAR. There is no per-cause table for it anywhere in
//                    Gold, so it cannot be ranked and does not pretend to be.
//
// Both are named on screen because Performance Loss is their sum, and a tab
// showing only the half that happens to be rankable would read as the whole
// figure. TODOS.md §24 is where the gap is written down.
//
// The Pareto card is NOT wrapped in a band of its own, though the reference
// design draws one. lib/loss-category.ts already titles it "Small Stop Pareto"
// and points its footnote at the Small Stop tile — deliberately, so it cannot
// promise a reconciliation against the whole factor — so a band captioned
// "Small Stop" around it would be the third time that phrase appeared on one
// screen. The card IS the first half; the band below is the second.
function PerformanceLossTab({
  report,
  detailTo,
  view,
  onViewChange,
}: {
  report: AnyReport;
  detailTo: LossesDetailTo;
  view: LossView;
  onViewChange: (next: LossView) => void;
}) {
  const { t } = useTranslation("oee");
  return (
    <Tabs value={view} onValueChange={(next) => onViewChange(next as LossView)}>
      <TabsList className={cn(SUBTAB_LIST, "self-center")}>
        {VIEWS.map((item) => (
          <TabsTrigger key={item.value} value={item.value} className={SUBTAB_TRIGGER}>
            {t(item.labelKey)}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="pareto">
        <div className="flex flex-col gap-4">
          <ReasonParetoCard report={report} category="SMALL_STOP" detailTo={detailTo} />
          <ReduceSpeedSection report={report} />
        </div>
      </TabsContent>

      <TabsContent value="trendline">
        {/* PRESENT BUT EMPTY AT LINE GRAIN, and the sub-tab still appears — so the
            bar does not change shape between subjects, and a reader who expects the
            view gets told why rather than finding it missing.
            
            There is no line performance endpoint. It needs product_perf_wu_hour
            rolled up by work_center_id AND the line's two uom triples on those rows,
            so the chart can tell which series belongs to which axis: a line consumes
            bags and ships cartons, and lib/perf-hourly.ts plots both against ONE
            shared quantity domain. Contract §16.4a states both halves; TODOS §61
            carries it. */}
        {/* TWO CARDS, ONE PER SUBJECT, and the choice lives here rather than
            inside one widened card because the two read DIFFERENT ENDPOINTS off
            DIFFERENT id sequences. A line report's id handed to a work-unit
            performance endpoint does not 404 in the general case — it returns
            some machine's hours, on some other date, drawn without a warning.
            Keeping the pick at the call site is what lets a test assert which
            function was called. (No glob in this comment: the closing slash
            would end it.)

            This arm used to be an empty panel saying hourly production "is not
            available for a line yet". True when written, false since migration
            0018 and its endpoints — see line-hourly-production-card.tsx. */}
        {/* THE MACHINE ARM IS THE POSITIVE ONE, deliberately. This read
            `isLineReport(report) ? Line : Machine` until 2026-09-02, i.e. "not a
            line, therefore a machine" — a reading that is only true while there
            are two subjects. Asking `isMachineReport` instead means a third
            subject lands in the else branch, where LineHourlyProductionCard's prop
            type refuses it and the build fails, rather than being silently handed
            a machine card. */}
        {/* FOUR SUBJECTS, AND TWO OF THEM ARE AN EMPTY STATE RATHER THAN A CARD.
            Neither a SKU report nor an AREA report has an hourly production chart,
            and the two reasons are different — see EmptyTrendline, which takes the
            subject and says which.

            Rendering the LINE card in either arm would have compiled if this were
            still a binary `else`; it did not, because the prop type refused
            SkuReportDetail and then AreaReportDetail. That refusal is the whole
            reason the machine arm was made the positive one. */}
        {report.subject === "machine" ? (
          /* `isActive` gates the request, so the Pareto view costs neither the
             hourly payload nor the recharts chunk. */
          <HourlyProductionCard report={report} isActive={view === "trendline"} />
        ) : report.subject === "line" ? (
          <LineHourlyProductionCard report={report} isActive={view === "trendline"} />
        ) : (
          /* THE SUB-TAB STILL APPEARS, and that is deliberate: the tab bar must
             not change shape between subjects, or a reader moving from a line to
             a SKU or an area sees a control vanish and reads it as a bug. TODOS §61
             is the line-grain version of the same argument.

             THE AREA REQUIREMENT ASKED FOR IT "without performance loss ->
             trendline tab", and this is that read as being about the CONTENT rather
             than the chrome: there is no curve to draw, and the view says so. If
             the intent was to remove the sub-tab bar on that one screen, this is
             the line to change — and §61's argument would then be one screen
             narrower. */
          <EmptyTrendline subject={report.subject} />
        )}
      </TabsContent>
    </Tabs>
  );
}

// The other half of Performance Loss, and the honest version of it.
//
// A TOTAL AND A SENTENCE, deliberately — not a Pareto with one bar, and not
// hidden. `reduce_speed_loss_time` is an ETL aggregate on the shift report; no
// table in Gold records WHY a machine ran slow, so there is nothing to rank and
// no eye button to offer. Saying that on screen is what stops a reader
// concluding that the Small Stop ranking above is all of Performance Loss.
//
// The figure is shown AS-IS, including when it is negative: reduce-speed loss
// goes below zero when the machine outran its standard rate, which is real data.
// losses-card.tsx renders the same number under the same rule.
function ReduceSpeedSection({ report }: { report: AnyReport }) {
  const { t } = useTranslation("oee");
  // OPEN by default. The content is two lines, and one of them is the disclaimer
  // that stops the ranking above being read as the whole of Performance Loss —
  // folding that away by default would hide the only thing this section exists
  // to say. The fold is there because the design draws one, and because a reader
  // who has taken the point can put it away.
  return (
    <LossSection label={t("report.reduceSpeed")} defaultOpen>
      <div className="flex flex-col gap-2 px-4 py-4">
        <p className="text-sm">
          <span className="text-muted-foreground">{t("common.total")} </span>
          <span className={cn("font-medium tabular-nums", CATEGORY_TEXT_CLASS.SMALL_STOP)}>
            {formatDuration(report.reduceSpeedLossTime)}
          </span>
        </p>
        <p className="text-muted-foreground text-xs">{t("report.reduceSpeedNote")}</p>
      </div>
    </LossSection>
  );
}

export { DEFAULT_VIEW, PerformanceLossTab, VIEWS };
export type { LossView };

// Performance Loss's Trendline at SKU and AREA grain.
//
// TWO SUBJECTS, TWO DIFFERENT REASONS, AND THE COPY SAYS WHICH — because "not shown
// here" and "cannot be shown here" are different promises and a reader deciding
// whether to file a bug needs to know which one they are looking at.
//
//   SKU   THE DATA EXISTS. oee.product_perf_wc_hour is the LINE's hourly production
//         PER SKU and would answer this directly; the requirement excludes an
//         hourly chart from the SKU screen, so nothing fetches it. A future
//         requirement could turn this on with no schema work.
//   AREA  THE DATA DOES NOT EXIST. There is no product_perf_area_hour table, and an
//         area-summed curve off the LINE hourly table would be the roll-up contract
//         §19.1 refuses one grain down — it would not integrate to the totals in
//         the card above the chart. That is a schema ask, not a flag.
//
// Both point the reader at the line's report, which is where the curve actually is.
// An empty CHART in either case would read as "this produced nothing all day",
// which is the flattering wrong answer these panels exist to avoid.
function EmptyTrendline({ subject }: { subject: "sku" | "area" }) {
  const { t } = useTranslation("oee");
  return (
    <div className="text-muted-foreground flex min-h-[240px] flex-col items-center justify-center gap-1 rounded-xl border p-6 text-center text-sm">
      {subject === "sku" ? <p>{t("report.noHourlyOnSku")}</p> : <p>{t("report.areaNoHourly")}</p>}
      <p>{t("report.openLineForHourly")}</p>
    </div>
  );
}
