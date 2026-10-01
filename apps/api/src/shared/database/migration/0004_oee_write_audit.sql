-- Write attribution for the `oee` schema.
--
-- WHY
--
-- Two writers share these tables and the database cannot currently tell them
-- apart:
--
--   * Apache Airflow -> dbt does every BULK write, aggregating Silver into Gold.
--   * This service does narrow OPERATOR mutations — approving a shift report,
--     and editing a downtime's category / reasons / actions.
--
-- Today both would be indistinguishable. Everything connects as the `webadmin`
-- superuser with a blank `application_name`, and all seven tables have no grants
-- at all (`relacl` is NULL), so nothing recorded anywhere says whether a row was
-- last touched by the pipeline or by a person. That matters twice over: it is
-- what will confirm the DAG behaves as specified on its first real run, and it
-- is what answers "who approved this report?" afterwards.
--
-- See `docs/gold-write-contract.md` for the ownership rules this enforces.
--
-- WHY INSERTs ARE AUDITED PER STATEMENT AND NOT PER ROW
--
-- This is the one decision in this file worth understanding before changing it.
--
-- The two axes do not have the same volume. Operator mutations are UPDATEs, a
-- handful per shift. The ETL's INSERTs are the bulk path: at the 500-work-unit
-- target that is roughly 18M `downtime_reports` rows a year. Auditing those per
-- row would DOUBLE the write volume of the pipeline to record nothing anyone
-- would read — every row of one bulk load has the same writer, the same instant
-- and the same application_name.
--
-- So INSERT fires `FOR EACH STATEMENT` (one audit row per load, `row_key` NULL)
-- and UPDATE/DELETE fire `FOR EACH ROW` (one audit row each, carrying the
-- primary key). Attribution for the pipeline, precision for the operator, and
-- no per-row cost on the path that actually has volume. Deliberately no
-- transition tables (`REFERENCING NEW TABLE`): they would materialise a
-- tuplestore of every inserted row purely to count it, which is the cost this
-- design exists to avoid. Row counts belong in `oee.etl_watermarks` (0005).
--
-- IDEMPOTENT, like 0003 — `GOLD_DATABASE_URL` points at a populated database
-- that has never run `db:migrate`, so the first real run applies this against
-- live data and must be repeatable. `CREATE OR REPLACE TRIGGER` needs
-- PostgreSQL 14+; the server is 18.4.

CREATE TABLE IF NOT EXISTS oee.write_audit (
  id                bigserial   NOT NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  table_name        text        NOT NULL,
  operation         text        NOT NULL,
  -- The changed row's primary key, as {column: value}. NULL for a statement-level
  -- INSERT, which by design does not know which rows it wrote.
  row_key           jsonb,
  db_user           text        NOT NULL,
  -- NULL when the client never set one. `tierPool` in infra-module.ts sets it for
  -- this service; the contract doc asks dbt to set it too, which is what makes
  -- this column able to separate the two writers.
  application_name  text,
  -- NULL over a unix socket.
  client_addr       inet,
  CONSTRAINT write_audit_pkey PRIMARY KEY (id),
  CONSTRAINT ck_write_audit_operation CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE'))
);

-- The two questions this table gets asked: "what happened to this table lately"
-- and "what happened to this row". Nothing scans it whole.
CREATE INDEX IF NOT EXISTS write_audit_ix_table_at
  ON oee.write_audit USING btree (table_name, at DESC);

CREATE INDEX IF NOT EXISTS write_audit_ix_row_key
  ON oee.write_audit USING gin (row_key);

-- One function for all seven tables. The primary key columns differ per table —
-- five are `id`, the two product-count tables are composite — so they arrive as
-- trigger arguments rather than being hard-coded here.
CREATE OR REPLACE FUNCTION oee.log_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  key_data jsonb;
  col      text;
BEGIN
  -- Statement-level: TG_LEVEL is 'STATEMENT' and neither NEW nor OLD exists.
  IF TG_LEVEL = 'STATEMENT' THEN
    key_data := NULL;
  ELSE
    row_data := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    key_data := '{}'::jsonb;
    FOREACH col IN ARRAY TG_ARGV LOOP
      key_data := key_data || jsonb_build_object(col, row_data -> col);
    END LOOP;
  END IF;

  INSERT INTO oee.write_audit (table_name, operation, row_key, db_user, application_name, client_addr)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    key_data,
    current_user,
    -- `true` = missing_ok. Comes back as '' rather than NULL when unset, hence nullif.
    nullif(current_setting('application_name', true), ''),
    inet_client_addr()
  );

  -- AFTER trigger: the return value is ignored.
  RETURN NULL;
END
$$;

-- oee.work_unit_shift_reports — PK (id)
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_unit_shift_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_unit_shift_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

-- oee.work_unit_day_reports — PK (id)
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_unit_day_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_unit_day_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

-- oee.work_unit_month_reports — PK (id)
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_unit_month_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_unit_month_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

-- oee.work_unit_perf_analytics — PK (id)
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_unit_perf_analytics
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_unit_perf_analytics
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

-- oee.downtime_reports — PK (id). The operator-edit target: category, reason, actions.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.downtime_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.downtime_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

-- oee.product_count_wu_shift — composite PK (work_unit_id, shift_date, shift, product_id)
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_count_wu_shift
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_count_wu_shift
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_unit_id', 'shift_date', 'shift', 'product_id');

-- oee.product_count_wu_day — composite PK (work_unit_id, date, product_id)
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_count_wu_day
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_count_wu_day
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_unit_id', 'date', 'product_id');
