import { useTranslation } from "react-i18next";

import { SEGMENT_CLASS } from "@/lib/downtime";
import { selectLoadState } from "@/lib/load-state";
import { useShiftTimeline } from "@/lib/queries";
import { Card, CardContent } from "@/components/ui/card";
import { TimelineStrip } from "@/components/report/timeline-strip";
import { Skeleton } from "@/components/ui/skeleton";

import type { ShiftTimelineParams } from "@/lib/api";

// Where the shift's time actually went, minute by minute, from
// oee.downtime_reports.
//
// Two things worth knowing before trusting a number off this strip:
//
//  1. It is ILLUSTRATIVE, not authoritative. The Losses card reads the ETL's
//     aggregate columns on oee.work_unit_shift_reports; this reads the raw
//     downtime records and merges them. They are two independent sources, and
//     the merge rule below guarantees they diverge — so the strip deliberately
//     never renders a total. Losses stays the number of record.
//
//  2. Overlaps resolve to the WEAKER category (run time > small stop > planned >
//     unplanned). Where a planned window overlaps an unplanned stop, the band is
//     blue. That inverts the conventional OEE reading and is a product decision;
//     the rule itself lives in core-api's SEGMENT_PRIORITY.
//
// 3. A SHIFT WITH NO DOWNTIME RECORDS NO LONGER RENDERS AS ONE FULL GREEN BAND
//    REGARDLESS. This comment used to say those two cases were "indistinguishable
//    here by design", which was true and was the single silent failure in this
//    feature: a shift that was down for hours rendered as flawless, with no error,
//    no empty state, and no test that could catch it. TODOS.md §8 filed it, and
//    option 7B was chosen knowingly at the time over 7A.
//
//    The endpoint now returns `loadedThrough`, so the strip is replaced by the
//    neutral track and a sentence when the pipeline has not reached this shift's
//    business day. The green band is reserved for a shift the pipeline can vouch
//    for.
const LEGEND = [
  { labelKey: "report.legendSchedule", className: SEGMENT_CLASS.PLANNED },
  { labelKey: "report.legendAvailability", className: SEGMENT_CLASS.UNPLANNED },
  { labelKey: "report.legendSmallStop", className: SEGMENT_CLASS.SMALL_STOP },
  { labelKey: "report.legendRunTime", className: SEGMENT_CLASS.RUN_TIME },
  // The strip's own track. Shows through only where a window has no segments at
  // all, which is why it has no matching TimelineSegmentKind.
  { labelKey: "report.legendAvailabilityTime", className: "bg-oee-neutral" },
] as const;

// One sentence per state that replaces the strip with the bare track.
//
// `empty-stale` is the sentence §8 was filed to get onto the screen. It says what
// is NOT known rather than describing the shift, because the whole point is that
// the card cannot describe the shift yet.
const TRACK_MESSAGE: Record<"no-params" | "error" | "empty-stale", string> = {
  "no-params": "report.timelineNoParams",
  error: "report.timelineError",
  "empty-stale": "report.timelineStale",
};

// THE PER-SKU RESIDUAL, AND IT IS §8's ARGUMENT ONE AXIS OVER.
//
// A product-filtered read is `product_id = X`, which is FALSE for NULL rather than
// unknown-but-included — so every stop the pipeline has not attributed to a SKU is
// silently absent. `downtime_reports.product_id` is NULL on every row today
// (migration 0020 added the columns; nothing writes them — TODOS.md §65), so this
// strip is empty of information for a SKU that certainly stopped.
//
// Which is exactly the failure §8 was filed for: "down for hours rendered as
// flawless, with no error, no empty state, and no test that could catch it." The
// watermark cannot separate these two, because the rows ARE loaded — they just
// carry no product. So the sentence has to be unconditional whenever a product
// filter is in play, and the full-width green band has to be withheld.
//
// DERIVED FROM THE PARAMS, NOT FROM A `subject` PROP. `productId` is present iff
// the caller asked for one SKU, which is the fact this card needs; a flag would be
// a second statement of it that could disagree.
// TAKES THE PARAMS, NOT THE REPORT, and that is what lets one strip serve a
// machine and a line.
//
// The caller composes them with `reportWindowParams`, which is the only thing
// that knows a report's SUBJECT — a machine resolves to `scope: "work-unit"` and
// a line to `scope: "work-center"`, both of which /downtimes/timeline already
// serves (SCOPE_COLUMN in core-api's downtime.ts). Passing the report instead
// would put that decision in here, where a Line screen would silently render its
// first machine's stops.
//
// It also DELETES a conversion rather than adding a branch: `params.date` IS the
// business day, already resolved by the composer, so the watermark check below
// no longer reduces an instant through a zone. A line report could not have gone
// the old way at all — migration 0014 gives those rows no `date` column, by
// design.
function TimelineCard({ params }: { params: ShiftTimelineParams | undefined }) {
  const { t } = useTranslation("oee");
  // Checked BEFORE isPending. `reportWindowParams` hands back undefined when the
  // report's date cannot be reduced to a business day — the plant's zone did not
  // resolve, or the pipeline has not written a business date — and that gates the
  // query off. A gated useQuery reports `status: "pending"` FOREVER, so reading
  // isPending first renders a skeleton that never resolves: no error, no empty
  // state, no log.
  const { data, isPending, isError } = useShiftTimeline(params);

  // See PRODUCT_RESIDUAL. Present iff the caller narrowed to one SKU.
  const perProduct = params?.productId !== undefined;

  // The same six-state ladder every other card on this screen uses, from the same
  // tested function — including `no-params` first, which is what the comment above
  // is about.
  //
  // `isEmpty` IS THE WHOLE OF §8, EXPRESSED IN ONE PREDICATE. A "clean" shift comes
  // back as exactly one RUN_TIME segment spanning the window, which is also what a
  // shift with no loaded rows comes back as — because RUN_TIME is not stored, it is
  // what a gap between records is called. So the strip is empty of INFORMATION
  // precisely when nothing but run time is in it, and the watermark decides which
  // of the two that means.
  const state = selectLoadState({
    hasParams: params !== undefined,
    isPending,
    isError,
    data,
    // The business day itself, not an instant. `isLoadedThrough` compares it to
    // the watermark as a STRING after passing it through `toBusinessDay`, whose
    // BARE_DAY short-circuit (format.ts) returns a 'YYYY-MM-DD' unchanged — that
    // short-circuit is what makes this safe, and removing it would send a bare
    // day through a zone conversion and land a day early west of Greenwich.
    reportDate: params?.date,
    isEmpty: (timeline) => timeline.segments.every((segment) => segment.kind === "RUN_TIME"),
  });

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-3 py-4">
        {/* Three of the six states are a sentence on the neutral track. Sharing one
            branch rather than three near-identical divs, because what differs
            between them is only the sentence — and `empty-stale` is the one this
            card gained. */}
        {state === "no-params" || state === "error" || state === "empty-stale" ? (
          <div className="bg-muted text-muted-foreground flex h-7 w-full items-center justify-center rounded-sm px-3 text-center text-xs">
            {t(TRACK_MESSAGE[state])}
          </div>
        ) : null}

        {/* A PRODUCT-FILTERED WINDOW WITH NOTHING IN IT IS A FOURTH SENTENCE, not
            the green band. `empty-loaded` means the pipeline reached this day and
            the window holds only run time — a true statement about a LINE, and a
            claim nobody can support about a SKU, because an unattributed stop
            reads identically. See PRODUCT_RESIDUAL. */}
        {perProduct && state === "empty-loaded" ? (
          <div className="bg-muted text-muted-foreground flex h-7 w-full items-center justify-center rounded-sm px-3 text-center text-xs">
            {t("report.timelineSkuEmpty")}
          </div>
        ) : null}

        {state === "pending" ? <Skeleton className="h-7 w-full rounded-sm" /> : null}

        {/* THE STRIP RENDERS FOR `ready` AND FOR `empty-loaded`, and that pair is
            deliberate: a shift the pipeline HAS reached and that genuinely had no
            stops is a real full-width green band, and drawing it is the correct
            answer rather than a hedge. Only `empty-stale` is withheld — and, at a
            product filter, `empty-loaded` too (see above). */}
        {(state === "ready" || (state === "empty-loaded" && !perProduct)) && data ? (
          <TimelineStrip {...data} />
        ) : null}

        {/* UNCONDITIONAL WHENEVER A PRODUCT FILTER IS IN PLAY, populated strip
            included: the residual is invisible either way, and it is a bigger
            surprise beside bands that ARE drawn than beside an empty track. */}
        {perProduct ? (
          <p className="text-muted-foreground text-xs">{t("report.timelineSkuResidual")}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {LEGEND.map((item) => (
            <div key={item.labelKey} className="flex items-center gap-1.5">
              <span className={`size-2.5 rounded-xs ${item.className}`} />
              <span className="text-muted-foreground text-xs">{t(item.labelKey)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export { TimelineCard };
