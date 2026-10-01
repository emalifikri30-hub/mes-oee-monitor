// Shapes mirrored from the BFF / core-api responses.

type Me = {
  sub: string;
  preferredUsername: string;
  email: string;
};

type PageMeta = {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
};

// core-api WebResponse envelope. Every core-api response is wrapped in this,
// so a new resource type only needs its own payload type, not its own envelope.
type WebResponse<T> = {
  data: T | null;
  meta?: PageMeta;
  error: string | null;
};

// master-data lookups, served by core-api rather than by mes-master-data directly.
// Both endpoints answer with a bare array — no `meta`.
type AreaSummary = {
  id: number;
  code: string;
  name: string;
};

type WorkCenterSummary = AreaSummary;

// One machine on a line, from mes-master-data via
// GET /master-data/work-units?workCenterId=. The OEE Performance dashboard's
// machine picker.
//
// A CATALOGUE, NOT A MEASUREMENT — the same distinction the product picker draws.
// The month-report list could have supplied these names, and was rejected: its
// contents change with the selected month, so a machine with no report for August
// could not be picked at all and the screen could never say so.
type WorkUnitSummary = AreaSummary;

// GET /{work-units,work-centers,areas}/month-reports/:id/oee-trend.
//
// One point per business day inside the month, ascending, already ordered by the
// server. `businessDate` is a bare YYYY-MM-DD and must never be parsed into a
// Date — see lib/format.ts's formatBusinessDate for what that costs.
type OeeTrendPoint = {
  businessDate: string;
  // ALL FOUR RATES, drawn on ONE chart — they are the factors OEE is the product
  // of, so "OEE fell on the 19th, which of them moved?" is the question the chart
  // exists to answer, and it is unanswerable one series at a time.
  //
  // NULL IS NOT ZERO. Not-null on the machine day table; nullable on the line and
  // area ones, where it means the day could not be composed. Zero means the
  // subject ran and produced nothing. buildOeeTrendSeries draws both as a gap,
  // because neither is a rate that can be plotted — but only one of them is a
  // measurement, and the wire keeps them apart.
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// An object rather than a bare array, for the reason ShiftProductCounts is one:
// an empty series cannot say WHY it is empty, and "this machine was idle all
// month" and "the day rows have not loaded" are opposite claims.
type MonthOeeTrend = {
  items: OeeTrendPoint[];
  timeZone: string;
  loadedThrough: string | null;
};

// One option in the downtime edit dialog's Reason picker, from mes-master-data's
// catalogue via GET /master-data/downtime-reasons?workCenterId=.
//
// SCOPED TO A LINE, which is the whole point of the endpoint: a stop already
// belongs to a known line, and offering the region's whole catalogue is how a
// filler stop gets labelled with a palletiser reason.
//
// `category` is the catalogue's own classification and is shown beside the option
// as a HINT. It deliberately does not drive the dialog's Category select: that
// one is the operator's judgement about THIS stop, and a reason's default is not
// always right for it.
//
// WHAT GETS STORED IS `name`, not `id` and not `code`. `downtime_reports.reason`
// is a jsonb array of plain strings that the pipeline also writes into, so there
// is no id to store — and element 0 is the label the Availability Pareto groups
// on, which means a code there would render as a code on every bar.
type DowntimeReasonOption = {
  id: number;
  code: string;
  name: string;
  category: DowntimeCategory;
};

// One option in the Actions picker.
//
// UNSCOPED, unlike a reason: `ms_downtime.downtime_actions` has no junction
// tables upstream, so the same catalogue is offered on every line.
//
// `color` is a `#rrggbb` string used to tint the chip. As with reasons, it is the
// `name` that gets stored on the downtime.
type DowntimeActionOption = {
  id: number;
  code: string;
  name: string;
  color: string;
};

// POST /master-data/downtime-actions body — the one master-data write this app
// makes, so an operator can add an action without leaving the dialog.
type CreateDowntimeActionInput = {
  code: string;
  name: string;
  color: string;
};

// A row of GET /work-units/shift-reports. `workUnit` (the machine), `workCenter`
// (the line) and `timeZone` are all null whenever master-data enrichment degrades —
// the endpoint still answers 200, so the table has to render without them.
type ShiftReportListItem = {
  id: number;
  // ISO-8601. The column is a Postgres `date`, so this is always UTC midnight —
  // format it with formatReportDate, never with the browser's local zone.
  // The instant the shift started, not a calendar day — see ShiftReportDetail.date.
  date: string;
  // Resolved per work unit; null when master-data could not be reached, in which
  // case the date is not renderable. Nullable for the same reason the two labels
  // below are: the list degrades rather than failing.
  timeZone: string | null;
  // `smallint` upstream, so this arrives as 1, not "1".
  shift: number;
  oee: number;
  availability: number;
  performance: number;
  quality: number;
  // Approval state for the row's badge. Never null: server-side the absence of an
  // approval row IS "open", and the service coalesces before the row leaves.
  status: ApprovalStatus;
  workUnit: { id: number; code: string; name: string } | null;
  workCenter: { id: number; code: string; name: string } | null;
};

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

type ApprovalStatus = "open" | "closed";
type ApprovalSource = "operator" | "system";

// The approval half of GET /work-units/shift-reports/:id, and the payload of
// POST .../approve.
//
// `status` is NEVER null — server-side the absence of a row means "open" and the
// query coalesces — which is why it is required on ShiftReportDetail rather than
// optional. An optional one would let the header render `status ?? "open"`, and
// that is a guess presented as a fact: an unapproved-looking badge on a report
// whose state is simply unknown.
type ShiftReportApproval = {
  status: ApprovalStatus;
  // All four are null while open, guaranteed by a CHECK constraint server-side.
  closedAt: string | null;
  // The Keycloak subject — durable, but not a name. Render `closedByName`.
  closedBy: string | null;
  closedByName: string | null;
  // `system` is reserved for the deferred 14-day auto-close and cannot occur yet.
  source: ApprovalSource | null;
};

// ---------------------------------------------------------------------------
// Activity — GET /work-units/shift-reports/:id/activity
// ---------------------------------------------------------------------------

type ActivityKind = "approval" | "downtime" | "quality";

// WHY a trail cannot exist, as an enum. The prose lives in lib/activity.ts so it
// can be reworded without a server deploy.
//
// `not-applicable` IS THE ODD ONE, and it earned its own value rather than reusing
// `no-source`. The first three all describe a trail that COULD exist and does not
// yet; this one says the EVENT does not exist at this grain and never will — the
// SKU day feed's approval arm, where
// oee.work_unit_shift_report_approval_events is keyed (work_unit_id, date, shift)
// and a SKU report has neither. `no-source`'s sentence is about reject and rework
// figures being the pipeline's, which under the word "Approvals" would be a
// visible mislabel.
//
// NOT_TRACKED_BODY in lib/activity.ts is a TOTAL map over this, so adding a value
// here is what forces its sentence to be written.
type UntrackedReason = "no-source" | "no-stable-id" | "not-implemented" | "not-applicable";

// One arm of the feed, and whether it is CAPABLE of carrying an entry.
//
// All three always arrive, including the one that never can. An arm omitted
// because it has nothing to say would render as a complete chronology with a
// whole class of change silently missing.
type ActivitySource = {
  kind: ActivityKind;
  tracked: boolean;
  untrackedReason: UntrackedReason | null;
  totalMembers: number;
  trackedMembers: number;
};

// Discriminated on `kind`: an approval is not a field change, and flattening the
// two would put `field: "status"` on screen, naming a column that does not exist.
type ActivityEntry =
  | {
      kind: "approval";
      // PREFIXED server-side — "approval:41" / "downtime:912" — because the two
      // arms come from tables with independent id sequences. Safe as a React key
      // exactly because of that prefix.
      id: string;
      at: string;
      // The Keycloak subject — a UUID. Durable, and NOT what to render.
      by: string | null;
      // preferred_username as it was at approval time. What a human reads.
      // Render through entryActor in lib/activity.ts, never either field alone.
      byName: string | null;
      fromStatus: ApprovalStatus;
      toStatus: ApprovalStatus;
      source: ApprovalSource;
      // WHICH shift report this transition belongs to. Null on a shift report's
      // own feed, where there is one and naming it is noise; a number on a day's
      // or a month's, where the feed spans three reports or ~90 and an
      // unattributed row reads as an approval of the period itself — the one
      // thing there is no such thing as.
      shift: number | null;
    }
  | {
      kind: "downtime";
      id: string;
      at: string;
      by: string;
      sourceEventId: string;
      field: string;
      // jsonb: a string, an array of them, or null. Always render through
      // renderValue in lib/activity.ts, or an array reaches the DOM as
      // "[object Object]".
      oldValue: unknown;
      newValue: unknown;
    }
  | {
      // AN OPERATOR-ENTERED REJECT AN OPERATOR ATTRIBUTED TO THIS MACHINE
      // (migration 0017), and THIS ARM WAS MISSING FROM THIS TYPE while the
      // server already sent it — the same drift LineActivityEntry's own quality
      // arm records about itself. It rendered anyway, because the panel's
      // `FeedEntry` is a union with the line's entry type and picked the member up
      // from there; what it did NOT do is reach `machineContext`, which is typed
      // against this union and could not see a field this union did not declare.
      //
      // WHY A MACHINE REPORT SHOWS THESE AT ALL, given the quantity lands on the
      // LINE: the operator picked this machine. Where the number lands is a
      // measurement question; what somebody recorded against a machine is an audit
      // question, and they have different right answers.
      //
      // REWORK NEVER APPEARS — structurally, not by a filter: a rework carries no
      // work_unit_id (the dialog does not ask), so a machine-scoped read cannot
      // return one.
      kind: "quality";
      id: string;
      at: string;
      by: string;
      byName: string | null;
      // 'reject' | 'rework'. A plain string on the wire, like `field` and `source`
      // above: a value the browser does not know must render as itself rather than
      // fail a parse.
      entryKind: string;
      // BOTH QUANTITIES. The operator recognises what they typed; the report moves
      // by what it converted to.
      enteredQty: number;
      enteredUomCode: string;
      targetQty: number;
      targetUomCode: string;
      productName: string | null;
      reasonName: string | null;
      // WHICH shift the operator recorded it in, on exactly the terms the approval
      // arm above carries the field: null on a shift report's own feed, a number on
      // a day's or a month's, where two 120 BAG rejects against one machine on
      // different shifts are otherwise one entry rendered twice.
      shift: number | null;
      // A VOID IS AN EVENT, shown on the same entry rather than as a second one.
      voidedAt: string | null;
      voidedBy: string | null;
      voidedByName: string | null;
      voidReason: string | null;
    };

type ShiftActivity = {
  timeZone: string;
  // Already merged and sorted newest-first by the server. Render in the order
  // received; a client-side re-sort would be a second opinion about a total
  // order the server already computed across two tables.
  entries: ActivityEntry[];
  // Always length 3.
  sources: ActivitySource[];
};

// GET /work-units/shift-reports/:id.
//
// core-api's type also declares workUnitCode / workCenterCode / uomCode, but its
// SELECT never asks for those columns, so they arrive `undefined`. Leaving them
// out here makes that unreachable rather than a trap.
//
// Percentages are numbers rounded to 3 decimals; `reject` and `rework` are
// counts in `uomName` units. Everything named *Time, plus `runtime`, is
// milliseconds — and the loss durations may be negative.
// The ~30 measures every report grain carries, extracted so a new one cannot be
// added to the shift payload and forgotten on the other two. Mirrors
// ReportMeasures in apps/api/src/module/work-unit/work-unit.ts.
//
// Percentages are numbers rounded to 3 decimals; `reject` and `rework` are
// counts in `uomName` units. Everything named *Time, plus `runtime`, is
// milliseconds — and the loss durations may be negative.
type ReportMeasures = {
  teep: number;
  oee: number;
  availability: number;
  performance: number;
  quality: number;
  totalOut: number;
  goodOut: number;
  effectiveOut: number;

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

  reject: number;
  rework: number;
};

type ShiftReportDetail = ReportMeasures & {
  // THE SUBJECT DISCRIMINANT, stamped client-side in lib/api.ts exactly as the
  // machine shift report's `grain` is, and for the same reason: that function is
  // the one place that knows for certain which endpoint answered.
  //
  // IT REPLACED A SHAPE CHECK, AND THE SHAPE CHECK WAS A LATENT BUG. Until
  // 2026-09-02 the subject was derived as `!("workUnitId" in report)` — true for a
  // line report because migration 0014 gives those tables no such column. That is
  // sound for TWO subjects and silently wrong for three: a SKU report has no
  // `workUnitId` either, so it read as a line, and every shared card would have
  // served LINE data on a SKU screen — type-checked, rendering, plausible.
  //
  // A tag cannot be accidentally satisfied by a missing column. Read it through
  // `reportSubject()` in lib/report-subject.ts, never by sniffing for a field.
  subject: "machine";
  // The union's discriminant. STAMPED CLIENT-SIDE in lib/api.ts, not sent by the
  // server: the shift endpoint predates the field and its response shape is a
  // shipped contract. See ReportDetail.
  grain: "shift";
  id: number;
  // The one field on this payload the pipeline does not own — this app writes it.
  // Nested rather than flattened for exactly that reason: the boundary is easier
  // to respect when it is visible.
  approval: ShiftReportApproval;
  // A number, not a string — the column is `smallint`. Anything that needs it as
  // a query param converts explicitly at the call site.
  shift: number;
  // ISO-8601 instant: the moment the shift STARTED, despite the field's name.
  // `timestamptz` upstream, so for a UTC+7 plant shifts 1/2/3 are 00:00Z / 08:00Z /
  // 16:00Z of the same business day. It is NOT a day at UTC midnight, and no
  // calendar reading of it is valid without `timeZone` below — use
  // formatReportDate or toBusinessDay, never a string slice.
  date: string;
  // IANA zone of the plant this machine sits in, resolved server-side per work
  // unit. Present on this response specifically so `date` is usable: the timeline
  // response also carries it, but working out which timeline to request needs the
  // business day first.
  timeZone: string;
  workUnitId: number;
  workUnitName: string | null;
  workCenterId: number;
  workCenterName: string | null;
  uomId: number;
  uomName: string | null;

  // Mean time to repair / between failures, both milliseconds. Shown in the
  // Downtime Details header — they come from the report, not from the downtime
  // records, so the card takes them as props rather than deriving them.
  mttr: number;
  mtbf: number;
};

// One hour-of-day bucket of a MONTH's performance profile, per product.
//
// A month holds ~720 hourly rows per product. No line chart draws that, so the
// month view answers a different question — "which hour of the day does this
// machine run worst" — by collapsing every occurrence of each clock hour into one
// point. 24 points, not 720.
//
// There is NO `bucketStart`, and that absence is the design: this bucket is not
// an instant, it is a clock hour that occurred ~30 times. Synthesising an instant
// would have to name a date, and on a DST month the same local hour occurs twice
// or not at all — collapsing or duplicating a point silently.
type HourProfileBucket = {
  // 0-23, plant-local. The join key for the chart's axis.
  hourOfDay: number;
  productId: number;
  productName: string;
  productCode: string;
  uomCode: string;
  totalOut: number;
  effectiveOut: number;
  // Milliseconds, summed across every occurrence of this hour.
  runtime: number;
  // RECOMPUTED server-side as the runtime-weighted mean of the standard, over the
  // runtime that actually carried one. Null when the month never knew a standard
  // for this product — never 0, which would make the target "make nothing".
  idealRatePerHour: number | null;
};

type HourOfDayProfile = {
  timeZone: string;
  // The plant-local hour a business day starts — 7 today. Sent by the server so
  // the axis can be built in BUSINESS-DAY order (07:00 first, 06:00 last) without
  // a copy of the shift table in the browser. An axis running 00..23 would split
  // the night shift across both ends of the chart.
  dayStartHour: number;
  buckets: HourProfileBucket[];
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// The coarser grains — By Day and By Monthly
// ---------------------------------------------------------------------------

// GET /work-units/{day,month}-reports/:id.
//
// The shift report's measures with a different identity, and each difference is
// a decision rather than an omission:
//
//   no `shift`      — the point of the grain.
//   no ShiftReportApproval — there is no day or month sign-off. `approval` here
//                     is a COUNT of the child shift reports, and the header
//                     renders it as "2 of 3 shifts approved" rather than as a
//                     badge, because a badge would assert a signature nobody
//                     gave. Null at month grain, where the tile is absent.
//   mttr/mtbf nullable — the columns exist (migration 0013) and the pipeline
//                     does not write them yet. NULL renders as an em dash; a 0
//                     would render as "00 s" and claim a perfect repair time.
//   businessDate    — 'YYYY-MM-DD'. THE FIELD TO USE for anything calendar. It
//                     is a real date from the server, not something to derive
//                     from `date` through a zone.
type PeriodReportDetail = ReportMeasures & {
  // See ShiftReportDetail.subject.
  subject: "machine";
  // Stamped by the API from the table it read.
  grain: "day" | "month";
  id: number;
  // ISO-8601 instant: 07:00 plant-local on the period's first business day.
  // Carried for completeness; nothing renders it — use businessDate.
  date: string;
  businessDate: string | null;
  timeZone: string | null;
  // The month table's own label. Its format is unspecified upstream, so nothing
  // renders it — the header formats from businessDate. Always null at day grain.
  month: string | null;
  workUnitId: number;
  workUnitName: string | null;
  workUnitCode: string | null;
  workCenterId: number | null;
  workCenterName: string | null;
  workCenterCode: string | null;
  uomId: number;
  uomName: string | null;
  uomCode: string | null;
  mttr: number | null;
  mtbf: number | null;
  approval: PeriodApprovalSummary | null;
};

// Not an approval. Two counts over the shift reports inside the period.
type PeriodApprovalSummary = {
  shiftsTotal: number;
  shiftsClosed: number;
};

// A row of GET /work-units/{day,month}-reports.
type PeriodReportListItem = {
  grain: "day" | "month";
  id: number;
  date: string;
  businessDate: string | null;
  month: string | null;
  timeZone: string | null;
  oee: number;
  availability: number;
  performance: number;
  quality: number;
  workUnit: { id: number; code: string; name: string } | null;
  workCenter: { id: number; code: string; name: string } | null;
};

// A row of GET /work-centers/{shift,day,month}-reports — the LINE grain.
//
// A DISCRIMINATED UNION ON `grain`, for the same reason ReportDetail is one: the
// Shift column exists only at shift grain, so a cell that reads `row.shift` has to
// narrow first and cannot render `undefined` on a month screen.
//
// THERE IS NO `workUnit`, NOT EVEN A NULLABLE ONE. These rows ARE lines. A
// nullable field would let a Machine column be pasted across from the machine
// table and render a column of em dashes that reads as degraded enrichment rather
// than as a mistake.
//
// There is no `status` either, at any grain, and that is still true after a line
// APPROVAL shipped. oee.work_unit_shift_report_approvals is keyed
// (work_unit_id, date, shift) and the work_center_* tables have no work_unit_id, so
// a line's status can only be DERIVED by counting its machine reports' approvals —
// one query per row on a list. The DETAIL screen does exactly that, once, for one
// report (LineApprovalSummary). A column here needs a set-based version first.
type LineReportListRow = {
  id: number;
  // Plant-local 'YYYY-MM-DD', already resolved server-side. These tables have no
  // `date timestamptz` column at all, so unlike ShiftReportListItem there is no
  // instant here and nothing to convert. NEVER pass this to formatReportDate.
  businessDate: string;
  timeZone: string;
  // FLAT, NOT A NESTED `workCenter` OBJECT — and the difference from
  // ShiftReportListItem / PeriodReportListItem above is the wire, not a style
  // choice. Those two are ENRICHED: core-api fetches the labels from
  // mes-master-data and nests them, which is why they are nullable there.
  //
  // These are COLUMNS on the Gold row (migration 0014), selected as
  // work_center_name / work_center_code and camelCased by postgres.js on the way
  // out, so the endpoint sends them flat and non-null:
  //
  //   { "workCenterId": 2, "workCenterName": "Line 1", "workCenterCode": "FI2-L1" }
  //
  // This shipped as a nested `workCenter` and every Line cell rendered an em dash,
  // because `row.workCenter?.name ?? EM_DASH` degrades silently rather than
  // failing. The component test could not catch it: its fixture was built from
  // THIS type, so both sides of the assertion shared the same wrong assumption.
  // The test that pins it now uses a response captured verbatim from the running
  // endpoint.
  workCenterId: number;
  workCenterName: string;
  workCenterCode: string | null;
  // Machines that REPORTED into this row, and the line's roster. `expectedCount`
  // is null when the pipeline could not resolve it, and the cell then renders a
  // bare count rather than a guess.
  workUnitCount: number;
  expectedWorkUnitCount: number | null;
  // NULLABLE, unlike the machine grains: 0/0 is real for a line whose machines
  // were all in planned downtime, and a fabricated 0% would be a measurement
  // where NULL is the truth. formatPercent renders null as an em dash.
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

type LineShiftReportListItem = LineReportListRow & { grain: "shift"; shift: number };
type LinePeriodReportListItem = LineReportListRow & { grain: "day" | "month"; shift: null };
type LineReportListItem = LineShiftReportListItem | LinePeriodReportListItem;

// The three Line report grains. Distinct from PeriodGrain, which covers the two
// COARSE machine grains — this one includes "shift" because a line report exists
// at all three.
// ─────────────────────────────────────────────────────────────────────────────
// The SKU grain — one SKU, on one line, on one business day
// ─────────────────────────────────────────────────────────────────────────────
//
// DAY ONLY. There is no SkuGrain union and no `grain` parameter on any of its
// fetchers, because oee.product_report_wc_day (0023) is the only table. `grain`
// is nevertheless ON the payload: the shared report components discriminate on
// it, and a report without one would need every one of them to special-case its
// absence.

// The list row. Four rates and the identity — a table renders nothing else.
type SkuReportListItem = {
  id: number;
  // Plant-local 'YYYY-MM-DD' straight off the Gold row. NO instant anywhere on
  // this grain, so never formatReportDate.
  businessDate: string;
  timeZone: string;
  workCenterId: number;
  workCenterName: string;
  // RENDERED BESIDE THE NAME, not instead of it. work_center_name is not unique —
  // the dev world carried two lines called 'Line 1' for months (TODOS.md §77) —
  // and a report whose whole point is WHICH LINE cannot identify one by a label
  // that repeats. Nullable, so the formatter falls back to the name alone rather
  // than rendering a trailing separator.
  workCenterCode: string | null;
  productId: number;
  productName: string;
  productCode: string;
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// The detail payload.
//
// NO `teep` AND NO `workUnitCount`, and both absences are migration 0023's. TEEP
// divides by CALENDAR time, which a SKU does not own — the line does, and shares
// it with every other SKU that ran that day. A SKU ran on one line, so there is no
// member count to report and no "4 of 5 machines" badge to derive.
//
// NO `approval` EITHER. oee.work_unit_shift_report_approvals is keyed
// (work_unit_id, date, shift) and this grain has neither, so there is nothing to
// sign and useReportApproved answers false for it.
// LineReportMeasures, NOT ReportMeasures, and the difference is nullability.
//
// The machine shape declares every rate as `number`. A SKU's are NULLABLE for the
// line's reason and one more: 0/0 is real for a SKU whose whole run sat in planned
// downtime, and 0023 declares the columns nullable so the browser renders an em
// dash rather than a fabricated 0%. Intersecting the machine shape here compiled
// and would have narrowed `oee` to `number`, which formatPercent would then never
// see a null through.
//
// `teep` comes with it and is the one field on that shape a SKU must not carry —
// it divides by CALENDAR time, which a SKU does not own. Omitted rather than left
// to arrive as undefined.
type SkuReportDetail = Omit<LineReportMeasures, "teep"> & {
  subject: "sku";
  // A constant, since there is one grain. It is here so the shared cards can
  // discriminate without asking which subject they are looking at first.
  grain: "day";
  id: number;
  businessDate: string;
  timeZone: string;
  workCenterId: number;
  workCenterName: string;
  workCenterCode: string | null;
  areaId: number | null;
  areaName: string | null;
  productId: number;
  productName: string;
  productCode: string;

  // TWO UNITS, and `totalOut = goodOut + reject + rework` is FALSE here by
  // construction — contract §16.4a, unchanged at this grain. Either may be null,
  // and its counts are null with it. NULL means "not known" here rather than
  // 0014's "the members disagreed": a SKU report has no members.
  infeedUomId: number | null;
  infeedUomName: string | null;
  infeedUomCode: string | null;
  outputUomId: number | null;
  outputUomName: string | null;
  outputUomCode: string | null;
};

// The Others tab's payload at SKU grain: the line's shape, plus the one number
// that says what it could NOT show.
type SkuDowntimeEventBreakdown = DowntimeEventReasonBreakdown & {
  // Stops on this line, in this window, with no SKU attributed — excluded from
  // every bucket above by construction, because `product_id = $` is false for
  // NULL. Zero once the pipeline writes the column; until then it is every stop,
  // and without it "this SKU never stopped" and "nothing is attributed yet" are
  // the same empty screen.
  unattributed: number;
};

// ---------------------------------------------------------------------------
// The SKU day report's Log Activity feed
// ---------------------------------------------------------------------------
//
// A NARROWING OF THE LINE'S ENTRY UNION, not a new shape — which is what lets
// activity-log-view.tsx serve a third subject with NO CODE CHANGE AT ALL. That is
// the payoff of it having been written to take data rather than a report.
//
// TWO KINDS, AND THE MISSING THIRD IS THE POINT: a SKU report has no approval
// EVENTS, because oee.work_unit_shift_report_approval_events is keyed
// (work_unit_id, date, shift) and this grain has neither. `Extract` says so in a
// way the compiler enforces at every render site, where a comment would not.
type SkuActivityEntry =
  | Extract<LineActivityEntry, { kind: "downtime" }>
  // `shift` NARROWED FROM `number | null` TO `number`, which is a smaller claim
  // than it was: the line's feed now carries the field too, sending null on a
  // shift report's own feed and a number at day and month grain (§60). A SKU
  // report is ALWAYS a day, so the value is never null here — and the narrowing is
  // what lets `skuContext` interpolate it without re-testing.
  //
  // It matters most on a REWORK, which carries no work_unit_id at all: with no
  // shift there would be nothing to disambiguate three otherwise identical rows.
  // The intersection keeps this assignable to the panel's FeedEntry union, so
  // activity-log-view.tsx still needs no change.
  | (Extract<LineActivityEntry, { kind: "quality" }> & { shift: number });

// `sources` STILL HAS THREE, and the asymmetry with the union above is deliberate.
// The panel's whole purpose is to separate "nothing was recorded" from "nothing
// COULD be recorded", so the approval arm still has to SAY so — it just says it as
// a SOURCE (`not-applicable`) and never as an entry. A reader who knows the other
// six report screens carry approvals is answered rather than left guessing.
type SkuActivity = {
  timeZone: string;
  entries: SkuActivityEntry[];
  // Always length 3 — see above. Two live arms and one named absence.
  sources: ActivitySource[];
  // The residual, riding with the feed exactly as it rides with the Others tab
  // (SkuDowntimeEventBreakdown above) and for the same reason: the downtime arm is
  // narrowed by product, so with 0020's column unwritten an empty panel means
  // either "nobody edited anything" or "no stop on this line belongs to any SKU".
  unattributed: number;
};

// The reject dialog's Machine picker.
//
// A ROSTER, AND DELIBERATELY NOT LineMachineList. That type carries a `reportId`
// per row — a MACHINE report's id — which has no business in a form; leaving it
// out is what stops a future caller interpolating it into a route. This list
// answers "which machines reported into this line on this day", which is what the
// entry's provenance field is asking.
type SkuMachineRoster = {
  machines: { workUnitId: number; workUnitName: string | null }[];
};

// ─────────────────────────────────────────────────────────────────────────────
// The AREA grain — one area, on one business day
// ─────────────────────────────────────────────────────────────────────────────
//
// TWO GRAINS AND NO MORE. The requirement is explicit — "only have 2 type of
// report on the Area: daily and monthly" — so `AreaGrain` is a two-member union
// rather than a reuse of `LineGrain`, and a shift cannot be named on this subject
// at all.
//
// THE MONTH IS A SECOND TABLE, NOT THE DAY TABLE WIDENED, and that is worth
// knowing here because it explains why the two grains cost two cache keys and two
// endpoints rather than one with a range. §15.5's rule is that durations and counts
// SUM while rates are RECOMPUTED: widening a day range gives the first for free and
// the second not at all, so a browser that derived a month's OEE would hold a
// SECOND definition of it, one click from the day screens it drills into.
// Migration 0025's header argues it.
//
// WHAT DIFFERS ON THE WIRE BETWEEN THE TWO: nothing. The two Gold tables differ by
// one CONSTRAINT (`ck_amr_month_start`) and by no column, so one payload type
// serves both and `grain` is the only thing that says which answered.
//
// ---------------------------------------------------------------------------
// A LINE IS MEASURED. AN AREA IS COMPOSED. READ THIS BEFORE ANY AREA CARD.
// ---------------------------------------------------------------------------
//
// Migration 0024's header is the long version. Three consequences reach these
// types, and every one of them inverts something a reader has learnt from the
// LINE grain:
//
//   1. EVERY DURATION IS IN LINE-HOURS. `runtime` on a five-line area's day is
//      ~120 hours, not ~24, and the Run Time tile is expected to say so. 0014 is
//      explicit that a LINE's durations are its own wall clock — "8 hours over a
//      4-machine shift, not 32" — because a line has a clock. An area does not.
//      Nothing in the browser may divide by a line count to "fix" this.
//   2. EVERY COUNT IS A MASS, in ONE unit, where a line has two. An area's member
//      lines disagree about both sides — one ships cartons, another sacks — so
//      mass is the only unit they can all be expressed in. That is why the tiles
//      carry `weightUomName` and there is no infeed/output split on this payload.
//   3. `totalOut = goodOut + reject + rework` IS STILL NOT AN IDENTITY. At line
//      grain it is FALSE by unit (contract §16.4a). Here the units agree, so the
//      sum is well-formed and still not asserted: the figures come from different
//      count points on N lines, and mass is neither conserved through a packing
//      line nor measured at a single point. No card may add across them.

// A row of GET /areas/day-reports.
//
// Four rates and the identity — a table renders nothing else. FLAT and non-null
// where they can be, straight off the Gold row (0024), not the nested-and-nullable
// shape the ENRICHED machine payloads use: that distinction is the one commit
// 0ed9c20 was about, and this grain is on the flat side of it.
type AreaGrain = "day" | "month";

type AreaReportListItem = {
  id: number;
  // WHICH TABLE ANSWERED, stamped by the server from the one it read. The Date
  // column reads it: a day row renders a business DATE and a month row a MONTH
  // LABEL, and passing a month start through `formatBusinessDate` would print
  // "01/09/2026" under a heading that says Month.
  grain: AreaGrain;
  // Plant-local 'YYYY-MM-DD' straight off the Gold row. NO instant anywhere on
  // this grain, so NEVER formatReportDate — it reads '2026-09-01' as UTC midnight
  // and lands on 31 August for any plant west of Greenwich.
  businessDate: string;
  timeZone: string;
  areaId: number;
  areaName: string;
  // RENDERED BESIDE THE NAME, not instead of it. A denormalised name is not unique
  // — the dev world carried two lines called 'Line 1' for months (TODOS.md §77) —
  // and a report whose subject IS the area cannot identify one by a label that can
  // repeat. Nullable, so the formatter falls back to the name alone rather than
  // rendering a trailing separator.
  areaCode: string | null;
  // NULLABLE, like the line grain's and for the same reason: 0/0 is real for an
  // area whose every line sat in planned downtime, and a fabricated 0% would be a
  // measurement where NULL is the truth. formatPercent renders null as an em dash.
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// GET /areas/day-reports/:id — the AREA detail payload.
//
// `Omit<LineReportMeasures, ...>` RATHER THAN A RESTATEMENT, and the omissions are
// the interesting part. What it keeps is the nullability (every rate and count can
// be null) and the twenty durations. What it drops:
//
//   teep          divides by CALENDAR time, and an area owns no calendar a reader
//                 could name — is it 24 hours, or 24 times the line count?
//                 Consequence 1 makes the second of every other duration here.
//   effectiveOut  the requirement's Area Overview names OEE, A, P, Q, Achievement,
//                 {Area} Production, Total Production, Finish Good and Runtime,
//                 and stops. Migration 0024 has no column, so this is an absence
//                 rather than a field that arrives null forever.
//   lineOut       renamed. The area's equivalent is `areaOut`, and calling it
//                 `lineOut` on an area payload would be the kind of paste that
//                 compiles and mislabels a tile.
//
// NO `approval` AND NO `workUnitCount`. An area report is not approvable —
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift), and
// there is no cascade defined at this grain — and the requirement names no member
// count, so 0024 has no column for one.
type AreaReportDetail = Omit<LineReportMeasures, "teep" | "effectiveOut" | "lineOut"> & {
  // See ShiftReportDetail.subject. Stamped in lib/api.ts, the one place that knows
  // which endpoint answered.
  subject: "area";
  // WHICH OF THE TWO TABLES ANSWERED. Sent by the server rather than stamped in
  // lib/api.ts — unlike `subject`, which no endpoint can know — and read by the
  // header, the Losses link and every route literal that names a grain.
  grain: AreaGrain;
  id: number;
  // AT MONTH GRAIN THIS IS THE FIRST BUSINESS DAY OF THE MONTH, guaranteed by
  // `ck_amr_month_start` (0025). Still a business DATE and still never an instant;
  // what changes is which formatter reads it — `formatMonthLabel` rather than
  // `formatBusinessDate`.
  businessDate: string;
  timeZone: string;
  areaId: number;
  areaName: string;
  areaCode: string | null;
  // The level above. Nothing renders it yet — it is on the Gold row so the factory
  // report is a read rather than a hierarchy lookup.
  //
  // CALLED `site`, NOT `factory`, SINCE MIGRATION `0028`. mes-master-data's
  // hierarchy is enterprise → site → area → work center → work unit and has no
  // `factory` at all, so the old name pointed at a level nothing upstream could
  // be joined on.
  siteId: number | null;
  siteName: string | null;
  enterpriseId: number | null;
  enterpriseName: string | null;

  // THE ONE UNIT, AND IT IS A MASS. NULL means "the members could not be brought
  // to a common mass" — typically a product with no std_weight in master data —
  // which is a THIRD meaning for a null unit in this app, neither the line's "the
  // members disagreed" nor the SKU's "not known". The five counts are null with
  // it, and formatQuantity renders both as an em dash.
  weightUomId: number | null;
  weightUomName: string | null;
  weightUomCode: string | null;

  // The area's own measured production — the member lines' `lineOut` brought to a
  // common mass and summed. The overview card labels this tile with the AREA's
  // name, exactly as the line card labels `lineOut` with the line's. Distinct from
  // `totalOut`, which is what those lines CONSUMED.
  areaOut: number | null;
};

// GET /areas/day-reports/:id/products — SKU View at area grain.
//
// The SAME ENVELOPE as the machine and line versions, so sku-view-card.tsx renders
// all three through one component and `skuTiles` needs no change.
//
// A ROLL-UP, AND THE ONE PLACE IN THIS APP WHERE THAT IS RIGHT. Contract §17.1
// spends a section forbidding it one grain down: a per-SKU view rolled up from
// MACHINES would print figures that visibly disagree with the LINE card above
// them, and the disagreement would be correct. Neither half holds here — summing a
// SKU's counts across lines WITHIN ONE UNIT is exact addition, and the card above
// is denominated in MASS, so there is no shared figure for the two to disagree
// about.
type AreaProductCounts = ShiftProductCounts;

// GET /areas/{day,month}-reports/:id/production-units — the Input/Output KPI.
//
// The requirement asks two things about an area's production that pull in opposite
// directions: one headline figure ("{Area} Production, Total Production and Finish
// Good use Weight Unit") and a breakdown across every unit its lines actually
// count in ("infeed: bag/shot/etc; output: carton/bag/sack — user want to know sum
// of total production in all infeed unit and sum of total output in all unit").
//
// The mass columns on the report row answer the first. This answers the second.
//
// THE DAY-GRAIN LINE REPORTS ANSWER BOTH AREA GRAINS, widened over the window —
// which is safe here and unsafe for the report tables for one reason: this sums
// COUNTS, and a count sums. At month grain that means ~30 line-days per line, and
// the unit resolution is FINER than reading the line MONTH rows would give: a line
// whose unit changed mid-month has a NULL unit on its month row and would land in
// the residual, where its day rows give two honest buckets.
//
// TWO INDEPENDENT LISTS, NOT ONE PIVOT WITH A `side` FIELD. A line row carries an
// infeed unit AND an output unit in two separate column groups, so "group by unit"
// is two questions over the same rows — and a single list with a discriminator
// would invite a reader (or a card) to total it, which is the one arithmetic 0014
// forbids. Keeping them apart on the wire is what keeps them apart on screen.
type AreaInfeedBucket = {
  uomId: number;
  uomName: string | null;
  uomCode: string | null;
  // How many of the area's lines counted in this unit. Not decoration: it is what
  // tells a reader whether a bucket is one line's whole output or a genuine sum.
  workCenterCount: number;
  totalOut: number;
  // Each line's own measured production at its infeed count point (0015), summed.
  lineOut: number;
  reject: number;
  rework: number;
};

type AreaOutputBucket = {
  uomId: number;
  uomName: string | null;
  uomCode: string | null;
  workCenterCount: number;
  goodOut: number;
  effectiveOut: number;
};

type AreaProductionUnits = {
  timeZone: string;
  infeed: AreaInfeedBucket[];
  output: AreaOutputBucket[];
  // Lines in this window with no infeed / output unit resolved. Their counts are
  // NULL by 0014's CHECK, so they contribute to NO bucket and are silently absent
  // — without these two numbers, "this area's lines all count in BAG" and "half
  // this area has no unit yet" are the same screen. PER SIDE, because 0014's guards
  // are per side: a line can be certain what it consumed and abstain about what it
  // shipped. Zero is the healthy state and the card says nothing when both are.
  infeedUnresolved: number;
  outputUnresolved: number;
  // The watermark for work_center_day_reports — the table these buckets are summed
  // from, NOT area_day_reports. Two different loads.
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// The area day report's Log Activity feed
// ---------------------------------------------------------------------------
//
// A NARROWING OF THE LINE'S ENTRY UNION with two fields added, which is what lets
// activity-log-view.tsx serve a FOURTH subject with no code change at all. That is
// the payoff of it having been written to take data rather than a report.
//
// TWO KINDS, AND THE MISSING THIRD IS THE POINT: an area report has no approval
// EVENTS, because oee.work_unit_shift_report_approval_events is keyed
// (work_unit_id, date, shift) and an area day has neither. `Extract` says so in a
// way the compiler enforces at every render site, where a comment would not.
//
// THE ARGUMENT IS STRONGER THAN THE SKU GRAIN'S, AND DIFFERENT. A SKU day simply
// has nothing to count. An area day DOES have child records it could report —
// a machine DAY feed reports its three child shift reports' transitions, so
// "a coarse grain can still show approvals" is demonstrably true one subject over.
// The answer is that an AREA REPORT IS NOT APPROVABLE: there is nothing to sign at
// this grain, so the transitions that exist belong to the machine and line screens
// that can act on them.
type AreaActivityEntry =
  | (Extract<LineActivityEntry, { kind: "downtime" }> & {
      // PLUS THE LINE. An area day feed spans three shifts AND N lines, so the
      // machine alone leaves "the filler on Line 1" and "the filler on Line 2"
      // reading as one entry — a name several lines have.
      workCenterId: number | null;
      workCenterName: string | null;
    })
  | (Extract<LineActivityEntry, { kind: "quality" }> & {
      // PLUS THE LINE, and the SHIFT narrowed to non-null. The line's own feed
      // carries a shift now — null on a shift report's feed, a number at day and
      // month grain (§60) — but an area report is always at least a day, so the
      // value is never null here.
      //
      // THE LINE IS WHAT NO OTHER SUBJECT NEEDS. An area day spans three shifts AND
      // N lines, and a REWORK carries no work_unit_id at all — so neither axis
      // alone disambiguates and both ship.
      shift: number;
      workCenterId: number;
    });

type AreaActivity = {
  timeZone: string;
  entries: AreaActivityEntry[];
  // Always length 3 — two live arms and one named absence.
  sources: ActivitySource[];
  // NO `unattributed`, unlike the SKU feed's, and the difference is the AXIS. A SKU
  // read narrows by `product_id`, which is OCCUPANCY OVER TIME: NULL means "not
  // attributed" and nothing can derive the answer, so the residual has to travel.
  // An area read narrows by `area_id`, which is CONTAINMENT — the area IS derivable
  // from the work unit — so a NULL there is a missing LABEL and the fix is a
  // backfill upstream. A residual here would invite a reader to treat
  // denormalisation lag as an attribution problem.
};

type LineGrain = "shift" | "day" | "month";

// GET /work-centers/{shift,day,month}-reports/:id — the LINE detail payload.
//
// WRITTEN FROM A RESPONSE CAPTURED OFF THE RUNNING ENDPOINT, not from the
// migration. That is the remedy commit 0ed9c20 established after the Line LIST
// type shipped saying `workCenter: { name }` where the endpoint sends flat
// `workCenterName` — every Line cell rendered an em dash, and the component test
// could not catch it because its fixture was built from the same wrong type.
// test/fixtures.ts holds that capture; keep the two in step.
//
// TWO UOM TRIPLES, SEPARATELY NAMED, AND NEVER A SINGLE `uomName`.
// A machine has one count point; a line has two, and they are usually different
// (migration 0014, contract §16.4a):
//
//     totalOut, lineOut, reject, rework  ->  infeedUom*    (bags in)
//     goodOut, effectiveOut              ->  outputUom*    (cartons out)
//
// `totalOut = goodOut + reject + rework` IS FALSE HERE BY CONSTRUCTION. 100 bags
// in yielding 10 cartons out is not a 90% loss, and nothing may compute across
// the two groups. Collapsing the triples into one `uomName` is what a paste from
// ShiftReportDetail produces, and it renders cartons under a bag label — a wrong
// number that looks completely ordinary. Keeping them apart makes that a type
// error instead of a judgement call.
//
// NO `approval` FIELD. A line's approval summary is its own endpoint, because
// computing it needs the line's roster from mes-master-data and that call is not
// cached — folding it in would put an uncached upstream request on the path the
// route loader AWAITS. Same reasoning as metrics-staleness on the machine screen.
//
// EVERY RATE AND EVERY COUNT IS NULLABLE, unlike the machine grains. 0/0 is real
// for a line whose machines were all in planned downtime, and a NULL count means
// "the members disagreed" — formatPercent and formatQuantity render both as an
// em dash. A 0 would be a measurement.
type LineReportMeasures = {
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
  // 0015). The overview card labels this tile with the LINE'S NAME.
  lineOut: number | null;
  // Output side.
  goodOut: number | null;
  effectiveOut: number | null;

  // Milliseconds, all of them. The loss durations may be negative.
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

  mttr: number | null;
  mtbf: number | null;
};

type LineReportRow = LineReportMeasures & {
  // See ShiftReportDetail.subject.
  subject: "line";
  id: number;
  // Plant-local 'YYYY-MM-DD', already resolved server-side. These tables have no
  // `date timestamptz` column at all (0014), so there is no instant here and
  // NOTHING to convert. NEVER pass this to formatReportDate.
  businessDate: string;
  timeZone: string;
  // FLAT, non-null, straight off the Gold row — not the nested, nullable shape
  // the enriched machine payloads use. This is the distinction 0ed9c20 was about.
  workCenterId: number;
  workCenterName: string;
  workCenterCode: string | null;
  areaId: number | null;
  areaName: string | null;
  // Machines that REPORTED into this row, and the line's roster. The Status tile
  // compares the first against how many machine reports the approval endpoint
  // actually found, and abstains when they disagree.
  workUnitCount: number;
  expectedWorkUnitCount: number | null;

  infeedUomId: number | null;
  infeedUomName: string | null;
  infeedUomCode: string | null;
  outputUomId: number | null;
  outputUomName: string | null;
  outputUomCode: string | null;
};

// A DISCRIMINATED UNION ON `grain`, for the reason ReportDetail is one: the Shift
// tile exists only at shift grain, so a header that reads `report.shift` has to
// narrow first and cannot render `undefined` on a month screen. Unlike the machine
// union, `grain` is sent by the server at every grain — these three endpoints all
// postdate the field.
type LineShiftReportDetail = LineReportRow & { grain: "shift"; shift: number };
type LinePeriodReportDetail = LineReportRow & { grain: "day" | "month"; shift: null };
type LineReportDetail = LineShiftReportDetail | LinePeriodReportDetail;

// GET /work-centers/shift-reports/:id/approval — the Status tile.
//
// NOT AN APPROVAL. Three counts over the line's machine shift reports, because
// there is no line approval row and cannot be one — oee.work_unit_shift_report_approvals
// is keyed (work_unit_id, date, shift) and the work_center_* tables have no
// work_unit_id column.
//
// `machinesFound` is the machine shift reports that NAME THIS LINE for this
// business date and shift; `workUnitCount` is what the pipeline wrote on the line
// row as having reported into it. Both are the pipeline's own figures, so a
// disagreement is it disagreeing with itself — and BOTH travel so the tile can
// abstain rather than render a fraction over the wrong denominator.
type LineApprovalSummary = {
  machinesFound: number;
  machinesClosed: number;
  workUnitCount: number;
};

// One entry in a line's Log Activity feed.
//
// The machine feed labels an approval with its SHIFT; this one labels it with its
// MACHINE. A line shift's transitions all share one shift and span N machines, so
// an unlabelled entry would read as an approval of the line itself — which is the
// one thing there is no such thing as.
type LineActivityEntry =
  | {
      kind: "approval";
      id: string;
      at: string;
      by: string | null;
      byName: string | null;
      fromStatus: ApprovalStatus;
      toStatus: ApprovalStatus;
      source: string;
      workUnitId: number;
      workUnitName: string | null;
      // AND WHICH SHIFT, at day and month grain, because a line DAY feed spans
      // BOTH axes at once — three shifts and N machines — and neither alone
      // disambiguates a row. Null on a line shift report's own feed, where there is
      // one shift and labelling every row with it is noise.
      shift: number | null;
    }
  | {
      kind: "downtime";
      id: string;
      at: string;
      by: string;
      sourceEventId: string;
      field: string;
      oldValue: unknown;
      newValue: unknown;
      workUnitId: number;
      workUnitName: string | null;
    }
  | {
      // An operator-entered reject or rework (migration 0017) — the third arm,
      // and the first whose events this service CREATES rather than reports.
      //
      // IT WAS MISSING HERE while the server already sent it, so the renderer's
      // "approval, else downtime" branch caught it and drew "Downtime ·
      // undefined … — → —". The type is what makes the third arm mandatory
      // rather than optional.
      kind: "quality";
      id: string;
      at: string;
      by: string;
      byName: string | null;
      // 'reject' | 'rework'. A plain string on the wire, like `field` and
      // `source` above: a value the browser does not know must render as itself
      // rather than fail a parse.
      entryKind: string;
      // BOTH QUANTITIES. The operator recognises what they typed; the report
      // moves by what it converted to.
      enteredQty: number;
      enteredUomCode: string;
      targetQty: number;
      targetUomCode: string;
      productName: string | null;
      reasonName: string | null;
      // Provenance, and NULL on a rework. It does not mean the machine's own
      // report moved — a line is measured at its own count points.
      workUnitId: number | null;
      workUnitName: string | null;
      // WHICH SHIFT, on the same terms as the approval arm's — and this arm needs
      // it MORE, because `workUnitId` above is null on a rework, so at day grain a
      // rework labelled only by its machine carries no label at all.
      shift: number | null;
      // A VOID IS AN EVENT, shown on the same entry rather than as a second one.
      voidedAt: string | null;
      voidedBy: string | null;
      voidedByName: string | null;
      voidReason: string | null;
    };

// The SAME shape as ActivitySource, and deliberately the same wire vocabulary for
// `untrackedReason` — the panel keys a TOTAL map on it (lib/activity.ts), so a
// value the server invented renders a blank sentence rather than failing.
type LineActivitySource = ActivitySource;

type LineActivity = {
  timeZone: string;
  entries: LineActivityEntry[];
  // Always length 3.
  sources: LineActivitySource[];
};

// WHAT EVERY REPORT CARD TAKES.
//
// A discriminated union rather than a base type with optional fields, so a card
// that reads `report.shift` has to narrow first and cannot silently render
// `undefined` on a month screen. `grain` is the discriminant; the shift arm is
// stamped client-side in lib/api.ts, because the shift endpoint predates the
// field and its response shape is a shipped contract.
type ReportDetail = ShiftReportDetail | PeriodReportDetail;

// ─────────────────────────────────────────────────────────────────────────────
// THE YEAR GRAIN — three detail payloads, and they stay OUT of `AnyReport`
// ─────────────────────────────────────────────────────────────────────────────
//
// Migration `0027` gives each subject a year table whose measure set is its month
// sibling's, column for column — which is why each of these is that type with its
// `grain` narrowed rather than a new list of forty fields.
//
// WHY THEY ARE NOT ADMITTED TO `AnyReport`, WHICH IS THE DECISION HERE.
// `AnyReport` is the union every exhaustive `switch (report.grain)` on the REPORT
// surface sees — `losses-tabs.tsx`, `report-actions.tsx`, `performance-dialog.tsx`,
// `ReportAddress`, `useReportApproved`, `LossesDetailTo`, the four activity
// dispatchers. A year arm would force every one of them to answer for a screen that
// will never exist: there is no year Losses page, no year approval, no year
// activity feed, and the API registers no route for any of them.
//
// So the composers that genuinely serve a year take `WindowedReport` and nothing
// else moves. Widening a FUNCTION'S PARAMETER is safe; widening the union it
// belongs to is a twelve-site change for zero screens.
//
// `date` AND `month` ARE NULL ON THE MACHINE ARM because the table has no such
// columns — `0027` followed `0014` in dropping them from a table with no upstream
// legacy, and the API sends literal NULLs rather than fabricating an instant.
type MachineYearReportDetail = Omit<PeriodReportDetail, "grain" | "date" | "month"> & {
  grain: "year";
  date: null;
  month: null;
};

type LineYearReportDetail = Omit<LinePeriodReportDetail, "grain"> & { grain: "year" };

// No `teep` here either — it is already absent from `AreaReportDetail`, because
// migration `0024` gives an area no such column and `0027` did not add one: TEEP
// divides by a calendar an area does not own.
type AreaYearReportDetail = Omit<AreaReportDetail, "grain"> & { grain: "year" };

type YearReportDetail = MachineYearReportDetail | LineYearReportDetail | AreaYearReportDetail;

// A YEAR LIST ROW, per subject. Same narrowing, same reason.
type MachineYearReportListItem = Omit<PeriodReportListItem, "grain" | "date" | "month"> & {
  grain: "year";
  date: null;
  month: null;
};
type LineYearReportListItem = Omit<LinePeriodReportListItem, "grain"> & { grain: "year" };
type AreaYearReportListItem = Omit<AreaReportListItem, "grain"> & { grain: "year" };

// A row of GET /work-units/shift-reports/:id/products — one product the machine
// ran during the shift, from oee.product_count_wu_shift.
//
// Every measure arrives already scaled: core-api applies `factor_to_base` in SQL,
// so nothing here multiplies anything. Which unit each figure is in differs by
// design, and it is not uniform:
//
//   totalOut, reject, rework  ->  baseUomCode   (converted to the base unit)
//   goodOut                   ->  uomCode       (as counted, in the production unit)
//
// So when factor_to_base <> 1 these figures are NOT additive on screen —
// totalOut <> goodOut + reject. The card's tooltip states that to the reader; the
// pairing itself lives in lib/product-count.ts, which is where it is tested.
type ProductCountItem = {
  productId: number;
  productName: string;
  productCode: string;
  totalOut: number;
  goodOut: number;
  reject: number;
  rework: number;
  uomCode: string;
  baseUomCode: string;
};

// A row of GET /downtimes. These are the RAW records, not the merged segments
// the timeline draws: two overlapping stops are two rows here and one band there.
type DowntimeListItem = {
  id: number;
  // The stop's PUBLIC identity — what a drill-down link and a history lookup key
  // on. Null on every stop the pipeline loaded, because it does not write it yet.
  //
  // Deliberately NOT `id`: the Gold write contract mandates DELETE-then-INSERT
  // until the upsert key lands, so `id` changes on every pipeline run and a link
  // built from it would silently come to mean a different stop.
  sourceEventId: string | null;
  // jsonb[] of plain strings, normalised server-side — never null, possibly empty.
  // A record can carry several reasons, which is why the cell collapses.
  reason: string[];
  actions: string[];
  category: TimelineSegmentKind;
  workUnitName: string | null;
  // The rest of the hierarchy, so the detail drawer can name area / line /
  // machine from a row it already holds rather than fetching again. `areaName`
  // is null until the pipeline writes it.
  workCenterName: string | null;
  areaName: string | null;
  // THE LINE'S ID, AND IT IS NOT FOR DISPLAY — it scopes the edit dialog's Reason
  // catalogue, which core-api refuses to serve unscoped.
  //
  // ADDED FOR THE AREA REPORT, which is why it is on the ROW rather than only on
  // the report. Every other subject's report knows its own single line; an AREA
  // report spans N of them, so the only thing that knows which catalogue applies
  // to a given stop is the stop. Nullable, matching the column.
  workCenterId: number | null;
  // Operator free text, and who logged / attended to the stop. All null until
  // the pipeline writes them; the UI renders an em dash.
  detailReason: string | null;
  inputBy: string | null;
  maintainedBy: string | null;
  startAt: string;
  endAt: string | null;
  // Derived server-side from startAt/endAt rather than read from the table's
  // `duration` column, so it always agrees with the timestamps beside it. Null
  // while a stop is still open.
  durationMs: number | null;
  // The plant zone, echoed per row so a row can be rendered without consulting
  // the timeline response.
  timeZone: string;
};

// Sortable columns, mirroring core-api's allowlist. Anything else is a 400.
type DowntimeSortBy = "category" | "startAt" | "duration";
type DowntimeSortDir = "asc" | "desc";

// GET /downtimes/timeline.
//
// The server merges overlapping downtime records into one flat, non-overlapping
// list that tiles [from, to) exactly, so the client only lays segments out — it
// never computes geometry from durations that might not add up. RUN_TIME is not
// a stored category; it is what a stretch no downtime record covers is called.
type TimelineSegmentKind = "RUN_TIME" | DowntimeCategory;

// The three values of the `oee.operation_type` enum, which is what a downtime
// record's category actually is. Named separately from TimelineSegmentKind
// because RUN_TIME is not one of them — it is the absence of a record — so a
// function that takes "which category am I about" must not accept it.
//
// Every OEE loss factor with a reason-level breakdown is one of these:
// UNPLANNED is Availability Loss, PLANNED is Schedule Loss, SMALL_STOP is half
// of Performance Loss. lib/loss-category.ts is keyed by this.
type DowntimeCategory = "PLANNED" | "UNPLANNED" | "SMALL_STOP";

type TimelineSegment = {
  kind: TimelineSegmentKind;
  // ISO-8601 instants. Render them with formatClock and the timeZone below —
  // the browser's own zone is not the plant's.
  startAt: string;
  endAt: string;
  durationMs: number;
};

// `from` / `to` are the shift window. They are the only statement of the shift
// boundaries the browser gets: 07:00/15:00/23:00 live in core-api, never here.
type ShiftTimeline = {
  from: string;
  to: string;
  // IANA zone, e.g. "Asia/Jakarta".
  timeZone: string;
  segments: TimelineSegment[];
  // How far the pipeline has loaded the downtime table. NULL means never.
  //
  // WITHOUT THIS THE STRIP CANNOT BE HONEST. `segments` for a shift with no
  // downtime rows is one full-width RUN_TIME band, and no rows has two opposite
  // causes — the machine ran clean, or the downtime ETL has not reached this day.
  // The ambiguous outcome is the FLATTERING one, so a shift that was down for
  // hours rendered as flawless with nothing on screen to suggest otherwise.
  // TODOS §8.
  loadedThrough: string | null;
};

// One product's hour within one shift, from GET /shift-reports/:id/performance.
//
// STORED COLUMNS ONLY — core-api derives nothing. The rate is `totalOut` over the
// hours actually run, and it is computed once in lib/perf-hourly.ts because the
// correct value at any grain is a ratio of sums rather than a mean of per-bucket
// ratios. A BI tool derives it the same way from the same two columns, so the
// chart and any report agree by construction.
//
// ABSENCE IS MEANINGFUL. A bucket with no row for a product is an hour that
// product did not run, which is NOT the same as an hour it ran and made nothing.
// The chart draws a gap for the first and a point on the axis for the second.
type PerfHourBucket = {
  // ISO instant. The x-axis key and the sort key — never the clock label. Shift 3
  // runs 23:00 -> 07:00, so its labels sort 00,01,…,06,23 and put the shift's
  // FIRST hour last. core-api already orders by this.
  bucketStart: string;
  bucketEnd: string;
  // Local clock hour 0-23, and the bucket's 0-based position in its shift. Labels
  // the pipeline computed in the plant's zone; `hourOfDay` is also the grouping
  // key a day- or month-grain hour-of-day profile will use.
  hourOfDay: number;
  shiftHourSeq: number;
  productId: number;
  productName: string;
  productCode: string;
  // Every measure on this row is in this unit — not split base/production like
  // ProductCountItem, because a rate and its standard must share a unit or they
  // cannot be compared.
  uomCode: string;
  totalOut: number;
  effectiveOut: number;
  // Milliseconds, like every other duration here, and the denominator of the rate.
  runtime: number;
  // The master standard, per hour, in uomCode. Null means no standard was known
  // when the row loaded — a real state, not a zero. Rendering 0 would draw a
  // target of "make nothing"; the chart omits the series instead.
  idealRatePerHour: number | null;
};

// GET /work-units/shift-reports/:id/performance.
//
// An object rather than a bare array, unlike the products response: it carries two
// facts the buckets cannot state about themselves.
type ShiftPerformance = {
  // IANA zone, e.g. "Asia/Jakarta". The bucket labels are local clock times and the
  // browser has no work-unit-to-zone table of its own.
  timeZone: string;
  buckets: PerfHourBucket[];
  // The furthest business day the pipeline has loaded, YYYY-MM-DD, or null for
  // never. This is what makes an empty `buckets` legible: compared against the
  // report's business day it separates "not loaded yet" from "the machine idled",
  // which is the ambiguity the timeline strip and the SKU card still have.
  loadedThrough: string | null;
};

// One primary downtime reason within one shift, from
// GET /downtimes/by-reason. Already aggregated and CLIPPED to the shift window
// server-side; the browser never re-derives a total from raw records, which is
// the rule timeline-card.tsx states about the strip.
type DowntimeReasonBucket = {
  // The FIRST element of the record's jsonb reason array. A stop can carry
  // several, so the grouping discards the rest rather than counting one stop
  // under two reasons — the bars would otherwise sum to more than the shift.
  //
  // NULL when no usable reason was recorded. It is a real bucket, not a row to
  // filter out, and the LABEL for it belongs here in the browser: the server
  // deliberately does not send "Unspecified", because a real reason of that
  // exact text would silently merge into the same bucket.
  reason: string | null;
  // Distinct machines behind the bucket. One entry at work-unit scope, which is
  // the only scope this endpoint serves today.
  workUnitNames: string[];
  frequency: number;
  durationMs: number;
};

// GET /downtimes/by-reason. An object rather than a bare array, for the reason
// ShiftPerformance is one.
// The truncated tail of a reason breakdown.
//
// `reasonCount` is what the "Other" bar's label renders — "Other (37 reasons)" —
// because "Other" alone does not say whether one reason was folded in or two
// hundred, and that difference is the whole reason to care that a chart is
// truncated.
// Which measure ranks a reason breakdown — and therefore which buckets come back,
// since the response is truncated to the top N. A WIRE type, mirroring core-api's
// ReasonMeasure; lib/pareto.ts's ParetoMeasure is an alias of it, so the chart's
// toggle and the query parameter cannot drift into disagreeing about the values.
type ReasonMeasure = "duration" | "frequency";

// One machine's contribution to a line report — a Machine View row.
//
// EVERY FIGURE IS THAT MACHINE'S OWN, from oee.work_unit_*_reports. Nothing here
// sums to the line's totals in the overview card above, and that is not a defect:
// a line is measured at its own count points, so `line <> sum(machines)` (0014).
// The card answers "which machine dragged the line down", not "what does the line's
// total decompose into".
type LineMachineBreakdown = {
  // THE MACHINE REPORT'S OWN ID, and the only thing the row's deep link may be
  // built from. Interpolating the LINE's id into a /report/machine/* route
  // compiles and opens an unrelated machine report — seven report tables, seven
  // independent identity sequences.
  reportId: number;
  workUnitId: number;
  workUnitName: string | null;
  workUnitCode: string | null;
  // The machine's single unit. No infeed/output split here — a work unit has one
  // count point, which is exactly what a line does not.
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
// THE WINDOW IS ON THE ENVELOPE, not on each row: every machine on a line runs the
// same shift, so a per-row pair could differ and that would be a fact about
// nothing. Instants, resolved server-side through the one statement of that
// arithmetic — so the card renders Start/End without a copy of SHIFT_WINDOWS here.
type LineMachineList = {
  timeZone: string;
  from: string;
  to: string;
  machines: LineMachineBreakdown[];
};

type ReasonTail = {
  reasonCount: number;
  frequency: number;
  durationMs: number;
};

type DowntimeReasonBreakdown = {
  // The window the durations were clipped to. Also what lets the query decide
  // whether a shift is closed and therefore immutable.
  from: string;
  to: string;
  timeZone: string;
  category: DowntimeCategory;
  // THE TOP N BY THE REQUESTED MEASURE, not every reason in the window. Which
  // measure ranked them is a request PARAMETER, and it has to be: the top ten by
  // duration are not the top ten by frequency, so re-ranking a duration-limited
  // set by frequency in the browser would draw the wrong ten bars. That is why
  // the measure toggle costs a round trip and rides in the cache key.
  buckets: DowntimeReasonBucket[];
  // Everything outside those, as one figure — null when nothing was truncated,
  // which is every machine shift. buildPareto turns it into an "Other" bar so the
  // truncation is visible and the cumulative line still closes at 100%.
  other: ReasonTail | null;
  // The cumulative line's denominators. Sent rather than summed from `buckets`,
  // which is what keeps them right now that the bars are only part of the story.
  totalFrequency: number;
  totalDurationMs: number;
  // Furthest business day the pipeline has loaded, YYYY-MM-DD, or null for
  // never. Against the report's own business day this is what separates "no
  // unplanned downtime" from "not loaded yet" — see lib/watermark.ts.
  loadedThrough: string | null;
};

// GET /downtimes/by-action. Pareto Actions, on the OEE Performance dashboard:
// what was DONE about the stops in this window, ranked.
//
// `DowntimeReasonBreakdown` MINUS `category`, and otherwise identical on purpose —
// an action is not an operation type, and the same action is taken on planned and
// unplanned stops alike. The shared shape is what lets lib/pareto.ts's buildPareto
// rank and the Pareto chart draw BOTH with one implementation, so the "Other"
// tail, the zero denominator and the unlabelled bucket have one set of edge cases
// rather than two that drift.
//
// ONE CAVEAT THE CARD MUST STATE: a stop can carry several actions and only the
// FIRST is counted, so the bars sum to the window's downtime and a second action
// recorded on a stop contributes nothing. See primaryAction in core-api for why
// the alternatives are worse.
type DowntimeActionBreakdown = Omit<DowntimeReasonBreakdown, "category">;

// GET /downtimes/by-reason/detail. ONE bucket of the breakdown, plus the records
// inside it.
//
// `bucket` is the same object the Pareto drew its bar from — the server computes
// both from one clipped row set, so the summary card cannot disagree with the
// chart it was opened from. Paging arrives in the envelope's `meta`, not here.
type ReasonDetail = {
  from: string;
  to: string;
  timeZone: string;
  category: DowntimeReasonBreakdown["category"];
  bucket: DowntimeReasonBucket;
  items: DowntimeListItem[];
  loadedThrough: string | null;
};

// One field-level change to one stop.
type DowntimeHistoryEntry = {
  id: number;
  sourceEventId: string;
  changedAt: string;
  changedBy: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
};

// GET /downtimes/by-reason/history.
//
// `trackedMembers` IS WHY THIS IS AN OBJECT. An empty `entries` has two
// meanings and the flattering one is wrong: either nothing has been edited, or
// none of these stops carries a sourceEventId and so nothing about them could
// ever be recorded. Every stop is the second case until the pipeline writes the
// key, and "No history data available" over untracked data is a claim the UI is
// not entitled to make.
type ReasonHistory = {
  entries: DowntimeHistoryEntry[];
  totalMembers: number;
  trackedMembers: number;
};

// The four editable fields of one stop, as PATCH /downtimes/:sourceEventId takes
// them.
//
// ALL FOUR REQUIRED, which is the server's contract and not a convenience. With
// optional fields, "absent" and "explicitly null" would decide whether a cleared
// detail reason is a clear or a no-op — a distinction no HTTP stack preserves
// reliably. The body is the complete post-edit state, and the SERVER works out
// which fields actually moved.
//
// `category` is DowntimeCategory, not TimelineSegmentKind: RUN_TIME is what a GAP
// between records is called and is never stored, so it cannot be assigned.
type DowntimeEdit = {
  category: DowntimeCategory;
  reason: string[];
  detailReason: string | null;
  actions: string[];
};

// The edit request. `baseline` is the optimistic-concurrency token — the values
// the dialog was showing when it opened — and the server binds it into the
// UPDATE's WHERE, so two operators editing one stop cannot silently revert each
// other. The loser gets a 412 rather than quietly winning.
type EditDowntimePayload = {
  next: DowntimeEdit;
  baseline: DowntimeEdit;
};

// Which of the four fields moved. Only `category` can make anything on screen
// stale, so this is what the stale-metrics banner keys off — and having the
// server say it keeps that rule in one place rather than re-derived here.
type EditableField = "category" | "reason" | "detailReason" | "actions";

type DowntimeEditResult = {
  item: DowntimeListItem;
  changed: EditableField[];
};

// GET /work-units/shift-reports/:id/metrics-staleness.
//
// ONE FIELD, AND IT IS A FACT RATHER THAN A VERDICT — there is deliberately no
// `stale: boolean`. Reason, actions and detail_reason are read live out of the
// downtime table, so editing them is already reflected everywhere. Editing
// `category` moves time between schedule loss and availability loss, and those
// totals are PRECOMPUTED by the pipeline — so the OEE tiles, the timeline strip
// and the waterfall keep showing the pre-edit split until it recomputes.
//
// "The pipeline has caught up with this report" is not something the server can
// know per-report yet, so it does not claim it and neither does the banner.
type MetricsStaleness = {
  // When a stop in this shift last had its category changed. Null means never,
  // which is every report today.
  categoryEditedAt: string | null;
};

// GET /work-units/shift-reports/:id/products.
//
// AN OBJECT, AND IT USED TO BE A BARE ARRAY — that change is the whole of
// TODOS §14. The card rendered "No product output recorded for this shift" for a
// machine that genuinely ran nothing AND for a business day the pipeline had not
// reached. Those are opposite claims, and an array cannot carry the difference.
//
// It is now `Watermarked`, so it goes through the same selectLoadState ladder as
// every other card on this screen.
type ShiftProductCounts = {
  items: ProductCountItem[];
  timeZone: string;
  loadedThrough: string | null;
};

// One reject counter's total for one shift, from
// GET /work-units/shift-reports/:id/rejects. Already aggregated server-side; the
// browser never re-derives a count from raw rows.
//
// TWO NUMBERS FOR ONE FACT, and both ship because the design shows both columns.
// `counterValue` is what the sensor counted, in `counterUnit` — 48 CALENDER.
// `quantity` is the same rejects with each row's conversion factor applied, in
// `convertedUnit` — 576 BAG. Only the second is comparable across counters, and
// it is what the Pareto plots.
//
// This is lib/product-count.ts's converted-versus-production-unit doctrine with
// one difference: there each figure carries ONE unit and the card's job is to
// label it correctly. Here the same rejects carry BOTH, side by side, because a
// plant reads its counters in their own units and cannot compare them in those
// units.
type RejectReasonBucket = {
  // WHICH COUNTER recorded the rejects — `Total_NG_Prod`, `NG_Over_Count`. A
  // column name the plant and the machine's HMI both use, not operator free
  // text, so unlike DowntimeReasonBucket.reason it is never null and it is
  // rendered VERBATIM: prettifying it into "Total NG Prod" would break the one
  // string a reader can match against the machine in front of them.
  reason: string;
  // The master-data reject reason behind the counter, where one is mapped. Null
  // when unmapped, or when this bucket's rows disagree about it.
  reasonCode: string | null;
  // Which machine. Nullable for the reason every denormalised label on this
  // screen is — master-data enrichment can degrade — and filled from the report
  // when absent, since this endpoint is scoped to one report and therefore one
  // machine. See buildQualityPareto.
  machineName: string | null;
  // AS THE SENSOR COUNTED IT, in `counterUnit`. Never scaled.
  counterValue: number;
  // Null when the bucket spans rows whose units disagree — one counter reporting
  // in BAG for one product and CALENDER for another. `counterValue` is then a sum
  // of unlike things, so the CELL renders an em dash rather than a plausible bare
  // number. Same guard hourly-production-body.tsx applies to a mixed-UoM shift.
  counterUnit: string | null;
  // The same rejects converted to `convertedUnit`. What the chart plots, and the
  // only figure here that may be compared or summed across counters.
  quantity: number;
  convertedUnit: string | null;
  // Grams. NULL means NOT WEIGHED — a counter with no scale behind it — which is
  // a different claim from "weighed nothing" and renders differently: an em dash
  // against `0 gr`. The design annotates this column for exactly that reason.
  weightGram: number | null;
  frequency: number;
  // Zero everywhere until the pipeline writes the per-counter reject time, so the
  // duration ranking is a column of zeros for now. Named rather than hidden —
  // the same treatment reduce-speed loss gets on the Performance Loss tab.
  durationMs: number;
};

// GET /work-units/shift-reports/:id/rejects. An object rather than a bare array,
// for the reason ShiftPerformance is one.
type RejectReasonBreakdown = {
  timeZone: string;
  buckets: RejectReasonBucket[];
  // FOUR DENOMINATORS, one per measure the card can rank by — sent rather than
  // summed from `buckets` for the reason DowntimeReasonBreakdown's two are: they
  // stay correct the day the endpoint grows a LIMIT and an "Other" bucket.
  totalFrequency: number;
  totalDurationMs: number;
  totalQuantity: number;
  // Null when no counter in the shift carries a weight at all. A null
  // denominator yields null percentages rather than NaN — deliberately NOT
  // coalesced to 0, which would claim the shift was weighed and found empty.
  totalWeightGram: number | null;
  // Non-null only when every bucket agrees. Null = the shift mixed base units,
  // so there is no one converted total and the card says so instead of adding
  // BAG to CARTON.
  convertedUnit: string | null;
  // Furthest business day the pipeline has loaded, or null for never. Against the
  // report's own business day this is what separates "no rejects" from "not
  // loaded yet" — see lib/watermark.ts. THE GOLD TABLE SHIPS EMPTY, so this is
  // the field that keeps the tab honest until the pipeline lands.
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// The Others tab — downtime reason frequency, from the immutable event log
// ---------------------------------------------------------------------------

// One downtime reason's occurrence count for one shift.
//
// FROM oee.downtime_log_events, NOT oee.downtime_reports. The event log is
// immutable, so an operator editing a downtime cannot move these bars — which is
// also why this tab has no drill-down: the losses/detail page filters
// downtime_reports by primary reason, a different table meaning a different
// thing, so its rows would not be the rows behind a bar.
type DowntimeEventReasonBucket = {
  // Null means NO REASON WAS RECORDED — a stop whose reason array was empty. The
  // server never sends the string "Unspecified"; the label is applied here
  // (UNSPECIFIED_LABEL in lib/pareto.ts) so a genuine reason of that exact text
  // cannot merge into the unattributed bucket. Same rule
  // DowntimeReasonBucket.reason follows.
  reason: string | null;
  // How many downtime EVENTS cited this reason. Named `frequency` to match its
  // two sibling bucket types, because it means what they mean: the number of
  // source records behind this bar.
  //
  // WHAT IS NEW IS NOT THE BAR, IT IS THE PAIR OF TOTALS BELOW. One event row
  // contributes to several bars, so these frequencies sum to `totalOccurrences`
  // and NOT to `totalEvents`. A reason repeated inside one event counts once,
  // because it is one event.
  frequency: number;
};

// GET /work-units/shift-reports/:id/downtime-events. An object rather than a
// bare array, for the reason ShiftPerformance is one.
type DowntimeEventReasonBreakdown = {
  timeZone: string;
  buckets: DowntimeEventReasonBucket[];
  // THE DENOMINATOR, and the only one. The total of the bars: each reason counted
  // once per event that cited it, so the cumulative line reaches exactly 100%.
  totalOccurrences: number;
  // THE NUMBER OF STOPS, and NOT the denominator. Smaller than totalOccurrences
  // whenever any event cited more than one reason.
  //
  // It ships so the card can state both and say why they differ. Nothing divides
  // by it, and nothing should: dividing by it draws a cumulative line that walks
  // past 100%, and it is the field most likely to be "simplified" into the
  // denominator by anyone who reasonably assumes a Pareto divides by its record
  // count.
  totalEvents: number;
  // Furthest business day the pipeline has loaded, or null for never. Against the
  // report's own business day this is what separates "no downtime events" from
  // "not loaded yet" — see lib/watermark.ts. THE GOLD TABLE SHIPS EMPTY, so on
  // day one this is the field that keeps the tab honest, and "not loaded yet" is
  // the only reachable non-error state.
  loadedThrough: string | null;
};

export type {
  LinePerfHourBucket,
  LinePerformance,
  ProductDetail,
  ProductPackage,
  QualityEntry,
  QualityEntryDraft,
  QualityEntryKind,
  QualityEntryList,
  QualityEntryTotal,
  RejectReasonOption,
  ActivityEntry,
  ActivityKind,
  ActivitySource,
  ApprovalSource,
  ApprovalStatus,
  AreaActivity,
  AreaActivityEntry,
  AreaGrain,
  AreaInfeedBucket,
  AreaOutputBucket,
  AreaProductCounts,
  AreaProductionUnits,
  AreaReportDetail,
  AreaYearReportDetail,
  AreaYearReportListItem,
  AreaReportListItem,
  AreaSummary,
  CreateDowntimeActionInput,
  DowntimeActionOption,
  DowntimeReasonOption,
  DowntimeCategory,
  DowntimeEventReasonBreakdown,
  DowntimeEventReasonBucket,
  DowntimeEdit,
  DowntimeEditResult,
  DowntimeHistoryEntry,
  EditableField,
  EditDowntimePayload,
  DowntimeListItem,
  LineActivity,
  LineActivityEntry,
  LineActivitySource,
  LineApprovalSummary,
  LineGrain,
  LineMachineBreakdown,
  LineMachineList,
  LinePeriodReportDetail,
  LineYearReportDetail,
  LineYearReportListItem,
  LineReportDetail,
  LineReportListItem,
  SkuActivity,
  SkuActivityEntry,
  SkuDowntimeEventBreakdown,
  SkuMachineRoster,
  SkuReportDetail,
  SkuReportListItem,
  LineReportMeasures,
  LineShiftReportDetail,
  LinePeriodReportListItem,
  LineShiftReportListItem,
  DowntimeReasonBreakdown,
  DowntimeReasonBucket,
  DowntimeSortBy,
  DowntimeSortDir,
  Me,
  PageMeta,
  PerfHourBucket,
  ProductCountItem,
  ReasonDetail,
  ReasonMeasure,
  ReasonTail,
  MetricsStaleness,
  ReasonHistory,
  ShiftProductCounts,
  RejectReasonBreakdown,
  RejectReasonBucket,
  ShiftActivity,
  ShiftPerformance,
  ShiftReportApproval,
  HourOfDayProfile,
  HourProfileBucket,
  PeriodApprovalSummary,
  PeriodReportDetail,
  MachineYearReportDetail,
  MachineYearReportListItem,
  YearReportDetail,
  PeriodReportListItem,
  ReportDetail,
  ReportMeasures,
  ShiftReportDetail,
  ShiftReportListItem,
  ShiftTimeline,
  TimelineSegment,
  TimelineSegmentKind,
  UntrackedReason,
  WebResponse,
  WorkCenterSummary,
  WorkUnitSummary,
  MonthOeeTrend,
  DowntimeActionBreakdown,
  OeeTrendPoint,
};

// ---------------------------------------------------------------------------
// Part 3 — operator-entered reject and rework
// ---------------------------------------------------------------------------

// One row of the ledger. Mirrors oee.work_center_quality_entries as the API
// projects it.
//
// BOTH QUANTITIES TRAVEL, and every screen that shows one shows the other.
// `enteredQty` in `enteredUomCode` is what the operator typed and is what they
// will recognise; `targetQty` in `targetUomCode` is what the report will move by
// once the pipeline applies it. A list showing only the second is unreadable to
// the person who wrote the entry; only the first is wrong to everybody else.
type QualityEntry = {
  id: number;
  kind: QualityEntryKind;
  workCenterId: number;
  businessDate: string;
  shift: number;
  timeZone: string;
  // PROVENANCE ONLY. The machine the operator attributed the quantity to — it
  // does NOT move that machine's own report, because a line is measured at its
  // own count points. Null on a rework.
  workUnitId: number | null;
  workUnitName: string | null;
  productId: number | null;
  productName: string | null;
  productCode: string | null;
  reasonId: number | null;
  reasonCode: string | null;
  reasonName: string | null;
  note: string | null;
  enteredQty: number;
  enteredUomCode: string;
  enteredUomName: string | null;
  targetQty: number;
  targetUomCode: string;
  targetUomName: string | null;
  // Whether the server could compare the entry's unit against the report row when
  // it was written. `unverified` is legitimate and common — a month-grain entry
  // for a date the pipeline has not reached — and says "we could not check",
  // never "we checked and it was fine".
  unitCheck: "verified" | "unverified";
  enteredAt: string;
  enteredBy: string;
  enteredByName: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  supersedesId: number | null;
};

type QualityEntryKind = "reject" | "rework";

// PER KIND AND PER UNIT, and the unit half is not decoration: a total that summed
// BAG and CARTON would be the "500 + 12 = 512 <blank>" the line grain refuses
// everywhere else. In practice every live entry on one report shares a unit, so a
// second bucket appearing here means the line's unit CHANGED between two entries
// — which the card shows rather than hides.
type QualityEntryTotal = {
  kind: QualityEntryKind;
  uomCode: string;
  qty: number;
  entries: number;
};

type QualityEntryList = {
  items: QualityEntry[];
  // LIVE ONLY. Voided rows are in `items` (they are the trail) and out of these
  // figures (they contribute to no report) — the same split the pipeline's
  // override join makes with `voided_at IS NULL`.
  totals: QualityEntryTotal[];
  // The line's infeed unit as it stands now, so the dialog can say what an entry
  // will land in. Null means the line report says its members disagreed, and
  // there is then nothing to denominate a quantity in.
  targetUomCode: string | null;
};

// What the dialog POSTs. Deliberately NOT the row's shape: the client sends what
// the OPERATOR CHOSE and the server resolves the unit arithmetic, because a
// client that could send a factor could send a conversion nobody checked.
type QualityEntryDraft = {
  kind: QualityEntryKind;
  productId: number;
  // THE PACKAGE, not a bare uom id — there is no global uom-to-uom conversion in
  // this system, so a bare unit would name something with no factor to convert
  // it by. See ProductPackage.
  //
  // OPTIONAL, because a line can run a SKU master data has not linked to it
  // (`product_work_centers` is a separate assignment upstream) and the picker
  // offers what actually RAN. Absent means: entered in the line's own unit, the
  // conversion is the identity, and the server resolves both from the report row.
  packageId?: number;
  quantity: number;
  shift: number;
  reasonId: number;
  // Reject only.
  workUnitId?: number;
  // Month grain only — the report spans ~30 days, so the operator names one.
  businessDate?: string;
  note?: string;
  // IDEMPOTENCY, generated by the browser. Without it a double-submitted form is
  // two live rows and a doubled figure with nothing anywhere to notice.
  requestId: string;
};

// One unit a product is counted in, with the factor that converts it to that
// product's base.
//
// THE UNIT PICKER'S OPTIONS, and the reason it CASCADES from the SKU picker
// rather than offering a global list: conversion in this system is per product,
// through this array. Several packages share one base, so any two convert through
// it — which is also how the dialog previews "10 CTN = 120 BAG" before submitting.
type ProductPackage = {
  id: number;
  main: boolean;
  sortOrder: number;
  factorToBase: number;
  uom: { id: number; code: string; name: string } | null;
};

type ProductDetail = {
  id: number;
  code: string;
  name: string;
  packages: ProductPackage[];
};

type RejectReasonOption = {
  id: number;
  code: string;
  name: string;
};

// One hour of one SKU on one LINE, from oee.product_perf_wc_hour (0018).
//
// TWO UNITS, which is the whole difference from PerfHourBucket. The machine
// version carries one `uomCode` and says of it that "a rate and its standard must
// share a unit or they cannot be compared". Still true, and at line grain there
// are TWO such pairs:
//
//   INFEED   totalOut                       -- what the line consumed
//   OUTPUT   effectiveOut, idealRatePerHour -- what it shipped, and the target
//
// So totalOut and effectiveOut DO NOT SHARE A SCALE. `buildLineHourlyOutput`
// splits a product into two chart blocks when its two units differ, because one
// axis drawn over bags and cartons looks entirely plausible.
type LinePerfHourBucket = {
  bucketStart: string;
  bucketEnd: string;
  hourOfDay: number;
  shiftHourSeq: number;
  productId: number;
  productName: string;
  productCode: string;
  // Either may be null — 0014's rule: NULL means "the members disagreed", not
  // "unknown", and that side's measures are null with it.
  infeedUomCode: string | null;
  outputUomCode: string | null;
  // INFEED, and deliberately not plotted against the two below.
  totalOut: number | null;
  // BOTH OUTPUT-SIDE, so they share a unit and a scale — which is what lets the
  // line chart use one quantity axis rather than needing two.
  goodOut: number | null;
  effectiveOut: number | null;
  runtime: number;
  idealRatePerHour: number | null;
};

type LinePerformance = {
  timeZone: string;
  buckets: LinePerfHourBucket[];
  // See the API type: the plant-local hour a business day starts, so the MONTH
  // profile's axis runs 07:00 -> 06:00 rather than splitting the night shift
  // across both ends. Sent at every grain so the payload has one shape.
  dayStartHour: number;
  // Null means never loaded, which is the state until Airflow fills 0018. It is
  // what lets the chart say "not loaded yet" rather than drawing a flat line at
  // zero on a line that ran all shift.
  loadedThrough: string | null;
};
