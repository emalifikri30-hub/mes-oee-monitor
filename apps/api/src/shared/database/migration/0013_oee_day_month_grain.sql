-- Make oee.work_unit_day_reports and oee.work_unit_month_reports readable, and
-- give oee.work_unit_shift_reports the business day it has always needed.
--
-- WHY NOW, AND WHY THIS IS THE ONLY MOMENT IT IS CHEAP
--
-- Both roll-up tables have existed since 0003 and are EMPTY: nothing in this
-- service reads them, and no dbt model writes them yet. The pipeline owner is
-- waiting on this file before building those models. Every column below is
-- either a gap the By Day / By Monthly screens would otherwise have to work
-- around in application code, or a defect 0003 documented and could not fix.
--
-- Once Airflow starts writing, none of this is free again. A rename becomes a
-- coordinated deploy, and a new NOT NULL column becomes a backfill.
--
-- THE MISSPELLING IS CORRECTED, AND THAT REVERSES A STANDING RULE
--
-- 0003's header, AGENTS.md and TODOS.md §1 all said `availablity_loss_time` must
-- be preserved. Read the reason 0003 gave: "renaming either would break the dbt
-- models that write them." There ARE no dbt models writing these two tables —
-- that is the whole premise of this migration — so the rule protects nothing and
-- costs every future reader a double-take plus an alias in every projection.
--
-- The shift table's spelling is untouched. It is correct there, and it is
-- populated.
--
--   work_unit_shift_reports.availability_loss_time   correct, unchanged
--   work_unit_day_reports.availablity_loss_time      -> availability_loss_time
--   work_unit_month_reports.availablity_loss_time    -> availability_loss_time
--
-- Those three comments in 0003 and the paragraph in AGENTS.md are corrected in
-- the same commit as this file. A preservation rule left standing after the wart
-- is gone is worse than the wart.
--
-- business_date AND time_zone — TODOS.md §17, FINALLY
--
-- `date` is a timestamptz holding an INSTANT, so a calendar day can only be
-- derived through the plant's zone. Today that costs a mes-master-data call
-- (`TimeZoneResolver`) on the read path, and `periodFilter` cannot do it at all
-- because it spans many work units in one query — so the By Shift month filter
-- is exact for a UTC+7 plant and misattributes both ends of the month anywhere
-- west of Greenwich. Getting this wrong is what produced the shift-3 bug.
--
-- Denormalising both onto the row removes the derivation entirely. This is not a
-- new idea in this schema: oee.reject_count_wu_shift and oee.downtime_reports
-- already carry `time_zone`. It makes the report tables consistent with them.
--
-- ON THE SHIFT TABLE BOTH COLUMNS ARE NULLABLE, DELIBERATELY. It holds rows, so
-- a NOT NULL would need a DEFAULT and a table rewrite, and a DEFAULT is a
-- fabricated business day. Nullable means `ADD COLUMN` is metadata-only and
-- instant, and the reader keeps its existing zone-resolution path until Airflow
-- backfills. TODOS.md §46 tracks tightening them afterwards.
--
-- On the two empty tables they are nullable only for symmetry with the reader;
-- the contract asks the pipeline to always write them.
--
-- work_center_*, mttr AND mtbf
--
-- Present on the shift table, absent here, and both screens need them. Without
-- work_center_id the downtime edit dialog cannot scope its Reason catalogue and
-- would need a mes-master-data round trip per request. Without mttr/mtbf the
-- Downtime Details badge has nothing behind it.
--
-- mttr/mtbf are NULLABLE ON PURPOSE, and must not gain a `DEFAULT 0` to match
-- the shift table. 0 is a measurement; NULL is "nobody has computed this". The
-- screens render an em dash for NULL and "00 s" for 0, and until the pipeline
-- writes these columns the honest answer is the em dash. Commit 12a2781 exists
-- because this distinction was collapsed once already.
--
-- No CHECK on `month varchar(50)`: its format is not specified anywhere yet, and
-- guessing it here would 500 the first DAG run. docs/gold-write-contract.md asks
-- for it; a CHECK can follow once the answer is known. Nothing in this service
-- reads it — the screens format their label from business_date.

-- ---------------------------------------------------------------------------
-- The two roll-up tables
-- ---------------------------------------------------------------------------

-- Plain ALTER TABLE, not IF NOT EXISTS: 0003's header states that future changes
-- belong in a new numbered migration using plain ALTER TABLE, which fails loudly
-- rather than silently doing nothing against a drifted schema.
ALTER TABLE oee.work_unit_day_reports   RENAME COLUMN availablity_loss_time TO availability_loss_time;
ALTER TABLE oee.work_unit_month_reports RENAME COLUMN availablity_loss_time TO availability_loss_time;

ALTER TABLE oee.work_unit_day_reports
  ADD COLUMN business_date    date,
  ADD COLUMN time_zone        text,
  ADD COLUMN work_center_id   integer,
  ADD COLUMN work_center_name varchar(255),
  ADD COLUMN work_center_code varchar(255),
  ADD COLUMN mttr             bigint,
  ADD COLUMN mtbf             bigint;

ALTER TABLE oee.work_unit_month_reports
  ADD COLUMN business_date    date,
  ADD COLUMN time_zone        text,
  ADD COLUMN work_center_id   integer,
  ADD COLUMN work_center_name varchar(255),
  ADD COLUMN work_center_code varchar(255),
  ADD COLUMN mttr             bigint,
  ADD COLUMN mtbf             bigint;

-- The list screens filter by month and year across many work units, so the
-- leading column is business_date, not work_unit_id. The existing
-- wu_{day,month}_report_wu_date_idx stay: they serve the single-work-unit
-- lookups and the upsert keys still use `date`.
CREATE INDEX wu_day_report_business_date_idx
  ON oee.work_unit_day_reports USING btree (business_date DESC);

CREATE INDEX wu_month_report_business_date_idx
  ON oee.work_unit_month_reports USING btree (business_date DESC);

-- ---------------------------------------------------------------------------
-- The shift table
-- ---------------------------------------------------------------------------

-- Metadata-only: no DEFAULT, so Postgres does not rewrite the table and this is
-- instant regardless of how many rows it holds.
ALTER TABLE oee.work_unit_shift_reports
  ADD COLUMN business_date date,
  ADD COLUMN time_zone     text;

CREATE INDEX wu_shift_report_business_date_idx
  ON oee.work_unit_shift_reports USING btree (business_date DESC);

-- ---------------------------------------------------------------------------
-- oee.downtime_reports — the range index, TODOS.md §10
-- ---------------------------------------------------------------------------
--
-- WHAT THIS FIXES IS CORRECTNESS FIRST AND SPEED SECOND.
--
-- Every windowed downtime read goes through `scopeAndWindow`, which pairs a real
-- half-open overlap test on start_at/end_at with a NARROWING on `date`:
--
--     AND date >= window.from - MAX_OPEN_DOWNTIME_DAYS   -- 7 days
--     AND date <= window.to
--
-- The narrowing exists only to keep the scan sargable, because no index can
-- serve the overlap test — dt_reports_date_wu_idx is partial on
-- `end_at IS NOT NULL` and cannot see open stops at all. Its cost is a silent
-- horizon: A STOP LEFT OPEN FOR MORE THAN SEVEN DAYS IS DROPPED FROM EVERY
-- WINDOW THAT SHOULD CONTAIN IT, with no error and nothing in any log.
--
-- That was survivable at shift grain. At month grain the same narrowing spans
-- ~37 days of index instead of ~8 hours, and the month Losses page fires several
-- of these queries, so the horizon gets more expensive at exactly the moment it
-- gets more wrong.
--
-- A GiST index over the stop's actual span serves the overlap test directly, so
-- the narrowing can go. btree_gist is what lets the scope column sit in the same
-- index as the range; without it the two have to be separate and the planner
-- loses the combination.
--
-- BUILT NON-CONCURRENTLY, AND THAT IS FORCED, NOT CHOSEN. scripts/migrate.mjs
-- runs each file inside `sql.begin()` so the DDL and its schema_migrations row
-- commit together, and CREATE INDEX CONCURRENTLY is illegal inside a transaction
-- block. A plain build takes a SHARE lock: reads continue, writes block until it
-- finishes. That is acceptable here because the only bulk writer is Airflow,
-- which writes in scheduled batches rather than continuously. If this table ever
-- grows past the point where that pause is tolerable, the answer is to build the
-- index out of band and record the version by hand, NOT to weaken the migrator's
-- transaction.
-- THE `greatest(...)` IS NOT DEFENSIVE TIDYING. IT IS LOAD-BEARING, AND LEAVING
-- IT OUT TURNS THIS INDEX INTO A CONSTRAINT NOBODY AGREED TO.
--
-- `tstzrange(lower, upper)` RAISES when lower > upper. oee.downtime_reports has
-- no `CHECK (end_at IS NULL OR end_at >= start_at)` — 0003's header and contract
-- §3.2 both say inverted rows are possible, and the service drops them at
-- runtime in `clipToWindow`, counted as `downtime_rows_dropped_total`. A CHECK
-- was considered for exactly this column and DELIBERATELY NOT ADDED, because the
-- table already holds live pipeline rows that nobody has surveyed.
--
-- An expression index evaluates its expression on every existing row at build
-- time and on every row inserted afterwards. So the unguarded form would:
--
--   * FAIL THIS MIGRATION if a single inverted row already exists, and
--   * reject every future inverted INSERT with
--     "range lower bound must be less than or equal to range upper bound"
--
-- which is precisely the CHECK constraint this repo declined to impose — smuggled
-- in through an index, where nobody would look for it, and landing on Airflow's
-- bulk load rather than on a reviewer. Verified by inserting an inverted row
-- against both forms: the unguarded index rejects it, this one accepts it.
--
-- `greatest(coalesce(end_at, 'infinity'), start_at)` makes the expression total.
-- An inverted row collapses to an EMPTY range, which `&&` never matches — the
-- same outcome the service already produces by dropping it, reached without an
-- exception. Whether inverted rows should be rejected outright is still contract
-- §3.2's question to ask, and it stays open.
--
-- ANY QUERY WANTING THIS INDEX MUST REPEAT THE EXPRESSION CHARACTER FOR
-- CHARACTER, `greatest` included. A near-miss silently falls back to a scan.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE INDEX dt_reports_span_gist
  ON oee.downtime_reports USING gist (
    work_unit_id,
    work_center_id,
    tstzrange(start_at, greatest(coalesce(end_at, 'infinity'::timestamptz), start_at), '[)')
  );
