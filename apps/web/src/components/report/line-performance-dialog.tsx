import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { buildLineHourOfDayOutput, buildLineHourlyOutput } from "@/lib/perf-hourly";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HourlyProductionBody,
  HourlyProductionSkeleton,
} from "@/components/report/hourly-production-body";
import { useLineHourProfile, useLinePerformance } from "@/lib/queries";

import type { LineReportDetail } from "@/lib/types";

// The Line Losses card's `View` drill-down: hourly production in a dialog.
//
// A FRAME, and nothing else — everything drawn inside lives in
// hourly-production-body.tsx, shared with the machine dialog and with the Losses
// page's Trendline tab. What this owns is what a dialog owns: the query gated on
// `open`, so a visit that never presses View pays for neither the request nor the
// recharts chunk.
//
// ---------------------------------------------------------------------------
// THREE GRAINS, TWO SHAPES — the machine dialog's split, and the same two hooks
// line-hourly-production-card.tsx already picks between
// ---------------------------------------------------------------------------
//
// Shift and day return buckets keyed on an INSTANT; a month returns 24
// hour-of-DAY buckets keyed on a clock hour that occurred ~30 times, because ~720
// hourly points is not a line chart. React forbids a conditional hook, so both are
// called and the one out of play is gated off — which costs nothing and keeps the
// two cache keys separate, as they must be: a day 7 and a month 7 are different
// reports off different sequences.
//
// THIS FILE ARGUED THE OPPOSITE FOR A WHILE, and the argument is worth keeping
// because it was half right. It read: a month's equivalent "is a different shape
// with a different axis, and it belongs on the Losses page's Performance Loss →
// Trendline sub-tab rather than behind a card button. Exactly where the machine
// screen puts it, and for the same reason." The first sentence is still true — the
// shape IS different, which is why there are two builders. The second stopped being
// true when the machine card's month button went back in: the sub-tab is not an
// alternative to the card shortcut, it is the other end of the same drill-down, and
// the month screen is the one furthest from the hour. Both doors, at all three
// grains, on both subjects.
//
// It was ALSO the wrong reason for this file specifically. The real obstacle was
// that this dialog did not read
// GET /work-centers/month-reports/:id/hour-profile — an endpoint that already
// existed and already served the Trendline card — so the button would have opened
// an empty panel. That was a missing read, not a design choice, and it is what this
// closes.
//
// ---------------------------------------------------------------------------
// WHAT IT PLOTS, WHICH IS NOT WHAT THE MACHINE DIALOG PLOTS
// ---------------------------------------------------------------------------
//
// The OUTPUT side: `goodOut` and `effectiveOut`, plus the actual and standard
// rates. All four share the line's output unit, so they share one axis honestly.
//
// `totalOut` is INFEED — a different unit (0014, contract §16.4a) — and is
// deliberately not drawn. Migration 0018 and §19 both say it is "a CONTEXT
// series, never a numerator", and drawing bags against cartons on one axis is the
// exact failure the two-unit rule exists to prevent. See buildLineHourlyOutput.
function LinePerformanceDialog({
  report,
  open,
  onOpenChange,
}: {
  report: LineReportDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const isMonth = report.grain === "month";

  // BOTH HOOKS, ONE GATED — the shape line-hourly-production-card.tsx already
  // uses over the same two endpoints, so the dialog and the sub-tab cannot end up
  // reading different tables for the same report.
  //
  // `"shift"` is a PLACEHOLDER when the chronological query is gated off, and the
  // reason it is needed rather than being narrowed away is worth stating: testing
  // `report.grain !== "month"` does NOT produce a narrower object type, because
  // `LinePeriodReportDetail` carries `"day" | "month"` on one member. A gate that
  // reads is better than an intersection that lies.
  const chronological = useLinePerformance(
    report.grain === "day" ? "day" : "shift",
    report.id,
    open && !isMonth,
  );
  const profile = useLineHourProfile(report.id, open && isMonth);

  const { data, isPending, isError } = isMonth ? profile : chronological;

  // TWO BUILDERS, and everything below them is shared. They differ only in the
  // axis and the join key — a clock hour against an instant — while all of the
  // rate arithmetic (a rate is qty over the hours the line RAN, an average rate is
  // runtime-weighted, a missing bucket is null and never 0) lives once in
  // perf-hourly.ts. That is the part that must not exist twice.
  const model = useMemo(
    () =>
      data === undefined
        ? undefined
        : isMonth
          ? buildLineHourOfDayOutput(data)
          : buildLineHourlyOutput(data),
    [data, isMonth],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("report.hourlyProduction")}</DialogTitle>
          {/* Radix warns without a description, and this one earns its place: the
              chart cannot say what it is drawn from — and here it has TWO things
              extra to say. The series are the line's OUTPUT, so a reader who
              expected its infeed would wonder where the bags went; and at month
              grain the axis is a CLOCK HOUR rather than an instant, so a reader who
              took it for a chronology would read 30 days of production as one
              day's.

              THREE SENTENCES, NOT `grain === "shift" ? "shift" : "day"`, which is
              what this said while a month could not reach it. That form printed
              "each hour of the day" for a month — the fallback arm catching a grain
              it was never meant to serve. */}
          <DialogDescription className="text-xs">
            {isMonth
              ? t("report.lineHourlyDescMonth")
              : report.grain === "shift"
                ? t("report.lineHourlyDescShift")
                : t("report.lineHourlyDescDay")}
          </DialogDescription>
        </DialogHeader>

        {isPending ? <HourlyProductionSkeleton /> : null}

        {/* Card-local, matching the machine dialog. Never an error boundary and
            never notFound(): the report page is fine, only this drill-down is not. */}
        {isError ? (
          <div className="bg-muted text-muted-foreground flex h-9 w-full items-center justify-center rounded-sm text-xs">
            {t("report.hourlyLoadLine")}
          </div>
        ) : null}

        {data !== undefined && model !== undefined ? (
          <HourlyProductionBody report={report} model={model} source={data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export { LinePerformanceDialog };
