import { describe, expect, it } from "vite-plus/test";

import { WorkCenterReportReaderRepository } from "./work-center-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";

// A stand-in for the postgres.js client, defined per repository test file by
// convention. It is callable two ways:
//   1. as a tagged template, for a query or a filter fragment, and
//   2. as a plain function, for the column/IN-list helper.
// Only a TemplateStringsArray carries `.raw`, which is what separates the two.
//
// Queries are answered by the first route whose pattern matches the normalised
// SQL text, so tests state what a query returns rather than depending on the
// order the repository happens to issue them in.
//
// WHAT THIS FAKE CANNOT SEE, and why the integration suite exists: it matches SQL
// TEXT and never executes it. A projection naming a column that does not exist,
// an arithmetic error, a three-valued-logic surprise — all pass here.
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

const PAGE = /LIMIT/;
const COUNT = /count\(r\.id\)/;

// CAMELCASE, because createPostgresDb sets `transform: postgres.camel` and the
// driver has already renamed every column by the time the repository sees a row.
// The SQL aliases in snake_case; nothing in this module maps between the two.
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    grain: "day",
    businessDate: "2026-08-26",
    timeZone: "Asia/Jakarta",
    shift: null,
    workCenterId: 11,
    workCenterName: "Molca Line 1",
    workCenterCode: "L1",
    workUnitCount: 3,
    expectedWorkUnitCount: 4,
    oee: 96.791,
    availability: 100,
    performance: 96.791,
    quality: 100,
    ...overrides,
  };
}

describe("WorkCenterReportReaderRepository — the page and the count", () => {
  it("returns the driver's rows unchanged and forwards limit and offset", async () => {
    const { goldDb, find } = fakeSql([
      { match: COUNT, rows: [{ value: 25 }] },
      { match: PAGE, rows: [row()] },
    ]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    const out = await repo.paginateReport({ grain: "day", limit: 10, offset: 20, filter: {} });

    expect(out.items[0]).toEqual({
      id: 1,
      grain: "day",
      businessDate: "2026-08-26",
      timeZone: "Asia/Jakarta",
      shift: null,
      workCenterId: 11,
      workCenterName: "Molca Line 1",
      workCenterCode: "L1",
      workUnitCount: 3,
      expectedWorkUnitCount: 4,
      oee: 96.791,
      availability: 100,
      performance: 96.791,
      quality: 100,
    });
    expect(out.totalElements).toBe(25);
    expect(find(PAGE)?.params.slice(-2)).toEqual([10, 20]);
  });

  it("returns totalElements 0 rather than NaN when the count row is missing", async () => {
    const { goldDb } = fakeSql([{ match: PAGE, rows: [row()] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    const out = await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: {} });

    expect(out.totalElements).toBe(0);
  });

  // The page query and the count query must bind THE SAME fragment instances, or
  // the pager reports a total for a different predicate than the page it labels.
  it("binds the same filter fragments into the page and the count", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({
      grain: "shift",
      limit: 10,
      offset: 0,
      filter: { month: 8, year: 2026, shift: 2, workCenterId: 11, areaId: 3, isHideZero: true },
    });

    // Both queries interpolate the FROM fragment then the five filter fragments.
    // The page carries a grain literal and the shift projection ahead of them and
    // the ORDER BY fragment, limit and offset after — hence the offsets.
    //
    //   page  [grain, shiftProjection, from, period, shift, workCenter, area,
    //          hideZero, shiftOrder, limit, offset]
    //   count [from, period, shift, workCenter, area, hideZero]
    //
    // FIVE FILTER FRAGMENTS SINCE THE HEADER AREA PICKER BECAME A REQUEST FILTER.
    // The area one has to be in BOTH or the pager counts a plant and pages an
    // area, which reads as a list that runs out of rows early rather than as a
    // bug.
    const page = find(PAGE)?.params ?? [];
    const count = find(COUNT)?.params ?? [];
    expect(count).toHaveLength(6);
    // Identity, not equality: the two must bind THE SAME fragment objects, or the
    // pager reports a total for a different predicate than the page it labels.
    expect(page.slice(2, 8)).toEqual(count);
  });

  // THE AREA FILTER — the header picker, on all three line grains.
  //
  // `0014` denormalised `area_id` onto these tables and `0027` carried it onto
  // the year one, so this needed no column — only a predicate. Asserting the
  // COLUMN matters for the same reason it does one subject over: an
  // implementation that resolved the area to its lines upstream would bind the
  // same value into a `work_center_id IN` and pass a value-only assertion.
  it.each(["shift", "day", "month", "year"] as const)(
    "paginateReport filters by area at %s grain",
    async (grain) => {
      const { goldDb, find } = fakeSql();
      const repo = new WorkCenterReportReaderRepository({ goldDb });

      await repo.paginateReport({ grain, limit: 10, offset: 0, filter: { areaId: 4 } });

      expect(find(/area_id = \?/)?.params).toEqual([4]);
    },
  );

  // An ABSENT areaId widens rather than empties: these endpoints are public and
  // only the browser sends the filter unconditionally.
  it("paginateReport omits the area predicate when no areaId is given", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: {} });

    expect(find(/area_id/)).toBeUndefined();
  });

  // Two statements, never three. An accidental extra round trip per page is
  // invisible until a 100-row page.
  it("issues exactly two statements", async () => {
    const { goldDb, findAll } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "month", limit: 10, offset: 0, filter: {} });

    expect(findAll(/SELECT/).length).toBe(2);
  });
});

describe("WorkCenterReportReaderRepository — the grain dispatch", () => {
  // The sql(identifier) trap: postgres.js would escape "oee.work_center_day_reports"
  // as ONE quoted identifier, dot included, and look for a table of that literal
  // name in the search path. These must be literal fragments in the SQL TEXT.
  it.each([
    ["shift", "oee.work_center_shift_reports"],
    ["day", "oee.work_center_day_reports"],
    ["month", "oee.work_center_month_reports"],
  ] as const)("reads %s grain from %s, unquoted", async (grain, table) => {
    const { goldDb, find, calls } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain, limit: 10, offset: 0, filter: {} });

    // The FROM clause is its own tagged-template fragment, so it is recorded as
    // its own call rather than appearing inline in the page query's text. Exact
    // match: a quoted "oee.work_center_day_reports" — what this.db(NAME) would
    // produce — is a DIFFERENT string and must not pass.
    expect(calls.map((c) => c.text)).toContain(table);
    expect(find(PAGE)?.text).toContain("FROM");
  });

  // `shift` is a column on ONE of the three tables. Selecting it at a coarse grain
  // is "column does not exist"; omitting it would give the mapper two shapes.
  it("selects r.shift at shift grain and a literal NULL at the coarse ones", async () => {
    const shift = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: shift.goldDb }).paginateReport({
      grain: "shift",
      limit: 10,
      offset: 0,
      filter: {},
    });
    expect(shift.calls.map((c) => c.text)).toContain("r.shift");

    const day = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: day.goldDb }).paginateReport({
      grain: "day",
      limit: 10,
      offset: 0,
      filter: {},
    });
    expect(day.calls.map((c) => c.text)).toContain("NULL::smallint AS shift");
    expect(day.calls.map((c) => c.text)).not.toContain("r.shift");
  });

  // A stray shift in the filter must NOT reach a table that has no such column.
  // The dto already drops the key at the coarse grains; this is the second guard,
  // because a 500 is what the first one failing looks like.
  it("applies a shift predicate at shift grain only", async () => {
    const shift = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: shift.goldDb }).paginateReport({
      grain: "shift",
      limit: 10,
      offset: 0,
      filter: { shift: 2 },
    });
    expect(shift.calls.some((c) => /AND r\.shift = \?/.test(c.text))).toBe(true);

    const day = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: day.goldDb }).paginateReport({
      grain: "day",
      limit: 10,
      offset: 0,
      filter: { shift: 2 },
    });
    expect(day.calls.some((c) => /AND r\.shift = \?/.test(c.text))).toBe(false);
  });

  it("orders by business_date, then shift at shift grain, and always by id last", async () => {
    const shift = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: shift.goldDb }).paginateReport({
      grain: "shift",
      limit: 10,
      offset: 0,
      filter: {},
    });
    expect(shift.find(PAGE)?.text).toContain("ORDER BY r.business_date DESC");
    expect(shift.calls.some((c) => /, r\.shift DESC/.test(c.text))).toBe(true);
    expect(shift.find(PAGE)?.text).toContain("r.id ASC");

    const month = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: month.goldDb }).paginateReport({
      grain: "month",
      limit: 10,
      offset: 0,
      filter: {},
    });
    expect(month.calls.some((c) => /, r\.shift DESC/.test(c.text))).toBe(false);
  });
});

describe("WorkCenterReportReaderRepository — the filters", () => {
  // A half-open range on a real `date` column: sargable, and no session zone can
  // move a boundary. This is the defect TODOS §17 records for the work_unit shift
  // list, which these tables never had because they never had a timestamptz.
  it("filters month+year as a half-open make_date range", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({
      grain: "day",
      limit: 10,
      offset: 0,
      filter: { month: 8, year: 2026 },
    });

    const fragment = calls.find((c) => /make_date/.test(c.text));
    expect(fragment?.text).toMatch(/r\.business_date >= make_date/);
    expect(fragment?.text).toMatch(/r\.business_date < make_date/);
    expect(fragment?.text).toContain("interval '1 month'");
    // Year and month are bound; the day-of-month 1 is a SQL literal, so it does
    // not appear here.
    expect(fragment?.params).toEqual([2026, 8, 2026, 8]);
  });

  it("filters a bare year across the whole year", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: { year: 2026 } });

    expect(calls.find((c) => /interval '1 year'/.test(c.text))).toBeDefined();
  });

  it("filters a bare month with extract", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: { month: 8 } });

    const fragment = calls.find((c) => /extract\(month/.test(c.text));
    expect(fragment?.params).toEqual([8]);
  });

  // A PLAIN PREDICATE, not an IN over ids resolved upstream. If this ever became a
  // no-op the Line filter would silently show every line's rows under one line's
  // label — a page that looks entirely normal.
  it("filters workCenterId as a bound column predicate", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: { workCenterId: 11 } });

    const fragment = calls.find((c) => /AND r\.work_center_id = \?/.test(c.text));
    expect(fragment?.params).toEqual([11]);
  });

  it("adds the hide-zero predicate only when isHideZero is true", async () => {
    const on = fakeSql();
    await new WorkCenterReportReaderRepository({ goldDb: on.goldDb }).paginateReport({
      grain: "day",
      limit: 10,
      offset: 0,
      filter: { isHideZero: true },
    });
    expect(on.calls.some((c) => /AND r\.oee <> 0/.test(c.text))).toBe(true);

    for (const isHideZero of [false, undefined]) {
      const off = fakeSql();
      await new WorkCenterReportReaderRepository({ goldDb: off.goldDb }).paginateReport({
        grain: "day",
        limit: 10,
        offset: 0,
        filter: { isHideZero },
      });
      expect(off.calls.some((c) => /AND r\.oee <> 0/.test(c.text))).toBe(false);
    }
  });

  it("rounds all four rates to 3 decimals and casts them to float8", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: {} });

    for (const rate of ["oee", "availability", "performance", "quality"]) {
      expect(find(PAGE)?.text).toContain(`round(r.${rate}::numeric, 3)::float8 AS ${rate}`);
    }
  });

  // Both machine counts are COLUMNS. If either were dropped from the projection the
  // Machines cell would read "undefined of 4" or fall back to a bare count with no
  // indication anything was lost.
  it("selects both machine counts", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: {} });

    expect(find(PAGE)?.text).toContain("r.work_unit_count");
    expect(find(PAGE)?.text).toContain("r.expected_work_unit_count");
  });

  // NULL is a real value here — nullable rates, and an unresolved roster — and a
  // coalesce creeping into the projection would claim a perfect line.
  it("passes NULL rates and a NULL expected count through untouched", async () => {
    const { goldDb } = fakeSql([
      {
        match: PAGE,
        rows: [row({ oee: null, availability: null, expectedWorkUnitCount: null })],
      },
    ]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    const out = await repo.paginateReport({ grain: "day", limit: 10, offset: 0, filter: {} });

    expect(out.items[0]?.oee).toBeNull();
    expect(out.items[0]?.availability).toBeNull();
    expect(out.items[0]?.expectedWorkUnitCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The detail read
// ---------------------------------------------------------------------------
//
// WHAT THIS FAKE CAN AND CANNOT PROVE HERE. It matches SQL text, so it can show
// that the right TABLE is named and that every nullable column is projected — and
// it cannot show that a cast works, that the columns exist, or that a CHECK fires.
// The `numeric`-arrives-as-a-string trap in particular is invisible to a fake that
// hands back whatever the test wrote. That is the integration suite's half.

const DETAIL = /WHERE r\.id = \?/;

describe("WorkCenterReportReaderRepository — the detail read", () => {
  // THE TABLE, PER GRAIN. Six report tables now carry six independent identity
  // sequences, so reading the wrong one for a valid id returns a complete,
  // plausible report about a different line on a different date. Nothing in the
  // response says so.
  it.each([
    ["shift", "oee.work_center_shift_reports"],
    ["day", "oee.work_center_day_reports"],
    ["month", "oee.work_center_month_reports"],
  ] as const)("reads the %s table", async (grain, table) => {
    const { goldDb, find, calls } = fakeSql([{ match: DETAIL, rows: [] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.getReport(grain, 7);

    // The FROM clause is its own tagged-template fragment, so it is recorded as
    // its own call rather than appearing inline — and the exact match matters: a
    // quoted "oee.work_center_day_reports", which this.db(NAME) would produce, is
    // a different string and must not pass.
    expect(calls.map((c) => c.text)).toContain(table);
    expect(find(DETAIL)?.params).toContain(7);
  });

  // `shift` exists only on the shift table, so the coarse grains select a literal
  // NULL rather than the column — the same trick the list projection uses, and
  // what keeps one row shape across three tables.
  it("selects the shift column only at shift grain", async () => {
    const shiftSql = fakeSql([{ match: DETAIL, rows: [] }]);
    await new WorkCenterReportReaderRepository(shiftSql).getReport("shift", 1);

    const daySql = fakeSql([{ match: DETAIL, rows: [] }]);
    await new WorkCenterReportReaderRepository(daySql).getReport("day", 1);

    expect(shiftSql.calls.map((c) => c.text)).toContain("r.shift");
    expect(daySql.calls.map((c) => c.text)).toContain("NULL::smallint AS shift");
  });

  it("returns undefined when the id names nothing", async () => {
    const { goldDb } = fakeSql([{ match: DETAIL, rows: [] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    expect(await repo.getReport("shift", 404)).toBeUndefined();
  });

  // BOTH UOM TRIPLES, SEPARATELY. A line consumes in one unit and ships in
  // another (0014), so a projection that selected one triple — or aliased both to
  // the same name — would render cartons under a bag label. Six columns, asserted
  // by name, because that mistake produces no error anywhere.
  it("projects both uom triples", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.getReport("shift", 1);
    const text = find(DETAIL)?.text ?? "";

    for (const column of [
      "r.infeed_uom_id",
      "r.infeed_uom_name",
      "r.infeed_uom_code",
      "r.output_uom_id",
      "r.output_uom_name",
      "r.output_uom_code",
    ]) {
      expect(text).toContain(column);
    }
  });

  // The fourth count (migration 0015), on the INFEED side with total_out.
  it("projects line_out beside the other infeed counts", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.getReport("shift", 1);

    expect(find(DETAIL)?.text).toContain("round(r.line_out::numeric, 3)::float8 AS line_out");
  });

  // NO COALESCE, ANYWHERE. Every nullable column on this grain means "not
  // established" — the members disagreed, or the pipeline has not written it — and
  // a zero would be a measurement. This is a text assertion because the failure it
  // guards against is somebody "tidying up" a null in the projection.
  it("coalesces nothing", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.getReport("month", 1);

    expect(find(DETAIL)?.text).not.toMatch(/coalesce/i);
  });

  // Every numeric and bigint column is cast, or postgres.js hands it back as a
  // STRING: percentages render "100.000%" and durations concatenate rather than
  // add. Counting is cruder than naming each column and is meant to be — it fails
  // when somebody adds a measure and forgets the cast, which is the actual risk.
  it("casts every measure out of numeric and bigint", async () => {
    const { goldDb, find } = fakeSql([{ match: DETAIL, rows: [] }]);
    const repo = new WorkCenterReportReaderRepository({ goldDb });

    await repo.getReport("shift", 1);
    const text = find(DETAIL)?.text ?? "";

    // 5 rates + 6 counts = 11 rounded numerics; 20 durations + mttr + mtbf = 22
    // bare float8 casts.
    expect(text.match(/round\(r\.\w+::numeric, 3\)::float8/g)).toHaveLength(11);
    expect(text.match(/r\.\w+::float8 AS/g)).toHaveLength(22);
  });
});
