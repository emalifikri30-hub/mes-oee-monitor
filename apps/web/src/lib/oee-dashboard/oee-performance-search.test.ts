import { describe, expect, it } from "vite-plus/test";

import {
  validateAreaMonthlySearch,
  validateAreaYearlySearch,
  validateLineMonthlySearch,
  validateLineYearlySearch,
  validateMachineMonthlySearch,
  validateMachineYearlySearch,
} from "./oee-performance-search";

import type { SearchSchemaInput } from "@tanstack/react-router";

const input = (raw: Record<string, unknown>) => raw as never as SearchSchemaInput;

describe("validateMachineMonthlySearch", () => {
  it("keeps a valid year, month and both ids", () => {
    expect(
      validateMachineMonthlySearch(input({ year: 2026, month: 8, workCenterId: 2, workUnitId: 3 })),
    ).toEqual({ year: 2026, month: 8, workCenterId: 2, workUnitId: 3 });
  });

  it("coerces the numeric strings a URL actually carries", () => {
    expect(
      validateMachineMonthlySearch(
        input({ year: "2026", month: "8", workCenterId: "2", workUnitId: "3" }),
      ),
    ).toEqual({ year: 2026, month: 8, workCenterId: 2, workUnitId: 3 });
  });

  // Every field degrades to something usable: a hand-edited URL must never error.
  it.each([
    ["a month of 0", { month: 0 }],
    ["a month of 13", { month: 13 }],
    ["a non-numeric month", { month: "august" }],
  ])("falls back to the default period for %s", (_label, raw) => {
    const result = validateMachineMonthlySearch(input(raw));

    expect(result.month).toBeGreaterThanOrEqual(1);
    expect(result.month).toBeLessThanOrEqual(12);
  });

  it("drops a zero or negative id rather than sending it", () => {
    expect(validateMachineMonthlySearch(input({ workCenterId: 0, workUnitId: -3 }))).toMatchObject({
      workCenterId: undefined,
      workUnitId: undefined,
    });
  });

  // THE PAIR IS COHERENT BY CONSTRUCTION. Defaulted independently, this is the
  // combination that asks for a month that has not happened.
  it("defaults year and month from ONE anchor, so they cannot disagree", () => {
    const { year, month } = validateMachineMonthlySearch(input({}));
    const now = new Date();
    const expected = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    expect({ year, month }).toEqual({
      year: expected.getFullYear(),
      month: expected.getMonth() + 1,
    });
  });

  // The server has no paging or hide-zero on this screen, so accepting either
  // would let a bookmarked URL look filtered when nothing applied.
  it("carries no filter the dashboard does not send", () => {
    const result = validateMachineMonthlySearch(input({ page: 3, size: 50, hideZero: true }));

    expect(Object.keys(result).sort()).toEqual(["month", "workCenterId", "workUnitId", "year"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER FIVE CONTRACTS, AND THE ASSERTIONS ARE ABSENCES
// ─────────────────────────────────────────────────────────────────────────────
//
// The rule these validators exist to keep is NEVER ACCEPT A FILTER THE SERVER
// IGNORES, so what has to be pinned is which fields DO NOT SURVIVE. A field that
// comes through is a bookmarked filter that reads as applied and does nothing —
// `?month=3` on a yearly screen, or `?workCenterId=3` on an area one, which would
// show a whole area's OEE under a heading claiming one line.
//
// `in` rather than a value check: a field present-and-undefined is still a field
// in the search object, and TanStack will put it back in the URL.
describe("the yearly validators drop `month`", () => {
  it("machine yearly", () => {
    expect("month" in validateMachineYearlySearch(input({ month: 3, year: 2026 }))).toBe(false);
  });

  it("line yearly", () => {
    expect("month" in validateLineYearlySearch(input({ month: 3, year: 2026 }))).toBe(false);
  });

  it("area yearly", () => {
    expect("month" in validateAreaYearlySearch(input({ month: 3, year: 2026 }))).toBe(false);
  });
});

describe("the line validators drop `workUnitId`", () => {
  // A line dashboard narrowed to one machine would BE the machine dashboard,
  // reached by a path that says Line — and the figures would not even agree, since
  // a line is measured at its own count points.
  it("line monthly", () => {
    expect("workUnitId" in validateLineMonthlySearch(input({ workUnitId: 3, year: 2026 }))).toBe(
      false,
    );
  });

  it("line yearly", () => {
    expect("workUnitId" in validateLineYearlySearch(input({ workUnitId: 3, year: 2026 }))).toBe(
      false,
    );
  });
});

describe("the area validators drop both line and machine", () => {
  it("area monthly", () => {
    const search = validateAreaMonthlySearch(input({ workCenterId: 3, workUnitId: 4, year: 2026 }));

    expect("workCenterId" in search).toBe(false);
    expect("workUnitId" in search).toBe(false);
  });

  it("area yearly", () => {
    const search = validateAreaYearlySearch(input({ workCenterId: 3, workUnitId: 4, year: 2026 }));

    expect("workCenterId" in search).toBe(false);
    expect("workUnitId" in search).toBe(false);
  });
});

// The three coercions are shared, so the BOUNDS are asserted once per kind rather
// than six times — what is per-validator is which fields exist, above.
describe("the shared coercions", () => {
  it("rejects an out-of-range year and falls back", () => {
    expect(validateAreaYearlySearch(input({ year: 99_999 })).year).not.toBe(99_999);
  });

  it("rejects an out-of-range month and falls back", () => {
    expect(validateAreaMonthlySearch(input({ year: 2026, month: 13 })).month).not.toBe(13);
  });

  // A hand-edited URL must never error — it falls back, which is what lets every
  // screen be linked to without inventing a period.
  it("survives a bare link with no search at all", () => {
    expect(validateAreaYearlySearch(input({}))).toMatchObject({ year: expect.any(Number) });
  });
});
