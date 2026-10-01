-- ---------------------------------------------------------------------------
-- 0020 — SKU attribution for downtime
-- ---------------------------------------------------------------------------
--
-- Adds `product_id` / `product_name` to the two downtime tables so a stop can
-- say WHICH SKU WAS RUNNING when it happened. Requested by contract §21; the
-- SKU/Product daily report (TODOS.md §65) cannot exist without it.
--
-- WHY THE SKU AXIS IS DIFFERENT FROM EVERY AXIS THIS TABLE ALREADY HAS
--
-- 0019's header states the rule that has governed every one of these decisions
-- so far: a reject is a COUNT AT A COUNT POINT, so the line has its own; a stop
-- is an EVENT IN TIME, and a stop on a machine genuinely IS a stop on the line.
-- That is why downtime is scoped by query param at any level of the hierarchy
-- and why the Others tab was explicitly NOT "fixed" to match the reject tables.
--
-- THAT REASONING DOES NOT CARRY TO SKU, and this migration exists because it
-- does not. The hierarchy axis is containment — a work unit is inside a work
-- center, permanently, so an event on the child is an event on the parent. SKU
-- is not containment, it is OCCUPANCY OVER TIME: a line runs SKU A, then SKU B.
-- A stop while A was running is NOT a stop on B. There is no query param that
-- can derive that, because the fact is not in the row.
--
-- SO THIS IS A COLUMN AND NOT A SCOPE. `SCOPE_COLUMN` in downtime.ts maps
-- work-unit and work-center and refuses the rest; product is a FILTER applied
-- alongside a scope, never a fifth member of that enum. A SKU report is always
-- "this SKU, on this line" — contract §21.2.
--
-- ---------------------------------------------------------------------------
-- THE UNIQUE KEY DECIDES THE ATTRIBUTION RULE. READ THIS BEFORE MODELLING IT.
-- ---------------------------------------------------------------------------
--
-- 0007 put a UNIQUE index on `source_event_id`. That is TODOS.md §19's
-- idempotency key and the ON CONFLICT target a dbt upsert will eventually need.
-- It means A STOP IS ONE ROW, PERMANENTLY.
--
-- So a stop that straddles a changeover — starts under SKU A, ends under SKU B —
-- MUST NOT BE SPLIT INTO TWO ROWS. Two rows would carry the same
-- `source_event_id` and the second INSERT would fail the unique index; writing
-- one of them with a NULL `source_event_id` to dodge that would resurrect the
-- duplicate-on-retry bug 0007 exists to close. The pipeline picks ONE product,
-- or writes NULL. Contract §21.3 asks which rule it picks and asks for it to be
-- stated rather than left to the model.
--
-- ---------------------------------------------------------------------------
-- NULL MEANS "NOT ATTRIBUTED". IT DOES NOT MEAN "NO PRODUCT WAS RUNNING".
-- ---------------------------------------------------------------------------
--
-- Both columns are NULLABLE and every existing row has them NULL, which is the
-- only honest state until Airflow writes them. Two consequences a reader must
-- carry, and the second is the one that produces a wrong number quietly:
--
--   1. A SKU-scoped read filtering `product_id = X` EXCLUDES every unattributed
--      stop. Until the pipeline writes this column that is EVERY stop, so a SKU
--      report's Availability reads 100% and its downtime table is empty — a
--      plausible screen, not an error. Whatever renders it must distinguish "no
--      stops" from "no attribution", exactly as §8/§14 made the ETL-not-loaded
--      case distinguishable from the nothing-happened case.
--
--   2. PER-SKU DOWNTIME DOES NOT SUM TO THE LINE'S DOWNTIME while any row is
--      unattributed, and the residual is invisible on a per-SKU screen. This is
--      the "measured, not summed" rule (0014, 0016, 0018, 0019) arriving from
--      the other direction: there, summing children OVERSTATED nothing but
--      contradicted a measured parent; here, summing the attributed rows
--      UNDERSTATES the parent by exactly the unattributed remainder. A SKU
--      waterfall and the line waterfall above it will disagree, and the
--      disagreement is correct.
--
-- NO PAIRING CHECK — `(product_id IS NULL) = (product_name IS NULL)` was
-- considered and declined. Every other denormalised name on this table
-- (work_unit_name, work_center_name, area_name from 0007) is nullable with no
-- such guard, and adding one for product alone would assert a coherence rule
-- three older columns do not keep. Contract §21.4 asks for the guarantee in
-- prose instead, where the other three already ask for it.
--
-- NO NEW INDEX, and this is deliberate rather than forgotten. 0007 declined to
-- index `reason ->> 0` on the same grounds and TODOS.md §10 ruled that indexing
-- this table is not worth doing at its current row count — it held 8 rows on
-- 2026-08-13 and no pipeline writes `product_id` yet, so an index would be built
-- over a column that is 100% NULL. When the load lands, the likely answer is
-- `product_id` as a leading column on a SECOND gist index rather than a change
-- to `dt_reports_span_gist` — whose expression every query must repeat character
-- for character, so altering it silently unindexes the callers that do. TODOS.md
-- §65 carries that as the measurement to take first.
--
-- Plain ALTER TABLE, not IF NOT EXISTS, per 0003's header: forward-only, and it
-- FAILS LOUDLY against a drifted table rather than silently doing nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE oee.downtime_reports
  ADD COLUMN product_id   integer,
  ADD COLUMN product_name varchar(255);

COMMENT ON COLUMN oee.downtime_reports.product_id IS
  'The SKU running when this stop occurred. NULL means NOT ATTRIBUTED, never "no product" — a SKU-scoped read silently excludes these rows, so per-SKU downtime does not sum to the line''s while any remain. One product per stop: source_event_id is UNIQUE, so a stop straddling a changeover is attributed to one SKU or to none, never split. Contract §21.';
COMMENT ON COLUMN oee.downtime_reports.product_name IS
  'Denormalised from mes-master-data, matching work_unit_name / work_center_name / area_name on this table — nullable and unpaired with its id, for the same reason those three are. Contract §21.4.';

-- ---------------------------------------------------------------------------
-- oee.downtime_log_events — the Others tab's count, same axis, same rule
-- ---------------------------------------------------------------------------
--
-- This table is one row per real-world event with NO duration and NO instant
-- (0009): the pipeline assigns each event to exactly one
-- (work_unit_id, shift_date, shift) and the contribution is 1. Adding a SKU
-- changes none of that — it adds one more thing the pipeline must decide at
-- assignment time, and it must decide it the SAME WAY it decides it for
-- downtime_reports, or the Others tab and the Availability Pareto on one screen
-- will attribute the same real stop to two different SKUs. Contract §21.5.
--
-- It gets the columns even though it has no duration, because the Losses page's
-- Others tab is per-SKU on a SKU report for the same reason every other tab is:
-- a stop under SKU A is not a stop under SKU B, whether it is being counted or
-- being timed.
-- ---------------------------------------------------------------------------

ALTER TABLE oee.downtime_log_events
  ADD COLUMN product_id   integer,
  ADD COLUMN product_name varchar(255);

COMMENT ON COLUMN oee.downtime_log_events.product_id IS
  'The SKU running when this event occurred. NULL means NOT ATTRIBUTED. MUST agree with oee.downtime_reports.product_id for the same real-world stop — the two are read side by side on one Losses page. Contract §21.5.';
COMMENT ON COLUMN oee.downtime_log_events.product_name IS
  'Denormalised from mes-master-data, matching work_unit_name / work_center_name / area_name on this table. Contract §21.4.';
