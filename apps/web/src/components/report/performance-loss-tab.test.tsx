import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { shiftReport } from "@/test/fixtures";
import { PerformanceLossTab } from "@/components/report/performance-loss-tab";

import type { DowntimeReasonBreakdown, ShiftPerformance } from "@/lib/types";

// WHAT THIS TAB CLAIMS is the thing under test, not its arithmetic.
//
// Performance Loss is Small Stop PLUS Reduce Speed, and only the first half is
// rankable. Every assertion below is about the tab not overstating what it
// knows: that the second half is named rather than omitted, that its number is
// shown as-is when negative, and that selecting a view does not quietly fetch
// the other one's payload.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getDowntimeReasons: vi.fn(),
  getShiftReportPerformance: vi.fn(),
}));

const { getDowntimeReasons, getShiftReportPerformance } = await import("@/lib/api");
const reasons = vi.mocked(getDowntimeReasons);
const performance = vi.mocked(getShiftReportPerformance);

const MINUTE = 60_000;

function breakdown(): DowntimeReasonBreakdown {
  return {
    from: "2026-08-09T00:00:00.000Z",
    to: "2026-08-09T08:00:00.000Z",
    timeZone: "Asia/Jakarta",
    category: "SMALL_STOP",
    buckets: [
      {
        reason: "Machine_Stop",
        workUnitNames: ["Packer Molca JCL"],
        frequency: 31,
        durationMs: 46 * MINUTE,
      },
    ],
    // No tail: these fixtures return every bucket.
    other: null,
    totalFrequency: 31,
    totalDurationMs: 46 * MINUTE,
    loadedThrough: "2026-08-10",
  };
}

// No buckets: this suite is about the frame, and buildHourlyOutput's own
// arithmetic is pinned in lib/perf-hourly.test.ts.
function shiftPerformance(): ShiftPerformance {
  return { buckets: [], timeZone: "Asia/Jakarta", loadedThrough: "2026-08-10" };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PerformanceLossTab", () => {
  it("ranks the small stops and asks for that category alone", async () => {
    reasons.mockResolvedValue(breakdown());

    renderWithQuery(
      <PerformanceLossTab
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        view="pareto"
        onViewChange={() => {}}
      />,
    );

    expect(await screen.findByText("Machine_Stop")).toBeTruthy();
    expect(reasons).toHaveBeenCalledWith(expect.objectContaining({ category: "SMALL_STOP" }));
  });

  // THE HALF THAT CANNOT BE RANKED, and the reason this tab is not just a second
  // Pareto. Omitting Reduce Speed would let the Small Stop ranking read as the
  // whole of Performance Loss.
  it("names Reduce Speed and says why it has no ranking", async () => {
    reasons.mockResolvedValue(breakdown());

    renderWithQuery(
      <PerformanceLossTab
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        view="pareto"
        onViewChange={() => {}}
      />,
    );

    expect(await screen.findByRole("button", { name: "Reduce Speed" })).toBeTruthy();
    expect(screen.getByText(/no per-cause records exist for reduce-speed loss/i)).toBeTruthy();
  });

  // Reduce-speed loss goes below zero when the machine outran its standard rate.
  // That is real data, and the fixture's own figure is negative for this reason —
  // clamping it here would be the flattering lie losses-card.tsx already refuses.
  it("shows a negative Reduce Speed total as-is", async () => {
    reasons.mockResolvedValue(breakdown());

    renderWithQuery(
      <PerformanceLossTab
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport({ reduceSpeedLossTime: -107_000 })}
        view="pareto"
        onViewChange={() => {}}
      />,
    );

    expect(await screen.findByText("-01 m 47 s")).toBeTruthy();
  });

  // The Pareto view must not pay for the Trendline's payload. `isActive` gates
  // that query exactly as `open` gates the dialog's; without it, landing on this
  // tab would fetch two unrelated responses to show one.
  it("does not fetch the hourly profile until the Trendline view is selected", async () => {
    reasons.mockResolvedValue(breakdown());
    performance.mockResolvedValue(shiftPerformance());

    const { rerender } = renderWithQuery(
      <PerformanceLossTab
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        view="pareto"
        onViewChange={() => {}}
      />,
    );

    await screen.findByText("Machine_Stop");
    expect(performance).not.toHaveBeenCalled();

    rerender(
      <PerformanceLossTab
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        view="trendline"
        onViewChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(performance).toHaveBeenCalledTimes(1);
    });
  });

  // The sub-tab is page identity, so it is reported upward to the route rather
  // than held here — a shared link has to reopen the same chart.
  it("reports a view change rather than owning it", async () => {
    reasons.mockResolvedValue(breakdown());
    const onViewChange = vi.fn();

    renderWithQuery(
      <PerformanceLossTab
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        view="pareto"
        onViewChange={onViewChange}
      />,
    );

    // mouseDown, not click(): Radix activates a tab on pointer-down, so
    // HTMLElement.click() — which dispatches only a click event — does nothing.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Trendline" }));

    await waitFor(() => {
      expect(onViewChange).toHaveBeenCalledWith("trendline");
    });
  });
});
