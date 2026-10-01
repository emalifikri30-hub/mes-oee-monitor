import { describe, expect, it } from "vite-plus/test";

import { LOSS_CATEGORY_COPY } from "@/lib/loss-category";
import { OTHERS_LOSS_COPY, occurrenceFootnote, occurrenceSummary } from "@/lib/others-loss";
import { QUALITY_LOSS_COPY } from "@/lib/quality-loss";

// The Others tab's words, and the same idiom lib/quality-loss.test.ts uses: assert
// what would be WRONG rather than the phrasing, so a rewrite for tone does not
// turn the suite red while a rewrite that changes a claim does.
//
// This file carries more weight than its two siblings, because on this tab the copy
// IS the correctness. No code can stop a supervisor reading a bar of 38 as "38
// stops" — arithmetically it is 38 events and the chart is simply right. Only a
// sentence can, so the sentences have tests.

describe("OTHERS_LOSS_COPY.empty", () => {
  const KEYS = ["no-params", "empty-loaded", "empty-stale", "error"] as const;

  it("covers exactly the four non-ready states of the ladder", () => {
    expect(Object.keys(OTHERS_LOSS_COPY.empty).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) expect(OTHERS_LOSS_COPY.empty[key].length).toBeGreaterThan(0);
  });

  // THE PAIR THAT MATTERS, and on this tab the stale one is not an edge case: the
  // Gold table ships empty, so it is the only reachable non-error state until the
  // DAG runs. Reporting those shifts as shifts nothing stopped would be the
  // flattering reading and the wrong one.
  it("says something different for a stale shift than for a clean one", () => {
    expect(OTHERS_LOSS_COPY.empty["empty-stale"]).not.toBe(OTHERS_LOSS_COPY.empty["empty-loaded"]);
    expect(OTHERS_LOSS_COPY.empty["empty-stale"]).toMatch(/not loaded/i);
    expect(OTHERS_LOSS_COPY.empty["empty-loaded"]).not.toMatch(/not loaded/i);
  });
});

describe("occurrenceSummary", () => {
  it("names both figures", () => {
    expect(occurrenceSummary(142, 97)).toBe("142 reason occurrences across 97 downtime events");
  });

  // "1 reason occurrences" reads as a bug, and a reader who has spotted one stops
  // trusting the rest of the screen.
  it("is singular on both halves at one", () => {
    expect(occurrenceSummary(1, 1)).toBe("1 reason occurrence across 1 downtime event");
  });

  it("pluralises the two halves independently", () => {
    expect(occurrenceSummary(3, 1)).toBe("3 reason occurrences across 1 downtime event");
  });

  // Through formatQuantity, so both figures are formatted exactly as the table's
  // own cells are — which is the point of routing them through it rather than
  // interpolating raw numbers.
  //
  // UNGROUPED, and that is the repo's choice rather than an oversight: the shared
  // `numberFormat` in lib/format.ts sets `useGrouping: false`, so "1420" here
  // matches "1420" in the Occurrences column. Asserting a comma would make this
  // sentence the one place on the card that formats a count differently.
  it("formats both figures the way the table's cells are formatted", () => {
    expect(occurrenceSummary(1420, 970)).toBe("1420 reason occurrences across 970 downtime events");
  });
});

describe("occurrenceFootnote", () => {
  // The clause the whole tab turns on, with the two numbers in it.
  it("quotes both figures and states the inequality", () => {
    const text = occurrenceFootnote(142, 97);

    expect(text).toContain("142");
    expect(text).toContain("97");
    expect(text).toMatch(/more than one reason/);
    expect(text).toMatch(/not to the 97 downtime events/);
  });

  // An empty or failed card must not footnote "0 occurrences across 0 events" as
  // though that were a finding — but the claim about multi-reason stops is true of
  // the tab rather than of one response, so it survives.
  it("drops the numeric clause when the figures are unknown, keeping the claim", () => {
    const text = occurrenceFootnote(null, null);

    expect(text).not.toMatch(/\d/);
    expect(text).toMatch(/more than one reason/);
  });

  // Named so a reader who compares the two is told they are different counts
  // rather than left to conclude one of them is wrong.
  it("names the figure a reader will otherwise compare it against", () => {
    expect(occurrenceFootnote(142, 97)).toMatch(/Downtime Frequency/);
  });
});

describe("OTHERS_LOSS_COPY invariants", () => {
  const STRINGS = [
    OTHERS_LOSS_COPY.paretoTitle,
    OTHERS_LOSS_COPY.paretoHint,
    OTHERS_LOSS_COPY.occurrencesLabel,
    OTHERS_LOSS_COPY.axisLabel,
    OTHERS_LOSS_COPY.rankedBy,
    ...Object.values(OTHERS_LOSS_COPY.empty),
  ];

  // Every string a reader meets as a LABEL, AXIS OR RESULT — the ones that would
  // be describing data rather than describing the tab.
  //
  // `paretoHint` IS DELIBERATELY EXCLUDED, and this is the one exemption in the
  // file. Its whole job is to explain the absence ("No duration is recorded per
  // reason, which is why frequency is the only ranking here"), so it is the single
  // string that has to be allowed to name the thing every other string must not.
  // A blanket assertion over it would forbid the sentence that makes the tab
  // legible.
  const RENDERED_AS_DATA = STRINGS.filter((text) => text !== OTHERS_LOSS_COPY.paretoHint);

  // FREQUENCY ONLY, asserted in the copy as well as in the SQL. This is the
  // assertion that stops a sentence being copied in from LOSS_CATEGORY_COPY later,
  // where every one of these words is legitimate.
  it("never reports a duration outside the hint that explains its absence", () => {
    for (const text of RENDERED_AS_DATA) {
      expect(text).not.toMatch(/duration|minutes|\bhours\b/i);
    }
    // And the hint really does explain it, so the exemption above is earning its
    // keep rather than merely excusing a stray word.
    expect(OTHERS_LOSS_COPY.paretoHint).toMatch(/no duration/i);
  });

  // Every string is plausible in the wrong tab, which is why the per-tab module
  // exists at all — so the test is that none of them describes another tab.
  it("never describes another loss tab", () => {
    for (const text of STRINGS) {
      expect(text).not.toMatch(/unplanned|planned downtime|small stop|reject|rework/i);
    }
  });

  // A STATIC LITERAL, never `var(--color-oee-${slug})`. With `@theme inline`
  // Tailwind emits a `--color-*` property only where its scanner found the literal
  // text, so a composed name is a property that was never emitted: the bars render
  // uncoloured and nothing errors anywhere.
  it("carries its band token as a whole var() literal", () => {
    expect(OTHERS_LOSS_COPY.bandVar).toBe("var(--color-oee-others)");
  });

  // Its own band, shared with nothing. The Losses page mounts one card per tab, so
  // two tabs could not collide on screen — but a shared token would mean a colour
  // change in one place silently restyled another tab.
  it("does not share a band token with any other loss tab", () => {
    const others = [
      QUALITY_LOSS_COPY.bandVar,
      ...Object.values(LOSS_CATEGORY_COPY).map((copy) => copy.bandVar),
    ];
    expect(others).not.toContain(OTHERS_LOSS_COPY.bandVar);
  });
});
