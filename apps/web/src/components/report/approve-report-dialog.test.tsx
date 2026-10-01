import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";

import { renderWithQuery } from "@/test/render";
import { shiftReportQueryOptions } from "@/lib/queries";
import { shiftReport } from "@/test/fixtures";
import { ApproveReportDialog } from "@/components/report/approve-report-dialog";

import type { ShiftReportApproval } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  approveShiftReport: vi.fn(),
}));

const { approveShiftReport } = await import("@/lib/api");
const mocked = vi.mocked(approveShiftReport);

const CLOSED: ShiftReportApproval = {
  status: "closed",
  closedAt: "2026-08-09T09:00:00.000Z",
  closedBy: "kc-sub-1",
  closedByName: "dewi",
  source: "operator",
};

// A real AxiosError, so the component's isAxiosError check and its status lookup
// are both exercised — a bare `{ response: { status } }` would pass the status
// map while silently skipping the guard in front of it.
function axiosError(status: number): AxiosError {
  const err = new AxiosError("request failed");
  err.response = {
    status,
    statusText: "",
    data: null,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return err;
}

function render(onOpenChange = () => {}) {
  return renderWithQuery(
    <ApproveReportDialog reportId={1} open onOpenChange={onOpenChange} />,
    // Seeded so the write-through has something to merge into. The mutation
    // deliberately skips setQueryData when nothing is cached, rather than
    // writing a partial report under the key.
    { seed: [{ queryKey: shiftReportQueryOptions(1).queryKey, data: shiftReport() }] },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ApproveReportDialog", () => {
  it("approves once when confirmed", async () => {
    mocked.mockResolvedValue(CLOSED);

    render();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(1));
    expect(mocked).toHaveBeenCalledWith(1);
  });

  // THE READ-AFTER-WRITE CONTRACT, TESTED RATHER THAN DESCRIBED.
  //
  // contract §8 records that approvals need read-after-write. The mutation
  // merges the returned approval into the cached report so the badge flips in
  // the same frame the dialog closes, instead of a round trip later.
  it("writes the new approval into the cached report", async () => {
    mocked.mockResolvedValue(CLOSED);
    const onOpenChange = vi.fn();

    const { queryClient } = renderWithQuery(
      <ApproveReportDialog reportId={1} open onOpenChange={onOpenChange} />,
      { seed: [{ queryKey: shiftReportQueryOptions(1).queryKey, data: shiftReport() }] },
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      const cached = queryClient.getQueryData(shiftReportQueryOptions(1).queryKey);
      expect(cached?.approval.status).toBe("closed");
    });
    // A MERGE, not a replace: the report's own measures must survive.
    const cached = queryClient.getQueryData(shiftReportQueryOptions(1).queryKey);
    expect(cached?.oee).toBe(0.62);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables both buttons while the write is in flight", async () => {
    // No double-submit, and cancel must not close the dialog over a write that
    // is still going to land.
    let release: (value: ShiftReportApproval) => void = () => {};
    mocked.mockReturnValue(
      new Promise<ShiftReportApproval>((resolve) => {
        release = resolve;
      }),
    );

    render();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    const pending = await screen.findByRole("button", { name: /approving/i });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    release(CLOSED);
  });

  // THE ASSERTION THAT JUSTIFIES CHOOSING AN INLINE ALERT OVER A TOAST.
  //
  // The user is about to press the button again, so the message has to stay on
  // screen next to it. If this ever passes with a toast library, the reason for
  // the choice has evaporated.
  it("keeps the dialog open on failure and shows the reason", async () => {
    mocked.mockRejectedValue(axiosError(500));
    const onOpenChange = vi.fn();

    render(onOpenChange);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/could not approve this report/i)).toBeTruthy();
    // Still on screen, so retry-in-place works.
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("names the conflict when someone else got there first", async () => {
    // A 409 is not "try again" — it means the badge behind this dialog is out of
    // date, and the copy has to say so rather than inviting a pointless retry.
    mocked.mockRejectedValue(axiosError(409));

    render();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/already been approved by someone else/i)).toBeTruthy();
  });

  it("explains a permission failure in its own words", async () => {
    mocked.mockRejectedValue(axiosError(403));

    render();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText(/not permitted to approve/i)).toBeTruthy();
  });

  it("states the consequence that matters, and names the recovery", async () => {
    // The copy used to say approving "cannot be undone from this screen", which
    // was true until reopen shipped. What it must say NOW is the consequence a
    // confirm step actually exists for — approving FREEZES the shift's downtime,
    // because the edit endpoint refuses a stop on an approved report — and that
    // the recovery exists, so nobody is left thinking they are stuck.
    render();

    expect(screen.getByText(/prevents its downtime from being edited/i)).toBeTruthy();
    expect(screen.getByText(/reopen it later/i)).toBeTruthy();
    // The old promise must not survive anywhere in the dialog.
    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
  });
});
