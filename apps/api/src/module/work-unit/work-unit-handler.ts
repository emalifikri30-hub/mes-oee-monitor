import { Hono } from "hono";

import { WebResponse } from "@molca/network";
import { requireActor } from "../../shared/actor.js";
import { workUnitValidator } from "./work-unit-dto.js";

import type { OeeTrend } from "../../shared/oee-trend.js";
import type {
  HourOfDayProfile,
  WorkUnitPeriodReport,
  WorkUnitPeriodReportEnrichedList,
  DowntimeEventBreakdown,
  RejectReasonBreakdown,
  ShiftActivity,
  ShiftPerformance,
  MetricsStaleness,
  ShiftProductCounts,
  ShiftReportApproval,
  WorkUnitShiftReport,
  WorkUnitShiftReportEnrichedList,
} from "./work-unit.js";
import type { TWorkUnitReportService } from "./work-unit-service.js";
import type { AuthMiddleware, AuthEnv } from "@molca/mes";
import { requireReportId } from "../../shared/report-id.js";

type WorkUnitHandlerDeps = {
  workUnitReportService: TWorkUnitReportService;
  authMw: AuthMiddleware;
};

function createWorkUnitHandler({ workUnitReportService, authMw }: WorkUnitHandlerDeps) {
  const app = new Hono<AuthEnv>();
  app.use("*", authMw);

  // `status` is filtered SERVER-SIDE rather than by the browser over a page it has
  // already paid to fetch — which is the point of TODOS.md §36. It is also the
  // first question anyone asks of a list that has an approval badge, and until now
  // the badge was there and the filter was not.
  app.get("/shift-reports", workUnitValidator.listShiftReport, async (c) => {
    const { page, size, month, year, shift, workCenterId, areaId, isHideZero, status } =
      c.req.valid("query");
    const filter = { month, year, shift, workCenterId, areaId, isHideZero, status };
    const { items, meta } = await workUnitReportService.getPagedShiftReport(page, size, filter);
    return c.json(
      WebResponse.builder<WorkUnitShiftReportEnrichedList[]>().data(items).meta(meta).build(),
      200,
    );
  });

  app.get("/shift-reports/:id", async (c) => {
    const report = await workUnitReportService.getShiftReport(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<WorkUnitShiftReport>().data(report).build(), 200);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // By Day and By Monthly
  // ───────────────────────────────────────────────────────────────────────────
  //
  // TWO ROUTE PREFIXES OVER ONE IMPLEMENTATION. The service and repository take
  // a grain and read whichever table it names; the URLs stay separate because a
  // path should say what it returns, and `/period-reports?grain=day` would make
  // every bookmark and every log line one query param harder to read.
  //
  // Registered from a loop rather than written twice, so a fix to one is a fix to
  // both — the same reason GRAIN_TABLE exists in the repository.
  //
  // No approve or reopen at either grain. oee.work_unit_shift_report_approvals
  // is keyed (work_unit_id, date, shift) and there is nothing here to key a
  // sign-off on; the detail payload carries a DERIVED count of its child shifts
  // instead. See PeriodApprovalSummary.
  for (const grain of ["day", "month"] as const) {
    app.get(`/${grain}-reports`, workUnitValidator.listPeriodReport, async (c) => {
      const { page, size, month, year, workCenterId, areaId, isHideZero } = c.req.valid("query");
      const { items, meta } = await workUnitReportService.getPagedPeriodReport(grain, page, size, {
        month,
        year,
        workCenterId,
        areaId,
        isHideZero,
      });
      return c.json(
        WebResponse.builder<WorkUnitPeriodReportEnrichedList[]>().data(items).meta(meta).build(),
        200,
      );
    });

    app.get(`/${grain}-reports/:id`, async (c) => {
      const report = await workUnitReportService.getPeriodReport(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<WorkUnitPeriodReport>().data(report).build(), 200);
    });

    // The Losses card's View button, and the Performance Loss tab's Trendline.
    //
    // TWO PATHS, ONE PER GRAIN, because the payloads genuinely differ: a day
    // returns 24 hourly buckets keyed on an INSTANT, a month returns 24
    // hour-of-day buckets keyed on a clock hour that occurred ~30 times. Both
    // registered here rather than one path returning two shapes.
    if (grain === "day") {
      app.get("/day-reports/:id/performance", async (c) => {
        const performance = await workUnitReportService.getPeriodPerformance(
          grain,
          requireReportId(c.req.param("id")),
        );
        return c.json(WebResponse.builder<ShiftPerformance>().data(performance).build(), 200);
      });
    } else {
      app.get("/month-reports/:id/hour-profile", async (c) => {
        const profile = await workUnitReportService.getMonthHourProfile(
          requireReportId(c.req.param("id")),
        );
        return c.json(WebResponse.builder<HourOfDayProfile>().data(profile).build(), 200);
      });

      // The OEE Performance dashboard's daily trend. MONTH ONLY, and it sits in
      // this arm rather than beside metrics-staleness below for that reason: a
      // day report has no days inside it to trend, so a /day-reports/:id/oee-trend
      // would be a route with nothing to answer. The handler test asserts it is
      // not registered.
      app.get("/month-reports/:id/oee-trend", async (c) => {
        const trend = await workUnitReportService.getMonthOeeTrend(
          requireReportId(c.req.param("id")),
        );
        return c.json(WebResponse.builder<OeeTrend>().data(trend).build(), 200);
      });
    }

    // The stale-metrics banner, at both coarse grains — TODOS §50's remaining
    // half. Its own route rather than a field on the report payload, for the
    // reason the shift sibling states at length: this scans the window's stops
    // and the report below is AWAITED, so folding it in would put that scan on
    // the blocking path of every page view for a banner absent on almost all
    // of them.
    app.get(`/${grain}-reports/:id/metrics-staleness`, async (c) => {
      const staleness = await workUnitReportService.getPeriodMetricsStaleness(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<MetricsStaleness>().data(staleness).build(), 200);
    });

    // The "…" menu's Log Activity sheet. See getPeriodActivity for what it can
    // honestly show at these grains and what it reports as untracked.
    app.get(`/${grain}-reports/:id/activity`, async (c) => {
      const activity = await workUnitReportService.getPeriodActivity(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<ShiftActivity>().data(activity).build(), 200);
    });

    // The Losses page's Quality tab.
    app.get(`/${grain}-reports/:id/rejects`, async (c) => {
      const breakdown = await workUnitReportService.getPeriodRejectReasons(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<RejectReasonBreakdown>().data(breakdown).build(), 200);
    });

    // The Losses page's Others tab.
    app.get(`/${grain}-reports/:id/downtime-events`, async (c) => {
      const breakdown = await workUnitReportService.getPeriodDowntimeEventReasons(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<DowntimeEventBreakdown>().data(breakdown).build(), 200);
    });

    // The SKU View card. Unpaged for the reason its shift sibling is: the grain
    // bounds the answer to the products one machine ran in one period.
    app.get(`/${grain}-reports/:id/products`, async (c) => {
      const counts = await workUnitReportService.getPeriodProductCounts(
        grain,
        requireReportId(c.req.param("id")),
      );
      return c.json(WebResponse.builder<ShiftProductCounts>().data(counts).build(), 200);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The YEAR grain — FOUR ROUTES, and the absences are the design
  // ───────────────────────────────────────────────────────────────────────────
  //
  // REGISTERED HERE RATHER THAN BY ADDING "year" TO THE LOOP ABOVE, and that is
  // the whole point of the block. That loop registers NINE routes per grain, and a
  // year report has an answer for only four of them:
  //
  //   list · detail · oee-trend · rejects
  //
  // What it deliberately does NOT get, each for its own reason:
  //
  //   no `products`           oee.product_count_wu_day widened over a year is a
  //                           scan for a card no screen renders — SKU View is a
  //                           REPORT screen's, and there is no year report screen.
  //   no `performance` / `hour-profile`
  //                           a day returns 24 hourly buckets and a month 24
  //                           hour-of-day ones; a year has no third shape anyone
  //                           has designed, and ~8,760 points is not a chart.
  //   no `downtime-events`    the Losses page's Others tab, and again there is no
  //                           year Losses page to open it from.
  //   no `activity`           a feed over a year is ~1,095 shifts of transitions,
  //                           which is a scan rather than a reading.
  //   no `metrics-staleness`  nothing coarser than a shift has been built at all
  //                           (§50, §60).
  //   no `approve` / `reopen` there is no key. oee.work_unit_shift_report_approvals
  //                           is keyed (work_unit_id, date, shift), and approving a
  //                           year would close every shift report inside it — an
  //                           authority none of the six role variables grants.
  //
  // Adding "year" to the loop would register all nine, and five of them would be
  // real URLs answering 200 with an expensive scan nobody asked for. `CoarseGrain`
  // is the type that keeps the other five unreachable: the service methods they
  // call take `PeriodGrain`, so a year id cannot COMPILE into them.
  app.get("/year-reports", workUnitValidator.listYearReport, async (c) => {
    const { page, size, year, workCenterId, areaId, isHideZero } = c.req.valid("query");
    const { items, meta } = await workUnitReportService.getPagedPeriodReport("year", page, size, {
      // NO `month`. The validator refuses one, so there is none to pass — see
      // listYearReportInputSchema.
      year,
      workCenterId,
      areaId,
      isHideZero,
    });

    return c.json(
      WebResponse.builder<WorkUnitPeriodReportEnrichedList[]>().data(items).meta(meta).build(),
      200,
    );
  });

  app.get("/year-reports/:id", async (c) => {
    const report = await workUnitReportService.getPeriodReport(
      "year",
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<WorkUnitPeriodReport>().data(report).build(), 200);
  });

  // The dashboard's trend, and it plots MONTHS — twelve points, not ~365 days.
  // See listYearOeeTrend for why the inner table is one grain finer and never two.
  app.get("/year-reports/:id/oee-trend", async (c) => {
    const trend = await workUnitReportService.getYearOeeTrend(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<OeeTrend>().data(trend).build(), 200);
  });

  // The Six Big Losses card's quality arm and the Pareto Quality Losses card. The
  // one sub-resource the dashboard needs that is not the report row itself.
  app.get("/year-reports/:id/rejects", async (c) => {
    const breakdown = await workUnitReportService.getPeriodRejectReasons(
      "year",
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<RejectReasonBreakdown>().data(breakdown).build(), 200);
  });

  // The per-SKU output breakdown of one report. A sub-resource rather than a
  // top-level /product-counts collection: the rows are keyed by the report's own
  // work unit, business day and shift, so taking the report id lets Postgres join
  // the two tables instead of making the browser round-trip three values it read
  // off one of them.
  //
  // Unpaged, hence no `meta`. The grain bounds the answer to the SKUs one machine
  // ran in one shift; product_count_rows is the instrument that says if that ever
  // stops being true.
  //
  // AN OBJECT NOW, WHERE THIS USED TO RETURN A BARE ARRAY — and the comment on the
  // route below still says "unlike /products" because that is the sentence this
  // change makes obsolete, so it is corrected there too.
  //
  // The reason is TODOS.md §14: an empty array cannot say WHY it is empty, and the
  // two reasons are opposite claims. A machine that genuinely ran nothing and a
  // business day the pipeline has not reached both rendered as "No product output
  // recorded for this shift". `loadedThrough` is what separates them, and
  // `timeZone` is what lets the browser reduce the report's shift-start instant to
  // a business day to compare against it.
  app.get("/shift-reports/:id/products", async (c) => {
    const counts = await workUnitReportService.getProductCounts(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<ShiftProductCounts>().data(counts).build(), 200);
  });

  // The hourly production profile of one report — the drill-down behind the Losses
  // card's View button. A sub-resource for the same reason /products is.
  //
  // An OBJECT rather than a bare array — as /products now is too, for the same
  // reason. It carries two facts the
  // buckets cannot state about themselves: the plant's `timeZone`, because the
  // labels are local clock hours and the browser has no zone table; and
  // `loadedThrough`, the pipeline's watermark, which is what separates "this shift
  // has not loaded yet" from "this machine made nothing".
  //
  // Unpaged, hence no `meta`. The grain is bounded by one shift — 8 hourly buckets
  // times the SKUs one machine ran — and perf_hour_points is the instrument that
  // says if that ever stops being true.
  app.get("/shift-reports/:id/performance", async (c) => {
    const data = await workUnitReportService.getPerformance(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<ShiftPerformance>().data(data).build(), 200);
  });

  // The per-counter reject breakdown behind the Losses page's Quality Loss
  // Pareto. A sub-resource for the same reason /products and /performance are:
  // the rows are keyed by the report's own work unit, business day and shift, so
  // taking the report id lets Postgres join the two tables instead of making the
  // browser round-trip three values it read off one of them.
  //
  // An OBJECT, like /performance. Besides the plant's `timeZone` and the
  // pipeline's `loadedThrough`, it carries FOUR grand totals — one per measure
  // the Pareto can rank by — because the browser's cumulative line divides by the
  // response's own totals rather than by the sum of the bars it drew.
  //
  // `loadedThrough` matters more on this endpoint than on any other.
  // oee.reject_count_wu_shift is empty until the `work_unit_*` DAG writes it, so
  // an empty `buckets` is the normal answer for every shift right now, and this
  // is the only field that separates that from a shift with no rejects.
  //
  // Unpaged, hence no `meta`. The grain bounds the answer to the reject counters
  // one machine has wired to it; reject_reason_groups is the instrument that says
  // if that ever stops being true.
  app.get("/shift-reports/:id/rejects", async (c) => {
    const data = await workUnitReportService.getRejectReasons(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<RejectReasonBreakdown>().data(data).build(), 200);
  });

  // The downtime-reason FREQUENCY breakdown behind the Losses page's "Others"
  // tab. A sub-resource for the reason /products, /performance and /rejects are:
  // the rows are keyed on the report's own work unit, business day and shift, so
  // taking the report id lets Postgres join the two tables instead of making the
  // browser round-trip three values it read off one of them.
  //
  // NOT a scoped endpoint on the /downtimes router, and deliberately so. Every
  // endpoint on that router reads oee.downtime_reports, which operators edit;
  // this reads the immutable oee.downtime_log_events. Putting them side by side
  // would invite exactly the consolidation the product decision forbids — see
  // TODOS.md §30.
  //
  // FREQUENCY ONLY. There is no duration on the response because there is none in
  // the table: the log records that a reason was cited, not how long it lasted.
  //
  // An OBJECT, like /performance and /rejects. Besides the plant's `timeZone` and
  // the pipeline's `loadedThrough` it carries TWO totals, of which only ONE is a
  // denominator:
  //
  //   totalOccurrences — the sum of the bars, each reason counted once per event
  //                      that cited it. THIS is what the cumulative line divides
  //                      by.
  //   totalEvents      — the number of stops, which is SMALLER as soon as any stop
  //                      cited several reasons. It ships so the card can tell the
  //                      reader the bars sum to occurrences rather than to stops.
  //                      DO NOT DIVIDE BY IT.
  //
  // `loadedThrough` matters as much here as on /rejects: oee.downtime_log_events
  // is empty until the `work_unit_*` DAG writes it, so an empty `buckets` is the
  // normal answer for every shift right now, and this is the only field that
  // separates that from a shift nothing stopped.
  //
  // Unpaged, hence no `meta`. The grain bounds the answer to the reasons one
  // machine's stops cited in one shift; downtime_event_groups is the instrument
  // that says if that ever stops being true.
  app.get("/shift-reports/:id/downtime-events", async (c) => {
    const data = await workUnitReportService.getDowntimeEventReasons(
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<DowntimeEventBreakdown>().data(data).build(), 200);
  });

  // The report's audit trail: approval transitions and downtime edits for THIS
  // shift's stops, merged newest-first.
  //
  // Unpaged, hence no `meta` — a chronology, not a table, the rule
  // /downtimes/by-reason/history already states. No validator either: the report
  // id is the whole request, like /products and /rejects.
  //
  // `sources` IS THE POINT, and it carries more weight here than `trackedMembers`
  // does one endpoint over. `entries` is empty for nearly every report today and
  // one of its three arms can NEVER be non-empty, so a bare array would render as
  // "nothing has ever happened to this report" over data that is largely
  // untrackable. See ShiftActivity.
  app.get("/shift-reports/:id/activity", async (c) => {
    const data = await workUnitReportService.getActivity(requireReportId(c.req.param("id")));
    return c.json(WebResponse.builder<ShiftActivity>().data(data).build(), 200);
  });

  // Approve a shift report: open -> closed. THE FIRST WRITE ROUTE IN THIS SERVICE.
  //
  // POST /:id/approve rather than PATCH /:id/status, and reversibility is the
  // argument FOR the named action rather than against it. A general state setter
  // publishes `{"status":"open"}` as a request a client can construct the moment
  // it exists, so it would have to either 400 the only other value in its own
  // vocabulary or implement reopen before product asked for it. `approve` admits
  // exactly one transition; reopen arrives as its own route with its own role
  // gate and its own 409 semantics (TODOS.md §33).
  //
  // It also matches the grammar of the five routes above, and it makes the
  // conflict status honest: a repeated PATCH to a value already held is
  // conventionally 200, whereas a repeated named action is legitimately 409.
  //
  // BODYLESS. Nothing in the design takes a note, so there is no jsonValidator
  // here — and adding one would actively break the call: jsonValidator(z.object({}))
  // rejects a POST with no `Content-Type: application/json`, which is exactly what
  // a bodyless fetch sends. A `note` column is one ALTER TABLE away if product
  // asks. (§21's OTHER half, the downtime edit, is where jsonValidator DID earn
  // its place — see downtime-dto.ts, which is the service's only one.)
  //
  // 200 and not 204: contract §8 is explicit that approvals need read-after-write,
  // and the browser flips the badge from this payload rather than from a refetch.
  app.post("/shift-reports/:id/approve", async (c) => {
    const approval = await workUnitReportService.approveShiftReport(
      requireReportId(c.req.param("id")),
      requireActor(c),
    );
    return c.json(WebResponse.builder<ShiftReportApproval>().data(approval).build(), 200);
  });

  // closed -> open. The other half of the state machine, and a SEPARATE named
  // route for the reason spelled out above /approve: a general PATCH /:id/status
  // publishes both transitions the moment it exists, so each arrives when product
  // asks for it and with its own conflict semantics.
  //
  // It arrives now because the downtime edit refuses to touch a stop belonging to
  // an approved report (409). Without a reopen, an operator who spots a genuine
  // mistake on a signed-off report has no way to correct it at all — the freeze
  // would be a trap rather than a control.
  //
  // Bodyless and 200, for the same two reasons approve is.
  app.post("/shift-reports/:id/reopen", async (c) => {
    const approval = await workUnitReportService.reopenShiftReport(
      requireReportId(c.req.param("id")),
      requireActor(c),
    );
    return c.json(WebResponse.builder<ShiftReportApproval>().data(approval).build(), 200);
  });

  // Whether an operator edit has moved a stop's CATEGORY since the pipeline last
  // computed this report's aggregates.
  //
  // ITS OWN ROUTE RATHER THAN A FIELD ON /shift-reports/:id, and the reason is
  // the detail page's loader: it AWAITS the report, so anything folded into that
  // query blocks the whole screen. This read scans oee.downtime_reports for the
  // shift's stops — the shape /activity pays for, but /activity is only asked
  // when somebody opens the Log Activity sheet, whereas this would be asked on
  // every page view. The route lets the browser prefetch it WITHOUT awaiting,
  // exactly as it already does for the timeline.
  //
  // It is also where the recalculation status belongs when that trigger ships
  // (TODOS.md), which is a second reason not to bury it in the report payload.
  //
  // No validator: the report id is the whole request, like /products and
  // /activity.
  app.get("/shift-reports/:id/metrics-staleness", async (c) => {
    const staleness = await workUnitReportService.getMetricsStaleness(
      requireReportId(c.req.param("id")),
    );
    return c.json(WebResponse.builder<MetricsStaleness>().data(staleness).build(), 200);
  });

  return app;
}

export { createWorkUnitHandler };
export type { WorkUnitHandlerDeps };
