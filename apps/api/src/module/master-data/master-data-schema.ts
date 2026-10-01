import * as z from "zod";

// Deliberately NARROW schemas: only the fields this service actually reads.
//
// mes-master-data's WorkUnit carries ~12 fields (position, telemetryTags,
// isOeeRelevant, class, timestamps...). Mirroring all of them here would create
// a second copy of someone else's DTO that has to be maintained in lockstep,
// and would reject a response over a purely additive upstream change. Validating
// only what is consumed means additive changes pass and a rename of something we
// depend on fails loudly as a `parse_error` — which is the point.
//
// `z.looseObject` (rather than the default strict-ish object) makes the
// "ignore unknown keys" intent explicit at each level.

const summarySchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  code: z.string(),
  name: z.string(),
});

// The work center rides along on each work unit; upstream serves null when a
// work unit is not assigned to one.
const workUnitWithCenterSchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  code: z.string(),
  name: z.string(),
  workCenter: z.nullable(summarySchema),
});

// Both services speak the same envelope: { data, meta, error }.
// Parameterised because the payload differs per endpoint but the wrapper never does.
function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.looseObject({
    data: z.nullable(data),
    error: z.nullable(z.string()),
  });
}

const workUnitListEnvelopeSchema = envelopeSchema(z.array(workUnitWithCenterSchema));
const workCenterEnvelopeSchema = envelopeSchema(summarySchema);

// Only the fields the page loop needs. `totalPages` bounds the iteration.
const pageMetaSchema = z.looseObject({
  page: z.number(),
  size: z.number(),
  totalElements: z.number(),
  totalPages: z.number(),
});

// A list endpoint's envelope: the same { data, meta, error } wrapper, with the
// payload always an array and `meta` carrying the page counts. Parameterised for
// the same reason `envelopeSchema` is — the item type varies per endpoint, the
// wrapper never does. `meta` stays optional so a caller that ignores paging
// still parses a response that omitted it.
function pagedEnvelopeSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({
    data: z.nullable(z.array(item)),
    meta: z.optional(pageMetaSchema),
    error: z.nullable(z.string()),
  });
}

const pagedWorkUnitListEnvelopeSchema = pagedEnvelopeSchema(workUnitWithCenterSchema);

// Serves BOTH /v1/areas and /v1/work-centers: this service reads the same three
// fields from each, so a second identical schema would only be a second name.
// Split it the day one of them needs a field the other does not.
const pagedSummaryListEnvelopeSchema = pagedEnvelopeSchema(summarySchema);

// The reason catalogue rows, narrowed to what the picker renders. Upstream's
// DowntimeReasonEnrichedList also carries `areas`, `workCenters`, `equipments`,
// `region` and `createdAt`; none of them reach the browser, so none are declared
// — same argument as workUnitWithCenterSchema's header.
//
// `category` IS validated as an enum rather than a plain string, unlike every
// other field here. It is the one value the UI branches on, so an upstream label
// this service does not know about must fail as a `parse_error` rather than
// arrive in the browser and render as a blank badge.
const downtimeReasonSummarySchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  code: z.string(),
  name: z.string(),
  category: z.enum(["PLANNED", "UNPLANNED", "SMALL_STOP"]),
});

// `color` is checked against the same `#rrggbb` pattern upstream enforces on
// write. The column is a varchar(10), so a longer value would have been
// TRUNCATED there rather than rejected — and a truncated hex renders as a
// different colour, silently. Failing here makes that visible.
const downtimeActionSummarySchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  code: z.string(),
  name: z.string(),
  color: z.string().check(z.regex(/^#[0-9a-fA-F]{6}$/)),
});

const pagedDowntimeReasonListEnvelopeSchema = pagedEnvelopeSchema(downtimeReasonSummarySchema);
const pagedDowntimeActionListEnvelopeSchema = pagedEnvelopeSchema(downtimeActionSummarySchema);

// A REJECT reason. The same three fields as a downtime reason and deliberately
// NOT the same schema: there is no `category` here, the two catalogues are
// separate tables upstream, and sharing one schema would make an added field on
// either look like a field on both.
const rejectReasonSummarySchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  code: z.string(),
  name: z.string(),
});

const pagedRejectReasonListEnvelopeSchema = pagedEnvelopeSchema(rejectReasonSummarySchema);

// ONE PACKAGE OF A PRODUCT — a unit the product is counted in, and the factor
// that converts it to the product's base.
//
// `factorToBase` IS THE WHOLE REASON THIS SCHEMA EXISTS, and it is checked
// POSITIVE here rather than trusted. It is a DIVISOR in the entry's generated
// column (migration 0017), so a zero would raise `division by zero` from
// Postgres — an error naming arithmetic rather than the master record that
// caused it — and a negative would silently invert a quantity.
//
// Upstream returns it as a `number` (product-repository casts with Number()), so
// no coercion here: if that ever becomes a string the parse must fail loudly
// rather than coerce, because a string factor multiplies as NaN.
const productPackageSchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  main: z.boolean(),
  sortOrder: z.number().check(z.int()),
  factorToBase: z.number().check(z.positive(), z.lte(1_000_000_000)),
  // NULLABLE upstream, and a package without a unit cannot be offered as one:
  // the entry needs a uom id and code to denominate the quantity. The service
  // drops those rather than failing the whole product.
  uom: z.nullable(
    z.looseObject({
      id: z.number().check(z.int(), z.positive()),
      code: z.string(),
      name: z.string(),
    }),
  ),
});

// GET /v1/products/:id. Narrow, per the note at the top of this file — the
// upstream Product carries area, workCenters, price, cost, idealRatePerHour and
// more, none of which this service reads.
const productDetailSchema = z.looseObject({
  id: z.number().check(z.int(), z.positive()),
  code: z.string(),
  name: z.string(),
  packages: z.array(productPackageSchema),
});

const productDetailEnvelopeSchema = envelopeSchema(productDetailSchema);
const pagedProductListEnvelopeSchema = pagedEnvelopeSchema(summarySchema);

// POST /v1/downtime-actions answers `{ data: { id }, error }` — the id ALONE, not
// the created row. The client re-projects from what it sent plus this id rather
// than issuing a second GET: upstream stores the three fields verbatim, and a
// follow-up read would be a round trip to learn what the caller already knows.
const createdIdEnvelopeSchema = envelopeSchema(
  z.looseObject({ id: z.number().check(z.int(), z.positive()) }),
);

// Postgres does the actual `AT TIME ZONE` arithmetic, so an unknown zone would
// otherwise surface as a query error on the first timeline request. Intl knows
// the same IANA database, which makes this a cheap check at the edge.
//
// This REPLACES the boot-time gate that used to validate PLANT_TIMEZONE: the
// value no longer enters at boot, it enters here. Upstream's `sites.timezone` is
// a plain varchar with no CHECK, so "WIB" or "+07" are writable there.
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Validated HERE rather than in the resolver on purpose: a bad zone becomes an
// ordinary `parse_error` MasterDataError, so it rides the same serve-stale path
// as any other upstream failure instead of reaching Postgres and 500ing.
const siteTimeZoneSchema = z.looseObject({
  siteId: z.number().check(z.int(), z.positive()),
  siteCode: z.string(),
  timezone: z.string().check(z.refine(isValidTimeZone, "not a valid IANA time zone")),
});

const siteTimeZoneEnvelopeSchema = envelopeSchema(siteTimeZoneSchema);

type WorkUnitWithCenterResponse = z.infer<typeof workUnitWithCenterSchema>;

export {
  summarySchema,
  downtimeReasonSummarySchema,
  downtimeActionSummarySchema,
  pagedDowntimeReasonListEnvelopeSchema,
  pagedProductListEnvelopeSchema,
  pagedRejectReasonListEnvelopeSchema,
  productDetailEnvelopeSchema,
  pagedDowntimeActionListEnvelopeSchema,
  createdIdEnvelopeSchema,
  workUnitWithCenterSchema,
  workUnitListEnvelopeSchema,
  workCenterEnvelopeSchema,
  pagedWorkUnitListEnvelopeSchema,
  pageMetaSchema,
  pagedSummaryListEnvelopeSchema,
  isValidTimeZone,
  siteTimeZoneSchema,
  siteTimeZoneEnvelopeSchema,
};
export type { WorkUnitWithCenterResponse };
