import { coerceInt } from "@/lib/period-search";
import { defaultReportYear, previousMonthAnchor } from "@/lib/oee-dashboard/previous-month";

import type { SearchSchemaInput } from "@tanstack/react-router";

// The OEE Performance dashboard's URL contracts — SIX of them, one per screen.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY SIX AND NOT ONE WIDE ONE
// ─────────────────────────────────────────────────────────────────────────────
//
// Their own rule, inherited from validatePeriodSearch: NEVER ACCEPT A FILTER THE
// SERVER IGNORES. One widened validator would admit `?month=9` on a YEARLY screen
// and `?workUnitId=3` on an AREA one, and a field that survives validation is a
// bookmarked filter that comes back looking as though it applied.
//
//   machine monthly   year  month  workCenterId  workUnitId
//   machine yearly    year         workCenterId  workUnitId
//   line    monthly   year  month  workCenterId
//   line    yearly    year         workCenterId
//   area    monthly   year  month
//   area    yearly    year
//
// AN AREA SCREEN CARRIES NO `workCenterId`, and that is the same call
// lib/area-search.ts makes for the Report > Area list: an area report is not scoped
// by a line, so accepting one would let a bookmarked `?workCenterId=3` come back
// with the whole area looking filtered. It carries no `workUnitId` for the stronger
// version of the same reason — there is no machine anywhere in an area report.
//
// Neither screen has paging (it shows one report, not a list) or hide-zero (there is
// no list to hide a row from), at any subject or grain.
//
// THE FIELDS ARE WRITTEN OUT PER SCREEN, not derived with `Omit<>`, so each
// screen's contract reads as the list of fields it has — the same call
// area-report-dto.ts makes on the server for the very same pair of grains. What IS
// shared is the three coercions below, because the BOUNDS are the drift-prone part
// and there is no reading of this surface on which they should differ.
const yearField = (raw: unknown) => coerceInt(raw, 1970, 9999);
const monthField = (raw: unknown) => coerceInt(raw, 1, 12);
const idField = (raw: unknown) => coerceInt(raw, 1, Number.MAX_SAFE_INTEGER);

type MachineMonthlySearch = {
  year: number;
  month: number;
  workCenterId: number | undefined;
  workUnitId: number | undefined;
};
type MachineYearlySearch = {
  year: number;
  workCenterId: number | undefined;
  workUnitId: number | undefined;
};
type LineMonthlySearch = { year: number; month: number; workCenterId: number | undefined };
type LineYearlySearch = { year: number; workCenterId: number | undefined };
type AreaMonthlySearch = { year: number; month: number };
type AreaYearlySearch = { year: number };

// Every field optional and `unknown`, so a plain back-link
// `<Link to="/oee-performance/line/yearly" />` compiles without inventing a year.
// Same shape and same reason as PeriodSearchInput.
type SearchInputOf<T> = Partial<Record<keyof T, unknown>> & SearchSchemaInput;

function validateMachineMonthlySearch(
  search: SearchInputOf<MachineMonthlySearch>,
): MachineMonthlySearch {
  // ONE ANCHOR FOR BOTH DEFAULTS. Defaulting `year` to the current year and `month`
  // to the previous one independently asks for a month that has not happened, every
  // January — see previousMonthAnchor.
  const fallback = previousMonthAnchor();

  return {
    year: yearField(search.year) ?? fallback.year,
    month: monthField(search.month) ?? fallback.month,
    // Both undefined-able: the screen resolves the first available option when the
    // URL names none, and DROPS one that is not on the current line rather than
    // showing an empty screen. A hand-edited URL never errors.
    workCenterId: idField(search.workCenterId),
    workUnitId: idField(search.workUnitId),
  };
}

function validateMachineYearlySearch(
  search: SearchInputOf<MachineYearlySearch>,
): MachineYearlySearch {
  return {
    year: yearField(search.year) ?? defaultReportYear(),
    workCenterId: idField(search.workCenterId),
    workUnitId: idField(search.workUnitId),
  };
}

function validateLineMonthlySearch(search: SearchInputOf<LineMonthlySearch>): LineMonthlySearch {
  const fallback = previousMonthAnchor();

  return {
    year: yearField(search.year) ?? fallback.year,
    month: monthField(search.month) ?? fallback.month,
    workCenterId: idField(search.workCenterId),
  };
}

function validateLineYearlySearch(search: SearchInputOf<LineYearlySearch>): LineYearlySearch {
  return {
    year: yearField(search.year) ?? defaultReportYear(),
    workCenterId: idField(search.workCenterId),
  };
}

function validateAreaMonthlySearch(search: SearchInputOf<AreaMonthlySearch>): AreaMonthlySearch {
  const fallback = previousMonthAnchor();

  return {
    year: yearField(search.year) ?? fallback.year,
    month: monthField(search.month) ?? fallback.month,
  };
}

function validateAreaYearlySearch(search: SearchInputOf<AreaYearlySearch>): AreaYearlySearch {
  return { year: yearField(search.year) ?? defaultReportYear() };
}

export {
  validateAreaMonthlySearch,
  validateAreaYearlySearch,
  validateLineMonthlySearch,
  validateLineYearlySearch,
  validateMachineMonthlySearch,
  validateMachineYearlySearch,
};
export type {
  AreaMonthlySearch,
  AreaYearlySearch,
  LineMonthlySearch,
  LineYearlySearch,
  MachineMonthlySearch,
  MachineYearlySearch,
};
