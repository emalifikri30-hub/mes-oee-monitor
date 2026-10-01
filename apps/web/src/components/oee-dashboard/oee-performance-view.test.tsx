import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen, within } from "@testing-library/react";

import { DASHBOARD_PERIOD_COPY } from "@/lib/oee-dashboard/period-copy";
import { TREND_AXIS } from "@/lib/oee-dashboard/oee-performance";
import { OeePerformanceView } from "@/components/oee-dashboard/oee-performance-view";
import { renderWithQuery } from "@/test/render";

import type { DowntimeReasonBreakdown, RejectReasonBreakdown } from "@/lib/types";

// THE CARD WIRING, AND ONLY THE WIRING.
//
// Every card below has its own suite for its own states. What NOTHING else covers
// is which PAYLOAD reaches which card — and that is the failure this component was
// extracted to prevent, because it is completely invisible:
//
//   * Schedule Loss must draw the PLANNED breakdown, the same one the Six Big
//     Losses card is ranking. Hand it `unplanned` instead and you get a correct
//     Pareto of the wrong category, correctly labelled "Schedule Loss".
//   * Pareto Quality Losses must draw the REJECTS payload, for the same reason.
//
// Six route files each wiring this grid by hand would be six chances at that, with
// no test able to see it. The distinct fixtures below are what make the swap fail.

afterEach(cleanup);

function downtime(reason: string, durationMs: number): DowntimeReasonBreakdown {
  return {
    from: "",
    to: "",
    timeZone: "Asia/Jakarta",
    category: "PLANNED",
    buckets: [{ reason, durationMs, workUnitNames: [], frequency: 2 }],
    other: null,
    totalFrequency: 2,
    totalDurationMs: durationMs,
    loadedThrough: "2026-08-31",
  } as DowntimeReasonBreakdown;
}

const REJECTS = {
  timeZone: "Asia/Jakarta",
  buckets: [
    {
      reason: "REJECT_MARKER",
      durationMs: 900_000,
      frequency: 3,
      quantity: 12,
      machineName: null,
      uomCode: null,
      weightGram: null,
    },
  ],
  totalFrequency: 3,
  totalDurationMs: 900_000,
  totalQuantity: 12,
  totalWeightGram: null,
  loadedThrough: "2026-08-31",
} as unknown as RejectReasonBreakdown;

const MEASURES = {
  availabilityTime: 2_678_400_000,
  valueAddedTime: 1_800_000_000,
  scheduleLossTime: 300_000_000,
  availabilityLossTime: 400_000_000,
  performanceLossTime: 100_000_000,
  qualityLossTime: 78_400_000,
  reduceSpeedLossTime: 50_000_000,
};

const settled = <T,>(data: T) => ({ data, isPending: false, isError: false });

function setup(overrides: Partial<Parameters<typeof OeePerformanceView>[0]> = {}) {
  return renderWithQuery(
    <OeePerformanceView
      tiles={[{ label: "OEE", value: "67.2%" }]}
      measures={MEASURES}
      hasReport
      reportPending={false}
      reportBusinessDay="2026-08-01"
      timeZone="Asia/Jakarta"
      trend={settled({ items: [], timeZone: "Asia/Jakarta", loadedThrough: "2026-08-31" })}
      rejects={settled(REJECTS)}
      planned={settled(downtime("PLANNED_MARKER", 600_000))}
      unplanned={settled(downtime("UNPLANNED_MARKER", 700_000))}
      smallStop={settled(downtime("SMALLSTOP_MARKER", 800_000))}
      actions={settled(downtime("ACTION_MARKER", 500_000))}
      subjectLabel="Line"
      copy={DASHBOARD_PERIOD_COPY.month}
      axis={TREND_AXIS.month}
      qualityMachineName={null}
      {...overrides}
    />,
  );
}

// The card a title belongs to.
//
// SCOPED QUERIES ARE NOT OPTIONAL HERE: the two Pareto cards share their error and
// empty sentences word for word, so an unscoped `getByText` would match either and
// the swap this file exists to catch would pass.
function card(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const root = heading.closest("[data-slot='card']");
  if (root === null) throw new Error(`no card around "${title}"`);

  return root as HTMLElement;
}

const PARETO_ERROR = "This breakdown could not be loaded.";

describe("OeePerformanceView", () => {
  it("draws every card the dashboard is made of", async () => {
    setup();

    expect(await screen.findByText("OEE Summary")).toBeTruthy();
    expect(screen.getByText("Calendar Time")).toBeTruthy();
    expect(screen.getByText("OEE Losses")).toBeTruthy();
    expect(screen.getByText("Six Big Losses")).toBeTruthy();
    expect(screen.getByText("OEE Trend")).toBeTruthy();
    expect(screen.getByText("Pareto Actions")).toBeTruthy();
    expect(screen.getByText("Schedule Loss")).toBeTruthy();
    expect(screen.getByText("Pareto Quality Losses")).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE ASSERTIONS THIS FILE EXISTS FOR
  // ───────────────────────────────────────────────────────────────────────────
  //
  // FAILING ONE SOURCE AT A TIME is what makes the wiring observable. recharts
  // renders nothing measurable under happy-dom, so a bucket's label never reaches
  // the DOM and "did this payload arrive" cannot be asked directly — but WHICH
  // CARD goes into the error state answers the same question, and answers it
  // without depending on a chart rendering at all.
  it("gives Schedule Loss the PLANNED source", async () => {
    setup({ planned: { data: undefined, isPending: false, isError: true } });
    await screen.findByText("Schedule Loss");

    expect(within(card("Schedule Loss")).getByText(PARETO_ERROR)).toBeTruthy();
    // If Schedule Loss were wired to `unplanned` or `smallStop`, THIS is the
    // assertion that would fail: the error would have surfaced on the other card.
    expect(within(card("Pareto Actions")).queryByText(PARETO_ERROR)).toBeNull();
  });

  it("gives Pareto Actions the ACTION source", async () => {
    setup({ actions: { data: undefined, isPending: false, isError: true } });
    await screen.findByText("Pareto Actions");

    expect(within(card("Pareto Actions")).getByText(PARETO_ERROR)).toBeTruthy();
    expect(within(card("Schedule Loss")).queryByText(PARETO_ERROR)).toBeNull();
  });

  it("gives Pareto Quality Losses the REJECTS source", async () => {
    setup({ rejects: { data: undefined, isPending: false, isError: true } });
    await screen.findByText("Pareto Quality Losses");

    expect(
      within(card("Pareto Quality Losses")).getByText("The quality breakdown could not be loaded."),
    ).toBeTruthy();
    expect(within(card("Schedule Loss")).queryByText(PARETO_ERROR)).toBeNull();
  });

  // THE PERIOD NOUN REACHES THE TREND CARD. A year screen must not say "daily".
  it("passes the grain's own prose to the trend card", async () => {
    setup({
      trend: { data: undefined, isPending: false, isError: true },
      copy: DASHBOARD_PERIOD_COPY.year,
    });

    expect(await screen.findByText("The monthly trend could not be loaded.")).toBeTruthy();
    expect(screen.queryByText(/daily/i)).toBeNull();
  });

  // THE DONUTS ARE ARITHMETIC OVER THE REPORT ROW, so an absent report must render
  // them as pending rather than as two empty rings claiming a period of nothing.
  it("renders the donuts pending while there is no report", async () => {
    setup({ hasReport: false, measures: undefined });

    expect(await screen.findByText("Calendar Time")).toBeTruthy();
    expect(within(card("Calendar Time")).queryByRole("img")).toBeNull();
  });
});
