-- ===========================================================================
-- 0014 — the LINE grain: oee.work_center_{shift,day,month}_reports
-- ===========================================================================
--
-- Three new tables holding the same ~30 measures as oee.work_unit_shift_reports,
-- rolled up across the MACHINES ON A LINE instead of across time. They back the
-- `Report > Line > {By Shift, By Day, By Monthly}` screens, which until now were
-- greyed-out placeholders in the sidebar because no line-grain row existed
-- anywhere in Gold.
--
-- WRITTEN BY Apache Airflow -> dbt, exactly as the work_unit_* tables are. This
-- service NEVER inserts into them; docs/gold-write-contract.md §16 is the
-- specification, and §16.10 Q1-Q5 are the questions that had to be answered
-- before this file landed.
--
-- PLAIN `CREATE TABLE`, NOT `CREATE TABLE IF NOT EXISTS`. 0003 is all-idempotent
-- because it is applied against an already-populated database and therefore
-- cannot reconcile drift — its header says so and says not to extend it. These
-- three tables exist nowhere, so a silent no-op against a drifted schema is the
-- failure to avoid rather than the behaviour to copy.
--
-- ---------------------------------------------------------------------------
-- THREE DELIBERATE DIVERGENCES FROM work_unit_*, each dropping a known defect
-- ---------------------------------------------------------------------------
--
-- 1. NO `date timestamptz` COLUMN, AND THE KEY IS `business_date`.
--
--    work_unit_*.date holds the shift's START INSTANT, not a calendar day. It is
--    the most-documented trap in this repo — 0003's header, AGENTS.md, TODOS §17,
--    the shift-3 product-count bug — and it exists on those tables only because it
--    predates business_date and is half of their upsert keys. Here it has NO
--    READER: every filter, every ORDER BY and every window resolves through
--    business_date + time_zone. Reproducing it would be re-planting a landmine for
--    symmetry's sake.
--
-- 2. `month` IS A NULLABLE LABEL, OUT OF THE KEY.
--
--    wu_month_report_key is (date, month, work_unit_id) — a uniqueness constraint
--    over a varchar whose format is specified nowhere. Contract §15.7 states the
--    consequence: two DAG versions could disagree and both would load, which
--    renders the line twice and doubles the pager count. Nothing reads the column
--    (the By Monthly header formats its label from business_date), so it survives
--    only as a convenience for BI. §16.10 Q5 asks for the format; the CHECK lands
--    when we get an answer.
--
-- 3. business_date, time_zone AND work_center_name ARE NOT NULL.
--
--    On work_unit_* the first two are nullable because those tables already held
--    rows and a DEFAULT would have fabricated a business day (0013). An empty
--    table has no such constraint, and the cost of leaving them nullable is
--    concrete: a row whose business_date the pipeline has not written is
--    INVISIBLE to any month or year filter while still appearing in an unfiltered
--    list — a filtered page that is silently short. NOT NULL moves that to the
--    first load, loudly, where a re-run fixes it.
--
--    work_center_name follows the rule 0008 set for work_unit_name: "a Pareto
--    whose rows cannot say which machine they came from is not one." A Line list
--    whose rows cannot say which line they are is not one either.
--
-- ---------------------------------------------------------------------------
-- A LINE IS MEASURED, NOT SUMMED. `line <> sum(machines)`.
-- ---------------------------------------------------------------------------
--
-- A line has its OWN count points — physically mounted on particular machines,
-- but read as the line's infeed and outfeed rather than as those machines'
-- production. The pipeline builds these rows from those count points; it does
-- NOT roll up oee.work_unit_*_reports.
--
-- SO THE DURATIONS ARE THE LINE'S OWN WALL CLOCK. availability_time on a
-- four-machine line over one 8-hour shift is 8 hours, not 32, and TEEP's
-- denominator is the line's calendar time, unscaled.
--
-- AND `line_report <> sum(machine_reports)`, WHICH IS NOT A DEFECT. Five machines
-- in series do not produce five times the output — they pass work along, and the
-- line ships what comes off the end. Any model, test or reviewer expecting the
-- two to agree is expecting the wrong thing. docs/gold-write-contract.md §16.8
-- asks for the invariant that IS true instead: a line's day equals the sum of its
-- own shifts.
--
-- This CORRECTS an earlier reading in this file, which called the durations
-- "machine-milliseconds" and asked the pipeline to assert line = sum(machines).
-- That assumed a roll-up; the pipeline owner confirmed it is not one. Recorded
-- rather than quietly deleted, because the dev seed still derives that way and
-- has to say loudly that it is a stand-in — see
-- apps/api/scripts/seed/0015_work_center_reports_dev.sql.
--
-- ---------------------------------------------------------------------------
-- A LINE HAS TWO UNITS, AND THEY ARE USUALLY DIFFERENT
-- ---------------------------------------------------------------------------
--
-- This is the one place the line grain differs in KIND from the machine grain
-- rather than merely in scope. A discrete manufacturing line consumes one thing
-- and produces another: bags or calender rolls go IN, cartons or sacks come OUT.
-- work_unit_shift_reports needs one uom_* triple because a machine has one count
-- point; a line has two, and the ontology says so — area -> work center -> work
-- unit, with ms_code.count_points naming which machine is which.
--
-- So the counts do NOT share a unit:
--
--   total_out, reject, rework    ->  INFEED units   (what the line consumed)
--   good_out, effective_out      ->  OUTPUT units   (finished goods)
--
-- effective_out sits with good_out on the OUTPUT side by the pipeline owner's
-- confirmation, not by our inference — contract §16.4a. One consequence is worth
-- knowing before anyone builds a Line performance chart: total_out and
-- effective_out are therefore in DIFFERENT units at this grain, where at machine
-- grain they share one. apps/web/src/lib/perf-hourly.ts plots them on a single
-- shared Y axis today, which is correct for a machine and would put bags and
-- cartons on one scale for a line.
--
-- THEREFORE `total_out = good_out + reject + rework` IS FALSE AT THIS GRAIN, by
-- construction rather than by defect. 100 bags in yielding 10 cartons out is not
-- a 90% loss. Nothing in this schema and nothing on the shipped screens may
-- compute across the two sides.
--
-- This is not new in this codebase — it is the rule product_count_wu_shift
-- already follows, where total_out/reject/rework are converted to the base unit
-- while good_out stays in the production unit, and the SKU card carries a tooltip
-- saying the figures are not additive (apps/web/src/lib/product-count.ts holds
-- that pairing and its tests). The line grain makes the same split STRUCTURAL
-- instead of documentary.
--
-- WITHIN each side, NULL still means "the members disagreed", not "unknown", and
-- the counts are nulled WITH their label: `500 BAG + 12 CARTON = 512 <blank>` is
-- a wrong number with a missing label, not a smaller truth. That is the treatment
-- aggregateRejectReasons already gives a mixed bucket — the unit AND the figure.
-- The two guards are SEPARATE so a line can be certain about what it consumed and
-- abstain about what it shipped, or the reverse, without discarding either.
--
-- Durations are unaffected. Time is time, which is why the three list screens
-- (OEE / A / P / Q, no counts) are well defined regardless.
--
-- ---------------------------------------------------------------------------
-- SIX SEQUENCES NOW, NOT THREE
-- ---------------------------------------------------------------------------
--
-- These tables have their own identity columns, so there are now SIX report
-- tables with six independent id sequences. AGENTS.md's rule for the browser used
-- to be "pick your endpoint from report.grain"; it is now grain AND SUBJECT.
-- Calling a work-unit endpoint with a work-center report's id has two outcomes and
-- the quiet one is the dangerous half: a 404, or another line's data on another
-- date rendered without a warning.

-- ---------------------------------------------------------------------------
-- oee.work_center_shift_reports — one line, one shift
-- ---------------------------------------------------------------------------

CREATE TABLE oee.work_center_shift_reports (
  -- GENERATED ALWAYS rather than `serial`: 0008 and 0009 already moved off it,
  -- and an explicit-id insert failing loudly is a feature on a table this
  -- service never writes.
  id                       integer       GENERATED ALWAYS AS IDENTITY,

  -- ---- grain --------------------------------------------------------------
  work_center_id           integer       NOT NULL,
  business_date            date          NOT NULL,
  shift                    smallint      NOT NULL,
  time_zone                text          NOT NULL,

  -- ---- dimensions, denormalised -------------------------------------------
  work_center_name         varchar(255)  NOT NULL,
  work_center_code         varchar(255),
  area_id                  integer,
  area_name                varchar(255),
  -- A label for BI only. Nothing in this repo reads it, and it is NOT part of
  -- the upsert key — see divergence 2 in the header.
  month                    varchar(50),

  -- ---- how many machines the line has, and how many ran --------------------
  work_unit_count          integer       NOT NULL,
  expected_work_unit_count integer,

  -- ---- TWO units, because a line has two count points. See the header. -----
  -- infeed  ->  total_out, reject, rework
  -- output  ->  good_out, effective_out
  infeed_uom_id            integer,
  infeed_uom_name          varchar(255),
  infeed_uom_code          varchar(255),
  output_uom_id            integer,
  output_uom_name          varchar(255),
  output_uom_code          varchar(255),

  -- ---- rates. RECOMPUTED from the sums below, never averaged. --------------
  -- Nullable, unlike work_unit_*, because 0/0 is real here: a line whose machines
  -- were all in planned downtime has production_time = 0, and a fabricated 0%
  -- is a measurement where NULL is the truth. The screens already render NULL as
  -- an em dash.
  teep                     numeric(10,3),
  oee                      numeric(10,3),
  availability             numeric(10,3),
  performance              numeric(10,3),
  quality                  numeric(10,3),

  -- ---- counts. Each side is NULL as a SET when its own unit is NULL. ------
  total_out                numeric(15,3),
  good_out                 numeric(15,3),
  effective_out            numeric(15,3),
  reject                   numeric(15,3),
  rework                   numeric(15,3),

  -- ---- durations: the LINE's own measured time. NOT a sum over machines. ---
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
  schedule_loss_time       bigint        NOT NULL,
  -- Spelled correctly. 0013 killed the `availablity_loss_time` wart on the day
  -- and month tables; do not reintroduce it here "for symmetry".
  availability_loss_time   bigint        NOT NULL,
  performance_loss_time    bigint        NOT NULL,
  ms_loss_time             bigint        NOT NULL,
  reduce_speed_loss_time   bigint        NOT NULL,
  quality_loss_time        bigint        NOT NULL,

  -- ---- ratios. NULL = not computed. NO DEFAULT 0 — see 0013 and §15.4. -----
  mttr                     bigint,
  mtbf                     bigint,

  CONSTRAINT work_center_shift_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ck_wcsr_shift CHECK (shift BETWEEN 1 AND 3),
  -- 'YYYY-MM', specified by the pipeline owner before anything was written.
  -- §15.7 could not constrain the work_unit equivalent because its format was
  -- never stated and a guess would have failed the first load; here it was asked
  -- and answered while the table was empty, which is the whole point of settling
  -- it now. NULL stays legal — the column is a convenience, not a key.
  CONSTRAINT ck_wcsr_month_format CHECK (month IS NULL OR month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- A count with no unit is a wrong number with a missing label. These CHECKs can
  -- FAIL A LOAD, deliberately — the same call 0011 made for the reason array.
  -- ONE PER SIDE rather than one for both, so a line that knows what it consumed
  -- but not what it shipped keeps the half it is sure of.
  CONSTRAINT ck_wcsr_infeed_units CHECK (
    infeed_uom_id IS NOT NULL
    OR (total_out IS NULL AND reject IS NULL AND rework IS NULL)
  ),
  CONSTRAINT ck_wcsr_output_units CHECK (
    output_uom_id IS NOT NULL
    OR (good_out IS NULL AND effective_out IS NULL)
  ),
  CONSTRAINT ck_wcsr_work_unit_count CHECK (work_unit_count > 0)
);

-- The pipeline's upsert key (dbt `unique_key`).
CREATE UNIQUE INDEX wc_shift_report_key
  ON oee.work_center_shift_reports USING btree (business_date, shift, work_center_id);

-- TWO INDEXES PER TABLE, NOT FOUR, AND THE OMISSIONS ARE DELIBERATE.
--
-- The unique key above leads with business_date, so it already serves the list's
-- month range AND its `ORDER BY business_date DESC` (btree scans backwards). This
-- one serves the line-filtered read and the future one-line-over-time read.
--
-- work_unit_shift_reports also carries wu_shift_report_wu_idx — a dead left-prefix
-- of wu_shift_report_wu_date_idx — and wu_shift_report_shift_idx, which indexes a
-- column with THREE distinct values that no planner will use. Both cost write time
-- on every bulk load. Do not add their equivalents here for symmetry.
CREATE INDEX wc_shift_report_wc_date_idx
  ON oee.work_center_shift_reports USING btree (work_center_id, business_date DESC);

COMMENT ON COLUMN oee.work_center_shift_reports.runtime IS
  'The LINE''s own measured time, in ms — wall clock, NOT a sum over its machines. A four-machine line over an 8h shift has 8 hours here, not 32. Every *_time column reads the same way, and none equals the sum of the machines'' equivalents.';
COMMENT ON COLUMN oee.work_center_shift_reports.availability_time IS
  'The line''s own measured time — see runtime. TEEP''s denominator is the line''s calendar time, unscaled.';
COMMENT ON COLUMN oee.work_center_shift_reports.infeed_uom_id IS
  'The unit the line CONSUMED in; total_out, reject and rework are denominated in it. NULL means the members disagreed, not that it is unknown, and those three are NULL with it (ck_wcsr_infeed_units).';
COMMENT ON COLUMN oee.work_center_shift_reports.output_uom_id IS
  'The unit the line SHIPPED in; good_out and effective_out are denominated in it. Usually DIFFERENT from infeed_uom_id, which is why total_out <> good_out + reject + rework at this grain.';
COMMENT ON COLUMN oee.work_center_shift_reports.work_unit_count IS
  'Machines on this line that ran in this period. NOTHING is summed from them — the line is measured at its own count points — so this is context for the reader, never a divisor. Compare with expected_work_unit_count to see a line running short.';
COMMENT ON COLUMN oee.work_center_shift_reports.expected_work_unit_count IS
  'Machines the line HAS, per mes-master-data. NULL when the pipeline could not resolve it — never a guess. Contract §16.5.';
COMMENT ON COLUMN oee.work_center_shift_reports.month IS
  'A label for BI, format YYYY-MM (ck_wcsr_month_format). Nothing in mes-oee-monitor reads it, and it is deliberately NOT part of the upsert key — contract §16.1.';

-- ---------------------------------------------------------------------------
-- oee.work_center_day_reports — one line, one business day
-- ---------------------------------------------------------------------------
--
-- The shift table minus `shift` and its CHECK. Same columns, same rules, same
-- reading of the durations.

CREATE TABLE oee.work_center_day_reports (
  id                       integer       GENERATED ALWAYS AS IDENTITY,

  work_center_id           integer       NOT NULL,
  business_date            date          NOT NULL,
  time_zone                text          NOT NULL,

  work_center_name         varchar(255)  NOT NULL,
  work_center_code         varchar(255),
  area_id                  integer,
  area_name                varchar(255),
  month                    varchar(50),

  work_unit_count          integer       NOT NULL,
  expected_work_unit_count integer,

  infeed_uom_id            integer,
  infeed_uom_name          varchar(255),
  infeed_uom_code          varchar(255),
  output_uom_id            integer,
  output_uom_name          varchar(255),
  output_uom_code          varchar(255),

  teep                     numeric(10,3),
  oee                      numeric(10,3),
  availability             numeric(10,3),
  performance              numeric(10,3),
  quality                  numeric(10,3),

  total_out                numeric(15,3),
  good_out                 numeric(15,3),
  effective_out            numeric(15,3),
  reject                   numeric(15,3),
  rework                   numeric(15,3),

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
  schedule_loss_time       bigint        NOT NULL,
  availability_loss_time   bigint        NOT NULL,
  performance_loss_time    bigint        NOT NULL,
  ms_loss_time             bigint        NOT NULL,
  reduce_speed_loss_time   bigint        NOT NULL,
  quality_loss_time        bigint        NOT NULL,

  mttr                     bigint,
  mtbf                     bigint,

  CONSTRAINT work_center_day_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ck_wcdr_month_format CHECK (month IS NULL OR month ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT ck_wcdr_infeed_units CHECK (
    infeed_uom_id IS NOT NULL
    OR (total_out IS NULL AND reject IS NULL AND rework IS NULL)
  ),
  CONSTRAINT ck_wcdr_output_units CHECK (
    output_uom_id IS NOT NULL
    OR (good_out IS NULL AND effective_out IS NULL)
  ),
  CONSTRAINT ck_wcdr_work_unit_count CHECK (work_unit_count > 0)
);

CREATE UNIQUE INDEX wc_day_report_key
  ON oee.work_center_day_reports USING btree (business_date, work_center_id);

CREATE INDEX wc_day_report_wc_date_idx
  ON oee.work_center_day_reports USING btree (work_center_id, business_date DESC);

COMMENT ON COLUMN oee.work_center_day_reports.runtime IS
  'The LINE''s own measured time, in ms — wall clock, NOT a sum over its machines. Every *_time column on this table reads the same way.';
COMMENT ON COLUMN oee.work_center_day_reports.infeed_uom_id IS
  'The unit the line CONSUMED in — see the shift table. total_out, reject and rework are denominated in it.';
COMMENT ON COLUMN oee.work_center_day_reports.output_uom_id IS
  'The unit the line SHIPPED in. good_out and effective_out are denominated in it, and it is usually DIFFERENT from infeed_uom_id.';
COMMENT ON COLUMN oee.work_center_day_reports.work_unit_count IS
  'Machines on this line that ran. At this grain it is the MAX over the day''s shifts, not the sum — a day''s machine count is its busiest shift''s. Contract §16.3.';

-- ---------------------------------------------------------------------------
-- oee.work_center_month_reports — one line, one month
-- ---------------------------------------------------------------------------
--
-- The day table plus one CHECK. business_date is the FIRST business day of the
-- month — contract §15.3 says "not the last, and not midnight of the first", and
-- ck_wcmr_month_start is what makes that mechanical rather than editorial.

CREATE TABLE oee.work_center_month_reports (
  id                       integer       GENERATED ALWAYS AS IDENTITY,

  work_center_id           integer       NOT NULL,
  business_date            date          NOT NULL,
  time_zone                text          NOT NULL,

  work_center_name         varchar(255)  NOT NULL,
  work_center_code         varchar(255),
  area_id                  integer,
  area_name                varchar(255),
  month                    varchar(50),

  work_unit_count          integer       NOT NULL,
  expected_work_unit_count integer,

  infeed_uom_id            integer,
  infeed_uom_name          varchar(255),
  infeed_uom_code          varchar(255),
  output_uom_id            integer,
  output_uom_name          varchar(255),
  output_uom_code          varchar(255),

  teep                     numeric(10,3),
  oee                      numeric(10,3),
  availability             numeric(10,3),
  performance              numeric(10,3),
  quality                  numeric(10,3),

  total_out                numeric(15,3),
  good_out                 numeric(15,3),
  effective_out            numeric(15,3),
  reject                   numeric(15,3),
  rework                   numeric(15,3),

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
  schedule_loss_time       bigint        NOT NULL,
  availability_loss_time   bigint        NOT NULL,
  performance_loss_time    bigint        NOT NULL,
  ms_loss_time             bigint        NOT NULL,
  reduce_speed_loss_time   bigint        NOT NULL,
  quality_loss_time        bigint        NOT NULL,

  mttr                     bigint,
  mtbf                     bigint,

  CONSTRAINT work_center_month_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ck_wcmr_month_format CHECK (month IS NULL OR month ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT ck_wcmr_month_start CHECK (business_date = date_trunc('month', business_date)::date),
  CONSTRAINT ck_wcmr_infeed_units CHECK (
    infeed_uom_id IS NOT NULL
    OR (total_out IS NULL AND reject IS NULL AND rework IS NULL)
  ),
  CONSTRAINT ck_wcmr_output_units CHECK (
    output_uom_id IS NOT NULL
    OR (good_out IS NULL AND effective_out IS NULL)
  ),
  CONSTRAINT ck_wcmr_work_unit_count CHECK (work_unit_count > 0)
);

CREATE UNIQUE INDEX wc_month_report_key
  ON oee.work_center_month_reports USING btree (business_date, work_center_id);

CREATE INDEX wc_month_report_wc_date_idx
  ON oee.work_center_month_reports USING btree (work_center_id, business_date DESC);

COMMENT ON COLUMN oee.work_center_month_reports.runtime IS
  'The LINE''s own measured time, in ms — wall clock, NOT a sum over its machines. Every *_time column on this table reads the same way.';
COMMENT ON COLUMN oee.work_center_month_reports.business_date IS
  'The FIRST business day of the month, enforced by ck_wcmr_month_start. Contract §15.3.';
COMMENT ON COLUMN oee.work_center_month_reports.infeed_uom_id IS
  'The unit the line CONSUMED in — see the shift table. total_out, reject and rework are denominated in it.';
COMMENT ON COLUMN oee.work_center_month_reports.output_uom_id IS
  'The unit the line SHIPPED in. good_out and effective_out are denominated in it, and it is usually DIFFERENT from infeed_uom_id.';

-- ---------------------------------------------------------------------------
-- Watermarks
-- ---------------------------------------------------------------------------
--
-- WITHOUT THIS THE PIPELINE'S POST-HOOK FAILS ON ITS FIRST RUN. 0005's header is
-- explicit that extending this list is a migration, "which is the point".
--
-- Plain ALTER rather than a DO-block guard, matching 0009: DROP ... IF EXISTS
-- followed by ADD is idempotent as a pair, and if the constraint is not the shape
-- this file expects the ADD must fail rather than pass silently.
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
  'work_center_month_reports'
));

-- ---------------------------------------------------------------------------
-- Audit triggers
-- ---------------------------------------------------------------------------
--
-- oee.log_write() takes the primary key columns as trigger arguments precisely so
-- it needs no per-table variant. Statement-level for INSERT and row-level for
-- UPDATE/DELETE, for the reasons set out at length in 0004: the pipeline is the
-- bulk path and the operator is the precise one.
--
-- The row-level trigger is the tripwire for a claim this repo is making rather
-- than decoration: NO OPERATOR MUTATION TARGETS THESE THREE TABLES.
--
-- THAT CLAIM SURVIVED THE ARRIVAL OF A LINE APPROVAL, and the reason is worth
-- knowing before anyone "corrects" this paragraph. This file originally said there
-- was no line-level approval at all; there is one now, and it still writes nothing
-- here. Approving a line closes the MACHINE shift reports on it, in
-- oee.work_unit_shift_report_approvals — which is keyed
-- (work_unit_id, date, shift), a key these tables cannot supply because they have
-- no work_unit_id column. So the line's own status is DERIVED by counting those
-- rows, these three tables stay pipeline-owned, and there is still no line-level
-- downtime edit. If a write ever does land here, oee.write_audit is what will say
-- so. Migration 0015 adds a column to these tables and no writer.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_center_shift_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_center_shift_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('business_date', 'shift', 'work_center_id');

CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_center_day_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_center_day_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('business_date', 'work_center_id');

CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_center_month_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_center_month_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('business_date', 'work_center_id');
