-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds in that directory, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
-- WHY IT EXISTS
--
-- oee.reject_count_wu_shift ships EMPTY, because
-- docs/gold-write-contract.md §1 rule 2 is that this service never inserts. That
-- is correct and it is also untestable by eye: the Quality Loss tab's only
-- reachable state without rows is its empty state. This file fills in the four
-- counters the reference design shows, so the populated path — the bars, the
-- cumulative line, the counter-versus-converted columns and the weight em dash —
-- can be looked at in a browser.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0008_reject_count_dev.sql
--
-- WHAT IT TARGETS, AND WHY THAT TRIPLE
--
-- work_unit_id 3 ("Vertical Packer N"), shift_date 2026-08-01, shift 3. That is
-- oee.work_unit_shift_reports id = 8, and it is the ONE (work_unit, shift_date,
-- shift) triple that already has product_count_wu_shift rows — so the seed is
-- consistent with the SKU View card on the same report rather than inventing a
-- product that ran nowhere else.
--
-- THE FOUR ROWS ARE THE DESIGN'S, WITH ONE DELIBERATE DEPARTURE
--
-- The mock renders `0 gr` for Total_NG_Prod and Reject_Count. This seeds NULL,
-- because that is what the design's own annotation asks for ("Some reason does
-- not have weight value") and because NULL and 0 are different claims the screen
-- renders differently. Seeding 0 would make the em dash unreachable and the
-- weight ranking untestable.
--
-- Three of the four counters count in CALENDER with factor_to_base 12, so the
-- Counter Unit and Converted columns hold VISIBLY different numbers on the same
-- row — 48 CALENDER against 576 BAG. Rendering counter_value in both columns is
-- the most plausible-looking way to get this screen wrong, and these rows are
-- what make that visible.
--
-- converted_value is NOT inserted: it is GENERATED ALWAYS ... STORED and
-- Postgres rejects any assignment to it. That is the column's whole point.
--
-- reject_time is seeded NON-NULL here even though the pipeline does not write it
-- yet, so the duration ranking has something to rank in dev. Do not read these
-- values as a claim about real reject time.

INSERT INTO oee.reject_count_wu_shift (
  work_unit_id, shift_date, shift, product_id, reason,
  work_unit_name, work_unit_code, work_center_id, work_center_name,
  product_name, product_code,
  reason_code, reason_id, source_tag, count_point_id,
  uom_id, uom_name, uom_code, counter_value,
  base_uom_id, base_uom_name, base_uom_code, factor_to_base,
  weight_gram, frequency, reject_time, time_zone
) VALUES
  (3, '2026-08-01', 3, 1, 'Total_NG_Prod',
   'Vertical Packer N', 'VP-N', 1, 'Line 1',
   'SKU A', 'SKU-A',
   NULL, NULL, 'PLC/FI2-L1/MITSUM-1/Total_NG_Prod', NULL,
   1, 'Bag', 'BAG', 4776,
   1, 'Bag', 'BAG', 1,
   NULL, 4776, 396000, 'Asia/Jakarta'),

  (3, '2026-08-01', 3, 1, 'NG_Over_Count',
   'Vertical Packer N', 'VP-N', 1, 'Line 1',
   'SKU A', 'SKU-A',
   NULL, NULL, 'PLC/FI2-L1/MITSUM-1/NG_Over_Count', NULL,
   2, 'Calender', 'CALENDER', 48,
   1, 'Bag', 'BAG', 12,
   15232, 48, 96000, 'Asia/Jakarta'),

  (3, '2026-08-01', 3, 1, 'Reject_Count',
   'Vertical Packer N', 'VP-N', 1, 'Line 1',
   'SKU A', 'SKU-A',
   NULL, NULL, 'PLC/FI2-L1/MITSUM-1/Reject_Count', NULL,
   2, 'Calender', 'CALENDER', 38,
   1, 'Bag', 'BAG', 12,
   NULL, 38, 74000, 'Asia/Jakarta'),

  (3, '2026-08-01', 3, 1, 'NG_Under_Count',
   'Vertical Packer N', 'VP-N', 1, 'Line 1',
   'SKU A', 'SKU-A',
   NULL, NULL, 'PLC/FI2-L1/MITSUM-1/NG_Under_Count', NULL,
   2, 'Calender', 'CALENDER', 17,
   1, 'Bag', 'BAG', 12,
   2571, 17, 33000, 'Asia/Jakarta')
ON CONFLICT (work_unit_id, shift_date, shift, product_id, reason) DO UPDATE SET
  counter_value = EXCLUDED.counter_value,
  weight_gram   = EXCLUDED.weight_gram,
  frequency     = EXCLUDED.frequency,
  reject_time   = EXCLUDED.reject_time;

-- WITHOUT THIS ROW THE TAB SAYS "not loaded yet" FOREVER, however many rejects
-- are seeded above. lib/watermark.ts compares the report's business day against
-- oee.etl_watermarks.last_business_date, and a missing row means "never loaded"
-- by design (contract §4: "A missing row means 'never loaded', which is why
-- nothing is seeded"). The live database's one existing watermark row was made
-- exactly this way, writer 'manual-seed'.
INSERT INTO oee.etl_watermarks
  (table_name, last_run_at, last_business_date, rows_total, run_id, writer)
VALUES
  ('reject_count_wu_shift', now(), '2026-08-01', 4, NULL, 'manual-seed')
ON CONFLICT (table_name) DO UPDATE SET
  last_run_at        = EXCLUDED.last_run_at,
  last_business_date = EXCLUDED.last_business_date,
  rows_total         = EXCLUDED.rows_total,
  writer             = EXCLUDED.writer;

-- ---------------------------------------------------------------------------
-- MIXED-UNIT VARIANT — uncomment to exercise the guard
-- ---------------------------------------------------------------------------
--
-- Give one counter a different base unit and the bucket for that reason spans
-- rows whose base_uom_code disagrees. The reader then nulls convertedUnit, the
-- Converted cell renders an em dash instead of a plausible sum of BAG and
-- CARTON, and the card shows its mixed-unit note. This is the only way to reach
-- that path by hand, and it is the path most likely to rot unnoticed.
--
-- INSERT INTO oee.reject_count_wu_shift (
--   work_unit_id, shift_date, shift, product_id, reason,
--   work_unit_name, uom_id, uom_code, counter_value,
--   base_uom_id, base_uom_code, factor_to_base,
--   weight_gram, frequency, reject_time, time_zone
-- ) VALUES
--   (3, '2026-08-01', 3, 2, 'NG_Over_Count',
--    'Vertical Packer N', 3, 'CARTON', 5,
--    3, 'CARTON', 1,
--    880, 5, 12000, 'Asia/Jakarta')
-- ON CONFLICT (work_unit_id, shift_date, shift, product_id, reason) DO NOTHING;
