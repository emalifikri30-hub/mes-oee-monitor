import { describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import { createProductReportHandler } from "../../module/product-report/product-report-handler.js";
import {
  createProductQualityEntryHandler,
  createQualityEntryHandler,
} from "../../module/quality-entry/quality-entry-handler.js";
import { createWorkCenterHandler } from "../../module/work-center/work-center-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";

// TWO HANDLERS ON ONE PREFIX, and this file exists because nothing else can see
// whether that works.
//
// app.ts mounts two Hono apps on `/work-centers` and — since the SKU entry dialog
// landed — two on `/products`. Its comment claims Hono "composes two `route()`
// calls on one prefix by trying each in order, so the paths simply have to not
// collide". THE PER-HANDLER TESTS CANNOT CHECK THAT: each builds ONE app and asks
// it for its own routes, so both pass whether or not the pair composes.
//
// THE FAILURE THIS GUARDS IS TOTAL, NOT SUBTLE. Every handler starts with
// `app.use("*", authMw)`. If the first app on a prefix answered an unmatched path
// itself — through that catch-all, or with a 404 of its own — the SECOND app's
// routes would be DEAD, and every quality-entry request would 401 or 404 with
// nothing in the code to say why. Probing the running service cannot tell you
// either: unauthenticated, auth runs before matching, so a live 401 is returned
// for a path that does not exist as readily as for one that does.
const auth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
}) as AuthMiddleware;

const LEDGER = { items: [], totals: [], targetUomCode: "BAG" };
const FEED = { timeZone: "Asia/Jakarta", entries: [], sources: [], unattributed: 0 };

function api() {
  const list = vi.fn().mockResolvedValue(LEDGER);
  const getActivity = vi.fn().mockResolvedValue(FEED);
  const getReport = vi.fn().mockResolvedValue({ id: 7, grain: "shift" });

  const app = new Hono().basePath("/api/v1");

  // The order app.ts uses: the READ handler first, then the entry one.
  app.route(
    "/products",
    createProductReportHandler({
      authMw: auth,
      productReportService: { getActivity } as never,
    }),
  );
  app.route(
    "/products",
    createProductQualityEntryHandler({
      authMw: auth,
      qualityEntryService: { list } as never,
    }),
  );
  app.route(
    "/work-centers",
    createWorkCenterHandler({
      authMw: auth,
      workCenterReportService: { getReport } as never,
    }),
  );
  app.route(
    "/work-centers",
    createQualityEntryHandler({
      authMw: auth,
      qualityEntryService: { list } as never,
    }),
  );

  return { app, list, getActivity, getReport };
}

describe("two handlers mounted on /products", () => {
  it("reaches the SECOND app's routes through the first", async () => {
    const { app, list } = api();

    const res = await app.request("/api/v1/products/day-reports/79/quality-entries");

    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ subject: "product", grain: "day" }, 79, false);
  });

  it("still reaches the FIRST app's routes", async () => {
    const { app, getActivity } = api();

    expect((await app.request("/api/v1/products/day-reports/79/activity")).status).toBe(200);
    expect(getActivity).toHaveBeenCalledWith(79);
  });

  // THE HAZARD THE TWO FACTORIES EXIST FOR. One parameterised factory mounted here
  // would also register /products/shift-reports/:id/quality-entries — a LINE report
  // id under a SKU prefix, resolving against a table with an independent identity
  // sequence and answering 200 with another line's ledger.
  it.each(["shift", "month"])("serves no /%s-reports quality path", async (grain) => {
    const { app, list } = api();

    expect((await app.request(`/api/v1/products/${grain}-reports/79/quality-entries`)).status).toBe(
      404,
    );
    expect(list).not.toHaveBeenCalled();
  });
});

describe("two handlers mounted on /work-centers", () => {
  // The shipped pair, unchanged — asserted here because the /products pair above
  // was added on the strength of it working, and if it ever stops the SKU screens
  // and the Line screens break together.
  it("reaches both apps", async () => {
    const { app, list, getReport } = api();

    expect((await app.request("/api/v1/work-centers/shift-reports/7")).status).toBe(200);
    expect(getReport).toHaveBeenCalled();

    expect((await app.request("/api/v1/work-centers/day-reports/7/quality-entries")).status).toBe(
      200,
    );
    expect(list).toHaveBeenCalledWith({ subject: "work-center", grain: "day" }, 7, false);
  });
});
