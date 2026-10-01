import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen, waitFor } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { shiftReport } from "@/test/fixtures";
import { ReasonParetoCard } from "@/components/report/reason-pareto-card";

import type { DowntimeReasonBreakdown } from "@/lib/types";

// Which state the card SELECTS is the part no pure function can reach, and it is
// where this card's real risk lives — five of its six states render no chart at
// all, and two of them mean opposite things about the same empty result.
//
// The arithmetic behind the chart is covered exhaustively in lib/pareto.test.ts.
// These assert the mapping from state to what a reader actually sees.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getDowntimeReasons: vi.fn(),
}));

const { getDowntimeReasons } = await import("@/lib/api");
const mocked = vi.mocked(getDowntimeReasons);

const MINUTE = 60_000;

function breakdown(overrides: Partial<DowntimeReasonBreakdown> = {}): DowntimeReasonBreakdown {
  return {
    from: "2026-08-09T00:00:00.000Z",
    to: "2026-08-09T08:00:00.000Z",
    timeZone: "Asia/Jakarta",
    category: "UNPLANNED",
    buckets: [
      {
        reason: "Mlipit",
        workUnitNames: ["Vertical Packer MJCL"],
        frequency: 3,
        durationMs: 47 * MINUTE,
      },
      {
        reason: "Ganti Film",
        workUnitNames: ["Vertical Packer MJCL"],
        frequency: 1,
        durationMs: 10 * MINUTE,
      },
    ],
    // No tail: these fixtures return every bucket.
    other: null,
    totalFrequency: 4,
    totalDurationMs: 57 * MINUTE,
    loadedThrough: "2026-08-10",
    ...overrides,
  };
}

// The Schedule Loss tab's payload. Distinct reasons from `breakdown()` above, so
// a test can tell WHICH cache entry a card read rather than only that it read one.
function plannedBreakdown(
  overrides: Partial<DowntimeReasonBreakdown> = {},
): DowntimeReasonBreakdown {
  return breakdown({
    category: "PLANNED",
    buckets: [
      {
        reason: "Cleaning",
        workUnitNames: ["Vertical Packer MJCL"],
        frequency: 2,
        durationMs: 30 * MINUTE,
      },
    ],
    totalFrequency: 2,
    totalDurationMs: 30 * MINUTE,
    ...overrides,
  });
}

// The params the card is expected to key and request on, per lib/queries.ts's
// `reasonBreakdownParams`. Written out here because the seeded-cache test below
// only means something if the key it seeds is the key the card subscribes to.
const SHIFT = {
  scope: "work-unit",
  scopeId: 42,
  // In the key because it is in the params, and the params ARE the key. A day
  // and a shift request for the same date would otherwise collide in the cache.
  grain: "shift",
  date: "2026-08-09",
  shift: "1",
  // AND SO IS THE MEASURE, since the endpoint started returning the top N by it
  // (TODOS §25). "duration" is what the card opens on and what the loader
  // prefetches — DEFAULT_REASON_MEASURE, shared so the two cannot drift.
  measure: "duration",
} as const;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReasonParetoCard", () => {
  it("lists the reasons once the breakdown arrives", async () => {
    mocked.mockResolvedValue(breakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    expect(await screen.findByText("Mlipit")).toBeTruthy();
    expect(screen.getByText("Ganti Film")).toBeTruthy();
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "work-unit",
        scopeId: 42,
        grain: "shift",
        date: "2026-08-09",
        shift: "1",
        category: "UNPLANNED",
      }),
    );
  });

  it("keeps a failure inside the card", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    // Twice, deliberately: the chart area and the table underneath it carry the
    // same sentence, so the two halves of the card cannot tell the reader
    // different stories about one result.
    expect(
      await screen.findAllByText(/could not load the unplanned downtime breakdown/i),
    ).toHaveLength(2);
  });

  // THE DISTINCTION THE WATERMARK EXISTS FOR. These two look identical on screen
  // unless the card says which one it is, and the flattering reading is the
  // wrong one.
  it("calls an empty shift clean when the pipeline has reached it", async () => {
    mocked.mockResolvedValue(breakdown({ buckets: [], loadedThrough: "2026-08-10" }));

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    expect(await screen.findAllByText(/no unplanned downtime recorded/i)).toHaveLength(2);
  });

  it.each([
    ["behind the shift", "2026-08-08"],
    ["never stamped", null],
  ])("says not loaded when the watermark is %s", async (_label, loadedThrough) => {
    mocked.mockResolvedValue(breakdown({ buckets: [], loadedThrough }));

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    expect(await screen.findAllByText(/not loaded yet/i)).toHaveLength(2);
    expect(screen.queryByText(/no unplanned downtime recorded/i)).toBeNull();
  });

  // The same bug the timeline card had: a gated query reports pending forever,
  // so a card reading isPending first loads a skeleton that never resolves.
  it("explains an unreadable date instead of loading forever", async () => {
    mocked.mockResolvedValue(breakdown());

    const { container } = renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport({ date: "" })}
        category="UNPLANNED"
      />,
    );

    expect(await screen.findAllByText(/date could not be read/i)).not.toHaveLength(0);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });

  // Two independent sources that will not reconcile. Without this sentence the
  // obvious next question has no answer on screen.
  it("says the totals need not match the report's Availability Loss", async () => {
    mocked.mockResolvedValue(breakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    expect(await screen.findByText(/need not match the availability loss figure/i)).toBeTruthy();
  });

  // A work unit IS one machine, so the filter is inert — but the control is part
  // of the design and becomes real at work-center scope.
  it("offers this report's machine alongside All Machine", async () => {
    mocked.mockResolvedValue(breakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    expect(screen.getByLabelText("Filter by machine")).toBeTruthy();
    expect(await screen.findByText("All Machine")).toBeTruthy();
  });

  // THE TOGGLE IS A REQUEST NOW, and this assertion is the inverse of the one it
  // replaces.
  //
  // It used to assert the opposite — that re-ranking never asked the server again
  // — and that was correct while the endpoint returned every bucket: the card held
  // them all and re-ranked with a reduce. The endpoint is truncated now and returns
  // the top N BY THE REQUESTED MEASURE, so the ten it sent for duration are not
  // the ten it would send for frequency. Re-ranking the duration set by frequency
  // would draw the wrong bars under a cumulative line that still looked plausible,
  // which is exactly the failure a truncation is supposed to make visible.
  //
  // So the round trip is the correct behaviour and is asserted as such. It is paid
  // once per measure: each is its own cache entry, and toggling back is instant.
  it("refetches when the measure changes, because the server picks the top N", async () => {
    mocked.mockResolvedValue(breakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );
    await screen.findByText("Mlipit");
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]?.[0]).toMatchObject({ measure: "duration" });

    screen.getByLabelText("frequency").click();

    await waitFor(() => {
      expect(mocked).toHaveBeenCalledTimes(2);
    });
    expect(mocked.mock.calls[1]?.[0]).toMatchObject({ measure: "frequency" });
  });

  // The row action is the feature's entry point, so what it POINTS AT is the
  // assertion. It carries the raw reason, not the rendered label.
  //
  // THIS HREF AND THE ONE BELOW ARE UNCHANGED from before the card was
  // generalised over `category`, and that is deliberate: UNPLANNED is the parse's
  // default and is omitted from the URL, so every availability link already
  // shared stays byte-identical. If either of these ever needs a `category=`
  // added, that contract has been broken.
  it("links each row to the stops behind that reason", async () => {
    mocked.mockResolvedValue(breakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport({ id: 77 })}
        category="UNPLANNED"
      />,
    );

    const links = await screen.findAllByRole("link", {
      name: /view the downtime records behind/i,
    });
    expect(links).toHaveLength(2);

    const hrefs = links.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/report/machine/by-shift/77/losses/detail?reason=Mlipit");
    expect(hrefs).toContain("/report/machine/by-shift/77/losses/detail?reason=Ganti+Film");
  });

  // THE TRAP, as a test. The unlabelled bucket is `reason: null` over the wire
  // and renders as "Unspecified" — a label lib/pareto.ts applies so a genuine
  // reason of that text cannot merge into it. A link built from the label would
  // match nothing server-side, or match the wrong stops, and the page would look
  // entirely reasonable either way. It must travel as `unlabelled=true`.
  it("links the unlabelled bucket by flag, never by the word Unspecified", async () => {
    mocked.mockResolvedValue(
      breakdown({
        buckets: [
          {
            reason: null,
            workUnitNames: ["Vertical Packer MJCL"],
            frequency: 2,
            durationMs: 60_000,
          },
        ],
        totalFrequency: 2,
        totalDurationMs: 60_000,
      }),
    );

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport({ id: 77 })}
        category="UNPLANNED"
      />,
    );

    const link = await screen.findByRole("link", {
      name: /view the downtime records behind/i,
    });
    expect(link.getAttribute("href")).toBe(
      "/report/machine/by-shift/77/losses/detail?unlabelled=true",
    );
    expect(link.getAttribute("href")).not.toMatch(/reason=/);
  });

  // ---- Schedule Loss: the same card over `category=PLANNED` ----

  it("requests the planned breakdown for the Schedule Loss tab", async () => {
    mocked.mockResolvedValue(plannedBreakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="PLANNED"
      />,
    );

    expect(await screen.findByText("Cleaning")).toBeTruthy();
    expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ category: "PLANNED" }));
    expect(await screen.findByText("Planned Downtime Pareto")).toBeTruthy();
  });

  // The whole risk of rendering two tabs from one component: every sentence in
  // this card was written about unplanned downtime, and each one is entirely
  // plausible in the wrong tab. Asserting the absence of "unplanned" is what
  // catches a half-wired copy record — the planned string alone would pass even
  // if a sibling sentence still said unplanned.
  it("says planned, never unplanned, in its empty states", async () => {
    mocked.mockResolvedValue(plannedBreakdown({ buckets: [], loadedThrough: "2026-08-10" }));

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="PLANNED"
      />,
    );

    expect(await screen.findAllByText(/no planned downtime recorded/i)).toHaveLength(2);
    expect(screen.queryByText(/unplanned/i)).toBeNull();
  });

  it("says planned, never unplanned, when the request fails", async () => {
    mocked.mockRejectedValue(new Error("boom"));

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="PLANNED"
      />,
    );

    expect(
      await screen.findAllByText(/could not load the planned downtime breakdown/i),
    ).toHaveLength(2);
    expect(screen.queryByText(/unplanned/i)).toBeNull();
  });

  // Pointing a Schedule Loss reader at the Availability Loss tile would invite
  // exactly the arithmetic the footnote exists to head off.
  it("reconciles against Schedule Loss rather than Availability Loss", async () => {
    mocked.mockResolvedValue(plannedBreakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="PLANNED"
      />,
    );

    expect(await screen.findByText(/need not match the schedule loss figure/i)).toBeTruthy();
    expect(screen.queryByText(/availability loss/i)).toBeNull();
  });

  // Read through URL/searchParams rather than string equality, so the assertion
  // does not pin the order the router happens to serialise two params in.
  it("carries a non-default category on the drill-down link", async () => {
    mocked.mockResolvedValue(plannedBreakdown());

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport({ id: 77 })}
        category="PLANNED"
      />,
    );

    const link = await screen.findByRole("link", { name: /view the downtime records behind/i });
    const url = new URL(link.getAttribute("href") ?? "", "http://test.invalid");

    expect(url.pathname).toBe("/report/machine/by-shift/77/losses/detail");
    expect(url.searchParams.get("reason")).toBe("Cleaning");
    expect(url.searchParams.get("category")).toBe("PLANNED");
  });

  it("carries the category alongside the unlabelled flag, not instead of it", async () => {
    mocked.mockResolvedValue(
      plannedBreakdown({
        buckets: [
          {
            reason: null,
            workUnitNames: ["Vertical Packer MJCL"],
            frequency: 1,
            durationMs: MINUTE,
          },
        ],
        totalFrequency: 1,
        totalDurationMs: MINUTE,
      }),
    );

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport({ id: 77 })}
        category="PLANNED"
      />,
    );

    const link = await screen.findByRole("link", { name: /view the downtime records behind/i });
    const url = new URL(link.getAttribute("href") ?? "", "http://test.invalid");

    expect(url.searchParams.get("unlabelled")).toBe("true");
    expect(url.searchParams.get("category")).toBe("PLANNED");
    expect(url.searchParams.has("reason")).toBe(false);
  });

  // THE BUG THIS CHANGE COULD MOST EASILY HAVE SHIPPED, and the only one that
  // would look entirely plausible on screen: keyed on the shift alone, the two
  // tabs share one cache entry and the second tab renders the first tab's rows.
  //
  // Seeding both entries covers the other half too, which is the silent one — if
  // the card composed its params differently from the loader, neither seed would
  // match and the card would fetch. `mocked` never being called is that proof.
  it("reads the entry its own category was prefetched under", async () => {
    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="PLANNED"
      />,
      {
        seed: [
          {
            queryKey: ["downtime-reasons", { ...SHIFT, category: "UNPLANNED" }],
            data: breakdown(),
          },
          {
            queryKey: ["downtime-reasons", { ...SHIFT, category: "PLANNED" }],
            data: plannedBreakdown(),
          },
        ],
      },
    );

    expect(await screen.findByText("Cleaning")).toBeTruthy();
    // The other tab's reasons, which a shared cache entry would have shown.
    expect(screen.queryByText("Mlipit")).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });

  // THE "OTHER" ROW HAS NOWHERE TO GO, and the failure it guards against is not a
  // broken link. Its `reason` is null, which is ALSO the unlabelled bucket's
  // value and a valid selector — so a link built from it would open the
  // UNSPECIFIED bucket's records under a heading saying "Other (37 reasons)",
  // with nothing on screen saying so.
  it("offers no drill-down on the truncated tail", async () => {
    mocked.mockResolvedValue(
      breakdown({
        other: { reasonCount: 37, frequency: 40, durationMs: 3_600_000 },
        totalFrequency: 100,
        totalDurationMs: 9_000_000,
      }),
    );

    renderWithQuery(
      <ReasonParetoCard
        detailTo="/report/machine/by-shift/$reportId/losses/detail"
        report={shiftReport()}
        category="UNPLANNED"
      />,
    );

    expect(await screen.findByText("Other (37 reasons)")).toBeTruthy();
    // Every other row keeps its eye; the tail's is inert and unnamed.
    expect(screen.queryByLabelText(/View the downtime records behind Other/)).toBeNull();
  });
});
