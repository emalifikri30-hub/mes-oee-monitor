import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaProvider } from "@/components/layout/area-context";
import { SkuReportTable } from "@/components/report/sku-report-table";
import { renderWithQuery } from "@/test/render";

import type { PeriodSearch } from "@/lib/period-search";
import type { ReactElement } from "react";
import type { SkuReportListItem } from "@/lib/types";

// The SKU By Day list's first component test, added with the header area filter.
//
// WHY IT EXISTS NOW AND NOT BEFORE. Its three siblings were written when the
// shared chrome was extracted out of them; this screen was built on that chrome
// and needed none of it pinned. What it does need pinned is what the other three
// now pin too — that the area selected in the header reaches the REQUEST — plus
// the one hazard this subject has more of than any other: which endpoint answered.
//
// THE SUBJECT AXIS IS WHY THAT MATTERS HERE. There are twelve report tables with
// twelve independent identity sequences, and `/work-centers/day-reports` returns
// the same envelope, the same four rates and a populated Line column. A test that
// asserted "rows render" would pass against the LINE list — a full page of real
// data about the wrong thing, with no warning anywhere on screen. So assert WHICH
// function was called.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getSkuReports: vi.fn(),
  getLineReports: vi.fn(),
  getPeriodReports: vi.fn(),
}));

const { getSkuReports, getLineReports, getPeriodReports } = await import("@/lib/api");
const skuReports = vi.mocked(getSkuReports);
const lineReports = vi.mocked(getLineReports);
const periodReports = vi.mocked(getPeriodReports);

const AREA = { id: 5, code: "FI-2", name: "Filling 2" };
const LINE_1 = { id: 11, code: "L1", name: "Molca Line 1" };
const LINE_2 = { id: 12, code: "L2", name: "Molca Line 2" };

const SEED_AREA = { queryKey: ["areas"], data: [AREA] };
const SEED_LINES = { queryKey: ["work-centers", AREA.id], data: [LINE_1, LINE_2] };

function search(overrides: Partial<PeriodSearch> = {}): PeriodSearch {
  return {
    page: 1,
    size: 10,
    month: 8,
    year: 2026,
    workCenterId: undefined,
    hideZero: true,
    ...overrides,
  } as PeriodSearch;
}

function row(overrides: Partial<SkuReportListItem> = {}): SkuReportListItem {
  return {
    id: 91,
    // Plant-local and zone-free. There is no instant on this grain at all, so a
    // fixture carrying one would let formatReportDate look correct here and be
    // wrong in production.
    businessDate: "2026-08-19",
    timeZone: "Asia/Jakarta",
    workCenterId: LINE_1.id,
    workCenterName: LINE_1.name,
    workCenterCode: LINE_1.code,
    productId: 3,
    productName: "Sasa Bumbu 250g",
    productCode: "SB-250",
    oee: 84.312,
    availability: 96.5,
    performance: 90.1,
    quality: 97.2,
    ...overrides,
  };
}

function page(items: SkuReportListItem[]) {
  return {
    items,
    meta: { page: 1, size: 10, totalElements: 14, totalPages: 2, first: true, last: false },
  };
}

function renderTable(ui: ReactElement, seed = [SEED_AREA, SEED_LINES]) {
  return renderWithQuery(<AreaProvider>{ui}</AreaProvider>, { seed });
}

function table(props: Partial<Parameters<typeof SkuReportTable>[0]> = {}) {
  return (
    <SkuReportTable search={search()} onFilter={() => {}} onPageChange={() => {}} {...props} />
  );
}

beforeEach(() => {
  skuReports.mockResolvedValue(page([row()]));
  lineReports.mockResolvedValue({ items: [], meta: undefined });
  periodReports.mockResolvedValue({ items: [], meta: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkuReportTable — which endpoint answered", () => {
  it("asks the SKU endpoint, and neither the line nor the machine one", async () => {
    renderTable(table());

    await screen.findByText("Sasa Bumbu 250g");

    expect(skuReports).toHaveBeenCalledTimes(1);
    expect(lineReports).not.toHaveBeenCalled();
    expect(periodReports).not.toHaveBeenCalled();
  });

  // ONE GRAIN, so no grain argument. `oee.product_report_wc_day` has no shift or
  // month sibling, and a grain parameter with one legal value is the shape a
  // caller assumes is meaningful and then passes wrongly.
  it("takes no grain argument", async () => {
    renderTable(table());

    await screen.findByText("Sasa Bumbu 250g");

    expect(skuReports.mock.calls[0]).toHaveLength(1);
  });
});

// THE HEADER AREA PICKER, AS A REQUEST FILTER — the same block the other three
// list tables carry, and the rule that INVERTED. `use-work-center-filter.ts` used
// to say the area "never filters a request on its own"; every report list sends
// it now, and `0023` gave this table an `area_id` from the start.
describe("SkuReportTable — the area filter", () => {
  it("sends the selected area with the request", async () => {
    renderTable(table());

    await screen.findByText("Sasa Bumbu 250g");

    expect(skuReports.mock.calls[0]?.[0].areaId).toBe(AREA.id);
  });

  // AN UNDEFINED AREA MUST NOT GATE THE QUERY. core-api reads an absent `areaId`
  // as EVERY area, so the first paint shows data and narrows a tick later; a
  // gated useQuery reports `status: "pending"` forever, so gating it wrongly
  // renders a skeleton that never clears.
  it("still fetches, unfiltered, while the area list is loading", async () => {
    renderTable(table(), []);

    await screen.findByText("Sasa Bumbu 250g");

    expect(skuReports).toHaveBeenCalledTimes(1);
    expect(skuReports.mock.calls[0]?.[0].areaId).toBeUndefined();
  });

  it("sends the area and the line together", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));

    await screen.findByText("Sasa Bumbu 250g");

    expect(skuReports.mock.calls[0]?.[0]).toMatchObject({
      areaId: AREA.id,
      workCenterId: LINE_2.id,
    });
  });

  // A STRANDED LINE MUST NOT STRAND THE AREA. Dropping both would widen the list
  // from one area to the whole plant, which looks like working data.
  it("keeps the area when the line id is stranded", async () => {
    renderTable(table({ search: search({ workCenterId: 999 }) }));

    await screen.findByText("Sasa Bumbu 250g");

    expect(skuReports.mock.calls[0]?.[0]).toMatchObject({
      areaId: AREA.id,
      workCenterId: undefined,
    });
  });
});

describe("SkuReportTable — the four states", () => {
  it("renders skeletons while pending", () => {
    skuReports.mockReturnValue(new Promise(() => {}));
    const { container } = renderTable(table());

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("renders the error state and drops the skeletons", async () => {
    skuReports.mockRejectedValue(new Error("boom"));
    const { container } = renderTable(table());

    await screen.findByText(/could not load/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("renders the empty state and drops the skeletons", async () => {
    skuReports.mockResolvedValue({ items: [], meta: undefined });
    const { container } = renderTable(table());

    await screen.findByText(/no .*report/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });
});

// The Line column is the second half of this grain's key, not decoration: the
// same SKU on the same date produces one row per line, carrying DIFFERENT numbers
// because a line is measured at its own count points. Without it the list reads
// as duplicated rows.
describe("SkuReportTable — the Line column", () => {
  it("renders the line code beside the name, because names repeat", async () => {
    renderTable(table());

    const cell = await screen.findByText(/Molca Line 1/);
    expect(cell.textContent).toContain(LINE_1.code);
  });
});
