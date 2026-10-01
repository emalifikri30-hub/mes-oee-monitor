// ACHIEVEMENT HAS NO COLUMN BEHIND IT, ON ANY SCREEN.
//
// There is no target anywhere in Gold — not per line, not per SKU, not per period
// — so there is nothing to compute a percentage against. The reference design
// specifies "default to 0", so this is the specified behaviour rather than a bug;
// what it is not is a measurement, and the muted styling below is the only thing
// on screen that says so.
//
// SHARED RATHER THAN DECLARED TWICE. It lived as a const inside
// line-overview-card.tsx until the SKU report needed the same tile. Two copies of
// a placeholder are two things to find on the day a target lands, and the one that
// gets missed keeps rendering 0% beside a screen that has started rendering a real
// figure — which reads as a line that achieved nothing rather than as a stale
// constant.
//
// WHEN A TARGET ARRIVES this becomes `formatPercent(actual / target)` in one
// place, and this module goes. TODOS.md §66 holds the open question of where a
// target would even come from: a production plan usually originates in an ERP or a
// scheduling system rather than in Silver telemetry, so it may not be the
// pipeline's to give at all.
const ACHIEVEMENT_PLACEHOLDER = "0%";

// The muted foreground that distinguishes a placeholder from a measurement.
// Exported with the value so the two cannot be paired differently.
const ACHIEVEMENT_CLASS_NAME = "text-muted-foreground";

export { ACHIEVEMENT_CLASS_NAME, ACHIEVEMENT_PLACEHOLDER };
