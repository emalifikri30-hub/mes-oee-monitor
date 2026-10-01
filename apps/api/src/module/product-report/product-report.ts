import type { ReportWindow } from "../../shared/report-window.js";
import type { DowntimeEventAggregate, RejectAggregate } from "../../shared/loss-aggregate.js";

// THE SKU GRAIN: one SKU, on one line, on one business day.
//
// DAY ONLY, AND THERE IS NO GRAIN PARAMETER ANYWHERE IN THIS MODULE. The
// work-unit and work-center modules loop over three grains and carry
// `grainFrom` / `grainShift` / `shiftFilter` to keep one implementation behind
// three prefixes. There is one table here, so that machinery would be dead code
// wearing the shape of a decision. If a shift or month grain ever lands, add the
// loop then — copying it in empty now would make the next reader look for the
// other two tables.
//
// `subject` IS NOT ON THIS PAYLOAD. The browser stamps it in lib/api.ts, which is
// the one place that knows which endpoint answered — see ShiftReportDetail.subject
// on the web side. Sending it would be telling the caller something it already
// knew from the URL it typed.

// The list row. A deliberate subset of the detail payload: four rates and the
// identity, because a table renders nothing else and a list query that selected
// forty measures would page slower for no reader.
type ProductReportListRow = {
  id: number;
  businessDate: string;
  timeZone: string;
  workCenterId: number;
  workCenterName: string;
  // NULLABLE, and the SKU screens render it BESIDE the name rather than instead
  // of it. work_center_name is not unique — the dev world has carried two lines
  // called 'Line 1' for months (TODOS.md §77) — and a report whose entire point
  // is WHICH LINE cannot identify one by a name that repeats.
  workCenterCode: string | null;
  productId: number;
  productName: string;
  productCode: string;
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// The detail payload. oee.product_report_wc_day, one row, every measure.
//
// NO `teep` AND NO `workUnitCount`, and both absences are the table's (0023).
// TEEP divides by calendar time, which a SKU does not own — the line does, and
// shares it with every other SKU that ran that day. A SKU ran on ONE line, so
// there is no member count to report.
type ProductReport = {
  id: number;
  // Stamped by the query, not stored. There is one grain, so this is a constant —
  // it exists because the browser's report union discriminates on it and a
  // payload without it would need a second stamping site.
  grain: "day";
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
  // and its counts are null with it.
  infeedUomId: number | null;
  infeedUomName: string | null;
  infeedUomCode: string | null;
  outputUomId: number | null;
  outputUomName: string | null;
  outputUomCode: string | null;

  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;

  // Infeed side.
  totalOut: number | null;
  reject: number | null;
  rework: number | null;
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

  mttr: number | null;
  mtbf: number | null;
};

// The window a SKU report covers, plus the one thing that makes it a SKU's.
//
// `productId` RIDES WITH THE WINDOW rather than being passed beside it, so no
// reader can scope by line and forget the product — which would return the whole
// line's rows under a SKU heading, every number plausible and every one wrong.
type ProductWindow = ReportWindow & { productId: number };

type ProductReportFilter = {
  month: number | undefined;
  year: number | undefined;
  workCenterId: number | undefined;
  // The header area picker. A denormalised label `0023` put on this table, so a
  // row the pipeline has not attributed appears on no screen — see
  // shared/area-scope.ts.
  areaId: number | undefined;
  productId: number | undefined;
  isHideZero: boolean;
};

type ListProductReportInput = {
  limit: number;
  offset: number;
  filter: ProductReportFilter;
};

type PagedProductReport = {
  items: ProductReportListRow[];
  totalElements: number;
};

// THE UNATTRIBUTED COUNT IS PART OF EVERY DOWNTIME ANSWER, not a separate lookup.
//
// oee.downtime_reports.product_id is NULLABLE and NULL means NOT ATTRIBUTED —
// never "no product ran" (migration 0020). A SKU-scoped read filters
// `product_id = $`, so those rows are silently excluded: with the column
// unwritten, a SKU report reads Availability 100% with an empty downtime table.
// That is a plausible screen, not an error, which is why the count travels WITH
// the buckets instead of being something a caller may forget to ask for.
type UnattributedDowntime = {
  // Stops in this window, on this line, with no SKU attributed. Zero once the
  // pipeline writes the column; the screen says nothing when it is zero.
  unattributed: number;
};

type ProductRejectBreakdown = RejectAggregate & {
  timeZone: string;
  loadedThrough: string | null;
};

type ProductDowntimeEventBreakdown = DowntimeEventAggregate &
  UnattributedDowntime & {
    timeZone: string;
    loadedThrough: string | null;
  };

// ---------------------------------------------------------------------------
// The SKU day report's Log Activity panel
// ---------------------------------------------------------------------------
//
// A THIRD DECLARATION, not an import from work-unit.ts or work-center.ts. What the
// three feeds share is a WIRE SHAPE, not a type — the call work-center.ts already
// made and stated ("modules never reach into each other's internals here"). The
// shapes genuinely differ, and the difference below is the interesting part.
//
// TWO ENTRY KINDS, AND THE MISSING THIRD IS THE POINT. There is no `approval` arm
// in the union at all, so an approval entry cannot be CONSTRUCTED here:
// oee.work_unit_shift_report_approval_events is keyed (work_unit_id, date, shift),
// and this grain has neither a work unit nor a shift. TODOS.md §65 left "decide
// what a SKU feed contains" open; this is the answer, and it is two arms.
//
// `sources` STILL HAS THREE ENTRIES, and the asymmetry with the union above is
// deliberate rather than an oversight. The panel's whole purpose is to separate
// "nothing was recorded" from "nothing COULD be recorded", so an arm that can
// never carry a row still has to SAY so — it just says it as a source and never as
// an entry. `not-applicable` is the reason (see UntrackedReason), and it is a
// fourth value rather than a reuse of `no-source`, whose sentence is about reject
// and rework figures and would be a visible mislabel over the word "Approvals".
type ProductActivityKind = "downtime" | "quality";

// The SAME wire vocabulary work-unit.ts's UntrackedReason uses — the browser's
// NOT_TRACKED_BODY is a TOTAL map over these values, so an invented one renders a
// blank sentence. There are three declarations of this list now (here, work-unit,
// work-center); a value added to one must be added to the browser's or a reader
// gets an empty box.
type ProductUntrackedReason = "no-source" | "no-stable-id" | "not-implemented" | "not-applicable";

type ProductActivitySource = {
  kind: "approval" | ProductActivityKind;
  tracked: boolean;
  untrackedReason: ProductUntrackedReason | null;
  totalMembers: number;
  trackedMembers: number;
};

type ProductActivityEntry =
  | {
      kind: "downtime";
      id: string;
      at: Date;
      by: string;
      sourceEventId: string;
      field: string;
      oldValue: unknown;
      newValue: unknown;
      // WHICH MACHINE the stop was on. A stop is an event in time on a machine,
      // and a machine's stop genuinely is a stop on the line — so this is the
      // fact that disambiguates two edits in this feed.
      workUnitId: number;
      workUnitName: string | null;
    }
  | {
      kind: "quality";
      id: string;
      at: Date;
      by: string;
      byName: string | null;
      // WHICH SHIFT the entry was recorded against, and it is REQUIRED here where
      // the line's feed does not carry it at all. A line SHIFT feed spans one
      // shift and N machines, so it labels an entry with the machine; a SKU DAY
      // feed spans three shifts, and a REWORK carries no work_unit_id — so
      // without this, half the entries would have no disambiguator and three
      // entries would read as three entries about the same thing.
      shift: number;
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

// THE UNATTRIBUTED RESIDUAL RIDES WITH THE FEED, exactly as it rides with
// /downtime-events and for the same reason: the downtime arm is narrowed by
// `product_id = $`, which is FALSE for NULL rather than unknown-but-included, so
// every stop the pipeline has not attributed is silently absent. Without this
// number an empty panel means either "nobody edited anything" or "no stop on this
// line belongs to any SKU", and those are not the same claim.
type ProductActivity = UnattributedDowntime & {
  timeZone: string;
  entries: ProductActivityEntry[];
  // Always length 3 — see ProductActivityKind.
  sources: ProductActivitySource[];
};

// The reject dialog's Machine picker, and NOTHING ELSE.
//
// A ROSTER, NOT A BREAKDOWN, and the distinction is why this exists rather than
// reusing /work-centers/{grain}-reports/:id/machines. That endpoint returns a
// per-machine measures breakdown keyed by a MACHINE REPORT ID — and it is
// addressed by a LINE report id, which a SKU screen does not have. Seven report
// tables, seven independent identity sequences: passing a SKU id there resolves a
// real machine report about another machine on another date.
//
// WHY THE PICKER NEEDS IT AT ALL: createQualityEntrySchema requires `workUnitId`
// for a reject — provenance, which machine the operator saw them on — and nothing
// else in the browser can list a line's machines.
//
// NO reportId FIELD, deliberately. This list feeds a form, and a machine report's
// id has no business in one; leaving it out is what stops a future caller
// interpolating it into a route.
type ProductMachineRoster = {
  machines: { workUnitId: number; workUnitName: string | null }[];
};

export type {
  ListProductReportInput,
  PagedProductReport,
  ProductActivity,
  ProductActivityEntry,
  ProductActivitySource,
  ProductMachineRoster,
  ProductDowntimeEventBreakdown,
  ProductRejectBreakdown,
  ProductReport,
  ProductReportFilter,
  ProductReportListRow,
  ProductWindow,
  UnattributedDowntime,
};
