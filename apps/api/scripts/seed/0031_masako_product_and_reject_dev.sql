-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE. `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more, so psql prints the refusal and carries
-- straight on to the INSERT. 0015's header records that being observed against
-- the shared Gold database, where 18 rows landed after the guard fired.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration — see 0029's header.
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0031_masako_product_and_reject_dev.sql
--
-- RUN AFTER 0029. Reads its report rows and cannot run without them.
--
-- ---------------------------------------------------------------------------
-- WHAT IT IS — the three cards that were still empty
-- ---------------------------------------------------------------------------
--
--   oee.product_perf_wu_hour     Hourly Production Chart (machine), and the
--                                Performance Loss tab's TRENDLINE
--   oee.product_perf_wc_hour     the same two, at LINE grain           STAND-IN
--   oee.product_count_wu_shift   SKU View, machine, shift grain
--   oee.product_count_wu_day     SKU View, machine, day and month grain
--   oee.product_count_wc_shift   SKU View, line                        STAND-IN
--   oee.product_count_wc_day     SKU View, line                        STAND-IN
--   oee.reject_count_wu_shift    the Quality Loss Pareto, machine
--   oee.reject_count_wc_shift    the Quality Loss Pareto, line
--
-- ---------------------------------------------------------------------------
-- EVERYTHING IS DERIVED DOWNWARD FROM THE REPORT ROW, WHICH IS THE POINT
-- ---------------------------------------------------------------------------
--
-- 0014's rule, and the reason its header says hand-writing these independently is
-- "the obvious way to do this and the wrong way":
--
--   sum(hourly runtime)       ==  the report's `runtime`
--   sum(hourly total_out)     ==  the report's `total_out`   (same for good_out,
--                                 effective_out, reject, rework)
--   SKU View                  ==  rolled up FROM the hourly rows, so the chart
--                                 and the card cannot disagree
--   Quality Pareto bars       ==  the report's `reject`
--
-- A reviewer cannot tell a seeding artefact from a real bug in the code they are
-- reviewing, so the seed must not produce one. Step 7 asserts each of these on
-- every row rather than trusting the arithmetic.
--
-- ---------------------------------------------------------------------------
-- THE TRENDLINE IS AN IDEAL-VS-ACTUAL CHART, AND THE GAP HAS TO BE REAL
-- ---------------------------------------------------------------------------
--
-- "Performance Loss / Reduce Speed" plots `actual_rate_per_hour` against
-- `ideal_rate_per_hour`. A seed where actual == ideal draws two identical lines
-- and shows nothing; a seed where actual > ideal draws a machine outrunning its
-- own standard, which is a real state (`0014`'s note about a NEGATIVE reduce-speed
-- loss) but not the one this chart exists to explain.
--
-- IT COMES OUT RIGHT BY CONSTRUCTION HERE, and that is worth stating because it
-- looks like luck. `runtime` sums to `operating_time`, while `total_out` is
-- derived from `net_time` — and `net_time = operating_time - ms - rs`. So
--
--     actual = total_out / (runtime/h) = (net_time/cycle) / (operating_time/h)
--     ideal  = 1/cycle per hour
--     actual/ideal = net_time / operating_time  <  1
--
-- and the shortfall IS exactly the small-stop plus reduce-speed loss the tab is
-- named after. Nothing is scaled to make the picture look right.
--
-- `ideal_rate_per_hour` IS ON THE OUTPUT SIDE at line grain (`0018`, contract
-- §19): performance is `effective_out / ideal_out`, so an infeed-side standard
-- would divide cartons by bags and produce a number between 0 and 1 that looks
-- exactly like a percentage.
--
-- ---------------------------------------------------------------------------
-- WHAT IS A STAND-IN, LOUDLY
-- ---------------------------------------------------------------------------
--
-- `product_perf_wc_hour` and `product_count_wc_{shift,day}` are MACHINE-SUMS, and
-- that is the WRONG NUMBER BY CONSTRUCTION. §17.1 and §19.1 ask the pipeline
-- owner in capitals not to roll these up, because A LINE IS MEASURED, NOT SUMMED
-- — it has its own count points, so a machine-summed curve would not integrate to
-- the line's own totals in the card above the chart.
--
-- 0016's seed sets the terms this file follows exactly:
--
--   IT IS A STAND-IN. IT IS *NOT* THE SPECIFICATION.
--
-- It exists because an unreachable screen cannot be reviewed. Do not read it as a
-- reference implementation, do not hand it to the pipeline owner, and do not use
-- it to check the pipeline's output when it arrives — the two SHOULD disagree, by
-- an unknown amount.
--
-- ---------------------------------------------------------------------------
-- THE REJECT REASON NAMES ARE GOLD-ONLY, the same call 0030 made
-- ---------------------------------------------------------------------------
--
-- `ms_reject` scopes two reasons to work center 14 (`MSK-QE01`, `MSK-QE02`, both
-- named "EXAMPLE n"). Two bars is not a Pareto. So the rows carry richer names
-- that exist only in Gold, with both real ones included so the entry dialog's
-- picker has a match. Same trade, same cost, same reason it is not fixed here:
-- `ms_reject` is owned by the mes-master-data repo.
--
-- ONE THING THE QUALITY PARETO DOES *NOT* PROMISE. Contract's Open Risks says
-- "nobody knows how far the ranked rejects and the `reject` tile will diverge",
-- and the screen footnotes that they will not match. They DO match here, exactly,
-- because a dev screen that disagrees with itself cannot be reviewed — but that
-- is a property of this seed, NOT a guarantee about production. The footnote is
-- still telling the truth about real data.
--
-- RE-RUNNABLE: deletes this area's rows first, scoped to work units 9/10/11 and
-- work center 14.
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

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM oee.work_unit_shift_reports WHERE work_unit_id IN (9,10,11);
  IF n = 0 THEN
    RAISE EXCEPTION 'No MASAKO machine shift reports. Run 0029_masako_reports_dev.sql first.';
  END IF;
  RAISE NOTICE 'seed 0031: deriving hourly, SKU and reject rows from % machine shift reports.', n;
END
$$;

DELETE FROM oee.product_perf_wu_hour   WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.product_perf_wc_hour   WHERE work_center_id = 14;
DELETE FROM oee.product_count_wu_shift WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.product_count_wu_day   WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.product_count_wc_shift WHERE work_center_id = 14;
DELETE FROM oee.product_count_wc_day   WHERE work_center_id = 14;
DELETE FROM oee.reject_count_wu_shift  WHERE work_unit_id IN (9,10,11);
DELETE FROM oee.reject_count_wc_shift  WHERE work_center_id = 14;

-- ---------------------------------------------------------------------------
-- Step 1 — eight hourly buckets per machine-shift
-- ---------------------------------------------------------------------------
--
-- ONE PRODUCT PER BUCKET, NOT A SPLIT. A machine runs one SKU at a time, so the
-- shift changes over from SKU A to SKU B partway through rather than making both
-- at once. That is also what gives the Hourly Production Chart a visible
-- changeover and SKU View two rows that add to the shift.
--
-- `ck_ppwuh_runtime` caps a bucket at one hour (3_600_000 ms) and the report's
-- `runtime` is `operating_time` — at most ~24M ms over 8 buckets, so ~3.0M each.
-- The LAST bucket takes the remainder, so integer division cannot leave the
-- hourly chart short of the card above it.
DROP TABLE IF EXISTS msk_hours;
CREATE TEMP TABLE msk_hours AS
WITH base AS (
  SELECT r.*,
         (extract(doy from r.business_date)::int * 7 + r.shift * 13 + r.work_unit_id * 31) AS v
    FROM oee.work_unit_shift_reports r
   WHERE r.work_unit_id IN (9,10,11)
),
weighted AS (
  SELECT b.*,
         g.seq,
         CASE WHEN g.seq < 4 + (b.v % 3) THEN 3 ELSE 4 END                     AS product_id,
         CASE WHEN g.seq < 4 + (b.v % 3) THEN 'SKU A' ELSE 'SKU B' END         AS product_name,
         CASE WHEN g.seq < 4 + (b.v % 3) THEN 'MSK-SKU0A' ELSE 'MSK-SKU0B' END AS product_code,
         b.date + (g.seq * interval '1 hour')                                  AS bucket_start,
         b.date + ((g.seq + 1) * interval '1 hour')                            AS bucket_end,
         -- TWO INDEPENDENT WEIGHTS, AND THE ASYMMETRY BETWEEN THEM IS THE WHOLE
         -- REASON THE CHARTS HAVE ANYTHING TO SHOW.
         --
         -- An even split across eight buckets makes `actual_rate_per_hour`
         -- IDENTICAL in every bucket, because it is `total_out / runtime` and
         -- both were divided by the same 8. The Hourly Production Chart then
         -- draws a flat line and the Reduce Speed trendline draws two parallel
         -- flat lines — which is exactly the picture those cards exist to rule
         -- out. This was the first version and it had to be replaced.
         --
         -- RUNTIME BARELY VARIES, AND IT CANNOT. `ck_ppwuh_runtime` caps a bucket
         -- at ONE HOUR, and a shift's operating_time reaches ~458 min over 8
         -- buckets — 57 of every 60 minutes. There is under 5% headroom, so the
         -- runtime weight is deliberately narrow (98..102). That is the physics,
         -- not a limitation of the seed: the machine really is running almost the
         -- whole hour.
         98 + ((b.v * 7 + g.seq * 13) % 5)                                      AS rw,
         -- THE COUNT weight is where the variation lives (80..110), so the actual
         -- rate moves hour to hour against a flat standard. Centred slightly
         -- BELOW 100 so the mean stays under the ideal while individual hours can
         -- exceed it — a machine outrunning its standard for an hour is a real
         -- state, and `0014` notes a NEGATIVE reduce-speed loss is legitimate and
         -- must not be Math.abs()'d away.
         80 + ((b.v * 11 + g.seq * 17) % 31)                                    AS cw
    FROM base b CROSS JOIN generate_series(0, 7) AS g(seq)
),
shares AS (
  SELECT w.*,
         sum(w.rw) OVER (PARTITION BY w.id) AS sum_rw,
         sum(w.cw) OVER (PARTITION BY w.id) AS sum_cw
    FROM weighted w
),
raw AS (
  SELECT s.*,
         -- FLOOR, never round, on every bucket but the last. Each share then
         -- lands at or below its exact value, so the remainder the last bucket
         -- takes is guaranteed NON-NEGATIVE — `ck_ppwuh_nonneg` rejects the
         -- alternative, and a negative count would render as a downward spike.
         floor(s.runtime::numeric * s.rw / s.sum_rw)::bigint                AS r_raw,
         floor(s.total_out     * s.cw / s.sum_cw * 1000) / 1000            AS t_raw,
         floor(s.good_out      * s.cw / s.sum_cw * 1000) / 1000            AS g_raw,
         floor(s.effective_out * s.cw / s.sum_cw * 1000) / 1000            AS e_raw,
         floor(s.reject        * s.cw / s.sum_cw * 1000) / 1000            AS j_raw,
         floor(s.rework        * s.cw / s.sum_cw * 1000) / 1000            AS k_raw
    FROM shares s
)
SELECT r.*,
       -- The last bucket closes each total exactly, so the hourly chart cannot
       -- come out short of the card above it.
       CASE WHEN r.seq = 7 THEN r.runtime - coalesce(sum(r.r_raw) OVER w, 0) ELSE r.r_raw END AS b_runtime,
       CASE WHEN r.seq = 7 THEN r.total_out     - coalesce(sum(r.t_raw) OVER w, 0) ELSE r.t_raw END AS b_total_out,
       CASE WHEN r.seq = 7 THEN r.good_out      - coalesce(sum(r.g_raw) OVER w, 0) ELSE r.g_raw END AS b_good_out,
       CASE WHEN r.seq = 7 THEN r.effective_out - coalesce(sum(r.e_raw) OVER w, 0) ELSE r.e_raw END AS b_effective_out,
       CASE WHEN r.seq = 7 THEN r.reject        - coalesce(sum(r.j_raw) OVER w, 0) ELSE r.j_raw END AS b_reject,
       CASE WHEN r.seq = 7 THEN r.rework        - coalesce(sum(r.k_raw) OVER w, 0) ELSE r.k_raw END AS b_rework
  FROM raw r
WINDOW w AS (PARTITION BY r.id ORDER BY r.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING);

-- The cap is tight enough to be worth asserting rather than assuming.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM msk_hours
   WHERE b_runtime < 0 OR b_runtime > 3600000
      OR b_total_out < 0 OR b_good_out < 0 OR b_reject < 0 OR b_rework < 0;
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% hourly bucket(s) break ck_ppwuh_runtime (0..1h) or ck_ppwuh_nonneg — widen the runtime weight at your peril, there is under 5%% headroom.', bad;
  END IF;
END
$$;

INSERT INTO oee.product_perf_wu_hour (
  bucket_start, bucket_end, work_unit_id, product_id, business_date, shift,
  hour_of_day, shift_hour_seq, time_zone,
  work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  product_name, product_code,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, effective_out, reject, rework, runtime,
  ideal_rate_per_hour, ideal_rate_source, loaded_at
)
SELECT
  h.bucket_start, h.bucket_end, h.work_unit_id, h.product_id, h.business_date, h.shift,
  extract(hour from (h.bucket_start AT TIME ZONE h.time_zone))::int,
  h.seq, h.time_zone,
  h.work_unit_name, h.work_unit_code, h.work_center_id, h.work_center_name, h.work_center_code,
  h.area_id, h.area_name, h.site_id, h.site_name, h.enterprise_id, h.enterprise_name,
  h.product_name, h.product_code,
  h.uom_id, h.uom_name, h.uom_code,
  -- The BASE unit is BAG for every machine: `ms_core.product_packages` gives
  -- product 3 the factors BAG 1 / INNER 10 / CARTON 100, so a machine's own unit
  -- converts to bags by its factor.
  1, 'BAG', 'BAG',
  CASE h.work_unit_id WHEN 9 THEN 1 WHEN 10 THEN 10 ELSE 100 END,
  h.b_total_out, h.b_good_out, h.b_effective_out, h.b_reject, h.b_rework, h.b_runtime,
  -- The machine's standard IN ITS OWN UNIT: 14400 base units/h divided by the
  -- factor. See 0029's header — taking 14400 literally for all three would have a
  -- cartoner out-producing the bagger feeding it.
  (14400::numeric / CASE h.work_unit_id WHEN 9 THEN 1 WHEN 10 THEN 10 ELSE 100 END),
  'master-data',
  -- `actual_rate_per_hour` AND `ideal_out` ARE NOT WRITTEN HERE. Both are
  -- GENERATED columns, so the conversion is the DATABASE's and not a reader's —
  -- the same rule `0017`'s `target_qty` follows. The actual rate lands BELOW
  -- ideal by exactly the ms+rs loss, and it does so because `runtime` sums to
  -- `operating_time` while `total_out` comes from `net_time`; see the header.
  now()
FROM msk_hours h;

-- ---------------------------------------------------------------------------
-- Step 2 — the LINE's hourly rows (STAND-IN — a machine-sum)
-- ---------------------------------------------------------------------------
--
-- Infeed from the bagger, output from the cartoner, exactly as 0029 builds the
-- line report — so the chart and the card above it are at least denominated the
-- same way. `runtime` is the LINE's wall clock (max, never sum), for 0014's
-- reason. `ideal_rate_per_hour` is OUTPUT-side: 144 cartons/h.
INSERT INTO oee.product_perf_wc_hour (
  bucket_start, bucket_end, work_center_id, product_id, business_date, shift,
  hour_of_day, shift_hour_seq, time_zone,
  work_center_name, work_center_code, area_id, area_name, site_id, site_name,
  enterprise_id, enterprise_name, product_name, product_code,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  infeed_base_uom_id, infeed_base_uom_code, infeed_factor_to_base,
  output_uom_id, output_uom_name, output_uom_code,
  output_base_uom_id, output_base_uom_code, output_factor_to_base,
  total_out, reject, rework, good_out, effective_out, runtime,
  ideal_rate_per_hour, ideal_rate_source, loaded_at
)
SELECT
  h.bucket_start, h.bucket_end, 14, h.product_id, h.business_date, h.shift,
  min(h.hour_of_day), min(h.shift_hour_seq), min(h.time_zone),
  min(h.work_center_name), min(h.work_center_code),
  min(h.area_id), min(h.area_name), min(h.site_id), min(h.site_name),
  min(h.enterprise_id), min(h.enterprise_name), min(h.product_name), min(h.product_code),
  1, 'BAG', 'BAG', 1, 'BAG', 1,
  4, 'CARTON', 'CARTON', 1, 'BAG', 100,
  max(h.total_out)     FILTER (WHERE h.work_unit_id = 9),
  max(h.reject)        FILTER (WHERE h.work_unit_id = 9),
  max(h.rework)        FILTER (WHERE h.work_unit_id = 9),
  max(h.good_out)      FILTER (WHERE h.work_unit_id = 11),
  max(h.effective_out) FILTER (WHERE h.work_unit_id = 11),
  -- ONE wall clock, not three added together.
  max(h.runtime),
  -- OUTPUT-side standard: 144 cartons/h. An infeed-side one would divide cartons
  -- by bags and produce a number between 0 and 1 that looks exactly like a
  -- percentage (contract §19). `actual_rate_per_hour` is GENERATED from
  -- `effective_out`, which is why the output side has to be the one that is right.
  144, 'master-data',
  now()
FROM oee.product_perf_wu_hour h
WHERE h.work_unit_id IN (9,10,11)
GROUP BY h.bucket_start, h.bucket_end, h.product_id, h.business_date, h.shift;

-- ---------------------------------------------------------------------------
-- Step 3 — SKU View, ROLLED UP FROM THE HOURLY ROWS
-- ---------------------------------------------------------------------------
--
-- Rolled up rather than generated, which is what makes the Hourly Production
-- Chart and the SKU View card below it provably agree: they are the same numbers
-- read at two resolutions. Generating them side by side is the mistake 0014's
-- header names.
INSERT INTO oee.product_count_wu_shift (
  shift, shift_date, product_id, product_name, product_code,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT h.shift, h.business_date, h.product_id, min(h.product_name), min(h.product_code),
       h.work_unit_id, min(h.work_unit_name), min(h.work_unit_code),
       min(h.work_center_id), min(h.work_center_name), min(h.work_center_code),
       min(h.area_id), min(h.area_name), min(h.site_id), min(h.site_name),
       min(h.enterprise_id), min(h.enterprise_name),
       min(h.uom_id), min(h.uom_name), min(h.uom_code),
       min(h.base_uom_id), min(h.base_uom_name), min(h.base_uom_code), min(h.factor_to_base),
       sum(h.total_out), sum(h.good_out), sum(h.reject), sum(h.rework)
  FROM oee.product_perf_wu_hour h
 WHERE h.work_unit_id IN (9,10,11)
 GROUP BY h.work_unit_id, h.business_date, h.shift, h.product_id;

INSERT INTO oee.product_count_wu_day (
  date, product_id, product_name, product_code,
  work_unit_id, work_unit_name, work_unit_code,
  work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT p.shift_date, p.product_id, min(p.product_name), min(p.product_code),
       p.work_unit_id, min(p.work_unit_name), min(p.work_unit_code),
       min(p.work_center_id), min(p.work_center_name), min(p.work_center_code),
       min(p.area_id), min(p.area_name), min(p.site_id), min(p.site_name),
       min(p.enterprise_id), min(p.enterprise_name),
       min(p.uom_id), min(p.uom_name), min(p.uom_code),
       min(p.base_uom_id), min(p.base_uom_name), min(p.base_uom_code), min(p.factor_to_base),
       sum(p.total_out), sum(p.good_out), sum(p.reject), sum(p.rework)
  FROM oee.product_count_wu_shift p
 WHERE p.work_unit_id IN (9,10,11)
 GROUP BY p.work_unit_id, p.shift_date, p.product_id;

-- The LINE's SKU View. STAND-IN — a machine-sum, the wrong number by
-- construction (§17.1). Counts the BAGGER's infeed so at least the unit is the
-- line's own infeed unit rather than three units added together.
INSERT INTO oee.product_count_wc_shift (
  work_center_id, business_date, shift, time_zone, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  product_id, product_name, product_code,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT 14, p.shift_date, p.shift, 'Asia/Jakarta',
       min(p.work_center_name), min(p.work_center_code),
       min(p.area_id), min(p.area_name), min(p.site_id), min(p.site_name),
       min(p.enterprise_id), min(p.enterprise_name),
       p.product_id, min(p.product_name), min(p.product_code),
       1, 'BAG', 'BAG', 1, 'BAG', 'BAG', 1,
       sum(p.total_out) FILTER (WHERE p.work_unit_id = 9),
       sum(p.good_out)  FILTER (WHERE p.work_unit_id = 9),
       sum(p.reject)    FILTER (WHERE p.work_unit_id = 9),
       sum(p.rework)    FILTER (WHERE p.work_unit_id = 9)
  FROM oee.product_count_wu_shift p
 WHERE p.work_unit_id IN (9,10,11)
 GROUP BY p.shift_date, p.shift, p.product_id;

INSERT INTO oee.product_count_wc_day (
  work_center_id, business_date, time_zone, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  product_id, product_name, product_code,
  uom_id, uom_name, uom_code, base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  total_out, good_out, reject, rework
)
SELECT 14, p.business_date, min(p.time_zone), min(p.work_center_name), min(p.work_center_code),
       min(p.area_id), min(p.area_name), min(p.site_id), min(p.site_name),
       min(p.enterprise_id), min(p.enterprise_name),
       p.product_id, min(p.product_name), min(p.product_code),
       1, 'BAG', 'BAG', 1, 'BAG', 'BAG', 1,
       sum(p.total_out), sum(p.good_out), sum(p.reject), sum(p.rework)
  FROM oee.product_count_wc_shift p
 WHERE p.work_center_id = 14
 GROUP BY p.business_date, p.product_id;

-- ---------------------------------------------------------------------------
-- Step 4 — the Quality Loss Pareto's rows
-- ---------------------------------------------------------------------------
--
-- Split each (machine, shift, product)'s reject count across a few reasons by
-- weight, LAST ONE TAKING THE REMAINDER — the same exactness 0030 needs for the
-- downtime Paretos, and for the same reason: a bar chart that does not add to the
-- figure above it is a screen quietly lying.
--
-- Rows are emitted only where there IS a reject. A zero-count row is legal
-- (`ck_rcwus_freq_agrees` permits counter_value = 0 with frequency = 0) and would
-- put an empty bar on every Pareto.
DROP TABLE IF EXISTS msk_reject_reasons;
CREATE TEMP TABLE msk_reject_reasons AS
SELECT * FROM (VALUES
  (0, 'Seal Leak'::text,        34::numeric),
  (1, 'Underweight',            26),
  (2, 'Print Defect',           18),
  (3, 'Foreign Material',       12),
  (4, 'EXAMPLE 1',               6),   -- MSK-QE01, the real catalogue one
  (5, 'EXAMPLE 2',               4)    -- MSK-QE02
) AS r(ord, reason, weight);

DROP TABLE IF EXISTS msk_rejects;
CREATE TEMP TABLE msk_rejects AS
WITH src AS (
  SELECT p.*, (extract(doy from p.shift_date)::int * 7 + p.shift * 13
               + p.work_unit_id * 31 + p.product_id * 17) AS v
    FROM oee.product_count_wu_shift p
   WHERE p.work_unit_id IN (9,10,11) AND p.reject > 0
),
picked AS (
  SELECT s.*, c.reason, c.weight,
         row_number() OVER (PARTITION BY s.work_unit_id, s.shift_date, s.shift, s.product_id ORDER BY c.rot) AS i,
         count(*)     OVER (PARTITION BY s.work_unit_id, s.shift_date, s.shift, s.product_id) AS n,
         sum(c.weight) OVER (PARTITION BY s.work_unit_id, s.shift_date, s.shift, s.product_id) AS sum_w
    FROM src s
    CROSS JOIN LATERAL (
      SELECT rr.reason, rr.weight, ((rr.ord + s.v) % 6) AS rot
        FROM msk_reject_reasons rr ORDER BY rot LIMIT 2 + (s.v % 3)
    ) c
),
raw AS (SELECT p.*, floor(p.reject * p.weight / p.sum_w)::numeric AS raw_qty FROM picked p)
SELECT r.*,
       CASE WHEN r.i = r.n
            THEN r.reject - coalesce(sum(r.raw_qty) OVER (PARTITION BY r.work_unit_id, r.shift_date, r.shift, r.product_id
                                                          ORDER BY r.i ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
            ELSE r.raw_qty
       END AS qty
  FROM raw r;

INSERT INTO oee.reject_count_wu_shift (
  work_unit_id, shift_date, shift, product_id, reason,
  work_unit_name, work_unit_code, work_center_id, work_center_name, work_center_code,
  area_id, area_name, site_id, site_name, enterprise_id, enterprise_name,
  product_name, product_code, reason_code,
  uom_id, uom_name, uom_code, counter_value,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  frequency, time_zone
)
SELECT r.work_unit_id, r.shift_date, r.shift, r.product_id, r.reason,
       r.work_unit_name, r.work_unit_code, r.work_center_id, r.work_center_name, r.work_center_code,
       r.area_id, r.area_name, r.site_id, r.site_name, r.enterprise_id, r.enterprise_name,
       r.product_name, r.product_code,
       upper(regexp_replace(r.reason, '[^a-zA-Z0-9]+', '-', 'g')),
       r.uom_id, r.uom_name, r.uom_code, r.qty,
       r.base_uom_id, r.base_uom_name, r.base_uom_code, r.factor_to_base,
       -- `converted_value` IS NOT WRITTEN: it is a GENERATED column,
       -- `counter_value * factor_to_base`, so the conversion is the database's
       -- and not a reader's. The integration suite exists partly to stop a reader
       -- reporting the raw counter twice.
       -- `ck_rcwus_freq_agrees`: a non-zero count must carry a non-zero frequency.
       greatest(1, ceil(r.qty / 40)::int),
       'Asia/Jakarta'
  FROM msk_rejects r
 WHERE r.qty > 0;

-- The LINE's rejects (`0019`). A fourth table and NOT a machine-sum in
-- production — the line has its own count point, which is the whole reason the
-- table exists (contract §20). Here it is the bagger's, for the same stand-in
-- reason as everything else at this grain.
INSERT INTO oee.reject_count_wc_shift (
  work_center_id, business_date, shift, product_id, reason,
  work_center_name, work_center_code, area_id, area_name,
  site_id, site_name, enterprise_id, enterprise_name,
  product_name, product_code, reason_code,
  uom_id, uom_name, uom_code, counter_value,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  frequency, time_zone
)
SELECT 14, r.shift_date, r.shift, r.product_id, r.reason,
       min(r.work_center_name), min(r.work_center_code), min(r.area_id), min(r.area_name),
       min(r.site_id), min(r.site_name), min(r.enterprise_id), min(r.enterprise_name),
       min(r.product_name), min(r.product_code),
       upper(regexp_replace(r.reason, '[^a-zA-Z0-9]+', '-', 'g')),
       1, 'BAG', 'BAG', sum(r.counter_value),
       1, 'BAG', 'BAG', 1,
       sum(r.frequency)::int, 'Asia/Jakarta'
  FROM oee.reject_count_wu_shift r
 WHERE r.work_unit_id = 9
 GROUP BY r.shift_date, r.shift, r.product_id, r.reason;

-- ---------------------------------------------------------------------------
-- Step 5 — the assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE bad int; n int; slow int;
BEGIN
  -- THE HOURLY CHART SUMS TO THE CARD ABOVE IT — runtime and every count.
  SELECT count(*) INTO bad FROM (
    SELECT r.id, r.runtime, r.total_out, r.good_out, r.reject, r.rework,
           sum(h.runtime) AS h_runtime, sum(h.total_out) AS h_total,
           sum(h.good_out) AS h_good, sum(h.reject) AS h_reject, sum(h.rework) AS h_rework
      FROM oee.work_unit_shift_reports r
      JOIN oee.product_perf_wu_hour h
        ON h.work_unit_id = r.work_unit_id AND h.business_date = r.business_date AND h.shift = r.shift
     WHERE r.work_unit_id IN (9,10,11)
     GROUP BY r.id, r.runtime, r.total_out, r.good_out, r.reject, r.rework
  ) x
   WHERE x.h_runtime <> x.runtime OR x.h_total <> x.total_out OR x.h_good <> x.good_out
      OR x.h_reject <> x.reject OR x.h_rework <> x.rework;
  IF bad > 0 THEN
    RAISE EXCEPTION '% machine-shift(s) have hourly rows that do not sum to the report.', bad;
  END IF;

  -- SKU VIEW SUMS TO THE CARD, at shift and at day grain.
  SELECT count(*) INTO bad FROM (
    SELECT r.id, r.total_out, sum(p.total_out) AS p_total
      FROM oee.work_unit_shift_reports r
      JOIN oee.product_count_wu_shift p
        ON p.work_unit_id = r.work_unit_id AND p.shift_date = r.business_date AND p.shift = r.shift
     WHERE r.work_unit_id IN (9,10,11)
     GROUP BY r.id, r.total_out
  ) x WHERE x.p_total <> x.total_out;
  IF bad > 0 THEN
    RAISE EXCEPTION '% machine-shift(s) have SKU View totals that do not sum to the report.', bad;
  END IF;

  -- THE QUALITY PARETO SUMS TO THE REPORT'S `reject`, per machine-shift.
  SELECT count(*) INTO bad FROM (
    SELECT r.id, r.reject, coalesce(sum(q.counter_value), 0) AS q_reject
      FROM oee.work_unit_shift_reports r
      LEFT JOIN oee.reject_count_wu_shift q
        ON q.work_unit_id = r.work_unit_id AND q.shift_date = r.business_date AND q.shift = r.shift
     WHERE r.work_unit_id IN (9,10,11)
     GROUP BY r.id, r.reject
  ) x WHERE x.q_reject <> x.reject;
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% machine-shift(s) have Quality Pareto bars that do not sum to the report''s reject figure.', bad;
  END IF;

  -- THE TRENDLINE HAS A GAP TO SHOW. If actual >= ideal everywhere, the Reduce
  -- Speed chart draws two identical lines and demonstrates nothing.
  SELECT count(*) INTO slow FROM oee.product_perf_wu_hour
   WHERE work_unit_id IN (9,10,11) AND runtime > 0
     AND actual_rate_per_hour < ideal_rate_per_hour;
  SELECT count(*) INTO n FROM oee.product_perf_wu_hour WHERE work_unit_id IN (9,10,11);
  IF slow < n / 2 THEN
    RAISE EXCEPTION
      'Only % of % hourly buckets run below the ideal rate — the Performance Loss trendline would have no gap to explain.', slow, n;
  END IF;

  RAISE NOTICE 'seed 0031: hourly, SKU View and the Quality Pareto all sum to their reports; % of % buckets run below standard.', slow, n;
END
$$;

SELECT 'product_perf_wu_hour'   AS table_name, count(*) AS rows FROM oee.product_perf_wu_hour   WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'product_perf_wc_hour',   count(*) FROM oee.product_perf_wc_hour   WHERE work_center_id = 14
UNION ALL SELECT 'product_count_wu_shift', count(*) FROM oee.product_count_wu_shift WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'product_count_wu_day',   count(*) FROM oee.product_count_wu_day   WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'product_count_wc_shift', count(*) FROM oee.product_count_wc_shift WHERE work_center_id = 14
UNION ALL SELECT 'product_count_wc_day',   count(*) FROM oee.product_count_wc_day   WHERE work_center_id = 14
UNION ALL SELECT 'reject_count_wu_shift',  count(*) FROM oee.reject_count_wu_shift  WHERE work_unit_id IN (9,10,11)
UNION ALL SELECT 'reject_count_wc_shift',  count(*) FROM oee.reject_count_wc_shift  WHERE work_center_id = 14;

-- What the Quality Loss Pareto will draw for the whole window.
SELECT reason, count(*) AS rows, sum(counter_value)::numeric(14,0) AS rejects,
       round(100.0 * sum(counter_value) / sum(sum(counter_value)) OVER (), 1) AS pct
  FROM oee.reject_count_wu_shift WHERE work_unit_id IN (9,10,11)
 GROUP BY reason ORDER BY sum(counter_value) DESC;

-- And the shape of the Reduce Speed gap.
SELECT work_unit_name, uom_code,
       round(avg(ideal_rate_per_hour), 0)  AS ideal_per_h,
       round(avg(actual_rate_per_hour), 0) AS actual_per_h,
       round(100 * avg(actual_rate_per_hour) / avg(ideal_rate_per_hour), 1) AS pct_of_standard
  FROM oee.product_perf_wu_hour WHERE work_unit_id IN (9,10,11) AND runtime > 0
 GROUP BY work_unit_name, uom_code ORDER BY work_unit_name;

DROP TABLE IF EXISTS msk_rejects;
DROP TABLE IF EXISTS msk_reject_reasons;
DROP TABLE IF EXISTS msk_hours;
