import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { SkuOverviewCard } from "@/components/report/sku-overview-card";
import { skuReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";

afterEach(cleanup);

// The same helper line-overview-card.test.tsx uses — the value is the label's next
// sibling, not a descendant of a shared parent.
function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  const value = labelEl.nextElementSibling;
  if (!value) throw new Error(`tile "${label}" has no value element`);
  return value.textContent ?? "";
}

// WHAT THIS CARD CAN GET WRONG IS A UNIT, NOT A NUMBER.
//
// A SKU inherits its line's two count points: `totalOut` is in the INFEED unit and
// `goodOut` in the OUTPUT one, and `totalOut = goodOut + reject + rework` is FALSE
// by construction (0023, contract §16.4a). Every assertion below therefore pins the
// figure AND the unit beside it — a card that read one `uom` local into every tile
// would pass any test that only checked the numbers, while rendering cartons under
// a bag label.
describe("SkuOverviewCard", () => {
  it("labels the infeed tiles with the infeed unit", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport()} />);

    expect(tileValue("Total Production")).toContain("Bag");
    expect(tileValue("Reject")).toContain("Bag");
    expect(tileValue("Rework")).toContain("Bag");
  });

  it("labels the output tiles with the output unit", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport()} />);

    expect(tileValue("Finish Good")).toContain("Carton");
    expect(tileValue("Effective Production")).toContain("Carton");
  });

  // The two sides are adjacent on screen and in DIFFERENT units. Reading down the
  // column without them would suggest 300 rejects against 1905 finished goods.
  it("does not render the two sides in the same unit", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport()} />);

    expect(tileValue("Reject")).not.toContain("Carton");
    expect(tileValue("Finish Good")).not.toContain("Bag");
  });

  // A SKU report is one of SEVERAL for the same date, one per line. The line has
  // to be identifiable on the card, and by CODE as well as name because
  // work_center_name is not unique (TODOS.md §77).
  it("names the line by name and code", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport()} />);

    expect(tileValue("Line")).toBe("Line 2 · FI2-L2");
  });

  it("falls back to the name alone when the line has no code", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport({ workCenterCode: null })} />);

    expect(tileValue("Line")).toBe("Line 2");
  });

  // TEEP divides by CALENDAR time, which a SKU does not own — the line does, and
  // shares it. There is no denominator anybody could name, so 0023 has no column
  // and this card must have no tile.
  it("renders no TEEP tile", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport()} />);

    expect(screen.queryByText("TEEP")).toBeNull();
  });

  // Achievement has no column behind it on any screen. The muted styling is the
  // only thing separating it from a measurement — see lib/achievement.ts.
  it("renders Achievement as the shared placeholder", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport()} />);

    expect(tileValue("Achievement")).toBe("0%");
  });

  // 0/0 is real for a SKU whose whole run sat in planned downtime. A fabricated 0%
  // would be a measurement where null is the truth.
  it("renders an em dash for a null rate, never a zero", () => {
    renderWithQuery(<SkuOverviewCard report={skuReport({ oee: null, availability: null })} />);

    expect(tileValue("OEE")).not.toBe("0%");
    expect(tileValue("A")).not.toBe("0%");
  });
});
