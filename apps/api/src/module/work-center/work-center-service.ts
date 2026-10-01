import { HTTPException } from "hono/http-exception";

import { buildPageMeta } from "@molca/network";
import { withLog, type Logger } from "@molca/utils";
import { baseLogger, getRequestContext } from "@molca/observability";

import { requireRole } from "../../shared/actor.js";
import {
  DAY_START_HOUR,
  resolveReportWindow,
  resolveShiftWindow,
  toShiftId,
} from "../../shared/shift-window.js";
import { getWatermark } from "../../shared/database/watermark.js";
import {
  getShiftReportTransitionConflictsCounter,
  getShiftReportTransitionsCounter,
} from "../../shared/observability/metrics.js";

import type { OeeTrend } from "../../shared/oee-trend.js";
import type {
  LineMachineList,
  LineWindow,
  LineActivity,
  LineActivityEntry,
  LineActivityWindow,
  LineActivitySource,
  LineShiftPerformance,
  LineShiftKey,
  PagedWorkCenterReportResult,
  CoarseGrain,
  ReportGrain,
  WorkCenterReport,
  WorkCenterReportFilter,
} from "./work-center.js";
import type { QualityEntry } from "../quality-entry/quality-entry.js";
import type { QualityEntryReader } from "../quality-entry/quality-entry-repository.js";
import type { WorkCenterReportReader, WorkCenterReportWriter } from "./work-center-repository.js";
import type { Actor } from "../../shared/actor.js";
import type { OperatorRoles } from "../../shared/config/config.js";
import type { GoldDB } from "../../shared/database/postgres.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";
import type { ProductCountItem } from "../../shared/product-count.js";
import type { MasterDataServiceContract } from "../master-data/master-data-service.js";

type WorkCenterReportServiceDeps = {
  workCenterReportReaderRepository: WorkCenterReportReader;
  workCenterReportWriterRepository: WorkCenterReportWriter;
  // FOR THE ACTIVITY FEED's third arm only. Injected across a module boundary
  // through the Awilix seam the downtime service already uses for
  // workUnitReportReaderRepository — and reciprocally, since quality-entry
  // injects this module's writer for the freeze. Both directions are
  // registrations rather than imports of another module's internals, which is
  // what the rule in shared/README.md is actually about.
  qualityEntryRepository: QualityEntryReader;
  // NO LONGER READ BY THIS SERVICE AT ALL, and kept registered on purpose.
  //
  // Five paths here used to resolve the line's roster through it. None do: every
  // table they scope carries work_center_id (see LineShiftKey), so the whole module
  // makes zero upstream calls again — which is what work-center-service's opening
  // paragraph claimed all along and was briefly untrue.
  //
  // The dependency stays because removing it would take the Cradle entry with it,
  // and the next thing this module needs from master-data — a line's machine ROSTER
  // as opposed to the machines that reported, which is a genuinely different
  // question (contract §16.5) — would have to add it back. work-center-service.test.ts
  // asserts it is never called.
  masterDataService: MasterDataServiceContract;
  operatorRoles: OperatorRoles;
  goldDb: GoldDB;
  logger?: Logger;
};

type TWorkCenterReportService = {
  getPagedReport: (
    grain: ReportGrain | CoarseGrain,
    page: number,
    size: number,
    filter: WorkCenterReportFilter,
  ) => Promise<PagedWorkCenterReportResult>;
  getReport: (grain: ReportGrain | CoarseGrain, reportId: number) => Promise<WorkCenterReport>;
  getApprovalSummary: (reportId: number) => Promise<LineApprovalSummary>;
  approveLineShift: (reportId: number, actor: Actor) => Promise<LineApprovalSummary>;
  reopenLineShift: (reportId: number, actor: Actor) => Promise<LineApprovalSummary>;
  getActivity: (grain: ReportGrain, reportId: number) => Promise<LineActivity>;
  getMetricsStaleness: (reportId: number) => Promise<{ categoryEditedAt: Date | null }>;
  getProductCounts: (grain: ReportGrain, reportId: number) => Promise<LineProductCounts>;
  // SHIFT AND DAY ONLY — the month's equivalent is an hour-of-DAY profile below,
  // and the two payloads genuinely differ. The handler enforces which grain
  // reaches which; the types leave `grain` wide because ReportGrain is the
  // module's vocabulary and narrowing it here would be a fourth grain type.
  getPerformance: (grain: ReportGrain, reportId: number) => Promise<LineShiftPerformance>;
  getHourProfile: (reportId: number) => Promise<LineShiftPerformance>;
  // Month only, like getHourProfile above and for a plainer reason: a shift and a
  // day have no days inside them to trend.
  getMonthOeeTrend: (reportId: number) => Promise<OeeTrend>;
  // TWO NAMED METHODS RATHER THAN ONE TAKING A GRAIN — there is no day-grain
  // answer, so a grain argument would admit a third call with no table behind it.
  getYearOeeTrend: (reportId: number) => Promise<OeeTrend>;
  getMachines: (grain: ReportGrain, reportId: number) => Promise<LineMachineList>;
  getRejectReasons: (
    grain: ReportGrain | CoarseGrain,
    reportId: number,
  ) => Promise<LineRejectBreakdown>;
  getDowntimeEventReasons: (
    grain: ReportGrain,
    reportId: number,
  ) => Promise<LineDowntimeEventBreakdown>;
};

// SKU View's payload. `loadedThrough` is the whole reason it is an object rather
// than a bare array: the 0016 tables ship EMPTY until Airflow fills them, so "no
// rows" is the normal answer today and this is the only thing that separates it
// from "this line produced nothing". TODOS §14.
type LineProductCounts = {
  items: ProductCountItem[];
  timeZone: string;
  loadedThrough: string | null;
};

type LineRejectBreakdown = RejectAggregate & {
  timeZone: string;
  loadedThrough: string | null;
};

type LineDowntimeEventBreakdown = DowntimeEventAggregate & {
  timeZone: string;
  loadedThrough: string | null;
};

// WHAT THE STATUS TILE RENDERS, and why it carries a third field.
//
// `machinesFound` counts the machine shift reports that EXIST for this line's
// business date and shift. `workUnitCount` is what the pipeline recorded on the
// line row — the machines that reported into its numbers. They should agree, and
// they diverge when a machine is re-parented upstream between the DAG run and now.
//
// WHEN THEY DISAGREE THE SCREEN MUST ABSTAIN rather than pick one. "4 of 5
// approved" over the wrong five is a fraction that cannot be supported, and this
// grain's whole convention — nullable rates, nullable counts, a NULL unit meaning
// "the members disagreed" — is to say so instead of rounding it off.
type LineApprovalSummary = {
  machinesFound: number;
  machinesClosed: number;
  // From the line row. Null when the two disagree is NOT how this is expressed —
  // the caller compares the two numbers, which keeps both visible.
  workUnitCount: number;
};

// The Line report list service.
//
// IT IS THIN, AND THE THINNESS IS THE POINT — read this before adding a
// dependency to it.
//
// A work_unit report page is a three-stage pipeline across two systems:
//
//   [1] workCenterId given? -> masterData.findAllWorkUnitByWorkCenterId  FATAL
//   [2] goldDb.paginateShiftReport                                          SQL
//   [3] distinct(workUnitIds) -> masterData.findAllWorkUnitByWorkUnitIds  DEGRADES
//
// A work_center report page is stage [2] and nothing else:
//
//   [1] gone   work_center_id IS the grain key, so the filter is a plain SQL
//              predicate. There is no id list to resolve, and therefore no
//              upstream call that could fail the request.
//   [3] gone   work_center_name, work_center_code, area_name and time_zone are
//              all COLUMNS on the row (migration 0014), so there is nothing to
//              enrich. This is the direction 0013 already moved the day/month
//              DETAIL path in — "0013 put the column on the row, so it is
//              selected. That removes a mes-master-data call from the detail path
//              entirely." Adding one back on a NEW screen would be moving
//              backwards.
//
// The two machine counts are columns for the same reason and one more: resolving
// the line's roster at read time would be one upstream call per line per page —
// the N+1 TODOS §3 names — on a screen that is otherwise two SQL statements.
// docs/gold-write-contract.md §16.5 asks the pipeline for it instead.
//
// THE READ PATH STILL MAKES NO UPSTREAM CALL, AND THAT IS WORTH CHECKING RATHER
// THAN ASSUMING, because this module now HAS a masterDataClient — the line
// APPROVAL needs the roster, since work_unit_shift_reports carries no
// work_center_id. The split is:
//
//   getPagedReport, getReport        zero HTTP calls. Every field is a column.
//   getApprovalSummary, approve,     ONE roster call each, and the reason the
//   reopen, getActivity              summary is a separate route rather than a
//                                    field on the detail payload: the browser
//                                    AWAITS the report and only prefetches this.
//
// So the master-data instruments in shared/observability/metrics.ts DO apply to
// this module now, on the write path only, and work-center-service.test.ts asserts
// that the two reads above still touch nothing. "A read with no new metric" is the
// design here; a read that grows one is a regression.
class WorkCenterReportService implements TWorkCenterReportService {
  private workCenterReportReaderRepository: WorkCenterReportReader;
  private workCenterReportWriterRepository: WorkCenterReportWriter;
  private qualityEntryRepository: QualityEntryReader;
  private masterDataService: MasterDataServiceContract;
  private operatorRoles: OperatorRoles;
  private goldDb: GoldDB;
  private fallbackLogger: Logger;

  constructor({
    workCenterReportReaderRepository,
    workCenterReportWriterRepository,
    qualityEntryRepository,
    masterDataService,
    operatorRoles,
    goldDb,
    logger,
  }: WorkCenterReportServiceDeps) {
    this.workCenterReportReaderRepository = workCenterReportReaderRepository;
    this.workCenterReportWriterRepository = workCenterReportWriterRepository;
    this.qualityEntryRepository = qualityEntryRepository;
    this.masterDataService = masterDataService;
    this.operatorRoles = operatorRoles;
    this.goldDb = goldDb;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  async getPagedReport(
    grain: ReportGrain | CoarseGrain,
    page: number,
    size: number,
    filter: WorkCenterReportFilter,
  ): Promise<PagedWorkCenterReportResult> {
    // The grain is IN the event name rather than in the context, so the three
    // grains are separable in a log query without a filter expression — the same
    // fix commit eb6d6ac made for the day and month emissions.
    return await withLog(this.logger, `paged_work_center_${grain}_report`, filter, async () => {
      const limit = size;
      const offset = (page - 1) * limit;

      const { items, totalElements } = await this.workCenterReportReaderRepository.paginateReport({
        grain,
        limit,
        offset,
        filter,
      });

      // No short-circuit for an unknown work center, unlike the work_unit lists.
      // Theirs exists because `workUnitIds: []` would be dropped downstream as "no
      // filter" and return every machine's rows instead of none. Here the
      // predicate always filters and an unknown id simply matches nothing, so an
      // empty page is the honest answer and needs no special case.
      return { items, meta: buildPageMeta(page, size, totalElements) };
    });
  }

  // One line report, every measure — the detail screen.
  //
  // 404 RATHER THAN AN EMPTY BODY, which is the opposite call from the LIST on
  // this same module. WorkCenterReportFilter explains why the list answers
  // 200-empty for an unknown line: there is no id list to be dropped as "no
  // filter", so an unknown id honestly matches nothing. A DETAIL request names ONE
  // row; if it is not there the id is wrong, and 200 with a null body would make
  // the browser render an empty report page instead of its not-found state.
  //
  // STILL ZERO UPSTREAM CALLS. Everything the screen needs is a column on the row
  // (0014/0015), which is why the thinness argument above survives this endpoint
  // intact — the one thing that WOULD have needed mes-master-data, the approval
  // summary, is a separate route for exactly that reason.
  async getReport(grain: ReportGrain | CoarseGrain, reportId: number): Promise<WorkCenterReport> {
    return await withLog(
      this.logger,
      `detail_work_center_${grain}_report`,
      { reportId },
      async () => {
        const found = await this.workCenterReportReaderRepository.getReport(grain, reportId);
        if (!found) throw new HTTPException(404, { message: "report not found" });

        return found;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // The line approval — one click, N machine shift reports
  // ---------------------------------------------------------------------------

  // Everything the two writes, the status tile, the activity feed and the banner
  // share: the line's identity and its shift window.
  //
  // NO UPSTREAM CALL, AND THAT IS A CORRECTION. This resolved the line's roster
  // through mes-master-data until it turned out not to need to:
  // oee.work_unit_shift_reports.work_center_id has been NOT NULL since 0003, and
  // the pipeline owner confirmed every work unit has a work center (contract
  // §16.10 Q6). The premise for the call — "that column does not exist" — was
  // simply wrong, and it put a FATAL HTTP dependency on a write path.
  //
  // Scoping by the column is also the BETTER DEFINITION rather than merely the
  // cheaper one; LineShiftKey sets out why.
  //
  // The window comes from resolveShiftWindow — SQL, AT TIME ZONE, resolved for that
  // date. Never `from + 8 hours`: eight wall-clock hours across a DST transition is
  // seven or nine real ones.
  private async resolveLineShift(reportId: number): Promise<{
    key: LineShiftKey;
    workUnitCount: number;
    timeZone: string;
    businessDate: string;
  }> {
    const report = await this.workCenterReportReaderRepository.getReport("shift", reportId);
    if (!report) throw new HTTPException(404, { message: "report not found" });
    if (report.shift === null) {
      // Unreachable through the shift table, which declares the column NOT NULL.
      // Kept as a guard rather than a non-null assertion because what it protects
      // is an approval attributed to the wrong shift.
      throw new HTTPException(404, { message: "report not found" });
    }

    // toShiftId narrows a number to the "1" | "2" | "3" that SHIFT_WINDOWS is keyed
    // by. ck_wcsr_shift already constrains the column to 1..3, so this cannot fire
    // — but the alternative is a non-null assertion, and what it would be asserting
    // is that an approval lands on the right shift.
    const shiftId = toShiftId(report.shift);
    if (shiftId === undefined) {
      throw new HTTPException(404, { message: "report not found" });
    }

    const window = await resolveShiftWindow(
      this.goldDb,
      report.businessDate,
      shiftId,
      report.timeZone,
    );

    return {
      // The quality arm of the activity feed keys on this rather than on the
      // instant window: an entry is shift-keyed by construction (0017) and has no
      // instant to fall inside.
      businessDate: report.businessDate,
      key: {
        workCenterId: report.workCenterId,
        from: window.from,
        to: window.to,
        shift: report.shift,
      },
      workUnitCount: report.workUnitCount,
      timeZone: report.timeZone,
    };
  }

  // The Status tile's payload. ITS OWN ROUTE, not a field on the detail response,
  // because it needs the roster and the roster is NOT cached — MasterDataService
  // holds a StaleCache for areas, work centers, reasons and actions, and this call
  // goes straight through the client. The browser AWAITS the detail request and
  // merely prefetches this one, so the cost lands where it can be absorbed.
  //
  // That is metrics-staleness's precedent exactly: "the detail page's loader
  // AWAITS the report, so anything folded into that query blocks the whole screen."
  async getApprovalSummary(reportId: number): Promise<LineApprovalSummary> {
    return await withLog(this.logger, "line_shift_approval_summary", { reportId }, async () => {
      const { key, workUnitCount } = await this.resolveLineShift(reportId);
      const outcome = await this.workCenterReportWriterRepository.summariseLineShift(key);

      return { ...outcome, workUnitCount };
    });
  }

  // open -> closed, for every machine on the line that is still open.
  //
  // Gated BEFORE anything else, so a refusal never calls mes-master-data, never
  // opens a transaction and never emits a transition metric — a 403 is not a
  // conflict and must not land in the same series as one.
  //
  //   no machine reports  -> 404. There is nothing to sign.
  //   all already closed  -> 409, and COUNTED, for the reason the machine path
  //                          counts it: the browser offered Approve on a line that
  //                          was already approved, which is a stale page the
  //                          server answers perfectly correctly.
  //   some open           -> 200. It closes ONLY those, which is what the button
  //                          offers on a partially approved line.
  async approveLineShift(reportId: number, actor: Actor): Promise<LineApprovalSummary> {
    requireRole(actor, this.operatorRoles.approveLine, {
      metric: "approve_line",
      message: "approve this line shift report",
    });

    return await withLog(this.logger, "approve_line_shift_report", { reportId }, async () => {
      const { key, workUnitCount } = await this.resolveLineShift(reportId);
      const before = await this.workCenterReportWriterRepository.summariseLineShift(key);

      if (before.machinesFound === 0) {
        throw new HTTPException(404, { message: "no machine reports for this line shift" });
      }
      if (before.machinesClosed === before.machinesFound) {
        getShiftReportTransitionConflictsCounter().add(1, { to: "closed" });
        this.logger.withMetadata({ reportId }).warn("line_shift_report_already_closed");
        throw new HTTPException(409, { message: "every machine on this line is already approved" });
      }

      const outcome = await this.workCenterReportWriterRepository.closeLineShift({
        ...key,
        closedBy: actor.subject,
        closedByName: actor.name,
      });

      // ONE COUNT PER MACHINE ACTUALLY CLOSED, not one per line. The series then
      // means the same thing whichever screen the approval came from, which is
      // what lets the existing dashboard keep working rather than under-reporting
      // a line click as a single transition.
      getShiftReportTransitionsCounter().add(outcome.machinesClosed - before.machinesClosed, {
        to: "closed",
        source: "operator",
      });

      return { ...outcome, workUnitCount };
    });
  }

  // closed -> open, across the same set. Its own role variable, for the reason
  // §34 gives: withdrawing a whole line's sign-off is not what granting one permits.
  async reopenLineShift(reportId: number, actor: Actor): Promise<LineApprovalSummary> {
    requireRole(actor, this.operatorRoles.reopenLine, {
      metric: "reopen_line",
      message: "reopen this line shift report",
    });

    return await withLog(this.logger, "reopen_line_shift_report", { reportId }, async () => {
      const { key, workUnitCount } = await this.resolveLineShift(reportId);
      const before = await this.workCenterReportWriterRepository.summariseLineShift(key);

      if (before.machinesFound === 0) {
        throw new HTTPException(404, { message: "no machine reports for this line shift" });
      }
      if (before.machinesClosed === 0) {
        getShiftReportTransitionConflictsCounter().add(1, { to: "open" });
        this.logger.withMetadata({ reportId }).warn("line_shift_report_already_open");
        throw new HTTPException(409, { message: "no machine on this line is approved" });
      }

      const outcome = await this.workCenterReportWriterRepository.reopenLineShift({
        ...key,
        closedBy: actor.subject,
        closedByName: actor.name,
      });

      getShiftReportTransitionsCounter().add(before.machinesClosed - outcome.machinesClosed, {
        to: "open",
        source: "operator",
      });

      return { ...outcome, workUnitCount };
    });
  }

  // ---------------------------------------------------------------------------
  // The activity feed
  // ---------------------------------------------------------------------------
  //
  // ALL THREE GRAINS, and the two coarse ones were a PRODUCT question rather than
  // a technical one. TODOS §60 held them open on the density argument — a line day
  // feed reports ~3N machine-shift transitions, "which may be a log rather than a
  // feed" — and the answer, once the other three subjects had shipped theirs, is
  // that it is a feed: a MACHINE day feed already reports its three child shifts'
  // transitions, and an AREA day feed spans three shifts AND N lines. What makes
  // the density readable is the LABEL, which is why both event arms now carry a
  // shift as well as a machine at the coarse grains.
  //
  // ONE IMPLEMENTATION, THREE GRAINS, and almost nothing in it branches:
  //
  //   approval   the ONLY read that changed. Its join is scoped by
  //              `machineReports`, whose `AND r.shift = $n` is now conditional.
  //   downtime   UNCHANGED. It was already expressed as a [from, to) instant
  //              window and never read the shift at all — which is why §60 said
  //              this was a handler rather than new SQL, and it was right.
  //   quality    the RANGE variant `listActivityForTarget`, which the SKU day feed
  //              already proved. An entry is shift-keyed (0017) and has no instant
  //              to fall inside, so this arm reads business DATES where the two
  //              above read instants.
  //
  // TODOS §52 EXPECTED THE APPROVAL ARM TO BE EMPTY. It said the arm would be
  // "honestly empty at line grain", because the events table is keyed
  // (work_unit_id, date, shift) and a line has no work_unit_id. The cascade
  // changed that premise: a line approval IS N machine approvals, so its
  // transitions are real events and each one names the machine it moved.
  //
  // `sources` carries what each arm could ever show, per arm, rather than one
  // "tracked" flag for the payload. That distinction is the whole reason an empty
  // feed here is readable: a stop with no source_event_id cannot carry a trail at
  // all, and saying so is different from saying nothing happened.
  async getActivity(grain: ReportGrain, reportId: number): Promise<LineActivity> {
    return await withLog(this.logger, `activity_line_${grain}_report`, { reportId }, async () => {
      const { window, instants } = await this.resolveActivityWindow(grain, reportId);

      const [transitions, downtime, machinesFound, quality] = await Promise.all([
        this.workCenterReportReaderRepository.listApprovalTransitions(instants),
        this.workCenterReportReaderRepository.listDowntimeEdits(instants),
        // THE APPROVAL ARM'S MEMBER COUNT, through the same fragment that arm's
        // join reads — so the panel cannot report "3 of 12" over a join that
        // looked at 9. This replaced a call to the WRITER's summariseLineShift,
        // which requires a shift because a cascade does; see countMachineReports.
        this.workCenterReportReaderRepository.countMachineReports(instants),
        // ACROSS A MODULE BOUNDARY, through the Awilix seam the downtime service
        // already uses for workUnitReportReaderRepository. The alternative is a
        // copy of the ledger's query here, and a feed that disagreed with the
        // ledger it reports on would be worse than no feed.
        //
        // THE RANGE VARIANT AT EVERY GRAIN, not `listActivity` at shift grain and
        // this at the others. `resolveLineWindow` already produces a half-open
        // date range with the shift narrowing beside it — which at shift grain is
        // exactly what the collapsed helper would have built — so one call serves
        // three grains and there is no branch to get backwards.
        this.qualityEntryRepository.listActivityForTarget({
          workCenterId: window.workCenterId,
          dateFrom: window.dateFrom,
          dateTo: window.dateTo,
          // The shift at shift grain, null at the other two, straight off the
          // report row.
          shift: window.shift,
          // Every SKU on the line: this feed reports what happened on the LINE,
          // and an entry belongs in it whichever product it named.
          productId: null,
        }),
      ]);

      // NULL THE SHIFT LABEL AT SHIFT GRAIN, on both arms that carry one. The
      // column is always known — the repository projects it and a quality entry is
      // shift-keyed — so this is not a data question but a DISPLAY one: a feed
      // covering one shift that labels every row with it is noise, and the browser
      // renders the suffix whenever the field is a number. Exactly the convention
      // the machine feed's approval arm has carried since §50.
      const labelShift = grain !== "shift";

      const entries: LineActivityEntry[] = [
        ...transitions.map((t) =>
          t.kind === "approval" && !labelShift ? { ...t, shift: null } : t,
        ),
        ...downtime.entries,
        ...quality.map((entry) => toQualityActivity(entry, labelShift)),
      ];

      // Sorted on `at` alone, leaving ties to sort stability. `id` is a PREFIXED
      // STRING here, so comparing two of them is lexicographic and would invert an
      // arm's own correct ordering for entries sharing an instant.
      //
      // IT MATTERS MORE AT THE COARSE GRAINS, because the approval arm arrives as
      // ~3N rows spanning three shifts: without this sort the panel would read as
      // shift 1's whole day, then shift 2's, which looks like a chronology and is
      // not.
      entries.sort((a, b) => b.at.getTime() - a.at.getTime());

      const sources: LineActivitySource[] = [
        {
          kind: "approval",
          tracked: true,
          untrackedReason: null,
          // The machine shift reports this report's window covers — every one of
          // them can carry a transition, so the two numbers are equal. N at shift
          // grain, ~3N at day grain, ~90N at month grain.
          totalMembers: machinesFound,
          trackedMembers: machinesFound,
        },
        {
          kind: "downtime",
          // ZERO MEMBERS IS NOT AN UNTRACKED ARM, and this arm read
          // `trackedMembers > 0` until the coarse grains shipped. The sentence
          // behind "no-stable-id" is "these downtime records carry no stable
          // identifier" — a claim about records, and a false one when there are
          // none: the truth is that nothing stopped.
          //
          // TODOS §60 filed the correction and said it was left alone because it
          // is "a visible copy change on a shipped screen". That argument expired
          // with this change rather than being overruled: the day and month feeds
          // are NEW screens, so shipping them with the wrong sentence and fixing
          // it later is two visible changes instead of one. The SKU and area feeds
          // have always read it this way.
          tracked: downtime.totalMembers === 0 || downtime.trackedMembers > 0,
          // "no-stable-id", NOT "not-implemented", and the same string the machine
          // feed uses — the browser's NOT_TRACKED_BODY is a TOTAL map over these
          // values, so an invented one renders a blank sentence. The write path
          // exists; what is missing is a source_event_id to hang a trail from,
          // which is a truer answer.
          untrackedReason:
            downtime.totalMembers > 0 && downtime.trackedMembers === 0 ? "no-stable-id" : null,
          totalMembers: downtime.totalMembers,
          trackedMembers: downtime.trackedMembers,
        },
        // TRACKED SINCE PART 3, where it read `not-implemented`. This service now
        // owns the write (0017), so every entry that exists carries a full trail
        // and the two counts are equal by construction — unlike the downtime arm,
        // whose members can lack a source_event_id to hang a trail from.
        //
        // ZERO IS A REAL ANSWER HERE, not an absence: no reject was entered by
        // hand on this period. That is why `tracked` is unconditionally true rather
        // than `quality.length > 0` — the latter would report a quiet shift, or a
        // quiet month, as an unimplemented feature.
        {
          kind: "quality",
          tracked: true,
          untrackedReason: null,
          totalMembers: quality.length,
          trackedMembers: quality.length,
        },
      ];

      return { timeZone: window.timeZone, entries, sources };
    });
  }

  // THE FEED'S TWO WINDOWS, resolved once from one report row.
  //
  // Both are needed and they are not interchangeable — LineActivityWindow's own
  // comment says why. The approval and downtime arms scope by INSTANTS (an approval
  // event is keyed on the shift report's start instant; a stop occupies a span of
  // them), while the quality arm scopes by BUSINESS DATES plus an optional shift,
  // because an entry is shift-keyed by construction and has no instant to fall
  // inside.
  //
  // BOTH COME OFF THE SAME `resolveLineWindow` CALL, which is the point of it being
  // one method: the date range and the instants are two readings of one report row,
  // and resolving them separately is how a feed ends up listing a downtime edit
  // from a day the quality arm did not cover.
  //
  // `instantWindow` puts the arithmetic in Postgres through resolveReportWindow —
  // never `dateFrom + 07:00` in JS. Eight wall-clock hours across a DST transition
  // is seven or nine real ones, and a calendar month is 743 or 745.
  private async resolveActivityWindow(
    grain: ReportGrain,
    reportId: number,
  ): Promise<{ window: LineWindow; instants: LineActivityWindow }> {
    const window = await this.resolveLineWindow(grain, reportId);
    const { from, to } = await this.instantWindow(grain, window);

    return {
      window,
      instants: { workCenterId: window.workCenterId, from, to, shift: window.shift },
    };
  }

  // THE STALE-METRICS BANNER, at line grain — TODOS §50, one subject wider.
  //
  // A line's aggregates are precomputed by the pipeline exactly as a machine's
  // are, so an operator moving a stop's CATEGORY leaves this screen's OEE tiles,
  // timeline strip and waterfall showing the pre-edit split. The machine screen
  // has warned about that since the edit path shipped; this one did not.
  //
  // ITS OWN ROUTE, not a field on the detail payload, for the two reasons the
  // approval summary is: it scans the window's stops, and the browser AWAITS the
  // report while only prefetching this. Folding it in would put that scan on the
  // blocking path of every page view for a banner absent on almost all of them.
  //
  // Over the SAME stop set the activity feed's downtime arm uses — both go through
  // resolveLineShift and the same roster-and-window pair. If they diverged, the
  // THE YEAR'S MONTHLY CURVE — the month sibling one grain up, and the ONE
  // difference that matters is the watermark: this plots MONTH rows, so the day
  // table's freshness says nothing about it.
  async getYearOeeTrend(reportId: number): Promise<OeeTrend> {
    return await withLog(this.logger, "work_center_year_oee_trend", { reportId }, async () => {
      const report = await this.workCenterReportReaderRepository.getReport("year", reportId);
      // The sibling endpoints 404 this id, so this one must not answer 200.
      if (!report) throw new HTTPException(404, { message: "report not found" });

      const [items, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.listYearOeeTrend(reportId),
        getWatermark(this.goldDb, "work_center_month_reports"),
      ]);

      return { items, timeZone: report.timeZone, loadedThrough };
    });
  }

  // Log Activity panel would list a category edit this endpoint did not think had
  // happened, and both screens would look entirely reasonable.
  async getMetricsStaleness(reportId: number): Promise<{ categoryEditedAt: Date | null }> {
    return await withLog(this.logger, "line_shift_report_staleness", { reportId }, async () => {
      const { key } = await this.resolveLineShift(reportId);
      const categoryEditedAt = await this.workCenterReportReaderRepository.getCategoryEditedAt(key);

      return { categoryEditedAt };
    });
  }

  // ---------------------------------------------------------------------------
  // Part 2's four sub-resources
  // ---------------------------------------------------------------------------

  // The window all four share, resolved ONCE per request from the line report's
  // own row — so none of them can disagree about which rows belong to this report.
  //
  // NO UPSTREAM CALL. `business_date` and `time_zone` are columns on every
  // work_center_* row (0014), so unlike the machine shift path there is nothing to
  // resolve through mes-master-data and no instant to reduce through a zone.
  //
  // The DATE range is half-open and never zero-width, including at shift grain —
  // see LineWindow. The INSTANT window is a different thing and is resolved
  // separately, by the one caller that renders it.
  private async resolveLineWindow(
    grain: ReportGrain | CoarseGrain,
    reportId: number,
  ): Promise<LineWindow> {
    const report = await this.workCenterReportReaderRepository.getReport(grain, reportId);
    if (!report) throw new HTTPException(404, { message: "report not found" });

    // THE GRAIN DECIDES EXACTLY ONE THING HERE — the exclusive end — which is what
    // let the year grain reuse this whole read path. `addYear` handles the leap
    // year for `addMonth`'s reason: a fixed day count is wrong roughly one year in
    // four, and the failure is a Pareto missing its last day rather than an error.
    const dateTo =
      grain === "year"
        ? addYear(report.businessDate)
        : grain === "month"
          ? addMonth(report.businessDate)
          : addDay(report.businessDate);

    return {
      workCenterId: report.workCenterId,
      dateFrom: report.businessDate,
      dateTo,
      shift: report.shift,
      timeZone: report.timeZone,
    };
  }

  // SKU View.
  //
  // EMPTY UNTIL THE PIPELINE WRITES THE 0016 TABLES, and the watermark is what
  // makes that legible: with no watermark row the card says "not loaded yet"
  // rather than "this line produced nothing". Those are opposite claims about the
  // same empty card and only one of them is true today. TODOS §14.
  //
  // THE DAY TABLE'S WATERMARK ANSWERS FOR THE MONTH GRAIN, because the day table
  // is what a month read widens over — there is deliberately no
  // product_count_wc_month.
  async getProductCounts(grain: ReportGrain, reportId: number): Promise<LineProductCounts> {
    return await withLog(this.logger, `product_count_wc_${grain}`, { reportId }, async () => {
      const window = await this.resolveLineWindow(grain, reportId);

      const [items, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.listProductCount(grain, window),
        getWatermark(
          this.goldDb,
          grain === "shift" ? "product_count_wc_shift" : "product_count_wc_day",
        ),
      ]);

      return { items, timeZone: window.timeZone, loadedThrough };
    });
  }

  // THE HOURLY TRENDLINE, shift and day grain.
  //
  // 24 BUCKETS ON AN INSTANT, where the month route below returns 24 hour-of-DAY
  // buckets on a clock hour. Two routes because the PAYLOADS genuinely differ —
  // the machine pair splits the same way and for the reason AGENTS.md gives: one
  // path returning two shapes is the thing a caller gets wrong once and works
  // around forever.
  //
  // SHIPS EMPTY. oee.product_perf_wc_hour (0018) has no rows until Airflow fills
  // it, so `loadedThrough` is null and the chart says "not loaded yet" rather than
  // drawing a flat line at zero on a line that ran all shift. That is §14's ladder
  // again, and the reason the watermark travels with the buckets.
  async getPerformance(grain: ReportGrain, reportId: number): Promise<LineShiftPerformance> {
    return await withLog(this.logger, `performance_wc_${grain}`, { reportId }, async () => {
      const window = await this.resolveLineWindow(grain, reportId);

      const [buckets, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.listPerfHours(window),
        this.workCenterReportReaderRepository.getPerfWatermark(),
      ]);

      return { buckets, timeZone: window.timeZone, loadedThrough, dayStartHour: DAY_START_HOUR };
    });
  }

  // The MONTH's hour-of-day profile.
  //
  // ORDERED FROM THE PLANT'S DAY START rather than from midnight, because shift 3
  // runs 23:00 -> 07:00 and a 0..23 ordering puts the day's first hour last. The
  // start hour comes from SHIFT_WINDOWS, which is the one place that arithmetic
  // lives — a literal here would be a second copy of it.
  async getHourProfile(reportId: number): Promise<LineShiftPerformance> {
    return await withLog(this.logger, "hour_profile_wc_month", { reportId }, async () => {
      const window = await this.resolveLineWindow("month", reportId);

      const [buckets, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.listHourProfile(window, DAY_START_HOUR),
        this.workCenterReportReaderRepository.getPerfWatermark(),
      ]);

      return { buckets, timeZone: window.timeZone, loadedThrough, dayStartHour: DAY_START_HOUR };
    });
  }

  // Machine View.
  //
  // ZERO UPSTREAM CALLS AT EVERY GRAIN. All three work_unit_* report tables carry
  // work_center_id — the shift table since 0003, the other two since 0013 — so the
  // read is a plain predicate. An earlier draft of this method fetched the line's
  // roster at shift grain and documented that as an unavoidable asymmetry; it was
  // neither, and LineShiftKey records the premise that was wrong.
  async getMachines(grain: ReportGrain, reportId: number): Promise<LineMachineList> {
    return await withLog(this.logger, `machines_wc_${grain}`, { reportId }, async () => {
      const window = await this.resolveLineWindow(grain, reportId);
      // The instants first, because the read needs them — `date` is what scopes
      // the machine rows, not `business_date` (§46: nullable and unbackfilled).
      const instants = await this.instantWindow(grain, window);
      const machines = await this.workCenterReportReaderRepository.listMachineBreakdown(
        grain,
        window,
        instants,
      );

      return { timeZone: window.timeZone, ...instants, machines };
    });
  }

  // The Start/End pair the card renders, as INSTANTS.
  //
  // Through resolveReportWindow, which is the one statement of this arithmetic and
  // the same function the timeline and the approval cascade go through — so the
  // three cannot disagree about when a shift began. Never `dateFrom + 07:00` in
  // JS: eight wall-clock hours across a DST transition is seven or nine real ones.
  private async instantWindow(
    grain: ReportGrain,
    window: LineWindow,
  ): Promise<{ from: Date; to: Date }> {
    const shiftId = window.shift === null ? undefined : toShiftId(window.shift);
    const resolved = await resolveReportWindow(
      this.goldDb,
      grain,
      window.dateFrom,
      shiftId,
      window.timeZone,
    );
    return { from: resolved.from, to: resolved.to };
  }

  // The Losses page's Quality Loss tab, over the line's machines. The arithmetic —
  // including the mixed-unit abstain, which fires far more often here than at
  // machine grain — is shared/loss-aggregate.ts's and is untouched.
  // The month's daily OEE curve, behind the OEE Performance dashboard's trend
  // chart. NO METRIC INSTRUMENT — see the machine module's twin for why that
  // asymmetry is a decision rather than an oversight.
  //
  // `oee` IS NULLABLE ON THIS TABLE, unlike the machine's, and the payload keeps
  // the null rather than coalescing it. A line whose month could not be composed
  // is not a line that scored zero, and 0014's two-unit rule is the reason the
  // distinction survives all the way to the chart.
  async getMonthOeeTrend(reportId: number): Promise<OeeTrend> {
    return await withLog(this.logger, "work_center_month_oee_trend", { reportId }, async () => {
      // Resolves the window purely for its time zone and its 404 — the repository
      // reads the span off the month row itself.
      const window = await this.resolveLineWindow("month", reportId);

      const [items, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.listMonthOeeTrend(reportId),
        getWatermark(this.goldDb, "work_center_day_reports"),
      ]);

      return { items, timeZone: window.timeZone, loadedThrough };
    });
  }

  async getRejectReasons(
    grain: ReportGrain | CoarseGrain,
    reportId: number,
  ): Promise<LineRejectBreakdown> {
    return await withLog(this.logger, `reject_wc_${grain}`, { reportId }, async () => {
      const window = await this.resolveLineWindow(grain, reportId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.aggregateRejectReasons(window),
        // THE LINE'S TABLE (0019), not the machines'. Reading the machine
        // watermark here would report the Pareto as loaded whenever the MACHINE
        // rejects had loaded — which is precisely the confusion the two tables
        // exist to separate.
        getWatermark(this.goldDb, "reject_count_wc_shift"),
      ]);

      return { ...aggregate, timeZone: window.timeZone, loadedThrough };
    });
  }

  // The Losses page's Others tab, on the same terms.
  async getDowntimeEventReasons(
    grain: ReportGrain,
    reportId: number,
  ): Promise<LineDowntimeEventBreakdown> {
    return await withLog(this.logger, `downtime_events_wc_${grain}`, { reportId }, async () => {
      const window = await this.resolveLineWindow(grain, reportId);

      const [aggregate, loadedThrough] = await Promise.all([
        this.workCenterReportReaderRepository.aggregateDowntimeEventReasons(window),
        getWatermark(this.goldDb, "downtime_log_events"),
      ]);

      return { ...aggregate, timeZone: window.timeZone, loadedThrough };
    });
  }
}

// Date arithmetic on a plain 'YYYY-MM-DD', in JS rather than SQL — the one place
// in this service that is true, and it is deliberate.
//
// These produce the EXCLUSIVE end of a business-DATE range, which is a calendar
// question with no zone in it: the day after 2026-08-09 is 2026-08-10 in every
// plant on earth. The instant arithmetic that genuinely needs a zone — when that
// day STARTS — stays in Postgres, in resolveReportWindow, where AT TIME ZONE
// resolves the offset for that date and a DST boundary comes out right.
//
// Getting that distinction backwards is how a month becomes 743 or 745 hours
// instead of 744; shared/shift-window.ts's header is where that is set out.
function addDay(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function addMonth(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString().slice(0, 10);
}

// The exclusive end of a YEAR's business-date range, from its first day.
//
// `setUTCFullYear` HANDLES THE LEAP YEAR, which is the reason it is used rather
// than `+ 365 days`: a year is 365 or 366 days. `ck_wcyr_year_start` guarantees the
// input is January 1, so the result is always January 1 of the next year.
//
// Built on a UTC instant and sliced back to a date, exactly as its two siblings
// are: these are business DATES with no zone in them, and constructing the Date
// locally would shift the boundary for any plant east or west of the server.
function addYear(businessDate: string): string {
  const next = new Date(`${businessDate}T00:00:00Z`);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next.toISOString().slice(0, 10);
}

// A ledger row as a feed entry.
//
// `id` IS PREFIXED, like the other two arms and for the same reason: three tables
// with independent bigserials would collide in React's keying, and the symptom is
// two entries sharing a row rather than an error.
//
// `labelShift` IS A DISPLAY DECISION AND NOTHING ELSE. The entry always knows its
// shift — it is part of the row's key (0017) — so this does not choose what to
// read, only whether the shift is worth SAYING. A feed covering one shift that
// labels every row with it is noise; a day or month feed that omits it leaves a
// rework, which names no machine, with no label at all. Passed rather than derived
// because a mapper has no idea what its caller's grain is, and a grain parameter
// here would invite it to start branching on more than one thing.
function toQualityActivity(entry: QualityEntry, labelShift: boolean): LineActivityEntry {
  return {
    kind: "quality",
    id: `quality-${String(entry.id)}`,
    // The ENTRY's instant, not the void's, so the feed orders by when the operator
    // acted. A void carries its own timestamp in the fields below and the browser
    // renders it as a second line on the same entry rather than as a second event
    // — one action, one row, which is how the downtime arm reads too.
    at: new Date(entry.enteredAt),
    by: entry.enteredBy,
    byName: entry.enteredByName,
    entryKind: entry.kind,
    enteredQty: entry.enteredQty,
    enteredUomCode: entry.enteredUomCode,
    targetQty: entry.targetQty,
    targetUomCode: entry.targetUomCode,
    productName: entry.productName,
    reasonName: entry.reasonName,
    workUnitId: entry.workUnitId,
    workUnitName: entry.workUnitName,
    shift: labelShift ? entry.shift : null,
    voidedAt: entry.voidedAt === null ? null : new Date(entry.voidedAt),
    voidedBy: entry.voidedBy,
    voidedByName: entry.voidedByName,
    voidReason: entry.voidReason,
  };
}

export { WorkCenterReportService };
export type {
  LineApprovalSummary,
  LineDowntimeEventBreakdown,
  LineProductCounts,
  LineRejectBreakdown,
  TWorkCenterReportService,
};
