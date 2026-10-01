// Shared presentation for downtime categories, read by both the timeline strip
// and the Downtime Details table. One map, so the same record cannot read as two
// different things in two places on the same screen.

import type { DowntimeListItem, TimelineSegmentKind } from "@/lib/types";
import type { UnavailableReason } from "@/components/report/downtime-row-menu";

// Uppercase category names, matching the design. Note these are the CATEGORY
// names, not the OEE loss names: the timeline legend still says "schedule loss
// (planned DT)" because it is mapping colours to OEE factors, which is a
// different question from what a given record is.
const CATEGORY_LABEL: Record<TimelineSegmentKind, string> = {
  RUN_TIME: "RUNTIME",
  SMALL_STOP: "SMALL STOP",
  PLANNED: "PLANNED",
  UNPLANNED: "UNPLANNED",
};

// The semantic tokens from index.css that the waterfall bars and the Losses
// figures already read, so a band and its matching figure cannot drift apart.
// Tailwind v4 only emits classes it can see written out, so these are static
// literals rather than `bg-oee-${kind}`.
const SEGMENT_CLASS: Record<TimelineSegmentKind, string> = {
  RUN_TIME: "bg-oee-value-added",
  SMALL_STOP: "bg-oee-small-stop",
  PLANNED: "bg-oee-planned-downtime",
  UNPLANNED: "bg-oee-unplanned-downtime",
};

// Text colours for the same four kinds, used by the table's Category cell.
//
// The `-fg` ramp, NOT the band tokens above. Those are tuned to be read as a
// filled band against a card, and as 12px text on white they fail WCAG AA
// badly — SMALL STOP was 1.76:1 here. index.css documents the measured ratios.
const CATEGORY_TEXT_CLASS: Record<TimelineSegmentKind, string> = {
  RUN_TIME: "text-oee-value-added-fg",
  SMALL_STOP: "text-oee-small-stop-fg",
  PLANNED: "text-oee-planned-downtime-fg",
  UNPLANNED: "text-oee-unplanned-downtime-fg",
};

// Which of the two reasons — if either — makes a stop uneditable. Shared by both
// downtime tables, so they cannot disagree about when Edit is offered.
//
// ORDER MATTERS. A stop with no stable id on an approved report is BOTH, and the
// missing id is the one to name: it is permanent until the pipeline writes the
// column, whereas reopening the report is something the reader can act on right
// now. Telling somebody to reopen a report so they can edit a stop that still
// could not be edited would send them down a dead end.
function unavailableReason(
  row: DowntimeListItem,
  reportApproved: boolean,
): UnavailableReason | null {
  if (row.sourceEventId === null) return "no-stable-id";
  if (reportApproved) return "report-approved";
  return null;
}

export { CATEGORY_LABEL, CATEGORY_TEXT_CLASS, SEGMENT_CLASS, unavailableReason };
