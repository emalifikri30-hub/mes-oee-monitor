// One product's output over one report's window, already scaled for display.
//
// SHARED BY BOTH SUBJECTS. It began in work-unit.ts as the shape of a row from
// oee.product_count_wu_shift; the Line report's SKU View reads
// oee.product_count_wc_{shift,day} (migration 0016) and produces the identical
// shape, so it moved here rather than being declared twice or imported across a
// module boundary. Modules never reach into each other's internals — see
// loss-aggregate.ts, which moved for the same reason on the same day.
//
// EVERY MEASURE IS ALREADY SCALED by the repository, so no consumer multiplies
// anything and there is exactly ONE place in the stack where `factor_to_base` is
// applied. Both unit codes ride on every row so one card can mix them without a
// second lookup:
//
//   totalOut, reject, rework  ->  baseUomCode   (scaled by factor_to_base)
//   goodOut                   ->  uomCode       (NOT scaled — Finish Good stays
//                                                in the unit it was counted in)
//
// CONSEQUENCE, ACCEPTED DELIBERATELY: when factor_to_base <> 1 the figures are NOT
// additive on screen — `totalOut <> goodOut + reject`. The SKU card carries a
// tooltip saying so, and apps/web/src/lib/product-count.ts is where the pairing is
// decided and tested.
//
// AT LINE GRAIN NOTHING ABOUT THAT CHANGES, which is why 0016 did not invent an
// infeed/output split the way 0014 had to for the report tables: a product-count
// row already carried two units.
type ProductCountItem = {
  productId: number;
  productName: string;
  productCode: string;
  totalOut: number; // baseUomCode
  goodOut: number; // uomCode
  reject: number; // baseUomCode
  rework: number; // baseUomCode
  uomCode: string;
  baseUomCode: string;
};

export type { ProductCountItem };
