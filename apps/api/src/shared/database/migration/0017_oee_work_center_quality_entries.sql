-- ===========================================================================
-- 0017 — oee.work_center_quality_entries: operator-entered reject and rework
-- ===========================================================================
--
-- WRITTEN BY mes-oee-monitor ONLY. Airflow/dbt READS it and must never insert,
-- update or delete — the same standing this schema already gives
-- oee.downtime_report_history (contract §13) and the two approval tables (§12).
-- It is deliberately ABSENT from ck_etl_watermarks_table, so a dbt model of this
-- name fails loudly on its post-hook. If a watermark insert is ever rejected for
-- this table, the model is pointed at a table it does not own; the fix is to
-- delete the model, not to amend the constraint.
--
-- WHAT IT IS FOR
--
-- An operator on the Line report screen types in rejects and rework the line's
-- count points did not see — hand-sorted product, a QC hold, a batch pulled off
-- the end. Those quantities must reach work_center_*_reports.reject/.rework, and
-- they get there through the OVERRIDE JOIN in contract §18, applied BY THE
-- PIPELINE. This service never writes the report tables: 0014's claim that "no
-- operator mutation targets these three tables" is UNCHANGED by this file, and
-- the row-level write_audit triggers over there remain the tripwire that says so.
--
-- ---------------------------------------------------------------------------
-- WHAT AN ENTRY DOES NOT DO, AND THE SCREEN MUST SAY SO
-- ---------------------------------------------------------------------------
--
-- It moves `reject` and `rework`. It moves NOTHING ELSE — not quality, not oee,
-- not teep, not quality_loss_time, not reject_time.
--
-- Contract §16.10a(b) settled that the rates at line grain are TIME-DERIVED:
-- quality = value_added_time / net_time, both durations. Count-derived quality
-- (good_out / total_out) was explicitly REFUSED, because at this grain those two
-- counts are in different units — a line taking 100 bags and shipping 10 cartons
-- would have reported "10% quality" with nothing rejected. That section ends:
-- "The count columns are reported figures; no rate reads them."
--
-- So 500 rejects typed in will not change the Quality percentage by one decimal.
-- That is correct, and it is the first thing that will be reported as a bug.
-- Making it move OEE is not a bigger version of this feature; it is a request to
-- make quality count-derived, which §16.10a refused on unit grounds.
--
-- ---------------------------------------------------------------------------
-- ONE TABLE, TWO KINDS
-- ---------------------------------------------------------------------------
--
-- Reject and rework share grain, unit rules, void lifecycle and consumer. A
-- `kind` discriminator makes the override CTE ONE scan with two FILTERed sums
-- instead of two of everything, three times over — twelve joins instead of six,
-- each an independent chance to get the unit predicate wrong.
--
-- text + CHECK rather than an enum, following work_unit_shift_report_approvals
-- .status and for the reason 0010 gives at length: a future 'scrap' is then a
-- DROP/ADD of one CHECK, the idiom 0015 established, rather than an ALTER TYPE.
--
-- ---------------------------------------------------------------------------
-- THE UNIT TRAP, AND WHERE IT IS ACTUALLY CAUGHT
-- ---------------------------------------------------------------------------
--
-- work_center_*_reports.reject is denominated in that report's INFEED unit
-- (0014, contract §16.4). Master data converts per PRODUCT, through packages[]
-- and factorToBase, into that PRODUCT's base unit. THESE ARE TWO DIFFERENT UNIT
-- SYSTEMS AND THEY NEED NOT AGREE. Adding a PCS-denominated figure to a
-- BAG-denominated column produces a plausible, silently wrong number.
--
-- Three defences, and only the third is a guarantee:
--
--   1. THE API REFUSES what it can see is wrong at write time. Best effort only:
--      at month grain the shift report row often does not exist yet, and
--      infeed_uom_id is nullable by design (0014: NULL means "the members
--      disagreed"). Advisory, not durable — which is what `unit_check` records.
--
--   2. THIS TABLE CONSTRAINS ITS OWN ARITHMETIC, AND ONLY ITS OWN. A CHECK
--      admits no subquery and cannot see another table, so the cross-table
--      condition CANNOT be expressed here. Do not add a lookup trigger
--      pretending otherwise: it would validate against a column the pipeline
--      REWRITES on its next run, buying a guarantee with a shelf life of one DAG
--      cycle and then lying about it forever. What IS enforced below is that the
--      entered and target units share a conversion basis, and that the identity
--      case is exact.
--
--   3. THE OVERRIDE JOIN GATES ON `e.target_uom_id = r.infeed_uom_id`, a plain
--      equality, at the only moment the report's unit is authoritative. This is
--      the guarantee, and it is SELF-PROTECTING: a mixed-unit shift has
--      infeed_uom_id NULL, target_uom_id is NOT NULL, and NULL equals nothing —
--      so the entry matches nothing and contributes nothing.
--
--      That last property is load-bearing rather than lucky. ck_wcsr_infeed_units
--      nulls reject and rework ALONG WITH the unit, so writing a non-NULL reject
--      onto a NULL-unit row ABORTS THE LOAD (§16.4: "These can fail your load").
--      NEVER write that predicate as IS NOT DISTINCT FROM, and never coalesce
--      either side — both would match the NULL and take the pipeline down for
--      one operator's entry against one mixed-unit shift.
--
-- An entry the join excludes is NOT discarded quietly: contract §18 ships a
-- stranded-entries test at WARN severity, and a reconciliation query beside it.
-- warn, NOT error — one operator's typo must not block the whole Gold load. That
-- is the mistake §16.8 made once and had to retract.
--
-- ---------------------------------------------------------------------------
-- CONVERSION GOES THROUGH THE PRODUCT'S BASE, NOT TO IT
-- ---------------------------------------------------------------------------
--
-- The naive reading is that an entry is admissible only when the product's base
-- uom EQUALS the line's infeed uom. That is far too strict. GET /products/:id
-- returns packages[] — several units sharing ONE base, a star rather than a
-- single conversion. So any package converts to any other through the hub:
--
--   target_qty = entered_qty * entered_factor_to_base / target_factor_to_base
--
-- The admissibility condition is therefore the much weaker "the line's infeed
-- uom is one of this product's packages".
--
-- BOTH FACTORS ARE STORED, NEVER THEIR RATIO. 1 CARTON = 12 BAG expressed as a
-- numeric(10,3) ratio is 0.083 and loses 0.4% on every entry. numeric(18,6) on
-- each side, full precision through the division, one round() at the end.
--
-- THE IDENTITY PATH IS FIRST CLASS AND CANNOT BE WRONG. When the operator enters
-- in the line's own infeed unit, entered_uom_id = target_uom_id, both factors are
-- equal, the ratio is exactly 1, master data is never consulted and no product is
-- needed at all. ck_wcqe_identity and ck_wcqe_basis make that structural rather
-- than a convention living in the service.
--
-- BOTH FACTORS ARE SNAPSHOTS, taken at entry time and never re-resolved. Master
-- data can be corrected, and a correction must not retroactively change what a
-- human entered three months ago. If it should, that is a void-and-re-enter,
-- performed by a person, with a name on it. 0008 snapshots factor_to_base for
-- exactly this reason.
--
-- ---------------------------------------------------------------------------
-- APPEND-ONLY, WITH A VOID
-- ---------------------------------------------------------------------------
--
-- There is NO edit. A wrong entry is VOIDED and a new one entered, so the trail
-- reads "500, then that was wrong, then 50" rather than "50" with no memory of
-- the 500 that sat on a report for a day. oee.wcqe_append_only() below enforces
-- it mechanically rather than by convention. This table is evidence, and evidence
-- that deletes itself is not evidence — 0010's phrasing, and the same reasoning.
--
-- The cost, stated plainly: a repair script cannot clean this table either. That
-- is accepted. A bad row is voided.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oee.work_center_quality_entries (
  -- bigint, not integer: an append-only ledger with no natural key, where every
  -- correction adds a row rather than replacing one.
  id                     bigint        GENERATED ALWAYS AS IDENTITY,

  kind                   text          NOT NULL,

  -- ---- THE TARGET GRAIN, AND IT IS ALWAYS SHIFT ---------------------------
  -- There is exactly ONE grain here even though the feature is offered on three
  -- screens. At month grain the operator picks a business date AND a shift; at
  -- day grain a shift; at shift grain both are already known. All three land the
  -- SAME row shape.
  --
  -- The day and month report rows get their share by ROLLING UP these rows —
  -- contract §16.3: "A line's day is the sum of its own line-shifts, and a month
  -- the sum of its days." A second entry at a coarser grain could not be
  -- attributed to a shift, so day and month would disagree with the shifts
  -- beneath them and §16.8's error-severity test would fire.
  work_center_id         integer       NOT NULL,
  -- The SHIFT's business day (contract §15.3), a real `date` — matching
  -- work_center_shift_reports.business_date. Shift 3 crosses midnight, so its
  -- post-midnight rejects carry the PREVIOUS calendar date.
  business_date          date          NOT NULL,
  shift                  smallint      NOT NULL,
  -- The IANA zone business_date was cut in, denormalised so the business-day
  -- rule is auditable from the data rather than from the service's config. 0006
  -- and 0008 do the same, for the same reason.
  time_zone              varchar(64)   NOT NULL,

  -- ---- PROVENANCE. None of this changes where the quantity lands. ---------
  -- The machine the operator saw the rejects on. PROVENANCE ONLY: it does NOT
  -- move oee.work_unit_*_reports, and there is no join anywhere that lets it.
  -- The decision behind that is 0014's: a line is MEASURED, not summed, so the
  -- line's reject comes from the line's own count point and a machine's comes
  -- from the machine's. An operator standing on the Line screen moves the LINE.
  --
  -- If a per-machine reject correction is ever wanted it is a DIFFERENT table at
  -- a different grain, keyed (work_unit_id, shift_date, shift). Do not reach for
  -- this column to build it.
  work_unit_id           integer,
  work_unit_name         varchar(255),

  -- The SKU. Nullable, but REQUIRED whenever a unit conversion happens, because
  -- it is the conversion basis — see ck_wcqe_basis. A line shift is not
  -- per-product and work_center_shift_reports has no product dimension, so the
  -- operator names the SKU; there is nothing to infer it from.
  product_id             integer,
  product_name           varchar(255),
  product_code           varchar(255),

  -- ms_reject.reject_reasons, scoped to the line by the filter added upstream in
  -- mes-master-data. Denormalised, like every id here, because there are no
  -- foreign keys in `oee` (0003) — every one of them belongs to a different
  -- service and a different database.
  reason_id              integer,
  reason_code            varchar(255),
  reason_name            varchar(255),
  note                   text,

  -- ---- AS ENTERED. Never scaled, never recomputed. ------------------------
  entered_qty            numeric(15,3) NOT NULL,
  entered_uom_id         integer       NOT NULL,
  entered_uom_code       varchar(255)  NOT NULL,
  entered_uom_name       varchar(255),
  -- numeric(18,6), NOT 0008's numeric(10,3): this one is a DIVISOR below, and
  -- three decimals of a ratio loses real quantity.
  entered_factor_to_base numeric(18,6) NOT NULL,

  -- ---- THE TARGET UNIT, SNAPSHOTTED AT ENTRY TIME -------------------------
  -- What the operator BELIEVED the line's infeed unit to be. A claim, not a
  -- fact: infeed_uom_id is pipeline-written and can change, or go NULL, before
  -- the override join runs. The join re-checks it.
  --
  -- NOT NULL precisely so the join's equality predicate can never match a NULL
  -- infeed unit — see defence 3 in the header.
  target_uom_id          integer       NOT NULL,
  target_uom_code        varchar(255)  NOT NULL,
  target_uom_name        varchar(255),
  target_factor_to_base  numeric(18,6) NOT NULL,
  -- The hub both factors point at. Carried so a reviewer can see that the two
  -- factors are commensurable at all.
  base_uom_id            integer       NOT NULL,
  base_uom_code          varchar(255)  NOT NULL,

  -- GENERATED, and that is the point — the same call 0008 made, and the one
  -- contract §3.3 records downtime_reports.duration failing to make. Postgres
  -- computes it and rejects any assignment, so a reader cannot drift from what a
  -- BI tool sees off the same row.
  --
  -- THE ONLY FIGURE THE OVERRIDE JOIN MAY SUM.
  --
  -- Two operational notes. A zero target_factor_to_base raises `division by
  -- zero` BEFORE ck_wcqe_factors reports it, because generated columns are
  -- computed ahead of constraints — the API validates first and the CHECK is the
  -- backstop with the less helpful message. And if this table is ever
  -- dbt-snapshotted, a naive merge fails with `column "target_qty" can only be
  -- updated to DEFAULT`.
  target_qty             numeric(15,3)
    GENERATED ALWAYS AS (
      round(entered_qty * entered_factor_to_base / target_factor_to_base, 3)
    ) STORED,

  -- ---- WHAT THE API COULD VERIFY WHEN THE ROW WAS WRITTEN -----------------
  --   'verified'   the report row existed, infeed_uom_id was known, and it
  --                matched target_uom_id.
  --   'unverified' no report row yet, or infeed_uom_id was NULL. Legitimate and
  --                common — a month-grain entry for a date the DAG has not
  --                reached. Accepted DELIBERATELY rather than refused: refusing
  --                here would make backfill and month-grain entry unusable, and
  --                the join decides in the end anyway.
  --
  -- This column exists so that "we could not check" stays distinguishable from
  -- "we checked", which is the distinction a support conversation turns on.
  unit_check             text          NOT NULL,

  -- ---- IDEMPOTENCY --------------------------------------------------------
  -- An append-only table with a surrogate key has NO natural key to ON CONFLICT
  -- against, so a double-submitted form is two live rows and a DOUBLED FIGURE,
  -- with nothing anywhere to notice. The client supplies this per submission and
  -- ux_wcqe_request makes the retry a no-op.
  --
  -- Not nullable "for scripts": a script can generate a uuid.
  request_id             uuid          NOT NULL,

  -- ---- AUDIT --------------------------------------------------------------
  -- now() is transaction_timestamp(), matching 0010's note.
  entered_at             timestamptz   NOT NULL DEFAULT now(),
  -- The Keycloak subject — the durable identity, the same rule
  -- work_unit_shift_report_approvals.closed_by follows and the one
  -- shared/actor.ts states: "The durable identity is always `sub`." NOT NULL,
  -- because there is no system path into this table.
  entered_by             text          NOT NULL,
  -- preferred_username AS IT WAS at entry time. Display only, and denormalised
  -- because there is no users table in this database. A person's display name
  -- changes; storing it as the identity would make the trail unjoinable.
  entered_by_name        text,

  -- ---- VOID, the only mutation this table permits -------------------------
  voided_at              timestamptz,
  voided_by              text,
  voided_by_name         text,
  void_reason            text,
  -- Set on the REPLACEMENT row, pointing at the row it corrects, so a chain of
  -- fat-finger corrections reads in order. NOT a foreign key — no table in `oee`
  -- has one, and a trail must survive its subject.
  supersedes_id          bigint,

  CONSTRAINT pk_work_center_quality_entries PRIMARY KEY (id),

  CONSTRAINT ck_wcqe_kind        CHECK (kind IN ('reject', 'rework')),
  CONSTRAINT ck_wcqe_shift       CHECK (shift BETWEEN 1 AND 3),
  CONSTRAINT ck_wcqe_unit_check  CHECK (unit_check IN ('verified', 'unverified')),

  -- STRICTLY POSITIVE, unlike 0008's counter_value >= 0. A sensor legitimately
  -- reports zero; a human typing zero has entered nothing, and the row would be
  -- a void-shaped object with no void on it.
  --
  -- And corrections are VOIDS, never negative quantities: a negative here would
  -- let an operator drive `reject` below what the line measured, which is a
  -- different claim from "I saw extra".
  CONSTRAINT ck_wcqe_qty         CHECK (entered_qty > 0),

  -- 0008's admission applies unchanged: any positive value passes, so a
  -- wrong-but-positive factor renders a plausible number and nothing downstream
  -- can validate it. What IS validated is the identity case below.
  CONSTRAINT ck_wcqe_factors     CHECK (
    entered_factor_to_base > 0 AND target_factor_to_base > 0
  ),

  -- THE IDENTITY PATH IS EXACT, BY CONSTRUCTION. If the operator entered in the
  -- line's own unit the ratio must be exactly 1 — not 0.999 from two
  -- independently fetched factors. This is the path that cannot be wrong, and
  -- this is what keeps it that way.
  CONSTRAINT ck_wcqe_identity    CHECK (
    entered_uom_id <> target_uom_id
    OR entered_factor_to_base = target_factor_to_base
  ),

  -- A CONVERSION NEEDS A BASIS. There is no global uom-to-uom table anywhere in
  -- this system; the only conversion that exists is per-product, through
  -- packages[]. So an entry whose units differ must name the product whose
  -- packages authorise the ratio. An entry already in the target unit needs no
  -- product at all.
  CONSTRAINT ck_wcqe_basis       CHECK (
    entered_uom_id = target_uom_id OR product_id IS NOT NULL
  ),

  -- A blank identity is worse than a rejected write: an audit row that cannot
  -- say who. 0008's ck_rcwus_reason, applied to a person.
  CONSTRAINT ck_wcqe_actor       CHECK (btrim(entered_by) <> ''),

  -- A void states WHEN and WHO together, or neither.
  CONSTRAINT ck_wcqe_void_pair   CHECK (
    (voided_at IS NULL) = (voided_by IS NULL)
  ),
  -- A LIVE row carries no void facts. Forward-compatible the way 0010's
  -- ck_wusra_open is: a live row describes the current state and must not hold a
  -- stale reason from something that did not happen.
  CONSTRAINT ck_wcqe_live_clean  CHECK (
    voided_at IS NOT NULL
    OR (voided_by_name IS NULL AND void_reason IS NULL)
  ),
  -- A row cannot supersede itself. The identity is materialised before
  -- constraints run, so this is legal in a CHECK.
  CONSTRAINT ck_wcqe_supersedes  CHECK (supersedes_id IS NULL OR supersedes_id <> id),

  CONSTRAINT ck_wcqe_note        CHECK (note IS NULL OR length(note) <= 2000)
);

-- ---------------------------------------------------------------------------
-- TWO INDEXES, AND THE OMISSIONS ARE DELIBERATE (0014's rule)
-- ---------------------------------------------------------------------------

-- Idempotency. A retried submission is a no-op, not a doubled figure.
CREATE UNIQUE INDEX IF NOT EXISTS ux_wcqe_request
  ON oee.work_center_quality_entries USING btree (request_id);

-- The override join's only access path, and the read path's ledger line.
-- PARTIAL: neither ever looks at voided rows, and on a table that grows by
-- correction the live set stays a fraction of the whole.
CREATE INDEX IF NOT EXISTS ix_wcqe_live_grain
  ON oee.work_center_quality_entries USING btree (work_center_id, business_date, shift)
  WHERE voided_at IS NULL;

-- No third index on business_date alone for the month roll-up: the override CTE
-- aggregates the whole live set once per run, which is a sequential scan over a
-- small table, and 0014 is explicit that an unused index costs write time on
-- every load. Add it when EXPLAIN asks for it.
--
-- THE SCALING TRIPWIRE, noted now so it is known rather than discovered: this
-- table only grows, and every void adds a row. At a few hundred entries a day it
-- is nothing for years, but the full-table CTE in every DAG run is what
-- eventually needs a business_date bound.

-- ---------------------------------------------------------------------------
-- APPEND-ONLY, ENFORCED
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oee.wcqe_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'oee.work_center_quality_entries is append-only: void row %, never delete it', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'oee.work_center_quality_entries: row % is already voided', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Everything except the four void columns must be byte-identical. to_jsonb
  -- minus the mutable keys is the whole-row comparison that a column-by-column
  -- list would silently stop covering the day somebody adds a column.
  --
  -- `target_qty` IS STRIPPED TOO, AND NOT BECAUSE IT IS MUTABLE — it is the one
  -- thing here nobody can write. GENERATED COLUMNS ARE COMPUTED AFTER BEFORE
  -- TRIGGERS RUN, so inside this function NEW.target_qty is NULL while
  -- OLD.target_qty carries the stored value. Comparing them makes EVERY update
  -- differ, which rejects the one mutation this table exists to permit — a void.
  -- That is not a hypothetical: this trigger shipped that way for one test run
  -- and refused every void with the "only the void columns" message, which points
  -- at exactly the wrong thing.
  --
  -- Dropping it from the comparison is safe rather than a loosening: target_qty
  -- is a pure function of entered_qty and the two factors, all three of which ARE
  -- compared. If they are unchanged it is unchanged, and it cannot be assigned.
  IF (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'voided_by_name' - 'void_reason' - 'target_qty')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'voided_by_name' - 'void_reason' - 'target_qty') THEN
    RAISE EXCEPTION
      'oee.work_center_quality_entries: only the void columns may be updated; '
      'correct an entry by voiding it and entering a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER wcqe_append_only BEFORE UPDATE OR DELETE
  ON oee.work_center_quality_entries
  FOR EACH ROW EXECUTE FUNCTION oee.wcqe_append_only();

-- ---------------------------------------------------------------------------
-- AUDIT, per 0004 — and note the inversion relative to every pipeline table.
-- There, INSERT is the bulk path and gets a STATEMENT-level trigger while the
-- operator's UPDATE/DELETE gets a row-level one. Here there is no pipeline path
-- at all: every INSERT is one operator entering one quantity, so row-level on
-- INSERT is the right call and is what makes the ledger auditable per row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT
  ON oee.work_center_quality_entries
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE
  ON oee.work_center_quality_entries
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('id');

-- ---------------------------------------------------------------------------
-- Column documentation, for the consumers who never open this file
-- ---------------------------------------------------------------------------
COMMENT ON TABLE oee.work_center_quality_entries IS
  'Operator-entered reject and rework at LINE grain. Written by mes-oee-monitor only; the pipeline READS it and applies it through the override join in gold-write-contract.md §18. Append-only: correct an entry by voiding it and entering a new one. An entry moves reject/rework and NO rate — the rates are time-derived (§16.10a).';
COMMENT ON COLUMN oee.work_center_quality_entries.work_unit_id IS
  'The machine the operator attributed the quantity to. PROVENANCE ONLY — it does not move oee.work_unit_*_reports. A line is measured at its own count points, so the quantity lands on the LINE.';
COMMENT ON COLUMN oee.work_center_quality_entries.target_uom_id IS
  'The line infeed unit the entry is denominated in, snapshotted at entry time. The override join admits an entry only when this EQUALS the report row''s infeed_uom_id — a plain equality, so a mixed-unit shift (infeed_uom_id NULL) matches nothing and cannot fail the load on ck_wcsr_infeed_units.';
COMMENT ON COLUMN oee.work_center_quality_entries.target_qty IS
  'The entered quantity converted into target_uom_id, through the product base both factors point at. GENERATED, so it cannot drift from the factors beside it. THE ONLY FIGURE THE OVERRIDE JOIN MAY SUM.';
COMMENT ON COLUMN oee.work_center_quality_entries.unit_check IS
  'Whether the API could compare target_uom_id against the report row at write time. ''unverified'' is legitimate — a month-grain entry for a date the pipeline has not reached — and says "we could not check", never "we checked and it was fine".';
COMMENT ON COLUMN oee.work_center_quality_entries.request_id IS
  'Client-supplied per submission. Unique, so a double-submitted form is a no-op rather than two live rows and a doubled figure.';
COMMENT ON COLUMN oee.work_center_quality_entries.supersedes_id IS
  'On a replacement row, the voided row it corrects, so a chain of corrections reads in order. Not a foreign key: nothing in oee has one.';
