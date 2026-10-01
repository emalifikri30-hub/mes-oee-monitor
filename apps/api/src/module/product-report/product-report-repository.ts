import { aggregateEventPairs, aggregateRejectRows } from "../../shared/loss-aggregate.js";
// The header area picker's predicate, shared by all four report subjects.
import { areaScope } from "../../shared/area-scope.js";
import { inDateRange, scopedRows } from "../../shared/report-window.js";
import { traced } from "../../shared/database/postgres.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";
import type {
  ListProductReportInput,
  PagedProductReport,
  ProductActivityEntry,
  ProductMachineRoster,
  ProductReport,
  ProductReportFilter,
  ProductReportListRow,
  ProductWindow,
  UnattributedDowntime,
} from "./product-report.js";
import type { Fragment } from "postgres";

const TABLE_PRODUCT_REPORT_WC_DAY = "oee.product_report_wc_day";
const TABLE_REJECT_COUNT_WC_SHIFT = "oee.reject_count_wc_shift";
const TABLE_DOWNTIME_LOG_EVENTS = "oee.downtime_log_events";
const TABLE_DOWNTIME_REPORTS = "oee.downtime_reports";
const TABLE_DOWNTIME_REPORT_HISTORY = "oee.downtime_report_history";
const TABLE_WORK_UNIT_SHIFT_REPORTS = "oee.work_unit_shift_reports";

type ProductReportReaderRepositoryDeps = { goldDb: GoldDB };

type ProductReportReader = {
  paginateReport: (input: ListProductReportInput) => Promise<PagedProductReport>;
  getReport: (id: number) => Promise<ProductReport | undefined>;
  aggregateRejectReasons: (window: ProductWindow) => Promise<RejectAggregate>;
  aggregateDowntimeEventReasons: (window: ProductWindow) => Promise<DowntimeEventAggregate>;
  countUnattributedDowntime: (window: ProductWindow) => Promise<UnattributedDowntime>;
  listDowntimeEdits: (window: ProductWindow) => Promise<{
    entries: ProductActivityEntry[];
    totalMembers: number;
    trackedMembers: number;
  }>;
  listMachineRoster: (
    instants: { from: Date; to: Date },
    workCenterId: number,
  ) => Promise<ProductMachineRoster>;
};

// READS ONLY. There is no writer class in this module and there is nothing for one
// to do: a SKU has no approval (oee.work_unit_shift_report_approvals is keyed
// (work_unit_id, date, shift), and this grain has neither a work unit nor a
// shift), and its measures are the pipeline's. The absence of a
// ProductReportWriterRepository is the statement that this module cannot mutate
// Gold, in the same way work-unit-module.ts's split is.
//
// THE SKU SCREEN DOES HAVE ONE OPERATOR WRITE, and it is not here. Recording
// reject or rework from the SKU day report inserts into
// oee.work_center_quality_entries, through the quality-entry module, which owns
// that table and registers its own writer. Nothing in this file writes anything,
// and 0023's row-level write_audit triggers remain the tripwire that says so.
class ProductReportReaderRepository implements ProductReportReader {
  private db: GoldDB;

  constructor({ goldDb }: ProductReportReaderRepositoryDeps) {
    this.db = goldDb;
  }

  // Copied from work-center-repository.ts's version rather than shared, and that
  // is deliberate: it is three branches over this module's own filter type, and a
  // shared version would need a column-name parameter to serve a table whose date
  // column might one day differ. Revisit on the third copy — the rule
  // shared/report-id.ts was promoted under.
  private businessDateFilter({ month, year }: ProductReportFilter): Fragment {
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

  async paginateReport({ limit, offset, filter }: ListProductReportInput) {
    return await traced("SELECT", TABLE_PRODUCT_REPORT_WC_DAY, async () => {
      // Built ONCE and shared by the page query and the count query, so the two
      // can never disagree about what is being counted.
      const periodSql = this.businessDateFilter(filter);

      const workCenterSql =
        filter.workCenterId === undefined
          ? this.db``
          : this.db`AND r.work_center_id = ${filter.workCenterId}`;

      const productSql =
        filter.productId === undefined
          ? this.db``
          : this.db`AND r.product_id = ${filter.productId}`;

      // The header area picker. Stacks with both filters above it rather than
      // replacing either — see area-scope.ts for what an absent id means and why
      // a NULL `area_id` is excluded rather than counted.
      const areaSql = areaScope(this.db, filter.areaId);

      // THREE-VALUED, AND DELIBERATELY SO. `oee` is nullable (0/0 is real for a
      // SKU whose whole run sat in planned downtime), and `NULL <> 0` is NULL
      // rather than true — so this hides a NULL-OEE row as well as a zero one.
      // That is the right outcome: an undefined row is an idle row, which is what
      // the filter is for. Do NOT "fix" this into `IS DISTINCT FROM 0`.
      const hideZeroSql = filter.isHideZero === true ? this.db`AND r.oee <> 0` : this.db``;

      const [rows, totals] = await Promise.all([
        this.db<ProductReportListRow[]>`
          SELECT r.id,
                 to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
                 r.time_zone,
                 r.work_center_id, r.work_center_name, r.work_center_code,
                 r.product_id, r.product_name, r.product_code,
                 -- float8 after rounding, or postgres.js hands numeric back as a
                 -- STRING and the browser renders "100.000%" and sorts it
                 -- lexicographically.
                 round(r.oee::numeric, 3)::float8 AS oee,
                 round(r.availability::numeric, 3)::float8 AS availability,
                 round(r.performance::numeric, 3)::float8 AS performance,
                 round(r.quality::numeric, 3)::float8 AS quality
          FROM oee.product_report_wc_day r
          WHERE TRUE ${periodSql} ${workCenterSql} ${areaSql} ${productSql} ${hideZeroSql}
          -- Date first, because that is the column a reader is sorting by in their
          -- head. Then PRODUCT NAME, not id — the list is read as "which SKUs ran"
          -- and an id order is arbitrary to everyone but the database. Then the
          -- LINE, so the same SKU on the same date lists its lines together, which
          -- is the comparison this report exists for. The id tiebreak last makes paging
          -- STABLE: without it a row can appear on two pages and another on none,
          -- which no test asserting "rows appear" would catch.
          ORDER BY r.business_date DESC, r.product_name ASC, r.work_center_id ASC, r.id ASC
          LIMIT ${limit} OFFSET ${offset}
        `,
        this.db<{ value: number }[]>`
          SELECT count(r.id)::int AS value
          FROM oee.product_report_wc_day r
          WHERE TRUE ${periodSql} ${workCenterSql} ${areaSql} ${productSql} ${hideZeroSql}
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
  // renders an em dash. A `coalesce(x, 0)` would turn "not known" into a
  // measurement of zero — and at this grain a NULL unit means exactly "not known"
  // rather than 0014's "the members disagreed", because a SKU report has no
  // members (0023).
  async getReport(id: number) {
    return await traced("SELECT", TABLE_PRODUCT_REPORT_WC_DAY, async () => {
      const rows = await this.db<ProductReport[]>`
        SELECT r.id, 'day'::text AS grain,
               to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
               r.time_zone,
               r.work_center_id, r.work_center_name, r.work_center_code,
               r.area_id, r.area_name,
               r.product_id, r.product_name, r.product_code,
               r.infeed_uom_id, r.infeed_uom_name, r.infeed_uom_code,
               r.output_uom_id, r.output_uom_name, r.output_uom_code,
               round(r.oee::numeric, 3)::float8 AS oee,
               round(r.availability::numeric, 3)::float8 AS availability,
               round(r.performance::numeric, 3)::float8 AS performance,
               round(r.quality::numeric, 3)::float8 AS quality,
               round(r.total_out::numeric, 3)::float8 AS total_out,
               round(r.reject::numeric, 3)::float8 AS reject,
               round(r.rework::numeric, 3)::float8 AS rework,
               round(r.line_out::numeric, 3)::float8 AS line_out,
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
               r.availability_loss_time::float8 AS availability_loss_time,
               r.performance_loss_time::float8 AS performance_loss_time,
               r.ms_loss_time::float8 AS ms_loss_time,
               r.reduce_speed_loss_time::float8 AS reduce_speed_loss_time,
               r.quality_loss_time::float8 AS quality_loss_time,
               r.mttr::float8 AS mttr,
               r.mtbf::float8 AS mtbf
        FROM oee.product_report_wc_day r
        WHERE r.id = ${id}
        LIMIT 1
      `;

      return rows[0];
    });
  }

  // THE PRODUCT PREDICATE, written once and reused by both aggregates below.
  // `j` is the alias scopedRows gives the row source; a fragment naming any other
  // alias produces a runtime "missing FROM-clause entry", which no fakeSql test
  // can see because that fake matches SQL text and never executes it.
  private forProduct({ productId }: ProductWindow): Fragment {
    return this.db`AND j.product_id = ${productId}`;
  }

  // The Quality Loss Pareto. The LINE's own reject counts (0019), narrowed to one
  // SKU — `product_id` has been in that table's primary key since it was created,
  // so this is a predicate rather than a new aggregate.
  async aggregateRejectReasons(window: ProductWindow) {
    return await aggregateRejectRows(
      this.db,
      TABLE_REJECT_COUNT_WC_SHIFT,
      this.db`
        SELECT j.*,
               -- The shared aggregate projects a machine name for the machine
               -- subject's drill-down. A SKU report has no machine, and NULL is
               -- the honest answer rather than a widened aggregate.
               NULL::varchar AS work_unit_name
        FROM (
          ${scopedRows({
            db: this.db,
            table: this.db`oee.reject_count_wc_shift`,
            window,
            dateColumn: this.db`j.business_date`,
            extra: this.forProduct(window),
          })}
        ) j
      `,
    );
  }

  // The Others tab. Same window, same product, one level of explode.
  async aggregateDowntimeEventReasons(window: ProductWindow) {
    const events = scopedRows({
      db: this.db,
      table: this.db`oee.downtime_log_events`,
      window,
      dateColumn: this.db`j.shift_date`,
      extra: this.forProduct(window),
    });

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

  // HOW MANY STOPS THIS WINDOW HOLDS THAT NO SKU OWNS.
  //
  // WHY THIS IS ITS OWN QUERY AND NOT A `FILTER` ON THE AGGREGATES ABOVE. Those
  // scope by `product_id = $` before they count anything, so the unattributed rows
  // are already gone by the time a FILTER could see them — it would return 0 for
  // every window, always, and look right. The count has to be taken over the rows
  // the product predicate has NOT been applied to.
  //
  // WHAT IT IS FOR. oee.downtime_reports.product_id is nullable and NULL means NOT
  // ATTRIBUTED, never "no product ran" (0020). With the column unwritten, a SKU
  // report reads Availability 100% with an empty downtime table — plausible, not
  // an error. A non-zero count here is what lets the screen say so instead.
  //
  // It counts oee.downtime_reports rather than downtime_log_events because that is
  // the table the timeline, the downtime table and the Availability Pareto all
  // read; the Others tab's own source is counted by whatever the screen shows for
  // it, and conflating the two would report a number against the wrong card.
  async countUnattributedDowntime(window: ProductWindow) {
    return await traced("SELECT", TABLE_DOWNTIME_REPORTS, async () => {
      const rows = await this.db<{ unattributed: number }[]>`
        SELECT count(*)::int AS unattributed
        FROM oee.downtime_reports j
        WHERE j.work_center_id = ${window.workCenterId}
          AND ${inDateRange(this.db, this.db`j.business_date`, window)}
          AND j.product_id IS NULL
      `;

      return { unattributed: rows[0]?.unattributed ?? 0 };
    });
  }

  // ---------------------------------------------------------------------------
  // The activity feed's downtime arm
  // ---------------------------------------------------------------------------
  //
  // Every recorded change to a stop this SKU owns, plus the two member counts that
  // let the panel distinguish "nothing was edited" from "nothing could be".
  //
  // SCOPED BY COLUMNS, NOT BY AN INSTANT RANGE, which is where it departs from
  // work-center-repository's listDowntimeEdits — and the reason is consistency
  // INSIDE this payload rather than a preference. countUnattributedDowntime, which
  // travels beside these counts in the same response, scopes by
  // `j.business_date` through inDateRange; aggregateDowntimeEventReasons and
  // aggregateRejectReasons do the same. Two definitions of "this SKU's day" in one
  // response is how a feed comes to list an edit the residual count did not know
  // about, on a screen where both numbers are visible at once.
  //
  // It is also SAFE rather than merely tidy: Flink forces a stop's end_at to the
  // shift boundary, so no stop crosses a shift or a day (AGENTS.md, contract
  // §21's Q1 note) — the two scopings coincide, and there is no straddle for a
  // date predicate to lose. 0021 put `business_date` on this table and 0022
  // dropped the legacy `date`, so this is the column, not a fallback.
  //
  // TWO STATEMENTS OVER THE SAME MEMBER SET, and the second is not the first with
  // a length(). count(*) is every stop this SKU owns; count(source_event_id) is
  // the trackable half — a stop with no stable id can never carry a trail, and
  // that is a different answer from "nobody has edited it". The
  // count(*)-not-count(column) rule, which is the whole distinction the pair
  // exists to draw.
  async listDowntimeEdits(window: ProductWindow) {
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
          }[]
        >`
          WITH members AS (
            ${scopedRows({
              db: this.db,
              table: this.db`oee.downtime_reports`,
              window,
              dateColumn: this.db`j.business_date`,
              // The alias is `j` and it must stay so: a fragment naming another
              // alias produces a runtime "missing FROM-clause entry" that no
              // fakeSql test can see, because the fake matches text and never
              // executes. Same note scopedRows carries.
              extra: this.db`AND j.product_id = ${window.productId}
                             AND j.source_event_id IS NOT NULL`,
            })}
          )
          SELECT 'downtime:' || h.id AS id, h.changed_at AS at, h.changed_by AS "by",
                 h.source_event_id, h.field, h.old_value, h.new_value,
                 m.work_unit_id, m.work_unit_name
          FROM oee.downtime_report_history h
          JOIN members m ON m.source_event_id = h.source_event_id
          ORDER BY h.changed_at DESC, h.id DESC
        `,
        this.db<{ total: number; tracked: number }[]>`
          SELECT count(*)::int AS total,
                 count(m.source_event_id)::int AS tracked
          FROM (
            ${scopedRows({
              db: this.db,
              table: this.db`oee.downtime_reports`,
              window,
              dateColumn: this.db`j.business_date`,
              // WITHOUT the source_event_id predicate — that is the whole
              // difference between the two statements. A stop with no stable id
              // belongs in `total` and not in `tracked`.
              extra: this.db`AND j.product_id = ${window.productId}`,
            })}
          ) m
        `,
      ]);

      return {
        entries: entries.map((e) => ({ ...e, kind: "downtime" as const })),
        totalMembers: counts[0]?.total ?? 0,
        trackedMembers: counts[0]?.tracked ?? 0,
      };
    });
  }

  // THE MACHINES THAT REPORTED INTO THIS LINE ON THIS DAY — a roster, for the
  // reject dialog's provenance picker. See ProductMachineRoster for why it is not
  // the line's /machines endpoint.
  //
  // SCOPED ON `date`, NOT `business_date`, and this one is the opposite call from
  // listDowntimeEdits above. oee.work_unit_shift_reports.business_date is nullable
  // and UNBACKFILLED (0013 added it to already-populated tables; TODOS.md §46), so
  // a date predicate here would return an empty roster and the picker would offer
  // nothing. `date` is the instant the shift STARTED, which is why the caller
  // resolves the day's instant window first — the same reason
  // work-center-service.getMachines does.
  //
  // ZERO UPSTREAM CALLS. work_center_id has been NOT NULL on this table since
  // 0003, and it is the better definition anyway: it records the line the pipeline
  // attributed a machine's numbers TO, where a master-data roster is the line's
  // membership NOW. That is the correction 4fccce8-era work made to the line
  // approval cascade, and the same argument applies to a picker.
  //
  // NOT NARROWED BY PRODUCT. A machine either ran on this line that day or it did
  // not; oee.work_unit_shift_reports has no product dimension, and offering only
  // the machines that ran the SKU would need per-SKU machine counts these tables
  // cannot supply (§15). The operator is naming where they SAW the rejects, which
  // is a fact about the shift and not about the SKU.
  async listMachineRoster(instants: { from: Date; to: Date }, workCenterId: number) {
    return await traced("SELECT", TABLE_WORK_UNIT_SHIFT_REPORTS, async () => {
      const machines = await this.db<{ workUnitId: number; workUnitName: string | null }[]>`
        SELECT DISTINCT r.work_unit_id, r.work_unit_name
        FROM oee.work_unit_shift_reports r
        WHERE r.work_center_id = ${workCenterId}
          -- HALF-OPEN over the day's instants, never an equality on date: a row
          -- written a millisecond off the shift boundary would be skipped and the
          -- picker would quietly omit a machine. (No backticks in a tagged
          -- template -- one would end the string.)
          AND r.date >= ${instants.from}
          AND r.date < ${instants.to}
        ORDER BY r.work_unit_name, r.work_unit_id
      `;

      return { machines };
    });
  }
}

export { ProductReportReaderRepository };
export type { ProductReportReader };
