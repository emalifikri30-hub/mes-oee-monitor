-- Partition oee.write_audit by month, so retention becomes a DROP rather than a
-- DELETE that rewrites a GIN index.
--
-- WHY NOW, WHILE THE TABLE HOLDS 111 ROWS
--
-- TODOS.md §35's argument was never that the table is big — it is that it grows
-- monotonically, nothing has ever pruned it, and the volume arrives with the first
-- real pipeline run. 0004 was careful on the WRITE side (INSERTs audited per
-- STATEMENT, not per row, so ~18M downtime_reports rows a year do not double the
-- write volume) and said nothing about how long any of it is kept. Converting a
-- table with 111 rows is free; converting it after the pipeline starts is not.
--
-- RETENTION: 12 MONTHS FOR EVERYTHING, INCLUDING THE OPERATOR ROWS
--
-- That decision reverses the suggestion in §35, which proposed keeping
-- `application_name = 'mes-oee-monitor-operator'` rows indefinitely. It was
-- reversed on a fact, not a preference: THOSE ROWS ARE NOT THE DURABLE RECORD.
--
--   oee.work_unit_shift_report_approval_events   by_subject, by_name,
--                                                from_status, to_status, at
--   oee.downtime_report_history                  changed_by, field,
--                                                old_value, new_value, changed_at
--
-- Both are append-only, neither is pruned by anything, and both carry strictly
-- MORE than write_audit does — who changed which field from what to what, rather
-- than "the operator role touched a row". contract §5 says the operator-name query
-- is "a complete list of every operator write ever made", which is true and is a
-- different claim from being the record you would go to. §14 of that document is
-- amended to say where the durable trail actually lives.
--
-- What write_audit is left being is what 0004 built it for: low-level "which db
-- user touched which row, from where" forensics during an incident. That question
-- has a short horizon, and it has no reader in this repo at all.
--
-- AND THE ALTERNATIVE DID NOT SURVIVE CONTACT WITH POSTGRES. Exempting operator
-- rows from a monthly drop is impossible in a single RANGE-partitioned table: a
-- partition is dropped WHOLESALE, so you cannot spare rows inside one. Honouring
-- the exemption structurally needs LIST (writer_kind) -> RANGE (at)
-- sub-partitioning, a new NOT NULL column for the trigger to populate, and a
-- three-column primary key — a two-level scheme every future reader has to hold in
-- their head, to protect a secondary copy of a trail that is already kept twice.
--
-- THE PRIMARY KEY HAD TO CHANGE, AND THAT IS NOT OPTIONAL
--
--   ERROR: unique constraint on partitioned table must include all partitioning
--          columns
--   DETAIL: PRIMARY KEY constraint on table "write_audit" lacks column "at" which
--           is part of the partition key.
--
-- So `PRIMARY KEY (id)` becomes `PRIMARY KEY (id, at)`. `id` remains globally
-- unique in practice — it is one bigserial shared by every partition — but the
-- DATABASE now only guarantees uniqueness of the pair. Nothing joins to this table
-- and nothing reads it from this service, so that is a statement about the
-- constraint rather than about the data.
--
-- THE FAILURE MODE THIS FILE IS SHAPED AROUND
--
-- A partitioned table REJECTS an insert with no matching partition. 0004 attached a
-- trigger pair to TWELVE Gold tables, all of which write here, so a missing month
-- would not degrade the audit log — it would fail every write to Gold, including
-- the pipeline's loads and both operator mutations. That is a far worse outcome
-- than an unpruned table.
--
-- Hence a DEFAULT partition, which is the whole reason this is safe: a row for a
-- month nobody created lands there instead of erroring. It converts "all writes
-- fail" into "some rows are in the wrong place", which is recoverable at leisure.
--
-- ONE CONSEQUENCE, and it is the reason to keep the monthly window wide: a new
-- partition CANNOT be attached while the DEFAULT partition holds rows that would
-- belong to it. Postgres scans DEFAULT on attach and refuses if any row matches.
-- So letting rows accumulate in DEFAULT is not harmless — it makes creating that
-- month's partition a data-move rather than a DDL statement. The maintenance
-- function at the bottom reports how many rows are sitting there, for exactly
-- this reason.
--
-- Plain DDL, forward-only, and deliberately NOT idempotent past the first
-- statement: it must fail loudly against a drifted database rather than half-apply.
-- scripts/migrate.mjs runs each file in a transaction, so the swap below is atomic
-- — a concurrent audited write blocks on the rename's lock and then proceeds
-- against the new table. Nothing is lost and no trigger ever sees a missing table.

-- ---------------------------------------------------------------------------
-- 1. Move the existing table aside. Renaming takes ACCESS EXCLUSIVE, so any
--    concurrent write blocks here until this transaction commits.
-- ---------------------------------------------------------------------------
ALTER TABLE oee.write_audit RENAME TO write_audit_legacy;
ALTER TABLE oee.write_audit_legacy RENAME CONSTRAINT write_audit_pkey TO write_audit_legacy_pkey;
ALTER INDEX oee.write_audit_ix_table_at RENAME TO write_audit_legacy_ix_table_at;
ALTER INDEX oee.write_audit_ix_row_key  RENAME TO write_audit_legacy_ix_row_key;

-- ---------------------------------------------------------------------------
-- 2. The partitioned table, under the original name so oee.log_write() — which
--    names `oee.write_audit` literally — needs no change at all.
-- ---------------------------------------------------------------------------
CREATE TABLE oee.write_audit (
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
  -- (id, at) rather than (id): `at` is the partition key and Postgres requires
  -- every unique constraint to contain it. See the header.
  CONSTRAINT write_audit_pkey PRIMARY KEY (id, at),
  CONSTRAINT ck_write_audit_operation CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE'))
) PARTITION BY RANGE (at);

-- Declared on the parent, which propagates them to every partition — existing and
-- future — so a new month is never silently unindexed.
--
-- The two questions this table gets asked: "what happened to this table lately"
-- and "what happened to this row". Nothing scans it whole.
CREATE INDEX write_audit_ix_table_at ON oee.write_audit USING btree (table_name, at DESC);
CREATE INDEX write_audit_ix_row_key  ON oee.write_audit USING gin (row_key);

-- ---------------------------------------------------------------------------
-- 3. The partitions. A generous window, plus DEFAULT as the safety net.
--
--    13 months back covers the 12-month retention plus the month being aged out;
--    12 forward means nothing needs creating for a year even if the maintenance
--    job never runs. Both are cheap — an empty partition costs a catalogue row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  m date := date_trunc('month', now())::date - interval '13 months';
  stop date := date_trunc('month', now())::date + interval '12 months';
BEGIN
  WHILE m < stop LOOP
    EXECUTE format(
      'CREATE TABLE oee.%I PARTITION OF oee.write_audit FOR VALUES FROM (%L) TO (%L)',
      'write_audit_' || to_char(m, 'YYYY_MM'), m, m + interval '1 month');
    m := m + interval '1 month';
  END LOOP;
END $$;

-- THE SAFETY NET, and the reason a missing partition cannot take Gold down. See
-- the header for why letting rows collect here is still not free.
CREATE TABLE oee.write_audit_default PARTITION OF oee.write_audit DEFAULT;

-- ---------------------------------------------------------------------------
-- 4. Carry the history across. Small today (111 rows on the dev database) and
--    worth keeping: three of them are the only evidence the downtime-edit write
--    path has ever run.
--
--    `id` is copied explicitly so row identities survive, then the sequence is
--    advanced past them — otherwise the first new insert would collide.
-- ---------------------------------------------------------------------------
INSERT INTO oee.write_audit (id, at, table_name, operation, row_key, db_user, application_name, client_addr)
SELECT id, at, table_name, operation, row_key, db_user, application_name, client_addr
FROM oee.write_audit_legacy;

SELECT setval(
  pg_get_serial_sequence('oee.write_audit', 'id'),
  GREATEST(COALESCE((SELECT max(id) FROM oee.write_audit), 0), 1)
);

DROP TABLE oee.write_audit_legacy;

-- ---------------------------------------------------------------------------
-- 5. Retention, as a function rather than a comment.
--
--    pg_cron IS NOT INSTALLED on the Gold database — checked, and neither is
--    pg_partman — so nothing runs this on a schedule yet. TODOS.md §35 records the
--    request, bundled with contract §6's outstanding database-roles ask since it is
--    the same administrator.
--
--    Until then it is a one-liner somebody runs by hand, which is the point of it
--    being a function: `DELETE FROM ... WHERE at < ...` on a GIN-indexed table is
--    the thing this migration exists to avoid, and it is exactly what a person
--    reaching for a manual prune would write.
--
--    RETURNS what it dropped, so a scheduled run has something to log and a manual
--    run can be checked. DROP TABLE, not DETACH: a detached partition is still a
--    table taking space, and "free" here means the storage actually goes away.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oee.prune_write_audit(retain_months int DEFAULT 12)
  RETURNS TABLE (dropped_partition text, rows_dropped bigint)
  LANGUAGE plpgsql
AS $$
DECLARE
  cutoff date := (date_trunc('month', now()) - make_interval(months => retain_months))::date;
  part   record;
  n      bigint;
BEGIN
  FOR part IN
    -- Only the monthly partitions, matched on the name this migration gives them.
    -- write_audit_default is deliberately never a candidate: dropping it would
    -- remove the safety net, and its contents are by definition rows whose month
    -- nobody created.
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    WHERE n2.nspname = 'oee'
      AND c.relname ~ '^write_audit_[0-9]{4}_[0-9]{2}$'
      AND to_date(right(c.relname, 7), 'YYYY_MM') < cutoff
    ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM oee.%I', part.relname) INTO n;
    EXECUTE format('DROP TABLE oee.%I', part.relname);
    dropped_partition := part.relname;
    rows_dropped := n;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION oee.prune_write_audit(int) IS
  'Drops oee.write_audit monthly partitions older than retain_months (default 12), returning what it dropped and how many rows went with it. Never touches write_audit_default. Retention covers operator rows too — the durable operator trail is work_unit_shift_report_approval_events and downtime_report_history, neither of which is pruned. TODOS.md §35.';

-- A companion, because the DEFAULT partition filling up is the one thing that
-- turns a future CREATE PARTITION into a data move. Cheap to check, easy to
-- forget it exists.
CREATE OR REPLACE FUNCTION oee.write_audit_default_backlog()
  RETURNS TABLE (month text, rows bigint)
  LANGUAGE sql
AS $$
  SELECT to_char(at, 'YYYY_MM') AS month, count(*) AS rows
  FROM oee.write_audit_default
  GROUP BY 1 ORDER BY 1
$$;

COMMENT ON FUNCTION oee.write_audit_default_backlog() IS
  'Which months have rows sitting in write_audit_default because no partition covered them. A non-empty result means creating that month''s partition now requires moving these rows first — Postgres refuses to attach a partition whose range overlaps rows in DEFAULT. TODOS.md §35.';
