import { asOperator, traced } from "../../shared/database/postgres.js";
import { EDITABLE_COLUMN, EDITABLE_FIELDS, SCOPE_COLUMN } from "./downtime.js";
import { resolveReportWindow, type ReportGrain, type ShiftId } from "../../shared/shift-window.js";

import type {
  DowntimeCategory,
  DowntimeEvent,
  DowntimeEdit,
  DowntimeRowValues,
  EditableField,
  EditConflictCause,
  EditDowntimeInput,
  EditDowntimeOutcome,
  DowntimeHistoryEntry,
  DowntimeListItem,
  DowntimeReasonBucket,
  DowntimeSortBy,
  DowntimeSortDir,
  ReasonMeasure,
  ReasonSelector,
  SupportedScope,
  TimelineWindow,
} from "./downtime.js";
import type { GoldDB, TransactionDB } from "../../shared/database/postgres.js";
import type { Paged } from "@molca/network";
import type { Fragment } from "postgres";

type ListOverlappingInput = {
  scope: SupportedScope;
  scopeId: number;
  window: TimelineWindow;
  // ON THE ROOT OF THE INPUT CHAIN, ON PURPOSE. Every other input type in this
  // file is built from this one — PaginateDowntimeInput, AggregateByReasonInput,
  // AggregateAllReasonsInput, PaginateByReasonInput, ListReasonHistoryInput — so
  // one field here reaches all six, and `scopeAndWindow` below is the single
  // fragment every read passes through. Adding it per-type would be five chances
  // to leave one out, and the one left out would answer with the whole line's
  // stops under a SKU heading.
  productId?: number;
};

// `timeZone` is not a column — the service stamps it on. Keeping it out of the
// row type stops a SELECT from being written for it.
type DowntimeRow = Omit<DowntimeListItem, "timeZone">;

// The edit path's projection, before toStringList runs over the two jsonb
// columns. `unknown` is honest about what postgres.js hands back for jsonb: an
// already-parsed value of any shape, which is exactly why it needs normalising
// rather than casting.
type EditableStopRow = Omit<DowntimeRowValues, "reason" | "actions"> & {
  reason: unknown;
  actions: unknown;
};

type PaginateDowntimeInput = ListOverlappingInput & {
  limit: number;
  offset: number;
  sortBy: DowntimeSortBy;
  sortDir: DowntimeSortDir;
};

// `now` is a parameter rather than SQL `now()`, for the reason flattenTimeline
// takes one: an open stop's contribution depends on it, and a clock the tests
// cannot move is a clock the tests cannot exercise.
type AggregateByReasonInput = ListOverlappingInput & {
  category: DowntimeCategory;
  now: Date;
  // Absent for the whole-shift breakdown; present for the per-reason
  // drill-down. Same input type either way, so both paths provably run over the
  // same clipped row set.
  selector?: ReasonSelector;
};

// The WHOLE-WINDOW aggregate's extra inputs. Its own type rather than two more
// fields on AggregateByReasonInput, which is shared with the per-reason
// drill-down and the detail pager — neither of which ranks or truncates anything,
// and both of which would then have to supply a measure they do not use.
type AggregateAllReasonsInput = AggregateByReasonInput & {
  measure: ReasonMeasure;
  limit: number;
};

// The ACTIONS aggregate's inputs.
//
// NO `category`, and that absence is the difference between the two Paretos. A
// reason explains WHY a stop happened, so it belongs to exactly one of the three
// operation types and the breakdown is read one type at a time. An action is what
// somebody DID about a stop, and "Replace Belt" is the same action whether the
// stop was planned or not — splitting it by category would scatter one action
// across three charts and rank none of them correctly.
type AggregateActionsInput = ListOverlappingInput & {
  now: Date;
  measure: ReasonMeasure;
  limit: number;
};

// `dropped` is a data-quality signal, not part of the HTTP contract — the
// service records it and strips it before responding.
type ReasonAggregate = {
  // The top `limit` by the requested measure. `groupCount` says how many there
  // were in total, which is what lets the service decide whether a tail exists
  // and how many reasons are inside it.
  buckets: DowntimeReasonBucket[];
  groupCount: number;
  totalFrequency: number;
  totalDurationMs: number;
  dropped: number;
};

type PaginateByReasonInput = AggregateByReasonInput & {
  limit: number;
  offset: number;
  sortBy: DowntimeSortBy;
  sortDir: DowntimeSortDir;
};

type ListReasonHistoryInput = ListOverlappingInput & {
  category: DowntimeCategory;
  selector: ReasonSelector;
};

// `trackedMembers` / `totalMembers` are what separate "nothing has been edited"
// from "none of these stops can be tracked at all". See listReasonHistory.
type ReasonHistoryRows = {
  entries: DowntimeHistoryEntry[];
  totalMembers: number;
  trackedMembers: number;
};

type DowntimeReader = {
  getWindow: (
    grain: ReportGrain,
    date: string,
    shift: ShiftId | undefined,
    timeZone: string,
  ) => Promise<TimelineWindow>;
  listOverlapping: (input: ListOverlappingInput) => Promise<DowntimeEvent[]>;
  paginateDowntime: (input: PaginateDowntimeInput) => Promise<Paged<DowntimeRow>>;
  aggregateByReason: (input: AggregateAllReasonsInput) => Promise<ReasonAggregate>;
  // Pareto Actions, on the OEE Performance dashboard. Same aggregate shape as
  // aggregateByReason so the browser ranks and draws both with one implementation.
  aggregateByAction: (input: AggregateActionsInput) => Promise<ReasonAggregate>;
  paginateByReason: (input: PaginateByReasonInput) => Promise<Paged<DowntimeRow>>;
  aggregateOneReason: (input: AggregateByReasonInput) => Promise<DowntimeReasonBucket | null>;
  listReasonHistory: (input: ListReasonHistoryInput) => Promise<ReasonHistoryRows>;
  // One stop, addressed by its PUBLIC identity, with the four mutable values and
  // the span the freeze check needs. `undefined` means no such stop — which is
  // every stop the pipeline has loaded, since it does not write source_event_id
  // (contract §3.3.2). A few hand-seeded rows on the dev database do carry one.
  getEditableStop: (sourceEventId: string) => Promise<DowntimeRowValues | undefined>;
  getDowntimeWatermark: () => Promise<string | null>;
};

// The bucket row as SQL projects it. `workUnitNames` arrives as a Postgres text
// array, which postgres.js parses into a JS array — hence `unknown`, normalised
// through toStringList like `reason` and `actions` are.
type ReasonBucketRow = Omit<DowntimeReasonBucket, "workUnitNames"> & {
  workUnitNames: unknown;
};

type ReasonTotalsRow = {
  totalFrequency: number;
  totalDurationMs: number;
  dropped: number;
  groupCount: number;
};

type DowntimeReaderRepositoryDeps = {
  goldDb: GoldDB;
};

const TABLE_DOWNTIME_REPORT = "oee.downtime_reports";
const TABLE_DOWNTIME_HISTORY = "oee.downtime_report_history";
const TABLE_ETL_WATERMARKS = "oee.etl_watermarks";

class DowntimeReaderRepository implements DowntimeReader {
  private db: GoldDB;

  constructor({ goldDb }: DowntimeReaderRepositoryDeps) {
    this.db = goldDb;
  }

  // The window is resolved by its own query rather than folded into the event
  // query as a CTE. Two reasons: a cross-joined window vanishes when no downtime
  // rows match — which is exactly the case a clean shift hits — and the service
  // needs `from`/`to` as real values to clip against and to put in the response.
  //
  // The arithmetic stays on Postgres' date/time types so no session time zone can
  // move a boundary, matching the discipline in work-unit-repository.ts.
  async getWindow(
    grain: ReportGrain,
    date: string,
    shift: ShiftId | undefined,
    timeZone: string,
  ): Promise<TimelineWindow> {
    // Delegates to shared/shift-window.ts, which is the ONE statement of this
    // arithmetic — the shift report's activity feed needs the identical window,
    // and two copies would diverge on exactly the stops that straddle a boundary.
    // The traced() wrapper stays here so the span still names this table.
    //
    // Everything below this line is grain-blind: `scopeAndWindow` and every
    // caller of it take two instants and do not care whether they bound a shift,
    // a day or a month. That is what lets the day and month screens reuse this
    // whole read path rather than growing a parallel one.
    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      return await resolveReportWindow(this.db, grain, date, shift, timeZone);
    });
  }

  // The events behind the merged strip. The predicate is `scopeAndWindow` below,
  // which is where it is explained — do not restate it here.
  async listOverlapping(input: ListOverlappingInput): Promise<DowntimeEvent[]> {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      const rows = await this.db<DowntimeEvent[]>`
        SELECT id, category, start_at, end_at
        FROM oee.downtime_reports
        WHERE ${this.scopeAndWindow(input)}
        ORDER BY start_at, id
      `;

      return [...rows];
    });
  }

  // The detail table under the strip. Shares `scopeAndWindow` with the timeline
  // above it, so the rows listed here are exactly the records that strip was
  // drawn from — a stop straddling the shift boundary appears in both, and the
  // two can never disagree about what belongs to a shift.
  //
  // Unlike the timeline, nothing is merged: two overlapping stops are two rows.
  async paginateDowntime(input: PaginateDowntimeInput): Promise<Paged<DowntimeRow>> {
    // DESTRUCTURED FROM `input`, NOT IN THE SIGNATURE, and that is structural
    // rather than stylistic. `scopeAndWindow` takes the WHOLE input; a signature
    // that destructured it here would force this method to rebuild an object to
    // hand over, and every optional field added to ListOverlappingInput later
    // would be silently dropped by that rebuild. `productId` was, at five sites in
    // this file and six more in the service, and every one of them type-checked.
    const { limit, offset, sortBy, sortDir } = input;

    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      const whereSql = this.scopeAndWindow(input);

      const [rows, totals] = await Promise.all([
        this.db<DowntimeRow[]>`
          SELECT ${this.detailColumns()},
                 -- UNCLIPPED, unlike paginateByReason below. See the note on
                 -- scopeAndWindow: this table lists records, not time.
                 (extract(epoch from (end_at - start_at)) * 1000)::float8 AS duration_ms
          FROM oee.downtime_reports
          WHERE ${whereSql}
          ORDER BY ${this.orderBy(sortBy, sortDir)}
          LIMIT ${limit} OFFSET ${offset}
        `,
        // `::int` matters: postgres.js returns bigint columns as strings, and
        // totalElements is typed as a number. This count is also what the card
        // renders as "Downtime Frequency".
        this.db<{ value: number }[]>`
          SELECT count(id)::int AS value
          FROM oee.downtime_reports
          WHERE ${whereSql}
        `,
      ]);

      return {
        items: rows.map((row) => ({
          ...row,
          reason: toStringList(row.reason),
          actions: toStringList(row.actions),
        })),
        totalElements: totals[0]?.value ?? 0,
      };
    });
  }

  // The row set EVERY aggregate below runs over: each record belonging to the
  // shift, clipped to it, one row per stop. Optionally narrowed to one reason.
  //
  // A shared Fragment for the same reason `scopeAndWindow` is one. The buckets
  // and the totals are computed by two separate statements, and a Pareto whose
  // bars do not sum to its own denominator is a defect nobody would spot on
  // screen. The drill-down joined that arrangement rather than growing a fourth
  // copy of the arithmetic — see `clipDurationMs` and `primaryReason` below.
  private clipped(input: AggregateByReasonInput): Fragment {
    // DESTRUCTURED FROM `input`, NOT IN THE SIGNATURE, and that is structural
    // rather than stylistic. `scopeAndWindow` takes the WHOLE input; a signature
    // that destructured it here would force this method to rebuild an object to
    // hand over, and every optional field added to ListOverlappingInput later
    // would be silently dropped by that rebuild. `productId` was, at five sites in
    // this file and six more in the service, and every one of them type-checked.
    const { window, category, now, selector } = input;

    return this.db`
      SELECT
        ${this.primaryReason()} AS reason_key,
        work_unit_name,
        ${this.clipDurationMs(window, now)} AS duration_ms
      FROM oee.downtime_reports
      WHERE ${this.scopeAndWindow(input)}
        AND category = ${category}::oee.operation_type
        ${this.reasonFilter(selector)}
    `;
  }

  // The PRIMARY reason: element 0 and nothing else. The jsonb_typeof guard is
  // toStringList's rule expressed in SQL — a non-string element would otherwise
  // group under its own JSON text, e.g. '{"code": 7}'. The -> 0 operator on a
  // non-array jsonb returns NULL rather than erroring, so a malformed column
  // degrades into the unlabelled bucket instead of failing the request.
  // nullif(btrim(...)) then folds '[]', '[""]' and ['   '] into that same one
  // bucket, not several distinct empty ones.
  //
  // EXTRACTED so the grouping key and the drill-down's filter are one
  // expression. If they were written twice, a stop tagged
  // ["Machine_Stop", "Custom_Reason_1"] could group under one reason and be
  // listed under another, and the detail page would not sum to the bar it was
  // opened from. TODOS.md §27 names this as the trap.
  private primaryReason(): Fragment {
    return this.db`
      nullif(
        btrim(CASE WHEN jsonb_typeof(reason -> 0) = 'string' THEN reason ->> 0 END),
        ''
      )
    `;
  }

  // The PRIMARY action: element 0, and nothing else.
  //
  // THIS IS A DECISION ABOUT DOUBLE COUNTING, not a copy of primaryReason for
  // symmetry's sake. `actions` is a jsonb ARRAY an operator edits, and a stop
  // genuinely can carry several — "Replace Belt" AND "Clean". Crediting each of
  // them the stop's whole duration would make the bars sum to more than the
  // window's downtime, and a Pareto's cumulative line is a SHARE: past 100% it
  // stops meaning anything. Splitting the duration evenly across a stop's actions
  // would keep the total right and invent a number nobody measured — the plant
  // never recorded which action took how long.
  //
  // So the first action is taken as the one being accounted, exactly as
  // primaryReason takes the first reason. THE COST IS REAL AND THE CARD SAYS SO:
  // a second action recorded on a stop contributes nothing to this chart.
  //
  // Same jsonb_typeof guard and the same nullif for the same reasons — see
  // primaryReason, which this is otherwise a twin of.
  private primaryAction(): Fragment {
    return this.db`
      nullif(
        btrim(CASE WHEN jsonb_typeof(actions -> 0) = 'string' THEN actions ->> 0 END),
        ''
      )
    `;
  }

  // THE CLIP IS THE POINT.
  //
  //   duration = LEAST(end, to) - GREATEST(start, from)
  //
  // A stop straddling a shift boundary contributes only its overlap, which is
  // what the strip above the chart already draws (`clipToWindow` in
  // downtime-service.ts) and what makes the bars add up to a number worth
  // comparing against the shift's own availability figure.
  //
  // `coalesce(end_at, now)` rather than `window.to` for an open stop, matching
  // clipToWindow exactly: a stop with no end_at is still RUNNING, so during a
  // live shift it reaches `now`, not the end of a shift that has not happened
  // yet. For a historical report `now` is past `window.to` and LEAST picks `to`,
  // so the two forms agree everywhere except the one case where only this one is
  // right.
  //
  // The stored `duration` column is NEVER read. It is written independently of
  // the timestamps and can disagree with them (docs/gold-write-contract.md §3.3,
  // TODOS.md §10) — and it describes the WHOLE stop, which is the wrong number
  // here even when it agrees.
  //
  // EXTRACTED so the aggregate and the drill-down clip identically. A detail row
  // showing more minutes than it contributed to its own bar is exactly the
  // discrepancy §27 warns about, and no test on either side alone would see it.
  private clipDurationMs(window: TimelineWindow, now: Date): Fragment {
    return this.db`
      (extract(epoch from (
         LEAST(coalesce(end_at, ${now}), ${window.to})
         - GREATEST(start_at, ${window.from})
      )) * 1000)
    `;
  }

  // Narrows to ONE bucket, or to nothing at all when no selector is given —
  // which is how aggregateByReason keeps grouping over every reason.
  //
  // The unlabelled bucket is `IS NULL` on the same expression the GROUP BY uses,
  // never the string "Unspecified". That label is applied in the browser
  // (lib/pareto.ts) so a genuine reason of that exact text cannot merge into it;
  // a filter keyed on the label would match nothing here, or match the wrong
  // stops. TODOS.md §27, second trap.
  private reasonFilter(selector: ReasonSelector | undefined): Fragment {
    if (selector === undefined) return this.db``;

    return selector.kind === "unlabelled"
      ? this.db`AND ${this.primaryReason()} IS NULL`
      : this.db`AND ${this.primaryReason()} = ${selector.reason}`;
  }

  // The Availability Loss aggregate.
  //
  // TWO statements rather than one with a `sum() OVER ()`, for the reason
  // getWindow is its own query: a window function attached to the group rows
  // VANISHES when there are no group rows — and "no unplanned downtime this
  // shift" is precisely the case the totals and the dropped count exist to
  // describe. A single GROUPING SETS query was considered and rejected: with
  // scope narrowed to work-unit the second scan is over one machine's eight
  // hours, so it costs nothing, and two readable statements beat one clever one.
  // Descending by the measure being ranked, with the group key as a TOTAL
  // tiebreak.
  //
  // A LITERAL FRAGMENT PER MEASURE, not an interpolated column name — the same
  // allowlist rule `orderBy` follows for the detail table's sort. And the
  // tiebreak is not decoration: `reason_key` is the group key and therefore
  // unique, so without it two equal buckets could swap places between identical
  // requests. That mattered when the browser re-ranked anyway; it matters far more
  // now that this ordering DECIDES WHICH BUCKETS SURVIVE THE LIMIT — an unstable
  // sort would make the tail's membership flicker between two identical requests.
  private reasonOrder(measure: ReasonMeasure): Fragment {
    return measure === "frequency"
      ? this.db`ORDER BY count(*) DESC, reason_key ASC NULLS LAST`
      : this.db`ORDER BY sum(duration_ms) DESC NULLS LAST, reason_key ASC NULLS LAST`;
  }

  // The row set the ACTIONS aggregate runs over — every stop in the window,
  // clipped to it, keyed by its primary action.
  //
  // Its own method rather than a `groupKey` parameter on `clipped`, because the
  // two differ by a PREDICATE as well as a key: `clipped` narrows to one category
  // and optionally to one reason, and neither applies here. A shared builder
  // taking both a key and an optional category is a query builder, which is the
  // move report-window.ts's `scopedRows` header already refuses on the same
  // grounds.
  private clippedActions(input: AggregateActionsInput): Fragment {
    const { window, now } = input;

    return this.db`
      SELECT
        ${this.primaryAction()} AS reason_key,
        work_unit_name,
        ${this.clipDurationMs(window, now)} AS duration_ms
      FROM oee.downtime_reports
      WHERE ${this.scopeAndWindow(input)}
    `;
  }

  // Pareto Actions.
  //
  // Deliberately the SAME SHAPE as aggregateByReason below — two statements, the
  // same `duration_ms > 0` guard, the same totals and group count — so the
  // browser ranks and draws both with one implementation and one set of edge
  // cases. The column is still called `reason_key` inside the CTE for that
  // reason: the aggregate above it does not care what kind of key it is, and
  // renaming it here would fork two statements that must stay identical.
  async aggregateByAction(input: AggregateActionsInput): Promise<ReasonAggregate> {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      const clippedSql = this.clippedActions(input);

      const [rows, totals] = await Promise.all([
        this.db<ReasonBucketRow[]>`
          WITH clipped AS (${clippedSql})
          SELECT reason_key                                        AS reason,
                 coalesce(
                   array_agg(DISTINCT work_unit_name)
                     FILTER (WHERE work_unit_name IS NOT NULL),
                   '{}'
                 )                                                 AS work_unit_names,
                 count(*)::int                                     AS frequency,
                 round(sum(duration_ms))::float8                   AS duration_ms
          FROM clipped
          WHERE duration_ms > 0
          GROUP BY reason_key
          ${this.reasonOrder(input.measure)}
          LIMIT ${input.limit}
        `,
        this.db<ReasonTotalsRow[]>`
          WITH clipped AS (${clippedSql})
          SELECT count(*) FILTER (WHERE duration_ms > 0)::int   AS total_frequency,
                 coalesce(
                   round(sum(duration_ms) FILTER (WHERE duration_ms > 0)), 0
                 )::float8                                      AS total_duration_ms,
                 count(*) FILTER (WHERE duration_ms <= 0)::int  AS dropped,
                 (
                   SELECT count(*)::int
                   FROM (
                     SELECT 1 FROM clipped WHERE duration_ms > 0 GROUP BY reason_key
                   ) g
                 )                                              AS group_count
          FROM clipped
        `,
      ]);

      return {
        buckets: rows.map((row) => ({
          ...row,
          workUnitNames: toStringList(row.workUnitNames),
        })),
        totalFrequency: totals[0]?.totalFrequency ?? 0,
        totalDurationMs: totals[0]?.totalDurationMs ?? 0,
        dropped: totals[0]?.dropped ?? 0,
        groupCount: totals[0]?.groupCount ?? 0,
      };
    });
  }

  async aggregateByReason(input: AggregateAllReasonsInput): Promise<ReasonAggregate> {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      const clippedSql = this.clipped(input);

      const [rows, totals] = await Promise.all([
        this.db<ReasonBucketRow[]>`
          WITH clipped AS (${clippedSql})
          SELECT reason_key                                        AS reason,
                 coalesce(
                   array_agg(DISTINCT work_unit_name)
                     FILTER (WHERE work_unit_name IS NOT NULL),
                   '{}'
                 )                                                 AS work_unit_names,
                 count(*)::int                                     AS frequency,
                 round(sum(duration_ms))::float8                   AS duration_ms
          FROM clipped
          -- The SQL twin of clipToWindow's end <= start guard. An inverted
          -- row (nothing prevents one — there is no CHECK constraint) or a stop
          -- that survives the clip as nothing would otherwise draw a zero- or
          -- negative-width bar. Counted rather than silently swallowed; the
          -- totals query below returns how many.
          WHERE duration_ms > 0
          GROUP BY reason_key
          -- THE ORDER NOW DECIDES WHAT THE CALLER SEES, not just the sequence it
          -- sees it in — see reasonOrder, and note the LIMIT below it.
          ${this.reasonOrder(input.measure)}
          LIMIT ${input.limit}
        `,
        // `::int` matters: postgres.js returns bigint columns as strings, and
        // these are typed as numbers. The coalesce on sum matters for a different
        // reason — sum over an empty set is NULL, and a null denominator reaches
        // the browser as a divide-by-null on the cumulative line.
        this.db<ReasonTotalsRow[]>`
          WITH clipped AS (${clippedSql})
          SELECT count(*) FILTER (WHERE duration_ms > 0)::int   AS total_frequency,
                 coalesce(
                   round(sum(duration_ms) FILTER (WHERE duration_ms > 0)), 0
                 )::float8                                      AS total_duration_ms,
                 count(*) FILTER (WHERE duration_ms <= 0)::int  AS dropped,
                 -- HOW MANY GROUPS EXIST, against how many the page query
                 -- returned — the difference is the tail's reason count.
                 --
                 -- A SUBQUERY, NOT count(DISTINCT reason_key): that skips NULL,
                 -- and NULL is a real bucket here (the unlabelled one). Counting
                 -- groups instead includes it exactly once, which is the
                 -- count(*)-not-count(column) rule pointed at a GROUP BY.
                 (
                   SELECT count(*)::int
                   FROM (
                     SELECT 1 FROM clipped WHERE duration_ms > 0 GROUP BY reason_key
                   ) g
                 )                                              AS group_count
          FROM clipped
        `,
      ]);

      return {
        buckets: rows.map((row) => ({
          ...row,
          workUnitNames: toStringList(row.workUnitNames),
        })),
        groupCount: totals[0]?.groupCount ?? 0,
        totalFrequency: totals[0]?.totalFrequency ?? 0,
        totalDurationMs: totals[0]?.totalDurationMs ?? 0,
        dropped: totals[0]?.dropped ?? 0,
      };
    });
  }

  // One projection for both detail tables, so the shared drawer they feed
  // (DowntimeDetailSheet) can never find a field present on one and missing on
  // the other. The 0007 columns are all NULL until the DAG writes them.
  private detailColumns(): Fragment {
    return this.db`
      id, source_event_id, category, reason, actions,
      work_unit_name, work_center_id, work_center_name, area_name,
      detail_reason, input_by, maintained_by,
      start_at, end_at
    `;
  }

  // The stops behind ONE reason, paged. The drill-down under the Pareto's eye
  // button.
  //
  // Differs from paginateDowntime in exactly two ways, and both are load-bearing:
  // it filters on the PRIMARY reason (never any element of the array), and its
  // duration is CLIPPED to the shift window. Without the clip a straddling stop
  // shows more minutes here than it contributed to the bar this page was opened
  // from; without the primary-reason rule a multi-reason stop appears under a
  // bucket that did not count it. TODOS.md §27.
  async paginateByReason(input: PaginateByReasonInput): Promise<Paged<DowntimeRow>> {
    // DESTRUCTURED FROM `input`, NOT IN THE SIGNATURE, and that is structural
    // rather than stylistic. `scopeAndWindow` takes the WHOLE input; a signature
    // that destructured it here would force this method to rebuild an object to
    // hand over, and every optional field added to ListOverlappingInput later
    // would be silently dropped by that rebuild. `productId` was, at five sites in
    // this file and six more in the service, and every one of them type-checked.
    const { window, category, now, selector, limit, offset, sortBy, sortDir } = input;

    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      const whereSql = this.db`
        ${this.scopeAndWindow(input)}
        AND category = ${category}::oee.operation_type
        ${this.reasonFilter(selector)}
      `;

      const [rows, totals] = await Promise.all([
        this.db<DowntimeRow[]>`
          SELECT ${this.detailColumns()},
                 ${this.clipDurationMs(window, now)}::float8 AS duration_ms
          FROM oee.downtime_reports
          WHERE ${whereSql}
          ORDER BY ${this.orderBy(sortBy, sortDir)}
          LIMIT ${limit} OFFSET ${offset}
        `,
        this.db<{ value: number }[]>`
          SELECT count(id)::int AS value
          FROM oee.downtime_reports
          WHERE ${whereSql}
        `,
      ]);

      return {
        items: rows.map((row) => ({
          ...row,
          reason: toStringList(row.reason),
          actions: toStringList(row.actions),
        })),
        totalElements: totals[0]?.value ?? 0,
      };
    });
  }

  // The single bucket the drill-down's summary card renders.
  //
  // Deliberately NOT a hand-written aggregate: it delegates to aggregateByReason
  // with a selector, so the numbers on the detail page are produced by the very
  // code that produced the bar. Two aggregates that merely agree today would
  // drift the first time either is touched, and a summary card disagreeing with
  // the chart it was opened from is a defect no screenshot would reveal.
  //
  // Returns null when the selector matches nothing — the caller turns that into
  // a 404 rather than an empty page pretending the reason exists.
  async aggregateOneReason(input: AggregateByReasonInput): Promise<DowntimeReasonBucket | null> {
    // `measure` and `limit` are inert here and are passed only to satisfy the
    // shared implementation: the selector has already narrowed the GROUP BY to a
    // single bucket, so there is nothing to rank and nothing to truncate. `1`
    // rather than the endpoint's default so that stays obvious at a glance.
    const { buckets } = await this.aggregateByReason({ ...input, measure: "duration", limit: 1 });
    return buckets[0] ?? null;
  }

  // The Changes History panel.
  //
  // Two numbers alongside the entries, because an empty list is ambiguous and
  // the flattering reading is the wrong one. `totalMembers` is how many stops
  // are in this bucket; `trackedMembers` is how many of them carry a
  // source_event_id and could therefore ever have history at all. Today that is
  // zero everywhere, so reporting only `entries` would render "no changes" over
  // data nothing is capable of tracking. Same silent-failure shape as TODOS.md §8.
  async listReasonHistory(input: ListReasonHistoryInput): Promise<ReasonHistoryRows> {
    // DESTRUCTURED FROM `input`, NOT IN THE SIGNATURE, and that is structural
    // rather than stylistic. `scopeAndWindow` takes the WHOLE input; a signature
    // that destructured it here would force this method to rebuild an object to
    // hand over, and every optional field added to ListOverlappingInput later
    // would be silently dropped by that rebuild. `productId` was, at five sites in
    // this file and six more in the service, and every one of them type-checked.
    const { category, selector } = input;

    return await traced("SELECT", TABLE_DOWNTIME_HISTORY, async () => {
      const membersSql = this.db`
        SELECT source_event_id
        FROM oee.downtime_reports
        WHERE ${this.scopeAndWindow(input)}
          AND category = ${category}::oee.operation_type
          ${this.reasonFilter(selector)}
      `;

      const [entries, counts] = await Promise.all([
        this.db<DowntimeHistoryEntry[]>`
          WITH members AS (${membersSql})
          SELECT h.id, h.source_event_id, h.changed_at, h.changed_by,
                 h.field, h.old_value, h.new_value
          FROM oee.downtime_report_history h
          JOIN members m ON m.source_event_id = h.source_event_id
          -- id breaks the tie so two fields changed in one edit have a stable
          -- order, exactly as orderBy does for the record tables.
          ORDER BY h.changed_at DESC, h.id DESC
        `,
        this.db<{ totalMembers: number; trackedMembers: number }[]>`
          WITH members AS (${membersSql})
          SELECT count(*)::int                                        AS total_members,
                 count(*) FILTER (WHERE source_event_id IS NOT NULL)::int
                                                                      AS tracked_members
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

  // One stop, by source_event_id, in the shape the edit path needs.
  //
  // WHY THIS IS READ BEFORE THE WRITE TRANSACTION RATHER THAN INSIDE IT.
  //
  // The freeze check has to run against oee.work_unit_shift_report_approvals,
  // which belongs to the work-unit module and is reached through a port
  // (DowntimeApprovalReader). A port cannot join this repository's transaction
  // without handing the transaction handle across the module boundary, which is
  // the coupling the port exists to prevent. So the service reads the stop here,
  // checks the freeze, and only then opens the write transaction — which reads
  // the row AGAIN, because the diff must be taken against what the transaction
  // itself can see.
  //
  // THE RESIDUAL RACE, STATED RATHER THAN HIDDEN. Between this read and the
  // UPDATE's commit, somebody could approve the report, and the edit would land
  // on a report that is now closed. The window is two short statements wide, the
  // approval event and the edit are both in the trail with their instants, and
  // the alternative costs the module boundary. Compare the case this design DOES
  // close: a straddling stop silently moving an approved report's numbers, which
  // was not a race at all but a permanent hole.
  //
  // ADDRESSED ON source_event_id, NEVER id. Contract §2.1 loads this table
  // DELETE-then-INSERT, so `id` is re-minted on every pipeline run and an edit
  // keyed on it would eventually address a different stop. That is also why
  // oee.downtime_report_history keys on this column.
  async getEditableStop(sourceEventId: string): Promise<DowntimeRowValues | undefined> {
    return await traced("SELECT", TABLE_DOWNTIME_REPORT, async () => {
      const rows = await this.db<EditableStopRow[]>`
        SELECT ${this.detailColumns()}, work_unit_id
        FROM oee.downtime_reports
        WHERE source_event_id = ${sourceEventId}
        LIMIT 1
      `;

      const row = rows[0];
      if (row === undefined) return undefined;

      // toStringList for the reason paginateDowntime uses it: these are jsonb
      // arrays of plain strings, and a malformed element must not reach the diff
      // — where it would compare unequal to itself on every subsequent edit and
      // make the field permanently "changed".
      return {
        ...row,
        reason: toStringList(row.reason),
        actions: toStringList(row.actions),
      };
    });
  }

  // How far the pipeline has loaded oee.downtime_reports. A MISSING ROW MEANS
  // NEVER LOADED, hence null rather than a throw or a default date.
  //
  // Its own query rather than a join onto the aggregate, for the reason getWindow
  // is separate: a joined watermark vanishes when no downtime rows match, and no
  // rows is exactly the case this value exists to explain. TODOS.md §8.
  async getDowntimeWatermark(): Promise<string | null> {
    return await traced("SELECT", TABLE_ETL_WATERMARKS, async () => {
      const rows = await this.db<{ lastBusinessDate: string | null }[]>`
        SELECT to_char(last_business_date, 'YYYY-MM-DD') AS last_business_date
        FROM oee.etl_watermarks
        WHERE table_name = 'downtime_reports'
        LIMIT 1
      `;

      return rows[0]?.lastBusinessDate ?? null;
    });
  }

  // Scope + window, shared by ALL THREE readers so they can never drift apart:
  // the merged timeline (`listOverlapping`), the raw detail table
  // (`paginateDowntime`) and the reason aggregate (`clipped`). This is the one
  // statement of which records belong to a shift, and it is the only reason a
  // Pareto can be trusted against the strip drawn above it.
  //
  // It decides MEMBERSHIP only. Most consumers then clip the rows it returns to
  // the window — `clipToWindow` in downtime-service.ts for the strip, the
  // `clipDurationMs` Fragment for the aggregate and for the per-reason
  // drill-down — because a stop that merely overlaps the shift did not spend all
  // of itself inside it.
  //
  // ONE consumer deliberately does not clip: `paginateDowntime`, the Downtime
  // Details table on the shift report. It lists records, not time, and its
  // Duration column means "how long was this stop", not "how much of it fell in
  // this shift". `paginateByReason` is the clipping sibling beside it and the
  // difference is the whole reason they are two methods — the drill-down must
  // reconcile with the bar it was opened from, and this table must not silently
  // change the number it has always shown.
  //
  // ONE predicate now, where there used to be two. TODOS.md §69 / §10.
  //
  // WHAT WAS HERE, AND WHY IT IS GONE. Until 2026-09-02 this carried a NARROWING
  // on `date` — `date BETWEEN window.from - MAX_OPEN_DOWNTIME_DAYS AND window.to`
  // — alongside the real `start_at`/`end_at` overlap test. The narrowing existed
  // only to keep the scan sargable, because the comparison form of the overlap
  // could not use an index. Its cost was a SILENT HORIZON: a stop open longer
  // than seven days dropped out of every window that should have contained it,
  // with no error and nothing in any log. `0013` built `dt_reports_span_gist` to
  // remove the trade-off; this is the caller finally being unbound.
  //
  // THE EXPRESSION IS COPIED FROM THE INDEX, CHARACTER FOR CHARACTER, `greatest`
  // included. `0013`'s header is emphatic about it: a near-miss silently falls
  // back to a sequential scan, and nothing fails — the page just gets slower as
  // the table grows. If you edit this, re-run the EXPLAIN in
  // downtime-repository.integration.test.ts, which asserts an index scan rather
  // than trusting the shape.
  //
  // `&&` on two half-open ranges IS the overlap test, and it keeps the property
  // the old pair had deliberately: there is NO `start_at >= from` lower bound, so
  // a stop that began before the window and is still running is kept and clipped
  // rather than dropped.
  //
  //   window        |<------------------->|
  //   still open  --+---------------------+-------->    kept, clipped both ends
  //   ended early   |   |-----|           |            kept
  //   after         |                     |  |----|    excluded — ranges disjoint
  //   open 3 weeks  +---------------------+-------->    NOW KEPT; the horizon
  //                                                     used to drop this one
  //
  // ONE BEHAVIOUR CHANGED BESIDES THE HORIZON, and it is why
  // downtime_rows_dropped_total means less than it did. `greatest(...)` makes an
  // INVERTED row (end_at < start_at) collapse to an EMPTY range, and `&&` never
  // matches empty — so malformed rows are now excluded HERE instead of being
  // returned and discarded by `clipToWindow`. `0013`'s header anticipated exactly
  // this and called it "the same outcome the service already produces, reached
  // without an exception". True for the timeline; the cost is that the counter
  // which used to surface them per-request now mostly cannot. See metrics.ts and
  // TODOS.md §70 — the detection wants to be a data-quality check over the table,
  // not a side effect of drawing a strip.
  //
  // NO `date` READER LEFT. That was this predicate's last one in a read path,
  // which is what TODOS.md §69 step 3 asked for — reached by removing the need
  // for the column rather than by re-pointing it at `business_date`, which is
  // NULL on every row until the pipeline writes it (contract §22).
  private scopeAndWindow({ scope, scopeId, window, productId }: ListOverlappingInput): Fragment {
    // THE SKU FILTER, AND ITS ABSENCE IS NOT THE SAME AS A NULL CHECK.
    //
    // Omitted, this adds no predicate at all, so every shipped caller sees exactly
    // what it saw before the column existed. Present, it narrows to one SKU — and
    // EXCLUDES every stop the pipeline has not attributed, because
    // `product_id = $` is false for NULL rather than unknown-but-included.
    //
    // That exclusion is the point and also the hazard: with 0020's column
    // unwritten it excludes EVERYTHING, and the caller gets an empty answer that
    // reads as "this SKU never stopped". `countUnattributedDowntime` in the
    // product-report module exists to make that state visible, and it deliberately
    // does NOT go through this fragment — a count taken after this predicate would
    // be zero every time and look right.
    const productSql = productId === undefined ? this.db`` : this.db`AND product_id = ${productId}`;

    return this.db`
      ${this.db(SCOPE_COLUMN[scope])} = ${scopeId}
      AND tstzrange(start_at, greatest(coalesce(end_at, 'infinity'::timestamptz), start_at), '[)')
          && tstzrange(${window.from}, ${window.to}, '[)')
      ${productSql}
    `;
  }

  // Sorting goes through an allowlist of fragments, never an interpolated column
  // name. `duration` repeats the expression rather than referencing the output
  // alias so the ORDER BY does not depend on the SELECT list.
  //
  // NULLS LAST keeps still-running stops (no end_at, so no duration) at the
  // bottom either way, and `id` breaks ties so paging is stable — without it,
  // rows sharing a start time can reappear on two pages.
  private orderBy(sortBy: DowntimeSortBy, sortDir: DowntimeSortDir): Fragment {
    const column = {
      category: this.db`category`,
      startAt: this.db`start_at`,
      duration: this.db`(end_at - start_at)`,
    }[sortBy];

    const direction = sortDir === "asc" ? this.db`ASC` : this.db`DESC`;

    return this.db`${column} ${direction} NULLS LAST, id ASC`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The WRITER — a separate class, and the type name is the only guard there is
// ─────────────────────────────────────────────────────────────────────────────
//
// The Gold pool is read-WRITE — tierPool(config.database.gold, ..., false) in
// infra-module.ts — so nothing physical stops DowntimeReaderRepository above from
// issuing an UPDATE. Splitting the writer into its own class and its own Awilix
// registration is what makes "this module's reads cannot mutate" a statement the
// compiler checks, and work-unit-module.ts already sets the precedent.

type DowntimeWriter = {
  editDowntime: (input: EditDowntimeInput) => Promise<EditDowntimeOutcome>;
};

type DowntimeWriterRepositoryDeps = {
  goldDb: GoldDB;
};

class DowntimeWriterRepository implements DowntimeWriter {
  private db: GoldDB;

  constructor({ goldDb }: DowntimeWriterRepositoryDeps) {
    this.db = goldDb;
  }

  // The four mutable fields of one stop, plus the trail that says what moved.
  //
  // ONE TRANSACTION, AND EVERY STATEMENT IN IT IS THERE FOR A REASON THAT IS NOT
  // OBVIOUS. Modelled statement-for-statement on
  // WorkUnitReportWriterRepository.closeShiftReport, whose header argues the
  // shared parts at length.
  //
  //   1. set_config(application_name) via asOperator — so oee.write_audit can
  //      separate this service's handful of operator writes from its thousands of
  //      reads. SET LOCAL semantics, so it reverts at COMMIT and the pooled
  //      connection does not mislabel the next request. postgres.ts states that
  //      BOTH mutations must write the identical string or the audit query
  //      returns half the answer; this is the second one.
  //
  //   2. Re-read the row INSIDE the transaction. The service has already read it
  //      once, to feed the freeze check — see getEditableStop — but the diff must
  //      be taken against what this transaction can see, not against what a
  //      previous statement saw. A separate statement for closeShiftReport's
  //      reason too: folded into the UPDATE, "no such stop" and "somebody else
  //      changed it" would both be zero rows and 404 and 412 would collapse.
  //
  //   3. The diff. NOTHING CHANGED IS A REAL OUTCOME: it commits, writes no
  //      history and emits no metric, because a trail row saying a field changed
  //      from X to X is noise in the one place noise is expensive.
  //
  //   4. The guarded UPDATE. Its row count IS the outcome:
  //        matched -> 1 row -> edited
  //        baseline stale, or the row vanished -> 0 rows -> statement 5 decides
  //      All four columns are SET, not just the changed ones — the guard already
  //      pins the unchanged three to their current values, so writing them back
  //      is a no-op and the SET clause stays one shape instead of sixteen.
  //
  //   5. Only on 0 rows: WHICH writer got there first. See EditConflictCause.
  //
  // ONE KNOWN LIMITATION, WHICH IS A PROPERTY OF THE GUARD AND NOT A BUG HERE.
  // `reason` and `actions` are jsonb columns that toStringList exists to defend
  // against — it drops non-string elements, because the pipeline has never been
  // constrained to write clean string arrays. A stop whose column holds something
  // else (say [{"code": 7}]) is READ as [], so the browser sends [] as its
  // baseline, and `reason = '[]'::jsonb` then matches nothing: that stop can
  // never be edited, and the operator is told the pipeline reloaded it. The round
  // trip through the read path is what loses the malformed original, so no guard
  // written here can recover it. Narrow — contract §3.3.1 is asking for `reason`
  // to become a real column anyway — and recorded in TODOS.md rather than worked
  // around with a second, looser comparison path.
  //
  //   6. The history rows, in the SAME transaction. TODOS.md §21's rule: "A trail
  //      that can disagree with the row it describes is worse than none." ONE
  //      statement over unnest rather than up to four INSERTs, which is also the
  //      shape work-unit-repository.ts uses for its array binds.
  //
  // JSONB IS BOUND WITH db.json(), NEVER JSON.stringify(), and this is worth a
  // paragraph because the wrong version type-checks, reads correctly, and fails
  // silently in the direction that matters.
  //
  // postgres.js sends a JS string destined for jsonb by JSON-ENCODING it, so
  //
  //   reason = ${JSON.stringify(["a","b"])}::jsonb
  //
  // compares the column against the jsonb SCALAR STRING "[\"a\",\"b\"]" rather
  // than against the jsonb ARRAY ["a","b"]. They are never equal, so the guard
  // below matched ZERO rows for every edit — meaning every well-formed request
  // came back 412 "somebody else changed this stop" when nobody had. The unit
  // suite passed throughout: fakeSql records the bound parameter and never asks
  // Postgres what it means. It was the integration suite that caught it, which is
  // the whole argument for that suite existing.
  //
  // db.json() marks the value as jsonb properly, and the `::jsonb` cast is then
  // redundant — the column type drives it. This is also what the integration
  // fixtures have always used for these columns.
  async editDowntime({
    sourceEventId,
    next,
    baseline,
    changedBy,
  }: EditDowntimeInput): Promise<EditDowntimeOutcome> {
    return await traced("UPDATE", TABLE_DOWNTIME_REPORT, async () => {
      return await this.db.begin(async (tx) => {
        await asOperator(tx);

        const current = await this.readStop(tx, sourceEventId);
        if (current === undefined) return { kind: "not_found" as const };

        const changed = diffEdit(baseline, next);
        if (changed.length === 0) return { kind: "unchanged" as const, row: current };

        const updated = await tx<{ sourceEventId: string }[]>`
          UPDATE oee.downtime_reports
             SET category      = ${next.category}::oee.operation_type,
                 reason        = ${this.db.json(next.reason)},
                 actions       = ${this.db.json(next.actions)},
                 detail_reason = ${next.detailReason}::text
           WHERE source_event_id = ${sourceEventId}
             AND category        = ${baseline.category}::oee.operation_type
             AND reason          = ${this.db.json(baseline.reason)}
             AND actions         = ${this.db.json(baseline.actions)}
             -- IS NOT DISTINCT FROM, never plain equality: detail_reason is
             -- nullable, and "= NULL" is NULL rather than true, so an untouched
             -- empty detail reason would fail its own guard on every edit.
             AND detail_reason IS NOT DISTINCT FROM ${baseline.detailReason}::text
          RETURNING source_event_id
        `;

        if (updated.length === 0) {
          const cause = await this.diagnose(tx, sourceEventId);
          return { kind: "conflict" as const, cause };
        }

        // `field` carries the COLUMN name, which is what 0007's
        // ck_downtime_report_history_field admits — 'detail_reason', not
        // 'detailReason'. EDITABLE_COLUMN is the one mapping between the two, so
        // the constraint cannot be violated by a naming slip here.
        //
        // Bound as text[] and cast per element rather than as jsonb[]: an
        // untyped array parameter reaches Postgres as unknown, and this file
        // already records what that costs — the whole unit suite stays green
        // while the statement fails in production.
        const fields = changed.map((field) => EDITABLE_COLUMN[field]);
        const oldValues = changed.map((field) => JSON.stringify(baseline[field] ?? null));
        const newValues = changed.map((field) => JSON.stringify(next[field] ?? null));

        await tx`
          INSERT INTO oee.downtime_report_history
            (source_event_id, changed_by, field, old_value, new_value)
          SELECT ${sourceEventId}, ${changedBy},
                 t.field, t.old_value::jsonb, t.new_value::jsonb
          FROM unnest(${fields}::text[], ${oldValues}::text[], ${newValues}::text[])
            AS t(field, old_value, new_value)
        `;

        return { kind: "edited" as const, row: { ...current, ...next }, changed };
      });
    });
  }

  // WHICH writer moved the stop out from under the dialog, on the failure path
  // only.
  //
  // A pipeline restatement and a colleague's edit produce the SAME zero row
  // count, and they are not the same thing to tell an operator: "another user
  // changed this" when no user did names the wrong actor, during the one
  // interaction where being believed matters.
  //
  // THE AUDIT TRAIL IS THE DISCRIMINATOR, not the row's existence. Once the
  // pipeline writes source_event_id its loader UPSERTS, so a restated row is
  // PRESENT with pipeline values — existence cannot tell the two apart. What can
  // is that an operator edit leaves a downtime_report_history row explaining the
  // current value, and a pipeline restatement leaves nothing.
  //
  // KNOWN RESIDUAL: an operator who edits a field back to a value the pipeline
  // also writes is attributed to the operator. Accepted rather than chased — the
  // alternative is a version token plumbed through the browser, and both answers
  // produce the same 412 with slightly different copy.
  // Takes only the id: what matters is whether ANY recorded edit explains where
  // the row now stands, not which field the caller was trying to write.
  private async diagnose(tx: TransactionDB, sourceEventId: string): Promise<EditConflictCause> {
    const rows = await tx<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM oee.downtime_report_history h
        JOIN oee.downtime_reports d ON d.source_event_id = h.source_event_id
        WHERE h.source_event_id = ${sourceEventId}
          AND (
            (h.field = 'category'      AND h.new_value #>> '{}' = d.category::text)
            OR (h.field = 'reason'        AND h.new_value = d.reason)
            OR (h.field = 'actions'       AND h.new_value = d.actions)
            OR (h.field = 'detail_reason'
                 AND h.new_value #>> '{}' IS NOT DISTINCT FROM d.detail_reason)
          )
      ) AS exists
    `;

    return rows[0]?.exists === true ? "concurrent" : "restated";
  }

  // The same projection getEditableStop uses, run on the TRANSACTION handle.
  //
  // WHY THE COLUMN LIST IS WRITTEN OUT HERE rather than shared. The reader's copy
  // runs on the pool and reuses its own private detailColumns() fragment; this one
  // must run inside the transaction, and a Fragment built from the pool handle
  // cannot be interpolated into a statement on the transaction handle. Sharing it
  // would mean a builder generic over both handle types to save one line, and
  // the two classes are deliberately separate — see the header above.
  //
  // WHAT THIS MEANS IN PRACTICE: if a column is added to the edit response, it
  // has to be added in BOTH places. The type is what catches that — EditableStopRow
  // is derived from DowntimeListItem, so a missing column is a compile error here
  // rather than an undefined in the payload.
  private async readStop(
    tx: TransactionDB,
    sourceEventId: string,
  ): Promise<DowntimeRowValues | undefined> {
    const rows = await tx<EditableStopRow[]>`
      SELECT id, source_event_id, category, reason, actions,
             work_unit_id, work_unit_name, work_center_id, work_center_name, area_name,
             detail_reason, input_by, maintained_by,
             start_at, end_at
      FROM oee.downtime_reports
      WHERE source_event_id = ${sourceEventId}
      LIMIT 1
    `;

    const row = rows[0];
    if (row === undefined) return undefined;

    return { ...row, reason: toStringList(row.reason), actions: toStringList(row.actions) };
  }
}

// Which of the four fields actually moved.
//
// A FREE FUNCTION, exported for the tests, because this is the whole rule that
// decides what lands in the audit trail and it is worth being able to state it
// directly rather than through five statements of SQL.
//
// Iterates EDITABLE_FIELDS rather than Object.keys(next): a body carrying an
// extra key must not be able to produce a history row for a field 0007's CHECK
// would reject, and a missing key must not silently drop out of the comparison.
//
// ARRAYS COMPARE ELEMENT-WISE AND ORDER-SENSITIVELY, matching jsonb `=` in the
// UPDATE's guard. That is not a detail: element 0 of `reason` is the key the
// Pareto groups on, so reordering IS a change, and a set comparison here would
// call it a no-op and leave the guard and the diff disagreeing.
function diffEdit(baseline: DowntimeEdit, next: DowntimeEdit): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => {
    const before = baseline[field];
    const after = next[field];
    if (Array.isArray(before) && Array.isArray(after)) {
      return before.length !== after.length || before.some((item, i) => item !== after[i]);
    }
    return before !== after;
  });
}

// `reason` and `actions` are jsonb[] holding plain JSON strings. postgres.js
// parses them into a JS array already, so this is a guard rather than a parser:
// a null column, a non-array, or an element that is not a string must not reach
// the browser and render as "[object Object]".
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export { diffEdit, DowntimeReaderRepository, DowntimeWriterRepository, toStringList };
export type {
  AggregateByReasonInput,
  DowntimeReader,
  DowntimeWriter,
  DowntimeWriterRepositoryDeps,
  DowntimeReaderRepositoryDeps,
  DowntimeRow,
  ListOverlappingInput,
  ListReasonHistoryInput,
  PaginateByReasonInput,
  PaginateDowntimeInput,
  ReasonAggregate,
  ReasonHistoryRows,
};
