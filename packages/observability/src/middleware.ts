import { trace } from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";

import { baseLogger } from "./logger.js";
import { runWithRequestContext } from "./context.js";

import type { ILogLayer } from "loglayer";

const TRACE_HEADER = "x-trace-id";

type ObservabilityEnv = {
  Variables: {
    logger: ILogLayer;
    traceId: string;
  };
};

// Replaces hono/logger. For every request it:
//  1. adopts the incoming x-trace-id (or mints one) as the correlation id,
//  2. stamps it on the active OTel span as `app.trace_id` and echoes it back,
//  3. binds a request-scoped logger (carrying x_trace_id + auto OTel trace ids)
//     into AsyncLocalStorage so handlers/services can resolve it,
//  4. logs request start/finish with method, path, status and duration.
const observability = () =>
  createMiddleware<ObservabilityEnv>(async (c, next) => {
    const incoming = c.req.header(TRACE_HEADER);
    const traceId = incoming && incoming.trim() !== "" ? incoming : crypto.randomUUID();

    trace.getActiveSpan()?.setAttribute("app.trace_id", traceId);
    c.header(TRACE_HEADER, traceId);

    const reqLogger = baseLogger.child().withContext({ x_trace_id: traceId });
    c.set("logger", reqLogger);
    c.set("traceId", traceId);

    const start = performance.now();
    reqLogger.withMetadata({ method: c.req.method, path: c.req.path }).info("request.start");

    await runWithRequestContext({ logger: reqLogger, traceId }, () => next());

    reqLogger
      .withMetadata({
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      })
      .info("request.finish");
  });

export { observability, TRACE_HEADER };
export type { ObservabilityEnv };
