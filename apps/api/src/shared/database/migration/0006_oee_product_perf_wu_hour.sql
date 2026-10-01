-- Hourly per-SKU throughput and rate, replacing `oee.work_unit_perf_analytics`.
--
-- WHY THIS FILE EXISTS
--
-- The Losses card's "View" drill-down on the work-unit shift report plots, for
-- one shift, per hour and per product: actual production, effective production,
-- the actual rate (which the UI labels "Cycle Time" — it is a RATE in qty/hour,
-- and the label is kept for continuity with the operators' vocabulary), the
-- master standard rate, and how long the machine actually ran in that hour.
--
-- The same chart is wanted on the day and month reports, still on hourly data.
-- That is why the grain, the calendar columns and the additivity rules below
-- are what they are: a month of hourly rows is ~720 points, so the readable
-- month view is an hour-of-day PROFILE (`GROUP BY hour_of_day`), and a profile
-- is only correct if the ratios are recomputed from summed components.
--
-- `oee.work_unit_perf_analytics` cannot serve any of that and is dropped at the
-- foot of this file. Five independent reasons:
--
--   * its grain is an ARBITRARY start_time..end_time interval, so nothing in
--     the schema forbids two rows overlapping and no aggregate over it is safe;
--   * it has no natural key, so a DAG retry, a DLQ replay or a backfill
--     silently inserts every row a second time — the second half of TODOS.md
--     §19 and of docs/gold-write-contract.md §2.1;
--   * it carries no business day and no shift, so "one shift of one work unit"
--     is not expressible without resolving the plant's zone first, which is the
--     bug class TODOS.md §17 exists to end;
--   * its measures are numeric(10,3) — narrower than the numeric(15,3) every
--     sibling table uses for the SAME quantities;
--   * it has no work_center_id, so no question above the work unit can be asked
--     without joining a service in another database.
--
-- NOT A UI TABLE
--
-- The modal is the first consumer, not the design brief. The dimensions and
-- measures below are chosen so that pointing Power BI, Snowflake or ClickHouse
-- at this table yields correct answers to questions nobody has asked yet. That
-- is also why every ratio is DERIVED from stored additive components, and why
-- this file is the first in the schema to carry COMMENT ON statements: the
-- explanatory headers in 0003-0005 are invisible to a BI tool's schema browser,
-- and the additivity rules are exactly what an analyst will get wrong first.
--
-- BUCKETS ARE LOCAL WALL-CLOCK HOURS, NOT UTC HOURS
--
-- Shifts start at 07:00 / 15:00 / 23:00 PLANT-LOCAL (SHIFT_WINDOWS in
-- apps/api/src/module/downtime/downtime.ts). An hour bucket cut on the local
-- clock therefore nests exactly inside a shift: 8 buckets per shift, 24 per
-- business day, no bucket straddling a boundary. A bucket cut on the UTC clock
-- does NOT nest for any plant whose offset is not a whole number of hours
-- (Asia/Kolkata +05:30, Asia/Kathmandu +05:45) — there every bucket straddles a
-- shift boundary by 30 or 45 minutes and every shift total is quietly wrong at
-- both ends. At Asia/Jakarta (+07:00) the two are INDISTINGUISHABLE, which is
-- precisely why this has to be stated rather than discovered. Same failure
-- family as the America/Chicago table in TODOS.md §17.
--
-- `time_zone` is denormalised onto every row so the rule is auditable from the
-- data rather than from a DAG's source.
--
-- BUSINESS DAY, NOT CALENDAR DAY
--
-- `business_date` is the SHIFT's business day, matching
-- product_count_wu_shift.shift_date. Shift 3 crosses midnight, so its buckets
-- at 00:00-07:00 local carry the PREVIOUS calendar date. The calendar date is
-- deliberately NOT a second column: two date columns, one of which is right, is
-- how the shift-3 product-count bug happened. Derive it when you want it:
--   (bucket_start AT TIME ZONE time_zone)::date
--
-- No foreign keys, for the same reason as 0003: work_unit_id, work_center_id,
-- product_id and uom_id all reference mes-master-data, a different service and
-- a different database. Names and codes are denormalised onto the row so this
-- read needs no mes-master-data call at all — including, and this is the new
-- ask, the MASTER RATE itself (docs/gold-write-contract.md §3.5).
--
-- IDEMPOTENT, like 0003-0005: GOLD_DATABASE_URL points at a populated database.
-- migrate.mjs runs this whole file in ONE transaction with its schema_migrations
-- row, so the CREATE, the watermark CHECK swap and the DROP land together or not
-- at all.
--
-- FORWARD-ONLY. migrate.mjs has no down path, so the DROP at the foot of this
-- file is irreversible through the runner. It is safe today — the table has no
-- reader in this repo and the whole Gold schema held 8 hand-seeded rows on
-- 2026-08-13 — but the `work_unit_*` DAG has no repository (TODOS.md §18), so
-- it cannot be confirmed by grep that no dbt model writes it. Confirm with the
-- DAG owner before deploying.

-- ---------------------------------------------------------------------------
-- oee.product_perf_wu_hour — per-SKU throughput and rate, one local hour
-- ---------------------------------------------------------------------------
--
-- Name obeys the grammar the schema already has: <subject>_<scope>_<grain>,
-- as in product_count_wu_shift and product_count_wu_day.
CREATE TABLE IF NOT EXISTS oee.product_perf_wu_hour (
  -- ---- grain --------------------------------------------------------------
  -- An INSTANT, not a local timestamp. On a DST fall-back day the local hour
  -- 01:00 happens twice, and those are two legitimate, distinct buckets that
  -- must not collide on the key.
  bucket_start          timestamp with time zone NOT NULL,
  bucket_end            timestamp with time zone NOT NULL,
  work_unit_id          integer                  NOT NULL,
  product_id            integer                  NOT NULL,

  -- ---- business calendar, written by the pipeline -------------------------
  -- The SHIFT's business day. Authoritative for every daily and monthly rollup.
  business_date         date                     NOT NULL,
  shift                 smallint                 NOT NULL,
  -- Local clock hour, 0-23. The GROUP BY key for an hour-of-day profile over a
  -- day or a month. A LABEL, never a key: it repeats on a fall-back day and it
  -- sorts wrong for shift 3 (23, 0, 1 ... 6).
  hour_of_day           smallint                 NOT NULL,
  -- 0-based position of the bucket within its shift. Normally 0-7; 0-8 on a DST
  -- fall-back day, 0-6 on a spring-forward day.
  shift_hour_seq        smallint                 NOT NULL,
  -- IANA zone the buckets were cut in. Self-describing rows, and the audit
  -- trail for the local-clock rule in this file's header.
  time_zone             varchar(64)              NOT NULL,

  -- ---- dimensions, denormalised -------------------------------------------
  work_unit_name        varchar(255)             NOT NULL,
  work_unit_code        varchar(255)             NOT NULL,
  work_center_id        integer                  NOT NULL,
  work_center_name      varchar(255)             NOT NULL,
  work_center_code      varchar(255)             NOT NULL,
  -- Nullable, unlike the work-center columns: the hierarchy above the work
  -- center is not reliably populated for every plant today, and NOT NULL here
  -- would block a first load over data this table does not itself need. Carried
  -- anyway because it is free on an empty table and expensive later — this is
  -- the same omission that makes `scope=area|factory` answer 400 on the
  -- downtime timeline (docs/gold-write-contract.md §3.2, TODOS.md §9).
  area_id               integer,
  area_name             varchar(255),
  factory_id            integer,
  factory_name          varchar(255),
  product_name          varchar(255)             NOT NULL,
  product_code          varchar(255)             NOT NULL,
  uom_id                integer                  NOT NULL,
  uom_name              varchar(255)             NOT NULL,
  uom_code              varchar(255)             NOT NULL,
  base_uom_id           integer                  NOT NULL,
  base_uom_name         varchar(255)             NOT NULL,
  base_uom_code         varchar(255)             NOT NULL,
  -- Same semantics and same caveat as product_count_wu_shift: converts
  -- total_out / reject / rework to the base unit, and good_out is deliberately
  -- NOT scaled. §3.4's per-(product, uom, base_uom) consistency guarantee
  -- applies to this table too.
  factor_to_base        numeric(10,3)            NOT NULL,

  -- ---- additive measures — the source of truth ----------------------------
  -- numeric(15,3), matching the report tables. work_unit_perf_analytics used
  -- numeric(10,3) for the same quantities; that was a defect, not a choice.
  total_out             numeric(15,3)            NOT NULL,  -- Actual Production
  good_out              numeric(15,3)            NOT NULL,
  effective_out         numeric(15,3)            NOT NULL,  -- Effective Production
  reject                numeric(15,3)            NOT NULL,
  rework                numeric(15,3)            NOT NULL,
  -- MILLISECONDS, like work_unit_shift_reports.runtime and formatDuration() in
  -- apps/web/src/lib/format.ts. The modal's "47 m 24 s". Per PRODUCT: two
  -- products sharing a bucket each carry their own, and the two sum to at most
  -- one hour.
  runtime               bigint                   NOT NULL,

  -- ---- the master rate, denormalised from mes-master-data ------------------
  -- The standard/ideal rate in `uom_id` per hour. NULLABLE ON PURPOSE: a
  -- product with no effective standard is a real and recurring condition, and
  -- both alternatives are worse — dropping the row loses production that did
  -- happen, and 0 makes every derived attainment ratio infinite. NULL means
  -- "no standard known". Never COALESCE it, and never substitute the actual
  -- rate, which would make the loss vanish.
  ideal_rate_per_hour   numeric(15,6),
  -- Provenance, because a wrong-but-plausible standard is unfalsifiable
  -- downstream. 'master-data' is the real thing; the others exist so a fallback
  -- is visible in the data instead of silent.
  ideal_rate_source     varchar(32),
  -- Effective-from date of the master record that supplied the rate, so a
  -- standard changing mid-month is explicable rather than mysterious.
  ideal_rate_valid_from date,

  -- ---- derived measures — GENERATED so they cannot drift -------------------
  -- downtime_reports.duration is written independently of start_at/end_at and
  -- can disagree with them (§3.3). That mistake is not repeated here: both
  -- ratios below are computed by the database and are not writable.
  --
  -- NULL rather than a division error when the machine did not run. A bucket
  -- with runtime = 0 has no meaningful rate; it does not have a rate of 0.
  actual_rate_per_hour  numeric(15,6)
    GENERATED ALWAYS AS (
      CASE WHEN runtime > 0
           THEN round(total_out * 3600000::numeric / runtime::numeric, 6)
      END
    ) STORED,
  -- THE load-bearing column. It turns the non-additive master RATE into an
  -- additive QUANTITY: what the standard says should have been produced in the
  -- time the machine actually ran. sum(ideal_out) is correct at any grain;
  -- avg(ideal_rate_per_hour) is not. NULL propagates when the standard is
  -- unknown, which is correct — an unknown target must not contribute 0.
  ideal_out             numeric(15,3)
    GENERATED ALWAYS AS (
      round(ideal_rate_per_hour * runtime::numeric / 3600000::numeric, 3)
    ) STORED,

  -- ---- provenance ----------------------------------------------------------
  -- Set on insert and on every upsert. Makes an incremental extract into a BI
  -- mirror possible without CDC (§8 recommendation 3), and distinguishes
  -- "restated last night" from "loaded in March and never touched" when a
  -- number is disputed.
  loaded_at             timestamp with time zone NOT NULL DEFAULT now(),

  -- The natural key TODOS.md §19 asks for, present from day one, so dbt has an
  -- ON CONFLICT target and a retry cannot double-insert.
  --
  -- `product_id` is in the key because a changeover mid-hour is legitimate: one
  -- bucket, two products, two rows, each with its own runtime.
  --
  -- `shift` is deliberately NOT in the key. (work_unit_id, bucket_start)
  -- determines business_date, shift, hour_of_day and shift_hour_seq — those are
  -- denormalisations, not independent facts — so including shift would make
  -- "two rows for one bucket claiming different shifts" representable, which is
  -- the double-count this key exists to forbid.
  CONSTRAINT pk_product_perf_wu_hour
    PRIMARY KEY (work_unit_id, bucket_start, product_id),

  CONSTRAINT ck_ppwuh_shift   CHECK (shift BETWEEN 1 AND 3),
  CONSTRAINT ck_ppwuh_hour    CHECK (hour_of_day BETWEEN 0 AND 23),
  CONSTRAINT ck_ppwuh_seq     CHECK (shift_hour_seq BETWEEN 0 AND 8),
  CONSTRAINT ck_ppwuh_bucket  CHECK (bucket_end > bucket_start),
  CONSTRAINT ck_ppwuh_factor  CHECK (factor_to_base > 0),
  CONSTRAINT ck_ppwuh_nonneg  CHECK (
    total_out >= 0 AND good_out >= 0 AND effective_out >= 0
    AND reject >= 0 AND rework >= 0
  ),
  -- An hour bucket cannot hold more than an hour of runtime. The cross-product
  -- version — that all products in one bucket sum to <= 1 h — is not expressible
  -- in a row CHECK and is a dbt test (§3.7).
  CONSTRAINT ck_ppwuh_runtime CHECK (runtime >= 0 AND runtime <= 3600000),
  -- Output with no runtime is physically impossible and arithmetically toxic:
  -- it is the only way to get production that adds to a rate's numerator with
  -- nothing in its denominator, which silently deflates every rate that rolls
  -- it up. Rejecting at the source beats counting at read time (§3.3). If this
  -- ever has to be relaxed against live data, re-add it NOT VALID rather than
  -- dropping it.
  CONSTRAINT ck_ppwuh_rate_defined CHECK (runtime > 0 OR total_out = 0),
  CONSTRAINT ck_ppwuh_ideal   CHECK (
    ideal_rate_per_hour IS NULL OR ideal_rate_per_hour > 0
  ),
  CONSTRAINT ck_ppwuh_rate_src CHECK (
    ideal_rate_source IS NULL OR ideal_rate_source IN
      ('master-data', 'work-unit-default', 'carried-forward', 'unknown')
  )
);

-- Four indexes and a primary key, and no more. Each names a query below; a
-- fifth would be paid for on every one of the ~18k rows a nightly load writes
-- and read by nobody.

-- (a) Every read this service issues, at all three grains. Equality on
--     work_unit_id + business_date (+ shift for the shift grain), then
--     bucket_start supplies the ORDER BY — one ordered index scan, no sort.
--     Deliberately keyed on business_date + shift rather than on a bucket_start
--     RANGE, so the read never computes a shift window and never resolves a
--     time zone. That is the whole direction of TODOS.md §17.
CREATE INDEX IF NOT EXISTS ix_ppwuh_wu_day_shift
  ON oee.product_perf_wu_hour USING btree (work_unit_id, business_date, shift, bucket_start);

-- (b) Ad-hoc BI grouped by SKU over a date range. Mirrors ix_pcwud_product_date
--     on product_count_wu_day.
CREATE INDEX IF NOT EXISTS ix_ppwuh_product_date
  ON oee.product_perf_wu_hour USING btree (product_id, business_date);

-- (c) Ad-hoc BI grouped by work center. This is the shape of query F in the
--     store benchmark ("OEE trend by work center, 12 months"); no existing Gold
--     table has this index, so the equivalent question costs a full scan today.
CREATE INDEX IF NOT EXISTS ix_ppwuh_wc_date
  ON oee.product_perf_wu_hour USING btree (work_center_id, business_date);

-- (d) Unqualified wide scans over a date window — the plant-year Pareto shape,
--     and the incremental extract into a BI mirror. BRIN rather than btree on
--     purpose: loads arrive in bucket order so the heap is naturally clustered
--     on business_date, and at the ~6.6M-rows-per-year projection this costs a
--     few hundred kilobytes instead of ~150 MB.
CREATE INDEX IF NOT EXISTS ix_ppwuh_business_date_brin
  ON oee.product_perf_wu_hour USING brin (business_date);

-- ---------------------------------------------------------------------------
-- Column documentation, for the consumers who never open this file
-- ---------------------------------------------------------------------------
--
-- New convention in this schema, and the reason is specific: the explanatory
-- headers in 0003-0005 are invisible to Power BI, Metabase, DBeaver and `\d+`.
-- COMMENT ON is not. The additivity rules below are the ones an analyst will
-- get wrong first, so they are stated where that analyst will actually see them.
--
-- COMMENT ON is idempotent by nature — it replaces.

COMMENT ON TABLE oee.product_perf_wu_hour IS
  'Per-SKU throughput and rate for one work unit and one local wall-clock hour. '
  'Grain: (work_unit_id, bucket_start, product_id). Buckets are cut in the plant''s '
  'local time (see time_zone) so that eight of them nest exactly inside a shift. '
  'business_date is the SHIFT''s business day, so shift-3 buckets after midnight '
  'carry the previous calendar date.';

COMMENT ON COLUMN oee.product_perf_wu_hour.business_date IS
  'The SHIFT''s business day, matching product_count_wu_shift.shift_date. NOT the '
  'calendar date of bucket_start: shift 3 runs 23:00 to 07:00, so its post-midnight '
  'buckets carry the previous date. Group daily and monthly reports by this column. '
  'The calendar date, if you want it, is (bucket_start AT TIME ZONE time_zone)::date.';

COMMENT ON COLUMN oee.product_perf_wu_hour.hour_of_day IS
  'Local clock hour, 0-23. The GROUP BY key for an hour-of-day profile over a day '
  'or a month. A LABEL, never a key: it repeats on a DST fall-back day and it sorts '
  '23,0,1..6 for shift 3.';

COMMENT ON COLUMN oee.product_perf_wu_hour.shift_hour_seq IS
  '0-based position of the bucket within its shift. Order chart axes and '
  'first-hour-versus-last-hour comparisons by this or by bucket_start, never by '
  'hour_of_day.';

COMMENT ON COLUMN oee.product_perf_wu_hour.runtime IS
  'ADDITIVE. MILLISECONDS this product actually ran inside this bucket, 0..3600000. '
  'Per product: two products sharing a bucket each carry their own, and the two sum '
  'to at most one hour. It is the denominator of every rate here.';

COMMENT ON COLUMN oee.product_perf_wu_hour.actual_rate_per_hour IS
  'DERIVED, NOT ADDITIVE. Do not SUM or AVG this column across buckets. For any '
  'rollup (a shift, a day, a month, a work centre) compute '
  'sum(total_out) * 3600000 / sum(runtime). NULL when runtime = 0.';

COMMENT ON COLUMN oee.product_perf_wu_hour.ideal_rate_per_hour IS
  'The master standard rate in uom_id per hour, denormalised from mes-master-data. '
  'NOT ADDITIVE — do not AVG it. To roll it up use sum(ideal_out) * 3600000 / '
  'sum(runtime) FILTER (WHERE ideal_out IS NOT NULL), which weights each hour by how '
  'long the machine actually ran. NULL means no standard was known at load time; it '
  'does not mean zero.';

COMMENT ON COLUMN oee.product_perf_wu_hour.ideal_out IS
  'ADDITIVE. What the master rate says should have been produced in the runtime '
  'actually recorded. Sum this, not ideal_rate_per_hour. Rate attainment at any grain '
  'is sum(total_out) / nullif(sum(ideal_out), 0).';

COMMENT ON COLUMN oee.product_perf_wu_hour.factor_to_base IS
  'Multiply total_out, reject and rework by this to reach base_uom. good_out is '
  'deliberately NOT scaled — Finish Good stays in its production unit. Rates are '
  'denominated in uom_id, so convert before comparing or summing rates across '
  'products that use different units.';

COMMENT ON COLUMN oee.product_perf_wu_hour.time_zone IS
  'IANA zone the hour buckets were cut in. Buckets are local wall-clock hours so that '
  'eight nest exactly inside a shift; UTC-hour buckets do not nest for a plant at a '
  'non-whole-hour offset. This column is what makes that auditable from the data.';

-- ---------------------------------------------------------------------------
-- Write attribution — 0004's triggers, applied to the new table
-- ---------------------------------------------------------------------------
--
-- oee.log_write() takes the primary key columns as trigger arguments precisely
-- so it needs no per-table variant. Statement-level for INSERT and row-level
-- for UPDATE/DELETE, for the reasons set out at length in 0004: the pipeline is
-- the bulk path and the operator is the precise one. No operator mutation
-- targets this table today, and the row-level trigger is what will notice if
-- that ever quietly changes.
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_perf_wu_hour
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_perf_wu_hour
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_unit_id', 'bucket_start', 'product_id');

-- ---------------------------------------------------------------------------
-- Retire oee.work_unit_perf_analytics
-- ---------------------------------------------------------------------------
--
-- Dropped rather than deprecated. It has no reader in this repo, no natural
-- key, an unsafe grain and no real data, and every day it survives is a day the
-- DAG might start writing it — at which point the cost changes category, from a
-- message to a backfill. DROP TABLE removes its 0004 triggers with it.
DROP TABLE IF EXISTS oee.work_unit_perf_analytics;

-- ORDER MATTERS. The stale watermark row must go BEFORE the tightened CHECK is
-- added, or ADD CONSTRAINT fails validating the very row it is about to forbid.
DELETE FROM oee.etl_watermarks WHERE table_name = 'work_unit_perf_analytics';

-- 0005's ck_etl_watermarks_table names exactly seven tables, deliberately, so
-- that a dbt model writing a watermark under a name no reader looks at fails
-- loudly instead of passing silently. Extending that list is a migration, which
-- is the point. Still seven: six survivors plus the new table.
--
-- Plain ALTER rather than a DO-block guard: DROP ... IF EXISTS followed by ADD
-- is idempotent as a pair, and if the constraint is not the shape this file
-- expects, the ADD must fail rather than pass silently (0003's header — future
-- changes belong in a new numbered migration with plain ALTER TABLE, which does
-- fail loudly).
--
-- Consequence worth restating because it is the one that fails loudly: the dbt
-- MODEL must be named `product_perf_wu_hour`, because `{{ this.identifier }}`
-- is what this CHECK sees.
ALTER TABLE oee.etl_watermarks DROP CONSTRAINT IF EXISTS ck_etl_watermarks_table;
ALTER TABLE oee.etl_watermarks ADD CONSTRAINT ck_etl_watermarks_table CHECK (table_name IN (
  'work_unit_shift_reports',
  'work_unit_day_reports',
  'work_unit_month_reports',
  'downtime_reports',
  'product_count_wu_shift',
  'product_count_wu_day',
  'product_perf_wu_hour'
));
