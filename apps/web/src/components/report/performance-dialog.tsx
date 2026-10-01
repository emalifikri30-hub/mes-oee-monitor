import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { buildHourlyOutput, buildHourOfDayOutput } from "@/lib/perf-hourly";
import {
  useMonthReportHourProfile,
  usePeriodReportPerformance,
  useShiftReportPerformance,
} from "@/lib/queries";
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

import type { HourOfDayProfile, ReportDetail, ShiftPerformance } from "@/lib/types";

type PerformanceDialogProps = {
  report: ReportDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// The Losses card's `View` drill-down: the hourly production profile in a dialog.
//
// A FRAME, and nothing else. Everything drawn inside it lives in
// hourly-production-body.tsx, because the Losses page's Performance Loss →
// Trendline tab renders exactly the same thing in a card — see that file for why
// the split falls here. What this file still owns is what a dialog owns: the
// query gated on `open`, so a visit that never clicks View pays for neither the
// request nor the recharts chunk.
//
// REACHED AT ALL THREE GRAINS. The card's View button was gated to shift and day
// for a while after this dialog had already learned to serve a month, so the month
// arm below was live code with no caller — see losses-card.tsx for that history.
function PerformanceDialog({ report, open, onOpenChange }: PerformanceDialogProps) {
  const { t } = useTranslation("oee");
  // THREE GRAINS, TWO PAYLOAD SHAPES, ONE MODEL. Shift and day return hourly
  // buckets keyed on an instant; a month returns 24 hour-of-day buckets keyed on a
  // clock hour, because ~720 hourly points is not a line chart. The two builders
  // differ only in the axis and the join key — every bit of the rate arithmetic
  // below them is shared.
  //
  // React forbids calling a hook conditionally, so all three are called and the
  // two that do not apply are gated off with `enabled: false`. That costs nothing
  // and keeps the three cache keys separate, which they must be: a shift 7, a day
  // 7 and a month 7 are different reports.
  const isShift = report.grain === "shift";
  const isMonth = report.grain === "month";

  const shiftQuery = useShiftReportPerformance(report.id, open && isShift);
  const dayQuery = usePeriodReportPerformance(report.id, open && !isShift && !isMonth);
  const monthQuery = useMonthReportHourProfile(report.id, open && isMonth);

  const { data, isPending, isError } = isMonth ? monthQuery : isShift ? shiftQuery : dayQuery;

  const model = useMemo(
    () =>
      data === undefined
        ? undefined
        : isMonth
          ? buildHourOfDayOutput(data as HourOfDayProfile)
          : buildHourlyOutput(data as ShiftPerformance),
    [data, isMonth],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("report.hourlyProduction")}</DialogTitle>
          {/* Radix warns without a description, and this one earns its place: the
              chart cannot say what it is drawn from — and at MONTH grain it has
              something extra to say, because the axis is a CLOCK HOUR rather than
              an instant. A reader who took it for a chronology would read 30 days
              of production as one day's.

              THREE SENTENCES, NOT `isShift ? "shift" : "day"`, which is what this
              said while the month was unreachable from the card. It printed "each
              hour of the day" over a chart whose points are each ~30 days of that
              hour averaged — plausible, and wrong about what it was showing. */}
          <DialogDescription className="text-xs">
            {isMonth
              ? t("report.hourlyDescMonth")
              : isShift
                ? t("report.hourlyDescShift")
                : t("report.hourlyDescDay")}
          </DialogDescription>
        </DialogHeader>

        {isPending ? <HourlyProductionSkeleton /> : null}

        {/* Card-local, matching sku-view-card.tsx. Never an error boundary and never
            notFound(): the report page is fine, only this drill-down is not. */}
        {isError ? (
          <div className="bg-muted text-muted-foreground flex h-9 w-full items-center justify-center rounded-sm text-xs">
            {t("report.hourlyLoadReport")}
          </div>
        ) : null}

        {data !== undefined && model !== undefined ? (
          <HourlyProductionBody report={report} model={model} source={data} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export { PerformanceDialog };
