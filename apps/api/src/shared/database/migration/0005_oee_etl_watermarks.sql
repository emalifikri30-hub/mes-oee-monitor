-- When each Gold table was last loaded, and up to which business day.
--
-- WHY
--
-- Two shipped features currently answer a question they cannot actually answer,
-- and both fail in the flattering direction — which is why neither has a test
-- that catches them:
--
--   * The downtime timeline (TODOS.md §8). `oee.downtime_reports` returning no
--     rows for a shift renders as a full-width green RUN_TIME band. A shift that
--     was down for hours and a shift whose downtime rows have not loaded yet look
--     identical, and the ambiguous one renders as flawless.
--
--   * The SKU View card (TODOS.md §14). No rows in `oee.product_count_wu_shift`
--     renders "No product output recorded for this shift" — the same text a
--     genuinely idle machine gets.
--
-- Neither can be resolved from the report tables themselves: a machine that ran a
-- product with `total_out = 0` is legitimate, and the downtime module has no
-- aggregate to cross-check against. The missing fact is not in the data, it is
-- about the data — has the pipeline reached this day yet? That is what this table
-- carries.
--
-- `last_business_date` is the column that does the work. The browser compares it
-- against the report's own business day: if the pipeline has loaded past that day
-- and there are still no downtime rows, the shift really was clean. If it has
-- not, the honest answer is "not loaded yet" rather than a green band.
--
-- WHO WRITES IT
--
-- dbt, as a post-hook on each Gold model — one row per table, upserted per run.
-- The canonical snippet lives in `docs/gold-write-contract.md`; this is the same
-- statement, kept here so the schema explains its own contract:
--
--   INSERT INTO oee.etl_watermarks AS w
--     (table_name, last_run_at, last_business_date, rows_total, run_id, writer)
--   SELECT '{{ this.identifier }}', now(), max(business_date), count(*),
--          '{{ invocation_id }}', 'dbt'
--     FROM {{ this }}
--   ON CONFLICT (table_name) DO UPDATE SET
--     last_run_at        = EXCLUDED.last_run_at,
--     last_business_date = EXCLUDED.last_business_date,
--     rows_total         = EXCLUDED.rows_total,
--     run_id             = EXCLUDED.run_id,
--     writer             = EXCLUDED.writer;
--
-- A MISSING ROW IS MEANINGFUL, so nothing is seeded here: no row for a table
-- means that table has never been loaded, which is exactly what a fresh
-- environment should report rather than a zero timestamp that reads as "loaded
-- at the epoch".
--
-- Idempotent for the same reason as 0003 and 0004.

CREATE TABLE IF NOT EXISTS oee.etl_watermarks (
  table_name          text        NOT NULL,
  last_run_at         timestamptz NOT NULL,
  -- The furthest business day this table now covers. NULL where the grain has no
  -- business day — `work_unit_perf_analytics` is keyed on an arbitrary
  -- start_time..end_time interval, not a shift or a day.
  last_business_date  date,
  -- Whole-table count at the end of the run, NOT rows written by it: dbt does not
  -- expose an affected-row count to a post-hook. Named for what it is. Freshness
  -- comes from last_run_at; this is a sanity figure, not a delta.
  rows_total          bigint,
  -- dbt's `invocation_id`, so a watermark can be traced back to one dbt run.
  run_id              text,
  -- 'dbt' for the pipeline. Free text rather than an enum because a backfill or a
  -- one-off repair is a legitimate writer too and should be able to say so.
  writer              text        NOT NULL,
  CONSTRAINT etl_watermarks_pkey PRIMARY KEY (table_name),
  -- Deliberately rigid. `{{ this.identifier }}` resolves to the dbt MODEL name,
  -- and the models being ported from `poc-flink-v2` are still called
  -- `machine_shift_report` / `line_shift_report` / `sku_daily_report`. Without
  -- this check a renamed-but-not-repointed model would happily write a watermark
  -- under the wrong key and every reader would go on seeing "never loaded" with
  -- nothing failing. Extending this list is a migration, which is the point.
  CONSTRAINT ck_etl_watermarks_table CHECK (table_name IN (
    'work_unit_shift_reports',
    'work_unit_day_reports',
    'work_unit_month_reports',
    'work_unit_perf_analytics',
    'downtime_reports',
    'product_count_wu_shift',
    'product_count_wu_day'
  ))
);
