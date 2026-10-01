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
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0022_area_day_reports_dev.sql
--
-- Seed numbers are a sequence of their own and do not track the migrations. The
-- migration this one fills is 0024_oee_area_day_reports.sql.
--
-- WHY IT EXISTS
--
-- oee.area_day_reports ships EMPTY — contract §1 rule 2 is that this service never
-- bulk-inserts, and no dbt model writes it yet (§25 is the ask). The Area By Day
-- list and detail screens are therefore unreachable by eye without this file.
--
-- ---------------------------------------------------------------------------
-- THIS SEED IS *NORMATIVE*, WHICH NO OTHER LINE-OR-COARSER SEED IN THIS
-- DIRECTORY IS. READ THIS BEFORE ASSUMING IT IS A STAND-IN LIKE 0015's.
-- ---------------------------------------------------------------------------
--
-- 0015 has to open with a warning that its step 1 is INVENTED: a line is MEASURED
-- at its own count points, so summing machines produces figures that are
-- "plausible and structurally wrong — right shape, right identities, wrong
-- provenance". 0016's tables get no seed at all, because "the only available
-- derivation is the roll-up, so a seed would teach the invariant the table exists
-- to deny".
--
-- NEITHER APPLIES HERE, AND THE REASON IS THE POINT OF MIGRATION 0024. An area
-- has no count point and no clock of its own. It is not measured; it is COMPOSED.
-- So the roll-up below is not a substitute for a measurement — it IS the
-- definition, and a dbt model that disagrees with it is the model that is wrong.
--
-- Two consequences that make the rows here directly reviewable:
--
--   * THE DURATIONS COME OUT IN LINE-MILLISECONDS, and that is correct rather
--     than an artifact. A five-line area's availability_time on one business day
--     is ~120 h, not ~24. Migration 0024's header and the COMMENT on the column
--     both say so; this seed is what makes it visible.
--   * THE RATES ARE RECOMPUTED FROM THE SUMMED COMPONENTS, never averaged. §15.5
--     works the arithmetic on the analogous case: a mean of ratios is not the
--     ratio of the sums, and it is the sums this row holds.
--
-- WHAT IT STILL CANNOT DO, AND WRITES NULL FOR RATHER THAN GUESSING
--
-- THE WEIGHT UNIT AND ALL FIVE COUNTS. Every count on oee.area_day_reports is a
-- MASS, because mass is the only unit an area's members can all be expressed in
-- (migration 0024, consequence 2). Converting a count to a mass needs
-- `std_weight` off ms_product.product_packaging — upstream, in mes-master-data,
-- and unreadable from the Gold database this script runs against.
--
-- So `weight_uom_*` and total_out / area_out / good_out / reject / rework are all
-- NULL, which is exactly what ck_adr_weight_units requires: a count with no unit
-- is a wrong number wearing a missing label. The overview card renders five em
-- dashes and the Losses card two, and that is the honest state — the pipeline
-- fills them.
--
-- It would be one line to write `sum(total_out)` into the mass column instead.
-- That is the error this paragraph exists to prevent: a confident figure under a
-- unit nobody established, adding bags to sacks.
--
-- WHAT IT FABRICATES: NOTHING. Every row derives from
-- oee.work_center_day_reports, which 0015_work_center_reports_dev.sql fills. Run
-- that first (and whatever fills the machine tables it derives from) or this file
-- inserts nothing at all. THEN RUN 0024_work_center_area_id_dev.sql: 0015 leaves
-- area_id NULL by design, and this file groups on exactly that column, so the two
-- of them without the third produce no rows and no error. Every step is `DO UPDATE`, so re-running refreshes the
-- area rows from whatever the line rows currently say.
--
--   step 0  the area_id coverage check           RAISE NOTICE
--   step 1  area DAY reports <- lines' day rows  normative
--   step 2  assertions                           RAISE EXCEPTION

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
--     -f apps/api/scripts/seed/0022_area_day_reports_dev.sql
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
-- `area_id` IS NULLABLE ON oee.work_center_day_reports (migration 0014), and this
-- roll-up groups on exactly that column. A line whose area the pipeline never
-- resolved contributes to NO area report — it is not an error and it is not
-- "area 0", it is simply absent, and an area total that silently excluded half the
-- plant is the quietest wrong number this feature can produce.
--
-- A NOTICE rather than an EXCEPTION: a developer whose dev database is incomplete
-- in a way that does not affect what they are working on should not be blocked.
DO $$
DECLARE
  orphans integer;
  areas   integer;
  widest  integer;
BEGIN
  SELECT count(*) INTO orphans
    FROM oee.work_center_day_reports WHERE area_id IS NULL;

  SELECT count(DISTINCT area_id) INTO areas
    FROM oee.work_center_day_reports WHERE area_id IS NOT NULL;

  IF areas = 0 THEN
    -- NOT 0015. It is the obvious answer and it is wrong: 0015 writes area_id as
    -- NULL on purpose ("The seed CANNOT derive these: work_unit_shift_reports
    -- has no area columns"), so running it again changes nothing and the chain
    -- reports success at every step while producing zero area reports.
    -- 0024_work_center_area_id_dev.sql is the backfill that closes that gap.
    RAISE NOTICE 'No line day report carries an area_id — run 0015_work_center_reports_dev.sql and then 0024_work_center_area_id_dev.sql (0015 alone leaves the column NULL), or this file inserts nothing at all.';
  END IF;

  IF orphans > 0 THEN
    RAISE NOTICE
      '% line day report row(s) have a NULL area_id and are EXCLUDED from every area total. That is the roll-up behaving correctly, not a filter bug — but the area figures below are then a subset of the plant.',
      orphans;
  END IF;

  -- Multi-line areas are what make this feature falsifiable by eye. An area
  -- derived from ONE line is numerically identical to that line, so
  -- "durations are LINE-hours" cannot be checked by looking at it — the tile
  -- would read 24 h either way.
  SELECT max(lines) INTO widest
    FROM (SELECT count(DISTINCT work_center_id) AS lines
            FROM oee.work_center_day_reports
           WHERE area_id IS NOT NULL
           GROUP BY area_id, business_date) w;

  IF widest IS NOT NULL AND widest < 2 THEN
    RAISE NOTICE
      'No area has more than one line on any business day. The roll-up will run, but every area row will equal its single line, so it cannot demonstrate that the durations are LINE-hours. 0020_second_line_dev.sql adds a genuine second line on area 2.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — area DAY reports, from the lines' own day reports
-- ---------------------------------------------------------------------------
--
-- GROUPED ON (area_id, business_date), which is the table's natural key.
--
-- The label columns take min() because they do not vary within an area — the same
-- argument 0013's seed makes for a work unit's labels, and unlike 0015 step 1's
-- min(uom_id), which stops being safe across a line's machines. An area's NAME is
-- constant across its lines by definition; a UNIT is not, which is the whole
-- reason this table denominates in mass.
--
-- factory_* CANNOT BE DERIVED. oee.work_center_day_reports carries area_id /
-- area_name and stops there, so the level above the area is not in the source.
-- NULL rather than a guess; the pipeline fills it (contract §25.4).
INSERT INTO oee.area_day_reports (
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
  r.business_date,
  min(r.time_zone),

  -- NOT NULL on the target, so coalesce rather than risk the insert failing on an
  -- area the pipeline labelled inconsistently. The id is the fact; the name is a
  -- denormalised label (contract §16.6's staleness policy).
  coalesce(min(r.area_name), 'Area ' || r.area_id::text),
  -- oee.work_center_day_reports has no area_code column, so there is nothing to
  -- derive one from. NULL, and the screens render the name alone.
  NULL::varchar,
  NULL::integer, NULL::varchar,
  to_char(r.business_date, 'YYYY-MM'),

  -- THE MASS UNIT AND EVERY COUNT: NULL. See the header — std_weight lives in
  -- mes-master-data and is unreadable from here, and `sum(total_out)` would be a
  -- confident figure under a unit nobody established. ck_adr_weight_units requires
  -- exactly this pairing.
  NULL::integer, NULL::varchar, NULL::varchar,

  -- RECOMPUTED FROM THE SUMS, never averaged. Same five expressions 0015 step 2
  -- uses one grain down, which is what makes an area's rates comparable with its
  -- lines' rather than a different definition of the same word.
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),

  -- Five counts, NULL with their unit.
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,

  -- THE DURATIONS. Plain sums, and the result is in LINE-milliseconds — read
  -- migration 0024's consequence 1 before "correcting" this by dividing by the
  -- line count.
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  -- MTTR AND MTBF ARE RATIOS AND ARE RECOMPUTED, NOT AVERAGED — 0015's rule and
  -- 0013's before it. The trick is that neither table stores a failure COUNT, so
  -- it is recovered per source row as `updt_time / mttr` and the two ratios are
  -- rebuilt over the summed repair time and the summed failure count. A source row
  -- with mttr = 0 or NULL contributes no failures, which is why the guard is
  -- `> 0` rather than `IS NOT NULL`: mttr = 0 would divide by zero.
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.work_center_day_reports r
-- THE FILTER STEP 0 WARNS ABOUT. A NULL area_id has no area to belong to; it is
-- excluded rather than grouped into a phantom row.
WHERE r.area_id IS NOT NULL
GROUP BY r.area_id, r.business_date
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
--
-- These check the ROLL-UP, which is this file's whole claim to being normative.
-- The unit/count pairing is checked by ck_adr_weight_units in the database and
-- needs no assertion here.
DO $$
DECLARE
  bad     integer;
  wrote   integer;
BEGIN
  SELECT count(*) INTO wrote FROM oee.area_day_reports;

  IF wrote = 0 THEN
    RAISE NOTICE 'oee.area_day_reports is still empty — oee.work_center_day_reports had no rows with an area_id. Run 0015_work_center_reports_dev.sql first.';
    RETURN;
  END IF;

  -- 1. EVERY DURATION IS THE SUM OF ITS LINES'. This is the identity a dbt model
  --    must reproduce, and the one a "wall clock" reading of the durations would
  --    break — an area row equal to 24 h where its lines sum to 120 h fails here.
  SELECT count(*) INTO bad
    FROM oee.area_day_reports a
    JOIN (
      SELECT area_id, business_date,
             sum(availability_time) AS availability_time,
             sum(production_time)   AS production_time,
             sum(value_added_time)  AS value_added_time,
             sum(runtime)           AS runtime
        FROM oee.work_center_day_reports
       WHERE area_id IS NOT NULL
       GROUP BY area_id, business_date
    ) l ON l.area_id = a.area_id AND l.business_date = a.business_date
   WHERE a.availability_time <> l.availability_time
      OR a.production_time   <> l.production_time
      OR a.value_added_time  <> l.value_added_time
      OR a.runtime           <> l.runtime;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% area row(s) whose durations are not the sum of their lines''. The roll-up is wrong, or something else has written this table.',
      bad;
  END IF;

  -- 2. NO AREA ROW IS AN AVERAGE OF ITS LINES' RATES. Checked by recomputing
  --    availability from the row's OWN summed components: if a future edit
  --    replaced the recompute with avg(availability), a multi-line area whose
  --    lines differ would drift here. Tolerance is the numeric(10,3) rounding.
  SELECT count(*) INTO bad
    FROM oee.area_day_reports a
   WHERE a.production_time > 0
     AND a.availability IS NOT NULL
     AND abs(a.availability
             - round(a.operating_time::numeric / a.production_time * 100, 3)) > 0.002;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% area row(s) whose availability does not equal operating_time / production_time. A mean of ratios is not the ratio of the sums (§15.5) — do not average rates.',
      bad;
  END IF;

  -- 3. THE COUNTS ARE NULL, WITH THEIR UNIT. Asserted rather than assumed,
  --    because writing sum(total_out) into a mass column is the single most
  --    likely "improvement" to this file and the header says why it is wrong.
  SELECT count(*) INTO bad
    FROM oee.area_day_reports
   WHERE weight_uom_id IS NOT NULL
      OR total_out IS NOT NULL OR area_out IS NOT NULL OR good_out IS NOT NULL
      OR reject IS NOT NULL OR rework IS NOT NULL;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% area row(s) carry a count or a weight unit. This seed cannot convert a count to a mass — std_weight lives in mes-master-data — so a figure here is a number under a unit nobody established.',
      bad;
  END IF;

  RAISE NOTICE 'oee.area_day_reports: % row(s), durations verified as line-sums, rates verified as recomputed.', wrote;
END
$$;

-- ---------------------------------------------------------------------------
-- The watermark
-- ---------------------------------------------------------------------------
--
-- WITHOUT THIS ROW THE SCREENS CANNOT TELL "this area had no production" FROM
-- "the DAG has not run" — §8 and §14's distinction, and the reason
-- ck_etl_watermarks_table gained 'area_day_reports' in migration 0024.
--
-- `last_business_date` is set to the latest business date this file actually
-- wrote, so the banner is consistent with the rows beside it rather than claiming
-- a freshness the data does not have. `HAVING` is what keeps the row absent when
-- step 1 inserted nothing — a watermark over zero rows would say "loaded through
-- nothing", which reads as loaded.
--
-- `writer` names this seed, not 'dbt'. Contract §4 makes it free text precisely so
-- a one-off can say so; a row claiming 'dbt' would make a hand-run seed
-- indistinguishable from a DAG run in the one table that exists to tell them
-- apart.
INSERT INTO oee.etl_watermarks
  (table_name, last_run_at, last_business_date, rows_total, run_id, writer)
SELECT 'area_day_reports', now(), max(business_date), count(*), NULL, 'seed-0022-dev'
  FROM oee.area_day_reports
 HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE SET
  last_run_at        = EXCLUDED.last_run_at,
  last_business_date = EXCLUDED.last_business_date,
  rows_total         = EXCLUDED.rows_total,
  writer             = EXCLUDED.writer;
