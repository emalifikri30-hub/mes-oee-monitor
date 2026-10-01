import { describe, it, expect, vi } from "vite-plus/test";
import { HTTPException } from "hono/http-exception";

import { WorkUnitReportService } from "./work-unit-service.js";
import { MasterDataError, upstreamUnavailable } from "../master-data/master-data-error.js";

import type { Logger } from "@molca/utils";
import type { MasterDataClientContract } from "@molca/contract-client";
import type { MasterDataServiceContract } from "../master-data/master-data-service.js";
import type { WorkUnitReportReader } from "./work-unit-repository.js";
import type { TimeZoneResolverContract } from "../master-data/time-zone-resolver.js";
import type { WorkUnitShiftReportList } from "./work-unit.js";
import type { WorkUnitReportWriter } from "./work-unit-repository.js";
import type { OperatorRoles } from "../../shared/config/config.js";

// The plant this service was built for: UTC+7, no DST.
const JAKARTA = "Asia/Jakarta";

function row(id: number, workUnitId: number): WorkUnitShiftReportList {
  return {
    id,
    shift: 1,
    date: new Date("2026-08-09T00:00:00.000Z"),
    workUnitId,
    oee: 80,
    availability: 90,
    performance: 95,
    quality: 93,
    // Every report is open until somebody approves it — the absence of a row in
    // oee.work_unit_shift_report_approvals IS "open" (migration 0010).
    status: "open",
  };
}

const unit = (id: number, workCenter: { id: number; code: string; name: string } | null) => ({
  id,
  code: `WU-${id}`,
  name: `Unit ${id}`,
  workCenter,
});

const LINE_3 = { id: 12, code: "WC-03", name: "Line 3" };

function fakeLogger() {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = {
    withMetadata: vi.fn(() => ({ warn, error })),
  } as unknown as Logger;
  return { logger, warn };
}

// `satisfies Record<keyof T, ...>` keeps these fakes exhaustive: adding a method
// to either interface breaks compilation here instead of silently going untested.
function setup(
  overrides: {
    rows?: WorkUnitShiftReportList[];
    totalElements?: number;
    masterData?: Partial<MasterDataClientContract>;
    // TODOS.md §34's gate. Absent means all three unset, which is every
    // deployment today and what the rest of this suite asserts against.
    operatorRoles?: OperatorRoles;
  } = {},
) {
  const paginateShiftReport = vi.fn().mockResolvedValue({
    items: overrides.rows ?? [],
    totalElements: overrides.totalElements ?? overrides.rows?.length ?? 0,
  });
  const getShiftReport = vi.fn().mockResolvedValue(undefined);
  const getReportScope = vi.fn().mockResolvedValue(undefined);
  const listProductCount = vi.fn().mockResolvedValue([]);
  const resolveBusinessDate = vi.fn().mockResolvedValue("2026-08-01");
  const listPerfHours = vi.fn().mockResolvedValue([]);
  const getPerfWatermark = vi.fn().mockResolvedValue(null);
  const aggregateRejectReasons = vi.fn().mockResolvedValue({
    buckets: [],
    totalFrequency: 0,
    totalDurationMs: 0,
    totalQuantity: 0,
    totalWeightGram: null,
    convertedUnit: null,
  });
  const getRejectWatermark = vi.fn().mockResolvedValue(null);
  const aggregateDowntimeEventReasons = vi.fn().mockResolvedValue({
    buckets: [],
    totalOccurrences: 0,
    totalEvents: 0,
  });
  const getDowntimeEventWatermark = vi.fn().mockResolvedValue(null);
  // Empty by default: no report has been approved, so every page row falls back
  // to "open" through attachApprovalStatus's coalesce.
  const listApprovalsForPage = vi.fn().mockResolvedValue([]);
  const listApprovalTransitions = vi.fn().mockResolvedValue([]);
  // The honest default for today's data: stops exist, none of them carries a
  // source_event_id, so nothing about them could ever have been recorded.
  const listShiftDowntimeHistory = vi
    .fn()
    .mockResolvedValue({ entries: [], totalMembers: 3, trackedMembers: 0 });
  const getShiftWindow = vi.fn().mockResolvedValue({
    from: new Date("2026-08-09T00:00:00.000Z"),
    to: new Date("2026-08-09T08:00:00.000Z"),
  });

  // The daily OEE curve behind the OEE Performance dashboard. Two points rather
  // than one so ordering is observable, and the second is 0 — a measurement the
  // service must pass through untouched, because dropping it here is the failure
  // the browser's gap rule exists to render honestly rather than to hide.
  const listMonthOeeTrend = vi.fn().mockResolvedValue([
    { businessDate: "2026-08-01", oee: 88.003 },
    { businessDate: "2026-08-02", oee: 0 },
  ]);
  const getDayReportWatermark = vi.fn().mockResolvedValue("2026-08-31");

  // The YEAR curve's twelve points, and its own watermark. DISTINCT VALUES from the
  // month pair above, deliberately: the two feeds read different tables, and a
  // shared fixture would let the year trend serve the month one's rows without a
  // single assertion noticing.
  const listYearOeeTrend = vi.fn().mockResolvedValue([
    { businessDate: "2026-01-01", oee: 74.5 },
    { businessDate: "2026-02-01", oee: 0 },
  ]);
  const getMonthReportWatermark = vi.fn().mockResolvedValue("2026-12-01");

  // Null is the state EVERY report is in today: nothing writes
  // oee.downtime_report_history yet, so no category has ever been edited.
  // Ahead of the report's business day, so an empty product list reads as a
  // genuinely idle machine rather than as "not loaded" — the default most tests
  // want, since they assert on rows rather than on the stale/loaded split.
  const getProductCountWatermark = vi.fn().mockResolvedValue("2026-08-31");

  const getCategoryEditedAt = vi.fn().mockResolvedValue(null);
  // Read by the downtime module's freeze through a port, not by this service —
  // the exhaustiveness check below is what requires it here.
  const listApprovalsOverlapping = vi.fn().mockResolvedValue([]);

  // The coarse grains. Defaulted to empty/absent so the shift-grain tests below
  // are unaffected; the day and month suites override what they need.
  const paginatePeriodReport = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
  const getPeriodReport = vi.fn().mockResolvedValue(undefined);
  const getPeriodReportScope = vi.fn().mockResolvedValue(undefined);
  const listPeriodProductCount = vi.fn().mockResolvedValue([]);
  const listPerfHourProfile = vi.fn().mockResolvedValue([]);
  const listApprovalTransitionsInWindow = vi.fn().mockResolvedValue([]);
  const aggregatePeriodRejectReasons = vi.fn().mockResolvedValue({
    buckets: [],
    totalFrequency: 0,
    totalDurationMs: 0,
    totalQuantity: 0,
    totalWeightGram: null,
    convertedUnit: null,
  });
  const aggregatePeriodDowntimeEventReasons = vi
    .fn()
    .mockResolvedValue({ buckets: [], totalOccurrences: 0, totalEvents: 0 });
  const getPeriodWindow = vi.fn().mockResolvedValue({
    from: new Date("2026-08-01T00:00:00Z"),
    to: new Date("2026-08-02T00:00:00Z"),
  });
  const summariseApprovalsInWindow = vi.fn().mockResolvedValue({ shiftsTotal: 0, shiftsClosed: 0 });

  const repoFns = {
    paginatePeriodReport,
    getPeriodReport,
    getPeriodReportScope,
    getPeriodWindow,
    listPeriodProductCount,
    listPerfHourProfile,
    listApprovalTransitionsInWindow,
    aggregatePeriodRejectReasons,
    aggregatePeriodDowntimeEventReasons,
    summariseApprovalsInWindow,
    paginateShiftReport,
    getShiftReport,
    getReportScope,
    listProductCount,
    resolveBusinessDate,
    listPerfHours,
    getPerfWatermark,
    aggregateRejectReasons,
    getRejectWatermark,
    getProductCountWatermark,
    aggregateDowntimeEventReasons,
    getDowntimeEventWatermark,
    listApprovalsForPage,
    listApprovalTransitions,
    listShiftDowntimeHistory,
    getCategoryEditedAt,
    listApprovalsOverlapping,
    getShiftWindow,
    listMonthOeeTrend,
    listYearOeeTrend,
    getDayReportWatermark,
    getMonthReportWatermark,
  } satisfies Record<keyof WorkUnitReportReader, ReturnType<typeof vi.fn>>;

  // The plant zone is what turns the report's shift-start instant into the business
  // day the product rows are keyed by, so it is on the happy path of two methods now.
  const timeZoneResolver = {
    resolve: vi.fn().mockResolvedValue(JAKARTA),
  } satisfies Record<keyof TimeZoneResolverContract, ReturnType<typeof vi.fn>>;

  const mdFns = {
    existsWorkCenter: vi.fn().mockResolvedValue(true),
    findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([]),
    findAllWorkUnitByWorkUnitIds: vi.fn().mockResolvedValue({ found: [], missingIds: [] }),
    findAllArea: vi.fn().mockResolvedValue([]),
    findAllWorkCenterByAreaId: vi.fn().mockResolvedValue([]),
    // The downtime catalogue is the edit dialog's, not this report's. Present
    // for the same exhaustiveness check as findTimeZoneByScope below.
    findAllDowntimeReasonByWorkCenterId: vi.fn().mockResolvedValue([]),
    findAllDowntimeAction: vi.fn().mockResolvedValue([]),
    createDowntimeAction: vi.fn(),
    // The work-unit report never resolves a time zone — only the downtime
    // timeline does — but the exhaustiveness check below requires it.
    findTimeZoneByScope: vi.fn(),
    // Part 3's three, unused here. Present because the `satisfies` below is
    // exhaustive over the port — which is the point of it: a method added to the
    // contract fails every fake until somebody decides what it should return.
    findAllRejectReasonByWorkCenterId: vi.fn(),
    findAllProductByWorkCenterId: vi.fn(),
    findProductById: vi.fn(),
  } satisfies Record<keyof MasterDataClientContract, ReturnType<typeof vi.fn>>;

  const masterData = { ...mdFns, ...overrides.masterData } as MasterDataClientContract &
    typeof mdFns;

  // A MasterDataService fake that DELEGATES to the client fake above, and wraps a
  // failure the way the real one does.
  //
  // `resolveWorkUnitIds` reads the work-center filter's id list through the SERVICE
  // now, because that path is cached (TODOS §58). Delegating rather than stubbing
  // separately is what keeps every existing assertion in this file — including the
  // two 502 cases — meaning exactly what it meant: the service really does end up
  // calling `findAllWorkUnitByWorkCenterId`, just through a cache.
  const masterDataService = {
    listWorkUnitIds: vi.fn(async (workCenterId: number, operation: string) => {
      try {
        return await masterData.findAllWorkUnitByWorkCenterId(workCenterId);
      } catch (err) {
        throw upstreamUnavailable(err, operation);
      }
    }),
  } as unknown as MasterDataServiceContract;
  const { logger, warn } = fakeLogger();

  const qualityRepoFns = {
    listActivityForMachine: vi.fn().mockResolvedValue([]),
    listActivityForMachineTarget: vi.fn().mockResolvedValue([]),
  };

  const closeShiftReport = vi.fn().mockResolvedValue({
    kind: "closed",
    approval: {
      status: "closed",
      closedAt: new Date("2026-08-09T09:00:00.000Z"),
      closedBy: "u1",
      closedByName: "dewi",
      source: "operator",
    },
  });

  const reopenShiftReport = vi.fn().mockResolvedValue({
    kind: "reopened",
    approval: {
      status: "open",
      // All four cleared, which ck_wusra_open requires of an open row — so a
      // stub that left the approver populated would be asserting a state the
      // database would reject.
      closedAt: null,
      closedBy: null,
      closedByName: null,
      source: null,
    },
  });

  const writerFns = { closeShiftReport, reopenShiftReport } satisfies Record<
    keyof WorkUnitReportWriter,
    ReturnType<typeof vi.fn>
  >;

  const service = new WorkUnitReportService({
    workUnitReportReaderRepository: repoFns as unknown as WorkUnitReportReader,
    workUnitReportWriterRepository: writerFns as unknown as WorkUnitReportWriter,
    // Part 3's third feed arm — BOTH READS, because the shift feed and the coarse
    // one call different methods and a swap between them is silent: the
    // shift-keyed read handed a day's window returns one shift's entries under a
    // day's heading, and the range read handed a shift's returns three shifts'.
    // Empty by default — this suite is mostly about the other two arms, and rows
    // here would show up in every assertion below.
    qualityEntryRepository: {
      listActivityForMachine: qualityRepoFns.listActivityForMachine,
      listActivityForMachineTarget: qualityRepoFns.listActivityForMachineTarget,
    } as unknown as ConstructorParameters<
      typeof WorkUnitReportService
    >[0]["qualityEntryRepository"],
    masterDataClient: masterData,
    masterDataService,
    timeZoneResolver,
    // Ungated by default, which is what the rest of this suite asserts against.
    // The gate's own describe block passes roles in.
    operatorRoles: overrides.operatorRoles ?? {},
    logger,
  });

  return {
    service,
    repo: repoFns,
    writer: writerFns,
    quality: qualityRepoFns,
    masterData,
    masterDataService,
    timeZoneResolver,
    warn,
  };
}

function filterPassedToRepo(repo: { paginateShiftReport: ReturnType<typeof vi.fn> }) {
  return repo.paginateShiftReport.mock.calls[0]?.[0]?.filter;
}

async function statusOf(run: () => Promise<unknown>) {
  const err = await run().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HTTPException);
  return err as HTTPException;
}

describe("getPagedShiftReport — work center filter (stage 1)", () => {
  it("skips master-data entirely when no workCenterId is given", async () => {
    const { service, masterData } = setup({ rows: [] });

    await service.getPagedShiftReport(1, 10, {});

    expect(masterData.findAllWorkUnitByWorkCenterId).not.toHaveBeenCalled();
    expect(masterData.existsWorkCenter).not.toHaveBeenCalled();
  });

  it("resolves workCenterId into workUnitIds for the repository", async () => {
    const { service, repo } = setup({
      rows: [],
      masterData: {
        findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([{ id: 4 }, { id: 5 }]),
      },
    });

    await service.getPagedShiftReport(1, 10, { workCenterId: 12 });

    expect(filterPassedToRepo(repo)).toMatchObject({ workUnitIds: [4, 5] });
  });

  it("does not leak workCenterId into the repository filter", async () => {
    const { service, repo } = setup({
      rows: [],
      masterData: {
        findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([{ id: 4 }]),
      },
    });

    await service.getPagedShiftReport(1, 10, { workCenterId: 12, shift: 1 });

    const filter = filterPassedToRepo(repo);
    expect(filter).not.toHaveProperty("workCenterId");
    expect(filter).toMatchObject({ shift: 1 });
  });

  // An existing work center with no units is a valid empty report. It must NOT
  // reach the repository with `workUnitIds: []`, which would be read as "no
  // filter" and return every work unit's rows.
  it("returns an empty page without querying when the work center exists but has no units", async () => {
    const { service, repo, masterData } = setup({
      masterData: {
        findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([]),
        existsWorkCenter: vi.fn().mockResolvedValue(true),
      },
    });

    const result = await service.getPagedShiftReport(1, 10, { workCenterId: 12 });

    expect(result.items).toEqual([]);
    expect(result.meta.totalElements).toBe(0);
    expect(repo.paginateShiftReport).not.toHaveBeenCalled();
    expect(masterData.existsWorkCenter).toHaveBeenCalledWith(12);
  });

  it("404s when the work center does not exist", async () => {
    const { service } = setup({
      masterData: {
        findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([]),
        existsWorkCenter: vi.fn().mockResolvedValue(false),
      },
    });

    const err = await statusOf(() => service.getPagedShiftReport(1, 10, { workCenterId: 999 }));

    expect(err.status).toBe(404);
    expect(err.message).toBe("work center not found");
  });

  // FATAL by design: returning unfiltered rows would be silently wrong data.
  it("502s when the id lookup fails, rather than returning unfiltered rows", async () => {
    const { service, repo } = setup({
      masterData: {
        findAllWorkUnitByWorkCenterId: vi.fn().mockRejectedValue(
          new MasterDataError({
            cause: "network_error",
            operation: "findAllWorkUnitByWorkCenterId",
            message: "ECONNREFUSED",
          }),
        ),
      },
    });

    const err = await statusOf(() => service.getPagedShiftReport(1, 10, { workCenterId: 12 }));

    expect(err.status).toBe(502);
    expect(err.message).toContain("network_error");
    expect(repo.paginateShiftReport).not.toHaveBeenCalled();
  });

  it("502s when the work-center existence check fails", async () => {
    const { service } = setup({
      masterData: {
        findAllWorkUnitByWorkCenterId: vi.fn().mockResolvedValue([]),
        existsWorkCenter: vi.fn().mockRejectedValue(
          new MasterDataError({
            cause: "timeout",
            operation: "existsWorkCenter",
            message: "timed out",
          }),
        ),
      },
    });

    const err = await statusOf(() => service.getPagedShiftReport(1, 10, { workCenterId: 12 }));

    expect(err.status).toBe(502);
    expect(err.message).toContain("timeout");
  });
});

describe("getPagedShiftReport — enrichment (stage 3)", () => {
  it("attaches the work unit and its work center to each row", async () => {
    const { service } = setup({
      rows: [row(1, 44), row(2, 45)],
      totalElements: 2,
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi.fn().mockResolvedValue({
          found: [unit(44, LINE_3), unit(45, LINE_3)],
          missingIds: [],
        }),
      },
    });

    const { items } = await service.getPagedShiftReport(1, 10, {});

    expect(items[0]).toMatchObject({
      id: 1,
      oee: 80,
      workUnit: { id: 44, code: "WU-44", name: "Unit 44" },
      workCenter: LINE_3,
    });
  });

  it("drops workUnitId from the enriched row", async () => {
    const { service } = setup({
      rows: [row(1, 44)],
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi
          .fn()
          .mockResolvedValue({ found: [unit(44, LINE_3)], missingIds: [] }),
      },
    });

    const { items } = await service.getPagedShiftReport(1, 10, {});

    expect(items[0]).not.toHaveProperty("workUnitId");
  });

  it("requests each distinct work unit only once", async () => {
    const { service, masterData } = setup({
      rows: [row(1, 44), row(2, 44), row(3, 45)],
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi.fn().mockResolvedValue({ found: [], missingIds: [] }),
      },
    });

    await service.getPagedShiftReport(1, 10, {});

    expect(masterData.findAllWorkUnitByWorkUnitIds).toHaveBeenCalledWith([44, 45]);
  });

  it("makes no enrichment call when the page is empty", async () => {
    const { service, masterData } = setup({ rows: [] });

    await service.getPagedShiftReport(1, 10, {});

    expect(masterData.findAllWorkUnitByWorkUnitIds).not.toHaveBeenCalled();
  });

  it("nulls both labels for a row whose work unit is missing upstream", async () => {
    const { service } = setup({
      rows: [row(1, 44), row(2, 99)],
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi
          .fn()
          .mockResolvedValue({ found: [unit(44, LINE_3)], missingIds: [99] }),
      },
    });

    const { items } = await service.getPagedShiftReport(1, 10, {});

    expect(items[1]).toMatchObject({ id: 2, workUnit: null, workCenter: null });
  });

  it("keeps the work unit but nulls the work center when the unit has none", async () => {
    const { service } = setup({
      rows: [row(1, 46)],
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi
          .fn()
          .mockResolvedValue({ found: [unit(46, null)], missingIds: [] }),
      },
    });

    const { items } = await service.getPagedShiftReport(1, 10, {});

    expect(items[0]).toMatchObject({
      workUnit: { id: 46, code: "WU-46", name: "Unit 46" },
      workCenter: null,
    });
  });

  // THE SILENT PATH. This returns HTTP 200, so the WARN log and the Prometheus
  // counter are the only evidence that every label on the page is missing.
  it("degrades to null labels and still returns 200 when enrichment fails", async () => {
    const { service, warn } = setup({
      rows: [row(1, 44), row(2, 45)],
      totalElements: 2,
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi.fn().mockRejectedValue(
          new MasterDataError({
            cause: "network_error",
            operation: "findAllWorkUnitByWorkUnitIds",
            message: "ECONNREFUSED",
          }),
        ),
      },
    });

    const { items, meta } = await service.getPagedShiftReport(1, 10, {});

    // The metrics survive — which is the entire point of degrading here.
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 1, oee: 80, workUnit: null, workCenter: null });
    expect(items[1]).toMatchObject({ id: 2, workUnit: null, workCenter: null });
    expect(meta.totalElements).toBe(2);
    // Without this the degradation is invisible.
    expect(warn).toHaveBeenCalledWith("work_unit_enrichment_degraded");
  });

  it("degrades on a non-MasterDataError too", async () => {
    const { service, warn } = setup({
      rows: [row(1, 44)],
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi.fn().mockRejectedValue(new TypeError("boom")),
      },
    });

    const { items } = await service.getPagedShiftReport(1, 10, {});

    expect(items[0]).toMatchObject({ workUnit: null, workCenter: null });
    expect(warn).toHaveBeenCalledWith("work_unit_enrichment_degraded");
  });

  it("does not warn on the happy path", async () => {
    const { service, warn } = setup({
      rows: [row(1, 44)],
      masterData: {
        findAllWorkUnitByWorkUnitIds: vi
          .fn()
          .mockResolvedValue({ found: [unit(44, LINE_3)], missingIds: [] }),
      },
    });

    await service.getPagedShiftReport(1, 10, {});

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("getPagedShiftReport — paging", () => {
  it("translates page/size into limit and offset", async () => {
    const { service, repo } = setup({ rows: [] });

    await service.getPagedShiftReport(3, 25, {});

    expect(repo.paginateShiftReport).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, offset: 50 }),
    );
  });

  it("builds page meta from the repository total", async () => {
    const { service } = setup({ rows: [row(1, 44)], totalElements: 42 });

    const { meta } = await service.getPagedShiftReport(2, 10, {});

    expect(meta).toMatchObject({ page: 2, size: 10, totalElements: 42, totalPages: 5 });
  });

  it("passes the period and shift filters straight through", async () => {
    const { service, repo } = setup({ rows: [] });

    await service.getPagedShiftReport(1, 10, {
      month: 3,
      year: 2026,
      shift: 2,
      isHideZero: true,
    });

    expect(filterPassedToRepo(repo)).toMatchObject({
      month: 3,
      year: 2026,
      shift: 2,
      isHideZero: true,
    });
  });
});

describe("getShiftReport", () => {
  it("returns the report when it exists", async () => {
    const { service, repo } = setup();
    const report = { id: 7, shift: 3, workUnitId: 3 };
    repo.getShiftReport.mockResolvedValue(report);

    await expect(service.getShiftReport(7)).resolves.toMatchObject(report);
  });

  // Stamped on, not selected — the zone is resolved per work unit through the
  // master-data hierarchy. It has to be on this response because `date` is the
  // shift's start instant: without a zone the browser cannot work out which
  // business day to request a timeline for, and the timeline is the only other
  // place the zone appears.
  it("stamps the resolved plant zone onto the report", async () => {
    const { service, repo, timeZoneResolver } = setup();
    repo.getShiftReport.mockResolvedValue({ id: 7, shift: 3, workUnitId: 3 });

    const out = await service.getShiftReport(7);

    expect(out.timeZone).toBe(JAKARTA);
    expect(timeZoneResolver.resolve).toHaveBeenCalledWith("work-unit", 3);
  });

  it("404s when the report does not exist", async () => {
    const { service } = setup();

    const err = await statusOf(() => service.getShiftReport(404));

    expect(err.status).toBe(404);
    expect(err.message).toBe("report not found");
  });
});

// The repository answers with three distinguishable states, and this method has to
// treat them as three. Conflating the first two is what would make
// product_count_empty_total fire on every bad id and stop meaning anything.
//
// The counters themselves bind to a no-op meter under test, so — following the
// enrichment-degraded tests above — the assertion is on the warn log that travels
// with them.
describe("getProductCounts", () => {
  const item = {
    productId: 4,
    productName: "SKU Line 4",
    productCode: "SKU-4",
    totalOut: 854_648,
    goodOut: 786_552,
    reject: 68_096,
    rework: 0,
    uomCode: "BAG",
    baseUomCode: "BAG",
  };

  // Sets up the found-report path: scope resolves, so the zone and product reads run.
  function found(rows: unknown[]) {
    const ctx = setup();
    ctx.repo.getReportScope.mockResolvedValue({ workUnitId: 3 });
    ctx.repo.listProductCount.mockResolvedValue(rows);
    return ctx;
  }

  it("returns the rows for a report that ran product, wrapped with its watermark", async () => {
    const { service } = found([item]);

    // AN OBJECT, not a bare array. TODOS.md §14: an empty array cannot say WHY it
    // is empty, and the two reasons — an idle machine, or a business day the
    // pipeline has not reached — are opposite claims.
    await expect(service.getProductCounts(7)).resolves.toEqual({
      items: [item],
      timeZone: JAKARTA,
      loadedThrough: "2026-08-31",
    });
  });

  // The ordering is forced and worth pinning: the product rows are keyed by business
  // day while the report stores a shift-start instant, so the zone has to be resolved
  // — which needs the work unit — before the product query can be built at all.
  it("resolves the work unit's zone and hands it to the query", async () => {
    const { service, repo, timeZoneResolver } = found([item]);

    await service.getProductCounts(7);

    expect(repo.getReportScope).toHaveBeenCalledWith(7);
    expect(timeZoneResolver.resolve).toHaveBeenCalledWith("work-unit", 3);
    expect(repo.listProductCount).toHaveBeenCalledWith(7, JAKARTA);
  });

  it("does not warn on the happy path", async () => {
    const { service, warn } = found([item]);

    await service.getProductCounts(7);

    expect(warn).not.toHaveBeenCalled();
  });

  // The dangerous answer: 200 with an empty list rendered the same message a
  // genuinely idle machine earns. The log used to be the ONLY signal the ETL was
  // behind — `loadedThrough` is now on the wire, so the browser can tell the two
  // apart instead of a human noticing a warning. The log stays: it is what says so
  // without anybody opening the page.
  it("warns when the report exists but ran no SKUs, and reports the watermark anyway", async () => {
    const { service, warn } = found([]);

    await expect(service.getProductCounts(7)).resolves.toEqual({
      items: [],
      timeZone: JAKARTA,
      loadedThrough: "2026-08-31",
    });
    expect(warn).toHaveBeenCalledWith("product_count_empty");
  });

  // THE SPLIT THE WHOLE CHANGE EXISTS FOR, from the other side: the same empty
  // list, but the pipeline has NOT reached this report's day. Identical payload
  // shape, opposite meaning — and the only thing carrying the difference is this
  // field.
  it("reports a watermark behind the report's day for the same empty list", async () => {
    const { service, repo } = found([]);
    repo.getProductCountWatermark.mockResolvedValue("2026-07-01");

    await expect(service.getProductCounts(7)).resolves.toMatchObject({
      items: [],
      loadedThrough: "2026-07-01",
    });
  });

  // A missing watermark row means the table has NEVER been loaded, which is a
  // third state again — and it must not be coerced into a date that would read as
  // "loaded through the epoch".
  it("reports null when the product-count table has never been loaded", async () => {
    const { service, repo } = found([]);
    repo.getProductCountWatermark.mockResolvedValue(null);

    await expect(service.getProductCounts(7)).resolves.toMatchObject({ loadedThrough: null });
  });

  it("404s when the report does not exist", async () => {
    const { service } = setup();

    const err = await statusOf(() => service.getProductCounts(404));

    expect(err.status).toBe(404);
    expect(err.message).toBe("report not found");
  });

  // A bad id is a bad request, not a data gap. Counting it would drown the signal
  // the empty-list case exists to raise.
  it("does not warn, or query, for an unknown report", async () => {
    const { service, repo, warn, timeZoneResolver } = setup();

    await service.getProductCounts(404).catch(() => undefined);

    expect(warn).not.toHaveBeenCalledWith("product_count_empty");
    expect(timeZoneResolver.resolve).not.toHaveBeenCalled();
    expect(repo.listProductCount).not.toHaveBeenCalled();
  });
});

describe("getMonthOeeTrend", () => {
  const POINTS = [
    { businessDate: "2026-08-01", oee: 88.003 },
    { businessDate: "2026-08-02", oee: 0 },
  ];

  it("returns the curve with the report's zone and the DAY table's watermark", async () => {
    const { service, repo } = setup();
    repo.getPeriodReportScope.mockResolvedValue({
      workUnitId: 3,
      workCenterId: 2,
      businessDate: "2026-08-01",
      timeZone: JAKARTA,
    });

    await expect(service.getMonthOeeTrend(7)).resolves.toEqual({
      items: POINTS,
      timeZone: JAKARTA,
      loadedThrough: "2026-08-31",
    });
    expect(repo.listMonthOeeTrend).toHaveBeenCalledWith(7);
  });

  // THE WATERMARK IS THE DAY TABLE'S, not the product count's or the month
  // report's. An empty curve and an unloaded one draw the same flat nothing, and
  // quoting another table's freshness here would vouch for a load this chart's own
  // source has not had.
  it("reads oee.work_unit_day_reports' own watermark", async () => {
    const { service, repo } = setup();
    repo.getPeriodReportScope.mockResolvedValue({ timeZone: JAKARTA });

    await service.getMonthOeeTrend(7);

    expect(repo.getDayReportWatermark).toHaveBeenCalled();
    expect(repo.getProductCountWatermark).not.toHaveBeenCalled();
  });

  // A zero day is a MEASUREMENT — the machine ran and produced nothing. The
  // browser draws it as a gap because a 0% point would drag the curve to the axis
  // and read as a collapse; the payload must still carry the zero, because only
  // the browser knows it is drawing a chart.
  it("passes a zero day through rather than dropping it", async () => {
    const { service, repo } = setup();
    repo.getPeriodReportScope.mockResolvedValue({ timeZone: JAKARTA });

    const { items } = await service.getMonthOeeTrend(7);

    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ businessDate: "2026-08-02", oee: 0 });
  });

  // The sibling endpoints 404 an unknown id, so this one must not answer 200 with
  // an empty curve — which would read as "this machine had a quiet month".
  it("404s an unknown report rather than answering an empty curve", async () => {
    const { service, repo } = setup();
    repo.getPeriodReportScope.mockResolvedValue(undefined);

    await expect(service.getMonthOeeTrend(404)).rejects.toMatchObject({ status: 404 });
    expect(repo.listMonthOeeTrend).not.toHaveBeenCalled();
  });

  // A row whose time_zone was never written still has to produce a usable payload:
  // the browser labels the axis with it. Same fallback every sibling feed uses.
  it("falls back to UTC when the row carries no zone", async () => {
    const { service, repo } = setup();
    repo.getPeriodReportScope.mockResolvedValue({ timeZone: null });

    await expect(service.getMonthOeeTrend(7)).resolves.toMatchObject({ timeZone: "UTC" });
  });
});

describe("getPerformance", () => {
  // Shift 3 of business day 2026-08-01 at UTC+7: 23:00 local is 16:00Z the same
  // day. The shift that crosses midnight, and the one a naive business-day
  // conversion gets wrong.
  const SHIFT_3_START = new Date("2026-08-01T16:00:00Z");

  const bucket = {
    bucketStart: SHIFT_3_START,
    bucketEnd: new Date("2026-08-01T17:00:00Z"),
    hourOfDay: 23,
    shiftHourSeq: 0,
    productId: 4,
    productName: "SKU Line 4",
    productCode: "SKU-4",
    uomCode: "BAG",
    totalOut: 34_304,
    effectiveOut: 34_140,
    runtime: 2_845_000,
    idealRatePerHour: 43_200,
  };

  // Sets up the found-report path: scope resolves, so the zone, business-day and
  // bucket reads all run.
  function found(rows: unknown[], watermark: string | null = "2026-08-02") {
    const ctx = setup();
    ctx.repo.getReportScope.mockResolvedValue({ workUnitId: 3, shift: 3, date: SHIFT_3_START });
    ctx.repo.listPerfHours.mockResolvedValue(rows);
    ctx.repo.getPerfWatermark.mockResolvedValue(watermark);
    return ctx;
  }

  it("returns the buckets, the zone and the watermark", async () => {
    const { service } = found([bucket]);

    await expect(service.getPerformance(7)).resolves.toEqual({
      timeZone: JAKARTA,
      buckets: [bucket],
      loadedThrough: "2026-08-02",
    });
  });

  // The ordering is forced, and it is one step longer than getProductCounts: the
  // hourly rows are keyed by a real `business_date`, the report stores a shift-start
  // instant, and reducing one to the other needs the zone — which needs the work
  // unit — which lives on the report.
  it("resolves the zone, then the business day, then queries that day and shift", async () => {
    const { service, repo, timeZoneResolver } = found([bucket]);

    await service.getPerformance(7);

    expect(repo.getReportScope).toHaveBeenCalledWith(7);
    expect(timeZoneResolver.resolve).toHaveBeenCalledWith("work-unit", 3);
    expect(repo.resolveBusinessDate).toHaveBeenCalledWith(SHIFT_3_START, JAKARTA);
    expect(repo.listPerfHours).toHaveBeenCalledWith({
      workUnitId: 3,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
      shift: 3,
    });
  });

  // dateFrom === dateTo and a shift is what makes this the SHIFT grain. The day and
  // month grains widen the range and drop the shift over the same method; see
  // TODOS.md §23.
  it("asks for exactly one business day, narrowed to the report's shift", async () => {
    const { service, repo } = found([bucket]);

    await service.getPerformance(7);

    const input = repo.listPerfHours.mock.calls[0]?.[0] as { dateFrom: string; dateTo: string };
    expect(input.dateFrom).toBe(input.dateTo);
  });

  it("does not warn on the happy path", async () => {
    const { service, warn } = found([bucket]);

    await service.getPerformance(7);

    expect(warn).not.toHaveBeenCalled();
  });

  // The dangerous answer, and the reason `loadedThrough` is on the response: an
  // empty list alone renders identically to a machine that idled all shift.
  it("warns when the report exists but has no hourly rows", async () => {
    const { service, warn } = found([]);

    await expect(service.getPerformance(7)).resolves.toMatchObject({ buckets: [] });
    expect(warn).toHaveBeenCalledWith("perf_hour_empty");
  });

  // Empty is not an error. The browser needs the watermark to explain WHY, so the
  // 200 has to carry it rather than the service turning the case into a failure.
  it("still returns the watermark when there are no buckets", async () => {
    const { service } = found([], null);

    await expect(service.getPerformance(7)).resolves.toEqual({
      timeZone: JAKARTA,
      buckets: [],
      loadedThrough: null,
    });
  });

  // The two reads share no inputs, and the watermark matters most exactly when the
  // bucket query returns nothing — so making it wait would add a round trip to the
  // slowest path.
  it("reads the buckets and the watermark concurrently", async () => {
    const { service, repo } = found([bucket]);
    let bucketsSettled = false;

    repo.listPerfHours.mockImplementation(async () => {
      await Promise.resolve();
      bucketsSettled = true;
      return [bucket];
    });
    repo.getPerfWatermark.mockImplementation(() => {
      // Started before the bucket query finished, which a sequential await could
      // not produce.
      expect(bucketsSettled).toBe(false);
      return Promise.resolve("2026-08-02");
    });

    await service.getPerformance(7);

    expect(repo.getPerfWatermark).toHaveBeenCalled();
  });

  it("404s when the report does not exist", async () => {
    const { service } = setup();

    const err = await statusOf(() => service.getPerformance(404));

    expect(err.status).toBe(404);
    expect(err.message).toBe("report not found");
  });

  // Same rule as the SKU card: a bad id is a bad request, not a data gap.
  it("does not warn, or query, for an unknown report", async () => {
    const { service, repo, warn, timeZoneResolver } = setup();

    await service.getPerformance(404).catch(() => undefined);

    expect(warn).not.toHaveBeenCalledWith("perf_hour_empty");
    expect(timeZoneResolver.resolve).not.toHaveBeenCalled();
    expect(repo.resolveBusinessDate).not.toHaveBeenCalled();
    expect(repo.listPerfHours).not.toHaveBeenCalled();
    expect(repo.getPerfWatermark).not.toHaveBeenCalled();
  });
});

// The Quality Loss Pareto's payload. Structurally getPerformance minus the
// business-day step — the join does that conversion in SQL — so the assertions
// here are about the ORDER of the two calls that remain and about the three
// states an empty result can mean.
//
// The counters bind to a no-op meter under test, so as elsewhere in this file the
// assertion is on the warn log that travels with them.
describe("getRejectReasons", () => {
  const SHIFT_3_START = new Date("2026-08-01T16:00:00Z");

  const bucket = {
    reason: "NG_Over_Count",
    reasonCode: null,
    machineName: "Vertical Packer N",
    counterValue: 48,
    counterUnit: "CALENDER",
    quantity: 576,
    convertedUnit: "BAG",
    weightGram: 15_232,
    frequency: 48,
    durationMs: 96_000,
  };

  const aggregate = {
    buckets: [bucket],
    totalFrequency: 48,
    totalDurationMs: 96_000,
    totalQuantity: 576,
    totalWeightGram: 15_232,
    convertedUnit: "BAG",
  };

  function found(agg: unknown = aggregate, watermark: string | null = "2026-08-01") {
    const ctx = setup();
    ctx.repo.getReportScope.mockResolvedValue({ workUnitId: 3, shift: 3, date: SHIFT_3_START });
    ctx.repo.aggregateRejectReasons.mockResolvedValue(agg);
    ctx.repo.getRejectWatermark.mockResolvedValue(watermark);
    return ctx;
  }

  it("returns the buckets, every total, the zone and the watermark", async () => {
    const { service } = found();

    await expect(service.getRejectReasons(7)).resolves.toEqual({
      timeZone: JAKARTA,
      ...aggregate,
      loadedThrough: "2026-08-01",
    });
  });

  // The zone has to be resolved BEFORE the aggregate, because the join reduces
  // the report's shift-start instant to a business day through it. Getting the
  // order wrong would send `undefined` to Postgres as the zone.
  it("resolves the zone before aggregating, then passes it to the query", async () => {
    const { service, repo, timeZoneResolver } = found();

    await service.getRejectReasons(7);

    expect(repo.getReportScope).toHaveBeenCalledWith(7);
    expect(timeZoneResolver.resolve).toHaveBeenCalledWith("work-unit", 3);
    expect(repo.aggregateRejectReasons).toHaveBeenCalledWith(7, JAKARTA);
  });

  // Unlike getPerformance, there is no resolveBusinessDate round trip: the join
  // does the conversion in SQL, exactly as listProductCount does.
  it("does not resolve a business day of its own", async () => {
    const { service, repo } = found();

    await service.getRejectReasons(7);

    expect(repo.resolveBusinessDate).not.toHaveBeenCalled();
  });

  it("404s when the report does not exist", async () => {
    const { service, repo } = setup();
    repo.getReportScope.mockResolvedValue(undefined);

    const err = await statusOf(() => service.getRejectReasons(404));

    expect(err.status).toBe(404);
    expect(err.message).toBe("report not found");
  });

  // A BAD ID IS NOT A DATA GAP. Conflating the two is what would make
  // reject_reason_empty_total fire on every broken link and stop meaning
  // anything — the same rule product_count_empty_total follows above.
  it("does not report an empty breakdown for an unknown report", async () => {
    const { service, warn } = setup();

    await statusOf(() => service.getRejectReasons(404));

    expect(warn).not.toHaveBeenCalledWith("reject_reason_empty");
  });

  // THE NORMAL CASE UNTIL THE PIPELINE LANDS. oee.reject_count_wu_shift ships
  // empty, so this path is the one every shift takes today.
  it("reports a report that exists but has no reject rows", async () => {
    const empty = { ...aggregate, buckets: [], totalFrequency: 0, totalWeightGram: null };
    const { service, warn } = found(empty, null);

    const out = await service.getRejectReasons(7);

    expect(out.buckets).toEqual([]);
    expect(warn).toHaveBeenCalledWith("reject_reason_empty");
  });

  it("does not report an empty breakdown when counters came back", async () => {
    const { service, warn } = found();

    await service.getRejectReasons(7);

    expect(warn).not.toHaveBeenCalledWith("reject_reason_empty");
  });

  // A null watermark and a null weight total are BOTH meaningful absences and
  // neither may be substituted: the first means the pipeline has never run, the
  // second that nothing in the shift was weighed.
  it("passes a never-loaded watermark and an unweighed shift through untouched", async () => {
    const { service } = found({ ...aggregate, totalWeightGram: null }, null);

    const out = await service.getRejectReasons(7);

    expect(out.loadedThrough).toBeNull();
    expect(out.totalWeightGram).toBeNull();
  });
});

// The Others tab's payload. Structurally getRejectReasons — the same three steps
// and the same two-call concurrency — so the assertions here are about the ORDER
// of those calls, the three states an empty result can mean, and the one thing
// this method must NOT do: derive either total.
//
// The counters bind to a no-op meter under test, so as elsewhere in this file the
// assertion is on the warn log that travels with them.
describe("getDowntimeEventReasons", () => {
  const SHIFT_3_START = new Date("2026-08-01T16:00:00Z");

  // The worked example the whole feature is specified against: {A,B} and {B,X,Y}
  // give B a frequency of 2. Five occurrences across two stops, so the two totals
  // differ — which is the relation every assertion below runs against.
  const aggregate = {
    buckets: [
      { reason: "Material_Jam", frequency: 2 },
      { reason: "Machine_Stop", frequency: 1 },
      { reason: "Operator_Break", frequency: 1 },
      { reason: "Belt_Slip", frequency: 1 },
    ],
    totalOccurrences: 5,
    totalEvents: 2,
  };

  function found(agg: unknown = aggregate, watermark: string | null = "2026-08-01") {
    const ctx = setup();
    ctx.repo.getReportScope.mockResolvedValue({ workUnitId: 3, shift: 3, date: SHIFT_3_START });
    ctx.repo.aggregateDowntimeEventReasons.mockResolvedValue(agg);
    ctx.repo.getDowntimeEventWatermark.mockResolvedValue(watermark);
    return ctx;
  }

  it("returns the buckets, both totals, the zone and the watermark", async () => {
    const { service } = found();

    await expect(service.getDowntimeEventReasons(7)).resolves.toEqual({
      timeZone: JAKARTA,
      ...aggregate,
      loadedThrough: "2026-08-01",
    });
  });

  // NOTHING IS DERIVED HERE, and this is the assertion that says so. Both totals
  // come back from SQL over the same rows the bars came from, which is what makes
  // the bars sum to their own denominator; summing them here would turn that
  // guarantee into an assumption. `totalEvents` is not derivable from the buckets
  // at all — an event citing three reasons appears in three of them, so any
  // reduce over the buckets would produce 5, not 2.
  it("passes both totals through untouched rather than deriving either", async () => {
    const { service } = found();

    const out = await service.getDowntimeEventReasons(7);

    expect(out.totalOccurrences).toBe(5);
    expect(out.totalEvents).toBe(2);
    // The relation the response is allowed to have, asserted rather than assumed.
    expect(out.totalEvents).toBeLessThan(out.totalOccurrences);
    // And the denominator really is the total of the bars.
    expect(out.buckets.reduce((n, b) => n + b.frequency, 0)).toBe(out.totalOccurrences);
  });

  // The zone has to be resolved BEFORE the aggregate, because the join reduces the
  // report's shift-start instant to a business day through it. Getting the order
  // wrong would send `undefined` to Postgres as the zone.
  it("resolves the zone before aggregating, then passes it to the query", async () => {
    const { service, repo, timeZoneResolver } = found();

    await service.getDowntimeEventReasons(7);

    expect(repo.getReportScope).toHaveBeenCalledWith(7);
    expect(timeZoneResolver.resolve).toHaveBeenCalledWith("work-unit", 3);
    expect(repo.aggregateDowntimeEventReasons).toHaveBeenCalledWith(7, JAKARTA);
  });

  it("does not resolve a business day of its own", async () => {
    const { service, repo } = found();

    await service.getDowntimeEventReasons(7);

    expect(repo.resolveBusinessDate).not.toHaveBeenCalled();
  });

  // THE PRODUCT DECISION, from this layer's side. The Others tab must not read the
  // operator-mutable table, so this method must not reach for any reader that
  // does. TODOS.md §30.
  it("reads neither the reject aggregate nor the product rows", async () => {
    const { service, repo } = found();

    await service.getDowntimeEventReasons(7);

    expect(repo.aggregateRejectReasons).not.toHaveBeenCalled();
    expect(repo.listProductCount).not.toHaveBeenCalled();
    expect(repo.listPerfHours).not.toHaveBeenCalled();
  });

  it("404s when the report does not exist", async () => {
    const { service, repo } = setup();
    repo.getReportScope.mockResolvedValue(undefined);

    const err = await statusOf(() => service.getDowntimeEventReasons(404));

    expect(err.status).toBe(404);
    expect(err.message).toBe("report not found");
  });

  // A BAD ID IS NOT A DATA GAP. Conflating the two is what would make
  // downtime_event_empty_total fire on every broken link and stop meaning
  // anything — the same rule its three siblings follow above.
  it("does not report an empty breakdown for an unknown report", async () => {
    const { service, warn } = setup();

    await statusOf(() => service.getDowntimeEventReasons(404));

    expect(warn).not.toHaveBeenCalledWith("downtime_event_empty");
  });

  // THE NORMAL CASE UNTIL THE PIPELINE LANDS. oee.downtime_log_events ships empty,
  // so this path is the one every shift takes today.
  it("reports a report that exists but has no logged events", async () => {
    const { service, warn } = found({ buckets: [], totalOccurrences: 0, totalEvents: 0 }, null);

    const out = await service.getDowntimeEventReasons(7);

    expect(out.buckets).toEqual([]);
    expect(warn).toHaveBeenCalledWith("downtime_event_empty");
  });

  it("does not report an empty breakdown when reasons came back", async () => {
    const { service, warn } = found();

    await service.getDowntimeEventReasons(7);

    expect(warn).not.toHaveBeenCalledWith("downtime_event_empty");
  });

  // A null watermark is a MEANINGFUL absence and may not be substituted: it means
  // the pipeline has never run, which is what separates "not loaded yet" from a
  // shift nothing stopped.
  it("passes a never-loaded watermark through untouched", async () => {
    const { service } = found(aggregate, null);

    expect((await service.getDowntimeEventReasons(7)).loadedThrough).toBeNull();
  });

  // A stop that recorded no reason at all. The bucket's `reason` is NULL and must
  // stay NULL: the "Unspecified" label belongs to the browser, so a genuine reason
  // of that exact text cannot merge into the unattributed bucket.
  it("passes an unattributed bucket through as null rather than a label", async () => {
    const unattributed = {
      buckets: [{ reason: null, frequency: 1 }],
      totalOccurrences: 1,
      totalEvents: 1,
    };
    const { service } = found(unattributed);

    const out = await service.getDowntimeEventReasons(7);

    expect(out.buckets[0]?.reason).toBeNull();
  });
});

describe("WorkUnitReportService page approval status", () => {
  it("defaults a report with no approval row to open", async () => {
    // The ABSENCE of a row IS open (migration 0010), so this is the schema's
    // rule rather than a fallback for a failed lookup. It is also the state of
    // every report in the database today.
    const { service, repo } = setup();
    repo.paginateShiftReport.mockResolvedValue({ items: [row(1, 7)], totalElements: 1 });

    const { items } = await service.getPagedShiftReport(1, 10, {});

    expect(items[0]?.status).toBe("open");
  });

  it("folds an approval onto the row it belongs to, and only that row", async () => {
    // Matched on the REPORT ID the query carries back, never on the natural key:
    // keying a Map on a Date would compare object identity, and two Dates for
    // the same instant are never ===, so every row would silently read "open".
    const { service, repo } = setup();
    repo.paginateShiftReport.mockResolvedValue({
      items: [row(1, 7), row(2, 9)],
      totalElements: 2,
    });
    repo.listApprovalsForPage.mockResolvedValue([{ reportId: 2, status: "closed" }]);

    const { items } = await service.getPagedShiftReport(1, 10, {});

    const byId = new Map(items.map((i) => [i.id, i.status]));
    expect(byId.get(1)).toBe("open");
    expect(byId.get(2)).toBe("closed");
  });

  it("asks for approvals using each row's natural key", async () => {
    const { service, repo } = setup();
    repo.paginateShiftReport.mockResolvedValue({ items: [row(1, 7)], totalElements: 1 });

    await service.getPagedShiftReport(1, 10, {});

    expect(repo.listApprovalsForPage).toHaveBeenCalledWith([
      {
        reportId: 1,
        workUnitId: 7,
        date: new Date("2026-08-09T00:00:00.000Z"),
        shift: 1,
      },
    ]);
  });
});

describe("WorkUnitReportService.approveShiftReport", () => {
  // Roles are [] because these suites exercise the UNGATED default — every
  // operatorRoles field below is undefined, so requireRole returns before it
  // looks at this array. The gate has its own describe block.
  const approver = { subject: "kc-sub-1", name: "dewi", roles: [] };

  it("returns the approval the repository wrote and forwards the subject", async () => {
    const { service, writer } = setup();

    const out = await service.approveShiftReport(42, approver);

    expect(writer.closeShiftReport).toHaveBeenCalledWith({
      reportId: 42,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });
    expect(out.status).toBe("closed");
    // The database's clock, not one the service invented.
    expect(out.closedAt).toEqual(new Date("2026-08-09T09:00:00.000Z"));
  });

  it("404s an unknown report", async () => {
    const { service, writer } = setup();
    writer.closeShiftReport.mockResolvedValue({ kind: "not_found" });

    await expect(service.approveShiftReport(42, approver)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("409s an already-closed report", async () => {
    // NOT an idempotent 200: a second approve is a different operator, or the
    // same one on a stale page, asserting a transition that is no longer
    // available. Answering 200 would name somebody else as the approver.
    const { service, writer } = setup();
    writer.closeShiftReport.mockResolvedValue({ kind: "already_closed" });

    await expect(service.approveShiftReport(42, approver)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("WorkUnitReportService.getActivity", () => {
  // setup()'s getReportScope defaults to undefined so the 404 path is the
  // explicit one everywhere else in this file. The activity tests need a real
  // report, so they seed it here rather than each restating the same three
  // columns.
  function activitySetup() {
    const harness = setup();
    harness.repo.getReportScope.mockResolvedValue({
      workUnitId: 7,
      shift: 1,
      date: new Date("2026-08-09T00:00:00.000Z"),
    });
    return harness;
  }

  it("always reports three sources, even when nothing has happened", async () => {
    // The assertion this endpoint exists for. `entries: []` alone would render
    // as "nothing has ever happened to this report" over data that is largely
    // untrackable.
    const { service } = activitySetup();

    const out = await service.getActivity(7);

    expect(out.entries).toEqual([]);
    expect(out.sources.map((s) => s.kind)).toEqual(["approval", "downtime", "quality"]);
  });

  // THIS ASSERTED THE OPPOSITE, and it was right until Part 3: "reports the
  // quality arm as permanently untracked without querying anything", because
  // reject and rework were the pipeline's alone and no column could hold a trail.
  //
  // An operator can now record a reject AND NAME A MACHINE, so that machine's
  // report has something to show. The assertion inverts rather than being
  // deleted: an arm that silently went back to "untracked" would otherwise pass
  // while quietly hiding an operator's own entries from the machine they
  // attributed them to.
  it("reports the quality arm as tracked, because an operator can now record one", async () => {
    const { service } = activitySetup();

    const out = await service.getActivity(7);
    const quality = out.sources.find((s) => s.kind === "quality");

    expect(quality).toEqual({
      kind: "quality",
      tracked: true,
      untrackedReason: null,
      // Zero is a REAL answer here — nobody entered a reject on this machine this
      // shift — which is why `tracked` is unconditional rather than
      // `entries.length > 0`. The latter reports a quiet shift as an
      // unimplemented feature.
      totalMembers: 0,
      trackedMembers: 0,
    });
  });

  it("distinguishes untrackable downtime from unedited downtime", async () => {
    // trackedMembers 0 out of 3 stops: the pipeline does not write
    // source_event_id yet, so NOTHING about these stops could ever have been
    // recorded — a different claim from "nobody edited them".
    const { service } = activitySetup();

    const out = await service.getActivity(7);
    const downtime = out.sources.find((s) => s.kind === "downtime");

    expect(downtime).toMatchObject({
      tracked: false,
      untrackedReason: "no-stable-id",
      totalMembers: 3,
      trackedMembers: 0,
    });
  });

  it("marks downtime tracked once any stop carries a stable id", async () => {
    const { service, repo } = activitySetup();
    repo.listShiftDowntimeHistory.mockResolvedValue({
      entries: [],
      totalMembers: 3,
      trackedMembers: 2,
    });

    const out = await service.getActivity(7);
    const downtime = out.sources.find((s) => s.kind === "downtime");

    expect(downtime).toMatchObject({ tracked: true, untrackedReason: null });
  });

  it("interleaves both arms newest-first and prefixes the ids", async () => {
    const { service, repo } = activitySetup();
    repo.listApprovalTransitions.mockResolvedValue([
      {
        id: 5,
        at: new Date("2026-08-09T10:00:00.000Z"),
        by: "kc-sub-1",
        byName: "dewi",
        fromStatus: "open",
        toStatus: "closed",
        source: "operator",
      },
    ]);
    repo.listShiftDowntimeHistory.mockResolvedValue({
      entries: [
        {
          id: 5,
          sourceEventId: "evt-a",
          changedAt: new Date("2026-08-09T11:00:00.000Z"),
          changedBy: "kc-sub-2",
          field: "actions",
          oldValue: null,
          newValue: ["Ganti Film"],
        },
      ],
      totalMembers: 1,
      trackedMembers: 1,
    });

    const out = await service.getActivity(7);

    // Newest first ACROSS the arms, not arm by arm.
    expect(out.entries.map((e) => e.id)).toEqual(["downtime:5", "approval:5"]);
    // Both rows are id 5 in their own table. Unprefixed they would collide and
    // React would reuse the wrong row's DOM node.
    expect(new Set(out.entries.map((e) => e.id)).size).toBe(2);
  });

  it("keeps each arm's own order when two entries share an instant", async () => {
    // REGRESSION GUARD. The obvious tie-break — comparing `id` — is wrong here
    // because ids are PREFIXED STRINGS, so "approval:9" sorts after
    // "approval:41" lexicographically and an arm's correct id DESC ordering gets
    // inverted. The merge sorts on `at` alone and relies on sort stability
    // instead; this pins that.
    const SAME = new Date("2026-08-09T10:00:00.000Z");
    const { service, repo } = activitySetup();
    repo.listApprovalTransitions.mockResolvedValue([
      {
        id: 41,
        at: SAME,
        by: "a",
        byName: "dewi",
        fromStatus: "open",
        toStatus: "closed",
        source: "operator",
      },
      {
        id: 9,
        at: SAME,
        by: "b",
        byName: "bagus",
        fromStatus: "closed",
        toStatus: "open",
        source: "operator",
      },
    ]);

    const out = await service.getActivity(7);

    // The repository returned 41 before 9 (its ORDER BY id DESC). That order
    // must survive the merge.
    expect(out.entries.map((e) => e.id)).toEqual(["approval:41", "approval:9"]);
  });

  it("404s an unknown report rather than answering an empty trail", async () => {
    const { service, repo } = activitySetup();
    repo.getReportScope.mockResolvedValue(undefined);

    await expect(service.getActivity(7)).rejects.toMatchObject({ status: 404 });
  });

  it("fails loudly on a shift the window table does not know", async () => {
    // Without the guard this reaches SHIFT_WINDOWS as "4", destructures to three
    // undefineds, and comes back as a window built from NULL — an empty range
    // that silently matches no stops. A quiet shift is a plausible screen, so
    // nothing would look wrong.
    const { service, repo } = activitySetup();
    repo.getReportScope.mockResolvedValue({
      workUnitId: 7,
      shift: 4,
      date: new Date("2026-08-09T00:00:00.000Z"),
    });

    await expect(service.getActivity(7)).rejects.toMatchObject({ status: 500 });
    expect(repo.getShiftWindow).not.toHaveBeenCalled();
  });

  // WHICH OF THE TWO QUALITY READS THE SHIFT FEED USES. The pair is
  // indistinguishable from the payload: both return QualityEntry rows through one
  // mapper, so a swap renders a full, plausible panel. The shift-keyed one handed a
  // day's window would show one shift's entries under a shift heading — correct by
  // accident — while the range one handed a shift's key shows all three shifts'
  // entries on a shift report, which is the direction that actually misleads.
  it("reads the SHIFT-KEYED quality arm, never the range one", async () => {
    const { service, quality } = activitySetup();

    await service.getActivity(7);

    expect(quality.listActivityForMachine).toHaveBeenCalledWith(7, "2026-08-01", 1);
    expect(quality.listActivityForMachineTarget).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The feed at DAY and MONTH grain
// ---------------------------------------------------------------------------
//
// TODOS §64's half. The quality arm was a CONSTANT here — `tracked: false,
// untrackedReason: "no-source"`, whose sentence reads "this feed does not carry
// them" — while an operator on the same machine's SHIFT report saw their own
// entry. Two opposite claims about an identical empty panel, one click apart.
//
// These assert the arm is real, that it reads the RANGE variant over the whole
// period, and that the window it asks for is the report's own — because the
// failure here is arithmetic: a day short by one renders a plausible feed.
describe("WorkUnitReportService.getPeriodActivity — the quality arm", () => {
  function periodSetup() {
    const harness = setup();
    harness.repo.getPeriodReportScope.mockResolvedValue({
      workUnitId: 7,
      workCenterId: 11,
      businessDate: "2026-08-01",
      timeZone: JAKARTA,
    });
    return harness;
  }

  function entry(over: Record<string, unknown> = {}) {
    return {
      id: 5,
      kind: "reject",
      enteredAt: "2026-08-02T03:00:00.000Z",
      enteredBy: "kc-1",
      enteredByName: "Operator One",
      enteredQty: 10,
      enteredUomCode: "CTN",
      targetQty: 120,
      targetUomCode: "BAG",
      productName: "Kacang Garuda 20g",
      reasonName: "Burst seal",
      shift: 2,
      voidedAt: null,
      voidedBy: null,
      voidedByName: null,
      voidReason: null,
      ...over,
    };
  }

  // A HALF-OPEN RANGE OVER THE DAY, keyed on the report's own business_date rather
  // than reduced out of the instant window. `shift: null` is what widens three
  // shifts' entries into a day's — with a shift named, a day report would show one
  // shift's and read as a quiet day.
  it("asks for the whole day, every shift", async () => {
    const { service, quality } = periodSetup();

    await service.getPeriodActivity("day", 9);

    expect(quality.listActivityForMachineTarget).toHaveBeenCalledWith({
      workUnitId: 7,
      dateFrom: "2026-08-01",
      dateTo: "2026-08-02",
      shift: null,
    });
    expect(quality.listActivityForMachine).not.toHaveBeenCalled();
  });

  // THE MONTH END IS A CALENDAR QUESTION, and `+ 30 days` is the wrong answer for
  // eleven months of the year. August has 31 days, so the exclusive end is the 1st
  // of September — one short would silently drop the last day's entries.
  it("asks for the whole month, through calendar arithmetic", async () => {
    const { service, quality } = periodSetup();

    await service.getPeriodActivity("month", 9);

    expect(quality.listActivityForMachineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: "2026-08-01", dateTo: "2026-09-01" }),
    );
  });

  // FEBRUARY AND THE YEAR BOUNDARY, because setUTCMonth is what handles both and a
  // hand-rolled `+ 31` would not.
  it.each([
    ["2026-02-01", "2026-03-01"],
    ["2026-12-01", "2027-01-01"],
  ])("widens %s to %s", async (businessDate, dateTo) => {
    const { service, repo, quality } = periodSetup();
    repo.getPeriodReportScope.mockResolvedValue({
      workUnitId: 7,
      workCenterId: 11,
      businessDate,
      timeZone: JAKARTA,
    });

    await service.getPeriodActivity("month", 9);

    expect(quality.listActivityForMachineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: businessDate, dateTo }),
    );
  });

  // THE ASSERTION THAT INVERTS A SHIPPED CLAIM. This arm reported
  // `untrackedReason: "no-source"`, which renders as a sentence saying the feed
  // cannot carry these — on a grain where it now can. Zero is a REAL answer, so
  // `tracked` is unconditional: `quality.length > 0` would report a quiet month as
  // an unimplemented feature.
  it("reports the quality arm as tracked even when nothing was entered", async () => {
    const { service } = periodSetup();

    const out = await service.getPeriodActivity("day", 9);

    expect(out.sources.find((source) => source.kind === "quality")).toEqual({
      kind: "quality",
      tracked: true,
      untrackedReason: null,
      totalMembers: 0,
      trackedMembers: 0,
    });
  });

  // THE SHIFT LABEL, which is the whole reason a day feed is readable. Without it
  // two 120 BAG rejects against one machine on different shifts are one entry
  // rendered twice.
  it("labels each entry with the shift it was recorded in", async () => {
    const { service, quality } = periodSetup();
    quality.listActivityForMachineTarget.mockResolvedValue([
      entry({ id: 5, shift: 1 }),
      entry({ id: 6, shift: 3 }),
    ]);

    const out = await service.getPeriodActivity("day", 9);

    expect(out.entries.map((e) => ("shift" in e ? e.shift : undefined))).toEqual([1, 3]);
  });

  // AND NULL AT SHIFT GRAIN, where the feed covers one shift and the suffix would
  // be noise on every row. Asserted beside the case above so the two cannot be
  // "made consistent" in the wrong direction.
  it("leaves the shift unlabelled on a shift report's own feed", async () => {
    const { service, repo, quality } = setup();
    repo.getReportScope.mockResolvedValue({
      workUnitId: 7,
      shift: 1,
      date: new Date("2026-08-09T00:00:00.000Z"),
    });
    quality.listActivityForMachine.mockResolvedValue([entry({ shift: 1 })]);

    const out = await service.getActivity(7);

    expect(out.entries.find((e) => e.kind === "quality")).toMatchObject({ shift: null });
  });

  // ONE TIMELINE, not three arms concatenated. The quality arm arrives from its own
  // query, so without the merge sort a day's feed reads as every approval, then
  // every edit, then every entry — which looks like a chronology and is not.
  it("merges the quality arm into the chronology by instant", async () => {
    const { service, repo, quality } = periodSetup();
    repo.listApprovalTransitionsInWindow.mockResolvedValue([
      {
        id: 41,
        at: new Date("2026-08-02T05:00:00.000Z"),
        by: "a",
        byName: "ayu",
        fromStatus: "open",
        toStatus: "closed",
        source: "operator",
        shift: 2,
      },
    ]);
    quality.listActivityForMachineTarget.mockResolvedValue([
      entry({ id: 5, enteredAt: "2026-08-02T06:00:00.000Z" }),
      entry({ id: 6, enteredAt: "2026-08-02T04:00:00.000Z" }),
    ]);

    const out = await service.getPeriodActivity("day", 9);

    expect(out.entries.map((e) => e.id)).toEqual(["quality:5", "approval:41", "quality:6"]);
  });
});

describe("WorkUnitReportService.reopenShiftReport", () => {
  const actor = { subject: "kc-sub-1", name: "dewi", roles: [] };

  it("returns the reopened approval and forwards the subject", async () => {
    const { service, writer } = setup();

    const out = await service.reopenShiftReport(42, actor);

    // The SAME input shape as closeShiftReport: on a reopen those columns are
    // cleared, and what the subject is actually used for is the event row — the
    // only durable record of who undid a sign-off.
    expect(writer.reopenShiftReport).toHaveBeenCalledWith({
      reportId: 42,
      closedBy: "kc-sub-1",
      closedByName: "dewi",
    });
    expect(out.status).toBe("open");
    // All four cleared, which ck_wusra_open requires of an open row — so a
    // lingering approver here would be a state the database would reject.
    expect(out).toMatchObject({ closedAt: null, closedBy: null, closedByName: null, source: null });
  });

  it("404s an unknown report", async () => {
    const { service, writer } = setup();
    writer.reopenShiftReport.mockResolvedValue({ kind: "not_found" });

    await expect(service.reopenShiftReport(42, actor)).rejects.toMatchObject({ status: 404 });
  });

  // Covers both "the row says open" and "there is no row at all" — 0010 makes
  // those the same claim, so the repository collapses them into one outcome and
  // this is the status that outcome becomes.
  it("409s a report that was not closed", async () => {
    const { service, writer } = setup();
    writer.reopenShiftReport.mockResolvedValue({ kind: "already_open" });

    await expect(service.reopenShiftReport(42, actor)).rejects.toMatchObject({ status: 409 });
  });
});

describe("WorkUnitReportService.getMetricsStaleness", () => {
  function stalenessSetup() {
    const harness = setup();
    harness.repo.getReportScope.mockResolvedValue({
      workUnitId: 7,
      shift: 1,
      date: new Date("2026-08-09T00:00:00.000Z"),
    });
    return harness;
  }

  it("reports null when no category has ever been edited", async () => {
    // The state EVERY report is in today: nothing writes
    // oee.downtime_report_history for a pipeline-loaded stop, which has no
    // source_event_id, so
    // nothing could attach to it if it did.
    const { service } = stalenessSetup();

    expect(await service.getMetricsStaleness(7)).toEqual({ categoryEditedAt: null });
  });

  it("reports the instant the category last moved", async () => {
    const { service, repo } = stalenessSetup();
    const at = new Date("2026-08-09T09:30:00.000Z");
    repo.getCategoryEditedAt.mockResolvedValue(at);

    expect(await service.getMetricsStaleness(7)).toEqual({ categoryEditedAt: at });
  });

  // THE ASSERTION THAT PINS THE DESIGN DECISION. `etl_watermarks.last_run_at` is
  // table-grained, so comparing against it would clear the banner while the tiles
  // were still wrong — a run covering other days advances it past the edit
  // without recomputing THIS report. That is the flattering direction, and the
  // silent-failure shape TODOS.md §8 and §14 are both about.
  it("never consults a watermark, and reports no verdict", async () => {
    const { service, repo } = stalenessSetup();
    repo.getCategoryEditedAt.mockResolvedValue(new Date("2026-08-09T09:30:00.000Z"));

    const out = await service.getMetricsStaleness(7);

    expect(repo.getPerfWatermark).not.toHaveBeenCalled();
    expect(repo.getRejectWatermark).not.toHaveBeenCalled();
    expect(repo.getDowntimeEventWatermark).not.toHaveBeenCalled();
    // One field, and it is a fact. A boolean would be a claim about the pipeline
    // that this service cannot make.
    expect(Object.keys(out)).toEqual(["categoryEditedAt"]);
  });

  // Runs over the SAME stop set as getActivity's downtime arm, which is what
  // resolveShiftScope and the shared shiftStops fragment exist to guarantee.
  it("asks about the shift's own window, resolved through the plant zone", async () => {
    const { service, repo, timeZoneResolver } = stalenessSetup();

    await service.getMetricsStaleness(7);

    expect(timeZoneResolver.resolve).toHaveBeenCalledWith("work-unit", 7);
    expect(repo.getCategoryEditedAt).toHaveBeenCalledWith({
      workUnitId: 7,
      from: new Date("2026-08-09T00:00:00.000Z"),
      to: new Date("2026-08-09T08:00:00.000Z"),
    });
  });

  it("404s an unknown report", async () => {
    const { service } = setup();

    await expect(service.getMetricsStaleness(7)).rejects.toMatchObject({ status: 404 });
  });

  // A report carrying a shift the window table does not know about would
  // otherwise build a window from NULL — an empty range that silently matches no
  // stops, on a screen where "no downtime" is entirely plausible. 500 rather than
  // 400: the value came out of a report row, not off the URL.
  it("500s a report with an unknown shift rather than building an empty window", async () => {
    const { service, repo } = setup();
    repo.getReportScope.mockResolvedValue({
      workUnitId: 7,
      shift: 4,
      date: new Date("2026-08-09T00:00:00.000Z"),
    });

    await expect(service.getMetricsStaleness(7)).rejects.toMatchObject({ status: 500 });
  });
});

// TODOS.md §34. The unit-level question is not "does requireRole work" — actor.test.ts
// owns that — but whether each mutation is wired to its OWN variable, which is the
// entire reason §34 ships three rather than one.
describe("WorkUnitReportService role gate", () => {
  const unroled = { subject: "kc-sub-1", name: "dewi", roles: [] };
  const approver = { subject: "kc-sub-1", name: "dewi", roles: ["oee-approver"] };

  it("approve is ungated when APPROVE_ROLE is unset", async () => {
    const { service, writer } = setup();
    writer.closeShiftReport.mockResolvedValue({
      kind: "closed",
      approval: { status: "closed" },
    });

    await service.approveShiftReport(42, unroled);

    expect(writer.closeShiftReport).toHaveBeenCalled();
  });

  it("approve 403s an actor without the configured role", async () => {
    const { service, writer } = setup({ operatorRoles: { approve: "oee-approver" } });

    await expect(service.approveShiftReport(42, unroled)).rejects.toMatchObject({ status: 403 });

    // REFUSED BEFORE THE REPOSITORY. A 403 must not open a transaction, and must
    // not land in the transition counter beside a real conflict.
    expect(writer.closeShiftReport).not.toHaveBeenCalled();
  });

  it("approve lets the role holder through", async () => {
    const { service, writer } = setup({ operatorRoles: { approve: "oee-approver" } });
    writer.closeShiftReport.mockResolvedValue({
      kind: "closed",
      approval: { status: "closed" },
    });

    await service.approveShiftReport(42, approver);

    expect(writer.closeShiftReport).toHaveBeenCalled();
  });

  // THE SEPARATION, asserted in both directions. This is the pair of tests that
  // would fail if the three variables were ever collapsed into one — which is the
  // refactor the code comments argue against, so it is worth making expensive.
  it("APPROVE_ROLE does not gate reopen", async () => {
    const { service, writer } = setup({ operatorRoles: { approve: "oee-approver" } });
    writer.reopenShiftReport.mockResolvedValue({
      kind: "reopened",
      approval: { status: "open" },
    });

    await service.reopenShiftReport(42, unroled);

    expect(writer.reopenShiftReport).toHaveBeenCalled();
  });

  it("REOPEN_ROLE does not gate approve", async () => {
    const { service, writer } = setup({ operatorRoles: { reopen: "oee-supervisor" } });
    writer.closeShiftReport.mockResolvedValue({
      kind: "closed",
      approval: { status: "closed" },
    });

    await service.approveShiftReport(42, unroled);

    expect(writer.closeShiftReport).toHaveBeenCalled();
  });

  // The arrangement §34 exists to make possible: approve granted widely, reopen
  // narrowly, so undoing somebody else's sign-off is not implied by being able to
  // give one.
  it("gates reopen alone when only REOPEN_ROLE is set", async () => {
    const { service, writer } = setup({ operatorRoles: { reopen: "oee-supervisor" } });

    await expect(service.reopenShiftReport(42, approver)).rejects.toMatchObject({ status: 403 });
    expect(writer.reopenShiftReport).not.toHaveBeenCalled();
  });
});
