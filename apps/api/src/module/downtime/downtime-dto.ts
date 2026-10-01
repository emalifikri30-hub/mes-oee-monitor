import * as z from "zod";

import { jsonValidator, paginationSchema, queryValidator } from "@molca/helper";
import { DOWNTIME_CATEGORIES, DOWNTIME_SORT_BY, DOWNTIME_SORT_DIR } from "./downtime.js";
import { REPORT_GRAINS, SHIFT_IDS } from "../../shared/shift-window.js";

import type { ReportGrain } from "../../shared/shift-window.js";

// A shift-grain window needs a shift; the other two grains have no use for one.
//
// Expressed as a refinement rather than a discriminated union on `grain`. The
// union is the textbook answer and it costs more than it buys here: the three
// members would be identical but for one optional field, every downstream schema
// that extends this one (`list`, `byReason`, and through it `reasonDetail` and
// `reasonHistory`) would have to extend three members instead of one, and the
// inferred type would become a union every consumer has to narrow before
// reading `scope`.
//
// `resolveReportWindow` throws on the same condition. That is not redundancy —
// this one turns it into a 400 naming the field, and that one stops a caller
// constructing the arguments in code from getting a silently three-times-too-long
// window.
//
// `ReportGrain` RATHER THAN THE THREE LITERALS IT USED TO SPELL OUT. When `0027`
// added `year` to REPORT_GRAINS the enum above widened and this signature did not,
// so every leaf schema failed to typecheck — which is the mechanism working, but
// only once. Deriving it means the fifth grain is not a fifth edit here.
function shiftRequiredForShiftGrain(value: { grain: ReportGrain; shift?: string }): boolean {
  return value.grain !== "shift" || value.shift !== undefined;
}

const SHIFT_REQUIRED_ERROR = {
  message: "`shift` is required when `grain` is `shift`",
  path: ["shift"],
};

// Query params arrive as strings, so `scopeId` is coerced the same way
// work-unit-dto.ts coerces its numerics.
//
// `scope` admits all four hierarchy levels even though only two are served: the
// contract is fixed now so the browser and the future work-center / area screens
// never have to change shape. The handler rejects the unserved two with a 400
// that names the limitation, which is a clearer answer than a schema error that
// implies the value is nonsense.
//
// `grain` DEFAULTS TO "shift", and that default is what keeps this change
// invisible to every existing caller. The browser's shift-report screens send no
// `grain` at all and keep the exact behaviour they had; the day and month
// screens send one. Making it required would have been a breaking change to a
// shipped contract for no gain.
//
// SPLIT INTO AN UNREFINED BASE AND A REFINED EXPORT, and that split is forced by
// zod rather than chosen. `.extend()` throws at RUNTIME — "Cannot overwrite keys
// on object schemas containing refinements" — when it overwrites a key on a
// schema carrying a refinement, and `reasonBreakdownInputSchema` below overwrites
// `scope` to narrow it to work-unit. TypeScript accepts that call happily, so the
// only signal is every route in this module failing to load.
//
// So the refinement is applied at each LEAF schema instead of once at the root.
// The cost is that `shiftRequiredForShiftGrain` is named four times below; the
// alternative is a base that cannot be narrowed.
const timelineInputBase = z.object({
  scope: z.enum(["work-unit", "work-center", "area", "factory"]),
  scopeId: z.coerce.number().check(z.int(), z.positive()),
  grain: z.enum(REPORT_GRAINS).default("shift"),
  // The report's business day. Kept as a string rather than coerced to a Date:
  // it is handed straight to Postgres as `::date`, and parsing it in JS would
  // reintroduce exactly the session-time-zone ambiguity this design avoids.
  //
  // At month grain any day inside the month is accepted and truncated by
  // `resolveReportWindow`; callers send the report's own `business_date`.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  // OPTIONAL IN THE SHAPE, REQUIRED BY THE REFINEMENT BELOW when grain is
  // "shift". A day or month window has no shift, and there is no honest value
  // to default it to — defaulting to "1" would silently return an eight-hour
  // slice of a month and render a report that looks merely quiet.
  shift: z.enum(SHIFT_IDS).optional(),
  // A FILTER ALONGSIDE THE SCOPE, NEVER A FIFTH SCOPE. Migration 0020's header is
  // explicit about it: the hierarchy axis is CONTAINMENT — a work unit is inside a
  // work center, permanently, so an event on the child is an event on the parent
  // and a scope parameter suffices. SKU is OCCUPANCY OVER TIME: a line runs A,
  // then B, and a stop while A was running is not a stop on B. No scope can derive
  // that, because the fact is not in the row.
  //
  // So a SKU read is always "this SKU, ON THIS LINE" — scope AND product, never
  // `scope=product`. SCOPE_COLUMN has no product member and must not grow one.
  //
  // OMITTED MEANS EVERY STOP, INCLUDING THE UNATTRIBUTED ONES. It does not mean
  // `product_id IS NULL`, and it does not mean "all products" in a way that would
  // exclude rows the pipeline has not attributed yet — every shipped caller sends
  // nothing and must keep seeing exactly what it sees today.
  productId: z.optional(z.coerce.number().check(z.int(), z.positive())),
});

const timelineInputSchema = timelineInputBase.refine(
  shiftRequiredForShiftGrain,
  SHIFT_REQUIRED_ERROR,
);

// The detail table asks for the same slice of the plant as the timeline, so it
// reuses the scope/date/shift schema verbatim and adds paging and sorting. Both
// endpoints therefore agree on which records belong to a shift — the table lists
// exactly the records the strip above it was drawn from.
//
// `sortBy` is an enum, not a column name: it maps to SQL through an allowlist in
// the repository, so no caller can name a column.
const listDowntimeInputSchema = timelineInputBase
  .extend(paginationSchema.shape)
  .extend({
    sortBy: z.enum(DOWNTIME_SORT_BY).default("startAt"),
    sortDir: z.enum(DOWNTIME_SORT_DIR).default("desc"),
  })
  .refine(shiftRequiredForShiftGrain, SHIFT_REQUIRED_ERROR);

// The reason breakdown behind the Availability Loss tab. Reuses the date/shift
// half of the schema above for the reason the list does: this is an AGGREGATE
// over exactly the records the strip was drawn from, so the two must never be
// able to disagree about which records belong to a shift.
//
// SCOPE NOW ADMITS work-center, and the LIMIT below is what made that safe.
//
// This used to be `z.literal("work-unit")`, because the endpoint was unpaged and
// the browser held the whole response: bounded by construction at one machine over
// one eight-hour shift, and bounded by nothing at line grain. TODOS.md §25 said
// widening it had to arrive WITH a server-side limit and an "Other" tail bucket,
// and it does.
//
// WHAT THE MEASUREMENT ACTUALLY SHOWED, because §25's premise was half right.
// A LIMIT bounds the RESPONSE, not a GROUP BY, so it was worth checking which of
// the two was the problem. At `scope=work-center` on postgres:18-alpine:
//
//   line-shift,  4 machines        60 rows ->  20 buckets     1 ms
//   line-day,    4 machines       160 rows ->  30 buckets     1 ms
//   line-month,  4 machines      4800 rows ->  60 buckets     6 ms
//   line-month, 10 machines     24800 rows -> 120 buckets    23 ms
//   plant-YEAR shape           876000 rows -> 400 buckets   513 ms
//
// So the QUERY is not the problem at line grain — the response is. 120 bars is a
// chart nobody can read and a payload that grows with the plant. The 2799 ms
// figure §25 quotes belongs to the last row's shape, `area` and `factory` over a
// year, which is a different question and still unanswered — which is why those
// two scopes stay out and `requireSupported` in the handler is now reachable and
// called.
//
// `category` is a parameter rather than a hardcoded UNPLANNED because it is the
// only thing separating this question from the adjacent ones a supervisor asks
// next: a planned-maintenance breakdown is the same query with one literal
// changed. The default is UNPLANNED because that, and only that, is availability
// loss — PLANNED time is subtracted from planned production time rather than
// lost against it, and SMALL_STOP is its own enum value that the availability
// tab must not absorb.
// Built from the UNREFINED base, because it overwrites `scope` — see the note on
// timelineInputBase for why that matters and how it fails if you forget.
const reasonBreakdownBase = timelineInputBase.extend({
  // The THREE supported scopes, not all four. SCOPE_COLUMN maps these three;
  // `factory` has no column on oee.downtime_reports and is refused by
  // requireSupported with a 400, exactly as it is on the two sibling routes.
  //
  // `area` JOINED THEM FOR THE AREA REPORT'S LOSSES SCREEN, and the §25 cost
  // question it was held back on is answered rather than waived — the four changes
  // §25 asked for all shipped with the line grain. See ReasonBreakdownFilter in
  // downtime.ts, which carries that argument in full.
  scope: z.enum(["work-unit", "work-center", "area"]),
  category: z.enum(DOWNTIME_CATEGORIES).default("UNPLANNED"),
});

// The ranking and the truncation belong to THIS schema alone, not to the shared
// base — the drill-down and the history below narrow to one bucket already, and a
// `measure` they accepted and ignored would be a parameter that answers a
// different question than the one it names.
const reasonBreakdownInputSchema = reasonBreakdownBase
  .extend({
    // WHICH MEASURE RANKS THE BUCKETS — and therefore which ones survive `limit`.
    //
    // A PARAMETER, not a presentation concern, and only because the response is
    // truncated. The browser re-ranked client-side for free while it held every
    // bucket; the top ten by duration are not the top ten by frequency, so once
    // the server picks the ten, re-ranking them by the other measure would draw
    // the wrong ten bars under a cumulative line that still looked plausible. The
    // measure toggle therefore costs a round trip now, and rides in the cache key.
    measure: z.enum(["duration", "frequency"]).default("duration"),
    // HOW MANY BARS. 20 sits above what a machine shift ever produces — so no
    // shipped screen changes — and below what a line month does, which is where it
    // is meant to bite. Capped rather than unbounded: a caller asking for 5000
    // would be back to the unpaged endpoint this replaced.
    limit: z.coerce.number().check(z.int(), z.gte(1), z.lte(100)).default(20),
  })
  .refine(shiftRequiredForShiftGrain, SHIFT_REQUIRED_ERROR);

// Pareto Actions, on the OEE Performance dashboard.
//
// BUILT FROM timelineInputBase, NOT FROM reasonBreakdownBase, and the difference
// is exactly one field: this takes NO `category`. A reason explains why a stop
// happened and belongs to one operation type; an action is what somebody did
// about it, and "Replace Belt" is the same action whether the stop was planned or
// not. Splitting by category would scatter one action across three charts and
// rank none of them correctly. See primaryAction in downtime-repository.ts for
// the other half of that argument — why only the FIRST action is counted.
//
// `scope` is overwritten for timelineInputBase's stated reason, and to the same
// three supported scopes.
const actionBreakdownInputSchema = timelineInputBase
  .extend({
    scope: z.enum(["work-unit", "work-center", "area"]),
    measure: z.enum(["duration", "frequency"]).default("duration"),
    limit: z.coerce.number().check(z.int(), z.gte(1), z.lte(100)).default(20),
  })
  .refine(shiftRequiredForShiftGrain, SHIFT_REQUIRED_ERROR);

// WHICH BUCKET the drill-down is about, as two params rather than one.
//
// This is the trap TODOS.md §27 names, expressed as a schema. Over the wire the
// unlabelled bucket is `reason IS NULL`; the browser's "Unspecified" label is
// applied in lib/pareto.ts precisely so a genuine reason of that text cannot
// merge into it. A single `reason` param cannot carry that distinction —
// `?reason=` (empty) and no `reason` at all are the same absence to every HTTP
// stack in the path, so "the unlabelled bucket" and "no filter at all" would
// collapse into each other and the endpoint would answer the wrong question
// without erroring.
//
// So: `reason` names a labelled bucket, `unlabelled=true` names the NULL one,
// and EXACTLY ONE must be present. `exactlyOneSelector` is what makes the
// discriminated union in downtime.ts safe to build from these two fields.
const reasonSelectorShape = {
  reason: z.string().min(1).optional(),
  // Query params are strings. Accepting only the two literals keeps `?unlabelled=1`
  // or `?unlabelled=yes` a 400 rather than a silent false, which would send the
  // caller the whole shift's stops under the guise of one bucket.
  unlabelled: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
};

// XOR. `.refine` runs on the PARSED object, so `unlabelled` is already a boolean
// here and the comparison is total.
function exactlyOneSelector(value: { reason?: string; unlabelled: boolean }): boolean {
  return (value.reason !== undefined) !== value.unlabelled;
}

const SELECTOR_ERROR = {
  message: "provide exactly one of `reason` or `unlabelled=true`",
  path: ["reason"],
};

// The per-reason drill-down. The breakdown's schema plus a selector, plus the
// list's paging and sorting — deliberately assembled from the existing schemas
// rather than restated, so a change to either propagates here.
//
// Scope stays narrowed to work-unit for the same reason the breakdown narrows
// it: this page IS the breakdown's drill-down, so it cannot be reachable from
// scopes the breakdown itself cannot serve.
//
// `sortDir` defaults to `asc` rather than the list's `desc`: this table reads as
// a chronology of one reason's stops within a single shift, so oldest-first is
// the order someone reconstructing the shift wants.
const reasonDetailInputSchema = reasonBreakdownBase
  .extend(paginationSchema.shape)
  .extend(reasonSelectorShape)
  .extend({
    sortBy: z.enum(DOWNTIME_SORT_BY).default("startAt"),
    sortDir: z.enum(DOWNTIME_SORT_DIR).default("asc"),
  })
  .refine(exactlyOneSelector, SELECTOR_ERROR)
  .refine(shiftRequiredForShiftGrain, SHIFT_REQUIRED_ERROR);

// History is unpaged and unsorted by the caller — it is a chronology, not a
// table — so it takes the bucket identity and nothing else.
const reasonHistoryInputSchema = reasonBreakdownBase
  .extend(reasonSelectorShape)
  .refine(exactlyOneSelector, SELECTOR_ERROR)
  .refine(shiftRequiredForShiftGrain, SHIFT_REQUIRED_ERROR);

// ─────────────────────────────────────────────────────────────────────────────
// The edit body — the first jsonValidator in this service
// ─────────────────────────────────────────────────────────────────────────────
//
// THIS SCHEMA IS THE ONLY GUARD ON reason AND actions THAT WILL EVER RUN.
//
// oee.downtime_reports has been pipeline-written until now, so those two jsonb
// columns carry no CHECK — unlike oee.downtime_log_events.reasons, which 0009
// protects with ck_dtle_reasons and an IMMUTABLE oee.text_array_has_blank()
// helper because blank and whitespace-only elements are a real hazard. An
// operator-written array must not be able to be worse-formed than a
// pipeline-written one, and here there is no constraint underneath to catch it.
// Adding one was considered and rejected: the column already holds live pipeline
// rows, so a CHECK could fail the migration on data nobody has surveyed. Filed
// in TODOS.md rather than guessed at.
//
// WHAT EACH RULE PREVENTS, because none of them throws anything visible:
//
//   trim + reject blank   '  ' in the array becomes an empty Pareto bucket that
//                         is NOT the unlabelled one — a second empty bar beside
//                         the real one. 0009's ck_dtle_reasons exists for this.
//   dedupe                the drill-down counts a stop once per DISTINCT reason;
//                         a duplicated element is a bar that overstates itself.
//                         0009 says the reader "trims but does not case-fold" and
//                         that a duplicate "counts once — but do not write one".
//   NOT case-folded       deliberately. Contract §3.9 is explicit that the reader
//                         trims and does not case-fold, so folding here would
//                         make an operator's edit disagree with every
//                         pipeline-written row.
//   length caps           `reason -> 0` is the Pareto's grouping key and
//                         detail_reason is unbounded text rendered in a drawer.
//                         Neither has a database limit.
const trimmedLabel = z
  .string()
  .transform((value) => value.trim())
  // AFTER the trim, so '   ' fails rather than passing as a three-space label.
  .refine((value) => value.length > 0, "must not be blank")
  .refine((value) => value.length <= 255, "must be at most 255 characters");

// Dedupe preserves FIRST occurrence, which matters: element 0 is the primary
// reason the Pareto groups on, so reordering the array would silently move a stop
// into a different bucket.
const labelList = z
  .array(trimmedLabel)
  .max(20, "at most 20 entries")
  .transform((values) => [...new Set(values)]);

// The post-edit state of the four mutable fields. All four required — see
// DowntimeEdit for why a partial body was rejected.
const downtimeEditSchema = z.object({
  category: z.enum(DOWNTIME_CATEGORIES),
  reason: labelList,
  // NULLABLE AND REQUIRED, which is the pair that makes "the operator cleared
  // this" expressible. `.nullable()` without the field being required would make
  // an absent key mean the same as null, and clearing would be indistinguishable
  // from not touching it.
  detailReason: z
    .string()
    .transform((value) => value.trim())
    // '' collapses to null rather than being stored as an empty string: the
    // column is nullable, the drawer renders an em dash for null, and two
    // representations of "nothing here" is how you get a row that renders as
    // blank instead of absent.
    .transform((value) => (value.length === 0 ? null : value))
    .refine((value) => value === null || value.length <= 2000, "must be at most 2000 characters")
    .nullable(),
  actions: labelList,
});

// The request: the new state, and the state the dialog was showing.
//
// `baseline` is validated by the SAME schema rather than accepted loosely,
// because it is bound into the UPDATE's WHERE clause. A baseline that skipped the
// trim would never match a row whose value was trimmed on the way in, and every
// edit would 412 with no explanation.
const editDowntimeSchema = z.object({
  next: downtimeEditSchema,
  baseline: downtimeEditSchema,
});

const downtimeValidator = {
  timeline: queryValidator(timelineInputSchema),
  // jsonValidator rather than queryValidator, and the FIRST use of it in this
  // service: work-unit-handler.ts records that the approve route is bodyless and
  // could not use it, and that "§21's OTHER half, the downtime edit, is where
  // jsonValidator earns its place". This is that place.
  edit: jsonValidator(editDowntimeSchema),
  list: queryValidator(listDowntimeInputSchema),
  byReason: queryValidator(reasonBreakdownInputSchema),
  byAction: queryValidator(actionBreakdownInputSchema),
  reasonDetail: queryValidator(reasonDetailInputSchema),
  reasonHistory: queryValidator(reasonHistoryInputSchema),
};

type TimelineQueryInput = z.infer<typeof timelineInputSchema>;
type EditDowntimeBody = z.infer<typeof editDowntimeSchema>;
type ListDowntimeQueryInput = z.infer<typeof listDowntimeInputSchema>;
type ReasonBreakdownQueryInput = z.infer<typeof reasonBreakdownInputSchema>;
type ActionBreakdownQueryInput = z.infer<typeof actionBreakdownInputSchema>;
type ReasonDetailQueryInput = z.infer<typeof reasonDetailInputSchema>;
type ReasonHistoryQueryInput = z.infer<typeof reasonHistoryInputSchema>;

export {
  actionBreakdownInputSchema,
  downtimeEditSchema,
  downtimeValidator,
  editDowntimeSchema,
  listDowntimeInputSchema,
  reasonBreakdownInputSchema,
  reasonDetailInputSchema,
  reasonHistoryInputSchema,
  timelineInputSchema,
};
export type {
  ActionBreakdownQueryInput,
  EditDowntimeBody,
  ListDowntimeQueryInput,
  ReasonBreakdownQueryInput,
  ReasonDetailQueryInput,
  ReasonHistoryQueryInput,
  TimelineQueryInput,
};
