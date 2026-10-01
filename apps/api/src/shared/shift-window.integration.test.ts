// Integration coverage for `resolveReportWindow`, against a REAL Postgres.
//
// WHY THIS NEEDS A DATABASE AND CANNOT BE A UNIT TEST
//
// The whole point of building these windows in SQL is `AT TIME ZONE`: it
// resolves the plant's offset FOR THE DATE it is applied to, using the IANA
// database Postgres ships. Faking that is faking the only thing under test.
// A `fakeSql` here could assert the query text and would tell you nothing about
// whether a month is the right number of hours long.
//
// THE FAILURES THIS FILE EXISTS TO CATCH ARE ALL SILENT
//
//   1. A day or month window off by an hour across a DST transition. Nothing
//      throws. It changes the denominator of every availability figure on the
//      screen and renders a plausible chart — the same failure class the
//      work-unit aggregates suite was written for.
//   2. A day window that is not exactly the span of its three shifts. A day
//      report's totals would then disagree with the sum of the shift reports
//      underneath it, which is the single invariant
//      docs/gold-write-contract.md §15.6 asks the pipeline to assert.
//   3. A month window built with `date_trunc` on one end but not the other, so
//      the last day or the first is dropped. Off by one day in ~30 looks like a
//      slightly quiet month.
//
// Asia/Jakarta is UTC+7 with NO DST, so it is the zone where every naive
// implementation happens to work — which is exactly why the DST cases below use
// America/Chicago instead. A suite that only tested the plant's own zone would
// pass on an implementation that adds 24 hours.
//
//   docker run --rm -d --name oee-itest-pg18 -p 55434:5432 \
//     -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=gold_test postgres:18-alpine
//   GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/gold_test \
//     pnpm --filter api exec vp test shift-window
//
// The `oee` schema is not needed — every query here is pure date arithmetic
// against no table — but the suite skips on the same variable as its siblings so
// there is one switch for "do I have a database".
import { afterAll, describe, expect, it } from "vite-plus/test";

import { createPostgresDb } from "./database/postgres.js";
import { resolveReportWindow, resolveShiftWindow, SHIFT_IDS } from "./shift-window.js";

import type { GoldDB } from "./database/postgres.js";

const url = process.env.GOLD_TEST_DATABASE_URL;

// The plant. UTC+7, no DST — the easy case, and the one everything else is
// compared against.
const JAKARTA = "Asia/Jakarta";

// A zone that actually transitions, so the arithmetic is exercised rather than
// merely evaluated. Chicago springs forward 2026-03-08 and falls back
// 2026-11-01, both at 02:00 local.
const CHICAGO = "America/Chicago";

const HOUR_MS = 60 * 60 * 1000;

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

describe.skipIf(!url)("resolveReportWindow", () => {
  const db = createPostgresDb({
    connectionString: url!,
    max: 2,
    applicationName: "api-integration-test",
  }) as GoldDB;

  afterAll(async () => {
    await db.end();
  });

  describe("day grain", () => {
    // THE INVARIANT THE COMMENT ON DAY_START_TIME PROMISES. A business day is
    // not an independent fact — it is exactly what shifts 1, 2 and 3 cover. If
    // these ever drift apart, a day report stops being the sum of its shifts and
    // nothing else in the system notices.
    it("spans exactly shift 1's start to shift 3's end", async () => {
      const day = await resolveReportWindow(db, "day", "2026-08-01", undefined, JAKARTA);
      const shift1 = await resolveShiftWindow(db, "2026-08-01", "1", JAKARTA);
      const shift3 = await resolveShiftWindow(db, "2026-08-01", "3", JAKARTA);

      expect(day.from).toEqual(shift1.from);
      expect(day.to).toEqual(shift3.to);
    });

    // Stated separately from the equality above because it is the thing a reader
    // actually wants to know, and because it would still hold if all three
    // shifts moved together.
    it("starts at 07:00 plant-local and runs 24 hours in a zone without DST", async () => {
      const day = await resolveReportWindow(db, "day", "2026-08-01", undefined, JAKARTA);

      // 07:00 in UTC+7 is 00:00Z the same day.
      expect(day.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
      expect(day.to.toISOString()).toBe("2026-08-02T00:00:00.000Z");
      expect(hoursBetween(day.from, day.to)).toBe(24);
    });

    // The three shifts tile the day with no gap and no overlap. A day that were
    // 24 hours long but misaligned would pass the length check above.
    it("is tiled exactly by its three shifts", async () => {
      const day = await resolveReportWindow(db, "day", "2026-08-01", undefined, JAKARTA);
      const shifts = await Promise.all(
        SHIFT_IDS.map((id) => resolveShiftWindow(db, "2026-08-01", id, JAKARTA)),
      );

      const covered = shifts.reduce((total, s) => total + hoursBetween(s.from, s.to), 0);
      expect(covered).toBe(hoursBetween(day.from, day.to));

      // Each shift begins where the previous ended.
      expect(shifts[0]!.from).toEqual(day.from);
      expect(shifts[1]!.from).toEqual(shifts[0]!.to);
      expect(shifts[2]!.from).toEqual(shifts[1]!.to);
      expect(shifts[2]!.to).toEqual(day.to);
    });

    // FAILURE MODE F1, at day grain. `from + 24h` passes every test above and
    // fails these.
    //
    // THE TRANSITION BELONGS TO THE BUSINESS DAY THAT STARTS THE CALENDAR DAY
    // BEFORE IT, and that is not a quirk of this implementation — it follows
    // from the 07:00 boundary. Chicago springs forward at 02:00 on Mar 8, which
    // is five hours BEFORE the business day named "2026-03-08" begins, so it
    // falls inside the one named "2026-03-07" (Mar 7 07:00 -> Mar 8 07:00).
    //
    // Getting this backwards is the plausible mistake: you would shorten the
    // wrong day by an hour, both days would still be 23 or 24 hours long, and
    // the totals would still sum to the right month.
    it("puts the spring-forward hour in the business day that starts the day before", async () => {
      const owns = await resolveReportWindow(db, "day", "2026-03-07", undefined, CHICAGO);
      const next = await resolveReportWindow(db, "day", "2026-03-08", undefined, CHICAGO);

      expect(hoursBetween(owns.from, owns.to)).toBe(23);
      expect(hoursBetween(next.from, next.to)).toBe(24);
    });

    it("puts the fall-back hour in the business day that starts the day before", async () => {
      const owns = await resolveReportWindow(db, "day", "2026-10-31", undefined, CHICAGO);
      const next = await resolveReportWindow(db, "day", "2026-11-01", undefined, CHICAGO);

      expect(hoursBetween(owns.from, owns.to)).toBe(25);
      expect(hoursBetween(next.from, next.to)).toBe(24);
    });
  });

  describe("month grain", () => {
    it("runs from the first business day 07:00 to the next month's first at 07:00", async () => {
      const month = await resolveReportWindow(db, "month", "2026-08-01", undefined, JAKARTA);

      expect(month.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
      expect(month.to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
      expect(hoursBetween(month.from, month.to)).toBe(31 * 24);
    });

    // Callers pass the row's `business_date`, which is already the first of the
    // month — but the month table is keyed on a date and nothing enforces which
    // one, so truncating defensively is cheaper than discovering a report that
    // starts on the 14th.
    it("truncates to the month, so any day inside it gives the same window", async () => {
      const first = await resolveReportWindow(db, "month", "2026-08-01", undefined, JAKARTA);
      const middle = await resolveReportWindow(db, "month", "2026-08-17", undefined, JAKARTA);
      const last = await resolveReportWindow(db, "month", "2026-08-31", undefined, JAKARTA);

      expect(middle).toEqual(first);
      expect(last).toEqual(first);
    });

    it("covers February in a leap year and in a common year", async () => {
      const leap = await resolveReportWindow(db, "month", "2028-02-01", undefined, JAKARTA);
      const common = await resolveReportWindow(db, "month", "2026-02-01", undefined, JAKARTA);

      expect(hoursBetween(leap.from, leap.to)).toBe(29 * 24);
      expect(hoursBetween(common.from, common.to)).toBe(28 * 24);
    });

    // FAILURE MODE F1, at month grain, and the reason it is worth a container.
    // A month that contains a transition is 743 or 745 real hours, never 744.
    // An availability figure divided by 744 is wrong by ~0.13% and looks
    // completely reasonable, which is why no reviewer would catch it.
    it("is 743 hours in a month that springs forward", async () => {
      const march = await resolveReportWindow(db, "month", "2026-03-01", undefined, CHICAGO);

      expect(hoursBetween(march.from, march.to)).toBe(31 * 24 - 1);
    });

    // THE SURPRISING ONE, AND THE REASON IT IS SPELLED OUT RATHER THAN FOLDED
    // INTO THE TEST ABOVE.
    //
    // Chicago falls back at 02:00 on NOVEMBER 1st. The November month window
    // does not begin until 07:00 that morning, so the extra hour is five hours
    // too early to be in it — it lands in OCTOBER's window, which runs to Nov 1
    // 07:00. November is therefore an ordinary 720 hours and October is 745.
    //
    // Anyone reading a monthly report would expect the reverse, and any
    // reimplementation that trims the hour from November instead will agree with
    // intuition and disagree with the plant. The pipeline has to reproduce this
    // too — docs/gold-write-contract.md §15.3 states the boundary it follows
    // from.
    it("attributes November's fall-back hour to OCTOBER, not November", async () => {
      const october = await resolveReportWindow(db, "month", "2026-10-01", undefined, CHICAGO);
      const november = await resolveReportWindow(db, "month", "2026-11-01", undefined, CHICAGO);

      expect(hoursBetween(october.from, october.to)).toBe(31 * 24 + 1);
      expect(hoursBetween(november.from, november.to)).toBe(30 * 24);
    });

    // A month is exactly its days, for the same reason a day is exactly its
    // shifts — and it has to hold in a DST month too, which is where a naive
    // implementation stops agreeing with itself.
    // October, deliberately: it is the month that actually contains a transition
    // under the 07:00 boundary, so this is the case where a day loop and a month
    // window can disagree. Over a quiet month they agree trivially.
    it("equals the sum of its day windows, including across a transition", async () => {
      const month = await resolveReportWindow(db, "month", "2026-10-01", undefined, CHICAGO);

      let covered = 0;
      for (let d = 1; d <= 31; d++) {
        const date = `2026-10-${String(d).padStart(2, "0")}`;
        const day = await resolveReportWindow(db, "day", date, undefined, CHICAGO);
        covered += hoursBetween(day.from, day.to);
      }

      expect(covered).toBe(hoursBetween(month.from, month.to));
      expect(covered).toBe(31 * 24 + 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // YEAR GRAIN — `0027`, and every failure below is the month's one compounded
  // ───────────────────────────────────────────────────────────────────────────
  //
  // A year is 8,760 or 8,784 hours BEFORE any DST is considered, and 8,759 or
  // 8,761 after. So `from + 365 days` is wrong roughly one year in four AND at
  // every transition — two independent ways to produce a denominator that is off
  // by a fraction of a percent and a chart nobody can see is wrong.
  describe("year grain", () => {
    it("runs from January 1 07:00 to the next January 1 at 07:00", async () => {
      const year = await resolveReportWindow(db, "year", "2026-01-01", undefined, JAKARTA);

      // Jakarta is UTC+7, so 07:00 plant-local IS 00:00Z on the same date — the
      // month cases above read the same way.
      expect(year.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(year.to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
      expect(hoursBetween(year.from, year.to)).toBe(365 * 24);
    });

    // `ck_*_year_start` guarantees callers pass January 1, but the truncation is
    // defensive for the month arm's reason — and here it matters more, because a
    // window that started mid-year would still be the RIGHT LENGTH and cover the
    // wrong twelve months.
    it("truncates to the year, so any day inside it gives the same window", async () => {
      const first = await resolveReportWindow(db, "year", "2026-01-01", undefined, JAKARTA);
      const middle = await resolveReportWindow(db, "year", "2026-07-17", undefined, JAKARTA);
      const last = await resolveReportWindow(db, "year", "2026-12-31", undefined, JAKARTA);

      expect(middle).toEqual(first);
      expect(last).toEqual(first);
    });

    // A LEAP YEAR IS 8,784 HOURS. `+ interval '1 year'` on a date gets this right;
    // a day count does not, and the error is one day in 366.
    it("covers a leap year and a common year", async () => {
      const leap = await resolveReportWindow(db, "year", "2028-01-01", undefined, JAKARTA);
      const common = await resolveReportWindow(db, "year", "2026-01-01", undefined, JAKARTA);

      expect(hoursBetween(leap.from, leap.to)).toBe(366 * 24);
      expect(hoursBetween(common.from, common.to)).toBe(365 * 24);
    });

    // BOTH TRANSITIONS FALL INSIDE ONE YEAR, so they cancel and a Chicago year is
    // an ordinary 8,760 hours. That is the answer, and it is worth pinning
    // PRECISELY BECAUSE IT LOOKS LIKE THE NAIVE ONE: an implementation that
    // ignored DST entirely would pass this and fail the month suite above, so
    // this case is only meaningful beside those.
    it("is 8,760 hours in a DST zone, because the two transitions cancel", async () => {
      const year = await resolveReportWindow(db, "year", "2026-01-01", undefined, CHICAGO);

      expect(hoursBetween(year.from, year.to)).toBe(365 * 24);
    });

    // A YEAR IS EXACTLY ITS TWELVE MONTHS, for the same reason a month is exactly
    // its days and a day is exactly its three shifts. This is the mechanical guard
    // that the year arm truncates BOTH ends: a `date_trunc` on one end only
    // produces a window of the right length that does not tile its months.
    //
    // Chicago, so both transitions are inside the range and the month windows
    // being tiled are 743 and 745 rather than uniform.
    it("equals the sum of its twelve month windows", async () => {
      const year = await resolveReportWindow(db, "year", "2026-01-01", undefined, CHICAGO);

      let covered = 0;
      for (let m = 1; m <= 12; m++) {
        const date = `2026-${String(m).padStart(2, "0")}-01`;
        const month = await resolveReportWindow(db, "month", date, undefined, CHICAGO);
        covered += hoursBetween(month.from, month.to);
      }

      expect(covered).toBe(hoursBetween(year.from, year.to));
      expect(covered).toBe(365 * 24);
    });
  });

  describe("shift grain", () => {
    it("delegates to resolveShiftWindow", async () => {
      const viaGrain = await resolveReportWindow(db, "shift", "2026-08-01", "3", JAKARTA);
      const direct = await resolveShiftWindow(db, "2026-08-01", "3", JAKARTA);

      expect(viaGrain).toEqual(direct);
    });

    // The DTO refines this away, so reaching it means a caller constructed the
    // arguments by hand. Throwing is the point: the alternative — quietly
    // treating it as a day — would produce a report three times too long with
    // nothing to indicate it.
    it("throws rather than guessing when the shift is missing", async () => {
      await expect(
        resolveReportWindow(db, "shift", "2026-08-01", undefined, JAKARTA),
      ).rejects.toThrow(/needs a shift/);
    });
  });
});
