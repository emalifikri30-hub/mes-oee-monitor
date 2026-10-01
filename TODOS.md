# TODOs

Deferred work with enough context to pick up cold. Delete an entry when it ships.

---

## 1. Establish ownership of the `work_unit_shift_reports` schema — **DONE (2026-08-13)**

**Shipped:** `apps/api/src/shared/database/migration/0003_oee_gold_schema.sql` — the complete
`oee` schema, not just `work_unit_shift_reports`. This repo now owns Gold's DDL, which is what
the medallion table in `README.md` already claimed.

All seven tables, the `oee.operation_type` enum, all five sequences and all twelve secondary
indexes are checked in:

| table                      | read by this service                                 |
| -------------------------- | ---------------------------------------------------- |
| `work_unit_shift_reports`  | yes — `WorkUnitReportReaderRepository`               |
| `product_count_wu_shift`   | yes — the SKU View card (also closes §12's DDL half) |
| `downtime_reports`         | yes — `DowntimeReaderRepository`                     |
| `work_unit_day_reports`    | no — captured so the schema is one unit              |
| `work_unit_month_reports`  | no — same                                            |
| `work_unit_perf_analytics` | no — **dropped by `0006`**, see §19 and §22          |
| `product_count_wu_day`     | no — same                                            |

**How it was produced, and why that matters.** The DDL was read out of `pg_catalog` on the live
Gold database rather than reconstructed from the application code. Reconstructing from code is
exactly how the shift-3 bug happened (§17): every comment in the repo said
`work_unit_shift_reports.date` was a Postgres `date` when the catalogue knew it was a
`timestamptz`. One artefact of that approach is preserved deliberately and must not be
"cleaned up" — the physical column order on `downtime_reports`. The misspelled
`availablity_loss_time` on the day and month tables was the other, and §47 records why `0013`
corrected it instead: those two tables were still empty and unwritten, which was the only
reason preserving it was ever the right call.

**Verified, not assumed.** The migration was applied to a throwaway Postgres 18 via the real
`scripts/migrate.mjs`, and a `pg_catalog` fingerprint — columns, types, precision, nullability,
defaults, constraint definitions, index definitions, enum labels, sequence parameters and
ownership — was compared against the live database. All 13 objects hash identically. The only
catalogue difference is a gap in `downtime_reports.attnum` where a column was dropped upstream
years ago, which is drop history rather than schema and cannot be reproduced. Seeded rows then
served every query the two repositories issue, including the shift-3 `AT TIME ZONE` join and
the `factor_to_base` scaling.

**Every statement is idempotent**, which is load-bearing: `GOLD_DATABASE_URL` points at a
database where all of this already exists and holds rows, and `schema_migrations` does not exist
there yet — so the first real `db:migrate` run applies this file against a populated schema and
must be a no-op. The trade-off is stated in the file header: `CREATE TABLE IF NOT EXISTS` does
not reconcile a table that has DRIFTED, it silently does nothing. **Future changes to these
tables belong in a new numbered migration using plain `ALTER TABLE`, which does fail loudly.**

**The writer is identified too, so §1 closes fully.** Gold's bulk writer is **Apache Airflow →
dbt**, aggregating Silver directly into this database — not through this API. Silver is written
by **Apache Flink**, Bronze by **Telegraf**. This repo also writes Gold, but only for named
operator mutations: approving a shift report (open → closed) and editing a downtime's category,
reasons or actions. **Wira Hutomo** (`pwawiwa`) owns the DAG. The whole contract is written down
in [`docs/gold-write-contract.md`](docs/gold-write-contract.md), which is the addressee every
item below used to lack.

Two facts about that pipeline matter more than the ownership answer itself:

- **It does not exist yet for the `work_unit_*` vocabulary.** `work_unit_shift_reports` has taken
  8 inserts in its lifetime (`stats_reset` is NULL, so counts are cumulative) and holds hand-made
  demo rows — `SKU A`/`SKU B`, `Custom_Reason_1`, five identical SMALL_STOPs 10 minutes apart.
  `molca-id/poc-flink-v2` implements the same pipeline for the older `line`/`machine` vocabulary
  against a different database, so the gap is naming and target, not capability. Everything §9,
  §10, §13 and §17 want is therefore a **specification line in a model that has not been written**
  rather than a migration plus a backfill against a live table — far cheaper now than later.
- **The DAG has no repository.** It is being developed on one laptop, so until it is pushed the
  contract doc is the only durable spec, and nobody else can review or redeploy it. Filed as §18.

**Unblocks:** integration tests against a real database — §11's `getWindow` assertion now has a
schema to run against, and `listOverlapping` coverage is no longer blocked. Migrations `0004`
(write attribution) and `0005` (load watermarks) build on this file and unblock §8 and §14.

---

## 2. Keycloak realm config for `audience` + `azp` enforcement

**What:** Create the `mes-oee-monitor-svc` confidential client with service accounts enabled, add
an audience protocol-mapper that emits `mes-master-data` in `aud`, then set `AUTH_AUDIENCE` and
`AUTH_ALLOWED_AZP` in `mes-master-data` (and, for its own inbound traffic, in this service).

**Why:** The code ships **env-gated off**, so it is inert until this is done. Today
`mes-master-data` accepts any token signed by the `molca` realm — signature, issuer and expiry
only, no audience and no client check. The security benefit of the service-token work is
unrealised until the flags flip.

**Context:** Both checks are implemented in `@molca/mes` (`src/jwt.ts`, `AuthMiddlewareOptions`)
and wired through `apps/api/src/shared/infra-module.ts` in both repos; see
`apps/api/.env.example` for the variables. Ordering is not optional:

1. Create the client and the audience mapper in Keycloak.
2. Verify a real token actually carries `aud: ["mes-master-data"]`.
3. Only then set the env vars.

Keycloak emits `aud: ["account"]` by default, so enabling `AUTH_AUDIENCE` against an unconfigured
realm 401s **every** caller including the browser/BFF flow. `AUTH_ALLOWED_AZP` must list the BFF
client _and_ the service client — omitting either locks that one out. Rollback in both cases is
unsetting the variable and restarting.

Also fix `apps/api/.env`, which currently sets `OIDC_CLIENT_ID="mes-master-data"`: this service is
borrowing the callee's client identity, and the outbound `client_credentials` grant needs its own.

**Depends on / blocked by:** Keycloak admin access to realm `molca` at
`https://identity.mes.molca.id`.

---

## 3. A bulk `getMany`-by-ids convention for `mes-master-data` resources

**What:** Extend the `?ids=` list filter added for work-units to the other master-data resources
(work-centers, equipment, products), and write it down as the cross-service read convention.

**Why:** Every `mes-master-data` module has a `getMany(ids)` in its `*-client.ts` that exists only
**in-process** and is never exposed over HTTP. This repo hit that wall implementing the work-unit
report; the next service integration will hit it too, and the obvious workaround — N+1
`GET /:id` calls — turns one page render into up to 100 upstream round-trips.

**Context:** The pattern established for work-units, in
`mes-master-data/apps/api/src/module/work-unit/`:

- `?ids=` as a comma-separated list, parsed in `work-unit-dto.ts` (`idsSchema`).
- Capped at `MAX_PAGE_SIZE` (100) so a caller always gets every requested id in one page.
- Deduplicated before the cap; blank/separator-only input means "no filter", never an empty
  `IN ()`.
- Composable with existing filters, applied in **both** the relational query and the count query
  in `work-unit-repository.ts` — they express the same filter in two dialects and will silently
  disagree if only one is updated.
- Response is the normal `{ data, meta, error }` envelope; missing ids are simply absent, and the
  caller diffs them to derive `missingIds` (see
  `apps/api/src/module/master-data/master-data-client.ts`).

**Depends on / blocked by:** Nothing. Each resource is independent; do them as demand appears.

---

## 4. Consider publishing `@molca/mes` properly (or migrating the remaining packages)

**What:** Revisit how `@molca/mes` is distributed, and decide whether the other five `@molca/*`
packages should join it.

**Why:** `mes-oee-monitor` and `mes-master-data` still carry byte-identical private copies of
`@molca/contract-client`, `@molca/helper`, `@molca/network`, `@molca/observability` and
`@molca/utils`. They will drift. Only `@molca/security` was extracted, because it was the one this
work had to change in both repos.

**Context:** `../mes-shared` publishes `@molca/mes` as a **tagged git dependency**
(`git+ssh://git@github.com/molca-id/mes-shared.git#v0.1.2`). It commits `dist/` and has no
`prepare` script — a build-on-install git dep requires each consumer to allowlist it under a key
containing the resolved commit SHA, which changes every release, and the accepted spelling varies
across pnpm versions. See that repo's README ("Why dist/ is committed") and
`.github/workflows/ci.yaml`, which fails if `dist/` is stale.

Costs of the current setup, which a registry would remove: consumers pin a tag by hand in two
repos; every version in `mes-shared/package.json` is pinned literally because a single-package
repo has no `catalog:`; and Docker/CI need SSH (`--mount=type=ssh`, `webfactory/ssh-agent`, the
repo secret `MES_SHARED_DEPLOY_KEY`).

**Depends on / blocked by:** Nothing technical. Migrating the remaining five is mostly mechanical
but touches every `@molca/*` import across 6 apps in 2 repos — do it one package per PR, not as a
single unbisectable commit.

---

## 5. Area → Work Center cascade filter on the shift-report screen — **DONE, INCIDENTALLY (closed 2026-08-25)**

**It was already built.** `components/layout/area-context.tsx` holds the area selection,
`lib/queries.ts` has `areasQueryOptions` and `workCentersQueryOptions` — the latter gated on
`enabled: areaId !== undefined`, so no request fires until an area is picked — both at
`REFERENCE_STALE_TIME` (5 minutes), and `by-shift.tsx` feeds its Line select from
`useWorkCenters(areaId)`. That is exactly the cascade this entry specified, down to the staleTime and
the gating.

**Nobody closed it, and the entry rotted into something actively misleading.** Every factual claim in
it was false by the time it was read:

| It said                                                                                | Actually                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `by-shift.tsx` is still a `ReportPlaceholder`                                          | a paged table with six filters                 |
| `components/ui/` is missing `select.tsx`, `table.tsx`, `popover.tsx`, `pagination.tsx` | all present                                    |
| `lib/queries.ts` holds exactly one query                                               | roughly twenty                                 |
| `apps/web` has **no** select or filter UI at all                                       | month, year, shift, line, status and hide-zero |

Read cold, it would have sent somebody rebuilding `select.tsx` from a sibling repo.

**Its one open instruction was consciously overruled, which is why this is closed rather than
partially done.** The entry said "make the filters URL-addressable with `validateSearch`". The area
is deliberately NOT a search param, and `area-context.tsx` states the reason at the point of the
decision: it survives navigation between reports, and it never filters a request on its own — it only
decides which work centers a page may offer, because core-api has no `areaId` filter. The _line_
filter it feeds IS in the URL, via `by-shift.tsx`'s `validateSearch`. So the addressability the entry
wanted is where it matters and absent where it would have been wrong.

**The lesson is about this file rather than about the feature.** AGENTS.md calls `TODOS.md` "the
durable backlog and part of the workflow, not a scratch file", and an entry describing an app from
several months ago is worse than no entry: it reads as authoritative. An item finished as a side
effect of other work needs closing at that point, not whenever somebody next picks it up and
discovers there is nothing to do.

## 6. Guard the `?ids=` filter semantics, and refresh the local mes-master-data checkout

**What:** Make `findAllWorkUnitByWorkUnitIds` reject a response containing work-unit ids it never
asked for, and pull the sibling `mes-master-data` checkout up to date.

**Why:** `apps/api/src/module/master-data/master-data-client.ts` sends `?ids=` to
`/v1/work-units`. Deployed `mes-master-data` **does** honour it — verified 2026-08-11 against
`https://api-md.mes.molca.id`: `?ids=1,2` returned exactly 2 rows where unfiltered returned 5. But
the local checkout at `../mes-master-data` has no `ids` field in `listWorkUnitInputSchema`
(`apps/api/src/module/work-unit/work-unit-dto.ts`), so it predates the feature. That matters
because zod **strips unknown query keys**: against any version without the filter, upstream
silently ignores it and returns the first page of the whole catalogue. `findAllWorkUnitByWorkUnitIds`
then computes wrong `found` / `missingIds`, and because nothing throws, the `degraded` counter and
the `work_unit_enrichment_degraded` warn in `work-unit-service.ts` never fire — the shift report
renders null or mismatched labels with no signal in logs, metrics or traces.

**Context:** This is the one failure mode in the master-data integration that is silent in all
three observability channels at once. The cheap fix is a semantic check rather than a schema one:
after parsing, diff the returned ids against the requested set and raise `parse_error` if upstream
returned any id that was not asked for. That converts a silent wrong-label render into a visible 502. The existing drift-guard fixture
(`apps/api/src/module/master-data/fixtures/work-units-by-ids.json`) pins the response _shape_ only
— filter _semantics_ are the hole. §3 above documents `?ids=` as an established convention and
should be read alongside this; the convention is real, it just is not universal across checkouts.

To re-verify at any time, mint a service token with `client_credentials` against `OIDC_TOKEN_URI`
(audience `mes-master-data`) and compare `GET /v1/work-units?ids=1,2&size=100` against
`GET /v1/work-units?size=100`. If the two return the same count, the filter is being ignored.

**Depends on / blocked by:** Nothing. Independent of §5, but it decides whether the labels on that
screen can be trusted.

---

## 7. TTL + single-flight cache for master-data reference lists — **DONE (2026-08-25)**

**Shipped:** `master-data-service.ts` caching `findAllArea` and `findAllWorkCenterByAreaId` behind a
5-minute TTL with single-flight, a 10 s failure backoff, and the last known good list served when
upstream is down.

**The design question this entry said to settle first is settled: YES, serve stale.** For a dropdown
a slightly stale option list beats a 502. The deciding argument was not the dropdown though — it was
that `TimeZoneResolver` already made exactly this call for exactly this upstream ("a TTL cache in
front and the last known good value behind"), so answering differently here would have put two
policies on one dependency. The cost is stated at the point of the code and metered: during an outage
a filter can offer a work center that has since been renamed, with nothing on screen to say so.

**The mechanism was EXTRACTED rather than copied, and that is the substantive part.** §7 pointed at
`health-handler.ts` as the pattern to copy. The better source was `TimeZoneResolver`, which already
had the whole state machine — TTL, single-flight, stale-on-failure, failure backoff, LRU cap — tuned
and covered by fifteen tests. Copying ~60 lines of two-timer, four-outcome logic a second time is the
kind of duplication that does not diverge loudly; it diverges in the failure path, which nobody
exercises by hand.

So it moved to `shared/stale-cache.ts`, which is the bar `shared/shift-window.ts` records for itself:
extract on the SECOND caller. The resolver was refactored onto it and **its fifteen tests passed
untouched**, which is what makes the extraction verifiably faithful rather than merely plausible. The
file owns the mechanism and none of the policy — each caller supplies its own `onOutcome`, `onStale`
and `wrapError`, so the resolver keeps its per-scope counter and its 404 passthrough while the lists
get their own.

**It earned the service this entry predicted it would.** `master-data-handler.ts`'s header stated the
rule and its own expiry — "The moment a rule appears — scoping areas to the caller's site, hiding
work centers with no OEE data, CACHING — it earns a service and this comment goes away." That comment
is now replaced by one recording what changed, including that the 502 body is unchanged because the
operation phrases moved with it.

**Registered as a SINGLETON, and the module comment explains why that is load-bearing.** The cache
lives on the instance, so a `.scoped()` registration would hand every request an empty one: no error,
no failing test, just a 100 % miss rate and exactly the upstream traffic the change removed. Awilix
`strict: true` then forces the client it consumes to be a singleton too, which it already was.

**Two implementation notes worth keeping.** The service holds TWO typed caches sharing one options
object rather than one cache over a union of both list types — the union version needs an `as` cast
per getter, and a cast would compile just as happily if the two key prefixes ever collided. And an
empty list is cached like any other, which is what stops a caller walking `?areaId=1..1e6` from
becoming upstream traffic.

**A new counter, and it is not the one that already existed.** `master_data_cache_total{list, outcome}`
sits beside `master_data_requests_total`, which records what crossed the WIRE — so after this change a
falling request rate is the cache working rather than traffic disappearing. `outcome="stale"` is the
one to watch and is invisible to every other signal: the request succeeds, the status is 200, nothing
logs an error, and a user is shown known-old data. Both alerts are in `prometheus-alerts.yml`.

**Not done: sizing the TTL from real traffic.** This entry suggested reading
`master_data_request_duration_ms` first. 5 minutes was chosen for CORRECTION LATENCY instead — how
long a renamed work center may show its old name — because these lists change on the order of weeks
and freshness buys almost nothing. It also matches `REFERENCE_STALE_TIME` in the browser on purpose:
two caches in series with different TTLs make "how old can this be" the sum of two numbers nobody
wrote down.

## 8. Distinguish "no downtime" from "the downtime ETL has not loaded" — **DONE (2026-08-25)**

**Shipped:** `GET /api/v1/downtimes/timeline` now returns `loadedThrough`, and `TimelineCard` renders
the neutral track with "No downtime detail recorded for this shift yet — the pipeline has not reached
it." instead of a full-width green band when the pipeline has not reached the shift's business day.

**This was the one silent failure the timeline feature shipped with, and it was accepted knowingly**
— option 7B over 7A during the original plan review. The entry's own words: "the ambiguous outcome is
the flattering one: a shift that was down for hours renders as flawless, with no error, no empty
state, and no test that could catch it."

**The watermark approach won, as this entry predicted, and the heuristic was not needed.** No
`pdtTime + updtTime + msTime > 0` cross-check: `oee.etl_watermarks.last_business_date` for
`downtime_reports` answers directly, and the repository already had `getDowntimeWatermark` for the
Pareto's own `loadedThrough`. The endpoint just was not carrying it.

**The predicate is the part worth reading.** "Empty" here is not "zero segments" — a clean shift comes
back as exactly ONE full-window `RUN_TIME` segment, which is also what an unloaded shift returns,
because `RUN_TIME` is never stored: it is the name for a gap between records. So the card asks
`segments.every(kind === "RUN_TIME")`, and the watermark decides which of the two that means.

**Both directions are guarded, and the second one matters as much.** A shift with real stops draws
regardless of the watermark — withholding the strip whenever the watermark lagged would hide downtime
that demonstrably exists, which is the opposite failure and a worse one. Four new tests in
`timeline-card.test.tsx` pin the pair, including that the strip is GONE rather than merely captioned
in the stale case: rendering both would still show a green band with a footnote, which reads as a
clean shift.

**No new machinery.** `selectLoadState` in `lib/load-state.ts` already carried the six-state ladder
and already cited this entry in its own comment; this made the payload `Watermarked` so the card
could use it.

---

## 10. Range index on `oee.downtime_reports` to remove the 7-day lookback horizon — **DONE (2026-09-02)**

> **CALLERS UNBOUND.** `0013` built `dt_reports_span_gist`; on 2026-09-02 the two
> read-path predicates that carried the `date` narrowing —
> `DowntimeReaderRepository.scopeAndWindow` and
> `WorkUnitReportReaderRepository.shiftStops` — were rewritten to a range `&&`
> matching that index character for character, and the narrowing was deleted.
> The horizon is gone rather than moved. §69 carries the measurements and the one
> behaviour that changed with it; §41's residual is closed by the same change,
> except for the half that lives on a different table.

**Status.** `0013` created `dt_reports_span_gist`, a GiST index over
`(work_unit_id, work_center_id, tstzrange(start_at, coalesce(end_at,'infinity'), '[)'))`, and
`EXPLAIN` confirms an index scan combining the scope column with the overlap test. It was built as
part of the By Day / By Monthly work, where a month window narrows to ~37 days of index instead of a
shift's ~8 hours.

It was built **non-concurrently**, which is forced rather than chosen: `scripts/migrate.mjs` runs
each file inside `sql.begin()`, and `CREATE INDEX CONCURRENTLY` is illegal in a transaction block.
A plain build takes a SHARE lock — reads continue, writes block — which is acceptable while Airflow
is the only bulk writer and writes in batches.

**What is left:** the callers still narrow on `date`. Dropping that from `scopeAndWindow` is the
half that actually removes the horizon and closes both this item and §41. The approach below
differs from what was implemented in two ways worth noting — no stored generated column was added,
because the expression form indexes identically and needs no schema change to `downtime_reports`;
and the expression is wrapped in `greatest(...)`, for the reason `0013`'s header gives at length.

**AND THE CALLER HALF IS NOT THE ONE-LINE SWAP IT LOOKS LIKE.** It was attempted while building
`0013` and deliberately backed out, because replacing

```sql
AND start_at < to AND coalesce(end_at, 'infinity') > from     -- today
```

with the indexable `&&` over the same range is NOT equivalent at two edges:

1. **A zero-length stop** (`start_at = end_at`) is a non-empty match today — `start_at < to` and
   `end_at > from` are both true inside the window — but `tstzrange(T, T, '[)')` is EMPTY, and an
   empty range overlaps nothing. Those rows would silently stop appearing in the Downtime Details
   table, which lists records rather than time and has always shown them.
2. **A stop ending exactly at `from`** is excluded today by the strict `end_at > from`. Switching
   the row side to inclusive bounds (`'[]'`) to rescue case 1 makes it overlap instead, attributing
   a stop to a shift that began the instant it ended.

So the swap needs a decision about both edges, not just a rewrite, and it must land with tests that
pin them. That is why the index shipped alone: it is the expensive, hard-to-reverse half, it is
inert until a caller uses it, and it changes no behaviour on its own.

**Do not "fix" this by making the index unguarded to match a naive query.** `0013` explains why the
`greatest(...)` is there: without it the index becomes a `CHECK (end_at >= start_at)` that this repo
deliberately declined to add, failing the migration on existing data and rejecting Airflow's inserts.

**A FOURTH reader now inherits this horizon (2026-08-19):** `paginateByReason`, behind the
Availability Loss detail report. It also adds the first `WHERE` on `reason ->> 0`, which no index
can serve against a jsonb array — so it scans whatever slice `scopeAndWindow` narrows to. An
expression index on `((reason ->> 0))` was considered and deliberately rejected: §3.3.1 of the
contract asks for `reason` to become a real `primary_reason text` column, which would buy the
filter, the GROUP BY and the index in one change, and indexing the jsonb shape now would be
throwaway work on a table holding 8 rows. Nothing here changes; the ask is stronger.

**What:** Add a stored generated `tstzrange` column and a GiST index over it, then drop the `date`
narrowing from `DowntimeReaderRepository.listOverlapping`.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE oee.downtime_reports
  ADD COLUMN during tstzrange
  GENERATED ALWAYS AS (tstzrange(start_at, coalesce(end_at, 'infinity'), '[)')) STORED;
CREATE INDEX ON oee.downtime_reports USING gist (work_unit_id, during);
CREATE INDEX ON oee.downtime_reports USING gist (work_center_id, during);
```

**Why:** The timeline query narrows on `date BETWEEN window.from - 7 days AND window.to` purely to
stay sargable — `date` is the business day a stop _started_ in, so bounding it is what keeps
Postgres from scanning a machine's entire history backwards. The cost is a correctness horizon: a
stop open longer than `MAX_OPEN_DOWNTIME_DAYS` silently drops out of windows it genuinely covers.
A range index makes the overlap test itself indexable, so the narrowing — and the horizon — can go.

**Context:** The constant and the reasoning are in `apps/api/src/module/downtime/downtime.ts`; the
query and its ASCII diagram are in `downtime-repository.ts`. `downtime-repository.test.ts` asserts
the emitted predicate, so removing the narrowing is a visible, tested change rather than a silent
one. Three smaller items belong in the same conversation with the schema owner, all of them
cheaper than this one:

- `CHECK (end_at IS NULL OR end_at >= start_at)` — inverted rows are currently possible and the
  service drops them at runtime (`clipToWindow`, counted as `downtime_rows_dropped_total`).
  Rejecting at the source is better than counting.
- `duration` is a nullable `int8` written independently of `start_at` / `end_at` and can disagree
  with them. It should be `GENERATED ALWAYS AS ... STORED`, or dropped.
- `shift varchar` would be better as `smallint` or an enum (`category` already is one), and `date`
  is a business-day bucket typed as `timestamptz` — a `date` column would remove a whole class of
  time-zone ambiguity.

Until any of this lands, the workhorse indexes to ask for are
`(work_unit_id, date, start_at) INCLUDE (end_at, category)` and its `work_center_id` mirror, which
match the query exactly as written today.

**Depends on / blocked by:** Wants a real row count first — none of this is worth doing on a small
table (the live table held 8 rows on 2026-08-13, all hand-seeded). Nothing else blocks it: §1
identified the owner, and the integrity items are filed as §3.3 of
[`docs/gold-write-contract.md`](docs/gold-write-contract.md). Because the DAG is unwritten, the
generated `duration` column and the `end_at >= start_at` check reject nothing that exists yet —
agreeing them now is free, agreeing them after the first load is not.

**Sizing note, measured 2026-08-13.** At the 500-work-unit target this table takes roughly 18M
rows a year, which is where the range index starts to matter and is also the input to the Gold
store decision in §20.

---

## 11. Integration-test the shift-window SQL against a real Postgres — **DONE (2026-08-18)**

**Shipped:** `apps/api/src/module/downtime/downtime-repository.integration.test.ts`, and a
`postgres:18-alpine` service on the `test` job in `.github/workflows/api.yaml`. CI applies the
checked-in DDL with the real `scripts/migrate.mjs` — so the schema under test is the one this repo
owns, not a fixture that could drift from it — then runs the suite.

The suite skips unless `GOLD_TEST_DATABASE_URL` is set, so a developer without Docker still gets a
green `vp test`. To run it locally:

```
docker run -d --name oee-itest-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_DB=gold_test -p 55433:5432 postgres:18-alpine
GOLD_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test node apps/api/scripts/migrate.mjs
GOLD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/gold_test vp run api#test
```

**What it covers, and why it went further than this item asked.** `getWindow` is asserted for all
three shifts at `Asia/Jakarta`, including the shift-3 case this item named — it comes out `+8h`, not
`-16h`. But the reason the infrastructure finally got built was `aggregateByReason`, added for the
Availability Loss tab: it clips each stop to the window with
`LEAST(coalesce(end_at, now), to) - GREATEST(start_at, from)`, and `fakeSql` can assert that text
while saying nothing about what it computes. A clip yielding seconds instead of milliseconds, or
LEAST and GREATEST with their bounds swapped, does not throw — it renders a plausible Pareto. The
suite asserts values for a stop inside the window, one straddling each end, an open stop in a closed
shift and in a live one, an inverted row, a multi-reason stop, four flavours of unusable reason, and
a wrong-category row.

**The `fakeSql` tests stay.** They pin SHAPE — that the stored `duration` column is never read, that
the reason array is never exploded — which result assertions cannot see. Neither suite subsumes the
other.

**What is still not covered:** `listOverlapping` and `paginateDowntime` have no result assertions,
only the shared predicate they inherit through `scopeAndWindow`. The infrastructure is now there, so
adding them is a test file rather than a CI change.

---

## 12. Establish ownership of the `product_count_wu_shift` schema — **DDL DONE (2026-08-13)**

**What remains:** document which pipeline writes it. The DDL half is closed — §1 captured the
whole `oee` schema in one migration, so `oee.product_count_wu_shift` and its day-grain sibling
`oee.product_count_wu_day` are both in
`apps/api/src/shared/database/migration/0003_oee_gold_schema.sql`, verified against the live
catalogue and exercised by a seeded shift-3 join.

Everything the plan review recorded by hand is now enforced by the checked-in DDL rather than by
prose: primary key `(work_unit_id, shift_date, shift, product_id)`, measures `numeric(15,3)`,
`factor_to_base numeric(10,3)` with `CHECK (factor_to_base > 0)`, non-negativity on the four
measures, and `CHECK (shift BETWEEN 1 AND 3)` — all three constraint classes were confirmed to
fire. The secondary indexes `pcwus_ix_pcs_date_shift` and `pcwus_ix_shift_pcs_product` are
captured too, though they still serve no query this service issues; the join uses the primary
key's left prefix.

The type hazard that made this worse than §1 is now visible in the repo: `shift_date` is a real
Postgres `date` while `work_unit_shift_reports.date` is a `timestamptz` holding the shift's start
instant, and the migration says so at the point of definition. That mismatch is what silently
returned nothing for shifts 2 and 3 — see §17.

**Depends on / blocked by:** Nothing — §1 closed the last open half by identifying the writer
(Airflow → dbt, owned by Wira Hutomo), so this item is fully resolved. The one thing still worth
chasing is §13: a wrong-but-positive `factor_to_base` renders a plausible number and no constraint
this repo can write will catch it, which is why it is asked of the pipeline in §3.4 of
[`docs/gold-write-contract.md`](docs/gold-write-contract.md).

---

## 13. Constrain `factor_to_base` to be consistent per product and UOM pair

**What:** Ask the ETL owner to guarantee — ideally with a reference table and a foreign key, or
failing that a uniqueness constraint — that all rows sharing `(product_id, uom_id, base_uom_id)`
carry the same `factor_to_base`.

**Why:** `listProductCount` multiplies three of its four measures by `factor_to_base` per row, so a
single row with a wrong factor renders a plausible number rather than failing. Nothing in the
database or the code can detect it: `CHECK (factor_to_base > 0)` admits any positive value, and a
conversion factor is not something the API can sanity-check without knowing the product. This is the
only silent data-quality hole in the SKU View feature that no test can close.

**Context:** The factor is applied in exactly one place — the `listProductCount` query in
`apps/api/src/module/work-unit/work-unit-repository.ts`, which carries a diagram of which columns are
scaled and which is not. `apps/web/src/lib/product-count.ts` pairs each figure with its unit code and
is tested for that pairing, but neither layer can validate the factor's _value_. A pragmatic interim
step, if the upstream fix is slow: have the ETL log or reject rows whose factor disagrees with the
most recent value for the same triple.

**Depends on / blocked by:** Nothing outstanding — the owner is identified (§1) and this is filed
as §3.4 of [`docs/gold-write-contract.md`](docs/gold-write-contract.md). Independent of the API
code: nothing in this repo changes when it is fixed.

---

## 14. Distinguish "the machine ran no product" from "the product-count ETL has not loaded" — **DONE (2026-08-25)**

**Shipped:** a `getProductCountWatermark` reader, `GET /work-units/shift-reports/:id/products`
reshaped from a bare array into `{ items, timeZone, loadedThrough }`, and `SkuViewCard` rendering two
different sentences for what used to be one.

**The payload had to change shape, and that is the whole story.** An empty array cannot say WHY it is
empty. `/products` was the last endpoint on this screen still returning a bare list — `/performance`,
`/rejects` and `/downtime-events` are all objects, each carrying a fact the rows cannot state about
themselves — and this is that fact.

**Why this one arrived last of the four watermarked surfaces.** The other three back tabs that ship
against an EMPTY table, so "no rows" was obviously the normal answer and the watermark was obviously
load-bearing. `oee.product_count_wu_shift` is populated, so the card looked correct — and rendered
"No product output recorded for this shift" for a machine that ran nothing AND for a day the pipeline
had not reached. Populated tables hide this class of bug better than empty ones do.

**One defect fixed on the way in:** `getShiftReportProducts` returned `data.data ?? []`. That default
discarded exactly the field that decides the question — an absent payload became an empty list, which
then read as an idle machine. It throws now, matching `getShiftReportPerformance`.

**The card had no test at all before this**, and the gap and the defect were the same thing: nothing
in the suite distinguished the two states because nothing on screen did. It has seven now, including
the inverse guard that rows which exist still render when the watermark lags.

---

## 15. A line-, area- and factory-level SKU view needs its own aggregate table — **ANSWERED FOR THE LINE GRAIN (2026-08-31)**

**What:** Before building the sidebar's disabled `SKU` navigation section, decide where
wider-than-one-machine product counts come from — a new Gold table at each grain, or a documented
roll-up over `oee.product_count_wu_shift`.

**Why:** `apps/web/src/components/layout/app-sidebar.tsx` already renders `Line`, `SKU`, `Area` and
`Factory` as greyed-out stubs, so this will be asked for. It is worth recording now that the existing
table cannot answer it: the grain is one work unit (its name says `wu_shift`), which is precisely why
`GET /work-units/shift-reports/:id/products` is a sub-resource of a report rather than a
scope-parameterised collection like `/downtimes`.

**Context:** The alternative was considered and rejected during the plan review. `/downtimes` takes
`scope=work-unit|work-center|area|factory` because a downtime genuinely belongs at any level; a
four-level scope param over a table that can only ever answer one would be a false contract, and it
would also force the browser to join two Gold tables by value. Note a roll-up is not just a `SUM`:
`factor_to_base` differs per product, so summing across work units has to happen after conversion to
the base unit, and the "Finish Good stays in its production unit" rule stops being expressible at all
once two machines count the same SKU in different units. That rule, and the conversion, live in
`work-unit-repository.ts` and `apps/web/src/lib/product-count.ts`.

### The answer, for the LINE grain (2026-08-31)

**A new pair of Gold tables, written by the pipeline** — `oee.product_count_wc_shift` and
`oee.product_count_wc_day`, added by migration `0016`, requested of the pipeline owner in
`docs/gold-write-contract.md` §17. Two tables rather than three: `listPeriodProductCount` already
proves a day table serves BOTH coarse grains by widening it over a span, and there is no
`product_count_wu_month` either.

**And the decisive argument is not the `factor_to_base` one this entry gives.** That argument is
real, but it is about difficulty. The one that settles it is about correctness:

> A line is MEASURED, not summed. `0014` and commit `4fccce8` establish that a line has its own count
> points, so `line <> sum(machines)`. The overview card sits DIRECTLY ABOVE SKU View and renders the
> line's own `total_out` / `good_out`. A rolled-up SKU View would therefore print per-SKU figures that
> **visibly disagree with the card above them, on the same screen** — and the disagreement would be
> CORRECT, which is what makes it unexplainable to a supervisor. Only the line's own per-product count
> points reconcile, and no read-time query can produce them.

The product question this entry ends on is answered the same way: a line-level "Finish Good" means
whatever the line's own output count point measured, in the line's own output unit — which is why
`0014` gives the `work_center_*` tables an infeed unit and an output unit rather than one (contract
§16.4a), and why `0016` keeps `uom_*` / `base_uom_*` / `factor_to_base` per row unchanged.

**The tables ship EMPTY, and there is deliberately no dev seed** — a divergence from
`0015_work_center_reports_dev.sql`'s precedent. That seed derives line reports from machine reports
and says loudly that it is a stand-in. Here the only available derivation is _the wrong number by
construction_, so a seed would teach exactly the invariant the table exists to deny. §14's
loaded/stale ladder is what lets `sku-view-card.tsx` say which kind of empty it is showing until
Airflow fills them.

**Still open: AREA and FACTORY.** Both need the same treatment and neither has a report table at all
yet, so this entry stays open for them. The precedent to follow is the one above, not a roll-up.

**Depends on / blocked by:** the LINE grain is unblocked and shipped. AREA and FACTORY still need a
report table each before this question can even be posed at those grains, plus the same pipeline
request `0016` made. Blocks the `SKU` sidebar section having a real route.

---

## 16. A component-testing convention for the web app — **DONE (2026-08-18)**

**Shipped:** `happy-dom` and `@testing-library/react` in `apps/web`, `test.environment` set in
`apps/web/vite.config.ts`, and a shared `src/test/render.tsx` helper. The convention is now written
down next to that config rather than only here.

**The helper is the part that makes it stick.** Every fetching card needs a `QueryClientProvider`,
so `renderWithQuery` supplies a fresh client per call — never a module-level one, or a test that
seeds "loaded" leaks into the next test's "empty" assertion — with `retry: false` (an error-state
test otherwise waits out three backoff retries and reads as a timeout) and `staleTime: Infinity`.
It also supplies `TooltipProvider`, which in the app comes from `SidebarProvider` several levels
above any card: without it a card throws a **caught** React error, leaving a green test and a stack
trace in the output. `src/test/fixtures.ts` holds a complete `ShiftReportDetail` builder so a new
column upstream costs one line rather than one per test file.

**The split with the pure-function tests is deliberate, not transitional.** Arithmetic and time-zone
handling still belong in a pure `src/lib/*.ts` — they are far cheaper to cover exhaustively as
functions than through a rendered tree, and `lib/pareto.ts` was written that way on purpose. What
the DOM adds is which state a card SELECTS.

**Covered so far:** `timeline-card.tsx` (§16's named first target) and
`reason-pareto-card.tsx`. Both include the regression that motivated this: a query gated off with
`enabled: false` reports `status: "pending"` forever, so a card reading `isPending` first renders a
skeleton that never resolves. That shipped in two cards because nothing could catch it. The test
asserts the skeleton is GONE, not merely that a message appeared — rendering both is the state the
bug actually produced.

**What is left:** `summary-oee-card.tsx`, `waterfall-card.tsx`, `sku-view-card.tsx`,
`downtime-details-card.tsx` and `performance-dialog.tsx` have no component tests. The convention now
exists, so each is a test file and nothing more.

---

## 17. Denormalise a `business_date` column onto `oee.work_unit_shift_reports`

**What:** Ask the ETL owner to write the shift's business day as a plain `date` column alongside the
existing `date` timestamptz, then filter and join on it.

**Why:** `date` is a `timestamptz` holding the instant the shift STARTED, not a calendar day. Every
consumer that wants a day out of it has to resolve the plant's zone first, and one consumer cannot:
`periodFilter` in `apps/api/src/module/work-unit/work-unit-repository.ts` builds a month window across
**many** work units in a single query, and the zone is not a column, so no single predicate is
correct. Measured against the live database:

```
plant           shift 3 of Aug 31   ->  instant        in the August filter?   truth
Asia/Jakarta      23:00+07          ->  Aug 31 16:00Z         yes               yes   ok
America/Chicago   23:00-05          ->  Sep  1 04:00Z         no                yes   WRONG
America/Chicago   shift 3 of Jul 31 ->  Aug  1 04:00Z         yes               no    WRONG
```

So a month report is exact for this plant and misattributes both ends of the month for any plant west
of Greenwich. A `business_date` column removes the problem rather than working around it, and would
additionally let the SKU View join drop its `AT TIME ZONE` conversion and the report detail drop the
`timeZone` resolve on its happy path.

**Context:** The same fact caused a shipped bug worth recording. `listProductCount` originally joined
`p.shift_date = r.date` — a `date` against a `timestamptz` — which Postgres resolves by widening the
date to midnight, so only a shift starting at exactly 00:00 in the session zone could ever match. At
UTC+7 that is shift 1 alone; shifts 2 and 3 returned nothing and the card rendered "No product output
recorded for this shift", indistinguishable from an idle machine. The fix in place now is
`p.shift_date = (r.date AT TIME ZONE ${timeZone})::date` with the zone resolved per work unit, and
`work-unit-repository.test.ts` pins both the correct form and the absence of the naive one.

Three other places had asserted in comments that the column was a Postgres `date` at UTC midnight —
`apps/web/src/lib/types.ts`, `lib/api.ts`, `lib/format.ts` — and all are corrected. `formatReportDate`
and `toBusinessDay` now take the zone explicitly, which is why `ShiftReportListItem.timeZone` exists
and is nullable.

**How to fix, in order.** Steps 1-3 are additive and safe to ship on their own; nothing changes
behaviour until step 4.

1. **Add the column, nullable at first.** `ALTER TABLE oee.work_unit_shift_reports ADD COLUMN
business_date date;` Nullable so the ETL and the backfill can land independently of each other,
   and so a missed row is detectable rather than defaulted to something plausible.

2. **Backfill, per zone — not globally.** The conversion needs each work unit's zone, so group by it
   rather than assuming one plant:

   ```sql
   UPDATE oee.work_unit_shift_reports
      SET business_date = (date AT TIME ZONE 'Asia/Jakarta')::date
    WHERE work_unit_id = ANY (:ids_for_that_zone) AND business_date IS NULL;
   ```

   The id-to-zone mapping is not in Gold; get it the way the API does, from mes-master-data's site
   hierarchy (`findTimeZoneByScope`, see `apps/api/src/module/master-data/time-zone-resolver.ts`).
   Then verify before trusting it — this is the assertion that matters:

   ```sql
   SELECT shift, count(*) FROM oee.work_unit_shift_reports
    WHERE business_date <> (date AT TIME ZONE 'Asia/Jakarta')::date OR business_date IS NULL
    GROUP BY shift;   -- must return zero rows
   ```

3. **Index it, then make it `NOT NULL`.** `CREATE INDEX CONCURRENTLY wusr_ix_wu_business_date_shift
ON oee.work_unit_shift_reports (work_unit_id, business_date, shift);` — that composite serves both
   the month filter and the product-count join. Add `SET NOT NULL` only once step 2 verifies clean,
   and get the ETL writing the column before that, or new rows will violate it.

4. **Switch the queries, in this order**, all in
   `apps/api/src/module/work-unit/work-unit-repository.ts`:
   - `periodFilter` — `business_date >= make_date(...)` / `< ... + interval '1 month'`. Now a genuine
     date-to-date comparison: sargable, and no session zone can move a boundary. This is the fix.
   - `listProductCount` — `p.shift_date = r.business_date`, dropping the `AT TIME ZONE` conversion
     and the `timeZone` parameter with it. Update the two assertions in
     `work-unit-repository.test.ts` that currently pin the conversion form.
   - `getProductCounts` in `work-unit-service.ts` — the `getReportScope` call and the resolver call
     both exist only to obtain that zone, so the method collapses back to one query. Keep the 404,
     which then comes from an empty result plus a separate existence check, or accept a 200 `[]`.

5. **What can be simplified afterwards, and what cannot.** `ShiftReportDetail.timeZone` must STAY —
   the downtime timeline and the clock times on the strip need it independently. But once the report
   carries `business_date`, the browser can send it straight to `/downtimes` and `toBusinessDay`
   disappears entirely, along with `ShiftReportListItem.timeZone` being needed for the date column.
   Do that as a separate change; it touches `lib/queries.ts`, `lib/format.ts` and the By Shift table.

6. **Verify the thing that was broken.** Compare attribution across the switch, not just row counts —
   a month report that changes by one shift at each boundary is the fix working:

   ```sql
   SELECT date_trunc('month', business_date) AS by_business_day,
          count(*) FILTER (WHERE date >= make_date(2026,8,1)
                             AND date <  make_date(2026,9,1)) AS by_old_predicate,
          count(*) AS by_new_predicate
     FROM oee.work_unit_shift_reports GROUP BY 1 ORDER BY 1;
   ```

   For a UTC+7 plant the two columns should agree exactly — that is the regression check. They are
   expected to differ only once a plant west of Greenwich exists.

**If the pipeline cannot be changed:** there is no correct workaround inside this repo. A generated
column cannot reach another service for a zone, and a view would need a `work_unit_id -> timezone`
table that Gold does not have. Materialising that mapping into Gold is the smaller version of this
same request, and is worth proposing instead of hand-rolling per-query conversions that will drift.

**The backfill is very likely unnecessary.** Steps 1-3 above were written assuming a populated
table. It is not: `work_unit_shift_reports` holds 3 hand-seeded rows and the `work_unit_*` DAG has
not been built (§1). If `business_date` is specified before the first real load — which is what
§3.1 of [`docs/gold-write-contract.md`](docs/gold-write-contract.md) asks for — then step 1 ships
as `NOT NULL` immediately, step 2 disappears, and step 4's query switch is the whole job. **This
is the cheapest it will ever be; every day the DAG goes unwritten it stays that cheap, and the
first production load ends it.**

**Depends on / blocked by:** Agreement from the DAG owner (Wira Hutomo) that dbt writes the
column. The migration itself is this repo's to write — §1 checked in the `oee` DDL and
`scripts/migrate.mjs` applies it. Until then `periodFilter` stays correct-for-Jakarta-only, and
the limitation is documented in a comment above the method so it is not mistaken for a plain bug.

---

## 18. The `work_unit_*` DAG has no repository

**What:** Get the Airflow DAGs and dbt project that will write Gold into `molca-id`, before the
first production load rather than after.

**Why:** The pipeline is being developed on one laptop. Until it is pushed there is no review
path, no history, no CI, and nobody but its author can redeploy it — and
[`docs/gold-write-contract.md`](docs/gold-write-contract.md) is the only durable statement of what
Gold expects from it. Every requirement in §9, §10, §13 and §17 is addressed to code that cannot
currently be read, so none of them can be verified as done.

**Context:** `molca-id/poc-flink-v2` is the same author's implementation of this pipeline for the
older `line`/`machine` vocabulary — Airflow DAGs, 20 dbt gold models, and Flink jobs — targeting
`103.185.38.172:5442`, dbname `gold`, schema `public`. It is the natural starting point and
already schedules `0 0,8,16 * * *`, matching `SHIFT_WINDOWS` in `downtime.ts` exactly. The port is
naming and target, not capability; §7 of the contract doc lists the mapping.

**Depends on / blocked by:** Wira Hutomo (`pwawiwa`), who owns it.

---

## 19. `downtime_reports` cannot be upserted idempotently — **KEY SHIPPED (2026-08-19), NEEDS POPULATING**

**Closed half:** `work_unit_perf_analytics` was the other table named here. It was **dropped** in
`0006_oee_product_perf_wu_hour.sql` and replaced by `oee.product_perf_wu_hour`, which ships with a
real natural key — `pk_product_perf_wu_hour (work_unit_id, bucket_start, product_id)`. Fixing it in
place was never the cheaper option: its grain was an arbitrary `start_time..end_time` interval, so a
key on `start_time` would only have been unique while intervals never changed length or origin —
exactly the fragility the fallback below is criticised for. Re-graining to a fixed hour bucket makes
overlap a primary-key violation rather than a thing nobody notices.

**The key has now SHIPPED as a column (2026-08-19).** `0007_oee_downtime_detail.sql` adds
`source_event_id text` with a UNIQUE index — the _preferred_ option below, not the fallback. It
arrived because the Availability Loss detail report needed a stable public identifier for a stop,
which turns out to be the same requirement seen from the other end: the UI cannot key a deep link
on `id` for exactly the reason dbt cannot key an upsert on it.

UNIQUE over a nullable column is deliberate. Postgres permits any number of NULLs, so all existing
rows coexist untouched and the constraint starts biting the moment the pipeline writes the key.

**What is left:** the pipeline must POPULATE `source_event_id` — a deterministic id carried from the
Silver event, per §3.3.2 of the contract — and the model must then become an upsert rather than an
append. Until it does, the DELETE-then-INSERT rule below still stands, and
`oee.downtime_report_history` cannot attach to anything.

**What was left before:** give `downtime_reports` a natural key so dbt has an `ON CONFLICT` target,
then make the model an upsert rather than an append.

**Why:** Its only unique index is on the surrogate `id` (`serial`), which the pipeline neither
supplies nor can match on. **A DAG retry, a DLQ replay or a backfill therefore inserts every row a
second time.** Nothing errors: duplicated stops render as a doubled timeline strip and inflated
downtime totals, which no test and no operator would catch. This is not hypothetical —
`poc-flink-v2` already ships `backfill_bronze_silver.py` and `dlq_monitor_dag.py`, so re-running
is an explicit part of the design.

The other six tables are safe: `wu_shift_report_key`, `wu_day_report_key`, `wu_month_report_key`,
the two product-count primary keys and `pk_product_perf_wu_hour` are all natural keys that `0003`
and `0006` enforce.

**Context:** Two options, in §2.1 of [`docs/gold-write-contract.md`](docs/gold-write-contract.md).
Preferred is a deterministic `source_event_id` carried from the Silver event through to Gold and
made `UNIQUE`, which survives a stop being corrected upstream. The fallback,
`UNIQUE (work_unit_id, start_at)`, is cheaper but breaks if `start_at` is ever revised — the
revision looks like a new row. Until one lands, the model writing `downtime_reports` must be
`DELETE`-then-`INSERT` scoped to the run window.

**Depends on / blocked by:** No longer a schema decision — the key exists and is the preferred one.
What remains is the DAG owner writing it, and the model switching to an upsert once it does.

---

## 20. Gold stays on plain Postgres — **BENCHMARKED (2026-08-13)**

**Decision:** keep plain Postgres for all seven tables. **Do not move Gold to a TimescaleDB
columnstore.** If ad-hoc BI becomes a firm requirement, mirror only `downtime_reports` and
`product_perf_wu_hour` into ClickHouse for BI and leave serving and mutations in Postgres.

Full method, numbers and caveats in §8 of
[`docs/gold-write-contract.md`](docs/gold-write-contract.md). One year at 500 work units — 18.07M
downtime rows — with both Postgres variants on the same server so the only variable was
heap versus hypertable-plus-columnstore.

**This reversed the going-in assumption**, which was that Timescale's columnstore was the obvious
answer: same SQL, same driver, already in the stack, and named for Gold by the KAIDO spec. It lost
on the paths the product actually uses:

| Query                             | plain PG | Timescale  | ClickHouse |
| --------------------------------- | -------- | ---------- | ---------- |
| report detail by id               | 0.4 ms   | **91 ms**  | 4 ms       |
| product-count join for one report | 0.8 ms   | **770 ms** | –          |
| By Shift list                     | 0.8 ms   | 5.1 ms     | –          |
| BI: downtime Pareto, plant-year   | 2799 ms  | 2660 ms    | **390 ms** |
| edit 1,000 downtimes              | 15 ms    | 728 ms     | 219 ms     |
| `downtime_reports` on disk        | 3551 MB  | **158 MB** | 304 MB     |

Two independent causes, both isolated: `GET /shift-reports/:id` carries no date, so no chunk can be
excluded and the plan fanned out across **39 chunk nodes** (adding a month predicate cut 96 ms to
16 ms — but the route cannot supply one); and the remaining 16 ms versus 0.4 ms is decompression on
the hot path. Meanwhile the upside never arrived — all three BI queries were within ±8%. These are
aggregate tables of a few hundred MB; Postgres already scans them fast.

**What is worth doing instead, in order.** The only genuinely slow query is the plant-year Pareto at
2.8 s. Before any engine change: normalise `reason` out of `jsonb` (measured at ~25% of that query —
2799 ms to 2111 ms), add the range index in §10, and add monthly roll-ups if BI settles on known
shapes. ClickHouse's 7x is real but its mutations are asynchronous by default, so an operator who
approves a report and reloads can read the stale value — it cannot hold the serving role that §21
needs, only the BI mirror.

**Depends on / blocked by:** Nothing; the decision is made. Revisit only if row counts approach the
projection — the live table held 8 rows on 2026-08-13.

---

## 21. The approval and downtime-edit write paths — **DONE (2026-08-25)**

**Shipped:** both named operator mutations `docs/gold-write-contract.md` §1 rule 2 reserves for this
service. Approving a shift report landed 2026-08-24 (`0010`, `POST /:id/approve`, the header's
Approve button). Editing a downtime landed 2026-08-25:
`PATCH /api/v1/downtimes/:sourceEventId`, one history row per changed field, and the row menu's Edit
item finally doing something.

**It needed no migration**, which is the payoff of `0007` having shipped the schema ahead of the
feature: `detail_reason` and `oee.downtime_report_history` were already there, with a CHECK naming
exactly the four editable fields, and `category` / `reason` / `actions` had always been columns.

**The three things that turned out to matter, none of which this item predicted.**

**A stop straddling 23:00 belongs to TWO shift reports, so the freeze has to consult both.** That is
the rule every read path already followed (`scopeAndWindow`, `listShiftDowntimeHistory`), but it was
not obvious that a WRITE had to follow it too. Resolving the report from the stop's own
`(work_unit_id, date, shift)` — the obvious implementation — would let an edit to a straddling stop
silently move the availability loss on a shift somebody had already signed off, with nothing in
_that_ report's trail to show it. `listApprovalsOverlapping` resolves every report the stop covers
and refuses if any is closed. It rebuilds each window through `AT TIME ZONE` rather than adding
eight hours, because eight WALL-CLOCK hours across a DST transition is seven or nine real ones and
`TimeZoneResolver` resolves the zone per work unit precisely because Asia/Jakarta is not a permanent
assumption.

**The concurrency guard needed no version column.** The dialog sends the values it opened with, the
`UPDATE` matches on them, and zero rows is a 412 — `closeShiftReport`'s "row count IS the outcome"
idiom, reused. On zero rows the AUDIT TRAIL is what says which writer got there first: an operator
edit leaves a history row explaining the current value, a pipeline restatement leaves nothing. That
distinction exists because telling somebody "another user changed this" when the nightly DAG rebuilt
the row names the wrong actor, in the one interaction where being believed matters.

**Only `category` makes anything on screen stale.** `reason`, `actions` and `detail_reason` are read
live out of `oee.downtime_reports` by the Pareto, the drill-down and the drawer, so those edits are
already reflected when the request returns. Only `category` moves time between schedule loss and
availability loss, and those totals are precomputed. That single observation is what kept the whole
change small — three of the four fields need nothing from the pipeline at all.

**What it did NOT do, and each is now its own entry.** No recalculation trigger (§38), no Grafana for
the two new counters (§39), no database-level guard on the `reason` array (§40), and the freeze has a
stated hole for long-open stops (§41).

**Why the feature is still nearly invisible:** the pipeline does not write `source_event_id`, so a
stop that has none is not addressable and 404s. The screens ship correct and inert — the row menu
disables Edit and says why — which is the same trade `0007`, `0008` and `0009` each made.

**Corrected 2026-08-25 after checking the dev database:** it is NOT null everywhere, as this item and
`0007`'s header both assumed. Three of the seventeen rows carry hand-seeded UUIDs, and
`oee.downtime_report_history` already holds two hand-written rows against one of them — with
`changed_by: "superadmin"`, a username, where this service writes the Keycloak subject. So the
feature IS exercisable on dev today, on those three stops, and
`apps/api/scripts/seed/0007_downtime_source_event_id_dev.sql` is only needed on a database where
nothing has been seeded (its `WHERE source_event_id IS NULL` guard leaves the existing three alone).

Populating it for real is §19, and `docs/gold-write-contract.md` §13 must land in the same change or
the first run after it discards every edit.

---

## 22. Confirm the `work_unit_perf_analytics` DROP with the DAG owner

**What:** Get a yes/no from **Wira Hutomo** (`pwawiwa`) that no dbt model on his laptop writes
`oee.work_unit_perf_analytics`, **before** `0006_oee_product_perf_wu_hour.sql` is applied to the
live Gold database.

**Why:** `0006` drops that table. `apps/api/scripts/migrate.mjs` is **forward-only** — it tracks
`schema_migrations(version, applied_at)` and has no down path — so the drop is irreversible through
the runner, and recovery means re-running `0003`'s `CREATE TABLE` by hand. The table has no reader
in this repo and held only hand-seeded rows, so the drop is safe _here_; the risk lives entirely on
the other side of a boundary this repo cannot see across. §18 is the reason: the DAG has no
repository, so nobody could grep for the model.

**Context:** The whole swap is written up for him in §9 of
[`docs/gold-write-contract.md`](docs/gold-write-contract.md) — what was added, what was dropped,
why re-graining beat fixing in place, and the four things he has to do. Two of those are traps he
will otherwise hit at runtime: the new dbt model **must be named `product_perf_wu_hour`** or the
watermark insert fails the `ck_etl_watermarks_table` check, and a naive `merge` strategy fails
outright because `actual_rate_per_hour` and `ideal_out` are `GENERATED ALWAYS` columns (verified
against Postgres 18.4, not predicted). Use `incremental_strategy='delete+insert'`.

If the answer is "yes, a model exists", the fix is small and known: point that model at
`product_perf_wu_hour`, re-grain its select to local wall-clock hours per §3.6, and drop its
`actual_rate_per_hour` / `ideal_out` assignments. Nothing needs to change in this repo.

**Depends on / blocked by:** Nothing technical. It is one message, and it blocks deploying `0006`.

---

## 23. Day- and month-grain performance charts — **DONE (2026-08-27)**

**Status.** The day chart ships. The Losses card's View button is offered on a By Day report and
opens the same Hourly Production dialog the shift report uses, with 24 buckets instead of 8, served
by `GET /work-units/day-reports/:id/performance`.

This item's central claim held exactly as written: `listPerfHours` was reused UNCHANGED. The day
handler passes the same date twice and omits the shift, and that is the whole difference. It really
was a new handler rather than a new query.

**The month shipped too, as the hour-of-day profile this entry specified** — 24 points, not ~720.
`GET /work-units/month-reports/:id/hour-profile` is its own endpoint rather than a second shape on
`/performance`, because a bucket there is a clock hour that occurred ~30 times rather than an
instant.

**THE VIEW BUTTON WENT BOTH WAYS BEFORE IT SETTLED, and this paragraph was wrong for two weeks.**
It read "the View button and the Trendline sub-tab are offered at every grain now", which was true
when written and stopped being true hours later: `ec22f42` removed the month button again, arguing
that the profile "belongs on the Losses page's Performance Loss → Trendline sub-tab" and that a
month report should reach it through the external-link icon. The Trendline half stayed. Nobody
corrected this paragraph, so `apps/web/AGENTS.md` carried the same claim and the code disagreed
with both.

**Settled (2026-09-11), in the ORIGINAL direction, because the owner reported the button as a
missing feature.** The removal's reasoning was coherent — one card-level shortcut per question, and
a month asks a different question — but it cost the month screen the affordance the other two grains
have, on the screen furthest from the hour, to reach a chart that was already built and wired. The
sub-tab still renders it; the card is a second door to the same room. `losses-card.test.tsx` now
asserts WHICH fetcher each grain reaches, which is the assertion neither earlier version had — and
the one that matters, because a month id on `/performance` 404s into a card-local error state and a
day id on the month profile draws a readable chart about the wrong span.

**AND THE LINE CARD FOLLOWED THE SAME DAY.** It was shift-and-day, which this paragraph had just
identified as a MISSING READ rather than a design choice: `GET /work-centers/month-reports/:id/
hour-profile` already existed and already served the line's Trendline sub-tab, and
`LinePerformanceDialog` simply did not call it — so the button would have opened an empty panel.
Wired, as this paragraph said to, rather than by re-gating the machine card.

**The file's own header had rationalised the gap**, which is the part worth remembering. It read
that a month's profile "belongs on the Losses page's Performance Loss → Trendline sub-tab rather
than behind a card button. Exactly where the machine screen puts it, and for the same reason." The
first clause was true and is why there are two builders; the second cited a machine-side rule that
had already been reversed. A comment that explains an absence is worth re-reading whenever the
thing it compares itself to changes.

**`buildLineHourOfDayOutput` had no tests**, because the Trendline sub-tab was its only caller.
A card button is a second surface on a shipped screen, so the two things it can get wrong are now
pinned over the hour-of-day axis as well: the output-side rename (`goodOut` takes the slot the
machine chart fills with `totalOut`) and the unit the block is denominated in. Over a MONTH the
infeed figure is ~30x larger, so one reaching the quantity domain scales the axis by cartons that
do not exist and flattens every output series along the bottom — more visible than at day grain,
and on a separate code path.

**Verified end to end** against a real Postgres: a line month report over September with hourly rows
for 09:00 on three days of the month plus one on 1 October returns ONE bucket for hour 9, summing
the three September rows (3000 infeed, 2700 output) and excluding October's, denominated in the
OUTPUT unit with `dayStartHour: 7` so the browser can rotate the axis without a copy of
`SHIFT_WINDOWS`.

Two things this entry called correctly and one it did not mention:

- `hour_of_day` was already the GROUP BY key, exactly as `0006`'s column comment predicted.
- `ideal_out` did all the work on the non-additive rate. That column's own comment —
  "sum(ideal_out) is correct at any grain; avg(ideal_rate_per_hour) is not" — is the whole problem
  solved at the schema level.
- **The DENOMINATOR was the trap, and it is not in this entry.** `sum()` skips nulls, so
  `sum(ideal_out)` covers only the hours that had a standard while `sum(runtime)` covers all of
  them. Dividing one by the other spreads a known standard across unknown time and UNDERSTATES the
  target, which shrinks performance loss — the flattering direction. The query filters the
  denominator to the runtime that carried a standard; a mutation test confirms the naive form
  returns 60 where the truth is 120.

The additivity rules this entry records are now also enforced in
`apps/api/scripts/seed/0013_day_month_reports_dev.sql` and stated to the pipeline owner in
`docs/gold-write-contract.md` §15.5.

**What:** Put the hourly performance chart on the day and month reports, as the shift report now
has it. For a month that means an **hour-of-day profile** — 24 points, `GROUP BY hour_of_day` —
because a month of hourly rows is ~720 points and no line chart can show that.

**Why:** Asked for alongside the shift chart. It was designed for and deliberately not built,
because there is nowhere to put it: `apps/web/src/routes/_app/report/machine/by-day.tsx` and
`by-monthly.tsx` are **list screens with no detail route**, and the API has no day or month
endpoint at all — `oee.work_unit_day_reports` and `work_unit_month_reports` are defined in `0003`
but read by nothing.

**Context:** The expensive parts are already done, and doing them later would have been a migration
plus a backfill rather than a column in an unwritten model.

- `oee.product_perf_wu_hour` carries `business_date`, `shift` and `hour_of_day`, so all three
  grains are the same table filtered differently.
- `WorkUnitReportReaderRepository.listPerfHours(workUnitId, dateFrom, dateTo, shift?)` is already
  **grain-agnostic**: shift is one date plus a shift, day is one date with no shift, month is a
  date range with no shift. `ix_ppwuh_wu_day_shift` serves all three — verified as an index scan
  with no sort node. Day and month are therefore new _handlers_, not a new query.
- The additivity rules are what make a month rollup correct at all: `sum(total_out)`, `sum(runtime)`
  and `sum(ideal_out)` are summable, and the rates are recomputed from them. `avg(actual_rate_per_hour)`
  over 30 days is wrong and flatteringly so — 1333.3/h against a true 1024.4/h on the worked example
  in §3.5 of the contract. This is stated in `COMMENT ON` so a BI user meets it in the schema
  browser, not only here.

**Depends on / blocked by:** A day/month report **detail screen** and its API endpoint, neither of
which exists. Blocks nothing.

---

## 24. What the remaining Loss tab would actually read — **DONE (2026-08-24)**

**What:** Decide where the Losses page's "Others" breakdown comes from — before anyone estimates it
as one afternoon's UI work. Quality Loss, which this item was half about, is now shipped; see §29.

**Shipped (2026-08-24):** Others, and with it the last tab on the page — see §30. The blocker this
item carried was never engineering: it was the sentence "no one has said what it means". Somebody
has now. "Others" ranks **how many times each downtime reason occurred**, frequency
only, from a new immutable event log rather than from the editable `oee.downtime_reports`. It cost a
migration (`0009`), an endpoint and a contract section, which is what this item existed to say in
advance.

**Shipped (2026-08-19):** Schedule Loss. It was the one tab that genuinely was a rendering job, and
it cost no contract change: `apps/web/src/components/report/reason-pareto-card.tsx` (renamed from
`unplanned-pareto-card.tsx`) now takes a `category` prop and serves both Availability Loss and
Schedule Loss, with the per-category wording in `apps/web/src/lib/loss-category.ts` and the category
carried through the drill-down URL by `lib/reason-search.ts`.

**Shipped (2026-08-20):** Performance Loss, in the shape this item predicted — see §28. The
micro-stop half was one `TABS` entry against the generalised card; the reduce-speed half is stated
as a total beside it, because that is what the data supports.

**Shipped (2026-08-20):** Quality Loss — see §29. This is the one this item priced correctly and the
only loss tab that genuinely needed a migration: `0008_oee_reject_count_wu_shift.sql` adds the
defect-reason table the row below said it required, and `docs/gold-write-contract.md` §3.8 and §10
are the ask that fills it. **The table ships empty**, so the tab renders "not loaded yet" until the
DAG runs — which is the same trade `0007` made and the reason the watermark row matters more on that
endpoint than on any other.

**Why:** `apps/web/src/routes/_app/report/machine/by-shift_.$reportId_.losses.tsx` renders five
tabs and now fills four. The tab bar made the empty ones look like a rendering job. They were not,
and the gap was in Gold rather than in the browser:

| Tab                   | Source                                                                                           | Cost                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **Availability Loss** | `oee.downtime_reports`, `category = 'UNPLANNED'`                                                 | shipped                                          |
| **Schedule Loss**     | the same endpoint with `category=PLANNED`                                                        | shipped                                          |
| **Performance Loss**  | `category=SMALL_STOP` for the micro-stop half; `reduce_speed_loss_time` for the rest, as a total | shipped, half of it as a figure                  |
| **Quality Loss**      | `oee.reject_count_wu_shift`, added by `0008` — one row per reject counter                        | shipped; **table empty** until the DAG writes it |
| **Others**            | `oee.downtime_log_events`, added by `0009` — one row per logged stop, `reasons text[]`           | shipped; **table empty** until the DAG writes it |

**Context:** `category` was made a query parameter on `GET /api/v1/downtimes/by-reason`, defaulting
to `UNPLANNED`, precisely so Schedule Loss would cost no contract change. It did not: shipping that
tab touched no API file and no migration, and neither did Performance Loss after it. The narrowing
that does bite is `scope`: see §25.

Two predictions this item made were both borne out. Performance Loss's micro-stop half really was
"a `TABS` entry plus a reviewed sentence rather than a component" — the sentence was already
written, in `LOSS_CATEGORY_COPY.SMALL_STOP`. And the warning that "the tab would show half of the
factor it is named after" is why it does not claim otherwise: the Reduce Speed half is named, given
its total, and says on screen that it has no per-cause records to rank.

The other note this item carried — that Performance Loss "already has a drill-down of a different
shape, the hourly production chart behind the Losses card's `View` button, so the tab would need to
say how it differs rather than duplicating it" — is answered. It does not differ: the chart IS the
tab's Trendline view, rendered from the same body the dialog renders.

**Depends on / blocked by:** nothing. Both remaining halves landed the same way. Quality Loss needed
a defect-reason table in Gold and a decision about what a defect reason even is — the table in
`0008`, the decision in §29 (a reject reason is a PLC counter tag, carrying an optional master-data
reason beside it). Others needed an event log and a decision about what an occurrence even is — the
table in `0009`, the decision in §30 (an occurrence is one stop citing one reason, counted once per
stop). **Populating** both tables is still the DAG owner's (§18).

---

## 25. Widening `/downtimes/by-reason` past work-unit scope — **DONE (line 2026-08-31, area 2026-09-10)**

> **All four changes landed with the LINE grain and the AREA grain is the first caller they were
> built for.** `limit` (capped at 100, defaulting to 20) and `measure` are on the schema; the
> "Other" tail is derived in `getReasonBreakdown` from `groupCount` against `buckets.length`, over
> the SAME totals the cumulative line divides by rather than a third query; the drill-down has
> always been server-paged. `SCOPE_COLUMN` now maps `work-unit`, `work-center` and `area`; only
> `factory` is refused, and only because there is no column to map.
>
> **THE WIDEST WINDOW ANY SCREEN NOW ASKS FOR IS AN AREA-MONTH** — the Area By Monthly Losses page,
> shipped 2026-09-10 — and it is **still unmeasured against real data**. The 2799 ms figure below
> belongs to a plant-YEAR, which nothing serves; an area-month is between that and the line-day
> shape that was measured. The four changes hold it in principle (a LIMIT of 20, the "Other" tail,
> server-side ranking, a paged drill-down), and this is the one shape worth putting a number on
> before a factory-year screen exists.
>
> The rest of this entry is kept below as the record of why the narrowing existed —
> unedited, because the reasoning is what makes the four changes read as one change
> rather than four.

> The Line report DETAIL screen shipped on 2026-08-31 (§52) and its Losses half is waiting on this
> item specifically. Work-center scope is already reachable — `SCOPE_COLUMN` maps it and the timeline
> uses it — so the blocker is cost, not capability: a line window unions EVERY machine's stops, and
> this endpoint is unpaged.
>
> **The TIMELINE at line-day scope was measured before shipping, and is not the problem.**
> `listOverlapping` at `scope=work-center` over a 24-hour window, postgres:18-alpine, median of five
> runs after a warm-up:
>
> | fixture                 | rows returned | median |
> | ----------------------- | ------------- | ------ |
> | 1 machine × 40 stops    | 40            | 0.6 ms |
> | 4 machines × 40 stops   | 160           | 0.7 ms |
> | 10 machines × 40 stops  | 400           | 1.3 ms |
> | 10 machines × 120 stops | 1200          | 2.4 ms |
>
> The last row is well past a realistic line-day. Two caveats before this number is reused: it was
> taken against a table holding only the fixture, so it measures the QUERY SHAPE and the merge at a
> realistic row count rather than the planner's behaviour on a plant-year table; and it says nothing
> about `/downtimes/by-reason`, which is a different, UNPAGED aggregate and is what the 2799 ms
> figure below belongs to. Re-measure that one separately against real data.

**What:** Before serving a line-, area- or factory-level Pareto from
`GET /api/v1/downtimes/by-reason`, add a server-side `LIMIT`, an "Other" tail bucket, server-side
sorting and server-side paging — together, not one at a time.

**Why:** `reasonBreakdownInputSchema` narrows `scope` to `work-unit` alone, unlike its two siblings
on the same router. That is not an oversight and the schema says so: the endpoint is **unpaged** and
the browser holds the entire response. At work-unit grain that is bounded by construction — one
machine, one eight-hour shift, a handful of distinct reasons. At line grain it is not bounded by
anything, and `docs/gold-write-contract.md` §8 measured the wide version of this query at **2799 ms**
for a plant-year.

**Context:** The four changes are one change because each is wrong without the others:

- A `LIMIT` alone would silently truncate the Pareto. `totalFrequency` / `totalDurationMs` already
  ride on the response precisely so the browser's cumulative line keeps dividing by the true total
  when that day comes — `lib/pareto.ts` divides by them and not by the sum of its bars, and
  `pareto.test.ts` pins that.
- An "Other" bucket is what makes the truncation visible instead of a missing tail.
- Sorting has to move server-side once the browser no longer holds every row, which also means the
  measure toggle stops being free — today it is a `reduce` over ten numbers with no round trip, and
  `reason-pareto-card.test.tsx` asserts it issues no second request.
- The table's paging is client-side for the same reason and would move with it.

`SCOPE_COLUMN` in `downtime.ts` already maps `work-center`, so the query itself needs no work — this
is entirely about what happens to the response. `getDowntimeReasonGroupsHistogram` (`downtime_reason_groups`)
is the instrument that says when work-unit grain stops being small.

**Depends on / blocked by:** A line- or area-level Losses screen, which does not exist. Nothing
depends on this.

---

## 26. Flip `autoCodeSplitting` — **DONE (2026-08-25), BUT NOT AS THIS ITEM DESCRIBED IT**

**Shipped:** `autoCodeSplitting: true`. The entry chunk went from **804.45 kB → 395.11 kB** raw and
**241.55 kB → 118.60 kB** gzipped, with per-route chunks for `_app`, `by-shift`, the detail report,
the Losses page and its drill-down. rolldown-vite handles it — that was the stated blocker and it
turned out not to be one.

**THE FIVE MANUAL SPLITS ARE STILL THERE, AND THIS ITEM WAS WRONG ABOUT THAT.** It said flipping the
flag "should retire all four" (five by the time anyone did it). It does not. Deleting them:

|                         | entry chunk                  | `CartesianChart`                  |
| ----------------------- | ---------------------------- | --------------------------------- |
| before, flag off        | 804.45 kB (241.55 kB gz)     | separate, 336 kB                  |
| flag on, splits kept    | **395.11 kB (118.60 kB gz)** | separate, 336 kB                  |
| flag on, splits deleted | 781.26 kB (229.27 kB gz)     | **gone — hoisted into the entry** |

**The mechanism, which is the part worth keeping.** Route-level splitting alone does not keep recharts
out of the entry chunk, because a module reachable from SEVERAL async chunks is lifted to their common
ancestor — and the chart cards live in three different route chunks (the detail report, the Losses
page, the per-reason drill-down), whose common ancestor is the entry. The `lazy()` boundaries are what
give recharts an async chunk of its own. The two mechanisms are **complementary, not redundant**, and
the comment in each of the five now says that rather than blaming the flag.

**Verified, not inferred.** `/login`'s `index.html` preloads eleven chunks and none of them is
`CartesianChart` or any chart chunk; the entry chunk contains **zero** recharts symbols; every
referenced asset resolves 200 from a static server; `routeTree.gen.ts` is unchanged, which is what CI
asserts.

**This item mis-stated its own baseline four times** — 692 kB, then 720.5 kB, then 739.21 kB, then
787.68 kB — each written down and then trusted. The measurement at the top of this entry was taken
immediately before the change, on the branch that made it, and includes the downtime-edit UI. It will
drift too. **Re-measure with `pnpm --filter web exec vp build`; do not trust the table above.**

**What this leaves open.** `select-*.js` is 89.4 kB and `createLucideIcon-*.js` is 77.1 kB, both now
visible as their own chunks and both loaded by `/login` — together roughly 42 % of the reduced entry
chunk. Neither was worth looking at while recharts dominated the number. Not filed as its own item
because nothing on screen is slow; noted because the next person to measure will see them first.

---

## 31. Auto-close shift reports older than 14 days

**What:** Close any shift report still `open` more than 14 days after its shift, without a person
doing it. The scheduling technology is **undecided** — pg_cron, a Kubernetes CronJob, or a task on
the existing Airflow instance are all plausible.

**Why:** Approval is a sign-off, and a report nobody ever approves stays `open` forever. Without a
sweeper the By Shift list accumulates an ever-growing tail of stale open reports, and "what still
needs approving" — the question §36's filter exists to answer — stops meaning anything.

**Context:** **The schema is already ready and needs no migration.**
`0010_oee_shift_report_approvals.sql` reserved exactly this case:

- `source` is `'operator' | 'system'`. A swept report is `'system'`.
- `closed_by` is **nullable**, and `ck_wusra_system` _requires_ it to be NULL when
  `source = 'system'` — so the sweeper has no fictional user to invent. `ck_wusra_operator` is the
  mirror image, so the two cannot be confused.
- `status` stays `'open' | 'closed'`. There is deliberately **no** `'auto_closed'` state: an
  auto-closed report is closed in every way a reader cares about, and a third value would force
  every query to write `status IN ('closed','auto_closed')` — the first one to forget would
  silently under-count. Provenance lives in `source`, which nothing needs in a `WHERE`.

The write is one upsert per report, the same shape as
`WorkUnitReportWriterRepository.closeShiftReport` but with `source = 'system'` and a NULL subject,
plus its `work_unit_shift_report_approval_events` row in the same transaction.

Three decisions to make before writing it:

1. **Where "14 days" is measured from.** `work_unit_shift_reports.date` is a shift-START INSTANT,
   so `now() - date > interval '14 days'` is correct without a zone conversion. Do not reach for
   the business day here; §17's missing column is not needed.
2. **Whether it runs inside this service or outside it.** If outside (pg_cron / Airflow), it writes
   Gold directly and `docs/gold-write-contract.md` §1 needs a third writer row — a real change to a
   normative document. If inside, it reuses `asOperator()` and shows up in `oee.write_audit`
   correctly for free, but this service has no scheduler today.
3. **Whether an auto-closed report is announced.** Nothing notifies anyone today.

**Depends on / blocked by:** A decision on (2), which is an infrastructure question rather than a
code one. Nothing technical.

---

## 32. There is no audit trail for defects and quality issues

**What:** Give the Log Activity panel its third arm. Today it reports the quality source as
permanently untracked (`untrackedReason: "no-source"`), and that is honest rather than temporary.

**Why:** The panel exists to answer "what happened to this shift report", and it currently cannot
speak for reject and rework at all. Approvals and downtime edits are covered; defects are the hole.

**Context: this is NOT a grain problem, and the brief that requested it assumed it was.** The
assumption was that reject/rework capture is "limited to work center or production line reports".
In _this_ database it is not — every reject-bearing table is keyed on the work unit:

| Table                     | Key                                                     |
| ------------------------- | ------------------------------------------------------- |
| `work_unit_shift_reports` | `reject` / `rework` scalars, work unit × shift          |
| `product_count_wu_shift`  | `(work_unit_id, shift_date, shift, product_id)`         |
| `reject_count_wu_shift`   | `(work_unit_id, shift_date, shift, product_id, reason)` |

`work_center_id` on `reject_count_wu_shift` is a **nullable denormalised label** — `0008` says so
explicitly — and there is no `line` concept anywhere: the hierarchy is factory → area →
work-center → work-unit, and `SCOPE_COLUMN` accepts only the last two.

**The actual blocker is that nothing edits any of them.** All three tables are ETL-written, and
this service has no mutation targeting them, so there is no edit to audit.
`oee.downtime_report_history` exists because editing a downtime is a _named operator mutation_
(contract §1 rule 2); nothing equivalent is defined for a defect. So the work is not "re-grain the
data", it is:

1. **A product decision first:** what does an operator actually change about a defect? Reclassify a
   reject reason? Correct a count? Add a note? Until that is answered there is nothing to design.
2. Then a new operator-mutable record plus its history table, modelled on `0007`'s pair.
3. Then the write path, and only then does this arm have anything to report.

Where the "not tracked" copy lives when it changes: `NOT_TRACKED_BODY["no-source"]` in
`apps/web/src/lib/activity.ts`, and `QUALITY_SOURCE` in `work-unit-service.ts`.

**Depends on / blocked by:** (1) — a product decision, not a schema one. If reject capture in the
wider MES really does happen at line level, that is a **separate integration question** about
whether those edits should reach this database at all.

---

## 33. `POST /work-units/shift-reports/:id/reopen` — **DONE (2026-08-25)**

**Shipped** with the downtime edit, and it arrived then rather than on its own merits: §37's freeze
means editing a stop on an approved report is refused, so without a reopen an operator who spots a
real mistake on a signed-off report had no path at all. A freeze with no escape hatch is a trap
rather than a control.

**No migration, exactly as this item predicted.** `ck_wusra_open` already required a reopened row to
clear all four closure columns — so getting that wrong is a constraint violation rather than a stale
approver quietly surviving — and `work_unit_shift_report_approval_events` already recorded
`from_status`, so the Log Activity panel renders a reopen with no change at all.

**One thing this item got wrong:** it said the write is "`closeShiftReport` mirrored" with the same
`ON CONFLICT`. It is an `UPDATE`, not an upsert. Absence of a row IS the open state (`0010`), so
there is nothing to insert — a report with no approval row is already open. That collapses "the row
says open" and "there is no row" into one `already_open` outcome, which is correct rather than a
compromise: both mean "this was not closed", which is the only thing a 409 here has to say.

**Shipped ungated, and that is a recorded choice rather than an oversight.** "Anyone may approve" is
defensible; "anyone may undo somebody else's sign-off" is a different claim. §34 holds the gate and
now covers both routes. The alternative was to block the downtime edit on a Keycloak role that does
not exist yet, which would have shipped the freeze with no way out.

---

## 34. Role-gate the three operator mutations — **MECHANISM DONE (2026-08-26), NOT YET ENABLED**

**Shipped:** `requireRole` in `shared/actor.ts`, `Actor.roles` read from `realm_access.roles`, three
optional variables — `APPROVE_ROLE`, `REOPEN_ROLE`, `EDIT_DOWNTIME_ROLE` — and a check at the top of
`approveShiftReport`, `reopenShiftReport` and `editDowntime`. All three unset by default, which
reproduces the previous behaviour exactly.

**THREE VARIABLES, WHICH IS THE OPPOSITE OF WHAT THIS ENTRY CONCLUDED.** It said: "One is simpler and
probably right; three invites a permissions matrix nobody asked for." Overruled, and the entry's own
AMENDED section is the argument — it spends three bullets establishing that the mutations are _not
equally defensible_, that approving is a sign-off, that reopening **undoes somebody else's**
sign-off, and that those "are not the same act". A single role forces them to be the same act, in
code, permanently.

The asymmetry is what settles it. Three variables can express one policy — set them to the same role
— but one variable can never express three. So the collapsed version is strictly less capable at
identical cost, and it decides a permissions question that belongs to whoever administers the realm.
It is also not a matrix: three independent switches of identical shape, each defaulting to off.

**`realm_access.roles`, and this entry was right for a better reason than it gave.** It said
`resource_access` "would hard-code a client id into the API". True, and the sharper point found while
building it: the only client id this service holds is `OIDC_CLIENT_ID`, consumed at exactly one site
(`infra-module.ts`, `createServiceTokenProvider`) as **its own service account** for calling
master-data — `.env.example` says outright "It must be THIS service's own client — not the callee's".
An operator's browser token is issued to the BFF's client, so `resource_access[oidc.clientId]` is
absent on every real request and the gate would have refused **everyone**. The naive implementation
looks correct and is the exact failure this entry was written to avoid.

**A ROLLOUT ALARM SHIPPED WITH IT, because this entry's stated risk was "it would be discovered in
production".** `operator_authorization_denials_total{action}` counts refusals and
`operator_authorization_grants_total{action}` counts gated successes, with two rules in
`prometheus-alerts.yml`. The failure is quiet by construction: a wrong role name breaks only the
three write paths, so every read works, every page renders, the numbers are right, and an operator
finds out at the end of a shift when Approve starts returning 403.

**The grants counter exists because the obvious alert was silently wrong.** Expressing "refused and
nothing succeeded" needs a success signal carrying the same `action` label, and no existing metric
has one — `shift_report_transitions_total` is `{to, source}`, `downtime_edits_total` is `{field}`.
`sum by (action)` over either yields a series with **no** `action` label, which cancels nothing.
Verified against a live Prometheus rather than reasoned about:
`label_replace(vector(1),"action","approve","","") unless on (action) vector(1)` returns the series.
The first version of that rule would therefore have fired **critical on every ordinary denial** while
reading perfectly sensibly in review.

**The browser still cannot help, and that is unchanged.** `/api/me` returns `{ sub,
preferredUsername, email }` and no roles, so the button cannot be hidden client-side; a 403 surfaces
in the dialog, which already has copy for it. Extending `/api/me` with roles touches the BFF, the
`Me` type and `useMe`, and is only worth doing if the UI should _hide_ the action rather than refuse
it.

**Still owing — this is DONE as a mechanism and OFF as a policy:**

1. **Someone must create the roles in Keycloak** and confirm they land in `realm_access.roles` on a
   real operator token. That was this entry's whole stated risk and it has not moved.
2. **If the realm defines them as CLIENT roles instead**, this needs a new variable naming the
   browser-facing client — a known question with a known answer, to be asked _before_ setting
   anything rather than discovered afterwards.
3. **Roll out one variable at a time**: set one, have a real operator exercise that one route, watch
   `operator_authorization_denials_total{action=...}`, then set the next. Rollback is unsetting it.
   `.env.example` carries this as the instruction.

**Depends on / blocked by:** nothing, for the code. Enabling any gate is blocked on the Keycloak role
existing and its claim location being confirmed.

---

## 35. Nothing prunes `oee.write_audit` — **DONE (2026-08-26)**

**Shipped:** `0012_oee_write_audit_partitioned.sql` — `oee.write_audit` partitioned by RANGE on
`at`, one partition per month, plus `oee.prune_write_audit(retain_months int DEFAULT 12)` which
drops whole partitions and returns what it dropped with a row count.

**Both open questions were answered, and QUESTION 1 WAS ANSWERED THE OPPOSITE WAY TO THIS ENTRY'S
OWN SUGGESTION.** It proposed keeping `application_name = 'mes-oee-monitor-operator'` rows
indefinitely. That was decided against on a fact this entry had not noticed: **those rows are not
the durable record, and never were.** The permanent operator trail is
`work_unit_shift_report_approval_events` (`by_subject`, `by_name`, `from_status`, `to_status`) and
`downtime_report_history` (`changed_by`, `field`, `old_value`, `new_value`) — both append-only, both
pruned by nothing, both carrying strictly more than `write_audit` does. `write_audit` records that
the operator ROLE touched a row; those two record who changed which field from what to what.

So retention is **twelve months for every writer**, and what `write_audit` is left being is what
`0004` built it for: "which database user wrote this, from where", asked during an incident.

**The exemption was also not merely unnecessary — it was expensive.** A partition is dropped
WHOLESALE, so rows inside one cannot be spared. Honouring the exemption structurally needs
`LIST (writer_kind) -> RANGE (at)` sub-partitioning, a new `NOT NULL` column for the trigger to
populate, and a three-column primary key. Verified against Postgres 18 that this works — and also
that the two cheaper spellings do not: a generated column is rejected as a partition key
("Column ... is a generated column"), and `application_name` cannot be one while a primary key
exists because it is nullable.

**Question 2 — partition, and the primary key had to change with it.**

    ERROR:  unique constraint on partitioned table must include all partitioning columns
    DETAIL: PRIMARY KEY constraint on table "write_audit" lacks column "at" ...

`PRIMARY KEY (id)` is now `PRIMARY KEY (id, at)`. `id` is still globally unique in practice — one
bigserial serves every partition — but the DATABASE now only guarantees the pair. Nothing joins to
this table and nothing in this repo reads it, so that is a statement about the constraint rather
than about the data.

**THE FAILURE MODE THE FILE IS SHAPED AROUND, and the reason a DEFAULT partition is not optional.**
A partitioned table _rejects_ an insert with no matching partition, and `0004`/`0006`/`0007`/`0008`/
`0009`/`0010` between them attached a trigger pair to **twelve** tables. A missing month would
therefore not degrade the audit log — it would **fail every write to Gold**, the pipeline's nightly
loads included. `0012` creates thirteen months back, twelve forward, and a DEFAULT partition that
converts an uncovered month from an outage into rows filed in the wrong place.
`defaults to DEFAULT rather than raising` in `write-audit.integration.test.ts` is the assertion that
pins it, and it is the highest-consequence line in that file.

**One residual, with a helper to make it visible:** Postgres refuses to attach a partition whose
range overlaps rows already in DEFAULT, so letting rows collect there turns a future
`CREATE TABLE ... PARTITION OF` into a data move. `oee.write_audit_default_backlog()` reports which
months are sitting there; empty is the expected state, and an integration test proves the attach
really is refused rather than taking the documentation's word for it.

**The migration was proven on the incremental path, not just a fresh database** — which is the one
that matters, since this applies to a populated table. Rows keep their ids, route into the correct
month, the legacy table is dropped, and `setval` advances the sequence past the copied ids so the
next insert does not collide. All inside one transaction, so a concurrent audited write blocks on
the rename's lock and then proceeds against the new table.

**Still owing, and it is the whole point of the retention window:** `pg_cron` is **not installed**
on the Gold cluster — nor is `pg_partman`, and `webadmin` is a superuser, so this is a genuine
absence rather than a permissions problem. Nothing runs `prune_write_audit()` on a schedule yet, so
until it is installed somebody runs it by hand and the consequence of forgetting is a table that
grows without bound: slow, not dangerous. Requested in contract §6.1, bundled with the database-roles
ask because it goes to the same administrator.

**Depends on / blocked by:** the scheduled prune is blocked on `pg_cron` being installed. The
partitioning itself is done.

---

## 36. A server-side `status` filter on the By Shift list — **DONE (2026-08-25)**

**Shipped:** `GET /work-units/shift-reports?status=open|closed`, and an "All Statuses / Needs
approval / Approved" select beside the shift and line filters. Absent means both.

**THIS ENTRY'S HAZARD WAS ACCURATE, AND IT WAS DEMONSTRATED RATHER THAN ASSUMED.** The filter has to
correlate a subquery against the report row, which forces the alias this entry warned about. With the
alias in place, `periodFilter`'s month-only branch — which qualified with the FULL TABLE NAME,
`work_unit_shift_reports.date` — is not merely ambiguous but outright rejected: "invalid reference to
FROM-clause entry".

So the aliasing pass went through `periodFilter` (all three branches), `shiftSql`, `workUnitSql`,
`hideZeroSql`, both SELECT lists, the `ORDER BY` and `count()`. Then the guard was checked by
REINTRODUCING the bug: with the full-table-name spelling restored, **the unit suite passed 90/90 and
the integration suite caught it**. That is this entry's claim about `fakeSql`, verified — worth the
two minutes, because it is the only evidence the new tests have teeth.

**The polarity is enforced by an integration test, not by a comment.** `status=open` is
`NOT EXISTS (... status = 'closed')`. The tempting `EXISTS (... status = 'open')` reads correctly,
passes review, and hides every report nobody has ever touched — which is nearly all of them, since
`0010`'s rule is that the ABSENCE of a row means open. Its failure mode is a SHORTER list, not an
error. `treats a report with NO approval row as open` is the assertion that pins it, and it fails
under the wrong spelling.

**EXISTS rather than a LEFT JOIN with `a.status IS NULL`:** a semi-join cannot duplicate a report row
even if the approvals table ever grew a second row per key, which keeps `count(r.id)` honest without a
DISTINCT.

**Two comments elsewhere had to be CORRECTED rather than deleted**, because both stated that the alias
hazard was unpaid and gave it as the reason `listApprovalsForPage` is a second query. It is paid now.
What keeps that a second query is a weaker argument and a trade rather than a hazard: one ~0.5 ms
round trip against a benchmarked 0.8 ms one, and filtering is a semi-join that selects no columns
while displaying needs the values. Folding it in became possible with this change; nothing is asking
for it.

**The label wording is deliberate.** "Needs approval" and "Approved", not "Open" and "Closed" — a
supervisor reading this list is asking what still needs signing off, and `closed` is a state name
rather than an answer to that question.

**Not browser-verified.** The web half is a `Select` wired to a URL search param, following the exact
pattern of the four filters beside it, none of which have component tests either. The correctness risk
is in the SQL, and that has 13 integration cases.

---

## 37. Approving a report does not actually freeze it — **DECIDED AND ENFORCED (2026-08-25)**

**The decision: a closed report's downtime may NOT be edited.** The edit endpoint checks the
approvals table and answers 409, naming the shift that is approved. Approving therefore means "this
is final", not "somebody looked at it".

**Made before the endpoint shipped, which is what this item asked for.** Retrofitting a freeze onto
an endpoint people already use is much harder than shipping it with one, and the alternative branch —
document in contract §1 that approval is not a freeze — was available right up to the point the route
was written.

**It made §33 load-bearing, and that is why reopen shipped the same day.** Correcting a real mistake
on a signed-off report now REQUIRES reopen → edit → re-approve, and all three transitions are in the
trail. That is arguably the point of having an approval at all.

**The part that was not in this item's framing, and mattered more than the decision itself.** "The
report a stop belongs to" is not a single report: a stop straddling 23:00 belongs to BOTH shifts it
touches, so the check consults every report the stop overlaps and refuses if any is closed. Reading
only the stop's own `(work_unit_id, date, shift)` would have satisfied this item's wording exactly
and still let an edit silently move a signed-off shift's numbers. See §21.

**One residual, deliberately accepted and now §41:** an unfinished stop is treated as reaching only
`MAX_OPEN_DOWNTIME_DAYS` forward rather than forever, so an approval further out than that will not
freeze it.

---

## 38. Ask the pipeline to recalculate one report after a category edit

**What:** A durable request channel from this service to Airflow, so a `category` edit can have that
one shift report's aggregates rebuilt in minutes rather than waiting up to eight hours for the next
scheduled run.

**Why:** Changing a stop's `category` moves time between schedule loss and availability loss. Those
totals live precomputed in `oee.work_unit_shift_reports`, so the report's OEE / A / P / Q tiles, its
timeline strip and its waterfall keep showing the pre-edit split until the pipeline recomputes them.
The reasons and the Paretos are read live and are already correct — this is the one field of the four
that leaves anything stale (§21).

Today the browser states it and waits: `GET /shift-reports/:id/metrics-staleness` reports when a
category was last edited, and `StaleMetricsBanner` names which cards are affected and which are
current. **That banner cannot clear itself, and that is the visible cost of this item.** Per-report
confirmation is not knowable without a request channel, and the obvious substitute is wrong in the
flattering direction: `oee.etl_watermarks.last_run_at` is TABLE-grained, so a run covering other days
advances it past the edit without recomputing this report — the banner would vanish while the tiles
were still stale. So it stays on screen indefinitely. Somebody will eventually ask why.

**Context: the shape is designed and written down, and deliberately not built.**
`docs/downtime-edit-trd.md` §4 carries it in full as a clearly-marked PROPOSAL, with the four
questions the DAG owner has to answer first. In outline:

- `oee.downtime_recalc_requests`, owned outright by this service, keyed on `(work_unit_id, date,
shift)` — the columns of `wu_shift_report_key`, for `0010`'s reason — written in the edit's
  transaction, and only when `category` actually changed.
- A **partial unique index on `(work_unit_id, date, shift) WHERE status = 'pending'`** is the
  coalescing mechanism: five edits to one shift queue ONE recalculation, enforced by the database
  rather than by application logic. `WHERE status = 'pending'` and not `IN ('pending','claimed')`,
  because an in-flight run cannot include an edit made after it started.
- Airflow claims with `FOR UPDATE SKIP LOCKED`, recomputes, writes back `succeeded` / `failed`.
  `status` + `attempts` IS the dead-letter queue; a reaper returns rows stuck in `claimed`. The
  status write-back IS the completion signal, so nothing has to publish anything and this service
  needs no consumer, no worker and no new deployment unit.
- Do NOT extend `ck_etl_watermarks_table` for it — leaving it alone is the mechanical version of
  "this table is not yours to model", exactly as `0010` did.

**A Kafka broker DOES exist on the Bronze/Silver side, and an outbox is still the recommendation.**
The only consumer is Airflow, which already holds a direct connection to Gold; a topic would add a
consumer group, offset management and a second topic to carry completion, to deliver one fact that a
`status` column delivers for free at a rate of a handful of edits a day. It is also not a dead end —
the outbox row is exactly the seam a publisher would read if a second consumer ever appeared. The
honest counter-argument, recorded in the TRD: polling is a DAG somebody has to own and monitor, and
if the DAG owner would rather consume a topic they already operate, that is a legitimate reason to
prefer Kafka.

The UI half is a per-report queue sheet (mirroring `activity-log-sheet.tsx`), a banner that reflects
`pending` / `failed`, and a `refetchInterval` on the report query while a request is outstanding.
`GET /shift-reports/:id/metrics-staleness` already exists and is the natural place for the status to
land, which is one of the reasons it is its own endpoint rather than a field on the report.

**Depends on / blocked by:** Agreement with the DAG owner on the four questions in the TRD — chiefly
whether a recalculation can be scoped to one `(work_unit_id, date, shift)` or only to a whole day,
which changes the table's grain. Also §35's problem in miniature: nothing would prune this table
either.

---

## 39. Grafana, and the alert rules `metrics.ts` has been describing all along — **DONE (2026-08-25)**

**Shipped:** `prometheus-alerts.yml` (12 rules in 4 groups), a Grafana service in
`docker-compose.yml` on port 3005, provisioned datasource and dashboard under `grafana/`, and a
README section. The `// Alert on:` comments in `apps/api/src/shared/observability/metrics.ts` are now
real rules instead of prose in code comments.

**THE METRIC NAMES WERE READ OFF THE COLLECTOR, NOT GUESSED, and that changed one of them.** Metrics
reach Prometheus through the OTel Collector's `prometheus` exporter, which rewrites names. Emitting
one sample of each of the 18 instruments and reading `:8889/metrics` settled two things:

- **Counters pass through unchanged.** `downtime_edits_total` stays `downtime_edits_total` — the
  exporter does not append a second `_total` to a name that already ends in one. That was the risk
  worth checking, and the existing annotations were correct.
- **Histograms become three series** — `_bucket`, `_count`, `_sum`. So
  `histogram_quantile(0.99, downtime_reason_groups)`, which this file had carried since the
  histogram was added, **was never runnable PromQL**: a quantile needs the bucket vector grouped by
  `le`. Corrected in `metrics.ts` and in the rule.

That is the entry's own point turned back on itself. An alerting design that lives only in comments
is not merely unimplemented — it is unverified, and one of the eight expressions did not work.

**Verified rather than assumed, at four levels:** `promtool check rules` passes; Prometheus loads all
4 groups; all 12 expressions execute against the live API; every metric the rules name is present in
Prometheus's `__name__` index; and a panel query returns data through Grafana's own datasource proxy.

**Two decisions worth keeping.** The datasource is provisioned with an **explicit `uid: prometheus`**
and the dashboard references it directly rather than through a `${DS_PROMETHEUS}` template variable —
without a fixed uid Grafana generates a random one per install and every panel renders "Datasource
not found" until somebody picks it from a dropdown, which a provisioned dashboard should never
require. And `allowUiUpdates: false`, because a dashboard edited by clicking is lost on the next
restart and is not reviewable.

**Deliberately not done: Alertmanager.** Prometheus evaluates the rules and the Alerts tab shows
them firing, but nothing routes them anywhere. Where an alert should actually go — email, Slack, a
pager — is an organisational decision, not a technical one, and wiring a receiver nobody reads would
be worse than the current state where somebody has to look. **Filed as §42.**

**One caveat on the compose stack:** anonymous admin, no login form. Fine for a local development
stack, and stated in both the compose file and the README, but this repo has no deployment manifest
and anything derived from that file for a real environment must put auth back.

---

## 40. `oee.downtime_reports.reason` has no database-level guard — **DONE (2026-08-25)**

**Shipped:** `0011_oee_downtime_reason_shape.sql` — `oee.jsonb_is_label_array(jsonb, int)` plus
`ck_downtime_reports_reason`, `ck_downtime_reports_actions` and
`ck_downtime_reports_detail_reason`. Documented for the pipeline as contract §14.

**Surveyed first, which is the only reason it was safe.** All 17 rows passed: no non-array values, no
non-string elements, no blank or untrimmed entries, no duplicates within a row, nothing over 255
characters, longest array 3 elements, `detail_reason` set on 2 rows at 6 characters. A CHECK added to
a populated column validates existing rows, so a migration that fails against real data would have
been worse than the missing constraint.

**A jsonb function was needed, as the pre-work predicted.** `ck_dtle_reasons` leans on
`oee.text_array_has_blank(text[])` and `reason` is jsonb — and there is no direct `jsonb -> text[]`
cast, while going via `ARRAY(SELECT jsonb_array_elements_text(v))` is a subquery, which a CHECK admits
nowhere. It would also coerce a non-string element to its JSON text, which is the case being rejected.

**Half the specification is what it must TOLERATE, and that half was the easy one to get wrong.**
Duplicates and case variants are accepted, because contract §3.9 says the reader "trims but does not
case-fold" and a duplicate "counts once". Rejecting either would make a PIPELINE write fail where the
reader is specified to cope — a contract change dressed as a constraint. Empty arrays and a NULL
`detail_reason` are accepted too, the first being the unlabelled Pareto bucket and the second being
what "the operator cleared this" looks like.

**It closes the permanently-uneditable bug, and only a constraint could.** A non-string element did
not merely mis-group a bar: `toStringList` drops it on read, so the row comes back as `[]`, the
browser sends `[]` as its concurrency baseline, `reason = '[]'::jsonb` matches nothing, and every edit
412s telling the operator the pipeline reloaded the stop. The round trip through the read path loses
the original, so no guard in the write path could recover it.

**Four existing reader tests had to be reckoned with, and that was the interesting part.** They
deliberately insert blank, whitespace-only and non-string elements to prove the reader folds them into
the unlabelled bucket — shapes the constraint now refuses. They are KEPT, behind a
`withoutShapeChecks` helper that suspends the constraint and restores it `NOT VALID` in a `finally`,
because the reader's tolerance still guards data written before `0011` and is what stopped those
shapes being a visible bug while the column was unconstrained. Defence in depth, with the bypass
scoped so it cannot quietly become permanent.

**It changes the pipeline's failure mode, so the contract had to say so.** A malformed label is now an
aborted statement rather than a mis-grouped bar. That is deliberately the trade §3.9 already made for
`downtime_log_events.reasons` — no `DEFAULT`, so "a forgetful model fails the load" — and what §3.3
asks for on this table: "rejecting at the source beats counting." §14 states it, and the residual is
in Open risks: it moves a rendering defect into the load path, for a DAG with no repository in which
to review the model that would hit it.

**Still true: contract §3.3.1 would make all of this unnecessary at once** — the constraint, the
reader's defensive normalisation and the bypass helper — by replacing the jsonb array with an
indexable `primary_reason text` column. §14 asks the DAG owner whether that is on the roadmap, since
it would make this throwaway work rather than a foundation.

---

## 41. A long-open stop can escape the downtime-edit freeze — **HALF CLOSED (2026-09-02)**

> **THE READ PATHS ARE UNBOUNDED NOW; THE FREEZE CHECK IS NOT.** §69 deleted the
> `date` narrowing from `scopeAndWindow` and `shiftStops`, so a three-week-old open
> stop is once again visible on every strip, Pareto and frequency count that should
> contain it. That is the half of this entry described as "the real fix is §10".
>
> **WHAT IS STILL OPEN IS THE INVERSE HOLE, AND IT DID NOT MOVE.**
> `listApprovalsOverlapping` bounds an open stop's span with
> `coalesce(endAt, startAt + MAX_OPEN_DOWNTIME_DAYS)`, and that is NOT the same
> problem wearing the same constant:
>
> - it queries `oee.work_unit_shift_reports`, which has **no GiST span index** —
>   `dt_reports_span_gist` is on the downtime table and cannot help here;
> - it is a **correctness** bound, not a sargability one. Removing it means an open
>   stop overlaps every later shift, so one approval anywhere freezes it forever —
>   which this entry already argues is unusable, and is why the current bound was
>   chosen knowingly as the lesser of two errors.
>
> So the remaining work is a **product decision** about how long an unfinished stop
> should stay editable, plus whatever index that decision implies. It is no longer
> waiting on §10.

**What:** Decide whether an unfinished downtime should be frozen by an approval on a shift arbitrarily
far in the future, and if so, make that affordable.

**Why:** Editing a stop is refused if any shift report it OVERLAPS has been approved (§37). An
unfinished stop — `end_at IS NULL` — is `coalesce(end_at, 'infinity')` to every read path, so taken
literally it overlaps every later shift and **one approval anywhere would freeze it forever.** A stop
left open for three weeks is precisely the one most likely to need its category corrected, so that
reading is unusable.

`listApprovalsOverlapping` therefore bounds it by `MAX_OPEN_DOWNTIME_DAYS`, the same constant that
bounds how far back the read paths look for an open stop — so both directions agree about how far one
reaches. **The residual is the inverse hole:** an approval more than that many days after an open
stop's start will not freeze it, and such an edit can still move a signed-off report's numbers. It is
silent, exactly like the straddle bug §21 describes, just much rarer.

**Context: this is the lesser of two errors, chosen knowingly, not an oversight.** Both branches are
wrong in some case; one makes long-open stops permanently uneditable, the other lets a rare edit
touch an approved report. The second is recoverable — the edit is in
`oee.downtime_report_history` with its actor and instant — and the first is not.

**The real fix is §10.** A GiST range index on `oee.downtime_reports` removes the lookback horizon
entirely, at which point the overlap check can be unbounded and correct without a table scan. Until
then this is a documented bound rather than a bug, and it is recorded in
`docs/gold-write-contract.md`'s Open risks so the pipeline owner sees it too.

**Depends on / blocked by:** no longer §10 — the `date` narrowing is gone (§69) and the
read-path half of this entry with it. What remains is a product answer on how long an
unfinished stop stays editable, which is a different question from the one this entry
opened with and wants asking on its own.

---

## 42. Nothing routes a firing alert anywhere

**What:** Add Alertmanager (or point Grafana's own alerting at a receiver) so the 12 rules in
`prometheus-alerts.yml` reach a human without one being at a dashboard.

**Why:** §39 made the rules real and they evaluate correctly — but a firing alert currently changes a
colour on a page nobody is obliged to look at. Every rule in that file exists because the underlying
defect renders as a perfectly healthy screen; an alert nobody receives has exactly the same property.

`TimeZoneResolutionFailures` is the one that makes this concrete. It is the only `critical` in the
file, and what it means is that shift windows are being built from the wrong offset — which moves the
23:00 boundary and misattributes stops between shifts, while every request still returns 200. That
is not something to discover from a dashboard the following week.

**Context:** the technical work is small — a receiver, a route tree, and `alerting:` in
`prometheus.yml`. What is not small, and is the actual blocker, is deciding **where alerts go and who
is on the hook**: the severities in `prometheus-alerts.yml` (`info` / `warning` / `critical`) were
chosen to make that routing expressible, but nobody has said what each should do. Four `info` rules
are explicitly not page-worthy and would want a digest rather than a notification.

Note also that several rules are EXPECTED to fire today and would be immediate noise:
`RejectReasonEmpty` and `DowntimeEventEmpty` fire until contract §3.8 and §3.9 populate their tables,
and `DowntimeEditsNeverHappen` fires until §19 lands. Routing before those clear would train people
to ignore the channel, which is worse than silence. Either wait, or ship with those three inhibited
and a note saying when to remove the inhibition.

**Depends on / blocked by:** A decision about destinations and ownership. Worth doing before the
first real pipeline run rather than after, which is §35's argument in a different key.

---

## 43. Nothing keeps CI's Postgres major aligned with the deployed one

**What:** A mechanical check — or at least a visible one — that the Postgres major the integration
tests run against is the major Gold actually runs.

**Why:** It drifted for months and nobody noticed. CI, `docker-compose.yml` and both integration-test
headers pinned `postgres:16-alpine` while the deployed Gold database is **18.4** — two majors ahead.
Every migration and all 155 integration tests were therefore verified against a server nothing runs.

Nothing broke: the 10 migrations and 750 tests were re-run against 18.6 when this was found, and
passed unchanged. That is the good outcome, and it is also why the drift survived — a gap that
produces no symptom produces no signal.

**It surfaced because §35 asked for PARTITIONING**, which is the one task in the backlog where a
major-version gap is most likely to matter. The comment in `api.yaml` said the pin "matches the
`postgres` service in docker-compose.yml" — true, and the wrong reference point: both were pinned to
16 together, so they agreed with each other and with nothing else.

**Context: the fix was one line in five places, so the interesting part is prevention.** Options, none
obviously right:

- **Report the server version from `/health/readiness`.** The Gold probe already connects; adding
  `server_version` to its payload makes the deployed major visible without asking anybody, and a
  human comparing it to CI is at least possible. Cheapest, and it is a signal rather than a guard.
- **Assert it in the integration suite.** A test that reads `current_setting('server_version_num')`
  and fails below a floor pins the CI container, but it cannot know what production runs — so it
  guards the wrong half.
- **A matrix on the `test` job.** Runs both majors and catches a regression in either direction.
  Doubles that job and pays for a version nobody deploys.

**Also still on 16:** `timescale/timescaledb:latest-pg16` in `docker-compose.yml`, for Silver. Left
alone on purpose — that container is not wired to anything (`SILVER_DATABASE_URL` points at Gold as a
placeholder), and Silver's version is the `vitual-factory` side's call, not this repo's.

**Depends on / blocked by:** Nothing. Worth doing before the next migration that is version-sensitive
rather than after, which is the same argument §35 makes about volume.

---

## 44. Downtime actions have no scope, so every line is offered every action

**Shipped alongside this, and this is the part that was NOT shipped.** The downtime edit dialog now
picks both `reason` and `actions` from mes-master-data instead of taking free text. Reasons are
scoped to the report's line — `GET /api/v1/master-data/downtime-reasons?workCenterId=` , backed by a
new `workCenterId` filter on mes-master-data's `/v1/downtime-reasons`, which semi-joins
`downtime_reasons_work_centers`. Actions are **not** scoped, because there is nothing to scope them
by: `ms_downtime.downtime_actions` has `defaultColumns() + color` and no junction table, where
`downtime_reasons` has three (`_areas`, `_work_centers`, `_equipments`).

**The consequence to weigh, not the bug.** Every line is offered every action in the region. That is
tolerable while the action vocabulary is generic — "Replace Belt", "Reset PLC", "Call Maintenance"
apply anywhere — and stops being tolerable the moment somebody adds a machine-specific one. The
create-on-Enter path makes that likelier over time, not less: an operator who cannot find what they
did types it, and what they type is about the machine in front of them.

**What it would take.** A `ms_downtime.downtime_actions_work_centers` junction mirroring
`downtime_reasons_work_centers` (unique `(action_id, work_center_id)`, region column, the same three
indexes), a migration, `workCenterId` on the action list filter, a Line multi-select on the
master-data form — and a decision about what the OEE dialog's create-on-Enter attaches the new
action to. Attaching it to the current line is the obvious answer and is also how a catalogue
quietly becomes per-line-fragmented; attaching it to nothing makes it invisible to the picker that
just created it.

**Do not do this as a cleanup.** It is a data-model change with a UX question in the middle of it,
and the current shape is a deliberate reading of the schema as it stands. Wait for a real
machine-specific action to exist.

**Depends on / blocked by:** Nothing technical. Blocked on the question above being answered by
whoever owns the action vocabulary.

---

## 45. `slugifyCode` is duplicated across two repos with nothing to catch a drift

`apps/web/src/lib/slug.ts` here and `apps/web/src/lib/downtime-action-schema.ts` in
mes-master-data derive an action's `code` from its `name` the same way, and must keep doing so.
Both have a test suite pinning the same five cases, which is the only thing holding them together —
there is no schema package between the repos, for the same reason `ui/tag-input.tsx` duplicates
core-api's `labelList` rules.

**What a drift looks like, and why it is not obvious.** Whichever app creates an action second gets
a `409` on the unique `(code, region)` key, reported to the operator as a duplicate — over a name
they can plainly see is not in the list. Nothing logs the mismatch, and neither repo's CI runs the
other's tests.

**The fix is not "extract a package"** unless something else earns one too: a shared package between
these two repos is a build, a version, a publish step and a deploy-order constraint, for one
28-character function. The cheaper options, in order — put the rule in
`docs/gold-write-contract.md` where both teams already read; or move the slugification server-side
so `POST /v1/downtime-actions` derives the code itself and neither browser has an opinion. The
second is probably right, and it also removes the client's ability to send a code that does not
match its name.

**Depends on / blocked by:** Nothing.

---

## 46. Backfill `business_date` and `time_zone` on `oee.work_unit_shift_reports`

**What:** Have Airflow populate the two columns `0013` added to the shift table, then tighten both to
`NOT NULL` in a follow-up migration and delete the zone-resolution fallback in the reader.

**Why:** `0013` added them nullable and metadata-only, so the `ALTER` was instant against a populated
table — but nullable means the reader cannot rely on them. `resolvePeriodScope` reads them straight
off the row for day and month, where the pipeline is expected to write them from the start; the
SHIFT path still goes through `TimeZoneResolver` (a mes-master-data call) and still derives the
business day with `(r.date AT TIME ZONE $tz)::date`. Both paths exist at once until this lands.

The second cost is `periodFilter`. It spans many work units in one query, so it cannot resolve a
zone per row, which is why the By Shift month filter is exact for a UTC+7 plant and misattributes
both ends of the month anywhere west of Greenwich (§17). Once `business_date` is populated the
filter becomes a plain column comparison and that defect goes away — the day and month list screens
already filter this way, so the two grains disagree with By Shift until then.

**Context:** `wu_shift_report_business_date_idx` is already built and is entirely NULL, so it costs
nothing today and starts working the moment rows are written. `oee.reject_count_wu_shift` and
`oee.downtime_reports` already carry `time_zone`, so the pipeline has the value to hand. The
contract section added for `0013` states the expected semantics: `business_date` is the plant-local
business day the row summarises, running 07:00 → 07:00.

**How you would know it is safe to tighten:** `SELECT count(*) FROM oee.work_unit_shift_reports
WHERE business_date IS NULL OR time_zone IS NULL` returns 0, and has for long enough that no DAG
backfill is still in flight.

**Also true of `oee.downtime_reports` as of `0021`** — the same pair, the same owner,
the same ask. §69 is that half and the two should be sent as one message rather than
as two.

**Depends on / blocked by:** Airflow/dbt writing the columns. Blocks the removal of
`TimeZoneResolver` from the report read path, and closes §17.

---

## 47. `availablity_loss_time` was corrected, reversing §1's preservation rule — **DONE (2026-08-27)**

**What happened:** `0013` renamed `availablity_loss_time` to `availability_loss_time` on
`oee.work_unit_day_reports` and `oee.work_unit_month_reports`. §1, `AGENTS.md` and
`0003_oee_gold_schema.sql` all previously said this must never be done.

**Why the reversal was correct rather than a violation.** Read the reason `0003` gave for
preserving it: _"renaming either would break the dbt models that write them."_ There were no dbt
models writing those two tables. They were captured empty in `0003`, nothing in this service read
them until the By Day / By Monthly screens, and the pipeline owner was waiting on this repo's
schema request before building the models at all. The rule protected a dependency that did not
exist, and it would have cost an alias in every projection and a double-take from every reader,
permanently.

**What was NOT changed, and why.** `work_unit_shift_reports.availability_loss_time` was already
spelled correctly. The physical column order on `oee.downtime_reports` remains preserved and is
still a real constraint — that one is load-bearing because `SELECT *` shape is relied on.

**The generalisable rule this leaves behind:** a preservation rule is only as good as its premise.
Before honouring one, check whether the thing it protects is still there. Had these tables been
populated, or had a dbt model referenced them, the rename would have been exactly the mistake §1
described.

---

## 48. Approving a day report, and whether it should cascade — **A MECHANISM NOW EXISTS TO REUSE**

> **Read §53 first.** The LINE cascade shipped on 2026-08-31 and is this item's shape one axis over:
> one click, N child shift reports, its own role variable, one data-modifying CTE, and a status
> derived by counting rather than stored. Building a day cascade independently is precisely how the
> app ends up with two definitions of "approved" — which is what this entry warns about below. The
> product question (may one operator close three shifts they did not work?) is still unanswered; the
> mechanism no longer needs designing.

**What:** Decide whether a day report gets an Approve action that closes its three child shift
reports in one transaction, and if so, under what authority.

**Why:** The By Day detail screen shows "2 of 3 shifts approved" and offers no way to act on it. A
supervisor who has read the day and is satisfied has to open three shift reports to sign them off.
That is the obvious next request, and it is deliberately not built.

**Context — this was decided, not overlooked.** The reference design removes the Approve button from
the day header, and the alternative is a real write with consequences the shift path does not have:

- **There is no row to write.** `oee.work_unit_shift_report_approvals` is keyed
  `(work_unit_id, date, shift)` (migration `0010`), so a day approval either writes three child rows
  or needs a new table. Three child rows is probably right — it keeps one definition of "approved"
  and the By Shift list stays correct — but it means one operator's `sub` lands in three `closed_by`
  columns and three rows of `oee.work_unit_shift_report_approval_events`.
- **It is a different authority.** `APPROVE_ROLE` gates approving the shift you worked. Signing off
  three shifts at once — including two somebody else ran — is not the same permission, and
  collapsing them would assert it is. §34's argument for three separate role variables applies here
  verbatim: it wants its own.
- **The partial case needs an answer.** If one of the three is already closed, does the cascade skip
  it, fail, or reopen-and-reclose? The shift endpoint answers `already_closed` as a distinct
  outcome; a cascade has to decide what that means for the set.

**Where to start:** `work-unit-service.ts`'s `approveShiftReport` and the writer's
`closeShiftReport` are the shape to follow — one transaction, `asOperator(tx)`, an event row per
transition. `summariseApprovalsInWindow` already produces the count the UI shows, so the read half
exists.

**Depends on / blocked by:** A product decision about the authority, and a fourth role variable if
the answer is yes. Blocks nothing.

---

## 49. A partially-approved day offers an edit the server refuses

**What:** The Downtime Details table on a By Day report enables the edit menu on rows whose own
shift is approved, whenever the day as a whole is not.

**Why:** Editing a stop is refused if any shift report it overlaps has been approved (§37), and the
server enforces that correctly — the operator gets a 409 the dialog surfaces, naming the shift. So
this is a wasted click and a confusing message, not a data risk.

**Context — the fix is not obviously worth its cost.** `downtime-details-card.tsx` derives
`reportApproved` from the report's approval state. At shift grain that is exact. At day grain the
report carries a COUNT (`shiftsClosed` of `shiftsTotal`), so the only honest reading is "frozen when
all of them are closed" — which is what it does.

Making it exact means deciding, per row, which shift the stop falls in. That needs the shift
boundaries in the browser, which is a second copy of `SHIFT_WINDOWS` — the arithmetic divergence
`apps/api/src/shared/shift-window.ts` exists to prevent, and the one that renders a plausible number
rather than throwing. A recoverable 409 is the cheaper error.

**The affordable version, if it becomes worth doing:** have `/downtimes` return a per-row
`frozenByShift: number | null`, computed server-side where the boundaries already live. The list
query already resolves the window; adding the overlap against approved shifts is one more join, and
the browser then greys the menu on a fact rather than on an inference.

**Depends on / blocked by:** Nothing. Wants a real operator complaint before it earns the join.

---

## 50. The day and month reports have no stale-metrics banner — **ACTIVITY DONE (2026-08-27)**

**Log Activity now works at both grains.** `GET /work-units/{day,month}-reports/:id/activity`, and
the `…` menu item is no longer disabled. What it can honestly show differs by grain and the payload
says so rather than the screen guessing:

- **approval** — the transitions of the CHILD shift reports, each labelled with its shift, and
  `totalMembers` is the real count of them rather than 1. There is no day or month approval, because
  the events table is keyed `(work_unit_id, date, shift)` — the same fact that means there is nothing
  to sign off at these grains.
- **downtime** — reports `no-stable-id` for exactly the reason it does at shift grain: the pipeline
  does not write `source_event_id` (§19), so those stops could never have carried a trail rather than
  merely not having one.
- **quality** — empty at every grain, and NOT because of the grain: both quality tables are keyed on
  `work_unit_id`. No operator mutation targets either, so there are zero editable entities of that
  kind. §32.

`listShiftDowntimeHistory` needed no widening at all — it was already expressed as a window, which
is why this was a handler rather than new SQL. The one new query is
`listApprovalTransitionsInWindow`, which returns `shift` on every row; the shift-grain sibling does
not, and without it three rows in a day's feed are indistinguishable from three approvals of one
report.

**What is still missing is the BANNER**, which is the rest of this entry below: `metrics-staleness`
has no day or month endpoint, so an operator's category edit leaves those two screens quietly
disagreeing with it while the shift report warns. Same shape as the activity feed — the repository's
`getCategoryEditedAt` already takes a window.

**What:** `StaleMetricsBanner` is absent from the By Day and By Monthly detail screens, so an
operator's downtime edit leaves those reports quietly disagreeing with the edit and nothing says so.

**Why:** `docs/downtime-edit-trd.md` already records that `work_unit_day_reports` and
`work_unit_month_reports` "roll up the same time, so a category edit makes them stale too — and
nothing today asks you to rebuild them either." The shift report warns about exactly this; these two
do not, and they are stale for the same reason.

**Context:** The banner reads `GET /work-units/shift-reports/:id/metrics-staleness`, which resolves
the shift's window and asks `getCategoryEditedAt` for the newest `field = 'category'` change among
the stops inside it. Every piece of that is already grain-agnostic — the repository's private
`shiftStops` fragment is expressed as a window, and `resolveReportWindow` produces one for any
grain. So this is a handler and a service method, not new SQL.

The reason it is not built is scope rather than difficulty: it is a separate endpoint per grain, and
the screens shipped without it rather than with a banner wired to the wrong report's window.

**Depends on / blocked by:** Nothing. `gold-write-contract.md` §15.9 tells the pipeline owner the
staleness exists; this is the half that tells the operator.

---

## 51. The By Day and By Monthly Losses drill-down — **DONE (2026-08-27)**

**Status.** Built. Both grains have the five-tab Losses page and the per-reason drill-down behind
it, and the Losses card's external-link icon is offered again at every grain.

The five tabs, their URL contract and their per-tab prefetch moved into
`apps/web/src/components/report/losses-tabs.tsx` rather than being cloned twice. That dispatch's
intricacy is load-bearing — the order of its checks is what makes `item.category` provably defined
in the last arm, and the `never` in its prefetch switch is what stops a sixth tab shipping without a
prefetch — and three copies would have been three places for it to drift silently. The extraction
also took ~29 kB out of the entry chunk, because the tab components are now reachable only from route
chunks.

Performance Loss → Trendline works at month grain too: §23's hour-of-day profile shipped, so the
sub-tab is no longer filtered out.

**One thing shipped wrong here and is worth recording.** The Losses card's external-link icon was
left hardcoded to `/report/machine/by-shift/$reportId/losses` while the card served three grains, so
the day and month Losses pages were built and UNREACHABLE — and the link that was on screen opened
the shift report sharing that id, about possibly a different machine on a different date, with
nothing to indicate it. The commit that built those routes claimed the icon "works at every grain
again"; it did not. `losses-card.test.tsx` now asserts the grain inside the href, which is the only
form of the assertion that catches it — a test that merely checked a link existed passed throughout.

**What this entry got right and wrong.** The two missing aggregates were exactly the shape predicted
(widen the private fragment from `shift_date = $d AND shift = $s` to a range), and the unit guards do
trip far more often over 30 days — a test pins that the counter unit goes null while the converted
total still adds up. What it did not anticipate: `reason-search.ts` needed no generalisation at all,
because the reason selector never carried a grain.

---

## 52. A Line report detail screen — **DONE (2026-08-31)**

**What:** Build `/report/line/{by-shift,by-day,by-monthly}/$reportId` and the API sub-resources
behind it, so the Action column's eye on the three Line list screens has somewhere to go.

**Why:** The eye shipped **inert** — a `<span>`, not a link — because the reference design showed the
column and nothing had been designed to open. That is the repo's convention for an undesigned action
(`report-actions.tsx` does the same for Regenerate), but an entirely-disabled column is arguably
worse than no column, and it was the first thing a supervisor would click.

### What part 1 shipped

`GET /api/v1/work-centers/{grain}-reports/:id` and the four sections the design specifies —
**header, overview, timeline, waterfall** — at all three grains, plus the eye as a real `<Link>`
(typed as the three route literals, so a wrong target is a build error rather than a MACHINE report
opened under a Line breadcrumb).

Two things came with it that this entry did not anticipate:

- **A line approval, as a CASCADE.** The design's header showed an Approve button. See §53, which
  this answers.
- **Migration `0015` adds `line_out`**, a fourth infeed-side count, because the overview card has
  four production tiles where `0014` gave three columns. Contract §16.4b is the request; the column
  ships NULL and the tile is an em dash until the DAG fills it.

Three sub-resources were reused with **no API change at all**, which is worth knowing before building
part 2: the timeline, `/downtimes` and `/downtimes/by-reason` all already take `scope=work-center`
(`SCOPE_COLUMN` in `downtime.ts`), and `reportWindowParams` in the browser resolves a line report to
that scope. The blocker on the Losses half is cost, not capability — see below.

### What part 2 shipped

**Context:** the URL shape was settled in part 1 and held: `/api/v1/work-centers/{grain}-reports/:id`,
NOT a bare `/work-centers/:id` — under that prefix a bare id reads as the master-data catalogue's
"the work center" rather than "the report". `work-center-handler.ts` says so in a comment.

Three more sections on the detail screen — **Losses, Downtime Details, Machine View, SKU View** — plus
the **Losses drill-down page and its per-reason detail page** at all three grains. Four new API
sub-resources: `products`, `machines`, `rejects`, `downtime-events`.

The four questions part 1 left open, and how each resolved:

- `products` — **UNBLOCKED BY A NEW PAIR OF GOLD TABLES**, not by a read-time roll-up, and the
  argument for that turned out to be stronger than the `factor_to_base` one this entry and §15 both
  gave. A line is MEASURED, not summed (`0014`, commit `4fccce8`), so `line <> sum(machines)` — and
  the overview card sits DIRECTLY ABOVE SKU View rendering the line's own `total_out` / `good_out`.
  A rolled-up SKU View would therefore print per-SKU figures that visibly disagree with the card
  above them on the same screen, and **the disagreement would be correct**, which makes it
  unexplainable. Migration `0016` adds `oee.product_count_wc_shift` and `oee.product_count_wc_day`
  (two tables, not three — the day table serves month by widening, exactly as
  `listPeriodProductCount` already proves for the machine pair). Contract §17 is the pipeline
  request. **The tables ship EMPTY** and there is deliberately no dev seed: the only available
  derivation is the roll-up, so a seed would teach the invariant the table exists to deny. §14's
  ladder is what lets the card say which kind of empty it is.
- `downtime-events`, `rejects`, the timeline, the three Availability Paretos — **shipped, and the
  two aggregates moved rather than being rewritten.** `aggregateRejectRows` and
  `aggregateEventPairs` were already Fragment-parameterised, so they lifted verbatim from
  `work-unit-repository.ts` into `shared/loss-aggregate.ts` — the move `shared/shift-window.ts` and
  `shared/actor.ts` made, for the same reason: a second caller appeared. §25 was bounded first, as
  this entry required, and `/downtimes/by-reason` now takes `measure` and `limit` and derives an
  `other` tail.
- `performance` / `hour-profile` — **still open, and now visible on screen as an empty state.** The
  Losses page's Performance Loss → Trendline sub-tab renders at line grain and says why it has
  nothing: `product_perf_wu_hour` needs rolling up by `work_center_id`, and the CHART needs the
  two-Y-axis change contract §16.4a describes, because `total_out` is in the line's INFEED unit and
  `effective_out` in its OUTPUT unit. The sub-tab is present rather than absent so the tab bar does
  not change shape between subjects. See §61.
- `metrics-staleness` — **shipped at shift grain** (§50's machine half closed at the same time). No
  coarser line reading exists; see §60.

Three things came with part 2 that this entry did not anticipate:

- **`ReportAddress`** (`web/src/lib/report-subject.ts`). The edit dialog and `useEditDowntime` took
  `reportId` and `grain` as separate parameters, which is the shape a caller gets half-right: a line
  report's id with the machine subject implied compiles, and the invalidation then refetches a
  STRANGER's activity feed while the operator's own stays stale. One value, derived once from the
  report.
- **`useReportApproved`** — the freeze rule for all six addresses in one place, because a line report
  has no `approval` column and has to read the machine-approval summary instead. §49's approximation
  now covers four of the six; the pending arm reads NOT frozen deliberately, since offering an edit
  that 409s is recoverable and refusing one that would have worked is not explainable.
- **Machine View**, which the design showed and this entry did not name. Its per-row arrow is the
  six-sequences hazard in its sharpest form — a machine link built on a line screen, with the wrong
  id in scope — so it interpolates the `reportId` the endpoint returns, and the test asserts the
  href.

**Where to start** if picking up the screen: `line-overview-card.tsx` still carries the two-unit map,
which is the thing about this grain a machine-shaped assumption gets wrong without failing.

**What is deliberately not built:** the reject/rework write path (§59), the coarse line activity feed
(§60), the line performance trendline (§61), and the §48 day-approval cascade. Filling
`oee.product_count_wc_*` is Airflow's.

---

## 53. Should a line report be approvable, and what would it mean? — **ANSWERED AND SHIPPED (2026-08-31)**

**What:** Decide whether the Line report screens gain an Approve action, and under what authority.

**THE ANSWER: yes, at shift grain, as a CASCADE over the line's machine shift reports.** A line has
no approval row and cannot have one, so approving one closes every machine shift report on it and its
own status is a DERIVED count ("4 of 5 machines approved") — the same treatment the machine day
header already gives "2 of 3 shifts approved", because a badge would assert a signature nobody gave.

### How each of this entry's three objections was resolved

- **"No `work_unit_id` on the `work_center_*` tables"** — true, and it does not matter, because the
  join runs the other way. `oee.work_unit_shift_reports.work_center_id` has been **NOT NULL since
  `0003`**, and the pipeline owner confirmed every work unit has a work center (contract §16.10 Q6).
  So the cascade finds its machines with a plain predicate and makes **no upstream call at all**.

  > **This was wrong when first shipped.** The cascade resolved the line's roster through
  > `findAllWorkUnitIdsByWorkCenterId`, on a comment asserting `work_unit_shift_reports` had no
  > `work_center_id` — it always had. Corrected on 2026-08-31, removing a FATAL HTTP dependency from a
  > write path and from four reads. Scoping by the column is also the **better definition**: it
  > records the line the pipeline attributed a machine's numbers to when it computed them, where a
  > roster is the line's membership now — so a machine re-parented since the DAG ran no longer gets
  > approved on the wrong line's screen.

- **"'The line is closed' has two incompatible meanings — all of its machines, or any of them"** —
  resolved by making the WRITE the definition rather than the read. There is now one definition of
  "approved" in the app, and a partially approved line (reachable the moment somebody approves one
  machine from the machine screen) keeps Approve enabled and closes only the open ones — which is
  what the existing upsert's `WHERE a.status = 'open'` already does.
- **"It is a third authority"** — `APPROVE_LINE_ROLE` and `REOPEN_LINE_ROLE`, new optional vars, by
  §34's argument rather than by symmetry. Unset means no check, which is the shipped state.

### Two consequences worth knowing

- **The downtime freeze needed NO code.** Because a line approval IS machine approvals,
  `listApprovalsOverlapping` already sees them and every stop carries `work_unit_id` — so a signed-off
  line's stops are frozen with no change to the downtime module, and there is no second definition of
  "frozen". Asserted in `work-center-repository.integration.test.ts` rather than claimed, because
  "nothing changed" is the kind of statement that rots.
- **`0014`'s trigger comment survived.** "No operator mutation targets these three tables" is still
  true: the writes land in `oee.work_unit_shift_report_approvals`, and the trail is the existing
  append-only `…_approval_events`, one row per machine.

### What this leaves open

**§48 should now REUSE this mechanism rather than design a second one.** A day cascade is the same
shape one axis over — one click, N child reports, its own role variable — and building it
independently is exactly how the app ends up with two definitions of "approved", which is what this
entry and §48 both warned about. The pieces to reuse are `closeLineShift`'s data-modifying CTE (one
statement for N rows, `RETURNING` feeding the event insert, `ORDER BY` for a stable lock order) and
`DerivedApprovalBadge`.

**Also open:** a line's status is derived per report, so the LIST screens still carry no Status
column — that needs a set-based version of the count first, one query for a page rather than one per
row.

**Why it mattered:** The three Line lists rendered no Status column and the API offered no
`approve`/`reopen`, which was correct but not obviously _permanent_. A supervisor who signs off
machines one at a time asked for the line.

**Context — this is §48 squared, and the two have to be answered together.** §48 asks whether a DAY
report can be approved and notes it would have to write three child rows because
`oee.work_unit_shift_report_approvals` is keyed `(work_unit_id, date, shift)`. A LINE approval has
the same problem across a different axis, plus one §48 does not have:

- **There is no `work_unit_id` on the `work_center_*` tables at all** (migration `0014`), so a line
  approval cannot even correlate a subquery against the approvals table without joining back through
  `work_unit_shift_reports` or calling master-data. The read side would need that too, which is why
  the list carries no derived count the way the day DETAIL screen does.
- **"The line is closed" has two incompatible meanings** — all of its machines, or any of them — and
  they disagree on every partially-approved line. §49 already documents the pain one partially
  approved DAY causes.
- **It is a third authority.** §34's argument for three separate role variables applies again:
  signing off a whole line at once is not the permission `APPROVE_ROLE` grants.

**Depends on / blocked by:** §48 should be answered first — a day cascade and a line cascade want
the same mechanism, and building them separately would give the app two definitions of "approved".

---

## 54. `/work-centers/*` answers 200-empty for an unknown line where `/work-units/*` answers 404

**What:** Decide whether the two report endpoint families should agree about an unknown
`workCenterId`, and in which direction.

**Why:** They currently disagree, deliberately, and the divergence is documented in
`work-center.ts` — but "documented" is not "decided". A client written against one and pointed at
the other gets a different answer for the same mistake.

**Context — the current behaviour is right for each, which is why this was not simply unified.**
`/work-units/*` resolves a `workCenterId` into a list of machine ids through mes-master-data;
`resolveWorkUnitIds` has to distinguish "an empty work center" from "a work center that does not
exist", because `workUnitIds: []` would be dropped downstream as "no filter" and return **every**
machine's rows. The 404 guards that specific failure of the id-list mechanism.

`/work-centers/*` has no id list: `work_center_id` is the grain key, the predicate always filters,
and an unknown id matches nothing. There is nothing left to guard, and adding an `existsWorkCenter`
call back would reintroduce a fatal upstream dependency on a read that otherwise touches only Gold —
or, if called only on the empty path, would make a master-data blip turn "this line was idle in
August" into a 503 while a populated page succeeds.

**Where to start:** If convergence is wanted, converging **downward** (drop the 404 on
`/work-units/*` too) is the cheaper and more defensible direction — see §55, which would make it
possible.

**Depends on / blocked by:** Nothing. Wants a real client complaint before it earns the churn.

---

## 55. `resolveWorkUnitIds` may be unnecessary on the work-unit lists too

**What:** Evaluate replacing the master-data round trip on `/work-units/*-reports?workCenterId=`
with a plain `AND r.work_center_id = $` predicate, as `/work-centers/*` now does.

**Why:** `oee.work_unit_shift_reports.work_center_id` has been `NOT NULL` since `0003`, and `0013`
added it to the day and month tables. So the column that would answer the filter is already there,
and the current path spends **one to two upstream HTTP calls, FATAL on failure**, to produce the
same id set — on the hottest page in the app.

**Context — the two are NOT equivalent, and that is the whole question.** The column says which line
the machine belonged to **when the report was written**; master-data says which line it belongs to
**now**. For a historical report the column is arguably the more correct answer: after a machine is
re-parented, the current behaviour retroactively moves its old reports to its new line, and the
column would leave them where they were produced.

That is a product decision, not a refactor. It also changes the 404 behaviour (§54) and would make
the two endpoint families agree by converging downward.

**Where to start:** `work-unit-service.ts`'s `resolveWorkUnitIds` and the three-stage pipeline
comment above `getPagedShiftReport`. `work-center-repository.ts`'s `workCenterSql` is the shape.

**Depends on / blocked by:** A product answer on re-parenting. Would close §54.

---

## 56. `work_unit_count` and `expected_work_unit_count` have no server-side guard

**What:** Decide whether the API should surface, or the pipeline should be tested on, the case where
a line row was built from fewer machines than the line has.

**Why:** The Line lists render "3 of 4", which is the honest signal — but it is the _only_ one. A
line whose DAG partition failed for one machine produces a plausible, slightly-lower OEE, and
nothing else in the stack notices. `docs/gold-write-contract.md` §16.8 asks the pipeline for two
cross-checks at `error` severity; neither of them covers a _partial_ line, because a line that
summed three of four machines correctly still equals the sum of the three it saw.

**Context:** The two columns exist precisely so this is _detectable_. What is missing is anything
that acts on it — a third dbt test (`work_unit_count = expected_work_unit_count` at warn severity),
or a banner on the screen, or a `line_reports_partial_total` counter. The screen currently shows the
numbers and leaves the reading to the operator.

Note `expected_work_unit_count` is nullable and is left NULL by the dev seed, so a partial line is
undetectable in dev until the pipeline writes it. §16.5 is explicit that it must never be a guess.

**Depends on / blocked by:** The pipeline writing `expected_work_unit_count` at all (§16.10 Q1).

---

## 57. `.strict()` on the report list query schemas — both modules, or neither

**What:** Decide whether an unknown query parameter on a report list should be a 400 rather than
silently dropped.

**Why:** `?shift=1` on `/work-units/day-reports` is **accepted and ignored** today —
`paginationSchema` is a plain `z.object`, so `.extend()` keeps it non-strict.
`work-unit-handler.test.ts` codifies that behaviour, and `work-center-handler.test.ts` now copies
it deliberately rather than diverging. But AGENTS.md's own argument for omitting `shift` from those
schemas is that "accepting and ignoring either would answer a filtered request with an unfiltered
page, which reads as data rather than as an error" — and accept-and-ignore is exactly what the
shipped endpoints do.

**Context:** The two positions are both defensible; what is not defensible is two modules answering
the same URL two different ways, which is why the new module matched rather than improved. A 400
would also break any bookmarked URL carrying a stale param, which is the same argument the
empty-string arms in `shared/report-filter-dto.ts` make for leniency.

**Where to start:** `packages/helper/src/validator.ts`'s `paginationSchema`, then the four list
schemas. It is one `.strict()` and a handful of test cases, applied to both modules in one commit or
neither.

**Depends on / blocked by:** Nothing. Blocks nothing.

---

---

## 58. `findAllWorkUnitIdsByWorkCenterId` is uncached — **DONE FOR THE LINE PATH (2026-08-31)**

> **`MasterDataService.listWorkUnitIds(workCenterId, operation)` now caches it** on the same
> `StaleCache` policy as areas, work centers and the two downtime catalogues, keyed per line. The
> whole work-center module reads through it, so the five callers on a Line shift detail page view —
> the approval summary, approve, reopen, the activity feed and the stale-metrics banner — share one
> round trip instead of making five.
>
> `operation` is a parameter, which none of the sibling getters need: `wrapError` turns a cold-cache
> failure into a 502 whose sentence the operator reads, and "resolve the work center filter" on a
> list screen is a different question from "resolve the line roster" before signing off a shift.
>
> **WHAT IS LEFT, and it is deliberately left.** `work-unit-service.ts`'s `resolveWorkUnitIds` still
> calls the CLIENT directly, so the machine list screens' Line filter is uncached. That call fires
> once per filter interaction rather than once per page view, so the value is much lower — and
> switching it changes the dependency graph and the error path of a shipped, heavily-tested service
> for that small gain. Worth doing when something else touches that method; not worth doing on its
> own. The cached getter is already there to point at.
>
> The TTL caveat below still stands and is the one thing to read before raising it.

### Original entry

**What:** Put the line-roster lookup behind `MasterDataService`'s existing `StaleCache`, as areas,
work centers, downtime reasons and downtime actions already are.

**Why:** `MasterDataService` holds four `StaleCache` instances
(`master-data-service.ts:104-107`) with a TTL, single-flight and stale-on-failure. The roster call
is not one of them — `work-unit-service.ts` and now `work-center-service.ts` reach
`MasterDataClient.findAllWorkUnitIdsByWorkCenterId` directly, so every call is an HTTP round trip to
mes-master-data.

That was tolerable while the only caller was a list filter the user had explicitly set. The line
approval made it hotter and sharper:

- **Every approve, reopen, activity read and approval-summary read makes one.** The summary is the
  one that matters — it is fetched on every Line shift detail page view. It is deliberately a
  separate route, prefetched WITHOUT awaiting, precisely so this cost does not block the page
  (`work-center-service.ts`'s `getApprovalSummary`); caching it would make that unnecessary rather
  than merely tolerable.
- **A slow roster call is on the WRITE path.** It is resolved before `db.begin` (deliberately — see
  §53), so it cannot hold a transaction open, but it is still latency the operator waits through with
  a confirm dialog on screen.

**Context / where to start:** `apps/api/src/module/master-data/master-data-service.ts` is the whole
pattern — add a fifth `StaleCache<{ id: number }[]>` keyed on the work-center id, wrap the client
call, and the two services then depend on the service rather than the client. `shared/stale-cache.ts`
holds the TTL/single-flight/stale-on-failure state machine and needs no change. §7 is the item that
built it, and its reasoning applies verbatim.

**The one thing to think about before doing it:** a stale roster changes an APPROVAL DENOMINATOR.
The line's Status tile compares `machinesFound` against the row's own `work_unit_count` and abstains
when they disagree (§53), so a stale roster surfaces as "Roster disagrees" rather than as a wrong
fraction — which is the right failure, but it means a long TTL turns a re-parented machine into a
visibly broken tile for that TTL. The existing 5-minute policy is almost certainly fine; picking a
longer one is a decision, not a tuning.

**Depends on / blocked by:** nothing. §7 already shipped the mechanism.

---

## 59. Operator-entered reject and rework has nowhere to write — **DONE (2026-09-01)**

**What:** Build the write path behind the Losses card's `Add Reject +` / `Add Rework +` buttons —
currently rendered **disabled with a tooltip** on the Line detail screen at shift grain.

**Why:** The buttons are the one place in this codebase that deliberately breaks
`report-actions.tsx`'s convention. That rule says a disabled action means NOBODY DESIGNED IT, so
there is nothing truthful to say on hover and no tooltip belongs. Here the feature IS designed and
committed — the product decision is recorded and includes an audit trail in the activity log covering
BOTH subjects, machine reports and line reports — it simply has nowhere to write. So the buttons are
shown so the feature is discoverable and the tooltip says exactly that. **That is a deliberate,
documented exception and it should not survive long**: every visit teaches an operator about a
feature they cannot use.

**Context — the shape of the problem, which is not the obvious one.** The tempting implementation is
to write the rows into `oee.product_count_wc_shift` / `oee.product_count_wu_shift`, since those carry
`reject` and `rework` columns per product. **`docs/gold-write-contract.md` §17.6 asks the pipeline
owner explicitly NOT to let that happen, and the same prohibition binds this service**: those tables
are `DELETE`-then-`INSERT` loaded, so an operator entry written there is reverted on the next DAG run
with nothing in any log — the identical failure §13 of the contract exists to prevent for
`downtime_reports`, which cost a real edit.

So this needs the shape the downtime edit has:

- **A new table** to hold the operator entries, keyed by report address and product, append-only or
  with a history sibling. `oee.downtime_report_history` is the model.
- **An override join** in the dbt model that reads the report, so the pipeline's own figures and the
  operator's additions compose rather than one clobbering the other. Contract §13 is the written
  precedent; a new contract section is where the request goes.
- **`asOperator(tx)`**, `requireActor`, and a **fourth optional role var** beside `APPROVE_ROLE` /
  `REOPEN_ROLE` / `EDIT_DOWNTIME_ROLE` — three vars rather than one is already a deliberate policy
  decision pushed out of the code (§34), and "may add a reject" is not the same authority as "may
  approve a report".
- **An activity-log arm**, at both subjects. This is the half the product decision named explicitly,
  and it is also the half that constrains the table: the feed reads events, so the entries have to be
  event-shaped, not merely a mutable column.

**The grain question is already answered:** shift only. A day or month figure is a sum over shifts, so
there is no single record for an entry to attach to — the same reason the approval is shift-only, and
the reason the buttons are absent rather than disabled at the coarse grains.

### What shipped, and the four places this entry was wrong

Migration `0017` (`oee.work_center_quality_entries`), contract §18, a
`quality-entry` module, three master-data catalogue routes, the entry dialog, the
ledger line, the entries sheet and the activity feed's third arm.

Four corrections to what this entry assumed:

- **"A fourth optional role var".** It is the SIXTH — `APPROVE_LINE_ROLE` and
  `REOPEN_LINE_ROLE` landed in Part 1. `ENTER_QUALITY_ROLE`.
- **"An override join in the dbt model … §13 is the written precedent."** True in
  shape and misleading in kind. §13 **replaces** four columns of a row keyed on
  `source_event_id`; this **adds** to a column, because no sensor recorded the
  quantity and there is no row to override. The failure mode inverts with it — a
  lost edit there, a DOUBLED figure or an ABORTED LOAD here — and the
  shift-grain-only rule falls straight out of that difference (§18.2).
- **"The grain question is already answered: shift only."** Overruled. The buttons
  are at all three grains; the coarse dialogs ask the operator to NAME a shift, so
  every entry is still one shift-keyed row.
- **It did not anticipate the unit trap at all**, which turned out to be the
  hardest part — see §18 and `0017`'s header.

**And the thing to know before touching any of it:** an entry moves `reject` and
`rework` and **no rate**. §16.10a(b) settled that the line's rates are
time-derived, and ends "the count columns are reported figures; no rate reads
them". So 500 rejects typed in change no percentage on the screen. The dialog says
so before the operator submits. Making OEE move is not a bigger version of this
feature — it is a request to make quality count-derived at line grain, which
§16.10a refused on unit grounds.

**Left open:** the Quality Pareto still reads `reject_count_wu_shift` and will not
reflect manual entries — see §62.

---

## 60. A line report has no activity feed or stale-metrics banner at day and month grain — **FEED DONE, BOTH GRAINS (2026-09-11); BANNER STILL OPEN**

**Status.** `GET /work-centers/{day,month}-reports/:id/activity` ships, and the Line day and month
detail screens offer Log Activity from the "…" menu. The **stale-metrics banner is still shift-only**
and is what remains of this entry, together with the two SKU items further down.

**The product question this entry held open is answered: a line day feed is a FEED.** The worry was
density — "~3N machine-shift transitions, each labelled with a machine AND a shift, which may be a
log rather than a feed" — and the deciding evidence was that two other subjects had already shipped
the same shape. A MACHINE day feed reports its three child shifts' transitions; an AREA day feed
spans three shifts AND N lines. What makes the density readable is the LABEL, not the count, so the
answer was to add the axis rather than to filter the rows: `LineActivityEntry`'s approval and
quality arms now carry a nullable `shift` beside their `workUnitId`, null at shift grain (where
labelling every row with the one shift is noise) and a number at the coarse ones.

**IT WAS SMALLER THAN THIS ENTRY PREDICTED, AND THE PREDICTION'S PREMISE WAS WRONG.** The entry said
both endpoints were shift-keyed "because both arms are scoped by a shift window over the roster",
and that the day version was "harder in one specific way: a line DAY window spans three shifts and N
machines, so the roster resolution and the events join both widen". Only the second half of the
second clause was true:

- the **downtime** arm was always a plain `[from, to)` instant window and never read the shift at
  all — it needed no change;
- the **quality** arm reads `listActivityForTarget`, the range variant the SKU day feed already
  proved, and now does so at ALL THREE grains rather than branching (`resolveLineWindow` produces a
  half-open date range with the shift beside it, which at shift grain is exactly what the collapsed
  helper built);
- the **approval** join was the only thing narrowing by a shift, so `machineReports`'s
  `AND r.shift = $n` became conditional. There is no roster resolution to widen — that premise died
  when `work_center_id` turned out to be NOT NULL on `oee.work_unit_shift_reports`.

Two things the widening did need, both recorded beside the code. `LineActivityWindow` is
`LineShiftKey` with `shift: number | null`, as a SEPARATE TYPE rather than a nullable field on the
cascade's own key — a null there would mean "close every shift in the window", which is the
authority §48 holds. And the approval arm's member count moved from the writer's
`summariseLineShift` to a reader `countMachineReports` that goes through the same fragment the arm
joins against: the writer's version exists so a badge and a 409 cannot disagree, it requires a shift
because a cascade does, and the feed has no part in either.

**READING IS NOT SIGNING, and that is the line to defend.** `/activity` serves all three grains
while `approve`, `reopen` and `/approval` stay shift-only. The two look alike and have different
answers: reading what happened over a window grants nothing, while signing off a day would cascade
over three shifts as well as N machines. `line-report-actions.test.tsx` asserts both in one case so
a future "consistency" pass cannot align either to the other.

**THE INVISIBLE HALF THIS ENTRY NAMED IS CLOSED, and it was bigger than the entry thought.** The
entry wrote the trigger condition verbatim — "the moment one exists, that arm must be filled in, and
nothing will fail if it is not" — for `useEditDowntime`'s line day/month arm, which resolved to
`null`. It now names `lineActivityKey(grain, reportId)`, and that key carries the grain in its
PREFIX for the reason every other line key does.

What the entry did not foresee is that the APPROVAL writes had the same gap in five places. One row
of `…_approval_events` is reported by SIX feeds (machine shift/day/month, line shift/day/month), and
five of them are keyed on ids the writing call site cannot compute. Both machine writes named one
key and the line cascade named two. `invalidateApprovalFeeds` in `mutations.ts` is now the single
statement of that set, used by all three call sites — two of them naming different subsets is
exactly the bug `invalidateAfterLineWrite`'s own header warns about.

**AND ITEM 2 BELOW IS DONE, because shipping two new screens with a wrong sentence is worse than a
copy change.** The line feed's downtime source reported `no-stable-id` over a ZERO-member window —
"these downtime records carry no stable identifier", a claim about records, and false when there are
none. This entry left it alone because it was "a visible copy change on a shipped screen"; that
argument expired rather than being overruled, since the alternative was two visible changes instead
of one. It now reads `tracked: true` there, matching the SKU and area feeds.

**What is left:** the banner at line grain, and the two SKU items below. Neither needs a product
decision.

---

## 60a. The original entry, for the reasoning

**What:** Extend `GET /work-centers/shift-reports/:id/{activity,metrics-staleness}` to the day and
month grains, or decide they should not exist.

**Why:** Two visible asymmetries and one invisible one.

The visible pair: the Line day and month detail screens render **no stale-metrics banner** and offer
**no activity sheet**, while the machine day and month screens have both (§50 closed that). Both
line endpoints are shift-keyed because both arms are scoped by a **shift window over the roster** —
the approval-events table is keyed `(work_unit_id, date, shift)`, and the staleness scan reads the
window's downtime rows.

The invisible one is the reason this is filed rather than left implicit. `useEditDowntime` in
`apps/web/src/lib/mutations.ts` now picks an activity key from FOUR cases, and the line day/month arm
invalidates **nothing** — deliberately, because naming the shift key there would clear an unrelated
line SHIFT report's feed (the three `work_center_*` tables have independent sequences too). So an
edit made from a line day screen leaves no feed stale, because there is no feed. The moment one
exists, that arm must be filled in, and nothing will fail if it is not.

**Context:** §50 is the same item one subject narrower and its resolution is the template — the
machine version widened `getPeriodMetricsStaleness(grain, id)` off the existing shift implementation.
The line version is harder in one specific way: a line DAY window spans three shifts and N machines,
so the roster resolution and the events join both widen, and `resolveLineWindow` already produces the
half-open `[dateFrom, dateTo)` this needs.

**The question worth answering first is whether the ACTIVITY feed should exist at all at those
grains.** A line day feed would report ~3N machine-shift transitions, each labelled with a machine
AND a shift, which may be a log rather than a feed. The machine day feed reports its three child
shifts' transitions and that is already the maximum useful density. The staleness banner has no such
doubt — it is one boolean and it should exist.

**Where to start:** `apps/api/src/module/work-center/work-center-service.ts` — `getActivity` and
`getMetricsStaleness`, both currently shift-only, beside `resolveLineWindow` which already answers
the window question at all three grains.

**THE PRODUCT DECISION IS MADE FOR ONE SUBJECT (2026-09-08), and the SKU feed is
the precedent.** This entry asked "whether the ACTIVITY feed should exist at all at
those grains", worrying that a day feed "may be a log rather than a feed". At SKU
day grain the answer is YES: two arms and one line's worth of stops per day is a
feed, not a log. That does NOT settle the LINE day case, which is the harder one —
~3N machine-shift transitions, each needing a machine AND a shift label — but it
does mean the density argument has a worked example now.

**AND THE LINE CASE WAS SETTLED THE SAME WAY (2026-09-11):** yes, with the machine
day feed and the area day feed as the other two precedents, and the resolution was
to ADD the shift label rather than to filter the rows — "what makes the density
readable is the LABEL, not the count". See §60's status block.

**AND THE INVISIBLE HALF THIS ENTRY NAMED IS CLOSED FOR THE SKU ARM.**
`useEditDowntime` picked its activity key from FOUR cases and a SKU address fell
into the MACHINE PERIOD one — this entry wrote the trigger condition verbatim, "the
moment one exists, that arm must be filled in, and nothing will fail if it is not."
Both dispatches are now a `switch (subject)` with a `never`, and
`downtime-edit-dialog.test.tsx` asserts it THROUGH THE CACHE (`isInvalidated`),
because no spy on the fetchers can see which KEY was named. The line day/month arm
still resolves to `null` and still fails silently if a feed lands there.

**TWO MORE ITEMS BELONG HERE, both from the SKU work:**

1. **There is no `GET /products/day-reports/:id/metrics-staleness`**, so the SKU
   screen renders no stale-metrics banner and `useEditDowntime`'s SKU staleness arm
   is `null`. The hazard is identical to the one §50 closed for machines: the SKU
   report's OEE tiles, timeline and waterfall are PRECOMPUTED, so an operator
   moving a stop's CATEGORY leaves them showing the pre-edit split.
   `getCategoryEditedAt` narrowed by `product_id` is the sibling; the window is
   already resolved by `product-report-service`'s `resolveWindow`.
2. ~~**The LINE feed's downtime source reports a ZERO-MEMBER window as
   `no-stable-id`**~~ — **DONE (2026-09-11)**, and the reason it stopped being
   deferrable is worth keeping. It was a claim about records that do not exist
   ("these downtime records carry no stable identifier"), left alone because
   aligning it is "a visible copy change on a shipped screen". Adding the day and
   month feeds made that argument expire rather than overruling it: shipping two
   NEW screens carrying the wrong sentence and fixing it later is two visible
   changes instead of one. It now reads `tracked: true` on a stopless window,
   matching the SKU and area feeds.

**Depends on / blocked by:** nothing. The LINE activity half's product decision is
made (see the status at the top of §60); the banner and item 1 need none.

---

## 61. The Performance Trendline has no line-grain data — **TABLE AND CONTRACT DONE (2026-09-01), READ PATH OPEN**

**What:** ~~Roll `oee.product_perf_wu_hour` up by `work_center_id`~~ — **NO. That instruction was
wrong and migration `0018` is the correction.** A line is MEASURED, not summed, so a machine-summed
hourly curve would not integrate to the line's own shift and day totals — the same figures the
overview card renders at the top of the page the chart sits on. §17.1's argument one grain finer, and
worse: two numbers disagreeing can carry a footnote, a curve whose area disagrees with the tile above
it cannot.

`oee.product_perf_wc_hour` (migration `0018`, contract §19) is the answer and it exists. **What is
still open is the read path**: three endpoints over it, and `lib/perf-hourly.ts`'s quantity domain.

**Why:** The Losses page's **Performance Loss → Trendline** sub-tab renders at line grain today and
says it has nothing, which is honest but is the only empty tab on that page. The Losses CARD's hourly
`View` button is absent at line grain for the same reason.

**Context — the query is the easy half.** `product_perf_wu_hour` already has
`(work_center_id, business_date)` indexed, so the roll-up is a query rather than a table.

**The chart is the half that fails quietly.** `lib/perf-hourly.ts` plots `totalOut` and
`effectiveOut` against ONE shared `qtyDomain`, which is correct for a machine and wrong for a line:
migration `0014` puts `total_out` in the line's **INFEED** unit and `effective_out` in its **OUTPUT**
unit (`docs/gold-write-contract.md` §16.4a), because a line consumes bags and ships cartons. Reusing
the machine model as-is would put bags and cartons on the same scale and produce a chart that looks
entirely plausible. Two Y axes, or two stacked blocks — and the comment on `qtyDomain` says the same
thing from the other end.

There is a second, smaller trap: the roll-up needs the line's two uom triples ON THE HOURLY ROWS, not
just on the report, so the browser can tell which series belongs to which axis. Deriving them from
the line report instead would be correct today and wrong the first time a line changes its packaging
mid-month.

**Where to start:** `apps/web/src/lib/perf-hourly.ts` (the axis and join-key parameterisation is
already there — it is what lets one implementation serve a day's 24 hourly buckets and a month's 24
hour-of-day buckets), and `performance-loss-tab.tsx`, whose Trendline arm holds the empty state.

**Depends on / blocked by:** nothing. The empty state is honest in the meantime.

---

## 62. The Quality Pareto does not reflect operator-entered rejects — **SOURCE FIXED (2026-09-01), ENTRIES STILL OPEN**

**What:** Decide whether `oee.reject_count_wu_shift` — which backs the Quality Loss Pareto — should
include manual entries, and if so how.

**UPDATE (2026-09-01): the LINE half of this entry was worse than it described, and is fixed.** The
line's Pareto did not merely read "a different table at a different grain" — it read the MACHINE
table scoped by `work_center_id`, i.e. a machine-sum, while the Reject tile two cards above it read
the line's own count point. Migration `0019` gives the line `oee.reject_count_wc_shift` and contract
§20 is the request. What follows is the remaining, narrower problem: operator entries.

**Why:** As of §59 an operator can record a reject by hand, and it reaches the line's `reject` figure
through contract §18's override join. **It does not reach the Pareto**, which reads a counter table
rather than the report row. So once the pipeline adopts §18, the Losses
page will show a reject TOTAL that includes hand-entered quantities above a breakdown that does not
— and the gap will be exactly the entered amount.

The screen already carries a footnote saying the two do not match, and contract "Open risks" already
records that **nobody knows how far they diverge**. This makes the divergence bigger and, for the
first time, _attributable_ — which is what makes it worth fixing rather than tolerating.

**Context:** entries carry `reason_id`/`reason_name` from `ms_reject.reject_reasons`, and
`reject_count_wu_shift.reason` is a PLC COUNTER TAG with the master record only nullable beside it
(`0008`). So the two reason vocabularies are not the same thing, and a naive union would put an
operator's "Burst seal" beside a sensor's `Total_NG_Prod` as if they were peers.

Three options, none obviously right:

1. **A separate series on the same chart** — "entered by hand" as its own bar. Honest, and it makes
   the gap self-explaining. Costs a second read in `aggregateRejectRows`.
2. **Fold them in on `reason_name`.** Reconciles the total, and quietly asserts the two vocabularies
   are one.
3. **Leave it, and say so on the card.** Cheapest; the footnote already exists.

**IT NOW APPLIES TO A SECOND SCREEN (2026-09-08).** The SKU day report has the same two Add buttons,
so its Quality Loss Pareto — `oee.reject_count_wc_shift` widened over the day and narrowed by
`product_id` — has the same gap against its own Reject tile. Nothing about the three options changes;
what changes is that whichever is chosen has to be applied at both subjects, and option 1 ("a
separate series on the same chart") costs a second read in TWO places rather than one.

**Depends on / blocked by:** nothing technical. Worth deciding before the pipeline adopts §18, since
that is when the gap becomes visible.

---

## 63. Nothing enforces §18's override join on the pipeline's side

**What:** The two dbt tests contract §18.6 asks for — stranded entries at `warn`, override-not-applied
at `error` — live in this repo's documentation and nowhere else.

**Why:** If the pipeline owner never adopts §18, every operator entry is recorded, shown in the
ledger and the activity log, and **never reaches a reported figure**. Nothing in this service can
detect that: the write succeeded, the trail is intact, and the report is simply unchanged — which is
indistinguishable from "the DAG has not run yet", which is the normal state.

The ledger line on the card is the only user-visible signal, and it says "not yet included", which
stays true forever if the join never lands.

**Context / where to start:** a cheap first version is a readiness or metrics check in THIS service
— count live entries older than N days whose `(work_center_id, business_date, shift)` report row
exists and whose `reject_entered` (if §18's optional columns land) or whose figure has not moved.
That last part is the hard half: without those two columns there is no way to tell an applied entry
from an unapplied one by looking at Gold, which is itself an argument for asking for them.

**Depends on / blocked by:** §18 being adopted at all. File this as the thing that notices if it is
not.

---

## 64. A machine's day and month feed has no quality arm — **DONE (2026-09-11)**

**Status.** `listActivityForMachineTarget` — the `work_unit_id`-keyed RANGE sibling this entry asked
for — ships on `quality-entry-repository.ts`, and `getPeriodActivity` builds a real quality arm from
it at both coarse grains. `listActivityForMachine` is now a thin caller of it with the range
collapsed to one day and a shift named, so there is exactly ONE statement of "what a machine's feed
shows" (always including voided rows), the same arrangement `listActivityForTarget` has on the line
side.

**This entry's own prediction held exactly**: it asked for "`(work_unit_id, dateFrom, dateTo)` with
no shift — the same widening `listForTarget` already does for the line's ledger", and that is what
it is. The fragment is a SECOND one (`machineScoped`) beside `scoped` rather than a widened version
of it, and that is the one place in that file where a second statement of a predicate is right:
`scoped` states what belongs to a LINE's ledger — the rows the card totals and contract §18's
override join re-reads — while this states what an operator RECORDED AGAINST A MACHINE, which
structurally excludes a class of row (`work_unit_id` is NULL on a rework) that `scoped` must include.
Folding them behind a nullable scope would make that exclusion look like a filter somebody could
lift, and would make "neither scope given" — every entry in the plant — representable.

**`QUALITY_SOURCE` is gone, and its removal is the point.** That constant reported
`tracked: false, untrackedReason: "no-source"` and argued at length that the gap was "NOT a grain
problem" but a missing mutation path. Every word of that was true when written, and it became false
in two steps: `0017` gave an operator somewhere to record a reject AGAINST A MACHINE (fixing shift
grain), and this closes the coarse grains. Both feeds now build the arm from a real count, so there
is no constant left to reintroduce the claim.

**TWO THINGS THIS ENTRY DID NOT MENTION, and the second is the one that would have been missed.**

The first is the LABEL. A day feed spans three shifts, so two 120 BAG rejects against one machine on
different shifts are indistinguishable without one — the same problem the approval arm solved at
this grain with a nullable `shift`, and solved the same way. Null at shift grain, a number at the
coarse ones.

The second is that **the browser's own `ActivityEntry` union had no quality member at all**, and had
not had one since the arm shipped at shift grain. It rendered anyway — the panel's `FeedEntry` is a
union with `LineActivityEntry`, which picked the member up — so nothing failed. But `machineContext`
is typed against the narrow union and read `if (entry.kind !== "approval") return null`, so it could
not see a `shift` field its own type did not declare, and the suffix was silently dropped on exactly
the screens this entry is about. Two omissions, each hiding the other, neither visible to a test.
The type now declares the arm and `machineContext` tests `in` **and** `typeof` like its three
siblings.

**Rework still never appears, at any grain, and that stays structural rather than filtered**: the
dialog does not ask a rework which machine it was on, so the column is NULL and `work_unit_id = $1`
drops it. `quality-entry-repository.integration.test.ts` pins that over a range as well as over a
shift, so a dialog that starts asking cannot change the answer by accident.

---

## 64a. The original entry, for the reasoning

**What:** `listActivityForMachine` takes one business date and one shift, so the
machine SHIFT report's activity feed shows operator-entered rejects and the DAY
and MONTH ones do not.

**Why:** An operator recording a reject picks a machine, and §63's fix made that
visible on the machine's shift report. A day report for the same machine covers
the same three shifts and shows nothing — which reads as "no rejects were entered
this day" rather than "this feed does not carry them", and those are opposite
claims about an identical empty panel. It is the failure §8 names, one arm over.

**Context:** the read is scoped `(work_unit_id, business_date, shift)` because
that is how an entry is keyed. A period feed needs a RANGE variant —
`(work_unit_id, dateFrom, dateTo)` with no shift — which is the same widening
`listForTarget` already does for the line's ledger. The source arm at those grains
currently reports `tracked: false, untrackedReason: "no-source"`, which is now
wrong there for the same reason it was wrong at shift grain.

**Where to start:** `quality-entry-repository.ts`'s `listActivityForMachine`, and
`work-unit-service.ts`'s `getPeriodActivity`, which carries a comment marking the
gap.

**HALF OF IT IS DONE (2026-09-08), and the half that is left is now two lines.**
(The other half closed 2026-09-11 — see the status block at the top of §64.)
The RANGE variant this entry asks for exists: `listActivityForTarget(target)` on
`quality-entry-repository.ts`, taking a `TargetKey` with no shift — the SKU day
feed's quality arm reads through it, and the shift-keyed `listActivity` is now a
thin caller of it so there is exactly ONE statement of "what a feed shows"
(always including voided rows).

What remains is the `work_unit_id`-keyed sibling — the range read is keyed by
`work_center_id` and a machine feed needs its own — plus swapping `QUALITY_SOURCE`
for a real arm in `getPeriodActivity`. The `NO QUALITY ARM AT DAY OR MONTH GRAIN
YET` comment there is still accurate.

**Depends on / blocked by:** nothing.

---

## 65. The SKU/Product daily report — the time half has no source, and `0020` is only its first half

**What:** Build the SKU/Product **daily** report — one SKU, on one line, on one
business date. No shift grain and no month grain: the same SKU on the same date
gets one report **per line**, so "Line" is the breakdown axis rather than a
filter. The detail screen is specified as: business date, SKU name, download,
activity log, an OEE summary (OEE / A / P / Q / Achievement, Line {X} Production,
Finish Good in the output unit, Effective Prod, Runtime), a timeline bar, a
waterfall, a Losses card with its full Pareto drill-down page and reject/rework,
and a downtime table. **No hourly day-production chart** — deliberately, so §61's
line-grain Trendline is not on this path.

**Why it is filed now:** a SKU report is the first screen whose subject is neither
a machine nor a line, and it divides cleanly in two. The half that COUNTS is
nearly free; the half that involves TIME has no source at all.

### What is already sourceable — the count half

| Section                                          | Source                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Line {X} Production, Finish Good, Effective Prod | `oee.product_count_wc_day` (`0016`)                                                                                                                                   |
| Runtime, Performance                             | `oee.product_perf_wc_hour` (`0018`), summed per `(work_center_id, product_id)` over the day — `ideal_out` is the additive standard, `avg(ideal_rate_per_hour)` is not |
| Reject / rework counts                           | `product_count_wc_day`, plus the operator ledger (`0017`)                                                                                                             |
| Losses → **Quality** Pareto                      | `oee.reject_count_wc_shift` (`0019`) widened over a `business_date` range — `product_id` is already IN its primary key                                                |

All four carry `product_id` today. This half is a read path, not a schema change.

### What had no source, and what `0020` did about it

Availability — therefore OEE — plus the timeline, the waterfall, the six Losses
durations and the downtime table all need a stop attributed to a SKU, and
**nothing in Gold said which SKU was running when a line stopped.**

`0020` (2026-09-02) adds `product_id` / `product_name` to **both**
`oee.downtime_reports` and `oee.downtime_log_events`, and contract §21 is the ask.
That was the cheaper of the two options considered; the other was a fully measured
`oee.product_report_wc_day` carrying its own A/P/Q/OEE and loss durations, which is
what §16.10a(a) / §17.1 / §19 / §20 chose every previous time this question came
up. §21.1 records why the SKU axis is genuinely a different case: those four were
about a COUNT AT A COUNT POINT, where the line has its own counter; a stop is an
EVENT IN TIME, and the SKU axis is **occupancy**, not containment.

**The columns are NULL on every row and no writer fills them yet.** So the schema
half is done and the data half has not started.

### What remains, in order

1. **Contract §21's three questions** — which attribution rule (start-of-stop /
   majority-duration / NULL-unless-wholly-inside), whether the SKU is knowable
   from Silver at all, and whether `product_code` should join the pair. §21.3's
   constraint is not negotiable and is the thing to lead with: `source_event_id`
   is UNIQUE, so **a stop straddling a changeover is one SKU or none, never two
   rows.**
2. **Decide what Availability's denominator is per SKU.** With stops attributed,
   `runtime` (from `0018`) plus attributed downtime is a plausible planned time —
   but only once attribution is dense. Until then the ratio is not merely unknown,
   it reads 100%.
3. **The "not attributed" empty state**, which is §21.4's second consequence and
   the one that renders a wrong number rather than no number. A SKU read filtering
   `product_id = X` silently EXCLUDES unattributed stops, so per-SKU downtime
   does not sum to the line's and the residual is invisible. §8 and §14 are the
   template — distinguish "no stops" from "no attribution" the way those
   distinguish "no downtime" from "the ETL has not loaded".
4. **The addressing question, which is new.** All six existing reports are
   addressed by a `serial` id. `product_count_wc_day` has **no id column** — its
   key is composite `(work_center_id, business_date, product_id)`. So a SKU
   report's URL, its `ReportAddress` in `lib/report-subject.ts`, and its cache
   keys are a shape this codebase has never had. Decide it deliberately, given the
   six-independent-sequences hazard the existing ids already carry.
5. **`isLineReport` / `ReportAddress` gain a third subject**, and every shared
   component's "takes DATA, never a `subject` flag" rule gets its first real test
   with three subjects rather than two.
6. **Measure before indexing.** §21.6: the likely answer is a SECOND GiST index
   leading with `product_id`, never an edit to `dt_reports_span_gist`, whose
   expression every query repeats character for character — changing it silently
   unindexes the callers that do.

**Related:** §13 is elevated by this screen and should be read as part of it — a
wrong-but-positive `factor_to_base` was one row's problem at line grain and is the
WHOLE REPORT at SKU grain, because there is no sibling row to disagree with it.
§60's open product question ("is a day-grain feed a log rather than a feed?") lands
on this screen's activity log too, and harder: `…_approval_events` is keyed
`(work_unit_id, date, shift)`, so **a SKU has no approval events at all** — decide
what a SKU feed contains before building one. §62/§63 matter because
`work_center_quality_entries.product_id` is NULLABLE (`ck_wcqe_basis` requires it
only when the units differ), so an entry recorded without a SKU belongs to no SKU
report.

**ANSWERED 2026-09-02 (contract §21).** The attribution rule is **the SKU running
when the stop STARTS**. The SKU is known at detection time, though Silver holds
the product's EXTERNAL CODE and the pipeline resolves it through
`ms_core.product_code_alias`; `product_id` and `product_name` are guaranteed to be
written together. So step 1 of this entry is closed and nothing about the SKU
attribution is open on our side — what remains is the pipeline running at all.

**And one answer landed that this entry did not ask for and must not miss:
NO STOP CROSSES A SHIFT OR A DAY.** Flink forces `end_at` to the shift boundary
(contract §21's Q1 note). Two consequences for THIS screen: a SKU's downtime is
wholly inside one shift, so a day report is a clean sum over its shifts with no
straddle arithmetic; and the "not attributed" residual in step 3 is the ONLY
reason per-SKU downtime would fail to reconcile with the line's. See §73 for the
consequences elsewhere.

**Depends on / blocked by:** the pipeline writing `product_id` at all — which is
§18 again, the DAG has no repository, so the ask cannot be verified. The count
half is buildable now; the addressing decision (step 4) and §66/§67 need no
pipeline at all. The count half is buildable now; the time half is not, and shipping only
the count half means a screen with an OEE summary card that cannot fill its first
two tiles.

### SHIPPED 2026-09-08 — the screen, its ledger, and its feed

Steps 4 and 5 are answered, step 3 is delivered on three surfaces, and the ACTIVITY
LOG question this entry left open is decided. What remains open is the pipeline.

- **Step 4, the addressing question.** A SKU report IS addressed by a `serial` id
  after all: `0023` gave `oee.product_report_wc_day` one, so the URL is
  `/products/day-reports/:id` and the cache keys are the `sku-day-report-*` family
  — no grain in them, because there is one table. The composite key
  `(work_center_id, business_date, product_id)` never became an address.
- **Step 5.** `ReportAddress` is now a DISCRIMINATED UNION with a `sku` arm, and
  `QualityAddress` is a narrowing of it to the two subjects that have a quality
  ledger. The "takes DATA, never a `subject` flag" rule got its real test: the
  entry dialog became `quality-entry-view.tsx` with two thin callers, and its
  acceptance test is its IMPORT LIST.
- **Step 3, the "not attributed" empty state.** Delivered on the activity feed
  (an `unattributed` count beside the two arms), the timeline strip (which now
  WITHHOLDS the full-width green band under a product filter and says why), and
  the Downtime Details table ("no downtime has been ATTRIBUTED to this SKU",
  never "none recorded"). `/downtime-events` already had it.
- **THE ACTIVITY LOG QUESTION, ANSWERED: two live arms and a named third
  absence.** This entry said "a SKU has no approval events at all — decide what a
  SKU feed contains before building one." It contains downtime edits on the stops
  attributed to this SKU, and the operator's reject/rework. The approval arm
  appears in `sources` reporting a FOURTH `UntrackedReason`, `not-applicable`, and
  can never appear in `entries` — `ProductActivityEntry` has no such arm, so the
  compiler refuses one. Omitting the source entirely was the alternative and was
  rejected: the panel exists to separate "nothing was recorded" from "nothing
  COULD be recorded", and a reader who knows the other six screens carry approvals
  would otherwise be left to guess "half-built".
- **AND THIS ENTRY'S LAST PARAGRAPH IS NOW WRONG, so read it with this.** It says
  `work_center_quality_entries.product_id` is nullable, "so an entry recorded
  without a SKU belongs to no SKU report". The create dto requires `productId`
  UNCONDITIONALLY, so every row this service has ever written carries one — the
  per-SKU ledger excludes nothing and its totals RECONCILE to the line's. The case
  is unreachable through this app.
- **What is covered, and by which kind of test.** The two arithmetic-class claims
  went to the INTEGRATION suites, because the `fakeSql` harness matches SQL text
  and never executes it: `listDowntimeEdits` dropping the unattributed stop from
  both member counts while `countUnattributedDowntime` finds it, and — the one
  most worth having — **the per-SKU ledger totals summing to the line's**, which
  three comments assert and only a sum over real rows can prove. Both were
  mutation-checked: a product predicate written `IS NOT DISTINCT FROM` and a
  `count(*)` in place of `count(source_event_id)` each fail them.
- **Still open:** the pipeline writing `downtime_reports.product_id`. Until it
  does, every per-SKU downtime read is empty and the residual count is every stop.
  The dev seed (`0021_product_report_wc_day_dev.sql`) fills it locally and
  deliberately leaves one stop per shift NULL so the empty state is reachable.

---

## 66. `Achievement` is a hardcoded 0% and there is no target anywhere in Gold

**What:** Either give Achievement a real denominator, or make the placeholder an
explicit product decision instead of a constant with a comment.

**Why:** `apps/web/src/components/report/line-overview-card.tsx` defines
`ACHIEVEMENT_PLACEHOLDER = "0%"` and its comment is exact — it is _"the one figure
on this card with no column behind it… there is no target anywhere in Gold, not
per line, not per SKU, not per period."_ It renders in `text-muted-foreground`,
which is the only thing on screen separating it from a measurement.

That comment says the gap was **"filed rather than invented"**. It was not filed;
this entry is that filing, written after a search for `achievement` across `apps/`
and `docs/` returned only the constant, its test, and nothing else.

**Context:** a target is a fourth pipeline ask, and it is not obviously the
pipeline's at all — a production plan usually originates in an ERP or a scheduling
system rather than in Silver telemetry, so this may be a mes-master-data question
or a new upstream entirely. That is the thing to establish before asking for a
column. Note the reference design specifies "default to 0", so the current
behaviour is not a bug; it is an unfilled feature that looks like a measurement.

**Why it surfaces now:** §65's SKU report lists Achievement as a tile. It will
render the same muted 0% unless something changes, which is consistent and honest
— but it should be a decision taken twice deliberately rather than a constant
copied to a second screen.

**Where to start:** `line-overview-card.tsx:43-48` and its test at
`line-overview-card.test.tsx:161`, which pins the placeholder so it cannot change
silently.

**Depends on / blocked by:** a product answer on where a target comes from.
Blocks nothing — the placeholder is stable and labelled.

---

## 67. Download report is a placeholder on every report screen

**What:** Decide whether report export is a real feature, and if so where it runs.

**Why:** `apps/web/src/components/report/download-report-dialog.tsx` is the "…"
menu's Download item and it _"does not download anything yet"_. Its header states
the convention that separates it from its neighbours, which is worth preserving:
Regenerate and Adjust calculation are **disabled** because nobody has designed
them, while Download is **enabled and answers honestly** because it is a committed
feature with a known shape. The component issues no query and no mutation, and its
test asserts that — a stub that quietly called something would be worse than the
stub.

So this is not a broken button. It is a stated position, and it is the same
position on **seven** screens now — the six report ones and, since the OEE
Performance dashboard shipped (2026-09-15), Machine Monthly. On that screen it is a
BUTTON in the filter bar rather than a "…" menu item, for the reason the SKU note
below gives: one live action does not earn a dropdown of one.

**What has to be decided, and none of it is written down anywhere:**

- **Which columns.** A report detail screen is forty measures, several child
  tables and two units; an export is a different document from the screen, not a
  serialisation of it.
- **Server-streamed or client-built.** The dialog's header names this explicitly
  as undecided. It has consequences: a client build needs a new dependency (the
  repo has none — no `xlsx`, no `csv`, no `pdf` package in the catalog) and holds
  the whole payload; a server stream needs a new route, a content-type the
  `WebResponse` envelope does not cover, and a decision about whether the BFF
  proxies a non-JSON body.
- **Which grains and subjects.** SEVEN report screens as of §65, and the OEE
  Performance dashboard is an EIGHTH surface that is not a report — the mock's own
  Download button sits beside its filters. Its export is a different document
  again: six rates, six ranked losses and a daily curve, none of which is a row in
  any of the seven.
- **The dialog's own copy needs a pass when this is answered.** It reads
  _"Exporting a **shift** report is still being built"_ on every screen that mounts
  it, and only two of the eight are shift reports — the rest are day, month, SKU,
  area and now a monthly dashboard. Harmless while nothing exports, and wrong the
  moment somebody reads it as a statement about what they are looking at.

**Why it surfaces now:** §65's SKU report lists "download report" as a section.
Adding a seventh screen to a feature that does not exist on the other six is the
moment to decide, rather than shipping a seventh identical placeholder.

**AND THE SKU SCREEN SHIPPED WITHOUT IT (2026-09-08), which is worth recording so
the absence does not read as an oversight.** Its header now has an actions node —
Log Activity arrived — but Download is still not on it. One live action gets a
BUTTON rather than a dropdown of one; when this entry is resolved, that screen
grows the "…" menu and the button moves into it. `sku-report-actions.tsx` says so
at the top, and `sku-report-actions.test.tsx` asserts no Download and no overflow
trigger, so re-adding a placeholder is a test failure rather than a review catch.

**Depends on / blocked by:** a product decision on scope and format. Nothing
technical, and it blocks nothing — the dialog is honest as it stands.

---

## 68. `audits the write under the operator application_name` is nondeterministic

**What:** Make the audit assertion in
`apps/api/src/module/work-unit/work-unit-repository.integration.test.ts:1136` order
by something total. It currently passes or fails on physical row order.

**Why:** It is a real flake in CI's always-on integration suite, and it fails
looking like a regression in the audit trail — which is the one place a false
alarm is most expensive to investigate.

**The mechanism, confirmed against `postgres:18-alpine` rather than reasoned
about.** The assertion is:

```sql
SELECT table_name FROM oee.write_audit
WHERE application_name = 'mes-oee-monitor-operator'
ORDER BY at DESC
LIMIT 2
```

expecting exactly `approval_events` + `approvals`. Two facts make that a coin
flip:

- **`write_audit.at` is `DEFAULT now()`** (`0004`, carried into `0012`), and
  `now()` is TRANSACTION start time — constant for every row a transaction
  writes. So all of one `closeShiftReport`'s audit rows carry an identical `at`
  and `ORDER BY at DESC` cannot separate them.
- **One `closeShiftReport` writes THREE operator rows, not two.** The upsert
  fires the statement-level trigger AND the row-level one, so `approvals` is
  audited twice:

  ```
  at = ...620425+00 | work_unit_shift_report_approval_events | INSERT
  at = ...620425+00 | work_unit_shift_report_approvals       | INSERT
  at = ...620425+00 | work_unit_shift_report_approvals       | UPDATE
  ```

`LIMIT 2` over a three-row tie has three possible pairs and **only one of them
matches the assertion.** Observed both ways on the same commit: the file passes
run alone, the 7-file integration suite has been seen both green and red, and the
red diff is `["approvals", "approvals"]` against the expected pair.

**Not a schema drift and not `0020`.** Reproduced on a clean database with `0020`
removed, which is how it was found.

**The fix is the assertion, not the trigger.** Being audited twice for an upsert
is correct — `0004`'s triggers are deliberately statement-level for INSERT and
row-level for UPDATE/DELETE, and `0012` kept that. Options, cheapest first:

- order by `id DESC` instead of `at` — but check first whether identity is
  strictly increasing ACROSS the monthly partitions `0012` added, or the fix
  moves the nondeterminism rather than removing it;
- drop `LIMIT` and assert the DISTINCT set of `table_name` for the newest `at`,
  which states what the test actually means — "one operator write touched both
  tables" — rather than "exactly two rows exist";
- assert on `(table_name, operation)` triples, which additionally pins the
  statement/row trigger split that is currently untested.

The second is closest to the comment already above the query ("the payoff for the
distinct name: one query returns every operator write").

**Where to start:** `work-unit-repository.integration.test.ts:1143-1155`. The test
directly above it at `:1120` also calls `closeShiftReport`, so whatever replaces
`LIMIT 2` must still scope to one transaction.

**Depends on / blocked by:** nothing.

---

## 69. Move the downtime read paths off `date` — **DONE (2026-09-02)**

> **RESOLVED DIFFERENTLY, AND BETTER, THAN THIS ENTRY PROPOSED.** The narrowing
> was not re-pointed at `business_date` — it was **deleted**. `0013`'s
> `dt_reports_span_gist` serves the overlap directly, so the predicate that
> needed a sargable date column does not need a date column at all.
>
> That matters for three reasons beyond tidiness. It needs **no pipeline data**,
> so the step-1 blocker below evaporated — re-pointing at `business_date` could
> not have shipped, because it is NULL on every row and every downtime screen
> would have gone blank. It closes **§10's remaining half** ("index built, callers
> not yet unbound"). And it removes the seven-day horizon outright rather than
> moving it, which is what §41 was waiting on.
>
> **Shipped:** `DowntimeReaderRepository.scopeAndWindow` and
> `WorkUnitReportReaderRepository.shiftStops` — moved together, in one change,
> because a horizon kept by one and dropped by the other is a silent divergence
> between the Log Activity panel and the stale-metrics banner.
>
> **Measured, not assumed.** 200k rows on `postgres:18-alpine`: `Bitmap Index Scan
on dt_reports_span_gist`, 8 shared buffers, 1.1 ms. Old vs new predicate over
> one window, same fixtures:
>
> | stop                               | old                      | new                 |
> | ---------------------------------- | ------------------------ | ------------------- |
> | ordinary, inside the window        | kept                     | kept                |
> | ends before the window opens       | excluded                 | excluded            |
> | **open since three weeks before**  | **DROPPED**              | kept                |
> | **inverted (`end_at < start_at`)** | returned, then discarded | **excluded in SQL** |
>
> The last row is the one cost, and it is why §70 exists — see below.
>
> **Step 5 is now done too.** Contract §22.3 Q2 came back not merely permitting the
> drop but urging it while the table was empty, and `0022` took it — so `date` no
> longer exists and this entry is closed end to end. §71 has the details.

**What:** Once the pipeline writes `business_date` / `time_zone` on
`oee.downtime_reports` (`0021`, contract §22), move `scopeAndWindow`'s narrowing
onto the real date column, then retire `date`.

**Why:** `date` is `timestamptz` holding a business day — the type says instant,
the value is a day, and the only statement of that anywhere is a source comment
in `shared/shift-window.ts:70`. `0021` added the honest pair beside it and
deliberately changed nothing else, because retyping a populated column on a
forward-only migrator is unrecoverable and because the obvious backfill is wrong
(see below). This entry is the other half.

**Order, and none of it is safe out of order:**

1. **Wait for the pipeline.** Both columns are NULL on every row today. Every step
   below reads as "no rows" against an unwritten column, which is a plausible
   screen rather than an error.
2. **Run both predicates side by side first.** A stop whose `business_date` and
   `date::date` disagree is either a boundary bug in the load or a plant west of
   the migrator's session zone — and you want to know which BEFORE the old column
   stops being written, not after. This is a query, not a code change.
3. **Switch `scopeAndWindow`'s narrowing** from `date` to `business_date`. It is
   one Fragment in one file — that is the whole reason `shared/shift-window.ts`
   exists (§49's argument), and the reason a second copy of it must not appear.
4. **Re-measure the index.** `dt_reports_date_wu_idx` is
   `btree (date DESC, work_unit_id) WHERE end_at IS NOT NULL` and serves the
   narrowing being removed. The replacement is not automatically the same index
   over `business_date`: §10's GiST span index (`dt_reports_span_gist`, `0013`)
   was built to serve the overlap DIRECTLY, which would let the narrowing go
   entirely rather than be re-pointed. That is also §41's fix — the long-open stop
   that escapes the freeze — so the three should be decided together.
5. **Then, and only then, ask the pipeline to stop writing `date`**, and drop it.
   Contract §22.3 Q2 promises we confirm before asking.

**THE BACKFILL IS NOT A CAST, and this is the thing to carry forward.**
`timestamptz::date` resolves through the session `TimeZone`, so for a plant west
of it an instant near local midnight truncates to the PREVIOUS day — every
boundary stop moves, every window that should hold it stops holding it, nothing
raises. It is the same mistake `formatReportDate` vs `formatBusinessDate` guards
against in the browser, with DDL privileges: it does not render the wrong day, it
stores it. Contract §22.2 states this normatively and `0021`'s header records why
no backfill shipped with the columns.

**Related:** §46 is the same backfill one table over (`work_unit_shift_reports`,
still open) and the two should land together — they are one message to the same
owner. §41 and §10 are step 4's real subject. §21/§65 are why this became urgent:
a SKU report is keyed on a business date, so joining a `date`-typed-as-timestamptz
against a real `date` is a silent off-by-one rather than a type error.

**Where to start:** `apps/api/src/shared/shift-window.ts` — `MAX_OPEN_DOWNTIME_DAYS`
and the narrowing it documents at line 70.

**Depends on / blocked by:** nothing — closed. Steps 3 and 4 shipped without the
pipeline at all, by removing the need for a date column rather than re-pointing at
one; step 5 followed once the owner answered §22.3 Q2.

---

## 70. Inverted downtime rows are no longer detected by anything

**What:** Detect `end_at < start_at` in `oee.downtime_reports` as a property of
the TABLE, rather than as a side effect of one shift's timeline being drawn.

**Why:** §69 replaced the downtime membership predicate with a range `&&`
matching `dt_reports_span_gist`. That expression's `greatest(...)` collapses an
inverted row to an EMPTY range, and `&&` never matches empty — so malformed rows
are now filtered inside Postgres and never reach `clipToWindow`, which is what
used to count them into `downtime_rows_dropped_total`.

**Nothing on a chart got worse.** A negative-width bar never rendered before and
does not now; `0013`'s header called this "the same outcome the service already
produces, reached without an exception", and that is true of the strip.

**What got worse is the SIGNAL, and it got worse in the flattering direction.**
The `DowntimeRowsDropped` alert now fires only on a genuinely empty clip — an
open stop against a window that has not started — which is real but far rarer.
**A flat zero on that panel no longer means the data is clean.** It means nothing
tripped over it while drawing a strip. That is precisely the shape §8 and §14
exist to refuse: a screen that cannot distinguish "fine" from "not looked at".

**It was always the wrong home for this.** Whether the table holds inverted rows
is a fact about the LOAD. Tying its detection to whether somebody happened to
open a shift whose window overlapped the bad row meant a malformed row in a month
nobody browsed was never counted anyway. The rewrite made an existing weakness
total instead of partial.

**Options, cheapest first:**

- **A scheduled count.** `SELECT count(*) FROM oee.downtime_reports WHERE end_at
< start_at`, exported as a gauge. Needs somewhere to run it from — same
  question §35 hit with `pg_cron` and §42 with alert routing, so it may be worth
  answering all three at once.
- **A readiness/probe-adjacent check**, which needs no scheduler but puts an
  unbounded count on a hot path unless it is bounded by `loaded_at`.
- **A `CHECK` constraint.** The honest end state, and `0013`'s header explains
  why it was declined: the table holds live pipeline rows nobody has surveyed,
  and a constraint added blind fails Airflow's bulk load rather than a reviewer.
  Contract §3.2 already asks whether inverted rows should be rejected outright
  and that question is still open — **survey first, exactly as §40 did before
  constraining `reason`.**

**Where to start:** `apps/api/src/shared/observability/metrics.ts`, whose comment
on `downtime_rows_dropped_total` now records the narrowed meaning, and
`prometheus-alerts.yml` / `grafana/dashboards/oee-service.json`, both annotated to
say a zero is not reassurance.

**Depends on / blocked by:** nothing to survey. Acting on the survey may want
§35's and §42's scheduling answer, which is one conversation for all three.

---

## 71. Drop `oee.downtime_reports.date` — **DONE (2026-09-02)**

> **`0022` dropped the column and `dt_reports_date_wu_idx` with it.** Nothing
> replaces the index: `dt_reports_wu_idx` still covers `work_unit_id` and
> `dt_reports_span_gist` serves every windowed read since §69.
>
> **What it touched, which was less than expected and more than the code.** No
> production reader and no production writer — the only UPDATE this service issues
> sets category/reason/actions/detail_reason. The work was three integration
> fixtures and **two dev seeds**, and the seeds are the part a test run would never
> have caught: `vp test` does not execute them. Running them by hand found two
> occurrences that four greps had missed.
>
> **Both seeds got better, not just compilable.** `0007` filtered on
> `d.date::date = '2026-08-01'` — the exact session-zone-dependent cast contract
> §22.2 forbids for the backfill, sitting in a seed deciding which rows to rewrite.
> It now names the shift by its window with `AT TIME ZONE`, as `resolveShiftWindow`
> does. `0014` carried a header describing how that same cast had silently broken
> its own DELETE so a second run collided on `source_event_id`; its bounds are now a
> plain `business_date BETWEEN`, which is **unrepresentable as that bug**. Verified:
> the seed applies twice in a row cleanly, 80 rows, all with `business_date` and
> `time_zone`.

**What:** Remove the `date` column. It is `timestamptz` holding a business day,
superseded by `business_date` (`0021`).

**Why now rather than later:** the owner offered it unprompted when answering
contract §22 Q2 — _"jujur sebenarnya bisa sekarang karena belum ada data masuk,
ini masih didevelopment server. jika kamu berinisiatif untuk menghapus kolom
tersebut kamu bisa melakukannya sesegera mungkin."_ No data has landed, the
pipeline is still being designed, and carrying two columns that mean the same
thing costs more than removing one. Contract §23.4 makes the general form of that
argument: destructive changes on an empty development database are cheap, and
this is the last cheap moment.

**Nothing in this service reads it.** §69 removed the last read-path reader on
2026-09-02 — the `date` narrowing in `scopeAndWindow` and `shiftStops`. What still
touches it is write-shaped and mechanical:

- the column is `NOT NULL`, so every INSERT names it — the dev seeds, the
  integration fixtures, and `DowntimeWriterRepository` if it writes it;
- `dt_reports_date_wu_idx` is `btree (date DESC, work_unit_id) WHERE end_at IS NOT
NULL` and goes with the column;
- `0021` added a `COMMENT` marking it legacy, which goes too.

**Order:** confirm no INSERT outside tests still supplies it → drop the index →
drop the column → delete the fixture arguments. One migration, plain
`ALTER TABLE ... DROP COLUMN`, forward-only like everything else.

**The one thing to check before pressing:** `scripts/migrate.mjs` has no down
path, so this is recovered by hand or not at all. The owner's "no data" applies to
the DEVELOPMENT database. Confirm the same is true of whatever
`GOLD_DATABASE_URL` points at when the migration is applied — `0016`'s seed header
records that a guard once fired against a SHARED database and 18 rows landed
anyway.

**Depends on / blocked by:** nothing — done. It was authorised explicitly and done
while the table was still empty, which contract §23.4 says is the only cheap moment
for a destructive change.

---

## 72. An index on the SKU columns of `oee.downtime_reports`

**What:** Decide whether `product_id` needs an index, and if so which shape.

**Why it is filed rather than done:** `0020` deliberately shipped no index — it
would have been built over a column that is 100% NULL, which is `0007`'s reasoning
for declining one on `reason ->> 0` and §10's for waiting on row counts. Contract
§21.6 raised it with the pipeline owner, whose answer was to move it here:
_"Index Pada Kolom SKU: Tolong pindahkan ke TODO jika belum tercatat."_

**The shape is the interesting part, and it is not the obvious one.** A SKU report
filters `product_id` AND a time window AND a scope. The existing
`dt_reports_span_gist` is `gist (work_unit_id, work_center_id, tstzrange(...))`.

**Do NOT add `product_id` to that index.** §69's rule applies: every query wanting
it must repeat its expression character for character, and altering the index
silently unindexes every caller that does. A SECOND gist index leading with
`product_id` is the likely answer, and `btree_gist` is already installed (`0013`).

**Measure first.** §25's numbers are the precedent — the wide query was 2799 ms in
prose and 23 ms when actually run, and the difference decided the design. There is
nothing to measure until the pipeline writes the column.

**THERE ARE THREE CALLERS NOW (2026-09-08), not one**, which changes what has to be
measured rather than the answer. All three filter `oee.downtime_reports` on
`work_center_id` + a `business_date` range + `product_id`:
`aggregateDowntimeEventReasons`, `countUnattributedDowntime`, and the activity
feed's `listDowntimeEdits` members CTE — and the last of those is joined to
`oee.downtime_report_history`, so its plan is not the other two's. Note also that
none of the three uses the tstzrange expression, so the "do not touch
`dt_reports_span_gist`" rule is about the DOWNTIME module's reads and not these.

**Depends on / blocked by:** the pipeline writing `product_id` (contract §21).

---

## 73. The pipeline guarantees no stop crosses a shift — and several comments now overstate their case

**What:** Decide what to do with the straddle handling now that Flink forces
`end_at` to the shift boundary, and correct the comments that describe straddling
as a live case.

**Why:** answering contract §21, the pipeline owner described Flink's detection
procedure, whose last step is: _"Barang tidak terdeteksi sampai akhir shift.
UPSERT, downtime dipaksa menjadi end_at dan duration pada saat shift berakhir.
Tujuannya agar tidak ada downtime yang cross shift atau hari."_ **No stop crosses
a shift or a day.**

That was never stated before, and a good deal of this codebase is built on the
opposite assumption:

- `listApprovalsOverlapping` exists because "a stop straddling 23:00 belongs to
  BOTH shifts it touches", and the downtime freeze (§37) follows that rule
  deliberately;
- `clipToWindow` and the `clipDurationMs` Fragment split a stop's minutes across
  two windows;
- §41's residual — an approval far in the future failing to freeze a long-open
  stop — needs a stop that outlives its shift, which now cannot happen;
- §69's headline case, a stop open for three weeks, likewise.

**THE ANSWER IS ALMOST CERTAINLY "CHANGE THE COMMENTS, KEEP THE CODE", and the
reasoning matters more than the conclusion.** The guarantee belongs to another
team's stream processor. It can lapse without anyone here being told: a Flink
restart mid-shift, a backfill written by something that is not Flink, a
shift-calendar change applied to one system before the other. The straddle
handling is the difference between a right number and a wrong one in exactly those
cases, and it costs nothing while the guarantee holds. Contract §21.7 states this
back to the owner.

**What SHOULD change:**

1. **The comments.** Several describe straddling as the normal case that motivates
   the code. They should say the pipeline now forbids it and the handling is a
   backstop — otherwise the next reader concludes the guarantee does not exist.
2. **A straddling stop becomes a SIGNAL.** Today it is silently clipped. If the
   pipeline forbids it, one appearing means the guarantee lapsed, and that is
   worth counting — the same argument §70 makes about inverted rows, and probably
   the same mechanism.
3. **`MAX_OPEN_DOWNTIME_DAYS = 7` is now wildly over-provisioned** — an open stop
   cannot outlive its shift. It survives only in `listApprovalsOverlapping`
   (§41). Whether to reduce it to one shift, or drop that bound entirely, is
   §41's remaining product question and this answer makes it much easier.

**Depends on / blocked by:** nothing. Worth doing before the comments mislead
somebody into removing the backstop as dead code.

---

## 74. Area and factory reports, and the YEAR grain nothing has — **AREA SHIPPED, BOTH GRAINS (2026-09-10)**

**Shipped:** `oee.area_day_reports` (`0024`) and `oee.area_month_reports` (`0025`),
the `area-report` module behind two prefixes, and the `Report > Area > By Day` and
`By Monthly` list, detail, Losses and drill-down screens. Contract §25 and §26 are
the pipeline's asks; `scripts/seed/0022_area_day_reports_dev.sql` and
`0023_area_month_reports_dev.sql` are their executable forms.

**THE PRIOR QUESTION THIS ENTRY REFUSED TO PRE-EMPT IS NOW ANSWERED FOR AREA, AND
THE ANSWER IS THE OPPOSITE OF THE LAST FOUR MIGRATIONS'.** `0014`, `0016`, `0018`
and `0019` each answered "is this a measurement or a roll-up?" with a new table
because a line has its own count points. **An area has none, and no clock either.**
It is COMPOSED, not measured — and that is not an argument against a table, because
the RATES still cannot be composed by a reader: availability needs a planned
production time denominator nothing in Gold exposes, and an area OEE derived in the
API would sit one click from the line reports it drills into, disagreeing by an
unknown amount. `0023`'s argument, transferred.

**What being composed rather than measured actually changed** — two rules inverted,
both documented in `0024`'s header and contract §25:

- **The durations are LINE-milliseconds.** A five-line area's `runtime` on one
  business day is ~120 h. `0014` is explicit that a LINE's are its own wall clock;
  an area's cannot be, or its loss durations would not add.
- **The counts are a MASS, in one unit.** The members disagree about both sides, so
  weight (via `product_packaging.std_weight`) is the only unit that survives
  composition. The per-unit view the requirement also asks for is a read-time
  aggregate over `oee.work_center_day_reports` — exact addition within a unit, so
  §23.1 applies and it got no table.

**And one thing that needed no table at all:** `SCOPE_COLUMN` now maps `area_id`,
a column `0007` added in August whose own `COMMENT` recorded that it was "NOT yet
accepted". §25's cost objection to a wide Pareto was already answered by the
LIMIT / "Other" tail / server-side ranking the line grain shipped, so the timeline,
the Downtime Details table and all three downtime Paretos serve an area with no new
arithmetic.

---

**AND THE MONTH GRAIN ANSWERED A SECOND QUESTION THIS ENTRY DID NOT ASK.** `0016`
serves a month by WIDENING its day table and this could not, and the line between
those two cases is §15.5: durations and counts SUM, **rates are RECOMPUTED**. A
month's OEE is not derivable from its days' rows without redoing the recompute in
the reader, which would be a second definition of area OEE in the API, one click
from the day screens. So a REPORT table needs a month sibling and a COUNT table does
not — which is also why the per-unit Input/Output read still widens
`oee.work_center_day_reports` over a month rather than reading the line month rows.
Contract §26.1.

**Area is also the first subject where `{shift, day, month}` is broken by DECISION
rather than by absence.** The requirement is explicit — "only have 2 type of report
on the Area" — so `AreaGrain` is a two-member union in both apps, `ReportGrain` is
not reused, and a shift prefix cannot be registered by widening anything.

---

**STILL OPEN, and the remaining two are genuinely different questions:**

**1. Factory. THE YEAR GRAIN HALF IS ANSWERED — for the other three subjects.**
`0027` added `oee.{work_unit,work_center,area}_year_reports` for the OEE Performance
dashboard's yearly screens, and contract §27 states that as a deliberate widening of
§23.2 rather than leaving the pipeline owner to find three unasked-for tables.

**And the plumbing cost was a fraction of what this entry predicted.** It said a
fourth `REPORT_GRAINS` member "touches the window resolver, both coarse-grain loops
and every list screen's filter". Only the first was true, because NOTHING ELSE READS
THAT CONSTANT: the per-subject grain unions are declared locally and separately
(`PeriodGrain`, work-center's own `ReportGrain`, `AreaGrain`), and none of them
widened. A separate `CoarseGrain` per module is what reaches the year tables, which
keeps a year id out of the reads that have no year answer — the hour profile, the
performance chart, the activity feed — as a BUILD error rather than a 404. The
coarse-grain loops were not touched at all: year registers four routes in its own
block beside them, because a year report has an answer for four of their nine.

What `REPORT_GRAINS` gaining `"year"` DID widen, and it is more than the two Pareto
endpoints: `timelineInputBase` carries the enum and the TIMELINE and the paginated
DOWNTIME LIST both extend it, so `grain=year` is acceptable to all four. No screen
asks either of the latter two for a year; nothing refuses them either.

**Factory itself is untouched and the prior question is still unanswered for it.** A
factory-year that is a true sum of its months does not need a table; a factory
measured at its own points does. **Still ask before building** — and note the
question is now only about the TABLE, not about the grain.

**2. `factory` is the last unmapped `SCOPE_COLUMN` member — AND THE COLUMN HALF IS
DONE (2026-09-18). THE NAME WAS THE BUG.**

This said `oee.downtime_reports` needs its own column. Migration `0028` gave it
one, under a different name, and the rename is the substance rather than a detail:
**there is no `factory` in `mes-master-data`**. Its hierarchy is enterprise → site
→ area → work center → work unit, so the level above an area is a SITE. `factory`
was a local name for a level that already had one upstream, and it had propagated
into `DowntimeScope`, into `subject.ts` and into the web's `factoryId` over two
months. `0028` renamed `factory_id`/`factory_name` to `site_id`/`site_name` on all
five tables that had them — safe only because every one was NULL on every row, the
same licence `0013` used — and added `site_id` / `enterprise_id` to
`oee.downtime_reports` and `oee.downtime_log_events`.

So the objection this entry recorded is spent. What is NOT done is the code:
`DowntimeScope` still reads `"work-unit" | "work-center" | "area" | "factory"`,
`SCOPE_COLUMN` still maps three, and `requireSupported` still 400s the fourth. See
§85, which holds that work and is a mechanical change rather than a question.

**A factory REPORT is a different and still-unanswered question** — there is no
`oee.factory_*` table at any grain, which is (1) above and is what §81 is blocked
on. The column half and the table half were always separate and this entry ran
them together.

**Depends on / blocked by:** (1) an answer from the pipeline owner. (2) nothing —
the column exists; §85 is the follow-through.

---

## 77. `work_center_id 1` is a stale duplicate of line 1, and the dev screens show it as a second line

**What:** Remove `work_center_id 1` from the dev seeds, or confirm it is real.

**Why:** `0013` (lines 171-172) puts work units 3 and 4 on `work_center_id 1`,
`'Line 1'`, code `'L1'`. `0014` then re-seeded work unit 3 from the LIVE rows and
found it on `work_center_id 2`, code `'FI2-L1'` — the same physical line under the
id master data actually uses. `0008` carries the same stale trio.

So every Line screen in dev shows **two lines both called "Line 1"**, and they are
one line. `0015` already prints a NOTICE saying so and carries on:

> _work unit 3 appears under 2 different work_center_ids (1, 2). The Line screens
> will show it as that many separate lines, possibly under the SAME NAME._

`0014`'s own header names the failure mode: _"it produces a second, near-identical
machine … which is worse than an error because it looks like data."_

**Why it surfaces now:** the SKU daily report is broken down BY LINE, so the
duplicate is no longer one confusing row on a filter — it is a whole extra report
for every (SKU, date), sitting beside the real one with slightly different numbers
and the same name. `0020_second_line_dev.sql` added a genuine second line
(`work_center_id 3`, `'Line 2'`, `'FI2-L2'`, work unit 6, identities supplied from
`ms_core`), so the by-line case is now real — but the stale one is still there
beside it, and a reviewer sees three lines where two exist.

**What is NOT known:** whether work unit 4 (`'Vertical Packer S'`, `'VP-S'`) is
real at all, or which line it belongs to. `0014` only corrected work unit 3. That
question has to be answered before `work_center_id 1` can simply be deleted —
dropping it silently re-parents work unit 4 to nothing.

**Where to start:** `apps/api/scripts/seed/0013_day_month_reports_dev.sql:168-173`,
whose own comment says _"SECOND_WORK_UNIT: change id 4 here if master-data knows a
different one"_ — the invitation was already there. `0008_reject_count_dev.sql:57`
carries the same identity and must move with it.

**Depends on / blocked by:** one lookup in `ms_core` — is work unit 4 real, and
which work center is it on? Nothing technical. Everything downstream (`0015`
through `0021`) derives from these rows, so this is one edit and a re-run.

---

## 78. `area_id` is nullable on every source table an area report reads — **WIDENED AND SHARPENED (2026-09-18): IT IS NOW EVERY SCREEN, NOT THE AREA ONES**

**STATUS.** The question is unchanged and still open. What changed is the BLAST
RADIUS, and it went up by an order of magnitude, so the entry is re-headed rather
than closed.

Migration `0028` put `area_id` on every report table and the header area picker
became a REQUEST filter on all four subjects — machine, line, SKU and area — so
`area_id` went from "a column four tables had and two screens read" to **a
predicate on every list in the application**. The consequence below used to be
"excluded from that area's totals". It is now:

> **A row with a NULL `area_id` appears on NO SCREEN AT ALL.** Not under its own
> area, not under any other, and not in an unfiltered list — because there is no
> unfiltered list any more. The screen shows an ordinary empty state, which reads
> as "this area was idle" rather than "the label has not landed".

**What shipped alongside it, so this is not blocking today.**
`apps/api/scripts/seed/0028_ontology_backfill_dev.sql` derives the whole chain
inside Gold — `work_unit_id` → `work_center_id` (NOT NULL since `0003`) →
`area_id` (from `oee.downtime_reports`, as `0024`'s seed does) — and its step 5
REFUSES if any machine shift report is left without one. So development is
correct. Production is the pipeline's, and contract §28.4 is the ask, with the
sparseness question as its Q1.

**The decision in this entry is UNCHANGED and is the reason no residual count
shipped:** `area_id` is CONTAINMENT and `product_id` (`0020`) is OCCUPANCY OVER
TIME. A NULL here is a missing LABEL, derivable from `work_unit_id` permanently,
so the fix is a backfill; a NULL there is an attribution nothing can derive, so it
needs an `unattributed` count on every payload. Shipping the residual here would
invite a reader to treat lag as an attribution problem and would make it easier to
leave un-backfilled. **If the pipeline answers "it will stay sparse", that
inverts** — and then this becomes §21's shape after all, on far more screens than
this entry originally covered. Do not add half of it.

**What:** Ask the pipeline to backfill `area_id`, or accept that every report list
is a subset of its plant and say so on screen.

**Why:** five of the six reads behind the Area screens scope by a plain
`area_id = $` predicate — and since `0028`, so does every other report list. On
four of those five tables the column is NULLABLE:

| table                         | `area_id`     | added by |
| ----------------------------- | ------------- | -------- |
| `oee.area_day_reports`        | IS the key    | `0024`   |
| `oee.area_month_reports`      | IS the key    | `0025`   |
| `oee.work_center_day_reports` | yes, nullable | `0014`   |
| `oee.reject_count_wc_shift`   | yes, nullable | `0019`   |
| `oee.downtime_log_events`     | yes, nullable | `0009`   |
| `oee.downtime_reports`        | yes, nullable | `0007`   |

**A row with a NULL `area_id` is EXCLUDED from that area's totals, silently.** The
dev seed's step 0 prints a NOTICE counting them, and
`area-report-repository.integration.test.ts` pins the exclusion as correct
behaviour — but on a real database a sparse column reads as a low OEE, an empty
Pareto or a short SKU View, and nothing on screen says otherwise.

**WHY THIS IS _NOT_ THE `product_id` SITUATION, which is the reason it ships without
a residual count.** `0020`'s `product_id` is OCCUPANCY OVER TIME: NULL means "not
attributed", nothing can derive the answer, and the residual therefore has to travel
with every per-SKU payload. `area_id` is CONTAINMENT — the area IS derivable from
`work_unit_id`, permanently — so a NULL is a missing LABEL and the fix is a
backfill. Shipping a residual would invite a reader to treat denormalisation lag as
an attribution problem, and would make it easier to leave un-backfilled.

**If the answer is "it will stay sparse"**, then this becomes the SKU shape after
all: an `unattributed` count on each area read, and a sentence on the empty states.
Do not add half of that.

**Where to start:** contract §25.5 and its Q3. `SCOPE_COLUMN` in
`module/downtime/downtime.ts` carries the same note.

**Depends on / blocked by:** one answer from the pipeline owner.

---

## 79. The area activity feed's quality arm is one query per line — **COLUMN DONE (`0028`), FAN-OUT STILL OPEN**

**STATUS.** This entry offered two routes and called the column "the cheap fix".
`0028` took it: `oee.work_center_quality_entries` now carries `area_id` /
`area_name` (plus site and enterprise), and
`apps/api/scripts/seed/0028_ontology_backfill_dev.sql` fills it in development.

**It landed as part of the ontology migration rather than on this entry's own
merits**, which is worth saying because it means the COST ARGUMENT below was never
actually adjudicated — the column arrived for a different reason and this entry got
it for free. The fan-out is still there, unchanged: `AreaReportService.getActivity`
still resolves the area's lines and calls `listActivityForTarget` once per line.

**WHAT REMAINS, AND WHY IT WAS NOT DONE IN THE SAME CHANGE.** Collapsing the
fan-out means a SECOND scoping query in the quality-entry repository, beside
`listForTarget` — and that file's own comment says it is written the way it is to
leave "exactly ONE statement" of what the feed shows. Having the column does not
make a second statement cheaper to keep correct; it only makes it possible. The
trade below is unchanged and still wants a real reason to pay it.

**One thing `0028` DOES change about the calculus:** the column is now filled by
THIS SERVICE's write path, not by the pipeline (contract §28.5), so a NULL there is
our bug rather than denormalisation lag — which makes an `area_id`-scoped read
safer here than the same read would be on a pipeline-written table.

**What:** Collapse the fan-out using the `area_id` `0028` added, or widen
`TargetKey` to accept a set of lines — or leave it, which is still defensible.

**Why:** `AreaReportService.getActivity` resolves the area's lines and then calls
`qualityEntryRepository.listActivityForTarget` **once per line**, concurrently. N is
the area's line count — single digits to low tens — so the cost is one round trip's
latency and N small indexed reads, which is why it shipped this way.

**AT MONTH GRAIN EACH OF THOSE N READS IS ~30x WIDER**, which does not change the
fan-out's shape but does raise the payload: a month of an area's hand-entered
reject/rework, in one panel, unpaged. Nobody has looked at how many rows that is in
practice. If it turns out to be a lot, the answer is probably a limit on the feed
rather than the column below — the panel is a chronology and a reader wants the top
of it.

**What it bought, and why the alternatives were refused at the time.**
`oee.work_center_quality_entries` is keyed `(work_center_id, business_date, shift)`
and carries no `area_id`, and `TargetKey` names ONE line. Both alternatives — a
widened `TargetKey`, or a second scoping query in the quality-entry repository —
would put a SECOND statement of "what the feed shows" beside `listForTarget`, and
that file's own comment says it is written the way it is to leave "exactly ONE
statement" of it. Fanning out reuses that statement verbatim.

**When to do something about it:** if an area ever has enough lines for the fan-out
to be visible, or if the machine day/month feed (§64) needs the same widening — that
would make it a second caller, which is this repo's own trigger for promoting a
shape. The cheap fix is the column; contract §25.5 asks for it as optional.

**Where to start:** `apps/api/src/module/area-report/area-report-service.ts`'s
`getActivity`, and the `TargetKey` comment in
`module/quality-entry/quality-entry-repository.ts`.

**Depends on / blocked by:** nothing. It works; it is a shape worth revisiting on a
second caller.

---

## 80. An area report has no approval, and nobody has decided whether it should

**What:** Decide whether approving an AREA means anything, and if so what.

**Why:** the Area screens — at BOTH grains — ship with no Approve, no Reopen, no
Status tile and an activity feed whose approval arm reports `not-applicable`. The stated reason is that
`oee.work_unit_shift_report_approvals` is keyed `(work_unit_id, date, shift)` and an
area day has neither — but that is only half an argument, because a LINE has no
approval row either and cascades over its machines instead (§53).

**The other half, which is the real one:** an area cascade would close **every
machine shift report in the area**, across three shifts. §53 already noted that a
LINE approval "is not the permission 'approve the shift you worked' grants", and it
gave that its own role variable (`APPROVE_LINE_ROLE`) for exactly that reason. An
area's is that argument again one level up, and it would need a seventh and eighth
role variable.

**Three things follow if it is ever wanted:**

- it is `APPROVE_AREA_ROLE` / `REOPEN_AREA_ROLE`, not a reuse of the line's;
- the cascade is `summariseLineShift` over N lines times three shifts — **times ~30
  days at month grain**, which is where the question stops being about permissions
  and starts being about whether one click should write a thousand rows;
- the derived status is then a fraction over a denominator somebody has to be able
  to name;
- the activity feed's third source stops being `not-applicable` and becomes real,
  which means the panel starts carrying ~45 transitions for a five-line area — and
  `contextOf` would need the shift AND the line AND the machine.

**§48 is the same question at the machine day grain and is still open.** Answer them
together, or the app ends up with three definitions of "approved".

**Depends on / blocked by:** a product decision. Nothing technical.

---

## 81. The OEE Performance dashboard exists for one subject of four — **LINE AND AREA SHIPPED, ALL THREE YEARLY GRAINS SHIPPED (2026-09-16); FACTORY STILL BLOCKED**

**Shipped:** Machine Monthly (2026-09-15), then Line Monthly, Area Monthly and the
three YEARLY screens — `/oee-performance/{machine,line,area}/{monthly,yearly}`.
`0027` added the three year tables and contract §27 is the pipeline's ask for them;
`apps/api/scripts/seed/002{5,6,7}_*_year_reports_dev.sql` are their executable form.

**What predicted this correctly, and what did not.** The context below said a second
subject was "a tile list plus a route — the charts follow", and that was exactly
right: `reportWindowParams` already resolved all four subjects, so both donuts, all
three Paretos and the Six Big Losses card needed no API change at either new subject.
What it did NOT anticipate is that `trendQueryOptions` had to LEAVE the subject
registry rather than gain a grain parameter — at three subjects times two grains it
becomes a dispatch table routes index by key, and all six trend endpoints return an
identical envelope, so a wrong pick draws a plausible curve about another subject.

**STILL OPEN: FACTORY, and it is blocked on a TABLE rather than on a grain.** The
paragraph below that blamed `REPORT_GRAINS` is spent — it carries `"year"` now, and
the six shipped screens use it. What remains is that there is no `oee.factory_*`
table at any grain and `oee.downtime_reports` has no `factory_id`, so factory is
still the one unmapped `SCOPE_COLUMN` member and its three Paretos could not be drawn
even if a tile list were invented. See §74.

---

**The original entry, for the reasoning.**

**What:** Build the OEE Performance dashboard for the line, the area and the
factory. Machine Monthly shipped 2026-09-15.

**Why:** `docs/gold-write-contract.md` §23.2 names the dashboard for work unit,
work center, area **and** factory, as a second surface over the same tables. One
of the four exists.

**Context — two of the three are much closer than they look, and one is blocked.**

- **The trend endpoint already ships for all three.**
  `GET /{work-units,work-centers,areas}/month-reports/:id/oee-trend` are all
  registered and tested; `apps/api/src/shared/oee-trend.ts` is parameterised by a
  table pair and a scope column, so line and area were one registration each. The
  line and area routes therefore have **no consumer today**, which is deliberate
  and is the thing to reuse rather than rebuild.
- **What each subject still needs is a TILE LIST**, and that is the whole content
  of `apps/web/src/lib/oee-dashboard/subject.ts`. The registry is there so the
  second subject is an entry rather than a fork of the route and its three cards.
- **AN AREA'S ROW IS NOT SIX TILES, and this is the trap.** Migration `0024` gives
  `oee.area_day_reports` **no `teep` column at all**, and its header says why: TEEP
  divides by CALENDAR time and an area owns no calendar a reader could name — is it
  24 hours, or 24 times the line count? **Utility has the same denominator and the
  same problem**, so an area's row is FOUR tiles (OEE, A, P, Q), not six with two
  blanks. A blank would read as "not computed yet" when the truth is "this figure
  does not exist for an area". `subject.ts` types `tiles` as a list for exactly
  this reason; do not narrow it to a tuple.
- **FACTORY IS BLOCKED, not merely unbuilt.** There is no `oee.factory_*` table,
  and it is the one subject that needs a YEAR grain — `REPORT_GRAINS` in
  `apps/api/src/shared/shift-window.ts` is `["shift","day","month"]` and `z.enum`
  derives the DTOs from it, so a fourth member touches the window resolver, both
  coarse-grain loops and every list screen's filter. `factory` is also still the
  one unmapped `SCOPE_COLUMN` member: `oee.downtime_reports` has no `factory_id`.
  See §74, which holds both halves.

**What the second subject inherits for free**, because the dashboard's charts were
built over reads that already serve every subject: both donuts (arithmetic over the
report row), Schedule Loss and Pareto Quality Losses (the `PLANNED` and reject
breakdowns, which `reportWindowParams` already scopes per subject), Pareto Actions
(`/downtimes/by-action` takes the same three scopes `SCOPE_COLUMN` maps) and the
four-series trend. So a second subject is a tile list plus a route — the charts
follow.

**Where to start:** `apps/web/src/lib/oee-dashboard/subject.ts` (add an entry),
then a route beside
`apps/web/src/routes/_app/oee-performance/machine/monthly.tsx`. The sidebar node
in `app-sidebar.tsx` gains a sibling; no BFF change is needed, because
`/oee-performance` is already in `ALLOWED_PREFIXES`.

**Depends on / blocked by:** line and area, nothing. Factory, on §74 — a Gold
table and an answer from the pipeline owner about whether a factory-year is a true
sum of its months.

---

## 82. The **SIX** oee-trend routes ship with no metric instrument

**What:** Give `GET /{work-units,work-centers,areas}/{month,year}-reports/:id/oee-trend`
the `*_empty` counter and `*_rows` histogram every sibling sub-feed emits, and the
Prometheus rule and Grafana panel that must move with them.

**Now six, not three.** `0027` added the year grain at all three subjects, and the
year routes shipped with the same asymmetry deliberately rather than half-fixing it —
instrumenting three of six would leave exactly the inconsistency this entry exists to
remove. The `{ grain }` tag every sibling instrument carries is what makes one pair of
instruments serve both grains.

**Why:** Every other sub-feed on these three modules emits a pair — see
`getPeriodProductCounts`'s `product_count_empty` / `product_count_rows`, both
tagged `{ grain }`. These three emit nothing, so an OEE Performance dashboard
drawing an empty trend for every machine in the plant is invisible to monitoring:
the requests SUCCEED, which is exactly the case the `*_empty` counters exist for
(the same argument `master_data_cache_total{outcome="stale"}` makes).

**Context:** this was a deliberate scope trim during the plan review for Machine
Monthly, not an oversight. The root `AGENTS.md` requires three files to move
together — `apps/api/src/shared/observability/metrics.ts`,
`prometheus-alerts.yml` and `grafana/dashboards/oee-service.json` — and note a
histogram exports as `_bucket`/`_count`/`_sum` while a counter keeps its name
exactly. So adding one instrument is a three-file change, and doing it for one of
the three routes would leave the asymmetry it is meant to remove.

**Where to start:** `getMonthOeeTrend` in `work-unit-service.ts` and its two twins
in `work-center-service.ts` and `area-report-service.ts`; each already has the
`Promise.all` the emission would sit after.

**Depends on / blocked by:** nothing. Note §42 — nothing routes a firing alert
anywhere yet — so the alert half buys less than the dashboard half until that is
answered.

---

## 83. `wu_day_report_wu_idx` is redundant after 0026

**What:** Drop `oee.wu_day_report_wu_idx`, the single-column index on
`work_unit_day_reports (work_unit_id)`, once nothing is shown to depend on it.

**Why:** Migration `0026` added
`wu_day_report_wu_business_date_idx (work_unit_id, business_date DESC)` for the
OEE Performance trend's join. A btree on `(a)` is a strict prefix of one on
`(a, b)`, so the planner can serve every query the old index served from the new
one. Carrying both costs write amplification on every pipeline load and one more
thing to keep in mind when reading the table's index list — which already has
FIVE entries and a near-miss among them (`wu_day_report_wu_date_idx` is on `date`,
the `timestamptz`, not `business_date`; that near-miss is why `0026` exists).

**Context:** deliberately NOT done in `0026`, because "nothing else uses it" is a
claim that needs checking rather than asserting. The check is `pg_stat_user_indexes.idx_scan`
on a database that has served real traffic, which the development one has not.
Contract §23.4 makes destructive changes cheap until production, so this is
cheapest now and gets expensive the moment Gold is live — but it is also the least
valuable of the three, and it must not be done blind.

**Where to start:** `apps/api/src/shared/database/migration/0026_wu_day_business_date_index.sql`,
whose header records the same reasoning.

**Depends on / blocked by:** index-usage statistics from a database with real
traffic.

---

## 84. `workCenterIdFilter` and `productIdFilter` still 400 on an empty value

**What:** Give both the empty-string arm `shiftFilter` and (since 2026-09-18)
`areaIdFilter` have, in `apps/api/src/shared/report-filter-dto.ts`.

**Why:** `?workCenterId=` and `?productId=` answer **400**, not "no filter".
`z.coerce.number()` turns `""` into `0`, which fails `.positive()`. That is the
exact trap `shiftFilter`'s header has documented since §36 — its empty-string arm
sits ahead of the numeric check for this reason — and two of the five filters in
that file never got it.

**How it surfaced, which is the part worth carrying forward.** It was found by
writing a test, not by a report: adding `areaId` to the four list schemas and then
asserting `?areaId=` maps to `undefined` failed immediately, because the new
validator had been copied from `workCenterIdFilter` rather than from `shiftFilter`.
`areaIdFilter` was fixed on the spot — it is now on EVERY report request, so a
bookmarked URL with a cleared area would 400 the whole list — and the other two
were deliberately not widened on the way past, because that is a behaviour change
to two shipped filters made in passing inside an unrelated migration.

**Why it is not urgent.** The list screens clear a filter by DROPPING the value
rather than blanking it, so the browser never emits either key empty. The exposure
is a hand-edited or bookmarked URL, and the failure is a loud 400 rather than a
wrong page.

**Why it is worth doing anyway.** Five filters in one shared file, three of which
read `""` as "no filter" and two of which reject it, is a difference with no reason
behind it — and the file's own header says its purpose is that "two copies of a
coercion this small would not fail loudly, they would disagree". They do disagree.

**Where to start:** `apps/api/src/shared/report-filter-dto.ts`. Copy `areaIdFilter`'s
nested `z.pipe` shape. `work-unit-handler.test.ts` has the three-case `it.each`
(absent / empty / given) to copy for each.

**Depends on / blocked by:** Nothing.

---

## 85. `DowntimeScope` still says `factory`, and the column it wanted now exists as `site_id`

**What:** Rename the scope member `factory` → `site`, map it in `SCOPE_COLUMN`, and
delete the guard that exists only to refuse it.

**Why:** §74's second half was blocked on "a column on `oee.downtime_reports`".
Migration `0028` added `site_id` and `enterprise_id` to that table, and renamed
`factory_*` to `site_*` everywhere else, because **`mes-master-data` has no
`factory`** — its hierarchy is enterprise → site → area → work center → work unit.
So the API now names a scope for a level that exists in neither the schema nor the
ontology, and refuses it with a 400 whose stated reason ("there is no `factory_id`
column") is literally true and thoroughly misleading.

**What the change actually is, and it is bigger than a rename by one word.** With
`site` mapped, every member of `DowntimeScope` maps, and that makes the guard
machinery vacuous:

| today                                                        | after                             |
| ------------------------------------------------------------ | --------------------------------- |
| `SCOPE_COLUMN` is a `Partial<Record<DowntimeScope, string>>` | a total `Record<…>`               |
| `SupportedScope = keyof typeof SCOPE_COLUMN`                 | gone; `DowntimeScope` is the type |
| `isSupportedScope` / `requireSupported`                      | gone                              |
| an unmapped scope 400s at runtime                            | an unmapped scope FAILS THE BUILD |

The last row is the argument for doing it this way rather than leaving a dead
guard in place: a total record means adding a sixth scope without mapping it is a
type error, which is strictly better than the 400 it replaces.

**What it touches:** `downtime.ts` (the union, `SCOPE_COLUMN`, two exports),
`downtime-dto.ts` (the `z.enum`, two comments), `downtime-handler.ts` (four
`requireSupported` call sites), `downtime-repository.ts` (one type import), the web's
`lib/api.ts` (which narrows the scope so a screen cannot ask for the unserved one)
and `lib/oee-dashboard/subject.ts` (two comments asserting `factory` has no
`SCOPE_COLUMN` entry). Plus five handler tests currently asserting a 400 for
`scope=factory`, which should become one asserting the four scopes are all served.

**Why it was NOT done with `0028`.** `0028` and the area filter were about making
every report list area-scoped; this is a public API change to a query parameter on
six endpoints, with no screen asking for it. Doing it in passing would have meant a
scope rename buried in a migration commit. It is mechanical and it is a decision,
so it gets its own entry and its own change.

**One thing to decide while doing it:** whether `enterprise` becomes a fifth scope
at the same time. `0028` put `enterprise_id` on `oee.downtime_reports` too, so it is
equally mappable — but nothing asks for it, and §23.1's "do not over-table" applies
at scope scale. The default should be no.

**Where to start:** `apps/api/src/module/downtime/downtime.ts:31`, and §74's
updated second half.

**Depends on / blocked by:** Nothing. The column shipped with `0028`.

---

## 86. The quality-entry write path does not fill its ontology columns, and a backfill is impossible

**What:** Decide where `recordEntry` learns the area, and fill `area_id` /
`area_name` (and `site_*` / `enterprise_*` if they are ever resolved) at INSERT
time on `oee.work_center_quality_entries`.

**Why it cannot wait for a backfill.** `0017`'s `wcqe_append_only()` trigger
compares the WHOLE ROW as jsonb minus the four void columns, so **there is no
subset of columns an UPDATE may touch**. Every entry recorded before this is fixed
keeps a NULL `area_id` permanently. That is not a flaw in the trigger — `0017`'s
header anticipates exactly this: "a repair script cannot clean this table either.
That is accepted. A bad row is voided."

**How it was found, which is worth recording.** `0028_ontology_backfill_dev.sql`
shipped with an UPDATE against this table and was refused by the trigger on its
first run against a real database — the seed's own author had written the
append-only rule into the root `AGENTS.md` and then written an UPDATE anyway. The
seed no longer attempts it and says why; contract §28.5 carries the same
correction so the pipeline owner is not told the column arrives populated.

**The actual decision, and it is why this is an entry rather than a patch.** The
write path does not know the area. `TargetKey` names a LINE, and the two ways to
resolve one are not equivalent:

|                                                    | cost                   | failure mode                                                                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `masterDataClient` lookup                          | one upstream HTTP call | **FATAL on an operator WRITE.** The write path currently makes none — the line cascade had one removed for exactly this reason (§53, commit `4fccce8`'s neighbourhood). A master-data blip would refuse an operator's reject entry. |
| scalar subquery on `oee.work_center_shift_reports` | free, same transaction | NULL when the DAG has not written the line's row yet — which is precisely when an operator is most likely to be entering a correction.                                                                                              |

The subquery is probably right, and it should read the SAME
`(work_center_id, business_date, shift)` the entry is keyed on rather than "any row
for this line" — an arbitrary row would attribute the entry to whatever area that
line sat in on some other date. But "NULL when the report has not landed" needs to
be an accepted answer before it is built, and it is the same NULL this column was
added to avoid.

**Why it is not urgent:** nothing reads the column. TODOS §79 is the read that
would, and it is still open on its own merits.

**Where to start:** `recordEntry` in
`apps/api/src/module/quality-entry/quality-entry-repository.ts` (the 29-column
INSERT), `0017`'s trigger for why there is one shot at it, and contract §28.5.

**Depends on / blocked by:** An answer on whether a NULL `area_id` is acceptable
when the line's shift report has not been written yet.

---

## 87. Un-hide the Dashboard once `/` has something to show

**What:** Three demo-driven hides to undo together, or to make permanent
deliberately: the Dashboard nav row (commented out in
`apps/web/src/components/layout/app-sidebar.tsx`), the `/` landing page (now a
`beforeLoad` redirect to `/oee-performance/machine/monthly` in
`apps/web/src/routes/_app/index.tsx`), and — the older one this sits beside —
the Report → SKU nav row hidden in the same file.

**Why:** `/` rendered a placeholder card that said "no dashboards yet" and named
an API path, which is the first screen an operator saw after signing in. For a
demo the OEE Performance machine-month screen is a better landing than a
placeholder, so `/` redirects there rather than being deleted: `/` is the BFF's
`DEFAULT_RETURN_PATH`, /login's own fallback, and where both `ErrorState` and
`NotFoundState` send "Back to home". Deleting the route would 404 all four.

**Context:** the post-login destination is therefore set in the WEB app, not in
the BFF. `ALLOWED_PREFIXES` in `apps/bff/src/module/auth/auth-service.ts` is
untouched and still decides only which deep links may be returned to — a plain
sign-in still resolves to `/` and is redirected from there. Nothing else in the
repo hardcodes the machine-month path as a destination.

**Where to start:** un-commenting the nav row is half the change; the route needs
a `component` back in the same commit, or the row points an operator at a link
that bounces them somewhere else.

**Depends on / blocked by:** a decision about what `/` should be — the original
comment there sketched a `loader` that prefetches the first widget's query.
