// Ids are numbers: mes-master-data uses `serial` primary keys and serves them as
// JSON numbers, and the OEE report rows key off a numeric `work_unit_id`.

type WorkCenterSummary = {
  id: number;
  code: string;
  name: string;
};

type WorkUnitSummary = {
  id: number;
  code: string;
  name: string;
};

type AreaSummary = {
  id: number;
  code: string;
  name: string;
};

// A work unit together with the work center it belongs to.
//
// These travel as one object rather than two lookups because the association is
// what the caller actually needs: given a report row's `workUnitId`, resolve
// BOTH labels. A flat `WorkCenterSummary[]` cannot answer that — it carries no
// `workUnitId`, so a page spanning two work centers is unresolvable. Upstream
// already embeds the work center in its work-unit payload, so this also costs
// one request instead of two.
type WorkUnitWithCenter = WorkUnitSummary & {
  workCenter: WorkCenterSummary | null;
};

// `missingIds` are the requested ids upstream had no record of. Callers get a
// partial result rather than an error: a report row pointing at a deleted work
// unit should still render its metrics.
type WorkUnitPartialFetch<T> = {
  found: T[];
  missingIds: number[];
};

// A downtime reason from mes-master-data's catalogue, as offered to an operator
// picking one in the downtime edit dialog.
//
// `category` rides along because the dialog already has a Category select beside
// the reason picker, and showing the catalogue's own category next to each option
// is what stops an operator filing a PLANNED reason under UNPLANNED. It is a
// HINT, not a constraint — this service does not force the two to agree, because
// upstream's category is the reason's default and the stop's is the operator's
// judgement about this particular stop.
//
// The enum is upstream's `ms_downtime.downtime_cat`. It happens to match this
// service's own DowntimeCategory exactly; they are kept as separate types anyway,
// because one is a transcription of someone else's schema and the other is this
// service's contract with its own browser.
type DowntimeReasonCategory = "PLANNED" | "UNPLANNED" | "SMALL_STOP";

type DowntimeReasonSummary = {
  id: number;
  code: string;
  name: string;
  category: DowntimeReasonCategory;
};

// A REJECT reason from ms_reject.reject_reasons, scoped to one line.
//
// SEPARATE FROM DowntimeReasonSummary and not an alias of it, even though the
// three fields match today. They are different tables upstream with different
// junction sets, and the downtime one carries a `category` this one has no
// equivalent for — aliasing them would make a field added to either look like a
// field on both.
//
// THE SAME CATALOGUE SERVES REWORK. The requirement is explicit that a rework
// reason IS a reject reason, so there is one read and one picker.
type RejectReasonSummary = {
  id: number;
  code: string;
  name: string;
};

// One unit a product is counted in, with the factor that converts it to that
// product's base unit.
//
// THIS IS THE ONLY CONVERSION THIS SYSTEM HAS. There is no global uom-to-uom
// table anywhere — conversion is per product, through this list — which is why
// the quality-entry dialog's unit picker CASCADES from its SKU picker rather than
// offering a global unit list. Several packages share one base, so any two of
// them convert through it: qty * from.factorToBase / to.factorToBase.
//
// `uom` is nullable upstream. A package without one cannot denominate a
// quantity, so callers drop it rather than failing the product.
type ProductPackageSummary = {
  id: number;
  main: boolean;
  sortOrder: number;
  factorToBase: number;
  uom: { id: number; code: string; name: string } | null;
};

// A product with its packages. The detail read, because the LIST does not carry
// packages and the factor is the point.
type ProductDetail = {
  id: number;
  code: string;
  name: string;
  packages: ProductPackageSummary[];
};

// A downtime action from mes-master-data's catalogue.
//
// NO category and no scope, unlike a reason: `ms_downtime.downtime_actions` has
// no junction tables at all, so the catalogue is regional and the same list is
// offered whichever line the stop is on. `color` is a `#rrggbb` string upstream
// validates, carried so a chip can be tinted without a second lookup.
type DowntimeActionSummary = {
  id: number;
  code: string;
  name: string;
  color: string;
};

// The body for creating an action upstream.
//
// THE ONLY WRITE THIS PORT MAKES, and it is deliberately narrow: an operator who
// needs an action the catalogue does not have should not have to leave the
// downtime dialog, open the master-data app and come back. Reasons have no
// equivalent — the reason catalogue is curated per line, and letting a stop
// invent one would put a bar on the Pareto that nobody owns.
type CreateDowntimeActionInput = {
  code: string;
  name: string;
  color: string;
};

// The levels a time zone can be resolved from. Upstream owns the hierarchy
// (work unit -> work center -> area -> site).
//
// TWO OF THESE THREE ARE UPSTREAM ENTRY POINTS AND ONE IS NOT, and the asymmetry
// is worth knowing before adding a fourth. mes-master-data serves
// `/v1/work-units/:id/timezone` and `/v1/work-centers/:id/timezone`, each a single
// lateral-join walk up to `sites.timezone`. It serves NO area endpoint, even
// though its own walk passes through `area` on the way — so `"area"` here is
// resolved by the CLIENT, in two hops, through one of the area's work centers.
//
// That is sound rather than merely expedient: a work center belongs to exactly
// one area and therefore one site, so every line in an area resolves to the same
// zone and picking any member cannot be wrong. It is still two round trips where
// one would do, which is why TODOS.md carries the ask for
// `/v1/areas/:id/timezone`. When that lands, the client's area arm collapses to
// the same one-hop shape as the other two and nothing else changes.
type TimeZoneScope = "work-unit" | "work-center" | "area";

// The site a piece of the hierarchy belongs to, and the zone it runs in.
//
// `timezone` keeps upstream's lowercase spelling, mirroring the column and the
// wire, exactly as WorkUnitWithCenter mirrors upstream's payload. The camelCase
// boundary belongs to this service's OWN contract (ShiftTimeline.timeZone), not
// to a transcription of someone else's.
//
// `siteId`/`siteCode` ride along because a wrong zone is otherwise unattributable:
// they are what a log line needs to say WHICH site was consulted.
type SiteTimeZone = {
  siteId: number;
  siteCode: string;
  timezone: string;
};

export type {
  AreaSummary,
  CreateDowntimeActionInput,
  DowntimeActionSummary,
  DowntimeReasonCategory,
  DowntimeReasonSummary,
  ProductDetail,
  ProductPackageSummary,
  RejectReasonSummary,
  SiteTimeZone,
  TimeZoneScope,
  WorkCenterSummary,
  WorkUnitPartialFetch,
  WorkUnitSummary,
  WorkUnitWithCenter,
};
