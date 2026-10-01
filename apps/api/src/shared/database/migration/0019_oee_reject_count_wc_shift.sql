-- ===========================================================================
-- 0019 — oee.reject_count_wc_shift: the LINE's rejects, per reason, per SKU
-- ===========================================================================
--
-- Backs the Quality Loss Pareto on the Line report's Losses page, which until now
-- read `oee.reject_count_wu_shift` scoped by `work_center_id` — i.e. it SUMMED
-- THE MACHINES' reject counters.
--
-- ---------------------------------------------------------------------------
-- WHY THAT WAS WRONG, AND IT IS THE SAME REASON THREE TIMES OVER
-- ---------------------------------------------------------------------------
--
-- A LINE IS MEASURED, NOT SUMMED (`0014`, commit 4fccce8). `0016` makes that
-- argument for per-SKU counts and `0018` for hourly production; this is the third
-- table it forces, and the sharpest, because the contradiction is on ONE SCREEN
-- and only two cards apart:
--
--   the Losses card's Reject tile    work_center_shift_reports.reject
--                                    -> the LINE's own infeed count point
--   the Quality Loss Pareto below    sum of the machines' counters
--                                    -> a different set of count points entirely
--
-- Those two disagree, the disagreement is CORRECT, and nothing on the page can
-- explain it. A supervisor reading "Reject 5,000 BAG" above a Pareto whose bars
-- total something else has been handed two right answers to one question.
--
-- The machine table is not wrong — it is the MACHINES' rejects, and the machine
-- report's own Pareto reads it correctly. What was wrong was pointing a LINE
-- screen at it and changing only the WHERE clause. The WHERE changed the GRAIN.
--
-- ---------------------------------------------------------------------------
-- WHY THE OTHERS TAB NEEDS NO EQUIVALENT
-- ---------------------------------------------------------------------------
--
-- It reads `oee.downtime_log_events` at line scope and that is CORRECT, because a
-- reject and a stop are different KINDS of fact:
--
--   a reject is a COUNT AT A COUNT POINT.  The line has its own, so the machines'
--                                          counters are a different measurement.
--   a stop is an EVENT IN TIME.            A stop on a machine IS a stop on the
--                                          line. The union is the answer, which is
--                                          why downtime is scoped by query param
--                                          at work unit, work center, area or
--                                          factory and always has been.
--
-- Do not "fix" the Others tab to match this file. It is already right.
--
-- ---------------------------------------------------------------------------
-- ONE TABLE, WIDENED — no day or month sibling
-- ---------------------------------------------------------------------------
--
-- `reject_count_wu_shift` has no day or month table either: the day and month
-- Paretos widen the shift table over a `shift_date` range. Same here, and for the
-- same reason `0016` gives for stopping at two — a second table is a second thing
-- to keep consistent for a read that a range already answers.
--
-- SHIPS EMPTY, like `0016` and `0018`. Contract §20 is the request. Until it is
-- filled the Quality Loss Pareto at line grain shows its "not loaded yet" state,
-- which is `loadedThrough`'s whole purpose (§14) — and is a better answer than
-- the machine-sum it used to show, because that one looked right.

CREATE TABLE IF NOT EXISTS oee.reject_count_wc_shift (
  -- ---- grain --------------------------------------------------------------
  work_center_id   integer       NOT NULL,
  -- The SHIFT's business day, a real `date` — matching product_count_wc_shift
  -- (`0016`) and NOT the timestamptz the machine report tables carry. Shift 3
  -- crosses midnight, so its post-midnight rejects carry the PREVIOUS date.
  --
  -- NOTE THE NAME. The machine table calls this `shift_date`; the work_center_*
  -- family calls it `business_date` (0014's divergence, §16.1). This follows its
  -- own family, so the reader that widens it over a range uses the same column
  -- name as every other line read.
  business_date    date          NOT NULL,
  shift            smallint      NOT NULL,
  product_id       integer       NOT NULL,
  -- WHICH COUNT POINT recorded the rejects, as the line reads it. A primary-key
  -- member, so it must be STABLE — a renamed tag reads as a new counter and
  -- splits one shift's history in two. Contract §3.8's rule, one grain up.
  reason           varchar(255)  NOT NULL,

  -- ---- dimensions, denormalised -------------------------------------------
  work_center_name varchar(255)  NOT NULL,
  work_center_code varchar(255),
  area_id          integer,
  area_name        varchar(255),
  product_name     varchar(255),
  product_code     varchar(255),

  -- ---- the reason's TWO identities, exactly as 0008 carries them -----------
  reason_code      varchar(255),
  reason_id        integer,
  source_tag       varchar(255),
  count_point_id   integer,

  -- NO work_unit_id, AND THAT IS THE POINT OF THE FILE. These are the LINE's
  -- count points. If a reject can be attributed to a machine it belongs in
  -- reject_count_wu_shift, which already exists and which the machine report
  -- reads. A nullable work_unit_id here would invite exactly the roll-up this
  -- table replaces.

  -- ---- the counter, in the SENSOR's own unit ------------------------------
  uom_id           integer       NOT NULL,
  uom_name         varchar(255),
  uom_code         varchar(255)  NOT NULL,
  counter_value    numeric(15,3) NOT NULL,

  -- ---- the same rejects, in the comparable unit ---------------------------
  base_uom_id      integer       NOT NULL,
  base_uom_name    varchar(255),
  base_uom_code    varchar(255)  NOT NULL,
  factor_to_base   numeric(10,3) NOT NULL,
  -- GENERATED, like 0008's: the database owns this arithmetic so a reader cannot
  -- drift from what a BI tool sees off the same row.
  converted_value  numeric(15,3)
    GENERATED ALWAYS AS (round(counter_value * factor_to_base, 3)) STORED,

  weight_gram      numeric(15,3),

  frequency        integer       NOT NULL,
  reject_time      bigint,

  time_zone        varchar(64)   NOT NULL,

  CONSTRAINT pk_reject_count_wc_shift
    PRIMARY KEY (work_center_id, business_date, shift, product_id, reason),
  CONSTRAINT ck_rcwcs_shift  CHECK (shift BETWEEN 1 AND 3),
  -- 0008's admission, unchanged: any positive value passes, so a wrong-but-
  -- positive factor renders a plausible number rather than failing. Contract §3.4
  -- asks for the per-(product, uom, base_uom) guarantee nothing downstream can
  -- validate.
  CONSTRAINT ck_rcwcs_factor CHECK (factor_to_base > 0),
  -- An empty reason would become an unlabelled bar with a primary-key row behind
  -- it, which is worse than a rejected load.
  CONSTRAINT ck_rcwcs_reason CHECK (btrim(reason) <> ''),
  CONSTRAINT ck_rcwcs_nonneg CHECK (
    counter_value >= 0 AND frequency >= 0
    AND (weight_gram IS NULL OR weight_gram >= 0)
    AND (reject_time IS NULL OR reject_time >= 0)
  ),
  -- A counter that recorded a quantity must have recorded an occurrence. ONE
  -- DIRECTION ONLY: frequency > 0 with counter_value = 0 is legitimate — the
  -- counter fired and nothing was rejected. The reverse is not: the row would
  -- rank in the quantity measure and vanish from the frequency one, which is a
  -- chart disagreeing with its own table.
  CONSTRAINT ck_rcwcs_freq_agrees CHECK (counter_value = 0 OR frequency > 0)
);

-- TWO INDEXES, and no more. This service's only read is a range over
-- (work_center_id, business_date[, shift]) — the primary key's LEFT PREFIX — so
-- it needs none of its own. Both below are for the pipeline and ad-hoc reporting,
-- mirroring the pair 0008 carries.

CREATE INDEX IF NOT EXISTS ix_rcwcs_reason_date
  ON oee.reject_count_wc_shift USING btree (reason, business_date);

CREATE INDEX IF NOT EXISTS ix_rcwcs_product_date
  ON oee.reject_count_wc_shift USING btree (product_id, business_date);

-- The watermark, so the pipeline's post-hook has somewhere to write (0005) and so
-- the Pareto can tell "not loaded yet" from "this line rejected nothing".
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
  'downtime_log_events',
  'work_center_shift_reports',
  'work_center_day_reports',
  'work_center_month_reports',
  'product_count_wc_shift',
  'product_count_wc_day',
  'product_perf_wc_hour',
  'reject_count_wc_shift'
));

-- Audited like every other pipeline table: bulk INSERT per statement, and the
-- row-level trigger as a TRIPWIRE — no operator mutation targets this table, so
-- if it ever fires, something in this service is writing where it must not.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.reject_count_wc_shift
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.reject_count_wc_shift
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_center_id', 'business_date', 'shift', 'product_id', 'reason');

COMMENT ON TABLE oee.reject_count_wc_shift IS
  'The LINE''s rejects per reason and SKU, from the line''s own count points. NOT a roll-up of reject_count_wu_shift: a line is measured, not summed, so summing the machines'' counters contradicts work_center_shift_reports.reject two cards away on the same screen. Contract §20.';
COMMENT ON COLUMN oee.reject_count_wc_shift.reason IS
  'The count point as the LINE reads it. A primary-key member, so it must be stable — a renamed tag reads as a new counter and splits one shift''s history in two.';
COMMENT ON COLUMN oee.reject_count_wc_shift.converted_value IS
  'counter_value in base_uom_code. GENERATED, so a reader cannot drift from what a BI tool sees off the same row. The only figure the Pareto ranks on.';
