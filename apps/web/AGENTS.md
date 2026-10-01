# AGENTS.md — `apps/web`

`CLAUDE.md` is a symlink to `AGENTS.md` — one file, both agents. Edit either; it is the same bytes.

This file loads when working with files under `apps/web/`. It was split out of the repo-root
`AGENTS.md` so the root file stays small enough not to trip the large-memory-file warning; the
root still holds everything cross-cutting — the Gold schema's purpose, the medallion tiers and
who writes them, the operator-mutation rules, CI, and testing conventions. **Read the root file
too** — the nine report tables' independent identity sequences, the two-unit rule at the line
grain, the AREA grain's inversion of it (one unit, and it is a MASS; durations in LINE-hours), and
the `business_date` vs `date` trap all originate there and several rules below only make sense
against them.

## `web` — SPA conventions

File-based TanStack Router under `src/routes/`; `src/routeTree.gen.ts` **is committed and must never
be hand-edited** (CI asserts freshness with `git diff --exit-code`). `_app.tsx` is the pathless
authenticated shell — `beforeLoad: requireAuth` gates the whole subtree, so there is no
`<RequireAuth>` component. Trailing underscores (`by-shift_.$reportId_.losses.tsx`) opt a route out
of nesting; the reason is stated in each file's header.

- All server data flows through `src/lib/api.ts` (axios, `PROXY_PREFIX = /api/proxy/api/v1`) and
  `src/lib/queries.ts` (`queryOptions` objects, so route loaders can prefetch what components
  subscribe to). New prefixes must also be allow-listed in the BFF's `PROXY_ALLOWED_PREFIXES`.
- `login()`/`logout()` must stay full-page `location.href` navigations — those endpoints answer with
  cross-origin 302s a client-side navigation cannot follow. Where login may _return_ to is
  allow-listed separately by `ALLOWED_PREFIXES` in `apps/bff/src/module/auth/auth-service.ts`;
  a path missing there is silently rewritten to `/`.
- `src/components/ui/*` are repo-owned shadcn files — edit them freely. Style with semantic tokens
  (`bg-background`, `text-muted-foreground`), never hardcoded palette colors, or dark mode breaks.
- `autoCodeSplitting` is **on** (since 2026-08-25), and the five report components that hand-roll
  `lazy()` + `<Suspense>` around their recharts chart are **still needed** — route splitting does
  not subsume them. rolldown lifts a module reachable from several async chunks to their common
  ancestor, and the chart cards live in three route chunks whose common ancestor is the entry, so
  deleting the `lazy()` boundaries pulls recharts back in (measured: 395 kB entry becomes 781 kB)
  and `/login` downloads it. The two mechanisms are complementary. Re-measure with
  `pnpm --filter web exec vp build` before touching either — TODOS.md §26 mis-stated its own
  baseline four times by writing a figure down and then trusting it.
- **Report components take `ReportDetail` (machine) or `LineReportDetail` (line), each a
  discriminated union on `grain`.** A card that reads `report.shift` has to narrow first, so it
  cannot render `undefined` on a month screen. The machine shift arm's `grain` is stamped in
  `lib/api.ts` rather than sent by the server — that function is the one place that knows which
  endpoint answered, and the shift response shape is a shipped contract; all three LINE endpoints
  postdate the field and send it themselves.
  **`reportWindowParams` is ONE function taking either union**, discriminating on SUBJECT (a line
  report has no `workUnitId`) as well as grain, and returning `scope: "work-center"` for a line —
  which core-api's `SCOPE_COLUMN` already serves, so the timeline needs no API work at that subject.
  A second `lineWindowParams` beside it would be a second chance for the scope half to drift, and
  the symptom is a skeleton flash on a page that had already fetched.
- **Components shared between the FOUR subjects take DATA, never a `subject` flag.**
  `metrics-card.tsx` takes tiles and formats nothing (a machine has one unit; a line has **two**, so
  the unit must stay beside the figure that needs it; an area has **one again and it is a MASS**, so
  a single local IS safe there and only there — see the area bullet below). Its `MetricSpec.hint` is
  the newest DATA-not-flag: an optional sentence beside a tile's label, added for the one figure in
  the app whose correct value looks like a defect; `report-header-shell.tsx` takes tiles and an
  actions node; `confirm-write-dialog.tsx` takes the MUTATION RESULT, so which write it performs
  stays at the call site where a test can assert it; `timeline-card.tsx` takes the params rather than
  a report; `activity-log-view.tsx` takes the feed plus a `contextOf`, and the four answers are a
  worked example of one rule: **the suffix disambiguates along the axis the feed SPANS.** A machine
  feed labels with its SHIFT — its day covers three reports, and since §64 that applies to the
  QUALITY arm as well as the approval one; a line's labels with its MACHINE and, at day and month
  grain, **its SHIFT too**, because a line day spans both axes at once (§60); a **SKU's labels
  whichever the ARM can carry**, so a quality entry gets its shift and a downtime edit its machine;
  and an **AREA's names the LINE first and then that axis**, because an area day spans three shifts,
  N lines and every machine on them and "the filler" is a name several lines have. Each one tests
  `in` **and** `typeof` on a field: `contextOf` is handed the wide `FeedEntry`, so `in` proves the
  field exists and `typeof` proves it is not another arm's `number | null` — without the second,
  "shift null" reaches the DOM.
  A flag in any of them is how a Line dialog signs off a MACHINE report.
  `quality-entry-view.tsx` is the sharpest case, because it was refactored INTO this shape rather
  than born in it: **its acceptance test is its import list.** If `LineReportDetail` or
  `SkuReportDetail` appears there, the separation has been undone — and the thing a report prop
  would drag in is not a field but a DECISION, which machines endpoint answers. Two thin callers
  (`line-quality-entry-dialog.tsx`, `sku-quality-entry-dialog.tsx`) name their own queries and
  their own mutation. Its `fixedShift` / `datePicker` props are deliberately not a grain: "is the
  shift already known" and "does this report span more than one business day" are the questions
  those fields ask, and a grain would re-open the half-right `(grain, id)` shape. `losses-card-shell.tsx` joins them: it takes the six loss durations as
  a `Pick`, so it cannot reach a unit, an id or a grain, and its reject/rework come in ALREADY
  FORMATTED — a machine has one unit, a line's two counts there are both **infeed**-side, and the
  shell formatting them itself is how cartons get rendered under a bag label. The drill-down link and
  the hourly affordance are SLOTS for the same reason: whether there is an hourly chart to open is a
  fact about the subject and grain, not about the layout.
- **The entry dialog's field order is load-bearing: SKU BEFORE UNIT.** There is no global
  uom-to-uom conversion in this system — it is per product, through `packages[]` — so the unit
  picker's options and their factors are a property of the chosen SKU. The requirement called this
  field "one of uom from master data (global)"; a global list would offer units the product has no
  factor for and the conversion would be undefined or silently 1.0. Changing the SKU **clears** the
  unit, because one carried across would still be selectable and would carry the previous product's
  factor. **On a SKU report the field is FIXED — read-only — and stays IN PLACE above the unit**:
  the report IS one product, so a picker would be a control that looks like a choice and is not,
  but removing the field would leave the unit options (that product's `packages[]`) unexplained.
- **An entry does not move the tile, and the ledger line is why that is survivable.** The reported
  figures are composed by the PIPELINE (contract §18), so the Reject tile is unchanged until the
  next DAG run. An operator who saw nothing happen would enter it again — so
  `quality-action.tsx` renders the entries on their own line beneath the tile, labelled as not yet
  included. That DISPLAYS the ledger; it must never add into the figure, or there are two
  definitions of the composed number and they disagree for as long as the DAG has not run.
  `line-losses-card.test.tsx` and `sku-losses-card.test.tsx` both pin 5000 + 140 rendering as 5000
  and a separate 140, never 5140. The button and that line live in ONE file shared by the two cards
  because they are mostly PROSE — the tooltip explaining why the tile did not move — and two copies
  drifting means two screens telling operators different things about one DAG run.
- **`lib/report-subject.ts` answers the two questions every shared component asks.** `isLineReport`
  discriminates on SHAPE (a line row has no `workUnitId`, which is `0014` rather than a convention);
  `reportBusinessDay` returns the covered day from whichever of THREE sources holds it — a line's,
  a SKU's and an area's `businessDate` are all NOT NULL and zone-free, a machine's coarse one is
  nullable pending §46's backfill, and a machine SHIFT report has only `date`, an **instant**, so
  the zone reduction is reached by ONE subject at ONE grain. `ReportAddress`
  (`{subject, grain, id}`) is the third: any write or invalidation that names a report takes one
  value rather than an id plus a grain, because that split is the shape a caller gets half-right —
  a line id with the machine subject implied compiles, and the invalidation then refetches a
  STRANGER's activity feed while the operator's own stays stale. It is a DISCRIMINATED UNION, so
  the four impossible addresses (a SKU shift, a SKU month, an area shift, an area month) are
  unrepresentable — but that does not by itself catch a mis-dispatch, because `grain: "day"` is legal
  for a machine too, which is why every consumer switches on `subject` FIRST with a `never` default.
  The two SKU absences are impossibilities (no table, and none wanted); the two AREA ones are
  different — a shift grain is not wanted, and a MONTH grain IS, as a pending table — so that arm
  widens when `oee.area_month_reports` lands rather than being admitted early. An address for a
  report that cannot be fetched is the shape a caller gets half-right. `QualityAddress` narrows it to
  the two subjects that HAVE a ledger: a machine report has none (`0017` treats a machine as
  provenance only), and the type is what refuses one at the call site rather than at the endpoint.
- **`useReportApproved` is the freeze rule for all EIGHT report addresses**, and six of them answer
  approximately. A machine shift report reads a real `approval` row; a machine day/month means ALL
  its child shifts closed; a line shift means ALL its machines closed; a line day/month is NEVER
  frozen by the line, because there is no line day approval (§48); and a **SKU day and an AREA day are never
  frozen either** — the server refuses the write per SHIFT (`refuseIfFrozen` asks the same
  `summariseLineShift` the cascade does), and the browser cannot know which shift a stop fell in
  without a second copy of `SHIFT_WINDOWS`. That alternative is worse at area grain than anywhere
  else: an area day spans N lines as well as three shifts. The server owns the truth and
  refuses with a 409 the dialog surfaces. The alternative — knowing which shift each stop falls in —
  means a second copy of `SHIFT_WINDOWS` in the browser, the divergence `shared/shift-window.ts`
  exists to prevent (§49). The pending arm reads NOT frozen deliberately: offering an edit that 409s
  is recoverable, refusing one that would have worked is not explainable.
- **A card that fetches by report id MUST pick its endpoint from `report.grain` AND its SUBJECT.**
  There are now **twelve** report tables — three `work_unit_*`, three `work_center_*`,
  `product_report_wc_day`, `area_day_reports`, `area_month_reports` and the three `*_year_reports`
  `0027` added — with twelve INDEPENDENT identity sequences. (Several older comments in this
  codebase still say seven, eight or nine; they were right when written and the COUNT is not the
  argument — the independence is.) **The two AREA ones are the sharpest case**, because they are the same
  subject: their route literals and query options compile in each other's place, so a day report's
  id opened at `/by-monthly` lands on a real MONTH report about a different period, populated and
  plausible. Every area cache key therefore carries the grain in its PREFIX
  (`` `area-${grain}-report[s]` ``), not as a field beside the id. Calling a shift-grain endpoint with a day report's id has two
  outcomes and the quiet one is the dangerous half: a 404 if no shift report has that id, or
  **another machine's data on another date, rendered without a warning**, if one does. `SkuViewCard`
  shipped with exactly that bug. The subject axis is the same hazard: a Line screen reaching a
  `/work-units/*` endpoint renders a full page of MACHINE rows, same envelope, same four measures,
  a populated Line column on both. A test asserting the card renders rows passes either way — assert
  WHICH function was called. Same rule for cache keys: `lineReportsQueryOptions` and
  `lineReportQueryOptions` key on `` `work-center-${grain}-report[s]` ``, carrying both axes — at the
  detail grain a key of `["shift-report", 7]` would collide with the MACHINE report already cached
  and the second screen to mount would render the other's forty measures. Same rule for
  `mutations.ts`, where `useApproveLineReport` additionally invalidates the MACHINE prefixes: the
  cascade closes N machine reports, so their screens would otherwise keep an "Open" badge on a report
  that was just signed.
- **The AREA screens invert two rules the other three subjects taught, and both inversions are on
  the cards — at both of its grains.** `AreaReportDetail` has ONE unit triple, `weightUom*`, and every count on it is a
  MASS — because an area's member lines disagree about both the infeed and the output side, so
  `0014`'s two-triple shape would leave every figure NULL. That makes a single `unit` local in
  `area-overview-card.tsx` safe, which `line-overview-card.tsx` explicitly forbids itself: the
  prohibition there is about a subject with TWO count points, and `0024`'s CHECK ties every area
  count to the one unit. **And its durations are LINE-hours**: `runtime` on a multi-line day reads
  above 24 h, which is the intended figure and the one a supervisor will report as a bug — hence the
  only `hint` tooltip on any overview tile, and hence a fixture whose durations are deliberately over
  a day so a card that "corrected" them by dividing would fail. `area-losses-card.tsx` passes
  **neither** `rejectAction` nor `reworkAction`: the requirement says "no add reject/rework", and an
  entry is keyed by LINE, so an area-level Add would exist only to make the operator pick one.
  `area-production-units-card.tsx` is the one card no other subject has, and its own header states
  why it is **two tables and not a chart** — bars are read by comparing lengths, and 12,000 BAG
  beside 400 SACK says nothing about which is more material; a stacked one would imply a total, and
  the total in these units is the thing that does not exist. It ships the per-side residual counts
  for the same reason the SKU reads ship `unattributed`: a line whose unit was never resolved is
  silently absent, and without the count "every line counts in BAG" and "half this area has no unit"
  are the same screen. **At MONTH grain both inversions get louder rather than different**: the
  durations are line-hours times a month, so Run Time reads in the thousands and its tooltip says so
  in different words from the day screen's; and the header's first tile changes its LABEL and its
  FORMATTER together, because `businessDate` there is the FIRST DAY of the month
  (`ck_amr_month_start`) and `formatBusinessDate` would print "01/09/2026" under a heading that says
  Month — a real date, correctly formatted, and read as the report covering one day.
- **The edit dialog's `workCenterId` comes from the ROW on an area screen and from the REPORT
  everywhere else.** Its prop comment used to say "taken from the REPORT, not from the row", which
  was true and stopped being the whole story: an area report spans N lines, so there is no
  report-level line to take, and the only thing that knows which Reason catalogue applies to a stop
  is the stop. `DowntimeListItem` carries `workCenterId` for exactly that. The old objection still
  stands for the other three subjects and is why they were not switched — the row's line is whatever
  the pipeline denormalised, while a machine, line or SKU report always knows its own.
- **`businessDate` must never go through `formatReportDate`.** That formatter takes an INSTANT and
  converts it into a zone; a business date is already plant-local, so `new Date("2026-08-01")` reads
  as UTC midnight and lands on 31 July for any plant west of Greenwich — the right-looking wrong day
  on every row. Use `formatBusinessDate` / `formatMonthLabel`, which never build a zoned Date.
- **The Losses card's View button is offered at every grain on BOTH subjects that have one, and a
  month gets a DIFFERENT chart rather than a longer one** — 24 hour-of-day points collapsed from
  ~720 hourly ones. `perf-hourly.ts` parameterises only the axis and the join key; all of the rate
  arithmetic below them is shared, which is what keeps one runtime-weighted-average implementation
  rather than two.
  **This has been both ways on the machine card and three ways on the line's, and the history is the
  argument.** The machine button was absent at month grain while there was no chart to open, enabled
  when `/work-units/month-reports/:id/hour-profile` shipped (§23), then removed again on the
  argument that a month report should reach the profile through the Losses page's Trendline sub-tab
  instead — which read as the feature being missing and was reported as such. The line button was
  absent at every grain until `0018`, then shift-and-day, and the reason given for the last gap
  ("a month is not a chronological chart, which is the same split the machine screen makes") was a
  rationalisation of a MISSING READ: `/work-centers/month-reports/:id/hour-profile` had served the
  Trendline sub-tab all along and `LinePerformanceDialog` simply did not call it, so the button
  would have opened an empty panel. **The sub-tab is not an alternative to the card shortcut — it is
  the other end of the same drill-down**, and a month screen is the one furthest from the hour.
  Both dialogs now pick their endpoint AND their model builder from the grain.
  `losses-card.test.tsx` and `line-losses-card.test.tsx` assert WHICH fetcher each grain reaches,
  because no wrong pick errors visibly: a machine month id on `/performance` 404s into a card-local
  error state, a LINE month id on `/performance` returns ~720 chronological buckets and draws an
  unreadable chart that is not empty, and a day id on either month profile draws 24 perfectly
  readable points about the wrong span. The line tests also pin the SUBJECT axis on its own, since
  a line id reaching a `/work-units/*` hourly read is another machine's hours drawn without a
  warning. **`buildLineHourOfDayOutput` is pinned too, now that two surfaces reach it** — the
  output-side rename and the unit the block is denominated in, the same pair the chronological
  builder carries, because over a month the infeed figure is ~30x larger and one reaching the
  quantity domain flattens every output series along the bottom.
  Its sibling external-link icon was gated by grain while the day and month Losses pages did not
  exist — because it interpolates the current report's id into a route, and the three report tables
  have independent `serial` sequences, so it would have opened an unrelated report and looked
  entirely normal. Both now resolve per grain.
- **Log Activity is offered on EIGHT of the nine report screens, and the one absence is the rule.**
  Every machine grain, every line grain (§60, which held the two coarse ones open as a product
  question about density — ~3N machine-shift transitions — and answered it yes on the machine day
  feed's and area day feed's precedent), the SKU day and both area grains. The **line month** and
  **machine month** feeds are real, not a widened day: the server reads the report's own window.
  Two rules follow that a "consistency" pass will want to break in both directions.
  **Reading is not signing**: `/activity` serves all three line grains while Approve stays
  shift-only, because a day approval would cascade over three shifts as well as N machines (§48) —
  `line-report-actions.test.tsx` asserts both in one case so neither can be aligned to the other.
  And **the stale-metrics banner is still shift-only at line grain** (§60's other half): widening it
  would ship an unbuilt read.
  Each sheet picks its endpoint AND its cache key from the grain — `lineActivityKey` keys on
  `` `work-center-${grain}-report-activity` ``, the grain in the PREFIX, because the three
  `work_center_*` tables have independent sequences and `["...activity", 7]` would otherwise serve
  a day 7's panel to a shift 7. **`invalidateApprovalFeeds` in `mutations.ts` is the other half**:
  one approval event appears in six feeds, five of them keyed on ids the writing call site cannot
  compute, so those five are invalidated by bare prefix. Both machine writes and the line cascade go
  through it — two call sites naming different subsets is exactly the bug it replaced.
- **The nine report LIST screens share their chrome, and the sharing is load-bearing.**
  `report-list-shell.tsx` (the ETL banner and the card), `report-list-filters.tsx` (Month, Year,
  Shift, Line, Hide-OEE-0%) and `table/index-column.tsx` are used by all of them;
  `hooks/use-work-center-filter.ts` (the Area → Line cascade and the stranded-id rule) by seven.
  **THE HEADER AREA PICKER FILTERS EVERY REQUEST NOW, AND THAT IS A REVERSAL.** That hook used to
  end: "The area itself is deliberately not a request filter: it only decides which lines a page may
  OFFER, because core-api's report endpoints take a workCenterId and know nothing about areas."
  Both halves are gone. The requirement is that every report screen — machine, line, SKU and area —
  opens filtered to the selected area, and migration `0028` put `area_id` on every report table, so
  the endpoints do know about areas and the filter is a plain column predicate rather than a
  hierarchy round trip. The hook returns `areaId` as a third field and the four list tables put it
  in the REQUEST beside `workCenterId`.
  **The two ids it returns are NOT interchangeable and the stranding rule is why.** `workCenterId`
  is the requested id AFTER stranding, so it is `undefined` when the URL names a line outside the
  selected area; `areaId` is never stranded, because the provider falls back to the first area. So
  **a stranded line must not strand the area with it** — dropping both widens the list from one area
  to the whole plant, which is the failure that looks like working data, and all four list tests pin
  it. And **an undefined area must NOT gate the query**: core-api reads an absent `areaId` as every
  area, so an ungated first paint shows data and narrows a tick later, where a gated `useQuery`
  reports `status: "pending"` forever.
  **The AREA list is still the exception, for a different reason than before.** Everywhere else the
  area is a LENS over rows keyed by something else; there it IS what the report is about, so
  `areaId` picks WHICH REPORT rather than which slice of one. That screen reads `useSelectedArea`
  directly, renders **no area control of its own** (the requirement says to use the
  header's, and a second picker would either duplicate it or disagree with it), and — the inverse of
  the stranded-id rule — does **not** gate its query on an undefined area. It also has its own
  URL contract, `lib/area-search.ts`, rather than `validatePeriodSearch`: that one carries
  `workCenterId`, and accepting a filter the server ignores lets a bookmarked `?workCenterId=3` come
  back with the whole area looking filtered. **The two area lists are ONE component** discriminated
  on a `search` UNION rather than a `grain` prop beside it: a prop plus a widened search would admit
  `{grain: "month", month: 9}`, which the requirement forbids in as many words and core-api refuses
  outright, and the union makes that combination unrepresentable rather than merely unused. Four rules were duplicated
  before that and none failed loudly when a copy drifted — most cheaply, the banner's PROSE, where a
  drift means two screens telling operators different update hours. `ReportListFilterBar` takes
  SLOTS rather than flags because machine By Shift orders its right group Shift → Line → Status →
  hide-zero, and an order that is configuration is an order somebody gets wrong. `StatusFilter`
  stays inline in that one screen: only a machine shift report has an approval.
- **The Losses page's five tabs live in `components/report/losses-tabs.tsx`, not in the routes.**
  All four subjects render the same dispatch, and its intricacy is load-bearing: the order of the
  checks is what makes `item.category` provably defined in the last arm, and the `never` in the
  prefetch switch is what stops a sixth tab shipping without a prefetch. A drift there does not
  fail — it silently loses Performance Loss's sub-tab bar. **The drill-down target is a `detailTo`
  prop typed as `LossesDetailTo`, eight route literals** — `reason-pareto-card.tsx` used to hardcode
  the machine by-shift one, which COMPILES on a line page (the param name is the same) and opens an
  unrelated report at the wrong subject. TanStack can only check a literal, so the union is what
  makes a rename a build failure. Performance Loss's **Trendline renders a real card at machine and
  LINE grain and an empty state at SKU and area grain** rather than being absent, so the tab bar
  does not change shape between subjects (§61). The line arm was an empty state until `0018` and
  its two endpoints landed, and it kept rendering one afterwards — "a stale empty state is worse
  than a missing feature, because nobody files a bug against a sentence that sounds considered".
  The two that remain say DIFFERENT things and that is the point: a SKU's hourly data EXISTS
  (`oee.product_perf_wc_hour` is the line's hourly production per SKU) and the requirement excludes
  the chart, where an area's does NOT exist and an area-summed curve off the line's would be the
  roll-up contract §19.1 refuses. "Not shown here" and "cannot be shown here" are different
  promises, and a reader deciding whether to file a bug needs to know which. **The card arms are
  picked with `isMachineReport` as the POSITIVE test**, never `isLineReport ? … : machine`, so a
  fifth subject lands where a prop type refuses it and the build fails.
- **Machine View's per-row arrow is the seven-sequences hazard in its sharpest form**: a MACHINE link
  built on a LINE screen, with the line's own id in scope being the wrong number. It interpolates
  `machine.reportId`, which `/machines` returns for exactly that purpose — the line's id there is a
  real machine report about another machine on another date, with a populated header and no warning.
  The card also renders **no total row and says so in its tooltip**: its rows do not add up to the
  overview card above them and never will, because a line is measured at its own count points.
- **Downtime reasons and actions are picked from mes-master-data, not typed.**
  `components/ui/option-tag-input.tsx` is the catalogue-backed chips control; `ui/tag-input.tsx`
  stays for uncatalogued lists and still owns the `MAX_ENTRIES`/`MAX_LENGTH` the other imports.
  **What is stored is the NAME, not an id** — both columns are jsonb string arrays the pipeline also
  writes into, so there is nothing to hold an id. Two consequences that must not regress: a chip
  whose name is not in the catalogue still renders (almost every stop on screen was labelled by the
  pipeline, and dropping it would rewrite an operator's record), and the Reason field takes no
  `onCreate` while the Actions field does. `lib/slug.ts` derives an action's code and is duplicated
  in mes-master-data's `lib/downtime-action-schema.ts` — change both together, or the same name
  yields two codes and the second create 409s.
- Writes live in `src/lib/mutations.ts`, never `queries.ts`: a route loader must never be able to
  import a mutation, and a separate module makes that structural. The conventions there are
  decisions, not defaults — write through with `setQueryData` then invalidate (an approval needs
  read-after-write, and the merge is because the endpoint returns only the approval, not the
  report's forty measures); no optimistic update, since `closedAt`/`closedBy` are the server's;
  and `retry: false` **explicitly**, because `query-client.ts` sets that for queries only and an
  auto-retried approve is a second write the server answers 409.
- **OEE PERFORMANCE IS A SECOND SURFACE, not a tenth report screen**, and it lives under its own
  top-level segment with its own search validators, its own `components/oee-dashboard/` folder and
  its own `lib/oee-dashboard/`. **SIX SCREENS NOW** —
  `/oee-performance/{machine,line,area}/{monthly,yearly}` — and only FACTORY is left (TODOS.md §81),
  blocked on a Gold table rather than on a grain.
  **The year grain is `0027`'s three tables, and its three screens ship against EMPTY ones** until
  Airflow writes them, which is the same state `0016`, `0024` and `0025` shipped in.
  Five things carry the six screens, and each is where a "consistency" pass would do damage:
  **the SUBJECT REGISTRY holds three entries and is keyed by subject ONLY** — the tile list is
  constant down the grain axis, so each entry's report type is its subject's two coarse grains and a
  six-cell registry would describe what does NOT differ; **`trendQueryOptions` was REMOVED from it**
  when the second subject landed, because at three subjects × two grains it becomes a dispatch table
  routes index by key and all six trend endpoints return an identical envelope — each screen names
  its own hook as a literal instead, which is also the only thing that lets a test assert which
  fetcher ran; **`OeePerformanceView` is the card grid and cannot reach an id, a grain or a subject**
  (its `measures` prop is a seven-field `Pick`, `losses-card-shell.tsx`'s trick), and what it
  protects is that Schedule Loss draws the same PLANNED payload the Six Big Losses card fetched;
  **`isListSettled` is four tokens and the obvious `!isPending` reads as correct and is not**, since
  every list here serves the previous subject's rows as placeholder data; and **`TREND_AXIS` and
  `DASHBOARD_PERIOD_COPY` are the only things that vary by grain**, both as VALUES indexed with a
  literal — recharts renders nothing measurable under happy-dom, so an axis tick is only assertable
  as a record, and a year screen saying "daily figures" describes a chart it is not drawing.
  **`isYearClosed` is a sibling of `isMonthClosed`, never a parameterised `isPeriodClosed(grain,…)`**:
  the parameterised version's only content is a slice length picked from a grain, and the two ways of
  getting it wrong are not symmetric — seven characters on a year row caches a LIVE period forever.
  **The three YEAR payload types stay OUT of `AnyReport`**; only `reportWindowParams`,
  `reasonBreakdownParams` and `actionBreakdownQuery` widen, to `WindowedReport`. `AnyReport` is what
  every exhaustive `switch (report.grain)` on the report surface sees, and a year arm would force a
  dozen of them to answer for screens that will never exist. Widening a function's parameter is safe;
  widening the union it belongs to is a twelve-site change for zero screens.
  Four more things are worth knowing before touching it.
  **Three of its six tiles are not columns** — Calendar Time is `availabilityTime`, Loading Time is
  `productionTime`, and Utility is their ratio; the root `AGENTS.md` carries the identity and why
  getting it wrong yields a percentage rather than an error. **The KPI row is a per-subject tile
  LIST, never a fixed six**, because migration `0024` gives an area no `teep` — and no Utility
  either, since both divide by a calendar an area does not own. That was a prediction when the
  registry held one entry and is now the shipped area row: FOUR tiles, not six with two blanks, at
  both of its grains. A blank reads as "not computed yet", which is a promise the figure will
  arrive. **Six Big Losses merges FOUR independently
  limited lists plus one synthetic row**, and two rules in `buildSixBigLosses` are load-bearing in
  opposite directions: the `other` tail is DROPPED (it is ~37 reasons folded into one figure and
  would take a slot in the six, producing a card that is wrong and reads as correct), and a
  NEGATIVE reduce-speed loss is left negative (a machine outran its standard; `Math.abs` would
  promote the best hour of the month to the worst loss on screen). The merge is exact — the top six
  can draw at most six rows from any one source, and each source returns its own top twenty — and
  that proof is a comment, because the obvious "fix" is a server-side merge that would cross the
  module boundary core-api enforces. **ITS LOAD LADDER READS THE REPORT FIRST**: the four breakdown
  queries are gated on `reasonBreakdownParams`, which is undefined until the report resolves, and a
  gated `useQuery` pends FOREVER — reading their `isPending` first renders a skeleton that never
  clears, on the centrepiece of the screen. One failed source fails the whole card, deliberately: a
  top six over three of four sources silently promotes a smaller loss and looks identical to the
  truth. **The machine picker is a master-data CATALOGUE, not a projection of the month-report
  list**, which is what makes "this machine has no report for August" a reachable state rather than
  an option that simply vanishes from the dropdown; `lib/oee-dashboard/selection.ts` holds the
  stranded-id rule and the report-id match as tested functions, including the one that lets a
  requested id stand while options are still loading so a shared link does not flash another
  machine's report.
  **Its second half is CHARTS OVER READS THAT ALREADY EXISTED**, and that ratio is
  worth keeping: two donuts, three Paretos and a four-series trend cost ONE new
  endpoint between them. Schedule Loss and Pareto Quality Losses draw the SAME
  `planned` and `rejects` payloads the Six Big Losses card fetches, so two cards on
  one screen provably cannot disagree; the donuts are arithmetic over the report
  row, built in `lib/oee-dashboard/` where "the slices sum to the whole" is a
  tested property rather than a hope — and the Calendar Time donut derives its
  losses slice by SUBTRACTION rather than re-summing the four loss columns, so the
  ring stays whole even on a row where the pipeline broke the identity. Two shared
  components were generalised to get there, both by the same rule: `buildPareto`
  and `selectParetoState` now take what they READ rather than one caller's payload
  (the action breakdown has no `category`), and `ReasonParetoChart` takes a
  `ParetoAppearance` — a colour token and a label — instead of a `DowntimeCategory`
  it looked both up from. That last one is the shared-component rule exactly: an
  action is not an operation type, so the alternatives were a lie (`"UNPLANNED"`,
  which prints "Unplanned stops" in the tooltip) or this.
  **`DashboardParetoCard` is deliberately NOT `reason-pareto-card.tsx`**: that card
  is the Losses PAGE's, with a measure toggle, a sortable paginated table and an
  eye button into one bucket's stops, because that page exists to be worked
  through. A dashboard answers "what should I look at" and hands off — four
  paginated tables on one screen, each linking to a report the dashboard is not
  about, is the thing reusing it would produce. What it DOES reuse is everything
  that could be wrong.
- Imports omit the `.js` extension here (`moduleResolution: "bundler"`); `api`, `bff` and
  `packages/*` **require** it. `@/*` → `src/*` is declared in both `tsconfig.app.json` and
  `vite.config.ts` — both are needed.
