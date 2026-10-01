import { describe, expect, it } from "vite-plus/test";

import { QualityEntryRepository } from "./quality-entry-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { ReportRef, TargetKey } from "./quality-entry-repository.js";

// The fakeSql harness, per the convention each repository test file follows. It
// matches SQL TEXT and never executes it, so arithmetic and three-valued-logic
// surprises belong to quality-entry-repository.integration.test.ts — which this
// module had, exclusively, until now.
//
// WHAT THIS SUITE IS FOR, AND WHY IT DID NOT EXIST BEFORE. The integration suite
// covers what a query RETURNS against a real Postgres. It cannot cover WHICH TABLE
// a query names, because a report id that resolves in one table usually resolves
// in another too — seven report tables, seven independent identity sequences. So
// the failure this file exists for is the quiet one: `findTargetByReport` given a
// SKU report id, reading oee.work_center_day_reports, returning a real anchor for
// a real line on a real date, and an operator's entry landing on a report nobody
// is looking at. Nothing throws, nothing logs, and the integration suite would
// pass because a row came back.
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

// NESTED FRAGMENTS ARE THEIR OWN CALLS, and in this repository almost everything
// interesting IS one. The fake joins template chunks with " ? ", so an interpolated
// Fragment shows as `?` in the outer query and is recorded separately with its own
// params — which means `FROM ?` in the anchor query, `WHERE ?` in every ledger
// read, and one more call each for the shift and product predicates.
//
// So assertions look at the FRAGMENT's call, never at the statement embedding it.
// `emitted` searches every recorded call, which is how a table name that only ever
// appears as its own one-chunk fragment can be asserted at all.
const ANCHOR = /WHERE id = \?/;
const SCOPED = /work_center_id = \? AND business_date/;
const LEDGER = /FROM oee\.work_center_quality_entries WHERE \?/;

// Did any recorded call — statement or nested fragment — contain this text?
function emitted(sql: ReturnType<typeof fakeSql>, needle: string): boolean {
  return sql.calls.some((call) => call.text.includes(needle));
}

// Every parameter bound anywhere in the request, fragments included.
function bound(sql: ReturnType<typeof fakeSql>): unknown[] {
  return sql.calls.flatMap((call) => call.params);
}

const LINE = (grain: "shift" | "day" | "month"): ReportRef =>
  ({ subject: "work-center", grain }) as const;
const SKU: ReportRef = { subject: "product", grain: "day" };

function target(overrides: Partial<TargetKey> = {}): TargetKey {
  return {
    workCenterId: 3,
    dateFrom: "2026-08-19",
    dateTo: "2026-08-20",
    shift: null,
    productId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findTargetByReport — which TABLE a report id is resolved against
// ---------------------------------------------------------------------------
describe("QualityEntryRepository.findTargetByReport", () => {
  // THE HAZARD THIS FILE EXISTS FOR, and it is the first assertion for that
  // reason. A SKU report id resolved against oee.work_center_day_reports comes
  // back populated — different line, possibly different date — and every step
  // after it is arithmetic on a plausible anchor.
  it("resolves a SKU report against oee.product_report_wc_day, never the line's day table", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.findTargetByReport(SKU, 79);

    expect(emitted(sql, "oee.product_report_wc_day")).toBe(true);
    expect(emitted(sql, "work_center_day_reports")).toBe(false);
    expect(sql.find(ANCHOR)?.params).toContain(79);
  });

  it.each([
    ["shift", "oee.work_center_shift_reports"],
    ["day", "oee.work_center_day_reports"],
    ["month", "oee.work_center_month_reports"],
  ] as const)("resolves a line %s report against %s", async (grain, table) => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.findTargetByReport(LINE(grain), 7);

    expect(emitted(sql, table)).toBe(true);
    expect(emitted(sql, "product_report_wc_day")).toBe(false);
  });

  // ALL FOUR ARMS PROJECT THE SAME SHAPE. A missing field on a camel-transformed
  // row compiles and reads `undefined` at runtime, so an arm that omitted
  // `product_id` rather than nulling it would produce an anchor the next query
  // binds and fails on — which is the 500 this method already produced once.
  it("projects a product on the SKU arm and a literal NULL on the line arms", async () => {
    const sku = fakeSql();
    await new QualityEntryRepository({ goldDb: sku.goldDb }).findTargetByReport(SKU, 79);
    expect(emitted(sku, "product_id")).toBe(true);
    expect(emitted(sku, "NULL::integer AS product_id")).toBe(false);

    const line = fakeSql();
    await new QualityEntryRepository({ goldDb: line.goldDb }).findTargetByReport(LINE("day"), 7);
    expect(emitted(line, "NULL::integer AS product_id")).toBe(true);
  });

  // The SKU table is a DAY table, so its window is the day arm's exactly — which
  // is the whole reason ReportRef carries a subject beside the grain rather than
  // adding a fourth grain literal.
  it("gives the SKU arm a one-day span, like the line's day report", async () => {
    const sql = fakeSql();
    await new QualityEntryRepository({ goldDb: sql.goldDb }).findTargetByReport(SKU, 79);

    expect(emitted(sql, "interval '1 day'")).toBe(true);
    expect(emitted(sql, "interval '1 month'")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `scoped` — the one predicate every ledger read shares
// ---------------------------------------------------------------------------
describe("QualityEntryRepository — the ledger's scope", () => {
  // OMITTED, NOT WRITTEN AS A NULL COMPARISON. A line's ledger is the whole
  // line's; an `IS NOT DISTINCT FROM NULL` would narrow it to the rows with no
  // product, which — since the create dto requires one — is none of them, and the
  // card would render an empty ledger beside a populated tile.
  it("adds no product predicate at line grain", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.listForTarget(target({ shift: 1 }), false);

    expect(emitted(sql, "AND product_id =")).toBe(false);
  });

  it("narrows to one product on a SKU report, as a bound parameter", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.listForTarget(target({ productId: 7 }), false);

    expect(emitted(sql, "AND product_id = ?")).toBe(true);
    expect(bound(sql)).toContain(7);
  });

  // The ledger and its totals must never be computed over different rows, which is
  // why they share one fragment. Asserted rather than assumed, because the symptom
  // of a drift is a "+140 BAG entered" line that does not match the entries the
  // sheet lists.
  it("uses the same scope for the ledger and its totals", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });
    const key = target({ productId: 7 });

    await repo.listForTarget(key, false);
    await repo.totalsForTarget(key);

    const scoped = sql.findAll(SCOPED);
    expect(scoped).toHaveLength(2);
    expect(scoped[0]?.text).toBe(scoped[1]?.text);
    expect(scoped[0]?.params).toEqual(scoped[1]?.params);
  });
});

// ---------------------------------------------------------------------------
// listActivityForTarget — the feed's arm, over a range
// ---------------------------------------------------------------------------
//
// The feed answers "what happened", not "what counts". A void IS an event, and a
// feed that hid it would show the 500 and not the retraction — the one thing an
// audit trail exists to prevent. So this arm takes no flag and must never emit the
// live-only filter, whatever the ledger beside it does.
describe("QualityEntryRepository.listActivityForTarget", () => {
  it("includes voided rows, always", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.listActivityForTarget(target({ productId: 7 }));

    expect(sql.find(LEDGER)?.text).not.toContain("voided_at IS NULL");
  });

  it("carries the product narrowing into the feed", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.listActivityForTarget(target({ productId: 7 }));

    expect(emitted(sql, "AND product_id = ?")).toBe(true);
    expect(bound(sql)).toContain(7);
  });

  // listActivity is this method with the range collapsed and a shift named, which
  // is what keeps ONE statement of "what the feed shows". Pinned so the shift-only
  // arm cannot drift into excluding voids while the range arm includes them.
  it("is what the shift-keyed listActivity delegates to", async () => {
    const sql = fakeSql();
    const repo = new QualityEntryRepository({ goldDb: sql.goldDb });

    await repo.listActivity(3, "2026-08-19", 2);

    expect(sql.find(LEDGER)?.text).not.toContain("voided_at IS NULL");
    // One day, twice, with the shift narrowing it — the inclusive arm of `scoped`.
    expect(emitted(sql, "AND shift = ?")).toBe(true);
    expect(bound(sql)).toContain(2);
    expect(sql.find(SCOPED)?.params).toContain("2026-08-19");
  });
});
