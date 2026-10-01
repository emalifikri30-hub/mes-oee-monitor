import { describe, it, expect, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { createWorkUnitHandler } from "./work-unit-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { TWorkUnitReportService } from "./work-unit-service.js";

const meta = { page: 1, size: 10, totalElements: 0, totalPages: 0, first: true, last: true };

// Only the fields the routes below actually assert on. `approval` is the derived
// shift count, and it is null at month grain — the one shape difference between
// the two prefixes.
const PERIOD_REPORT = {
  id: 1,
  grain: "day",
  businessDate: "2026-08-01",
  timeZone: "Asia/Jakarta",
  month: null,
  approval: { shiftsTotal: 3, shiftsClosed: 2 },
};

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so query parsing and the envelope can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

// A token that VERIFIED but carries no `sub`. Distinct from rejectingAuth: the
// middleware let it through, and it is the handler's own guard that must stop
// it — because `sub` is the value that lands in a NOT NULL column.
const subjectlessAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", {});
  await next();
});

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  const getPagedShiftReport = vi.fn().mockResolvedValue({ items: [], meta });
  const getShiftReport = vi.fn().mockResolvedValue({ id: 7, shift: 2 });
  const getProductCounts = vi.fn().mockResolvedValue([]);
  const getPerformance = vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", buckets: [], loadedThrough: null });
  const getRejectReasons = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    buckets: [],
    totalFrequency: 0,
    totalDurationMs: 0,
    totalQuantity: 0,
    totalWeightGram: null,
    convertedUnit: null,
    loadedThrough: null,
  });

  // A realistic default rather than an empty object: the totals are the fields the
  // route comment warns about, so a stub that omitted them would let a transposition
  // pass. `totalEvents` is deliberately SMALLER than `totalOccurrences`, which is the
  // only relation the response is allowed to have.
  const getDowntimeEventReasons = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    buckets: [],
    totalOccurrences: 0,
    totalEvents: 0,
    loadedThrough: null,
  });

  // A realistic default: THREE sources, two of them untracked. A stub returning
  // `{ entries: [] }` alone would let a handler that dropped `sources` pass, and
  // `sources` is the whole point of this payload.
  const getActivity = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    entries: [],
    sources: [
      {
        kind: "approval",
        tracked: true,
        untrackedReason: null,
        totalMembers: 1,
        trackedMembers: 1,
      },
      {
        kind: "downtime",
        tracked: false,
        untrackedReason: "no-stable-id",
        totalMembers: 3,
        trackedMembers: 0,
      },
      {
        kind: "quality",
        tracked: false,
        untrackedReason: "no-source",
        totalMembers: 0,
        trackedMembers: 0,
      },
    ],
  });

  const approveShiftReport = vi.fn().mockResolvedValue({
    status: "closed",
    closedAt: new Date("2026-08-09T09:00:00.000Z"),
    closedBy: "u1",
    closedByName: "dewi",
    source: "operator",
  });

  const reopenShiftReport = vi.fn().mockResolvedValue({
    status: "open",
    closedAt: null,
    closedBy: null,
    closedByName: null,
    source: null,
  });

  // Null is what every report reports today — nothing writes
  // oee.downtime_report_history yet.
  const getPeriodMetricsStaleness = vi.fn().mockResolvedValue({ categoryEditedAt: null });
  const getMetricsStaleness = vi.fn().mockResolvedValue({ categoryEditedAt: null });

  // The coarse grains. One pair of service methods serves both route prefixes,
  // so these mocks record the `grain` argument the route passed — which is the
  // only thing distinguishing /day-reports from /month-reports below.
  const getPagedPeriodReport = vi.fn().mockResolvedValue({ items: [], meta });
  const getPeriodReport = vi.fn().mockResolvedValue(PERIOD_REPORT);
  const getPeriodActivity = vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", entries: [], sources: [] });
  const getMonthHourProfile = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    dayStartHour: 7,
    buckets: [],
    loadedThrough: null,
  });
  const getPeriodRejectReasons = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    buckets: [],
    totalFrequency: 0,
    totalDurationMs: 0,
    totalQuantity: 0,
    totalWeightGram: null,
    convertedUnit: null,
    loadedThrough: null,
  });
  const getPeriodDowntimeEventReasons = vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    buckets: [],
    totalOccurrences: 0,
    totalEvents: 0,
    loadedThrough: null,
  });
  const getPeriodPerformance = vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", buckets: [], loadedThrough: null });
  const getPeriodProductCounts = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });
  const getMonthOeeTrend = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });
  const getYearOeeTrend = vi
    .fn()
    .mockResolvedValue({ items: [], timeZone: "Asia/Jakarta", loadedThrough: null });

  const app = createWorkUnitHandler({
    workUnitReportService: {
      getPagedPeriodReport,
      getPeriodReport,
      getPeriodProductCounts,
      getPeriodPerformance,
      getPeriodActivity,
      getMonthHourProfile,
      getMonthOeeTrend,
      getYearOeeTrend,
      getPeriodRejectReasons,
      getPeriodDowntimeEventReasons,
      getPagedShiftReport,
      getShiftReport,
      getProductCounts,
      getPerformance,
      getRejectReasons,
      getDowntimeEventReasons,
      getActivity,
      approveShiftReport,
      reopenShiftReport,
      getMetricsStaleness,
      getPeriodMetricsStaleness,
    } satisfies Record<keyof TWorkUnitReportService, ReturnType<typeof vi.fn>>,
    authMw,
  });

  // The handler throws HTTPException directly; the real app.onError maps it.
  // Reproduced here so status assertions reflect what a client actually sees.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: "internal" }, 500);
  });

  return {
    app,
    getPagedPeriodReport,
    getPeriodReport,
    getPeriodProductCounts,
    getPeriodPerformance,
    getPeriodActivity,
    getMonthHourProfile,
    getMonthOeeTrend,
    getYearOeeTrend,
    getPeriodRejectReasons,
    getPeriodDowntimeEventReasons,
    approveShiftReport,
    reopenShiftReport,
    getMetricsStaleness,
    getPeriodMetricsStaleness,
    getActivity,
    getDowntimeEventReasons,
    getPagedShiftReport,
    getShiftReport,
    getProductCounts,
    getPerformance,
    getRejectReasons,
  };
}

function filterOf(fn: ReturnType<typeof vi.fn>) {
  return fn.mock.calls[0]?.[2];
}

describe("GET /shift-reports", () => {
  it("applies the shared pagination defaults", async () => {
    const { app, getPagedShiftReport } = setup();

    const res = await app.request("/shift-reports");

    expect(res.status).toBe(200);
    expect(getPagedShiftReport).toHaveBeenCalledWith(1, 10, expect.any(Object));
  });

  it("passes every filter through", async () => {
    const { app, getPagedShiftReport } = setup();

    await app.request(
      "/shift-reports?page=2&size=25&month=3&year=2026&shift=2&workCenterId=12&areaId=4",
    );

    expect(getPagedShiftReport).toHaveBeenCalledWith(2, 25, {
      month: 3,
      year: 2026,
      // A number, not "2": the column is smallint, and binding a string would
      // make Postgres parse it — turning `?shift=abc` into a 500.
      shift: 2,
      workCenterId: 12,
      // The header area picker, which the browser sends on EVERY report request.
      // It reaches the repository as itself rather than being resolved into a
      // machine id list the way `workCenterId` is — see WorkUnitPeriodReportFilter.
      areaId: 4,
      isHideZero: false,
    });
  });

  // An omitted areaId must reach the service as undefined — "every area" — and
  // never as NaN or 0. These endpoints are public; only the browser sends the
  // filter unconditionally.
  it.each([
    ["absent", "", undefined],
    ["empty", "&areaId=", undefined],
    ["given", "&areaId=4", 4],
  ])("maps a %s areaId to %s", async (_name, qs, expected) => {
    const { app, getPagedShiftReport } = setup();

    await app.request(`/shift-reports?page=1${qs}`);

    expect(filterOf(getPagedShiftReport)).toMatchObject({ areaId: expected });
  });

  // `?shift=` means "all shifts": the By Shift screen clears the filter by
  // dropping the value, and a hand-edited URL keeps the key. Number("") is 0, so
  // a naive coercion would answer that URL with a 400 — which is why the
  // empty-string arm sits ahead of the numeric check in the schema.
  it.each([
    ["1", 1],
    ["3", 3],
    ["", undefined],
  ])("maps shift=%s to %s", async (raw, expected) => {
    const { app, getPagedShiftReport } = setup();

    await app.request(`/shift-reports?shift=${raw}`);

    expect(filterOf(getPagedShiftReport)).toMatchObject({ shift: expected });
  });

  // Only the literal "true" hides rows — the repository checks `=== true`, so a
  // loose truthiness read here would silently drop data for `?isHideZero=0`.
  it.each([
    ["true", true],
    ["false", false],
    ["1", false],
    ["", false],
  ])("maps isHideZero=%s to %s", async (raw, expected) => {
    const { app, getPagedShiftReport } = setup();

    await app.request(`/shift-reports?isHideZero=${raw}`);

    expect(filterOf(getPagedShiftReport)).toMatchObject({ isHideZero: expected });
  });

  it("leaves absent filters undefined rather than coercing them", async () => {
    const { app, getPagedShiftReport } = setup();

    await app.request("/shift-reports");

    expect(filterOf(getPagedShiftReport)).toMatchObject({
      month: undefined,
      year: undefined,
      shift: undefined,
      workCenterId: undefined,
    });
  });

  it("returns the standard envelope", async () => {
    const { app } = setup();

    const res = await app.request("/shift-reports");
    const body = await res.json();

    expect(body.error).toBeNull();
    expect(body.data).toEqual([]);
    expect(body.meta).toEqual(meta);
  });

  it.each([
    ["a month above 12", "month=13"],
    ["a month below 1", "month=0"],
    ["a non-numeric month", "month=abc"],
    // Was a harmless empty result while `shift` was text; against a smallint
    // column an unvalidated string is `invalid input syntax` — a 500.
    ["a non-numeric shift", "shift=abc"],
    ["a shift above 3", "shift=4"],
    ["a shift below 1", "shift=0"],
    ["a fractional shift", "shift=1.5"],
    ["a size above the cap", "size=101"],
    ["a page below 1", "page=0"],
    ["a zero workCenterId", "workCenterId=0"],
    ["a negative workCenterId", "workCenterId=-3"],
  ])("400s on %s", async (_label, query) => {
    const { app, getPagedShiftReport } = setup();

    const res = await app.request(`/shift-reports?${query}`);

    expect(res.status).toBe(400);
    expect(getPagedShiftReport).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404 for an unknown work center", async () => {
    const { app, getPagedShiftReport } = setup();
    getPagedShiftReport.mockRejectedValue(
      new HTTPException(404, { message: "work center not found" }),
    );

    const res = await app.request("/shift-reports?workCenterId=999");

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("work center not found");
  });

  it("surfaces the service's 502 when master data is unavailable", async () => {
    const { app, getPagedShiftReport } = setup();
    getPagedShiftReport.mockRejectedValue(
      new HTTPException(502, { message: "master data unavailable" }),
    );

    const res = await app.request("/shift-reports?workCenterId=12");

    expect(res.status).toBe(502);
  });

  it("401s without a valid token", async () => {
    const { app, getPagedShiftReport } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports");

    expect(res.status).toBe(401);
    expect(getPagedShiftReport).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id", () => {
  it("returns the report", async () => {
    const { app, getShiftReport } = setup();

    const res = await app.request("/shift-reports/7");

    expect(res.status).toBe(200);
    expect(getShiftReport).toHaveBeenCalledWith(7);
    expect((await res.json()).data).toMatchObject({ id: 7 });
  });

  // A non-numeric param would otherwise reach the repository as NaN, which
  // matches no rows and reads as "not found" instead of "bad request".
  it.each([
    ["a non-numeric id", "abc"],
    ["a fractional id", "1.5"],
    ["a zero id", "0"],
    ["a negative id", "-1"],
  ])("400s on %s without calling the service", async (_label, id) => {
    const { app, getShiftReport } = setup();

    const res = await app.request(`/shift-reports/${id}`);

    expect(res.status).toBe(400);
    expect(getShiftReport).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404", async () => {
    const { app, getShiftReport } = setup();
    getShiftReport.mockRejectedValue(new HTTPException(404, { message: "report not found" }));

    const res = await app.request("/shift-reports/12345");

    expect(res.status).toBe(404);
  });

  it("401s without a valid token", async () => {
    const { app, getShiftReport } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/7");

    expect(res.status).toBe(401);
    expect(getShiftReport).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id/products", () => {
  const item = {
    productId: 4,
    productName: "SKU Line 4",
    productCode: "SKU-4",
    totalOut: 854_648,
    goodOut: 786_552,
    reject: 68_096,
    rework: 0,
    uomCode: "BAG",
    baseUomCode: "BAG",
  };

  it("returns the rows unpaged, with no meta", async () => {
    const { app, getProductCounts } = setup();
    getProductCounts.mockResolvedValue([item]);

    const res = await app.request("/shift-reports/7/products");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getProductCounts).toHaveBeenCalledWith(7);
    expect(body.data).toEqual([item]);
    // The grain bounds the answer to one machine's SKUs in one shift, so there is
    // nothing to page — an absent `meta` is the contract, not an omission.
    expect(body.meta).toBeUndefined();
  });

  it("returns an empty list for a shift that ran no SKUs", async () => {
    const { app } = setup();

    const res = await app.request("/shift-reports/7/products");

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  // Same guard as /shift-reports/:id, shared so the two routes cannot disagree.
  it.each([
    ["a non-numeric id", "abc"],
    ["a fractional id", "1.5"],
    ["a zero id", "0"],
    ["a negative id", "-1"],
  ])("400s on %s without calling the service", async (_label, id) => {
    const { app, getProductCounts } = setup();

    const res = await app.request(`/shift-reports/${id}/products`);

    expect(res.status).toBe(400);
    expect(getProductCounts).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404 for an unknown report", async () => {
    const { app, getProductCounts } = setup();
    getProductCounts.mockRejectedValue(new HTTPException(404, { message: "report not found" }));

    const res = await app.request("/shift-reports/12345/products");

    expect(res.status).toBe(404);
  });

  it("401s without a valid token", async () => {
    const { app, getProductCounts } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/7/products");

    expect(res.status).toBe(401);
    expect(getProductCounts).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id/performance", () => {
  const payload = {
    timeZone: "Asia/Jakarta",
    buckets: [{ bucketStart: "2026-08-01T16:00:00.000Z", productId: 4, totalOut: 34_304 }],
    loadedThrough: "2026-08-02",
  };

  it("returns the performance payload for a report", async () => {
    const { app, getPerformance } = setup();
    getPerformance.mockResolvedValue(payload);

    const res = await app.request("/shift-reports/7/performance");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getPerformance).toHaveBeenCalledWith(7);
    expect(body.data).toEqual(payload);
    // Unpaged: the grain is one shift's 8 buckets times a handful of SKUs.
    expect(body.meta).toBeUndefined();
  });

  // An OBJECT, not a bare array like /products. The zone and the watermark are
  // facts about the payload that the buckets cannot state about themselves.
  it("carries the zone and the watermark alongside an empty bucket list", async () => {
    const { app } = setup();

    const res = await app.request("/shift-reports/7/performance");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ timeZone: "Asia/Jakarta", buckets: [], loadedThrough: null });
  });

  // The same requireReportId guard as the two sibling :id routes, shared so the
  // three cannot disagree about what a valid report id is.
  it.each([
    ["a non-numeric id", "abc"],
    ["a fractional id", "1.5"],
    ["a zero id", "0"],
    ["a negative id", "-1"],
  ])("400s on %s without calling the service", async (_label, id) => {
    const { app, getPerformance } = setup();

    const res = await app.request(`/shift-reports/${id}/performance`);

    expect(res.status).toBe(400);
    expect(getPerformance).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404 for an unknown report", async () => {
    const { app, getPerformance } = setup();
    getPerformance.mockRejectedValue(new HTTPException(404, { message: "report not found" }));

    const res = await app.request("/shift-reports/12345/performance");

    expect(res.status).toBe(404);
  });

  it("401s without a valid token", async () => {
    const { app, getPerformance } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/7/performance");

    expect(res.status).toBe(401);
    expect(getPerformance).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id/rejects", () => {
  const payload = {
    timeZone: "Asia/Jakarta",
    buckets: [
      {
        reason: "NG_Over_Count",
        reasonCode: null,
        machineName: "Vertical Packer N",
        counterValue: 48,
        counterUnit: "CALENDER",
        quantity: 576,
        convertedUnit: "BAG",
        weightGram: 15_232,
        frequency: 48,
        durationMs: 96_000,
      },
    ],
    totalFrequency: 48,
    totalDurationMs: 96_000,
    totalQuantity: 576,
    totalWeightGram: 15_232,
    convertedUnit: "BAG",
    loadedThrough: "2026-08-01",
  };

  it("returns the reject breakdown for a report", async () => {
    const { app, getRejectReasons } = setup();
    getRejectReasons.mockResolvedValue(payload);

    const res = await app.request("/shift-reports/8/rejects");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getRejectReasons).toHaveBeenCalledWith(8);
    expect(body.data).toEqual(payload);
    // Unpaged: the grain is the reject counters wired to one machine.
    expect(body.meta).toBeUndefined();
  });

  // The counter figure and the converted figure are DIFFERENT NUMBERS in the
  // same row — 48 CALENDER against 576 BAG — and both have to survive the
  // envelope. Collapsing them is the most plausible-looking way to get this
  // screen wrong, so the wire contract pins it.
  it("carries the counter figure and the converted figure separately", async () => {
    const { app, getRejectReasons } = setup();
    getRejectReasons.mockResolvedValue(payload);

    const res = await app.request("/shift-reports/8/rejects");
    const body = await res.json();

    const [bucket] = body.data.buckets;
    expect(bucket.counterValue).toBe(48);
    expect(bucket.counterUnit).toBe("CALENDER");
    expect(bucket.quantity).toBe(576);
    expect(bucket.convertedUnit).toBe("BAG");
  });

  // FOUR DENOMINATORS ride on the response because the browser's cumulative line
  // divides by them rather than by the bars it drew. A null weight total means
  // nothing in the shift was weighed and must reach the browser as null.
  it("carries all four totals, and a null weight total unchanged", async () => {
    const { app, getRejectReasons } = setup();
    getRejectReasons.mockResolvedValue({ ...payload, totalWeightGram: null });

    const res = await app.request("/shift-reports/8/rejects");
    const body = await res.json();

    expect(body.data.totalFrequency).toBe(48);
    expect(body.data.totalDurationMs).toBe(96_000);
    expect(body.data.totalQuantity).toBe(576);
    expect(body.data.totalWeightGram).toBeNull();
  });

  // An OBJECT, not a bare array like /products — and on this endpoint the
  // watermark is the load-bearing part: the Gold table ships empty, so an empty
  // bucket list is the normal answer and `loadedThrough` is the only thing that
  // separates it from a shift with no rejects.
  it("carries the zone and the watermark alongside an empty bucket list", async () => {
    const { app } = setup();

    const res = await app.request("/shift-reports/8/rejects");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      timeZone: "Asia/Jakarta",
      buckets: [],
      totalFrequency: 0,
      totalDurationMs: 0,
      totalQuantity: 0,
      totalWeightGram: null,
      convertedUnit: null,
      loadedThrough: null,
    });
  });

  // The same requireReportId guard as the three sibling :id routes.
  it.each([
    ["a non-numeric id", "abc"],
    ["a fractional id", "1.5"],
    ["a zero id", "0"],
    ["a negative id", "-1"],
  ])("400s on %s without calling the service", async (_label, id) => {
    const { app, getRejectReasons } = setup();

    const res = await app.request(`/shift-reports/${id}/rejects`);

    expect(res.status).toBe(400);
    expect(getRejectReasons).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404 for an unknown report", async () => {
    const { app, getRejectReasons } = setup();
    getRejectReasons.mockRejectedValue(new HTTPException(404, { message: "report not found" }));

    const res = await app.request("/shift-reports/12345/rejects");

    expect(res.status).toBe(404);
  });

  it("401s without a valid token", async () => {
    const { app, getRejectReasons } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/8/rejects");

    expect(res.status).toBe(401);
    expect(getRejectReasons).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id/downtime-events", () => {
  // The worked example the feature is specified against: {Material_Jam,
  // Machine_Stop} and {Material_Jam, Operator_Break, Belt_Slip} give Material_Jam
  // a frequency of 2. FIVE occurrences across TWO stops, so the two totals differ
  // — which is the whole point of carrying both.
  const payload = {
    timeZone: "Asia/Jakarta",
    buckets: [
      { reason: "Material_Jam", frequency: 2 },
      { reason: "Machine_Stop", frequency: 1 },
      { reason: "Operator_Break", frequency: 1 },
      { reason: "Belt_Slip", frequency: 1 },
    ],
    totalOccurrences: 5,
    totalEvents: 2,
    loadedThrough: "2026-08-01",
  };

  it("returns the downtime event breakdown for a report", async () => {
    const { app, getDowntimeEventReasons } = setup();
    getDowntimeEventReasons.mockResolvedValue(payload);

    const res = await app.request("/shift-reports/8/downtime-events");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getDowntimeEventReasons).toHaveBeenCalledWith(8);
    expect(body.data).toEqual(payload);
    // Unpaged: the grain is the reasons one machine's stops cited in one shift.
    expect(body.meta).toBeUndefined();
  });

  // TWO TOTALS, AND ONLY ONE IS A DENOMINATOR. Both have to survive the envelope
  // distinctly, because the card states them side by side and the browser divides
  // by exactly one of them. A transposition here is the most plausible-looking way
  // to get this screen wrong: the cumulative line would walk past 100%.
  it("carries both totals separately, with the event count the smaller one", async () => {
    const { app, getDowntimeEventReasons } = setup();
    getDowntimeEventReasons.mockResolvedValue(payload);

    const res = await app.request("/shift-reports/8/downtime-events");
    const body = await res.json();

    expect(body.data.totalOccurrences).toBe(5);
    expect(body.data.totalEvents).toBe(2);
    expect(body.data.totalEvents).toBeLessThan(body.data.totalOccurrences);
    // The denominator is the total of the bars, which is what makes the cumulative
    // line reach exactly 100%.
    expect(
      body.data.buckets.reduce((n: number, b: { frequency: number }) => n + b.frequency, 0),
    ).toBe(body.data.totalOccurrences);
  });

  // FREQUENCY ONLY. The wire contract pins the absence, because a duration field
  // added later would be rendered by a chart that has no axis for it.
  it("carries no duration on any bucket", async () => {
    const { app, getDowntimeEventReasons } = setup();
    getDowntimeEventReasons.mockResolvedValue(payload);

    const res = await app.request("/shift-reports/8/downtime-events");
    const body = await res.json();

    for (const bucket of body.data.buckets) {
      expect(Object.keys(bucket)).toEqual(["reason", "frequency"]);
    }
  });

  // A stop that recorded no reason. `reason` must reach the browser as NULL and
  // never as "Unspecified": that label is applied client-side so a genuine reason
  // of that exact text cannot merge into the unattributed bucket.
  it("carries an unattributed bucket as a null reason", async () => {
    const { app, getDowntimeEventReasons } = setup();
    getDowntimeEventReasons.mockResolvedValue({
      ...payload,
      buckets: [{ reason: null, frequency: 3 }],
      totalOccurrences: 3,
      totalEvents: 3,
    });

    const res = await app.request("/shift-reports/8/downtime-events");
    const body = await res.json();

    expect(body.data.buckets[0].reason).toBeNull();
  });

  // An OBJECT, not a bare array like /products — and on this endpoint the
  // watermark is the load-bearing part: the Gold table ships empty, so an empty
  // bucket list is the normal answer and `loadedThrough` is the only thing that
  // separates it from a shift nothing stopped.
  it("carries the zone and the watermark alongside an empty bucket list", async () => {
    const { app } = setup();

    const res = await app.request("/shift-reports/8/downtime-events");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      timeZone: "Asia/Jakarta",
      buckets: [],
      totalOccurrences: 0,
      totalEvents: 0,
      loadedThrough: null,
    });
  });

  // The same requireReportId guard as the four sibling :id routes.
  it.each([
    ["a non-numeric id", "abc"],
    ["a fractional id", "1.5"],
    ["a zero id", "0"],
    ["a negative id", "-1"],
  ])("400s on %s without calling the service", async (_label, id) => {
    const { app, getDowntimeEventReasons } = setup();

    const res = await app.request(`/shift-reports/${id}/downtime-events`);

    expect(res.status).toBe(400);
    expect(getDowntimeEventReasons).not.toHaveBeenCalled();
  });

  it("surfaces the service's 404 for an unknown report", async () => {
    const { app, getDowntimeEventReasons } = setup();
    getDowntimeEventReasons.mockRejectedValue(
      new HTTPException(404, { message: "report not found" }),
    );

    const res = await app.request("/shift-reports/12345/downtime-events");

    expect(res.status).toBe(404);
  });

  it("401s without a valid token", async () => {
    const { app, getDowntimeEventReasons } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/8/downtime-events");

    expect(res.status).toBe(401);
    expect(getDowntimeEventReasons).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id/activity", () => {
  it("returns all three sources in the envelope", async () => {
    const { app } = setup();

    const res = await app.request("/shift-reports/7/activity");
    const body = (await res.json()) as {
      data: { sources: { kind: string }[]; entries: unknown[] };
    };

    expect(res.status).toBe(200);
    // An empty `entries` with three `sources` is the CORRECT answer for nearly
    // every report today, and the sources are what say why.
    expect(body.data.entries).toEqual([]);
    expect(body.data.sources.map((s) => s.kind)).toEqual(["approval", "downtime", "quality"]);
  });

  it("rejects a non-numeric id before reaching the service", async () => {
    const { app, getActivity } = setup();

    const res = await app.request("/shift-reports/abc/activity");

    expect(res.status).toBe(400);
    expect(getActivity).not.toHaveBeenCalled();
  });
});

describe("POST /shift-reports/:id/approve", () => {
  it("approves and returns the new approval state", async () => {
    const { app, approveShiftReport } = setup();

    const res = await app.request("/shift-reports/7/approve", { method: "POST" });
    const body = (await res.json()) as { data: { status: string; closedBy: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("closed");
    // 200 with a payload rather than 204: the browser flips the badge from this
    // response, and contract §8 is explicit that approvals need read-after-write.
    expect(body.data.closedBy).toBe("u1");
    expect(approveShiftReport).toHaveBeenCalledTimes(1);
  });

  it("passes the keycloak subject through, not the database user", async () => {
    const { app, approveShiftReport } = setup();

    await app.request("/shift-reports/7/approve", { method: "POST" });

    // passthroughAuth sets { sub: "u1" }; `name` is absent, so it degrades to
    // null rather than inventing a label.
    expect(approveShiftReport).toHaveBeenCalledWith(7, { subject: "u1", name: null, roles: [] });
  });

  it("rejects a non-numeric id before reaching the service", async () => {
    const { app, approveShiftReport } = setup();

    const res = await app.request("/shift-reports/abc/approve", { method: "POST" });

    expect(res.status).toBe(400);
    expect(approveShiftReport).not.toHaveBeenCalled();
  });

  it("401s a verified token that carries no subject", async () => {
    // The one place an undefined would otherwise reach a NOT NULL text column.
    // 401 and not 400: the token authenticated, it just cannot name anyone.
    const { app, approveShiftReport } = setup(subjectlessAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/7/approve", { method: "POST" });

    expect(res.status).toBe(401);
    expect(approveShiftReport).not.toHaveBeenCalled();
  });

  it("does not answer GET", async () => {
    // The route is a named action, not a readable resource.
    const { app } = setup();

    const res = await app.request("/shift-reports/7/approve");

    expect(res.status).toBe(404);
  });
});

describe("POST /shift-reports/:id/reopen", () => {
  it("reopens and returns the cleared approval state", async () => {
    const { app, reopenShiftReport } = setup();

    const res = await app.request("/shift-reports/7/reopen", { method: "POST" });
    const body = (await res.json()) as { data: { status: string; closedBy: string | null } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("open");
    // Cleared, not merely superseded — ck_wusra_open requires it, and the badge
    // flips from this payload rather than from a refetch.
    expect(body.data.closedBy).toBeNull();
    expect(reopenShiftReport).toHaveBeenCalledTimes(1);
  });

  it("passes the keycloak subject through", async () => {
    const { app, reopenShiftReport } = setup();

    await app.request("/shift-reports/7/reopen", { method: "POST" });

    expect(reopenShiftReport).toHaveBeenCalledWith(7, { subject: "u1", name: null, roles: [] });
  });

  it("rejects a non-numeric id before reaching the service", async () => {
    const { app, reopenShiftReport } = setup();

    const res = await app.request("/shift-reports/abc/reopen", { method: "POST" });

    expect(res.status).toBe(400);
    expect(reopenShiftReport).not.toHaveBeenCalled();
  });

  // A named action, not PATCH /:id/status. The two routes are deliberately
  // separate so each arrives with its own conflict semantics — and so a general
  // setter cannot publish a transition nobody asked for.
  it("is not reachable by GET", async () => {
    const { app } = setup();

    expect((await app.request("/shift-reports/7/reopen")).status).toBe(404);
  });

  it("requires a token", async () => {
    const { app, reopenShiftReport } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/shift-reports/7/reopen", { method: "POST" });

    expect(res.status).toBe(401);
    expect(reopenShiftReport).not.toHaveBeenCalled();
  });
});

describe("GET /shift-reports/:id/metrics-staleness", () => {
  it("answers with the envelope and no meta", async () => {
    const { app, getMetricsStaleness } = setup();

    const res = await app.request("/shift-reports/7/metrics-staleness");

    expect(res.status).toBe(200);
    expect(getMetricsStaleness).toHaveBeenCalledWith(7);
    // Unpaged, so no `meta` — the rule /activity already states.
    expect(await res.json()).toEqual({ data: { categoryEditedAt: null }, error: null });
  });

  it("rejects a non-numeric id before reaching the service", async () => {
    const { app, getMetricsStaleness } = setup();

    const res = await app.request("/shift-reports/abc/metrics-staleness");

    expect(res.status).toBe(400);
    expect(getMetricsStaleness).not.toHaveBeenCalled();
  });

  it("requires a token", async () => {
    const { app, getMetricsStaleness } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request("/shift-reports/7/metrics-staleness")).status).toBe(401);
    expect(getMetricsStaleness).not.toHaveBeenCalled();
  });
});

// TODOS §50's remaining half. The day and month reports roll up the same time a
// shift report does, so an operator's category edit makes them stale in exactly
// the same way — and until now only the shift screen said so, which left the two
// coarse screens quietly disagreeing with an edit somebody had just made.
describe("GET /{day,month}-reports/:id/metrics-staleness", () => {
  // WHICH GRAIN THE SPY RECEIVED. The three report tables have independent id
  // sequences, so a route wired to the wrong grain answers 200 about a different
  // report entirely — and "no category edit" is the reassuring answer, which is
  // the one this endpoint must never give by accident.
  it.each([
    ["day", "/day-reports/7/metrics-staleness"],
    ["month", "/month-reports/7/metrics-staleness"],
  ] as const)("%s reads its own grain", async (grain, url) => {
    const { app, getPeriodMetricsStaleness } = setup();

    const res = await app.request(url);

    expect(res.status).toBe(200);
    expect(getPeriodMetricsStaleness).toHaveBeenCalledWith(grain, 7);
    expect(await res.json()).toEqual({ data: { categoryEditedAt: null }, error: null });
  });

  it.each(["/day-reports/abc/metrics-staleness", "/month-reports/0/metrics-staleness"])(
    "rejects %s before reaching the service",
    async (url) => {
      const { app, getPeriodMetricsStaleness } = setup();

      expect((await app.request(url)).status).toBe(400);
      expect(getPeriodMetricsStaleness).not.toHaveBeenCalled();
    },
  );

  it("requires a token", async () => {
    const { app, getPeriodMetricsStaleness } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request("/day-reports/7/metrics-staleness")).status).toBe(401);
    expect(getPeriodMetricsStaleness).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// By Day and By Monthly
// ─────────────────────────────────────────────────────────────────────────────
//
// The two prefixes are registered from a `for (const grain of ["day","month"])`
// loop over one implementation, so the property worth testing is not that each
// route answers — it is that each passes ITS OWN grain through. A loop that
// closed over the wrong variable, or a copy-paste that left "day" in the month
// branch, would serve the day table under a /month-reports URL and nothing in
// the response shape would look wrong.
describe("period reports", () => {
  const GRAINS = [
    ["day", "/day-reports"],
    ["month", "/month-reports"],
  ] as const;

  it.each(GRAINS)("GET %s list passes its own grain to the service", async (grain, path) => {
    const { app, getPagedPeriodReport } = setup();

    const res = await app.request(path);

    expect(res.status).toBe(200);
    expect(getPagedPeriodReport).toHaveBeenCalledWith(grain, 1, 10, expect.any(Object));
  });

  it.each(GRAINS)("GET %s detail passes its own grain to the service", async (grain, path) => {
    const { app, getPeriodReport } = setup();

    const res = await app.request(`${path}/7`);

    expect(res.status).toBe(200);
    expect(getPeriodReport).toHaveBeenCalledWith(grain, 7);
  });

  it("carries the list filter through, and does not invent a shift or a status", async () => {
    const { app, getPagedPeriodReport } = setup();

    await app.request(
      "/day-reports?page=2&size=5&month=8&year=2026&workCenterId=3&areaId=4&isHideZero=true",
    );

    expect(getPagedPeriodReport).toHaveBeenCalledWith("day", 2, 5, {
      month: 8,
      year: 2026,
      workCenterId: 3,
      areaId: 4,
      isHideZero: true,
    });
  });

  // There is no shift and no approval at these grains. Accepting either would
  // answer a filtered request with an unfiltered page, which reads as data
  // rather than as an error.
  it.each([
    ["a shift", "/day-reports?shift=1"],
    ["a status", "/day-reports?status=closed"],
  ])("ignores %s rather than filtering on it", async (_name, path) => {
    const { app, getPagedPeriodReport } = setup();

    await app.request(path);

    const filter = getPagedPeriodReport.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(filter).not.toHaveProperty("shift");
    expect(filter).not.toHaveProperty("status");
  });

  // The same guard the shift routes use, reached through the same helper — a
  // non-numeric id is a broken link, not a server fault.
  it.each([
    ["a non-numeric id", "/day-reports/abc"],
    ["a zero id", "/month-reports/0"],
    ["a negative id", "/day-reports/-3"],
  ])("400s %s", async (_name, path) => {
    const { app, getPeriodReport } = setup();

    const res = await app.request(path);

    expect(res.status).toBe(400);
    expect(getPeriodReport).not.toHaveBeenCalled();
  });

  it("answers the detail in the WebResponse envelope", async () => {
    const { app } = setup();

    const res = await app.request("/day-reports/1");

    expect(await res.json()).toMatchObject({
      data: { id: 1, grain: "day", approval: { shiftsTotal: 3, shiftsClosed: 2 } },
      error: null,
    });
  });

  // Neither prefix may grow an approve or reopen route: there is no key to write
  // a day or month sign-off against.
  // Log Activity is enabled at every grain now, so the route has to exist on both
  // prefixes and pass its own grain — the same property the list and detail
  // routes are tested for, because they share one registration loop.
  it.each(GRAINS)("GET %s activity passes its own grain", async (grain, path) => {
    const { app, getPeriodActivity } = setup();

    const res = await app.request(`${path}/9/activity`);

    expect(res.status).toBe(200);
    expect(getPeriodActivity).toHaveBeenCalledWith(grain, 9);
  });

  it.each([
    ["/day-reports/1/approve"],
    ["/day-reports/1/reopen"],
    ["/month-reports/1/approve"],
    ["/month-reports/1/reopen"],
  ])("has no %s route", async (path) => {
    const { app } = setup();

    const res = await app.request(path, { method: "POST" });

    expect(res.status).toBe(404);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE YEAR GRAIN — four routes, and the FIVE ABSENCES are the load-bearing half
  // ───────────────────────────────────────────────────────────────────────────
  //
  // `0027` registers the year routes in their OWN block rather than by adding
  // "year" to the `["day","month"]` loop, because that loop mounts nine routes per
  // grain and a year report has an answer for four. These tests are what keep the
  // other five unmounted: fold the year into the loop and every one of the 404
  // assertions below flips to a 200 over an expensive scan nobody asked for.
  it("GET year oee-trend answers the envelope, and calls the YEAR fetcher", async () => {
    const { app, getYearOeeTrend, getMonthOeeTrend } = setup();

    const res = await app.request("/year-reports/9/oee-trend");

    expect(res.status).toBe(200);
    expect(getYearOeeTrend).toHaveBeenCalledWith(9);
    // THE SUBJECT-AND-GRAIN ASSERTION. Both trend endpoints return an IDENTICAL
    // envelope, so a wrong pick answers 200 with a plausible curve about another
    // period — asserting the response shape alone would pass either way.
    expect(getMonthOeeTrend).not.toHaveBeenCalled();
  });

  it("GET year-reports/:id reads the YEAR table", async () => {
    const { app, getPeriodReport } = setup();

    const res = await app.request("/year-reports/9");

    expect(res.status).toBe(200);
    expect(getPeriodReport).toHaveBeenCalledWith("year", 9);
  });

  it("GET year-reports/:id/rejects reads the YEAR window", async () => {
    const { app, getPeriodRejectReasons } = setup();

    const res = await app.request("/year-reports/9/rejects");

    expect(res.status).toBe(200);
    expect(getPeriodRejectReasons).toHaveBeenCalledWith("year", 9);
  });

  // NO `month` ON THE YEAR LIST. The validator never declares it, so a bookmarked
  // `?month=3` must not narrow the page — a year list narrowed to one month is a
  // different question, and answering it silently is the "filter that reads as
  // applied" failure listYearReportInputSchema exists to refuse.
  it("GET year-reports ignores a month parameter entirely", async () => {
    const { app, getPagedPeriodReport } = setup();

    const res = await app.request("/year-reports?year=2026&month=3");

    expect(res.status).toBe(200);
    expect(getPagedPeriodReport).toHaveBeenCalledWith(
      "year",
      1,
      10,
      expect.not.objectContaining({ month: 3 }),
    );
  });

  // THE FIVE ABSENCES.
  it.each([
    // SKU View is a report screen's card, and there is no year report screen.
    "/year-reports/9/products",
    // ~8,760 hourly points is not a chart at any grain.
    "/year-reports/9/performance",
    "/year-reports/9/hour-profile",
    // The Losses page's Others tab — same absence as products.
    "/year-reports/9/downtime-events",
    // ~1,095 shifts of transitions is a scan rather than a reading.
    "/year-reports/9/activity",
    // Nothing coarser than a shift has been built at all (§50, §60).
    "/year-reports/9/metrics-staleness",
  ])("does not register %s", async (path) => {
    const { app } = setup();

    expect((await app.request(path)).status).toBe(404);
  });

  // AND NO APPROVAL AT YEAR GRAIN. oee.work_unit_shift_report_approvals is keyed
  // (work_unit_id, date, shift); approving a year would close every shift report
  // inside it, which is not a permission any of the six role variables grants.
  it.each(["/year-reports/9/approve", "/year-reports/9/reopen"])(
    "does not register %s",
    async (path) => {
      const { app } = setup();

      expect((await app.request(path, { method: "POST" })).status).toBe(404);
    },
  );

  // The OEE Performance dashboard's daily trend.
  it("GET month oee-trend answers the envelope", async () => {
    const { app, getMonthOeeTrend } = setup();

    const res = await app.request("/month-reports/9/oee-trend");

    expect(res.status).toBe(200);
    expect(getMonthOeeTrend).toHaveBeenCalledWith(9);
    expect(await res.json()).toMatchObject({
      data: { items: [], timeZone: "Asia/Jakarta", loadedThrough: null },
      error: null,
    });
  });

  it("rejects a non-numeric oee-trend id before reaching the service", async () => {
    const { app, getMonthOeeTrend } = setup();

    const res = await app.request("/month-reports/abc/oee-trend");

    expect(res.status).toBe(400);
    expect(getMonthOeeTrend).not.toHaveBeenCalled();
  });

  // NOT REGISTERED AT DAY GRAIN, and this is the assertion that keeps it that way.
  // The route sits inside the registration loop's month-only arm; moving it out by
  // one brace would silently give a day report a trend of its own single day.
  it("has no /day-reports/:id/oee-trend route", async () => {
    const { app } = setup();

    const res = await app.request("/day-reports/1/oee-trend");

    expect(res.status).toBe(404);
  });
});
