-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE. `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more: psql reports the error and carries
-- straight on to the next statement, so the refusal prints and the seed runs
-- anyway. That was observed against the shared Gold database, not theorised —
-- 0015's header records it.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds in that directory, so a seed placed there would write denormalised
-- labels over whatever the pipeline had resolved, in every environment the
-- migrator touches.
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0024_work_center_area_id_dev.sql
--
-- RUN AFTER 0015, 0016, 0018, 0019 and 0021 — everything that writes a
-- work_center-keyed table — AND BEFORE 0022. Running it earlier leaves whichever
-- table had not been written yet with a NULL area_id; running it after 0022
-- leaves the area tables empty, because 0022 groups on exactly the column this
-- file fills.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE EXISTS: 0022 SAYS "RUN 0015 FIRST", AND 0015 WRITES NULL
-- ---------------------------------------------------------------------------
--
-- 0022's step 0 prints
--
--   "No line day report carries an area_id — run 0015_work_center_reports_dev.sql
--    first, or this file inserts nothing at all."
--
-- and following that instruction does not help, because 0015 is explicit that it
-- will not invent the column:
--
--   "The seed CANNOT derive these: work_unit_shift_reports has no area columns.
--    The pipeline reads them from mes-master-data, exactly as it already does for
--    oee.product_perf_wu_hour.area_id. Contract §16.6."
--
-- Every word of that is right about 0015's OWN inputs. It is the roll-up source
-- for the line tables, and it groups oee.work_unit_shift_reports, which carries
-- no area at all. So the line grain comes out area-less and the area grain then
-- has nothing to group by — the seed chain runs clean, reports success at every
-- step, and produces ZERO area reports. That is the gap this file closes, and it
-- is a gap in the SEEDS, not in the schema.
--
-- ---------------------------------------------------------------------------
-- WHY A BACKFILL IS THE CORRECT SHAPE, AND NOT AN INVENTION — TODOS.md §78
-- ---------------------------------------------------------------------------
--
-- §78 draws the line this file sits on, and it is the same distinction 0020 drew
-- between the two kinds of axis:
--
--   "`area_id` is CONTAINMENT — the area IS derivable from `work_unit_id`,
--    permanently — so a NULL is a missing LABEL and the fix is a backfill."
--
-- A missing label is recoverable from anywhere the label was already resolved. A
-- missing ATTRIBUTION (0020's `product_id`, OCCUPANCY OVER TIME) is not, which is
-- why that one ships a residual count instead of a backfill. This file is only
-- ever allowed to exist because area is the first kind and not the second.
--
-- SO IT INVENTS NOTHING. The mapping is READ from oee.downtime_reports, which
-- 0014 and 0020 populate from the identity supplied out of ms_core — the same
-- provenance 0020's header defends at length ("THE IDENTITY BELOW IS REAL. IT WAS
-- SUPPLIED FROM ms_core, NOT INVENTED"), and the same reason commit c9580a6 is
-- cited there: a label is not a key, and a made-up id renders in a table and is
-- then missing from the dropdown that filters it.
--
-- oee.downtime_log_events carries the same three columns from the same source and
-- is used as a CROSS-CHECK rather than a second source. If the two ever disagree
-- about a line's area, step 1 refuses rather than picking one.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT TOUCH
-- ---------------------------------------------------------------------------
--
--   * factory_id / factory_name — NOT filled, anywhere. The source tables stop at
--     area_name, so the level above the area is not in the data; 0022's own
--     comment says NULL rather than a guess and points at contract §25.4. This
--     file holds that line.
--   * Any row whose area_id is ALREADY SET. Every UPDATE below is guarded by
--     `area_id IS NULL`, so a pipeline that has started resolving the column wins
--     over this seed and a re-run is a no-op rather than a revert. That is the
--     `0013` "ON CONFLICT DO NOTHING" convention: a seed must never overwrite a
--     real answer with a derived one.
--   * oee.work_center_quality_entries — it has no area_id and deliberately so
--     (TODOS.md §79 is the open question about denormalising one).
--
-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
--
-- THE BYPASS IS A FLAG, NOT AN EDIT — 0014's convention: "a guard you have to
-- delete to proceed is a guard that gets deleted and left deleted." Both parts
-- must be in ONE psql invocation; a separate `-c` is a separate session and the
-- setting will not survive into this file.
DO $$
BEGIN
  IF current_database() = 'mes-master-data'
     AND coalesce(current_setting('seed.allow_shared', true), '') <> 'yes' THEN
    RAISE EXCEPTION
      'Refusing to seed the shared Gold database %. Point GOLD_DATABASE_URL at a local Postgres, or pass -c "SET seed.allow_shared = ''yes''" if you really mean it.',
      current_database();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — the mapping, and the refusal if it is ambiguous
-- ---------------------------------------------------------------------------
--
-- One row per work_center_id that any downtime row has an area for. The
-- assertions are the whole point of materialising it rather than joining inline:
-- a silently ambiguous mapping would push a line's whole week into the wrong
-- area's totals, and an area total that quietly absorbed another area's line is
-- the same class of wrong number 0020's duplicate-line story is about.
-- NOT `ON COMMIT DROP`. psql runs each of these statements in its own implicit
-- transaction, so an ON COMMIT DROP temp table is created and destroyed by the
-- same statement and step 2 then fails on a relation that does not exist. The
-- table is session-scoped, so it goes when psql exits; the explicit DROP at the
-- bottom is what makes a second run in one session work.
DROP TABLE IF EXISTS wc_area;
CREATE TEMP TABLE wc_area AS
SELECT work_center_id,
       min(area_id)                        AS area_id,
       min(area_name)                      AS area_name,
       count(DISTINCT area_id)             AS distinct_areas,
       count(DISTINCT coalesce(area_name, '')) AS distinct_names
  FROM oee.downtime_reports
 WHERE work_center_id IS NOT NULL
   AND area_id IS NOT NULL
 GROUP BY work_center_id;

DO $$
DECLARE
  lines_mapped integer;
  ambiguous    integer;
  conflicting  integer;
BEGIN
  SELECT count(*) INTO lines_mapped FROM wc_area;

  IF lines_mapped = 0 THEN
    RAISE EXCEPTION
      'No line has a resolvable area: oee.downtime_reports carries no (work_center_id, area_id) pair. Run 0014_review_week_dev.sql and 0020_second_line_dev.sql first.';
  END IF;

  -- Two areas for one line is not a case to resolve by taking the first. It means
  -- the source data disagrees with itself, and every figure derived from it after
  -- this point would be confidently wrong.
  SELECT count(*) INTO ambiguous
    FROM wc_area WHERE distinct_areas > 1 OR distinct_names > 1;

  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      '% line(s) map to more than one area in oee.downtime_reports. Refusing to pick one — fix the source rows.',
      ambiguous;
  END IF;

  -- oee.downtime_log_events is the same identity from the same upstream, written
  -- by the same seeds. It is a check, not a fallback: if it disagrees, one of the
  -- two seeds is wrong and both are being trusted elsewhere.
  SELECT count(*) INTO conflicting
    FROM wc_area w
    JOIN (SELECT work_center_id, min(area_id) AS area_id
            FROM oee.downtime_log_events
           WHERE work_center_id IS NOT NULL AND area_id IS NOT NULL
           GROUP BY work_center_id) e
      ON e.work_center_id = w.work_center_id
   WHERE e.area_id <> w.area_id;

  IF conflicting > 0 THEN
    RAISE EXCEPTION
      'oee.downtime_reports and oee.downtime_log_events disagree about the area of % line(s).',
      conflicting;
  END IF;

  RAISE NOTICE 'seed 0024: % line(s) have a resolvable area; the mapping is unambiguous and both downtime tables agree.', lines_mapped;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 2 — stamp the label onto every work_center-keyed table that carries it
-- ---------------------------------------------------------------------------
--
-- Six tables, one predicate. `area_id IS NULL` on every one of them, so a
-- resolved value is never overwritten (see "WHAT IT DOES NOT TOUCH" above).
--
-- THE THREE REPORT TABLES ARE WHAT 0022 AND 0023 READ. The other three are what
-- the AREA SCREENS read once those exist: reject_count_wc_shift backs the area's
-- Quality Loss Pareto, product_report_wc_day its SKU reads, and
-- product_perf_wc_hour the hourly dialog — all five of the "plain area_id
-- predicate" reads contract §25.5 lists. Filling only the day table would make
-- the area's overview card populate while every card under it stayed empty,
-- which looks like a broken screen rather than a partial seed.
UPDATE oee.work_center_shift_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.work_center_day_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.work_center_month_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.reject_count_wc_shift t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.product_report_wc_day t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.product_perf_wc_hour t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

-- ---------------------------------------------------------------------------
-- Step 3 — assertions, and the one NOTICE worth reading before running 0022
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  still_null integer;
  widest     integer;
BEGIN
  SELECT count(*) INTO still_null
    FROM oee.work_center_day_reports WHERE area_id IS NULL;

  IF still_null > 0 THEN
    RAISE EXCEPTION
      '% line day report row(s) still have a NULL area_id — their work_center_id has no downtime row to read an area from, so 0022 would silently exclude them from the plant.',
      still_null;
  END IF;

  -- 0022's step 0 makes this point and it is worth making BEFORE the rows exist:
  -- an area derived from ONE line is numerically identical to that line, so the
  -- "durations are LINE-milliseconds" claim cannot be checked by looking at it.
  SELECT max(lines) INTO widest
    FROM (SELECT count(DISTINCT work_center_id) AS lines
            FROM oee.work_center_day_reports
           WHERE area_id IS NOT NULL
           GROUP BY area_id, business_date) w;

  IF widest < 2 THEN
    RAISE NOTICE
      'No area has more than one line on any business day — the area rows 0022 writes will equal their single line. 0020_second_line_dev.sql adds a genuine second line on area 2.';
  ELSE
    RAISE NOTICE
      'seed 0024: the widest area-day has % lines, so the area rows will be a real composition and the LINE-millisecond durations are checkable by eye.',
      widest;
  END IF;
END
$$;

SELECT 'work_center_shift_reports' AS table_name, count(*) FILTER (WHERE area_id IS NOT NULL) AS with_area, count(*) AS rows FROM oee.work_center_shift_reports
UNION ALL SELECT 'work_center_day_reports',   count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_center_day_reports
UNION ALL SELECT 'work_center_month_reports', count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_center_month_reports
UNION ALL SELECT 'reject_count_wc_shift',     count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.reject_count_wc_shift
UNION ALL SELECT 'product_report_wc_day',     count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_report_wc_day
UNION ALL SELECT 'product_perf_wc_hour',      count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_perf_wc_hour;

DROP TABLE IF EXISTS wc_area;
