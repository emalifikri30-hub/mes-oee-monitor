import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";

import { renderWithQuery } from "@/test/render";
import { shiftReportQueryOptions } from "@/lib/queries";
import { shiftReport } from "@/test/fixtures";
import { ReopenReportDialog } from "@/components/report/reopen-report-dialog";

import type { ShiftReportApproval } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  reopenShiftReport: vi.fn(),
}));

const { reopenShiftReport } = await import("@/lib/api");
const mocked = vi.mocked(reopenShiftReport);

// All four closure columns cleared, which is what ck_wusra_open requires of an
// open row — a payload that left the approver populated would describe a state
// the database would have rejected.
const REOPENED: ShiftReportApproval = {
  status: "open",
  closedAt: null,
  closedBy: null,
  closedByName: null,
  source: null,
};

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

function render(closedByName: string | null = "dewi") {
  const onOpenChange = vi.fn();
  const result = renderWithQuery(
    <ReopenReportDialog
      reportId={7}
      closedByName={closedByName}
      open
      onOpenChange={onOpenChange}
    />,
    { seed: [{ queryKey: shiftReportQueryOptions(7).queryKey, data: shiftReport() }] },
  );
  return { onOpenChange, ...result };
}

const reopen = () => screen.getByRole("button", { name: /^reopen$/i });

afterEach(() => {
  cleanup();
  mocked.mockReset();
});

describe("ReopenReportDialog", () => {
  // Reopening withdraws somebody's sign-off, and it may not be the current
  // user's. "Are you sure" with no name is not a question anybody can answer.
  it("names the approver being overridden", () => {
    render("dewi");

    expect(screen.getByText(/approved by dewi/i)).toBeTruthy();
  });

  // A system close has no person behind it — the 14-day sweeper writes
  // source='system' with closed_by NULL — so the copy must not invent one.
  it("words it differently when nobody approved it", () => {
    render(null);

    expect(screen.getByText(/closed automatically/i)).toBeTruthy();
    expect(screen.queryByText(/approved by/i)).toBeNull();
  });

  it("reopens and closes on success", async () => {
    mocked.mockResolvedValue(REOPENED);
    const { onOpenChange } = render();

    fireEvent.click(reopen());

    await waitFor(() => expect(mocked).toHaveBeenCalledWith(7));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [403, /not permitted to reopen/i],
    [404, /no longer exists/i],
    // Somebody else reopened it first. The recovery is not "try again" — the
    // badge on screen is out of date.
    [409, /already open/i],
    [500, /try again in a moment/i],
  ])("renders the right message for %i and stays open", async (status, expected) => {
    mocked.mockRejectedValue(axiosError(status));
    const { onOpenChange } = render();

    fireEvent.click(reopen());

    expect(await screen.findByText(expected)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("disables both buttons while the write is in flight", async () => {
    mocked.mockReturnValue(new Promise(() => {}));
    render();

    fireEvent.click(reopen());

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /reopening/i }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect((screen.getByRole("button", { name: /cancel/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
