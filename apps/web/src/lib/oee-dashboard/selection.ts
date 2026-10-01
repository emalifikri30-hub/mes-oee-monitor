import type {
  AreaReportListItem,
  AreaYearReportListItem,
  LinePeriodReportListItem,
  LineYearReportListItem,
  MachineYearReportListItem,
  PeriodReportListItem,
} from "@/lib/types";

// Turning a URL into a selection, and a selection into a report id.
//
// PURE, AND THEREFORE TESTED AS FUNCTIONS — the split apps/web/AGENTS.md draws for
// arithmetic and calendar logic, applied here because the two rules below are the
// screen's quietest failures. One of them shipped as a real bug on the report
// lists before `useWorkCenterFilter` was written, and the other is the
// nine-sequences hazard in miniature.

// Which option is actually selected, given what the URL asked for.
//
// TWO RULES, AND THE ORDER MATTERS:
//
//   1. WHILE THE OPTIONS ARE STILL LOADING, THE REQUESTED ID STANDS. `options`
//      is undefined then, and returning undefined would make the screen fall back
//      to "first available" for one tick and FLASH ANOTHER MACHINE'S REPORT before
//      settling on the one the link asked for. `useWorkCenterFilter` relies on
//      `undefined?.every()` being falsy for exactly this; stating it as a branch
//      here is the same rule, said out loud.
//
//   2. ONCE THEY HAVE LOADED, AN ID THAT IS NOT AMONG THEM IS DROPPED. A machine
//      left over from a previously-selected line is not on this one, and keeping
//      it would either strand the screen on an option the picker cannot show or
//      resolve against another line's report entirely.
//
// The fallback is the first option rather than "no selection": unlike a report
// LIST, this dashboard is about ONE subject and has nothing to render without one.
function resolveSelection(
  requested: number | undefined,
  options: readonly { id: number }[] | undefined,
): number | undefined {
  if (options === undefined) return requested;
  if (requested !== undefined && options.some((option) => option.id === requested)) {
    return requested;
  }

  return options[0]?.id;
}

// (line, year, month, machine) -> report id.
//
// MATCHED ON `workUnit.id`, NEVER ON THE ROW'S POSITION. The rows come back
// ordered by business date and id, and a positional match would silently pair the
// picker with whichever machine happened to sort first — a populated, plausible
// report about the wrong machine, which is the nine-sequences hazard's whole
// shape.
//
// `undefined` means this machine HAS NO REPORT for the month, which is a real and
// reachable state on this screen precisely because the picker is a master-data
// catalogue rather than a projection of these rows.
function findReportId(
  items: readonly (PeriodReportListItem | MachineYearReportListItem)[] | undefined,
  workUnitId: number | undefined,
): number | undefined {
  if (items === undefined || workUnitId === undefined) return undefined;

  return items.find((row) => row.workUnit?.id === workUnitId)?.id;
}

// HAS THE LIST ACTUALLY ANSWERED? Four tokens, and the obvious wrong version
// (`!isPending`) reads as plainly correct, which is what makes this worth a
// function and a test rather than six copies.
//
// Every list this surface uses — usePeriodReports, useLineReports, useAreaReports —
// carries `placeholderData: (previous) => previous`. That is right for the report
// LISTS they were written for, where keeping the last page visible while the next
// loads avoids a flash of empty table. HERE THE ROWS ARE NOT DISPLAYED, THEY ARE
// SEARCHED: during a subject change the PREVIOUS subject's rows are served under
// the new key, the requested id is not among them, and the screen states "this
// machine has no report for the selected month" — a confident negative, rendered
// for as long as the refetch takes.
//
// `isPending` alone cannot see it: with placeholder data present it is FALSE.
function isListSettled(query: { isPending: boolean; isPlaceholderData: boolean }): boolean {
  return !query.isPending && !query.isPlaceholderData;
}

// The LINE's matcher, and the AREA's two.
//
// FOUR SEPARATELY-TYPED FUNCTIONS RATHER THAN ONE TAKING A KEY SELECTOR, and the
// generalisation is the trap. `findReportId(items, id, (row) => row.workCenter?.id)`
// on a MACHINE list compiles and reads a real, populated field — the row's LINE —
// so it would return a line id that happens to collide with a work unit id and open
// a plausible report about the wrong machine. A lambda cannot be typechecked into
// being the right field; a parameter type can. Same argument as LossesDetailTo's
// eight route literals.
//
// A line row's key is FLAT and NOT NULL (`workCenterId`, a Gold column from 0014),
// where a machine row's is the nested, nullable `workUnit` the enriched payload
// carries. That difference is exactly what 0ed9c20 was about.
function findLineReportId(
  items: readonly (LinePeriodReportListItem | LineYearReportListItem)[] | undefined,
  workCenterId: number | undefined,
): number | undefined {
  if (items === undefined || workCenterId === undefined) return undefined;

  return items.find((row) => row.workCenterId === workCenterId)?.id;
}

// THE AREA MONTH LIST TAKES NO `month` PARAMETER, so this one does the narrowing
// the server will not.
//
// That is not an oversight upstream: area-report-dto.ts writes the month schema out
// as the day schema MINUS `month`, because the requirement is "Monthly Report (Show
// all month on selected year)" — and it REFUSES the field with a 400 rather than
// accepting and dropping it. So the dashboard asks for a whole year and picks its
// month here.
//
// A STRING SLICE, NEVER A Date. `businessDate` is plant-local and already free of a
// zone; `new Date("2026-09-01")` reads as UTC midnight and lands on 31 August for
// any plant west of Greenwich — the right-looking wrong month, every row.
//
// THE `areaId` COMPARISON IS NOT REDUNDANT with the query's own filter. The list is
// gated on a resolved area (see useAreaReports), but a gate is about the REQUEST;
// this is about the ROWS, and an id lookup must not trust a filter it cannot see.
// Without it, a response that arrived for another area resolves to that area's
// report — populated, plausible, under this area's heading.
function findAreaMonthReportId(
  items: readonly AreaReportListItem[] | undefined,
  areaId: number | undefined,
  month: number,
): number | undefined {
  if (items === undefined || areaId === undefined) return undefined;

  const wanted = String(month).padStart(2, "0");
  return items.find((row) => row.areaId === areaId && row.businessDate.slice(5, 7) === wanted)?.id;
}

// THE AREA'S YEAR MATCHER — and it needs no month, which is the whole difference.
//
// `/areas/year-reports` DOES take a `year`, unlike the month list, so the server
// narrows to one row per area and this only has to confirm which area it belongs
// to. That `areaId` check is still not redundant, for its month sibling's reason:
// the gate is about the REQUEST, and an id lookup must not trust a filter it
// cannot see.
//
// A SEPARATE FUNCTION RATHER THAN A DEFAULTED `month` ARGUMENT. An optional month
// on the month matcher would make "no month supplied" mean "any month", which on a
// twelve-row page silently resolves to whichever row sorted first — a populated,
// plausible report about a period nobody asked for.
function findAreaYearReportId(
  items: readonly AreaYearReportListItem[] | undefined,
  areaId: number | undefined,
): number | undefined {
  if (items === undefined || areaId === undefined) return undefined;

  return items.find((row) => row.areaId === areaId)?.id;
}

export {
  findAreaMonthReportId,
  findAreaYearReportId,
  findLineReportId,
  findReportId,
  isListSettled,
  resolveSelection,
};
