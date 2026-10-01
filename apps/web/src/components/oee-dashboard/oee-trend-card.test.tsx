import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { renderWithQuery } from "@/test/render";
import { OeeTrendCard } from "@/components/oee-dashboard/oee-trend-card";

import type { MonthOeeTrend } from "@/lib/types";

// The gap rule itself is tested as a function in lib/oee-dashboard/. This file
// covers the six-state ladder — and specifically the one split that is a claim
// about the plant rather than about the UI: an empty month the pipeline has NOT
// reached must not render as a month with nothing to report.

afterEach(cleanup);

const trend = (items: MonthOeeTrend["items"], loadedThrough: string | null): MonthOeeTrend => ({
  items,
  timeZone: "Asia/Jakarta",
  loadedThrough,
});

function setup(overrides: Partial<Parameters<typeof OeeTrendCard>[0]> = {}) {
  return renderWithQuery(
    <OeeTrendCard
      trend={trend(
        [{ businessDate: "2026-08-01", oee: 88, availability: 90, performance: 97, quality: 99 }],
        "2026-08-31",
      )}
      isPending={false}
      isError={false}
      hasReport
      reportBusinessDay="2026-08-01"
      copy={DASHBOARD_PERIOD_COPY.month}
      axis={TREND_AXIS.month}
      {...overrides}
    />,
  );
}

describe("OeeTrendCard", () => {
  it("renders the chart once the series has loaded", async () => {
    setup();

    expect(await screen.findByText("OEE Trend")).toBeTruthy();
    expect(screen.queryByText(/have not been loaded/i)).toBeNull();
  });

  // `hasParams` FIRST. This query is gated until a report id exists, and a gated
  // useQuery reports pending forever — a ladder reading isPending first would
  // render a skeleton that never clears.
  it("shows a skeleton, not an empty state, while there is no report yet", () => {
    const { container } = setup({ hasReport: false, trend: undefined, isPending: true });

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/No daily figures/i)).toBeNull();
  });

  it("names a failure rather than drawing an empty chart", () => {
    setup({ trend: undefined, isError: true });

    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  // THE SPLIT THAT MATTERS, and the flattering reading is the wrong one.
  it("distinguishes a month the pipeline has not reached from a month with no figures", () => {
    setup({ trend: trend([], "2026-07-31"), reportBusinessDay: "2026-08-01" });

    expect(screen.getByText(/have not been loaded yet/i)).toBeTruthy();
    expect(screen.queryByText(/No daily figures were recorded/i)).toBeNull();
  });

  it("says a loaded month genuinely recorded nothing", () => {
    setup({ trend: trend([], "2026-08-31"), reportBusinessDay: "2026-08-01" });

    expect(screen.getByText(/No daily figures were recorded/i)).toBeTruthy();
  });
});
