// The OEE Performance dashboard's default period.
//
// ONE ANCHOR FOR BOTH FIELDS, and that is the whole reason this is a function.
// The requirement states the two defaults separately — "filter by year (default:
// current year)" and "filter by month (default: previous month)" — and taken
// literally they CONTRADICT EACH OTHER once a year. In January 2027 the previous
// month is December 2026, so a `year` defaulted to `now.getFullYear()` beside a
// `month` defaulted to the previous one asks for December 2027: a month that has
// not happened, on a screen whose whole job is to report a month that has.
//
// Deriving both from one Date makes the pair coherent by construction. The bug it
// prevents is invisible for eleven months of every twelve, which is exactly the
// kind that ships — so the test carries a January case.
//
// `now` is injectable for the reason reportYearOptions's is: so the test does not
// have to be re-read every January, which is the one month it matters.
function previousMonthAnchor(now: Date = new Date()): { year: number; month: number } {
  // Day 1 rather than today's date: constructing month - 1 on the 31st would land
  // on a month with fewer days and roll forward. `new Date(2026, 2, 31)` is fine,
  // but `new Date(2026, 1, 31)` is 3 March.
  const anchor = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  // getMonth() is 0-based; every filter, URL and API param in this app is 1-based.
  return { year: anchor.getFullYear(), month: anchor.getMonth() + 1 };
}

// THE YEARLY SCREENS' DEFAULT YEAR, derived from the SAME anchor rather than from
// a second `new Date()`.
//
// Not `now.getFullYear()`, which is what every report LIST uses and is wrong here
// for the reason the month default above is: on the first working days of January
// the current year has no finished month in it at all, so a screen whose whole job
// is to report a period that HAS HAPPENED would open on an empty one and read as
// broken. And not "last year" either — that fixes January and breaks the other
// eleven months, opening 2025 in December 2026.
//
// `previousMonthAnchor().year` is exactly "the latest year that certainly has data":
// the current year from February onward, the previous one in January. Deriving it
// from the anchor rather than re-deriving `getMonth() === 0` is what stops the
// monthly and yearly screens disagreeing about which period is the latest one worth
// defaulting to — the same single-source argument the anchor itself exists for, one
// grain up.
function defaultReportYear(now: Date = new Date()): number {
  return previousMonthAnchor(now).year;
}

export { defaultReportYear, previousMonthAnchor };
