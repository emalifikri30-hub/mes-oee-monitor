-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE. See 0015.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0017_work_center_units_dev.sql
--
-- ===========================================================================
-- THIS FILE INVENTS THE ONE FACT 0015 DELIBERATELY REFUSES TO INVENT.
-- ===========================================================================
--
-- Read 0015's note 2 before this one. It says, correctly:
--
--   "THIS SEED CANNOT DERIVE EITHER SIDE HONESTLY, and writes NULL rather than
--    guessing. oee.work_unit_shift_reports carries ONE uom per machine and no
--    marking of which machine is the line's infeed or its outfeed — that lives
--    in ms_code.count_points, upstream and unreadable from here. [...] A seed
--    that took min(uom_id) for both sides would be inventing the one fact that
--    section exists to pin down."
--
-- Every word of that stands. THIS FILE INVENTS IT ANYWAY, on purpose, because
-- without units the line screens cannot be exercised at all:
--
--   * the Losses card's Reject and Rework tiles render em dashes
--     (ck_wcsr_infeed_units nulls the counts along with the unit)
--   * the hourly seed 0018 finds nothing to join and produces no rows
--   * AND THE REJECT/REWORK ENTRY DIALOG REFUSES EVERY WRITE with a 409 —
--     "this line has not reported a unit for that shift, so there is nothing to
--     record the quantity in". That refusal is CORRECT (see
--     quality-entry-service.ts) and it makes the feature untestable on
--     0015-seeded data.
--
-- THE INFEED UNIT IS REAL; ONLY THE OUTPUT ONE IS INVENTED. That split is a bug
-- fix, not a refinement. The first version hardcoded `infeed_uom_id = 41` — a
-- made-up id — and the entry dialog then refused every write with
--
--   "SKU B has no BAG conversion, so this quantity cannot be recorded against a
--    line reporting in BAG"
--
-- which reads as nonsense and is exactly right: the service matches a product's
-- packages on uom **ID**, master data's real BAG record is not id 41, and the
-- CODES agreed while the RECORDS did not. A label is not a key.
--
-- So the infeed triple now comes from oee.work_unit_shift_reports.uom_*, which
-- the pipeline wrote from master data and which therefore joins to it. The output
-- triple stays invented, and that is safe because NOTHING JOINS ON IT — an entry
-- lands infeed-side, so the output unit is display only.
--
-- ---------------------------------------------------------------------------
-- WHAT MUST NOT BE CONCLUDED FROM THIS FILE
-- ---------------------------------------------------------------------------
--
--   * NOT that a line's infeed is its machines' unit. It is whatever
--     ms_code.count_points says, and this file has never read that table.
--   * NOT that output = infeed / 12. That ratio is invented so the two sides are
--     VISIBLY different on screen; a real line's is a packaging fact.
--   * NOT that these figures reconcile with anything. They do not — 0015's own
--     durations are machine-milliseconds and the counts here are machine-sums.
--
-- IT KEEPS THE TWO UNITS DIFFERENT ON PURPOSE. If dev data had them equal, every
-- rule that exists because a line has two units — the Losses card's infeed
-- labelling, the entry dialog's conversion, the hourly chart plotting only the
-- output side — would look correct while being untested, and the first person to
-- see the difference would be a user.
--
-- Run AFTER 0015 and BEFORE 0016/0018.

DO $$
BEGIN
  IF current_database() = 'mes-master-data'
     AND coalesce(current_setting('seed.allow_shared', true), '') <> 'yes' THEN
    RAISE EXCEPTION
      'Refusing to seed the shared Gold database %. Point GOLD_DATABASE_URL at a local Postgres, or pass -c "SET seed.allow_shared = ''yes''" if you really mean it.',
      current_database();
  END IF;
END
$$;

BEGIN;

-- ONLY ROWS THAT ARE STILL ABSTAINING. A line report whose units the PIPELINE has
-- filled is left completely alone — this file must never overwrite a real
-- measurement with an invented one, which is the one way it could do lasting harm.
--
-- The counts move with the unit, because ck_wcsr_infeed_units and
-- ck_wcsr_output_units refuse a count whose side has no unit. Writing one without
-- the other fails the statement rather than landing half a row.
UPDATE oee.work_center_shift_reports r
   SET infeed_uom_id   = m.uom_id,
       infeed_uom_name = m.uom_name,
       infeed_uom_code = m.uom_code,
       -- INVENTED, and safe to invent because nothing joins on it — see the
       -- header. Kept DIFFERENT from the infeed unit on purpose: if dev data had
       -- them equal, every rule that exists because a line has two units would
       -- look correct while being untested.
       output_uom_id = 42, output_uom_name = 'Carton', output_uom_code = 'CTN',
       -- INFEED side. Machine sums, which is the wrong number by construction —
       -- 0015's step 1 already says so at length about the durations.
       total_out = m.total_out,
       reject    = m.reject,
       rework    = m.rework,
       -- The line's own measured infeed (migration 0015's column). Set a little
       -- under total_out so the overview card's fourth tile differs from the
       -- first and the two are distinguishable on screen.
       line_out  = round(m.total_out * 0.98, 3),
       -- OUTPUT side, in CARTONS. Twelve bags to a carton — invented, see above.
       good_out      = round(m.good_out / 12.0, 3),
       effective_out = round(m.good_out / 12.0 * 0.94, 3)
  FROM (
    SELECT work_center_id,
           coalesce(business_date, (date AT TIME ZONE time_zone)::date) AS business_date,
           shift,
           -- THE MACHINES' OWN UNIT, which the pipeline wrote from master data and
           -- which therefore carries a REAL uom id. min() is safe only because the
           -- filter below admits nothing else — see the HAVING.
           min(uom_id)              AS uom_id,
           min(uom_name)            AS uom_name,
           min(uom_code)            AS uom_code,
           round(sum(total_out), 3) AS total_out,
           round(sum(good_out), 3)  AS good_out,
           round(sum(reject), 3)    AS reject,
           round(sum(rework), 3)    AS rework
      FROM oee.work_unit_shift_reports
     GROUP BY work_center_id, coalesce(business_date, (date AT TIME ZONE time_zone)::date), shift
    -- UNANIMOUS UNITS ONLY. A line whose machines disagree has no single infeed
    -- unit to borrow, and picking one would put unlike counts under one label —
    -- the "512 <blank>" §16.4 refuses. Those lines keep 0015's NULLs and their
    -- Losses tiles stay em dashes, which is the honest outcome.
    HAVING count(DISTINCT uom_id) = 1
  ) AS m
 WHERE r.work_center_id = m.work_center_id
   AND r.business_date  = m.business_date
   AND r.shift          = m.shift
   -- THE ABSTENTION TEST. Both sides null means 0015 wrote this row; either side
   -- populated means somebody else did, and this file keeps its hands off.
   AND r.infeed_uom_id IS NULL
   AND r.output_uom_id IS NULL;

-- The day and month rows, rolled from the shifts this file just filled. §16.3's
-- rule: the counts ADD along the time axis, the rates are recomputed and are left
-- untouched here because 0015 already wrote them.
UPDATE oee.work_center_day_reports d
   SET infeed_uom_id   = s.infeed_uom_id,
       infeed_uom_name = s.infeed_uom_name,
       infeed_uom_code = s.infeed_uom_code,
       output_uom_id = 42, output_uom_name = 'Carton', output_uom_code = 'CTN',
       total_out = s.total_out, reject = s.reject, rework = s.rework,
       line_out = s.line_out, good_out = s.good_out, effective_out = s.effective_out
  FROM (
    SELECT work_center_id, business_date,
           min(infeed_uom_id)           AS infeed_uom_id,
           min(infeed_uom_name)         AS infeed_uom_name,
           min(infeed_uom_code)         AS infeed_uom_code,
           round(sum(total_out), 3)     AS total_out,
           round(sum(reject), 3)        AS reject,
           round(sum(rework), 3)        AS rework,
           round(sum(line_out), 3)      AS line_out,
           round(sum(good_out), 3)      AS good_out,
           round(sum(effective_out), 3) AS effective_out
      FROM oee.work_center_shift_reports
     WHERE infeed_uom_id IS NOT NULL
     GROUP BY work_center_id, business_date
  ) AS s
 WHERE d.work_center_id = s.work_center_id
   AND d.business_date  = s.business_date
   AND d.infeed_uom_id IS NULL
   AND d.output_uom_id IS NULL;

UPDATE oee.work_center_month_reports mo
   SET infeed_uom_id   = s.infeed_uom_id,
       infeed_uom_name = s.infeed_uom_name,
       infeed_uom_code = s.infeed_uom_code,
       output_uom_id = 42, output_uom_name = 'Carton', output_uom_code = 'CTN',
       total_out = s.total_out, reject = s.reject, rework = s.rework,
       line_out = s.line_out, good_out = s.good_out, effective_out = s.effective_out
  FROM (
    SELECT work_center_id, date_trunc('month', business_date)::date AS business_date,
           min(infeed_uom_id)           AS infeed_uom_id,
           min(infeed_uom_name)         AS infeed_uom_name,
           min(infeed_uom_code)         AS infeed_uom_code,
           round(sum(total_out), 3)     AS total_out,
           round(sum(reject), 3)        AS reject,
           round(sum(rework), 3)        AS rework,
           round(sum(line_out), 3)      AS line_out,
           round(sum(good_out), 3)      AS good_out,
           round(sum(effective_out), 3) AS effective_out
      FROM oee.work_center_shift_reports
     WHERE infeed_uom_id IS NOT NULL
     GROUP BY work_center_id, date_trunc('month', business_date)::date
  ) AS s
 WHERE mo.work_center_id = s.work_center_id
   AND mo.business_date  = s.business_date
   AND mo.infeed_uom_id IS NULL
   AND mo.output_uom_id IS NULL;

DO $$
DECLARE
  filled bigint;
  still_null bigint;
BEGIN
  SELECT count(*) INTO filled
    FROM oee.work_center_shift_reports WHERE infeed_uom_id IS NOT NULL;
  SELECT count(*) INTO still_null
    FROM oee.work_center_shift_reports WHERE infeed_uom_id IS NULL;

  IF filled = 0 THEN
    RAISE EXCEPTION
      'No line shift report gained a unit. Run 0015 first, or the rows already carry pipeline-written units (in which case nothing here was needed).';
  END IF;

  RAISE NOTICE 'seed 0017: % line shift reports carry units; % left abstaining (machines disagreed)',
    filled, still_null;
  RAISE NOTICE '  INFEED is the machines'' own unit, so it joins to master data and the entry dialog works.';
  RAISE NOTICE '  OUTPUT is INVENTED (CTN). Nothing joins on it. See this file''s header.';
END
$$;

COMMIT;
