import type { Paged, PagedResult } from "@molca/network";
import type { ReportWindow } from "../../shared/report-window.js";

// THE LINE GRAIN — oee.work_center_{shift,day,month}_reports.
//
// One row per LINE per period, rolled up across the machines on that line by
// Airflow/dbt. Migration 0014 creates the tables; docs/gold-write-contract.md §16
// is the contract. This service reads them and never writes them.
//
// WHY A SEPARATE MODULE FROM work-unit RATHER THAN A FOURTH GRAIN INSIDE IT.
// This is a different SUBJECT, not a different grain of the same subject.
// Everything reusable in work-unit is keyed by `work_unit_id` and does not apply
// here: resolveWorkUnitIds, enrich<T extends { workUnitId: number }>,
// attachApprovalStatus, summariseApprovalsInWindow, and the whole writer
// repository. What genuinely is shared already lives in shared/.
//
// THREE GRAINS BEHIND ONE IMPLEMENTATION, where work-unit needs two.
// In work-unit, `shift-reports` is a genuinely different implementation: an
// approvals correlated subquery, a `status` filter, a `date`-timestamptz period
// filter, and eight sub-resources. Here all three tables differ by EXACTLY ONE
// COLUMN (`shift`), all three key and filter on `business_date`, none has an
// approval COLUMN, and the list projection is identical. One loop over three is
// honest. (The line APPROVAL that shipped later is a cascade over the machine
// tables — see CascadeOutcome — so it adds nothing to these three.)
type ReportGrain = "shift" | "day" | "month";

// THE COARSE GRAINS THE OEE PERFORMANCE DASHBOARD READS. `0027` added
// `oee.work_center_year_reports`, and this is the union that reaches it.
//
// SEPARATE FROM `ReportGrain` RATHER THAN A FOURTH MEMBER OF IT, and the reason is
// the loop above: all three of the tables `ReportGrain` names differ by exactly one
// column and share eight sub-resources, which is what makes ONE registration loop
// honest. The year table has no shift, no products, no machines, no hourly profile
// and no approval — a year approval would cascade over three shifts AND N machines,
// which is an authority nobody has granted (§48) — so admitting it to that union
// would put a value in every one of those signatures that has no table to read.
// Four reads answer at year grain and they take this type.
type CoarseGrain = "day" | "month" | "year";

// WHAT THIS GRAIN DELIBERATELY DOES NOT HAVE, and why each absence is a decision:
//
//   no `approval` FIELD and no `status` FILTER — though approve and reopen exist
//       oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift)
//       and these tables have NO work_unit_id column at all, so the correlated
//       subquery a `status` filter would need cannot even be written.
//
//       APPROVING A LINE IS NEVERTHELESS POSSIBLE, and the resolution to "the line
//       is closed has two incompatible meanings — all of its machines, or any of
//       them" was to make the WRITE the definition rather than the read: approving
//       a line closes every machine shift report on it, and its status is a COUNT
//       of those (CascadeOutcome). One definition of "approved" in the app, and
//       nothing on this row to correlate a filter against. TODOS §53 records the
//       decision; §48 holds the day cascade, which should reuse this mechanism.
//
//   no per-product rows
//       `factor_to_base` differs per product, so summing counts across machines
//       has to happen after conversion to a base unit, and the "Finish Good stays
//       in its production unit" rule stops being expressible once two machines
//       count the same SKU in different units. TODOS §15 is still open; these
//       tables do not answer it.
type WorkCenterReportListRow = {
  id: number;
  // Stamped by the repository from the grain it was asked for, not stored — the
  // three tables are distinguished by which one answered.
  grain: ReportGrain;
  // 'YYYY-MM-DD', already plant-local. NOT an instant: there is no `date
  // timestamptz` column on these tables at all, deliberately (0014's header).
  // The browser must never put this through a zone conversion.
  businessDate: string;
  timeZone: string;
  // NULL at day and month grain, where the column does not exist — selected as a
  // literal NULL so all three grains come back the same shape and the mapper
  // needs no branch.
  shift: number | null;
  workCenterId: number;
  workCenterName: string;
  workCenterCode: string | null;
  // Machines that REPORTED into this row, and the line's roster per master-data.
  //
  // BOTH ARE COLUMNS, and that is a performance decision as much as a modelling
  // one. Resolving the roster at read time would mean one mes-master-data call
  // per line per page — an N+1 (TODOS §3 names it) on a read that otherwise
  // touches nothing but Gold. The pipeline already joins master-data to
  // denormalise work_center_name, so it is asked for there instead (§16.5).
  //
  // `expectedWorkUnitCount` is null when the pipeline could not resolve it, and
  // the screen then renders a bare count rather than a guess.
  workUnitCount: number;
  expectedWorkUnitCount: number | null;
  // Nullable, unlike the work_unit_* tables, because 0/0 is real at this grain:
  // a line whose machines were all in planned downtime has production_time = 0.
  // A fabricated 0% is a measurement where NULL is the truth.
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// The list filter.
//
// `shift` is accepted ONLY at shift grain. At day and month it never reaches the
// repository, because those tables have no such column — and answering a filtered
// request with an unfiltered page reads as data rather than as an error.
//
// There is no `status`, at any grain. See WorkCenterReportListRow above.
type WorkCenterReportFilter = {
  month?: number | undefined;
  year?: number | undefined;
  shift?: number | undefined;
  // A PLAIN SQL PREDICATE, not an id list resolved through mes-master-data.
  //
  // The work_unit lists translate a workCenterId into a list of machine ids
  // upstream, fatally on failure, because their tables are keyed on the machine.
  // Here work_center_id IS the grain key, so the filter is `AND
  // r.work_center_id = $` and the whole read path makes zero HTTP calls.
  //
  // ONE CONSEQUENCE, DOCUMENTED RATHER THAN LEFT TO BE FOUND: an unknown line id
  // answers 200 with an empty page here, where /work-units/* answers 404. That
  // 404 exists to guard a specific failure of the ID-LIST mechanism — an empty
  // list being dropped as "no filter" and returning every machine's rows. There
  // is no id list here, the predicate always filters, and an unknown id matches
  // nothing. The guard has nothing left to guard.
  workCenterId?: number | undefined;
  // The header area picker, and a LABEL rather than a key — `0014` denormalised
  // `area_id` onto the three grain tables and `0027` onto the year one. So unlike
  // `workCenterId` above, an absent value here can mean the pipeline has not
  // resolved the hierarchy yet, and such a row is excluded from every area-scoped
  // list. shared/area-scope.ts states why that is accepted rather than counted.
  areaId?: number | undefined;
  isHideZero?: boolean | undefined;
};

// THE DETAIL PAYLOAD — GET /work-centers/{grain}-reports/:id.
//
// The list row plus every measure, which is the whole difference between the two:
// a list answers "which line, how good", a detail answers "where did the time go".
//
// TWO UOM TRIPLES, FLAT AND SEPARATELY NAMED, and this is the field group to read
// before touching anything downstream. A machine has ONE count point and therefore
// one `uom_*`; a line has two, and they are usually different — bags in, cartons
// out (migration 0014's header, contract §16.4a). So:
//
//     total_out, reject, rework, line_out   ->  infeedUom*
//     goodOut, effectiveOut                 ->  outputUom*
//
// `total_out = good_out + reject + rework` IS FALSE HERE BY CONSTRUCTION. 100 bags
// in yielding 10 cartons out is not a 90% loss, and nothing on either side of the
// wire may compute across the two groups.
//
// Collapsing these into one `uomName` is what a paste from WorkUnitShiftReport
// produces, and it renders cartons under a bag label — a wrong number that looks
// completely ordinary. Keeping the names apart makes that collapse a type error
// rather than a judgement call.
//
// NO `approval` FIELD, deliberately. A line's approval summary is its own route
// (/shift-reports/:id/approval) because computing it needs the line's ROSTER from
// mes-master-data, which is not cached — folding it in here would put an uncached
// upstream call on the path the browser's loader AWAITS. That is exactly the
// reasoning /work-units/shift-reports/:id/metrics-staleness already shipped with.
//
// Every duration is milliseconds and the loss durations may be negative. Every
// rate and every count is NULLABLE at this grain: 0/0 is real for a line whose
// machines were all in planned downtime, and NULL means "not established" — never
// 0, which would be a measurement.
type WorkCenterReport = {
  id: number;
  grain: ReportGrain;
  businessDate: string;
  timeZone: string;
  // NULL at day and month grain, where the column does not exist.
  shift: number | null;
  workCenterId: number;
  workCenterName: string;
  workCenterCode: string | null;
  areaId: number | null;
  areaName: string | null;
  workUnitCount: number;
  expectedWorkUnitCount: number | null;

  infeedUomId: number | null;
  infeedUomName: string | null;
  infeedUomCode: string | null;
  outputUomId: number | null;
  outputUomName: string | null;
  outputUomCode: string | null;

  teep: number | null;
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;

  // Infeed side.
  totalOut: number | null;
  reject: number | null;
  rework: number | null;
  // The line's own measured production at its infeed count point (migration
  // 0015). The detail screen labels this tile with the line's NAME.
  lineOut: number | null;
  // Output side.
  goodOut: number | null;
  effectiveOut: number | null;

  runtime: number;
  availabilityTime: number;
  productionTime: number;
  pdtTime: number;
  operatingTime: number;
  updtTime: number;
  netTime: number;
  reduceSpeedTime: number;
  msTime: number;
  valueAddedTime: number;
  reworkTime: number;
  rejectTime: number;
  anomalyTime: number;
  upSpeedTime: number;

  scheduleLossTime: number;
  availabilityLossTime: number;
  performanceLossTime: number;
  msLossTime: number;
  reduceSpeedLossTime: number;
  qualityLossTime: number;

  // NOT coalesced to 0 — the pipeline does not compute these yet, and a 0 would
  // claim a perfect repair time on every unwritten row.
  mttr: number | null;
  mtbf: number | null;
};

// THE LINE'S APPROVAL, WHICH IS A COUNT OF OTHER RECORDS.
//
// Not an approval row. There is none and there cannot be one: the approvals table
// is keyed (work_unit_id, date, shift) and work_center_shift_reports has no
// work_unit_id column (0014). "This line is approved" therefore means "every
// machine shift report on it, for this business date and shift, is closed", and
// the screen renders the fraction rather than a badge — the same treatment the
// machine DAY header already gives "2 of 3 shifts approved", and for the same
// reason: a badge would assert a signature nobody gave.
//
// `machinesFound` IS THE MACHINE REPORTS THAT EXIST, not the line's roster. The
// two differ whenever a machine is re-parented upstream, and the roster is the
// wrong denominator: it would claim a fraction over machines that never ran this
// shift. The caller additionally compares this against the line row's
// `work_unit_count` and abstains when they disagree — a count that cannot be
// supported is not a smaller truth, it is a wrong one.
type CascadeOutcome = {
  machinesFound: number;
  machinesClosed: number;
};

// Which machine reports a line's shift covers.
//
// The window is a HALF-OPEN [from, to) resolved in SQL through the plant's zone,
// never `from + 8 hours` — eight WALL-CLOCK hours across a DST transition is
// seven or nine real ones. See resolveShiftWindow.
type LineShiftKey = {
  // THE LINE'S OWN ID, NOT A LIST OF MACHINE IDS — and this replaced a roster
  // fetched from mes-master-data, which was there on a false premise.
  //
  // oee.work_unit_shift_reports.work_center_id HAS BEEN NOT NULL SINCE 0003. The
  // cascade originally resolved the line's machines through
  // findAllWorkUnitByWorkCenterId because a comment here claimed that column did
  // not exist; it does, and the pipeline owner has confirmed every work unit has a
  // work center whatever its process type (contract §16.10 Q6). The seed at
  // scripts/seed/0015_work_center_reports_dev.sql says so in as many words.
  //
  // Correcting it removes an HTTP call from FIVE paths — approve, reopen, the
  // approval summary, the activity feed and the stale-metrics banner — including a
  // FATAL one on a write path.
  //
  // AND IT IS A BETTER DEFINITION, not merely a cheaper one. The roster is the
  // line's CURRENT membership; `work_center_id` on a report row is the line the
  // pipeline attributed that machine's numbers to WHEN IT COMPUTED THEM. Approving
  // "this line's shift" means closing the reports that rolled into this line's
  // shift — which is the second thing, not the first. A machine re-parented since
  // the DAG ran would otherwise be approved on the wrong line's screen.
  workCenterId: number;
  from: Date;
  to: Date;
  shift: number;
};

type CascadeInput = LineShiftKey & {
  // From the verified token's `sub`, via requireActor. This is what lands in
  // closed_by, on an audit trail, where a wrong answer is worse than none.
  closedBy: string;
  closedByName: string | null;
};

// ---------------------------------------------------------------------------
// The activity feed, at line grain
// ---------------------------------------------------------------------------
//
// A SEPARATE DECLARATION FROM work-unit.ts's, NOT AN IMPORT. Modules never reach
// into each other's internals here, and the wire shape is the shared thing rather
// than the type — the browser renders both through one sheet. Where the two
// deliberately differ is documented on the fields below.
//
// WHAT A LINE'S FEED CAN HONESTLY SHOW, which is the interesting part.
// TODOS §52 said this arm would be "honestly empty at line grain", because the
// approvals table is keyed (work_unit_id, date, shift) and a line has no
// work_unit_id to report against. THAT IS NO LONGER TRUE: a line approval is N
// machine approvals, so its transitions are exactly the events the cascade wrote,
// and each one is labelled with the machine it belongs to.
//
// ALL THREE GRAINS NOW, AND THE DAY CASE WAS A PRODUCT QUESTION RATHER THAN A
// TECHNICAL ONE. TODOS §60 held it open and said so in as many words — a line day
// feed reports ~3N machine-shift transitions, "which may be a log rather than a
// feed". The answer is that it is a feed, on the precedent the other three
// subjects set: a MACHINE day feed already reports its three child shifts'
// transitions, and an AREA day feed spans three shifts AND N lines. What makes the
// density readable is the LABEL, not the count, which is why the two arms below
// grew a `shift` field rather than the endpoint growing a filter.
//
// Nothing about the ARMS changes by grain. The downtime arm was already expressed
// as an instant window and never read the shift; the quality arm reads the range
// variant `listActivityForTarget`, which the SKU day feed already proved; only the
// approval join had a `shift =` in it. That is why this is three handlers over the
// same three reads rather than a parallel implementation.
// THE INSTANT WINDOW THE FEED'S TWO EVENT ARMS READ, at any grain.
//
// `LineShiftKey` WIDENED IN EXACTLY ONE PLACE — `shift` — and a separate type
// rather than a nullable field on that one, because LineShiftKey addresses a
// CASCADE: approving a line means closing the machine reports of ONE shift, and
// a null there would mean "close every shift in the window", which is the
// authority TODOS §48 holds and nobody has granted. `LineShiftKey` is assignable
// to this, so the shift path passes its own key unchanged and the coarse paths
// pass a window with no shift.
//
// WHY THE EVENT ARMS TAKE INSTANTS WHILE THE QUALITY ARM TAKES DATES. An approval
// event is keyed on the shift report's start INSTANT and a downtime stop occupies
// a span of them, so both are scoped by [from, to). A quality entry is keyed
// (work_center_id, business_date, shift) by construction (0017) and has no instant
// to fall inside — so it reads through `LineWindow`'s business-date range instead.
// Two windows for one feed is not a defect; it is two kinds of record.
type LineActivityWindow = {
  workCenterId: number;
  from: Date;
  to: Date;
  // NULL AT DAY AND MONTH GRAIN, meaning "every shift the window covers". The one
  // predicate that changes across the three grains, and it changes in one query —
  // the approval arm's join. The downtime arm never read it.
  shift: number | null;
};

type LineActivityKind = "approval" | "downtime" | "quality";

type LineActivitySource = {
  kind: LineActivityKind;
  tracked: boolean;
  // The SAME wire vocabulary work-unit.ts's UntrackedReason uses — and
  // product-report.ts's, which is a THIRD declaration of the same list. The
  // browser keys a total map on it, so an invented value renders a blank sentence
  // rather than failing. Declared as a union here rather than `string` for that
  // reason.
  //
  // `not-applicable` is deliberately NOT admitted here even though the vocabulary
  // now carries it: a LINE shift report has real approvals, so no arm of this feed
  // can be inapplicable, and admitting the value would make an impossible state
  // representable.
  untrackedReason: "no-source" | "no-stable-id" | "not-implemented" | null;
  // How many things of this kind belong to the window this report covers, and how
  // many of them could ever carry a trail — the same two numbers, with the same
  // meaning, as work-unit's ActivitySource. At day and month grain the first
  // number grows with the window (a day's approval arm covers 3N machine shift
  // reports, not N), which is the point of reporting a count rather than a flag.
  totalMembers: number;
  trackedMembers: number;
};

type LineActivityEntry =
  | {
      kind: "approval";
      // PREFIXED, because the two arms come from tables with independent
      // bigserials and a bare id would collide in React's keying.
      id: string;
      at: Date;
      by: string | null;
      byName: string | null;
      fromStatus: string;
      toStatus: string;
      source: string;
      // WHICH MACHINE — and at shift grain that was the WHOLE answer, where the
      // machine feed carries which SHIFT instead. A line shift's transitions all
      // share one shift and span N machines, so an unlabelled entry would read as
      // an approval of the line itself, which is the one thing there is no such
      // thing as.
      workUnitId: number;
      workUnitName: string | null;
      // AND WHICH SHIFT, at the coarse grains, because a line DAY feed spans BOTH
      // axes at once — three shifts and N machines — and neither one alone
      // disambiguates a row. That is the area feed's problem one subject narrower,
      // and it is answered the same way: name both.
      //
      // NULL AT SHIFT GRAIN, where there is one shift and labelling every row with
      // it would be noise. Exactly the convention work-unit.ts's approval arm
      // carries for the same field, read from the other side.
      shift: number | null;
    }
  | {
      kind: "downtime";
      id: string;
      at: Date;
      by: string;
      sourceEventId: string;
      field: string;
      oldValue: unknown;
      newValue: unknown;
      workUnitId: number;
      workUnitName: string | null;
    }
  | {
      // An operator-entered reject or rework (migration 0017). The THIRD arm, and
      // the first one whose events this service creates rather than reports.
      kind: "quality";
      id: string;
      at: Date;
      by: string;
      byName: string | null;
      // 'reject' | 'rework'. Not narrowed to a union here for the reason the two
      // arms above leave `field` and `source` as strings: this is the wire, and a
      // value the browser does not know must render as itself rather than fail a
      // parse.
      entryKind: string;
      // BOTH QUANTITIES, as everywhere else this entry is shown: the operator
      // recognises what they typed, the report moves by what it converted to.
      enteredQty: number;
      enteredUomCode: string;
      targetQty: number;
      targetUomCode: string;
      productName: string | null;
      reasonName: string | null;
      // Provenance, and null on a rework. Labelled like the other two arms so the
      // feed reads consistently — but it does NOT mean the machine's own report
      // moved, which is the one thing a reader might infer.
      workUnitId: number | null;
      workUnitName: string | null;
      // WHICH SHIFT, on the same terms as the approval arm's — and this arm needs
      // it MORE, because `workUnitId` above is null on a rework. At day or month
      // grain a rework labelled only by its machine carries no label at all.
      // Null at shift grain.
      shift: number | null;
      // A VOID IS AN EVENT, not an absence. Present so the feed can show "500,
      // then that was wrong" rather than silently dropping the retraction.
      voidedAt: Date | null;
      voidedBy: string | null;
      voidedByName: string | null;
      voidReason: string | null;
    };

type LineActivity = {
  timeZone: string;
  entries: LineActivityEntry[];
  // Always length 3.
  sources: LineActivitySource[];
};

// ---------------------------------------------------------------------------
// Part 2's four sub-resources
// ---------------------------------------------------------------------------

// The window one line report covers, resolved once and shared by all four reads
// below so none of them can disagree about which rows belong to it.
//
// A HALF-OPEN BUSINESS-DATE RANGE plus an optional shift, not a report id, because
// the four source tables key on `(work_unit_id, shift_date[, shift])` or on
// `(work_center_id, business_date[, shift])` and none of them can be joined to a
// line report row directly. The three grains collapse into one shape:
//
//   shift   dateFrom = dateTo = the business day,  shift given
//   day     dateFrom = the day, dateTo = +1 day,   shift omitted
//   month   dateFrom = the 1st, dateTo = +1 month, shift omitted
// THE LINE'S WINDOW IS THE SHARED ONE, under this module's own name.
//
// Aliased rather than renamed at ~28 call sites: `LineWindow` is what the line
// module's vocabulary calls it, and the SKU module calls the same shape
// `ReportWindow`. One definition, so the two cannot drift; two names, so neither
// module reads as if it were the other. shared/report-window.ts holds the
// reasoning and the two predicates that go with it.
type LineWindow = ReportWindow;

// One hour of one SKU on one line, from oee.product_perf_wc_hour (0018).
//
// TWO UNITS, which is the whole difference from PerfHourBucket. The machine
// version carries ONE `uomCode` and says of it: "every measure on this row is in
// this unit … because a rate and its standard must share a unit or they cannot be
// compared". At line grain that is still true and there are TWO such pairs:
//
//   INFEED   totalOut                          -- what the line consumed
//   OUTPUT   effectiveOut, idealRatePerHour    -- what it shipped, and the target
//
// So `totalOut` and `effectiveOut` DO NOT SHARE A SCALE and must never be plotted
// against one axis — bags and cartons drawn together look entirely plausible.
// perf-hourly.ts's quantity domain is per unit for exactly this.
//
// The STANDARD IS OUTPUT-SIDE (contract §19.2), so performance is
// effectiveOut / ideal and the ratio is unit-consistent. `totalOut` is a CONTEXT
// series, never a numerator.
type LinePerfHourBucket = {
  bucketStart: Date;
  bucketEnd: Date;
  hourOfDay: number;
  shiftHourSeq: number;
  productId: number;
  productName: string;
  productCode: string;
  // Either may be null — 0014's rule, one table over: NULL means "the members
  // disagreed", not "unknown", and that side's measures are null with it.
  infeedUomCode: string | null;
  outputUomCode: string | null;
  // INFEED. Carried for the tooltip and for context, and deliberately NOT plotted
  // against the two below — see the note above.
  totalOut: number | null;
  // BOTH OUTPUT-SIDE, so they share a unit and a scale. These are what the chart
  // draws: `goodOut` is what came off the end, `effectiveOut` is that figure
  // adjusted to the standard, and the rates below are derived from them.
  goodOut: number | null;
  effectiveOut: number | null;
  runtime: number;
  // In outputUomCode per hour. Null means no standard was known, which is a real
  // and recurring state rather than a zero — rendering it as 0 would make the
  // target "make nothing", and substituting the actual rate would make the loss
  // vanish. The chart omits the series instead.
  idealRatePerHour: number | null;
};

type LineShiftPerformance = {
  timeZone: string;
  buckets: LinePerfHourBucket[];
  // The plant-local hour a business day starts — 7 today. Sent so the MONTH
  // profile's axis can be built in business-day order (07:00 first, 06:00 last)
  // without a copy of the shift table in the browser: an axis running 00..23
  // would split the night shift across both ends of the chart. Meaningless at
  // shift and day grain, where the axis is chronological, and sent anyway so the
  // payload has one shape.
  dayStartHour: number;
  // oee.etl_watermarks.last_business_date for product_perf_wc_hour. Null means
  // never loaded — which is the CURRENT state, because 0018 ships empty. This is
  // what lets the Trendline say "not loaded yet" rather than drawing a flat line
  // at zero on a line that ran all shift.
  loadedThrough: string | null;
};

// One machine's contribution to a line report — the Machine View card.
//
// EVERY FIGURE IS THAT MACHINE'S OWN, read from oee.work_unit_*_reports. Nothing
// here is derived from the line row, and nothing here sums to it: a line is
// measured at its own count points, so `line <> sum(machines)` (0014). The card
// exists to show which machine dragged the line down, not to decompose the line's
// total.
type LineMachineBreakdown = {
  // THE MACHINE REPORT'S OWN ID, and the reason this field exists at all: the
  // card's per-row arrow deep-links to that report. Interpolating the LINE's id
  // into a /report/machine/* route would compile and open an unrelated machine
  // report — six report tables, six independent identity sequences.
  reportId: number;
  workUnitId: number;
  workUnitName: string | null;
  workUnitCode: string | null;
  // The machine's single unit. Unlike the line row there is no infeed/output
  // split here — a work unit has one count point.
  uomName: string | null;
  totalOut: number;
  goodOut: number;
  reject: number;
  rework: number;
  scheduleLossTime: number;
  availabilityLossTime: number;
  performanceLossTime: number;
  msLossTime: number;
  reduceSpeedLossTime: number;
  qualityLossTime: number;
};

// GET /work-centers/{grain}-reports/:id/machines.
//
// THE WINDOW IS ON THE ENVELOPE, NOT ON EACH ROW, and that is the design rather
// than a saving. Every machine on a line runs the same shift, and at the coarse
// grains the period is the period — so the mock shows the same Start and End on
// every row, and putting the pair per row would let two of them differ, which
// would be a fact about nothing.
//
// It is resolved by `resolveReportWindow`, the one statement of that arithmetic
// (shared/shift-window.ts), so the card renders Start/End without a second copy of
// SHIFT_WINDOWS in the browser.
type LineMachineList = {
  timeZone: string;
  from: Date;
  to: Date;
  machines: LineMachineBreakdown[];
};

type ListWorkCenterReportInput = {
  // `CoarseGrain` too, since `0027`: the OEE Performance dashboard resolves a
  // report id from this list at YEAR grain. The projection is identical at all
  // four — `grainShift` selects a literal NULL wherever there is no shift column.
  grain: ReportGrain | CoarseGrain;
  limit: number;
  offset: number;
  filter: WorkCenterReportFilter;
};

type PagedWorkCenterReport = Paged<WorkCenterReportListRow>;

type PagedWorkCenterReportResult = PagedResult<WorkCenterReportListRow>;

export type {
  CascadeInput,
  LineMachineBreakdown,
  LineMachineList,
  LineWindow,
  LineActivity,
  LineActivityEntry,
  LineActivityKind,
  LineActivityWindow,
  LinePerfHourBucket,
  LineShiftPerformance,
  LineActivitySource,
  CascadeOutcome,
  LineShiftKey,
  ListWorkCenterReportInput,
  WorkCenterReport,
  PagedWorkCenterReport,
  PagedWorkCenterReportResult,
  CoarseGrain,
  ReportGrain,
  WorkCenterReportFilter,
  WorkCenterReportListRow,
};
