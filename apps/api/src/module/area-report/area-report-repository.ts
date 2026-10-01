import { aggregateEventPairs, aggregateRejectRows } from "../../shared/loss-aggregate.js";
import { inDateRange } from "../../shared/report-window.js";
import { listOeeTrend } from "../../shared/oee-trend.js";
import { traced } from "../../shared/database/postgres.js";

import type { OeeTrendPoint } from "../../shared/oee-trend.js";
import type { GoldDB } from "../../shared/database/postgres.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";
import type { ProductCountItem } from "../../shared/product-count.js";
import type {
  AreaActivityEntry,
  AreaCoarseGrain,
  AreaInfeedBucket,
  AreaLines,
  AreaOutputBucket,
  AreaReport,
  AreaReportFilter,
  AreaReportListRow,
  AreaWindow,
  ListAreaReportInput,
  PagedAreaReport,
} from "./area-report.js";
import type { Fragment } from "postgres";

// Span names only — never interpolated into SQL. The FROM clause comes from
// `grainFrom()` below, which builds literal fragments; this map exists so a trace
// says which table answered. The same idiom as work-unit's GRAIN_TABLE,
// work-center's and downtime's SCOPE_COLUMN.
const GRAIN_TABLE = {
  day: "oee.area_day_reports",
  month: "oee.area_month_reports",
  year: "oee.area_year_reports",
} as const satisfies Record<AreaCoarseGrain, string>;
const TABLE_WORK_CENTER_DAY_REPORTS = "oee.work_center_day_reports";
const TABLE_PRODUCT_COUNT_WC_DAY = "oee.product_count_wc_day";
const TABLE_REJECT_COUNT_WC_SHIFT = "oee.reject_count_wc_shift";
const TABLE_DOWNTIME_LOG_EVENTS = "oee.downtime_log_events";
const TABLE_DOWNTIME_REPORT_HISTORY = "oee.downtime_report_history";

type AreaReportReaderRepositoryDeps = { goldDb: GoldDB };

type AreaReportReader = {
  paginateReport: (input: ListAreaReportInput) => Promise<PagedAreaReport>;
  getReport: (grain: AreaCoarseGrain, id: number) => Promise<AreaReport | undefined>;
  // The month's daily OEE curve, for the OEE Performance dashboard. MONTH ONLY —
  // no grain parameter, because a day has no days inside it to trend.
  listMonthOeeTrend: (reportId: number) => Promise<OeeTrendPoint[]>;
  listYearOeeTrend: (reportId: number) => Promise<OeeTrendPoint[]>;
  listAreaLines: (window: AreaWindow) => Promise<AreaLines>;
  listProductCount: (window: AreaWindow, lines: AreaLines) => Promise<ProductCountItem[]>;
  aggregateProductionUnits: (window: AreaWindow) => Promise<{
    infeed: AreaInfeedBucket[];
    output: AreaOutputBucket[];
    infeedUnresolved: number;
    outputUnresolved: number;
  }>;
  aggregateRejectReasons: (window: AreaWindow) => Promise<RejectAggregate>;
  aggregateDowntimeEventReasons: (window: AreaWindow) => Promise<DowntimeEventAggregate>;
  listDowntimeEdits: (window: AreaWindow) => Promise<{
    entries: AreaActivityEntry[];
    totalMembers: number;
    trackedMembers: number;
  }>;
};

// READS ONLY. There is no writer class in this module and there is nothing for one
// to do: an area report has no approval (oee.work_unit_shift_report_approvals is
// keyed (work_unit_id, date, shift), and NEITHER area grain has either half), no
// quality ledger of its own (an entry is a row in oee.work_center_quality_entries,
// keyed by LINE), and its measures are the pipeline's. The absence of an
// AreaReportWriterRepository is the statement that this module cannot mutate Gold,
// in the same way product-report-module.ts's is — and migrations 0024's and 0025's
// row-level write_audit triggers are the tripwire that says so from the database's
// side.
//
// TWO REPORT TABLES AND SIX SOURCE TABLES, and only the first pair varies by
// grain: `grainFrom` picks between oee.area_day_reports and
// oee.area_month_reports, and every read below that one takes an AreaWindow whose
// range is already the right width. A month is not a different query anywhere
// except the two report reads.
//
// ---------------------------------------------------------------------------
// THREE DIFFERENT WAYS TO SAY "THIS AREA", AND THE SOURCE TABLE DECIDES WHICH
// ---------------------------------------------------------------------------
//
// This is the one thing to know before editing any read below. `area_id` is
// denormalised onto some of Gold's tables and not others:
//
//   oee.area_day_reports          area_id IS the grain key            (0024)
//   oee.area_month_reports        area_id IS the grain key            (0025)
//   oee.work_center_day_reports   area_id, nullable                   (0014)
//   oee.reject_count_wc_shift     area_id, nullable                   (0019)
//   oee.downtime_log_events       area_id, nullable                   (0009)
//   oee.downtime_reports          area_id, nullable                   (0007)
//   oee.product_count_wc_day      NO area_id AT ALL                   (0016)
//
// So five of the six reads are a plain `area_id = $` predicate, and the SKU View
// is not: it has to name the area's LINES, which come from
// oee.work_center_day_reports' own attribution over the same window. That is why
// `listAreaLines` exists and why it is the pipeline's attribution rather than a
// master-data roster — see AreaLines.
//
// A NULLABLE area_id MEANS A ROW CAN BE MISSING FROM AN AREA'S TOTALS, and the
// consequence differs by table in a way that matters. On the report and count
// tables it is denormalisation lag: containment means the area IS derivable from
// the line, so the row is simply missing a label it could have, and the fix is a
// backfill. It is NOT the `product_id` situation (0020), where NULL means "not
// attributed" and no amount of backfilling can decide the answer — which is why
// none of these reads ships an `unattributed` count and the SKU reads do.
class AreaReportReaderRepository implements AreaReportReader {
  private db: GoldDB;

  constructor({ goldDb }: AreaReportReaderRepositoryDeps) {
    this.db = goldDb;
  }

  // The FROM clause for a grain, as a literal fragment.
  //
  // NOT `this.db(GRAIN_TABLE[grain])`: postgres.js escapes that as ONE identifier,
  // dot included, so it would look for a table literally named
  // `oee.area_day_reports` in the search path rather than `area_day_reports` in
  // schema `oee`. Two hardcoded fragments cannot be injected into and read plainly
  // — work-center-repository.ts's `grainFrom` records the same trap.
  //
  // NO `shift` COUNTERPART, unlike work-center's pair. Neither area table has a
  // `shift` column and neither ever will, so there is no projection difference
  // between the two grains at all: they differ by `ck_amr_month_start` and by
  // nothing a SELECT can see. That is what makes ONE implementation behind two
  // prefixes honest here rather than a shape borrowed from a subject it fits
  // better.
  // The month's daily OEE curve. The arithmetic and the half-open boundary live in
  // shared/oee-trend.ts, which the machine and line modules call with their own
  // tables; all this supplies is which two and which scope column.
  //
  // NOTE WHAT THIS IS NOT DOING: it reads area_day_reports, which 0024 composes
  // from its member lines. It does not re-compose anything, and it must not — `oee`
  // is a RATE, and 0025's whole argument is that rates are RECOMPUTED rather than
  // summed. Each day's figure is the pipeline's own, read as stored.
  async listMonthOeeTrend(reportId: number): Promise<OeeTrendPoint[]> {
    return await listOeeTrend(this.db, {
      innerTable: GRAIN_TABLE.day,
      outerFrom: this.grainFrom("month"),
      innerFrom: this.grainFrom("day"),
      span: this.db`interval '1 month'`,
      scopeColumn: "area_id",
      reportId,
    });
  }

  // THE YEAR'S MONTHLY CURVE, reading the MONTH table under a YEAR row.
  //
  // NOTE WHAT THIS IS NOT DOING, exactly as its month sibling's header says: it
  // reads rows `0025` already composed from the area's member lines. It does not
  // re-compose anything and it must not — `oee` is a RATE, and rates are
  // RECOMPUTED rather than summed. Each month's figure is the pipeline's own.
  async listYearOeeTrend(reportId: number): Promise<OeeTrendPoint[]> {
    return await listOeeTrend(this.db, {
      innerTable: GRAIN_TABLE.month,
      outerFrom: this.grainFrom("year"),
      innerFrom: this.grainFrom("month"),
      span: this.db`interval '1 year'`,
      scopeColumn: "area_id",
      reportId,
    });
  }

  private grainFrom(grain: AreaCoarseGrain): Fragment {
    if (grain === "day") return this.db`oee.area_day_reports`;
    if (grain === "month") return this.db`oee.area_month_reports`;
    return this.db`oee.area_year_reports`;
  }

  // Copied from work-center-repository.ts's version rather than shared, and this
  // is the THIRD copy — the rule shared/report-id.ts was promoted under says the
  // third is the moment to move it, and this one deliberately does not.
  //
  // The reason is that promotion would need a parameter this one does not want.
  // The other two branch over a filter type carrying `shift`; sharing would mean a
  // filter type wide enough for all three, which is the "accepted and ignored"
  // shape the coarse grains' own dto refuses. Three branches over three module
  // filter types is smaller than one branch plus a widened type — and unlike
  // `requireReportId`, this one is not "four lines with no policy in it": the
  // month-only arm below is a decision about what a bare `?month=` means.
  //
  // THE MONTH-ONLY ARM IS REACHED BY THE DAY GRAIN ALONE. The month list's dto
  // does not declare `month`, so at that grain this always takes the year-only or
  // the empty branch — which is why there is no `grain` parameter here and no
  // second guard. See area-report-dto.ts for why the dto refuses rather than
  // drops, and why that makes a repository guard unnecessary where work-center
  // needs one.
  private businessDateFilter({ month, year }: AreaReportFilter): Fragment {
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

  async paginateReport({ grain, limit, offset, filter }: ListAreaReportInput) {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      // Built ONCE and shared by the page query and the count query, so the two
      // can never disagree about what is being counted.
      const from = this.grainFrom(grain);
      const periodSql = this.businessDateFilter(filter);

      // `area_id` IS the grain key, so this is a predicate rather than an `IN` over
      // ids resolved upstream. An unknown area matches nothing and the caller gets
      // an empty page — a list names a FILTER, and a filter that matches nothing is
      // an empty set rather than a 404. The DETAIL route 404s, which is the
      // asymmetry every subject in this service keeps.
      const areaSql =
        filter.areaId === undefined ? this.db`` : this.db`AND r.area_id = ${filter.areaId}`;

      // THREE-VALUED, AND DELIBERATELY SO. `oee` is nullable on this table (0/0 is
      // real for an area whose every line sat in planned downtime), and
      // `NULL <> 0` is NULL rather than true — so this hides a NULL-OEE row as
      // well as a zero one. That is the right outcome: an undefined row is an idle
      // row, which is what the filter is for. Do NOT "fix" this into
      // `IS DISTINCT FROM 0`.
      const hideZeroSql = filter.isHideZero === true ? this.db`AND r.oee <> 0` : this.db``;

      const [rows, totals] = await Promise.all([
        this.db<AreaReportListRow[]>`
          SELECT r.id, ${grain}::text AS grain,
                 to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
                 r.time_zone,
                 r.area_id, r.area_name, r.area_code,
                 -- float8 after rounding, or postgres.js hands numeric back as a
                 -- STRING and the browser renders "100.000%" and sorts it
                 -- lexicographically.
                 round(r.oee::numeric, 3)::float8 AS oee,
                 round(r.availability::numeric, 3)::float8 AS availability,
                 round(r.performance::numeric, 3)::float8 AS performance,
                 round(r.quality::numeric, 3)::float8 AS quality
          FROM ${from} r
          WHERE TRUE ${periodSql} ${areaSql} ${hideZeroSql}
          -- Date first, because that is the column a reader is sorting by in their
          -- head -- and at month grain business_date IS the month, the first of
          -- it, so this orders chronologically without touching the month LABEL.
          -- Sorting on that label would be lexicographic over a varchar whose
          -- format was never specified upstream (contract 15.7). Then the AREA, so
          -- a list left unscoped groups an area's periods together rather than
          -- interleaving areas. The id tiebreak last makes paging STABLE: without
          -- it a row can appear on two pages and another on none, which no test
          -- asserting "rows appear" would catch.
          --
          -- (No backticks anywhere in this comment: it lives in a tagged template
          -- and one would terminate the string. The formatter catches it, loudly.)
          ORDER BY r.business_date DESC, r.area_id ASC, r.id ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        this.db<{ value: number }[]>`
          SELECT count(r.id)::int AS value
          FROM ${from} r
          WHERE TRUE ${periodSql} ${areaSql} ${hideZeroSql}
        `,
      ]);

      return { items: [...rows], totalElements: totals[0]?.value ?? 0 };
    });
  }

  // ONE ROW, EVERY MEASURE. The casts are load-bearing rather than noise:
  //
  //   round(x::numeric, 3)::float8   postgres.js hands `numeric` back as a STRING.
  //   x::float8                      same for `bigint`, which would otherwise
  //                                  concatenate rather than add.
  //
  // NOTHING IS COALESCED. Every nullable column reaches the browser as null and
  // renders an em dash. A `coalesce(x, 0)` would turn "the members could not be
  // brought to a common mass" into a measurement of zero — and on this subject that
  // null has a third meaning again, neither 0014's "the members disagreed" nor
  // 0023's "not known": see AreaReport.weightUomId.
  //
  // ONE PROJECTION FOR BOTH GRAINS, because the two tables differ by exactly one
  // CONSTRAINT and by no column. `id` is meaningful only against the table the
  // grain names — nine report tables, nine independent identity sequences — so
  // the grain is not decoration here: `getReport("day", 3)` and
  // `getReport("month", 3)` are two different reports.
  async getReport(grain: AreaCoarseGrain, id: number) {
    return await traced("SELECT", GRAIN_TABLE[grain], async () => {
      const rows = await this.db<AreaReport[]>`
        SELECT r.id, ${grain}::text AS grain,
               to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
               r.time_zone,
               r.area_id, r.area_name, r.area_code,
               r.site_id, r.site_name,
               r.enterprise_id, r.enterprise_name,
               -- ONE unit triple, not two. An area's counts are all masses; see
               -- AreaReport for why that is the consequence of its members having
               -- many units rather than a relaxation of 0014's rule.
               r.weight_uom_id, r.weight_uom_name, r.weight_uom_code,
               round(r.oee::numeric, 3)::float8 AS oee,
               round(r.availability::numeric, 3)::float8 AS availability,
               round(r.performance::numeric, 3)::float8 AS performance,
               round(r.quality::numeric, 3)::float8 AS quality,
               round(r.total_out::numeric, 3)::float8 AS total_out,
               round(r.area_out::numeric, 3)::float8 AS area_out,
               round(r.reject::numeric, 3)::float8 AS reject,
               round(r.rework::numeric, 3)::float8 AS rework,
               round(r.good_out::numeric, 3)::float8 AS good_out,
               -- LINE-MILLISECONDS, all of them. A five-line area's runtime on one
               -- day is ~120 h and the tile is expected to say so — migration
               -- 0024's consequence 1. Nothing here divides by a line count.
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

  // THE AREA'S SCOPE PREDICATE, written once and used by every read below that
  // has an `area_id` to compare. `j` is the alias each caller gives its row
  // source; a fragment naming another alias produces a runtime "missing
  // FROM-clause entry", which no fakeSql test can see because that fake matches
  // SQL text and never executes it.
  private forArea({ areaId }: AreaWindow): Fragment {
    return this.db`j.area_id = ${areaId}`;
  }

  // WHICH LINES REPORTED INTO THIS AREA OVER THIS WINDOW.
  //
  // The pipeline's own attribution, off oee.work_center_day_reports.area_id — NOT
  // a roster from mes-master-data. See AreaLines for the full argument; the short
  // version is that the column records the area a LINE's numbers were attributed
  // to over this window, where a roster is the area's membership NOW, and this
  // read path makes no upstream call.
  //
  // ITS ONLY CONSUMER IS THE SKU VIEW, because oee.product_count_wc_day is the one
  // source table with no `area_id` of its own (0016). Everything else here scopes
  // by column. If a second consumer appears, check first whether its table already
  // carries the column — five of six do.
  //
  // DISTINCT, and ordered, so the array is stable between identical requests: it
  // becomes an `= ANY($)` bind below, and an unstable order would make two
  // otherwise-identical query plans look different in a trace for no reason.
  async listAreaLines(window: AreaWindow): Promise<AreaLines> {
    return await traced("SELECT", TABLE_WORK_CENTER_DAY_REPORTS, async () => {
      const rows = await this.db<{ workCenterId: number }[]>`
        SELECT DISTINCT j.work_center_id
        FROM oee.work_center_day_reports j
        WHERE ${this.forArea(window)}
          AND ${inDateRange(this.db, this.db`j.business_date`, window)}
        ORDER BY j.work_center_id ASC
      `;

      return { workCenterIds: rows.map((row) => row.workCenterId) };
    });
  }

  // SKU View's rows, from the 0016 day table over the area's lines.
  //
  // `factor_to_base` IS APPLIED HERE AND NOWHERE ELSE, to total_out, reject and
  // rework — and deliberately NOT to good_out, because Finish Good stays in the
  // unit it was counted in. That pairing is the whole of ProductCountItem's
  // doctrine and the reason its two unit codes both ride on every row. It is the
  // same projection work-center-repository.ts's listProductCount uses, with the
  // scope widened from one line to N.
  //
  // GROUPED ON (product, uom, base_uom) AND NOT ON THE LINE, which is the one
  // thing that changes at this grain: a SKU that ran on three lines is ONE row
  // here. The group key carries both unit codes, so a SKU whose lines counted it
  // in DIFFERENT units comes back as two rows rather than one row summing unlike
  // things — the same guard that protects a product whose unit changed mid-window
  // one grain down, doing more work here because an area's lines genuinely differ.
  //
  // AN EMPTY LINE LIST RETURNS NO ROWS RATHER THAN EVERY ROW. `= ANY('{}')` is
  // false for every row, which is the wanted answer — but it is worth being
  // explicit that this is checked BEFORE the query rather than relied on, because
  // an accidental `IN ()` would be a syntax error and an accidental omission of
  // the predicate would return the whole plant under one area's heading.
  async listProductCount(window: AreaWindow, lines: AreaLines): Promise<ProductCountItem[]> {
    if (lines.workCenterIds.length === 0) return [];

    return await traced("SELECT", TABLE_PRODUCT_COUNT_WC_DAY, async () => {
      const rows = await this.db<ProductCountItem[]>`
        SELECT p.product_id,
               min(p.product_name) AS product_name,
               min(p.product_code) AS product_code,
               p.uom_code, p.base_uom_code,
               round(sum(p.total_out * p.factor_to_base), 3)::float8 AS total_out,
               round(sum(p.good_out)::numeric, 3)::float8            AS good_out,
               round(sum(p.reject * p.factor_to_base), 3)::float8    AS reject,
               round(sum(p.rework * p.factor_to_base), 3)::float8    AS rework
        FROM oee.product_count_wc_day p
        WHERE p.work_center_id = ANY(${lines.workCenterIds})
          AND ${inDateRange(this.db, this.db`p.business_date`, window)}
        GROUP BY p.product_id, p.uom_code, p.base_uom_code
        ORDER BY min(p.product_name) ASC, p.product_id ASC
      `;

      return [...rows];
    });
  }

  // ---------------------------------------------------------------------------
  // The Input/Output Production KPI
  // ---------------------------------------------------------------------------
  //
  // The area's production summed PER UNIT, across its lines — the second half of
  // the requirement that the mass columns on oee.area_day_reports cannot answer.
  // See AreaProductionUnits for why this is a read and not a table.
  //
  // FOUR STATEMENTS, NOT ONE, AND THE SPLIT IS THE DESIGN.
  //
  // A line row carries an infeed unit AND an output unit in two separate column
  // groups (0014), so "group by unit" is genuinely two questions over one row set.
  // One statement with a UNION and a `side` discriminator would produce a single
  // list a reader could total — and totalling across the two sides is the one
  // arithmetic 0014 forbids. Keeping them apart in SQL is what keeps them apart on
  // the wire.
  //
  // THE TWO RESIDUAL COUNTS ARE THEIR OWN STATEMENT, over the rows the unit
  // predicate has NOT been applied to. They cannot be a FILTER on the grouped
  // queries above, for the reason product-report-repository.ts's
  // countUnattributedDowntime records: those group BY the unit, so a NULL-unit row
  // is already in its own bucket rather than absent, and a FILTER would count
  // something else. They are also PER SIDE, because 0014's guards are per side — a
  // line can be certain what it consumed and abstain about what it shipped.
  //
  // COALESCED SUMS, unlike the reject aggregate's `weight_gram`. Every row in a
  // bucket has a non-null unit by construction (the WHERE excludes the others), and
  // 0014's CHECK then guarantees the counts are non-null too — except `line_out`
  // and `effective_out`, which the pipeline may simply not have written yet. A null
  // there is "not written", and 0 is the honest total of nothing rather than a
  // claim: unlike a unit or a rate, a SUM over some written and some unwritten rows
  // is already partial, so distinguishing the two buys a caller nothing it could
  // act on.
  async aggregateProductionUnits(window: AreaWindow) {
    return await traced("SELECT", TABLE_WORK_CENTER_DAY_REPORTS, async () => {
      // A WHERE-CLAUSE FRAGMENT, NOT A `FROM ... WHERE` ONE, and the difference is
      // worth a line. A fragment carrying its own WHERE forces every caller to
      // continue it with `AND`, which reads as a syntax accident and breaks the
      // moment one of them wants an `OR` or no extra predicate at all. Each
      // statement below writes its own FROM and composes predicates with `AND`
      // explicitly, so what the three share is the SCOPE and nothing else.
      const scopeSql = this.db`
        ${this.forArea(window)}
        AND ${inDateRange(this.db, this.db`j.business_date`, window)}
      `;

      const [infeed, output, unresolved] = await Promise.all([
        this.db<AreaInfeedBucket[]>`
          SELECT j.infeed_uom_id                            AS uom_id,
                 min(j.infeed_uom_name)                     AS uom_name,
                 min(j.infeed_uom_code)                     AS uom_code,
                 count(DISTINCT j.work_center_id)::int      AS work_center_count,
                 round(coalesce(sum(j.total_out), 0), 3)::float8 AS total_out,
                 round(coalesce(sum(j.line_out), 0), 3)::float8  AS line_out,
                 round(coalesce(sum(j.reject), 0), 3)::float8    AS reject,
                 round(coalesce(sum(j.rework), 0), 3)::float8    AS rework
          FROM oee.work_center_day_reports j
          WHERE ${scopeSql}
            AND j.infeed_uom_id IS NOT NULL
          GROUP BY j.infeed_uom_id
          -- By the unit's own CODE, so the card's order is the one a reader scans
          -- for. The id tiebreak makes it TOTAL: two units sharing a denormalised
          -- code would otherwise swap places between identical requests.
          ORDER BY min(j.infeed_uom_code) ASC NULLS LAST, j.infeed_uom_id ASC
        `,
        this.db<AreaOutputBucket[]>`
          SELECT j.output_uom_id                            AS uom_id,
                 min(j.output_uom_name)                     AS uom_name,
                 min(j.output_uom_code)                     AS uom_code,
                 count(DISTINCT j.work_center_id)::int      AS work_center_count,
                 round(coalesce(sum(j.good_out), 0), 3)::float8      AS good_out,
                 round(coalesce(sum(j.effective_out), 0), 3)::float8 AS effective_out
          FROM oee.work_center_day_reports j
          WHERE ${scopeSql}
            AND j.output_uom_id IS NOT NULL
          GROUP BY j.output_uom_id
          ORDER BY min(j.output_uom_code) ASC NULLS LAST, j.output_uom_id ASC
        `,
        // TWO COUNTS OVER THE SAME ROW SET, and `count(*)` rather than
        // `count(column)` on neither — these count the rows where the column IS
        // null, so the FILTER does the work the column cannot. The
        // count(*)-not-count(column) rule pointed the other way round.
        //
        // DISTINCT LINES, not rows: an area's line reports over a month are many
        // rows per line, and "6 lines have no output unit" is the sentence the card
        // needs where "180 rows" is not.
        this.db<{ infeedUnresolved: number; outputUnresolved: number }[]>`
          SELECT count(DISTINCT j.work_center_id)
                   FILTER (WHERE j.infeed_uom_id IS NULL)::int AS infeed_unresolved,
                 count(DISTINCT j.work_center_id)
                   FILTER (WHERE j.output_uom_id IS NULL)::int AS output_unresolved
          FROM oee.work_center_day_reports j
          WHERE ${scopeSql}
        `,
      ]);

      return {
        infeed: [...infeed],
        output: [...output],
        infeedUnresolved: unresolved[0]?.infeedUnresolved ?? 0,
        outputUnresolved: unresolved[0]?.outputUnresolved ?? 0,
      };
    });
  }

  // The Quality Loss Pareto.
  //
  // READS THE LINES' OWN COUNT POINTS (0019), scoped by `area_id`, which that
  // table has carried since it was created. No line list needed and no machine sum
  // involved: contract §20 is explicit that a reject is a COUNT AT A COUNT POINT,
  // so the line has its own — and an area's Pareto is the sum of its lines' count
  // points, which is exact within a unit.
  //
  // THE AGGREGATE IS UNCHANGED AND SHARED. The unit guards, the generated-column
  // read and the count(*)-not-count(column) rule stay in one statement each; this
  // is a new WHERE and no new arithmetic, which is what aggregateRejectRows being
  // parameterised BY A FRAGMENT buys.
  //
  // THE MIXED-UNIT ABSTAIN WILL FIRE OFTEN HERE, AND THAT IS THE POINT. A bucket
  // whose rows disagree on `uom_code` reports a NULL unit and the screen renders an
  // em dash rather than adding sacks to cartons. At machine grain that guard is
  // near-decorative; at line grain it bites; across an area it is the normal case.
  // An em dash is the correct answer, not a degraded one.
  async aggregateRejectReasons(window: AreaWindow) {
    return await aggregateRejectRows(
      this.db,
      TABLE_REJECT_COUNT_WC_SHIFT,
      this.db`
        SELECT j.*,
               -- NO MACHINE TO NAME. The shared aggregate projects work_unit_name
               -- as each bucket's machineName, which is meaningful when the rows
               -- ARE a machine's; these are the LINES' own count points and this
               -- one spans several lines, so there is no machine behind a bar and
               -- the Pareto shows an em dash. Supplied HERE rather than by
               -- loosening the aggregate, which keeps that function identical for
               -- all four subjects. (No backticks in this comment: it lives in a
               -- tagged template and one would terminate the string.)
               NULL::varchar AS work_unit_name
        FROM oee.reject_count_wc_shift j
        WHERE ${this.forArea(window)}
          AND ${inDateRange(this.db, this.db`j.business_date`, window)}
      `,
    );
  }

  // The Others tab, on the same terms — `area_id` has been on oee.downtime_log_events
  // since 0009, and its business day is `shift_date` rather than `business_date`
  // (the older name, kept rather than renamed — contract §22.4).
  //
  // NO SHIFT NARROWING. An area day report spans all three shifts and this table is
  // shift-keyed, so the range widens over them. Passing a shift here would silently
  // report a third of the day.
  async aggregateDowntimeEventReasons(window: AreaWindow) {
    return await aggregateEventPairs(
      this.db,
      TABLE_DOWNTIME_LOG_EVENTS,
      this.db`
        SELECT DISTINCT e.event_id, nullif(btrim(x.reason), '') AS reason
        FROM (
          SELECT j.event_id, j.reasons
          FROM oee.downtime_log_events j
          WHERE ${this.forArea(window)}
            AND ${inDateRange(this.db, this.db`j.shift_date`, window)}
        ) e
        LEFT JOIN LATERAL unnest(e.reasons) AS x(reason) ON true
      `,
    );
  }

  // ---------------------------------------------------------------------------
  // The activity feed's downtime arm
  // ---------------------------------------------------------------------------
  //
  // Every recorded change to a stop in this area, plus the two member counts that
  // let the panel distinguish "nothing was edited" from "nothing could be".
  //
  // SCOPED BY COLUMN AND BY BUSINESS DATE, not by an instant range, which is where
  // it departs from work-center-repository's listDowntimeEdits. The reason is
  // consistency INSIDE the area payload: every other read here narrows on a
  // business-date range, and two definitions of "this area's day" in one screen is
  // how a feed comes to list an edit no other card knew about.
  //
  // It is also SAFE rather than merely tidy: Flink forces a stop's `end_at` to the
  // shift boundary, so no stop crosses a shift or a day (AGENTS.md, contract §21.7)
  // — the two scopings coincide and there is no straddle for a date predicate to
  // lose. 0021 put `business_date` on this table and 0022 dropped the legacy
  // `date`, so this is the column, not a fallback.
  //
  // BOTH THE MACHINE AND THE LINE RIDE ON EVERY ENTRY. An area day feed spans three
  // shifts, N lines and every machine on them, so the machine alone can leave two
  // edits reading as one — "the filler" is a name several lines have. See
  // AreaActivityEntry.
  //
  // TWO STATEMENTS OVER THE SAME MEMBER SET, and the second is not the first with a
  // length(). `count(*)` is every stop in the area; `count(source_event_id)` is the
  // trackable half — a stop with no stable id can never carry a trail, and that is
  // a different answer from "nobody has edited it". The
  // count(*)-not-count(column) rule, which is the whole distinction the pair exists
  // to draw.
  async listDowntimeEdits(window: AreaWindow) {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT_HISTORY, async () => {
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
            workCenterId: number | null;
            workCenterName: string | null;
          }[]
        >`
          WITH members AS (
            SELECT j.source_event_id,
                   j.work_unit_id, j.work_unit_name,
                   j.work_center_id, j.work_center_name
            FROM oee.downtime_reports j
            WHERE ${this.forArea(window)}
              AND ${inDateRange(this.db, this.db`j.business_date`, window)}
              AND j.source_event_id IS NOT NULL
          )
          SELECT 'downtime:' || h.id AS id, h.changed_at AS at, h.changed_by AS "by",
                 h.source_event_id, h.field, h.old_value, h.new_value,
                 m.work_unit_id, m.work_unit_name,
                 m.work_center_id, m.work_center_name
          FROM oee.downtime_report_history h
          JOIN members m ON m.source_event_id = h.source_event_id
          ORDER BY h.changed_at DESC, h.id DESC
        `,
        this.db<{ total: number; tracked: number }[]>`
          SELECT count(*)::int AS total,
                 count(j.source_event_id)::int AS tracked
          FROM oee.downtime_reports j
          WHERE ${this.forArea(window)}
            AND ${inDateRange(this.db, this.db`j.business_date`, window)}
        `,
      ]);

      return {
        entries: entries.map((e) => ({ ...e, kind: "downtime" as const })),
        totalMembers: counts[0]?.total ?? 0,
        trackedMembers: counts[0]?.tracked ?? 0,
      };
    });
  }
}

export { AreaReportReaderRepository };
export type { AreaReportReader };
