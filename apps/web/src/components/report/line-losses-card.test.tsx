import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { lineReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { LineLossesCard } from "@/components/report/line-losses-card";

// FOUR HOURLY FETCHERS MOCKED — the line's two and the MACHINE's two — so a swap
// on either axis fails. The grain axis is the one the dialog picks from; the
// subject axis is the one that compiles silently, because a line report's id is a
// real machine report's id on another sequence.
//
// The resolved values are inline because `vi.mock` is hoisted above every
// module-scope binding in this file: a shared const here is `undefined` at factory
// time, and the queries then reject on a null payload.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getLinePerformance: vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    buckets: [],
    loadedThrough: null,
    dayStartHour: 7,
  }),
  getLineHourProfile: vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    buckets: [],
    loadedThrough: null,
    dayStartHour: 7,
  }),
  getShiftReportPerformance: vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", buckets: [], loadedThrough: null }),
  getMonthReportHourProfile: vi.fn().mockResolvedValue({
    timeZone: "Asia/Jakarta",
    dayStartHour: 7,
    buckets: [],
    loadedThrough: null,
  }),
}));

const api = await import("@/lib/api");
const linePerformance = vi.mocked(api.getLinePerformance);
const lineHourProfile = vi.mocked(api.getLineHourProfile);
const machinePerformance = vi.mocked(api.getShiftReportPerformance);
const machineHourProfile = vi.mocked(api.getMonthReportHourProfile);

// WHAT THIS CARD IS ALLOWED TO CLAIM ABOUT A LINE. The measures come from the
// shell, shared with the machine card and tested there; everything asserted here
// is a place where a LINE differs from a MACHINE and the difference is invisible
// on screen.
//
//   the unit          reject and rework sit on the INFEED side, with total_out.
//                     Labelling them with the output unit renders cartons under a
//                     bag heading — contract §16.4a, and the reason the shell
//                     formats nothing itself.
//
//   the link's SUBJECT AND GRAIN. There are SEVEN report tables with six
//                     independent serial sequences, so an href off by either axis
//                     opens a real report and looks entirely ordinary: the wrong
//                     grain gives another date, `/machine/` gives another machine.
//                     The machine card already shipped the grain half of this bug.
//
//   the View button   at EVERY grain, and WHICH READ each one reaches. The line has
//                     two hourly endpoints off two payload shapes, and neither
//                     wrong pick errors visibly — so the assertion has to name the
//                     fetcher, not the button.
//
//   the Add buttons   a committed feature with nowhere to write yet. They must
//                     expose no action AND say why, which is the one place this
//                     screen departs from report-actions.tsx's convention.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LineLossesCard — the counts' unit", () => {
  // A line's two count points are usually in different units. Both of these
  // numbers are infeed-side, so both take the infeed unit — and the fixture makes
  // them differ (BAG in, CARTON out) precisely so a swap fails here.
  it("labels reject and rework with the INFEED unit, not the output unit", () => {
    renderWithQuery(
      <LineLossesCard
        report={lineReport({
          infeedUomName: "BAG",
          outputUomName: "CARTON",
          reject: 120,
          rework: 45,
        })}
      />,
    );

    expect(screen.getByText(/120 BAG/)).toBeTruthy();
    expect(screen.getByText(/45 BAG/)).toBeTruthy();
    expect(screen.queryByText(/CARTON/)).toBeNull();
  });
});

describe("LineLossesCard — the Losses detail link", () => {
  it.each([
    ["shift", lineReport({ id: 12 }), "/report/line/by-shift/12/losses"],
    ["day", lineReport({ grain: "day", shift: null, id: 12 }), "/report/line/by-day/12/losses"],
    [
      "month",
      lineReport({ grain: "month", shift: null, id: 12 }),
      "/report/line/by-monthly/12/losses",
    ],
  ])("on a %s report points at the LINE page at that grain", (_grain, report, href) => {
    renderWithQuery(<LineLossesCard report={report} />);

    const link = screen.getByRole("link", { name: /open the losses detail page/i });
    expect(link.getAttribute("href")).toContain(href);
  });

  // THE SUBJECT AXIS, checked on its own. `/report/machine/by-shift/12/losses`
  // satisfies "contains by-shift and 12" and is a full page of the wrong
  // subject's data, so the grain assertions above cannot catch it.
  it("never reaches a machine route", () => {
    renderWithQuery(<LineLossesCard report={lineReport({ id: 12 })} />);

    const link = screen.getByRole("link", { name: /open the losses detail page/i });
    expect(link.getAttribute("href")).not.toContain("/machine/");
  });
});

describe("LineLossesCard — the hourly chart", () => {
  // EVERY GRAIN, matching the machine card. This block has now asserted three
  // different things, and each inversion is worth knowing because the reason
  // changed each time rather than the opinion:
  //
  //   "offers no View button at ANY grain"  correct while oee.product_perf_wc_hour
  //     did not exist. Migration 0018 and its two endpoints shipped in Part 3.
  //   "offers none at month grain"          correct while LinePerformanceDialog did
  //     not READ /work-centers/month-reports/:id/hour-profile. The endpoint served
  //     the Trendline sub-tab the whole time; the dialog did not, so the button
  //     would have opened an empty panel. That was a missing read, not a design
  //     choice, and the card's own comment said to close it by wiring the endpoint.
  //   every grain                           the dialog reads both now.
  //
  // The assertions invert rather than being deleted: a button that silently
  // disappeared again would otherwise pass.
  it.each([
    ["shift", lineReport()],
    ["day", lineReport({ grain: "day", shift: null })],
    ["month", lineReport({ grain: "month", shift: null })],
  ])("offers a View button at %s grain", (_grain, report) => {
    renderWithQuery(<LineLossesCard report={report} />);

    expect(screen.getByRole("button", { name: /hourly production detail/i })).toBeTruthy();
  });

  // WHICH READ EACH GRAIN REACHES, which is the assertion the block above cannot
  // make and the one that matters. The two endpoints return two payload shapes and
  // both render through one body, so nothing on screen separates a wrong pick:
  //
  //   a month id on /performance   answers over a business-date range covering the
  //     whole month, so it returns ~720 chronological buckets. buildLineHourlyOutput
  //     draws them. That is a chart, it is not empty, and it is unreadable.
  //   a day id on /hour-profile    answers about the MONTH containing that day and
  //     draws 24 perfectly readable points about the wrong span.
  //
  // Neither throws. Hence the fetcher identity.
  it.each([
    [
      "shift",
      lineReport({ id: 12 }),
      () => expect(linePerformance).toHaveBeenCalledWith("shift", 12),
    ],
    [
      "day",
      lineReport({ grain: "day", shift: null, id: 12 }),
      () => expect(linePerformance).toHaveBeenCalledWith("day", 12),
    ],
  ])("reads /performance at %s grain, never the month profile", async (_grain, report, assert) => {
    renderWithQuery(<LineLossesCard report={report} />);

    fireEvent.click(screen.getByRole("button", { name: /hourly production detail/i }));

    await waitFor(assert);
    expect(lineHourProfile).not.toHaveBeenCalled();
  });

  it("reads the month hour-profile at month grain, never /performance", async () => {
    renderWithQuery(
      <LineLossesCard report={lineReport({ grain: "month", shift: null, id: 12 })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /hourly production detail/i }));

    await waitFor(() => expect(lineHourProfile).toHaveBeenCalledWith(12));
    expect(linePerformance).not.toHaveBeenCalled();
  });

  // AND NEVER THE MACHINE READS, at any grain. Same envelope, same four measures,
  // and a line report's id is a real machine report's id on another sequence — so
  // the panel would draw some machine's hours on another date without a warning.
  // The subject axis is asserted on its own because the grain cases above pass
  // either way.
  it.each([
    ["shift", lineReport({ id: 12 })],
    ["day", lineReport({ grain: "day", shift: null, id: 12 })],
    ["month", lineReport({ grain: "month", shift: null, id: 12 })],
  ])("never reaches a machine hourly endpoint at %s grain", async (_grain, report) => {
    renderWithQuery(<LineLossesCard report={report} />);

    fireEvent.click(screen.getByRole("button", { name: /hourly production detail/i }));

    // Awaited on the line side so the assertion is not merely racing the render.
    await waitFor(() =>
      expect(linePerformance.mock.calls.length + lineHourProfile.mock.calls.length).toBeGreaterThan(
        0,
      ),
    );
    expect(machinePerformance).not.toHaveBeenCalled();
    expect(machineHourProfile).not.toHaveBeenCalled();
  });

  // The dialog carries a query and the recharts chunk, so a closed one must cost
  // neither — at every grain, since neither hook is gated by the card any more.
  it.each([
    ["shift", lineReport()],
    ["month", lineReport({ grain: "month", shift: null })],
  ])("mounts no dialog and issues no request until View is pressed at %s grain", (_g, report) => {
    renderWithQuery(<LineLossesCard report={report} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(linePerformance).not.toHaveBeenCalled();
    expect(lineHourProfile).not.toHaveBeenCalled();
  });
});

describe("LineLossesCard — the Add Reject / Add Rework buttons", () => {
  // PART 2 SHIPPED THESE DISABLED, with a tooltip, as a deliberate and documented
  // exception to report-actions.tsx's rule that a disabled action means nobody
  // designed it. This block asserted that. The exception is over — the write path
  // exists (0017, contract §18) — so the assertions invert rather than being
  // deleted: a button that silently went back to disabled would otherwise pass.
  it("offers both, enabled, at shift grain", () => {
    renderWithQuery(<LineLossesCard report={lineReport()} />);

    for (const label of [/add reject/i, /add rework/i]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-disabled")).not.toBe("true");
    }
  });

  // AT EVERY GRAIN NOW, where Part 2 rendered them only at shift and §59 recorded
  // "shift only". The product decision widened it: the coarse dialogs ask the
  // operator to NAME a shift — a day report supplies its own date and asks for
  // the shift, a month report asks for both — so all three produce the same
  // shift-keyed row and the entry is answerable at each.
  it.each([
    ["day", lineReport({ grain: "day", shift: null })],
    ["month", lineReport({ grain: "month", shift: null })],
  ])("offers both at %s grain too", (_grain, report) => {
    renderWithQuery(<LineLossesCard report={report} />);

    expect(screen.getByRole("button", { name: /add reject/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add rework/i })).toBeTruthy();
  });

  // THE DIALOG IS NOT MOUNTED UNTIL IT IS OPENED, which is not a micro-optimisation:
  // it carries three catalogue queries and a per-open idempotency key, and a
  // mounted-but-closed copy would fetch on every page view and would generate its
  // requestId once for the life of the page rather than once per entry.
  it("mounts no dialog until an Add button is pressed", () => {
    renderWithQuery(<LineLossesCard report={lineReport()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// THE LEDGER LINE — the mitigation for the one real cost of composing in the
// pipeline rather than at read time.
//
// An entry does not move the tile until the next DAG run. An operator who saw
// nothing change would enter it again, so the entries are shown immediately,
// beneath the tile, labelled as not yet included. These assert both halves: that
// the entered figure appears, and that it is NOT folded into the tile.
describe("LineLossesCard — entries not yet in the figure", () => {
  const seedLedger = (totals: unknown[]) => [
    {
      queryKey: ["work-center-quality-entries", "shift", 7, false],
      data: { items: [], totals, targetUomCode: "BAG" },
    },
  ];

  it("shows what has been entered by hand, in the line's infeed unit", () => {
    renderWithQuery(<LineLossesCard report={lineReport({ id: 7, reject: 5000 })} />, {
      seed: seedLedger([{ kind: "reject", uomCode: "BAG", qty: 140, entries: 2 }]),
    });

    expect(screen.getByText(/\+140 BAG entered/)).toBeTruthy();
  });

  // THE ASSERTION THAT MATTERS. 5000 measured plus 140 entered must render as
  // 5000 and a separate 140 — never 5140. Adding them here would be a SECOND
  // definition of the composed number, disagreeing with the one the pipeline
  // writes, and the two would differ for as long as the DAG had not run.
  it("does not add the entries into the tile", () => {
    renderWithQuery(<LineLossesCard report={lineReport({ id: 7, reject: 5000 })} />, {
      seed: seedLedger([{ kind: "reject", uomCode: "BAG", qty: 140, entries: 1 }]),
    });

    // No thousands separators: format.ts sets `useGrouping: false`.
    expect(screen.getByText(/5000 BAG/)).toBeTruthy();
    expect(screen.queryByText(/5140/)).toBeNull();
  });

  // Reject and rework are separate figures, so an entry against one must not
  // appear under the other.
  it("keeps a rework entry off the reject tile", () => {
    renderWithQuery(<LineLossesCard report={lineReport({ id: 7 })} />, {
      seed: seedLedger([{ kind: "rework", uomCode: "BAG", qty: 45, entries: 1 }]),
    });

    expect(screen.getAllByText(/\+45 BAG entered/)).toHaveLength(1);
  });

  it("shows nothing when nothing has been entered", () => {
    renderWithQuery(<LineLossesCard report={lineReport({ id: 7 })} />, {
      seed: seedLedger([]),
    });

    expect(screen.queryByText(/entered/)).toBeNull();
  });
});
