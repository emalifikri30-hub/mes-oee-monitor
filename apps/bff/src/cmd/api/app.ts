import { startOtel } from "@molca/observability";

// Start the OTel SDK before anything else loads so instrumentation can patch
// modules. In prod this is a no-op (already started by --import instrumentation.mjs).
startOtel();

import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { httpInstrumentationMiddleware } from "@hono/otel";

import type { ContentfulStatusCode } from "hono/utils/http-status";

import { createContainer } from "../container/container.js";
import { loadConfig } from "../../shared/config/config.js";
import { createAuthHandler } from "../../module/auth/auth-handler.js";
import { createHealthHandler } from "../../module/health/health-handler.js";
import { createProxyHandler } from "../../module/proxy/proxy-handler.js";
import { mapDomainError } from "@molca/helper";
import { observability, baseLogger, getRequestContext } from "@molca/observability";
import { WebResponse } from "@molca/network";

const config = loadConfig();
const container = createContainer(config);

const authService = container.resolve("authService");
const authMw = container.resolve("authMw");

const app = new Hono();

app.use("*", httpInstrumentationMiddleware());
app.use("*", observability());
app.use(
  "*",
  cors({
    origin: config.cors.allowedOrigins,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: [
      "content-type",
      "x-request-id",
      "x-trace-id",
      "range",
      "x-tenant-id",
      "x-org-id",
    ],
    exposeHeaders: ["x-trace-id"],
  }),
);

const healthRoutes = createHealthHandler({
  coreApiBaseUrl: config.coreApi.baseUrl,
  oidcBaseUri: config.oidc.baseUri,
});
app.route("/health", healthRoutes);

const authRoutes = createAuthHandler({ authService, config, authMw });
app.route("/", authRoutes);

const proxyRoutes = createProxyHandler({ config, authMw });
app.route("/api/proxy", proxyRoutes);

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
  log.withError(err).error("internal_server_error");
  return c.json(WebResponse.builder<string>().error("internal server error").build(), 500);
});

export { container };
export default app;
