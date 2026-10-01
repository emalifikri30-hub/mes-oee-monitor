import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { lineReport } from "@/test/fixtures";
import { qualityAddress } from "@/lib/report-subject";
import { QualityEntriesSheet } from "@/components/report/quality-entries-sheet";
import { renderWithQuery } from "@/test/render";

import type { QualityEntry } from "@/lib/types";

// THE ONLY PLACE AN ENTRY CAN BE CORRECTED, and the only place a voided one is
// visible. Both halves are asserted, because they are opposite claims about the
// same list: the card's ledger shows what COUNTS, this shows what HAPPENED.
//
// Mocks lib/api rather than lib/queries, per timeline-card.test.tsx: the wiring is
// what breaks, and stubbing the hook would replace the code under test.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getQualityEntries: vi.fn(),
  voidQualityEntry: vi.fn(),
}));

const { getQualityEntries, voidQualityEntry } = await import("@/lib/api");
const mocked = vi.mocked(getQualityEntries);
const mockedVoid = vi.mocked(voidQualityEntry);

function entry(over: Partial<QualityEntry> = {}): QualityEntry {
  return {
    id: 1,
    kind: "reject",
    workCenterId: 9999,
    businessDate: "2026-08-01",
    shift: 1,
    timeZone: "Asia/Jakarta",
    workUnitId: 3,
    workUnitName: "Filler 2",
    productId: 4,
    productName: "Kacang Garuda 20g",
    productCode: "KG-20",
    reasonId: 7,
    reasonCode: "BURST",
    reasonName: "Burst seal",
    note: null,
    enteredQty: 140,
    enteredUomCode: "BAG",
    enteredUomName: "Bag",
    targetQty: 140,
    targetUomCode: "BAG",
    targetUomName: "Bag",
    unitCheck: "verified",
    enteredAt: "2026-08-01T02:00:00.000Z",
    enteredBy: "kc-1",
    enteredByName: "Operator One",
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    supersedesId: null,
    ...over,
  };
}

const payload = (items: QualityEntry[]) => ({ items, totals: [], targetUomCode: "BAG" });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("QualityEntriesSheet", () => {
  // ASKS FOR THE VOIDED ROWS. The card's read does not, and the two are separate
  // cache entries because of it — a shared key would make opening this sheet
  // rewrite the card's live figure with a set that includes retracted entries.
  it("reads the ledger WITH the voided entries", async () => {
    mocked.mockResolvedValue(payload([entry()]));

    renderWithQuery(
      <QualityEntriesSheet
        address={qualityAddress(lineReport({ id: 7 }))}
        open
        onOpenChange={vi.fn()}
      />,
    );

    await screen.findByText(/Burst seal/);
    expect(mocked).toHaveBeenCalledWith({ subject: "line", grain: "shift", id: 7 }, true);
  });

  // A VOIDED ENTRY IS SHOWN, not filtered out. It reads "500, then that was
  // wrong" rather than "50" with no memory of the 500 that sat on a report.
  it("shows a voided entry, with who voided it and why", async () => {
    mocked.mockResolvedValue(
      payload([
        entry({
          voidedAt: "2026-08-01T05:00:00.000Z",
          voidedBy: "kc-2",
          voidedByName: "Supervisor",
          voidReason: "counted twice",
        }),
      ]),
    );

    renderWithQuery(
      <QualityEntriesSheet address={qualityAddress(lineReport())} open onOpenChange={vi.fn()} />,
    );

    expect(await screen.findByText("Voided")).toBeTruthy();
    expect(screen.getByText(/Supervisor/)).toBeTruthy();
    expect(screen.getByText(/counted twice/)).toBeTruthy();
  });

  // AND OFFERS NO VOID ON IT. The trigger refuses a second void with a 409, so an
  // offered button here would be an action that always fails.
  it("offers no Void on an already-voided entry", async () => {
    mocked.mockResolvedValue(
      payload([entry({ voidedAt: "2026-08-01T05:00:00.000Z", voidedBy: "kc-2" })]),
    );

    renderWithQuery(
      <QualityEntriesSheet address={qualityAddress(lineReport())} open onOpenChange={vi.fn()} />,
    );

    await screen.findByText("Voided");
    expect(screen.queryByRole("button", { name: /^void$/i })).toBeNull();
  });

  // TWO PRESSES. A void cannot be undone from here — the row stays voided and the
  // correction is a NEW entry — so a single-click destructive action beside a list
  // of similar rows is the shape a mis-click takes.
  it("requires a confirmation before voiding", async () => {
    mocked.mockResolvedValue(payload([entry({ id: 42 })]));

    renderWithQuery(
      <QualityEntriesSheet
        address={qualityAddress(lineReport({ id: 7 }))}
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^void$/i }));
    expect(mockedVoid).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    // `mutate` dispatches asynchronously through the query client, so the call
    // has not happened by the time the click returns.
    await vi.waitFor(() => {
      expect(mockedVoid).toHaveBeenCalledWith(
        { subject: "line", grain: "shift", id: 7 },
        42,
        undefined,
      );
    });
  });

  // BOTH QUANTITIES when the units differ, one when they agree. An operator who
  // typed 10 cartons must be able to find their own entry in a list otherwise
  // denominated in bags.
  it("shows what was typed beside what it converted to", async () => {
    mocked.mockResolvedValue(
      payload([
        entry({ enteredQty: 10, enteredUomCode: "CTN", targetQty: 120, targetUomCode: "BAG" }),
      ]),
    );

    renderWithQuery(
      <QualityEntriesSheet address={qualityAddress(lineReport())} open onOpenChange={vi.fn()} />,
    );

    expect(await screen.findByText(/10 CTN/)).toBeTruthy();
    expect(screen.getByText(/120 BAG/)).toBeTruthy();
  });

  // "We could not check", never "we checked and it was fine" — the server accepts
  // an entry whose shift the pipeline has not reached, and the join decides later.
  it("marks an entry whose unit could not be confirmed", async () => {
    mocked.mockResolvedValue(payload([entry({ unitCheck: "unverified" })]));

    renderWithQuery(
      <QualityEntriesSheet address={qualityAddress(lineReport())} open onOpenChange={vi.fn()} />,
    );

    expect(await screen.findByText(/unit unconfirmed/i)).toBeTruthy();
  });

  it("says so when nothing has been entered", async () => {
    mocked.mockResolvedValue(payload([]));

    renderWithQuery(
      <QualityEntriesSheet address={qualityAddress(lineReport())} open onOpenChange={vi.fn()} />,
    );

    expect(await screen.findByText(/nothing has been recorded by hand/i)).toBeTruthy();
  });
});
