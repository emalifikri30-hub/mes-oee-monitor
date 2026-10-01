import { HTTPException } from "hono/http-exception";

import { baseLogger, getRequestContext } from "@molca/observability";
import { buildPageMeta } from "@molca/network";

import {
  getDowntimeEditConflictsCounter,
  getDowntimeEditsCounter,
  getDowntimeReasonGroupsHistogram,
  getDowntimeRowsDroppedCounter,
  getDowntimeSegmentsHistogram,
} from "../../shared/observability/metrics.js";
import { priorityOf } from "./downtime.js";

import type {
  DowntimeApprovalReader,
  DowntimeCategory,
  DowntimeEdit,
  DowntimeEvent,
  DowntimeListFilter,
  DowntimeListItem,
  DowntimeReasonBreakdown,
  DowntimeActionBreakdown,
  ActionBreakdownQuery,
  ReasonTail,
  DowntimeRowValues,
  DowntimeSortBy,
  DowntimeSortDir,
  EditableField,
  EditConflictCause,
  ReasonBreakdownFilter,
  ReasonBreakdownQuery,
  ReasonDetail,
  ReasonDetailFilter,
  ReasonHistory,
  ReasonSelector,
  ShiftTimeline,
  TimelineSegment,
  TimelineSegmentKind,
  TimelineWindow,
} from "./downtime.js";
import type { DowntimeReader, DowntimeWriter } from "./downtime-repository.js";
import { requireRole } from "../../shared/actor.js";

import type { Actor } from "../../shared/actor.js";
import type { OperatorRoles } from "../../shared/config/config.js";
import type { TimeZoneResolverContract } from "../master-data/time-zone-resolver.js";
import type { PageMeta } from "@molca/network";

// The same window/scope pair every other read filter carries. Built from
// WindowSelector rather than restated, so `grain` could not be added here and
// forgotten there.
// THE SAME SHAPE AS DowntimeListFilter, and now the same TYPE.
//
// It was a second, independent declaration of `WindowSelector & { scope, scopeId }`
// — which is fine while nothing changes and is a silent divergence the moment
// something does. Adding `productId` to the filter left this one behind, so the
// timeline compiled, ran, and served the whole line's stops under a SKU heading;
// only destructuring a field this type did not have made it fail loudly.
//
// Aliased rather than re-declared so the next filter field cannot repeat that.
type GetTimelineInput = DowntimeListFilter;

type PagedDowntimeResult = {
  items: DowntimeListItem[];
  meta: PageMeta;
};

// The drill-down carries paging in `meta` like the list endpoint does, and its
// bucket + window in `data` like the breakdown does. Both halves are needed:
// this page is reachable by deep link, so it cannot read the bucket out of the
// Pareto page's query cache.
type ReasonDetailResult = {
  detail: ReasonDetail;
  meta: PageMeta;
};

type ReasonHistoryFilter = ReasonBreakdownFilter & { selector: ReasonSelector };

type TDowntimeTimelineService = {
  getTimeline: (input: GetTimelineInput) => Promise<ShiftTimeline>;
  getPagedDowntime: (
    page: number,
    size: number,
    filter: DowntimeListFilter,
    sort: { sortBy: DowntimeSortBy; sortDir: DowntimeSortDir },
  ) => Promise<PagedDowntimeResult>;
  getReasonBreakdown: (filter: ReasonBreakdownQuery) => Promise<DowntimeReasonBreakdown>;
  // Pareto Actions. No `category` — see actionBreakdownInputSchema.
  getActionBreakdown: (filter: ActionBreakdownQuery) => Promise<DowntimeActionBreakdown>;
  getReasonDetail: (
    page: number,
    size: number,
    filter: ReasonDetailFilter,
  ) => Promise<ReasonDetailResult>;
  getReasonHistory: (filter: ReasonHistoryFilter) => Promise<ReasonHistory>;
  editDowntime: (input: EditDowntimeRequest) => Promise<DowntimeEditResult>;
};

// The edit as the handler hands it over: the validated body, the stop's public
// id from the path, and the actor from the token.
type EditDowntimeRequest = {
  sourceEventId: string;
  next: DowntimeEdit;
  baseline: DowntimeEdit;
  actor: Actor;
};

// What the handler puts on the wire: the stop as it now stands, plus which
// fields moved.
//
// `changed` is carried rather than inferred by the browser, and it is empty for a
// no-op edit. The dialog uses it for nothing today; the STALE-METRICS BANNER is
// what needs it, because only a `category` change can make anything on screen
// wrong — and having the server say which fields moved keeps that rule in one
// place instead of re-derived in the browser.
type DowntimeEditResult = {
  item: DowntimeListItem;
  changed: EditableField[];
};

type DowntimeTimelineServiceDeps = {
  downtimeReaderRepository: DowntimeReader;
  downtimeWriterRepository: DowntimeWriter;
  // The approvals read, as a NARROW PORT rather than the work-unit repository
  // itself. AGENTS.md: modules never import each other's internals, and 0010's
  // "the ABSENCE of a row means open" rule must exist in exactly one place.
  // WorkUnitReportReaderRepository satisfies this shape structurally and is
  // already registered, so this costs a type alias and no new class.
  workUnitReportReaderRepository: DowntimeApprovalReader;
  timeZoneResolver: TimeZoneResolverContract;
  operatorRoles: OperatorRoles;
};

// A record clipped to the window, in epoch milliseconds. Working in numbers
// rather than Dates keeps the comparisons in the sweep unambiguous — two Date
// objects for the same instant are not `===`.
type ClippedEvent = {
  category: DowntimeCategory;
  start: number;
  end: number;
};

type ClipResult = {
  clipped: ClippedEvent[];
  dropped: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// The flatten pipeline
//
//   window   ├───────────────────────────────────────────────────────┤
//   ev A          ├──── UNPLANNED ────┤
//   ev B                  ├──────── PLANNED ────────┤
//   ev C                                                ├ SMALL ┤
//   ev D (open)                                                    ├─ UNPL ──▶ clip
//
//   boundaries    │       │           │             │    │       │  │
//   atomic     [gap][UNP][UNP∩PLA][PLA          ][gap ][SS   ][gap][UNP]
//                          ▲ both cover this slice → the WEAKER category wins
//
//   coalesce   ├RUN┤├UNP┤├──── PLANNED ────┤├RUN┤├SS┤├RUN┤├─ UNPLANNED ─┤
//
// Three properties hold for every output, and the tests assert all three:
//   1. segments are sorted and pairwise disjoint
//   2. they tile [from, to) exactly — no gap, no overlap
//   3. no two adjacent segments share a kind
// ─────────────────────────────────────────────────────────────────────────────

// Clips every record to the window and discards the ones that survive as nothing.
//
// An open record (`end_at IS NULL`) is still running, so it reaches `now` — or
// the end of the window when the shift has already closed.
function clipToWindow(events: DowntimeEvent[], window: TimelineWindow, now: Date): ClipResult {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const nowMs = now.getTime();

  const clipped: ClippedEvent[] = [];
  let dropped = 0;

  for (const event of events) {
    const rawStart = event.startAt.getTime();
    const rawEnd = event.endAt === null ? nowMs : event.endAt.getTime();

    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      dropped += 1;
      continue;
    }

    const start = Math.max(rawStart, from);
    const end = Math.min(rawEnd, to);

    // One test covers three degenerate shapes: an inverted row (end_at <
    // start_at, which no CHECK constraint currently prevents), a zero-length
    // row, and an open row whose clock skew puts `now` before it began. All
    // three would otherwise reach the browser as a negative- or zero-width div.
    if (end <= start) {
      dropped += 1;
      continue;
    }

    clipped.push({ category: event.category, start, end });
  }

  return { clipped, dropped };
}

// Sweep-line over every boundary the clipped records introduce. Each atomic
// slice is resolved independently, then equal neighbours are merged.
//
// O(n²) in the number of records, which is the right trade for a shift that
// holds tens of them: an interval tree would cost more to read than it saves.
function sweep(clipped: ClippedEvent[], window: TimelineWindow): TimelineSegment[] {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (to <= from) return [];

  const boundaries = new Set<number>([from, to]);
  for (const event of clipped) {
    boundaries.add(event.start);
    boundaries.add(event.end);
  }

  const points = [...boundaries].filter((p) => p >= from && p <= to).sort((a, b) => a - b);

  const segments: TimelineSegment[] = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]!;
    const end = points[i + 1]!;

    // Records covering this slice decide its kind; a slice nothing covers is
    // RUN_TIME. Note the "RUN_TIME outranks everything" arm of the hierarchy is
    // unreachable by construction — a gap is the absence of records, so it never
    // competes with one.
    let kind: TimelineSegmentKind = "RUN_TIME";
    let bestRank = Number.POSITIVE_INFINITY;

    for (const event of clipped) {
      if (event.start > start || event.end < end) continue;
      const rank = priorityOf(event.category);
      if (rank < bestRank) {
        bestRank = rank;
        kind = event.category;
      }
    }

    const previous = segments.at(-1);
    if (previous !== undefined && previous.kind === kind) {
      previous.endAt = new Date(end);
      previous.durationMs = end - previous.startAt.getTime();
      continue;
    }

    segments.push({
      kind,
      startAt: new Date(start),
      endAt: new Date(end),
      durationMs: end - start,
    });
  }

  return segments;
}

// Exported for the tests: this is the whole algorithm, and `now` is a parameter
// precisely so open-ended records can be exercised without faking a clock.
function flattenTimeline(
  events: DowntimeEvent[],
  window: TimelineWindow,
  now: Date,
): { segments: TimelineSegment[]; dropped: number } {
  const { clipped, dropped } = clipToWindow(events, window, now);
  return { segments: sweep(clipped, window), dropped };
}

// Merging a scope wider than one machine is a flat union: **a scope is down when
// any of its members is down, and the least-severe concurrent stop is shown.**
// Five machines on a line collapse into one band, so a line reads as down even
// when four of the five ran clean. That is the definition this endpoint promises;
// per-machine tracks would be a different contract.
// THE "OTHER" TAIL, DERIVED FROM THE TOTALS RATHER THAN QUERIED AGAIN.
//
// Both halves are subtractions against figures the totals query already returned
// over the SAME clipped row set, so the tail cannot disagree with the
// denominators the cumulative line divides by — which a third query could, if a
// stop closed between the two.
//
// Null when nothing was truncated, and that is the normal case: a machine shift
// has a handful of reasons and the limit of 20 never bites. Null rather than a
// zero-filled object so the browser renders no "Other" bar at all instead of an
// empty one — `groupCount === buckets.length` is the whole test.
//
// SHARED BY THE REASON AND ACTION BREAKDOWNS, which is why it is a function
// rather than eight lines inside one of them: the two must fold their tails
// identically or one Pareto's cumulative line closes at 100% and the other's does
// not, for no reason a reader could find.
function paretoTail({
  groupCount,
  buckets,
  totalFrequency,
  totalDurationMs,
}: {
  groupCount: number;
  buckets: readonly { frequency: number; durationMs: number }[];
  totalFrequency: number;
  totalDurationMs: number;
}): ReasonTail | null {
  if (groupCount <= buckets.length) return null;

  const shownFrequency = buckets.reduce((sum, bucket) => sum + bucket.frequency, 0);
  const shownDurationMs = buckets.reduce((sum, bucket) => sum + bucket.durationMs, 0);

  return {
    reasonCount: groupCount - buckets.length,
    frequency: totalFrequency - shownFrequency,
    durationMs: totalDurationMs - shownDurationMs,
  };
}

class DowntimeTimelineService implements TDowntimeTimelineService {
  private repository: DowntimeReader;
  private writer: DowntimeWriter;
  private approvals: DowntimeApprovalReader;
  private timeZoneResolver: TimeZoneResolverContract;
  private operatorRoles: OperatorRoles;

  constructor({
    downtimeReaderRepository,
    downtimeWriterRepository,
    workUnitReportReaderRepository,
    timeZoneResolver,
    operatorRoles,
  }: DowntimeTimelineServiceDeps) {
    this.repository = downtimeReaderRepository;
    this.writer = downtimeWriterRepository;
    this.approvals = workUnitReportReaderRepository;
    this.timeZoneResolver = timeZoneResolver;
    this.operatorRoles = operatorRoles;
  }

  async getTimeline({
    scope,
    scopeId,
    grain,
    date,
    shift,
    productId,
  }: GetTimelineInput): Promise<ShiftTimeline> {
    // Must precede getWindow, which needs the zone to turn a business date and a
    // wall-clock shift into absolute bounds. Normally a Map lookup — see
    // TimeZoneResolver for what happens when it is not.
    const timeZone = await this.timeZoneResolver.resolve(scope, scopeId);

    const window = await this.repository.getWindow(grain, date, shift, timeZone);
    // Concurrent, and the watermark is deliberately NOT joined onto the event
    // query. getDowntimeWatermark's own header gives the reason: a joined
    // watermark vanishes when no downtime rows match, and NO ROWS IS EXACTLY THE
    // CASE THIS VALUE EXISTS TO EXPLAIN. Its own statement always answers.
    const [events, loadedThrough] = await Promise.all([
      this.repository.listOverlapping({ scope, scopeId, window, productId }),
      this.repository.getDowntimeWatermark(),
    ]);

    const { segments, dropped } = flattenTimeline(events, window, new Date());

    getDowntimeSegmentsHistogram().record(segments.length, { scope });

    if (dropped > 0) {
      getDowntimeRowsDroppedCounter().add(dropped, { scope });
      const log = getRequestContext()?.logger ?? baseLogger;
      log.withMetadata({ scope, scopeId, date, shift, dropped }).warn("downtime_rows_dropped");
    }

    return { ...window, timeZone, segments, loadedThrough };
  }

  // The raw records behind the strip, paged and sorted for the detail table.
  //
  // Resolves the window through the same query the timeline uses, so both views
  // agree on which records belong to the shift. `totalElements` doubles as the
  // "Downtime Frequency" figure the card shows — it is the count of records in
  // the window, which is exactly what frequency means here.
  async getPagedDowntime(
    page: number,
    size: number,
    { scope, scopeId, grain, date, shift, productId }: DowntimeListFilter,
    { sortBy, sortDir }: { sortBy: DowntimeSortBy; sortDir: DowntimeSortDir },
  ): Promise<PagedDowntimeResult> {
    const timeZone = await this.timeZoneResolver.resolve(scope, scopeId);
    const window = await this.repository.getWindow(grain, date, shift, timeZone);

    const { items, totalElements } = await this.repository.paginateDowntime({
      scope,
      scopeId,
      window,
      productId,
      limit: size,
      offset: (page - 1) * size,
      sortBy,
      sortDir,
    });

    return {
      // Stamped here rather than selected: the zone is resolved per scope through
      // the master-data hierarchy, not stored on the row.
      items: items.map((item) => ({ ...item, timeZone })),
      meta: buildPageMeta(page, size, totalElements),
    };
  }

  // The reason breakdown behind the Availability Loss tab. Same window, same
  // predicate, same records as the strip and the table — aggregated on the
  // server, because a rollup over the paged /downtimes list would aggregate one
  // page and call it a shift.
  //
  //   [1] timeZoneResolver.resolve  ──HTTP──▶  IANA zone   (15-min TTL cache)
  //   [2] repository.getWindow      ───SQL──▶  from / to
  //   [3] aggregateByReason  +  getDowntimeWatermark  ───SQL──▶  CONCURRENTLY
  //
  // [3] runs its two reads in parallel: they share no inputs, and the watermark
  // matters MOST exactly when the aggregate comes back empty, so making it wait
  // would add a round trip to the one path that needs it. Same shape as
  // getPerformance in work-unit-service.ts.
  //
  // NOTHING IS DERIVED HERE. No percentage, no cumulative, no ranking. All three
  // are ratios or orderings over ratios, and the browser derives them once from
  // `totalDurationMs` so the chart and a BI query over the same columns agree by
  // construction — the rule work-unit.ts states for rates.
  async getReasonBreakdown({
    scope,
    scopeId,
    grain,
    date,
    shift,
    productId,
    category,
    measure,
    limit,
  }: ReasonBreakdownQuery): Promise<DowntimeReasonBreakdown> {
    const timeZone = await this.timeZoneResolver.resolve(scope, scopeId);
    const window = await this.repository.getWindow(grain, date, shift, timeZone);

    const [aggregate, loadedThrough] = await Promise.all([
      this.repository.aggregateByReason({
        scope,
        scopeId,
        window,
        productId,
        category,
        measure,
        limit,
        now: new Date(),
      }),
      this.repository.getDowntimeWatermark(),
    ]);

    const { dropped, groupCount, buckets, totalFrequency, totalDurationMs } = aggregate;

    // THE HISTOGRAM RECORDS `groupCount`, NOT `buckets.length`, now that the query
    // truncates. Its whole job (metrics.ts) is to say when a scope stops being
    // small — and after a LIMIT, `buckets.length` is pinned at 20 for every wide
    // request, which is precisely the reading it exists to give. The true group
    // count still moves.
    getDowntimeReasonGroupsHistogram().record(groupCount, { scope, category });

    // The same instrument the sweep uses, because it is the same event on the
    // same rows: a record whose interval is empty or inverted. Splitting it in
    // two would split the alert.
    if (dropped > 0) {
      getDowntimeRowsDroppedCounter().add(dropped, { scope });
      const log = getRequestContext()?.logger ?? baseLogger;
      log.withMetadata({ scope, scopeId, date, shift, dropped }).warn("downtime_rows_dropped");
    }

    // The ambiguous case, and the only one worth a log line: nothing to show AND
    // the pipeline cannot vouch for the day. An empty result with a watermark at
    // or past `date` is a clean shift — good news, not an event, and the reason
    // there is no downtime_reason_empty_total counter to go with the two
    // *_empty_total counters in metrics.ts. Those fire on an anomaly; a shift
    // with no unplanned stops is common, and a counter that fires on every clean
    // shift would drown its neighbours.
    if (buckets.length === 0 && (loadedThrough === null || loadedThrough < date)) {
      const log = getRequestContext()?.logger ?? baseLogger;
      log
        .withMetadata({ scope, scopeId, date, shift, loadedThrough })
        .warn("downtime_reason_breakdown_stale");
    }

    // THE TAIL, DERIVED FROM THE TOTALS RATHER THAN QUERIED AGAIN.
    //
    // Both halves are subtractions against figures the totals query already
    // returned over the SAME clipped row set, so the tail cannot disagree with
    // the denominators the cumulative line divides by — which a third query
    // could, if a stop closed between the two.
    //
    // Null when nothing was truncated, and that is the normal case: a machine
    // shift has a handful of reasons and 20 never bites. Null rather than a
    // zero-filled object so the browser renders no "Other" bar at all instead of
    // an empty one — `groupCount === buckets.length` is the whole test.
    const other = paretoTail({ groupCount, buckets, totalFrequency, totalDurationMs });

    // `dropped` and `groupCount` are deliberately not spread in: the first is a
    // data-quality signal for the operators of this service, and the second is
    // an implementation detail of `other` above. Neither is part of the browser's
    // contract.
    return {
      ...window,
      timeZone,
      category,
      buckets,
      other,
      totalFrequency,
      totalDurationMs,
      loadedThrough,
    };
  }

  // Pareto Actions, on the OEE Performance dashboard: what was DONE about the
  // stops in this window, ranked.
  //
  // DELIBERATELY NOT A PARAMETERISED getReasonBreakdown. The two differ by a
  // `category` the aggregate does not take, by the instrument below, and by the
  // absence of the staleness log — and a shared method taking an optional
  // category would make the category-less call look like an oversight rather than
  // the decision it is (see actionBreakdownInputSchema).
  //
  // IT SHARES THE TAIL ARITHMETIC AND THE DROPPED-ROW SIGNAL, which are the two
  // parts that fail quietly, through `paretoTail` below.
  async getActionBreakdown({
    scope,
    scopeId,
    grain,
    date,
    shift,
    productId,
    measure,
    limit,
  }: ActionBreakdownQuery): Promise<DowntimeActionBreakdown> {
    const timeZone = await this.timeZoneResolver.resolve(scope, scopeId);
    const window = await this.repository.getWindow(grain, date, shift, timeZone);

    const [aggregate, loadedThrough] = await Promise.all([
      this.repository.aggregateByAction({
        scope,
        scopeId,
        window,
        productId,
        measure,
        limit,
        now: new Date(),
      }),
      this.repository.getDowntimeWatermark(),
    ]);

    const { dropped, groupCount, buckets, totalFrequency, totalDurationMs } = aggregate;

    // The same instrument and the same reasoning as the reason breakdown's: it is
    // the same event on the same rows, and splitting it would split the alert.
    if (dropped > 0) {
      getDowntimeRowsDroppedCounter().add(dropped, { scope });
      const log = getRequestContext()?.logger ?? baseLogger;
      log.withMetadata({ scope, scopeId, date, shift, dropped }).warn("downtime_rows_dropped");
    }

    return {
      ...window,
      timeZone,
      buckets,
      other: paretoTail({ groupCount, buckets, totalFrequency, totalDurationMs }),
      totalFrequency,
      totalDurationMs,
      loadedThrough,
    };
  }

  // ONE bucket of the breakdown above, plus the individual stops inside it. What
  // the Pareto's eye button opens.
  //
  //   [1] timeZoneResolver.resolve  ──HTTP──▶  IANA zone   (15-min TTL cache)
  //   [2] repository.getWindow      ───SQL──▶  from / to
  //   [3] aggregateOneReason + paginateByReason + watermark ──SQL──▶ CONCURRENTLY
  //
  // [3] is one Promise.all for the reason getReasonBreakdown's is: the three
  // reads share no inputs beyond the window, and serialising them would add two
  // round trips to a page that already waits on the master-data hop at [1].
  //
  // THE BUCKET IS NOT RECOMPUTED HERE. `aggregateOneReason` delegates to the
  // very aggregate that drew the bar, narrowed by a selector. A summary card
  // that disagreed with the chart it was opened from is a defect nobody would
  // catch by looking, so the guarantee is structural rather than tested into
  // place — though downtime-repository.integration.test.ts pins it anyway.
  async getReasonDetail(
    page: number,
    size: number,
    {
      scope,
      scopeId,
      grain,
      date,
      shift,
      productId,
      category,
      selector,
      sortBy,
      sortDir,
    }: ReasonDetailFilter,
  ): Promise<ReasonDetailResult> {
    const timeZone = await this.timeZoneResolver.resolve(scope, scopeId);
    const window = await this.repository.getWindow(grain, date, shift, timeZone);
    const now = new Date();

    const [bucket, paged, loadedThrough] = await Promise.all([
      this.repository.aggregateOneReason({
        scope,
        scopeId,
        window,
        productId,
        category,
        now,
        selector,
      }),
      this.repository.paginateByReason({
        scope,
        scopeId,
        window,
        productId,
        category,
        now,
        selector,
        limit: size,
        offset: (page - 1) * size,
        sortBy,
        sortDir,
      }),
      this.repository.getDowntimeWatermark(),
    ]);

    // A reason that contributed nothing to this shift has no page to show. 404
    // rather than an empty table, because the two are genuinely different
    // answers: a mistyped deep link is a broken link, not a clean shift.
    //
    // Note this fires only when the BUCKET is absent. A bucket that exists with
    // an empty current page is ordinary paging and passes straight through.
    if (bucket === null) {
      throw new HTTPException(404, { message: "no downtime recorded for that reason" });
    }

    return {
      detail: {
        ...window,
        timeZone,
        category,
        bucket,
        // Stamped here rather than selected, exactly as getPagedDowntime does.
        items: paged.items.map((item) => ({ ...item, timeZone })),
        loadedThrough,
      },
      meta: buildPageMeta(page, size, paged.totalElements),
    };
  }

  // The Changes History panel for one reason bucket.
  //
  // Unpaged, deliberately: the trail for a handful of stops within one shift is
  // bounded by how many times an operator edited them, and the panel reads as a
  // chronology rather than a table.
  //
  // Passes `trackedMembers` straight through. See the type — it is what stops an
  // empty list from rendering as "nothing changed" when the truth is "none of
  // these stops can be tracked at all", which is every stop until the DAG writes
  // source_event_id.
  async getReasonHistory({
    scope,
    scopeId,
    grain,
    date,
    shift,
    productId,
    category,
    selector,
  }: ReasonHistoryFilter): Promise<ReasonHistory> {
    const timeZone = await this.timeZoneResolver.resolve(scope, scopeId);
    const window = await this.repository.getWindow(grain, date, shift, timeZone);

    return await this.repository.listReasonHistory({
      scope,
      scopeId,
      window,
      productId,
      category,
      selector,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Edit a downtime — the second of this service's two operator mutations
  // ─────────────────────────────────────────────────────────────────────────
  //
  //   [1] getEditableStop(sourceEventId)      404 if absent — which is EVERY
  //                                           stop today, since the pipeline
  //                                           does not write source_event_id yet
  //   [2] timeZoneResolver.resolve            needed to rebuild shift windows
  //   [3] listApprovalsOverlapping            the FREEZE, over every shift the
  //                                           stop touches
  //   [4] writer.editDowntime                 one transaction: re-read, diff,
  //                                           guarded UPDATE, history rows
  //   [5] map the outcome to HTTP and count
  //
  // WHY THE FREEZE IS HERE AND NOT INSIDE THE TRANSACTION. Step [3] goes through
  // a port to another module, which cannot join step [4]'s transaction without
  // handing the transaction handle across the module boundary. getEditableStop's
  // header states the residual race and why it is the cheaper side of the trade.
  //
  // WHY A STOP HAS MORE THAN ONE REPORT, which is the part worth reading twice. A
  // stop straddling 23:00 belongs to BOTH shifts it touches — the rule every read
  // path already follows — so its category contributes availability loss to two
  // reports, and an edit can move the numbers on either. Checking only the report
  // named by the stop's own (work_unit_id, date, shift) would let an edit to a
  // straddling stop silently rewrite a shift somebody had already signed off,
  // with nothing in THAT report's trail to show it.
  //
  //   status codes, and each one is a different question
  //     404  no such stop
  //     409  a report this stop belongs to is approved — TODOS.md §37's decision
  //     412  the stop moved under the dialog; the cause says which writer
  //     200  edited, or unchanged with an empty `changed`
  //
  // ROLE-GATED BY EDIT_DOWNTIME_ROLE, and OFF unless it is set — TODOS.md §34.
  //
  // ITS OWN VARIABLE rather than sharing approve's, even though both are "operator
  // work". Correcting a mistyped reason is routine data entry; approving freezes a
  // shift and stamps a name on it. Forcing one role to cover both would mean
  // granting sign-off authority to everyone who may fix a typo, and a realm cannot
  // undo that from configuration once the code assumes it.
  //
  // FIRST, before the 404. A caller with no permission to edit anything must not
  // be able to learn which source_event_ids exist by reading the difference
  // between 403 and 404 — and this route's id is a UUID from the pipeline, so
  // probing it is otherwise the only way to find out.
  async editDowntime({
    sourceEventId,
    next,
    baseline,
    actor,
  }: EditDowntimeRequest): Promise<DowntimeEditResult> {
    requireRole(actor, this.operatorRoles.editDowntime, {
      metric: "edit_downtime",
      message: "edit this downtime",
    });

    const stop = await this.repository.getEditableStop(sourceEventId);
    // Worded for an operator: app.onError puts this string straight into the
    // envelope, and "unknown downtime id" is what the browser can act on.
    if (stop === undefined) {
      throw new HTTPException(404, { message: "no downtime with that id" });
    }

    // Scope is work-unit here rather than a parameter: a stop's freeze is decided
    // by the SHIFT REPORTS it belongs to, and those are work-unit grained. There
    // is no line- or area-level report to be approved.
    const timeZone = await this.timeZoneResolver.resolve("work-unit", stop.workUnitId);

    const overlapping = await this.approvals.listApprovalsOverlapping({
      workUnitId: stop.workUnitId,
      startAt: stop.startAt,
      endAt: stop.endAt,
      timeZone,
    });

    const closed = overlapping.find((report) => report.status === "closed");
    if (closed !== undefined) {
      getDowntimeEditConflictsCounter().add(1, { cause: "approved" });
      // Names the shift, because a straddling stop can be frozen by a shift that
      // is not its own and an operator told only "this is approved" would go
      // looking at the wrong report.
      throw new HTTPException(409, {
        message: `shift ${closed.shift} has been approved; reopen it before editing this downtime`,
      });
    }

    const outcome = await this.writer.editDowntime({
      sourceEventId,
      next,
      baseline,
      changedBy: actor.subject,
    });

    switch (outcome.kind) {
      // The stop vanished between [1] and [4]. Reachable only through the race
      // getEditableStop documents, and it is still a 404 rather than a 412: there
      // is nothing to conflict with.
      case "not_found":
        throw new HTTPException(404, { message: "no downtime with that id" });

      // 409, not 412: this is the freeze firing inside the transaction, which
      // the writer cannot currently produce — the check above owns it. Kept so
      // the switch is exhaustive over the union rather than falling through, and
      // so moving the freeze into the transaction later needs no change here.
      case "approved":
        getDowntimeEditConflictsCounter().add(1, { cause: "approved" });
        throw new HTTPException(409, {
          message: `shift ${outcome.shift} has been approved; reopen it before editing this downtime`,
        });

      case "conflict": {
        getDowntimeEditConflictsCounter().add(1, { cause: outcome.cause });
        const log = getRequestContext()?.logger ?? baseLogger;
        log.withMetadata({ sourceEventId, cause: outcome.cause }).warn("downtime_edit_conflict");
        // 412 rather than a second 409 so the browser can give the two conflicts
        // different copy from a status-keyed map — and because "the precondition
        // you sent no longer holds" is literally what happened.
        throw new HTTPException(412, { message: CONFLICT_MESSAGE[outcome.cause] });
      }

      // A no-op edit is a SUCCESS with an empty `changed`. It wrote no history
      // row and it is not counted: counting it would make downtime_edits_total
      // disagree with the table it mirrors.
      case "unchanged":
        return { item: this.toListItem(outcome.row, timeZone), changed: [] };

      case "edited":
        // ONE INCREMENT PER CHANGED FIELD, which is the grain
        // oee.downtime_report_history is written at — so the counter and the
        // trail can be reconciled against each other.
        for (const field of outcome.changed) {
          getDowntimeEditsCounter().add(1, { field });
        }
        return { item: this.toListItem(outcome.row, timeZone), changed: outcome.changed };
    }
  }

  // The edited stop in the shape the detail table already renders, so the browser
  // can write it through its cache instead of refetching the page it is on.
  //
  // The five denormalised names and `durationMs` come off the row rather than
  // being recomputed: none of them is editable, and durationMs is derived from
  // start/end for the reason DowntimeListItem states — the `duration` column can
  // disagree with its own timestamps.
  private toListItem(row: DowntimeRowValues, timeZone: string): DowntimeListItem {
    return {
      // `id` is the surrogate serial, which the browser does not key on — but the
      // type carries it and omitting it would mean a second, nearly identical
      // type for one field. -1 would be a lie; the value is read from the row.
      id: row.id,
      sourceEventId: row.sourceEventId,
      reason: row.reason,
      actions: row.actions,
      category: row.category,
      workUnitName: row.workUnitName,
      // NOT FOR DISPLAY. The edited row is written straight through the browser's
      // cache, and the AREA report's edit dialog reads this to scope its Reason
      // catalogue — so an edit that dropped it would leave the dialog unscoped on
      // its second open. See DowntimeListItem.
      workCenterId: row.workCenterId,
      workCenterName: row.workCenterName,
      areaName: row.areaName,
      detailReason: row.detailReason,
      inputBy: row.inputBy,
      maintainedBy: row.maintainedBy,
      startAt: row.startAt,
      endAt: row.endAt,
      durationMs: row.endAt === null ? null : row.endAt.getTime() - row.startAt.getTime(),
      timeZone,
    };
  }
}

// Worded for an operator, and the two are different claims rather than two
// phrasings of one. Naming the wrong actor in the "restated" case is the failure
// EditConflictCause exists to prevent.
const CONFLICT_MESSAGE: Record<EditConflictCause, string> = {
  concurrent:
    "another user changed this downtime while you had it open; reopen it to see the current values",
  restated:
    "the pipeline reloaded this downtime while you had it open; reopen it to see the current values",
};

export { clipToWindow, DowntimeTimelineService, flattenTimeline, sweep };
export type {
  DowntimeEditResult,
  DowntimeTimelineServiceDeps,
  EditDowntimeRequest,
  GetTimelineInput,
  PagedDowntimeResult,
  ReasonDetailResult,
  ReasonHistoryFilter,
  TDowntimeTimelineService,
};
