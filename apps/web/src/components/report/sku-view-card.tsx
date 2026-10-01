import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { selectLoadState } from "@/lib/load-state";
import { skuTiles } from "@/lib/product-count";
import { reportBusinessDay } from "@/lib/report-subject";
import type { AnyReport } from "@/lib/report-subject";
import { useReportProducts } from "@/lib/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricTile } from "@/components/report/metric-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { LoadState } from "@/lib/load-state";
import type { ProductCountItem } from "@/lib/types";

// What the SUBJECT actually made, broken out by SKU — from oee.product_count_wu_*
// for a machine and oee.product_count_wc_* for a line.
//
// TWO FAMILIES OF TABLES RATHER THAN A ROLL-UP OVER ONE, and that is the design
// decision this card is downstream of. A line is MEASURED, not summed (0014,
// commit 4fccce8): it has its own count points, so `line <> sum(machines)`. The
// overview card sits DIRECTLY ABOVE this one and renders the line's own
// total_out / good_out — so a SKU View rolled up from the machines would print
// per-SKU figures that visibly disagree with the card above them, on the same
// screen, and the disagreement would be CORRECT. That is unexplainable to a
// supervisor, and no read-time query can fix it. Only the line's own per-product
// count points reconcile. Contract §17; migration 0016.
//
// THE LINE TABLES SHIP EMPTY. Airflow fills them, and until it does this card's
// `empty-stale` arm is the true one at line grain — which is exactly what §14's
// ladder was built to be able to say. There is deliberately NO dev seed: the only
// derivation available is the roll-up, so a seed would teach the invariant this
// table exists to deny.
//
// This is the same output the card above reports as one number, split by product —
// so the two can be read against each other, but only loosely: the figures here
// are converted per product using that product's own factor_to_base, while the
// card above reports the window in the report's OWN unit. A machine has one such
// unit; a line has two, an infeed and an output (contract §16.4a), which makes the
// looseness wider there rather than different in kind.
//
// The units are not uniform WITHIN a row either, and that is the one thing a reader
// has to know before doing arithmetic on this card: Total Output, Reject and Rework
// are in the product's base unit, Finish Good is in the unit it was counted in. The
// tooltip says so, and lib/product-count.ts is where the pairing is decided and
// tested.
//
// A SHIFT THAT PRODUCED NOTHING AND ONE WHOSE ETL HAS NOT RUN ARE NOW DIFFERENT
// STATES, and this comment used to say the opposite: "not something the browser
// can distinguish". It was true, and it was the defect — those are opposite
// claims and the card made the flattering one for both. TODOS §14.
//
// What changed is the payload: /products returns an object carrying
// `loadedThrough`, so the same six-state ladder every other card on this screen
// uses can tell them apart. core-api still meters product_count_empty_total,
// which is what says so without anybody opening the page.
// One message per state that has one. `ready` and `pending` render content rather
// than text, so they are absent by design — the same shape reason-detail-card uses.
//
// THE TWO EMPTY MESSAGES ARE THE POINT OF THE CARD'S EXISTENCE HERE. They are
// opposite claims about the same empty list, and until §14 both read as the first.
const EMPTY_MESSAGE: Partial<Record<LoadState, string>> = {
  error: "report.loadSkuSummary",
  "empty-loaded": "report.noProductOutput",
  // SUBJECT-NEUTRAL, deliberately: "an idle machine" was true of the only caller
  // this card had, and at line grain it would name the wrong thing entirely.
  "empty-stale": "report.skuOutputStale",
};

const TILE_LABEL: Record<string, string> = {
  "Total Output": "report.totalOutput",
  "Finish Good": "report.finishGood",
  Reject: "report.reject",
  Rework: "report.rework",
};

function SkuViewCard({ report }: { report: AnyReport }) {
  const { t } = useTranslation("oee");
  // THREE HOOKS, ONE PICKED — and this card SHIPPED WITH THE GRAIN HALF OF THAT
  // WRONG, which is worth keeping recorded because the failure was not a 404 in
  // the general case. The dispatch lives in `useReportProducts` now, so the two
  // axes are decided in one place; what follows is why it cannot be a template.
  //
  // SEVEN report tables, SIX independent `serial` sequences. Reaching the wrong one
  // has two outcomes and the quiet one is the dangerous half:
  //
  //   nothing has that id       ->  404, an error card. Visible.
  //   something does            ->  200, and a populated card. On the grain axis
  //                                 that is another date; on the SUBJECT axis it
  //                                 is a machine's SKUs under a line's heading —
  //                                 and because the line tables ship EMPTY, the
  //                                 wrong entry is the only one that renders any
  //                                 numbers at all, which makes it look like the
  //                                 working case.
  //
  // sku-view-card.test.tsx therefore asserts WHICH api function was called, not
  // that rows appeared.
  const { data, isPending, isError } = useReportProducts(report);

  // `hasParams` is always true: this query takes the report id alone and is never
  // gated, unlike the drill-downs. It stays in the call because the ladder's ORDER
  // is what is wrong when this is wrong, and dropping the first rung locally is
  // how a second copy comes to disagree with the shared one.
  const state = selectLoadState({
    hasParams: true,
    isPending,
    isError,
    data,
    // The business day this report covers, from whichever of the three sources
    // holds it — see `reportBusinessDay`. A line's is NOT NULL and zone-free; a
    // machine SHIFT report has only an instant, and calling that a business day
    // is the wrong-day bug TODOS §17 records.
    reportDate: reportBusinessDay(report),
    isEmpty: (counts) => counts.items.length === 0,
  });

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="py-4">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t("report.skuView")}
          <Tooltip>
            <TooltipTrigger>
              <InfoIcon className="text-muted-foreground size-3.5" />
            </TooltipTrigger>
            {/* `align="start"` and a width cap, because the trigger sits at the far
                left of a full-width card: a centre-aligned tooltip this long runs off
                the left edge of the viewport and gets clipped. */}
            <TooltipContent align="start" className="max-w-xs">
              {t("report.skuViewHint")}
            </TooltipContent>
          </Tooltip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-5">
        {state === "pending" ? <SkuSkeleton /> : null}

        {/* Card-local, like the timeline: the route starts this request without
            awaiting it, so a failure here costs this card and nothing else. The
            error keeps its filled treatment; the two empty states are ordinary
            copy, because an empty shift is not a fault. */}
        {state === "error" ? (
          <div className="bg-muted text-muted-foreground flex h-9 w-full items-center justify-center rounded-sm text-xs">
            {t(EMPTY_MESSAGE.error!)}
          </div>
        ) : null}

        {state === "empty-loaded" || state === "empty-stale" ? (
          <p className="text-muted-foreground text-xs">{t(EMPTY_MESSAGE[state]!)}</p>
        ) : null}

        {/* Unbounded on purpose: even at the widest address here — a line over a
            month — this is the SKU MIX, not a row per unit produced. Truncating
            real production figures to protect the layout would be the worse
            failure; core-api records product_count_rows so a growing mix shows up
            as data rather than as a long page. */}
        {data?.items.map((item, index) => (
          <SkuBlock key={item.productId} item={item} index={index} />
        ))}
      </CardContent>
    </Card>
  );
}

// The numbering is positional, not stored: core-api orders by product name, and
// this renders that order.
function SkuBlock({ item, index }: { item: ProductCountItem; index: number }) {
  const { t } = useTranslation("oee");
  return (
    <div className={index > 0 ? "border-t pt-4" : undefined}>
      <p className="text-sm font-semibold">
        {index + 1}. {item.productName}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {skuTiles(item).map((tile) => (
          <MetricTile
            key={tile.label}
            label={TILE_LABEL[tile.label] ? t(TILE_LABEL[tile.label]) : tile.label}
            value={tile.value}
            valueClassName={tile.valueClassName}
          />
        ))}
      </div>
    </div>
  );
}

function SkuSkeleton() {
  return (
    <div>
      <Skeleton className="h-5 w-32" />
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}

export { SkuViewCard };
