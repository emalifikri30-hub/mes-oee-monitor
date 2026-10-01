-- The columns and the history table behind the Availability Loss detail report.
--
-- WHY THIS FILE EXISTS
--
-- The Losses page's Unplanned Downtime Pareto ranks reasons; its eye button now
-- opens the individual stops behind one bar. That screen, and the per-record
-- drawer beside it, name six things `oee.downtime_reports` cannot answer: a
-- stable public identifier for a stop, the area it happened in, the operator's
-- free-text elaboration on the reason, who logged it, who attended to it, and
-- what has been changed about it since.
--
-- WHAT THIS FILE DOES NOT DO, AND CANNOT
--
-- It does not populate any of them. `docs/gold-write-contract.md` §1 rule 2:
-- this service writes only named operator mutations and NEVER inserts. Every
-- column below arrives NULL and stays NULL until the `work_unit_*` DAG writes
-- it — which is filed as a requirement in that document, not assumed here. The
-- UI renders an em dash for each, which is what the design already shows.
--
-- Adding them anyway is deliberate. The alternative is a screen that cannot be
-- built until an unwritten DAG lands, and an ask that exists only in prose. A
-- nullable column plus a filed requirement is the cheaper half of the trade,
-- and it is free right now: the table holds 8 hand-seeded rows (TODOS.md §10).
--
-- `source_event_id` IS DOING TWO JOBS
--
-- It is the "Downtime ID" the design shows on screen. It is ALSO TODOS.md §19's
-- PREFERRED idempotency key, which the table has never had — its only unique
-- index is the surrogate `id serial`, which the pipeline neither supplies nor
-- can match on, so a DAG retry or a DLQ replay inserts every row a second time.
--
-- That is why the UI must key on this and not on `id`. Until the model becomes
-- an upsert, contract §2.1 mandates DELETE-then-INSERT scoped to the run window
-- — so every `id` changes on every run. A deep link, or a history row, pointing
-- at `id` would silently come to mean a DIFFERENT stop.
--
-- UNIQUE on a nullable column is the point, not an oversight: Postgres permits
-- any number of NULLs in a unique index, so all 8 existing rows coexist while
-- the key is unwritten, and the constraint starts biting the moment it is not.
--
-- NOT INDEXED HERE: `reason ->> 0`
--
-- The detail endpoint filters on the primary reason, which no index can serve
-- against a jsonb array. Left alone on purpose. contract §3.3.1 asks for
-- `reason` to become a real `primary_reason text` column, which would make the
-- filter, the GROUP BY and the index one change instead of three — and TODOS.md
-- §10 already ruled that indexing this table is not worth doing at 8 rows.
--
-- Plain ALTER TABLE, not IF NOT EXISTS: 0003's header states that future
-- changes belong in a new numbered migration using plain ALTER TABLE, which
-- FAILS LOUDLY rather than silently doing nothing against a drifted table.
-- Forward-only; scripts/migrate.mjs has no down path.

ALTER TABLE oee.downtime_reports
  ADD COLUMN source_event_id text,
  ADD COLUMN area_id         integer,
  ADD COLUMN area_name       varchar(255),
  ADD COLUMN detail_reason   text,
  ADD COLUMN input_by        varchar(255),
  ADD COLUMN maintained_by   varchar(255);

COMMENT ON COLUMN oee.downtime_reports.source_event_id IS
  'Deterministic id carried from the Silver event. The stop''s public identity, and the ON CONFLICT target a dbt upsert needs. NULL until the DAG writes it.';
COMMENT ON COLUMN oee.downtime_reports.area_id IS
  'Denormalised from mes-master-data, alongside work_center_id / work_unit_id. TODOS.md §9. NOT yet accepted by SCOPE_COLUMN — see below.';
COMMENT ON COLUMN oee.downtime_reports.area_name IS
  'Denormalised area name, matching the work_unit_name / work_center_name pattern already on this table.';
COMMENT ON COLUMN oee.downtime_reports.detail_reason IS
  'Operator free text elaborating on `reason`. Unbounded; rendered only in the per-record drawer.';
COMMENT ON COLUMN oee.downtime_reports.input_by IS
  'Who logged the stop, as recorded upstream. A name, not a foreign key — there is no users table in this database.';
COMMENT ON COLUMN oee.downtime_reports.maintained_by IS
  'Who attended to the stop, as recorded upstream. Free text for the same reason as input_by.';

-- The idempotency key. See the header: UNIQUE over a nullable column is
-- deliberate, and this is TODOS.md §19's preferred half.
CREATE UNIQUE INDEX downtime_reports_source_event_key
  ON oee.downtime_reports (source_event_id);

-- The Changes History panel.
--
-- AMENDED 2026-08-25: THE WRITE PATH NOW EXISTS. This block used to say the
-- table "ships correctly empty" because the downtime-edit path did not exist.
-- It does — PATCH /api/v1/downtimes/:sourceEventId — and it writes one row here
-- per changed field, inside the same transaction as the UPDATE, with changed_by
-- read from the JWT. Both rules this header states below are honoured by it.
--
-- THE TABLE IS STILL EMPTY, AND THE REASON HAS MOVED. It is no longer waiting on
-- code; it is waiting on DATA. Every row of oee.downtime_reports has
-- source_event_id NULL, so no stop is addressable by that endpoint at all and
-- nothing can attach here. contract §3.3.2 asks the pipeline for the column and
-- TODOS.md §19 tracks it. Until then the endpoint 404s every stop, the browser
-- disables its Edit item for a row with no id rather than offering an action that
-- cannot work, and the read path goes on distinguishing "no changes recorded"
-- from "this stop is not tracked at all" — which is still every row.
--
-- apps/api/scripts/seed/0007_downtime_source_event_id_dev.sql fills the column in
-- on a dev database so the whole path can be exercised in a browser.
--
-- AMENDED 2026-08-24: this used to say TODOS.md §21 was "blocked on a product
-- decision about the approval state model". THAT DECISION HAS BEEN MADE and the
-- approval half of §21 has shipped — see 0010_oee_shift_report_approvals.sql,
-- which also settles the two rules this file's header states below (changed_by
-- is the Keycloak subject; the trail is written in the UPDATE's transaction).
--
-- WHY NOT oee.write_audit (0004)
--
-- That table answers "was this row touched, by which database user". It stores
-- no old value, no new value, no column name, and no application-level user —
-- and its INSERT trigger is statement-level, so most rows have no entry at all.
-- A per-field trail is a different question and needs a different table.
--
-- WHY NO FOREIGN KEY to oee.downtime_reports
--
-- Two reasons, either one sufficient. There are no foreign keys anywhere in the
-- `oee` schema — work_unit_id and work_center_id already point at a different
-- database. And contract §2.1 mandates DELETE-then-INSERT until the upsert key
-- lands, which an FK would block outright.
--
-- `changed_by` IS THE KEYCLOAK SUBJECT, not the database user. The pool
-- connects as one shared role, so current_user identifies the service, not the
-- person. The write path must read it from the JWT (`c.get("jwtPayload")`).
CREATE TABLE oee.downtime_report_history (
  id              bigserial   NOT NULL,
  -- Not `id`: see the header. This is what survives a pipeline re-run.
  source_event_id text        NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  changed_by      text        NOT NULL,
  -- One row per FIELD changed, so a single edit touching category and actions
  -- writes two rows. The panel groups them by changed_at.
  field           text        NOT NULL,
  -- jsonb rather than text: `reason` and `actions` are jsonb arrays, and
  -- flattening them to a string would make the trail unable to say which
  -- element moved.
  old_value       jsonb,
  new_value       jsonb,
  CONSTRAINT downtime_report_history_pkey PRIMARY KEY (id),
  CONSTRAINT ck_downtime_report_history_field CHECK (
    field IN ('category', 'reason', 'actions', 'detail_reason')
  )
);

-- The only question this table gets asked: "what changed about these stops,
-- newest first". Nothing scans it whole.
CREATE INDEX downtime_report_history_ix_event
  ON oee.downtime_report_history USING btree (source_event_id, changed_at DESC);

-- Audited like every other table in the schema. Same asymmetry as 0004: bulk
-- INSERT per statement, operator UPDATE/DELETE per row.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.downtime_report_history
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.downtime_report_history
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
