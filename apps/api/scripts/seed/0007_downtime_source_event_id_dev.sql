-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds in that directory, so a seed placed there would fabricate a production
-- identifier for every stop in every environment the migrator touches. That
-- identifier is the ON CONFLICT target contract §2.1 asks the PIPELINE for; this
-- service inventing one in production would silently make a DAG's upsert key
-- disagree with the ids Silver assigns.
--
-- WHY IT EXISTS
--
-- The PIPELINE does not write `oee.downtime_reports.source_event_id`. Migration
-- 0007 added the column, contract §3.3.2 asks for it, and TODOS.md §19 states the
-- consequence plainly: "oee.downtime_report_history cannot attach to anything."
-- Everything the downtime edit does keys on that column —
-- `PATCH /api/v1/downtimes/:sourceEventId`, the per-field trail, the Changes
-- History panel, the stale-metrics banner — so a stop without one is CORRECT AND
-- UNREACHABLE. This file makes a shift's stops reachable on a dev database.
--
-- CHECK BEFORE YOU RUN IT. The shared dev database already has some: at the time
-- of writing three of its seventeen rows carry hand-seeded UUIDs, and one of them
-- has two hand-written history rows against it. On THAT database this file is
-- nearly a no-op and you probably do not need it — the feature is already
-- exercisable on those three stops. It earns its place on a database where
-- nothing has been seeded: a fresh local Postgres, or one restored from a dump.
--
--   SELECT count(*) AS total, count(source_event_id) AS tracked
--     FROM oee.downtime_reports
--    WHERE work_unit_id = 3 AND shift = 3
--      AND start_at >= (('2026-08-01'::date + '23:00'::time) AT TIME ZONE 'Asia/Jakarta')
--      AND start_at <  (('2026-08-02'::date + '07:00'::time) AT TIME ZONE 'Asia/Jakarta');
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0007_downtime_source_event_id_dev.sql
--
-- WHAT IT TARGETS, AND WHY THAT TRIPLE
--
-- work_unit_id 3 ("Vertical Packer N"), the shift starting 2026-08-01, shift 3 —
-- oee.work_unit_shift_reports id = 8. The same triple 0008_reject_count_dev.sql
-- and 0009_downtime_log_events_dev.sql already target, so ONE browser pass over
-- that report exercises the Quality Loss tab, the Others tab and the downtime
-- edit together.
--
-- IT UPDATES; IT NEVER INSERTS. The stops themselves are already there — the
-- eight hand-seeded rows 0007's header mentions — and inserting more would change
-- the timeline strip and every Pareto on that report, which the other two seeds
-- were written against. §1 rule 2's "never inserts" is also simply true of this
-- service, and a seed that broke that rule would be teaching the wrong shape.
--
-- ONE ROW IS DELIBERATELY LEFT NULL
--
-- The lowest-id stop in the shift keeps `source_event_id IS NULL`, because that is
-- the state of every stop the PIPELINE has loaded and the browser has to be able
-- to show it: the row menu's Edit item disables itself, with a tooltip that says
-- the stop has no stable id yet, rather than offering an action that would 404. A
-- seed that filled in every row would hide the state real data is in.
--
-- WHY THE IDS DO NOT MATCH oee.downtime_log_events.event_id, AND THEY SHOULD
--
-- Contract §2.1 asks for ONE string in both tables — "write the same string into
-- both" — because that is what makes the two reconcilable and what lets §3.9's
-- second test say anything precise. It cannot be honoured here: the two dev
-- fixtures were seeded independently, `downtime_log_events` carries no timestamps
-- (§3.9, deliberately), and there is therefore NO join key between a logged event
-- and the stop it came from. Faking a correspondence would assert a reconciliation
-- that does not exist. The `dev-dtr-` prefix says out loud that these are this
-- file's ids and not the pipeline's.
--
-- IDEMPOTENT, AND IT LEAVES EXISTING IDS ALONE. `WHERE source_event_id IS NULL`
-- means a second run is a no-op, and a row that already carries a hand-seeded or
-- pipeline-written id is never touched — which matters twice over:
-- downtime_reports_source_event_key is UNIQUE, and renumbering a stop that history
-- rows already point at would orphan its trail.

-- THE SHIFT IS NAMED BY ITS WINDOW, NOT BY A BUCKET COLUMN. This used to read
-- `d.date::date = '2026-08-01'` — migration 0022 dropped `date`, and that
-- predicate was doubly wrong to keep anyway: `timestamptz::date` resolves through
-- the SESSION time zone, so the very cast contract §22.2 forbids for the backfill
-- was sitting here deciding which rows a seed rewrote.
--
-- Shift 3 on 2026-08-01 is 23:00 that day to 07:00 the next, PLANT-LOCAL. Built
-- with AT TIME ZONE exactly as resolveShiftWindow builds it, so the offset is
-- resolved for the date rather than assumed, and half-open so a stop starting at
-- 07:00 belongs to the next shift. 'Asia/Jakarta' matches the other dev seeds
-- (0008, 0009) and the hand-seeded rows this file targets.
UPDATE oee.downtime_reports d
   SET source_event_id = 'dev-dtr-' || lpad(d.id::text, 4, '0')
 WHERE d.work_unit_id = 3
   AND d.shift = 3
   AND d.start_at >= (('2026-08-01'::date + '23:00'::time) AT TIME ZONE 'Asia/Jakarta')
   AND d.start_at <  (('2026-08-02'::date + '07:00'::time) AT TIME ZONE 'Asia/Jakarta')
   AND d.source_event_id IS NULL
   -- The one left untracked. min(id) rather than a hardcoded value: the eight
   -- rows are hand-seeded, so their ids differ per database.
   AND d.id <> (
     SELECT min(id) FROM oee.downtime_reports
      WHERE work_unit_id = 3 AND shift = 3
        AND start_at >= (('2026-08-01'::date + '23:00'::time) AT TIME ZONE 'Asia/Jakarta')
        AND start_at <  (('2026-08-02'::date + '07:00'::time) AT TIME ZONE 'Asia/Jakarta')
   );

-- What the walkthrough should see. Run it after the UPDATE above:
--
--   SELECT id, source_event_id, category, reason, actions, detail_reason
--     FROM oee.downtime_reports
--    WHERE work_unit_id = 3 AND shift = 3
--      AND start_at >= (('2026-08-01'::date + '23:00'::time) AT TIME ZONE 'Asia/Jakarta')
--      AND start_at <  (('2026-08-02'::date + '07:00'::time) AT TIME ZONE 'Asia/Jakarta')
--    ORDER BY start_at;
--
-- Exactly one row with source_event_id NULL — its Edit item is disabled — and the
-- rest addressable. Then, on report 8's Losses page:
--
--   * edit a REASON on a tracked stop: the Availability Loss Pareto moves at
--     once, the Others tab does NOT (contract §1: the event log is what was
--     OBSERVED), and no banner appears.
--   * edit a CATEGORY: the stale-metrics banner appears, because the OEE tiles,
--     the timeline strip and the waterfall are precomputed by the pipeline.
--   * approve the report, then try either: 409, naming the shift.
--
-- To put it back — e.g. to re-check the untracked state — clear the column and
-- the trail that points at it. The trail must go too: its rows are keyed on
-- source_event_id, so orphaning them would leave the Changes History panel
-- reporting edits to a stop nothing can find.
--
--   DELETE FROM oee.downtime_report_history
--    WHERE source_event_id LIKE 'dev-dtr-%';
--   UPDATE oee.downtime_reports SET source_event_id = NULL
--    WHERE work_unit_id = 3 AND shift = 3
--      AND start_at >= (('2026-08-01'::date + '23:00'::time) AT TIME ZONE 'Asia/Jakarta')
--      AND start_at <  (('2026-08-02'::date + '07:00'::time) AT TIME ZONE 'Asia/Jakarta');
