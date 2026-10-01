import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { periodReport, shiftReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { SummaryOeeCard } from "@/components/report/summary-oee-card";

// PINNING THE KPI ROW BEFORE IT TAKES A TILE LIST.
//
// The Line Overview card is this card with different tiles, so the plan
// generalises this one to accept them rather than shipping a second collapsible
// MetricTile grid. This file had no coverage, and every failure mode of that
// refactor is silent: a tile dropped, two tiles swapped, or — the expensive one —
// a COUNT rendered with the wrong unit.
//
// WHAT IS ASSERTED, AND WHY IT IS THE PAIRING RATHER THAN THE VALUE.
// `getByText("3416 BAG")` would pass with the figure under any label. These tests
// resolve the LABEL and then read the value beside it, so a tile that keeps its
// number and loses its meaning fails. That distinction is not academic here: the
// Line grain has TWO units on one row (migration 0014 — infeed bags in, output
// cartons out), and the whole reason this card is being generalised rather than
// copied is so one implementation carries the unit per tile.
function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  const value = labelEl.nextElementSibling;
  if (!value) throw new Error(`tile "${label}" has no value element`);
  return value.textContent ?? "";
}

afterEach(cleanup);

describe("SummaryOeeCard", () => {
  it("renders the five rates as percentages", () => {
    renderWithQuery(
      <SummaryOeeCard
        report={shiftReport({
          teep: 40,
          oee: 62.5,
          availability: 80,
          performance: 85.125,
          quality: 91,
        })}
      />,
    );

    expect(tileValue("TEEP")).toBe("40%");
    expect(tileValue("OEE")).toBe("62.5%");
    expect(tileValue("A")).toBe("80%");
    expect(tileValue("P")).toBe("85.125%");
    expect(tileValue("Q")).toBe("91%");
  });

  // The production tile is NAMED after the machine, which is exactly the tile the
  // Line card renames after the line. Pinned so the generalisation cannot quietly
  // turn it into a static label.
  it("names the production tile after the work unit", () => {
    renderWithQuery(
      <SummaryOeeCard report={shiftReport({ workUnitName: "Vertical Packer MJCL" })} />,
    );

    expect(tileValue("Vertical Packer MJCL Production")).toBe("3416 BAG");
  });

  it("falls back to a bare label when the work unit has no name", () => {
    renderWithQuery(<SummaryOeeCard report={shiftReport({ workUnitName: null })} />);

    expect(screen.getByText("Production")).toBeTruthy();
  });

  // THE UNIT PAIRING. All three counts share one uom at machine grain — which is
  // precisely the assumption that does NOT hold for a line, so this pins the
  // machine behaviour before the shared component learns to carry two.
  it("renders every count in the report's unit", () => {
    renderWithQuery(
      <SummaryOeeCard
        report={shiftReport({ totalOut: 3416, goodOut: 3200, effectiveOut: 3100, uomName: "BAG" })}
      />,
    );

    expect(tileValue("Vertical Packer MJCL Production")).toBe("3416 BAG");
    expect(tileValue("Finish Good")).toBe("3200 BAG");
    expect(tileValue("Effective Prod.")).toBe("3100 BAG");
  });

  it("omits the unit rather than printing null when the uom is unknown", () => {
    renderWithQuery(<SummaryOeeCard report={shiftReport({ uomName: null, goodOut: 3200 })} />);

    expect(tileValue("Finish Good")).toBe("3200");
  });

  it("renders run time as a duration, not a number", () => {
    renderWithQuery(<SummaryOeeCard report={shiftReport({ runtime: 28_800_000 })} />);

    expect(tileValue("Run Time")).toBe("08 h 00 m 00 s");
  });

  // Nullable measures reach this card at the coarse grains too, and an em dash is
  // the contract: a 0 would be a measurement where "unknown" is the truth.
  it("renders an em dash for a measure the pipeline has not computed", () => {
    renderWithQuery(
      <SummaryOeeCard report={periodReport({ effectiveOut: null as unknown as number })} />,
    );

    expect(tileValue("Effective Prod.")).toBe("—");
  });

  it("renders a period report with no shift-specific tile", () => {
    renderWithQuery(<SummaryOeeCard report={periodReport()} />);

    expect(screen.getByText("Summary OEE")).toBeTruthy();
    expect(screen.queryByText("Shift")).toBeNull();
  });

  // Open by default: the numbers are the point of the screen, and a collapsed
  // KPI row on load would hide them behind a click.
  it("starts expanded and offers a collapse control", () => {
    renderWithQuery(<SummaryOeeCard report={shiftReport()} />);

    expect(screen.getByLabelText("Collapse summary")).toBeTruthy();
    expect(screen.getByText("TEEP")).toBeTruthy();
  });
});
