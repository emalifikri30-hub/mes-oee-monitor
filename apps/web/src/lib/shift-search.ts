import { validatePeriodSearch } from "@/lib/period-search";

import type { SearchSchemaInput } from "@tanstack/react-router";
import type { PeriodSearch } from "@/lib/period-search";

// The URL contract for the two SHIFT-grain list screens — machine By Shift and
// line By Shift.
//
// Composed from validatePeriodSearch rather than restating its six defaults; the
// same argument that file's header makes for existing at all.
//
// THE TWO SHIFT SCREENS DIFFER BY `status`, AND THAT IS NOT AN OVERSIGHT.
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift), so a
// MACHINE shift report is the only thing in this app with an approval ROW. A line
// can be approved — the detail screen cascades over its machines — but its status
// is DERIVED by counting those rows, so there is no column here to filter on. A
// line URL carrying `?status=closed` would therefore claim a filter the server
// ignores, and an ignored filter answers a filtered request with an unfiltered
// page, which reads as data rather than as an error.

// The plant runs three numbered shifts. THE ONLY LIST that decides what may be
// requested — the ShiftFilter control imports it too, so the picker cannot offer
// a value this validator would drop.
const SHIFTS = ["1", "2", "3"] as const;

type ShiftGrainSearch = PeriodSearch & { shift: string | undefined };

// The machine screen's contract: the shift grain plus the approval filter.
type MachineShiftSearch = ShiftGrainSearch & { status: "open" | "closed" | undefined };

type ShiftSearchInput = Partial<Record<keyof MachineShiftSearch, unknown>>;

function validateShiftSearch(search: ShiftSearchInput & SearchSchemaInput): ShiftGrainSearch {
  const shift = typeof search.shift === "string" ? search.shift : undefined;

  return {
    ...validatePeriodSearch(search),
    shift: SHIFTS.includes(shift as (typeof SHIFTS)[number]) ? shift : undefined,
  };
}

function validateMachineShiftSearch(
  search: ShiftSearchInput & SearchSchemaInput,
): MachineShiftSearch {
  return {
    ...validateShiftSearch(search),
    // Anything unrecognised — including the `all` sentinel the Select uses, and a
    // hand-edited URL — degrades to "both" rather than to an error, matching every
    // other field here.
    status: search.status === "open" || search.status === "closed" ? search.status : undefined,
  };
}

export { SHIFTS, validateMachineShiftSearch, validateShiftSearch };
export type { MachineShiftSearch, ShiftGrainSearch, ShiftSearchInput };
