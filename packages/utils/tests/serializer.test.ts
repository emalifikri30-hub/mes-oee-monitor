import { describe, it, expect } from "vite-plus/test";

import { serializeError } from "../src/serializer.js";

describe("serializeError", () => {
  it("extracts name and message from an Error", () => {
    expect(serializeError(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });

  it("preserves a custom error subclass name", () => {
    class CustomError extends Error {
      override name = "CustomError";
    }
    expect(serializeError(new CustomError("nope"))).toEqual({
      name: "CustomError",
      message: "nope",
    });
  });

  it("stringifies a non-error string value", () => {
    expect(serializeError("oops")).toBe("oops");
  });

  it("stringifies a non-error numeric value", () => {
    expect(serializeError(123)).toBe("123");
  });

  it("stringifies null and undefined", () => {
    expect(serializeError(null)).toBe("null");
    expect(serializeError(undefined)).toBe("undefined");
  });
});
