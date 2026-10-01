import { describe, it, expect } from "vite-plus/test";
import { HTTPException } from "hono/http-exception";

import { mapDomainError } from "../src/error.js";

describe("mapDomainError", () => {
  it("returns the same HTTPException instance when given one", () => {
    const ex = new HTTPException(404, { message: "not found" });
    expect(mapDomainError(ex)).toBe(ex);
  });

  it("returns null for a plain Error", () => {
    expect(mapDomainError(new Error("boom"))).toBeNull();
  });

  it("returns null for non-error values", () => {
    expect(mapDomainError("oops")).toBeNull();
    expect(mapDomainError(undefined)).toBeNull();
    expect(mapDomainError({ status: 500 })).toBeNull();
  });
});
