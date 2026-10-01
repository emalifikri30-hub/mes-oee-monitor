import type { Paged } from "@molca/network";
// THE TWO BUCKET SHAPES MOVED TO shared/loss-aggregate.ts with the aggregates that
// build them, when the LINE report's Losses page became a second caller. They are
// re-exported below so this module's public surface is unchanged, and the two
// payload types here add each endpoint's own envelope on top of them.
import type { DowntimeEventReasonBucket, RejectReasonBucket } from "../../shared/loss-aggregate.js";
// The per-SKU row shape, moved to shared/ when the Line report's SKU View became a
// second producer of it. Re-exported below, so this module's surface is unchanged.
import type { ProductCountItem } from "../../shared/product-count.js";

// THE MEASURES, and only the measures — the ~30 numbers that are identical on
// all three Gold report tables.
//
// Extracted when the day and month grains became readable, and deliberately
// NOT extended to cover the identity columns beside them. Those genuinely
// differ: a shift row has a `shift`, a month row has a `month` label, and
// mttr/mtbf are NOT NULL on the shift table and nullable on the other two until
// the pipeline computes them. Forcing one type over all of that would need an
// Omit-and-re-add per grain, which reads worse than the honest split below and
// hides exactly the differences a reader needs to see.
//
// What this DOES buy is the thing worth buying: a new measure cannot be added
// to one grain's payload and forgotten on the others, because there is one
// list of them.
type ReportMeasures = {
  teep: number; // percent
  oee: number; // percent
  availability: number; // percent
  performance: number; // percent
  quality: number; // percent
  totalOut: number; // count, in uomCode
  goodOut: number; // count, in uomCode
  effectiveOut: number; // count, in uomCode
  runtime: number; // milis
  availabilityTime: number; // milis
  productionTime: number; // milis
  pdtTime: number; // milis
  operatingTime: number; // milis
  updtTime: number; // milis
  netTime: number; // milis
  reduceSpeedTime: number; // milis
  msTime: number; // milis
  valueAddedTime: number; // milis
  reworkTime: number; // milis
  rejectTime: number; // milis
  anomalyTime: number; // milis
  upSpeedTime: number; // milis
  scheduleLossTime: number; // milis
  availabilityLossTime: number; // milis
  performanceLossTime: number; // milis
  msLossTime: number; // milis
  reduceSpeedLossTime: number; // milis
  qualityLossTime: number; // milis
  reject: number; // count, in uomCode — NOT a duration; rejectTime is that
  rework: number; // count, in uomCode — NOT a duration; reworkTime is that
};

type WorkUnitShiftReportField = ReportMeasures & {
  id: number;
  // `smallint` in Gold, and postgres.js parses int2 as a JS number — so this is
  // 1, not "1". The browser turns it back into a string only where a query param
  // needs one; see shiftTimelineParams in apps/web/src/lib/queries.ts.
  shift: number;
  // `timestamptz` in Gold, holding the instant the shift STARTED — not a business
  // day at midnight, whatever this field's name suggests. For a UTC+7 plant that is
  // 00:00Z / 08:00Z / 16:00Z for shifts 1 / 2 / 3, all of business day N.
  //
  // So a calendar day cannot be read off it without a zone: `date::date` names the
  // right day only where the local and UTC dates happen to coincide. Consumers take
  // the business day via the resolved `timeZone` on WorkUnitShiftReport below.
  date: Date;
  workUnitId: number;
  workUnitCode: string | null;
  workUnitName: string | null;
  workCenterId: number;
  workCenterCode: string | null;
  workCenterName: string | null;
  uomId: number;
  uomCode: string | null;
  uomName: string | null;
  // NOT NULL on oee.work_unit_shift_reports, so non-optional here. Their day and
  // month siblings are nullable — see WorkUnitPeriodReportField.
  mttr: number; // milis
  mtbf: number; // milis
};

// The detail view returns every column; the list view below is the trimmed
// projection a report table needs.
//
// `timeZone` is not a column — the service resolves it per work unit through the
// master-data hierarchy and stamps it on. It is what makes `date` usable: without
// it the browser cannot turn a shift-start instant into the business day it needs
// to request the timeline, and the timeline is the only other place the zone
// appears — a circular dependency.
type WorkUnitShiftReport = WorkUnitShiftReportField & {
  timeZone: string;
  // NESTED rather than flattened alongside the ~40 measures above, and the shape
  // is the point: every other field on this payload is a column the PIPELINE
  // owns, and this is the one fact this service owns. The boundary is easier to
  // respect when it is visible.
  approval: ShiftReportApproval;
};

// ─────────────────────────────────────────────────────────────────────────────
// The coarser grains — oee.work_unit_day_reports and work_unit_month_reports
// ─────────────────────────────────────────────────────────────────────────────
//
// One type for both, discriminated by `grain`, because after migration 0013 the
// two tables differ by exactly one column (`month`). Two near-identical types
// would be two places to add the next measure to.
//
// HOW THIS DIFFERS FROM THE SHIFT REPORT, and why each difference is real:
//
//   no `shift`          - the whole point of the grain.
//   no `approval`       - oee.work_unit_shift_report_approvals is keyed
//                         (work_unit_id, date, shift). There is nothing to key a
//                         day or month approval on, and inventing one would
//                         assert a sign-off nobody gave. The day screen shows a
//                         DERIVED count instead; see PeriodApprovalSummary.
//   mttr/mtbf nullable  - 0013 added the columns; nothing writes them yet. NULL
//                         means "not computed" and renders as an em dash. A
//                         DEFAULT 0 would have claimed a perfect repair time on
//                         every unwritten row.
//   businessDate        - a real `date`, not derived from `date` through a zone.
//                         This is what makes the window resolvable without a
//                         mes-master-data round trip, and what makes the month
//                         filter exact rather than off by a shift at each end.
type PeriodGrain = "day" | "month";

// THE COARSE GRAINS THE OEE PERFORMANCE DASHBOARD READS, which is `PeriodGrain`
// plus the one `0027` added.
//
// A SEPARATE TYPE RATHER THAN A WIDENED `PeriodGrain`, and the separation is the
// point. Only FOUR reads answer at year grain — the list, the detail, the OEE
// trend and the reject breakdown — because a year report has no Report screen and
// therefore no products card, no activity feed, no stale-metrics banner and no
// hourly profile. Widening `PeriodGrain` would make `getPeriodPerformance("year",
// id)` compile and 404 at runtime; keeping them apart makes it a build error.
//
// There is no year APPROVAL either, and there cannot be one:
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift), and
// approving a year would close every shift report inside it — which is not a
// permission any of the six role variables grants.
type CoarseGrain = PeriodGrain | "year";

type WorkUnitPeriodReportField = ReportMeasures & {
  id: number;
  // Not a column - stamped by the repository from which table it read, so a
  // consumer can tell two payloads apart without tracking which endpoint
  // produced them.
  grain: CoarseGrain;
  // The instant the period STARTED: 07:00 plant-local on its first business day.
  // Carried because it is half of both upsert keys; nothing reads it for display.
  //
  // NULL AT YEAR GRAIN, because `oee.work_unit_year_reports` HAS NO SUCH COLUMN.
  // `0003` captured `date` from a populated upstream schema and `0013` kept it;
  // `0014` dropped it deliberately for the line grain and `0027` followed that for
  // a table with no upstream legacy. Sent as NULL rather than fabricated from
  // `business_date` — an instant derived here would be a value nothing measured,
  // in the one field that exists to be an instant.
  date: Date | null;
  // THE ONE TO USE. The plant-local business day this row summarises - for a
  // month, its first. Nullable only because 0013 could not make it NOT NULL
  // while the pipeline was not yet writing it; a row without it cannot be
  // reduced to a window, and the service treats that as unresolvable rather than
  // guessing.
  businessDate: string | null;
  // IANA zone, off the row rather than resolved per request.
  timeZone: string | null;
  // The month table's own varchar(50) label. Present so nothing is silently
  // dropped, and deliberately NOT rendered: its format is unspecified upstream
  // (gold-write-contract §15.7), so the screens format from businessDate.
  // Always null at day grain.
  month: string | null;
  workUnitId: number;
  workUnitCode: string | null;
  workUnitName: string | null;
  // Nullable here, NOT NULL on the shift table - 0013 added the column and the
  // pipeline does not fill it yet. The downtime edit dialog needs it to scope its
  // Reason catalogue, and degrades to an unscoped picker when it is absent.
  workCenterId: number | null;
  workCenterCode: string | null;
  workCenterName: string | null;
  uomId: number;
  uomCode: string | null;
  uomName: string | null;
  mttr: number | null; // milis, null until the pipeline computes it
  mtbf: number | null; // milis, null until the pipeline computes it
};

// What the day screen's Status tile renders, and it is NOT an approval.
//
// There is no day approval and no signer. This counts the shift reports inside
// the day's window and how many are closed, so the tile can say "2 of 3 shifts
// approved" - a statement about three other records, which cannot be misread as
// a sign-off on this one. An Open/Closed badge here would assert exactly that.
//
// Null at month grain: that screen has no such tile at all.
type PeriodApprovalSummary = {
  shiftsTotal: number;
  shiftsClosed: number;
};

type WorkUnitPeriodReport = WorkUnitPeriodReportField & {
  approval: PeriodApprovalSummary | null;
};

// The trimmed projection the By Day / By Monthly tables need. No `status`,
// unlike the shift list: the approval count is a per-row window query and the
// list deliberately does not pay for it.
type WorkUnitPeriodReportList = Pick<
  WorkUnitPeriodReportField,
  | "id"
  | "grain"
  | "date"
  | "businessDate"
  | "month"
  | "workUnitId"
  | "oee"
  | "availability"
  | "performance"
  | "quality"
>;

type WorkUnitPeriodReportEnrichedList = Omit<WorkUnitPeriodReportList, "workUnitId"> & {
  timeZone: string | null;
  workCenter: { id: number; code: string; name: string } | null;
  workUnit: { id: number; code: string; name: string } | null;
};

// The shift list's filter minus `shift` (no such thing here) and minus `status`
// (nothing to filter on - see WorkUnitPeriodReportList).
type WorkUnitPeriodReportFilter = {
  month?: number;
  year?: number;
  workUnitIds?: number[];
  // A PLAIN COLUMN PREDICATE, unlike `workUnitIds` above it, and the contrast is
  // the whole reason both are here. A `workCenterId` reaches this type as a LIST
  // of machine ids resolved through mes-master-data (see `resolveWorkUnitIds`);
  // an `areaId` reaches it as itself, because migration `0028` put `area_id` on
  // the three coarse tables. One filter costs an upstream HTTP call that is FATAL
  // on failure; the other costs a WHERE clause.
  //
  // It is NOT resolved into `workUnitIds` even though it could be. Doing so would
  // make the area filter inherit `resolveWorkUnitIds`'s empty-page short circuit
  // and its 404, and would answer "which machines are in this area NOW" where the
  // column answers "which area did the pipeline attribute this row to" — the
  // distinction TODOS §55 draws for the line filter, and the historically correct
  // side of it for a report about last August.
  areaId?: number;
  isHideZero?: boolean;
};

type ListWorkUnitPeriodReportInput = {
  grain: CoarseGrain;
  limit: number;
  offset: number;
  filter: WorkUnitPeriodReportFilter;
};

type PeriodReportListRow = WorkUnitPeriodReportList;
type PagedWorkUnitPeriodReport = Paged<PeriodReportListRow>;

// Enough to build the window: which machine, which business day, which zone.
// The day/month analogue of ReportScope in work-unit-repository.ts, and unlike
// that one it needs no mes-master-data call - 0013 put both columns on the row.
type PeriodReportScope = {
  workUnitId: number;
  workCenterId: number | null;
  businessDate: string | null;
  timeZone: string | null;
};

// `status` is intersected rather than Pick-ed, because it is NOT a column on
// oee.work_unit_shift_reports — it comes from the approvals table, which is
// deliberately keyed on the natural key rather than joined by report id. See
// migration 0010.
type WorkUnitShiftReportList = Pick<
  WorkUnitShiftReportField,
  "id" | "shift" | "date" | "workUnitId" | "oee" | "availability" | "performance" | "quality"
> & {
  status: ApprovalStatus;
};

type WorkUnitShiftReportEnrichedList = Omit<WorkUnitShiftReportList, "workUnitId"> & {
  // Resolved per work unit, and nullable for the same reason the labels below are:
  // enrichment degrades rather than failing the page. Null means the zone could not
  // be resolved, so `date` cannot be reduced to a calendar day — the client shows a
  // dash rather than guessing UTC and rendering a plausible wrong day.
  timeZone: string | null;
  workCenter: {
    id: number;
    code: string;
    name: string;
  } | null;
  workUnit: {
    id: number;
    code: string;
    name: string;
  } | null;
};

type WorkUnitShiftReportFilter = {
  month?: number;
  year?: number;
  shift?: number;
  workUnitIds?: number[];
  // `area_id` on oee.work_unit_shift_reports since `0028`. See the twin field on
  // WorkUnitPeriodReportFilter for why this is a column and `workUnitIds` is a
  // resolved list.
  areaId?: number;
  isHideZero?: boolean;
  // Approval state, filtered SERVER-SIDE. Absent means "both".
  //
  // Reuses ApprovalStatus rather than restating the two literals, so a third
  // state — if approval ever grows one — cannot be admitted here and rejected by
  // the query, or the reverse.
  status?: ApprovalStatus;
};

type ListWorkUnitShiftReportInput = {
  limit: number;
  offset: number;
  filter: WorkUnitShiftReportFilter;
};

// What the page QUERY returns, before the service attaches approval state.
//
// `status` is not on it because oee.work_unit_shift_reports has no such column
// and paginateShiftReport deliberately does not join the approvals table — see
// listApprovalsForPage in the repository for why. Stating that in the type keeps
// the two halves of the read honest about which one owns the field.
type ShiftReportListRow = Omit<WorkUnitShiftReportList, "status">;

type PagedWorkUnitShiftReport = Paged<ShiftReportListRow>;

// One product's hour inside one shift, from oee.product_perf_wu_hour.
//
// STORED COLUMNS ONLY. No rate and no average is computed here, and that is the
// design rather than an omission: a rate is a ratio, and the correct value at any
// grain is sum(total_out) / sum(runtime), never the mean of per-bucket rates. The
// browser derives it once in lib/perf-hourly.ts and a BI tool derives it from the
// same two columns, so the chart and the report agree by construction. Compute it
// here as well and there would be two places to disagree.
//
// Absence is meaningful: a bucket with no row is an hour this product did not run,
// which is NOT the same as an hour it ran and made nothing. The browser draws a
// gap for the first and a point at zero for the second.
type PerfHourBucket = {
  // The instant the hour started, and the sort key. Never sort by the clock
  // label: shift 3 runs 23:00 -> 07:00, so its labels sort 00,01,...,06,23 and
  // put the shift's FIRST hour last.
  bucketStart: Date;
  bucketEnd: Date;
  // Local clock hour 0-23, and the bucket's 0-based position in its shift. Both
  // are labels the pipeline computed in the plant's zone; hour_of_day is also the
  // GROUP BY key a month-grain hour-of-day profile will use.
  hourOfDay: number;
  shiftHourSeq: number;
  productId: number;
  productName: string;
  productCode: string;
  // Every measure on this row is in this unit — not split base/production like
  // ProductCountItem, because a rate and its standard must share a unit or they
  // cannot be compared.
  uomCode: string;
  totalOut: number; // Actual Production, in uomCode
  effectiveOut: number; // Effective Production, in uomCode
  runtime: number; // milis — the denominator of every rate derived from this row
  // The master standard, in uomCode per hour. Null means no standard was known
  // when the row loaded — a real and recurring state, not a zero. Rendering it as
  // 0 would make the target "make nothing"; substituting the actual rate would
  // make the loss vanish. The chart omits the series instead.
  idealRatePerHour: number | null;
};

// One hour-of-day bucket of a MONTH's performance profile, per product.
//
// WHY A MONTH NEEDS A DIFFERENT SHAPE AT ALL. A month holds ~720 hourly rows per
// product. No line chart can draw that, so the month view answers a different
// question — "which hour of the day does this machine run worst" — by collapsing
// every occurrence of each clock hour into one point. 24 points, not 720.
//
// So there is no `bucketStart`: this bucket is not an instant, it is an hour of
// the clock that occurred ~30 times. Synthesising an instant for it was the
// alternative and is rejected — it would have to name a date, and on a DST month
// the same local hour occurs twice or not at all, which would collapse or
// duplicate a point silently.
type HourProfileBucket = Omit<PerfHourBucket, "bucketStart" | "bucketEnd" | "shiftHourSeq">;

// The payload behind the Losses card's View button on a MONTH report.
type HourOfDayProfile = {
  timeZone: string;
  // The plant-local hour a business day starts — 7 today, from
  // shared/shift-window.ts. Sent so the browser can build a complete 24-point
  // axis in BUSINESS-DAY order without a copy of SHIFT_WINDOWS of its own.
  //
  // Without it the axis would run 00..23 and split the night shift across both
  // ends of the chart, which is exactly the reading error the shift chart's own
  // "never sort by the clock label" note warns about.
  dayStartHour: number;
  buckets: HourProfileBucket[];
  // product_perf_wu_hour's watermark, on the same terms as ShiftPerformance's.
  loadedThrough: string | null;
};

// The payload behind the Losses card's View button.
//
// `timeZone` rides along for the same reason it does on WorkUnitShiftReport: the
// bucket labels are local clock times, and the browser has no work-unit-to-zone
// table of its own.
type ShiftPerformance = {
  timeZone: string;
  buckets: PerfHourBucket[];
  // oee.etl_watermarks.last_business_date for product_perf_wu_hour: the furthest
  // business day the pipeline has loaded. Null means never loaded.
  //
  // This is what lets an empty `buckets` be reported honestly. Without it, a shift
  // whose rows have not loaded yet and a machine that genuinely idled render
  // identically — the failure the watermark table was created for on the timeline
  // and the SKU card (TODOS.md §8 and §14), closed here BEFORE it ships rather
  // than after.
  loadedThrough: string | null;
};

// One reject counter's total for one work unit, shift and product, from
// oee.reject_count_wu_shift. Already aggregated by the repository; no consumer
// re-derives a count from raw rows.
//
// TWO NUMBERS FOR ONE FACT, and both ship because the design shows both columns.
// `counterValue` is what the sensor counted, in `counterUnit` — 48 CALENDER.
// `quantity` is the same rejects with each row's factor_to_base applied, in
// `convertedUnit` — 576 BAG. Only the second is comparable or summable across
// counters, and it is what the Pareto plots.
//
// This is ProductCountItem's factor_to_base doctrine with one difference worth
// naming: there the converted form is the only one that ships and `goodOut` is
// the lone unscaled exception, so the card shows one number per measure. Here a
// plant reads its counters in their own units AND needs to compare them, so both
// forms travel side by side, each labelled with its own unit.
type RejectReasonBreakdown = {
  timeZone: string;
  buckets: RejectReasonBucket[];
  // FOUR DENOMINATORS, one per measure the card can rank by. Sent rather than
  // left to the browser to sum for the reason DowntimeReasonBreakdown's two are:
  // the cumulative line divides by the response's own total, so it stays correct
  // the day this endpoint grows a LIMIT and an "Other" bucket.
  totalFrequency: number;
  totalDurationMs: number;
  totalQuantity: number;
  // NULL when no counter in the shift carries a weight at all. A null
  // denominator yields null percentages rather than NaN, which is the honest
  // answer for a measure nothing was recorded in — deliberately NOT coalesced
  // to 0, which would claim the shift was weighed and found empty.
  totalWeightGram: number | null;
  // Non-null only when every bucket agrees. NULL means the shift mixed base
  // units, so there is no single converted total and the card says so instead of
  // adding BAG to CARTON.
  convertedUnit: string | null;
  // oee.etl_watermarks.last_business_date for reject_count_wu_shift. Null means
  // never loaded — which is the state of the world until the DAG runs, and
  // exactly why this field matters more here than anywhere else it appears: the
  // table ships EMPTY, so without it the tab would report every shift as a clean
  // one. contract §3.8.
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// The Others tab — downtime reason FREQUENCY, from the immutable event log
// ---------------------------------------------------------------------------

// One downtime reason's occurrence count for one shift, from
// oee.downtime_log_events.
//
// FREQUENCY ONLY. There is no duration on this bucket because there is none in
// the table — the log records that a reason was cited, not how long it lasted.
//
// NOT A REUSE OF DowntimeReasonBucket, and the divergence is deliberate. That
// type carries `durationMs` and `workUnitNames` and reads a table operators can
// edit; this one carries neither and reads a table nobody may. Keeping the two
// disjoint is the argument TODOS.md §29 makes for keeping ParetoMeasure at two
// members and quality out of DowntimeCategory: structural reuse across two
// sources that will diverge turns a future divergence into a silent fall-through
// instead of a compile error.
type DowntimeEventBreakdown = {
  timeZone: string;
  buckets: DowntimeEventReasonBucket[];
  // THE DENOMINATOR, and the only one. Equal to the sum of every bucket's
  // `frequency` BY CONSTRUCTION: the buckets and this number are two aggregates
  // over one shared row set, a single GROUP BY apart. Sent rather than left to
  // the browser to sum for the reason DowntimeReasonBreakdown's two totals are —
  // the cumulative line divides by the response's own total, so it stays correct
  // the day this endpoint grows a LIMIT and an "Other" tail (TODOS.md §25).
  totalOccurrences: number;
  // NOT the denominator. The number of downtime EVENTS in the shift, which is
  // <= totalOccurrences and is strictly smaller as soon as any event cited more
  // than one reason.
  //
  // It ships so the card can state the difference IN WORDS — the bars sum to
  // occurrences, not to stops — rather than leaving a supervisor to assume the
  // two are one number. Nothing divides by it, and nothing should.
  totalEvents: number;
  // oee.etl_watermarks.last_business_date for downtime_log_events. Null means
  // never loaded, which is the state of the world until the DAG runs: the table
  // ships EMPTY (contract §1 rule 2, §3.9), so without this field the tab would
  // report every shift as a shift nothing stopped. The flattering reading and the
  // wrong one.
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// Approval — the one thing on this screen this service writes
// ---------------------------------------------------------------------------
//
// Backed by oee.work_unit_shift_report_approvals (migration 0010), which is
// keyed on (work_unit_id, date, shift) and NOT on the report's id. That is the
// whole design, and its header explains why; the consequence visible from here
// is that a report with NO approval row is `open`, so `status` is never null
// even though every other field is.

type ApprovalStatus = "open" | "closed";

// WHO closed it, categorically. NOT a third ApprovalStatus: an auto-closed
// report is closed in every way that matters to a reader, and folding
// provenance into the status would make every caller write
// `status IN ("closed", "auto_closed")` and the first one to forget under-count
// silently. See 0010's header.
type ApprovalSource = "operator" | "system";

type ShiftReportApproval = {
  // Never null. The ABSENCE of a row means open, and the repository coalesces.
  status: ApprovalStatus;
  // All four are null while open, guaranteed by ck_wusra_open in 0010.
  closedAt: Date | null;
  // The Keycloak subject. Null for `source: "system"`, which is why the deferred
  // 14-day sweeper (TODOS.md §31) needs no fictional user.
  closedBy: string | null;
  // preferred_username as it was at closing time. Display only.
  closedByName: string | null;
  source: ApprovalSource | null;
};

// The outcome of an approve attempt, as the repository reports it.
//
// A TAGGED UNION rather than a throw or an `undefined`. The repository is the
// SQL layer and knows nothing about HTTP, and unlike its read siblings — where
// `undefined` means "no such row" and the service turns that into a 404 — there
// are THREE outcomes here and two of them are failures with different statuses.
// Collapsing them would make 404 and 409 indistinguishable, which is exactly the
// bug the separate existence check inside the transaction exists to prevent.
type CloseShiftReportOutcome =
  | { kind: "closed"; approval: ShiftReportApproval }
  | { kind: "not_found" }
  | { kind: "already_closed" };

// The mirror of the above, for the reverse transition.
//
// A SEPARATE UNION rather than one shared `{ kind: "conflict" }`, because the two
// conflicts are opposite claims — "this is already closed" and "this is already
// open" — and a single type would let a handler render one as the other. Both are
// 409, and the message is the whole information content of a 409 here.
//
// `reopened` carries the approval for the reason `closed` does: contract §8 wants
// read-after-write, and the browser flips the badge from this payload rather than
// from a refetch.
type ReopenShiftReportOutcome =
  | { kind: "reopened"; approval: ShiftReportApproval }
  | { kind: "not_found" }
  | { kind: "already_open" };

// ---------------------------------------------------------------------------
// Metrics staleness — what an operator edit has made the aggregates wrong about
// ---------------------------------------------------------------------------
//
// ONE FIELD, AND IT IS A FACT RATHER THAN A VERDICT.
//
// Editing a downtime's `reason`, `actions` or `detail_reason` cannot make
// anything on screen wrong: the Pareto, the drill-down and the drawer all read
// oee.downtime_reports LIVE, so those edits are already reflected. Editing its
// `category` moves time between schedule loss and availability loss, and THOSE
// totals are precomputed by the pipeline into oee.work_unit_shift_reports — so
// the OEE tiles, the timeline strip and the waterfall keep showing the pre-edit
// split until the pipeline recomputes them.
//
// WHAT THIS TYPE DELIBERATELY DOES NOT CARRY: a boolean.
//
// `stale: true` would be a claim about the PIPELINE, and this service cannot
// make it. The obvious source is oee.etl_watermarks.last_run_at, and comparing
// against it is wrong in the flattering direction — that watermark is
// TABLE-grained, so a run covering other days advances it past the edit without
// recomputing this report, and the flag would clear while the tiles were still
// wrong. Per-report confirmation is not knowable until the recalculation trigger
// exists (TODOS.md), so the browser is given the instant and states exactly that:
// this changed at T, and these cards are computed elsewhere.
// GET /work-units/shift-reports/:id/products.
//
// AN OBJECT, AND IT USED TO BE A BARE ARRAY. That change is the whole of
// TODOS.md §14: the card rendered "No product output recorded for this shift" for
// a machine that genuinely ran nothing AND for a business day the pipeline had not
// reached. Those are opposite claims, and an array cannot carry the difference.
//
// It now matches /performance, /rejects and /downtime-events, all of which are
// objects for the same reason — they each carry a fact the rows cannot state about
// themselves.
type ShiftProductCounts = {
  items: ProductCountItem[];
  // The plant zone. Needed to reduce the report's shift-start instant to a
  // business day before it can be compared with `loadedThrough`, and the browser
  // has no zone table.
  timeZone: string;
  // How far the pipeline has loaded oee.product_count_wu_shift. NULL means never,
  // which is a third state and must not read as "loaded through the epoch".
  loadedThrough: string | null;
};

type MetricsStaleness = {
  // When a stop in this shift last had its category changed. Null means never,
  // which is every report today — nothing has written
  // oee.downtime_report_history yet.
  categoryEditedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Activity — the report's audit trail
// ---------------------------------------------------------------------------
//
// Three sources, unioned newest-first, and TWO OF THEM CANNOT PRODUCE A ROW
// TODAY. That is not a defect being hidden; it is the fact this whole type
// exists to state precisely. See `ActivitySource`.

type ActivityKind = "approval" | "downtime" | "quality";

// WHY a trail cannot exist, as an enum on the wire with the prose in the
// browser — the same discipline that keeps the string "Unspecified" out of
// DowntimeReasonBucket.reason. Copy is a presentation concern, and a sentence
// on the wire cannot be re-worded without a deploy or read in a second language.
//
//   no-source        no table records this class of change AT ALL
//   no-stable-id     the rows exist but carry no key a trail could hang from
//   not-implemented  the write path that would produce these has not shipped
//   not-applicable   THE EVENT DOES NOT EXIST AT THIS GRAIN, and never will
//
// The first three all describe a trail that COULD exist and does not yet, which
// is why the fourth had to be its own value rather than a reuse of `no-source`:
// the SKU day feed's approval arm is not "no table records approvals", it is
// "a SKU report has no sign-off to record". Reusing `no-source` would have printed
// a sentence about reject and rework figures under the word "Approvals".
//
// THIS LIST IS DECLARED THREE TIMES — here, in work-center.ts and in
// product-report.ts — because modules do not import each other's internals; what
// they share is the WIRE vocabulary. The browser's NOT_TRACKED_BODY is a TOTAL map
// over it, so a value added on this side and not there renders a blank sentence,
// and the web half should land first.
type UntrackedReason = "no-source" | "no-stable-id" | "not-implemented" | "not-applicable";

// One arm of the union, and whether it is CAPABLE of having an answer.
//
// ALL THREE ARE ALWAYS PRESENT, including the one that can never carry an entry.
// Omitting an arm that has nothing to say is precisely the lie this type exists
// to prevent: the reader would see a complete-looking chronology with the
// quality half silently missing, and the flattering reading — "no quality issues
// were edited" — would be the wrong one. Same failure shape as TODOS.md §8.
type ActivitySource = {
  kind: ActivityKind;
  // Computed server-side so the browser cannot get the comparison backwards in
  // one of two places.
  tracked: boolean;
  // Null if and only if `tracked`.
  untrackedReason: UntrackedReason | null;
  // How many things of this kind belong to this shift, and how many of them
  // could ever carry a trail. The same two numbers, with the same meaning, as
  // ReasonHistory's totalMembers / trackedMembers.
  totalMembers: number;
  trackedMembers: number;
};

// A discriminated union, because an approval is NOT a field change. Forcing it
// into field-change vocabulary would put `field: "status"` on the wire, naming a
// column that does not exist.
type ActivityEntry =
  | {
      kind: "approval";
      // PREFIXED — "approval:41", "downtime:912". The two arms come from two
      // tables with independent bigserials, so a bare id would collide and React
      // would reuse the wrong row's DOM node.
      id: string;
      at: Date;
      // The Keycloak subject. Durable, and NOT what to render — see byName.
      // Null only for a system transition, which has no person behind it.
      by: string | null;
      // The display label captured at the time. Both travel because they answer
      // different questions: `by` is who, `byName` is what to put on screen.
      byName: string | null;
      fromStatus: ApprovalStatus;
      toStatus: ApprovalStatus;
      source: ApprovalSource;
      // WHICH shift report this transition belongs to. Null at shift grain, where
      // there is only one and naming it would be noise; a number at day and month
      // grain, where the feed spans three or ~90 reports and an unattributed
      // transition reads as an approval of the period itself — which is the one
      // thing there is no such thing as.
      shift: number | null;
    }
  | {
      kind: "downtime";
      id: string;
      at: Date;
      by: string;
      sourceEventId: string;
      // category | reason | actions | detail_reason — constrained by
      // ck_downtime_report_history_field in 0007, not here.
      field: string;
      // jsonb: a string, an array of them, or null. Rendered through one helper
      // in the browser, or an array reaches the DOM as "[object Object]".
      oldValue: unknown;
      newValue: unknown;
    }
  | {
      // An operator-entered reject an operator ATTRIBUTED TO THIS MACHINE
      // (migration 0017). The quantity lands on the LINE — a line is measured at
      // its own count points — but the operator picked this machine and said the
      // rejects were here, so a trail on this machine's report that omitted it
      // would be missing the one fact they contributed.
      //
      // REWORK NEVER APPEARS, structurally rather than by a filter: a rework
      // carries no work_unit_id, so a machine-scoped read cannot return one.
      kind: "quality";
      id: string;
      at: Date;
      by: string;
      byName: string | null;
      entryKind: string;
      enteredQty: number;
      enteredUomCode: string;
      targetQty: number;
      targetUomCode: string;
      productName: string | null;
      reasonName: string | null;
      // WHICH SHIFT the operator recorded it in, on exactly the terms the approval
      // arm above carries the field: null at shift grain, where the feed covers one
      // shift and naming it would be noise; a number at day and month grain, where
      // the feed spans three shifts or ~90 and two entries of the same quantity
      // against the same machine are otherwise indistinguishable.
      //
      // A SECOND FIELD ON THE ENTRY RATHER THAN A SECOND ARM, because an entry is
      // shift-keyed by construction (0017) — the value is always known; what
      // changes by grain is whether it is worth saying.
      shift: number | null;
      voidedAt: Date | null;
      voidedBy: string | null;
      voidedByName: string | null;
      voidReason: string | null;
    };

// NO `loadedThrough`, unlike /performance, /rejects and /downtime-events. Every
// other empty payload on this screen is ambiguous because an ETL may not have
// run, and the watermark is what separates "not loaded" from "nothing happened".
// This one is ambiguous because a WRITE PATH has not shipped, and `sources` says
// so precisely and per-arm. A watermark here would answer a question nobody
// asked.
//
// NO `meta`: unpaged. A chronology, not a table — the rule
// /downtimes/by-reason/history already states. What bounds it is one machine's
// one shift.
type ShiftActivity = {
  // Echoed for the reason every other payload here echoes it: `at` renders as a
  // wall-clock time and the browser has no zone table.
  timeZone: string;
  // Merged newest-first, NOT grouped by kind — the reader's question is "what
  // happened to this report", which is one timeline.
  entries: ActivityEntry[];
  // Always length 3.
  sources: ActivitySource[];
};

export type {
  ActivityEntry,
  ActivityKind,
  ActivitySource,
  ApprovalSource,
  ApprovalStatus,
  CloseShiftReportOutcome,
  MetricsStaleness,
  ReopenShiftReportOutcome,
  ShiftProductCounts,
  DowntimeEventBreakdown,
  DowntimeEventReasonBucket,
  ShiftActivity,
  ShiftReportApproval,
  UntrackedReason,
  PerfHourBucket,
  ProductCountItem,
  RejectReasonBreakdown,
  RejectReasonBucket,
  HourOfDayProfile,
  HourProfileBucket,
  ShiftPerformance,
  ListWorkUnitPeriodReportInput,
  PagedWorkUnitPeriodReport,
  PeriodApprovalSummary,
  CoarseGrain,
  PeriodGrain,
  PeriodReportListRow,
  PeriodReportScope,
  ReportMeasures,
  WorkUnitPeriodReport,
  WorkUnitPeriodReportEnrichedList,
  WorkUnitPeriodReportField,
  WorkUnitPeriodReportFilter,
  WorkUnitPeriodReportList,
  WorkUnitShiftReportField,
  WorkUnitShiftReport,
  WorkUnitShiftReportList,
  WorkUnitShiftReportFilter,
  ListWorkUnitShiftReportInput,
  PagedWorkUnitShiftReport,
  ShiftReportListRow,
  WorkUnitShiftReportEnrichedList,
};
