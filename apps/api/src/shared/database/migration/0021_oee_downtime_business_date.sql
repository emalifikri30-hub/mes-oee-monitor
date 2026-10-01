-- ---------------------------------------------------------------------------
-- 0021 — a real business date, and the zone it was cut in, on downtime
-- ---------------------------------------------------------------------------
--
-- Adds `business_date date` and `time_zone varchar(64)` to
-- `oee.downtime_reports`. Both NULLABLE, both NULL on every existing row.
-- Contract §22 is the ask; TODOS.md §69 is the cutover.
--
-- ONLY ONE OF THE TWO DOWNTIME TABLES NEEDS THIS. `oee.downtime_log_events`
-- (`0009`) already carries `shift_date date NOT NULL` and
-- `time_zone varchar(64) NOT NULL` — it was built after the lesson and got the
-- right shape on day one. Nothing here touches it.
--
-- AND IT IS NOT RENAMED. `shift_date` there is NOT NULL and `0009`'s header
-- chose the name deliberately, to match `product_count_wu_shift.shift_date` and
-- `reject_count_wu_shift.shift_date`. The `work_center_*` family says
-- `business_date` instead (`0014`, §16.1's divergence), so the two names for one
-- concept already coexist on purpose. Renaming a NOT NULL column the pipeline may
-- already be writing is a breaking change bought for tidiness; §22.4 records the
-- inconsistency instead. `business_date` is the name here because that is what
-- every table added since `0013` calls it.
--
-- ---------------------------------------------------------------------------
-- WHAT IS ACTUALLY WRONG WITH `date` TODAY
-- ---------------------------------------------------------------------------
--
-- `oee.downtime_reports.date` is `timestamp with time zone` (`0003`), and it has
-- NO `COMMENT`. The only statement of what it means anywhere in this repo is a
-- comment in shared/shift-window.ts:
--
--     oee.downtime_reports.date is the business day a stop STARTED in
--
-- So the VALUE is a business day and the TYPE is an instant. That is the same
-- class of wart as `work_unit_shift_reports.date`, but it is NOT the same wart,
-- and the difference decides everything below:
--
--   * `work_unit_shift_reports.date` genuinely IS an instant — the moment the
--     shift started — and reading it as a calendar day produced a real shift-3
--     bug. `0013` fixed that by ADDING `business_date` beside it, not by
--     retyping it, because the instant is still the truth about that row.
--   * `downtime_reports.date` is a day WEARING an instant's type. There is no
--     instant to preserve here (`start_at` already holds it), so the column is
--     carrying a time-of-day and an offset that mean nothing and that no reader
--     may trust.
--
-- ---------------------------------------------------------------------------
-- SO WHY NOT JUST `ALTER COLUMN date TYPE date`?
-- ---------------------------------------------------------------------------
--
-- Because the cast is WRONG, not merely risky, and it is wrong silently.
--
-- `timestamptz::date` resolves through the SESSION's `TimeZone` setting. The
-- migrator does not set one, so the cast would be taken in whatever the server
-- default happens to be — and for any plant WEST of that zone, an instant at or
-- near local midnight truncates to THE PREVIOUS DAY. Every stop on the boundary
-- silently moves one day, every window that should contain it stops containing
-- it, and nothing errors.
--
-- VERIFIED, NOT PREDICTED. Against postgres:18-alpine, one instant — local
-- midnight in a UTC+7 plant — cast under two sessions:
--
--     SET TimeZone='UTC';           ('2026-09-02 00:00:00+07')::date -> 2026-09-01
--     SET TimeZone='Asia/Jakarta';  ('2026-09-02 00:00:00+07')::date -> 2026-09-02
--
-- The server default in that container is UTC, and `scripts/migrate.mjs` sets no
-- TimeZone, so the naive backfill would have taken the FIRST branch on every row
-- of a Jakarta plant's boundary stops.
--
-- This is exactly the hazard the web app already has a rule about: a business
-- date must never go through `formatReportDate`, because that formatter takes an
-- INSTANT and resolves it into a zone, landing on the wrong day for any plant
-- west of Greenwich. A `::date` cast in the database is that same mistake with
-- DDL privileges — it does not render the wrong day, it STORES it.
--
-- ONLY THE WRITER KNOWS WHICH ZONE THE DAY WAS CUT IN, which is why the two
-- columns arrive together and why `time_zone` is not optional garnish. `0013`
-- paired them for the same reason, and TODOS.md §46 is still open on exactly
-- that pairing for the machine reports.
--
-- Three more reasons the retype is the wrong shape even setting the cast aside:
--
--   1. `dt_reports_date_wu_idx` is `btree (date DESC, work_unit_id) WHERE
--      end_at IS NOT NULL`. A type change rewrites it.
--   2. `scopeAndWindow` narrows on `date` with timestamptz arithmetic
--      (`date >= window.from - MAX_OPEN_DOWNTIME_DAYS`). Retyping the column
--      makes that comparison mean something else on a live read path, and §41
--      already documents the horizon it creates.
--   3. scripts/migrate.mjs is FORWARD-ONLY with no down path. A destructive
--      retype of a populated column is recovered by hand or not at all, and
--      `0003`'s header states the table holds live pipeline rows nobody has
--      surveyed.
--
-- So: ADD, do not replace. `date` keeps its meaning and its callers until the
-- pipeline writes `business_date` and §69 moves them over, one at a time, with
-- both columns populated and comparable. Retiring `date` is that entry's last
-- step, not this migration's first.
--
-- NO BACKFILL IN THIS FILE, for the cast reason above.
--
-- NO INDEX, for `0020`'s reason and `0007`'s before it: it would be built over a
-- column that is 100% NULL. When the load lands, §69 measures before choosing
-- between an index on `business_date` and simply letting the GiST span index from
-- `0013` serve the overlap directly, which is what §10 was always aiming at.
--
-- Plain ALTER TABLE, not IF NOT EXISTS, per `0003`'s header: forward-only, and it
-- FAILS LOUDLY against a drifted table rather than silently doing nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE oee.downtime_reports
  ADD COLUMN business_date date,
  ADD COLUMN time_zone     varchar(64);

COMMENT ON COLUMN oee.downtime_reports.business_date IS
  'The plant-local business day this stop is attributed to, as a real date. Supersedes `date`, which is a timestamptz holding the same concept and whose time-of-day and offset mean nothing. NOT derivable here by casting `date`: timestamptz::date resolves through the session TimeZone and lands a day early for any plant west of it. NULL until the pipeline writes it — contract §22, cutover in TODOS.md §69.';

COMMENT ON COLUMN oee.downtime_reports.time_zone IS
  'The IANA zone business_date was cut in, denormalised so a window can be resolved without a mes-master-data call. Ships beside business_date and not after it: a business day with no zone cannot be turned back into an instant range, which is the whole reason 0013 added the pair rather than the date alone. varchar(64) matches oee.downtime_log_events.time_zone — the two downtime tables are read side by side.';

COMMENT ON COLUMN oee.downtime_reports.date IS
  'LEGACY. Typed timestamptz, but the value is a business day (see shared/shift-window.ts) — the time-of-day and offset carry no meaning. Superseded by business_date; still NOT NULL and still the column scopeAndWindow narrows on, so it stays until TODOS.md §69 moves the callers. Do not add new readers.';
