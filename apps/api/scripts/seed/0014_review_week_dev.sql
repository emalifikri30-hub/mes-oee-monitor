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
-- finds there, so a seed placed there would insert fabricated production data
-- into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0014_review_week_dev.sql
--
-- CHECK `\conninfo` FIRST. The guard below refuses one database by name; it
-- cannot know about yours. A stale dev server pointed at a seeded scratch
-- database already caused one round of "the browser shows 62 rows and the table
-- is empty", and these rows are fabricated production figures.
--
-- WHAT IT IS
--
-- One reviewable week — 2026-08-17 to 2026-08-22 inclusive, six business days,
-- three shifts each — populated across EVERY table the report screens read, at
-- all three grains:
--
--   oee.downtime_reports         the stops, with source_event_id so they are EDITABLE
--   oee.downtime_log_events      the immutable log behind the Others tab
--   oee.product_perf_wu_hour     the hourly chart and the month's hour-of-day profile
--   oee.product_count_wu_shift   SKU View at shift grain
--   oee.product_count_wu_day     SKU View at day and month grain
--   oee.reject_count_wu_shift    the Quality Loss Pareto
--   oee.work_unit_shift_reports  18 rows
--   oee.work_unit_day_reports    6 rows
--   oee.work_unit_month_reports  1 row (August, from these six days only)
--   oee.downtime_report_history  two operator edits, so Log Activity has entries
--
-- THE ORDER OF THE STEPS IS THE WHOLE DESIGN
--
-- The stops and the hourly rows are generated FIRST, and every report measure is
-- then DERIVED from them. That is what makes the screens agree with each other
-- rather than agreeing by coincidence:
--
--   Downtime Details' frequency IS the count of stops in the window.
--   The Availability Pareto's bars sum to the report's availability_loss_time.
--   The Schedule Loss Pareto's bars sum to schedule_loss_time.
--   SKU View's totals sum to the report's total_out / good_out / reject / rework.
--   The hourly chart's runtime sums to the report's runtime.
--   A day equals the sum of its three shifts; the month equals the sum of days.
--
-- Hand-writing the report rows and the stops independently is the obvious way to
-- do this and it is the wrong way: the numbers disagree, and a reviewer cannot
-- tell a seeding artefact from a real bug in the code they are reviewing.
--
-- WHAT IS DELIBERATELY NOT CONSISTENT
--
-- The timeline strip merges overlapping stops and resolves an overlap to the
-- WEAKER category, so its bands do not add up to the Losses card. timeline-card.tsx
-- says so on screen; this seed includes one overlapping pair on 2026-08-19 shift 2
-- specifically so that behaviour is visible rather than theoretical.
--
-- `reduce_speed_loss_time` has no per-cause records anywhere in Gold, so nothing
-- ranks it. It is generated as a shift-level figure only, which is exactly the
-- state performance-loss-tab.tsx explains beside the Small Stop ranking.
--
-- TIME ZONE
--
-- Asia/Jakarta, UTC+7, no DST — the plant these seeds assume. Business day D runs
-- 07:00 local to 07:00 local on D+1, so shift 3 of the 22nd ends on the 23rd.

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------

-- THE BYPASS IS A FLAG, NOT AN EDIT. The first version simply refused the shared
-- database by name, which meant seeding it deliberately required commenting this
-- block out — and a guard you have to delete to proceed is a guard that gets
-- deleted and left deleted. Requiring an explicit GUC keeps the refusal for
-- everyone who did not mean it, while making the override visible in the command
-- that ran rather than invisible in a working copy:
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0014_review_week_dev.sql
--
-- Both must be in ONE psql invocation. A separate `-c` call is a separate
-- session and the setting will not survive into this file.
DO $$
BEGIN
  IF current_database() = 'mes-master-data'
     AND coalesce(current_setting('seed.allow_shared', true), '') <> 'yes' THEN
    RAISE EXCEPTION
      'Refusing to seed fabricated reports into the shared database %. Point GOLD_DATABASE_URL at a local Postgres, or pass -c "SET seed.allow_shared = ''yes''" if you really mean it.',
      current_database();
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Parameters, and a clean slate for this window only
-- ---------------------------------------------------------------------------
--
-- Every DELETE is bounded to work_unit_id 3 AND the six-day window, so re-running
-- this file cannot touch another seed's rows or a real row outside it. It is the
-- reason every step below is safe to repeat.
--
-- work_unit_id 3 ("Vertical Packer N") is the machine 0007, 0008, 0009 and 0013
-- all target, and the one the reference designs show. ONE machine, not two: the
-- list screens get 18 shift rows and 6 day rows from it, which is enough to page,
-- and a second invented work unit is invisible to the Line filter anyway because
-- that filter resolves ids through mes-master-data rather than off these rows.

CREATE TEMP TABLE seed_params AS
-- EVERY DIMENSION HERE WAS READ OFF THE LIVE GOLD DATABASE, not carried over
-- from the earlier seeds. Those used work_center_id 1, code 'VP-N' and product
-- codes 'SKU-A'/'SKU-B'; the live rows say work_center_id 2, 'VERTICAL-PACKER-N',
-- 'FI2-L1' and 'SKU0A'/'SKU0B'. Getting these wrong does not fail — it produces a
-- second, near-identical machine and a second spelling of each SKU sitting beside
-- the real ones, which is worse than an error because it looks like data.
SELECT 3                       AS work_unit_id,
       'Vertical Packer N'     AS work_unit_name,
       'VERTICAL-PACKER-N'     AS work_unit_code,
       2                       AS work_center_id,
       'Line 1'                AS work_center_name,
       'FI2-L1'                AS work_center_code,
       2                       AS area_id,
       'FI2'                   AS area_name,
       1                       AS uom_id,
       'Bag'                   AS uom_name,
       'BAG'                   AS uom_code,
       'Asia/Jakarta'          AS tz,
       '2026-08-17'::date      AS from_date,
       '2026-08-22'::date      AS to_date,
       28800000::bigint        AS shift_ms,     -- 8 h
       2000::numeric           AS cycle_ms;     -- one bag per 2 s -> 1800/h

-- THE BUG THIS COMMENT USED TO DESCRIBE IS NOW UNREPRESENTABLE, which is the
-- clearest single argument for migration 0021 and worth keeping the record of.
--
-- `downtime_reports.date` WAS a timestamptz holding midnight plant-local, not a
-- calendar date — so `date BETWEEN d0 AND d1` compared it against midnight UTC
-- and silently dropped the first day for any plant east of Greenwich (business
-- day 2026-08-17 was stored as 2026-08-16T17:00Z at UTC+7). This file was written
-- with that bug; it broke the DELETE, so a second run collided on
-- source_event_id instead of replacing cleanly. The fix at the time was to repeat
-- the INSERT's AT TIME ZONE expression here, character for character.
--
-- 0021 replaced the column with `business_date date` and 0022 dropped it, so the
-- two bounds below are now a plain date comparison — the same shape the
-- downtime_log_events and product_* deletes below have always had. There is no
-- expression to keep in step and no zone to get wrong.
DELETE FROM oee.downtime_report_history h
 USING oee.downtime_reports d
 WHERE d.source_event_id = h.source_event_id
   AND d.work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND d.business_date BETWEEN (SELECT from_date FROM seed_params)
                           AND (SELECT to_date FROM seed_params);

DELETE FROM oee.downtime_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params)
                         AND (SELECT to_date FROM seed_params);

DELETE FROM oee.downtime_log_events
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

DELETE FROM oee.product_perf_wu_hour
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

DELETE FROM oee.product_count_wu_shift
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

DELETE FROM oee.product_count_wu_day
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

DELETE FROM oee.reject_count_wu_shift
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

DELETE FROM oee.work_unit_shift_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

DELETE FROM oee.work_unit_day_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params);

-- The month row is rebuilt from these six days ALONE, so it is deleted whole.
-- That makes August's month report describe the seeded week rather than the whole
-- month, which is the honest thing when only one week exists.
DELETE FROM oee.work_unit_month_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date = date_trunc('month', (SELECT from_date FROM seed_params))::date;

-- ---------------------------------------------------------------------------
-- Step 1 — the shift grid, and each shift's deterministic shape
-- ---------------------------------------------------------------------------
--
-- `v` is a 0-11 value derived from the day and the shift. DETERMINISTIC, never
-- random: `random()` would make every run produce different charts, so no
-- screenshot would reproduce and no two reviewers would see the same numbers.
--
-- Shift 3 is deliberately the worst performer and shift 1 the best, because a
-- report where every shift looks alike hides whether the screens are actually
-- reading per-shift data.

CREATE TEMP TABLE seed_shifts AS
SELECT
  p.*,
  d::date                                                        AS business_date,
  s                                                              AS shift,
  extract(day FROM d)::int                                       AS dom,
  -- COEFFICIENTS CHOSEN SO ADJACENT SHIFTS DO NOT COLLIDE. The obvious
  -- `(dom * 5 + shift * 7) % 12` looks fine and is not: 5 + 7 = 12, so moving one
  -- day forward and one shift forward returns the SAME v, and 17-s1, 18-s2 and
  -- 19-s3 came out byte-identical. Repeated numbers across a review week read as
  -- a bug in the code being reviewed. A prime modulus with small coprime
  -- coefficients has no such short cycle.
  ((extract(day FROM d)::int * 3 + s * 5) % 11)                  AS v,
  -- The shift's start instant: 07:00 / 15:00 / 23:00 plant-local, resolved
  -- through AT TIME ZONE so the stored timestamptz is right for that date.
  ((d::date + (CASE s WHEN 1 THEN '07:00' WHEN 2 THEN '15:00' ELSE '23:00' END)::time)
     AT TIME ZONE p.tz)                                          AS shift_start,
  -- SKU A on shifts 1 and 2, SKU B on shift 3. That gives every DAY two SKUs, so
  -- SKU View and the hourly chart both render two blocks rather than one.
  CASE WHEN s = 3 THEN 2 ELSE 1 END                              AS product_id,
  CASE WHEN s = 3 THEN 'SKU B' ELSE 'SKU A' END                  AS product_name,
  CASE WHEN s = 3 THEN 'SKU0B' ELSE 'SKU0A' END                  AS product_code
FROM seed_params p
CROSS JOIN generate_series(
  (SELECT from_date FROM seed_params),
  (SELECT to_date FROM seed_params),
  interval '1 day'
) AS d
CROSS JOIN generate_series(1, 3) AS s;

-- ---------------------------------------------------------------------------
-- Step 2 — THE STOPS. Everything downstream is derived from these.
-- ---------------------------------------------------------------------------
--
-- Between three and six stops per shift, drawn from a small catalogue so the
-- Paretos have a shape worth looking at: a dominant reason, a long tail, and one
-- unlabelled stop so the "Unspecified" bucket is reachable.
--
-- CATEGORIES CARRY MEANING HERE, and the report measures below depend on it:
--   PLANNED     -> schedule loss    (subtracted from calendar to reach production)
--   UNPLANNED   -> availability loss
--   SMALL_STOP  -> the micro-stop half of performance loss
--
-- `source_event_id` IS POPULATED, which is what makes these stops editable at all
-- — the PATCH route is addressed by it, and the pipeline does not write it yet
-- (TODOS.md §19). Without it the edit dialog is unreachable and Log Activity can
-- never carry a downtime entry, so a review of those features needs this column.

CREATE TEMP TABLE seed_stops AS
WITH catalogue(idx, reason, category, actions, detail) AS (
  VALUES
    (0, 'Machine_Stop',      'UNPLANNED'::oee.operation_type, '["Restart machine","Inspect sensor"]'::jsonb, 'Sensor tripped on the infeed conveyor.'),
    (1, 'Film_Change',       'PLANNED'::oee.operation_type,   '["Replace film reel"]'::jsonb,               NULL),
    (2, 'Jam_Sealing_Jaw',   'UNPLANNED'::oee.operation_type, '["Clear jam","Clean jaw"]'::jsonb,           'Product build-up under the sealing jaw.'),
    (3, 'Cleaning',          'PLANNED'::oee.operation_type,   '["Wet clean","Sanitise"]'::jsonb,            NULL),
    (4, 'Minor_Adjustment',  'SMALL_STOP'::oee.operation_type,'["Adjust guide"]'::jsonb,                    NULL),
    (5, 'Label_Misfeed',     'SMALL_STOP'::oee.operation_type,'[]'::jsonb,                                  NULL),
    (6, 'Air_Pressure_Low',  'UNPLANNED'::oee.operation_type, '["Check compressor"]'::jsonb,                'Line pressure dropped below 5 bar.'),
    -- THE UNLABELLED ONE. `reason = '[]'` is what the Pareto's "Unspecified"
    -- bucket groups, and lib/pareto.ts applies that label client-side precisely
    -- so a genuine reason of that text cannot merge into it. Unreachable without
    -- a row like this.
    (7, NULL,                'UNPLANNED'::oee.operation_type, '[]'::jsonb,                                  NULL)
),
picks AS (
  -- 3-6 stops per shift, and which catalogue entries they draw. The modular
  -- arithmetic is arbitrary but fixed; what matters is that reason 0 and 2 recur
  -- often enough to dominate the Availability Pareto while 6 and 7 stay a tail.
  SELECT sh.*,
         n,
         (sh.v * 3 + n * 5) % 8 AS idx
  FROM seed_shifts sh
  -- LATERAL, so the count depends on the shift's own `v`: 3 to 6 stops.
  CROSS JOIN LATERAL generate_series(0, 2 + (sh.v % 4)) AS n
),
timed AS (
  SELECT
    p.*,
    c.reason, c.category, c.actions, c.detail,
    -- Stops are laid out in sequence from the shift's start, each preceded by a
    -- gap. A gap between records is what the timeline strip calls RUN_TIME — it
    -- is not stored, which is why a clean shift and an unloaded one look alike
    -- there (TODOS.md §8).
    p.shift_start
      + make_interval(secs => (600 + p.n * 3300 + (p.v * 137) % 900))          AS start_at,
    -- Duration by category: planned stops are long, unplanned mid, small stops
    -- short by definition. Bounded so the sums below cannot exceed the shift.
    (CASE c.category
       WHEN 'PLANNED'    THEN 900000  + ((p.v * 7  + p.n * 11) % 5)  * 180000  -- 15-27 min
       WHEN 'UNPLANNED'  THEN 480000  + ((p.v * 13 + p.n * 17) % 7)  * 240000  --  8-32 min
       ELSE                   60000   + ((p.v * 5  + p.n * 3)  % 5)  * 60000   --  1-5 min
     END)::bigint                                                              AS duration_ms
  FROM picks p
  JOIN catalogue c ON c.idx = p.idx
)
SELECT
  t.*,
  -- A STABLE, UNIQUE PUBLIC ID PER STOP. Shaped like Flink's so the screens read
  -- the way they will in production.
  format('evt-%s-s%s-%s', to_char(t.business_date, 'YYYYMMDD'), t.shift, t.n) AS source_event_id,
  t.start_at + make_interval(secs => t.duration_ms / 1000)                     AS end_at
FROM timed t;

-- ONE OVERLAPPING PAIR, on 2026-08-19 shift 2, added on purpose.
--
-- The timeline strip resolves an overlap to the WEAKER category (run time >
-- small stop > planned > unplanned), so where this PLANNED window covers an
-- UNPLANNED stop the band renders BLUE. That inverts the conventional OEE
-- reading and is a product decision core-api's SEGMENT_PRIORITY owns — worth
-- being able to see rather than take on trust, and worth knowing the strip and
-- the Losses card therefore disagree by construction.
-- DERIVED FROM THE TARGET STOP rather than placed at a fixed offset. The first
-- version hardcoded +15 min for 40 min, which happened to overlap another PLANNED
-- stop and not the UNPLANNED one — so the case it was added to demonstrate was not
-- actually on screen. Wrapping the shift's first UNPLANNED stop with five minutes
-- either side makes the overlap an invariant instead of an arithmetic coincidence
-- that breaks the next time the generator's offsets change.
INSERT INTO seed_stops
SELECT sh.*,
       99                                                AS n,
       3                                                 AS idx,
       'Cleaning'                                        AS reason,
       'PLANNED'::oee.operation_type                      AS category,
       '["Wet clean"]'::jsonb                             AS actions,
       'Deliberately wraps an unplanned stop, so the strip renders the weaker category.' AS detail,
       t.start_at - interval '5 minutes'                  AS start_at,
       (extract(epoch FROM (t.end_at - t.start_at)) * 1000 + 600000)::bigint AS duration_ms,
       format('evt-%s-s%s-overlap', to_char(sh.business_date, 'YYYYMMDD'), sh.shift) AS source_event_id,
       t.end_at + interval '5 minutes'                    AS end_at
FROM seed_shifts sh
JOIN LATERAL (
  SELECT s.start_at, s.end_at
    FROM seed_stops s
   WHERE s.business_date = sh.business_date
     AND s.shift = sh.shift
     AND s.category = 'UNPLANNED'
   ORDER BY s.n
   LIMIT 1
) t ON true
WHERE sh.business_date = '2026-08-19' AND sh.shift = 2;

INSERT INTO oee.downtime_reports (
  reason, category, work_unit_id, shift, business_date, time_zone, actions, start_at, end_at, duration,
  work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
  source_event_id, area_id, area_name, detail_reason, input_by, maintained_by
)
SELECT
  -- `reason` is a jsonb ARRAY of plain strings, and element 0 is the key every
  -- Pareto groups on. `[]` is the unlabelled bucket. ck_downtime_reports_reason
  -- rejects blanks, so a NULL reason must become an empty array rather than
  -- '[""]'.
  CASE WHEN s.reason IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.reason) END,
  s.category, s.work_unit_id, s.shift,
  -- The business day the stop STARTED in, as a REAL date, plus the zone it was
  -- cut in. This used to write `date` — a timestamptz built by pushing local
  -- midnight through AT TIME ZONE — which migration 0022 dropped. 0021's pair
  -- replaces it and needs no such construction: a business day is a date.
  --
  -- Writing `time_zone` beside it is not optional. A business day with no zone
  -- cannot be turned back into an instant range, which is why 0021 added the two
  -- together and why contract §22.2 refuses a cast as the backfill.
  s.business_date::date, s.tz,
  s.actions, s.start_at, s.end_at, s.duration_ms,
  s.work_unit_name, s.work_unit_code, s.work_center_id, s.work_center_name, s.work_center_code,
  s.source_event_id, s.area_id, s.area_name, s.detail, 'operator.dev', 'maintenance.dev'
FROM seed_stops s;

-- The immutable log behind the Others tab. Mirrors the stops one-for-one, which
-- is what makes its frequency reconcilable with Downtime Details — and carries a
-- `reasons text[]`, not jsonb, so the Others Pareto explodes an array rather
-- than reading element 0.
INSERT INTO oee.downtime_log_events (
  event_id, work_unit_id, shift_date, shift, reasons, category,
  work_unit_name, work_unit_code, work_center_id, work_center_name,
  area_id, area_name, time_zone
)
SELECT s.source_event_id, s.work_unit_id, s.business_date, s.shift,
       CASE WHEN s.reason IS NULL THEN ARRAY[]::text[] ELSE ARRAY[s.reason] END,
       s.category,
       s.work_unit_name, s.work_unit_code, s.work_center_id, s.work_center_name,
       s.area_id, s.area_name, s.tz
FROM seed_stops s;

-- ---------------------------------------------------------------------------
-- Step 3 — each shift's losses, SUMMED FROM ITS OWN STOPS
-- ---------------------------------------------------------------------------
--
-- This is the join that makes the screens agree. Every loss column below is a
-- sum over step 2's rows, so the Availability Pareto's bars add up to
-- availability_loss_time by construction rather than by luck.
--
-- `reduce_speed_time` is the exception and has to be: no table in Gold records
-- WHY a machine ran slow, so it is generated at shift level only. That is
-- exactly the state performance-loss-tab.tsx explains on screen.

CREATE TEMP TABLE seed_measures AS
WITH stop_sums AS (
  SELECT business_date, shift,
         coalesce(sum(duration_ms) FILTER (WHERE category = 'PLANNED'), 0)::bigint    AS pdt_ms,
         coalesce(sum(duration_ms) FILTER (WHERE category = 'UNPLANNED'), 0)::bigint  AS updt_ms,
         coalesce(sum(duration_ms) FILTER (WHERE category = 'SMALL_STOP'), 0)::bigint AS ms_ms
  FROM seed_stops
  GROUP BY business_date, shift
)
SELECT
  sh.*,
  s.pdt_ms, s.updt_ms, s.ms_ms,
  -- Reduce speed: 4-11 minutes, deterministic, no per-cause records.
  ((4 + sh.v % 8) * 60000)::bigint                                       AS rs_ms,
  -- Reject and rework as TIME, converted to counts further down at one cycle
  -- each so the two readings of Quality cannot disagree.
  ((sh.v % 5) * 40000)::bigint                                           AS reject_ms,
  ((sh.v % 3) * 20000)::bigint                                           AS rework_ms,
  sh.shift_ms                                                            AS availability_time,
  sh.shift_ms - s.pdt_ms                                                 AS production_time,
  sh.shift_ms - s.pdt_ms - s.updt_ms                                     AS operating_time
FROM seed_shifts sh
JOIN stop_sums s USING (business_date, shift);

CREATE TEMP TABLE seed_derived AS
SELECT
  m.*,
  m.operating_time - m.ms_ms - m.rs_ms                                   AS net_time,
  m.operating_time - m.ms_ms - m.rs_ms - m.reject_ms - m.rework_ms       AS value_added_time
FROM seed_measures m;

-- A shift whose stops swallowed the whole window would make every rate below
-- divide by zero or go negative. The generator's bounds prevent it; this asserts
-- it rather than trusting the arithmetic, because a negative value_added_time
-- renders as a ragged waterfall rather than as an error.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM seed_derived
   WHERE production_time <= 0 OR operating_time <= 0 OR net_time <= 0 OR value_added_time <= 0;
  IF bad > 0 THEN
    RAISE EXCEPTION '% shift(s) have non-positive derived time. The stop durations in step 2 are too long.', bad;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 4 — the hourly rows, distributing each shift's runtime across 8 buckets
-- ---------------------------------------------------------------------------
--
-- `runtime` per bucket is capped at one hour by ck_ppwuh_runtime, and the eight
-- buckets sum to the shift's operating_time — so the hourly chart's total
-- reconciles with the report's runtime rather than being an independent guess.
--
-- ck_ppwuh_rate_defined also forbids output with no runtime, so a bucket that
-- got zero runtime must get zero output. The CASE below is that constraint
-- honoured rather than discovered.

CREATE TEMP TABLE seed_hours AS
WITH spread AS (
  SELECT d.*,
         h,
         -- Even split, with the remainder on the first bucket so the eight sum
         -- exactly. An off-by-a-millisecond here would break the reconciliation
         -- the whole file exists for.
         (d.operating_time / 8) + CASE WHEN h = 0 THEN d.operating_time % 8 ELSE 0 END AS bucket_runtime
  FROM seed_derived d
  CROSS JOIN generate_series(0, 7) AS h
)
SELECT
  s.*,
  -- Local clock hour of this bucket, 0-23. Shift 3 wraps past midnight, which is
  -- why hour_of_day is a LABEL and shift_hour_seq is the position.
  ((CASE s.shift WHEN 1 THEN 7 WHEN 2 THEN 15 ELSE 23 END) + s.h) % 24        AS hour_of_day,
  s.h                                                                          AS shift_hour_seq,
  s.shift_start + make_interval(hours => s.h)                                  AS bucket_start,
  s.shift_start + make_interval(hours => s.h + 1)                              AS bucket_end,
  round(s.bucket_runtime::numeric / s.cycle_ms, 3)                             AS bucket_total_out,
  -- The master standard: one bag per 1.8 s, i.e. 2000/h — deliberately ABOVE the
  -- actual 1800/h so there is a visible performance gap to look at. Null on one
  -- day so the "no standard known" path is reachable: the chart omits the Master
  -- Rate line rather than substituting the actual rate.
  CASE WHEN s.business_date = '2026-08-21' THEN NULL ELSE 2000::numeric END    AS ideal_rate
FROM spread s;

INSERT INTO oee.product_perf_wu_hour (
  bucket_start, bucket_end, work_unit_id, product_id,
  business_date, shift, hour_of_day, shift_hour_seq, time_zone,
  work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
  area_id, area_name, product_name, product_code,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, effective_out, reject, rework, runtime, ideal_rate_per_hour, ideal_rate_source
)
SELECT
  h.bucket_start, h.bucket_end, h.work_unit_id, h.product_id,
  h.business_date, h.shift, h.hour_of_day, h.shift_hour_seq, h.tz,
  h.work_unit_name, h.work_unit_code, h.work_center_id, h.work_center_name, h.work_center_code,
  h.area_id, h.area_name, h.product_name, h.product_code,
  h.uom_id, h.uom_name, h.uom_code, h.uom_id, h.uom_name, h.uom_code, 1,
  -- ck_ppwuh_rate_defined: output requires runtime.
  CASE WHEN h.bucket_runtime > 0 THEN h.bucket_total_out ELSE 0 END,
  CASE WHEN h.bucket_runtime > 0 THEN h.bucket_total_out ELSE 0 END,
  CASE WHEN h.bucket_runtime > 0 THEN round(h.bucket_total_out * 0.97, 3) ELSE 0 END,
  0, 0,
  h.bucket_runtime,
  h.ideal_rate,
  CASE WHEN h.ideal_rate IS NULL THEN NULL ELSE 'master-data' END
FROM seed_hours h;

-- ---------------------------------------------------------------------------
-- Step 5 — SKU counts at shift grain, then rolled to day grain
-- ---------------------------------------------------------------------------
--
-- Derived from the same net_time the report uses, at the same cycle time, so SKU
-- View's totals reconcile with the Summary OEE tiles above it.
--
-- total_out = good_out + reject + rework holds because all three come from the
-- same division. factor_to_base is 1 here; 0008's seed exercises the != 1 case
-- at shift grain, where the Counter and Converted columns must differ.

INSERT INTO oee.product_count_wu_shift (
  shift, shift_date, product_id, product_name, product_code,
  work_unit_id, work_unit_name, work_unit_code,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT d.shift, d.business_date, d.product_id, d.product_name, d.product_code,
       d.work_unit_id, d.work_unit_name, d.work_unit_code,
       d.uom_id, d.uom_name, d.uom_code, d.uom_id, d.uom_name, d.uom_code, 1,
       round(d.net_time / d.cycle_ms, 3),
       round(d.value_added_time / d.cycle_ms, 3),
       round(d.reject_ms / d.cycle_ms, 3),
       round(d.rework_ms / d.cycle_ms, 3)
FROM seed_derived d;

INSERT INTO oee.product_count_wu_day (
  date, product_id, product_name, product_code,
  work_unit_id, work_unit_name, work_unit_code,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT p.shift_date, p.product_id, min(p.product_name), min(p.product_code),
       p.work_unit_id, min(p.work_unit_name), min(p.work_unit_code),
       min(p.uom_id), min(p.uom_name), min(p.uom_code),
       min(p.base_uom_id), min(p.base_uom_name), min(p.base_uom_code),
       min(p.factor_to_base),
       sum(p.total_out), sum(p.good_out), sum(p.reject), sum(p.rework)
FROM oee.product_count_wu_shift p
WHERE p.work_unit_id = (SELECT work_unit_id FROM seed_params)
  AND p.shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
GROUP BY p.work_unit_id, p.shift_date, p.product_id;

-- ---------------------------------------------------------------------------
-- Step 6 — the reject counters behind the Quality Loss Pareto
-- ---------------------------------------------------------------------------
--
-- Three counters, splitting each shift's reject count so the bars sum to it.
--
-- `weight_gram` is NULL on one of the three DELIBERATELY: the design's own
-- annotation says "some reason does not have weight value", and NULL and 0 are
-- different claims the screen renders differently — an em dash versus a zero.
-- Seeding 0 everywhere would make the em dash unreachable and the weight ranking
-- untestable. `converted_value` is GENERATED and must not be inserted.

INSERT INTO oee.reject_count_wu_shift (
  work_unit_id, shift_date, shift, product_id, reason,
  work_unit_name, work_unit_code, work_center_id, work_center_name,
  product_name, product_code,
  uom_id, uom_name, uom_code, counter_value,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  weight_gram, frequency, reject_time, time_zone
)
SELECT d.work_unit_id, d.business_date, d.shift, d.product_id, c.reason,
       d.work_unit_name, d.work_unit_code, d.work_center_id, d.work_center_name,
       d.product_name, d.product_code,
       d.uom_id, d.uom_name, d.uom_code,
       round(d.reject_ms / d.cycle_ms * c.share, 3),
       d.uom_id, d.uom_name, d.uom_code, 1,
       c.weight, c.freq,
       round(d.reject_ms * c.share)::bigint,
       d.tz
FROM seed_derived d
CROSS JOIN (VALUES
  ('Seal_Leak',      0.50, 12.5::numeric, 3),
  ('Underweight',    0.30, 8.0::numeric,  2),
  -- The one with no weight recorded.
  ('Print_Defect',   0.20, NULL::numeric, 1)
) AS c(reason, share, weight, freq)
WHERE d.reject_ms > 0;

-- ---------------------------------------------------------------------------
-- Step 7 — the shift reports, DERIVED
-- ---------------------------------------------------------------------------
--
-- Rates are recomputed from the durations above, never stored independently:
--   availability = operating / production
--   performance  = net / operating
--   quality      = value_added / net
--   oee          = a x p x q  ==  value_added / production
--   teep         = value_added / calendar
--
-- The waterfall identities hold by construction, which is what stops
-- waterfall.ts drawing a ragged chart:
--   production + pdt = calendar; operating + updt = production;
--   net + ms + rs = operating; value_added + reject + rework = net.

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
  d.shift, d.shift_start, d.business_date, d.tz,
  d.work_unit_id, d.work_unit_name, d.work_unit_code,
  d.work_center_id, d.work_center_name, d.work_center_code,
  d.uom_id, d.uom_name, d.uom_code,
  round(d.value_added_time::numeric / d.availability_time * 100, 3),
  round(d.value_added_time::numeric / d.production_time   * 100, 3),
  round(d.operating_time::numeric   / d.production_time   * 100, 3),
  round(d.net_time::numeric         / d.operating_time    * 100, 3),
  round(d.value_added_time::numeric / d.net_time          * 100, 3),
  round(d.net_time          / d.cycle_ms, 3),
  round(d.value_added_time  / d.cycle_ms, 3),
  round(d.value_added_time  / d.cycle_ms, 3),
  d.operating_time, d.availability_time, d.production_time, d.pdt_ms, d.operating_time,
  d.updt_ms, d.net_time, d.rs_ms, d.ms_ms, d.value_added_time,
  d.rework_ms, d.reject_ms, 0, 0,
  d.pdt_ms, d.updt_ms, d.ms_ms + d.rs_ms,
  d.ms_ms, d.rs_ms, d.reject_ms + d.rework_ms,
  round(d.reject_ms / d.cycle_ms, 3),
  round(d.rework_ms / d.cycle_ms, 3),
  -- MTTR / MTBF from the shift's OWN unplanned stop count, so the badge agrees
  -- with the Downtime Frequency beside it. The pipeline owns the real definition
  -- of a "failure"; this stands in for it.
  (d.updt_ms / greatest(1, (SELECT count(*) FROM seed_stops s
                             WHERE s.business_date = d.business_date AND s.shift = d.shift
                               AND s.category = 'UNPLANNED')))::bigint,
  (d.operating_time / greatest(1, (SELECT count(*) FROM seed_stops s
                             WHERE s.business_date = d.business_date AND s.shift = d.shift
                               AND s.category = 'UNPLANNED')))::bigint
FROM seed_derived d;

-- ---------------------------------------------------------------------------
-- Step 8 — day and month, rolled up
-- ---------------------------------------------------------------------------
--
-- Durations and counts SUM; rates are RECOMPUTED from those sums. Never
-- avg(availability) — see gold-write-contract.md §15.5. This is the same
-- arithmetic 0013's seed states and the same one the integration suite's
-- cross-check asserts.

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
  (r.business_date + '07:00'::time) AT TIME ZONE min(r.time_zone),
  r.business_date, min(r.time_zone),
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
  -- Ratios, so each shift's failure count is recovered as updt/mttr, the counts
  -- are summed, and the day divides the summed durations by that total.
  -- avg(mttr) would weight a shift with one stop like a shift with twenty.
  (sum(r.updt_time) / greatest(1, sum(CASE WHEN r.mttr > 0 THEN r.updt_time / r.mttr ELSE 0 END)))::bigint,
  (sum(r.operating_time) / greatest(1, sum(CASE WHEN r.mttr > 0 THEN r.updt_time / r.mttr ELSE 0 END)))::bigint
FROM oee.work_unit_shift_reports r
WHERE r.work_unit_id = (SELECT work_unit_id FROM seed_params)
  AND r.business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
GROUP BY r.work_unit_id, r.business_date;

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
  (date_trunc('month', d.business_date)::date + '07:00'::time) AT TIME ZONE min(d.time_zone),
  date_trunc('month', d.business_date)::date, min(d.time_zone),
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
  (sum(d.updt_time) / greatest(1, sum(CASE WHEN d.mttr > 0 THEN d.updt_time / d.mttr ELSE 0 END)))::bigint,
  (sum(d.operating_time) / greatest(1, sum(CASE WHEN d.mttr > 0 THEN d.updt_time / d.mttr ELSE 0 END)))::bigint
FROM oee.work_unit_day_reports d
WHERE d.work_unit_id = (SELECT work_unit_id FROM seed_params)
  AND d.business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
GROUP BY d.work_unit_id, date_trunc('month', d.business_date);

-- ---------------------------------------------------------------------------
-- Step 9 — two operator edits, so Log Activity and the stale banner have data
-- ---------------------------------------------------------------------------
--
-- oee.downtime_report_history is what the shift report's Log Activity panel and
-- the "A downtime category was changed on ..." banner both read. Nothing writes
-- it unless an operator edits a stop, so both are unreachable on fresh data.
--
-- A `field = 'category'` row is the one that lights the banner: metrics-staleness
-- reports the newest category change among the stops in the window, and the
-- banner then says the OEE tiles and the waterfall still show pre-edit values.
-- That is TRUE of these rows — the report measures above were derived from the
-- ORIGINAL categories — so the warning is honest rather than decorative.
INSERT INTO oee.downtime_report_history (source_event_id, changed_at, changed_by, field, old_value, new_value)
SELECT s.source_event_id,
       s.end_at + interval '2 hours',
       'dev-operator-sub',
       'category',
       to_jsonb('UNPLANNED'::text),
       to_jsonb('PLANNED'::text)
FROM seed_stops s
WHERE s.business_date = '2026-08-18' AND s.shift = 1 AND s.category = 'UNPLANNED'
ORDER BY s.n
LIMIT 1;

INSERT INTO oee.downtime_report_history (source_event_id, changed_at, changed_by, field, old_value, new_value)
SELECT s.source_event_id,
       s.end_at + interval '3 hours',
       'dev-operator-sub',
       'reason',
       '["Machine_Stop"]'::jsonb,
       '["Machine_Stop","Operator corrected the cause"]'::jsonb
FROM seed_stops s
WHERE s.business_date = '2026-08-18' AND s.shift = 1
ORDER BY s.n DESC
LIMIT 1;

-- ---------------------------------------------------------------------------
-- Step 10 — assert the reconciliations this file exists to guarantee
-- ---------------------------------------------------------------------------
--
-- Every one of these is a claim the screens make. If any fails, a reviewer would
-- see two cards disagree and have no way to tell a seeding artefact from a real
-- bug in the code under review — which is the whole reason the checks are here
-- rather than in a comment.
DO $$
DECLARE
  wu int := (SELECT work_unit_id FROM seed_params);
  d0 date := (SELECT from_date FROM seed_params);
  d1 date := (SELECT to_date FROM seed_params);
  bad int;
BEGIN
  -- The waterfall identities, on all three grains.
  SELECT count(*) INTO bad FROM oee.work_unit_shift_reports
   WHERE work_unit_id = wu AND business_date BETWEEN d0 AND d1
     AND (production_time + pdt_time <> availability_time
       OR operating_time + updt_time <> production_time
       OR net_time + ms_time + reduce_speed_time <> operating_time
       OR value_added_time + reject_time + rework_time <> net_time);
  IF bad > 0 THEN RAISE EXCEPTION '% shift report(s) break the waterfall identities', bad; END IF;

  SELECT count(*) INTO bad FROM oee.work_unit_day_reports
   WHERE work_unit_id = wu AND business_date BETWEEN d0 AND d1
     AND (production_time + pdt_time <> availability_time
       OR operating_time + updt_time <> production_time
       OR net_time + ms_time + reduce_speed_time <> operating_time
       OR value_added_time + reject_time + rework_time <> net_time);
  IF bad > 0 THEN RAISE EXCEPTION '% day report(s) break the waterfall identities', bad; END IF;

  -- Losses vs the stops they were summed from. This is the reconciliation the
  -- Availability and Schedule Paretos depend on.
  SELECT count(*) INTO bad
    FROM oee.work_unit_shift_reports r
    JOIN (SELECT business_date, shift,
                 coalesce(sum(duration_ms) FILTER (WHERE category = 'PLANNED'), 0)   AS pdt,
                 coalesce(sum(duration_ms) FILTER (WHERE category = 'UNPLANNED'), 0) AS updt,
                 coalesce(sum(duration_ms) FILTER (WHERE category = 'SMALL_STOP'), 0) AS ms
            FROM seed_stops GROUP BY 1, 2) s
      ON s.business_date = r.business_date AND s.shift = r.shift
   WHERE r.work_unit_id = wu
     AND (r.schedule_loss_time <> s.pdt
       OR r.availability_loss_time <> s.updt
       OR r.ms_loss_time <> s.ms);
  IF bad > 0 THEN RAISE EXCEPTION '% shift report(s) disagree with their own stops', bad; END IF;

  -- The hourly chart's runtime against the report's.
  SELECT count(*) INTO bad
    FROM oee.work_unit_shift_reports r
    JOIN (SELECT business_date, shift, sum(runtime) AS runtime
            FROM oee.product_perf_wu_hour
           WHERE work_unit_id = wu AND business_date BETWEEN d0 AND d1
           GROUP BY 1, 2) h
      ON h.business_date = r.business_date AND h.shift = r.shift
   WHERE r.work_unit_id = wu AND r.runtime <> h.runtime;
  IF bad > 0 THEN RAISE EXCEPTION '% shift(s) where the hourly rows do not sum to runtime', bad; END IF;

  -- SKU View against the Summary tiles.
  SELECT count(*) INTO bad
    FROM oee.work_unit_shift_reports r
    JOIN (SELECT shift_date, shift, sum(total_out) AS total_out, sum(good_out) AS good_out
            FROM oee.product_count_wu_shift
           WHERE work_unit_id = wu AND shift_date BETWEEN d0 AND d1
           GROUP BY 1, 2) p
      ON p.shift_date = r.business_date AND p.shift = r.shift
   WHERE r.work_unit_id = wu AND (r.total_out <> p.total_out OR r.good_out <> p.good_out);
  IF bad > 0 THEN RAISE EXCEPTION '% shift(s) where SKU View disagrees with the report', bad; END IF;

  -- Day equals the sum of its shifts, and month equals the sum of its days —
  -- the invariant gold-write-contract.md §15.6 asks the pipeline to assert.
  SELECT count(*) INTO bad
    FROM oee.work_unit_day_reports dd
    JOIN (SELECT business_date, sum(runtime) AS runtime, sum(availability_time) AS at
            FROM oee.work_unit_shift_reports
           WHERE work_unit_id = wu AND business_date BETWEEN d0 AND d1
           GROUP BY 1) ss USING (business_date)
   WHERE dd.work_unit_id = wu
     AND (dd.runtime <> ss.runtime OR dd.availability_time <> ss.at);
  IF bad > 0 THEN RAISE EXCEPTION '% day(s) disagree with the sum of their shifts', bad; END IF;

  SELECT count(*) INTO bad
    FROM oee.work_unit_month_reports mm
    JOIN (SELECT sum(runtime) AS runtime, sum(availability_time) AS at
            FROM oee.work_unit_day_reports
           WHERE work_unit_id = wu AND business_date BETWEEN d0 AND d1) dsum ON true
   WHERE mm.work_unit_id = wu
     AND mm.business_date = date_trunc('month', d0)::date
     AND (mm.runtime <> dsum.runtime OR mm.availability_time <> dsum.at);
  IF bad > 0 THEN RAISE EXCEPTION 'the month report disagrees with the sum of its days'; END IF;

  RAISE NOTICE 'All reconciliations hold.';
END
$$;

-- ---------------------------------------------------------------------------
-- What landed
-- ---------------------------------------------------------------------------

SELECT 'downtime_reports'        AS table_name, count(*) FROM oee.downtime_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params)
                         AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'downtime_log_events', count(*) FROM oee.downtime_log_events
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'product_perf_wu_hour', count(*) FROM oee.product_perf_wu_hour
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'product_count_wu_shift', count(*) FROM oee.product_count_wu_shift
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'product_count_wu_day', count(*) FROM oee.product_count_wu_day
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'reject_count_wu_shift', count(*) FROM oee.reject_count_wu_shift
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND shift_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'work_unit_shift_reports', count(*) FROM oee.work_unit_shift_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'work_unit_day_reports', count(*) FROM oee.work_unit_day_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date BETWEEN (SELECT from_date FROM seed_params) AND (SELECT to_date FROM seed_params)
UNION ALL SELECT 'work_unit_month_reports', count(*) FROM oee.work_unit_month_reports
 WHERE work_unit_id = (SELECT work_unit_id FROM seed_params)
   AND business_date = date_trunc('month', (SELECT from_date FROM seed_params))::date
UNION ALL SELECT 'downtime_report_history', count(*) FROM oee.downtime_report_history h
 WHERE EXISTS (SELECT 1 FROM oee.downtime_reports d
                WHERE d.source_event_id = h.source_event_id
                  AND d.work_unit_id = (SELECT work_unit_id FROM seed_params))
ORDER BY 1;
