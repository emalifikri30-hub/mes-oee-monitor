import { describe, it, expect, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { createMasterDataHandler } from "./master-data-handler.js";
import { MasterDataError } from "./master-data-error.js";
import { MasterDataService } from "./master-data-service.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { MasterDataClientContract } from "@molca/contract-client";

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so query parsing and the envelope can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

const AREA = { id: 1, code: "AJINEX-H7", name: "H7" };
const WORK_CENTER = { id: 13, code: "H7-PB", name: "Line PB" };
const DOWNTIME_REASON = {
  id: 41,
  code: "MCH_BRK",
  name: "Machine Breakdown",
  category: "UNPLANNED" as const,
};
const DOWNTIME_ACTION = { id: 7, code: "replace_belt", name: "Replace Belt", color: "#f43f5e" };

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  // `satisfies Record<keyof ...>` keeps this fake exhaustive: adding a method to
  // the contract breaks compilation here instead of silently going untested.
  const client = {
    existsWorkCenter: vi.fn().mockResolvedValue(true),
    findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([]),
    findAllWorkUnitByWorkUnitIds: vi.fn().mockResolvedValue({ found: [], missingIds: [] }),
    findAllArea: vi.fn().mockResolvedValue([AREA]),
    findAllWorkCenterByAreaId: vi.fn().mockResolvedValue([WORK_CENTER]),
    findAllDowntimeReasonByWorkCenterId: vi.fn().mockResolvedValue([DOWNTIME_REASON]),
    findAllDowntimeAction: vi.fn().mockResolvedValue([DOWNTIME_ACTION]),
    createDowntimeAction: vi.fn().mockResolvedValue(DOWNTIME_ACTION),
    // Unused by these routes, but the exhaustiveness check below requires it.
    findTimeZoneByScope: vi.fn(),
    // Part 3's three, unused here. Present because the `satisfies` below is
    // exhaustive over the port — which is the point of it: a method added to the
    // contract fails every fake until somebody decides what it should return.
    findAllRejectReasonByWorkCenterId: vi.fn(),
    findAllProductByWorkCenterId: vi.fn(),
    findProductById: vi.fn(),
  } satisfies Record<keyof MasterDataClientContract, ReturnType<typeof vi.fn>>;

  // A REAL MasterDataService over the fake client, not a stubbed service.
  //
  // The route no longer touches the client — TODOS.md §7 put a cache between them
  // — and stubbing the service would test the handler against a mock of the only
  // thing that changed. Wrapping instead keeps every `client.findAllArea` assertion
  // below meaningful AND puts the cache on the path these tests exercise, which is
  // what the route actually does now.
  //
  // A FRESH SERVICE PER setup() CALL, so no cache outlives its test. That is why
  // the single-call assertions still read as they did; the caching behaviour itself
  // is asserted in master-data-service.test.ts, where it can be about one thing.
  const app = createMasterDataHandler({
    // No `logger`: it defaults to baseLogger, and the only thing the service
    // logs is a stale serve — which a fresh cache with nothing to fall back to
    // cannot reach. Asserted in master-data-service.test.ts, where it can be
    // seeded deliberately.
    masterDataService: new MasterDataService({
      masterDataClient: client as unknown as MasterDataClientContract,
    }),
    authMw,
  });

  // The handler throws HTTPException directly; the real app.onError maps it.
  // Reproduced here so status assertions reflect what a client actually sees.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: "internal" }, 500);
  });

  return { app, client };
}

const timeout = () =>
  new MasterDataError({ cause: "timeout", operation: "op", message: "timed out" });

describe("GET /areas", () => {
  it("returns the list in the standard envelope", async () => {
    const { app, client } = setup();

    const res = await app.request("/areas");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(client.findAllArea).toHaveBeenCalledTimes(1);
    expect(body.data).toEqual([AREA]);
    expect(body.error).toBeNull();
  });

  // A select box cannot act on a page count, and the client returns whole lists —
  // an absent `meta` is the contract, not an oversight.
  it("omits meta entirely", async () => {
    const { app } = setup();

    const body = await (await app.request("/areas")).json();

    expect(body).not.toHaveProperty("meta");
  });

  it("returns an empty list rather than 404 when there are no areas", async () => {
    const { app, client } = setup();
    client.findAllArea.mockResolvedValue([]);

    const res = await app.request("/areas");

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  // 502, not 500: the failure is upstream's, and a 500 would read as a bug here.
  it("502s with the typed cause when master data fails", async () => {
    const { app, client } = setup();
    client.findAllArea.mockRejectedValue(timeout());

    const res = await app.request("/areas");

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "master data unavailable: could not list areas (timeout)",
    );
  });

  it("401s without a valid token", async () => {
    const { app, client } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/areas");

    expect(res.status).toBe(401);
    expect(client.findAllArea).not.toHaveBeenCalled();
  });
});

describe("GET /work-units", () => {
  const WORK_UNIT = { id: 3, code: "WU-3", name: "Vertical Packer N" };
  const ROSTER = [{ ...WORK_UNIT, workCenter: { id: 12, code: "WC-03", name: "Line 3" } }];

  it("passes the coerced workCenterId through and drops the nested work center", async () => {
    const { app, client } = setup();
    client.findAllWorkUnitByWorkCenterId.mockResolvedValue(ROSTER);

    const res = await app.request("/work-units?workCenterId=12");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(client.findAllWorkUnitByWorkCenterId).toHaveBeenCalledWith(12);
    // The picker's caller already knows the line — it is the filter above this one
    // in the bar — so carrying `workCenter` would be a second source of truth for
    // its name.
    expect(body.data).toEqual([WORK_UNIT]);
    expect(body).not.toHaveProperty("meta");
  });

  // Unscoped, upstream reads this as "no filter" and answers with every work unit
  // in the region — which would offer an operator every machine in the plant under
  // one line's label.
  it.each([
    ["a missing workCenterId", ""],
    ["an empty workCenterId", "?workCenterId="],
    ["a non-numeric workCenterId", "?workCenterId=abc"],
    ["a zero workCenterId", "?workCenterId=0"],
  ])("400s %s before reaching upstream", async (_label, query) => {
    const { app, client } = setup();

    const res = await app.request(`/work-units${query}`);

    expect(res.status).toBe(400);
    expect(client.findAllWorkUnitByWorkCenterId).not.toHaveBeenCalled();
  });

  // A line with no machines and an unknown workCenterId are indistinguishable
  // upstream, so both are an empty picker rather than a 404.
  it("returns an empty list for a line with no machines", async () => {
    const { app, client } = setup();
    client.findAllWorkUnitByWorkCenterId.mockResolvedValue([]);

    const res = await app.request("/work-units?workCenterId=999");

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });
});

describe("GET /work-centers", () => {
  it("passes the coerced areaId through", async () => {
    const { app, client } = setup();

    const res = await app.request("/work-centers?areaId=7");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(client.findAllWorkCenterByAreaId).toHaveBeenCalledWith(7);
    expect(body.data).toEqual([WORK_CENTER]);
    expect(body).not.toHaveProperty("meta");
  });

  // Upstream reads a missing or `0` areaId as "no filter" and answers with every
  // work center in the region, so an unvalidated param would silently widen a
  // scoped lookup into a full catalogue dump.
  it.each([
    ["a missing areaId", ""],
    ["an empty areaId", "?areaId="],
    ["a non-numeric areaId", "?areaId=abc"],
    ["a zero areaId", "?areaId=0"],
    ["a negative areaId", "?areaId=-3"],
    ["a fractional areaId", "?areaId=1.5"],
  ])("400s on %s without calling upstream", async (_label, query) => {
    const { app, client } = setup();

    const res = await app.request(`/work-centers${query}`);

    expect(res.status).toBe(400);
    expect(client.findAllWorkCenterByAreaId).not.toHaveBeenCalled();
  });

  it("returns an empty list for an area with no work centers", async () => {
    const { app, client } = setup();
    client.findAllWorkCenterByAreaId.mockResolvedValue([]);

    const res = await app.request("/work-centers?areaId=999");

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it("502s with the typed cause when master data fails", async () => {
    const { app, client } = setup();
    client.findAllWorkCenterByAreaId.mockRejectedValue(timeout());

    const res = await app.request("/work-centers?areaId=7");

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "master data unavailable: could not list work centers (timeout)",
    );
  });

  it("401s without a valid token", async () => {
    const { app, client } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/work-centers?areaId=7");

    expect(res.status).toBe(401);
    expect(client.findAllWorkCenterByAreaId).not.toHaveBeenCalled();
  });
});

describe("GET /downtime-reasons", () => {
  it("returns the line's reason catalogue in the standard envelope", async () => {
    const { app, client } = setup();

    const res = await app.request("/downtime-reasons?workCenterId=13");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(client.findAllDowntimeReasonByWorkCenterId).toHaveBeenCalledWith(13);
    expect(body.data).toEqual([DOWNTIME_REASON]);
    expect(body.error).toBeNull();
  });

  // THE WHOLE POINT OF THE PARAM BEING REQUIRED. Upstream reads a missing
  // workCenterId as "no filter" and answers with the entire region's catalogue,
  // so an unvalidated param would silently offer the palletiser's reasons to
  // somebody recording a stop on the filler — and reason[0] is the key the
  // Availability Pareto groups that stop under. The 400 must land BEFORE any
  // upstream call, which is what the second assertion pins.
  it.each([
    ["a missing workCenterId", ""],
    ["a zero workCenterId", "?workCenterId=0"],
    ["a negative workCenterId", "?workCenterId=-1"],
    ["a non-numeric workCenterId", "?workCenterId=abc"],
    ["a fractional workCenterId", "?workCenterId=1.5"],
  ])("400s on %s without calling upstream", async (_label, query) => {
    const { app, client } = setup();

    const res = await app.request(`/downtime-reasons${query}`);

    expect(res.status).toBe(400);
    expect(client.findAllDowntimeReasonByWorkCenterId).not.toHaveBeenCalled();
  });

  // A line with no reasons attached is a valid empty picker, and an unknown
  // workCenterId is indistinguishable from it upstream — so both are 200.
  it("returns an empty list rather than 404 for a line with no reasons", async () => {
    const { app, client } = setup();
    client.findAllDowntimeReasonByWorkCenterId.mockResolvedValue([]);

    const res = await app.request("/downtime-reasons?workCenterId=999");

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it("502s with the typed cause when master data fails", async () => {
    const { app, client } = setup();
    client.findAllDowntimeReasonByWorkCenterId.mockRejectedValue(timeout());

    const res = await app.request("/downtime-reasons?workCenterId=13");

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "master data unavailable: could not list downtime reasons (timeout)",
    );
  });

  it("401s without a valid token", async () => {
    const { app, client } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/downtime-reasons?workCenterId=13");

    expect(res.status).toBe(401);
    expect(client.findAllDowntimeReasonByWorkCenterId).not.toHaveBeenCalled();
  });
});

describe("GET /downtime-actions", () => {
  // NO scope param, unlike every other list here: `ms_downtime.downtime_actions`
  // has no junction tables upstream, so there is nothing to scope by. A
  // workCenterId appearing on this route would be a schema change, not a filter.
  it("returns the catalogue with no scope param required", async () => {
    const { app, client } = setup();

    const res = await app.request("/downtime-actions");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(client.findAllDowntimeAction).toHaveBeenCalledTimes(1);
    expect(body.data).toEqual([DOWNTIME_ACTION]);
  });

  it("502s with the typed cause when master data fails", async () => {
    const { app, client } = setup();
    client.findAllDowntimeAction.mockRejectedValue(timeout());

    const res = await app.request("/downtime-actions");

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "master data unavailable: could not list downtime actions (timeout)",
    );
  });

  it("401s without a valid token", async () => {
    const { app, client } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/downtime-actions");

    expect(res.status).toBe(401);
    expect(client.findAllDowntimeAction).not.toHaveBeenCalled();
  });
});

function postAction(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const NEW_ACTION = { code: "replace_belt", name: "Replace Belt", color: "#f43f5e" };

describe("POST /downtime-actions", () => {
  // 201 WITH THE ROW, not with an id: the browser writes the action's NAME into
  // the downtime's actions[], so an id-only response would send it back for a
  // second request to learn something it is entitled to be told once.
  it("201s with the created row", async () => {
    const { app, client } = setup();

    const res = await app.request("/downtime-actions", postAction(NEW_ACTION));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(client.createDowntimeAction).toHaveBeenCalledWith(NEW_ACTION);
    expect(body.data).toEqual(DOWNTIME_ACTION);
    expect(body.error).toBeNull();
  });

  // Validated HERE rather than forwarded blind, so a bad body is a 400 from this
  // service with a message the dialog can render — not a 502 wrapping somebody
  // else's 400. The colour cases matter most: upstream's column is a varchar(10),
  // so an over-long hex would be TRUNCATED there rather than rejected, and a
  // truncated hex is a different colour with nothing to say so.
  it.each([
    ["a short code", { ...NEW_ACTION, code: "ab" }],
    ["a short name", { ...NEW_ACTION, name: "Ab" }],
    ["a colour word", { ...NEW_ACTION, color: "red rose" }],
    ["a short hex", { ...NEW_ACTION, color: "#f43f5" }],
    ["a hex with no hash", { ...NEW_ACTION, color: "f43f5e" }],
    ["a hex with alpha", { ...NEW_ACTION, color: "#f43f5e99" }],
    ["a missing colour", { code: "replace_belt", name: "Replace Belt" }],
  ])("400s on %s without calling upstream", async (_label, body) => {
    const { app, client } = setup();

    const res = await app.request("/downtime-actions", postAction(body));

    expect(res.status).toBe(400);
    expect(client.createDowntimeAction).not.toHaveBeenCalled();
  });

  it("502s with the typed cause when the create fails upstream", async () => {
    const { app, client } = setup();
    client.createDowntimeAction.mockRejectedValue(timeout());

    const res = await app.request("/downtime-actions", postAction(NEW_ACTION));

    // 502, matching the READS. A write that answered 500 for the same upstream
    // outage would say the fault is this service's, and send whoever is on call
    // to the wrong place.
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "master data unavailable: could not create downtime action (timeout)",
    );
  });

  // The write is gated by the same middleware as the reads, and must not reach
  // upstream unauthenticated — the one assertion here that is about a WRITE
  // rather than about a wasted request.
  it("401s without a valid token and never calls upstream", async () => {
    const { app, client } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request("/downtime-actions", postAction(NEW_ACTION));

    expect(res.status).toBe(401);
    expect(client.createDowntimeAction).not.toHaveBeenCalled();
  });
});
