import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { shiftReport } from "@/test/fixtures";
import { QualityLossTab } from "@/components/report/quality-loss-tab";

import type { RejectReasonBreakdown } from "@/lib/types";

// WHAT THIS TAB CLAIMS is the thing under test, not its arithmetic — that lives
// in lib/quality-pareto.test.ts, per the split vite.config.ts states.
//
// Two claims are specific to this screen and are the reason most of these
// assertions exist:
//
//   1. THE COUNTER COLUMN AND THE CONVERTED COLUMN ARE DIFFERENT NUMBERS.
//      Rendering the raw counter in both looks entirely plausible and is the most
//      likely way to get this table wrong.
//   2. AN ABSENT WEIGHT IS AN EM DASH, not `0 gr`. "Not weighed" and "weighed
//      nothing" are different claims about a counter.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportRejects: vi.fn(),
}));

const { getShiftReportRejects } = await import("@/lib/api");
const rejects = vi.mocked(getShiftReportRejects);

const MINUTE = 60_000;

// The four counters the reference design shows, including the two with no weight.
function breakdown(overrides: Partial<RejectReasonBreakdown> = {}): RejectReasonBreakdown {
  return {
    timeZone: "Asia/Jakarta",
    buckets: [
      {
        reason: "Total_NG_Prod",
        reasonCode: null,
        machineName: "Vertical Packer N",
        counterValue: 4776,
        counterUnit: "BAG",
        quantity: 4776,
        convertedUnit: "BAG",
        weightGram: null,
        frequency: 4776,
        durationMs: 6 * MINUTE,
      },
      {
        reason: "NG_Over_Count",
        reasonCode: null,
        machineName: "Vertical Packer N",
        counterValue: 48,
        counterUnit: "CALENDER",
        quantity: 576,
        convertedUnit: "BAG",
        weightGram: 15_232,
        frequency: 48,
        durationMs: 2 * MINUTE,
      },
    ],
    totalFrequency: 4824,
    totalDurationMs: 8 * MINUTE,
    totalQuantity: 5352,
    totalWeightGram: 15_232,
    convertedUnit: "BAG",
    loadedThrough: "2026-08-10",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QualityLossTab", () => {
  it("lists the reject counters once the breakdown arrives", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    expect(await screen.findByText("Total_NG_Prod")).toBeTruthy();
    expect(screen.getByText("NG_Over_Count")).toBeTruthy();
    // Keyed on the report id alone, which is what makes the loader's prefetch and
    // this subscription the same cache entry.
    expect(rejects).toHaveBeenCalledWith(1);
  });

  // Claim 1. Both figures, in the same row, and they are not the same number.
  it("shows the counter figure and the converted figure as different numbers", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    await screen.findByText("NG_Over_Count");
    // 48 CALENDER as the sensor counted it...
    expect(screen.getByText("48 CALENDER")).toBeTruthy();
    // ...and 576 BAG once converted. A reader that showed the counter twice would
    // render "48 CALENDER" here too.
    expect(screen.getByText("576 BAG")).toBeTruthy();
  });

  it("names the converted column's unit when the shift has one", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    expect(await screen.findByText(/Converted \(BAG\)/)).toBeTruthy();
  });

  // Claim 2, both directions in one table.
  it("em-dashes an unweighed counter and shows grams for a weighed one", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    await screen.findByText("Total_NG_Prod");
    expect(screen.getByText("15232 gr")).toBeTruthy();
    // The unweighed row renders an em dash rather than `0 gr`.
    expect(screen.queryByText("0 gr")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  // THE DESIGN'S "Should not empty" ANNOTATION. Every row names a machine, and a
  // bucket whose own name did not resolve borrows the report's.
  it("names a machine on every row, falling back to the report's own", async () => {
    const data = breakdown();
    data.buckets = data.buckets.map((bucket) => ({ ...bucket, machineName: null }));
    rejects.mockResolvedValue(data);

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    await screen.findByText("Total_NG_Prod");
    // shiftReport()'s work unit, supplied by the card rather than em-dashed.
    expect(screen.getAllByText("Vertical Packer MJCL").length).toBe(2);
  });

  it("offers four ways to rank, and re-ranks without asking the server again", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    await screen.findByText("Total_NG_Prod");
    for (const label of ["quantity", "weight", "frequency", "duration"]) {
      fireEvent.click(screen.getByLabelText(label));
    }

    // Re-ranking is a reduce over the payload already in the browser.
    await waitFor(() => expect(rejects).toHaveBeenCalledTimes(1));
  });

  // A mixed-unit shift cannot be totalled, and saying so beats showing a sum of
  // unlike units. The rejected alternative — disabling the quantity radio — is
  // recorded in quality-pareto-card.tsx.
  it("says so when the shift mixes units, and em-dashes the converted cell", async () => {
    const data = breakdown({ convertedUnit: null });
    data.buckets = data.buckets.map((bucket) => ({ ...bucket, convertedUnit: null }));
    rejects.mockResolvedValue(data);

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    expect(await screen.findByText(/Mixed units of measure/)).toBeTruthy();
    expect(screen.queryByText("576 BAG")).toBeNull();
    // The header loses its unit too, rather than naming one of the two.
    expect(screen.getByText("Converted")).toBeTruthy();
  });

  // THE NORMAL STATE UNTIL THE PIPELINE LANDS, and the split that must not read
  // as good news. Each sentence appears twice — the chart area and the table —
  // so the two halves cannot tell different stories.
  it("calls an empty shift clean only when the pipeline has reached it", async () => {
    rejects.mockResolvedValue(breakdown({ buckets: [], loadedThrough: "2026-08-10" }));

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    const lines = await screen.findAllByText("No rejects recorded for this shift.");
    expect(lines.length).toBe(2);
  });

  it("says not-loaded rather than clean when the pipeline has not reached the shift", async () => {
    rejects.mockResolvedValue(breakdown({ buckets: [], loadedThrough: "2026-07-31" }));

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    const lines = await screen.findAllByText(/Not loaded yet/);
    expect(lines.length).toBe(2);
    expect(screen.queryByText("No rejects recorded for this shift.")).toBeNull();
  });

  it("treats a never-stamped watermark as not loaded", async () => {
    rejects.mockResolvedValue(breakdown({ buckets: [], loadedThrough: null }));

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    expect((await screen.findAllByText(/Not loaded yet/)).length).toBe(2);
  });

  it("keeps a failure inside the card", async () => {
    rejects.mockRejectedValue(new Error("boom"));

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    const lines = await screen.findAllByText(/Could not load the reject breakdown/);
    expect(lines.length).toBe(2);
  });

  it("says the figures will not add up to the Reject tile", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    expect(await screen.findByText(/will not add up to the Reject tile/)).toBeTruthy();
  });

  it("offers this report's machine alongside All Machine", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    expect(await screen.findByLabelText("Filter by machine")).toBeTruthy();
  });

  // NO DRILL-DOWN. The design shows no eye button, and there is nothing behind
  // one — /rejects is an aggregate and no per-reject record table exists.
  it("offers no drill-down link", async () => {
    rejects.mockResolvedValue(breakdown());

    renderWithQuery(<QualityLossTab report={shiftReport()} />);

    await screen.findByText("Total_NG_Prod");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  describe("the Rework band", () => {
    it("states the count from the report, in the report's own unit", async () => {
      rejects.mockResolvedValue(breakdown());

      renderWithQuery(<QualityLossTab report={shiftReport({ rework: 0 })} />);

      const band = await screen.findByRole("button", { name: /Rework/ });
      expect(band.textContent).toContain("0 BAG");
    });

    it("leaks no 'null' when the report has no unit of measure", async () => {
      rejects.mockResolvedValue(breakdown());

      renderWithQuery(<QualityLossTab report={shiftReport({ rework: 12, uomName: null })} />);

      const band = await screen.findByRole("button", { name: /Rework/ });
      expect(band.textContent).toContain("12");
      expect(band.textContent).not.toMatch(/null/);
    });

    // CLOSED BY DEFAULT, unlike Reduce Speed — the header already states the
    // figure and nothing here prevents a misreading, so the fold costs nothing.
    it("starts closed, so its caveat is folded away rather than its number", async () => {
      rejects.mockResolvedValue(breakdown());

      renderWithQuery(<QualityLossTab report={shiftReport()} />);

      const band = await screen.findByRole("button", { name: /Rework/ });
      expect(band.getAttribute("aria-expanded")).toBe("false");
    });

    it("explains that rework cannot be ranked once opened", async () => {
      rejects.mockResolvedValue(breakdown());

      renderWithQuery(<QualityLossTab report={shiftReport()} />);

      fireEvent.click(await screen.findByRole("button", { name: /Rework/ }));

      expect(await screen.findByText(/cannot be ranked/)).toBeTruthy();
    });
  });

  // The direct analogue of reason-pareto-card.test.tsx's prefetch test, and the
  // only available proof that the route's loader and this card key identically:
  // seed the cache under the key the loader uses and assert no request follows.
  it("reads the entry the route's loader prefetched", async () => {
    renderWithQuery(<QualityLossTab report={shiftReport()} />, {
      seed: [{ queryKey: ["shift-report-rejects", 1], data: breakdown() }],
    });

    expect(await screen.findByText("Total_NG_Prod")).toBeTruthy();
    expect(rejects).not.toHaveBeenCalled();
  });
});
