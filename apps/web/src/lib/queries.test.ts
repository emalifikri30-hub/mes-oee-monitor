import { describe, expect, it } from "vite-plus/test";

import {
  areaMonthOeeTrendQueryOptions,
  areaYearOeeTrendQueryOptions,
  machineYearOeeTrendQueryOptions,
  lineYearOeeTrendQueryOptions,
  lineMonthOeeTrendQueryOptions,
  machineMonthOeeTrendQueryOptions,
  reasonBreakdownParams,
  reportWindowParams,
} from "@/lib/queries";
import { lineReport, periodReport, shiftReport, skuReport } from "@/test/fixtures";

// THE WINDOW COMPOSER, AT BOTH SUBJECTS.
//
// `reportWindowParams` discriminates on SUBJECT as well as grain, so that a Line
// report resolves to `scope: "work-center"`. Its own comment explains
// why there must stay exactly one of it: the detail route's loader prefetches with
// it and each card subscribes with it, "so the two cannot key differently and
// fetch twice." A second composer beside it is a second chance to drift, and the
// only symptom would be a skeleton flash on a page that had already fetched.
//
// The work-unit cases below were written BEFORE that widening and are the reason
// they are here: if widening the function had let a machine report resolve to
// work-center scope, the machine timeline would silently render the whole LINE's
// stops. Same envelope, same colours, more bands — nothing on screen says it is
// wrong. They passed unchanged through the change, which is the whole value of
// having written them first.
//
// The object is also the react-query CACHE KEY, which is why the absence of
// `shift` at the coarse grains is asserted rather than assumed: a stray
// `shift: undefined` is a second key for an identical server page.

describe("reportWindowParams", () => {
  describe("shift grain", () => {
    it("scopes to the work unit", () => {
      const params = reportWindowParams(shiftReport({ workUnitId: 42 }));

      expect(params).toMatchObject({ scope: "work-unit", scopeId: 42, grain: "shift" });
    });

    // `date` is the shift's START INSTANT, so the business day only falls out of it
    // in the plant's zone. 2026-08-09T00:00Z is 07:00 on the 9th at Asia/Jakarta.
    it("reduces the start instant to a business day in the plant's zone", () => {
      const params = reportWindowParams(
        shiftReport({ date: "2026-08-09T00:00:00.000Z", timeZone: "Asia/Jakarta" }),
      );

      expect(params?.date).toBe("2026-08-09");
    });

    // THE SHIFT-3 CASE, which is the one a naive ISO string slice gets wrong. The
    // instant is 16:00Z; sliced it reads 2026-08-01 and happens to agree here, so
    // the west-of-Greenwich plant below is the assertion that actually bites.
    it("attributes a late shift to the business day the plant is on", () => {
      expect(
        reportWindowParams(
          shiftReport({ date: "2026-08-02T04:00:00.000Z", timeZone: "America/Chicago" }),
        )?.date,
      ).toBe("2026-08-01");
    });

    // A string, because query params are strings and core-api's SHIFT_WINDOWS is
    // keyed by "1" | "2" | "3" — while the column is a smallint.
    it("sends the shift as a string", () => {
      expect(reportWindowParams(shiftReport({ shift: 3 }))?.shift).toBe("3");
    });

    it("returns undefined when the date cannot be read", () => {
      expect(reportWindowParams(shiftReport({ date: "not-an-instant" }))).toBeUndefined();
    });
  });

  describe("coarse grains", () => {
    // NOTHING IS DERIVED — migration 0013 put `business_date` on the row as a real
    // date, so the browser reads it rather than reducing an instant through a zone.
    it("passes the day report's business date through untouched", () => {
      const params = reportWindowParams(periodReport({ grain: "day", businessDate: "2026-08-09" }));

      expect(params).toMatchObject({ scope: "work-unit", grain: "day", date: "2026-08-09" });
    });

    it("passes the month report's business date through untouched", () => {
      const params = reportWindowParams(
        periodReport({ grain: "month", businessDate: "2026-08-01", approval: null }),
      );

      expect(params).toMatchObject({ grain: "month", date: "2026-08-01" });
    });

    // Omitted, not `undefined`: this object is a cache key, and a key carrying an
    // undefined `shift` is a distinct entry for an identical server page.
    it("omits the shift key entirely", () => {
      const params = reportWindowParams(periodReport({ grain: "day" }));

      expect(params && "shift" in params).toBe(false);
    });

    // The same "cannot be looked up" state the shift path reaches when the zone
    // does not resolve — the cards already render a sentence for it.
    it("returns undefined when the pipeline has not written a business date", () => {
      expect(reportWindowParams(periodReport({ businessDate: null }))).toBeUndefined();
    });
  });
});

// THE LINE ARM. Added when the composer learned a second subject; the work-unit
// cases above are the regression surface that mattered, and these are what the
// widening was for.
describe("reportWindowParams — line reports", () => {
  it("scopes to the work centre, not the work unit", () => {
    const params = reportWindowParams(lineReport({ workCenterId: 9999 }));

    expect(params).toMatchObject({ scope: "work-center", scopeId: 9999, grain: "shift" });
  });

  // NOTHING IS DERIVED THROUGH A ZONE AT ANY LINE GRAIN. These rows have no
  // `date timestamptz` column at all (0014), so businessDate is read straight
  // through — there is no instant to reduce and no zone conversion to get wrong.
  it("reads the business date straight through at shift grain", () => {
    const params = reportWindowParams(lineReport({ businessDate: "2026-08-01", shift: 3 }));

    expect(params).toMatchObject({ date: "2026-08-01", shift: "3" });
  });

  it.each(["day", "month"] as const)("scopes a %s report to the work centre", (grain) => {
    const params = reportWindowParams(
      lineReport({ grain, shift: null, businessDate: "2026-08-01" }),
    );

    expect(params).toMatchObject({ scope: "work-center", grain, date: "2026-08-01" });
    expect(params && "shift" in params).toBe(false);
  });

  // THE REGRESSION THIS FILE EXISTS FOR, stated as an assertion rather than a
  // comment: the two subjects must not resolve to the same scope. A machine report
  // resolving to work-center scope draws the whole LINE's stops on a machine
  // timeline — same envelope, same colours, more bands, nothing saying it is wrong.
  it("never gives a machine report and a line report the same scope", () => {
    expect(reportWindowParams(shiftReport())?.scope).toBe("work-unit");
    expect(reportWindowParams(lineReport())?.scope).toBe("work-center");
  });
});

// THE SKU ARM, AND IT IS THE ONE THAT IS SCOPE **PLUS A PREDICATE**.
//
// A SKU report resolves to `scope: "work-center"` like a line one — a SKU ran on
// one line — so the scope half alone cannot distinguish them, and that is exactly
// how this shipped once with `productId` missing: the strip, the Downtime Details
// table and the Availability Paretos drew the WHOLE LINE's day under a SKU
// heading. Nothing in the types could see it, because the field is optional.
//
// So these assertions are about the PREDICATE, not the scope. The last one is the
// one that could not be written as a comment: a SKU report and its own line's day
// report, on the same line and the same date, must not produce the same object —
// because this object IS the react-query cache key, and whichever screen mounted
// second would render the other's stops.
describe("reportWindowParams — SKU reports", () => {
  it("carries the product as a filter beside the work-centre scope", () => {
    const params = reportWindowParams(skuReport({ workCenterId: 9, productId: 7 }));

    expect(params).toMatchObject({
      scope: "work-center",
      scopeId: 9,
      grain: "day",
      productId: 7,
    });
  });

  // A SKU report's businessDate is NOT NULL and zone-free (0023), so there is no
  // instant to reduce — the same straight-through read a line report gets.
  it("reads the business date straight through", () => {
    const params = reportWindowParams(skuReport({ businessDate: "2026-08-19" }));

    expect(params).toMatchObject({ date: "2026-08-19" });
    expect(params && "shift" in params).toBe(false);
  });

  // OMITTED, NOT `undefined`, on the other two subjects — the rule the coarse
  // grains' missing `shift` is already pinned for. A stray `productId: undefined`
  // is a second cache key for an identical server page.
  it("omits the product key entirely on machine and line reports", () => {
    const machine = reportWindowParams(shiftReport());
    const line = reportWindowParams(lineReport({ grain: "day", shift: null }));

    expect(machine && "productId" in machine).toBe(false);
    expect(line && "productId" in line).toBe(false);
  });

  it("never keys a SKU report the same as its own line's day report", () => {
    const sku = reportWindowParams(skuReport({ workCenterId: 3, businessDate: "2026-08-19" }));
    const line = reportWindowParams(
      lineReport({ grain: "day", shift: null, workCenterId: 3, businessDate: "2026-08-19" }),
    );

    expect(sku).not.toEqual(line);
  });
});

// Composed FROM reportWindowParams rather than built by hand, so the Losses
// loader's prefetch and the card's subscription cannot key differently. Pinned
// here because widening the composer must not change what this adds on top.
describe("reasonBreakdownParams", () => {
  it("adds the category to the window params", () => {
    expect(reasonBreakdownParams(shiftReport({ workUnitId: 42 }), "UNPLANNED")).toMatchObject({
      scope: "work-unit",
      scopeId: 42,
      grain: "shift",
      category: "UNPLANNED",
    });
  });

  it("stays undefined when the window itself cannot be resolved", () => {
    expect(reasonBreakdownParams(periodReport({ businessDate: null }), "PLANNED")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE TREND QUERY KEYS
// ─────────────────────────────────────────────────────────────────────────────
//
// A key test reads as ceremony and is not. `shared/oee-trend.ts` is parameterised
// by a table pair and a scope column, so all three endpoints return an IDENTICAL
// envelope — same four rates, same `items`/`timeZone`/`loadedThrough` shape. That
// is what makes a collision INVISIBLE: `oee.work_unit_month_reports`,
// `oee.work_center_month_reports` and `oee.area_month_reports` have independent
// identity sequences, so month report 7 exists at all three subjects and means
// three different things. Under a shared `["oee-trend", 7]` key, whichever screen
// mounted second would render the first's curve — populated, plausible, about
// another subject.
//
// The SUBJECT is therefore in the PREFIX, never a field beside the id, and these
// assertions are what stop a later "tidy-up" from collapsing them.
describe("the oee-trend query keys", () => {
  const keys = [
    machineMonthOeeTrendQueryOptions(7, true).queryKey,
    lineMonthOeeTrendQueryOptions(7, true).queryKey,
    areaMonthOeeTrendQueryOptions(7, true).queryKey,
    machineYearOeeTrendQueryOptions(7, true).queryKey,
    lineYearOeeTrendQueryOptions(7, true).queryKey,
    areaYearOeeTrendQueryOptions(7, true).queryKey,
  ];

  it("names its subject AND its grain in the prefix", () => {
    expect(keys).toEqual([
      ["work-unit-month-oee-trend", 7],
      ["work-center-month-oee-trend", 7],
      ["area-month-oee-trend", 7],
      ["work-unit-year-oee-trend", 7],
      ["work-center-year-oee-trend", 7],
      ["area-year-oee-trend", 7],
    ]);
  });

  // ONE ID, SIX CACHE ENTRIES. `0027` gave each of the three subjects a year table
  // with its own identity sequence, so report 7 now names six different reports —
  // and all six payloads have the SAME shape, which is what makes a collision
  // invisible rather than an error. Asserted over the serialised keys rather than by
  // eye, so a later "tidy-up" cannot silently reuse a prefix.
  it("gives one report id six distinct entries", () => {
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(6);
  });

  // A FINISHED PERIOD CAN NEVER CHANGE, so its curve caches forever. The flag is
  // passed in rather than derived inside the options, and this is the assertion
  // that catches `isMonthClosed` being handed the wrong report's date: an open
  // period cached at Infinity would never refetch, which on a live month means a
  // chart that stops updating with nothing to say so.
  it("caches a closed period forever and leaves an open one refetchable", () => {
    expect(machineMonthOeeTrendQueryOptions(7, true).staleTime).toBe(Infinity);
    expect(machineMonthOeeTrendQueryOptions(7, false).staleTime).not.toBe(Infinity);
  });
});
