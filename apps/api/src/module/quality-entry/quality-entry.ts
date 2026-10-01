// Operator-entered reject and rework at LINE grain.
//
// ITS OWN MODULE RATHER THAN A work-center SUB-RESOURCE, even though every route
// hangs off a work-center report id. The rule `src/shared/README.md` states is
// about ownership: this slice owns a Gold table (`oee.work_center_quality_entries`,
// migration 0017), its own validators and the only WRITE in this service that
// creates a row rather than changing one. work-center owns the three report
// tables' reads and a writer that touches none of them.
//
// ---------------------------------------------------------------------------
// THE ONE GRAIN
// ---------------------------------------------------------------------------
//
// An entry is ALWAYS a shift-grain fact, whichever screen produced it. The form is
// offered on FOUR screens across TWO subjects — all three Line reports and the SKU
// day report — and every one of them produces the same row:
//
//   line shift   knows the date and the shift; the dialog prefills both.
//   line day     knows the date, asks for the shift.
//   line month   asks for both, bounded to the month.
//   SKU day      knows the date AND the product, asks for the shift. The product
//                is the extra key part this subject supplies, and the service
//                refuses a client that names a different one — resolveProductId.
//
// That is what lets contract §18 be ONE dbt join at shift grain: §16.3 already
// guarantees "a line's day is the sum of its own line-shifts, and a month the sum
// of its days", so day and month inherit the entry through the roll-up the
// pipeline already performs. A coarser-grained entry could not be attributed to a
// shift, and §16.8's error-severity test would fire on the disagreement.
//
// THE SKU SCREEN CHANGES NOTHING ABOUT THAT, and it is worth being explicit: a
// per-SKU entry is not a per-SKU ROW. It is the same (line, business_date, shift)
// row with `product_id` filled in — a column §18's join does not read and does not
// need to, since the SKU is a property of what was entered rather than of where it
// lands. A SKU-grain entry table would be a second thing to roll up and a second
// chance to disagree with the shifts beneath it.

// What the operator picked, before any unit arithmetic.
//
// `kind` discriminates but does not change the shape: the two differ only in
// whether a machine is named, and that is a POLICY in the dto rather than a
// constraint in the schema — see quality-entry-dto.ts.
type QualityEntryKind = "reject" | "rework";

// Whether the API could compare the entry's target unit against the report row
// when it was written.
//
//   verified    the shift report existed, its infeed unit was known, and it
//               matched.
//   unverified  there was no shift report row yet, or its infeed unit was NULL
//               ("the members disagreed", 0014). Legitimate and common — a
//               month-grain entry for a date the pipeline has not reached.
//
// Recorded rather than enforced because refusing the second case would make
// backfill and month-grain entry unusable, and because "we could not check" and
// "we checked and it was fine" are different claims. Contract §18 gives the join
// the last word either way.
type QualityUnitCheck = "verified" | "unverified";

// One row of the ledger, as the browser reads it.
//
// BOTH QUANTITIES TRAVEL. `enteredQty` in `enteredUomCode` is what the operator
// typed and is what they will recognise; `targetQty` in `targetUomCode` is what
// the report will move by. Showing only the second makes an operator who typed 10
// cartons unable to find their own entry in a list of BAG figures; showing only
// the first makes the ledger not add up to anything.
type QualityEntry = {
  id: number;
  kind: QualityEntryKind;

  workCenterId: number;
  businessDate: string;
  shift: number;
  timeZone: string;

  // Provenance only — see 0017. Never moves the machine's own report.
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

  unitCheck: QualityUnitCheck;

  enteredAt: string;
  enteredBy: string;
  enteredByName: string | null;

  voidedAt: string | null;
  voidedBy: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  supersedesId: number | null;
};

// GET .../quality-entries.
//
// THE TOTALS ARE PER KIND AND PER UNIT, and the unit half is not decoration. A
// ledger that summed BAG and CARTON into one figure would be the "500 + 12 = 512
// <blank>" §16.4 refuses. In practice every live entry on one report shares a
// unit — they all target the line's infeed unit — so a second bucket appearing
// here means the line's unit CHANGED between two entries, which the screen should
// show rather than hide.
type QualityEntryTotal = {
  kind: QualityEntryKind;
  uomCode: string;
  qty: number;
  entries: number;
};

type QualityEntryList = {
  items: QualityEntry[];
  // Live totals only — voided rows are in `items` (they are the trail) and out of
  // these figures (they contribute to no report). The same split contract §18's
  // aggregate makes with `voided_at IS NULL`.
  totals: QualityEntryTotal[];
  // The line's infeed unit as it stands NOW, so the card can say what an entry
  // would land in — and so it can warn when a live entry no longer matches it,
  // which is the state the dbt join will silently exclude. Null means the line
  // report says its members disagreed.
  targetUomCode: string | null;
};

// The address an entry attaches to, resolved from a report id plus whatever the
// coarse grains had to ask for. Always a shift.
type QualityEntryTarget = {
  workCenterId: number;
  businessDate: string;
  shift: number;
  timeZone: string;
  // The report row's infeed unit, or null when it disagreed or there is no row
  // yet. Drives `unitCheck` and the API's refusal.
  infeedUomId: number | null;
  infeedUomCode: string | null;
};

export type {
  QualityEntry,
  QualityEntryKind,
  QualityEntryList,
  QualityEntryTarget,
  QualityEntryTotal,
  QualityUnitCheck,
};
