import { describe, it, expect } from "vite-plus/test";

import { chunk } from "../src/chunk.js";

// `chunk` bounds outbound request size: the master-data client splits work-unit
// ids into batches of 100 because upstream rejects a longer `?ids=` list. An
// off-by-one here becomes a 400 from another service, so the boundaries are
// pinned explicitly.
describe("chunk", () => {
  it("splits evenly when the length is an exact multiple", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("puts the remainder in a shorter final batch", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no batches for an empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("returns a single batch when the input is shorter than the size", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns a single batch when the input is exactly the size", () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("splits into singletons at size 1", () => {
    expect(chunk([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
  });

  it("preserves order across batches", () => {
    const input = Array.from({ length: 250 }, (_, i) => i);

    const batches = chunk(input, 100);

    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = [1, 2, 3];

    chunk(input, 2);

    expect(input).toEqual([1, 2, 3]);
  });

  it("copies rather than aliasing the source array", () => {
    const input = [1, 2, 3, 4];

    const batches = chunk(input, 2);
    batches[0]![0] = 99;

    expect(input[0]).toBe(1);
  });

  // Throwing beats looping forever: `i += 0` would never advance.
  it.each([0, -1])("throws for a size of %s", (size) => {
    expect(() => chunk([1, 2, 3], size)).toThrow("chunk size must be > 0");
  });

  it("accepts a readonly array", () => {
    const input: readonly number[] = [1, 2, 3];

    expect(chunk(input, 2)).toEqual([[1, 2], [3]]);
  });
});
