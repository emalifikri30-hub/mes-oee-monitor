# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`CLAUDE.md` is a symlink to `AGENTS.md` — one file, both agents. Edit either; it is the same bytes.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Commands

```bash
pnpm install                        # or vp install
pnpm dev:all                        # web :3000, bff :3001, api :3002
pnpm dev:web | dev:bff | dev:api    # one app
pnpm run ready                      # vp check && vp run -r test && vp run -r build (pre-push gate)

vp check                            # format + lint + type-check, whole repo
vp run -r test                      # test every package
pnpm --filter <app> run check|test|build
pnpm --filter api db:migrate        # apply Gold migrations (needs GOLD_DATABASE_URL)
```

**One test file / one test name** — vitest positional filters pass straight through:

```bash
pnpm --filter web exec vp test format        # runs src/lib/format.test.ts
pnpm --filter api exec vp test work-unit-repository
pnpm --filter web exec vp test watch         # watch mode (vp test does NOT watch by default)
```

**Type-aware lint needs the workspace packages built first.** `packages/*/dist` is gitignored, and
`vp check` resolves `@molca/*` types from those built outputs. On a fresh checkout, or after
changing a package, run `pnpm --filter "<app>^..." run build` before `pnpm --filter <app> run check`
(this is exactly what `api` and `bff` CI does). `web` is the exception — it depends on no workspace
package, so `web^...` resolves to nothing and its CI check job has no prebuild step.

**`@molca/mes` is a private `git+ssh` dependency** (`molca-id/mes-shared`). `pnpm install` needs an
SSH agent with access; CI loads `MES_SHARED_DEPLOY_KEY`. It supplies auth: `createAuthMiddleware`,
`createKeycloakJwks`, `createServiceTokenProvider`, `bearerToken`/`cookieToken`, and the `AuthEnv`
Hono type. Auth is tested there, not here — handler tests stub `authMw` with a pass-through.

## Architecture

`web` (React SPA, nginx) → `bff` (Hono, OIDC + session cookie) → `api` (Hono, modular monolith) →
PostgreSQL, plus `mes-master-data` (separate repo/deployment) for work-unit and work-center records.
The browser never holds a token: it talks to the BFF same-origin, and `/api/proxy/*` swaps the
httpOnly cookie for a bearer token toward `api`. Root `README.md` has the full diagram; each app has
its own README (`apps/bff/README.md`, `apps/web/README.md`) with env vars.

### What the Gold schema is FOR — stated by its owner, 2026-09-02

Every table decision below has been argued locally. This is the statement of what
the whole is meant to become, and it is the tiebreaker for the next "should this be
its own table?" question. Full text in [`docs/gold-write-contract.md`](docs/gold-write-contract.md) §23.

- **DO NOT OVER-TABLE. Match the functional requirement and stop.** A direct
  counterweight to the "a line is MEASURED, not summed" pattern below, which
  answered that question with a new table four times (`0014`, `0016`, `0018`,
  `0019`) — correctly, but the pattern is not a licence. It is why `0020`
  attributed downtime to a SKU with **two columns** rather than a seventh report
  table, and why that shape should keep being preferred.
- **The intended surface is larger than what exists.** Reports for work unit,
  work center, **SKU, area and factory**, at shift / day / month — and **factory
  additionally needs YEAR**. Work unit, work center, SKU (day) and **area (day)**
  exist. Two things follow: `{shift, day, month}` has been assumed universal and
  **is not** — `REPORT_GRAINS` in `shared/shift-window.ts` admits no year, the DTOs
  derive from it, and **area is deliberately TWO grains** ("only have 2 type of
  report on the Area"), which makes it the first subject where that triple is broken
  by DECISION rather than by absence. Only **factory** has no table at all, and it is
  the one that needs the year grain. TODOS.md §74, contract §25 and §26.
- **Gold is meant to be read by people outside this application.** Third parties
  should be able to point their own BI tooling at these tables. That raises the
  bar on anything treated as an internal convenience: **column names and semantics
  are a public interface**, meaning has to live in `COMMENT ON COLUMN` because an
  external analyst has no source file to read, and §16.4a's two-unit rule —
  `total_out = good_out + reject + rework` being FALSE at the line grain — is the
  single most likely thing a stranger gets wrong.
- **Before production the owner will add migration and rollback documentation.**
  Until then, destructive changes on the empty development database are cheap and
  are the right time to make them (TODOS.md §71 is the first).

**One pipeline guarantee, learned the same day, that several comments in this repo
predate:** Flink forces a stop's `end_at` to the shift boundary, so **no downtime
crosses a shift or a day**. The straddle handling — `clipToWindow`, the two-shift
freeze in `listApprovalsOverlapping` — is therefore a **backstop, not the normal
case**. Keep it: the guarantee belongs to another team's stream processor and can
lapse without anyone here being told. But do not read those comments as evidence
that straddling stops are expected. Contract §21.7, TODOS.md §73.

### The medallion tiers, and who writes them

`api` injects two connections, `goldDb` and `silverDb`. **Schema owner and writer are different
roles** and confusing them is the main way to break things here:

| Tier   | Store                        | This service | DDL owner                                                | Bulk writer                                |
| ------ | ---------------------------- | ------------ | -------------------------------------------------------- | ------------------------------------------ |
| Bronze | TimescaleDB raw ingest       | not wired    | `vitual-factory` repo                                    | Telegraf                                   |
| Silver | TimescaleDB, HOT telemetry   | read-only    | nobody checked in yet                                    | Apache Flink                               |
| Gold   | Postgres `oee`, COLD reports | read-write   | **this repo**, `apps/api/src/shared/database/migration/` | **Apache Airflow → dbt**, direct to the DB |

- This service writes Gold only for **named operator mutations** — approve a shift report, reopen
  one, edit a downtime. All three are shipped; it never bulk-inserts. The contract with the
  pipeline is normative and lives in [`docs/gold-write-contract.md`](docs/gold-write-contract.md)
  — if a screen needs a new column, that doc plus a migration is where the request goes.
- **An operator edit is one un-joined dbt model away from being silently discarded**, and that is the
  most consequential thing in the boundary. `downtime_reports` is loaded `DELETE`-then-`INSERT`, so
  rebuilding its four operator-mutable columns from Silver reverts the edit with nothing in any log.
  §13 of the contract is the required override join; [`docs/downtime-edit-trd.md`](docs/downtime-edit-trd.md)
  is the narrative version, and its §4 sketches an unbuilt recalculation trigger (TODOS.md §38).
  [`docs/downtime-edit-handoff.md`](docs/downtime-edit-handoff.md) is the cover note that says which
  two sections to read first and in which order — it overrides nothing.
- Approving a report **freezes its downtime** — the edit endpoint refuses a stop on a closed report,
  and a stop straddling 23:00 is frozen by BOTH shifts it touches. That attribution rule is
  `scopeAndWindow`'s, and the write path follows it deliberately: reading only the stop's own
  `(work_unit_id, date, shift)` would let an edit move a signed-off report's numbers silently.
- Silver connections open with `default_transaction_read_only`, so a stray write fails loudly.
  `SILVER_DATABASE_URL` currently points at the Gold database as a placeholder.
- Schema changes are a **new numbered `.sql`** in `migration/` using plain `ALTER TABLE`.
  `0003_oee_gold_schema.sql` is deliberately all-idempotent (`IF NOT EXISTS`) because it is applied
  against an already-populated database — which means it does _not_ reconcile drift. Do not extend
  it; add a file. One intentional wart must not be "cleaned up": the physical column order of
  `downtime_reports`. The misspelled `availablity_loss_time` on the day/month tables **was**
  the second, and `0013` corrected it — safe only because those tables were still empty and no
  dbt model wrote them, which was the whole reason the rule existed.
- **The LINE grain is three more Gold tables**, `oee.work_center_{shift,day,month}_reports`, added by
  `0014` and written by the same pipeline. **A line is MEASURED, not summed**: it has its own count
  points, so `line <> sum(machines)` is not a defect and its durations are the line's own wall clock
  — 8 hours over a 4-machine shift, not 32. (An earlier reading of `0014` called them
  "machine-milliseconds"; `4fccce8` corrected it after the pipeline owner confirmed it is not a
  roll-up. The dev seed still derives that way and says loudly that it is a stand-in.) Two more
  choices are deliberate departures: they key on `business_date` and have **no `date timestamptz`
  column at all**, and `month` survives as a nullable label **out of the key**.
- **A line has TWO units and they are usually different** — bags in, cartons out. `total_out`,
  `reject`, `rework` and `line_out` are in the **infeed** unit; `good_out` and `effective_out` in the
  **output** one (`0014`, contract §16.4a). So **`total_out = good_out + reject + rework` is FALSE at
  this grain**, by construction, and nothing may compute across the two sides. Either unit may be
  NULL, meaning "the members disagreed", and its counts are nulled WITH it — one `CHECK` per side, so
  a line can be certain what it consumed and abstain about what it shipped. `0015` adds `line_out`,
  the line's own measured production on the infeed side, and joins it to that `CHECK`.
  [`docs/gold-write-contract.md`](docs/gold-write-contract.md) §16 is the contract, and
  `apps/api/scripts/seed/0015_work_center_reports_dev.sql` is its executable form.
- **The line's REJECTS are a fourth table, `oee.reject_count_wc_shift`** (`0019`), and the reason is
  the same one a third time. The Quality Loss Pareto on the Line screen used to read
  `reject_count_wu_shift` scoped by `work_center_id` — a machine-sum — while the Losses card's
  Reject tile two cards above it reads the line's own count point. **Two right answers to one
  question, on one screen.** One table widened over a range serves all three grains, as the machine
  side does. **The Others tab is NOT the same case and must not be "fixed" to match**: a reject is a
  COUNT AT A COUNT POINT, so the line has its own; a stop is an EVENT IN TIME, and a stop on a
  machine genuinely is a stop on the line — which is why downtime is scoped by query param at any
  level. Contract §20.
- **SKU is a THIRD kind of axis, and it is the one exception to the rule above** (`0020`,
  contract §21). The hierarchy axis is CONTAINMENT — a work unit is inside a work center,
  permanently, so an event on the child is an event on the parent, and a query param suffices. SKU
  is OCCUPANCY OVER TIME: a line runs A, then B, and a stop while A was running is not a stop on B.
  No scope parameter can derive that, because the fact is not in the row — so `product_id` /
  `product_name` are **columns** on both `oee.downtime_reports` and `oee.downtime_log_events`, and
  a SKU read is a scope PLUS a product predicate, never a fifth member of `SCOPE_COLUMN`. Two
  things about them are load-bearing. `source_event_id` is UNIQUE, so **a stop straddling a
  changeover is attributed to one SKU or to none, and is NEVER split into two rows** — two rows
  would collide on that key. And **NULL means "not attributed", never "no product"**: a read
  filtering `product_id = X` silently excludes those rows, so per-SKU downtime does not sum to the
  line's and the residual is invisible on a per-SKU screen. Both columns are NULL on every row
  today; nothing writes them yet (TODOS.md §65). **Every per-SKU downtime read therefore ships an
  `unattributed` count beside it** — `/downtime-events`, the activity feed, and the browser's
  timeline and Downtime Details empty states — because without one "this SKU never stopped" and
  "nothing is attributed yet" are the same empty screen, and only the second is true.
- **AN AREA IS COMPOSED, WHERE A LINE IS MEASURED — and `0024` inverts two of
  `0014`'s rules rather than repeating them.** `oee.area_day_reports` and
  `oee.area_month_reports` are the two area grains (contract §25, §26). A line has its own count points and its own clock; an
  area has neither, so every figure is a composition of its member lines' and two
  things follow that hold nowhere else in this schema. **Its durations are
  LINE-milliseconds**: a five-line area's `runtime` on one business day is ~120
  hours, not ~24, because an area that lost 3 h on line A and 2 h on line B has lost
  5 h — the Run Time tile carries a tooltip saying so, and nothing may divide by the
  line count to make it look like a wall clock. **And its counts are a MASS, in ONE
  unit, precisely because its members have many**: the lines disagree about both the
  infeed and the output side, so `0014`'s two-triple shape would leave every count
  NULL, and weight (through `product_packaging.std_weight`) is the only unit that
  survives composition. So `total_out = good_out + reject + rework` is at least
  unit-consistent here and is STILL not asserted — five count points on N lines, and
  mass is not conserved through a packing line. A NULL unit is a THIRD meaning
  again: not "the members disagreed" (`0014`) and not "not known" (`0023`), but
  "could not be brought to a common mass". The per-unit view the requirement ALSO
  asks for is a read-time aggregate over `oee.work_center_day_reports` grouped by
  unit — exact addition within a unit, so §23.1 applies and it gets no table. Area
  is also the first subject whose downtime reads are a plain scope: **`SCOPE_COLUMN`
  now maps `area_id`**, a column `0007` added in August and whose own `COMMENT`
  recorded that it was "NOT yet accepted", so the timeline, the Downtime Details
  table and all three downtime Paretos serve it with no new arithmetic.
- **THE AREA's MONTH IS A SECOND TABLE, NOT THE DAY TABLE WIDENED** (`0025`,
  contract §26), and the reason is the one line that separates a report table from a
  count table. §15.5: durations and counts SUM, **rates are RECOMPUTED**. Widening a
  day range gives the first for free and the second not at all — so a reader that
  derived a month's OEE would hold a second definition of it, one click from the day
  screens it drills into. That is why `0016` could serve a month by widening its day
  table and this cannot, and why the per-unit Input/Output read still DOES widen
  `oee.work_center_day_reports`: it sums counts, and a count sums. The two area
  tables differ by exactly ONE CONSTRAINT — `ck_amr_month_start`, which makes
  `business_date` the FIRST day of the month (§15.3) — and by no column, which is
  what lets one payload type, one projection and one card set serve both. At month
  grain the durations are line-milliseconds times a month: a five-line area reads
  **~3,600 hours**, and the Run Time tooltip says so in different words from the day
  screen's because the magnitude is ~30x larger.
- **Operator-entered reject and rework live in `oee.work_center_quality_entries`** (`0017`), a
  table this service WRITES and the pipeline only READS — contract §18. Three things about it are
  load-bearing. It is **append-only with a void**, enforced by a trigger rather than convention, so
  a correction reads "500, then that was wrong, then 50". Its `target_qty` is **GENERATED**, because
  the conversion must be the database's and not a reader's. And it is deliberately **absent from
  `ck_etl_watermarks_table`**, so a dbt model of that name fails loudly on its post-hook.
  **An entry moves `reject` and `rework` and NO RATE** — the rates are time-derived (§16.10a(b)) —
  which is correct and is the first thing that will be reported as a bug.
- **`oee.product_perf_wc_hour`** (`0018`) is the line's hourly production per SKU, and it is **NOT a
  roll-up of `product_perf_wu_hour`** even though that table carries `work_center_id`. TODOS §61
  said to roll it up; that was wrong for the reason `0014` exists — a machine-summed curve would not
  integrate to the line's own totals in the card above the chart. Its `ideal_rate_per_hour` is on
  the **OUTPUT** side, so performance is `effective_out / ideal_out` and the ratio is
  unit-consistent; an infeed-side standard would divide cartons by bags and produce a number between
  0 and 1 that looks exactly like a percentage. Contract §19 asks the pipeline owner to confirm that.
- **The line's per-SKU counts are TWO MORE TABLES, not a roll-up** — `oee.product_count_wc_{shift,day}`,
  added by `0016`, requested in contract §17. The reason is the same "measured, not summed" fact one
  step further on: SKU View sits directly below the overview card, so a rolled-up SKU View would print
  per-SKU figures that **visibly disagree with the card above them on the same screen, and the
  disagreement would be correct** — unexplainable to a supervisor. Two tables rather than three
  because a day table serves month by widening, which `listPeriodProductCount` already proves for the
  machine pair. **They ship EMPTY and get NO dev seed on purpose**: the only available derivation is
  the roll-up, so a seed would teach the invariant the table exists to deny. `sku-view-card.tsx`'s
  loaded/stale ladder says which kind of empty it is showing. §17.6 also asks the pipeline owner not
  to let the future reject/rework entry feature write these rows — they are `DELETE`-then-`INSERT`
  loaded, so an operator entry there is reverted with nothing in any log (TODOS §59).
- `work_unit_shift_reports.date` is a `timestamptz` holding the instant the shift **started**, not a
  business day at midnight. A calendar day can only be derived through the plant's time zone
  (resolved via `TimeZoneResolver` from master data). Getting this wrong produced a real shift-3 bug.

### Operator mutations — who, whether, and where it is recorded

The seven writes — approve a machine shift report, reopen one, edit a downtime, **approve or reopen
a LINE shift report**, and **record or void a reject/rework entry** — share one path, and each piece
of it is load-bearing. Still SEVEN across FOUR report subjects, and that is the point of the count.
The SKU day report offers the same record-and-void, and it is the SAME TWO WRITES against the same
table. The **AREA day report offers none of them**: no approval (there is no key at that grain and
no cascade defined — approving an area would close every machine shift report in it, which is not a
permission any of the six role variables grants) and no quality entry (an entry is keyed by LINE, so
an area-level Add would have to make the operator pick one — the requirement says "no add
reject/rework"). `oee.product_report_wc_day` and `oee.area_day_reports` take no operator mutation at
all, which is what `0023`'s and `0024`'s `write_audit` triggers assert and what both modules' "A
READER AND NO WRITER" comments record. **A downtime edit reaches an area screen anyway** — a stop is
scoped, not owned — and it needed one change: the Reason catalogue is scoped by LINE and an area
report has no single line, so `DowntimeListItem` now carries `workCenterId` and the area screens
read it per ROW.

- **Who** comes off the verified token through `requireActor` in `shared/actor.ts`. `sub` is what
  lands in `closed_by` / `changed_by`; the guard there is the one place in the codebase an
  `undefined` could reach a `NOT NULL text` column and write the string `"undefined"` as an
  operator's identity — into an audit trail, where a wrong answer is worse than no answer. **Realm
  roles only** (`realm_access.roles`), never `resource_access`.
- **Whether** is gated by six _optional_ role names — `APPROVE_ROLE`, `REOPEN_ROLE`,
  `EDIT_DOWNTIME_ROLE`, `APPROVE_LINE_ROLE`, `REOPEN_LINE_ROLE`, `ENTER_QUALITY_ROLE`
  (`shared/config/config.ts`).
  Undefined means "do not check", which is the default and the currently shipped state: the
  mechanism is in, the roles are not set (TODOS.md §34). One var per mutation rather than one for
  all is a deliberate policy decision pushed out of the code — collapsing them would assert that
  whoever may approve a report may also undo someone else's sign-off, and the two LINE vars are a
  third and fourth authority again: approving a line closes **every machine shift report on it** in
  one click, which is not the permission "approve the shift you worked" grants. `AUTH_AUDIENCE` and `AUTH_ALLOWED_AZP` are opt-in the same way, and for a sharper
  reason: a role name Keycloak does not emit 403s every operator, where a wrong audience only 401s
  them (TODOS.md §2).
- **Where it is recorded**: every mutating transaction calls `asOperator(tx)`, which stamps
  `application_name = 'mes-oee-monitor-operator'` for the `oee.write_audit` trigger. It uses
  `set_config(..., is_local => true)` rather than `SET LOCAL` (which takes no bind parameters), and
  the reversion at COMMIT is load-bearing — postgres.js pools connections, so a leaked name would
  label a later pure read as an operator write. Note `write_audit` is **not** the durable record:
  it is `current_user` plus a self-reported application name, and `0012` partitions it monthly with
  12-month retention. The durable trails are `oee.work_unit_shift_report_approval_events` and
  `oee.downtime_report_history`, both append-only and both carrying strictly more.

### ONE ONTOLOGY, AND EVERY REPORT LIST IS AREA-SCOPED — `0028`, contract §28

The newest cross-cutting rule, and it inverts one this repo taught for two months.

- **Gold speaks `mes-master-data`'s hierarchy, exactly: enterprise → site → area →
  work center → work unit.** `0028` put the full chain ABOVE its own grain on
  twenty-three tables — every report table, and every fact table a report screen
  reads. Each level is `<level>_id integer` + `<level>_name varchar(255)`,
  nullable, out of every key. The five audit trails
  (`…_approval_events`, `downtime_report_history`, `write_audit`,
  `etl_watermarks`) deliberately got none: they are addressed by natural key and
  never scanned by area, so a denormalised label there is a second place for the
  hierarchy to drift with no read that would notice.
- **THERE IS NO `factory`, AND THERE NEVER WAS.** `0006`, `0018`, `0024`, `0025`
  and `0027` each wrote `factory_id` / `factory_name` for "the level above the
  area". Master data calls that level a SITE. `0028` renamed all five, which was
  safe for one expiring reason — every such column was NULL on every row, nothing
  upstream resolved it — and is the same licence `0013` used for
  `availablity_loss_time`. Column names are a PUBLIC INTERFACE (§23.3): a column
  named for a level the master data does not have is one an outside analyst cannot
  join on, and two names for one level is how a stranger groups by both and halves
  every figure. `DowntimeScope` has not caught up (TODOS.md §85).
- **THE HEADER AREA PICKER IS A REQUEST FILTER NOW, ON ALL FOUR SUBJECTS.** It used
  to decide only which LINES a page could OFFER — `apps/web/src/hooks/use-work-center-filter.ts`
  said "it never filters a request on its own" and the AREA lists were the sole
  exception. Every report list sends `areaId` on every request, and
  `shared/area-scope.ts` is the one statement of the predicate. **The two meanings
  are not the same and must not be conflated**: on an area list `area_id` is the
  grain KEY and picks WHICH REPORT; everywhere else it is a denormalised LABEL and
  picks which slice of one.
- **A NULL `area_id` therefore appears on NO SCREEN AT ALL** — not under its own
  area, not under any other, and there is no unfiltered list left. It renders as an
  ordinary empty state, which reads as "this area was idle". That is accepted
  rather than counted, and the reason is the one `0020` drew: area is CONTAINMENT
  (derivable from `work_unit_id`, permanently, so a NULL is a missing LABEL and the
  fix is a BACKFILL), where `product_id` is OCCUPANCY OVER TIME (underivable, so
  every per-SKU read ships an `unattributed` count). **If the pipeline ever answers
  that `area_id` will stay sparse, that inverts** and this becomes the SKU shape on
  far more screens — TODOS.md §78, contract §28.4 Q1. Do not add half of it.
- **`apps/api/scripts/seed/0028_ontology_backfill_dev.sql` is what keeps development
  honest, and it must be run.** Without it every machine, line and SKU list is
  correctly and completely EMPTY. It derives the chain inside Gold —
  `work_unit_id` → `work_center_id` (NOT NULL since `0003`) → `area_id` (from
  `oee.downtime_reports`, as `0024`'s seed does) — refuses an ambiguous mapping
  rather than picking one, and **fills neither `site_*` nor `enterprise_*`**: no
  source in Gold carries either, and inventing an identity is the failure `0020`'s
  header defends against at length.
- **`oee.work_center_quality_entries` is the one table in that migration THIS
  SERVICE writes**, so its new columns are ours to fill and a NULL there is our bug
  rather than pipeline lag (contract §28.5). It closed TODOS.md §79's column half.

### `area` — the fourth subject → contract §25 and `apps/api/src/module/area-report/`

Two more pointers before the per-app files, because both are new axes rather than
more of the same:

- **`SCOPE_COLUMN` maps three scopes now, not two.** `factory` is the only one left
  refused. Adding `area` is what lets
  the Area screens reuse the timeline strip, the Downtime Details table and all
  three downtime Paretos unchanged, and TODOS.md §25's cost objection was already
  answered by the LIMIT / "Other" tail / server-side ranking the line grain shipped.
  **The stated reason for refusing the fourth is now WRONG and the code has not
  caught up.** It was "`oee.downtime_reports` has no `factory_id`"; `0028` gave that
  table `site_id`, which is the same level under the name master data uses. So the
  refusal survives as a scope named for a level that exists in neither the schema
  nor the ontology — TODOS.md §85 is the mechanical follow-through, §74's second
  half is closed.
- **`shared/report-window.ts` split `DateRange` out of `ReportWindow`.** The
  half-open `>= from AND < to` rule now serves four subjects through one function;
  `scopedRows` still hardcodes `j.work_center_id` and serves the three that are
  line-scoped. Widening it into a scope-column parameter was the obvious move and
  the wrong one — that is a query builder, not a statement of one predicate.

### OEE Performance — a SECOND SURFACE over the same tables, and its vocabulary

Contract §23.2 asks for an **OEE Performance dashboard** beside the report screens,
for work unit, work center, area and factory. **Machine × month shipped first**
(`/oee-performance/machine/monthly`); the rest is TODOS.md §81, and the line and
area trend endpoints already ship with no consumer.

**Three of its six headline figures are NOT columns, and the mapping is the single
thing to get right here — because getting it wrong produces a plausible percentage
rather than an error:**

```
Calendar Time  ==  availability_time      TEEP's denominator
Loading Time   ==  production_time        OEE's denominator
Utility        ==  Loading / Calendar     no column anywhere

availability_time == schedule_loss + availability_loss + performance_loss
                   + quality_loss  + value_added_time
teep == value_added_time / availability_time
oee  == value_added_time / production_time
TEEP == Utility x OEE
```

Verified to the millisecond against real Gold rows. `availability_time` is a badly
named column for what it holds and the name is a **public interface** (§23.3), so
it is not ours to change — `lib/waterfall.ts` already labels it "Calendar Time" and
the dashboard reuses that vocabulary rather than inventing a second. The identity
is asserted in **two** places deliberately: over a fixture in
`apps/web/src/lib/oee-dashboard/oee-performance.test.ts`, and against real rows in
`work-unit-period-repository.integration.test.ts`, where it would catch a pipeline
model breaking it. **An area has no `teep` and can have no Utility either** — both
divide by a calendar an area does not own (`0024`), which is why the dashboard's
KPI row is a per-subject tile LIST and never a fixed six.

**The dashboard's second half is CHARTS OVER READS THAT ALREADY EXISTED**, and
that is the ratio to preserve: two donuts, three Paretos and a four-series trend
cost exactly ONE new endpoint between them. The donuts are arithmetic over the
report row; Schedule Loss and Quality Losses reuse the `PLANNED` breakdown and the
reject breakdown the Six Big Losses card already fetches, so two cards on one
screen cannot disagree; and the trend gained its three extra series as three more
columns in one projection. **Only Pareto Actions needed a query** — `actions` is a
jsonb array nothing aggregated — and its one decision is stated in
`primaryAction`: only a stop's FIRST action is counted, because crediting each of
several the whole stop makes the bars sum to more than the downtime and a Pareto's
cumulative line is a SHARE. The card says so in a footnote rather than leaving the
reader to discover it.

**`shared/oee-trend.ts` is the one read the dashboard needed that nothing answered.**
Nothing in Gold returned a per-day OEE series: the day LIST endpoints filter by
line, never by machine, and their 100-row cap truncates silently at four machines
× thirty-one days. It is shared on arrival rather than after a second caller
because three subjects have BOTH a month and a day table, so there were three
callers on day one. **Its tables are Fragments and its scope column is a string**,
and that split is not stylistic: `db(name)` escapes a dotted table name as ONE
identifier, naming a table called `oee.work_unit_day_reports` in the search path —
the trap `grainFrom` records in all three repositories.

### `api` — module layout → [`apps/api/AGENTS.md`](apps/api/AGENTS.md)

The module-slice file convention, the Awilix wiring, the full endpoint inventory and — more
importantly — the reasons the coarse grains deliberately have no `approve`/`reopen`, why the
LINE approve is a cascade, and what the two coarse grains do NOT accept. Loads when working
under `apps/api/`.

### `web` — SPA conventions → [`apps/web/AGENTS.md`](apps/web/AGENTS.md)

Router and data-flow conventions, the shared-component rule (components take DATA, never a
`subject` flag), the seven-sequences hazard, `businessDate` vs `formatReportDate`, and the
mutation conventions. Loads when working under `apps/web/`.

## CI and observability

Per-app workflows in `.github/workflows/` (`api.yaml`, `bff.yaml`, `web.yaml`), path-filtered to
that app, each `install-deps → {check, test, build} → release-image`. Every job needs the
`MES_SHARED_DEPLOY_KEY` secret to fetch `@molca/mes`, image builds included (BuildKit
`--mount=type=ssh` forwards the job's agent). `release-image` runs only on push to `main`.

- `api`'s test job starts a **`postgres:18-alpine`** service and sets `GOLD_TEST_DATABASE_URL`, so
  the integration suite always runs there. 18 tracks **the deployed Gold major**, not the
  `postgres` service in `docker-compose.yml` (still 16) — nothing enforces that alignment yet
  (TODOS.md §43).
- The schema under test is applied by the real `scripts/migrate.mjs` against the checked-in DDL, so
  the tests cannot drift onto a fixture.
- `web`'s **build** job asserts `routeTree.gen.ts` freshness with `git diff --exit-code`; `tsc -b`
  alone would not catch a stale tree.

`apps/api/src/shared/observability/metrics.ts` annotates every instrument with the PromQL that
should page somebody, and those annotations are now real rules in `prometheus-alerts.yml` with a
provisioned dashboard at `grafana/dashboards/oee-service.json`. **Keep the three in step** — and
note a histogram exports as `_bucket`/`_count`/`_sum` while a counter keeps its name exactly.
Grafana is deliberately not editable in the UI (a clicked-together dashboard is lost on restart and
is not reviewable); change the JSON. `docker compose up` brings up the whole chain — Jaeger
:16686, Prometheus :9090, Grafana :3005 (not 3000, which `web` owns in dev). Nothing routes a
firing alert anywhere yet (TODOS.md §42).

## Testing conventions

- **`api` unit tests** use a hand-rolled `fakeSql` (defined per repository test file) that routes
  normalised SQL text to canned rows and records bound params. Outbound HTTP is stubbed with
  `msw/node`.
- **`api` integration tests** (`*.integration.test.ts`) run against a real Postgres and are
  **skipped unless `GOLD_TEST_DATABASE_URL` is set**, so `vp test` stays green without Docker. CI
  always runs them, applying the checked-in DDL with the real `scripts/migrate.mjs`. They exist
  because the failures they catch are _arithmetic_ — a wrong unit conversion, a NULL sum turned into
  0, LEAST/GREATEST swapped — which render a plausible chart instead of throwing. Each file's header
  documents the exact `docker run` + migrate commands.
- **`web`** runs `happy-dom`. Pure arithmetic and time-zone logic belongs in `src/lib/*.ts` with a
  colocated test; component tests exist for the one thing a pure function cannot reach — _which
  state a card selects_ (pending / error / empty / populated, plus the trap that a query gated by
  `enabled: false` reports `status: "pending"` forever). Render through `src/test/render.tsx`, which
  supplies a fresh QueryClient (`retry: false`, `staleTime: Infinity`), router stubs and providers;
  seed the cache with a `queryKey` that matches `lib/queries.ts` exactly.

## Conventions

- Conventional commits with an app scope: `feat(web):`, `feat(api):`, `fix(web):`, `docs:`, `test(web):`.
- **`TODOS.md` is the durable backlog** and part of the workflow, not a scratch file: entries carry
  enough context to pick up cold, are numbered (`§24`), and commits close them explicitly. Deferred
  work belongs there rather than being done in passing.
- Comments in this codebase explain _why_, often at length, and frequently point at the failure that
  motivated the code. Match that register; when you change code with a nearby explanation or ASCII
  diagram, update it in the same change — a stale one actively misleads.
- The pre-commit hook runs `vp staged` → `vp check --fix` from the **root** config, which is why
  `routeTree.gen.ts` is ignored in both the root and `apps/web` vite configs.
- Package versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: prefer`); add new deps
  as `catalog:` entries. `@tanstack/react-router` and `@tanstack/router-plugin` must be bumped
  together.
