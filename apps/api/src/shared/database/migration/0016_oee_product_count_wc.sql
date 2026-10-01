-- ===========================================================================
-- 0016 — per-SKU output at the LINE grain: oee.product_count_wc_{shift,day}
-- ===========================================================================
--
-- Two new tables holding the same per-product counts as
-- oee.product_count_wu_{shift,day}, measured at the LINE's own count points
-- instead of at one machine's. They back the SKU View card on the
-- `Report > Line > … > Detail Report` screens.
--
-- WRITTEN BY Apache Airflow -> dbt, exactly as every other Gold table is. This
-- service NEVER inserts into them; docs/gold-write-contract.md §17 is the
-- specification.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT A ROLL-UP — this is the whole reason the file exists
-- ---------------------------------------------------------------------------
--
-- TODOS.md §15 has been open since 0003 asking where wider-than-one-machine
-- product counts come from, and it framed the blocker as UNIT CONVERSION:
-- `factor_to_base` differs per product, so summing across machines has to happen
-- after conversion to a base unit, and the "Finish Good stays in its production
-- unit" rule stops being expressible once two machines count the same SKU in
-- different units. That is true, and it is not the strongest argument.
--
-- THE STRONGEST ARGUMENT IS RECONCILIATION. 0014's header and commit 4fccce8
-- establish that a line is MEASURED, not summed: it has its own count points, so
-- `line <> sum(machines)` — and that is a fact about the plant, not a defect.
-- The Line detail screen renders the line's own total_out and good_out in its
-- overview card, and SKU View sits DIRECTLY BELOW IT.
--
-- So a SKU View rolled up from oee.product_count_wu_shift would print per-SKU
-- totals that visibly disagree with the card above them, ON THE SAME SCREEN, and
-- the disagreement would be CORRECT. There is no sentence a supervisor can be
-- given that makes two contradicting sets of numbers on one page acceptable.
-- Only the line's own per-product count points reconcile, and no read-time query
-- over the machine tables can produce them.
--
-- That also settles §15 for this grain: the answer is a table, not a documented
-- roll-up.
--
-- ---------------------------------------------------------------------------
-- TWO TABLES, NOT THREE, AND NO MONTH TABLE
-- ---------------------------------------------------------------------------
--
-- The report tables at this grain come in three (0014). These come in two, and
-- deliberately: `listPeriodProductCount` in work-unit-repository.ts already
-- proves a DAY table serves both coarse grains by widening it over an interval,
-- which is why oee.product_count_wu_month does not exist either. A month table
-- would be a third thing for the pipeline to keep consistent, and a third place
-- for a sum to drift, in exchange for a read this service does not make.
--
-- ---------------------------------------------------------------------------
-- THE TWO UNITS PER ROW ARE UNCHANGED FROM THE MACHINE TABLES
-- ---------------------------------------------------------------------------
--
-- 0014 had to invent an infeed/output split because a LINE REPORT carries one
-- row per period and needed two units on it. A PRODUCT COUNT row already had
-- that shape:
--
--   total_out, reject, rework  ->  scaled by factor_to_base into base_uom_*
--   good_out                   ->  NOT scaled. Finish Good stays in uom_*.
--
-- apps/web/src/lib/product-count.ts renders exactly that pairing and carries the
-- tooltip saying the figures are not additive across it. Nothing about it changes
-- at line grain, so nothing about it is redesigned here — the columns are the
-- machine tables' columns.
--
-- ---------------------------------------------------------------------------
-- THREE DIVERGENCES FROM THE MACHINE PAIR, all of them 0014's
-- ---------------------------------------------------------------------------
--
-- 1. `business_date`, NOT `shift_date` or a bare `date`. One name for the same
--    concept across every work_center_* table, and no `date timestamptz` column
--    anywhere at this grain — 0014's divergence 1 at length.
-- 2. `time_zone` and `work_center_name` are NOT NULL. These tables are empty, so
--    there is no populated-table excuse for nullable (0014's divergence 3), and a
--    row whose business_date the pipeline has not written is invisible to every
--    window filter while still existing.
-- 3. GENERATED ALWAYS is NOT used, because these tables have no identity column
--    at all — like the machine product-count tables, their primary key is the
--    natural one. Nothing deep-links to a product-count row.
--
-- PLAIN `CREATE TABLE`, not IF NOT EXISTS: 0003 is all-idempotent because it is
-- applied against an already-populated database and therefore cannot reconcile
-- drift. These two exist nowhere, so a silent no-op against a drifted schema is
-- the failure to avoid rather than the behaviour to copy — 0014's call.

-- ---------------------------------------------------------------------------
-- oee.product_count_wc_shift — one line, one shift, one product
-- ---------------------------------------------------------------------------

CREATE TABLE oee.product_count_wc_shift (
  work_center_id    integer       NOT NULL,
  business_date     date          NOT NULL,
  shift             smallint      NOT NULL,
  time_zone         text          NOT NULL,

  work_center_name  varchar(255)  NOT NULL,
  work_center_code  varchar(255),

  product_id        integer       NOT NULL,
  product_name      varchar(255)  NOT NULL,
  product_code      varchar(255)  NOT NULL,

  -- The unit the line COUNTED this product in, and the base it converts to.
  -- Both NOT NULL, unlike the report tables' nullable uom triples: a product
  -- count row is per PRODUCT, so there is no "the members disagreed" case to
  -- express — if the line cannot name the unit for one product, that product has
  -- no row rather than a row with a hole in it.
  uom_id            integer       NOT NULL,
  uom_name          varchar(255)  NOT NULL,
  uom_code          varchar(255)  NOT NULL,
  base_uom_id       integer       NOT NULL,
  base_uom_name     varchar(255)  NOT NULL,
  base_uom_code     varchar(255)  NOT NULL,
  factor_to_base    numeric(10,3) NOT NULL,

  total_out         numeric(15,3) NOT NULL,
  good_out          numeric(15,3) NOT NULL,
  reject            numeric(15,3) NOT NULL,
  rework            numeric(15,3) NOT NULL,

  CONSTRAINT pk_product_count_wc_shift
    PRIMARY KEY (work_center_id, business_date, shift, product_id),
  CONSTRAINT ck_pcwcs_shift  CHECK (shift BETWEEN 1 AND 3),
  -- Admits any positive value, exactly as ck_pcwus_factor does, so a
  -- wrong-but-positive factor renders a plausible number rather than failing the
  -- load. Contract §17 asks for the per-(product, uom, base_uom) guarantee
  -- nothing downstream can validate — the same ask §3.4 makes of the machine pair.
  CONSTRAINT ck_pcwcs_factor CHECK (factor_to_base > 0),
  CONSTRAINT ck_pcwcs_nonneg CHECK (
    total_out >= 0 AND good_out >= 0 AND reject >= 0 AND rework >= 0
  )
);

-- The primary key's left prefix (work_center_id, business_date, shift) already
-- serves the detail screen's read, which is the only query this service issues
-- against this table. One secondary index for the per-SKU-over-time question BI
-- will ask; the machine tables' third index is a dead left-prefix and is not
-- copied here (0014's note on wu_shift_report_wu_idx).
CREATE INDEX ix_pcwcs_product_date
  ON oee.product_count_wc_shift USING btree (product_id, business_date DESC);

COMMENT ON TABLE oee.product_count_wc_shift IS
  'Per-SKU output measured at the LINE''s own count points, one row per (line, business date, shift, product). NOT a roll-up of oee.product_count_wu_shift — a line is measured rather than summed, so a roll-up would contradict oee.work_center_shift_reports on the same screen. Contract §17.';
COMMENT ON COLUMN oee.product_count_wc_shift.good_out IS
  'Finish Good, in uom_* and deliberately NOT scaled by factor_to_base — the rule oee.product_count_wu_shift already follows. total_out, reject and rework scale into base_uom_*, which is why a reader must not add across the two.';

-- ---------------------------------------------------------------------------
-- oee.product_count_wc_day — the same rolled up to a business day
-- ---------------------------------------------------------------------------
--
-- The shift table minus `shift` and its CHECK. SERVES THE MONTH GRAIN TOO, by
-- being widened over an interval — see the header, and listPeriodProductCount for
-- the machine equivalent already doing it.

CREATE TABLE oee.product_count_wc_day (
  work_center_id    integer       NOT NULL,
  business_date     date          NOT NULL,
  time_zone         text          NOT NULL,

  work_center_name  varchar(255)  NOT NULL,
  work_center_code  varchar(255),

  product_id        integer       NOT NULL,
  product_name      varchar(255)  NOT NULL,
  product_code      varchar(255)  NOT NULL,

  uom_id            integer       NOT NULL,
  uom_name          varchar(255)  NOT NULL,
  uom_code          varchar(255)  NOT NULL,
  base_uom_id       integer       NOT NULL,
  base_uom_name     varchar(255)  NOT NULL,
  base_uom_code     varchar(255)  NOT NULL,
  factor_to_base    numeric(10,3) NOT NULL,

  total_out         numeric(15,3) NOT NULL,
  good_out          numeric(15,3) NOT NULL,
  reject            numeric(15,3) NOT NULL,
  rework            numeric(15,3) NOT NULL,

  CONSTRAINT pk_product_count_wc_day
    PRIMARY KEY (work_center_id, business_date, product_id),
  CONSTRAINT ck_pcwcd_factor CHECK (factor_to_base > 0),
  CONSTRAINT ck_pcwcd_nonneg CHECK (
    total_out >= 0 AND good_out >= 0 AND reject >= 0 AND rework >= 0
  )
);

CREATE INDEX ix_pcwcd_product_date
  ON oee.product_count_wc_day USING btree (product_id, business_date DESC);

COMMENT ON TABLE oee.product_count_wc_day IS
  'Per-SKU output at the LINE grain, one row per (line, business date, product). Read for BOTH the day and month screens, widened over an interval — there is deliberately no product_count_wc_month, mirroring the absence of product_count_wu_month. Contract §17.';

-- ---------------------------------------------------------------------------
-- Watermarks
-- ---------------------------------------------------------------------------
--
-- WITHOUT THIS THE PIPELINE'S POST-HOOK FAILS ON ITS FIRST RUN — 0005's header is
-- explicit that extending this list is a migration, "which is the point", and
-- 0014 had to do the same. DROP IF EXISTS followed by ADD is idempotent as a
-- pair, and if the constraint is not the shape this file expects the ADD must
-- fail rather than pass silently.
--
-- The watermark is what lets SKU View say "not loaded yet" instead of "this line
-- produced nothing" — opposite claims about the same empty card, and until the
-- pipeline writes these tables the second one is a lie. TODOS §14 is the item
-- that established the distinction.
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
  'product_count_wc_day'
));

-- ---------------------------------------------------------------------------
-- Audit triggers
-- ---------------------------------------------------------------------------
--
-- Statement-level for INSERT and row-level for UPDATE/DELETE, for the reasons set
-- out at length in 0004: the pipeline is the bulk path and the operator is the
-- precise one. oee.log_write() takes the primary key columns as arguments so it
-- needs no per-table variant.
--
-- The row-level trigger is the tripwire for the same claim 0014 makes and that
-- survived a line approval arriving: NO OPERATOR MUTATION TARGETS THESE TABLES.
-- Note that the reject/rework ENTRY feature the Losses card now shows as disabled
-- buttons would be exactly such a mutation — and it must not land here. These
-- rows are the pipeline's measurement; an operator's correction is a different
-- fact and needs its own table and its own trail.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_count_wc_shift
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_count_wc_shift
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_center_id', 'business_date', 'shift', 'product_id');

CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_count_wc_day
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_count_wc_day
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_center_id', 'business_date', 'product_id');
