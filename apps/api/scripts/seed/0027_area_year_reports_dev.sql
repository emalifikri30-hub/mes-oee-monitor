-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See 0015's
-- header: without it the guard below prints its refusal and the seed runs anyway.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration — scripts/migrate.mjs applies every *.sql in
-- src/shared/database/migration/, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0027_area_year_reports_dev.sql
--
-- The migration this one fills is 0027_oee_year_reports.sql. (The numbers matching
-- is a coincidence — seed numbers are their own sequence.)
--
-- RUN 0023_area_month_reports_dev.sql FIRST. This file derives from
-- oee.area_month_reports and inserts nothing if that table is empty.
--
-- ---------------------------------------------------------------------------
-- NORMATIVE, and 0023's argument carried one grain further
-- ---------------------------------------------------------------------------
--
--     durations and counts   ->  SUM   (over the year's MONTHS)
--     rates + mttr/mtbf      ->  RECOMPUTE from those sums
--
-- **Never `avg(oee)` and never an average of the months' rates.** Step 2's
-- assertion 2 is the mechanical guard, and it is what justifies the table: a
-- reader widening oee.area_month_reports gets the sums for free and the rates not
-- at all.
--
-- ---------------------------------------------------------------------------
-- 0024'S TWO INVERSIONS HOLD, AND GET LOUDER RATHER THAN DIFFERENT
-- ---------------------------------------------------------------------------
--
--   * THE DURATIONS ARE LINE-MILLISECONDS, NOW TIMES A YEAR. A five-line area's
--     availability_time reads ~43,800 hours. That is the intended figure and the
--     one a reader will report as a bug. Do NOT divide by the line count, by the
--     month count or by anything else to make it look like a wall clock.
--   * THE COUNTS ARE A MASS, IN ONE UNIT, precisely because the member lines have
--     many. A NULL unit is a THIRD meaning: not 0014's "the members disagreed" and
--     not 0023's "not known", but "could not be brought to a common mass".
--
-- AND NO `teep`, for 0024's reason — TEEP divides by CALENDAR time and an area owns
-- no calendar a reader could name. There is no column to write and no expression
-- below that computes one. The dashboard's KPI row is a per-subject tile LIST
-- because of this absence.
--
--   step 0  is there anything to group?              RAISE NOTICE
--   step 1  area YEAR reports <- area MONTH reports  normative
--   step 2  assertions                               RAISE EXCEPTION

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

-- Step 0 — a year derived from ONE month is numerically identical to that month.
DO $$
DECLARE
  months integer;
  widest integer;
BEGIN
  SELECT count(*) INTO months FROM oee.area_month_reports;

  IF months = 0 THEN
    RAISE NOTICE 'oee.area_month_reports is empty — run 0023_area_month_reports_dev.sql first, or this file inserts nothing at all.';
    RETURN;
  END IF;

  SELECT max(n) INTO widest
    FROM (SELECT count(*) AS n
            FROM oee.area_month_reports
           GROUP BY area_id, date_trunc('year', business_date)) y;

  IF widest < 2 THEN
    RAISE NOTICE
      'No area has more than one month report in any year. The roll-up will run, but every year row will equal its single month — so it cannot demonstrate that the durations sum or that the rates were recomputed rather than averaged.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — area YEAR reports, from the area's own month reports
-- ---------------------------------------------------------------------------
INSERT INTO oee.area_year_reports (
  area_id, business_date, time_zone,
  area_name, area_code, site_id, site_name,
  weight_uom_id, weight_uom_name, weight_uom_code,
  oee, availability, performance, quality,
  total_out, area_out, reject, rework, good_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.area_id,
  -- `::date` is not cosmetic: date_trunc returns a timestamp, and ck_ayr_year_start
  -- compares against its OWN truncation of the stored date.
  date_trunc('year', r.business_date)::date,
  min(r.time_zone),

  coalesce(min(r.area_name), 'Area ' || r.area_id::text),
  min(r.area_code), min(r.site_id), min(r.site_name),

  -- THE MASS UNIT, GATED. Both halves are load-bearing — count(DISTINCT x) SKIPS
  -- NULLs, so a year mixing one unit-less month with eleven KG ones would otherwise
  -- report a confident KG over a sum that silently dropped the twelfth (§16.3(c)).
  -- With both halves it abstains, and ck_ayr_weight_units then nulls the counts.
  CASE WHEN count(DISTINCT r.weight_uom_id) = 1 AND count(r.weight_uom_id) = count(*)
       THEN min(r.weight_uom_id) END,
  CASE WHEN count(DISTINCT r.weight_uom_id) = 1 AND count(r.weight_uom_id) = count(*)
       THEN min(r.weight_uom_name) END,
  CASE WHEN count(DISTINCT r.weight_uom_id) = 1 AND count(r.weight_uom_id) = count(*)
       THEN min(r.weight_uom_code) END,

  -- RECOMPUTED FROM THE SUMS. FOUR RATES AND NOT FIVE — there is no `teep`
  -- expression here because there is no such column, and adding one would require
  -- naming a calendar an area does not have.
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),

  -- THE FIVE COUNTS, SUMMED RATHER THAN NULLED. They are NULL on every month row
  -- while 0022 cannot convert a count to a mass, and sum() over an all-NULL set is
  -- NULL — so this writes NULL today and rolls a real mass up correctly the day the
  -- month rows carry one, with no branch and no edit here. 0023's property, kept.
  round(sum(r.total_out), 3), round(sum(r.area_out), 3), round(sum(r.reject), 3),
  round(sum(r.rework), 3), round(sum(r.good_out), 3),

  -- THE DURATIONS. Plain sums, and the result is in LINE-MILLISECONDS over a whole
  -- YEAR — a five-line area reads ~43,800 h. Read 0024's header before "correcting"
  -- this by dividing by anything.
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  -- RATIOS, REBUILT over the summed repair time and a failure count recovered as
  -- `updt_time / mttr`. `> 0` rather than `IS NOT NULL` because mttr = 0 divides by
  -- zero.
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.area_month_reports r
GROUP BY r.area_id, date_trunc('year', r.business_date)
ON CONFLICT (area_id, business_date) DO UPDATE SET
  time_zone = excluded.time_zone,
  area_name = excluded.area_name, area_code = excluded.area_code,
  site_id = excluded.site_id, site_name = excluded.site_name,
  weight_uom_id = excluded.weight_uom_id, weight_uom_name = excluded.weight_uom_name,
  weight_uom_code = excluded.weight_uom_code,
  oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, area_out = excluded.area_out,
  reject = excluded.reject, rework = excluded.rework, good_out = excluded.good_out,
  runtime = excluded.runtime, availability_time = excluded.availability_time,
  production_time = excluded.production_time, pdt_time = excluded.pdt_time,
  operating_time = excluded.operating_time, updt_time = excluded.updt_time,
  net_time = excluded.net_time, reduce_speed_time = excluded.reduce_speed_time,
  ms_time = excluded.ms_time, value_added_time = excluded.value_added_time,
  rework_time = excluded.rework_time, reject_time = excluded.reject_time,
  anomaly_time = excluded.anomaly_time, up_speed_time = excluded.up_speed_time,
  schedule_loss_time = excluded.schedule_loss_time,
  availability_loss_time = excluded.availability_loss_time,
  performance_loss_time = excluded.performance_loss_time,
  ms_loss_time = excluded.ms_loss_time,
  reduce_speed_loss_time = excluded.reduce_speed_loss_time,
  quality_loss_time = excluded.quality_loss_time,
  mttr = excluded.mttr, mtbf = excluded.mtbf;

-- ---------------------------------------------------------------------------
-- Step 2 — assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad   integer;
  wrote integer;
BEGIN
  SELECT count(*) INTO wrote FROM oee.area_year_reports;

  IF wrote = 0 THEN
    RAISE NOTICE 'oee.area_year_reports is still empty — oee.area_month_reports had no rows.';
    RETURN;
  END IF;

  -- 1. EVERY DURATION IS THE SUM OF ITS MONTHS'. The identity a dbt model must
  --    reproduce, and the one a "wall clock" reading would break.
  SELECT count(*) INTO bad
    FROM oee.area_year_reports y
    JOIN (
      SELECT area_id,
             date_trunc('year', business_date)::date AS year_start,
             sum(availability_time) AS availability_time,
             sum(production_time)   AS production_time,
             sum(value_added_time)  AS value_added_time,
             sum(runtime)           AS runtime
        FROM oee.area_month_reports
       GROUP BY area_id, date_trunc('year', business_date)
    ) m ON m.area_id = y.area_id AND m.year_start = y.business_date
   WHERE y.availability_time <> m.availability_time
      OR y.production_time   <> m.production_time
      OR y.value_added_time  <> m.value_added_time
      OR y.runtime           <> m.runtime;

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) whose durations are not the sum of their months''.', bad;
  END IF;

  -- 2. NO YEAR ROW IS AN AVERAGE OF ITS MONTHS' RATES. The assertion that justifies
  --    the table.
  SELECT count(*) INTO bad
    FROM oee.area_year_reports y
   WHERE y.production_time > 0
     AND y.availability IS NOT NULL
     AND abs(y.availability
             - round(y.operating_time::numeric / y.production_time * 100, 3)) > 0.001;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% year row(s) whose availability is not its own operating_time / production_time. A mean of ratios is not the ratio of the sums.',
      bad;
  END IF;

  -- 3. EVERY ROW IS DATED JANUARY 1.
  SELECT count(*) INTO bad
    FROM oee.area_year_reports
   WHERE business_date <> date_trunc('year', business_date)::date;

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) not dated January 1.', bad;
  END IF;

  -- 4. THE COUNTS ARE PAIRED WITH THEIR UNIT, IN BOTH DIRECTIONS. Today both sides
  --    are NULL and this passes trivially; it is here so that it stops passing the
  --    moment a mass arrives on one side only.
  SELECT count(*) INTO bad
    FROM oee.area_year_reports
   WHERE (weight_uom_id IS NULL) <> (total_out IS NULL);

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) whose mass unit and counts disagree about being present.', bad;
  END IF;

  RAISE NOTICE 'oee.area_year_reports: % row(s), all assertions passed.', wrote;
END
$$;
