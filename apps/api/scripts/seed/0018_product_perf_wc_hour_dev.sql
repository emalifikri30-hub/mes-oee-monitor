-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See 0015's
-- header: without it, `RAISE EXCEPTION` inside a DO block prints and psql carries
-- straight on to the INSERT.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0018_product_perf_wc_hour_dev.sql
--
-- CHECK `\conninfo` FIRST — apps/api/.env points GOLD_DATABASE_URL at a SHARED
-- REMOTE database, and the guard below refuses only one of them by name.
--
-- ---------------------------------------------------------------------------
-- WHY IT EXISTS
-- ---------------------------------------------------------------------------
--
-- `oee.product_perf_wc_hour` (migration 0018) ships EMPTY, so the Hourly
-- Production dialog behind the Line Losses card's View button has only one state
-- anyone can see. This fills it so the chart, its axes and its tooltip can be
-- looked at.
--
-- IT IS A STAND-IN. IT IS *NOT* THE SPECIFICATION — 0015's terms, unchanged, and
-- for a reason that is sharper here than anywhere else:
--
--   THE FIGURES ARE SYNTHESISED, NOT DERIVED. There is nothing to derive them
--   from. An hourly LINE curve cannot be built out of the machine tables, because
--   a line is MEASURED, not summed (contract §19.1 asks the pipeline owner in
--   capitals not to build one that way) — and 0018 exists precisely because a
--   machine-summed curve would not integrate to the line's own shift totals.
--
-- So this does not even pretend to reconcile. It shapes a plausible eight-hour
-- curve around each line-shift's own reported output, which is enough to render
-- and nothing more. Do not compare it to anything.
--
-- ---------------------------------------------------------------------------
-- THE ONE THING IT GETS RIGHT ON PURPOSE: THE TWO UNITS
-- ---------------------------------------------------------------------------
--
-- infeed and output are DIFFERENT (0014, §16.4a), and the seed keeps them
-- different — it takes both triples straight off the line's own shift report. If
-- they were the same, the chart's whole reason for plotting the OUTPUT side only
-- would be invisible in dev and the first person to see it would be a user.
--
-- `ideal_rate_per_hour` is OUTPUT-side per §19.2, which is the assumption the
-- CHECK encodes and the pipeline owner has been asked to confirm.

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

BEGIN;

DELETE FROM oee.product_perf_wc_hour h
 WHERE EXISTS (
   SELECT 1 FROM oee.work_center_shift_reports r
    WHERE r.work_center_id = h.work_center_id
      AND r.business_date  = h.business_date
 );

-- EIGHT BUCKETS PER LINE-SHIFT, one row per SKU the line ran that day.
--
-- The SKU list comes from oee.product_count_wc_shift — this seed's sibling, 0016
-- — so the two dev screens agree about which products exist even though neither
-- figure means anything.
--
-- THE SHAPE, and it is deliberately not flat: a flat line proves nothing about a
-- chart. Output rises through the first half of the shift and dips in hour 5,
-- which is enough to see the axis, the gap behaviour and the standard line doing
-- something. `h` is the 0-based hour within the shift.
INSERT INTO oee.product_perf_wc_hour (
  bucket_start, bucket_end, work_center_id, product_id,
  business_date, shift, hour_of_day, shift_hour_seq, time_zone,
  work_center_name, work_center_code, product_name, product_code,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  infeed_base_uom_id, infeed_base_uom_code, infeed_factor_to_base,
  output_uom_id, output_uom_name, output_uom_code,
  output_base_uom_id, output_base_uom_code, output_factor_to_base,
  total_out, reject, rework, good_out, effective_out,
  runtime, ideal_rate_per_hour, ideal_rate_source
)
SELECT
  -- The shift's start instant plus h hours. Shift 1 starts 07:00 local, 2 at
  -- 15:00, 3 at 23:00 — SHIFT_WINDOWS' boundaries, and the only place this seed
  -- copies them. AT TIME ZONE turns the local wall clock into the instant the
  -- column stores.
  ((r.business_date + make_interval(hours => 7 + (r.shift - 1) * 8 + g.h)) AT TIME ZONE r.time_zone),
  ((r.business_date + make_interval(hours => 8 + (r.shift - 1) * 8 + g.h)) AT TIME ZONE r.time_zone),
  r.work_center_id,
  p.product_id,
  r.business_date,
  r.shift,
  (7 + (r.shift - 1) * 8 + g.h) % 24                       AS hour_of_day,
  g.h                                                       AS shift_hour_seq,
  r.time_zone,
  r.work_center_name,
  coalesce(r.work_center_code, 'L' || r.work_center_id),
  p.product_name,
  p.product_code,
  r.infeed_uom_id, r.infeed_uom_name, r.infeed_uom_code,
  r.infeed_uom_id, r.infeed_uom_code, 1,
  r.output_uom_id, r.output_uom_name, r.output_uom_code,
  r.output_uom_id, r.output_uom_code, 1,
  -- The curve. Each hour gets a share of the SKU's shift figure, tilted by the
  -- factor below so the line is not flat, then rounded.
  round(p.total_out / 8.0 * g.factor, 3),
  round(coalesce(p.reject, 0) / 8.0 * g.factor, 3),
  round(coalesce(p.rework, 0) / 8.0 * g.factor, 3),
  round(p.good_out / 8.0 * g.factor, 3),
  -- effective_out sits a little under good_out, which is what makes the two
  -- series distinguishable on the chart rather than one hiding the other.
  round(p.good_out / 8.0 * g.factor * 0.94, 3),
  3600000,
  -- OUTPUT-side, per §19.2. Set a touch above the hour's actual output so the
  -- standard line sits above the actual one and the gap IS the performance loss —
  -- which is the whole point of drawing them together.
  round(p.good_out / 8.0 * 1.15, 6),
  'seed-0018-dev'
  FROM oee.work_center_shift_reports r
  JOIN oee.product_count_wc_shift p
    ON p.work_center_id = r.work_center_id
   AND p.business_date  = r.business_date
   AND p.shift          = r.shift
  -- Eight hours, with a dip at hour 5 so the curve has a shape worth looking at.
  CROSS JOIN (
    VALUES (0, 0.7), (1, 0.95), (2, 1.1), (3, 1.2), (4, 1.15), (5, 0.6), (6, 1.15), (7, 1.15)
  ) AS g(h, factor)
 -- BOTH UNITS MUST BE KNOWN. ck_ppwch_infeed_units and ck_ppwch_output_units
 -- would refuse a row carrying counts with no unit, and a line report that
 -- abstained (0014: NULL means "the members disagreed") has nothing to denominate
 -- these figures in. Skipped rather than guessed.
 WHERE r.infeed_uom_id IS NOT NULL
   AND r.output_uom_id IS NOT NULL
   AND p.good_out IS NOT NULL;

-- The watermark, without which every populated chart would ALSO claim to be
-- stale — §14's ladder failing in the opposite direction.
INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
SELECT 'product_perf_wc_hour', now(), max(business_date), count(*), 'seed-0018-dev'
  FROM oee.product_perf_wc_hour
HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE
   SET last_run_at = excluded.last_run_at,
       last_business_date = excluded.last_business_date,
       rows_total = excluded.rows_total,
       writer = excluded.writer;

DO $$
DECLARE
  rows_made bigint;
  lines_made bigint;
BEGIN
  SELECT count(*), count(DISTINCT work_center_id) INTO rows_made, lines_made
    FROM oee.product_perf_wc_hour;

  IF rows_made = 0 THEN
    RAISE EXCEPTION
      'Seed produced no rows. It needs oee.work_center_shift_reports (seed 0015) AND oee.product_count_wc_shift (seed 0016) — run those first.';
  END IF;

  RAISE NOTICE 'seed 0018: % hourly rows across % lines', rows_made, lines_made;
END
$$;

COMMIT;
