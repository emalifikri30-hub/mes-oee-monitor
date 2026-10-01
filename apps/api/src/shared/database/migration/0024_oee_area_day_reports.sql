-- ---------------------------------------------------------------------------
-- 0024 — the AREA grain: one report per (area, business day)
-- ---------------------------------------------------------------------------
--
-- One table, `oee.area_day_reports`. It backs the `Report > Area > By Day`
-- screens and it is contract §25's ask. It ships EMPTY.
--
-- TODOS.md §74 said "do not start by writing tables" and asked the prior
-- question first: which of the remaining subjects is a MEASUREMENT with its own
-- count points, and which is a legitimate roll-up. That question is answered
-- here, and the answer is not the one the last four migrations gave.
--
-- ---------------------------------------------------------------------------
-- A LINE IS *MEASURED*. AN AREA IS *COMPOSED*. THAT IS THE WHOLE DESIGN.
-- ---------------------------------------------------------------------------
--
-- `0014` exists because a line has its own count points: an infeed counter and
-- an output counter, physically on the line, so `line <> sum(machines)` is not a
-- defect and a roll-up would have contradicted the line's own instruments.
-- `0016`, `0018`, `0019` and `0023` each repeat that argument one axis over.
--
-- AN AREA HAS NO INSTRUMENT. There is no counter at the edge of an area and no
-- clock that an area runs on; an area is a set of lines that happen to be
-- managed together. So every figure on this row is a COMPOSITION of its member
-- lines' figures, and three consequences follow that no other report table in
-- this schema has to deal with:
--
--   1. THE DURATIONS ARE LINE-HOURS, NOT WALL-CLOCK HOURS. `0014`'s header is
--      explicit that a line's durations are "the line's own wall clock — 8 hours
--      over a 4-machine shift, not 32", and an earlier reading calling them
--      "machine-milliseconds" was CORRECTED by 4fccce8. At this grain that
--      reading is the right one: `availability_time` for a five-line area on one
--      business day is ~120 hours, not ~24. It has to be, or the loss durations
--      could not add — an area that lost 3 h on line A and 2 h on line B has lost
--      5 h of production capacity, and there is no "wall clock" reading under
--      which that is anything else.
--
--      So `runtime` on this table WILL exceed 24 hours on a normal day, and the
--      Run Time tile is expected to read "97 h 12 m". That is not a bug and must
--      not be "fixed" by dividing by the line count. See the COMMENT on the
--      column, which says so in the database, because an external analyst has no
--      source file to read (contract §23.3).
--
--   2. THE COUNTS ARE IN *WEIGHT*, AND THAT IS WHY THERE IS ONLY ONE UNIT.
--      `0014` gives a line TWO unit triples because bags go in and cartons come
--      out. An area's members disagree about BOTH sides — one line ships cartons,
--      another sacks — so the `0014` shape applied here would leave both triples
--      NULL on almost every row and null every count with them. The Total
--      Production tile would be a permanent em dash.
--
--      Weight is the answer, and it is the requirement's answer: every product
--      package in mes-master-data carries `std_weight` / `min_weight` /
--      `max_weight`, so a count in ANY packaging unit converts to a mass. Mass is
--      the only unit that survives composition across an area, which is exactly
--      why an area has one unit where a line has two. The `0014` rule is not
--      being relaxed; it is being satisfied by picking a unit the members can all
--      be expressed in.
--
--      The per-unit view the requirement ALSO asks for — "sum of total production
--      in all infeed units and all output units" — is deliberately NOT a column
--      here. Summing counts WITHIN one unit across lines is exact arithmetic with
--      no denominator to invent, so it is a read-time aggregate over
--      `oee.work_center_day_reports` grouped by unit (contract §25.6). §23.1's
--      "do not over-table" applies squarely: that view needs no table.
--
--   3. `total_out = good_out + reject + rework` IS STILL NOT ASSERTED. At line
--      grain it is FALSE because the two sides are in different units
--      (§16.4a). Here the units agree, so the sum is at least well-formed — and
--      it is still not an identity, because the five figures come from different
--      count points on N different lines and mass is neither conserved through a
--      packing line nor measured at a single point. No CHECK asserts it, for the
--      reason `0015` gives: a CHECK that failed a load over an arithmetic
--      disagreement between count points would take a whole area's reporting down
--      to protect a tile.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AT ALL, GIVEN §23.1
-- ---------------------------------------------------------------------------
--
-- Because the RATES cannot be composed by a reader, and `0023`'s argument
-- transfers word for word: availability needs a PLANNED PRODUCTION TIME
-- denominator, and nothing in Gold exposes how the pipeline computes a line's. An
-- area OEE derived here would be a second definition of OEE living in the API,
-- disagreeing by an unknown amount with the line reports it drills down into —
-- two defensible numbers one click apart, which is the failure `0014`, `0016`,
-- `0018`, `0019` and `0023` each exist to prevent.
--
-- And because §23.2 lists area as one of five intended report SUBJECTS. §23.1
-- asks for fewer report tables, not none. The restraint it asks for is visible in
-- what this migration does NOT add: no shift sibling (the requirement is day and
-- month only — "Only have 2 type of report on the Area"), no month sibling in
-- THIS file (it is a separate deliverable and a separate table, because a month's
-- rates cannot be got by widening a day's), and no fifth member of `SCOPE_COLUMN`
-- for downtime — `oee.downtime_reports.area_id` has existed since `0007` and the
-- downtime read path is being taught to use it, which is a two-line change rather
-- than a table.
--
-- ---------------------------------------------------------------------------
-- THE KEY: AN IDENTITY `id` *AND* A NATURAL UNIQUE KEY. BOTH.
-- ---------------------------------------------------------------------------
--
-- `0023`'s pairing, for `0023`'s two reasons, unchanged:
--
--   * `id` is what a URL and a cache key name. Every report table is addressed
--     this way and the browser's routing, query keys and ReportAddress all assume
--     it. A composite-key URL here would be an eighth addressing shape.
--   * The NATURAL KEY is what makes `id` safe to name. These tables are loaded
--     DELETE-then-INSERT today, which churns a serial on every run; a unique key
--     from the first migration is what lets contract §25 ask for an UPSERT so
--     `id` stays put.
--
-- Plain `CREATE TABLE`, not `IF NOT EXISTS`: this table exists nowhere, so a
-- silent no-op against a drifted schema is the failure to avoid. `0016`'s rule.
-- ---------------------------------------------------------------------------

CREATE TABLE oee.area_day_reports (
  id                          integer       GENERATED ALWAYS AS IDENTITY,

  -- ---- the grain ---------------------------------------------------------
  area_id                     integer       NOT NULL,
  business_date               date          NOT NULL,
  -- The IANA zone `business_date` was cut in. NOT NULL, as on `0023`: this table
  -- is empty, so the pairing `0021`'s header argues for is enforceable from the
  -- start. A business day must never be reconstructed with `::date` — see §22.2.
  time_zone                   text          NOT NULL,

  -- ---- dimensions, denormalised -----------------------------------------
  area_name                   varchar(255)  NOT NULL,
  -- NULLABLE and rendered BESIDE the name, never instead of it. This mirrors
  -- work_center_code on `0014`: a denormalised name is not unique (the dev world
  -- carried two lines called 'Line 1' for months, TODOS.md §77) and a report whose
  -- subject IS the area cannot identify one by a label that can repeat.
  area_code                   varchar(255),
  -- THE LEVEL ABOVE, denormalised exactly as `0014` denormalises the level above
  -- a line. Nullable for the same reason area_id is nullable there: the pipeline
  -- may not have resolved the hierarchy. Nothing in this application reads it yet
  -- — it is here so the factory report (§23.2, TODOS.md §74) is a read rather
  -- than a hierarchy lookup, and so an external analyst can group areas without
  -- joining out to master data.
  factory_id                  integer,
  factory_name                varchar(255),
  -- Nullable label OUT of the key, exactly as `0014` and `0023` keep it. A month
  -- is derivable from business_date; this is for display only and nothing joins
  -- on it or renders it.
  month                       varchar(50),

  -- ---- THE ONE UNIT, AND IT IS A MASS -----------------------------------
  -- `0014`'s nullability rule with `0014`'s CHECK, over ONE triple rather than
  -- two — see consequence 2 in the header for why an area has one unit where a
  -- line has two. A count with no unit is a wrong number wearing a missing label,
  -- so the whole count set is NULL together or the unit is present.
  --
  -- NULL MEANS "THE MEMBERS COULD NOT BE BROUGHT TO A COMMON MASS", which is a
  -- third meaning for this column family and worth stating: on a LINE row NULL
  -- means the members disagreed about a unit; on a `0023` SKU row it means simply
  -- not known. Here the members cannot disagree — mass commutes — so NULL means a
  -- product that ran in the window has no `std_weight` in master data and the
  -- pipeline refused to guess. That is a data-quality signal pointing at
  -- ms_product.product_packaging, not at this schema.
  weight_uom_id               integer,
  weight_uom_name             varchar(255),
  weight_uom_code             varchar(255),

  -- ---- rates, all nullable ----------------------------------------------
  -- 0/0 is real for an area whose every line sat in planned downtime. NULL is not
  -- 0 and must never be coalesced to it; the browser renders an em dash.
  --
  -- COMPOSED BY THE PIPELINE, NEVER BY A READER. See the header: an availability
  -- derived in the API would be a second definition of OEE one click away from the
  -- line reports this screen drills into.
  --
  -- NO `teep`. TEEP divides by CALENDAR time, and an area does not own a calendar
  -- any reader could name — is it 24 hours, or 24 hours times the line count? The
  -- second is what consequence 1 makes of every other duration here, and a TEEP
  -- over that denominator is a ratio of two composed quantities that nobody has
  -- asked for. `oee` stays: it divides by the area's own composed loading time.
  oee                         numeric(10,3),
  availability                numeric(10,3),
  performance                 numeric(10,3),
  quality                     numeric(10,3),

  -- ---- counts, ALL IN `weight_uom_*` ------------------------------------
  -- The three the overview card names, plus the two the Losses card names. There
  -- is no infeed/output SPLIT of units here, but there is still a split of
  -- PROVENANCE, and it is the same one:
  --
  --   consumed side   total_out, area_out, reject, rework
  --   shipped side    good_out
  --
  -- Both sides are masses, so they are comparable — and still not an identity.
  -- See consequence 3.
  --
  -- NO `effective_out`. The requirement's Area Overview names OEE, A, P, Q,
  -- Achievement, {Area} Production, Total Production, Finish Good and Runtime, and
  -- stops. Effective Production is the one tile the line card has that the area
  -- card does not, so the column is absent rather than shipped NULL forever —
  -- §23.1, match the requirement and stop. It is an ALTER TABLE if it is ever
  -- asked for.
  total_out                   numeric(15,3),
  -- "{Area Name} Production" — the tile the overview card labels with the area's
  -- own name, exactly as the line card labels `line_out` with the line's.
  --
  -- WHAT IT IS: the member lines' OWN measured production (`line_out`, `0015`)
  -- brought to a common mass and summed. What `total_out` is: what those lines
  -- CONSUMED, likewise summed. The two answer different questions and the second
  -- is not derivable from the first.
  area_out                    numeric(15,3),
  reject                      numeric(15,3),
  rework                      numeric(15,3),
  good_out                    numeric(15,3),

  -- ---- durations, milliseconds, NOT NULL --------------------------------
  -- `0014`'s set verbatim. A duration has no "unknown" state the way a rate does:
  -- time either elapsed against this area's lines or it did not.
  --
  -- LINE-MILLISECONDS. Read consequence 1 in the header before touching any of
  -- these — a five-line area's `availability_time` on one day is ~120 h.
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

  -- The six the Losses card and the waterfall read. Spelled correctly here, as on
  -- `0014` and `0023`; the `availablity_loss_time` (sic) wart `0013` had to
  -- correct never reached these tables.
  schedule_loss_time          bigint        NOT NULL,
  availability_loss_time      bigint        NOT NULL,
  performance_loss_time       bigint        NOT NULL,
  ms_loss_time                bigint        NOT NULL,
  reduce_speed_loss_time      bigint        NOT NULL,
  quality_loss_time           bigint        NOT NULL,

  -- NULLABLE WITH NO DEFAULT, `0013` §15.4's rule: a DEFAULT 0 would make every
  -- unwritten row claim a perfect repair time. An area's MTTR/MTBF are composed
  -- over every stop on every line in it, which is a coarser but still meaningful
  -- reliability figure — the Downtime Details card renders them beside a frequency
  -- taken over the same set of stops.
  mttr                        bigint,
  mtbf                        bigint,

  CONSTRAINT area_day_reports_pkey PRIMARY KEY (id),

  CONSTRAINT ck_adr_month_format CHECK (month IS NULL OR month ~ '^[0-9]{4}-[0-9]{2}$'),

  -- ONE unit guard over ONE count set — `0014`'s two CHECKs collapsed into one
  -- because an area has one unit. `area_out` joins it the way `0015` joined
  -- `line_out` to the infeed side: it is denominated in exactly the unit the set
  -- is about.
  CONSTRAINT ck_adr_weight_units CHECK (
    weight_uom_id IS NOT NULL
    OR (total_out IS NULL AND area_out IS NULL AND reject IS NULL
        AND rework IS NULL AND good_out IS NULL)
  )
);

-- THE UPSERT TARGET. Contract §25 asks the pipeline to use it, which is what keeps
-- `id` stable across runs — see the header for why that is not optional.
CREATE UNIQUE INDEX area_day_reports_key
  ON oee.area_day_reports USING btree (area_id, business_date);

-- The list screen: ordered by date, filtered by month/year and by area.
--
-- `area_id` SECOND, not first, unlike ix_pcwcd_product_date and friends. The
-- Area By Day list is always scoped to ONE area — the header's area picker is a
-- REQUEST filter on this screen rather than only deciding which lines a page may
-- offer — but it orders and pages by date, and the unique index above already
-- serves an area-then-date lookup. This one serves the ORDER BY.
CREATE INDEX adr_ix_date_area
  ON oee.area_day_reports USING btree (business_date DESC, area_id);

COMMENT ON TABLE oee.area_day_reports IS
  'One area, on one business day. COMPOSED from the area''s member lines, never measured: an area has no count point and no clock of its own. Two consequences an external reader must know before using this table — every duration is in LINE-milliseconds (a five-line area''s availability_time on one day is ~120 hours, not ~24), and every count is a MASS in weight_uom_*, because that is the only unit the member lines can all be expressed in. Contract §25.';
COMMENT ON COLUMN oee.area_day_reports.availability IS
  'The area''s composed availability, written by the pipeline. NOT an average of its lines'' availabilities — a mean of ratios is not the ratio of the sums, and the sums are what the durations on this row hold.';
COMMENT ON COLUMN oee.area_day_reports.runtime IS
  'LINE-MILLISECONDS, summed across every line in the area. Expected to exceed 24 h on a normal day for any area with more than one line; do NOT divide by the line count to get a wall clock. Every other duration on this row is on the same footing.';
COMMENT ON COLUMN oee.area_day_reports.availability_time IS
  'LINE-MILLISECONDS. See runtime. This is the denominator the area''s loss durations are taken against, which is why it is a sum rather than the 24 h an area''s wall clock would show.';
COMMENT ON COLUMN oee.area_day_reports.total_out IS
  'What the area''s lines CONSUMED, as a MASS in weight_uom_*. total_out = good_out + reject + rework is NOT asserted here: the units agree (unlike the line grain, contract §16.4a) but the figures come from different count points on N lines, and mass is neither conserved through a packing line nor measured at a single point.';
COMMENT ON COLUMN oee.area_day_reports.area_out IS
  'The member lines'' OWN measured production (work_center_*.line_out) brought to a common mass and summed — the figure the detail screen labels "<area name> Production". Distinct from total_out, which is what those lines consumed.';
COMMENT ON COLUMN oee.area_day_reports.good_out IS
  'What the area SHIPPED, as a MASS in weight_uom_* — the figure the detail screen labels "Finish Good". A mass, so it is comparable with total_out; see that column for why the comparison is not an identity.';
COMMENT ON COLUMN oee.area_day_reports.weight_uom_id IS
  'The mass unit every count on this row is denominated in. NULL means the pipeline could not bring the members to a common mass — typically a product that ran in the window has no std_weight in ms_product.product_packaging — and the counts are NULL with it (ck_adr_weight_units). It does NOT mean "the members disagreed", which is what a NULL unit means on oee.work_center_day_reports.';

-- The watermark list. Without this row the screen cannot tell "this area had no
-- production" from "the DAG has not run", which is the distinction §8 and §14 both
-- exist for — and it is the state this table SHIPS in.
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
  'reject_count_wc_shift',
  'product_report_wc_day',
  'area_day_reports'
));

-- NO OPERATOR MUTATION TARGETS THIS TABLE, and these two triggers are what assert
-- it from the database's side — `0023`'s arrangement, for `0023`'s reason. An area
-- report has no approval (oee.work_unit_shift_report_approvals is keyed
-- (work_unit_id, date, shift), and this grain has neither) and no quality ledger of
-- its own (an entry is a row in oee.work_center_quality_entries, keyed by LINE). If
-- an operator write ever shows up in oee.write_audit against this table, something
-- has gone wrong.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.area_day_reports
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.area_day_reports
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
