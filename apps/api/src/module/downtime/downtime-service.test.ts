import { describe, it, expect, vi } from "vite-plus/test";

import { DowntimeTimelineService, flattenTimeline } from "./downtime-service.js";

import type {
  DowntimeCategory,
  DowntimeEvent,
  TimelineSegment,
  TimelineWindow,
} from "./downtime.js";
import type { DowntimeReader, DowntimeWriter } from "./downtime-repository.js";
import type { TimeZoneResolverContract } from "../master-data/time-zone-resolver.js";
import type { OperatorRoles } from "../../shared/config/config.js";
import type { Actor } from "../../shared/actor.js";

// The flatten algorithm is time-zone agnostic — it only ever compares instants —
// so the fixtures use a plain UTC day. The wall-clock-to-instant conversion is
// Postgres' job and is asserted in downtime-repository.test.ts.
function at(hhmm: string): Date {
  return new Date(`2026-08-09T${hhmm}:00.000Z`);
}

// Stands in for shift 1: 07:00 -> 15:00.
const WINDOW: TimelineWindow = { from: at("07:00"), to: at("15:00") };

// What aggregateByReason returns for a shift with nothing to show. The default
// for every setup() below, so a test that cares about buckets has to say so.
const EMPTY_AGGREGATE = {
  buckets: [],
  groupCount: 0,
  totalFrequency: 0,
  totalDurationMs: 0,
  dropped: 0,
};

let nextId = 1;

function event(category: DowntimeCategory, start: string, end: string | null): DowntimeEvent {
  return {
    id: nextId++,
    category,
    startAt: at(start),
    endAt: end === null ? null : at(end),
  };
}

// A compact view of the result, so a case reads as the picture it is testing.
function shape(segments: TimelineSegment[]): string[] {
  return segments.map(
    (s) =>
      `${s.startAt.toISOString().slice(11, 16)}-${s.endAt.toISOString().slice(11, 16)} ${s.kind}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The three properties that must hold for EVERY output, whatever the input:
//
//   1. each segment is non-empty, and durationMs agrees with its own bounds
//   2. the segments tile [from, to) exactly — start at `from`, end at `to`,
//      and every neighbour meets edge to edge (no gap, no overlap)
//   3. no two adjacent segments share a kind (fully coalesced)
//
// Asserted alongside every enumerated case, because the enumerated expectations
// only check what the author thought to look at.
// ─────────────────────────────────────────────────────────────────────────────
function expectValidTimeline(segments: TimelineSegment[], window: TimelineWindow) {
  expect(segments.length).toBeGreaterThan(0);

  expect(segments[0]!.startAt.getTime()).toBe(window.from.getTime());
  expect(segments.at(-1)!.endAt.getTime()).toBe(window.to.getTime());

  for (const [i, segment] of segments.entries()) {
    expect(segment.endAt.getTime()).toBeGreaterThan(segment.startAt.getTime());
    expect(segment.durationMs).toBe(segment.endAt.getTime() - segment.startAt.getTime());

    const next = segments[i + 1];
    if (next === undefined) continue;
    expect(next.startAt.getTime()).toBe(segment.endAt.getTime());
    expect(next.kind).not.toBe(segment.kind);
  }
}

// `now` sits after the window closes unless a case says otherwise, which is the
// normal state for a historical shift report.
const AFTER_SHIFT = at("18:00");

describe("flattenTimeline", () => {
  it("T-F11: returns one full-window RUN_TIME segment when there are no events", () => {
    const { segments, dropped } = flattenTimeline([], WINDOW, AFTER_SHIFT);

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual(["07:00-15:00 RUN_TIME"]);
    expect(dropped).toBe(0);
  });

  it("T-F9: fills the stretches no record covers with RUN_TIME", () => {
    const { segments } = flattenTimeline([event("PLANNED", "09:00", "10:00")], WINDOW, AFTER_SHIFT);

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-09:00 RUN_TIME",
      "09:00-10:00 PLANNED",
      "10:00-15:00 RUN_TIME",
    ]);
  });

  it("T-F1: clips a record that began before the window", () => {
    const { segments } = flattenTimeline(
      [event("UNPLANNED", "05:30", "08:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual(["07:00-08:00 UNPLANNED", "08:00-15:00 RUN_TIME"]);
  });

  it("T-F2: clips a record that runs past the window", () => {
    const { segments } = flattenTimeline(
      [event("UNPLANNED", "14:00", "16:30")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual(["07:00-14:00 RUN_TIME", "14:00-15:00 UNPLANNED"]);
  });

  it("T-F3: an open record reaches `now` while the shift is still running", () => {
    const { segments } = flattenTimeline(
      [event("UNPLANNED", "12:00", null)],
      WINDOW,
      at("13:30"), // mid-shift
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-12:00 RUN_TIME",
      "12:00-13:30 UNPLANNED",
      "13:30-15:00 RUN_TIME",
    ]);
  });

  it("T-F3: an open record is clipped to the window end once the shift has closed", () => {
    const { segments } = flattenTimeline([event("PLANNED", "12:00", null)], WINDOW, AFTER_SHIFT);

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual(["07:00-12:00 RUN_TIME", "12:00-15:00 PLANNED"]);
  });

  it("T-F4: drops a record that falls entirely outside the window", () => {
    const { segments, dropped } = flattenTimeline(
      [event("UNPLANNED", "03:00", "04:00"), event("PLANNED", "16:00", "17:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual(["07:00-15:00 RUN_TIME"]);
    expect(dropped).toBe(2);
  });

  it("T-F5: drops an inverted record rather than emitting a negative-width segment", () => {
    const { segments, dropped } = flattenTimeline(
      [event("UNPLANNED", "11:00", "09:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual(["07:00-15:00 RUN_TIME"]);
    expect(dropped).toBe(1);
  });

  it("T-F5: drops a zero-length record", () => {
    const { segments, dropped } = flattenTimeline(
      [event("SMALL_STOP", "10:00", "10:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expect(shape(segments)).toEqual(["07:00-15:00 RUN_TIME"]);
    expect(dropped).toBe(1);
  });

  it("T-F5: drops an open record whose clock skew puts `now` before it began", () => {
    const { segments, dropped } = flattenTimeline(
      [event("UNPLANNED", "13:00", null)],
      WINDOW,
      at("12:00"),
    );

    expect(shape(segments)).toEqual(["07:00-15:00 RUN_TIME"]);
    expect(dropped).toBe(1);
  });

  // The rule confirmed against the design's worked example: where two records
  // cover the same minutes, the WEAKER category renders. This inverts the
  // conventional OEE reading, so it gets the most direct test in the file.
  it("T-F6: the weaker category wins an overlap (PLANNED over UNPLANNED)", () => {
    const { segments } = flattenTimeline(
      [event("UNPLANNED", "08:00", "12:00"), event("PLANNED", "09:00", "11:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-08:00 RUN_TIME",
      "08:00-09:00 UNPLANNED",
      "09:00-11:00 PLANNED",
      "11:00-12:00 UNPLANNED",
      "12:00-15:00 RUN_TIME",
    ]);
  });

  it("T-F6: SMALL_STOP outranks PLANNED, completing the priority chain", () => {
    const { segments } = flattenTimeline(
      [event("PLANNED", "09:00", "11:00"), event("SMALL_STOP", "10:00", "10:30")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-09:00 RUN_TIME",
      "09:00-10:00 PLANNED",
      "10:00-10:30 SMALL_STOP",
      "10:30-11:00 PLANNED",
      "11:00-15:00 RUN_TIME",
    ]);
  });

  it("T-F7: two overlapping records of the same category coalesce into one segment", () => {
    const { segments } = flattenTimeline(
      [event("UNPLANNED", "09:00", "11:00"), event("UNPLANNED", "10:00", "12:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-09:00 RUN_TIME",
      "09:00-12:00 UNPLANNED",
      "12:00-15:00 RUN_TIME",
    ]);
  });

  it("T-F8: a record nested entirely inside a stronger one still shows through", () => {
    const { segments } = flattenTimeline(
      [event("UNPLANNED", "09:00", "12:00"), event("SMALL_STOP", "10:00", "10:15")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-09:00 RUN_TIME",
      "09:00-10:00 UNPLANNED",
      "10:00-10:15 SMALL_STOP",
      "10:15-12:00 UNPLANNED",
      "12:00-15:00 RUN_TIME",
    ]);
  });

  it("T-F10: records that merely touch produce one segment, not two", () => {
    const { segments } = flattenTimeline(
      [event("PLANNED", "09:00", "10:00"), event("PLANNED", "10:00", "11:00")],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(shape(segments)).toEqual([
      "07:00-09:00 RUN_TIME",
      "09:00-11:00 PLANNED",
      "11:00-15:00 RUN_TIME",
    ]);
  });

  it("holds its invariants on a dense, messy shift", () => {
    const { segments } = flattenTimeline(
      [
        event("UNPLANNED", "06:00", "07:30"),
        event("SMALL_STOP", "07:20", "07:25"),
        event("PLANNED", "07:25", "09:00"),
        event("UNPLANNED", "08:30", "08:45"),
        event("SMALL_STOP", "11:00", "11:02"),
        event("SMALL_STOP", "11:02", "11:04"),
        event("PLANNED", "14:00", null),
      ],
      WINDOW,
      AFTER_SHIFT,
    );

    expectValidTimeline(segments, WINDOW);
    expect(segments.at(-1)!.kind).toBe("PLANNED");
  });

  // Shift 3 spans midnight. The algorithm never looks at calendar days, but the
  // case is cheap and it is the one the design flags as special.
  it("T-W3: works across a midnight-crossing window", () => {
    const nightWindow: TimelineWindow = {
      from: new Date("2026-08-09T23:00:00.000Z"),
      to: new Date("2026-08-10T07:00:00.000Z"),
    };

    const { segments } = flattenTimeline(
      [
        {
          id: 99,
          category: "UNPLANNED",
          startAt: new Date("2026-08-09T23:30:00.000Z"),
          endAt: new Date("2026-08-10T01:00:00.000Z"),
        },
      ],
      nightWindow,
      new Date("2026-08-10T09:00:00.000Z"),
    );

    expectValidTimeline(segments, nightWindow);
    expect(segments.map((s) => s.kind)).toEqual(["RUN_TIME", "UNPLANNED", "RUN_TIME"]);
  });
});

describe("DowntimeTimelineService", () => {
  function setup(
    events: DowntimeEvent[] = [],
    page: { items: unknown[]; totalElements: number } = { items: [], totalElements: 0 },
    resolver: TimeZoneResolverContract["resolve"] = vi.fn().mockResolvedValue("Asia/Jakarta"),
  ) {
    const getWindow = vi.fn().mockResolvedValue(WINDOW);
    const listOverlapping = vi.fn().mockResolvedValue(events);
    const paginateDowntime = vi.fn().mockResolvedValue(page);
    const aggregateByReason = vi.fn().mockResolvedValue(EMPTY_AGGREGATE);
    const aggregateByAction = vi.fn().mockResolvedValue(EMPTY_AGGREGATE);
    const paginateByReason = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
    const aggregateOneReason = vi.fn().mockResolvedValue(null);
    const listReasonHistory = vi
      .fn()
      .mockResolvedValue({ entries: [], totalMembers: 0, trackedMembers: 0 });
    const getDowntimeWatermark = vi.fn().mockResolvedValue(null);
    // undefined is what EVERY stop returns today: the pipeline does not write
    // source_event_id, so no stop is addressable by the edit path at all.
    const getEditableStop = vi.fn().mockResolvedValue(undefined);
    const editDowntime = vi.fn();
    // No approval row anywhere means every report is open — 0010's rule, and the
    // state that lets an edit through.
    const listApprovalsOverlapping = vi.fn().mockResolvedValue([]);

    const service = new DowntimeTimelineService({
      downtimeReaderRepository: {
        getWindow,
        listOverlapping,
        paginateDowntime,
        aggregateByReason,
        aggregateByAction,
        paginateByReason,
        aggregateOneReason,
        listReasonHistory,
        getDowntimeWatermark,
        getEditableStop,
      } satisfies Record<keyof DowntimeReader, ReturnType<typeof vi.fn>>,
      downtimeWriterRepository: { editDowntime } satisfies Record<
        keyof DowntimeWriter,
        ReturnType<typeof vi.fn>
      >,
      workUnitReportReaderRepository: { listApprovalsOverlapping },
      timeZoneResolver: { resolve: resolver },
      // Ungated: every field undefined, so requireRole is a no-op.
      operatorRoles: {},
    });

    return {
      service,
      getWindow,
      listOverlapping,
      paginateDowntime,
      getDowntimeWatermark,
      resolve: resolver,
    };
  }

  // TODOS.md §8. A shift with no downtime rows renders as ONE full-width RUN_TIME
  // band, and no rows has two opposite causes: the machine ran clean, or the
  // downtime ETL has not reached this day. The flattering reading was winning —
  // a shift that was down for hours looked flawless, with no error and no empty
  // state. This field is the only thing that separates them.
  it("reports how far the downtime table has loaded", async () => {
    const { service, getDowntimeWatermark } = setup();
    getDowntimeWatermark.mockResolvedValue("2026-08-09");

    const out = await service.getTimeline({
      scope: "work-unit",
      scopeId: 42,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(out.loadedThrough).toBe("2026-08-09");
  });

  // A MISSING WATERMARK ROW MEANS NEVER LOADED, which is a third state and must
  // not be coerced into a date — "loaded through the epoch" would read as loaded.
  it("reports null when the downtime table has never been loaded", async () => {
    const { service } = setup();

    const out = await service.getTimeline({
      scope: "work-unit",
      scopeId: 42,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(out.loadedThrough).toBeNull();
  });

  // Its OWN statement, never a join onto the event query. A joined watermark
  // vanishes when no downtime rows match — and no rows is precisely the case this
  // value exists to explain, so the join would drop it exactly when it was needed.
  it("asks for the watermark even when the shift has no downtime at all", async () => {
    const { service, getDowntimeWatermark } = setup([]);

    await service.getTimeline({
      scope: "work-unit",
      scopeId: 42,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(getDowntimeWatermark).toHaveBeenCalledTimes(1);
  });

  it("resolves the window first and passes it to the event query", async () => {
    const { service, getWindow, listOverlapping } = setup();

    await service.getTimeline({
      scope: "work-unit",
      scopeId: 42,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(getWindow).toHaveBeenCalledWith("shift", "2026-08-09", "1", "Asia/Jakarta");
    expect(listOverlapping).toHaveBeenCalledWith({
      scope: "work-unit",
      scopeId: 42,
      window: WINDOW,
    });
  });

  it("resolves the zone for the scope under request", async () => {
    const { service, resolve } = setup();

    await service.getTimeline({
      scope: "work-center",
      scopeId: 7,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(resolve).toHaveBeenCalledWith("work-center", 7);
  });

  // The assertions above all pin "Asia/Jakarta", which a hardcoded default would
  // satisfy just as well. This is the one that proves the zone actually comes
  // from the resolver: a different site's zone has to reach BOTH the window
  // arithmetic and the response.
  it("uses whatever zone the resolver returns, not a fixed one", async () => {
    const { service, getWindow } = setup([], undefined, vi.fn().mockResolvedValue("Asia/Makassar"));

    const timeline = await service.getTimeline({
      scope: "work-unit",
      scopeId: 42,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(getWindow).toHaveBeenCalledWith("shift", "2026-08-09", "1", "Asia/Makassar");
    expect(timeline.timeZone).toBe("Asia/Makassar");
  });

  // A shift window computed against a guessed zone renders as plausible-looking
  // data, so a resolution failure must reach the caller rather than be absorbed
  // into a default.
  it("propagates a resolution failure instead of falling back to a default", async () => {
    const { service, getWindow } = setup(
      [],
      undefined,
      vi.fn().mockRejectedValue(new Error("upstream down")),
    );

    await expect(
      service.getTimeline({
        scope: "work-unit",
        scopeId: 42,
        date: "2026-08-09",
        shift: "1",
        grain: "shift",
      }),
    ).rejects.toThrow("upstream down");
    expect(getWindow).not.toHaveBeenCalled();
  });

  it("echoes the window and the resolved time zone alongside the segments", async () => {
    const { service } = setup([event("PLANNED", "09:00", "10:00")]);

    const timeline = await service.getTimeline({
      scope: "work-center",
      scopeId: 7,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(timeline.from).toEqual(WINDOW.from);
    expect(timeline.to).toEqual(WINDOW.to);
    expect(timeline.timeZone).toBe("Asia/Jakarta");
    expectValidTimeline(timeline.segments, WINDOW);
  });

  // The endpoint answers 200 whether or not any downtime exists, so an empty
  // table and a clean shift are indistinguishable by design — see TODOS.md.
  it("answers a clean shift with a single RUN_TIME band", async () => {
    const { service } = setup([]);

    const timeline = await service.getTimeline({
      scope: "work-unit",
      scopeId: 1,
      date: "2026-08-09",
      shift: "1",
      grain: "shift",
    });

    expect(timeline.segments).toHaveLength(1);
    expect(timeline.segments[0]!.kind).toBe("RUN_TIME");
  });
});

describe("DowntimeTimelineService.getPagedDowntime", () => {
  const ROW = {
    id: 3,
    category: "SMALL_STOP" as const,
    reason: ["A1_Filling_Servo_OL"],
    actions: [],
    workUnitName: "Molca Packer N",
    startAt: at("07:23"),
    endAt: at("07:24"),
    durationMs: 60_000,
  };

  function setup(items: unknown[] = [ROW], totalElements = 50, timeZone = "Asia/Jakarta") {
    const getWindow = vi.fn().mockResolvedValue(WINDOW);
    const listOverlapping = vi.fn().mockResolvedValue([]);
    const paginateDowntime = vi.fn().mockResolvedValue({ items, totalElements });
    const aggregateByReason = vi.fn().mockResolvedValue(EMPTY_AGGREGATE);
    const aggregateByAction = vi.fn().mockResolvedValue(EMPTY_AGGREGATE);
    const paginateByReason = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
    const aggregateOneReason = vi.fn().mockResolvedValue(null);
    const listReasonHistory = vi
      .fn()
      .mockResolvedValue({ entries: [], totalMembers: 0, trackedMembers: 0 });
    const getDowntimeWatermark = vi.fn().mockResolvedValue(null);
    // undefined is what EVERY stop returns today: the pipeline does not write
    // source_event_id, so no stop is addressable by the edit path at all.
    const getEditableStop = vi.fn().mockResolvedValue(undefined);
    const editDowntime = vi.fn();
    // No approval row anywhere means every report is open — 0010's rule, and the
    // state that lets an edit through.
    const listApprovalsOverlapping = vi.fn().mockResolvedValue([]);
    const resolve = vi.fn().mockResolvedValue(timeZone);

    const service = new DowntimeTimelineService({
      downtimeReaderRepository: {
        getWindow,
        listOverlapping,
        paginateDowntime,
        aggregateByReason,
        aggregateByAction,
        paginateByReason,
        aggregateOneReason,
        listReasonHistory,
        getDowntimeWatermark,
        getEditableStop,
      } satisfies Record<keyof DowntimeReader, ReturnType<typeof vi.fn>>,
      downtimeWriterRepository: { editDowntime } satisfies Record<
        keyof DowntimeWriter,
        ReturnType<typeof vi.fn>
      >,
      workUnitReportReaderRepository: { listApprovalsOverlapping },
      timeZoneResolver: { resolve },
      operatorRoles: {},
    });

    return { service, getWindow, paginateDowntime, resolve };
  }

  const FILTER = {
    scope: "work-unit" as const,
    scopeId: 42,
    date: "2026-08-09",
    shift: "1" as const,
    grain: "shift" as const,
  };
  const SORT = { sortBy: "startAt" as const, sortDir: "desc" as const };

  it("resolves the same window the timeline uses, so both views agree", async () => {
    const { service, getWindow, paginateDowntime } = setup();

    await service.getPagedDowntime(1, 5, FILTER, SORT);

    expect(getWindow).toHaveBeenCalledWith("shift", "2026-08-09", "1", "Asia/Jakarta");
    expect(paginateDowntime).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "work-unit", scopeId: 42, window: WINDOW }),
    );
  });

  it("turns page/size into limit/offset", async () => {
    const { service, paginateDowntime } = setup();

    await service.getPagedDowntime(3, 5, FILTER, SORT);

    expect(paginateDowntime).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 10 }),
    );
  });

  it("stamps the resolved time zone onto every row", async () => {
    const { service } = setup();

    const { items } = await service.getPagedDowntime(1, 5, FILTER, SORT);

    expect(items[0]!.timeZone).toBe("Asia/Jakarta");
    expect(items[0]!.reason).toEqual(["A1_Filling_Servo_OL"]);
  });

  // The table and the strip above it must agree on the zone, or a row's clock
  // reading would contradict where its band sits.
  it("resolves the same scope's zone the timeline does", async () => {
    const { service, getWindow, resolve } = setup([ROW], 50, "Asia/Makassar");

    const { items } = await service.getPagedDowntime(1, 5, FILTER, SORT);

    expect(resolve).toHaveBeenCalledWith("work-unit", 42);
    expect(getWindow).toHaveBeenCalledWith("shift", "2026-08-09", "1", "Asia/Makassar");
    expect(items[0]!.timeZone).toBe("Asia/Makassar");
  });

  // totalElements is what the card shows as "Downtime Frequency", so the meta
  // has to survive the mapping intact.
  it("builds page meta from the total, which is the frequency figure", async () => {
    const { service } = setup([ROW], 50);

    const { meta } = await service.getPagedDowntime(1, 5, FILTER, SORT);

    expect(meta).toEqual({
      page: 1,
      size: 5,
      totalElements: 50,
      totalPages: 10,
      first: true,
      last: false,
    });
  });

  it("reports an empty shift as zero pages rather than one blank one", async () => {
    const { service } = setup([], 0);

    const { items, meta } = await service.getPagedDowntime(1, 5, FILTER, SORT);

    expect(items).toEqual([]);
    expect(meta.totalPages).toBe(0);
    expect(meta.last).toBe(true);
  });
});

describe("DowntimeTimelineService.getReasonBreakdown", () => {
  const BUCKET = {
    reason: "Mlipit",
    workUnitNames: ["Molca Packer N"],
    frequency: 3,
    durationMs: 2_844_000,
  };

  // ONE bucket shown out of ONE group, so the default case has no tail — which is
  // what a machine shift looks like, and what every case below except the tail's
  // own should see.
  const AGGREGATE = {
    buckets: [BUCKET],
    groupCount: 1,
    totalFrequency: 5,
    totalDurationMs: 3_826_000,
    dropped: 0,
  };

  function setup(
    aggregate: unknown = AGGREGATE,
    loadedThrough: string | null = "2026-08-10",
    timeZone = "Asia/Jakarta",
  ) {
    const getWindow = vi.fn().mockResolvedValue(WINDOW);
    const listOverlapping = vi.fn().mockResolvedValue([]);
    const paginateDowntime = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
    const aggregateByReason = vi.fn().mockResolvedValue(aggregate);
    const aggregateByAction = vi.fn().mockResolvedValue(aggregate);
    const paginateByReason = vi.fn().mockResolvedValue({ items: [], totalElements: 0 });
    const aggregateOneReason = vi.fn().mockResolvedValue(null);
    const listReasonHistory = vi
      .fn()
      .mockResolvedValue({ entries: [], totalMembers: 0, trackedMembers: 0 });
    const getDowntimeWatermark = vi.fn().mockResolvedValue(loadedThrough);
    const resolve = vi.fn().mockResolvedValue(timeZone);
    const getEditableStop = vi.fn().mockResolvedValue(undefined);
    const editDowntime = vi.fn();
    const listApprovalsOverlapping = vi.fn().mockResolvedValue([]);

    const service = new DowntimeTimelineService({
      downtimeReaderRepository: {
        getWindow,
        listOverlapping,
        paginateDowntime,
        aggregateByReason,
        aggregateByAction,
        paginateByReason,
        aggregateOneReason,
        listReasonHistory,
        getDowntimeWatermark,
        getEditableStop,
      } satisfies Record<keyof DowntimeReader, ReturnType<typeof vi.fn>>,
      downtimeWriterRepository: { editDowntime } satisfies Record<
        keyof DowntimeWriter,
        ReturnType<typeof vi.fn>
      >,
      workUnitReportReaderRepository: { listApprovalsOverlapping },
      timeZoneResolver: { resolve },
      operatorRoles: {},
    });

    return { service, getWindow, aggregateByReason, getDowntimeWatermark, resolve };
  }

  const FILTER = {
    scope: "work-unit" as const,
    scopeId: 42,
    date: "2026-08-09",
    shift: "1" as const,
    grain: "shift" as const,
    category: "UNPLANNED" as const,
    // The endpoint's own defaults, so the cases below read as they did before the
    // response grew a limit. The truncation has its own cases at the end.
    measure: "duration" as const,
    limit: 20,
  };

  // The guarantee that the Pareto, the strip and the detail table are drawn from
  // one definition of "belongs to this shift". A second getWindow call, or a
  // window built anywhere else, would break it silently.
  it("resolves the window once and passes that same object to the aggregate", async () => {
    const { service, getWindow, aggregateByReason } = setup();

    await service.getReasonBreakdown(FILTER);

    expect(getWindow).toHaveBeenCalledWith("shift", "2026-08-09", "1", "Asia/Jakarta");
    expect(aggregateByReason).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "work-unit", scopeId: 42, window: WINDOW }),
    );
  });

  // A hardcoded Asia/Jakarta would pass every other test in this file.
  it("uses the resolver's zone rather than a fixed one", async () => {
    const { service, getWindow } = setup(AGGREGATE, "2026-08-10", "Asia/Makassar");

    const result = await service.getReasonBreakdown(FILTER);

    expect(getWindow).toHaveBeenCalledWith("shift", "2026-08-09", "1", "Asia/Makassar");
    expect(result.timeZone).toBe("Asia/Makassar");
  });

  it("passes the category through and stamps a clock the repository can clip with", async () => {
    const { service, aggregateByReason } = setup();

    await service.getReasonBreakdown({ ...FILTER, category: "PLANNED" });

    expect(aggregateByReason).toHaveBeenCalledWith(
      expect.objectContaining({ category: "PLANNED", now: expect.any(Date) }),
    );
  });

  it("does not query when the zone cannot be resolved", async () => {
    const { service, getWindow, aggregateByReason, resolve } = setup();
    resolve.mockRejectedValueOnce(new Error("upstream unavailable"));

    await expect(service.getReasonBreakdown(FILTER)).rejects.toThrow("upstream unavailable");
    expect(getWindow).not.toHaveBeenCalled();
    expect(aggregateByReason).not.toHaveBeenCalled();
  });

  // The one case the watermark exists for. A lazy `if (buckets.length)` around
  // the read would leave an empty tab unable to say WHY it is empty.
  it("still reads the watermark when there are no buckets", async () => {
    const { service, getDowntimeWatermark } = setup({ ...AGGREGATE, buckets: [] });

    const result = await service.getReasonBreakdown(FILTER);

    expect(getDowntimeWatermark).toHaveBeenCalled();
    expect(result.loadedThrough).toBe("2026-08-10");
  });

  // Unlike getPerformance, there is no report here that could be unknown — an
  // empty breakdown is a legitimate answer about a real shift.
  it("answers with an empty breakdown rather than throwing when nothing matched", async () => {
    const { service } = setup({ buckets: [], totalFrequency: 0, totalDurationMs: 0, dropped: 0 });

    const result = await service.getReasonBreakdown(FILTER);

    expect(result.buckets).toEqual([]);
    expect(result.totalDurationMs).toBe(0);
  });

  it("echoes the window and the category so the durations are interpretable", async () => {
    const { service } = setup();

    const result = await service.getReasonBreakdown(FILTER);

    expect(result.from).toBe(WINDOW.from);
    expect(result.to).toBe(WINDOW.to);
    expect(result.category).toBe("UNPLANNED");
  });

  // The cumulative line's denominators. Summing the buckets instead would be
  // wrong the day this grows a LIMIT and an "Other" bucket.
  it("carries the totals through untouched", async () => {
    const { service } = setup();

    const result = await service.getReasonBreakdown(FILTER);

    expect(result.totalFrequency).toBe(5);
    expect(result.totalDurationMs).toBe(3_826_000);
  });

  // `dropped` is an operational signal about data quality, not something the
  // browser has any use for.
  it("keeps the dropped count out of the response", async () => {
    const { service } = setup({ ...AGGREGATE, dropped: 2 });

    const result = await service.getReasonBreakdown(FILTER);

    expect(result).not.toHaveProperty("dropped");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The truncated tail (TODOS §25)
  // ───────────────────────────────────────────────────────────────────────────
  //
  // DERIVED FROM THE TOTALS, NOT QUERIED. Both halves are subtractions against
  // figures the totals query already returned over the same clipped rows, so the
  // tail cannot disagree with the denominators the cumulative line divides by —
  // which a third query could, if a stop closed between the two.

  it("reports no tail when every group was returned", async () => {
    const { service } = setup();

    expect((await service.getReasonBreakdown(FILTER)).other).toBeNull();
  });

  // NULL rather than a zero-filled object, so the browser renders no "Other" bar
  // at all instead of an empty one sitting at the end of every chart.
  it("reports no tail for an empty window", async () => {
    const { service } = setup(EMPTY_AGGREGATE);

    expect((await service.getReasonBreakdown(FILTER)).other).toBeNull();
  });

  it("derives the tail from the totals when groups were truncated", async () => {
    const { service } = setup({
      buckets: [BUCKET],
      // Four groups existed; one came back.
      groupCount: 4,
      totalFrequency: 10,
      totalDurationMs: 5_000_000,
      dropped: 0,
    });

    expect((await service.getReasonBreakdown(FILTER)).other).toEqual({
      reasonCount: 3,
      frequency: 10 - BUCKET.frequency,
      durationMs: 5_000_000 - BUCKET.durationMs,
    });
  });

  // THE INVARIANT THE CUMULATIVE LINE DEPENDS ON: shown + tail == the totals. If
  // it ever fails, the browser's line either stops short of 100% or overshoots it,
  // and both look like a rendering bug rather than a data one.
  it("keeps shown plus tail equal to the totals", async () => {
    const { service } = setup({
      buckets: [BUCKET, { ...BUCKET, reason: "Other stop", frequency: 2, durationMs: 500_000 }],
      groupCount: 9,
      totalFrequency: 40,
      totalDurationMs: 9_000_000,
      dropped: 0,
    });

    const out = await service.getReasonBreakdown(FILTER);
    const shownFrequency = out.buckets.reduce((n, b) => n + b.frequency, 0);
    const shownDurationMs = out.buckets.reduce((n, b) => n + b.durationMs, 0);

    expect(shownFrequency + (out.other?.frequency ?? 0)).toBe(out.totalFrequency);
    expect(shownDurationMs + (out.other?.durationMs ?? 0)).toBe(out.totalDurationMs);
  });

  // NOT ASSERTED HERE, BUT WORTH KNOWING: the downtime_reason_groups histogram
  // records `groupCount`, not `buckets.length`. Its job (metrics.ts) is to say
  // when a scope stops being small, and after a LIMIT the bucket count is pinned
  // at the limit for every wide request — which is exactly the reading it exists
  // to give. This file mocks no instruments, so that line is covered by reading
  // it rather than by a spy; if this suite ever gains a metrics double, it is the
  // first thing to point at.

  it("passes the caller's measure and limit through to the repository", async () => {
    const { service, aggregateByReason } = setup();

    await service.getReasonBreakdown({ ...FILTER, measure: "frequency", limit: 5 });

    expect(aggregateByReason).toHaveBeenCalledWith(
      expect.objectContaining({ measure: "frequency", limit: 5 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// editDowntime — the freeze, the outcome mapping, and the counters
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS SUITE OWNS, and what it deliberately leaves alone. The service is the
// layer that decides WHETHER an edit may proceed and WHICH HTTP status each
// outcome becomes. The diff itself, the guarded UPDATE and the history rows are
// the repository's and are asserted in downtime-repository.test.ts — over a real
// Postgres for the parts a fakeSql cannot reach.
//
// The freeze is the part worth reading. A stop straddling 23:00 belongs to BOTH
// shifts it touches, so listApprovalsOverlapping returns every report the stop
// covers and ANY closed one refuses the edit. Checking only the stop's own shift
// would let an edit silently move a signed-off report's availability loss, with
// nothing in that report's trail to show it.
describe("DowntimeTimelineService.editDowntime", () => {
  const EDIT = {
    category: "UNPLANNED" as DowntimeCategory,
    reason: ["Machine_Stop"],
    detailReason: "belt slipped",
    actions: ["Realigned"],
  };

  // A stop that starts in shift 2 and runs past 23:00 into shift 3 — the case the
  // whole freeze design exists for.
  const STRADDLING_STOP = {
    id: 7,
    sourceEventId: "evt-1",
    workUnitId: 3,
    startAt: new Date("2026-08-09T15:40:00.000Z"),
    endAt: new Date("2026-08-09T16:20:00.000Z"),
    reason: ["Machine_Stop"],
    actions: ["Realigned"],
    category: "UNPLANNED" as DowntimeCategory,
    workUnitName: "Vertical Packer N",
    workCenterName: "Line 1",
    areaName: null,
    detailReason: "belt slipped",
    inputBy: null,
    maintainedBy: null,
  };

  // roles: [] — these cases run with EDIT_DOWNTIME_ROLE unset, so requireRole
  // returns before reading it. The gate is covered separately.
  const ACTOR = { subject: "u1", name: "dewi", roles: [] };

  function setup(
    overrides: {
      stop?: unknown;
      approvals?: { shift: number; status: "open" | "closed" }[];
      outcome?: unknown;
      // TODOS.md §34. Absent means EDIT_DOWNTIME_ROLE unset, which is every
      // deployment today.
      operatorRoles?: OperatorRoles;
    } = {},
  ) {
    // `in` rather than `??`: the whole point of one case is a stop that is
    // ABSENT, and `overrides.stop ?? DEFAULT` would silently hand it the default.
    const getEditableStop = vi
      .fn()
      .mockResolvedValue("stop" in overrides ? overrides.stop : STRADDLING_STOP);
    const listApprovalsOverlapping = vi.fn().mockResolvedValue(overrides.approvals ?? []);
    const editDowntime = vi
      .fn()
      .mockResolvedValue(
        overrides.outcome ?? { kind: "edited", row: STRADDLING_STOP, changed: ["category"] },
      );
    const resolve = vi.fn().mockResolvedValue("Asia/Jakarta");

    const service = new DowntimeTimelineService({
      downtimeReaderRepository: {
        getWindow: vi.fn(),
        listOverlapping: vi.fn(),
        paginateDowntime: vi.fn(),
        aggregateByReason: vi.fn(),
        paginateByReason: vi.fn(),
        aggregateOneReason: vi.fn(),
        listReasonHistory: vi.fn(),
        getDowntimeWatermark: vi.fn(),
        getEditableStop,
        // The unused reads are bare mocks, so the object needs the cast the
        // work-unit suite already uses for the same reason: a vi.fn() with no
        // implementation does not satisfy a typed method signature.
      } as unknown as DowntimeReader,
      downtimeWriterRepository: { editDowntime } as unknown as DowntimeWriter,
      workUnitReportReaderRepository: { listApprovalsOverlapping },
      timeZoneResolver: { resolve },
      operatorRoles: overrides.operatorRoles ?? {},
    });

    return { service, getEditableStop, listApprovalsOverlapping, editDowntime, resolve };
  }

  function edit(service: DowntimeTimelineService) {
    return service.editDowntime({
      sourceEventId: "evt-1",
      next: { ...EDIT, category: "PLANNED" },
      baseline: EDIT,
      actor: ACTOR,
    });
  }

  it("resolves the stop, then asks about every report it overlaps", async () => {
    const { service, getEditableStop, listApprovalsOverlapping, resolve } = setup();

    await edit(service);

    expect(getEditableStop).toHaveBeenCalledWith("evt-1");
    // The zone comes from the stop's WORK UNIT, and it has to: rebuilding a shift
    // window without it would put the 23:00 boundary in the wrong place, which is
    // precisely where a straddling stop is decided.
    expect(resolve).toHaveBeenCalledWith("work-unit", 3);
    expect(listApprovalsOverlapping).toHaveBeenCalledWith({
      workUnitId: 3,
      startAt: STRADDLING_STOP.startAt,
      endAt: STRADDLING_STOP.endAt,
      timeZone: "Asia/Jakarta",
    });
  });

  it("404s an unknown stop without touching the writer", async () => {
    const { service, editDowntime, listApprovalsOverlapping } = setup({ stop: undefined });

    await expect(edit(service)).rejects.toMatchObject({ status: 404 });
    // The freeze is never consulted either: there is no stop to work out which
    // reports it belongs to.
    expect(listApprovalsOverlapping).not.toHaveBeenCalled();
    expect(editDowntime).not.toHaveBeenCalled();
  });

  it("passes the actor's SUBJECT through as changedBy, never the name", async () => {
    const { service, editDowntime } = setup();

    await edit(service);

    // changed_by is the Keycloak subject. `preferred_username` is a label that
    // can change; the subject is the durable identity, and 0007's header, §21 and
    // postgres.ts all say the same thing.
    expect(editDowntime).toHaveBeenCalledWith({
      sourceEventId: "evt-1",
      next: { ...EDIT, category: "PLANNED" },
      baseline: EDIT,
      changedBy: "u1",
    });
  });

  // THE ASSERTION THAT WOULD HAVE FAILED UNDER THE REJECTED DESIGN. The stop's own
  // shift is 2 and it is open; shift 3, which the stop merely straddles, is
  // approved. Reading only the stop's own (work_unit_id, date, shift) would let
  // this through.
  it("refuses the edit when a report the stop merely STRADDLES is approved", async () => {
    const { service, editDowntime } = setup({
      approvals: [
        { shift: 2, status: "open" },
        { shift: 3, status: "closed" },
      ],
    });

    await expect(edit(service)).rejects.toMatchObject({
      status: 409,
      // Names the shift, because the frozen one is not the stop's own and an
      // operator told only "this is approved" would open the wrong report.
      message: expect.stringContaining("shift 3"),
    });
    expect(editDowntime).not.toHaveBeenCalled();
  });

  // 0010's rule, from the other side: an empty result means no approval row for
  // any of the shifts, and the ABSENCE of a row IS open.
  it("allows the edit when no report has an approval row at all", async () => {
    const { service, editDowntime } = setup({ approvals: [] });

    await edit(service);

    expect(editDowntime).toHaveBeenCalledTimes(1);
  });

  it("allows the edit when every overlapping report is open", async () => {
    const { service, editDowntime } = setup({
      approvals: [
        { shift: 2, status: "open" },
        { shift: 3, status: "open" },
      ],
    });

    await edit(service);

    expect(editDowntime).toHaveBeenCalledTimes(1);
  });

  // 412 rather than a second 409, so the browser can give the two conflicts
  // different copy from a status-keyed map. The MESSAGES are the whole information
  // content: naming a colleague for what the pipeline did is the failure
  // EditConflictCause exists to prevent.
  it.each([
    ["concurrent", "another user"],
    ["restated", "the pipeline"],
  ])("412s a %s conflict and says so", async (cause, phrase) => {
    const { service } = setup({ outcome: { kind: "conflict", cause } });

    await expect(edit(service)).rejects.toMatchObject({
      status: 412,
      message: expect.stringContaining(phrase),
    });
  });

  // A no-op edit is a SUCCESS, not a 4xx: the operator asked for a state the row
  // is already in, and nothing is wrong. `changed` empty is how the browser knows
  // not to show the stale-metrics banner.
  it("returns 200 with an empty `changed` for a no-op edit", async () => {
    const { service } = setup({ outcome: { kind: "unchanged", row: STRADDLING_STOP } });

    const result = await edit(service);

    expect(result.changed).toEqual([]);
  });

  // durationMs is DERIVED from start/end rather than read from the `duration`
  // column, which is written independently of the timestamps and can disagree with
  // them — and this row sits directly under a timeline strip drawn from those same
  // timestamps, so a mismatch would be visible.
  it("returns the row in the shape the detail table renders, with a derived duration", async () => {
    const { service } = setup();

    const { item } = await edit(service);

    expect(item).toMatchObject({
      id: 7,
      sourceEventId: "evt-1",
      timeZone: "Asia/Jakarta",
      durationMs: 40 * 60 * 1000,
    });
    // workUnitId is the freeze's input, not part of the wire shape.
    expect(item).not.toHaveProperty("workUnitId");
  });

  it("reports a null duration for a stop that is still open", async () => {
    const { service } = setup({
      outcome: {
        kind: "edited",
        row: { ...STRADDLING_STOP, endAt: null },
        changed: ["category"],
      },
    });

    const { item } = await edit(service);

    expect(item.durationMs).toBeNull();
  });

  describe("DowntimeTimelineService.editDowntime role gate", () => {
    // Annotated rather than inferred: `roles: []` widens to never[] on its own,
    // and a helper typed `typeof unroled` would then reject the roled fixture.
    const unroled: Actor = { subject: "u1", name: "dewi", roles: [] };
    const editor: Actor = { subject: "u1", name: "dewi", roles: ["oee-downtime-editor"] };

    const EDIT = {
      category: "PLANNED" as const,
      reason: ["Mlipit"],
      actions: [],
      detailReason: null,
    };

    function editAs(service: DowntimeTimelineService, actor: Actor) {
      return service.editDowntime({
        sourceEventId: "evt-1",
        next: EDIT,
        baseline: { ...EDIT, category: "UNPLANNED" },
        actor,
      });
    }

    it("is ungated when EDIT_DOWNTIME_ROLE is unset", async () => {
      const { service, editDowntime } = setup();

      await editAs(service, unroled);

      expect(editDowntime).toHaveBeenCalled();
    });

    it("403s an actor without the configured role", async () => {
      const { service, editDowntime } = setup({
        operatorRoles: { editDowntime: "oee-downtime-editor" },
      });

      await expect(editAs(service, unroled)).rejects.toMatchObject({ status: 403 });
      expect(editDowntime).not.toHaveBeenCalled();
    });

    it("lets the role holder through", async () => {
      const { service, editDowntime } = setup({
        operatorRoles: { editDowntime: "oee-downtime-editor" },
      });

      await editAs(service, editor);

      expect(editDowntime).toHaveBeenCalled();
    });

    // THE ORDERING ASSERTION, and the reason the gate is the first statement in the
    // method rather than merely somewhere before the write.
    //
    // source_event_id is a pipeline-generated UUID, so it cannot be guessed — which
    // makes the difference between 403 and 404 the only channel through which an
    // unauthorised caller could confirm one exists. Gating first collapses that to a
    // single answer, and `getEditableStop` never being called is what proves it.
    it("refuses before looking the stop up, so 403 and 404 cannot be told apart", async () => {
      const { service, getEditableStop } = setup({
        stop: undefined,
        operatorRoles: { editDowntime: "oee-downtime-editor" },
      });

      await expect(editAs(service, unroled)).rejects.toMatchObject({ status: 403 });
      expect(getEditableStop).not.toHaveBeenCalled();
    });

    // The same absent stop, WITH the role, is a 404 — which is what makes the test
    // above meaningful rather than a tautology about a broken fixture.
    it("still 404s an absent stop once the role is held", async () => {
      const { service, getEditableStop } = setup({
        stop: undefined,
        operatorRoles: { editDowntime: "oee-downtime-editor" },
      });

      await expect(editAs(service, editor)).rejects.toMatchObject({ status: 404 });
      expect(getEditableStop).toHaveBeenCalled();
    });

    // Cross-mutation independence, matching the pair in the work-unit suite.
    it("APPROVE_ROLE does not gate a downtime edit", async () => {
      const { service, editDowntime } = setup({ operatorRoles: { approve: "oee-approver" } });

      await editAs(service, unroled);

      expect(editDowntime).toHaveBeenCalled();
    });
  });
});
