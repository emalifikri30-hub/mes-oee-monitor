import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { ActivityLogSheet } from "@/components/report/activity-log-sheet";

import type { ActivityEntry, ActivitySource, ShiftActivity } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportActivity: vi.fn(),
  // The coarse feeds' fetcher, mocked so the day and month cases below can assert
  // WHICH one answered. The two take ids from different sequences, so a shift-keyed
  // read on a day report's id renders another shift's chronology and looks fine.
  getPeriodReportActivity: vi.fn(),
}));

const { getShiftReportActivity, getPeriodReportActivity } = await import("@/lib/api");
const mocked = vi.mocked(getShiftReportActivity);
const mockedPeriod = vi.mocked(getPeriodReportActivity);

const TRACKED_APPROVAL: ActivitySource = {
  kind: "approval",
  tracked: true,
  untrackedReason: null,
  totalMembers: 1,
  trackedMembers: 1,
};

const UNTRACKED_APPROVAL: ActivitySource = {
  kind: "approval",
  tracked: false,
  untrackedReason: "not-implemented",
  totalMembers: 1,
  trackedMembers: 0,
};

// Today's real state: three stops, none carrying a source_event_id.
const UNTRACKED_DOWNTIME: ActivitySource = {
  kind: "downtime",
  tracked: false,
  untrackedReason: "no-stable-id",
  totalMembers: 3,
  trackedMembers: 0,
};

// The arm that can NEVER carry a row.
const UNTRACKED_QUALITY: ActivitySource = {
  kind: "quality",
  tracked: false,
  untrackedReason: "no-source",
  totalMembers: 0,
  trackedMembers: 0,
};

// `by` is the Keycloak SUBJECT, as it really arrives — a UUID, not a name.
// Writing a readable string here would have hidden the bug this fixture now
// guards: the panel used to render `by` and put the UUID on screen.
const APPROVAL_ENTRY: ActivityEntry = {
  kind: "approval",
  id: "approval:41",
  at: "2026-08-09T09:00:00.000Z",
  by: "4f3c1a8e-2b71-4d0e-9c55-a1b2c3d4e5f6",
  byName: "dewi",
  // Null: this is a SHIFT report's own feed, where naming the shift is noise.
  // The day/month case is covered separately below.
  shift: null,
  fromStatus: "open",
  toStatus: "closed",
  source: "operator",
};

// An operator-entered reject, attributed to THIS machine. `shift` is a number
// because this fixture is used on the day and month feeds; the shift feed sends
// null there and the test below pins that.
const QUALITY_ENTRY: ActivityEntry = {
  kind: "quality",
  id: "quality:5",
  at: "2026-08-01T03:00:00.000Z",
  by: "kc-1",
  byName: "Operator One",
  entryKind: "reject",
  enteredQty: 10,
  enteredUomCode: "CTN",
  targetQty: 120,
  targetUomCode: "BAG",
  productName: "Kacang Garuda 20g",
  reasonName: "Burst seal",
  shift: 2,
  voidedAt: null,
  voidedBy: null,
  voidedByName: null,
  voidReason: null,
};

const TRACKED_QUALITY: ActivitySource = {
  kind: "quality",
  tracked: true,
  untrackedReason: null,
  totalMembers: 1,
  trackedMembers: 1,
};

const DOWNTIME_ENTRY: ActivityEntry = {
  kind: "downtime",
  id: "downtime:912",
  at: "2026-08-09T11:00:00.000Z",
  by: "bagus",
  sourceEventId: "evt-a",
  field: "actions",
  oldValue: null,
  newValue: ["Ganti Film", "Cleaning"],
};

function activity(overrides: Partial<ShiftActivity> = {}): ShiftActivity {
  return {
    timeZone: "Asia/Jakarta",
    entries: [],
    sources: [UNTRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
    ...overrides,
  };
}

function render(open = true) {
  return renderWithQuery(
    <ActivityLogSheet
      reportId={7}
      grain="shift"
      timeZone="Asia/Jakarta"
      open={open}
      onOpenChange={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityLogSheet", () => {
  // THE STATE EVERY REPORT WAS IN BEFORE APPROVE SHIPPED, and the direct mirror
  // of ChangesHistorySheet's flagship test. "No activity recorded" would be a
  // claim about the data; the truth is that nothing about this report could ever
  // have been recorded.
  it("says nothing is tracked rather than 'no activity' when every arm is untracked", async () => {
    mocked.mockResolvedValue(activity());

    render();

    expect(await screen.findByText(/not tracked/i)).toBeTruthy();
    expect(screen.queryByText(/no activity recorded/i)).toBeNull();
  });

  it("says 'no activity' only once an arm could have carried something", async () => {
    mocked.mockResolvedValue(
      activity({ sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY] }),
    );

    render();

    expect(await screen.findByText(/no activity recorded/i)).toBeTruthy();
    // The untracked arms are still named — the report is not fully covered just
    // because one arm is.
    expect(screen.getByText(/quality and defects/i)).toBeTruthy();
  });

  // THE MOST IMPORTANT ASSERTION IN THIS FILE.
  //
  // Once approvals start writing entries the chronology looks complete while the
  // quality half is still missing entirely. If the "Not tracked" list were
  // rendered only in the empty case, the panel would begin lying on the exact
  // day the feature started working — and every other test here would stay green.
  it("keeps the untracked quality row visible even with a populated chronology", async () => {
    mocked.mockResolvedValue(
      activity({
        entries: [APPROVAL_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    expect(await screen.findByText(/approved/i)).toBeTruthy();
    expect(screen.getByText(/quality and defects/i)).toBeTruthy();
    expect(screen.getByText(/cannot be edited here/i)).toBeTruthy();
  });

  it("renders entries in the order the server merged them", async () => {
    // The server computes one total order across two tables. A client-side
    // re-sort would be a second opinion about it, so assert DOM ORDER rather
    // than mere presence.
    mocked.mockResolvedValue(
      activity({
        entries: [DOWNTIME_ENTRY, APPROVAL_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    const items = await screen.findAllByRole("listitem");
    expect(items[0]?.textContent).toMatch(/Downtime · actions/);
    expect(items[1]?.textContent).toMatch(/Approved/);
  });

  it("renders a jsonb array without leaking [object Object]", async () => {
    mocked.mockResolvedValue(
      activity({
        entries: [DOWNTIME_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    expect(await screen.findByText(/Ganti Film, Cleaning/)).toBeTruthy();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it("gives an approval its own vocabulary rather than a field change", async () => {
    mocked.mockResolvedValue(
      activity({
        entries: [APPROVAL_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    // "Open → Closed", not a field named `status`, which is a column that does
    // not exist on the report.
    expect(await screen.findByText(/open/i)).toBeTruthy();
    expect(screen.getByText(/closed/i)).toBeTruthy();
  });

  it("names the approver, not their Keycloak subject", async () => {
    // REGRESSION GUARD. The first version of this panel rendered `entry.by`,
    // which is the subject — so an operator saw "by 4f3c1a8e-2b71-…" after
    // approving. The name is what a chronology is for.
    mocked.mockResolvedValue(
      activity({
        entries: [APPROVAL_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    expect(await screen.findByText(/by dewi/i)).toBeTruthy();
    expect(screen.queryByText(/4f3c1a8e/)).toBeNull();
  });

  it("falls back to the subject when no name was captured", async () => {
    // A UUID is poor; "by —" on an audited action is worse.
    mocked.mockResolvedValue(
      activity({
        entries: [{ ...APPROVAL_ENTRY, byName: null }],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    expect(await screen.findByText(/4f3c1a8e/)).toBeTruthy();
  });

  it("names the system for a transition nobody made", async () => {
    // The deferred 14-day auto-close (TODOS.md §31) writes by_subject NULL, and
    // ck_wusrae_actor guarantees that only happens for source='system'.
    mocked.mockResolvedValue(
      activity({
        entries: [{ ...APPROVAL_ENTRY, by: null, byName: null, source: "system" }],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, UNTRACKED_QUALITY],
      }),
    );

    render();

    expect(await screen.findByText(/by the system/i)).toBeTruthy();
  });

  it("issues no request until it is opened", async () => {
    // The gated-query trap: `enabled: false` reports pending forever, so the
    // ladder reads `open` before `isPending`. This asserts the other half — that
    // a closed sheet costs nothing.
    mocked.mockResolvedValue(activity());

    render(false);

    expect(mocked).not.toHaveBeenCalled();
  });

  it("reports a failure rather than an empty trail", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    render();

    expect(await screen.findByText(/could not load the activity/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The coarse grains
// ---------------------------------------------------------------------------
//
// TODOS §64's half, from the browser's side. Two things were wrong together and
// each hid the other: the server's day and month feeds had no quality arm, and this
// app's own `ActivityEntry` type had no quality MEMBER — so when the arm shipped,
// `machineContext` (typed against that union) could not see a `shift` field the
// union did not declare, and the suffix was silently dropped.
//
// The result on screen: two 120 BAG rejects against one machine on different shifts
// rendering as one entry twice. Nothing errored, and no test failed.
describe("ActivityLogSheet at day and month grain", () => {
  function renderPeriod(grain: "day" | "month") {
    return renderWithQuery(
      <ActivityLogSheet
        reportId={9}
        grain={grain}
        timeZone="Asia/Jakarta"
        open
        onOpenChange={() => {}}
      />,
    );
  }

  // WHICH FETCHER ANSWERED, and with which grain. The three feeds share an
  // envelope, so a wrong pick is a populated panel about another report.
  it.each(["day", "month"] as const)(
    "reads the %s-grain feed, not the shift one",
    async (grain) => {
      mockedPeriod.mockResolvedValue(activity());

      renderPeriod(grain);

      await screen.findByText(/not tracked/i);
      expect(mockedPeriod).toHaveBeenCalledWith(grain, 9);
      expect(mocked).not.toHaveBeenCalled();
    },
  );

  // THE SUFFIX ON A QUALITY ENTRY, which is the regression this block exists for.
  // A day feed spans three shifts, and the shift is the only thing that separates
  // two identical entries.
  it("labels a quality entry with its shift", async () => {
    mockedPeriod.mockResolvedValue(
      activity({
        entries: [QUALITY_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, TRACKED_QUALITY],
      }),
    );

    renderPeriod("day");

    expect((await firstEntry()).textContent).toMatch(/· shift 2/);
  });

  // BOTH QUANTITIES when the units differ, which is the ledger's own rule — an
  // operator who typed 10 cartons has to recognise their entry in a feed otherwise
  // denominated in bags. Asserted here as well as at line grain because the machine
  // feed reaches this renderer through a different type.
  it("renders what was typed and what it converted to", async () => {
    mockedPeriod.mockResolvedValue(
      activity({
        entries: [QUALITY_ENTRY],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, TRACKED_QUALITY],
      }),
    );

    renderPeriod("day");

    const item = await firstEntry();
    expect(item.textContent).toMatch(/10 CTN = 120 BAG/);
    // NOT the downtime arm's vocabulary. Before the renderer grew a third branch a
    // quality entry fell through to "— → —" under the heading "Downtime ·
    // undefined"; the type is what makes that unreachable now, and this is the
    // behavioural half of the same guard.
    expect(item.textContent).not.toMatch(/Downtime/);
  });

  // AND NULL ON A SHIFT REPORT'S OWN FEED, where the suffix would be noise on every
  // row. Asserted beside the case above so the two cannot be "made consistent" in
  // the wrong direction.
  it("omits the suffix on a shift report's own quality entry", async () => {
    mocked.mockResolvedValue(
      activity({
        entries: [{ ...QUALITY_ENTRY, shift: null }],
        sources: [TRACKED_APPROVAL, UNTRACKED_DOWNTIME, TRACKED_QUALITY],
      }),
    );

    render();

    const item = await firstEntry();
    expect(item.textContent).toMatch(/10 CTN = 120 BAG/);
    expect(item.textContent).not.toMatch(/shift/);
  });
});

// THE FIRST ROW OF THE CHRONOLOGY, and a plain findByRole("listitem") does not get
// it: the "Not tracked" section is a <ul> of <li> too — deliberately, since it
// renders REGARDLESS of whether the list above has rows, so an untracked arm can
// never be hidden by a populated one. The query therefore matches several and
// throws.
//
// INDEX 0 IS THE ENTRY because the <ol> of entries precedes that <ul> in the DOM,
// which is the reading order the panel is laid out in. The explicit undefined check
// is what turns "the feed rendered nothing" into that sentence rather than into a
// property access on undefined three lines later.
async function firstEntry(): Promise<HTMLElement> {
  const entry = (await screen.findAllByRole("listitem"))[0];
  if (entry === undefined) throw new Error("the feed rendered no entries");
  return entry;
}
