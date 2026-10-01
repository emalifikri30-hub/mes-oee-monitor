import { describe, expect, it } from "vite-plus/test";

import { validatePeriodSearch } from "@/lib/period-search";

import type { SearchSchemaInput } from "@tanstack/react-router";

// The URL contract behind four list screens, and until now behind none of these
// assertions. Its header claims "a hand-edited URL degrades to this month instead
// of to an error" — every case below is one clause of that claim.
//
// The cast is what TanStack's own callers do: SearchSchemaInput is a phantom
// marker on the parameter type, never a value.
function parse(search: Record<string, unknown>) {
  return validatePeriodSearch(search as Record<string, unknown> & SearchSchemaInput);
}

const NOW = new Date();

describe("validatePeriodSearch", () => {
  it("defaults an empty URL to this month, page 1, size 10", () => {
    expect(parse({})).toEqual({
      page: 1,
      size: 10,
      month: NOW.getMonth() + 1,
      year: NOW.getFullYear(),
      workCenterId: undefined,
      hideZero: true,
    });
  });

  it("keeps a well-formed URL intact", () => {
    expect(
      parse({ page: 3, size: 25, month: 2, year: 2024, workCenterId: 11, hideZero: false }),
    ).toEqual({ page: 3, size: 25, month: 2, year: 2024, workCenterId: 11, hideZero: false });
  });

  // 100 is the API's hard cap. Anything past it would 400, so it degrades to the
  // default rather than to an error the user cannot act on.
  it.each([101, 0, -1, 2.5, "abc", null])("falls back to size 10 for %p", (size) => {
    expect(parse({ size }).size).toBe(10);
  });

  it.each([0, -1, 1.5, "abc", null, undefined])("falls back to page 1 for %p", (page) => {
    expect(parse({ page }).page).toBe(1);
  });

  it.each([0, 13, 1.5, "August", null])("falls back to this month for %p", (month) => {
    expect(parse({ month }).month).toBe(NOW.getMonth() + 1);
  });

  it.each([1969, 10000, "2026a", null])("falls back to this year for %p", (year) => {
    expect(parse({ year }).year).toBe(NOW.getFullYear());
  });

  it.each([0, -3, "abc", null])("drops a malformed workCenterId (%p)", (workCenterId) => {
    expect(parse({ workCenterId }).workCenterId).toBeUndefined();
  });

  // Default ON, per the design: a period with no production is noise on a
  // performance report. Only an explicit false turns it off — and the STRING
  // "false" counts, because that is what a URL actually carries.
  it.each([false, "false"])("turns hideZero off for %p", (hideZero) => {
    expect(parse({ hideZero }).hideZero).toBe(false);
  });

  it.each([true, "true", "0", undefined, null, "anything"])(
    "leaves hideZero on for %p",
    (hideZero) => {
      expect(parse({ hideZero }).hideZero).toBe(true);
    },
  );

  // Neither belongs at these grains, and the validator is what stops a URL
  // claiming a filter the server ignores.
  it("carries neither shift nor status, even when the URL supplies them", () => {
    const result = parse({ shift: "2", status: "closed" });

    expect(result).not.toHaveProperty("shift");
    expect(result).not.toHaveProperty("status");
  });
});
