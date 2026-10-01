import { Suspense, lazy, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildWaterfallRows } from "@/lib/waterfall";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import type { WaterfallMeasures } from "@/lib/waterfall";

// SPLIT OUT OF THE ENTRY CHUNK, and NOT because autoCodeSplitting is off — it is
// on. recharts is the heaviest dependency in the app and only the report screens
// need it, but route-level splitting alone does not keep it out: the chart cards
// live in three different route chunks, so rolldown lifts recharts to their common
// ancestor, which IS the entry chunk. Measured — deleting these boundaries takes
// the entry from 395 kB back to 781 kB.
//
// This `lazy()` is what gives recharts an async chunk of its own. The reasoning
// lives once beside the flag in vite.config.ts; TODOS.md §26 has the numbers.
const WaterfallChart = lazy(() =>
  import("@/components/report/waterfall-chart").then((m) => ({ default: m.WaterfallChart })),
);

// Takes the MEASURES rather than a report, so the same card serves a machine and
// a line. See WaterfallMeasures for why that narrowing is safe — this chart reads
// thirteen durations and nothing that differs between the two subjects.
function WaterfallCard({ report }: { report: WaterfallMeasures }) {
  const { t } = useTranslation("oee");
  const [showAnomaly, setShowAnomaly] = useState(false);

  const rows = useMemo(() => {
    const built = buildWaterfallRows(report, { showAnomaly });
    return built.map((row) => ({
      ...row,
      category: WATERFALL_CATEGORY[row.key] ? t(WATERFALL_CATEGORY[row.key]) : row.category,
      sublabel: WATERFALL_SUB[row.key] ? t(WATERFALL_SUB[row.key]) : row.sublabel,
      segments: row.segments.map((segment) => ({
        ...segment,
        label: WATERFALL_SEGMENT[segment.label]
          ? t(WATERFALL_SEGMENT[segment.label])
          : segment.label,
      })),
    }));
  }, [report, showAnomaly, t]);

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="py-4">
        <CardTitle className="text-sm">{t("report.waterfall")}</CardTitle>
        <div className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end">
          <Checkbox
            id="show-anomaly"
            checked={showAnomaly}
            onCheckedChange={(checked) => setShowAnomaly(checked === true)}
          />
          <Label htmlFor="show-anomaly" className="text-xs font-normal">
            {t("report.showAnomaly")}
          </Label>
        </div>
      </CardHeader>
      <CardContent className="pb-5">
        <Suspense fallback={<Skeleton className="h-[340px] w-full" />}>
          <WaterfallChart rows={rows} />
        </Suspense>
      </CardContent>
    </Card>
  );
}

const WATERFALL_CATEGORY: Record<string, string> = {
  calendar: "report.wfCalendar",
  loading: "report.wfLoading",
  operating: "report.wfOperating",
  "net-operating": "report.wfNetOperating",
  "value-added": "report.wfValueAddedHours",
  "finish-good": "report.finishGood",
};

const WATERFALL_SUB: Record<string, string> = {
  calendar: "report.wfCalendarSub",
  loading: "report.wfLoadingSub",
};

const WATERFALL_SEGMENT: Record<string, string> = {
  "Availability Time": "report.wfAvailabilityTime",
  "Production Time": "report.wfProductionTime",
  "Planned Downtime": "report.wfPlannedDowntime",
  "Operating Time": "report.wfOperating",
  "Unplanned Downtime": "report.wfUnplannedDowntime",
  "Net Operating Time": "report.wfNetOperating",
  "Small Stop": "report.smallStop",
  "Reduce Speed": "report.reduceSpeed",
  "Value Added Hour": "report.wfValueAddedHour",
  Reject: "report.reject",
  Rework: "report.rework",
  Anomaly: "report.wfAnomaly",
  "Up Speed": "report.wfUpSpeed",
};

export { WaterfallCard };
