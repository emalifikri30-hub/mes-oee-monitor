import * as z from "zod";

import { jsonValidator, queryValidator } from "@molca/helper";

// The entry form's boundary.
//
// THE SHAPE THE BROWSER SENDS IS NOT THE SHAPE THE ROW TAKES, and the gap is
// deliberate. The client sends what the OPERATOR CHOSE — a product, a package, a
// quantity — and the service resolves the unit arithmetic against the report and
// master data. It never sends `targetQty`, `factorToBase`, `timeZone` or the
// target unit: those are derived, and a client that could send them could send a
// conversion nobody checked. Migration 0017's generated column is the other half
// of the same rule.

const positiveInt = z.number().check(z.int(), z.positive());

// A quantity, not a count. `numeric(15,3)` on the column, so three decimals is
// the floor of what a client may send and anything finer is silently rounded by
// Postgres — better to refuse it here where the operator can see why.
//
// STRICTLY POSITIVE, matching ck_wcqe_qty. Zero is not an entry, and a correction
// is a VOID rather than a negative: a negative would let an operator drive the
// reported reject below what the line measured, which is a different claim from
// "I saw extra". The spec says "Greater than 0" too, so this is the one field
// where the schema, the constraint and the requirement already agree.
const quantity = z
  .number()
  .check(z.positive(), z.lte(9_999_999_999.999))
  .refine((v) => Number.isFinite(v) && Math.round(v * 1000) === v * 1000, {
    message: "at most three decimal places",
  });

// Shift is REQUIRED on every entry, at every grain, because the row is always
// shift-keyed — see quality-entry.ts. What differs per grain is only whether the
// browser can prefill it.
const shift = z.number().check(z.int(), z.gte(1), z.lte(3));

// A plain 'YYYY-MM-DD', never an instant. The entry's business date is a business
// date, so parsing it into a Date and back through a zone is the wrong-day bug
// TODOS §17 records — the same reason lib/format.ts refuses to build a zoned Date
// from one. Validated by SHAPE and then by CALENDAR: `z.iso.date()` alone accepts
// '2026-02-31'.
const businessDate = z.iso.date().refine(
  (v) => {
    const [y, m, d] = v.split("-").map(Number);
    const probe = new Date(Date.UTC(y!, m! - 1, d!));
    return (
      probe.getUTCFullYear() === y && probe.getUTCMonth() === m! - 1 && probe.getUTCDate() === d
    );
  },
  { message: "not a real calendar date" },
);

// ---------------------------------------------------------------------------
// THE ASYMMETRY BETWEEN REJECT AND REWORK LIVES HERE, NOT IN THE SCHEMA
// ---------------------------------------------------------------------------
//
// The requirement puts a Machine field on Reject and not on Rework, and does not
// say why. It may be that rework happens off-line, at a rework station rather
// than at a machine; it may be an oversight.
//
// So migration 0017 makes `work_unit_id` NULLABLE FOR BOTH and this file carries
// the policy. If the answer turns out to be "rework has a machine too", that is a
// change to the two lines below — not a migration against a table that by then
// holds signed operator entries.
//
// The reverse arrangement (a CHECK tying work_unit_id to kind) would have been
// tidier-looking and much worse: it would encode an unexplained product decision
// as a database invariant, and unwinding it later means an ALTER on a live audit
// table.
const rejectBody = z.object({
  kind: z.literal("reject"),
  // REQUIRED for a reject, per the spec: "User must pick one of machine of the
  // line". Provenance only — 0017's column comment says at length that it does
  // not move the machine's own report.
  workUnitId: positiveInt,
  // REQUIRED for a reject: "User must pick one of reject reason from master data
  // that filtered by work center". Scoped upstream by the filter added to
  // mes-master-data for exactly this picker.
  reasonId: positiveInt,
});

const reworkBody = z.object({
  kind: z.literal("rework"),
  // ABSENT, per the spec — see the note above. `z.optional` rather than omitted
  // so a client that sends one gets a 400 naming the field, instead of the value
  // being silently dropped and the entry looking machine-less in the trail.
  workUnitId: z.optional(z.never()),
  // PRESENT, and the spec is explicit that it is the same catalogue: "User must
  // pick one of rework reason (reject reason) from master data".
  reasonId: positiveInt,
});

// Everything both kinds carry.
const commonBody = z.object({
  // THE SKU. Required, because it is the CONVERSION BASIS as well as an
  // attribution: there is no global uom-to-uom table in this system, only
  // per-product packages, so the product is what authorises the ratio. 0017's
  // ck_wcqe_basis enforces the weaker version of this (a product is needed
  // whenever the units differ); the API requires it always.
  //
  // STILL REQUIRED ON A SKU REPORT, where the screen does NOT ask — the dialog
  // shows the report's product as a fixed, read-only field and sends it. It is not
  // optional-and-defaulted the way `businessDate` is, and the difference is worth
  // keeping: a business date has exactly one possible value and means nothing
  // else, where a conversion basis that was inferred rather than named is the
  // thing ck_wcqe_basis exists to make explicit. The service refuses a value that
  // disagrees with the report — see resolveProductId — rather than accepting an
  // absence and filling it in.
  //
  // The consequence worth knowing is that every row this service writes carries a
  // product, so a per-SKU ledger read loses nothing and the per-SKU totals
  // reconcile to the line's. TODOS.md §65 worried about the opposite; this is why
  // it cannot happen through this app.
  productId: positiveInt,

  // THE PACKAGE, not a bare uom id. This is the field the requirement described
  // as "one of uom from master data (global)", and the correction matters: there
  // is no global conversion, so a bare uom id would name a unit with no factor to
  // convert it by. `GET /products/:id` returns `packages[]`, each a (uom, factor)
  // pair, and the operator picks one of THOSE — which is what makes "the convert
  // ratio is from master data" true rather than aspirational.
  //
  // The service re-resolves the package server-side and uses the factor IT reads,
  // never one the client sends.
  //
  // OPTIONAL, and the absence is a real case rather than laziness. A line can run
  // a SKU that master data has not linked to it — `product_work_centers` is a
  // separate assignment upstream — and the dialog's picker offers what actually
  // RAN, so it can legitimately name a product with no package list to pick from.
  // The unit is then the line's own, the conversion is the identity, and the
  // service resolves both from the report row. See resolveConversion.
  packageId: z.optional(positiveInt),

  quantity,
  shift,
  // Supplied at month grain, where the report spans ~30 days and the shift alone
  // does not identify one. Optional here and defaulted by the SERVICE from the
  // report's own window — a client that omits it on a shift or day report gets
  // the right date rather than a 400 about a field its screen never showed.
  businessDate: z.optional(businessDate),

  note: z.optional(z.string().check(z.maxLength(2000))),

  // IDEMPOTENCY, and the one field the browser must generate. Without it a
  // double-submitted form is two live rows and a doubled figure with nothing
  // anywhere to notice — 0017's ux_wcqe_request turns the retry into a no-op, but
  // only if the retry carries the same id. Required rather than defaulted: a
  // server-generated one would be different on every attempt and guard nothing.
  requestId: z.uuid(),
});

// Discriminated on `kind`, so the two field sets cannot be mixed — a body naming
// both a machine and `kind: "rework"` is refused rather than quietly accepted
// with one half ignored.
const createQualityEntrySchema = z.intersection(
  commonBody,
  z.discriminatedUnion("kind", [rejectBody, reworkBody]),
);

// A void names WHY, optionally. Who and when come off the token and the clock —
// a client that could send either could forge an audit row.
const voidQualityEntrySchema = z.object({
  reason: z.optional(z.string().check(z.maxLength(2000))),
});

// The ledger read. `includeVoided` defaults FALSE so the common read is the live
// set — the figures the card shows — and the sheet asks for the trail explicitly.
const listQualityEntrySchema = z.object({
  includeVoided: z.pipe(
    z.optional(z.string()),
    z.transform((v) => v === "true"),
  ),
});

type CreateQualityEntryInput = z.infer<typeof createQualityEntrySchema>;
type VoidQualityEntryInput = z.infer<typeof voidQualityEntrySchema>;
type ListQualityEntryInput = z.infer<typeof listQualityEntrySchema>;

const qualityEntryValidator = {
  create: jsonValidator(createQualityEntrySchema),
  void: jsonValidator(voidQualityEntrySchema),
  list: queryValidator(listQualityEntrySchema),
};

export {
  createQualityEntrySchema,
  listQualityEntrySchema,
  qualityEntryValidator,
  voidQualityEntrySchema,
};
export type { CreateQualityEntryInput, ListQualityEntryInput, VoidQualityEntryInput };
