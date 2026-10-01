import { describe, expect, it } from "vite-plus/test";

import { listOeeTrend } from "./oee-trend.js";

import type { GoldDB } from "./database/postgres.js";
import type { Fragment } from "postgres";

// The fakeSql harness, per the convention each repository test file follows. It
// matches SQL TEXT and never executes it, so a wrong column name or a genuine
// arithmetic surprise passes here — those belong to
// work-unit-period-repository.integration.test.ts, which runs the real statement
// against real rows.
//
// WHAT THIS SUITE PINS IS SHAPE, and for this file shape is most of the risk. One
// statement serves three subjects, so the failure it has to make impossible is a
// caller reaching the wrong pair of tables or scoping on the wrong column — which
// would return a plausible curve for somebody else's machine.
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

  return { goldDb: sql as unknown as GoldDB, calls, find };
}

const TREND = /FROM \? r JOIN \? d/;

// The three subjects, exactly as the three repositories call this. Nested
// fragments show as `?` in the outer text and are recorded as their own calls, so
// the table names are asserted through the fragment calls rather than the join.
const SUBJECTS = [
  {
    name: "machine",
    monthTable: "oee.work_unit_month_reports",
    dayTable: "oee.work_unit_day_reports",
    scopeColumn: "work_unit_id",
  },
  {
    name: "line",
    monthTable: "oee.work_center_month_reports",
    dayTable: "oee.work_center_day_reports",
    scopeColumn: "work_center_id",
  },
  {
    name: "area",
    monthTable: "oee.area_month_reports",
    dayTable: "oee.area_day_reports",
    scopeColumn: "area_id",
  },
] as const;

function run(
  db: ReturnType<typeof fakeSql>,
  subject: (typeof SUBJECTS)[number],
  reportId = 7373,
  span: unknown = { interval: "1 month" },
) {
  return listOeeTrend(db.goldDb, {
    innerTable: subject.dayTable,
    // The real callers pass `this.grainFrom(...)`, which is a literal fragment.
    // A plain object stands in: the fake only needs it to be a non-template value
    // so it is recorded as an interpolation rather than a statement.
    outerFrom: { table: subject.monthTable } as unknown as Fragment,
    innerFrom: { table: subject.dayTable } as unknown as Fragment,
    span: span as Fragment,
    scopeColumn: subject.scopeColumn,
    reportId,
  });
}

describe("listOeeTrend", () => {
  it.each(SUBJECTS)("joins $name's month table to its own day table", async (subject) => {
    const db = fakeSql();

    await run(db, subject);

    const stmt = db.find(TREND);
    expect(stmt).toBeDefined();
    // Both tables arrive as interpolated fragments, so the statement itself must
    // name NEITHER table literally. A hardcoded table here would serve one subject
    // and silently mis-serve the other two.
    expect(stmt!.text).not.toMatch(/work_unit|work_center|area_day|area_month/);
    expect(stmt!.params).toContainEqual({ table: subject.monthTable });
    expect(stmt!.params).toContainEqual({ table: subject.dayTable });
  });

  it.each(SUBJECTS)("scopes $name on its own id column", async (subject) => {
    const db = fakeSql();

    await run(db, subject);

    // `db(scopeColumn)` is an identifier escape, which the fake records as a
    // non-template interpolation. It must be the subject's OWN column: joining
    // area rows on work_unit_id would either error or, worse, match nothing and
    // draw an empty chart that reads as "this area never ran".
    expect(db.find(TREND)!.params).toContainEqual({ fragment: subject.scopeColumn });
  });

  it("bounds the period HALF-OPEN and never with BETWEEN", async () => {
    const db = fakeSql();

    await run(db, SUBJECTS[0]);

    const text = db.find(TREND)!.text;
    expect(text).toMatch(/d\.business_date >= r\.business_date/);
    // The SPAN IS INTERPOLATED since `0027` — it is a caller-supplied Fragment now,
    // one month or one year — so the bound is asserted as `+ <interpolation>`
    // rather than as literal SQL. The half-open SHAPE is what this test is about,
    // and it is unchanged.
    expect(text).toMatch(/d\.business_date < r\.business_date \+ \?/);
    // BETWEEN is inclusive at BOTH ends. It would pull the first sub-period of the
    // NEXT period into the curve — a 32nd day under a month, or a THIRTEENTH MONTH
    // under a year, at the right-hand edge of a chart where nothing looks wrong.
    // shared/report-window.ts states the same rule for every other windowed read.
    expect(text).not.toMatch(/BETWEEN/i);
  });

  // THE SPAN IS THE ONE PARAMETER THAT RENDERS A PLAUSIBLE CHART WHEN IT IS WRONG,
  // so it is asserted as a value rather than trusted. A year joined with a
  // one-month span draws January alone and labels it as the year; a month joined
  // with a one-year span draws twelve months of days under a month heading. Neither
  // throws, and neither is visible on screen.
  it("passes the caller's span through untouched", async () => {
    const monthDb = fakeSql();
    await run(monthDb, SUBJECTS[0]);
    expect(monthDb.find(TREND)!.params).toContainEqual({ interval: "1 month" });

    const yearDb = fakeSql();
    await run(yearDb, SUBJECTS[0], 7373, { interval: "1 year" });
    expect(yearDb.find(TREND)!.params).toContainEqual({ interval: "1 year" });
  });

  it("reads the window off the month row rather than from a parameter", async () => {
    const db = fakeSql();

    await run(db, SUBJECTS[0], 4242);

    // The ONLY bound value is the report id. If a date ever appears here, a caller
    // has been given the chance to hand this a window that disagrees with the
    // report it is drawing.
    const stmt = db.find(TREND)!;
    expect(stmt.params.filter((p) => typeof p === "number")).toEqual([4242]);
  });

  it("returns the business date as a bare day and keeps a null rate null", async () => {
    const rows = [
      {
        businessDate: "2026-08-01",
        oee: 88.003,
        availability: 90.571,
        performance: 97.532,
        quality: 99.624,
      },
      // Nullable on the line and area day tables, where it means "could not be
      // composed". Not zero, and not coalesced to zero anywhere on the way out.
      {
        businessDate: "2026-08-02",
        oee: null,
        availability: null,
        performance: null,
        quality: null,
      },
      // Zero IS a measurement — the subject ran and produced nothing. The browser
      // draws it as a gap; the payload must still say zero.
      { businessDate: "2026-08-03", oee: 0, availability: 0, performance: 0, quality: 0 },
    ];
    const db = fakeSql([{ match: TREND, rows }]);

    await expect(run(db, SUBJECTS[1])).resolves.toEqual(rows);
  });

  it("orders ascending, so the chart's x-axis needs no client-side sort", async () => {
    const db = fakeSql();

    await run(db, SUBJECTS[2]);

    expect(db.find(TREND)!.text).toMatch(/ORDER BY d\.business_date ASC/);
  });

  // FOUR RATES ON ONE CHART. The three beside `oee` are what make "OEE fell on the
  // 19th — which factor moved?" answerable, and a projection that quietly lost one
  // would draw a chart with a missing line rather than fail.
  it("projects all four rates, each rounded to 3dp as a float8", async () => {
    const db = fakeSql();

    await run(db, SUBJECTS[0]);

    const text = db.find(TREND)!.text;
    for (const rate of ["oee", "availability", "performance", "quality"]) {
      expect(text).toMatch(new RegExp(`round\\(d\\.${rate}::numeric, 3\\)::float8 +AS ${rate}`));
    }
  });

  it("projects the business date through to_char, never as a bare date column", async () => {
    const db = fakeSql();

    await run(db, SUBJECTS[0]);

    // postgres.js parses a `date` into a JS Date, which would put a zone back into
    // the one value that exists to be free of one — a business day west of
    // Greenwich then renders as the previous day.
    expect(db.find(TREND)!.text).toMatch(/to_char\(d\.business_date, 'YYYY-MM-DD'\)/);
  });
});
