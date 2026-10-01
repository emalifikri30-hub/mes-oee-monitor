-- ---------------------------------------------------------------------------
-- 0027 — the YEAR grain, for the three subjects that have a month table
-- ---------------------------------------------------------------------------
--
-- Three tables — `oee.work_unit_year_reports`, `oee.work_center_year_reports`
-- and `oee.area_year_reports`. They back the OEE Performance dashboard's three
-- YEARLY screens and they are contract §27's ask. All three ship EMPTY.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT A WIDENED MONTH RANGE — §15.5, FOR THE THIRD TIME
-- ---------------------------------------------------------------------------
--
--     durations and counts   ->  SUM        widening a month range gives this
--     rates (oee, a, p, q)   ->  RECOMPUTE  widening a month range does NOT
--
-- A YEAR'S OEE IS NOT THE AVERAGE OF ITS MONTHS' OEEs, and it is not derivable
-- from the month rows without redoing the recompute in the reader. That would put
-- a SECOND DEFINITION OF OEE in the API, one click from the month screens the year
-- screens drill into — the failure `0023`, `0024` and `0025` each exist to
-- prevent. `0025` argues it at length between an area's month and its days; this
-- is the identical argument one grain up, and it is the whole reason these are
-- three tables rather than a `dateTo` on three existing reads.
--
-- Note what still does NOT get a year sibling on the same argument: anything that
-- sums COUNTS. Exact addition with no rate in it needs no table (§23.1), which is
-- why `0016`'s product-count pair serves a month by widening and always will.
--
-- ---------------------------------------------------------------------------
-- A DELIBERATE WIDENING OF §23.2, AND IT IS STATED RATHER THAN SLIPPED IN
-- ---------------------------------------------------------------------------
--
-- §23.2's table asks for a year grain on FACTORY ONLY; §26.5 says "No year grain"
-- in as many words. Building it for three other subjects is a decision made after
-- that was written, and contract §27 says so plainly rather than leaving the
-- pipeline owner to discover three unasked-for tables. Factory is still absent —
-- it has no report table at any grain, and `oee.downtime_reports` has no
-- `factory_id`, so it remains the one unmapped `SCOPE_COLUMN` member (TODOS §74).
--
-- ---------------------------------------------------------------------------
-- EACH TABLE IS ITS MONTH SIBLING'S MEASURE SET, COLUMN FOR COLUMN
-- ---------------------------------------------------------------------------
--
-- Deliberately, and it is the property that lets ONE payload type, ONE projection
-- and ONE card set serve both grains per subject — exactly what `0025` preserved
-- between the two area tables, which differ by one constraint and no column.
--
--   oee.work_unit_year_reports     mirrors work_unit_month_reports    (0003+0013)
--   oee.work_center_year_reports   mirrors work_center_month_reports  (0014+0015)
--   oee.area_year_reports          mirrors area_month_reports         (0025)
--
-- So every rule those three carry is carried here unchanged and is NOT re-argued:
-- a LINE has two units and `total_out = good_out + reject + rework` is FALSE at
-- that grain (§16.4a); an AREA has one unit and it is a MASS, its durations are
-- LINE-milliseconds, and it has NO `teep` because TEEP divides by a calendar an
-- area does not own (`0024`). Read `0014` and `0024` before changing anything
-- below.
--
-- ---------------------------------------------------------------------------
-- THREE DEPARTURES FROM THE MONTH TABLES, AND EACH WILL LOOK LIKE AN OVERSIGHT
-- ---------------------------------------------------------------------------
--
-- 1. `business_date` IS JANUARY 1 OF THE YEAR, enforced per table by
--    `ck_*_year_start`. §15.3's rule one grain up: NOT December 31, and not
--    midnight of January 1. It matters for `ck_amr_month_start`'s reason — the
--    LIST orders and filters on this column directly, so a row dated mid-year
--    would sort between two other years' rows and answer a `year` filter from a
--    position no reader could predict.
--
-- 2. NO `date timestamptz` ON THE MACHINE TABLE, unlike its month sibling.
--    `oee.work_unit_month_reports` carries one because `0003` captured it from a
--    populated upstream schema; `0014` dropped the column deliberately for the
--    line grain and `0024`/`0025` never had one. A NEW table has no upstream
--    history to preserve, so it follows the newest convention. A business year is
--    plant-local and must never be reconstructed through a zone (§22.2).
--
-- 3. NO DISPLAY-LABEL COLUMN. The three month tables carry a nullable `month
--    varchar(50)` out of the key, and nothing reads it — it exists because the
--    format was never specified upstream (§15.7) and removing it would be a
--    coordinated deploy. A `year` label here would be a redundant, derivable
--    column on a table with no such legacy, which is §23.1's "do not over-table"
--    applied at column scale. `business_date` IS the year.
--
-- ---------------------------------------------------------------------------
-- Plain `CREATE TABLE`, not `IF NOT EXISTS`: these tables exist nowhere, so a
-- silent no-op against a drifted schema is the failure to avoid. `0016`'s rule.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The MACHINE's year
-- ---------------------------------------------------------------------------

CREATE TABLE oee.work_unit_year_reports (
  id                      integer       GENERATED ALWAYS AS IDENTITY,

  -- ---- the grain ---------------------------------------------------------
  work_unit_id            integer       NOT NULL,
  -- JANUARY 1, enforced by ck_wuyr_year_start below.
  business_date           date          NOT NULL,
  -- The IANA zone business_date was cut in. NOT NULL here where `0013` had to
  -- make it nullable on the month table — that one holds rows and a NOT NULL
  -- would have needed a fabricated default. This one is empty, so the contract
  -- can be tight from the start.
  time_zone               text          NOT NULL,

  -- ---- dimensions, denormalised -----------------------------------------
  work_unit_name          varchar(255),
  work_unit_code          varchar(255),
  work_center_id          integer,
  work_center_name        varchar(255),
  work_center_code        varchar(255),

  -- ONE UNIT. A machine has a single count point, which is the whole contrast
  -- with the line table below.
  uom_id                  integer,
  uom_name                varchar(255),
  uom_code                varchar(255),

  -- ---- rates -------------------------------------------------------------
  -- RECOMPUTED FROM THE YEAR'S SUMS, never averaged over the months. See the
  -- header; this is the one thing a reader cannot do for itself and therefore the
  -- entire reason this table exists.
  --
  -- `teep` IS PRESENT HERE, unlike on the area table: a machine owns a calendar.
  teep                    numeric(10,3),
  oee                     numeric(10,3),
  availability            numeric(10,3),
  performance             numeric(10,3),
  quality                 numeric(10,3),

  -- ---- counts, all in `uom_*` -------------------------------------------
  total_out               numeric(15,3),
  good_out                numeric(15,3),
  effective_out           numeric(15,3),
  reject                  numeric(15,3),
  rework                  numeric(15,3),

  -- ---- durations, milliseconds, NOT NULL --------------------------------
  -- A MACHINE'S OWN WALL CLOCK summed over a year: `availability_time` is ~8,760
  -- hours. Not line-milliseconds — that inversion belongs to the area table.
  --
  -- AND A YEAR'S LENGTH IS NOT A CONSTANT: 8,759 or 8,761 real hours across a DST
  -- transition, and 8,784 in a leap year. Nothing in this application computes
  -- one — the pipeline sums what elapsed, and `resolveReportWindow` does the
  -- boundary arithmetic in Postgres with AT TIME ZONE so each boundary resolves
  -- its own offset.
  runtime                 bigint        NOT NULL,
  availability_time       bigint        NOT NULL,
  production_time         bigint        NOT NULL,
  pdt_time                bigint        NOT NULL,
  operating_time          bigint        NOT NULL,
  updt_time               bigint        NOT NULL,
  net_time                bigint        NOT NULL,
  reduce_speed_time       bigint        NOT NULL,
  ms_time                 bigint        NOT NULL,
  value_added_time        bigint        NOT NULL,
  rework_time             bigint        NOT NULL,
  reject_time             bigint        NOT NULL,
  anomaly_time            bigint        NOT NULL,
  up_speed_time           bigint        NOT NULL,

  schedule_loss_time      bigint        NOT NULL,
  -- SPELLED CORRECTLY. `0003` captured `availablity_loss_time` from upstream and
  -- `0013` corrected the day and month tables while they were still empty. There
  -- is no wart to preserve on a new table.
  availability_loss_time  bigint        NOT NULL,
  performance_loss_time   bigint        NOT NULL,
  ms_loss_time            bigint        NOT NULL,
  reduce_speed_loss_time  bigint        NOT NULL,
  quality_loss_time       bigint        NOT NULL,

  -- RATIOS, so they are recomputed over the year's summed repair time and failure
  -- count rather than averaged over the months'. Nullable with no default,
  -- §15.4's rule: a DEFAULT 0 would make every unwritten row claim a perfect
  -- repair time, and 0 is a measurement where NULL is "nobody has computed this".
  mttr                    bigint,
  mtbf                    bigint,

  CONSTRAINT work_unit_year_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ck_wuyr_year_start CHECK (business_date = date_trunc('year', business_date)::date)
);

-- THE UPSERT TARGET. Contract §27 asks the pipeline to use it, which is what keeps
-- `id` stable across runs — `0023`'s header says why that is not optional: the
-- browser holds a report id in a URL, and a rebuilt table that reassigns ids turns
-- every bookmark into another subject's report.
CREATE UNIQUE INDEX wu_year_report_key
  ON oee.work_unit_year_reports USING btree (work_unit_id, business_date);

-- The list: every machine for one year.
CREATE INDEX wu_year_report_date_wu_idx
  ON oee.work_unit_year_reports USING btree (business_date DESC, work_unit_id);

-- "This machine over time" — the shape every other per-subject table has, so a
-- reader moving between them meets one access pattern rather than several.
CREATE INDEX wu_year_report_wu_date_idx
  ON oee.work_unit_year_reports USING btree (work_unit_id, business_date DESC);

COMMENT ON TABLE oee.work_unit_year_reports IS
  'One machine, one year. Its RATES are recomputed from the year''s sums and are NOT the average of its months'' rates, which is why this exists as a table rather than being derived by widening oee.work_unit_month_reports (contract §15.5, §27). Durations are the machine''s own wall clock: availability_time over a year is ~8,760 hours.';
COMMENT ON COLUMN oee.work_unit_year_reports.business_date IS
  'The FIRST business day of the year — January 1 — enforced by ck_wuyr_year_start. Contract §15.3''s rule one grain up: not December 31, and not midnight of January 1. Plant-local and never to be reconstructed through a time zone.';
COMMENT ON COLUMN oee.work_unit_year_reports.availability_time IS
  'CALENDAR TIME, and the name is historical rather than descriptive. It is TEEP''s denominator and satisfies availability_time = schedule_loss_time + availability_loss_time + performance_loss_time + quality_loss_time + value_added_time. production_time is LOADING TIME, OEE''s denominator. Contract §23.3 — the OEE Performance dashboard depends on both readings.';
COMMENT ON COLUMN oee.work_unit_year_reports.mttr IS
  'A RATIO, recomputed over the year''s summed repair time and failure count — never the average of the months'' mttr. NULL means nobody has computed it; 0 would be a measurement. Contract §15.4.';

-- ---------------------------------------------------------------------------
-- The LINE's year
-- ---------------------------------------------------------------------------
--
-- `0014`'s month table, verbatim, plus `0015`'s `line_out` and minus the `month`
-- label. EVERY RULE `0014` STATES HOLDS HERE and none of it is re-argued:
--
--   * A LINE IS MEASURED, NOT SUMMED. It has its own count points, so
--     `line <> sum(machines)` is not a defect.
--   * ITS DURATIONS ARE ITS OWN WALL CLOCK. A year is ~8,760 hours over a
--     4-machine line, not ~35,000. (An area's are line-milliseconds; that
--     inversion is `0024`'s and belongs to the third table only.)
--   * TWO UNITS, AND THEY ARE USUALLY DIFFERENT — bags in, cartons out. So
--     `total_out = good_out + reject + rework` IS FALSE at this grain, by
--     construction, and nothing may compute across the two sides.

CREATE TABLE oee.work_center_year_reports (
  id                       integer       GENERATED ALWAYS AS IDENTITY,

  work_center_id           integer       NOT NULL,
  -- JANUARY 1, enforced by ck_wcyr_year_start below.
  business_date            date          NOT NULL,
  time_zone                text          NOT NULL,

  work_center_name         varchar(255)  NOT NULL,
  work_center_code         varchar(255),
  area_id                  integer,
  area_name                varchar(255),

  -- Machines that REPORTED into this row, and the line's roster.
  work_unit_count          integer       NOT NULL,
  expected_work_unit_count integer,

  -- TWO UNIT TRIPLES, AND EITHER MAY BE NULL INDEPENDENTLY. A NULL side means
  -- "the members disagreed" — `0024`'s null means something else again — and its
  -- counts are nulled WITH it by the two CHECKs below, so a line can be certain
  -- what it consumed and abstain about what it shipped.
  infeed_uom_id            integer,
  infeed_uom_name          varchar(255),
  infeed_uom_code          varchar(255),
  output_uom_id            integer,
  output_uom_name          varchar(255),
  output_uom_code          varchar(255),

  -- RECOMPUTED FROM THE YEAR'S SUMS. `teep` is present: a LINE OWNS A CALENDAR.
  teep                     numeric(10,3),
  oee                      numeric(10,3),
  availability             numeric(10,3),
  performance              numeric(10,3),
  quality                  numeric(10,3),

  -- Infeed side.
  total_out                numeric(15,3),
  reject                   numeric(15,3),
  rework                   numeric(15,3),
  -- The line's OWN measured production at its infeed count point (`0015`).
  -- `total_out = line_out + reject + rework` is NOT asserted either.
  line_out                 numeric(15,3),
  -- Output side.
  good_out                 numeric(15,3),
  effective_out            numeric(15,3),

  runtime                  bigint        NOT NULL,
  availability_time        bigint        NOT NULL,
  production_time          bigint        NOT NULL,
  pdt_time                 bigint        NOT NULL,
  operating_time           bigint        NOT NULL,
  updt_time                bigint        NOT NULL,
  net_time                 bigint        NOT NULL,
  reduce_speed_time        bigint        NOT NULL,
  ms_time                  bigint        NOT NULL,
  value_added_time         bigint        NOT NULL,
  rework_time              bigint        NOT NULL,
  reject_time              bigint        NOT NULL,
  anomaly_time             bigint        NOT NULL,
  up_speed_time            bigint        NOT NULL,

  schedule_loss_time       bigint        NOT NULL,
  availability_loss_time   bigint        NOT NULL,
  performance_loss_time    bigint        NOT NULL,
  ms_loss_time             bigint        NOT NULL,
  reduce_speed_loss_time   bigint        NOT NULL,
  quality_loss_time        bigint        NOT NULL,

  mttr                     bigint,
  mtbf                     bigint,

  CONSTRAINT work_center_year_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ck_wcyr_year_start CHECK (business_date = date_trunc('year', business_date)::date),

  -- ONE CHECK PER SIDE — `0014`'s pair with `0015`'s `line_out` joined to the
  -- infeed one. A count without its unit is a number nobody can read.
  CONSTRAINT ck_wcyr_infeed_units CHECK (
    infeed_uom_id IS NOT NULL
    OR (total_out IS NULL AND reject IS NULL AND rework IS NULL AND line_out IS NULL)
  ),
  CONSTRAINT ck_wcyr_output_units CHECK (
    output_uom_id IS NOT NULL
    OR (good_out IS NULL AND effective_out IS NULL)
  ),
  CONSTRAINT ck_wcyr_work_unit_count CHECK (work_unit_count > 0)
);

CREATE UNIQUE INDEX wc_year_report_key
  ON oee.work_center_year_reports USING btree (work_center_id, business_date);

CREATE INDEX wc_year_report_date_wc_idx
  ON oee.work_center_year_reports USING btree (business_date DESC, work_center_id);

CREATE INDEX wc_year_report_wc_date_idx
  ON oee.work_center_year_reports USING btree (work_center_id, business_date DESC);

COMMENT ON TABLE oee.work_center_year_reports IS
  'One line, one year. MEASURED at the line''s own count points, never summed from its machines — line <> sum(machines) is not a defect (0014). Its RATES are recomputed from the year''s sums and are NOT the average of its months'' (contract §15.5, §27). Durations are the line''s OWN wall clock: ~8,760 hours over a year regardless of machine count.';
COMMENT ON COLUMN oee.work_center_year_reports.business_date IS
  'The FIRST business day of the year — January 1 — enforced by ck_wcyr_year_start. Contract §15.3.';
COMMENT ON COLUMN oee.work_center_year_reports.total_out IS
  'What the line CONSUMED over the year, in infeed_uom_*. total_out = good_out + reject + rework is FALSE at this grain by construction: good_out and effective_out are in the OUTPUT unit (cartons) while these are in the INFEED one (bags). Nothing may compute across the two sides. Contract §16.4a.';
COMMENT ON COLUMN oee.work_center_year_reports.line_out IS
  'The line''s OWN measured production at its infeed count point, summed over the year (0015). Distinct from total_out, which is what it consumed.';

-- ---------------------------------------------------------------------------
-- The AREA's year
-- ---------------------------------------------------------------------------
--
-- `0025`'s table with a year CHECK in place of the month one. `0024` IS THE FILE
-- TO READ FIRST; its two inversions hold here and get LOUDER rather than
-- different:
--
--   * THE DURATIONS ARE LINE-MILLISECONDS, now times a YEAR. A five-line area's
--     `availability_time` reads ~43,800 hours. Do NOT divide by the line count or
--     by the day count to make it look like a wall clock.
--   * THE COUNTS ARE A MASS, in ONE unit, precisely because the members have
--     many. A NULL unit is a THIRD meaning again: not `0014`'s "the members
--     disagreed" and not `0023`'s "not known", but "could not be brought to a
--     common mass".
--
-- AND NO `teep`, for `0024`'s reason: TEEP divides by CALENDAR time and an area
-- owns no calendar a reader could name. The dashboard's KPI row is a per-subject
-- tile LIST because of this column's absence, and an area's row is FOUR tiles
-- rather than six with two blanks.

CREATE TABLE oee.area_year_reports (
  id                          integer       GENERATED ALWAYS AS IDENTITY,

  area_id                     integer       NOT NULL,
  -- JANUARY 1, enforced by ck_ayr_year_start below.
  business_date               date          NOT NULL,
  time_zone                   text          NOT NULL,

  area_name                   varchar(255)  NOT NULL,
  area_code                   varchar(255),
  factory_id                  integer,
  factory_name                varchar(255),

  -- THE ONE UNIT, AND IT IS A MASS.
  weight_uom_id               integer,
  weight_uom_name             varchar(255),
  weight_uom_code             varchar(255),

  -- No `teep`. See the header.
  oee                         numeric(10,3),
  availability                numeric(10,3),
  performance                 numeric(10,3),
  quality                     numeric(10,3),

  -- All five in `weight_uom_*`. `total_out = good_out + reject + rework` is at
  -- least unit-consistent here and is STILL not asserted: five count points on N
  -- lines, and mass is not conserved through a packing line.
  total_out                   numeric(15,3),
  area_out                    numeric(15,3),
  reject                      numeric(15,3),
  rework                      numeric(15,3),
  good_out                    numeric(15,3),

  runtime                     bigint        NOT NULL,
  availability_time           bigint        NOT NULL,
  production_time             bigint        NOT NULL,
  pdt_time                    bigint        NOT NULL,
  operating_time              bigint        NOT NULL,
  updt_time                   bigint        NOT NULL,
  net_time                    bigint        NOT NULL,
  reduce_speed_time           bigint        NOT NULL,
  ms_time                     bigint        NOT NULL,
  value_added_time            bigint        NOT NULL,
  rework_time                 bigint        NOT NULL,
  reject_time                 bigint        NOT NULL,
  anomaly_time                bigint        NOT NULL,
  up_speed_time               bigint        NOT NULL,

  schedule_loss_time          bigint        NOT NULL,
  availability_loss_time      bigint        NOT NULL,
  performance_loss_time       bigint        NOT NULL,
  ms_loss_time                bigint        NOT NULL,
  reduce_speed_loss_time      bigint        NOT NULL,
  quality_loss_time           bigint        NOT NULL,

  mttr                        bigint,
  mtbf                        bigint,

  CONSTRAINT area_year_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ck_ayr_year_start CHECK (business_date = date_trunc('year', business_date)::date),

  -- ONE unit guard over ONE count set — `0024`'s and `0025`'s, unchanged.
  CONSTRAINT ck_ayr_weight_units CHECK (
    weight_uom_id IS NOT NULL
    OR (total_out IS NULL AND area_out IS NULL AND reject IS NULL
        AND rework IS NULL AND good_out IS NULL)
  )
);

CREATE UNIQUE INDEX area_year_reports_key
  ON oee.area_year_reports USING btree (area_id, business_date);

CREATE INDEX ayr_ix_date_area
  ON oee.area_year_reports USING btree (business_date DESC, area_id);

CREATE INDEX ayr_ix_area_date
  ON oee.area_year_reports USING btree (area_id, business_date DESC);

COMMENT ON TABLE oee.area_year_reports IS
  'One area, one year. COMPOSED from the area''s member lines over the whole year, never measured: an area has no count point and no clock of its own. Its RATES are recomputed from the year''s sums and are NOT the average of its months'' (contract §15.5, §27). Every duration is in LINE-milliseconds — a five-line area reads ~43,800 hours — and every count is a MASS. See oee.area_day_reports (0024).';
COMMENT ON COLUMN oee.area_year_reports.business_date IS
  'The FIRST business day of the year — January 1 — enforced by ck_ayr_year_start. Contract §15.3.';
COMMENT ON COLUMN oee.area_year_reports.availability_time IS
  'LINE-MILLISECONDS summed across the area''s lines AND the year''s days — a five-line area reads ~43,800 hours, not ~8,760. This is the intended figure. Do not divide by the line count to make it look like a wall clock (0024).';
COMMENT ON COLUMN oee.area_year_reports.weight_uom_id IS
  'The mass unit every count on this row is denominated in. NULL means the pipeline could not bring the members to a common mass over this year — typically a product with no std_weight in ms_product.product_packaging — and the counts are NULL with it (ck_ayr_weight_units).';

-- ---------------------------------------------------------------------------
-- The watermark list
-- ---------------------------------------------------------------------------
--
-- Without these rows a screen cannot tell "this subject had no production that
-- year" from "the DAG has not run" — §8 and §14's distinction, and the state all
-- three tables SHIP in. Contract §27 asks for `last_business_date` to be the
-- latest YEAR START, which is what these tables' `business_date` holds.
ALTER TABLE oee.etl_watermarks DROP CONSTRAINT IF EXISTS ck_etl_watermarks_table;
ALTER TABLE oee.etl_watermarks ADD CONSTRAINT ck_etl_watermarks_table CHECK (table_name IN (
  'work_unit_shift_reports',
  'work_unit_day_reports',
  'work_unit_month_reports',
  'work_unit_year_reports',
  'downtime_reports',
  'product_count_wu_shift',
  'product_count_wu_day',
  'product_perf_wu_hour',
  'reject_count_wu_shift',
  'downtime_log_events',
  'work_center_shift_reports',
  'work_center_day_reports',
  'work_center_month_reports',
  'work_center_year_reports',
  'product_count_wc_shift',
  'product_count_wc_day',
  'product_perf_wc_hour',
  'reject_count_wc_shift',
  'product_report_wc_day',
  'area_day_reports',
  'area_month_reports',
  'area_year_reports'
));

-- ---------------------------------------------------------------------------
-- NO OPERATOR MUTATION TARGETS THESE TABLES, and these triggers assert it from
-- the database's side — `0023`'s, `0024`'s and `0025`'s arrangement.
--
-- The seven operator writes are keyed at grains that do not exist here: an
-- approval is keyed (work_unit_id, date, shift), a line approval cascades over
-- one shift's machines, and a quality entry is keyed by LINE and business DAY.
-- There is no key at year grain and no cascade anyone has defined — approving a
-- year would close every shift report inside it, which is not a permission any of
-- the six role variables grants. If an operator write ever shows up in
-- oee.write_audit against one of these tables, something has gone wrong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_unit_year_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_unit_year_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.work_center_year_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.work_center_year_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.area_year_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.area_year_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
