import { describe, it, expect } from "vite-plus/test";

import { baseLogger } from "../src/logger.js";
import { getRequestContext, runWithRequestContext } from "../src/context.js";

describe("request context", () => {
  it("returns undefined outside of any request scope", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("exposes the bound context inside runWithRequestContext", () => {
    const ctx = { logger: baseLogger, traceId: "trace-123" };
    const seen = runWithRequestContext(ctx, () => getRequestContext());
    expect(seen).toBe(ctx);
    expect(seen?.traceId).toBe("trace-123");
  });

  it("does not leak context after the scope ends", () => {
    runWithRequestContext({ logger: baseLogger, traceId: "trace-456" }, () => {
      expect(getRequestContext()?.traceId).toBe("trace-456");
    });
    expect(getRequestContext()).toBeUndefined();
  });
});
