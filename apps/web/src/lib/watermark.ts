import { toBusinessDay } from "@/lib/format";

// Has the pipeline reached the day a report covers?
//
// This is the one question that separates two empty states which look identical
// on screen and mean opposite things:
//
//   loaded      ->  the machine genuinely produced nothing / stopped for nothing
//   not loaded  ->  the rows have not arrived yet, and the card is lying
//
// The flattering reading is the wrong one, which is why it gets a function and a
// test rather than an inline comparison per card. TODOS.md §8 records the same
// ambiguity still open on the timeline strip.
//
// STRING COMPARISON, DELIBERATELY. Both sides are YYYY-MM-DD, which sorts
// lexicographically, and parsing them into Dates would reintroduce exactly the
// time-zone ambiguity `toBusinessDay` exists to remove — a `new Date("2026-08-09")`
// is midnight UTC, which is the previous day in Jakarta.
//
// Every failure to know resolves to NOT loaded: a null watermark (the pipeline
// has never stamped the table) and an unreadable report date both mean the card
// cannot claim the shift was clean.
function isLoadedThrough(
  reportDate: string | null | undefined,
  timeZone: string,
  loadedThrough: string | null,
): boolean {
  if (loadedThrough === null) return false;

  const businessDay = toBusinessDay(reportDate, timeZone);
  if (businessDay === undefined) return false;

  return loadedThrough >= businessDay;
}

export { isLoadedThrough };
