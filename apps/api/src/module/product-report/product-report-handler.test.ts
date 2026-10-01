import { describe, expect, it, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";

import { createProductReportHandler } from "./product-report-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { TProductReportService } from "./product-report-service.js";

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so routing and the envelope can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

const FEED = { timeZone: "Asia/Jakarta", entries: [], sources: [], unattributed: 0 };

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  const getActivity = vi.fn().mockResolvedValue(FEED);
  const getMachines = vi.fn().mockResolvedValue({ machines: [] });
  const listReports = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
  const service = {
    listReports,
    getReport: vi.fn().mockResolvedValue({ id: 79 }),
    getRejectReasons: vi.fn().mockResolvedValue({ buckets: [] }),
    getDowntimeEventReasons: vi.fn().mockResolvedValue({ buckets: [], unattributed: 0 }),
    getActivity,
    getMachines,
  } as unknown as TProductReportService;

  return {
    app: createProductReportHandler({ productReportService: service, authMw }),
    getActivity,
    getMachines,
    listReports,
  };
}

// THE LIST FILTERS, and the area one is why this describe block exists.
//
// The SKU list is the third subject the header's area picker narrows, and its two
// narrowing axes are of different KINDS — `areaId` is CONTAINMENT, `productId` is
// OCCUPANCY OVER TIME (migration 0020) — so neither subsumes the other and both
// have to arrive.
describe("createProductReportHandler — GET /day-reports", () => {
  it("forwards every filter to the service", async () => {
    const { app, listReports } = setup();

    await app.request(
      "/day-reports?page=2&size=5&month=8&year=2026&workCenterId=3&areaId=4&productId=7&isHideZero=true",
    );

    expect(listReports).toHaveBeenCalledWith({
      limit: 5,
      offset: 5,
      filter: {
        month: 8,
        year: 2026,
        workCenterId: 3,
        areaId: 4,
        productId: 7,
        isHideZero: true,
      },
    });
  });

  // `?areaId=` means "every area", not 400 — the empty-string arm shiftFilter
  // documents, on the filter every report URL now carries.
  it.each([
    ["", undefined],
    ["areaId=", undefined],
    ["areaId=4", 4],
  ])("maps %s to areaId %s", async (query, expected) => {
    const { app, listReports } = setup();

    await app.request(`/day-reports?${query}`);

    const call = listReports.mock.calls[0]?.[0] as { filter: { areaId?: number } };
    expect(call.filter.areaId).toBe(expected);
  });
});

// The two routes this feature added. The reads that shipped with the screen are
// covered at the service and repository levels; what is asserted here is that the
// id guard runs BEFORE the service and that both sit behind auth — the two things
// a route can get wrong on its own.
describe("createProductReportHandler — /activity", () => {
  it("answers the feed", async () => {
    const { app, getActivity } = setup();

    const res = await app.request("/day-reports/79/activity");

    expect(res.status).toBe(200);
    expect(getActivity).toHaveBeenCalledWith(79);
  });

  // A broken link, not a server fault, so it must never reach the database.
  it("rejects a non-numeric id before the service", async () => {
    const { app, getActivity } = setup();

    const res = await app.request("/day-reports/abc/activity");

    expect(res.status).toBe(400);
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("sits behind auth", async () => {
    const { app, getActivity } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request("/day-reports/79/activity")).status).toBe(401);
    expect(getActivity).not.toHaveBeenCalled();
  });
});

describe("createProductReportHandler — /machines", () => {
  it("answers the roster", async () => {
    const { app, getMachines } = setup();

    const res = await app.request("/day-reports/79/machines");

    expect(res.status).toBe(200);
    expect(getMachines).toHaveBeenCalledWith(79);
  });

  it("rejects a non-numeric id before the service", async () => {
    const { app, getMachines } = setup();

    expect((await app.request("/day-reports/abc/machines")).status).toBe(400);
    expect(getMachines).not.toHaveBeenCalled();
  });
});

// WHAT MUST STAY ABSENT. /performance was never built (no hourly chart on this
// screen, by requirement) and the three approval paths cannot exist at this grain.
// Asserted rather than commented because adding a grain loop here later would be
// the cheapest way to register all of them by accident.
describe("createProductReportHandler — the absences", () => {
  it.each(["performance", "approval", "hour-profile", "products"])(
    "does not serve /%s",
    async (path) => {
      const { app } = setup();

      expect((await app.request(`/day-reports/79/${path}`)).status).toBe(404);
    },
  );

  it.each(["shift", "month"])("serves no %s-reports prefix at all", async (grain) => {
    const { app } = setup();

    expect((await app.request(`/${grain}-reports/79`)).status).toBe(404);
  });
});
