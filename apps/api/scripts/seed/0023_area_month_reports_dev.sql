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
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0023_area_month_reports_dev.sql
--
-- Seed numbers are a sequence of their own and do not track the migrations. The
-- migration this one fills is 0025_oee_area_month_reports.sql.
--
-- RUN 0022_area_day_reports_dev.sql FIRST. This file derives from
-- oee.area_day_reports and inserts nothing at all if that table is empty.
--
-- ---------------------------------------------------------------------------
-- THIS SEED IS NORMATIVE, LIKE 0022's AND FOR THE SAME REASON — PLUS ONE MORE
-- ---------------------------------------------------------------------------
--
-- 0022's header sets out why the AREA roll-up is the definition rather than a
-- stand-in: an area has no count point and no clock, so it is COMPOSED, and
-- summing its lines IS what its figures mean. That argument carries over.
--
-- The extra reason here is that the day -> month hop is normative on EVERY
-- subject in this schema, not just this one. 0013's seed chains month <- day for
-- the machine grain and 0015's step 3 does it for the line grain; both call that
-- hop normative and both are right, because §15.5's rule is subject-independent:
--
--     durations and counts   ->  SUM
--     rates (oee, a, p, q,
--            mttr, mtbf)     ->  RECOMPUTE from the sums
--
-- **Never `avg(availability)`.** A mean of ratios is not the ratio of the sums,
-- and it is the sums this row holds. §15.5 works the arithmetic on the analogous
-- case, and step 2's assertion 2 below is the mechanical guard.
--
-- SO WHY DOES THE MONTH NEED A TABLE AT ALL, IF THIS FILE CAN DERIVE IT?
--
-- Because "recompute from the sums" is exactly what a READER cannot do. A reader
-- widening oee.area_day_reports over a month gets the durations and counts for
-- free and gets NO rates — and the moment it computes them itself there are two
-- definitions of area OEE in the system, one in dbt and one in the API, sitting
-- one click apart on screens that drill into each other. That is the failure 0023
-- and 0024 both exist to prevent. Migration 0025's header argues it at length.
--
-- This file does the recompute in SQL, in the same shape the DAG should, which is
-- the point of it being checked in.
--
-- ---------------------------------------------------------------------------
-- WHAT IT CAN DO THAT 0022 COULD NOT: CARRY A MASS THROUGH
-- ---------------------------------------------------------------------------
--
-- 0022 writes NULL for `weight_uom_*` and all five counts, because converting a
-- count to a mass needs `std_weight` from ms_product.product_packaging — upstream,
-- and unreadable from the Gold database. So today this file sums NULLs and writes
-- NULLs, and the assertions below check the PAIRING rather than the absence.
--
-- IT IS WRITTEN TO SURVIVE THAT CHANGING, deliberately. If the pipeline (or a
-- future seed) ever fills the day rows' masses, this file rolls them up correctly
-- rather than silently discarding them — `sum()` over a set that is entirely NULL
-- is NULL, so the two cases need no branch. The one thing it must not do is take
-- `min(weight_uom_id)` across a month whose days disagreed, so the unit is GATED:
--
--   * count(DISTINCT weight_uom_id) = 1   the days agree on a unit, and
--   * count(weight_uom_id) = count(*)     every day HAS one
--
-- THE SECOND HALF IS THE NULL-SKIPPING TRAP §16.3(c) DESCRIBES, and it is the one
-- line in this file that is easy to get wrong invisibly: count(DISTINCT x) SKIPS
-- NULLs, so a month mixing one unit-less day with twenty-nine KG ones would report
-- a confident KG over a sum that silently dropped the unit-less day. With both
-- halves it abstains, and ck_amr_weight_units then nulls the counts with it.
--
-- WHAT IT FABRICATES: NOTHING. Every row derives from oee.area_day_reports. Every
-- step is `DO UPDATE`, so re-running refreshes the month rows from whatever the
-- day rows currently say.
--
--   step 0  is there anything to group?                RAISE NOTICE
--   step 1  area MONTH reports <- area DAY reports     normative
--   step 2  assertions                                 RAISE EXCEPTION

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
--
-- THE BYPASS IS A FLAG, NOT AN EDIT — 0014_review_week_dev.sql's convention:
-- "a guard you have to delete to proceed is a guard that gets deleted and left
-- deleted." Both parts must be in ONE psql invocation; a separate `-c` is a
-- separate session and the setting will not survive into this file.
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0023_area_month_reports_dev.sql
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
-- A NOTICE rather than an EXCEPTION: a developer whose dev database is incomplete
-- in a way that does not affect what they are working on should not be blocked.
--
-- The second check is what makes this file falsifiable by eye. A month derived
-- from ONE day is numerically identical to that day, so neither "the durations
-- sum" nor "the rates are recomputed rather than averaged" can be checked by
-- looking at it — an average of one number is that number.
DO $$
DECLARE
  days   integer;
  widest integer;
BEGIN
  SELECT count(*) INTO days FROM oee.area_day_reports;

  IF days = 0 THEN
    RAISE NOTICE 'oee.area_day_reports is empty — run 0022_area_day_reports_dev.sql first, or this file inserts nothing at all.';
    RETURN;
  END IF;

  SELECT max(n) INTO widest
    FROM (SELECT count(*) AS n
            FROM oee.area_day_reports
           GROUP BY area_id, date_trunc('month', business_date)) m;

  IF widest < 2 THEN
    RAISE NOTICE
      'No area has more than one day report in any month. The roll-up will run, but every month row will equal its single day — so it cannot demonstrate that the durations sum or that the rates were recomputed rather than averaged. 0014_review_week_dev.sql seeds a week of machine days; run it before 0015 and 0022 for a month worth looking at.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — area MONTH reports, from the area's own day reports
-- ---------------------------------------------------------------------------
--
-- GROUPED ON (area_id, month start), which is the table's natural key.
--
-- `date_trunc('month', business_date)::date` IS THE KEY EXPRESSION, and the
-- `::date` is not cosmetic: date_trunc returns a timestamp, and inserting one into
-- a `date` column relies on an implicit cast that ck_amr_month_start would then
-- compare against its own truncation. Casting here makes the two identical by
-- construction rather than by coincidence.
--
-- The label columns take min() because they do not vary within an area — the same
-- argument 0022 makes one grain down, and unlike 0015 step 1's min(uom_id), which
-- stops being safe across a line's machines. An area's NAME is constant across its
-- days by definition; a UNIT is not, which is why it is gated below.
INSERT INTO oee.area_month_reports (
  area_id, business_date, time_zone,
  area_name, area_code, site_id, site_name, month,
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
  date_trunc('month', r.business_date)::date,
  min(r.time_zone),

  -- NOT NULL on the target, so coalesce rather than risk the insert failing on an
  -- area the pipeline labelled inconsistently.
  coalesce(min(r.area_name), 'Area ' || r.area_id::text),
  min(r.area_code),
  min(r.site_id), min(r.site_name),
  to_char(date_trunc('month', r.business_date), 'YYYY-MM'),

  -- THE MASS UNIT, GATED. Both halves of each condition are load-bearing — see
  -- the header's note on the NULL-skipping trap. Without the second,
  -- count(DISTINCT) skips NULLs and a month mixing one unit-less day with
  -- twenty-nine KG ones reports a confident KG over an incomplete sum.
  CASE WHEN count(DISTINCT r.weight_uom_id) = 1
        AND count(r.weight_uom_id) = count(*)
       THEN min(r.weight_uom_id) END,
  CASE WHEN count(DISTINCT r.weight_uom_id) = 1
        AND count(r.weight_uom_id) = count(*)
       THEN min(r.weight_uom_name) END,
  CASE WHEN count(DISTINCT r.weight_uom_id) = 1
        AND count(r.weight_uom_id) = count(*)
       THEN min(r.weight_uom_code) END,

  -- RECOMPUTED FROM THE SUMS, never averaged over the days. The same four
  -- expressions 0022 uses one grain down, which is what makes an area's month
  -- rates comparable with its days' rather than a different definition of the same
  -- word. THIS IS THE ONE THING A READER CANNOT DO FOR ITSELF, and therefore the
  -- whole reason oee.area_month_reports is a table.
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),

  -- THE FIVE COUNTS, SUMMED RATHER THAN NULLED. They are NULL on every day row
  -- today (0022 cannot convert a count to a mass), and sum() over an all-NULL set
  -- is NULL — so this writes NULL today and rolls a real mass up correctly the day
  -- the day rows carry one, with no branch and no edit here. ck_amr_weight_units
  -- pairs them with the gated unit above.
  round(sum(r.total_out), 3),
  round(sum(r.area_out), 3),
  round(sum(r.reject), 3),
  round(sum(r.rework), 3),
  round(sum(r.good_out), 3),

  -- THE DURATIONS. Plain sums, and the result is in LINE-milliseconds summed over
  -- the month's days — a five-line area over 30 days is ~3,600 h. Read migration
  -- 0025's header before "correcting" this by dividing by anything.
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  -- MTTR AND MTBF ARE RATIOS AND ARE RECOMPUTED, NOT AVERAGED — 0022's rule and
  -- 0013's before it. Neither table stores a failure COUNT, so it is recovered per
  -- source row as `updt_time / mttr` and the two ratios are rebuilt over the
  -- summed repair time and the summed failure count. A source row with mttr = 0 or
  -- NULL contributes no failures, which is why the guard is `> 0` rather than
  -- `IS NOT NULL`: mttr = 0 would divide by zero.
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.area_day_reports r
GROUP BY r.area_id, date_trunc('month', r.business_date)
ON CONFLICT (area_id, business_date) DO UPDATE SET
  time_zone = excluded.time_zone,
  area_name = excluded.area_name, area_code = excluded.area_code,
  site_id = excluded.site_id, site_name = excluded.site_name,
  month = excluded.month,
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
--
-- RAISE EXCEPTION, not NOTICE, and \set ON_ERROR_STOP at the top of the file is
-- what makes that abort the run rather than print and continue.
DO $$
DECLARE
  bad   integer;
  wrote integer;
BEGIN
  SELECT count(*) INTO wrote FROM oee.area_month_reports;

  IF wrote = 0 THEN
    RAISE NOTICE 'oee.area_month_reports is still empty — oee.area_day_reports had no rows. Run 0022_area_day_reports_dev.sql first.';
    RETURN;
  END IF;

  -- 1. EVERY DURATION IS THE SUM OF ITS DAYS'. This is the identity a dbt model
  --    must reproduce, and the one a "wall clock" or per-day-average reading would
  --    break.
  SELECT count(*) INTO bad
    FROM oee.area_month_reports m
    JOIN (
      SELECT area_id,
             date_trunc('month', business_date)::date AS month_start,
             sum(availability_time) AS availability_time,
             sum(production_time)   AS production_time,
             sum(value_added_time)  AS value_added_time,
             sum(runtime)           AS runtime
        FROM oee.area_day_reports
       GROUP BY area_id, date_trunc('month', business_date)
    ) d ON d.area_id = m.area_id AND d.month_start = m.business_date
   WHERE m.availability_time <> d.availability_time
      OR m.production_time   <> d.production_time
      OR m.value_added_time  <> d.value_added_time
      OR m.runtime           <> d.runtime;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% month row(s) whose durations are not the sum of their days''. The roll-up is wrong, or something else has written this table.',
      bad;
  END IF;

  -- 2. NO MONTH ROW IS AN AVERAGE OF ITS DAYS' RATES. Checked by recomputing
  --    availability from the row's OWN summed components: if a future edit replaced
  --    the recompute with avg(availability), a month whose days differ would drift
  --    here. Tolerance is the numeric(10,3) rounding.
  --
  --    THIS IS THE ASSERTION THAT JUSTIFIES THE TABLE. A reader widening the day
  --    rows can reproduce assertion 1 for free and cannot reproduce this one at
  --    all without redoing the recompute — which would be a second definition of
  --    area OEE, in the API, one click from the day screens.
  SELECT count(*) INTO bad
    FROM oee.area_month_reports m
   WHERE m.production_time > 0
     AND m.availability IS NOT NULL
     AND abs(m.availability
             - round(m.operating_time::numeric / m.production_time * 100, 3)) > 0.002;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% month row(s) whose availability does not equal operating_time / production_time. A mean of ratios is not the ratio of the sums (§15.5) — do not average rates.',
      bad;
  END IF;

  -- 3. `business_date` IS THE FIRST OF THE MONTH. ck_amr_month_start enforces this
  --    in the database, so this can only fail if the constraint were dropped —
  --    which is exactly why it is worth one query: the seed is where a
  --    date_trunc-without-cast would first show up.
  SELECT count(*) INTO bad
    FROM oee.area_month_reports
   WHERE business_date <> date_trunc('month', business_date)::date;

  IF bad > 0 THEN
    RAISE EXCEPTION '% month row(s) not dated the first of their month.', bad;
  END IF;

  -- 4. THE COUNTS ARE PAIRED WITH THEIR UNIT, in both directions.
  --
  --    NOT "the counts are NULL", which is what 0022 asserts one grain down. That
  --    file cannot convert a count to a mass and must never appear to; THIS file
  --    only rolls up whatever the day rows hold, so a mass appearing here is
  --    correct the moment one appears there. What must hold either way is the
  --    pairing — a count with no unit is a wrong number wearing a missing label.
  SELECT count(*) INTO bad
    FROM oee.area_month_reports
   WHERE (weight_uom_id IS NULL) <> (total_out IS NULL);

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% month row(s) where the mass unit and total_out disagree about being present. ck_amr_weight_units should have refused these.',
      bad;
  END IF;

  RAISE NOTICE 'oee.area_month_reports: % row(s), durations verified as day-sums, rates verified as recomputed, month starts verified.', wrote;
END
$$;

-- ---------------------------------------------------------------------------
-- The watermark
-- ---------------------------------------------------------------------------
--
-- WITHOUT THIS ROW THE SCREENS CANNOT TELL "this area had no production that
-- month" FROM "the DAG has not run" — §8 and §14's distinction, and the reason
-- ck_etl_watermarks_table gained 'area_month_reports' in migration 0025.
--
-- `last_business_date` IS THE LATEST MONTH START, not the last day of that month,
-- because that is what this table's `business_date` holds and the browser compares
-- the two as business days. A month-end value here would make a report for the
-- current month read as loaded before its last day had run.
--
-- `writer` names this seed, not 'dbt'. Contract §4 makes it free text precisely so
-- a one-off can say so; a row claiming 'dbt' would make a hand-run seed
-- indistinguishable from a DAG run in the one table that exists to tell them apart.
INSERT INTO oee.etl_watermarks
  (table_name, last_run_at, last_business_date, rows_total, run_id, writer)
SELECT 'area_month_reports', now(), max(business_date), count(*), NULL, 'seed-0023-dev'
  FROM oee.area_month_reports
 HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE SET
  last_run_at        = EXCLUDED.last_run_at,
  last_business_date = EXCLUDED.last_business_date,
  rows_total         = EXCLUDED.rows_total,
  writer             = EXCLUDED.writer;
