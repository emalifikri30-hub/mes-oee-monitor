// Display formatting for the OEE report screens. Every duration the API returns
// is milliseconds, every percentage is a number already rounded to 3 decimals.

const EM_DASH = "—";

const MS_PER_HOUR = 3_600_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Durations read as `03 h 27 m 14 s`, dropping *leading* zero units only: a
// sub-minute value is `28 s`, never `00 h 00 m 28 s`. Interior zeros stay, so
// `03 h 00 m 14 s` keeps its minutes and the columns still line up.
//
// Loss durations can be negative (a machine that ran faster than its standard),
// which is real data rather than an error — one minus sign, in front.
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;

  const sign = ms < 0 ? "-" : "";
  // Round before decomposing: the columns are float8, so 59_600 ms must carry
  // to `01 m 00 s` rather than truncate to `59 s`.
  const total = Math.round(Math.abs(ms) / 1000);

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${sign}${pad(hours)} h ${pad(minutes)} m ${pad(seconds)} s`;
  if (minutes > 0) return `${sign}${pad(minutes)} m ${pad(seconds)} s`;
  return `${sign}${pad(seconds)} s`;
}

// The same duration with a DAYS unit on top.
//
// WHY A SECOND FORMATTER RATHER THAN A FLAG ON THE FIRST. `formatDuration` is on
// every report screen and reads in hours because a shift is eight of them and a
// day is twenty-four — "08 h 12 m 30 s" is the figure an operator compares
// against a shift. The OEE Performance dashboard's donuts show a MONTH of
// calendar time, where that same formatter prints "744 h 00 m 00 s": correct, and
// a number nobody can size at a glance. Days are what make it readable.
//
// A `showDays` parameter was the obvious alternative and is worse: it would put
// the decision at ~40 call sites that currently cannot get it wrong, and the two
// forms are not interchangeable — a shift report showing "0 d 08 h" would be
// noise, and a month donut showing "744 h" would be unreadable.
//
// Same three rules as formatDuration, deliberately: leading zero units are
// dropped, INTERIOR zeros are kept (so "2 d 00 h 05 m 00 s" stays legible as two
// days and five minutes), and a negative duration is real data rendered as-is.
function formatLongDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;

  const sign = ms < 0 ? "-" : "";
  // Rounded BEFORE decomposing, for formatDuration's reason: these come from
  // float8 columns and a fractional second would otherwise leak into every unit.
  const total = Math.round(Math.abs(ms) / 1000);
  const days = Math.floor(total / 86_400);

  // Under a day this IS formatDuration, and delegating rather than re-deriving is
  // what stops the two drifting on the rules they share.
  if (days === 0) return formatDuration(ms);

  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${sign}${days} d ${pad(hours)} h ${pad(minutes)} m ${pad(seconds)} s`;
}

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
  useGrouping: false,
});

// 3-decimal percentages with trailing zeros stripped: 97.558%, 100%.
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${numberFormat.format(value)}%`;
}

// Output counts carry the report's unit of measure, which is nullable — a null
// uom must not leak "null" or a trailing space into the tile.
function formatQuantity(value: number | null | undefined, uom: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const amount = numberFormat.format(value);
  return uom ? `${amount} ${uom}` : amount;
}

// The report's `date` is NOT a calendar day — it is the instant the shift started
// (`timestamptz` upstream). So every calendar reading of it needs the plant's zone:
//
//   2026-08-01T16:00:00Z   shift 3 start
//     in Asia/Jakarta (+7)  ->  2026-08-01 23:00  ->  business day 2026-08-01
//     in America/Chicago    ->  2026-08-01 11:00  ->  business day 2026-08-01
//   2026-08-02T04:00:00Z   the same shift 3 for a UTC-5 plant
//     read in UTC           ->  2026-08-02        ->  WRONG day
//     in America/Chicago    ->  2026-08-01 23:00  ->  right day
//
// Reading these in UTC is correct only where the local and UTC dates coincide,
// which is every shift at UTC+7 and not a guarantee anywhere else. One formatter
// per zone, cached: constructing one is expensive relative to formatting.
const reportDateFormats = new Map<string, Intl.DateTimeFormat>();

function reportDateFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = reportDateFormats.get(timeZone);
  if (cached !== undefined) return cached;

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone,
    });
  } catch {
    // Unreachable if the zone came from master-data, which validates it against
    // the IANA database — but throwing from inside a render would take the whole
    // report page down over a label.
    format = reportDateFormat("UTC");
  }

  reportDateFormats.set(timeZone, format);
  return format;
}

// Only a full ISO instant is accepted, and the guard is not decoration: `new Date`
// is lenient enough to read "09/08/2026" as a US M/D/Y date and "2026-8-9" as an
// unpadded one, both in the BROWSER's zone. Either would then format into a
// perfectly well-formed but wrong day — and toBusinessDay's output goes straight
// into a query param, so a wrong day is a wrong request rather than a visible
// error. The old string-slicing implementation got this right for free by never
// parsing at all.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

// Both readers below compose from parts rather than taking a formatted string,
// for the reason formatDateTime does: locales disagree about the separators, and
// ICU versions disagree about whether they are there at all.
function reportDateParts(iso: string, timeZone: string) {
  if (!ISO_INSTANT.test(iso)) return undefined;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;

  const parts = reportDateFormat(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return { weekday: part("weekday"), day: part("day"), month: part("month"), year: part("year") };
}

// `Sunday, 09/08/2026`, in the plant's zone.
//
// A null zone means master-data could not tell us where the plant is, so the day is
// genuinely unknown — an em dash, not a guess at UTC that would render a plausible
// wrong day.
function formatReportDate(iso: string | null | undefined, timeZone: string | null): string {
  if (!iso || !timeZone) return EM_DASH;

  const parts = reportDateParts(iso, timeZone);
  if (parts === undefined) return EM_DASH;

  return `${parts.weekday}, ${parts.day}/${parts.month}/${parts.year}`;
}

// ---------------------------------------------------------------------------
// Business dates — already plant-local, so NOTHING here converts a zone
// ---------------------------------------------------------------------------
//
// `businessDate` on a day or month report is a plain 'YYYY-MM-DD' the SERVER
// resolved in the plant's zone (migration 0013). It is not an instant.
//
// THAT IS WHY THESE TWO EXIST INSTEAD OF REUSING formatReportDate. Handing
// '2026-08-01' to that function makes `new Date` read it as UTC midnight, and
// converting UTC midnight into any zone west of Greenwich lands on 31 July. The
// screen would render the day before the one the report is about, on every row,
// and it would look entirely normal.
//
// So these parse the components and never build a zoned Date at all. A string
// that is not a business date returns an em dash rather than "Invalid Date".
const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// `Saturday, 01/08/2026` — the same shape formatReportDate produces, from a
// business date rather than an instant.
function formatBusinessDate(date: string | null | undefined): string {
  const parts = businessDateParts(date);
  if (parts === undefined) return EM_DASH;

  const { year, month, day } = parts;
  // Date.UTC + getUTCDay, so the weekday is computed from the calendar date
  // itself and no local offset can move it.
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? EM_DASH;

  return `${weekday}, ${pad(day)}/${pad(month)}/${year}`;
}

// `August 2026`, from the month's first business day.
//
// The year is NOT optional. "January" alone is what the reference design shows,
// and it is ambiguous the moment somebody opens a report from last year — which
// the By Monthly list makes one click away.
function formatMonthLabel(date: string | null | undefined): string {
  const parts = businessDateParts(date);
  if (parts === undefined) return EM_DASH;

  const name = MONTH_NAMES[parts.month - 1];
  if (name === undefined) return EM_DASH;

  return `${name} ${parts.year}`;
}

function businessDateParts(
  date: string | null | undefined,
): { year: number; month: number; day: number } | undefined {
  if (!date) return undefined;

  const match = BUSINESS_DATE.exec(date);
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Guards a well-shaped but impossible date — '2026-13-01' matches the regex.
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  return { year, month, day };
}

// One Intl.DateTimeFormat per zone. Constructing one is expensive relative to
// formatting, and the downtime strip formats two clock times per segment.
const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = clockFormats.get(timeZone);
  if (cached !== undefined) return cached;

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      // h23 explicitly: without it some locales render midnight as 24:00.
      hourCycle: "h23",
      timeZone,
    });
  } catch {
    // core-api validates the zone against the IANA database before it leaves
    // master-data, so an unknown one should be unreachable — but falling back
    // beats throwing from inside a render and taking the whole report page down
    // over a label.
    format = clockFormat("UTC");
  }

  clockFormats.set(timeZone, format);
  return format;
}

// `17:29`, read in the plant's zone rather than the browser's. The zone comes
// from the timeline payload, so the shift boundaries stay a server-side fact.
function formatClock(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return EM_DASH;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  return clockFormat(timeZone).format(date);
}

// Same per-zone cache as clockFormat, with seconds. Separate rather than
// parameterised because a formatter's options are fixed at construction, so one
// Map per shape is the only way to cache them at all.
const secondsFormats = new Map<string, Intl.DateTimeFormat>();

function secondsFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = secondsFormats.get(timeZone);
  if (cached !== undefined) return cached;

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // h23 explicitly, and it is load-bearing here rather than cosmetic: an hour
      // bucket ending at midnight must read `00:00:00`, and without this some
      // locales render it `24:00:00` — which would sort and read as a 25th hour.
      hourCycle: "h23",
      timeZone,
    });
  } catch {
    // Same reasoning as clockFormat: falling back beats throwing from inside a
    // render and taking the report page down over an axis label.
    format = secondsFormat("UTC");
  }

  secondsFormats.set(timeZone, format);
  return format;
}

// `23:00:00`, in the plant's zone. The hourly performance chart labels its buckets
// with these, as `00:00:00 - 01:00:00`.
function formatClockSeconds(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return EM_DASH;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  return secondsFormat(timeZone).format(date);
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = dateTimeFormats.get(timeZone);
  if (cached !== undefined) return cached;

  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
  } catch {
    format = dateTimeFormat("UTC");
  }

  dateTimeFormats.set(timeZone, format);
  return format;
}

// `11/08/2026 14:23`, in the plant's zone.
//
// Composed from parts rather than taken as a formatted string because locales
// insert a comma between the date and the time, and ICU versions disagree about
// whether it is there at all — the same reason formatReportDate is hand-built.
function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return EM_DASH;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const parts = dateTimeFormat(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;

// `2026-08-01T16:00:00.000Z` + `Asia/Jakarta` -> `2026-08-01`, the business day
// core-api's timeline and downtime endpoints expect.
//
// Resolved in the plant's zone, NOT by slicing the ISO string. Slicing reads the
// UTC calendar date, which is the same as the plant's only where the shift's start
// instant happens to fall on the same day in both — true for every shift at UTC+7
// and false for a 23:00 shift-3 start anywhere west of Greenwich, where the UTC
// date is already tomorrow.
//
// An already-bare day is returned untouched: it carries no instant, so there is
// nothing to convert and converting it would shift it.
function toBusinessDay(iso: string | null | undefined, timeZone: string): string | undefined {
  if (!iso) return undefined;
  if (BARE_DAY.test(iso)) return iso;

  const parts = reportDateParts(iso, timeZone);
  if (parts === undefined) return undefined;

  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return BARE_DAY.test(day) ? day : undefined;
}

function msToHours(ms: number): number {
  return ms / MS_PER_HOUR;
}

export {
  formatBusinessDate,
  formatMonthLabel,
  EM_DASH,
  formatClock,
  formatClockSeconds,
  formatDateTime,
  formatDuration,
  formatLongDuration,
  formatPercent,
  formatQuantity,
  formatReportDate,
  msToHours,
  toBusinessDay,
};
