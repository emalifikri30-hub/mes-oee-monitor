import { describe, expect, it } from "vite-plus/test";

import {
  findAreaMonthReportId,
  findAreaYearReportId,
  findLineReportId,
  findReportId,
  isListSettled,
  resolveSelection,
} from "./selection";

import type { PeriodReportListItem } from "@/lib/types";

const OPTIONS = [{ id: 3 }, { id: 6 }];

describe("resolveSelection", () => {
  it("keeps an id that is among the options", () => {
    expect(resolveSelection(6, OPTIONS)).toBe(6);
  });

  it("falls back to the first option when the URL asked for nothing", () => {
    expect(resolveSelection(undefined, OPTIONS)).toBe(3);
  });

  // A machine left over from a previously-selected line. Keeping it would resolve
  // against another line's report.
  it("drops an id that is NOT among the loaded options", () => {
    expect(resolveSelection(99, OPTIONS)).toBe(3);
  });

  // THE FLASH THIS PREVENTS. While the options are loading there is nothing to
  // check the id against, so it must stand — otherwise the screen falls back to
  // "first available" for one tick and paints a different machine's report before
  // settling on the one the shared link asked for.
  it("lets the requested id stand while the options are still loading", () => {
    expect(resolveSelection(99, undefined)).toBe(99);
  });

  it("has nothing to select when the options loaded empty", () => {
    expect(resolveSelection(3, [])).toBeUndefined();
  });
});

const row = (id: number, workUnitId: number) =>
  ({ id, workUnit: { id: workUnitId, code: "", name: "" } }) as PeriodReportListItem;

describe("findReportId", () => {
  it("matches on the work unit, not on the row's position", () => {
    // The wanted machine is SECOND. A positional match would return 101 — a real,
    // populated month report about the wrong machine.
    expect(findReportId([row(101, 3), row(102, 6)], 6)).toBe(102);
  });

  // A reachable state, and the reason the picker is a master-data catalogue: a
  // machine with no report for the month can still be CHOSEN, so the screen can
  // say it has none.
  it("returns undefined when this machine has no report for the month", () => {
    expect(findReportId([row(101, 3)], 6)).toBeUndefined();
  });

  it("returns undefined before the list has loaded", () => {
    expect(findReportId(undefined, 6)).toBeUndefined();
  });

  it("returns undefined when no machine is selected yet", () => {
    expect(findReportId([row(101, 3)], undefined)).toBeUndefined();
  });

  it("ignores a row whose work unit could not be enriched", () => {
    expect(findReportId([{ id: 101, workUnit: null } as PeriodReportListItem], 3)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isListSettled
// ─────────────────────────────────────────────────────────────────────────────
//
// The one case that matters is the one the obvious implementation gets wrong.
describe("isListSettled", () => {
  it("is false while PLACEHOLDER data is being served", () => {
    // `isPending` is FALSE here — there is data — which is exactly why
    // `!isPending` reads as correct and is not. These rows belong to the
    // PREVIOUSLY selected subject, and a screen that treats them as an answer
    // states "this machine has no report for the selected month" about a machine
    // whose rows have not arrived.
    expect(isListSettled({ isPending: false, isPlaceholderData: true })).toBe(false);
  });

  it("is false while pending", () => {
    expect(isListSettled({ isPending: true, isPlaceholderData: false })).toBe(false);
  });

  it("is true only once the rows are this subject's own", () => {
    expect(isListSettled({ isPending: false, isPlaceholderData: false })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findLineReportId
// ─────────────────────────────────────────────────────────────────────────────
//
// A LINE ROW'S KEY IS FLAT AND NOT NULL, where a machine row's is the nested,
// nullable `workUnit`. The fixture is written out here rather than built from the
// type for `0ed9c20`'s reason: a fixture derived from the type shares the wrong
// assumption with the code under test, which is how a whole column of em dashes
// shipped once.
describe("findLineReportId", () => {
  const rows = [
    { id: 11, workCenterId: 2 },
    { id: 12, workCenterId: 5 },
  ] as never;

  it("matches on the row's own workCenterId", () => {
    expect(findLineReportId(rows, 5)).toBe(12);
  });

  // NEVER POSITIONAL. The rows come back ordered by business date and id, so a
  // positional match would pair the picker with whichever line sorted first — a
  // populated, plausible report about the wrong line.
  it("does not fall back to the first row when the line is absent", () => {
    expect(findLineReportId(rows, 9)).toBeUndefined();
  });

  it("returns undefined while the list or the selection is unresolved", () => {
    expect(findLineReportId(undefined, 5)).toBeUndefined();
    expect(findLineReportId(rows, undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findAreaMonthReportId
// ─────────────────────────────────────────────────────────────────────────────
describe("findAreaMonthReportId", () => {
  const year = [
    { id: 31, areaId: 3, businessDate: "2026-08-01" },
    { id: 32, areaId: 3, businessDate: "2026-09-01" },
    { id: 33, areaId: 3, businessDate: "2026-10-01" },
  ] as never;

  // `/areas/month-reports` REFUSES a `month` parameter, so the browser asks for a
  // whole year and narrows here. This is the assertion that stops someone
  // "simplifying" it back to `items[0]`.
  it("picks the requested month out of a year of rows", () => {
    expect(findAreaMonthReportId(year, 3, 9)).toBe(32);
  });

  it("returns undefined for a month the year has no row for", () => {
    expect(findAreaMonthReportId(year, 3, 12)).toBeUndefined();
  });

  // THE GUARD AGAINST A STRANGER'S REPORT. The query is gated on a resolved area,
  // but a gate is about the REQUEST — this is about the ROWS, and an id lookup
  // must not trust a filter it cannot see. Without the areaId comparison this row
  // would resolve and open another area's September under this area's heading.
  it("ignores a row belonging to another area", () => {
    const otherArea = [{ id: 44, areaId: 7, businessDate: "2026-09-01" }] as never;

    expect(findAreaMonthReportId(otherArea, 3, 9)).toBeUndefined();
  });

  it("returns undefined while the area is unresolved", () => {
    expect(findAreaMonthReportId(year, undefined, 9)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findAreaYearReportId
// ─────────────────────────────────────────────────────────────────────────────
//
// The year list DOES take a `year` where the month list refuses a `month`, so the
// server narrows to one row per area and this only confirms which area it is.
describe("findAreaYearReportId", () => {
  const rows = [{ id: 51, areaId: 3, businessDate: "2026-01-01" }] as never;

  it("matches the area's own row", () => {
    expect(findAreaYearReportId(rows, 3)).toBe(51);
  });

  // THE GUARD AGAINST A STRANGER'S REPORT, same as its month sibling's: the gate is
  // about the REQUEST, and an id lookup must not trust a filter it cannot see.
  it("ignores a row belonging to another area", () => {
    expect(findAreaYearReportId([{ id: 52, areaId: 7 }] as never, 3)).toBeUndefined();
  });

  it("returns undefined while the area is unresolved", () => {
    expect(findAreaYearReportId(rows, undefined)).toBeUndefined();
  });
});
