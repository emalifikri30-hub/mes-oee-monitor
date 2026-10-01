import { coerceInt } from "@/lib/period-search";

import type { SearchSchemaInput } from "@tanstack/react-router";

// The URL contract for the AREA report lists.
//
// ITS OWN TYPE RATHER THAN `PeriodSearch`, AND THE ONE MISSING FIELD IS WHY.
// `PeriodSearch` carries `workCenterId`, because every screen it serves is either
// about a line or filtered by one. An AREA report is not scoped by a line — a line
// filter here would name a subset the row's own figures were never computed over,
// so the page would show one area's OEE under a heading claiming one line.
//
// Reusing `PeriodSearch` and ignoring the field was the smaller diff and is the
// wrong one, for the reason that file states about `shift` and `status`: accepting
// a filter the server ignores lets a URL claim something it does not do, which
// reads as data rather than as an error. A bookmarked
// `?workCenterId=3` would come back with the whole area and look filtered.
//
// `coerceInt` IS SHARED, not re-derived. It is the one thing the two contracts
// genuinely have in common, and a second copy of "an integer in range or the
// default" would be a second place for the bounds to drift.
//
// THE AREA ITSELF IS NOT IN HERE, and that is a decision made one level up:
// components/layout/area-context.tsx keeps the header picker's selection in
// context and localStorage rather than in the URL, "deliberately NOT a search
// param: it survives navigation between reports". The area report lists are the
// first screens where that selection becomes a REQUEST filter, and they inherit
// the storage decision unchanged — so a shared link reopens the same month and
// year, in whatever area the recipient last chose. If that turns out to be wrong,
// the fix is to move the area into the URL for every screen at once, not to add a
// second home for it here.
type AreaDaySearch = {
  page: number;
  size: number;
  month: number;
  year: number;
  hideZero: boolean;
};

// What a caller may hand to <Link to="/report/area/by-day">. Every key is optional
// and untyped because this function defaults all of them — without it the link
// type would demand the full, already-validated object, and a plain "back to the
// list" link would not compile.
type AreaDaySearchInput = Partial<Record<keyof AreaDaySearch, unknown>>;

function validateAreaDaySearch(search: AreaDaySearchInput & SearchSchemaInput): AreaDaySearch {
  const now = new Date();

  return {
    page: coerceInt(search.page, 1, Number.MAX_SAFE_INTEGER) ?? 1,
    // 100 is the API's hard page-size cap.
    size: coerceInt(search.size, 1, 100) ?? 10,
    month: coerceInt(search.month, 1, 12) ?? now.getMonth() + 1,
    year: coerceInt(search.year, 1970, 9999) ?? now.getFullYear(),
    // Default on, per the design and matching every other list: a period with no
    // production is noise on a performance report. Only an explicit `false` turns
    // it off.
    hideZero: search.hideZero !== false && search.hideZero !== "false",
  };
}

// The MONTH list's contract: the day one minus `month`.
//
// AND THAT ABSENCE IS THE REQUIREMENT'S, IN AS MANY WORDS — "Monthly Report (Show
// all month on selected year)". A month filter would contradict the screen's own
// heading, and a month list narrowed to one month is one row.
//
// IT IS ALSO STRICTER THAN THE SIX SHIPPED BY-MONTHLY SCREENS, which share
// `validatePeriodSearch` with their day siblings and do carry a month. The
// divergence is asked for, and core-api's month list refuses the param outright —
// so a `?month=9` bookmarked from a day screen must not survive into this one and
// look like a filter. Dropping it here is what makes that true of the URL as well
// as of the request.
//
// A SEPARATE TYPE RATHER THAN `Omit<AreaDaySearch, "month">`, so each screen's
// contract reads as the list of fields it has — the same call area-report-dto.ts's
// two schemas make on the server.
type AreaMonthSearch = {
  page: number;
  size: number;
  year: number;
  hideZero: boolean;
};

type AreaMonthSearchInput = Partial<Record<keyof AreaMonthSearch, unknown>>;

function validateAreaMonthSearch(
  search: AreaMonthSearchInput & SearchSchemaInput,
): AreaMonthSearch {
  const now = new Date();

  return {
    page: coerceInt(search.page, 1, Number.MAX_SAFE_INTEGER) ?? 1,
    // 12 RATHER THAN THE DAY LIST'S 10, because a year holds twelve months and a
    // reader on this screen wants the whole year on one page. Still well under the
    // API's cap of 100.
    size: coerceInt(search.size, 1, 100) ?? 12,
    year: coerceInt(search.year, 1970, 9999) ?? now.getFullYear(),
    hideZero: search.hideZero !== false && search.hideZero !== "false",
  };
}

export { validateAreaDaySearch, validateAreaMonthSearch };
export type { AreaDaySearch, AreaDaySearchInput, AreaMonthSearch, AreaMonthSearchInput };
