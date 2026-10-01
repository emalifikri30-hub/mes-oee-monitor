import { HTTPException } from "hono/http-exception";

import { withLog, type Logger } from "@molca/utils";
import { toShiftId, type ShiftWindow } from "../../shared/shift-window.js";
import { buildPageMeta, type PagedResult } from "@molca/network";
import { baseLogger, getRequestContext } from "@molca/observability";

import type { OeeTrend } from "../../shared/oee-trend.js";
import type {
  ActivityEntry,
  ActivitySource,
  MetricsStaleness,
  ShiftProductCounts,
  DowntimeEventBreakdown,
  RejectReasonBreakdown,
  ShiftActivity,
  HourOfDayProfile,
  ShiftPerformance,
  ShiftReportApproval,
  ShiftReportListRow,
  WorkUnitShiftReport,
  PeriodApprovalSummary,
  CoarseGrain,
  PeriodGrain,
  WorkUnitPeriodReport,
  WorkUnitPeriodReportEnrichedList,
  WorkUnitPeriodReportField,
  WorkUnitPeriodReportFilter,
  WorkUnitShiftReportEnrichedList,
  WorkUnitShiftReportFilter,
  WorkUnitShiftReportList,
} from "./work-unit.js";
import type {
  ReportScope,
  WorkUnitReportReader,
  WorkUnitReportWriter,
} from "./work-unit-repository.js";
import { requireRole } from "../../shared/actor.js";
import { DAY_START_HOUR } from "../../shared/shift-window.js";

import type { Actor } from "../../shared/actor.js";
import type { QualityEntryReader } from "../quality-entry/quality-entry-repository.js";
import type { OperatorRoles } from "../../shared/config/config.js";
import type { TimeZoneResolverContract } from "../master-data/time-zone-resolver.js";
import type { MasterDataClientContract, WorkUnitWithCenter } from "@molca/contract-client";
import type { MasterDataServiceContract } from "../master-data/master-data-service.js";

import { isMasterDataError, upstreamUnavailable } from "../master-data/master-data-error.js";
import {
  getDowntimeEventEmptyCounter,
  getDowntimeEventGroupsHistogram,
  getMasterDataRequestsCounter,
  getPerfHourEmptyCounter,
  getPerfHourPointsHistogram,
  getProductCountEmptyCounter,
  getProductCountRowsHistogram,
  getRejectReasonEmptyCounter,
  getRejectReasonGroupsHistogram,
  getShiftReportTransitionsCounter,
  getShiftReportTransitionConflictsCounter,
} from "../../shared/observability/metrics.js";

// ---------------------------------------------------------------------------
// The three arms of the activity feed, and why two of them are empty
// ---------------------------------------------------------------------------

// Approvals. The only arm that can carry a row today.
//
// A CONSTANT, not a function of the transitions, and the numbers are the reason.
// `totalMembers` / `trackedMembers` count how many THINGS OF THIS KIND belong to
// the shift and how many of them could carry a trail — not how many entries
// there are. A shift report has exactly one approval state, and it is trackable,
// so both are 1 whether it has been approved nought times or five. How many
// times it HAS happened is `entries`.
//
// The "not-implemented" UntrackedReason exists for this arm as it was BEFORE the
// approve path landed: no write path, so no transition could ever have been
// recorded.
//
// IT IS STILL UNUSED, and it is now clear that it will stay that way. It was kept
// on the expectation that the downtime-edit half of TODOS.md §21 would need it —
// but that half has shipped and does NOT: a stop with no source_event_id is
// "no-stable-id", which downtimeSource already reports, and that is a truer answer
// than "not-implemented" because the write path exists and the DATA is what
// cannot carry a trail. Kept for TODOS.md §32's quality arm, which is the one
// case that genuinely has no write path.
const APPROVAL_SOURCE: ActivitySource = {
  kind: "approval",
  tracked: true,
  untrackedReason: null,
  totalMembers: 1,
  trackedMembers: 1,
};

// The same source at day or month grain, where the members are the CHILD shift
// reports rather than this one.
//
// `totalMembers` has to be the real count and not 1. The panel says how many
// things of this kind belong to the report, and claiming one at a grain that
// spans three — or ~90 — would make "no changes" read as a much stronger
// statement than it is.
//
// Still `tracked: true`: every shift report can carry a transition, so nothing
// here is untrackable. That is the honest difference from the downtime and
// quality arms below, which report why they cannot.
function periodApprovalSource(shiftsTotal: number): ActivitySource {
  return {
    kind: "approval",
    tracked: true,
    untrackedReason: null,
    totalMembers: shiftsTotal,
    trackedMembers: shiftsTotal,
  };
}

// Downtime edits.
//
// EMPTY FOR EVERY REPORT TODAY, and for a reason the reader cannot see from the
// screen: oee.downtime_report_history is written by the downtime-EDIT path,
// which does not exist (TODOS.md §21 — this change built the approval half of
// that item, not the downtime half).
//
// But that is not the reason reported here, because there is a stronger one.
// `trackedMembers` counts the stops carrying a source_event_id, and the pipeline
// does not write that key yet (§19), so today NOTHING ABOUT THESE STOPS COULD
// EVER HAVE BEEN RECORDED — "no-stable-id" — rather than merely nothing having
// been. The two are opposite claims and the panel words them differently.
//
// `totalMembers` is the real stop count, so the panel can say how many records
// are in this state instead of implying the shift was quiet.
//
// "no-stable-id" REMAINS THE RIGHT REASON NOW THAT THE WRITE PATH EXISTS, and it
// is worth saying why rather than leaving a reader to wonder. Editing a downtime
// is implemented; what is missing is source_event_id, which the pipeline does not
// write yet (contract §3.3.2, TODOS.md §19). So every stop is untrackable because
// of its DATA, not because of missing code — and the panel's copy says exactly
// that. When the DAG populates the column this arm starts carrying rows with no
// change here at all.
function downtimeSource(totalMembers: number, trackedMembers: number): ActivitySource {
  const tracked = trackedMembers > 0;
  return {
    kind: "downtime",
    tracked,
    untrackedReason: tracked ? null : "no-stable-id",
    totalMembers,
    trackedMembers,
  };
}

// THE ARM THAT IS EMPTY BY DESIGN, and the reason `sources` exists at all.
//
// THERE IS NO `QUALITY_SOURCE` CONSTANT ANY MORE, and its removal is worth a
// note because it stood here for three grains and the sentence it carried has
// become false in two steps.
//
// It reported `tracked: false, untrackedReason: "no-source"` and argued at length
// that this was "NOT a grain problem": reject and rework are pipeline-written
// scalars, oee.reject_count_wu_shift is a pipeline-written aggregate, and no
// operator mutation targeted either — so there were zero EDITABLE entities of
// that kind. All of that was true when written. Migration 0017 gave an operator a
// place to record a reject AGAINST A MACHINE, which made the constant wrong at
// shift grain (fixed then, in getActivity) and left it wrong at day and month
// until the range read existed (TODOS.md §64, fixed in getPeriodActivity).
//
// Both feeds now build the arm from a real count, so a constant here would only
// be a way to reintroduce the claim. What each arm reports lives beside the read
// that produced it.

type PagedWorkUnitShiftReportResult = PagedResult<WorkUnitShiftReportEnrichedList>;
type PagedWorkUnitPeriodReportResult = PagedResult<WorkUnitPeriodReportEnrichedList>;
type PagedWorkUnitPeriodReportFilter = Omit<WorkUnitPeriodReportFilter, "workUnitIds"> & {
  workCenterId?: number;
};
type PagedWorkUnitShiftReportFilter = Omit<WorkUnitShiftReportFilter, "workUnitIds"> & {
  workCenterId?: number;
};

type TWorkUnitReportService = {
  getPagedShiftReport: (
    page: number,
    size: number,
    filter: PagedWorkUnitShiftReportFilter,
  ) => Promise<PagedWorkUnitShiftReportResult>;
  getShiftReport: (id: number) => Promise<WorkUnitShiftReport>;
  // The coarse grains. One pair of methods over both, picked by `grain` — the
  // routes stay separate so a URL still names what it returns.
  getPagedPeriodReport: (
    grain: CoarseGrain,
    page: number,
    size: number,
    filter: PagedWorkUnitPeriodReportFilter,
  ) => Promise<PagedWorkUnitPeriodReportResult>;
  getPeriodReport: (grain: CoarseGrain, id: number) => Promise<WorkUnitPeriodReport>;
  getPeriodProductCounts: (grain: PeriodGrain, id: number) => Promise<ShiftProductCounts>;
  getPeriodPerformance: (grain: PeriodGrain, id: number) => Promise<ShiftPerformance>;
  getMonthHourProfile: (id: number) => Promise<HourOfDayProfile>;
  // COARSE ONLY, like getMonthHourProfile above and for a plainer reason: a day
  // has no days inside it to trend. Two named methods rather than one taking a
  // grain, so the third call that has no table behind it cannot be written.
  getMonthOeeTrend: (id: number) => Promise<OeeTrend>;
  getYearOeeTrend: (id: number) => Promise<OeeTrend>;
  getPeriodRejectReasons: (grain: CoarseGrain, id: number) => Promise<RejectReasonBreakdown>;
  getPeriodDowntimeEventReasons: (
    grain: PeriodGrain,
    id: number,
  ) => Promise<DowntimeEventBreakdown>;
  getPeriodActivity: (grain: PeriodGrain, id: number) => Promise<ShiftActivity>;
  getProductCounts: (id: number) => Promise<ShiftProductCounts>;
  getPerformance: (id: number) => Promise<ShiftPerformance>;
  getRejectReasons: (id: number) => Promise<RejectReasonBreakdown>;
  getDowntimeEventReasons: (id: number) => Promise<DowntimeEventBreakdown>;
  getActivity: (id: number) => Promise<ShiftActivity>;
  getMetricsStaleness: (id: number) => Promise<MetricsStaleness>;
  getPeriodMetricsStaleness: (grain: PeriodGrain, id: number) => Promise<MetricsStaleness>;
  approveShiftReport: (id: number, actor: Actor) => Promise<ShiftReportApproval>;
  reopenShiftReport: (id: number, actor: Actor) => Promise<ShiftReportApproval>;
};

type WorkUnitReportServiceDeps = {
  workUnitReportReaderRepository: WorkUnitReportReader;
  workUnitReportWriterRepository: WorkUnitReportWriter;
  // FOR THE ACTIVITY FEED's third arm only, through the Awilix seam the downtime
  // service already uses for this module's reader. A machine's feed shows the
  // rejects an operator ATTRIBUTED to it, even though the quantity lands on the
  // line — see listActivityForMachine.
  qualityEntryRepository: QualityEntryReader;
  masterDataClient: MasterDataClientContract;
  // For the work-center filter's id list, which is CACHED there — see
  // resolveWorkUnitIds. The client above is still used for everything else this
  // service asks upstream, none of which is cacheable per-request.
  masterDataService: MasterDataServiceContract;
  timeZoneResolver: TimeZoneResolverContract;
  operatorRoles: OperatorRoles;
  logger?: Logger;
};

class WorkUnitReportService implements TWorkUnitReportService {
  private workUnitReportReaderRepository: WorkUnitReportReader;
  private workUnitReportWriterRepository: WorkUnitReportWriter;
  private qualityEntryRepository: QualityEntryReader;
  private masterDataClient: MasterDataClientContract;
  private masterDataService: MasterDataServiceContract;
  private timeZoneResolver: TimeZoneResolverContract;
  private operatorRoles: OperatorRoles;
  private fallbackLogger: Logger;

  constructor({
    workUnitReportReaderRepository,
    workUnitReportWriterRepository,
    qualityEntryRepository,
    masterDataClient,
    masterDataService,
    timeZoneResolver,
    operatorRoles,
    logger,
  }: WorkUnitReportServiceDeps) {
    this.workUnitReportReaderRepository = workUnitReportReaderRepository;
    this.workUnitReportWriterRepository = workUnitReportWriterRepository;
    this.qualityEntryRepository = qualityEntryRepository;
    this.masterDataClient = masterDataClient;
    this.masterDataService = masterDataService;
    this.timeZoneResolver = timeZoneResolver;
    this.operatorRoles = operatorRoles;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  // Metrics live in this service's Gold DB, but the labels that make a row
  // readable — and the work-center filter itself — belong to mes-master-data.
  // So one report page is a three-stage pipeline across two systems:
  //
  //   [1] workCenterId given?                                   FATAL on failure
  //        └─ masterData.findAllWorkUnitByWorkCenterId ──HTTP─▶
  //             ├─ ids  -> filter.workUnitIds = ids
  //             └─ none -> masterData.existsWorkCenter ────HTTP─▶
  //                          ├─ false -> 404
  //                          └─ true  -> 200, empty page
  //   [2] goldDb.paginateShiftReport ──SQL─▶  rows keyed by workUnitId
  //   [3] distinct(workUnitIds), skip if empty                DEGRADES on failure
  //        └─ masterData.findAllWorkUnitByWorkUnitIds ────HTTP─▶
  //             └─ Map by id -> attach workUnit + workCenter
  //
  // The stages are genuinely sequential: [2] needs [1]'s id list, [3] needs
  // [2]'s rows. Nothing here can be parallelised.
  //
  // The asymmetry between [1] and [3] is deliberate. A failure in [1] would
  // return rows the caller did not ask for — silently WRONG data — so it must
  // fail the request. A failure in [3] only costs cosmetic labels, which the
  // enriched type already models as nullable, so the metrics still render. The
  // trade is availability for correctness, in the one place each matters.
  async getPagedShiftReport(
    page: number,
    size: number,
    filter: PagedWorkUnitShiftReportFilter,
  ): Promise<PagedWorkUnitShiftReportResult> {
    return await withLog(this.logger, "paged_work_unit_shift_report", filter, async () => {
      const limit = size;
      const offset = (page - 1) * limit;

      const { workCenterId, ...rest } = filter;
      const resolved = await this.resolveWorkUnitIds(workCenterId);

      // An existing work center with no work units: a valid, genuinely empty
      // report. Short-circuited because `workUnitIds: []` would be dropped as
      // "no filter" and return every work unit's rows instead of none.
      if (resolved.emptyPage) {
        return { items: [], meta: buildPageMeta(page, size, 0) };
      }

      const { items, totalElements } =
        await this.workUnitReportReaderRepository.paginateShiftReport({
          limit,
          offset,
          filter: { ...rest, workUnitIds: resolved.workUnitIds },
        });

      // Approval state is still a SECOND query rather than a join — but the reason
      // has changed, and the old one is worth correcting rather than deleting.
      //
      // It used to be that joining would force an alias onto paginateShiftReport's
      // SQL and make every bare `shift` / `date` / `id` reference ambiguous at
      // runtime, which fakeSql cannot see. THAT COST HAS NOW BEEN PAID: the
      // server-side `status` filter (TODOS.md §36) needed to correlate a subquery
      // against the report row, so the table is aliased `r` and every fragment is
      // qualified, with an integration case per periodFilter branch.
      //
      // What remains is a weaker argument, and it is a trade rather than a hazard:
      // this is one ~0.5 ms round trip on a query benchmarked at 0.8 ms, and
      // FILTERING is a semi-join that selects no columns while DISPLAYING needs the
      // actual values. Folding it in is now possible; it is simply not free, and
      // nothing is asking for it.
      const withStatus = await this.attachApprovalStatus(items);

      const enriched = await this.enrich(withStatus);

      return { items: enriched, meta: buildPageMeta(page, size, totalElements) };
    });
  }

  // `timeZone` is stamped on rather than selected — it is resolved per work unit
  // through the master-data hierarchy, not stored on the row. Same reasoning as
  // downtime-service.ts does for its list rows.
  //
  // It has to be on this response specifically, because `date` is the shift's start
  // INSTANT and every consumer that wants a calendar day out of it needs a zone to
  // reduce it in. Without this field the browser has a circular problem: the
  // timeline response carries the zone, but working out which timeline to ask for
  // requires the business day first.
  async getShiftReport(reportId: number): Promise<WorkUnitShiftReport> {
    return await withLog(this.logger, "detail_work_unit_shift_report", { reportId }, async () => {
      const found = await this.workUnitReportReaderRepository.getShiftReport(reportId);
      if (!found) throw new HTTPException(404, { message: "report not found" });

      const timeZone = await this.timeZoneResolver.resolve("work-unit", found.workUnitId);

      return { ...found, timeZone };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The coarse grains
  // ───────────────────────────────────────────────────────────────────────────

  async getPagedPeriodReport(
    grain: CoarseGrain,
    page: number,
    size: number,
    filter: PagedWorkUnitPeriodReportFilter,
  ): Promise<PagedWorkUnitPeriodReportResult> {
    return await withLog(this.logger, `paged_work_unit_${grain}_report`, filter, async () => {
      const limit = size;
      const offset = (page - 1) * limit;

      const { workCenterId, ...rest } = filter;
      const resolved = await this.resolveWorkUnitIds(workCenterId);

      // Same short-circuit the shift list needs, and for the same reason: an
      // empty id list is dropped as "no filter" downstream, so it would return
      // every machine's rows rather than none.
      if (resolved.emptyPage) {
        return { items: [], meta: buildPageMeta(page, size, 0) };
      }

      const { items, totalElements } =
        await this.workUnitReportReaderRepository.paginatePeriodReport({
          grain,
          limit,
          offset,
          filter: { ...rest, workUnitIds: resolved.workUnitIds },
        });

      // No attachApprovalStatus here, unlike the shift list. There is no day or
      // month approval, and deriving a per-row shift count would be one window
      // query per row — see WorkUnitPeriodReportList.
      const enriched = await this.enrich(items);

      return { items: enriched, meta: buildPageMeta(page, size, totalElements) };
    });
  }

  // One report, plus the derived shift count the day screen's Status tile shows.
  //
  // `timeZone` is NOT stamped on here the way getShiftReport stamps it: 0013 put
  // the column on the row, so it is selected. That removes a mes-master-data call
  // from the detail path entirely.
  async getPeriodReport(grain: CoarseGrain, reportId: number): Promise<WorkUnitPeriodReport> {
    return await withLog(
      this.logger,
      `detail_work_unit_${grain}_report`,
      { reportId },
      async () => {
        const found = await this.workUnitReportReaderRepository.getPeriodReport(grain, reportId);
        if (!found) throw new HTTPException(404, { message: "report not found" });

        return { ...found, approval: await this.summariseShifts(grain, found) };
      },
    );
  }

  // The per-SKU breakdown at day or month grain.
  //
  // SHORTER THAN ITS SHIFT SIBLING BY TWO STEPS, and the absence is the point.
  // getProductCounts has to resolve the plant zone and convert the report's
  // shift-start instant into a business day before it can join; here both sides
  // are `date` columns after 0013, so the join needs neither. `timeZone` still
  // reaches the browser — it is read off the row rather than fetched.
  async getPeriodProductCounts(grain: PeriodGrain, reportId: number): Promise<ShiftProductCounts> {
    return await withLog(this.logger, `product_count_wu_${grain}`, { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(grain, reportId);
      // The sibling endpoint 404s this id, so this one must not answer 200.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      // Concurrent, and the watermark is a SEPARATE statement rather than a join:
      // a joined watermark vanishes when no rows match, and no rows is exactly
      // the case it exists to explain.
      const [items, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.listPeriodProductCount(grain, reportId),
        this.workUnitReportReaderRepository.getProductCountWatermark(),
      ]);

      // The watermark named here is product_count_wu_shift's, NOT one for
      // product_count_wu_day — nothing writes a day watermark yet, and inventing
      // a null one would make every day report claim "not loaded". The two
      // tables are filled by the same DAG run, so the shift watermark is the
      // best available answer; gold-write-contract §15.8 asks for the real ones.
      const timeZone = scope.timeZone ?? "UTC";

      if (items.length === 0) {
        // TAGGED WITH THE GRAIN, and the shift path's untagged emission is what
        // it is compared against. Without this a firing ProductCountEmpty names
        // oee.product_count_wu_shift in its annotation while the actual empty
        // read was oee.product_count_wu_day — sending whoever is paged to the
        // wrong table at the wrong hour.
        getProductCountEmptyCounter().add(1, { grain });
        this.logger.withMetadata({ reportId, grain, loadedThrough }).warn("product_count_empty");
        return { items, timeZone, loadedThrough };
      }

      getProductCountRowsHistogram().record(items.length, { grain });
      return { items, timeZone, loadedThrough };
    });
  }

  // The hourly performance profile at DAY grain, behind the Losses card's View
  // button.
  //
  // DAY ONLY, and month is refused rather than served. TODOS.md §23 is explicit:
  // a month of hourly rows is ~720 points, which no line chart can show, and the
  // answer there is an hour-of-day PROFILE grouped over 24 buckets — a different
  // chart answering a different question. Serving 720 points here because the
  // query happens to accept the range would put an unreadable chart on screen
  // and look like the feature working.
  //
  // `listPerfHours` IS REUSED UNCHANGED. §23 measured this: the same
  // ix_ppwuh_wu_day_shift index scan serves one date with a shift, one date
  // without, and a range without — so day grain is a new handler, not a new
  // query. It passes the same date twice and omits the shift.
  async getPeriodPerformance(grain: PeriodGrain, reportId: number): Promise<ShiftPerformance> {
    // Month has its OWN endpoint and its own payload shape — see
    // getMonthHourProfile. This one stays day-only rather than growing a second
    // return type on one path.
    if (grain === "month") {
      throw new HTTPException(404, { message: "use hour-profile at month grain" });
    }

    return await withLog(this.logger, "product_perf_wu_day", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(grain, reportId);
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      // No resolveBusinessDate call, unlike the shift path: 0013 put the business
      // day on the row, so there is no instant to reduce through a zone.
      const businessDate = scope.businessDate;
      if (businessDate === null) {
        throw new HTTPException(404, { message: "report has no business date" });
      }

      const [buckets, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.listPerfHours({
          workUnitId: scope.workUnitId,
          dateFrom: businessDate,
          dateTo: businessDate,
          // NO SHIFT. That is the whole difference from the shift handler, and it
          // is what widens the same query from eight hours to twenty-four.
        }),
        this.workUnitReportReaderRepository.getPerfWatermark(),
      ]);

      if (buckets.length === 0) {
        getPerfHourEmptyCounter().add(1, { grain });
        this.logger
          .withMetadata({ reportId, grain, businessDate, loadedThrough })
          .warn("perf_hour_empty");
      } else {
        // A day is 24 buckets against a shift's 8, so the untagged histogram
        // would show a bimodal distribution nobody could read. The grain is what
        // separates the two populations.
        getPerfHourPointsHistogram().record(buckets.length, { grain });
      }

      return { timeZone: scope.timeZone ?? "UTC", buckets, loadedThrough };
    });
  }

  // The Quality Loss Pareto at day or month grain.
  //
  // Same shape as its shift sibling minus the zone resolution — 0013 put the
  // business day on the row, so the join needs no `AT TIME ZONE`.
  //
  // A MIXED-UNIT WINDOW IS ORDINARY HERE, unlike at shift grain. The aggregate's
  // `CASE WHEN count(DISTINCT uom_code) = 1` guards return NULL for a bucket that
  // saw both BAG and CARTON, and over thirty days that is common. The screen
  // already renders an em dash for a null unit; what it must never do is pick one
  // and add incompatible numbers under it.
  async getPeriodRejectReasons(
    grain: CoarseGrain,
    reportId: number,
  ): Promise<RejectReasonBreakdown> {
    return await withLog(this.logger, `reject_count_wu_${grain}`, { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(grain, reportId);
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const [aggregate, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.aggregatePeriodRejectReasons(grain, reportId),
        this.workUnitReportReaderRepository.getRejectWatermark(),
      ]);

      if (aggregate.buckets.length === 0) {
        getRejectReasonEmptyCounter().add(1, { grain });
        this.logger.withMetadata({ reportId, grain, loadedThrough }).warn("reject_reason_empty");
      } else {
        getRejectReasonGroupsHistogram().record(aggregate.buckets.length, { grain });
      }

      return { timeZone: scope.timeZone ?? "UTC", ...aggregate, loadedThrough };
    });
  }

  // The Others tab's Pareto at day or month grain.
  //
  // The pairs fragment DISTINCTs on (event_id, reason) across the whole window,
  // so a reason repeated inside one event still counts once however many days
  // the window spans — the property the shift version relies on, holding at a
  // scale where it actually gets exercised.
  async getPeriodDowntimeEventReasons(
    grain: PeriodGrain,
    reportId: number,
  ): Promise<DowntimeEventBreakdown> {
    return await withLog(this.logger, `downtime_log_events_${grain}`, { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(grain, reportId);
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const [aggregate, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.aggregatePeriodDowntimeEventReasons(grain, reportId),
        this.workUnitReportReaderRepository.getDowntimeEventWatermark(),
      ]);

      if (aggregate.buckets.length === 0) {
        getDowntimeEventEmptyCounter().add(1, { grain });
        this.logger.withMetadata({ reportId, grain, loadedThrough }).warn("downtime_event_empty");
      } else {
        getDowntimeEventGroupsHistogram().record(aggregate.buckets.length, { grain });
      }

      return { timeZone: scope.timeZone ?? "UTC", ...aggregate, loadedThrough };
    });
  }

  // The MONTH report's hour-of-day performance profile, behind the Losses card's
  // View button and the Performance Loss tab's Trendline sub-tab.
  //
  // A SEPARATE ENDPOINT FROM /performance, not a second shape on it. The payload
  // genuinely differs — a bucket here is an hour of the CLOCK that occurred ~30
  // times, not an instant — and one path returning two shapes is the kind of
  // thing a caller gets wrong once and then works around forever.
  //
  // The heavy lifting is the repository's; §23 was right that this is a handler
  // rather than a new query, and right again that a month needs the profile
  // rather than the raw hours.
  async getMonthHourProfile(reportId: number): Promise<HourOfDayProfile> {
    return await withLog(this.logger, "product_perf_wu_hour_profile", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(
        "month",
        reportId,
      );
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });
      if (scope.businessDate === null) {
        throw new HTTPException(404, { message: "report has no business date" });
      }

      // The month's whole span, as business days. `business_date` is the first of
      // the month, so the window is [first, first + 1 month - 1 day] — expressed
      // by asking the database rather than by adding 30 in JavaScript.
      const window = await this.workUnitReportReaderRepository.getPeriodWindow(
        "month",
        scope.businessDate,
        scope.timeZone ?? "UTC",
      );

      const [buckets, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.listPerfHourProfile({
          workUnitId: scope.workUnitId,
          dateFrom: scope.businessDate,
          // The last business day IN the month. `window.to` is the instant the
          // NEXT month begins, so its business day is the 1st of that month and
          // must not be included — the predicate is `<=` on a date.
          dateTo: await this.workUnitReportReaderRepository.resolveBusinessDate(
            new Date(window.to.getTime() - 1),
            scope.timeZone ?? "UTC",
          ),
          dayStartHour: DAY_START_HOUR,
        }),
        this.workUnitReportReaderRepository.getPerfWatermark(),
      ]);

      if (buckets.length === 0) {
        getPerfHourEmptyCounter().add(1, { grain: "month" });
        this.logger
          .withMetadata({ reportId, grain: "month", loadedThrough })
          .warn("perf_hour_empty");
      } else {
        // 24 hours x products, so this population is distinct again from the
        // shift's 8 and the day's 24-per-product. The grain label separates them.
        getPerfHourPointsHistogram().record(buckets.length, { grain: "month-profile" });
      }

      return {
        timeZone: scope.timeZone ?? "UTC",
        dayStartHour: DAY_START_HOUR,
        buckets,
        loadedThrough,
      };
    });
  }

  // The month's daily OEE curve, behind the OEE Performance dashboard's trend
  // chart. Nothing else in this service answers "which days inside the month were
  // bad" — the day LIST filters by line and caps at 100 rows, which silently
  // truncates at four machines times thirty-one days.
  //
  // SIMPLER THAN getMonthHourProfile ABOVE, and deliberately so. That one has to
  // resolve a window because product_perf_wu_hour is keyed by business day and the
  // report is not; here both sides are `date` columns and the repository reads the
  // span straight off the month row, so there is no window to compute and no zone
  // arithmetic to get wrong. The time zone is still returned — the browser needs
  // it to label the axis — but nothing here divides by it.
  //
  // NO METRIC INSTRUMENT, unlike every sibling sub-feed on this service. That
  // asymmetry is a decision, not an oversight: an `*_empty` counter here would
  // pull prometheus-alerts.yml and grafana/dashboards/oee-service.json into the
  // same change, because AGENTS.md requires the three to move together. Filed in
  // TODOS.md instead of half-done.
  async getMonthOeeTrend(reportId: number): Promise<OeeTrend> {
    return await withLog(this.logger, "work_unit_month_oee_trend", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(
        "month",
        reportId,
      );
      // The sibling endpoints 404 this id, so this one must not answer 200.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      // Concurrent, and the watermark is a SEPARATE statement rather than a join:
      // a joined watermark vanishes when no rows match, and no rows is exactly the
      // case it exists to explain. An unloaded month and a month the machine never
      // ran both draw as an empty chart; only this tells them apart.
      const [items, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.listMonthOeeTrend(reportId),
        this.workUnitReportReaderRepository.getDayReportWatermark(),
      ]);

      return { items, timeZone: scope.timeZone ?? "UTC", loadedThrough };
    });
  }

  // THE YEAR'S MONTHLY CURVE — its month sibling one grain up, and the ONE
  // difference that matters is the watermark.
  //
  // `getMonthReportWatermark`, NOT `getDayReportWatermark`. This curve plots MONTH
  // rows, so the day table's freshness says nothing about it: a plant whose day
  // model has run to yesterday but whose month model stopped in June would draw six
  // months and claim to be current. The two feeds read different tables and must
  // report different watermarks.
  //
  // A SEPARATE METHOD RATHER THAN A GRAIN PARAMETER, matching the repository: there
  // is no day-grain answer — a day has no days inside it to trend — so a grain
  // argument would admit a third call with no table behind it.
  async getYearOeeTrend(reportId: number): Promise<OeeTrend> {
    return await withLog(this.logger, "work_unit_year_oee_trend", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(
        "year",
        reportId,
      );
      // The sibling endpoints 404 this id, so this one must not answer 200.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const [items, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.listYearOeeTrend(reportId),
        this.workUnitReportReaderRepository.getMonthReportWatermark(),
      ]);

      return { items, timeZone: scope.timeZone ?? "UTC", loadedThrough };
    });
  }

  // Log Activity at day or month grain.
  //
  // WHAT THIS CAN HONESTLY SHOW, and why it is not simply the shift feed widened.
  //
  // There is no day or month approval — the events table is keyed
  // (work_unit_id, date, shift), which is the same fact that means there is
  // nothing to sign off at these grains. So the approval arm reports the
  // transitions of the CHILD shift reports, each labelled with its shift, and
  // `totalMembers` is the real count of them rather than 1.
  //
  // The downtime arm needs no widening at all: listShiftDowntimeHistory was
  // already expressed as a window, which is why this method is a handler rather
  // than new SQL. It reports "no-stable-id" here for exactly the reason it does
  // at shift grain — the pipeline does not write source_event_id (TODOS.md §19),
  // so those stops could never have carried a trail rather than merely not
  // having one.
  //
  // THE QUALITY ARM IS REAL AT THESE GRAINS NOW, and the comment it replaces was
  // wrong twice over. It said the arm "is empty at every grain" because "no
  // operator mutation targets either" quality table — which stopped being true
  // with migration 0017, first at shift grain and now here. TODOS.md §64 named
  // the remaining half precisely: the range read was keyed `work_center_id` and a
  // machine feed needs its own, which `listActivityForMachineTarget` is.
  //
  // WHAT AN EMPTY ARM MEANT BEFORE THIS, and why that was the bug rather than a
  // missing feature: the arm reported `tracked: false, untrackedReason:
  // "no-source"`, whose sentence says "this feed does not carry them", while an
  // operator reading the same panel on the same machine's SHIFT report saw their
  // own entry. Two opposite claims about an identical empty panel, one click
  // apart. It is §8's failure one arm over.
  //
  // REWORK STILL NEVER APPEARS, at any grain, and that is structural rather than
  // a filter: a rework carries no work_unit_id (the dialog does not ask), so a
  // machine-scoped read cannot return one. See listActivityForMachineTarget.
  async getPeriodActivity(grain: PeriodGrain, reportId: number): Promise<ShiftActivity> {
    return await withLog(this.logger, `activity_wu_${grain}_report`, { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(grain, reportId);
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });
      if (scope.businessDate === null || scope.timeZone === null) {
        throw new HTTPException(404, { message: "report has no resolvable window" });
      }

      const window = await this.workUnitReportReaderRepository.getPeriodWindow(
        grain,
        scope.businessDate,
        scope.timeZone,
      );

      const [transitions, downtime, approvals, quality] = await Promise.all([
        this.workUnitReportReaderRepository.listApprovalTransitionsInWindow({
          workUnitId: scope.workUnitId,
          from: window.from,
          to: window.to,
        }),
        this.workUnitReportReaderRepository.listShiftDowntimeHistory({
          workUnitId: scope.workUnitId,
          from: window.from,
          to: window.to,
        }),
        // The member count for the approval source. The same query the Status
        // tile uses, so the panel and the tile cannot disagree about how many
        // shifts the period has.
        this.workUnitReportReaderRepository.summariseApprovalsInWindow({
          workUnitId: scope.workUnitId,
          from: window.from,
          to: window.to,
        }),
        // ACROSS A MODULE BOUNDARY through the Awilix seam, as the shift feed does
        // — and on a BUSINESS-DATE RANGE rather than the instant window the two
        // arms above use, because an entry is shift-keyed by construction (0017)
        // and has no instant to fall inside.
        //
        // The range is computed from `business_date` on the report row, NOT
        // reduced out of `window`: 0013 put that column on both coarse tables, so
        // there is no zone to go through and `addDay` / `addMonth` are plain
        // calendar arithmetic. Deriving it from the instants instead would need
        // resolveBusinessDate twice and would put a zone back into the one value
        // that exists to be free of one.
        this.qualityEntryRepository.listActivityForMachineTarget({
          workUnitId: scope.workUnitId,
          dateFrom: scope.businessDate,
          dateTo: grain === "month" ? addMonth(scope.businessDate) : addDay(scope.businessDate),
          // EVERY SHIFT IN THE RANGE. The whole difference from the shift feed's
          // call, and what widens three shifts' entries into a day's.
          shift: null,
        }),
      ]);

      const entries: ActivityEntry[] = [
        ...transitions.map((t) => ({
          kind: "approval" as const,
          id: `approval:${t.id}`,
          at: t.at,
          by: t.by,
          byName: t.byName,
          fromStatus: t.fromStatus,
          toStatus: t.toStatus,
          source: t.source,
          // The one field the shift feed leaves null. Without it three approvals
          // in a day's feed are indistinguishable from three approvals of the
          // same report.
          shift: t.shift,
        })),
        ...downtime.entries.map((e) => ({
          kind: "downtime" as const,
          id: `downtime:${e.id}`,
          at: e.changedAt,
          by: e.changedBy,
          sourceEventId: e.sourceEventId,
          field: e.field,
          oldValue: e.oldValue,
          newValue: e.newValue,
        })),
        // THE THIRD ARM, over the whole period. Mapped here rather than through a
        // shared helper for the reason the SKU and area feeds give about their own
        // copies: what the feeds share is a WIRE SHAPE, not a type, and a shared
        // mapper would need a shared return type — which would re-couple four
        // modules' payloads to save one function.
        ...quality.map((q) => ({
          kind: "quality" as const,
          id: `quality:${String(q.id)}`,
          // The ENTRY's instant, not the void's: one action, one row.
          at: new Date(q.enteredAt),
          by: q.enteredBy,
          byName: q.enteredByName,
          entryKind: q.kind,
          enteredQty: q.enteredQty,
          enteredUomCode: q.enteredUomCode,
          targetQty: q.targetQty,
          targetUomCode: q.targetUomCode,
          productName: q.productName,
          reasonName: q.reasonName,
          // THE FIELD THE SHIFT FEED LEAVES NULL, for the reason the approval arm
          // above carries its own: without it, two entries of the same quantity
          // against the same machine on different shifts read as one entry made
          // twice.
          shift: q.shift,
          voidedAt: q.voidedAt === null ? null : new Date(q.voidedAt),
          voidedBy: q.voidedBy,
          voidedByName: q.voidedByName,
          voidReason: q.voidReason,
        })),
      ];

      // Sorted on `at` alone, leaving ties to sort stability — for the reason
      // getActivity states at length: `id` is a PREFIXED STRING here, so
      // comparing two of them is lexicographic and would invert an arm's own
      // correct ordering for entries sharing an instant.
      entries.sort((a, b) => b.at.getTime() - a.at.getTime());

      return {
        timeZone: scope.timeZone,
        entries,
        sources: [
          periodApprovalSource(approvals.shiftsTotal),
          downtimeSource(downtime.totalMembers, downtime.trackedMembers),
          // A REAL ARM, not QUALITY_SOURCE — which is what this slot held while
          // the read did not exist, and which claimed "these figures are the
          // pipeline's and cannot be edited here" on a machine whose own shift
          // report showed the operator's entry.
          //
          // ZERO IS A REAL ANSWER — nobody recorded a reject on this machine this
          // period — so `tracked` is unconditionally true rather than
          // `quality.length > 0`, which would report a quiet month as an
          // unimplemented feature. The two counts are equal by construction: this
          // service owns the write (0017), so every entry that exists carries a
          // full trail.
          {
            kind: "quality" as const,
            tracked: true,
            untrackedReason: null,
            totalMembers: quality.length,
            trackedMembers: quality.length,
          },
        ],
      };
    });
  }

  // The Status tile's two numbers, or null when there is nothing to show.
  //
  // NULL AT MONTH GRAIN BY DESIGN, not because it is expensive. A month spans
  // ~90 shifts, and "58 of 90 shifts approved" is not a fact anybody acts on —
  // the month screen has no Status tile at all. Returning null rather than a
  // count is what makes that a decision the payload states instead of something
  // the browser has to know.
  //
  // Null ALSO when the window cannot be resolved, which is the honest answer
  // when business_date or time_zone is missing: the alternative is reporting
  // "0 of 0 shifts approved", which reads as a real answer about a real day.
  private async summariseShifts(
    grain: CoarseGrain,
    report: WorkUnitPeriodReportField,
  ): Promise<PeriodApprovalSummary | null> {
    // NULL AT MONTH **AND YEAR**, and the year arm is the stronger case rather
    // than a copy of the month one. "2 of 3 shifts approved" is a statement a
    // supervisor can act on; "418 of 1,095" is a number nobody reads, over a scan
    // of every shift report in the year, on the blocking path of a dashboard that
    // renders no Status tile at all. The dashboard is not an approval surface.
    if (grain === "month" || grain === "year") return null;
    if (report.businessDate === null || report.timeZone === null) return null;

    const window = await this.workUnitReportReaderRepository.getPeriodWindow(
      grain,
      report.businessDate,
      report.timeZone,
    );

    return await this.workUnitReportReaderRepository.summariseApprovalsInWindow({
      workUnitId: report.workUnitId,
      from: window.from,
      to: window.to,
    });
  }

  // Fold each page row's approval status onto it.
  //
  // A Map keyed on the REPORT ID, which the query carries through and hands back,
  // rather than on the natural key. Keying on (workUnitId, date, shift) would
  // mean building a composite string from a Date, and the failure mode of getting
  // that wrong is silent: every report would simply read "open", which is exactly
  // what an unapproved report looks like.
  //
  // Absent means open. That is not a fallback for a failed lookup — it is the
  // schema's rule (0010: the ABSENCE of a row means open), and the same coalesce
  // the detail query does in SQL.
  private async attachApprovalStatus(
    rows: ShiftReportListRow[],
  ): Promise<WorkUnitShiftReportList[]> {
    const approvals = await this.workUnitReportReaderRepository.listApprovalsForPage(
      rows.map((row) => ({
        reportId: row.id,
        workUnitId: row.workUnitId,
        date: row.date,
        shift: row.shift,
      })),
    );

    const byReportId = new Map(approvals.map((a) => [a.reportId, a.status]));

    return rows.map((row) => ({ ...row, status: byReportId.get(row.id) ?? "open" }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Approve and reopen — the two writes this service makes
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Thin on purpose. Everything that could go wrong concurrently is settled by
  // the repository's single conditional upsert (see closeShiftReport); this
  // method's whole job is turning its three outcomes into three HTTP statuses
  // and counting the one that matters.
  //
  //   not_found      -> 404, and NOT counted. A bad id is a bad request, not a
  //                     data gap — the rule getProductCounts states for itself.
  //   already_closed -> 409, and COUNTED. The browser offered Approve on a
  //                     report that was already closed, which is a stale cache:
  //                     the server answers correctly and looks perfectly healthy,
  //                     so this counter is the only thing that would ever say so.
  //   closed         -> 200, counted by `source`.
  //
  // WHY 409 AND NOT AN IDEMPOTENT 200. A second approve is not a retry of the
  // first. It is a different operator — or the same one on a stale page —
  // asserting a transition that is no longer available, and answering 200 would
  // tell them "you approved it" while the payload named somebody else at a
  // different instant.
  //
  // The 409 body cannot carry the current approval, because app.onError builds
  // the error envelope as WebResponse.error(message) with no `data`. The browser
  // refetches. That is a property of the shared envelope and is deliberately not
  // special-cased here.
  //
  // ROLE-GATED, and OFF unless APPROVE_ROLE is set — TODOS.md §34. Until it is,
  // any authenticated caller may approve and `closed_by` records exactly who did,
  // which is the behaviour every deployment has had so far.
  //
  // The check is HERE and not in the handler because this is where domain rules
  // live, and because "who may do this" belongs beside "what happens when they
  // do" rather than a layer away from it. The handler's job stays reading the
  // token — see requireActor.
  //
  // Gated BEFORE the repository call, so a refusal never opens a transaction and
  // never emits a transition metric. A 403 is not a conflict and must not appear
  // in the same series as one.
  async approveShiftReport(reportId: number, actor: Actor): Promise<ShiftReportApproval> {
    requireRole(actor, this.operatorRoles.approve, {
      metric: "approve",
      message: "approve this shift report",
    });

    return await withLog(this.logger, "approve_work_unit_shift_report", { reportId }, async () => {
      const outcome = await this.workUnitReportWriterRepository.closeShiftReport({
        reportId,
        closedBy: actor.subject,
        closedByName: actor.name,
      });

      switch (outcome.kind) {
        case "not_found":
          throw new HTTPException(404, { message: "report not found" });
        case "already_closed":
          getShiftReportTransitionConflictsCounter().add(1, { to: "closed" });
          this.logger.withMetadata({ reportId }).warn("shift_report_already_closed");
          // Worded for an operator, not for a log: app.onError puts this string
          // straight into the response envelope.
          throw new HTTPException(409, { message: "shift report is already closed" });
        case "closed":
          getShiftReportTransitionsCounter().add(1, { to: "closed", source: "operator" });
          return outcome.approval;
      }
    });
  }

  // closed -> open. The mirror of the above, and thin for the same reason.
  //
  //   not_found    -> 404, and NOT counted, by the rule above.
  //   already_open -> 409, and COUNTED. Same argument as already_closed: the
  //                   browser offered Reopen on a report that was not closed,
  //                   which is a stale cache the server answers perfectly
  //                   correctly. One counter for both conflicts, labelled by
  //                   direction, rather than two — the transition is the
  //                   interesting dimension, and a second counter would have to
  //                   be summed with the first to answer "how stale are our
  //                   pages".
  //   reopened     -> 200, counted with to_status 'open'.
  //
  // ROLE-GATED BY ITS OWN VARIABLE, REOPEN_ROLE, and that separation is the whole
  // reason §34 ships three variables rather than one.
  //
  // The comment this replaces made the argument and could not act on it:
  // "anyone may sign off" is defensible, "anyone may undo somebody else's
  // sign-off" is a different claim. One shared role would have forced those two
  // claims to be the same, in code, permanently — so the distinction is expressed
  // where it can actually be configured. A realm can now grant approve widely and
  // reopen narrowly, which is the arrangement the sentence was reaching for.
  //
  // Still OFF when unset, like the other two. The original ungated ship was
  // deliberate and remains defensible: the alternative was blocking the downtime
  // edit's freeze on a Keycloak role that did not exist, leaving an operator
  // unable to correct a mistake at all.
  async reopenShiftReport(reportId: number, actor: Actor): Promise<ShiftReportApproval> {
    requireRole(actor, this.operatorRoles.reopen, {
      metric: "reopen",
      message: "reopen this shift report",
    });

    return await withLog(this.logger, "reopen_work_unit_shift_report", { reportId }, async () => {
      const outcome = await this.workUnitReportWriterRepository.reopenShiftReport({
        reportId,
        closedBy: actor.subject,
        closedByName: actor.name,
      });

      switch (outcome.kind) {
        case "not_found":
          throw new HTTPException(404, { message: "report not found" });
        case "already_open":
          getShiftReportTransitionConflictsCounter().add(1, { to: "open" });
          this.logger.withMetadata({ reportId }).warn("shift_report_already_open");
          throw new HTTPException(409, { message: "shift report is already open" });
        case "reopened":
          getShiftReportTransitionsCounter().add(1, { to: "open", source: "operator" });
          return outcome.approval;
      }
    });
  }

  // Steps [1]-[4] of the chain below, which two callers now need.
  //
  // EXTRACTED WHEN THE SECOND CALLER ARRIVED, which is this file's own rule
  // rather than a preference: SHIFT_WINDOWS moved to shared/ the moment a second
  // module needed it, for the reason that a second copy of shift arithmetic is an
  // ARITHMETIC divergence — a stop straddling 23:00 attributed by one caller and
  // not the other. That failure renders a plausible screen instead of throwing.
  // getMetricsStaleness asks about exactly the same stops getActivity does, so
  // the two must not be able to disagree about which those are.
  //
  //   [1] getReportScope(id)                       404 if absent, as siblings do
  //   [2] timeZoneResolver.resolve("work-unit", …)  normally a Map hit
  //   [3] resolveBusinessDate(date, tz)             the downtime window is keyed
  //                                                 on the business DAY, not the
  //                                                 shift-start instant
  //   [4] getShiftWindow(day, shift, tz)            one statement of this
  //                                                 arithmetic, in shared/
  //
  // Steps [3] and [4] are two round trips a denormalised `business_date` column
  // would collapse to zero — TODOS.md §17, the same tax getPerformance pays.
  private async resolveShiftScope(
    reportId: number,
  ): Promise<{ scope: ReportScope; timeZone: string; window: ShiftWindow }> {
    const scope = await this.workUnitReportReaderRepository.getReportScope(reportId);
    if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

    const timeZone = await this.timeZoneResolver.resolve("work-unit", scope.workUnitId);

    // A guard, not a cast. A report carrying a shift the window table does not
    // know about would otherwise reach SHIFT_WINDOWS as "4", destructure to
    // three undefineds, and come back as a window Postgres built from NULL — an
    // empty range that silently matches no stops. A shift report with no
    // downtime is a completely plausible screen, so nothing would look wrong.
    //
    // 500 rather than 400: the value came out of a report row, not off the URL.
    const shift = toShiftId(scope.shift);
    if (shift === undefined) {
      throw new HTTPException(500, { message: `report has unknown shift ${scope.shift}` });
    }

    const businessDate = await this.workUnitReportReaderRepository.resolveBusinessDate(
      scope.date,
      timeZone,
    );
    const window = await this.workUnitReportReaderRepository.getShiftWindow(
      businessDate,
      shift,
      timeZone,
    );

    return { scope, timeZone, window };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics staleness
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Whether an operator has moved a stop's CATEGORY since the pipeline computed
  // this report's aggregates — reported as the instant it happened, never as a
  // verdict. MetricsStaleness carries the argument for why there is no boolean.
  //
  // NO METRICS, by getActivity's rule: this is asked on every detail page view,
  // so a counter here would fire on 100% of requests and say nothing.
  //
  // It runs over the SAME stop set as the downtime arm of getActivity, which is
  // what resolveShiftScope and the repository's shared shiftStops fragment exist
  // to guarantee. If they diverged, the Log Activity panel would list a category
  // edit that this endpoint did not think had happened, and both screens would
  // look entirely reasonable.
  async getMetricsStaleness(reportId: number): Promise<MetricsStaleness> {
    return await withLog(
      this.logger,
      "work_unit_shift_report_staleness",
      { reportId },
      async () => {
        const { scope, window } = await this.resolveShiftScope(reportId);

        const categoryEditedAt = await this.workUnitReportReaderRepository.getCategoryEditedAt({
          workUnitId: scope.workUnitId,
          from: window.from,
          to: window.to,
        });

        return { categoryEditedAt };
      },
    );
  }

  // THE SAME QUESTION AT DAY AND MONTH GRAIN — TODOS §50, the half that was still
  // missing after the activity feed shipped.
  //
  // `work_unit_day_reports` and `work_unit_month_reports` roll up the same time a
  // shift report does, so an operator moving a stop's category makes them stale in
  // exactly the same way, and until now only the shift screen said so. The two
  // coarse screens quietly disagreed with an edit the operator had just made.
  //
  // NO NEW SQL, and that is the point of how the shift version was written: the
  // repository's `shiftStops` fragment is expressed as a WINDOW, and
  // `getPeriodWindow` produces one for any grain. So this is the same
  // `getCategoryEditedAt` over a wider pair of instants.
  //
  // TWO ROUND TRIPS FEWER than its shift sibling, for the reason getPeriodReport
  // has: 0013 put `business_date` and `time_zone` on the row, so there is no
  // mes-master-data call and no instant to reduce through a zone.
  //
  // 404 ON AN UNRESOLVABLE WINDOW rather than a null answer. A report whose
  // business_date the pipeline never wrote (§46) has no window, and "no category
  // edit" is the reassuring answer — the one thing this endpoint must not say
  // when it does not know.
  async getPeriodMetricsStaleness(grain: PeriodGrain, reportId: number): Promise<MetricsStaleness> {
    return await withLog(
      this.logger,
      `work_unit_${grain}_report_staleness`,
      { reportId },
      async () => {
        const scope = await this.workUnitReportReaderRepository.getPeriodReportScope(
          grain,
          reportId,
        );
        if (scope === undefined) throw new HTTPException(404, { message: "report not found" });
        if (scope.businessDate === null || scope.timeZone === null) {
          throw new HTTPException(404, { message: "report has no resolvable window" });
        }

        const window = await this.workUnitReportReaderRepository.getPeriodWindow(
          grain,
          scope.businessDate,
          scope.timeZone,
        );

        const categoryEditedAt = await this.workUnitReportReaderRepository.getCategoryEditedAt({
          workUnitId: scope.workUnitId,
          from: window.from,
          to: window.to,
        });

        return { categoryEditedAt };
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // The report's audit trail
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Three sources, merged newest-first. TWO OF THEM CANNOT PRODUCE A ROW TODAY,
  // and saying so precisely is what `sources` is for — see ShiftActivity.
  //
  //   [1] resolveShiftScope(id)                   404 if absent, and the shift
  //                                                window, shared with
  //                                                getMetricsStaleness
  //   [2] Promise.all(approval arm, downtime arm)  no shared inputs
  //   [3] merge, sort, build the three sources
  //
  // THE MERGE IS HERE AND NOT IN SQL. A UNION ALL would force both arms to
  // project identical columns — approval rows carrying null jsonb, downtime rows
  // carrying a null from_status — which is precisely the shape the discriminated
  // union exists to avoid.
  //
  // NO METRICS, and that is a decision rather than an omission. Every counter in
  // this service exists because an empty payload is indistinguishable from a
  // correct one; here the emptiness is stated on the wire, per arm, and it will
  // be empty for every report for months by design. A counter that fires on 100%
  // of requests is noise.
  async getActivity(reportId: number): Promise<ShiftActivity> {
    return await withLog(this.logger, "work_unit_shift_report_activity", { reportId }, async () => {
      const { scope, timeZone, window } = await this.resolveShiftScope(reportId);

      // THE BUSINESS DAY, because a quality entry is keyed on one where the two
      // arms above key on an instant. `scope.date` is the shift's START INSTANT
      // (0003), so the calendar day only falls out of it through the plant's
      // zone — the resolver that already exists for exactly this.
      const businessDate = await this.workUnitReportReaderRepository.resolveBusinessDate(
        scope.date,
        timeZone,
      );

      const [transitions, downtime, quality] = await Promise.all([
        this.workUnitReportReaderRepository.listApprovalTransitions({
          workUnitId: scope.workUnitId,
          date: scope.date,
          shift: scope.shift,
        }),
        this.workUnitReportReaderRepository.listShiftDowntimeHistory({
          workUnitId: scope.workUnitId,
          from: window.from,
          to: window.to,
        }),
        // ACROSS A MODULE BOUNDARY through the Awilix seam, as the downtime
        // service already does for this module's reader. See
        // listActivityForMachine for why a MACHINE feed carries entries whose
        // quantity lands on the LINE.
        this.qualityEntryRepository.listActivityForMachine(
          scope.workUnitId,
          businessDate,
          scope.shift,
        ),
      ]);

      // Ids are PREFIXED because the two arms come from two tables with
      // independent bigserials. Unprefixed, "41" from each would collide and
      // React would reuse the wrong row's DOM node.
      const entries: ActivityEntry[] = [
        ...transitions.map((t) => ({
          kind: "approval" as const,
          id: `approval:${t.id}`,
          at: t.at,
          by: t.by,
          byName: t.byName,
          fromStatus: t.fromStatus,
          toStatus: t.toStatus,
          source: t.source,
          // Null at this grain: there is exactly one shift report in the feed and
          // labelling every row with it would be noise.
          shift: null,
        })),
        ...downtime.entries.map((e) => ({
          kind: "downtime" as const,
          id: `downtime:${e.id}`,
          at: e.changedAt,
          by: e.changedBy,
          sourceEventId: e.sourceEventId,
          field: e.field,
          oldValue: e.oldValue,
          newValue: e.newValue,
        })),
        ...quality.map((q) => ({
          kind: "quality" as const,
          id: `quality:${String(q.id)}`,
          // The ENTRY's instant, not the void's: one action, one row.
          at: new Date(q.enteredAt),
          by: q.enteredBy,
          byName: q.enteredByName,
          entryKind: q.kind,
          enteredQty: q.enteredQty,
          enteredUomCode: q.enteredUomCode,
          targetQty: q.targetQty,
          targetUomCode: q.targetUomCode,
          productName: q.productName,
          reasonName: q.reasonName,
          // Null at this grain, like the approval arm's: the feed covers one
          // shift and labelling every row with it would be noise.
          shift: null,
          voidedAt: q.voidedAt === null ? null : new Date(q.voidedAt),
          voidedBy: q.voidedBy,
          voidedByName: q.voidedByName,
          voidReason: q.voidReason,
        })),
      ];

      // One total order across both arms. Each arm already arrives sorted by
      // (at DESC, id DESC), but interleaving them needs a re-sort.
      //
      // SORTED ON `at` ALONE, AND TIES ARE LEFT TO SORT STABILITY. That is
      // deliberate, and the obvious tie-break is a trap: `id` is a PREFIXED
      // STRING here ("approval:41"), so comparing two of them is lexicographic —
      // "approval:9" sorts after "approval:41" — which would silently INVERT an
      // arm's own correct id ordering for entries sharing an instant. Comparing
      // across arms is meaningless anyway, since the two tables have independent
      // sequences.
      //
      // Array.prototype.sort is stable (ES2019+), so equal timestamps keep the
      // order they were pushed in: each arm's own ORDER BY survives intact, and
      // an approval precedes a downtime edit recorded in the same instant.
      // Arbitrary between arms, but deterministic — which is what a chronology
      // needs.
      entries.sort((a, b) => b.at.getTime() - a.at.getTime());

      return {
        timeZone,
        entries,
        sources: [
          APPROVAL_SOURCE,
          downtimeSource(downtime.totalMembers, downtime.trackedMembers),
          // TRACKED SINCE PART 3, where this was the constant QUALITY_SOURCE
          // saying reject and rework "are produced by the data pipeline and
          // cannot be edited here". That stopped being true when an operator
          // could record one against a machine.
          //
          // Zero is a REAL answer — nobody entered a reject on this machine this
          // shift — so `tracked` is unconditionally true rather than
          // `quality.length > 0`, which would report a quiet shift as an
          // unimplemented feature.
          {
            kind: "quality" as const,
            tracked: true,
            untrackedReason: null,
            totalMembers: quality.length,
            trackedMembers: quality.length,
          },
        ],
      };
    });
  }

  // The per-SKU output breakdown for one shift report.
  //
  // Two things make this the odd one out in this service. It is the only read
  // spanning two Gold tables — the repository joins oee.product_count_wu_shift to
  // the report row, so the caller sends an id and nothing downstream has to agree
  // with anything about dates or shift numbering. And it needs NO mes-master-data
  // call at all: product and UOM labels are denormalised onto the row, so there is
  // no enrichment Map, no degraded-with-nulls path, and no `outcome="degraded"`
  // counter to emit.
  //
  // What it does have is the opposite problem — an answer that is indistinguishable
  // from a correct one:
  //
  //   no such report      -> 404. NOT counted: a bad id is a bad request, not a
  //                          data gap, and counting it would drown the signal below.
  //   report ran no SKUs  -> 200 []. This is the one that lies: the card renders
  //                          the same "no product output" message a genuinely idle
  //                          machine earns. Counted.
  //   [n items]           -> 200. Row count recorded, because the endpoint is
  //                          unpaged on the assumption that one machine runs a
  //                          handful of SKUs a shift.
  //
  // Three steps, and the order is forced: the product rows are keyed by BUSINESS
  // DAY while the report stores a shift-start INSTANT, so reducing one to the other
  // needs the plant's zone — which needs the work unit — which lives on the report.
  //
  //   [1] goldDb.getReportScope ──SQL─▶ workUnitId       404 if absent
  //   [2] timeZoneResolver.resolve ──HTTP─▶ IANA zone    normally a Map lookup
  //   [3] goldDb.listProductCount ──SQL─▶ rows
  async getProductCounts(reportId: number): Promise<ShiftProductCounts> {
    return await withLog(this.logger, "product_count_wu_shift", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getReportScope(reportId);
      // Matches getShiftReport above: the sibling endpoint 404s this id, so this
      // one must not answer 200 for it.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const timeZone = await this.timeZoneResolver.resolve("work-unit", scope.workUnitId);

      // Concurrent, and the watermark is a SEPARATE statement rather than a join
      // onto the rows — because a joined watermark vanishes when no rows match,
      // and no rows is exactly the case it exists to explain.
      const [items, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.listProductCount(reportId, timeZone),
        this.workUnitReportReaderRepository.getProductCountWatermark(),
      ]);

      if (items.length === 0) {
        getProductCountEmptyCounter().add(1);
        this.logger.withMetadata({ reportId, loadedThrough }).warn("product_count_empty");
        return { items, timeZone, loadedThrough };
      }

      getProductCountRowsHistogram().record(items.length);
      return { items, timeZone, loadedThrough };
    });
  }

  // The hourly performance profile behind the Losses card's View button.
  //
  // Four steps. The first three are getProductCounts' pipeline for the same
  // reason — the fact rows are keyed by BUSINESS DAY while the report stores a
  // shift-start INSTANT, and bridging them needs the plant's zone, which needs the
  // work unit, which lives on the report:
  //
  //   [1] goldDb.getReportScope       ──SQL─▶ workUnitId + shift + date   404 if absent
  //   [2] timeZoneResolver.resolve    ─HTTP─▶ IANA zone                   normally a Map lookup
  //   [3] goldDb.resolveBusinessDate  ──SQL─▶ 'YYYY-MM-DD'
  //   [4] goldDb.listPerfHours + getPerfWatermark  ──SQL─▶ buckets, watermark
  //
  // Step [4] runs its two queries CONCURRENTLY. They share no inputs, and the
  // watermark is most needed exactly when the bucket query returns nothing — so
  // making it wait on that result would add a round trip to the slowest path.
  //
  // NOTHING IS DERIVED HERE. No rate, no average. Both are ratios, and the correct
  // value at any grain is a ratio of sums rather than a mean of per-bucket ratios;
  // computing them here as well as in the browser would create two places for that
  // subtlety to be got wrong differently. See lib/perf-hourly.ts.
  //
  // An empty result is NOT an error and not a 404. `loadedThrough` is what makes it
  // legible: the browser compares it against the report's business day and says
  // "not loaded yet" or "no product output", instead of drawing an empty chart that
  // reads as a flawless shift. That is TODOS.md §8 and §14's failure, closed on
  // this surface before it shipped rather than after.
  async getPerformance(reportId: number): Promise<ShiftPerformance> {
    return await withLog(this.logger, "product_perf_wu_hour", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getReportScope(reportId);
      // Matches getShiftReport and getProductCounts: the sibling endpoints 404 this
      // id, so this one must not answer 200 for it.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const timeZone = await this.timeZoneResolver.resolve("work-unit", scope.workUnitId);

      const businessDate = await this.workUnitReportReaderRepository.resolveBusinessDate(
        scope.date,
        timeZone,
      );

      const [buckets, loadedThrough] = await Promise.all([
        // One business day and one shift. The day and month grains pass a wider
        // range and omit the shift; see ListPerfHoursInput.
        this.workUnitReportReaderRepository.listPerfHours({
          workUnitId: scope.workUnitId,
          dateFrom: businessDate,
          dateTo: businessDate,
          shift: scope.shift,
        }),
        this.workUnitReportReaderRepository.getPerfWatermark(),
      ]);

      if (buckets.length === 0) {
        getPerfHourEmptyCounter().add(1);
        this.logger.withMetadata({ reportId, businessDate, loadedThrough }).warn("perf_hour_empty");
      } else {
        getPerfHourPointsHistogram().record(buckets.length);
      }

      return { timeZone, buckets, loadedThrough };
    });
  }

  // The Quality Loss Pareto's payload.
  //
  // ONE STEP SHORTER THAN getPerformance and one longer than getProductCounts.
  // Like the SKU read, the business-day conversion happens inside the SQL, so
  // there is no resolveBusinessDate round trip — the rows are keyed on
  // shift_date and the join reduces the report's start instant to it. Like the
  // performance read, the response is an OBJECT carrying the zone and the
  // watermark, because a bucket cannot state either about itself.
  //
  // THE WATERMARK IS LOAD-BEARING HERE IN A WAY IT IS NOWHERE ELSE.
  // oee.reject_count_wu_shift ships empty by design (contract §1 rule 2 — this
  // service never inserts), so an empty result is the normal answer for every
  // shift until the DAG runs. Without `loadedThrough` the tab would report every
  // one of them as a shift with no rejects, which is the flattering reading and
  // the wrong one.
  async getRejectReasons(reportId: number): Promise<RejectReasonBreakdown> {
    return await withLog(this.logger, "reject_count_wu_shift", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getReportScope(reportId);
      // Matches getShiftReport, getProductCounts and getPerformance: the sibling
      // endpoints 404 this id, so this one must not answer 200 for it.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const timeZone = await this.timeZoneResolver.resolve("work-unit", scope.workUnitId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.aggregateRejectReasons(reportId, timeZone),
        this.workUnitReportReaderRepository.getRejectWatermark(),
      ]);

      if (aggregate.buckets.length === 0) {
        getRejectReasonEmptyCounter().add(1);
        this.logger.withMetadata({ reportId, loadedThrough }).warn("reject_reason_empty");
      } else {
        getRejectReasonGroupsHistogram().record(aggregate.buckets.length);
      }

      return { timeZone, ...aggregate, loadedThrough };
    });
  }

  // The Others tab's payload: how many times each downtime reason occurred.
  //
  // getRejectReasons' pipeline exactly — getReportScope (404 if absent), resolve
  // the plant zone, then the aggregate and the watermark CONCURRENTLY. No
  // resolveBusinessDate round trip, because the join does the conversion in SQL:
  // the rows are keyed on a business day and the report stores a shift-start
  // instant.
  //
  // WHAT MAKES THIS ONE DIFFERENT FROM EVERY OTHER READ ON THE LOSSES PAGE: its
  // source is IMMUTABLE. oee.downtime_reports is the operator-mutable table and
  // this endpoint does not touch it, so these bars do not move when a downtime is
  // edited. That is the product decision behind the tab, and the repository test
  // pinning the SQL is where it is enforced rather than described.
  //
  // NOTHING IS DERIVED HERE, and the rule matters more than usual. In particular
  // `totalOccurrences` is not summed from the buckets and `totalEvents` is not
  // computed from anything: both come back from SQL over the same rows the bars
  // came from, which is what makes the bars sum to their own denominator. Summing
  // them here would turn that guarantee into an assumption, and `totalEvents` is
  // not derivable from the buckets at all — an event citing three reasons appears
  // in three of them.
  //
  // THE WATERMARK IS LOAD-BEARING, for the reason it is on /rejects:
  // oee.downtime_log_events ships empty (contract §1 rule 2, §3.9), so an empty
  // result is the normal answer for every shift until the DAG runs. Without
  // `loadedThrough` the tab would report every one of them as a shift nothing
  // stopped.
  async getDowntimeEventReasons(reportId: number): Promise<DowntimeEventBreakdown> {
    return await withLog(this.logger, "downtime_log_events", { reportId }, async () => {
      const scope = await this.workUnitReportReaderRepository.getReportScope(reportId);
      // Matches its four sibling endpoints: they 404 this id, so this one must not
      // answer 200 for it.
      if (scope === undefined) throw new HTTPException(404, { message: "report not found" });

      const timeZone = await this.timeZoneResolver.resolve("work-unit", scope.workUnitId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.workUnitReportReaderRepository.aggregateDowntimeEventReasons(reportId, timeZone),
        this.workUnitReportReaderRepository.getDowntimeEventWatermark(),
      ]);

      if (aggregate.buckets.length === 0) {
        getDowntimeEventEmptyCounter().add(1);
        this.logger.withMetadata({ reportId, loadedThrough }).warn("downtime_event_empty");
      } else {
        getDowntimeEventGroupsHistogram().record(aggregate.buckets.length);
      }

      return { timeZone, ...aggregate, loadedThrough };
    });
  }

  // Stage [1]. Returns `emptyPage` rather than an empty id list so the caller
  // cannot confuse "no filter" with "filter that matches nothing".
  private async resolveWorkUnitIds(
    workCenterId: number | undefined,
  ): Promise<{ workUnitIds?: number[]; emptyPage: boolean }> {
    if (workCenterId === undefined) return { emptyPage: false };

    // THROUGH THE SERVICE, NOT THE CLIENT, so this is cached — TODOS §58, whose
    // remaining half this closes. The line paths that prompted that cache stopped
    // needing it (they scope by work_center_id), and this became its only caller:
    // a filter interaction that used to make one round trip per page now makes one
    // per five minutes.
    //
    // NO try/catch, unlike the second call below. `listWorkUnitIds` wraps a
    // cold-cache failure in `upstreamUnavailable` itself, using the operation string
    // passed here — so catching and re-wrapping would double-wrap an HTTPException
    // and lose nothing. The message an operator reads is unchanged.
    const units = await this.masterDataService.listWorkUnitIds(
      workCenterId,
      "resolve the work center filter",
    );

    if (units.length > 0) {
      return { workUnitIds: units.map((u) => u.id), emptyPage: false };
    }

    // No units came back. That is either an empty work center or a work center
    // that does not exist, and those must not look the same to the caller.
    let exists: boolean;
    try {
      exists = await this.masterDataClient.existsWorkCenter(workCenterId);
    } catch (err) {
      throw upstreamUnavailable(err, "verify the work center");
    }

    if (!exists) throw new HTTPException(404, { message: "work center not found" });

    return { emptyPage: true };
  }

  // Stage [3]. Never throws: enrichment is best-effort by design.
  private async enrich<T extends { workUnitId: number }>(items: T[]): Promise<Enriched<T>[]> {
    if (items.length === 0) return [];

    const ids = [...new Set(items.map((row) => row.workUnitId))];

    let byId: Map<number, WorkUnitWithCenter>;
    try {
      const { found } = await this.masterDataClient.findAllWorkUnitByWorkUnitIds(ids);
      // A Map, not `found.find(...)` inside the map below — that would be
      // O(rows x units), which at a 100-row page is 10k comparisons per request.
      byId = new Map(found.map((unit) => [unit.id, unit]));
    } catch (err) {
      // The degraded path. It returns HTTP 200, so the counter below is the ONLY
      // signal that labels are missing — without it a permanently broken
      // master-data link looks exactly like working software.
      getMasterDataRequestsCounter().add(1, {
        operation: "findAllWorkUnitByWorkUnitIds",
        outcome: "degraded",
      });
      this.logger
        .withMetadata({
          event: "work_unit_enrichment_degraded",
          work_unit_ids: ids.length,
          ...(isMasterDataError(err) ? err.toMetadata() : { master_data_cause: "unknown" }),
        })
        .warn("work_unit_enrichment_degraded");

      byId = new Map();
    }

    const zoneById = await this.resolveZones(ids);

    return items.map((row) =>
      toEnriched(row, byId.get(row.workUnitId), zoneById.get(row.workUnitId) ?? null),
    );
  }

  // Zones for one page, by distinct work unit — the same fan-out shape the label
  // enrichment above uses, and for the same reason: a page of 100 rows is a handful
  // of distinct machines, and the resolver is normally a Map lookup behind a 15-min
  // LRU with single-flight and a stale fallback.
  //
  // Degrades rather than throws, exactly like the labels beside it. `resolve` throws
  // only when a zone was never known at all; a list that renders its metrics with an
  // unformatted date beats a 503 for the whole page. A null zone leaves the row's
  // date unreadable to the client, which is the honest outcome — the alternative is
  // guessing UTC and rendering a wrong day that looks right.
  private async resolveZones(ids: number[]): Promise<Map<number, string>> {
    const resolved = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await this.timeZoneResolver.resolve("work-unit", id)] as const;
        } catch {
          // The resolver has already counted and logged this against
          // time_zone_resolutions_total{outcome="failed"} — no second signal needed.
          return undefined;
        }
      }),
    );

    return new Map(resolved.filter((entry): entry is [number, string] => entry !== undefined));
  }
}

// A row whose work unit upstream no longer knows about still renders its
// metrics, with both labels null. `workCenter` is null whenever the work unit is
// missing OR the work unit exists but belongs to no work center.
// Generic over the row, so the shift, day and month lists share one statement of
// what "enriched" means. They differ only in the measures they carry, and the
// three fields added here are identical in all three — a second copy would be a
// second place for the degraded-master-data shape to drift.
function toEnriched<T extends { workUnitId: number }>(
  row: T,
  unit: WorkUnitWithCenter | undefined,
  timeZone: string | null,
): Enriched<T> {
  const { workUnitId: _workUnitId, ...metrics } = row;

  return {
    ...metrics,
    timeZone,
    workCenter: unit?.workCenter ?? null,
    workUnit: unit === undefined ? null : { id: unit.id, code: unit.code, name: unit.name },
  } as Enriched<T>;
}

type Enriched<T extends { workUnitId: number }> = Omit<T, "workUnitId"> & {
  timeZone: string | null;
  workCenter: { id: number; code: string; name: string } | null;
  workUnit: { id: number; code: string; name: string } | null;
};

// CALENDAR ARITHMETIC IN JS, INSTANT ARITHMETIC IN POSTGRES — the split
// work-center-service.ts makes and which product-report-service.ts and
// area-report-service.ts both repeat. A business day is a LABEL, so adding one to
// it is date arithmetic with no zone in it; anything that needs an INSTANT goes
// through AT TIME ZONE in SQL, where the offset is resolved for that date.
// Getting the split backwards is how a month becomes 743 or 745 hours instead of
// 744 — shared/shift-window.ts's header sets that out.
//
// `T00:00:00Z` and getUTC* keep it in UTC end to end, so a server running in a
// negative offset cannot roll the date backwards on the way through.
//
// A FIFTH COPY OF `addDay` AND A THIRD OF `addMonth`, and they stay that way for
// the reason area-report-service.ts states beside its own: three lines each with
// no policy in them, against a shared helper coupling five modules that must not
// import each other's internals. If either ever needs to know about a grain, that
// is the moment to move it.
function addDay(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

// `setUTCMonth` HANDLES THE LENGTHS AND THE YEAR BOUNDARY, which is the whole
// reason it is used rather than `+ 30 days`: a month is 28 to 31 days, and
// December rolls the year. A month report's `business_date` is the first of the
// month, so the result is always the first of the next one.
function addMonth(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString().slice(0, 10);
}

export { WorkUnitReportService };
export type {
  TWorkUnitReportService,
  PagedWorkUnitShiftReportResult,
  PagedWorkUnitShiftReportFilter,
  PagedWorkUnitPeriodReportResult,
  PagedWorkUnitPeriodReportFilter,
};
