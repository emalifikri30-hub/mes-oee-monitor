-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE. `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more: psql reports the error and carries
-- straight on to the next statement, so the refusal prints and the seed runs
-- anyway. 0014's header records that happening for real.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration — see 0029's header.
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0030_masako_downtime_dev.sql
--
-- RUN AFTER 0029. It reads that seed's report rows and cannot run without them.
--
-- ---------------------------------------------------------------------------
-- WHAT IT IS, AND THE ONE PROPERTY THAT MATTERS
-- ---------------------------------------------------------------------------
--
-- The stops behind MASAKO's Paretos, for the window 0029 wrote:
--
--   oee.downtime_reports      the editable stops — Downtime Details, the
--                             timeline strip, the Availability / Schedule Loss /
--                             Actions Paretos
--   oee.downtime_log_events   the immutable log behind the Others tab
--
-- **EVERY PARETO'S BARS MUST SUM TO THE REPORT'S OWN LOSS COLUMN.** That is the
-- property, and it is the only reason this file is harder than a random insert:
--
--   sum(duration) WHERE category='UNPLANNED'   ==  availability_loss_time
--   sum(duration) WHERE category='PLANNED'     ==  schedule_loss_time
--   sum(duration) WHERE category='SMALL_STOP'  ==  ms_loss_time
--
-- per (work_unit_id, business_date, shift). A supervisor reading the Losses page
-- sees a Pareto whose bars add to the figure in the card above it. If they do
-- not, the screen is quietly lying and no test would catch it — the chart draws
-- perfectly either way.
--
-- **SO THIS FILE RUNS THE DERIVATION BACKWARDS FROM 0014's.** That seed generates
-- stops first and derives the report measures from them. The reports already
-- exist here, so the stops are SPLIT OUT OF the loss columns instead — each
-- bucket divided among a few reasons by weight, with the LAST stop taking the
-- remainder so integer division cannot drift. Same invariant, opposite direction.
--
-- `reduce_speed_time` gets NO stops, deliberately. Nothing in Gold records WHY a
-- machine ran slow — 0014 makes the same point, and performance-loss-tab.tsx
-- explains that state on screen. `performance_loss_time` is `ms + rs`, so only
-- its `ms` half is covered by stop records and the Pareto says so.
--
-- ---------------------------------------------------------------------------
-- THE SUM HOLDS AT MACHINE SCOPE AND MUST NOT AT LINE OR AREA SCOPE
-- ---------------------------------------------------------------------------
--
-- This is the first thing a reviewer will read as a bug, so it is stated here
-- rather than discovered on a screen. On this data:
--
--   machine Losses page   Pareto 341.1 h?  no — each machine's own, and EXACT
--   line Losses page      Pareto 341.1 h   vs  the card's 156.1 h
--   area Losses page      the same gap again
--
-- **BOTH NUMBERS ARE RIGHT AND THEY ARE NOT THE SAME QUANTITY.** A stop is an
-- EVENT IN TIME and a stop on a machine genuinely IS a stop on the line, which is
-- why downtime is scoped by query param at any level (root AGENTS.md, and the
-- passage contrasting it with rejects). So a line-scoped Pareto legitimately
-- shows all three machines' stops and adds to 341 h. The line REPORT's
-- `availability_loss_time` is the LINE's own wall clock — 0029 takes the worst
-- machine per bucket over one clock — so it reads 156 h. Three machines down for
-- an hour each at different times costs the line up to three hours; down
-- simultaneously it costs one. The two figures diverge by exactly the overlap,
-- and nothing can make them agree without asserting that a line's losses are the
-- SUM of its machines' — which is the "machine-milliseconds" reading `0014`
-- explicitly retracts.
--
-- The invariant this file DOES guarantee, and asserts on all 954 rows, is the
-- machine one: per (work_unit_id, business_date, shift) the stops sum to that
-- report's loss columns to the millisecond. That is the grain `0014`'s seed makes
-- the same promise at, and the grain where a mismatch would be a real defect.
--
-- ---------------------------------------------------------------------------
-- THE REASON NAMES ARE NOT IN THE CATALOGUE, AND THAT IS A DECIDED TRADE
-- ---------------------------------------------------------------------------
--
-- `ms_downtime` scopes exactly TWO reasons to work center 14 — one PLANNED
-- (`MSK-REST01` ISTIRAHAT) and one UNPLANNED (`MSK-UPDT01` EXAMPLE 1). A Pareto
-- ranks reasons and draws a cumulative SHARE line; with one reason per category
-- it renders a single bar at 100% and demonstrates nothing.
--
-- So the stops carry richer names that exist ONLY in Gold. **That is what
-- production already looks like** — the browser's own rule is that "a chip whose
-- name is not in the catalogue still renders", because almost every stop on
-- screen was labelled by the pipeline and dropping it would rewrite an operator's
-- record. What is stored is the NAME, not an id (both columns are jsonb string
-- arrays the pipeline writes into), so there is no dangling reference here.
--
-- THE COST, STATED SO IT IS NOT REDISCOVERED AS A BUG: the edit dialog's Reason
-- picker is scoped by work center and will offer only the two real reasons. An
-- operator can SEE 'Belt Jam' on a stop and cannot re-pick it after removing the
-- chip. The fix is master data, not this file — `ms_downtime` is owned by the
-- mes-master-data repo and deployment, and this seed writes nothing outside the
-- `oee` schema. The two real names ARE in the lists below so at least one bar per
-- category round-trips through the dialog.
--
-- ACTIONS ARE THE REAL CATALOGUE, unscoped. `ms_downtime.downtime_actions` has no
-- junction table at all (TODOS §44), so every line is offered all six — which is
-- why the Actions Pareto can use real names where the reasons cannot. They are
-- placeholder-looking ("Test Action 1") because that is genuinely what the
-- catalogue holds.
--
-- ---------------------------------------------------------------------------
-- THREE MORE THINGS THE GENERATOR GETS RIGHT ON PURPOSE
-- ---------------------------------------------------------------------------
--
-- 1. NO STOP CROSSES A SHIFT BOUNDARY. Flink forces a stop's end_at to the shift
--    boundary, so no downtime crosses a shift or a day (root AGENTS.md, TODOS
--    §73) — the straddle handling in `clipToWindow` is a BACKSTOP, not the normal
--    case. Every stop here is laid inside its own shift window and step 5 asserts
--    it, so this data does not teach the exception as the rule.
--
-- 2. `source_event_id` IS SET ON EVERY ROW, and it is what makes a stop EDITABLE.
--    A stop without one cannot be edited at all (TODOS §19), which is every stop
--    the pipeline has loaded so far — so a seed that omitted it would ship a
--    screen whose edit button is uniformly dead.
--
-- 3. ~15% OF STOPS CARRY NO `product_id`, DELIBERATELY. `0020`: NULL means "not
--    attributed", never "no product", so a per-SKU read filtering `product_id = X`
--    silently excludes them and the residual is invisible. Every per-SKU downtime
--    read therefore ships an `unattributed` count beside it — and that count is
--    only exercised if some rows actually are unattributed. Seeding 100%
--    attribution would leave the one number those payloads exist to carry at zero
--    on every screen.
--
-- RE-RUNNABLE: deletes this area's stops first, scoped to work units 9/10/11.
-- ---------------------------------------------------------------------------

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
-- Step 0 — refuse unless 0029 has run
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM oee.work_unit_shift_reports WHERE work_unit_id IN (9,10,11);
  IF n = 0 THEN
    RAISE EXCEPTION
      'No MASAKO machine shift reports. Run 0029_masako_reports_dev.sql first — this file SPLITS that seed''s loss columns and has nothing to split without them.';
  END IF;
  RAISE NOTICE 'seed 0030: splitting the loss columns of % machine shift reports.', n;
END
$$;

DELETE FROM oee.downtime_reports    WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.downtime_log_events WHERE work_unit_id IN (9,10,11);

-- ---------------------------------------------------------------------------
-- Step 1 — the reason lists, with the WEIGHTS that give each Pareto its shape
-- ---------------------------------------------------------------------------
--
-- The weight is a reason's share of its bucket when it is picked. Deliberately
-- uneven: a Pareto whose bars are all the same height has no head and no tail,
-- so the "Other" fold, the cumulative line and the server-side ranking are all
-- untested by it.
--
-- `ord` is the rotation key. Each shift picks a CONTIGUOUS WINDOW of this list
-- starting at `v % count`, so a reason's FREQUENCY varies across the window as
-- well as its duration — which is what makes the Pareto's measure toggle
-- (duration vs frequency) re-rank rather than redraw the same chart.
DROP TABLE IF EXISTS msk_reasons;
CREATE TEMP TABLE msk_reasons AS
SELECT * FROM (VALUES
  -- UNPLANNED — the Availability Pareto
  ('UNPLANNED'::text, 0, 'Film Splice'::text,          30::numeric),
  ('UNPLANNED',       1, 'Belt Jam',                   22),
  ('UNPLANNED',       2, 'Sealing Jaw Fault',          18),
  ('UNPLANNED',       3, 'Product Feed Empty',         14),
  ('UNPLANNED',       4, 'Coder Fault',                 9),
  -- The one name that IS in ms_downtime for this line, so at least one bar
  -- round-trips through the edit dialog.
  ('UNPLANNED',       5, 'EXAMPLE 1',                   7),
  -- PLANNED — the Schedule Loss Pareto
  ('PLANNED',         0, 'ISTIRAHAT',                  40),   -- the real catalogue one
  ('PLANNED',         1, 'Changeover',                 28),
  ('PLANNED',         2, 'Preventive Maintenance',     18),
  ('PLANNED',         3, 'Sanitation',                 14),
  -- SMALL_STOP — the Others tab and the ms half of performance loss
  ('SMALL_STOP',      0, 'Micro Stop',                 45),
  ('SMALL_STOP',      1, 'Photo Eye Blocked',          30),
  ('SMALL_STOP',      2, 'Carton Magazine Low',        25)
) AS r(category, ord, reason, weight);

DROP TABLE IF EXISTS msk_actions;
CREATE TEMP TABLE msk_actions AS
SELECT * FROM (VALUES
  (0, 'Test Action 1'::text), (1, 'Test Action 2'), (2, 'Test Action 3'),
  (3, 'Test Action 4'),       (4, 'Test Create 1'), (5, 'Test Create 2')
) AS a(ord, name);

-- ---------------------------------------------------------------------------
-- Step 2 — one row per (machine, day, shift, category), carrying its bucket
-- ---------------------------------------------------------------------------
--
-- `reduce_speed_time` is absent by design — see the header.
DROP TABLE IF EXISTS msk_buckets;
CREATE TEMP TABLE msk_buckets AS
SELECT b.*,
       -- How many reasons this bucket is split across. Varies per shift so the
       -- frequency ranking is not a constant multiple of the duration ranking.
       CASE b.category
         WHEN 'UNPLANNED'  THEN 2 + (b.v % 3)   -- 2..4
         WHEN 'PLANNED'    THEN 1 + (b.v % 2)   -- 1..2
         ELSE                   2 + (b.v % 2)   -- 2..3
       END AS k
FROM (
  SELECT r.work_unit_id, r.work_unit_name, r.work_unit_code,
         r.work_center_id, r.work_center_name, r.work_center_code,
         r.area_id, r.area_name, r.site_id, r.site_name,
         r.enterprise_id, r.enterprise_name,
         r.business_date, r.shift, r.date AS shift_start, r.time_zone,
         (extract(doy from r.business_date)::int * 7 + r.shift * 13 + r.work_unit_id * 31) AS v,
         c.category, c.bucket_ms
    FROM oee.work_unit_shift_reports r
    CROSS JOIN LATERAL (VALUES
      ('UNPLANNED'::text,  r.availability_loss_time),
      ('PLANNED',          r.schedule_loss_time),
      ('SMALL_STOP',       r.ms_loss_time)
    ) AS c(category, bucket_ms)
   WHERE r.work_unit_id IN (9,10,11)
     AND c.bucket_ms > 0
) b;

-- ---------------------------------------------------------------------------
-- Step 3 — split each bucket, EXACTLY
-- ---------------------------------------------------------------------------
--
-- THE LAST STOP TAKES THE REMAINDER. `floor(bucket * weight / sum_weight)` loses
-- up to k-1 milliseconds to integer division, and those milliseconds are exactly
-- the difference between a Pareto that adds up and one that is short by an amount
-- too small to notice and too real to explain. Giving the final row
-- `bucket - (everything already allocated)` closes it by construction rather than
-- by rounding luck.
DROP TABLE IF EXISTS msk_split;
CREATE TEMP TABLE msk_split AS
WITH picked AS (
  SELECT b.*,
         c.reason, c.weight,
         row_number() OVER (PARTITION BY b.work_unit_id, b.business_date, b.shift, b.category
                            ORDER BY c.rot)                                   AS i,
         count(*)    OVER (PARTITION BY b.work_unit_id, b.business_date, b.shift, b.category) AS n,
         sum(c.weight) OVER (PARTITION BY b.work_unit_id, b.business_date, b.shift, b.category) AS sum_w
    FROM msk_buckets b
    CROSS JOIN LATERAL (
      SELECT rr.reason, rr.weight,
             ((rr.ord + b.v) % (SELECT count(*) FROM msk_reasons z WHERE z.category = b.category)) AS rot
        FROM msk_reasons rr
       WHERE rr.category = b.category
       ORDER BY rot
       LIMIT b.k
    ) c
),
raw AS (
  SELECT p.*, floor(p.bucket_ms * p.weight / p.sum_w)::bigint AS raw_ms
    FROM picked p
)
SELECT r.*,
       coalesce(sum(r.raw_ms) OVER (PARTITION BY r.work_unit_id, r.business_date, r.shift, r.category
                                    ORDER BY r.i
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS allocated_before,
       CASE WHEN r.i = r.n
            THEN r.bucket_ms - coalesce(sum(r.raw_ms) OVER (PARTITION BY r.work_unit_id, r.business_date, r.shift, r.category
                                                            ORDER BY r.i
                                                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
            ELSE r.raw_ms
       END AS duration_ms
  FROM raw r;

DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM msk_split WHERE duration_ms <= 0;
  IF bad > 0 THEN
    RAISE EXCEPTION '% stop(s) came out non-positive — a bucket was split across more reasons than it has milliseconds for.', bad;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 4 — lay the stops out inside their shift, without overlapping
-- ---------------------------------------------------------------------------
--
-- The gap between stops is whatever is left of the 8-hour window after the stops
-- themselves, divided evenly. That guarantees two things at once: the last stop
-- ENDS before the shift does (no straddle — see the header), and the timeline
-- strip shows RUN_TIME between stops rather than one solid block.
DROP TABLE IF EXISTS msk_stops;
CREATE TEMP TABLE msk_stops AS
WITH ordered AS (
  SELECT s.*,
         row_number() OVER (PARTITION BY s.work_unit_id, s.business_date, s.shift
                            ORDER BY s.category, s.i)                             AS seq,
         count(*)     OVER (PARTITION BY s.work_unit_id, s.business_date, s.shift) AS n_shift,
         sum(s.duration_ms) OVER (PARTITION BY s.work_unit_id, s.business_date, s.shift) AS stop_ms_shift,
         coalesce(sum(s.duration_ms) OVER (PARTITION BY s.work_unit_id, s.business_date, s.shift
                                           ORDER BY s.category, s.i
                                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_ms
    FROM msk_split s
)
SELECT o.*,
       ((28800000 - o.stop_ms_shift) / (o.n_shift + 1))::bigint AS gap_ms,
       o.shift_start
         + ((o.before_ms + ((28800000 - o.stop_ms_shift) / (o.n_shift + 1)) * o.seq)
            * interval '1 millisecond')                         AS start_at,
       o.shift_start
         + ((o.before_ms + ((28800000 - o.stop_ms_shift) / (o.n_shift + 1)) * o.seq + o.duration_ms)
            * interval '1 millisecond')                         AS end_at,
       -- Unique per stop, and the thing that makes it editable (TODOS §19).
       'msk-' || o.work_unit_id || '-' || to_char(o.business_date, 'YYYYMMDD')
              || '-' || o.shift || '-' || o.seq                 AS source_event_id,
       -- SKU attribution. ~15% left NULL on purpose — see the header.
       CASE WHEN (o.v + o.seq) % 7 = 0 THEN NULL
            WHEN (o.v + o.seq) % 5 < 3 THEN 3 ELSE 4 END        AS product_id,
       CASE WHEN (o.v + o.seq) % 7 = 0 THEN NULL
            WHEN (o.v + o.seq) % 5 < 3 THEN 'SKU A' ELSE 'SKU B' END AS product_name
  FROM ordered o;

-- ---------------------------------------------------------------------------
-- Step 5 — the stops themselves
-- ---------------------------------------------------------------------------
--
-- `reason` and `actions` are jsonb ARRAYS of names (never ids) — `0011`'s
-- `ck_downtime_reports_reason` rejects a blank or non-string element, which is a
-- failed statement rather than a mis-grouped Pareto bar (§14).
--
-- The Availability Pareto groups on `reason[0]` — `primaryReason` — and the
-- Actions Pareto on `actions[0]`, because crediting each of several the stop's
-- whole duration would make the bars sum to MORE than the window's downtime and a
-- cumulative share line stops meaning anything past 100%. So the FIRST element of
-- each array is the one that ranks, and both are single-element here except where
-- a second action is added to exercise the "a second action contributes nothing"
-- footnote the card carries.
INSERT INTO oee.downtime_reports (
  reason, category, work_unit_id, shift, actions, start_at, end_at, duration,
  work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
  source_event_id, area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  business_date, time_zone, product_id, product_name, detail_reason, input_by
)
SELECT
  jsonb_build_array(s.reason),
  s.category::oee.operation_type,
  s.work_unit_id, s.shift,
  CASE WHEN s.seq % 4 = 0
       THEN jsonb_build_array(a1.name, a2.name)   -- two actions; only the first ranks
       ELSE jsonb_build_array(a1.name)
  END,
  s.start_at, s.end_at, s.duration_ms,
  s.work_unit_name, s.work_unit_code,
  s.work_center_id, s.work_center_name, s.work_center_code,
  s.source_event_id, s.area_id, s.area_name, s.site_id, s.site_name,
  s.enterprise_id, s.enterprise_name,
  s.business_date, s.time_zone, s.product_id, s.product_name,
  -- A note on roughly one stop in six, so the Downtime Details drawer has
  -- something to show and the 2000-char cap has a non-null case to hold.
  CASE WHEN s.seq % 6 = 0
       THEN s.reason || ' on ' || to_char(s.business_date, 'DD Mon') || ', shift ' || s.shift || '.'
       ELSE NULL
  END,
  'seed'
FROM msk_stops s
JOIN msk_actions a1 ON a1.ord = (s.v + s.seq) % 6
JOIN msk_actions a2 ON a2.ord = (s.v + s.seq + 3) % 6;

-- The immutable log behind the Others tab. Same events from the same source, so
-- the two tabs COUNT THE SAME STOPS FROM TWO TABLES — which is by design (one is
-- immutable, the other operator-editable) and whose divergence is unmeasured in
-- production (contract, Open risks). Seeding them identically is the honest
-- starting point: any later divergence on this data is an operator edit.
--
-- `reasons` here is a text[], not jsonb — the older shape (§22.4), kept rather
-- than renamed.
INSERT INTO oee.downtime_log_events (
  event_id, work_unit_id, shift_date, shift, reasons, category,
  work_unit_name, work_unit_code, work_center_id, work_center_name,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  time_zone, product_id, product_name
)
SELECT
  s.source_event_id, s.work_unit_id, s.business_date, s.shift,
  ARRAY[s.reason], s.category::oee.operation_type,
  s.work_unit_name, s.work_unit_code, s.work_center_id, s.work_center_name,
  s.area_id, s.area_name, s.site_id, s.site_name, s.enterprise_id, s.enterprise_name,
  s.time_zone, s.product_id, s.product_name
FROM msk_stops s;

-- ---------------------------------------------------------------------------
-- Step 6 — the assertions, and the first one IS the feature
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad int; n_stops int; n_events int; straddle int; unattributed int;
BEGIN
  -- THE PARETOS ADD UP. Every category's stops must sum to the matching loss
  -- column on the report, per machine-shift. This is the whole point of the file
  -- and the one thing no screen would reveal if it were wrong.
  SELECT count(*) INTO bad
    FROM (
      SELECT r.work_unit_id, r.business_date, r.shift,
             r.availability_loss_time, r.schedule_loss_time, r.ms_loss_time,
             coalesce(sum(d.duration) FILTER (WHERE d.category = 'UNPLANNED'), 0)  AS updt,
             coalesce(sum(d.duration) FILTER (WHERE d.category = 'PLANNED'), 0)    AS pdt,
             coalesce(sum(d.duration) FILTER (WHERE d.category = 'SMALL_STOP'), 0) AS ms
        FROM oee.work_unit_shift_reports r
        LEFT JOIN oee.downtime_reports d
               ON d.work_unit_id = r.work_unit_id
              AND d.business_date = r.business_date
              AND d.shift = r.shift
       WHERE r.work_unit_id IN (9,10,11)
       GROUP BY r.work_unit_id, r.business_date, r.shift,
                r.availability_loss_time, r.schedule_loss_time, r.ms_loss_time
    ) x
   WHERE x.updt <> x.availability_loss_time
      OR x.pdt  <> x.schedule_loss_time
      OR x.ms   <> x.ms_loss_time;

  IF bad > 0 THEN
    RAISE EXCEPTION
      '% machine-shift(s) have stops that do NOT sum to the report''s loss columns — every Pareto on those screens would disagree with the card above it.', bad;
  END IF;

  -- NO STOP CROSSES ITS SHIFT. The pipeline guarantees this and the straddle
  -- handling is a backstop (TODOS §73); seeded data must not teach the exception.
  SELECT count(*) INTO straddle
    FROM oee.downtime_reports d
    JOIN oee.work_unit_shift_reports r
      ON r.work_unit_id = d.work_unit_id AND r.business_date = d.business_date AND r.shift = d.shift
   WHERE d.work_unit_id IN (9,10,11)
     AND (d.start_at < r.date OR d.end_at > r.date + interval '8 hours');
  IF straddle > 0 THEN
    RAISE EXCEPTION '% stop(s) fall outside their own shift window.', straddle;
  END IF;

  -- Every stop editable, and the two tables in step.
  SELECT count(*) INTO bad FROM oee.downtime_reports
   WHERE work_unit_id IN (9,10,11) AND (source_event_id IS NULL OR area_id IS NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION '% stop(s) have no source_event_id or no area — uneditable, or invisible to the area lists.', bad;
  END IF;

  SELECT count(*) INTO n_stops  FROM oee.downtime_reports    WHERE work_unit_id IN (9,10,11);
  SELECT count(*) INTO n_events FROM oee.downtime_log_events WHERE work_unit_id IN (9,10,11);
  IF n_stops <> n_events THEN
    RAISE EXCEPTION 'downtime_reports has % rows and downtime_log_events has % — the Others tab would disagree with Downtime Details.', n_stops, n_events;
  END IF;

  SELECT count(*) INTO unattributed FROM oee.downtime_reports
   WHERE work_unit_id IN (9,10,11) AND product_id IS NULL;
  IF unattributed = 0 THEN
    RAISE EXCEPTION
      'Every stop is attributed to a SKU, so the `unattributed` count every per-SKU downtime read ships would be 0 on every screen and the code path is untested.';
  END IF;

  RAISE NOTICE 'seed 0030: % stops, % log events, % unattributed (% percent). Every Pareto sums to its report.',
    n_stops, n_events, unattributed, round(unattributed * 100.0 / n_stops, 1);
END
$$;

-- What the Availability Pareto will draw for the whole window, top first.
SELECT reason -> 0 ->> 0 AS reason,
       count(*)                                   AS stops,
       round(sum(duration) / 3600000.0, 1)        AS hours,
       round(100.0 * sum(duration) / sum(sum(duration)) OVER (), 1) AS pct
  FROM oee.downtime_reports
 WHERE work_unit_id IN (9,10,11) AND category = 'UNPLANNED'
 GROUP BY 1 ORDER BY sum(duration) DESC;

-- And the Schedule Loss one.
SELECT reason -> 0 ->> 0 AS reason,
       count(*)                            AS stops,
       round(sum(duration) / 3600000.0, 1) AS hours
  FROM oee.downtime_reports
 WHERE work_unit_id IN (9,10,11) AND category = 'PLANNED'
 GROUP BY 1 ORDER BY sum(duration) DESC;

DROP TABLE IF EXISTS msk_stops;
DROP TABLE IF EXISTS msk_split;
DROP TABLE IF EXISTS msk_buckets;
DROP TABLE IF EXISTS msk_actions;
DROP TABLE IF EXISTS msk_reasons;
