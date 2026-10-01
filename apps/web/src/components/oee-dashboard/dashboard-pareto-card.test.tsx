import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { DashboardParetoCard } from "@/components/oee-dashboard/dashboard-pareto-card";
import { QualityLossesCard } from "@/components/oee-dashboard/quality-losses-card";
import { renderWithQuery } from "@/test/render";

import type { DowntimeReasonBreakdown, RejectReasonBreakdown } from "@/lib/types";

// The ranking is tested as a function in lib/pareto.ts. These cover the thing a
// pure function cannot reach — WHICH STATE the card selects — and in particular
// the one split that is a claim about the plant rather than about the UI.

afterEach(cleanup);

const APPEARANCE = { bandVar: "var(--color-oee-anomaly)", stopsLabel: "Stops actioned" };

function breakdown(
  buckets: { reason: string | null; durationMs: number }[],
  loadedThrough: string | null = "2026-08-31",
): DowntimeReasonBreakdown {
  return {
    from: "",
    to: "",
    timeZone: "Asia/Jakarta",
    category: "PLANNED",
    buckets: buckets.map((b) => ({ ...b, workUnitNames: [], frequency: 2 })),
    other: null,
    totalFrequency: 2,
    totalDurationMs: buckets.reduce((sum, b) => sum + b.durationMs, 0),
    loadedThrough,
  } as DowntimeReasonBreakdown;
}

function setup(overrides: Partial<Parameters<typeof DashboardParetoCard>[0]> = {}) {
  return renderWithQuery(
    <DashboardParetoCard
      title="Pareto Actions"
      breakdown={breakdown([{ reason: "Clear jam", durationMs: 600_000 }])}
      appearance={APPEARANCE}
      isPending={false}
      isError={false}
      hasParams
      reportBusinessDay="2026-08-01"
      {...overrides}
    />,
  );
}

describe("DashboardParetoCard", () => {
  it("renders its title once the breakdown has loaded", async () => {
    setup();

    expect(await screen.findByText("Pareto Actions")).toBeTruthy();
    expect(screen.queryByText(/have not been loaded/i)).toBeNull();
  });

  // `hasParams` FIRST. This query is gated until the report resolves, and a gated
  // useQuery reports pending FOREVER — a ladder reading isPending first renders a
  // skeleton that never clears.
  it("shows a skeleton, not an empty state, while there is no report yet", () => {
    const { container } = setup({ hasParams: false, breakdown: undefined, isPending: true });

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Nothing was recorded/i)).toBeNull();
  });

  it("names a failure rather than drawing an empty chart", () => {
    setup({ breakdown: undefined, isError: true });

    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  // THE SPLIT THAT MATTERS, and the flattering reading is the wrong one: a month
  // the pipeline has not reached must not render as a month with no stops.
  it("distinguishes a month not yet loaded from a month with nothing recorded", () => {
    setup({ breakdown: breakdown([], "2026-07-31"), reportBusinessDay: "2026-08-01" });

    expect(screen.getByText(/have not been loaded yet/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing was recorded/i)).toBeNull();
  });

  it("says a loaded month genuinely recorded nothing", () => {
    setup({ breakdown: breakdown([], "2026-08-31"), reportBusinessDay: "2026-08-01" });

    expect(screen.getByText(/Nothing was recorded/i)).toBeTruthy();
  });

  // Pareto Actions counts only a stop's FIRST action, so a second action recorded
  // on a stop contributes nothing. That is a caveat about the data, and it has to
  // be on the chart rather than in a comment nobody reads.
  it("renders the footnote when one is supplied, and nothing when not", () => {
    setup({ footnote: "Counted against each stop's first action." });
    expect(screen.getByText(/first action/i)).toBeTruthy();

    cleanup();
    setup();
    expect(screen.queryByText(/first action/i)).toBeNull();
  });
});

const REJECTS = {
  timeZone: "Asia/Jakarta",
  buckets: [
    {
      reason: "Seal_Leak",
      reasonCode: null,
      machineName: null,
      counterValue: 10,
      counterUnit: "BAG",
      quantity: 10,
      convertedUnit: "BAG",
      weightGram: null,
      frequency: 2,
      durationMs: 680_000,
    },
  ],
  totalFrequency: 2,
  totalDurationMs: 680_000,
  totalQuantity: 10,
  totalWeightGram: null,
  convertedUnit: "BAG",
  loadedThrough: "2026-08-31",
} as RejectReasonBreakdown;

describe("QualityLossesCard", () => {
  function quality(overrides: Partial<Parameters<typeof QualityLossesCard>[0]> = {}) {
    return renderWithQuery(
      <QualityLossesCard
        breakdown={REJECTS}
        isPending={false}
        isError={false}
        hasParams
        reportBusinessDay="2026-08-01"
        machineName="Vertical Packer N"
        {...overrides}
      />,
    );
  }

  it("renders once the counters have loaded", async () => {
    quality();

    expect(await screen.findByText("Pareto Quality Losses")).toBeTruthy();
  });

  it("shows a skeleton while there is no report yet", () => {
    const { container } = quality({ hasParams: false, breakdown: undefined, isPending: true });

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  // The reject tables ship EMPTY until the pipeline writes them, so this is the
  // state the screen is actually in today on most rows — it must not read as a
  // month with no rejects.
  it("distinguishes unloaded counters from a month with no rejects", () => {
    quality({
      breakdown: { ...REJECTS, buckets: [], loadedThrough: "2026-07-31" },
      reportBusinessDay: "2026-08-01",
    });

    expect(screen.getByText(/have not been loaded yet/i)).toBeTruthy();
  });

  it("says a loaded month genuinely recorded no rejects", () => {
    quality({ breakdown: { ...REJECTS, buckets: [] }, reportBusinessDay: "2026-08-01" });

    expect(screen.getByText(/No rejects were recorded/i)).toBeTruthy();
  });
});
