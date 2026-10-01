-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE: `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more, so psql prints the refusal and carries
-- straight on to the INSERT. 0015's header records that being observed against
-- the shared Gold database, where 18 rows landed after the guard fired.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds there, so a seed placed in that directory would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0016_product_count_wc_dev.sql
--
-- CHECK `\conninfo` FIRST. apps/api/.env points GOLD_DATABASE_URL at a SHARED
-- REMOTE database. The guard below refuses one database by name; it cannot know
-- about yours.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS, AND WHY PART 2 REFUSED TO WRITE IT
-- ---------------------------------------------------------------------------
--
-- `oee.product_count_wc_{shift,day}` (migration 0016) ship EMPTY. Airflow fills
-- them; contract §17 is the ask. So SKU View on the three Line report screens has
-- only one state anyone can see — its empty state.
--
-- PART 2 DELIBERATELY SHIPPED NO SEED FOR THESE TWO TABLES, and the reason is
-- still true: the only derivation available here is a ROLL-UP of the machine
-- tables, and §17.1 asks the pipeline owner in capitals not to build one, because
-- A LINE IS MEASURED, NOT SUMMED. A seed that sums machines teaches exactly the
-- invariant these tables exist to deny.
--
-- WHAT CHANGED IS THE PURPOSE, NOT THE ARITHMETIC. The reject/rework entry
-- feature (Part 3) needs the SKU View card populated to be exercised by eye at
-- all, and an unreachable screen cannot be reviewed. So this file exists on
-- exactly the terms 0015 set for the line reports themselves:
--
--   IT IS A STAND-IN. IT IS *NOT* THE SPECIFICATION.
--
-- Every figure below is a machine-sum, which is the WRONG NUMBER BY
-- CONSTRUCTION. Do not read it as a reference implementation, do not hand it to
-- the pipeline owner, and do not use it to check the pipeline's own output when
-- it arrives — the two SHOULD disagree, and by an unknown amount.
--
-- THE ONE THING IT IS GOOD FOR: making the card render so its layout, its
-- loaded/stale ladder and the Add Reject / Add Rework buttons beside it can be
-- looked at.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT SEED, AND WHY THAT MATTERS FOR TESTING THE ENTRY DIALOG
-- ---------------------------------------------------------------------------
--
-- THE ENTRY DIALOG'S SKU PICKER DOES NOT READ THESE TABLES. It reads
-- mes-master-data (`GET /master-data/products?workCenterId=`), because a picklist
-- is a CATALOGUE question — what the line is set up to run — and not a
-- MEASUREMENT of what it did run. So Add Reject works whether or not this seed
-- has been applied; what needs it is the SKU View CARD.
--
-- If the dialog's SKU list is empty, the problem is upstream: that line has no
-- products assigned to it in mes-master-data.

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

-- IDEMPOTENT BY DELETE-THEN-INSERT over the rows this seed itself produces —
-- keyed by the work centers it can derive, so a second run replaces rather than
-- conflicts. It deliberately does NOT truncate: if the pipeline has started
-- writing real rows for OTHER lines, those must survive.
DELETE FROM oee.product_count_wc_shift s
 WHERE EXISTS (
   SELECT 1 FROM oee.work_unit_shift_reports r
    WHERE r.work_center_id = s.work_center_id
 );

-- ---------------------------------------------------------------------------
-- STEP 1 — the shift grain, summed from the machines. THE WRONG NUMBER.
-- ---------------------------------------------------------------------------
--
-- The join is `work_unit_shift_reports` -> `product_count_wu_shift` on
-- (work_unit_id, shift_date, shift), because product_count_wu_shift carries no
-- work_center_id of its own and the report row is what knows the line.
--
-- MIXED-UNIT SKUs ARE SKIPPED, and finding out why is worth the paragraph.
--
-- The obvious move is §16.3(c)'s abstention: when a SKU's machines disagree on
-- the unit, write NULL and null its counts with it. THAT CANNOT BE STORED HERE —
-- `product_count_wc_shift.uom_id` is NOT NULL.
--
-- And that constraint is RIGHT, which is the interesting part. These tables are
-- not a roll-up: a line measures one SKU at ONE count point in ONE unit, so there
-- is nothing for the real loader to abstain about. The disagreement exists only
-- inside the fiction this seed performs — summing machines — so the honest thing
-- is for the seed to decline to invent a row rather than to pick a unit and put
-- incompatible numbers under it.
--
-- Step 4 reports how many SKUs were dropped. A line whose SKU View looks short is
-- looking at that, not at a missing product.
INSERT INTO oee.product_count_wc_shift (
  work_center_id, business_date, shift, time_zone,
  work_center_name, work_center_code,
  product_id, product_name, product_code,
  uom_id, uom_name, uom_code,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT r.work_center_id,
       -- The SHIFT's business day. product_count_wu_shift.shift_date already IS
       -- one (a real `date`, not the timestamptz work_unit_shift_reports.date is),
       -- so nothing is converted here and no zone is involved.
       p.shift_date                                     AS business_date,
       p.shift,
       min(r.time_zone)                                 AS time_zone,
       min(r.work_center_name)                          AS work_center_name,
       min(r.work_center_code)                          AS work_center_code,
       p.product_id,
       min(p.product_name)                              AS product_name,
       min(p.product_code)                              AS product_code,
       -- min() over a group the HAVING below has already proved unanimous, so
       -- this picks the only value there is rather than one of several.
       min(p.uom_id)                                    AS uom_id,
       min(p.uom_name)                                  AS uom_name,
       min(p.uom_code)                                  AS uom_code,
       min(p.base_uom_id)                               AS base_uom_id,
       min(p.base_uom_name)                             AS base_uom_name,
       min(p.base_uom_code)                             AS base_uom_code,
       -- One factor per (product, uom, base_uom) is contract §3.4's guarantee, so
       -- min() picks the only value there is. If that guarantee is ever broken
       -- this silently picks one, which is the seed inheriting a real caveat
       -- rather than adding one.
       min(p.factor_to_base)                            AS factor_to_base,
       round(sum(p.total_out), 3)                       AS total_out,
       round(sum(p.good_out), 3)                        AS good_out,
       round(sum(p.reject), 3)                          AS reject,
       round(sum(p.rework), 3)                          AS rework
  FROM oee.work_unit_shift_reports r
  JOIN oee.product_count_wu_shift p
    ON p.work_unit_id = r.work_unit_id
   AND p.shift        = r.shift
   -- r.date is the shift's START INSTANT, so the business day comes off the
   -- report's own business_date where 0013 has filled it and off the instant
   -- through the plant's zone where it has not (TODOS §46: that column is
   -- nullable and unbackfilled).
   AND p.shift_date   = coalesce(r.business_date, (r.date AT TIME ZONE r.time_zone)::date)
 GROUP BY r.work_center_id, p.shift_date, p.shift, p.product_id
-- THE FILTER, not an abstention — see the note above. `count(DISTINCT uom_id) = 1`
-- alone suffices at THIS hop because product_count_wu_shift.uom_id is NOT NULL: a
-- machine always has a unit, and only the fictional line-level sum can disagree.
HAVING count(DISTINCT p.uom_id) = 1;

-- ---------------------------------------------------------------------------
-- STEP 2 — the day grain, chained from step 1.
-- ---------------------------------------------------------------------------
--
-- CHAINED DELIBERATELY, as 0013's and 0015's seeds chain, so the two-step shape
-- the pipeline will build is the one exercised.
--
-- NO NULL-SKIPPING TRAP ON THIS HOP EITHER, and it is worth saying so rather than
-- carrying a guard against it: step 1's output has uom_id NOT NULL too, so a day
-- cannot inherit an abstention because a shift cannot express one. The same
-- unanimity filter applies for the same reason — three shifts of one SKU could
-- still disagree if the line's machine mix changed between them.
DELETE FROM oee.product_count_wc_day d
 WHERE EXISTS (
   SELECT 1 FROM oee.work_unit_shift_reports r
    WHERE r.work_center_id = d.work_center_id
 );

INSERT INTO oee.product_count_wc_day (
  work_center_id, business_date, time_zone,
  work_center_name, work_center_code,
  product_id, product_name, product_code,
  uom_id, uom_name, uom_code,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT s.work_center_id,
       s.business_date,
       min(s.time_zone),
       min(s.work_center_name),
       min(s.work_center_code),
       s.product_id,
       min(s.product_name),
       min(s.product_code),
       min(s.uom_id),
       min(s.uom_name),
       min(s.uom_code),
       min(s.base_uom_id),
       min(s.base_uom_name),
       min(s.base_uom_code),
       min(s.factor_to_base),
       round(sum(s.total_out), 3),
       round(sum(s.good_out), 3),
       round(sum(s.reject), 3),
       round(sum(s.rework), 3)
  FROM oee.product_count_wc_shift s
 GROUP BY s.work_center_id, s.business_date, s.product_id
HAVING count(DISTINCT s.uom_id) = 1;

-- ---------------------------------------------------------------------------
-- STEP 3 — the watermark, without which the card cannot tell its two empties apart
-- ---------------------------------------------------------------------------
--
-- `loadedThrough` is what lets SKU View say "not loaded yet" rather than "this
-- line produced nothing" — §14's ladder, and the whole reason the payload carries
-- it. A seed that filled the rows and left the watermark alone would leave every
-- populated card ALSO claiming to be stale, which is the opposite failure.
INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
SELECT 'product_count_wc_shift', now(), max(business_date), count(*), 'seed-0016-dev'
  FROM oee.product_count_wc_shift
HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE
   SET last_run_at = excluded.last_run_at,
       last_business_date = excluded.last_business_date,
       rows_total = excluded.rows_total,
       writer = excluded.writer;

INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
SELECT 'product_count_wc_day', now(), max(business_date), count(*), 'seed-0016-dev'
  FROM oee.product_count_wc_day
HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE
   SET last_run_at = excluded.last_run_at,
       last_business_date = excluded.last_business_date,
       rows_total = excluded.rows_total,
       writer = excluded.writer;

-- ---------------------------------------------------------------------------
-- STEP 4 — assertions. A seed that quietly produced nothing is worse than none:
-- the card's empty state is indistinguishable from the seed not having run.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  shift_rows bigint;
  day_rows   bigint;
  skipped    bigint;
BEGIN
  SELECT count(*) INTO shift_rows FROM oee.product_count_wc_shift;
  SELECT count(*) INTO day_rows   FROM oee.product_count_wc_day;

  IF shift_rows = 0 THEN
    RAISE EXCEPTION
      'Seed produced no rows. oee.product_count_wu_shift is probably empty, or no work_unit_shift_report joins it — this seed derives entirely from those two.';
  END IF;

  -- HOW MANY SKUs THE UNANIMITY FILTER DROPPED. A silent skip is the one thing
  -- worse than the skip itself: a line whose SKU View looks short would otherwise
  -- read as a line that ran fewer products.
  SELECT count(*) INTO skipped
    FROM (
      SELECT 1
        FROM oee.work_unit_shift_reports r
        JOIN oee.product_count_wu_shift p
          ON p.work_unit_id = r.work_unit_id
         AND p.shift        = r.shift
         AND p.shift_date   = coalesce(r.business_date, (r.date AT TIME ZONE r.time_zone)::date)
       GROUP BY r.work_center_id, p.shift_date, p.shift, p.product_id
      HAVING count(DISTINCT p.uom_id) > 1
    ) AS mixed;

  RAISE NOTICE 'seed 0016: % shift rows, % day rows, % SKU-shifts skipped for mixed units',
    shift_rows, day_rows, skipped;

  IF skipped > 0 THEN
    RAISE NOTICE '  those SKUs are counted in different units on different machines, which a line-level row cannot represent — see the note in step 1.';
  END IF;
END
$$;

COMMIT;
