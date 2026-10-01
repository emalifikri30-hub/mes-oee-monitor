import { Hono } from "hono";

import { WebResponse, buildPageMeta } from "@molca/network";
import { areaReportValidator } from "./area-report-dto.js";
import { requireReportId } from "../../shared/report-id.js";

import type { OeeTrend } from "../../shared/oee-trend.js";
import type {
  AreaActivity,
  AreaCoarseGrain,
  AreaDowntimeEventBreakdown,
  AreaReportFilter,
  AreaProductCounts,
  AreaProductionUnits,
  AreaRejectBreakdown,
  AreaReport,
  PagedAreaReport,
} from "./area-report.js";
import type { TAreaReportService } from "./area-report-service.js";
import type { AuthMiddleware, AuthEnv } from "@molca/mes";

type AreaReportHandlerDeps = {
  areaReportService: TAreaReportService;
  authMw: AuthMiddleware;
};

// The AREA report — the `Report > Area > By Day` and `By Monthly` screens.
//
// ONE IMPLEMENTATION BEHIND TWO PREFIXES, registered from a loop over
// ["day", "month"] and reading whichever table `GRAIN_TABLE` names — the same
// idiom as work-unit's coarse pair, work-center's three and `SCOPE_COLUMN` in the
// downtime module. The URLs stay separate because a path should say what it
// returns.
//
// THE DAY GRAIN SHIPPED FIRST WITH NO LOOP AT ALL, and this file said why: "an
// empty loop now would make the next reader hunt for the others". The loop is real
// now, and the two grains it serves are all there will ever be — the requirement
// is explicit ("only have 2 type of report on the Area"), so `AreaGrain` is a
// two-member union rather than a reuse of `ReportGrain` and a shift prefix cannot
// be registered here by widening anything.
//
// THE TWO LIST ROUTES SIT *OUTSIDE* THE LOOP, and that is the same call
// work-center's handler makes about its writes: the loop is for the routes that
// are genuinely one implementation, and the lists are not.
//
// They differ in their VALIDATOR and therefore in their validated SHAPE — the
// month list does not accept a `month` param at all, because the requirement is
// "Monthly Report (Show all month on selected year)" and a month filter would
// contradict its own heading. That is stricter than the six shipped By Monthly
// screens, which share one validator with their day siblings; see
// area-report-dto.ts.
//
// FOLDING THEM IN WAS TRIED AND IS WORSE. A loop reading `LIST_VALIDATOR[grain]`
// makes `c.req.valid("query")` a UNION of the two shapes, so `month` can only be
// reached through an `in` check that narrows to `unknown` and then needs a cast.
// The cast is the problem: it is exactly the place a future edit could start
// reading a month at month grain with nothing objecting. Two routes, each with its
// own typed destructure, need no cast at all — and `buildListFilter` below is what
// keeps the one piece they DO share from being written twice.
//
// MOUNTED AT `/areas`, beside `/work-units`, `/work-centers` and `/products` — the
// subject names the prefix. It does not collide with `/master-data/areas`: that is
// the area CATALOGUE (which areas exist, backing the header picker) and this is a
// MEASUREMENT of what they did, the same split `/master-data/work-centers` and
// `/work-centers` already keep two subjects over.
function createAreaReportHandler({ areaReportService, authMw }: AreaReportHandlerDeps) {
  const app = new Hono<AuthEnv>();

  app.use("*", authMw);

  // THE HALF THE TWO LIST ROUTES SHARE: the offset arithmetic, the service call and
  // the envelope. Written once so the two cannot page differently — `(page - 1) *
  // size` off by one on one screen and not the other shows as a missing row rather
  // than as an error.
  //
  // IT RETURNS THE ENVELOPE, NOT A RESPONSE, so each route calls `c.json` itself.
  // Passing the Hono context in would mean typing it, and its type carries the
  // route path AND the validated shape — which is exactly what differs between the
  // two callers. The envelope carries neither.
  //
  // The FILTER is the caller's, fully built, which is what keeps each route's
  // validated shape at the route.
  async function buildListEnvelope(
    // `AreaCoarseGrain`, so the dashboard's year list shares this envelope too. The
    // three lists differ only in which fields their validators declare, and that
    // difference stays at the route — which is the whole reason this takes a fully
    // built filter rather than a Hono context.
    grain: AreaCoarseGrain,
    page: number,
    size: number,
    filter: AreaReportFilter,
  ) {
    const { items, totalElements } = await areaReportService.listReports({
      grain,
      limit: size,
      offset: (page - 1) * size,
      filter,
    });

    return WebResponse.builder<PagedAreaReport["items"]>()
      .data(items)
      .meta(buildPageMeta(page, size, totalElements))
      .build();
  }

  // THE DAY LIST. Month, year, area and hide-zero.
  app.get("/day-reports", areaReportValidator.listDayReport, async (c) => {
    const { page, size, month, year, areaId, isHideZero } = c.req.valid("query");

    const envelope = await buildListEnvelope("day", page, size, {
      month,
      year,
      areaId,
      isHideZero,
    });

    return c.json(envelope, 200);
  });

  // THE MONTH LIST. Year, area and hide-zero — and `month` is not in scope here at
  // all, which is the dto's doing rather than this handler's discipline.
  app.get("/month-reports", areaReportValidator.listMonthReport, async (c) => {
    const { page, size, year, areaId, isHideZero } = c.req.valid("query");

    const envelope = await buildListEnvelope("month", page, size, {
      // EXPLICIT, not omitted, so `AreaReportFilter` stays one type rather than a
      // union three repository reads would have to narrow. The dto is what
      // guarantees nothing can arrive here; this line is what says so at the seam.
      month: undefined,
      year,
      areaId,
      isHideZero,
    });

    return c.json(envelope, 200);
  });

  // The six id-addressed routes ARE one implementation, so they loop. `AreaGrain`
  // is a two-member union, so this cannot produce a third prefix.
  for (const grain of ["day", "month"] as const) {
    app.get(`/${grain}-reports/:id`, async (c) => {
      const report = await areaReportService.getReport(grain, requireReportId(c.req.param("id")));

      return c.json(WebResponse.builder<AreaReport>().data(report).build(), 200);
    });

    // The OEE Performance dashboard's daily trend. MONTH ONLY, so it is registered
    // under an explicit literal rather than the loop's `${grain}` — a day report
    // has no days inside it to trend, and a /day-reports/:id/oee-trend would be a
    // route with nothing to answer.
    if (grain === "month") {
      app.get("/month-reports/:id/oee-trend", async (c) => {
        const trend = await areaReportService.getMonthOeeTrend(requireReportId(c.req.param("id")));

        return c.json(WebResponse.builder<OeeTrend>().data(trend).build(), 200);
      });
    }

    // SKU View. A ROLL-UP over the area's lines, and this is the one grain in this
    // schema where that is the right answer — see AreaProductCounts for why
    // contract §17.1's prohibition does not reach it. The DAY table answers both
    // grains by being widened, which is safe here and unsafe for the report tables
    // for one reason: this read sums COUNTS, and a count sums.
    app.get(`/${grain}-reports/:id/products`, async (c) => {
      const counts = await areaReportService.getProductCounts(
        grain,
        requireReportId(c.req.param("id")),
      );

      return c.json(WebResponse.builder<AreaProductCounts>().data(counts).build(), 200);
    });

    // The Input/Output Production KPI: production summed PER UNIT across the area's
    // lines, which is the half of the requirement the report row's mass columns
    // cannot answer.
    //
    // ITS OWN ROUTE RATHER THAN A FIELD ON `/:id`, for the argument `/:id/approval`
    // makes one subject over: answering it means three aggregates over every line
    // report in the window, and the browser AWAITS the report while only
    // prefetching this. Folding it in would put that fan-out on the path the route
    // loader blocks on — and at MONTH grain the window is thirty times wider, so
    // the argument gets thirty times stronger rather than weaker.
    app.get(`/${grain}-reports/:id/production-units`, async (c) => {
      const units = await areaReportService.getProductionUnits(
        grain,
        requireReportId(c.req.param("id")),
      );

      return c.json(WebResponse.builder<AreaProductionUnits>().data(units).build(), 200);
    });

    // The Quality Loss tab.
    app.get(`/${grain}-reports/:id/rejects`, async (c) => {
      const breakdown = await areaReportService.getRejectReasons(
        grain,
        requireReportId(c.req.param("id")),
      );

      return c.json(WebResponse.builder<AreaRejectBreakdown>().data(breakdown).build(), 200);
    });

    // The Others tab.
    app.get(`/${grain}-reports/:id/downtime-events`, async (c) => {
      const breakdown = await areaReportService.getDowntimeEventReasons(
        grain,
        requireReportId(c.req.param("id")),
      );

      return c.json(WebResponse.builder<AreaDowntimeEventBreakdown>().data(breakdown).build(), 200);
    });

    // The "…" menu's Log Activity panel. Two live arms — downtime edits on the
    // stops in this area, and the reject/rework an operator entered against its
    // lines — plus a named absence where the other screens have approvals. See
    // getActivity for why the absent arm is REPORTED rather than omitted, and why
    // its argument is stronger than the SKU grain's.
    //
    // SERVED AT BOTH GRAINS, unlike the LINE feed, which is shift-only because both
    // its arms scope by a shift window over the line's machine reports (§60). These
    // two arms scope by a business-DATE RANGE, so a month is the same query with a
    // wider end — no second endpoint and no second shape.
    app.get(`/${grain}-reports/:id/activity`, async (c) => {
      const activity = await areaReportService.getActivity(
        grain,
        requireReportId(c.req.param("id")),
      );

      return c.json(WebResponse.builder<AreaActivity>().data(activity).build(), 200);
    });
  }

  // WHAT IS DELIBERATELY ABSENT, so the next reader does not go looking:
  //
  //   /machines            an area's machines are a list of every machine in the
  //                        plant's area, and nothing on this screen asks for one.
  //                        The reject dialog's provenance picker — the only reason
  //                        the SKU grain has this path — does not exist here,
  //                        because there is no Add Reject on an area report (see
  //                        /quality-entries below).
  //   /performance         no hourly chart on this screen. There is no
  //                        `product_perf_area_hour` table and an area-summed curve
  //                        off the LINE hourly table would be the roll-up
  //                        contract §19.1 refuses one grain down. The Performance
  //                        Loss tab renders an empty state naming that.
  //   /hour-profile        same, and it is the MONTH grain's shape anyway.
  //   /approve /reopen     oee.work_unit_shift_report_approvals is keyed
  //   /approval            (work_unit_id, date, shift). An area day has neither,
  //                        and unlike a line shift there is no cascade defined for
  //                        it: approving an area would close every machine shift
  //                        report in it, which is not a permission any of the six
  //                        role variables grants. /activity EXISTS anyway and
  //                        reports the absence as one of its three sources.
  //   /quality-entries     an area report asks the operator for nothing. The
  //                        requirement is explicit — "no add reject/rework" — and
  //                        the schema agrees: an entry is keyed by LINE, so an
  //                        area-level Add button would have to pick one, which is
  //                        a choice the operator is already making on the line
  //                        screen. Note the CONTRAST with the SKU day report,
  //                        which DOES mount the ledger: there the line is fixed by
  //                        the report itself.
  //   /metrics-staleness   not at either grain yet (TODOS.md §50, §60). The
  //                        activity feed ships and the banner does not, which is
  //                        the same split the line's coarse grains have.
  //
  // AND NO `/shift-reports` PREFIX, WHICH THE LOOP MAKES STRUCTURAL RATHER THAN A
  // MATTER OF DISCIPLINE. `AreaGrain` is `"day" | "month"`, so the loop cannot
  // produce a third prefix and `grainFrom` would not compile for one. The
  // requirement is explicit — "only have 2 type of report on the Area" — and there
  // is no oee.area_shift_reports to serve.
  // ───────────────────────────────────────────────────────────────────────────
  // The YEAR grain — FOUR ROUTES, and it is NOT A THIRD REPORT GRAIN
  // ───────────────────────────────────────────────────────────────────────────
  //
  // READ THE PARAGRAPH ABOVE FIRST: "only have 2 type of report on the Area" is the
  // requirement, `AreaGrain` is two members, and nothing here weakens either. These
  // four routes are the OEE PERFORMANCE DASHBOARD's, which is a second surface over
  // the same tables (contract §23.2) rather than a report screen — so `AreaGrain`
  // stays two members and a separate `AreaCoarseGrain` is what reaches `0027`'s
  // table. `grainFrom("shift")` is still a build error; `/shift-reports` is still
  // unregisterable.
  //
  // FOUR, AND OUTSIDE THE LOOP, for the reason work-unit's block gives: the loop
  // mounts six sub-resources per grain and a year report has an answer for the list,
  // the detail, the OEE trend and the reject breakdown. No `products` (SKU View is a
  // report screen's card), no `production-units`, no `activity` (a year of an area's
  // feed fans out one quality query per line over ~1,095 shifts), no
  // `downtime-events`, and none of the mutations this subject already refuses at
  // both its report grains.
  app.get("/year-reports", areaReportValidator.listYearReport, async (c) => {
    const { page, size, year, areaId, isHideZero } = c.req.valid("query");

    const envelope = await buildListEnvelope("year", page, size, {
      // EXPLICIT, not omitted, for the month list's reason: `AreaReportFilter` stays
      // ONE type rather than a union the repository reads would have to narrow. The
      // dto is what guarantees nothing can arrive here; this line says so at the seam.
      month: undefined,
      year,
      areaId,
      isHideZero,
    });

    return c.json(envelope, 200);
  });

  app.get("/year-reports/:id", async (c) => {
    const report = await areaReportService.getReport("year", requireReportId(c.req.param("id")));

    return c.json(WebResponse.builder<AreaReport>().data(report).build(), 200);
  });

  // The dashboard's trend, and it plots MONTHS — twelve points, not ~365 days. It
  // reads `oee.area_month_reports`, rows `0025` already composed; it re-composes
  // nothing, because a rate is RECOMPUTED rather than summed.
  app.get("/year-reports/:id/oee-trend", async (c) => {
    const trend = await areaReportService.getYearOeeTrend(requireReportId(c.req.param("id")));

    return c.json(WebResponse.builder<OeeTrend>().data(trend).build(), 200);
  });

  app.get("/year-reports/:id/rejects", async (c) => {
    const breakdown = await areaReportService.getRejectReasons(
      "year",
      requireReportId(c.req.param("id")),
    );

    return c.json(WebResponse.builder<AreaRejectBreakdown>().data(breakdown).build(), 200);
  });

  return app;
}

export { createAreaReportHandler };
