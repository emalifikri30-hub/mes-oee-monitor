# The Gold write contract

**Audience:** whoever writes the `work_unit_*` Airflow DAGs and dbt models — currently
**Wira Hutomo** (`pwawiwa`, wira.hutomo@gmail.com).

**Status:** normative. Until the DAG is in a repository (see [Open risks](#open-risks)) this
document is the only durable specification of what the Gold tier expects.

**Scope:** the `oee` schema in the `mes-master-data` Postgres database — the tables whose DDL is
checked in at `apps/api/src/shared/database/migration/0003_oee_gold_schema.sql`, as amended by
`0006_oee_product_perf_wu_hour.sql`, which **adds `product_perf_wu_hour` and drops
`work_unit_perf_analytics`** (still seven — see [§9](#9-what-changed-in-0006)), and by
`0008_oee_reject_count_wu_shift.sql`, which **adds `reject_count_wu_shift`** and takes the count to
**eight**. See [§10](#10-what-0008-adds) for what that migration expects of you, and
[§3.8](#38-reject_count_wu_shift--what-must-fill-it) for the columns it asks you to populate. Amended
again by `0009_oee_downtime_log_events.sql`, which **adds `downtime_log_events`** and takes the count
to **nine**; see [§11](#11-what-0009-adds) and
[§3.9](#39-downtime_log_events--what-must-fill-it).

`0010_oee_shift_report_approvals.sql` adds two more tables — `work_unit_shift_report_approvals` and
`work_unit_shift_report_approval_events` — but **they are not part of the nine and nothing is asked
of you for them.** They are written exclusively by `mes-oee-monitor`, and the pipeline must never
read, write or model them. See [§12](#12-what-0010-adds--and-why-there-is-nothing-for-you-to-do), which is a page of what NOT to do.

**Amended 2026-08-25 again by `0011_oee_downtime_reason_shape.sql`**, which adds three CHECK
constraints to `downtime_reports` and asks nothing of you — but changes what a malformed label does
from "a slightly wrong chart" to "an aborted statement". See [§14](#14-what-0011-adds--a-shape-guard-that-can-fail-your-load).

**Amended 2026-08-25, and this one DOES ask something of you.** The downtime-edit write path has
shipped, so `oee.downtime_report_history` now receives rows. That changes how you must build
`downtime_reports`: re-deriving its four operator-mutable columns from Silver on every run
**silently discards operator corrections**. [§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model)
is the change, and it is the only section here that asks you to revise a model you have already
written. No migration accompanies it — every column and table involved already exists.

---

## 1. Who writes what

| Tier                      | Store                 | Written by                                | State         |
| ------------------------- | --------------------- | ----------------------------------------- | ------------- |
| **Bronze**                | TimescaleDB           | **Telegraf**                              | exists        |
| **Silver** (hot)          | TimescaleDB           | **Apache Flink**                          | R&D           |
| **Gold** (cold)           | Postgres `oee` schema | **Apache Airflow → dbt**, direct DB write | **not built** |
| Gold — operator mutations | Postgres `oee` schema | **`mes-oee-monitor` (this repo)**         | **not built** |

Two rules follow, and everything else in this document is a consequence of them:

1. **Airflow/dbt owns every bulk write.** It INSERTs and upserts rows. It writes Gold _directly_,
   not through this service's HTTP API.
2. **This repo writes only named operator mutations.** Approving a shift report (open → closed),
   and editing a downtime — changing its category, updating its reasons, adding or removing
   actions. **Against the twelve tables above it never inserts and never deletes** — its only write
   to them is an `UPDATE` on a downtime's own columns.

   That sentence used to end at "never inserts and never deletes", full stop. `0010` makes the
   qualifier necessary: this service now **owns three tables outright** —
   `work_unit_shift_report_approvals`, `work_unit_shift_report_approval_events` and
   `oee.downtime_report_history` — and inserts into all three. They hold no pipeline data, they are
   keyed on the natural key of a shift report or on a stop's `source_event_id` rather than on any
   `serial`, and the pipeline has no reason to write them.

   **Both mutations are now built (2026-08-25), and the second one has a consequence for you.**
   `oee.downtime_report_history` was empty when this was written; it is not any more, and
   [§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model) is what your model must
   do about it. The `UPDATE` on a downtime's own columns is still the ONLY write this service makes
   to any of the nine — what changed is that the pipeline must now READ one of the three above when
   rebuilding one of the nine.

   Approving a report also **freezes its downtime**: the edit endpoint refuses a stop belonging to a
   closed report. That is a decision about this service's own behaviour and asks nothing of you, but
   it is why a reopen endpoint exists beside it.

The near-realtime `/dashboard` reads **Silver**, not Gold. Gold is cold: it serves reports.

`mes-oee-monitor` owns the **DDL** for all nine tables. Schema changes belong in a numbered
migration in that directory, not in `oee_db_setup_dag.py` or a dbt `on-run-start` hook. If the
pipeline needs a column, ask for it here and it ships as a migration.

**One table is outside rule 2 entirely.** `downtime_log_events`, added by `0009`, is the one table
this service will never write at all — not even as an operator mutation. Editing a downtime writes
`downtime_reports`; the log is the record of what was **observed**, and a bar that moves when an
operator corrects a stop is not a count of anything. Its row-level audit trigger exists to notice if
that ever quietly changes. See [§3.9](#39-downtime_log_events--what-must-fill-it).

---

## 2. Per-table grain and upsert key

| Table                       | Grain                                            | Upsert key (enforced)                                                            |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `work_unit_shift_reports`   | work unit × shift × day                          | `wu_shift_report_key (date, shift, work_unit_id)`                                |
| `work_unit_day_reports`     | work unit × day                                  | `wu_day_report_key (date, work_unit_id)`                                         |
| `work_unit_month_reports`   | work unit × month                                | `wu_month_report_key (date, month, work_unit_id)`                                |
| `product_count_wu_shift`    | work unit × shift day × shift × product          | `pk_product_count_wu_shift (work_unit_id, shift_date, shift, product_id)`        |
| `product_count_wu_day`      | work unit × day × product                        | `pk_product_count_wu_day (work_unit_id, date, product_id)`                       |
| `downtime_reports`          | one machine stop                                 | **none — see below**                                                             |
| `product_perf_wu_hour`      | work unit × local hour × product                 | `pk_product_perf_wu_hour (work_unit_id, bucket_start, product_id)`               |
| `reject_count_wu_shift`     | work unit × shift day × shift × product × reason | `pk_reject_count_wu_shift (work_unit_id, shift_date, shift, product_id, reason)` |
| `downtime_log_events`       | one machine stop, as logged (immutable)          | `pk_downtime_log_events (event_id)`                                              |
| `work_center_shift_reports` | work centre × shift × business day               | `wc_shift_report_key (business_date, shift, work_center_id)`                     |
| `work_center_day_reports`   | work centre × business day                       | `wc_day_report_key (business_date, work_center_id)`                              |
| `work_center_month_reports` | work centre × month                              | `wc_month_report_key (business_date, work_center_id)`                            |

**Three tables are deliberately absent from that list**, because you must not write them at all:
`downtime_report_history` (`0007`), `work_unit_shift_report_approvals` and
`work_unit_shift_report_approval_events` (`0010`). They are `mes-oee-monitor`'s, end to end. Their
enforcement is mechanical rather than editorial — see [§12](#12-what-0010-adds--and-why-there-is-nothing-for-you-to-do).

Use these as the `ON CONFLICT` target (dbt: `unique_key`). They exist precisely so a re-run
overwrites rather than duplicates.

### 2.1 The idempotency gap — read this before the first backfill

> `downtime_reports` has **no natural key**. Its only unique index is on the surrogate `id`
> (`serial`), which the pipeline does not supply and cannot match on. **There is no `ON CONFLICT`
> target, so dbt cannot upsert it — a DAG retry, a DLQ replay, or a backfill will silently insert
> every row a second time.**

This gap used to name two tables. `work_unit_perf_analytics` was the other, and `0006` **dropped
it**; its replacement `product_perf_wu_hour` is born with a natural key, so it does not join this
list. It upserts, the `DELETE`-then-`INSERT` requirement below never applies to it, and a re-run
restates rather than duplicates. **`downtime_reports` is now the only table with this problem.**

`reject_count_wu_shift`, added by `0008`, is born with a key for the same reason and by the same
deliberate choice — the five-column primary key in §2 above. It upserts, so nothing in this section
applies to it either. That is also why its `reason` column carries a constraint the other tables'
labels do not: it is a **key member**, so a renamed counter is a new row rather than a corrected
one. See §3.8.

`downtime_log_events`, added by `0009`, is born with a key too — **and it is precisely the key this
section has been asking for.** The Preferred fix below is "a deterministic identifier from the Silver
event … make it `UNIQUE`"; on that table the same identifier is the **whole primary key**, because a
table carrying no timestamps has no composite candidate at all. So it upserts, and nothing in this
section applies to it either.

**Write the same string into both.** If `downtime_log_events.event_id` and
`downtime_reports.source_event_id` (§3.3.2) carry one identifier, the two tables become reconcilable
— which is what makes §3.9's second test able to say anything precise — and this section closes on
both tables at once. That is one field.

This is not hypothetical: `poc-flink-v2` already ships `backfill_bronze_silver.py` and
`dlq_monitor_dag.py`. Duplicated stops do not error; they render as a doubled timeline strip and
inflated downtime totals, which nobody would spot from the screen.

**Requested fix — pick one, and tell us which so the migration matches:**

- **Preferred:** carry a deterministic identifier from the Silver event through to Gold — a
  `source_event_id text` that Flink already assigns per detected stop — and make it `UNIQUE`.
  This survives changes to start/end times when a stop is corrected upstream.
- **Fallback:** `UNIQUE (work_unit_id, start_at)` on `downtime_reports`. Cheaper, but it breaks if
  a stop's `start_at` is ever revised, since the revision looks like a new row.

Until one lands, **the DAG writing `downtime_reports` must be `DELETE`-then-`INSERT` scoped to the
run's window**, never append-only. Say so explicitly in the model config.

**AMENDED 2026-08-25 — this is now a blocker on a SHIPPED feature, not only on your idempotency.**
The downtime-edit endpoint addresses a stop by `source_event_id` and `oee.downtime_report_history`
keys on it `NOT NULL`, so **a stop without one cannot be edited at all** — the row menu disables its
Edit item and says why, rather than offering an action that would 404. On the dev database a few rows
carry a hand-seeded UUID (three of seventeen at the time of writing) and those are editable;
everything the pipeline has loaded is not. Populating the column is what turns the feature on for
real.

And note what happens in the same run that populates it: the override join in
[§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model) stops being inert at
exactly that moment. **Land the two together.**

---

## 3. Schema requirements for v1

These are already filed as TODOs against this repo. Because the DAG is greenfield, each is a
line in a model rather than a migration plus a backfill against a live table — so they are far
cheaper now than later. `§` numbers refer to [`TODOS.md`](../TODOS.md).

### 3.1 `business_date` — write the business day as a real `date` (§17)

`work_unit_shift_reports.date` is a `timestamptz` holding the shift's **start instant**, not a
calendar day. Every consumer that wants a day out of it has to resolve the plant's time zone
first, and one of them cannot: the month filter spans many work units in a single query and the
zone is not a column, so no single predicate is correct. Measured against the live database:

```
plant             shift 3 of Aug 31   ->  instant          in the August filter?   truth
Asia/Jakarta        23:00+07          ->  Aug 31 16:00Z           yes               yes   ok
America/Chicago     23:00-05          ->  Sep  1 04:00Z           no                yes   WRONG
America/Chicago     shift 3 of Jul 31 ->  Aug  1 04:00Z           yes               no    WRONG
```

**Please write a `business_date date` column on every table that has a business day**, alongside
the existing `date`. It also makes the watermark post-hook in §4 uniform, and lets the SKU join
drop its `AT TIME ZONE` conversion.

**Partly delivered by `0013` (2026-08-27).** The column now EXISTS, nullable, on
`work_unit_shift_reports`, `work_unit_day_reports` and `work_unit_month_reports`, alongside a
`time_zone text`. The schema half is done; the writing and the backfill are yours. §15.3 defines
exactly what the value must be, including the 07:00 → 07:00 day boundary.

This has already caused one shipped bug: the product-count join originally compared
`p.shift_date = r.date` — a `date` against a `timestamptz` — which Postgres resolves by widening
the date to midnight, so only a shift starting at exactly 00:00 in the session zone could match.
At UTC+7 that is shift 1 alone; shifts 2 and 3 silently returned nothing and the card rendered
"No product output recorded for this shift", indistinguishable from an idle machine.

### 3.2 `area_id` and `factory_id` on `downtime_reports` (§9)

**`area_id` and `area_name` now EXIST** — migration `0007` added them, because the downtime detail
drawer names the full area / line / machine hierarchy. **They are empty.** Nothing writes them, so
this section is now a request to POPULATE two columns rather than to add them, and `factory_id` is
still outstanding.

`SCOPE_COLUMN` in `downtime-handler.ts` is deliberately NOT extended in the meantime: an all-NULL
column would turn `scope=area` from an honest 400 into a 200 with an empty result, which is worse.
It widens the day the pipeline writes the column, and not before.

`GET /api/v1/downtimes/timeline` accepts `scope=area` and `scope=factory` but answers 400,
because the table carries no column to filter on. Serving them today would mean resolving the
hierarchy through `mes-master-data` first and inheriting its failure modes for data that was
sitting in Gold the whole time. Two denormalised columns turn all four scopes into one `WHERE`
clause, permanently. `work_unit_id` and `work_center_id` are already denormalised this way.

### 3.3 Integrity on `downtime_reports` (§10)

- `CHECK (end_at IS NULL OR end_at >= start_at)` — inverted rows are currently possible, and this
  service drops them at runtime (`clipToWindow`, counted as `downtime_rows_dropped_total`).
  Rejecting at the source beats counting.
- `duration` is a nullable `int8` written independently of `start_at`/`end_at` and can disagree
  with them. Make it `GENERATED ALWAYS AS ... STORED`, or drop it and let readers compute it.
  **Note this column is now read by nothing at all** — every consumer derives duration from the
  timestamps, and the reason aggregate below additionally CLIPS it to the shift window, which the
  stored value could not express even if it agreed.

### 3.3.1 `reason` wants to be a column, not a jsonb array

**This is now the THIRD consumer of `reason ->> 0`, and the first that FILTERS on it rather than
grouping.** `GET /api/v1/downtimes/by-reason/detail` — the drill-down behind the Pareto's eye
button — matches `reason ->> 0 = $1` to list the stops behind one bar. A `WHERE` on an expression
over jsonb cannot use an index, so it scans the seven-day slice `scopeAndWindow` narrows to. A real
`primary_reason text` column would buy the filter, the GROUP BY and an index in one change; an
expression index on `((reason ->> 0))` was considered and rejected, because it would index a shape
this section asks you to delete.

The equality is also now load-bearing in a way grouping alone was not: the drill-down and the bar
it was opened from MUST select the same rows, or the detail page will not sum to the chart. Both
compose one shared SQL fragment for exactly that reason, and an integration test pins it. `GET /api/v1/downtimes/by-reason` — the Availability Loss and Schedule Loss Paretos, which
are the same query over `category` — groups on the
FIRST element of the array and discards the rest, because a stop has one cause for accounting
purposes and exploding the array would count one 40-minute stop under two reasons and make the bars
sum to more than the shift. The browser already renders the array's other elements in the Downtime
Details table, so both readings of the column now ship.

Three consequences worth putting in front of whoever writes the model:

- **The grouping key is an expression over jsonb.** §8 measured the plant-year Pareto at 2799 ms
  against `reason#>>'{0}'` and 2111 ms against a plain `text` column — ~25%, for a column that is a
  single string in every row we have seen.
- **Element order is now load-bearing.** Nothing today guarantees that `reason[0]` is the _primary_
  cause rather than whichever the operator typed first. If the pipeline can order the array by
  significance, say so; if it cannot, a dedicated `primary_reason text` alongside the array is the
  honest fix and settles the question permanently.
- **Non-string elements degrade silently.** The reader guards with
  `jsonb_typeof(reason -> 0) = 'string'` and folds anything else — plus `[]`, `[""]` and
  whitespace — into one unlabelled bucket. That is a guard, not a feature: those rows are
  unattributable downtime, and they render as "Unspecified" on an operator's screen.

**A THIRD READING OF THE ARRAY NOW EXISTS, and it strengthens this ask rather than weakening it.**
The paragraph above says the array's non-first elements are only ever _rendered_, in the Downtime
Details table. That is no longer true: the Losses page's Others tab AGGREGATES over every element,
counting how many stops cited each reason. It does so from `downtime_log_events.reasons`
([§3.9](#39-downtime_log_events--what-must-fill-it)) and **not** from this column — for the
mutability reason §3.9 gives, and because that table's array is a `text[]` rather than jsonb, which
is this section's ask applied to a column whose semantics genuinely are a set of strings. So the two
requests are consistent: `downtime_reports` wants **one** scalar cause it can index and filter, and
the event log wants **all** of them typed. Neither wants a jsonb array.

### 3.3.2 The six columns migration `0007` added, and what must fill them

`0007_oee_downtime_detail.sql` added six nullable columns to `downtime_reports` and one new table.
**Every one of them is empty and will stay empty until the DAG writes it.** They ship ahead of the
data deliberately — the alternative was a screen that cannot be built until an unwritten pipeline
lands — and the UI renders an em dash for each, which is what the design already shows.

| Column                        | What it feeds on screen                                                   | Notes                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `source_event_id text UNIQUE` | the "Downtime ID" on the detail table; the key the history table joins on | **Also §2.1's preferred idempotency key.** See below — this is the one that matters most. |
| `area_id` / `area_name`       | "Area Name" in the detail drawer                                          | §3.2 above                                                                                |
| `detail_reason text`          | "Detail Reason" in the drawer — the operator's elaboration on `reason`    | unbounded; rendered for one record at a time                                              |
| `input_by varchar(255)`       | "Input by"                                                                | a name, not a key: there is no users table in this database                               |
| `maintained_by varchar(255)`  | "Maintained by"                                                           | same                                                                                      |

**`source_event_id` is the ask worth reading twice.** It is simultaneously the public identifier
the UI links on and the `ON CONFLICT` target §2.1 has been asking for. Those are the same
requirement seen from two ends: because the table has no natural key, §2.1 mandates
DELETE-then-INSERT scoped to the run window, which means **every `id` changes on every run** — so a
deep link or a history row keyed on `id` would silently come to mean a different stop. The UNIQUE
index is over a nullable column on purpose: Postgres permits any number of NULLs, so today's rows
coexist untouched and the constraint starts biting the moment the pipeline writes the key.

Please carry a deterministic id from the Silver event through to Gold. A value that survives a stop
being corrected upstream is what makes both the upsert and the drill-down correct.

**`oee.downtime_report_history`** is the per-field change trail behind the Changes History panel.
This service writes it — it is an operator mutation, not a pipeline concern — so the DAG must never
insert, update or delete there. It has no foreign key to `downtime_reports`, both because the `oee`
schema has none anywhere and because an FK would block the DELETE-then-INSERT above.

**AMENDED 2026-08-25: the write path now exists, so this table is no longer merely "not yours to
model" — you have to READ it.** See
[§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model): its latest row per field
is the authority for the four operator-mutable columns, and rebuilding those from Silver without it
discards operator corrections silently.

It is very nearly empty, and the reason has moved from code to DATA: the pipeline does not write
`source_event_id`, so almost nothing can attach to it. The endpoint reports `trackedMembers` alongside
the entries so the UI can distinguish "nothing has been edited" from "none of these stops can be
tracked at all" — and for any stop the pipeline loaded, it is the second.

### 3.4 `factor_to_base` consistency (§13)

`listProductCount` multiplies `total_out`, `reject` and `rework` by `factor_to_base`, so one row
with a wrong factor renders a plausible number rather than failing. `CHECK (factor_to_base > 0)`
admits any positive value and nothing downstream can validate it. **Guarantee that all rows
sharing `(product_id, uom_id, base_uom_id)` carry the same `factor_to_base`** — ideally by
sourcing it from a reference table rather than recomputing per row.

Note `good_out` is deliberately **not** scaled: Finish Good stays in its production unit.

### 3.5 The master rate must arrive in Gold — `product_perf_wu_hour.ideal_rate_per_hour`

This is the one value the pipeline has to fetch that it does not fetch today. The standard/ideal
production rate is owned by **mes-master-data**; it must be resolved at load time and written onto
the row. `mes-oee-monitor` will never call mes-master-data for it — for the same reason product and
UOM names are denormalised today, and the same reason §3.2 asks for `area_id`/`factory_id`: a read
path that reaches into another service inherits its availability.

1. **Denominate it in `uom_id`** — the same unit as `total_out` on the same row, _not_ the base
   unit. Cross-product comparisons apply `factor_to_base` themselves.
2. **Resolve it as-of the bucket, not as-of the load.** Standards change. A backfill of March must
   use March's standard, or every re-run silently restates history. Write the master record's
   effective-from date into `ideal_rate_valid_from` so the choice is auditable.
3. **Write `NULL` when there is no standard.** Do not substitute `0`, do not substitute the actual
   rate, do not drop the row. `NULL` means "unknown", every downstream aggregation is written to
   propagate it, and the chart renders it as a gap. `0` makes attainment infinite; the actual rate
   makes the loss vanish. Set `ideal_rate_source` to one of `master-data` / `work-unit-default` /
   `carried-forward` / `unknown` so a fallback is visible **in the data** rather than only in a
   DAG's source. A `CHECK` enforces that vocabulary.
4. **Restate names, codes, `factor_to_base` and the rate on every upsert**, so a master-data
   correction heals on the next run instead of leaving March disagreeing with April.

**Do not write `actual_rate_per_hour` or `ideal_out`.** Both are `GENERATED ALWAYS ... STORED`;
Postgres computes them and rejects any attempt to assign to them. That is deliberate —
`downtime_reports.duration` is written independently of `start_at`/`end_at` and can disagree with
them (§3.3), and this is that bug prevented by construction rather than by a `CHECK` that rounding
would break.

> **The dbt trap this creates, verified against Postgres 18.4.** dbt-postgres builds the
> `DO UPDATE SET` list from the _target relation's_ columns, so a naive `merge` model fails with
> `column "actual_rate_per_hour" can only be updated to DEFAULT`. Configure one of:
>
> ```yaml
> {{ config(
>     materialized='incremental',
>     unique_key=['work_unit_id', 'bucket_start', 'product_id'],
>     incremental_strategy='delete+insert'
> ) }}
> ```
>
> `delete+insert` is the better default here because the delete scopes naturally to the run's
> `business_date` window. If you prefer `merge`, add
> `merge_exclude_columns=['actual_rate_per_hour', 'ideal_out']`.

**Why the split matters more than it looks.** `ideal_rate_per_hour` is a rate and therefore
non-additive, but `ideal_out` — the same standard weighted by the runtime actually recorded — is
additive. That is what lets a day or a month roll up correctly:

```
   two full hours at 1000/h, then a three-minute sliver at 2000/h

     AVG(actual_rate_per_hour)                      = 1333.3 /h   ← WRONG
     sum(total_out) * 3600000 / sum(runtime)        = 1024.4 /h   ← right
```

The sliver carries a third of the weight of two full hours, and the error is **flattering** — the
same direction as the two failures §4 exists for. Over a month of hourly rows it compounds.

### 3.6 How to cut the buckets — the highest-risk instruction in this document

Bucket on the **plant's local wall clock**:

```sql
date_trunc('hour', ts AT TIME ZONE :plant_tz)   -- then convert back to an instant
```

**Never `date_trunc('hour', ts)` on the UTC value.** Shift boundaries are on the local hour
(07:00 / 15:00 / 23:00, `SHIFT_WINDOWS` in `apps/api/src/module/downtime/downtime.ts` — read them
from there, do not restate them), so local-hour buckets nest exactly **8 per shift, 24 per business
day**, with no bucket straddling a boundary. UTC-hour buckets do not nest for any plant at a
non-whole-hour offset:

```
  Asia/Jakarta   +07:00   local-hour == UTC-hour buckets     ← indistinguishable
  Asia/Kolkata   +05:30   every bucket straddles a boundary by 30 min
  Asia/Kathmandu +05:45   ... by 45 min
```

At UTC+7 a UTC-bucketing pipeline ships green and stays green. It breaks silently at the first
non-whole-hour plant, and every shift total is then wrong at both ends by an amount too small to
notice per shift and large enough to matter per month. This is the same correct-for-Jakarta-only
failure family as §3.1's `America/Chicago` table. Test 1 in §3.7 is what catches it mechanically.

Per row also write:

| Column           | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `time_zone`      | the IANA zone the buckets were cut in. Makes the rule auditable from the data.                            |
| `business_date`  | **the SHIFT's business day.** Shift 3's post-midnight buckets carry the **previous** date.                |
| `shift`          | 1–3.                                                                                                      |
| `hour_of_day`    | local clock hour 0–23. A label and a `GROUP BY` key, never a key.                                         |
| `shift_hour_seq` | 0-based position within the shift: 0–7 normally, 0–8 on a DST fall-back day, 0–6 on a spring-forward day. |

**Emit no row for a bucket with no runtime and no output.** Emit one row per product per bucket — a
changeover at 10:20 is two rows in the 10:00 bucket — and let their `runtime` values sum to at most
3,600,000 ms.

### 3.7 Three dbt tests, at `error` severity

Three rules above are not expressible as row-level constraints. They belong in the model's tests,
and they are the only thing standing between a silent bucketing defect and a customer finding it.

```sql
-- 1. Bucket coverage. Catches UTC bucketing, a lost hour, and a shift attributed
--    to the wrong business day. This is the test that would catch a +05:30 plant.
--    7-9 rather than = 8, because DST makes a shift legitimately 7 or 9 buckets long.
SELECT work_unit_id, business_date, shift, count(DISTINCT bucket_start) AS buckets
  FROM {{ this }} GROUP BY 1,2,3
HAVING count(DISTINCT bucket_start) NOT BETWEEN 7 AND 9

-- 2. No bucket holds more than an hour of runtime across all of its products.
--    The row-level CHECK cannot see across products; this can.
SELECT work_unit_id, bucket_start, sum(runtime) AS ms
  FROM {{ this }} GROUP BY 1,2 HAVING sum(runtime) > 3600000

-- 3. Hourly output reconciles with product_count_wu_shift for the same shift.
--    Two independently computed sources for one number; if they disagree, one of
--    them is being shown to an operator. Also the only thing that catches a
--    time-zone correction that re-buckets production without colliding on the key.
SELECT h.work_unit_id, h.business_date, h.shift, h.product_id
  FROM (SELECT work_unit_id, business_date, shift, product_id, sum(total_out) AS t
          FROM {{ this }} GROUP BY 1,2,3,4) h
  FULL JOIN oee.product_count_wu_shift p
    ON (p.work_unit_id, p.shift_date, p.shift, p.product_id)
     = (h.work_unit_id, h.business_date, h.shift, h.product_id)
 WHERE h.t IS DISTINCT FROM p.total_out
```

### 3.8 `reject_count_wu_shift` — what must fill it (§24, §29)

`0008_oee_reject_count_wu_shift.sql` adds **one new table**, and **every row of it is missing**.
Nothing writes it. It ships ahead of the data for the reason `0007` did — the alternative was a
screen that cannot be built until an unwritten model lands — and until you write it the Losses
page's Quality Loss tab renders "not loaded yet" for every shift.

This is the table `TODOS.md` §24 predicted. `reject` and `rework` are scalars on
`work_unit_shift_reports`, and `product_count_wu_shift` carries the same two per SKU; neither has a
reason dimension, so there has never been anything to rank. The design asks for a bar per reject
reason naming the machine, the reason, its weight, the unit the **sensor** counted in, and the same
quantity **converted** to a comparable unit. Not one of those five is expressible against any
existing table.

**Grain: work unit × shift day × shift × product × reason.** Upsert key in §2. The names the
reference design shows — `Total_NG_Prod`, `NG_Over_Count`, `Reject_Count`, `NG_Under_Count` — look
like PLC counter tags rather than master-data reasons, which is why the table carries **both**
identities. See the `reason*` rows below.

| Column                                     | What it feeds on screen                                            | Notes                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `reason varchar(255)`                      | "Reject Reason", and the Pareto's x axis                           | **A PRIMARY KEY MEMBER — it must be stable.** Read the first sub-section below before choosing what goes in it.    |
| `reason_code` / `reason_id`                | nothing yet; the master-data half of the reason's identity         | `ms_reject.reject_reasons.code` / `.id`. That table is **empty** upstream today. Nullable, so not key members.     |
| `source_tag` / `count_point_id`            | nothing yet; the provenance half                                   | `ms_core.count_points.source_tag` / `.id`. Lets a counter be traced to the tag it came from.                       |
| `uom_code` + `counter_value`               | "Counter Unit" — `48 CALENDER`                                     | **As the sensor counted it. Never scaled.** Not comparable across counters.                                        |
| `base_uom_code` + `factor_to_base`         | the unit the converted column is denominated in                    | §3.4's consistency requirement applies unchanged. **Converge on one base unit per work unit** — see below.         |
| `converted_value`                          | the "Converted" column, and **the figure the bars are drawn from** | **`GENERATED ALWAYS ... STORED`. Do not assign to it.** See the dbt trap below.                                    |
| `weight_gram numeric(15,3)`                | "Weight" — `15232 gr`, or an em dash                               | **Write `NULL`, never `0`.** This is the ask most likely to be got wrong; read it below.                           |
| `frequency integer`                        | "Freq."                                                            | How many reject records stand behind the row.                                                                      |
| `reject_time bigint`                       | the Pareto's `duration` ranking                                    | Nullable and **unwritten today**, so that one radio ranks a column of zeros. Named on screen rather than hidden.   |
| `work_unit_name varchar(255)` **NOT NULL** | "Machine Name"                                                     | Unusual in this schema — the report tables allow NULL. The design annotates the column "should not be empty".      |
| `shift_date date` + `time_zone`            | which shift the rows belong to                                     | `shift_date` is the **SHIFT's** business day, matching `product_count_wu_shift.shift_date`. §3.1 applies here too. |

#### `weight_gram`: write `NULL`, never `0` — the one to read twice

The design annotates the Weight column "some reason does not have weight value", and the reference
mock renders `0 gr` for two of its four counters. **Those are two different claims and the screen
renders them differently:**

```
  weight_gram = NULL  ->  "—"       the counter has no scale behind it
  weight_gram = 0     ->  "0 gr"    it was weighed, and weighed nothing
```

Writing `0` for "not weighed" is undetectable downstream and quietly wrong in three places at once:
the cell asserts a measurement nobody took, the weight ranking treats an unmeasured counter as a
measured empty one, and — because `sum()` over an all-`NULL` set is `NULL` while `sum()` over zeros
is `0` — the shift's weight total flips from "nothing was weighed" to "the shift weighed nothing".
The reader depends on that `sum()` behaviour rather than special-casing it, which is exactly why the
column is nullable.

#### `converted_value` is `GENERATED` — and the dbt trap §3.5 already documented

```sql
converted_value numeric(15,3)
  GENERATED ALWAYS AS (round(counter_value * factor_to_base, 3)) STORED
```

Postgres computes it and **rejects any attempt to assign to it.** That is deliberate, and it is
§3.3's lesson applied before it can bite: `downtime_reports.duration` is written independently of
`start_at`/`end_at` and can disagree with them, and this is the same defect prevented by
construction in the one column the chart plots.

The consequence is the trap §3.5 records for `product_perf_wu_hour`, and it applies here verbatim —
a naive `merge` fails with `column "converted_value" can only be updated to DEFAULT`:

```yaml
{{ config(
    materialized='incremental',
    unique_key=['work_unit_id', 'shift_date', 'shift', 'product_id', 'reason'],
    incremental_strategy='delete+insert'
) }}
```

`delete+insert` is the better default for the same reason it is there: the delete scopes naturally
to the run's `shift_date` window. If you prefer `merge`, add
`merge_exclude_columns=['converted_value']`.

#### `reason` is a key member, so it must be stable

`reason` is the last column of the primary key, because the table has no other candidate — both
halves of the reason's identity (`reason_code`/`reason_id` and `source_tag`/`count_point_id`) are
nullable, and a nullable column cannot key anything.

**So a renamed counter is a new row, not a corrected one.** A tag that changes from `NG_Over_Count`
to `NG_OverCount` between runs splits one shift's history into two bars that each look plausible.
Write the canonical tag the plant and the machine's HMI use, and if that vocabulary is ever
renamed upstream, say so — it is a data migration, not a model change.

The UI renders this value **verbatim**, deliberately: prettifying `Total_NG_Prod` into "Total NG
Prod" would break the one string an operator can match against the machine in front of them.

#### Mixed base units make the converted column useless — please avoid them

The converted column exists so counters in different sensor units can be compared. That works only
while they convert to the **same** base unit. If one work unit's counters carry
`base_uom_code = 'BAG'` and another's `'CARTON'` within one shift, there is no sum that means
anything, and the reader is written to say so rather than to add them:

- per bucket, `counter_unit` and `converted_unit` come back `NULL` and the cell renders an em dash;
- per shift, `convertedUnit` comes back `NULL` and the card states that quantities are not
  comparable and shows no total.

That is honest and it is also useless to the person reading it. **Please converge on one base unit
per work unit where the plant allows it.** This is §3.4's consistency requirement one level up:
that one asks for a consistent factor per `(product, uom, base_uom)`, this asks for a consistent
`base_uom` per work unit.

#### Two dbt tests, at `error` severity

```sql
-- 1. The generated column is the only place the conversion happens. This is
--    cheap, and it is the column the Pareto's bars are drawn from — so if it
--    ever disagrees with its inputs, every bar on the screen is wrong.
SELECT work_unit_id, shift_date, shift, product_id, reason
  FROM {{ this }}
 WHERE converted_value IS DISTINCT FROM round(counter_value * factor_to_base, 3)

-- 2. Rejects reconcile with the shift report's own aggregate, or the gap is
--    explained. The screen's footnote PROMISES the reader these will not match,
--    because each row is scaled by its own factor while the tile is the ETL's
--    aggregate. That promise should rest on a measured number rather than a
--    guess: this test is what turns "they differ" into "they differ by X".
--    Set the threshold from what you actually observe; start by reporting it.
SELECT r.work_unit_id, r.shift_date, r.shift,
       sum(r.converted_value) AS ranked, w.reject AS aggregate
  FROM {{ this }} r
  JOIN oee.work_unit_shift_reports w
    ON w.work_unit_id = r.work_unit_id
   AND w.shift        = r.shift
   AND (w.date AT TIME ZONE r.time_zone)::date = r.shift_date
 GROUP BY 1,2,3, w.reject
HAVING sum(r.converted_value) IS DISTINCT FROM w.reject
```

Test 2 will fail on day one, and that is the point — it is the instrument that tells us **how far
apart** the two sources are, which nobody currently knows. Report the number before deciding
whether it is a threshold, a bug in the model, or a bug in the report table.

### 3.9 `downtime_log_events` — what must fill it (§24, §30)

`0009_oee_downtime_log_events.sql` adds one new table, and **every row of it is missing**. The Losses
page's Others tab renders "not loaded yet" for every shift until you write it. Same trade `0007` and
`0008` made, taken a third time.

#### Why a new table rather than a read of `downtime_reports`

This is the product decision, and it is normative rather than a preference. `downtime_reports` is the
**operator-mutable** table: §1 rule 2 reserves editing a downtime — its category, its reasons, its
actions — for this service, and `0004`'s row-level trigger plus `0007`'s `downtime_report_history`
exist for that path and nothing else. A frequency Pareto drawn from it therefore **moves when an
operator corrects a stop**.

"How often did this happen" and "how often do we currently say this happened" are two different
questions, and only the second can be answered by a mutable table. A view over `downtime_reports`
was considered and rejected: no projection of a mutable table is immutable, so it would inherit the
defect with none of the cost saved.

Both readings now ship, on one page, from two tables — Availability / Schedule / Performance Loss
from `downtime_reports`, Others from this log. **They are allowed to disagree**; that is the point of
the split. Nobody knows by how much, which is what the second test below is for.

#### Grain and key

One row per downtime **event**, as logged. Upsert key `event_id` (`pk_downtime_log_events`).

| Column                                      | What it feeds on screen                                  | Notes                                                                                           |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `event_id text`                             | nothing directly — it is the identity behind every count | **Deterministic, from the Silver event.** The whole primary key. See §2.1 and the note below.   |
| `work_unit_id`, `shift_date`, `shift`       | the join to the shift report                             | `shift_date` is the **shift's business day**, per §3.1 — not a calendar day and not an instant. |
| `reasons text[]`                            | one bar per element                                      | **Every element counts.** See below — this is the column with the most rules on it.             |
| `category oee.operation_type`               | nothing today                                            | Nullable and **unread**: Others counts every stop. Carried so a later cut costs no migration.   |
| `work_unit_name`                            | the machine behind the bars                              | **NOT NULL.** A Pareto row that cannot name its machine is not one.                             |
| `work_unit_code`, `work_center_*`, `area_*` | nothing today                                            | Nullable, carried because free on an empty table — 0006's argument.                             |
| `time_zone varchar(64)`                     | nothing directly                                         | The IANA zone `shift_date` was cut in. **The only record of how the day was cut** — see below.  |

#### `reasons` is a `text[]`, and it is §3.3.1's ask rather than a second jsonb array

[§3.3.1](#331-reason-wants-to-be-a-column-not-a-jsonb-array) asks for `downtime_reports.reason` to
stop being a jsonb array. Shipping a brand-new table with the shape this document asks you to delete
would be indefensible, so it does not. `text[]` answers all three of §3.3.1's complaints, and it
answers them **because this is a different read**:

- **"The grouping key is an expression over jsonb."** Here the grouping key is `unnest`'s output — a
  plain `text`, comparable and indexable, not `reason#>>'{0}'`. §8 measured that expression at
  2799 ms against 2111 ms for a real `text` column.
- **"Element order is load-bearing."** It is **irrelevant** here, because this read counts _every_
  element rather than element 0. §3.3.1's second complaint exists precisely because `->> 0` discards
  the tail; nothing is discarded here.
- **"Non-string elements degrade silently."** They are **not representable**: the element type is
  `text`, so the database rejects at write time what the jsonb reader has to guard against at read
  time.

So this is not a jsonb array in disguise. And §3.3.1's own preferred fix — a scalar
`primary_reason text` — would be the **wrong shape here**, because a stop genuinely carries several
reasons and this chart genuinely counts all of them. `reasons text[]` and `primary_reason text` are
the same lesson applied to two different questions; asking for both is consistent.

#### `'{}'` means unattributed, and it is the only way to say it

`ck_dtle_reasons` rejects NULL and blank elements, so "no reason was recorded" has **exactly one**
representation and cannot be confused with "a reason that happens to be empty". Contrast
`downtime_reports.reason`, where `'[]'`, `'[""]'`, `'["   "]'` and a non-string element all mean the
same thing and the reader has to fold four shapes into one.

Two further rules:

- **There is no `DEFAULT` on the column**, unlike `downtime_reports.reason DEFAULT '[]'`. A model
  that forgets it must **fail the load** — with a default it would instead mark every stop
  unattributed, inflating exactly one bar to 100% while every real reason vanished, and nothing
  anywhere would error.
- **Trim your elements.** `ck_dtle_reasons` rejects blanks but not `'  Machine_Stop  '`; the reader
  trims, so the fold is safe, but the untrimmed test below is what keeps it honest.

#### A duplicated element counts once — but do not write one

The reader explodes with `SELECT DISTINCT event_id, reason`, so `{Material_Jam, Material_Jam}`
contributes 1. That makes a duplicate harmless, not correct: it is still an untruth about the event,
and there is no constraint against it. The warn-severity test below reports them.

#### The table carries NO duration, and one rule follows from that

No `duration`, no `start_at`, no `end_at`, and no instant of any kind. Two classes of arithmetic
disappear with them, and one obligation moves to you:

- **Nothing can be clipped.** `DowntimeReaderRepository.clipped` computes
  `LEAST(coalesce(end_at, now), window.to) - GREATEST(start_at, window.from)` precisely because a
  stop straddles a shift boundary and its **minutes** have to be split. A count cannot be split.
- **So assign each event to exactly ONE `(work_unit_id, shift_date, shift)`.** Whichever side of
  midnight a boundary-crossing stop is filed under, its contribution is 1. The single-column primary
  key is the only mechanical guard: an event written under two shift assignments conflicts on the
  second write.
- **There is no open-stop case.** `coalesce(end_at, now())` has no analogue; a stop still in progress
  is already one event.

The honest cost, filed in [Open risks](#open-risks): with no instant on the row, the shift assignment
is not auditable from the data — `event_id` is the only route back to Silver. A nullable
`occurred_at timestamptz` was deliberately left out on §3.3's ground, which is that a second
representation of one fact eventually disagrees with the first. It stays cheap to add while the table
is empty; ask if you want it.

#### Canonical reasons — the reader trims but does not case-fold

`'Machine_Stop'` and `'machine stop'` are two bars. Same stability ask §3.8 makes of
`reject_count_wu_shift.reason`, and for the same reason: a renamed vocabulary is a data migration
rather than a model change. **Tell us if it changes.**

#### NEVER `UPDATE` and NEVER `DELETE` a row here

Append-only is not an optimisation, it is the table's reason to exist. If a stop is corrected
upstream, write a new event or reload from Silver **under the same `event_id`**; do not mutate the log
to match a corrected report. `0009`'s row-level audit trigger is what will say so if this is ever
broken.

#### dbt config — and note the difference from §3.8

```yaml
{
  {
    config(
    materialized='incremental',
    unique_key='event_id',
    incremental_strategy='merge',
    ),
  },
}
```

**A naive `merge` is fine here**, unlike on `reject_count_wu_shift`: nothing on this table is
`GENERATED`, so there is no column a merge can fail on. `delete+insert` scoped on `shift_date` is
equally acceptable if the run window is the natural unit. This is said explicitly so nobody copies
§3.8's `delete+insert` note and assumes a generated-column trap that does not exist.

#### Three dbt tests — two at `error`, one at `warn`

```sql
-- 1. ERROR. No element is NULL, blank, or untrimmed.
--    ck_dtle_reasons enforces the first two, through an IMMUTABLE function --
--    because a CHECK admits no subquery. Postgres does NOT re-validate a CHECK
--    when the body of a function it calls is replaced, so this test is the
--    DURABLE half of that guard. The untrimmed case is not constrained at all and
--    would render two bars for one reason.
SELECT event_id
  FROM {{ this }}
 WHERE EXISTS (
   SELECT 1 FROM unnest(reasons) AS e(v)
    WHERE v IS NULL OR btrim(v) = '' OR v <> btrim(v)
 )

-- 2. ERROR. THE NUMBER NOBODY KNOWS, and the analogue of §3.8's second test.
--    Two tabs on ONE page now count the same physical stops through two tables:
--    Others from this immutable log, Availability/Schedule/Performance Loss from
--    the operator-mutable oee.downtime_reports. They are ALLOWED to disagree --
--    that is the point of the split -- but the magnitude is unmeasured. This is
--    what turns "they differ" into "they differ by X".
--    It compares per-shift COUNTS, which is the best it can do until
--    source_event_id is populated (§3.3.2); with that field it becomes an exact
--    anti-join and says which stops are missing rather than how many.
SELECT e.work_unit_id, e.shift_date, e.shift,
       count(*) AS logged_events,
       (SELECT count(*)
          FROM oee.downtime_reports d
         WHERE d.work_unit_id = e.work_unit_id
           AND d.shift        = e.shift
           AND (d.date AT TIME ZONE e.time_zone)::date = e.shift_date) AS reported_stops
  FROM {{ this }} e
 GROUP BY 1, 2, 3
HAVING count(*) IS DISTINCT FROM (
         SELECT count(*)
           FROM oee.downtime_reports d
          WHERE d.work_unit_id = e.work_unit_id
            AND d.shift        = e.shift
            AND (d.date AT TIME ZONE e.time_zone)::date = e.shift_date)

-- 3. WARN. A reason repeated inside one row. The reader counts it once, so this is
--    not an error -- it is a claim about an event that is not true.
SELECT event_id
  FROM {{ this }}
 WHERE cardinality(reasons) <> cardinality(ARRAY(SELECT DISTINCT unnest(reasons)))
```

Test 2 will fail on day one, and that is the point, exactly as it is for §3.8's second test. Report
the number rather than suppressing it, and before deciding whether it is a threshold, a bug in this
model, or a bug in `downtime_reports`.

---

---

## 4. The watermark — `oee.etl_watermarks`

Created by `0005_oee_etl_watermarks.sql`. **dbt stamps it**, one row per Gold table, upserted per
run.

### Why it exists

Two shipped features currently answer a question they cannot answer, and both fail in the
flattering direction:

- An empty `downtime_reports` result renders as a **full-width green RUN_TIME band**. A shift that
  was down for hours and a shift whose rows have not loaded yet look identical (§8).
- An empty `product_count_wu_shift` result renders "No product output recorded for this shift" —
  the same text a genuinely idle machine gets (§14).

Neither is resolvable from the data: a machine that ran a product with `total_out = 0` is
legitimate. The missing fact is _about_ the data — has the pipeline reached this day yet?

### The post-hook

Add to every Gold model. This is verified SQL — it was run against a real Postgres 18 before
being written here:

```sql
{{ config(post_hook="
  INSERT INTO oee.etl_watermarks AS w
    (table_name, last_run_at, last_business_date, rows_total, run_id, writer)
  SELECT '{{ this.identifier }}', now(), max(business_date), count(*),
         '{{ invocation_id }}', 'dbt'
    FROM {{ this }}
  ON CONFLICT (table_name) DO UPDATE SET
    last_run_at        = EXCLUDED.last_run_at,
    last_business_date = EXCLUDED.last_business_date,
    rows_total         = EXCLUDED.rows_total,
    run_id             = EXCLUDED.run_id,
    writer             = EXCLUDED.writer
") }}
```

Until §3.1 lands there is no `business_date` column, so substitute per table:

| Table                         | `last_business_date` before §3.1                         |
| ----------------------------- | -------------------------------------------------------- |
| `product_count_wu_shift`      | `max(shift_date)` — already a real `date`                |
| `product_count_wu_day`        | `max(date)` — already a real `date`                      |
| `product_perf_wu_hour`        | `max(business_date)` — already a real `date`             |
| `reject_count_wu_shift`       | `max(shift_date)` — already a real `date`                |
| `downtime_log_events`         | `max(shift_date)` — already a real `date`                |
| the four `timestamptz` tables | `max((date AT TIME ZONE '{{ var("plant_tz") }}')::date)` |

`product_perf_wu_hour` is the reason this row matters more than the others: its watermark is what
lets the shift report's performance chart say **"not loaded yet"** instead of drawing an empty chart
that reads as an idle machine. Without the row, that chart becomes the **third** surface to fail in
the flattering direction, alongside the timeline and the SKU card described above.

**`reject_count_wu_shift` needs this row more than any other table does.** Its watermark is the
only thing separating "this machine rejected nothing" from "the reject model has never run", and
until you run it the second is true of every shift — so the tab is written to say so. Without the
row the screen stays honest; with rows but no row here, it starts calling every loaded shift
unloaded.

**`downtime_log_events` needs it for exactly the same reason**, and the sentence transfers word for
word with two nouns changed: its watermark is the only thing separating "nothing stopped this
machine" from "the event log has never run", and until you run it the second is true of every shift.

`table_name` is constrained by a `CHECK` to the nine real table names. That is deliberate:
`{{ this.identifier }}` resolves to the **dbt model name**, and the models being ported are still
called `machine_shift_report` / `line_shift_report` / `sku_daily_report`. Without the check, a
renamed-but-not-repointed model would write a watermark under a key no reader looks at, and
nothing would fail. **If your insert is rejected, the model name is wrong, not the check.**

`rows_total` is a whole-table count, not rows written by the run — dbt does not expose an
affected-row count to a post-hook. Freshness comes from `last_run_at`.

A **missing row means "never loaded"**, which is why nothing is seeded.

---

## 5. Write attribution — set `application_name`

`0004_oee_write_audit.sql` adds `oee.write_audit` and a trigger pair per table — `0006`, `0007`,
`0008`, `0009` and `0010` each carried the pair for the table they added, so **twelve** tables are
audited today. Every writer is recorded with `current_user`, `application_name`, client address and
timestamp.

**Please connect with a distinct `application_name`** — e.g. `dbt-gold` — otherwise both writers
appear identically and the audit trail cannot separate a pipeline load from an operator edit.

For reference, the names this service reports:

| `application_name`         | What it means                                                       |
| -------------------------- | ------------------------------------------------------------------- |
| `mes-oee-monitor-gold`     | Ordinary reads. The overwhelming majority of its connections.       |
| `mes-oee-monitor-operator` | A **named operator mutation**, set per transaction via `SET LOCAL`. |
| `api-gold-migrate`         | `scripts/migrate.mjs` applying a migration.                         |

So `SELECT * FROM oee.write_audit WHERE application_name = 'mes-oee-monitor-operator'` lists every
operator write **still within retention** — see §5.1, which also says where to look for the trail
that is kept permanently.

For dbt, set it in `profiles.yml`:

```yaml
outputs:
  gold:
    type: postgres
    # ...
    search_path: oee
    application_name: dbt-gold
```

Cost is negligible and deliberately asymmetric: **INSERTs are audited once per statement**, not
per row, because at the 500-work-unit target the pipeline writes ~18M `downtime_reports` rows a
year and auditing each would double that write volume to record nothing anyone reads. UPDATEs and
DELETEs are audited per row, carrying the primary key, because those are the operator path.

### 5.1 `write_audit` is partitioned by month, and pruned after a year

`0012_oee_write_audit_partitioned.sql` turned `oee.write_audit` into a table partitioned by RANGE on
`at`, one partition per month. **Nothing about how you write to it changes** — you insert into
`oee.write_audit` exactly as before, or rather you do not insert at all, because the triggers do it
for you. Two things are worth knowing anyway.

**Retention is twelve months, for every writer including the operator.** Earlier drafts of this
section proposed keeping operator rows forever, and that was reversed on a fact: those rows are not
the durable record, and never were. The permanent operator trail is in two other tables, neither of
which is pruned by anything, and both of which carry strictly more than `write_audit` does:

| Table                                        | What it keeps                                                 |
| -------------------------------------------- | ------------------------------------------------------------- |
| `oee.work_unit_shift_report_approval_events` | `by_subject`, `by_name`, `from_status`, `to_status`, `at`     |
| `oee.downtime_report_history`                | `changed_by`, `field`, `old_value`, `new_value`, `changed_at` |

`write_audit` says "the operator role touched a row"; those two say who changed which field from
what to what. **If you need to reason about an operator override — which §13 requires you to — read
`downtime_report_history`, never `write_audit`.** The latter is an incident-forensics log for the
question "which database user wrote this, from where", which has a short useful life.

Pruning is `SELECT * FROM oee.prune_write_audit()` — it drops whole partitions rather than deleting
rows, and returns what it dropped with a row count. **Nothing runs it on a schedule yet**: `pg_cron`
is not installed on this cluster, which is bundled into the request in §6.

**The one hazard, and it is yours as much as ours.** A partitioned table _rejects_ an insert for
which no partition exists, and twelve tables' triggers write here — so a missing month would not
degrade the audit log, it would **fail every write to Gold, your loads included**. `0012` therefore
creates a DEFAULT partition as the guard, plus monthly partitions thirteen months back and twelve
forward. A row for an uncovered month lands in DEFAULT instead of raising.

That safety net has a cost worth checking occasionally, because Postgres refuses to attach a new
partition whose range overlaps rows already sitting in DEFAULT:

```sql
SELECT * FROM oee.write_audit_default_backlog();
```

A non-empty result means that month's partition can no longer be created with one DDL statement —
those rows have to be moved first. Empty is the expected state.

---

## 6. Proposed database roles

Today every connection is the `webadmin` superuser with a blank `application_name`, and **no table
in the `oee` schema carries any grant at all** — checked 2026-08-26, `relacl` is NULL on all 14.
Requested of whoever administers the cluster:

| Role      | Grants                                                                                                                                                                  | Used by           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `oee_etl` | `INSERT`, `UPDATE`, `DELETE` on the **pipeline-owned** tables; `USAGE` on the sequences                                                                                 | Airflow / dbt     |
| `oee_app` | `SELECT` on `oee.*`; `UPDATE` on the mutation columns of `downtime_reports`; **`INSERT`, `UPDATE` on the three operator-owned tables**, plus `USAGE` on their sequences | `mes-oee-monitor` |

**The `oee_app` row previously read "`SELECT` on `oee.*`; `UPDATE` on the mutation columns only",
and that grant cannot execute the features this service now ships.** Approving a report inserts
into `work_unit_shift_report_approvals` and `work_unit_shift_report_approval_events`; editing a
downtime will insert into `downtime_report_history`. All three are tables this service owns
outright, so the `INSERT` is not a widening of its reach into pipeline data — but implemented as
originally written, the first approve would fail at the database with a permission error.

`oee_etl` is narrowed in the same amendment: `oee.*` would have given the pipeline write access to
the three operator-owned tables, which [§12](#12-what-0010-adds--and-why-there-is-nothing-for-you-to-do) exists to prevent.

**Amended 2026-08-25.** `oee_etl` needs **`SELECT` on `oee.downtime_report_history`** — the override
join in [§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model) reads it on every
run. Narrowed as originally written, that join fails with a permission error the first time the
model runs, which is at least loud. `INSERT`, `UPDATE` and `DELETE` on that table stay off the
pipeline's grant, which is the half worth keeping.

This is what makes §5 trustworthy — an `application_name` is self-reported, a role is not.

### 6.1 Also requested: `pg_cron`

Checked on this cluster and **not installed** — neither is `pg_partman`. `webadmin` is a superuser,
so the failure is genuinely "the extension is absent", not a permissions problem.

It is wanted for one job: `SELECT * FROM oee.prune_write_audit()` monthly, which is what makes §5.1's
twelve-month retention actually happen rather than merely being documented. Until it exists somebody
runs that by hand, and the consequence of forgetting is an audit table that grows without bound —
slow, not dangerous.

Bundled here rather than filed separately because it goes to the same administrator as the roles
above, and asking twice is worse than asking once.

---

## 7. `poc-flink-v2` — NOT being ported (kept as a vocabulary map only)

> **This section is obsolete as an instruction.** It was written on the assumption that
> `molca-id/poc-flink-v2` would be ported to this vocabulary. It will not be: the pipeline owner has
> confirmed it is an older implementation for a **different project**, and a **new pipeline is being
> written for `mes-oee-monitor`** (§16.10 Q10). Nothing below should be read as "do this". The table
> is retained because the vocabulary mapping is still a useful Rosetta stone when someone reads the
> old models, and because the DAG schedule note underneath it is independently true.
>
> In particular, **do not port `line_shift_report`** — see the note at the end of this section.

`molca-id/poc-flink-v2` implements a similar pipeline for the previous vocabulary. The mapping,
for reference only:

| In `poc-flink-v2`                                 | Here                                    |
| ------------------------------------------------- | --------------------------------------- |
| `103.185.38.172:5442`, db `gold`, schema `public` | `mes-master-data` cluster, schema `oee` |
| `dbt_project.yml` → `name: 'ajinomoto_gold'`      | scoped to the `work_unit` vocabulary    |
| `machine_shift_report`                            | `work_unit_shift_reports`               |
| `line_shift_report`                               | no direct equivalent — see note below   |
| `sku_daily_report`                                | `product_count_wu_day`                  |
| `line` / `machine`                                | `work_center` / `work_unit`             |

`report_shift_aggregation_dag.py` already runs `0 0,8,16 * * *` for shifts ending 07:00 / 15:00 /
23:00 WIB, which matches `SHIFT_WINDOWS` in `apps/api/src/module/downtime/downtime.ts` exactly.
No change needed there.

**Note on line-level grain — SETTLED, AND THE ANSWER IS §16.** This note used to say "do not port
`line_shift_report` until that is settled". It is settled twice over: the grain now exists, and the
porting question is moot because nothing is being ported (see the banner above). `0014` adds
`oee.work_center_{shift,day,month}_reports`, and §16 is the specification. Read it before porting
anything, because the target's keys and its unit rule both differ from `line_shift_report`'s — and
§16.10 Q10 asks you to check one thing about the old model specifically: if it averages rates, or
divides by wall clock rather than by machine-time, **do not port it.**

What is NOT settled is the SKU half, and the distinction is the whole reason `0014` was possible.
The OEE measures roll up across machines cleanly — durations and counts add, rates are recomputed
from the sums. Per-product counts do not: `factor_to_base` differs per product, so summing across
work units has to happen after conversion to the base unit, and the "Finish Good stays in its
production unit" rule stops being expressible once two machines count the same SKU in different
units. So `sku_daily_report` at line grain remains an open product question, and `0014` does not
answer it — these three tables carry no per-product rows at all.

---

## 8. Store decision — measured 2026-08-13

**Verdict: keep plain Postgres. Do not move Gold to a TimescaleDB columnstore.** If ad-hoc BI
becomes a real requirement, mirror only the two large tables into ClickHouse for BI and leave
serving and mutations where they are.

This reverses the expectation the benchmark set out to confirm. The columnstore was the favourite
going in — same SQL, same driver, already in the stack for Bronze/Silver, and named for Gold by the
KAIDO spec. It measured badly enough on the paths this product actually uses that the assumption
did not survive.

### Method

One year at 500 work units, generated deterministically (no `random()`, so every engine got
identical data): 547,500 shift reports, 1,642,500 product-count rows, **18,067,500 downtime rows**.
Both Postgres variants ran on **the same TimescaleDB PG17 server** — same binary, same settings —
so the only variable between them is heap versus hypertable-plus-columnstore. Median of 7
server-side timings via `\timing`, after one discarded warm-up, so client startup is excluded.
Queries A-E are the real ones this API issues; F-H are representative ad-hoc BI.

### Storage

| Table                            | plain PG | Timescale columnstore | ClickHouse   |
| -------------------------------- | -------- | --------------------- | ------------ |
| `downtime_reports` (18.07M rows) | 3551 MB  | **158 MB** (22x)      | 304 MB (12x) |
| all three tables                 | 4112 MB  | **270 MB** (15x)      | –            |
| bulk load time                   | 133 s    | 168 s                 | **7 s**      |

### Latency (median ms)

| Query                                             | plain PG | Timescale      | ClickHouse   |
| ------------------------------------------------- | -------- | -------------- | ------------ |
| A — By Shift list (month + shift + 10 work units) | **0.8**  | 5.1 (6x)       | –            |
| B — the matching count                            | **0.7**  | 4.0 (6x)       | –            |
| C — report detail by id                           | **0.4**  | **91 (228x)**  | 4            |
| D — product-count join for one report             | **0.8**  | **770 (960x)** | –            |
| E — downtime overlap for one shift                | 5.8      | **2.3 (0.4x)** | 4            |
| F — BI: OEE trend by work center, 12 months       | **89**   | 96             | –            |
| G — BI: downtime Pareto, plant-year               | 2799     | 2660           | **390 (7x)** |
| H — BI: SKU output by month                       | 338      | **321**        | –            |
| approve 1,000 shift reports (UPDATE)              | **94**   | 126            | 392*         |
| edit 1,000 downtimes (UPDATE)                     | **15**   | 728 (47x)      | 219*         |

\* ClickHouse mutations, forced synchronous with `mutations_sync=2`. They are **asynchronous by
default**, which is the real problem — see below.

### Why the columnstore loses

Two independent effects, both isolated by measurement:

1. **Chunk fan-out.** `GET /work-units/shift-reports/:id` looks a report up by its surrogate id and
   nothing else — the URL carries no date. On a hypertable there is no partitioning column in that
   predicate, so no chunk can be excluded: the plan referenced **39 chunk nodes**. Adding a
   one-month date predicate to the same lookup dropped it from 96 ms to 16 ms. The API cannot
   supply that date without changing the route, so this penalty is structural, not a tuning
   mistake.
2. **Decompression on the hot path.** Even with chunk exclusion working, the same lookup was 16 ms
   against 0.4 ms on the heap — 40x — because the row lives in a compressed columnar chunk.

A "compress only chunks older than 30 days" policy would soften effect 2 for recent data, but not
effect 1, and every report older than the window pays both. Meanwhile the upside never arrived:
**the three BI queries were a wash** (-5% to +8%). These are aggregate tables of a few hundred
megabytes; plain Postgres already scans them fast, and columnar storage had nothing to win back.

Timescale also forces a schema change: every unique index must contain the partitioning column, so
`work_unit_shift_reports_pkey` and `downtime_reports_pkey` have to widen to `(id, date)` and
`(id, start_at)`.

### Where the real BI ceiling is

The one genuinely slow query is the plant-year downtime Pareto at **2.8 s**, and ClickHouse does it
in **390 ms (7x)**. That is a real gap, and it is the only result that argues for a columnar engine
at all. Two things to know before reaching for one:

- **`jsonb` is a minor part of it.** Grouping on a plain `text` column instead of extracting
  `reason#>>'{0}'` took the Pareto from 2799 ms to 2111 ms — about 25%. The remaining 2.1 s is
  scanning 3.5 GB. Normalising `reason` is worth doing, but it is not the fix.
- **ClickHouse is not disqualified on latency.** Its point lookup by id was 4 ms and its mutations
  0.2-0.4 s, both usable. It is disqualified for the _serving_ role on semantics: mutations are
  asynchronous by default, so an operator who approves a report and immediately reloads can read
  the old value, and there are no transactions to update a row and write its audit entry atomically.
  Approvals need read-after-write; BI does not.

### Recommendation, in order

1. **Stay on plain Postgres** for all seven tables. Every query this API issues is under 1 ms, and
   both mutation paths are under 100 ms.
2. **Before considering another engine**, take the cheap wins: normalise `reason` out of `jsonb`
   (~25% of the Pareto), add the range index in §10, and add monthly roll-up tables if BI settles
   on a few known shapes. Any of these beats a migration.
3. **If ad-hoc BI becomes a firm requirement**, mirror **only** `downtime_reports` and
   `product_perf_wu_hour` into ClickHouse, served by the same dbt project. Serving and
   mutations stay in Postgres. That buys the 7x where it matters and touches no shipped read path.
   `product_perf_wu_hour` projects to roughly **6.6M rows/year** (500 work units × 24 h × 365 d ×
   ~1.5 products per hour) — about a third of `downtime_reports`, so it is the second table worth
   mirroring and small enough that recommendation 1 is unaffected. Its `loaded_at` column exists so
   that mirror can be extracted incrementally without CDC.
4. **Revisit when row counts approach the projection.** The live table held 8 rows on 2026-08-13.

### Caveats

Synthetic data is more regular than production, so all three compression ratios are optimistic.
Both Postgres variants ran on PG17 (production is 18.4). One year at 500 work units — ratios should
hold as volume grows, absolutes scale roughly linearly. Only `downtime_reports` was loaded into
ClickHouse, so its column is partly blank by design: the point was to size the BI ceiling and the
mutation semantics, not to port the whole schema.

---

## 9. What changed in `0006`

`0006_oee_product_perf_wu_hour.sql` swaps one table for another. **Read this before your next
model run.**

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| **Added**   | `oee.product_perf_wu_hour` — work unit × local hour × product                  |
| **Dropped** | `oee.work_unit_perf_analytics` (and its audit triggers, and its watermark row) |
| **Altered** | `ck_etl_watermarks_table` — same seven names, one substituted                  |

### Why the swap rather than a fix in place

`work_unit_perf_analytics` was keyed on an arbitrary `start_time..end_time` interval. Five things
followed, and all five are fixed by re-graining rather than by adding columns: nothing forbade two
rows overlapping, so no aggregate over it was safe; it had no natural key, so it was half of §2.1;
it carried no business day and no shift, so "one shift of one work unit" was not expressible; its
measures were `numeric(10,3)` where every sibling table uses `numeric(15,3)` for the same
quantities; and it had no `work_center_id`, so no question above the work unit could be asked
without joining another database.

It had **no reader in this repo** and the whole Gold schema held 8 hand-seeded rows, so this was the
cheapest it will ever be.

### What you need to do

1. **Confirm no `work_unit_perf_analytics` model exists on your laptop.** This is the one thing
   nobody here could check.
2. **Name the new model `product_perf_wu_hour`.** `{{ this.identifier }}` is what
   `ck_etl_watermarks_table` sees; a mismatched name fails the watermark insert loudly, which is
   the point of the check.
3. **Read §3.5** (the master rate, and the `GENERATED`-column trap that breaks a naive `merge`),
   **§3.6** (local-clock bucketing — the highest-risk instruction in this document) and **§3.7**
   (the three tests).
4. `unique_key=['work_unit_id', 'bucket_start', 'product_id']`, `incremental_strategy='delete+insert'`.

The DDL was applied to a throwaway PostgreSQL 18.4 and exercised before this was written: the
generated columns, all ten CHECKs, `ON CONFLICT` idempotency, the audit triggers and both watermark
outcomes. The `merge`-strategy failure in §3.5 is a reproduction, not a prediction.

## 10. What `0008` adds

`0008_oee_reject_count_wu_shift.sql` adds one table and widens one constraint. **Read this before
your next model run**, and read [§3.8](#38-reject_count_wu_shift--what-must-fill-it) before writing
the model.

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| **Added**   | `oee.reject_count_wu_shift` — work unit × shift day × shift × product × reason |
| **Altered** | `ck_etl_watermarks_table` — seven names becomes **eight**                      |
| **Dropped** | nothing                                                                        |

Nothing existing changes shape, so no model you have today breaks. The table is **new and empty**.

### Why a new table rather than columns on `product_count_wu_shift`

That table's grain is `(work_unit, shift_date, shift, product)`. A reject reason is a fifth key
member, so adding one would **re-grain every existing row** — a migration plus a backfill against a
live table, and a silent doubling of every SKU View figure for any consumer that missed the change.
A separate table at its own grain leaves the SKU read untouched, and it is the cheapest this will
ever be: the whole schema still holds a handful of hand-seeded rows.

### What you need to do

1. **Name the model `reject_count_wu_shift`.** `{{ this.identifier }}` is what
   `ck_etl_watermarks_table` sees; a mismatched name fails the watermark insert loudly, which is the
   point of the check.
2. `unique_key=['work_unit_id', 'shift_date', 'shift', 'product_id', 'reason']`,
   `incremental_strategy='delete+insert'`. **Not a naive `merge`** — `converted_value` is
   `GENERATED` and a merge fails on it. §3.8 has the config block.
3. **Write `NULL` weights, never `0`.** §3.8 explains what breaks otherwise, and it breaks in three
   places at once.
4. **Do not write `converted_value`.** Postgres computes it.
5. **Decide what goes in `reason`** — it is a primary-key member and must be stable across runs.
6. **Add the §4 watermark post-hook**, substituting `max(shift_date)`.
7. **Add the two tests in §3.8.** The second one will fail on day one; report the number rather than
   suppressing it.
8. **Tell us the base-unit story.** If a work unit's counters can convert to more than one base
   unit, the converted column stops being comparable and the screen says so — see §3.8. We would
   rather know now than render an em dash at a supervisor.

The DDL was applied to a throwaway PostgreSQL and exercised before this was written: the generated
column rejects an explicit assignment, all six `CHECK`s reject the rows they are meant to,
`ON CONFLICT` on the five key columns restates rather than duplicates, both audit triggers fire
(statement-level for `INSERT`, row-level with the full composite key for `UPDATE`/`DELETE`), and the
widened watermark check accepts `reject_count_wu_shift` while still rejecting a typo of it.

---

---

## 11. What `0009` adds

`0009_oee_downtime_log_events.sql` adds one table plus one helper function, and widens one
constraint. **Read this before your next model run**, and read
[§3.9](#39-downtime_log_events--what-must-fill-it) before writing the model.

|             |                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------ |
| **Added**   | `oee.downtime_log_events` — one machine stop, as logged (immutable)                              |
| **Added**   | `oee.text_array_has_blank(text[])` — an `IMMUTABLE` helper, because a `CHECK` admits no subquery |
| **Altered** | `ck_etl_watermarks_table` — eight names becomes **nine**                                         |
| **Dropped** | nothing                                                                                          |

Nothing existing changes shape, so no model you have today breaks. The table is **new and empty**.

### Why a new table rather than reading `downtime_reports`

That table is the one operators edit (§1 rule 2), so a frequency Pareto over it moves when a stop is
corrected — and a count of what happened cannot depend on what someone currently says about it. On
top of that, §2.1 means `downtime_reports` is loaded `DELETE`-then-`INSERT`, so every `id` changes on
every run; counting rows whose identity is re-minted nightly is not counting. A view was considered
and rejected: no projection of a mutable table is immutable.

### What you need to do

1. **Name the model `downtime_log_events`.** `{{ this.identifier }}` is what
   `ck_etl_watermarks_table` sees; a mismatched name fails the watermark insert loudly, which is the
   point of the check.
2. `unique_key='event_id'`. **A naive `merge` is fine here** — nothing on this table is `GENERATED`,
   unlike `reject_count_wu_shift` (§3.8). `delete+insert` scoped on `shift_date` is equally
   acceptable. §3.9 has the config block.
3. **Carry a deterministic `event_id` from the Silver event.** It is the whole primary key. **Write
   the same string into `downtime_reports.source_event_id`** (§3.3.2) and §2.1 closes on both tables
   at once — that is one field, and it is also what makes test 2 below able to say anything precise.
4. **Write `reasons` as a real `text[]`** — one element per reason recorded, no NULL and no blank
   elements, trimmed, `'{}'` for a stop with no reason attributed. Do not write duplicates.
5. **Assign each event to exactly ONE `(work_unit_id, shift_date, shift)`.** The table carries no
   timestamps, so nothing can clip a boundary-crossing stop and nothing can re-derive the day. §3.9
   explains why the single-column primary key is the only mechanical guard.
6. **Never `UPDATE` and never `DELETE` a row here.** Append-only is not an optimisation, it is the
   table's reason to exist. The row-level audit trigger will say so if it happens.
7. **Use the canonical reason vocabulary.** The reader trims; it does not case-fold, so
   `'machine stop'` and `'Machine_Stop'` are two bars.
8. **Add the §4 watermark post-hook**, substituting `max(shift_date)`. Without it the Others tab says
   "not loaded yet" however many events you write.
9. **Add the three tests in §3.9.** The second will fail on day one; report the number rather than
   suppressing it.
10. **Tell us whether a stop can legitimately carry no reasons, and how often.** That is what the
    Unspecified bar actually means, and we would rather know now than explain it to a supervisor.
11. **Tell us if you want `occurred_at`.** It was deliberately left out (§3.9) and is cheap to add
    while the table is empty. Ask before it stops being cheap.

**The DDL has been APPLIED and READ but not yet exercised.** It is live on the dev Gold database and
the Others tab renders from it (TODOS.md §30 records the walkthrough), so the table, the helper
function, the index and the watermark row all work for the read path. **That proves nothing about
what the table REJECTS**, and every guard in `0009` is about rejection — so this is deliberately not
the paragraph `0008` and `0009`'s equivalents carry. What a first proper run on a **throwaway** still
owes: every `CHECK` rejecting the rows it must (**especially `ck_dtle_reasons`, whose predicate lives
in a function precisely because the inline form is illegal, and `ck_dtle_reasons_1d`, which must admit
`array_ndims('{}')` being NULL**), `ON CONFLICT (event_id)` restating rather than duplicating, both
audit triggers firing, and the widened watermark check accepting `downtime_log_events` while still
rejecting a typo of it. The dev seed carries commented-out blank-element and 2-D blocks for exactly
that.

---

---

## 12. What `0010` adds — and why there is nothing for you to do

`0010_oee_shift_report_approvals.sql` adds two tables:

| Table                                    | Grain                                 | Written by                 |
| ---------------------------------------- | ------------------------------------- | -------------------------- |
| `work_unit_shift_report_approvals`       | one work unit × shift (current state) | **`mes-oee-monitor` only** |
| `work_unit_shift_report_approval_events` | one approval transition               | **`mes-oee-monitor` only** |

**Neither is part of the nine, and this section asks nothing of you.** It exists so that when you
see two new tables in `oee`, you know they are not yours and know why.

### Do not model these

- **No dbt model, no source, no snapshot, no test.** They hold no data derived from Silver.
- **No `etl_watermarks` row.** `ck_etl_watermarks_table` was _deliberately not extended_ to include
  them, so a `post_hook` stamping `{{ this.identifier }}` for a model of either name **fails
  loudly**. That is intentional: it is the mechanical version of this paragraph. If your watermark
  insert is rejected with `ck_etl_watermarks_table`, you have a model pointed at a table this
  service owns — the fix is to remove the model, not to amend the constraint.

### What they are for, briefly

Approving a shift report is one of the two named operator mutations in [§1 rule 2](#1-who-writes-what).
It moves a report `open → closed` and records who did it and when.

### The one thing that concerns you, and it is a warning

Approval state is keyed on **`(work_unit_id, date, shift)`** — the columns of
`wu_shift_report_key` — and deliberately **not** on `work_unit_shift_reports.id`.

That is a defence against your loader, and it is worth being explicit about why:

- `work_unit_shift_reports.id` is a `serial` you do not supply. A **`delete+insert`** load — which
  [§9](#9-what-changed-in-0006) recommends to you for `product_perf_wu_hour`, and which
  [§2.1](#21-the-idempotency-gap--read-this-before-the-first-backfill) mandates for
  `downtime_reports` — deletes the row and re-inserts it with a **new id**.
- Had approval state been columns on that row, such a load would have **silently destroyed an
  operator's approval** and broken every deep link at the same time. Nothing would error; the
  report would simply read "open" again.
- Keyed on the natural key, the approval **reattaches** to the restated row. Your loader can
  restate `work_unit_shift_reports` as often as it likes.

**So the ask is only this: keep upserting `work_unit_shift_reports` on `wu_shift_report_key`, as
[§2](#2-per-table-grain-and-upsert-key) already says.** If that key is ever changed, or a row is
re-keyed to a different `(work_unit_id, date, shift)`, its approval orphans — harmlessly, but
invisibly. Tell us before changing it. To find orphans:

```sql
SELECT a.* FROM oee.work_unit_shift_report_approvals a
 WHERE NOT EXISTS (SELECT 1 FROM oee.work_unit_shift_reports r
                    WHERE r.work_unit_id = a.work_unit_id
                      AND r.date = a.date AND r.shift = a.shift);
```

---

## 13. Editing a downtime — the one change you must make to your model

**This is the only section in this document that asks you to change a model you have already
written, and it is not optional.** Everything else here is a request for a column or a test. This
one describes a way your next ordinary run will destroy an operator's work, silently, with nothing
in any log to show it happened.

`mes-oee-monitor` now ships the second of the two named operator mutations in
[§1 rule 2](#1-who-writes-what): `PATCH /api/v1/downtimes/:sourceEventId` changes a stop's
`category`, `reason`, `detail_reason` and `actions`. It writes one row per changed field into
`oee.downtime_report_history` — a table [§2](#2-per-table-grain-and-upsert-key) already tells you not
to touch — inside the same transaction as the `UPDATE`.

### The problem, in four lines

1. An operator corrects a stop: `category` UNPLANNED → PLANNED. The `UPDATE` lands.
2. Your next run loads `downtime_reports` from Silver, which knows nothing about that correction.
3. [§2.1](#21-the-idempotency-gap--read-this-before-the-first-backfill) mandates
   `DELETE`-then-`INSERT` scoped to the run window, so the corrected row is deleted and the
   machine's original values are re-inserted.
4. The chart goes back to what it said before. **Nothing errors.** The operator's correction is gone
   and the only trace is a history row nobody is looking at.

**Switching to an upsert does not fix this.** Once you populate `source_event_id` and the model
becomes `ON CONFLICT (source_event_id) DO UPDATE`, `excluded.category` overwrites the operator's
value just as thoroughly. The load strategy is not the problem; **re-deriving those four columns
from Silver on every run is.**

### What you need to do

**Apply the operator's overrides when you build the row.** The trail is the source of truth for the
four mutable columns; Silver is the source of truth for everything else on the table.

The current override for a stop is the LATEST history row per field:

```sql
WITH latest AS (
  SELECT DISTINCT ON (source_event_id, field)
         source_event_id, field, new_value
    FROM oee.downtime_report_history
   ORDER BY source_event_id, field, changed_at DESC, id DESC
),
override AS (
  SELECT source_event_id,
         (array_agg(new_value) FILTER (WHERE field = 'category'))[1]      AS category,
         (array_agg(new_value) FILTER (WHERE field = 'reason'))[1]        AS reason,
         (array_agg(new_value) FILTER (WHERE field = 'actions'))[1]       AS actions,
         (array_agg(new_value) FILTER (WHERE field = 'detail_reason'))[1] AS detail_reason,
         bool_or(field = 'category')      AS has_category,
         bool_or(field = 'reason')        AS has_reason,
         bool_or(field = 'actions')       AS has_actions,
         bool_or(field = 'detail_reason') AS has_detail_reason
    FROM latest
   GROUP BY source_event_id
)
```

`array_agg(...)[1]` is a pivot, not an aggregate: `DISTINCT ON` has already reduced `latest` to one
row per `(source_event_id, field)`, so there is exactly one value to take.

**And it is `array_agg(...)[1]` rather than the more obvious `max(...)` because THERE IS NO
`max(jsonb)` IN POSTGRES.** `max()` is defined for numbers, text, dates and a few more, not for
jsonb — so the `max()` version of this CTE fails outright with `function max(jsonb) does not exist`.
That is at least a loud failure rather than a silent one, but it costs a debugging session, so it is
called out here. (This document carried the `max()` version briefly; it was corrected once the query
was actually executed against Postgres 16 rather than read.)

Then, in the model that builds `downtime_reports`:

```sql
SELECT s.*,
       CASE WHEN o.has_category
            THEN (o.category #>> '{}')::oee.operation_type
            ELSE s.category END                                   AS category,
       CASE WHEN o.has_reason        THEN o.reason        ELSE s.reason        END AS reason,
       CASE WHEN o.has_actions       THEN o.actions       ELSE s.actions       END AS actions,
       CASE WHEN o.has_detail_reason
            THEN o.detail_reason #>> '{}'
            ELSE s.detail_reason END                              AS detail_reason
  FROM {{ ref('silver_downtime') }} s
  LEFT JOIN override o ON o.source_event_id = s.source_event_id
```

### Three things in that SQL that are easy to get wrong

**`CASE WHEN has_x`, never `COALESCE`.** An operator can legitimately CLEAR `detail_reason` to
nothing, and the endpoint stores that as a jsonb `null`. `COALESCE(o.detail_reason, s.detail_reason)`
would treat "the operator deliberately emptied this" as "the operator said nothing" and put the
machine's text back. The `has_*` flags are the only way to tell an override to NULL apart from no
override at all.

**`#>> '{}'` for the two scalars, never `::text`.** `category` and `detail_reason` are stored as
jsonb STRINGS, so `new_value::text` yields `"PLANNED"` **with the quotes included** and the cast to
`oee.operation_type` fails with a message that points at the enum rather than at the quoting.
`#>> '{}'` extracts the text unquoted. `reason` and `actions` are jsonb arrays already and go
across as-is.

**Join on `source_event_id`, which means this section depends on
[§3.3.2](#332-the-six-columns-migration-0007-added-and-what-must-fill-them).** Until you populate
that column the history table cannot attach to anything, so the endpoint refuses every stop and
there is nothing to override — the override join is correct and inert. **The day you populate it,
this join becomes load-bearing in the same run.** Please land the two together.

### Precedence: the operator wins, and it is worth saying why

If an operator sets `category` to PLANNED and a LATER upstream correction sets it to SMALL_STOP,
this projection keeps PLANNED. That is deliberate. The operator is a human looking at the machine
and correcting the pipeline; a rule that let the pipeline win would make the edit feature pointless
the first time Silver was re-derived. Both values remain visible in
`oee.downtime_report_history` — the old value, the new value, who and when — so nothing is lost,
and a genuine upstream correction that matters can be applied by editing the stop again.

Any override layer has to answer this question. It is answered here, once, so nobody has to infer
it from a `COALESCE`.

### Finding rows where the override was not applied

The reconciliation query, in [§12](#12-what-0010-adds--and-why-there-is-nothing-for-you-to-do)'s spirit. A non-empty result means a run
built these rows without the join above:

```sql
WITH latest AS (
  SELECT DISTINCT ON (source_event_id, field) source_event_id, field, new_value
    FROM oee.downtime_report_history
   ORDER BY source_event_id, field, changed_at DESC, id DESC
)
SELECT d.source_event_id, l.field, l.new_value AS should_be,
       CASE l.field
         WHEN 'category'      THEN to_jsonb(d.category::text)
         WHEN 'detail_reason' THEN to_jsonb(d.detail_reason)
         WHEN 'reason'        THEN d.reason
         WHEN 'actions'       THEN d.actions
       END AS actually_is
  FROM latest l
  JOIN oee.downtime_reports d USING (source_event_id)
 WHERE CASE l.field
         WHEN 'category'      THEN l.new_value #>> '{}' IS DISTINCT FROM d.category::text
         WHEN 'detail_reason' THEN l.new_value #>> '{}' IS DISTINCT FROM d.detail_reason
         WHEN 'reason'        THEN l.new_value IS DISTINCT FROM d.reason
         WHEN 'actions'       THEN l.new_value IS DISTINCT FROM d.actions
       END;
```

Re-applying the projection repairs it. It is idempotent, so running it twice is harmless.

**Every statement in this section has been executed against Postgres 16**, not only written down —
the projection, the reconciliation query, and the round trip of "restate the row, re-apply the
override, confirm it heals" are all asserted in
`apps/api/src/module/downtime/downtime-repository.integration.test.ts`. That is deliberate: the first
draft of this section did not run, and the reason it did not was invisible from reading it.

### One dbt test, at `error` severity

Ship the reconciliation above as a singular test. It is the only mechanical guard that this section
was honoured — the failure mode is a chart that quietly reverts, and no schema constraint can
express "this column should hold what a different table's latest row says".

```sql
-- tests/downtime_overrides_applied.sql
-- Fails if any operator edit is not reflected in downtime_reports. A row here means
-- a run rebuilt the table without the override join in gold-write-contract.md §13,
-- and an operator's correction has been silently discarded.
```

### What is NOT asked of you

- **Do not write `oee.downtime_report_history`.** Read it in the projection above; never insert,
  update or delete. It is `mes-oee-monitor`'s, like the two approval tables.
- **No `etl_watermarks` row for it**, and `ck_etl_watermarks_table` will reject one — the same
  mechanical enforcement [§12](#12-what-0010-adds--and-why-there-is-nothing-for-you-to-do) describes.
- **`downtime_log_events` is untouched by any of this**, and that is the point of it being a separate
  table. [§3.9](#39-downtime_log_events--what-must-fill-it) says never `UPDATE` and never `DELETE`
  there; an operator correcting a stop does not change what was OBSERVED, so the Others tab
  deliberately does not move when the Availability Pareto does.
- **Nothing about recalculation, yet.** Changing a stop's `category` moves time between schedule loss
  and availability loss, so the aggregates in `work_unit_shift_reports` are stale until your next
  run recomputes them. Today the browser simply says so and waits for the scheduled run. A mechanism
  for asking you to recompute one report sooner is sketched in
  [`downtime-edit-trd.md`](downtime-edit-trd.md) and is **not built and not agreed** — please read it
  and tell us whether the shape is workable before anyone implements it.

---

## 14. What `0011` adds — a shape guard that can FAIL YOUR LOAD

`0011_oee_downtime_reason_shape.sql` adds three CHECK constraints to
`oee.downtime_reports` and one `IMMUTABLE` helper function. **Read this one even
though it asks nothing of you, because it changes what happens when a model writes
a malformed label: it used to render a slightly wrong chart, and now it aborts the
statement.**

| Constraint                          | Rejects                                                             |
| ----------------------------------- | ------------------------------------------------------------------- |
| `ck_downtime_reports_reason`        | `reason` that is not a jsonb ARRAY of non-blank strings ≤ 255 chars |
| `ck_downtime_reports_actions`       | the same, on `actions`                                              |
| `ck_downtime_reports_detail_reason` | `detail_reason` longer than 2000 characters                         |

`oee.jsonb_is_label_array(jsonb, int)` is the predicate. It exists because a CHECK
admits no subquery, and it is the jsonb counterpart to
`oee.text_array_has_blank(text[])`, which `0009` added for the same reason on
`downtime_log_events.reasons`.

### Why now, and why this is the same call §3.9 already made

Those two columns were **pipeline-written only** until 2026-08-25, when the
downtime-edit endpoint shipped ([§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model)).
A second writer arrived, and its validation protects itself and nothing else — a
repair script, a `psql` session, or your model bypasses it entirely.

This is deliberately the trade [§3.9](#39-downtime_log_events--what-must-fill-it)
already made for `reasons`, where the column has **no `DEFAULT`** specifically so
"a forgetful model fails the load". It is also what
[§3.3](#33-integrity-on-downtime_reports-10) has been asking for on this very
table: _"inverted rows are currently possible, and this service drops them at
runtime… Rejecting at the source beats counting."_ Same argument, applied to
labels.

### What it will and will not reject

**Tolerated, and each one deliberately:**

- **An empty array.** `[]` is the unlabelled Pareto bucket, which the read path
  handles explicitly.
- **Duplicate elements.** §3.9 records that a duplicate "counts once — but do not
  write one". The reader is specified to cope, so rejecting them here would be a
  contract change dressed as a constraint. The edit endpoint dedupes on the way in;
  the database tolerates what you send.
- **Case variants.** §3.9: the reader "trims but does not case-fold", so
  `Machine_Stop` and `machine_stop` are two reasons by design.
- **`NULL detail_reason`.** That is what "the operator cleared this" looks like, and
  §13's `CASE WHEN` exists to preserve exactly it.

**Rejected:** a non-array value, a non-string element, a blank or whitespace-only
element, a label over 255 characters, a `detail_reason` over 2000.

### What you need to do

1. **Nothing, if your model already writes clean string arrays.** The live table
   was surveyed before the constraint was added — all 17 rows passed, with no
   non-arrays, no non-string elements, no blanks, no untrimmed values and the
   longest array at 3 elements — so it applied without a rewrite.
2. **`btrim` your labels before writing them**, if there is any chance Silver
   carries padding. A trailing space is now an aborted statement rather than a
   duplicate-looking Pareto bar.
3. **Expect a hard failure rather than a bad chart** if a label is empty. That is
   the point, and it is the same behaviour `ck_dtle_reasons` already gives you on
   `downtime_log_events`.
4. **Tell us if 255 or 2000 is too short for anything real.** Both are bounds this
   service chose to match its own input validation, not measurements of your data.

### The bug this closes, which is worth one paragraph

A non-string element did not merely mis-group a bar. `toStringList` drops it on
READ, so the row comes back as `[]` — the browser then sends `[]` as the
optimistic-concurrency baseline for an edit, `reason = '[]'::jsonb` matches
nothing, and **the stop becomes permanently uneditable**, telling the operator on
every attempt that the pipeline reloaded it. The round trip through the read path
is what loses the original, so no guard in the write path could recover it. This
constraint is the only place it can be stopped.

Note that §3.3.1 — replacing `reason` with an indexable `primary_reason text`
column — would make this section, the reader's defensive normalisation and the
constraint all unnecessary at once. If that is on your roadmap, say so and this
becomes throwaway work rather than a foundation.

---

## 15. What `0013` adds — the day and month tables become real, and they need you

**This is the section to read first if you are picking up the `work_unit_*` DAG.** Until now
`oee.work_unit_day_reports` and `oee.work_unit_month_reports` appeared in this document only as two
rows in §2's grain table. `mes-oee-monitor` now reads both — the By Day and By Monthly report
screens — and they are still empty, so those screens render an empty state until your models exist.

Migration `0013` changed both tables while they were empty, precisely so that none of this costs you
a coordinated deploy later.

### 15.1 The misspelling is gone — `availablity_loss_time` → `availability_loss_time`

Both tables spelled it without the second `i`; the shift table always spelled it correctly. `0013`
renamed the two, so **all three report tables now use `availability_loss_time`**.

This document and this repo previously told you the misspelling had to be preserved forever. That
instruction was conditional on something that turned out not to exist — dbt models already writing
those columns. If you have a model in progress that writes `availablity_loss_time`, this is the one
change in `0013` that will break it, and it will break loudly with an "column does not exist" error
rather than silently. **Please say so now if that is the case** and we will reinstate the old name
as a view or reverse the rename; it is cheap today and expensive after your first load.

### 15.2 Five columns added to both tables

| Column             | Type           | Notes                                                                                                         |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `business_date`    | `date`         | The plant-local business day this row summarises. See §15.3.                                                  |
| `time_zone`        | `text`         | IANA zone, e.g. `Asia/Jakarta`. Same value as the one you already write to `reject_count_wu_shift.time_zone`. |
| `work_center_id`   | `integer`      | The line. Denormalised exactly as on `work_unit_shift_reports`.                                               |
| `work_center_name` | `varchar(255)` |                                                                                                               |
| `work_center_code` | `varchar(255)` |                                                                                                               |
| `mttr`             | `bigint`       | Mean time to repair, **milliseconds**. See §15.4.                                                             |
| `mtbf`             | `bigint`       | Mean time between failures, **milliseconds**.                                                                 |

All are nullable in the DDL so the migration was instant, but **the contract is that you write every
one of them.** `work_center_id` in particular: without it the downtime edit dialog cannot scope its
Reason catalogue to the line, and a stop on the filler gets offered a palletiser reason.

### 15.3 What `business_date` must mean, and the day boundary

This is the ask §3.1 already made, now with a definite answer for these two tables.

**A business day runs 07:00 → 07:00 plant-local**, because shift 1 starts at 07:00 and shift 3 ends
at 07:00 the next day. So the business day `2026-08-01` is the interval

```
[ 2026-08-01 07:00 plant-local , 2026-08-02 07:00 plant-local )
```

and it contains shift 1 and shift 2 of Aug 1 plus **shift 3 of Aug 1, which ends on Aug 2**. A day
report's `business_date` is the date on the left of that interval. A month report's `business_date`
is the **first business day of the month** — `2026-08-01` for August — not the last, and not
midnight of the first.

Do the arithmetic in Postgres date/time types with `AT TIME ZONE`, not by adding hours to a
timestamp. The offset differs across a DST transition, and a month window that adds `24 * n` hours
is silently one hour wrong twice a year — which changes the availability denominator and renders a
plausible chart rather than failing.

**One consequence of the 07:00 boundary is genuinely counter-intuitive, and you will reproduce it
only if you do the arithmetic this way.** A DST transition at 02:00 local falls inside the business
day that began at 07:00 on the _previous_ calendar day. Measured against Postgres for
`America/Chicago` in 2026, where the clocks move on Mar 8 and Nov 1:

```
business day 2026-03-07   23 h   <- owns the spring-forward hour
business day 2026-03-08   24 h
business day 2026-10-31   25 h   <- owns the fall-back hour
business day 2026-11-01   24 h

month 2026-03            743 h
month 2026-10            745 h   <- November's transition is attributed HERE
month 2026-11            720 h
```

Read the October row twice. The clocks change on **November 1st**, but the November month window
does not open until 07:00 that morning — five hours too late — so the extra hour belongs to October.
Anyone eyeballing a monthly report would expect the reverse, and an implementation that trims the
hour from November will match intuition and disagree with the plant. `mes-oee-monitor` asserts all
six of these figures in `apps/api/src/shared/shift-window.integration.test.ts`.

The plant is `Asia/Jakarta` today, which is UTC+7 with no DST, so none of this bites yet — which is
exactly why it is written down now rather than discovered at the first plant that does observe it.

`date` stays as it is, and the upsert keys still use it — `wu_day_report_key (date, work_unit_id)`
and `wu_month_report_key (date, month, work_unit_id)` are unchanged. `business_date` is additional,
and it is what every read filters and joins on.

`business_date` and `time_zone` were also added to `work_unit_shift_reports`, nullable, for the
same reason. That table holds rows, so **it needs a backfill** — see §3.1 for the defect this fixes
and the measured example of the month filter getting it wrong.

### 15.4 `mttr` and `mtbf` — and why they must be NULL rather than 0

Both are in milliseconds, matching `work_unit_shift_reports.mttr` / `.mtbf`.

On the shift table these are `NOT NULL DEFAULT 0`. On the day and month tables they are **nullable
with no default, deliberately, and please do not ask us to add one.** The screens render `0` as
`00 s` — a measurement — and `NULL` as an em dash, meaning "not computed". A `DEFAULT 0` would make
every unwritten row claim a perfect repair time. Until your model computes them, NULL is the correct
and honest value, and the screen already handles it.

Use the same definition of "failure" you use for the shift table. That definition lives in your
model and nowhere else — `mes-oee-monitor` deliberately does not derive MTTR or MTBF from
`downtime_reports`, because a second definition in the API would disagree with the shift report on
the next screen over.

### 15.5 The roll-up rules — which measures add, and which must not be averaged

Both tables carry the same ~40 measures as the shift table, and getting this wrong produces numbers
that look right. The rule:

- **Additive — sum them.** Every `*_time` column, `runtime`, `total_out`, `good_out`,
  `effective_out`, `reject`, `rework`. A day is the sum of its three shifts; a month is the sum of
  its days.
- **NOT additive — recompute from the summed components, never average.** `oee`, `teep`,
  `availability`, `performance`, `quality`. `avg(availability)` over 30 days is wrong, and it is
  wrong in the flattering direction — §3.5 works the arithmetic on the analogous rate case and gets
  1333.3/h against a true 1024.4/h.
- `mttr` / `mtbf` are ratios and fall in the second group: recompute from total repair time and
  total failure count, do not average the shift values.

`mes-oee-monitor` ships a seed script,
`apps/api/scripts/seed/0013_day_month_reports_dev.sql`, that derives day and month rows from
`work_unit_shift_reports` using exactly these rules. **It is executable and you should read it as
the specification** — it is what the integration suite's cross-check asserts against.

### 15.6 One dbt test, at `error` severity

The single invariant worth failing a load over:

```sql
-- A day report must equal the sum of its shift reports, and a month the sum of its days.
select d.work_unit_id, d.business_date, d.runtime, s.runtime as shift_sum
  from {{ ref('work_unit_day_reports') }} d
  join (
    select work_unit_id, business_date, sum(runtime) as runtime
      from {{ ref('work_unit_shift_reports') }}
     group by 1, 2
  ) s using (work_unit_id, business_date)
 where d.runtime <> s.runtime
```

Run it on `runtime` and on `availability_time` at minimum. If those two agree, a systematic window
error is very unlikely to be hiding in the rest.

### 15.7 `month varchar(50)` — please tell us the format

It is part of `wu_month_report_key` so you must write it, but **its format is specified nowhere**,
and there is no CHECK constraint because guessing one would fail your first load. Nothing in
`mes-oee-monitor` reads it — the By Monthly header formats its label from `business_date` instead.

Tell us what you intend (`2026-08`? `August 2026`? `2026-08-01`?) and we will add the constraint. As
it stands two DAG versions could disagree and both would load.

### 15.7b `ideal_out` is now load-bearing for the month report

The By Monthly screen draws an **hour-of-day performance profile**: 24 points, each collapsing every
occurrence of that clock hour across the month. It reads `oee.product_perf_wu_hour`, and it depends
on one column you already write.

`ideal_out` is `GENERATED ALWAYS AS (ideal_rate_per_hour * runtime / 3600000)`. `0006`'s own comment
calls it "THE load-bearing column" because it turns the non-additive master RATE into an additive
QUANTITY — and the month profile is the first consumer that actually relies on that. The month's
standard is recomputed as

```sql
sum(ideal_out) * 3600000 / sum(runtime) FILTER (WHERE ideal_rate_per_hour IS NOT NULL)
```

**Two consequences for you.**

1. **Keep `ideal_rate_per_hour` NULL when no standard is known.** Never `COALESCE` it to 0 and never
   substitute the actual rate. `0006` already says this; the month profile is where getting it wrong
   becomes invisible rather than obvious. A 0 makes `ideal_out` 0 and drags the month's standard
   down; the actual rate makes the loss vanish entirely.
2. **The `FILTER` on that denominator is why partial coverage is safe.** An hour with production but
   no standard still contributes its output and is excluded from the standard's weighting. If you
   ever compute a monthly standard yourself, divide by the runtime that carried a standard — not by
   all runtime. Dividing by all runtime understates the target, which SHRINKS performance loss, and
   nothing on the screen would look wrong.

`actual_rate_per_hour` is not read at any grain: the browser derives it from `total_out` and
`runtime`, so the generated column is a convenience for BI rather than a dependency here.

### 15.8 What you need to do

1. Say now if any in-progress model writes `availablity_loss_time` (§15.1).
2. Build the day and month models, writing all seven new columns (§15.2), with `business_date` on
   the 07:00 → 07:00 boundary (§15.3).
3. Apply the additivity rules in §15.5. Read the seed script; it is the spec.
4. Add the cross-check test in §15.6 at `error` severity.
5. Backfill `business_date` and `time_zone` on `work_unit_shift_reports` (§3.1, §15.3).
6. Keep `ideal_rate_per_hour` NULL where no standard is known (§15.7b) — the month profile depends
   on it.
7. Write watermark rows for `work_unit_day_reports` and `work_unit_month_reports`. Both table names
   are **already legal** in `ck_etl_watermarks_table` and have been since `0005` — nothing writes
   them, so `loadedThrough` is `null` on every day and month payload and the screens cannot yet tell
   "no downtime" from "not loaded". §4 has the post-hook.
8. Tell us the `month` format (§15.7).

### 15.9 What is NOT asked of you

Nothing recalculates these two tables after an operator edits a downtime. §13 asks you to honour
the operator override on `downtime_reports` only. The day and month tables roll up the same time, so
a category edit makes them stale in exactly the way `docs/downtime-edit-trd.md` describes for the
shift table — and as there, **no rebuild is being requested here.** It is recorded so it is known
rather than discovered.

---

## 16. What `0014` adds — the LINE grain, and what it asks of you

**This is the section to read first if you are picking up the `work_center` DAG, and it is a new
DAG rather than a change to an existing one.** Migration `0014` adds three tables:

```
oee.work_center_shift_reports     one line, one shift
oee.work_center_day_reports       one line, one business day
oee.work_center_month_reports     one line, one month
```

They carry the same ~30 measures as `work_unit_shift_reports`, rolled up across the **machines on a
line** instead of across time. `mes-oee-monitor` reads all three — the `Report › Line ›
{By Shift, By Day, By Monthly}` screens — and they are empty, so those screens render an empty
state until your models exist.

All three were created empty and are read by nothing else, which is the whole reason this section
can ask for things §15 could not. **Everything in §16.1 is free to change today and a coordinated
deploy plus a backfill after your first load.** Please answer §16.10 Q1–Q5 before you write a model.

### 16.1 Three deliberate divergences from `work_unit_*` — say now if any of them hurts

These tables are NOT a copy of the `work_unit_*` shape. Three differences are intentional, and each
one drops a defect this document already records rather than reproducing it:

**1. The upsert key is `business_date`, not a `date` instant.** There is **no `date timestamptz`
column at all.**

`work_unit_*.date` is the most-documented trap in this system: it holds the shift's START INSTANT,
not a calendar day, so no calendar reading of it is correct without a time zone — see §3.1 and
§15.3. It exists on those tables because it predates `business_date` and because it is half of their
upsert keys. On a table that has never existed it has no reader: `mes-oee-monitor` filters and
orders on `business_date`, and any window it resolves is `business_date` + `time_zone` computed in
Postgres. Reproducing the column would have been re-planting a landmine for symmetry's sake.

**2. `month varchar(50)` is nullable, OUT of the key, and now CONSTRAINED.** §15.7 says of
`wu_month_report_key (date, month, work_unit_id)` that the format of `month` "is specified nowhere"
and that "two DAG versions could disagree and both would load". That is a uniqueness constraint over
a string nobody defined. Here the column survives only as a **label** for BI — nothing in
`mes-oee-monitor` reads it, the By Monthly header formats from `business_date` — and **you have now
specified the format, so it is enforced**: `ck_wc{s,d,m}r_month_format` requires `YYYY-MM` (e.g.
`2026-08`) on all three tables. NULL remains legal, because the column is a convenience rather than
a key. This is the difference the empty-table window buys: §15.7 could not add this constraint, and
this one could.

**3. `business_date`, `time_zone` and `work_center_name` are `NOT NULL`.** On `work_unit_*` the
first two are nullable because those tables already held rows and a `DEFAULT` would have fabricated
a business day. That reason does not apply to an empty table, and the cost of leaving them nullable
is stated in `mes-oee-monitor`'s own filter code: **a row whose `business_date` you have not written
is invisible to any month or year filter while still appearing in an unfiltered list** — so a
filtered list comes back shorter than it should, with nothing to say why. `NOT NULL` moves that
failure to your first load, loudly, where a re-run fixes it. `work_center_name` follows the rule
`0008` set for `work_unit_name`: a Pareto whose rows cannot say which machine they came from is not
one, and a **Line** list whose rows cannot say which line they are is not one either.

### 16.2 `business_date` means exactly what §15.3 says

The 07:00 → 07:00 plant-local business day, unchanged, including the DST worked example. A month
row's `business_date` is the **first business day of the month**. Do not restate the arithmetic
here — use §15.3, and note `0014` adds the `CHECK` that makes the month rule mechanical:

```sql
CHECK (business_date = date_trunc('month', business_date)::date)
```

### 16.3 The roll-up — §15.5's rules, plus three things that change at line grain

The rules are unchanged and are not negotiable:

- **Additive — SUM.** Every `*_time` column, `runtime`, `total_out`, `good_out`, `effective_out`,
  `reject`, `rework`.
- **NOT additive — RECOMPUTE from the summed components, never average.** `oee`, `teep`,
  `availability`, `performance`, `quality`, `mttr`, `mtbf`. There is no `avg()` in the reference
  implementation and there must never be one.

`apps/api/scripts/seed/0015_work_center_reports_dev.sql` derives all three tables from
`work_unit_shift_reports` using exactly these rules. **It is executable and you should read it as
the specification**, the way §15.5 asks you to read `0013`'s seed. Three things genuinely change
when the group key is `work_center_id` rather than a time bucket:

**(a) A line is MEASURED, not summed — `line <> sum(machines)`.** A line has its own count points,
physically mounted on particular machines but read as the line's infeed and outfeed rather than as
those machines' production. So `availability_time` on a four-machine line over an 8-hour shift is
**8 hours, not 32**, and TEEP's denominator is the line's calendar time, unscaled.

This is the correction to an earlier version of this section, which called the durations
"machine-milliseconds" and asked you to assert `line = sum(machines)`. That assumed a roll-up. It is
not one, and five machines in series do not produce five times the output — they pass work along and
the line ships what comes off the end. **§16.8 now asks only for the invariant that is actually
true.**

One consequence for the roll-up rules above: they still apply, but along the TIME axis only. A
line's day is the sum of its own line-shifts, and a month the sum of its days, with the rates
recomputed from those sums. Nothing sums across machines.

**(b) The unit is no longer invariant within a group.** `0013`'s seed takes `min(uom_id)` and says
of it: "they are denormalised labels that do not vary within a work unit; if they ever did, `min()`
would pick one silently." Across the machines of a line they DO vary. `min()` here would label a
mixed line BAG and sum cartons into the total. See §16.4.

**(c) The NULL-skipping trap on the second hop, which is the subtle one.** `count(DISTINCT x)`
**skips NULLs.** So a day whose shift 1 was mixed-unit (`uom_id` NULL, counts NULL) and whose shifts
2 and 3 were BAG evaluates `count(DISTINCT uom_id) = 1`, writes `BAG`, and `sum(total_out)` then
**skips shift 1's NULL** — producing a confident `BAG` label over a day that under-reports its
output by a whole shift, with nothing failing anywhere. The gate needs both halves:

```sql
-- Both conditions are load-bearing:
--   count(DISTINCT uom_id) = 1  -> the members agreed on a unit
--   count(uom_id) = count(*)    -> and NO MEMBER ABSTAINED
CASE WHEN count(DISTINCT r.uom_id) = 1 AND count(r.uom_id) = count(*)
     THEN min(r.uom_id) END
```

One more that is easy to get wrong and invisible: **`work_unit_count` is `count(*)` at the first hop
and `max()` at the later ones.** A day's machine count is its busiest shift's, not the sum of three
shifts' counts.

### 16.4 A LINE HAS TWO UNITS — and the CHECKs that will FAIL YOUR LOAD

This section changed after you answered §16.10 Q2, and it is the one place the line grain differs in
**kind** from the machine grain rather than merely in scope.

A discrete line consumes one thing and produces another — bags or calender rolls in, cartons or
sacks out — and `ms_code.count_points` is what names which machine is which. So the tables carry
**two** unit triples, not one:

| Columns                         | Denominated in                      |
| ------------------------------- | ----------------------------------- |
| `total_out`, `reject`, `rework` | `infeed_uom_id` / `_name` / `_code` |
| `good_out`, `effective_out`     | `output_uom_id` / `_name` / `_code` |

**`total_out = good_out + reject + rework` IS THEREFORE FALSE AT THIS GRAIN**, by construction
rather than by defect. 100 bags in yielding 10 cartons out is not a 90% loss. Nothing in this schema
computes across the two sides, and nothing on the shipped screens does either — the three Line list
screens show OEE / Availability / Performance / Quality and no counts at all.

This is not a new idea in Gold. `product_count_wu_shift` already works this way: `total_out`,
`reject` and `rework` are converted to the base unit while `good_out` stays in the production unit,
and the SKU card carries a tooltip telling the reader the figures are not additive. The line grain
makes the same split **structural** instead of documentary.

**Within each side, NULL means "the members disagreed", not "unknown", and the counts are nulled
WITH their label.** `500 BAG + 12 CARTON = 512 <blank>` is a wrong number with a missing label, not
a smaller truth — the same treatment `aggregateRejectReasons` already gives a mixed bucket, where
the unit _and_ the converted figure go.

The two guards are **separate**, deliberately, so a line that knows what it consumed but not what it
shipped keeps the half it is certain of:

```sql
CONSTRAINT ck_wcsr_infeed_units CHECK (
  infeed_uom_id IS NOT NULL
  OR (total_out IS NULL AND reject IS NULL AND rework IS NULL AND line_out IS NULL)
),
CONSTRAINT ck_wcsr_output_units CHECK (
  output_uom_id IS NOT NULL
  OR (good_out IS NULL AND effective_out IS NULL)
)
```

> **`line_out` joined the infeed CHECK in `0015`.** Widened rather than given a guard of its own,
> because it is denominated in exactly the unit that guard is about. If you are reading `0014` for the
> constraint text, this is the current form.

**These can fail your load.** That is the same call §14 (`0011`) made for the `reason` array shape,
and for the same reason: the alternative renders as data.

**Durations are unaffected.** Time is time, which is why the list screens are well defined for a
line whose two units differ — and why the dev seed can derive them while writing no units at all.

#### 16.4a `effective_out` is on the OUTPUT side — settled

Confirmed by the pipeline owner: **`effective_out` is denominated in the OUTPUT unit, alongside
`good_out`.** So the split is final:

| Columns                                     | Unit           |
| ------------------------------------------- | -------------- |
| `total_out`, `reject`, `rework`, `line_out` | `infeed_uom_*` |
| `good_out`, `effective_out`                 | `output_uom_*` |

No schema change was needed — this is where `0014` already placed it — but the reading behind it is
worth keeping, because two things follow that are not obvious from the DDL.

**1. `total_out` and `effective_out` are now in different units at line grain.** At machine grain
they share one, which is why the Summary card can put "Actual Production" and "Effective Prod." next
to each other without qualification. At line grain that stops being true, and anything comparing the
two directly is comparing bags to cartons.

**2. A future Line performance chart needs TWO Y axes, not one.**
`apps/web/src/lib/perf-hourly.ts` builds a single shared quantity domain over both series
(`domainOf(allPoints.flatMap((p) => [p.totalOut, p.effectiveOut]))`) so that small multiples are
directly comparable. That is correct for a machine and **wrong for a line**. Nothing is broken today
— the chart is machine-only, and the Line detail screen that has since shipped deliberately does NOT
include it for this reason.

**And it cannot be fixed until you answer two things**, which is why it is still recorded rather than
done. A line performance chart needs `product_perf_wu_hour` rolled up by `work_center_id`, and it
needs the line's TWO uom triples on those rows — otherwise the browser cannot know which series
belongs to which axis. Neither exists. Designing the domain split against a payload nobody has
specified would be guessing at the contract, so the note stays in `perf-hourly.ts` next to the domain
it would break, and in `TODOS.md` §52.

**What this does NOT change:** the rates. Quality is time-derived (§16.10 Q3), so no OEE figure
divides an output count by an infeed one, and no bags-per-carton conversion is needed anywhere in
this schema.

#### 16.4b `line_out` — a fourth count we need, added by `0015`

**What we are asking for:** one more `numeric(15,3)` column on all three
`oee.work_center_*_reports` tables, on the **infeed** side.

```sql
line_out  numeric(15,3)     -- nullable, no default
```

**What it means:** the line's own measured production at its **infeed count point**, denominated in
`infeed_uom_*` — so it is comparable with `total_out` and with nothing on the output side. The Line
detail screen's overview card labels this tile with the line's NAME ("Molca Line 8 Production"),
beside `total_out` under "Total Production".

**Why it is not derived.** The obvious candidate was `total_out - reject - rework`. We are not doing
that, and would rather you did not either: `0014` already records that a line is MEASURED, not
summed, so an arithmetic identity between two count points is not something this schema asserts. If
the line's infeed count point reports this figure directly, that is what we want.

**What `0015` does and does not do:**

- It **widens `ck_*_infeed_units`** to cover `line_out` (see §16.4). A `line_out` written without an
  `infeed_uom_id` will FAIL YOUR LOAD, on the same terms as the other three infeed counts.
- It does **NOT** assert `total_out = line_out + reject + rework`. A CHECK there would take a line's
  whole reporting down to protect one tile.
- It adds **no writer.** The column ships NULL everywhere, and the tile renders an em dash until your
  DAG fills it — which is the correct state, not a bug to be worked around with a 0.

**If this figure does not exist at your end, say so** and we will remove the column and the tile
rather than leave a permanently blank one on screen.

### 16.5 `work_unit_count` and `expected_work_unit_count` — write both

```
work_unit_count           NOT NULL   machines that REPORTED into this row  = count(*)
expected_work_unit_count  nullable   machines the line HAS, per master-data
```

If a line has four machines and one DAG partition fails, the row is written from three and renders a
plausible, slightly-lower OEE **with no signal anywhere**. These two columns are what let the screen
say "3 of 4" and let §16.8's test fail the load instead.

`expected_work_unit_count` is asked of you rather than resolved at read time deliberately: you
already join mes-master-data to denormalise `work_center_name`, so the roster is in front of you.
Resolving it in the API would mean one upstream HTTP call per line per page — an N+1 on a screen
that otherwise touches nothing but Gold. Leave it NULL if you cannot supply it and the screen falls
back to a bare count; it must never be a guess.

### 16.6 `area_id` / `area_name`, and the label-staleness policy

Both nullable, from mes-master-data, exactly as you already write `product_perf_wu_hour.area_id`.
`0006`'s reasoning applies unchanged: the hierarchy above the work center is not reliably populated
for every plant today, and `NOT NULL` here would block a first load.

**Label staleness is accepted policy, and it is stated here so nobody is surprised by it.** All of
`work_center_name`, `work_center_code` and `area_name` are denormalised, so a line renamed in
master-data keeps its old name on rows already written. Restate labels for rows inside your run
window; **do not backfill history.** Old periods then carry the name the line had at the time, which
is what a report should say, and it is already how `work_unit_name` behaves on every screen in the
app. `mes-oee-monitor` makes no master-data call at all on this read path — the labels on the row
are the only ones it has.

### 16.7 `mttr` / `mtbf`

Milliseconds, **nullable with no default**, and NULL rather than 0 for §15.4's reason verbatim: the
screens render `0` as `00 s`, a measurement, and NULL as an em dash, meaning "not computed". A
`DEFAULT 0` would make every unwritten row claim a perfect repair time. They are ratios, so they are
**recomputed from total repair time and total failure count across the line's machines** — not
averaged. Use the same definition of "failure" you use for the shift table.

### 16.8 One dbt test, at `error` severity

**This section previously asked for two, and the first one was wrong.** It asserted
`line_shift = sum(machine_shift)`, which assumed the line was a roll-up of its machines. It is not
(§16.3a), so that test would have failed every load. It has been removed rather than softened.

What remains is the invariant that is true of a measured line, and it is the same one §15.6 asks for
one axis over — a period equals the sum of the periods beneath it, for the **same subject**:

```sql
-- A line's day report equals the sum of its own line-shift reports.
-- (And a month, the sum of its days.)
select d.work_center_id, d.business_date, d.runtime, s.runtime as shift_sum
  from {{ ref('work_center_day_reports') }} d
  join (
    select work_center_id, business_date, sum(runtime) as runtime
      from {{ ref('work_center_shift_reports') }}
     group by 1, 2
  ) s using (work_center_id, business_date)
 where d.runtime <> s.runtime
```

Run it on `runtime` and on `availability_time` at minimum, and again for month-over-day.

**What must NOT be tested:** any agreement between a line row and the machine rows underneath it.
There is no such relationship, and a test asserting one is a test that will be deleted later by
somebody who has to work out why it fires.

### 16.9 Watermarks

`0014` extends `ck_etl_watermarks_table` with the three new names. **Without that your post-hook
would fail on its first run** — §4 is explicit that extending the list is a migration, which is the
point. The post-hook itself is unchanged.

Note the three tables have no watermark rows yet, so `loadedThrough` is null for them and the
screens cannot distinguish "this line did not run" from "not loaded" — the same gap §15 records for
the day and month tables.

### 16.10 Questions — Q1 to Q5 ANSWERED, and what changed as a result

Answered by the pipeline owner before the migration merged, which is exactly the window §16 opened
for. What each answer changed is recorded here so the reasoning survives the conversation.

1. **Does a line row exist when only SOME of its machines reported? Can you supply
   `expected_work_unit_count`?** — **Yes and yes.** Both columns stay as specified in §16.5.
2. **What does a line's UOM mean, and do you model infeed and output units separately?** —
   **Separately, and they are usually different.** "Discrete manufacturing lines utilise distinct
   input and output units… production volume, total production, rejects and rework rely on units
   associated with the INFEED machinery, whereas finished goods are measured using units from the
   OUTPUT machinery." **This rewrote §16.4**: one `uom_*` triple became `infeed_uom_*` and
   `output_uom_*`, with a separate CHECK per side. `effective_out` sits on the output
   side, confirmed separately — §16.4a.
3. **Are the five rates time-derived or count-derived?** — _See §16.10a below; this one is still
   open, and it matters more now than when it was asked._
4. **`business_date` as the upsert key rather than a `date` instant?** — **Yes**, and it will be
   produced for the work unit, work centre and area grains (factory deferred). No change needed.
5. **What format for `month`?** — **`YYYY-MM`** (`2026-08`). Now enforced by
   `ck_wc{s,d,m}r_month_format` on all three tables (§16.1).
6. **Every work unit has a work center** — _"even the process is batch or continuous line
   production."_ So the hierarchy is total: no machine is ever unattached, and
   `expected_work_unit_count` is always resolvable. This confirms the `NOT NULL` that has been on
   `work_unit_shift_reports.work_center_id` since `0003`, and makes the dev seed's
   `WHERE work_center_id IS NOT NULL` guard belt-and-braces rather than load-bearing.
   **Residual, and minor:** what happens to rows ALREADY WRITTEN when a machine is re-parented to
   another line — restate them, or preserve the line it ran on at the time? Our position is
   preserve, because a report should say where the work happened. Nothing blocks on it.
7. **Will the line models CHAIN from the machine reports, or be built independently?** —
   **Independently**, from the line's own count points. This rewrote §16.3a, cut §16.8 down to a
   single test, and reframed the dev seed as a stand-in rather than a specification.
8. **TEEP at line grain** — the denominator is the line's own calendar time, unscaled, which
   follows from Q1/Q7. Flagged rather than asked: correct us if the line's calendar differs from its
   machines'.
9. **Watermark rows** for the three new tables (§16.9). Still open.
10. **`poc-flink-v2` is NOT the source.** It is an older pipeline for a DIFFERENT project, and a new
    one is being written for `mes-oee-monitor`. §7's porting guidance is obsolete and is marked as
    such at the top of that section. Nothing should be ported from it — its `line_shift_report` in
    particular defines a line for another product's purposes.

### 16.10a Both settled — what changed, kept here so the reasoning survives

**(a) A line is measured, not summed.** Answered: _"yes line have different count point. that is the
table view that query from count point from the machine."_ A line's count points sit on machines but
are read as the line's, so the line report is built from them rather than rolled up. Three things in
`mes-oee-monitor` were written on the opposite assumption and are now corrected:

| Was                                                                   | Now                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0014` called the durations "machine-milliseconds"                    | the line's own wall clock; `line <> sum(machines)` stated in the header and on every duration column                                                                                  |
| §16.8 asked for `line_shift = sum(machine_shift)` at `error` severity | removed — it would have failed every load. One test remains, day-over-shift (§16.8)                                                                                                   |
| `0015` presented itself as "the specification of the roll-up"         | reframed as a **dev stand-in**. It still sums machines, because a dev database has nothing else to derive from, and now says at length that step 1 is invented and structurally wrong |

**(b) The rates are time-derived.** Answered directly, and it closes the question §16.4 had
reopened. For the record, since the distinction was asked about:

```
time-derived   quality = value_added_time / net_time     both durations, same unit
count-derived  quality = good_out / total_out            both counts
```

They agree only when the counts share a unit — and §16.4 establishes that at line grain they do not.
A count-derived quality would have made a line taking 100 bags and shipping 10 cartons report _"10%
quality"_ with nothing rejected, and would have needed a bags-per-carton conversion this document
does not name. **Time-derived avoids all of it.** The count columns are reported figures; no rate
reads them.

### 16.11 What is NOT asked of you

- **No approval COLUMN, and there is nothing to key one on.** `oee.work_unit_shift_report_approvals`
  is keyed `(work_unit_id, date, shift)` and these tables have no `work_unit_id` column at all, so
  nothing in this schema holds approval state and **you are not asked to write any**.

  A line CAN now be approved from the Line detail screen, and it changes nothing here: the write
  closes the MACHINE shift reports on the line, in `oee.work_unit_shift_report_approvals`, and the
  line's own status is DERIVED by counting them. `0014`'s row-level `write_audit` triggers on these
  three tables are still the tripwire for "no operator mutation targets them" — if one of them ever
  fires, something has gone wrong. The list screens still carry no Status column at any grain.

- **No per-product rows.** These tables do not answer the line-level SKU question; see the revised
  §7 for why the OEE half rolls up cleanly and the product half does not.
- **No recalculation after an operator's downtime edit.** §15.9's position, unchanged and now one
  grain wider: a category edit makes these three stale too, and no rebuild is being requested. It is
  recorded so it is known rather than discovered.
- **No `factory_id`.** Nothing in the product has a factory selector, and a nullable column added
  later to a table of any size is a metadata-only `ALTER`.

---

---

## 17. What `0016` adds — per-SKU output at the LINE grain

Two new tables, `oee.product_count_wc_shift` and `oee.product_count_wc_day`. They back the **SKU
View** card on the Line report detail screens, which ships with an empty state until you fill them.

They are the same columns as `oee.product_count_wu_{shift,day}` — including `uom_*`, `base_uom_*` and
`factor_to_base` unchanged — with `work_unit_*` replaced by `work_center_*` and `shift_date` /
`date` replaced by `business_date`. If you already model the machine pair, this is that model keyed
one level up.

### 17.1 THIS IS NOT A ROLL-UP OF THE MACHINE TABLES — please do not build it as one

This is the one thing to get right, and §16's own header is why. **A line is measured, not summed**:
it has its own count points, so `line <> sum(machines)`. You confirmed that, and `0014` records it.

`oee.work_center_shift_reports.total_out` is therefore the line's OWN measured output — and the Line
detail screen renders it in a card **directly above** SKU View. So if these rows were a roll-up of
`product_count_wu_shift`, the screen would show two sets of production figures that disagree, on one
page, both correct. There is no caption that makes that readable.

**What we need is the same count points, split by product.** The line's infeed and outfeed counters
already attribute output to a SKU; that attribution, per shift and per business day, is these tables.

### 17.2 The two units per row are the machine tables' rule, unchanged

```
total_out, reject, rework  ->  scaled by factor_to_base, denominated in base_uom_*
good_out                   ->  NOT scaled. Finish Good stays in uom_*.
```

This is `§3.4`'s rule verbatim, and the browser already renders exactly this pairing with a tooltip
saying the figures are not additive across it (`apps/web/src/lib/product-count.ts`). Nothing about it
changes at line grain — which is why `0016` did not invent an infeed/output split the way `0014` had
to for the report tables.

`ck_pcwcs_factor` admits any positive factor, exactly as `ck_pcwus_factor` does, so a
wrong-but-positive value renders a plausible number rather than failing the load. **We are asking for
the same per-`(product, uom, base_uom)` consistency guarantee §3.4 asks for**, for the same reason:
nothing downstream can validate a factor's value.

### 17.3 Two tables, and the month grain is served by the day one

There is no `product_count_wc_month`, and none is wanted — the month screen reads the day table
widened over an interval, exactly as the machine month screen already reads
`product_count_wu_day`. One fewer model to keep consistent, and one fewer place for a sum to drift.

### 17.4 `business_date`, `time_zone` and `work_center_name` are NOT NULL

`§15.3`'s meaning of `business_date`, and `0014`'s divergence 3: these tables are empty, so there is
no populated-table excuse for nullable. A row whose `business_date` you have not written would be
invisible to every window filter while still existing, which is a silently short card rather than a
loud failure.

### 17.5 Watermarks

`0016` adds `product_count_wc_shift` and `product_count_wc_day` to `ck_etl_watermarks_table`, so your
post-hook can stamp them. **Please do stamp them.** The watermark is the only thing that lets SKU
View say _"product output has not been loaded for this line yet"_ instead of _"this line produced
nothing"_ — opposite claims about the same empty card, and until you write these tables the second
one is a lie. `TODOS.md` §14 is the item that established that distinction after the machine card
shipped making the flattering claim for both.

### 17.6 What is NOT asked of you

- **No per-machine breakdown inside these rows.** The Machine View card on the same screen reads
  `oee.work_unit_*_reports` directly for that, which you already write.
- **No operator-entered reject or rework.** These are your measurement; an operator's correction is
  a different fact. `0016`'s row-level `write_audit` triggers are the tripwire for that.
  **THAT FEATURE IS NOW BUILT, and it kept the promise**: it writes
  `oee.work_center_quality_entries`, its own table with its own audit trail, and **§18 is the one
  change it asks of you.** Nothing about these two tables changes.
- **No recalculation after an operator's downtime edit.** §15.9 and §16.11's position, unchanged.

---

## 18. Operator-entered reject and rework — the second change you must make to your model

**This is the second section that asks you to change a model you have already written**, and like
[§13](#13-editing-a-downtime--the-one-change-you-must-make-to-your-model) it is not optional. Unlike
§13, it does not describe a way your next run destroys somebody's work — it describes work that never
arrives at all unless you do this.

`mes-oee-monitor` now ships an operator entry form on the Line report screens. An operator types in
reject and rework the line's count points did not see — hand-sorted product, a QC hold, a batch
pulled off the end — and each entry becomes one row in **`oee.work_center_quality_entries`**, a table
this service owns and you have not seen before.

**You read it. You never write it.** Same standing as `oee.downtime_report_history` (§13) and the two
approval tables (§12). It is deliberately absent from `ck_etl_watermarks_table`, so a dbt model of
that name fails on its post-hook — if that ever happens, the model is pointed at a table it does not
own and the fix is to delete the model, not to amend the constraint.

### 18.1 How this differs from §13, which changes the SQL

§13 is an **override**: it replaces four columns of a row you already build, keyed on
`source_event_id`. This is an **addition**: there is no pipeline row for a manual reject to override,
because no sensor recorded it. The operator is adding a fact, not correcting one.

Three consequences follow, and each is a different failure mode from §13's:

|                     | §13, downtime edit                  | §18, quality entry                             |
| ------------------- | ----------------------------------- | ---------------------------------------------- |
| operation           | replace a column                    | **add to** a column                            |
| attaches to         | an existing row (`source_event_id`) | a `(line, business_date, shift)` **grain**     |
| if you get it wrong | the operator's edit is lost         | the figure **doubles**, or the load **aborts** |
| precedence          | operator wins                       | not applicable — nothing is being overridden   |

### 18.2 ONE JOIN, AT SHIFT GRAIN. Not three.

Every entry is a **shift-grain fact**, whichever screen produced it. The form is offered on the
shift, day and month reports, but at month grain the operator picks a business date _and_ a shift,
and at day grain a shift — so all three land the same row shape, keyed
`(work_center_id, business_date, shift)`.

That matters because §16.3 already guarantees the rest: _"A line's day is the sum of its own
line-shifts, and a month the sum of its days."_ **Fold the entries into the shift model and the day
and month models inherit them through the roll-up you already perform.**

Joining at day or month grain **as well** double counts — and §16.8's `error`-severity day-over-shift
test will fire. That is the safety net working, but it fires on a load rather than in review, so:
**the one-join rule is not a preference. It is the only version that passes the test you already
run.**

Build the aggregate once, at shift grain, and re-aggregate it for the coarser models if they need it
— never re-aggregate the source table three times, and never chain a coarse model off the already-
overridden shift model _and_ join the entries again.

### 18.3 The aggregate

```sql
-- The LIVE operator-entered quantities, at SHIFT grain, PER TARGET UNIT.
--
-- `voided_at IS NULL` is not optional: a corrected fat-finger stays in the table
-- as evidence, and counting it forever is the whole point of the column.
--
-- GROUPING BY target_uom_id is load-bearing, not tidiness. A sum across two units
-- is the "500 BAG + 12 CARTON = 512 <blank>" that §16.4 refuses. Each group is
-- denominated in exactly one unit, and the join below admits at most one of them.
WITH entry_shift AS (
  SELECT e.work_center_id,
         e.business_date,
         e.shift,
         e.target_uom_id,
         sum(e.target_qty) FILTER (WHERE e.kind = 'reject') AS reject_add,
         sum(e.target_qty) FILTER (WHERE e.kind = 'rework') AS rework_add
    FROM oee.work_center_quality_entries e
   WHERE e.voided_at IS NULL
   GROUP BY 1, 2, 3, 4
)
```

`target_qty` is a **generated** column — the entered quantity converted into the line's unit, computed
by the database from two snapshotted factors. It is the only figure you may sum. Do not recompute it
from `entered_qty`, and do not use `entered_qty` directly: it is in whatever unit the operator typed.

### 18.4 The projection

```sql
SELECT s.*,   -- minus reject and rework; spell the columns however your dialect prefers

       CASE WHEN o.reject_add IS NULL THEN s.reject
            ELSE coalesce(s.reject, 0) + o.reject_add END   AS reject,
       CASE WHEN o.rework_add IS NULL THEN s.rework
            ELSE coalesce(s.rework, 0) + o.rework_add END   AS rework

  FROM base_work_center_shift s
  LEFT JOIN entry_shift o
    ON  o.work_center_id = s.work_center_id
    AND o.business_date  = s.business_date
    AND o.shift          = s.shift
    -- THE UNIT GATE. See §18.5 items 1 and 2 before touching this line.
    AND o.target_uom_id  = s.infeed_uom_id
```

`coalesce(s.reject, 0)` inside the `ELSE` is a narrow, deliberate decision. A report row with a known
infeed unit but `reject IS NULL` means "not measured", and normally that must stay an em dash. But
once an operator has entered a figure, _"the only rejects anyone knows about are the 500 a human
counted"_ is more informative than an em dash — so NULL degrades to 0 **only in the presence of an
entry**, never otherwise.

### 18.5 Every way this join goes wrong

**1. The unit predicate moved to `WHERE`.** `WHERE o.target_uom_id = s.infeed_uom_id` after a
`LEFT JOIN` silently converts it to an inner join and **drops every line-shift with no operator
entry** — which is nearly all of them. The Line report goes from 900 rows to 12. It will be written
that way at least once.

**2. `IS NOT DISTINCT FROM` instead of `=`. This one aborts your load.** It looks defensive and it is
catastrophic. A mixed-unit shift has `infeed_uom_id` NULL, and `ck_wcsr_infeed_units` nulls `reject`
and `rework` **along with it** — so matching that NULL and writing a non-NULL reject onto the row
violates the constraint and **fails the model**, for one operator's entry against one mixed shift.

Plain `=` is self-protecting: `target_uom_id` is `NOT NULL`, NULL equals nothing, the entry matches
nothing and contributes nothing. **The predicate must be able to fail to match.** Same for
`coalesce(s.infeed_uom_id, o.target_uom_id)`.

**3. `sum()` over an empty `FILTER` is NULL, not 0.** A shift with rework entries but no reject
entries has `reject_add = NULL`, and `s.reject + NULL` is NULL — which **wipes your own measured
reject**. This is the likeliest silent-data-loss bug in the section, because it only appears on
shifts carrying one kind of entry and not the other. It is the same class as §13's
`CASE WHEN has_x` versus `COALESCE`.

**4. An `UPDATE … SET reject = reject + x` post-hook.** It **doubles on every run, forever**, and
nothing in the data says how many times it ran. The override must be part of the `SELECT` that builds
the row — §13's whole architecture, and the reason it is stated there as a projection.

**5. Applying it twice at one grain.** If a coarse model is ever changed to build from the _already
overridden_ shift model and still joins the entries itself, they land twice. Rule: **each model
applies the override exactly once.** If day ever chains from shift, delete its entry join in the same
commit.

**6. An incremental lookback shorter than an operator's memory.** With a 3-day window, an entry made
today against last Wednesday's shift is **never** applied — not late, never. The operator sees nothing
happen and enters it again. Widen the incremental filter by the entry table:

```sql
{% if is_incremental() %}
WHERE s.business_date >= least(
        (current_date - interval '{{ var("lookback_days", 3) }} days')::date,
        coalesce((SELECT min(business_date)
                    FROM oee.work_center_quality_entries
                   WHERE greatest(entered_at, coalesce(voided_at, entered_at))
                         > coalesce((SELECT last_run_at FROM oee.etl_watermarks
                                      WHERE table_name = '{{ this.identifier }}'),
                                    '-infinity'::timestamptz)),
                 current_date))
{% endif %}
```

`greatest(entered_at, voided_at)` is what makes a **void** re-open its partition too. Without it,
voiding a three-week-old entry leaves the inflated figure on the report permanently — the mirror of
the same bug, and the easier one to miss.

**7. Recording "this entry has been applied" anywhere. Do not.** Keep the pipeline stateless with
respect to this table. Idempotency comes from the projection being a pure function of (your base
rows, the live entries); the moment you track application state, a re-run and a void disagree.

### 18.6 Two tests

**Stranded entries — `warn` severity.** Three ways an entry contributes to nothing: there is no
report row for that `(line, date, shift)`, the shift was mixed-unit, or the units disagree. All three
are the join working as designed, and all three are invisible.

```sql
-- WARN, NOT ERROR. Each row here is a quantity a human counted that no figure
-- includes — worth surfacing, never worth blocking the whole Gold load for. That
-- is the mistake §16.8 made once and had to retract.
SELECT e.id, e.work_center_id, e.business_date, e.shift, e.kind,
       e.target_qty, e.target_uom_code, r.infeed_uom_code AS report_uom_code,
       CASE WHEN r.work_center_id IS NULL THEN 'no_report_row'
            WHEN r.infeed_uom_id  IS NULL THEN 'report_unit_null'
            ELSE                               'unit_mismatch' END AS why
  FROM oee.work_center_quality_entries e
  LEFT JOIN {{ ref('work_center_shift_reports') }} r
    ON  r.work_center_id = e.work_center_id
    AND r.business_date  = e.business_date
    AND r.shift          = e.shift
 WHERE e.voided_at IS NULL
   AND (r.work_center_id IS NULL OR r.infeed_uom_id IS DISTINCT FROM e.target_uom_id);
```

**§16.8, widened — `error` severity.** Its day-over-shift invariant runs on `runtime` and
`availability_time` today. Once this lands, **extend it to `reject` and `rework`**. That is the only
mechanical guard that all three grains got the same treatment: with `entry_shift` as the shared
source, day = sum(shifts) holds exactly, because both sides sum the same rows.

### 18.7 What is NOT asked of you

- **No new rate arithmetic, and this is the important one.** §16.10a(b) settled that the rates are
  **time-derived**. An entry moves `reject` and `rework` and **nothing else** — not `quality`, not
  `oee`, not `teep`, not `quality_loss_time`, not `reject_time`. Do not "fix" that by deriving a
  duration from a count, and do not adjust `total_out` or `line_out` to preserve an arithmetic
  identity: `0015` deliberately does not assert `total_out = line_out + reject + rework`, and this is
  one reason why.
- **Nothing at machine grain.** An entry carries a `work_unit_id`, and it is **provenance only** — the
  machine the operator saw the rejects on. It must never influence `oee.work_unit_*_reports`. A line
  is measured at its own count points; that is why the quantity lands on the line.
- **No writes to the entry table**, of any kind. No `DELETE`-then-`INSERT`, no truncate, no upsert,
  no backfill. It is append-only and its own trigger enforces that against you as well as against us.
- **No per-product attribution of the entry** into `oee.product_count_wc_*`. §17.6's position,
  unchanged: an entry names a SKU so the conversion has a basis, not so it can be folded into your
  per-SKU measurement.

### 18.8 One question for you

**Do you need `SELECT` granted explicitly?** §6 proposes roles that do not exist yet and `0004` notes
everything runs as superuser today, so there is nothing to do now. It is written down because the day
least-privilege arrives, this is the read that silently returns **zero rows** and quietly stops
applying every operator entry, with no error anywhere.

---

## 19. What `0018` adds — the LINE's hourly production, and one question

One new table, `oee.product_perf_wc_hour`. It backs the **Performance Loss →
Trendline** sub-tab on the Line report's Losses page, which ships an **empty
state** against it until you fill it — the same terms `0016` shipped on.

It is `oee.product_perf_wu_hour` keyed one level up, with `work_unit_*` replaced
by `work_center_*` and `0014`'s two-unit rule applied. If you already model the
machine table, this is that model at the line's own count points.

### 19.1 PLEASE DO NOT BUILD IT AS A ROLL-UP — and we told you the opposite once

`product_perf_wu_hour` already carries `work_center_id` NOT NULL with an index on
`(work_center_id, business_date)`, so grouping machine rows by line is trivially
available, and an earlier version of our backlog said to do exactly that. **That
was wrong, and this section is the correction.**

§16.10a(a) settled that **a line is MEASURED, not summed**: `line <> sum(machines)`.
So a machine-summed hourly curve would **not integrate to the line's own shift and
day totals** — the same figures the overview card renders at the top of the very
page the chart sits on. That is §17.1's argument one grain finer, and it is worse
here: two numbers disagreeing can carry a footnote, but a CURVE whose area
disagrees with the tile above it cannot be explained to a supervisor.

Same count points as `product_count_wc_*` (§17), one bucket finer.

### 19.2 THE ONE QUESTION: which side is `ideal_rate_per_hour` on?

**We have assumed the OUTPUT side, and the CHECK constraint encodes that
assumption. Please confirm or correct it before your first load.**

`ideal_out` is the load-bearing generated column — it turns the non-additive
master RATE into an additive QUANTITY, which is what makes `sum(ideal_out)`
correct at any grain where `avg(rate)` is not (§3.5 works that arithmetic).
Everything derived from it inherits its unit.

- **Output side (assumed).** `ideal_rate_per_hour` is in `output_uom_id` per hour,
  `ideal_out` is output-denominated, and performance is
  `effective_out / ideal_out` — both output, so the ratio is unit-consistent.
- **Infeed side.** Then every attainment figure divides an OUTPUT count by an
  INFEED target: cartons over bags. **It produces a number between 0 and 1 that
  looks exactly like a percentage, and nothing downstream can detect it.**

`ck_ppwch_output_units` refuses a standard with no output unit to express it in,
so a row that disagrees with this assumption fails the load rather than loading a
figure nobody can falsify. If your standards are genuinely infeed-denominated, say
so and we will add a second pair of columns rather than reinterpret these.

### 19.3 The two units are `0014`'s rule, unchanged

| Side   | Columns                                                           |
| ------ | ----------------------------------------------------------------- |
| INFEED | `total_out`, `reject`, `rework`                                   |
| OUTPUT | `good_out`, `effective_out`, `ideal_out` (and the standard above) |

Both `*_uom_id` are nullable, and NULL means **"the members disagreed"**, not
"unknown" — with that side's counts NULL alongside it, enforced by
`ck_ppwch_infeed_units` / `ck_ppwch_output_units`. §16.4's rule, and **these can
fail your load** for the same reason.

A count with no unit is `500 BAG + 12 CARTON = 512 <blank>`, and a chart is a
worse place for that than a tile: an axis label is read once and a shape is read
continuously.

### 19.4 Per product, and the key

`(work_center_id, bucket_start, product_id)`, mirroring `0006`. `product_id` is in
the key because a changeover mid-hour is legitimate — one bucket, two products,
two rows, each with its own runtime and its own standard.

`shift` is deliberately **NOT** in the key. `(work_center_id, bucket_start)`
determines `business_date`, `shift`, `hour_of_day` and `shift_hour_seq`; those are
denormalisations, not independent facts, so including `shift` would make "two rows
for one bucket claiming different shifts" representable. `0006`'s reasoning
verbatim.

`bucket_start` is an **INSTANT**. On a DST fall-back day the local hour 01:00
happens twice and those are two distinct buckets — §3.6 is still the
highest-risk instruction in this document and it applies here unchanged.

### 19.5 Watermarks

`0018` adds `product_perf_wc_hour` to `ck_etl_watermarks_table`. Write the
post-hook row as §4 describes.

Note what is **not** there: `work_center_quality_entries` (§18) is deliberately
absent, so a dbt model of that name fails on its post-hook. That is the tripwire,
not an oversight.

### 19.6 What is NOT asked of you

- **No aggregate by hour at the shift, day or month grain.** This service reads the
  buckets and aggregates them itself — 24 for a day, 24 hour-of-day buckets for a
  month, collapsed from ~720. §23's denominator rule applies: the month's rates are
  RECOMPUTED from `ideal_out` over the runtime that carried a standard, never
  averaged.
- **No backfill before you are ready.** The screen says "not loaded yet" rather
  than drawing a flat line at zero, which is the same honest-empty trade `0008`,
  `0009` and `0016` already made.
- **Nothing about operator entries.** §18's reject and rework do not touch this
  table. They move `reject` and `rework` on the three report tables and no rate
  anywhere — see §18.7.

---

## 20. What `0019` adds — the LINE's rejects, and a table we should have asked for sooner

One new table, `oee.reject_count_wc_shift`. It backs the **Quality Loss Pareto** on
the Line report's Losses page, which ships an **empty state** against it until you
fill it.

It is `oee.reject_count_wu_shift` (§3.8) keyed one level up: `work_unit_*` replaced
by `work_center_*`, and `shift_date` renamed `business_date` to match the rest of
the `work_center_*` family (§16.1's divergence). If you already model the machine
table, this is that model at the line's own count points.

### 20.1 WHY IT EXISTS — this is the third time, and the clearest

The Line screen's Quality Loss Pareto read **your machine table**,
`reject_count_wu_shift`, scoped by `work_center_id`. That is a machine-sum, and
§16.10a(a) settled that **a line is MEASURED, not summed**.

What makes this the sharpest instance is that the contradiction sits on **one
screen, two cards apart**:

| Card                 | Reads                                 | Denominated in                           |
| -------------------- | ------------------------------------- | ---------------------------------------- |
| Losses → Reject tile | `work_center_shift_reports.reject`    | the line's own infeed count point        |
| Quality Loss Pareto  | _(was)_ sum of the machines' counters | a different set of count points entirely |

Those two disagree, **the disagreement is correct**, and nothing on the page can
explain it. A supervisor reading "Reject 5,000 BAG" above a Pareto whose bars
total something else has been handed two right answers to one question.

Your machine table is not wrong — it is the machines' rejects, and the machine
report's own Pareto reads it correctly. What was wrong was pointing a LINE screen
at it and changing only the `WHERE` clause. **The `WHERE` changed the grain.**

### 20.2 What is NOT being asked, and please do not "fix" it

**The Others tab keeps reading `oee.downtime_log_events` at line scope, and that
is correct.** A reject and a stop are different kinds of fact:

- a **reject** is a COUNT AT A COUNT POINT. The line has its own, so the machines'
  counters are a different measurement.
- a **stop** is an EVENT IN TIME. A stop on a machine _is_ a stop on the line. The
  union is the answer — which is why downtime has always been scoped by a query
  param at work unit, work center, area or factory.

There is no `downtime_log_events_wc` and there should not be one.

### 20.3 One table, widened — no day or month sibling

`reject_count_wu_shift` has no day or month table either; the coarse Paretos widen
the shift table over a date range. Same here, for the reason §17.3 gives for
stopping at two: a second table is a second thing to keep consistent for a read
that a range already answers.

### 20.4 The columns, and the one that is deliberately absent

Everything §3.8 asks for, with `work_unit_id`, `work_unit_name` and
`work_unit_code` **removed**.

That absence is the point of the file. **These are the LINE's count points.** If a
reject can be attributed to a machine it belongs in `reject_count_wu_shift`, which
already exists and which the machine report reads. A nullable `work_unit_id` here
would invite exactly the roll-up this table replaces.

`reason` is a primary-key member and must be **stable** — §3.8's rule, unchanged: a
renamed tag reads as a new counter and splits one shift's history in two.

`converted_value` is **generated** from `counter_value * factor_to_base`, as it is
on the machine table, so a reader cannot drift from what a BI tool sees off the
same row. It is the only figure the Pareto ranks on.

### 20.5 The unit rule, which bites harder here

The reader **abstains** when the rows in one bucket disagree on `uom_code` — it
reports a NULL unit and the screen renders an em dash rather than summing unlike
things. That is §16.4's rule reaching the Pareto.

It matters more at this grain than at the machine one, where a work unit has a
single unit and the guard is near-decorative. A line's count points can genuinely
differ, so **please write `uom_id` / `uom_code` per row honestly** rather than
normalising them — the abstention is a better answer than a confident wrong total,
and it only works if the rows tell the truth.

### 20.6 Watermarks

`0019` adds `reject_count_wc_shift` to `ck_etl_watermarks_table`. Write the
post-hook row as §4 describes — without it the Pareto cannot tell "not loaded yet"
from "this line rejected nothing", which are opposite claims about an identical
empty response (§14).

### 20.7 A question, and an apology for the ordering

**Do your line count points record a reason at all?** §3.8's `reason` is a PLC
counter tag (`Total_NG_Prod`, `NG_Over_Count`) and this table assumes the line's
equivalent exists. If a line's reject counters are unlabelled, say so — the table
would then need a single synthetic bucket rather than a NOT NULL key member, and
that is better decided now than discovered on a first load.

This should have been asked alongside §17, when the same argument produced
`product_count_wc_*`. It was not, and a Line screen shipped reading the machine
table in the meantime.

## 21. What `0020` adds — SKU attribution for downtime — **ANSWERED 2026-09-02**

> **THE PIPELINE OWNER'S ANSWERS.** Recorded here rather than summarised, because
> two of them change what the application may assume.
>
> **Q1 — attribution rule: THE SKU RUNNING WHEN THE STOP STARTS.** Chosen from the
> three offered; the other two are not implemented and should not be assumed
> anywhere.
>
> **Q1 also brought an unasked-for fact that is more consequential than the
> answer.** Apache Flink detects downtime on the stream, and its procedure is:
>
> 1. nothing produced for 1 minute → write a stop to Silver as `SMALL_STOP`;
> 2. past 5 minutes → UPSERT, promoting `category` to `PLANNED` / `UNPLANNED`;
> 3. production resumes → UPSERT `end_at` and `duration`;
> 4. **nothing produced through to the end of the shift → UPSERT, forcing `end_at`
>    and `duration` TO THE SHIFT BOUNDARY.**
>
> Step 4 is a guarantee this document did not previously have:
> **NO STOP CROSSES A SHIFT OR A DAY.** It is deliberate — the owner's stated
> purpose is exactly that. See §21.7 for what it does and does not license.
>
> **Q2 — yes, the SKU is known at detection time**, but Silver records the
> product's EXTERNAL CODE. Resolving it to a real `product_id` / `product_name`
> requires joining `ms_core.product_code_alias` on that external code. That join is
> the pipeline's; this service never sees an external code.
>
> **Q3 — `product_id` and `product_name` will always be written together**, and
> data consistency in Gold is guaranteed by the loader. So `0020`'s decision not to
> add a pairing CHECK stands on the owner's word rather than on hope.
>
> **`product_code` was not requested**, so `0020`'s two columns stay two.
>
> **The index question (§21.6) is deferred to the backlog** at the owner's request
> — TODOS.md §72.

### 21.7 What the shift-bounded guarantee does NOT license

Flink forcing `end_at` to the shift boundary means a straddling stop should not
exist in Silver, and therefore should not reach Gold. **This service is not
removing its straddle handling, and that is not distrust.**

- `clipToWindow`, the two-shift freeze in `listApprovalsOverlapping`, and the
  half-open overlap test all stay. They are the difference between a wrong number
  and a right one IF the guarantee ever lapses — a Flink restart mid-shift, a
  backfill written by something other than Flink, a shift-calendar change applied
  to one system before the other.
- An **open** stop still exists: `end_at IS NULL` for the whole of a stop in the
  currently-running shift. Everything that reads `coalesce(end_at, ...)` is still
  live.
- What it DOES license is expectations: a stop spanning two business days is now
  a **data-quality signal**, not a normal case, and it is worth alerting on rather
  than silently clipping.

If step 4 ever changes, tell us before it ships. It is the kind of change that
alters numbers rather than breaking a query.

Two columns, `product_id` and `product_name`, on **both** downtime tables:
`oee.downtime_reports` and `oee.downtime_log_events`. Both are **nullable** and
every existing row has them NULL, which is the honest state until you write them.

They exist for the SKU/Product daily report (TODOS.md §65), which is "one SKU, on
one line, on one business date". Everything on that screen that counts — Finish
Good, Effective Prod, Runtime, Performance, the Quality Pareto — is already
answerable from tables you have or have been asked for (`product_count_wc_day`
§17, `product_perf_wc_hour` §19, `reject_count_wc_shift` §20). Everything on it
that involves **time** — Availability, therefore OEE, the timeline, the waterfall,
the Losses durations, the downtime table — is not, because **no row anywhere in
Gold says which SKU was running when a line stopped**.

### 21.1 WHY THIS IS A COLUMN AND NOT A NEW TABLE

§16.10a(a), §17.1, §19 and §20 all reached the same answer — a line is MEASURED,
not summed, so it gets its own table. This one deliberately does not, and the
difference is worth stating because it looks like the same question.

Those four were about a **count at a count point**: the line has its own counter,
so its number is a measurement and cannot be reconstructed from its machines'.
A stop is not a count, it is an **event in time**, and §20 already recorded the
consequence — a stop on a machine genuinely IS a stop on the line, which is why
downtime is scoped by query param at every level of the hierarchy and why the
Others tab was explicitly not "fixed" to match the reject tables.

SKU is a third kind of axis and neither rule covers it. The hierarchy axis is
**containment** — a work unit is inside a work center, permanently. SKU is
**occupancy over time**: the line runs A, then B. A stop while A was running is
not a stop on B, and no scope parameter can derive that, because the fact is not
in the row. So: a column, on the rows you already write, not a fifth aggregate.

### 21.2 It is a FILTER, not a scope

`SCOPE_COLUMN` in this service maps `work-unit` and `work-center` and refuses
`area` and `factory`. `product` is never a member of that enum. A SKU read is
always a scope **plus** a product predicate — "this SKU, on this line" — because
a SKU across the whole plant is a different question nobody has asked for.

Nothing changes for you here; it is recorded so a future `scope=product` request
is recognised as a different design rather than a missing case.

### 21.3 THE UNIQUE KEY FORCES THE ATTRIBUTION RULE — please confirm which one you pick

`oee.downtime_reports.source_event_id` is UNIQUE (§3.7, added by `0007`). It is
the idempotency key and the eventual `ON CONFLICT` target. **A stop is one row,
permanently.**

So a stop that **straddles a changeover** — starts under SKU A, ends under SKU B —
**must not be split into two rows.** Two rows would carry the same
`source_event_id` and the second INSERT fails the unique index; giving one of them
a NULL `source_event_id` to dodge that resurrects the duplicate-on-retry bug
`0007` exists to close.

**Q1. Which rule do you apply?** Any of these is workable and we do not have a
preference, but we need to know which, because it changes what the number means:

- the SKU running at `start_at`, or
- the SKU that occupied the majority of the stop's duration, or
- NULL whenever the stop is not wholly inside one SKU's run.

**Q2. Is the SKU knowable at all from Silver at the moment a stop is recorded?**
If it is only derivable by joining a stop's window against a production run
elsewhere, say so — that is a legitimate answer and it tells us these columns will
be sparse rather than mostly-populated, which changes what the screen must say.

### 21.4 NULL means "not attributed", never "no product"

Two consequences, and the second is the one that produces a wrong number quietly.

- **A SKU-scoped read filtering `product_id = X` excludes every unattributed
  stop.** Until you write the column that is every stop, so a SKU report would
  read Availability 100% with an empty downtime table — a plausible screen, not an
  error. This service will distinguish "no stops" from "no attribution" the way
  §8 and §14 already distinguish the ETL-not-loaded case; that is our half.
- **Per-SKU downtime does not sum to the line's downtime** while any row is
  unattributed, and the residual is invisible on a per-SKU screen. This is the
  "measured, not summed" rule arriving from the other direction: there, summing
  children contradicted a measured parent; here, summing the attributed rows
  **understates** the parent by exactly the unattributed remainder.

`product_name` is denormalised and nullable, matching `work_unit_name`,
`work_center_name` and `area_name` on the same table. `0020` deliberately adds
**no** `(product_id IS NULL) = (product_name IS NULL)` check, because those three
older columns keep no such rule and a guard on product alone would be a
constraint nobody agreed to. **Q3: please keep them written together anyway** — an
id with no name renders a bare integer to a supervisor.

`product_code` was **not** added, unlike `product_count_wc_*` (§17) and
`reject_count_wc_shift` (§20) which both carry it. If you would rather write the
same triple everywhere, say so and it is one more `ALTER TABLE`.

### 21.5 The two tables must agree

`downtime_log_events` (§3.9) gets the columns too. It has no duration and no
instant — you assign each event to exactly one `(work_unit_id, shift_date, shift)`
and the contribution is 1 — and a SKU changes none of that. It adds one thing to
decide at assignment time, and **it must be decided the same way as for
`downtime_reports`**: the two are read side by side on one Losses page, so the
same real stop attributed to two different SKUs would put the Others tab and the
Availability Pareto in visible disagreement on one screen.

### 21.6 No index yet, and why we are telling you

`0020` adds no index on either column. At the row counts we can see, one would be
built over a column that is 100% NULL, and `0007` declined an index on the same
table for the same reason. When your load lands, the likely answer is a **second**
GiST index leading with `product_id`, not a change to `dt_reports_span_gist` —
whose expression every query must repeat character for character, so altering it
silently unindexes the existing callers. If you expect these columns to be dense,
tell us and we will measure before the first big load rather than after.

## 22. What `0021` adds — a real business date on downtime — **ANSWERED 2026-09-02**

> **ALL THREE ACCEPTED.** `business_date` + `time_zone` will be written (Q1), `date`
> keeps being written until we say otherwise (Q2), and the backfill will be a real
> derivation rather than a cast (Q3).
>
> **Q2 came back with an offer we should take: DROP `date` NOW.** The owner's
> reasoning is that the pipeline is still being designed, no data has landed, and
> this is a development server — so the cost of carrying two columns meaning the
> same thing is higher than the cost of removing one. Explicitly: _"jika kamu
> berinisiatif untuk menghapus kolom tersebut kamu bisa melakukannya sesegera
> mungkin."_ TODOS.md §71 carries it. §69 removed the last read-path reader of
> `date` on 2026-09-02, so nothing in this service is waiting on it.
>
> **Q3 carried the most important thing in either answer, and it is not about
> dates.** See §23 — the schema's purpose and its intended consumers.

Two columns on `oee.downtime_reports`: `business_date date` and
`time_zone varchar(64)`. Both **nullable**, both NULL on every existing row.

`oee.downtime_log_events` needs **nothing** — it already carries
`shift_date date NOT NULL` and `time_zone varchar(64) NOT NULL` from §3.9. This
section is about the older table only.

### 22.1 The problem

`oee.downtime_reports.date` is `timestamp with time zone`, and the value in it is
a **business day**. The type says instant; the meaning is a day. There is no
`COMMENT` on the column and the only place that semantics is written down is a
source comment in this service.

That is survivable while one service reads it and unsurvivable the moment a second
one does, which §21's SKU work makes imminent — a SKU report is keyed on a
business date, and joining a `date`-typed-as-timestamptz against a real `date`
column is a silent off-by-one rather than a type error.

### 22.2 THE ONE THING WE NEED YOU TO NOT DO

**Do not backfill `business_date` with `date::date`.**

`timestamptz::date` resolves through the session's `TimeZone`. For any plant WEST
of whatever zone the session happens to be in, an instant at or near local
midnight truncates to **the previous day**. Every boundary stop moves one day,
every window that should contain it stops containing it, and nothing raises.

Measured against `postgres:18-alpine` rather than reasoned about — one instant,
local midnight in a UTC+7 plant, cast under two sessions:

```
SET TimeZone='UTC';           ('2026-09-02 00:00:00+07')::date  ->  2026-09-01
SET TimeZone='Asia/Jakarta';  ('2026-09-02 00:00:00+07')::date  ->  2026-09-02
```

The container's default is UTC and our migrator sets no `TimeZone`, so the naive
backfill takes the first branch on every boundary row.

We did not write the backfill into `0021` for this reason, and we cannot write it
correctly from here: **only the writer knows which zone the day was cut in.** That
is why `time_zone` arrives in the same migration rather than later — a business
day with no zone cannot be turned back into an instant range, which is the same
pairing §15 made for the machine reports.

### 22.3 What we are asking for

- **Q1.** Write `business_date` as the plant-local calendar day the stop is
  attributed to, and `time_zone` as the IANA zone that day was cut in — the same
  pair, and the same rule, as `downtime_log_events.shift_date` / `time_zone`
  already uses. If a stop's attribution rule differs between the two tables, say
  so; they are read on one screen.
- **Q2.** Keep writing `date` as well, unchanged, until we tell you otherwise.
  It is still `NOT NULL` and it is still what our overlap queries narrow on. We
  retire it on our side in a later change (TODOS.md §69) and will confirm here
  before asking you to stop.
- **Q3.** For rows already loaded, a re-derivation from the source event's own
  local timestamp is correct; a cast of `date` is not, per §22.2. If the source
  no longer has that, tell us — a partial backfill with honest NULLs is better
  than a complete one that is a day out on the boundary rows, and our reads
  already distinguish "not loaded" from "nothing happened" (§8, §14).

### 22.4 A naming inconsistency we are choosing to keep

`business_date` here, `shift_date` on `downtime_log_events`. Both are the same
concept, and the split already exists across the schema: the `work_unit_*` family
says `shift_date` (§3.8, §3.9) and everything added since `0013` says
`business_date` (§15, §16.1, §17, §20).

We are not renaming `shift_date`. It is `NOT NULL`, you may already be writing it,
and a rename is a breaking change bought for tidiness. New tables get
`business_date`; the two older ones keep their names. Flagging it so it reads as a
decision rather than as drift when you meet both in one model.

## 23. What this schema is FOR — stated by its owner, 2026-09-02

Recorded because every table-shaped decision in this document has been argued
locally, and this is the first statement of what the whole is supposed to become.
It is the tiebreaker for the next "should this be its own table?" question.

### 23.1 The priority is a GOOD SCHEMA, not more tables

> _"yang harus diprioritaskan sekarang adalah bentuk skema database gold yang baik.
> Tidak over table report, sesuai dengan functional requirement itu yang paling
> wajib."_

**Do not over-table.** Match the functional requirement and stop. This is a direct
counterweight to the reasoning in §16.10a, §17.1, §19 and §20, each of which
answered "measured, not summed" with a new table — correctly, but the pattern is
not a licence. It is also why `0020` attributed downtime to a SKU with **two
columns** rather than a seventh report table: the cheaper shape was the right one,
and this section is the reason to keep preferring it.

### 23.2 The intended surface, which is larger than what exists

Reports, for the application, at every combination of:

| Subject            | shift   | day     | month   | year         |
| ------------------ | ------- | ------- | ------- | ------------ |
| work unit          | shipped | shipped | shipped | shipped      |
| work center (line) | shipped | shipped | shipped | shipped      |
| SKU                | —       | shipped | —       | —            |
| area               | —       | shipped | shipped | shipped      |
| **factory**        | —       | —       | —       | **required** |

_The status column is kept current as tables land; the prose below is the owner's
statement of intent and is left as written. SKU shipped as `0023` (§24); area's day
grain as `0024` (§25) and its month grain as `0025` (§26) — a separate table,
because a month's rates cannot be got by widening a day's. **Area is TWO grains
rather than three, deliberately**: the requirement is explicit that it "only have 2
type of report on the Area", which makes it the first subject where the
`{shift, day, month}` triple is broken by decision rather than by absence. **The
year grain then broke that triple a second time and in the opposite direction**:
`0027` added it for work unit, work center and area, which is MORE than this table
asked for — §27.1 states that widening rather than leaving it to be discovered. Only
FACTORY is left, and it is still the subject with no table at any grain._

Then a second surface on top of the same data: an **OEE Performance dashboard**
for work unit, work center, area and factory.

Two things follow that are worth saying now. **Factory is the only subject that
needs a YEAR grain**, and nothing in this schema has a year grain yet — the
`{shift, day, month}` triple has been assumed universal and it is not. And **area
and factory have no report table at all**, which is the same gap TODOS.md §15 hit
from the SKU side and could not answer.

### 23.3 Gold is meant to be read by people outside this application

> _"harapan kami juga besar agar tabel tabel dan data data yang sudah ada dapat
> dikonsumsi oleh pihak external agar bisa dianalisa."_

Third parties should be able to point their own BI tooling at these tables and
build the analytics this application does not provide.

**This raises the bar on things that have so far been treated as internal
conveniences**, and it is the strongest argument yet for several open items:

- **Column names and semantics are a public interface.** `date` meaning a business
  day while typed `timestamptz` (§22) is exactly the trap an external analyst
  cannot be warned about — they have no `shift-window.ts` to read. The
  `shift_date` / `business_date` split (§22.4) is the same hazard, milder.
- **Documented meaning has to live in the database**, since a reader outside this
  repo sees only `COMMENT ON COLUMN`. `0020` and `0021` both comment every column
  they add; older tables are patchier.
- **The unit rules become load-bearing for strangers.** §16.4a's two-unit split —
  `total_out = good_out + reject + rework` being FALSE at the line grain — is
  correct, deliberate, and the single most likely thing an external analyst gets
  wrong. It needs to be discoverable from the schema, not just from here.

### 23.4 Before production

The owner will add migration, rollback and data-migration documentation to this
contract once the application is live, so that changes are made with more care
than a development server warrants. **Until then, destructive changes on an empty
development database are cheap and are the right time to make them** — §71 is the
first of those, offered rather than requested.

## 24. What `0023` adds — the SKU grain, and the one thing you must not do to it

One table, `oee.product_report_wc_day`. **One SKU, on one line, on one business
day.** It ships EMPTY and backs the SKU/Product daily report, which is the third
of the five report subjects §23.2 lists.

Day grain only. No shift table and no month table — a month is this table widened
over an interval, exactly as `product_count_wc_day` serves the line's month screen.

### 24.1 THE RULE: MEASURED PER SKU, NEVER APPORTIONED FROM THE LINE

This is the same sentence §16.10a, §17.1, §19 and §20 each needed, one grain
further down, and it is the only thing in this section we cannot recover from if it
is got wrong.

**`line <> sum(SKUs)`.** A line's availability is its own wall clock. It cannot be
divided between the products that shared the day, because the stops did not divide
— a changeover belongs to the changeover, not to 40% of SKU A and 60% of SKU B.

The tempting shape, and the one we are asking you **not** to build:

```sql
-- DO NOT DO THIS
SELECT r.availability,                          -- the LINE's, copied down
       r.availability_loss_time * (p.good_out / sum(p.good_out) OVER ()) -- apportioned
```

It produces a table where every SKU on a line reports the **same** availability,
and loss durations that sum neatly to the line's. Both properties look like
correctness and are the opposite: they are the roll-up this table exists to deny,
and a supervisor comparing two SKUs on one line would find them identical for a
reason no screen could explain.

If a SKU's own availability is not measurable from your sources, **write NULL**.
The screen renders an em dash. A wrong number does not.

### 24.2 The key, and why there are two of them

`id integer GENERATED ALWAYS AS IDENTITY` is the primary key, and
`UNIQUE (work_center_id, business_date, product_id)` sits beside it.

**Please load this table with an UPSERT on the natural key**, not
`DELETE`-then-`INSERT`. The browser puts `id` in URLs and cache keys, as it does
for all six existing report tables, so a churning `id` silently retargets a deep
link at a different SKU. `0007`'s header records that hazard on
`downtime_reports.id`, where there was no natural key to upsert on until
`source_event_id` existed. There is one here from the first migration.

```sql
INSERT INTO oee.product_report_wc_day (...) VALUES (...)
ON CONFLICT (work_center_id, business_date, product_id) DO UPDATE SET ...
```

### 24.3 What is deliberately absent

- **No `teep`.** TEEP divides by CALENDAR time, and a SKU does not own the
  calendar — the line does, and shares it. `oee` stays, because it divides by the
  SKU's own loading time.
- **No `work_unit_count`.** A SKU ran on one line; `work_center_id` is NOT NULL
  and single-valued.
- **No per-machine rows.** §15's base-unit conversion problem is unchanged.

### 24.4 The two units, and one difference from `0014` worth reading

Same infeed/output split, same `CHECK` pair nulling a side's counts with its unit,
same consequence: **`total_out = good_out + reject + rework` is FALSE here**
(§16.4a).

One word differs. On a `work_center_*` row, a NULL unit means _"the members
disagreed"_. Here there are no members — one SKU, one line — so NULL means simply
_"not known"_. That makes it **rarer and more suspicious**: at the line grain a
NULL unit is a normal outcome, here it is a data-quality signal.

`time_zone` is `NOT NULL`, unlike on `downtime_reports` where `0021` had to admit
existing rows. This table is empty, so the pairing can be enforced from the start.

### 24.5 The watermark

`product_report_wc_day` is now in `ck_etl_watermarks_table`. **Please write the
row.** Without it the screen cannot tell _"this SKU had no production that day"_
from _"the DAG has not run"_, which is the distinction §8 and §14 both exist for
and the one thing an empty report cannot say for itself.

### 24.6 Questions

- **Q1. Can you measure a SKU's own availability at all?** If loading time and
  downtime are only attributable to the LINE, say so — the honest answer changes
  the screen (the OEE tiles render em dashes and the Losses card leans on §21's
  downtime attribution instead) and is much better than an apportioned figure.
- **Q2. Does `0020`'s downtime `product_id` come from the same attribution you
  would use here?** They are read on one screen: the Losses card sums this table's
  `availability_loss_time`, and the downtime table beneath it lists stops filtered
  by `product_id`. If the two rules differ, those two disagree and neither is
  wrong.
- **Q3. Is a SKU that ran for ten minutes a row?** We would rather have it with
  tiny durations than not have it — a missing row reads as "did not run", and
  §14's argument applies. But if you plan a floor, tell us the threshold so the
  screen can say so.

## 25. What `0024` adds — the AREA grain, and the two things about it that invert `0014`

One table, `oee.area_day_reports`. **One area, on one business day.** It backs the
`Report > Area > By Day` screens and it ships EMPTY.

TODOS.md §74 said not to start by writing tables and asked the prior question
first: which of the remaining subjects is a MEASUREMENT with its own count points,
and which is a legitimate roll-up. **That question is answered here, and the answer
is not the one the last four migrations gave — so please read §25.1 before
anything else.**

### 25.1 A LINE IS MEASURED. AN AREA IS COMPOSED.

`0014` exists because a line has its own count points: an infeed counter and an
output counter, physically on the line, so `line <> sum(machines)` is not a defect
and a roll-up would have contradicted the line's own instruments. §17.1, §19.1 and
§20.1 each repeat that argument one axis over. §24.1 repeats it for SKU.

**An area has no instrument.** There is no counter at the edge of an area and no
clock that an area runs on; an area is a set of lines that happen to be managed
together. So every figure on this row is a COMPOSITION of its member lines'
figures, and two consequences follow that no other report table in this schema has
to deal with.

### 25.2 THE DURATIONS ARE LINE-MILLISECONDS, NOT WALL-CLOCK MILLISECONDS

`0014`'s header is explicit that a line's durations are "the line's own wall clock
— 8 hours over a 4-machine shift, not 32", and an earlier reading of it that called
them "machine-milliseconds" was CORRECTED. **At this grain that corrected reading is
the right one.** `availability_time` for a five-line area on one business day is
~120 hours, not ~24.

It has to be, or the loss durations could not add: an area that lost 3 h on line A
and 2 h on line B has lost 5 h of production capacity, and there is no "wall clock"
reading under which that is anything else.

**So `runtime` on this table WILL exceed 24 hours on a normal day.** The Run Time
tile is expected to read "97 h 12 m" and carries a tooltip saying so. Please do not
divide by the line count. The `COMMENT ON COLUMN` says this in the database too,
because an external reader has no source file (§23.3).

### 25.3 THE COUNTS ARE A MASS, AND THAT IS WHY THERE IS ONLY ONE UNIT

`0014` gives a line TWO unit triples because bags go in and cartons come out.
**An area's members disagree about BOTH sides** — one line ships cartons, another
sacks — so `0014`'s shape applied here would leave both triples NULL on almost
every row and null every count with them. The Total Production tile would be a
permanent em dash.

Weight is the answer, and it is the requirement's answer:

> _"{Area} Production, Total Production, and Finish Good use Weight Unit. Every sku
> packageing have weight, min weight, max weight value."_

Every product package in `ms_product.product_packaging` carries `std_weight` /
`min_weight` / `max_weight`, so a count in ANY packaging unit converts to a mass.
Mass is the only unit that survives composition across an area, which is exactly
why an area has one unit where a line has two. **The `0014` rule is not being
relaxed; it is being satisfied by picking a unit the members can all be expressed
in.**

**What we need from you:** `weight_uom_*` and the five counts, converted through
`std_weight`. Three things about that conversion:

- **NULL when you cannot do it.** If a product that ran in the window has no
  `std_weight`, write NULL for the unit and NULL for all five counts —
  `ck_adr_weight_units` requires the pairing. That is a data-quality signal pointing
  at master data, and it is much better than a mass computed from a guessed weight.
  Note this is a THIRD meaning for a NULL unit in this schema: on a LINE row it
  means the members disagreed, on a `0023` SKU row it means simply not known, and
  here it means the members could not be brought to a common mass.
- **Please tell us which weight you use** — `std_weight`, or something derived from
  the min/max band. We assumed `std_weight` and the screen says nothing about it;
  if it is actually a measured average, that is worth naming on the tile.
- **`total_out = good_out + reject + rework` IS STILL NOT ASSERTED.** At line grain
  it is FALSE because the two sides are in different units (§16.4a). Here the units
  agree, so the sum is at least well-formed — and it is still not an identity,
  because the five figures come from different count points on N lines and mass is
  neither conserved through a packing line nor measured at a single point. No CHECK
  asserts it, for `0015`'s reason: a CHECK that failed a load over an arithmetic
  disagreement between count points would take a whole area's reporting down to
  protect a tile.

### 25.4 The roll-up rules, which are §15.5's with one addition

    durations and counts                    ->  SUM (in LINE-milliseconds; §25.2)
    rates (oee, availability, performance,
           quality, mttr, mtbf)             ->  RECOMPUTE from the sums

**Never `avg(availability)`.** §15.5 works the arithmetic on the analogous case; a
mean of ratios is not the ratio of the sums, and it is the sums this row holds.

The addition is `area_name` / `area_code` / `factory_id` / `factory_name`. The first
is NOT NULL; the other three are nullable and denormalised, exactly as `0014`
denormalises the level above a line. **`factory_*` is not read by this application
at all yet** — it is here so the factory report (§23.2) is a read rather than a
hierarchy lookup, and so an external analyst can group areas without joining out to
master data. The label-staleness policy is §16.6's, unchanged.

`apps/api/scripts/seed/0022_area_day_reports_dev.sql` is the executable form of
this section, and unlike `0015`'s seed **it is normative rather than a stand-in** —
because an area is composed, summing its lines IS the definition. The one thing it
cannot do is the mass conversion, so it writes NULL for the unit and the counts and
asserts that it did.

### 25.5 Which lines belong to an area, and the one column that is missing

Five of the six reads behind these screens scope by a plain `area_id` predicate,
because five source tables already carry the column:

| table                          | `area_id`     | added by |
| ------------------------------ | ------------- | -------- |
| `oee.area_day_reports`         | IS the key    | `0024`   |
| `oee.work_center_day_reports`  | yes, nullable | `0014`   |
| `oee.reject_count_wc_shift`    | yes, nullable | `0019`   |
| `oee.downtime_log_events`      | yes, nullable | `0009`   |
| `oee.downtime_reports`         | yes, nullable | `0007`   |
| **`oee.product_count_wc_day`** | **NO**        | —        |

The last row is the SKU View's only source, so that one read resolves the area's
LINES first — from `oee.work_center_day_reports.area_id` over the same window,
which is your own attribution rather than a master-data roster. It works, and it is
one round trip we would rather not make.

**A small ask, entirely optional:** `area_id` / `area_name` on
`oee.product_count_wc_{shift,day}`, denormalised the way `0019` and `0009` already
carry it. Same for `oee.work_center_quality_entries`, where the activity feed
currently fans out one query per line. Neither blocks anything.

**And one thing to know about the nullable ones.** A stop or a count row the
pipeline never attributed to an area is EXCLUDED from that area's totals, silently.
That is denormalisation lag rather than a semantic gap — containment means the area
IS derivable from `work_unit_id`, so the row is simply missing a label it could have
— which is why none of these reads ships an "unattributed" count the way the SKU
downtime reads do (§21.4). **If the column turns out to be sparse in production,
the fix is a backfill, and we would want to know rather than discover it as a low
OEE.**

### 25.6 What is deliberately NOT asked of you

- **No shift table.** The requirement is day and month only.
- **No month table in `0024`.** It is a separate migration and a separate
  deliverable — a month's rates cannot be got by widening a day's, which is why
  `oee.work_center_month_reports` exists beside the day one. It will be `0025`.
- **No `teep`.** TEEP divides by CALENDAR time, and an area owns no calendar a
  reader could name — is it 24 hours, or 24 times the line count? §25.2 makes the
  second of every other duration here, and a ratio over that denominator is one
  nobody has asked for. `oee` stays: it divides by the area's own composed loading
  time.
- **No `effective_out`.** The requirement's Area Overview names OEE, A, P, Q,
  Achievement, {Area} Production, Total Production, Finish Good and Runtime, and
  stops. §23.1 — match the requirement and stop.
- **No member count.** No `work_center_count`. The requirement's list and overview
  name none. **This is the field most likely to be asked for next**, and it is an
  `ALTER TABLE` when it is; say if you would rather write it now than add it later.
- **No per-unit table.** The requirement also asks for production summed across
  every unit the area's lines count in, which is the half a mass cannot answer. That
  is a read-time aggregate over `oee.work_center_day_reports` grouped by its own two
  unit triples — exact addition within a unit, with no denominator to invent — so
  §23.1 applies and there is nothing here for you to load.
- **No area hourly table.** The Performance Loss Trendline renders an empty state at
  this grain. An area-summed curve off `oee.product_perf_wc_hour` would be the
  roll-up §19.1 refuses; if an area-level hourly view is ever wanted it needs its own
  measured source, and that is a conversation rather than a column.

### 25.7 The watermark

`area_day_reports` is now in `ck_etl_watermarks_table`. **Please write the row.**
Without it the screens cannot tell _"this area had no production that day"_ from
_"the DAG has not run"_ — §8 and §14's distinction, and the state this table ships
in.

Note the Input/Output Production card reads `work_center_day_reports`' watermark
instead, because that is the table its rows are summed from. Two different loads,
and quoting the wrong one would vouch for a freshness the card's own source does
not have.

### 25.8 Questions

- **Q1. Which weight do you use, and per what?** §25.3. We assumed
  `product_packaging.std_weight` for the package the count was taken in. If it is a
  measured average or a min/max midpoint, the tile should say so.
- **Q2. Is an area with one line a row?** It is numerically identical to that line,
  which makes the screen look redundant but is not wrong. We would rather have it.
- **Q3. Should `area_id` be backfilled on the four nullable tables, and by when?**
  §25.5. Everything works without it and reports a subset of the plant when it is
  missing, which is the failure mode we would least like to find in production.
- **Q4. Do you want the member count now?** §25.6. One column, and it would stop
  the next requirement being an `ALTER TABLE`.

## 26. What `0025` adds — the AREA's month, and why it is not the day table widened

One table, `oee.area_month_reports`. **One area, one month.** It backs the
`Report > Area > By Monthly` screens and it ships EMPTY.

**§25 is the file to read first.** Everything that makes an area's numbers
different from a line's is argued there and is unchanged here: an area is COMPOSED
rather than measured, its durations are LINE-milliseconds, its counts are a MASS in
one unit, and `total_out = good_out + reject + rework` is not asserted. This
section is `0024` **plus one CHECK** and one argument.

### 26.1 Why a second table, when §17.3 chose the other way

This is the question `0016` answered in the opposite direction — it created two
product-count tables rather than three, "because a day table serves month by
widening, which `listPeriodProductCount` already proves". That reasoning is right
for a COUNT table and wrong for a REPORT table, and §15.5 is the difference:

    durations and counts   ->  SUM        widening a day range gives this
    rates (oee, a, p, q)   ->  RECOMPUTE  widening a day range does NOT

**A month's OEE is not the average of its days' OEEs**, and it is not derivable
from the day rows without redoing the recompute in the reader — which would put a
SECOND definition of area OEE in the API, one click from the day screens it drills
into. That is the failure `0023` and `0024` both exist to prevent.
`oee.work_unit_month_reports` and `oee.work_center_month_reports` exist for exactly
this reason, and so does this.

**What does NOT get a month sibling on the same argument:** the per-unit
Input/Output read widens `oee.work_center_day_reports` over the month, because
summing counts WITHIN one unit is exact addition with no rate in it. §23.1 applies
and there is nothing there for you to load. Note that reading the LINE DAY rows
rather than the line MONTH rows is deliberate and gives FINER unit resolution: a
line whose unit changed mid-month has a NULL unit on its month row, where its day
rows give two honest buckets.

### 26.2 The one thing this table adds: `business_date` is the FIRST of the month

`ck_amr_month_start CHECK (business_date = date_trunc('month', business_date)::date)`
— `0014`'s `ck_wcmr_month_start`, verbatim. §15.3's rule: **not the last, and not
midnight of the first.**

It matters more than it looks. Every READ resolves its window from the row's own
`business_date` and `resolveReportWindow` truncates to the month, so a mid-month
value would still produce the right window — but the LIST orders and filters on the
column directly, and `month` is a nullable display label OUT of the key that nothing
joins on. A row dated the 15th would sort between two other months' rows and answer
a `year = 2026` filter from a position no reader could predict.

### 26.3 The roll-up, which is §15.5's with `0024`'s two twists

    durations and counts   ->  SUM   (over the area's LINES *and* the month's DAYS)
    rates + mttr/mtbf      ->  RECOMPUTE from those sums

**Never `avg(availability)` and never an average of the days' rates.**

- **The durations are LINE-milliseconds times a month.** A five-line area's
  `availability_time` over a 30-day month is **~3,600 hours**, not ~720 and not
  ~744. The Run Time tile carries a tooltip saying so, and its sentence is
  deliberately different from the day screen's because the magnitude is ~30x
  larger. Do not divide by the line count or by the day count.
- **The month length is not a constant, and nothing in this app computes one.**
  Across a DST transition a calendar month is 743 or 745 real hours. The pipeline
  sums what elapsed; the API's boundary arithmetic is
  `resolveReportWindow`'s, in Postgres, with `AT TIME ZONE` resolving each
  boundary's own offset.
- **`mttr` / `mtbf` are RATIOS.** Neither table stores a failure count, so recover
  it per source row as `updt_time / mttr` and rebuild the two ratios over the
  summed repair time and the summed failure count. §15.4's rule that they are NULL
  rather than 0 is unchanged.

`apps/api/scripts/seed/0023_area_month_reports_dev.sql` is the executable form of
this section, and like `0022` it is **normative rather than a stand-in** — the
day→month hop is normative on every subject in this schema (`0013`'s seed and
`0015`'s step 3 both say so). Its step 2 asserts the duration sums, that the rates
were recomputed rather than averaged, that every row is dated the first of its
month, and that the counts are paired with their unit in both directions.

One thing that seed does that `0022` cannot: **it carries a mass through if one
exists.** It sums the day rows' counts rather than writing NULL, and gates the unit
on the days AGREEING — `count(DISTINCT weight_uom_id) = 1 AND count(weight_uom_id)
= count(*)`. The second half is §16.3(c)'s NULL-skipping trap: `count(DISTINCT x)`
skips NULLs, so a month mixing one unit-less day with twenty-nine KG ones would
otherwise report a confident KG over a sum that silently dropped the unit-less day.

### 26.4 The watermark

`area_month_reports` is now in `ck_etl_watermarks_table`. **Please write the row**,
and write `last_business_date` as the **latest MONTH START** rather than a month
end — that is what this table's `business_date` holds, and the browser compares the
two as business days. A month-end value would make the current month read as loaded
before its last day had run.

### 26.5 What is deliberately NOT asked of you

- **No shift table, and there will not be one.** The requirement is explicit —
  "only have 2 type of report on the Area" — so the application's `AreaGrain` is a
  two-member union rather than a reuse of the `{shift, day, month}` triple. This is
  the first subject in this schema where that triple has been broken deliberately
  rather than by absence.
- **No `teep`, no `effective_out`, no member count.** §25.6's four absences,
  unchanged. The member count is still the field most likely to be asked for next.
- **Nothing new on any source table.** Every sub-resource behind the month screens
  is a read the day screens already make with a wider `dateTo`.
- **No year grain.** §23.2 says factory is the only subject that needs one, and
  nothing in this schema or in the application's grain plumbing admits one yet
  (TODOS.md §74).

### 26.6 Questions

- **Q1. Is a month with one day of production a row?** We would rather have it —
  a missing row reads as "did not run", which is §14's argument. Say if you plan a
  floor.
- **Q2. Should the month row be REBUILT each run, or upserted as the month
  progresses?** The unique key `(area_id, business_date)` supports either, and the
  screen is honest under both — but a partially-elapsed month whose OEE is computed
  over the elapsed part only is a figure a supervisor will compare against a full
  month. If you write it progressively, we would like `last_business_date` on the
  watermark to say how far it covers, which it already does.
- **Q3. Does the mass conversion happen per DAY and then sum, or over the month's
  counts directly?** They differ if a product's `std_weight` changed mid-month.
  Either is defensible; we would like to know which, because the day and month
  screens will then disagree by that amount and the difference should be
  explainable rather than discovered.

## 27. What `0027` adds — the YEAR grain, and a widening of §23.2 we are stating rather than slipping in

Three tables — `oee.work_unit_year_reports`, `oee.work_center_year_reports` and
`oee.area_year_reports`. **One subject, one year.** They back the OEE Performance
dashboard's three YEARLY screens and they all ship EMPTY.

### 27.1 WE ARE ASKING FOR MORE THAN §23.2 SAID, AND THIS IS THE ASK

§23.2's table puts a year grain under **factory only**, and §26.5 says "No year
grain" in as many words. That was right when it was written. The application has
since been asked for a yearly OEE Performance dashboard at work unit, work center
and area — the same second surface §23.2 names for those subjects, one grain
coarser — and three tables is what that costs.

**We are flagging it rather than letting you discover three unasked-for tables in a
migration.** If you would rather the application derived a year in the reader, say
so and we will — but §27.2 is why we think you should not want that.

Factory is still absent at every grain. It has no report table, and
`oee.downtime_reports` has no `factory_id`, so it remains the one unmapped
`SCOPE_COLUMN` member.

### 27.2 Why a table, when a reader could widen the month range — §15.5, a third time

    durations and counts   ->  SUM        widening a month range gives this
    rates (oee, a, p, q)   ->  RECOMPUTE  widening a month range does NOT

**A year's OEE is not the average of its months' OEEs.** This is §26.1's argument
one grain up and nothing about it is new: the moment the API recomputes a year's
rates for itself there are two definitions of OEE in the system, one in dbt and one
in the reader, on screens that drill into each other. That is the failure `0023`,
`0024` and `0025` each exist to prevent.

What still gets no year sibling on the same argument: anything that sums COUNTS.
Exact addition with no rate in it needs no table (§23.1), which is why `0016`'s
product-count pair serves a month by widening and always will.

### 27.3 Each table is its month sibling's measure set, column for column

|                                | mirrors                     |
| ------------------------------ | --------------------------- |
| `oee.work_unit_year_reports`   | `work_unit_month_reports`   |
| `oee.work_center_year_reports` | `work_center_month_reports` |
| `oee.area_year_reports`        | `area_month_reports`        |

Deliberately, and it is what lets ONE payload type, ONE projection and ONE card set
serve both grains per subject — the property `0025` preserved between the two area
tables. **Every rule those three carry is carried here unchanged**: a line has two
units and `total_out = good_out + reject + rework` is FALSE at that grain (§16.4a);
an area has one unit and it is a MASS, its durations are LINE-milliseconds, and it
has **no `teep`** because TEEP divides by a calendar an area does not own (§25).

**Three departures, each of which will look like an oversight:**

1. **`business_date` is JANUARY 1**, enforced by `ck_{wuyr,wcyr,ayr}_year_start`.
   §15.3's rule one grain up: not December 31, and not midnight of January 1. It
   matters for `ck_amr_month_start`'s reason — the LIST orders and filters on this
   column directly.
2. **No `date timestamptz` on the machine table**, unlike its month sibling. `0014`
   dropped that column deliberately for the line grain and `0024`/`0025` never had
   one; a new table has no upstream history to preserve.
3. **No display-label column.** The three month tables carry a nullable `month
varchar(50)` out of the key that nothing reads, because the format was never
   specified upstream (§15.7). A `year` label would be a redundant, derivable column
   on a table with no such legacy — §23.1 at column scale. `business_date` IS the
   year.

### 27.4 The roll-up, which is §15.5's with each subject's own twists

    durations and counts   ->  SUM       (over the year's MONTHS)
    rates + mttr/mtbf      ->  RECOMPUTE from those sums

**Never `avg(availability)` and never an average of the months' rates.**

- **A YEAR'S LENGTH IS NOT A CONSTANT, twice over.** 8,760 hours, or 8,784 in a leap
  year — and 8,759 or 8,761 where a DST transition falls inside it. So `+ 365 days`
  is wrong roughly one year in four AND at every transition. Nothing in this
  application computes a year length: the pipeline sums what elapsed, and
  `resolveReportWindow` does the boundary arithmetic in Postgres with `AT TIME ZONE`
  so each boundary resolves its own offset. Our integration suite asserts a year
  equals the sum of its twelve month windows, in a DST zone.
- **The area's durations are LINE-milliseconds times a YEAR.** A five-line area's
  `availability_time` reads **~43,800 hours**. That is the intended figure. Do not
  divide by the line count or by the month count.
- **`mttr` / `mtbf` are RATIOS.** Neither table stores a failure count, so recover it
  per source row as `updt_time / mttr` and rebuild both ratios over the summed repair
  time and the summed failure count. §15.4's rule that they are NULL rather than 0 is
  unchanged.

`apps/api/scripts/seed/002{5,6,7}_*_year_reports_dev.sql` are the executable form of
this section, one per subject, and they are **normative rather than stand-ins** — the
day→month hop is normative on every subject in this schema (`0013`'s seed, `0015`'s
step 3, `0023`'s seed all say so), and month→year is that hop one step further with
no new argument. Each seed's step 2 asserts the duration sums, that the rates were
recomputed rather than averaged, that every row is dated January 1, and that the
counts are paired with their unit in both directions — per SIDE on the line.

### 27.5 The watermarks

`work_unit_year_reports`, `work_center_year_reports` and `area_year_reports` are now
in `ck_etl_watermarks_table`. **Please write all three rows**, and write
`last_business_date` as the **latest YEAR START** rather than a year end — that is
what these tables' `business_date` holds, and the browser compares the two as
business days. A year-end value would make the current year read as loaded before
its last month had run.

**One thing the dashboard depends on that is easy to miss:** the year TREND reads the
MONTH table, so it reports the MONTH watermark, not the year one. A plant whose month
model stopped in June would otherwise draw six points and claim to be current.

### 27.6 What is deliberately NOT asked of you

- **No year grain for SKU**, and none for factory. `oee.product_report_wc_day` has no
  month sibling either; factory has no table at all.
- **No approval at year grain, on any subject** — and the LINE one is the sharpest.
  A line's approve is already a cascade over its machines' shift reports; at year
  grain it would close roughly 1,095 shifts times N machines, which is not the
  permission `APPROVE_LINE_ROLE` grants. The application registers four routes per
  subject at this grain (list, detail, OEE trend, rejects) and nothing else.
- **No quality entry.** An entry is keyed by LINE and business DAY.
- **Nothing new on any source table.** Every sub-resource behind the year screens is
  a read the month screens already make with a wider `dateTo`.

### 27.7 Questions

- **Q1. Is a year with one month of production a row?** We would rather have it — a
  missing row reads as "did not run", which is §14's argument.
- **Q2. Rebuilt each run, or upserted as the year progresses?** The unique keys
  support either and the screens are honest under both, but a partially-elapsed year
  whose OEE is computed over the elapsed part only is a figure a supervisor will
  compare against a full one. If you write progressively, we would like
  `last_business_date` to say how far it covers — which it already does.
- **Q3. Does the area's mass conversion happen per MONTH and then sum, or over the
  year's counts directly?** They differ if a product's `std_weight` changed
  mid-year. §26.6's Q3 one grain up, and we would like the same answer to cover both.

## 28. What `0028` adds — ONE ONTOLOGY on every table, and a rename we need you to know about

`0028` puts the full `mes-master-data` hierarchy — **enterprise → site → area →
work center → work unit** — on every Gold report table and on every fact table a
report screen reads. Twenty-three tables. It also **renames `factory_id` /
`factory_name` to `site_id` / `site_name`** on the five tables that had them.

Nothing in it is a new table and nothing in it changes a measure. What it changes
is how much of the hierarchy a row states about itself, and one column name.

### 28.1 THE RENAME, AND WHY WE THINK IT HAD TO HAPPEN NOW

`0006`, `0018`, `0024`, `0025` and `0027` each added `factory_id` / `factory_name`
meaning "the level above the area". **There is no `factory` in `mes-master-data`.**
Its hierarchy is `ms_core.enterprices` → `ms_core.sites` → `ms_core.areas` →
`ms_core.work_centers` → `ms_core.work_units`; the level above an area is a SITE,
and above that an ENTERPRISE. `factory` was a local name for a level that already
had one upstream.

§23.3 is why that is not cosmetic: **Gold is meant to be read by people outside
this application**, and "column names and semantics are a public interface". A
column named for a level the master data does not have is a column an outside
analyst cannot join on. So this is a rename rather than a second column beside the
first — two names for one level is how a stranger groups by both and halves every
figure.

**It is safe for exactly one reason and the reason expires.** Every `factory_*`
column is NULL on every row today: nothing upstream resolves the level above an
area (`0024`'s own comment says "NOT filled, anywhere") and no dbt model writes
either column. That is the same licence `0013` used to correct
`availablity_loss_time` and the one §23.4 offered for `downtime_reports.date` —
and it will not be available once you start writing them.

**If any model of yours already selects `factory_id` or `factory_name`, it needs
the new name.** We believe none does. Please tell us if we are wrong, and we will
ship a compatibility view rather than ask you to change a running model.

### 28.2 THE COLUMNS, BY WHAT EACH TABLE WAS MISSING

Every table now carries the full chain ABOVE its own grain. Nothing carries a
level at or below it.

| tables                                       | what they had                | what `0028` adds                                 |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| `work_unit_{shift,day,month,year}_reports`   | work unit, work center       | **area**, site, enterprise                       |
| `work_center_{shift,day,month,year}_reports` | work center, area            | site, enterprise                                 |
| `product_report_wc_day`                      | work center, area            | site, enterprise                                 |
| `area_{day,month,year}_reports`              | area, factory                | site _(renamed)_, enterprise                     |
| `downtime_reports`, `downtime_log_events`    | work unit, work center, area | site, enterprise                                 |
| `product_count_wu_{shift,day}`               | work unit                    | **work center**, **area**, site, enterprise      |
| `product_count_wc_{shift,day}`               | work center                  | **area**, site, enterprise                       |
| `reject_count_wu_shift`                      | work unit, work center       | work center **code**, **area**, site, enterprise |
| `reject_count_wc_shift`                      | work center, area            | site, enterprise                                 |
| `product_perf_w{u,c}_hour`                   | … area, factory              | site _(renamed)_, enterprise                     |
| `work_center_quality_entries`                | work center, work unit       | **area**, site, enterprise                       |

Every one is NULLABLE, every one is `integer` + `varchar(255)`, and none is in any
key or any constraint. The names in **bold** are the ones a screen reads today.

**What `0028` deliberately does NOT touch**: `work_unit_shift_report_approvals`,
`…_approval_events`, `downtime_report_history`, `write_audit` and `etl_watermarks`.
Those are append-only audit trails addressed by natural key and never scanned by
area — a denormalised label there would be a second place for the hierarchy to
drift with no read that would notice.

### 28.3 WHAT WE ARE ASKING YOU TO FILL, AND IN WHAT ORDER

**`area_id` and `area_name` first, on the four `work_unit_*` report tables.** They
are the ones a screen reads and the ones no table carried. Everything else on the
list is genuinely lower priority.

The reason is §28.4. The rest — `site_*`, `enterprise_*`, and `area_*` on the
count/reject/hourly tables — is a denormalisation we want for the reason `0024`
gave for its own: so an external analyst can group without joining out to master
data, and so a future factory report is a read rather than a hierarchy lookup.
Nothing in the application reads them yet.

You already resolve `area_id` for `oee.product_perf_wu_hour` (`0006`) and for the
`work_center_*` tables, so the lookup exists; this asks for it on more rows rather
than for anything new.

### 28.4 THE CONSEQUENCE WE NEED TO BE EXPLICIT ABOUT: A NULL `area_id` IS NOW INVISIBLE

**Every report list in the application is scoped to one area.** The web app has a
header area picker; it used to decide only which LINES a page could offer, and it
is now a predicate on every list request — machine, line, SKU and area.

So the meaning of a NULL `area_id` changed without the column changing:

    before 0028   a row missing a label two screens happened to read
    after  0028   a row that appears on NO screen in the application

It is not merely excluded from that area's totals. It is excluded from every area,
so it is unreachable — and the screen shows an ordinary empty state, which reads as
"this area was idle", not as "the label has not landed".

**We are NOT asking for an `unattributed` count beside it**, and the contrast with
§21 is deliberate. `product_id` is OCCUPANCY OVER TIME: nothing can derive which SKU
was running during a stop, so a residual has to travel with every per-SKU payload.
`area_id` is CONTAINMENT: the area IS derivable from `work_unit_id`, permanently, so
a NULL is a missing LABEL and the fix is a backfill. Shipping a residual would invite
a reader to treat denormalisation lag as an attribution problem, and would make it
easier to leave un-backfilled.

**Q1 — is `area_id` sparse in production today?** If the answer is "it will stay
sparse", tell us: that turns this into §21's shape after all, and we will ship the
residual count and say so on the empty states. We would rather do that than have
supervisors read "no reports" as an answer.

### 28.5 `oee.work_center_quality_entries` IS THE ONE TABLE HERE YOU MUST NOT WRITE

It gains the same six columns and they are **ours to fill**, not yours. §18's rule
is unchanged: that table is written by the operator and only READ by you. A NULL
`area_id` there after our own backfill is our bug, not pipeline lag.

It is in this migration because TODOS §79 asked for exactly that column — the area
activity feed currently fans out one query per line for want of it — and §25.5 lists
it as optional. It is no longer optional; it is just not yours.

**One correction, so you are not told something that is not true yet.** Our write
path does not fill these columns today, and `0017`'s append-only trigger means a
backfill is impossible — it compares the whole row minus the four void columns, so
there is no subset an UPDATE could touch. Entries recorded before we fix that keep
a NULL `area_id` permanently. **Nothing about this asks anything of you**; it is
recorded here only because §28.3's table lists the table and you would otherwise
reasonably assume the column arrives populated.

### 28.6 What we would like back

1. **Q1 above** — is `area_id` sparse, and will it stay sparse?
2. Confirmation that **no model selects `factory_id` / `factory_name`**, so the
   rename in §28.1 costs you nothing.
3. A rough order for §28.3, if ours is wrong — in particular whether `site_*` and
   `enterprise_*` are cheap to resolve alongside `area_id` or a separate lookup.

## Open risks

- **An approval can orphan, silently, and nothing detects it.** Approval state is keyed on
  `(work_unit_id, date, shift)` rather than on `work_unit_shift_reports.id`, which is what makes
  it survive a pipeline restatement (§12). The residual case is the opposite one: if a report is
  ever **re-keyed** — a corrected shift calendar moving its `(date, shift)` — the approval no
  longer matches any row, the report reads `open` again, and there is **no test, no error and no
  user-visible signal**. There are no foreign keys anywhere in `oee` and there cannot be, so
  nothing can prevent it. A reconciliation query is in `0010`'s header and in §12; deliberately
  no cleanup job, because an orphaned row is evidence that somebody approved something.
- **The `work_unit_*` DAG has no repository.** It is being developed on one laptop. Until it is
  pushed to `molca-id` there is no review path, no history, and nobody else can redeploy it. This
  document is meanwhile the only durable spec of what Gold expects.
- **`oee.reject_count_wu_shift` is empty, and the Quality Loss tab is shipped against it.** The
  screen degrades honestly — it reports "not loaded yet" rather than a clean shift — but it shows a
  supervisor nothing until the model in §3.8 exists. This is the same trade `0007` made for the
  downtime detail columns, taken once more.
- **Nobody knows how far the ranked rejects and the `reject` tile will diverge.** The screen's
  footnote tells the reader they will not match, which is true by construction, but the magnitude is
  unmeasured. Test 2 in §3.8 exists to find out.
- **`oee.downtime_log_events` is empty, and the Others tab is shipped against it.** The screen
  degrades honestly — it reports "not loaded yet" rather than a shift nothing stopped — but it shows
  a supervisor nothing until the model in §3.9 exists. The same trade `0007` and `0008` made, taken a
  third time.
- **Two tabs on one page now count the same stops from two tables, and the divergence is
  unmeasured.** That is by design — one source is immutable, the other is operator-editable — but
  nobody knows the magnitude. Test 2 in §3.9 exists to find out, and it needs `source_event_id`
  (§3.3.2) to say anything better than a per-shift count comparison.
- **The event log carries no instant, so a shift assignment is auditable only through Silver.** If the
  shift calendar is ever corrected retroactively, those rows cannot be re-cut from this table alone;
  they must be reloaded from Silver by `event_id`. A nullable `occurred_at timestamptz` was
  deliberately left out of `0009` on §3.3's ground, and is cheap to add while the table is empty.
- **`0009`'s constraints have not been exercised.** The DDL is applied on dev and the read path is
  verified in a browser, but nothing has yet tried to INSERT a row it should reject —
  `ck_dtle_reasons`' function-backed predicate, `ck_dtle_reasons_1d`, `ON CONFLICT (event_id)` and the
  audit triggers are all still unproven in the direction that matters. §11 lists what the first run on
  a throwaway has to confirm.
- **§2.1**: `downtime_reports` cannot be upserted idempotently. This used to name two tables;
  `0006` closed the other half by dropping `work_unit_perf_analytics` in favour of
  `product_perf_wu_hour`, which has a natural key. **As of 2026-08-25 this also gates a shipped
  feature**: a stop without `source_event_id` cannot be edited at all, which is every stop the
  pipeline has loaded.
- **`0011`'s shape constraints can abort a pipeline load.** A blank or non-string label in `reason`
  or `actions` is now a failed statement rather than a mis-grouped Pareto bar (§14). That is the
  trade §3.9 already made for `downtime_log_events.reasons` and §3.3 asks for on this table, and it
  is deliberate — but it moves a rendering defect into the load path, and the DAG has no repository
  in which to review the model that would hit it (§18). The live table was surveyed clean before the
  constraint was added; a database whose contents differ has not been.
- **An operator's downtime edit is one un-joined model away from being silently discarded.** §13
  asks the pipeline to apply the override when it rebuilds `downtime_reports`; nothing in the
  database can enforce it, because no constraint can express "this column should hold what a
  different table's latest row says". The failure is a chart that quietly reverts to the machine's
  original values, with the operator's correction still sitting in the trail. The singular dbt test
  in §13 is the only mechanical guard, and it lives in a repository nobody in this repo can see
  (§18). **This is the highest-consequence unenforced instruction in this document.**
- **The freeze has a stated hole for long-open stops.** Editing a stop is refused if any shift
  report it overlaps has been approved — but an unfinished stop (`end_at IS NULL`) is treated as
  reaching only `MAX_OPEN_DOWNTIME_DAYS` forward, not forever, because the literal reading would
  make such a stop permanently uneditable. So an approval further out than that will not freeze it,
  and such an edit can still move a signed-off report's numbers. Deliberate, bounded, and recorded
  in `TODOS.md` rather than left to be discovered.
- **Nothing asks the pipeline to recompute one report after an edit.** Changing a stop's `category`
  moves time between schedule loss and availability loss, so the aggregates in
  `work_unit_shift_reports` are stale until the next scheduled run. The browser says so and does not
  pretend otherwise. A trigger is sketched in `downtime-edit-trd.md`, **not built and not agreed**.
- **The `0006` drop was not verifiable from here.** Because the DAG has no repository, nobody in
  this repo could grep for a `work_unit_perf_analytics` model. If one exists on your laptop, its
  next run breaks. This needed a yes/no from you **before** the migration was deployed — see §9.
- **`oee.work_unit_day_reports` and `oee.work_unit_month_reports` are empty, and the By Day / By
  Monthly screens are shipped against them.** The same trade `0007`, `0008` and `0009` each made,
  taken a fourth time. Both screens degrade honestly, but a supervisor sees nothing until the models
  in §15 exist. Neither table has a watermark row either, so `loadedThrough` is `null` and the
  screens cannot yet distinguish "no downtime" from "not loaded" the way the shift screen can.
- **The three `work_center_*` tables are empty, and the Line report screens are shipped against
  them.** The same trade `0007`, `0008`, `0009` and `0013` each made, taken a fifth time. The
  screens degrade honestly to an empty state, but a supervisor sees nothing until the models in §16
  exist. They have no watermark rows either, so they cannot yet tell "this line did not run" from
  "not loaded".
- **A line row written from some of its machines is indistinguishable from a complete one, unless
  the pipeline writes both counts.** §16.5 asks for `work_unit_count` and
  `expected_work_unit_count`; if the second is left NULL the screen falls back to a bare count and
  a partial line renders a plausible, slightly-lower OEE with nothing to flag it. The §16.8 test is
  the mechanical guard, and like §13's it lives in a repository nobody in this repo can see (§18).
- **The `availablity_loss_time` rename in `0013` is the one change that can break work already in
  progress.** It was safe on the evidence available here — the tables are empty and no model in this
  repo's view writes them — but that evidence stops at the edge of a DAG nobody here can read (§18).
  If such a model exists, its next run fails with "column does not exist". Loud, not silent, and
  reversible today; see §15.1.
