-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See 0015.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds there, so a seed placed in that directory would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0021_product_report_wc_day_dev.sql
--
-- CHECK `\conninfo` FIRST. apps/api/.env points GOLD_DATABASE_URL at a SHARED
-- REMOTE database. The guard below refuses one database by name; it cannot know
-- about yours.
--
-- RUN AFTER: 0013, 0014, 0015, 0017, 0016. This reads work_center_day_reports
-- (0015+0017) and product_count_wc_day (0016) and hard-fails if either is empty.
--
-- ---------------------------------------------------------------------------
-- IT IS A STAND-IN. IT IS *NOT* THE SPECIFICATION. READ THIS BEFORE COPYING IT.
-- ---------------------------------------------------------------------------
--
-- `oee.product_report_wc_day` (migration 0023) ships EMPTY. Airflow fills it;
-- contract §24 is the ask. So the SKU daily report has exactly one state anyone
-- can see — its empty one — until this file runs.
--
-- AND WHAT THIS FILE DOES IS THE ONE THING §24.1 ASKS THE PIPELINE OWNER IN
-- CAPITALS NOT TO DO: it APPORTIONS the line's day report between the SKUs that
-- ran on it, weighted by each SKU's share of output. That is a roll-up run
-- backwards, and it is WRONG BY CONSTRUCTION, because a line's availability is
-- its own wall clock and cannot be divided between the products that shared it —
-- a changeover belongs to the changeover, not to 40% of SKU A and 60% of SKU B.
--
-- Do not read it as a reference implementation, do not hand it to the pipeline
-- owner, and DO NOT USE IT TO CHECK THE PIPELINE'S OUTPUT when it arrives. The
-- two SHOULD disagree, and by an unknown amount.
--
-- THE ONE THING IT IS GOOD FOR: making the screen render, so its layout, its
-- loaded/stale ladder, its unattributed-downtime banner and its Losses drill-down
-- can be looked at.
--
-- WHAT IS NEVERTHELESS HONEST HERE, and worth reading as spec:
--
--   * THE INFEED COUNTS ARE REAL PER SKU. total_out / reject / rework / line_out
--     come from oee.product_count_wc_day, which is measured per product. Only the
--     OUTPUT side is apportioned, because that table counts in the INFEED unit
--     (BAG) and the report's output side is denominated in the line's output unit
--     (CARTON) — there is no per-SKU carton count anywhere to read.
--   * QUALITY IS COMPUTED FROM THOSE REAL COUNTS, not apportioned. So it genuinely
--     differs per SKU, which is the one rate on this screen that is not fiction.
--   * THE UNITS ARE THE LINE'S OWN, read off work_center_day_reports rather than
--     invented. Commit c9580a6 is what happens when a seed makes up a uom id: the
--     CODES agreed while the RECORDS did not, and the error message read as
--     nonsense. A label is not a key.
--
-- WHAT IS NOT: every duration, and therefore availability and performance. Those
-- are the line's, split by share and then given a small deterministic per-product
-- skew so the two SKUs do not render identical rates. THE SKEW IS INVENTED. It
-- exists because a screen where every SKU on a line shows the same availability
-- is unreviewable — and, worse, is exactly the tell §24.1 says to look for in a
-- pipeline that apportioned. This file has to look wrong in the way it IS wrong.
--
-- ---------------------------------------------------------------------------
-- The guard. 0015's, verbatim, including the escape hatch.
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

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1 — attribute downtime to a SKU
-- ---------------------------------------------------------------------------
--
-- Migration 0020 added product_id / product_name to oee.downtime_reports and
-- oee.downtime_log_events. Nothing writes them, so every row is NULL — and NULL
-- means NOT ATTRIBUTED, never "no product ran". A SKU-scoped read filtering
-- product_id = X therefore matches nothing, and the screen would render
-- Availability 100% with an empty downtime table: a plausible screen, not an
-- error. That is what this step exists to make visible.
--
-- THE RULE IS CONTRACT §21's: the SKU running when the stop STARTED. In this dev
-- world that is decided by shift, because 0013 and 0014 run SKU A on shifts 1-2
-- and SKU B on shift 3. Real attribution comes from Silver's external product
-- code through ms_core.product_code_alias; there is nothing to join to here.
--
-- ONE STOP PER SHIFT IS DELIBERATELY LEFT NULL, and it is not laziness. The
-- unattributed banner is the only thing standing between an operator and a SKU
-- report that silently omits stops, and an empty-set fixture cannot exercise it.
-- The lowest id in each (line, date, shift) keeps its NULL, mirroring how 0007
-- leaves one stop without a source_event_id so the disabled-Edit state is
-- reachable.
UPDATE oee.downtime_reports d
   SET product_id   = CASE WHEN d.shift = 3 THEN 2 ELSE 1 END,
       product_name = CASE WHEN d.shift = 3 THEN 'SKU B' ELSE 'SKU A' END
 WHERE d.product_id IS NULL
   AND d.id <> (
     SELECT min(x.id) FROM oee.downtime_reports x
      WHERE x.work_center_id = d.work_center_id
        AND x.business_date  = d.business_date
        AND x.shift          = d.shift
   );

-- The Others tab's counts, kept in step with the table above. Contract §21.5:
-- these two are read side by side on one Losses page, so the same real stop
-- attributed to two different SKUs would put the Others tab and the Availability
-- Pareto in visible disagreement on one screen.
UPDATE oee.downtime_log_events e
   SET product_id   = CASE WHEN e.shift = 3 THEN 2 ELSE 1 END,
       product_name = CASE WHEN e.shift = 3 THEN 'SKU B' ELSE 'SKU A' END
 WHERE e.product_id IS NULL;

-- ---------------------------------------------------------------------------
-- STEP 2 — the report rows
-- ---------------------------------------------------------------------------
--
-- DELETE-then-INSERT scoped to the (line, date) pairs this file is about to
-- write, NOT a truncate and NOT an unbounded delete. 0016's deletes are unbounded
-- by date and wipe every date for any line with a machine report; copying that
-- shape here would silently remove pipeline rows outside the seeded range.
DELETE FROM oee.product_report_wc_day p
 WHERE EXISTS (
   SELECT 1 FROM oee.work_center_day_reports r
    WHERE r.work_center_id = p.work_center_id
      AND r.business_date  = p.business_date
 );

INSERT INTO oee.product_report_wc_day (
  work_center_id, business_date, product_id, time_zone,
  work_center_name, work_center_code, area_id, area_name,
  product_name, product_code, month,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  oee, availability, performance, quality,
  total_out, reject, rework, line_out, good_out, effective_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id, r.business_date, c.product_id, r.time_zone,
  r.work_center_name, r.work_center_code, r.area_id, r.area_name,
  c.product_name, c.product_code, to_char(r.business_date, 'YYYY-MM'),
  r.infeed_uom_id, r.infeed_uom_name, r.infeed_uom_code,
  r.output_uom_id, r.output_uom_name, r.output_uom_code,

  -- OEE = A * P * Q, recomputed from the three below rather than apportioned in
  -- its own right. 0015's rule: rates are RECOMPUTED from their components, never
  -- averaged and never scaled — a rate is not additive.
  round(s.avail * s.perf * s.qual / 10000.0, 3),
  round(s.avail, 3),
  round(s.perf, 3),
  round(s.qual, 3),

  -- INFEED, REAL: measured per product by 0016, scaled to base as that table's
  -- own reader does. good_out is deliberately NOT scaled there, which is why it
  -- takes no part in this side.
  round(c.total_out * c.factor_to_base, 3),
  round(c.reject    * c.factor_to_base, 3),
  round(c.rework    * c.factor_to_base, 3),
  round(c.total_out * c.factor_to_base * 0.98, 3),

  -- OUTPUT, APPORTIONED: the line's own carton figures split by this SKU's share
  -- of infeed. There is no per-SKU carton count in Gold to read instead.
  round(r.good_out      * s.share, 3),
  round(r.effective_out * s.share, 3),

  -- Durations: the line's, split by share and skewed. See the header.
  round(r.runtime                * s.skew)::bigint,
  round(r.availability_time      * s.share)::bigint,
  round(r.production_time        * s.share)::bigint,
  round(r.pdt_time               * s.share)::bigint,
  round(r.operating_time         * s.skew)::bigint,
  round(r.updt_time              * s.share)::bigint,
  round(r.net_time               * s.skew)::bigint,
  round(r.reduce_speed_time      * s.share)::bigint,
  round(r.ms_time                * s.share)::bigint,
  round(r.value_added_time       * s.skew)::bigint,
  round(r.rework_time            * s.share)::bigint,
  round(r.reject_time            * s.share)::bigint,
  round(r.anomaly_time           * s.share)::bigint,
  round(r.up_speed_time          * s.share)::bigint,
  round(r.schedule_loss_time     * s.share)::bigint,
  round(r.availability_loss_time * s.share)::bigint,
  round(r.performance_loss_time  * s.share)::bigint,
  round(r.ms_loss_time           * s.share)::bigint,
  round(r.reduce_speed_loss_time * s.share)::bigint,
  round(r.quality_loss_time      * s.share)::bigint,
  r.mttr, r.mtbf
FROM oee.work_center_day_reports r
JOIN oee.product_count_wc_day c
  ON c.work_center_id = r.work_center_id
 AND c.business_date  = r.business_date
CROSS JOIN LATERAL (
  -- This SKU's share of the line's infeed for the day.
  --
  -- A PLAIN AGGREGATE OVER EVERY PRODUCT ON THE LINE-DAY, and the denominator is
  -- the whole point. The first version wrote `sum(...) OVER (PARTITION BY ...)`
  -- inside a subquery that ALSO filtered `c2.product_id = c.product_id` — so the
  -- window saw exactly one row, the sum equalled the numerator, and every share
  -- came out 1.0. The tell was visible in the output and nowhere else: both SKUs
  -- on a line reported the SAME good_out, and each SKU's runtime EXCEEDED the
  -- line's. Neither raised. This is the arithmetic class the integration suite
  -- exists for.
  SELECT c.total_out * c.factor_to_base
           / nullif(sum(c2.total_out * c2.factor_to_base), 0)          AS share_raw,
         -- THE SKEWED SHARE, NORMALISED SO IT STILL SUMS TO 1 ACROSS THE LINE-DAY.
         -- The nudge exists to stop two SKUs rendering identical rates; it must
         -- REDISTRIBUTE time between them, never create it. The first version
         -- multiplied each share by (1 +/- 0.04) without renormalising, so the
         -- SKUs' runtimes summed to MORE than the line's — a line running two
         -- products at once, which is not a thing. Dividing by the skewed total
         -- keeps sum(SKU runtime) = line runtime exactly.
         c.total_out * c.factor_to_base * (1 + CASE WHEN c.product_id % 2 = 1 THEN 0.04 ELSE -0.04 END)
           / nullif(sum(c2.total_out * c2.factor_to_base
                        * (1 + CASE WHEN c2.product_id % 2 = 1 THEN 0.04 ELSE -0.04 END)), 0)
                                                                       AS skew_raw
  FROM oee.product_count_wc_day c2
  WHERE c2.work_center_id = c.work_center_id
    AND c2.business_date  = c.business_date
) sh
CROSS JOIN LATERAL (
  SELECT
    sh.share_raw                                                       AS share,
    -- THE INVENTED PART, and it is a REDISTRIBUTION rather than a multiplier —
    -- see share_raw's sibling above. Odd product ids run a little longer than
    -- their infeed share, even ids a little shorter, and the two still add up.
    sh.skew_raw                                                        AS skew,
    -- QUALITY IS REAL: measured counts, this SKU's own.
    100.0 * (c.total_out - c.reject - c.rework)
          / nullif(c.total_out, 0)                                     AS qual
) s0
CROSS JOIN LATERAL (
  SELECT
    s0.share, s0.skew, s0.qual,
    -- Availability and performance carry the skew, so they differ per SKU. The
    -- line's own figures are the base; NULL propagates rather than becoming 0,
    -- because a line with no rate has no rate to divide.
    least(100.0, r.availability * (1 + CASE WHEN c.product_id % 2 = 1 THEN 0.02 ELSE -0.02 END)) AS avail,
    least(100.0, r.performance  * (1 + CASE WHEN c.product_id % 2 = 1 THEN -0.03 ELSE 0.03 END)) AS perf
) s
WHERE r.infeed_uom_id IS NOT NULL
  AND r.output_uom_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- STEP 3 — the watermark
-- ---------------------------------------------------------------------------
--
-- A seed that fills the rows and leaves the watermark alone leaves every
-- populated card ALSO claiming to be stale, which is the opposite failure. 0016's
-- rule. `HAVING count(*) > 0` makes it a no-op rather than a lie when the insert
-- above matched nothing.
INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
SELECT 'product_report_wc_day', now(), max(business_date), count(*), 'seed-0021-dev'
  FROM oee.product_report_wc_day
HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE
   SET last_run_at        = excluded.last_run_at,
       last_business_date = excluded.last_business_date,
       rows_total         = excluded.rows_total,
       writer             = excluded.writer;

-- ---------------------------------------------------------------------------
-- STEP 4 — assertions
-- ---------------------------------------------------------------------------
--
-- A seed that quietly produced nothing is worse than none: the screen's empty
-- state is indistinguishable from the seed not having run.
DO $$
DECLARE
  reports    bigint;
  attributed bigint;
  unattr     bigint;
  two_lines  bigint;
BEGIN
  SELECT count(*) INTO reports FROM oee.product_report_wc_day;
  IF reports = 0 THEN
    RAISE EXCEPTION 'Seeded no SKU reports. Run 0013, 0014, 0015, 0017 and 0016 first.';
  END IF;

  SELECT count(*) FILTER (WHERE product_id IS NOT NULL),
         count(*) FILTER (WHERE product_id IS NULL)
    INTO attributed, unattr
    FROM oee.downtime_reports;

  IF attributed = 0 THEN
    RAISE EXCEPTION 'No downtime was attributed to a SKU; the SKU screens would read 100%% available.';
  END IF;

  -- The banner has to be reachable. If every stop were attributed, the one state
  -- that stops an operator trusting an incomplete downtime table would be dead
  -- code with no way to see it.
  IF unattr = 0 THEN
    RAISE EXCEPTION 'Every stop is attributed, so the unattributed-downtime banner cannot be exercised.';
  END IF;

  -- THE CASE THE WHOLE REPORT EXISTS FOR: one SKU, one date, two lines. If this
  -- ever stops holding, the list screen still renders and its reason for being
  -- breaks down silently.
  SELECT count(*) INTO two_lines
    FROM (
      SELECT business_date, product_id
        FROM oee.product_report_wc_day
       GROUP BY business_date, product_id
      HAVING count(DISTINCT work_center_id) > 1
    ) t;
  IF two_lines = 0 THEN
    RAISE EXCEPTION 'No (date, SKU) is reported on two lines; the breakdown-by-line case is unreachable.';
  END IF;

  RAISE NOTICE 'Seeded % SKU reports; % stops attributed, % left NULL; % (date, SKU) pairs span two lines.',
    reports, attributed, unattr, two_lines;
END
$$;

COMMIT;
