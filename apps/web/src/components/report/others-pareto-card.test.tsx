import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { shiftReport } from "@/test/fixtures";
import { OthersParetoCard } from "@/components/report/others-pareto-card";

import type { DowntimeEventReasonBreakdown } from "@/lib/types";

// WHICH STATE THIS CARD SELECTS is the thing under test, not its arithmetic —
// that lives in lib/downtime-event-pareto.test.ts, per the split AGENTS.md states.
//
// Three claims are specific to this screen and are the reason most of the
// assertions below exist:
//
//   1. A BAR IS NOT A NUMBER OF STOPS. One stop can cite several reasons, so the
//      bars sum to occurrences and not to stops. No code can convey that, because
//      arithmetically the chart is simply correct — only the summary line and the
//      footnote can, which is why both are asserted verbatim.
//   2. THERE IS NO MEASURE TOGGLE. Frequency is the only thing the source records,
//      and a one-option radio group asserts a choice that does not exist.
//   3. "NOT LOADED YET" IS NOT "NOTHING STOPPED THIS MACHINE".
//      oee.downtime_log_events ships empty, so the stale state is the only
//      reachable non-error one until the DAG runs — this is the assertion that
//      ships green and stays green longest.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportDowntimeEvents: vi.fn(),
}));

const { getShiftReportDowntimeEvents } = await import("@/lib/api");
const events = vi.mocked(getShiftReportDowntimeEvents);

// The fixture report's business day is 2026-08-09 in Asia/Jakarta.
const report = shiftReport();

// 142 reason occurrences across 97 downtime events — the worked example the whole
// feature is specified against, and a payload where the two totals differ.
function breakdown(
  overrides: Partial<DowntimeEventReasonBreakdown> = {},
): DowntimeEventReasonBreakdown {
  return {
    timeZone: "Asia/Jakarta",
    buckets: [
      { reason: "Material_Jam", frequency: 71 },
      { reason: "Machine_Stop", frequency: 38 },
      { reason: "Operator_Break", frequency: 21 },
      { reason: "Belt_Slip", frequency: 12 },
    ],
    totalOccurrences: 142,
    totalEvents: 97,
    loadedThrough: "2026-08-10",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  events.mockReset();
});

describe("OthersParetoCard", () => {
  // ---- the six states ----------------------------------------------------

  it("renders the reasons once the log has loaded", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findByText("Material_Jam")).toBeTruthy();
    expect(await screen.findByText("Machine_Stop")).toBeTruthy();
    // THE BARE REPORT ID is the whole request, which is what makes the route
    // loader's prefetch and this subscription provably one cache entry.
    expect(events).toHaveBeenCalledWith(report.id);
  });

  it("renders skeletons and no empty sentence while the request is in flight", () => {
    events.mockReturnValue(new Promise(() => {}));

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(screen.queryByText(/No downtime events recorded/)).toBeNull();
    expect(screen.queryByText(/Not loaded yet/)).toBeNull();
  });

  // Twice: the chart area and the table each say it, from one shared string, so
  // the two can never tell the reader different stories about one empty result.
  it("reports a failure in both the chart area and the table", async () => {
    events.mockRejectedValue(new Error("boom"));

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findAllByText(/Could not load the downtime event log/)).toHaveLength(2);
  });

  it("reports a genuinely quiet shift when the pipeline has reached its day", async () => {
    events.mockResolvedValue(breakdown({ buckets: [], loadedThrough: "2026-08-10" }));

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findAllByText("No downtime events recorded for this shift.")).toHaveLength(
      2,
    );
    expect(screen.queryByText(/Not loaded yet/)).toBeNull();
  });

  // THE NORMAL CASE UNTIL THE DAG RUNS, and the split that matters: the flattering
  // reading of an empty result is the wrong one (TODOS.md §8).
  it("reports not-loaded rather than a quiet shift when the pipeline is behind", async () => {
    events.mockResolvedValue(breakdown({ buckets: [], loadedThrough: "2026-07-31" }));

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findAllByText(/Not loaded yet/)).toHaveLength(2);
    expect(screen.queryByText("No downtime events recorded for this shift.")).toBeNull();
  });

  it("reports not-loaded when the log has never been loaded at all", async () => {
    events.mockResolvedValue(breakdown({ buckets: [], loadedThrough: null }));

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findAllByText(/Not loaded yet/)).toHaveLength(2);
  });

  // THE GATED-QUERY TRAP, as a test rather than only a comment. `hasParams` is a
  // literal `true` here and cannot be false, so the card reaches `ready` and shows
  // no skeleton.
  //
  // FOR WHOEVER LATER ADDS AN `enabled:` GATE to shiftReportDowntimeEventsQueryOptions:
  // a gated useQuery reports `status: "pending"` FOREVER, so `no-params` must stay
  // first in lib/load-state.ts's ladder or this card renders a skeleton that never
  // resolves — the bug 2b33e1d fixed in two cards on this very page. The ladder
  // order itself is pinned in lib/downtime-event-pareto.test.ts, where it is cheap
  // and exhaustive.
  it("never reaches the no-params state, because the report id is the whole request", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    await screen.findByText("Material_Jam");
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  // ---- the claims specific to this screen --------------------------------

  // CLAIM 1, first half. The sentence that occupies the slot every other loss card
  // gives to its MeasureToggle.
  it("names both totals in the header", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(
      await screen.findByText("142 reason occurrences across 97 downtime events"),
    ).toBeTruthy();
  });

  // CLAIM 1, second half. Without this footnote a supervisor reads the 38 next to
  // Machine_Stop as 38 stops, and nothing on the card contradicts them.
  it("footnotes why the bars do not sum to the number of stops", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(
      await screen.findByText(/sum to 142 reason occurrences, not to the 97 downtime events/),
    ).toBeTruthy();
  });

  // An empty card must not footnote "0 occurrences across 0 events" as though that
  // were a finding, but the claim about multi-reason stops still holds.
  it("keeps the multi-reason claim but drops the figures when there are none", async () => {
    events.mockResolvedValue(breakdown({ buckets: [], loadedThrough: null }));

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findByText(/A stop can cite more than one reason/)).toBeTruthy();
    expect(screen.queryByText(/sum to 142 reason occurrences/)).toBeNull();
  });

  // CLAIM 2. Both assertions, because either alone would pass against a
  // differently-broken implementation: a stray RadioGroup with no label, or a
  // labelled toggle rendering no radios.
  it("renders no measure toggle", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    await screen.findByText("Material_Jam");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText("Sort by:")).toBeNull();
  });

  // FREQUENCY ONLY, on screen as well as on the wire. The column is headed
  // "Occurrences" and never "Freq.", which is what both sibling tables call their
  // count column — there one record is one stop, and here it is not.
  //
  // ASSERTS ON THE COLUMNS AND THE CELLS, not on a blanket /duration/i over the
  // card. The FOOTNOTE names duration on purpose — "No duration appears here: the
  // log records that a reason was cited, not how long it lasted" — so a blanket
  // match would forbid the sentence that makes the absence legible, exactly as it
  // would in lib/others-loss.test.ts.
  it("renders no duration column and heads the count Occurrences", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findByText("Occurrences")).toBeTruthy();
    expect(screen.queryByText("Freq.")).toBeNull();

    // No column header names a duration.
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.textContent ?? "").not.toMatch(/duration|minutes/i);
    }
    // And no CELL carries formatDuration's shape ("2h 13m"), which is what a
    // duration would look like if one were ever plotted or tabulated here.
    for (const cell of screen.getAllByRole("cell")) {
      expect(cell.textContent ?? "").not.toMatch(/\d+h \d+m/);
    }
  });

  // NO DRILL-DOWN, and for a sharper reason than Quality Loss's: the rows behind an
  // eye button here would be the WRONG rows, since /losses/detail filters the
  // editable downtime table by primary reason.
  it("renders no drill-down link", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    await screen.findByText("Material_Jam");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  // The Share column is the reader's own check on the denominator: 71/142 is 50%,
  // which is only true against the occurrence total and not against the 97 stops
  // beside it in the header.
  it("renders each reason's share of the occurrence total", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findByText("50%")).toBeTruthy();
  });

  // The fold, visible on screen: two null buckets are ONE row labelled
  // "Unspecified", not two.
  it("renders one Unspecified row for however many unattributed buckets arrive", async () => {
    events.mockResolvedValue(
      breakdown({
        buckets: [
          { reason: null, frequency: 3 },
          { reason: "Machine_Stop", frequency: 2 },
          { reason: null, frequency: 4 },
        ],
        totalOccurrences: 9,
        totalEvents: 6,
      }),
    );

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findAllByText("Unspecified")).toHaveLength(1);
  });

  // THE ONLY AVAILABLE PROOF that the route's loader and this card key identically
  // — there is no route-level test in this repo — so it is not optional. The key
  // must match lib/queries.ts exactly.
  it("reads a cache entry the route loader warmed, without refetching", async () => {
    renderWithQuery(<OthersParetoCard report={report} />, {
      seed: [{ queryKey: ["shift-report-downtime-events", report.id], data: breakdown() }],
    });

    expect(await screen.findByText("Material_Jam")).toBeTruthy();
    expect(events).not.toHaveBeenCalled();
  });

  // By its ARIA label, not by the machine name: MachineFilter opens on "All
  // Machine", and the report's own machine is a SelectItem inside a closed
  // SelectContent that happy-dom never renders.
  it("renders the machine filter above the card", async () => {
    events.mockResolvedValue(breakdown());

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findByLabelText("Filter by machine")).toBeTruthy();
  });

  // Client-side paging over the complete response, at the default page size.
  it("pages the table at five rows", async () => {
    events.mockResolvedValue(
      breakdown({
        buckets: Array.from({ length: 7 }, (_, i) => ({
          reason: `Reason_${i}`,
          frequency: 7 - i,
        })),
        totalOccurrences: 28,
        totalEvents: 20,
      }),
    );

    renderWithQuery(<OthersParetoCard report={report} />);

    expect(await screen.findByText("Reason_0")).toBeTruthy();
    expect(screen.queryByText("Reason_5")).toBeNull();
  });
});
