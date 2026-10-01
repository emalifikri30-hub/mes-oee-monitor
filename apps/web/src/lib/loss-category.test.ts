import { describe, expect, it } from "vite-plus/test";

import { LOSS_CATEGORY_COPY } from "@/lib/loss-category";

import type { DowntimeCategory } from "@/lib/types";

// Copy, not arithmetic — so these do not check wording, which is a design
// decision and would make the suite a changelog. They check the two things that
// are silently WRONG rather than merely differently phrased:
//
//   1. `lossName` names the Losses-card tile this breakdown reconciles against.
//      A wrong one sends the reader to a figure from a different source.
//   2. No sentence written for one category leaks into another. Every string
//      here started as unplanned-specific prose, and a missed one reads as
//      entirely reasonable in the wrong tab.
const CATEGORIES: DowntimeCategory[] = ["UNPLANNED", "PLANNED", "SMALL_STOP"];

describe("LOSS_CATEGORY_COPY", () => {
  it("names the Losses-card figure each breakdown is read against", () => {
    expect(LOSS_CATEGORY_COPY.UNPLANNED.lossName).toBe("Availability Loss");
    expect(LOSS_CATEGORY_COPY.PLANNED.lossName).toBe("Schedule Loss");
    // Small Stop, not "Performance Loss": that factor is small stops plus
    // reduce-speed, and only the first half has per-cause records.
    expect(LOSS_CATEGORY_COPY.SMALL_STOP.lossName).toBe("Small Stop");
  });

  it.each(CATEGORIES)("covers every state of the load ladder for %s", (category) => {
    const { empty } = LOSS_CATEGORY_COPY[category];

    // The four non-ready states lib/load-state.ts can report. A missing one
    // would render as `undefined` inside the card's message strip.
    expect(Object.keys(empty).sort()).toEqual([
      "empty-loaded",
      "empty-stale",
      "error",
      "no-params",
    ]);
    for (const sentence of Object.values(empty)) expect(sentence.length).toBeGreaterThan(0);
  });

  // The pair that means opposite things about an identically empty response.
  // Collapsing them would let "not loaded yet" read as "the machine ran clean".
  it.each(CATEGORIES)("separates a clean shift from an unloaded one for %s", (category) => {
    const { empty } = LOSS_CATEGORY_COPY[category];
    expect(empty["empty-loaded"]).not.toBe(empty["empty-stale"]);
  });

  it("does not describe one category with another's words", () => {
    // "unplanned" contains "planned", so the planned copy is matched on a word
    // boundary that a leading "un" defeats.
    const planned = /(?<!un)planned/i;

    const unplanned = LOSS_CATEGORY_COPY.UNPLANNED;
    expect(unplanned.paretoTitle).toMatch(/unplanned/i);
    expect(unplanned.empty["empty-loaded"]).toMatch(/unplanned/i);

    const scheduled = LOSS_CATEGORY_COPY.PLANNED;
    expect(scheduled.paretoTitle).toMatch(planned);
    expect(scheduled.paretoTitle).not.toMatch(/unplanned/i);
    expect(scheduled.stopsLabel).not.toMatch(/unplanned/i);
    expect(scheduled.empty["empty-loaded"]).not.toMatch(/unplanned/i);
    expect(scheduled.empty["empty-stale"]).not.toMatch(/unplanned/i);
    expect(scheduled.empty.error).not.toMatch(/unplanned/i);
  });

  // The band colours the chart hands recharts. Each must be its own token, or
  // two tabs draw identical charts and the category stops being visible at a
  // glance — which is the only thing colour encodes on a Pareto.
  it("gives each category its own band token", () => {
    const bands = CATEGORIES.map((category) => LOSS_CATEGORY_COPY[category].bandVar);
    expect(new Set(bands).size).toBe(CATEGORIES.length);
    for (const band of bands) expect(band).toMatch(/^var\(--color-oee-[a-z-]+\)$/);
  });
});
