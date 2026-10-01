import { AsyncLocalStorage } from "node:async_hooks";

import type { ILogLayer } from "loglayer";

// Per-request context carried via AsyncLocalStorage. The container is built
// once at startup (services are effectively singletons), so a per-request child
// logger cannot reach them through Awilix — ALS lets a singleton resolve the
// current request's logger at call time, falling back to the base logger
// outside any request (startup, tests).
type RequestContext = {
  logger: ILogLayer;
  traceId: string;
};

const als = new AsyncLocalStorage<RequestContext>();

function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

export { runWithRequestContext, getRequestContext };
export type { RequestContext };
