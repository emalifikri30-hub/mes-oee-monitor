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
-- finds in that directory, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0025_work_unit_year_reports_dev.sql
--
-- Seed numbers are a sequence of their own and do not track the migrations. The
-- migration this one fills is 0027_oee_year_reports.sql.
--
-- RUN 0013_day_month_reports_dev.sql FIRST. This file derives from
-- oee.work_unit_month_reports and inserts nothing at all if that table is empty.
--
-- ---------------------------------------------------------------------------
-- THIS SEED IS NORMATIVE, LIKE ITS THREE PREDECESSORS
-- ---------------------------------------------------------------------------
--
-- The day -> month hop is normative on EVERY subject in this schema — 0013's seed
-- chains it for the machine grain, 0015's step 3 for the line grain and 0023's for
-- the area. MONTH -> YEAR is that same hop one step further, with no new argument,
-- because §15.5's rule is grain-independent as well as subject-independent:
--
--     durations and counts   ->  SUM
--     rates (oee, a, p, q,
--            mttr, mtbf)     ->  RECOMPUTE from the sums
--
-- **Never `avg(oee)`.** A mean of ratios is not the ratio of the sums, and it is
-- the sums this row holds. Step 2's assertion 2 below is the mechanical guard.
--
-- SO WHY DOES THE YEAR NEED A TABLE AT ALL, IF THIS FILE CAN DERIVE IT?
--
-- Because "recompute from the sums" is exactly what a READER cannot do. A reader
-- widening oee.work_unit_month_reports over a year gets the durations and counts
-- for free and gets NO rates — and the moment it computes them itself there are
-- two definitions of machine OEE in the system, one in dbt and one in the API,
-- sitting one click apart on screens that drill into each other. Migration 0027's
-- header argues it at length.
--
--   step 0  is there anything to group?                RAISE NOTICE
--   step 1  machine YEAR reports <- machine MONTH      normative
--   step 2  assertions                                 RAISE EXCEPTION

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
--
-- THE BYPASS IS A FLAG, NOT AN EDIT — 0014_review_week_dev.sql's convention:
-- "a guard you have to delete to proceed is a guard that gets deleted and left
-- deleted." Both parts must be in ONE psql invocation; a separate `-c` is a
-- separate session and the setting will not survive into this file.
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
-- Step 0 — is there anything to group BY?
-- ---------------------------------------------------------------------------
--
-- The second check is what makes this file falsifiable by eye. A year derived from
-- ONE month is numerically identical to that month, so neither "the durations sum"
-- nor "the rates are recomputed rather than averaged" can be checked by looking at
-- it — an average of one number is that number.
DO $$
DECLARE
  months integer;
  widest integer;
BEGIN
  SELECT count(*) INTO months FROM oee.work_unit_month_reports;

  IF months = 0 THEN
    RAISE NOTICE 'oee.work_unit_month_reports is empty — run 0013_day_month_reports_dev.sql first, or this file inserts nothing at all.';
    RETURN;
  END IF;

  SELECT max(n) INTO widest
    FROM (SELECT count(*) AS n
            FROM oee.work_unit_month_reports
           WHERE business_date IS NOT NULL
           GROUP BY work_unit_id, date_trunc('year', business_date)) y;

  IF widest < 2 THEN
    RAISE NOTICE
      'No machine has more than one month report in any year. The roll-up will run, but every year row will equal its single month — so it cannot demonstrate that the durations sum or that the rates were recomputed rather than averaged.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — machine YEAR reports, from the machine's own month reports
-- ---------------------------------------------------------------------------
--
-- GROUPED ON (work_unit_id, year start), which is the table's natural key.
--
-- `date_trunc('year', business_date)::date` IS THE KEY EXPRESSION, and the
-- `::date` is not cosmetic: date_trunc returns a timestamp, and inserting one into
-- a `date` column relies on an implicit cast that ck_wuyr_year_start would then
-- compare against its own truncation. Casting here makes the two identical by
-- construction rather than by coincidence.
--
-- `business_date IS NOT NULL` IS REQUIRED HERE AND NOT ELSEWHERE. 0013 could only
-- add that column as NULLABLE — the month table already held rows — and TODOS §46
-- tracks tightening it. A NULL would group every unstamped month of every machine
-- into one bogus year row.
INSERT INTO oee.work_unit_year_reports (
  work_unit_id, business_date, time_zone,
  work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
  uom_id, uom_name, uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_unit_id,
  date_trunc('year', r.business_date)::date,
  -- NOT NULL on the target where 0013 had to leave it nullable on the source.
  coalesce(min(r.time_zone), 'Asia/Jakarta'),

  min(r.work_unit_name), min(r.work_unit_code),
  min(r.work_center_id), min(r.work_center_name), min(r.work_center_code),

  -- THE UNIT. A machine has ONE count point, so unlike the line and area seeds
  -- there is no two-triple shape and no mass conversion — but the GATE is the same
  -- and for the same reason: a machine whose uom changed mid-year has months that
  -- disagree, and min() would pick one and add incompatible numbers under it.
  --
  -- BOTH HALVES ARE LOAD-BEARING. count(DISTINCT x) SKIPS NULLs, so a year mixing
  -- one unit-less month with eleven others would otherwise report a confident unit
  -- over a sum that silently dropped the twelfth.
  CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
       THEN min(r.uom_id) END,
  CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
       THEN min(r.uom_name) END,
  CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
       THEN min(r.uom_code) END,

  -- RECOMPUTED FROM THE SUMS, never averaged over the months. THIS IS THE ONE
  -- THING A READER CANNOT DO FOR ITSELF, and therefore the whole reason
  -- oee.work_unit_year_reports is a table.
  --
  -- `teep` IS PRESENT HERE and absent from the area seed, because a MACHINE OWNS A
  -- CALENDAR: availability_time is its own wall clock over the year.
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),

  -- THE COUNTS. Plain sums within the one gated unit above.
  round(sum(r.total_out), 3), round(sum(r.good_out), 3), round(sum(r.effective_out), 3),
  round(sum(r.reject), 3), round(sum(r.rework), 3),

  -- THE DURATIONS. Plain sums, and the result is the MACHINE'S OWN WALL CLOCK over
  -- the year — ~8,760 hours of availability_time, not line-milliseconds. That
  -- inversion belongs to the area grain only (0024).
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  -- MTTR AND MTBF ARE RATIOS AND ARE RECOMPUTED, NOT AVERAGED — 0023's rule, which
  -- is 0013's before it. Neither table stores a failure COUNT, so it is recovered
  -- per source row as `updt_time / mttr` and the two ratios are rebuilt over the
  -- summed repair time and the summed failure count. The guard is `> 0` rather
  -- than `IS NOT NULL` because mttr = 0 would divide by zero.
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.work_unit_month_reports r
WHERE r.business_date IS NOT NULL
GROUP BY r.work_unit_id, date_trunc('year', r.business_date)
ON CONFLICT (work_unit_id, business_date) DO UPDATE SET
  time_zone = excluded.time_zone,
  work_unit_name = excluded.work_unit_name, work_unit_code = excluded.work_unit_code,
  work_center_id = excluded.work_center_id, work_center_name = excluded.work_center_name,
  work_center_code = excluded.work_center_code,
  uom_id = excluded.uom_id, uom_name = excluded.uom_name, uom_code = excluded.uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out, reject = excluded.reject, rework = excluded.rework,
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
  SELECT count(*) INTO wrote FROM oee.work_unit_year_reports;

  IF wrote = 0 THEN
    RAISE NOTICE 'oee.work_unit_year_reports is still empty — oee.work_unit_month_reports had no stamped rows.';
    RETURN;
  END IF;

  -- 1. EVERY DURATION IS THE SUM OF ITS MONTHS'. The identity a dbt model must
  --    reproduce, and the one a per-month-average reading would break.
  SELECT count(*) INTO bad
    FROM oee.work_unit_year_reports y
    JOIN (
      SELECT work_unit_id,
             date_trunc('year', business_date)::date AS year_start,
             sum(availability_time) AS availability_time,
             sum(production_time)   AS production_time,
             sum(value_added_time)  AS value_added_time,
             sum(runtime)           AS runtime
        FROM oee.work_unit_month_reports
       WHERE business_date IS NOT NULL
       GROUP BY work_unit_id, date_trunc('year', business_date)
    ) m ON m.work_unit_id = y.work_unit_id AND m.year_start = y.business_date
   WHERE y.availability_time <> m.availability_time
      OR y.production_time   <> m.production_time
      OR y.value_added_time  <> m.value_added_time
      OR y.runtime           <> m.runtime;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% year row(s) whose durations are not the sum of their months''. The roll-up is wrong, or something else has written this table.',
      bad;
  END IF;

  -- 2. NO YEAR ROW IS AN AVERAGE OF ITS MONTHS' RATES. Recomputed from the row's
  --    OWN summed components: a future edit replacing the recompute with
  --    avg(availability) would drift here on any machine whose months differ.
  --    Tolerance is the numeric(10,3) rounding.
  --
  --    THIS IS THE ASSERTION THAT JUSTIFIES THE TABLE. A reader widening the month
  --    rows reproduces assertion 1 for free and cannot reproduce this one without
  --    redoing the recompute — a second definition of machine OEE, in the API, one
  --    click from the month screens.
  SELECT count(*) INTO bad
    FROM oee.work_unit_year_reports y
   WHERE y.production_time > 0
     AND y.availability IS NOT NULL
     AND abs(y.availability
             - round(y.operating_time::numeric / y.production_time * 100, 3)) > 0.001;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% year row(s) whose availability is not its own operating_time / production_time. A mean of ratios is not the ratio of the sums.',
      bad;
  END IF;

  -- 3. EVERY ROW IS DATED JANUARY 1. ck_wuyr_year_start already enforces it; this
  --    asserts the SEED produces it rather than relying on the constraint to reject
  --    a whole run.
  SELECT count(*) INTO bad
    FROM oee.work_unit_year_reports
   WHERE business_date <> date_trunc('year', business_date)::date;

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) not dated January 1.', bad;
  END IF;

  -- 4. THE COUNTS ARE PAIRED WITH THEIR UNIT, IN BOTH DIRECTIONS. A count without
  --    a unit is a number nobody can read; a unit with no counts is a claim the
  --    year was measured when it was not.
  SELECT count(*) INTO bad
    FROM oee.work_unit_year_reports
   WHERE (uom_id IS NULL) <> (total_out IS NULL);

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) whose unit and counts disagree about being present.', bad;
  END IF;

  RAISE NOTICE 'oee.work_unit_year_reports: % row(s), all assertions passed.', wrote;
END
$$;
