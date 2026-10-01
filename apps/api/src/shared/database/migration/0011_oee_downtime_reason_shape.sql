-- A shape guard on the two jsonb arrays an operator can now edit.
--
-- WHY THIS FILE EXISTS
--
-- `oee.downtime_reports.reason` and `.actions` were PIPELINE-WRITTEN ONLY until
-- 2026-08-25, when `PATCH /api/v1/downtimes/:sourceEventId` shipped (TODOS.md
-- §21). They carry no constraint, unlike `oee.downtime_log_events.reasons`, which
-- 0009 protects with ck_dtle_reasons and oee.text_array_has_blank() — because 0009
-- judged blank and whitespace-only elements a real hazard, and it was right.
--
-- The judgement has not changed; only the number of writers has. Until now the
-- one writer was a dbt model somebody could read; now there is an HTTP endpoint,
-- and its Zod schema is the only guard on it. Application-level validation
-- protects THAT endpoint and nothing else — a repair script, a second service, or
-- a psql session bypasses it entirely. TODOS.md §40.
--
-- WHAT A BAD ELEMENT ACTUALLY DOES, because none of it throws
--
--   a blank or whitespace-only string   becomes a Pareto bucket that is NOT the
--                                       unlabelled one — a second empty bar
--                                       beside the real one, on a chart whose
--                                       bars are supposed to sum to their own
--                                       denominator
--   a non-string element                groups under its own JSON text, so
--                                       `{"code": 7}` becomes a reason label.
--                                       toStringList drops it on READ, which is
--                                       worse than it sounds: the row then reads
--                                       back as `[]`, the browser sends `[]` as
--                                       its optimistic-concurrency baseline, and
--                                       THE STOP BECOMES PERMANENTLY UNEDITABLE
--                                       — every edit 412s, telling the operator
--                                       the pipeline reloaded it
--   an over-long string                 `reason ->> 0` is the Pareto's grouping
--                                       key and has no length bound at all
--
-- SURVEYED BEFORE CONSTRAINING, WHICH IS THE ONLY REASON THIS IS SAFE
--
-- A CHECK added to a populated column fails the migration if any existing row
-- violates it, and a migration that fails against real data is worse than a
-- missing constraint. So the live table was surveyed first (TODOS.md §40 carries
-- the query and the result): all 17 rows hold proper jsonb arrays — no non-array
-- values, no non-string elements, no blank or untrimmed entries, no duplicates
-- within a row, nothing over 255 characters, longest array 3 elements.
--
-- Re-run that survey before applying this to any database whose contents differ
-- from the one it was written against.
--
-- WHAT THIS DELIBERATELY DOES NOT ENFORCE
--
--   DUPLICATES. Contract §3.9 records that the reader "trims but does not
--   case-fold" and that a duplicated element "counts once — but do not write
--   one". Rejecting them here would make a pipeline write FAIL where the reader
--   is specified to cope, which is a contract change dressed as a constraint.
--   The edit endpoint dedupes on the way in; the database tolerates what the
--   pipeline sends.
--
--   CASE. Same section: the reader trims and does not case-fold, so "Machine_Stop"
--   and "machine_stop" are two reasons by design. Folding them here would make an
--   operator's edit disagree with every pipeline-written row.
--
--   AN EMPTY ARRAY. `[]` is a legitimate value — a stop with no cited reason is
--   the unlabelled Pareto bucket, which the read path handles explicitly. Both
--   functions below return true for it, matching text_array_has_blank's own
--   "an EMPTY array is false (it has no elements)" rule read the other way up.
--
-- Plain ALTER TABLE, forward-only, per 0003's header. NOT idempotent: this must
-- fail loudly against a drifted database rather than silently doing nothing.

-- The jsonb counterpart to 0009's oee.text_array_has_blank.
--
-- A SEPARATE FUNCTION RATHER THAN A CAST TO text[], and the difference is not
-- stylistic: `jsonb -> text[]` has no direct cast, and going via
-- `ARRAY(SELECT jsonb_array_elements_text(v))` is a subquery — which a CHECK
-- admits nowhere. It also silently coerces a non-string element to its JSON text,
-- which is exactly the case this is meant to reject.
--
-- IMMUTABLE PARALLEL SAFE for the reason 0009's is: a CHECK constraint may only
-- call an immutable function, and the planner needs the parallel-safety marker to
-- use it in a parallel scan.
CREATE OR REPLACE FUNCTION oee.jsonb_is_label_array(v jsonb, max_len int)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
AS $$
  SELECT v IS NULL OR (
    jsonb_typeof(v) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v) AS e(value)
      WHERE jsonb_typeof(e.value) <> 'string'
         OR btrim(e.value #>> '{}') = ''
         OR length(e.value #>> '{}') > max_len
    )
  )
$$;

COMMENT ON FUNCTION oee.jsonb_is_label_array(jsonb, int) IS
  'True when the value is NULL, or a jsonb ARRAY whose every element is a non-blank string no longer than max_len. An EMPTY array is true (it has no elements). Exists because a CHECK constraint admits no subquery; the jsonb counterpart to oee.text_array_has_blank. Called by ck_downtime_reports_reason and ck_downtime_reports_actions.';

-- 255 to match the varchar(255) labels elsewhere in this schema and the cap the
-- edit endpoint's Zod schema already applies, so the two agree.
ALTER TABLE oee.downtime_reports
  ADD CONSTRAINT ck_downtime_reports_reason
    CHECK (oee.jsonb_is_label_array(reason, 255)),
  ADD CONSTRAINT ck_downtime_reports_actions
    CHECK (oee.jsonb_is_label_array(actions, 255));

-- detail_reason is unbounded `text` and is rendered in a drawer one record at a
-- time. The endpoint caps it at 2000; this is the same bound at the database, so
-- a second writer cannot paste a novel into a column with no limit.
--
-- NULL is permitted and meaningful — it is what "the operator cleared this" looks
-- like, and contract §13's CASE WHEN exists to preserve exactly that.
ALTER TABLE oee.downtime_reports
  ADD CONSTRAINT ck_downtime_reports_detail_reason
    CHECK (detail_reason IS NULL OR length(detail_reason) <= 2000);
