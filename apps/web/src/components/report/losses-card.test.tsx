import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { periodReport, shiftReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { LossesCard } from "@/components/report/losses-card";

// THREE FETCHERS, ALL MOCKED, so a swap in any direction fails. The dialog picks
// one of them from the grain and all three payloads render through one body, so
// nothing on screen distinguishes a wrong choice — and neither wrong choice would
// even error visibly: a month id on /performance 404s into the panel's card-local
// error state, and a day id on the month profile draws a perfectly readable chart
// about the wrong span.
//
// The resolved values are written INLINE because `vi.mock` is hoisted above every
// module-scope binding in this file — a shared `EMPTY` const here is `undefined`
// at factory time, and the queries then reject on a null payload.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReportPerformance: vi
    .fn()
    .mockResolvedValue({ timeZone: "Asia/Jakarta", buckets: [], loadedThrough: null }),
  getPeriodReportPerformance: vi
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
const shiftPerformance = vi.mocked(api.getShiftReportPerformance);
const periodPerformance = vi.mocked(api.getPeriodReportPerformance);
const hourProfile = vi.mocked(api.getMonthReportHourProfile);

// WHICH DRILL-DOWNS THE CARD OFFERS, per grain. Both are links or buttons that
// would look completely normal if they appeared on the wrong report.
//
//   the external-link icon  goes to one of THREE routes and interpolates THIS
//     report's id. The three report tables have independent serial sequences, so
//     a by-shift route given a day report's id opens the shift report sharing
//     that id — a different machine on a different date, rendered without a
//     single error. THIS ALREADY SHIPPED WRONG ONCE: the target was hardcoded to
//     by-shift while the card served three grains.
//
//   the View button         the card-level shortcut to the hourly chart, at EVERY
//     grain. A month gets a DIFFERENT chart rather than a longer one — 24
//     hour-of-day points collapsed from ~720 — and the dialog picks both its
//     endpoint and its model builder from the grain.
//
// Neither is enforceable by a type — the link target is a literal ternary and the
// dialog accepts any report — so both are asserted here.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LossesCard drill-downs", () => {
  // THE REGRESSION THIS BLOCK EXISTS FOR, and it is one that actually shipped:
  // the link was hardcoded to the by-shift route while the card served three
  // grains. A day report's id went into `/by-shift/$reportId/losses`, which
  // opened the shift report sharing that id — a different machine on a different
  // date — with nothing on screen to say so.
  //
  // Asserting the GRAIN in the href is what catches that. Asserting only that a
  // link exists would have passed the whole time.
  describe("the Losses detail link", () => {
    it.each([
      ["shift", shiftReport({ id: 12 }), "/by-shift/12/losses"],
      ["day", periodReport({ grain: "day", id: 12 }), "/by-day/12/losses"],
      ["month", periodReport({ grain: "month", approval: null, id: 12 }), "/by-monthly/12/losses"],
    ])("on a %s report points at that grain's Losses page", (_grain, report, href) => {
      renderWithQuery(<LossesCard report={report} />);

      const link = screen.getByRole("link", { name: /open the losses detail page/i });
      expect(link.getAttribute("href")).toContain(href);
    });

    // The three routes must not collapse into one another. A card that renders
    // the by-shift href on every grain passes the three cases above only if this
    // one fails, so they are checked together.
    it("never sends a coarse report's id to the by-shift route", () => {
      renderWithQuery(<LossesCard report={periodReport({ grain: "day", id: 28 })} />);

      const link = screen.getByRole("link", { name: /open the losses detail page/i });
      expect(link.getAttribute("href")).not.toContain("by-shift");
    });
  });

  // EVERY GRAIN, AND THE MONTH CASE IS THE ONE THAT HAS BEEN BOTH WAYS. The
  // button was absent at month grain while there was no chart to open; the
  // hour-of-DAY profile that answers the month's version of the question shipped
  // with §23, and a follow-up nonetheless removed the button again on the argument
  // that a month report should reach the profile through the Losses page's
  // Trendline sub-tab instead. That read as the feature being missing — which is
  // how it was reported — so the card offers it at all three grains and the
  // sub-tab keeps rendering the same chart.
  //
  // The month arm is asserted on its own rather than folded into the loop, so a
  // future "consistency" pass that re-gates it fails a named test instead of
  // shrinking a table.
  describe("the View button", () => {
    it.each([
      ["shift", shiftReport()],
      ["day", periodReport({ grain: "day" })],
    ])("is offered on a %s report", (_grain, report) => {
      renderWithQuery(<LossesCard report={report} />);

      expect(screen.getByRole("button", { name: /hourly production detail/i })).toBeTruthy();
    });

    it("IS offered on a month report, opening the hour-of-day profile", () => {
      renderWithQuery(<LossesCard report={periodReport({ grain: "month", approval: null })} />);

      expect(screen.getByRole("button", { name: /hourly production detail/i })).toBeTruthy();
    });

    // WHICH ENDPOINT THE MONTH BUTTON REACHES, which is the assertion that the one
    // above cannot make. A month report's id sent to /performance would 404 — that
    // path refuses a month deliberately — and the panel would render its error
    // state, which is a plausible screen on a table that ships empty. So the test
    // has to name the function.
    it("reads the month hour-profile endpoint, never /performance", async () => {
      renderWithQuery(
        <LossesCard report={periodReport({ grain: "month", approval: null, id: 12 })} />,
      );

      fireEvent.click(screen.getByRole("button", { name: /hourly production detail/i }));

      await waitFor(() => expect(hourProfile).toHaveBeenCalledWith(12));
      expect(periodPerformance).not.toHaveBeenCalled();
      expect(shiftPerformance).not.toHaveBeenCalled();
    });

    // AND THE MIRROR, so a swap in the other direction fails too: a DAY report must
    // not reach the month profile, which would answer about a month that contains
    // it and draw a perfectly readable chart about the wrong span.
    it("reads /performance on a day report, never the month profile", async () => {
      renderWithQuery(<LossesCard report={periodReport({ grain: "day", id: 12 })} />);

      fireEvent.click(screen.getByRole("button", { name: /hourly production detail/i }));

      await waitFor(() => expect(periodPerformance).toHaveBeenCalledWith(12));
      expect(hourProfile).not.toHaveBeenCalled();
    });
  });
});
