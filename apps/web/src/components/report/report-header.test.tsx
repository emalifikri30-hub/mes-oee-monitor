import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { periodReport, shiftReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";
import { ReportHeader } from "@/components/report/report-header";

// WHICH TILES THE HEADER SELECTS, per grain — the one thing about this component
// a pure function cannot reach.
//
// The three layouts are not cosmetic variants. Each absence encodes something
// the database cannot express:
//
//   the Shift tile      only a shift report has a shift.
//   the Approve button  only a shift report can be approved; approval is keyed
//                       (work_unit_id, date, shift), so a day sign-off has no
//                       row to live in.
//   the Status tile     at day grain it is a COUNT of other records, and it must
//                       not be able to render as an Open/Closed badge — that
//                       would assert a signature nobody gave. At month grain it
//                       is absent entirely.
//
// A regression in any of those renders a header that looks completely normal,
// which is why they are asserted rather than left to review.

// The header mounts ReportActions, which mounts four dialogs and a sheet that
// each fire their own queries. Stubbed so this file tests the header's tile
// selection rather than the dialog tree's.
vi.mock("@/components/report/report-actions", () => ({
  ReportActions: ({ report }: { report: { grain: string } }) => (
    <div data-testid="report-actions" data-grain={report.grain} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReportHeader", () => {
  describe("shift grain", () => {
    it("shows the Shift tile", () => {
      renderWithQuery(<ReportHeader report={shiftReport({ shift: 3 })} />);

      expect(screen.getByText("Shift")).toBeTruthy();
      expect(screen.getByText("3")).toBeTruthy();
    });

    it("shows Open for an unapproved report", () => {
      renderWithQuery(<ReportHeader report={shiftReport()} />);

      expect(screen.getByText("Open")).toBeTruthy();
    });
  });

  describe("day grain", () => {
    it("has no Shift tile", () => {
      renderWithQuery(<ReportHeader report={periodReport()} />);

      expect(screen.queryByText("Shift")).toBeNull();
    });

    // THE ONE THAT MATTERS. "2 of 3 shifts approved" is a statement about three
    // other records; a "Closed" badge here would be a statement about this one.
    it("shows the shift count rather than an approval badge", () => {
      renderWithQuery(
        <ReportHeader report={periodReport({ approval: { shiftsTotal: 3, shiftsClosed: 2 } })} />,
      );

      expect(screen.getByText("2 of 3 shifts approved")).toBeTruthy();
      expect(screen.queryByText("Closed")).toBeNull();
    });

    it("says Approved once every shift is closed, and drops the count", () => {
      renderWithQuery(
        <ReportHeader report={periodReport({ approval: { shiftsTotal: 3, shiftsClosed: 3 } })} />,
      );

      expect(screen.getByText("Approved")).toBeTruthy();
      expect(screen.queryByText("3 of 3 shifts approved")).toBeNull();
    });

    it("shows none approved as 0 of 3, not as Open", () => {
      renderWithQuery(
        <ReportHeader report={periodReport({ approval: { shiftsTotal: 3, shiftsClosed: 0 } })} />,
      );

      expect(screen.getByText("0 of 3 shifts approved")).toBeTruthy();
      expect(screen.queryByText("Open")).toBeNull();
    });

    // "0 of 0 shifts approved" reads as a real answer about a real day. This is
    // the pipeline not having reached it, which is a different claim.
    it("says the pipeline has written nothing rather than 0 of 0", () => {
      renderWithQuery(
        <ReportHeader report={periodReport({ approval: { shiftsTotal: 0, shiftsClosed: 0 } })} />,
      );

      expect(screen.getByText("No shift reports")).toBeTruthy();
      expect(screen.queryByText("0 of 0 shifts approved")).toBeNull();
    });

    // The label is formatted from businessDate, which is ALREADY plant-local.
    // Pushing it through the instant formatter would read '2026-08-09' as UTC
    // midnight and render the 8th for any plant west of Greenwich.
    it("labels the date tile from the business day, not from the instant", () => {
      renderWithQuery(<ReportHeader report={periodReport({ businessDate: "2026-08-09" })} />);

      expect(screen.getByText("Date")).toBeTruthy();
      expect(screen.getByText("Sunday, 09/08/2026")).toBeTruthy();
    });
  });

  describe("month grain", () => {
    const monthReport = () =>
      periodReport({
        grain: "month",
        approval: null,
        businessDate: "2026-08-01",
        month: "2026-08",
      });

    it("has no Status tile at all", () => {
      renderWithQuery(<ReportHeader report={monthReport()} />);

      expect(screen.queryByText("Status")).toBeNull();
    });

    it("labels the tile Month and names the month", () => {
      renderWithQuery(<ReportHeader report={monthReport()} />);

      expect(screen.getByText("Month")).toBeTruthy();
      expect(screen.getByText("August 2026")).toBeTruthy();
      expect(screen.queryByText("Date")).toBeNull();
    });

    // The `month` column is right there on the row and is deliberately NOT what
    // gets rendered: its format is unspecified upstream, so the label is derived
    // from businessDate instead.
    it("does not render the raw month column", () => {
      renderWithQuery(<ReportHeader report={monthReport()} />);

      expect(screen.queryByText("2026-08")).toBeNull();
    });
  });

  // Nothing renderable, and it must not become "Invalid Date" or today's date.
  it("renders an em dash when the pipeline has not written a business date", () => {
    renderWithQuery(<ReportHeader report={periodReport({ businessDate: null })} />);

    expect(screen.getByText("—")).toBeTruthy();
  });
});
