import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { lineApprovalKey } from "@/lib/queries";
import { lineReport, periodReport, shiftReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { DowntimeDetailsCard } from "@/components/report/downtime-details-card";

import type { DowntimeListItem, LineApprovalSummary } from "@/lib/types";

// The MTTR / MTBF badge, and only that — the rest of this card is a table whose
// behaviour is covered by the downtime queries and the row menu's own suite.
//
// WHY THE BADGE IS WORTH ITS OWN FILE. On the shift table mttr and mtbf are
// `NOT NULL DEFAULT 0`; on the day and month tables migration 0013 added them
// nullable and nothing writes them yet. So this is the exact place where 0 and
// "nobody computed this" are both plausible and render differently:
//
//   0     -> "00 s"  a measurement. Claims a perfect repair time.
//   null  -> "—"     no claim at all.
//
// Commit 12a2781 exists because that distinction was collapsed once already, and
// a `coalesce(mttr, 0)` anywhere between the column and this badge would put it
// back with nothing to notice.

// A SPY rather than a fixed stub, because the SCOPE the card asks for is one of
// the things under test — see the last block. `useReportApproved` is deliberately
// NOT stubbed: it is the other half of what changed at line grain, and stubbing it
// would replace the code the freeze tests exist to exercise.
// The `_params` is declared, unused, deliberately: `vi.fn(() => ...)` infers a
// ZERO-ARG tuple, so `mock.calls[0][0]` then fails to type-check even though the
// call records the argument at runtime.
const useDowntimes = vi.fn(
  (_params: unknown) => ({ data: undefined, isPending: false, isError: false }) as never,
);

vi.mock("@/lib/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...actual,
    // The table itself is not under test in the first block; an empty page keeps
    // the card rendering its header without a network call.
    useDowntimes: (params: unknown) => useDowntimes(params as never),
  };
});

// One editable row, so the menu has something to offer or withhold.
function row(over: Partial<DowntimeListItem> = {}): DowntimeListItem {
  return {
    id: 91,
    sourceEventId: "wc-e1",
    workUnitId: 3,
    workUnitName: "Filler 2",
    workCenterName: "Line 8",
    reason: ["Jam"],
    detailReason: null,
    actions: [],
    category: "UNPLANNED",
    startAt: "2026-08-01T01:00:00.000Z",
    endAt: "2026-08-01T01:20:00.000Z",
    durationMs: 1_200_000,
    timeZone: "Asia/Jakarta",
    ...over,
  } as DowntimeListItem;
}

function withRows(rows: DowntimeListItem[]) {
  useDowntimes.mockReturnValue({
    data: { items: rows, meta: { totalElements: rows.length } },
    isPending: false,
    isError: false,
  } as never);
}

function summary(over: Partial<LineApprovalSummary> = {}): LineApprovalSummary {
  return { machinesFound: 4, machinesClosed: 0, workUnitCount: 4, ...over };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useDowntimes.mockReturnValue({ data: undefined, isPending: false, isError: false } as never);
});

describe("DowntimeDetailsCard MTTR/MTBF", () => {
  it("renders an em dash, not 00 s, when the pipeline has not computed them", () => {
    renderWithQuery(<DowntimeDetailsCard report={periodReport({ mttr: null, mtbf: null })} />);

    expect(screen.getByText("MTTR:")).toBeTruthy();
    // Two em dashes: one per figure. Their absence would mean a zero rendered.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("00 s")).toBeNull();
  });

  it("renders 00 s when the value really is zero", () => {
    renderWithQuery(<DowntimeDetailsCard report={periodReport({ mttr: 0, mtbf: 0 })} />);

    expect(screen.getAllByText("00 s").length).toBe(2);
  });

  it("renders a real duration when there is one", () => {
    renderWithQuery(<DowntimeDetailsCard report={periodReport({ mttr: 3_600_000, mtbf: 0 })} />);

    expect(screen.getByText("01 h 00 m 00 s")).toBeTruthy();
  });

  // The shift table's columns are NOT NULL, so this path must keep working
  // exactly as it did.
  it("still renders the shift report's own figures", () => {
    renderWithQuery(<DowntimeDetailsCard report={shiftReport({ mttr: 60_000, mtbf: 120_000 })} />);

    expect(screen.getByText("01 m 00 s")).toBeTruthy();
    expect(screen.getByText("02 m 00 s")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AT LINE GRAIN — what changed, and the two things that fail silently
// ---------------------------------------------------------------------------

// WHICH SCOPE THE CARD ASKS FOR. Downtime is scoped by a query param rather than
// nested under a work unit, which is what let this card serve both subjects
// unchanged — and is also what makes the wrong scope a 200 rather than a 404. A
// line report sent as `scope: "work-unit"` with the line's own id would return the
// stops of the MACHINE with that id: same envelope, same columns, a populated
// Machine column, a plausible Downtime Frequency count. Nothing on screen says so.
describe("DowntimeDetailsCard scope", () => {
  it("asks at work-center scope for a line report", () => {
    renderWithQuery(<DowntimeDetailsCard report={lineReport({ workCenterId: 8 })} />);

    expect(useDowntimes).toHaveBeenCalled();
    expect(useDowntimes.mock.calls[0]?.[0]).toMatchObject({ scope: "work-center", scopeId: 8 });
  });

  it("still asks at work-unit scope for a machine report", () => {
    renderWithQuery(<DowntimeDetailsCard report={shiftReport()} />);

    expect(useDowntimes.mock.calls[0]?.[0]).toMatchObject({ scope: "work-unit" });
  });
});

// THE FREEZE, which a line report cannot answer from a column. A machine shift
// report carries `approval`; the work_center_* tables have no approval row and
// cannot have one, so `useReportApproved` reads the machine-approval SUMMARY
// instead — and a regression there does not throw, it just re-enables Edit on a
// frozen report and lets the server answer 409 to an edit nobody expected to fail.
//
// ASSERTED ON `aria-disabled`, NOT ON THE ABSENCE OF THE WORD "Edit". The menu
// renders an Edit item in BOTH states — disabled it is wrapped in a tooltip
// trigger that carries the reason, which is the whole point of it (see
// downtime-row-menu.tsx). A text-absence assertion here would pass in every state
// and prove nothing.
//
// KEYBOARD, not click: happy-dom has no real PointerEvent, so fireEvent.click on
// the trigger leaves the menu closed and the queries below would fail confusingly.
describe("DowntimeDetailsCard freeze at line grain", () => {
  function openMenu() {
    fireEvent.keyDown(screen.getByRole("button", { name: "Row actions" }), { key: "Enter" });
    const found = screen.getAllByRole("menuitem").find((i) => /^edit$/i.test(i.textContent ?? ""));
    if (found === undefined) throw new Error("no Edit item in the row menu");
    return found;
  }

  function renderLine(data: LineApprovalSummary) {
    withRows([row()]);
    renderWithQuery(<DowntimeDetailsCard report={lineReport({ id: 7 })} />, {
      seed: [{ queryKey: lineApprovalKey(7), data }],
    });
  }

  it("offers Edit while a machine on the line is still open", () => {
    renderLine(summary({ machinesFound: 4, machinesClosed: 3 }));

    expect(openMenu().getAttribute("aria-disabled")).not.toBe("true");
  });

  it("withholds Edit once every machine is approved", () => {
    renderLine(summary({ machinesFound: 4, machinesClosed: 4 }));

    const edit = openMenu();
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    // And it says WHY, reachably — the reason is the point of a disabled Edit.
    expect(edit.getAttribute("aria-describedby")).toBe("downtime-edit-unavailable");
  });

  // THE PENDING ARM. The summary is prefetched WITHOUT being awaited, so an
  // unresolved one is the first paint of a normal page load — and `undefined` must
  // read as NOT frozen, so an operator on an open report is not told to reopen it.
  // The wrong direction here is not symmetric: offering an edit that 409s is
  // recoverable, refusing one that would have worked is not explainable.
  it("treats an unresolved summary as not frozen", () => {
    withRows([row()]);
    renderWithQuery(<DowntimeDetailsCard report={lineReport({ id: 7 })} />);

    expect(openMenu().getAttribute("aria-disabled")).not.toBe("true");
  });

  // A LINE DAY OR MONTH REPORT IS NEVER FROZEN BY THE LINE, because there is no
  // line day approval to freeze it (TODOS §48) and the summary query is gated off
  // at those grains. Individual stops may still be frozen by their MACHINE's shift
  // approval, and the server enforces that — the honest position: the browser says
  // what the line knows, the server owns the truth.
  it.each([
    ["day", lineReport({ grain: "day", shift: null, id: 7 })],
    ["month", lineReport({ grain: "month", shift: null, id: 7 })],
  ])("offers Edit at line %s grain even with every machine closed", (_grain, report) => {
    withRows([row()]);
    renderWithQuery(<DowntimeDetailsCard report={report} />, {
      // Seeded anyway, to prove the gate is what decides and not the data.
      seed: [{ queryKey: lineApprovalKey(7), data: summary({ machinesClosed: 4 }) }],
    });

    expect(openMenu().getAttribute("aria-disabled")).not.toBe("true");
  });
});
