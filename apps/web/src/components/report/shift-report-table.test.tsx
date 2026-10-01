import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaProvider } from "@/components/layout/area-context";
import { ShiftReportTable } from "@/components/report/shift-report-table";
import { renderWithQuery } from "@/test/render";

import type { MachineShiftSearch } from "@/lib/shift-search";
import type { ReactElement } from "react";
import type { ShiftReportListItem } from "@/lib/types";

// PINS THE BY SHIFT LIST BEFORE THE SHARED CHROME IS EXTRACTED OUT OF IT.
//
// The sibling of period-report-table.test.tsx, covering the same four rules the
// extraction moves — which endpoint was called, the stranded-line rule in both
// directions, the four DataTable states with the skeleton asserted GONE, and
// continuous row numbering — plus the two things only this screen has: the shift
// filter and the approval status filter.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getShiftReports: vi.fn(),
  getPeriodReports: vi.fn(),
}));

const { getShiftReports, getPeriodReports } = await import("@/lib/api");
const shiftReports = vi.mocked(getShiftReports);
const periodReports = vi.mocked(getPeriodReports);

const AREA = { id: 5, code: "FI-2", name: "Filling 2" };
const LINE_1 = { id: 11, code: "L1", name: "Molca Line 1" };
const LINE_2 = { id: 12, code: "L2", name: "Molca Line 2" };

const SEED_AREA = { queryKey: ["areas"], data: [AREA] };
const SEED_LINES = { queryKey: ["work-centers", AREA.id], data: [LINE_1, LINE_2] };

function search(overrides: Partial<MachineShiftSearch> = {}): MachineShiftSearch {
  return {
    page: 1,
    size: 10,
    month: 8,
    year: 2026,
    shift: undefined,
    workCenterId: undefined,
    hideZero: true,
    status: undefined,
    ...overrides,
  };
}

function row(overrides: Partial<ShiftReportListItem> = {}): ShiftReportListItem {
  return {
    id: 71,
    shift: 3,
    // The shift's START INSTANT: 23:00 on 2 August at Asia/Jakarta.
    date: "2026-08-02T16:00:00.000Z",
    timeZone: "Asia/Jakarta",
    oee: 83.851,
    availability: 100,
    performance: 84.283,
    quality: 99.488,
    status: "open",
    workUnit: { id: 42, code: "VP-N", name: "Vertical Packer N" },
    workCenter: LINE_1,
    ...overrides,
  } as ShiftReportListItem;
}

function page(items: ShiftReportListItem[], meta?: Partial<{ page: number; size: number }>) {
  const p = meta?.page ?? 1;
  const size = meta?.size ?? 10;
  return {
    items,
    meta: { page: p, size, totalElements: 76, totalPages: 8, first: p === 1, last: false },
  };
}

function renderTable(ui: ReactElement, seed = [SEED_AREA, SEED_LINES]) {
  return renderWithQuery(<AreaProvider>{ui}</AreaProvider>, { seed });
}

function table(props: Partial<Parameters<typeof ShiftReportTable>[0]> = {}) {
  return (
    <ShiftReportTable search={search()} onFilter={() => {}} onPageChange={() => {}} {...props} />
  );
}

beforeEach(() => {
  shiftReports.mockResolvedValue(page([row()]));
  periodReports.mockResolvedValue({ items: [], meta: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ShiftReportTable — which endpoint answered", () => {
  it("asks the shift endpoint, and never a coarse one", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    expect(shiftReports).toHaveBeenCalledWith(expect.objectContaining({ page: 1, size: 10 }));
    expect(periodReports).not.toHaveBeenCalled();
  });

  // The two filters this screen has and the coarse ones do not.
  it("forwards shift and status when they are set", async () => {
    renderTable(table({ search: search({ shift: "2", status: "closed" }) }));

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0]).toMatchObject({ shift: "2", status: "closed" });
  });

  // `undefined` rather than an "all" sentinel: lib/api.ts strips undefined keys,
  // and core-api reads an absent param as "no predicate". A sentinel would have to
  // be translated back to absence on both sides.
  it("leaves shift and status undefined when they are not set", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    const params = shiftReports.mock.calls[0]?.[0];
    expect(params?.shift).toBeUndefined();
    expect(params?.status).toBeUndefined();
  });
});

// THE HEADER AREA PICKER, AS A REQUEST FILTER.
//
// This is the rule that INVERTED: the hook's header used to say the area "never
// filters a request on its own — it only decides which work centers a page may
// offer". Every report list sends it now, and `area_id` is a column on every
// report table as of migration 0028.
//
// Asserting it on the REQUEST and not on the rendered rows is the point. The
// fetcher is mocked, so a screen that read the area and quietly dropped it before
// the call renders exactly the same table — the failure has no visible symptom
// except a list that is too long, which looks like real data.
describe("ShiftReportTable — the area filter", () => {
  it("sends the selected area with the request", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0].areaId).toBe(AREA.id);
  });

  // AN UNDEFINED AREA MUST NOT GATE THE QUERY, which is the inverse of the
  // stranded-line rule below and the same call area-report-table.tsx makes. The
  // provider resolves the area from a cache seed or falls back to the first area,
  // so it is undefined only while `["areas"]` is still in flight — and core-api
  // reads an absent `areaId` as EVERY area. Gating here would render a skeleton
  // that clears a tick later on every cold load; a gated useQuery reports
  // `status: "pending"` forever, so gating it wrongly renders one that never
  // clears at all.
  it("still fetches, unfiltered, while the area list is loading", async () => {
    renderTable(table(), []);

    await screen.findByText("Molca Line 1");

    expect(shiftReports).toHaveBeenCalledTimes(1);
    expect(shiftReports.mock.calls[0]?.[0].areaId).toBeUndefined();
  });

  // The two ids are independent: a page can be narrowed to one line INSIDE the
  // selected area, and neither filter may swallow the other.
  it("sends the area and the line together", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0]).toMatchObject({
      areaId: AREA.id,
      workCenterId: LINE_2.id,
    });
  });

  // A STRANDED LINE MUST NOT STRAND THE AREA. The line id is dropped from the
  // request when it belongs to an area we have left; the area itself is never
  // stranded, so the list narrows to the selected area rather than widening to
  // the whole plant — which is the outcome that would look like working data.
  it("keeps the area when the line id is stranded", async () => {
    renderTable(table({ search: search({ workCenterId: 999 }) }));

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0]).toMatchObject({
      areaId: AREA.id,
      workCenterId: undefined,
    });
  });
});

describe("ShiftReportTable — the stranded line filter", () => {
  it("drops a line id the current area does not offer", async () => {
    renderTable(table({ search: search({ workCenterId: 999 }) }));

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0].workCenterId).toBeUndefined();
  });

  it("keeps a line id the current area does offer", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0].workCenterId).toBe(LINE_2.id);
  });

  // While the options are still loading `workCenters` is undefined and
  // `undefined?.every()` is falsy, so the requested id STANDS rather than the
  // list silently widening to every machine on the first render.
  it("keeps a requested line while the options are still loading", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }), []);

    await screen.findByText("Molca Line 1");

    expect(shiftReports.mock.calls[0]?.[0].workCenterId).toBe(LINE_2.id);
  });
});

describe("ShiftReportTable — the four states", () => {
  it("renders skeletons while pending", () => {
    shiftReports.mockReturnValue(new Promise(() => {}));
    const { container } = renderTable(table());

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  it("renders the error state and drops the skeletons", async () => {
    shiftReports.mockRejectedValue(new Error("boom"));
    const { container } = renderTable(table());

    await screen.findByText(/could not load shift reports/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("renders the empty state and drops the skeletons", async () => {
    shiftReports.mockResolvedValue(page([]));
    const { container } = renderTable(table());

    await screen.findByText(/no shift reports for these filters/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });
});

describe("ShiftReportTable — row numbering", () => {
  // Out of the table body, not by text: the pager renders page numbers too.
  function indexColumn(container: HTMLElement): string[] {
    return [...container.querySelectorAll("tbody tr")].map(
      (tr) => tr.querySelector("td")?.textContent ?? "",
    );
  }

  it("numbers rows continuously across pages", async () => {
    shiftReports.mockResolvedValue(page([row({ id: 71 }), row({ id: 72 })], { page: 8, size: 10 }));
    const { container } = renderTable(table({ search: search({ page: 8, size: 10 }) }));

    await screen.findAllByText("Molca Line 1");
    expect(indexColumn(container)).toEqual(["71", "72"]);
  });

  it("starts at 1 on the first page", async () => {
    const { container } = renderTable(table());

    await screen.findByText("Molca Line 1");
    expect(indexColumn(container)).toEqual(["1"]);
  });
});

describe("ShiftReportTable — the date column", () => {
  // `date` is the shift's START INSTANT, so the calendar day depends on the
  // plant's zone. 2026-08-02T16:00Z is 23:00 on the 2nd at Asia/Jakarta — reading
  // it as UTC would render the 2nd here too, so the case that actually separates
  // them is the null zone below.
  it("renders the plant-local day", async () => {
    renderTable(table());

    await screen.findByText(/02\/08\/2026/);
  });

  // Enrichment degrades to null rather than failing the page, and a guessed day
  // would be worse than no day.
  it("renders a dash rather than a guessed day when the zone is missing", async () => {
    shiftReports.mockResolvedValue(page([row({ timeZone: null })]));
    const { container } = renderTable(table());

    await screen.findByText("Molca Line 1");
    const cells = [...container.querySelectorAll("tbody tr td")].map((td) => td.textContent);
    expect(cells).toContain("—");
  });
});
