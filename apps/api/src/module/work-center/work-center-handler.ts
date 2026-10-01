import { Hono } from "hono";

import { WebResponse } from "@molca/network";
import { requireActor } from "../../shared/actor.js";
import { workCenterValidator } from "./work-center-dto.js";

import type { OeeTrend } from "../../shared/oee-trend.js";
import type {
  LineActivity,
  LineMachineList,
  LineShiftPerformance,
  WorkCenterReport,
  WorkCenterReportListRow,
} from "./work-center.js";
import type {
  LineApprovalSummary,
  LineDowntimeEventBreakdown,
  LineProductCounts,
  LineRejectBreakdown,
  TWorkCenterReportService,
} from "./work-center-service.js";
import type { AuthMiddleware, AuthEnv } from "@molca/mes";
import { requireReportId } from "../../shared/report-id.js";

type WorkCenterHandlerDeps = {
  workCenterReportService: TWorkCenterReportService;
  authMw: AuthMiddleware;
};

// The Line report lists — the `Report > Line > {By Shift, By Day, By Monthly}`
// screens.
//
// THREE ROUTE PREFIXES OVER ONE IMPLEMENTATION. The service and repository take a
// grain and read whichever of the three work_center_* tables it names; the URLs
// stay separate because a path should say what it returns, and
// `/reports?grain=day` would make every bookmark and every log line one query
// param harder to read.
//
// Registered from a loop rather than written three times, so a fix to one is a fix
// to all three — the same reason work-unit's handler loops over ["day","month"]
// and GRAIN_TABLE exists in the repository.
//
// MOUNTED AT /work-centers, BESIDE /master-data/work-centers RATHER THAN UNDER IT.
// Those are two different things: the catalogue upstream, and this service's Gold
// reports about them. It mirrors the /work-units vs /master-data split already
// shipped.
//
// WHAT THESE ROUTES DELIBERATELY DO NOT HAVE:
//
//   no `status` filter on the lists
//       oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift)
//       and these tables have NO work_unit_id column at all, so there is nothing
//       for the list query to correlate against. Approve and reopen DO exist now,
//       at shift grain only — see below; they write the machine approvals rather
//       than any line row, which is why the list still cannot filter on them
//       without a join it does not do.
//
//   no bare `/work-centers/:id`
//       under this prefix that reads as "the work center", which is the master-data
//       catalogue's meaning, not "the report". The detail screen has landed, and it
//       is /work-centers/{grain}-reports/:id — as this comment said it would be.
//
//   no `shift` on the two coarse lists
//       there is no shift at those grains. The schema omits it, so `?shift=2` is
//       stripped rather than rejected — matching the shipped behaviour of
//       /work-units/{day,month}-reports, which work-unit-handler.test.ts codifies.
//       Diverging from that quietly would be worse than either choice.
function createWorkCenterHandler({ workCenterReportService, authMw }: WorkCenterHandlerDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMw);

  for (const grain of ["shift", "day", "month"] as const) {
    // The shift list is the only one that takes a `shift`, so it is the only one
    // that gets the wider validator.
    const validator =
      grain === "shift"
        ? workCenterValidator.listShiftReport
        : workCenterValidator.listPeriodReport;

    app.get(`/${grain}-reports`, validator, async (c) => {
      const query = c.req.valid("query");
      const { page, size, month, year, workCenterId, areaId, isHideZero } = query;
      // `shift` is present on the shift schema only; reading it off the union
      // narrows to undefined at the other two grains, which is exactly what the
      // repository expects.
      const shift = "shift" in query ? query.shift : undefined;

      const { items, meta } = await workCenterReportService.getPagedReport(grain, page, size, {
        month,
        year,
        shift,
        workCenterId,
        areaId,
        isHideZero,
      });

      return c.json(
        WebResponse.builder<WorkCenterReportListRow[]>().data(items).meta(meta).build(),
        200,
      );
    });

    // The detail screen. Inside the same loop, because the three grains differ by
    // exactly one column here too — and a fix to one is then a fix to all three.
    //
    // 404 FOR AN UNKNOWN ID, where the list above answers 200-empty. Not an
    // inconsistency: see getReport. A list request names a filter, a detail
    // request names a row.
    app.get(`/${grain}-reports/:id`, async (c) => {
      const report = await workCenterReportService.getReport(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<WorkCenterReport>().data(report).build(), 200);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Part 3's hourly trendline
    // ─────────────────────────────────────────────────────────────────────────
    //
    // TWO ROUTES, NOT ONE, and the month gets the other. A shift or a day returns
    // 24 buckets keyed on an INSTANT; a month returns 24 hour-of-DAY buckets keyed
    // on a clock hour that occurred ~30 times. The payloads genuinely differ, so
    // one path returning two shapes is the thing a caller gets wrong once and
    // works around forever — the same split /work-units already has.
    if (grain !== "month") {
      app.get(`/${grain}-reports/:id/performance`, async (c) => {
        const performance = await workCenterReportService.getPerformance(
          grain,
          requireReportId(c.req.param("id")),
        );
        return c.json(WebResponse.builder<LineShiftPerformance>().data(performance).build(), 200);
      });
    } else {
      app.get(`/${grain}-reports/:id/hour-profile`, async (c) => {
        const profile = await workCenterReportService.getHourProfile(
          requireReportId(c.req.param("id")),
        );
        return c.json(WebResponse.builder<LineShiftPerformance>().data(profile).build(), 200);
      });

      // The OEE Performance dashboard's daily trend. MONTH ONLY, in this arm for
      // that reason — a shift or a day report has no days inside it to trend.
      app.get("/month-reports/:id/oee-trend", async (c) => {
        const trend = await workCenterReportService.getMonthOeeTrend(
          requireReportId(c.req.param("id")),
        );
        return c.json(WebResponse.builder<OeeTrend>().data(trend).build(), 200);
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Part 2's four sub-resources, all three grains
    // ─────────────────────────────────────────────────────────────────────────

    // SKU View. Reads the 0016 tables, which ship EMPTY — the payload's
    // `loadedThrough` is what lets the card say "not loaded yet" rather than
    // "this line produced nothing".
    app.get(`/${grain}-reports/:id/products`, async (c) => {
      const counts = await workCenterReportService.getProductCounts(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<LineProductCounts>().data(counts).build(), 200);
    });

    // Machine View. The one read here whose COST depends on the grain — shift
    // makes no upstream call at any grain — every work_unit_* report table carries
    // work_center_id. See getMachines.
    app.get(`/${grain}-reports/:id/machines`, async (c) => {
      const machines = await workCenterReportService.getMachines(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<LineMachineList>().data(machines).build(), 200);
    });

    // The Losses page's Quality Loss tab.
    app.get(`/${grain}-reports/:id/rejects`, async (c) => {
      const breakdown = await workCenterReportService.getRejectReasons(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<LineRejectBreakdown>().data(breakdown).build(), 200);
    });

    // The Losses page's Others tab.
    app.get(`/${grain}-reports/:id/downtime-events`, async (c) => {
      const breakdown = await workCenterReportService.getDowntimeEventReasons(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<LineDowntimeEventBreakdown>().data(breakdown).build(), 200);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // The "…" menu's Log Activity sheet
    // ─────────────────────────────────────────────────────────────────────────
    //
    // INSIDE THE LOOP, and it was outside it until TODOS §60 was answered. The
    // reason it sat with the approval block was stated as "both of its arms are
    // scoped by a shift window over the line's machine reports" — half true. The
    // DOWNTIME arm was always a plain [from, to) instant window that never read a
    // shift; only the approval join narrowed by one, and a day report's window
    // simply contains three shifts' worth of machine reports instead of one.
    //
    // WHY THAT IS NOT THE APPROVAL BLOCK'S ARGUMENT. Approve and reopen stay shift
    // grain because a day approval would be a CASCADE over three shifts as well as
    // N machines — an authority nobody has granted (§48). READING what happened
    // over the same window grants nothing, so the two questions have different
    // answers even though they look alike.
    //
    // ONE SHAPE FOR THREE GRAINS, so the browser renders all three through the one
    // sheet. What differs is the density and the LABELS — see getActivity.
    app.get(`/${grain}-reports/:id/activity`, async (c) => {
      const activity = await workCenterReportService.getActivity(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<LineActivity>().data(activity).build(), 200);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The line approval — SHIFT GRAIN ONLY
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Outside the grain loop, deliberately. A day or month line report has nothing
  // to sign: the approvals table is keyed (work_unit_id, date, shift), so a line
  // DAY approval would be a cascade over three shifts as well as N machines — the
  // question TODOS §48 holds, and answering it by accident here would give the app
  // two definitions of "approved".
  //
  // THESE ROUTES WRITE oee.work_unit_shift_report_approvals, NOT ANY work_center_*
  // TABLE. Approving a line closes every machine shift report on it; its own
  // status is derived by counting them. Migration 0014's trigger comment — "no
  // operator mutation targets these three tables" — therefore still holds, and the
  // downtime freeze needs no change at all, since listApprovalsOverlapping already
  // reads the rows this writes.

  // The Status tile's payload. Its own route rather than a field on the detail
  // response: it runs two COUNT queries over the machine reports and their
  // approvals, and the browser AWAITS the detail request while merely prefetching
  // this one — so a scan on the blocking path of every page view is what is being
  // avoided. Same reasoning as /work-units/shift-reports/:id/metrics-staleness.
  //
  // (It also used to resolve the line's roster from mes-master-data, which was the
  // original reason for splitting it out. That call is gone — work_center_id scopes
  // the rows — and the split still stands on the scan alone.)
  app.get("/shift-reports/:id/approval", async (c) => {
    const summary = await workCenterReportService.getApprovalSummary(
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<LineApprovalSummary>().data(summary).build(), 200);
  });

  // 200 and not 204: the browser flips the Status tile from this payload rather
  // than from a refetch, which is contract §8's read-after-write rule.
  app.post("/shift-reports/:id/approve", async (c) => {
    const summary = await workCenterReportService.approveLineShift(
      requireReportId(c.req.param("id")),
      requireActor(c),
    );
    return c.json(WebResponse.builder<LineApprovalSummary>().data(summary).build(), 200);
  });

  // A SEPARATE NAMED ROUTE rather than a PATCH .../status, for the reason
  // work-unit-handler.ts gives: a general status route publishes both transitions
  // the moment it exists, and each of these has its own conflict semantics and its
  // own role variable.
  app.post("/shift-reports/:id/reopen", async (c) => {
    const summary = await workCenterReportService.reopenLineShift(
      requireReportId(c.req.param("id")),
      requireActor(c),
    );
    return c.json(WebResponse.builder<LineApprovalSummary>().data(summary).build(), 200);
  });

  // The stale-metrics banner. STILL SHIFT GRAIN ONLY, and now the only thing in
  // this block that is scoped that way for a reason other than an authority: it
  // reads through `resolveLineShift`, and nothing coarser has been built.
  // TODOS §60's other half.
  app.get("/shift-reports/:id/metrics-staleness", async (c) => {
    const staleness = await workCenterReportService.getMetricsStaleness(
      requireReportId(c.req.param("id")),
    );
    return c.json(
      WebResponse.builder<{ categoryEditedAt: Date | null }>().data(staleness).build(),
      200,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The YEAR grain — FOUR ROUTES, OUTSIDE the loop above
  // ───────────────────────────────────────────────────────────────────────────
  //
  // That loop registers eight sub-resources per grain because all three of its
  // tables differ by exactly one column and share every one of them. The year table
  // shares FOUR: the list, the detail, the OEE trend and the reject breakdown.
  //
  // What it deliberately does not get: no `products` or `machines` (both are REPORT
  // screen cards, and there is no year report screen), no `performance` /
  // `hour-profile` (~8,760 points is not a chart), no `downtime-events` (the Losses
  // page's Others tab, same absence), no `activity`, no `quality-entries` (an entry
  // is keyed by LINE and business DAY), no `metrics-staleness`, and — the one worth
  // stating loudest — NO `approve` / `reopen` / `approval`.
  //
  // THE APPROVAL ABSENCE IS THE STRONGEST OF THE SET. A line's approve is already a
  // CASCADE: one click closes every machine shift report on the line. At year grain
  // it would close every machine shift report on the line FOR A YEAR — roughly
  // 1,095 shifts times N machines — which is not the permission `APPROVE_LINE_ROLE`
  // grants, and there is no fifth role variable for it because nobody has decided
  // there should be. §48 holds the day-grain version of the same question and it is
  // still open one grain down.
  app.get("/year-reports", workCenterValidator.listYearReport, async (c) => {
    const { page, size, year, workCenterId, areaId, isHideZero } = c.req.valid("query");
    const { items, meta } = await workCenterReportService.getPagedReport("year", page, size, {
      // NO `month` and NO `shift`. The validator declares neither.
      year,
      workCenterId,
      areaId,
      isHideZero,
    });

    return c.json(
      WebResponse.builder<WorkCenterReportListRow[]>().data(items).meta(meta).build(),
      200,
    );
  });

  app.get("/year-reports/:id", async (c) => {
    const report = await workCenterReportService.getReport(
      "year",
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<WorkCenterReport>().data(report).build(), 200);
  });

  // The dashboard's trend, and it plots MONTHS — twelve points, not ~365 days.
  app.get("/year-reports/:id/oee-trend", async (c) => {
    const trend = await workCenterReportService.getYearOeeTrend(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<OeeTrend>().data(trend).build(), 200);
  });

  // The LINE's own reject table (0019) widened over a year — not the machines'.
  app.get("/year-reports/:id/rejects", async (c) => {
    const breakdown = await workCenterReportService.getRejectReasons(
      "year",
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<LineRejectBreakdown>().data(breakdown).build(), 200);
  });

  return app;
}

export { createWorkCenterHandler };
