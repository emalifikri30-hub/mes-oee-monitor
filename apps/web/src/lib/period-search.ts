import type { SearchSchemaInput } from "@tanstack/react-router";

// The URL contract shared by every report LIST screen.
//
// Hand-rolled rather than zod, matching routes/login.tsx: the filters are the
// page's whole state, and keeping them in the URL means a shared link reopens
// the same list. Every field falls back to a usable default, so a hand-edited
// URL degrades to "this month" instead of to an error.
//
// LIVES HERE RATHER THAN IN ANY ROUTE because four routes need exactly this
// function — machine By Day and By Monthly, and line By Day and By Monthly — and
// TanStack requires each to declare its own `validateSearch`. Copies would be
// copies of six defaults, and the symptom of a drift is a By Day link that opens
// By Monthly on a different month.
//
// `PeriodSearch` is DECLARED HERE rather than in the component that consumes it.
// It used to be imported from components/report/period-report-table.tsx, which
// pointed lib/ at a component — tolerable with one consumer and wrong with four,
// since lib/shift-search.ts now builds on it too.
//
// It deliberately carries NEITHER `shift` NOR `status`. There is no shift at
// these grains and no day or month approval to filter on, and accepting either
// would let a URL claim a filter the server ignores — which reads as data rather
// than as an error.
type PeriodSearch = {
  page: number;
  size: number;
  month: number;
  year: number;
  workCenterId: number | undefined;
  hideZero: boolean;
};

// What a caller may hand to <Link to="/report/machine/by-day">. Every key is
// optional and untyped because this function defaults all of them — without it
// the link type would demand the full, already-validated object, and a plain
// "back to the list" link would not compile.
type PeriodSearchInput = Partial<Record<keyof PeriodSearch, unknown>>;

function coerceInt(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function validatePeriodSearch(search: PeriodSearchInput & SearchSchemaInput): PeriodSearch {
  const now = new Date();

  return {
    page: coerceInt(search.page, 1, Number.MAX_SAFE_INTEGER) ?? 1,
    // 100 is the API's hard page-size cap.
    size: coerceInt(search.size, 1, 100) ?? 10,
    month: coerceInt(search.month, 1, 12) ?? now.getMonth() + 1,
    year: coerceInt(search.year, 1970, 9999) ?? now.getFullYear(),
    workCenterId: coerceInt(search.workCenterId, 1, Number.MAX_SAFE_INTEGER),
    // Default on, per the design: a period with no production is noise on a
    // performance report. Only an explicit `false` turns it off.
    hideZero: search.hideZero !== false && search.hideZero !== "false",
  };
}

export { coerceInt, validatePeriodSearch };
export type { PeriodSearch, PeriodSearchInput };
