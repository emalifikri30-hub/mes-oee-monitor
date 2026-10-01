import { describe, expect, it } from "vite-plus/test";

import { reportYearOptions } from "@/lib/year-options";

// A fixed "now" so these cases mean the same thing in every January.
const NOW = new Date("2026-08-28T00:00:00.000Z");

describe("reportYearOptions", () => {
  it("returns five years, newest first", () => {
    expect(reportYearOptions(2026, NOW)).toEqual([2026, 2025, 2024, 2023, 2022]);
  });

  it("does not duplicate a year already inside the window", () => {
    expect(reportYearOptions(2023, NOW)).toEqual([2026, 2025, 2024, 2023, 2022]);
  });

  // A shared link's year. Without this the dropdown would disagree with the
  // table it controls.
  it("keeps a year older than the window selectable, still descending", () => {
    expect(reportYearOptions(2018, NOW)).toEqual(
      [2018, 2026, 2025, 2024, 2023, 2022].sort((a, b) => b - a),
    );
    expect(reportYearOptions(2018, NOW)[0]).toBe(2026);
    expect(reportYearOptions(2018, NOW)).toContain(2018);
  });

  it("keeps a year newer than the window selectable", () => {
    expect(reportYearOptions(2030, NOW)[0]).toBe(2030);
  });

  it("stays sorted descending in every case", () => {
    for (const selected of [2018, 2022, 2026, 2030]) {
      const years = reportYearOptions(selected, NOW);
      expect([...years].sort((a, b) => b - a)).toEqual(years);
    }
  });
});
