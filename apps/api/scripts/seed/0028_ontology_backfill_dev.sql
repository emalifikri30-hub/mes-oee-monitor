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
-- finds in that directory, so a seed placed there would write denormalised
-- labels over whatever the pipeline had resolved, in every environment the
-- migrator touches.
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0028_ontology_backfill_dev.sql
--
-- RUN LAST, AFTER 0024. It reads the same `(work_center_id -> area)` mapping that
-- file builds and extends it one level DOWN, to every work-unit-keyed table. Run
-- it before 0024 and the mapping is thinner; run it before the table-writing
-- seeds and it stamps nothing.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE EXISTS: EVERY REPORT LIST IS AREA-SCOPED NOW
-- ---------------------------------------------------------------------------
--
-- Migration `0028` put the full ontology — enterprise, site, area, work center,
-- work unit — on every report table and every fact table a report screen reads,
-- and the web app's header area picker became a REQUEST filter on all four
-- subjects rather than a lens over which lines a page may offer.
--
-- So `area_id` went from a column four tables had and two screens read, to a
-- PREDICATE ON EVERY LIST. On a development database where the machine tables
-- carry NULL there, that is not a subtle degradation: **By Shift, By Day, By
-- Monthly and the SKU list all go completely empty**, correctly, and look
-- broken. 0024 closed the same gap one level up when the AREA screens landed and
-- its step 3 assertion says what that felt like; this is that file's argument
-- applied to the level below it.
--
-- ---------------------------------------------------------------------------
-- IT INVENTS NOTHING, AND THE TWO LEVELS IT LEAVES NULL ARE THE PROOF
-- ---------------------------------------------------------------------------
--
-- TODOS §78 draws the line this file sits on, and it is 0020's distinction
-- between the two kinds of axis:
--
--   "`area_id` is CONTAINMENT — the area IS derivable from `work_unit_id`,
--    permanently — so a NULL is a missing LABEL and the fix is a backfill."
--
-- A missing LABEL is recoverable from anywhere the label was already resolved. A
-- missing ATTRIBUTION (0020's `product_id`, OCCUPANCY OVER TIME) is not, which is
-- why that one ships a residual count instead of a backfill.
--
-- So the derivation chain is entirely within Gold and entirely from rows the
-- pipeline itself wrote:
--
--     work_unit_id  ──oee.work_unit_shift_reports.work_center_id──▶  work_center_id
--                                    (NOT NULL since 0003)
--     work_center_id ──oee.downtime_reports.(work_center_id, area_id)──▶  area_id
--                                    (0007, and 0024's mapping)
--
-- **`site_*` AND `enterprise_*` ARE NOT FILLED, ANYWHERE, AND THAT IS THE SAME
-- LINE 0024 HELD.** Its header says of the level above the area:
--
--   "factory_id / factory_name — NOT filled, anywhere. The source tables stop at
--    area_name, so the level above the area is not in the data."
--
-- That is still true of `site_*` (which IS those columns, renamed by `0028` to the
-- name mes-master-data uses) and it is true of `enterprise_*` for the first time.
-- Nothing in Gold carries either, so a seed that filled them would be inventing an
-- identity — the failure 0020's header defends against at length, and the one
-- commit c9580a6 is cited for: a label is not a key, and a made-up id renders in a
-- table and is then missing from the dropdown that filters it. **No screen reads
-- either level**, so leaving them NULL costs nothing today; contract §28.4 is the
-- ask that makes them real.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT TOUCH
-- ---------------------------------------------------------------------------
--
--   * Any row whose target column is ALREADY SET. Every UPDATE is guarded by
--     `IS NULL`, so a pipeline that has started resolving these wins over the
--     seed and a re-run is a no-op rather than a revert. `0013`'s "ON CONFLICT DO
--     NOTHING" convention: a seed must never overwrite a real answer with a
--     derived one.
--   * The append-only audit trails — `…_approval_events`,
--     `downtime_report_history`, `write_audit`. `0028` gave them no ontology
--     columns either; they are addressed by natural key and never scanned by area.
--
-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
--
-- THE BYPASS IS A FLAG, NOT AN EDIT — 0014's convention: "a guard you have to
-- delete to proceed is a guard that gets deleted and left deleted." Both parts
-- must be in ONE psql invocation; a separate `-c` is a separate session and the
-- setting will not survive into this file.
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
-- Step 0 — refuse early if 0028 has not been applied
-- ---------------------------------------------------------------------------
--
-- Without this the first UPDATE fails with `column "area_id" does not exist`,
-- which is a true message about the wrong problem: the reader concludes the seed
-- is broken rather than that the migration has not run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'oee'
       AND table_name   = 'work_unit_shift_reports'
       AND column_name  = 'area_id'
  ) THEN
    RAISE EXCEPTION
      'oee.work_unit_shift_reports has no area_id — apply migration 0028 first (pnpm --filter api db:migrate).';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — the line -> area mapping, and the refusal if it is ambiguous
-- ---------------------------------------------------------------------------
--
-- 0024's step 1, verbatim in intent: one row per work_center_id that any downtime
-- row has an area for. Materialised rather than joined inline because the
-- assertions are the point — a silently ambiguous mapping would push a line's
-- whole week into the wrong area's totals, and every list on every screen filters
-- on the result.
--
-- NOT `ON COMMIT DROP`. psql runs each of these statements in its own implicit
-- transaction, so an ON COMMIT DROP temp table is created and destroyed by the
-- same statement and the next step then fails on a relation that does not exist.
DROP TABLE IF EXISTS wc_area;
CREATE TEMP TABLE wc_area AS
SELECT work_center_id,
       min(area_id)                             AS area_id,
       min(area_name)                           AS area_name,
       count(DISTINCT area_id)                  AS distinct_areas,
       count(DISTINCT coalesce(area_name, ''))  AS distinct_names
  FROM oee.downtime_reports
 WHERE work_center_id IS NOT NULL
   AND area_id IS NOT NULL
 GROUP BY work_center_id;

-- Widened with whatever the LINE report tables already know, which 0024 filled.
-- A line that appears in a report but never stopped has no downtime row and would
-- otherwise be unmapped — and its machines' rows would then stay NULL and vanish
-- from every screen, which is precisely the failure this file exists to prevent.
INSERT INTO wc_area (work_center_id, area_id, area_name, distinct_areas, distinct_names)
SELECT r.work_center_id, min(r.area_id), min(r.area_name), count(DISTINCT r.area_id), 1
  FROM oee.work_center_day_reports r
 WHERE r.area_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM wc_area w WHERE w.work_center_id = r.work_center_id)
 GROUP BY r.work_center_id;

DO $$
DECLARE
  lines_mapped integer;
  ambiguous    integer;
BEGIN
  SELECT count(*) INTO lines_mapped FROM wc_area;

  IF lines_mapped = 0 THEN
    RAISE EXCEPTION
      'No line has a resolvable area. Run 0014_review_week_dev.sql, 0020_second_line_dev.sql and 0024_work_center_area_id_dev.sql first.';
  END IF;

  -- Two areas for one line is not a case to resolve by taking the first. It means
  -- the source data disagrees with itself, and every figure derived from it after
  -- this point would be confidently wrong.
  SELECT count(*) INTO ambiguous
    FROM wc_area WHERE distinct_areas > 1 OR distinct_names > 1;

  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      '% line(s) map to more than one area. Refusing to pick one — fix the source rows.',
      ambiguous;
  END IF;

  RAISE NOTICE 'seed 0028: % line(s) have a resolvable area.', lines_mapped;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 2 — the machine -> line mapping
-- ---------------------------------------------------------------------------
--
-- `oee.work_unit_shift_reports.work_center_id` has been NOT NULL since `0003`,
-- and it is the BETTER source than a master-data roster for the reason TODOS §55
-- states: the column records the line the pipeline attributed a machine's numbers
-- TO, where a roster is the line's membership NOW. For a historical report the
-- column is the more correct answer.
--
-- The same ambiguity refusal, and it is not theoretical here — TODOS §77 records
-- work unit 3 appearing under two different `work_center_id`s in the dev seeds.
-- If that is still true this step stops rather than silently filing a machine's
-- reports under one of its two lines.
DROP TABLE IF EXISTS wu_wc;
CREATE TEMP TABLE wu_wc AS
SELECT work_unit_id,
       min(work_center_id)             AS work_center_id,
       count(DISTINCT work_center_id)  AS distinct_lines
  FROM oee.work_unit_shift_reports
 WHERE work_center_id IS NOT NULL
 GROUP BY work_unit_id;

DO $$
DECLARE
  ambiguous integer;
  mapped    integer;
BEGIN
  SELECT count(*) INTO mapped FROM wu_wc;
  SELECT count(*) INTO ambiguous FROM wu_wc WHERE distinct_lines > 1;

  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      '% machine(s) appear under more than one work_center_id in oee.work_unit_shift_reports — TODOS §77. Refusing to pick one.',
      ambiguous;
  END IF;

  RAISE NOTICE 'seed 0028: % machine(s) map to exactly one line.', mapped;
END
$$;

-- The machine -> area mapping, composed from the two above. One join written once,
-- rather than a three-table join repeated in each of the seven UPDATEs below.
DROP TABLE IF EXISTS wu_area;
CREATE TEMP TABLE wu_area AS
SELECT u.work_unit_id, u.work_center_id, a.area_id, a.area_name
  FROM wu_wc u
  JOIN wc_area a ON a.work_center_id = u.work_center_id;

-- ---------------------------------------------------------------------------
-- Step 3 — the MACHINE-keyed tables
-- ---------------------------------------------------------------------------
--
-- The four report tables first: these are what By Shift, By Day, By Monthly and
-- the dashboard's year screens read, and they are the ones that go empty without
-- this file.

UPDATE oee.work_unit_shift_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

UPDATE oee.work_unit_day_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

UPDATE oee.work_unit_month_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

UPDATE oee.work_unit_year_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

-- The machine-keyed FACT tables. `0028` gave the two product-count ones a
-- `work_center_id` they never had, so this fills both levels at once — the LINE
-- first, because the area is derived through it.
UPDATE oee.product_count_wu_shift t
   SET work_center_id = w.work_center_id,
       area_id        = w.area_id,
       area_name      = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

UPDATE oee.product_count_wu_day t
   SET work_center_id = w.work_center_id,
       area_id        = w.area_id,
       area_name      = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

-- `reject_count_wu_shift.work_center_id` is a NULLABLE denormalised label — 0008
-- says so explicitly — so it may already be set, and is filled only where it is
-- not. The area is stamped independently of it.
UPDATE oee.reject_count_wu_shift t
   SET work_center_id = coalesce(t.work_center_id, w.work_center_id),
       area_id        = w.area_id,
       area_name      = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

UPDATE oee.product_perf_wu_hour t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wu_area w
 WHERE t.work_unit_id = w.work_unit_id AND t.area_id IS NULL;

-- ---------------------------------------------------------------------------
-- Step 4 — the LINE-keyed tables 0024 did not reach
-- ---------------------------------------------------------------------------
--
-- 0024 stamped six tables. `0016`'s product-count pair had no `area_id` to stamp
-- until `0028` added one, and `0027`'s year table postdates that seed.
--
-- ---------------------------------------------------------------------------
-- `oee.work_center_quality_entries` IS NOT HERE, AND IT CANNOT BE
-- ---------------------------------------------------------------------------
--
-- This file tried to stamp it and was REFUSED, by `0017`'s `wcqe_append_only()`
-- trigger, with:
--
--   only the void columns may be updated; correct an entry by voiding it and
--   entering a new one
--
-- That is not an obstacle to work around — it is the table's whole design, and
-- `0017`'s header anticipates this exact script in as many words: "The cost,
-- stated plainly: a repair script cannot clean this table either. That is
-- accepted. A bad row is voided." The trigger compares the WHOLE ROW as jsonb
-- minus the four void columns, so there is no subset of columns a backfill could
-- touch; `ALTER TABLE ... DISABLE TRIGGER` would work and is exactly the
-- "guard you have to delete to proceed" this repo refuses to write.
--
-- SO ITS ONTOLOGY COLUMNS ARE INSERT-TIME ONLY, AND OURS. `0028` gave the table
-- the same six columns as everything else and contract §28.5 says they are this
-- service's to fill rather than the pipeline's — which can only mean filled BY THE
-- WRITE PATH WHEN THE ENTRY IS RECORDED, because there is no second chance.
--
-- **THE WRITE PATH DOES NOT FILL THEM YET.** `recordEntry` in
-- `module/quality-entry/quality-entry-repository.ts` names twenty-nine columns and
-- none of the six is among them, so every entry recorded today gets a NULL
-- `area_id` that can never be corrected. That is TODOS §86, and it is a real
-- decision rather than an oversight: the write path does not know the area, and
-- the two ways to teach it are a master-data call (a FATAL upstream dependency on
-- an operator WRITE) or a scalar subquery against the line's own report row (free,
-- but NULL when the DAG has not written one yet). Nothing reads the column, so
-- nothing is broken today; TODOS §79 holds the fan-out it was asked for.

UPDATE oee.product_count_wc_shift t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.product_count_wc_day t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

UPDATE oee.work_center_year_reports t
   SET area_id = w.area_id, area_name = w.area_name
  FROM wc_area w
 WHERE t.work_center_id = w.work_center_id AND t.area_id IS NULL;

-- ---------------------------------------------------------------------------
-- Step 5 — assertions, and the one that matters most
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  orphan_shift integer;
  areas_seen   integer;
BEGIN
  -- THE ASSERTION THIS FILE EXISTS FOR. A machine shift report with a NULL
  -- area_id appears on NO screen at all now — not in By Shift, not under any
  -- area, nowhere. One left behind is a row that silently stopped existing.
  SELECT count(*) INTO orphan_shift
    FROM oee.work_unit_shift_reports WHERE area_id IS NULL;

  IF orphan_shift > 0 THEN
    RAISE EXCEPTION
      '% machine shift report(s) still have a NULL area_id — their work_center_id has no resolvable area, so they are invisible on every report screen.',
      orphan_shift;
  END IF;

  -- A single-area dev world cannot demonstrate the filter at all: every list
  -- looks identical filtered and unfiltered, so a regression that dropped the
  -- predicate entirely would pass every screen by eye.
  SELECT count(DISTINCT area_id) INTO areas_seen FROM oee.work_unit_shift_reports;

  IF areas_seen < 2 THEN
    RAISE NOTICE
      'Only % area(s) carry machine reports — switching the header picker will not visibly change any list. 0020_second_line_dev.sql adds a genuine second line on area 2.',
      areas_seen;
  ELSE
    RAISE NOTICE
      'seed 0028: machine reports span % areas, so the header picker is checkable by eye.',
      areas_seen;
  END IF;
END
$$;

SELECT 'work_unit_shift_reports'      AS table_name, count(*) FILTER (WHERE area_id IS NOT NULL) AS with_area, count(*) AS rows FROM oee.work_unit_shift_reports
UNION ALL SELECT 'work_unit_day_reports',     count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_unit_day_reports
UNION ALL SELECT 'work_unit_month_reports',   count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_unit_month_reports
UNION ALL SELECT 'work_unit_year_reports',    count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_unit_year_reports
UNION ALL SELECT 'product_count_wu_shift',    count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_count_wu_shift
UNION ALL SELECT 'product_count_wu_day',      count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_count_wu_day
UNION ALL SELECT 'reject_count_wu_shift',     count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.reject_count_wu_shift
UNION ALL SELECT 'product_perf_wu_hour',      count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_perf_wu_hour
UNION ALL SELECT 'product_count_wc_shift',    count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_count_wc_shift
UNION ALL SELECT 'product_count_wc_day',      count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.product_count_wc_day
UNION ALL SELECT 'work_center_year_reports',  count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_center_year_reports
-- Listed even though this file never writes it, and it is the one row in this
-- summary expected to read 0 out of N on any database with entries predating
-- the write-path change. See the block above step 4 for why it cannot be
-- backfilled at all.
UNION ALL SELECT 'work_center_quality_entries', count(*) FILTER (WHERE area_id IS NOT NULL), count(*) FROM oee.work_center_quality_entries;

DROP TABLE IF EXISTS wu_area;
DROP TABLE IF EXISTS wu_wc;
DROP TABLE IF EXISTS wc_area;
