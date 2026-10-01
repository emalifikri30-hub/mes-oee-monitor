import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, TrendingUpIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { LossesCardShell } from "@/components/report/losses-card-shell";
import { PerformanceDialog } from "@/components/report/performance-dialog";

import type { ReportDetail } from "@/lib/types";

// Where a MACHINE's time went.
//
// The layout, the three groups and the reasoning behind them live in
// losses-card-shell.tsx, shared with the Line card. What stays here is the part
// that is about a machine: which route the drill-down opens, that all its counts
// share ONE unit of measure, and WHICH hourly chart there is to open.
//
// BOTH DRILL-DOWNS NOW RESOLVE AT EVERY GRAIN, which was not true of either when
// this card was written — and the LINE card still differs on the second: it has no
// month hour-profile endpoint (there is no /work-centers/month-reports/:id/
// hour-profile), so its View button stays shift-and-day. That asymmetry is a
// missing read at line grain, not a design choice, and the comment there says so.
function LossesCard({ report }: { report: ReportDetail }) {
  const { t } = useTranslation("oee");
  const [open, setOpen] = useState(false);

  // One route literal per grain. A ternary of literals keeps the union narrow
  // enough for `Link to`, so a renamed route is a build failure.
  //
  // OFFERED AT EVERY GRAIN, and the target is CHOSEN BY GRAIN rather than
  // hardcoded. That is the whole hazard here: the route interpolates THIS report's
  // id, and the three report tables have independent `serial` sequences — so a
  // by-shift route given a day report's id opens an unrelated shift report, about
  // possibly a different machine on a different date, and the page looks entirely
  // normal. Nothing errors. losses-card.test.tsx asserts the id lands in the right
  // one.
  const lossesTo =
    report.grain === "shift"
      ? "/report/machine/by-shift/$reportId/losses"
      : report.grain === "day"
        ? "/report/machine/by-day/$reportId/losses"
        : "/report/machine/by-monthly/$reportId/losses";

  return (
    <>
      <LossesCardShell
        losses={report}
        // ONE UNIT FOR BOTH COUNTS, which is true of a machine and only of a
        // machine — a work unit has one count point. The line card passes its
        // INFEED unit to both, because that is the side reject and rework sit on.
        reject={formatQuantity(report.reject, report.uomName)}
        rework={formatQuantity(report.rework, report.uomName)}
        detailLink={
          <Button asChild variant="ghost" size="icon-sm">
            <Link to={lossesTo} params={{ reportId: String(report.id) }}>
              <ExternalLinkIcon />
              <span className="sr-only">{t("report.openLosses")}</span>
            </Link>
          </Button>
        }
        // OFFERED AT EVERY GRAIN, and a month gets a DIFFERENT chart rather than a
        // longer one.
        //
        // THIS HAS BEEN BOTH WAYS AND THE HISTORY IS THE ARGUMENT. It was absent at
        // month grain originally, on the sound reasoning that the dialog draws an
        // hour-BY-hour chart — 8 points over a shift, 24 over a day, and ~720 over
        // a month, which no line chart can show. The hour-of-DAY profile that
        // answers the month's version of the question shipped alongside it
        // (`/month-reports/:id/hour-profile`, TODOS §23), and the button was
        // enabled; a follow-up then removed it again, arguing the profile "belongs
        // on the Losses page's Performance Loss -> Trendline sub-tab" and that a
        // month report should reach it through the external-link icon instead.
        //
        // THAT LAST STEP WAS WRONG IN PRACTICE, and it is what the owner reported
        // as a missing feature. The month screen is the one where a reader most
        // needs the shortcut — it is the furthest from the hour — and requiring two
        // navigations to reach a chart that exists and is already wired reads as the
        // feature being absent. The sub-tab keeps rendering it; this is a second
        // door to the same room, which is exactly what the shift and day screens
        // have.
        //
        // The dialog picks its own endpoint AND its own model builder from the
        // grain, so nothing here needs to know which chart it opens.
        hourly={
          <Button variant="outline" size="xs" onClick={() => setOpen(true)}>
            {t("common.view")}
            <TrendingUpIcon className="size-3.5" />
            <span className="sr-only">{t("report.hourlyProductionDetail")}</span>
          </Button>
        }
      />

      {/* Mounted unconditionally but inert until `open`: the query is gated on it
          and the chart chunk is lazy, so a closed dialog costs neither a request
          nor a download. Owned by the card rather than the route for the same
          reason — it is not prefetched, so the route has nothing to say about it.

          NO GRAIN GATE. All three are served — see the button above — and the
          dialog gates each of its three queries on `open` plus its own grain, so
          the two that do not apply issue nothing. */}
      <PerformanceDialog report={report} open={open} onOpenChange={setOpen} />
    </>
  );
}

export { LossesCard };
