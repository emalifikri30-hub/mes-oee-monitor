-- The immutable downtime event log behind the Losses page's "Others" Pareto.
--
-- WHY THIS FILE EXISTS
--
-- The Losses page renders five tabs. Four of them rank something. "Others" was
-- a one-line placeholder and TODOS.md §24 held it open for one reason only:
-- "nothing, now, except a product decision about what 'Others' means". That
-- decision has been made, and it is the reason this table is not a view:
--
--   "Others" counts HOW MANY TIMES each downtime reason occurred. Frequency
--   only. No duration anywhere.
--
-- WHY NOT oee.downtime_reports, WHICH ALREADY HAS THE REASONS
--
-- Because that table is the OPERATOR-MUTABLE one. docs/gold-write-contract.md
-- §1 rule 2 reserves exactly two writes for this service, and one of them is
-- editing a downtime — its category, its reasons, its actions. 0004's row-level
-- trigger and 0007's oee.downtime_report_history exist for that path and nothing
-- else. A frequency Pareto drawn from that table therefore MOVES WHEN AN
-- OPERATOR CORRECTS A STOP.
--
-- "How often did this happen" and "how often do we currently say this happened"
-- are two different questions. Only the second one can be answered by a mutable
-- table, and it is not the question the tab asks. No projection of a mutable
-- table is immutable either, so a view over downtime_reports would inherit the
-- same defect with none of the cost saved.
--
-- There is a second, independent reason. contract §2.1: downtime_reports has no
-- natural key, so its load is DELETE-then-INSERT and every `id` changes on every
-- run. Counting rows whose identity is re-minted nightly is not counting.
--
-- WHY THE ARRAY IS EXPLODED HERE AND DISCARDED THERE
--
-- contract §3.3.1 records that GET /downtimes/by-reason "groups on the FIRST
-- element of the array and discards the rest, because a stop has one cause for
-- accounting purposes and exploding the array would count one 40-minute stop
-- under two reasons and make the bars sum to more than the shift."
--
-- That objection is ENTIRELY ABOUT DURATION, and it is correct. A count has no
-- such problem: an event can honestly be counted under every reason it cited,
-- because no minute is being double-spent. So this is the one read that gets to
-- explode the array — which is also why it is a different question from
-- Availability Loss rather than a re-cut of it.
--
-- The consequence is stated on screen rather than buried: the bars sum to
-- OCCURRENCES, not to stops. See total_occurrences / total_events in the
-- reader, and §3.9 of the contract.
--
-- WHAT THIS FILE DOES NOT DO, AND CANNOT
--
-- It does not populate the table. contract §1 rule 2: this service writes only
-- named operator mutations and NEVER inserts. Every row arrives from the
-- `work_unit_*` DAG, filed as a requirement in §3.9 of that document rather than
-- assumed here. Until it does, the Others tab renders its watermark-aware empty
-- state — "not loaded yet", NOT "nothing stopped this machine" — which is the
-- distinction oee.etl_watermarks exists for and the reason the watermark CHECK
-- below is amended in the same transaction.
--
-- Shipping the table ahead of the data is the same trade 0007 and 0008 made, for
-- the same reason: the alternative is a screen that cannot be built until an
-- unwritten DAG lands. A dev seed lives at
-- scripts/seed/0009_downtime_log_events_dev.sql so the populated path can be
-- exercised by hand; it is deliberately outside this directory, because
-- migrate.mjs applies EVERY *.sql it finds here.
--
-- NAMING, BECAUSE 0008 MAKES A POINT OF THE GRAMMAR
--
-- `<subject>_<scope>_<grain>` — product_count_wu_shift, reject_count_wu_shift,
-- product_perf_wu_hour — names an AGGREGATE and its grain. This table is one row
-- per real-world event, so it takes downtime_reports' shape of name instead.
-- Calling it downtime_count_wu_shift would promise a pre-aggregate the DAG is
-- not being asked to build.
--
-- NO DURATION, AND TWO RULES FOLLOW FROM THAT
--
-- No `duration`, no `start_at`, no `end_at`, and no instant of any kind. That is
-- the product requirement, and it removes two whole classes of arithmetic:
--
--   1. THERE IS NOTHING TO CLIP. DowntimeReaderRepository.clipped computes
--      LEAST(coalesce(end_at, now), window.to) - GREATEST(start_at, window.from)
--      precisely because a stop straddles a shift boundary and its MINUTES have
--      to be split. A count cannot be split: an event either belongs to a shift
--      or it does not. So THE PIPELINE MUST ASSIGN EACH EVENT TO EXACTLY ONE
--      (work_unit_id, shift_date, shift). Whichever side of midnight it picks,
--      the contribution is 1. §3.9 asks for this normatively.
--   2. There is no open-stop case. `coalesce(end_at, now())` has no analogue
--      here; a stop still in progress is already one event.
--
-- The honest cost, filed as an Open risk in the contract: with no instant on the
-- row, the shift assignment is not auditable from the data — `event_id` is the
-- only route back to Silver. A nullable `occurred_at` was considered and left
-- out on §3.3's ground, which is that a second representation of one fact
-- eventually disagrees with the first: downtime_reports.duration is written
-- independently of its own timestamps and can contradict them, and that is
-- exactly the defect not being reproduced here. It stays cheap to add while the
-- table is empty.
--
-- No foreign keys, for the reason 0003 gives: work_unit_id, work_center_id and
-- area_id all reference mes-master-data, a different service and a different
-- database. Names and codes are denormalised onto the row so this read needs no
-- mes-master-data call.
--
-- Plain CREATE TABLE / plain ALTER TABLE, not IF NOT EXISTS: 0003's header
-- states that future changes belong in a new numbered migration using plain DDL,
-- which FAILS LOUDLY rather than silently doing nothing against a drifted table.
-- Forward-only; scripts/migrate.mjs has no down path. migrate.mjs runs this
-- whole file in ONE transaction with its schema_migrations row, so the function,
-- the table, the watermark CHECK swap and both triggers land together or not at
-- all.

-- ---------------------------------------------------------------------------
-- A CHECK cannot contain a subquery, so the array predicate becomes a function
-- ---------------------------------------------------------------------------
--
-- "No element of this array is NULL or blank" is not expressible inline: a CHECK
-- constraint admits neither a subquery nor an aggregate, so the obvious
-- `CHECK (NOT EXISTS (SELECT 1 FROM unnest(reasons) ...))` is rejected at
-- migration time with `cannot use subquery in check constraint`. This is that
-- predicate as a function. It touches no table — only its own argument — so it
-- is genuinely IMMUTABLE rather than merely declared so.
--
-- AN EMPTY ARRAY PASSES, and that is the whole point. '{}' is how the pipeline
-- says "no reason was recorded", and it is the ONLY way to say it.
--
-- NOT STRICT, deliberately. A STRICT function returns NULL for a NULL argument,
-- a NULL CHECK result PASSES, and the guard would evaporate for one of the two
-- inputs it exists to reject. `reasons NOT NULL` already covers that case;
-- belt-and-braces beats cleverness in a constraint nobody will re-read.
--
-- CAVEAT WORTH KNOWING BEFORE YOU EDIT THIS FUNCTION: Postgres does NOT
-- re-validate a CHECK when the body of a function it calls is replaced. A later
-- CREATE OR REPLACE silently changes what ck_dtle_reasons means for NEW rows
-- only, leaving existing rows unexamined. That is why contract §3.9 also asks
-- the pipeline for a dbt test asserting the same predicate: the constraint is
-- the fast guard, the test is the durable one.
CREATE OR REPLACE FUNCTION oee.text_array_has_blank(arr text[])
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM unnest(arr) AS e(v) WHERE v IS NULL OR btrim(v) = ''
  )
$$;

COMMENT ON FUNCTION oee.text_array_has_blank(text[]) IS
  'True when any element of the array is NULL or blank after btrim. An EMPTY array is false (it has no elements). Exists because a CHECK constraint admits no subquery; called by ck_dtle_reasons on oee.downtime_log_events.';

-- ---------------------------------------------------------------------------
-- oee.downtime_log_events — one machine stop, as logged, immutable
-- ---------------------------------------------------------------------------
CREATE TABLE oee.downtime_log_events (
  -- ---- identity -----------------------------------------------------------
  -- THE DETERMINISTIC NATURAL KEY contract §2.1 and §3.3.2 have been asking for
  -- on downtime_reports since 0007. Here it is not an ask, it is the primary
  -- key — and this table has NO other candidate. It carries no instant (see the
  -- header), so two stops of one machine in one shift citing the same reasons
  -- are indistinguishable by every other column combined: a composite key over
  -- (work_unit_id, shift_date, shift, reasons) would MERGE them and silently
  -- lose a bar's worth of frequency.
  --
  -- One consequence is worth more than the key itself. Because event_id is the
  -- WHOLE key, an event cannot be written under two shift assignments — the
  -- second write conflicts. On a table with no timestamps to cross-check, that
  -- is the only mechanical guarantee the "exactly one shift" rule of §3.9 can
  -- have.
  event_id         text         NOT NULL,

  -- ---- the join grain -----------------------------------------------------
  work_unit_id     integer      NOT NULL,
  -- The SHIFT's business day, a real `date` — matching
  -- product_count_wu_shift.shift_date and reject_count_wu_shift.shift_date, and
  -- NOT the timestamptz that work_unit_shift_reports.date is. Shift 3 crosses
  -- midnight, so its post-midnight events carry the PREVIOUS calendar date.
  shift_date       date         NOT NULL,
  shift            smallint     NOT NULL,

  -- ---- the measure, and there is only one ---------------------------------
  -- ONE ROW, MANY REASONS. {r1,r2} and {r2,rX,rY} give r2 a frequency of 2.
  -- The reader explodes with `SELECT DISTINCT event_id, reason`, so an element
  -- repeated inside one row counts ONCE — it is one event.
  --
  -- '{}' means NO REASON RECORDED and folds into a single unattributed bucket.
  -- It is the ONLY way to say that: ck_dtle_reasons rejects NULL and blank
  -- elements, so "absent" and "blank" cannot be confused. Contrast
  -- downtime_reports.reason, where '[]', '[""]', '["   "]' and a non-string
  -- element all mean the same thing and the reader folds four shapes into one.
  --
  -- NO DEFAULT, on purpose, and unlike downtime_reports.reason DEFAULT '[]'. A
  -- DAG that forgets this column must FAIL the load; with a default it would
  -- instead write "unattributed" for every stop, inflating exactly one bar to
  -- 100% while every real reason vanished, and nothing anywhere would error.
  reasons          text[]       NOT NULL,

  -- ---- classification, carried and NOT read -------------------------------
  -- Reuses the enum 0003 created for downtime_reports.category, so no second
  -- vocabulary exists to drift from the first. Nullable, and unread: "Others" is
  -- every stop regardless of category, which is what makes it Others.
  --
  -- Carried because it is free on an empty table and expensive later, exactly as
  -- 0006 and 0008 argue for their nullable area and work-centre columns. If a
  -- category filter is ever added it is one WHERE clause — but it MOVES THE
  -- DENOMINATOR, so per TODOS.md §25 it arrives with a LIMIT, an "Other" tail
  -- bucket and server-side sorting together, or not at all.
  category         oee.operation_type,

  -- ---- dimensions, denormalised -------------------------------------------
  -- NOT NULL, for the reason reject_count_wu_shift.work_unit_name is: a Pareto
  -- row that cannot say which machine it came from is not one. Cheap on an
  -- empty table and impossible to add later without a backfill.
  work_unit_name   varchar(255) NOT NULL,
  work_unit_code   varchar(255),
  -- Nullable above the work unit, like product_perf_wu_hour's area columns and
  -- for the same reason: not reliably populated for every plant today, and NOT
  -- NULL here would block a first load over data this read does not need.
  work_center_id   integer,
  work_center_name varchar(255),
  area_id          integer,
  area_name        varchar(255),

  -- ---- provenance ---------------------------------------------------------
  -- The IANA zone shift_date was cut in, denormalised so the business-day rule
  -- is auditable from the data rather than from a DAG's source. 0006 and 0008 do
  -- the same — and it matters MORE here, because this table has no instant of
  -- its own from which the day could be re-derived.
  time_zone        varchar(64)  NOT NULL,

  CONSTRAINT pk_downtime_log_events PRIMARY KEY (event_id),
  -- A blank key is a row nothing can restate and nothing can trace to Silver.
  CONSTRAINT ck_dtle_event_id CHECK (btrim(event_id) <> ''),
  CONSTRAINT ck_dtle_shift    CHECK (shift BETWEEN 1 AND 3),
  -- See the function above. An empty array passes; NULL or blank elements do
  -- not, which is what makes '{}' the single unambiguous spelling of
  -- "unattributed".
  CONSTRAINT ck_dtle_reasons  CHECK (NOT oee.text_array_has_blank(reasons)),
  -- unnest() FLATTENS a multi-dimensional array, so a 2-D value would explode
  -- into elements no writer intended and no reader could explain — and it would
  -- do it quietly, as extra frequency. array_ndims('{}'::text[]) is NULL rather
  -- than 0, so the empty array has to be admitted explicitly.
  CONSTRAINT ck_dtle_reasons_1d CHECK (
    array_ndims(reasons) IS NULL OR array_ndims(reasons) = 1
  )
);

-- ---------------------------------------------------------------------------
-- Two indexes, and no more — 0008's rule, with one difference that matters
-- ---------------------------------------------------------------------------
--
-- 0008 needed NO index for its own read, because reject_count_wu_shift's
-- five-column primary key has (work_unit_id, shift_date, shift) as its LEFT
-- PREFIX and serves the shift lookup for free. THIS TABLE'S KEY OFFERS THAT JOIN
-- NOTHING AT ALL: it is a single text event_id. So the first index below is
-- mandatory rather than convenient — without it the aggregate is a sequential
-- scan over the highest-cardinality table in the schema.

-- THE READ'S INDEX. Equality on all three columns, which is exactly what
-- WorkUnitReportReaderRepository joins on.
CREATE INDEX ix_dtle_wu_shift
  ON oee.downtime_log_events USING btree (work_unit_id, shift_date, shift);

-- THE PIPELINE'S INDEX. A run-window restatement or a backfill scopes on
-- shift_date across every work unit, which ix_dtle_wu_shift cannot serve — its
-- leading column is the one such a statement does not constrain. Also the
-- ad-hoc "how often did this reason occur this month" slice.
CREATE INDEX ix_dtle_shift_date
  ON oee.downtime_log_events USING btree (shift_date);

-- Two alternatives were considered and rejected, recorded so they are not
-- re-proposed as improvements:
--
--   ONE INDEX, (shift_date, work_unit_id, shift), would serve both — equality on
--   all three for the read, a range on the leading column for the pipeline.
--   Rejected because the read is the hot path and deserves the index whose
--   leading column is most selective FOR IT, and because one machine's history
--   across dates then loses its prefix. A second btree on a `date` is cheap.
--
--   A GIN INDEX ON `reasons`. Rejected outright: this read never FILTERS by
--   reason, it explodes a row set three equalities have already narrowed to one
--   machine's one shift. GIN buys `reasons @> ARRAY['x']`, which is a per-reason
--   drill-down — and that drill-down deliberately does not exist (TODOS.md §30),
--   for the reason §29 gives about the reject Pareto's missing eye button.

-- ---------------------------------------------------------------------------
-- Column documentation, for the consumers who never open this file
-- ---------------------------------------------------------------------------
--
-- 0006's convention and its reason: the explanatory header above is invisible to
-- Power BI, Metabase, DBeaver and `\d+`. COMMENT ON is not. The three things an
-- analyst will get wrong first are that every element of `reasons` counts (unlike
-- downtime_reports.reason), that `shift_date` is a business day and not a
-- calendar one, and that there is no duration column to look for.
COMMENT ON TABLE oee.downtime_log_events IS
  'One machine stop, as logged. IMMUTABLE and append-only: no operator mutation '
  'may ever target this table, which is the entire reason it exists apart from '
  'oee.downtime_reports (which operators edit). Grain: one row per event, keyed '
  'on a deterministic event_id from Silver. reasons is a text[] and EVERY element '
  'counts — a reason''s frequency is the number of EVENTS carrying it, and an '
  'element repeated inside one row counts once. ''{}'' means no reason was '
  'recorded and is the only way to say so. shift_date is the SHIFT''s business '
  'day, so shift-3 events after midnight carry the previous calendar date. There '
  'is NO duration, start_at or end_at: this table records that a reason was '
  'cited, not how long it lasted. EMPTY until the work_unit_* DAG writes it — see '
  'docs/gold-write-contract.md §3.9.';

COMMENT ON COLUMN oee.downtime_log_events.event_id IS
  'Deterministic identifier for the stop, carried through from the Silver event. The WHOLE primary key, because a table with no timestamps has no composite candidate — and that is what makes filing one event under two shifts impossible. This is the key docs/gold-write-contract.md §2.1 and §3.3.2 have been asking for on downtime_reports.source_event_id; writing the same string into both makes the two tables reconcilable.';
COMMENT ON COLUMN oee.downtime_log_events.shift_date IS
  'The SHIFT''s business day, as a real date. Matches product_count_wu_shift.shift_date and reject_count_wu_shift.shift_date, NOT work_unit_shift_reports.date (a shift-start instant). With no instant on this row, this column plus time_zone is the only record of how the day was cut.';
COMMENT ON COLUMN oee.downtime_log_events.reasons IS
  'Every reason this stop cited, one element each. ALL elements count, unlike downtime_reports.reason where only element 0 is read — which is why this column is a text[] and not a jsonb array (contract §3.9). A reason repeated inside one row counts ONCE: the reader explodes with SELECT DISTINCT event_id, reason. ''{}'' means no reason was recorded and folds into a single unattributed bucket; ck_dtle_reasons rejects NULL and blank elements so that spelling is unambiguous. NO DEFAULT, deliberately: a forgotten column must fail the load rather than mark every stop unattributed.';
COMMENT ON COLUMN oee.downtime_log_events.category IS
  'The stop''s operation type, reusing the enum downtime_reports.category uses so no second vocabulary can drift. Carried but NOT READ: the Others tab counts every stop regardless of category. A category filter would move the Pareto''s denominator, so per TODOS.md §25 it arrives with a LIMIT, an "Other" bucket and server-side sorting, or not at all.';
COMMENT ON COLUMN oee.downtime_log_events.work_unit_name IS
  'Denormalised machine name. NOT NULL, unlike the report tables in 0003: a Pareto row that cannot name its machine is not one.';
COMMENT ON COLUMN oee.downtime_log_events.time_zone IS
  'The IANA zone shift_date was cut in. Makes the business-day rule auditable from the data rather than from a DAG''s source — and it is load-bearing here in a way it is not on 0006 or 0008, because this table has no instant from which the day could be recomputed.';

-- ---------------------------------------------------------------------------
-- The watermark vocabulary — eight names becomes nine
-- ---------------------------------------------------------------------------
--
-- 0005 constrains etl_watermarks.table_name to the real table names precisely
-- because `{{ this.identifier }}` resolves to the dbt MODEL name. Extending the
-- list is a migration, which is the point: without the check a renamed-but-not-
-- repointed model would write a watermark under a key no reader looks at, and
-- nothing would fail.
--
-- CONSEQUENCE WORTH READING TWICE, and it is the same one 0006 and 0008 shipped:
-- the dbt MODEL MUST BE NAMED `downtime_log_events`. A mismatched name fails the
-- watermark insert loudly. If your insert is rejected, the model name is wrong,
-- not the check.
--
-- This watermark is not optional decoration, and it carries more weight on this
-- endpoint than on any other except /rejects. The Others tab renders an empty
-- result two different ways — "no downtime events recorded for this shift" and
-- "not loaded yet" — and the second is the honest one until the DAG runs. With no
-- row here every reader must assume never-loaded, which is correct today and
-- becomes wrong silently the moment events arrive without a watermark.
--
-- Plain ALTER rather than a DO-block guard: DROP ... IF EXISTS followed by ADD is
-- idempotent as a pair, and if the constraint is not the shape this file expects
-- the ADD must fail rather than pass silently.
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
  'downtime_log_events'
));

-- ---------------------------------------------------------------------------
-- Audit triggers
-- ---------------------------------------------------------------------------
--
-- oee.log_write() takes the primary key columns as trigger arguments precisely
-- so it needs no per-table variant. Statement-level for INSERT and row-level for
-- UPDATE/DELETE, for the reasons set out at length in 0004: the pipeline is the
-- bulk path and the operator is the precise one.
--
-- HERE THE ROW-LEVEL TRIGGER IS NOT DECORATION, IT IS THE TRIPWIRE FOR THE
-- PRODUCT DECISION. 0008's equivalent says "no operator mutation targets this
-- table today"; on this table none may EVER, because an append-only log is the
-- whole feature. If one ever does, oee.write_audit is what will say so.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.downtime_log_events
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.downtime_log_events
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('event_id');
