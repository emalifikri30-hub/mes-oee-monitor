import { describe, expect, it } from "vite-plus/test";

import { SHIFTS, validateMachineShiftSearch, validateShiftSearch } from "@/lib/shift-search";

import type { SearchSchemaInput } from "@tanstack/react-router";

function line(search: Record<string, unknown>) {
  return validateShiftSearch(search as Record<string, unknown> & SearchSchemaInput);
}

function machine(search: Record<string, unknown>) {
  return validateMachineShiftSearch(search as Record<string, unknown> & SearchSchemaInput);
}

describe("validateShiftSearch", () => {
  // Composition, not duplication: one case is enough to prove the six defaults
  // come from validatePeriodSearch, which has its own file of cases.
  it("delegates the period defaults", () => {
    expect(line({})).toMatchObject({ page: 1, size: 10, hideZero: true });
  });

  it.each([...SHIFTS])("accepts shift %s", (shift) => {
    expect(line({ shift }).shift).toBe(shift);
  });

  // The Select clears the filter by dropping the value, but a bookmarked URL keeps
  // the key — so "" must mean "all shifts" rather than an error. `4` and `0` are
  // outside the plant's three shifts; a number rather than a string is what a
  // hand-written link produces.
  it.each(["all", "0", "4", "", " 1", 1, null, undefined])(
    "drops an unusable shift (%p)",
    (shift) => {
      expect(line({ shift }).shift).toBeUndefined();
    },
  );

  // THE ASSERTION THIS FILE EXISTS FOR. A line has no approval to filter on —
  // oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift) —
  // so a line URL must not be able to claim one.
  it("carries no status key at all, even when the URL supplies one", () => {
    expect(line({ status: "closed" })).not.toHaveProperty("status");
  });
});

describe("validateMachineShiftSearch", () => {
  it("adds the approval filter the line screen does not have", () => {
    expect(machine({ status: "closed" }).status).toBe("closed");
    expect(machine({ status: "open" }).status).toBe("open");
  });

  // Including the `all` sentinel the Select uses: anything unrecognised degrades
  // to "both" rather than to an error.
  it.each(["all", "", "CLOSED", "approved", null, undefined])(
    "degrades an unrecognised status (%p) to both",
    (status) => {
      expect(machine({ status }).status).toBeUndefined();
    },
  );

  it("still validates the shift the same way", () => {
    expect(machine({ shift: "3" }).shift).toBe("3");
    expect(machine({ shift: "9" }).shift).toBeUndefined();
  });
});
