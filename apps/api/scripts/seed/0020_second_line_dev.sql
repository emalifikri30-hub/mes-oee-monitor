-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See 0015.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds there, so a seed placed in that directory would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0020_second_line_dev.sql
--
-- CHECK `\conninfo` FIRST. apps/api/.env points GOLD_DATABASE_URL at a SHARED
-- REMOTE database. The guard below refuses one database by name; it cannot know
-- about yours.
--
-- RUN AFTER 0014 and BEFORE 0015. This clones what 0014 wrote, and 0015/0016/
-- 0017/0018/0019 then derive the line-grain tables for BOTH lines. Running it
-- after those leaves the new line with machine rows and no line report.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS: THE DEV WORLD HAD ONE LINE WEARING TWO IDS
-- ---------------------------------------------------------------------------
--
-- A SKU daily report is "one SKU, on one line, on one business date", and its
-- whole reason for being is that the SAME SKU on the SAME DATE yields a separate
-- report per line. Before this file, no date in dev carried two lines.
--
-- IT LOOKED LIKE IT DID, AND THAT IS THE PART WORTH READING. 0013 puts work units
-- 3 and 4 on work_center_id 1, 'Line 1', code 'L1'. 0014 then re-seeded work unit
-- 3 from the LIVE rows and found it on work_center_id 2, code 'FI2-L1' — the same
-- physical line under the id master data actually uses. So 2026-08-19 appeared to
-- have two lines, both named 'Line 1', and it had one:
--
--     wc 1  'Line 1'  'L1'       <- 0013's stale spelling
--     wc 2  'Line 1'  'FI2-L1'   <- the live one, same line
--
-- 0014's own header names this failure exactly — "it produces a second,
-- near-identical machine ... which is worse than an error because it looks like
-- data" — and a review of this feature walked into it anyway, first calling the
-- case unreachable, then calling that wrong on the strength of the duplicate.
-- The seed's assertion at the bottom is there so nobody has to notice again.
--
-- ---------------------------------------------------------------------------
-- THE IDENTITY BELOW IS REAL. IT WAS SUPPLIED FROM ms_core, NOT INVENTED.
-- ---------------------------------------------------------------------------
--
--   work_center_id 3, 'Line 2', 'FI2-L2'
--   area_id 2, 'FI2' (code AJINE-FI2), factory 1 'Ajinomoto Mojokerto NE' (AJINE)
--   work_unit_id 6, 'Vertical Packer L', 'VERTICAL-PACKER-L'
--
-- THIS MATTERS MORE THAN IT LOOKS. Commit c9580a6 is what happens when a seed
-- makes up an id: 0017 hardcoded a uom id that did not exist upstream, the CODES
-- agreed while the RECORDS did not, and the resulting error read as nonsense. A
-- label is not a key. Here the stake is the Line filter on every report list,
-- which is built from mes-master-data — an invented work_center_id renders in a
-- table and is then missing from the dropdown that filters it.
--
-- IF THESE IDS ARE WRONG, FIX THEM HERE rather than working around them
-- downstream, and re-run from 0015.
--
-- ---------------------------------------------------------------------------
-- IT IS A CLONE, AND THE MEASURES ARE PERTURBED ON PURPOSE
-- ---------------------------------------------------------------------------
--
-- Every row is 0014's, re-keyed onto the identity above. That keeps the two lines
-- structurally identical — same dates, same shifts, same SKUs — which is what
-- makes them comparable on screen.
--
-- The MEASURES are then scaled by a few percent, and that is not decoration. Two
-- lines carrying byte-identical numbers cannot fail a "read the wrong line" test:
-- a screen that fetched line 2 and rendered line 3 would look perfect. The scale
-- factors make the two distinguishable at a glance and in an assertion.
--
-- `to_jsonb(row) || overrides` RATHER THAN A COLUMN LIST, because the report
-- tables carry ~45 columns each and listing them twice per table is a drift
-- waiting to happen — the next migration to add a column would leave this file
-- silently copying a NULL. The serial ids are drawn explicitly from their own
-- sequences, since jsonb_populate_record would otherwise supply NULL and defeat
-- the DEFAULT.
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

CREATE TEMP TABLE line2_params AS
SELECT 3                       AS work_center_id,
       'Line 2'                AS work_center_name,
       'FI2-L2'                AS work_center_code,
       2                       AS area_id,
       'FI2'                   AS area_name,
       6                       AS work_unit_id,
       'Vertical Packer L'     AS work_unit_name,
       'VERTICAL-PACKER-L'     AS work_unit_code,
       -- The source this clones from: 0014's work unit, on the live line.
       3                       AS src_work_unit_id,
       2                       AS src_work_center_id,
       -- Distinguishability. See the header.
       0.93::numeric           AS count_scale,
       0.88::numeric           AS time_scale,
       -- THE TWO MEASURE FAMILIES, NAMED, because scaling must be uniform WITHIN
       -- a family and may differ BETWEEN them. 0015 asserts the waterfall
       -- identities (availability_time = runtime + its losses, and so on down),
       -- and those are linear — so multiplying every duration by one factor
       -- preserves all of them, while scaling a SUBSET breaks them. The first
       -- version of this file scaled runtime, availability_time and
       -- availability_loss_time only, and 0015 refused 25 rows. It was right.
       ARRAY[
         'runtime','availability_time','production_time','pdt_time','operating_time',
         'updt_time','net_time','reduce_speed_time','ms_time','value_added_time',
         'rework_time','reject_time','anomaly_time','up_speed_time',
         'schedule_loss_time','availability_loss_time','performance_loss_time',
         'ms_loss_time','reduce_speed_loss_time','quality_loss_time'
       ]::text[]              AS duration_cols,
       ARRAY[
         'total_out','good_out','effective_out','reject','rework','line_out'
       ]::text[]              AS count_cols;

-- Idempotent, and scoped to the CLONE rather than to a date range: everything
-- this file writes carries work_unit_id 6, so deleting by it cannot reach 0014's
-- rows or the pipeline's.
DELETE FROM oee.downtime_log_events   WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.downtime_reports      WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.product_count_wu_day  WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.product_count_wu_shift WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.reject_count_wu_shift WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.work_unit_month_reports WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.work_unit_day_reports  WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);
DELETE FROM oee.work_unit_shift_reports WHERE work_unit_id = (SELECT work_unit_id FROM line2_params);

-- The identity overrides every clone applies. Built once so the nine statements
-- below cannot drift from each other.
CREATE TEMP TABLE line2_identity AS
SELECT jsonb_build_object(
         'work_unit_id',     p.work_unit_id,
         'work_unit_name',   p.work_unit_name,
         'work_unit_code',   p.work_unit_code,
         'work_center_id',   p.work_center_id,
         'work_center_name', p.work_center_name,
         'work_center_code', p.work_center_code,
         'area_id',          p.area_id,
         'area_name',        p.area_name
       ) AS ident
FROM line2_params p;

-- ---- the three machine report grains ---------------------------------------
INSERT INTO oee.work_unit_shift_reports
SELECT (jsonb_populate_record(
          NULL::oee.work_unit_shift_reports,
          sc.scaled || i.ident
            || jsonb_build_object('id', nextval('oee.work_unit_shift_reports_id_seq'))
        )).*
FROM oee.work_unit_shift_reports r, line2_params p, line2_identity i
CROSS JOIN LATERAL (  -- Scale every measure by its FAMILY's factor and copy everything else
  -- verbatim. Rebuilding the object from jsonb_each rather than overriding named
  -- columns is what keeps the scaling uniform: there is no way to scale one
  -- duration and forget its siblings.
  --
  -- CONSEQUENCE WORTH KNOWING: a rate whose numerator and denominator sit in the
  -- SAME family is unchanged by this. Availability is runtime/availability_time,
  -- so line 2 and line 3 report the same availability; quality is likewise
  -- counts-only. Performance and OEE mix the families and do differ. The two
  -- lines are told apart by their COUNTS, which is what this file's assertion
  -- checks — and making a rate differ would mean scaling a leaf duration and
  -- recomputing its parents, i.e. reimplementing 0015's arithmetic here.
  SELECT jsonb_object_agg(
           e.key,
           CASE
             WHEN e.value = 'null'::jsonb              THEN e.value
             WHEN e.key = ANY (p.duration_cols)
               THEN to_jsonb(round((e.value #>> '{}')::numeric * p.time_scale))
             WHEN e.key = ANY (p.count_cols)
               THEN to_jsonb(round((e.value #>> '{}')::numeric * p.count_scale, 3))
             ELSE e.value
           END
         ) AS scaled
  FROM jsonb_each(to_jsonb(r)) e) sc
WHERE r.work_unit_id = p.src_work_unit_id AND r.work_center_id = p.src_work_center_id;

INSERT INTO oee.work_unit_day_reports
SELECT (jsonb_populate_record(
          NULL::oee.work_unit_day_reports,
          sc.scaled || i.ident
            || jsonb_build_object('id', nextval('oee.work_unit_day_reports_id_seq'))
        )).*
FROM oee.work_unit_day_reports r, line2_params p, line2_identity i
CROSS JOIN LATERAL (  -- Scale every measure by its FAMILY's factor and copy everything else
  -- verbatim. Rebuilding the object from jsonb_each rather than overriding named
  -- columns is what keeps the scaling uniform: there is no way to scale one
  -- duration and forget its siblings.
  --
  -- CONSEQUENCE WORTH KNOWING: a rate whose numerator and denominator sit in the
  -- SAME family is unchanged by this. Availability is runtime/availability_time,
  -- so line 2 and line 3 report the same availability; quality is likewise
  -- counts-only. Performance and OEE mix the families and do differ. The two
  -- lines are told apart by their COUNTS, which is what this file's assertion
  -- checks — and making a rate differ would mean scaling a leaf duration and
  -- recomputing its parents, i.e. reimplementing 0015's arithmetic here.
  SELECT jsonb_object_agg(
           e.key,
           CASE
             WHEN e.value = 'null'::jsonb              THEN e.value
             WHEN e.key = ANY (p.duration_cols)
               THEN to_jsonb(round((e.value #>> '{}')::numeric * p.time_scale))
             WHEN e.key = ANY (p.count_cols)
               THEN to_jsonb(round((e.value #>> '{}')::numeric * p.count_scale, 3))
             ELSE e.value
           END
         ) AS scaled
  FROM jsonb_each(to_jsonb(r)) e) sc
WHERE r.work_unit_id = p.src_work_unit_id AND r.work_center_id = p.src_work_center_id;

INSERT INTO oee.work_unit_month_reports
SELECT (jsonb_populate_record(
          NULL::oee.work_unit_month_reports,
          sc.scaled || i.ident
            || jsonb_build_object('id', nextval('oee.work_unit_month_reports_id_seq'))
        )).*
FROM oee.work_unit_month_reports r, line2_params p, line2_identity i
CROSS JOIN LATERAL (  -- Scale every measure by its FAMILY's factor and copy everything else
  -- verbatim. Rebuilding the object from jsonb_each rather than overriding named
  -- columns is what keeps the scaling uniform: there is no way to scale one
  -- duration and forget its siblings.
  --
  -- CONSEQUENCE WORTH KNOWING: a rate whose numerator and denominator sit in the
  -- SAME family is unchanged by this. Availability is runtime/availability_time,
  -- so line 2 and line 3 report the same availability; quality is likewise
  -- counts-only. Performance and OEE mix the families and do differ. The two
  -- lines are told apart by their COUNTS, which is what this file's assertion
  -- checks — and making a rate differ would mean scaling a leaf duration and
  -- recomputing its parents, i.e. reimplementing 0015's arithmetic here.
  SELECT jsonb_object_agg(
           e.key,
           CASE
             WHEN e.value = 'null'::jsonb              THEN e.value
             WHEN e.key = ANY (p.duration_cols)
               THEN to_jsonb(round((e.value #>> '{}')::numeric * p.time_scale))
             WHEN e.key = ANY (p.count_cols)
               THEN to_jsonb(round((e.value #>> '{}')::numeric * p.count_scale, 3))
             ELSE e.value
           END
         ) AS scaled
  FROM jsonb_each(to_jsonb(r)) e) sc
WHERE r.work_unit_id = p.src_work_unit_id AND r.work_center_id = p.src_work_center_id;

-- ---- downtime ---------------------------------------------------------------
-- `source_event_id` is UNIQUE (0007), so the clone MUST re-key it. Prefixing
-- rather than nulling: a NULL would make the stop uneditable, and 0007's own
-- header records that the disabled-Edit state is deliberately reachable on ONE
-- row rather than all of them.
--
-- product_id / product_name are cleared, not cloned. 0021 attributes them, and
-- inheriting an attribution from another line would assert that the same SKU ran
-- at the same instant on both — which is the sort of thing a screen shows without
-- comment.
INSERT INTO oee.downtime_reports
SELECT (jsonb_populate_record(
          NULL::oee.downtime_reports,
          to_jsonb(r) || i.ident
            || jsonb_build_object('id', nextval('oee.downtime_reports_id_seq'))
            || jsonb_build_object(
                 'source_event_id',
                 CASE WHEN r.source_event_id IS NULL THEN NULL
                      ELSE 'l2-' || r.source_event_id END)
            || jsonb_build_object('product_id', NULL, 'product_name', NULL)
        )).*
FROM oee.downtime_reports r, line2_params p, line2_identity i
WHERE r.work_unit_id = p.src_work_unit_id AND r.work_center_id = p.src_work_center_id;

-- event_id is this table's PRIMARY KEY, so it is re-keyed for the same reason.
INSERT INTO oee.downtime_log_events
SELECT (jsonb_populate_record(
          NULL::oee.downtime_log_events,
          to_jsonb(e) || i.ident
            || jsonb_build_object('event_id', 'l2-' || e.event_id)
            || jsonb_build_object('product_id', NULL, 'product_name', NULL)
        )).*
FROM oee.downtime_log_events e, line2_params p, line2_identity i
WHERE e.work_unit_id = p.src_work_unit_id AND e.work_center_id = p.src_work_center_id;

-- ---- the per-SKU tables -----------------------------------------------------
INSERT INTO oee.product_count_wu_shift
SELECT (jsonb_populate_record(
          NULL::oee.product_count_wu_shift,
          to_jsonb(c) || i.ident
            || jsonb_build_object(
                 'total_out', round(c.total_out * p.count_scale, 3),
                 'good_out',  round(c.good_out  * p.count_scale, 3),
                 'reject',    round(c.reject    * p.count_scale, 3),
                 'rework',    round(c.rework    * p.count_scale, 3))
        )).*
FROM oee.product_count_wu_shift c, line2_params p, line2_identity i
WHERE c.work_unit_id = p.src_work_unit_id;

INSERT INTO oee.product_count_wu_day
SELECT (jsonb_populate_record(
          NULL::oee.product_count_wu_day,
          to_jsonb(c) || i.ident
            || jsonb_build_object(
                 'total_out', round(c.total_out * p.count_scale, 3),
                 'good_out',  round(c.good_out  * p.count_scale, 3),
                 'reject',    round(c.reject    * p.count_scale, 3),
                 'rework',    round(c.rework    * p.count_scale, 3))
        )).*
FROM oee.product_count_wu_day c, line2_params p, line2_identity i
WHERE c.work_unit_id = p.src_work_unit_id;

-- THE ONLY EXPLICIT COLUMN LIST IN THIS FILE, and `converted_value` is why.
--
-- It is GENERATED ALWAYS. Stripping it from the jsonb (`- 'converted_value'`) is
-- NOT enough: jsonb_populate_record still materialises the column as NULL, and
-- `INSERT ... SELECT (rec).*` then supplies a non-DEFAULT value for a generated
-- column, which Postgres refuses outright. Tried first; it fails loudly, which is
-- the good case.
--
-- A generated column can only be omitted by naming every OTHER column, so this one
-- table pays the drift risk the rest of the file avoids. If a migration adds a
-- column here, add it below — the seed will not notice on its own.
INSERT INTO oee.reject_count_wu_shift (
  work_unit_id, shift_date, shift, product_id, reason,
  work_unit_name, work_unit_code, work_center_id, work_center_name,
  product_name, product_code, reason_code, reason_id, source_tag, count_point_id,
  uom_id, uom_name, uom_code, counter_value,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  weight_gram, frequency, reject_time, time_zone
)
SELECT p.work_unit_id, j.shift_date, j.shift, j.product_id, j.reason,
       p.work_unit_name, p.work_unit_code, p.work_center_id, p.work_center_name,
       j.product_name, j.product_code, j.reason_code, j.reason_id, j.source_tag, j.count_point_id,
       j.uom_id, j.uom_name, j.uom_code, round(j.counter_value * p.count_scale, 3),
       j.base_uom_id, j.base_uom_name, j.base_uom_code, j.factor_to_base,
       j.weight_gram, j.frequency, j.reject_time, j.time_zone
FROM oee.reject_count_wu_shift j, line2_params p
WHERE j.work_unit_id = p.src_work_unit_id;

-- oee.product_perf_wu_hour is DELIBERATELY NOT CLONED. Seed 0018 builds the
-- LINE's hourly curve from work_center_shift_reports joined to
-- product_count_wc_shift — it never reads the machine table — and the SKU daily
-- report has no hourly chart at all. Cloning it would add rows nothing reads, and
-- it carries two generated columns that would need the treatment above.

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  shifts    bigint;
  stops     bigint;
  two_lines bigint;
  same_nums bigint;
BEGIN
  SELECT count(*) INTO shifts FROM oee.work_unit_shift_reports WHERE work_unit_id = 6;
  IF shifts = 0 THEN
    RAISE EXCEPTION 'Cloned nothing. Run 0014 first — this file copies what it wrote.';
  END IF;

  SELECT count(*) INTO stops FROM oee.downtime_reports WHERE work_unit_id = 6;
  IF stops = 0 THEN
    RAISE EXCEPTION 'The new line has no downtime, so its SKU reports cannot exercise the timeline.';
  END IF;

  -- THE CASE THIS FILE EXISTS FOR. Two DISTINCT work centers on one business
  -- date. Counted over work_center_id, so 0013's stale duplicate of line 1
  -- cannot satisfy it on its own.
  SELECT count(*) INTO two_lines
    FROM (SELECT business_date FROM oee.work_unit_shift_reports
           GROUP BY business_date HAVING count(DISTINCT work_center_id) > 1) t;
  IF two_lines = 0 THEN
    RAISE EXCEPTION 'No business date carries two work centers; the by-line breakdown is still unreachable.';
  END IF;

  -- And they must be TELLABLE APART. Identical measures would let a screen fetch
  -- the wrong line and look perfect.
  SELECT count(*) INTO same_nums
    FROM oee.work_unit_shift_reports a
    JOIN oee.work_unit_shift_reports b
      ON b.business_date = a.business_date AND b.shift = a.shift
     AND b.work_unit_id = 6 AND a.work_unit_id = 3
   WHERE a.total_out = b.total_out;
  IF same_nums > 0 THEN
    RAISE EXCEPTION 'The two lines report identical counts; a wrong-line read would be invisible.';
  END IF;

  RAISE NOTICE 'Line 2 (wc 3): % shift reports, % stops. % business dates now carry two lines.',
    shifts, stops, two_lines;
END
$$;

COMMIT;
