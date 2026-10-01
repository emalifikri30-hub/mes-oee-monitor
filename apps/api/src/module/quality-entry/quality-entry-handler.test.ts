import { describe, expect, it, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";

import {
  createProductQualityEntryHandler,
  createQualityEntryHandler,
} from "./quality-entry-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { QualityEntryService } from "./quality-entry-service.js";

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so the ROUTING can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1", preferred_username: "op" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

const ENTRY = { id: 1, kind: "reject" };
const LIST = { items: [], totals: [], targetUomCode: "BAG" };

const DRAFT = {
  kind: "reject",
  workUnitId: 5,
  reasonId: 2,
  productId: 7,
  packageId: 3,
  quantity: 10,
  shift: 2,
  requestId: "3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
};

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  const list = vi.fn().mockResolvedValue(LIST);
  const create = vi.fn().mockResolvedValue(ENTRY);
  const voidEntry = vi.fn().mockResolvedValue(ENTRY);
  const service = { list, create, void: voidEntry } as unknown as QualityEntryService;

  return {
    line: createQualityEntryHandler({ qualityEntryService: service, authMw }),
    sku: createProductQualityEntryHandler({ qualityEntryService: service, authMw }),
    list,
    create,
    voidEntry,
  };
}

// ---------------------------------------------------------------------------
// The two mounts, and the path each one must NOT serve
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS. The two factories are the guard against a hazard the type
// system cannot see: one parameterised factory mounted at /products would also
// register `/products/shift-reports/:id/quality-entries`, which resolves a LINE
// report id under a SKU prefix. Seven report tables, seven independent identity
// sequences — so that request answers 200 with some other line's ledger, and
// nothing on the wire says it is the wrong subject.
//
// A test asserting the SKU routes WORK would pass either way. What has to be
// asserted is that the others are UNREGISTERED, and that each factory hands the
// service the right ref.
describe("createProductQualityEntryHandler", () => {
  it("serves the SKU day report's ledger", async () => {
    const { sku, list } = setup();

    const res = await sku.request("/day-reports/79/quality-entries");

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ subject: "product", grain: "day" }, 79, false);
  });

  it.each(["shift", "month"] as const)(
    "does not serve a %s-reports path, and never reaches the service",
    async (grain) => {
      const { sku, list } = setup();

      const res = await sku.request(`/${grain}-reports/79/quality-entries`);

      expect(res.status).toBe(404);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("records an entry against the product subject", async () => {
    const { sku, create } = setup();

    const res = await sku.request("/day-reports/79/quality-entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(DRAFT),
    });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      { subject: "product", grain: "day" },
      79,
      expect.objectContaining({ productId: 7 }),
      expect.anything(),
    );
  });

  it("voids one against the product subject", async () => {
    const { sku, voidEntry } = setup();

    const res = await sku.request("/day-reports/79/quality-entries/12/void", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "miskeyed" }),
    });

    expect(res.status).toBe(200);
    expect(voidEntry).toHaveBeenCalledWith(
      { subject: "product", grain: "day" },
      79,
      12,
      "miskeyed",
      expect.anything(),
    );
  });

  // A broken link, not a server fault, and it must never reach the database.
  it("rejects a non-numeric report id before the service", async () => {
    const { sku, list } = setup();

    const res = await sku.request("/day-reports/abc/quality-entries");

    expect(res.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("sits behind auth", async () => {
    const { sku, list } = setup(rejectingAuth as AuthMiddleware);

    const res = await sku.request("/day-reports/79/quality-entries");

    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("createQualityEntryHandler", () => {
  it.each(["shift", "day", "month"] as const)(
    "serves the line's %s report with its own grain",
    async (grain) => {
      const { line, list } = setup();

      const res = await line.request(`/${grain}-reports/7/quality-entries`);

      expect(res.status).toBe(200);
      expect(list).toHaveBeenCalledWith({ subject: "work-center", grain }, 7, false);
    },
  );

  // The mirror of the SKU assertion above: the line factory must not answer the
  // SKU prefix's shape either, or mounting both on one Hono app would let a SKU
  // request fall through to a line resolution.
  it("does not serve a bare /day-reports path with the product subject", async () => {
    const { line, list } = setup();

    await line.request("/day-reports/7/quality-entries");

    expect(list).not.toHaveBeenCalledWith(
      expect.objectContaining({ subject: "product" }),
      expect.anything(),
      expect.anything(),
    );
  });
});
