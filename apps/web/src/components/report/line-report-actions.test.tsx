import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { lineApprovalKey } from "@/lib/queries";
import { lineReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { LineReportActions } from "@/components/report/line-report-actions";

import type { LineApprovalSummary } from "@/lib/types";

// WHICH ENDPOINT A LINE ACTION HITS, and which actions exist at all.
//
// THE ASSERTION THAT MATTERS MOST IS THE FUNCTION IDENTITY, not that a dialog
// opened. There are seven report tables with seven INDEPENDENT identity sequences, and
// ConfirmWriteDialog takes its mutation as a PROP precisely so this wiring lives
// at the call site — a Line dialog handed `useApproveShiftReport` would POST a
// line's id to /work-units/shift-reports/:id/approve, which either 404s or signs
// off some unrelated MACHINE report and reports success. Nothing on screen would
// differ. So these tests spy on lib/api and check WHICH function ran.
//
// The mock covers both writes so a swap in either direction fails: asserting only
// that approveLineReport ran would still pass if the component ALSO called the
// machine one.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  approveLineReport: vi.fn(),
  reopenLineReport: vi.fn(),
  approveShiftReport: vi.fn(),
  reopenShiftReport: vi.fn(),
  getLineApproval: vi.fn(),
  // The feed's three fetchers, for the same reason the two writes are mocked in
  // both directions: the LINE one takes a grain and the two MACHINE ones take an id
  // from another sequence entirely, and confusing them renders a stranger's
  // chronology with nothing on screen to say so.
  getLineActivity: vi.fn(),
  getShiftReportActivity: vi.fn(),
  getPeriodReportActivity: vi.fn(),
}));

const api = await import("@/lib/api");
const approveLine = vi.mocked(api.approveLineReport);
const reopenLine = vi.mocked(api.reopenLineReport);
const approveMachine = vi.mocked(api.approveShiftReport);
const reopenMachine = vi.mocked(api.reopenShiftReport);
const lineActivity = vi.mocked(api.getLineActivity);
const machineActivity = vi.mocked(api.getShiftReportActivity);
const machinePeriodActivity = vi.mocked(api.getPeriodReportActivity);

function summary(over: Partial<LineApprovalSummary> = {}): LineApprovalSummary {
  return { machinesFound: 4, machinesClosed: 0, workUnitCount: 4, ...over };
}

function render(report = lineReport({ id: 7 }), approval = summary()) {
  return renderWithQuery(<LineReportActions report={report} />, {
    seed: [{ queryKey: lineApprovalKey(7), data: approval }],
  });
}

// KEYBOARD, not click. happy-dom has no real PointerEvent, so fireEvent.click on
// a Radix trigger leaves the menu closed and every query below fails with a
// confusing "unable to find" — the note downtime-row-menu.test.tsx and
// report-actions.test.tsx both already carry.
async function openMenu() {
  fireEvent.keyDown(screen.getByLabelText("More actions"), { key: "Enter" });
  await screen.findByText("Download");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LineReportActions — which write runs", () => {
  it("approves through the LINE endpoint, never the machine one", async () => {
    approveLine.mockResolvedValue(summary({ machinesClosed: 4 }));
    render();

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(approveLine).toHaveBeenCalledWith(7));
    expect(approveMachine).not.toHaveBeenCalled();
  });

  it("reopens through the LINE endpoint, never the machine one", async () => {
    reopenLine.mockResolvedValue(summary({ machinesClosed: 0 }));
    render(lineReport({ id: 7 }), summary({ machinesClosed: 4 }));

    await openMenu();
    fireEvent.click(screen.getByText("Reopen"));
    fireEvent.click(await screen.findByRole("button", { name: "Reopen" }));

    await waitFor(() => expect(reopenLine).toHaveBeenCalledWith(7));
    expect(reopenMachine).not.toHaveBeenCalled();
  });
});

describe("LineReportActions — the Approve button's states", () => {
  // A PARTIALLY APPROVED LINE IS STILL APPROVABLE. Reachable the moment somebody
  // approves one machine from the machine screen; refusing here would leave the
  // line permanently un-approvable from its own page. The server closes only the
  // open ones, which is what the upsert's WHERE status='open' already does.
  it("stays enabled while any machine is open", () => {
    render(lineReport({ id: 7 }), summary({ machinesFound: 4, machinesClosed: 3 }));

    expect(screen.getByRole("button", { name: /approve/i })).not.toHaveProperty("disabled", true);
  });

  it("reads Approved and disables once every machine is closed", () => {
    render(lineReport({ id: 7 }), summary({ machinesFound: 4, machinesClosed: 4 }));

    const button = screen.getByRole("button", { name: /approved/i });
    expect(button).toHaveProperty("disabled", true);
  });

  // 0 of 0 IS NOT "FULLY APPROVED". A line whose machines never reported has
  // nothing to sign and the server 404s it; a button reading "Approved" there
  // would claim a sign-off over an empty shift.
  it("does not read Approved when no machine reported", () => {
    render(
      lineReport({ id: 7 }),
      summary({ machinesFound: 0, machinesClosed: 0, workUnitCount: 0 }),
    );

    expect(screen.queryByRole("button", { name: /approved/i })).toBeNull();
    expect(screen.getByRole("button", { name: /approve/i })).toBeTruthy();
  });
});

describe("LineReportActions — what each grain offers", () => {
  it.each(["day", "month"] as const)("hides Approve entirely at %s grain", (grain) => {
    render(lineReport({ id: 7, grain, shift: null }));

    // HIDDEN, not disabled. A disabled button says "you cannot do this now"; here
    // the action does not exist — a line day approval would cascade over three
    // shifts as well as N machines, which is TODOS §48.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  // LOG ACTIVITY IS AT EVERY GRAIN, and this test asserted the opposite — correctly,
  // while /activity was shift-only. TODOS §60 held the coarse grains open as a
  // PRODUCT question about density ("may be a log rather than a feed"), and the
  // answer, on the machine day feed's and the area day feed's precedent, is that a
  // day feed is a feed.
  //
  // THE ASSERTION INVERTS RATHER THAN BEING DELETED, because the neighbouring case
  // below still holds: Approve stays shift-only. The two are asserted together so a
  // future pass cannot "make them consistent" in either direction — reading grants
  // no authority, and signing off a day would cascade over three shifts as well as
  // N machines (§48).
  it.each(["day", "month"] as const)("offers Log Activity at %s grain", async (grain) => {
    render(lineReport({ id: 7, grain, shift: null }));

    await openMenu();

    expect(screen.getByText("Log Activity")).toBeTruthy();
    expect(screen.getByText("Download")).toBeTruthy();
    // And still no Approve — the point of asserting both in one place.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  // WHICH ENDPOINT THE COARSE SHEET READS. The three work_center_* tables have
  // independent identity sequences, so a day report's id sent to the shift path
  // resolves against a real line SHIFT report about another period and renders a
  // populated, plausible panel. Nothing on screen would differ, so the test names
  // the function and its grain.
  // THE REPORTS ARE WRITTEN OUT PER GRAIN rather than built from the loop variable,
  // because `LineReportDetail` is a DISCRIMINATED UNION and `{grain, shift}` off a
  // widening variable is not assignable to a Partial of one — the same property
  // that stops a month report carrying a shift anywhere in this app.
  it.each([
    ["shift" as const, lineReport({ id: 7, grain: "shift", shift: 2 })],
    ["day" as const, lineReport({ id: 7, grain: "day", shift: null })],
    ["month" as const, lineReport({ id: 7, grain: "month", shift: null })],
  ])("opens the %s-grain feed, never another grain's", async (grain, report) => {
    lineActivity.mockResolvedValue({ timeZone: "Asia/Jakarta", entries: [], sources: [] });
    render(report);

    await openMenu();
    fireEvent.click(screen.getByText("Log Activity"));

    await waitFor(() => expect(lineActivity).toHaveBeenCalledWith(grain, 7));
    // NEVER the machine feeds: same envelope, same three arms, a full panel of
    // some MACHINE report's history under a Line heading.
    expect(machineActivity).not.toHaveBeenCalled();
    expect(machinePeriodActivity).not.toHaveBeenCalled();
  });

  // Hidden rather than disabled, because "reopen" over a line with nothing
  // approved is not a state worth rendering.
  it("hides Reopen when no machine is approved", async () => {
    render(lineReport({ id: 7 }), summary({ machinesClosed: 0 }));

    await openMenu();

    expect(screen.queryByText("Reopen")).toBeNull();
  });

  it("offers Reopen once something is approved", async () => {
    render(lineReport({ id: 7 }), summary({ machinesClosed: 2 }));

    await openMenu();

    expect(screen.getByText("Reopen")).toBeTruthy();
  });

  // DISABLED, not hidden: neither is designed, so a dialog would have nothing
  // truthful to say. downtime-row-menu.tsx's convention.
  it.each(["Regenerate", "Adjust calculation"])("leaves %s disabled", async (label) => {
    render();

    await openMenu();

    expect(screen.getByText(label).closest("[data-disabled]")).toBeTruthy();
  });
});

describe("LineReportActions — the cascade is named in the copy", () => {
  // A CASCADE THE OPERATOR CANNOT SEE IS THIS FEATURE'S WORST FAILURE MODE. One
  // click closes N machine reports, and the count comes from the same summary the
  // Status tile renders — so the two cannot disagree.
  it("says how many machines Approve will close", async () => {
    render(lineReport({ id: 7 }), summary({ machinesFound: 4, machinesClosed: 1 }));

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    expect(await screen.findByText(/3 machines on this line/)).toBeTruthy();
  });

  it("says how many approvals Reopen will withdraw", async () => {
    render(lineReport({ id: 7 }), summary({ machinesFound: 4, machinesClosed: 2 }));

    await openMenu();
    fireEvent.click(screen.getByText("Reopen"));

    expect(await screen.findByText(/2 approved machines on this line/)).toBeTruthy();
  });
});
