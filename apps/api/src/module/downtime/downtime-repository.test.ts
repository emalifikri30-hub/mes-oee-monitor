import { describe, it, expect } from "vite-plus/test";

import {
  diffEdit,
  DowntimeReaderRepository,
  DowntimeWriterRepository,
  toStringList,
} from "./downtime-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { DowntimeEdit } from "./downtime.js";

// Same stand-in for the postgres.js client as work-unit-repository.test.ts: the
// client is callable as a tagged template (a query) and as a plain function (the
// identifier / column helper), and only a TemplateStringsArray carries `.raw`.
//
// Queries are answered by the first route whose pattern matches the normalised
// SQL text, so a test states what a query returns rather than depending on the
// order the repository happens to issue them in.
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

  const find = (pattern: RegExp) => calls.find((c) => pattern.test(c.text));

  return { goldDb: sql as unknown as GoldDB, calls, columns, find };
}

const WINDOW_QUERY = /AT TIME ZONE/;
const EVENTS_QUERY = /FROM oee\.downtime_reports/;
// The shared scope + window predicate, nested into all three readers as its own
// tagged-template call.
//
// This used to match on `make_interval`, which was the `date` narrowing's own
// text — so when TODOS.md §10/§69 removed the narrowing, every assertion using
// this constant failed by finding NOTHING rather than by finding the wrong
// thing. Now keyed on the range overlap, which is what the fragment is FOR
// rather than an incidental detail of how it was once optimised.
const WHERE_FRAGMENT = /&& tstzrange/;

const WINDOW = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-09T08:00:00.000Z"),
};

// Past the window's end, i.e. a shift that has already closed — so LEAST picks
// `to` and an open stop clips there. The live-shift case, where `now` is inside
// the window and wins, is exercised against real SQL in the integration suite.
const NOW = new Date("2026-08-09T12:00:00.000Z");

function windowRoute() {
  return { match: WINDOW_QUERY, rows: [WINDOW] };
}

describe("DowntimeReaderRepository.getWindow", () => {
  // T-W1 / T-W2 / T-W3. The wall-clock times themselves live in SHIFT_WINDOWS;
  // what matters here is that the repository binds them, and the day offset,
  // in the order the SQL expects.
  it.each([
    ["1", "07:00", 0, "15:00"],
    ["2", "15:00", 0, "23:00"],
    ["3", "23:00", 1, "07:00"],
  ] as const)("T-W: binds shift %s as %s -> +%id %s", async (shift, start, offset, end) => {
    const { goldDb, find } = fakeSql([windowRoute()]);
    const repo = new DowntimeReaderRepository({ goldDb });

    const out = await repo.getWindow("shift", "2026-08-09", shift, "Asia/Jakarta");

    expect(out).toEqual(WINDOW);
    expect(find(WINDOW_QUERY)?.params).toEqual([
      "2026-08-09",
      start,
      "Asia/Jakarta",
      "2026-08-09",
      offset,
      end,
      "Asia/Jakarta",
    ]);
  });

  // Shift 3 is the only window whose end lands on the next calendar day; a zero
  // offset here would silently produce a negative 16-hour window.
  it("T-W3: gives shift 3 a next-day end", async () => {
    const { goldDb, find } = fakeSql([windowRoute()]);
    const repo = new DowntimeReaderRepository({ goldDb });

    await repo.getWindow("shift", "2026-08-09", "3", "Asia/Jakarta");

    expect(find(WINDOW_QUERY)?.params).toContain(1);
  });

  it("throws rather than returning an undefined window", async () => {
    const { goldDb } = fakeSql([]); // no route -> no rows
    const repo = new DowntimeReaderRepository({ goldDb });

    await expect(repo.getWindow("shift", "2026-08-09", "1", "Asia/Jakarta")).rejects.toThrow(
      /could not resolve window/,
    );
  });
});

describe("DowntimeReaderRepository.listOverlapping", () => {
  function run(scope: "work-unit" | "work-center", scopeId = 42, productId?: number) {
    const rows = [
      {
        id: 1,
        category: "UNPLANNED",
        startAt: new Date("2026-08-09T01:00:00.000Z"),
        endAt: null,
      },
    ];
    const fake = fakeSql([{ match: EVENTS_QUERY, rows }]);
    const repo = new DowntimeReaderRepository({ goldDb: fake.goldDb });

    return {
      ...fake,
      rows,
      promise: repo.listOverlapping({ scope, scopeId, window: WINDOW, productId }),
    };
  }

  it("T-R1: filters work-unit scope on work_unit_id", async () => {
    const { columns, promise } = run("work-unit");
    await promise;

    expect(columns).toEqual(["work_unit_id"]);
  });

  it("T-R2: filters work-center scope on work_center_id", async () => {
    const { columns, promise } = run("work-center");
    await promise;

    expect(columns).toEqual(["work_center_id"]);
  });

  it("returns the rows as a plain array", async () => {
    const { rows, promise } = run("work-unit");

    expect(await promise).toEqual(rows);
  });

  // The scope + window predicate is a nested fragment shared with
  // paginateDowntime, so it is a tagged-template call of its own rather than
  // part of the SELECT's text. Asserting on the fragment is what proves both
  // readers filter identically.
  it("delegates its predicate to the shared scope+window fragment", async () => {
    const { find, promise } = run("work-unit");
    await promise;

    expect(find(WHERE_FRAGMENT)).toBeDefined();
    expect(find(EVENTS_QUERY)!.text).toMatch(/WHERE \?/);
  });

  // T-R3 USED TO ASSERT THE OPPOSITE. It pinned a `date` narrowing bounded by
  // MAX_OPEN_DOWNTIME_DAYS, which is exactly the silent seven-day horizon
  // TODOS.md §10 and §69 removed on 2026-09-02. It now pins the horizon's
  // ABSENCE, because re-adding it is the regression that costs nothing at review
  // time and drops three-week-old open stops in production.
  it("T-R3: carries no `date` narrowing, so there is no lookback horizon", async () => {
    const { find, promise } = run("work-unit");
    await promise;

    const call = find(WHERE_FRAGMENT)!;
    expect(call.text).not.toMatch(/\bdate\b/);
    expect(call.text).not.toMatch(/make_interval/);
    // The horizon used to ride in as a bound parameter. Nothing should bind 7.
    expect(call.params).not.toContain(7);
  });

  // The expression must match dt_reports_span_gist (migration 0013) CHARACTER
  // FOR CHARACTER or the planner silently falls back to a sequential scan —
  // nothing errors, the page just degrades as the table grows. This asserts the
  // text; the integration suite asserts the plan.
  it("T-R4: overlaps via the range expression the GiST index is built on", async () => {
    const { find, promise } = run("work-unit");
    await promise;

    const call = find(WHERE_FRAGMENT)!;
    expect(call.text).toMatch(
      /tstzrange\(start_at, greatest\(coalesce\(end_at, 'infinity'::timestamptz\), start_at\), '\[\)'\)/,
    );
    expect(call.text).toMatch(/&& tstzrange\(\s*\?\s*,\s*\?\s*, '\[\)'\)/);
    // The regression this has always guarded, unchanged by the rewrite: a
    // `start_at >= from` lower bound drops a stop that began before the shift and
    // is still running — exactly what the strip must render clipped.
    expect(call.text).not.toMatch(/start_at >=/);
  });

  it("binds the scope and the two window bounds, and nothing else", async () => {
    const { find, promise } = run("work-unit", 99);
    await promise;

    // Four VALUES, where there used to be seven: the window is named once on each
    // side of the `&&` instead of three times across two predicates. The trailing
    // entry is the product predicate's fragment, EMPTY here — see the test below.
    const params = find(WHERE_FRAGMENT)!.params;
    expect(params.slice(0, 4)).toEqual([{ fragment: "work_unit_id" }, 99, WINDOW.from, WINDOW.to]);
  });

  // THE SKU FILTER, AND ITS ABSENCE IS THE CASE THAT MATTERS MOST.
  //
  // Every shipped caller of this endpoint sends no productId and must keep seeing
  // exactly what it saw before the column existed. A predicate built as
  // `product_id = NULL` would be NULL rather than false and return nothing — an
  // empty timeline on every machine and line screen at once, with no error.
  it("adds no product predicate when none is asked for", async () => {
    const { find, promise } = run("work-unit", 99);
    await promise;

    expect(find(/product_id/)).toBeUndefined();
  });

  it("narrows to one SKU when one is asked for", async () => {
    const { find, promise } = run("work-unit", 99, 7);
    await promise;

    // Its own call, because an interpolated fragment is recorded separately and
    // shows in the outer statement only as `?`.
    expect(find(/AND product_id = \?/)!.params).toEqual([7]);
  });
});

const PAGE = /LIMIT/;
const COUNT = /count\(id\)/;

describe("DowntimeReaderRepository.paginateDowntime", () => {
  const ROW = {
    id: 3,
    category: "SMALL_STOP",
    reason: ["A1_Filling_Servo_OL"],
    actions: [],
    workUnitName: "Molca Packer N",
    startAt: new Date("2026-08-09T07:23:00.000Z"),
    endAt: new Date("2026-08-09T07:23:25.000Z"),
    durationMs: 25_000,
  };

  function paginate(
    overrides: Partial<Parameters<DowntimeReaderRepository["paginateDowntime"]>[0]> = {},
  ) {
    // COUNT is listed first: routes match in order, and both queries read the
    // same table, so the page pattern would otherwise swallow the count.
    const fake = fakeSql([
      { match: COUNT, rows: [{ value: 50 }] },
      { match: PAGE, rows: [ROW] },
    ]);
    const repo = new DowntimeReaderRepository({ goldDb: fake.goldDb });

    return {
      ...fake,
      promise: repo.paginateDowntime({
        scope: "work-unit",
        scopeId: 42,
        window: WINDOW,
        limit: 5,
        offset: 0,
        sortBy: "startAt",
        sortDir: "desc",
        ...overrides,
      }),
    };
  }

  it("returns the page and the total, which is the card's Downtime Frequency", async () => {
    const { promise } = paginate();

    const out = await promise;

    expect(out.items).toEqual([ROW]);
    expect(out.totalElements).toBe(50);
  });

  it("forwards limit and offset", async () => {
    const { find, promise } = paginate({ limit: 5, offset: 10 });
    await promise;

    const params = find(PAGE)!.params;
    expect(params.slice(-2)).toEqual([5, 10]);
  });

  // The stored `duration` column can disagree with start_at / end_at, and this
  // table renders directly beneath a strip drawn from those timestamps.
  it("derives the duration from the timestamps and never reads the duration column", async () => {
    const { find, promise } = paginate();
    await promise;

    const text = find(PAGE)!.text;
    expect(text).toMatch(
      /extract\(epoch from \(end_at - start_at\)\) \* 1000\)::float8 AS duration_ms/,
    );
    // `\b` does not match inside `duration_ms`, so this asserts the bare column
    // is absent rather than merely unaliased.
    expect(text).not.toMatch(/\bduration\b/);
  });

  it("shares the scope + window predicate with listOverlapping", async () => {
    const { find, promise } = paginate();
    await promise;

    const fragment = find(WHERE_FRAGMENT)!;
    expect(fragment.text).toMatch(
      /tstzrange\(start_at, greatest\(coalesce\(end_at, 'infinity'::timestamptz\), start_at\), '\[\)'\)\s*&& tstzrange/,
    );
    expect(fragment.text).not.toMatch(/start_at >=/);
    // Same absence as T-R3: no horizon here either, or this reader and the strip
    // above it would disagree about a long-open stop.
    expect(fragment.text).not.toMatch(/make_interval/);
  });

  it.each([
    ["category", "asc", /category/, /ASC/],
    ["category", "desc", /category/, /DESC/],
    ["startAt", "asc", /start_at/, /ASC/],
    ["startAt", "desc", /start_at/, /DESC/],
    ["duration", "asc", /\(end_at - start_at\)/, /ASC/],
    ["duration", "desc", /\(end_at - start_at\)/, /DESC/],
  ] as const)(
    "sorts by %s %s through the allowlist",
    async (sortBy, sortDir, column, direction) => {
      const { find, calls, promise } = paginate({ sortBy, sortDir });
      await promise;

      const order = find(/NULLS LAST/)!;
      expect(order.text).toMatch(/NULLS LAST, id ASC/);
      // The column and direction arrive as nested fragments, recorded as their own
      // calls — asserting on those is what proves nothing was interpolated raw.
      expect(calls.some((c) => column.test(c.text))).toBe(true);
      expect(calls.some((c) => direction.test(c.text))).toBe(true);
    },
  );

  // Without the id tiebreaker, rows sharing a start time can reappear on two
  // pages — the mockup has two records at 14:15, so this is not hypothetical.
  it("breaks ties on id so paging is stable", async () => {
    const { find, promise } = paginate();
    await promise;

    expect(find(/NULLS LAST/)!.text).toMatch(/id ASC/);
  });

  it("normalises reason and actions coming back from jsonb[]", async () => {
    const fake = fakeSql([
      { match: COUNT, rows: [{ value: 1 }] },
      {
        match: PAGE,
        rows: [{ ...ROW, reason: ["ok", 42, null, ""], actions: null }],
      },
    ]);
    const repo = new DowntimeReaderRepository({ goldDb: fake.goldDb });

    const out = await repo.paginateDowntime({
      scope: "work-unit",
      scopeId: 1,
      window: WINDOW,
      limit: 5,
      offset: 0,
      sortBy: "startAt",
      sortDir: "desc",
    });

    expect(out.items[0]!.reason).toEqual(["ok"]);
    expect(out.items[0]!.actions).toEqual([]);
  });
});

describe("toStringList", () => {
  it("keeps only non-empty strings", () => {
    expect(toStringList(["a", "", "b"])).toEqual(["a", "b"]);
  });

  // A malformed element must not reach the browser and render as
  // "[object Object]".
  it.each([null, undefined, "not-an-array", 7, {}])("returns [] for %s", (input) => {
    expect(toStringList(input)).toEqual([]);
  });

  it("drops non-string elements rather than coercing them", () => {
    expect(toStringList([{ name: "x" }, 1, "keep"])).toEqual(["keep"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregateByReason — the Availability Loss breakdown
//
// These assert SQL TEXT and bound parameters, which is all `fakeSql` can see.
// The ARITHMETIC — that the clip yields milliseconds, that the bounds are on the
// right sides of LEAST/GREATEST, that shift 3 does not invert — is asserted
// against a real Postgres in downtime-repository.integration.test.ts. Neither
// suite subsumes the other: this one pins shape (no `duration` column, no
// jsonb_array_elements) which result assertions cannot see, and that one pins
// values which a regex cannot.
// ─────────────────────────────────────────────────────────────────────────────

// The clipped row set is now assembled from two EXTRACTED Fragments — the
// drill-down composes the same two — and postgres.js records a nested Fragment
// as its own call. So the three patterns below address three separate recorded
// statements, not one:
//
//   CLIP          the outer SELECT: scope, category, and the aliases
//   REASON_KEY    the primary-reason expression, shared with the reason filter
//   CLIP_DURATION the LEAST/GREATEST arithmetic, shared with paginateByReason
//
// Splitting them is what lets a test say "the drill-down clips identically"
// rather than "the drill-down also contains a LEAST somewhere".
const CLIP = /AS reason_key/;
const REASON_KEY = /jsonb_typeof\(reason -> 0\)/;
const CLIP_DURATION = /LEAST\(coalesce\(end_at/;
const BUCKETS = /GROUP BY reason_key/;
// Listed before BUCKETS in every route array below: both statements inline the
// same CTE text, so the buckets pattern would otherwise swallow the totals.
const TOTALS = /total_frequency/;
const WATERMARK = /etl_watermarks/;

// ─────────────────────────────────────────────────────────────────────────────
// aggregateByAction — Pareto Actions, on the OEE Performance dashboard
//
// Two things separate it from its twin below, and both are decisions rather than
// omissions, so both are pinned here: it groups on the first ACTION, and it takes
// NO category.
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_KEY = /jsonb_typeof\(actions -> 0\)/;

describe("DowntimeReaderRepository.aggregateByAction", () => {
  const BUCKET_ROW = {
    reason: "Replace Belt",
    workUnitNames: ["Molca Packer N"],
    frequency: 3,
    durationMs: 2_844_000,
  };
  const TOTALS_ROW = { totalFrequency: 5, totalDurationMs: 3_826_000, dropped: 0, groupCount: 2 };

  function aggregate(
    overrides: Partial<Parameters<DowntimeReaderRepository["aggregateByAction"]>[0]> = {},
  ) {
    const fake = fakeSql([
      { match: TOTALS, rows: [TOTALS_ROW] },
      { match: BUCKETS, rows: [BUCKET_ROW] },
    ]);
    const repo = new DowntimeReaderRepository({ goldDb: fake.goldDb });

    return {
      ...fake,
      promise: repo.aggregateByAction({
        scope: "work-unit",
        scopeId: 42,
        window: WINDOW,
        now: NOW,
        measure: "duration" as const,
        limit: 20,
        ...overrides,
      }),
    };
  }

  // THE FIRST ACTION AND NOTHING ELSE. Crediting every action on a stop its whole
  // duration would make the bars sum to more than the window's downtime, and a
  // Pareto's cumulative line is a SHARE — past 100% it stops meaning anything.
  it("groups on the first ACTION, never on the reason", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(ACTION_KEY)).toBeDefined();
    expect(find(REASON_KEY)).toBeUndefined();
  });

  // NO jsonb_array_elements ANYWHERE. Its appearance would mean somebody had
  // "fixed" the under-counting by exploding the array, which silently breaks the
  // cumulative line rather than failing.
  it("does not explode the actions array", async () => {
    const { calls, promise } = aggregate();
    await promise;

    for (const call of calls) {
      expect(call.text).not.toMatch(/jsonb_array_elements/);
    }
  });

  // An action is not an operation type: the same action is taken on planned and
  // unplanned stops alike, and filtering by one would scatter it across charts.
  it("applies NO category predicate", async () => {
    const { calls, promise } = aggregate();
    await promise;

    for (const call of calls) {
      expect(call.text).not.toMatch(/oee\.operation_type/);
    }
  });

  // The same clip as the reason breakdown, so the two Paretos on one screen are
  // computed over the same rows.
  it("clips each row to the window rather than summing whole stops", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(CLIP_DURATION)!.text).toMatch(/LEAST\(coalesce\(end_at,\s*\?\s*\),\s*\?\s*\)/);
  });

  it("drops empty and inverted rows from the buckets and counts them", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(BUCKETS)!.text).toMatch(/WHERE duration_ms > 0/);
    expect(find(TOTALS)!.text).toMatch(/count\(\*\) FILTER \(WHERE duration_ms <= 0\)/);
  });

  // `reasonOrder` is a nested Fragment, so it is recorded as its own call rather
  // than inlined — the same reason the predicate assertions above address the
  // fragment's call and not the statement that embeds it.
  it("ranks by the requested measure and truncates to the limit", async () => {
    const { find, promise } = aggregate({ measure: "frequency" });
    await promise;

    expect(find(/ORDER BY count\(\*\) DESC/)).toBeDefined();
    expect(find(BUCKETS)!.text).toMatch(/LIMIT/);
  });

  it("returns the aggregate in the same shape the reason breakdown does", async () => {
    const { promise } = aggregate();

    await expect(promise).resolves.toEqual({
      buckets: [BUCKET_ROW],
      totalFrequency: 5,
      totalDurationMs: 3_826_000,
      dropped: 0,
      groupCount: 2,
    });
  });
});

describe("DowntimeReaderRepository.aggregateByReason", () => {
  const BUCKET_ROW = {
    reason: "Mlipit",
    workUnitNames: ["Molca Packer N"],
    frequency: 3,
    durationMs: 2_844_000,
  };

  const TOTALS_ROW = { totalFrequency: 5, totalDurationMs: 3_826_000, dropped: 0 };

  function aggregate(
    overrides: Partial<Parameters<DowntimeReaderRepository["aggregateByReason"]>[0]> = {},
    rows: { buckets?: unknown[]; totals?: unknown[] } = {},
  ) {
    const fake = fakeSql([
      { match: TOTALS, rows: rows.totals ?? [TOTALS_ROW] },
      { match: BUCKETS, rows: rows.buckets ?? [BUCKET_ROW] },
    ]);
    const repo = new DowntimeReaderRepository({ goldDb: fake.goldDb });

    return {
      ...fake,
      promise: repo.aggregateByReason({
        scope: "work-unit",
        scopeId: 42,
        window: WINDOW,
        category: "UNPLANNED",
        now: NOW,
        measure: "duration" as const,
        limit: 20,
        ...overrides,
      }),
    };
  }

  // The single most damaging possible bug here: a Pareto counting a different
  // set of records than the strip drawn directly above it on the same page.
  it("shares the scope + window predicate with the other two readers", async () => {
    const { find, promise } = aggregate();
    await promise;

    const fragment = find(WHERE_FRAGMENT)!;
    expect(fragment.text).toMatch(
      /tstzrange\(start_at, greatest\(coalesce\(end_at, 'infinity'::timestamptz\), start_at\), '\[\)'\)\s*&& tstzrange/,
    );
    expect(fragment.text).not.toMatch(/start_at >=/);
    // Same absence as T-R3: no horizon here either, or this reader and the strip
    // above it would disagree about a long-open stop.
    expect(fragment.text).not.toMatch(/make_interval/);
  });

  it("clips each row to the window rather than summing whole stops", async () => {
    const { find, promise } = aggregate();
    await promise;

    const clip = find(CLIP_DURATION)!;
    expect(clip.text).toMatch(/LEAST\(coalesce\(end_at,\s*\?\s*\),\s*\?\s*\)/);
    expect(clip.text).toMatch(/GREATEST\(start_at,\s*\?\s*\)/);
  });

  // Binding the window bounds to the wrong sides of the clip is arithmetically
  // silent and renders a plausible chart, so the ORDER is the assertion.
  it("binds now, window.to and window.from in the order the clip expects", async () => {
    const { find, promise } = aggregate();
    await promise;

    // The arithmetic is its own Fragment now, so its three bounds are the whole
    // of its parameter list — a tighter assertion than when they were embedded
    // among the outer SELECT's bindings.
    const { params } = find(CLIP_DURATION)!;
    expect(params).toEqual([NOW, WINDOW.to, WINDOW.from]);

    // The outer statement's own binding is the category. Every other slot it
    // holds is a nested Fragment — scope/window, the reason key, the duration
    // arithmetic and the (empty, for the un-narrowed breakdown) reason filter —
    // so filtering to the scalar bindings is what isolates it.
    const outer = find(CLIP)!.params.filter((param) => typeof param === "string");
    expect(outer).toEqual(["UNPLANNED"]);
  });

  // An open stop reaches `now`, not the end of a shift that has not happened
  // yet — matching clipToWindow. For a historical shift LEAST picks `to` anyway.
  it("clips an open stop at now rather than at the window end", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(CLIP_DURATION)!.text).toMatch(/coalesce\(end_at,\s*\?\s*\)/);
  });

  it("never reads the stored duration column", async () => {
    const { find, promise } = aggregate();
    await promise;

    // `\b` does not match inside `duration_ms`, so this asserts the bare column
    // is absent rather than merely unaliased. Both halves are checked: the
    // arithmetic could read it, and so could the outer projection.
    expect(find(CLIP)!.text).not.toMatch(/\bduration\b/);
    expect(find(CLIP_DURATION)!.text).not.toMatch(/\bduration\b/);
  });

  // Exploding the array would count one 40-minute stop under two reasons and
  // make the bars sum to more than the shift.
  it("groups on the primary reason only, never on every element", async () => {
    const { find, promise } = aggregate();
    await promise;

    const key = find(REASON_KEY)!;
    expect(key.text).toMatch(/jsonb_typeof\(reason -> 0\) = 'string'/);
    expect(key.text).toMatch(/reason ->> 0/);
    expect(key.text).not.toMatch(/jsonb_array_elements/);
  });

  it("folds empty and blank reasons into one null bucket", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(REASON_KEY)!.text).toMatch(/nullif\(\s*btrim\(/);
  });

  it("passes a null reason through as null rather than a label", async () => {
    const { promise } = aggregate({}, { buckets: [{ ...BUCKET_ROW, reason: null }] });

    const result = await promise;
    expect(result.buckets[0]?.reason).toBeNull();
  });

  // Availability loss must not absorb micro-stops, which are their own enum
  // value. The cast matters for the reason make_interval's ::int does.
  it.each(["UNPLANNED", "PLANNED", "SMALL_STOP"] as const)(
    "binds category %s against the enum type",
    async (category) => {
      const { find, promise } = aggregate({ category });
      await promise;

      const clip = find(CLIP)!;
      expect(clip.text).toMatch(/category = \?\s*::oee\.operation_type/);
      expect(clip.params).toContain(category);
    },
  );

  it("excludes empty and inverted clips from the buckets", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(BUCKETS)!.text).toMatch(/WHERE duration_ms > 0/);
  });

  it("counts empty and inverted clips rather than swallowing them", async () => {
    const { find, promise } = aggregate({}, { totals: [{ ...TOTALS_ROW, dropped: 2 }] });

    const result = await promise;
    expect(find(TOTALS)!.text).toMatch(/FILTER \(WHERE duration_ms <= 0\)/);
    expect(result.dropped).toBe(2);
  });

  // postgres.js returns bigint and numeric as STRINGS, and every field here is
  // typed as a number.
  it("casts the aggregates so they arrive as numbers", async () => {
    const { find, promise } = aggregate();
    await promise;

    expect(find(BUCKETS)!.text).toMatch(/count\(\*\)::int/);
    expect(find(BUCKETS)!.text).toMatch(/round\(sum\(duration_ms\)\)::float8/);
    expect(find(TOTALS)!.text).toMatch(/coalesce\(\s*round\(sum\(duration_ms\)/);
  });

  // sum() over an empty set is NULL, and a null denominator reaches the browser
  // as a divide-by-null on the cumulative line.
  it("returns zeroed totals rather than nulls when nothing matched", async () => {
    const { promise } = aggregate({}, { buckets: [], totals: [] });

    const result = await promise;
    expect(result).toEqual({
      buckets: [],
      // Zero GROUPS, which is what tells the service there is no tail to report —
      // `groupCount === buckets.length` is the whole test for that.
      groupCount: 0,
      totalFrequency: 0,
      totalDurationMs: 0,
      dropped: 0,
    });
  });

  // THE ORDER IS A FRAGMENT NOW, so it is recorded as its own call rather than
  // appearing inline in the page query's text — the same shape the FROM clause
  // takes in the work-center repository's tests.
  //
  // AND IT DECIDES WHAT THE CALLER SEES, not just the sequence it sees it in: the
  // LIMIT below it means the ordering picks which buckets survive. The tiebreak on
  // `reason_key` therefore matters more than it did — without it, two equal
  // buckets could swap places between identical requests and the TAIL'S MEMBERSHIP
  // would flicker.
  it.each([
    ["duration", "ORDER BY sum(duration_ms) DESC NULLS LAST, reason_key ASC NULLS LAST"],
    ["frequency", "ORDER BY count(*) DESC, reason_key ASC NULLS LAST"],
  ] as const)("ranks by %s, with the reason as a total-order tiebreak", async (measure, order) => {
    const { calls, promise } = aggregate({ measure });
    await promise;

    expect(calls.map((c) => c.text)).toContain(order);
  });

  it("applies the caller's limit to the bucket query", async () => {
    const { find, promise } = aggregate({ limit: 5 });
    await promise;

    expect(find(BUCKETS)!.text).toMatch(/LIMIT \?/);
    expect(find(BUCKETS)!.params).toContain(5);
  });

  // The totals query must NOT be limited — it is the denominator the cumulative
  // line divides by, and the count the tail is derived from. A LIMIT leaking into
  // it would make the bars sum to the total by construction and the "Other" bar
  // vanish, which is the truncation becoming invisible again.
  it("never limits the totals query", async () => {
    const { find, promise } = aggregate({ limit: 5 });
    await promise;

    expect(find(TOTALS)!.text).not.toMatch(/LIMIT/);
  });

  // The same guard toStringList gives `reason` and `actions`: a non-string
  // element must not reach the browser and render as "[object Object]".
  it("normalises the machine names, dropping anything that is not a string", async () => {
    const { promise } = aggregate(
      {},
      { buckets: [{ ...BUCKET_ROW, workUnitNames: ["Molca Packer N", 42, null, ""] }] },
    );

    const result = await promise;
    expect(result.buckets[0]?.workUnitNames).toEqual(["Molca Packer N"]);
  });
});

describe("DowntimeReaderRepository.getDowntimeWatermark", () => {
  function watermark(rows: unknown[]) {
    const fake = fakeSql([{ match: WATERMARK, rows }]);
    const repo = new DowntimeReaderRepository({ goldDb: fake.goldDb });

    return { ...fake, promise: repo.getDowntimeWatermark() };
  }

  // A copy-paste of 'product_perf_wu_hour' from the sibling repository is the
  // realistic failure, and it would answer with another table's progress.
  it("reads the watermark for downtime_reports specifically", async () => {
    const { find, promise } = watermark([{ lastBusinessDate: "2026-08-10" }]);

    await expect(promise).resolves.toBe("2026-08-10");
    expect(find(WATERMARK)!.text).toMatch(/WHERE table_name = 'downtime_reports'/);
  });

  it("answers null when the table has never been loaded", async () => {
    const { promise } = watermark([]);
    await expect(promise).resolves.toBeNull();
  });

  it("answers null when the row exists but carries no date", async () => {
    const { promise } = watermark([{ lastBusinessDate: null }]);
    await expect(promise).resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diffEdit — the rule that decides what lands in the audit trail
// ─────────────────────────────────────────────────────────────────────────────
//
// Worth testing directly rather than only through the SQL, because it is the
// whole of what oee.downtime_report_history records and a wrong answer here is a
// trail that disagrees with the row it describes — which TODOS.md §21 calls worse
// than no trail at all.
//
// It must also agree EXACTLY with the guarded UPDATE's WHERE clause, which
// compares with jsonb `=`. jsonb array equality is ORDER-SENSITIVE, so this is
// too: element 0 of `reason` is the key the Pareto groups on, which makes a
// reorder a real change. A set comparison would call it a no-op and leave the
// diff and the guard disagreeing — the diff would write no history while the
// UPDATE happily rewrote the column.
describe("diffEdit", () => {
  const BASE: DowntimeEdit = {
    category: "UNPLANNED",
    reason: ["Machine_Stop", "Material_Jam"],
    detailReason: "belt slipped",
    actions: ["Realigned"],
  };

  it("reports nothing changed for an identical edit", () => {
    expect(diffEdit(BASE, { ...BASE })).toEqual([]);
  });

  // Fresh arrays with equal contents are a different object identity, which is
  // what a `!==` on the array itself would wrongly call a change — and every
  // request builds fresh arrays out of JSON.
  it("compares arrays by content, not identity", () => {
    expect(diffEdit(BASE, { ...BASE, reason: ["Machine_Stop", "Material_Jam"] })).toEqual([]);
  });

  it.each<[string, Partial<DowntimeEdit>]>([
    ["category", { category: "PLANNED" }],
    ["reason", { reason: ["Machine_Stop"] }],
    ["detailReason", { detailReason: "chain jumped" }],
    ["actions", { actions: [] }],
  ])("reports %s alone when only it moved", (field, patch) => {
    expect(diffEdit(BASE, { ...BASE, ...patch })).toEqual([field]);
  });

  // A REORDER IS A CHANGE. Element 0 is the primary reason the Pareto groups on,
  // so swapping these two moves the stop from one bar to another.
  it("treats a reordered array as changed", () => {
    expect(diffEdit(BASE, { ...BASE, reason: ["Material_Jam", "Machine_Stop"] })).toEqual([
      "reason",
    ]);
  });

  it.each([
    ["cleared", { detailReason: null }],
    ["set from null", { detailReason: "now filled" }],
  ])("treats detailReason %s as changed", (_label, patch) => {
    const from =
      "detailReason" in patch && patch.detailReason === null
        ? BASE
        : { ...BASE, detailReason: null };
    expect(diffEdit(from, { ...from, ...patch })).toEqual(["detailReason"]);
  });

  // Order follows EDITABLE_FIELDS, not the order the object's keys happen to sit
  // in, so the history rows of one edit are written in a stable order.
  it("returns every changed field, in EDITABLE_FIELDS order", () => {
    const changed = diffEdit(BASE, {
      category: "SMALL_STOP",
      reason: [],
      detailReason: null,
      actions: [],
    });
    expect(changed).toEqual(["category", "reason", "detailReason", "actions"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DowntimeWriterRepository.editDowntime
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT A fakeSql TEST CAN AND CANNOT PROVE HERE, because the difference decides
// what the integration suite has to carry.
//
// It CAN prove the statement sequence, and that the right values are BOUND — that
// the guard binds the baseline and not the new values, that the history arrays are
// built from the changed fields only, and that no statement names a table this
// service must never write.
//
// It CANNOT prove that Postgres PAIRS the three unnest arrays correctly, because
// nothing executes. work-unit-repository.ts records exactly what that costs:
// "the whole unit suite stayed green while the By Shift list 500'd" on untyped
// array parameters. So the alignment itself is asserted in the integration suite,
// over real rows.
describe("DowntimeWriterRepository.editDowntime", () => {
  const BASELINE: DowntimeEdit = {
    category: "UNPLANNED",
    reason: ["Machine_Stop"],
    detailReason: "belt slipped",
    actions: ["Realigned"],
  };

  const STOP_ROW = {
    id: 7,
    sourceEventId: "evt-1",
    workUnitId: 3,
    workUnitName: "Vertical Packer N",
    workCenterName: "Line 1",
    areaName: null,
    inputBy: null,
    maintainedBy: null,
    startAt: new Date("2026-08-09T15:40:00.000Z"),
    endAt: new Date("2026-08-09T16:20:00.000Z"),
    ...BASELINE,
  };

  const SELECT_STOP = /SELECT id, source_event_id/;
  const UPDATE_STOP = /UPDATE oee\.downtime_reports/;
  const INSERT_HISTORY = /INSERT INTO oee\.downtime_report_history/;
  const DIAGNOSE = /SELECT EXISTS/;
  const SET_CONFIG = /set_config/;

  // The reader's fakeSql has no transaction, and this repository's whole point is
  // that everything happens inside one. `begin` hands the callback the SAME
  // tagged-template function, so every statement lands in one `calls` list in the
  // order it was issued — which is exactly what these tests assert.
  function fakeTx(routes: Route[] = []) {
    const base = fakeSql(routes);
    const tx = base.goldDb as unknown as Record<string, unknown>;
    tx.begin = async (fn: (h: unknown) => Promise<unknown>) => await fn(base.goldDb);
    // `sql.json(x)` marks a value as jsonb. The real helper returns an opaque
    // Parameter; the fake returns something recognisable so an assertion can say
    // "this was bound AS JSONB" rather than only "this array was bound".
    //
    // THE FAKE HAS TO MODEL IT AT ALL, which is the lesson: the first version of
    // this repository used JSON.stringify() instead, the fake happily recorded
    // the string, every unit test passed, and Postgres compared the column
    // against a jsonb SCALAR STRING so every edit came back 412. See the note on
    // editDowntime.
    tx.json = (value: unknown) => ({ json: value });
    return base;
  }

  // What db.json() binds, for use in parameter assertions.
  const asJson = (value: unknown) => ({ json: value });

  function writer(routes: Route[] = []) {
    const db = fakeTx([{ match: SELECT_STOP, rows: [STOP_ROW] }, ...routes]);
    return { repo: new DowntimeWriterRepository({ goldDb: db.goldDb }), db };
  }

  function run(repo: DowntimeWriterRepository, next: Partial<DowntimeEdit> = {}) {
    return repo.editDowntime({
      sourceEventId: "evt-1",
      next: { ...BASELINE, ...next },
      baseline: BASELINE,
      changedBy: "kc-subject-1",
    });
  }

  it("stamps the operator application_name before anything else", async () => {
    const { repo, db } = writer([{ match: UPDATE_STOP, rows: [{ sourceEventId: "evt-1" }] }]);

    await run(repo, { category: "PLANNED" });

    // FIRST, and inside the transaction. SET LOCAL semantics mean it reverts at
    // COMMIT — without that, postgres.js hands the connection to the next request
    // still labelled as an operator mutation and a pure read is mislabelled in
    // oee.write_audit.
    expect(db.calls[0]?.text).toMatch(SET_CONFIG);
    expect(db.calls[0]?.params).toContain("mes-oee-monitor-operator");
  });

  it("guards the UPDATE on the BASELINE values, not the new ones", async () => {
    const { repo, db } = writer([{ match: UPDATE_STOP, rows: [{ sourceEventId: "evt-1" }] }]);

    await run(repo, { category: "PLANNED" });

    const update = db.find(UPDATE_STOP);
    // The new value is written, the OLD one is matched. Binding the new value in
    // the WHERE would make the guard tautological and the whole
    // optimistic-concurrency check a no-op that never fires.
    expect(update?.params).toContain("PLANNED");
    expect(update?.params).toContain("UNPLANNED");
    // jsonb arrays are bound as JSON text and cast, never as Postgres arrays.
    // Bound AS JSONB, not as a JSON string — the distinction the integration
    // suite had to catch.
    expect(update?.params).toContainEqual(asJson(BASELINE.reason));
    // IS NOT DISTINCT FROM, because detail_reason is nullable and `= NULL` never
    // matches — an untouched empty detail reason would fail its own guard.
    expect(update?.text).toMatch(/IS NOT DISTINCT FROM/);
  });

  it("writes one history row per CHANGED field, and no others", async () => {
    const { repo, db } = writer([{ match: UPDATE_STOP, rows: [{ sourceEventId: "evt-1" }] }]);

    const outcome = await run(repo, { category: "PLANNED", actions: [] });

    expect(outcome).toMatchObject({ kind: "edited", changed: ["category", "actions"] });

    const insert = db.find(INSERT_HISTORY);
    // COLUMN names, not field names: 0007's ck_downtime_report_history_field
    // admits 'detail_reason' and would reject 'detailReason'.
    expect(insert?.params[2]).toEqual(["category", "actions"]);
    // Old and new, as JSON text per element — the scalar goes in as a jsonb
    // STRING, which is what makes `#>> '{}'` the way to read it back.
    expect(insert?.params[3]).toEqual(['"UNPLANNED"', '["Realigned"]']);
    expect(insert?.params[4]).toEqual(['"PLANNED"', "[]"]);
    // The subject, never current_user: the pool connects as one shared role, so
    // the database cannot name the person.
    expect(insert?.params[1]).toBe("kc-subject-1");
  });

  it("maps detail_reason to its column name and null to a jsonb null", async () => {
    const { repo, db } = writer([{ match: UPDATE_STOP, rows: [{ sourceEventId: "evt-1" }] }]);

    await run(repo, { detailReason: null });

    const insert = db.find(INSERT_HISTORY);
    expect(insert?.params[2]).toEqual(["detail_reason"]);
    expect(insert?.params[4]).toEqual(["null"]);
  });

  // A no-op edit COMMITS and writes nothing. A history row saying a field went
  // from X to X is noise in the one table where noise is expensive.
  it("writes nothing at all when nothing changed", async () => {
    const { repo, db } = writer();

    const outcome = await run(repo);

    expect(outcome).toMatchObject({ kind: "unchanged" });
    expect(db.find(UPDATE_STOP)).toBeUndefined();
    expect(db.find(INSERT_HISTORY)).toBeUndefined();
  });

  // The re-read is a SEPARATE statement for closeShiftReport's reason: folded
  // into the UPDATE, "no such stop" and "somebody else changed it" would both be
  // zero rows and 404 and 412 would collapse into each other.
  it("reports not_found without attempting the UPDATE", async () => {
    const db = fakeTx([]);
    const repo = new DowntimeWriterRepository({ goldDb: db.goldDb });

    const outcome = await run(repo, { category: "PLANNED" });

    expect(outcome).toEqual({ kind: "not_found" });
    expect(db.find(UPDATE_STOP)).toBeUndefined();
  });

  // Zero rows from the guarded UPDATE means the stop moved. WHICH writer moved it
  // is decided by whether the audit trail explains where the row now stands — an
  // operator edit leaves a history row, a pipeline restatement leaves nothing.
  it.each([
    ["concurrent", [{ exists: true }]],
    ["restated", [{ exists: false }]],
  ])("diagnoses a %s conflict from the audit trail", async (cause, rows) => {
    const { repo, db } = writer([
      { match: UPDATE_STOP, rows: [] },
      { match: DIAGNOSE, rows },
    ]);

    const outcome = await run(repo, { category: "PLANNED" });

    expect(outcome).toEqual({ kind: "conflict", cause });
    expect(db.find(INSERT_HISTORY)).toBeUndefined();
  });

  // contract §1: this service must NEVER write oee.downtime_log_events, "not even
  // as an operator mutation" — a bar that moves when an operator corrects a stop
  // is not a count of anything. The read paths already assert this by iterating
  // every statement; the WRITE path is the one that could actually do it, so the
  // same guard belongs here. Mechanical rather than editorial, by choice.
  it("never names oee.downtime_log_events, in any statement", async () => {
    const { repo, db } = writer([{ match: UPDATE_STOP, rows: [{ sourceEventId: "evt-1" }] }]);

    await run(repo, { category: "PLANNED", reason: ["Other"], detailReason: null, actions: [] });

    expect(db.calls.length).toBeGreaterThan(2);
    for (const call of db.calls) {
      expect(call.text).not.toMatch(/downtime_log_events/);
    }
    // ...and it does write the two tables it is supposed to, so the assertion
    // above cannot pass by issuing no SQL.
    expect(db.find(UPDATE_STOP)).toBeDefined();
    expect(db.find(INSERT_HISTORY)).toBeDefined();
  });
});
