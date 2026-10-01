import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaProvider } from "@/components/layout/area-context";
import { PeriodReportTable } from "@/components/report/period-report-table";
import { renderWithQuery } from "@/test/render";

import type { PeriodReportListItem } from "@/lib/types";
import type { PeriodSearch } from "@/lib/period-search";
import type { ReactElement } from "react";

// PINS THE BY DAY / BY MONTHLY LIST BEFORE THE SHARED CHROME IS EXTRACTED OUT OF IT.
//
// This screen and machine/by-shift.tsx each carry their own copy of four rules,
// and the extraction moves all four into components/report/report-list-*.tsx.
// None of them fails loudly when a copy drifts, which is why they are worth
// pinning first rather than after:
//
//   1. WHICH endpoint function is called. The By Day and By Monthly screens are
//      ONE component distinguished only by `grain`, and the three report tables
//      have INDEPENDENT serial sequences — so a grain that reaches the wrong
//      endpoint renders a full page of plausible rows for another table. A test
//      asserting "rows appear" passes either way; this asserts the CALL.
//   2. The stranded-workCenterId rule, in BOTH directions. Getting it backwards
//      either sends core-api an id it would 404 on, or silently widens a filtered
//      list to every machine.
//   3. The four DataTable states, asserting the skeleton is GONE rather than
//      merely that a message appeared — rendering both is the state the
//      `enabled: false` -> "pending forever" bug actually produced (TODOS §16).
//   4. Row numbering continuous across pages. Off by a page looks entirely
//      plausible and nothing else in the app would notice.
//
// It mocks lib/api rather than lib/queries, matching timeline-card.test.tsx: the
// wiring between the component and the query layer IS the code under test here,
// and stubbing the hook would replace it.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getPeriodReports: vi.fn(),
  getShiftReports: vi.fn(),
}));

const { getPeriodReports, getShiftReports } = await import("@/lib/api");
const periodReports = vi.mocked(getPeriodReports);
const shiftReports = vi.mocked(getShiftReports);

const AREA = { id: 5, code: "FI-2", name: "Filling 2" };
const LINE_1 = { id: 11, code: "L1", name: "Molca Line 1" };
const LINE_2 = { id: 12, code: "L2", name: "Molca Line 2" };

// The area lands from the cache, so AreaProvider resolves areaId synchronously
// and useWorkCenters is never gated off. A test that wants the UNRESOLVED case
// omits these seeds; see "keeps a requested line while the options are loading".
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
  };
}

function row(overrides: Partial<PeriodReportListItem> = {}): PeriodReportListItem {
  return {
    grain: "day",
    id: 1,
    date: "2026-08-26T00:00:00.000Z",
    businessDate: "2026-08-26",
    month: null,
    timeZone: "Asia/Jakarta",
    oee: 96.791,
    availability: 100,
    performance: 96.791,
    quality: 100,
    workUnit: { id: 42, code: "VP-N", name: "Vertical Packer N" },
    workCenter: LINE_1,
    ...overrides,
  };
}

function page(items: PeriodReportListItem[], meta?: Partial<{ page: number; size: number }>) {
  const p = meta?.page ?? 1;
  const size = meta?.size ?? 10;
  return {
    items,
    meta: { page: p, size, totalElements: 42, totalPages: 5, first: p === 1, last: false },
  };
}

// AreaProvider is NOT in renderWithQuery's wrapper — useSelectedArea throws
// without it. Wrapped here rather than added to test/render.tsx, which would
// change the provider tree of every existing card test for this file's benefit.
function renderTable(ui: ReactElement, seed = [SEED_AREA, SEED_LINES]) {
  return renderWithQuery(<AreaProvider>{ui}</AreaProvider>, { seed });
}

function table(props: Partial<Parameters<typeof PeriodReportTable>[0]> = {}) {
  return (
    <PeriodReportTable
      grain="day"
      search={search()}
      onFilter={() => {}}
      onPageChange={() => {}}
      detailTo="/report/machine/by-day/$reportId"
      {...props}
    />
  );
}

beforeEach(() => {
  periodReports.mockResolvedValue(page([row()]));
  shiftReports.mockResolvedValue({ items: [], meta: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PeriodReportTable — which endpoint answered", () => {
  // The whole point of the grain prop. Asserting rows rendered would pass even
  // if this screen called the SHIFT endpoint, because both return the same
  // envelope and both carry a populated Line column.
  it("asks the day endpoint at day grain, and never the shift one", async () => {
    renderTable(table({ grain: "day" }));

    await screen.findByText("Molca Line 1");

    expect(periodReports).toHaveBeenCalledWith(
      "day",
      expect.objectContaining({ page: 1, size: 10 }),
    );
    expect(shiftReports).not.toHaveBeenCalled();
  });

  it("asks the month endpoint at month grain", async () => {
    renderTable(table({ grain: "month", detailTo: "/report/machine/by-monthly/$reportId" }));

    await screen.findByText("Molca Line 1");

    expect(periodReports).toHaveBeenCalledWith("month", expect.anything());
    expect(periodReports).not.toHaveBeenCalledWith("day", expect.anything());
  });

  // `shift` and `status` are absent from this screen's server contract. Sending
  // either would be IGNORED by core-api, which answers a filtered request with an
  // unfiltered page — data rather than an error.
  it("never sends shift or status", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    const params = periodReports.mock.calls[0]?.[1];
    expect(params).not.toHaveProperty("shift");
    expect(params).not.toHaveProperty("status");
  });
});

describe("PeriodReportTable — the stranded line filter", () => {
  // Switching area can leave a workCenterId in the URL that belongs to the area
  // we just left. It is DROPPED FROM THE REQUEST but left in the URL, so
  // switching back restores the filter.
  it("drops a line id the current area does not offer", async () => {
    renderTable(table({ search: search({ workCenterId: 999 }) }));

    await screen.findByText("Molca Line 1");

    expect(periodReports.mock.calls[0]?.[1].workCenterId).toBeUndefined();
  });

  it("keeps a line id the current area does offer", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));

    await screen.findByText("Molca Line 1");

    expect(periodReports.mock.calls[0]?.[1].workCenterId).toBe(LINE_2.id);
  });

  // The OTHER direction, and the one that is easy to get backwards. While the
  // options are still loading `workCenters` is undefined, and `undefined?.every()`
  // is falsy — so the requested id STANDS rather than the list silently widening
  // to every machine on the first render.
  it("keeps a requested line while the options are still loading", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }), []);

    await screen.findByText("Molca Line 1");

    expect(periodReports.mock.calls[0]?.[1].workCenterId).toBe(LINE_2.id);
  });
});

// THE HEADER AREA PICKER, AS A REQUEST FILTER.
//
// The rule that INVERTED. `use-work-center-filter.ts` used to say the area "never
// filters a request on its own — it only decides which work centers a page may
// offer"; every report list sends it now, and migration 0028 put `area_id` on
// every report table. Asserted on the REQUEST rather than on the rendered rows,
// because the fetcher is mocked: a screen that read the area and dropped it
// before the call renders an identical table, and the only symptom is a list that
// is too long — which looks like real data.
describe("PeriodReportTable — the area filter", () => {
  it("sends the selected area with the request", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    expect(periodReports.mock.calls[0]?.[1].areaId).toBe(AREA.id);
  });

  // AN UNDEFINED AREA MUST NOT GATE THE QUERY — the inverse of the stranded-line
  // rule above, and the same call area-report-table.tsx makes. core-api reads an
  // absent `areaId` as EVERY area, so the first paint shows data and narrows a
  // tick later; a gated useQuery reports `status: "pending"` forever, so gating
  // it wrongly renders a skeleton that never clears.
  it("still fetches, unfiltered, while the area list is loading", async () => {
    renderTable(table(), []);

    await screen.findByText("Molca Line 1");

    expect(periodReports).toHaveBeenCalledTimes(1);
    expect(periodReports.mock.calls[0]?.[1].areaId).toBeUndefined();
  });

  // The two ids are independent: a page can be narrowed to one line INSIDE the
  // selected area, and a STRANDED line must not strand the area with it — that
  // would widen the list to the whole plant, which is the outcome that looks like
  // working data.
  it("keeps the area whether the line stands or is stranded", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));
    await screen.findByText("Molca Line 1");
    expect(periodReports.mock.calls[0]?.[1]).toMatchObject({
      areaId: AREA.id,
      workCenterId: LINE_2.id,
    });

    cleanup();
    vi.clearAllMocks();
    periodReports.mockResolvedValue(page([row()]));

    renderTable(table({ search: search({ workCenterId: 999 }) }));
    await screen.findByText("Molca Line 1");
    expect(periodReports.mock.calls[0]?.[1]).toMatchObject({
      areaId: AREA.id,
      workCenterId: undefined,
    });
  });
});

describe("PeriodReportTable — the four states", () => {
  it("renders skeletons while pending", () => {
    periodReports.mockReturnValue(new Promise(() => {}));
    const { container } = renderTable(table());

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  // Asserts the skeleton is GONE, not merely that the message appeared. The bug
  // this guards against rendered BOTH.
  it("renders the error state and drops the skeletons", async () => {
    periodReports.mockRejectedValue(new Error("boom"));
    const { container } = renderTable(table());

    await screen.findByText(/could not load day reports/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("renders the empty state and drops the skeletons", async () => {
    periodReports.mockResolvedValue(page([]));
    const { container } = renderTable(table());

    await screen.findByText(/no day reports for these filters/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("names the grain in both messages at month grain", async () => {
    periodReports.mockResolvedValue(page([]));
    renderTable(table({ grain: "month", detailTo: "/report/machine/by-monthly/$reportId" }));

    await screen.findByText(/no month reports for these filters/i);
  });
});

describe("PeriodReportTable — row numbering", () => {
  // (page - 1) * size + index + 1. Off by a page is invisible: the numbers are
  // still consecutive, they just start at the wrong one.
  // Read out of the TABLE BODY rather than by text: the pager renders page
  // NUMBERS too, so getByText("1") matches the pagination button as well and the
  // assertion would be ambiguous on page 1 and vacuous everywhere else.
  function indexColumn(container: HTMLElement): string[] {
    return [...container.querySelectorAll("tbody tr")].map(
      (tr) => tr.querySelector("td")?.textContent ?? "",
    );
  }

  it("numbers rows continuously across pages", async () => {
    periodReports.mockResolvedValue(
      page([row({ id: 31 }), row({ id: 32 })], { page: 4, size: 10 }),
    );
    const { container } = renderTable(table({ search: search({ page: 4, size: 10 }) }));

    // findAllByText: both rows are on the same line, so the singular query would
    // throw on multiple matches rather than assert anything.
    await screen.findAllByText("Molca Line 1");
    expect(indexColumn(container)).toEqual(["31", "32"]);
  });

  it("starts at 1 on the first page", async () => {
    const { container } = renderTable(table());

    await screen.findByText("Molca Line 1");
    expect(indexColumn(container)).toEqual(["1"]);
  });
});

describe("PeriodReportTable — the period column", () => {
  // businessDate is a plant-local 'YYYY-MM-DD' and must never go through a zone
  // conversion. formatReportDate would read it as UTC midnight and render 25
  // August here, on every row, looking entirely normal.
  it("formats a day row from businessDate without a zone conversion", async () => {
    renderTable(table());

    await screen.findByText(/26\/08\/2026/);
  });

  it("formats a month row as a month label", async () => {
    periodReports.mockResolvedValue(page([row({ grain: "month", businessDate: "2026-08-01" })]));
    renderTable(table({ grain: "month", detailTo: "/report/machine/by-monthly/$reportId" }));

    await screen.findByText(/August 2026/);
  });
});
