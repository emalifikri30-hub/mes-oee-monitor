import { describe, expect, it } from "vite-plus/test";

import { ProductReportReaderRepository } from "./product-report-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { ProductWindow } from "./product-report.js";

// The fakeSql harness, per the convention each repository test file follows. It
// matches SQL TEXT and never executes it: a projection naming a column that does
// not exist, an arithmetic error or a three-valued-logic surprise all pass here.
// Those belong to product-report-repository.integration.test.ts. What THIS suite
// pins is SHAPE — which table, which predicate, which parameter — and the shape
// is where this module's two subject-confusion hazards live.
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
const PRODUCT_PRED = /AND r\.product_id = \?/;
const J_PRODUCT_PRED = /AND j\.product_id = \?/;
const PAGE = /LIMIT/;
const COUNT = /count\(r\.id\)/;
const DETAIL = /WHERE r\.id = \?/;
const UNATTRIBUTED = /count\(\*\)::int AS unattributed/;

function window(overrides: Partial<ProductWindow> = {}): ProductWindow {
  return {
    workCenterId: 3,
    dateFrom: "2026-08-19",
    dateTo: "2026-08-20",
    shift: null,
    timeZone: "Asia/Jakarta",
    productId: 1,
    ...overrides,
  };
}

function filter(overrides: Record<string, unknown> = {}) {
  return {
    month: undefined,
    year: undefined,
    workCenterId: undefined,
    areaId: undefined,
    productId: undefined,
    isHideZero: false,
    ...overrides,
  } as never;
}

describe("ProductReportReaderRepository.paginateReport", () => {
  function run(over: Record<string, unknown> = {}) {
    const { goldDb, find, findAll } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });
    const promise = repo.paginateReport({ limit: 20, offset: 0, filter: filter(over) });
    return { find, findAll, promise };
  }

  // THE SIX-SEQUENCES HAZARD, ONE TABLE FURTHER ON. There are now SEVEN report
  // tables with seven independent identity sequences. A list that read
  // work_center_day_reports would return real rows, with real ids, four real
  // rates and a populated Line column — and every one of them about a LINE rather
  // than a SKU. A test asserting "rows come back" passes against the wrong table,
  // so assert the table.
  it("reads oee.product_report_wc_day and no other report table", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(PAGE)!.text).toMatch(/FROM oee\.product_report_wc_day r/);
    expect(find(PAGE)!.text).not.toMatch(/work_center_day_reports|work_unit_day_reports/);
  });

  it("binds the product filter when one is given", async () => {
    const { find, promise } = run({ productId: 7 });
    await promise;

    expect(find(PRODUCT_PRED)!.params).toEqual([7]);
  });

  // An absent filter must add no predicate at all, not `product_id = NULL` — which
  // is NULL rather than false and would return an empty page for every caller.
  it("adds no product predicate when the filter is absent", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(PRODUCT_PRED)).toBeUndefined();
  });

  // THE AREA FILTER — the header picker, which narrows this list the same way it
  // narrows the machine and line ones. `0023` put `area_id` on this table from
  // the start, so it needed a predicate and no column.
  it("binds the area filter when one is given", async () => {
    const { find, promise } = run({ areaId: 4 });
    await promise;

    expect(find(/area_id = \?/)!.params).toEqual([4]);
  });

  // Same rule as the product filter one line up: an absent filter adds NO
  // predicate. `area_id = NULL` is NULL rather than false and would empty the
  // page for every caller that omitted it.
  it("adds no area predicate when the filter is absent", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(/area_id/)).toBeUndefined();
  });

  // THE TWO AXES STACK, and this is the one list where that is worth pinning.
  // `areaId` is CONTAINMENT and `productId` is OCCUPANCY OVER TIME (migration
  // 0020's distinction), so "SKU A, in Filling 2" is a question with one answer
  // and neither filter subsumes the other.
  it("applies the area and the product filters together", async () => {
    const { find, promise } = run({ areaId: 4, productId: 7 });
    await promise;

    expect(find(/area_id = \?/)!.params).toEqual([4]);
    expect(find(PRODUCT_PRED)!.params).toEqual([7]);
  });

  // The page and the count must be filtered identically or the pager reports a
  // total the table cannot show.
  // THE STRONGEST FORM THIS ASSERTION CAN TAKE. The predicates are built once and
  // interpolated into both statements, so the page and the count carry THE SAME
  // FRAGMENT OBJECTS — identity, not just equal text. Two separately-built
  // predicate sets could read identically today and drift tomorrow; the same
  // object cannot. The page's trailing two params are LIMIT and OFFSET, which the
  // count has no use for.
  it("filters the page and the count with the very same fragments", async () => {
    const { find, promise } = run({ productId: 7, workCenterId: 3, areaId: 4, isHideZero: true });
    await promise;

    const page = find(PAGE)!.params;
    expect(find(COUNT)!.params).toEqual(page.slice(0, page.length - 2));
    expect(page.slice(page.length - 2)).toEqual([20, 0]);
  });

  // The id tiebreak is what makes paging stable — without it a row can appear on
  // two pages and another on none, which no "rows appear" assertion would catch.
  it("orders by date, then SKU, then line, then id", async () => {
    const { find, promise } = run();
    await promise;

    expect(find(PAGE)!.text).toMatch(
      /ORDER BY r\.business_date DESC, r\.product_name ASC, r\.work_center_id ASC, r\.id ASC/,
    );
  });
});

describe("ProductReportReaderRepository.getReport", () => {
  it("reads the SKU table by id", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.getReport(42);

    expect(find(DETAIL)!.text).toMatch(/FROM oee\.product_report_wc_day r/);
    expect(find(DETAIL)!.params).toContain(42);
  });

  // `grain` is stamped by the query rather than stored. The browser's report union
  // discriminates on it, so a payload without it would need a second stamping site
  // — and two sites for one discriminant is how they come to disagree.
  it("stamps the grain, which the table does not store", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.getReport(42);

    expect(find(DETAIL)!.text).toMatch(/'day'::text AS grain/);
  });

  // Coalescing a nullable measure would turn "not known" into a measurement of
  // zero. At this grain a NULL unit means exactly that — 0014's "the members
  // disagreed" has no analogue, because a SKU report has no members.
  it("coalesces nothing", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.getReport(42);

    expect(find(DETAIL)!.text).not.toMatch(/coalesce/i);
  });
});

describe("ProductReportReaderRepository — the SKU predicate on the loss aggregates", () => {
  it("narrows the reject rows to one product, on the LINE's reject table", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.aggregateRejectReasons(window({ productId: 9 }));

    expect(find(J_PRODUCT_PRED)!.params).toEqual([9]);
    // The LINE's reject table. The machine one is wrong here for the reason 0019
    // exists: reading it scoped by work_center_id is a machine-SUM, which the
    // Losses card's own Reject tile would then contradict two cards above it.
    expect(find(/^oee\.reject_count_wc_shift$/)).toBeDefined();
    expect(find(/reject_count_wu_shift/)).toBeUndefined();
  });

  it("narrows the downtime events to one product", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.aggregateDowntimeEventReasons(window({ productId: 9 }));

    expect(find(J_PRODUCT_PRED)!.params).toEqual([9]);
    expect(find(/^oee\.downtime_log_events$/)).toBeDefined();
  });
});

// THE ONE THAT WOULD RETURN 0 FOREVER AND LOOK RIGHT.
//
// Every other read in this module scopes by `product_id = $`. If the unattributed
// count did the same — or rode as a `FILTER (WHERE product_id IS NULL)` on one of
// those aggregates — the rows it exists to count would already be gone, and it
// would answer 0 for every window in every state of the pipeline. The banner would
// never appear, including when every stop on the line is unattributed, which is
// the live state today.
describe("ProductReportReaderRepository.countUnattributedDowntime", () => {
  it("counts rows the product predicate has NOT been applied to", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.countUnattributedDowntime(window({ productId: 9 }));

    const q = find(UNATTRIBUTED)!;
    expect(q.text).toMatch(/j\.product_id IS NULL/);
    // No product predicate is BUILT AT ALL for this read — not built and then
    // left out, which a text assertion on the outer statement could not tell
    // apart, since an interpolated fragment shows there only as `?`.
    expect(find(J_PRODUCT_PRED)).toBeUndefined();
    expect(q.params).not.toContain(9);
  });

  it("still scopes to the line and the window", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.countUnattributedDowntime(window({ workCenterId: 3 }));

    const q = find(UNATTRIBUTED)!;
    expect(q.text).toMatch(/j\.work_center_id = \?/);
    expect(q.params).toContain(3);

    // The window is the shared inDateRange fragment, recorded as its own call.
    // HALF-OPEN — `>= from AND < to`. A BETWEEN here would count the next day's
    // first stops against this report.
    const range = find(/>= \? ::date AND \? < \? ::date/)!;
    expect(range.params).toContain("2026-08-19");
    expect(range.params).toContain("2026-08-20");
  });

  // oee.downtime_reports, not downtime_log_events: that is the table the timeline,
  // the downtime table and the Availability Pareto all read. Counting the other
  // one would report a number against the wrong card.
  it("counts the stop table, not the event-log table", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.countUnattributedDowntime(window());

    expect(find(UNATTRIBUTED)!.text).toMatch(/FROM oee\.downtime_reports j/);
  });
});

// ---------------------------------------------------------------------------
// listDowntimeEdits — the activity feed's downtime arm
// ---------------------------------------------------------------------------
describe("ProductReportReaderRepository.listDowntimeEdits", () => {
  it("narrows the members to this SKU's stops on this line and day", async () => {
    const { goldDb, find, findAll } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window({ workCenterId: 3, productId: 7 }));

    // scopedRows records its own call, with the line and the alias `j`.
    const scoped = findAll(/FROM \? j WHERE j\.work_center_id = \?/);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped[0]?.params).toContain(3);

    const pred = find(J_PRODUCT_PRED)!;
    expect(pred.params).toContain(7);
  });

  // THE TWO STATEMENTS DIFFER BY EXACTLY THIS PREDICATE, and that is the whole
  // count(*)-not-count(column) distinction: a stop with no stable id belongs in
  // `total` and not in `tracked`, so the counts must be taken over the rows the
  // trail filter has NOT been applied to.
  it("filters the trail's members by source_event_id and the counts' members not at all", async () => {
    const { goldDb, findAll } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window({ productId: 7 }));

    const preds = findAll(J_PRODUCT_PRED);
    expect(preds).toHaveLength(2);
    expect(preds.filter((p) => /source_event_id IS NOT NULL/.test(p.text))).toHaveLength(1);
  });

  it("counts every member and only the trackable half separately", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window({ productId: 7 }));

    const counts = find(/count\(\*\)::int AS total/)!;
    expect(counts.text).toMatch(/count\(m\.source_event_id\)::int AS tracked/);
  });

  it("reads the history table and joins it to the members", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window({ productId: 7 }));

    const trail = find(/FROM oee\.downtime_report_history h/)!;
    expect(trail.text).toMatch(/JOIN members m ON m\.source_event_id = h\.source_event_id/);
    // Newest first, with the id breaking a tie rather than leaving one.
    expect(trail.text).toMatch(/ORDER BY h\.changed_at DESC, h\.id DESC/);
  });

  // SCOPED BY business_date, NOT by an instant range — consistent with
  // countUnattributedDowntime, which travels beside these counts in one response.
  // Two definitions of "this SKU's day" in one payload is how a feed comes to list
  // an edit the residual count did not know about, on a screen showing both.
  it("scopes by the business date, half-open, like its sibling in the same payload", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listDowntimeEdits(window({ productId: 7 }));

    const range = find(/>= \? ::date AND \? < \? ::date/)!;
    expect(range.params).toContain("2026-08-19");
    expect(range.params).toContain("2026-08-20");
  });
});

// ---------------------------------------------------------------------------
// listMachineRoster — the reject dialog's provenance picker
// ---------------------------------------------------------------------------
describe("ProductReportReaderRepository.listMachineRoster", () => {
  const INSTANTS = {
    from: new Date("2026-08-19T00:00:00.000Z"),
    to: new Date("2026-08-20T00:00:00.000Z"),
  };

  // ON `date`, NOT `business_date`, and this is the opposite call from
  // listDowntimeEdits above. oee.work_unit_shift_reports.business_date is nullable
  // and unbackfilled (§46), so a date predicate would return an empty roster and
  // the picker would offer nothing — which reads as a line with no machines.
  it("scopes on the shift's start instant, half-open, never on business_date", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listMachineRoster(INSTANTS, 3);

    const q = find(/FROM oee\.work_unit_shift_reports r/)!;
    expect(q.text).toMatch(/r\.date >= \?/);
    expect(q.text).toMatch(/r\.date < \?/);
    expect(q.text).not.toMatch(/business_date/);
    expect(q.params).toContain(INSTANTS.from);
    expect(q.params).toContain(INSTANTS.to);
  });

  // ZERO UPSTREAM CALLS: work_center_id has been NOT NULL on this table since
  // 0003, and it records the line the pipeline attributed a machine's numbers TO —
  // where a master-data roster is the line's membership NOW.
  it("resolves the roster from the report table's own work_center_id", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listMachineRoster(INSTANTS, 3);

    const q = find(/FROM oee\.work_unit_shift_reports r/)!;
    expect(q.text).toMatch(/r\.work_center_id = \?/);
    expect(q.params).toContain(3);
  });

  // NOT NARROWED BY PRODUCT. A machine either ran on this line that day or it did
  // not; the table has no product dimension, and the operator is naming where they
  // SAW the rejects, which is a fact about the shift rather than about the SKU.
  it("does not narrow the roster by product", async () => {
    const { goldDb, find, calls } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listMachineRoster(INSTANTS, 3);

    expect(find(/FROM oee\.work_unit_shift_reports r/)!.text).not.toMatch(/product_id/);
    expect(calls.flatMap((c) => c.params)).not.toContain(7);
  });

  // One row per machine, however many shifts it reported: this list is a picker,
  // and three "Vertical Packer" options are three ways to pick one thing.
  it("returns each machine once", async () => {
    const { goldDb, find } = fakeSql();
    const repo = new ProductReportReaderRepository({ goldDb });

    await repo.listMachineRoster(INSTANTS, 3);

    expect(find(/FROM oee\.work_unit_shift_reports r/)!.text).toMatch(/SELECT DISTINCT/);
  });
});
