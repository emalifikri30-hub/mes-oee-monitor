import { describe, expect, it } from "vite-plus/test";

import { isLoadedThrough } from "@/lib/watermark";

// Shift 1 of business day 2026-08-09 at Asia/Jakarta: 07:00 local is 00:00Z.
const SHIFT_1 = "2026-08-09T00:00:00.000Z";
// Shift 3 of the SAME business day starts at 23:00 local, i.e. 16:00Z — still
// the 9th in Jakarta, and still the 9th in UTC. The zone matters below.
const SHIFT_3 = "2026-08-09T16:00:00.000Z";
const JAKARTA = "Asia/Jakarta";

describe("isLoadedThrough", () => {
  it("is loaded when the watermark is exactly the report's business day", () => {
    expect(isLoadedThrough(SHIFT_1, JAKARTA, "2026-08-09")).toBe(true);
  });

  it("is loaded when the pipeline has run past the report's day", () => {
    expect(isLoadedThrough(SHIFT_1, JAKARTA, "2026-08-12")).toBe(true);
  });

  it("is not loaded when the pipeline has not reached the report's day", () => {
    expect(isLoadedThrough(SHIFT_1, JAKARTA, "2026-08-08")).toBe(false);
  });

  // A missing row means the table has never been loaded at all, which must not
  // read as a clean shift.
  it("is not loaded when the pipeline has never stamped the table", () => {
    expect(isLoadedThrough(SHIFT_1, JAKARTA, null)).toBe(false);
  });

  it.each([
    ["an empty date", ""],
    ["a malformed date", "09-08-2026"],
    ["a null date", null],
    ["an undefined date", undefined],
  ])("is not loaded when the report carries %s", (_label, date) => {
    expect(isLoadedThrough(date, JAKARTA, "2026-08-12")).toBe(false);
  });

  // Crossing a month boundary is where a numeric-ish comparison would go wrong;
  // lexicographic ordering on zero-padded YYYY-MM-DD gets it right.
  it("orders correctly across a month boundary", () => {
    expect(isLoadedThrough("2026-09-01T00:00:00.000Z", JAKARTA, "2026-08-31")).toBe(false);
    expect(isLoadedThrough("2026-08-31T00:00:00.000Z", JAKARTA, "2026-09-01")).toBe(true);
  });

  // The reason the zone is a parameter rather than assumed. A shift starting at
  // 17:00Z is the 9th in Jakarta (UTC+7, so 00:00 on the 10th... ) — verified
  // against toBusinessDay rather than asserted from memory.
  it("reduces the instant in the plant's zone, not in UTC", () => {
    // 2026-08-09T17:00Z is 2026-08-10 00:00 in Jakarta, so its business day is
    // the 10th and a watermark at the 9th has not reached it.
    expect(isLoadedThrough("2026-08-09T17:00:00.000Z", JAKARTA, "2026-08-09")).toBe(false);
    // The same instant in UTC is still the 9th, so a UTC plant IS loaded.
    expect(isLoadedThrough("2026-08-09T17:00:00.000Z", "UTC", "2026-08-09")).toBe(true);
  });

  it("treats shift 3 as belonging to its own business day", () => {
    expect(isLoadedThrough(SHIFT_3, JAKARTA, "2026-08-09")).toBe(true);
  });
});
