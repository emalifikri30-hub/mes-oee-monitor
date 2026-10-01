import { describe, it, expect } from "vite-plus/test";

import { skuTiles } from "./product-count";

import type { ProductCountItem } from "./types";

// The reference design's row: one SKU whose production unit already IS its base
// unit, so factor_to_base is 1 and every figure reads the same either way. This is
// the case that cannot tell a right implementation from a wrong one, which is
// exactly why the second fixture below exists.
const SAME_UNIT: ProductCountItem = {
  productId: 4,
  productName: "SKU Line 4",
  productCode: "SKU-4",
  totalOut: 854_648,
  goodOut: 786_552,
  reject: 68_096,
  rework: 0,
  uomCode: "BAG",
  baseUomCode: "BAG",
};

// A SKU counted in cartons of 12 bags. core-api has already multiplied totalOut,
// reject and rework by factor_to_base; goodOut is still in cartons. Nothing here
// does arithmetic — the point is which UNIT each figure is labelled with.
const CONVERTED: ProductCountItem = {
  productId: 9,
  productName: "SKU Line 9",
  productCode: "SKU-9",
  totalOut: 12_000, // 1000 cartons x 12
  goodOut: 920, // cartons, unconverted
  reject: 960, // 80 cartons x 12
  rework: 120, // 10 cartons x 12
  uomCode: "CARTON",
  baseUomCode: "BAG",
};

function tile(item: ProductCountItem, label: string) {
  const found = skuTiles(item).find((t) => t.label === label);
  expect(found).toBeDefined();
  return found!;
}

describe("skuTiles", () => {
  it("returns the design's four tiles in order", () => {
    expect(skuTiles(SAME_UNIT).map((t) => t.label)).toEqual([
      "Total Output",
      "Finish Good",
      "Reject",
      "Rework",
    ]);
  });

  it("renders the reference row as the design shows it", () => {
    expect(skuTiles(SAME_UNIT).map((t) => t.value)).toEqual([
      "854648 BAG",
      "786552 BAG",
      "68096 BAG",
      "0 BAG",
    ]);
  });

  // The assertion the whole module exists for. Three tiles carry the base unit and
  // one carries the production unit; getting the pairing wrong produces figures
  // that look completely reasonable.
  it("labels Total Output, Reject and Rework with the base unit", () => {
    expect(tile(CONVERTED, "Total Output").value).toBe("12000 BAG");
    expect(tile(CONVERTED, "Reject").value).toBe("960 BAG");
    expect(tile(CONVERTED, "Rework").value).toBe("120 BAG");
  });

  it("labels Finish Good with the production unit, not the base unit", () => {
    expect(tile(CONVERTED, "Finish Good").value).toBe("920 CARTON");
    expect(tile(CONVERTED, "Finish Good").value).not.toContain("BAG");
  });

  // Reject and rework are the bad numbers and share one accent; Finish Good gets
  // its own; Total Output stays on the default foreground.
  it("accents the loss figures and leaves the total unstyled", () => {
    expect(tile(SAME_UNIT, "Total Output").valueClassName).toBeUndefined();
    expect(tile(SAME_UNIT, "Finish Good").valueClassName).toBe("text-oee-planned-downtime");
    expect(tile(SAME_UNIT, "Reject").valueClassName).toBe("text-destructive");
    expect(tile(SAME_UNIT, "Rework").valueClassName).toBe("text-destructive");
  });

  // A zero is a real measurement, not missing data — it must not fall through to
  // formatQuantity's em-dash.
  it("renders a zero as a zero", () => {
    expect(tile(SAME_UNIT, "Rework").value).toBe("0 BAG");
  });
});
