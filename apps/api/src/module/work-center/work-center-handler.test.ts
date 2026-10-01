import { describe, expect, it, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";

import { createWorkCenterHandler } from "./work-center-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { TWorkCenterReportService } from "./work-center-service.js";

const meta = { page: 1, size: 10, totalElements: 0, totalPages: 0, first: true, last: true };

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so query parsing and the envelope can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

const SUMMARY = { machinesFound: 3, machinesClosed: 2, workUnitCount: 3 };

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  const getPagedReport = vi.fn().mockResolvedValue({ items: [], meta });
  const getReport = vi.fn().mockResolvedValue({ id: 1, grain: "shift" });
  const getApprovalSummary = vi.fn().mockResolvedValue(SUMMARY);
  const approveLineShift = vi.fn().mockResolvedValue(SUMMARY);
  const reopenLineShift = vi.fn().mockResolvedValue(SUMMARY);
  const getActivity = vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", entries: [], sources: [] });
  const getMetricsStaleness = vi.fn().mockResolvedValue({ categoryEditedAt: null });
  const getProductCounts = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });
  const getMachines = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    from: new Date(0),
    to: new Date(0),
    machines: [],
  });
  const getRejectReasons = vi.fn().mockResolvedValue({ buckets: [], totalFrequency: 0 });
  const getDowntimeEventReasons = vi.fn().mockResolvedValue({ buckets: [], totalEvents: 0 });
  const getMonthOeeTrend = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });
  const getYearOeeTrend = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });

  const service = {
    getPagedReport,
    getReport,
    getMonthOeeTrend,
    getYearOeeTrend,
    getApprovalSummary,
    approveLineShift,
    reopenLineShift,
    getActivity,
    getMetricsStaleness,
    getProductCounts,
    getMachines,
    getRejectReasons,
    getDowntimeEventReasons,
  } as unknown as TWorkCenterReportService;
  const app = createWorkCenterHandler({ workCenterReportService: service, authMw });
  return {
    app,
    getPagedReport,
    getReport,
    getApprovalSummary,
    approveLineShift,
    reopenLineShift,
    getActivity,
    getMetricsStaleness,
    getProductCounts,
    getMachines,
    getRejectReasons,
    getDowntimeEventReasons,
    getMonthOeeTrend,
    getYearOeeTrend,
  };
}

const PATHS = [
  ["shift", "/shift-reports"],
  ["day", "/day-reports"],
  ["month", "/month-reports"],
] as const;

describe("work-center handler — the grain each route serves", () => {
  // ASSERT WHICH GRAIN THE SPY RECEIVED, not that rows rendered. The three tables
  // have independent identity sequences, so a route wired to the wrong grain
  // answers with a full page of plausible rows for another table — and every
  // assertion about the envelope passes either way.
  it.each(PATHS)("%s grain is served from %s", async (grain, path) => {
    const { app, getPagedReport } = setup();

    const res = await app.request(`${path}?page=1&size=10`);

    expect(res.status).toBe(200);
    expect(getPagedReport.mock.calls[0]?.[0]).toBe(grain);
  });

  it.each(PATHS)("%s returns the WebResponse envelope with paging meta", async (_grain, path) => {
    const { app } = setup();

    const body = (await (await app.request(path)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ data: [], meta, error: null });
  });

  it.each(PATHS)("%s is behind auth", async (_grain, path) => {
    const { app } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request(path)).status).toBe(401);
  });
});

describe("work-center handler — the shift filter", () => {
  it("forwards shift at shift grain", async () => {
    const { app, getPagedReport } = setup();

    await app.request("/shift-reports?shift=2");

    // A NUMBER, not "2": `shift` is a smallint column, and binding a string would
    // make Postgres parse it.
    expect(getPagedReport.mock.calls[0]?.[3]).toMatchObject({ shift: 2 });
  });

  // MATCHES THE SHIPPED BEHAVIOUR OF /work-units/{day,month}-reports rather than
  // diverging from it. paginationSchema is a plain z.object, so .extend() keeps it
  // non-strict and an unknown key is DROPPED, not rejected. Whether both modules
  // should go .strict() is a separate question; two modules answering the same URL
  // two different ways is not.
  it.each([
    ["day", "/day-reports"],
    ["month", "/month-reports"],
  ] as const)("ignores shift at %s grain rather than filtering on it", async (_grain, path) => {
    const { app, getPagedReport } = setup();

    const res = await app.request(`${path}?shift=2`);

    expect(res.status).toBe(200);
    expect(getPagedReport.mock.calls[0]?.[3].shift).toBeUndefined();
  });

  // The screens clear a filter by dropping the value, but a bookmarked URL keeps
  // the key. `?shift=` must mean "all shifts", not 400 — and Number("") is 0, so
  // this only works because the empty-string arm sits ahead of the numeric check.
  it("reads ?shift= as all shifts rather than answering 400", async () => {
    const { app, getPagedReport } = setup();

    const res = await app.request("/shift-reports?shift=");

    expect(res.status).toBe(200);
    expect(getPagedReport.mock.calls[0]?.[3].shift).toBeUndefined();
  });

  // A 400, never a 500: `invalid input syntax for type smallint` is what reaches
  // the client if a string is bound straight to the column.
  it.each(["abc", "0", "4", "1.5"])("rejects ?shift=%s with 400", async (shift) => {
    const { app } = setup();

    expect((await app.request(`/shift-reports?shift=${shift}`)).status).toBe(400);
  });
});

describe("work-center handler — what these routes do not accept", () => {
  // There is no line status COLUMN to filter on: the approvals table is keyed
  // (work_unit_id, date, shift) and these tables have no work_unit_id at all, so a
  // line's status can only be derived per report. The detail screen does that; a
  // list filter would need a set-based version first.
  it.each(PATHS)("%s ignores status", async (_grain, path) => {
    const { app, getPagedReport } = setup();

    const res = await app.request(`${path}?status=closed`);

    expect(res.status).toBe(200);
    expect(getPagedReport.mock.calls[0]?.[3]).not.toHaveProperty("status");
  });

  // NO BARE /:id, still. Under this prefix a bare id reads as the master-data
  // catalogue's "the work center", not "the report" — which is why the detail
  // route below is /{grain}-reports/:id and this one stays unrouted.
  it.each(["/1", "/shift-reports"])("does not route GET %s as a detail", async (path) => {
    const { app, getReport } = setup();

    await app.request(path, { method: "GET" });

    expect(getReport).not.toHaveBeenCalled();
  });
});

describe("work-center handler — the detail route", () => {
  // WHICH GRAIN AND WHICH ID THE SPY RECEIVED. The six report tables have six
  // independent identity sequences, so a route wired to the wrong grain answers
  // 200 with a complete, plausible report for an unrelated line on an unrelated
  // date. Asserting the envelope cannot see that; asserting the call can.
  it.each(PATHS)("%s detail reads the %s table", async (grain, path) => {
    const { app, getReport } = setup();

    const res = await app.request(`${path}/7`);

    expect(res.status).toBe(200);
    expect(getReport.mock.calls[0]).toEqual([grain, 7]);
  });

  it.each(PATHS)("%s detail returns the WebResponse envelope", async (_grain, path) => {
    const { app } = setup();

    const body = (await (await app.request(`${path}/7`)).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ data: { id: 1 }, error: null });
  });

  // 400 AND NOT 404, and never a call. `Number("abc")` is NaN, which binds
  // happily and matches no rows — turning a malformed request into "this report
  // does not exist", which sends the reader looking for a report rather than at
  // their link.
  it.each(["abc", "0", "-1", "1.5"])(
    "rejects the id %s before touching the service",
    async (id) => {
      const { app, getReport } = setup();

      const res = await app.request(`/shift-reports/${id}`);

      expect(res.status).toBe(400);
      expect(getReport).not.toHaveBeenCalled();
    },
  );

  it("is behind auth", async () => {
    const { app } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request("/shift-reports/7")).status).toBe(401);
  });
});

describe("work-center handler — the shared filters", () => {
  it("forwards month, year, workCenterId and areaId as numbers", async () => {
    const { app, getPagedReport } = setup();

    await app.request("/day-reports?month=8&year=2026&workCenterId=11&areaId=4");

    expect(getPagedReport.mock.calls[0]?.[3]).toMatchObject({
      month: 8,
      year: 2026,
      workCenterId: 11,
      // The header area picker, which the browser sends on every report request.
      areaId: 4,
    });
  });

  // `?areaId=` means "every area", not 400 — the empty-string arm shiftFilter
  // documents, on the one filter every report URL now carries.
  it.each([
    ["", undefined],
    ["areaId=", undefined],
    ["areaId=4", 4],
  ])("maps %s to areaId %s", async (query, expected) => {
    const { app, getPagedReport } = setup();

    await app.request(`/day-reports?${query}`);

    expect(getPagedReport.mock.calls[0]?.[3].areaId).toBe(expected);
  });

  it("treats only the literal true as hide-zero", async () => {
    for (const [query, expected] of [
      ["isHideZero=true", true],
      ["isHideZero=false", false],
      ["", false],
    ] as const) {
      const { app, getPagedReport } = setup();
      await app.request(`/day-reports?${query}`);
      expect(getPagedReport.mock.calls[0]?.[3].isHideZero).toBe(expected);
    }
  });

  it("defaults paging to page 1 size 10 and caps the size", async () => {
    const { app, getPagedReport } = setup();
    await app.request("/day-reports");
    expect(getPagedReport.mock.calls[0]?.slice(1, 3)).toEqual([1, 10]);

    const over = setup();
    expect((await over.app.request("/day-reports?size=101")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The line approval routes
// ---------------------------------------------------------------------------
//
// SHIFT GRAIN ONLY, and the two absences are asserted rather than described. A
// day or month line report has nothing to sign: the approvals table is keyed
// (work_unit_id, date, shift), so a line DAY approval would cascade over three
// shifts as well as N machines — the question TODOS §48 holds. Routing it here by
// accident would answer that question in passing and give the app two definitions
// of "approved".
describe("work-center handler — the line approval", () => {
  it("passes the report id and the actor to approve", async () => {
    const { app, approveLineShift } = setup();

    const res = await app.request("/shift-reports/7/approve", { method: "POST" });

    expect(res.status).toBe(200);
    expect(approveLineShift.mock.calls[0]?.[0]).toBe(7);
    // requireActor reads the VERIFIED token, and `sub` is what lands in closed_by
    // — on an audit trail, where a wrong answer is worse than none.
    expect(approveLineShift.mock.calls[0]?.[1]).toMatchObject({ subject: "u1" });
  });

  it("passes the report id and the actor to reopen", async () => {
    const { app, reopenLineShift } = setup();

    const res = await app.request("/shift-reports/7/reopen", { method: "POST" });

    expect(res.status).toBe(200);
    expect(reopenLineShift.mock.calls[0]?.[0]).toBe(7);
  });

  // 200 WITH THE SUMMARY, not 204. The browser flips the Status tile from this
  // payload rather than from a refetch — contract §8's read-after-write rule.
  it.each(["approve", "reopen"])("%s answers with the summary in the envelope", async (action) => {
    const { app } = setup();

    const body = (await (
      await app.request(`/shift-reports/7/${action}`, { method: "POST" })
    ).json()) as Record<string, unknown>;

    expect(body).toMatchObject({ data: SUMMARY, error: null });
  });

  it("serves the approval summary as its own GET", async () => {
    const { app, getApprovalSummary } = setup();

    const res = await app.request("/shift-reports/7/approval");

    expect(res.status).toBe(200);
    expect(getApprovalSummary).toHaveBeenCalledWith(7);
  });

  // THE COARSE GRAINS HAVE NO APPROVAL, at all — no write and no summary.
  it.each([
    "/day-reports/7/approve",
    "/month-reports/7/approve",
    "/day-reports/7/reopen",
    "/month-reports/7/reopen",
  ])("does not route %s", async (path) => {
    const { app, approveLineShift, reopenLineShift } = setup();

    expect((await app.request(path, { method: "POST" })).status).toBe(404);
    expect(approveLineShift).not.toHaveBeenCalled();
    expect(reopenLineShift).not.toHaveBeenCalled();
  });

  it.each(["/day-reports/7/approval", "/month-reports/7/approval"])(
    "does not serve %s",
    async (path) => {
      const { app, getApprovalSummary } = setup();

      expect((await app.request(path)).status).toBe(404);
      expect(getApprovalSummary).not.toHaveBeenCalled();
    },
  );

  // A WRITE IS A POST. Routing it on GET would make an approval reachable from a
  // link, a prefetch or a crawler.
  it.each(["approve", "reopen"])("does not accept %s over GET", async (action) => {
    const { app } = setup();

    expect((await app.request(`/shift-reports/7/${action}`)).status).toBe(404);
  });

  it.each(["abc", "0", "-1"])("rejects the id %s on a write before the service", async (id) => {
    const { app, approveLineShift } = setup();

    const res = await app.request(`/shift-reports/${id}/approve`, { method: "POST" });

    expect(res.status).toBe(400);
    expect(approveLineShift).not.toHaveBeenCalled();
  });

  it.each(["/shift-reports/7/approve", "/shift-reports/7/reopen"])(
    "%s is behind auth",
    async (path) => {
      const { app } = setup(rejectingAuth as AuthMiddleware);

      expect((await app.request(path, { method: "POST" })).status).toBe(401);
    },
  );
});

// THE TWO SUB-RESOURCES BEHIND THE "…" MENU AND THE BANNER, and they no longer
// agree about which grains exist — which is the whole point of this block.
//
//   /activity            ALL THREE GRAINS (TODOS §60). Reading what happened over
//                        a window grants no authority, and the arms widen: the
//                        downtime one was always an instant window that never read
//                        a shift, and only the approval join narrowed by one.
//   /metrics-staleness   SHIFT ONLY still. Nothing coarser has been built; §60's
//                        other half holds it.
//
// The pair is asserted together because the tempting change is to make them
// "consistent" in either direction, and both directions are wrong: widening the
// banner ships an unbuilt read, and narrowing the feed removes the feature this
// block exists to pin. The grain is in the URL for exactly that reason.
describe("work-center handler — the feed and the banner, per grain", () => {
  it.each(["/shift-reports/7/activity", "/day-reports/7/activity", "/month-reports/7/activity"])(
    "serves %s",
    async (url) => {
      const { app } = setup();

      expect((await app.request(url)).status).toBe(200);
    },
  );

  // WHICH GRAIN REACHED THE SERVICE, not merely that it answered 200. The three
  // work_center_* tables have independent identity sequences, so a route passing
  // the wrong grain resolves id 7 against another period's row and renders a
  // populated, plausible panel about the wrong window.
  it.each([
    ["shift", "/shift-reports/7/activity"],
    ["day", "/day-reports/7/activity"],
    ["month", "/month-reports/7/activity"],
  ])("passes the %s grain through to the service", async (grain, url) => {
    const { app, getActivity } = setup();

    await app.request(url);

    expect(getActivity).toHaveBeenCalledWith(grain, 7);
  });

  it("serves metrics-staleness for a line shift", async () => {
    const { app } = setup();

    expect((await app.request("/shift-reports/7/metrics-staleness")).status).toBe(200);
  });

  it.each(["/day-reports/7/metrics-staleness", "/month-reports/7/metrics-staleness"])(
    "does not route %s",
    async (url) => {
      const { app, getMetricsStaleness } = setup();

      expect((await app.request(url)).status).toBe(404);
      expect(getMetricsStaleness).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["activity", "/shift-reports/abc/activity"],
    ["activity at day grain", "/day-reports/0/activity"],
    ["metrics-staleness", "/shift-reports/0/metrics-staleness"],
  ])("rejects a bad id on %s before the service", async (_label, url) => {
    const { app, getActivity, getMetricsStaleness } = setup();

    expect((await app.request(url)).status).toBe(400);
    expect(getActivity).not.toHaveBeenCalled();
    expect(getMetricsStaleness).not.toHaveBeenCalled();
  });

  it.each([
    "/shift-reports/7/activity",
    "/day-reports/7/activity",
    "/month-reports/7/activity",
    "/shift-reports/7/metrics-staleness",
  ])("%s is behind auth", async (url) => {
    const { app } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request(url)).status).toBe(401);
  });
});

// Part 2's four sub-resources. All three grains, all `:id`-addressed, all inside
// the same loop the list and the detail are registered from.
describe("work-center handler — Part 2's sub-resources", () => {
  const ROUTES = [
    ["products", "getProductCounts"],
    ["machines", "getMachines"],
    ["rejects", "getRejectReasons"],
    ["downtime-events", "getDowntimeEventReasons"],
  ] as const;

  // WHICH GRAIN THE SPY RECEIVED, for every one of the twelve routes. Six report
  // tables have six independent identity sequences, so a route wired to the wrong
  // grain answers 200 with a complete, plausible payload about an unrelated line on
  // an unrelated date — and for the SKU card in particular the usual answer is an
  // empty list, so the wrong grain would not even look different.
  it.each(
    ROUTES.flatMap(([segment, spy]) =>
      (["shift", "day", "month"] as const).map(
        (grain) => [grain, segment, spy] as [typeof grain, typeof segment, typeof spy],
      ),
    ),
  )("%s/%s reads its own grain", async (grain, segment, spy) => {
    const setupResult = setup();
    const fn = setupResult[spy];

    const res = await setupResult.app.request(`/${grain}-reports/7/${segment}`);

    expect(res.status).toBe(200);
    expect(fn.mock.calls[0]).toEqual([grain, 7]);
  });

  it.each(ROUTES.map(([segment]) => segment))("%s returns the envelope", async (segment) => {
    const { app } = setup();

    const body = (await (await app.request(`/shift-reports/7/${segment}`)).json()) as Record<
      string,
      unknown
    >;

    expect(body).toMatchObject({ error: null });
    expect(body.data).toBeTruthy();
    // Unpaged, all four — the rule /activity already states. A grand total on a
    // Pareto's payload is a denominator, not a page count.
    expect(body).not.toHaveProperty("meta.totalPages");
  });

  it.each(ROUTES.map(([segment]) => segment))(
    "%s rejects a bad id before the service",
    async (segment) => {
      const setupResult = setup();

      const res = await setupResult.app.request(`/shift-reports/abc/${segment}`);

      expect(res.status).toBe(400);
      expect(setupResult.getProductCounts).not.toHaveBeenCalled();
      expect(setupResult.getMachines).not.toHaveBeenCalled();
      expect(setupResult.getRejectReasons).not.toHaveBeenCalled();
      expect(setupResult.getDowntimeEventReasons).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES.map(([segment]) => segment))("%s is behind auth", async (segment) => {
    const { app } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request(`/shift-reports/7/${segment}`)).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE YEAR GRAIN — four routes, OUTSIDE the three-grain loop
// ─────────────────────────────────────────────────────────────────────────────
//
// That loop mounts eight sub-resources per grain because all three of its tables
// differ by exactly one column and share every one of them. `0027`'s table shares
// four, and these tests are what keep the other four unmounted.
describe("createWorkCenterHandler — /year-reports", () => {
  it("answers the trend with the YEAR fetcher, never the month one", async () => {
    const { app, getYearOeeTrend, getMonthOeeTrend } = setup();

    const res = await app.request("/year-reports/9/oee-trend");

    expect(res.status).toBe(200);
    expect(getYearOeeTrend).toHaveBeenCalledWith(9);
    // Both return an IDENTICAL envelope, so a wrong pick draws a plausible curve
    // about another period and answers 200 doing it.
    expect(getMonthOeeTrend).not.toHaveBeenCalled();
  });

  it("reads the YEAR table for the detail and the rejects", async () => {
    const { app, getReport, getRejectReasons } = setup();

    expect((await app.request("/year-reports/9")).status).toBe(200);
    expect(getReport).toHaveBeenCalledWith("year", 9);

    expect((await app.request("/year-reports/9/rejects")).status).toBe(200);
    expect(getRejectReasons).toHaveBeenCalledWith("year", 9);
  });

  it("lists at year grain and accepts neither month nor shift", async () => {
    const { app, getPagedReport } = setup();

    const res = await app.request("/year-reports?year=2026&month=3&shift=2");

    expect(res.status).toBe(200);
    expect(getPagedReport).toHaveBeenCalledWith(
      "year",
      1,
      10,
      expect.not.objectContaining({ month: 3, shift: "2" }),
    );
  });

  it.each([
    "/year-reports/9/products",
    "/year-reports/9/machines",
    "/year-reports/9/downtime-events",
    "/year-reports/9/activity",
    "/year-reports/9/performance",
    "/year-reports/9/hour-profile",
    "/year-reports/9/quality-entries",
    "/year-reports/9/approval",
    "/year-reports/9/metrics-staleness",
  ])("does not register %s", async (path) => {
    const { app } = setup();

    expect((await app.request(path)).status).toBe(404);
  });

  // THE SHARPEST ABSENCE. A line's approve is ALREADY a cascade — one click closes
  // every machine shift report on the line. At year grain it would close roughly
  // 1,095 shifts times N machines, which is not what `APPROVE_LINE_ROLE` grants and
  // has no role variable of its own because nobody has decided there should be one.
  it.each(["/year-reports/9/approve", "/year-reports/9/reopen"])(
    "does not register %s",
    async (path) => {
      const { app } = setup();

      expect((await app.request(path, { method: "POST" })).status).toBe(404);
    },
  );
});
