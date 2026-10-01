import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { lineReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { MachineViewCard } from "@/components/report/machine-view-card";

import type { LineMachineBreakdown, LineMachineList } from "@/lib/types";

// THE PER-ROW ARROW IS WHY THIS FILE EXISTS. It opens a MACHINE report from a LINE
// screen, which means the id it interpolates comes from the row and the line's own
// id is right there in scope being the wrong number.
//
// Seven report tables, seven independent `serial` sequences. So
// `/report/machine/by-shift/{lineReportId}` does not 404 in the general case — it
// opens a real machine report, possibly a machine not on this line, on a date that
// is not this one, with a populated header and a populated OEE row. A test that
// asserts "the row has a link" passes either way. These assert the href.
//
// Mocks lib/api rather than lib/queries, per timeline-card.test.tsx: the wiring is
// what breaks, and stubbing the hook would replace the code under test.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getLineMachines: vi.fn(),
}));

const { getLineMachines } = await import("@/lib/api");
const mocked = vi.mocked(getLineMachines);

function machine(over: Partial<LineMachineBreakdown> = {}): LineMachineBreakdown {
  return {
    reportId: 501,
    workUnitId: 3,
    workUnitName: "Filler 2",
    workUnitCode: "FL-02",
    uomName: "BAG",
    totalOut: 1000,
    goodOut: 950,
    reject: 40,
    rework: 10,
    scheduleLossTime: 600_000,
    availabilityLossTime: 1_200_000,
    performanceLossTime: 300_000,
    msLossTime: 120_000,
    reduceSpeedLossTime: -60_000,
    qualityLossTime: 90_000,
    ...over,
  };
}

// BY ROLE, not by text. Each machine's name appears TWICE — once in the row's
// collapsible trigger and once in the arrow link's sr-only label — so a bare
// getByText finds two elements and throws. Asking for the trigger says which one
// is meant and doubles as an assertion that the row IS expandable.
const rowTrigger = (name: RegExp) => screen.findByRole("button", { name });

function payload(machines: LineMachineBreakdown[] = [machine()]): LineMachineList {
  return {
    timeZone: "Asia/Jakarta",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-01T08:00:00.000Z",
    machines,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MachineViewCard rows", () => {
  it("names each machine that reported into the line", async () => {
    mocked.mockResolvedValue(
      payload([machine(), machine({ reportId: 502, workUnitName: "Capper 1" })]),
    );

    renderWithQuery(<MachineViewCard report={lineReport()} />);

    expect(await rowTrigger(/Filler 2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Capper 1/ })).toBeTruthy();
  });

  // A work unit whose name the pipeline left null still gets a row: dropping it
  // would silently shrink the roster, and a line with a machine missing from this
  // card reads as a line with fewer machines.
  it("still renders a machine with no name", async () => {
    mocked.mockResolvedValue(payload([machine({ workUnitName: null, workUnitCode: null })]));

    renderWithQuery(<MachineViewCard report={lineReport()} />);

    expect(await rowTrigger(/Work unit 3/)).toBeTruthy();
  });

  it("says so when no machine reported into the line", async () => {
    mocked.mockResolvedValue(payload([]));

    renderWithQuery(<MachineViewCard report={lineReport()} />);

    expect(await screen.findByText(/no machine reported into this line/i)).toBeTruthy();
  });

  it("keeps a failure inside the card", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    renderWithQuery(<MachineViewCard report={lineReport()} />);

    expect(await screen.findByText(/could not load the machine breakdown/i)).toBeTruthy();
  });

  // All rows collapsed, so the page's height does not depend on the roster — and
  // so the durations below are proof the expansion did something.
  it("starts collapsed and reveals the machine's losses when opened", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<MachineViewCard report={lineReport()} />);

    const trigger = await rowTrigger(/Filler 2/);
    expect(screen.queryByText("Small Stop")).toBeNull();

    fireEvent.click(trigger);

    expect(screen.getByText("Small Stop")).toBeTruthy();
    // Negative reduce-speed loss is real data — the machine outran its standard
    // rate — and must render as-is rather than being clamped to zero.
    expect(screen.getByText("-01 m 00 s")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// THE ARROW'S TARGET — both axes, and one of them is in scope being wrong
// ---------------------------------------------------------------------------
describe("MachineViewCard deep link", () => {
  // `reportId: 501` on the row, `id: 7` on the LINE report. Both are plausible
  // machine report ids, which is the entire hazard.
  const LINE_ID = 7;

  it.each([
    ["shift", lineReport({ id: LINE_ID }), "/report/machine/by-shift/501"],
    ["day", lineReport({ grain: "day", shift: null, id: LINE_ID }), "/report/machine/by-day/501"],
    [
      "month",
      lineReport({ grain: "month", shift: null, id: LINE_ID }),
      "/report/machine/by-monthly/501",
    ],
  ])("opens the machine's own report at %s grain", async (_grain, report, href) => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<MachineViewCard report={report} />);

    const link = await screen.findByRole("link", { name: /open filler 2's report/i });
    expect(link.getAttribute("href")).toContain(href);
  });

  // THE ASSERTION THE CARD EXISTS TO KEEP TRUE. The line's id in that slot is a
  // real machine report about the wrong machine on the wrong date.
  it("never interpolates the LINE report's id", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<MachineViewCard report={lineReport({ id: LINE_ID })} />);

    const link = await screen.findByRole("link", { name: /open filler 2's report/i });
    expect(link.getAttribute("href")).not.toContain(`/${LINE_ID}`);
  });

  // And it must not stay on the LINE routes either — that would be the subject
  // axis, and it would render a Line screen for a machine report's id.
  it("leaves the line routes", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<MachineViewCard report={lineReport({ id: LINE_ID })} />);

    const link = await screen.findByRole("link", { name: /open filler 2's report/i });
    expect(link.getAttribute("href")).not.toContain("/report/line/");
  });
});

// The window comes from the ENVELOPE, not from a row: every machine on a line runs
// the same shift, so a per-row pair would be a fact about nothing. It is resolved
// server-side, which is what keeps a second copy of SHIFT_WINDOWS out of the
// browser.
describe("MachineViewCard window", () => {
  it("renders the envelope's window in the plant's zone", async () => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<MachineViewCard report={lineReport()} />);

    // 00:00Z is 07:00 in Asia/Jakarta; 08:00Z is 15:00. A card reading these as
    // UTC would show 00:00 and 08:00, which is the whole class of bug.
    await rowTrigger(/Filler 2/);
    expect(screen.getByText(/07:00/)).toBeTruthy();
    expect(screen.getByText(/15:00/)).toBeTruthy();
  });
});

describe("MachineViewCard endpoint", () => {
  // BOTH AXES IN THE CALL. A machines read at the wrong grain returns another
  // date's roster with the same shape.
  it.each([
    ["shift", lineReport({ id: 7 })],
    ["day", lineReport({ grain: "day", shift: null, id: 7 })],
    ["month", lineReport({ grain: "month", shift: null, id: 7 })],
  ])("asks the %s endpoint", async (grain, report) => {
    mocked.mockResolvedValue(payload());

    renderWithQuery(<MachineViewCard report={report} />);

    await rowTrigger(/Filler 2/);
    expect(mocked).toHaveBeenCalledWith(grain, 7);
  });
});
