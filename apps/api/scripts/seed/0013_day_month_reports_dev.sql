-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE. `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more: psql reports the error and carries
-- straight on to the next statement, so the refusal prints and the seed runs
-- anyway. That was observed, not theorised — the guard fired against the shared
-- Gold database and 18 rows landed regardless.
--
-- Setting it inside the FILE rather than relying on `psql -v ON_ERROR_STOP=1`
-- means the protection travels with the script, however it is invoked.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds in that directory, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0013_day_month_reports_dev.sql
--
-- READ THE GUARD AT THE TOP BEFORE YOU RUN IT. apps/api/.env points
-- GOLD_DATABASE_URL at a SHARED REMOTE DATABASE, not a local one. This script
-- fabricates shift reports, and running it there would put invented production
-- figures in front of real people. The guard refuses that one database by name;
-- it cannot know about yours, so check `\conninfo` first anyway.
--
-- WHY IT EXISTS
--
-- oee.work_unit_day_reports and oee.work_unit_month_reports ship EMPTY —
-- docs/gold-write-contract.md §1 rule 2 is that this service never bulk-inserts,
-- and no dbt model writes them yet (§15 is the ask). The By Day and By Monthly
-- screens are therefore unreachable by eye: their only state without rows is an
-- empty list. This file fills all three grains so the populated path can be
-- looked at in a browser.
--
-- AND IT IS ALSO THE SPECIFICATION OF THE ROLL-UP
--
-- That is the more important half, and it is why steps 3-5 DERIVE rather than
-- hand-write. Every day row below is computed from the shift rows underneath it
-- and every month row from the day rows, using exactly the rules
-- docs/gold-write-contract.md §15.5 states:
--
--     durations and counts  ->  SUM
--     rates (oee, teep, a, p, q, mttr, mtbf)  ->  RECOMPUTE from the sums
--
-- Never `avg(availability)`. Averaging a rate over 30 days is wrong in the
-- flattering direction — §3.5 of the contract works the arithmetic on the
-- analogous case and gets 1333.3/h against a true 1024.4/h. Because these rows
-- are derived, the integration suite's cross-check (a day equals the sum of its
-- shifts) passes against this seed by construction, and a dbt model that
-- disagrees with it is the model that is wrong.
--
-- WHAT IT FABRICATES, AND WHAT IT ONLY DERIVES
--
--   step 1  backfills business_date / time_zone on EXISTING shift rows   derived
--   step 2  invents a month of shift reports for two machines            FABRICATED
--   step 3  day reports                                                  derived
--   step 4  month reports                                                derived
--   step 5  product_count_wu_day                                         derived
--
-- Step 2 is the only invention, and it is `ON CONFLICT DO NOTHING`, so a real
-- shift report already in your dev database always wins and is never overwritten.
-- Steps 3-5 are `DO UPDATE`, so re-running refreshes them from whatever the shift
-- rows currently say — which is what makes this safe to run after you change the
-- source data.
--
-- THE SECOND MACHINE HAS ONE LIMITATION WORTH KNOWING
--
-- work_unit_id 4 is invented here so the list screens have more than one row.
-- The Line filter on those screens does NOT read work_center_id off these rows —
-- it resolves work-unit ids through mes-master-data
-- (`findAllWorkUnitIdsByWorkCenterId`). So if your master-data dev instance does
-- not know work unit 4, that filter will exclude it while the unfiltered list
-- still shows it. Change SECOND_WORK_UNIT below to an id master-data does know
-- if you need to exercise the filter.
--
-- TIME ZONE
--
-- Everything is Asia/Jakarta (UTC+7, no DST). That matches the plant the other
-- seeds assume, and it is the case where the naive readings all happen to work —
-- so this seed CANNOT reproduce the DST and westward-plant defects described in
-- contract §3.1 and §15.3. Those live in the integration suite, which builds its
-- own fixtures in a zone that actually has a transition.

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF current_database() = 'mes-master-data' THEN
    RAISE EXCEPTION
      'Refusing to seed fabricated reports into %. This is the shared Gold database that apps/api/.env points at. Point GOLD_DATABASE_URL at a local Postgres first.',
      current_database();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — backfill business_date and time_zone on existing shift reports
-- ---------------------------------------------------------------------------
--
-- 0013 added both columns nullable; Airflow has not filled them (TODOS.md §46).
-- Steps 3-5 group by business_date, so without this any pre-existing shift row
-- in your database would be silently excluded from its own day report.
--
-- `date` is the shift's START INSTANT, so `(date AT TIME ZONE tz)::date` is the
-- business day for all three shifts: 07:00, 15:00 and 23:00 local all fall on
-- the same local date, which is exactly why shift 3 belongs to the day it starts
-- on and not the one it ends on.
UPDATE oee.work_unit_shift_reports
   SET time_zone     = coalesce(time_zone, 'Asia/Jakarta'),
       business_date = coalesce(
         business_date,
         (date AT TIME ZONE coalesce(time_zone, 'Asia/Jakarta'))::date
       )
 WHERE business_date IS NULL OR time_zone IS NULL;

-- ---------------------------------------------------------------------------
-- Step 2 — a month of shift reports for two machines (THE ONLY FABRICATION)
-- ---------------------------------------------------------------------------
--
-- August 2026, three shifts a day, two work units: 186 rows.
--
-- THE NUMBERS ARE NOT RANDOM, and they must not become random. `random()` would
-- make every run produce a different chart, so nothing could be compared across
-- runs and no screenshot would reproduce. The variation comes from `v`, a
-- deterministic 0..11 derived from the day, the shift and the work unit — so
-- the same row always gets the same figures, and the two machines differ from
-- each other because the work unit is in the expression.
--
-- THE MEASURES SATISFY THE WATERFALL IDENTITIES. apps/web/src/lib/waterfall.ts
-- reads each bar as "the previous bar's base, with this step's losses stacked on
-- top", and it deliberately does NOT back-compute a band — a row whose parts do
-- not add up renders as a ragged chart rather than being papered over. So:
--
--     production_time   + pdt_time                            = availability_time
--     operating_time    + updt_time                           = production_time
--     net_time          + ms_time + reduce_speed_time         = operating_time
--     value_added_time  + reject_time + rework_time           = net_time
--
-- and the loss columns are the same quantities under the names the Losses card
-- reads: schedule = pdt, availability = updt, performance = ms + reduce_speed,
-- quality = reject + rework.
--
-- Output counts come from one cycle time (2000 ms/unit, 1800/hour) applied to
-- those same durations, which is what keeps `total_out = good_out + reject +
-- rework` true and keeps the time-based and count-based readings of Quality
-- agreeing with each other.
WITH params AS (
  SELECT
    'Asia/Jakarta'::text AS tz,
    2000::numeric        AS cycle_ms,        -- one unit per 2 s
    28800000::bigint     AS shift_ms         -- 8 h
),
grid AS (
  SELECT
    wu.id            AS work_unit_id,
    wu.name          AS work_unit_name,
    wu.code          AS work_unit_code,
    wu.wc_id         AS work_center_id,
    wu.wc_name       AS work_center_name,
    wu.wc_code       AS work_center_code,
    d::date          AS business_date,
    s                AS shift,
    p.tz, p.cycle_ms, p.shift_ms
  FROM params p
  CROSS JOIN generate_series('2026-08-01'::date, '2026-08-31'::date, interval '1 day') AS d
  CROSS JOIN generate_series(1, 3) AS s
  CROSS JOIN (VALUES
    -- SECOND_WORK_UNIT: change id 4 here if master-data knows a different one.
    (3, 'Vertical Packer N', 'VP-N', 1, 'Line 1', 'L1'),
    (4, 'Vertical Packer S', 'VP-S', 1, 'Line 1', 'L1')
  ) AS wu(id, name, code, wc_id, wc_name, wc_code)
),
shaped AS (
  SELECT
    g.*,
    (extract(day FROM g.business_date)::int * 7 + g.shift * 13 + (g.work_unit_id % 7) * 3) % 12 AS v
  FROM grid g
),
timed AS (
  SELECT
    s.*,
    -- All six loss inputs in milliseconds. Ranges are bounded so net_time and
    -- value_added_time stay comfortably positive at every combination of v.
    ((15 + s.v * 5) * 60000)::bigint                  AS pdt_ms,
    ((10 + ((s.v * 7) % 13) * 6) * 60000)::bigint     AS updt_ms,
    ((3 + (s.v % 5) * 4) * 60000)::bigint             AS ms_ms,
    ((5 + ((s.v * 3) % 7) * 3) * 60000)::bigint       AS rs_ms,
    (((s.v % 4) * 2) * 60000)::bigint                 AS reject_ms,
    (((s.v % 3) * 1) * 60000)::bigint                 AS rework_ms
  FROM shaped s
),
derived AS (
  SELECT
    t.*,
    t.shift_ms                                              AS availability_time,
    t.shift_ms - t.pdt_ms                                   AS production_time,
    t.shift_ms - t.pdt_ms - t.updt_ms                       AS operating_time,
    t.shift_ms - t.pdt_ms - t.updt_ms - t.ms_ms - t.rs_ms   AS net_time,
    t.shift_ms - t.pdt_ms - t.updt_ms - t.ms_ms - t.rs_ms
      - t.reject_ms - t.rework_ms                           AS value_added_time
  FROM timed t
)
INSERT INTO oee.work_unit_shift_reports (
  shift, date, business_date, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  uom_id, uom_name, uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  reject, rework, mttr, mtbf
)
SELECT
  d.shift,
  -- The shift's start instant: 07:00 / 15:00 / 23:00 plant-local, resolved
  -- through AT TIME ZONE so the stored timestamptz is right for that date.
  ((d.business_date + (CASE d.shift WHEN 1 THEN '07:00' WHEN 2 THEN '15:00' ELSE '23:00' END)::time)
     AT TIME ZONE d.tz),
  d.business_date,
  d.tz,
  d.work_unit_id, d.work_unit_name, d.work_unit_code,
  d.work_center_id, d.work_center_name, d.work_center_code,
  1, 'Bag', 'BAG',
  -- TEEP is value-added against CALENDAR time; OEE is against production time.
  round((d.value_added_time::numeric / d.availability_time) * 100, 3),
  round((d.value_added_time::numeric / d.production_time)   * 100, 3),
  round((d.operating_time::numeric  / d.production_time)    * 100, 3),
  round((d.net_time::numeric        / d.operating_time)     * 100, 3),
  round((d.value_added_time::numeric / d.net_time)          * 100, 3),
  round(d.net_time          / d.cycle_ms, 3),   -- total_out
  round(d.value_added_time  / d.cycle_ms, 3),   -- good_out
  round(d.value_added_time  / d.cycle_ms, 3),   -- effective_out
  d.operating_time,                             -- runtime
  d.availability_time, d.production_time, d.pdt_ms, d.operating_time,
  d.updt_ms, d.net_time, d.rs_ms, d.ms_ms, d.value_added_time,
  d.rework_ms, d.reject_ms, 0, 0,
  d.pdt_ms, d.updt_ms, d.ms_ms + d.rs_ms,
  d.ms_ms, d.rs_ms, d.reject_ms + d.rework_ms,
  round(d.reject_ms / d.cycle_ms, 3),
  round(d.rework_ms / d.cycle_ms, 3),
  -- One "failure" per 45 minutes of unplanned downtime, floor 1. Invented, and
  -- invented CONSISTENTLY: steps 3 and 4 recompute mttr/mtbf from these totals
  -- rather than averaging them, which is the behaviour §15.5 asks the pipeline
  -- for. The definition of a failure is the pipeline's, not this file's.
  d.updt_ms / greatest(1, d.updt_ms / 2700000),
  d.operating_time / greatest(1, d.updt_ms / 2700000)
FROM derived d
ON CONFLICT (date, shift, work_unit_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 3 — day reports, DERIVED from every shift report in the day
-- ---------------------------------------------------------------------------
--
-- This is the roll-up contract §15.5 describes, expressed as SQL. Read the
-- SELECT list as two halves: everything before `teep` is a SUM, and the five
-- rates are recomputed from those sums. There is no `avg()` anywhere in this
-- statement and there must never be one.
--
-- HOW BADLY avg() WOULD BE WRONG DEPENDS ON THE DATA, and on this seed it is
-- worth being honest about the size: measured against these rows the gap between
-- the recomputed OEE and `avg(shift.oee)` is 0.004 to 0.5 percentage points,
-- because every shift here is the same eight hours with production in all three.
-- That is NOT an argument that averaging is close enough. The gap is a function
-- of how much the shifts differ, and it is unbounded in the cases that matter —
-- a shift that ran for one hour, or a shift with no production at all, which
-- `avg` weights exactly as heavily as a full one. §3.5 of the contract works a
-- rate case where it reaches 1333.3/h against a true 1024.4/h.
--
-- work_center_* and uom_* are taken with min() because they are denormalised
-- labels that do not vary within a work unit; if they ever did, min() would pick
-- one silently — which is why the pipeline, not this seed, is the place that
-- decides such a case.
INSERT INTO oee.work_unit_day_reports (
  date, business_date, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  uom_id, uom_name, uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  reject, rework, mttr, mtbf
)
SELECT
  -- A day report's `date` is the day's START instant — 07:00 plant-local, which
  -- is shift 1's start. NOT midnight. contract §15.3.
  ((r.business_date + '07:00'::time) AT TIME ZONE min(r.time_zone)),
  r.business_date,
  min(r.time_zone),
  r.work_unit_id, min(r.work_unit_name), min(r.work_unit_code),
  min(r.work_center_id), min(r.work_center_name), min(r.work_center_code),
  min(r.uom_id), min(r.uom_name), min(r.uom_code),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),
  sum(r.total_out), sum(r.good_out), sum(r.effective_out),
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  sum(r.reject), sum(r.rework),
  -- MTTR/MTBF ARE RATIOS AND ARE RECOMPUTED, NOT AVERAGED. Each shift's failure
  -- count is recovered as updt_time / mttr, the counts are summed, and the day's
  -- values divide the summed durations by that total. avg(mttr) over three
  -- shifts weights a shift with one stop the same as a shift with twenty.
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time) / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time) / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.work_unit_shift_reports r
WHERE r.business_date IS NOT NULL
GROUP BY r.work_unit_id, r.business_date
ON CONFLICT (date, work_unit_id) DO UPDATE SET
  business_date = excluded.business_date, time_zone = excluded.time_zone,
  work_unit_name = excluded.work_unit_name, work_unit_code = excluded.work_unit_code,
  work_center_id = excluded.work_center_id, work_center_name = excluded.work_center_name,
  work_center_code = excluded.work_center_code,
  uom_id = excluded.uom_id, uom_name = excluded.uom_name, uom_code = excluded.uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out, runtime = excluded.runtime,
  availability_time = excluded.availability_time, production_time = excluded.production_time,
  pdt_time = excluded.pdt_time, operating_time = excluded.operating_time,
  updt_time = excluded.updt_time, net_time = excluded.net_time,
  reduce_speed_time = excluded.reduce_speed_time, ms_time = excluded.ms_time,
  value_added_time = excluded.value_added_time, rework_time = excluded.rework_time,
  reject_time = excluded.reject_time, anomaly_time = excluded.anomaly_time,
  up_speed_time = excluded.up_speed_time,
  schedule_loss_time = excluded.schedule_loss_time,
  availability_loss_time = excluded.availability_loss_time,
  performance_loss_time = excluded.performance_loss_time,
  ms_loss_time = excluded.ms_loss_time,
  reduce_speed_loss_time = excluded.reduce_speed_loss_time,
  quality_loss_time = excluded.quality_loss_time,
  reject = excluded.reject, rework = excluded.rework,
  mttr = excluded.mttr, mtbf = excluded.mtbf;

-- ---------------------------------------------------------------------------
-- Step 4 — month reports, DERIVED from the day reports
-- ---------------------------------------------------------------------------
--
-- Rolled up from step 3's output rather than from the shift rows directly. That
-- is deliberate: it proves the two-step chain the pipeline will actually build
-- (shift -> day -> month) rather than a shortcut that could hide a day-level
-- error, and month == sum(days) becomes independently checkable.
--
-- `month` is written as 'YYYY-MM'. That format is a GUESS — contract §15.7 asks
-- the pipeline owner to settle it, and nothing in this service reads the column,
-- so a different answer costs only a re-run of this file.
INSERT INTO oee.work_unit_month_reports (
  month, date, business_date, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  uom_id, uom_name, uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  reject, rework, mttr, mtbf
)
SELECT
  to_char(date_trunc('month', d.business_date), 'YYYY-MM'),
  -- The month's start instant: 07:00 plant-local on its FIRST business day.
  ((date_trunc('month', d.business_date)::date + '07:00'::time) AT TIME ZONE min(d.time_zone)),
  date_trunc('month', d.business_date)::date,
  min(d.time_zone),
  d.work_unit_id, min(d.work_unit_name), min(d.work_unit_code),
  min(d.work_center_id), min(d.work_center_name), min(d.work_center_code),
  min(d.uom_id), min(d.uom_name), min(d.uom_code),
  round(sum(d.value_added_time)::numeric / nullif(sum(d.availability_time), 0) * 100, 3),
  round(sum(d.value_added_time)::numeric / nullif(sum(d.production_time),   0) * 100, 3),
  round(sum(d.operating_time)::numeric   / nullif(sum(d.production_time),   0) * 100, 3),
  round(sum(d.net_time)::numeric         / nullif(sum(d.operating_time),    0) * 100, 3),
  round(sum(d.value_added_time)::numeric / nullif(sum(d.net_time),          0) * 100, 3),
  sum(d.total_out), sum(d.good_out), sum(d.effective_out),
  sum(d.runtime), sum(d.availability_time), sum(d.production_time), sum(d.pdt_time),
  sum(d.operating_time), sum(d.updt_time), sum(d.net_time), sum(d.reduce_speed_time),
  sum(d.ms_time), sum(d.value_added_time), sum(d.rework_time), sum(d.reject_time),
  sum(d.anomaly_time), sum(d.up_speed_time),
  sum(d.schedule_loss_time), sum(d.availability_loss_time), sum(d.performance_loss_time),
  sum(d.ms_loss_time), sum(d.reduce_speed_loss_time), sum(d.quality_loss_time),
  sum(d.reject), sum(d.rework),
  CASE WHEN sum(CASE WHEN d.mttr > 0 THEN d.updt_time::numeric / d.mttr ELSE 0 END) > 0
       THEN (sum(d.updt_time) / sum(CASE WHEN d.mttr > 0 THEN d.updt_time::numeric / d.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN d.mttr > 0 THEN d.updt_time::numeric / d.mttr ELSE 0 END) > 0
       THEN (sum(d.operating_time) / sum(CASE WHEN d.mttr > 0 THEN d.updt_time::numeric / d.mttr ELSE 0 END))::bigint
  END
FROM oee.work_unit_day_reports d
WHERE d.business_date IS NOT NULL
GROUP BY d.work_unit_id, date_trunc('month', d.business_date)
ON CONFLICT (date, month, work_unit_id) DO UPDATE SET
  business_date = excluded.business_date, time_zone = excluded.time_zone,
  work_unit_name = excluded.work_unit_name, work_unit_code = excluded.work_unit_code,
  work_center_id = excluded.work_center_id, work_center_name = excluded.work_center_name,
  work_center_code = excluded.work_center_code,
  uom_id = excluded.uom_id, uom_name = excluded.uom_name, uom_code = excluded.uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out, runtime = excluded.runtime,
  availability_time = excluded.availability_time, production_time = excluded.production_time,
  pdt_time = excluded.pdt_time, operating_time = excluded.operating_time,
  updt_time = excluded.updt_time, net_time = excluded.net_time,
  reduce_speed_time = excluded.reduce_speed_time, ms_time = excluded.ms_time,
  value_added_time = excluded.value_added_time, rework_time = excluded.rework_time,
  reject_time = excluded.reject_time, anomaly_time = excluded.anomaly_time,
  up_speed_time = excluded.up_speed_time,
  schedule_loss_time = excluded.schedule_loss_time,
  availability_loss_time = excluded.availability_loss_time,
  performance_loss_time = excluded.performance_loss_time,
  ms_loss_time = excluded.ms_loss_time,
  reduce_speed_loss_time = excluded.reduce_speed_loss_time,
  quality_loss_time = excluded.quality_loss_time,
  reject = excluded.reject, rework = excluded.rework,
  mttr = excluded.mttr, mtbf = excluded.mtbf;

-- ---------------------------------------------------------------------------
-- Step 5 — SKU counts, at shift grain then rolled up to day grain
-- ---------------------------------------------------------------------------
--
-- Without these the SKU View card is empty on both new screens even once the
-- report tables above are full, because oee.product_count_wu_day is ALSO unread
-- and unwritten today.
--
-- Two SKUs, split the way the reference design shows them: SKU A runs shifts 1
-- and 2, SKU B runs shift 3. That is what makes the Hourly Production dialog
-- render two series instead of one.
--
-- factor_to_base is 1 here. The interesting case — a counter whose unit differs
-- from the base unit, so the Counter and Converted columns hold visibly
-- different numbers — is already seeded at shift grain by
-- 0008_reject_count_dev.sql, and rendering counter_value in both columns is the
-- most plausible-looking way to get that screen wrong.
INSERT INTO oee.product_count_wu_shift (
  shift, shift_date, product_id, product_name, product_code,
  work_unit_id, work_unit_name, work_unit_code,
  uom_id, uom_name, uom_code,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT
  r.shift, r.business_date,
  CASE WHEN r.shift = 3 THEN 2 ELSE 1 END,
  CASE WHEN r.shift = 3 THEN 'SKU B' ELSE 'SKU A' END,
  CASE WHEN r.shift = 3 THEN 'SKU-B' ELSE 'SKU-A' END,
  r.work_unit_id, r.work_unit_name, r.work_unit_code,
  r.uom_id, r.uom_name, r.uom_code,
  1, 'Bag', 'BAG', 1,
  r.total_out, r.good_out, r.reject, r.rework
FROM oee.work_unit_shift_reports r
WHERE r.business_date BETWEEN '2026-08-01' AND '2026-08-31'
  AND r.work_unit_id IN (3, 4)
ON CONFLICT (work_unit_id, shift_date, shift, product_id) DO NOTHING;

-- A product's factor_to_base must not vary within a day, because
-- pk_product_count_wu_day is (work_unit_id, date, product_id) and there is
-- nowhere to put a second factor. Summing raw counts across differing factors is
-- the silent arithmetic error this check exists to make loud — it is failure
-- mode F2 in the plan, and it renders as a wrong SKU total rather than an error.
DO $$
DECLARE offenders int;
BEGIN
  SELECT count(*) INTO offenders FROM (
    SELECT 1 FROM oee.product_count_wu_shift
     GROUP BY work_unit_id, shift_date, product_id
    HAVING count(DISTINCT factor_to_base) > 1
  ) x;
  IF offenders > 0 THEN
    RAISE EXCEPTION
      '% (work_unit, day, product) group(s) have more than one factor_to_base. Rolling them up to product_count_wu_day would silently sum incompatible units.',
      offenders;
  END IF;
END
$$;

INSERT INTO oee.product_count_wu_day (
  date, product_id, product_name, product_code,
  work_unit_id, work_unit_name, work_unit_code,
  uom_id, uom_name, uom_code,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT
  p.shift_date, p.product_id, min(p.product_name), min(p.product_code),
  p.work_unit_id, min(p.work_unit_name), min(p.work_unit_code),
  min(p.uom_id), min(p.uom_name), min(p.uom_code),
  min(p.base_uom_id), min(p.base_uom_name), min(p.base_uom_code),
  -- Safe only because the assertion above proved it is unique in this group.
  min(p.factor_to_base),
  sum(p.total_out), sum(p.good_out), sum(p.reject), sum(p.rework)
FROM oee.product_count_wu_shift p
GROUP BY p.work_unit_id, p.shift_date, p.product_id
ON CONFLICT (work_unit_id, date, product_id) DO UPDATE SET
  product_name = excluded.product_name, product_code = excluded.product_code,
  work_unit_name = excluded.work_unit_name, work_unit_code = excluded.work_unit_code,
  uom_id = excluded.uom_id, uom_name = excluded.uom_name, uom_code = excluded.uom_code,
  base_uom_id = excluded.base_uom_id, base_uom_name = excluded.base_uom_name,
  base_uom_code = excluded.base_uom_code, factor_to_base = excluded.factor_to_base,
  total_out = excluded.total_out, good_out = excluded.good_out,
  reject = excluded.reject, rework = excluded.rework;

-- ---------------------------------------------------------------------------
-- Verify — run these after seeding; both must return zero rows
-- ---------------------------------------------------------------------------
--
-- This is the same invariant docs/gold-write-contract.md §15.6 asks the pipeline
-- to assert as a dbt test at `error` severity, and the same one the integration
-- suite checks. If a day disagrees with its shifts here, the roll-up above is
-- wrong and so is any model copied from it.
--
--   SELECT d.work_unit_id, d.business_date, d.runtime, s.runtime AS shift_sum
--     FROM oee.work_unit_day_reports d
--     JOIN (SELECT work_unit_id, business_date, sum(runtime) AS runtime
--             FROM oee.work_unit_shift_reports GROUP BY 1, 2) s
--       USING (work_unit_id, business_date)
--    WHERE d.runtime <> s.runtime;
--
--   SELECT m.work_unit_id, m.month, m.availability_time, d.availability_time
--     FROM oee.work_unit_month_reports m
--     JOIN (SELECT work_unit_id, date_trunc('month', business_date)::date AS bd,
--                  sum(availability_time) AS availability_time
--             FROM oee.work_unit_day_reports GROUP BY 1, 2) d
--       ON d.work_unit_id = m.work_unit_id AND d.bd = m.business_date
--    WHERE m.availability_time <> d.availability_time;
--
-- And the waterfall identity, which must hold on every row of all three tables:
--
--   SELECT id FROM oee.work_unit_day_reports
--    WHERE production_time + pdt_time <> availability_time
--       OR operating_time + updt_time <> production_time
--       OR net_time + ms_time + reduce_speed_time <> operating_time
--       OR value_added_time + reject_time + rework_time <> net_time;
