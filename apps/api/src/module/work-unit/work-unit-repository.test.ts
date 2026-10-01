import { describe, it, expect } from "vite-plus/test";

import {
  WorkUnitReportReaderRepository,
  WorkUnitReportWriterRepository,
} from "./work-unit-repository.js";

import type { ListPerfHoursInput } from "./work-unit-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";

// A stand-in for the postgres.js client, which is callable two ways:
//   1. as a tagged template — `sql`SELECT ...`` — for a query, and
//   2. as a plain function — `sql(obj)` / `sql(array)` — for the column helper
//      that builds INSERT/UPDATE column lists and IN lists.
// Only a TemplateStringsArray carries `.raw`, which is what separates the two.
//
// Queries are answered by the first route whose pattern matches the normalised
// SQL text, so tests state what a query returns rather than relying on the order
// the repository happens to issue them in. Filter fragments are tagged-template
// calls too, so they are recorded alongside the queries and can be asserted on.
type Route = { match: RegExp; rows: unknown[] };
type Call = { text: string; params: unknown[] };

function isTemplateStrings(x: unknown): x is TemplateStringsArray {
  return Array.isArray(x) && "raw" in x;
}

function fakeSql(routes: Route[] = []) {
  const calls: Call[] = [];
  const columns: unknown[] = [];

  const sql = (first: unknown, ...values: unknown[]) => {
    if (!isTemplateStrings(first)) {
      columns.push(first);
      return { fragment: first };
    }

    const text = first.join(" ? ").replaceAll(/\s+/g, " ").trim();
    calls.push({ text, params: values });

    return Promise.resolve(routes.find((r) => r.match.test(text))?.rows ?? []);
  };

  // postgres.js's `sql.begin(cb)` runs its callback against a transaction handle.
  // Here that handle is the SAME fake, so statements issued inside a transaction
  // are recorded alongside every other one and can be asserted on identically.
  //
  // THIS DOES NOT PROVE ATOMICITY, and no fake can. It issues no BEGIN, no
  // COMMIT and no ROLLBACK, so a repository that wrote its two rows in two
  // SEPARATE transactions would pass every assertion here unchanged. What the
  // fake CAN prove is which statements are issued, in what order, with what
  // parameters. That the approvals row and its event row commit together is
  // proved in work-unit-repository.integration.test.ts against a real Postgres,
  // and only there.
  const begin = async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => await cb(sql);
  (sql as unknown as { begin: typeof begin }).begin = begin;

  const find = (pattern: RegExp) => calls.find((c) => pattern.test(c.text));
  const findAll = (pattern: RegExp) => calls.filter((c) => pattern.test(c.text));

  return { goldDb: sql as unknown as GoldDB, calls, columns, find, findAll };
}

const PAGE = /LIMIT/;
const COUNT = /count\(r\.id\)/;

describe("WorkUnitReportReaderRepository", () => {
  it("paginateShiftReport maps rows and total, forwarding limit and offset", async () => {
    const dataRows = [
      {
        id: 1,
        shift: "A",
        workUnitId: 7,
        oee: 82.5,
        availability: 90,
        performance: 95,
        quality: 96.5,
      },
    ];
    const { goldDb, find } = fakeSql([
      { match: COUNT, rows: [{ value: 25 }] },
      { match: PAGE, rows: dataRows },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    const out = await repo.paginateShiftReport({ limit: 10, offset: 20, filter: {} });

    expect(out.items).toEqual(dataRows);
    expect(out.totalElements).toBe(25);
    // The SIX (empty) filter fragments, then limit and offset — period, shift,
    // work unit, AREA, hide-zero, status. Five until the header area picker
    // became a request filter; `0028` put `area_id` on this table and
    // shared/area-scope.ts builds the sixth. The count is asserted rather than
    // loosened because the page query and the count query must bind the same
    // fragment instances, and the test below compares them slot by slot.
    expect(find(PAGE)?.params).toEqual([
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      10,
      20,
    ]);
  });

  it("paginateShiftReport returns the percentages as numbers rounded to 3 decimals", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: {} });

    // Without the float8 cast postgres.js hands numerics back as strings, so a
    // perfect score would leave this endpoint as "100.000" instead of 100.
    for (const column of ["oee", "availability", "performance", "quality"]) {
      expect(find(PAGE)?.text).toContain(`round(r.${column}::numeric, 3)::float8 AS ${column}`);
    }
  });

  it("paginateShiftReport defaults total to 0 when the count row is missing", async () => {
    const { goldDb } = fakeSql([{ match: PAGE, rows: [] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    const out = await repo.paginateShiftReport({ limit: 10, offset: 0, filter: {} });

    expect(out.items).toEqual([]);
    expect(out.totalElements).toBe(0);
  });

  it("paginateShiftReport shares every filter fragment with the count query", async () => {
    const { goldDb, find } = fakeSql([{ match: COUNT, rows: [{ value: 0 }] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({
      limit: 10,
      offset: 0,
      filter: { month: 8, year: 2026, shift: 1, workUnitIds: [7], isHideZero: true },
    });

    // The page query and the count query share one fragment instance per filter,
    // so they can never disagree about what is being counted.
    const page = find(PAGE);
    const total = find(COUNT);
    for (const slot of [0, 1, 2, 3, 4, 5]) {
      expect(page?.params[slot]).toBe(total?.params[slot]);
    }
  });

  // THE AREA FILTER — the header picker, as a column predicate.
  //
  // It is a predicate rather than a second `resolveWorkUnitIds` round trip only
  // because `0028` put `area_id` on this table. Asserting the COLUMN and not just
  // the bound value is what catches the shape this would otherwise regress into:
  // resolving the area to its machines upstream binds the same 3 into a
  // `work_unit_id IN` and passes a value-only assertion.
  it("paginateShiftReport filters by area with a plain column predicate", async () => {
    const { goldDb, find, columns } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: { areaId: 3 } });

    expect(find(/area_id = \?/)?.params).toEqual([3]);
    // No id list, so no upstream resolution and no `sql(array)` helper call.
    expect(find(/work_unit_id IN/)).toBeUndefined();
    expect(columns).toEqual([]);
  });

  // An ABSENT areaId is "every area", not "no area". The browser always sends
  // one, but these endpoints are public and an omitted filter must widen rather
  // than empty the list.
  it("paginateShiftReport omits the area predicate when no areaId is given", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: {} });

    expect(find(/area_id/)).toBeUndefined();
  });

  // The area filter STACKS with the line filter rather than replacing it: a page
  // can be narrowed to one line inside the selected area.
  it("paginateShiftReport applies the area and the work unit filters together", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({
      limit: 10,
      offset: 0,
      filter: { areaId: 3, workUnitIds: [7, 9] },
    });

    expect(find(/area_id = \?/)?.params).toEqual([3]);
    expect(find(/work_unit_id IN/)).toBeDefined();
  });

  // Every coarse grain reads the same fragment, so a filter that works on By Day
  // must work on By Monthly and on the year list the dashboard reads.
  it.each(["day", "month", "year"] as const)(
    "paginatePeriodReport filters by area at %s grain",
    async (grain) => {
      const { goldDb, find } = fakeSql();
      const repo = new WorkUnitReportReaderRepository({ goldDb });

      await repo.paginatePeriodReport({ grain, limit: 10, offset: 0, filter: { areaId: 4 } });

      expect(find(/area_id = \?/)?.params).toEqual([4]);
    },
  );

  it("paginateShiftReport narrows month and year to a half-open range on date", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: { month: 8, year: 2026 } });

    const period = find(/make_date/);
    expect(period?.text).toMatch(/date >= make_date\(.+date < make_date\(.+interval '1 month'/);
    expect(period?.params).toEqual([2026, 8, 2026, 8]);
  });

  it("paginateShiftReport narrows a year on its own to a whole-year range", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: { year: 2026 } });

    const period = find(/make_date/);
    expect(period?.text).toMatch(/interval '1 year'/);
    expect(period?.params).toEqual([2026, 2026]);
  });

  it("paginateShiftReport reads a month with no year as that month in every year", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: { month: 8 } });

    expect(find(/make_date/)).toBeUndefined();
    expect(find(/extract\(month/)?.params).toEqual([8]);
  });

  it("paginateShiftReport filters by shift and by work unit ids", async () => {
    const { goldDb, find, columns } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({
      limit: 10,
      offset: 0,
      filter: { shift: 1, workUnitIds: [7, 9] },
    });

    // Bound as a number: the column is smallint, so a string would make Postgres
    // parse it and a bad value would surface as a 500 rather than a 400.
    expect(find(/shift = \?/)?.params).toEqual([1]);
    // The id list goes through the `sql(array)` helper, not as a bound value.
    expect(find(/work_unit_id IN/)).toBeDefined();
    expect(columns[0]).toEqual([7, 9]);
  });

  it("paginateShiftReport ignores an empty work unit id list", async () => {
    const { goldDb, find, columns } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: { workUnitIds: [] } });

    expect(find(/work_unit_id IN/)).toBeUndefined();
    expect(columns).toEqual([]);
  });

  it("paginateShiftReport hides zero-OEE rows only when isHideZero is true", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.paginateShiftReport({ limit: 10, offset: 0, filter: { isHideZero: true } });
    expect(find(/oee <> 0/)).toBeDefined();

    const off = fakeSql();
    const offRepo = new WorkUnitReportReaderRepository({ goldDb: off.goldDb });

    await offRepo.paginateShiftReport({ limit: 10, offset: 0, filter: { isHideZero: false } });
    expect(off.find(/oee <> 0/)).toBeUndefined();
  });

  it("getShiftReport looks the row up by id and nests the approval", async () => {
    // The SELECT projects the approval columns FLAT — postgres.js cannot nest —
    // and the repository reshapes them under `approval`. Asserting the reshape
    // rather than identity is the point: a row that reached the service with
    // `status` at the top level would type-check nowhere but render fine.
    const row = {
      id: 1,
      shift: "A",
      status: "closed",
      closedAt: new Date("2026-08-09T09:00:00.000Z"),
      closedBy: "u1",
      closedByName: "dewi",
      source: "operator",
    };
    const { goldDb, find } = fakeSql([{ match: /FROM oee\.work_unit_shift_reports/, rows: [row] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    const out = await repo.getShiftReport(1);

    expect(out).toEqual({
      id: 1,
      shift: "A",
      approval: {
        status: "closed",
        closedAt: new Date("2026-08-09T09:00:00.000Z"),
        closedBy: "u1",
        closedByName: "dewi",
        source: "operator",
      },
    });
    // The five flat columns must not ALSO survive at the top level.
    expect(out).not.toHaveProperty("status");
    expect(out).not.toHaveProperty("closedBy");

    const q = find(/FROM oee\.work_unit_shift_reports/);
    expect(q?.text).toMatch(/WHERE r\.id = \? LIMIT 1/);
    expect(q?.params).toEqual([1]);
    // The approval is joined on the NATURAL key, never on the report's serial id
    // — that is the entire reason migration 0010 keys the table that way, and an
    // `a.report_id` here would silently undo it.
    expect(q?.text).toMatch(/LEFT JOIN oee\.work_unit_shift_report_approvals a/);
    expect(q?.text).toMatch(/a\.work_unit_id = r\.work_unit_id/);
    expect(q?.text).toMatch(/a\.date = r\.date/);
    expect(q?.text).toMatch(/a\.shift = r\.shift/);
    // Ambiguity guard: the three columns both tables carry must be r-qualified,
    // or Postgres raises "column reference is ambiguous" at runtime — which this
    // fake, matching text without executing it, would otherwise never see.
    expect(q?.text).toMatch(/SELECT r\.id, r\.shift, r\.date, r\.work_unit_id/);
  });

  it("getShiftReport returns undefined when not found", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getShiftReport(404)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listProductCount
//
// The whole contract of this read is in the SQL text, so that is what these
// assert. Three of the four measures are scaled by factor_to_base and one is
// deliberately not — which looks like a bug to any future reader, and is exactly
// why the negative assertion below exists.
// ─────────────────────────────────────────────────────────────────────────────
const PRODUCTS = /product_count_wu_shift/;

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    productId: 4,
    productName: "SKU Line 4",
    productCode: "SKU-4",
    uomCode: "BAG",
    baseUomCode: "BAG",
    totalOut: 854_648,
    goodOut: 786_552,
    reject: 68_096,
    rework: 0,
    ...overrides,
  };
}

const JAKARTA = "Asia/Jakarta";

describe("WorkUnitReportReaderRepository.listProductCount", () => {
  it("looks the rows up by report id, in the given zone", async () => {
    const row = productRow();
    const { goldDb, find } = fakeSql([{ match: PRODUCTS, rows: [row] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    const out = await repo.listProductCount(7, JAKARTA);

    expect(out).toEqual([row]);
    expect(find(PRODUCTS)?.text).toMatch(/WHERE r\.id = \?/);
    // Zone first — it appears in the JOIN, which precedes the WHERE.
    expect(find(PRODUCTS)?.params).toEqual([JAKARTA, 7]);
  });

  it("scales total_out, reject and rework by factor_to_base", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, JAKARTA);

    const text = find(PRODUCTS)?.text ?? "";
    for (const column of ["total_out", "reject", "rework"]) {
      expect(text).toContain(`round(p.${column} * p.factor_to_base, 3)::float8 AS ${column}`);
    }
  });

  // The one that matters. `good_out` stays in the row's own unit of measure while
  // its three neighbours are converted to the base unit — a product decision, and
  // the asymmetry reads as an oversight. Without this assertion, "fixing" it would
  // ship plausible, silently wrong numbers.
  it("does NOT scale good_out by factor_to_base", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, JAKARTA);

    const text = find(PRODUCTS)?.text ?? "";
    expect(text).toContain("round(p.good_out::numeric, 3)::float8 AS good_out");
    expect(text).not.toMatch(/good_out \* p\.factor_to_base/);
  });

  it("returns every measure as a float8, and both unit codes", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, JAKARTA);

    const text = find(PRODUCTS)?.text ?? "";
    // Without the cast postgres.js hands numerics back as strings, so 854648.000
    // would reach the browser as a string and render with its trailing zeros.
    expect(text.match(/::float8/g)).toHaveLength(4);
    expect(text).toContain("p.uom_code");
    expect(text).toContain("p.base_uom_code");
  });

  // The regression this whole signature exists for.
  //
  // `work_unit_shift_reports.date` is a timestamptz holding the shift's START
  // INSTANT; `product_count_wu_shift.shift_date` is a date holding the BUSINESS DAY.
  // Comparing them directly makes Postgres widen the date to timestamptz at
  // midnight, so only a shift starting at exactly 00:00 can ever match — at UTC+7
  // that is shift 1, and shifts 2 and 3 silently return nothing.
  it("reduces the shift-start instant to a business day before comparing", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, JAKARTA);

    const text = find(PRODUCTS)?.text ?? "";
    // `\s*` around the placeholder: fakeSql joins the template parts with " ? ",
    // so a bound value always arrives space-padded.
    expect(text).toMatch(/p\.shift_date\s*=\s*\(r\.date AT TIME ZONE\s*\?\s*\)::date/);
    // Never the naive form — this is the bug.
    expect(text).not.toMatch(/p\.shift_date\s*=\s*r\.date\b/);
  });

  // The plant's zone, not UTC. Invisible at UTC+7, where every shift start shares a
  // calendar date with its UTC instant; load-bearing west of Greenwich, where a
  // 23:00 shift-3 start is already tomorrow in UTC.
  it("takes the business day in the caller's zone rather than hardcoding UTC", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, "America/Chicago");

    expect(find(PRODUCTS)?.params).toContain("America/Chicago");
    expect(find(PRODUCTS)?.text).not.toMatch(/AT TIME ZONE 'UTC'/);
  });

  it("joins the products onto the report, matching on all three key columns", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, JAKARTA);

    const text = find(PRODUCTS)?.text ?? "";
    expect(text).toMatch(/FROM oee\.work_unit_shift_reports r\s+JOIN oee\.product_count_wu_shift/);
    expect(text).toContain("p.work_unit_id = r.work_unit_id");
    // No cast: both columns are smallint. A cast on p.shift would defeat the
    // pk_product_count_wu_shift prefix scan this read depends on.
    expect(text).toContain("p.shift = r.shift");
    expect(text).not.toMatch(/p\.shift = r\.shift::/);
  });

  it("orders by product name with a stable id tiebreak", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listProductCount(7, JAKARTA);

    expect(find(PRODUCTS)?.text).toMatch(/ORDER BY p\.product_name ASC, p\.product_id ASC/);
  });

  it("returns an empty list when the report ran no SKUs", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.listProductCount(7, JAKARTA)).toEqual([]);
  });

  it("keeps every matching row", async () => {
    const rows = [productRow({ productId: 1 }), productRow({ productId: 2 })];
    const { goldDb } = fakeSql([{ match: PRODUCTS, rows }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.listProductCount(7, JAKARTA)).toHaveLength(2);
  });
});

// The existence check, and the source of the work unit the zone is resolved for.
// Kept separate from getShiftReport so resolving a zone does not drag forty columns
// with it.
describe("WorkUnitReportReaderRepository.getReportScope", () => {
  const SCOPE = /SELECT work_unit_id/;

  // Three columns, not forty, and not one: the performance read needs the shift
  // and the start instant to build its business-day filter, and a second lookup
  // for them would be a second chance for the two reads to drift.
  it("reads the work unit, shift and start instant, by id", async () => {
    const row = { workUnitId: 3, shift: 2, date: new Date("2026-08-01T08:00:00Z") };
    const { goldDb, find } = fakeSql([{ match: SCOPE, rows: [row] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getReportScope(7)).toEqual(row);
    expect(find(SCOPE)?.text).toMatch(/SELECT work_unit_id, shift, date/);
    expect(find(SCOPE)?.text).toMatch(/WHERE id = \? LIMIT 1/);
    expect(find(SCOPE)?.params).toEqual([7]);
  });

  it("returns undefined when the report does not exist", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getReportScope(404)).toBeUndefined();
  });
});

const PERF = /product_perf_wu_hour/;
const BUSINESS_DATE = /AT TIME ZONE \? \)::date/;
const WATERMARK = /etl_watermarks/;

function perfInput(overrides: Partial<ListPerfHoursInput> = {}): ListPerfHoursInput {
  return { workUnitId: 7, dateFrom: "2026-08-01", dateTo: "2026-08-01", shift: 3, ...overrides };
}

describe("WorkUnitReportReaderRepository.resolveBusinessDate", () => {
  const INSTANT = new Date("2026-08-01T16:00:00Z");

  it("reduces the instant to a business day in the given zone", async () => {
    const { goldDb, find } = fakeSql([
      { match: BUSINESS_DATE, rows: [{ businessDate: "2026-08-01" }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.resolveBusinessDate(INSTANT, JAKARTA)).toBe("2026-08-01");
    expect(find(BUSINESS_DATE)?.params).toEqual([INSTANT, JAKARTA]);
  });

  // The conversion belongs to Postgres, not to Node's Intl. Every other date
  // computation in this service is handed to the database precisely so no session
  // zone and no ICU build can move a boundary; doing it two ways is how the two
  // answers eventually differ.
  it("hands the arithmetic to Postgres rather than hardcoding UTC", async () => {
    const { goldDb, find } = fakeSql([
      { match: BUSINESS_DATE, rows: [{ businessDate: "2026-08-01" }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.resolveBusinessDate(INSTANT, "America/Chicago");

    expect(find(BUSINESS_DATE)?.params).toContain("America/Chicago");
    expect(find(BUSINESS_DATE)?.text).not.toMatch(/AT TIME ZONE 'UTC'/);
  });

  // A silent undefined would reach the next query as the string "undefined" and
  // match no rows — an empty chart rather than an error.
  it("throws rather than returning undefined when the conversion yields nothing", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await expect(repo.resolveBusinessDate(INSTANT, JAKARTA)).rejects.toThrow(/business date/);
  });
});

describe("WorkUnitReportReaderRepository.listPerfHours", () => {
  it("filters by work unit and a business-date range", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listPerfHours(perfInput());

    const text = find(PERF)?.text ?? "";
    expect(text).toMatch(/WHERE work_unit_id = \?/);
    // `\s*` before the cast: fakeSql joins the template parts with " ? ", so a
    // bound value always arrives space-padded.
    expect(text).toMatch(/business_date >=\s*\?\s*::date/);
    expect(text).toMatch(/business_date <=\s*\?\s*::date/);
    // Slot-wise, like the paginateShiftReport assertions above: the trailing slot
    // is the shift FRAGMENT, which fakeSql records as a param of the parent query.
    expect(find(PERF)?.params.slice(0, 3)).toEqual([7, "2026-08-01", "2026-08-01"]);
  });

  // The shift grain narrows; the day and month grains span every shift, so the
  // predicate has to disappear rather than match a sentinel.
  it("adds the shift predicate only when a shift is given", async () => {
    const SHIFT = /AND shift = \?/;

    const withShift = fakeSql();
    await new WorkUnitReportReaderRepository({ goldDb: withShift.goldDb }).listPerfHours(
      perfInput({ shift: 3 }),
    );
    // A fragment is its own recorded call, so it is found by its own text rather
    // than inside the parent's.
    expect(withShift.find(SHIFT)?.params).toEqual([3]);

    const withoutShift = fakeSql();
    await new WorkUnitReportReaderRepository({ goldDb: withoutShift.goldDb }).listPerfHours(
      perfInput({ shift: undefined }),
    );
    expect(withoutShift.find(SHIFT)).toBeUndefined();
  });

  // A month is a range over the same method — the reason this is not keyed on a
  // report id. See TODOS.md §23.
  it("takes a multi-day range unchanged, for the day and month grains", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listPerfHours(
      perfInput({ dateFrom: "2026-08-01", dateTo: "2026-08-31", shift: undefined }),
    );

    expect(find(PERF)?.params.slice(0, 3)).toEqual([7, "2026-08-01", "2026-08-31"]);
  });

  // THE regression this ORDER BY exists for. Shift 3 runs 23:00 -> 07:00, so
  // ordering by the clock label renders 00,01,...,06,23 and puts the shift's FIRST
  // hour last — which is exactly what the reference design did.
  it("orders by the bucket instant, never by the clock-hour label", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listPerfHours(perfInput());

    const text = find(PERF)?.text ?? "";
    expect(text).toMatch(/ORDER BY bucket_start ASC, product_name ASC, product_id ASC/);
    expect(text).not.toMatch(/ORDER BY[^;]*hour_of_day/);
  });

  // No AT TIME ZONE anywhere: business_date is a real date the pipeline already
  // computed in the plant's zone. This is what listProductCount cannot do, and the
  // reason the new table was given the column from day one.
  it("does no time-zone arithmetic of its own", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listPerfHours(perfInput());

    expect(find(PERF)?.text).not.toMatch(/AT TIME ZONE/);
  });

  // postgres.js returns numeric AND bigint as strings, so an uncast column reaches
  // the browser as "34304.000" and violates the `number` domain type.
  it("returns every measure as a float8", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listPerfHours(perfInput());

    const text = find(PERF)?.text ?? "";
    expect(text).toContain("round(total_out::numeric, 3)::float8");
    expect(text).toContain("round(effective_out::numeric, 3)::float8");
    expect(text).toContain("round(ideal_rate_per_hour::numeric, 3)::float8");
    expect(text).toContain("runtime::float8");
  });

  // Rates here are denominated in uom_id, so scaling the quantities to the base
  // unit while leaving the standard in the production unit would put a numerator
  // and its denominator in different units. Contrast listProductCount, which does
  // scale — and must.
  it("does NOT scale the measures by factor_to_base", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listPerfHours(perfInput());

    expect(find(PERF)?.text).not.toContain("factor_to_base");
  });

  it("returns an empty list when the shift has no hourly rows", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.listPerfHours(perfInput())).toEqual([]);
  });
});

describe("WorkUnitReportReaderRepository.getPerfWatermark", () => {
  it("reads the watermark for this table only", async () => {
    const { goldDb, find } = fakeSql([
      { match: WATERMARK, rows: [{ lastBusinessDate: "2026-08-02" }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getPerfWatermark()).toBe("2026-08-02");
    expect(find(WATERMARK)?.params).toContain("product_perf_wu_hour");
  });

  // A MISSING ROW MEANS NEVER LOADED. Returning null rather than throwing or
  // defaulting to a date is what lets the browser separate "the pipeline has not
  // reached this day" from "the machine made nothing".
  it("returns null when the table has never been loaded", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getPerfWatermark()).toBeNull();
  });

  it("returns null when the row exists but carries no business day", async () => {
    const { goldDb } = fakeSql([{ match: WATERMARK, rows: [{ lastBusinessDate: null }] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getPerfWatermark()).toBeNull();
  });
});

// The Quality Loss Pareto's aggregate. These pin SHAPE, which is what fakeSql can
// see; the VALUES are pinned by the integration suite next door, because
// everything this query gets wrong it gets wrong arithmetically and none of it
// throws.
// The shared row set is its own recorded call — it is a fragment, interpolated
// into both statements below as a single bound value. So the JOIN is asserted
// against this pattern and the aggregates against the two below it.
const REJECT_ROWS = /JOIN oee\.reject_count_wu_shift/;
const REJECT_BUCKETS = /GROUP BY reason/;
const REJECT_TOTALS = /total_weight_gram/;
const REJECT_WATERMARK = /FROM oee\.etl_watermarks/;

describe("WorkUnitReportReaderRepository.aggregateRejectReasons", () => {
  it("joins the reject rows to the report through the plant's business day", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    const call = find(REJECT_ROWS);
    expect(call?.text).toMatch(/j\.shift_date = \(r\.date AT TIME ZONE \? \)::date/);
    expect(call?.params).toEqual([JAKARTA, 7]);
  });

  // The two traps listProductCount already documents, restated as assertions.
  // Converting `j.shift_date` instead of `r.date` would move the conversion onto
  // every reject row and defeat pk_reject_count_wu_shift; a cast on the shift
  // would defeat it too.
  it("leaves the indexed columns bare so the primary key still serves the lookup", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    const text = find(REJECT_ROWS)?.text ?? "";
    expect(text).not.toMatch(/j\.shift_date AT TIME ZONE/);
    expect(text).toContain("j.shift = r.shift");
    expect(text).not.toMatch(/j\.shift::/);
  });

  // THE ASSERTION THAT MATTERS MOST IN THIS BLOCK. `converted_value` is a
  // GENERATED column, so the database owns `counter_value * factor_to_base`.
  // Recomputing it here would give the browser and a BI tool two places to
  // disagree about one number — and both would look plausible.
  it("reads converted_value rather than recomputing the conversion", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    // NOTE FOR WHOEVER EDITS THE QUERY'S COMMENTS: the normalisation above
    // collapses newlines, so `--` prose survives into this string. A comment that
    // QUOTES the expression below would fail this test on the prose alone — which
    // is why the one beside `converted_value` describes the conversion instead of
    // spelling it out.
    const text = find(REJECT_BUCKETS)?.text ?? "";
    expect(text).toContain("sum(converted_value)");
    expect(text).not.toMatch(/counter_value \* factor_to_base/);
  });

  // NULL is "not weighed" and 0 is "weighed nothing". sum() over an all-NULL set
  // is NULL, which is exactly the wanted semantics — so a coalesce here would
  // silently convert every unweighed counter into a weighed-and-empty one.
  it("does NOT coalesce the weight sum, in the buckets or the totals", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    for (const pattern of [REJECT_BUCKETS, REJECT_TOTALS]) {
      const text = find(pattern)?.text ?? "";
      expect(text).toContain("round(sum(weight_gram), 3)::float8");
      expect(text).not.toMatch(/coalesce\(\s*(round\()?sum\(weight_gram\)/);
    }
  });

  // Every other measure IS coalesced, because the browser types them as numbers
  // and a null denominator on those would reach the cumulative line as a
  // divide-by-null.
  it("coalesces every measure except the weight", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    const text = find(REJECT_TOTALS)?.text ?? "";
    expect(text).toContain("coalesce(sum(frequency), 0)::int");
    expect(text).toContain("coalesce(sum(reject_time), 0)::float8");
    expect(text).toContain("coalesce(round(sum(converted_value), 3), 0)::float8");
  });

  // A work unit's counters can report in different units, and one reason can span
  // several products — so a bucket may cover rows whose units disagree. Summing
  // those is meaningless, and the guard is what turns a plausible number into an
  // em dash on screen.
  it("nulls a unit the bucket's rows disagree about, rather than picking one", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    const text = find(REJECT_BUCKETS)?.text ?? "";
    expect(text).toContain("CASE WHEN count(DISTINCT uom_code) = 1 THEN min(uom_code) END");
    expect(text).toContain(
      "CASE WHEN count(DISTINCT base_uom_code) = 1 THEN min(base_uom_code) END",
    );
    // The shift-level converted unit gets the same treatment on the totals.
    expect(find(REJECT_TOTALS)?.text).toContain("count(DISTINCT base_uom_code) = 1");
  });

  // Two statements over ONE shared row set. If the buckets and the totals could
  // select different rows, the bars would not sum to their own denominator and
  // the cumulative line would be wrong in a way nobody would spot.
  it("computes the buckets and the totals over the same CTE", async () => {
    const { goldDb, find, calls } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    for (const pattern of [REJECT_BUCKETS, REJECT_TOTALS]) {
      const call = find(pattern);
      expect(call?.text).toContain("WITH scoped AS (");
      expect(call?.text).toContain("FROM scoped");
      // ONE bound value each, and it is the fragment — not a second copy of the
      // join with its own parameters, which is how the two could come to select
      // different rows.
      expect(call?.params).toHaveLength(1);
    }
    // The join itself was issued exactly once.
    expect(calls.filter((c) => REJECT_ROWS.test(c.text))).toHaveLength(1);
  });

  // Deterministic and TOTAL. The cumulative line is a function of the order, so
  // two equal counters swapping places between identical requests would move the
  // chart under a user who changed nothing.
  it("orders by converted quantity with the reason as a tiebreak", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(7, JAKARTA);

    expect(find(REJECT_BUCKETS)?.text).toContain(
      "ORDER BY sum(converted_value) DESC NULLS LAST, reason ASC",
    );
  });

  it("returns zeroed totals and a null weight when nothing matched", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.aggregateRejectReasons(7, JAKARTA)).toEqual({
      buckets: [],
      totalFrequency: 0,
      totalDurationMs: 0,
      totalQuantity: 0,
      totalWeightGram: null,
      convertedUnit: null,
    });
  });
});

describe("WorkUnitReportReaderRepository.getRejectWatermark", () => {
  it("reads the watermark for the reject table only", async () => {
    const { goldDb, find } = fakeSql([
      { match: REJECT_WATERMARK, rows: [{ lastBusinessDate: "2026-08-01" }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getRejectWatermark()).toBe("2026-08-01");
    // A BOUND PARAMETER, not a literal — the read moved to shared/database/watermark.ts
    // when the line grain became its fifth caller, and the table name is now the one
    // thing each caller supplies. Asserting the PARAM is what pins that this reader
    // asks about its own table and no other.
    expect(find(REJECT_WATERMARK)?.params).toContain("reject_count_wu_shift");
  });

  // The table ships EMPTY, so this is the normal answer today — and it is the
  // only thing that stops the Quality Loss tab reporting every shift as clean.
  it("returns null when the table has never been loaded", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getRejectWatermark()).toBeNull();
  });
});

// The Others tab's aggregate. Same division of labour as the reject block above:
// these pin SHAPE, which is all fakeSql can see, and the integration suite next
// door pins the VALUES — because everything this query gets wrong it gets wrong
// arithmetically and none of it throws.
//
// The (event, reason) pairs are their own recorded call, being a fragment
// interpolated into both statements as a single bound value. `pairs` rather than
// `scoped` as the CTE name, deliberately, so these patterns cannot collide with
// the reject block's.
const EVENT_PAIRS = /JOIN oee\.downtime_log_events/;
const EVENT_BUCKETS = /count\(\*\)::int AS frequency/;
const EVENT_TOTALS = /total_events/;
const EVENT_WATERMARK = /FROM oee\.etl_watermarks/;

// Every table this query must NEVER name. oee.work_unit_shift_reports is
// deliberately absent from the list: it is the join anchor and the 404 source.
const FORBIDDEN_TABLES = [
  "oee.downtime_reports",
  "oee.downtime_report_history",
  "oee.reject_count_wu_shift",
  "oee.product_count_wu_shift",
  "oee.product_perf_wu_hour",
];

describe("WorkUnitReportReaderRepository.aggregateDowntimeEventReasons", () => {
  it("joins the events to the report through the plant's business day", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    const call = find(EVENT_PAIRS);
    expect(call?.text).toMatch(/e\.shift_date = \(r\.date AT TIME ZONE \? \)::date/);
    expect(call?.params).toEqual([JAKARTA, 7]);
  });

  // Worth more here than on the reject table. pk_reject_count_wu_shift has
  // (work_unit_id, shift_date, shift) as its left prefix and serves that join for
  // free; this table's key is a single text event_id and serves it not at all, so
  // ix_dtle_wu_shift is the only thing standing between this read and a
  // sequential scan. Converting the event side, or casting the shift, defeats it.
  it("leaves the indexed columns bare so ix_dtle_wu_shift still serves the lookup", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    const call = find(EVENT_PAIRS);
    expect(call?.text).not.toMatch(/e\.shift_date AT TIME ZONE/);
    expect(call?.text).toContain("e.shift = r.shift");
    expect(call?.text).not.toMatch(/e\.shift::/);
  });

  // THE PRODUCT DECISION, ASSERTED RATHER THAN DESCRIBED. oee.downtime_reports is
  // the operator-mutable table — editing a downtime's reasons is one of the two
  // writes contract §1 rule 2 reserves for this service — so a Pareto drawn from
  // it moves when an operator corrects a stop. A query that reaches into it is
  // not a slower version of this feature, it is a different feature. TODOS.md §30.
  it("reads neither oee.downtime_reports nor any product-report table", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    for (const forbidden of FORBIDDEN_TABLES) {
      for (const call of calls) expect(call.text).not.toContain(forbidden);
    }
    // The anchor it IS allowed to read, so this test cannot pass by issuing no
    // SQL at all.
    expect(calls.some((c) => c.text.includes("oee.work_unit_shift_reports"))).toBe(true);
  });

  // A reason repeated inside ONE row must count ONCE, because it is one event.
  // The event id has to be part of the DISTINCT key or the explode collapses to a
  // presence list and every frequency becomes 1.
  it("explodes the array once per event, DISTINCT on the pair", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    const call = find(EVENT_PAIRS);
    expect(call?.text).toContain("SELECT DISTINCT e.event_id");
    expect(call?.text).toMatch(/unnest\(e\.reasons\)/);
    expect(call?.text).not.toMatch(/SELECT DISTINCT nullif/);
  });

  // THE QUIETEST FAILURE IN THE FEATURE. unnest('{}') yields zero rows, so an
  // inner join drops every event that recorded no reason — out of the
  // unattributed bucket AND out of total_events. The bars still sum to
  // total_occurrences and the cumulative line still reaches 100%, so the chart
  // looks entirely correct and only the sentence beside it is wrong.
  it("keeps a reason-less event by joining LEFT", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    const call = find(EVENT_PAIRS);
    expect(call?.text).toMatch(/LEFT JOIN LATERAL unnest\(e\.reasons\)/);
    expect(call?.text).not.toMatch(/, unnest\(/);
    expect(call?.text).not.toMatch(/[^T] JOIN unnest\(/);
  });

  // So there is exactly ONE unattributed bucket. ck_dtle_reasons makes a blank
  // element unreachable from a compliant pipeline; this guard outlives the
  // constraint, the way DowntimeReaderRepository.primaryReason's outlives
  // downtime_reports' lack of one.
  it("folds a blank element into the same bucket as an absent one", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    expect(find(EVENT_PAIRS)?.text).toContain("nullif(btrim(x.reason), '')");
  });

  // Counting the reason COLUMN would skip nulls and report 0 for the unattributed
  // bucket — a zero-height bar still occupying a table row — and the totals
  // written the same way would stop equalling the total of the bars.
  //
  // NOTE FOR WHOEVER EDITS THE SQL'S COMMENTS: fakeSql records the comment text
  // along with the statement, so a negative assertion like the one below can be
  // defeated by prose that quotes the anti-pattern verbatim. Both this case and
  // "carries no duration anywhere" have already been tripped that way once.
  it("counts rows rather than non-null reasons", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    expect(find(EVENT_BUCKETS)?.text).toContain("count(*)::int AS frequency");
    expect(find(EVENT_BUCKETS)?.text).not.toMatch(/count\(reason\)/);
  });

  // total_occurrences is the DENOMINATOR and total_events is not. No coalesce on
  // either: count() over an empty row set returns a row containing 0, never NULL,
  // unlike the sum()s in aggregateRejectReasons where the coalesce is
  // load-bearing.
  it("returns both totals from the same rows, and coalesces neither", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    const call = find(EVENT_TOTALS);
    expect(call?.text).toContain("count(*)::int AS total_occurrences");
    expect(call?.text).toContain("count(DISTINCT event_id)::int AS total_events");
    expect(call?.text).not.toMatch(/coalesce\( ?count\(/);
  });

  // FREQUENCY ONLY, pinned in code. The table carries no duration, no start_at
  // and no end_at, so no statement here may reach for one — and none may sum
  // anything, since there is nothing summable on the row.
  it("carries no duration anywhere", async () => {
    const { goldDb, calls } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    for (const call of calls) {
      expect(call.text).not.toMatch(/duration/i);
      expect(call.text).not.toMatch(/start_at|end_at/);
      expect(call.text).not.toMatch(/sum\(/);
    }
  });

  // The bars and their own denominator, over ONE row set. Two aggregates that
  // derived the explode separately could differ in the DISTINCT key and disagree
  // about the total, which nothing on screen would reveal.
  it("computes the buckets and the totals over one shared row set", async () => {
    const { goldDb, find, calls } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    for (const pattern of [EVENT_BUCKETS, EVENT_TOTALS]) {
      const call = find(pattern);
      expect(call?.text).toContain("WITH pairs AS (");
      expect(call?.text).toContain("FROM pairs");
      // ONE bound value each, and it is the fragment — not a second copy of the
      // join carrying its own parameters, which is how the two could come to
      // select different rows.
      expect(call?.params).toHaveLength(1);
    }
    expect(calls.filter((c) => EVENT_PAIRS.test(c.text))).toHaveLength(1);
  });

  // Deterministic and TOTAL. The reason IS the group key, so the tiebreak makes
  // the order a function of the data alone — without it two equally frequent
  // reasons could swap between identical requests and the cumulative line, which
  // is a function of the order, would move under a user who changed nothing.
  it("orders by frequency with the reason as a tiebreak", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(7, JAKARTA);

    expect(find(EVENT_BUCKETS)?.text).toContain("ORDER BY count(*) DESC, reason ASC NULLS LAST");
  });

  // The highest-consequence typo in the feature, and the only unit-level guard
  // against it. Transposed, `totalEvents` becomes the denominator and the
  // cumulative line walks past 100%.
  it("maps total_occurrences and total_events to the right fields", async () => {
    const { goldDb } = fakeSql([
      { match: EVENT_TOTALS, rows: [{ totalOccurrences: 8, totalEvents: 5 }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.aggregateDowntimeEventReasons(7, JAKARTA)).toEqual({
      buckets: [],
      totalOccurrences: 8,
      totalEvents: 5,
    });
  });

  it("returns zeroed totals when nothing matched", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.aggregateDowntimeEventReasons(7, JAKARTA)).toEqual({
      buckets: [],
      totalOccurrences: 0,
      totalEvents: 0,
    });
  });
});

describe("WorkUnitReportReaderRepository.getDowntimeEventWatermark", () => {
  it("reads the watermark for the event log only", async () => {
    const { goldDb, find } = fakeSql([
      { match: EVENT_WATERMARK, rows: [{ lastBusinessDate: "2026-08-01" }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getDowntimeEventWatermark()).toBe("2026-08-01");
    expect(find(EVENT_WATERMARK)?.params).toContain("downtime_log_events");
  });

  // The table ships EMPTY, so this is the normal answer today — and it is the only
  // thing that stops the Others tab reporting every shift as a shift nothing
  // stopped.
  it("returns null when the log has never been loaded", async () => {
    const { goldDb } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getDowntimeEventWatermark()).toBeNull();
  });
});

describe("WorkUnitReportReaderRepository.listApprovalTransitions", () => {
  const EVENTS = /FROM oee\.work_unit_shift_report_approval_events/;

  it("selects the display name alongside the subject", async () => {
    // REGRESSION GUARD. This query originally selected by_subject alone, so the
    // Log Activity panel had only a Keycloak UUID to render and showed it.
    const { goldDb, find } = fakeSql([{ match: EVENTS, rows: [] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listApprovalTransitions({
      workUnitId: 7,
      date: new Date("2026-08-09T00:00:00.000Z"),
      shift: 1,
    });

    const q = find(EVENTS);
    expect(q?.text).toMatch(/by_subject AS "by"/);
    expect(q?.text).toMatch(/by_name/);
    // Newest first, with id breaking the tie — matching the other arm so the
    // merged chronology has one total order.
    expect(q?.text).toMatch(/ORDER BY at DESC, id DESC/);
  });
});

describe("WorkUnitReportReaderRepository.listApprovalsForPage", () => {
  const APPROVALS = /FROM unnest\(/;

  it("issues no query at all for an empty page", async () => {
    // Not merely an optimisation. paginateShiftReport legitimately returns zero
    // rows — an existing work centre with no work units is a valid empty page —
    // and unnest of three empty arrays is a pointless round trip on the app's
    // hottest screen.
    const { goldDb, calls } = fakeSql();
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    const out = await repo.listApprovalsForPage([]);

    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("binds one array per key column, aligned by position", async () => {
    // THE FAILURE THIS GUARDS IS SILENT. unnest zips the arrays positionally, so
    // a misalignment joins the wrong report to the wrong approval and every row
    // still renders plausibly. Asserting the params as parallel arrays is what
    // catches a stray .map() that reorders one of them.
    const d1 = new Date("2026-08-09T00:00:00.000Z");
    const d2 = new Date("2026-08-10T08:00:00.000Z");
    const { goldDb, find } = fakeSql([{ match: APPROVALS, rows: [] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listApprovalsForPage([
      { reportId: 1, workUnitId: 7, date: d1, shift: 1 },
      { reportId: 2, workUnitId: 9, date: d2, shift: 2 },
    ]);

    const q = find(APPROVALS);
    expect(q?.params).toEqual([
      [7, 9],
      // ISO STRINGS, NOT Date OBJECTS, and this is a regression guard rather
      // than a style preference. postgres.js infers an array parameter's type
      // from its FIRST ELEMENT, so a Date[] is declared as a scalar timestamptz
      // and `::timestamptz[]` then fails with "cannot cast type timestamp with
      // time zone to timestamp with time zone[]" — which shipped once and took
      // out the whole By Shift list. A string infers as unspecified, so the cast
      // decides the type, exactly as it does for the int arrays.
      ["2026-08-09T00:00:00.000Z", "2026-08-10T08:00:00.000Z"],
      [1, 2],
      [1, 2],
    ]);
    // Belt and braces: nothing in the bind params may be a Date.
    for (const param of q?.params ?? []) {
      for (const element of param as unknown[]) {
        expect(element).not.toBeInstanceOf(Date);
      }
    }
    // The casts are load-bearing: postgres.js sends a JS array as text[] unless
    // told otherwise, and `text = integer` is not an implicit comparison.
    expect(q?.text).toMatch(/::int\[\]/);
    expect(q?.text).toMatch(/::timestamptz\[\]/);
    expect(q?.text).toMatch(/::smallint\[\]/);
    // Joined on the natural key — the approvals table has no report_id column,
    // which is the entire point of migration 0010.
    expect(q?.text).toMatch(/a\.work_unit_id = k\.work_unit_id/);
    expect(q?.text).not.toMatch(/a\.report_id/);
  });
});

// ---------------------------------------------------------------------------
// The write side
// ---------------------------------------------------------------------------
//
// What these tests CAN see: which statements are issued, in what order, with
// what parameters. What they CANNOT see: that the statements share a
// transaction, or what Postgres does with ON CONFLICT. fakeSql matches SQL text
// and never executes it, so the outcome-discrimination and concurrency
// properties are proved in work-unit-repository.integration.test.ts.
const SCOPE = /FROM oee\.work_unit_shift_reports/;
const UPSERT = /INSERT INTO oee\.work_unit_shift_report_approvals/;
const EVENT = /INSERT INTO oee\.work_unit_shift_report_approval_events/;

const KEY_ROW = {
  workUnitId: 7,
  date: new Date("2026-08-09T00:00:00.000Z"),
  shift: 1,
};

const APPROVAL_ROW = {
  status: "closed",
  closedAt: new Date("2026-08-09T09:00:00.000Z"),
  closedBy: "kc-sub-1",
  closedByName: "dewi",
  source: "operator",
};

function closeInput() {
  return { reportId: 42, closedBy: "kc-sub-1", closedByName: "dewi" };
}

describe("WorkUnitReportWriterRepository.closeShiftReport", () => {
  it("stamps the operator application_name before writing anything", async () => {
    const { goldDb, calls } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: UPSERT, rows: [APPROVAL_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.closeShiftReport(closeInput());

    // set_config with is_local => true, NOT `SET LOCAL` — the latter takes no
    // bind parameters, so it cannot be written safely as a tagged template.
    // Being FIRST is what scopes it over the writes that follow.
    expect(calls[0]?.text).toMatch(/set_config\('application_name', \? ?, true\)/);
    expect(calls[0]?.params).toEqual(["mes-oee-monitor-operator"]);
  });

  it("never writes to oee.work_unit_shift_reports", async () => {
    // THE CHEAP PROXY FOR MIGRATION 0010'S WHOLE ARGUMENT.
    //
    // Approval state lives in its own table, keyed on (work_unit_id, date,
    // shift), precisely so a dbt restatement of the report row cannot destroy
    // it. That property is proved for real in the integration suite; this
    // assertion is what catches somebody "simplifying" it back into a column on
    // the report row, and it runs on every `vp test`.
    const { goldDb, calls } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: UPSERT, rows: [APPROVAL_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.closeShiftReport(closeInput());

    const writes = calls.filter((c) => /INSERT|UPDATE|DELETE/.test(c.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.text).not.toMatch(/oee\.work_unit_shift_reports\b/);
    }
  });

  it("upserts on the natural key and only when the report is open", async () => {
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: UPSERT, rows: [APPROVAL_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.closeShiftReport(closeInput());

    const upsert = find(UPSERT);
    expect(upsert?.text).toMatch(/ON CONFLICT \(work_unit_id, date, shift\) DO UPDATE/);
    // The guard that makes a second approve a 409 instead of a silent re-close.
    // `a.` and not the schema-qualified name: only the alias is a valid
    // reference to the existing row in a DO UPDATE ... WHERE.
    expect(upsert?.text).toMatch(/WHERE a\.status = 'open'/);
    expect(upsert?.text).toMatch(/INSERT INTO oee\.work_unit_shift_report_approvals AS a/);
    // RETURNING is what turns the row count into the outcome.
    expect(upsert?.text).toMatch(/RETURNING/);
    // The subject reaches the row; the display name rides along beside it.
    expect(upsert?.params).toEqual([7, KEY_ROW.date, 1, "kc-sub-1", "dewi"]);
  });

  it("writes the transition event with both sides of the move", async () => {
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: UPSERT, rows: [APPROVAL_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.closeShiftReport(closeInput());

    const event = find(EVENT);
    expect(event).toBeDefined();
    // from_status is 'open' by construction — the upsert's WHERE admits no other
    // prior state — so no extra read is needed to discover it.
    expect(event?.text).toMatch(/'open', 'closed', 'operator'/);
    expect(event?.params).toEqual([7, KEY_ROW.date, 1, "kc-sub-1", "dewi"]);
  });

  it("reports not_found without attempting either write", async () => {
    // The existence check is a SEPARATE statement precisely so this case is
    // distinguishable from already_closed. Folding it into the upsert would make
    // both produce zero rows, and 404 and 409 would collapse into one.
    const { goldDb, find } = fakeSql([{ match: SCOPE, rows: [] }]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    const out = await repo.closeShiftReport(closeInput());

    expect(out).toEqual({ kind: "not_found" });
    expect(find(UPSERT)).toBeUndefined();
    expect(find(EVENT)).toBeUndefined();
  });

  it("reports already_closed when the upsert matches no row, and logs no event", async () => {
    // Zero rows back from the upsert means the WHERE a.status = 'open' filtered
    // an existing CLOSED row out. The event log must not gain a row for a
    // transition that did not happen — ck_wusrae_moves would reject it anyway,
    // but the writer must not try.
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: UPSERT, rows: [] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    const out = await repo.closeShiftReport(closeInput());

    expect(out).toEqual({ kind: "already_closed" });
    expect(find(EVENT)).toBeUndefined();
  });

  it("returns the approval the database actually wrote", async () => {
    const { goldDb } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: UPSERT, rows: [APPROVAL_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    const out = await repo.closeShiftReport(closeInput());

    // Not a value the service reassembled from its own inputs: closed_at is the
    // database's clock, and the browser renders it.
    expect(out).toEqual({ kind: "closed", approval: APPROVAL_ROW });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WorkUnitReportWriterRepository.reopenShiftReport
// ─────────────────────────────────────────────────────────────────────────────
//
// The mirror of closeShiftReport, and what these tests own is the difference: an
// UPDATE rather than an upsert, all four closure columns cleared, and the event
// row recording the reverse direction. The row-count discrimination — which is
// what makes an already-open report a 409 rather than a silent success — is
// proved in the integration suite, because fakeSql matches SQL text and never
// executes ON CONFLICT or a WHERE.
const REOPEN = /UPDATE oee\.work_unit_shift_report_approvals/;

const OPEN_ROW = {
  status: "open",
  closedAt: null,
  closedBy: null,
  closedByName: null,
  source: null,
};

describe("WorkUnitReportWriterRepository.reopenShiftReport", () => {
  it("stamps the operator application_name before writing anything", async () => {
    const { goldDb, calls } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: REOPEN, rows: [OPEN_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.reopenShiftReport(closeInput());

    // ONE CONSTANT FOR BOTH MUTATIONS, and now for all three: postgres.ts states
    // that a different string here would make
    // `WHERE application_name = 'mes-oee-monitor-operator'` return part of the
    // answer, silently.
    expect(calls[0]?.text).toMatch(/set_config\('application_name', \? ?, true\)/);
    expect(calls[0]?.params).toEqual(["mes-oee-monitor-operator"]);
  });

  it("clears ALL FOUR closure columns, not just the status", async () => {
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: REOPEN, rows: [OPEN_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.reopenShiftReport(closeInput());

    const update = find(REOPEN);
    // ck_wusra_open REQUIRES this, so leaving one populated is a constraint
    // violation rather than a stale approver quietly surviving on a reopened
    // report — which is exactly why 0010 wrote the constraint that way.
    expect(update?.text).toMatch(/status\s*=\s*'open'/);
    for (const column of ["source", "closed_at", "closed_by", "closed_by_name"]) {
      expect(update?.text).toMatch(new RegExp(`${column}\\s*=\\s*NULL`));
    }
  });

  it("updates on the natural key and only when the report is closed", async () => {
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: REOPEN, rows: [OPEN_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.reopenShiftReport(closeInput());

    const update = find(REOPEN);
    // Keyed on (work_unit_id, date, shift), never on the report's serial id —
    // 0010's whole argument, and the reason an approval survives a dbt
    // restatement of the report row.
    expect(update?.text).toMatch(/work_unit_id = \?/);
    expect(update?.text).toMatch(/AND status\s*=\s*'closed'/);
    expect(update?.text).toMatch(/RETURNING/);
    expect(update?.params).toEqual([KEY_ROW.workUnitId, KEY_ROW.date, KEY_ROW.shift]);
  });

  it("records the reverse transition in the same set of statements", async () => {
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: REOPEN, rows: [OPEN_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.reopenShiftReport(closeInput());

    const event = find(EVENT);
    // 'closed' -> 'open'. from_status is 'closed' BY CONSTRUCTION — the UPDATE's
    // WHERE admits no other prior state — so it needs no extra read to discover.
    // The subject is recorded because it is the only durable record of who undid
    // somebody else's sign-off.
    expect(event?.params).toEqual([
      KEY_ROW.workUnitId,
      KEY_ROW.date,
      KEY_ROW.shift,
      "kc-sub-1",
      "dewi",
    ]);
    expect(event?.text).toMatch(/'closed', 'open', 'operator'/);
  });

  it("never writes to oee.work_unit_shift_reports", async () => {
    const { goldDb, calls } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: REOPEN, rows: [OPEN_ROW] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    await repo.reopenShiftReport(closeInput());

    const writes = calls.filter((c) => /INSERT|UPDATE|DELETE/.test(c.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.text).not.toMatch(/oee\.work_unit_shift_reports\b/);
    }
  });

  // The existence check is SEPARATE for closeShiftReport's reason: folded into
  // the UPDATE, a missing report and an already-open one would both be zero rows
  // and 404 and 409 would collapse.
  it("reports not_found without attempting the UPDATE", async () => {
    const { goldDb, find } = fakeSql([]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    const outcome = await repo.reopenShiftReport(closeInput());

    expect(outcome).toEqual({ kind: "not_found" });
    expect(find(REOPEN)).toBeUndefined();
  });

  // Zero rows from the guarded UPDATE. Note this covers BOTH "the row says open"
  // and "there is no row at all", which are the same claim — 0010: the absence of
  // a row IS the open state.
  it("reports already_open on zero rows, and writes no event", async () => {
    const { goldDb, find } = fakeSql([
      { match: SCOPE, rows: [KEY_ROW] },
      { match: REOPEN, rows: [] },
    ]);
    const repo = new WorkUnitReportWriterRepository({ goldDb });

    const outcome = await repo.reopenShiftReport(closeInput());

    expect(outcome).toEqual({ kind: "already_open" });
    // A trail that can disagree with the row it describes is worse than none —
    // TODOS.md §21's rule, applied to the failure path.
    expect(find(EVENT)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two reads the downtime edit added
// ─────────────────────────────────────────────────────────────────────────────
describe("WorkUnitReportReaderRepository.getProductCountWatermark", () => {
  const WATERMARK = /FROM oee\.etl_watermarks/;

  // The table name is the whole content of this query, and getting it wrong is
  // silent: a watermark read for the wrong table returns SOME date, the comparison
  // succeeds, and the card confidently reports a clean shift over data that has
  // not loaded. TODOS.md §14.
  it("reads the watermark for product_count_wu_shift and nothing else", async () => {
    const { goldDb, find } = fakeSql([
      { match: WATERMARK, rows: [{ lastBusinessDate: "2026-08-09" }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getProductCountWatermark()).toBe("2026-08-09");
    expect(find(WATERMARK)?.params).toContain("product_count_wu_shift");
    // Formatted in SQL, not in JS: the column is a `date`, and letting a Date
    // reach the browser would reintroduce the session-time-zone ambiguity the
    // business-day comparison exists to avoid.
    expect(find(WATERMARK)?.text).toMatch(/to_char\(last_business_date, 'YYYY-MM-DD'\)/);
  });

  // No row means the table has NEVER been loaded — a third state, distinct from
  // both "loaded" and "loaded through some earlier day".
  it("reports null when no watermark row exists", async () => {
    const { goldDb } = fakeSql([]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getProductCountWatermark()).toBeNull();
  });
});

describe("WorkUnitReportReaderRepository.getCategoryEditedAt", () => {
  const STALENESS = /max\(h\.changed_at\)/;

  const input = () => ({
    workUnitId: 3,
    from: new Date("2026-08-09T00:00:00.000Z"),
    to: new Date("2026-08-09T08:00:00.000Z"),
  });

  it("asks only about `category`, of the four editable fields", async () => {
    const { goldDb, find } = fakeSql([
      { match: STALENESS, rows: [{ editedAt: new Date("2026-08-09T09:30:00.000Z") }] },
    ]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.getCategoryEditedAt(input());

    // The other three — reason, actions, detail_reason — are read LIVE out of
    // oee.downtime_reports by the Pareto and the drawer, so editing them cannot
    // make anything on screen stale. Only `category` moves time between schedule
    // loss and availability loss, which the pipeline precomputes.
    expect(find(STALENESS)?.text).toMatch(/h\.field = 'category'/);
  });

  it("reuses the shift-stop membership predicate, overlap and all", async () => {
    const { goldDb, find } = fakeSql([{ match: STALENESS, rows: [{ editedAt: null }] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.getCategoryEditedAt(input());

    // The predicate is a NESTED fragment — the outer statement reads
    // `WITH members AS ( ? )` — so it is recorded as its own call. That nesting is
    // the point: it is the SAME fragment listShiftDowntimeHistory interpolates.
    // If the two diverged, the Log Activity panel would list a category edit this
    // endpoint did not think had happened, and both screens would look fine.
    expect(find(STALENESS)?.text).toMatch(/WITH members AS \( \? \)/);

    const members = find(/FROM oee\.downtime_reports/);
    // The range expression, copied from dt_reports_span_gist. It must be
    // IDENTICAL to DowntimeReaderRepository.scopeAndWindow's — if one of the two
    // drifts, the Log Activity panel and the stale-metrics banner disagree about
    // which stops belong to the shift and both screens still look fine.
    expect(members?.text).toMatch(
      /tstzrange\(start_at, greatest\(coalesce\(end_at, 'infinity'::timestamptz\), start_at\), '\[\)'\)\s*&& tstzrange/,
    );
    // No `start_at >= from` lower bound is the load-bearing absence: it would
    // drop a stop that began before the shift and is still running.
    expect(members?.text).not.toMatch(/start_at >= \?/);
    // The `date` narrowing is GONE (TODOS.md §10, §69). Asserting its absence is
    // the guard against the seven-day horizon coming back.
    expect(members?.text).not.toMatch(/make_interval\(days => \? ?::int\)/);
    expect(members?.text).not.toMatch(/\bdate\b/);
  });

  // max() over no rows is ONE row holding NULL, not zero rows — so a repository
  // that treated an empty result as the only null case would still be right, and
  // one that indexed [0] without a fallback would be wrong for a different
  // reason. Both are covered.
  it.each([
    ["a null from max()", [{ editedAt: null }]],
    ["no row at all", []],
  ])("reports null for %s", async (_label, rows) => {
    const { goldDb } = fakeSql([{ match: STALENESS, rows }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    expect(await repo.getCategoryEditedAt(input())).toBeNull();
  });
});

describe("WorkUnitReportReaderRepository.listApprovalsOverlapping", () => {
  const OVERLAP = /FROM oee\.work_unit_shift_reports r/;

  const input = (endAt: Date | null = new Date("2026-08-09T16:20:00.000Z")) => ({
    workUnitId: 3,
    startAt: new Date("2026-08-09T15:40:00.000Z"),
    endAt,
    timeZone: "Asia/Jakarta",
  });

  it("LEFT JOINs the approvals and coalesces a missing row to open", async () => {
    const { goldDb, find } = fakeSql([{ match: OVERLAP, rows: [] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listApprovalsOverlapping(input());

    const query = find(OVERLAP);
    // 0010: the ABSENCE of a row means open. Reading the approvals table alone
    // would drop every unapproved shift from the result, and the freeze would
    // then only ever see reports somebody had already touched.
    expect(query?.text).toMatch(/LEFT JOIN oee\.work_unit_shift_report_approvals/);
    expect(query?.text).toMatch(/coalesce\(a\.status, 'open'\)/);
  });

  it("rebuilds each shift's end through AT TIME ZONE rather than adding hours", async () => {
    const { goldDb, find } = fakeSql([{ match: OVERLAP, rows: [] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listApprovalsOverlapping(input());

    const query = find(OVERLAP);
    // Every window IS eight hours, and `date + interval '8 hours'` would be
    // correct today and wrong in a plant that observes DST — eight WALL-CLOCK
    // hours across a transition is seven or nine real ones. The bounds are bound
    // as arrays derived from SHIFT_WINDOWS, so there is still one statement of
    // where a shift ends.
    expect(query?.text).toMatch(/AT TIME ZONE \?/);
    expect(query?.text).not.toMatch(/interval '8 hours'/);
    // Cast, because an untyped array parameter reaches Postgres as unknown and
    // the join on `shift` would fail — the trap listApprovalsForPage records.
    expect(query?.text).toMatch(/\? ?::int\[\]/);
    expect(query?.text).toMatch(/\? ?::text\[\]/);
    // The three arrays are the shift ids, their day offsets and their end times.
    expect(query?.params).toContainEqual([1, 2, 3]);
  });

  // An open stop is `coalesce(end_at, 'infinity')` to every read path. Taken
  // literally here it would overlap EVERY later shift, so one approval anywhere
  // would freeze it forever — and a long-open stop is the one most likely to need
  // its category corrected.
  it("bounds an open stop rather than letting it reach forever", async () => {
    const { goldDb, find } = fakeSql([{ match: OVERLAP, rows: [] }]);
    const repo = new WorkUnitReportReaderRepository({ goldDb });

    await repo.listApprovalsOverlapping(input(null));

    const query = find(OVERLAP);
    expect(query?.text).toMatch(/coalesce\(\s*\? ?::timestamptz,/);
    expect(query?.text).toMatch(/make_interval\(days => \? ?::int\)/);
    expect(query?.text).not.toMatch(/'infinity'/);
    // MAX_OPEN_DOWNTIME_DAYS, the same constant that bounds how far back the read
    // paths look for an open stop — so both directions agree about how far one
    // reaches.
    expect(query?.params).toContain(7);
  });
});
