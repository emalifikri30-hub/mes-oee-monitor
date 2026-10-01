# Hand-off: what to change before populating `source_event_id`

**Audience:** whoever writes the `work_unit_*` Airflow DAGs and dbt models — currently
**Wira Hutomo** (`pwawiwa`, wira.hutomo@gmail.com).

**Status:** a **cover note**, not a specification. Everything here points at
[`gold-write-contract.md`](gold-write-contract.md), which stays normative; nothing in this file
overrides it. It exists because the contract is long and two of its sections became urgent at a
specific moment, and "read §13 before you do §3.3.2" is not a thing a document can say about itself.

**Scope:** the four operator-editable columns of `oee.downtime_reports`, and the ordering constraint
between the override join and populating `source_event_id`.

---

**TL;DR:** re-deriving four columns of `oee.downtime_reports` from Silver on every run silently
discards operator corrections. The fix is a `LEFT JOIN` documented in
[§13](gold-write-contract.md#13-editing-a-downtime--the-one-change-you-must-make-to-your-model). It
must land in the **same change** as populating `source_event_id`, not after. Separately,
[§14](gold-write-contract.md#14-what-0011-adds--a-shape-guard-that-can-fail-your-load) can abort your
load outright, which is a different and louder problem.

---

## 1. The problem in four lines

1. An operator corrects a stop: `category` UNPLANNED → PLANNED. Saved.
2. Your next run loads `downtime_reports` from Silver, which knows nothing about that correction.
3. §2.1 has you loading that table `DELETE`-then-`INSERT`, so the corrected row is deleted and the
   machine's original values are re-inserted.
4. The chart reverts. **Nothing errors.** The correction is gone, and the only trace is a row in
   `oee.downtime_report_history`.

This is your **next ordinary scheduled run** — not a retry, not a backfill.

**Switching to an upsert does not fix it.** Once `source_event_id` is populated and the model becomes
`ON CONFLICT (source_event_id) DO UPDATE`, `excluded.category` overwrites the operator's value just
as thoroughly. The load strategy was never the problem; **re-deriving those four columns from Silver
on every run is.**

## 2. What to change

`oee.downtime_report_history` becomes the source of truth for four columns — `category`, `reason`,
`detail_reason`, `actions`. Silver stays the source of truth for everything else on the row.

The full SQL is in **§13**. In outline: a `DISTINCT ON (source_event_id, field)` CTE for the latest
override per field, `LEFT JOIN`ed on `source_event_id`, with each of the four columns wrapped in
`CASE WHEN has_x`.

Three specifics worth reading twice, because each one type-checks while being wrong:

- **`CASE WHEN has_x`, never `COALESCE`.** An operator can deliberately CLEAR `detail_reason`, stored
  as a jsonb `null`. `COALESCE` would read that as "said nothing" and put the machine's text back.
- **`#>> '{}'` for the two scalars, never `::text`.** They are stored as jsonb strings, so `::text`
  yields `"PLANNED"` _with the quotes_, and the enum cast then fails pointing at the enum rather than
  at the quoting.
- **`array_agg(...)[1]`, not `max(...)`.** There is no `max(jsonb)` in Postgres. §13 carried the
  `max()` version briefly and it does not run — found by executing it rather than reading it.

Every statement in §13 has been executed against **Postgres 18** and is asserted in
`apps/api/src/module/downtime/downtime-repository.integration.test.ts`, including the round trip:
restate the row, re-apply the override, confirm it heals.

> **On the version:** these were originally verified against 16, because CI, `docker-compose.yml` and
> both integration-test headers pinned `postgres:16-alpine` while the deployed Gold database is
> **18.4** — a two-major gap that had gone unnoticed for months. Everything was re-run against 18 and
> passed unchanged, and the pins now match. Flagged in case anything on your side is also pinned to
> 16 on the same stale assumption.

## 3. Also read §14 — it can fail your load rather than corrupt it

`0011_oee_downtime_reason_shape.sql` added CHECK constraints on the shape of `reason`, `actions` and
`detail_reason`. **A row that violates one aborts the statement**, so a load carrying a malformed
value fails loudly instead of landing.

That is the _good_ failure mode and it needs no join to defend against — but it is a new way for your
DAG to go red, and the message will point at a constraint name rather than at the row. §14 lists what
each constraint requires and the shapes that trip it.

## 4. The ordering, which is the actual trap

`source_event_id` is what the edit endpoint addresses a stop by, so **populating it is what turns the
feature on.** That makes it the natural thing to do first — and populating it _without_ the override
join is the one sequence that loses data.

Please land these together:

1. The `latest` / `override` CTEs and the four `CASE WHEN` columns (§13).
2. The singular dbt test in §13, at `error` severity. It is the only mechanical guard that any of
   this happened — no constraint can express "this column should hold what a different table's latest
   row says".
3. `SELECT` on `oee.downtime_report_history` for the `oee_etl` role (§6). Without it the join fails
   outright, which is the good outcome.
4. Populating `source_event_id` itself (§3.3.2 / TODOS §19). Please write the same string into
   `downtime_log_events.event_id` — §2.1 asks for one identifier in both, which is what makes the two
   tables reconcilable.

**Precedence, so you do not have to infer it:** the operator wins, including over a later upstream
correction. Both values stay in the history table, so nothing is lost, and a genuine upstream
correction can be applied by editing the stop again.

## 5. What is NOT asked of you

- **Never write `oee.downtime_report_history`.** Read it in the projection; no insert, update or
  delete. Same as the two approval tables.
- **No `etl_watermarks` row for it** — `ck_etl_watermarks_table` will reject one, deliberately.
- **`downtime_log_events` is untouched by all of this**, and that is the point of it being a separate
  table: an operator correcting a stop does not change what was _observed_, so the Others tab
  deliberately does not move when the Availability Pareto does.
- **`oee.write_audit` is now partitioned by month** (`0012`) and pruned to twelve months. Nothing
  changes for you — the triggers still fire and you still insert nothing — but §5.1 is worth two
  minutes because a partitioned table _rejects_ an insert with no matching partition, and that would
  surface as your loads failing rather than as a gap in an audit log. There is a DEFAULT partition
  precisely so that cannot happen.
- **Nothing about recalculation, yet** — see below.

## 6. The four questions, and where they stand

Changing a stop's `category` moves time between schedule loss and availability loss, and those totals
are precomputed in `work_unit_shift_reports`. So a report's OEE / A / P / Q tiles, its timeline strip
and its waterfall are stale until your next run. Today the screen says so plainly and waits — nothing
is broken by the delay.

We sketched a way to ask you to recompute _one_ report sooner. It is written up in
[`downtime-edit-trd.md`](downtime-edit-trd.md) §4 and is explicitly **a proposal, not built, not
agreed** — please argue with it before anyone implements it.

**Three of the four now have a provisional answer from the OEE side. They are recorded here as
answers we are working from, NOT as decisions made for you** — questions 2 and 3 are about what your
model can actually do, and only you can settle them.

| Question                                                                   | Where it stands                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Is polling acceptable at all?**                                       | Provisionally yes, **every 5 minutes**. Please confirm a deferrable sensor or short-interval DAG is something you are willing to own.                                                                                                                                                                                                                              |
| **2. Can a recalculation be scoped to one `(work_unit_id, date, shift)`?** | Provisionally yes, with the DAG fanning out to the day and month aggregates. **This determines the request table's primary key**, so it is the answer we most need. Note there is no year-grain table in Gold, so year is out of scope.                                                                                                                            |
| **3. How long does that recomputation take?**                              | **Still open, and nobody on our side can answer it.** It sets the reaper's "this run is stuck" threshold and what the screen is allowed to promise. We are assuming ≤5 minutes and will set the threshold to 15; tell us if that is wrong by an order of magnitude.                                                                                                |
| **4. Would you rather consume a Kafka topic?**                             | Provisionally no — a table for now, revisited later. A broker exists on the Bronze/Silver side, and we defaulted to a table because the only consumer is Airflow, which already holds a direct Gold connection. But **polling is a DAG you would have to own and monitor**, and if that is the worse trade for you, say so and we will produce to a topic instead. |

One more we should have asked: **what should happen to the request table's own rows?** We are
planning to delete terminal (`succeeded` / `failed`) rows after 30 days. It is the same problem
`write_audit` had and it needs a scheduler, which brings us to the next section.

## 7. Two things we need from your side of the fence

Both are infrastructure rather than code, and both are blocking something already written:

1. **`pg_cron` is not installed** on the Gold cluster — nor is `pg_partman`, and `webadmin` is a
   superuser, so it is a genuine absence rather than a permissions problem. Two jobs want it: pruning
   `write_audit` (§5.1) and auto-closing shift reports older than 14 days. If Airflow is the better
   home for both, that is a perfectly good answer — it is a scheduler either way, and you already
   operate one.
2. **The roles in [§6](gold-write-contract.md#6-proposed-database-roles)**, including the amended
   `SELECT` on `oee.downtime_report_history`. Today every connection is `webadmin` with a blank
   `application_name`, and no table in the `oee` schema carries any grant at all.

## 8. Where things stand

The feature is merged and live. On the dev database **all 17 `downtime_reports` rows now carry a
`source_event_id`** and are editable, with 15 rows in `downtime_report_history` — so the write path
has been exercised end to end rather than merely shipped. What is still true is that **nothing the
pipeline has loaded carries one**, which is what §13 plus TODOS §19 turns on properly.

Happy to walk through §13 together if that is easier than reading it.
