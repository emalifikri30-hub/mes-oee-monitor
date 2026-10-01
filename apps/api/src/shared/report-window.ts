import type { GoldDB } from "./database/postgres.js";
import type { Fragment } from "postgres";

// THE WINDOW A PERIOD REPORT COVERS, AND THE TWO PREDICATES EVERY READER OF IT
// BUILDS — shared by the LINE reports and the SKU ones.
//
// WHY IT MOVED HERE. Both live in work-center-repository.ts until 2026-09-03, and
// the SKU report needs the identical pair: same half-open date range, same
// optional shift narrowing, same scoping by work_center_id. Modules must not
// import each other's internals (AGENTS.md), so the alternative was a second copy
// — and a drift between two copies of `inDateRange` would make the SKU Pareto and
// the Line Pareto disagree about which rows belong to a day, on two screens one
// click apart, with neither raising. shared/README.md's rule is to move a thing
// here on its second caller; this is that.
//
// The SUBJECT is not in here. These functions scope by work_center_id and take
// any extra predicate as a Fragment, which is how the SKU reader adds its product
// filter without this file learning that SKUs exist — the same parameterisation
// loss-aggregate.ts uses for its row source.
//
// THE TWO HALVES NOW SERVE DIFFERENT NUMBERS OF SUBJECTS, and that is the one
// thing to know before reading further. `inDateRange` takes a bare `DateRange` and
// serves all four subjects, AREA included. `scopedRows` still hardcodes
// `j.work_center_id`, so it serves the three that are scoped by a line — the area
// reader writes its own `WHERE`, because its scope column is `area_id` and two of
// its three source tables carry one while the third does not. Widening
// `scopedRows` with a scope-column parameter was the obvious move and is the wrong
// one: it would turn a helper that states one predicate into a helper that
// composes any predicate, which is a query builder, and the area reader's three
// reads do not agree on enough for it to have saved a line.

// THE HALF-OPEN DAY RANGE, ON ITS OWN, WITHOUT A SUBJECT.
//
// Split out for the AREA reports, whose reads scope by `area_id` and therefore
// cannot carry a `workCenterId` — but which must not restate the half-open rule
// below, because that rule is the one thing here that renders a plausible number
// when it is got wrong.
//
// A TYPE AND NOT A SECOND FUNCTION. `inDateRange` now takes this, so every
// subject — machine, line, SKU and area — reaches ONE statement of `>= from AND
// < to`. The alternative, an `inAreaDateRange` beside it, is exactly the drift
// this file's header says would make two Paretos one click apart disagree about
// which rows belong to a day.
type DateRange = {
  // Inclusive.
  dateFrom: string;
  // EXCLUSIVE. See ReportWindow.dateTo for why it is never equal to dateFrom.
  dateTo: string;
};

// `LineWindow` in the work-center module until it had a second subject.
type ReportWindow = DateRange & {
  workCenterId: number;
  // `dateFrom` and `dateTo` come from DateRange above. The rule they carry, and
  // which no reader may restate: `dateTo` is EXCLUSIVE and NEVER equal to
  // dateFrom — even at shift grain, where it is the next day. The source tables
  // key on a `shift_date`, so a shift's rows carry the business DATE and are
  // narrowed by `shift` instead; a range of zero width would match nothing and
  // every card would render empty.
  //
  // A month is 28 to 31 days, so the end is an interval rather than a computed
  // day, which is the other reason this is a range and not a pair of equal dates.
  //
  // Null at day and month grain. At shift grain it narrows the source tables'
  // third key column.
  shift: number | null;
  timeZone: string;
};

// HALF-OPEN, `>= from AND < to`, and it must stay that way. `BETWEEN` is
// inclusive on both ends, so a month window would double-count the first day of
// the next month against the last of this one — the class of error that renders a
// plausible total rather than throwing.
//
// Both bounds are cast `::date` rather than compared as text: the columns are
// real `date`s and a text comparison would sort '2026-9-1' before '2026-08-31'.
function inDateRange(db: GoldDB, column: Fragment, { dateFrom, dateTo }: DateRange): Fragment {
  return db`${column} >= ${dateFrom}::date AND ${column} < ${dateTo}::date`;
}

// The row source every shift-keyed aggregate reads: one line, one date range,
// optionally one shift.
//
// `extra` IS HOW A SUBJECT NARROWS FURTHER WITHOUT THIS FILE KNOWING HOW. The SKU
// reader passes `AND j.product_id = ${id}`; the line reader passes nothing. A
// `productId?: number` parameter here would have been smaller and is the wrong
// shape — it would put one subject's vocabulary into the helper both share, and
// the next subject would add a second optional field beside it.
//
// The alias is `j` and callers must use it. Interpolating a Fragment that says
// `p.product_id` into this produces a runtime "missing FROM-clause entry", which
// no fakeSql test can see because that fake matches SQL text and never executes.
function scopedRows({
  db,
  table,
  window,
  dateColumn,
  extra,
}: {
  db: GoldDB;
  table: Fragment;
  window: ReportWindow;
  dateColumn: Fragment;
  extra?: Fragment;
}): Fragment {
  const shiftSql = window.shift === null ? db`` : db`AND j.shift = ${window.shift}`;
  const extraSql = extra ?? db``;

  return db`
    SELECT j.*
    FROM ${table} j
    WHERE j.work_center_id = ${window.workCenterId}
      AND ${inDateRange(db, dateColumn, window)}
      ${shiftSql}
      ${extraSql}
  `;
}

export { inDateRange, scopedRows };
export type { DateRange, ReportWindow };
