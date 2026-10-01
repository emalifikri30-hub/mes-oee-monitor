-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds in that directory, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
-- WHY IT EXISTS
--
-- oee.downtime_log_events ships EMPTY, because
-- docs/gold-write-contract.md §1 rule 2 is that this service never inserts. That
-- is correct and it is also untestable by eye: the Others tab's only reachable
-- state without rows is its empty state. This file fills in five events chosen so
-- that every counting rule the feature depends on is VISIBLE IN A BROWSER rather
-- than only in a test.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0009_downtime_log_events_dev.sql
--
-- WHAT IT TARGETS, AND WHY THAT TRIPLE
--
-- work_unit_id 3 ("Vertical Packer N"), shift_date 2026-08-01, shift 3 — the
-- same triple 0008_reject_count_dev.sql seeds, which is
-- oee.work_unit_shift_reports id = 8. Deliberately the same, so the Others tab
-- and the Quality Loss tab describe ONE shift and a single browser pass can look
-- at both. It is also a shift that crosses midnight at UTC+7, which is what makes
-- the business-day join worth looking at rather than merely worth asserting.
--
-- THE FIVE EVENTS, AND WHAT EACH ONE PROVES
--
--   dev-dtle-0001  {Machine_Stop, Material_Jam}                one row, many reasons
--   dev-dtle-0002  {Material_Jam, Operator_Break, Machine_Stop} the overlap that makes
--                                                              occurrences > events
--   dev-dtle-0003  {Machine_Stop}                              the plain case
--   dev-dtle-0004  {Material_Jam, Material_Jam}                a DUPLICATE inside one
--                                                              row counts ONCE
--   dev-dtle-0005  {}                                          unattributed — and still
--                                                              an event
--
-- Expected bars: Machine_Stop 3, Material_Jam 3, Operator_Break 1, Unspecified 1.
-- totalOccurrences = 8, totalEvents = 5. The card must therefore read "8 reason
-- occurrences across 5 downtime events", and the two 3s exercise the reason ASC
-- tiebreak on screen (Machine_Stop ranks first).
--
-- THE DUPLICATE IS THE ONE WORTH WATCHING. If the reader ever loses its
-- SELECT DISTINCT event_id, reason, Material_Jam renders 4 and OUTRANKS
-- Machine_Stop — so the bug shows up as a DIFFERENT CHART, not merely a different
-- number, which is the failure mode a screenshot can catch.
--
-- ALWAYS CAST THE ARRAY. postgres.js and psql both need an element type to infer,
-- and '{}' has no element: an uncast empty array fails with "cannot determine type
-- of empty array". That failure looks like a migration problem and is not.

INSERT INTO oee.downtime_log_events (
  event_id, work_unit_id, shift_date, shift, reasons, category,
  work_unit_name, work_unit_code, work_center_id, work_center_name,
  area_id, area_name, time_zone
) VALUES
  ('dev-dtle-0001', 3, '2026-08-01', 3,
   '{Machine_Stop,Material_Jam}'::text[], 'UNPLANNED',
   'Vertical Packer N', 'VP-N', 1, 'Line 1', NULL, NULL, 'Asia/Jakarta'),

  ('dev-dtle-0002', 3, '2026-08-01', 3,
   '{Material_Jam,Operator_Break,Machine_Stop}'::text[], 'UNPLANNED',
   'Vertical Packer N', 'VP-N', 1, 'Line 1', NULL, NULL, 'Asia/Jakarta'),

  ('dev-dtle-0003', 3, '2026-08-01', 3,
   '{Machine_Stop}'::text[], 'SMALL_STOP',
   'Vertical Packer N', 'VP-N', 1, 'Line 1', NULL, NULL, 'Asia/Jakarta'),

  -- The duplicate. See the header: without the reader's DISTINCT this row makes
  -- Material_Jam outrank Machine_Stop.
  ('dev-dtle-0004', 3, '2026-08-01', 3,
   '{Material_Jam,Material_Jam}'::text[], 'UNPLANNED',
   'Vertical Packer N', 'VP-N', 1, 'Line 1', NULL, NULL, 'Asia/Jakarta'),

  -- The unattributed stop. '{}' is the ONLY spelling of "no reason recorded" —
  -- ck_dtle_reasons rejects NULL and blank elements. It must still count toward
  -- totalEvents, which is what the reader's LEFT JOIN is for.
  ('dev-dtle-0005', 3, '2026-08-01', 3,
   '{}'::text[], 'PLANNED',
   'Vertical Packer N', 'VP-N', 1, 'Line 1', NULL, NULL, 'Asia/Jakarta')
ON CONFLICT (event_id) DO UPDATE SET
  reasons        = EXCLUDED.reasons,
  category       = EXCLUDED.category,
  shift_date     = EXCLUDED.shift_date,
  shift          = EXCLUDED.shift,
  work_unit_name = EXCLUDED.work_unit_name,
  time_zone      = EXCLUDED.time_zone;

-- WITHOUT THIS ROW THE TAB SAYS "not loaded yet" FOREVER, however many events are
-- seeded above. lib/watermark.ts compares the report's business day against
-- oee.etl_watermarks.last_business_date, and a missing row means "never loaded"
-- by design (contract §4: "A missing row means 'never loaded', which is why
-- nothing is seeded"). Same shape and same writer as the reject seed's row.
INSERT INTO oee.etl_watermarks
  (table_name, last_run_at, last_business_date, rows_total, run_id, writer)
VALUES
  ('downtime_log_events', now(), '2026-08-01', 5, NULL, 'manual-seed')
ON CONFLICT (table_name) DO UPDATE SET
  last_run_at        = EXCLUDED.last_run_at,
  last_business_date = EXCLUDED.last_business_date,
  rows_total         = EXCLUDED.rows_total,
  writer             = EXCLUDED.writer;

-- ---------------------------------------------------------------------------
-- BLANK-ELEMENT VARIANT — uncomment to watch the constraint reject it
-- ---------------------------------------------------------------------------
--
-- ck_dtle_reasons calls oee.text_array_has_blank(), which exists because a CHECK
-- admits no subquery. This row is what proves the function is wired: it must fail
-- with `violates check constraint "ck_dtle_reasons"`. A whitespace-only element
-- is the case the naive subquery-free formulations miss, so it is the one worth
-- running by hand.
--
-- INSERT INTO oee.downtime_log_events (
--   event_id, work_unit_id, shift_date, shift, reasons,
--   work_unit_name, time_zone
-- ) VALUES
--   ('dev-dtle-blank', 3, '2026-08-01', 3,
--    '{Machine_Stop,"   "}'::text[],
--    'Vertical Packer N', 'Asia/Jakarta');
--
-- And the multi-dimensional case, which ck_dtle_reasons_1d rejects because
-- unnest() would flatten it into elements nobody wrote:
--
-- INSERT INTO oee.downtime_log_events (
--   event_id, work_unit_id, shift_date, shift, reasons,
--   work_unit_name, time_zone
-- ) VALUES
--   ('dev-dtle-2d', 3, '2026-08-01', 3,
--    '{{Machine_Stop},{Material_Jam}}'::text[],
--    'Vertical Packer N', 'Asia/Jakarta');
