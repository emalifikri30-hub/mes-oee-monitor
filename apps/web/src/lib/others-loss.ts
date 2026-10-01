import { formatQuantity } from "@/lib/format";

// What the Others tab is CALLED, how it READS, and the two sentences that keep it
// honest — in one place.
//
// A PLAIN OBJECT, not an entry in LOSS_CATEGORY_COPY, and it cannot be one even
// in principle: that record is keyed by DowntimeCategory, which lib/types.ts pins
// to oee.operation_type, and "Others" is not an operation type. It must never be
// added to that enum, for the reason TODOS.md §29 gives about quality — the tab
// spans every category, which is what makes it Others.
//
// Nor an addition to lib/quality-loss.ts. Different source, different tab, and
// colocating them would make it possible to hand one tab the other's sentences —
// the drift a per-tab module exists to prevent, and which is silent because every
// string is plausible in the wrong tab.
//
// THE COPY IS THE FEATURE'S ONLY DEFENCE AGAINST ITS WORST FAILURE. There is no
// code that can stop a supervisor reading a bar of 38 as "38 stops", because
// arithmetically it is 38 events and the chart is correct. Only a sentence can,
// which is why occurrenceSummary and occurrenceFootnote are functions with tests
// rather than strings.

const OTHERS_LOSS_COPY = {
  // Names what is RANKED, as LOSS_CATEGORY_COPY's titles do. The tab bar already
  // carries the design's word for it, which is "Others" — a label, not a
  // description — so the card says what the bars actually are.
  paretoTitle: "Downtime Reason Occurrence Pareto",

  paretoHint:
    "How many times each reason was cited by a downtime event in this shift. It reads the immutable event log rather than the editable downtime records, so correcting a stop's reason cannot move these bars. One stop can cite several reasons, so a bar counts the stops that mentioned a reason — it is not a share of the shift's clock. No duration is recorded per reason, which is why frequency is the only ranking here.",

  // The chart tooltip's count row — stopsLabel's job in LOSS_CATEGORY_COPY.
  // "Stops citing this", never a bare "Stops": naming the row after what it
  // counts is the only place the multi-reason fact fits in three words.
  occurrencesLabel: "Stops citing this",

  // The left axis caption. A CONSTANT, not a function of a measure, because there
  // is one measure and so nothing to look up. quality-loss.ts needs a record of
  // four specs; this needs two strings.
  axisLabel: "Occurrences",

  // The tooltip's "…, ranked by X" tail.
  rankedBy: "occurrences",

  // The band colour, as the CSS custom property recharts is handed.
  //
  // A STATIC STRING, never `var(--color-oee-${slug})`. index.css opens
  // `@theme inline`, and with `inline` Tailwind defines a `--color-*` property
  // only where its scanner found the literal text — so a composed name is a
  // property that was never emitted, `fill` resolves to nothing, and the bars
  // render uncoloured with no error anywhere. The same note in
  // lib/quality-loss.ts points at where that is verified against the built CSS.
  bandVar: "var(--color-oee-others)",

  // One sentence per non-ready state of the six-state ladder in lib/load-state.ts,
  // so the chart and the table can never tell the reader two different stories
  // about the same empty result.
  //
  // `empty-loaded` and `empty-stale` are the pair that matters, and on THIS tab
  // the second one is not an edge case — it is the ONLY reachable non-error state.
  // oee.downtime_log_events ships empty, so until the pipeline writes it every
  // shift is "not loaded yet". Reporting those as shifts nothing stopped would be
  // the flattering reading and the wrong one (TODOS.md §8).
  empty: {
    // Unreachable today and written anyway, exactly as QUALITY_LOSS_COPY's is:
    // this query is keyed on the report id, so there is nothing to fail to
    // derive. It exists so the state is already covered the day the endpoint
    // grows a scope or a date.
    "no-params": "This shift's date could not be read, so its downtime events cannot be looked up.",
    "empty-loaded": "No downtime events recorded for this shift.",
    "empty-stale":
      "Not loaded yet — the downtime event log for this shift has not reached the reporting database.",
    error: "Could not load the downtime event log for this shift.",
  },
} as const;

// "142 reason occurrences across 97 downtime events".
//
// BOTH FIGURES, ALWAYS, AND NAMED. This is the sentence the whole tab turns on: a
// supervisor reads a bar as a number of stops unless something on screen says
// otherwise, and this is that something. It occupies the header slot every other
// loss card gives to its MeasureToggle, which is the strictly better use of the
// same pixels when there is only one measure to rank by.
//
// A FUNCTION rather than a template in the card, so the pluralisation and the
// wording are covered by lib/others-loss.test.ts. Pluralised because
// "1 reason occurrences" reads as a bug, and a reader who has spotted one stops
// trusting the rest of the screen.
//
// Both numbers go through formatQuantity with a null unit — a bare formatted
// number — so a four-digit count carries its thousands separator and matches the
// table's cells.
function occurrenceSummary(totalOccurrences: number, totalEvents: number): string {
  const occurrences = formatQuantity(totalOccurrences, null);
  const events = formatQuantity(totalEvents, null);
  const occurrenceNoun = totalOccurrences === 1 ? "reason occurrence" : "reason occurrences";
  const eventNoun = totalEvents === 1 ? "downtime event" : "downtime events";

  return `${occurrences} ${occurrenceNoun} across ${events} ${eventNoun}`;
}

// The reconciliation footnote, and the one place the inequality is spelled out.
//
// QUOTES THE TWO NUMBERS when they are known and DROPS the numeric clause
// otherwise, so an empty or failed card never footnotes "0 occurrences across 0
// events" as though that were a finding. The claim about multi-reason stops
// survives either way, because it is true of the tab and not of one response.
//
// It states the mismatch as a FACT rather than hedging it, the way
// QUALITY_LOSS_COPY.footnote does and for a stronger version of its reason: there
// the tiles merely LOOK like they should match, whereas here a reader has no way
// at all to tell an occurrence count from a stop count by looking.
function occurrenceFootnote(totalOccurrences: number | null, totalEvents: number | null): string {
  const counted =
    totalOccurrences === null || totalEvents === null
      ? "so these bars sum to reason occurrences, not to the downtime events they came from"
      : `so these bars sum to ${formatQuantity(totalOccurrences, null)} reason occurrences, not to the ${formatQuantity(totalEvents, null)} downtime events they came from`;

  return `Ranked from the shift's downtime event log, counted by how many stops cited each reason. A stop can cite more than one reason, ${counted}. Neither figure is the Downtime Frequency on the report, which counts the editable downtime records across every category. No duration appears here: the log records that a reason was cited, not how long it lasted.`;
}

export { OTHERS_LOSS_COPY, occurrenceFootnote, occurrenceSummary };
