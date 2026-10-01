import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { lineReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { LineOverviewCard } from "@/components/report/line-overview-card";

// WHICH FIGURE SITS UNDER WHICH LABEL, AND IN WHICH UNIT.
//
// This card is the one place in the app where two different units appear on the
// same row of tiles, and that is not a styling detail — migration 0014 puts
// `total_out` in the line's INFEED unit (bags in) and `effective_out` in its
// OUTPUT unit (cartons out), and contract §16.4a settled that split with the
// pipeline owner. So `totalOut = goodOut + reject + rework` is FALSE here by
// construction, and a card that read one `uomName` into a local would render
// cartons under a bag label — a wrong number that looks completely ordinary.
//
// `getByText("70811 BAG")` would pass with that figure under ANY label, so every
// assertion below resolves the LABEL and reads the value beside it. The last three
// commits on main were all corrections of exactly this class (74d8f19 "a line has
// two units, not one"; 8613bc6 "effective_out is output-side"), which is why the
// pairing is asserted rather than reviewed.
function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  const value = labelEl.nextElementSibling;
  if (!value) throw new Error(`tile "${label}" has no value element`);
  return value.textContent ?? "";
}

afterEach(cleanup);

describe("LineOverviewCard", () => {
  it("renders the four rates as percentages", () => {
    renderWithQuery(
      <LineOverviewCard
        report={lineReport({ oee: 71.63, availability: 100, performance: 72.613, quality: 98.646 })}
      />,
    );

    expect(tileValue("OEE")).toBe("71.63%");
    expect(tileValue("A")).toBe("100%");
    expect(tileValue("P")).toBe("72.613%");
    expect(tileValue("Q")).toBe("98.646%");
  });

  // NO TEEP TILE, unlike the machine card. The reference design's Line Overview
  // does not carry it, and the column exists — so its absence is the design's
  // decision rendered rather than a missing field.
  it("has no TEEP tile", () => {
    renderWithQuery(<LineOverviewCard report={lineReport()} />);

    expect(screen.queryByText("TEEP")).toBeNull();
  });

  it("names the production tile after the line", () => {
    renderWithQuery(
      <LineOverviewCard report={lineReport({ workCenterName: "Molca Line 8", lineOut: 64818 })} />,
    );

    expect(tileValue("Molca Line 8 Production")).toBe("64818 BAG");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE UNIT PAIRING. The whole point of this file.
  // ───────────────────────────────────────────────────────────────────────────
  it("renders the infeed counts in the infeed unit", () => {
    renderWithQuery(<LineOverviewCard report={lineReport()} />);

    expect(tileValue("Molca Line 8 Production")).toBe("64818 BAG");
    expect(tileValue("Total Production")).toBe("70811 BAG");
    expect(tileValue("Reject")).toBe("5000 BAG");
    expect(tileValue("Rework")).toBe("993 BAG");
  });

  it("renders the output counts in the OUTPUT unit, not the infeed one", () => {
    renderWithQuery(<LineOverviewCard report={lineReport()} />);

    expect(tileValue("Effective Production")).toBe("79821.3 CARTON");
    expect(tileValue("Finish Good")).toBe("789 CARTON");
  });

  // The two sides come from independent columns, so a line can be certain about
  // what it consumed and abstain about what it shipped — or the reverse. Each
  // guard is separate in the schema (ck_wcsr_infeed_units / ck_wcsr_output_units)
  // and the card must not let one side's abstention blank the other.
  it("keeps one side when the other abstains", () => {
    renderWithQuery(
      <LineOverviewCard
        report={lineReport({
          outputUomName: null,
          goodOut: null,
          effectiveOut: null,
        })}
      />,
    );

    expect(tileValue("Total Production")).toBe("70811 BAG");
    expect(tileValue("Finish Good")).toBe("—");
    expect(tileValue("Effective Production")).toBe("—");
  });

  // A NULL COUNT IS "THE MEMBERS DISAGREED", never zero. 0/0 is real at this grain
  // — a line whose machines were all in planned downtime — and a fabricated 0
  // would be a measurement where NULL is the truth.
  it("renders an em dash for every abstaining measure, never a zero", () => {
    renderWithQuery(
      <LineOverviewCard
        report={lineReport({
          oee: null,
          availability: null,
          performance: null,
          quality: null,
          totalOut: null,
          lineOut: null,
          reject: null,
          rework: null,
          goodOut: null,
          effectiveOut: null,
          infeedUomName: null,
          outputUomName: null,
        })}
      />,
    );

    for (const label of [
      "OEE",
      "A",
      "P",
      "Q",
      "Total Production",
      "Reject",
      "Rework",
      "Finish Good",
      "Effective Production",
    ]) {
      expect(tileValue(label), `${label} should abstain`).toBe("—");
    }
  });

  // `lineOut` ships nullable with nothing writing it until the Airflow DAG lands
  // (migration 0015, contract §16), so this is the state on screen TODAY.
  it("renders an em dash for line_out until the pipeline writes it", () => {
    renderWithQuery(<LineOverviewCard report={lineReport({ lineOut: null })} />);

    expect(tileValue("Molca Line 8 Production")).toBe("—");
    // And it must not drag the other infeed figures down with it — they are
    // separate columns.
    expect(tileValue("Total Production")).toBe("70811 BAG");
  });

  it("renders run time as a duration", () => {
    renderWithQuery(<LineOverviewCard report={lineReport({ runtime: 73_681_000 })} />);

    expect(tileValue("Run Time")).toBe("20 h 28 m 01 s");
  });

  // A LITERAL 0%, per the reference design's "default to 0". There is no target
  // column anywhere in Gold, so nothing computes this — the muted class is the only
  // thing distinguishing it from a measured figure, and the tile is pinned here so
  // a future target column has to change the test as well as the code.
  it("renders Achievement as a placeholder zero", () => {
    renderWithQuery(<LineOverviewCard report={lineReport()} />);

    expect(tileValue("Achievement")).toBe("0%");
  });

  it("renders at the coarse grains too", () => {
    renderWithQuery(<LineOverviewCard report={lineReport({ grain: "month", shift: null })} />);

    expect(screen.getByText("Line Overview")).toBeTruthy();
    expect(tileValue("Total Production")).toBe("70811 BAG");
  });
});
