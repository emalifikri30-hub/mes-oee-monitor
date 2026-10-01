// The Year filter's options, for every report list screen.
//
// Two rules, and the second is the one that was duplicated and is easy to lose:
//
//   1. a rolling window of the last five years, newest first; and
//   2. a year OUTSIDE that window stays selectable if it is the one currently
//      chosen. A shared link may point at 2018; without this the dropdown would
//      show 2022-2026 while the table showed 2018's rows, so the control would
//      disagree with the screen it controls.
//
// Pure, and therefore tested as a function rather than through a rendered tree —
// the split AGENTS.md draws for arithmetic and calendar logic.
const YEAR_SPAN = 5;

// `now` is injectable so the test does not have to be re-read every January.
function reportYearOptions(selected: number, now: Date = new Date()): number[] {
  const current = now.getFullYear();
  const span = Array.from({ length: YEAR_SPAN }, (_, i) => current - i);

  return span.includes(selected) ? span : [selected, ...span].sort((a, b) => b - a);
}

export { YEAR_SPAN, reportYearOptions };
