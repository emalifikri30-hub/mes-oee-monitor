-- ---------------------------------------------------------------------------
-- 0023 — the SKU grain: one report per (line, business day, product)
-- ---------------------------------------------------------------------------
--
-- One table, `oee.product_report_wc_day`. It backs the SKU/Product daily report
-- (TODOS.md §65) and it is contract §24's ask. It ships EMPTY.
--
-- WHY A REPORT TABLE AND NOT A READ-TIME DERIVATION
--
-- Every OEE figure this service has ever rendered is a column the pipeline wrote.
-- The API computes no rate anywhere except one runtime-weighted
-- `ideal_rate_per_hour` for the month hour-profile, and that is a rate rather than
-- an OEE.
--
-- A per-SKU A/P/Q could LOOK derivable — runtime from product_perf_wc_hour,
-- downtime from downtime_reports.product_id (0020), counts from
-- product_count_wc_day. It is not. Availability needs a PLANNED PRODUCTION TIME
-- denominator, and nothing in Gold exposes how the pipeline computes the line's.
-- A second definition would put two OEE figures on one screen — the SKU card and
-- the line report it drills down from — disagreeing by an unknown amount, both
-- defensible. That is the failure 0014, 0016, 0018 and 0019 each exist to prevent,
-- and it is worse here because the two numbers are one click apart.
--
-- WHY THIS DOES NOT CONTRADICT "DO NOT OVER-TABLE" (contract §23.1)
--
-- The pipeline owner asked for fewer report tables, not none: §23.2 lists SKU as
-- one of five intended report SUBJECTS. This is that subject's table. The
-- restraint §23.1 asks for is visible one migration back — 0020 attributed
-- downtime to a SKU with two COLUMNS rather than a seventh aggregate, because a
-- stop is an event on a row that already exists. A SKU's OEE is not.
--
-- ---------------------------------------------------------------------------
-- THE KEY: AN IDENTITY `id` *AND* A NATURAL UNIQUE KEY. BOTH. -----------------
-- ---------------------------------------------------------------------------
--
-- This mirrors oee.work_center_day_reports exactly, and the pairing is the whole
-- design rather than two independent choices:
--
--   * `id` is what a URL and a cache key name. All six existing report tables are
--     addressed this way and the browser's routing, query keys and ReportAddress
--     all assume it. A composite-key URL here would be a seventh addressing shape
--     for one table.
--   * The NATURAL KEY is what makes `id` safe to name. These tables are loaded
--     DELETE-then-INSERT today, which churns a serial on every run — the hazard
--     0007's header records for `downtime_reports.id`, where there was no natural
--     key to upsert on until `source_event_id` existed. There is one here from the
--     first migration, so contract §24 can ask for an UPSERT and `id` stays put.
--
-- So: do not drop either. `id` without the unique key is a deep link that silently
-- retargets; the unique key without `id` is a URL shape nothing else in this app
-- speaks.
--
-- ---------------------------------------------------------------------------
-- WHAT IS *NOT* HERE, and each absence is a decision -------------------------
-- ---------------------------------------------------------------------------
--
--   * NO shift or month sibling. The requirement is day only. A month table would
--     also be premature for the reason 0016 gives: a day table widened over an
--     interval already answers a month, which `listPeriodProductCount` proves.
--   * NO `work_unit_count`. A SKU is not made of machines; it ran on ONE line.
--     `work_center_id` is NOT NULL and single-valued, which is the whole grain.
--   * NO `teep`. TEEP divides by CALENDAR time, and a SKU does not own the
--     calendar — the line does, and it shares it with every other SKU that ran
--     that day. A per-SKU TEEP would be a number with no denominator anybody
--     could name. `oee` stays because it divides by the SKU's own loading time.
--   * NO per-machine breakdown. §17's "summing counts across machines needs a
--     base-unit conversion" applies unchanged.
--
-- Plain CREATE TABLE, not IF NOT EXISTS: this table exists nowhere, so a silent
-- no-op against a drifted schema is the failure to avoid. 0016's rule.
-- ---------------------------------------------------------------------------

CREATE TABLE oee.product_report_wc_day (
  id                       integer       GENERATED ALWAYS AS IDENTITY,

  -- ---- the grain ----------------------------------------------------------
  work_center_id           integer       NOT NULL,
  business_date            date          NOT NULL,
  product_id               integer       NOT NULL,
  -- The IANA zone business_date was cut in. NOT NULL here, unlike on
  -- downtime_reports where 0021 had to admit existing rows: this table is empty,
  -- so the pairing 0021's header argues for can be enforced from the start.
  time_zone                text          NOT NULL,

  -- ---- dimensions, denormalised -------------------------------------------
  work_center_name         varchar(255)  NOT NULL,
  work_center_code         varchar(255),
  area_id                  integer,
  area_name                varchar(255),
  product_name             varchar(255)  NOT NULL,
  product_code             varchar(255)  NOT NULL,
  -- Nullable label OUT of the key, exactly as 0014 keeps it. A month is derivable
  -- from business_date; this is for display only and nothing joins on it.
  month                    varchar(50),

  -- ---- THE TWO UNITS ------------------------------------------------------
  -- 0014's shape and 0014's nullability. A count with no unit is nulled WITH it,
  -- enforced by the two CHECKs below, because "500 BAG + 12 CARTON = 512 <blank>"
  -- is a wrong number wearing a missing label rather than a smaller truth.
  --
  -- NOTE the meaning of NULL differs from 0014's by one word and it matters. On a
  -- LINE row NULL means "the members disagreed". Here there are no members — one
  -- SKU on one line — so NULL means simply "not known", which is rarer and is a
  -- data-quality signal rather than a normal state.
  infeed_uom_id            integer,
  infeed_uom_name          varchar(255),
  infeed_uom_code          varchar(255),
  output_uom_id            integer,
  output_uom_name          varchar(255),
  output_uom_code          varchar(255),

  -- ---- rates, all nullable ------------------------------------------------
  -- 0/0 is real for a SKU whose whole run sat in planned downtime. NULL is not 0
  -- and must never be coalesced to it; the browser renders an em dash.
  -- No `teep` — see the header.
  oee                      numeric(10,3),
  availability             numeric(10,3),
  performance              numeric(10,3),
  quality                  numeric(10,3),

  -- ---- counts, split across the two units ---------------------------------
  -- INFEED side: what the line consumed making this SKU.
  total_out                numeric(15,3),
  reject                   numeric(15,3),
  rework                   numeric(15,3),
  line_out                 numeric(15,3),
  -- OUTPUT side: what came off the end.
  good_out                 numeric(15,3),
  effective_out            numeric(15,3),

  -- ---- durations, milliseconds, NOT NULL ----------------------------------
  -- 0014's set verbatim. A duration has no "unknown" state the way a rate does:
  -- time either elapsed against this SKU or it did not.
  runtime                  bigint        NOT NULL,
  availability_time        bigint        NOT NULL,
  production_time          bigint        NOT NULL,
  pdt_time                 bigint        NOT NULL,
  operating_time           bigint        NOT NULL,
  updt_time                bigint        NOT NULL,
  net_time                 bigint        NOT NULL,
  reduce_speed_time        bigint        NOT NULL,
  ms_time                  bigint        NOT NULL,
  value_added_time         bigint        NOT NULL,
  rework_time              bigint        NOT NULL,
  reject_time              bigint        NOT NULL,
  anomaly_time             bigint        NOT NULL,
  up_speed_time            bigint        NOT NULL,

  -- The six the Losses card and the waterfall read.
  schedule_loss_time       bigint        NOT NULL,
  availability_loss_time   bigint        NOT NULL,
  performance_loss_time    bigint        NOT NULL,
  ms_loss_time             bigint        NOT NULL,
  reduce_speed_loss_time   bigint        NOT NULL,
  quality_loss_time        bigint        NOT NULL,

  mttr                     bigint,
  mtbf                     bigint,

  CONSTRAINT product_report_wc_day_pkey PRIMARY KEY (id),

  CONSTRAINT ck_prwcd_month_format CHECK (month IS NULL OR month ~ '^[0-9]{4}-[0-9]{2}$'),

  -- The two unit guards, 0014's, with line_out joined to the infeed side as 0015
  -- joined it there.
  CONSTRAINT ck_prwcd_infeed_units CHECK (
    infeed_uom_id IS NOT NULL
    OR (total_out IS NULL AND reject IS NULL AND rework IS NULL AND line_out IS NULL)
  ),
  CONSTRAINT ck_prwcd_output_units CHECK (
    output_uom_id IS NOT NULL
    OR (good_out IS NULL AND effective_out IS NULL)
  )
);

-- THE UPSERT TARGET. Contract §24 asks the pipeline to use it, which is what keeps
-- `id` stable across runs — see the header for why that is not optional.
CREATE UNIQUE INDEX product_report_wc_day_key
  ON oee.product_report_wc_day USING btree (work_center_id, business_date, product_id);

-- The list screen: ordered by date, filtered by month/year and optionally by line.
CREATE INDEX prwcd_ix_date_line
  ON oee.product_report_wc_day USING btree (business_date DESC, work_center_id);

-- "This SKU over time" — the same shape ix_pcwcd_product_date (0016) and
-- ix_rcwcs_product_date (0019) already have, so a reader moving between the three
-- product tables meets one access pattern rather than three.
CREATE INDEX prwcd_ix_product_date
  ON oee.product_report_wc_day USING btree (product_id, business_date DESC);

COMMENT ON TABLE oee.product_report_wc_day IS
  'One SKU, on one line, on one business day. MEASURED per SKU, never apportioned from the line: line <> sum(SKUs), because a line''s availability is its own wall clock and cannot be divided between the products that shared it. Contract §24.';
COMMENT ON COLUMN oee.product_report_wc_day.availability IS
  'The SKU''s own availability. NOT the line''s, and NOT the line''s scaled by this SKU''s share of output — that would make every SKU on a line report the same figure, which is the roll-up this table exists to deny.';
COMMENT ON COLUMN oee.product_report_wc_day.total_out IS
  'INFEED side, with reject, rework and line_out. Shares no unit with good_out or effective_out, so total_out = good_out + reject + rework is FALSE here exactly as it is at the line grain (0014, contract §16.4a).';
COMMENT ON COLUMN oee.product_report_wc_day.infeed_uom_id IS
  'The unit consumed. NULL means the unit is not known — NOT "the members disagreed", which is what it means on oee.work_center_day_reports; a SKU report has no members.';

-- The watermark list. Without this row the screen cannot tell "this SKU had no
-- production" from "the DAG has not run", which is the distinction §8 and §14 both
-- exist for.
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
  'product_report_wc_day'
));

CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_report_wc_day
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_report_wc_day
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
