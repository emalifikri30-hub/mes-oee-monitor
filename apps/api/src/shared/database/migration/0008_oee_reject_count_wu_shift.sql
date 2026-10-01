-- Per-counter reject totals behind the Losses page's Quality Loss Pareto.
--
-- WHY THIS FILE EXISTS
--
-- The Losses page renders five tabs. Four of them now rank something; Quality
-- Loss was a one-line placeholder, and unlike the others that was not a
-- rendering gap. TODOS.md §24 recorded the reason: `reject` and `rework` are
-- SCALARS on oee.work_unit_shift_reports, and `product_count_wu_shift` carries
-- the same two per SKU. Neither has a reason dimension, so there has never been
-- anything to rank. The design asks for a bar per reject reason, naming the
-- machine, the reason, its weight, the unit the SENSOR counted in, and the same
-- quantity converted to a comparable unit. Not one of those five is expressible
-- against any existing Gold table.
--
-- WHAT THIS FILE DOES NOT DO, AND CANNOT
--
-- It does not populate the table. docs/gold-write-contract.md §1 rule 2: this
-- service writes only named operator mutations and NEVER inserts. Every row
-- arrives from the `work_unit_*` DAG, which is filed as a requirement in §3.8 of
-- that document rather than assumed here. Until it does, the Quality Loss tab
-- renders its watermark-aware empty state — "not loaded yet", NOT "no rejects"
-- — which is the distinction oee.etl_watermarks exists for and the reason the
-- watermark CHECK below is amended in the same transaction.
--
-- Shipping the table ahead of the data is the same trade 0007 made, for the same
-- reason: the alternative is a screen that cannot be built until an unwritten
-- DAG lands. A dev seed lives at scripts/seed/0008_reject_count_dev.sql so the
-- populated path can be exercised by hand; it is deliberately outside this
-- directory, because migrate.mjs applies EVERY *.sql it finds here.
--
-- WHY A NEW TABLE RATHER THAN COLUMNS ON product_count_wu_shift
--
-- That table's grain is (work_unit, shift_date, shift, product). A reject reason
-- is a fifth key member, so adding one would RE-GRAIN every existing row — a
-- migration plus a backfill against a live table, and a silent doubling of every
-- SKU View figure if any consumer missed it. A separate table at its own grain
-- leaves the SKU read untouched.
--
-- BORN WITH A NATURAL KEY, which is the one thing downtime_reports still lacks.
-- contract §2.1 mandates DELETE-then-INSERT for that table because it has no
-- ON CONFLICT target; this one has a five-column primary key, so a DAG retry, a
-- DLQ replay or a backfill restates rather than duplicates. 0006 earned the same
-- note when product_perf_wu_hour replaced work_unit_perf_analytics.
--
-- TWO NUMBERS FOR ONE FACT, DELIBERATELY
--
-- `counter_value` is what the sensor counted, in `uom_code` — 48 CALENDER.
-- `converted_value` is the same rejects in `base_uom_code` — 576 BAG. The design
-- shows BOTH columns, because a plant reads its counters in their own units and
-- cannot compare them in those units. This is product_count_wu_shift's
-- factor_to_base doctrine (contract §3.4) with one difference worth naming:
-- there only the converted form ships and `good_out` is the lone exception; here
-- both forms ship side by side, and the UI labels each with its own unit.
--
-- `converted_value` IS GENERATED, AND THAT IS THE POINT
--
-- contract §3.3 records that downtime_reports.duration is written independently
-- of start_at/end_at and can disagree with them. That bug is not repeated in the
-- one column this chart plots: Postgres computes it and rejects any attempt to
-- assign to it. Consequence for dbt, reproduced in §3.5 for product_perf_wu_hour
-- and restated in §3.8 for this table: a naive `merge` fails with
-- `column "converted_value" can only be updated to DEFAULT`. Use
-- incremental_strategy='delete+insert', or
-- merge_exclude_columns=['converted_value'].
--
-- weight_gram IS NULLABLE, AND NULL IS NOT ZERO
--
-- The design annotates the Weight column "Some reason does not have weight
-- value". "Not weighed" and "weighed nothing" are different claims about a
-- counter and the screen renders them differently — an em dash against `0 gr`.
-- Two consequences the pipeline must respect (§3.8 says so normatively):
-- write NULL, never 0; and because sum() over an all-NULL set is NULL, a bucket
-- where nothing was weighed reports "not weighed" for free rather than needing a
-- special case in the reader.
--
-- reject_time IS NULLABLE AND NOTHING WRITES IT YET
--
-- The Pareto offers four rankings — converted quantity, weight, frequency and
-- duration. Only the fourth needs this column, and no upstream source measures
-- it today, so that radio ranks a column of zeros until the DAG fills it. Named
-- rather than hidden: this is the same treatment reduce_speed_loss_time got on
-- the Performance Loss tab (TODOS.md §28), and lib/pareto-rank.ts renders a zero
-- grand total as null percentages rather than NaN.
--
-- No foreign keys, for the reason 0003 gives: work_unit_id, work_center_id,
-- product_id, uom_id, reason_id and count_point_id all reference
-- mes-master-data, a different service and a different database. Names and codes
-- are denormalised onto the row so this read needs no mes-master-data call.
--
-- Plain CREATE TABLE / ALTER TABLE, not IF NOT EXISTS on the ALTERs: 0003's
-- header states that future changes belong in a new numbered migration using
-- plain ALTER TABLE, which FAILS LOUDLY rather than silently doing nothing
-- against a drifted table. Forward-only; scripts/migrate.mjs has no down path.
-- migrate.mjs runs this whole file in ONE transaction with its schema_migrations
-- row, so the CREATE and the watermark CHECK swap land together or not at all.

-- ---------------------------------------------------------------------------
-- oee.reject_count_wu_shift — per-counter rejects, one work unit, one shift
-- ---------------------------------------------------------------------------
--
-- Name obeys the grammar the schema already has: <subject>_<scope>_<grain>, as
-- in product_count_wu_shift and product_perf_wu_hour.
CREATE TABLE oee.reject_count_wu_shift (
  -- ---- grain --------------------------------------------------------------
  work_unit_id     integer       NOT NULL,
  -- The SHIFT's business day, a real `date` — matching
  -- product_count_wu_shift.shift_date and NOT the timestamptz that
  -- work_unit_shift_reports.date is. Shift 3 crosses midnight, so its
  -- post-midnight rejects carry the PREVIOUS calendar date.
  shift_date       date          NOT NULL,
  shift            smallint      NOT NULL,
  product_id       integer       NOT NULL,
  -- WHICH COUNTER recorded the rejects: `Total_NG_Prod`, `NG_Over_Count`. A
  -- primary-key member, so it must be STABLE — a renamed tag reads as a new
  -- counter and splits one shift's history in two. See §3.8.
  reason           varchar(255)  NOT NULL,

  -- ---- dimensions, denormalised -------------------------------------------
  -- NOT NULL, unlike its equivalent on the three report tables in 0003. The
  -- design annotates the Machine Name column "Should not empty", and a Pareto
  -- whose rows cannot say which machine they came from is not one.
  work_unit_name   varchar(255)  NOT NULL,
  work_unit_code   varchar(255),
  -- Nullable, like product_perf_wu_hour's area columns and for the same reason:
  -- carried because it is free on an empty table and expensive later, but NOT
  -- NULL here would block a first load over data this read does not need.
  work_center_id   integer,
  work_center_name varchar(255),
  product_name     varchar(255),
  product_code     varchar(255),

  -- ---- the reason's TWO identities ----------------------------------------
  -- A reject reason is a PLC counter tag upstream and a master-data record in
  -- ms_reject.reject_reasons; both are asked for, because the tag is what the
  -- HMI shows an operator and the master record is what a report groups by.
  -- Both nullable, and therefore neither can be a key member — which is why
  -- `reason` above carries the identity the primary key needs.
  reason_code      varchar(255),
  reason_id        integer,
  source_tag       varchar(255),
  count_point_id   integer,

  -- ---- the counter, in the SENSOR's own unit -------------------------------
  uom_id           integer       NOT NULL,
  uom_name         varchar(255),
  uom_code         varchar(255)  NOT NULL,
  counter_value    numeric(15,3) NOT NULL,

  -- ---- the same rejects, in the comparable unit ---------------------------
  base_uom_id      integer       NOT NULL,
  base_uom_name    varchar(255),
  base_uom_code    varchar(255)  NOT NULL,
  factor_to_base   numeric(10,3) NOT NULL,
  converted_value  numeric(15,3)
    GENERATED ALWAYS AS (round(counter_value * factor_to_base, 3)) STORED,

  -- ---- weight -------------------------------------------------------------
  weight_gram      numeric(15,3),

  -- ---- occurrence and duration -------------------------------------------
  frequency        integer       NOT NULL,
  reject_time      bigint,

  -- ---- provenance ---------------------------------------------------------
  -- The IANA zone shift_date was cut in, denormalised so the business-day rule
  -- is auditable from the data rather than from a DAG's source. 0006 does the
  -- same for its hour buckets, and for the same reason.
  time_zone        varchar(64)   NOT NULL,

  CONSTRAINT pk_reject_count_wu_shift
    PRIMARY KEY (work_unit_id, shift_date, shift, product_id, reason),
  CONSTRAINT ck_rcwus_shift  CHECK (shift BETWEEN 1 AND 3),
  -- Same admission as product_count_wu_shift: any positive value passes, so a
  -- wrong-but-positive factor renders a plausible number rather than failing.
  -- contract §3.4 asks for the per-(product, uom, base_uom) guarantee nothing
  -- downstream can validate.
  CONSTRAINT ck_rcwus_factor CHECK (factor_to_base > 0),
  -- An empty or whitespace reason would become an unlabelled bar with a
  -- primary-key row behind it, which is worse than a rejected load.
  CONSTRAINT ck_rcwus_reason CHECK (btrim(reason) <> ''),
  CONSTRAINT ck_rcwus_nonneg CHECK (
    counter_value >= 0 AND frequency >= 0
    AND (weight_gram IS NULL OR weight_gram >= 0)
    AND (reject_time IS NULL OR reject_time >= 0)
  ),
  -- A counter that recorded a quantity must have recorded an occurrence. ONE
  -- DIRECTION ONLY: frequency > 0 with counter_value = 0 is legitimate — the
  -- counter fired and nothing was rejected. The reverse is not: a row would
  -- rank in the quantity measure and vanish from the frequency one, which is a
  -- chart disagreeing with its own table.
  CONSTRAINT ck_rcwus_freq_agrees CHECK (counter_value = 0 OR frequency > 0)
);

-- Two indexes, and no more. This service's only read is a join on the report's
-- (work_unit_id, shift_date, shift) — the primary key's LEFT PREFIX, exactly as
-- pk_product_count_wu_shift serves listProductCount — so it needs none of its
-- own. Both below are for the pipeline and ad-hoc reporting, mirroring the pair
-- product_count_wu_shift carries for the same purpose.

-- "Which counter dominates, over time" — the question this table exists to make
-- askable above one shift.
CREATE INDEX ix_rcwus_reason_date
  ON oee.reject_count_wu_shift USING btree (reason, shift_date);

-- Per-SKU rejects over a date range. Mirrors pcwus_ix_shift_pcs_product.
CREATE INDEX ix_rcwus_product_date
  ON oee.reject_count_wu_shift USING btree (product_id, shift_date);

-- ---------------------------------------------------------------------------
-- Column documentation, for the consumers who never open this file
-- ---------------------------------------------------------------------------
--
-- 0006's convention and its reason: the explanatory header above is invisible to
-- Power BI, Metabase, DBeaver and `\d+`. COMMENT ON is not. The counter-versus-
-- converted distinction is the first thing an analyst will get wrong, so it is
-- stated where that analyst will actually see it.
COMMENT ON TABLE oee.reject_count_wu_shift IS
  'Per-counter reject totals for one work unit, one shift and one product. '
  'Grain: (work_unit_id, shift_date, shift, product_id, reason). shift_date is '
  'the SHIFT''s business day, so shift-3 rejects after midnight carry the '
  'previous calendar date. counter_value is in uom_code (as the sensor counted); '
  'converted_value is the same rejects in base_uom_code and is the only figure '
  'comparable or summable across counters. EMPTY until the work_unit_* DAG '
  'writes it — see docs/gold-write-contract.md §3.8.';

COMMENT ON COLUMN oee.reject_count_wu_shift.shift_date IS
  'The SHIFT''s business day, as a real date. Matches product_count_wu_shift.shift_date, NOT work_unit_shift_reports.date (a shift-start instant).';
COMMENT ON COLUMN oee.reject_count_wu_shift.reason IS
  'The counter that recorded the rejects, e.g. Total_NG_Prod. A PRIMARY KEY MEMBER, so it must be stable across runs: a renamed tag reads as a new counter and splits a shift''s history.';
COMMENT ON COLUMN oee.reject_count_wu_shift.work_unit_name IS
  'Denormalised machine name. NOT NULL, unlike the report tables: the Quality Loss Pareto names the machine on every row.';
COMMENT ON COLUMN oee.reject_count_wu_shift.reason_code IS
  'ms_reject.reject_reasons.code, where the counter maps to a master-data reject reason. NULL until resolved; nullable, so not a key member.';
COMMENT ON COLUMN oee.reject_count_wu_shift.reason_id IS
  'ms_reject.reject_reasons.id. Denormalised alongside reason_code for the same reason product and UOM names are.';
COMMENT ON COLUMN oee.reject_count_wu_shift.source_tag IS
  'The PLC tag behind the counter, as ms_core.count_points.source_tag. The provenance half of the reason''s identity.';
COMMENT ON COLUMN oee.reject_count_wu_shift.count_point_id IS
  'ms_core.count_points.id, where the counter is a configured count point.';
COMMENT ON COLUMN oee.reject_count_wu_shift.uom_code IS
  'The unit the SENSOR counted in — BAG, CALENDER. counter_value is denominated in this and is NOT comparable across counters.';
COMMENT ON COLUMN oee.reject_count_wu_shift.counter_value IS
  'Rejects as counted, in uom_code. Never scaled. Summing this across rows with different uom_code is meaningless; the reader nulls the unit in that case and the UI renders an em dash.';
COMMENT ON COLUMN oee.reject_count_wu_shift.base_uom_code IS
  'The comparable unit. converted_value is denominated in this. Converging on ONE base unit per work unit is what keeps the converted column comparable — see contract §3.8.';
COMMENT ON COLUMN oee.reject_count_wu_shift.factor_to_base IS
  'Converts counter_value to base_uom_code. Same semantics and same open caveat as product_count_wu_shift.factor_to_base (contract §3.4): any positive value passes and nothing downstream can validate it.';
COMMENT ON COLUMN oee.reject_count_wu_shift.converted_value IS
  'GENERATED ALWAYS AS round(counter_value * factor_to_base, 3) STORED — the database computes it and rejects any assignment. The figure the Pareto plots, and the only one summable across counters. A naive dbt merge fails on this column; use delete+insert or merge_exclude_columns.';
COMMENT ON COLUMN oee.reject_count_wu_shift.weight_gram IS
  'Reject weight in grams. NULL means NOT WEIGHED and must never be written as 0, which means weighed-and-empty: the UI renders the two differently, and sum() over an all-NULL bucket yields NULL, which is the semantics the screen depends on.';
COMMENT ON COLUMN oee.reject_count_wu_shift.frequency IS
  'How many reject records stand behind this row. The Pareto''s frequency ranking.';
COMMENT ON COLUMN oee.reject_count_wu_shift.reject_time IS
  'Milliseconds of production time lost to this counter, like work_unit_shift_reports.reject_time. NULL until the DAG measures it, and until then the Pareto''s duration ranking is a column of zeros.';
COMMENT ON COLUMN oee.reject_count_wu_shift.time_zone IS
  'The IANA zone shift_date was cut in. Makes the business-day rule auditable from the data rather than from a DAG''s source.';

-- ---------------------------------------------------------------------------
-- The watermark vocabulary — seven names becomes eight
-- ---------------------------------------------------------------------------
--
-- 0005 constrains etl_watermarks.table_name to the real table names precisely
-- because `{{ this.identifier }}` resolves to the dbt MODEL name. Extending the
-- list is a migration, which is the point: without the check a renamed-but-not-
-- repointed model would write a watermark under a key no reader looks at, and
-- nothing would fail.
--
-- CONSEQUENCE WORTH READING TWICE, and it is the same one 0006 shipped: the dbt
-- MODEL MUST BE NAMED `reject_count_wu_shift`. A mismatched name fails the
-- watermark insert loudly. If your insert is rejected, the model name is wrong,
-- not the check.
--
-- This watermark is not optional decoration. The Quality Loss tab renders an
-- empty result two different ways — "no rejects recorded for this shift" and
-- "not loaded yet" — and the second is the honest one until the DAG runs. With
-- no row here every reader must assume never-loaded, which is correct today and
-- becomes wrong silently the moment rows arrive without a watermark.
--
-- Plain ALTER rather than a DO-block guard: DROP ... IF EXISTS followed by ADD
-- is idempotent as a pair, and if the constraint is not the shape this file
-- expects the ADD must fail rather than pass silently.
ALTER TABLE oee.etl_watermarks DROP CONSTRAINT IF EXISTS ck_etl_watermarks_table;
ALTER TABLE oee.etl_watermarks ADD CONSTRAINT ck_etl_watermarks_table CHECK (table_name IN (
  'work_unit_shift_reports',
  'work_unit_day_reports',
  'work_unit_month_reports',
  'downtime_reports',
  'product_count_wu_shift',
  'product_count_wu_day',
  'product_perf_wu_hour',
  'reject_count_wu_shift'
));

-- ---------------------------------------------------------------------------
-- Audit triggers
-- ---------------------------------------------------------------------------
--
-- oee.log_write() takes the primary key columns as trigger arguments precisely
-- so it needs no per-table variant. Statement-level for INSERT and row-level for
-- UPDATE/DELETE, for the reasons set out at length in 0004: the pipeline is the
-- bulk path and the operator is the precise one. No operator mutation targets
-- this table today, and the row-level trigger is what will notice if that ever
-- quietly changes.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.reject_count_wu_shift
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.reject_count_wu_shift
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_unit_id', 'shift_date', 'shift', 'product_id', 'reason');
