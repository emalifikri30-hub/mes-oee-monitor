// Integration coverage for the reason aggregate, against a REAL Postgres.
//
// Why this file exists, and why the fakeSql suite next to it is not enough:
// `fakeSql` can assert the SQL text and the bound parameters, but never a
// result. Everything this aggregate gets wrong, it gets wrong arithmetically —
// a clip that yields seconds instead of milliseconds, LEAST and GREATEST with
// their bounds swapped, a shift-3 window that comes out sixteen hours negative
// instead of eight hours positive. None of those throw. They render a plausible
// Pareto, and no regex would notice. This closes TODOS.md §11.
//
// Neither suite subsumes the other. The fakeSql tests pin SHAPE — that the
// stored `duration` column is never read, that the reason array is never
// exploded — which result assertions cannot see. These pin VALUES.
//
// Runs only when GOLD_TEST_DATABASE_URL points at a throwaway database with the
// `oee` schema applied (scripts/migrate.mjs does that). Skipped otherwise, so a
// developer without Docker still gets a green `vp test`.
//
//   docker run -d --name oee-itest-pg -e POSTGRES_PASSWORD=postgres \
//     -e POSTGRES_USER=postgres -e POSTGRES_DB=gold_test -p 55433:5432 postgres:18-alpine
//   GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test \
//     node scripts/migrate.mjs
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test vp run api#test
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "../../shared/database/postgres.js";
import { DowntimeReaderRepository, DowntimeWriterRepository } from "./downtime-repository.js";

import type { GoldDB } from "../../shared/database/postgres.js";
import type { JSONValue } from "postgres";
import type { DowntimeEdit } from "./downtime.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// The window every fixture below is placed against: shift 1 on 2026-08-09 at
// UTC+7, i.e. 07:00-15:00 local == 00:00-08:00Z.
const WINDOW = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-09T08:00:00.000Z"),
};

// Past the window, so a historical shift's open stop clips at `to`. The
// live-shift case overrides this.
const AFTER = new Date("2026-08-09T12:00:00.000Z");

const WORK_UNIT = 4242;
const MINUTE = 60_000;

describe.skipIf(!url)("DowntimeReaderRepository against a real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new DowntimeReaderRepository({ goldDb: db });

  // The history table is keyed on source_event_id, which carries no work-unit
  // sentinel of its own — so it is scoped by the ids this file uses rather than
  // by WORK_UNIT, and cleaned on the same schedule.
  const HISTORY_IDS = ["evt-a", "evt-b"];

  async function truncateFixtures() {
    await db`DELETE FROM oee.downtime_reports WHERE work_unit_id = ${WORK_UNIT}`;
    await db`DELETE FROM oee.downtime_report_history WHERE source_event_id IN ${db(HISTORY_IDS)}`;
  }

  afterAll(async () => {
    await truncateFixtures();
    await db.end();
  });

  beforeEach(truncateFixtures);

  // No `date` any more — 0022 dropped it. A stop's membership in a window is
  // decided entirely by start_at/end_at against dt_reports_span_gist, so these
  // fixtures say only when the stop happened.
  async function stop(opts: {
    startAt: string;
    endAt: string | null;
    // JSONValue rather than string[]: the point of several fixtures below is
    // that the column can hold something the reader must survive, such as
    // [{ code: 7 }].
    reason?: JSONValue;
    category?: "UNPLANNED" | "PLANNED" | "SMALL_STOP";
    workUnitName?: string;
    // The 0007 columns. `sourceEventId` defaults to NULL, which is the state of
    // every row in the live table today — several tests below depend on that
    // being the default rather than an opt-out.
    sourceEventId?: string;
    actions?: JSONValue;
    detailReason?: string;
    inputBy?: string;
    maintainedBy?: string;
    areaName?: string;
  }) {
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, shift, start_at, end_at, work_unit_name,
         work_center_id, work_center_name, source_event_id, actions, detail_reason,
         input_by, maintained_by, area_name)
      VALUES (
        ${db.json(opts.reason ?? ["Mlipit"])},
        ${opts.category ?? "UNPLANNED"}::oee.operation_type,
        ${WORK_UNIT}, 1,
        ${new Date(opts.startAt)},
        ${opts.endAt === null ? null : new Date(opts.endAt)},
        ${opts.workUnitName ?? "Vertical Packer MJCL"},
        99, 'H2-4',
        ${opts.sourceEventId ?? null},
        ${db.json(opts.actions ?? [])},
        ${opts.detailReason ?? null},
        ${opts.inputBy ?? null},
        ${opts.maintainedBy ?? null},
        ${opts.areaName ?? null}
      )
    `;
  }

  // Runs `write` with 0011's shape constraints suspended, then puts them back.
  //
  // ONLY FOR FIXTURES THAT MODEL PRE-0011 DATA. A CHECK constraint is not
  // deferrable, so there is no gentler way to insert a row the schema now refuses —
  // and being unable to write it is the whole point of the constraint.
  //
  // The restore is in a `finally`, because a bypass that leaked on a failing test
  // would silently disable the guard for every test after it in this file.
  //
  // IT COMES BACK `NOT VALID`, and that is required rather than lazy: the row just
  // written violates it, so re-adding it as VALID would fail on the fixture it was
  // suspended for. `NOT VALID` skips checking EXISTING rows and still enforces
  // every subsequent INSERT and UPDATE — so the guard is live for the rest of the
  // suite, which is what matters. (It is also the shape you would use to add this
  // constraint to a table you had not surveyed.)
  async function withoutShapeChecks(write: () => Promise<void>): Promise<void> {
    await db`ALTER TABLE oee.downtime_reports DROP CONSTRAINT ck_downtime_reports_reason`;
    try {
      await write();
    } finally {
      await db`
        ALTER TABLE oee.downtime_reports
          ADD CONSTRAINT ck_downtime_reports_reason
            CHECK (oee.jsonb_is_label_array(reason, 255)) NOT VALID
      `;
    }
  }

  // `measure` and `limit` default to the endpoint's own defaults, so every case
  // below reads as it did before the truncation landed. The cases that exercise
  // the LIMIT pass their own.
  function aggregate(
    now: Date = AFTER,
    category: "UNPLANNED" | "PLANNED" | "SMALL_STOP" = "UNPLANNED",
    over: { measure?: "duration" | "frequency"; limit?: number } = {},
  ) {
    return repo.aggregateByReason({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      category,
      now,
      measure: over.measure ?? "duration",
      limit: over.limit ?? 20,
    });
  }

  it("sums a stop that lies wholly inside the window, in milliseconds", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:30:00Z" });

    const result = await aggregate();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      reason: "Mlipit",
      frequency: 1,
      durationMs: 30 * MINUTE,
    });
    expect(result.totalDurationMs).toBe(30 * MINUTE);
  });

  // Without the GREATEST this would report 90 minutes for a stop that spent 30
  // of them in the previous shift.
  it("clips a stop that began before the window at the window start", async () => {
    await stop({ startAt: "2026-08-08T23:30:00Z", endAt: "2026-08-09T01:00:00Z" });

    const result = await aggregate();

    expect(result.buckets[0]?.durationMs).toBe(60 * MINUTE);
  });

  // Without the LEAST this would report 90 minutes and could exceed the shift.
  it("clips a stop that ran past the window at the window end", async () => {
    await stop({ startAt: "2026-08-09T07:00:00Z", endAt: "2026-08-09T08:30:00Z" });

    const result = await aggregate();

    expect(result.buckets[0]?.durationMs).toBe(60 * MINUTE);
  });

  it("clips an open stop at the window end once the shift has closed", async () => {
    await stop({ startAt: "2026-08-09T07:00:00Z", endAt: null });

    const result = await aggregate(AFTER);

    expect(result.buckets[0]?.durationMs).toBe(60 * MINUTE);
  });

  // The one case coalesce(end_at, now) exists for: a stop still running inside a
  // live shift has not yet spent the rest of the window, and the strip beside it
  // draws it only as far as now.
  it("clips an open stop at now while the shift is still running", async () => {
    await stop({ startAt: "2026-08-09T04:00:00Z", endAt: null });

    const result = await aggregate(new Date("2026-08-09T05:00:00Z"));

    expect(result.buckets[0]?.durationMs).toBe(60 * MINUTE);
  });

  // No CHECK constraint prevents these, and a negative-width bar is nonsense.
  //
  // THIS TEST WAS INVERTED ON 2026-09-02 AND THAT IS THE POINT OF IT NOW. It used
  // to assert `dropped === 1` — the row came back from Postgres and the sweep
  // discarded it, incrementing downtime_rows_dropped_total. Since §10/§69
  // replaced the membership predicate with a range `&&` matching
  // dt_reports_span_gist, `greatest(...)` collapses an inverted row to an EMPTY
  // range and `&&` never matches empty, so it is filtered in the database and the
  // sweep never sees it.
  //
  // The BAR is unchanged either way, which is why this is acceptable: nonsense
  // never reached a chart before and does not now. What changed is the SIGNAL —
  // the counter that existed to say "upstream data is malformed" can no longer
  // see this class of row. metrics.ts records the narrowed meaning and TODOS.md
  // §70 carries the replacement, because a data-quality fact about the table
  // should never have been a side effect of drawing one shift's strip.
  it("excludes an inverted row in the database, so the sweep never counts it", async () => {
    await stop({ startAt: "2026-08-09T03:00:00Z", endAt: "2026-08-09T02:00:00Z" });

    const result = await aggregate();

    expect(result.buckets).toEqual([]);
    expect(result.totalDurationMs).toBe(0);
    // Zero, not one. See the header: the row is gone before the sweep runs.
    expect(result.dropped).toBe(0);
  });

  // Exploding the array would count one stop twice and make the bars sum to more
  // than the shift.
  it("groups a multi-reason stop under its primary reason only", async () => {
    await stop({
      startAt: "2026-08-09T02:00:00Z",
      endAt: "2026-08-09T02:20:00Z",
      reason: ["Ganti Film", "Camera Inspection"],
    });

    const result = await aggregate();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ reason: "Ganti Film", frequency: 1 });
    expect(result.totalFrequency).toBe(1);
  });

  // `[]` is a legitimate value and stays writable — it IS the unlabelled bucket.
  it("folds an empty array into the single unlabelled bucket", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z", reason: [] });

    const result = await aggregate();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.reason).toBeNull();
  });

  // THESE THREE SHAPES ARE NO LONGER WRITABLE, and the tests are kept anyway.
  //
  // Migration 0011 added ck_downtime_reports_reason, so a blank, whitespace-only or
  // non-string element is rejected at the database — which is why each of these has
  // to suspend the constraint to set its fixture up. That looks like fighting the
  // schema, so the reason is worth stating: the reader's tolerance still guards data
  // written BEFORE 0011, and it is what stopped these shapes from being a visible
  // bug for as long as the column was unconstrained. Defence in depth, with the
  // depth now measurable — `withoutShapeChecks` failing to restore would break
  // every test after it, so the bypass cannot quietly become permanent.
  //
  // If contract §3.3.1 ever lands and `reason` becomes a `primary_reason text`
  // column, all of this — reader defence, constraint and bypass — goes away
  // together.
  it.each([
    ["a blank string", [""]],
    ["whitespace only", ["   "]],
    ["a non-string element", [{ code: 7 }]],
  ] as [string, JSONValue][])(
    "folds %s into the single unlabelled bucket (pre-0011 data)",
    async (_label, reason) => {
      await withoutShapeChecks(() =>
        stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z", reason }),
      );

      const result = await aggregate();

      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0]?.reason).toBeNull();
    },
  );

  it("keeps several distinct unlabelled stops in one bucket, not several", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z", reason: [] });
    await withoutShapeChecks(() =>
      stop({ startAt: "2026-08-09T03:00:00Z", endAt: "2026-08-09T03:10:00Z", reason: [""] }),
    );

    const result = await aggregate();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ reason: null, frequency: 2 });
  });

  // Availability loss is UNPLANNED alone; SMALL_STOP is its own enum value.
  it("excludes other categories", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z" });
    await stop({
      startAt: "2026-08-09T03:00:00Z",
      endAt: "2026-08-09T03:10:00Z",
      category: "SMALL_STOP",
      reason: ["Jam"],
    });
    await stop({
      startAt: "2026-08-09T04:00:00Z",
      endAt: "2026-08-09T04:10:00Z",
      category: "PLANNED",
      reason: ["Changeover"],
    });

    const unplanned = await aggregate();
    expect(unplanned.buckets.map((b) => b.reason)).toEqual(["Mlipit"]);

    const smallStop = await aggregate(AFTER, "SMALL_STOP");
    expect(smallStop.buckets.map((b) => b.reason)).toEqual(["Jam"]);
  });

  it("ranks by clipped duration descending and breaks ties on the reason", async () => {
    await stop({ startAt: "2026-08-09T01:00:00Z", endAt: "2026-08-09T01:10:00Z", reason: ["B"] });
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z", reason: ["A"] });
    await stop({ startAt: "2026-08-09T03:00:00Z", endAt: "2026-08-09T03:30:00Z", reason: ["C"] });

    const result = await aggregate();

    // C is longest; A and B tie at ten minutes and sort alphabetically.
    expect(result.buckets.map((b) => b.reason)).toEqual(["C", "A", "B"]);
  });

  it("collects the distinct machine names behind a bucket", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z" });
    await stop({ startAt: "2026-08-09T03:00:00Z", endAt: "2026-08-09T03:10:00Z" });

    const result = await aggregate();

    expect(result.buckets[0]?.workUnitNames).toEqual(["Vertical Packer MJCL"]);
  });

  it("excludes a stop that lies entirely outside the window", async () => {
    await stop({ startAt: "2026-08-09T09:00:00Z", endAt: "2026-08-09T09:30:00Z" });

    const result = await aggregate();

    expect(result.buckets).toEqual([]);
  });

  // sum() over an empty set is NULL, which would reach the browser as a
  // divide-by-null on the cumulative line.
  it("returns zeroed totals rather than nulls when nothing matched", async () => {
    const result = await aggregate();

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

  // ───────────────────────────────────────────────────────────────────────────
  // The LIMIT and the tail (TODOS §25)
  // ───────────────────────────────────────────────────────────────────────────
  //
  // WHAT ONLY A REAL POSTGRES SHOWS HERE. The unit suite asserts the SQL text —
  // that an ORDER BY per measure exists, that the bucket query is limited and the
  // totals query is not. It cannot execute any of it, so the three things that
  // actually matter are invisible there: that the limit picks the RIGHT buckets,
  // that `group_count` counts the NULL bucket (count(DISTINCT) would skip it), and
  // that the totals stay the WHOLE window's while the buckets are only part of it.
  //
  // That last one is the whole point of the design. The browser's cumulative line
  // divides by the totals, so if a LIMIT leaked into the totals query the bars
  // would sum to 100% by construction and the truncation would be invisible —
  // which is the flattering reading of a missing tail.

  it("returns only the top N by duration, and counts every group", async () => {
    // Five reasons, descending: 50, 40, 30, 20, 10 minutes.
    for (const [i, reason] of ["A", "B", "C", "D", "E"].entries()) {
      await stop({
        startAt: `2026-08-09T0${i + 1}:00:00Z`,
        endAt: `2026-08-09T0${i + 1}:${String(50 - i * 10).padStart(2, "0")}:00Z`,
        reason: [reason],
      });
    }

    const result = await aggregate(AFTER, "UNPLANNED", { limit: 2 });

    expect(result.buckets.map((b) => b.reason)).toEqual(["A", "B"]);
    // FIVE, not two. This is what the tail is derived from.
    expect(result.groupCount).toBe(5);
    // And the totals cover all five, not the two returned.
    expect(result.totalFrequency).toBe(5);
    expect(result.totalDurationMs).toBe(150 * MINUTE);
  });

  // THE TWO MEASURES PICK DIFFERENT BUCKETS, which is the entire reason `measure`
  // had to become a server parameter rather than stay a browser toggle.
  it("ranks by frequency when asked, which selects a different top N", async () => {
    // One long stop under "Rare", three short ones under "Often".
    await stop({
      startAt: "2026-08-09T01:00:00Z",
      endAt: "2026-08-09T02:00:00Z",
      reason: ["Rare"],
    });
    for (const hour of ["03", "04", "05"]) {
      await stop({
        startAt: `2026-08-09T${hour}:00:00Z`,
        endAt: `2026-08-09T${hour}:05:00Z`,
        reason: ["Often"],
      });
    }

    const byDuration = await aggregate(AFTER, "UNPLANNED", { limit: 1, measure: "duration" });
    const byFrequency = await aggregate(AFTER, "UNPLANNED", { limit: 1, measure: "frequency" });

    expect(byDuration.buckets[0]?.reason).toBe("Rare");
    expect(byFrequency.buckets[0]?.reason).toBe("Often");
    // Same window, same totals, whichever measure ranked it.
    expect(byDuration.totalDurationMs).toBe(byFrequency.totalDurationMs);
    expect(byDuration.groupCount).toBe(byFrequency.groupCount);
  });

  // count(DISTINCT reason_key) SKIPS NULL, and NULL is a real bucket here — the
  // unlabelled one. Counting GROUPS instead includes it exactly once. Getting this
  // wrong understates the tail by one and is invisible in every other assertion.
  it("counts the unlabelled bucket as a group", async () => {
    await stop({ startAt: "2026-08-09T01:00:00Z", endAt: "2026-08-09T01:10:00Z", reason: ["A"] });
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z", reason: [] });

    const result = await aggregate();

    expect(result.groupCount).toBe(2);
    expect(result.buckets.map((b) => b.reason)).toContain(null);
  });

  it("reports no tail when the limit does not bite", async () => {
    await stop({ startAt: "2026-08-09T01:00:00Z", endAt: "2026-08-09T01:10:00Z", reason: ["A"] });

    const result = await aggregate(AFTER, "UNPLANNED", { limit: 20 });

    expect(result.groupCount).toBe(result.buckets.length);
  });

  it("keeps the totals equal to the sum of the buckets", async () => {
    await stop({ startAt: "2026-08-09T01:00:00Z", endAt: "2026-08-09T01:10:00Z", reason: ["A"] });
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:20:00Z", reason: ["B"] });

    const result = await aggregate();

    const summed = result.buckets.reduce((total, b) => total + b.durationMs, 0);
    expect(result.totalDurationMs).toBe(summed);
    expect(result.totalFrequency).toBe(2);
  });

  // TODOS.md §11's stated first target. Shift 3 crosses midnight via an
  // endDayOffset of 1; getting it wrong yields a negative sixteen-hour window
  // rather than a positive eight-hour one, and renders a plausible strip.
  describe("getWindow", () => {
    it.each([
      ["1", "2026-08-09T00:00:00.000Z", "2026-08-09T08:00:00.000Z"],
      ["2", "2026-08-09T08:00:00.000Z", "2026-08-09T16:00:00.000Z"],
      ["3", "2026-08-09T16:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    ] as const)("resolves shift %s in the plant's zone", async (shift, from, to) => {
      const window = await repo.getWindow("shift", "2026-08-09", shift, "Asia/Jakarta");

      expect(window.from.toISOString()).toBe(from);
      expect(window.to.toISOString()).toBe(to);
      expect(window.to.getTime() - window.from.getTime()).toBe(8 * 60 * MINUTE);
    });
  });

  describe("getDowntimeWatermark", () => {
    it("answers null when the pipeline has never stamped the table", async () => {
      await db`DELETE FROM oee.etl_watermarks WHERE table_name = 'downtime_reports'`;

      await expect(repo.getDowntimeWatermark()).resolves.toBeNull();
    });

    it("answers the business day the pipeline last loaded", async () => {
      // `last_run_at` and `writer` are NOT NULL on this table — the pipeline
      // stamps who wrote and when, alongside how far it got.
      await db`
        INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, writer)
        VALUES ('downtime_reports', now(), '2026-08-10', 'integration-test')
        ON CONFLICT (table_name) DO UPDATE SET last_business_date = EXCLUDED.last_business_date
      `;

      await expect(repo.getDowntimeWatermark()).resolves.toBe("2026-08-10");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The per-reason drill-down.
  //
  // Three things can be wrong here and none of them throws: the filter can match
  // any element of the reason array instead of the primary one, the durations
  // can go unclipped, and the summary bucket can disagree with the bar the page
  // was opened from. Each renders a completely reasonable-looking screen.
  // TODOS.md §27.
  // ───────────────────────────────────────────────────────────────────────────
  function detail(
    selector: { kind: "labelled"; reason: string } | { kind: "unlabelled" },
    now: Date = AFTER,
  ) {
    return repo.paginateByReason({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      category: "UNPLANNED",
      now,
      selector,
      limit: 50,
      offset: 0,
      sortBy: "startAt",
      sortDir: "asc",
    });
  }

  // THE trap. A stop tagged ["Machine_Stop", "Custom_Reason_1"] belongs to
  // Machine_Stop and to nothing else, because that is how aggregateByReason
  // groups it. If the filter matched any element, this stop would also be listed
  // under Custom_Reason_1 — a bucket whose bar never counted it.
  it("lists a multi-reason stop under its primary reason and no other", async () => {
    await stop({
      startAt: "2026-08-09T02:00:00Z",
      endAt: "2026-08-09T02:30:00Z",
      reason: ["Machine_Stop", "Custom_Reason_1"],
    });

    const primary = await detail({ kind: "labelled", reason: "Machine_Stop" });
    expect(primary.totalElements).toBe(1);
    expect(primary.items[0]?.reason).toEqual(["Machine_Stop", "Custom_Reason_1"]);

    const secondary = await detail({ kind: "labelled", reason: "Custom_Reason_1" });
    expect(secondary.totalElements).toBe(0);
    expect(secondary.items).toEqual([]);
  });

  // Unlike paginateDowntime, which lists records and reports whole stops. A
  // straddling stop showing 90 minutes here would not sum to the 30 its bar got.
  it("clips a straddling stop to the window, unlike the unclipped detail list", async () => {
    await stop({ startAt: "2026-08-08T23:00:00Z", endAt: "2026-08-09T00:30:00Z" });

    const clipped = await detail({ kind: "labelled", reason: "Mlipit" });
    expect(clipped.items[0]?.durationMs).toBe(30 * MINUTE);

    const unclipped = await repo.paginateDowntime({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      limit: 50,
      offset: 0,
      sortBy: "startAt",
      sortDir: "asc",
    });
    expect(unclipped.items[0]?.durationMs).toBe(90 * MINUTE);
  });

  it("clips an open stop at now during a live shift, matching the aggregate", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: null });
    const live = new Date("2026-08-09T03:00:00Z");

    const rows = await detail({ kind: "labelled", reason: "Mlipit" }, live);
    expect(rows.items[0]?.durationMs).toBe(60 * MINUTE);

    const { buckets } = await repo.aggregateByReason({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      category: "UNPLANNED",
      now: live,
      measure: "duration",
      limit: 20,
    });
    expect(buckets[0]?.durationMs).toBe(60 * MINUTE);
  });

  // The unlabelled bucket is `reason IS NULL` over the wire. A filter keyed on
  // the browser's "Unspecified" label would match nothing here — or, worse,
  // match a genuine reason of that exact text.
  it("selects the unlabelled bucket by null, never by the word Unspecified", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:10:00Z", reason: [] });
    await stop({
      startAt: "2026-08-09T03:00:00Z",
      endAt: "2026-08-09T03:10:00Z",
      reason: ["Unspecified"],
    });

    const unlabelled = await detail({ kind: "unlabelled" });
    expect(unlabelled.totalElements).toBe(1);
    expect(unlabelled.items[0]?.reason).toEqual([]);

    // The real reason of that text is its own bucket and must not be absorbed.
    const literal = await detail({ kind: "labelled", reason: "Unspecified" });
    expect(literal.totalElements).toBe(1);
    expect(literal.items[0]?.reason).toEqual(["Unspecified"]);
  });

  it("excludes a stop of another category, as its bar does", async () => {
    await stop({
      startAt: "2026-08-09T02:00:00Z",
      endAt: "2026-08-09T02:30:00Z",
      category: "PLANNED",
    });

    expect((await detail({ kind: "labelled", reason: "Mlipit" })).totalElements).toBe(0);
  });

  it("carries the 0007 columns the shared detail drawer renders", async () => {
    await stop({
      startAt: "2026-08-09T02:00:00Z",
      endAt: "2026-08-09T02:30:00Z",
      sourceEventId: "evt-a",
      actions: ["Ganti Film"],
      detailReason: "film habis di tengah batch",
      inputBy: "operator-1",
      maintainedBy: "Operator",
      areaName: "FI-2",
    });

    const [row] = (await detail({ kind: "labelled", reason: "Mlipit" })).items;
    expect(row).toMatchObject({
      sourceEventId: "evt-a",
      actions: ["Ganti Film"],
      detailReason: "film habis di tengah batch",
      inputBy: "operator-1",
      maintainedBy: "Operator",
      areaName: "FI-2",
      workCenterName: "H2-4",
    });
  });

  // The SAME projection feeds the drawer from both tables. A field present on
  // one and missing on the other is invisible until someone opens the drawer
  // from the wrong screen.
  it("projects identical fields from both detail readers", async () => {
    await stop({
      startAt: "2026-08-09T02:00:00Z",
      endAt: "2026-08-09T02:30:00Z",
      sourceEventId: "evt-a",
    });

    const [viaReason] = (await detail({ kind: "labelled", reason: "Mlipit" })).items;
    const [viaList] = (
      await repo.paginateDowntime({
        scope: "work-unit",
        scopeId: WORK_UNIT,
        window: WINDOW,
        limit: 50,
        offset: 0,
        sortBy: "startAt",
        sortDir: "asc",
      })
    ).items;

    expect(Object.keys(viaReason!).sort()).toEqual(Object.keys(viaList!).sort());
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RECONCILIATION. The summary card must equal the bar it was opened from.
  //
  // Structure already makes this hard to break — aggregateOneReason delegates to
  // aggregateByReason, and both compose the same clipped fragments. This proves
  // the structure stayed that way.
  // ───────────────────────────────────────────────────────────────────────────
  it("returns, per reason, exactly the bucket the whole-shift breakdown drew", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:30:00Z" });
    await stop({ startAt: "2026-08-09T04:00:00Z", endAt: "2026-08-09T04:20:00Z" });
    await stop({
      startAt: "2026-08-08T23:00:00Z",
      endAt: "2026-08-09T00:30:00Z",
      reason: ["Machine_Stop", "Mlipit"],
    });
    await stop({ startAt: "2026-08-09T06:00:00Z", endAt: "2026-08-09T06:15:00Z", reason: [] });

    const { buckets } = await repo.aggregateByReason({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      category: "UNPLANNED",
      now: AFTER,
      measure: "duration",
      limit: 20,
    });
    expect(buckets.length).toBe(3);

    for (const bar of buckets) {
      const selector =
        bar.reason === null
          ? ({ kind: "unlabelled" } as const)
          : ({ kind: "labelled", reason: bar.reason } as const);

      const one = await repo.aggregateOneReason({
        scope: "work-unit",
        scopeId: WORK_UNIT,
        window: WINDOW,
        category: "UNPLANNED",
        now: AFTER,
        selector,
      });
      expect(one).toEqual(bar);

      // And the rows behind it agree with the frequency the bar claims.
      const rows = await detail(selector);
      expect(rows.totalElements).toBe(bar.frequency);
      const summed = rows.items.reduce((total, row) => total + (row.durationMs ?? 0), 0);
      expect(Math.round(summed)).toBe(Math.round(bar.durationMs));
    }
  });

  it("returns null for a reason that contributed nothing, so the route can 404", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:30:00Z" });

    const missing = await repo.aggregateOneReason({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      category: "UNPLANNED",
      now: AFTER,
      selector: { kind: "labelled", reason: "DoesNotExist" },
    });
    expect(missing).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Changes History.
  // ───────────────────────────────────────────────────────────────────────────
  function history(selector: { kind: "labelled"; reason: string } | { kind: "unlabelled" }) {
    return repo.listReasonHistory({
      scope: "work-unit",
      scopeId: WORK_UNIT,
      window: WINDOW,
      category: "UNPLANNED",
      selector,
    });
  }

  // The state of every row in the live table: stops exist, none carries a
  // source_event_id, so nothing about them CAN be recorded. Reporting an empty
  // list alone would render as "nothing changed", which is a different and
  // flattering claim.
  it("separates untracked stops from stops with no changes", async () => {
    await stop({ startAt: "2026-08-09T02:00:00Z", endAt: "2026-08-09T02:30:00Z" });
    await stop({ startAt: "2026-08-09T04:00:00Z", endAt: "2026-08-09T04:30:00Z" });

    const untracked = await history({ kind: "labelled", reason: "Mlipit" });
    expect(untracked).toEqual({ entries: [], totalMembers: 2, trackedMembers: 0 });

    await db`UPDATE oee.downtime_reports
             SET source_event_id = 'evt-a'
             WHERE work_unit_id = ${WORK_UNIT} AND start_at = ${new Date("2026-08-09T02:00:00Z")}`;

    const tracked = await history({ kind: "labelled", reason: "Mlipit" });
    expect(tracked).toEqual({ entries: [], totalMembers: 2, trackedMembers: 1 });
  });

  it("returns a stop's trail newest first, and only for stops in the bucket", async () => {
    await stop({
      startAt: "2026-08-09T02:00:00Z",
      endAt: "2026-08-09T02:30:00Z",
      sourceEventId: "evt-a",
    });
    await stop({
      startAt: "2026-08-09T04:00:00Z",
      endAt: "2026-08-09T04:30:00Z",
      reason: ["Machine_Stop"],
      sourceEventId: "evt-b",
    });

    await db`
      INSERT INTO oee.downtime_report_history
        (source_event_id, changed_at, changed_by, field, old_value, new_value)
      VALUES
        ('evt-a', '2026-08-09T05:00:00Z', 'kiki', 'category',
         ${db.json("PLANNED")}, ${db.json("UNPLANNED")}),
        ('evt-a', '2026-08-09T06:00:00Z', 'kiki', 'actions',
         ${db.json([])}, ${db.json(["Ganti Film"])}),
        ('evt-b', '2026-08-09T07:00:00Z', 'kiki', 'category',
         ${db.json("UNPLANNED")}, ${db.json("PLANNED")})
    `;

    const result = await history({ kind: "labelled", reason: "Mlipit" });

    expect(result.trackedMembers).toBe(1);
    expect(result.entries.map((entry) => entry.field)).toEqual(["actions", "category"]);
    expect(result.entries.every((entry) => entry.sourceEventId === "evt-a")).toBe(true);
    expect(result.entries[0]).toMatchObject({ changedBy: "kiki", newValue: ["Ganti Film"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DowntimeWriterRepository against a real Postgres
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THE fakeSql SUITE IS NOT ENOUGH HERE, specifically.
//
// The unit tests prove the three arrays are BUILT and BOUND. They cannot prove
// Postgres PAIRS them, because nothing executes — and work-unit-repository.ts
// records exactly what that costs: "the whole unit suite stayed green while the
// By Shift list 500'd" on untyped array parameters. A misaligned unnest writes a
// trail that attributes the wrong old value to the wrong field, which by
// TODOS.md §21's standard is worse than no trail at all, and which no regex over
// SQL text could ever notice.
//
// The other three things only real SQL can settle: that jsonb equality in the
// guard behaves the way diffEdit assumes (order-sensitive over arrays), that
// `#>> '{}'` reads a scalar back UNQUOTED, and that the whole thing is one
// transaction.
describe.skipIf(!url)("DowntimeWriterRepository against a real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const writer = new DowntimeWriterRepository({ goldDb: db });
  const reader = new DowntimeReaderRepository({ goldDb: db });

  const WU = 4243;
  const EVENT = "evt-edit-1";

  const BASELINE: DowntimeEdit = {
    category: "UNPLANNED",
    reason: ["Machine_Stop", "Material_Jam"],
    detailReason: "belt slipped",
    actions: ["Realigned"],
  };

  async function truncate() {
    await db`DELETE FROM oee.downtime_reports WHERE work_unit_id = ${WU}`;
    await db`DELETE FROM oee.downtime_report_history WHERE source_event_id = ${EVENT}`;
    await db`DELETE FROM oee.write_audit WHERE table_name = 'downtime_report_history'`;
  }

  afterAll(async () => {
    await truncate();
    await db.end();
  });

  beforeEach(truncate);

  // The stop every test below edits, seeded with BASELINE's values so a request
  // carrying BASELINE as its baseline matches.
  async function seed(overrides: Partial<DowntimeEdit> = {}) {
    const row = { ...BASELINE, ...overrides };
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, shift, start_at, end_at,
         work_center_id, source_event_id, actions, detail_reason)
      VALUES (
        ${db.json(row.reason)}, ${row.category}::oee.operation_type,
        ${WU}, 1,
        '2026-08-09T02:00:00Z', '2026-08-09T02:40:00Z',
        99, ${EVENT}, ${db.json(row.actions)}, ${row.detailReason}
      )
    `;
  }

  function edit(next: Partial<DowntimeEdit>, baseline = BASELINE) {
    return writer.editDowntime({
      sourceEventId: EVENT,
      next: { ...BASELINE, ...next },
      baseline,
      changedBy: "kc-subject-1",
    });
  }

  function historyRows() {
    return db<{ field: string; oldValue: unknown; newValue: unknown }[]>`
      SELECT field, old_value, new_value
      FROM oee.downtime_report_history
      WHERE source_event_id = ${EVENT}
      ORDER BY field ASC
    `;
  }

  // THE unnest ALIGNMENT ASSERTION. Three fields change at once, each with a
  // different old and new value, so a misalignment cannot pass by coincidence.
  it("pairs each field with ITS OWN old and new value", async () => {
    await seed();

    const outcome = await edit({
      category: "PLANNED",
      reason: ["Machine_Stop"],
      actions: [],
    });

    expect(outcome.kind).toBe("edited");
    expect(await historyRows()).toEqual([
      // Arrays land as arrays, scalars as jsonb strings — and each row carries
      // the values of the field it names, not of its neighbour.
      { field: "actions", oldValue: ["Realigned"], newValue: [] },
      { field: "category", oldValue: "UNPLANNED", newValue: "PLANNED" },
      { field: "reason", oldValue: ["Machine_Stop", "Material_Jam"], newValue: ["Machine_Stop"] },
    ]);
  });

  // contract §13 tells the pipeline to read a scalar override with `#>> '{}'`
  // rather than `::text`, because the latter yields "PLANNED" WITH QUOTES and the
  // enum cast then fails confusingly. This is that instruction, verified.
  it("stores a scalar so `#>> '{}'` reads it back unquoted", async () => {
    await seed();
    await edit({ category: "SMALL_STOP" });

    const [row] = await db<{ raw: string; unquoted: string }[]>`
      SELECT new_value::text AS raw, new_value #>> '{}' AS unquoted
      FROM oee.downtime_report_history
      WHERE source_event_id = ${EVENT} AND field = 'category'
    `;

    expect(row?.raw).toBe('"SMALL_STOP"');
    expect(row?.unquoted).toBe("SMALL_STOP");
  });

  // The column name, not the field name — 0007's ck_downtime_report_history_field
  // admits 'detail_reason' and would REJECT 'detailReason'. A constraint
  // violation here would be a 500, so this is the assertion that the mapping is
  // applied at all.
  it("writes detail_reason under its column name, and null as a jsonb null", async () => {
    await seed();

    await edit({ detailReason: null });

    const rows = await historyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ field: "detail_reason", oldValue: "belt slipped" });
    // jsonb null, not SQL NULL — which is what makes contract §13's
    // "CASE WHEN overridden" distinguishable from "not overridden".
    expect(rows[0]?.newValue).toBeNull();
  });

  it("commits the row and the trail together", async () => {
    await seed();

    await edit({ category: "PLANNED" });

    const stop = await reader.getEditableStop(EVENT);
    expect(stop?.category).toBe("PLANNED");
    expect(await historyRows()).toHaveLength(1);
  });

  it("writes nothing at all for a no-op edit", async () => {
    await seed();

    const outcome = await edit({});

    expect(outcome.kind).toBe("unchanged");
    expect(await historyRows()).toEqual([]);
  });

  // jsonb array equality is ORDER-SENSITIVE, which is what diffEdit assumes. If
  // Postgres treated these as equal the guard would pass while the diff said
  // "changed", and the UPDATE would rewrite the column with no trail.
  it("treats a reordered reason array as a real change", async () => {
    await seed();

    const outcome = await edit({ reason: ["Material_Jam", "Machine_Stop"] });

    expect(outcome.kind).toBe("edited");
    expect((await historyRows()).map((r) => r.field)).toEqual(["reason"]);
  });

  // THE CONCURRENCY ASSERTION, sequential rather than racing: the WHERE clause
  // already serialises, and what matters is that the first edit SURVIVES.
  it("412s a stale baseline and leaves the first edit intact", async () => {
    await seed();
    await edit({ category: "PLANNED" });

    // A second request carrying the ORIGINAL baseline — what a dialog opened
    // before the first edit would send.
    const outcome = await edit({ category: "SMALL_STOP" }, BASELINE);

    expect(outcome).toMatchObject({ kind: "conflict" });
    const stop = await reader.getEditableStop(EVENT);
    // Neither the row nor the trail moved.
    expect(stop?.category).toBe("PLANNED");
    expect(await historyRows()).toHaveLength(1);
  });

  // The discriminator is the AUDIT TRAIL, not the row's existence: an operator
  // edit leaves a history row explaining the current value, a pipeline
  // restatement leaves nothing.
  it("blames the operator when a history row explains the current value", async () => {
    await seed();
    await edit({ category: "PLANNED" });

    const outcome = await edit({ category: "SMALL_STOP" }, BASELINE);

    expect(outcome).toEqual({ kind: "conflict", cause: "concurrent" });
  });

  it("blames the pipeline when nothing audited explains it", async () => {
    await seed();
    // A restatement: the values move with no history row behind them, which is
    // exactly what DELETE-then-INSERT from Silver looks like.
    await db`
      UPDATE oee.downtime_reports
         SET category = 'PLANNED'::oee.operation_type
       WHERE source_event_id = ${EVENT}
    `;

    const outcome = await edit({ category: "SMALL_STOP" }, BASELINE);

    expect(outcome).toEqual({ kind: "conflict", cause: "restated" });
  });

  it("reports not_found for an unknown stop", async () => {
    const outcome = await writer.editDowntime({
      sourceEventId: "evt-does-not-exist",
      next: BASELINE,
      baseline: BASELINE,
      changedBy: "kc-subject-1",
    });

    expect(outcome).toEqual({ kind: "not_found" });
  });

  // postgres.js pools connections, so `is_local => true` reverting at COMMIT is
  // load-bearing: without it the next request handed this connection would report
  // itself as an operator mutation and mislabel a pure read in oee.write_audit.
  it("reverts application_name after the transaction commits", async () => {
    await seed();
    await edit({ category: "PLANNED" });

    const [row] = await db<{ name: string }[]>`
      SELECT current_setting('application_name') AS name
    `;
    expect(row?.name).toBe("api-integration-test");
  });

  // 0007 carries the same audit trigger pair as every other table: statement-level
  // for INSERT, row-level for UPDATE and DELETE. So
  // `WHERE application_name = 'mes-oee-monitor-operator'` is a complete list of
  // every operator write ever made — contract §5's claim, checked.
  it("records the write under the operator application_name", async () => {
    await seed();
    await edit({ category: "PLANNED" });

    const [row] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM oee.write_audit
      WHERE table_name = 'downtime_report_history'
        AND application_name = 'mes-oee-monitor-operator'
    `;
    expect(row?.count).toBeGreaterThan(0);
  });

  // THE PROPERTY contract §13 EXISTS TO PROTECT, demonstrated rather than argued.
  //
  // The pipeline loads this table DELETE-then-INSERT (§2.1), so an operator edit
  // is destroyed by the next ordinary run unless the loader re-applies the
  // override. This test performs that restatement and then re-applies the trail
  // the way §13's projection tells the pipeline to — proving the trail carries
  // everything needed to recover the edit, which is the whole ask.
  it("carries enough in the trail to survive a DELETE-then-INSERT restatement", async () => {
    await seed();
    await edit({ category: "PLANNED", detailReason: "operator correction" });

    // The pipeline's run: the row is deleted and re-inserted from Silver, which
    // knows nothing about the edit. Note the new `id`.
    await db`DELETE FROM oee.downtime_reports WHERE source_event_id = ${EVENT}`;
    await seed();

    const reverted = await reader.getEditableStop(EVENT);
    expect(reverted?.category).toBe("UNPLANNED");

    // §13's projection: the LATEST history row per (source_event_id, field), then
    // applied with CASE WHEN rather than COALESCE — so a field the operator
    // CLEARED to null is still applied rather than falling back to the machine's
    // value.
    await db`
      WITH latest AS (
        SELECT DISTINCT ON (source_event_id, field) source_event_id, field, new_value
        FROM oee.downtime_report_history
        ORDER BY source_event_id, field, changed_at DESC, id DESC
      ),
      override AS (
        SELECT source_event_id,
               -- array_agg(...)[1], NOT max(): there is no max(jsonb) in
               -- Postgres, and DISTINCT ON has already reduced this to one row
               -- per (source_event_id, field), so taking the first element IS
               -- the pivot.
               (array_agg(new_value) FILTER (WHERE field = 'category'))[1]      AS category,
               bool_or(field = 'category')                                      AS has_category,
               (array_agg(new_value) FILTER (WHERE field = 'detail_reason'))[1] AS detail_reason,
               bool_or(field = 'detail_reason')                                 AS has_detail_reason
        FROM latest GROUP BY source_event_id
      )
      UPDATE oee.downtime_reports d
         SET category = CASE WHEN o.has_category
                             THEN (o.category #>> '{}')::oee.operation_type
                             ELSE d.category END,
             detail_reason = CASE WHEN o.has_detail_reason
                                  THEN o.detail_reason #>> '{}'
                                  ELSE d.detail_reason END
        FROM override o
       WHERE o.source_event_id = d.source_event_id
    `;

    const healed = await reader.getEditableStop(EVENT);
    expect(healed?.category).toBe("PLANNED");
    expect(healed?.detailReason).toBe("operator correction");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 0011's shape constraints on reason / actions / detail_reason
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THESE ARE TESTED AT ALL, given a CHECK either fires or it does not.
//
// Because HALF the specification is what they must TOLERATE, and that half is the
// easy one to get wrong while making the rejections stricter. Contract §3.9 says
// the reader "trims but does not case-fold" and that a duplicated element "counts
// once — but do not write one". A constraint that rejected duplicates or folded
// case would make a PIPELINE write fail where the reader is specified to cope —
// a contract change dressed as a constraint, and one that would only surface on a
// real load.
//
// The rejections matter too, and none of them throws on its own: a blank element
// becomes a Pareto bucket that is not the unlabelled one, and a non-string element
// makes the stop PERMANENTLY UNEDITABLE — toStringList drops it on read, so the
// browser sends `[]` as its concurrency baseline and every edit 412s.
//
// ─────────────────────────────────────────────────────────────────────────────
// The membership predicate after the lookback horizon was removed — §10 / §69
// ─────────────────────────────────────────────────────────────────────────────
//
// `scopeAndWindow` used to pair the real overlap test with a NARROWING on
// `date`, bounded by MAX_OPEN_DOWNTIME_DAYS = 7, purely so the scan stayed
// sargable. Its cost was a silent horizon: a stop open longer than a week fell
// out of every window that should have contained it, with no error anywhere. On
// 2026-09-02 the narrowing was replaced by a range `&&` matching
// `dt_reports_span_gist` (migration 0013), which serves the overlap directly.
//
// EXACTLY TWO BEHAVIOURS CHANGED, and both are pinned below because neither
// throws when it regresses — one renders a strip missing a stop, the other
// renders a strip containing a garbage one.
const HORIZON_WORK_UNIT = 4245;

describe.skipIf(!url)("the downtime membership predicate — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  const repo = new DowntimeReaderRepository({ goldDb: db });

  async function clean() {
    await db`DELETE FROM oee.downtime_reports WHERE work_unit_id = ${HORIZON_WORK_UNIT}`;
  }

  afterAll(async () => {
    await clean();
    await db.end();
  });
  beforeEach(clean);

  // These fixtures used to carry a `date` bucket set to the day the stop STARTED,
  // which was how the three-week-old stop below proved the old narrowing excluded
  // it before the overlap test ever ran. 0022 dropped the column, so the proof is
  // now structural rather than fixture-shaped: THERE IS NO DATE TO NARROW ON.
  // The cases are kept because they still pin the overlap semantics.
  async function stopAt(startAt: string, endAt: string | null, reason: string) {
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, shift, start_at, end_at, work_center_id)
      VALUES (${db.json([reason])}, 'UNPLANNED'::oee.operation_type,
              ${HORIZON_WORK_UNIT}, 1,
              ${new Date(startAt)}, ${endAt === null ? null : new Date(endAt)}, 99)
    `;
  }

  const overlapping = async () =>
    await repo.listOverlapping({ scope: "work-unit", scopeId: HORIZON_WORK_UNIT, window: WINDOW });

  it("keeps a stop that has been open far longer than the old seven-day horizon", async () => {
    // Three weeks before the window and still running. THE REGRESSION THIS
    // GUARDS IS INVISIBLE: with the narrowing back, this row is silently absent
    // from the strip, the Pareto and the frequency count, and every one of them
    // renders a completely plausible screen.
    await stopAt("2026-07-19T02:00:00Z", null, "open-three-weeks");

    expect(await overlapping()).toHaveLength(1);
  });

  it("still keeps an ordinary stop that started inside the window", async () => {
    await stopAt("2026-08-09T02:00:00Z", "2026-08-09T02:30:00Z", "ordinary");

    expect(await overlapping()).toHaveLength(1);
  });

  it("still excludes a stop that ends before the window opens", async () => {
    // The half-open contract, unchanged by the rewrite: `to` is exclusive on the
    // stop's side too, so a stop ending exactly at `from` does not reach in.
    await stopAt("2026-08-08T20:00:00Z", "2026-08-09T00:00:00Z", "before");

    expect(await overlapping()).toHaveLength(0);
  });

  // THE OTHER BEHAVIOUR CHANGE. `greatest(...)` collapses an inverted row to an
  // EMPTY range and `&&` never matches empty, so a malformed stop is now excluded
  // in the database instead of being returned and discarded by clipToWindow.
  // 0013's header anticipated this and called it the same outcome reached without
  // an exception — true for the strip, but it is why downtime_rows_dropped_total
  // can no longer see these rows. See metrics.ts and TODOS.md §70.
  it("excludes an inverted row rather than returning it to be discarded", async () => {
    await stopAt("2026-08-09T04:00:00Z", "2026-08-09T03:00:00Z", "inverted");

    expect(await overlapping()).toHaveLength(0);
  });

  // THE EXPRESSION MUST MATCH dt_reports_span_gist CHARACTER FOR CHARACTER or
  // the planner silently falls back to a sequential scan — nothing fails, the
  // page just degrades as the table grows, which is the failure no test would
  // ever catch by asserting rows.
  //
  // `enable_seqscan = off` is what makes this assertable on a fixture-sized
  // table: at six rows a seq scan is genuinely cheaper and the planner is right
  // to pick it, so this asks CAN the index serve this predicate rather than
  // WOULD it. A drifted expression still fails, because the planner cannot use a
  // GiST index it does not match even when a seq scan is penalised.
  //
  // The predicate is repeated here rather than imported — `scopeAndWindow` is
  // private and built from an interpolated Fragment. Its counterpart guard is
  // T-R4 in downtime-repository.test.ts, which pins the repository's own text
  // against the same expression; the two must be edited together.
  it("uses dt_reports_span_gist for the overlap", async () => {
    await stopAt("2026-08-09T02:00:00Z", "2026-08-09T02:30:00Z", "planned");

    // THE SCOPE PREDICATE IS OMITTED FROM THIS PROBE ON PURPOSE. With
    // `work_unit_id = ...` present the planner prefers dt_reports_wu_idx — a
    // plain btree — and relegates the range to a Filter, which is the correct
    // choice at fixture size and tells us nothing about the expression. Stripped
    // to the range alone, the GiST is the ONLY index that can serve it, so the
    // plan answers exactly the question at issue: does this expression still
    // match the index?
    //
    // Verified to discriminate rather than assumed. Dropping `greatest(...)` from
    // the expression below turns this plan into `Seq Scan / Disabled: true`, so a
    // drift fails here loudly instead of degrading silently in production.

    // INSIDE A TRANSACTION, WITH `SET LOCAL`, and that is not tidiness. postgres.js
    // POOLS: a bare `SET` and the EXPLAIN after it can land on two different
    // connections, so the planner setting silently does not apply and this test
    // fails only when another file happens to be holding the other connection.
    // Observed exactly that way. `SET LOCAL` also reverts at COMMIT, so a pooled
    // connection cannot escape with seqscans disabled — the same reasoning
    // asOperator() records for application_name.
    const text = await db.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const plan = await tx<Record<string, string>[]>`
        EXPLAIN (COSTS OFF)
        SELECT id FROM oee.downtime_reports
        WHERE tstzrange(start_at, greatest(coalesce(end_at, 'infinity'::timestamptz), start_at), '[)')
              && tstzrange(${WINDOW.from}, ${WINDOW.to}, '[)')
      `;
      return plan.map((r) => Object.values(r).join(" ")).join("\n");
    });

    expect(text).toContain("dt_reports_span_gist");
  });
});

// TODOS.md §40. Surveyed before constraining; the survey is in that entry.
const SHAPE_WORK_UNIT = 4244;

describe.skipIf(!url)("oee.downtime_reports shape constraints — real Postgres", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  async function insert(opts: {
    reason?: unknown;
    actions?: unknown;
    detailReason?: string | null;
  }): Promise<void> {
    await db`
      INSERT INTO oee.downtime_reports
        (reason, category, work_unit_id, shift, start_at, work_center_id,
         actions, detail_reason)
      VALUES (
        ${db.json((opts.reason ?? ["Machine_Stop"]) as never)}, 'UNPLANNED'::oee.operation_type,
        ${SHAPE_WORK_UNIT}, 1, '2026-08-09T01:00:00Z', 9,
        ${db.json((opts.actions ?? []) as never)}, ${opts.detailReason ?? null}
      )
    `;
  }

  beforeEach(async () => {
    await db`DELETE FROM oee.downtime_reports WHERE work_unit_id = ${SHAPE_WORK_UNIT}`;
  });

  afterAll(async () => {
    await db`DELETE FROM oee.downtime_reports WHERE work_unit_id = ${SHAPE_WORK_UNIT}`;
    await db.end();
  });

  // ---- what it must TOLERATE, which is the half worth guarding -----------------
  it.each([
    ["a normal array", { reason: ["Machine_Stop", "Material_Jam"] }],
    // `[]` is the unlabelled Pareto bucket, which the read path handles explicitly.
    ["an empty array", { reason: [] }],
    // §3.9: a duplicate counts once. The READER copes; the database must not refuse.
    ["duplicate elements", { reason: ["Machine_Stop", "Machine_Stop"] }],
    // §3.9: trims but does not case-fold, so these are two reasons by design.
    ["case variants of one label", { reason: ["Machine_Stop", "machine_stop"] }],
    ["a label exactly at the 255 bound", { reason: ["x".repeat(255)] }],
    ["an empty actions array", { actions: [] }],
    // NULL is what "the operator cleared this" looks like, and contract §13's
    // CASE WHEN exists to preserve exactly that.
    ["a null detail_reason", { detailReason: null }],
    ["a detail_reason exactly at the 2000 bound", { detailReason: "y".repeat(2000) }],
  ])("accepts %s", async (_label, opts) => {
    await expect(insert(opts)).resolves.not.toThrow();
  });

  // ---- what it must REJECT ----------------------------------------------------
  it.each([
    ["a blank element", { reason: [""] }, /ck_downtime_reports_reason/],
    ["a whitespace-only element", { reason: ["   "] }, /ck_downtime_reports_reason/],
    // The one that makes a stop permanently uneditable if it gets in.
    ["a non-string element", { reason: [{ code: 7 }] }, /ck_downtime_reports_reason/],
    ["a nested array", { reason: [["Machine_Stop"]] }, /ck_downtime_reports_reason/],
    ["a label one over the bound", { reason: ["x".repeat(256)] }, /ck_downtime_reports_reason/],
    ["an object where an array belongs", { reason: { a: 1 } }, /ck_downtime_reports_reason/],
    // actions carries the SAME guard, and naming it separately is what proves the
    // constraint was applied twice rather than once.
    ["a blank actions element", { actions: ["  "] }, /ck_downtime_reports_actions/],
    [
      "a detail_reason one over the bound",
      { detailReason: "y".repeat(2001) },
      /ck_downtime_reports_detail_reason/,
    ],
  ])("rejects %s", async (_label, opts, constraint) => {
    await expect(insert(opts)).rejects.toThrow(constraint);
  });

  // The function is what makes the CHECK possible at all — a CHECK admits no
  // subquery, so the EXISTS has to live behind an IMMUTABLE function. If it were
  // ever recreated as VOLATILE the constraint could not be added.
  it("exposes the guard as an IMMUTABLE, parallel-safe function", async () => {
    const [row] = await db<{ volatility: string; parallel: string }[]>`
      SELECT provolatile AS volatility, proparallel AS parallel
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'oee' AND p.proname = 'jsonb_is_label_array'
    `;
    // 'i' = immutable, 's' = parallel safe.
    expect(row).toEqual({ volatility: "i", parallel: "s" });
  });
});
