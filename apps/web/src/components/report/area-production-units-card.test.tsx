import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaProductionUnitsCard } from "@/components/report/area-production-units-card";
import { areaReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";

import type { AreaProductionUnits } from "@/lib/types";
import type { Seed } from "@/test/render";

afterEach(cleanup);

const REPORT = areaReport();

// The cache key must match `areaProductionUnitsQueryOptions` in lib/queries.ts
// EXACTLY. That coupling is the point: a key that drifts is a card that silently
// refetches forever, and the seed would simply be ignored — leaving these tests
// asserting the pending state and passing for the wrong reason.
function seed(units: Partial<AreaProductionUnits>): Seed[] {
  return [
    {
      queryKey: ["area-day-report-production-units", REPORT.id],
      data: {
        timeZone: "Asia/Jakarta",
        infeed: [],
        output: [],
        infeedUnresolved: 0,
        outputUnresolved: 0,
        loadedThrough: "2026-09-01",
        ...units,
      } satisfies AreaProductionUnits,
    },
  ];
}

const BAG = {
  uomId: 1,
  uomName: "Bag",
  uomCode: "BAG",
  workCenterCount: 2,
  totalOut: 1500,
  lineOut: 1430,
  reject: 45,
  rework: 25,
};

const SACK = {
  uomId: 2,
  uomName: "Sack",
  uomCode: "SACK",
  workCenterCount: 1,
  totalOut: 500,
  lineOut: 480,
  reject: 15,
  rework: 5,
};

const CTN = {
  uomId: 41,
  uomName: "Carton",
  uomCode: "CTN",
  workCenterCount: 2,
  goodOut: 120,
  effectiveOut: 117,
};

// One unit's row, as its cells — the line count first, then that side's measures
// in the order the header declares them.
function cellsOf(unit: string): string[] {
  const row = screen.getByRole("rowheader", { name: unit }).closest("tr");
  if (!row) throw new Error(`no row for unit "${unit}"`);
  return [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "");
}

// ---------------------------------------------------------------------------
// WHAT THIS CARD IS FOR, AND THEREFORE WHAT ITS TESTS PIN
// ---------------------------------------------------------------------------
//
// It exists because the overview card's three production figures are MASSES — the
// only unit an area's member lines can all be expressed in — and a mass cannot
// answer "how many bags went in". So this card breaks the same window out per unit.
//
// Three things can go wrong, and none of them throws:
//
//   1. ONE BUCKET WHERE THERE SHOULD BE TWO. Two lines counting in BAG and SACK
//      must produce two rows; a collapse produces one confident row adding sacks to
//      bags, and the number looks entirely ordinary.
//   2. THE TWO SIDES MERGED. A line has an infeed unit AND an output unit, and one
//      row can have either without the other. Totalling across them is the one
//      arithmetic migration 0014 forbids.
//   3. AN EMPTY CARD MEANING THE WRONG THING. An area that genuinely counted
//      nothing and one whose LINE reports have not loaded are opposite claims about
//      an identical empty card. `loadedThrough` names work_center_day_reports — the
//      table the rows come from — not area_day_reports.
describe("AreaProductionUnitsCard", () => {
  it("renders one row per unit on each side", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG, SACK], output: [CTN] }),
    });

    // Row headers, so `getByRole("rowheader")` finds the unit and nothing else on
    // the row can satisfy it.
    expect(screen.getByRole("rowheader", { name: "BAG" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "SACK" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "CTN" })).toBeTruthy();
  });

  // CELL BY CELL, NOT BY SUBSTRING. `textContent` on the SACK row is
  // "SACK" + "1" + "500" + "480" + "15" + "5" — which CONTAINS "1500" across the
  // line-count and total-out boundary, so a substring assertion here passes and
  // fails for reasons that have nothing to do with the card. Reading the cells is
  // both stronger and stable.
  it("keeps each unit's figures on its own row", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG, SACK], output: [CTN] }),
    });

    expect(cellsOf("BAG")).toEqual(["2", "1500", "1430", "45", "25"]);
    expect(cellsOf("SACK")).toEqual(["1", "500", "480", "15", "5"]);
    expect(cellsOf("CTN")).toEqual(["2", "120", "117"]);
  });

  // NOTHING IS TOTALLED, and that is the recommendation the card's header states
  // rather than an omission. A sum across rows is a sum of incommensurable
  // quantities; a sum across SIDES is the one 0014 forbids outright. Neither exists,
  // so there is no total row to find.
  it("renders no total row on either side", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG, SACK], output: [CTN] }),
    });

    expect(screen.queryByRole("rowheader", { name: /total/i })).toBeNull();
    // 2000 is 1500 + 500 — the sum a collapsed or totalled table would print.
    expect(screen.queryByText("2000")).toBeNull();
  });

  // THE LINE COUNT IS NOT DECORATION. It is what tells a reader whether a bucket is
  // one line's whole output or a genuine sum of several.
  it("says how many lines are behind each bucket", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG, SACK], output: [] }),
    });

    const bagRow = screen.getByRole("rowheader", { name: "BAG" }).closest("tr");
    const sackRow = screen.getByRole("rowheader", { name: "SACK" }).closest("tr");

    expect(bagRow?.textContent).toContain("2");
    expect(sackRow?.textContent).toContain("1");
  });

  // ONE SIDE POPULATED AND ONE EMPTY IS A POPULATED CARD, not an empty one. A
  // ladder that judged the two lists separately would render the "has not loaded
  // yet" sentence inside a card that plainly had loaded.
  it("renders the populated side and a per-side note for the empty one", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG], output: [] }),
    });

    expect(screen.getByRole("rowheader", { name: "BAG" })).toBeTruthy();
    expect(screen.getByText("No unit resolved on this side.")).toBeTruthy();
    // NOT the card-level empty state.
    expect(screen.queryByText(/not a record of nothing being produced/)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // The residuals
  // ---------------------------------------------------------------------------
  //
  // A line whose unit the pipeline could not resolve has a NULL unit triple, and
  // 0014's CHECK nulls its counts WITH it — so it contributes to NO bucket and is
  // silently absent. Without these counts, "this area's lines all count in BAG" and
  // "half this area has no unit yet" are the same screen.
  it("names the excluded lines per side when there are any", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG], output: [CTN], infeedUnresolved: 3, outputUnresolved: 1 }),
    });

    expect(screen.getByText(/3 lines are excluded/)).toBeTruthy();
    expect(screen.getByText(/1 line is excluded/)).toBeTruthy();
  });

  // ZERO IS THE HEALTHY STATE, and a permanent "0 lines excluded" line would be
  // noise that trains a reader to skip the place the real warning appears.
  it("says nothing about exclusions when both residuals are zero", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG], output: [CTN] }),
    });

    expect(screen.queryByText(/excluded/)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // The two empty states, which are opposite claims about an identical card
  // ---------------------------------------------------------------------------

  it("says the area produced nothing when the pipeline has reached this day", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ loadedThrough: "2026-09-01" }),
    });

    expect(screen.getByText(/No line on this area recorded production/)).toBeTruthy();
  });

  // THE FLATTERING READING IS THE WRONG ONE. An empty result the pipeline cannot
  // vouch for must not render as an idle area — TODOS §8, and the reason
  // `loadedThrough` is on the payload at all.
  it("says the line reports have not loaded when the pipeline has not reached this day", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ loadedThrough: "2026-08-01" }),
    });

    expect(screen.getByText(/have not been loaded for this report yet/)).toBeTruthy();
  });

  // A watermark that has NEVER been written is a third state and must read as the
  // stale one, not the loaded one.
  it("treats a never-loaded watermark as stale rather than as loaded", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ loadedThrough: null }),
    });

    expect(screen.getByText(/have not been loaded for this report yet/)).toBeTruthy();
  });

  // The tooltip is the only thing on screen saying these figures must not be
  // compared with each other. It is prose, and it is the point of the card.
  it("warns that the rows are not comparable", () => {
    renderWithQuery(<AreaProductionUnitsCard report={REPORT} />, {
      seed: seed({ infeed: [BAG, SACK], output: [CTN] }),
    });

    expect(screen.getByLabelText("About this breakdown")).toBeTruthy();
  });
});
