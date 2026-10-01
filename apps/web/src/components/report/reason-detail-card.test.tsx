import { Component } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen, waitFor } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { downtimeItem, shiftReport } from "@/test/fixtures";
import { ReasonDetailCard } from "@/components/report/reason-detail-card";

import type { PageMeta, ReasonDetail } from "@/lib/types";

// Which state the card SELECTS, for the reason reason-pareto-card.test.tsx
// gives: five of the six states render no table at all, and two of them mean
// opposite things about the same empty result.
//
// The clip arithmetic and the reason filter behind these numbers are covered
// against a real Postgres in the API's downtime-repository.integration.test.ts.
// These assert the mapping from state to what a reader actually sees.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getReasonDetail: vi.fn(),
  // Mocked only so the Changes History sheet's request can be inspected — it is
  // the one other place this card sends the category, and it used to send its own
  // hardcoded literal.
  getReasonHistory: vi.fn(),
}));

const { getReasonDetail, getReasonHistory } = await import("@/lib/api");
const mocked = vi.mocked(getReasonDetail);
const mockedHistory = vi.mocked(getReasonHistory);

const MINUTE = 60_000;

const META: PageMeta = {
  page: 1,
  size: 5,
  totalElements: 2,
  totalPages: 1,
  first: true,
  last: true,
};

function detail(overrides: Partial<ReasonDetail> = {}): ReasonDetail {
  return {
    from: "2026-08-09T00:00:00.000Z",
    to: "2026-08-09T08:00:00.000Z",
    timeZone: "Asia/Jakarta",
    category: "UNPLANNED",
    bucket: {
      reason: "Ganti Film",
      workUnitNames: ["Vertical Packer MJCL"],
      frequency: 2,
      durationMs: 13 * MINUTE + 44_000,
    },
    items: [
      downtimeItem({ id: 1, sourceEventId: "2ff9d891-5554-4e5a-8de1", actions: ["Ganti Film"] }),
      downtimeItem({ id: 2, sourceEventId: "3caf13b7-bb7b-47c8-89cf", maintainedBy: "Operator" }),
    ],
    loadedThrough: "2026-08-10",
    ...overrides,
  };
}

const LABELLED = { kind: "labelled", reason: "Ganti Film" } as const;

// An axios-shaped rejection, which is what isNotFoundError inspects. A plain
// Error must NOT be mistaken for a missing reason.
function axios404() {
  return Object.assign(new Error("Request failed with status code 404"), {
    isAxiosError: true,
    response: { status: 404 },
  });
}

// Stands in for the route's notFoundComponent. The card escalates a 404 by
// THROWING, so without a boundary the throw would fail the test rather than be
// observable — this is the smallest thing that makes "it escalated" assertable.
class NotFoundBoundary extends Component<{ children: React.ReactNode }, { caught: boolean }> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render() {
    return this.state.caught ? <p>escalated to not-found</p> : this.props.children;
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReasonDetailCard", () => {
  it("renders the summary from the server's bucket, not from the visible rows", async () => {
    // The rows on this page sum to 12 minutes; the bucket says 13m44s because
    // it counts every stop in the reason, not just the ones on page one. If the
    // card ever derives the summary from `items`, this is what catches it.
    mocked.mockResolvedValue({ detail: detail(), meta: { ...META, totalElements: 9 } });

    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="UNPLANNED" />,
    );

    expect(await screen.findByText("13 m 44 s")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getAllByText(/UNPLANNED/).length).toBeGreaterThan(0);
  });

  it("lists the stops with their public id and action chips", async () => {
    mocked.mockResolvedValue({ detail: detail(), meta: META });

    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="UNPLANNED" />,
    );

    expect(await screen.findByText("2ff9d891-5554-4e5a-8de1")).toBeTruthy();
    expect(screen.getByText("3caf13b7-bb7b-47c8-89cf")).toBeTruthy();
    expect(screen.getByText("Operator")).toBeTruthy();
  });

  it("passes the selector through to the request rather than a label", async () => {
    mocked.mockResolvedValue({ detail: detail(), meta: META });

    renderWithQuery(
      <ReasonDetailCard
        report={shiftReport()}
        selector={{ kind: "unlabelled" }}
        category="UNPLANNED"
      />,
    );

    await waitFor(() => {
      expect(mocked).toHaveBeenCalledWith(
        expect.objectContaining({ selector: { kind: "unlabelled" }, category: "UNPLANNED" }),
      );
    });
  });

  // THE REGRESSION THIS SUITE EXISTS FOR. A query gated with `enabled: false`
  // reports `status: "pending"` forever, so a ladder reading isPending first
  // renders a skeleton that never resolves. Asserting the skeleton is GONE is
  // the assertion — rendering the message AND the skeleton is exactly the state
  // the bug produced, so a message-only check would pass on the broken version.
  it("renders a message and no skeleton when the shift's date cannot be read", async () => {
    const { container } = renderWithQuery(
      <ReasonDetailCard
        report={shiftReport({ date: "not-a-date" })}
        selector={LABELLED}
        category="UNPLANNED"
      />,
    );

    // findAll, not find: the banner and the table's empty row deliberately
    // carry the same sentence, so the two can never tell different stories
    // about one empty result.
    expect(await screen.findAllByText(/date could not be read/i)).toBeTruthy();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });

  it("says so when the request fails, rather than showing an empty table", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    renderWithQuery(
      <NotFoundBoundary>
        <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="UNPLANNED" />
      </NotFoundBoundary>,
    );

    // A real fault STAYS on the card — it is retryable, and a missing-reason
    // page would hide an outage behind "this does not exist".
    expect(await screen.findAllByText(/could not load the stops/i)).toBeTruthy();
    expect(screen.queryByText(/escalated to not-found/i)).toBeNull();
  });

  // A reason that names nothing is a broken link, not a fault. Rendering the
  // card's retry banner would invite a retry that can never succeed.
  it("escalates a 404 to the route's not-found boundary instead of its error banner", async () => {
    mocked.mockRejectedValue(axios404());

    renderWithQuery(
      <NotFoundBoundary>
        <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="UNPLANNED" />
      </NotFoundBoundary>,
    );

    expect(await screen.findByText(/escalated to not-found/i)).toBeTruthy();
    expect(screen.queryByText(/could not load the stops/i)).toBeNull();
  });

  // The two empty states that look identical and mean opposite things.
  it("distinguishes a genuinely empty reason from one the pipeline has not reached", async () => {
    const empty = {
      bucket: { reason: "Ganti Film", workUnitNames: [], frequency: 0, durationMs: 0 },
      items: [],
    };

    mocked.mockResolvedValue({
      detail: detail({ ...empty, loadedThrough: "2026-08-10" }),
      meta: META,
    });
    const loaded = renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="UNPLANNED" />,
    );
    expect(await screen.findAllByText(/no stops recorded/i)).toBeTruthy();
    loaded.unmount();
    cleanup();

    mocked.mockResolvedValue({ detail: detail({ ...empty, loadedThrough: null }), meta: META });
    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="UNPLANNED" />,
    );
    expect(await screen.findAllByText(/not loaded yet/i)).toBeTruthy();
  });

  // ---- Schedule Loss: the same card, opened from the PLANNED Pareto ----

  // The category used to be a literal in this card, so the request went out as
  // UNPLANNED no matter which bar was clicked. That is the bug this pins: a
  // planned reason listing unplanned stops, with nothing on screen saying so.
  it("requests the category the page was opened for", async () => {
    mocked.mockResolvedValue({ detail: detail({ category: "PLANNED" }), meta: META });

    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="PLANNED" />,
    );

    await waitFor(() => {
      expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ category: "PLANNED" }));
    });
  });

  // EXACT MATCHERS, NOT /PLANNED/. That regex matches "UNPLANNED" too, so it
  // would pass against the un-fixed component and prove nothing. The full-string
  // match plus the absence check is what actually distinguishes them.
  it("labels the summary tile with that category, not the shipped default", async () => {
    mocked.mockResolvedValue({ detail: detail({ category: "PLANNED" }), meta: META });

    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="PLANNED" />,
    );

    expect(await screen.findByText("PLANNED")).toBeTruthy();
    expect(screen.queryByText("UNPLANNED")).toBeNull();
  });

  // A class assertion is normally too brittle to earn its place, but this exact
  // token was hardcoded on the duration until now, so it is the thing being fixed.
  it("colours the duration with that category's ramp", async () => {
    mocked.mockResolvedValue({ detail: detail({ category: "PLANNED" }), meta: META });

    const { container } = renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="PLANNED" />,
    );

    await screen.findByText("PLANNED");
    expect(container.querySelector(".text-oee-planned-downtime-fg")).toBeTruthy();
    expect(container.querySelector(".text-oee-unplanned-downtime-fg")).toBeNull();
  });

  it("reconciles against Schedule Loss rather than Availability Loss", async () => {
    mocked.mockResolvedValue({ detail: detail({ category: "PLANNED" }), meta: META });

    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="PLANNED" />,
    );

    expect(await screen.findByText(/not to the schedule loss figure/i)).toBeTruthy();
    expect(screen.queryByText(/availability loss/i)).toBeNull();
  });

  // The Changes History sheet keys and requests on the same identity as the table.
  // If it kept the old literal, the history panel would answer for a different
  // loss than the page it opens from.
  it("opens its history for that category too", async () => {
    mocked.mockResolvedValue({ detail: detail({ category: "PLANNED" }), meta: META });

    renderWithQuery(
      <ReasonDetailCard report={shiftReport()} selector={LABELLED} category="PLANNED" />,
    );

    (await screen.findByRole("button", { name: /view history/i })).click();

    await waitFor(() => {
      expect(mockedHistory).toHaveBeenCalledWith(expect.objectContaining({ category: "PLANNED" }));
    });
  });
});
