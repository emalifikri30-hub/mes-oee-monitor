import type { ReportGrain, ShiftId } from "../../shared/shift-window.js";

// Domain types for the downtime timeline.
//
// A "timeline" is the shift window cut into non-overlapping, contiguous segments
// that tile it exactly. Downtime records come from oee.downtime_reports; every
// stretch no record covers is RUN_TIME. Records may overlap each other, so the
// segments are the *result* of a merge rather than the records themselves.

// The category column is the `oee.operation_type` enum. postgres.js hands enums
// back as plain strings, so this list is the only guard there is.
//
// A const array rather than a bare union because the reason breakdown takes the
// category as a query parameter, and `z.enum` needs the values at runtime. The
// resulting type is identical to the union it replaced.
const DOWNTIME_CATEGORIES = ["PLANNED", "UNPLANNED", "SMALL_STOP"] as const;

type DowntimeCategory = (typeof DOWNTIME_CATEGORIES)[number];

// RUN_TIME is never stored — it is what a gap between records is called.
type TimelineSegmentKind = DowntimeCategory | "RUN_TIME";

// Which level of the plant hierarchy the caller is asking about.
//
// `factory` is still accepted by the schema and rejected by the handler:
// oee.downtime_reports has no factory_id column, so serving it would mean
// resolving the hierarchy through mes-master-data first. `area` USED TO SAY THE
// SAME AND THE CLAIM WAS FALSE — migration 0007 added `area_id` / `area_name` to
// that table in August, and 0007's own COMMENT on the column recorded that it was
// "NOT yet accepted by SCOPE_COLUMN". It is now.
type DowntimeScope = "work-unit" | "work-center" | "area" | "factory";

// The scopes that map to a single column on oee.downtime_reports.
//
// THE HIERARCHY AXIS IS CONTAINMENT, which is what makes each of these a plain
// predicate. A work unit is inside a work center is inside an area, permanently,
// so a stop on the child IS a stop on the parent and no apportionment is involved
// — migration 0020's header draws the contrast with SKU, which is OCCUPANCY OVER
// TIME and therefore a FILTER beside a scope rather than a fourth member here.
//
// `area_id` IS NULLABLE, unlike the two below it, and the consequence is worth
// stating because it is invisible: a stop the pipeline never attributed to an area
// is excluded from every area-scoped read. That is denormalisation lag rather than
// a semantic gap — containment means the area IS derivable from `work_unit_id`, so
// the row is simply missing a label it could have — which is why this needs no
// `unattributed` count beside it the way `product_id` does. If the column turns
// out to be sparse in production, the fix is a backfill upstream, not a residual
// on the payload.
const SCOPE_COLUMN = {
  "work-unit": "work_unit_id",
  "work-center": "work_center_id",
  area: "area_id",
} as const satisfies Partial<Record<DowntimeScope, string>>;

type SupportedScope = keyof typeof SCOPE_COLUMN;

function isSupportedScope(scope: DowntimeScope): scope is SupportedScope {
  return scope in SCOPE_COLUMN;
}

// One row as the repository projects it. `endAt` is null while a stop is still
// open, which is a normal state, not missing data.
type DowntimeEvent = {
  id: number;
  category: DowntimeCategory;
  startAt: Date;
  endAt: Date | null;
};

// Half-open: [from, to). A stop that ends exactly at `to` contributes nothing to
// the next shift.
type TimelineWindow = {
  from: Date;
  to: Date;
};

type TimelineSegment = {
  kind: TimelineSegmentKind;
  startAt: Date;
  endAt: Date;
  durationMs: number;
};

type ShiftTimeline = TimelineWindow & {
  // IANA zone the window was built in, echoed so the browser can render clock
  // times without hardcoding the plant's location.
  timeZone: string;
  segments: TimelineSegment[];
  // HOW FAR THE PIPELINE HAS LOADED oee.downtime_reports, and the reason this
  // endpoint is not answerable without it.
  //
  // `segments` for a shift with no downtime rows is ONE full-width RUN_TIME band
  // — and no downtime rows has two very different causes: the machine genuinely
  // ran clean, or the downtime ETL has not reached this day. The ambiguous
  // outcome is the FLATTERING one: a shift that was down for hours renders as
  // flawless, with no error, no empty state and nothing on screen that could
  // hint otherwise. TODOS.md §8 filed exactly that, and this field is what
  // closes it.
  //
  // A DATE STRING, not a boolean. The comparison needs the report's own business
  // day, which this endpoint does not have — it is given a date and a shift, not
  // a report — so the browser makes the call through
  // isLoadedThrough / selectLoadState. NULL means the table has never been
  // loaded, which is a third state again and must not read as "loaded through
  // the epoch".
  loadedThrough: string | null;
};

// The three fields that name a window, factored out because all three read
// filters below carry them identically. They differ only in which `scope` values
// they admit.
//
// `shift` is optional HERE for the reason downtime-dto.ts gives at length: a day
// or month window has no shift, and no default for it is honest. The DTO refines
// it to be present when `grain` is "shift", and `resolveReportWindow` throws if a
// caller assembles the pair by hand.
type WindowSelector = {
  grain: ReportGrain;
  // YYYY-MM-DD, the report's business day. At month grain any day inside the
  // month is accepted and truncated.
  date: string;
  shift?: ShiftId;
};

type TimelineQuery = WindowSelector & {
  scope: DowntimeScope;
  scopeId: number;
};

// Where two records cover the same instant, the WEAKER category renders.
// Lower index wins. This reads the design's hierarchy arrow top-down and was
// confirmed against its worked example, where an UNPLANNED stop overlapped by a
// PLANNED one renders as PLANNED.
//
// Note this inverts the conventional OEE reading. It is a deliberate product
// decision, not an oversight.
const SEGMENT_PRIORITY = ["RUN_TIME", "SMALL_STOP", "PLANNED", "UNPLANNED"] as const;

function priorityOf(kind: TimelineSegmentKind): number {
  return SEGMENT_PRIORITY.indexOf(kind);
}

// One row of the downtime detail table. Unlike the timeline, this is the raw
// records — nothing is merged, so two overlapping stops are two rows.
//
// `reason` and `actions` are `jsonb[]` holding plain JSON strings. Both are
// normalised to string[] in the repository so a malformed element cannot reach
// the browser as an object it would render as "[object Object]".
type DowntimeListItem = {
  id: number;
  // The stop's PUBLIC identity, and what every drill-down keys on. Null until
  // the DAG writes it (0007). Deliberately not `id`: contract §2.1 mandates
  // DELETE-then-INSERT until the upsert key lands, so `id` changes on every
  // pipeline run and a link built from it would come to mean a different stop.
  sourceEventId: string | null;
  reason: string[];
  actions: string[];
  category: DowntimeCategory;
  workUnitName: string | null;
  // Carried so the per-record drawer can name the full hierarchy — area, line,
  // machine — from a row it already has, without a second request. `areaName`
  // is null until the DAG writes it (TODOS.md §9).
  workCenterName: string | null;
  areaName: string | null;
  // THE LINE'S ID, AND IT IS NOT FOR DISPLAY. It is what scopes the edit dialog's
  // Reason catalogue, which core-api refuses to serve unscoped (an unscoped read
  // returns the whole region, which is how a stop on the filler gets labelled with
  // a palletiser reason).
  //
  // ADDED FOR THE AREA REPORT, and that screen is the reason it has to be on the
  // ROW rather than only on the report. Every other subject's report knows its own
  // single line; an AREA report spans N of them, so the only thing that knows which
  // catalogue applies to a given stop is the stop. Nullable, matching the column.
  workCenterId: number | null;
  // Operator free text elaborating on `reason`, and who logged / attended to the
  // stop. All null until the DAG writes them; the browser renders an em dash.
  detailReason: string | null;
  inputBy: string | null;
  maintainedBy: string | null;
  startAt: Date;
  endAt: Date | null;
  // Derived from start_at / end_at, NOT read from the `duration` column.
  //
  // The column is written independently of the timestamps and can disagree with
  // them (see TODOS.md §10). Since this table sits directly under the timeline
  // strip — which is drawn from those same timestamps — a Duration that did not
  // match its own Start would be visibly wrong. Null while a stop is still open.
  durationMs: number | null;
  // Echoed per row so a row is self-describing: the browser needs the plant zone
  // to render `startAt` as a wall-clock time, and carrying it here avoids
  // coupling this endpoint's consumer to the timeline endpoint's response.
  timeZone: string;
};

// Sortable columns, as an allowlist mapped to SQL further down. A caller can
// never name a column directly.
const DOWNTIME_SORT_BY = ["category", "startAt", "duration"] as const;
const DOWNTIME_SORT_DIR = ["asc", "desc"] as const;

type DowntimeSortBy = (typeof DOWNTIME_SORT_BY)[number];
type DowntimeSortDir = (typeof DOWNTIME_SORT_DIR)[number];

type DowntimeListFilter = WindowSelector & {
  scope: SupportedScope;
  scopeId: number;
  // Narrows to one SKU, on top of the scope. Undefined means every stop in the
  // window — see downtime-dto.ts for why this is a filter and not a scope, and
  // why "undefined" must keep meaning what it meant before this field existed.
  productId?: number;
};

type ListDowntimeInput = DowntimeListFilter & {
  limit: number;
  offset: number;
  sortBy: DowntimeSortBy;
  sortDir: DowntimeSortDir;
};

// ─────────────────────────────────────────────────────────────────────────────
// The reason breakdown — oee.downtime_reports grouped by primary reason.
//
// What the Availability Loss tab draws its Pareto and its table from. Same
// records as the timeline and the detail list; the difference is that these are
// AGGREGATED, and CLIPPED to the shift window before they are summed.
//
//   window          |<--------------------------->|
//   straddles start -+----|                        |     counts from `from`
//   inside           |    |------|                 |     counts whole
//   straddles end    |               |-------------+--|  counts to `to`
//   still open       |                     |-------+----->  counts to `now`
//
// Clipping is what makes the bars add up to something comparable with the strip
// above them. It is also why the stored `duration` column is unusable here: it
// describes the whole stop, not the part that fell in this shift.
// ─────────────────────────────────────────────────────────────────────────────

// One primary downtime reason within one shift window.
type DowntimeReasonBucket = {
  // GROUPED ON THE FIRST ELEMENT of `reason` only. The column is a jsonb array
  // and operators do record several, but a stop has one cause for accounting
  // purposes; exploding the array would count one 40-minute stop under two
  // reasons and make the bars sum to more than the shift.
  //
  // NULL when no usable primary reason was recorded — deliberately not the
  // literal "Unspecified", which a real reason of that exact text would silently
  // merge into. The label is a presentation concern the browser already owns for
  // every other enum on this screen.
  reason: string | null;
  // Distinct machines behind this bucket. At work-unit scope this is one name —
  // two only if the denormalised name was rewritten mid-shift, which is the
  // truth and not a bug.
  workUnitNames: string[];
  // Stops overlapping the window, after empty and inverted clips are dropped. A
  // stop straddling a boundary counts as one in BOTH shifts — the same rule the
  // detail table already follows by listing it in both.
  frequency: number;
  // CLIPPED to the window, derived from start_at/end_at, never read from the
  // stored `duration` column. Same reasoning as DowntimeListItem.durationMs.
  durationMs: number;
};

// The Availability Loss payload. Echoes the window and the zone for the reason
// ShiftTimeline does — the durations mean nothing without the window they were
// clipped to, and the browser has no shift table of its own.
//
// NO CUMULATIVE PERCENTAGE, deliberately. A cumulative % is a ratio, and its
// value depends on which measure the caller is ranking by, which is a UI toggle.
// The browser derives it once from the totals below, so the chart and a BI query
// over the same two columns agree by construction — the rule work-unit.ts states
// for rates.
// THE TRUNCATED TAIL — everything outside the top-N `buckets`, as one figure.
//
// Null when nothing was truncated, which is the normal case at work-unit grain: a
// machine's shift has a handful of distinct reasons and the limit never bites.
// Non-null is what a LINE month looks like — measured at 120 distinct reasons for
// a 10-machine line over 31 days, which is 120 bars nobody can read and a payload
// that grows with the plant.
//
// IT EXISTS SO THE TRUNCATION IS VISIBLE. A bare LIMIT would draw a Pareto whose
// bars stop somewhere arbitrary and whose cumulative line still reached 100%,
// which is the flattering reading of a missing tail. With this, the chart draws
// one more bar labelled "Other", the line reaches 100% honestly, and
// `reasonCount` says how many reasons are inside it.
type ReasonTail = {
  // How many distinct reasons were folded in. The figure the label renders —
  // "Other (37 reasons)" — because "Other" alone does not say whether one reason
  // was dropped or two hundred.
  reasonCount: number;
  frequency: number;
  durationMs: number;
};

type DowntimeReasonBreakdown = TimelineWindow & {
  timeZone: string;
  category: DowntimeCategory;
  // THE TOP N BY THE REQUESTED MEASURE, not every reason in the window. `other`
  // below carries the rest. Which measure ranked them is the caller's `measure`
  // param, and it has to be a param: the top ten by duration are not the top ten
  // by frequency, so a browser re-ranking a duration-limited set by frequency
  // would show the wrong ten bars.
  buckets: DowntimeReasonBucket[];
  other: ReasonTail | null;
  // The cumulative line's denominators. Sent rather than left to be summed from
  // `buckets`, which is what keeps them correct now that a LIMIT and an "Other"
  // bucket exist — the bars alone are no longer the whole story, and
  // lib/pareto-rank.ts divides by these.
  totalFrequency: number;
  totalDurationMs: number;
  // oee.etl_watermarks.last_business_date for downtime_reports; null = never
  // loaded. Against the request's own `date` it separates "this machine ran
  // clean" from "downtime has not loaded yet" — TODOS.md §8, closed on this
  // surface before it shipped rather than after.
  loadedThrough: string | null;
};

// WHICH MEASURE RANKS THE BUCKETS, and therefore which ones survive the limit.
//
// Not a presentation concern once the response is truncated. The browser used to
// re-rank client-side for free — it held every bucket — and that stops being
// possible the moment the server decides which N to send.
type ReasonMeasure = "duration" | "frequency";

// Scope is no longer narrowed to work-unit: `work-center` is served too, for the
// Line report's Losses screen, and `area` for the Area report's. Only `factory`
// remains unmapped in SCOPE_COLUMN, so the handler's requireSupported still
// refuses that one.
//
// TODOS.md §25 held the wide scopes back on COST, not capability, and named four
// changes that had to land together before an area could be served: a server-side
// LIMIT, an "Other" tail bucket, server-side ranking and server-side paging of the
// drill-down. All four shipped with the line grain — `limit` and `measure` are on
// this endpoint's schema, `other` is derived from `groupCount` in the service, and
// the drill-down has always been paged. So the area scope is not a re-opening of
// that question; it is the first caller the answer was built for.
type ReasonBreakdownFilter = DowntimeListFilter & {
  category: DowntimeCategory;
};

// ─────────────────────────────────────────────────────────────────────────────
// The per-reason drill-down — one bucket of the breakdown above, plus the
// individual stops inside it.
//
// This is what the Pareto's eye button opens. The contract that matters is that
// its `bucket` EQUALS the bar it was opened from, so both are computed from the
// same clipped row set in downtime-repository.ts rather than by two aggregates
// that happen to agree today.
// ─────────────────────────────────────────────────────────────────────────────

// Which bucket. A discriminated union rather than `string | null`, because the
// unlabelled bucket is `reason IS NULL` in SQL and an empty string over the wire
// cannot be told apart from "no filter at all" — the trap TODOS.md §27 names.
//
// The browser's "Unspecified" label never appears here. It is applied in
// lib/pareto.ts precisely so a real reason of that text cannot merge into it.
type ReasonSelector = { kind: "labelled"; reason: string } | { kind: "unlabelled" };

// Paging is NOT here: getReasonDetail takes `page`/`size` as its own arguments
// and derives limit/offset, exactly as getPagedDowntime does. This type is the
// identity of the slice being asked about, and nothing about how it is walked.
// The whole-window breakdown adds the two knobs that decide WHICH buckets come
// back. They are not on ReasonBreakdownFilter itself because the drill-down and
// the history below narrow to one bucket and have nothing to rank.
type ReasonBreakdownQuery = ReasonBreakdownFilter & {
  measure: ReasonMeasure;
  limit: number;
};

// Pareto Actions' query. `ReasonBreakdownFilter` minus its `category`, for the
// reason actionBreakdownInputSchema states: an action is not an operation type.
type ActionBreakdownQuery = Omit<ReasonBreakdownFilter, "category"> & {
  measure: ReasonMeasure;
  limit: number;
};

// Pareto Actions' payload.
//
// `DowntimeReasonBreakdown` MINUS `category`, and otherwise identical on purpose:
// the browser ranks and draws both with one implementation (lib/pareto.ts's
// buildPareto reads buckets, other and the two totals, and never looks at the
// category). A shape of its own here would have forced a second Pareto builder
// whose edge cases — the "Other" tail, a zero denominator, the unlabelled bucket —
// would drift from the first one's.
type DowntimeActionBreakdown = Omit<DowntimeReasonBreakdown, "category">;

type ReasonDetailFilter = ReasonBreakdownFilter & {
  selector: ReasonSelector;
  sortBy: DowntimeSortBy;
  sortDir: DowntimeSortDir;
};

// The drill-down payload. Echoes the window, zone and watermark for the same
// reasons DowntimeReasonBreakdown does — this page is reachable by deep link, so
// it cannot assume the Pareto page's response is in the browser's cache.
type ReasonDetail = TimelineWindow & {
  timeZone: string;
  category: DowntimeCategory;
  // The single bucket, identical to its twin in DowntimeReasonBreakdown.buckets.
  bucket: DowntimeReasonBucket;
  items: DowntimeListItem[];
  loadedThrough: string | null;
};

// One field-level change to one stop. Written by the downtime-edit path, which
// does not exist yet (TODOS.md §21) — so this list is empty everywhere today,
// and ReasonHistory below is what stops that reading as "nothing ever changed".
type DowntimeHistoryEntry = {
  id: number;
  sourceEventId: string;
  changedAt: Date;
  changedBy: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
};

// The Changes History payload.
//
// `trackedMembers` IS THE POINT. An empty `entries` has two very different
// meanings, and the flattering one is the wrong one: either nothing has been
// edited, or none of these stops carries a source_event_id and therefore NOTHING
// COULD EVER BE RECORDED about them. Every row today is the second case.
// Reporting only `entries` would render "no changes" over data that is not
// tracked at all — the same silent-failure shape as TODOS.md §8.
type ReasonHistory = {
  entries: DowntimeHistoryEntry[];
  trackedMembers: number;
  totalMembers: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Editing a downtime — the second of the two named operator mutations
// ─────────────────────────────────────────────────────────────────────────────
//
// docs/gold-write-contract.md §1 rule 2 reserves exactly two writes for this
// service, and this is the other one. It needs no new columns: `category` is the
// oee.operation_type enum, `reason` and `actions` are jsonb, and `detail_reason`
// arrived with 0007 — which also created oee.downtime_report_history, whose CHECK
// names these four fields and nothing else.

// THE FOUR EDITABLE FIELDS, ONCE.
//
// This list is otherwise hard-coded in five places — the request schema, the diff,
// the UPDATE's SET clause, the history rows, and the browser's form — and the
// fifth is in SQL, in 0007's ck_downtime_report_history_field CHECK, where
// TypeScript cannot reach it. So this const's job is to stop the four TypeScript
// copies drifting from each other AND from that constraint: every one of them is
// derived from here, and adding a fifth field is one entry plus a migration
// rather than a hunt.
//
// ORDER IS NOT SIGNIFICANT to correctness — the diff and the history rows are
// keyed by name — but it is the order the drawer renders in, so it matches the
// design rather than the column order of the table.
const EDITABLE_FIELDS = ["category", "reason", "detailReason", "actions"] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

// The database column each field maps to, because three of the four differ in
// case convention and `detail_reason` is the one that would be silently wrong.
//
// An explicit map rather than a camel-to-snake helper: a generic converter would
// also happily produce a column name for a field that does not exist, and the
// point of this table is that only these four do.
const EDITABLE_COLUMN = {
  category: "category",
  reason: "reason",
  detailReason: "detail_reason",
  actions: "actions",
} as const satisfies Record<EditableField, string>;

// The four values as they travel over the wire and as the diff compares them.
//
// ALL FOUR ARE REQUIRED, and that is the deliberate choice rather than a partial
// PATCH body. With optional fields, "absent" and "explicitly null" decide whether
// a cleared `detailReason` is a clear or a no-op — a distinction no HTTP stack
// preserves reliably and every caller would have to get right. Requiring all four
// removes the question: the body is the complete post-edit state of the four
// mutable fields, and the SERVER works out which of them actually moved.
type DowntimeEdit = {
  category: DowntimeCategory;
  reason: string[];
  detailReason: string | null;
  actions: string[];
};

// The edit request: the new values, plus the values the dialog was showing when
// the operator opened it.
//
// `baseline` IS THE OPTIMISTIC-CONCURRENCY TOKEN, and it is the whole edit rather
// than a version number because the table has no version column and adding one
// would be a migration against a table the pipeline rewrites. The UPDATE matches
// on these values, so two operators editing the same stop cannot silently revert
// each other — the second one gets a 412 instead of quietly winning.
type EditDowntimeInput = {
  sourceEventId: string;
  next: DowntimeEdit;
  baseline: DowntimeEdit;
  // The Keycloak subject, which is what lands in
  // oee.downtime_report_history.changed_by. NEVER current_user: the pool connects
  // as one shared role, so the database cannot name the person. 0007's header and
  // TODOS.md §21 both say so, and postgres.ts repeats it.
  changedBy: string;
};

// WHY A 412 NEEDS TO SAY WHICH WRITER MOVED THE STOP.
//
// Two very different things produce the same zero row count from the guarded
// UPDATE: a colleague edited the stop, or the nightly DAG rebuilt the row
// underneath the open dialog (contract §2.1 loads oee.downtime_reports
// DELETE-then-INSERT). Telling an operator "somebody else edited this" when no
// person did names the wrong actor, during the one interaction where being
// believed matters.
//
// The audit trail is the discriminator: an operator edit leaves a
// downtime_report_history row explaining the current value, and a pipeline
// restatement leaves nothing. See DowntimeWriterRepository.editDowntime.
type EditConflictCause = "concurrent" | "restated";

// The outcome of an edit attempt, as the repository reports it.
//
// A TAGGED UNION for the reason CloseShiftReportOutcome is one: the repository
// knows nothing about HTTP, and there are five outcomes carrying four different
// statuses. Collapsing any two would make them indistinguishable to the handler.
//
//   edited    -> 200, with the fields that actually changed
//   unchanged -> 200, and NOTHING was written — see the note on `changed`
//   not_found -> 404
//   approved  -> 409, the freeze
//   conflict  -> 412, carrying which writer got there first
type EditDowntimeOutcome =
  | { kind: "edited"; row: DowntimeRowValues; changed: EditableField[] }
  | { kind: "unchanged"; row: DowntimeRowValues }
  | { kind: "not_found" }
  // Which report froze it, so the message can name the shift rather than saying
  // "some report". A straddling stop can be frozen by a shift that is not its
  // own, and an operator told only "this is approved" would go looking at the
  // wrong report.
  | { kind: "approved"; shift: number }
  | { kind: "conflict"; cause: EditConflictCause };

// The whole stop as the edit path reads it: the four mutable values, the
// identity the freeze check needs, and the denormalised labels the response
// carries back.
//
// DERIVED FROM DowntimeListItem rather than restated, so the edit's response
// cannot drift from the shape the detail table already renders — which is the
// point of returning it at all: the browser writes the edited row through its
// cache instead of refetching the page it is standing on.
//
// Two fields are deliberately absent. `timeZone` is not a column — the service
// stamps it on. `durationMs` is DERIVED from start/end rather than read from the
// `duration` column, for the reason DowntimeListItem states: that column is
// written independently of the timestamps and can disagree with them.
//
// `startAt` / `endAt` are load-bearing beyond display: the freeze check needs the
// stop's own span to work out which shifts it overlaps — a stop straddling 23:00
// belongs to both, so both can refuse the edit.
type DowntimeRowValues = Omit<DowntimeListItem, "timeZone" | "durationMs"> & {
  // NON-NULL here, unlike on DowntimeListItem, because this row was addressed BY
  // it. A stop with no source_event_id cannot be reached by this path at all,
  // which is every stop today.
  sourceEventId: string;
  // Not on DowntimeListItem, which carries the work unit's NAME for display. The
  // freeze needs the id to ask which shift reports exist for that machine.
  workUnitId: number;
};

// The narrow slice of the work-unit module this feature reads.
//
// A PORT, not an import of the repository. AGENTS.md is explicit that modules
// never import each other's internals, and approval state belongs to the
// work-unit module — 0010's "the ABSENCE of a row means open" rule in particular,
// which must exist in exactly one place. WorkUnitReportReaderRepository satisfies
// this shape structurally and is already registered in the container, so this
// costs a type alias and no new class.
//
// Deliberately NOT modelled on MasterDataClientContract: that boundary exists so
// a module can become its own SERVICE without touching call sites. This is one
// method read in-process, and inventing an HTTP-shaped contract for it would be
// six files to move one query.
type DowntimeApprovalReader = {
  listApprovalsOverlapping: (input: {
    workUnitId: number;
    startAt: Date;
    endAt: Date | null;
    timeZone: string;
  }) => Promise<{ shift: number; status: "open" | "closed" }[]>;
};

export {
  DOWNTIME_CATEGORIES,
  EDITABLE_COLUMN,
  EDITABLE_FIELDS,
  DOWNTIME_SORT_BY,
  DOWNTIME_SORT_DIR,
  isSupportedScope,
  priorityOf,
  SCOPE_COLUMN,
  SEGMENT_PRIORITY,
};
export type {
  DowntimeApprovalReader,
  DowntimeCategory,
  DowntimeEdit,
  DowntimeRowValues,
  EditableField,
  EditConflictCause,
  EditDowntimeInput,
  EditDowntimeOutcome,
  DowntimeEvent,
  DowntimeHistoryEntry,
  DowntimeReasonBreakdown,
  DowntimeActionBreakdown,
  ActionBreakdownQuery,
  DowntimeReasonBucket,
  ReasonMeasure,
  ReasonTail,
  DowntimeListFilter,
  DowntimeListItem,
  DowntimeScope,
  DowntimeSortBy,
  DowntimeSortDir,
  ListDowntimeInput,
  ReasonBreakdownFilter,
  ReasonDetail,
  ReasonBreakdownQuery,
  ReasonDetailFilter,
  ReasonHistory,
  ReasonSelector,
  ShiftTimeline,
  SupportedScope,
  TimelineQuery,
  TimelineSegment,
  TimelineSegmentKind,
  TimelineWindow,
  WindowSelector,
};
