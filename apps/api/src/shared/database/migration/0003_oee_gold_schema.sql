-- The Gold tier's `oee` schema — every table this service reads.
--
-- WHY THIS FILE EXISTS
--
-- Until now this repo owned no schema at all. `README.md` already claimed Gold's
-- DDL lived in this directory, but the tables were created out-of-band, so nobody
-- could stand up a local environment that served a real report, no integration
-- test could run against a real database, and an upstream column rename would
-- break production with no compile-time signal. This file closes that gap: it is
-- the checked-in, authoritative DDL for the `oee` schema.
--
-- OWNING THE DDL IS NOT OWNING THE DATA. Every BULK write to these tables is
-- Apache Airflow -> dbt, writing directly to the database; this service writes
-- only named operator mutations. The full contract, including the upsert keys and
-- the columns still being asked for, is in `docs/gold-write-contract.md`.
--
-- PROVENANCE
--
-- Captured 2026-08-13 from the live Gold database (`mes-master-data`, schema
-- `oee`) by reading `pg_catalog` / `information_schema` directly — column order,
-- types, precision, nullability, defaults, constraint names and index names are
-- reproduced verbatim rather than reconstructed from the application code. That
-- matters: reasoning about these columns from the codebase is exactly how the
-- shift-3 product-count bug happened (see TODOS.md §17). Only the catalogue knew
-- that `work_unit_shift_reports.date` is a `timestamptz` holding the shift's
-- START INSTANT and not a calendar `date`.
--
-- The capture below spelled the same concept two ways, because the live database
-- did:
--
--   work_unit_shift_reports.availability_loss_time   -- correct
--   work_unit_day_reports.availablity_loss_time      -- missing the second 'i'
--   work_unit_month_reports.availablity_loss_time    -- likewise
--
-- THE DAY AND MONTH SPELLINGS WERE CORRECTED BY 0013 and no longer exist. That
-- was safe precisely because those two tables were still empty and no dbt model
-- wrote them — which was the entire reason this file said to preserve them. The
-- shift table's spelling was already correct and is untouched. Read the DDL
-- below as the 2026-08-13 capture it is, not as the current schema.
--
-- WHY EVERY STATEMENT IS IDEMPOTENT
--
-- `GOLD_DATABASE_URL` points at a database where all of this ALREADY EXISTS and
-- holds rows, and `schema_migrations` does not exist there yet — so the first
-- `db:migrate` run against a real environment will apply this file against a
-- populated schema. `IF NOT EXISTS` throughout makes that run a no-op, while a
-- fresh local Postgres gets the complete schema from the same file.
--
-- The trade-off is worth stating plainly: `CREATE TABLE IF NOT EXISTS` does not
-- reconcile an existing table that has DRIFTED from this definition — it simply
-- does nothing. This file is therefore the source of truth for a NEW database
-- and a faithful reference for an existing one; it is not a drift detector.
-- Future changes to these tables belong in a new numbered migration with plain
-- `ALTER TABLE`, which does fail loudly.
--
-- No foreign keys appear below because there are none: `work_unit_id`,
-- `work_center_id`, `product_id` and `uom_id` reference mes-master-data, a
-- different service and a different database. Names and codes are denormalised
-- onto each row for the same reason, which is why the product-count read needs
-- no mes-master-data call at all.

CREATE SCHEMA IF NOT EXISTS oee;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- `CREATE TYPE` has no IF NOT EXISTS, so it needs a guard to stay re-runnable.
-- The three labels are load-bearing: postgres.js hands enums back as raw strings
-- and `apps/api/src/module/downtime/downtime.ts` maps them to timeline
-- categories by exact value.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'oee' AND t.typname = 'operation_type'
  ) THEN
    CREATE TYPE oee.operation_type AS ENUM ('UNPLANNED', 'PLANNED', 'SMALL_STOP');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- oee.downtime_reports — one machine stop
-- ---------------------------------------------------------------------------
--
-- Read by `DowntimeReaderRepository` for the timeline strip. Column order below
-- is the physical order in the live database, which is not a tidy one — the
-- work_center_* columns were clearly added after the fact. It is reproduced
-- as-is so a `SELECT *` returns identical shape everywhere.
--
-- Known modelling gaps, asked of the pipeline owner in
-- docs/gold-write-contract.md §3.2-§3.3 rather than changed here unilaterally:
--   * no `CHECK (end_at IS NULL OR end_at >= start_at)` — inverted rows are
--     possible and the service drops them at runtime (`clipToWindow`, counted
--     as `downtime_rows_dropped_total`).
--   * `duration` is written independently of start_at/end_at and can disagree
--     with them; it wants to be a generated column or to go away.
--   * `shift` is a smallint here but a varchar in some sibling tables' history;
--     `date` is a business-day bucket typed as timestamptz.
--   * no area_id / factory_id, which is why `scope=area|factory` on the
--     timeline endpoint answers 400 (TODOS.md §9).
CREATE TABLE IF NOT EXISTS oee.downtime_reports (
  id                serial                   NOT NULL,
  reason            jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  category          oee.operation_type       NOT NULL,
  work_unit_id      integer                  NOT NULL,
  shift             smallint                 NOT NULL,
  date              timestamp with time zone NOT NULL,
  actions           jsonb                             DEFAULT '[]'::jsonb,
  start_at          timestamp with time zone NOT NULL,
  end_at            timestamp with time zone,
  duration          bigint,
  work_unit_name    varchar(255),
  work_unit_code    varchar(255),
  work_center_id    integer                  NOT NULL,
  work_center_name  varchar(255),
  work_center_code  varchar(255),
  CONSTRAINT downtime_reports_pkey PRIMARY KEY (id)
);

-- Partial on `end_at IS NOT NULL`: closed stops only. `listOverlapping` also has
-- to see OPEN stops, which this index cannot serve — that is why the query
-- narrows on `date` (MAX_OPEN_DOWNTIME_DAYS) to stay sargable, and why TODOS.md
-- §10 proposes a GiST range index to remove that horizon.
CREATE INDEX IF NOT EXISTS dt_reports_date_wu_idx
  ON oee.downtime_reports USING btree (date DESC, work_unit_id)
  WHERE (end_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS dt_reports_wu_idx
  ON oee.downtime_reports USING btree (work_unit_id);

-- ---------------------------------------------------------------------------
-- oee.work_unit_shift_reports — one work unit, one shift
-- ---------------------------------------------------------------------------
--
-- The table `WorkUnitReportReaderRepository` reads for the By Shift screen; its
-- ~40 columns are mirrored by `WorkUnitShiftReportField` in
-- `apps/api/src/module/work-unit/work-unit.ts`.
--
-- `date` IS A timestamptz HOLDING THE SHIFT'S START INSTANT, not a calendar day.
-- Every consumer wanting a business day out of it must resolve the plant's time
-- zone first. `periodFilter` cannot, because it spans many work units in one
-- query and the zone is not a column — so the month filter is exact for a UTC+7
-- plant and misattributes both ends of the month anywhere west of Greenwich.
-- TODOS.md §17 is the fix (a denormalised `business_date date`), and is the
-- reason `listProductCount` joins via `(r.date AT TIME ZONE $tz)::date`.
--
-- 0013 ADDED `business_date` AND `time_zone` TO THIS TABLE, both nullable. They
-- are the fix, but they are not populated yet — Airflow has to backfill them —
-- so the zone-resolution path above is still live and still correct. See
-- TODOS.md §46.
CREATE TABLE IF NOT EXISTS oee.work_unit_shift_reports (
  id                      serial                   NOT NULL,
  shift                   smallint                 NOT NULL,
  date                    timestamp with time zone NOT NULL,
  work_unit_id            integer                  NOT NULL,
  work_unit_name          varchar(255),
  work_unit_code          varchar(255),
  uom_id                  integer                  NOT NULL,
  uom_name                varchar(255),
  uom_code                varchar(255),
  teep                    numeric(10,3)            NOT NULL,
  oee                     numeric(10,3)            NOT NULL,
  availability            numeric(10,3)            NOT NULL,
  performance             numeric(10,3)            NOT NULL,
  quality                 numeric(10,3)            NOT NULL,
  total_out               numeric(15,3)            NOT NULL,
  good_out                numeric(15,3)            NOT NULL,
  effective_out           numeric(15,3)            NOT NULL,
  runtime                 bigint                   NOT NULL,
  availability_time       bigint                   NOT NULL,
  production_time         bigint                   NOT NULL,
  pdt_time                bigint                   NOT NULL,
  operating_time          bigint                   NOT NULL,
  updt_time               bigint                   NOT NULL,
  net_time                bigint                   NOT NULL,
  reduce_speed_time       bigint                   NOT NULL,
  ms_time                 bigint                   NOT NULL,
  value_added_time        bigint                   NOT NULL,
  rework_time             bigint                   NOT NULL,
  reject_time             bigint                   NOT NULL,
  anomaly_time            bigint                   NOT NULL,
  up_speed_time           bigint                   NOT NULL,
  schedule_loss_time      bigint                   NOT NULL,
  availability_loss_time  bigint                   NOT NULL,
  performance_loss_time   bigint                   NOT NULL,
  ms_loss_time            bigint                   NOT NULL,
  reduce_speed_loss_time  bigint                   NOT NULL,
  quality_loss_time       bigint                   NOT NULL,
  reject                  numeric(15,3)            NOT NULL,
  rework                  numeric(15,3)            NOT NULL,
  work_center_id          integer                  NOT NULL,
  work_center_name        varchar(255),
  work_center_code        varchar(255),
  mttr                    bigint                   NOT NULL DEFAULT 0,
  mtbf                    bigint                   NOT NULL DEFAULT 0,
  CONSTRAINT work_unit_shift_reports_pkey PRIMARY KEY (id)
);

-- The pipeline's upsert key (dbt `unique_key`) — one report per (work unit,
-- shift, shift start). Unlike downtime_reports below, this table CAN be upserted
-- idempotently, which is why a DAG retry does not duplicate it.
-- A plain unique INDEX in the live database, not a table constraint; kept that
-- way so `pg_dump` output and this file agree.
CREATE UNIQUE INDEX IF NOT EXISTS wu_shift_report_key
  ON oee.work_unit_shift_reports USING btree (date, shift, work_unit_id);

CREATE INDEX IF NOT EXISTS wu_shift_report_shift_idx
  ON oee.work_unit_shift_reports USING btree (shift);

CREATE INDEX IF NOT EXISTS wu_shift_report_wu_date_idx
  ON oee.work_unit_shift_reports USING btree (work_unit_id, date DESC);

CREATE INDEX IF NOT EXISTS wu_shift_report_wu_idx
  ON oee.work_unit_shift_reports USING btree (work_unit_id);

-- ---------------------------------------------------------------------------
-- oee.work_unit_day_reports — the same measures rolled up to a business day
-- ---------------------------------------------------------------------------
--
-- Captured empty; the shift table minus shift/work_center/mttr/mtbf, and with
-- `availablity_loss_time` misspelled.
--
-- 0013 CHANGED ALL OF THAT: it corrected the spelling and added work_center_*,
-- mttr, mtbf, business_date and time_zone, so this table is now the shift table
-- minus `shift` alone. It IS read by this service now — the By Day screens —
-- through `GRAIN_TABLE` in work-unit-repository.ts.
CREATE TABLE IF NOT EXISTS oee.work_unit_day_reports (
  id                      serial                   NOT NULL,
  date                    timestamp with time zone NOT NULL,
  work_unit_id            integer                  NOT NULL,
  work_unit_name          varchar(255),
  work_unit_code          varchar(255),
  uom_id                  integer                  NOT NULL,
  uom_name                varchar(255),
  uom_code                varchar(255),
  teep                    numeric(10,3)            NOT NULL,
  oee                     numeric(10,3)            NOT NULL,
  availability            numeric(10,3)            NOT NULL,
  performance             numeric(10,3)            NOT NULL,
  quality                 numeric(10,3)            NOT NULL,
  total_out               numeric(15,3)            NOT NULL,
  good_out                numeric(15,3)            NOT NULL,
  effective_out           numeric(15,3)            NOT NULL,
  runtime                 bigint                   NOT NULL,
  availability_time       bigint                   NOT NULL,
  production_time         bigint                   NOT NULL,
  pdt_time                bigint                   NOT NULL,
  operating_time          bigint                   NOT NULL,
  updt_time               bigint                   NOT NULL,
  net_time                bigint                   NOT NULL,
  reduce_speed_time       bigint                   NOT NULL,
  ms_time                 bigint                   NOT NULL,
  value_added_time        bigint                   NOT NULL,
  rework_time             bigint                   NOT NULL,
  reject_time             bigint                   NOT NULL,
  anomaly_time            bigint                   NOT NULL,
  up_speed_time           bigint                   NOT NULL,
  schedule_loss_time      bigint                   NOT NULL,
  availablity_loss_time   bigint                   NOT NULL,  -- sic
  performance_loss_time   bigint                   NOT NULL,
  ms_loss_time            bigint                   NOT NULL,
  reduce_speed_loss_time  bigint                   NOT NULL,
  quality_loss_time       bigint                   NOT NULL,
  reject                  numeric(15,3)            NOT NULL,
  rework                  numeric(15,3)            NOT NULL,
  CONSTRAINT work_unit_day_reports_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS wu_day_report_key
  ON oee.work_unit_day_reports USING btree (date, work_unit_id);

CREATE INDEX IF NOT EXISTS wu_day_report_wu_date_idx
  ON oee.work_unit_day_reports USING btree (work_unit_id, date DESC);

CREATE INDEX IF NOT EXISTS wu_day_report_wu_idx
  ON oee.work_unit_day_reports USING btree (work_unit_id);

-- ---------------------------------------------------------------------------
-- oee.work_unit_month_reports — the same measures rolled up to a month
-- ---------------------------------------------------------------------------
--
-- Carries BOTH a `month varchar(50)` label and a `date timestamptz`, and the
-- upsert key uses both. `month`'s format is still unspecified upstream, which is
-- why nothing reads it — the By Monthly screens format their label from
-- `business_date` instead.
--
-- 0013 applied the same corrections as the day table above, and this one is read
-- by this service now too.
CREATE TABLE IF NOT EXISTS oee.work_unit_month_reports (
  id                      serial                   NOT NULL,
  month                   varchar(50)              NOT NULL,
  date                    timestamp with time zone NOT NULL,
  work_unit_id            integer                  NOT NULL,
  work_unit_name          varchar(255),
  work_unit_code          varchar(255),
  uom_id                  integer                  NOT NULL,
  uom_name                varchar(255),
  uom_code                varchar(255),
  teep                    numeric(10,3)            NOT NULL,
  oee                     numeric(10,3)            NOT NULL,
  availability            numeric(10,3)            NOT NULL,
  performance             numeric(10,3)            NOT NULL,
  quality                 numeric(10,3)            NOT NULL,
  total_out               numeric(15,3)            NOT NULL,
  good_out                numeric(15,3)            NOT NULL,
  effective_out           numeric(15,3)            NOT NULL,
  runtime                 bigint                   NOT NULL,
  availability_time       bigint                   NOT NULL,
  production_time         bigint                   NOT NULL,
  pdt_time                bigint                   NOT NULL,
  operating_time          bigint                   NOT NULL,
  updt_time               bigint                   NOT NULL,
  net_time                bigint                   NOT NULL,
  reduce_speed_time       bigint                   NOT NULL,
  ms_time                 bigint                   NOT NULL,
  value_added_time        bigint                   NOT NULL,
  rework_time             bigint                   NOT NULL,
  reject_time             bigint                   NOT NULL,
  anomaly_time            bigint                   NOT NULL,
  up_speed_time           bigint                   NOT NULL,
  schedule_loss_time      bigint                   NOT NULL,
  availablity_loss_time   bigint                   NOT NULL,  -- sic
  performance_loss_time   bigint                   NOT NULL,
  ms_loss_time            bigint                   NOT NULL,
  reduce_speed_loss_time  bigint                   NOT NULL,
  quality_loss_time       bigint                   NOT NULL,
  reject                  numeric(15,3)            NOT NULL,
  rework                  numeric(15,3)            NOT NULL,
  CONSTRAINT work_unit_month_reports_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS wu_month_report_key
  ON oee.work_unit_month_reports USING btree (date, month, work_unit_id);

CREATE INDEX IF NOT EXISTS wu_month_report_wu_date_idx
  ON oee.work_unit_month_reports USING btree (work_unit_id, date DESC);

CREATE INDEX IF NOT EXISTS wu_month_report_wu_idx
  ON oee.work_unit_month_reports USING btree (work_unit_id);

-- ---------------------------------------------------------------------------
-- oee.work_unit_perf_analytics — actual vs ideal rate over an arbitrary window
-- ---------------------------------------------------------------------------
--
-- Grain is a (work unit, product, start_time..end_time) interval rather than a
-- shift or a day, so it does not line up with the report tables above. Not read
-- by this service yet. Note the measures are numeric(10,3) here, narrower than
-- the numeric(15,3) used for the same quantities on the report tables.
CREATE TABLE IF NOT EXISTS oee.work_unit_perf_analytics (
  id                    serial                   NOT NULL,
  uom_id                integer                  NOT NULL,
  work_unit_id          integer                  NOT NULL,
  product_id            integer                  NOT NULL,
  product_name          varchar(255),
  product_code          varchar(255),
  start_time            timestamp with time zone NOT NULL,
  end_time              timestamp with time zone NOT NULL,
  effective_out         numeric(10,3)            NOT NULL,
  actual_rate_per_hour  numeric(10,3)            NOT NULL,
  ideal_rate_per_hour   numeric(10,3)            NOT NULL,
  total_out             numeric(10,3)            NOT NULL,
  CONSTRAINT work_unit_perf_analytics_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS wu_perf_wu_idx
  ON oee.work_unit_perf_analytics USING btree (work_unit_id);

-- ---------------------------------------------------------------------------
-- oee.product_count_wu_shift — per-SKU output for one work unit and shift
-- ---------------------------------------------------------------------------
--
-- Backs the SKU View card. `shift_date` here is a real Postgres `date` (the
-- business day), NOT the timestamptz that `work_unit_shift_reports.date` is —
-- the two are joined by converting the latter through the plant's time zone.
-- Joining them naively matched only shift 1 at UTC+7 and silently returned
-- nothing for shifts 2 and 3; see TODOS.md §17 and the diagram above
-- `listProductCount` in `work-unit-repository.ts`.
--
-- `factor_to_base` converts total_out / reject / rework into the base unit —
-- good_out is deliberately NOT scaled, because Finish Good stays in its
-- production unit. `CHECK (factor_to_base > 0)` admits any positive value, so a
-- wrong-but-positive factor renders a plausible number rather than failing;
-- docs/gold-write-contract.md §3.4 asks for a per-(product, uom, base_uom)
-- guarantee, since nothing downstream can validate the factor's value.
--
-- Product, UOM and base-UOM names and codes are denormalised onto the row,
-- which is why this read needs no mes-master-data call at all.
CREATE TABLE IF NOT EXISTS oee.product_count_wu_shift (
  shift           smallint      NOT NULL,
  shift_date      date          NOT NULL,
  product_id      integer       NOT NULL,
  product_name    varchar(255)  NOT NULL,
  product_code    varchar(255)  NOT NULL,
  work_unit_id    integer       NOT NULL,
  work_unit_name  varchar(255)  NOT NULL,
  work_unit_code  varchar(255)  NOT NULL,
  uom_id          integer       NOT NULL,
  uom_name        varchar(255)  NOT NULL,
  uom_code        varchar(255)  NOT NULL,
  base_uom_id     integer       NOT NULL,
  base_uom_name   varchar(255)  NOT NULL,
  base_uom_code   varchar(255)  NOT NULL,
  factor_to_base  numeric(10,3) NOT NULL,
  total_out       numeric(15,3) NOT NULL,
  good_out        numeric(15,3) NOT NULL,
  reject          numeric(15,3) NOT NULL,
  rework          numeric(15,3) NOT NULL,
  CONSTRAINT pk_product_count_wu_shift
    PRIMARY KEY (work_unit_id, shift_date, shift, product_id),
  CONSTRAINT ck_pcwus_shift  CHECK (shift >= 1 AND shift <= 3),
  CONSTRAINT ck_pcwus_factor CHECK (factor_to_base > 0),
  CONSTRAINT ck_pcwus_nonneg CHECK (
    total_out >= 0 AND good_out >= 0 AND reject >= 0 AND rework >= 0
  )
);

-- Neither secondary index serves a query this service issues — the report join
-- uses the primary key's left prefix `(work_unit_id, shift_date, shift)`. They
-- exist for the pipeline and for ad-hoc per-SKU reporting.
CREATE INDEX IF NOT EXISTS pcwus_ix_pcs_date_shift
  ON oee.product_count_wu_shift USING btree (shift_date, shift);

CREATE INDEX IF NOT EXISTS pcwus_ix_shift_pcs_product
  ON oee.product_count_wu_shift USING btree (product_id, shift_date);

-- ---------------------------------------------------------------------------
-- oee.product_count_wu_day — the same per-SKU output rolled up to a day
-- ---------------------------------------------------------------------------
--
-- Same columns as the shift table with `shift`/`shift_date` collapsed into a
-- single `date date`, and therefore no shift range check. Not read by this
-- service yet. Note the grain is still ONE WORK UNIT — neither product-count
-- table can answer a line-, area- or factory-level SKU question, which is the
-- open design point in TODOS.md §15.
CREATE TABLE IF NOT EXISTS oee.product_count_wu_day (
  date            date          NOT NULL,
  product_id      integer       NOT NULL,
  product_name    varchar(255)  NOT NULL,
  product_code    varchar(255)  NOT NULL,
  work_unit_id    integer       NOT NULL,
  work_unit_name  varchar(255)  NOT NULL,
  work_unit_code  varchar(255)  NOT NULL,
  uom_id          integer       NOT NULL,
  uom_name        varchar(255)  NOT NULL,
  uom_code        varchar(255)  NOT NULL,
  base_uom_id     integer       NOT NULL,
  base_uom_name   varchar(255)  NOT NULL,
  base_uom_code   varchar(255)  NOT NULL,
  factor_to_base  numeric(10,3) NOT NULL,
  total_out       numeric(15,3) NOT NULL,
  good_out        numeric(15,3) NOT NULL,
  reject          numeric(15,3) NOT NULL,
  rework          numeric(15,3) NOT NULL,
  CONSTRAINT pk_product_count_wu_day
    PRIMARY KEY (work_unit_id, date, product_id),
  CONSTRAINT ck_pcwud_factor CHECK (factor_to_base > 0),
  CONSTRAINT ck_pcwud_nonneg CHECK (
    total_out >= 0 AND good_out >= 0 AND reject >= 0 AND rework >= 0
  )
);

CREATE INDEX IF NOT EXISTS ix_pcwud_date
  ON oee.product_count_wu_day USING btree (date);

CREATE INDEX IF NOT EXISTS ix_pcwud_product_date
  ON oee.product_count_wu_day USING btree (product_id, date);
