import { EM_DASH, formatDuration, formatQuantity } from "@/lib/format";

import type { QualityMeasure } from "@/lib/quality-pareto";

// What the Quality Loss tab is CALLED, how it READS, and how each of its four
// measures is FORMATTED — in one place.
//
// A PLAIN OBJECT, not a Record keyed by a discriminant like LOSS_CATEGORY_COPY.
// Quality Loss is one tab, and it cannot be an entry in that record even in
// principle: that one is keyed by DowntimeCategory, which lib/types.ts pins to
// oee.operation_type, and a reject counter is not a downtime category. What
// transfers from loss-category.ts is the ARGUMENT for the module rather than its
// shape — the words live beside the thing they describe, so no call site can hand
// this tab another tab's sentences, and the drift a props-threaded version would
// allow is silent because every string is plausible in the wrong tab.

const QUALITY_LOSS_COPY = {
  // The Losses-card tile this breakdown will be read against, and therefore the
  // figure the footnote has to name. This one carries more weight than its
  // downtime equivalents: `Quality Loss` is a DURATION and every number on this
  // screen is a count or a weight, so the footnote below has to head off a
  // comparison the reader will otherwise attempt.
  lossName: "Quality Loss",
  // Names what is RANKED, as LOSS_CATEGORY_COPY's titles do. The tab already
  // carries the OEE factor's name.
  paretoTitle: "Quality Loss Pareto",
  paretoHint:
    "Rejects recorded against each of the machine's counters, ranked by their share of the shift. The counter column is what the sensor counted, in its own unit; the converted column restates the same rejects in one unit so counters can be compared. Weight is recorded for some counters only.",
  // The chart tooltip's occurrence row — stopsLabel's job in LOSS_CATEGORY_COPY.
  // "Reject records", not "Rejects": the count is of ROWS behind the bar, and the
  // rejected quantity is the converted column.
  occurrencesLabel: "Reject records",
  // The band colour, as the CSS custom property recharts is handed.
  //
  // A STATIC STRING, never `var(--color-oee-${slug})`. index.css opens
  // `@theme inline`, and with `inline` Tailwind defines a `--color-*` property
  // only where its scanner found the literal text — so a composed name is a
  // property that was never emitted, `fill` resolves to nothing, and the bars
  // render uncoloured with no error anywhere. reason-pareto-chart.tsx's `fillsFor`
  // comment is where that is verified against the built CSS.
  bandVar: "var(--color-oee-quality)",
  // One sentence per non-ready state of the six-state ladder in lib/load-state.ts,
  // so the chart and the table can never tell the reader two different stories
  // about the same empty result.
  //
  // `empty-loaded` and `empty-stale` are the pair that matters, and on THIS tab
  // the second one is the normal case: oee.reject_count_wu_shift ships empty, so
  // until the pipeline writes it every shift is "not loaded yet". Reporting those
  // as clean shifts would be the flattering reading and the wrong one.
  empty: {
    // Unreachable today and written anyway: /rejects is keyed on the report id,
    // so there is nothing to fail to derive. It exists so the state is already
    // covered the day the endpoint grows a scope or a date — the same reason
    // LOSS_CATEGORY_COPY.SMALL_STOP was written a tab early.
    "no-params": "This shift's date could not be read, so its rejects cannot be looked up.",
    "empty-loaded": "No rejects recorded for this shift.",
    "empty-stale":
      "Not loaded yet — the reject breakdown for this shift has not reached the reporting database.",
    error: "Could not load the reject breakdown for this shift.",
  },
  // Shown when the shift's counters convert to more than one base unit. The
  // converted column stops being comparable row to row and there is no single
  // shift total, which is the same thing the SKU averages say about a mixed-UoM
  // shift rather than quietly adding the two together.
  mixedUnitNote:
    "Mixed units of measure — converted quantities are not comparable across these rows, and no shift total is shown.",
  // The reconciliation note, and it states the mismatch as a FACT rather than
  // hedging it. The downtime cards say totals "need not match"; here two of the
  // three tiles look like they should, so a weaker sentence would invite exactly
  // the arithmetic this exists to head off.
  footnote:
    "Ranked from the shift's reject counters. These figures will not add up to the Reject tile on the report: that tile is the ETL's own aggregate on the shift row, while each row here is one counter scaled by its own conversion factor. Weight is recorded for some counters only, and Quality Loss is a duration — so neither of those is a total of this table either.",
  reworkLabel: "Rework",
  reworkNote:
    "Rework is a count on the shift report with no per-reason records anywhere in the reporting database, so it cannot be ranked. It is output that was reprocessed rather than scrapped, and it is not part of the ranking above.",
};

type QualityMeasureSpec = {
  // The radio's label. Lowercase, matching the downtime card's "duration".
  label: string;
  // The left axis caption. A FUNCTION, because the quantity axis's unit is not
  // known until the response arrives — and is null when the shift mixed units.
  axisLabel: (unit: string | null) => string;
  // One number in this measure's own terms. Applied to the RAW value
  // (`bar.value`, `bar.quantity`, `bar.weightGram`) and never to `bar.plotValue`,
  // which is scaled for the axis.
  //
  // Read by the chart's tooltip AND by the table's Weight and Converted cells, so
  // the three cannot drift — which is the failure this record exists to prevent:
  // an axis, a tooltip and a cell disagreeing about one number.
  format: (value: number | null, unit: string | null) => string;
  // The tooltip's "…, ranked by X" tail.
  rankedBy: string;
};

const QUALITY_MEASURES: Record<QualityMeasure, QualityMeasureSpec> = {
  quantity: {
    label: "quantity",
    axisLabel: (unit) => (unit === null ? "Quantity" : `Quantity (${unit})`),
    // A NULL UNIT IS A MIXED-UNIT BUCKET, not a missing label: the value behind it
    // is a sum of unlike units, so the whole cell is an em dash rather than a
    // plausible bare number. Same guard lib/product-count.ts documents and
    // hourly-production-body.tsx renders.
    format: (value, unit) => (unit === null ? EM_DASH : formatQuantity(value, unit)),
    rankedBy: "converted quantity",
  },
  weight: {
    label: "weight",
    axisLabel: () => "Weight (gr)",
    // Grams are grams, so this measure ignores the unit argument. A null VALUE is
    // a counter with no weight recorded at all, and formatQuantity already renders
    // that as an em dash — which is the whole point of keeping it null.
    format: (value) => formatQuantity(value, "gr"),
    rankedBy: "weight",
  },
  frequency: {
    label: "frequency",
    axisLabel: () => "Reject records",
    // `formatQuantity` with a null unit is a bare formatted number, and it
    // already renders null as an em dash — so a count needs no formatter of its
    // own and format.ts needs no wider public surface.
    format: (value) => formatQuantity(value, null),
    rankedBy: "frequency",
  },
  duration: {
    label: "duration",
    axisLabel: () => "Minutes",
    format: (value) => formatDuration(value),
    rankedBy: "duration",
  },
};

// The order the radios are rendered in, and the default is the first.
//
// `quantity` LEADS because this Pareto exists to rank how MUCH was rejected, and
// because it is the measure the reference design plots. `duration` is last on
// purpose: no upstream source measures per-counter reject time yet, so it ranks a
// column of zeros until the pipeline writes it.
const QUALITY_MEASURE_ORDER = ["quantity", "weight", "frequency", "duration"] as const;

export { QUALITY_LOSS_COPY, QUALITY_MEASURE_ORDER, QUALITY_MEASURES };
export type { QualityMeasureSpec };
