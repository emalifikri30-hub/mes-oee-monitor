import { describe, expect, it, vi } from "vite-plus/test";

import { AreaReportService } from "./area-report-service.js";

import type { AreaReportReader } from "./area-report-repository.js";

const REPORT = {
  id: 11,
  grain: "day" as const,
  businessDate: "2026-09-01",
  timeZone: "Asia/Jakarta",
  areaId: 2,
  areaName: "FI2",
};

const LINES = { workCenterIds: [2, 3] };

// THE GRAIN IS THE FIRST ARGUMENT OF EVERY ID-ADDRESSED METHOD, and it is not
// ceremony: the two area tables have INDEPENDENT identity sequences, so
// `getReport("day", 11)` and `getReport("month", 11)` are two different reports.
// Most assertions below use the DAY grain because the two paths are one
// implementation; what differs is the WINDOW, and the month describe block at the
// end is where that is pinned.
const DAY = "day" as const;
const MONTH = "month" as const;

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind: "reject" as const,
    shift: 1,
    enteredAt: "2026-09-01T08:00:00.000Z",
    enteredBy: "u1",
    enteredByName: "Operator One",
    productName: "SKU A",
    reasonName: "Torn",
    enteredQty: 10,
    enteredUomCode: "BAG",
    targetQty: 10,
    targetUomCode: "BAG",
    unitCheck: "ok",
    voidedAt: null,
    voidedBy: null,
    voidedByName: null,
    voidReason: null,
    ...over,
  };
}

// THE REPORT IS WRAPPED, so that "the repository found nothing" is representable.
// `setup(report: unknown = REPORT)` cannot express it: passing `undefined` selects
// the DEFAULT, so the 404 test would call the happy path and pass by resolving.
// The same trap product-report-service.test.ts records, one subject over.
function setup(
  opts: {
    report?: unknown;
    lines?: { workCenterIds: number[] };
    downtime?: { entries: unknown[]; totalMembers: number; trackedMembers: number };
    // Keyed by work center id, so a fan-out test can give each line its own
    // entries and the merge can be asserted.
    quality?: Record<number, unknown[]>;
    watermark?: string | null;
  } = {},
) {
  const getReport = vi.fn().mockResolvedValue("report" in opts ? opts.report : REPORT);
  const paginateReport = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
  const listAreaLines = vi.fn().mockResolvedValue(opts.lines ?? LINES);
  const listProductCount = vi.fn().mockResolvedValue([]);
  const aggregateProductionUnits = vi.fn().mockResolvedValue({
    infeed: [],
    output: [],
    infeedUnresolved: 0,
    outputUnresolved: 0,
  });
  const aggregateRejectReasons = vi.fn().mockResolvedValue({ buckets: [], totalQuantity: 0 });
  const aggregateDowntimeEventReasons = vi.fn().mockResolvedValue({ buckets: [] });
  const listDowntimeEdits = vi
    .fn()
    .mockResolvedValue(opts.downtime ?? { entries: [], totalMembers: 0, trackedMembers: 0 });

  const repo = {
    getReport,
    paginateReport,
    listAreaLines,
    listProductCount,
    aggregateProductionUnits,
    aggregateRejectReasons,
    aggregateDowntimeEventReasons,
    listDowntimeEdits,
  } as unknown as AreaReportReader;

  const listActivityForTarget = vi
    .fn()
    .mockImplementation(({ workCenterId }: { workCenterId: number }) =>
      Promise.resolve(opts.quality?.[workCenterId] ?? []),
    );

  // getWatermark reads the real Gold handle directly. A flat stub is enough here,
  // unlike the SKU service's — nothing in this module calls resolveReportWindow,
  // because `time_zone` is NOT NULL on oee.area_day_reports and no read needs the
  // day's INSTANTS.
  const watermarkRows =
    "watermark" in opts ? [{ lastBusinessDate: opts.watermark }] : [{ lastBusinessDate: null }];
  const seen: string[] = [];
  const goldDb = ((chunks: TemplateStringsArray, ...values: unknown[]) => {
    seen.push(String(values[0]));
    void chunks;
    return Promise.resolve(watermarkRows);
  }) as never;

  return {
    service: new AreaReportService({
      areaReportReaderRepository: repo,
      qualityEntryRepository: { listActivityForTarget } as never,
      goldDb,
      // `withLog` is silent on success and calls
      // `logger.withMetadata({...}).error(event)` on failure, so the stub has to
      // be CHAINABLE. A flat { error } passes every happy-path test here and then
      // throws "withMetadata is not a function" from inside the 404 path.
      logger: { withMetadata: () => ({ error: vi.fn() }) } as never,
    }),
    getReport,
    paginateReport,
    listAreaLines,
    listProductCount,
    aggregateProductionUnits,
    aggregateRejectReasons,
    aggregateDowntimeEventReasons,
    listDowntimeEdits,
    listActivityForTarget,
    // Which table each getWatermark call named. The watermark is bound as a
    // PARAMETER (shared/database/watermark.ts), so this is the param and not text.
    watermarkTables: seen,
  };
}

describe("AreaReportService.getReport", () => {
  it("404s an id that names no row", async () => {
    const { service } = setup({ report: undefined });

    await expect(service.getReport(DAY, 11)).rejects.toMatchObject({ status: 404 });
  });

  // THE ASYMMETRY WITH THE LIST, which answers 200-empty for an unknown filter. An
  // id names a row that either exists or does not; a filter describes a set that
  // may be empty. Answering 200 here would make a broken deep link look like an
  // area that produced nothing.
  it("answers the list for a filter that matches nothing", async () => {
    const { service } = setup();

    await expect(
      service.listReports({
        grain: DAY,
        limit: 10,
        offset: 0,
        filter: { month: 9, year: 2026, areaId: 999, isHideZero: false },
      }),
    ).resolves.toEqual({ items: [], totalElements: 0 });
  });
});

// THE WINDOW COMES OFF THE ROW, NOT OFF THE REQUEST, which is what makes an area
// read un-spoofable: the caller names a report id, and which area that is is the
// row's business.
describe("AreaReportService — the window", () => {
  it.each([
    ["rejects", (s: AreaReportService) => s.getRejectReasons(DAY, 11), "aggregateRejectReasons"],
    [
      "downtime-events",
      (s: AreaReportService) => s.getDowntimeEventReasons(DAY, 11),
      "aggregateDowntimeEventReasons",
    ],
    [
      "production-units",
      (s: AreaReportService) => s.getProductionUnits(DAY, 11),
      "aggregateProductionUnits",
    ],
  ] as const)("derives the day window from the row for /%s", async (_label, call, method) => {
    const handles = setup();

    await call(handles.service);

    expect(handles[method]).toHaveBeenCalledWith({
      areaId: 2,
      dateFrom: "2026-09-01",
      // THE NEXT DAY, EXCLUSIVE. Never equal to dateFrom: every source table is
      // shift-keyed on a business DATE, so a zero-width range matches nothing and
      // every card renders empty.
      dateTo: "2026-09-02",
      timeZone: "Asia/Jakarta",
    });
  });

  // NO SHIFT ON THE WINDOW AT ALL. An area day spans all three, and the source
  // tables are shift-keyed — so the range widens over them. A `shift: 1` here
  // would silently report a third of the day, which is a plausible screen.
  it("puts no shift on the window", async () => {
    const { service, aggregateRejectReasons } = setup();

    await service.getRejectReasons(DAY, 11);

    expect(aggregateRejectReasons.mock.calls[0]![0]).not.toHaveProperty("shift");
  });

  // A MONTH BOUNDARY, and the reason this is worth its own case: `addDay` does
  // calendar arithmetic in UTC deliberately, so the last day of a month must roll
  // to the first of the next rather than to "2026-09-32".
  it("rolls a month-end business date to the next month", async () => {
    const { service, aggregateRejectReasons } = setup({
      report: { ...REPORT, businessDate: "2026-09-30" },
    });

    await service.getRejectReasons(DAY, 11);

    expect(aggregateRejectReasons).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: "2026-09-30", dateTo: "2026-10-01" }),
    );
  });
});

describe("AreaReportService.getProductCounts", () => {
  // TWO READS IN SEQUENCE, and the second's SCOPE is the first's RESULT.
  // oee.product_count_wc_day carries no area_id (0016), so the lines have to be
  // resolved first — and passing a fabricated line list, or none, would return the
  // whole plant under one area's heading.
  it("scopes the count by the lines the first read resolved", async () => {
    const { service, listAreaLines, listProductCount } = setup();

    await service.getProductCounts(DAY, 11);

    expect(listAreaLines).toHaveBeenCalledWith(expect.objectContaining({ areaId: 2 }));
    expect(listProductCount).toHaveBeenCalledWith(expect.objectContaining({ areaId: 2 }), LINES);
  });

  it("passes an empty line list through rather than widening it", async () => {
    const { service, listProductCount } = setup({ lines: { workCenterIds: [] } });

    const result = await service.getProductCounts(DAY, 11);

    expect(listProductCount).toHaveBeenCalledWith(expect.anything(), { workCenterIds: [] });
    expect(result.items).toEqual([]);
  });

  // `loadedThrough` NAMES THE TABLE THE ROWS CAME FROM, not the report table. Two
  // different loads: quoting area_day_reports' watermark here would vouch for a
  // freshness this card's own source does not have — and product_count_wc_day
  // ships EMPTY with no dev seed, so that lie would be permanent.
  it("reads the watermark for product_count_wc_day", async () => {
    const { service, watermarkTables } = setup();

    await service.getProductCounts(DAY, 11);

    expect(watermarkTables).toEqual(["product_count_wc_day"]);
  });
});

describe("AreaReportService.getProductionUnits", () => {
  // Same rule, other table: these buckets are summed from the LINE reports, so the
  // freshness that matters is work_center_day_reports'.
  it("reads the watermark for work_center_day_reports", async () => {
    const { service, watermarkTables } = setup();

    await service.getProductionUnits(DAY, 11);

    expect(watermarkTables).toEqual(["work_center_day_reports"]);
  });

  it("passes the aggregate through with the window's zone", async () => {
    const { service } = setup({ watermark: "2026-09-01" });

    await expect(service.getProductionUnits(DAY, 11)).resolves.toEqual({
      infeed: [],
      output: [],
      infeedUnresolved: 0,
      outputUnresolved: 0,
      timeZone: "Asia/Jakarta",
      loadedThrough: "2026-09-01",
    });
  });
});

describe("AreaReportService.getActivity", () => {
  // THREE SOURCES, ALWAYS, and the approval one can never carry an entry.
  it("reports three sources with approval as not-applicable", async () => {
    const { service } = setup();

    const feed = await service.getActivity(DAY, 11);

    expect(feed.sources.map((s) => s.kind)).toEqual(["approval", "downtime", "quality"]);
    expect(feed.sources[0]).toEqual({
      kind: "approval",
      tracked: false,
      untrackedReason: "not-applicable",
      totalMembers: 0,
      trackedMembers: 0,
    });
  });

  // THE QUALITY ARM FANS OUT OVER THE AREA'S LINES, one call per line, with no
  // shift and every SKU. A `shift` here would report a third of the day; a
  // `productId` would narrow an AREA feed to one SKU.
  it("asks the ledger once per line, over the whole day and every SKU", async () => {
    const { service, listActivityForTarget } = setup();

    await service.getActivity(DAY, 11);

    expect(listActivityForTarget).toHaveBeenCalledTimes(2);
    for (const workCenterId of LINES.workCenterIds) {
      expect(listActivityForTarget).toHaveBeenCalledWith({
        workCenterId,
        dateFrom: "2026-09-01",
        dateTo: "2026-09-02",
        shift: null,
        productId: null,
      });
    }
  });

  it("asks the ledger nothing when the area has no lines", async () => {
    const { service, listActivityForTarget } = setup({ lines: { workCenterIds: [] } });

    const feed = await service.getActivity(DAY, 11);

    expect(listActivityForTarget).not.toHaveBeenCalled();
    expect(feed.entries).toEqual([]);
    // ZERO IS A REAL ANSWER — no reject was entered by hand in this area — where
    // an untracked arm would report a quiet day as an unimplemented feature.
    expect(feed.sources[2]).toMatchObject({ kind: "quality", tracked: true, totalMembers: 0 });
  });

  // EACH ENTRY CARRIES THE LINE IT CAME FROM. An area day spans three shifts AND N
  // lines, and a rework names no machine — so without this two lines' entries read
  // as one line's.
  it("stamps each quality entry with the line it was read from", async () => {
    const { service } = setup({
      quality: { 2: [entry({ id: 1 })], 3: [entry({ id: 2, kind: "rework" })] },
    });

    const feed = await service.getActivity(DAY, 11);

    expect(
      feed.entries.map((e) => (e.kind === "quality" ? [e.id, e.workCenterId, e.shift] : null)),
    ).toEqual(
      expect.arrayContaining([
        ["quality:1", 2, 1],
        ["quality:2", 3, 1],
      ]),
    );
  });

  // SORTED ON `at` ACROSS THE ARMS, newest first. It matters more here than in any
  // other feed: the quality arm arrives as N per-line lists concatenated, so
  // without the sort the panel reads as line 2's whole day and then line 3's,
  // which looks like a chronology and is not.
  it("merges the two arms into one reverse-chronological list", async () => {
    const { service } = setup({
      quality: {
        2: [entry({ id: 1, enteredAt: "2026-09-01T08:00:00.000Z" })],
        3: [entry({ id: 2, enteredAt: "2026-09-01T20:00:00.000Z" })],
      },
      downtime: {
        entries: [
          {
            kind: "downtime" as const,
            id: "downtime:9",
            at: new Date("2026-09-01T14:00:00.000Z"),
            by: "u2",
            sourceEventId: "evt-9",
            field: "category",
            oldValue: "PLANNED",
            newValue: "UNPLANNED",
            workUnitId: 3,
            workUnitName: "Filler",
            workCenterId: 2,
            workCenterName: "Line 1",
          },
        ],
        totalMembers: 4,
        trackedMembers: 4,
      },
    });

    const feed = await service.getActivity(DAY, 11);

    expect(feed.entries.map((e) => e.id)).toEqual(["quality:2", "downtime:9", "quality:1"]);
  });

  // ZERO MEMBERS IS NOT AN UNTRACKED ARM. "These downtime records carry no stable
  // identifier" is a claim about records that do not exist.
  it.each([
    [{ totalMembers: 0, trackedMembers: 0 }, true, null],
    [{ totalMembers: 4, trackedMembers: 0 }, false, "no-stable-id"],
    [{ totalMembers: 4, trackedMembers: 2 }, true, null],
  ])("reports the downtime arm as %j -> tracked %s", async (counts, tracked, reason) => {
    const { service } = setup({ downtime: { entries: [], ...counts } });

    const feed = await service.getActivity(DAY, 11);

    expect(feed.sources[1]).toMatchObject({
      kind: "downtime",
      tracked,
      untrackedReason: reason,
      ...counts,
    });
  });

  // NO UNATTRIBUTED RESIDUAL ON THIS PAYLOAD, unlike the SKU feed's, and the
  // difference is the axis. A SKU read narrows by `product_id`, where NULL means
  // "not attributed" and nothing can derive the answer. An area read narrows by
  // `area_id`, which is CONTAINMENT — the area IS derivable from the work unit — so
  // a NULL there is a missing LABEL and the fix is a backfill upstream. Shipping a
  // residual would invite a reader to treat denormalisation lag as an attribution
  // problem.
  it("carries no unattributed count", async () => {
    const { service } = setup();

    const feed = await service.getActivity(DAY, 11);

    expect(feed).not.toHaveProperty("unattributed");
  });
});

// ---------------------------------------------------------------------------
// THE MONTH GRAIN
// ---------------------------------------------------------------------------
//
// ONE IMPLEMENTATION SERVES BOTH, so the only thing that differs is where `dateTo`
// LANDS — and that one difference is the whole of the month grain's arithmetic.
// Getting it wrong is silent in the worst way: `addDay` on a month report gives a
// ONE-DAY window, so every card would render the first of the month and call it
// the month.
describe("AreaReportService — the month grain", () => {
  it("resolves a whole month, not a day, from a month report's row", async () => {
    const { service, aggregateRejectReasons } = setup({
      report: { ...REPORT, grain: MONTH, businessDate: "2026-09-01" },
    });

    await service.getRejectReasons(MONTH, 11);

    expect(aggregateRejectReasons).toHaveBeenCalledWith({
      areaId: 2,
      dateFrom: "2026-09-01",
      // THE FIRST OF THE NEXT MONTH. `ck_amr_month_start` (0025) guarantees
      // `businessDate` is the first of its own, so this is exclusive and exact.
      dateTo: "2026-10-01",
      timeZone: "Asia/Jakarta",
    });
  });

  // MONTH LENGTHS AND THE YEAR BOUNDARY, which is why `addMonth` uses
  // `setUTCMonth` rather than adding thirty days. A `+ 30 days` version passes the
  // September case above and fails all three of these.
  it.each([
    ["a 28-day month", "2026-02-01", "2026-03-01"],
    ["a 31-day month", "2026-01-01", "2026-02-01"],
    ["December, rolling the year", "2026-12-01", "2027-01-01"],
  ])("spans %s exactly", async (_label, businessDate, expected) => {
    const { service, aggregateRejectReasons } = setup({
      report: { ...REPORT, grain: MONTH, businessDate },
    });

    await service.getRejectReasons(MONTH, 11);

    expect(aggregateRejectReasons).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: businessDate, dateTo: expected }),
    );
  });

  // THE GRAIN REACHES THE REPOSITORY'S REPORT READ, which is what picks the table.
  // Nine report tables, nine independent identity sequences: a month request
  // answered from the day table returns a real report about a real day.
  it("asks the repository for the month table", async () => {
    const { service, getReport } = setup({ report: { ...REPORT, grain: MONTH } });

    await service.getReport(MONTH, 11);

    expect(getReport).toHaveBeenCalledWith(MONTH, 11);
  });

  // THE QUALITY ARM WIDENS OVER THE WHOLE MONTH, per line and with no shift. A
  // shift here would report a hundredth of the month; a day range would report a
  // thirtieth.
  it("asks the ledger for the whole month, once per line", async () => {
    const { service, listActivityForTarget } = setup({
      report: { ...REPORT, grain: MONTH, businessDate: "2026-09-01" },
    });

    await service.getActivity(MONTH, 11);

    expect(listActivityForTarget).toHaveBeenCalledTimes(2);
    expect(listActivityForTarget).toHaveBeenCalledWith({
      workCenterId: 2,
      dateFrom: "2026-09-01",
      dateTo: "2026-10-01",
      shift: null,
      productId: null,
    });
  });

  // THE WATERMARKS STILL NAME THE SOURCE TABLES, not the area month one. The SKU
  // View's rows come from the DAY product-count table at both grains (a count sums,
  // so widening is exact), and the Input/Output buckets from the LINE day reports —
  // so quoting `area_month_reports` here would vouch for a freshness neither card's
  // own source has.
  it.each([
    ["products", (s: AreaReportService) => s.getProductCounts(MONTH, 11), "product_count_wc_day"],
    [
      "production-units",
      (s: AreaReportService) => s.getProductionUnits(MONTH, 11),
      "work_center_day_reports",
    ],
  ] as const)("reads the source table's watermark for /%s", async (_label, call, table) => {
    const handles = setup({ report: { ...REPORT, grain: MONTH } });

    await call(handles.service);

    expect(handles.watermarkTables).toEqual([table]);
  });
});
