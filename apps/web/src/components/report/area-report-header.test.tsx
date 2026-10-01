import { afterEach, describe, expect, it } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaReportHeader } from "@/components/report/area-report-header";
import { areaReport } from "@/test/fixtures";
import { renderWithQuery } from "@/test/render";

afterEach(cleanup);

// The AREA report's header strip.
//
// IT EXISTS FOR ONE ASSERTION AND GAINED THE REST AROUND IT: the first tile
// changes both its LABEL and its FORMATTER with the grain, and getting that wrong
// is silent. `businessDate` at month grain is the FIRST DAY of the month
// (`ck_amr_month_start`, 0025), so `formatBusinessDate` prints "01/09/2026" — a
// real date, correctly formatted, under a heading that says Month, which a reader
// takes as the report covering one day.
describe("AreaReportHeader", () => {
  it("labels the period Date and formats a business date at day grain", () => {
    renderWithQuery(<AreaReportHeader report={areaReport({ grain: "day" })} />);

    expect(screen.getByText("Date")).toBeTruthy();
    expect(screen.getByText(/01\/09\/2026/)).toBeTruthy();
    expect(screen.queryByText("Month")).toBeNull();
  });

  it("labels the period Month and formats a month label at month grain", () => {
    renderWithQuery(<AreaReportHeader report={areaReport({ grain: "month" })} />);

    expect(screen.getByText("Month")).toBeTruthy();
    expect(screen.getByText("September 2026")).toBeTruthy();
    // The date that would have been printed by the day formatter, absent.
    expect(screen.queryByText(/01\/09\/2026/)).toBeNull();
    expect(screen.queryByText("Date")).toBeNull();
  });

  // NAME AND CODE. A denormalised name is not guaranteed unique — the dev world
  // carried two lines called 'Line 1' for months (TODOS.md §77) — and a report
  // whose subject IS the area cannot identify one by a label that can repeat.
  it("names the area by name and code", () => {
    renderWithQuery(<AreaReportHeader report={areaReport()} />);

    expect(screen.getByText("Filling 2 · FI2")).toBeTruthy();
  });

  it("falls back to the name alone when the area has no code", () => {
    renderWithQuery(<AreaReportHeader report={areaReport({ areaCode: null })} />);

    expect(screen.getByText("Filling 2")).toBeTruthy();
  });

  // TWO TILES, WHICH IS THE FEWEST OF ANY REPORT SCREEN. No Status tile at either
  // grain: oee.work_unit_shift_report_approvals is keyed
  // (work_unit_id, date, shift), an area report has neither, and unlike the line
  // day header — which at least has child reports it could count and declines to
  // (§48) — there is no cascade defined for an area at all.
  it.each(["day", "month"] as const)("renders no Status tile at %s grain", (grain) => {
    renderWithQuery(<AreaReportHeader report={areaReport({ grain })} />);

    expect(screen.queryByText("Status")).toBeNull();
  });

  // THE ACTIONS ARE A "…" MENU, per the requirement ("Action button (3 dot icon;
  // for download and log activity)") — and NOT the single button the SKU header
  // uses, which is a menu of one there because Download is a placeholder.
  it("renders the overflow menu and no Approve", () => {
    renderWithQuery(<AreaReportHeader report={areaReport()} />);

    expect(screen.getByLabelText("More actions")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });
});
