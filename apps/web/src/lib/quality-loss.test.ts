import { describe, expect, it } from "vite-plus/test";

import { EM_DASH } from "@/lib/format";
import { LOSS_CATEGORY_COPY } from "@/lib/loss-category";
import { QUALITY_LOSS_COPY, QUALITY_MEASURE_ORDER, QUALITY_MEASURES } from "@/lib/quality-loss";

import type { DowntimeCategory } from "@/lib/types";

// Copy, not wording: these assert the things that are WRONG rather than merely
// differently phrased — a sentence that promises the wrong reconciliation, a band
// token shared with another tab, a formatter that renders a mixed-unit sum as a
// plausible number. Same idiom as loss-category.test.ts.

const LADDER = ["no-params", "empty-loaded", "empty-stale", "error"] as const;

describe("QUALITY_LOSS_COPY", () => {
  it("covers exactly the four non-ready states of the load ladder", () => {
    expect(Object.keys(QUALITY_LOSS_COPY.empty).sort()).toEqual([...LADDER].sort());
    for (const state of LADDER) {
      expect(QUALITY_LOSS_COPY.empty[state].length).toBeGreaterThan(0);
    }
  });

  // The pair that means opposite things about an identically empty response. On
  // this tab the stale one is the normal case until the pipeline lands, so they
  // must not read the same.
  it("says something different about a clean shift and an unloaded one", () => {
    expect(QUALITY_LOSS_COPY.empty["empty-loaded"]).not.toBe(
      QUALITY_LOSS_COPY.empty["empty-stale"],
    );
    expect(QUALITY_LOSS_COPY.empty["empty-stale"]).toMatch(/not loaded/i);
    expect(QUALITY_LOSS_COPY.empty["empty-loaded"]).not.toMatch(/not loaded/i);
  });

  // THE ASSERTION THAT MATTERS MOST. The downtime cards say totals "need not
  // match"; here two of the three tiles look like they should, so the sentence has
  // to state the mismatch as a fact and name the tile it is about.
  it("states outright that the figures will not add up to the Reject tile", () => {
    expect(QUALITY_LOSS_COPY.footnote).toMatch(/will not add up/i);
    expect(QUALITY_LOSS_COPY.footnote).toMatch(/Reject/);
    expect(QUALITY_LOSS_COPY.footnote).not.toMatch(/need not match/i);
  });

  it("does not describe this tab with a downtime tab's words", () => {
    const strings = [
      QUALITY_LOSS_COPY.paretoTitle,
      QUALITY_LOSS_COPY.paretoHint,
      QUALITY_LOSS_COPY.occurrencesLabel,
      QUALITY_LOSS_COPY.footnote,
      ...LADDER.map((state) => QUALITY_LOSS_COPY.empty[state]),
    ];

    for (const text of strings) {
      expect(text).not.toMatch(/unplanned|planned downtime|small stop/i);
    }
  });

  // Colour is the only thing a Pareto's fill encodes, so a quality chart drawn in
  // a downtime tab's band would make the tab invisible at a glance.
  it("uses a band token of its own, shared with no downtime category", () => {
    const categories: DowntimeCategory[] = ["UNPLANNED", "PLANNED", "SMALL_STOP"];
    const downtimeBands = categories.map((category) => LOSS_CATEGORY_COPY[category].bandVar);

    expect(QUALITY_LOSS_COPY.bandVar).toMatch(/^var\(--color-oee-[a-z-]+\)$/);
    expect(downtimeBands).not.toContain(QUALITY_LOSS_COPY.bandVar);
  });

  it("names the Rework band and explains why it cannot be ranked", () => {
    expect(QUALITY_LOSS_COPY.reworkLabel).toBe("Rework");
    expect(QUALITY_LOSS_COPY.reworkNote).toMatch(/cannot be ranked/i);
  });
});

describe("QUALITY_MEASURES", () => {
  it("has one entry per ordered measure, with unique labels", () => {
    expect(QUALITY_MEASURE_ORDER).toHaveLength(4);
    for (const measure of QUALITY_MEASURE_ORDER) {
      expect(QUALITY_MEASURES[measure]).toBeDefined();
    }
    const labels = QUALITY_MEASURE_ORDER.map((measure) => QUALITY_MEASURES[measure].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("leads with quantity, the measure the chart plots by default", () => {
    expect(QUALITY_MEASURE_ORDER[0]).toBe("quantity");
  });

  it("renders an absent figure as an em dash for every measure", () => {
    for (const measure of QUALITY_MEASURE_ORDER) {
      expect(QUALITY_MEASURES[measure].format(null, "BAG")).toBe(EM_DASH);
    }
  });

  // A MIXED-UNIT BUCKET IS NOT A MISSING LABEL. The number behind it is a sum of
  // unlike units, so the whole cell has to em dash rather than show a bare figure
  // the reader would take at face value.
  it("em-dashes a converted quantity whose unit is mixed, rather than showing the number", () => {
    expect(QUALITY_MEASURES.quantity.format(4776, null)).toBe(EM_DASH);
    expect(QUALITY_MEASURES.quantity.format(4776, "BAG")).toContain("BAG");
  });

  it("names the unit on the quantity axis when the shift has one, and never prints null", () => {
    expect(QUALITY_MEASURES.quantity.axisLabel("BAG")).toBe("Quantity (BAG)");
    for (const measure of QUALITY_MEASURE_ORDER) {
      expect(QUALITY_MEASURES[measure].axisLabel(null)).not.toMatch(/null/);
    }
  });

  it("denominates weight in grams whatever unit it is handed", () => {
    expect(QUALITY_MEASURES.weight.format(15_232, null)).toBe("15232 gr");
    expect(QUALITY_MEASURES.weight.format(15_232, "BAG")).toBe("15232 gr");
  });

  it("formats a count bare, with no unit attached", () => {
    expect(QUALITY_MEASURES.frequency.format(48, null)).toBe("48");
  });

  it("gives every measure its own 'ranked by' phrase", () => {
    const phrases = QUALITY_MEASURE_ORDER.map((measure) => QUALITY_MEASURES[measure].rankedBy);
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});
