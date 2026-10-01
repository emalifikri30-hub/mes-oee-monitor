import { describe, it, expect } from "vite-plus/test";

import { buildPageMeta, WebResponse } from "../src/response.js";

describe("buildPageMeta", () => {
  it("returns an empty meta when there are no elements", () => {
    const meta = buildPageMeta(1, 10, 0);
    expect(meta).toEqual({
      page: 1,
      size: 10,
      totalElements: 0,
      totalPages: 0,
      first: true,
      last: true,
    });
  });

  it("marks a single full page as both first and last", () => {
    const meta = buildPageMeta(1, 10, 5);
    expect(meta.totalPages).toBe(1);
    expect(meta.first).toBe(true);
    expect(meta.last).toBe(true);
  });

  it("computes ceil for partial last page on the first page", () => {
    const meta = buildPageMeta(1, 10, 25);
    expect(meta.totalPages).toBe(3);
    expect(meta.first).toBe(true);
    expect(meta.last).toBe(false);
  });

  it("flags a middle page as neither first nor last", () => {
    const meta = buildPageMeta(2, 10, 25);
    expect(meta.first).toBe(false);
    expect(meta.last).toBe(false);
  });

  it("flags the final page as last", () => {
    const meta = buildPageMeta(3, 10, 25);
    expect(meta.totalPages).toBe(3);
    expect(meta.first).toBe(false);
    expect(meta.last).toBe(true);
  });
});

describe("WebResponse builder", () => {
  it("builds a data-only payload with null error and no meta", () => {
    const out = WebResponse.builder<number[]>().data([1, 2, 3]).build();
    expect(out).toEqual({ data: [1, 2, 3], error: null });
    expect("meta" in out).toBe(false);
  });

  it("includes meta when provided", () => {
    const meta = buildPageMeta(1, 10, 1);
    const out = WebResponse.builder<string>().data("x").meta(meta).build();
    expect(out.data).toBe("x");
    expect(out.meta).toEqual(meta);
  });

  it("clears data when an error is set", () => {
    const out = WebResponse.builder<string>().data("x").error("boom").build();
    expect(out.data).toBeNull();
    expect(out.error).toBe("boom");
  });

  it("defaults to null data and null error", () => {
    const out = WebResponse.builder<string>().build();
    expect(out).toEqual({ data: null, error: null });
  });
});
