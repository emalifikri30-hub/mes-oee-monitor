import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaOverviewCard, RUNTIME_HINT } from "@/components/report/area-overview-card";
import { areaReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";

afterEach(cleanup);

// The same helper the line and SKU overview suites use — the value is the label's
// next sibling, not a descendant of a shared parent.
//
// EXCEPT WHERE THE LABEL HAS A HINT. Run Time's label sits in a flex row beside an
// info-icon button, so `nextElementSibling` finds the BUTTON — which is not null,
// and whose textContent is "" because it holds only an svg. Falling back on `??`
// therefore never fires. The helper walks up one level when the sibling it found
// carries no text, which keeps every assertion below reading the same way and keeps
// the failure mode loud: a genuinely empty tile still throws.
function tileValue(label: string): string {
  const labelEl = screen.getByText(label);

  const withText = (el: Element | null | undefined): string | null => {
    const text = el?.textContent ?? "";
    return text === "" ? null : text;
  };

  const value =
    withText(labelEl.nextElementSibling) ?? withText(labelEl.parentElement?.nextElementSibling);
  if (value === null) throw new Error(`tile "${label}" has no value element`);
  return value;
}

// `renderWithQuery` RATHER THAN A BARE `render`, unlike the SKU overview suite's.
// This card carries a tooltip on Run Time, and a tooltip rendered outside
// TooltipProvider throws "`Tooltip` must be used within `TooltipProvider`" — as a
// CAUGHT React error that leaves the test green with a stack trace in the output.
// test/render.tsx exists for exactly that.

// ---------------------------------------------------------------------------
// WHAT THIS CARD CAN GET WRONG, AND IT IS THE OPPOSITE OF THE LINE CARD'S RISK
// ---------------------------------------------------------------------------
//
// The line and SKU cards risk a WRONG UNIT: two count points, two units, and a
// single `uom` local renders cartons under a bag label. An area has ONE unit, so
// that risk is gone — and two new ones take its place:
//
//   1. THE WRONG UNIT FIELD. `infeedUomName` does not exist on this payload, so a
//      paste from the line card is a build error rather than a mislabel. What a
//      paste CAN do is silently drop the unit — `formatQuantity(x, null)` renders a
//      bare number — so every count assertion below pins the unit's presence.
//   2. A "CORRECTED" RUN TIME. An area's durations are LINE-hours, so a multi-line
//      day reads above 24 h. That looks like a bug, and the obvious fix — divide by
//      the line count — would make every figure wrong. The fixture's runtime is
//      33.89 h for exactly this assertion.
describe("AreaOverviewCard", () => {
  it("labels every production figure with the area's single mass unit", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(tileValue("Filling 2 Production")).toContain("Kilogram");
    expect(tileValue("Total Production")).toContain("Kilogram");
    expect(tileValue("Finish Good")).toContain("Kilogram");
    expect(tileValue("Reject")).toContain("Kilogram");
    expect(tileValue("Rework")).toContain("Kilogram");
  });

  // The tile named after the AREA, exactly as the line card names one after the
  // line. It reads `areaOut` — the member lines' own measured production — and NOT
  // `totalOut`, which is what those lines consumed. Two different questions.
  it("names the area's own production tile after the area and reads areaOut", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(tileValue("Filling 2 Production")).toContain("23400");
    expect(tileValue("Total Production")).toContain("24000");
  });

  // LINE-HOURS, NOT WALL-CLOCK HOURS. 122,000,000 ms is 33 h 53 m 20 s, and it must
  // render as that rather than being folded back under 24.
  it("renders a runtime above 24 hours unchanged", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(tileValue("Run Time")).toBe("33 h 53 m 20 s");
  });

  // AND SAYS WHY ON SCREEN. Every other subject's Run Time is bounded by its own
  // wall clock, so this is the one tile in the app whose correct value looks like a
  // defect — the note is what stops it being reported as one.
  it("explains the runtime with a hint on the tile", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(screen.getByLabelText("About Run Time")).toBeTruthy();
  });

  // AT MONTH GRAIN THE MAGNITUDE IS ~30x LARGER, so the note has to say so.
  //
  // ASSERTED ON THE VALUE, NOT ON THE DOM, and that is not a shortcut: a Radix
  // TooltipContent is not in the document while closed, so `getByText` cannot
  // reach either sentence. Which sentence is chosen is a pure decision and
  // RUNTIME_HINT is where it lives — the trigger's presence is what the component
  // test covers, one case up.
  it("scales the runtime note to the grain", () => {
    expect(RUNTIME_HINT.day).toMatch(/multi-line day exceeds 24 hours/);
    expect(RUNTIME_HINT.month).toMatch(/every day of the month/);
    // Both say the thing a reader most needs: that there is no clock to divide by.
    expect(RUNTIME_HINT.day).toMatch(/no clock of its own/);
    expect(RUNTIME_HINT.month).toMatch(/no clock of its own/);
    // And they are not the same sentence, which is the regression this guards.
    expect(RUNTIME_HINT.day).not.toBe(RUNTIME_HINT.month);
  });

  // THE TILE READS THE MAP RATHER THAN A LITERAL, so a grain that lost its note
  // would render `undefined` and lose the icon. Pinned at both grains.
  it.each(["day", "month"] as const)("keeps the runtime hint at %s grain", (grain) => {
    renderWithQuery(<AreaOverviewCard report={areaReport({ grain })} />);

    expect(screen.getByLabelText("About Run Time")).toBeTruthy();
  });

  // NO SECOND UNIT ANYWHERE. A paste from the line card would bring an
  // "Effective Production" tile with it, and 0024 has no column for one.
  it("renders no Effective Production tile", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(screen.queryByText("Effective Production")).toBeNull();
  });

  // TEEP divides by CALENDAR time, and an area owns no calendar a reader could
  // name — is it 24 hours, or 24 times the line count? 0024 has no column.
  it("renders no TEEP tile", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(screen.queryByText("TEEP")).toBeNull();
  });

  // Achievement has no column behind it on any screen. The muted styling is the
  // only thing separating it from a measurement — see lib/achievement.ts.
  it("renders Achievement as the shared placeholder", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport()} />);

    expect(tileValue("Achievement")).toBe("0%");
  });

  // 0/0 is real for an area whose every line sat in planned downtime. A fabricated
  // 0% would be a measurement where null is the truth.
  it("renders an em dash for a null rate, never a zero", () => {
    renderWithQuery(<AreaOverviewCard report={areaReport({ oee: null, availability: null })} />);

    expect(tileValue("OEE")).not.toBe("0%");
    expect(tileValue("A")).not.toBe("0%");
  });

  // A NULL MASS UNIT NULLS ITS COUNTS, by 0024's CHECK — and here the null means
  // something neither the line's nor the SKU's does: the pipeline could not bring
  // the members to a common mass, typically because a product that ran has no
  // std_weight in master data. An em dash claims nothing, which is right; a 0 would
  // claim the area produced nothing.
  it("renders em dashes when the members could not be brought to a common mass", () => {
    renderWithQuery(
      <AreaOverviewCard
        report={areaReport({
          weightUomId: null,
          weightUomName: null,
          weightUomCode: null,
          totalOut: null,
          areaOut: null,
          goodOut: null,
          reject: null,
          rework: null,
        })}
      />,
    );

    expect(tileValue("Total Production")).not.toContain("0");
    expect(tileValue("Finish Good")).not.toContain("0");
    // And no unit is printed beside an absent figure.
    expect(tileValue("Reject")).not.toContain("Kilogram");
  });
});
