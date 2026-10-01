import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, screen } from "@testing-library/react";

import { AreaProvider } from "@/components/layout/area-context";
import { LineReportTable } from "@/components/report/line-report-table";
import { renderWithQuery } from "@/test/render";

import type { LineReportListItem } from "@/lib/types";
import type { PeriodSearch } from "@/lib/period-search";
import type { ReactElement } from "react";

// The three Line list screens.
//
// It mocks lib/api rather than lib/queries, matching timeline-card.test.tsx: the
// wiring between the component and the query layer IS the code under test, and
// stubbing the hook would replace it.
//
// getPeriodReports and getShiftReports are mocked ONLY so they can be asserted
// UN-called. That is the highest-value assertion in this file — see below.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getLineReports: vi.fn(),
  getPeriodReports: vi.fn(),
  getShiftReports: vi.fn(),
}));

const { getLineReports, getPeriodReports, getShiftReports } = await import("@/lib/api");
const lineReports = vi.mocked(getLineReports);
const periodReports = vi.mocked(getPeriodReports);
const shiftReports = vi.mocked(getShiftReports);

const AREA = { id: 5, code: "FI-2", name: "Filling 2" };
// The Line FILTER's options still come from mes-master-data and are nested —
// that endpoint is unchanged. Only the report ROWS are flat.
const LINE_1 = { id: 11, code: "L1", name: "Molca Line 1" };
const LINE_2 = { id: 12, code: "L2", name: "Molca Line 2" };

// A REAL response body, captured verbatim from
// GET /api/proxy/api/v1/work-centers/day-reports on a running dev stack.
//
// IT IS HERE BECAUSE THE HAND-WRITTEN FIXTURE BELOW COULD NOT CATCH A SEAM BUG.
// `row()` is built from LineReportListItem, so when that type declared a nested
// `workCenter` object the fixture obligingly produced one, both sides of every
// assertion agreed, 27 tests passed — and every Line cell on the real screen
// rendered an em dash, because `workCenter?.name ?? EM_DASH` degrades silently.
//
// This constant is the wire, not our idea of it. If the endpoint's shape ever
// drifts from it, the assertion using it fails.
const WIRE_ROW = {
  id: 6,
  grain: "day",
  businessDate: "2026-08-22",
  timeZone: "Asia/Jakarta",
  shift: null,
  workCenterId: 2,
  workCenterName: "Line 1",
  workCenterCode: "FI2-L1",
  workUnitCount: 1,
  expectedWorkUnitCount: null,
  oee: 88.865,
  availability: 91.557,
  performance: 97.377,
  quality: 99.673,
} as const;

const SEED_AREA = { queryKey: ["areas"], data: [AREA] };
const SEED_LINES = { queryKey: ["work-centers", AREA.id], data: [LINE_1, LINE_2] };

type Search = PeriodSearch & { shift?: string | undefined };

function search(overrides: Partial<Search> = {}): Search {
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

function row(overrides: Partial<LineReportListItem> = {}): LineReportListItem {
  return {
    grain: "day",
    shift: null,
    id: 1,
    businessDate: "2026-08-26",
    timeZone: "Asia/Jakarta",
    workCenterId: LINE_1.id,
    workCenterName: LINE_1.name,
    workCenterCode: LINE_1.code,
    workUnitCount: 3,
    expectedWorkUnitCount: 4,
    oee: 96.791,
    availability: 100,
    performance: 96.791,
    quality: 100,
    ...overrides,
  } as LineReportListItem;
}

function page(items: LineReportListItem[], meta?: Partial<{ page: number; size: number }>) {
  const p = meta?.page ?? 1;
  const size = meta?.size ?? 10;
  return {
    items,
    meta: { page: p, size, totalElements: 42, totalPages: 5, first: p === 1, last: false },
  };
}

// LineReportTable calls useSelectedArea(), which THROWS outside <AreaProvider>,
// and renderWithQuery does not supply one. Wrapped here rather than added to
// test/render.tsx, which would change the provider tree of every existing card
// test for this one file's benefit.
function renderTable(ui: ReactElement, seed = [SEED_AREA, SEED_LINES]) {
  return renderWithQuery(<AreaProvider>{ui}</AreaProvider>, { seed });
}

function table(props: Partial<Parameters<typeof LineReportTable>[0]> = {}) {
  return (
    <LineReportTable
      grain="day"
      search={search()}
      onFilter={() => {}}
      onPageChange={() => {}}
      detailTo="/report/line/by-day/$reportId"
      {...props}
    />
  );
}

beforeEach(() => {
  lineReports.mockResolvedValue(page([row()]));
  periodReports.mockResolvedValue({ items: [], meta: undefined });
  shiftReports.mockResolvedValue({ items: [], meta: undefined });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LineReportTable — which endpoint answered", () => {
  // THE HIGHEST-VALUE ASSERTION IN THIS FILE.
  //
  // This component was written from period-report-table.tsx. A forgotten import
  // swap would hit the MACHINE endpoint and render a full table of plausible rows
  // with a populated Line column — passing every other assertion here. AGENTS.md
  // states the rule for exactly this: assert WHICH function was called.
  it.each(["shift", "day", "month"] as const)(
    "asks the line endpoint at %s grain, and never a machine one",
    async (grain) => {
      renderTable(table({ grain }));

      await screen.findByText("Molca Line 1");

      expect(lineReports).toHaveBeenCalledWith(grain, expect.objectContaining({ page: 1 }));
      expect(periodReports).not.toHaveBeenCalled();
      expect(shiftReports).not.toHaveBeenCalled();
    },
  );

  it("forwards shift at shift grain", async () => {
    renderTable(table({ grain: "shift", search: search({ shift: "2" }) }));

    await screen.findByText("Molca Line 1");

    expect(lineReports).toHaveBeenCalledWith("shift", expect.objectContaining({ shift: "2" }));
  });

  // NOT EVEN AS `shift: undefined`. A stray undefined key is a SECOND react-query
  // cache key for an identical server page, which is invisible except as a double
  // fetch.
  it.each(["day", "month"] as const)("omits the shift key entirely at %s grain", async (grain) => {
    renderTable(table({ grain, search: search({ shift: "2" }) }));

    await screen.findByText("Molca Line 1");

    expect(lineReports.mock.calls[0]?.[1]).not.toHaveProperty("shift");
  });

  // A line has no approval at any grain.
  it("never sends status", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    expect(lineReports.mock.calls[0]?.[1]).not.toHaveProperty("status");
  });
});

describe("LineReportTable — the stranded line filter", () => {
  it("drops a line id the current area does not offer", async () => {
    renderTable(table({ search: search({ workCenterId: 999 }) }));

    await screen.findByText("Molca Line 1");

    expect(lineReports.mock.calls[0]?.[1].workCenterId).toBeUndefined();
  });

  it("keeps a line id the current area does offer", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));

    await screen.findByText("Molca Line 1");

    expect(lineReports.mock.calls[0]?.[1].workCenterId).toBe(LINE_2.id);
  });

  // The `enabled: false` -> "pending forever" trap in its real form here:
  // useWorkCenters is gated on areaId, so with no area resolved the options are
  // undefined. `undefined?.every()` is falsy, so the requested id must STAND
  // rather than the list silently widening to every line for one render.
  it("keeps a requested line while the options are still loading", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }), []);

    await screen.findByText("Molca Line 1");

    expect(lineReports.mock.calls[0]?.[1].workCenterId).toBe(LINE_2.id);
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
describe("LineReportTable — the area filter", () => {
  it("sends the selected area with the request", async () => {
    renderTable(table());

    await screen.findByText("Molca Line 1");

    expect(lineReports.mock.calls[0]?.[1].areaId).toBe(AREA.id);
  });

  // AN UNDEFINED AREA MUST NOT GATE THE QUERY — the inverse of the stranded-line
  // rule above, and the same call area-report-table.tsx makes. core-api reads an
  // absent `areaId` as EVERY area, so the first paint shows data and narrows a
  // tick later; a gated useQuery reports `status: "pending"` forever, so gating
  // it wrongly renders a skeleton that never clears.
  it("still fetches, unfiltered, while the area list is loading", async () => {
    renderTable(table(), []);

    await screen.findByText("Molca Line 1");

    expect(lineReports).toHaveBeenCalledTimes(1);
    expect(lineReports.mock.calls[0]?.[1].areaId).toBeUndefined();
  });

  // The two ids are independent: a page can be narrowed to one line INSIDE the
  // selected area, and a STRANDED line must not strand the area with it — that
  // would widen the list to the whole plant, which is the outcome that looks like
  // working data.
  it("keeps the area whether the line stands or is stranded", async () => {
    renderTable(table({ search: search({ workCenterId: LINE_2.id }) }));
    await screen.findByText("Molca Line 1");
    expect(lineReports.mock.calls[0]?.[1]).toMatchObject({
      areaId: AREA.id,
      workCenterId: LINE_2.id,
    });

    cleanup();
    vi.clearAllMocks();
    lineReports.mockResolvedValue(page([row()]));

    renderTable(table({ search: search({ workCenterId: 999 }) }));
    await screen.findByText("Molca Line 1");
    expect(lineReports.mock.calls[0]?.[1]).toMatchObject({
      areaId: AREA.id,
      workCenterId: undefined,
    });
  });
});

describe("LineReportTable — the columns", () => {
  it("renders no Machine column at any grain", async () => {
    for (const grain of ["shift", "day", "month"] as const) {
      const { unmount } = renderTable(table({ grain }));
      await screen.findByText("Molca Line 1");
      expect(screen.queryByRole("columnheader", { name: "Machine" })).toBeNull();
      unmount();
    }
  });

  it("renders no Status column at any grain", async () => {
    for (const grain of ["shift", "day", "month"] as const) {
      const { unmount } = renderTable(table({ grain }));
      await screen.findByText("Molca Line 1");
      expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
      unmount();
    }
  });

  it("renders the Shift column at shift grain only", async () => {
    const shift = renderTable(table({ grain: "shift", search: search() }));
    await screen.findByText("Molca Line 1");
    expect(screen.getByRole("columnheader", { name: "Shift" })).toBeTruthy();
    shift.unmount();

    renderTable(table({ grain: "day" }));
    await screen.findByText("Molca Line 1");
    expect(screen.queryByRole("columnheader", { name: "Shift" })).toBeNull();
  });

  // THE REGRESSION TEST FOR THE SHAPE THIS SHIPPED WRONG.
  //
  // Rendered against a response captured verbatim from the running endpoint, so
  // it fails if the browser's idea of the payload drifts from the wire again. The
  // em dash is asserted ABSENT explicitly: that is what the nested-shape bug
  // produced, and "the name is missing" and "the name is an em dash" are the same
  // pixel but different bugs.
  it("renders the line name from a real endpoint payload", async () => {
    lineReports.mockResolvedValue(page([WIRE_ROW as unknown as LineReportListItem]));
    const { container } = renderTable(table());

    expect(await screen.findByText("Line 1")).toBeTruthy();
    const cells = [...container.querySelectorAll("tbody tr td")].map((td) => td.textContent);
    expect(cells).not.toContain("—");
  });

  // The one thing that makes a PARTIAL line visible.
  it("renders the machine count as N of M when the roster is known", async () => {
    renderTable(table());

    expect(await screen.findByText("3 of 4")).toBeTruthy();
  });

  // "3" is true on its own terms; "3 of 4" would be a guess. §16.5 says the
  // expected count must never be invented.
  it("falls back to a bare count when the roster is unknown", async () => {
    lineReports.mockResolvedValue(page([row({ expectedWorkUnitCount: null })]));
    const { container } = renderTable(table());

    await screen.findByText("Molca Line 1");
    const cells = [...container.querySelectorAll("tbody tr td")].map((td) => td.textContent);
    expect(cells).toContain("3");
    expect(cells).not.toContain("3 of 4");
  });

  // 0/0 recomputed is NULL, not a measured zero, and formatPercent says so.
  it("renders a null rate as an em dash rather than 0%", async () => {
    lineReports.mockResolvedValue(page([row({ oee: null })]));
    const { container } = renderTable(table());

    await screen.findByText("Molca Line 1");
    const cells = [...container.querySelectorAll("tbody tr td")].map((td) => td.textContent);
    expect(cells).toContain("—");
    expect(cells).not.toContain("0%");
  });
});

describe("LineReportTable — the period column", () => {
  // businessDate is plant-local and must never go through formatReportDate, which
  // would read '2026-08-26' as UTC midnight and render the 25th for any plant west
  // of Greenwich — on every row, looking entirely normal.
  it("formats a day row from businessDate with no zone conversion", async () => {
    renderTable(table({ grain: "day" }));

    expect(await screen.findByText(/26\/08\/2026/)).toBeTruthy();
  });

  it("formats a month row as a month label", async () => {
    lineReports.mockResolvedValue(page([row({ grain: "month", businessDate: "2026-08-01" })]));
    renderTable(table({ grain: "month" }));

    expect(await screen.findByText(/August 2026/)).toBeTruthy();
  });

  // Shift grain uses the SAME formatter, because these tables carry no instant at
  // all — unlike the machine By Shift list, which has to reduce a shift-start
  // instant through the plant zone and shows an em dash when it is missing.
  it("formats a shift row from businessDate too, with the shift beside it", async () => {
    lineReports.mockResolvedValue(
      page([row({ grain: "shift", shift: 3, businessDate: "2026-08-02" })]),
    );
    renderTable(table({ grain: "shift", search: search() }));

    expect(await screen.findByText(/02\/08\/2026/)).toBeTruthy();
    expect(screen.getByRole("cell", { name: "3" })).toBeTruthy();
  });
});

describe("LineReportTable — where the eye goes", () => {
  // THE ASSERTION IS THE HREF, NOT THAT A LINK EXISTS. This column was an inert
  // <span> until the Line detail screen landed, and the reason it was inert is the
  // reason these tests check the target: a
  // <Link to="/report/machine/by-shift/$reportId"> pasted across from the machine
  // column WOULD compile — the param name is identical — and would open an
  // unrelated MACHINE report, because the seven report tables have seven independent
  // identity sequences. A full page of plausible figures under a Line breadcrumb,
  // with nothing on screen saying so.
  it.each([
    ["shift", "/report/line/by-shift/$reportId", "/report/line/by-shift/7"],
    ["day", "/report/line/by-day/$reportId", "/report/line/by-day/7"],
    ["month", "/report/line/by-monthly/$reportId", "/report/line/by-monthly/7"],
  ] as const)("points a %s row at the line detail route", async (grain, detailTo, href) => {
    // Cast because LineReportListItem is a union on `grain`, and the parametrised
    // grain here is the union of all three — narrowing per case would turn one
    // table-driven test into three copies of itself.
    lineReports.mockResolvedValue(
      page([
        row({ id: 7, grain, shift: grain === "shift" ? 1 : null } as Partial<LineReportListItem>),
      ]),
    );

    renderTable(table({ grain, detailTo, search: search() }));

    const link = await screen.findByLabelText("View report 7");
    expect(link.getAttribute("href")).toBe(href);
  });

  // NEVER A /report/machine/* PATH, at any grain. The negative is asserted
  // separately because the positive above would still pass if the component
  // rendered two links, and because this is the specific mistake being guarded.
  it("never points at a machine route", async () => {
    renderTable(table());

    const link = await screen.findByLabelText("View report 1");
    expect(link.getAttribute("href")).not.toContain("/machine/");
  });
});

describe("LineReportTable — the four states", () => {
  it("renders skeletons while pending", () => {
    lineReports.mockReturnValue(new Promise(() => {}));
    const { container } = renderTable(table());

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  // Asserts the skeleton is GONE, not merely that the message appeared. The bug
  // this guards against rendered BOTH.
  it("renders the error state and drops the skeletons", async () => {
    lineReports.mockRejectedValue(new Error("boom"));
    const { container } = renderTable(table());

    await screen.findByText(/could not load day reports/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it("renders the empty state and drops the skeletons", async () => {
    lineReports.mockResolvedValue(page([]));
    const { container } = renderTable(table());

    await screen.findByText(/no day reports for these filters/i);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
  });

  it.each([
    ["shift", /no shift reports/i],
    ["month", /no month reports/i],
  ] as const)("names the %s grain in its empty message", async (grain, message) => {
    lineReports.mockResolvedValue(page([]));
    renderTable(table({ grain }));

    expect(await screen.findByText(message)).toBeTruthy();
  });

  // Cheap insurance on the extracted shell.
  it("keeps the ETL grace-period banner", async () => {
    renderTable(table());

    expect(await screen.findByText(/07:15, 15:15, 23:15/)).toBeTruthy();
  });
});
