import { traced } from "./database/postgres.js";

import type { GoldDB } from "./database/postgres.js";
import type { Fragment } from "postgres";

// THE OEE CURVE UNDER A COARSE REPORT, once, for every subject and grain that has
// one.
//
// WHAT IT IS FOR. The OEE Performance dashboard asks a question none of the report
// screens do: not "what did this period total" but "which parts of it were bad".
// Nothing in Gold answered that and nothing could be made to — the day list
// endpoints filter by LINE, never by machine, and their 100-row page cap silently
// truncates at four machines times thirty-one days. So this reads the finer table
// directly, through the coarser row that names the window.
//
// IT IS SHARED ON ARRIVAL, which is unusual for this directory and is the reason
// it belongs here rather than in work-unit-repository.ts. There were three callers
// on day one and `0027` made it six:
//
//   subject  grain  outer table                    inner table                    scope column
//   machine  month  work_unit_month_reports        work_unit_day_reports          work_unit_id
//   machine  year   work_unit_year_reports         work_unit_month_reports        work_unit_id
//   line     month  work_center_month_reports      work_center_day_reports        work_center_id
//   line     year   work_center_year_reports       work_center_month_reports      work_center_id
//   area     month  area_month_reports             area_day_reports               area_id
//   area     year   area_year_reports              area_month_reports             area_id
//
// THE INNER TABLE IS ONE GRAIN FINER THAN THE OUTER, ALWAYS — a month report
// trends DAYS and a year report trends MONTHS. A year trending days would be ~365
// points on a four-series chart, which is a smear rather than a reading; the
// twelve-point curve also drills into month screens that exist.
//
// Factory is not a caller at any grain — it has no Gold table at all, and
// `oee.downtime_reports` has no `factory_id` (TODOS.md §74).
//
// THE TABLES ARE FRAGMENTS AND THE SCOPE COLUMN IS A STRING, and the split is not
// stylistic. postgres.js escapes `db(name)` as ONE identifier, dot included, so
// `db("oee.work_unit_day_reports")` names a table of that literal name in the
// search path rather than `work_unit_day_reports` in schema `oee` —
// WorkUnitReportReaderRepository.grainFrom records the same trap. A bare column
// has no dot, so `db(scopeColumn)` is the right tool there and is exactly how
// DowntimeReaderRepository applies SCOPE_COLUMN. Callers build the two fragments
// from hardcoded literals, which is what makes this uninjectable.

type OeeTrendPoint = {
  businessDate: string;
  // ALL FOUR RATES, because the dashboard plots them on ONE chart.
  //
  // It returned `oee` alone first, deliberately — the requirement named one
  // series. The other three arrived with the Availability / Performance / Quality
  // trends, and they belong on the same axis rather than in three more payloads:
  // they are the factors OEE is the product of, so the question a reader asks of
  // this chart is "OEE fell on the 19th — WHICH of them moved?", and that question
  // is unanswerable one series at a time.
  //
  // NULL IS NOT ZERO, and the dashboard renders them the same way for different
  // reasons. These are NOT NULL on the machine day table and nullable on the line
  // and area ones, where NULL means "could not be composed" — migration 0024's
  // third meaning of a null. Zero is a measurement: the machine ran and produced
  // nothing. Both draw as a gap in the trend, but only zero may ever be described
  // to a reader as zero percent.
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
};

// The envelope, identical in shape to ShiftProductCounts and every other sub-feed
// on these three modules. `loadedThrough` is what separates "this subject had a
// clean period" from "the sub-period rows have not arrived yet" — without it an
// empty series and an unloaded one are the same flat chart, and only one of them
// is true. See shared/database/watermark.ts.
//
// IT IS THE INNER TABLE'S WATERMARK, NOT THE OUTER'S, and each caller must pass
// the right one: a year curve reads the MONTH table, so reporting the day table's
// freshness there would claim a currency the curve does not have.
//
// NAMED `OeeTrend` RATHER THAN `MonthOeeTrend` since `0027`. It describes "the
// report's sub-periods" at two grains now, and a name asserting one grain is the
// kind of thing a reader trusts and should not.
type OeeTrend = {
  items: OeeTrendPoint[];
  timeZone: string;
  loadedThrough: string | null;
};

type OeeTrendQuery = {
  // The inner table's name as a plain string, for the tracing span only. It never
  // reaches the statement — `innerFrom` does.
  innerTable: string;
  outerFrom: Fragment;
  innerFrom: Fragment;
  // How long the OUTER row covers: `interval '1 month'` under a month report,
  // `interval '1 year'` under a year one. A Fragment rather than a string for the
  // reason the tables are — it is interpolated into the statement.
  //
  // THIS IS THE ONE PARAMETER THAT RENDERS A PLAUSIBLE CHART WHEN IT IS WRONG. A
  // year report joined with a one-month span draws January alone and labels it as
  // the year; a month report joined with a one-year span draws twelve months of
  // days under a month heading. Neither throws.
  span: Fragment;
  scopeColumn: string;
  reportId: number;
};

async function listOeeTrend(
  db: GoldDB,
  { innerTable, outerFrom, innerFrom, span, scopeColumn, reportId }: OeeTrendQuery,
): Promise<OeeTrendPoint[]> {
  return await traced("SELECT", innerTable, async () => {
    const scope = db(scopeColumn);

    const rows = await db<OeeTrendPoint[]>`
      SELECT to_char(d.business_date, 'YYYY-MM-DD')      AS business_date,
             round(d.oee::numeric, 3)::float8            AS oee,
             round(d.availability::numeric, 3)::float8   AS availability,
             round(d.performance::numeric, 3)::float8    AS performance,
             round(d.quality::numeric, 3)::float8        AS quality
      FROM ${outerFrom} r
      JOIN ${innerFrom} d
        -- The window is read OFF THE OUTER ROW rather than passed in, so no
        -- caller can hand this a date that disagrees with the report it is
        -- drawing. listPeriodProductCount joins the same way and for the reason.
        --
        -- business_date is the FIRST day of the outer period on every one of
        -- these tables (ck_*_month_start and ck_*_year_start make that a schema
        -- guarantee), so the lower bound needs no truncation here.
        ON  d.${scope} = r.${scope}
       AND  d.business_date >= r.business_date
       AND  d.business_date <  r.business_date + ${span}
      WHERE r.id = ${reportId}
      ORDER BY d.business_date ASC
    `;

    // HALF-OPEN, `>= from AND < to`, and it must stay that way — shared/report-window.ts
    // states the same rule for every other windowed read in this service. `BETWEEN`
    // here would be inclusive at both ends and pull the first sub-period of the NEXT
    // period into the curve: a 32nd day under a month, or a THIRTEENTH MONTH under a
    // year, at the right-hand edge of a chart where nothing looks wrong. The
    // integration test pins both.

    // to_char, not the bare column: postgres.js parses a `date` into a JS Date and
    // would put a zone back into the one value that exists to be free of one. A
    // business day is plant-local and is never re-zoned.
    return [...rows];
  });
}

export { listOeeTrend };
export type { OeeTrend, OeeTrendPoint, OeeTrendQuery };
