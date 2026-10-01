-- ===========================================================================
-- 0015 — `line_out`: the fourth count on the LINE grain
-- ===========================================================================
--
-- The Line report DETAIL screen's overview card shows four production figures
-- where oee.work_center_*_reports carries three. This adds the fourth.
--
-- WRITTEN BY Apache Airflow -> dbt, like every other column on these tables.
-- This service reads it and never writes it. docs/gold-write-contract.md §16 is
-- the request; it ships NULL everywhere until that DAG lands, and the tile then
-- renders an em dash rather than a zero — see below.
--
-- ---------------------------------------------------------------------------
-- WHICH SIDE IT IS ON, WHICH IS THE ONLY QUESTION THAT MATTERS HERE
-- ---------------------------------------------------------------------------
--
-- 0014's header is the thing to read first: a line has TWO count points and they
-- are usually in different units. Bags go in, cartons come out.
--
--          INFEED side                        OUTPUT side
--     (what the line consumed)           (what the line shipped)
--     ┌──────────────────────┐          ┌──────────────────────┐
--     │  total_out           │          │  good_out            │
--     │  reject              │          │  effective_out       │
--     │  rework              │          │                      │
--     │  line_out    <── NEW │          │                      │
--     └──────────┬───────────┘          └──────────┬───────────┘
--         infeed_uom_*                       output_uom_*
--       ck_*_infeed_units                  ck_*_output_units
--
-- `line_out` IS ON THE INFEED SIDE, and therefore joins the infeed CHECK. It is
-- the line's own measured production at its infeed count point, denominated in
-- the same unit as total_out — so the two are comparable with each other and with
-- nothing on the other side.
--
-- `total_out = line_out + reject + rework` IS NOT ASSERTED, and deliberately not.
-- 0014 already records that a line is MEASURED, not summed, and that a model
-- expecting its parts to reconcile is expecting the wrong thing. If the pipeline
-- can make that identity hold it may; this file does not require it, because a
-- CHECK that fails a load over an arithmetic disagreement between two count
-- points would take the whole line's reporting down to protect a tile.
--
-- ---------------------------------------------------------------------------
-- WHY THE CHECK IS DROPPED AND RE-ADDED RATHER THAN ALTERED
-- ---------------------------------------------------------------------------
--
-- Postgres has no ALTER CONSTRAINT for a CHECK's expression. DROP ... IF EXISTS
-- followed by ADD is idempotent as a pair, and if the constraint is not the shape
-- this file expects the ADD must fail rather than pass silently — the call 0009
-- and 0014 both made.
--
-- The rule the CHECK enforces is unchanged and is 0014's: a count with no unit is
-- a wrong number with a missing label, so the whole infeed SET is NULL together
-- or the unit is present. `line_out` joins that set rather than getting a guard
-- of its own, because it is denominated in exactly the unit the set is about.
--
-- NULLABLE, WITH NO DEFAULT. Same reasoning as mttr/mtbf in 0013 and §15.4: a
-- DEFAULT 0 would make every unwritten row claim the line produced nothing, which
-- is a measurement. NULL renders an em dash and claims nothing.

-- ---------------------------------------------------------------------------
-- shift
-- ---------------------------------------------------------------------------

ALTER TABLE oee.work_center_shift_reports
  ADD COLUMN IF NOT EXISTS line_out numeric(15,3);

ALTER TABLE oee.work_center_shift_reports DROP CONSTRAINT IF EXISTS ck_wcsr_infeed_units;
ALTER TABLE oee.work_center_shift_reports ADD CONSTRAINT ck_wcsr_infeed_units CHECK (
  infeed_uom_id IS NOT NULL
  OR (total_out IS NULL AND reject IS NULL AND rework IS NULL AND line_out IS NULL)
);

COMMENT ON COLUMN oee.work_center_shift_reports.line_out IS
  'The line''s own measured production at its INFEED count point, in infeed_uom_* units — the figure the detail screen labels "<line name> Production". Comparable with total_out and with nothing on the output side. NULL means the members disagreed or the pipeline has not written it; never 0. Contract §16.';

-- ---------------------------------------------------------------------------
-- day
-- ---------------------------------------------------------------------------

ALTER TABLE oee.work_center_day_reports
  ADD COLUMN IF NOT EXISTS line_out numeric(15,3);

ALTER TABLE oee.work_center_day_reports DROP CONSTRAINT IF EXISTS ck_wcdr_infeed_units;
ALTER TABLE oee.work_center_day_reports ADD CONSTRAINT ck_wcdr_infeed_units CHECK (
  infeed_uom_id IS NOT NULL
  OR (total_out IS NULL AND reject IS NULL AND rework IS NULL AND line_out IS NULL)
);

COMMENT ON COLUMN oee.work_center_day_reports.line_out IS
  'The line''s own measured production at its INFEED count point — see the shift table.';

-- ---------------------------------------------------------------------------
-- month
-- ---------------------------------------------------------------------------

ALTER TABLE oee.work_center_month_reports
  ADD COLUMN IF NOT EXISTS line_out numeric(15,3);

ALTER TABLE oee.work_center_month_reports DROP CONSTRAINT IF EXISTS ck_wcmr_infeed_units;
ALTER TABLE oee.work_center_month_reports ADD CONSTRAINT ck_wcmr_infeed_units CHECK (
  infeed_uom_id IS NOT NULL
  OR (total_out IS NULL AND reject IS NULL AND rework IS NULL AND line_out IS NULL)
);

COMMENT ON COLUMN oee.work_center_month_reports.line_out IS
  'The line''s own measured production at its INFEED count point — see the shift table.';
