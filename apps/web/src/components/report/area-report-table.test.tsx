import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaProvider } from "@/components/layout/area-context";
import { AreaReportTable } from "@/components/report/area-report-table";
import { renderWithQuery } from "@/test/render";

import type { AreaDaySearch, AreaMonthSearch } from "@/lib/area-search";
import type { AreaReportListItem } from "@/lib/types";
import type { ReactElement } from "react";

// The Area By Day and By Monthly lists — one component, two grains.
//
// It mocks lib/api rather than lib/queries, matching every other list suite: the
// wiring between the component and the query layer IS the code under test, and
// stubbing the hook would replace it.
//
// THE OTHER THREE LIST FETCHERS ARE MOCKED ONLY SO THEY CAN BE ASSERTED UN-CALLED,
// and that is the highest-value assertion in this file. Nine report tables, eight
// independent identity sequences — a list wired to `getLineReports` returns real
// rows with real ids and four real rates, about LINES, under an Area heading. A
// test asserting "rows appear" passes either way, so assert WHICH function ran.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getAreaReports: vi.fn(),
  getLineReports: vi.fn(),
  getPeriodReports: vi.fn(),
  getSkuReports: vi.fn(),
}));

const { getAreaReports, getLineReports, getPeriodReports, getSkuReports } =
  await import("@/lib/api");
const areaReports = vi.mocked(getAreaReports);
const lineReports = vi.mocked(getLineReports);
const periodReports = vi.mocked(getPeriodReports);
const skuReports = vi.mocked(getSkuReports);

const AREA = { id: 2, code: "FI2", name: "Filling 2" };
const OTHER_AREA = { id: 3, code: "PK1", name: "Packing 1" };

const SEED_AREAS = { queryKey: ["areas"], data: [AREA, OTHER_AREA] };

function search(overrides: Partial<AreaDaySearch> = {}): AreaDaySearch {
  return { page: 1, size: 10, month: 9, year: 2026, hideZero: true, ...overrides };
}

function row(overrides: Partial<AreaReportListItem> = {}): AreaReportListItem {
  return {
    id: 11,
    grain: "day",
    businessDate: "2026-09-01",
    timeZone: "Asia/Jakarta",
    areaId: AREA.id,
    areaName: "Filling 2",
    areaCode: "FI2",
    oee: 71.429,
    availability: 83.571,
    performance: 92.308,
    quality: 92.593,
    ...overrides,
  };
}

// THE PROVIDER IS NOT OPTIONAL HERE, and that is the one structural difference from
// every other list suite. Those read the header's area through
// `useWorkCenterFilter`, which only uses it to decide which LINES to offer. This
// screen reads `useSelectedArea` directly and puts the result in the REQUEST — so a
// render without the provider throws rather than degrading, which is the guard
// working.
function renderTable(ui: ReactElement, seed = [SEED_AREAS]) {
  return renderWithQuery(<AreaProvider>{ui}</AreaProvider>, { seed });
}

beforeEach(() => {
  areaReports.mockResolvedValue({ items: [row()], meta: undefined });
  // AreaProvider reads a stored area id on mount and falls back to the first area
  // only when the stored one is not in the list. Clearing it keeps each test
  // starting from "nothing chosen", so the seeded list is what decides the
  // selection rather than whatever a previous test wrote.
  globalThis.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AreaReportTable", () => {
  it("reads the area list endpoint and no other subject's", async () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    await screen.findByText("Filling 2 · FI2");

    expect(areaReports).toHaveBeenCalled();
    expect(lineReports).not.toHaveBeenCalled();
    expect(periodReports).not.toHaveBeenCalled();
    expect(skuReports).not.toHaveBeenCalled();
  });

  // THE HEADER PICKER IS A REQUEST FILTER ON THIS SCREEN, AND ON NO OTHER. Every
  // other list sends `workCenterId` and nothing about the area; this one sends the
  // area and nothing about a line.
  it("sends the header's selected area as the request filter", async () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    await screen.findByText("Filling 2 · FI2");

    expect(areaReports).toHaveBeenCalledWith(
      "day",
      expect.objectContaining({ areaId: AREA.id, month: 9, year: 2026, hideZero: true }),
    );
  });

  // AND NEVER A LINE. An area report is not scoped by a line, so a `workCenterId`
  // reaching the request would name a subset the row's figures were never computed
  // over — one area's OEE under a heading claiming one line.
  it("sends no workCenterId at all", async () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    await screen.findByText("Filling 2 · FI2");

    expect(areaReports.mock.calls[0]![1]).not.toHaveProperty("workCenterId");
  });

  // AN UNDEFINED AREA MUST NOT GATE THE QUERY. `useSelectedArea` is undefined until
  // the area list resolves, and core-api reads an absent `areaId` as "every area" —
  // so the first paint shows data and narrows a tick later, rather than a skeleton
  // waiting on a second request. Seeding NO areas is that state.
  it("still requests a page when no area has resolved yet", async () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
      [],
    );

    await screen.findByText("Filling 2 · FI2");

    expect(areaReports).toHaveBeenCalledWith("day", expect.objectContaining({ areaId: undefined }));
  });

  // NAME AND CODE. `area_name` is not guaranteed unique — the dev world carried two
  // lines called 'Line 1' for months (TODOS.md §77) — and a screen whose subject IS
  // the area cannot identify one by a label that can repeat.
  it("names the area by name and code", async () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    expect(await screen.findByText("Filling 2 · FI2")).toBeTruthy();
  });

  it("falls back to the name alone when the area has no code", async () => {
    areaReports.mockResolvedValue({ items: [row({ areaCode: null })], meta: undefined });

    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    expect(await screen.findByText("Filling 2")).toBeTruthy();
  });

  // THE EIGHT-SEQUENCES HAZARD IN ITS SHARPEST FORM. This row's id is meaningful
  // only against oee.area_day_reports, and the machine, line and SKU detail routes
  // all COMPILE here because the param name is the same — any of them would open a
  // real report about another subject, with a populated header and no warning. So
  // assert the HREF, not that a link exists.
  it("points the eye at the area detail route", async () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    const link = await screen.findByLabelText("View report 11");

    expect(link.getAttribute("href")).toBe("/report/area/by-day/11");
  });

  // NO SHIFT AND NO LINE CONTROL. Neither exists at this grain, and a second area
  // picker on the page would duplicate the header's or disagree with it.
  it("renders neither a Shift nor a Line filter, and no area picker of its own", () => {
    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    expect(screen.queryByLabelText("Shift")).toBeNull();
    expect(screen.queryByLabelText("Line")).toBeNull();
    expect(screen.queryByLabelText("Area")).toBeNull();
  });

  // formatBusinessDate, NEVER formatReportDate. `businessDate` is plant-local and
  // zone-free (0024); the instant formatter would read '2026-09-01' as UTC midnight
  // and print 31 August for any plant west of Greenwich — the right-looking wrong
  // day, on every row.
  it("renders the business date without reducing it through a zone", async () => {
    areaReports.mockResolvedValue({
      items: [row({ businessDate: "2026-09-01" })],
      meta: undefined,
    });

    renderTable(
      <AreaReportTable grain="day" search={search()} onFilter={vi.fn()} onPageChange={vi.fn()} />,
    );

    expect(await screen.findByText(/01\/09\/2026/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// THE MONTH GRAIN
// ---------------------------------------------------------------------------
//
// ONE COMPONENT SERVES BOTH, so what is worth asserting is the three things that
// actually differ — and each of them is a quiet failure rather than a loud one.
describe("AreaReportTable — the month grain", () => {
  const monthRow = () => row({ id: 12, grain: "month", businessDate: "2026-09-01" });

  function monthSearch(over: Partial<AreaMonthSearch> = {}): AreaMonthSearch {
    return { page: 1, size: 12, year: 2026, hideZero: true, ...over };
  }

  function renderMonth() {
    return renderTable(
      <AreaReportTable
        grain="month"
        search={monthSearch()}
        onFilter={vi.fn()}
        onPageChange={vi.fn()}
      />,
    );
  }

  // 1. THE GRAIN REACHES THE FETCHER, which is what picks the endpoint and the
  //    cache key. The two area tables have INDEPENDENT identity sequences, so a
  //    month screen that asked for "day" would render a page of real reports about
  //    single days under a Month header.
  it("asks for the month grain and sends no month filter", async () => {
    areaReports.mockResolvedValue({ items: [monthRow()], meta: undefined });

    renderMonth();

    await screen.findByText("Filling 2 · FI2");

    expect(areaReports).toHaveBeenCalledWith(
      "month",
      expect.objectContaining({ year: 2026, hideZero: true }),
    );
    // NOT `month: undefined` — ABSENT. The month list's schema does not declare the
    // param, and lib/api strips nothing: sending the key at all would be a filter
    // that reads as set and does nothing.
    expect(areaReports.mock.calls[0]![1]).not.toHaveProperty("month");
  });

  // 2. THE FIRST COLUMN IS A MONTH LABEL, NOT A BUSINESS DATE. `businessDate` at
  //    this grain is the FIRST DAY of the month (`ck_amr_month_start`), so
  //    `formatBusinessDate` would print "01/09/2026" under a header that says Month
  //    — and a reader would take every row as covering one day.
  it("renders a month label under a Month header", async () => {
    areaReports.mockResolvedValue({ items: [monthRow()], meta: undefined });

    renderMonth();

    expect(await screen.findByText("September 2026")).toBeTruthy();
    expect(screen.getByText("Month")).toBeTruthy();
    expect(screen.queryByText(/01\/09\/2026/)).toBeNull();
  });

  // 3. NO MONTH FILTER CONTROL. The requirement is "Monthly Report (Show all month
  //    on selected year)", so a Month select here would be a control whose value
  //    the request cannot carry. The Year one stays.
  it("renders a Year filter and no Month filter", () => {
    areaReports.mockResolvedValue({ items: [monthRow()], meta: undefined });

    renderMonth();

    expect(screen.getByLabelText("Year")).toBeTruthy();
    expect(screen.queryByLabelText("Month")).toBeNull();
  });

  // AND THE EYE POINTS AT THE MONTH DETAIL ROUTE. The two AREA literals compile in
  // each other's place — same subject, same param name — and with independent
  // identity sequences a day literal here opens a real DAY report about a different
  // period. Assert the HREF.
  it("points the eye at the month detail route", async () => {
    areaReports.mockResolvedValue({ items: [monthRow()], meta: undefined });

    renderMonth();

    const link = await screen.findByLabelText("View report 12");

    expect(link.getAttribute("href")).toBe("/report/area/by-monthly/12");
  });

  it("still reads the header's area as the request filter", async () => {
    areaReports.mockResolvedValue({ items: [monthRow()], meta: undefined });

    renderMonth();

    await screen.findByText("Filling 2 · FI2");

    expect(areaReports).toHaveBeenCalledWith("month", expect.objectContaining({ areaId: AREA.id }));
  });
});
