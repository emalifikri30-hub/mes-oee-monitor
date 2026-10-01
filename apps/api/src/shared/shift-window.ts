import type { PostgresDB } from "./database/postgres.js";

// The plant's shift boundaries, and the types that name a shift.
//
// WHY THIS IS IN shared/ AND NOT IN module/downtime/
//
// It started in `module/downtime/downtime.ts`, because the timeline strip was
// the first screen that needed it. It moved here the moment a SECOND module
// needed the same boundaries: the work-unit shift report's Log Activity feed
// asks "which stops belong to this shift", which is the identical question the
// timeline asks and must not be answered twice.
//
// A second copy of these three rows would be an ARITHMETIC divergence — a stop
// straddling 23:00 counted by one query and not the other — which renders a
// plausible number rather than throwing. That is the failure class this repo's
// integration tests exist for, and the cheapest place to prevent it is to have
// one definition.
//
// The alternative considered was a port in `@molca/contract-client`, mirroring
// MasterDataClientContract. Rejected: that boundary exists so a module can be
// extracted into its own SERVICE without touching call sites, and these are
// three constants describing the physical plant, not a service's behaviour.
// It would have cost six files to move three lines.
//
// Note this is plant-wide configuration masquerading as a constant. If a second
// plant with different shift times is ever onboarded, this is the thing that
// has to become master data — see the note on SHIFT_WINDOWS below.

// The plant runs three numbered shifts. These times are the ONLY statement of
// the shift boundaries in the codebase — the browser never hardcodes them, it
// reads `from`/`to` off the response.
//
//   shift 1  07:00 ─────────▶ 15:00   same day
//   shift 2  15:00 ─────────▶ 23:00   same day
//   shift 3  23:00 ─────────▶ 07:00   next day  ◀ crosses midnight
//
// `endDayOffset` is added to the business date before the end time, which is
// what makes shift 3 an 8-hour window rather than a negative 16-hour one.
const SHIFT_WINDOWS = {
  "1": { startTime: "07:00", endTime: "15:00", endDayOffset: 0 },
  "2": { startTime: "15:00", endTime: "23:00", endDayOffset: 0 },
  "3": { startTime: "23:00", endTime: "07:00", endDayOffset: 1 },
} as const;

type ShiftId = keyof typeof SHIFT_WINDOWS;

const SHIFT_IDS = Object.keys(SHIFT_WINDOWS) as [ShiftId, ...ShiftId[]];

// `shift` is a `smallint` on every Gold table, so it arrives from the database
// as a NUMBER while every window lookup is keyed by STRING. This is the one
// conversion between the two, and it is a guard rather than a cast.
//
// `String(shift) as ShiftId` would be the obvious one-liner and it is a trap: a
// report carrying a shift the window table does not know about would reach
// SHIFT_WINDOWS as "4", destructure to three `undefined`s, and come back from
// Postgres as a window built from `NULL::time` — an empty range that silently
// matches no stops. A shift report with no downtime is a completely plausible
// screen, so nothing would look wrong.
//
// Returns undefined rather than throwing: the caller knows whether an unknown
// shift is a 400 (it came from a query param) or a 500 (it came out of a
// report row), and this module does not.
function toShiftId(shift: number | string): ShiftId | undefined {
  const id = String(shift);
  return id === "1" || id === "2" || id === "3" ? id : undefined;
}

// How far back to look for a stop that is STILL OPEN.
//
// oee.downtime_reports.date is the business day a stop STARTED in, so narrowing
// on it is what keeps an overlap query sargable — but it also means a stop open
// longer than this horizon drops out of windows it genuinely covers. Bounded and
// documented rather than unbounded and slow; the GiST range index in TODOS.md
// §10 removes the trade-off entirely.
//
// HERE FOR THE SAME REASON SHIFT_WINDOWS IS. It began in module/downtime, and
// moved when the shift report's activity feed became a second caller. Both
// constants answer one question — "how do I turn a shift into a predicate over
// oee.downtime_reports?" — and a second copy of either is an arithmetic
// divergence that renders a plausible number instead of throwing.
const MAX_OPEN_DOWNTIME_DAYS = 7;

// The half-open instant range a shift covers, in real time.
type ShiftWindow = {
  from: Date;
  to: Date;
};

// Turn a business day + a shift into the two instants that bound it.
//
// THE ARITHMETIC STAYS ON POSTGRES' DATE/TIME TYPES rather than being done in
// JavaScript, and that is the point of doing it in SQL at all: `AT TIME ZONE`
// resolves the plant's offset FOR THAT DATE, so a DST transition inside the
// window lands where the plant says it does. Node's Date has no zone-aware
// arithmetic without a library, and the naive version silently shifts every
// boundary by an hour twice a year in any plant that observes DST.
//
// `endDayOffset` is added to the DATE before the end time is added, which is
// what makes shift 3 an 8-hour window rather than a negative 16-hour one.
//
// A FREE FUNCTION TAKING THE HANDLE, not a repository method. Two repositories
// need this — DowntimeReaderRepository for the timeline, and
// WorkUnitReportReaderRepository for the shift report's activity feed — and a
// second copy of this SQL would be an arithmetic divergence: a stop straddling
// 23:00 counted by one and not the other, rendering a plausible number rather
// than throwing. Callers keep their own traced() wrapper, so the span still
// names the table the caller is really working on.
async function resolveShiftWindow(
  db: PostgresDB,
  date: string,
  shift: ShiftId,
  timeZone: string,
): Promise<ShiftWindow> {
  const { startTime, endTime, endDayOffset } = SHIFT_WINDOWS[shift];

  const rows = await db<ShiftWindow[]>`
    SELECT ((${date}::date + ${startTime}::time) AT TIME ZONE ${timeZone}) AS "from",
           (((${date}::date + ${endDayOffset}::int) + ${endTime}::time)
             AT TIME ZONE ${timeZone}) AS "to"
  `;

  const window = rows[0];
  // Unreachable with a validated date and a known shift, but a silent undefined
  // here would surface as a NaN-width timeline much further on.
  if (window === undefined) {
    throw new Error(`could not resolve window for shift ${shift} on ${date}`);
  }

  return window;
}

// The FOUR grains a report can be written at. `shift` is the only one that needs a
// shift number; the other three are windows over whole business days.
//
// An array rather than a bare union so `z.enum(REPORT_GRAINS)` in downtime-dto.ts
// is derived from it, exactly as SHIFT_IDS is. A hand-written enum in the DTO
// would be a second list to keep aligned, and the symptom of a drift is a 400 on
// a grain the rest of the service handles perfectly well.
//
// ─────────────────────────────────────────────────────────────────────────────
// `year` ARRIVED WITH `0027`, AND WHAT IT WIDENS IS WORTH KNOWING
// ─────────────────────────────────────────────────────────────────────────────
//
// TODOS.md §74 predicted a fourth member would be expensive — "it touches the
// window resolver, both coarse-grain loops and every list screen's filter". Only
// the first of those turned out to be true, and the reason is that NOTHING ELSE
// READS THIS CONSTANT. The per-subject grain unions are declared locally and
// separately: `PeriodGrain` in work-unit.ts, a local `ReportGrain` in
// work-center.ts, `AreaGrain` in area-report.ts. None of them widened, which is
// what keeps a year report id out of the reads that have no year answer — the
// hour profile, the performance chart, the activity feed.
//
// What it DOES widen is `downtime-dto.ts`'s `grain` enum — which is the point.
// The three downtime Paretos and Pareto Actions then serve a year screen with no
// new arithmetic anywhere.
//
// AND IT WIDENS MORE THAN THOSE TWO ENDPOINTS, deliberately but worth stating:
// `timelineInputBase` carries the enum, and the TIMELINE and the paginated
// DOWNTIME LIST both extend it. So `grain=year` is acceptable to all four. No
// screen asks either of them for a year — a year-long "timeline strip" is not a
// thing anyone has designed — but nothing refuses it either. Splitting the base
// to prevent that would mean two statements of the scope/date/shift contract, and
// reportWindowParams' own header explains why one composer is worth more than the
// refusal.
const REPORT_GRAINS = ["shift", "day", "month", "year"] as const;

type ReportGrain = (typeof REPORT_GRAINS)[number];

// A BUSINESS DAY RUNS 07:00 -> 07:00 PLANT-LOCAL, and this is where that is
// said. It is DERIVED from shift 1's start rather than written out, because a
// business day is not an independent fact about the plant — it is exactly the
// span shift 1, 2 and 3 cover:
//
//   day D  ├── shift 1 ──┼── shift 2 ──┼──── shift 3 ────┤
//        07:00        15:00         23:00            07:00 of D+1
//
// So a day window's `from` IS shift 1's `from`, and its `to` IS shift 3's `to`.
// Writing "07:00" here a second time would let the two drift apart, and the
// symptom would be a day report whose totals quietly disagree with the sum of
// its three shifts. `resolveReportWindow` has a test asserting exactly that
// equality, which is the mechanical guard.
const DAY_START_TIME = SHIFT_WINDOWS["1"].startTime;

// The same fact as a number, for the one consumer that needs to rotate a 0-23
// clock hour into business-day order: the month report's hour-of-day profile.
//
// DERIVED from DAY_START_TIME rather than written as 7, for the reason that
// constant is derived from SHIFT_WINDOWS. It is sent to the browser on the
// profile payload so the axis can be built in business-day order WITHOUT a copy
// of the shift table in the client — the arithmetic divergence this whole file
// exists to prevent.
const DAY_START_HOUR = Number(DAY_START_TIME.slice(0, 2));

// The window for any grain. `shift` is required when grain is "shift" and
// ignored otherwise.
//
// WHY ONE FUNCTION RATHER THAN THREE CALLERS PICKING
//
// Everything downstream of this — `scopeAndWindow`, `windowStops`, the reject
// and downtime-event range filters — takes a `ShiftWindow` and does not care
// which grain produced it. Funnelling the three cases through one function is
// what lets the day and month report screens reuse the entire downtime read
// path unchanged rather than growing a parallel one.
//
// THE ARITHMETIC STAYS IN POSTGRES for the same reason resolveShiftWindow's
// does, and the stakes rise with the grain: a month is the case where a naive
// `from + 30 days` is wrong. Across a DST transition a calendar month is 743 or
// 745 real hours, not 744, and an availability figure computed against the wrong
// denominator renders a plausible chart rather than throwing. A YEAR compounds
// both — 8,759 or 8,761 hours across a transition, and 8,784 in a leap year, so
// `from + 365 days` is wrong roughly one year in four AND at every DST boundary.
// `AT TIME ZONE` applied to a date arrived at by DATE arithmetic gets all of this
// right by construction — the offset is resolved for each boundary's own date.
//
// For a month or year grain, `date` may be any day inside the period; it is
// truncated here. Callers pass the row's `business_date`, which is already the
// first — `ck_*_month_start` and `ck_*_year_start` make that a schema guarantee
// rather than a convention.
async function resolveReportWindow(
  db: PostgresDB,
  grain: ReportGrain,
  date: string,
  shift: ShiftId | undefined,
  timeZone: string,
): Promise<ShiftWindow> {
  if (grain === "shift") {
    // Not a 500 waiting to happen: the DTO refines `shift` to be present when
    // grain is "shift", and a report row always knows its own. This is the
    // guard that keeps that promise checkable rather than assumed.
    if (shift === undefined) {
      throw new Error(`a shift-grain window needs a shift (date ${date})`);
    }
    return resolveShiftWindow(db, date, shift, timeZone);
  }

  // Three explicit statements rather than one with an interpolated unit. The day
  // bounds need no truncation and the coarse ones do, and a single query covering
  // all three reads worse than the set.
  //
  // THE YEAR ARM IS THE MONTH ARM WITH ONE WORD CHANGED, and it must stay that
  // way: `date_trunc` on BOTH ends, so the window is [Jan 1 07:00, next Jan 1
  // 07:00). A `+ interval '1 year'` applied to an untruncated date would give a
  // correct-LENGTH window starting wherever the caller's date fell — a plausible
  // 8,760 hours, about the wrong twelve months.
  const rows =
    grain === "day"
      ? await db<ShiftWindow[]>`
          SELECT ((${date}::date + ${DAY_START_TIME}::time) AT TIME ZONE ${timeZone}) AS "from",
                 (((${date}::date + 1) + ${DAY_START_TIME}::time)
                   AT TIME ZONE ${timeZone}) AS "to"
        `
      : grain === "month"
        ? await db<ShiftWindow[]>`
            SELECT ((date_trunc('month', ${date}::date)::date + ${DAY_START_TIME}::time)
                     AT TIME ZONE ${timeZone}) AS "from",
                   (((date_trunc('month', ${date}::date) + interval '1 month')::date
                       + ${DAY_START_TIME}::time)
                     AT TIME ZONE ${timeZone}) AS "to"
          `
        : await db<ShiftWindow[]>`
            SELECT ((date_trunc('year', ${date}::date)::date + ${DAY_START_TIME}::time)
                     AT TIME ZONE ${timeZone}) AS "from",
                   (((date_trunc('year', ${date}::date) + interval '1 year')::date
                       + ${DAY_START_TIME}::time)
                     AT TIME ZONE ${timeZone}) AS "to"
          `;

  const window = rows[0];
  // Same reasoning as resolveShiftWindow's guard: unreachable with a validated
  // date, and a silent undefined here becomes a NaN-width window much later.
  if (window === undefined) {
    throw new Error(`could not resolve ${grain} window for ${date}`);
  }

  return window;
}

// The SAME arithmetic as resolveShiftWindow, read backwards, in the shape a SQL
// bind needs.
//
// WHY THE INVERSE EXISTS AT ALL
//
// resolveShiftWindow answers "which instants does this shift cover". The
// downtime-edit freeze asks the opposite: "which shifts does this stop cover".
// A stop straddling 23:00 belongs to BOTH shifts it touches — the rule
// scopeAndWindow already encodes for reads — so an edit to it can move the
// numbers on either report, and both have to be checked for an approval.
//
// WHY IT IS THREE ARRAYS AND NOT A DURATION
//
// `work_unit_shift_reports.date` is the shift's START instant, so the tempting
// version is `date + interval '8 hours'`. Every window here IS eight hours, and
// that would be correct today and wrong in a plant that observes DST: eight
// WALL-CLOCK hours across a transition is seven or nine real ones, and
// timestamptz arithmetic adds real ones. The plant is Asia/Jakarta today, but
// TimeZoneResolver resolves the zone per work unit precisely because that is not
// a permanent assumption.
//
// So the end instant is rebuilt exactly as resolveShiftWindow builds it —
// recover the business date from the start instant, add endDayOffset, add
// endTime, and let AT TIME ZONE resolve the offset FOR THAT DATE:
//
//   (((date AT TIME ZONE tz)::date + end_day_offset) + end_time) AT TIME ZONE tz
//
// DERIVED from SHIFT_WINDOWS rather than written out, so there is still exactly
// one statement of where a shift ends. A second copy would be the arithmetic
// divergence this whole file exists to prevent.
const SHIFT_END_BOUNDS = {
  shifts: SHIFT_IDS.map(Number),
  endDayOffsets: SHIFT_IDS.map((id) => SHIFT_WINDOWS[id].endDayOffset),
  endTimes: SHIFT_IDS.map((id) => SHIFT_WINDOWS[id].endTime),
} as const;

export {
  DAY_START_HOUR,
  DAY_START_TIME,
  MAX_OPEN_DOWNTIME_DAYS,
  REPORT_GRAINS,
  resolveReportWindow,
  resolveShiftWindow,
  SHIFT_END_BOUNDS,
  SHIFT_IDS,
  SHIFT_WINDOWS,
  toShiftId,
};
export type { ReportGrain, ShiftId, ShiftWindow };
