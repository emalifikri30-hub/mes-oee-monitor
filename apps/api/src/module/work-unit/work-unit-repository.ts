import { asOperator, traced } from "../../shared/database/postgres.js";
// The header area picker's predicate. In shared/ because all four report subjects
// apply it — see area-scope.ts for what an absent id means and why a NULL
// `area_id` is excluded rather than counted.
import { areaScope } from "../../shared/area-scope.js";
// THE TWO LOSSES AGGREGATES LIVE IN shared/ NOW, because the LINE report's Losses
// page needed the identical arithmetic over a different row set. They were always
// parameterised by a Fragment, so the move changed no SQL — see loss-aggregate.ts.
import { aggregateEventPairs, aggregateRejectRows } from "../../shared/loss-aggregate.js";
// One watermark read for every table, in shared/ — see watermark.ts for what this
// value is load-bearing for and why four copies of it here was a quiet risk.
import { getWatermark } from "../../shared/database/watermark.js";
// The daily OEE curve under a month report. Shared on arrival rather than after a
// second caller: three subjects have both a month and a day table, so work-center
// and area read the identical statement over their own two — see oee-trend.ts.
import { listOeeTrend } from "../../shared/oee-trend.js";
import {
  MAX_OPEN_DOWNTIME_DAYS,
  resolveReportWindow,
  resolveShiftWindow,
  SHIFT_END_BOUNDS,
  type ShiftId,
  type ShiftWindow,
} from "../../shared/shift-window.js";

import type {
  ApprovalSource,
  ApprovalStatus,
  CloseShiftReportOutcome,
  ReopenShiftReportOutcome,
  ListWorkUnitPeriodReportInput,
  ListWorkUnitShiftReportInput,
  PagedWorkUnitPeriodReport,
  PeriodApprovalSummary,
  CoarseGrain,
  PeriodGrain,
  PeriodReportListRow,
  HourProfileBucket,
  PeriodReportScope,
  WorkUnitPeriodReportField,
  WorkUnitPeriodReportFilter,
  PagedWorkUnitShiftReport,
  PerfHourBucket,
  ProductCountItem,
  WorkUnitShiftReport,
  WorkUnitShiftReportFilter,
  ShiftReportListRow,
} from "./work-unit.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";
import type { OeeTrendPoint } from "../../shared/oee-trend.js";
import type { GoldDB } from "../../shared/database/postgres.js";
import type { Fragment } from "postgres";

type WorkUnitReportReader = {
  paginateShiftReport: (input: ListWorkUnitShiftReportInput) => Promise<PagedWorkUnitShiftReport>;
  // `timeZone` is the service's to attach — it comes from master data, not from
  // Gold — so the Omit is honest about what this query can actually produce.
  // It was previously typed as the full WorkUnitShiftReport, which claimed a
  // field the SELECT never asked for.
  getShiftReport: (id: number) => Promise<Omit<WorkUnitShiftReport, "timeZone"> | undefined>;
  // Approval state for a whole PAGE of reports, in ONE round trip.
  //
  // Separate from paginateShiftReport rather than joined into it, and the reason
  // for that has CHANGED — the old one is corrected here rather than deleted,
  // because it was the whole argument and a reader will come looking for it.
  //
  // It used to be that joining would mean aliasing oee.work_unit_shift_reports,
  // which makes every bare `shift` / `date` / `id` reference in periodFilter,
  // shiftSql, workUnitSql, hideZeroSql, the SELECT list and the ORDER BY ambiguous
  // at runtime — and fakeSql matches SQL TEXT without executing it, so the whole
  // unit suite would stay green while the hottest page in the app 500s.
  //
  // THE ALIAS NOW EXISTS. The server-side status filter (TODOS.md §36) had to
  // correlate a subquery against the report row, so the table is `r`, every
  // fragment is qualified, and each periodFilter branch has an integration case.
  // The hazard was real — the month-only branch qualified with the FULL TABLE NAME,
  // which an alias replaces outright — and it is paid.
  //
  // What keeps this a second query is now a trade rather than a hazard: one ~0.5 ms
  // round trip against a benchmarked 0.8 ms one, and FILTERING is a semi-join that
  // selects no columns while DISPLAYING needs the values. Folding it in became
  // possible with §36; nothing is asking for it.
  listApprovalsForPage: (keys: PageApprovalKey[]) => Promise<ApprovalByKey[]>;
  // The approval transitions of one report, newest first — the first arm of the
  // activity feed.
  listApprovalTransitions: (key: ShiftReportKey) => Promise<ApprovalTransitionRow[]>;
  listApprovalTransitionsInWindow: (input: {
    workUnitId: number;
    from: Date;
    to: Date;
  }) => Promise<PeriodApprovalTransitionRow[]>;
  // Every recorded edit to every stop in one shift — the second arm.
  //
  // Reads oee.downtime_report_history, which belongs to the downtime feature.
  // That is NOT a module boundary violation: this repository already reads
  // oee.downtime_log_events for the Others tab. What must not be duplicated is
  // the SHIFT WINDOW arithmetic, and it is not — SHIFT_WINDOWS moved to
  // shared/shift-window.ts so there is exactly one statement of it.
  listShiftDowntimeHistory: (input: ListShiftHistoryInput) => Promise<ShiftDowntimeHistory>;
  // When a stop in this shift last had its CATEGORY changed. Null means never,
  // and only `category` is asked about — see the method for why the other three
  // editable fields cannot make anything on screen stale.
  getCategoryEditedAt: (input: ListShiftHistoryInput) => Promise<Date | null>;
  // Every shift report one stop overlaps, with its approval status. The
  // downtime-edit freeze reads this through a narrow port rather than querying
  // the approvals table itself — see DowntimeApprovalReader in downtime.ts.
  listApprovalsOverlapping: (
    input: ListOverlappingApprovalsInput,
  ) => Promise<OverlappingApproval[]>;
  // The instant range one shift covers. Delegates to shared/shift-window.ts so
  // this and DowntimeReaderRepository.getWindow cannot disagree.
  getShiftWindow: (date: string, shift: ShiftId, timeZone: string) => Promise<ShiftWindow>;
  // Just enough of a report to resolve its time zone, which has to happen before
  // the product and performance queries can be built. `undefined` means there is
  // no such report.
  getReportScope: (id: number) => Promise<ReportScope | undefined>;
  // ── The coarse grains. One set of methods over both tables; see GRAIN_TABLE.
  paginatePeriodReport: (
    input: ListWorkUnitPeriodReportInput,
  ) => Promise<PagedWorkUnitPeriodReport>;
  getPeriodReport: (
    grain: CoarseGrain,
    id: number,
  ) => Promise<WorkUnitPeriodReportField | undefined>;
  // The day/month twin of getReportScope, and it needs no follow-up
  // mes-master-data call: 0013 put business_date and time_zone on the row.
  getPeriodReportScope: (grain: CoarseGrain, id: number) => Promise<PeriodReportScope | undefined>;
  listPeriodProductCount: (grain: PeriodGrain, reportId: number) => Promise<ProductCountItem[]>;
  // The coarse OEE curves, for the OEE Performance dashboard. TWO NAMED METHODS
  // RATHER THAN ONE TAKING A GRAIN, because there is no day-grain answer — a day
  // has no days inside it to trend — so a grain parameter would admit a third call
  // that has no table to read.
  listMonthOeeTrend: (reportId: number) => Promise<OeeTrendPoint[]>;
  listYearOeeTrend: (reportId: number) => Promise<OeeTrendPoint[]>;
  // oee.work_unit_day_reports' own watermark. Separate from the product-count one
  // because they are different tables written by different models.
  getDayReportWatermark: () => Promise<string | null>;
  // The MONTH table's watermark, for the YEAR curve. Its own method rather than a
  // reuse of the day one: a year trend reads month rows, so reporting the day
  // table's freshness beside it would claim a currency the curve does not have.
  getMonthReportWatermark: () => Promise<string | null>;
  listPerfHourProfile: (input: {
    workUnitId: number;
    dateFrom: string;
    dateTo: string;
    dayStartHour: number;
  }) => Promise<HourProfileBucket[]>;
  getPeriodWindow: (
    grain: CoarseGrain,
    businessDate: string,
    timeZone: string,
  ) => Promise<ShiftWindow>;
  // Counts the shift reports inside a window and how many are approved. NOT an
  // approval — see PeriodApprovalSummary.
  summariseApprovalsInWindow: (input: {
    workUnitId: number;
    from: Date;
    to: Date;
  }) => Promise<PeriodApprovalSummary>;
  listProductCount: (reportId: number, timeZone: string) => Promise<ProductCountItem[]>;
  resolveBusinessDate: (instant: Date, timeZone: string) => Promise<string>;
  listPerfHours: (input: ListPerfHoursInput) => Promise<PerfHourBucket[]>;
  getPerfWatermark: () => Promise<string | null>;
  // Takes the zone for the same reason listProductCount does: the rows are keyed
  // on a business day and the report stores a shift-start instant.
  aggregateRejectReasons: (reportId: number, timeZone: string) => Promise<RejectAggregate>;
  getRejectWatermark: () => Promise<string | null>;
  getProductCountWatermark: () => Promise<string | null>;
  // Takes the zone for the reason aggregateRejectReasons does, and the rows it
  // reads are keyed on the same business day.
  aggregateDowntimeEventReasons: (
    reportId: number,
    timeZone: string,
  ) => Promise<DowntimeEventAggregate>;
  aggregatePeriodRejectReasons: (grain: CoarseGrain, reportId: number) => Promise<RejectAggregate>;
  aggregatePeriodDowntimeEventReasons: (
    grain: PeriodGrain,
    reportId: number,
  ) => Promise<DowntimeEventAggregate>;
  getDowntimeEventWatermark: () => Promise<string | null>;
};

// The natural key of a shift report, and the ONLY way to address its approval.
//
// `date` is the shift-start instant, carried as a Date and compared with plain
// timestamptz equality. Not a business day — see 0010's header.
type ShiftReportKey = {
  workUnitId: number;
  date: Date;
  shift: number;
};

// One page row's approval state, keyed back to the report by id.
//
// `reportId` rides along so the service can merge without re-deriving the key,
// which would mean matching Dates by value and is a trap: two Date objects for
// the same instant are not `===`, so a naive Map keyed on the object silently
// matches nothing and every report renders as open.
type ApprovalByKey = {
  reportId: number;
  status: ApprovalStatus;
};

// The page lookup's input: the natural key plus the report id it belongs to.
// The id is carried THROUGH the query and back out rather than matched in
// TypeScript, because matching would mean comparing Date objects — and two Dates
// for the same instant are never `===`, so a Map keyed on one silently matches
// nothing and every report renders as open.
type PageApprovalKey = ShiftReportKey & { reportId: number };

// The same row plus the shift it belongs to, which only matters when a feed spans
// more than one of them.
type PeriodApprovalTransitionRow = ApprovalTransitionRow & { shift: number };

type ApprovalTransitionRow = {
  id: number;
  at: Date;
  // The KEYCLOAK SUBJECT — durable, and useless to read. NULL for a system
  // transition, which has no person behind it.
  by: string | null;
  // preferred_username as it was at the time. What a human should actually see,
  // and nullable because it is a label rather than an identity. Both travel,
  // for the reason 0010 stores both.
  byName: string | null;
  fromStatus: ApprovalStatus;
  toStatus: ApprovalStatus;
  source: ApprovalSource;
};

type ListShiftHistoryInput = {
  workUnitId: number;
  // The shift window, already resolved through the plant's zone.
  from: Date;
  to: Date;
};

// The same two-number shape ReasonHistory carries, and for the same reason:
// `entries: []` alone cannot distinguish "nobody edited these stops" from
// "none of these stops could ever have been edited". Today every row is in the
// second state for any stop the pipeline loaded, because it does not write
// oee.downtime_reports.source_event_id.
type ShiftDowntimeHistory = {
  entries: DowntimeHistoryRow[];
  totalMembers: number;
  trackedMembers: number;
};

type DowntimeHistoryRow = {
  id: number;
  sourceEventId: string;
  changedAt: Date;
  changedBy: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
};

// One stop's identity, as the freeze check needs to ask about it.
//
// `endAt` is null while a stop is still running, which is a normal state and the
// one the bound in listApprovalsOverlapping exists for. `timeZone` comes from
// master data, so it is passed in rather than read from Gold — the same
// arrangement listProductCount and aggregateRejectReasons already use.
type ListOverlappingApprovalsInput = {
  workUnitId: number;
  startAt: Date;
  endAt: Date | null;
  timeZone: string;
};

// A report the stop overlaps, and whether it is signed off. `status` is
// coalesced in SQL, so 'open' here can mean either an open row or no row at all
// — which 0010 says are the same thing.
type OverlappingApproval = ShiftReportKey & {
  status: ApprovalStatus;
};

// What aggregateRejectReasons returns: everything RejectReasonBreakdown carries
// except the two facts the repository has no business knowing — the plant's zone
// and the watermark, both of which the service attaches.
// The report's identity for time-zone purposes. Deliberately not the whole row:
// resolving a zone needs one column, and selecting forty to get it would invite
// the two reads to drift. `shift` and `date` ride along because the performance
// read needs the report's business day, which is `date` reduced through the zone
// that `workUnitId` resolves — three columns, still one round trip.
type ReportScope = {
  workUnitId: number;
  shift: number;
  date: Date;
};

// Deliberately a business-date RANGE plus an optional shift rather than a report
// id, because oee.product_perf_wu_hour answers three grains from one shape and
// only one of them has a report to anchor to:
//
//   shift  dateFrom = dateTo = the business day,  shift given
//   day    dateFrom = dateTo = the business day,  shift omitted
//   month  dateFrom..dateTo  = the month bounds,  shift omitted
//
// Only the shift grain has a screen today (TODOS.md §23). The other two are new
// handlers over this method, not a new query — and all three are served by
// ix_ppwuh_wu_day_shift as an ordered index scan with no sort node.
type ListPerfHoursInput = {
  workUnitId: number;
  dateFrom: string;
  dateTo: string;
  shift?: number;
};

type WorkUnitReportReaderRepositoryDeps = {
  goldDb: GoldDB;
};

const TABLE_WORK_UNIT_SHIFT_REPORT = "oee.work_unit_shift_reports";
const TABLE_PRODUCT_COUNT_WU_SHIFT = "oee.product_count_wu_shift";
const TABLE_PRODUCT_COUNT_WU_DAY = "oee.product_count_wu_day";
const TABLE_PRODUCT_PERF_WU_HOUR = "oee.product_perf_wu_hour";
const TABLE_WU_SHIFT_REPORT_APPROVALS = "oee.work_unit_shift_report_approvals";
const TABLE_WU_SHIFT_REPORT_APPROVAL_EVENTS = "oee.work_unit_shift_report_approval_events";
const TABLE_DOWNTIME_REPORT_HISTORY = "oee.downtime_report_history";
// Named here rather than in shared/loss-aggregate.ts: the aggregate reads
// whichever rows its fragment chose, so the table belongs to the caller that
// built the fragment. The line module names its own, and they differ.
const TABLE_REJECT_COUNT_WU_SHIFT = "oee.reject_count_wu_shift";
const TABLE_DOWNTIME_LOG_EVENTS = "oee.downtime_log_events";

// Which table each coarse grain lives in — the same idiom as SCOPE_COLUMN in
// downtime.ts, and here for the same reason: after 0013 the day and month tables
// differ by one column, so one set of methods reads both and a fix cannot be
// applied to one and forgotten on the other.
//
// Used for the traced() span name. The FROM clause itself comes from
// `grainFrom` below rather than from this map: postgres.js's `sql(identifier)`
// helper would render "oee.work_unit_day_reports" as a single quoted identifier
// including the dot, which is not the same table.
const GRAIN_TABLE = {
  day: "oee.work_unit_day_reports",
  month: "oee.work_unit_month_reports",
  year: "oee.work_unit_year_reports",
} as const;

// oee.etl_watermarks keys on the BARE table name, without the schema — the same
// spelling the pipeline stamps. GRAIN_TABLE's values are schema-qualified because
// they name a span for tracing, so the two cannot be shared.
const WATERMARK_WU_DAY_REPORTS = "work_unit_day_reports";
// The YEAR curve's source. `oee.work_unit_year_reports` has a watermark row of its
// own, but it is NOT this one — that row says how far the year TABLE is loaded,
// and what the curve needs is how far the MONTH rows it plots are.
const WATERMARK_WU_MONTH_REPORTS = "work_unit_month_reports";

// The detail SELECT projects the approval columns FLAT — postgres.js has no
// notion of a nested result — while WorkUnitShiftReport nests them under
// `approval`. This is that reshape, in one place.
//
// Split out rather than inlined so the row type can be stated: without it the
// generic on the query would have to lie about the shape coming back.
type ShiftReportRow = Omit<WorkUnitShiftReport, "timeZone" | "approval"> & {
  status: ApprovalStatus;
  closedAt: Date | null;
  closedBy: string | null;
  closedByName: string | null;
  source: ApprovalSource | null;
};

function toShiftReport(row: ShiftReportRow): Omit<WorkUnitShiftReport, "timeZone"> {
  const { status, closedAt, closedBy, closedByName, source, ...report } = row;
  return { ...report, approval: { status, closedAt, closedBy, closedByName, source } };
}

class WorkUnitReportReaderRepository implements WorkUnitReportReader {
  private db: GoldDB;

  constructor({ goldDb }: WorkUnitReportReaderRepositoryDeps) {
    this.db = goldDb;
  }

  async paginateShiftReport({
    limit,
    offset,
    filter,
  }: ListWorkUnitShiftReportInput): Promise<PagedWorkUnitShiftReport> {
    return await traced("SELECT", TABLE_WORK_UNIT_SHIFT_REPORT, async () => {
      // Fragments shared by the page query and the count query, so the two can
      // never disagree about what is being counted. The table has no static
      // predicate to anchor them, hence `WHERE TRUE` below.
      const periodSql = this.periodFilter(filter);

      const shiftSql =
        filter.shift === undefined ? this.db`` : this.db`AND r.shift = ${filter.shift}`;

      // `IN ()` is not valid SQL, so an empty list contributes no predicate
      // rather than a query that can never match.
      const workUnitSql =
        filter.workUnitIds === undefined || filter.workUnitIds.length === 0
          ? this.db``
          : this.db`AND r.work_unit_id IN ${this.db(filter.workUnitIds)}`;

      // Only `true` hides zero-OEE rows; `false` is an explicit "show everything".
      const hideZeroSql = filter.isHideZero === true ? this.db`AND r.oee <> 0` : this.db``;

      // The header area picker, as a column predicate. It sits BESIDE
      // `workUnitSql` rather than replacing it: a page can be narrowed to one
      // line inside the selected area, and the two are independent.
      const areaSql = areaScope(this.db, filter.areaId);

      const statusSql = this.statusFilter(filter);

      // The percentage columns are `numeric`, and postgres.js returns numerics as
      // strings to protect precision — so an untouched `oee` reaches the client as
      // "100.000" rather than the `number` the domain type promises. Rounding to 3
      // decimals and casting to float8 makes postgres.js parse them as JS numbers,
      // which JSON renders without trailing zeros: 100 stays 100, 97.809 keeps its
      // three decimals.
      const [rows, totals] = await Promise.all([
        this.db<ShiftReportListRow[]>`
          SELECT r.id, r.shift, r.date, r.work_unit_id,
                 round(r.oee::numeric, 3)::float8 AS oee,
                 round(r.availability::numeric, 3)::float8 AS availability,
                 round(r.performance::numeric, 3)::float8 AS performance,
                 round(r.quality::numeric, 3)::float8 AS quality
          FROM oee.work_unit_shift_reports r
          WHERE TRUE ${periodSql} ${shiftSql} ${workUnitSql} ${areaSql} ${hideZeroSql} ${statusSql}
          ORDER BY r.date DESC, r.id ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        // `::int` matters: postgres.js returns bigint columns as strings, and
        // totalElements is typed as a number.
        this.db<{ value: number }[]>`
          SELECT count(r.id)::int AS value
          FROM oee.work_unit_shift_reports r
          WHERE TRUE ${periodSql} ${shiftSql} ${workUnitSql} ${areaSql} ${hideZeroSql} ${statusSql}
        `,
      ]);

      return { items: [...rows], totalElements: totals[0]?.value ?? 0 };
    });
  }

  async getShiftWindow(date: string, shift: ShiftId, timeZone: string): Promise<ShiftWindow> {
    return await traced("SELECT", TABLE_WORK_UNIT_SHIFT_REPORT, async () => {
      return await resolveShiftWindow(this.db, date, shift, timeZone);
    });
  }

  // Approval state for one page of reports, in one round trip.
  //
  // THE SHAPE IS unnest() OF THREE PARALLEL ARRAYS, and the alternatives are
  // worse in specific ways:
  //
  //   * a row-constructor `WHERE (work_unit_id, date, shift) IN ((..),(..))`
  //     cannot be built with postgres.js's sql() helper, which produces FLAT
  //     lists — so it would mean assembling the tuple text by hand;
  //   * fetching by the page's min/max date instead over-fetches every approval
  //     in the window for every work unit, growing with the plant rather than
  //     with the page.
  //
  // unnest binds three ordinary array parameters, and Postgres serves the join
  // from pk_wu_shift_report_approvals — equality on all three key columns.
  //
  // The casts are load-bearing, and so is the fact that every array reaches them
  // as UNTYPED. postgres.js infers a parameter's type with
  //
  //     Array.isArray(x) ? inferType(x[0]) : ...
  //
  // — the ELEMENT's type, not the array's. So a `Date[]` is declared to Postgres
  // as a SCALAR timestamptz, and `$n::timestamptz[]` is then a cast from
  // timestamptz to timestamptz[], which Postgres rejects outright:
  //
  //     cannot cast type timestamp with time zone to timestamp with time zone[]
  //
  // Numbers escape this by luck: inferType returns 0 (unspecified) for them, so
  // Postgres resolves the type from the cast. Dates do not, because
  // `x instanceof Date` matches first and yields a concrete OID.
  //
  // Hence toISOString(): a string also infers to 0, so the ::timestamptz[] cast
  // is what decides the type, exactly as ::int[] does for the ids. The instant is
  // unchanged, so equality against the stored timestamptz still holds.
  //
  // NO fakeSql TEST CAN CATCH THIS. That fake matches SQL text and never sends a
  // parameter to Postgres, so the whole unit suite stayed green while the By
  // Shift list 500'd. The guard is the integration test.
  async listApprovalsForPage(keys: PageApprovalKey[]): Promise<ApprovalByKey[]> {
    // No keys means an empty page. Returning early is not just an optimisation:
    // unnest of three empty arrays is a valid but pointless round trip, and the
    // repository test asserts this query is never issued for an empty page.
    if (keys.length === 0) return [];

    return await traced("SELECT", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      // Built by index rather than with three .map() passes so the arrays cannot
      // fall out of alignment — a misaligned unnest joins the wrong report to the
      // wrong approval and every row still looks plausible.
      const workUnitIds: number[] = [];
      const dates: string[] = [];
      const shifts: number[] = [];
      const reportIds: number[] = [];
      for (const key of keys) {
        workUnitIds.push(key.workUnitId);
        // ISO strings, NOT Date objects — see the note above the method.
        dates.push(key.date.toISOString());
        shifts.push(key.shift);
        reportIds.push(key.reportId);
      }

      const rows = await this.db<ApprovalByKey[]>`
        SELECT k.report_id, a.status
        FROM unnest(
               ${workUnitIds}::int[],
               ${dates}::timestamptz[],
               ${shifts}::smallint[],
               ${reportIds}::int[]
             ) AS k(work_unit_id, date, shift, report_id)
        JOIN oee.work_unit_shift_report_approvals a
          ON a.work_unit_id = k.work_unit_id
         AND a.date         = k.date
         AND a.shift        = k.shift
      `;

      // An INNER join, so reports with no approval row are simply absent. The
      // service coalesces them to 'open' — the same rule the detail query
      // expresses as coalesce(a.status, 'open').
      return [...rows];
    });
  }

  // The approval transitions of one report, newest first.
  //
  // Reads the EVENT LOG, not the current-state row. A report that was approved,
  // reopened and approved again has one row there and three here, and it is the
  // three the Log Activity panel exists to show.
  //
  // `id DESC` breaks the tie so two transitions recorded in the same instant have
  // a stable order, exactly as listReasonHistory does.
  async listApprovalTransitions(key: ShiftReportKey): Promise<ApprovalTransitionRow[]> {
    return await traced("SELECT", TABLE_WU_SHIFT_REPORT_APPROVAL_EVENTS, async () => {
      const rows = await this.db<ApprovalTransitionRow[]>`
        SELECT id, at, by_subject AS "by", by_name, from_status, to_status, source
        FROM oee.work_unit_shift_report_approval_events
        WHERE work_unit_id = ${key.workUnitId}
          AND date         = ${key.date}
          AND shift        = ${key.shift}
        ORDER BY at DESC, id DESC
      `;
      return [...rows];
    });
  }

  // The approval transitions of every shift report inside a WINDOW, newest first.
  //
  // The day and month grains have no approval of their own — the events table is
  // keyed (work_unit_id, date, shift), which is exactly why there is nothing to
  // sign off at those grains. What their Log Activity panel can honestly show is
  // the transitions of the CHILD shift reports, which is what this returns.
  //
  // Bounded on `date`, the shift's START instant, against the window's own
  // timestamptz bounds — the same predicate summariseApprovalsInWindow uses, so
  // the panel and the "2 of 3 shifts approved" tile above it can never disagree
  // about which shifts belong to the day.
  //
  // `shift` COMES BACK ON EVERY ROW here and does not on the shift-grain sibling.
  // At one grain it is redundant; at these it is the only thing that says which
  // of three reports a transition belongs to, and a feed that omits it reads as
  // three unexplained approvals of the same thing.
  async listApprovalTransitionsInWindow({
    workUnitId,
    from,
    to,
  }: {
    workUnitId: number;
    from: Date;
    to: Date;
  }): Promise<PeriodApprovalTransitionRow[]> {
    return await traced("SELECT", TABLE_WU_SHIFT_REPORT_APPROVAL_EVENTS, async () => {
      const rows = await this.db<PeriodApprovalTransitionRow[]>`
        SELECT id, at, shift, by_subject AS "by", by_name, from_status, to_status, source
        FROM oee.work_unit_shift_report_approval_events
        WHERE work_unit_id = ${workUnitId}
          AND date >= ${from}
          AND date <  ${to}
        ORDER BY at DESC, id DESC
      `;
      return [...rows];
    });
  }

  // Every recorded edit to every stop in one shift.
  //
  // The whole-shift sibling of DowntimeReaderRepository.listReasonHistory: no
  // category filter and no reason selector, because the report's activity feed
  // asks about the shift rather than about one bar of a Pareto.
  //
  // TWO STATEMENTS OVER ONE MEMBER SET, and the second is not optional.
  // `entries` alone cannot distinguish "nobody edited these stops" from "none of
  // these stops could ever have been edited" — and today EVERY row is in the
  // second state, because the pipeline does not write source_event_id yet
  // (TODOS.md §19). Reporting only the entries would render "no changes" over
  // data nothing is capable of tracking. Same silent-failure shape as §8.
  //
  // The window predicate matches DowntimeReaderRepository.listOverlapping: a stop
  // counts if it OVERLAPS the shift, not if it started inside it, so a stop
  // straddling 23:00 belongs to both shifts it touches. `date >= from - N days`
  // keeps the scan sargable for stops that are still open, which is what
  // MAX_OPEN_DOWNTIME_DAYS is for.
  async listShiftDowntimeHistory({
    workUnitId,
    from,
    to,
  }: ListShiftHistoryInput): Promise<ShiftDowntimeHistory> {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT_HISTORY, async () => {
      const membersSql = this.shiftStops({ workUnitId, from, to });

      const [entries, counts] = await Promise.all([
        this.db<DowntimeHistoryRow[]>`
          WITH members AS (${membersSql})
          SELECT h.id, h.source_event_id, h.changed_at, h.changed_by,
                 h.field, h.old_value, h.new_value
          FROM oee.downtime_report_history h
          JOIN members m ON m.source_event_id = h.source_event_id
          ORDER BY h.changed_at DESC, h.id DESC
        `,
        this.db<{ totalMembers: number; trackedMembers: number }[]>`
          WITH members AS (${membersSql})
          SELECT count(*)::int AS total_members,
                 count(*) FILTER (WHERE source_event_id IS NOT NULL)::int AS tracked_members
          FROM members
        `,
      ]);

      return {
        entries: [...entries],
        totalMembers: counts[0]?.totalMembers ?? 0,
        trackedMembers: counts[0]?.trackedMembers ?? 0,
      };
    });
  }

  // WHICH STOPS BELONG TO THIS SHIFT — the one statement of it on this side of
  // the codebase, shared by the activity feed above and getCategoryEditedAt
  // below.
  //
  // EXTRACTED RATHER THAN COPIED, and the reason is the same one that moved
  // SHIFT_WINDOWS into shared/: two readers with their own copy of this
  // predicate diverge silently. The failure is not an error — the Log Activity
  // panel would list an edit that the stale-metrics banner did not think had
  // happened, or the reverse, and both screens would look entirely reasonable.
  //
  // Mirrors DowntimeReaderRepository.scopeAndWindow, and MUST keep mirroring it —
  // that header carries the full reasoning and this one states only what differs.
  // The two were unbound from the `date` narrowing together (TODOS.md §69 / §10)
  // and the range expression is copied from `dt_reports_span_gist` character for
  // character, `greatest` included, because a near-miss silently falls back to a
  // scan instead of failing.
  //
  // Still no `start_at >= from` lower bound, for the reason stated there: a stop
  // which began before the shift and is still running has to be kept.
  //
  // THE DIVERGENCE THIS GUARDS AGAINST IS NOT HYPOTHETICAL. If one of these two
  // keeps a horizon the other has dropped, the Log Activity panel lists an edit
  // the stale-metrics banner does not think happened, or the reverse — and both
  // screens look entirely reasonable. That is why the predicate moved in both
  // files in one change rather than in two.
  private shiftStops({ workUnitId, from, to }: ListShiftHistoryInput): Fragment {
    return this.db`
      SELECT source_event_id
      FROM oee.downtime_reports
      WHERE work_unit_id = ${workUnitId}
        AND tstzrange(start_at, greatest(coalesce(end_at, 'infinity'::timestamptz), start_at), '[)')
            && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')
    `;
  }

  // When a stop in this shift last had its CATEGORY changed, or null if none has.
  //
  // WHY ONLY `category`, OF THE FOUR EDITABLE FIELDS
  //
  // Because it is the only one that can make anything on screen wrong. `reason`,
  // `actions` and `detail_reason` are read LIVE out of oee.downtime_reports by
  // the Pareto, the drill-down and the drawer, so an edit to them is already
  // reflected the moment it commits. `category` moves time between schedule loss
  // and availability loss, and those totals are PRECOMPUTED by the pipeline into
  // oee.work_unit_shift_reports — so the OEE tiles, the timeline strip and the
  // waterfall keep showing the pre-edit split until the pipeline recomputes.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO
  //
  // It does not compare against oee.etl_watermarks. The obvious version is
  // "stale if the last category edit is newer than last_run_at", and it is wrong
  // in the FLATTERING direction: that watermark is TABLE-grained, so a run
  // covering other days advances it past the edit without recomputing THIS
  // report — and the banner would clear while the tiles were still wrong. That
  // is the silent-failure shape TODOS.md §8 and §14 are both about. A non-null
  // instant here is a FACT; "the pipeline has caught up with this report" is not
  // knowable per-report until the recalculation trigger exists, so nothing here
  // claims it.
  async getCategoryEditedAt(input: ListShiftHistoryInput): Promise<Date | null> {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT_HISTORY, async () => {
      const rows = await this.db<{ editedAt: Date | null }[]>`
        WITH members AS (${this.shiftStops(input)})
        SELECT max(h.changed_at) AS edited_at
        FROM oee.downtime_report_history h
        JOIN members m ON m.source_event_id = h.source_event_id
        WHERE h.field = 'category'
      `;

      // max() over no rows is one row holding NULL, not zero rows — so the
      // ?? null is for the impossible-empty case and the value itself is
      // already nullable.
      return rows[0]?.editedAt ?? null;
    });
  }

  // Every shift report the given stop OVERLAPS, with its approval status.
  //
  // WHY A STOP HAS MORE THAN ONE REPORT, WHICH IS THE WHOLE POINT
  //
  // A stop straddling 23:00 belongs to BOTH shifts it touches — that is the rule
  // scopeAndWindow and shiftStops already encode for every read — so its
  // `category` contributes availability loss to two reports. Checking only the
  // one named by the stop's own (work_unit_id, date, shift) would let an edit to
  // a straddling stop move the numbers on a report somebody had already signed
  // off, with no error and nothing in that report's own trail to show it.
  //
  // ABSENCE IS OPEN. 0010's header is emphatic: no row in the approvals table
  // means the report is open, so this LEFT JOINs and coalesces rather than
  // reading the approvals table alone. A report with no row must come back
  // 'open', not be missing from the result.
  //
  // BOUNDED ON THE OPEN SIDE. `end_at IS NULL` means the stop is still running,
  // which scopeAndWindow reads as `infinity` — taken literally here, an open stop
  // overlaps EVERY later shift, so one approval anywhere would freeze it forever.
  // And a long-open stop is precisely the one most likely to need its category
  // corrected. MAX_OPEN_DOWNTIME_DAYS bounds it, which is the same constant that
  // bounds how far back the read paths look for an open stop, so both directions
  // agree about how far one reaches. The residual is stated in TODOS.md: an
  // approval further out than that will not freeze the stop.
  //
  //   shift boundary        23:00
  //   report A  |------------|            approved  -> the edit is refused
  //   report B               |----------|  open
  //   the stop        |======|=====|       straddles both
  async listApprovalsOverlapping({
    workUnitId,
    startAt,
    endAt,
    timeZone,
  }: ListOverlappingApprovalsInput): Promise<OverlappingApproval[]> {
    return await traced("SELECT", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      const { shifts, endDayOffsets, endTimes } = SHIFT_END_BOUNDS;

      // The three arrays are bound as arrays and unnested, the same shape
      // listApprovalsForPage uses. They are CAST — an untyped array parameter
      // reaches Postgres as unknown and the join on `shift` would fail, which is
      // the trap this file already records at listApprovalsForPage.
      const rows = await this.db<OverlappingApproval[]>`
        WITH bounds AS (
          SELECT * FROM unnest(
            ${shifts}::int[], ${endDayOffsets}::int[], ${endTimes}::text[]
          ) AS t(shift, end_day_offset, end_time)
        ),
        span AS (
          SELECT ${startAt}::timestamptz AS from_at,
                 coalesce(
                   ${endAt}::timestamptz,
                   ${startAt}::timestamptz
                     + make_interval(days => ${MAX_OPEN_DOWNTIME_DAYS}::int)
                 ) AS to_at
        )
        SELECT r.work_unit_id, r.date, r.shift,
               coalesce(a.status, 'open') AS status
        FROM oee.work_unit_shift_reports r
        JOIN bounds b ON b.shift = r.shift
        CROSS JOIN span s
        LEFT JOIN oee.work_unit_shift_report_approvals a
               ON a.work_unit_id = r.work_unit_id
              AND a.date         = r.date
              AND a.shift        = r.shift
        WHERE r.work_unit_id = ${workUnitId}
          -- The narrowing, for the reason shiftStops narrows on date: without
          -- it this is an unbounded scan of one machine's whole history.
          AND r.date >= s.from_at - make_interval(days => ${MAX_OPEN_DOWNTIME_DAYS}::int)
          -- A report whose window STARTS at or after the stop ends cannot
          -- overlap it. Half-open, so a stop ending exactly at 23:00 does not
          -- reach into shift 3.
          AND r.date < s.to_at
          -- ...and its window must still be running when the stop begins. The
          -- end instant is rebuilt exactly as resolveShiftWindow builds it, so
          -- AT TIME ZONE resolves the offset for that date rather than assuming
          -- eight real hours. See SHIFT_END_BOUNDS.
          AND ((((r.date AT TIME ZONE ${timeZone})::date + b.end_day_offset)
                 + b.end_time::time) AT TIME ZONE ${timeZone}) > s.from_at
        ORDER BY r.date ASC, r.shift ASC
      `;

      return [...rows];
    });
  }

  async getShiftReport(id: number): Promise<Omit<WorkUnitShiftReport, "timeZone"> | undefined> {
    return await traced("SELECT", TABLE_WORK_UNIT_SHIFT_REPORT, async () => {
      const rows = await this.db<ShiftReportRow[]>`
        -- r-qualified on the three columns oee.work_unit_shift_report_approvals
        -- also has. Without this each one is a runtime "column reference is
        -- ambiguous" error, which no fakeSql test can see because that fake matches
        -- SQL text and never executes it.
        SELECT r.id, r.shift, r.date, r.work_unit_id, work_unit_name, work_center_id, work_center_name,
              uom_id, uom_name,
              round(teep::numeric, 3)::float8 AS teep,
              round(oee::numeric, 3)::float8 AS oee,
              round(availability::numeric, 3)::float8 AS availability,
              round(performance::numeric, 3)::float8 AS performance,
              round(quality::numeric, 3)::float8 AS quality,
              round(total_out::numeric, 3)::float8 AS total_out,
              round(good_out::numeric, 3)::float8 AS good_out,
              round(effective_out::numeric, 3)::float8 AS effective_out,
              runtime::float8 as runtime,
              availability_time::float8 as availability_time,
              production_time::float8 as production_time,
              pdt_time::float8 as pdt_time,
              operating_time::float8 as operating_time,
              updt_time::float8 as updt_time,
              net_time::float8 as net_time,
              reduce_speed_time::float8 as reduce_speed_time,
              ms_time::float8 as ms_time,
              value_added_time::float8 as value_added_time,
              reject_time::float8 as reject_time,
              rework_time::float8 as rework_time,
              anomaly_time::float8 as anomaly_time,
              up_speed_time::float8 as up_speed_time,
              schedule_loss_time::float8 as schedule_loss_time,
              availability_loss_time::float8 as availability_loss_time,
              performance_loss_time::float8 as performance_loss_time,
              ms_loss_time::float8 as ms_loss_time,
              reduce_speed_loss_time::float8 as reduce_speed_loss_time,
              quality_loss_time::float8 as quality_loss_time,
              round(reject::numeric, 3)::float8 AS reject,
              round(rework::numeric, 3)::float8 AS rework,
              mttr::float8 as mttr,
              mtbf::float8 as mtbf,
              -- The ABSENCE of an approval row means open; see 0010's header.
              -- Every reader of this table has to coalesce, and this is one of
              -- the two places that does.
              coalesce(a.status, 'open') AS status,
              a.closed_at, a.closed_by, a.closed_by_name, a.source
        FROM oee.work_unit_shift_reports r
        -- Joined on the NATURAL key, not on r.id, because the approvals table is
        -- keyed that way on purpose — a pipeline restatement re-mints r.id but
        -- leaves these three columns alone. They are exactly wu_shift_report_key.
        --
        -- Plain timestamptz equality, and deliberately NOT the
        -- (r.date AT TIME ZONE $tz)::date form every other join in this file
        -- uses: a.date is a copy of r.date, an instant, not a business day. Do
        -- not "fix" this into a zone conversion.
        LEFT JOIN oee.work_unit_shift_report_approvals a
               ON a.work_unit_id = r.work_unit_id
              AND a.date         = r.date
              AND a.shift        = r.shift
        WHERE r.id = ${id}
        LIMIT 1
      `;

      const row = rows[0];
      if (row === undefined) return undefined;

      return toShiftReport(row);
    });
  }

  // The per-SKU breakdown of one shift report, from oee.product_count_wu_shift.
  //
  // Which measures get scaled, and which unit each one is labelled with:
  //
  //   row: uom=CARTON  base=BAG  factor_to_base=12
  //   ┌───────────────┬──────────────┬─────────────────────────┐
  //   │ column        │ x factor?    │ label the UI shows      │
  //   ├───────────────┼──────────────┼─────────────────────────┤
  //   │ total_out     │ YES  x12     │ base_uom_code   (BAG)   │
  //   │ good_out      │ NO           │ uom_code     (CARTON)   │  <- the exception
  //   │ reject        │ YES  x12     │ base_uom_code   (BAG)   │
  //   │ rework        │ YES  x12     │ base_uom_code   (BAG)   │
  //   └───────────────┴──────────────┴─────────────────────────┘
  //
  // `good_out` staying unscaled is a product decision, not an oversight — it is
  // the one thing in this query a future reader will want to "fix", and the
  // repository test asserts factor_to_base never touches it.
  //
  // The join is driven FROM the report, so the two tables' correspondence is a
  // fact Postgres establishes rather than one the browser asserts by sending three
  // values it read off one of them.
  //
  // The date predicate is the subtle one, and it is NOT `p.shift_date = r.date`:
  //
  //   oee.work_unit_shift_reports.date  timestamptz — the shift's START INSTANT
  //   oee.product_count_wu_shift.shift_date  date   — the shift's BUSINESS DAY
  //
  // Those are different kinds of value. Comparing them directly makes Postgres
  // widen the `date` side to timestamptz at midnight, so the only shift that can
  // ever match is one starting at exactly 00:00 in the session zone — which for a
  // UTC+7 plant is shift 1 and nothing else. Shifts 2 and 3 silently return no
  // rows, and an empty SKU card is indistinguishable from an idle machine.
  //
  //   shift 1  2026-08-01 00:00Z  (07:00 local)  ─┐
  //   shift 2  2026-08-01 08:00Z  (15:00 local)   ├─ all business day 2026-08-01
  //   shift 3  2026-08-01 16:00Z  (23:00 local)  ─┘
  //
  // So the instant is reduced to a business day first, in the PLANT's zone — not
  // UTC. The distinction is invisible at UTC+7, where every shift start lands on
  // the same UTC calendar date as the local one, and load-bearing anywhere west of
  // Greenwich: a 23:00 shift-3 start at UTC-5 is 04:00Z the NEXT day, so the UTC
  // date part would name the wrong business day.
  //
  // `p.shift_date` stays a bare column so pk_product_count_wu_shift still serves
  // the lookup; the conversion is on the single `r` row the WHERE has already
  // pinned. There is likewise no cast on `p.shift = r.shift` — both are smallint,
  // and a cast on p.shift would defeat that same index.
  async listProductCount(reportId: number, timeZone: string): Promise<ProductCountItem[]> {
    return await traced("SELECT", TABLE_PRODUCT_COUNT_WU_SHIFT, async () => {
      // Same numeric discipline as getShiftReport above: postgres.js returns
      // `numeric` as a string to protect precision, so every measure is rounded
      // and cast to float8 or it reaches the browser as "854648.000".
      const rows = await this.db<ProductCountItem[]>`
        SELECT p.product_id, p.product_name, p.product_code,
               p.uom_code, p.base_uom_code,
               round(p.total_out * p.factor_to_base, 3)::float8 AS total_out,
               round(p.good_out::numeric, 3)::float8            AS good_out,
               round(p.reject * p.factor_to_base, 3)::float8    AS reject,
               round(p.rework * p.factor_to_base, 3)::float8    AS rework
        FROM oee.work_unit_shift_reports r
        JOIN oee.product_count_wu_shift p
          ON p.work_unit_id = r.work_unit_id
         AND p.shift_date   = (r.date AT TIME ZONE ${timeZone})::date
         AND p.shift        = r.shift
        WHERE r.id = ${reportId}
        ORDER BY p.product_name ASC, p.product_id ASC
      `;

      return [...rows];
    });
  }

  // Resolving the zone above needs the work unit, and the work unit lives on the
  // report — so this read comes first and doubles as the existence check. That is
  // why listProductCount is a plain JOIN: it no longer has to distinguish "no such
  // report" from "report ran no SKUs", because the caller already knows.
  async getReportScope(id: number): Promise<ReportScope | undefined> {
    return await traced("SELECT", TABLE_WORK_UNIT_SHIFT_REPORT, async () => {
      const rows = await this.db<ReportScope[]>`
        SELECT work_unit_id, shift, date
        FROM oee.work_unit_shift_reports
        WHERE id = ${id}
        LIMIT 1
      `;

      return rows[0];
    });
  }

  // Reduce a shift's START INSTANT to the business day it belongs to, in the
  // plant's zone. The whole conversion is one expression and it touches no table.
  //
  // It is a query rather than JS on purpose. `Intl.DateTimeFormat` could do this,
  // but every other date computation in this service is handed to Postgres — see
  // `periodFilter` above and `DowntimeReaderRepository.getWindow` — precisely so
  // that no session time zone, and no Node ICU build, can move a boundary. Doing
  // it two ways is how the two answers eventually differ.
  //
  // Why it exists at all: `listPerfHours` is keyed on `business_date`, a real
  // `date`, while the report stores a `timestamptz`. The zone needed to bridge
  // them is resolved from `workUnitId`, which is itself only known after
  // `getReportScope` — so this cannot be folded into that read. It disappears
  // entirely when TODOS.md §17 puts a `business_date` column on the report table.
  async resolveBusinessDate(instant: Date, timeZone: string): Promise<string> {
    return await traced("SELECT", TABLE_WORK_UNIT_SHIFT_REPORT, async () => {
      const rows = await this.db<{ businessDate: string }[]>`
        SELECT to_char((${instant}::timestamptz AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD')
                 AS business_date
      `;

      const businessDate = rows[0]?.businessDate;
      // Unreachable for a valid instant and a valid IANA zone, and a silent
      // undefined here would reach the next query as the string "undefined" and
      // match nothing — an empty chart rather than an error.
      if (businessDate === undefined) {
        throw new Error(`could not resolve business date in zone ${timeZone}`);
      }

      return businessDate;
    });
  }

  // The hourly performance profile: one row per product per hour.
  //
  // NO TIME-ZONE ARITHMETIC. `business_date` is already the business day the
  // pipeline computed in the plant's zone, and `bucket_start` is an instant, so
  // this is plain equality and a range — which is exactly what makes the same
  // method serve shift, day and month. Contrast `listProductCount` above, which
  // still has to convert because `work_unit_shift_reports.date` is a timestamptz;
  // this table was given a real `business_date` from day one so that the read
  // would never repeat that.
  //
  // ORDER BY bucket_start, NOT by the clock label. Shift 3 runs 23:00 -> 07:00,
  // so ordering by `hour_of_day` would render 00,01,...,06,23 and put the shift's
  // FIRST hour last. The instant is the only thing that sorts correctly across
  // midnight, and the trailing key in ix_ppwuh_wu_day_shift supplies this order
  // for free.
  //
  // The measures are NOT scaled by factor_to_base, unlike listProductCount. Rates
  // here are denominated in `uom_id`, so converting the quantities to the base
  // unit while leaving the standard in the production unit would put a numerator
  // and its denominator in different units — a plausible-looking wrong number.
  // Cross-product conversion is a BI concern and the column is on the row for it.
  async listPerfHours({
    workUnitId,
    dateFrom,
    dateTo,
    shift,
  }: ListPerfHoursInput): Promise<PerfHourBucket[]> {
    return await traced("SELECT", TABLE_PRODUCT_PERF_WU_HOUR, async () => {
      // Omitted for the day and month grains, which span every shift.
      const shiftSql = shift === undefined ? this.db`` : this.db`AND shift = ${shift}`;

      // Same numeric discipline as every read above: postgres.js returns `numeric`
      // AND `bigint` as strings to protect precision, so each measure is cast or it
      // reaches the browser as "34304.000" and violates the `number` domain type.
      const rows = await this.db<PerfHourBucket[]>`
        SELECT bucket_start, bucket_end, hour_of_day, shift_hour_seq,
               product_id, product_name, product_code, uom_code,
               round(total_out::numeric, 3)::float8           AS total_out,
               round(effective_out::numeric, 3)::float8       AS effective_out,
               runtime::float8                                AS runtime,
               round(ideal_rate_per_hour::numeric, 3)::float8 AS ideal_rate_per_hour
        FROM oee.product_perf_wu_hour
        WHERE work_unit_id = ${workUnitId}
          AND business_date >= ${dateFrom}::date
          AND business_date <= ${dateTo}::date
          ${shiftSql}
        ORDER BY bucket_start ASC, product_name ASC, product_id ASC
      `;

      return [...rows];
    });
  }

  // How far the pipeline has loaded this table. A MISSING ROW MEANS NEVER LOADED,
  // which is why this returns null rather than throwing or defaulting to a date:
  // "never loaded" and "loaded up to some day" are different answers and the
  // browser renders them differently.
  //
  // Its own query rather than a join onto the buckets, for the reason
  // `DowntimeReaderRepository.getWindow` is separate too: a joined watermark
  // vanishes when no bucket rows match, and no rows is precisely the case this
  // value exists to explain.
  async getPerfWatermark(): Promise<string | null> {
    return await getWatermark(this.db, "product_perf_wu_hour");
  }

  // The rows behind one report's reject breakdown, as a fragment both statements
  // in `aggregateRejectReasons` compose. Extracted for the reason
  // DowntimeReaderRepository.clipped is: an aggregate whose bars do not sum to
  // its own denominator is a defect nobody would spot on screen, and one shared
  // row set is what makes that impossible rather than merely unlikely.
  //
  // The join is listProductCount's. Both of its traps apply unchanged: the zone
  // conversion lands on the single `r` row the WHERE has pinned, so
  // `j.shift_date` stays a bare column and pk_reject_count_wu_shift still serves
  // the lookup; and `j.shift = r.shift` carries no cast, since both are smallint
  // and a cast would defeat that same index.
  private rejectRows(reportId: number, timeZone: string): Fragment {
    return this.db`
      SELECT j.*
      FROM oee.work_unit_shift_reports r
      JOIN oee.reject_count_wu_shift j
        ON j.work_unit_id = r.work_unit_id
       AND j.shift_date   = (r.date AT TIME ZONE ${timeZone})::date
       AND j.shift        = r.shift
      WHERE r.id = ${reportId}
    `;
  }

  // The same rows over a DAY or MONTH window.
  //
  // Only the join differs from rejectRows above, which is why this is a separate
  // fragment rather than a branch inside it — and why the two aggregates that
  // consume either are unchanged. Everything hard about them (the unit guards,
  // the generated-column read, the null-vs-zero weight rule) has one statement.
  //
  // NO ZONE CONVERSION. The shift version bridges an instant to a business day
  // with `AT TIME ZONE`; here `r.business_date` and `j.shift_date` are both
  // `date` columns after 0013, so the join is a plain half-open range.
  //
  // A WIDER WINDOW MAKES THE UNIT GUARDS FIRE FAR MORE OFTEN, and that is
  // correct rather than a regression. `CASE WHEN count(DISTINCT uom_code) = 1`
  // returns NULL for a bucket that mixed BAG and CARTON — over eight hours that
  // is rare, over thirty days it is ordinary — and the screen renders an em dash
  // for the unit rather than picking one of them and adding incompatible
  // numbers under it.
  private periodRejectRows(grain: CoarseGrain, reportId: number): Fragment {
    const span = this.grainSpan(grain);

    return this.db`
      SELECT j.*
      FROM ${this.grainFrom(grain)} r
      JOIN oee.reject_count_wu_shift j
        ON j.work_unit_id = r.work_unit_id
       AND j.shift_date  >= r.business_date
       AND j.shift_date  <  r.business_date + ${span}
      WHERE r.id = ${reportId}
    `;
  }

  // The Others tab's pairs over a day or month window, on the same terms as
  // periodRejectRows above.
  //
  // The DISTINCT is doing MORE work here than at shift grain: it deduplicates
  // (event_id, reason) across the whole window, so a reason repeated inside one
  // event still counts once no matter how many days the window spans.
  private periodDowntimeEventReasonPairs(grain: PeriodGrain, reportId: number): Fragment {
    const span = this.grainSpan(grain);

    return this.db`
      SELECT DISTINCT e.event_id,
                      nullif(btrim(x.reason), '') AS reason
      FROM ${this.grainFrom(grain)} r
      JOIN oee.downtime_log_events e
        ON e.work_unit_id = r.work_unit_id
       AND e.shift_date  >= r.business_date
       AND e.shift_date  <  r.business_date + ${span}
      LEFT JOIN LATERAL unnest(e.reasons) AS x(reason) ON true
      WHERE r.id = ${reportId}
    `;
  }

  // The Quality Loss Pareto, grouped by reject counter.
  //
  // TWO STATEMENTS OVER ONE SHARED CTE, mirroring
  // DowntimeReaderRepository.aggregateByReason and for the identical reason: the
  // browser's cumulative line divides by the response's TOTALS, so the bars must
  // sum to their own denominator. Computing the totals as a second aggregate over
  // the same row set is what guarantees that; re-deriving them from the buckets
  // would make the guarantee an assumption. A single GROUPING SETS query was
  // rejected for the reason stated there — the grain is one machine's shift, so
  // the second scan costs nothing, and two readable statements beat one clever
  // one.
  //
  // THE MIXED-UNIT GUARDS ARE THE POINT OF THIS QUERY. A work unit's counters can
  // report in different units — the design's own example has one in BAG and three
  // in CALENDER — and one reason can span several products. So a bucket may cover
  // rows whose `uom_code` disagrees, and summing those is meaningless. Rather
  // than return a plausible number, the unit comes back NULL and the browser
  // renders the whole cell as an em dash. Same treatment for `base_uom_code` and
  // the converted figure. This is the guard the SKU card already applies when a
  // shift mixes units of measure; here it is per bucket as well as per shift.
  async aggregateRejectReasons(reportId: number, timeZone: string): Promise<RejectAggregate> {
    return await aggregateRejectRows(
      this.db,
      TABLE_REJECT_COUNT_WU_SHIFT,
      this.rejectRows(reportId, timeZone),
    );
  }

  // The identical aggregate over a day or month window.
  async aggregatePeriodRejectReasons(
    grain: CoarseGrain,
    reportId: number,
  ): Promise<RejectAggregate> {
    return await aggregateRejectRows(
      this.db,
      TABLE_REJECT_COUNT_WU_SHIFT,
      this.periodRejectRows(grain, reportId),
    );
  }

  // The watermark for the reject table. Its own query rather than a join onto the
  // buckets, for the reason getPerfWatermark states — and it matters more here
  // than anywhere else it appears: oee.reject_count_wu_shift ships EMPTY, so "no
  // rows" is the normal answer and this value is the only thing that stops the
  // tab reporting every shift as a clean one.
  async getRejectWatermark(): Promise<string | null> {
    return await getWatermark(this.db, "reject_count_wu_shift");
  }

  // The watermark for the product-count table. Its own query, for the reason the
  // three watermark readers above give.
  //
  // WHY THIS ARRIVES LAST OF THE FOUR, which is the interesting part. The other
  // three back tabs that ship against an EMPTY table, so "no rows" was obviously
  // the normal answer and the watermark was obviously load-bearing.
  // oee.product_count_wu_shift is populated, so the SKU View card looked correct —
  // and it renders "No product output recorded for this shift" for a machine that
  // ran nothing AND for a day the pipeline has not reached. Those are opposite
  // claims and the flattering one was winning. TODOS.md §14.
  async getProductCountWatermark(): Promise<string | null> {
    return await getWatermark(this.db, "product_count_wu_shift");
  }

  // The (event, reason) pairs behind one report's downtime-reason frequencies, as
  // a fragment BOTH statements in aggregateDowntimeEventReasons compose.
  //
  // THE EXPLODE LIVES IN HERE, NOT IN THE TWO STATEMENTS, and that is the whole
  // design. rejectRows returns raw rows because both of its statements aggregate
  // the same columns; here the two statements aggregate a DERIVED row set, and if
  // each derived it for itself the DISTINCT could drift between them — which would
  // make `total_occurrences` disagree with the sum of the bars in a way nothing on
  // screen would reveal. One fragment, one explode, one row set.
  //
  // SELECT DISTINCT event_id, reason: a reason repeated inside ONE event must
  // count ONCE, because it is one event. Without the DISTINCT
  // {Material_Jam, Material_Jam} contributes 2, and the bar can then outrank a
  // reason that really did occur more often — so the bug shows up as a DIFFERENT
  // CHART, not merely a different number.
  //
  // LEFT JOIN, not a comma join and not an inner one. unnest('{}') yields zero
  // rows, so an inner join would DROP every event with no reason recorded — out of
  // the unattributed bucket AND out of total_events. The bars would still sum to
  // total_occurrences and the cumulative line would still reach 100%, so the
  // Pareto would look entirely correct and only the sentence beside it would be
  // wrong. That is the quietest failure in this feature; the integration suite is
  // what catches it.
  //
  // nullif(btrim(...)) folds a blank element into the same NULL the empty array
  // produces, so there is exactly ONE unattributed bucket. ck_dtle_reasons makes
  // that unreachable from a compliant pipeline; this is the guard that outlives
  // the constraint, the way DowntimeReaderRepository.primaryReason's guard
  // outlives downtime_reports' lack of one.
  //
  // The join is rejectRows'. Both of its traps apply unchanged: the zone
  // conversion lands on the single `r` row the WHERE has pinned, so `e.shift_date`
  // stays a bare column and ix_dtle_wu_shift still serves the lookup — which
  // matters MORE here than on the reject table, whose primary key covers this join
  // for free while this table's single-column key covers it not at all; and
  // `e.shift = r.shift` carries no cast, since both are smallint.
  //
  // LATERAL is a noise word before a function-call FROM item and is written anyway,
  // so nobody "fixes" the lateral reference into a correlated subquery. `ON true`
  // is required, because it is a join.
  private downtimeEventReasonPairs(reportId: number, timeZone: string): Fragment {
    return this.db`
      SELECT DISTINCT e.event_id,
                      nullif(btrim(x.reason), '') AS reason
      FROM oee.work_unit_shift_reports r
      JOIN oee.downtime_log_events e
        ON e.work_unit_id = r.work_unit_id
       AND e.shift_date   = (r.date AT TIME ZONE ${timeZone})::date
       AND e.shift        = r.shift
      LEFT JOIN LATERAL unnest(e.reasons) AS x(reason) ON true
      WHERE r.id = ${reportId}
    `;
  }

  // The Others tab's Pareto: how many times each downtime reason occurred.
  //
  // FREQUENCY ONLY. No duration anywhere, because oee.downtime_log_events carries
  // none — no duration column, no start_at, no end_at. So there is nothing to clip
  // and no open-stop arithmetic: each event belongs to exactly one shift, and the
  // pipeline is what guarantees that (contract §3.9).
  //
  // IT DOES NOT READ oee.downtime_reports, AND MUST NOT. That table is the
  // operator-mutable one — editing a downtime's reasons is one of the two
  // mutations contract §1 rule 2 reserves for this service — and a bar that moves
  // when an operator corrects a stop is not a count of what happened. A repository
  // test asserts the SQL names neither it nor any product-report table, so the
  // product decision is enforced here rather than merely described.
  //
  // TWO STATEMENTS OVER ONE SHARED ROW SET, mirroring aggregateRejectReasons and
  // DowntimeReaderRepository.aggregateByReason, for the identical reason: the
  // browser's cumulative line divides by total_occurrences, so the bars must sum
  // to their own denominator. Computing that denominator as a second aggregate
  // over the same pairs is what makes it a guarantee rather than an assumption.
  async aggregateDowntimeEventReasons(
    reportId: number,
    timeZone: string,
  ): Promise<DowntimeEventAggregate> {
    return await aggregateEventPairs(
      this.db,
      TABLE_DOWNTIME_LOG_EVENTS,
      this.downtimeEventReasonPairs(reportId, timeZone),
    );
  }

  // The identical aggregate over a day or month window.
  async aggregatePeriodDowntimeEventReasons(
    grain: PeriodGrain,
    reportId: number,
  ): Promise<DowntimeEventAggregate> {
    return await aggregateEventPairs(
      this.db,
      TABLE_DOWNTIME_LOG_EVENTS,
      this.periodDowntimeEventReasonPairs(grain, reportId),
    );
  }

  // The watermark for the downtime event log. Its own query rather than a join
  // onto the buckets, for the reason getPerfWatermark states — and it matters as
  // much here as on the reject table: oee.downtime_log_events ships EMPTY, so "no
  // rows" is the normal answer and this value is the only thing that stops the
  // Others tab reporting every shift as a shift nothing stopped.
  async getDowntimeEventWatermark(): Promise<string | null> {
    return await getWatermark(this.db, "downtime_log_events");
  }

  // `month` and `year` are independently optional. When both are given the
  // period becomes a half-open range on `date`, which an index can serve, and the
  // arithmetic stays in SQL rather than being computed in JS.
  //
  // KNOWN LIMITATION, correct for this plant and not in general. `date` is a
  // timestamptz holding the shift's start instant, while a month is a run of
  // business days — and `make_date` produces a `date`, which Postgres widens to
  // timestamptz at midnight in the SESSION zone (postgres.js does not pin it, so
  // that is the server default). The two line up only where a business day begins
  // at 00:00 in that zone:
  //
  //   plant       shift 3 of Aug 31   -> instant      in August filter?  truth
  //   Asia/Jakarta  23:00+07          -> Aug 31 16:00Z      yes           yes  ok
  //   America/…     23:00-05          -> Sep  1 04:00Z      no            yes  WRONG
  //
  // Fixing it needs `(date AT TIME ZONE <that row's zone>)::date`, and the zone is
  // not a column — one query spans many work units that may sit in different
  // zones, so no single predicate is correct. The real fix is a `business_date`
  // column on this table. See TODOS.
  //
  // Do NOT "simplify" this to a plain `date` comparison on the assumption the
  // column is a date; it is not, and that mistake already cost the SKU View card
  // every shift but the first.
  //
  // EVERY BRANCH QUALIFIES WITH `r.`, AND THAT IS NOT COSMETIC. paginateShiftReport
  // aliases oee.work_unit_shift_reports as `r` so the status filter can correlate a
  // subquery against it. The moment that alias exists, a bare `date` here is
  // ambiguous the instant any joined relation also has one — and, worse, the
  // month-only branch below used to qualify with the FULL TABLE NAME
  // (`work_unit_shift_reports.date`), which an alias replaces outright: Postgres
  // rejects it with "invalid reference to FROM-clause entry".
  //
  // `fakeSql` CANNOT SEE ANY OF THIS. It matches SQL text and never executes it, so
  // the whole unit suite stays green while the hottest page in the app 500s. That
  // is why every branch is exercised against a real Postgres in
  // work-unit-repository.integration.test.ts. TODOS.md §36 stated this hazard
  // before the work started; it was accurate.
  // ───────────────────────────────────────────────────────────────────────────
  // The coarse grains — By Day and By Monthly
  // ───────────────────────────────────────────────────────────────────────────

  // The FROM clause for a grain, as a literal fragment.
  //
  // Not `this.db(GRAIN_TABLE[grain])`: postgres.js escapes that as ONE identifier,
  // dot included, so it would name a table called `oee.work_unit_day_reports` in
  // the search path rather than `work_unit_day_reports` in schema `oee`. Two
  // hardcoded fragments cannot be injected into and read plainly.
  // ONE STATEMENT OF HOW LONG EACH GRAIN IS, for every read that widens a source
  // table over a report row's window by joining `>= business_date AND <
  // business_date + span`. It was written out twice before `0027` and would have
  // been written out a third time; the two copies agreeing was luck rather than
  // structure, and a wrong span renders a plausible total rather than throwing.
  private grainSpan(grain: CoarseGrain): Fragment {
    if (grain === "day") return this.db`interval '1 day'`;
    if (grain === "month") return this.db`interval '1 month'`;
    return this.db`interval '1 year'`;
  }

  private grainFrom(grain: CoarseGrain): Fragment {
    if (grain === "day") return this.db`oee.work_unit_day_reports`;
    if (grain === "month") return this.db`oee.work_unit_month_reports`;
    return this.db`oee.work_unit_year_reports`;
  }

  // `month` exists only on the month table, so the projection has to differ by
  // exactly one column. Selected as a literal NULL at day grain rather than
  // omitted, so both grains come back the same shape and the mapper needs no
  // branch.
  private grainMonth(grain: CoarseGrain): Fragment {
    return grain === "month" ? this.db`r.month` : this.db`NULL::text AS month`;
  }

  // `date` exists on the day and month tables and NOT on the year one — `0027`
  // followed `0014` in dropping it from a table with no upstream legacy. Selected
  // as a literal NULL there rather than omitted, so all three grains come back the
  // same shape and the mapper needs no branch, exactly as grainMonth does.
  //
  // NOT DERIVED FROM `business_date`. Fabricating an instant here would put a
  // measured-looking value in the one field that exists to be an instant, and
  // WorkUnitPeriodReportField.date says nothing reads it for display anyway.
  private grainDate(grain: CoarseGrain): Fragment {
    return grain === "year" ? this.db`NULL::timestamptz AS date` : this.db`r.date`;
  }

  async paginatePeriodReport({
    grain,
    limit,
    offset,
    filter,
  }: ListWorkUnitPeriodReportInput): Promise<PagedWorkUnitPeriodReport> {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      const from = this.grainFrom(grain);
      const periodSql = this.businessDateFilter(filter);

      const workUnitSql =
        filter.workUnitIds === undefined || filter.workUnitIds.length === 0
          ? this.db``
          : this.db`AND r.work_unit_id IN ${this.db(filter.workUnitIds)}`;

      const hideZeroSql = filter.isHideZero === true ? this.db`AND r.oee <> 0` : this.db``;

      // The header area picker. `0013` put `work_center_id` on these two tables
      // and `0027` carried it onto the year one; `0028` added `area_id` to all
      // three, which is what makes this a predicate at every coarse grain rather
      // than at the shift grain alone.
      const areaSql = areaScope(this.db, filter.areaId);

      // No shift filter and no status filter, unlike the shift list. There is no
      // shift at these grains, and the approval count is a per-row window query
      // the list deliberately does not pay for — see WorkUnitPeriodReportList.
      const [rows, totals] = await Promise.all([
        this.db<PeriodReportListRow[]>`
          SELECT r.id, ${grain}::text AS grain, ${this.grainDate(grain)},
                 to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
                 ${this.grainMonth(grain)},
                 r.work_unit_id,
                 round(r.oee::numeric, 3)::float8 AS oee,
                 round(r.availability::numeric, 3)::float8 AS availability,
                 round(r.performance::numeric, 3)::float8 AS performance,
                 round(r.quality::numeric, 3)::float8 AS quality
          FROM ${from} r
          WHERE TRUE ${periodSql} ${workUnitSql} ${areaSql} ${hideZeroSql}
          -- business_date first, because it is the column a reader is sorting by
          -- in their head. NULLS LAST keeps rows the pipeline has not stamped yet
          -- at the bottom rather than at the top, where they would look like the
          -- most recent reports.
          ORDER BY r.business_date DESC NULLS LAST, r.id ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        this.db<{ value: number }[]>`
          SELECT count(r.id)::int AS value
          FROM ${from} r
          WHERE TRUE ${periodSql} ${workUnitSql} ${areaSql} ${hideZeroSql}
        `,
      ]);

      return { items: [...rows], totalElements: totals[0]?.value ?? 0 };
    });
  }

  // One report, every column. No approval join — there is nothing keyed to join
  // to; the service adds the derived shift count separately.
  async getPeriodReport(
    grain: CoarseGrain,
    id: number,
  ): Promise<WorkUnitPeriodReportField | undefined> {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      const rows = await this.db<WorkUnitPeriodReportField[]>`
        SELECT r.id, ${grain}::text AS grain, ${this.grainDate(grain)},
               to_char(r.business_date, 'YYYY-MM-DD') AS business_date, r.time_zone,
               ${this.grainMonth(grain)},
               r.work_unit_id, r.work_unit_name, r.work_unit_code,
               r.work_center_id, r.work_center_name, r.work_center_code,
               r.uom_id, r.uom_name, r.uom_code,
               round(teep::numeric, 3)::float8 AS teep,
               round(oee::numeric, 3)::float8 AS oee,
               round(availability::numeric, 3)::float8 AS availability,
               round(performance::numeric, 3)::float8 AS performance,
               round(quality::numeric, 3)::float8 AS quality,
               round(total_out::numeric, 3)::float8 AS total_out,
               round(good_out::numeric, 3)::float8 AS good_out,
               round(effective_out::numeric, 3)::float8 AS effective_out,
               runtime::float8 AS runtime,
               availability_time::float8 AS availability_time,
               production_time::float8 AS production_time,
               pdt_time::float8 AS pdt_time,
               operating_time::float8 AS operating_time,
               updt_time::float8 AS updt_time,
               net_time::float8 AS net_time,
               reduce_speed_time::float8 AS reduce_speed_time,
               ms_time::float8 AS ms_time,
               value_added_time::float8 AS value_added_time,
               reject_time::float8 AS reject_time,
               rework_time::float8 AS rework_time,
               anomaly_time::float8 AS anomaly_time,
               up_speed_time::float8 AS up_speed_time,
               schedule_loss_time::float8 AS schedule_loss_time,
               -- Spelled correctly HERE AND IN THE DATABASE. 0013 renamed the
               -- misspelled availablity_loss_time (sic) on both tables; if you
               -- are reading 0003 for the column list, that is the pre-0013
               -- capture and still shows the old spelling.
               availability_loss_time::float8 AS availability_loss_time,
               performance_loss_time::float8 AS performance_loss_time,
               ms_loss_time::float8 AS ms_loss_time,
               reduce_speed_loss_time::float8 AS reduce_speed_loss_time,
               quality_loss_time::float8 AS quality_loss_time,
               round(reject::numeric, 3)::float8 AS reject,
               round(rework::numeric, 3)::float8 AS rework,
               -- NOT coalesced to 0. NULL means the pipeline has not computed
               -- these yet and the screen renders an em dash; a 0 here would
               -- claim a perfect repair time on every unwritten row.
               mttr::float8 AS mttr,
               mtbf::float8 AS mtbf
        FROM ${this.grainFrom(grain)} r
        WHERE r.id = ${id}
        LIMIT 1
      `;

      return rows[0];
    });
  }

  // The MONTH report's hour-of-day performance profile: 24 points per product,
  // not ~720.
  //
  // TODOS.md §23 specified this and the specification held. `product_perf_wu_hour`
  // already carries `hour_of_day` as the GROUP BY key, and `ideal_out` as the
  // GENERATED additive form of the master rate — that column's own comment says
  // "sum(ideal_out) is correct at any grain; avg(ideal_rate_per_hour) is not",
  // which is the whole arithmetic problem solved at the schema level.
  //
  // WHAT IS SUMMED AND WHAT IS RECOMPUTED, because getting this wrong produces a
  // chart that reads perfectly:
  //
  //   total_out, effective_out, runtime   SUM. Additive by construction.
  //   ideal_rate_per_hour                 RECOMPUTED from sum(ideal_out) over the
  //                                       runtime that HAD a standard.
  //   actual_rate_per_hour                not selected at all — the browser
  //                                       derives it from total_out and runtime,
  //                                       as it does at every other grain.
  //
  // THE `FILTER` ON THE DENOMINATOR IS THE SUBTLE PART. `sum()` skips nulls, so
  // sum(ideal_out) covers only the rows that had a standard while sum(runtime)
  // covers all of them. Dividing one by the other would spread a known standard
  // across unknown time and understate the target — a target that is too low
  // makes performance loss shrink, which is the flattering direction. Dividing by
  // the runtime that actually carried a standard is the runtime-weighted mean of
  // the standard, and NULL when none was known anywhere in the month.
  //
  // ORDERED IN BUSINESS-DAY ORDER, not clock order. `(hour_of_day - dayStartHour
  // + 24) % 24` rotates 07:00 to the front, so the profile reads shift 1 -> 2 -> 3
  // rather than splitting the night shift across both ends of the chart. The
  // browser is sent `dayStartHour` so it can build the same rotation for the axis
  // without a copy of SHIFT_WINDOWS.
  async listPerfHourProfile({
    workUnitId,
    dateFrom,
    dateTo,
    dayStartHour,
  }: {
    workUnitId: number;
    dateFrom: string;
    dateTo: string;
    dayStartHour: number;
  }): Promise<HourProfileBucket[]> {
    return await traced("SELECT", TABLE_PRODUCT_PERF_WU_HOUR, async () => {
      const rows = await this.db<HourProfileBucket[]>`
        SELECT p.hour_of_day,
               p.product_id,
               min(p.product_name) AS product_name,
               min(p.product_code) AS product_code,
               min(p.uom_code)     AS uom_code,
               round(sum(p.total_out), 3)::float8     AS total_out,
               round(sum(p.effective_out), 3)::float8 AS effective_out,
               sum(p.runtime)::float8                 AS runtime,
               -- See the header: the denominator is the runtime that carried a
               -- standard, never the whole month's runtime.
               CASE
                 WHEN sum(p.runtime) FILTER (WHERE p.ideal_rate_per_hour IS NOT NULL) > 0
                 THEN round(
                        sum(p.ideal_out) * 3600000::numeric
                          / sum(p.runtime) FILTER (WHERE p.ideal_rate_per_hour IS NOT NULL),
                        6
                      )::float8
               END AS ideal_rate_per_hour
        FROM oee.product_perf_wu_hour p
        WHERE p.work_unit_id = ${workUnitId}
          AND p.business_date >= ${dateFrom}::date
          AND p.business_date <= ${dateTo}::date
        GROUP BY p.hour_of_day, p.product_id
        ORDER BY ((p.hour_of_day - ${dayStartHour}::int + 24) % 24) ASC,
                 min(p.product_name) ASC,
                 p.product_id ASC
      `;

      return [...rows];
    });
  }

  // The per-SKU breakdown at day or month grain, both from
  // oee.product_count_wu_day. There is no product_count_wu_month, and counts are
  // additive, so a month is that table summed over its days.
  //
  // NO ZONE CONVERSION, unlike listProductCount above. That one joins through
  // `(r.date AT TIME ZONE $tz)::date` because the shift report stores an instant
  // and the count table stores a business day. Here both sides are already
  // `date` columns — which is the whole payoff of 0013 — so the join is a plain
  // range and pk_product_count_wu_day serves it.
  //
  // WHAT IS SUMMED, AND WHAT MUST NOT BE. total_out, reject and rework are summed
  // AFTER multiplying by factor_to_base, so a product counted in CARTON one day
  // and BAG the next still adds up in base units. Summing the raw counters would
  // add 12 cartons to 12 bags and report 24 of nothing — silent, and it renders
  // as a plausible SKU total.
  //
  // `good_out` is the exception, here as in the shift query: it stays UNSCALED
  // and is labelled in uom_code. That means it cannot be summed across differing
  // units at all — so uom_code and base_uom_code are in the GROUP BY, and a
  // product that changed pack size mid-month comes back as TWO rows rather than
  // one wrong one. Two honest rows are a question a supervisor can answer; one
  // wrong number is not.
  async listPeriodProductCount(grain: PeriodGrain, reportId: number): Promise<ProductCountItem[]> {
    return await traced("SELECT", TABLE_PRODUCT_COUNT_WU_DAY, async () => {
      const span = grain === "day" ? this.db`interval '1 day'` : this.db`interval '1 month'`;

      const rows = await this.db<ProductCountItem[]>`
        SELECT p.product_id,
               min(p.product_name) AS product_name,
               min(p.product_code) AS product_code,
               p.uom_code, p.base_uom_code,
               round(sum(p.total_out * p.factor_to_base), 3)::float8 AS total_out,
               round(sum(p.good_out)::numeric, 3)::float8            AS good_out,
               round(sum(p.reject * p.factor_to_base), 3)::float8    AS reject,
               round(sum(p.rework * p.factor_to_base), 3)::float8    AS rework
        FROM ${this.grainFrom(grain)} r
        JOIN oee.product_count_wu_day p
          ON p.work_unit_id = r.work_unit_id
         AND p.date >= r.business_date
         AND p.date <  r.business_date + ${span}
        WHERE r.id = ${reportId}
        GROUP BY p.product_id, p.uom_code, p.base_uom_code
        ORDER BY min(p.product_name) ASC, p.product_id ASC
      `;

      return [...rows];
    });
  }

  // The month's daily OEE curve, for the OEE Performance dashboard.
  //
  // MONTH GRAIN ONLY, and there is no day-grain twin — a day has no days inside
  // it to trend. The handler registers this beside hour-profile in the `else`
  // arm for that reason.
  //
  // The arithmetic and the boundary rule live in shared/oee-trend.ts, which two
  // other modules call with their own tables. All this supplies is which tables
  // and which scope column, as hardcoded fragments plus one bare column name.
  async listMonthOeeTrend(reportId: number): Promise<OeeTrendPoint[]> {
    return await listOeeTrend(this.db, {
      innerTable: GRAIN_TABLE.day,
      outerFrom: this.grainFrom("month"),
      innerFrom: this.grainFrom("day"),
      span: this.grainSpan("month"),
      scopeColumn: "work_unit_id",
      reportId,
    });
  }

  // THE YEAR'S MONTHLY CURVE — the same statement one grain up, so it reads the
  // MONTH table under a YEAR row.
  //
  // TWELVE POINTS, NOT ~365. A year trending days would put a four-series chart
  // over 365 x-positions, which is a smear rather than a reading — and each of
  // these points drills into a month screen that exists.
  //
  // NOT A ROLL-UP, AND THAT IS WORTH SAYING HERE because this one reads a table
  // whose rows the year row also summarises. Each point is the PIPELINE's own
  // recomputed rate for that month, read as stored. Averaging twelve of them would
  // not give the year row above the chart, which is the whole of §15.5 and the
  // reason `oee.work_unit_year_reports` exists at all.
  async listYearOeeTrend(reportId: number): Promise<OeeTrendPoint[]> {
    return await listOeeTrend(this.db, {
      innerTable: GRAIN_TABLE.month,
      outerFrom: this.grainFrom("year"),
      innerFrom: this.grainFrom("month"),
      span: this.grainSpan("year"),
      scopeColumn: "work_unit_id",
      reportId,
    });
  }

  // The watermark for the day table the trend reads. Separate from
  // getProductCountWatermark because they are different tables loaded by
  // different models, and reusing one would make a stale trend claim the
  // freshness of a product count.
  async getDayReportWatermark(): Promise<string | null> {
    return await getWatermark(this.db, WATERMARK_WU_DAY_REPORTS);
  }

  async getMonthReportWatermark(): Promise<string | null> {
    return await getWatermark(this.db, WATERMARK_WU_MONTH_REPORTS);
  }

  // The instant range a day or month covers. The twin of getShiftWindow above,
  // delegating to the same shared function so the three grains cannot disagree
  // about where a business day begins.
  async getPeriodWindow(
    grain: CoarseGrain,
    businessDate: string,
    timeZone: string,
  ): Promise<ShiftWindow> {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      return await resolveReportWindow(this.db, grain, businessDate, undefined, timeZone);
    });
  }

  // Enough to build the window. Unlike the shift path's getReportScope, this
  // needs no mes-master-data call afterwards: 0013 put business_date and
  // time_zone on the row, so the zone is read rather than resolved.
  async getPeriodReportScope(
    grain: CoarseGrain,
    id: number,
  ): Promise<PeriodReportScope | undefined> {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      const rows = await this.db<PeriodReportScope[]>`
        -- to_char, not the bare column: postgres.js parses a date column into a
        -- JS Date, and handing that to resolveReportWindow would put a zone back
        -- into the one value that exists to be free of one.
        SELECT work_unit_id, work_center_id,
               to_char(business_date, 'YYYY-MM-DD') AS business_date, time_zone
        FROM ${this.grainFrom(grain)}
        WHERE id = ${id}
        LIMIT 1
      `;

      return rows[0];
    });
  }

  // How many shift reports fall inside a window, and how many are approved.
  //
  // THIS IS NOT AN APPROVAL AND MUST NOT BE RENDERED AS ONE. It is a count over
  // three other records, which is why it comes back as two numbers rather than a
  // status: the day screen says "2 of 3 shifts approved", and there is no
  // sign-off on the day itself to report.
  //
  // Bounded on `r.date`, the shift's START instant, against the window's own
  // timestamptz bounds — a shift starts inside exactly one day and one month, so
  // this neither double-counts shift 3 nor drops it.
  async summariseApprovalsInWindow({
    workUnitId,
    from,
    to,
  }: {
    workUnitId: number;
    from: Date;
    to: Date;
  }): Promise<PeriodApprovalSummary> {
    return await traced("SELECT", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      const rows = await this.db<PeriodApprovalSummary[]>`
        SELECT count(r.id)::int AS shifts_total,
               -- The ABSENCE of an approval row means open (0010), so this counts
               -- 'closed' explicitly rather than counting non-null joins.
               count(a.status) FILTER (WHERE a.status = 'closed')::int AS shifts_closed
        FROM oee.work_unit_shift_reports r
        LEFT JOIN oee.work_unit_shift_report_approvals a
               ON a.work_unit_id = r.work_unit_id
              AND a.date         = r.date
              AND a.shift        = r.shift
        WHERE r.work_unit_id = ${workUnitId}
          AND r.date >= ${from}
          AND r.date <  ${to}
      `;

      return rows[0] ?? { shiftsTotal: 0, shiftsClosed: 0 };
    });
  }

  // The month/year filter, on `business_date` rather than on the `date` instant.
  //
  // THIS IS WHY 0013 ADDED THE COLUMN. The shift list's periodFilter compares
  // against a timestamptz and cannot resolve a zone — it spans many work units in
  // one query — so it is exact for a UTC+7 plant and misattributes both ends of
  // the month anywhere west of Greenwich (TODOS.md §17). A real `date` column
  // makes the same filter exact everywhere, and sargable against
  // wu_{day,month}_report_business_date_idx.
  //
  // ONE CONSEQUENCE WORTH KNOWING: a row whose business_date the pipeline has not
  // written is invisible to a month or year filter, though it still appears in an
  // unfiltered list. gold-write-contract §15.2 asks for the column on every row;
  // until that lands, a filtered list can be shorter than an unfiltered one.
  private businessDateFilter({ month, year }: WorkUnitPeriodReportFilter): Fragment {
    if (year !== undefined && month !== undefined) {
      return this.db`
        AND r.business_date >= make_date(${year}, ${month}, 1)
        AND r.business_date < make_date(${year}, ${month}, 1) + interval '1 month'
      `;
    }

    if (year !== undefined) {
      return this.db`
        AND r.business_date >= make_date(${year}, 1, 1)
        AND r.business_date < make_date(${year}, 1, 1) + interval '1 year'
      `;
    }

    if (month !== undefined) {
      return this.db`AND extract(month from r.business_date) = ${month}`;
    }

    return this.db``;
  }

  private periodFilter({ month, year }: WorkUnitShiftReportFilter): Fragment {
    if (year !== undefined && month !== undefined) {
      return this.db`
        AND r.date >= make_date(${year}, ${month}, 1)
        AND r.date < make_date(${year}, ${month}, 1) + interval '1 month'
      `;
    }

    if (year !== undefined) {
      // `+ interval '1 year'` rather than `${year} + 1`: an untyped parameter in
      // an arithmetic expression risks "operator is not unique".
      return this.db`
        AND r.date >= make_date(${year}, 1, 1)
        AND r.date < make_date(${year}, 1, 1) + interval '1 year'
      `;
    }

    if (month !== undefined) {
      // A month with no year means that month across every year. Not sargable,
      // but it is the only correct reading. Qualified so the parser cannot read
      // `date` as the start of a type literal inside extract().
      return this.db`AND extract(month from r.date) = ${month}`;
    }

    return this.db``;
  }

  // `status=open` / `status=closed`, as a semi- or anti-join.
  //
  // THE POLARITY IS THE TRAP, and it is not symmetric. `0010`'s rule is that the
  // ABSENCE of an approval row means open, so:
  //
  //   closed  ->  EXISTS     (... AND a.status = 'closed')
  //   open    ->  NOT EXISTS (... AND a.status = 'closed')
  //
  // `open` is emphatically NOT `EXISTS (... AND a.status = 'open')`. That spelling
  // reads correctly, passes review, and hides every report nobody has ever touched
  // — which is nearly all of them. It would answer "which reports has somebody
  // explicitly reopened", a question nobody asked, and the failure is a SHORTER
  // list rather than an error.
  //
  // EXISTS rather than a LEFT JOIN with `a.status IS NULL`: a semi-join cannot
  // duplicate a report row even if the approvals table ever grew a second row per
  // key, and it keeps `count(r.id)` honest without a DISTINCT.
  private statusFilter({ status }: WorkUnitShiftReportFilter): Fragment {
    if (status === undefined) return this.db``;

    const closed = this.db`
      SELECT 1
      FROM oee.work_unit_shift_report_approvals a
      WHERE a.work_unit_id = r.work_unit_id
        AND a.date         = r.date
        AND a.shift        = r.shift
        AND a.status       = 'closed'
    `;

    return status === "closed"
      ? this.db`AND EXISTS (${closed})`
      : this.db`AND NOT EXISTS (${closed})`;
  }
}

// ---------------------------------------------------------------------------
// The WRITE side
// ---------------------------------------------------------------------------
//
// A SEPARATE INTERFACE, not three more methods on WorkUnitReportReader. The
// Gold pool is read-WRITE — `tierPool(config.database.gold, ..., false)` in
// infra-module.ts — so nothing physical stops a reader issuing an UPDATE. The
// type name is the only guard there is, and it is worth having: until this file
// existed, "the repository layer is a reader interface" was load-bearing enough
// that apps/web quoted it in a comment.

type CloseShiftReportInput = {
  reportId: number;
  // The Keycloak subject. NOT current_user — the pool connects as one shared
  // role, so the database cannot name the person. See 0007's header and §21.
  closedBy: string;
  // preferred_username at closing time; display only.
  closedByName: string | null;
};

// Reopening takes the SAME input, and the field names are deliberately not
// renamed to something neutral like `actorSubject`.
//
// They describe the columns being written, and on a reopen those columns are
// CLEARED — ck_wusra_open in 0010 requires closed_at / closed_by /
// closed_by_name / source to be NULL on an open row, so a stale approver cannot
// linger on a reopened report. What the subject is actually used for here is the
// EVENT row, which is the only durable record of who undid the sign-off.
type ReopenShiftReportInput = CloseShiftReportInput;

type WorkUnitReportWriter = {
  closeShiftReport: (input: CloseShiftReportInput) => Promise<CloseShiftReportOutcome>;
  reopenShiftReport: (input: ReopenShiftReportInput) => Promise<ReopenShiftReportOutcome>;
};

type WorkUnitReportWriterRepositoryDeps = {
  goldDb: GoldDB;
};

// The row the upsert's RETURNING clause produces.
type ApprovalRow = {
  status: ApprovalStatus;
  closedAt: Date | null;
  closedBy: string | null;
  closedByName: string | null;
  source: ApprovalSource | null;
};

class WorkUnitReportWriterRepository implements WorkUnitReportWriter {
  private db: GoldDB;

  constructor({ goldDb }: WorkUnitReportWriterRepositoryDeps) {
    this.db = goldDb;
  }

  // open -> closed, attributed to a person.
  //
  // ONE TRANSACTION, THREE STATEMENTS, and each one is there for a reason that
  // is not obvious:
  //
  //   1. set_config(application_name) — so oee.write_audit can separate this
  //      service's handful of operator writes from its thousands of reads.
  //      SET LOCAL semantics, so it reverts at COMMIT and the pooled connection
  //      does not mislabel the next request. See asOperator in postgres.ts.
  //   2. The existence check — SEPARATE, and this is the subtle one. Folding it
  //      into the upsert as `INSERT ... SELECT ... WHERE id = $1` would make a
  //      missing report and an already-closed report BOTH produce zero rows, and
  //      404 and 409 would become indistinguishable.
  //   3. The conditional upsert, whose ROW COUNT is the outcome:
  //        no row existed      -> INSERT fires        -> 1 row -> closed
  //        row existed, open   -> DO UPDATE fires     -> 1 row -> closed
  //        row existed, closed -> the WHERE drops it  -> 0 rows -> already_closed
  //   4. The event row, in the SAME transaction. TODOS.md §21's rule: "A trail
  //      that can disagree with the row it describes is worse than none."
  //
  // CONCURRENCY NEEDS NO LOCK. Two simultaneous approves serialise on
  // pk_wu_shift_report_approvals; the loser blocks until the winner commits, then
  // takes the DO UPDATE path, whose WHERE now sees 'closed' and yields 0 rows.
  // No lost update, no duplicate row, no advisory lock, and no SELECT-then-INSERT
  // race — which is why this is an upsert rather than a read-modify-write.
  //
  // A CONCURRENT PIPELINE RUN IS THE DESIGN'S PAYOFF, NOT A HAZARD. If dbt
  // deletes and re-inserts the report row mid-request, the approval is keyed on
  // (work_unit_id, date, shift) — which the same run restates — so it reattaches
  // to the new row and its new id. Approval state on the report row would have
  // silently lost it. That is what 0010's header is about.
  async closeShiftReport({
    reportId,
    closedBy,
    closedByName,
  }: CloseShiftReportInput): Promise<CloseShiftReportOutcome> {
    return await traced("INSERT", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      return await this.db.begin(async (tx) => {
        await asOperator(tx);

        // Statement 2. Also yields the natural key, which is the only way to
        // address the approval — see 0010.
        const scope = await tx<ShiftReportKey[]>`
          SELECT work_unit_id, date, shift
          FROM oee.work_unit_shift_reports
          WHERE id = ${reportId}
          LIMIT 1
        `;
        const key = scope[0];
        if (key === undefined) return { kind: "not_found" as const };

        // Statement 3. `AS a` is required, not stylistic: the DO UPDATE ... WHERE
        // clause must reference the EXISTING row, and it can only do that through
        // the table's alias — the schema-qualified name is not a valid reference
        // there.
        //
        // now() is transaction_timestamp(), so closed_at and the event row's `at`
        // are the same instant rather than merely close together.
        const closed = await tx<ApprovalRow[]>`
          INSERT INTO oee.work_unit_shift_report_approvals AS a
            (work_unit_id, date, shift, status, source, closed_at, closed_by, closed_by_name)
          VALUES (
            ${key.workUnitId}, ${key.date}, ${key.shift},
            'closed', 'operator', now(), ${closedBy}, ${closedByName}
          )
          ON CONFLICT (work_unit_id, date, shift) DO UPDATE
             SET status         = 'closed',
                 source         = excluded.source,
                 closed_at      = excluded.closed_at,
                 closed_by      = excluded.closed_by,
                 closed_by_name = excluded.closed_by_name
           WHERE a.status = 'open'
          RETURNING status, closed_at, closed_by, closed_by_name, source
        `;

        const approval = closed[0];
        if (approval === undefined) return { kind: "already_closed" as const };

        // Statement 4. `from_status` is 'open' by construction — the WHERE above
        // admits no other prior state, and ck_wusrae_moves would reject a
        // no-op — so this needs no extra read to discover it.
        await tx`
          INSERT INTO oee.work_unit_shift_report_approval_events
            (work_unit_id, date, shift, by_subject, by_name, from_status, to_status, source)
          VALUES (
            ${key.workUnitId}, ${key.date}, ${key.shift},
            ${closedBy}, ${closedByName}, 'open', 'closed', 'operator'
          )
        `;

        return { kind: "closed" as const, approval };
      });
    });
  }

  // closed -> open. The exact mirror of the method above, and the differences
  // are the interesting part.
  //
  // NO INSERT PATH, hence UPDATE rather than the upsert closeShiftReport uses.
  // Absence of a row IS the open state (0010), so there is nothing to insert: a
  // report with no approval row is already open, and the row count says so.
  //
  //   row exists, closed -> the UPDATE fires   -> 1 row -> reopened
  //   row exists, open   -> the WHERE drops it -> 0 rows -> already_open
  //   no row at all      -> nothing to update  -> 0 rows -> already_open
  //
  // The last two collapsing into one outcome is correct rather than a compromise:
  // both mean "this report was not closed", which is the only thing a 409 here
  // has to say. The existence check above it is what keeps 404 distinguishable —
  // and it is a check on the REPORT, not on the approval.
  //
  // ALL FOUR CLOSURE COLUMNS ARE CLEARED, not just status. ck_wusra_open
  // requires it, so getting this wrong is a constraint violation rather than a
  // stale approver silently surviving on a reopened report — which is exactly
  // why the constraint is written that way.
  //
  // The event row records from_status 'closed', which is 'closed' by
  // construction: the WHERE admits no other prior state. So the Log Activity
  // panel renders a reopen with NO change at all — it already reads
  // from_status/to_status off the event table rather than inferring a direction.
  async reopenShiftReport({
    reportId,
    closedBy,
    closedByName,
  }: ReopenShiftReportInput): Promise<ReopenShiftReportOutcome> {
    return await traced("UPDATE", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      return await this.db.begin(async (tx) => {
        await asOperator(tx);

        const scope = await tx<ShiftReportKey[]>`
          SELECT work_unit_id, date, shift
          FROM oee.work_unit_shift_reports
          WHERE id = ${reportId}
          LIMIT 1
        `;
        const key = scope[0];
        if (key === undefined) return { kind: "not_found" as const };

        const reopened = await tx<ApprovalRow[]>`
          UPDATE oee.work_unit_shift_report_approvals
             SET status         = 'open',
                 source         = NULL,
                 closed_at      = NULL,
                 closed_by      = NULL,
                 closed_by_name = NULL
           WHERE work_unit_id = ${key.workUnitId}
             AND date         = ${key.date}
             AND shift        = ${key.shift}
             AND status       = 'closed'
          RETURNING status, closed_at, closed_by, closed_by_name, source
        `;

        const approval = reopened[0];
        if (approval === undefined) return { kind: "already_open" as const };

        await tx`
          INSERT INTO oee.work_unit_shift_report_approval_events
            (work_unit_id, date, shift, by_subject, by_name, from_status, to_status, source)
          VALUES (
            ${key.workUnitId}, ${key.date}, ${key.shift},
            ${closedBy}, ${closedByName}, 'closed', 'open', 'operator'
          )
        `;

        return { kind: "reopened" as const, approval };
      });
    });
  }
}

export { WorkUnitReportReaderRepository, WorkUnitReportWriterRepository };
export type {
  ApprovalByKey,
  ApprovalTransitionRow,
  CloseShiftReportInput,
  DowntimeHistoryRow,
  ListOverlappingApprovalsInput,
  ListPerfHoursInput,
  ListShiftHistoryInput,
  OverlappingApproval,
  PageApprovalKey,
  ReopenShiftReportInput,
  ReportScope,
  ShiftDowntimeHistory,
  ShiftReportKey,
  WorkUnitReportReader,
  WorkUnitReportReaderRepositoryDeps,
  WorkUnitReportWriter,
  WorkUnitReportWriterRepositoryDeps,
};
