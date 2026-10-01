import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, TrendingUpIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { LossesCardShell } from "@/components/report/losses-card-shell";
import { LinePerformanceDialog } from "@/components/report/line-performance-dialog";
import { LineQualityEntryDialog } from "@/components/report/line-quality-entry-dialog";
import { QualityAction } from "@/components/report/quality-action";
import { QualityEntriesSheet } from "@/components/report/quality-entries-sheet";
import { qualityAddress } from "@/lib/report-subject";
import { useQualityEntries } from "@/lib/queries";

import type { LineReportDetail, QualityEntryKind } from "@/lib/types";

// Where a LINE's time went.
//
// The layout is losses-card-shell.tsx's, shared with the machine card. Three
// things differ here, and each is a fact about the subject rather than a styling
// choice.
//
// 1. REJECT AND REWORK TAKE THE INFEED UNIT. A line has two count points and they
//    are usually in different units — bags in, cartons out (0014, contract §16.4a)
//    — and these two sit on the infeed side with `total_out`. Passing the output
//    unit would render cartons under a bag label: a wrong number that looks
//    entirely ordinary, which is why the shell formats nothing itself.
//
// 2. THE HOURLY CHART IS AT EVERY GRAIN, matching the machine card again — and a
//    month gets a DIFFERENT chart rather than a longer one, 24 hour-of-day points
//    collapsed from ~720. `LinePerformanceDialog` picks its endpoint and its model
//    builder from the grain.
//
//    IT WAS SHIFT-AND-DAY UNTIL THE READ EXISTED IN THE DIALOG, which is the
//    distinction worth keeping. The month endpoint
//    (`/work-centers/month-reports/:id/hour-profile`) has served the Losses page's
//    Trendline sub-tab since migration 0018; the dialog simply did not read it, so
//    the button would have opened an empty panel. That was a MISSING READ PATH
//    rather than a design choice, and the comment here said to close it by wiring
//    the endpoint rather than by "restoring consistency" in the other direction.
//    This is that.
//
//    WHAT IT PLOTS DIFFERS FROM THE MACHINE'S THOUGH, at every grain. It draws the
//    OUTPUT side — goodOut and effectiveOut against the standard, all in the line's
//    output unit — and leaves `totalOut` out, because that is INFEED and a
//    different unit (0014, contract §16.4a). Drawing bags against cartons on one
//    axis is the failure the two-unit rule exists to prevent; see
//    buildLineHourlyOutput for why that beat two Y axes.
//
//    It reads oee.product_perf_wc_hour (0018), which ships EMPTY — so until
//    Airflow fills it the dialog opens on the honest "not loaded yet" state
//    rather than on a flat line at zero. `loadedThrough` is what tells the two
//    apart.
//
// 3. THE TWO ADD BUTTONS ARE REAL, at every grain. Part 2 shipped them DISABLED
//    with a tooltip, as a deliberate and documented exception to
//    report-actions.tsx's rule that a disabled action means nobody designed it.
//    That exception is over: the write path exists (migration 0017, contract §18)
//    and the buttons open the entry dialog.
//
//    THE BUTTON AND ITS LEDGER LINE NOW LIVE IN quality-action.tsx, because the
//    SKU card renders the same pair. It moved rather than being copied because it
//    is mostly PROSE — the tooltip explaining why the tile did not move — and two
//    copies drifting means two screens telling operators different things about
//    the same pipeline run.
//
// ---------------------------------------------------------------------------
// THE LEDGER LINE, AND WHY THE TILE ABOVE IT DOES NOT MOVE
// ---------------------------------------------------------------------------
//
// An entry does NOT change the tile: the reported figures are composed by the
// PIPELINE through contract §18's override join, so the Reject tile is what the
// last DAG run wrote until the next one. The full argument, and the copy that
// carries it to the operator, are in quality-action.tsx — the one place both this
// card and the SKU one read it from.
function LineLossesCard({ report }: { report: LineReportDetail }) {
  const { t } = useTranslation("oee");
  const [adding, setAdding] = useState<QualityEntryKind | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [hourly, setHourly] = useState(false);

  const lossesTo =
    report.grain === "shift"
      ? "/report/line/by-shift/$reportId/losses"
      : report.grain === "day"
        ? "/report/line/by-day/$reportId/losses"
        : "/report/line/by-monthly/$reportId/losses";

  const address = qualityAddress(report);
  const ledger = useQualityEntries(address);

  // Live totals per kind, in the entry's TARGET unit — which is the line's infeed
  // unit, the same one the tile is denominated in. Bucketed per unit upstream, so
  // a second bucket here means the line's unit changed between two entries; the
  // line renders each on its own rather than adding them, for the reason §16.4
  // gives everywhere else.
  const pending = (kind: QualityEntryKind) =>
    (ledger.data?.totals ?? []).filter((total) => total.kind === kind);

  return (
    <>
      <LossesCardShell
        losses={report}
        reject={formatQuantity(report.reject, report.infeedUomName)}
        rework={formatQuantity(report.rework, report.infeedUomName)}
        detailLink={
          <Button asChild variant="ghost" size="icon-sm">
            <Link to={lossesTo} params={{ reportId: String(report.id) }}>
              <ExternalLinkIcon />
              <span className="sr-only">{t("report.openLosses")}</span>
            </Link>
          </Button>
        }
        // See 2 above. Every grain, matching the machine card — the dialog picks
        // which of the two reads answers.
        hourly={
          <Button variant="outline" size="xs" onClick={() => setHourly(true)}>
            {t("common.view")}
            <TrendingUpIcon className="size-3.5" />
            <span className="sr-only">{t("report.hourlyProductionDetail")}</span>
          </Button>
        }
        rejectAction={
          <QualityAction
            kind="reject"
            totals={pending("reject")}
            onAdd={() => setAdding("reject")}
            onBrowse={() => setBrowsing(true)}
          />
        }
        reworkAction={
          <QualityAction
            kind="rework"
            totals={pending("rework")}
            onAdd={() => setAdding("rework")}
            onBrowse={() => setBrowsing(true)}
          />
        }
      />

      {/* Mounted only while open, so the three catalogue queries inside it cost
          nothing on a page view — and so its per-open `requestId` is genuinely
          per-open rather than per-mount. */}
      {adding !== null ? (
        <LineQualityEntryDialog
          report={report}
          kind={adding}
          open
          onOpenChange={(next) => {
            if (!next) setAdding(null);
          }}
        />
      ) : null}

      {/* THE ONLY PLACE AN ENTRY CAN BE CORRECTED. Mounted only while open, like
          the dialog: it reads the ledger WITH voided rows, which is a second cache
          entry, and a closed copy would fetch it on every page view. */}
      {browsing ? <QualityEntriesSheet address={address} open onOpenChange={setBrowsing} /> : null}

      {/* Mounted only while open, so a visit that never presses View pays for
          neither the request nor the recharts chunk — which is also why there is no
          grain gate here: the dialog calls both of its hooks unconditionally (React
          forbids a conditional one) and gates each on `open` plus its own grain, so
          an unmounted dialog issues nothing at any grain. */}
      {hourly ? <LinePerformanceDialog report={report} open onOpenChange={setHourly} /> : null}
    </>
  );
}

export { LineLossesCard };
