import { describe, it, expect } from "vite-plus/test";

import {
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
  toBusinessDay,
} from "./format";

// The plant this service was built for. Chosen deliberately: a positive offset
// with no DST, so a case that breaks under a naive local-time read fails here
// rather than passing by accident in a UTC CI container.
const JAKARTA = "Asia/Jakarta"; // UTC+7, no DST

describe("formatClock", () => {
  it("renders an instant in the plant's zone, not the browser's", () => {
    // 10:29Z is 17:29 in Jakarta — the exact value the design's tooltip shows.
    expect(formatClock("2026-08-09T10:29:00.000Z", JAKARTA)).toBe("17:29");
  });

  it("uses a 24-hour clock with a zero-padded hour", () => {
    expect(formatClock("2026-08-09T01:05:00.000Z", JAKARTA)).toBe("08:05");
    expect(formatClock("2026-08-09T00:00:00.000Z", "UTC")).toBe("00:00");
  });

  // Midnight is the case that renders as "24:00" under some locale defaults,
  // which is why hourCycle is pinned rather than inferred.
  it("renders midnight as 00:00, never 24:00", () => {
    expect(formatClock("2026-08-09T17:00:00.000Z", JAKARTA)).toBe("00:00");
  });

  it("covers all three shift boundaries", () => {
    // 07:00, 15:00 and 23:00 Jakarta are 00:00Z, 08:00Z and 16:00Z.
    expect(formatClock("2026-08-09T00:00:00.000Z", JAKARTA)).toBe("07:00");
    expect(formatClock("2026-08-09T08:00:00.000Z", JAKARTA)).toBe("15:00");
    expect(formatClock("2026-08-09T16:00:00.000Z", JAKARTA)).toBe("23:00");
  });

  // Shift 3 runs 23:00 -> 07:00 the next day. Both ends must read as wall-clock
  // times; nothing in the tooltip says which calendar day it is.
  it("renders a midnight-crossing shift's ends correctly", () => {
    expect(formatClock("2026-08-09T16:00:00.000Z", JAKARTA)).toBe("23:00");
    expect(formatClock("2026-08-10T00:00:00.000Z", JAKARTA)).toBe("07:00");
  });

  it("honours a different zone for the same instant", () => {
    expect(formatClock("2026-08-09T10:29:00.000Z", "UTC")).toBe("10:29");
    expect(formatClock("2026-08-09T10:29:00.000Z", "Asia/Tokyo")).toBe("19:29");
  });

  it("falls back rather than throwing on an unknown zone", () => {
    // core-api validates the zone against the IANA database before it leaves
    // master-data, so this should be unreachable — but throwing from a render
    // would take the whole report page down.
    expect(formatClock("2026-08-09T10:29:00.000Z", "Mars/Olympus")).toBe("10:29");
  });

  it.each([null, undefined, "", "not-a-date"])("renders %s as an em dash", (input) => {
    expect(formatClock(input, JAKARTA)).toBe(EM_DASH);
  });
});

describe("formatClockSeconds", () => {
  it("renders an instant with seconds in the plant's zone", () => {
    expect(formatClockSeconds("2026-08-09T10:29:14.000Z", JAKARTA)).toBe("17:29:14");
  });

  // The hourly performance chart labels its buckets as `HH:MM:SS - HH:MM:SS`, so a
  // whole hour has to render its zeroes rather than collapsing them.
  it("keeps the zero minutes and seconds of a whole hour", () => {
    expect(formatClockSeconds("2026-08-09T16:00:00.000Z", JAKARTA)).toBe("23:00:00");
  });

  // Load-bearing rather than cosmetic: an hour bucket ENDING at midnight is the
  // upper label of the 23:00-00:00 bucket, and `24:00:00` there would read as a
  // 25th hour of the day.
  it("renders midnight as 00:00:00, never 24:00:00", () => {
    expect(formatClockSeconds("2026-08-09T17:00:00.000Z", JAKARTA)).toBe("00:00:00");
  });

  it("covers all three shift boundaries", () => {
    expect(formatClockSeconds("2026-08-09T00:00:00.000Z", JAKARTA)).toBe("07:00:00");
    expect(formatClockSeconds("2026-08-09T08:00:00.000Z", JAKARTA)).toBe("15:00:00");
    expect(formatClockSeconds("2026-08-09T16:00:00.000Z", JAKARTA)).toBe("23:00:00");
  });

  it("falls back rather than throwing on an unknown zone", () => {
    expect(formatClockSeconds("2026-08-09T10:29:14.000Z", "Mars/Olympus")).toBe("10:29:14");
  });

  it.each([null, undefined, "", "not-a-date"])("renders %s as an em dash", (input) => {
    expect(formatClockSeconds(input, JAKARTA)).toBe(EM_DASH);
  });
});

describe("formatDateTime", () => {
  it("renders dd/MM/yyyy HH:mm in the plant's zone", () => {
    // 07:23Z is 14:23 in Jakarta — the value in the Downtime Details mockup.
    expect(formatDateTime("2026-08-11T07:23:00.000Z", JAKARTA)).toBe("11/08/2026 14:23");
  });

  // Locales put a comma between the date and the time, and ICU versions disagree
  // about whether it is there at all — hence composing from parts.
  it("puts no comma between the date and the time", () => {
    expect(formatDateTime("2026-08-11T07:23:00.000Z", JAKARTA)).not.toContain(",");
  });

  it("zero-pads the day and month", () => {
    expect(formatDateTime("2026-01-05T02:07:00.000Z", "UTC")).toBe("05/01/2026 02:07");
  });

  // The plant offset can roll the date over, which is the whole reason this is
  // not formatted in the browser's zone.
  it("carries the date across midnight in the plant's zone", () => {
    // 18:30Z on the 10th is 01:30 on the 11th in Jakarta.
    expect(formatDateTime("2026-08-10T18:30:00.000Z", JAKARTA)).toBe("11/08/2026 01:30");
  });

  it("falls back rather than throwing on an unknown zone", () => {
    expect(formatDateTime("2026-08-11T07:23:00.000Z", "Mars/Olympus")).toBe("11/08/2026 07:23");
  });

  it.each([null, undefined, "", "not-a-date"])("renders %s as an em dash", (input) => {
    expect(formatDateTime(input, JAKARTA)).toBe(EM_DASH);
  });
});

// `date` on a shift report is the instant the shift STARTED, not a calendar day, so
// every reading of it needs the plant's zone. At UTC+7 all three shift starts share
// a calendar date with their UTC instant, which is why a UTC read passed for so long
// — the CHICAGO cases below are the ones that would have caught it.
describe("toBusinessDay", () => {
  it.each([
    ["shift 1", "2026-08-09T00:00:00.000Z"], // 07:00 Jakarta
    ["shift 2", "2026-08-09T08:00:00.000Z"], // 15:00 Jakarta
    ["shift 3", "2026-08-09T16:00:00.000Z"], // 23:00 Jakarta
  ])("puts %s on the business day the shift started", (_label, iso) => {
    expect(toBusinessDay(iso, JAKARTA)).toBe("2026-08-09");
  });

  // The regression guard. A 23:00 shift-3 start at UTC-5 is already tomorrow in UTC,
  // so slicing the ISO string — or reading it in UTC — names the wrong day.
  it("reads the day in the plant's zone, not UTC", () => {
    const shift3AtChicago = "2026-08-10T04:00:00.000Z"; // 23:00 on 08-09, UTC-5

    expect(toBusinessDay(shift3AtChicago, "America/Chicago")).toBe("2026-08-09");
    expect(toBusinessDay(shift3AtChicago, "UTC")).toBe("2026-08-10");
  });

  // No instant to convert, so converting would only shift it.
  it("passes an already-bare day through untouched", () => {
    expect(toBusinessDay("2026-08-09", "America/Chicago")).toBe("2026-08-09");
  });

  it.each([null, undefined, "", "09/08/2026", "2026-8-9"])(
    "returns undefined for %s rather than a malformed day",
    (input) => {
      expect(toBusinessDay(input, JAKARTA)).toBeUndefined();
    },
  );
});

describe("formatDuration", () => {
  it("drops leading zero units but keeps interior ones", () => {
    expect(formatDuration(12_434_000)).toBe("03 h 27 m 14 s");
    expect(formatDuration(10_814_000)).toBe("03 h 00 m 14 s");
    expect(formatDuration(74_000)).toBe("01 m 14 s");
    expect(formatDuration(28_000)).toBe("28 s");
  });

  it("rounds to the nearest second before decomposing", () => {
    // The columns are float8, so 59_600 ms must carry rather than truncate.
    expect(formatDuration(59_600)).toBe("01 m 00 s");
  });

  // Reduce-speed loss goes negative when a machine outran its standard rate.
  it("renders a negative duration with a single leading minus", () => {
    expect(formatDuration(-74_000)).toBe("-01 m 14 s");
  });

  it("renders zero as 00 s", () => {
    expect(formatDuration(0)).toBe("00 s");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "renders %s as an em dash",
    (input) => {
      expect(formatDuration(input)).toBe(EM_DASH);
    },
  );
});

describe("formatPercent", () => {
  it("keeps up to three decimals and strips trailing zeros", () => {
    expect(formatPercent(97.558)).toBe("97.558%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(0)).toBe("0%");
  });

  it("does not group thousands", () => {
    expect(formatPercent(1234.5)).toBe("1234.5%");
  });

  it.each([null, undefined, Number.NaN])("renders %s as an em dash", (input) => {
    expect(formatPercent(input)).toBe(EM_DASH);
  });
});

describe("formatQuantity", () => {
  it("appends the unit of measure when there is one", () => {
    expect(formatQuantity(12_924, "BAG")).toBe("12924 BAG");
  });

  // A null uom must not leak "null" or a trailing space into the tile.
  it("omits a null unit of measure cleanly", () => {
    expect(formatQuantity(12_924, null)).toBe("12924");
  });

  it("renders a null value as an em dash", () => {
    expect(formatQuantity(null, "BAG")).toBe(EM_DASH);
  });
});

describe("formatReportDate", () => {
  it("renders the weekday and day in the plant's zone", () => {
    expect(formatReportDate("2026-08-09T00:00:00.000Z", JAKARTA)).toBe("Sunday, 09/08/2026");
  });

  // A shift 3 that starts at 23:00 local is the next day in UTC, so the weekday and
  // the date both move if the zone is ignored.
  it("does not let a late shift roll over into the next day", () => {
    expect(formatReportDate("2026-08-09T16:00:00.000Z", JAKARTA)).toBe("Sunday, 09/08/2026");
    expect(formatReportDate("2026-08-10T04:00:00.000Z", "America/Chicago")).toBe(
      "Sunday, 09/08/2026",
    );
  });

  it.each([null, undefined, "", "not-a-date"])("renders %s as an em dash", (input) => {
    expect(formatReportDate(input, JAKARTA)).toBe(EM_DASH);
  });

  // A null zone means master-data could not say where the plant is, so the day is
  // genuinely unknown — better a dash than a plausible wrong date.
  it("renders an em dash when the zone is unknown", () => {
    expect(formatReportDate("2026-08-09T16:00:00.000Z", null)).toBe(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// Business dates
// ---------------------------------------------------------------------------
//
// THE WHOLE POINT OF THESE TWO IS THAT THEY DO NOT CONVERT A ZONE, so the tests
// that matter are the ones a zone-converting implementation would fail.
//
// `businessDate` arrives from the server already resolved in the plant's zone
// (migration 0013). Handing it to formatReportDate makes `new Date` read
// '2026-08-01' as UTC MIDNIGHT, and converting UTC midnight into any zone west
// of Greenwich lands on the previous day — so every row would render the day
// before the one it is about, and look entirely normal doing it.
describe("formatBusinessDate", () => {
  it("renders the weekday and the day itself", () => {
    expect(formatBusinessDate("2026-08-01")).toBe("Saturday, 01/08/2026");
  });

  // THE REGRESSION GUARD. A zone-converting implementation returns the 31st of
  // July here for a western plant; this one cannot, because it never builds a
  // zoned Date at all. Asserted on the first of a month, where an off-by-one
  // crosses a month boundary and is therefore unmistakable.
  it("does not shift the day, whatever the machine's local zone is", () => {
    expect(formatBusinessDate("2026-01-01")).toBe("Thursday, 01/01/2026");
    expect(formatBusinessDate("2026-03-01")).toBe("Sunday, 01/03/2026");
  });

  it("pads single-digit days and months", () => {
    expect(formatBusinessDate("2026-02-09")).toBe("Monday, 09/02/2026");
  });

  it("handles a leap day", () => {
    expect(formatBusinessDate("2028-02-29")).toBe("Tuesday, 29/02/2028");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["an instant rather than a date", "2026-08-01T00:00:00.000Z"],
    ["an unpadded date", "2026-8-1"],
    ["a US-style date", "08/01/2026"],
    ["a well-shaped impossible month", "2026-13-01"],
  ])("returns an em dash for %s", (_name, input) => {
    expect(formatBusinessDate(input)).toBe("—");
  });
});

describe("formatMonthLabel", () => {
  it("names the month and the year", () => {
    expect(formatMonthLabel("2026-08-01")).toBe("August 2026");
  });

  // The year is not optional. The reference design shows "January" alone, which
  // is ambiguous the moment somebody opens a report from a previous year — and
  // the By Monthly list makes that one click away.
  it("always carries the year", () => {
    expect(formatMonthLabel("2025-01-01")).toBe("January 2025");
    expect(formatMonthLabel("2026-01-01")).toBe("January 2026");
  });

  it("reads the month from the date, not from any day-of-month assumption", () => {
    expect(formatMonthLabel("2026-12-31")).toBe("December 2026");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an instant", "2026-08-01T00:00:00.000Z"],
    ["a month with no day", "2026-08"],
    ["month zero", "2026-00-01"],
  ])("returns an em dash for %s", (_name, input) => {
    expect(formatMonthLabel(input)).toBe("—");
  });
});

// The OEE Performance dashboard's donuts show a MONTH of calendar time, where
// formatDuration prints "744 h 00 m 00 s" — correct, and a number nobody can size
// at a glance.
describe("formatLongDuration", () => {
  const DAY = 86_400_000;

  it("adds a days unit above hours", () => {
    expect(formatLongDuration(25 * DAY + 8 * 3_600_000)).toBe("25 d 08 h 00 m 00 s");
  });

  // DELEGATES under a day, rather than printing "0 d". The two formatters then
  // cannot disagree about the rules they share.
  it.each([
    [8 * 3_600_000 + 12 * 60_000 + 30_000, "08 h 12 m 30 s"],
    [28_000, "28 s"],
    [0, "00 s"],
  ])("is formatDuration below one day (%i)", (ms, expected) => {
    expect(formatLongDuration(ms)).toBe(expected);
  });

  // Interior zeros stay: two days and five minutes must not read as "2 d 05 m".
  it("keeps interior zero units", () => {
    expect(formatLongDuration(2 * DAY + 5 * 60_000)).toBe("2 d 00 h 05 m 00 s");
  });

  it("renders a negative duration as-is rather than as its magnitude", () => {
    expect(formatLongDuration(-(DAY + 3_600_000))).toBe("-1 d 01 h 00 m 00 s");
  });

  it.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "renders %s as an em dash",
    (ms) => {
      expect(formatLongDuration(ms as number)).toBe(EM_DASH);
    },
  );

  // Rounded before decomposing, like formatDuration: these come from float8
  // columns and a fractional second would otherwise leak into every unit.
  it("rounds to the nearest second before decomposing", () => {
    expect(formatLongDuration(DAY + 999)).toBe("1 d 00 h 00 m 01 s");
  });
});
