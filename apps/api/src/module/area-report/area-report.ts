import type { DateRange } from "../../shared/report-window.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";
import type { ProductCountItem } from "../../shared/product-count.js";

// THE AREA GRAIN: one area, on one business day or one month.
//
// TWO GRAINS AND NO MORE, AND THE REQUIREMENT SAYS SO RATHER THAN THE SCHEMA:
// "only have 2 type of report on the Area — daily and monthly". There is no shift
// grain and there will not be one; `AreaGrain` below is a two-member union rather
// than a reuse of `ReportGrain`, so a shift cannot be named here at all.
//
// ONE IMPLEMENTATION BEHIND TWO PREFIXES, the idiom work-unit's coarse pair and
// work-center's three already follow: `GRAIN_TABLE` in the repository names which
// table answers, and the URLs stay separate because a path should say what it
// returns. The day grain shipped first and this module carried a comment saying an
// empty loop would make the next reader hunt for the other grains; the loop is
// real now.
//
// WHY THE MONTH IS A SECOND TABLE AND NOT THE DAY TABLE WIDENED — the one thing
// to understand before reading further. §15.5's rule is that durations and counts
// SUM while rates are RECOMPUTED. Widening a day range gives the first for free
// and the second not at all, so a reader that derived a month's OEE would put a
// SECOND definition of it in the API, one click from the day screens it drills
// into. Migration 0025's header argues it; `oee.work_center_month_reports` and
// `oee.work_unit_month_reports` exist for the same reason. Note what does NOT get
// a month sibling on that argument: the per-unit Input/Output read widens
// `oee.work_center_day_reports` over the month, because summing counts WITHIN one
// unit is exact addition with no rate in it.
//
// ---------------------------------------------------------------------------
// A LINE IS MEASURED. AN AREA IS COMPOSED. READ THIS BEFORE ANYTHING ELSE HERE.
// ---------------------------------------------------------------------------
//
// Migration 0024's header is the long version. The three consequences that show
// up in these types:
//
//   1. EVERY DURATION IS IN LINE-MILLISECONDS. `runtime` on a five-line area's day
//      is ~120 hours, not ~24, and the Run Time tile is expected to say so. This
//      is the opposite of the LINE grain's rule, where 0014 is explicit that a
//      line's durations are "its own wall clock — 8 hours over a 4-machine shift,
//      not 32". A line has a clock; an area does not.
//
//   2. EVERY COUNT IS A MASS. An area's member lines disagree about both units —
//      one ships cartons, another sacks — so 0014's two-triple shape would leave
//      both triples NULL on almost every row and null every count with them. Mass
//      is the only unit the members can all be expressed in, which is why there is
//      ONE unit triple here where a line has two, and why it is called
//      `weightUom*` rather than `infeedUom*`/`outputUom*`.
//
//   3. `totalOut = goodOut + reject + rework` IS STILL NOT AN IDENTITY. At line
//      grain it is FALSE by unit (contract §16.4a). Here the units agree, so the
//      sum is at least well-formed — and it is still not asserted, because the
//      figures come from different count points on N lines and mass is neither
//      conserved through a packing line nor measured at a single point.
//
// `subject` IS NOT ON THIS PAYLOAD. The browser stamps it in lib/api.ts, which is
// the one place that knows which endpoint answered — the argument
// ShiftReportDetail.subject already makes. Sending it would be telling the caller
// something it knew from the URL it typed.

// THE TWO GRAINS AN AREA REPORT EXISTS AT.
//
// NOT `ReportGrain` FROM shared/shift-window.ts, which is
// `["shift", "day", "month"]`. That union admits a shift, and this subject has no
// shift table and is not getting one — so reusing it would make every function
// here take a value a third of which is unrepresentable in the schema, and the
// `never` exhaustiveness that catches a mis-dispatch would stop catching anything.
// A two-member union is what makes `grainFrom("shift")` a build error.
type AreaGrain = "day" | "month";

// THE THREE GRAINS THE OEE PERFORMANCE DASHBOARD READS AT THIS SUBJECT — the two
// REPORT grains plus the one `0027` added.
//
// AND `AreaGrain` STAYS TWO MEMBERS, which is the whole point of a second type
// here. The requirement is explicit that an area "only have 2 type of report", so
// the Report screens' union must keep refusing anything else — `grainFrom("year")`
// on a report path should stay as much a build error as `grainFrom("shift")` is.
// The year table is not a third report grain; it is the dashboard's, and only four
// reads reach it.
type AreaCoarseGrain = AreaGrain | "year";

// The list row. A deliberate subset of the detail payload: four rates and the
// identity, because a table renders nothing else and a list query that selected
// forty measures would page slower for no reader.
//
// `grain` IS STAMPED ON IT, by the query rather than stored. The browser's list
// components discriminate on it, and — more to the point — the Date column reads
// differently per grain: a day row renders a business DATE and a month row a MONTH
// LABEL, and the two must not be formatted by the same call.
type AreaReportListRow = {
  id: number;
  grain: AreaGrain;
  businessDate: string;
  timeZone: string;
  areaId: number;
  areaName: string;
  // NULLABLE, and the screens render it BESIDE the name rather than instead of
  // it. A denormalised name is not unique — the dev world carried two lines called
  // 'Line 1' for months (TODOS.md §77) — and a report whose subject IS the area
  // cannot identify one by a label that can repeat.
  areaCode: string | null;
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// The detail payload. `oee.area_day_reports` or `oee.area_month_reports` — the two
// tables differ by exactly ONE constraint (`ck_amr_month_start`) and by nothing a
// payload can see, which is what lets one type and one projection serve both.
//
// WHAT IS ABSENT, AND EACH ABSENCE IS THE TABLE'S (0024):
//
//   no `teep`            TEEP divides by CALENDAR time, and an area owns no
//                        calendar a reader could name — is it 24 hours, or 24
//                        times the line count? Consequence 1 makes the second of
//                        every other duration here, and a ratio over that
//                        denominator is one nobody asked for. `oee` stays: it
//                        divides by the area's own composed loading time.
//   no `effectiveOut`    the requirement's Area Overview names OEE, A, P, Q,
//                        Achievement, {Area} Production, Total Production, Finish
//                        Good and Runtime, and stops. Effective Production is the
//                        one line tile the area card does not have, so the column
//                        is absent rather than shipped NULL forever (contract
//                        §23.1 — match the requirement and stop).
//   no member count      the requirement's list and overview name none, so
//                        `work_center_count` is not on the table. It is the field
//                        most likely to be asked for next, and it is an ALTER
//                        TABLE plus one line here when it is.
type AreaReport = {
  id: number;
  // Stamped by the query from the table it read, not stored — the one place that
  // knows which of the two answered. The browser's report union discriminates on
  // it, and its own cards read it to decide whether `businessDate` is a day or a
  // month start.
  grain: AreaGrain;
  // AT MONTH GRAIN THIS IS THE FIRST BUSINESS DAY OF THE MONTH, enforced by
  // `ck_amr_month_start` (0025). It is still a business DATE and still must never
  // go through an instant formatter; what changes is which formatter reads it.
  businessDate: string;
  timeZone: string;
  areaId: number;
  areaName: string;
  areaCode: string | null;
  // THE LEVEL ABOVE, denormalised on the Gold row exactly as a line row carries
  // its area. Nullable, and nothing renders it yet — it is here so the factory
  // report (contract §23.2) is a read rather than a hierarchy lookup.
  //
  // NAMED `site` SINCE `0028`, AND THE OLD NAME WAS THE BUG. The column was
  // `factory_id` from `0024` until `0028` renamed it: there is no `factory` in
  // mes-master-data, whose hierarchy is enterprise → site → area → work center →
  // work unit, so the level above an area is a SITE. A column named for a level
  // the master data does not have is not joinable by an outside reader, and
  // column names are a public interface (contract §23.3).
  siteId: number | null;
  siteName: string | null;
  // THE TOP OF THE HIERARCHY, added by `0028` for the same reason: a Gold row
  // should name every level above its own grain, so no read has to walk upstream
  // to find out which plant it belongs to.
  enterpriseId: number | null;
  enterpriseName: string | null;

  // THE ONE UNIT, AND IT IS A MASS — see consequence 2 above.
  //
  // NULL MEANS "THE MEMBERS COULD NOT BE BROUGHT TO A COMMON MASS", which is a
  // THIRD meaning for a null unit in this schema and the one most likely to be
  // misread. On a LINE row it means the members disagreed about a unit; on a SKU
  // row (0023) it means simply not known. Here the members cannot disagree — mass
  // commutes — so it means a product that ran has no `std_weight` in master data
  // and the pipeline refused to guess. The five counts are NULL with it.
  weightUomId: number | null;
  weightUomName: string | null;
  weightUomCode: string | null;

  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;

  // All five in `weightUom*`. `areaOut` is the tile the overview card labels with
  // the AREA's own name, exactly as the line card labels `lineOut` with the
  // line's: the member lines' own measured production, summed as a mass. It is a
  // different question from `totalOut`, which is what those lines CONSUMED.
  totalOut: number | null;
  areaOut: number | null;
  reject: number | null;
  rework: number | null;
  goodOut: number | null;

  // LINE-MILLISECONDS, every one of them. See consequence 1.
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

// The window an area report covers.
//
// `DateRange` PLUS AN AREA, NOT `ReportWindow` PLUS AN AREA. ReportWindow carries
// `workCenterId` and a `shift`, and this subject has neither: an area is not
// scoped by a line, and neither of its grains narrows to a shift. Composing from
// the bare range is what lets `inDateRange` — the single statement of the
// half-open rule — serve this subject without the area reader inheriting a line id
// it would have to invent a value for.
//
// THE GRAIN IS NOT ON IT, AND THAT IS THE POINT. A day window and a month window
// differ only in where `dateTo` lands (the next day, or the first of the next
// month), so every read below takes the same shape and none of them branches. The
// service resolves that one difference once, from the report's own row. A `grain`
// field here would be a value six reads could consult and get wrong.
type AreaWindow = DateRange & {
  areaId: number;
  timeZone: string;
};

// THE AREA'S MEMBER LINES, for the two reads whose source tables have no
// `area_id` of their own.
//
// WHY IT EXISTS AT ALL. `oee.downtime_reports` (0007), `oee.downtime_log_events`
// (0009) and `oee.reject_count_wc_shift` (0019) all carry `area_id`, so those
// reads are plain predicates. `oee.product_count_wc_day` (0016) does NOT, and it
// is the SKU View's only source — so that read has to name the lines.
//
// WHERE THE LIST COMES FROM, AND WHY IT IS NOT A MASTER-DATA ROSTER.
// `oee.work_center_day_reports.area_id` is the pipeline's own attribution: it
// records the area it attributed a LINE's numbers to, over the same window. A
// roster from mes-master-data is the area's membership NOW, which is a different
// fact and the wrong one — it is the correction the line approval cascade already
// made (AGENTS.md: "the column records the line the pipeline attributed a
// machine's numbers TO, where a roster is the line's membership NOW"), and it
// keeps this read path free of an HTTP dependency.
type AreaLines = {
  // May be EMPTY, and an empty list is a real answer rather than an error: an area
  // whose lines the pipeline never attributed has no members for this window. Every
  // consumer must render "nothing to show" rather than widening to every line,
  // which is why this is a value and not an optional predicate.
  workCenterIds: number[];
};

type AreaReportFilter = {
  // DAY GRAIN ONLY IN PRACTICE, and the DTO is what guarantees it: the month
  // list's schema does not admit a `month` param at all, so it 400s rather than
  // accepting and ignoring one. That is stricter than the six shipped By Monthly
  // screens, which do take a month, and the requirement asked for it —
  // "Monthly Report (Show all month on selected year)". A month filter would
  // contradict the screen's own heading.
  //
  // Kept on the shared filter type rather than split into two, because
  // `businessDateFilter` already has an honest branch for `month === undefined`
  // and a discriminated filter would make three of the repository's reads take a
  // union to serve one column. The guard is at the edge, once.
  month: number | undefined;
  year: number | undefined;
  // THE HEADER'S AREA PICKER, AND ON THIS SCREEN IT IS A REQUEST FILTER.
  //
  // That is new. On every other list screen the area only decides which LINES the
  // page may offer, because those endpoints take a `workCenterId` and know nothing
  // about areas (apps/web hooks/use-work-center-filter.ts says so). Here the area
  // IS the subject, so it narrows the query.
  //
  // OPTIONAL, and an absent value means every area rather than none. The browser
  // always sends one — the picker falls back to the first area — but a
  // hand-edited URL or an API client must get a page rather than a 400.
  areaId: number | undefined;
  isHideZero: boolean;
};

type ListAreaReportInput = {
  // `AreaCoarseGrain`, since `0027`: the OEE Performance dashboard resolves a
  // report id from this list at YEAR grain. The projection is identical at all
  // three — the three area tables differ by no column a SELECT can see.
  grain: AreaCoarseGrain;
  limit: number;
  offset: number;
  filter: AreaReportFilter;
};

type PagedAreaReport = {
  items: AreaReportListRow[];
  totalElements: number;
};

// The Quality Loss Pareto and the Others tab, on the same envelope every other
// subject uses: the shared aggregate plus the window's zone and the watermark that
// separates "this area rejected nothing" from "the DAG has not run".
//
// THE MIXED-UNIT ABSTAIN FIRES FAR MORE OFTEN AT THIS GRAIN, AND THAT IS CORRECT.
// aggregateRejectRows nulls a bucket's unit when its rows disagree, and an area's
// count points genuinely differ — so an em dash where a line would show a figure
// is the honest answer rather than a regression. loss-aggregate.ts makes the same
// note about the line grain one level down; the argument only gets stronger here.
type AreaRejectBreakdown = RejectAggregate & {
  timeZone: string;
  loadedThrough: string | null;
};

type AreaDowntimeEventBreakdown = DowntimeEventAggregate & {
  timeZone: string;
  loadedThrough: string | null;
};

// SKU View's rows, from oee.product_count_wc_day over the area's lines.
//
// A ROLL-UP, AND THIS IS THE ONE PLACE IN THIS SCHEMA WHERE THAT IS THE RIGHT
// ANSWER — which is worth stating because contract §17.1 spends a section
// forbidding it one grain down. §17.1's argument is that a per-SKU view rolled up
// from MACHINES would print figures that visibly disagree with the LINE card above
// them, and the disagreement would be correct, because a line is measured at its
// own count points.
//
// Neither half holds here. Summing a SKU's counts across lines WITHIN ONE UNIT is
// exact arithmetic — no denominator to invent, no rate to average — and the card
// above this one is denominated in MASS, so there is no shared figure for the two
// to disagree about. The looseness is stated in the tooltip rather than hidden.
//
// THE DAY TABLE ANSWERS BOTH GRAINS, by being widened over the window's range —
// which is exactly what `0016` created two tables rather than three for, and what
// `listPeriodProductCount` already proves on the machine pair. It is safe here and
// unsafe for the REPORT tables for one reason: this read sums COUNTS, and a count
// sums. A report carries rates, and a rate does not.
//
// `oee.product_count_wc_day` SHIPS EMPTY AND HAS NO DEV SEED, on purpose
// (migration 0016: "the only available derivation is the roll-up, so a seed would
// teach the invariant the table exists to deny"). So this read answers empty in
// dev, and `loadedThrough` is what lets the card say which kind of empty.
type AreaProductCounts = {
  items: ProductCountItem[];
  timeZone: string;
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// The Input/Output Production KPI — the per-unit view the mass columns cannot give
// ---------------------------------------------------------------------------
//
// The requirement asks for two things about an area's production and they pull in
// opposite directions: one headline figure ("{Area} Production, Total Production
// and Finish Good use Weight Unit") and a breakdown across every unit its lines
// actually count in ("infeed: bag/shot/etc; output: carton/bag/sack — user want to
// know sum of total production in all infeed unit and sum of total output in all
// unit").
//
// The mass columns on oee.area_day_reports answer the first. This answers the
// second, and it is NOT A TABLE — contract §23.1's "do not over-table" applies
// squarely, because summing counts WITHIN one unit across lines is exact addition
// with nothing to invent. It is a read-time aggregate over
// oee.work_center_day_reports grouped by that table's own two unit triples.
//
// TWO INDEPENDENT GROUPINGS, NOT ONE PIVOT WITH A `side` COLUMN. A line row
// carries an infeed unit AND an output unit, in two separate column groups, so
// "group by unit" is two different questions over the same rows — and a single
// list with a discriminator would invite a reader to total it, which is the one
// arithmetic 0014 forbids. The payload keeps them apart so nothing downstream can
// add across them.
type AreaInfeedBucket = {
  uomId: number;
  uomName: string | null;
  uomCode: string | null;
  // How many of the area's lines counted in this unit. Not decoration: it is what
  // tells a reader whether a bucket is one line's whole output or a genuine sum,
  // and the card renders it.
  workCenterCount: number;
  // The infeed-side counts, summed. `lineOut` is each line's own measured
  // production (0015); `totalOut` is what those lines consumed.
  totalOut: number;
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

// THE RESIDUAL RIDES WITH THE ANSWER, exactly as the SKU reads' `unattributed`
// count does and for the same reason.
//
// A line whose unit the pipeline could not resolve has a NULL unit triple, and
// 0014's CHECK nulls its counts WITH it — so such a line contributes nothing to
// any bucket and is silently absent. Without these two numbers, "this area's
// lines all count in BAG" and "half this area has no unit yet" are the same
// screen, and only the first is a statement about production.
//
// COUNTED PER SIDE, because 0014's guards are per side: a line can be certain what
// it consumed and abstain about what it shipped, so the two residuals genuinely
// differ.
type AreaProductionUnits = {
  timeZone: string;
  infeed: AreaInfeedBucket[];
  output: AreaOutputBucket[];
  // Lines in this window with no infeed / output unit resolved. Zero is the
  // healthy state and the card says nothing when both are zero.
  infeedUnresolved: number;
  outputUnresolved: number;
  // oee.etl_watermarks for work_center_day_reports — the table these buckets are
  // summed from, NOT area_day_reports. Two different loads, and quoting the wrong
  // one would vouch for a freshness this card's own source does not have.
  loadedThrough: string | null;
};

// ---------------------------------------------------------------------------
// The area day report's Log Activity panel
// ---------------------------------------------------------------------------
//
// A FOURTH DECLARATION, not an import from work-unit.ts, work-center.ts or
// product-report.ts. What the four feeds share is a WIRE SHAPE, not a type — the
// call work-center.ts made first and product-report.ts repeated — and modules never
// reach into each other's internals.
//
// SERVES BOTH GRAINS UNCHANGED, unlike the LINE feed, which is shift-only because
// both its arms scope by a shift window over the line's machine reports (§60).
// These two arms scope by a business-DATE RANGE, so a month is the same query with
// a wider `dateTo` — no second endpoint and no second shape.
//
// TWO ENTRY KINDS, AND THE MISSING THIRD IS THE POINT, exactly as at SKU grain.
// There is no `approval` arm in the union at all, so an approval entry cannot be
// CONSTRUCTED here: oee.work_unit_shift_report_approval_events is keyed
// (work_unit_id, date, shift), and an area report has neither at either grain.
//
// WHY THE ABSENCE IS REPORTED AND NOT INFERRED. A machine DAY feed reports its
// three child SHIFT reports' transitions, so "a coarse grain can still show
// approvals" is demonstrably true one subject over, and a reader will look for
// them here. The answer is that an AREA REPORT IS NOT APPROVABLE — there is
// nothing to sign at this grain and no cascade defined for it — so the transitions
// that exist belong to the machine and line screens that can act on them.
// Surfacing ~15 machine-shift sign-offs in an area panel would be a chronology
// nobody can act on from the page they are reading. TODOS.md carries the question.
type AreaActivityKind = "downtime" | "quality";

// The SAME wire vocabulary work-unit.ts's UntrackedReason uses — the browser's
// NOT_TRACKED_BODY is a TOTAL map over these values, so an invented one renders a
// blank sentence. This is the FOURTH declaration of the list; a value added to one
// must be added to the browser's or a reader gets an empty box.
type AreaUntrackedReason = "no-source" | "no-stable-id" | "not-implemented" | "not-applicable";

type AreaActivitySource = {
  kind: "approval" | AreaActivityKind;
  tracked: boolean;
  untrackedReason: AreaUntrackedReason | null;
  totalMembers: number;
  trackedMembers: number;
};

type AreaActivityEntry =
  | {
      kind: "downtime";
      id: string;
      at: Date;
      by: string;
      sourceEventId: string;
      field: string;
      oldValue: unknown;
      newValue: unknown;
      // WHICH MACHINE the stop was on, and WHICH LINE. An area day feed spans
      // both axes AND three shifts, so the machine alone can leave two edits
      // reading as one — the line is what separates "the filler on Line 1" from
      // "the filler on Line 2", which in a plant with per-line naming is the only
      // distinguishing fact. The SKU feed needs only the machine because it is
      // scoped to ONE line.
      workUnitId: number;
      workUnitName: string | null;
      workCenterId: number | null;
      workCenterName: string | null;
    }
  | {
      kind: "quality";
      id: string;
      at: Date;
      by: string;
      byName: string | null;
      // WHICH SHIFT and WHICH LINE. An area day spans three shifts and N lines,
      // and a REWORK carries no work_unit_id at all — so neither alone
      // disambiguates and both ship. (A line SHIFT feed labels with the machine
      // because it spans exactly one shift and one line; a SKU DAY feed labels
      // with the shift because it spans one line.)
      shift: number;
      workCenterId: number;
      entryKind: "reject" | "rework";
      productName: string | null;
      reasonName: string | null;
      enteredQty: number;
      enteredUomCode: string;
      targetQty: number;
      targetUomCode: string;
      unitCheck: string;
      voidedAt: string | null;
      voidedBy: string | null;
      voidedByName: string | null;
      voidReason: string | null;
    };

type AreaActivity = {
  timeZone: string;
  entries: AreaActivityEntry[];
  // Always length 3 — see AreaActivityKind.
  sources: AreaActivitySource[];
};

export type {
  AreaActivity,
  AreaCoarseGrain,
  AreaGrain,
  AreaActivityEntry,
  AreaActivitySource,
  AreaDowntimeEventBreakdown,
  AreaInfeedBucket,
  AreaLines,
  AreaOutputBucket,
  AreaProductCounts,
  AreaProductionUnits,
  AreaRejectBreakdown,
  AreaReport,
  AreaReportFilter,
  AreaReportListRow,
  AreaWindow,
  ListAreaReportInput,
  PagedAreaReport,
};
