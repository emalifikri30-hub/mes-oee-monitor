-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See
-- 0015's header: without it the guard below prints its refusal and the seed runs
-- anyway.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration — scripts/migrate.mjs applies every *.sql in
-- src/shared/database/migration/, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0026_work_center_year_reports_dev.sql
--
-- The migration this one fills is 0027_oee_year_reports.sql.
--
-- RUN 0015_work_center_reports_dev.sql FIRST. This file derives from
-- oee.work_center_month_reports and inserts nothing if that table is empty.
--
-- ---------------------------------------------------------------------------
-- NORMATIVE, and §15.5's rule one grain further on
-- ---------------------------------------------------------------------------
--
--     durations and counts   ->  SUM
--     rates + mttr/mtbf      ->  RECOMPUTE from the sums
--
-- **Never `avg(oee)`.** Step 2's assertion 2 is the mechanical guard, and it is the
-- assertion that justifies oee.work_center_year_reports existing at all: a reader
-- widening the month rows gets the sums for free and the rates not at all.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DIFFERENT HERE FROM THE MACHINE SEED: TWO UNITS, TWO GATES
-- ---------------------------------------------------------------------------
--
-- A LINE HAS TWO COUNT POINTS AND THEY ARE USUALLY DIFFERENT — bags in, cartons
-- out (0014, contract §16.4a). So there are two unit triples, each gated
-- independently, and `total_out = good_out + reject + rework` IS FALSE at this
-- grain by construction. NOTHING BELOW COMPUTES ACROSS THE TWO SIDES.
--
-- A line can be certain what it consumed and abstain about what it shipped, which
-- is why the gates are separate rather than one condition over all five counts —
-- ck_wcyr_infeed_units and ck_wcyr_output_units are the schema's version of the
-- same split.
--
-- AND THE DURATIONS ARE THE LINE'S OWN WALL CLOCK, ~8,760 hours over a year
-- regardless of machine count. Not machine-milliseconds, and not the
-- line-milliseconds an AREA carries — 4fccce8 corrected the first reading after
-- the pipeline owner confirmed it.
--
--   step 0  is there anything to group?              RAISE NOTICE
--   step 1  line YEAR reports <- line MONTH reports  normative
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

-- Step 0 — a year derived from ONE month is numerically identical to that month,
-- so neither "the durations sum" nor "the rates are recomputed" is checkable by eye.
DO $$
DECLARE
  months integer;
  widest integer;
BEGIN
  SELECT count(*) INTO months FROM oee.work_center_month_reports;

  IF months = 0 THEN
    RAISE NOTICE 'oee.work_center_month_reports is empty — run 0015_work_center_reports_dev.sql first, or this file inserts nothing at all.';
    RETURN;
  END IF;

  SELECT max(n) INTO widest
    FROM (SELECT count(*) AS n
            FROM oee.work_center_month_reports
           GROUP BY work_center_id, date_trunc('year', business_date)) y;

  IF widest < 2 THEN
    RAISE NOTICE
      'No line has more than one month report in any year. The roll-up will run, but every year row will equal its single month — so it cannot demonstrate that the durations sum or that the rates were recomputed rather than averaged.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — line YEAR reports, from the line's own month reports
-- ---------------------------------------------------------------------------
INSERT INTO oee.work_center_year_reports (
  work_center_id, business_date, time_zone,
  work_center_name, work_center_code, area_id, area_name,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, reject, rework, line_out, good_out, effective_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id,
  -- `::date` is not cosmetic: date_trunc returns a timestamp, and ck_wcyr_year_start
  -- compares against its OWN truncation of the stored date. Casting here makes the
  -- two identical by construction.
  date_trunc('year', r.business_date)::date,
  min(r.time_zone),

  coalesce(min(r.work_center_name), 'Line ' || r.work_center_id::text),
  min(r.work_center_code), min(r.area_id), min(r.area_name),

  -- THE ROSTER. max() rather than min(): work_unit_count is how many machines
  -- REPORTED into a month, so a year's figure is the widest the line ever ran, not
  -- the narrowest. ck_wcyr_work_unit_count needs it > 0, which max() preserves
  -- wherever any month had one.
  max(r.work_unit_count), max(r.expected_work_unit_count),

  -- THE TWO UNITS, GATED INDEPENDENTLY. Both halves of each condition are
  -- load-bearing: count(DISTINCT x) SKIPS NULLs, so a year mixing one unit-less
  -- month with eleven BAG ones would otherwise report a confident BAG over a sum
  -- that silently dropped the twelfth (§16.3(c)).
  CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
       THEN min(r.infeed_uom_id) END,
  CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
       THEN min(r.infeed_uom_name) END,
  CASE WHEN count(DISTINCT r.infeed_uom_id) = 1 AND count(r.infeed_uom_id) = count(*)
       THEN min(r.infeed_uom_code) END,
  CASE WHEN count(DISTINCT r.output_uom_id) = 1 AND count(r.output_uom_id) = count(*)
       THEN min(r.output_uom_id) END,
  CASE WHEN count(DISTINCT r.output_uom_id) = 1 AND count(r.output_uom_id) = count(*)
       THEN min(r.output_uom_name) END,
  CASE WHEN count(DISTINCT r.output_uom_id) = 1 AND count(r.output_uom_id) = count(*)
       THEN min(r.output_uom_code) END,

  -- RECOMPUTED FROM THE SUMS. `teep` is present because A LINE OWNS A CALENDAR —
  -- availability_time is its own wall clock. The area seed has no such column.
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),

  -- INFEED SIDE, then OUTPUT SIDE. Summed WITHIN a side and never across — the two
  -- are in different units, and `total_out = good_out + reject + rework` is FALSE
  -- here by construction. Each side is nulled with its own gate above.
  round(sum(r.total_out), 3), round(sum(r.reject), 3), round(sum(r.rework), 3),
  round(sum(r.line_out), 3),
  round(sum(r.good_out), 3), round(sum(r.effective_out), 3),

  -- THE DURATIONS. Plain sums: the LINE'S OWN wall clock over the year.
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
FROM oee.work_center_month_reports r
GROUP BY r.work_center_id, date_trunc('year', r.business_date)
ON CONFLICT (work_center_id, business_date) DO UPDATE SET
  time_zone = excluded.time_zone,
  work_center_name = excluded.work_center_name, work_center_code = excluded.work_center_code,
  area_id = excluded.area_id, area_name = excluded.area_name,
  work_unit_count = excluded.work_unit_count,
  expected_work_unit_count = excluded.expected_work_unit_count,
  infeed_uom_id = excluded.infeed_uom_id, infeed_uom_name = excluded.infeed_uom_name,
  infeed_uom_code = excluded.infeed_uom_code,
  output_uom_id = excluded.output_uom_id, output_uom_name = excluded.output_uom_name,
  output_uom_code = excluded.output_uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, reject = excluded.reject, rework = excluded.rework,
  line_out = excluded.line_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out,
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
  SELECT count(*) INTO wrote FROM oee.work_center_year_reports;

  IF wrote = 0 THEN
    RAISE NOTICE 'oee.work_center_year_reports is still empty — oee.work_center_month_reports had no rows.';
    RETURN;
  END IF;

  -- 1. EVERY DURATION IS THE SUM OF ITS MONTHS'.
  SELECT count(*) INTO bad
    FROM oee.work_center_year_reports y
    JOIN (
      SELECT work_center_id,
             date_trunc('year', business_date)::date AS year_start,
             sum(availability_time) AS availability_time,
             sum(production_time)   AS production_time,
             sum(value_added_time)  AS value_added_time,
             sum(runtime)           AS runtime
        FROM oee.work_center_month_reports
       GROUP BY work_center_id, date_trunc('year', business_date)
    ) m ON m.work_center_id = y.work_center_id AND m.year_start = y.business_date
   WHERE y.availability_time <> m.availability_time
      OR y.production_time   <> m.production_time
      OR y.value_added_time  <> m.value_added_time
      OR y.runtime           <> m.runtime;

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) whose durations are not the sum of their months''.', bad;
  END IF;

  -- 2. NO YEAR ROW IS AN AVERAGE OF ITS MONTHS' RATES. The assertion that justifies
  --    the table: a reader widening the month rows reproduces assertion 1 for free
  --    and cannot reproduce this one without a second definition of line OEE.
  SELECT count(*) INTO bad
    FROM oee.work_center_year_reports y
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
    FROM oee.work_center_year_reports
   WHERE business_date <> date_trunc('year', business_date)::date;

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) not dated January 1.', bad;
  END IF;

  -- 4. EACH SIDE'S COUNTS ARE PAIRED WITH THEIR OWN UNIT, IN BOTH DIRECTIONS AND
  --    INDEPENDENTLY. Checking them together would let a line that knows what it
  --    consumed and abstains about what it shipped read as broken — which is the
  --    exact state 0014 designed the two CHECKs to permit.
  SELECT count(*) INTO bad
    FROM oee.work_center_year_reports
   WHERE (infeed_uom_id IS NULL) <> (total_out IS NULL)
      OR (output_uom_id IS NULL) <> (good_out IS NULL);

  IF bad > 0 THEN
    RAISE EXCEPTION '% year row(s) whose unit and counts disagree on one of the two sides.', bad;
  END IF;

  RAISE NOTICE 'oee.work_center_year_reports: % row(s), all assertions passed.', wrote;
END
$$;
