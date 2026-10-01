import { describe, it, expect } from "vite-plus/test";
import { HTTPException } from "hono/http-exception";

import { MasterDataError, isMasterDataError, upstreamUnavailable } from "./master-data-error.js";

describe("upstreamUnavailable", () => {
  it("maps a MasterDataError to a 502 naming the cause", () => {
    const err = upstreamUnavailable(
      new MasterDataError({ cause: "timeout", operation: "findAllArea", message: "timed out" }),
      "list areas",
    );

    expect(err).toBeInstanceOf(HTTPException);
    expect(err.status).toBe(502);
    expect(err.message).toBe("master data unavailable: could not list areas (timeout)");
  });

  it.each(["network_error", "http_error", "auth_error", "parse_error"] as const)(
    "carries the %s cause into the message",
    (cause) => {
      const err = upstreamUnavailable(
        new MasterDataError({ cause, operation: "op", message: "boom" }),
        "list work centers",
      );

      expect(err.message).toBe(`master data unavailable: could not list work centers (${cause})`);
    },
  );

  // A service that already decided the status — a 404 for an unknown work center —
  // must not have it rewritten to 502 on the way out.
  it("passes an existing HTTPException through untouched", () => {
    const original = new HTTPException(404, { message: "work center not found" });

    expect(upstreamUnavailable(original, "verify the work center")).toBe(original);
  });

  it("labels a non-MasterDataError cause as unknown", () => {
    const err = upstreamUnavailable(new TypeError("undefined is not a function"), "list areas");

    expect(err.status).toBe(502);
    expect(err.message).toBe("master data unavailable: could not list areas (unknown)");
  });

  // The original error stays reachable so serializeError can walk the chain.
  it("keeps the original error as the cause", () => {
    const original = new MasterDataError({ cause: "timeout", operation: "op", message: "boom" });

    expect(upstreamUnavailable(original, "list areas").cause).toBe(original);
  });
});

describe("isMasterDataError", () => {
  it.each([
    ["a MasterDataError", new MasterDataError({ cause: "timeout", operation: "o", message: "m" })],
    ["a plain Error", new Error("nope")],
    ["a string", "nope"],
    ["null", null],
  ])("narrows %s correctly", (label, value) => {
    expect(isMasterDataError(value)).toBe(label === "a MasterDataError");
  });
});
