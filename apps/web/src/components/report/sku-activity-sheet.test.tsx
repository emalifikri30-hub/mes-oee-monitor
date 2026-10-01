import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderWithQuery } from "@/test/render";
import { SkuActivitySheet } from "@/components/report/sku-activity-sheet";

// The SKU day feed's PANEL, and specifically the two things this subject decides
// for itself: what disambiguates an entry, and how the approval arm's permanent
// absence is stated.
//
// The panel's own states — pending, error, "nothing is tracked" vs "no activity",
// the rule that an untracked arm survives a populated chronology — are pinned in
// activity-log-sheet.test.tsx over the machine feed, and that component is
// unchanged here. This file does not repeat them.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getSkuActivity: vi.fn(),
}));

const { getSkuActivity } = await import("@/lib/api");
const mocked = vi.mocked(getSkuActivity);

const SOURCES = [
  {
    kind: "approval" as const,
    tracked: false,
    untrackedReason: "not-applicable" as const,
    totalMembers: 0,
    trackedMembers: 0,
  },
  {
    kind: "downtime" as const,
    tracked: true,
    untrackedReason: null,
    totalMembers: 2,
    trackedMembers: 2,
  },
  {
    kind: "quality" as const,
    tracked: true,
    untrackedReason: null,
    totalMembers: 1,
    trackedMembers: 1,
  },
];

const ENTRY = {
  kind: "quality" as const,
  id: "quality:7",
  at: "2026-08-19T12:00:00.000Z",
  by: "kc-2",
  byName: "Operator Two",
  shift: 2,
  entryKind: "reject",
  productName: "SKU A",
  reasonName: "Burst seal",
  enteredQty: 120,
  enteredUomCode: "BAG",
  targetQty: 120,
  targetUomCode: "BAG",
  unitCheck: "verified",
  voidedAt: null,
  voidedBy: null,
  voidedByName: null,
  voidReason: null,
};

const EDIT = {
  kind: "downtime" as const,
  id: "downtime:1",
  at: "2026-08-19T09:00:00.000Z",
  by: "kc-1",
  sourceEventId: "evt-1",
  field: "category",
  oldValue: "PLANNED",
  newValue: "UNPLANNED",
  workUnitId: 5,
  workUnitName: "Vertical Packer",
};

function feed(over: Record<string, unknown> = {}) {
  return {
    timeZone: "Asia/Jakarta",
    entries: [ENTRY, EDIT],
    sources: SOURCES,
    unattributed: 0,
    ...over,
  } as never;
}

function render() {
  return renderWithQuery(
    <SkuActivitySheet reportId={79} timeZone="Asia/Jakarta" open onOpenChange={vi.fn()} />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkuActivitySheet — what disambiguates an entry", () => {
  // THE THIRD DISTINCT ANSWER to the same question, and the reason it is per-ARM
  // rather than per-feed: a SKU day spans BOTH three shifts and N machines, so no
  // single axis serves it. A quality entry's discriminator is its SHIFT (a rework
  // carries no machine at all); a downtime edit carries a machine and no shift.
  it("labels a quality entry with its shift", async () => {
    mocked.mockResolvedValue(feed());

    render();

    expect(await screen.findByText(/· shift 2/)).toBeTruthy();
  });

  it("labels a downtime edit with its machine", async () => {
    mocked.mockResolvedValue(feed());

    render();

    expect(await screen.findByText(/· Vertical Packer/)).toBeTruthy();
  });

  // A NUMBERED MACHINE IS STILL AN ANSWER, where a bare "Downtime" three times
  // over is not. Same fallback lineContext uses.
  it("falls back to the machine's id when it has no name", async () => {
    mocked.mockResolvedValue(feed({ entries: [{ ...EDIT, workUnitName: null }] }));

    render();

    expect(await screen.findByText(/· machine 5/)).toBeTruthy();
  });
});

describe("SkuActivitySheet — the approval arm", () => {
  // NOT "NOT YET". The panel exists to separate "nothing was recorded" from
  // "nothing COULD be recorded", and this arm is the second — a SKU report has no
  // sign-off of its own, now or ever.
  it("says why no approval can appear, beside a populated chronology", async () => {
    mocked.mockResolvedValue(feed());

    render();

    // The populated list AND the untracked arm — the rule activity-log-view.tsx
    // defends hardest: an untracked arm must never be hidden by a populated one.
    expect(await screen.findByText(/· shift 2/)).toBeTruthy();
    expect(screen.getByText("Approvals")).toBeTruthy();
    expect(screen.getByText(/no sign-off of its own/i)).toBeTruthy();
  });

  // AND IT MUST NOT REUSE THE QUALITY SENTENCE, which is about reject and rework
  // figures being the pipeline's — a visible mislabel under this heading.
  it("does not print the reject-and-rework sentence under Approvals", async () => {
    mocked.mockResolvedValue(feed());

    render();

    await screen.findByText("Approvals");
    expect(screen.queryByText(/produced by the data pipeline and cannot be edited/i)).toBeNull();
  });
});
