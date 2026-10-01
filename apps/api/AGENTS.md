# AGENTS.md — `apps/api`

`CLAUDE.md` is a symlink to `AGENTS.md` — one file, both agents. Edit either; it is the same bytes.

This file loads when working with files under `apps/api/`. It was split out of the repo-root
`AGENTS.md` so the root file stays small enough not to trip the large-memory-file warning; the
root still holds everything cross-cutting — the Gold schema's purpose, the medallion tiers and
who writes them, the operator-mutation rules, CI, and testing conventions. **Read the root file
too** — the Gold write contract and the medallion-tier table are the premises most of what
follows depends on.

## `api` — module layout

`src/module/<feature>/` is one vertical slice, always the same files:
`<feature>.ts` (domain types) · `-dto.ts` (Zod validators) · `-handler.ts` (Hono routes) ·
`-service.ts` (orchestration, metrics, error mapping) · `-repository.ts` (SQL) ·
`-module.ts` (Awilix registrations). `work-unit` and `downtime` are the canonical pair; `work-center`
is the leanest complete example, and the shape of its writer is the interesting part: it registers
one, but **that writer touches no `work_center_*` table**. Approving a line closes the MACHINE shift
reports on it, in `oee.work_unit_shift_report_approvals` — which is keyed
`(work_unit_id, date, shift)`, a key those tables cannot supply. Its **read** path still makes zero
upstream calls (every field is a column), which is why the approval summary is a separate route
rather than a field on the detail payload. The two modules with no Gold table
of their own diverge for a reason worth knowing — `health` has no dto or
repository (its dependencies are `Probe`s), and `master-data` reads an upstream service instead, so
its "repository" is `-client.ts` behind `-schema.ts` (where IANA zone validation now lives) plus
`-error.ts` and `time-zone-resolver.ts`. Cross-cutting code goes in `src/shared/` — see
`src/shared/README.md`, though note its table is partly stale: `helper/`, `network/`, `util/` and
`middleware/` have moved out into `packages/` and `@molca/mes`. `shared/` also holds six things
lifted out of modules once a second caller appeared, each with a header explaining why:
`shift-window.ts` (the three shift boundaries and `scopeAndWindow`), `actor.ts`,
`report-filter-dto.ts` (the Zod fragments every report list shares — including the `?shift=`
empty-string arm that must sit ahead of the numeric check, which is why one copy matters),
`loss-aggregate.ts`, `database/watermark.ts` and `product-count.ts`. The last three came with the
line's Losses and SKU reads and two of them are worth a note — and `report-window.ts` gained a
split with the AREA grain that is worth a third:

- `report-window.ts`'s two halves now serve DIFFERENT numbers of subjects. `inDateRange` takes a
  bare `DateRange` and serves all four, so the half-open `>= from AND < to` rule — the one thing
  in that file that renders a plausible number when it is wrong — has one statement. `scopedRows`
  still hardcodes `j.work_center_id` and serves the three subjects scoped by a line; the area
  reader writes its own `WHERE`, because its scope column is `area_id` and one of its three source
  tables does not carry it. Widening `scopedRows` with a scope-column parameter was the obvious
  move and the wrong one: it turns a helper that states ONE predicate into one that composes any
  predicate.

- `loss-aggregate.ts` was a MOVE, not a rewrite. `aggregateRejectRows` and `aggregateEventPairs` were
  already parameterised **by a Fragment** — they were written to take their row source — so the
  line's version is a new `WHERE` and **no new arithmetic**. The unit guards, the generated-column
  read and the `count(*)`-not-`count(column)` rule stay in one statement each. Its type derivation is
  INVERTED from the usual direction: the aggregate is the primitive and the module payload types add
  the envelope, so a module cannot quietly widen what the shared function returns.
- `database/watermark.ts` replaced four identical copies of `getWatermark`. The table name is now a
  **bound param**, so a unit test asserts `.params` rather than SQL text.

Wiring: `src/cmd/container/container.ts` builds the Awilix container in **PROXY mode with
`strict: true`** — every name a constructor destructures must appear in the `Cradle` type _and_ be
registered, or it throws at resolve time rather than at boot. `src/cmd/api/app.ts` mounts handlers
under `/api/v1` and owns the global error mapping (`mapDomainError` → `WebResponse`).

Modules never import each other's internals. Cross-service and cross-module calls go through
`@molca/contract-client` interfaces — `MasterDataClientContract` is the port, `MasterDataClient` its
HTTP impl; swapping in gRPC or in-process touches no call site.

Endpoints: `/health/liveness` and `/health/readiness` — the latter probes Keycloak, Gold **and**
Silver, and all three gate readiness, so an outage of the shared TimescaleDB takes this API out of
rotation (deliberate: a monitor that cannot read telemetry is not serving its purpose). The snapshot
is cached 5s and single-flighted. Under `/api/v1`:

- `work-units/shift-reports[/:id[/products|performance|rejects|downtime-events|activity|metrics-staleness]]`,
  plus `POST .../:id/approve` and `POST .../:id/reopen`
- `work-units/day-reports[/:id[/products|performance|rejects|downtime-events|activity]]`
- `work-units/month-reports[/:id[/products|hour-profile|oee-trend|rejects|downtime-events|activity]]` — and
  both coarse feeds carry **three live arms** since §64: the approval one reports the period's CHILD
  shifts' transitions (each labelled with its shift, because the events table is keyed
  `(work_unit_id, date, shift)` and there is nothing to sign at these grains), the downtime one
  needed no widening at all (`listShiftDowntimeHistory` was already a window), and the quality one
  reads `listActivityForMachineTarget` — the `work_unit_id`-keyed RANGE sibling of the read the SKU
  day feed uses. It replaced a `QUALITY_SOURCE` constant reporting `no-source`, whose sentence says
  "this feed does not carry them" on a machine whose own SHIFT report showed the operator's entry.
  A rework still never appears at any grain, structurally: it carries no `work_unit_id`.
- `work-centers/{shift,day,month}-reports[/:id[/products|machines|rejects|downtime-events|performance|hour-profile|activity]]`
  plus `work-centers/month-reports/:id/oee-trend` — the
  LINE grain, plus `POST work-centers/shift-reports/:id/{approve,reopen}` and
  `GET work-centers/shift-reports/:id/{approval,metrics-staleness}`.
  **`activity` moved INTO the grain loop (§60) while the other three stayed out of it, and the split
  is the point.** Approve, reopen and `approval` are shift-only because a day approval would cascade
  over three shifts as well as N machines — an authority nobody has granted (§48); `activity` is not,
  because READING what happened over a window grants nothing. The old reason given for pinning the
  feed to shift grain — "both its arms scope by a shift window over the roster" — was half true: the
  downtime arm was always a plain `[from, to)` instant window that never read a shift, and only the
  approval join narrowed by one, so `machineReports`'s `AND r.shift = $n` became conditional and
  nothing else in the read changed. `metrics-staleness` IS still shift-only, and now for the
  honest reason: nothing coarser has been built (§60's other half). Two more things the widening
  needed. `LineActivityWindow` is `LineShiftKey` with `shift: number | null` — a SEPARATE type, not
  a nullable field on the cascade's key, because a null there would mean "close every shift in the
  window". And the feed's approval-arm member count now comes from the reader's
  `countMachineReports`, through the SAME fragment that arm joins against, rather than from the
  writer's `summariseLineShift` — which requires a shift because a cascade does, and whose job is to
  keep a badge and a 409 agreeing, which the feed has no part in.
  `machines` is Machine View's read, and its ONE asymmetry is worth knowing before touching it: at
  shift grain it resolves the line's roster from mes-master-data, because
  `work_unit_shift_reports` has no `work_center_id`; at day and month `0013`'s column makes it a
  plain predicate and **zero upstream calls**. Smoothing that over would mean adding a roster call
  the coarse grains do not need.
- `products/day-reports[/:id[/rejects|downtime-events|activity|machines]]` — the SKU grain, and
  **one grain only**: `oee.product_report_wc_day` (`0023`) has no shift or month sibling, so a
  shift-grain SKU report would need a table that does not exist. Its `activity` feed carries **two
  live arms and a named third absence** — downtime edits on the stops attributed to this SKU, the
  operator's reject/rework, and an approval source reporting `not-applicable`, because
  `oee.work_unit_shift_report_approvals` is keyed `(work_unit_id, date, shift)` and this grain has
  neither. That is a fourth `UntrackedReason` and the browser's `NOT_TRACKED_BODY` is a TOTAL map
  over the list, so the web half must ship first or a reader gets a blank box. `machines` here is a
  **ROSTER** for the reject dialog's provenance picker — `{workUnitId, workUnitName}` off
  `oee.work_unit_shift_reports`, scoped on `date` because those tables' `business_date` is nullable
  and unbackfilled (§46) — and NOT the line's per-machine measures breakdown, which stays absent
  for §15's reason. There is no `metrics-staleness` at this grain yet (§60).
- `areas/{day,month}-reports[/:id[/products|production-units|rejects|downtime-events|activity]]`
  plus `areas/month-reports/:id/oee-trend` —
  the AREA grain, **two grains and no more**: the requirement is explicit ("only have 2 type of
  report on the Area"), so `AreaGrain` is a two-member union rather than a reuse of `ReportGrain`
  and a `/shift-reports` prefix cannot be registered by widening anything. The six ID-ADDRESSED
  routes are ONE implementation behind two prefixes, registered from a loop; **the two LIST routes
  sit OUTSIDE it**, which is the same call work-center's handler makes about its writes — the month
  list does not accept a `month` param at all ("Monthly Report (Show all month on selected year)"),
  so the two have different validators and therefore different validated shapes. Folding them in
  makes `c.req.valid("query")` a union whose `month` is reachable only through an `in` check that
  narrows to `unknown` and then needs a cast, and the cast is exactly where a future edit could
  start reading a month at month grain. `oee.area_month_reports` is a SEPARATE TABLE (`0025`)
  because a month's rates cannot be got by widening a day's — §15.5's SUM-vs-RECOMPUTE line, and
  the same reason `oee.work_center_month_reports` exists beside its day sibling. **`production-units` is the one endpoint no other subject has**, and it exists
  because the requirement asks two things that pull apart: one headline production figure (a MASS,
  the only unit an area's member lines can all be expressed in) and a breakdown across every unit
  those lines actually count in. The report row answers the first; this is a read-time aggregate
  over `oee.work_center_day_reports` grouped by its own TWO unit triples — two independent
  groupings on the wire, never one list with a `side` field, because a single list invites a total
  and totalling across the sides is the arithmetic `0014` forbids. It ships the two per-side
  residual counts beside them: a line whose unit the pipeline never resolved contributes to no
  bucket and is otherwise silently absent. `products` is a genuine ROLL-UP over the area's lines,
  which is right here and forbidden one grain down (§17.1) — summing within one unit is exact, and
  the card above is in mass, so there is no shared figure to disagree about. It is also the ONE
  read whose source (`oee.product_count_wc_day`) carries no `area_id`, so it resolves the area's
  lines first, from the pipeline's own attribution on `oee.work_center_day_reports`. What the grain
  deliberately does NOT have: **no `approve`/`reopen`/`approval`** (no key, and no cascade — closing
  every machine shift report in an area is not a permission any role variable grants), **no
  `quality-entries`** (an entry is keyed by LINE; the requirement says "no add reject/rework"), **no
  `machines`**, **no `performance`/`hour-profile`** (there is no area hourly table, and an
  area-summed curve off the line's would be the roll-up §19.1 refuses) and no `metrics-staleness`
  (§50, §60). `activity` DOES exist, with two live arms and the approval one reported
  `not-applicable` — and that absence needs the STRONGER argument, because unlike a SKU day an area
  day has child records it could report: the answer is that an area report is not approvable at
  all. Its quality arm **fans out one `listActivityForTarget` per line**, concurrently, rather than
  growing a second scoping query in the quality-entry module — that file's own comment is that it
  exists to leave "exactly ONE statement of what the feed shows". **The feed serves BOTH grains
  unchanged**, which was once the contrast with the line's shift-only one and is now simply the
  norm — every report subject serves a feed at every grain it has (§60, §64). What is still
  particular here is that neither area arm needed a conditional predicate: both scope by a
  business-DATE RANGE, so a month is the same query with a wider end. The GRAIN decides exactly one thing in the service —
  `resolveWindow`'s `dateTo`, the next day or the first of the next month — which is why
  `AreaWindow` carries no grain and none of the six source reads takes one.
- `work-centers/{shift,day,month}-reports/:id/quality-entries` **and
  `products/day-reports/:id/quality-entries`** — the operator ledger, plus `POST` to record one and
  `POST .../:entryId/void` to correct it. All three LINE grains plus the SKU day, because each of
  those screens asks the operator for whatever the report does not already know; **every entry is a
  shift-keyed row whatever screen produced it**, which is what lets contract §18 be ONE dbt join. A
  per-SKU entry is not a per-SKU ROW — it is the same row with `product_id` filled in.
  **TWO HANDLER FACTORIES, not one with a prefix parameter**: a parameterised factory mounted at
  `/products` would also register `/products/shift-reports/:id/quality-entries`, resolving a LINE
  report id under a SKU prefix and answering 200 with another line's ledger.
- `downtimes[/|/timeline|/by-reason[/detail|/history]|/by-action]`, plus
  `PATCH downtimes/:sourceEventId`. **`by-action` is a SIBLING of `by-reason`, not a
  mode of it**, and the difference is one parameter: it takes NO `category`,
  because an action is what somebody DID about a stop and "Replace Belt" is the
  same action whether the stop was planned or not — splitting it by operation type
  would scatter one action across three charts and rank none correctly. It groups
  on the FIRST action only, exactly as `primaryReason` takes the first reason, and
  for the sharper version of that reason: `actions` is an array an operator edits,
  so crediting each of several the stop's whole duration would make the bars sum to
  MORE than the window's downtime, and a Pareto's cumulative line is a share that
  stops meaning anything past 100%. Splitting the duration evenly would keep the
  total and invent a number nobody measured. The cost — a second action on a stop
  contributes nothing — is real, and the browser's card states it. It returns
  `DowntimeReasonBreakdown` minus `category`, so the browser ranks and draws both
  Paretos with ONE implementation; the `other` tail is folded by a shared
  `paretoTail`, because two copies would let one chart's cumulative line close at
  100% and the other's not. There is no `/by-action/detail`: nothing drills in yet,
  and an unused drill-down is a second copy of the selector plumbing to keep in step.
- `master-data/areas|work-centers|work-units|downtime-reasons|downtime-actions|reject-reasons|products[/:id]`,
  plus `POST master-data/downtime-actions`. The last two back the entry dialog, and
  **`products/:id` is the conversion basis**: there is no global uom-to-uom table anywhere in this
  system, so a product's `packages[]` IS the unit catalogue and each option carries its own
  `factorToBase`.

**EVERY REPORT LIST TAKES `areaId`, AND `shared/area-scope.ts` IS THE ONE STATEMENT OF IT.**
`0028` put `area_id` on every report table and the web app's header picker became a request filter
on all four subjects, so `/work-units/{shift,day,month,year}-reports`,
`/work-centers/{shift,day,month,year}-reports`, `/products/day-reports` and the two `/areas/*` lists
all accept it. Three things about it are worth knowing before touching a list read. It is a **plain
column predicate**, NOT resolved into an id list the way `workCenterId` is on `/work-units/*` —
that path costs one to two upstream HTTP calls, FATAL on failure, and answers "which machines are in
this area NOW" where the column answers "which area did the pipeline attribute this row to", which
is the historically correct side of TODOS.md §55's question. It **stacks** with every other filter
rather than replacing one, so a page can be narrowed to one line inside the selected area. And the
same validator serves two different meanings — on `/areas/*` the area is the SUBJECT and `area_id`
is the grain KEY, everywhere else it is a denormalised LABEL that can be NULL — which is why
`areaIdFilter` is in `shared/report-filter-dto.ts` and the predicate is in `shared/area-scope.ts`,
one file per half. `areaIdFilter` is also the SECOND validator in that file to carry `shiftFilter`'s
empty-string arm, and needed it more than the first: it is on every report URL, so a bookmarked one
with the area cleared would 400 the whole list. `workCenterIdFilter` and `productIdFilter` still do
not have it (TODOS.md §84).

The two coarse grains are **one implementation behind two prefixes**, registered from a loop over
`["day", "month"]` and reading whichever table `GRAIN_TABLE` names — the same idiom as `SCOPE_COLUMN`
in the downtime module. The URLs stay separate because a path should say what it returns. What they
deliberately do NOT have:

- **no `approve` / `reopen`.** `oee.work_unit_shift_report_approvals` is keyed
  `(work_unit_id, date, shift)`, so there is nothing to key a day or month sign-off on. The detail
  payload carries a DERIVED count instead — "2 of 3 shifts approved" — which is a statement about
  three other records and cannot be misread as a signature. It is `null` at month grain, and the
  header renders no Status tile there. TODOS.md §48 holds the cascade question — **and the LINE
  screen now ships exactly that shape one axis over** (one click, N machine shift reports, its own
  role variable), so a day cascade should reuse it rather than invent a second definition of
  "approved".
- **no `shift` or `status` on the list filter.** Accepting and ignoring either would answer a
  filtered request with an unfiltered page, which reads as data rather than as an error.
  **They DO take `areaId`, as every report list does since `0028`** — see the note below on the
  header filter.
- **`performance` is day-only, and month has `hour-profile` instead.** Two paths because the
  payloads genuinely differ: a day returns 24 hourly buckets keyed on an INSTANT, a month returns 24
  hour-of-day buckets keyed on a clock hour that occurred ~30 times. One path returning two shapes is
  the thing a caller gets wrong once and works around forever. The month's rates are RECOMPUTED from
  `ideal_out` over the runtime that carried a standard — see §23 for why the denominator is the trap.
  The LINE routes are **three prefixes over one implementation** for the reads — all three tables
  differ by exactly one column (`shift`) — and the writes sit **outside** that loop, at shift grain
  only. What they have and deliberately do not:

- **`approve` / `reopen` EXIST, and they are a CASCADE.** A line has no approval row and cannot have
  one, so approving one closes every machine shift report on it and its own status is a derived count
  ("4 of 5 machines approved"). Three consequences: there is one definition of "approved" in the app
  rather than two that disagree on a partially approved line; **the downtime freeze needs no code**,
  since `listApprovalsOverlapping` already reads the rows this writes; and the trail is the existing
  append-only `…_approval_events`, one row per machine. It makes **no upstream call**: the machines
  are found by `work_center_id`, which `oee.work_unit_shift_reports` has carried as NOT NULL since
  `0003` — and that is also the better definition, because the column records the line the pipeline
  attributed a machine's numbers TO, where a roster is the line's membership NOW. (The cascade
  shipped fetching a roster from mes-master-data on the false premise that the column did not exist;
  that was corrected, removing a FATAL HTTP dependency from a write path.) The machine reports are
  matched on a **half-open `[from, to)`** window over `date`, never `date = window.from` — a row
  written a millisecond off would be skipped and the cascade would return a plausible 200 for a
  subset — and never `business_date`, which is nullable and unbackfilled (§46). Shift grain only;
  TODOS.md §53 records the decision.
- **`/:id/approval` is a separate route from `/:id`.** Answering it means two COUNT queries over the
  machine reports and their approvals, and the browser AWAITS the report while only prefetching this
  — the same argument `metrics-staleness` shipped with. It returns `machinesFound` beside the row's
  own `work_unit_count` so the screen can **abstain** when they disagree instead of rendering a
  fraction over the wrong denominator; both are the pipeline's own figures, so a disagreement is it
  disagreeing with itself.
- **no `status` filter on the lists, at any grain.** A line's status is derived per report, so a
  column here would be one query per row.
- **no per-product rows.** Blocked by §15: summing counts across machines needs a base-unit
  conversion, and these tables carry no per-product rows at all.

- **`activity` serves every grain of both subjects now; `metrics-staleness` serves neither coarse
  grain of either** (§50 for the machine's, §60 for the line's — both still open). That asymmetry is
  the one to keep straight: a feed is a read over a window and a banner is a read over a window, but
  only the feed has been built at the coarse grains. Both feeds' approval arms report the period's
  CHILD shift reports' transitions, each labelled with its shift, because there is no day or month
  approval to report — `…_approval_events` is keyed `(work_unit_id, date, shift)` — and the LINE
  feed labels with the MACHINE as well, since a line day spans both axes at once. The MACHINE feed's
  quality arm is real at the coarse grains as of §64; the line's always was.

`rejects` and `downtime-events` widen their shift-keyed source tables over a `shift_date` range
rather than duplicating the aggregates, which keep one statement each of the unit guards, the
generated-column read and the count(*)-not-count(column) rule. **A wider window makes those guards
fire far more often, and that is correct**: a bucket that saw both BAG and CARTON reports a null unit
and the screen renders an em dash, rather than picking one and adding incompatible numbers under it.

Every downtime read takes an optional `grain` (`shift` | `day` | `month`, defaulting to `shift`, with
`shift` required only when the grain is one). That default is what keeps the change invisible to
every shipped caller, and it is why the day and month screens reuse the timeline strip, the Downtime
Details table and the Availability Paretos unchanged rather than growing a parallel read path.

`business_date` and `time_zone` are columns on all three report tables as of `0013`, which is what
lets a window be resolved without a mes-master-data call — and what makes the day/month month filter
exact where the By Shift one still misattributes both ends of a month (§17, §46). `0021` added the
same pair to `oee.downtime_reports` and **`0022` DROPPED that table's `date` column entirely** —
`business_date` is now the only business day it has. The history is worth knowing because the trap
recurs: `date` was `timestamptz` while its VALUE was a business day, the type saying instant and the
meaning saying day, with the only statement of that being a comment in `shared/shift-window.ts`.
§69 removed its last reader, the pipeline owner offered the drop while the table was still empty
(contract §22, §23.4), and `0022` took it. **A business day must never be reconstructed with
`date::date`** — `timestamptz::date` resolves through the session `TimeZone`, so local midnight in a
UTC+7 plant becomes the PREVIOUS day under a UTC session (measured, contract §22.2). Only the writer
knows the zone the day was cut in, which is why the pair always ships together. That is the same
mistake `formatReportDate` vs `formatBusinessDate` guards in the browser, and
`0014_review_week_dev.sql`'s header records it silently breaking a seed's DELETE. `oee.downtime_log_events` needs none of this: it has
`shift_date`/`time_zone` already, and that older name is kept rather than renamed (§22.4).

The last three back the downtime edit dialog's two catalogue pickers, and the asymmetry between
them is the design rather than an oversight. `downtime-reasons` **requires** `?workCenterId=` — the
reason catalogue is scoped by `downtime_reasons_work_centers` upstream, and an unscoped read
returns the whole region, which is how a stop on the filler gets labelled with a palletiser reason.
`downtime-actions` takes no scope because `ms_downtime.downtime_actions` has **no junction tables at
all** (TODOS.md §44). The `POST` is the only write in this service that does not touch `oee`: it
forwards to mes-master-data so an operator can add an action without leaving the dialog. Reasons get
no equivalent on purpose — `reason[0]` is the key the Availability Pareto groups on, so an invented
one is a bar no line's catalogue owns. Both lists are cached by `MasterDataService` on the same
`StaleCache` policy as areas/work centers; the create calls `StaleCache.invalidate`, which is the
only place an entry is deleted.

Downtimes are _not_ nested under work-units — a stop can belong to a work unit, work center, area
or the factory, so scope is a query param. **`SCOPE_COLUMN` maps THREE of the four now**:
`work_unit_id`, `work_center_id` and, since the Area report, `area_id` — a column `0007` added in
August, whose own `COMMENT` recorded that it was "NOT yet accepted by SCOPE_COLUMN". Only `factory`
is still refused — **and the reason given for refusing it is now out of date**: it was "there is no
`factory_id` column to map", and `0028` gave `oee.downtime_reports` a `site_id`, which is that same
level under the name `mes-master-data` actually uses. There is no `factory` in that ontology at all
(enterprise → site → area → work center → work unit), so what survives is a scope named for a level
that exists in neither the schema nor the hierarchy. TODOS.md §85 is the rename-and-map; it also
deletes `isSupportedScope` / `requireSupported`, because a total `Record<DowntimeScope, string>`
turns an unmapped scope from a runtime 400 into a build failure. TODOS.md §25 held the
wide scopes back on COST rather than capability and named four changes that had to land together
first — a server-side `LIMIT`, an "Other" tail bucket, server-side ranking and a paged drill-down —
and all four shipped with the line grain, so `area` is the first caller that answer was built for.
The hierarchy axis is CONTAINMENT, which is what keeps each of these a plain predicate: `0020`'s
header draws the contrast with SKU, which is OCCUPANCY OVER TIME and is therefore a FILTER beside a
scope. One consequence of `area_id` being NULLABLE where the other two are not: a stop the pipeline
never attributed is excluded from every area-scoped read. That is denormalisation lag rather than an
attribution gap — the area IS derivable from the work unit — which is why it needs no
`unattributed` count the way `product_id` does, and why the fix if it bites is a backfill.

`DowntimeListItem` carries `work_center_id` as of the Area report, and it is **not for display**:
it scopes the edit dialog's Reason catalogue, which core-api refuses to serve unscoped. Every other
subject's report knows its own single line and supplies it; an area report spans N, so the only
thing that knows which catalogue applies to a stop is the stop. It has to be added in BOTH
projections — `detailColumns()` and `readStop()` — and `DowntimeRowValues` being derived from
`DowntimeListItem` is what makes a miss a compile error rather than an `undefined` in the payload.

**THE YEAR GRAIN IS THE DASHBOARD'S, AND IT REGISTERS FOUR ROUTES PER SUBJECT — NOT NINE.**
`0027` added `oee.{work_unit,work_center,area}_year_reports` (contract §27), and each module
mounts `/year-reports`, `/year-reports/:id`, `/year-reports/:id/oee-trend` and
`/year-reports/:id/rejects` in **its own block BESIDE the grain loop, never by adding "year" to
it**. That loop mounts every sub-resource its grains share; a year report has an answer for four.
The five it does not get are each a decision: no `products` or `machines` (report screens' cards,
and there is no year report screen), no `performance`/`hour-profile` (~8,760 points is not a
chart), no `downtime-events`, no `activity` (~1,095 shifts of transitions is a scan), no
`metrics-staleness`, and **no approve/reopen at any subject** — the LINE one being the sharpest,
since a line approve is already a cascade and at year grain would close ~1,095 shifts times N
machines, which is not what `APPROVE_LINE_ROLE` grants. **A separate `CoarseGrain` per module is
what keeps the other five unreachable**: they take `PeriodGrain` / the local `ReportGrain` /
`AreaGrain`, so a year id cannot COMPILE into them. The per-subject unions did NOT widen, and
`AreaGrain` staying two members is load-bearing — an area still has exactly two REPORT grains
("only have 2 type of report"), and the dashboard is a second surface rather than a third one.
The year LIST validator is each subject's coarse schema MINUS `month`, written out rather than
`.omit()`d (`area-report-dto.ts`'s call), because a year list narrowed to one month is a different
question and accepting the filter silently is the thing every list schema here refuses.

**`REPORT_GRAINS` carries `"year"` now, and its blast radius was smaller than TODOS §74 predicted**
— nothing else reads the constant, so only `resolveReportWindow` (a `date_trunc('year', …)` arm on
both ends) and `downtime-dto.ts`'s enum moved. That enum is the point: the three downtime Paretos
and Pareto Actions serve a year screen with no new arithmetic. **It widens FOUR endpoints, not two**
— `timelineInputBase` is extended by the timeline and the paginated downtime list as well — which
nothing asks for a year and nothing refuses either.

**`oee-trend` is the one sub-feed that exists at COARSE GRAINS ON THREE SUBJECTS AND NOWHERE ELSE**, and
both halves of that are deliberate. It answers the OEE Performance dashboard's daily curve, which
nothing else in this service could: the day LIST endpoints filter by LINE, never by machine, and
their 100-row cap truncates silently at four machines × thirty-one days. There is no day-grain twin
because a day has no days inside it to trend — the handler tests assert `/day-reports/:id/oee-trend`
is NOT registered, since the route sits inside a registration loop's month-only arm and moving it out
by one brace would give a day report a trend of its own single day. **Since `0027` there are SIX of
them**, a month and a year per subject, and **the inner table is always ONE grain finer than the
outer**: a month report trends DAYS, a year report trends MONTHS. Twelve points rather than ~365, so
four series stay readable and each point drills into a month screen that exists. Two named methods
per module rather than one taking a grain, so the third call that has no table behind it cannot be
written. **The watermark differs with the grain and each caller must pass the right one** — a year
curve reads the MONTH table, so reporting the day table's freshness there would make a curve that
stops in June claim to be current. The arithmetic lives once, in
`shared/oee-trend.ts`, which was shared ON ARRIVAL rather than after a second caller: three subjects
have BOTH a month and a day table (`work_unit_*`, `work_center_*`, `area_*`), so there were three
callers immediately — and `0027` made it six. It takes the outer table, the inner table AND THE
SPAN, the last being the one parameter that renders a plausible chart when it is wrong: a year
joined with a one-month span draws January alone and labels it as the year. **It takes its tables as Fragments and its scope column as a string**, and that
asymmetry is the file's one trap — `db(name)` escapes a dotted name as ONE identifier, so
`db("oee.work_unit_day_reports")` names a table of that literal name in the search path rather than
one in schema `oee`; a bare column has no dot, which is why `SCOPE_COLUMN` may use it and a table may
not. It projects ALL FOUR RATES — oee, availability, performance and quality — because the dashboard
draws them on ONE chart: OEE is the product of the other three, so "OEE fell on the 19th, which of
them moved?" is the question the chart exists to answer and it is unanswerable one series at a time.
Each is NOT NULL on the machine day table and NULLABLE on the other two, and the payload keeps the
null: an area day that could not be composed is not an area that scored zero. Migration `0026`
added the composite index the machine table was the only one of the three to lack — its near-miss
sibling `wu_day_report_wu_date_idx` is on `date`, the `timestamptz`, not `business_date`.

**`master-data/work-units` is a CATALOGUE, and the alternative to it is the interesting part.** It
backs the dashboard's machine picker, scoped by `?workCenterId=` and required for the reason every
other list on that mount requires its scope: unscoped, upstream answers with the whole region. The
month-report LIST could have supplied the same names at no new endpoint, and was rejected on what it
does to the screen — the options would change whenever the selected month did, and a machine with no
report for that month could not be picked at all, so "this machine has no report for August" would be
unreachable. `MasterDataClient.findAllWorkUnitByWorkCenterId` was WIDENED from `{ id }[]` rather than
joined by a second method: the response was already parsed as a full work unit and the labels thrown
away, and a second method would have meant a second copy of the page loop and its truncation warning.
`MasterDataService` caches it ONCE and serves both shapes from the one entry, so the picker and the
report list's work-unit filter cannot disagree about a line's membership.

Every response is the `WebResponse` envelope from `@molca/network` (`{ data, meta, error }`), paged
lists via `buildPageMeta`. postgres.js is used directly (no ORM) and cannot be auto-instrumented, so
repositories emit spans through the `traced()` helper in `shared/database/postgres.ts`.
