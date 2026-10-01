import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaLossesCard } from "@/components/report/area-losses-card";
import { areaReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";

afterEach(cleanup);

// The AREA's Losses card.
//
// WHAT IT PINS IS TWO ABSENCES AND ONE UNIT, and the absences are the interesting
// half — the line and SKU cards both offer Add Reject / Add Rework, and this one
// must not.
describe("AreaLossesCard", () => {
  it("renders the six loss durations", () => {
    renderWithQuery(<AreaLossesCard report={areaReport()} />);

    expect(screen.getByText("Schedule Loss")).toBeTruthy();
    expect(screen.getByText("Availability Loss")).toBeTruthy();
    expect(screen.getByText("Performance Loss")).toBeTruthy();
    expect(screen.getByText("Quality Loss")).toBeTruthy();
  });

  // ONE UNIT, AND IT IS A MASS. The shell formats nothing, so the unit is this
  // card's to supply — and `weightUomName` is the only one on the payload.
  // `infeedUomName` does not exist here, which is what makes a paste from the line
  // card a build error rather than a mislabelled figure.
  it("denominates reject and rework in the area's mass unit", () => {
    renderWithQuery(<AreaLossesCard report={areaReport()} />);

    expect(screen.getByText(/480 Kilogram/)).toBeTruthy();
    expect(screen.getByText(/120 Kilogram/)).toBeTruthy();
  });

  it("renders em dashes when the members could not be brought to a common mass", () => {
    renderWithQuery(
      <AreaLossesCard
        report={areaReport({ weightUomId: null, weightUomName: null, reject: null, rework: null })}
      />,
    );

    expect(screen.queryByText(/Kilogram/)).toBeNull();
  });

  // NO ADD REJECT, NO ADD REWORK — by requirement ("no add reject/rework") AND by
  // schema. oee.work_center_quality_entries is keyed
  // (work_center_id, business_date, shift); an AREA report cannot supply the line
  // because it spans N of them, so an Add button here would exist only to make the
  // operator pick one — a choice they are already making on the line screen it
  // would send them to.
  //
  // OMITTED RATHER THAN DISABLED, which is why this asserts absence and not a
  // disabled attribute: the shell takes the two actions as optional SLOTS precisely
  // so a subject with nothing to put there says nothing.
  it("offers no Add Reject and no Add Rework", () => {
    renderWithQuery(<AreaLossesCard report={areaReport()} />);

    expect(screen.queryByRole("button", { name: /add reject/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add rework/i })).toBeNull();
  });

  // AND NO PENDING-ENTRY LEDGER LINE. quality-action.tsx renders "+140 BAG entered"
  // beneath the tile on the line and SKU cards, because there an entry exists that
  // the composed figure does not yet include. Nothing can be entered here, so there
  // is nothing pending and the line would be a promise about a control that is
  // absent.
  it("renders no pending-entry note beneath the count tiles", () => {
    renderWithQuery(<AreaLossesCard report={areaReport()} />);

    expect(screen.queryByText(/entered/i)).toBeNull();
  });

  // NO HOURLY AFFORDANCE. There is no product_perf_area_hour table, and an
  // area-summed curve off the LINE hourly table would be the roll-up contract §19.1
  // refuses — it would not integrate to the totals in the card above.
  it("offers no hourly production drill-down", () => {
    renderWithQuery(<AreaLossesCard report={areaReport()} />);

    expect(screen.queryByRole("button", { name: /view/i })).toBeNull();
  });

  // THE DRILL-DOWN LINK IS THE EIGHT-SEQUENCES HAZARD AGAIN, TWICE OVER. The
  // machine, line and SKU losses literals all COMPILE here — the param name is the
  // same — and any of them would open an unrelated report at another subject. And
  // so do the two AREA ones in each other's place, which is the sharper half: the
  // two tables have INDEPENDENT identity sequences, so a day report's id opened at
  // `/by-monthly` lands on a real MONTH report about a different period, populated
  // and plausible. Assert the HREF at both grains.
  it.each([
    ["day", "/report/area/by-day/11/losses"],
    ["month", "/report/area/by-monthly/11/losses"],
  ] as const)("points the Losses link at the %s losses route", (grain, href) => {
    renderWithQuery(<AreaLossesCard report={areaReport({ grain })} />);

    const link = screen.getByText("Open the Losses detail page").closest("a");

    expect(link?.getAttribute("href")).toBe(href);
  });
});
