// The four figures the SKU View card shows for one product, resolved from a
// ProductCountItem.
//
// This is a module rather than JSX because the pairing below is the one thing in
// the feature that can be silently wrong: a figure rendered against the wrong
// unit of measure looks entirely plausible. There is no DOM test environment in
// this app (see the `test` block in vite.config.ts), so the logic lives here where
// it can be tested as a pure function, and the card only lays out what it returns.
// Same split as lib/waterfall.ts and lib/downtime.ts.
//
//   row: uom=CARTON  base=BAG  factor_to_base=12  (applied server-side already)
//   ┌───────────────┬─────────────────┬───────────────────────────────────┐
//   │ tile          │ field           │ unit label                        │
//   ├───────────────┼─────────────────┼───────────────────────────────────┤
//   │ Total Output  │ totalOut        │ baseUomCode   (BAG)               │
//   │ Finish Good   │ goodOut         │ uomCode    (CARTON)  <- exception │
//   │ Reject        │ reject          │ baseUomCode   (BAG)               │
//   │ Rework        │ rework          │ baseUomCode   (BAG)               │
//   └───────────────┴─────────────────┴───────────────────────────────────┘
//
// Finish Good being the odd one out is a product decision, not an oversight. Its
// consequence — the four figures do not add up on screen once factor_to_base <> 1
// — is stated to the user by the card's tooltip.

// Relative rather than the `@/lib/*` alias its siblings use, and deliberately so:
// `vp test` from the repo root resolves this file without apps/web's vite config,
// so an aliased import here is unresolvable from the workspace test runner. Same
// reason format.ts/format.test.ts pair up relatively.
import { formatQuantity } from "./format";

import type { ProductCountItem } from "./types";

type SkuTile = {
  label: string;
  value: string;
  valueClassName?: string;
};

// Colours come from the semantic token set, never a hardcoded palette class —
// index.css states that rule. `text-oee-planned-downtime` is used for Finish Good
// purely because it is the only blue the design system exposes; it carries no
// downtime meaning here.
const FINISH_GOOD_CLASS = "text-oee-planned-downtime";
const LOSS_CLASS = "text-destructive";

function skuTiles(item: ProductCountItem): SkuTile[] {
  return [
    { label: "Total Output", value: formatQuantity(item.totalOut, item.baseUomCode) },
    {
      label: "Finish Good",
      value: formatQuantity(item.goodOut, item.uomCode),
      valueClassName: FINISH_GOOD_CLASS,
    },
    {
      label: "Reject",
      value: formatQuantity(item.reject, item.baseUomCode),
      valueClassName: LOSS_CLASS,
    },
    {
      label: "Rework",
      value: formatQuantity(item.rework, item.baseUomCode),
      valueClassName: LOSS_CLASS,
    },
  ];
}

export { skuTiles };
export type { SkuTile };
