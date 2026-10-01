-- ---------------------------------------------------------------------------
-- 0025 — the AREA grain's second half: one report per (area, month)
-- ---------------------------------------------------------------------------
--
-- One table, `oee.area_month_reports`. It backs the `Report > Area > By Monthly`
-- screens and it is contract §26's ask. It ships EMPTY.
--
-- `0024` IS THE FILE TO READ FIRST. Everything that makes an area's numbers
-- different from a line's is argued there and is unchanged here:
--
--   * A LINE IS MEASURED. AN AREA IS COMPOSED. An area has no count point and no
--     clock; every figure is a composition of its member lines'.
--   * THE DURATIONS ARE LINE-MILLISECONDS. A five-line area's `availability_time`
--     over a 30-day month is ~3,600 hours, not ~720. Do not divide by the line
--     count.
--   * THE COUNTS ARE A MASS, in ONE unit, because the members have many.
--   * `total_out = good_out + reject + rework` IS NOT ASSERTED.
--
-- This file is `0024` PLUS ONE CHECK, which is exactly the relationship `0014`
-- states between `oee.work_center_day_reports` and its month sibling. Read the
-- two sections below and then read `0024`.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND TABLE AND NOT THE DAY TABLE WIDENED
-- ---------------------------------------------------------------------------
--
-- This is the question `0016` answered the OTHER way — it created two
-- product-count tables rather than three, "because a day table serves month by
-- widening, which `listPeriodProductCount` already proves". That reasoning is
-- right for a COUNT table and wrong for a REPORT table, and the difference is the
-- whole of §15.5:
--
--     durations and counts   ->  SUM        widening a day range gives this
--     rates (oee, a, p, q)   ->  RECOMPUTE  widening a day range does NOT
--
-- A month's OEE is not the average of its days' OEEs, and it is not derivable
-- from the day rows without redoing the recompute in the reader — which is the
-- second-definition-of-OEE problem `0023` and `0024` both exist to prevent, here
-- between an area's month screen and its own day screens one click apart. Only a
-- row the pipeline composed can carry it.
--
-- So: `oee.work_center_month_reports` exists beside the day one for this reason,
-- `oee.work_unit_month_reports` does, and this does. Note what does NOT get a
-- month sibling for the same reason: the per-unit Input/Output read widens
-- `oee.work_center_day_reports` over the month, because summing counts WITHIN one
-- unit is exact addition with no rate in it (contract §26.3).
--
-- ---------------------------------------------------------------------------
-- THE ONE THING THIS FILE ADDS: `business_date` IS THE FIRST DAY OF THE MONTH
-- ---------------------------------------------------------------------------
--
-- Contract §15.3 says "not the last, and not midnight of the first", and
-- `ck_amr_month_start` is what makes that mechanical rather than editorial —
-- `0014`'s `ck_wcmr_month_start`, verbatim.
--
-- IT MATTERS MORE THAN IT LOOKS. Every read of this table resolves a window from
-- the row's own `business_date` (`resolveReportWindow` truncates to the month, so
-- a mid-month value would still produce the right WINDOW) — but the LIST orders
-- and filters on the column directly, and `month` is a nullable display label
-- OUT of the key that nothing joins on. A row dated the 15th would sort between
-- two other months' rows and answer a `year = 2026 AND month = 9` filter from a
-- position no reader could predict. The CHECK is cheaper than the bug.
--
-- Plain `CREATE TABLE`, not `IF NOT EXISTS`: this table exists nowhere, so a
-- silent no-op against a drifted schema is the failure to avoid. `0016`'s rule.
-- ---------------------------------------------------------------------------

CREATE TABLE oee.area_month_reports (
  id                          integer       GENERATED ALWAYS AS IDENTITY,

  -- ---- the grain ---------------------------------------------------------
  area_id                     integer       NOT NULL,
  -- THE FIRST BUSINESS DAY OF THE MONTH, enforced by ck_amr_month_start below.
  business_date               date          NOT NULL,
  -- The IANA zone business_date was cut in. NOT NULL, as on `0024`. A business
  -- day must never be reconstructed with `::date` — contract §22.2.
  time_zone                   text          NOT NULL,

  -- ---- dimensions, denormalised -----------------------------------------
  area_name                   varchar(255)  NOT NULL,
  area_code                   varchar(255),
  factory_id                  integer,
  factory_name                varchar(255),
  -- Nullable label OUT of the key. A month is derivable from business_date; this
  -- is for display only and nothing joins on it. Note this is the ONE grain where
  -- it is tempting to promote it into the key, and it must not be: a varchar
  -- month sorts lexicographically, which happens to agree with chronology for
  -- 'YYYY-MM' and stops agreeing the moment anything writes a different format —
  -- and §15.7 records that the format was never specified upstream.
  month                       varchar(50),

  -- ---- THE ONE UNIT, AND IT IS A MASS -----------------------------------
  -- `0024`'s triple and `0024`'s CHECK. NULL means the members could not be
  -- brought to a common mass — a THIRD meaning for a null unit in this schema,
  -- neither `0014`'s "the members disagreed" nor `0023`'s "not known".
  weight_uom_id               integer,
  weight_uom_name             varchar(255),
  weight_uom_code             varchar(255),

  -- ---- rates, all nullable ----------------------------------------------
  -- COMPOSED BY THE PIPELINE AND RECOMPUTED FROM THE MONTH'S SUMS, never averaged
  -- over the days. §15.5 works the arithmetic; a mean of ratios is not the ratio
  -- of the sums, and it is the sums the duration columns below hold. This is the
  -- one thing a reader cannot do for itself and therefore the whole reason this
  -- table exists — see the header.
  --
  -- No `teep`, for `0024`'s reason: an area owns no calendar a reader could name.
  oee                         numeric(10,3),
  availability                numeric(10,3),
  performance                 numeric(10,3),
  quality                     numeric(10,3),

  -- ---- counts, ALL IN `weight_uom_*` ------------------------------------
  --   consumed side   total_out, area_out, reject, rework
  --   shipped side     good_out
  -- Both are masses, so they are comparable — and still not an identity.
  -- No `effective_out`; the requirement's tile list stops at Finish Good.
  total_out                   numeric(15,3),
  area_out                    numeric(15,3),
  reject                      numeric(15,3),
  rework                      numeric(15,3),
  good_out                    numeric(15,3),

  -- ---- durations, milliseconds, NOT NULL --------------------------------
  -- LINE-MILLISECONDS, summed across the area's lines AND across the month's
  -- days. A five-line area's `availability_time` over a 30-day month is ~3,600
  -- hours. Read `0024`'s consequence 1 before "correcting" any of these.
  --
  -- AND THE MONTH LENGTH IS NOT A CONSTANT: across a DST transition a calendar
  -- month is 743 or 745 real hours, not 744. Nothing here computes a month
  -- length — the pipeline sums what elapsed — and `resolveReportWindow` does the
  -- boundary arithmetic in Postgres with AT TIME ZONE so a reader never has to.
  runtime                     bigint        NOT NULL,
  availability_time           bigint        NOT NULL,
  production_time             bigint        NOT NULL,
  pdt_time                    bigint        NOT NULL,
  operating_time              bigint        NOT NULL,
  updt_time                   bigint        NOT NULL,
  net_time                    bigint        NOT NULL,
  reduce_speed_time           bigint        NOT NULL,
  ms_time                     bigint        NOT NULL,
  value_added_time            bigint        NOT NULL,
  rework_time                 bigint        NOT NULL,
  reject_time                 bigint        NOT NULL,
  anomaly_time                bigint        NOT NULL,
  up_speed_time               bigint        NOT NULL,

  schedule_loss_time          bigint        NOT NULL,
  availability_loss_time      bigint        NOT NULL,
  performance_loss_time       bigint        NOT NULL,
  ms_loss_time                bigint        NOT NULL,
  reduce_speed_loss_time      bigint        NOT NULL,
  quality_loss_time           bigint        NOT NULL,

  -- Nullable with no default, §15.4's rule: a DEFAULT 0 would make every
  -- unwritten row claim a perfect repair time. RATIOS, so they are recomputed
  -- over the month's summed repair time and failure count rather than averaged
  -- over the days'.
  mttr                        bigint,
  mtbf                        bigint,

  CONSTRAINT area_month_reports_pkey PRIMARY KEY (id),

  CONSTRAINT ck_amr_month_format CHECK (month IS NULL OR month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- THE ONE CONSTRAINT THIS FILE ADDS BEYOND `0024`'s. See the header.
  CONSTRAINT ck_amr_month_start CHECK (business_date = date_trunc('month', business_date)::date),

  -- ONE unit guard over ONE count set — `0024`'s, unchanged.
  CONSTRAINT ck_amr_weight_units CHECK (
    weight_uom_id IS NOT NULL
    OR (total_out IS NULL AND area_out IS NULL AND reject IS NULL
        AND rework IS NULL AND good_out IS NULL)
  )
);

-- THE UPSERT TARGET. Contract §26 asks the pipeline to use it, which is what keeps
-- `id` stable across runs — `0023`'s header says why that is not optional.
--
-- `(area_id, business_date)`, the same column ORDER `0024`'s key uses, so the two
-- area tables read identically. (`0014`'s month key is `(business_date,
-- work_center_id)` and its day key is the other way round; that inconsistency is
-- upstream history, not a pattern to copy.)
CREATE UNIQUE INDEX area_month_reports_key
  ON oee.area_month_reports USING btree (area_id, business_date);

-- The list screen: every month of one year for one area, newest first.
CREATE INDEX amr_ix_date_area
  ON oee.area_month_reports USING btree (business_date DESC, area_id);

-- "This area over time" — the shape every other per-subject table has, so a reader
-- moving between them meets one access pattern rather than several.
CREATE INDEX amr_ix_area_date
  ON oee.area_month_reports USING btree (area_id, business_date DESC);

COMMENT ON TABLE oee.area_month_reports IS
  'One area, one month. COMPOSED from the area''s member lines over the whole month, never measured: an area has no count point and no clock of its own. Its RATES are recomputed from the month''s sums and are NOT the average of its days'' rates, which is the reason this exists as a table rather than being derived by widening oee.area_day_reports. Every duration is in LINE-milliseconds and every count is a MASS — see oee.area_day_reports (0024). Contract §26.';
COMMENT ON COLUMN oee.area_month_reports.business_date IS
  'The FIRST business day of the month, enforced by ck_amr_month_start. Contract §15.3 — not the last, and not midnight of the first.';
COMMENT ON COLUMN oee.area_month_reports.month IS
  'A display label only, OUT of the key and joined on by nothing. business_date is the month. Format unspecified upstream (§15.7), which is why nothing sorts or filters on this.';
COMMENT ON COLUMN oee.area_month_reports.availability IS
  'The area''s composed availability for the month, RECOMPUTED from this row''s own summed components. NOT an average of its days'' availabilities and NOT an average of its lines'' — a mean of ratios is not the ratio of the sums (§15.5).';
COMMENT ON COLUMN oee.area_month_reports.runtime IS
  'LINE-MILLISECONDS, summed across every line in the area AND across the month''s days. A five-line area over a 30-day month is ~3,600 hours, not ~720; do NOT divide by the line count or by the day count. Every other duration on this row is on the same footing.';
COMMENT ON COLUMN oee.area_month_reports.total_out IS
  'What the area''s lines CONSUMED over the month, as a MASS in weight_uom_*. total_out = good_out + reject + rework is NOT asserted: the figures come from different count points on N lines, and mass is neither conserved through a packing line nor measured at a single point.';
COMMENT ON COLUMN oee.area_month_reports.area_out IS
  'The member lines'' OWN measured production (work_center_*.line_out) brought to a common mass and summed over the month — the figure the detail screen labels "<area name> Production". Distinct from total_out, which is what those lines consumed.';
COMMENT ON COLUMN oee.area_month_reports.weight_uom_id IS
  'The mass unit every count on this row is denominated in. NULL means the pipeline could not bring the members to a common mass over this month — typically a product with no std_weight in ms_product.product_packaging — and the counts are NULL with it (ck_amr_weight_units).';

-- The watermark list. Without this row the screen cannot tell "this area had no
-- production that month" from "the DAG has not run" — §8 and §14's distinction,
-- and the state this table SHIPS in.
ALTER TABLE oee.etl_watermarks DROP CONSTRAINT IF EXISTS ck_etl_watermarks_table;
ALTER TABLE oee.etl_watermarks ADD CONSTRAINT ck_etl_watermarks_table CHECK (table_name IN (
  'work_unit_shift_reports',
  'work_unit_day_reports',
  'work_unit_month_reports',
  'downtime_reports',
  'product_count_wu_shift',
  'product_count_wu_day',
  'product_perf_wu_hour',
  'reject_count_wu_shift',
  'downtime_log_events',
  'work_center_shift_reports',
  'work_center_day_reports',
  'work_center_month_reports',
  'product_count_wc_shift',
  'product_count_wc_day',
  'product_perf_wc_hour',
  'reject_count_wc_shift',
  'product_report_wc_day',
  'area_day_reports',
  'area_month_reports'
));

-- NO OPERATOR MUTATION TARGETS THIS TABLE, and these two triggers assert it from
-- the database's side — `0023`'s and `0024`'s arrangement. An area report has no
-- approval (oee.work_unit_shift_report_approvals is keyed
-- (work_unit_id, date, shift)) and no quality ledger of its own (an entry is a row
-- in oee.work_center_quality_entries, keyed by LINE). If an operator write ever
-- shows up in oee.write_audit against this table, something has gone wrong.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.area_month_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.area_month_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
