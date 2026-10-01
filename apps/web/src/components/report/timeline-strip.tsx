import { useTranslation } from "react-i18next";

import { SEGMENT_CLASS } from "@/lib/downtime";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ShiftTimeline } from "@/lib/types";

// The scope-agnostic half of the timeline: it knows a window, a zone and a list
// of segments, and nothing about work units, reports or endpoints. The
// work-center / area / factory screens render this same component.
//
// Labels and colours come from lib/downtime.ts, shared with the Downtime Details
// table below — the same record must not read as two different things on one
// screen.
//
// Segments are laid out with `flex-grow: durationMs` over a zero basis, not with
// percentage widths. The browser then divides the row exactly, so no rounding
// residue accumulates and no sliver of track shows through at the right edge.
//
//   |<-------------------- the shift window -------------------->|
//   [ RUN_TIME  ][UNPL][ RUN_TIME ][SS][      PLANNED       ][RUN ]
//     grow:1.8M   240k    900k     60k        2.4M            600k
//
// `min-w-px` is the one deliberate departure: a 30-second stop in an 8-hour
// shift is a sub-pixel sliver and would be invisible and unhoverable. Giving it
// one pixel costs a fraction of a pixel of accuracy elsewhere, which is the
// better trade for something whose job is to be noticed.
const CATEGORY_KEYS = {
  RUN_TIME: "report.categoryRuntime",
  SMALL_STOP: "report.categorySmallStop",
  PLANNED: "report.categoryPlanned",
  UNPLANNED: "report.categoryUnplanned",
} as const;

function TimelineStrip({ from, to, timeZone, segments }: ShiftTimeline) {
  const { t } = useTranslation("oee");
  return (
    <div className="flex flex-col gap-1.5">
      {/* role="img" makes the segments presentational to assistive tech, which
          is right: each one is a coloured slice whose meaning is the picture as
          a whole, and 40 individually announced divs would be noise. */}
      <div
        role="img"
        aria-label={t("report.timelineAria", {
          from: formatClock(from, timeZone),
          to: formatClock(to, timeZone),
          count: segments.length,
        })}
        className="bg-oee-neutral flex h-7 w-full overflow-hidden rounded-sm"
      >
        {segments.map((segment) => (
          <Tooltip key={segment.startAt}>
            <TooltipTrigger asChild>
              <div
                className={cn("h-full min-w-px", SEGMENT_CLASS[segment.kind])}
                style={{ flexGrow: segment.durationMs, flexBasis: 0 }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-semibold">{t(CATEGORY_KEYS[segment.kind])}</div>
              <div>{t("report.startClock", { time: formatClock(segment.startAt, timeZone) })}</div>
              <div>{t("report.endClock", { time: formatClock(segment.endAt, timeZone) })}</div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* The window's own ends, which are the only place the shift boundaries
          appear in the browser — they arrive on the payload rather than being
          derived from a shift number the client would have to know about. */}
      <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
        <span>{formatClock(from, timeZone)}</span>
        <span>{formatClock(to, timeZone)}</span>
      </div>
    </div>
  );
}

export { TimelineStrip };
