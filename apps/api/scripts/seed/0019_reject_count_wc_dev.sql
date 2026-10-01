-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See 0015.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0019_reject_count_wc_dev.sql
--
-- CHECK `\conninfo` FIRST.
--
-- ---------------------------------------------------------------------------
-- WHY IT EXISTS
-- ---------------------------------------------------------------------------
--
-- oee.reject_count_wc_shift (migration 0019) ships EMPTY, so the Quality Loss
-- Pareto on the Line report's Losses page has only its "not loaded yet" state.
--
-- IT IS A STAND-IN. IT IS *NOT* THE SPECIFICATION — 0016's terms exactly, and the
-- irony is worth stating plainly:
--
--   THIS SEED PERFORMS THE VERY ROLL-UP MIGRATION 0019 EXISTS TO STOP. It sums
--   the machines' reject counters, which is what the Pareto used to do and which
--   contract §20.1 asks the pipeline owner in capitals not to build.
--
-- It does it because there is nothing else to derive from, and because an
-- unreachable screen cannot be reviewed. Every figure below is the WRONG NUMBER
-- BY CONSTRUCTION: it will not agree with the Losses card's Reject tile, and when
-- the pipeline's own rows arrive the two SHOULD differ by an unknown amount.
--
-- Do not hand this to the pipeline owner. Do not check their output against it.

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

DELETE FROM oee.reject_count_wc_shift w
 WHERE EXISTS (
   SELECT 1 FROM oee.reject_count_wu_shift m
    WHERE m.work_center_id = w.work_center_id
 );

-- THE UNIT GATE IS THE ONE PIECE WORTH COPYING, and unlike 0016's it can actually
-- ABSTAIN here — uom_id is NULLABLE on this table's reader path, because a line's
-- count points can genuinely differ (contract §20.5) where a machine has one unit.
--
-- Except it cannot: uom_id is NOT NULL on the table, same as 0008's. So a bucket
-- whose machines disagree is SKIPPED, exactly as 0016 skips a mixed-unit SKU and
-- for the same reason — the abstention belongs to the READER, which reports a
-- NULL unit when the rows in a bucket disagree. Step 3 counts what was dropped.
INSERT INTO oee.reject_count_wc_shift (
  work_center_id, business_date, shift, product_id, reason,
  work_center_name, work_center_code, product_name, product_code,
  reason_code, reason_id, source_tag, count_point_id,
  uom_id, uom_name, uom_code,
  counter_value, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  weight_gram, frequency, reject_time, time_zone
)
SELECT m.work_center_id,
       m.shift_date                      AS business_date,
       m.shift,
       m.product_id,
       m.reason,
       min(m.work_center_name)           AS work_center_name,
       min(m.work_center_name)           AS work_center_code,
       min(m.product_name)               AS product_name,
       min(m.product_code)               AS product_code,
       min(m.reason_code)                AS reason_code,
       min(m.reason_id)                  AS reason_id,
       min(m.source_tag)                 AS source_tag,
       min(m.count_point_id)             AS count_point_id,
       min(m.uom_id)                     AS uom_id,
       min(m.uom_name)                   AS uom_name,
       min(m.uom_code)                   AS uom_code,
       round(sum(m.counter_value), 3)    AS counter_value,
       min(m.base_uom_id)                AS base_uom_id,
       min(m.base_uom_name)              AS base_uom_name,
       min(m.base_uom_code)              AS base_uom_code,
       -- One factor per (product, uom, base_uom) is §3.4's guarantee, so min()
       -- picks the only value there is. converted_value is GENERATED from it.
       min(m.factor_to_base)             AS factor_to_base,
       round(sum(m.weight_gram), 3)      AS weight_gram,
       sum(m.frequency)::int             AS frequency,
       sum(m.reject_time)::bigint        AS reject_time,
       min(m.time_zone)                  AS time_zone
  FROM oee.reject_count_wu_shift m
 WHERE m.work_center_id IS NOT NULL
 GROUP BY m.work_center_id, m.shift_date, m.shift, m.product_id, m.reason
-- UNANIMOUS UNITS ONLY. count(DISTINCT uom_id) = 1 alone suffices because
-- reject_count_wu_shift.uom_id is NOT NULL: a machine counter always has a unit,
-- and only the fictional line-level sum can disagree.
HAVING count(DISTINCT m.uom_id) = 1;

INSERT INTO oee.etl_watermarks (table_name, last_run_at, last_business_date, rows_total, writer)
SELECT 'reject_count_wc_shift', now(), max(business_date), count(*), 'seed-0019-dev'
  FROM oee.reject_count_wc_shift
HAVING count(*) > 0
ON CONFLICT (table_name) DO UPDATE
   SET last_run_at = excluded.last_run_at,
       last_business_date = excluded.last_business_date,
       rows_total = excluded.rows_total,
       writer = excluded.writer;

DO $$
DECLARE
  made bigint;
  skipped bigint;
BEGIN
  SELECT count(*) INTO made FROM oee.reject_count_wc_shift;

  SELECT count(*) INTO skipped
    FROM (
      SELECT 1 FROM oee.reject_count_wu_shift
       WHERE work_center_id IS NOT NULL
       GROUP BY work_center_id, shift_date, shift, product_id, reason
      HAVING count(DISTINCT uom_id) > 1
    ) AS mixed;

  IF made = 0 THEN
    RAISE EXCEPTION
      'Seed produced no rows. oee.reject_count_wu_shift is empty, or none of its rows carry a work_center_id — this seed derives entirely from it.';
  END IF;

  RAISE NOTICE 'seed 0019: % line reject rows, % buckets skipped for mixed units', made, skipped;
  RAISE NOTICE '  these are MACHINE SUMS. They will not agree with the Losses card''s Reject tile, and they are not what the pipeline should produce (contract §20.1).';
END
$$;

COMMIT;
