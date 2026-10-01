-- \set ON_ERROR_STOP on IS LOAD-BEARING AND MUST STAY THE FIRST LINE.
--
-- Without it the guard below is DECORATIVE. `RAISE EXCEPTION` inside a DO block
-- aborts that statement and nothing more: psql reports the error and carries
-- straight on to the next statement, so the refusal prints and the seed runs
-- anyway. That was observed, not theorised — the guard fired against the shared
-- Gold database and 18 rows landed regardless.
--
-- Setting it inside the FILE rather than relying on `psql -v ON_ERROR_STOP=1`
-- means the protection travels with the script, however it is invoked.
\set ON_ERROR_STOP on

-- DEV ONLY. Hand-run. NOT a migration, and deliberately not in
-- src/shared/database/migration/ — scripts/migrate.mjs applies EVERY *.sql it
-- finds in that directory, so a seed placed there would insert fabricated
-- production data into every environment the migrator touches.
--
--   psql "$GOLD_DATABASE_URL" -f apps/api/scripts/seed/0015_work_center_reports_dev.sql
--
-- READ THE GUARD AT THE TOP BEFORE YOU RUN IT. apps/api/.env points
-- GOLD_DATABASE_URL at a SHARED REMOTE DATABASE, not a local one. The guard
-- refuses that one database by name; it cannot know about yours, so check
-- `\conninfo` first anyway.
--
-- THE NUMBER IS 0015, NOT 0014, AND IT DOES NOT TRACK THE MIGRATION.
-- scripts/seed/0014_review_week_dev.sql already exists and has no corresponding
-- migration. Seed numbers are a sequence of their own; the migration this one
-- fills is 0014_oee_work_center_grain.sql.
--
-- WHY IT EXISTS
--
-- oee.work_center_{shift,day,month}_reports ship EMPTY —
-- docs/gold-write-contract.md §1 rule 2 is that this service never bulk-inserts,
-- and no dbt model writes them yet (§16 is the ask). The three Line report
-- screens are therefore unreachable by eye: their only state without rows is an
-- empty list. This file fills all three grains so the populated path can be
-- looked at in a browser.
--
-- IT IS A STAND-IN. IT IS *NOT* THE SPECIFICATION. READ THIS BEFORE COPYING IT.
--
-- 0013's seed could call itself the specification of the day/month roll-up,
-- because a day genuinely IS the sum of its shifts. THIS FILE CANNOT, and the
-- difference matters more than the similarity:
--
--   A LINE IS MEASURED AT ITS OWN COUNT POINTS. It is not a roll-up of its
--   machines, and `line_report <> sum(machine_reports)`. Five machines in series
--   pass work along; the line ships what comes off the end, and its
--   availability_time is its own wall clock, not N times anything. See migration
--   0014's header and contract §16.3.
--
-- This file sums machines anyway, because in a dev database there is nothing else
-- to derive from: oee.work_unit_shift_reports is all that exists, and empty Line
-- screens cannot be reviewed by eye. The numbers it produces are therefore
-- PLAUSIBLE AND STRUCTURALLY WRONG — right shape, right identities, wrong
-- provenance. They are here so the screens can be looked at, and for nothing else.
--
-- WHAT IS STILL NORMATIVE HERE, and worth reading as spec:
--
--   * the rates are RECOMPUTED from the summed components, never averaged;
--   * a line's DAY is the sum of its own line-SHIFTS (steps 2 and 3), which is
--     true of the real pipeline too and is the one dbt test §16.8 asks for;
--   * mttr/mtbf are ratios and are recomputed, not averaged;
--   * work_unit_count is max() up the chain, not sum().
--
-- WHAT IS NOT: step 1. The hop from machines to a line is this file's invention.
--
-- The shared rules, which steps 2 and 3 do follow, are §16.3's:
--
--     durations and counts  ->  SUM        (in MACHINE-milliseconds; see below)
--     rates (oee, teep, a, p, q, mttr, mtbf)  ->  RECOMPUTE from the sums
--
-- Never `avg(availability)`. §15.5 works the arithmetic on the analogous case.
--
-- A dbt model that disagrees with STEPS 2 AND 3 is the model that is wrong. A dbt
-- model that disagrees with STEP 1 is almost certainly right, and this file is
-- the thing that is wrong — see the stand-in warning above.
--
-- WHAT IT FABRICATES: NOTHING. Every row is derived from
-- oee.work_unit_shift_reports, which 0013_day_month_reports_dev.sql and
-- 0014_review_week_dev.sql fill. Run one of those first or this file inserts
-- nothing at all. Every step is `DO UPDATE`, so re-running refreshes the line
-- rows from whatever the machine rows currently say.
--
--   step 0  the work_center_id collision check                    RAISE NOTICE
--   step 1  line SHIFT reports  <- oee.work_unit_shift_reports   INVENTED (see above)
--   step 2  line DAY reports    <- step 1                        normative
--   step 3  line MONTH reports  <- step 2                        normative
--   step 4  assertions                                           RAISE EXCEPTION
--
-- STEPS 2 AND 3 CHAIN DELIBERATELY, as 0013's seed chains month<-day: it proves
-- the two-step chain the pipeline will actually build (§16.10 Q7), and it is the
-- only way to exercise the NULL-skipping trap in step 2's unit gate.
--
-- ---------------------------------------------------------------------------
-- THREE THINGS THAT CHANGE WHEN THE GROUP KEY IS work_center_id
-- ---------------------------------------------------------------------------
--
--   work_unit roll-up (0013 seed)          work_center roll-up (this file)
--   GROUP BY work_unit_id, business_date   GROUP BY work_center_id, business_date[, shift]
--     -- ONE machine, MANY times             -- MANY machines, ONE time
--     uom invariant   -> min() is safe       uom NOT invariant -> guard, or NULL
--     availability_time = wall clock         availability_time = N x wall clock
--     count(*) = shifts in the day           count(*) = machines that REPORTED
--     work_center_* constant -> min() safe   work_center_* constant BY DEFINITION
--
-- 1. min(uom_id) STOPS BEING SAFE. 0013's seed says of min(): "they are
--    denormalised labels that do not vary within a work unit; if they ever did,
--    min() would pick one silently." Across the machines of a line they DO vary.
--
-- 2. THE COUNTS ARE NULLED WITH THEIR UNIT, not just the label — and there are
--    TWO units to gate rather than one. A line consumes in one and ships in
--    another (migration 0014's header): total_out/reject/rework belong to the
--    INFEED unit, good_out/effective_out to the OUTPUT unit, and the guards are
--    separate so a line can be sure of one side and abstain on the other.
--
--    THIS SEED CANNOT DERIVE EITHER SIDE HONESTLY, and writes NULL rather than
--    guessing. oee.work_unit_shift_reports carries ONE uom per machine and no
--    marking of which machine is the line's infeed or its outfeed — that lives
--    in ms_code.count_points, upstream and unreadable from here. So both triples
--    and all five counts are NULL, which satisfies the ck_*_units guards
--    trivially. The PIPELINE fills them; contract §16.4. A seed that took
--    min(uom_id) for both sides would be inventing the one fact that section
--    exists to pin down.
--
-- 3. THE DURATIONS THIS FILE PRODUCES ARE MACHINE-MILLISECONDS, and the real
--    ones are not. Summing four machines over an 8h shift gives 32 machine-hours
--    here; the pipeline's line row will carry 8, measured at the line. This is
--    the single most misleading thing about step 1 and the main reason the file
--    opens with a warning.
--
-- ---------------------------------------------------------------------------
-- AND ONE TRAP THAT ONLY APPEARS ON THE SECOND HOP
-- ---------------------------------------------------------------------------
--
-- count(DISTINCT x) SKIPS NULLs. So a day whose shift 1 was mixed-unit (uom_id
-- NULL, counts NULL) and whose shifts 2 and 3 were BAG evaluates
-- count(DISTINCT uom_id) = 1, writes BAG, and sum(total_out) then SKIPS shift 1's
-- NULL — a confident BAG label over a day that under-reports its output by a
-- whole shift, with nothing failing anywhere.
--
-- A unit gate therefore needs TWO halves, and both are load-bearing. It is
-- written out in docs/gold-write-contract.md §16.3 for the pipeline to
-- implement; THIS FILE DOES NOT EXERCISE IT, because it writes no units at all
-- (see 2 above) and so has nothing to gate:
--
--     count(DISTINCT uom_id) = 1   -- the members agreed on a unit
--     count(uom_id) = count(*)     -- and NO MEMBER ABSTAINED
--
-- That is AGENTS.md's count(*)-not-count(column) rule, used deliberately in both
-- directions.

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------

-- THE BYPASS IS A FLAG, NOT AN EDIT — the convention 0014_review_week_dev.sql
-- established, and its reasoning applies verbatim: "a guard you have to delete to
-- proceed is a guard that gets deleted and left deleted." Requiring an explicit
-- GUC keeps the refusal for everyone who did not mean it, while making the
-- override visible in the command that ran rather than invisible in a working
-- copy:
--
--   psql "$GOLD_DATABASE_URL" \
--     -c "SET seed.allow_shared = 'yes'" \
--     -f apps/api/scripts/seed/0015_work_center_reports_dev.sql
--
-- Both must be in ONE psql invocation. A separate `-c` call is a separate session
-- and the setting will not survive into this file.
--
-- This file DERIVES rather than fabricates, so seeding a shared database with it
-- is less dangerous than with 0013 — but "less dangerous" is not "intended", and
-- the three tables it writes are the pipeline's to own.
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

-- ---------------------------------------------------------------------------
-- Step 0 — the work_center_id collision check
-- ---------------------------------------------------------------------------
--
-- THE TWO EXISTING SEEDS DISAGREE ABOUT WHICH LINE A MACHINE IS ON, and this
-- roll-up groups on exactly that column. 0013_day_month_reports_dev.sql writes
-- work unit 3 under work_center_id 1 ('Line 1', 'L1'); 0014_review_week_dev.sql
-- writes it under work_center_id 2 ('Line 1', 'FI2-L1'), and says it read those
-- values off the live Gold database.
--
-- So a dev database that has run BOTH gets TWO ROWS BOTH LABELLED "Line 1" on
-- every Line screen. That is a data artifact, not a bug in the roll-up — but it
-- is the first thing anyone will see, and without this notice it reads as the
-- feature being broken.
--
-- A NOTICE rather than an EXCEPTION: a developer whose dev database is
-- inconsistent in a way that does not affect what they are working on should not
-- be blocked from seeding.
DO $$
DECLARE
  offender record;
  found    boolean := false;
BEGIN
  FOR offender IN
    SELECT work_unit_id,
           count(DISTINCT work_center_id)                     AS lines,
           string_agg(DISTINCT work_center_id::text, ', ' ORDER BY work_center_id::text) AS ids
      FROM oee.work_unit_shift_reports
     GROUP BY work_unit_id
    HAVING count(DISTINCT work_center_id) > 1
  LOOP
    found := true;
    RAISE NOTICE
      'work unit % appears under % different work_center_ids (%). The Line screens will show it as that many separate lines, possibly under the SAME NAME. This is the 0013 / 0014 seed disagreement, not a roll-up bug — see the header.',
      offender.work_unit_id, offender.lines, offender.ids;
  END LOOP;

  IF NOT found THEN
    RAISE NOTICE 'work_center_id is consistent per work unit; the Line screens will show one row per real line.';
  END IF;
END
$$;

-- Multi-machine lines are what make this feature falsifiable by eye: a line
-- derived from ONE machine is numerically identical to that machine, so
-- "line = sum of its machines" cannot be checked by looking at it. 0013's seed
-- provides one (work units 3 and 4 on the same line); the review-week seed does
-- not.
DO $$
DECLARE
  widest integer;
BEGIN
  SELECT max(machines) INTO widest
    FROM (SELECT count(DISTINCT work_unit_id) AS machines
            FROM oee.work_unit_shift_reports
           GROUP BY work_center_id, business_date, shift) w;

  IF widest IS NULL THEN
    RAISE NOTICE 'oee.work_unit_shift_reports is empty — run 0013_day_month_reports_dev.sql first, or this file inserts nothing.';
  ELSIF widest < 2 THEN
    RAISE NOTICE 'No line has more than one machine in any shift. The roll-up will run, but every line row will equal its single machine, so it cannot demonstrate the arithmetic. Run 0013_day_month_reports_dev.sql for a two-machine line.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Step 1 — line SHIFT reports, from every machine's shift report
-- ---------------------------------------------------------------------------

INSERT INTO oee.work_center_shift_reports (
  work_center_id, business_date, shift, time_zone,
  work_center_name, work_center_code, area_id, area_name, month,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id,
  r.business_date,
  r.shift,
  min(r.time_zone),

  -- Safe here in a way min(uom_*) is NOT: these are constant within the group BY
  -- DEFINITION of the group key. coalesce so a NULL denormalised name still
  -- satisfies work_center_name NOT NULL — the PIPELINE must write a real one
  -- (§16.1), and a seed that fell over on dev data would teach nobody that.
  coalesce(min(r.work_center_name), 'Line ' || r.work_center_id),
  min(r.work_center_code),

  -- The seed CANNOT derive these: work_unit_shift_reports has no area columns.
  -- The pipeline reads them from mes-master-data, exactly as it already does for
  -- oee.product_perf_wu_hour.area_id. Contract §16.6.
  NULL::integer,
  NULL::varchar,
  to_char(r.business_date, 'YYYY-MM'),

  count(*)::int,
  -- Likewise not derivable here — it is the line's ROSTER, which lives upstream.
  -- Left NULL so the screen falls back to a bare count; §16.5 says it must never
  -- be a guess, and a seed inventing one would be exactly that.
  NULL::integer,

  -- Which machine is the line's infeed and which its outfeed lives in
  -- ms_code.count_points, upstream and unreadable from here. NULL rather than a
  -- guess; the pipeline fills both triples. Contract §16.4.
  NULL::integer, NULL::varchar, NULL::varchar,
  NULL::integer, NULL::varchar, NULL::varchar,

  -- RATES: recomputed from the summed components. NEVER avg(). nullif() gives
  -- NULL rather than a division error for a line that never ran — the columns are
  -- nullable precisely so 0/0 stays honest instead of claiming 0%.
  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),

  -- NULL with their units. ck_*_units requires the pairing, and a count with no
  -- unit is a wrong number with a missing label.
  --
  -- SIX NOW, NOT FIVE: `line_out` (migration 0015) is the line's own measured
  -- production on the INFEED side, so it is nulled with total_out/reject/rework
  -- and by the same guard. It is the one count this seed could most plausibly
  -- fake — sum(total_out) is right there — and faking it would be exactly the
  -- error point 2 above is about: a confident number under a unit nobody
  -- established.
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,

  -- DURATIONS: plain sums, giving MACHINE-milliseconds. The pipeline's line row
  -- carries the LINE's own wall clock instead. Step 1 is a stand-in; see the header.
  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  -- MTTR/MTBF ARE RATIOS AND ARE RECOMPUTED, NOT AVERAGED. Each machine's failure
  -- count is recovered as updt_time / mttr, the counts are summed, and the line's
  -- values divide the summed durations by that total. IDENTICAL IN FORM to 0013's
  -- seed; what changes is the reading — the count is now failures across the
  -- LINE's machines, and MTBF's numerator is machine-operating-time.
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.work_unit_shift_reports r
-- business_date IS NOT NULL is load-bearing: 0013 added it nullable and Airflow
-- has not backfilled it (TODOS §46), so a machine row without one has no day to
-- group into. work_center_id IS NOT NULL is belt-and-braces — the column has been
-- NOT NULL since 0003, and the pipeline owner has confirmed every work unit has a
-- work center whatever its process type (contract §16.10 Q6).
WHERE r.business_date IS NOT NULL
  AND r.work_center_id IS NOT NULL
GROUP BY r.work_center_id, r.business_date, r.shift
ON CONFLICT (business_date, shift, work_center_id) DO UPDATE SET
  time_zone = excluded.time_zone,
  work_center_name = excluded.work_center_name, work_center_code = excluded.work_center_code,
  area_id = excluded.area_id, area_name = excluded.area_name, month = excluded.month,
  work_unit_count = excluded.work_unit_count,
  expected_work_unit_count = excluded.expected_work_unit_count,
  infeed_uom_id = excluded.infeed_uom_id, infeed_uom_name = excluded.infeed_uom_name,
  infeed_uom_code = excluded.infeed_uom_code,
  output_uom_id = excluded.output_uom_id, output_uom_name = excluded.output_uom_name,
  output_uom_code = excluded.output_uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out, reject = excluded.reject, rework = excluded.rework,
  line_out = excluded.line_out,
  runtime = excluded.runtime, availability_time = excluded.availability_time,
  production_time = excluded.production_time, pdt_time = excluded.pdt_time,
  operating_time = excluded.operating_time, updt_time = excluded.updt_time,
  net_time = excluded.net_time, reduce_speed_time = excluded.reduce_speed_time,
  ms_time = excluded.ms_time, value_added_time = excluded.value_added_time,
  rework_time = excluded.rework_time, reject_time = excluded.reject_time,
  anomaly_time = excluded.anomaly_time, up_speed_time = excluded.up_speed_time,
  schedule_loss_time = excluded.schedule_loss_time,
  availability_loss_time = excluded.availability_loss_time,
  performance_loss_time = excluded.performance_loss_time,
  ms_loss_time = excluded.ms_loss_time,
  reduce_speed_loss_time = excluded.reduce_speed_loss_time,
  quality_loss_time = excluded.quality_loss_time,
  mttr = excluded.mttr, mtbf = excluded.mtbf;

-- ---------------------------------------------------------------------------
-- Step 2 — line DAY reports, from the line shift reports above
-- ---------------------------------------------------------------------------
--
-- The same statement one grain up. Two things differ and both are easy to get
-- wrong invisibly:
--
--   * work_unit_count is max(), NOT sum(). A day's machine count is its busiest
--     shift's; summing three shifts of a two-machine line would claim six.
--   * this is the hop where the NULL-skipping trap lives. The unit gate is
--     unchanged in form precisely because it already handles it.

INSERT INTO oee.work_center_day_reports (
  work_center_id, business_date, time_zone,
  work_center_name, work_center_code, area_id, area_name, month,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id,
  r.business_date,
  min(r.time_zone),
  min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name),
  to_char(r.business_date, 'YYYY-MM'),

  max(r.work_unit_count)::int,
  max(r.expected_work_unit_count)::int,

  -- Which machine is the line's infeed and which its outfeed lives in
  -- ms_code.count_points, upstream and unreadable from here. NULL rather than a
  -- guess; the pipeline fills both triples. Contract §16.4.
  NULL::integer, NULL::varchar, NULL::varchar,
  NULL::integer, NULL::varchar, NULL::varchar,

  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),

  -- NULL with their units. ck_*_units requires the pairing, and a count with no
  -- unit is a wrong number with a missing label.
  --
  -- SIX NOW, NOT FIVE: `line_out` (migration 0015) is the line's own measured
  -- production on the INFEED side, so it is nulled with total_out/reject/rework
  -- and by the same guard. It is the one count this seed could most plausibly
  -- fake — sum(total_out) is right there — and faking it would be exactly the
  -- error point 2 above is about: a confident number under a unit nobody
  -- established.
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,

  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.work_center_shift_reports r
GROUP BY r.work_center_id, r.business_date
ON CONFLICT (business_date, work_center_id) DO UPDATE SET
  time_zone = excluded.time_zone,
  work_center_name = excluded.work_center_name, work_center_code = excluded.work_center_code,
  area_id = excluded.area_id, area_name = excluded.area_name, month = excluded.month,
  work_unit_count = excluded.work_unit_count,
  expected_work_unit_count = excluded.expected_work_unit_count,
  infeed_uom_id = excluded.infeed_uom_id, infeed_uom_name = excluded.infeed_uom_name,
  infeed_uom_code = excluded.infeed_uom_code,
  output_uom_id = excluded.output_uom_id, output_uom_name = excluded.output_uom_name,
  output_uom_code = excluded.output_uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out, reject = excluded.reject, rework = excluded.rework,
  line_out = excluded.line_out,
  runtime = excluded.runtime, availability_time = excluded.availability_time,
  production_time = excluded.production_time, pdt_time = excluded.pdt_time,
  operating_time = excluded.operating_time, updt_time = excluded.updt_time,
  net_time = excluded.net_time, reduce_speed_time = excluded.reduce_speed_time,
  ms_time = excluded.ms_time, value_added_time = excluded.value_added_time,
  rework_time = excluded.rework_time, reject_time = excluded.reject_time,
  anomaly_time = excluded.anomaly_time, up_speed_time = excluded.up_speed_time,
  schedule_loss_time = excluded.schedule_loss_time,
  availability_loss_time = excluded.availability_loss_time,
  performance_loss_time = excluded.performance_loss_time,
  ms_loss_time = excluded.ms_loss_time,
  reduce_speed_loss_time = excluded.reduce_speed_loss_time,
  quality_loss_time = excluded.quality_loss_time,
  mttr = excluded.mttr, mtbf = excluded.mtbf;

-- ---------------------------------------------------------------------------
-- Step 3 — line MONTH reports, from the line day reports above
-- ---------------------------------------------------------------------------
--
-- business_date is the FIRST business day of the month, which ck_wcmr_month_start
-- enforces — contract §15.3 says "not the last, and not midnight of the first".

INSERT INTO oee.work_center_month_reports (
  work_center_id, business_date, time_zone,
  work_center_name, work_center_code, area_id, area_name, month,
  work_unit_count, expected_work_unit_count,
  infeed_uom_id, infeed_uom_name, infeed_uom_code,
  output_uom_id, output_uom_name, output_uom_code,
  teep, oee, availability, performance, quality,
  total_out, good_out, effective_out, reject, rework, line_out,
  runtime, availability_time, production_time, pdt_time, operating_time,
  updt_time, net_time, reduce_speed_time, ms_time, value_added_time,
  rework_time, reject_time, anomaly_time, up_speed_time,
  schedule_loss_time, availability_loss_time, performance_loss_time,
  ms_loss_time, reduce_speed_loss_time, quality_loss_time,
  mttr, mtbf
)
SELECT
  r.work_center_id,
  date_trunc('month', r.business_date)::date,
  min(r.time_zone),
  min(r.work_center_name), min(r.work_center_code),
  min(r.area_id), min(r.area_name),
  to_char(date_trunc('month', r.business_date), 'YYYY-MM'),

  max(r.work_unit_count)::int,
  max(r.expected_work_unit_count)::int,

  -- Which machine is the line's infeed and which its outfeed lives in
  -- ms_code.count_points, upstream and unreadable from here. NULL rather than a
  -- guess; the pipeline fills both triples. Contract §16.4.
  NULL::integer, NULL::varchar, NULL::varchar,
  NULL::integer, NULL::varchar, NULL::varchar,

  round(sum(r.value_added_time)::numeric / nullif(sum(r.availability_time), 0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.operating_time)::numeric   / nullif(sum(r.production_time),   0) * 100, 3),
  round(sum(r.net_time)::numeric         / nullif(sum(r.operating_time),    0) * 100, 3),
  round(sum(r.value_added_time)::numeric / nullif(sum(r.net_time),          0) * 100, 3),

  -- NULL with their units. ck_*_units requires the pairing, and a count with no
  -- unit is a wrong number with a missing label.
  --
  -- SIX NOW, NOT FIVE: `line_out` (migration 0015) is the line's own measured
  -- production on the INFEED side, so it is nulled with total_out/reject/rework
  -- and by the same guard. It is the one count this seed could most plausibly
  -- fake — sum(total_out) is right there — and faking it would be exactly the
  -- error point 2 above is about: a confident number under a unit nobody
  -- established.
  NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,

  sum(r.runtime), sum(r.availability_time), sum(r.production_time), sum(r.pdt_time),
  sum(r.operating_time), sum(r.updt_time), sum(r.net_time), sum(r.reduce_speed_time),
  sum(r.ms_time), sum(r.value_added_time), sum(r.rework_time), sum(r.reject_time),
  sum(r.anomaly_time), sum(r.up_speed_time),
  sum(r.schedule_loss_time), sum(r.availability_loss_time), sum(r.performance_loss_time),
  sum(r.ms_loss_time), sum(r.reduce_speed_loss_time), sum(r.quality_loss_time),

  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.updt_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END,
  CASE WHEN sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END) > 0
       THEN (sum(r.operating_time)
             / sum(CASE WHEN r.mttr > 0 THEN r.updt_time::numeric / r.mttr ELSE 0 END))::bigint
  END
FROM oee.work_center_day_reports r
GROUP BY r.work_center_id, date_trunc('month', r.business_date)
ON CONFLICT (business_date, work_center_id) DO UPDATE SET
  time_zone = excluded.time_zone,
  work_center_name = excluded.work_center_name, work_center_code = excluded.work_center_code,
  area_id = excluded.area_id, area_name = excluded.area_name, month = excluded.month,
  work_unit_count = excluded.work_unit_count,
  expected_work_unit_count = excluded.expected_work_unit_count,
  infeed_uom_id = excluded.infeed_uom_id, infeed_uom_name = excluded.infeed_uom_name,
  infeed_uom_code = excluded.infeed_uom_code,
  output_uom_id = excluded.output_uom_id, output_uom_name = excluded.output_uom_name,
  output_uom_code = excluded.output_uom_code,
  teep = excluded.teep, oee = excluded.oee, availability = excluded.availability,
  performance = excluded.performance, quality = excluded.quality,
  total_out = excluded.total_out, good_out = excluded.good_out,
  effective_out = excluded.effective_out, reject = excluded.reject, rework = excluded.rework,
  line_out = excluded.line_out,
  runtime = excluded.runtime, availability_time = excluded.availability_time,
  production_time = excluded.production_time, pdt_time = excluded.pdt_time,
  operating_time = excluded.operating_time, updt_time = excluded.updt_time,
  net_time = excluded.net_time, reduce_speed_time = excluded.reduce_speed_time,
  ms_time = excluded.ms_time, value_added_time = excluded.value_added_time,
  rework_time = excluded.rework_time, reject_time = excluded.reject_time,
  anomaly_time = excluded.anomaly_time, up_speed_time = excluded.up_speed_time,
  schedule_loss_time = excluded.schedule_loss_time,
  availability_loss_time = excluded.availability_loss_time,
  performance_loss_time = excluded.performance_loss_time,
  ms_loss_time = excluded.ms_loss_time,
  reduce_speed_loss_time = excluded.reduce_speed_loss_time,
  quality_loss_time = excluded.quality_loss_time,
  mttr = excluded.mttr, mtbf = excluded.mtbf;

-- ---------------------------------------------------------------------------
-- Step 4 — assertions
-- ---------------------------------------------------------------------------
--
-- RAISE EXCEPTION, not comments. These are the invariants §16.8 asks the pipeline
-- to assert as dbt tests, asserted here too — so this file cannot silently drift
-- from the specification it claims to be.

DO $$
DECLARE
  bad bigint;
BEGIN
  -- 1. A SELF-CHECK OF STEP 1, NOT A GOLD INVARIANT. It asserts this file did
  --    what it says it does. The real pipeline will NOT satisfy it, because a
  --    line is measured rather than summed — see the header and §16.8, which
  --    deliberately does not ask for this one.
  SELECT count(*) INTO bad
    FROM oee.work_center_shift_reports l
    JOIN (
      SELECT work_center_id, business_date, shift,
             sum(runtime) AS runtime, sum(availability_time) AS availability_time
        FROM oee.work_unit_shift_reports
       WHERE business_date IS NOT NULL AND work_center_id IS NOT NULL
       GROUP BY 1, 2, 3
    ) m USING (work_center_id, business_date, shift)
   WHERE l.runtime <> m.runtime OR l.availability_time <> m.availability_time;
  IF bad > 0 THEN
    RAISE EXCEPTION 'step 1 did not sum the machines it claims to, on % row(s)', bad;
  END IF;

  -- 2. A REAL INVARIANT, true of this file and of the pipeline both: a line's day
  --    is the sum of its own shifts. This is the dbt test §16.8 asks for.
  SELECT count(*) INTO bad
    FROM oee.work_center_day_reports d
    JOIN (
      SELECT work_center_id, business_date,
             sum(runtime) AS runtime, sum(availability_time) AS availability_time
        FROM oee.work_center_shift_reports
       GROUP BY 1, 2
    ) s USING (work_center_id, business_date)
   WHERE d.runtime <> s.runtime OR d.availability_time <> s.availability_time;
  IF bad > 0 THEN
    RAISE EXCEPTION 'line day roll-up disagrees with its shifts on % row(s)', bad;
  END IF;

  -- 3. A line's month equals the sum of its days.
  SELECT count(*) INTO bad
    FROM oee.work_center_month_reports mo
    JOIN (
      SELECT work_center_id, date_trunc('month', business_date)::date AS business_date,
             sum(runtime) AS runtime, sum(availability_time) AS availability_time
        FROM oee.work_center_day_reports
       GROUP BY 1, 2
    ) d USING (work_center_id, business_date)
   WHERE mo.runtime <> d.runtime OR mo.availability_time <> d.availability_time;
  IF bad > 0 THEN
    RAISE EXCEPTION 'line month roll-up disagrees with its days on % row(s)', bad;
  END IF;

  -- 4. The waterfall identities, on every derived row of all three tables.
  --    apps/web/src/lib/waterfall.ts reads each bar as "the previous bar's base
  --    with this step's losses stacked on top" and does NOT back-compute a band,
  --    so a row whose parts do not add up renders as a ragged chart rather than
  --    being papered over.
  SELECT count(*) INTO bad FROM (
    SELECT production_time, pdt_time, availability_time, operating_time, updt_time,
           net_time, ms_time, reduce_speed_time, value_added_time, reject_time, rework_time
      FROM oee.work_center_shift_reports
    UNION ALL SELECT production_time, pdt_time, availability_time, operating_time, updt_time,
           net_time, ms_time, reduce_speed_time, value_added_time, reject_time, rework_time
      FROM oee.work_center_day_reports
    UNION ALL SELECT production_time, pdt_time, availability_time, operating_time, updt_time,
           net_time, ms_time, reduce_speed_time, value_added_time, reject_time, rework_time
      FROM oee.work_center_month_reports
  ) w
   WHERE production_time + pdt_time <> availability_time
      OR operating_time + updt_time <> production_time
      OR net_time + ms_time + reduce_speed_time <> operating_time
      OR value_added_time + reject_time + rework_time <> net_time;
  IF bad > 0 THEN
    RAISE EXCEPTION 'the waterfall identities do not hold on % line row(s)', bad;
  END IF;

  RAISE NOTICE 'seed assertions passed: step 1 summed its machines (a STAND-IN, not a Gold invariant), day = sum(line shifts), month = sum(days), waterfall identities hold.';
END
$$;

SELECT 'work_center_shift_reports' AS table_name, count(*) AS rows FROM oee.work_center_shift_reports
UNION ALL SELECT 'work_center_day_reports',   count(*) FROM oee.work_center_day_reports
UNION ALL SELECT 'work_center_month_reports', count(*) FROM oee.work_center_month_reports;
