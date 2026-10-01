import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { lineApprovalKey } from "@/lib/queries";
import { lineReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { LineReportHeader } from "@/components/report/line-report-header";

import type { LineApprovalSummary } from "@/lib/types";

// WHICH TILES THE LINE HEADER SELECTS, per grain, and what its Status tile is
// allowed to claim.
//
// The three layouts are not cosmetic variants. Each absence encodes something the
// database cannot express:
//
//   the Shift tile     only a shift report has a shift.
//   the Status tile    a line has NO approval row and cannot have one —
//                      oee.work_unit_shift_report_approvals is keyed
//                      (work_unit_id, date, shift) and the work_center_* tables
//                      have no work_unit_id column. So the tile is a COUNT of the
//                      line's machine reports, and it must never be able to render
//                      as an Open/Closed badge, which would assert a signature
//                      nobody gave. Absent entirely at day and month grain, where
//                      the cascade question (TODOS §48) is unanswered.
//
// A regression in any of those renders a header that looks completely normal.

// The header mounts LineReportActions, which mounts two dialogs and a sheet that
// each fire their own queries. Stubbed so this file tests tile selection rather
// than the dialog tree — line-report-actions.test.tsx covers that.
vi.mock("@/components/report/line-report-actions", () => ({
  LineReportActions: ({ report }: { report: { grain: string } }) => (
    <div data-testid="line-report-actions" data-grain={report.grain} />
  ),
}));

function summary(over: Partial<LineApprovalSummary> = {}): LineApprovalSummary {
  return { machinesFound: 4, machinesClosed: 0, workUnitCount: 4, ...over };
}

// Seeded through the SAME key lib/queries.ts uses. A key that drifts is a tile
// that renders an em dash forever while a request loops behind it.
function seedApproval(id: number, data: LineApprovalSummary) {
  return [{ queryKey: lineApprovalKey(id), data }];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LineReportHeader — shift grain", () => {
  it("shows the Shift tile", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ shift: 3 })} />);

    expect(screen.getByText("Shift")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  // NEVER THROUGH A ZONE. `businessDate` is a plain 'YYYY-MM-DD' and these tables
  // have no `date timestamptz` column at all (0014), so formatReportDate — which
  // takes an instant — must not appear in this component. Handed a business date
  // it reads '2026-08-01' as UTC midnight and lands on 31 July west of Greenwich.
  it("formats the date from the business day, not through a zone", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ businessDate: "2026-08-01" })} />);

    expect(screen.getByText(/01\/08\/2026/)).toBeTruthy();
  });

  it("names the line, not a machine", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ workCenterName: "Molca Line 8" })} />);

    expect(screen.getByText("Line")).toBeTruthy();
    expect(screen.getByText("Molca Line 8")).toBeTruthy();
    expect(screen.queryByText("Machine Name")).toBeNull();
  });
});

describe("LineReportHeader — the Status tile", () => {
  it("counts the machines still to be approved", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ id: 7 })} />, {
      seed: seedApproval(7, summary({ machinesFound: 4, machinesClosed: 1, workUnitCount: 4 })),
    });

    expect(screen.getByText("1 of 4 machines approved")).toBeTruthy();
  });

  // "Approved" rather than "4 of 4" — at that point the count adds nothing. It
  // stays the quiet `secondary` treatment, so nobody reads it as an action.
  it("says Approved once every machine is closed", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ id: 7 })} />, {
      seed: seedApproval(7, summary({ machinesFound: 4, machinesClosed: 4, workUnitCount: 4 })),
    });

    expect(screen.getByText("Approved")).toBeTruthy();
  });

  // 0 of 0 reads as a real answer about a real shift; this says the pipeline has
  // not filled it in.
  it("says so when no machine reported the shift", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ id: 7 })} />, {
      seed: seedApproval(7, summary({ machinesFound: 0, machinesClosed: 0, workUnitCount: 0 })),
    });

    expect(screen.getByText("No machine reports")).toBeTruthy();
  });

  // THE ABSTENTION ARM. `machinesFound` is the machine shift reports that NAME THIS
  // LINE for this date and shift; `workUnitCount` is what the pipeline wrote on the
  // line row as having reported into it. BOTH ARE THE PIPELINE'S OWN FIGURES, so a
  // disagreement is it disagreeing with itself — and a fraction over the wrong
  // denominator is a WRONG answer rather than a smaller one, so the tile refuses to
  // state one. Same call ck_wcsr_infeed_units makes for an unlabelled count.
  it("abstains when the line row and the machine reports disagree", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ id: 7 })} />, {
      seed: seedApproval(7, summary({ machinesFound: 5, machinesClosed: 2, workUnitCount: 4 })),
    });

    expect(screen.getByText("Counts disagree")).toBeTruthy();
    expect(screen.queryByText(/machines approved/)).toBeNull();
  });

  // The summary is prefetched WITHOUT being awaited, so an unresolved one is the
  // first paint of a normal page load. An em dash, never a skeleton: this query is
  // gated at the coarse grains and a gated useQuery reports pending forever.
  it("renders an em dash while the summary is still in flight", () => {
    renderWithQuery(<LineReportHeader report={lineReport({ id: 7 })} />);

    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.queryByText(/machines approved/)).toBeNull();
  });
});

describe("LineReportHeader — coarse grains", () => {
  it.each(["day", "month"] as const)("has no Shift tile at %s grain", (grain) => {
    renderWithQuery(<LineReportHeader report={lineReport({ grain, shift: null })} />);

    expect(screen.queryByText("Shift")).toBeNull();
  });

  // NO STATUS AT ALL, even seeded. A line day would be a cascade over three shifts
  // as well as N machines (TODOS §48), so a count here would describe ~3N records
  // nobody can act on — and the query is gated off, so nothing is even requested.
  it.each(["day", "month"] as const)("has no Status tile at %s grain", (grain) => {
    renderWithQuery(<LineReportHeader report={lineReport({ id: 7, grain, shift: null })} />, {
      seed: seedApproval(7, summary({ machinesClosed: 2 })),
    });

    expect(screen.queryByText("Status")).toBeNull();
  });

  it("labels a month report Month and a day report Date", () => {
    const { unmount } = renderWithQuery(
      <LineReportHeader report={lineReport({ grain: "day", shift: null })} />,
    );
    expect(screen.getByText("Date")).toBeTruthy();
    unmount();

    renderWithQuery(<LineReportHeader report={lineReport({ grain: "month", shift: null })} />);
    expect(screen.getByText("Month")).toBeTruthy();
  });
});
