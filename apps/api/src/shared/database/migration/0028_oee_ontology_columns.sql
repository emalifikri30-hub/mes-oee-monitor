-- ---------------------------------------------------------------------------
-- 0028 — ONE ONTOLOGY: enterprise → site → area → work center → work unit
-- ---------------------------------------------------------------------------
--
-- Every Gold report table, and every fact table a report screen reads, now
-- carries the FULL ANCESTOR CHAIN of its own grain as denormalised labels. The
-- chain is `mes-master-data`'s, verbatim — `ms_core.enterprices` (sic, the
-- upstream spelling), `ms_core.sites`, `ms_core.areas`, `ms_core.work_centers`,
-- `ms_core.work_units` — so a reader of Gold and a reader of master data are
-- naming the same five levels.
--
-- ---------------------------------------------------------------------------
-- WHY: A HEADER FILTER IS A PREDICATE, AND A PREDICATE NEEDS A COLUMN
-- ---------------------------------------------------------------------------
--
-- The web app's header area picker has, until now, been a way of deciding which
-- LINES a report page may OFFER — `apps/web/src/hooks/use-work-center-filter.ts`
-- says so in as many words: "it never filters a request on its own". It does
-- now. Every report list — machine, line, SKU and area — is scoped to the
-- selected area on first paint, which means `area_id` has to be a column on the
-- table each list reads. Four of the eleven list-backing tables had it; the rest
-- reached an area only by resolving the hierarchy through an upstream HTTP call,
-- which is the FATAL dependency TODOS §55 wants off the hottest page in the app.
--
-- Adding only `area_id` would have answered the requirement and left the schema
-- lopsided, which is why this goes to the top of the chain in one migration
-- rather than one level per screen. Contract §28 is the pipeline's ask.
--
-- ---------------------------------------------------------------------------
-- THE RENAME: `factory_*` WAS ALWAYS `site_*`, AND THIS SAYS SO
-- ---------------------------------------------------------------------------
--
-- `0006`, `0018`, `0024`, `0025` and `0027` put `factory_id` / `factory_name` on
-- five tables, meaning "the level above the area". **There is no `factory` in
-- `mes-master-data`.** The level above an area is a SITE (`ms_core.areas.site_id`
-- → `ms_core.sites`), and above that an ENTERPRISE. `factory` was a local name
-- for a level that already had one upstream, and it has been quietly propagating
-- — into `DowntimeScope`, into `subject.ts`, into the web's `factoryId` — for two
-- months.
--
-- Column names are a PUBLIC INTERFACE (§23.3): an external analyst pointing BI
-- tooling at these tables has no source file to read, so a column named for a
-- level that does not exist in the master data they join against is worse than a
-- clumsy one. This is therefore a RENAME rather than a second column beside it.
-- Two names for one level is how a stranger ends up grouping by both and halving
-- every figure.
--
-- IT IS SAFE FOR EXACTLY ONE REASON AND THE REASON WILL EXPIRE. Every `factory_*`
-- column is NULL on every row today — nothing upstream resolves the level above
-- an area (`0024`'s own comment: "NOT filled, anywhere") and no dbt model writes
-- it. TODOS §71 is the precedent and the rule it set: a destructive change on the
-- empty development database is cheap and this is the right time to make it. It
-- is the same licence `0013` used to correct `availablity_loss_time`, and the
-- same one that will NOT be available once the pipeline starts writing.
--
-- ---------------------------------------------------------------------------
-- WHAT A NULL MEANS HERE — AND IT IS THE `0024` MEANING, NOT THE `0020` ONE
-- ---------------------------------------------------------------------------
--
-- NULL means "the pipeline has not resolved this label yet". It does NOT mean
-- "this row has no site", and it is not an attribution gap.
--
-- That distinction is TODOS §78's and it decides the whole read strategy. The
-- hierarchy axis is CONTAINMENT: a work unit is inside a work center is inside
-- an area is inside a site is inside an enterprise, permanently, so every one of
-- these columns is DERIVABLE from `work_unit_id` and a NULL is a missing LABEL.
-- The fix for a sparse column is a BACKFILL upstream. Contrast `0020`'s
-- `product_id`, which is OCCUPANCY OVER TIME: nothing can derive which SKU was
-- running during a stop, so that one ships an `unattributed` count beside every
-- read and this one deliberately does not.
--
-- The visible consequence, stated because it is invisible in the data: **a row
-- with a NULL `area_id` is silently EXCLUDED from that area's lists.** Every
-- report list is area-scoped now, so an un-backfilled row does not appear
-- anywhere in the app. `apps/api/scripts/seed/0028_ontology_backfill_dev.sql`
-- closes that for development; §28.4 asks the pipeline to close it for real.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT TOUCHED, AND WHY EACH ABSENCE IS A DECISION
-- ---------------------------------------------------------------------------
--
--   oee.work_unit_shift_report_approvals        an append-only AUDIT TRAIL, addressed
--   oee.work_unit_shift_report_approval_events  by its natural key and never scanned by
--   oee.downtime_report_history                 area. A denormalised label there is a
--                                               second place for the hierarchy to drift
--                                               with no read that would ever notice.
--
--   oee.write_audit        `current_user` plus an application name; carries no grain at all.
--   oee.etl_watermarks     one row per dbt model.
--   oee.work_unit_perf_analytics   pending the DROP in TODOS §22.
--
-- ---------------------------------------------------------------------------
-- `ADD COLUMN IF NOT EXISTS` throughout, unlike `0014`/`0023`/`0027`'s plain
-- `CREATE TABLE`. Those create tables that exist nowhere, so a silent no-op would
-- hide a drifted schema. This one adds a column to twenty-three tables across six
-- migrations' worth of history, several of which were themselves applied against
-- an already-populated database — re-runnability is worth more here than the
-- drift check, and `0015`'s `ADD COLUMN IF NOT EXISTS` is the precedent.
--
-- The RENAMEs below are the exception: `ALTER TABLE ... RENAME COLUMN` has no
-- `IF EXISTS` form for the column, so each is guarded by a `DO` block that skips
-- when the new name is already in place. A bare RENAME would make this file
-- un-re-runnable, which is the property the rest of it has.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PART A — `factory_*` becomes `site_*` on the five tables that had it
-- ===========================================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'product_perf_wu_hour',   -- 0006
    'product_perf_wc_hour',   -- 0018
    'area_day_reports',       -- 0024
    'area_month_reports',     -- 0025
    'area_year_reports'       -- 0027
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'oee' AND table_name = t AND column_name = 'factory_id'
    ) THEN
      EXECUTE format('ALTER TABLE oee.%I RENAME COLUMN factory_id TO site_id', t);
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'oee' AND table_name = t AND column_name = 'factory_name'
    ) THEN
      EXECUTE format('ALTER TABLE oee.%I RENAME COLUMN factory_name TO site_name', t);
    END IF;
  END LOOP;
END
$$;


-- ===========================================================================
-- PART B — the ancestor chain, one table at a time
-- ===========================================================================
--
-- Grouped by SUBJECT rather than by level, so each block reads as "what this
-- grain was missing". The `--` after each table names what it already had.

-- ---------------------------------------------------------------------------
-- The MACHINE grain — four report tables, and none of them reached past the line
-- ---------------------------------------------------------------------------
--
-- `work_center_id` has been on the shift table since `0003` and on day/month
-- since `0013`; `0027` carried it onto the year table. Everything above the line
-- was resolved per request through mes-master-data, which is what made the area
-- filter an HTTP call rather than a predicate.

ALTER TABLE oee.work_unit_shift_reports                   -- had: work_unit_*, work_center_*
  ADD COLUMN IF NOT EXISTS area_id         integer,
  ADD COLUMN IF NOT EXISTS area_name       varchar(255),
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.work_unit_day_reports                     -- had: work_unit_*, work_center_*
  ADD COLUMN IF NOT EXISTS area_id         integer,
  ADD COLUMN IF NOT EXISTS area_name       varchar(255),
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.work_unit_month_reports                   -- had: work_unit_*, work_center_*
  ADD COLUMN IF NOT EXISTS area_id         integer,
  ADD COLUMN IF NOT EXISTS area_name       varchar(255),
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.work_unit_year_reports                    -- had: work_unit_*, work_center_*
  ADD COLUMN IF NOT EXISTS area_id         integer,
  ADD COLUMN IF NOT EXISTS area_name       varchar(255),
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

-- ---------------------------------------------------------------------------
-- The LINE grain — four report tables, all of which stopped at the area
-- ---------------------------------------------------------------------------

ALTER TABLE oee.work_center_shift_reports                 -- had: work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.work_center_day_reports                   -- had: work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.work_center_month_reports                 -- had: work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.work_center_year_reports                  -- had: work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

-- ---------------------------------------------------------------------------
-- The SKU grain — one table (`0023`), one grain, no shift or month sibling
-- ---------------------------------------------------------------------------

ALTER TABLE oee.product_report_wc_day                     -- had: work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

-- ---------------------------------------------------------------------------
-- The AREA grain — three report tables; `site_*` arrived by rename in PART A
-- ---------------------------------------------------------------------------

ALTER TABLE oee.area_day_reports                          -- had: area_*, site_* (was factory_*)
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.area_month_reports                        -- had: area_*, site_* (was factory_*)
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.area_year_reports                         -- had: area_*, site_* (was factory_*)
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

-- ---------------------------------------------------------------------------
-- DOWNTIME — the two tables `SCOPE_COLUMN` reads
-- ---------------------------------------------------------------------------
--
-- `oee.downtime_reports` gaining `site_id` is what TODOS §74 has been blocked on:
-- "`factory` is the last unmapped `SCOPE_COLUMN` member, and unlike `area` it
-- genuinely cannot be mapped: `oee.downtime_reports` has no `factory_id`." It has
-- one now, under the name the ontology uses, so the scope becomes `site` and maps
-- like the other three. `oee.downtime_log_events` carries the same chain from the
-- same upstream because `0024`'s dev backfill uses the two as a CROSS-CHECK: if
-- they disagree about a line's area, that seed refuses rather than picking one,
-- and that check is only worth having while both tables carry the same columns.
--
-- A `factory_id` for a factory REPORT is still absent, and is a different
-- question: there is no `oee.factory_*` table at any grain (TODOS §74, §81). What
-- this closes is the SCOPE half only.

ALTER TABLE oee.downtime_reports                          -- had: work_unit_*, work_center_*, area_* (0007)
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.downtime_log_events                       -- had: work_unit_*, work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

-- ---------------------------------------------------------------------------
-- The COUNT tables — `0003`'s machine pair and `0016`'s line pair
-- ---------------------------------------------------------------------------
--
-- The machine pair is the widest gap in the schema: `0003` gave it `work_unit_*`
-- and nothing above. `work_center_code` is included here because its line-grain
-- sibling (`0016`) carries one, and a pair of tables that answer the same question
-- at two grains should not disagree about which labels a row carries.

ALTER TABLE oee.product_count_wu_shift                    -- had: work_unit_* only
  ADD COLUMN IF NOT EXISTS work_center_id   integer,
  ADD COLUMN IF NOT EXISTS work_center_name varchar(255),
  ADD COLUMN IF NOT EXISTS work_center_code varchar(255),
  ADD COLUMN IF NOT EXISTS area_id          integer,
  ADD COLUMN IF NOT EXISTS area_name        varchar(255),
  ADD COLUMN IF NOT EXISTS site_id          integer,
  ADD COLUMN IF NOT EXISTS site_name        varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id    integer,
  ADD COLUMN IF NOT EXISTS enterprise_name  varchar(255);

ALTER TABLE oee.product_count_wu_day                      -- had: work_unit_* only
  ADD COLUMN IF NOT EXISTS work_center_id   integer,
  ADD COLUMN IF NOT EXISTS work_center_name varchar(255),
  ADD COLUMN IF NOT EXISTS work_center_code varchar(255),
  ADD COLUMN IF NOT EXISTS area_id          integer,
  ADD COLUMN IF NOT EXISTS area_name        varchar(255),
  ADD COLUMN IF NOT EXISTS site_id          integer,
  ADD COLUMN IF NOT EXISTS site_name        varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id    integer,
  ADD COLUMN IF NOT EXISTS enterprise_name  varchar(255);

ALTER TABLE oee.product_count_wc_shift                    -- had: work_center_*
  ADD COLUMN IF NOT EXISTS area_id          integer,
  ADD COLUMN IF NOT EXISTS area_name        varchar(255),
  ADD COLUMN IF NOT EXISTS site_id          integer,
  ADD COLUMN IF NOT EXISTS site_name        varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id    integer,
  ADD COLUMN IF NOT EXISTS enterprise_name  varchar(255);

ALTER TABLE oee.product_count_wc_day                      -- had: work_center_*
  ADD COLUMN IF NOT EXISTS area_id          integer,
  ADD COLUMN IF NOT EXISTS area_name        varchar(255),
  ADD COLUMN IF NOT EXISTS site_id          integer,
  ADD COLUMN IF NOT EXISTS site_name        varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id    integer,
  ADD COLUMN IF NOT EXISTS enterprise_name  varchar(255);

-- ---------------------------------------------------------------------------
-- The REJECT tables — `0008`'s machine one and `0019`'s line one
-- ---------------------------------------------------------------------------
--
-- `reject_count_wu_shift.work_center_id` is what TODOS §32 calls "a nullable
-- denormalised label" — `0008` says so explicitly. It stays nullable and it gains
-- the `work_center_code` its line sibling has, for the same reason the count pair
-- above does.

ALTER TABLE oee.reject_count_wu_shift                     -- had: work_unit_*, work_center_id/name
  ADD COLUMN IF NOT EXISTS work_center_code varchar(255),
  ADD COLUMN IF NOT EXISTS area_id          integer,
  ADD COLUMN IF NOT EXISTS area_name        varchar(255),
  ADD COLUMN IF NOT EXISTS site_id          integer,
  ADD COLUMN IF NOT EXISTS site_name        varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id    integer,
  ADD COLUMN IF NOT EXISTS enterprise_name  varchar(255);

ALTER TABLE oee.reject_count_wc_shift                     -- had: work_center_*, area_*
  ADD COLUMN IF NOT EXISTS site_id          integer,
  ADD COLUMN IF NOT EXISTS site_name        varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id    integer,
  ADD COLUMN IF NOT EXISTS enterprise_name  varchar(255);

-- ---------------------------------------------------------------------------
-- The HOURLY tables — `0006`'s machine one and `0018`'s line one
-- ---------------------------------------------------------------------------
--
-- These two already reached the level above the area; PART A renamed it. Only the
-- enterprise is new.

ALTER TABLE oee.product_perf_wu_hour                      -- had: work_unit_*, work_center_*, area_*, site_*
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

ALTER TABLE oee.product_perf_wc_hour                      -- had: work_center_*, area_*, site_*
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);

-- ---------------------------------------------------------------------------
-- The OPERATOR LEDGER — the one table in this file THIS SERVICE writes
-- ---------------------------------------------------------------------------
--
-- `oee.work_center_quality_entries` (`0017`) is append-only-with-a-void, written
-- by the operator and only READ by the pipeline (contract §18). Everything else in
-- PART B is the reverse, and the difference is load-bearing: these columns are
-- filled by OUR write path, not by dbt, so a NULL here is our bug rather than
-- denormalisation lag.
--
-- This closes TODOS §79, which asked for exactly `area_id` and called it "the
-- cheap fix": `AreaReportService.getActivity` fans out one `listActivityForTarget`
-- per line because the table carries no area. The column is here; the fan-out is
-- a separate change and §79 records which half is done.

ALTER TABLE oee.work_center_quality_entries               -- had: work_center_id, work_unit_id/name
  ADD COLUMN IF NOT EXISTS area_id         integer,
  ADD COLUMN IF NOT EXISTS area_name       varchar(255),
  ADD COLUMN IF NOT EXISTS site_id         integer,
  ADD COLUMN IF NOT EXISTS site_name       varchar(255),
  ADD COLUMN IF NOT EXISTS enterprise_id   integer,
  ADD COLUMN IF NOT EXISTS enterprise_name varchar(255);


-- ===========================================================================
-- PART C — the column comments
-- ===========================================================================
--
-- A LOOP RATHER THAN ~130 EXPLICIT `COMMENT ON COLUMN` STATEMENTS, which is a
-- departure from every earlier migration in this directory and is deliberate.
-- Those comment individual columns whose meaning is particular to one table —
-- `0014`'s two-unit rule, `0024`'s LINE-millisecond durations. These columns mean
-- the SAME THING on all twenty-three tables, and the failure to avoid is two of
-- them drifting apart: an analyst who reads `area_id`'s comment on one table and
-- finds a different one elsewhere learns nothing they can rely on.
--
-- Gold is meant to be read by people outside this application (§23.3), so the
-- meaning has to live in the catalogue and not in this file's header.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'oee'
       AND c.column_name IN (
             'enterprise_id', 'enterprise_name',
             'site_id',       'site_name',
             'area_id',       'area_name'
           )
  LOOP
    EXECUTE format(
      'COMMENT ON COLUMN oee.%I.%I IS %L',
      rec.table_name,
      rec.column_name,
      CASE rec.column_name
        WHEN 'enterprise_id' THEN
          'ms_core.enterprices.id — the top of the hierarchy. Denormalised by the pipeline. NULL means NOT YET RESOLVED, never "no enterprise": containment makes it derivable from work_unit_id, so a NULL is a missing label and the fix is a backfill (contract §28.4). A row with a NULL is silently excluded from any read that filters on this level.'
        WHEN 'enterprise_name' THEN
          'ms_core.enterprices.name at the time the row was written. Display only — join on enterprise_id, never on this.'
        WHEN 'site_id' THEN
          'ms_core.sites.id — the level above the area. RENAMED FROM factory_id by 0028: there is no "factory" in mes-master-data, and a column named for a level the master data does not have is not joinable by an outside reader. NULL means NOT YET RESOLVED (see enterprise_id).'
        WHEN 'site_name' THEN
          'ms_core.sites.name at the time the row was written. RENAMED FROM factory_name by 0028. Display only — join on site_id, never on this.'
        WHEN 'area_id' THEN
          'ms_core.areas.id. Every report list in the application is scoped to one area, so this is a hot predicate and not only a label. NULL means NOT YET RESOLVED (see enterprise_id) — and because the scoping is unconditional, a row with a NULL here appears on NO screen at all.'
        WHEN 'area_name' THEN
          'ms_core.areas.name at the time the row was written. Display only — join on area_id, never on this.'
      END
    );
  END LOOP;
END
$$;


-- ===========================================================================
-- PART D — one index per list-backing table
-- ===========================================================================
--
-- `area_id` is now in the WHERE clause of every report list, so each of these
-- tables gets an index on it. COMPOSITE, leading with `area_id`, because no list
-- filters by area alone — the machine and line lists always pair it with a period
-- predicate, and a bare `area_id` index on a plant with four areas selects a
-- quarter of the table and is not worth planning around.
--
-- Plain `CREATE INDEX IF NOT EXISTS`, NOT `CONCURRENTLY`: `scripts/migrate.mjs`
-- runs each file inside `sql.begin()` together with its bookkeeping INSERT, and
-- `CREATE INDEX CONCURRENTLY` is illegal inside a transaction. `0013` and `0026`
-- both record this, and `0026` records the consequence — these take a brief
-- ACCESS EXCLUSIVE lock, which is acceptable on tables this size and would not be
-- on a populated production one.
--
-- The four tables NOT here already lead with `area_id` in a key `0024`/`0025`/
-- `0027` created (`area_*_reports`), or are never listed by area (the count,
-- reject, hourly and ledger tables are all reached through a report id).

CREATE INDEX IF NOT EXISTS wu_shift_report_area_date_idx
  ON oee.work_unit_shift_reports (area_id, date DESC);

CREATE INDEX IF NOT EXISTS wu_day_report_area_date_idx
  ON oee.work_unit_day_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS wu_month_report_area_date_idx
  ON oee.work_unit_month_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS wu_year_report_area_date_idx
  ON oee.work_unit_year_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS wc_shift_report_area_date_idx
  ON oee.work_center_shift_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS wc_day_report_area_date_idx
  ON oee.work_center_day_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS wc_month_report_area_date_idx
  ON oee.work_center_month_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS wc_year_report_area_date_idx
  ON oee.work_center_year_reports (area_id, business_date DESC);

CREATE INDEX IF NOT EXISTS prwcd_ix_area_date
  ON oee.product_report_wc_day (area_id, business_date DESC);

-- The downtime reads are scoped by `SCOPE_COLUMN`, which now maps four levels.
-- `dt_reports_span_gist` (`0013`) already leads with the two narrow scopes; this
-- is the area equivalent and it pairs with `business_date` because `0021` made
-- that the column every downtime read windows on.
CREATE INDEX IF NOT EXISTS dt_reports_area_business_date_idx
  ON oee.downtime_reports (area_id, business_date);

CREATE INDEX IF NOT EXISTS dt_reports_site_business_date_idx
  ON oee.downtime_reports (site_id, business_date);
