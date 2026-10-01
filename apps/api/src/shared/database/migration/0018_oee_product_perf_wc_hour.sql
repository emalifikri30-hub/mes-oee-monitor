-- ===========================================================================
-- 0018 — oee.product_perf_wc_hour: the LINE's hourly production, per SKU
-- ===========================================================================
--
-- Backs the Performance Loss -> Trendline sub-tab on the Line report's Losses
-- page, which ships an EMPTY STATE against this table until Airflow fills it —
-- the same terms `0016` shipped on.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT A ROLL-UP OF product_perf_wu_hour
-- ---------------------------------------------------------------------------
--
-- `oee.product_perf_wu_hour` already carries `work_center_id` NOT NULL and an
-- index on (work_center_id, business_date), so grouping the machine rows by line
-- is trivially available. TODOS §61 and §52 both said to do exactly that — "a
-- query rather than a table" — AND THAT WAS WRONG. This file is the correction.
--
-- A LINE IS MEASURED, NOT SUMMED (`0014`, commit 4fccce8). It has its own count
-- points, so `line <> sum(machines)`. A machine-summed hourly curve would
-- therefore NOT INTEGRATE to the line's own shift and day totals — the same
-- figures rendered in the overview card at the top of the very page the chart
-- sits on. That is the SKU View argument (contract §17.1) one grain finer, and it
-- is worse here rather than better: two numbers disagreeing can be explained in a
-- footnote, but a CURVE whose area disagrees with the tile above it cannot.
--
-- So the line's hourly production comes from the line's own count points, at the
-- hour, per product, exactly as the machine table does for a machine.
--
-- ---------------------------------------------------------------------------
-- THE TWO UNITS, AND WHICH SIDE THE STANDARD LIVES ON
-- ---------------------------------------------------------------------------
--
-- `product_perf_wu_hour` has ONE uom triple, because a work unit has one count
-- point. A LINE HAS TWO (`0014`, contract §16.4a) — bags in, cartons out — so
-- this table carries both, with the same per-side CHECKs, and each measure sits
-- on exactly one side:
--
--   INFEED   total_out, reject, rework
--   OUTPUT   good_out, effective_out, ideal_out
--
-- `ideal_rate_per_hour` IS ON THE OUTPUT SIDE, and this is the one genuine
-- decision in this file rather than a transcription. It matters because
-- `ideal_out` is the load-bearing generated column — the thing that turns a
-- non-additive RATE into an additive QUANTITY, which is what makes
-- sum(ideal_out) correct at any grain where avg(rate) is not (contract §3.5).
--
-- Put the standard on the OUTPUT side and performance is
-- `effective_out / ideal_out`, both output-denominated, and the ratio is
-- unit-consistent. Put it on the infeed side and every derived attainment figure
-- silently divides cartons by bags — a number between 0 and 1 that looks entirely
-- like a percentage. Nothing downstream can detect that, which is why the
-- contract asks the question explicitly (§19) rather than leaving it to be
-- inferred from this file.
--
-- `total_out` is therefore a CONTEXT series on the chart, not a numerator.
--
-- ---------------------------------------------------------------------------
-- PER PRODUCT, like 0006
-- ---------------------------------------------------------------------------
--
-- A changeover mid-hour is legitimate: one bucket, two products, two rows, each
-- with its own runtime and its own standard. And `0016` already establishes that
-- the line's counts ARE resolvable per SKU, so this asks for nothing new in kind.

CREATE TABLE IF NOT EXISTS oee.product_perf_wc_hour (
  -- ---- grain --------------------------------------------------------------
  -- An INSTANT, not a local timestamp. On a DST fall-back day the local hour
  -- 01:00 happens twice, and those are two legitimate, distinct buckets that
  -- must not collide on the key. 0006's rule, unchanged.
  bucket_start          timestamp with time zone NOT NULL,
  bucket_end            timestamp with time zone NOT NULL,
  work_center_id        integer                  NOT NULL,
  product_id            integer                  NOT NULL,

  -- ---- business calendar, written by the pipeline -------------------------
  business_date         date                     NOT NULL,
  shift                 smallint                 NOT NULL,
  -- Local clock hour, 0-23. The GROUP BY key for an hour-of-day profile over a
  -- day or a month. A LABEL, never a key: it repeats on a fall-back day and it
  -- sorts wrong for shift 3 (23, 0, 1 ... 6).
  hour_of_day           smallint                 NOT NULL,
  -- 0-based position within its shift. Normally 0-7; 0-8 on a DST fall-back day,
  -- 0-6 on a spring-forward day.
  shift_hour_seq        smallint                 NOT NULL,
  time_zone             varchar(64)              NOT NULL,

  -- ---- dimensions, denormalised -------------------------------------------
  work_center_name      varchar(255)             NOT NULL,
  work_center_code      varchar(255)             NOT NULL,
  -- Nullable, like 0006's and for the same reason: the hierarchy above the work
  -- center is not reliably populated for every plant, and NOT NULL here would
  -- block a first load over data this table does not itself need.
  area_id               integer,
  area_name             varchar(255),
  factory_id            integer,
  factory_name          varchar(255),
  product_name          varchar(255)             NOT NULL,
  product_code          varchar(255)             NOT NULL,

  -- ---- THE TWO UNITS ------------------------------------------------------
  -- Same shape as 0014's, including the nullability: NULL means "the members
  -- disagreed", not "unknown", and the counts on that side are NULL with it.
  infeed_uom_id         integer,
  infeed_uom_name       varchar(255),
  infeed_uom_code       varchar(255),
  infeed_base_uom_id    integer,
  infeed_base_uom_code  varchar(255),
  infeed_factor_to_base numeric(10,3),

  output_uom_id         integer,
  output_uom_name       varchar(255),
  output_uom_code       varchar(255),
  output_base_uom_id    integer,
  output_base_uom_code  varchar(255),
  output_factor_to_base numeric(10,3),

  -- ---- additive measures --------------------------------------------------
  -- INFEED side.
  total_out             numeric(15,3),
  reject                numeric(15,3),
  rework                numeric(15,3),
  -- OUTPUT side.
  good_out              numeric(15,3),
  effective_out         numeric(15,3),

  -- MILLISECONDS, like 0006's and formatDuration()'s. Per PRODUCT: two products
  -- sharing a bucket each carry their own, and the two sum to at most one hour.
  runtime               bigint                   NOT NULL,

  -- ---- the master rate, OUTPUT-side ---------------------------------------
  -- In `output_uom_id` per hour. NULLABLE ON PURPOSE, 0006's reasoning verbatim:
  -- a product with no effective standard is a real and recurring condition, and
  -- both alternatives are worse — dropping the row loses production that did
  -- happen, and 0 makes every derived attainment ratio infinite. NULL means "no
  -- standard known". Never COALESCE it, and never substitute the actual rate,
  -- which would make the loss vanish.
  ideal_rate_per_hour   numeric(15,6),
  ideal_rate_source     varchar(32),
  ideal_rate_valid_from date,

  -- ---- derived measures — GENERATED so they cannot drift -------------------
  -- OUTPUT-denominated, matching the standard above. NULL rather than a division
  -- error when the line did not run: a bucket with runtime = 0 has no meaningful
  -- rate; it does not have a rate of 0.
  actual_rate_per_hour  numeric(15,6)
    GENERATED ALWAYS AS (
      CASE WHEN runtime > 0
           THEN round(effective_out * 3600000::numeric / runtime::numeric, 6)
      END
    ) STORED,
  -- THE load-bearing column. Turns the non-additive master RATE into an additive
  -- QUANTITY: what the standard says should have come off the end in the time the
  -- line actually ran. sum(ideal_out) is correct at any grain;
  -- avg(ideal_rate_per_hour) is not. NULL propagates when the standard is
  -- unknown, which is correct — an unknown target must not contribute 0.
  ideal_out             numeric(15,3)
    GENERATED ALWAYS AS (
      round(ideal_rate_per_hour * runtime::numeric / 3600000::numeric, 3)
    ) STORED,

  loaded_at             timestamp with time zone NOT NULL DEFAULT now(),

  -- 0006's key, one level up. `product_id` is in it because a changeover mid-hour
  -- is legitimate; `shift` is deliberately NOT, because
  -- (work_center_id, bucket_start) determines business_date, shift, hour_of_day
  -- and shift_hour_seq — those are denormalisations, not independent facts — so
  -- including shift would make "two rows for one bucket claiming different
  -- shifts" representable, which is the double-count the key exists to forbid.
  CONSTRAINT pk_product_perf_wc_hour
    PRIMARY KEY (work_center_id, bucket_start, product_id),

  CONSTRAINT ck_ppwch_shift    CHECK (shift BETWEEN 1 AND 3),
  CONSTRAINT ck_ppwch_hour     CHECK (hour_of_day BETWEEN 0 AND 23),
  CONSTRAINT ck_ppwch_bucket   CHECK (bucket_end > bucket_start),
  CONSTRAINT ck_ppwch_runtime  CHECK (runtime >= 0),
  CONSTRAINT ck_ppwch_factors  CHECK (
    (infeed_factor_to_base IS NULL OR infeed_factor_to_base > 0)
    AND (output_factor_to_base IS NULL OR output_factor_to_base > 0)
  ),

  -- THE TWO UNIT GUARDS, mirroring ck_wcsr_infeed_units / ck_wcsr_output_units.
  -- A count with no unit is "500 BAG + 12 CARTON = 512 <blank>" on a chart axis,
  -- which is the failure 0014 added its pair to prevent — and a chart is a worse
  -- place for it than a tile, because an axis label is read once and the shape is
  -- read continuously.
  CONSTRAINT ck_ppwch_infeed_units CHECK (
    infeed_uom_id IS NOT NULL
    OR (total_out IS NULL AND reject IS NULL AND rework IS NULL)
  ),
  -- ideal_out is in the OUTPUT unit, so it is nulled with that side too — see the
  -- header for why the standard lives there. Note ideal_out is GENERATED, so this
  -- constrains `ideal_rate_per_hour`: a standard with no unit to express it in is
  -- refused rather than silently denominated in whatever the reader assumes.
  CONSTRAINT ck_ppwch_output_units CHECK (
    output_uom_id IS NOT NULL
    OR (good_out IS NULL AND effective_out IS NULL AND ideal_rate_per_hour IS NULL)
  )
);

-- TWO INDEXES, and the omissions are deliberate (0014's rule).
--
-- The primary key's LEFT PREFIX (work_center_id, bucket_start) already serves the
-- shift and day reads, which scan an instant range for one line. Neither of these
-- duplicates it.

-- The hour-of-day PROFILE — a month's ~720 buckets collapsed to 24. The month
-- endpoint's only access path.
CREATE INDEX IF NOT EXISTS ix_ppwch_line_date
  ON oee.product_perf_wc_hour USING btree (work_center_id, business_date);

-- "How did this SKU run over time", across lines. For the pipeline and for ad-hoc
-- reporting, mirroring the pair 0006 carries for the same purpose.
CREATE INDEX IF NOT EXISTS ix_ppwch_product_date
  ON oee.product_perf_wc_hour USING btree (product_id, business_date);

-- ---------------------------------------------------------------------------
-- The watermark, so the pipeline's post-hook has somewhere to write (0005)
-- ---------------------------------------------------------------------------
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
  'product_perf_wc_hour'
));

-- ---------------------------------------------------------------------------
-- Audit, per 0004 and 0014: bulk INSERT per statement, operator mutation per row.
-- NO operator mutation targets this table — it is pipeline-owned like 0006's —
-- so the row-level trigger is a TRIPWIRE rather than a log. If it ever fires,
-- something in this service is writing where it must not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER write_audit_ins AFTER INSERT ON oee.product_perf_wc_hour
  FOR EACH STATEMENT EXECUTE FUNCTION oee.log_write();
CREATE OR REPLACE TRIGGER write_audit_row AFTER UPDATE OR DELETE ON oee.product_perf_wc_hour
  FOR EACH ROW EXECUTE FUNCTION oee.log_write('work_center_id', 'bucket_start', 'product_id');

-- ---------------------------------------------------------------------------
-- Column documentation, for the consumers who never open this file
-- ---------------------------------------------------------------------------
COMMENT ON TABLE oee.product_perf_wc_hour IS
  'The LINE''s hourly production per SKU, from the line''s own count points. NOT a roll-up of product_perf_wu_hour: a line is measured, not summed, so a machine-summed curve would not integrate to the line''s own totals on the same screen. Contract §19.';
COMMENT ON COLUMN oee.product_perf_wc_hour.ideal_rate_per_hour IS
  'The standard, in output_uom_id per hour — the OUTPUT side. Performance is effective_out / ideal_out, both output-denominated. A standard expressed on the infeed side would make every attainment ratio divide cartons by bags, which nothing downstream can detect. NULL means no standard is known; never COALESCE it.';
COMMENT ON COLUMN oee.product_perf_wc_hour.ideal_out IS
  'The additive form of the standard: what should have come off the end in the time the line actually ran. sum(ideal_out) is correct at any grain; avg(ideal_rate_per_hour) is not.';
COMMENT ON COLUMN oee.product_perf_wc_hour.total_out IS
  'INFEED side, so it shares no unit with good_out or effective_out and must never be plotted against them on one axis. A CONTEXT series on the chart, never a numerator.';
