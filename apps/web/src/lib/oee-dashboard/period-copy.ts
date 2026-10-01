import type { DashboardPeriodCopy } from "@/components/oee-dashboard/oee-performance-view";

// THE PROSE THAT VARIES WITH THE GRAIN, and it is the ONLY thing that does.
//
// The subject registry (lib/oee-dashboard/subject.ts) owns the other axis and
// deliberately has no grain key, because no tile changes between a month screen and
// a year one. What DOES change is every sentence that names the period — and those
// sentences are the difference between a screen that reads as broken and one that
// reads as honest, so they are a tested VALUE rather than six inline literals.
//
// A RECORD INDEXED BY A LITERAL, never by a variable. `DASHBOARD_PERIOD_COPY[grain]`
// with a `grain` in scope is how the year screen's wording reaches a month screen —
// the same reason the trend query options were taken OUT of the subject registry.
// Each route writes `.month` or `.year`.
//
// THE CARD TITLES ARE NOT IN HERE and must not be added. "OEE Trend", "Six Big
// Losses", "Schedule Loss" and "Pareto Actions" are the same words at both grains,
// because a supervisor comparing a line's month to its year must not find two names
// for one card — oee-summary-card.tsx makes the same call for its own title.
const DASHBOARD_PERIOD_COPY = {
  month: {
    trendError: "The daily trend could not be loaded.",
    // THE SPLIT THAT MATTERS, and the flattering reading is the wrong one: a month
    // with no day rows loaded must not render as a month with nothing to report.
    trendEmptyStale: "The daily figures for this month have not been loaded yet.",
    trendEmptyLoaded: "No daily figures were recorded for this month.",
    actionsFootnote:
      "Counted against each stop's first action, so the bars sum to the month's downtime.",
  },
  year: {
    // A YEAR REPORT TRENDS MONTHS, NOT DAYS — its twelve points are the month rows
    // beneath it. Calling them "daily figures" here would describe a chart the
    // screen is not drawing, which is the whole reason this record exists.
    trendError: "The monthly trend could not be loaded.",
    trendEmptyStale: "The monthly figures for this year have not been loaded yet.",
    trendEmptyLoaded: "No monthly figures were recorded for this year.",
    actionsFootnote:
      "Counted against each stop's first action, so the bars sum to the year's downtime.",
  },
} as const satisfies Record<"month" | "year", DashboardPeriodCopy>;

export { DASHBOARD_PERIOD_COPY };
