import type { DowntimeCategory } from "@/lib/types";

// What each downtime category is CALLED and how it READS, in one place.
//
// The Availability Loss tab shipped first, so every sentence it renders was
// written about unplanned downtime specifically: "No unplanned downtime recorded
// for this shift", "Unplanned stops", "the Availability Loss figure on the
// report". Schedule Loss is the same chart over `category=PLANNED`, and the one
// thing it cannot share is the words.
//
// A RECORD RATHER THAN PROPS. Threading eight strings from the route would put
// the wording at the call site, where two tabs rendering one component are free
// to drift — and the drift is silent, because every string is plausible in the
// wrong tab. The same argument CATEGORY_LABEL and SEGMENT_CLASS in
// lib/downtime.ts already make about colours.
//
// EXHAUSTIVE BY TYPE, so SMALL_STOP has an entry it does not yet use. That is
// deliberate: Performance Loss is the next tab and TODOS.md §24 calls it "half
// answerable" from `category=SMALL_STOP`, so the copy is written now while the
// three are being compared side by side rather than later in isolation.

type LossCategoryCopy = {
  // The Losses card's own tile that this breakdown will be read against, and
  // therefore the figure the reconciliation footnote has to name. Getting this
  // wrong points the reader at a number from a different source and invites
  // exactly the arithmetic the footnote exists to head off.
  lossName: string;
  // The Pareto card's title. Names the RECORDS ("Planned Downtime"), not the OEE
  // factor ("Schedule Loss") — lib/downtime.ts draws that distinction, and the
  // tab already carries the factor name.
  paretoTitle: string;
  // The header InfoIcon tooltip: what is in scope and what is counted elsewhere.
  paretoHint: string;
  // The chart tooltip's frequency row.
  stopsLabel: string;
  // The band colour, as the CSS custom property recharts is handed.
  //
  // A STATIC STRING PER KEY, not `var(--color-oee-${slug})`. The token names are
  // not a mechanical function of the enum — SMALL_STOP is `small-stop`, not
  // `small_stop` — and writing them out is what makes them greppable from
  // index.css, where the ramps and their measured contrast ratios are defined.
  bandVar: string;
  // One sentence per non-ready state of the six-state ladder in lib/load-state.ts,
  // so a card's chart and its table can never tell the reader two different
  // stories about the same empty result.
  //
  // `empty-loaded` and `empty-stale` are the pair that matters: they mean
  // opposite things about an identically empty response, and the flattering one
  // is wrong.
  empty: Record<"no-params" | "empty-loaded" | "empty-stale" | "error", string>;
};

const LOSS_CATEGORY_COPY: Record<DowntimeCategory, LossCategoryCopy> = {
  UNPLANNED: {
    lossName: "Availability Loss",
    paretoTitle: "Unplanned Downtime Pareto",
    paretoHint:
      "Machine stops recorded as unplanned, ranked by their share of the shift. Planned downtime and small stops are counted elsewhere.",
    stopsLabel: "Unplanned stops",
    bandVar: "var(--color-oee-unplanned-downtime)",
    empty: {
      "no-params": "This shift's date could not be read, so its downtime cannot be looked up.",
      "empty-loaded": "No unplanned downtime recorded for this shift.",
      "empty-stale":
        "Not loaded yet — the unplanned downtime for this shift has not reached the reporting database.",
      error: "Could not load the unplanned downtime breakdown for this shift.",
    },
  },
  PLANNED: {
    lossName: "Schedule Loss",
    paretoTitle: "Planned Downtime Pareto",
    // Says what planned downtime DOES to OEE, because that is the question a
    // supervisor arrives with: it is subtracted from planned production time
    // rather than lost against it, which is why it is not availability loss.
    // downtime-dto.ts states the same thing where the API's default is set.
    paretoHint:
      "Stops recorded as planned — changeovers, maintenance, cleaning — ranked by their share of the shift. Planned time is subtracted from production time rather than lost against it, so it is not availability loss.",
    stopsLabel: "Planned stops",
    bandVar: "var(--color-oee-planned-downtime)",
    empty: {
      "no-params": "This shift's date could not be read, so its downtime cannot be looked up.",
      "empty-loaded": "No planned downtime recorded for this shift.",
      "empty-stale":
        "Not loaded yet — the planned downtime for this shift has not reached the reporting database.",
      error: "Could not load the planned downtime breakdown for this shift.",
    },
  },
  SMALL_STOP: {
    // NOT "Performance Loss", which is small stops PLUS reduce-speed. Small
    // stops are one of its two halves and the only one with per-cause records
    // anywhere, so naming the whole factor here would promise a reconciliation
    // this breakdown cannot deliver. losses-card.tsx renders both tiles.
    lossName: "Small Stop",
    paretoTitle: "Small Stop Pareto",
    paretoHint:
      "Micro-stops too short to count as downtime, ranked by their share of the shift. They are half of performance loss; reduced speed is the other half and has no per-cause records.",
    stopsLabel: "Small stops",
    bandVar: "var(--color-oee-small-stop)",
    empty: {
      "no-params": "This shift's date could not be read, so its downtime cannot be looked up.",
      "empty-loaded": "No small stops recorded for this shift.",
      "empty-stale":
        "Not loaded yet — the small stops for this shift have not reached the reporting database.",
      error: "Could not load the small stop breakdown for this shift.",
    },
  },
};

export { LOSS_CATEGORY_COPY };
export type { LossCategoryCopy };
