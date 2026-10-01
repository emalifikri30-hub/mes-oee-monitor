import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { shiftReport } from "@/test/fixtures";
import { ReportActions } from "@/components/report/report-actions";

import type { ShiftReportDetail } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportActivity: vi.fn(),
  approveShiftReport: vi.fn(),
}));

const { getShiftReportActivity, approveShiftReport } = await import("@/lib/api");
const mockedActivity = vi.mocked(getShiftReportActivity);
const mockedApprove = vi.mocked(approveShiftReport);

function closed(): ShiftReportDetail {
  return shiftReport({
    approval: {
      status: "closed",
      closedAt: "2026-08-09T09:00:00.000Z",
      closedBy: "kc-sub-1",
      closedByName: "dewi",
      source: "operator",
    },
  });
}

// Radix opens a DropdownMenu on POINTERDOWN or a key, never on a synthetic
// click — `fireEvent.click` alone leaves the menu closed and every query below
// fails with a confusing "unable to find role menuitem". The keyboard path is
// the reliable one under happy-dom, which has no real PointerEvent.
function openMenu(): void {
  fireEvent.keyDown(screen.getByRole("button", { name: /more actions/i }), { key: "Enter" });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReportActions", () => {
  it("offers Approve while the report is open", () => {
    renderWithQuery(<ReportActions report={shiftReport()} />);

    const button = screen.getByRole("button", { name: /approve/i });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("shows an already-approved report as done, not actionable", () => {
    // Disabled rather than hidden: the button is the clearest statement that the
    // report has been approved, and removing it leaves the reader hunting.
    renderWithQuery(<ReportActions report={closed()} />);

    const button = screen.getByRole("button", { name: /approved/i });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("does not open the confirm dialog for a closed report", () => {
    renderWithQuery(<ReportActions report={closed()} />);

    fireEvent.click(screen.getByRole("button", { name: /approved/i }));

    expect(screen.queryByText(/approve this report\?/i)).toBeNull();
  });

  it("offers four actions, with the two undesigned ones disabled", () => {
    // The rule this asserts: Regenerate and Adjust calculation are disabled
    // because nothing has designed them, while Download is enabled because it is
    // a committed feature that can explain itself. See the component's comment —
    // without this test the four drift into being "consistent" the wrong way.
    renderWithQuery(<ReportActions report={shiftReport()} />);
    openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);

    const byName = (name: RegExp) => items.find((i) => name.test(i.textContent ?? ""));
    expect(byName(/download/i)?.getAttribute("aria-disabled")).not.toBe("true");
    expect(byName(/log activity/i)?.getAttribute("aria-disabled")).not.toBe("true");
    expect(byName(/regenerate/i)?.getAttribute("aria-disabled")).toBe("true");
    expect(byName(/adjust calculation/i)?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the menu available after a report closes, and GROWS it by Reopen", () => {
    // Reading what happened to a report, and exporting it, are exactly what you
    // do to a CLOSED one — the menu must not narrow. It gains one item: Reopen,
    // which only exists for a report there is something to reopen.
    renderWithQuery(<ReportActions report={closed()} />);
    openMenu();

    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(5);
    expect(items.some((i) => /reopen/i.test(i.textContent ?? ""))).toBe(true);
  });

  it("offers no Reopen on an open report", () => {
    // Hidden rather than disabled, unlike Approve. "Reopen" over an already-open
    // report is not a state worth rendering, whereas a disabled Approve is the
    // clearest statement that a report is closed.
    renderWithQuery(<ReportActions report={shiftReport()} />);
    openMenu();

    expect(screen.getAllByRole("menuitem").some((i) => /reopen/i.test(i.textContent ?? ""))).toBe(
      false,
    );
  });

  // Reopening withdraws somebody's sign-off, and it may not be the current
  // user's — so the confirm body has to name whose it was. "Are you sure" with no
  // name is not a question anybody can answer.
  it("names the approver in the reopen confirmation", async () => {
    renderWithQuery(<ReportActions report={closed()} />);
    openMenu();

    fireEvent.click(
      screen.getAllByRole("menuitem").find((i) => /reopen/i.test(i.textContent ?? ""))!,
    );

    expect(await screen.findByText(/approved by/i)).toBeTruthy();
  });

  it("issues no activity request until Log Activity is chosen", () => {
    // The gated-query trap, carried over from changes-history-sheet.test.tsx: a
    // panel most visits never open must cost nothing on mount.
    renderWithQuery(<ReportActions report={shiftReport()} />);
    openMenu();

    expect(mockedActivity).not.toHaveBeenCalled();
  });

  it("asks for nothing at all when Download is chosen", () => {
    // The stub is a stub. A Download item that quietly called an endpoint would
    // be worse than one that does nothing.
    renderWithQuery(<ReportActions report={shiftReport()} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /download/i }));

    expect(mockedActivity).not.toHaveBeenCalled();
    expect(mockedApprove).not.toHaveBeenCalled();
  });
});
