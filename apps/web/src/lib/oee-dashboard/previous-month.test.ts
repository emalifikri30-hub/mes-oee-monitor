import { describe, expect, it } from "vite-plus/test";

import { defaultReportYear, previousMonthAnchor } from "./previous-month";

describe("previousMonthAnchor", () => {
  it("returns the month before, in the same year", () => {
    expect(previousMonthAnchor(new Date(2026, 8, 15))).toEqual({ year: 2026, month: 9 - 1 });
  });

  // THE CASE THE REQUIREMENT'S OWN WORDING GETS WRONG. "Default year = current
  // year" and "default month = previous month" disagree every January, and taking
  // them literally asks for December of a year that has not finished.
  it("rolls the YEAR back in January", () => {
    expect(previousMonthAnchor(new Date(2027, 0, 9))).toEqual({ year: 2026, month: 12 });
  });

  it("is stable on the 31st, where naive month arithmetic rolls forward", () => {
    // new Date(2026, 1, 31) is 3 March. Anchoring on day 1 is what avoids it.
    expect(previousMonthAnchor(new Date(2026, 2, 31))).toEqual({ year: 2026, month: 2 });
  });

  it("handles a leap February the same way", () => {
    expect(previousMonthAnchor(new Date(2028, 2, 30))).toEqual({ year: 2028, month: 2 });
  });

  it("returns a 1-based month, matching every filter and API param", () => {
    expect(previousMonthAnchor(new Date(2026, 1, 5)).month).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defaultReportYear
// ─────────────────────────────────────────────────────────────────────────────
//
// The yearly screens' default, and JANUARY IS THE WHOLE TEST — for eleven months
// of every twelve this is indistinguishable from `now.getFullYear()`, which is
// exactly the kind of bug that ships.
describe("defaultReportYear", () => {
  it("opens on the PREVIOUS year in January, when the current one has no finished month", () => {
    expect(defaultReportYear(new Date(2027, 0, 15))).toBe(2026);
  });

  it("opens on the current year from February onward", () => {
    expect(defaultReportYear(new Date(2027, 1, 1))).toBe(2027);
    expect(defaultReportYear(new Date(2027, 11, 31))).toBe(2027);
  });

  // DERIVED FROM THE SAME ANCHOR as the monthly screens' pair, so the two grains
  // cannot disagree about which period is the latest one worth defaulting to.
  it("agrees with the month anchor's year", () => {
    const now = new Date(2027, 0, 15);

    expect(defaultReportYear(now)).toBe(previousMonthAnchor(now).year);
  });
});
