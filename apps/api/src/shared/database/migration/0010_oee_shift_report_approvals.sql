-- Approval state for a work-unit shift report, and the trail of how it got there.
--
-- WHY THIS FILE EXISTS
--
-- `apps/web/src/components/report/shift-report-header.tsx` has rendered a
-- DISABLED "Approve" button since the detail page was built. TODOS.md §21 says
-- why in one sentence: "oee.work_unit_shift_reports has no `status` column, so
-- an approval has nowhere to land." That item has been blocked, deliberately,
-- on a product decision rather than guessed at — §21's own words: "a state model
-- invented ahead of the flow is how you get a column nobody uses."
--
-- The decision has been made:
--
--   * open -> closed, and CLOSED IS REVERSIBLE. Reopen is permitted by the model.
--   * Any authenticated user may approve. `closed_by` records who did.
--   * A closed report is NOT frozen. The downtime-edit path does not consult
--     `status` — filed as TODOS.md §37 rather than answered by omission.
--
-- WHY THIS IS NOT A COLUMN ON oee.work_unit_shift_reports
--
-- This is the one decision in this file worth understanding before changing it,
-- and §21's own suggestion ("ship `status`, `approved_at` and `approved_by` in
-- the same migration as the feature") is the thing being overruled.
--
-- That table is the PIPELINE'S. Airflow -> dbt owns every bulk write to it
-- (docs/gold-write-contract.md §1 rule 1), and this repo cannot see that code:
-- §18 records that the DAG has no repository, lives on one laptop, and has no
-- review path. So "dbt must not overwrite these columns" could only ever be a
-- sentence in a document, enforced by hope, guarding the one write this service
-- exists to make.
--
-- Two concrete mechanisms would destroy an approval, and neither is exotic:
--
--   1. DELETE-then-INSERT. contract §9 item 4 PRESCRIBES
--      `incremental_strategy='delete+insert'` to that same DAG for
--      product_perf_wu_hour, because a naive dbt `merge` fails outright against
--      GENERATED ALWAYS columns. If that strategy is ever pointed here, the row
--      is deleted and re-inserted: the approval columns are wiped AND the
--      `serial` id is re-minted, which breaks every deep link at the same time.
--   2. `merge`. dbt's `default__get_merge_sql` derives its `update set` list
--      from the TARGET relation's columns, so whether an unmodelled column
--      survives depends on a dbt internal owned by another team.
--
-- Both failures are SILENT. Nothing errors; the report simply reads "open"
-- again, and the operator who approved it has no way to tell.
--
-- Keying on (work_unit_id, date, shift) instead removes the question entirely:
-- NO STATEMENT TARGETING work_unit_shift_reports CAN REACH THIS TABLE. That is
-- the same argument 0007 makes for keying downtime history on `source_event_id`
-- rather than on `downtime_reports.id`, applied one table over. The cost is one
-- LEFT JOIN on a read that contract §8 measured at 0.4 ms.
--
-- Those three columns are not an arbitrary choice: they are exactly
-- `wu_shift_report_key`, the UNIQUE index 0003 already puts on that table and
-- contract §2 already names as its upsert key. So the grain is guaranteed to
-- match, by a constraint, and a dbt run that restates the report row REATTACHES
-- its approval rather than losing it.
--
-- AND THE ENFORCEMENT IS MACHINE-CHECKED, NOT PROSE
--
-- Note what this file does NOT do: it does not extend
-- `ck_etl_watermarks_table`. That omission is deliberate and it is the whole
-- point. 0005 constrains `etl_watermarks.table_name` to the real table names,
-- and contract §4 has the pipeline stamp `{{ this.identifier }}` in a dbt
-- post-hook. So if a dbt model named `work_unit_shift_report_approvals` (or
-- `..._approval_events`) is ever created, ITS WATERMARK INSERT FAILS LOUDLY at
-- the constraint.
--
-- That is a better statement of "dbt must never write these" than any paragraph
-- in a document nobody is obliged to read. Do NOT "fix" the omission by adding
-- these names to the check.
--
-- WHY TWO TABLES
--
-- Because reopen is permitted, and a current-state row can only ever state the
-- LATEST transition. "This report is closed" and "this report was approved by
-- Dewi, reopened by Bagus, and approved again" are different facts, and the
-- second is the one the Log Activity panel exists to show.
--
-- This is not a second representation of one fact — the trap §3.3 of the
-- contract warns about, and the reason 0009 refused a nullable `occurred_at`.
-- It is 0003+0007's shape exactly: `downtime_reports` carries the current
-- values, `downtime_report_history` carries how they changed. Current state is
-- a row; history is a log. Neither can be derived from the other cheaply, and
-- neither can contradict the other, because they answer different questions.
--
-- The current-state table also earns its place mechanically: it is what makes
-- "close it only if it is open" expressible as ONE conditional upsert (see
-- WorkUnitReportWriterRepository.closeShiftReport). Against an append-only log
-- alone, that predicate needs an advisory lock or a partial unique index, and
-- every read grows a DISTINCT ON lateral.
--
-- WHY text + CHECK AND NOT AN ENUM, GIVEN 0003 CREATED ONE
--
-- `oee.operation_type` earned its enum: it is a closed, stable vocabulary shared
-- by two tables, and 0009 reuses it explicitly "so no second vocabulary exists
-- to drift from the first". A status on one table is none of those things.
--
-- The decisive reason is mechanical, though. `ALTER TYPE ... ADD VALUE` CANNOT
-- BE USED IN THE SAME TRANSACTION THAT THEN USES THE NEW VALUE, and
-- scripts/migrate.mjs runs each file in exactly one transaction together with
-- its schema_migrations row. So a future migration adding a state and
-- backfilling it would fail outright. The same change as a
-- DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT pair is trivial — which is the
-- idiom 0009 already established for the watermark check, for its own reasons.
--
-- postgres.js hands enum values back as plain strings anyway (0003's header
-- says so), so the enum would buy nothing at the TypeScript boundary either.
--
-- WHY `source` AND NOT A THIRD STATUS
--
-- TODOS.md §31 defers auto-closing reports older than 14 days; the scheduling
-- technology is undecided. The state model has to accommodate it NOW, because
-- it is free on an empty table and a migration later.
--
-- A report closed by that sweeper IS closed: not editable, counted as closed in
-- every rollup, rendering the same badge. It differs in PROVENANCE, not state.
-- Spelling it 'auto_closed' in `status` would force every reader to write
-- `status IN ('closed','auto_closed')`, and the first one that forgot would
-- return a silently under-counted "closed reports" number — precisely the class
-- of failure this schema instruments against everywhere else.
--
-- So provenance lives in its own column, which nothing needs in a WHERE and
-- therefore nothing can drop from one by accident.
--
-- `closed_by` IS THE KEYCLOAK SUBJECT, not the database user. The pool connects
-- as one shared role, so 0004's `db_user` identifies the service and not the
-- person. The write path reads it from `c.get("jwtPayload")`. Identical rule to
-- downtime_report_history.changed_by, and stated again here because it is the
-- single easiest thing to get wrong in a write path.
--
-- THE COST THIS DESIGN ACCEPTS, NAMED RATHER THAN DISCOVERED
--
-- An approval whose report row is later RE-KEYED — a corrected shift calendar
-- moving (date, shift) — ORPHANS. There are no foreign keys anywhere in `oee`
-- and there cannot be (work_unit_id points at a different database), so nothing
-- prevents it.
--
-- The row is harmless: the LEFT JOIN finds nothing, the report reads "open", and
-- the orphan remains as EVIDENCE that somebody approved something under a key
-- that no longer exists. It is deliberately not cleaned up by a job. To find
-- them:
--
--   SELECT a.* FROM oee.work_unit_shift_report_approvals a
--    WHERE NOT EXISTS (SELECT 1 FROM oee.work_unit_shift_reports r
--                       WHERE r.work_unit_id = a.work_unit_id
--                         AND r.date = a.date AND r.shift = a.shift);
--
-- Filed in the contract's Open risks. Note it has NO user-visible signal: the
-- report silently reads "open" again, which is the one failure mode of this
-- design that behaves like the failure mode it was chosen to prevent.
--
-- Plain CREATE TABLE, not IF NOT EXISTS: 0003's header states that future
-- changes belong in a new numbered migration using plain DDL, which FAILS
-- LOUDLY rather than silently doing nothing against a drifted table.
-- Forward-only; scripts/migrate.mjs has no down path.

-- ---------------------------------------------------------------------------
-- oee.work_unit_shift_report_approvals — CURRENT state, one row per report
-- ---------------------------------------------------------------------------
--
-- THE ABSENCE OF A ROW MEANS OPEN. That is the normal state of every report in
-- the database today and of every report the pipeline will ever write, so the
-- alternative — backfilling an 'open' row per report and having the DAG insert
-- one on every load — would put this service's table on the pipeline's write
-- path, which is the entire thing being avoided.
--
-- Readers must therefore `coalesce(a.status, 'open')`, and an "open" FILTER is
-- `NOT EXISTS (... status = 'closed')` and NEVER `EXISTS (... status = 'open')`.
-- The latter is the wrong spelling and would hide every never-touched report,
-- which is currently all of them.
CREATE TABLE oee.work_unit_shift_report_approvals (
  -- ---- the NATURAL key, deliberately not work_unit_shift_reports.id --------
  -- Exactly the columns of `wu_shift_report_key`, so the grain is guaranteed by
  -- a constraint on the other table rather than by agreement.
  work_unit_id   integer     NOT NULL,
  -- The shift's START INSTANT, copied verbatim. NOT a business day and NOT a
  -- calendar date: the join is plain timestamptz equality with no AT TIME ZONE,
  -- unlike every `shift_date` join in WorkUnitReportReaderRepository. Do not
  -- "fix" it into a business-day conversion.
  date           timestamptz NOT NULL,
  shift          smallint    NOT NULL,

  -- ---- the state ----------------------------------------------------------
  status         text        NOT NULL,
  -- See the header: this is what makes "auto-closed" expressible without a
  -- third status. NULL while open.
  source         text,
  closed_at      timestamptz,
  -- The Keycloak subject. NULL for source='system', which is the point of
  -- ck_wusra_system below.
  closed_by      text,
  -- preferred_username (falling back to `name`) AS IT WAS at closing time.
  -- Display only; `closed_by` is the durable identity. Denormalised because
  -- there is no users table in this database — the same reason
  -- downtime_reports.input_by is free text.
  closed_by_name text,

  CONSTRAINT pk_wu_shift_report_approvals PRIMARY KEY (work_unit_id, date, shift),

  CONSTRAINT ck_wusra_shift    CHECK (shift BETWEEN 1 AND 3),
  CONSTRAINT ck_wusra_status   CHECK (status IN ('open', 'closed')),
  CONSTRAINT ck_wusra_source   CHECK (source IS NULL OR source IN ('operator', 'system')),

  -- A closed row states WHEN and HOW it closed.
  CONSTRAINT ck_wusra_closed   CHECK (
    status <> 'closed' OR (closed_at IS NOT NULL AND source IS NOT NULL)
  ),
  -- An operator close NAMES THE PERSON.
  CONSTRAINT ck_wusra_operator CHECK (
    source IS DISTINCT FROM 'operator' OR closed_by IS NOT NULL
  ),
  -- A system close must NOT pretend a person did it. Together with
  -- ck_wusra_operator this is what stops the deferred sweeper (§31) inventing a
  -- subject to satisfy a NOT NULL.
  CONSTRAINT ck_wusra_system   CHECK (
    source IS DISTINCT FROM 'system' OR closed_by IS NULL
  ),
  -- An OPEN row carries no closure facts. Forward-compatible with reopen: this
  -- row describes the CURRENT state, and a PREVIOUS closure belongs to the
  -- event log below, not to a stale column here that would disagree with it.
  CONSTRAINT ck_wusra_open     CHECK (
    status <> 'open'
      OR (closed_at IS NULL AND closed_by IS NULL
          AND closed_by_name IS NULL AND source IS NULL)
  )
);

-- No secondary index, and 0008's rule is the reason: the primary key's equality
-- on all three columns serves every question this table gets — the detail
-- lookup, the list's batched `unnest` join, and the deferred sweeper's
-- anti-join. Nothing scans it whole.

COMMENT ON TABLE oee.work_unit_shift_report_approvals IS
  'Approval state for one work unit''s one shift. Written ONLY by mes-oee-monitor '
  '(docs/gold-write-contract.md §1 rule 2 and §12); Airflow/dbt must NEVER write it. '
  'Keyed on the NATURAL key (work_unit_id, date, shift) — the columns of '
  'wu_shift_report_key — and NOT on work_unit_shift_reports.id, because that id is a '
  'serial the pipeline re-mints on any delete+insert restatement, which would silently '
  'orphan an operator''s approval. ONE row per report, CURRENT STATE ONLY; the trail of '
  'transitions is oee.work_unit_shift_report_approval_events. THE ABSENCE OF A ROW MEANS '
  'OPEN, so readers must coalesce and an "open" filter is NOT EXISTS over ''closed'', '
  'never EXISTS over ''open''. `date` is the shift''s START INSTANT, matching '
  'work_unit_shift_reports.date exactly — not a business day. Deliberately ABSENT from '
  'ck_etl_watermarks_table, so a dbt model of this name fails its watermark insert loudly.';

COMMENT ON COLUMN oee.work_unit_shift_report_approvals.status IS
  'open | closed. text + CHECK rather than an enum so the vocabulary can be extended by a '
  'DROP/ADD CONSTRAINT pair inside one migration transaction — ALTER TYPE ADD VALUE cannot '
  'be used in the transaction that also uses the new value, and migrate.mjs runs each file '
  'in exactly one. NO row means ''open''.';
COMMENT ON COLUMN oee.work_unit_shift_report_approvals.source IS
  'operator | system. THE REASON THERE IS NO THIRD STATUS. A report auto-closed by the '
  'deferred 14-day sweeper (TODOS.md §31) is closed — not editable, counted as closed '
  'everywhere. It differs in PROVENANCE, not state. Spelling it ''auto_closed'' in `status` '
  'would force every reader to write status IN (''closed'',''auto_closed''), and the first '
  'one that forgot would silently under-count closed reports.';
COMMENT ON COLUMN oee.work_unit_shift_report_approvals.closed_by IS
  'The KEYCLOAK SUBJECT (jwtPayload.sub), not current_user. The pool connects as one shared '
  'role, so 0004''s db_user identifies the service and not the person — the same rule '
  'downtime_report_history.changed_by follows. NULL when source = ''system''.';
COMMENT ON COLUMN oee.work_unit_shift_report_approvals.closed_by_name IS
  'preferred_username (falling back to name) AS IT WAS at closing time. Display only; '
  'closed_by is the durable identity. Denormalised because there is no users table in this '
  'database, exactly as downtime_reports.input_by is.';
COMMENT ON COLUMN oee.work_unit_shift_report_approvals.date IS
  'The shift''s START INSTANT, copied verbatim from work_unit_shift_reports.date. NOT a '
  'business day and NOT a calendar date — the join is plain timestamptz equality with no '
  'AT TIME ZONE, unlike every shift_date join in WorkUnitReportReaderRepository.';

-- ---------------------------------------------------------------------------
-- oee.work_unit_shift_report_approval_events — the append-only trail
-- ---------------------------------------------------------------------------
--
-- One row per TRANSITION. Written in the SAME TRANSACTION as the row above, per
-- TODOS.md §21's rule for the downtime trail: "A trail that can disagree with
-- the row it describes is worse than none."
--
-- This is what the Log Activity panel reads. The current-state table cannot
-- serve it: a report approved, reopened and approved again has one row there
-- and three here, and it is the three the panel exists to show.
--
-- APPEND-ONLY BY CONVENTION, NOT BY CONSTRAINT — there is no way to express
-- "no UPDATE" in DDL. The row-level audit trigger below is the tripwire, the
-- same role 0009 gives its own: if anything ever updates this table,
-- oee.write_audit is what will say so.
CREATE TABLE oee.work_unit_shift_report_approval_events (
  id           bigserial   NOT NULL,

  -- The same natural key, and for the same reason as the table above. NOT a
  -- foreign key to it: there are no foreign keys anywhere in `oee`, and an
  -- event must survive its subject being re-keyed — an orphaned trail is
  -- evidence, and evidence that deletes itself is not evidence.
  work_unit_id integer     NOT NULL,
  date         timestamptz NOT NULL,
  shift        smallint    NOT NULL,

  -- `now()` is transaction_timestamp(), so this matches the approvals row's
  -- closed_at exactly rather than approximately.
  at           timestamptz NOT NULL DEFAULT now(),

  -- Nullable ONLY because a system transition has no person behind it; see
  -- ck_wusrae_actor. Same Keycloak-subject rule as closed_by.
  by_subject   text,
  by_name      text,

  -- BOTH sides recorded, not just the destination. "It became closed" does not
  -- say whether that was an approval or a re-approval after a reopen, and the
  -- panel renders the arrow.
  from_status  text        NOT NULL,
  to_status    text        NOT NULL,
  -- NOT NULL here, unlike on the current-state table: an event always happened
  -- somehow, whereas an open row has not happened at all yet.
  source       text        NOT NULL,

  CONSTRAINT pk_wu_shift_report_approval_events PRIMARY KEY (id),
  CONSTRAINT ck_wusrae_shift  CHECK (shift BETWEEN 1 AND 3),
  CONSTRAINT ck_wusrae_from   CHECK (from_status IN ('open', 'closed')),
  CONSTRAINT ck_wusrae_to     CHECK (to_status   IN ('open', 'closed')),
  -- A "transition" that changes nothing is a bug in the writer, not an event.
  -- With two states this also means from_status is fully determined by
  -- to_status — which is exactly why the writer can set it without re-reading.
  CONSTRAINT ck_wusrae_moves  CHECK (from_status <> to_status),
  CONSTRAINT ck_wusrae_source CHECK (source IN ('operator', 'system')),
  CONSTRAINT ck_wusrae_actor  CHECK (source <> 'operator' OR by_subject IS NOT NULL)
);

-- The only question this table gets asked: "what happened to this report,
-- newest first". Nothing scans it whole. `at DESC` is in the index because it
-- is in the ORDER BY, the same shape as downtime_report_history_ix_event.
CREATE INDEX wusrae_ix_report
  ON oee.work_unit_shift_report_approval_events
  USING btree (work_unit_id, date, shift, at DESC);

COMMENT ON TABLE oee.work_unit_shift_report_approval_events IS
  'One row per approval TRANSITION of a work-unit shift report — the trail behind the Log '
  'Activity panel. APPEND-ONLY, and written in the SAME TRANSACTION as '
  'oee.work_unit_shift_report_approvals so the trail can never disagree with the state it '
  'describes (TODOS.md §21). Written ONLY by mes-oee-monitor; Airflow/dbt must NEVER write '
  'it, and it is deliberately absent from ck_etl_watermarks_table so a dbt model of this '
  'name fails loudly. Keyed on the same NATURAL key as the state table and with NO foreign '
  'key to it: an event must survive its subject being re-keyed, because an orphaned trail is '
  'evidence.';

COMMENT ON COLUMN oee.work_unit_shift_report_approval_events.from_status IS
  'The status BEFORE this transition. Recorded rather than inferred so the panel can render '
  'an arrow and so a re-approval after a reopen is distinguishable from a first approval.';
COMMENT ON COLUMN oee.work_unit_shift_report_approval_events.by_subject IS
  'The KEYCLOAK SUBJECT of whoever caused the transition, not current_user. NULL only when '
  'source = ''system'' — see ck_wusrae_actor.';
COMMENT ON COLUMN oee.work_unit_shift_report_approval_events.source IS
  'operator | system. NOT NULL, unlike the same column on the state table: an event always '
  'happened somehow, whereas an open report has not happened at all yet.';

-- ---------------------------------------------------------------------------
-- Audit triggers
-- ---------------------------------------------------------------------------
--
-- The house pair, oee.log_write() taking the primary key columns as trigger
-- arguments so no per-table variant is needed.
--
-- NOTE THE INVERTED ASYMMETRY, and that it happens to come out right. 0004
-- chose statement-level INSERT and row-level UPDATE/DELETE because on every
-- other table the INSERT is the PIPELINE's bulk path (18M rows a year) and the
-- UPDATE is the operator's precise one.
--
-- Here the INSERT *is* the operator path. Statement-level is still correct, for
-- a different reason: one approve is one statement is one row, so per-statement
-- and per-row are the same thing on this table. The arithmetic that follows is
-- worth knowing before someone adds a third audited write to this path — at the
-- 500-work-unit target, 3 shifts a day, approving every report is roughly
-- 550k approvals a year and 2 audit rows each (one per table), so ~1.1M rows a
-- year into oee.write_audit. Modest beside the pipeline's 18M, but NOTHING
-- ANYWHERE PRUNES write_audit and it carries a GIN index on row_key. Filed as
-- TODOS.md §35; it is a schema-wide concern this path surfaces rather than
-- causes.
CREATE OR REPLACE TRIGGER write_audit_ins
  AFTER INSERT ON oee.work_unit_shift_report_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row
  AFTER UPDATE OR DELETE ON oee.work_unit_shift_report_approvals
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_unit_id', 'date', 'shift');

-- On the event log the row-level trigger is NOT decoration: this table is
-- append-only, and nothing may ever UPDATE or DELETE a row in it. If something
-- does, oee.write_audit is the only thing that will say so — the same tripwire
-- 0009 describes for downtime_log_events.
CREATE OR REPLACE TRIGGER write_audit_ins
  AFTER INSERT ON oee.work_unit_shift_report_approval_events
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row
  AFTER UPDATE OR DELETE ON oee.work_unit_shift_report_approval_events
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
