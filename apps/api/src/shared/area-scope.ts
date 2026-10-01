import type { GoldDB } from "./database/postgres.js";
import type { Fragment } from "postgres";

// THE AREA PREDICATE EVERY REPORT LIST APPLIES, IN ONE PLACE.
//
// Shared ON ARRIVAL rather than on a second caller, which is the exception
// `shared/oee-trend.ts` already sets: there were FOUR callers on day one —
// `/work-units/{shift,day,month,year}-reports`, `/work-centers/*-reports`,
// `/products/day-reports` and the area lists' own grain key — because the
// requirement is that EVERY report screen opens filtered to the area chosen in
// the web app's header.
//
// ONE LINE OF SQL AND THREE THINGS THAT ARE NOT OBVIOUS FROM IT:
//
// 1. AN ABSENT `areaId` IS "EVERY AREA", NOT "NO AREA". The browser sends the
//    filter on every request, so in practice it is always present — but the
//    endpoints are public and a caller that omits it must get an unscoped list
//    rather than an empty one. `IN ()` is not valid SQL and `= NULL` is never
//    true; both are the shapes this returns an empty Fragment to avoid.
//
// 2. A ROW WITH `area_id IS NULL` IS EXCLUDED, SILENTLY, AND THAT IS ACCEPTED.
//    `0028` put the column on every report table and the PIPELINE fills it, so
//    until it does, a row is invisible on every screen in the app rather than
//    merely unattributed. TODOS §78 is the decision: the hierarchy axis is
//    CONTAINMENT — the area IS derivable from `work_unit_id`, permanently — so a
//    NULL is a missing LABEL and the fix is a BACKFILL upstream, not a residual
//    count on the payload. Contrast `0020`'s `product_id`, which is OCCUPANCY
//    OVER TIME: nothing can derive it, so every per-SKU read ships an
//    `unattributed` count beside it. Adding one here would invite a reader to
//    treat denormalisation lag as an attribution problem and would make it easier
//    to leave un-backfilled.
//
// 3. THE ALIAS IS `r` AND EVERY CALLER MUST USE IT. All four list queries alias
//    their report table as `r`; interpolating this into a query that does not
//    produces a runtime "missing FROM-clause entry", which NO fakeSql test can
//    see because that fake matches SQL text and never executes it. The integration
//    suites are where this is proved.
//
// It takes `db` and an id rather than a whole filter object so it cannot start
// reading a second field — the mistake `scopedRows` in report-window.ts refused
// when it was offered a scope-column parameter.
function areaScope(db: GoldDB, areaId: number | undefined): Fragment {
  return areaId === undefined ? db`` : db`AND r.area_id = ${areaId}`;
}

export { areaScope };
