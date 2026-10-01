import { startOtel } from "@molca/observability";

// Start the OTel SDK before anything else loads so instrumentation can patch
// modules. In prod this is a no-op (already started by --import instrumentation.mjs).
// There is no database instrumentation to register: postgres.js cannot be
// auto-patched, so the repositories emit their spans through the `traced()`
// helper in shared/database/postgres.ts instead.
startOtel();

import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { httpInstrumentationMiddleware } from "@hono/otel";

import type { ContentfulStatusCode } from "hono/utils/http-status";

import { createContainer } from "../container/container.js";
import { loadConfig } from "../../shared/config/config.js";
import { createHealthHandler } from "../../module/health/health-handler.js";
import { createMasterDataHandler } from "../../module/master-data/master-data-handler.js";
import { createWorkUnitHandler } from "../../module/work-unit/work-unit-handler.js";
import {
  createProductQualityEntryHandler,
  createQualityEntryHandler,
} from "../../module/quality-entry/quality-entry-handler.js";
import { createProductReportHandler } from "../../module/product-report/product-report-handler.js";
import { createAreaReportHandler } from "../../module/area-report/area-report-handler.js";
import { createWorkCenterHandler } from "../../module/work-center/work-center-handler.js";
import { createDowntimeHandler } from "../../module/downtime/downtime-handler.js";
import { mapDomainError } from "@molca/helper";
import { observability, baseLogger, getRequestContext } from "@molca/observability";
import { serializeError } from "@molca/utils";
import { WebResponse } from "@molca/network";

const config = loadConfig();
const container = createContainer(config);

const app = new Hono();

app.use("*", httpInstrumentationMiddleware());
app.use("*", observability());
app.use(
  "*",
  cors({
    origin: config.cors.allowedOrigins,
  }),
);

app.route(
  "/health",
  createHealthHandler({
    keycloakProbe: container.resolve("keycloakProbe"),
    goldProbe: container.resolve("goldProbe"),
    silverProbe: container.resolve("silverProbe"),
  }),
);

const api = new Hono().basePath("/api/v1");

api.route(
  "/work-units",
  createWorkUnitHandler({
    authMw: container.resolve("authMw"),
    workUnitReportService: container.resolve("workUnitReportService"),
  }),
);

// Beside /master-data/work-centers rather than under it: that is the upstream
// catalogue, this is Gold's reports about the lines in it. Same split as
// /work-units vs /master-data.
api.route(
  "/work-centers",
  createWorkCenterHandler({
    authMw: container.resolve("authMw"),
    workCenterReportService: container.resolve("workCenterReportService"),
  }),
);

// The SKU grain. Its own prefix beside the other two subjects; see the handler for
// why `/products` does not collide with `/master-data/products`.
api.route(
  "/products",
  createProductReportHandler({
    authMw: container.resolve("authMw"),
    productReportService: container.resolve("productReportService"),
  }),
);

// The AREA grain. Its own prefix beside the other three subjects; see the handler
// for why `/areas` does not collide with `/master-data/areas`.
//
// NO quality-entry HANDLER IS MOUNTED HERE, and that asymmetry with `/products`
// below is the requirement's ("no add reject/rework" on an area report) as well as
// the schema's: an entry is keyed by LINE, so an area-level Add button would have
// to pick one — a choice the operator is already making on the line screen.
api.route(
  "/areas",
  createAreaReportHandler({
    authMw: container.resolve("authMw"),
    areaReportService: container.resolve("areaReportService"),
  }),
);

// MOUNTED ON THE SAME PREFIX as the reports above, deliberately, so the routes
// read `/work-centers/{grain}-reports/:id/quality-entries` — an entry against a
// LINE REPORT. Its own Hono app rather than more routes on the work-center
// handler because it is its own module: its own Gold table, its own validators
// and the only write in this service that CREATES a row.
//
// Hono composes two `route()` calls on one prefix by trying each in order, so the
// paths simply have to not collide — and they cannot, since every route here ends
// in a segment work-center-handler never serves.
api.route(
  "/work-centers",
  createQualityEntryHandler({
    authMw: container.resolve("authMw"),
    qualityEntryService: container.resolve("qualityEntryService"),
  }),
);

// AND A SECOND TIME ON /products, for the same reason and by the same
// composition: the SKU day report's Losses card offers the same two Add buttons,
// and every entry it produces is the same shift-keyed row in the same table.
//
// A SEPARATE FACTORY, NOT THE ONE ABOVE WITH A DIFFERENT PREFIX. Mounting the
// three-grain app here would register `/products/shift-reports/:id/quality-entries`
// — a LINE report id under a SKU prefix, resolving against a table with an
// independent identity sequence, answering 200 with another line's ledger. The
// handler's own comment says this at length.
api.route(
  "/products",
  createProductQualityEntryHandler({
    authMw: container.resolve("authMw"),
    qualityEntryService: container.resolve("qualityEntryService"),
  }),
);

// Not nested under /work-units: a downtime can belong to a work unit, a work
// center, an area or the factory, so the resource is scoped by query param.
api.route(
  "/downtimes",
  createDowntimeHandler({
    authMw: container.resolve("authMw"),
    downtimeTimelineService: container.resolve("downtimeTimelineService"),
  }),
);

// Reference lists from mes-master-data, behind a 5-minute cache that serves the
// last known good list when upstream is down (TODOS.md §7). Namespaced by their
// owner rather than mounted as /areas — see the header in master-data-handler.ts.
api.route(
  "/master-data",
  createMasterDataHandler({
    authMw: container.resolve("authMw"),
    masterDataService: container.resolve("masterDataService"),
  }),
);

app.route("/", api);

app.notFound((c) => {
  return c.json(WebResponse.builder<string>().error("not found page").build(), 404);
});

app.onError(async (err, c) => {
  const mapped = mapDomainError(err);
  if (mapped !== null) {
    const errRes = mapped.getResponse();
    const errMessage: string = await errRes.text();
    const errStatus: ContentfulStatusCode = errRes.status as ContentfulStatusCode;
    return c.json(WebResponse.builder<string>().error(errMessage).build(), errStatus);
  }

  const log = getRequestContext()?.logger ?? baseLogger;
  log.withMetadata({ err: serializeError(err) }).error("internal_server_error");
  return c.json(WebResponse.builder<string>().error("internal server error").build(), 500);
});

export { container };
export default app;
