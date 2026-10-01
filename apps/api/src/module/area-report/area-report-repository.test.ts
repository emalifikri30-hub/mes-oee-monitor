import { describe, expect, it } from "vite-plus/test";

import { AreaReportReaderRepository } from "./area-report-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { AreaWindow } from "./area-report.js";

// The fakeSql harness, per the convention each repository test file follows. It
// matches SQL TEXT and never executes it: a projection naming a column that does
// not exist, an arithmetic error or a three-valued-logic surprise all pass here.
// Those belong to area-report-repository.integration.test.ts.
//
// WHAT *THIS* SUITE PINS IS SHAPE — which table, which predicate, which parameter
// — and at this grain the shape carries two hazards no integration test can
// isolate as cleanly:
//
//   1. EIGHT REPORT TABLES, EIGHT INDEPENDENT IDENTITY SEQUENCES. A read that
//      touched work_center_day_reports where it meant area_day_reports comes back
//      populated, with real ids and four real rates, about a LINE. So the
//      assertions name the table.
//   2. `area_id` IS DENORMALISED ONTO SOME SOURCE TABLES AND NOT OTHERS. Five of
//      the six reads scope by column; the SKU View has to name the area's LINES,
//      because oee.product_count_wc_day carries no area_id at all (0016). A read
//      that scoped the SKU View by an area_id it does not have would be a SQL
//      error — but one that FORGOT to scope it would silently return the whole
//      plant under one area's heading, which is the assertion below.
type Route = { match: RegExp; rows: unknown[] };
type Call = { text: string; params: unknown[] };

function isTemplateStrings(x: unknown): x is TemplateStringsArray {
  return Array.isArray(x) && "raw" in x;
}

function fakeSql(routes: Route[] = []) {
  const calls: Call[] = [];

  const sql = (first: unknown, ...values: unknown[]) => {
    if (!isTemplateStrings(first)) return { fragment: first };

    const text = first.join(" ? ").replaceAll(/\s+/g, " ").trim();
    calls.push({ text, params: values });

    return Promise.resolve(routes.find((r) => r.match.test(text))?.rows ?? []);
  };

  const find = (pattern: RegExp) => calls.find((c) => pattern.test(c.text));
  const findAll = (pattern: RegExp) => calls.filter((c) => pattern.test(c.text));

  return { goldDb: sql as unknown as GoldDB, calls, find, findAll };
}

// NESTED FRAGMENTS ARE THEIR OWN CALLS. The fake joins template chunks with " ? ",
// so an interpolated Fragment shows as `?` in the outer query and is recorded
// separately with its own params. Assertions about a predicate therefore look at
// the PREDICATE's call, not at the statement that embeds it.
const AREA_PRED = /AND r\.area_id = \?/;
const J_AREA_PRED = /^j\.area_id = \?$/;
const PAGE = /LIMIT/;
const COUNT = /count\(r\.id\)/;
const DETAIL = /WHERE r\.id = \?/;
const LINES = /SELECT DISTINCT j\.work_center_id/;
const PRODUCTS = /FROM oee\.product_count_wc_day p/;
const INFEED = /AS work_center_count.*infeed_uom_id IS NOT NULL/s;
const OUTPUT = /AS work_center_count.*output_uom_id IS NOT NULL/s;
const UNRESOLVED = /AS infeed_unresolved/;
// THE TWO REPORT TABLES ARE FRAGMENTS TOO, since `grainFrom` builds them — so the
// statement that reads one shows `FROM ?` and the name is its own recorded call.
// That is what these two match, and it is why a "which table" assertion here looks
// for a CALL rather than for text inside the query.
const DAY_TABLE = /^oee\.area_day_reports$/;
const MONTH_TABLE = /^oee\.area_month_reports$/;
// Two predicates that are interpolated FRAGMENTS rather than inline text, so they
// are recorded as their own calls — see the note on nested fragments above.
const HIDE_ZERO = /^AND r\.oee <> 0$/;
// The fake collapses whitespace but keeps the space its " ? " join introduces, so
// `${dateFrom}::date` is recorded as `? ::date`.
const RANGE = /^\? >= \? ::date AND \? < \? ::date$/;

function window(overrides: Partial<AreaWindow> = {}): AreaWindow {
  return {
    areaId: 2,
    dateFrom: "2026-09-01",
    dateTo: "2026-09-02",
    timeZone: "Asia/Jakarta",
    ...overrides,
  };
}

function filter(overrides: Record<string, unknown> = {}) {
  return {
    month: undefined,
    year: undefined,
    areaId: undefined,
    isHideZero: false,
    ...overrides,
  } as never;
}

// THE GRAIN IS A PARAMETER OF EVERY REPORT READ, and the two tables have
// INDEPENDENT identity sequences — so `getReport("day", 1)` and
// `getReport("month", 1)` are two different reports. Defaulting to "day" keeps the
// day-grain assertions below reading as they did; the month grain gets its own
// describe block at the end, which is where the pairing is asserted.
const DAY = "day" as const;
const MONTH = "month" as const;

describe("AreaReportReaderRepository.paginateReport", () => {
  function run(over: Record<string, unknown> = {}) {
    const { goldDb, find, findAll } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });
    const promise = repo.paginateReport({ grain: DAY, limit: 20, offset: 0, filter: filter(over) });
    return { find, findAll, promise };
  }

  it("reads oee.area_day_reports and no other report table", async () => {
    const { find, promise } = run();
    await promise;

    // The FROM clause is a Fragment, so the table name is its own call.
    expect(find(DAY_TABLE)).toBeDefined();
    expect(find(MONTH_TABLE)).toBeUndefined();
    expect(find(PAGE)!.text).not.toMatch(
      /work_center_day_reports|work_unit_day_reports|product_report_wc_day/,
    );
  });

  it("binds the area filter when one is given", async () => {
    const { find, promise } = run({ areaId: 2 });
    await promise;

    expect(find(AREA_PRED)!.params).toEqual([2]);
  });

  // An absent filter must add no predicate at all, not `area_id = NULL` — which is
  // NULL rather than false and would return an empty page for every caller. The
  // browser always sends one, so this arm is reached only by a hand-edited URL or
  // an API client, and it must get a page rather than a silently empty one.
  it("adds no area predicate when the filter is absent", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(AREA_PRED)).toBeUndefined();
  });

  // THE STRONGEST FORM THIS ASSERTION CAN TAKE. The predicates are built once and
  // interpolated into both statements, so the page and the count carry THE SAME
  // FRAGMENT OBJECTS — identity, not just equal text. Two separately-built
  // predicate sets could read identically today and drift tomorrow; the same object
  // cannot.
  //
  // THREE PARAMS THE COUNT HAS NO USE FOR, and they bracket the shared middle: the
  // GRAIN LITERAL leads (the page stamps it into its projection; the count selects
  // no grain), and LIMIT and OFFSET trail. The slice below is what makes their
  // positions explicit rather than assumed — an added interpolation anywhere in the
  // page query fails this test, which is the point.
  it("filters the page and the count with the very same fragments", async () => {
    const { find, promise } = run({ areaId: 2, year: 2026, month: 9, isHideZero: true });
    await promise;

    const page = find(PAGE)!.params;
    const count = find(COUNT)!.params;

    expect(page[0]).toBe("day");
    expect(page.slice(1, 1 + count.length)).toEqual(count);
    expect(page.slice(1 + count.length)).toEqual([20, 0]);
  });

  // THREE-VALUED AND DELIBERATELY SO. `oee` is nullable on this table, so
  // `oee <> 0` is NULL for a null row rather than true — the filter hides an
  // undefined area as well as a zero one, which is what it is for. `IS DISTINCT
  // FROM 0` would keep the null rows and is the "fix" this pins against.
  it("hides zero-OEE rows with a plain inequality, not IS DISTINCT FROM", async () => {
    const { find, promise } = run({ isHideZero: true });
    await promise;

    // ITS OWN CALL, because the predicate is a Fragment interpolated into both
    // statements — see the note on nested fragments above.
    expect(find(HIDE_ZERO)).toBeDefined();
    expect(find(/IS DISTINCT FROM/)).toBeUndefined();
  });

  it("adds no hide-zero predicate when the flag is off", async () => {
    const { find, promise } = run({ isHideZero: false });
    await promise;

    expect(find(HIDE_ZERO)).toBeUndefined();
  });

  // PAGING MUST BE TOTAL. `business_date` ties across areas on every day, so
  // without the id tiebreak a row can appear on two pages and another on none —
  // which no test asserting "rows came back" would catch.
  it("orders by date, then area, then id", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(PAGE)!.text).toMatch(/ORDER BY r\.business_date DESC, r\.area_id ASC, r\.id ASC/);
  });

  // A REAL `date` RANGE, not `extract`, when both halves are known: sargable
  // against the index, and no session zone can move a boundary. The month-only arm
  // is the one that has to use `extract`, because there is no year to build a
  // range from.
  it("uses a half-open make_date range when year and month are both given", async () => {
    const { find, promise } = run({ year: 2026, month: 9 });
    await promise;

    const period = find(/make_date/)!;
    expect(period.text).toMatch(/AND r\.business_date >= make_date/);
    expect(period.text).toMatch(/AND r\.business_date < make_date/);
    expect(period.text).toMatch(/interval '1 month'/);
    expect(find(/extract\(month/)).toBeUndefined();
  });
});

describe("AreaReportReaderRepository.getReport", () => {
  it("reads one row from oee.area_day_reports and stamps the grain", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [{ id: 1 }] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.getReport(DAY, 1);

    const call = find(DETAIL)!;
    expect(find(DAY_TABLE)).toBeDefined();
    expect(find(MONTH_TABLE)).toBeUndefined();
    // The grain is BOUND, not literal — stamped from the table that answered.
    expect(call.params).toContain("day");
    expect(call.params).toContain(1);
  });

  // ONE UNIT TRIPLE, NOT TWO, and it is a MASS. A projection that named
  // infeed_uom_* / output_uom_* here would be a paste from the line reader against
  // columns migration 0024 does not have — and the reason it does not have them is
  // the design (an area's members disagree about both sides, so mass is the only
  // unit that survives composition).
  it("selects the weight unit triple and neither of the line grain's", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [{ id: 1 }] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.getReport(DAY, 1);

    const text = find(DETAIL)!.text;
    expect(text).toMatch(/r\.weight_uom_id, r\.weight_uom_name, r\.weight_uom_code/);
    expect(text).not.toMatch(/infeed_uom|output_uom/);
  });

  // NOTHING IS COALESCED. A `coalesce(x, 0)` on this table would turn "the members
  // could not be brought to a common mass" into a measurement of zero — and that
  // null has a third meaning here, neither 0014's "the members disagreed" nor
  // 0023's "not known".
  it("coalesces nothing", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [{ id: 1 }] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.getReport(DAY, 1);

    expect(find(DETAIL)!.text).not.toMatch(/coalesce/);
  });

  // NO `teep` AND NO `effective_out` — both absences are the table's, and a
  // projection naming either would fail against the real schema. Pinned here
  // because the failure would be a 500 on a shipped screen rather than a build
  // error.
  it("selects neither teep nor effective_out", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [{ id: 1 }] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.getReport(DAY, 1);

    expect(find(DETAIL)!.text).not.toMatch(/teep|effective_out/);
  });
});

describe("AreaReportReaderRepository.listAreaLines", () => {
  // THE PIPELINE'S ATTRIBUTION, NOT A MASTER-DATA ROSTER, and the table it comes
  // off is the assertion: `oee.work_center_day_reports.area_id` records the area a
  // LINE's numbers were attributed to over this window, where a roster is the
  // area's membership NOW. It also keeps this read path free of an HTTP dependency.
  it("resolves the lines from oee.work_center_day_reports over the window", async () => {
    const { goldDb, find } = fakeSql([{ match: LINES, rows: [{ workCenterId: 2 }] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    const lines = await repo.listAreaLines(window());

    expect(find(LINES)!.text).toMatch(/FROM oee\.work_center_day_reports j/);
    expect(lines.workCenterIds).toEqual([2]);
  });

  it("scopes by area_id and by the half-open business-date range", async () => {
    const { goldDb, find, findAll } = fakeSql([{ match: LINES, rows: [] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listAreaLines(window());

    expect(find(J_AREA_PRED)!.params).toEqual([2]);
    // inDateRange's own fragment, recorded separately, and the column it compares
    // is a Fragment too — so the text is all placeholders and the DATES sit at
    // params 1 and 3. HALF-OPEN: `>=` and `<`, never BETWEEN, which is inclusive
    // on both ends and would double-count a month boundary.
    const range = find(RANGE)!;
    expect(range.params[1]).toBe("2026-09-01");
    expect(range.params[3]).toBe("2026-09-02");
    expect(findAll(/BETWEEN/)).toHaveLength(0);
    // The column the range was applied to, as its own call.
    expect(find(/^j\.business_date$/)).toBeDefined();
  });
});

describe("AreaReportReaderRepository.listProductCount", () => {
  // AN EMPTY LINE LIST MUST RETURN NO ROWS AND ISSUE NO QUERY. The dangerous
  // failure is the other direction: a read that dropped the line predicate would
  // return every SKU in the plant under one area's heading, populated and
  // plausible.
  it("issues no query at all when the area has no lines", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    const rows = await repo.listProductCount(window(), { workCenterIds: [] });

    expect(rows).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("binds the area's lines as one array parameter", async () => {
    const { goldDb, find } = fakeSql([{ match: PRODUCTS, rows: [] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listProductCount(window(), { workCenterIds: [2, 3] });

    const call = find(PRODUCTS)!;
    expect(call.text).toMatch(/WHERE p\.work_center_id = ANY\( ?\? ?\)/);
    expect(call.params[0]).toEqual([2, 3]);
  });

  // `factor_to_base` GOES ON THREE MEASURES AND NOT ON `good_out`. That pairing is
  // the whole of ProductCountItem's doctrine — Finish Good stays in the unit it
  // was counted in — and it is applied in exactly one place in the stack, which is
  // here.
  it("scales total_out, reject and rework but never good_out", async () => {
    const { goldDb, find } = fakeSql([{ match: PRODUCTS, rows: [] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listProductCount(window(), { workCenterIds: [2] });

    const text = find(PRODUCTS)!.text;
    expect(text).toMatch(/sum\(p\.total_out \* p\.factor_to_base\)/);
    expect(text).toMatch(/sum\(p\.reject \* p\.factor_to_base\)/);
    expect(text).toMatch(/sum\(p\.rework \* p\.factor_to_base\)/);
    expect(text).toMatch(/sum\(p\.good_out\)::numeric/);
    expect(text).not.toMatch(/good_out \* p\.factor_to_base/);
  });

  // GROUPED ON (product, uom, base_uom) AND NOT ON THE LINE. A SKU that ran on
  // three lines is ONE row here — that is the roll-up this grain legitimately does
  // — but the two unit codes stay in the key so a SKU its lines counted in
  // DIFFERENT units comes back as two rows rather than one row summing unlike
  // things.
  it("groups by product and both unit codes, never by the line", async () => {
    const { goldDb, find } = fakeSql([{ match: PRODUCTS, rows: [] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listProductCount(window(), { workCenterIds: [2, 3] });

    const text = find(PRODUCTS)!.text;
    expect(text).toMatch(/GROUP BY p\.product_id, p\.uom_code, p\.base_uom_code/);
    expect(text).not.toMatch(/GROUP BY[^-]*work_center_id/);
  });
});

describe("AreaReportReaderRepository.aggregateProductionUnits", () => {
  function run() {
    const { goldDb, find, findAll } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });
    return { find, findAll, promise: repo.aggregateProductionUnits(window()) };
  }

  // THE TWO SIDES ARE TWO STATEMENTS, NOT ONE UNION WITH A DISCRIMINATOR. A single
  // list a reader could total is the one arithmetic migration 0014 forbids —
  // totalling bags and cartons — so the split in SQL is what keeps them apart on
  // the wire.
  it("groups the two sides in two separate statements", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(INFEED)!.text).toMatch(/GROUP BY j\.infeed_uom_id/);
    expect(find(OUTPUT)!.text).toMatch(/GROUP BY j\.output_uom_id/);
    expect(find(INFEED)!.text).not.toMatch(/UNION/);
    expect(find(OUTPUT)!.text).not.toMatch(/UNION/);
  });

  // EACH SIDE EXCLUDES ITS OWN NULL UNIT, and only its own. A row with an infeed
  // unit and no output unit belongs in an infeed bucket and in the output
  // residual, which is 0014's per-side guard reaching the read.
  it("excludes only its own null unit on each side", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(INFEED)!.text).toMatch(/AND j\.infeed_uom_id IS NOT NULL/);
    expect(find(INFEED)!.text).not.toMatch(/output_uom_id IS NOT NULL/);
    expect(find(OUTPUT)!.text).toMatch(/AND j\.output_uom_id IS NOT NULL/);
    expect(find(OUTPUT)!.text).not.toMatch(/infeed_uom_id IS NOT NULL/);
  });

  // THE RESIDUALS ARE THEIR OWN STATEMENT, over the rows the unit predicate has
  // NOT been applied to. A FILTER on the grouped queries would count something
  // else entirely: those already group BY the unit, so a null-unit row is in its
  // own bucket rather than absent.
  it("counts the two residuals in a third statement, over unfiltered rows", async () => {
    const { find, promise } = run();
    await promise;

    const text = find(UNRESOLVED)!.text;
    expect(text).toMatch(/FILTER \(WHERE j\.infeed_uom_id IS NULL\)/);
    expect(text).toMatch(/FILTER \(WHERE j\.output_uom_id IS NULL\)/);
    // DISTINCT LINES, not rows: "6 lines have no output unit" is the sentence the
    // card needs, where "180 rows" is not.
    expect(text).toMatch(/count\(DISTINCT j\.work_center_id\)/);
    expect(text).not.toMatch(/IS NOT NULL/);
  });

  // ALL THREE SHARE ONE SCOPE FRAGMENT, so they cannot disagree about which line
  // reports belong to this area's day — the same identity argument the page/count
  // pair makes above.
  it("scopes all three statements by the same area predicate", async () => {
    const { findAll, promise } = run();
    await promise;

    const areaPreds = findAll(J_AREA_PRED);
    expect(areaPreds).toHaveLength(1);
    expect(areaPreds[0]!.params).toEqual([2]);
  });
});

describe("AreaReportReaderRepository.aggregateRejectReasons", () => {
  // THE LINES' OWN COUNT POINTS (0019), SCOPED BY area_id — not a machine sum off
  // oee.reject_count_wu_shift, which is the bug contract §20 exists to record one
  // grain down.
  it("reads oee.reject_count_wc_shift scoped by area_id", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(window());

    const scoped = find(/FROM oee\.reject_count_wc_shift j/)!;
    expect(scoped.text).not.toMatch(/reject_count_wu_shift/);
    expect(find(J_AREA_PRED)!.params).toEqual([2]);
  });

  // NO MACHINE TO NAME. The shared aggregate projects work_unit_name as each
  // bucket's machineName; an area's bucket spans several lines, so NULL is the
  // honest answer and it is supplied HERE rather than by loosening the aggregate.
  it("supplies a null machine name rather than widening the shared aggregate", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(window());

    expect(find(/FROM oee\.reject_count_wc_shift j/)!.text).toMatch(
      /NULL::varchar AS work_unit_name/,
    );
  });
});

describe("AreaReportReaderRepository.aggregateDowntimeEventReasons", () => {
  // `shift_date`, NOT `business_date` — oee.downtime_log_events keeps the older
  // name (contract §22.4), and naming the wrong column here is a 500 the fakeSql
  // suite is the only cheap place to catch.
  it("reads oee.downtime_log_events on shift_date, scoped by area_id", async () => {
    const { goldDb, find, findAll } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(window());

    expect(find(/FROM oee\.downtime_log_events j/)).toBeDefined();
    // The date column is a Fragment, so it is its own recorded call rather than
    // text inside the statement above.
    expect(find(/^j\.shift_date$/)).toBeDefined();
    expect(find(/^j\.business_date$/)).toBeUndefined();
    expect(findAll(J_AREA_PRED)[0]!.params).toEqual([2]);
  });

  // NO SHIFT NARROWING. An area day spans all three shifts and this table is
  // shift-keyed, so the range widens over them; a shift predicate here would
  // silently report a third of the day.
  it("narrows by no shift", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(window());

    expect(find(/FROM oee\.downtime_log_events j/)!.text).not.toMatch(/j\.shift =/);
  });
});

describe("AreaReportReaderRepository.listDowntimeEdits", () => {
  const HISTORY = /FROM oee\.downtime_report_history h/;
  const COUNTS = /count\(j\.source_event_id\)::int AS tracked/;

  it("joins the history to the area's stops and carries both the machine and the line", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window());

    const text = find(HISTORY)!.text;
    expect(text).toMatch(/FROM oee\.downtime_reports j/);
    expect(text).toMatch(/m\.work_unit_id, m\.work_unit_name/);
    // BOTH AXES. An area day feed spans N lines, so the machine alone leaves "the
    // filler on Line 1" and "the filler on Line 2" reading as one entry.
    expect(text).toMatch(/m\.work_center_id, m\.work_center_name/);
  });

  // TWO STATEMENTS OVER THE SAME MEMBER SET, and the second is not the first with
  // a length(). `count(*)` is every stop; `count(source_event_id)` is the
  // trackable half — a stop with no stable id can never carry a trail, which is a
  // different answer from "nobody has edited it".
  it("counts total with count(*) and tracked with count(source_event_id)", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window());

    const text = find(COUNTS)!.text;
    expect(text).toMatch(/count\(\*\)::int AS total/);
    // The counting statement must NOT carry the source_event_id predicate the
    // entry query does — that is the whole difference between the two.
    expect(text).not.toMatch(/source_event_id IS NOT NULL/);
    expect(find(HISTORY)!.text).toMatch(/j\.source_event_id IS NOT NULL/);
  });

  // ON `business_date`, NOT AN INSTANT RANGE, unlike the line's version of this
  // read. Consistency inside the area payload is the reason: every other read here
  // narrows on a business-date range, and two definitions of "this area's day" in
  // one screen is how a feed lists an edit no other card knew about.
  it("scopes on business_date rather than on an instant range", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window());

    // Again the column is a Fragment and therefore its own call. The LINE's
    // version of this read scopes by `start_at`/`end_at` instants instead; that
    // predicate must not appear anywhere here.
    expect(find(/^j\.business_date$/)).toBeDefined();
    expect(find(/start_at/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE MONTH GRAIN
// ---------------------------------------------------------------------------
//
// ONE IMPLEMENTATION BEHIND TWO PREFIXES, so what is worth asserting is not that
// the month reads work — the projection is byte-identical — but that they read the
// OTHER TABLE. Nine report tables, nine independent identity sequences: a month
// request answered from `oee.area_day_reports` returns a real report about a real
// day, with four real rates, under a month heading.
describe("AreaReportReaderRepository — the month grain", () => {
  it("pages oee.area_month_reports and never the day table", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: MONTH, limit: 20, offset: 0, filter: filter() });

    expect(find(MONTH_TABLE)).toBeDefined();
    expect(find(DAY_TABLE)).toBeUndefined();
  });

  it("reads one month row from oee.area_month_reports and stamps the grain", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [{ id: 1 }] }]);
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.getReport(MONTH, 1);

    const call = find(DETAIL)!;
    expect(find(MONTH_TABLE)).toBeDefined();
    expect(find(DAY_TABLE)).toBeUndefined();
    // Stamped from the table that answered, not hardcoded — the browser's report
    // union discriminates on it and its cards read it to decide whether
    // `businessDate` is a day or a month start.
    expect(call.params).toContain("month");
  });

  // THE PROJECTION IS IDENTICAL, and that is worth pinning rather than assuming:
  // the two tables differ by exactly one CONSTRAINT (`ck_amr_month_start`) and by
  // no column, which is the whole justification for one implementation. A column
  // appearing on one and not the other would break that silently — a `SELECT` of
  // something the month table lacks is a 500 on a shipped screen, and the fakeSql
  // suite is the only cheap place to notice.
  it("projects the same columns at both grains", async () => {
    const project = async (grain: "day" | "month") => {
      const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [{ id: 1 }] }]);
      const repo = new AreaReportReaderRepository({ goldDb });
      await repo.getReport(grain, 1);
      // NO NORMALISATION NEEDED, and that is itself the point: the table name is a
      // Fragment, so it is not in this text at all — the two statements are
      // byte-identical, which is the strongest form this assertion can take.
      return find(DETAIL)!.text;
    };

    expect(await project("day")).toBe(await project("month"));
  });

  // A MONTH LIST TAKES NO MONTH FILTER — the dto does not declare the field, so
  // this arm is unreachable through HTTP. Asserted anyway, because the shared
  // `AreaReportFilter` still HAS the field and a future edit could start passing
  // it: if it ever arrives, it must narrow rather than be ignored.
  it("still honours a month filter if one is somehow passed", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new AreaReportReaderRepository({ goldDb });

    await repo.paginateReport({
      grain: MONTH,
      limit: 20,
      offset: 0,
      filter: filter({ year: 2026, month: 9 }),
    });

    expect(find(/make_date/)).toBeDefined();
  });
});
