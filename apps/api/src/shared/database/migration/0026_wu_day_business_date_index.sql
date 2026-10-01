-- ---------------------------------------------------------------------------
-- 0026 — the composite index the machine day table was missing
-- ---------------------------------------------------------------------------
--
-- The OEE Performance dashboard draws a daily OEE curve under a month report, by
-- joining a month row to its day rows on (scope id, business_date). See
-- shared/oee-trend.ts. That predicate already had a perfect index on two of the
-- three subjects and none on the third — the one the dashboard ships for first:
--
--   work_center_day_reports  wc_day_report_wc_date_idx (work_center_id, business_date DESC)
--   area_day_reports         area_day_reports_key      (area_id,        business_date)
--   work_unit_day_reports    wu_day_report_wu_date_idx (work_unit_id,   date DESC)   <-- `date`
--                            wu_day_report_business_date_idx (business_date DESC)
--                            wu_day_report_wu_idx      (work_unit_id)
--
-- THE NEAR MISS IS THE POINT. `wu_day_report_wu_date_idx` looks like the index
-- this query wants and is not: its second column is `date`, the `timestamptz`
-- that 0013 left in place beside the honest `business_date`. A reader checking
-- "is there an index on work unit and date" finds one and stops. So the planner
-- falls back to `wu_day_report_wu_idx`, narrows to every day ever recorded for
-- that machine, and filters ~30 rows out of it. Correct, and it degrades with
-- exactly the thing a report table is designed to accumulate.
--
-- WHY `business_date` AND NOT `date`, given both exist. The join is on the
-- business day because that is what a month report's window is expressed in
-- (0013 §15.3: a business day runs 07:00 -> 07:00 plant-local, and a month row's
-- business_date is the first business day of the month). `date` is an instant and
-- cannot be range-compared against a month boundary without a zone.
--
-- `wu_day_report_wu_idx (work_unit_id)` BECOMES REDUNDANT — it is now a strict
-- prefix of this index — but is left in place deliberately. Dropping it needs a
-- survey of what else plans on it, which is separate work and is filed in
-- TODOS.md rather than done in passing.
--
-- BUILT NON-CONCURRENTLY, AND THAT IS FORCED, NOT CHOSEN — scripts/migrate.mjs
-- runs each file inside `sql.begin()`, and CREATE INDEX CONCURRENTLY is illegal
-- inside a transaction block. 0013's header states the same constraint and the
-- same reasoning about the SHARE lock; the table is written by Airflow in
-- scheduled batches, not continuously.
--
-- IF NOT EXISTS because this file may be applied against a database where an
-- equivalent index was built by hand. It is additive, so unlike 0003's blanket
-- idempotency this does not hide drift: there is nothing here to reconcile.

CREATE INDEX IF NOT EXISTS wu_day_report_wu_business_date_idx
  ON oee.work_unit_day_reports USING btree (work_unit_id, business_date DESC);

COMMENT ON INDEX oee.wu_day_report_wu_business_date_idx IS
  'Serves the month-report -> day-rows join behind the OEE Performance trend (shared/oee-trend.ts). Matches wc_day_report_wc_date_idx and area_day_reports_key on the other two subjects.';
