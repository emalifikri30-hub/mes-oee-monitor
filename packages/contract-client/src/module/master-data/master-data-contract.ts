import type {
  AreaSummary,
  CreateDowntimeActionInput,
  DowntimeActionSummary,
  DowntimeReasonSummary,
  ProductDetail,
  RejectReasonSummary,
  SiteTimeZone,
  TimeZoneScope,
  WorkCenterSummary,
  WorkUnitPartialFetch,
  WorkUnitWithCenter,
} from "./master-data-dto.js";

// The port for reading master data owned by the mes-master-data service.
//
// This interface IS the transport boundary: an HTTP implementation and a future
// gRPC one both just `implements` it, so swapping transports touches no caller.
type MasterDataClientContract = {
  // Distinguishes "this work center has no work units" from "this work center
  // does not exist". The two are indistinguishable after
  // findAllWorkUnitByWorkCenterId returns an empty list, but one is a valid
  // empty report and the other is a 404.
  existsWorkCenter(workCenterId: number): Promise<boolean>;

  // The line's machine roster: whole rows, not bare ids.
  //
  // IT RETURNED `{ id }[]` UNTIL THE OEE PERFORMANCE DASHBOARD needed a machine
  // picker with labels on it. Widening it cost nothing — the response was already
  // parsed as a full work unit and the name and code discarded — and the
  // alternative was a second method with a second copy of the page loop and its
  // truncation warning. Callers that only want ids map them; the two shapes are
  // served from ONE cache entry, so this added no upstream traffic.
  findAllWorkUnitByWorkCenterId(workCenterId: number): Promise<WorkUnitWithCenter[]>;

  // Bulk label lookup for a page of report rows. Each work unit arrives with its
  // work center attached — see WorkUnitWithCenter for why this is not two calls.
  findAllWorkUnitByWorkUnitIds(
    workUnitIds: number[],
  ): Promise<WorkUnitPartialFetch<WorkUnitWithCenter>>;

  findAllArea(): Promise<AreaSummary[]>;
  findAllWorkCenterByAreaId(areaId: number): Promise<WorkCenterSummary[]>;

  // The reason catalogue for ONE line.
  //
  // SCOPED, and the parameter is required for the same reason
  // findAllWorkCenterByAreaId's is: upstream treats a missing filter as "no
  // filter" and answers with the whole region, so an optional parameter here
  // would turn a line-scoped picker into a catalogue dump the first time a
  // caller forgot it. A stop already belongs to a known line, so there is no
  // caller that legitimately wants the unscoped list.
  findAllDowntimeReasonByWorkCenterId(workCenterId: number): Promise<DowntimeReasonSummary[]>;

  // The REJECT reason catalogue for one line, which the quality-entry dialog
  // uses for both its Reject and its Rework picker — the requirement is explicit
  // that they are the same catalogue.
  //
  // SCOPED, and required, for the reason the downtime one gives. Upstream gained
  // this filter for this caller; before that it answered with the whole region,
  // and the reason is what the Quality Pareto groups a reject under.
  findAllRejectReasonByWorkCenterId(workCenterId: number): Promise<RejectReasonSummary[]>;

  // The products assigned to one line — the quality-entry dialog's SKU picker.
  //
  // FROM MASTER DATA RATHER THAN FROM SKU View, deliberately. SKU View reads
  // oee.product_count_wc_*, which is a MEASUREMENT of what ran and currently
  // ships empty; a picklist is a CATALOGUE question, so answering it from what
  // the line is set up to run teaches none of the false invariants a rolled-up
  // figure would, and does not block the feature on the pipeline.
  findAllProductByWorkCenterId(workCenterId: number): Promise<AreaSummary[]>;

  // One product WITH its packages — the conversion basis. See
  // ProductPackageSummary: this is the only conversion this system has.
  findProductById(productId: number): Promise<ProductDetail | undefined>;

  // The action catalogue, which is regional — see DowntimeActionSummary for why
  // there is no scope to pass.
  findAllDowntimeAction(): Promise<DowntimeActionSummary[]>;

  // Appends to that catalogue. The one write on this port; see
  // CreateDowntimeActionInput.
  //
  // Returns the created row rather than an id, because the caller needs the NAME
  // back: it is what gets written into the downtime's `actions[]`, and upstream
  // is entitled to have stored something other than what was sent.
  createDowntimeAction(input: CreateDowntimeActionInput): Promise<DowntimeActionSummary>;

  // Walks the hierarchy up to the site that owns `id` and returns its time zone.
  //
  // ONE method taking a scope rather than one per level: the sole caller already
  // holds the scope as a variable (a downtime request is scoped to a work unit or
  // a work center), so splitting it would only push a switch to the call site.
  //
  // Upstream resolves the whole chain server-side. Doing it here would mean four
  // sequential round trips against endpoints that each expose one link.
  findTimeZoneByScope(scope: TimeZoneScope, id: number): Promise<SiteTimeZone>;
};

export type { MasterDataClientContract };
