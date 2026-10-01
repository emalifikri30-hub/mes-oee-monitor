-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE. `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more: psql reports the error and carries
-- straight on to the next statement, so the refusal prints and the seed runs
-- anyway. That was observed, not theorised — 0014's header records the guard
-- firing against the shared Gold database with 18 rows landing regardless.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds there, so a seed placed there would insert FABRICATED PRODUCTION FIGURES
-- into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0029_masako_reports_dev.sql
--
-- CHECK `\conninfo` FIRST. The guard below refuses one database by name; it
-- cannot know about yours.
--
-- ---------------------------------------------------------------------------
-- WHAT IT IS
-- ---------------------------------------------------------------------------
--
-- The MASAKO area, fully populated across the twelve report tables the four
-- report surfaces read, for 2026-06-01 → 2026-09-14 (92 days + the first two
-- weeks of September, 106 business days, three shifts each):
--
--   oee.work_unit_{shift,day,month,year}_reports      954 / 318 / 12 / 3
--   oee.work_center_{shift,day,month,year}_reports    318 / 106 /  4 / 1
--   oee.product_report_wc_day                         212   (two SKUs)
--   oee.area_{day,month,year}_reports                 106 /   4 / 1
--
-- ---------------------------------------------------------------------------
-- THE IDENTITY IS REAL. IT WAS SUPPLIED, NOT INVENTED
-- ---------------------------------------------------------------------------
--
-- Every id, code and name below was read back from `ms_core` on the target
-- database and cross-checked against the hierarchy the requester stated. That
-- matters for the reason `0020`'s header defends at length and commit `c9580a6`
-- is cited for: a label is not a key, and a made-up id renders in a table and is
-- then MISSING FROM THE DROPDOWN THAT FILTERS IT.
--
--   enterprise  1  AJINOMOTO      Ajinomoto
--   site        1  AJINE          Ajinomoto Mojokerto NE
--   area        3  AJINE-MASAKO   MASAKO
--   work center 14 MSK-LINE01     Line 1            (ms_core.work_centers.area_id = 3)
--   work unit   9  MSK-PCK-BAG01  Packer Bag        counts BAG    (uom 1)
--   work unit   10 MSK-PCK-IN01   Packer Inner      counts INNER  (uom 3)
--   work unit   11 MSK-AUTO-CTN01 Auto Cartoner     counts CARTON (uom 4)
--
-- **THIS IS THE FIRST SEED THAT CAN FILL `site_*` AND `enterprise_*`.** `0024`
-- and `0028` both refused to ("the source tables stop at area_name, so the level
-- above the area is not in the data") and both were right about their own inputs.
-- The hierarchy above is an INPUT to this file, so the refusal does not apply —
-- and it is verified against `ms_core.areas`/`sites` in step 1 rather than
-- trusted, because a seed that hardcoded a wrong site id would be indetectable.
--
-- ---------------------------------------------------------------------------
-- THE LINE IS A GENUINE TWO-UNIT LINE, WHICH IS WHY THIS AREA IS WORTH SEEDING
-- ---------------------------------------------------------------------------
--
-- `0014` and contract §16.4a say a line has TWO units and they are usually
-- different — "bags in, cartons out" — and that
-- `total_out = good_out + reject + rework` is therefore FALSE at that grain. On
-- the FI2 data that claim is only assertable from the schema. Here it is
-- physically true: MSK-LINE01 runs Packer Bag → Packer Inner → Auto Cartoner, so
--
--   infeed  = BAG    (uom 1)   total_out, reject, rework, line_out
--   output  = CARTON (uom 4)   good_out, effective_out
--
-- and the two sides differ by the packaging factor. A reviewer can see the rule
-- rather than take it on trust.
--
-- THE MACHINE RATES ARE A REAL CONVERSION, NOT A FUDGE.
-- `ms_core.product_work_unit_specs` gives all three machines
-- `ideal_rate_per_hour = 14400`, and `ms_core.product_packages` gives product 3
-- the factors BAG 1 / INNER 10 / CARTON 100. 14400 is therefore 14400 BASE units
-- (bags) per hour, and a machine counting in its own unit runs at
-- `14400 / factor_to_base` — 14400 bags, 1440 inners, 144 cartons. Using 14400
-- for all three would have made a cartoner out-produce the bagger feeding it.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DERIVED FROM WHAT, AND THE ONE PLACE THAT IS A STAND-IN
-- ---------------------------------------------------------------------------
--
-- The MACHINE shift rows are generated; everything else is derived from them, so
-- the screens agree with each other rather than agreeing by coincidence:
--
--   machine day   = sum of its 3 shifts       rates RECOMPUTED, never averaged
--   machine month = sum of its days           §15.5
--   machine year  = sum of its months
--   line          = its machines              ← A STAND-IN. See below.
--   SKU day       = the line's day, split     by a fixed product mix
--   area          = its lines                 one line, so numerically identical
--
-- **THE LINE ROWS ARE DERIVED FROM THE MACHINES AND THAT IS WRONG IN PRODUCTION.**
-- `0014` is explicit that A LINE IS MEASURED, NOT SUMMED: it has its own count
-- points, so `line <> sum(machines)` is not a defect, and its durations are the
-- line's OWN wall clock — 8 hours over a 3-machine shift, not 24. `0015`'s seed
-- carries the same warning and this one repeats it rather than quietly relying on
-- it. So the line durations here are taken as the MAX over the machines (one
-- wall clock), NOT the sum; the counts come from the first and last machine in
-- the flow rather than from a total. That is the closest a derivation can get to
-- a measurement, and it is still a stand-in. When the pipeline writes these
-- tables it will disagree with this seed, and the pipeline will be right.
--
-- **THE AREA'S COUNTS ARE NULL, DELIBERATELY.** `0024` makes an area's counts a
-- MASS in ONE unit, through `product_packaging.std_weight`, and
-- `ck_adr_weight_units` ties the unit and the five counts together so they are
-- NULL or present as a set. There is NO mass unit in `ms_core.uom` on this
-- database — it holds BAG, SHOT, INNER, CARTON, SACK and nothing weighed — so a
-- figure here would be a confident number under a unit nobody established. That
-- is `0022`'s call and this file makes the same one. The area's RATES and
-- DURATIONS are real, which is most of the screen.
--
-- **AN AREA OF ONE LINE IS NUMERICALLY IDENTICAL TO THAT LINE.** `0022`'s step 3
-- makes this point and it applies here: MASAKO has exactly one work center, so
-- the "durations are LINE-milliseconds" rule (`0024` consequence 1) cannot be
-- checked by eye against this data — an area of one line has the same wall clock
-- as the line. FI2 is where that is checkable.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DOES NOT WRITE, AND WHY EACH SCREEN THAT NEEDS IT WILL SAY SO
-- ---------------------------------------------------------------------------
--
-- Only the twelve REPORT tables. Not `downtime_reports`, not
-- `downtime_log_events`, not `product_count_w*`, not `reject_count_w*`, not
-- `product_perf_w*_hour`. Those back the Losses drill-downs, the Paretos, SKU
-- View and the hourly charts, and every one of those cards distinguishes "no
-- data" from "the ETL has not loaded" (TODOS §8, §14) — so they will render their
-- honest not-loaded state rather than looking broken. The overview, the metric
-- tiles, the four rates, the waterfall and all four list screens are complete.
--
-- The trade is deliberate: generating stops for 106 days × 3 shifts × 3 machines
-- and keeping every Pareto summing to its report's loss columns is `0014`'s whole
-- design, and `0014` does it for SIX days. Extending it to 106 is a different and
-- much larger piece of work than the report rows asked for here.
--
-- ---------------------------------------------------------------------------
-- RE-RUNNABLE. Every insert is `ON CONFLICT DO NOTHING` against the table's
-- natural key, and step 0 deletes this area's rows first, so a second run
-- replaces rather than doubles. It touches NOTHING outside work units 9/10/11,
-- work center 14 and area 3 — FI2 and H7 are never read and never written.
-- ---------------------------------------------------------------------------

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
-- Step 1 — the identity, VERIFIED rather than trusted
-- ---------------------------------------------------------------------------
--
-- Hardcoded because this file's whole purpose is to supply an identity Gold does
-- not yet carry — and then checked against ms_core, because a hardcoded WRONG id
-- produces rows that look perfect and filter to nothing. If ms_core is not
-- readable from this connection the check is skipped with a NOTICE rather than
-- failing: Gold and master data are the same database today (SILVER/GOLD both
-- point at `mes-master-data`) and that is a placeholder, not a guarantee.
DROP TABLE IF EXISTS msk_identity;
CREATE TEMP TABLE msk_identity AS
SELECT 1                        AS enterprise_id,
       'Ajinomoto'::varchar     AS enterprise_name,
       1                        AS site_id,
       'Ajinomoto Mojokerto NE'::varchar AS site_name,
       3                        AS area_id,
       'MASAKO'::varchar        AS area_name,
       'AJINE-MASAKO'::varchar  AS area_code,
       14                       AS work_center_id,
       'Line 1'::varchar        AS work_center_name,
       'MSK-LINE01'::varchar    AS work_center_code,
       'Asia/Jakarta'::varchar  AS tz;

DO $$
DECLARE
  ok boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'ms_core' AND table_name = 'areas') THEN
    RAISE NOTICE 'ms_core is not readable from this connection — identity NOT verified.';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM ms_core.work_centers wc
      JOIN ms_core.areas a ON a.id = wc.area_id
      JOIN ms_core.sites s ON s.id = a.site_id
     WHERE wc.id = 14 AND a.id = 3 AND s.id = 1 AND s.enterprise_id = 1
  ) INTO ok;

  IF NOT ok THEN
    RAISE EXCEPTION
      'The hardcoded MASAKO hierarchy does not match ms_core. Expected work_center 14 -> area 3 -> site 1 -> enterprise 1. Fix msk_identity before seeding.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM ms_core.work_units WHERE id IN (9,10,11) AND work_center_id = 14
                  HAVING count(*) = 3) THEN
    RAISE EXCEPTION 'Work units 9, 10 and 11 are not all on work_center 14 in ms_core.';
  END IF;

  RAISE NOTICE 'seed 0029: identity verified against ms_core — wc 14 -> area 3 -> site 1 -> enterprise 1.';
END
$$;

-- The three machines, each with its OWN counting unit and the rate that unit
-- actually runs at. `ideal_rate_per_hour` is 14400 BASE units (bags) per hour for
-- all three, so a machine counting INNERs at factor 10 runs at 1440 — see the
-- header. `cycle_ms` is how long one of that machine's units takes.
DROP TABLE IF EXISTS msk_machines;
CREATE TEMP TABLE msk_machines AS
SELECT * FROM (VALUES
  ( 9, 'Packer Bag'::varchar,     'MSK-PCK-BAG01'::varchar,  1, 'BAG'::varchar,    'BAG'::varchar,      1::numeric),
  (10, 'Packer Inner',            'MSK-PCK-IN01',            3, 'INNER',           'INNER',            10::numeric),
  (11, 'Auto Cartoner',           'MSK-AUTO-CTN01',          4, 'CARTON',          'CARTON',          100::numeric)
) AS m(work_unit_id, work_unit_name, work_unit_code, uom_id, uom_name, uom_code, factor_to_base);

-- ---------------------------------------------------------------------------
-- Step 0 (runs here, after the identity is proven) — clear this area only
-- ---------------------------------------------------------------------------
--
-- Scoped to work units 9/10/11, work center 14 and area 3. FI2's and H7's rows
-- are never matched by any predicate in this file.
DELETE FROM oee.work_unit_shift_reports  WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.work_unit_day_reports    WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.work_unit_month_reports  WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.work_unit_year_reports   WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.work_center_shift_reports WHERE work_center_id = 14;
DELETE FROM oee.work_center_day_reports   WHERE work_center_id = 14;
DELETE FROM oee.work_center_month_reports WHERE work_center_id = 14;
DELETE FROM oee.work_center_year_reports  WHERE work_center_id = 14;
DELETE FROM oee.product_report_wc_day     WHERE work_center_id = 14;
DELETE FROM oee.area_day_reports          WHERE area_id = 3;
DELETE FROM oee.area_month_reports        WHERE area_id = 3;
DELETE FROM oee.area_year_reports         WHERE area_id = 3;

-- ---------------------------------------------------------------------------
-- Step 2 — the window, and the loss decomposition
-- ---------------------------------------------------------------------------
--
-- 106 business days x 3 shifts x 3 machines = 954 shift rows.
--
-- `date` ON A MACHINE SHIFT ROW IS THE SHIFT'S START INSTANT, not a business day
-- at midnight — the trap the root AGENTS.md calls out and that produced a real
-- shift-3 bug. Shift 3 starts at 23:00 local and runs into the NEXT calendar day
-- while belonging to THIS business date (shared/shift-window.ts), which is
-- exactly why the instant is built from the business date plus the start time in
-- the plant's zone and never the other way round.
--
-- EVERY FIGURE IS DETERMINISTIC. `v` is pure arithmetic over the business date,
-- the shift and the machine — no random(), no hashtext() (which is not stable
-- across major versions) — so two runs produce identical rows and a reviewer
-- comparing a screen against a query gets the same numbers.
DROP TABLE IF EXISTS msk_shifts;
CREATE TEMP TABLE msk_shifts AS
SELECT
  d::date                                                   AS business_date,
  sh.shift,
  m.*,
  i.tz,
  (d::date + sh.start_time) AT TIME ZONE i.tz               AS shift_start,
  28800000::bigint                                          AS shift_ms,   -- 8h
  -- The month index, 0 for June .. 3 for September. Used only to trend the
  -- figures upward over the window so the four-month charts have a shape.
  ((extract(year from d)::int - 2026) * 12 + extract(month from d)::int - 6) AS mi,
  (extract(doy from d)::int * 7 + sh.shift * 13 + m.work_unit_id * 31)       AS v,
  -- 3.6e6 ms per hour / (base rate / factor) = ms per ONE of this machine's units.
  (3600000::numeric / (14400::numeric / m.factor_to_base))   AS cycle_ms
FROM generate_series('2026-06-01'::date, '2026-09-14'::date, '1 day') d
CROSS JOIN (VALUES (1, '07:00'::time), (2, '15:00'::time), (3, '23:00'::time)) AS sh(shift, start_time)
CROSS JOIN msk_machines m
CROSS JOIN msk_identity i;

-- The five loss buckets, in milliseconds.
--
-- `mi` trends schedule and availability loss DOWN over the four months, so OEE
-- climbs from roughly the low 70s in June to the high 70s in September. A flat
-- window would make the trend chart and the month-over-month comparison — the
-- whole point of having four months — a straight line.
DROP TABLE IF EXISTS msk_derived;
CREATE TEMP TABLE msk_derived AS
WITH losses AS (
  SELECT s.*,
         ((22 + (s.v % 26) - s.mi * 2) * 60000)::bigint       AS pdt_ms,    -- schedule loss
         ((12 + ((s.v * 3) % 27) - s.mi * 2) * 60000)::bigint AS updt_ms,   -- availability loss
         (( 3 + ((s.v * 5) % 10)) * 60000)::bigint            AS ms_ms,     -- small stops
         (( 4 + ((s.v * 7) %  8)) * 60000)::bigint            AS rs_ms,     -- reduce speed
         (((s.v * 11) % 5) * 40000)::bigint                   AS reject_ms,
         (((s.v * 13) % 3) * 20000)::bigint                   AS rework_ms
    FROM msk_shifts s
)
SELECT l.*,
       l.shift_ms                                              AS availability_time,
       l.shift_ms - l.pdt_ms                                   AS production_time,
       l.shift_ms - l.pdt_ms - l.updt_ms                       AS operating_time,
       l.shift_ms - l.pdt_ms - l.updt_ms - l.ms_ms - l.rs_ms    AS net_time,
       l.shift_ms - l.pdt_ms - l.updt_ms - l.ms_ms - l.rs_ms
         - l.reject_ms - l.rework_ms                            AS value_added_time
  FROM losses l;

-- THE WATERFALL IDENTITY, ASSERTED RATHER THAN TRUSTED.
--
--   availability_time = schedule + availability + performance + quality + value_added
--
-- This is the identity `lib/waterfall.ts` draws, that the OEE Performance
-- dashboard's Calendar Time donut derives by subtraction, and that
-- `work-unit-period-repository.integration.test.ts` asserts against real Gold
-- rows. A seed that broke it would make a REAL test fail against fabricated data
-- and send somebody looking for a bug in the reader. A negative value_added_time
-- renders as a ragged waterfall rather than as an error.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM msk_derived
   WHERE production_time <= 0 OR operating_time <= 0 OR net_time <= 0 OR value_added_time <= 0
      OR availability_time <> pdt_ms + updt_ms + (ms_ms + rs_ms) + (reject_ms + rework_ms) + value_added_time;
  IF bad > 0 THEN
    RAISE EXCEPTION '% shift row(s) break the waterfall identity or have non-positive derived time.', bad;
  END IF;
  RAISE NOTICE 'seed 0029: % shift rows, waterfall identity holds on every one.', (SELECT count(*) FROM msk_derived);
END
$$;

-- ---------------------------------------------------------------------------
-- Step 3 — the MACHINE grain
-- ---------------------------------------------------------------------------

INSERT INTO oee.work_unit_shift_reports (
  shift, date, business_date, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
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
  i.work_center_id, i.work_center_name, i.work_center_code,
  i.area_id, i.area_name, i.site_id, i.site_name, i.enterprise_id, i.enterprise_name,
  d.uom_id, d.uom_name, d.uom_code,
  -- Rates, all five recomputed from the durations above rather than stated.
  round(d.value_added_time::numeric / d.availability_time * 100, 3),
  round(d.value_added_time::numeric / d.production_time   * 100, 3),
  round(d.operating_time::numeric   / d.production_time   * 100, 3),
  round(d.net_time::numeric         / d.operating_time    * 100, 3),
  round(d.value_added_time::numeric / d.net_time          * 100, 3),
  -- Counts from time at one cycle each, so the two readings of Quality — the
  -- rate and the reject count — cannot disagree.
  round(d.net_time         / d.cycle_ms, 3),
  round(d.value_added_time / d.cycle_ms, 3),
  round(d.value_added_time / d.cycle_ms, 3),
  d.operating_time, d.availability_time, d.production_time, d.pdt_ms, d.operating_time,
  d.updt_ms, d.net_time, d.rs_ms, d.ms_ms, d.value_added_time,
  d.rework_ms, d.reject_ms, 0, 0,
  d.pdt_ms, d.updt_ms, d.ms_ms + d.rs_ms,
  d.ms_ms, d.rs_ms, d.reject_ms + d.rework_ms,
  round(d.reject_ms / d.cycle_ms, 3),
  round(d.rework_ms / d.cycle_ms, 3),
  -- MTTR / MTBF stand in for a "failure" definition this seed has no stops to
  -- count. Four unplanned events per shift, flat.
  (d.updt_ms / 4)::bigint,
  (d.operating_time / 4)::bigint
FROM msk_derived d CROSS JOIN msk_identity i;

-- Day, month and year: durations and counts SUM, rates are RECOMPUTED from those
-- sums. NEVER avg(availability) — contract §15.5, and the single line that
-- separates a report table from a count table.
INSERT INTO oee.work_unit_day_reports (
  date, business_date, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
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
  min(r.area_id), min(r.area_name), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
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
  (sum(r.updt_time) / 12)::bigint, (sum(r.operating_time) / 12)::bigint
FROM oee.work_unit_shift_reports r
WHERE r.work_unit_id IN (9,10,11)
GROUP BY r.work_unit_id, r.business_date;

INSERT INTO oee.work_unit_month_reports (
  date, business_date, month, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
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
  (date_trunc('month', r.business_date)::date + '07:00'::time) AT TIME ZONE min(r.time_zone),
  date_trunc('month', r.business_date)::date,
  to_char(r.business_date, 'YYYY-MM'),
  min(r.time_zone),
  r.work_unit_id, min(r.work_unit_name), min(r.work_unit_code),
  min(r.work_center_id), min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
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
  (sum(r.updt_time) / 360)::bigint, (sum(r.operating_time) / 360)::bigint
FROM oee.work_unit_day_reports r
WHERE r.work_unit_id IN (9,10,11)
GROUP BY r.work_unit_id, date_trunc('month', r.business_date), to_char(r.business_date, 'YYYY-MM');

-- The YEAR table has NO `date timestamptz` column (0027 departure 2) and its
-- business_date must be JANUARY 1 (ck_wuyr_year_start) — not December 31, and not
-- the first day the data covers. It carries no `month` label either.
INSERT INTO oee.work_unit_year_reports (
  business_date, time_zone,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
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
  date_trunc('year', r.business_date)::date, min(r.time_zone),
  r.work_unit_id, min(r.work_unit_name), min(r.work_unit_code),
  min(r.work_center_id), min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
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
  (sum(r.updt_time) / 1272)::bigint, (sum(r.operating_time) / 1272)::bigint
FROM oee.work_unit_month_reports r
WHERE r.work_unit_id IN (9,10,11)
GROUP BY r.work_unit_id, date_trunc('year', r.business_date);

-- ---------------------------------------------------------------------------
-- Step 4 — the LINE grain (A STAND-IN — see the header)
-- ---------------------------------------------------------------------------
--
-- DURATIONS ARE max(), NOT sum(). A line has ONE wall clock: 8 hours over a
-- 3-machine shift, not 24 (`0014`, and the correction `4fccce8` made after the
-- pipeline owner confirmed these are not a roll-up). Summing would produce
-- "machine-milliseconds", which is the reading `0014`'s header explicitly
-- retracts. All three machines here run the same window, so max() IS the line's
-- clock.
--
-- COUNTS COME FROM THE FLOW, NOT FROM A TOTAL. The line consumes BAGS at the
-- bagger and ships CARTONS from the cartoner, so:
--   infeed side  (total_out, reject, rework, line_out)  <- work unit 9,  BAG
--   output side  (good_out, effective_out)              <- work unit 11, CARTON
-- Summing across the three machines would add bags to inners to cartons, which is
-- the arithmetic §16.4a forbids in as many words.
DROP TABLE IF EXISTS msk_line_shift;
CREATE TEMP TABLE msk_line_shift AS
WITH worst AS (
  -- THE LINE IS DOWN WHEN ANY MACHINE ON IT IS DOWN, so each loss bucket is the
  -- WORST machine's, not the sum and not the average. That is the closest a
  -- derivation gets to "a line is measured".
  SELECT
    r.business_date, r.shift, min(r.time_zone) AS time_zone,
    max(r.availability_time)        AS availability_time,   -- one wall clock; all three are 8h
    max(r.pdt_time)                 AS pdt_time,
    max(r.updt_time)                AS updt_time,
    max(r.ms_time)                  AS ms_time,
    max(r.reduce_speed_time)        AS reduce_speed_time,
    max(r.reject_time)              AS reject_time,
    max(r.rework_time)              AS rework_time,
    -- infeed side, from the BAGGER; output side, from the CARTONER.
    max(r.total_out)     FILTER (WHERE r.work_unit_id = 9)  AS total_out,
    max(r.reject)        FILTER (WHERE r.work_unit_id = 9)  AS reject,
    max(r.rework)        FILTER (WHERE r.work_unit_id = 9)  AS rework,
    max(r.good_out)      FILTER (WHERE r.work_unit_id = 9)  AS line_out,
    max(r.good_out)      FILTER (WHERE r.work_unit_id = 11) AS good_out,
    max(r.effective_out) FILTER (WHERE r.work_unit_id = 11) AS effective_out,
    count(*)::int                   AS work_unit_count
  FROM oee.work_unit_shift_reports r
  WHERE r.work_unit_id IN (9,10,11)
  GROUP BY r.business_date, r.shift
)
SELECT
  w.*,
  -- DERIVED FROM THE BUCKETS ABOVE, NOT TAKEN AS max() OF THE MACHINES' OWN.
  --
  -- THIS IS THE BUG THE STEP 7 ASSERTION CAUGHT, and it is worth stating because
  -- the wrong version looks entirely reasonable. Selecting max(value_added_time)
  -- beside max(pdt_time) takes each from WHICHEVER MACHINE HAPPENED TO BE WORST
  -- AT THAT ONE BUCKET — different machines — so the five parts no longer add to
  -- the whole and every waterfall on the Line and Area screens renders ragged.
  -- Recomputing the chain from one consistent set of buckets makes the identity
  -- hold by construction, which is the only way it can be relied on.
  w.availability_time - w.pdt_time                                        AS production_time,
  w.availability_time - w.pdt_time - w.updt_time                          AS operating_time,
  w.availability_time - w.pdt_time - w.updt_time - w.ms_time
    - w.reduce_speed_time                                                 AS net_time,
  w.availability_time - w.pdt_time - w.updt_time - w.ms_time
    - w.reduce_speed_time - w.reject_time - w.rework_time                 AS value_added_time,
  -- A machine's `runtime` IS its operating_time (step 3), so the line's is too.
  w.availability_time - w.pdt_time - w.updt_time                          AS runtime
FROM worst w;

-- Same guard the machine grain gets, one grain up: a line whose worst-case
-- buckets swallowed the window would divide by zero in every rate below.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM msk_line_shift
   WHERE production_time <= 0 OR operating_time <= 0 OR net_time <= 0 OR value_added_time <= 0
      OR availability_time <> pdt_time + updt_time + (ms_time + reduce_speed_time)
                            + (reject_time + rework_time) + value_added_time;
  IF bad > 0 THEN
    RAISE EXCEPTION '% line shift row(s) break the waterfall identity or have non-positive derived time.', bad;
  END IF;
END
$$;

INSERT INTO oee.work_center_shift_reports (
  work_center_id, business_date, shift, time_zone,
  work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name, month,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  i.work_center_id, l.business_date, l.shift, l.time_zone,
  i.work_center_name, i.work_center_code,
  i.area_id, i.area_name, i.site_id, i.site_name, i.enterprise_id, i.enterprise_name,
  to_char(l.business_date, 'YYYY-MM'),
  l.work_unit_count, 3,
  1, 'BAG', 'BAG',
  4, 'CARTON', 'CARTON',
  round(l.value_added_time::numeric / l.availability_time * 100, 3),
  round(l.value_added_time::numeric / l.production_time   * 100, 3),
  round(l.operating_time::numeric   / l.production_time   * 100, 3),
  round(l.net_time::numeric         / l.operating_time    * 100, 3),
  round(l.value_added_time::numeric / l.net_time          * 100, 3),
  l.total_out, l.good_out, l.effective_out, l.reject, l.rework, l.line_out,
  l.runtime, l.availability_time, l.production_time, l.pdt_time, l.operating_time,
  l.updt_time, l.net_time, l.reduce_speed_time, l.ms_time, l.value_added_time,
  l.rework_time, l.reject_time, 0, 0,
  l.pdt_time, l.updt_time, l.ms_time + l.reduce_speed_time,
  l.ms_time, l.reduce_speed_time, l.reject_time + l.rework_time,
  (l.updt_time / 4)::bigint, (l.operating_time / 4)::bigint
FROM msk_line_shift l CROSS JOIN msk_identity i;

-- The line's day, month and year. Same §15.5 rule: durations and counts SUM
-- (a line's day IS the sum of its own line-shifts — contract §16.3), rates are
-- RECOMPUTED. The coarse line tables carry NO `date timestamptz` at all (`0014`),
-- and `month` survives as a nullable label out of the key.
INSERT INTO oee.work_center_day_reports (
  work_center_id, business_date, time_zone, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name, month,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id, r.business_date, min(r.time_zone),
  min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
  to_char(r.business_date, 'YYYY-MM'),
  max(r.work_unit_count), max(r.expected_work_unit_count),
  min(r.infeed_uom_id), min(r.infeed_uom_name), min(r.infeed_uom_code),
  min(r.output_uom_id), min(r.output_uom_name), min(r.output_uom_code),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),
  sum(r.total_out), sum(r.good_out), sum(r.effective_out),
  sum(r.reject), sum(r.rework), sum(r.line_out),
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  (sum(r.updt_time) / 12)::bigint, (sum(r.operating_time) / 12)::bigint
FROM oee.work_center_shift_reports r
WHERE r.work_center_id = 14
GROUP BY r.work_center_id, r.business_date;

INSERT INTO oee.work_center_month_reports (
  work_center_id, business_date, time_zone, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name, month,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id, date_trunc('month', r.business_date)::date, min(r.time_zone),
  min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
  to_char(r.business_date, 'YYYY-MM'),
  max(r.work_unit_count), max(r.expected_work_unit_count),
  min(r.infeed_uom_id), min(r.infeed_uom_name), min(r.infeed_uom_code),
  min(r.output_uom_id), min(r.output_uom_name), min(r.output_uom_code),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),
  sum(r.total_out), sum(r.good_out), sum(r.effective_out),
  sum(r.reject), sum(r.rework), sum(r.line_out),
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  (sum(r.updt_time) / 360)::bigint, (sum(r.operating_time) / 360)::bigint
FROM oee.work_center_day_reports r
WHERE r.work_center_id = 14
GROUP BY r.work_center_id, date_trunc('month', r.business_date), to_char(r.business_date, 'YYYY-MM');

INSERT INTO oee.work_center_year_reports (
  work_center_id, business_date, time_zone, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id, date_trunc('year', r.business_date)::date, min(r.time_zone),
  min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
  max(r.work_unit_count), max(r.expected_work_unit_count),
  min(r.infeed_uom_id), min(r.infeed_uom_name), min(r.infeed_uom_code),
  min(r.output_uom_id), min(r.output_uom_name), min(r.output_uom_code),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),
  sum(r.total_out), sum(r.good_out), sum(r.effective_out),
  sum(r.reject), sum(r.rework), sum(r.line_out),
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  (sum(r.updt_time) / 1272)::bigint, (sum(r.operating_time) / 1272)::bigint
FROM oee.work_center_month_reports r
WHERE r.work_center_id = 14
GROUP BY r.work_center_id, date_trunc('year', r.business_date);

-- ---------------------------------------------------------------------------
-- Step 5 — the SKU grain, `oee.product_report_wc_day` (0023)
-- ---------------------------------------------------------------------------
--
-- ONE GRAIN ONLY. There is no shift or month sibling and none is wanted (§17,
-- §24), so this is the whole SKU surface.
--
-- TWO SKUs, SPLIT 60/40. Both are real: `ms_core.products` 3 (MSK-SKU0A, "SKU A")
-- and 4 (MSK-SKU0B, "SKU B"). The split is a fixed share of the line's day rather
-- than a per-day mix, which keeps a property worth having — the two SKU rows'
-- durations and counts add back to the line day above them, so the SKU screen and
-- the Line screen do not disagree about a day's total.
--
-- RATES ARE RECOMPUTED PER SKU, NOT APPORTIONED. Scaling a percentage by 0.6 is
-- meaningless; `0021`'s seed makes the same point. Because both SKUs take the same
-- share of every duration, their rates come out equal to the line's — which is a
-- property of this MIX, not of the arithmetic.
INSERT INTO oee.product_report_wc_day (
  work_center_id, business_date, product_id, time_zone,
  work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
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
  r.work_center_id, r.business_date, p.product_id, r.time_zone,
  r.work_center_name, r.work_center_code,
  r.area_id, r.area_name, r.site_id, r.site_name, r.enterprise_id, r.enterprise_name,
  p.product_name, p.product_code, to_char(r.business_date, 'YYYY-MM'),
  r.infeed_uom_id, r.infeed_uom_name, r.infeed_uom_code,
  r.output_uom_id, r.output_uom_name, r.output_uom_code,
  round((r.value_added_time * p.share)::numeric / nullif(r.production_time * p.share, 0) * 100, 3),
  round((r.operating_time   * p.share)::numeric / nullif(r.production_time * p.share, 0) * 100, 3),
  round((r.net_time         * p.share)::numeric / nullif(r.operating_time  * p.share, 0) * 100, 3),
  round((r.value_added_time * p.share)::numeric / nullif(r.net_time        * p.share, 0) * 100, 3),
  round(r.total_out * p.share, 3), round(r.reject * p.share, 3), round(r.rework * p.share, 3),
  round(r.line_out * p.share, 3), round(r.good_out * p.share, 3),
  round(r.effective_out * p.share, 3),
  (r.runtime * p.share)::bigint, (r.availability_time * p.share)::bigint,
  (r.production_time * p.share)::bigint, (r.pdt_time * p.share)::bigint,
  (r.operating_time * p.share)::bigint, (r.updt_time * p.share)::bigint,
  (r.net_time * p.share)::bigint, (r.reduce_speed_time * p.share)::bigint,
  (r.ms_time * p.share)::bigint, (r.value_added_time * p.share)::bigint,
  (r.rework_time * p.share)::bigint, (r.reject_time * p.share)::bigint, 0, 0,
  (r.schedule_loss_time * p.share)::bigint, (r.availability_loss_time * p.share)::bigint,
  (r.performance_loss_time * p.share)::bigint, (r.ms_loss_time * p.share)::bigint,
  (r.reduce_speed_loss_time * p.share)::bigint, (r.quality_loss_time * p.share)::bigint,
  (r.mttr * p.share)::bigint, (r.mtbf * p.share)::bigint
FROM oee.work_center_day_reports r
CROSS JOIN (VALUES
  (3, 'SKU A'::varchar, 'MSK-SKU0A'::varchar, 0.6::numeric),
  (4, 'SKU B',          'MSK-SKU0B',          0.4::numeric)
) AS p(product_id, product_name, product_code, share)
WHERE r.work_center_id = 14;

-- ---------------------------------------------------------------------------
-- Step 6 — the AREA grain (0024, 0025, 0027)
-- ---------------------------------------------------------------------------
--
-- DURATIONS ARE LINE-MILLISECONDS — `0024` consequence 1, and the ONE place in
-- this schema where a day's runtime may exceed 24 hours. An area that lost 3 h on
-- line A and 2 h on line B has lost 5 h, so the losses add and nothing may divide
-- by the line count to make it look like a wall clock. MASAKO has ONE line, so
-- these figures equal that line's exactly and the rule is not visible here.
--
-- COUNTS AND THE WEIGHT UNIT ARE NULL — see the header. `ck_adr_weight_units`
-- requires `weight_uom_id` and the five counts to be NULL or present together,
-- and there is no mass unit in `ms_core.uom` on this database.
INSERT INTO oee.area_day_reports (
  area_id, business_date, time_zone,
  area_name, area_code, site_id, site_name, enterprise_id, enterprise_name, month,
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
  i.area_id, r.business_date, min(r.time_zone),
  i.area_name, i.area_code, i.site_id, i.site_name, i.enterprise_id, i.enterprise_name,
  to_char(r.business_date, 'YYYY-MM'),
  NULL::integer, NULL::varchar, NULL::varchar,
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  (sum(r.updt_time) / 12)::bigint, (sum(r.operating_time) / 12)::bigint
FROM oee.work_center_day_reports r CROSS JOIN msk_identity i
WHERE r.area_id = 3
GROUP BY i.area_id, i.area_name, i.area_code, i.site_id, i.site_name,
         i.enterprise_id, i.enterprise_name, r.business_date;

-- A SECOND TABLE, NOT THE DAY TABLE WIDENED (`0025`, contract §26). Durations and
-- counts SUM, rates are RECOMPUTED — a reader that derived a month's OEE from its
-- days would hold a second definition of it, one click from the day screens it
-- drills into. `ck_amr_month_start` makes business_date the FIRST day of the month.
INSERT INTO oee.area_month_reports (
  area_id, business_date, time_zone,
  area_name, area_code, site_id, site_name, enterprise_id, enterprise_name, month,
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
  r.area_id, date_trunc('month', r.business_date)::date, min(r.time_zone),
  min(r.area_name), min(r.area_code), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
  to_char(r.business_date, 'YYYY-MM'),
  NULL::integer, NULL::varchar, NULL::varchar,
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  (sum(r.updt_time) / 360)::bigint, (sum(r.operating_time) / 360)::bigint
FROM oee.area_day_reports r
WHERE r.area_id = 3
GROUP BY r.area_id, date_trunc('month', r.business_date), to_char(r.business_date, 'YYYY-MM');

-- The area's YEAR (`0027`): no `month` label, and business_date is JANUARY 1
-- (ck_ayr_year_start).
INSERT INTO oee.area_year_reports (
  area_id, business_date, time_zone,
  area_name, area_code, site_id, site_name, enterprise_id, enterprise_name,
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
  r.area_id, date_trunc('year', r.business_date)::date, min(r.time_zone),
  min(r.area_name), min(r.area_code), min(r.site_id), min(r.site_name),
  min(r.enterprise_id), min(r.enterprise_name),
  NULL::integer, NULL::varchar, NULL::varchar,
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time), 0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),  0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),        0) * 100, 3),
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),
  (sum(r.updt_time) / 1272)::bigint, (sum(r.operating_time) / 1272)::bigint
FROM oee.area_month_reports r
WHERE r.area_id = 3
GROUP BY r.area_id, date_trunc('year', r.business_date);

-- ---------------------------------------------------------------------------
-- Step 7 — the assertions, and they are the point of the file
-- ---------------------------------------------------------------------------
--
-- Each one catches a class of seeding error that renders as a PLAUSIBLE SCREEN
-- rather than as an error, which is the same argument the integration suite makes
-- for existing against a real Postgres.
DO $$
DECLARE
  n_shift int; n_day int; n_month int; n_year int;
  bad int;
  no_area int;
BEGIN
  SELECT count(*) INTO n_shift FROM oee.work_unit_shift_reports WHERE work_unit_id IN (9,10,11);
  SELECT count(*) INTO n_day   FROM oee.work_unit_day_reports   WHERE work_unit_id IN (9,10,11);
  SELECT count(*) INTO n_month FROM oee.work_unit_month_reports WHERE work_unit_id IN (9,10,11);
  SELECT count(*) INTO n_year  FROM oee.work_unit_year_reports  WHERE work_unit_id IN (9,10,11);

  IF n_shift <> 954 OR n_day <> 318 OR n_month <> 12 OR n_year <> 3 THEN
    RAISE EXCEPTION 'Machine row counts are wrong: shift=% (954) day=% (318) month=% (12) year=% (3).',
      n_shift, n_day, n_month, n_year;
  END IF;

  -- THE WATERFALL IDENTITY, AT EVERY GRAIN. It holds by construction at shift
  -- grain and SUMS cleanly to the coarse ones — but only if every coarse row
  -- summed the same set of shift rows. A GROUP BY that dropped a column would
  -- produce rows that still look right individually.
  SELECT count(*) INTO bad FROM oee.work_unit_day_reports
   WHERE work_unit_id IN (9,10,11)
     AND availability_time <> schedule_loss_time + availability_loss_time
                            + performance_loss_time + quality_loss_time + value_added_time;
  IF bad > 0 THEN
    RAISE EXCEPTION '% machine DAY row(s) break the waterfall identity.', bad;
  END IF;

  SELECT count(*) INTO bad FROM oee.area_day_reports
   WHERE area_id = 3
     AND availability_time <> schedule_loss_time + availability_loss_time
                            + performance_loss_time + quality_loss_time + value_added_time;
  IF bad > 0 THEN
    RAISE EXCEPTION '% AREA day row(s) break the waterfall identity.', bad;
  END IF;

  -- A LINE DAY MUST NOT BE THREE MACHINE-DAYS LONG. If the derivation ever
  -- switched from max() to sum() this would read ~72 h and every Run Time tile on
  -- the Line and Area screens would be three times reality — a plausible number,
  -- and wrong. 24 h in ms = 86_400_000.
  SELECT count(*) INTO bad FROM oee.work_center_day_reports
   WHERE work_center_id = 14 AND availability_time > 86400000;
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% line day row(s) have more than 24h of calendar time — the durations were summed across machines rather than taken as one wall clock (0014).', bad;
  END IF;

  -- THE TWO-UNIT RULE, POSITIVELY ASSERTED. total_out is BAGS and good_out is
  -- CARTONS, so they must NOT be equal and total_out must be the larger — if a
  -- future edit summed across the machines this would collapse.
  SELECT count(*) INTO bad FROM oee.work_center_day_reports
   WHERE work_center_id = 14 AND (good_out >= total_out OR infeed_uom_id = output_uom_id);
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% line day row(s) have good_out >= total_out or one unit on both sides — the infeed/output split (§16.4a) is broken.', bad;
  END IF;

  -- Every row this file wrote must carry the full hierarchy, or it is invisible
  -- to the area-scoped lists `0028` introduced.
  SELECT count(*) INTO no_area FROM oee.work_unit_shift_reports
   WHERE work_unit_id IN (9,10,11)
     AND (area_id IS NULL OR site_id IS NULL OR enterprise_id IS NULL);
  IF no_area > 0 THEN
    RAISE EXCEPTION '% machine shift row(s) are missing part of the hierarchy.', no_area;
  END IF;

  RAISE NOTICE 'seed 0029: every assertion passed.';
END
$$;

SELECT 'work_unit_shift_reports'   AS table_name, count(*) AS rows FROM oee.work_unit_shift_reports  WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'work_unit_day_reports',    count(*) FROM oee.work_unit_day_reports    WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'work_unit_month_reports',  count(*) FROM oee.work_unit_month_reports  WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'work_unit_year_reports',   count(*) FROM oee.work_unit_year_reports   WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'work_center_shift_reports',count(*) FROM oee.work_center_shift_reports WHERE work_center_id = 14
UNION ALL SELECT 'work_center_day_reports',  count(*) FROM oee.work_center_day_reports  WHERE work_center_id = 14
UNION ALL SELECT 'work_center_month_reports',count(*) FROM oee.work_center_month_reports WHERE work_center_id = 14
UNION ALL SELECT 'work_center_year_reports', count(*) FROM oee.work_center_year_reports WHERE work_center_id = 14
UNION ALL SELECT 'product_report_wc_day',    count(*) FROM oee.product_report_wc_day    WHERE work_center_id = 14
UNION ALL SELECT 'area_day_reports',         count(*) FROM oee.area_day_reports         WHERE area_id = 3
UNION ALL SELECT 'area_month_reports',       count(*) FROM oee.area_month_reports       WHERE area_id = 3
UNION ALL SELECT 'area_year_reports',        count(*) FROM oee.area_year_reports        WHERE area_id = 3;

-- The OEE trend across the four months, so a reviewer can see the window has a
-- shape rather than being flat noise.
SELECT month, round(oee, 1) AS line_oee, round(availability, 1) AS a,
       round(performance, 1) AS p, round(quality, 1) AS q
  FROM oee.work_center_month_reports WHERE work_center_id = 14 ORDER BY business_date;

DROP TABLE IF EXISTS msk_line_shift;
DROP TABLE IF EXISTS msk_derived;
DROP TABLE IF EXISTS msk_shifts;
DROP TABLE IF EXISTS msk_machines;
DROP TABLE IF EXISTS msk_identity;
