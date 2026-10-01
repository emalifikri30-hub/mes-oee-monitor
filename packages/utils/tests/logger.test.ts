import { describe, it, expect, vi } from "vite-plus/test";

import { withLog } from "../src/logger.js";

import type { Logger } from "../src/logger.js";

function fakeLogger() {
  const error = vi.fn();
  const withMetadata = vi.fn(() => ({ error }));
  // Minimal fluent stub shaped like the slice of ILogLayer that withLog uses.
  const logger = { withMetadata } as unknown as Logger;
  return { logger, withMetadata, error };
}

describe("withLog", () => {
  it("returns the wrapped function result and does not log on success", async () => {
    const { logger, withMetadata, error } = fakeLogger();
    const result = await withLog(logger, "post_create", { postId: "p1" }, async () => "ok");

    expect(result).toBe("ok");
    expect(withMetadata).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("logs the event, context and serialized error, then rethrows", async () => {
    const { logger, withMetadata, error } = fakeLogger();
    const boom = new Error("db down");

    await expect(
      withLog(logger, "post_update", { postId: "p1" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(withMetadata).toHaveBeenCalledTimes(1);
    expect(withMetadata).toHaveBeenCalledWith({
      event: "post_update",
      postId: "p1",
      err: { name: "Error", message: "db down" },
    });
    expect(error).toHaveBeenCalledWith("post_update");
  });
});
