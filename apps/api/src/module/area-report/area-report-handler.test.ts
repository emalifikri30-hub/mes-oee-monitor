import { describe, expect, it, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";

import { createAreaReportHandler } from "./area-report-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { TAreaReportService } from "./area-report-service.js";

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so routing, the query contract and the envelope can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  const listReports = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
  const getReport = vi.fn().mockResolvedValue({ id: 11, grain: "day" });
  const getProductCounts = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });
  const getProductionUnits = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    infeed: [],
    output: [],
    infeedUnresolved: 0,
    outputUnresolved: 0,
    loadedThrough: null,
  });
  const getRejectReasons = vi.fn().mockResolvedValue({ buckets: [] });
  const getDowntimeEventReasons = vi.fn().mockResolvedValue({ buckets: [] });
  const getActivity = vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", entries: [], sources: [] });

  const getMonthOeeTrend = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });
  const getYearOeeTrend = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });

  const service = {
    listReports,
    getReport,
    getMonthOeeTrend,
    getYearOeeTrend,
    getProductCounts,
    getProductionUnits,
    getRejectReasons,
    getDowntimeEventReasons,
    getActivity,
  } as unknown as TAreaReportService;

  return {
    app: createAreaReportHandler({ areaReportService: service, authMw }),
    listReports,
    getReport,
    getProductCounts,
    getProductionUnits,
    getRejectReasons,
    getDowntimeEventReasons,
    getActivity,
    getMonthOeeTrend,
    getYearOeeTrend,
  };
}

describe("createAreaReportHandler — /day-reports", () => {
  it("forwards the four filters and pages from 1", async () => {
    const { app, listReports } = setup();

    const res = await app.request("/day-reports?page=2&size=25&month=9&year=2026&areaId=2");

    expect(res.status).toBe(200);
    expect(listReports).toHaveBeenCalledWith({
      grain: "day",
      limit: 25,
      offset: 25,
      filter: { month: 9, year: 2026, areaId: 2, isHideZero: false },
    });
  });

  // ONLY THE LITERAL "true" HIDES ZERO-OEE ROWS, matching the shared coercion and
  // every other list. `?isHideZero=false` must read as "show everything" rather
  // than as a filter that is set and does nothing.
  it.each([
    ["true", true],
    ["false", false],
    ["1", false],
  ])("reads isHideZero=%s as %s", async (raw, expected) => {
    const { app, listReports } = setup();

    await app.request(`/day-reports?isHideZero=${raw}`);

    expect(listReports).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ isHideZero: expected }) }),
    );
  });

  // AN ABSENT AREA IS EVERY AREA, not area NaN. The browser always sends one (the
  // header picker falls back to the first area), so this arm is reached by a
  // hand-edited URL or an API client — and it must get a page.
  it("accepts a request with no area at all", async () => {
    const { app, listReports } = setup();

    const res = await app.request("/day-reports");

    expect(res.status).toBe(200);
    expect(listReports).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ areaId: undefined }) }),
    );
  });

  it.each([
    ["a non-numeric area", "/day-reports?areaId=abc"],
    ["a zero area", "/day-reports?areaId=0"],
    ["a month out of range", "/day-reports?month=13"],
    ["a size over the cap", "/day-reports?size=500"],
    ["a zero page", "/day-reports?page=0"],
  ])("rejects %s with a 400 and never reaches the service", async (_label, url) => {
    const { app, listReports } = setup();

    expect((await app.request(url)).status).toBe(400);
    expect(listReports).not.toHaveBeenCalled();
  });

  // NO SHIFT AND NO LINE FILTER AT THIS GRAIN. Both are accepted-and-ignored
  // hazards rather than 400s — `paginationSchema` is not strict, so an unknown key
  // simply does not reach the filter. What must NOT happen is one of them
  // arriving in the filter object, which would mean the schema had grown a field
  // the repository has no predicate for.
  it.each(["shift=2", "workCenterId=3", "status=closed"])(
    "does not carry %s into the filter",
    async (param) => {
      const { app, listReports } = setup();

      await app.request(`/day-reports?${param}`);

      const filter = listReports.mock.calls[0]![0]!.filter as Record<string, unknown>;
      expect(Object.keys(filter).sort()).toEqual(["areaId", "isHideZero", "month", "year"]);
    },
  );

  it("sits behind auth", async () => {
    const { app, listReports } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request("/day-reports")).status).toBe(401);
    expect(listReports).not.toHaveBeenCalled();
  });
});

// SIX ROUTES TIMES TWO GRAINS, and two things are asserted at every one of the
// twelve.
//
// THE ID GUARD RUNS BEFORE THE SERVICE. A non-numeric id is a broken link, not a
// server fault, and must never reach a repository as NaN — which would match no
// rows and become a 404, the wrong answer to a malformed request.
//
// AND THE GRAIN IS FORWARDED. The two area tables have INDEPENDENT identity
// sequences, so a month request that reached the service with `grain: "day"`
// returns a real report about a real DAY, populated, under a month heading. A test
// asserting a 200 passes either way, so assert WHICH grain went through.
describe("createAreaReportHandler — the id-addressed routes", () => {
  const ROUTES = [
    ["", "getReport"],
    ["/products", "getProductCounts"],
    ["/production-units", "getProductionUnits"],
    ["/rejects", "getRejectReasons"],
    ["/downtime-events", "getDowntimeEventReasons"],
    ["/activity", "getActivity"],
  ] as const;

  const CASES = (["day", "month"] as const).flatMap((grain) =>
    ROUTES.map(([suffix, method]) => [grain, suffix, method] as const),
  );

  it.each(CASES)(
    "serves /%s-reports/:id%s and forwards the grain",
    async (grain, suffix, method) => {
      const handles = setup();

      const res = await handles.app.request(`/${grain}-reports/11${suffix}`);

      expect(res.status).toBe(200);
      expect(handles[method]).toHaveBeenCalledWith(grain, 11);
    },
  );

  it.each(CASES)("rejects a non-numeric id on /%s-reports/:id%s", async (grain, suffix, method) => {
    const handles = setup();

    expect((await handles.app.request(`/${grain}-reports/abc${suffix}`)).status).toBe(400);
    expect(handles[method]).not.toHaveBeenCalled();
  });

  it.each(CASES)("puts /%s-reports/:id%s behind auth", async (grain, suffix, method) => {
    const handles = setup(rejectingAuth as AuthMiddleware);

    expect((await handles.app.request(`/${grain}-reports/11${suffix}`)).status).toBe(401);
    expect(handles[method]).not.toHaveBeenCalled();
  });
});

// WHAT MUST STAY ABSENT.
//
// Asserted rather than commented because a grain loop or a copied handler would be
// the cheapest way to register all of these by accident — and three of them would
// then answer 200 for a report that cannot have them.
describe("createAreaReportHandler — the absences", () => {
  it.each([
    // No approval at this grain: oee.work_unit_shift_report_approvals is keyed
    // (work_unit_id, date, shift), and an area report is not approvable at all.
    "approval",
    // No hourly chart, and no area hourly table to build one from. An area-summed
    // curve off the LINE table would be the roll-up contract §19.1 refuses.
    "performance",
    "hour-profile",
    // An area report asks the operator for nothing — the requirement says "no add
    // reject/rework", and an entry is keyed by LINE.
    "quality-entries",
    // The SKU grain's provenance picker. Nothing on this screen needs one.
    "machines",
    // TODOS.md §50 / §60. The activity feed ships and the banner does not.
    "metrics-staleness",
  ])("does not serve /day-reports/:id/%s", async (path) => {
    const { app } = setup();

    expect((await app.request(`/day-reports/11/${path}`)).status).toBe(404);
  });

  // THE SAME ABSENCES AT MONTH GRAIN. Asserted separately rather than folded into
  // the list above, because a grain loop is exactly what could register one of them
  // at only one grain — and a `/month-reports/:id/approval` that answered 200 while
  // its day sibling 404'd would be the strangest bug in this feature.
  it.each(["approval", "performance", "hour-profile", "quality-entries", "machines"])(
    "does not serve /month-reports/:id/%s",
    async (path) => {
      const { app } = setup();

      expect((await app.request(`/month-reports/11/${path}`)).status).toBe(404);
    },
  );

  // NO SHIFT PREFIX, AND THE LOOP MAKES THAT STRUCTURAL. `AreaGrain` is
  // `"day" | "month"`, so the loop cannot produce a third prefix and `grainFrom`
  // would not compile for one. The requirement is explicit — "only have 2 type of
  // report on the Area" — and there is no oee.area_shift_reports to serve.
  it("serves no shift-reports prefix at all", async () => {
    const { app } = setup();

    expect((await app.request("/shift-reports/11")).status).toBe(404);
  });

  // NO WRITE OF ANY KIND. The module registers a reader and no writer, and 0024's
  // write_audit triggers assert the same thing from the database's side; this is
  // the HTTP surface saying it too.
  it.each([
    "/day-reports/11/approve",
    "/day-reports/11/reopen",
    "/day-reports/11",
    "/month-reports/11/approve",
    "/month-reports/11/reopen",
    "/month-reports/11",
  ])("answers no POST to %s", async (path) => {
    const { app } = setup();

    expect((await app.request(path, { method: "POST" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// THE MONTH LIST'S OWN FILTER CONTRACT
// ---------------------------------------------------------------------------
//
// The one place the two grains genuinely diverge, which is why the two list routes
// sit outside the handler's loop. The requirement is
// "Monthly Report (Show all month on selected year)": year, area and hide-zero,
// and NO month — a month filter would contradict the screen's own heading, and a
// month list narrowed to one month is one row.
//
// THIS IS STRICTER THAN THE SIX SHIPPED BY-MONTHLY SCREENS, which share one
// validator with their day siblings and do take a month. The divergence is asked
// for; these tests are what stop it being "tidied up" into the shared shape.
describe("createAreaReportHandler — /month-reports", () => {
  it("forwards year, area and hide-zero, and a month of undefined", async () => {
    const { app, listReports } = setup();

    const res = await app.request("/month-reports?page=1&size=10&year=2026&areaId=2");

    expect(res.status).toBe(200);
    expect(listReports).toHaveBeenCalledWith({
      grain: "month",
      limit: 10,
      offset: 0,
      // `month: undefined` EXPLICITLY, not absent: the shared AreaReportFilter has
      // the field, and this is the seam saying nothing can arrive in it.
      filter: { month: undefined, year: 2026, areaId: 2, isHideZero: false },
    });
  });

  // A MONTH PARAM IS NOT A 400 — `paginationSchema` is not strict, so an unknown
  // key is simply not in the validated object. What must NOT happen is it reaching
  // the filter, which would make the month list answer a narrower question than its
  // heading claims.
  it("never carries a month into the filter even when one is sent", async () => {
    const { app, listReports } = setup();

    await app.request("/month-reports?year=2026&month=9");

    expect(listReports).toHaveBeenCalledWith(
      expect.objectContaining({
        grain: "month",
        filter: expect.objectContaining({ month: undefined, year: 2026 }),
      }),
    );
  });

  it.each(["shift=2", "workCenterId=3", "status=closed"])(
    "does not carry %s into the filter either",
    async (param) => {
      const { app, listReports } = setup();

      await app.request(`/month-reports?${param}`);

      const filter = listReports.mock.calls[0]![0]!.filter as Record<string, unknown>;
      expect(Object.keys(filter).sort()).toEqual(["areaId", "isHideZero", "month", "year"]);
    },
  );

  it.each([
    ["a non-numeric area", "/month-reports?areaId=abc"],
    ["a size over the cap", "/month-reports?size=500"],
    ["a zero page", "/month-reports?page=0"],
    ["a year out of range", "/month-reports?year=12"],
  ])("rejects %s with a 400 and never reaches the service", async (_label, url) => {
    const { app, listReports } = setup();

    expect((await app.request(url)).status).toBe(400);
    expect(listReports).not.toHaveBeenCalled();
  });

  it("sits behind auth", async () => {
    const { app, listReports } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request("/month-reports")).status).toBe(401);
    expect(listReports).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE YEAR GRAIN — the dashboard's, and NOT a third report grain
// ─────────────────────────────────────────────────────────────────────────────
//
// The requirement is explicit that an area "only have 2 type of report", and
// nothing here weakens it: `AreaGrain` is still two members and `/shift-reports`
// is still unregisterable. These four routes belong to the OEE Performance
// dashboard, a second surface over the same tables (contract §23.2), and they
// reach `0027`'s table through a separate `AreaCoarseGrain`.
describe("createAreaReportHandler — /year-reports", () => {
  it("answers the trend with the YEAR fetcher, never the month one", async () => {
    const { app, getYearOeeTrend, getMonthOeeTrend } = setup();

    const res = await app.request("/year-reports/9/oee-trend");

    expect(res.status).toBe(200);
    expect(getYearOeeTrend).toHaveBeenCalledWith(9);
    // Both endpoints return an IDENTICAL envelope — `shared/oee-trend.ts` is one
    // statement parameterised by a table pair — so a wrong pick answers 200 with a
    // plausible curve about another period. Asserting the shape would pass either way.
    expect(getMonthOeeTrend).not.toHaveBeenCalled();
  });

  it("reads the YEAR table for the detail and the rejects", async () => {
    const { app, getReport, getRejectReasons } = setup();

    expect((await app.request("/year-reports/9")).status).toBe(200);
    expect(getReport).toHaveBeenCalledWith("year", 9);

    expect((await app.request("/year-reports/9/rejects")).status).toBe(200);
    expect(getRejectReasons).toHaveBeenCalledWith("year", 9);
  });

  it("lists at year grain and accepts no month", async () => {
    const { app, listReports } = setup();

    const res = await app.request("/year-reports?year=2026&month=3");

    expect(res.status).toBe(200);
    expect(listReports).toHaveBeenCalledWith(
      expect.objectContaining({
        grain: "year",
        // The validator never declares `month`, so the filter carries undefined —
        // stated explicitly at the seam rather than omitted, exactly as the month
        // list does, so `AreaReportFilter` stays ONE type.
        filter: expect.objectContaining({ month: undefined, year: 2026 }),
      }),
    );
  });

  // THE ABSENCES. An area report takes no operator mutation at ANY grain, and the
  // four report sub-resources it does have are report screens' cards — there is no
  // year report screen to render them.
  it.each([
    "/year-reports/9/products",
    "/year-reports/9/production-units",
    "/year-reports/9/downtime-events",
    "/year-reports/9/activity",
  ])("does not register %s", async (path) => {
    const { app } = setup();

    expect((await app.request(path)).status).toBe(404);
  });
});
