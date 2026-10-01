import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { ChangesHistorySheet } from "@/components/report/changes-history-sheet";

import type { ReasonHistory } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getReasonHistory: vi.fn(),
}));

const { getReasonHistory } = await import("@/lib/api");
const mocked = vi.mocked(getReasonHistory);

const PARAMS = {
  scope: "work-unit" as const,
  scopeId: 42,
  grain: "shift" as const,
  date: "2026-08-09",
  shift: "1",
  category: "UNPLANNED" as const,
  selector: { kind: "labelled" as const, reason: "Ganti Film" },
};

function history(overrides: Partial<ReasonHistory> = {}): ReasonHistory {
  return { entries: [], totalMembers: 2, trackedMembers: 0, ...overrides };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChangesHistorySheet", () => {
  // THE DISTINCTION THE WHOLE PAYLOAD EXISTS FOR, and the state every stop is in
  // today. An empty list rendered as "No history data available" would be a
  // claim about the DATA — that nobody has edited these stops — when the truth
  // is that nothing about them can be recorded at all.
  it("says 'not tracked' rather than 'no history' when no stop carries an id", async () => {
    mocked.mockResolvedValue(history({ trackedMembers: 0 }));

    renderWithQuery(
      <ChangesHistorySheet params={PARAMS} open onOpenChange={() => {}} timeZone="Asia/Jakarta" />,
    );

    expect(await screen.findByText(/not tracked/i)).toBeTruthy();
    expect(screen.queryByText(/no history data available/i)).toBeNull();
  });

  it("says 'no history' once the stops CAN be tracked and simply have not changed", async () => {
    mocked.mockResolvedValue(history({ trackedMembers: 2 }));

    renderWithQuery(
      <ChangesHistorySheet params={PARAMS} open onOpenChange={() => {}} timeZone="Asia/Jakarta" />,
    );

    expect(await screen.findByText(/no history data available/i)).toBeTruthy();
    expect(screen.queryByText(/not tracked/i)).toBeNull();
  });

  it("lists the trail when there is one", async () => {
    mocked.mockResolvedValue(
      history({
        trackedMembers: 1,
        entries: [
          {
            id: 1,
            sourceEventId: "evt-a",
            changedAt: "2026-08-09T06:00:00.000Z",
            changedBy: "kiki",
            field: "actions",
            oldValue: [],
            newValue: ["Ganti Film"],
          },
        ],
      }),
    );

    renderWithQuery(
      <ChangesHistorySheet params={PARAMS} open onOpenChange={() => {}} timeZone="Asia/Jakarta" />,
    );

    expect(await screen.findByText("actions")).toBeTruthy();
    // jsonb values can be arrays; interpolating one would render "[object Object]".
    expect(screen.getByText(/Ganti Film/)).toBeTruthy();
    expect(screen.getByText(/kiki/)).toBeTruthy();
  });

  // Opt-in, like performance-dialog.tsx: a panel nobody opened should cost
  // nothing. The gated query reports pending forever, which is why the ladder
  // checks `open` before `isPending`.
  it("issues no request until it is opened", () => {
    renderWithQuery(
      <ChangesHistorySheet
        params={PARAMS}
        open={false}
        onOpenChange={() => {}}
        timeZone="Asia/Jakarta"
      />,
    );

    expect(mocked).not.toHaveBeenCalled();
  });
});
