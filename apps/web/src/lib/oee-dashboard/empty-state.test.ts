import { describe, expect, it } from "vite-plus/test";

import { areaEmptyState, lineEmptyState, machineEmptyState } from "./empty-state";

// THE ASSERTION THAT MATTERS IN ALL THREE LADDERS IS THE `settled: false` ONE.
//
// "This machine has no report for the selected month" is a CONFIDENT NEGATIVE, and
// every list on this surface serves the PREVIOUS subject's rows as placeholder data
// while the next loads. A ladder that states it early tells an operator a machine
// had no production, for as long as a refetch takes. The other rungs are derived
// from master-data catalogues and cannot lie that way.

const machineBase = {
  lineCount: 2,
  workCenterId: 2 as number | undefined,
  machineOptions: [{ id: 7 }] as readonly unknown[] | undefined,
  settled: true,
  workUnitId: 7 as number | undefined,
  hasReport: true,
  periodNoun: "month" as const,
};

describe("machineEmptyState", () => {
  it("says nothing when there is a report to draw", () => {
    expect(machineEmptyState(machineBase)).toBeUndefined();
  });

  it("names the area's missing lines first", () => {
    expect(machineEmptyState({ ...machineBase, lineCount: 0, workCenterId: undefined })).toBe(
      "This area has no lines.",
    );
  });

  it("names the line's missing machines next", () => {
    expect(machineEmptyState({ ...machineBase, machineOptions: [] })).toBe(
      "This line has no machines.",
    );
  });

  // `undefined` options mean the CATALOGUE IS STILL LOADING, and an empty array
  // means the line genuinely has no machines. Only the second is a sentence —
  // reading the first as "no machines" would accuse a line of being empty every
  // time the catalogue was slow.
  //
  // NOTE WHAT THIS DOES *NOT* SUPPRESS, because it looks like an inconsistency and
  // is not: the LAST rung still fires while the catalogue loads. `resolveSelection`
  // deliberately lets a requested id stand before the options arrive, so a shared
  // link naming a machine from another line reaches a settled report list with no
  // matching row — and at that point "this machine has no report" is simply true.
  // Whether the picker can yet draw its name has no bearing on whether Gold holds
  // a report.
  it("does not read a loading catalogue as a line with no machines", () => {
    expect(
      machineEmptyState({ ...machineBase, machineOptions: undefined, hasReport: false }),
    ).not.toBe("This line has no machines.");
  });

  it("reports a machine with no report for the period", () => {
    expect(machineEmptyState({ ...machineBase, hasReport: false })).toBe(
      "This machine has no report for the selected month.",
    );
  });

  // THE ONE THAT CATCHES THE PLACEHOLDER TRAP.
  it("refuses the confident negative until the list has settled", () => {
    expect(machineEmptyState({ ...machineBase, settled: false, hasReport: false })).toBeUndefined();
  });

  it("swaps the noun at year grain", () => {
    expect(machineEmptyState({ ...machineBase, hasReport: false, periodNoun: "year" })).toBe(
      "This machine has no report for the selected year.",
    );
  });
});

const lineBase = {
  lineCount: 2,
  workCenterId: 2 as number | undefined,
  settled: true,
  hasReport: true,
  periodNoun: "month" as const,
};

describe("lineEmptyState", () => {
  it("says nothing when there is a report to draw", () => {
    expect(lineEmptyState(lineBase)).toBeUndefined();
  });

  // TWO RUNGS, NOT THREE — a line screen resolves one level below the header's area
  // picker, where a machine screen resolves two.
  it("names the area's missing lines", () => {
    expect(lineEmptyState({ ...lineBase, lineCount: 0, workCenterId: undefined })).toBe(
      "This area has no lines.",
    );
  });

  it("reports a line with no report for the period", () => {
    expect(lineEmptyState({ ...lineBase, hasReport: false })).toBe(
      "This line has no report for the selected month.",
    );
  });

  it("refuses the confident negative until the list has settled", () => {
    expect(lineEmptyState({ ...lineBase, settled: false, hasReport: false })).toBeUndefined();
  });

  it("swaps the noun at year grain", () => {
    expect(lineEmptyState({ ...lineBase, hasReport: false, periodNoun: "year" })).toBe(
      "This line has no report for the selected year.",
    );
  });
});

const areaBase = {
  areaId: 3 as number | undefined,
  areasLoaded: true,
  settled: true,
  hasReport: true,
  periodNoun: "month" as const,
};

describe("areaEmptyState", () => {
  it("says nothing when there is a report to draw", () => {
    expect(areaEmptyState(areaBase)).toBeUndefined();
  });

  it("reports a plant with no areas at all", () => {
    expect(areaEmptyState({ ...areaBase, areaId: undefined })).toBe("There are no areas.");
  });

  // An undefined area BEFORE the catalogue lands is the header picker still
  // resolving, not an empty plant.
  it("is silent while the area catalogue is loading", () => {
    expect(areaEmptyState({ ...areaBase, areaId: undefined, areasLoaded: false })).toBeUndefined();
  });

  it("reports an area with no report for the period", () => {
    expect(areaEmptyState({ ...areaBase, hasReport: false })).toBe(
      "This area has no report for the selected month.",
    );
  });

  it("refuses the confident negative until the list has settled", () => {
    expect(areaEmptyState({ ...areaBase, settled: false, hasReport: false })).toBeUndefined();
  });

  it("swaps the noun at year grain", () => {
    expect(areaEmptyState({ ...areaBase, hasReport: false, periodNoun: "year" })).toBe(
      "This area has no report for the selected year.",
    );
  });
});
