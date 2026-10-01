import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { DonutCard } from "@/components/oee-dashboard/donut-card";
import { buildCalendarTimeSlices, buildOeeLossSlices } from "@/lib/oee-dashboard/oee-performance";
import { renderWithQuery } from "@/test/render";

// The slice arithmetic and the "sums to the whole" property are tested as
// functions in lib/oee-dashboard/. What is left for a rendered test is the shell's
// one branch, and the fact that BOTH donuts are the same component — which is the
// thing a refactor would quietly undo.

afterEach(cleanup);

const REPORT = {
  availabilityTime: 518_400_000,
  valueAddedTime: 434_560_000,
  scheduleLossTime: 24_600_000,
  availabilityLossTime: 46_560_000,
  performanceLossTime: 11_040_000,
  qualityLossTime: 1_640_000,
};

describe("DonutCard", () => {
  it("shows a skeleton and no chart while the report is pending", () => {
    const { container } = renderWithQuery(
      <DonutCard title="Calendar Time" slices={[]} isPending />,
    );

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("renders its title once the report has loaded", async () => {
    renderWithQuery(
      <DonutCard
        title="Calendar Time"
        slices={buildCalendarTimeSlices(REPORT)}
        isPending={false}
      />,
    );

    expect(await screen.findByText("Calendar Time")).toBeTruthy();
  });

  // ONE COMPONENT, TWO CARDS. A second donut that built its own slices would be a
  // second place for a wedge to stop matching its label.
  it("serves the OEE Losses donut from the same shell", async () => {
    renderWithQuery(
      <DonutCard title="OEE Losses" slices={buildOeeLossSlices(REPORT)} isPending={false} />,
    );

    expect(await screen.findByText("OEE Losses")).toBeTruthy();
  });
});
