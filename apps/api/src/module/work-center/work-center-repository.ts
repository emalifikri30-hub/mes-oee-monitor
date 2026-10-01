import { asOperator, traced } from "../../shared/database/postgres.js";
// The header area picker's predicate, shared by all four report subjects.
import { areaScope } from "../../shared/area-scope.js";
import { getWatermark } from "../../shared/database/watermark.js";
// The Losses page's two aggregates, shared with work-unit — see loss-aggregate.ts
// for why they moved and what the move deliberately did NOT change.
import { aggregateEventPairs, aggregateRejectRows } from "../../shared/loss-aggregate.js";
// The daily OEE curve under a month report, shared with work-unit and area — all
// three have both a month and a day table, so there were three callers on day one.
import { listOeeTrend } from "../../shared/oee-trend.js";

import type { OeeTrendPoint } from "../../shared/oee-trend.js";
import type {
  ListWorkCenterReportInput,
  PagedWorkCenterReport,
  CoarseGrain,
  ReportGrain,
  WorkCenterReport,
  WorkCenterReportFilter,
  WorkCenterReportListRow,
} from "./work-center.js";
import type { GoldDB, TransactionDB } from "../../shared/database/postgres.js";
import type {
  LinePerfHourBucket,
  CascadeInput,
  CascadeOutcome,
  LineActivityEntry,
  LineMachineBreakdown,
  LineActivityWindow,
  LineShiftKey,
  LineWindow,
} from "./work-center.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";
import type { ProductCountItem } from "../../shared/product-count.js";
import type { Fragment } from "postgres";
import { inDateRange, scopedRows } from "../../shared/report-window.js";

type WorkCenterReportReader = {
  paginateReport: (input: ListWorkCenterReportInput) => Promise<PagedWorkCenterReport>;
  getReport: (
    grain: ReportGrain | CoarseGrain,
    id: number,
  ) => Promise<WorkCenterReport | undefined>;
  // The month's daily OEE curve, for the OEE Performance dashboard. MONTH ONLY —
  // no grain parameter, because a shift and a day have no days inside them.
  listMonthOeeTrend: (reportId: number) => Promise<OeeTrendPoint[]>;
  listYearOeeTrend: (reportId: number) => Promise<OeeTrendPoint[]>;
  listApprovalTransitions: (window: LineActivityWindow) => Promise<LineActivityEntry[]>;
  // How many machine shift reports the feed's window covers — the approval arm's
  // `totalMembers`. THROUGH THE SAME FRAGMENT THE ARM ABOVE JOINS AGAINST, so the
  // count and the rows cannot describe different sets.
  countMachineReports: (window: LineActivityWindow) => Promise<number>;
  listDowntimeEdits: (window: LineActivityWindow) => Promise<{
    entries: LineActivityEntry[];
    totalMembers: number;
    trackedMembers: number;
  }>;
  getCategoryEditedAt: (window: LineActivityWindow) => Promise<Date | null>;
  listProductCount: (grain: ReportGrain, window: LineWindow) => Promise<ProductCountItem[]>;
  listMachineBreakdown: (
    grain: ReportGrain,
    window: LineWindow,
    instants: { from: Date; to: Date },
  ) => Promise<LineMachineBreakdown[]>;
  listPerfHours: (window: LineWindow) => Promise<LinePerfHourBucket[]>;
  listHourProfile: (window: LineWindow, dayStartHour: number) => Promise<LinePerfHourBucket[]>;
  getPerfWatermark: () => Promise<string | null>;
  aggregateRejectReasons: (window: LineWindow) => Promise<RejectAggregate>;
  aggregateDowntimeEventReasons: (window: LineWindow) => Promise<DowntimeEventAggregate>;
};

type WorkCenterReportWriter = {
  closeLineShift: (input: CascadeInput) => Promise<CascadeOutcome>;
  reopenLineShift: (input: CascadeInput) => Promise<CascadeOutcome>;
  summariseLineShift: (key: LineShiftKey) => Promise<CascadeOutcome>;
};

type WorkCenterReportReaderRepositoryDeps = {
  goldDb: GoldDB;
};

// Span names only — never interpolated into SQL. The FROM clause comes from
// grainFrom() below, which builds literal fragments; this map exists so a trace
// says which table answered. Same idiom as work-unit's GRAIN_TABLE and downtime's
// SCOPE_COLUMN.
const GRAIN_TABLE = {
  shift: "oee.work_center_shift_reports",
  day: "oee.work_center_day_reports",
  month: "oee.work_center_month_reports",
  year: "oee.work_center_year_reports",
} as const;

// Span names for Part 2's two grain-dependent reads. Note the product-count pair
// serves THREE grains from TWO tables — the day table answers month as well, by
// being widened — so the trace says which table actually answered.
const PRODUCT_COUNT_TABLE = {
  shift: "oee.product_count_wc_shift",
  day: "oee.product_count_wc_day",
  month: "oee.product_count_wc_day",
} as const;

const MACHINE_TABLE = {
  shift: "oee.work_unit_shift_reports",
  day: "oee.work_unit_day_reports",
  month: "oee.work_unit_month_reports",
} as const;

// NO ROW-SHAPE TYPE AND NO MAPPER HERE, DELIBERATELY.
//
// createPostgresDb sets `transform: postgres.camel`, so the driver renames every
// column on the way out — `business_date` arrives as `businessDate`. The SQL below
// therefore aliases in snake_case (which is what the columns are called) and the
// query is typed directly as the domain row.
//
// A hand-written snake_case mapper was here first and every field it produced was
// `undefined`. THE UNIT SUITE COULD NOT SEE IT: fakeSql returns whatever rows the
// test hands it, so the mapper was being tested against its own assumption. The
// integration suite caught it on the first run, which is the entire argument for
// that file existing.

// ONE IMPLEMENTATION OVER THREE TABLES.
//
// The three work_center_* report tables differ by exactly one column (`shift`),
// which is why a single paginateReport can serve all of them where work-unit
// needs a separate path for its shift grain. Everything else — the projection,
// the business-date filter, the ordering, the paging — is identical.
class WorkCenterReportReaderRepository implements WorkCenterReportReader {
  private db: GoldDB;

  constructor({ goldDb }: WorkCenterReportReaderRepositoryDeps) {
    this.db = goldDb;
  }

  // The month's daily OEE curve. The arithmetic and the half-open boundary live
  // in shared/oee-trend.ts, which the machine and area modules call with their own
  // tables; all this supplies is which two and which scope column.
  async listMonthOeeTrend(reportId: number): Promise<OeeTrendPoint[]> {
    return await listOeeTrend(this.db, {
      innerTable: GRAIN_TABLE.day,
      outerFrom: this.grainFrom("month"),
      innerFrom: this.grainFrom("day"),
      span: this.db`interval '1 month'`,
      scopeColumn: "work_center_id",
      reportId,
    });
  }

  // THE YEAR'S MONTHLY CURVE — the same statement one grain up, reading the MONTH
  // table under a YEAR row. Twelve points rather than ~365, so the four series
  // stay readable and each point drills into a month screen that exists.
  //
  // NOT A ROLL-UP. Each point is the pipeline's own recomputed rate for that
  // month, read as stored; averaging twelve of them would not give the year row
  // above the chart, which is §15.5 and the reason `0027` exists.
  async listYearOeeTrend(reportId: number): Promise<OeeTrendPoint[]> {
    return await listOeeTrend(this.db, {
      innerTable: GRAIN_TABLE.month,
      outerFrom: this.grainFrom("year"),
      innerFrom: this.grainFrom("month"),
      span: this.db`interval '1 year'`,
      scopeColumn: "work_center_id",
      reportId,
    });
  }

  // The FROM clause for a grain, as a literal fragment.
  //
  // NOT `this.db(GRAIN_TABLE[grain])`: postgres.js escapes that as ONE identifier,
  // dot included, so it would look for a table literally named
  // `oee.work_center_day_reports` in the search path rather than
  // `work_center_day_reports` in schema `oee`. Three hardcoded fragments cannot be
  // injected into and read plainly.
  private grainFrom(grain: ReportGrain | CoarseGrain): Fragment {
    if (grain === "shift") return this.db`oee.work_center_shift_reports`;
    if (grain === "day") return this.db`oee.work_center_day_reports`;
    if (grain === "month") return this.db`oee.work_center_month_reports`;
    return this.db`oee.work_center_year_reports`;
  }

  // `shift` exists only on the shift table, so the projection differs by exactly
  // one column. Selected as a literal NULL at the coarse grains rather than
  // omitted, so all three come back the same shape and the mapper needs no branch.
  private grainShift(grain: ReportGrain | CoarseGrain): Fragment {
    return grain === "shift" ? this.db`r.shift` : this.db`NULL::smallint AS shift`;
  }

  // A shift predicate can ONLY be produced at shift grain. The coarse tables have
  // no such column, so a stray `shift` in the filter must not reach SQL — it would
  // be a 500 rather than the "accepted and ignored" the dto already produces by
  // dropping the key.
  private shiftFilter(grain: ReportGrain | CoarseGrain, filter: WorkCenterReportFilter): Fragment {
    if (grain !== "shift" || filter.shift === undefined) return this.db``;
    return this.db`AND r.shift = ${filter.shift}`;
  }

  // A plain column comparison, and an exact one.
  //
  // These tables key on `business_date`, a real `date`, so this is a genuine
  // date-to-date range: sargable against the unique index, and no session zone can
  // move a boundary. The work_unit SHIFT list's equivalent compares a timestamptz
  // and misattributes both ends of a month for any plant west of Greenwich
  // (TODOS §17/§46) — this grain never had that defect because it never had that
  // column.
  private businessDateFilter({ month, year }: WorkCenterReportFilter): Fragment {
    if (year !== undefined && month !== undefined) {
      return this.db`
        AND r.business_date >= make_date(${year}, ${month}, 1)
        AND r.business_date < make_date(${year}, ${month}, 1) + interval '1 month'
      `;
    }

    if (year !== undefined) {
      // `+ interval '1 year'` rather than `${year} + 1`: an untyped parameter in
      // an arithmetic expression risks "operator is not unique".
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

  async paginateReport({
    grain,
    limit,
    offset,
    filter,
  }: ListWorkCenterReportInput): Promise<PagedWorkCenterReport> {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      // Fragments built ONCE and shared by the page query and the count query, so
      // the two can never disagree about what is being counted. The tables have no
      // static predicate to anchor them, hence `WHERE TRUE` below.
      const from = this.grainFrom(grain);
      const periodSql = this.businessDateFilter(filter);
      const shiftSql = this.shiftFilter(grain, filter);

      // `work_center_id` IS the grain key, so this is a predicate rather than an
      // `IN` over ids resolved upstream. An unknown line matches nothing and the
      // caller gets an empty page — see WorkCenterReportFilter for why that is
      // right here and a 404 is right on /work-units/*.
      const workCenterSql =
        filter.workCenterId === undefined
          ? this.db``
          : this.db`AND r.work_center_id = ${filter.workCenterId}`;

      // The header area picker. It sits BESIDE the line filter rather than
      // replacing it — a page can be narrowed to one line inside the selected
      // area — and unlike `work_center_id` it reads a denormalised label, so a
      // row the pipeline has not attributed is excluded. See area-scope.ts.
      const areaSql = areaScope(this.db, filter.areaId);

      // THREE-VALUED, AND DELIBERATELY SO. `oee` is nullable on these tables (0/0
      // is real for a line that never ran), and `NULL <> 0` is NULL, not true — so
      // this hides a NULL-OEE row as well as a zero one. That is the right
      // outcome: an undefined row is an idle row, which is exactly what the filter
      // is for. Do NOT "fix" this into `IS DISTINCT FROM 0`.
      const hideZeroSql = filter.isHideZero === true ? this.db`AND r.oee <> 0` : this.db``;

      const [rows, totals] = await Promise.all([
        this.db<WorkCenterReportListRow[]>`
          SELECT r.id, ${grain}::text AS grain,
                 to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
                 r.time_zone,
                 ${this.grainShift(grain)},
                 r.work_center_id, r.work_center_name, r.work_center_code,
                 r.work_unit_count, r.expected_work_unit_count,
                 -- float8 after rounding, or postgres.js hands numeric back as
                 -- a STRING and the browser renders "100.000%" and sorts it
                 -- lexicographically.
                 round(r.oee::numeric, 3)::float8 AS oee,
                 round(r.availability::numeric, 3)::float8 AS availability,
                 round(r.performance::numeric, 3)::float8 AS performance,
                 round(r.quality::numeric, 3)::float8 AS quality
          FROM ${from} r
          WHERE TRUE ${periodSql} ${shiftSql} ${workCenterSql} ${areaSql} ${hideZeroSql}
          -- business_date first, because it is the column a reader is sorting by
          -- in their head. Descending shift within a day matches the By Shift
          -- list's reading order (3, 2, 1 -- most recent first). The id tiebreak
          -- last is what makes paging STABLE: without it a row can appear on two
          -- pages and another on none, which no test asserting "rows appear"
          -- would catch.
          ORDER BY r.business_date DESC ${this.grainShiftOrder(grain)}, r.id ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        this.db<{ value: number }[]>`
          SELECT count(r.id)::int AS value
          FROM ${from} r
          WHERE TRUE ${periodSql} ${shiftSql} ${workCenterSql} ${areaSql} ${hideZeroSql}
        `,
      ]);

      return { items: [...rows], totalElements: totals[0]?.value ?? 0 };
    });
  }

  // ONE ROW, EVERY MEASURE — the detail screen's payload.
  //
  // Modelled on work-unit-repository.ts's getPeriodReport, and the casts are the
  // load-bearing part rather than noise:
  //
  //   round(x::numeric, 3)::float8   postgres.js hands `numeric` back as a STRING.
  //                                  Without this the browser renders "100.000%"
  //                                  and sorts it lexicographically.
  //   x::float8                      same for `bigint`, which arrives as a string
  //                                  too and would concatenate rather than add.
  //
  // NOTHING IS COALESCED. Every nullable column reaches the browser as null, which
  // renders an em dash. A `coalesce(x, 0)` here would turn "the members disagreed"
  // and "the pipeline has not written it" into a measurement of zero.
  async getReport(
    grain: ReportGrain | CoarseGrain,
    id: number,
  ): Promise<WorkCenterReport | undefined> {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      const rows = await this.db<WorkCenterReport[]>`
        SELECT r.id, ${grain}::text AS grain,
               to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
               r.time_zone,
               ${this.grainShift(grain)},
               r.work_center_id, r.work_center_name, r.work_center_code,
               r.area_id, r.area_name,
               r.work_unit_count, r.expected_work_unit_count,
               -- BOTH TRIPLES, and never merged into one. A line consumes in one
               -- unit and ships in another; see WorkCenterReport for what merging
               -- them renders.
               r.infeed_uom_id, r.infeed_uom_name, r.infeed_uom_code,
               r.output_uom_id, r.output_uom_name, r.output_uom_code,
               round(r.teep::numeric, 3)::float8 AS teep,
               round(r.oee::numeric, 3)::float8 AS oee,
               round(r.availability::numeric, 3)::float8 AS availability,
               round(r.performance::numeric, 3)::float8 AS performance,
               round(r.quality::numeric, 3)::float8 AS quality,
               -- Infeed side.
               round(r.total_out::numeric, 3)::float8 AS total_out,
               round(r.reject::numeric, 3)::float8 AS reject,
               round(r.rework::numeric, 3)::float8 AS rework,
               round(r.line_out::numeric, 3)::float8 AS line_out,
               -- Output side.
               round(r.good_out::numeric, 3)::float8 AS good_out,
               round(r.effective_out::numeric, 3)::float8 AS effective_out,
               r.runtime::float8 AS runtime,
               r.availability_time::float8 AS availability_time,
               r.production_time::float8 AS production_time,
               r.pdt_time::float8 AS pdt_time,
               r.operating_time::float8 AS operating_time,
               r.updt_time::float8 AS updt_time,
               r.net_time::float8 AS net_time,
               r.reduce_speed_time::float8 AS reduce_speed_time,
               r.ms_time::float8 AS ms_time,
               r.value_added_time::float8 AS value_added_time,
               r.rework_time::float8 AS rework_time,
               r.reject_time::float8 AS reject_time,
               r.anomaly_time::float8 AS anomaly_time,
               r.up_speed_time::float8 AS up_speed_time,
               r.schedule_loss_time::float8 AS schedule_loss_time,
               -- Spelled correctly here AND in the database. 0014 never carried
               -- the availablity_loss_time (sic) wart that 0013 had to correct on
               -- the work_unit day and month tables.
               r.availability_loss_time::float8 AS availability_loss_time,
               r.performance_loss_time::float8 AS performance_loss_time,
               r.ms_loss_time::float8 AS ms_loss_time,
               r.reduce_speed_loss_time::float8 AS reduce_speed_loss_time,
               r.quality_loss_time::float8 AS quality_loss_time,
               r.mttr::float8 AS mttr,
               r.mtbf::float8 AS mtbf
        FROM ${this.grainFrom(grain)} r
        WHERE r.id = ${id}
        LIMIT 1
      `;

      return rows[0];
    });
  }

  // The machine reports this line report's window covers, as a fragment the
  // approval arm joins against AND the member count selects from. Same half-open
  // window as the cascade, for the same reason — see the writer's inWindow.
  //
  // THE SHIFT PREDICATE IS CONDITIONAL, and it is the only thing in the whole
  // activity read that varies by grain. A shift report narrows to its own shift;
  // a day or month report covers every shift its instant window contains, which
  // is 3N machine shift reports rather than N.
  //
  // ONE FRAGMENT FOR THE ROWS AND FOR THE COUNT is the point of it being a
  // fragment. The approval source's `totalMembers` says how many records COULD
  // carry a transition, and if that number came from a second predicate the panel
  // could report "3 of 12" over a join that had looked at 9.
  private machineReports({ workCenterId, from, to, shift }: LineActivityWindow): Fragment {
    return this.db`
      SELECT r.work_unit_id, r.work_unit_name, r.date, r.shift
      FROM oee.work_unit_shift_reports r
      WHERE r.work_center_id = ${workCenterId}
        AND r.date >= ${from}
        AND r.date < ${to}
        ${shift === null ? this.db`` : this.db`AND r.shift = ${shift}`}
    `;
  }

  // HOW MANY MACHINE SHIFT REPORTS THE WINDOW COVERS — the approval arm's
  // `totalMembers`, and every one of them can carry a transition, so the arm's two
  // counts are equal.
  //
  // A READER METHOD, WHERE THE SHIFT FEED USED TO REACH FOR THE WRITER'S
  // `summariseLineShift`. That method serves the /approval route and both writes
  // so a badge and a 409 can never disagree about what "all of them" meant — a
  // real constraint, and one the FEED has no part in. It also requires a shift,
  // because a cascade does; borrowing it here would have forced either a fourth
  // grain-shaped branch or a widening of the cascade's own key. At shift grain
  // this returns the same number through the same predicate.
  async countMachineReports(window: LineActivityWindow): Promise<number> {
    return await traced("SELECT", "oee.work_unit_shift_reports", async () => {
      const rows = await this.db<{ total: number }[]>`
        WITH members AS (${this.machineReports(window)})
        SELECT count(*)::int AS total FROM members
      `;

      return rows[0]?.total ?? 0;
    });
  }

  // EVERY APPROVAL TRANSITION ON THE LINE'S MACHINES, newest first.
  //
  // JOINED TO THE REPORTS RATHER THAN FILTERED ON work_unit_id ALONE. The events
  // table carries (work_unit_id, date, shift) but no work_center_id, so the join
  // is what scopes the feed to this line's shift — the events table carries no
  // work_center_id of its own, so without the join it would return every
  // transition those machines ever had.
  //
  // `work_unit_name` comes off the report row, not from mes-master-data: the
  // column is denormalised there (0003) and this read must make no upstream call.
  async listApprovalTransitions(window: LineActivityWindow): Promise<LineActivityEntry[]> {
    return await traced("SELECT", "oee.work_unit_shift_report_approval_events", async () => {
      const rows = await this.db<
        {
          id: string;
          at: Date;
          by: string | null;
          byName: string | null;
          fromStatus: string;
          toStatus: string;
          source: string;
          workUnitId: number;
          workUnitName: string | null;
          shift: number;
        }[]
      >`
        WITH members AS (${this.machineReports(window)})
        SELECT 'approval:' || e.id AS id, e.at,
               e.by_subject AS "by", e.by_name,
               e.from_status, e.to_status, e.source,
               m.work_unit_id, m.work_unit_name,
               -- OFF THE MEMBER ROW, not off the event. Both carry the shift and
               -- the join equates them, so either would do — the report row is
               -- chosen because it is the thing the feed is scoped BY, and because
               -- the work_unit_name beside it comes from that same row. One source
               -- for the whole label. (No backticks in a tagged template: one
               -- would end the string.)
               m.shift
        FROM oee.work_unit_shift_report_approval_events e
        JOIN members m
          ON m.work_unit_id = e.work_unit_id AND m.date = e.date AND m.shift = e.shift
        ORDER BY e.at DESC, e.id DESC
      `;

      // `shift` IS NULLED AT SHIFT GRAIN BY THE SERVICE, not here. The column is
      // always known; whether it is worth SAYING is a property of the feed's
      // grain, and that is the service's question — see getActivity.
      return rows.map((r) => ({ ...r, kind: "approval" as const }));
    });
  }

  // EVERY DOWNTIME EDIT ON THE LINE'S STOPS, plus the two counts that say what the
  // arm could ever show.
  //
  // `totalMembers` is the stops in the window; `trackedMembers` is those with a
  // source_event_id, which is the only thing oee.downtime_report_history can be
  // keyed by. A stop the pipeline never gave one cannot carry a trail at all, and
  // saying so per-arm is what stops an empty feed reading as "nothing happened".
  async listDowntimeEdits(window: LineActivityWindow): Promise<{
    entries: LineActivityEntry[];
    totalMembers: number;
    trackedMembers: number;
  }> {
    return await traced("SELECT", "oee.downtime_report_history", async () => {
      // SCOPED BY work_center_id, which oee.downtime_reports carries (0003) — and
      // which is now also what the approval arm above resolves through. ONE
      // definition of "this line's machines" across both arms, because two would
      // let them describe different sets while looking like one feed.
      const [entries, counts] = await Promise.all([
        this.db<
          {
            id: string;
            at: Date;
            by: string;
            sourceEventId: string;
            field: string;
            oldValue: unknown;
            newValue: unknown;
            workUnitId: number;
            workUnitName: string | null;
          }[]
        >`
          WITH members AS (
            SELECT d.source_event_id, d.work_unit_id, d.work_unit_name
            FROM oee.downtime_reports d
            WHERE d.work_center_id = ${window.workCenterId}
              AND d.start_at < ${window.to}
              AND coalesce(d.end_at, 'infinity'::timestamptz) > ${window.from}
              AND d.source_event_id IS NOT NULL
          )
          SELECT 'downtime:' || h.id AS id, h.changed_at AS at, h.changed_by AS "by",
                 h.source_event_id, h.field, h.old_value, h.new_value,
                 m.work_unit_id, m.work_unit_name
          FROM oee.downtime_report_history h
          JOIN members m ON m.source_event_id = h.source_event_id
          ORDER BY h.changed_at DESC, h.id DESC
        `,
        // count(*) FOR THE TOTAL AND count(source_event_id) FOR THE TRACKABLE
        // HALF — the count(*)-not-count(column) rule, which is the whole
        // distinction this pair exists to draw.
        this.db<{ total: number; tracked: number }[]>`
          SELECT count(*)::int AS total,
                 count(d.source_event_id)::int AS tracked
          FROM oee.downtime_reports d
          WHERE d.work_center_id = ${window.workCenterId}
            AND d.start_at < ${window.to}
            AND coalesce(d.end_at, 'infinity'::timestamptz) > ${window.from}
        `,
      ]);

      return {
        entries: entries.map((e) => ({ ...e, kind: "downtime" as const })),
        totalMembers: counts[0]?.total ?? 0,
        trackedMembers: counts[0]?.tracked ?? 0,
      };
    });
  }

  // WHEN A STOP ON THIS LINE LAST HAD ITS CATEGORY CHANGED, or null if none has.
  //
  // WHY ONLY `category`, of the four editable fields — the reason work-unit's
  // sibling gives, and it applies identically here. `reason`, `actions` and
  // `detail_reason` are read LIVE out of oee.downtime_reports by the Pareto and
  // the drawer, so an edit to them is reflected the moment it commits. `category`
  // moves time between schedule loss and availability loss, and those totals are
  // PRECOMPUTED by the pipeline into oee.work_center_shift_reports — so the OEE
  // tiles, the timeline strip and the waterfall keep showing the pre-edit split
  // until the pipeline recomputes.
  //
  // A FACT, NOT A VERDICT. It does not compare against oee.etl_watermarks, for
  // the reason work-unit's version sets out at length: that watermark is
  // TABLE-grained, so a run covering other days advances it past the edit without
  // recomputing THIS report — and a banner that cleared on it would clear while
  // the tiles were still wrong.
  async getCategoryEditedAt(window: LineActivityWindow): Promise<Date | null> {
    return await traced("SELECT", "oee.downtime_report_history", async () => {
      const rows = await this.db<{ editedAt: Date | null }[]>`
        WITH members AS (
          SELECT d.source_event_id
          FROM oee.downtime_reports d
          WHERE d.work_center_id = ${window.workCenterId}
            AND d.start_at < ${window.to}
            AND coalesce(d.end_at, 'infinity'::timestamptz) > ${window.from}
            AND d.source_event_id IS NOT NULL
        )
        SELECT max(h.changed_at) AS edited_at
        FROM oee.downtime_report_history h
        JOIN members m ON m.source_event_id = h.source_event_id
        WHERE h.field = 'category'
      `;

      return rows[0]?.editedAt ?? null;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Part 2's four reads
  // ───────────────────────────────────────────────────────────────────────────

  // SKU View's rows, from the 0016 tables.
  //
  // TWO TABLES OVER THREE GRAINS: the shift table answers shift grain, and the DAY
  // table answers both day and month by being widened over the window's range.
  // That is why 0016 creates two rather than three — listPeriodProductCount does
  // the same over the machine pair, and there is no product_count_wu_month either.
  //
  // `factor_to_base` IS APPLIED HERE AND NOWHERE ELSE, to total_out, reject and
  // rework — and deliberately NOT to good_out, because Finish Good stays in the
  // unit it was counted in. That pairing is the whole of ProductCountItem's
  // doctrine and the reason its two unit codes both ride on every row.
  //
  // GROUPED even at shift grain, where the primary key already makes each product
  // unique. One projection for three grains beats a branch, and the group key
  // carries `uom_code` and `base_uom_code` so a product whose unit CHANGED inside
  // the window comes back as two rows rather than one row summing unlike things.
  async listProductCount(grain: ReportGrain, window: LineWindow): Promise<ProductCountItem[]> {
    const table =
      grain === "shift" ? this.db`oee.product_count_wc_shift` : this.db`oee.product_count_wc_day`;

    return await traced("SELECT", PRODUCT_COUNT_TABLE[grain], async () => {
      const shiftSql =
        grain === "shift" && window.shift !== null
          ? this.db`AND p.shift = ${window.shift}`
          : this.db``;

      const rows = await this.db<ProductCountItem[]>`
        SELECT p.product_id,
               min(p.product_name) AS product_name,
               min(p.product_code) AS product_code,
               p.uom_code, p.base_uom_code,
               round(sum(p.total_out * p.factor_to_base), 3)::float8 AS total_out,
               round(sum(p.good_out)::numeric, 3)::float8            AS good_out,
               round(sum(p.reject * p.factor_to_base), 3)::float8    AS reject,
               round(sum(p.rework * p.factor_to_base), 3)::float8    AS rework
        FROM ${table} p
        WHERE p.work_center_id = ${window.workCenterId}
          AND ${inDateRange(this.db, this.db`p.business_date`, window)}
          ${shiftSql}
        GROUP BY p.product_id, p.uom_code, p.base_uom_code
        ORDER BY min(p.product_name) ASC, p.product_id ASC
      `;

      return [...rows];
    });
  }

  // Machine View's rows.
  //
  // ONE PREDICATE FOR ALL THREE GRAINS: `work_center_id` plus the INSTANT window.
  // Every one of the three work_unit_* report tables carries work_center_id — the
  // shift table since 0003, the other two since 0013 — so this read makes no
  // upstream call at any grain. An earlier draft of this file had a roster
  // argument and a comment about a "one asymmetry"; both were wrong, and
  // LineShiftKey records why.
  //
  // ON `date` AND NOT `business_date`, for the reason the cascade gives: 0013 added
  // business_date nullable and Airflow has not backfilled it (§46), so it is NULL
  // on the historical rows this mostly runs against. `date` is NOT NULL on all
  // three tables, and the instants come from resolveReportWindow — the one
  // statement of that arithmetic, so a DST boundary resolves once.
  async listMachineBreakdown(
    grain: ReportGrain,
    window: LineWindow,
    instants: { from: Date; to: Date },
  ): Promise<LineMachineBreakdown[]> {
    return await traced("SELECT", MACHINE_TABLE[grain], async () => {
      const table =
        grain === "shift"
          ? this.db`oee.work_unit_shift_reports`
          : grain === "day"
            ? this.db`oee.work_unit_day_reports`
            : this.db`oee.work_unit_month_reports`;

      const shiftSql =
        grain === "shift" && window.shift !== null
          ? this.db`AND r.shift = ${window.shift}`
          : this.db``;

      const rows = await this.db<LineMachineBreakdown[]>`
        SELECT r.id AS report_id,
               r.work_unit_id, r.work_unit_name, r.work_unit_code,
               r.uom_name,
               round(r.total_out::numeric, 3)::float8 AS total_out,
               round(r.good_out::numeric, 3)::float8  AS good_out,
               round(r.reject::numeric, 3)::float8    AS reject,
               round(r.rework::numeric, 3)::float8    AS rework,
               r.schedule_loss_time::float8     AS schedule_loss_time,
               r.availability_loss_time::float8 AS availability_loss_time,
               r.performance_loss_time::float8  AS performance_loss_time,
               r.ms_loss_time::float8           AS ms_loss_time,
               r.reduce_speed_loss_time::float8 AS reduce_speed_loss_time,
               r.quality_loss_time::float8      AS quality_loss_time
        FROM ${table} r
        WHERE r.work_center_id = ${window.workCenterId}
          AND r.date >= ${instants.from}
          AND r.date < ${instants.to}
          ${shiftSql}
        -- By NAME, so the card's order is the one a reader scans for. The id
        -- tiebreak makes it total: two machines sharing a denormalised name would
        -- otherwise swap places between identical requests.
        ORDER BY r.work_unit_name ASC NULLS LAST, r.work_unit_id ASC
      `;

      return [...rows];
    });
  }

  // The Quality Loss tab, over the line's machines. The arithmetic — including the
  // mixed-unit abstain, which fires FAR more often here than at machine grain — is
  // shared/loss-aggregate.ts's and is untouched.
  // The hourly buckets for one line report's window — shift and day grain.
  //
  // A HALF-OPEN business-date range plus an optional shift, the same LineWindow
  // every other Part 2 read takes, so none of them can disagree about which rows
  // belong to a report.
  //
  // NOT CONVERTED TO A BASE UNIT, matching listPerfHours' rule one table over: a
  // rate and its standard must share a unit, and converting the counts while
  // leaving the standard alone would put a numerator and its denominator in
  // different units.
  async listPerfHours(window: LineWindow): Promise<LinePerfHourBucket[]> {
    return await traced("SELECT", "oee.product_perf_wc_hour", async () => {
      const rows = await this.db<LinePerfHourBucket[]>`
        SELECT bucket_start, bucket_end, hour_of_day, shift_hour_seq,
               product_id, product_name, product_code,
               infeed_uom_code, output_uom_code,
               round(total_out::numeric, 3)::float8           AS total_out,
               round(good_out::numeric, 3)::float8            AS good_out,
               round(effective_out::numeric, 3)::float8       AS effective_out,
               runtime::float8                                AS runtime,
               round(ideal_rate_per_hour::numeric, 3)::float8 AS ideal_rate_per_hour
          FROM oee.product_perf_wc_hour
         WHERE work_center_id = ${window.workCenterId}
           AND business_date >= ${window.dateFrom}::date
           AND business_date <  ${window.dateTo}::date
           ${window.shift === null ? this.db`` : this.db`AND shift = ${window.shift}`}
         ORDER BY bucket_start ASC, product_name ASC, product_id ASC
      `;

      return [...rows];
    });
  }

  // A MONTH's hour-of-DAY profile: ~720 buckets collapsed to 24 per SKU.
  //
  // A DIFFERENT SHAPE, NOT A LONGER ONE, which is why month has its own route.
  // The key is a CLOCK HOUR that occurred ~30 times, not an instant — so the
  // measures SUM across the days and the rates are recomputed downstream from
  // those sums, never averaged (§15.5's rule, and §3.5 works the arithmetic).
  //
  // `ideal_rate_per_hour` is WEIGHTED BY RUNTIME rather than averaged, and only
  // over the runtime that CARRIED a standard: a month where half the days had no
  // standard must not have its target halved. That is the denominator trap the
  // machine month path already documents.
  //
  // ORDERED FROM THE PLANT'S DAY START, not from midnight: shift 3 runs 23:00 ->
  // 07:00, so a naive 0..23 ordering puts the day's first hour last.
  async listHourProfile(window: LineWindow, dayStartHour: number): Promise<LinePerfHourBucket[]> {
    return await traced("SELECT", "oee.product_perf_wc_hour", async () => {
      const rows = await this.db<LinePerfHourBucket[]>`
        SELECT min(p.bucket_start)                            AS bucket_start,
               max(p.bucket_end)                              AS bucket_end,
               p.hour_of_day,
               -- Meaningless in a profile — the same clock hour is a different
               -- position in different shifts — so it is pinned rather than
               -- aggregated into a number somebody might read.
               0                                              AS shift_hour_seq,
               p.product_id,
               min(p.product_name)                            AS product_name,
               min(p.product_code)                            AS product_code,
               -- ABSTAIN ON DISAGREEMENT, and the second half of each condition is
               -- the NULL-skipping trap §16.3(c) describes: count(DISTINCT x)
               -- SKIPS NULLs, so a profile mixing one mixed-unit hour with thirty
               -- BAG ones would report a confident BAG over a sum that silently
               -- dropped the mixed hour.
               CASE WHEN count(DISTINCT p.infeed_uom_code) = 1
                     AND count(p.infeed_uom_code) = count(*)
                    THEN min(p.infeed_uom_code) END           AS infeed_uom_code,
               CASE WHEN count(DISTINCT p.output_uom_code) = 1
                     AND count(p.output_uom_code) = count(*)
                    THEN min(p.output_uom_code) END           AS output_uom_code,
               round(sum(p.total_out), 3)::float8             AS total_out,
               round(sum(p.good_out), 3)::float8              AS good_out,
               round(sum(p.effective_out), 3)::float8         AS effective_out,
               sum(p.runtime)::float8                         AS runtime,
               -- Runtime-weighted, over the runtime that carried a standard.
               -- NULLIF guards a profile hour where nothing had one: that is a
               -- NULL target, not a zero.
               round(
                 sum(p.ideal_rate_per_hour * p.runtime)
                   / nullif(sum(p.runtime) FILTER (WHERE p.ideal_rate_per_hour IS NOT NULL), 0),
                 3
               )::float8                                      AS ideal_rate_per_hour
          FROM oee.product_perf_wc_hour p
         WHERE p.work_center_id = ${window.workCenterId}
           AND p.business_date >= ${window.dateFrom}::date
           AND p.business_date <  ${window.dateTo}::date
         GROUP BY p.hour_of_day, p.product_id
         ORDER BY ((p.hour_of_day - ${dayStartHour}::int + 24) % 24) ASC,
                  min(p.product_name) ASC,
                  p.product_id ASC
      `;

      return [...rows];
    });
  }

  // How far the pipeline has loaded 0018. A MISSING ROW MEANS NEVER LOADED, which
  // is the state today — the table ships empty — and is exactly what lets the
  // Trendline say so rather than drawing a flat line at zero.
  async getPerfWatermark(): Promise<string | null> {
    return await getWatermark(this.db, "product_perf_wc_hour");
  }

  // The Quality Loss Pareto.
  //
  // READS THE LINE'S OWN TABLE (0019), NOT THE MACHINES'. It used to read
  // oee.reject_count_wu_shift scoped by work_center_id — a machine-sum — and that
  // was wrong for the reason 0014, 0016 and 0018 all exist: a line is MEASURED,
  // not summed, so the machines' counters are a DIFFERENT measurement from the
  // line's own count points.
  //
  // The contradiction was two cards apart on one screen: the Losses card's Reject
  // tile reads work_center_shift_reports.reject and this ranked the machines. Two
  // right answers to one question, and nothing on the page to explain the gap.
  //
  // NO machineRows() HERE, which is the visible difference — this table is already
  // keyed by work_center_id, so there are no machines to scope through. The three
  // grains are served by widening one shift table over a business-date range,
  // exactly as the machine side widens its own.
  //
  // The AGGREGATE is unchanged and shared: the unit guards, the generated-column
  // read and the count(*)-not-count(column) rule stay in one statement each. That
  // is what aggregateRejectRows being parameterised BY A FRAGMENT buys — swapping
  // the source touched no arithmetic.
  async aggregateRejectReasons(window: LineWindow): Promise<RejectAggregate> {
    const shiftSql = window.shift === null ? this.db`` : this.db`AND j.shift = ${window.shift}`;

    return await aggregateRejectRows(
      this.db,
      // THE LINE'S OWN TABLE. This read was traced as `reject_count_wu_shift` — the
      // MACHINE table — until 2026-09-03, because the span name was a constant
      // inside the shared aggregate. It reads oee.reject_count_wc_shift and always
      // did; only the trace disagreed.
      TABLE_REJECT_COUNT_WC_SHIFT,
      this.db`
        SELECT j.*,
               -- NO MACHINE TO NAME, and the NULL is the honest answer rather
               -- than a gap. The shared aggregate projects work_unit_name as each
               -- bucket's machineName, which is meaningful when the rows ARE a
               -- machine's; these are the LINE's own count points, so there is no
               -- machine behind a bar and the Pareto shows an em dash.
               --
               -- Supplied HERE rather than by loosening the aggregate, which is
               -- what keeps that function identical for both subjects. (No
               -- backticks in this comment: it lives in a tagged template and one
               -- would terminate the string.)
               NULL::varchar AS work_unit_name
        FROM oee.reject_count_wc_shift j
        WHERE j.work_center_id = ${window.workCenterId}
          AND ${inDateRange(this.db, this.db`j.business_date`, window)}
          ${shiftSql}
      `,
    );
  }

  // The Others tab, on the same terms.
  async aggregateDowntimeEventReasons(window: LineWindow): Promise<DowntimeEventAggregate> {
    const events = scopedRows({
      db: this.db,
      table: this.db`oee.downtime_log_events`,
      window,
      dateColumn: this.db`j.shift_date`,
    });

    // The explode into (event, reason) pairs, which is what the shared aggregate
    // counts. DISTINCT because a reason repeated inside ONE event is one event —
    // the rule work-unit-repository.integration.test.ts pins on the machine side.
    return await aggregateEventPairs(
      this.db,
      TABLE_DOWNTIME_LOG_EVENTS,
      this.db`
        SELECT DISTINCT e.event_id, nullif(btrim(x.reason), '') AS reason
        FROM (${events}) e
        LEFT JOIN LATERAL unnest(e.reasons) AS x(reason) ON true
      `,
    );
  }

  private grainShiftOrder(grain: ReportGrain | CoarseGrain): Fragment {
    return grain === "shift" ? this.db`, r.shift DESC` : this.db``;
  }
}

// Span names for the cascade. It writes the WORK_UNIT approval tables, never the
// work_center_* ones — which is why 0014's trigger comment ("no operator mutation
// targets these three tables") is still true after this module gained a writer.
const TABLE_WU_SHIFT_REPORT_APPROVALS = "oee.work_unit_shift_report_approvals";
const TABLE_REJECT_COUNT_WC_SHIFT = "oee.reject_count_wc_shift";
const TABLE_DOWNTIME_LOG_EVENTS = "oee.downtime_log_events";

// THE LINE APPROVAL, WHICH IS N MACHINE APPROVALS.
//
// A line has no approval row of its own and cannot have one:
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift), and
// oee.work_center_shift_reports has no work_unit_id column at all (migration
// 0014). So approving a line means approving the machine shift reports on it, and
// its status is DERIVED by counting them.
//
// Three consequences of that choice, all of them good, and worth stating because
// the alternative (a work_center_shift_report_approvals table) looks tidier:
//
//   * There is ONE definition of "approved" in the app, not two that can disagree
//     on a partially-approved line.
//   * THE DOWNTIME FREEZE COMES FOR FREE. listApprovalsOverlapping already reads
//     these rows, and every stop carries work_unit_id — so a line's stops are
//     frozen by its own approval with no change to the downtime module at all.
//   * The audit trail is the existing append-only
//     oee.work_unit_shift_report_approval_events, one row per machine.
//
//                     approve a LINE shift report
//                                 |
//     [before the tx]   shift window from SQL        -- AT TIME ZONE, per date
//                       (no upstream call: work_center_id scopes the rows)
//                                 |
//     [inside the tx]   asOperator(tx)
//                       (1) count the machine reports in the window   -> found
//                       (2) ONE data-modifying CTE:
//                             upsert approvals ... WHERE a.status='open'
//                                                  RETURNING the keys
//                             -> insert one event per returned key
//                                                              -> closed
//                                 |
//                    found = 0            -> 404, nothing to approve
//                    closed = 0, found>0  -> 409, all already approved
//                    otherwise            -> 200, "closed of found"
class WorkCenterReportWriterRepository implements WorkCenterReportWriter {
  private db: GoldDB;

  constructor({ goldDb }: WorkCenterReportReaderRepositoryDeps) {
    this.db = goldDb;
  }

  // WHICH MACHINE REPORTS THE LINE'S SHIFT COVERS.
  //
  // SCOPED BY work_center_id, which oee.work_unit_shift_reports has carried as NOT
  // NULL since 0003 — so this needs no roster and makes no upstream call. See
  // LineShiftKey.
  //
  // A HALF-OPEN RANGE ON `date`, NOT `date = window.from`, and this is the guard
  // that matters most in this file. work_unit_shift_reports.date is the shift's
  // START INSTANT written by the pipeline; a row landing on a marginally
  // different instant would be SKIPPED by an equality match, and the cascade
  // would then approve four machines out of five and answer 200 with a summary
  // that looks entirely ordinary.
  //
  // NOT `business_date` either, which is the other tempting join. 0013 added that
  // column nullable and Airflow has not backfilled it (TODOS §46), so it is NULL
  // on the historical rows this will mostly run against — matching on it would
  // silently approve nothing at all.
  private inWindow({ workCenterId, from, to, shift }: LineShiftKey): Fragment {
    return this.db`
      r.work_center_id = ${workCenterId}
        AND r.date >= ${from}
        AND r.date < ${to}
        AND r.shift = ${shift}
    `;
  }

  // How many machine reports exist in the window, and how many are closed.
  //
  // Serves the /approval route AND the two writes' outcome, so a badge and a 409
  // can never disagree about what "all of them" meant.
  async summariseLineShift(key: LineShiftKey): Promise<CascadeOutcome> {
    return await traced("SELECT", "oee.work_unit_shift_reports", async () => {
      return await this.countIn(this.db, key);
    });
  }

  private async countIn(db: GoldDB | TransactionDB, key: LineShiftKey): Promise<CascadeOutcome> {
    // count(*) FOR THE TOTAL AND count(a.status) FOR THE CLOSED HALF — the
    // count(*)-not-count(column) rule, used deliberately in both directions. The
    // LEFT JOIN yields NULL for a machine with no approval row, which IS the open
    // state (0010), and count() skips those.
    const rows = await db<{ found: number; closed: number }[]>`
      SELECT count(*)::int AS found,
             count(a.status) FILTER (WHERE a.status = 'closed')::int AS closed
      FROM oee.work_unit_shift_reports r
      LEFT JOIN oee.work_unit_shift_report_approvals a
        ON a.work_unit_id = r.work_unit_id AND a.date = r.date AND a.shift = r.shift
      WHERE ${this.inWindow(key)}
    `;

    return { machinesFound: rows[0]?.found ?? 0, machinesClosed: rows[0]?.closed ?? 0 };
  }

  async closeLineShift(input: CascadeInput): Promise<CascadeOutcome> {
    return await traced("INSERT", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      return await this.db.begin(async (tx) => {
        // Stamps application_name for the oee.write_audit trigger, with SET LOCAL
        // semantics so it reverts at COMMIT — postgres.js pools connections, and a
        // leaked name would label a later pure read as an operator write.
        await asOperator(tx);

        const before = await this.countIn(tx, input);
        if (before.machinesFound === 0) return before;

        // ONE STATEMENT FOR N MACHINES, not a loop. Two reasons beyond the round
        // trips: the data-modifying CTE makes the event trail atomic with the
        // write BY CONSTRUCTION rather than by both being in the same transaction
        // (TODOS §21: "a trail that can disagree with the row it describes is
        // worse than none"), and `ORDER BY r.work_unit_id` gives every cascade the
        // same lock order, so two of them — or this one and the day cascade §48
        // asks for — cannot deadlock against each other.
        //
        // `WHERE a.status = 'open'` on the DO UPDATE is what makes this idempotent
        // AND what makes the outcome countable: a machine already closed is
        // dropped by that clause and never reaches RETURNING, so the returned rows
        // are exactly the machines this call changed. Approving a partially
        // approved line therefore closes only the open ones, which is precisely
        // the behaviour the screen offers.
        const closed = await tx<{ workUnitId: number }[]>`
          WITH closed AS (
            INSERT INTO oee.work_unit_shift_report_approvals AS a
              (work_unit_id, date, shift, status, source, closed_at, closed_by, closed_by_name)
            SELECT r.work_unit_id, r.date, r.shift,
                   'closed', 'operator', now(), ${input.closedBy}, ${input.closedByName}
            FROM oee.work_unit_shift_reports r
            WHERE ${this.inWindow(input)}
            ORDER BY r.work_unit_id
            ON CONFLICT (work_unit_id, date, shift) DO UPDATE
               SET status         = 'closed',
                   source         = excluded.source,
                   closed_at      = excluded.closed_at,
                   closed_by      = excluded.closed_by,
                   closed_by_name = excluded.closed_by_name
             WHERE a.status = 'open'
            RETURNING a.work_unit_id, a.date, a.shift
          )
          INSERT INTO oee.work_unit_shift_report_approval_events
            (work_unit_id, date, shift, by_subject, by_name, from_status, to_status, source)
          SELECT c.work_unit_id, c.date, c.shift,
                 ${input.closedBy}, ${input.closedByName}, 'open', 'closed', 'operator'
          FROM closed c
          RETURNING work_unit_id
        `;

        // `found` from before the write; `closed` is the whole set now closed —
        // the ones this call changed plus the ones that already were.
        return {
          machinesFound: before.machinesFound,
          machinesClosed: before.machinesClosed + closed.length,
        };
      });
    });
  }

  // closed -> open, across the same set. The mirror, and the differences are the
  // ones closeShiftReport's own comment sets out.
  //
  // NO INSERT PATH, hence UPDATE rather than an upsert: absence of a row IS the
  // open state (0010), so there is nothing to insert. ALL FOUR closure columns are
  // cleared, not just `status` — ck_wusra_open requires it, so getting this wrong
  // is a constraint violation rather than a stale approver quietly surviving.
  async reopenLineShift(input: CascadeInput): Promise<CascadeOutcome> {
    return await traced("UPDATE", TABLE_WU_SHIFT_REPORT_APPROVALS, async () => {
      return await this.db.begin(async (tx) => {
        await asOperator(tx);

        const before = await this.countIn(tx, input);
        if (before.machinesFound === 0) return before;

        const reopened = await tx<{ workUnitId: number }[]>`
          WITH reopened AS (
            UPDATE oee.work_unit_shift_report_approvals a
               SET status = 'open', source = NULL, closed_at = NULL,
                   closed_by = NULL, closed_by_name = NULL
             WHERE a.status = 'closed'
               AND (a.work_unit_id, a.date, a.shift) IN (
                 SELECT r.work_unit_id, r.date, r.shift
                 FROM oee.work_unit_shift_reports r
                 WHERE ${this.inWindow(input)}
                 ORDER BY r.work_unit_id
               )
            RETURNING a.work_unit_id, a.date, a.shift
          )
          INSERT INTO oee.work_unit_shift_report_approval_events
            (work_unit_id, date, shift, by_subject, by_name, from_status, to_status, source)
          SELECT r.work_unit_id, r.date, r.shift,
                 ${input.closedBy}, ${input.closedByName}, 'closed', 'open', 'operator'
          FROM reopened r
          RETURNING work_unit_id
        `;

        return {
          machinesFound: before.machinesFound,
          machinesClosed: before.machinesClosed - reopened.length,
        };
      });
    });
  }
}

export { GRAIN_TABLE, WorkCenterReportReaderRepository, WorkCenterReportWriterRepository };
export type { WorkCenterReportReader, WorkCenterReportWriter };
