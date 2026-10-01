import type { AnyReport, WindowedReport, QualityAddress } from "@/lib/report-subject";
import { queryOptions, useQuery } from "@tanstack/react-query";

import {
  getAreas,
  getDowntimeActionOptions,
  getDowntimeReasonOptions,
  getDowntimeReasons,
  getDowntimes,
  getLineActivity,
  getLineApproval,
  getLineDowntimeEvents,
  getLineHourProfile,
  getLineMachines,
  getLineMetricsStaleness,
  getLinePerformance,
  getLineProductOptions,
  getLineProducts,
  getLineRejects,
  getLineReport,
  getLineReports,
  getMe,
  getMetricsStaleness,
  getMonthReportHourProfile,
  getPeriodMetricsStaleness,
  getPeriodReport,
  getPeriodReportActivity,
  getPeriodReportDowntimeEvents,
  getPeriodReportPerformance,
  getPeriodReportProducts,
  getPeriodReportRejects,
  getPeriodReports,
  getProductDetail,
  getQualityEntries,
  getReasonDetail,
  getReasonHistory,
  getRejectReasonOptions,
  getShiftReport,
  getShiftReportActivity,
  getShiftReportDowntimeEvents,
  getShiftReportPerformance,
  getShiftReportProducts,
  getShiftReportRejects,
  getShiftReports,
  getShiftTimeline,
  getWorkCenters,
  getWorkUnits,
  getMachineMonthOeeTrend,
  getMachineYearOeeTrend,
  getLineYearOeeTrend,
  getAreaYearOeeTrend,
  getMachineYearReports,
  getLineYearReports,
  getAreaYearReports,
  getMachineYearReport,
  getLineYearReport,
  getAreaYearReport,
  getMachineYearRejects,
  getLineYearRejects,
  getAreaYearRejects,
  getLineMonthOeeTrend,
  getAreaMonthOeeTrend,
  getDowntimeActions,
  getAreaActivity,
  getAreaDowntimeEvents,
  getAreaProductionUnits,
  getAreaProducts,
  getAreaRejects,
  getAreaReport,
  getAreaReports,
  getSkuActivity,
  getSkuDowntimeEvents,
  getSkuMachines,
  getSkuRejects,
  getSkuReport,
  getSkuReports,
} from "@/lib/api";

import { toBusinessDay } from "@/lib/format";

import type {
  LineReportListParams,
  DowntimeListParams,
  ActionBreakdownQuery,
  ReasonBreakdownParams,
  ReasonBreakdownQuery,
  ReasonDetailParams,
  ReasonSelectorParams,
  PeriodGrain,
  PeriodReportListParams,
  YearReportListParams,
  ShiftReportListParams,
  ShiftTimelineParams,
  TimelineScope,
  AreaReportListParams,
  SkuReportListParams,
} from "@/lib/api";

import type { AreaGrain, DowntimeCategory, LineGrain, ReasonMeasure } from "@/lib/types";

const meKey = ["me"] as const;

// Option objects rather than inline hook config, so route loaders can prefetch
// the same queries the components subscribe to (`ensureQueryData`).
//
// `retry: false` matters here: an unauthenticated visitor gets a 401, which is a
// normal answer rather than a transient failure — retrying only delays the
// redirect to login.
const meQueryOptions = queryOptions({
  queryKey: meKey,
  queryFn: getMe,
  staleTime: 5 * 60 * 1000,
  retry: false,
});

function useMe() {
  return useQuery(meQueryOptions);
}

// Reference data: small, rarely edited, and read by the header on every screen.
const REFERENCE_STALE_TIME = 5 * 60 * 1000;

const areasKey = ["areas"] as const;

const areasQueryOptions = queryOptions({
  queryKey: areasKey,
  queryFn: getAreas,
  staleTime: REFERENCE_STALE_TIME,
});

function useAreas() {
  return useQuery(areasQueryOptions);
}

// `enabled` is the cascade gate: upstream rejects a work-center request with no
// areaId, so nothing may fire until the header has settled on an area.
function workCentersQueryOptions(areaId: number | undefined) {
  return queryOptions({
    queryKey: ["work-centers", areaId] as const,
    queryFn: () => getWorkCenters(areaId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: areaId !== undefined,
  });
}

function useWorkCenters(areaId: number | undefined) {
  return useQuery(workCentersQueryOptions(areaId));
}

// The machines on one line, for the OEE Performance dashboard's machine picker.
//
// REFERENCE_STALE_TIME, matching areas, work centers, reasons and products — the
// four sibling mes-master-data catalogues. Without it this fires an upstream HTTP
// round trip (with a paging loop behind it) on every year, month or line change,
// for a catalogue that changes on the order of weeks.
//
// `enabled` is the same cascade gate workCentersQueryOptions carries one level up:
// core-api 400s a work-unit request with no workCenterId, so nothing may fire
// until a line is chosen.
function workUnitsQueryOptions(workCenterId: number | undefined) {
  return queryOptions({
    queryKey: ["work-units", workCenterId] as const,
    queryFn: () => getWorkUnits(workCenterId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: workCenterId !== undefined,
  });
}

function useWorkUnits(workCenterId: number | undefined) {
  return useQuery(workUnitsQueryOptions(workCenterId));
}

// The downtime edit dialog's two pickers, both mes-master-data catalogues and
// both REFERENCE_STALE_TIME for the same reason areas and work centers are.
//
// WHY THEY ARE FETCHED WHOLE AND FILTERED IN THE BROWSER. A server-side `?q=`
// would be a request per keystroke against a list of a few dozen rows that
// changes on the order of weeks — and it would make the picker unusable the
// moment upstream is slow, which is exactly when an operator is recording a
// stop. One fetch per line per five minutes, filtered locally, is both fewer
// requests and a picker that keeps typing at network speed.
//
// The core-api service in front of them serves stale on an upstream outage, so a
// picker degrades to a slightly old catalogue rather than to an empty one.
function downtimeReasonOptionsQueryOptions(workCenterId: number | undefined) {
  return queryOptions({
    queryKey: ["downtime-reason-options", workCenterId] as const,
    queryFn: () => getDowntimeReasonOptions(workCenterId as number),
    staleTime: REFERENCE_STALE_TIME,
    // The same cascade gate workCentersQueryOptions uses: upstream 400s without
    // a work center, so nothing may fire until the report has resolved its line.
    enabled: workCenterId !== undefined,
  });
}

function useDowntimeReasonOptions(workCenterId: number | undefined) {
  return useQuery(downtimeReasonOptionsQueryOptions(workCenterId));
}

// ---------------------------------------------------------------------------
// Part 3's catalogues, on the same policy and for the same reasons
// ---------------------------------------------------------------------------

// ONE ENTRY SERVING TWO PICKERS. The Reject and the Rework field read the same
// catalogue, so a second key would be a second cache entry that could disagree
// with the first about a line's reasons.
function rejectReasonOptionsQueryOptions(workCenterId: number | undefined) {
  return queryOptions({
    queryKey: ["reject-reason-options", workCenterId] as const,
    queryFn: () => getRejectReasonOptions(workCenterId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: workCenterId !== undefined,
  });
}

function useRejectReasonOptions(workCenterId: number | undefined) {
  return useQuery(rejectReasonOptionsQueryOptions(workCenterId));
}

function lineProductOptionsQueryOptions(workCenterId: number | undefined, enabled = true) {
  return queryOptions({
    queryKey: ["line-product-options", workCenterId] as const,
    queryFn: () => getLineProductOptions(workCenterId as number),
    staleTime: REFERENCE_STALE_TIME,
    // TWO GATES, AND THE SECOND IS THE CALLER'S. `workCenterId !== undefined` is
    // this query's own precondition; `enabled` is for a caller that has a work
    // centre and still does not want the list — the SKU entry dialog, whose
    // product is fixed by the report, where fetching a catalogue to choose from
    // would be a request whose answer cannot be used.
    enabled: enabled && workCenterId !== undefined,
  });
}

function useLineProductOptions(workCenterId: number | undefined, enabled = true) {
  return useQuery(lineProductOptionsQueryOptions(workCenterId, enabled));
}

// ONE PRODUCT'S PACKAGES — the unit picker's options, fetched WHEN THE SKU IS
// CHOSEN rather than up front.
//
// This is the cascade, and the gate is what makes it one. Keyed on the product so
// switching back to a previously chosen SKU is instant, and gated on `undefined`
// so nothing fires before there is a SKU — a bare `/products/undefined` would be
// a 400 the operator sees as a broken form.
//
// REFERENCE_STALE_TIME like the catalogues, and worth one caveat: the FACTOR the
// dialog previews with comes from here, while the factor the ENTRY is written
// with is re-resolved server-side and never cached (see MasterDataService). So a
// five-minute-stale preview can differ from what lands — which is why the
// response, not the preview, is what the ledger renders after a save.
function productDetailQueryOptions(productId: number | undefined) {
  return queryOptions({
    queryKey: ["product-detail", productId] as const,
    queryFn: () => getProductDetail(productId as number),
    staleTime: REFERENCE_STALE_TIME,
    enabled: productId !== undefined,
  });
}

function useProductDetail(productId: number | undefined) {
  return useQuery(productDetailQueryOptions(productId));
}

// THE LEDGER. Keyed on the SUBJECT and its axes plus `includeVoided`, because the
// sheet's read and the card's are genuinely different lists — sharing a key would
// make opening the sheet rewrite the card's figure with a set that includes voided
// rows.
//
// TWO SHAPES, AND THE LINE'S IS BYTE-IDENTICAL TO WHAT IT ALWAYS WAS. That is a
// design constraint rather than luck: line-losses-card.test.tsx seeds these keys
// directly, so its passing UNCHANGED is the gate proving the line behaviour did
// not move when the SKU subject arrived.
//
// The SKU shape has NO GRAIN in it, matching the rest of the sku-day-report-*
// family and for the reason skuReportQueryOptions gives — there is one table, and
// a constant in a cache key reads as a decision. It must never be
// ["work-center-quality-entries", "day", id]: seven report tables with seven
// independent identity sequences, so that key would collide with the LINE day
// report sharing the id and the second card to mount would render the other's
// ledger under this one's Reject tile.
function qualityEntriesPrefix(address: QualityAddress) {
  return address.subject === "sku"
    ? (["sku-day-report-quality-entries", address.id] as const)
    : (["work-center-quality-entries", address.grain, address.id] as const);
}

// The prefix plus the leaf. EXPORTED SEPARATELY from the prefix above so
// mutations.ts can invalidate without hand-writing a key that could drift from
// this builder — the one thing that would make a write refresh nothing.
const qualityEntriesKey = (address: QualityAddress, includeVoided: boolean) =>
  [...qualityEntriesPrefix(address), includeVoided] as const;

function qualityEntriesQueryOptions(address: QualityAddress, includeVoided = false) {
  return queryOptions({
    queryKey: qualityEntriesKey(address, includeVoided),
    queryFn: () => getQualityEntries(address, includeVoided),
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useQualityEntries(address: QualityAddress, includeVoided = false) {
  return useQuery(qualityEntriesQueryOptions(address, includeVoided));
}

// The line's hourly production, shift and day. GATED ON `open`, like the machine
// dialog's: a visit that never presses View pays for neither the request nor the
// recharts chunk.
function useLinePerformance(grain: "shift" | "day", id: number, enabled: boolean) {
  return useQuery({
    queryKey: ["work-center-performance", grain, id] as const,
    queryFn: () => getLinePerformance(grain, id),
    enabled,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

// The line's MONTH hour-of-day profile, for the Losses page's Trendline tab.
// Gated like its siblings so the Pareto view costs neither payload nor chunk.
function useLineHourProfile(id: number, enabled: boolean) {
  return useQuery({
    queryKey: ["work-center-hour-profile", id] as const,
    queryFn: () => getLineHourProfile(id),
    enabled,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

// No scope and so no gate: the action catalogue is regional upstream.
const downtimeActionOptionsKey = ["downtime-action-options"] as const;

const downtimeActionOptionsQueryOptions = queryOptions({
  queryKey: downtimeActionOptionsKey,
  queryFn: getDowntimeActionOptions,
  staleTime: REFERENCE_STALE_TIME,
});

function useDowntimeActionOptions() {
  return useQuery(downtimeActionOptionsQueryOptions);
}

// The params object is the cache key: every filter change is a distinct server
// page, and the list is server-paginated, so there is nothing to derive locally.
function shiftReportsQueryOptions(params: ShiftReportListParams) {
  return queryOptions({
    queryKey: ["shift-reports", params] as const,
    queryFn: () => getShiftReports(params),
    // Keeps the previous page on screen while the next one loads, so the table
    // does not collapse to skeletons on every page step.
    placeholderData: (previous) => previous,
  });
}

function useShiftReports(params: ShiftReportListParams) {
  return useQuery(shiftReportsQueryOptions(params));
}

function shiftReportQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["shift-report", id] as const,
    queryFn: () => getShiftReport(id),
    staleTime: REFERENCE_STALE_TIME,
    // A closed shift is immutable, and the loader maps 404 to notFound() — a
    // retry would only delay that.
    retry: false,
  });
}

function useShiftReport(id: number) {
  return useQuery(shiftReportQueryOptions(id));
}

// ---------------------------------------------------------------------------
// By Day and By Monthly
// ---------------------------------------------------------------------------
//
// GRAIN IS IN EVERY KEY, and it has to be: the two grains have independent id
// sequences, so day report 7 and month report 7 are different reports. A key of
// ["period-report", 7] would serve one screen the other's numbers, and both
// render perfectly.
//
// staleTime is the shift report's five minutes, uniformly. A completed month is
// immutable and could be cached far longer, but deciding "has this period ended"
// needs plant-local time in the browser, which is exactly the kind of thing this
// app pushes to the server. Filed rather than guessed.
function periodReportsQueryOptions(grain: PeriodGrain, params: PeriodReportListParams) {
  return queryOptions({
    queryKey: [`${grain}-reports`, params] as const,
    queryFn: () => getPeriodReports(grain, params),
    placeholderData: (previous) => previous,
  });
}

// `enabled` defaults to true so the four report LIST screens are untouched — an
// unfiltered page is exactly what they want. The OEE Performance dashboard passes
// false until its line resolves: there, an unscoped request is a page of every
// machine in the plant, fetched to answer a question about one of them.
function usePeriodReports(grain: PeriodGrain, params: PeriodReportListParams, enabled = true) {
  return useQuery({ ...periodReportsQueryOptions(grain, params), enabled });
}

// ---------------------------------------------------------------------------
// Line (work-center) report lists
// ---------------------------------------------------------------------------
//
// DIMENSION *AND* GRAIN ARE IN EVERY KEY, and both halves are load-bearing.
//
// AGENTS.md states the grain half: the report tables have INDEPENDENT `serial`
// sequences, so day report 7 and month report 7 are different reports. The
// dimension half is the same hazard one axis over — oee.work_center_*_reports are
// three MORE tables with three MORE sequences, so work-center shift report 7 is a
// fourth unrelated row.
//
// A key of ["shift-reports", params] here would serve the Line By Shift screen the
// MACHINE page for the same filters, and it would render PERFECTLY: same envelope,
// same four measures, a Line column populated on both. Nothing on screen and no
// test asserting "rows appear" would catch it.
//
// `work-center-` rather than `line-`: the API path, the id and the master-data
// resource are all "work center". "Line" is the label on the screen.
// ONE LINE REPORT, AND BOTH AXES IN THE KEY.
//
// The comment above says why grain is in it. The SUBJECT half is the same hazard
// one axis over and the reason is worth restating at the detail grain, where it
// bites harder: a key of ["shift-report", 7] here would collide with the MACHINE
// shift report 7 already in the cache, and whichever screen mounted second would
// render the other's report — same envelope, same forty measures, a populated Line
// column on both. Nothing on screen and no test asserting "the page rendered"
// would catch it.
function lineReportQueryOptions(grain: LineGrain, id: number) {
  return queryOptions({
    queryKey: [`work-center-${grain}-report`, id] as const,
    queryFn: () => getLineReport(grain, id),
    staleTime: REFERENCE_STALE_TIME,
    // The loader maps 404 to notFound(); a retry would only delay it.
    retry: false,
  });
}

// `enabled` defaults to true, so every route loader and detail screen is untouched.
// The OEE Performance dashboard needs the gate for usePeriodReport's reason: it
// resolves its report id from a LIST, so there is a render where no id exists yet,
// and firing `/work-centers/{grain}-reports/0` answers 400 — a real request and a real error state, for a
// report nobody asked for.
function useLineReport(grain: LineGrain, id: number, enabled = true) {
  return useQuery({ ...lineReportQueryOptions(grain, id), enabled });
}

// The Status tile's counts. Exported as a KEY as well, so mutations.ts can write
// through to it without hand-writing the string.
const lineApprovalKey = (id: number) => ["work-center-shift-report-approval", id] as const;

// SHIFT GRAIN ONLY, so no grain in the key — there is no day or month line
// approval, and a key carrying a constant would suggest otherwise.
//
// LIVE_SHIFT_STALE_TIME rather than REFERENCE_STALE_TIME, and not window-aware
// either. Every other payload on this screen is a function of the shift, so a
// closed shift makes it immutable; this one is not — somebody else can approve a
// machine on this line at any time.
function lineApprovalQueryOptions(id: number, enabled = true) {
  return queryOptions({
    queryKey: lineApprovalKey(id),
    queryFn: () => getLineApproval(id),
    // Gated so the coarse-grain screens, which have no approval at all, can call
    // the hook unconditionally rather than branching around it — React forbids a
    // conditional hook. The KEY does not carry `enabled`, so the route loader's
    // prefetch and the component's subscription still share one entry.
    enabled,
    staleTime: LIVE_SHIFT_STALE_TIME,
    retry: false,
  });
}

// THE CONSEQUENCE A CALLER MUST KNOW: a gated useQuery reports `status: "pending"`
// FOREVER. Read `data` and treat undefined as "not known yet"; never render a
// skeleton off `isPending` here, or a day screen shows one that never resolves.
function useLineApproval(id: number, enabled = true) {
  return useQuery(lineApprovalQueryOptions(id, enabled));
}

// THE GRAIN IS IN THE KEY'S PREFIX, not a field beside the id — the rule every
// other line key in this file follows, and which this one was exempt from only
// while the endpoint was shift-only (TODOS §60).
//
// It is load-bearing twice over. The three work_center_* tables have INDEPENDENT
// identity sequences, so `["work-center-report-activity", 7]` would collide
// between a shift 7, a day 7 and a month 7 and the second screen to mount would
// render the other's chronology. And `["shift-report-activity", 7]` — the machine
// feed's key — would collide across SUBJECTS, which is the sharper failure: same
// envelope, same three arms, a populated panel about another line's machines.
const lineActivityKey = (grain: LineGrain, id: number) =>
  [`work-center-${grain}-report-activity`, id] as const;

// `enabled: isOpen` for the reason the machine feed has it: an opt-in panel most
// visits never open should cost nothing. The KEY does not contain `isOpen`, so an
// approval can invalidate one entry whether or not the sheet is mounted.
//
// THE CONSEQUENCE THE SHEET HAS TO KNOW: a gated useQuery reports
// `status: "pending"` FOREVER, so its state ladder must read `open` before
// `isPending`.
function lineActivityQueryOptions(grain: LineGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: lineActivityKey(grain, id),
    queryFn: () => getLineActivity(grain, id),
    enabled,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useLineActivity(grain: LineGrain, id: number, isOpen: boolean) {
  return useQuery(lineActivityQueryOptions(grain, id, isOpen));
}

// ---------------------------------------------------------------------------
// Part 2's four line sub-resources
// ---------------------------------------------------------------------------
//
// BOTH AXES IN EVERY KEY, for the reason this file states at length and which is
// sharpest on the SKU one: `["shift-report-products", 7]` would collide with the
// MACHINE report 7's SKU rows, and because the line tables ship EMPTY the wrong
// entry would render a POPULATED card — a machine's SKUs under a line's heading,
// with nothing on screen saying so.

function lineProductsQueryOptions(grain: LineGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: [`work-center-${grain}-report-products`, id] as const,
    queryFn: () => getLineProducts(grain, id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useLineProducts(grain: LineGrain, id: number, enabled = true) {
  return useQuery(lineProductsQueryOptions(grain, id, enabled));
}

function lineMachinesQueryOptions(grain: LineGrain, id: number) {
  return queryOptions({
    queryKey: [`work-center-${grain}-report-machines`, id] as const,
    queryFn: () => getLineMachines(grain, id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useLineMachines(grain: LineGrain, id: number) {
  return useQuery(lineMachinesQueryOptions(grain, id));
}

// The Losses page's last two tabs. Gated on `enabled` the way their machine
// siblings are: exactly one tab is mounted at a time, so a tab nobody opened costs
// nothing — and a gated useQuery reports pending FOREVER, which is why every card
// reading these puts `no-params`/`enabled` ahead of `isPending` in its ladder.
// ─────────────────────────────────────────────────────────────────────────────
// The SKU grain
// ─────────────────────────────────────────────────────────────────────────────
//
// EVERY KEY CARRIES THE SUBJECT, and at this grain it has to. There are EIGHT
// report tables now with nine independent identity sequences, so an id is
// meaningful only against the one table it came from. A key of
// ["day-report", 7] would collide with the machine, line and area reports already
// cached under their own prefixes, and the second screen to mount would render
// another subject's forty measures under this one's heading.
//
// NO GRAIN IN THE KEY, unlike the line's, because there is one table. Putting a
// constant in a cache key is noise that reads as a decision.
function skuReportsQueryOptions(params: SkuReportListParams) {
  return queryOptions({
    queryKey: ["sku-day-reports", params] as const,
    queryFn: () => getSkuReports(params),
    // Keeps the previous page on screen while the next loads, matching the other
    // five lists, so the table does not collapse to skeletons on a page step.
    placeholderData: (previous) => previous,
  });
}

function useSkuReports(params: SkuReportListParams) {
  return useQuery(skuReportsQueryOptions(params));
}

function skuReportQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["sku-day-report", id] as const,
    queryFn: () => getSkuReport(id),
    staleTime: REFERENCE_STALE_TIME,
    // The loader maps a 404 to the router's notFound state; retrying a 404 just
    // delays that by three round trips.
    retry: false,
  });
}

function useSkuReport(id: number) {
  return useQuery(skuReportQueryOptions(id));
}

function skuRejectsQueryOptions(id: number, enabled = true) {
  return queryOptions({
    queryKey: ["sku-day-report-rejects", id] as const,
    queryFn: () => getSkuRejects(id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useSkuRejects(id: number, enabled = true) {
  return useQuery(skuRejectsQueryOptions(id, enabled));
}

function skuDowntimeEventsQueryOptions(id: number, enabled = true) {
  return queryOptions({
    queryKey: ["sku-day-report-downtime-events", id] as const,
    queryFn: () => getSkuDowntimeEvents(id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useSkuDowntimeEvents(id: number, enabled = true) {
  return useQuery(skuDowntimeEventsQueryOptions(id, enabled));
}

// THE SKU DAY REPORT'S LOG ACTIVITY PANEL.
//
// Its own key, hook and fetcher beside the line's rather than a parameterised
// pair, for the reason line-activity-sheet.tsx states: the two take an id from a
// different sequence and hit a different path, and confusing them renders another
// subject's history in this panel with nothing on screen saying so. Naming the
// endpoint at the call site is what lets a test assert WHICH one answered.
//
// `isOpen` IS NOT IN THE KEY, deliberately, matching both existing feeds: a
// mutation has to be able to invalidate this entry while the sheet is closed, and
// a key carrying the open state would make the closed copy a separate one that
// nothing refreshes.
const skuActivityKey = (id: number) => ["sku-day-report-activity", id] as const;

function skuActivityQueryOptions(id: number, enabled: boolean) {
  return queryOptions({
    queryKey: skuActivityKey(id),
    queryFn: () => getSkuActivity(id),
    // GATED, so an opt-in panel most visits never open costs nothing. A gated
    // useQuery reports `status: "pending"` FOREVER, which is why the sheet reads
    // `open` before `isPending`.
    enabled,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useSkuActivity(id: number, isOpen: boolean) {
  return useQuery(skuActivityQueryOptions(id, isOpen));
}

// The reject dialog's Machine picker. A ROSTER — which machines reported into this
// line on this day — and NOT useLineMachines, whose id comes from a different
// sequence and whose payload carries a machine REPORT id this form must not reach.
function skuMachinesQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["sku-day-report-machines", id] as const,
    queryFn: () => getSkuMachines(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useSkuMachines(id: number) {
  return useQuery(skuMachinesQueryOptions(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// The AREA grain
// ─────────────────────────────────────────────────────────────────────────────
//
// EVERY KEY CARRIES THE SUBJECT *AND* THE GRAIN, for the reason the SKU section
// states one table over — nine report tables, eight independent identity
// sequences. Area day report 7 and area month report 7 are DIFFERENT reports, so a
// key of `["area-report", 7]` would collide and the second screen to mount would
// render the other period's forty measures.
//
// THE GRAIN IS IN THE PREFIX, not a field beside the id, which is
// `lineReportQueryOptions`' shape: `` `area-${grain}-report` ``. A field would key
// the same string with two different payloads under it, and TanStack compares keys
// structurally — so it would work, and it would read as though one entry held both.
//
// THE DAY GRAIN SHIPPED WITH NO GRAIN IN ITS KEY at all, and this note said the
// month "gets its OWN prefix rather than a `grain` field". Interpolating it is that,
// with the prefix built rather than written twice.
function areaReportsQueryOptions(grain: AreaGrain, params: AreaReportListParams) {
  return queryOptions({
    queryKey: [`area-${grain}-reports`, params] as const,
    queryFn: () => getAreaReports(grain, params),
    // Keeps the previous page on screen while the next loads, matching every other
    // list, so the table does not collapse to skeletons on a page step.
    placeholderData: (previous) => previous,
  });
}

// `enabled` defaults to true, AND THE DEFAULT IS THE INTERESTING HALF.
//
// The Report > Area LIST must keep passing nothing. Its ungated first paint is
// deliberate and documented: core-api reads an absent `areaId` as EVERY area, so the
// page shows data immediately and narrows a tick later — the inverse of the
// stranded-id rule, and right for a list.
//
// THE DASHBOARD MUST GATE, and the same fact is what makes it necessary rather than
// merely tidy. That screen does not DISPLAY these rows, it SEARCHES them for one
// area's report id. Ungated, the first response is a page of OTHER areas' rows, and
// a match against it opens a stranger's report — populated, plausible, and under
// this area's heading. See findAreaMonthReportId.
function useAreaReports(grain: AreaGrain, params: AreaReportListParams, enabled = true) {
  return useQuery({ ...areaReportsQueryOptions(grain, params), enabled });
}

function areaReportQueryOptions(grain: AreaGrain, id: number) {
  return queryOptions({
    queryKey: [`area-${grain}-report`, id] as const,
    queryFn: () => getAreaReport(grain, id),
    staleTime: REFERENCE_STALE_TIME,
    // The loader maps a 404 to the router's notFound state; retrying a 404 just
    // delays that by three round trips.
    retry: false,
  });
}

// `enabled` defaults to true, so every route loader and detail screen is untouched.
// The OEE Performance dashboard needs the gate for usePeriodReport's reason: it
// resolves its report id from a LIST, so there is a render where no id exists yet,
// and firing `/areas/{grain}-reports/0` answers 400 — a real request and a real error state, for a
// report nobody asked for.
function useAreaReport(grain: AreaGrain, id: number, enabled = true) {
  return useQuery({ ...areaReportQueryOptions(grain, id), enabled });
}

function areaProductsQueryOptions(grain: AreaGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: [`area-${grain}-report-products`, id] as const,
    queryFn: () => getAreaProducts(grain, id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useAreaProducts(grain: AreaGrain, id: number, enabled = true) {
  return useQuery(areaProductsQueryOptions(grain, id, enabled));
}

// THE INPUT/OUTPUT PRODUCTION KPI. Its own query rather than a field on the
// report, for the argument the line's `/approval` makes: answering it means three
// aggregates over every line report in the window, and the route loader AWAITS the
// report while only PREFETCHING this — so a fan-out cannot delay first paint.
function areaProductionUnitsQueryOptions(grain: AreaGrain, id: number) {
  return queryOptions({
    queryKey: [`area-${grain}-report-production-units`, id] as const,
    queryFn: () => getAreaProductionUnits(grain, id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useAreaProductionUnits(grain: AreaGrain, id: number) {
  return useQuery(areaProductionUnitsQueryOptions(grain, id));
}

function areaRejectsQueryOptions(grain: AreaGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: [`area-${grain}-report-rejects`, id] as const,
    queryFn: () => getAreaRejects(grain, id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useAreaRejects(grain: AreaGrain, id: number, enabled = true) {
  return useQuery(areaRejectsQueryOptions(grain, id, enabled));
}

function areaDowntimeEventsQueryOptions(grain: AreaGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: [`area-${grain}-report-downtime-events`, id] as const,
    queryFn: () => getAreaDowntimeEvents(grain, id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useAreaDowntimeEvents(grain: AreaGrain, id: number, enabled = true) {
  return useQuery(areaDowntimeEventsQueryOptions(grain, id, enabled));
}

// THE AREA DAY REPORT'S LOG ACTIVITY PANEL.
//
// Its own key, hook and fetcher beside the other three rather than a parameterised
// set, for the reason the SKU one states: they take ids from different sequences
// and hit different paths, and confusing them renders another subject's history in
// this panel with nothing on screen saying so.
//
// `isOpen` IS NOT IN THE KEY, matching all three existing feeds: a mutation has to
// be able to invalidate this entry while the sheet is closed, and a key carrying
// the open state would make the closed copy a separate one that nothing refreshes.
const areaActivityKey = (grain: AreaGrain, id: number) =>
  [`area-${grain}-report-activity`, id] as const;

function areaActivityQueryOptions(grain: AreaGrain, id: number, enabled: boolean) {
  return queryOptions({
    queryKey: areaActivityKey(grain, id),
    queryFn: () => getAreaActivity(grain, id),
    // GATED, so an opt-in panel most visits never open costs nothing. A gated
    // useQuery reports `status: "pending"` FOREVER, which is why the sheet reads
    // `open` before `isPending`.
    enabled,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useAreaActivity(grain: AreaGrain, id: number, isOpen: boolean) {
  return useQuery(areaActivityQueryOptions(grain, id, isOpen));
}

function lineRejectsQueryOptions(grain: LineGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: [`work-center-${grain}-report-rejects`, id] as const,
    queryFn: () => getLineRejects(grain, id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useLineRejects(grain: LineGrain, id: number, enabled = true) {
  return useQuery(lineRejectsQueryOptions(grain, id, enabled));
}

function lineDowntimeEventsQueryOptions(grain: LineGrain, id: number, enabled = true) {
  return queryOptions({
    queryKey: [`work-center-${grain}-report-downtime-events`, id] as const,
    queryFn: () => getLineDowntimeEvents(grain, id),
    enabled,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useLineDowntimeEvents(grain: LineGrain, id: number, enabled = true) {
  return useQuery(lineDowntimeEventsQueryOptions(grain, id, enabled));
}

// ---------------------------------------------------------------------------
// The sub-resources several subjects share, picked in ONE place
// ---------------------------------------------------------------------------
//
// EIGHT ENDPOINTS EACH NOW — three machine grains, three line grains, one SKU and
// one AREA — and the choice between them lives here rather than in the four cards
// that read them. Each card called a "two hooks, one picked" ladder of its own;
// adding a line would have made that three, four times over, and four copies of a
// choice is four chances to make it differently.
//
// It is the move `reportWindowParams` already makes: discriminate on the report's
// own SUBJECT TAG and hand back the right thing.
//
// THE TAG REPLACED A SHAPE CHECK ON 2026-09-02. These read `isLineReport(report)`,
// i.e. "has no workUnitId" — correct for two subjects and silently wrong for
// three, because a SKU report has no workUnitId either and would have taken the
// LINE branch here: a populated payload about a different report, on every one of
// these four hooks at once. `report.subject` is a tag no missing column can
// satisfy. The cards keep their state ladders and
// their tests keep asserting WHICH api function ran — the assertion that matters,
// because the wrong endpoint here returns a populated payload about a different
// report, not an error.
//
// THREE HOOKS, ONE PICKED, in each. React forbids calling a hook conditionally, so
// the two that are not in play are gated off with `enabled: false` and cost
// nothing — the arrangement each card used for its two, kept for the same reason.
// A gated useQuery reports `status: "pending"` FOREVER, which is why every caller's
// ladder reads its gate before `isPending`.
function useReportRejects(report: AnyReport) {
  // FIVE HOOKS, ONE PICKED. React forbids calling a hook conditionally, so the
  // four not in play are gated off with `enabled: false` and cost nothing. A
  // gated useQuery reports `status: "pending"` FOREVER, which is why every
  // caller's ladder reads its gate before `isPending`.
  //
  // EVERY NEW ARM HAS HAD TO BE ADDED BY HAND AND THE COMPILER COULD NOT ASK FOR
  // IT — twice now, and the failure was the same both times. Widening the parameter
  // to AnyReport leaves this function type-correct and WRONG: a SKU report and an
  // AREA report both have `grain === "day"`, so either falls through into the
  // MACHINE period query, called with an id from another sequence. Eight tables,
  // eight independent sequences — that returns a real machine's day report,
  // populated, about another subject entirely.
  //
  // THE SUBJECT IS CHECKED FIRST FOR THAT REASON, before grain is consulted at
  // all, and each arm is a plain boolean rather than a switch because the hook
  // calls have to be unconditional.
  const area = report.subject === "area";
  // THE GRAIN THE GATED AREA QUERY IS KEYED ON. `report.grain` is `"shift" | "day"
  // | "month"` across the union and an area's is only ever `"day" | "month"`, so
  // this narrows once — and defaults to "day" for the three subjects whose query is
  // gated OFF anyway, because a key is still built for a query that never runs and
  // it must not be a key another screen could collide with.
  const areaGrain: AreaGrain = area && report.grain === "month" ? "month" : "day";
  const sku = report.subject === "sku";
  const line = report.subject === "line";
  const machine = report.subject === "machine";
  const isShift = machine && report.grain === "shift";

  const areaQuery = useAreaRejects(areaGrain, area ? report.id : 0, area);
  const skuQuery = useSkuRejects(sku ? report.id : 0, sku);
  const shiftQuery = useShiftReportRejects(isShift ? report.id : 0, isShift);
  const periodQuery = usePeriodReportRejects(
    report.grain === "shift" ? "day" : (report.grain as PeriodGrain),
    machine && !isShift ? report.id : 0,
    machine && !isShift,
  );
  const lineQuery = useLineRejects(report.grain, line ? report.id : 0, line);

  if (area) return areaQuery;
  if (sku) return skuQuery;
  if (line) return lineQuery;
  return isShift ? shiftQuery : periodQuery;
}

function useReportDowntimeEvents(report: AnyReport) {
  // FIVE HOOKS, ONE PICKED — see useReportRejects above for why the subject is
  // checked before the grain, and why adding an arm here is a manual step the
  // compiler cannot demand.
  //
  // ONE ASYMMETRY IN THE PAYLOADS, and it is deliberate rather than an oversight:
  // the SKU arm's response carries an `unattributed` count and the AREA arm's does
  // not. A SKU read narrows by `product_id` (OCCUPANCY OVER TIME — NULL means "not
  // attributed" and nothing can derive it), an area read by `area_id`
  // (CONTAINMENT — a NULL is a missing label and the fix is a backfill). The Others
  // card reads the field optionally, so both shapes render correctly.
  const area = report.subject === "area";
  // THE GRAIN THE GATED AREA QUERY IS KEYED ON. `report.grain` is `"shift" | "day"
  // | "month"` across the union and an area's is only ever `"day" | "month"`, so
  // this narrows once — and defaults to "day" for the three subjects whose query is
  // gated OFF anyway, because a key is still built for a query that never runs and
  // it must not be a key another screen could collide with.
  const areaGrain: AreaGrain = area && report.grain === "month" ? "month" : "day";
  const sku = report.subject === "sku";
  const line = report.subject === "line";
  const machine = report.subject === "machine";
  const isShift = machine && report.grain === "shift";

  const areaQuery = useAreaDowntimeEvents(areaGrain, area ? report.id : 0, area);
  const skuQuery = useSkuDowntimeEvents(sku ? report.id : 0, sku);
  const shiftQuery = useShiftReportDowntimeEvents(isShift ? report.id : 0, isShift);
  const periodQuery = usePeriodReportDowntimeEvents(
    report.grain === "shift" ? "day" : (report.grain as PeriodGrain),
    machine && !isShift ? report.id : 0,
    machine && !isShift,
  );
  const lineQuery = useLineDowntimeEvents(report.grain, line ? report.id : 0, line);

  if (area) return areaQuery;
  if (sku) return skuQuery;
  if (line) return lineQuery;
  return isShift ? shiftQuery : periodQuery;
}

// IS THIS REPORT'S DOWNTIME FROZEN? — what stops the row menu offering an edit the
// server would answer 409.
//
// THREE DIFFERENT SOURCES, and the middle one is an approximation the server
// corrects:
//
//   machine shift   `approval.status`, a real row. Exact.
//   machine day/mo  ALL its child shift reports closed. On a partially approved day
//                   the menu therefore offers an edit on a row belonging to the
//                   shift that IS closed, and the server refuses it with a 409 the
//                   dialog surfaces. The alternative is worse: the browser would
//                   have to know which shift each stop falls in, which means a
//                   second copy of SHIFT_WINDOWS here — the arithmetic divergence
//                   shared/shift-window.ts exists to prevent. TODOS §49.
//   line shift      ALL its machines approved, from the approval summary. Same
//                   approximation, same 409 fallback.
//   line day/month  NEVER frozen by the LINE, because there is no line day
//                   approval (§48). Individual stops may still be frozen by their
//                   MACHINE's shift approval, and the server enforces that — which
//                   is the honest position: this hook says what the line knows, and
//                   the server owns the truth.
//   sku day         never frozen. No approval key at this grain at all.
//   area day        never frozen, same reason, and the server's refusal is the
//                   only authority: a stop in an area belongs to a machine whose
//                   shift report may well be closed.
//
// A HOOK RATHER THAN A PROP so no caller has to know any of the above, and so the
// line branch can subscribe to the summary it needs. The query is gated off for a
// machine report, and a gated useQuery reports pending forever — which does not
// matter here because only `data` is read.
function useReportApproved(report: AnyReport): boolean {
  const line = report.subject === "line";
  const { data: summary } = useLineApproval(line ? report.id : 0, line && report.grain === "shift");

  if (line) {
    if (report.grain !== "shift" || summary === undefined) return false;
    return summary.machinesFound > 0 && summary.machinesClosed === summary.machinesFound;
  }

  // A SKU AND AN AREA ARE NEVER FROZEN BY THEIR OWN REPORT, and this is a stronger
  // statement than the line day/month arm's. That one has child records it could
  // count and declines to (§48); these two have no approval key at all —
  // oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift) and
  // neither grain has either half.
  //
  // FALSE MEANS "NOT FROZEN", WHICH IS THE PERMISSIVE ANSWER, and it is the right
  // one here for the reason the pending arm gives: individual stops may still be
  // frozen by their MACHINE's shift approval, the server enforces that and refuses
  // with a 409 the dialog surfaces. Offering an edit that 409s is recoverable;
  // refusing one that would have worked is not explainable.
  //
  // The alternative — knowing which shift each stop fell in — means a second copy
  // of SHIFT_WINDOWS in the browser, which is the arithmetic divergence
  // shared/shift-window.ts exists to prevent (§49). It is worse at area grain than
  // at SKU: an area day spans N lines as well as three shifts.
  if (report.subject === "sku" || report.subject === "area") return false;

  return report.grain === "shift"
    ? report.approval.status === "closed"
    : report.approval !== null && report.approval.shiftsClosed === report.approval.shiftsTotal;
}

function useReportProducts(report: AnyReport) {
  // FOUR HOOKS AND NO SKU ONE, because there is no endpoint to call at that
  // subject: a SKU report IS one SKU, so a per-SKU breakdown of it is one row
  // repeating the card above. SkuViewCard is therefore not rendered on a SKU screen
  // at all — but this hook takes AnyReport, so the arm is written rather than left
  // to fall through into the machine period query with a SKU's id.
  //
  // THE AREA ARM IS A REAL ENDPOINT, unlike the SKU one, and that is the point of
  // reading the two lines below together. An area's SKU View is a ROLL-UP over its
  // lines — legitimate here, and forbidden one grain down for contract §17.1's
  // reason (a machine-summed SKU View would visibly disagree with the LINE card
  // above it, and the disagreement would be correct). Neither half holds at area
  // grain: summing within one unit across lines is exact, and the card above is
  // denominated in MASS.
  const area = report.subject === "area";
  // THE GRAIN THE GATED AREA QUERY IS KEYED ON. `report.grain` is `"shift" | "day"
  // | "month"` across the union and an area's is only ever `"day" | "month"`, so
  // this narrows once — and defaults to "day" for the three subjects whose query is
  // gated OFF anyway, because a key is still built for a query that never runs and
  // it must not be a key another screen could collide with.
  const areaGrain: AreaGrain = area && report.grain === "month" ? "month" : "day";
  const sku = report.subject === "sku";
  const line = report.subject === "line";
  const machine = report.subject === "machine";
  const isShift = machine && report.grain === "shift";

  const areaQuery = useAreaProducts(areaGrain, area ? report.id : 0, area);
  const shiftQuery = useShiftReportProducts(isShift ? report.id : 0, isShift);
  const periodQuery = usePeriodReportProducts(
    report.grain === "shift" ? "day" : (report.grain as PeriodGrain),
    machine && !isShift ? report.id : 0,
    machine && !isShift,
  );
  const lineQuery = useLineProducts(report.grain, line ? report.id : 0, line);

  if (area) return areaQuery;
  // Every query gated off. The card's ladder reads its gate before `isPending`,
  // so this renders its empty state rather than a permanent skeleton.
  if (sku) return lineQuery;
  if (line) return lineQuery;
  return isShift ? shiftQuery : periodQuery;
}

function lineReportsQueryOptions(grain: LineGrain, params: LineReportListParams) {
  return queryOptions({
    queryKey: [`work-center-${grain}-reports`, params] as const,
    queryFn: () => getLineReports(grain, params),
    // Keeps the previous page on screen while the next one loads, matching both
    // work-unit lists, so the table does not collapse to skeletons on a page step.
    placeholderData: (previous) => previous,
  });
}

// `enabled` defaults to true, so every shipped list caller is untouched. The OEE
// Performance dashboard needs the gate for usePeriodReports' reason: it resolves a
// report ID from this list, so there is a render before the line is known, and an
// UNSCOPED request asks for every line in the plant to answer a question about one.
function useLineReports(grain: LineGrain, params: LineReportListParams, enabled = true) {
  return useQuery({ ...lineReportsQueryOptions(grain, params), enabled });
}

function periodReportQueryOptions(grain: PeriodGrain, id: number) {
  return queryOptions({
    queryKey: [`${grain}-report`, id] as const,
    queryFn: () => getPeriodReport(grain, id),
    staleTime: REFERENCE_STALE_TIME,
    // Same reasoning as the shift report: the loader maps 404 to notFound(), and
    // a retry would only delay it.
    retry: false,
  });
}

// `enabled` defaults to true, so every shipped caller is untouched. The OEE
// Performance dashboard needs the gate: it resolves its report id from a LIST, so
// there is a render where no id exists yet, and firing `/month-reports/0` answers
// 400 — a real request, a real error state, for a report nobody asked for.
function usePeriodReport(grain: PeriodGrain, id: number, enabled = true) {
  return useQuery({ ...periodReportQueryOptions(grain, id), enabled });
}

// The daily OEE curve behind the OEE Performance dashboard's trend chart.
//
// THE KEY CARRIES THE SUBJECT AND THE GRAIN IN ITS PREFIX, not as a field beside
// the id. There are nine report tables with nine independent identity sequences,
// so `["oee-trend", 7]` would let a LINE month report's curve answer for a MACHINE
// month report's — a populated, plausible chart about another machine.
//
// `closed` DRIVES THE staleTime and is passed in rather than derived here: a month
// that has ended can never change, so its curve is immutable and caching it
// forever saves a refetch every time the operator returns to it. It is the
// window-aware idiom shiftTimelineQueryOptions uses, reached through the report —
// this payload carries no `to` for the usual closure to read.
function machineMonthOeeTrendQueryOptions(id: number, closed: boolean) {
  return queryOptions({
    queryKey: ["work-unit-month-oee-trend", id] as const,
    queryFn: () => getMachineMonthOeeTrend(id),
    staleTime: closed ? Infinity : LIVE_SHIFT_STALE_TIME,
  });
}

// The same curve for the LINE and the AREA, and the three keys are the load-bearing
// part rather than the three functions.
//
// `oee.work_center_month_reports` and `oee.area_month_reports` have their own
// identity sequences, so month report 7 exists at all three subjects and means three
// different things. A shared `["oee-trend", id]` would let whichever screen mounted
// second render the first's curve — populated, plausible, about another subject and
// possibly another month. The subject is in the PREFIX for exactly that reason.
//
// These two endpoints shipped with `e847dfc` and had no consumer until now; the
// parameterisation in shared/oee-trend.ts is what made them one registration each.
function lineMonthOeeTrendQueryOptions(id: number, closed: boolean) {
  return queryOptions({
    queryKey: ["work-center-month-oee-trend", id] as const,
    queryFn: () => getLineMonthOeeTrend(id),
    staleTime: closed ? Infinity : LIVE_SHIFT_STALE_TIME,
  });
}

function areaMonthOeeTrendQueryOptions(id: number, closed: boolean) {
  return queryOptions({
    queryKey: ["area-month-oee-trend", id] as const,
    queryFn: () => getAreaMonthOeeTrend(id),
    staleTime: closed ? Infinity : LIVE_SHIFT_STALE_TIME,
  });
}

// GATED, for the reason usePeriodReport is: this id comes from a list lookup, and
// `/month-reports/0/oee-trend` is a 400 rather than an empty curve. Callers must
// read their own `hasParams` BEFORE this query's `isPending` — a gated useQuery
// pends forever (lib/load-state.ts), which OeeTrendCard's ladder already does.
function useMachineMonthOeeTrend(id: number, closed: boolean, enabled = true) {
  return useQuery({ ...machineMonthOeeTrendQueryOptions(id, closed), enabled });
}

function useLineMonthOeeTrend(id: number, closed: boolean, enabled = true) {
  return useQuery({ ...lineMonthOeeTrendQueryOptions(id, closed), enabled });
}

function useAreaMonthOeeTrend(id: number, closed: boolean, enabled = true) {
  return useQuery({ ...areaMonthOeeTrendQueryOptions(id, closed), enabled });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE YEAR GRAIN — four queries per subject, and the KEYS are the load-bearing part
// ─────────────────────────────────────────────────────────────────────────────
//
// TWELVE REPORT TABLES NOW, with twelve INDEPENDENT identity sequences: `0027`
// added a year table at each of the three subjects that had a month one. So report
// id 7 exists as a machine month, a machine year, a line month, a line year, an
// area month and an area year — six different reports — and every one of these
// payloads has the SAME SHAPE as its siblings.
//
// Both the SUBJECT and the GRAIN therefore live in the key PREFIX, never as a
// field beside the id. A key of `["year-report", 7]` would let whichever screen
// mounted second render another subject's forty measures.
function machineYearReportsQueryOptions(params: YearReportListParams) {
  return queryOptions({
    queryKey: ["work-unit-year-reports", params] as const,
    queryFn: () => getMachineYearReports(params),
    placeholderData: (previous) => previous,
  });
}

function lineYearReportsQueryOptions(params: YearReportListParams) {
  return queryOptions({
    queryKey: ["work-center-year-reports", params] as const,
    queryFn: () => getLineYearReports(params),
    placeholderData: (previous) => previous,
  });
}

function areaYearReportsQueryOptions(params: YearReportListParams) {
  return queryOptions({
    queryKey: ["area-year-reports", params] as const,
    queryFn: () => getAreaYearReports(params),
    placeholderData: (previous) => previous,
  });
}

// GATED, all three, for usePeriodReports' reason: these lists are SEARCHED for a
// report id, so an unscoped first request asks for every subject in the plant to
// answer a question about one of them.
function useMachineYearReports(params: YearReportListParams, enabled = true) {
  return useQuery({ ...machineYearReportsQueryOptions(params), enabled });
}
function useLineYearReports(params: YearReportListParams, enabled = true) {
  return useQuery({ ...lineYearReportsQueryOptions(params), enabled });
}
function useAreaYearReports(params: YearReportListParams, enabled = true) {
  return useQuery({ ...areaYearReportsQueryOptions(params), enabled });
}

function machineYearReportQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["work-unit-year-report", id] as const,
    queryFn: () => getMachineYearReport(id),
    staleTime: REFERENCE_STALE_TIME,
    retry: false,
  });
}
function lineYearReportQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["work-center-year-report", id] as const,
    queryFn: () => getLineYearReport(id),
    staleTime: REFERENCE_STALE_TIME,
    retry: false,
  });
}
function areaYearReportQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["area-year-report", id] as const,
    queryFn: () => getAreaYearReport(id),
    staleTime: REFERENCE_STALE_TIME,
    retry: false,
  });
}

function useMachineYearReport(id: number, enabled = true) {
  return useQuery({ ...machineYearReportQueryOptions(id), enabled });
}
function useLineYearReport(id: number, enabled = true) {
  return useQuery({ ...lineYearReportQueryOptions(id), enabled });
}
function useAreaYearReport(id: number, enabled = true) {
  return useQuery({ ...areaYearReportQueryOptions(id), enabled });
}

// The three YEAR curves. `closed` comes from `isYearClosed`, not `isMonthClosed` —
// handing this the month predicate would compare a year row's `YYYY-01-01` on its
// first seven characters and report a finished year as open all year, which costs
// only refetches; the reverse pairing caches a LIVE period forever, which does not.
function machineYearOeeTrendQueryOptions(id: number, closed: boolean) {
  return queryOptions({
    queryKey: ["work-unit-year-oee-trend", id] as const,
    queryFn: () => getMachineYearOeeTrend(id),
    staleTime: closed ? Infinity : LIVE_SHIFT_STALE_TIME,
  });
}
function lineYearOeeTrendQueryOptions(id: number, closed: boolean) {
  return queryOptions({
    queryKey: ["work-center-year-oee-trend", id] as const,
    queryFn: () => getLineYearOeeTrend(id),
    staleTime: closed ? Infinity : LIVE_SHIFT_STALE_TIME,
  });
}
function areaYearOeeTrendQueryOptions(id: number, closed: boolean) {
  return queryOptions({
    queryKey: ["area-year-oee-trend", id] as const,
    queryFn: () => getAreaYearOeeTrend(id),
    staleTime: closed ? Infinity : LIVE_SHIFT_STALE_TIME,
  });
}

function useMachineYearOeeTrend(id: number, closed: boolean, enabled = true) {
  return useQuery({ ...machineYearOeeTrendQueryOptions(id, closed), enabled });
}
function useLineYearOeeTrend(id: number, closed: boolean, enabled = true) {
  return useQuery({ ...lineYearOeeTrendQueryOptions(id, closed), enabled });
}
function useAreaYearOeeTrend(id: number, closed: boolean, enabled = true) {
  return useQuery({ ...areaYearOeeTrendQueryOptions(id, closed), enabled });
}

function machineYearRejectsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["work-unit-year-report-rejects", id] as const,
    queryFn: () => getMachineYearRejects(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}
function lineYearRejectsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["work-center-year-report-rejects", id] as const,
    queryFn: () => getLineYearRejects(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}
function areaYearRejectsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["area-year-report-rejects", id] as const,
    queryFn: () => getAreaYearRejects(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useMachineYearRejects(id: number, enabled = true) {
  return useQuery({ ...machineYearRejectsQueryOptions(id), enabled });
}
function useLineYearRejects(id: number, enabled = true) {
  return useQuery({ ...lineYearRejectsQueryOptions(id), enabled });
}
function useAreaYearRejects(id: number, enabled = true) {
  return useQuery({ ...areaYearRejectsQueryOptions(id), enabled });
}

function periodReportProductsQueryOptions(grain: PeriodGrain, id: number) {
  return queryOptions({
    queryKey: [`${grain}-report-products`, id] as const,
    queryFn: () => getPeriodReportProducts(grain, id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function usePeriodReportProducts(grain: PeriodGrain, id: number, enabled = true) {
  return useQuery({ ...periodReportProductsQueryOptions(grain, id), enabled });
}

// The per-SKU breakdown of one report. Keyed on the id alone — everything the
// server needs to find the rows is on the report row itself, so unlike the
// timeline below this query has no params to derive and no `enabled` gate: it can
// be fired the moment a route knows its id, before the report has resolved.
//
// Flat staleTime rather than the timeline's window-aware function. That trick reads
// the shift's `to` off the response to decide a closed shift is immutable; this
// payload carries no window, and the browser deliberately has no shift-boundary
// table of its own (see shiftTimelineQueryOptions below), so closed-ness cannot be
// derived here. Reaching into the timeline query's cache for it would couple two
// independent queries — five minutes, matching the report itself, is the honest
// answer.
function shiftReportProductsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["shift-report-products", id] as const,
    queryFn: () => getShiftReportProducts(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

// `enabled` defaults to true, so the route loaders and every existing caller are
// untouched. SkuViewCard passes it because it serves three grains and React
// forbids calling a hook conditionally.
function useShiftReportProducts(id: number, enabled = true) {
  return useQuery({ ...shiftReportProductsQueryOptions(id), enabled });
}

// The hourly production profile behind the Losses card's View button.
//
// `enabled: isOpen` is the point of this one. It is a click-gated drill-down, so
// unlike the products query it is deliberately NOT prefetched by the route loader
// and does not fire while the dialog is closed — seven cards should not wait on an
// eighth request that most visits never look at. It also keeps the recharts chunk
// off the critical path, since the component that imports it only mounts when open.
//
// Flat staleTime, matching shiftReportProductsQueryOptions and for the same stated
// reason: this payload carries no shift window, so closed-ness cannot be derived
// the way the timeline derives it, and reaching into the timeline query's cache for
// it would couple two independent queries.
function shiftReportPerformanceQueryOptions(id: number, isOpen: boolean) {
  return queryOptions({
    queryKey: ["shift-report-performance", id] as const,
    queryFn: () => getShiftReportPerformance(id),
    enabled: isOpen,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useShiftReportPerformance(id: number, isOpen: boolean) {
  return useQuery(shiftReportPerformanceQueryOptions(id, isOpen));
}

// The same drill-down on a DAY report — 24 buckets rather than 8, from the same
// grain-agnostic query on the server.
//
// Its own key prefix, not a shared one with a grain field: day report 7 and
// shift report 7 are different reports, and a shared prefix would serve one
// dialog the other's hours.
function periodReportPerformanceQueryOptions(id: number, isOpen: boolean) {
  return queryOptions({
    queryKey: ["day-report-performance", id] as const,
    queryFn: () => getPeriodReportPerformance(id),
    enabled: isOpen,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function usePeriodReportPerformance(id: number, isOpen: boolean) {
  return useQuery(periodReportPerformanceQueryOptions(id, isOpen));
}

// The month report's hour-of-day profile. Its own key prefix and its own payload
// shape — a month 7 and a day 7 are different reports, and the two payloads are
// not interchangeable.
function monthReportHourProfileQueryOptions(id: number, isOpen: boolean) {
  return queryOptions({
    queryKey: ["month-report-hour-profile", id] as const,
    queryFn: () => getMonthReportHourProfile(id),
    enabled: isOpen,
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useMonthReportHourProfile(id: number, isOpen: boolean) {
  return useQuery(monthReportHourProfileQueryOptions(id, isOpen));
}

// The Quality and Others tabs at day or month grain.
//
// Keyed on grain AND id for the reason everything else here is: the three report
// tables have independent id sequences, so a shared key would serve one tab
// another report's Pareto.
//
// Not gated on anything: Radix unmounts an inactive tab, so the query only fires
// when its tab is on screen — the same reasoning the shift versions state.
function periodReportRejectsQueryOptions(grain: PeriodGrain, id: number) {
  return queryOptions({
    queryKey: [`${grain}-report-rejects`, id] as const,
    queryFn: () => getPeriodReportRejects(grain, id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function usePeriodReportRejects(grain: PeriodGrain, id: number, enabled = true) {
  return useQuery({ ...periodReportRejectsQueryOptions(grain, id), enabled });
}

function periodReportDowntimeEventsQueryOptions(grain: PeriodGrain, id: number) {
  return queryOptions({
    queryKey: [`${grain}-report-downtime-events`, id] as const,
    queryFn: () => getPeriodReportDowntimeEvents(grain, id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function usePeriodReportDowntimeEvents(grain: PeriodGrain, id: number, enabled = true) {
  return useQuery({ ...periodReportDowntimeEventsQueryOptions(grain, id), enabled });
}

// The per-counter reject breakdown behind the Quality Loss tab.
//
// KEYED ON THE ID ALONE, like shiftReportProductsQueryOptions — everything the
// server needs is on the report row. That is also what removes this feature's
// version of reasonBreakdownParams's quietest failure: there is no params object
// for the route's loader and the card to build differently, so a prefetch cannot
// write an entry nobody reads.
//
// NO `enabled` GATE, unlike shiftReportPerformanceQueryOptions. Radix unmounts an
// inactive TabsContent, so this card mounts only when its tab is selected and
// exactly one breakdown is ever in flight — the same thing that makes
// ReasonParetoCard gate-free. The Losses route carries the matching per-tab gate
// on its prefetch.
//
// Flat staleTime, matching shiftReportProductsQueryOptions and for its stated
// reason: this payload carries no shift window, so closed-ness cannot be derived
// the way the timeline derives it, and reaching into the timeline query's cache
// for it would couple two independent queries.
function shiftReportRejectsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["shift-report-rejects", id] as const,
    queryFn: () => getShiftReportRejects(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

// `enabled` defaults to true, so the route loaders and every existing caller are
// untouched. It exists because the Pareto cards now serve three grains and React
// forbids calling a hook conditionally — both hooks are called, and the one whose
// grain is not in play is gated off. The card only ever reads the enabled one's
// state, so the "a gated query pends forever" trap cannot bite here.
function useShiftReportRejects(id: number, enabled = true) {
  return useQuery({ ...shiftReportRejectsQueryOptions(id), enabled });
}

// The per-reason downtime event count behind the Others tab.
//
// KEYED ON THE ID ALONE, like shiftReportRejectsQueryOptions — the same removal of
// reasonBreakdownParams's failure mode, and the same thing that makes the route
// loader's prefetch and the card's subscription provably one cache entry.
//
// NO `enabled` GATE. Radix unmounts an inactive TabsContent, so this card mounts
// only when its tab is selected and exactly one breakdown is ever in flight. Note
// what that buys beyond a saved request: a gated useQuery reports
// `status: "pending"` FOREVER (see lib/load-state.ts), and with the gate absent
// the card's `hasParams` can be a literal `true` rather than a condition that
// could go false.
//
// Flat staleTime, matching its siblings and for their stated reason: this payload
// carries no shift window, so closed-ness cannot be derived the way the timeline
// derives it. `Infinity` was considered and rejected even though the event log
// genuinely IS immutable — the Gold table ships empty, so the first weeks of this
// tab's life are exactly the period in which a cached empty answer has to be
// allowed to expire.
function shiftReportDowntimeEventsQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["shift-report-downtime-events", id] as const,
    queryFn: () => getShiftReportDowntimeEvents(id),
    staleTime: REFERENCE_STALE_TIME,
  });
}

function useShiftReportDowntimeEvents(id: number, enabled = true) {
  return useQuery({ ...shiftReportDowntimeEventsQueryOptions(id), enabled });
}

// How long a still-running shift's timeline may go unrefreshed. Short, because
// the strip is the only part of the page that changes while a shift is open.
const LIVE_SHIFT_STALE_TIME = 60 * 1000;

// A closed shift is immutable — once the window's `to` has passed, no downtime
// record for it can change again — so browsing report history costs one request
// per report and no more.
//
// `staleTime` is a function so the decision reads the window off the response
// itself. The browser deliberately has no shift-boundary table of its own (the
// times live in core-api's SHIFT_WINDOWS), so it cannot work out when a shift
// ended any other way.
// `enabled` is the gate, mirroring workCentersQueryOptions: a report whose date
// cannot be reduced to a business day has nothing to ask for, and firing the
// request anyway would only earn a 400.
function shiftTimelineQueryOptions(params: ShiftTimelineParams | undefined) {
  return queryOptions({
    queryKey: ["shift-timeline", params] as const,
    queryFn: () => getShiftTimeline(params as ShiftTimelineParams),
    enabled: params !== undefined,
    staleTime: (query) => {
      const to = query.state.data?.to;
      if (to === undefined) return LIVE_SHIFT_STALE_TIME;
      return new Date(to).getTime() <= Date.now() ? Infinity : LIVE_SHIFT_STALE_TIME;
    },
  });
}

function useShiftTimeline(params: ShiftTimelineParams | undefined) {
  return useQuery(shiftTimelineQueryOptions(params));
}

// The downtime list is keyed on paging and sorting as well as the shift, so
// every combination is its own cached page. `placeholderData` keeps the current
// page on screen while the next one loads, matching the By Shift table.
//
// The window's closed/open reasoning is the same as the timeline's, and for the
// same reason — these are the records that timeline was drawn from.
function downtimesQueryOptions(params: DowntimeListParams | undefined) {
  return queryOptions({
    queryKey: ["downtimes", params] as const,
    queryFn: () => getDowntimes(params as DowntimeListParams),
    enabled: params !== undefined,
    placeholderData: (previous) => previous,
  });
}

function useDowntimes(params: DowntimeListParams | undefined) {
  return useQuery(downtimesQueryOptions(params));
}

// The per-reason drill-down. Gated on a selector, so a route that has not
// resolved one yet issues no request — and the card's ladder reads `no-params`
// FIRST, because a gated query reports pending forever.
//
// Same window-aware staleTime as the breakdown above: once the shift's `to` is
// in the past the payload is immutable, so a closed shift is cached for the
// session. That matters more here than there — the Losses table has one eye
// button per reason, and without a durable cache a mouse travelling down that
// column would re-request every bucket it passed over.
function reasonDetailQueryOptions(params: ReasonDetailParams | undefined) {
  return queryOptions({
    queryKey: ["downtime-reason-detail", params] as const,
    queryFn: () => getReasonDetail(params as ReasonDetailParams),
    enabled: params !== undefined,
    staleTime: (query) => {
      const to = query.state.data?.detail.to;
      if (to === undefined) return LIVE_SHIFT_STALE_TIME;
      return new Date(to).getTime() <= Date.now() ? Infinity : LIVE_SHIFT_STALE_TIME;
    },
  });
}

function useReasonDetail(params: ReasonDetailParams | undefined) {
  return useQuery(reasonDetailQueryOptions(params));
}

// The Changes History panel. NOT window-aware: unlike every other payload on
// this screen, history is not a function of the shift window — an operator can
// edit a stop belonging to a shift that closed weeks ago, so a closed shift does
// not make this immutable. Plain LIVE_SHIFT_STALE_TIME, deliberately.
//
// Gated on `enabled` from the caller as well as on params, so the sheet only
// fetches once it is actually opened — the pattern performance-dialog.tsx uses.
function reasonHistoryQueryOptions(params: ReasonSelectorParams | undefined, enabled = true) {
  return queryOptions({
    queryKey: ["downtime-reason-history", params] as const,
    queryFn: () => getReasonHistory(params as ReasonSelectorParams),
    enabled: enabled && params !== undefined,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useReasonHistory(params: ReasonSelectorParams | undefined, enabled = true) {
  return useQuery(reasonHistoryQueryOptions(params, enabled));
}

// The per-reason aggregate behind a Losses tab's Pareto.
//
// `category` IS PART OF THE KEY, via `params`, and it has to be. The page renders
// Availability Loss and Schedule Loss from one card over two categories; keyed on
// the shift alone, both tabs would resolve to a single cache entry and the second
// one opened would render the first one's rows — a full, plausible, entirely
// wrong Pareto with nothing on screen to say so. Which is also why
// `ReasonBreakdownParams` makes `category` required even though the endpoint
// defaults it: an optional one lets a caller omit it and key two different
// questions the same way. Build the params with `reasonBreakdownParams` rather
// than by hand.
//
// `enabled` is the same gate the timeline uses: a report whose date cannot be
// reduced to a business day has nothing to ask for, and firing anyway would only
// earn a 400.
//
// The window-aware staleTime is copied from shiftTimelineQueryOptions for the
// same reason, and it carries extra weight here. The Losses card's expand icon
// is a <Link>, and the router preloads on intent — so merely HOVERING it on any
// report page runs that route's loader. A closed shift is immutable, so the
// second hover and every hover after it costs nothing; without this, browsing a
// list of reports would fire one aggregate per hover.
//
// No placeholderData: the whole result set arrives in one payload, and both the
// chart's measure toggle and the table's sort are client-side, so nothing
// re-requests.
function downtimeReasonsQueryOptions(params: ReasonBreakdownQuery | undefined) {
  return queryOptions({
    queryKey: ["downtime-reasons", params] as const,
    queryFn: () => getDowntimeReasons(params as ReasonBreakdownQuery),
    enabled: params !== undefined,
    staleTime: (query) => {
      const to = query.state.data?.to;
      if (to === undefined) return LIVE_SHIFT_STALE_TIME;
      return new Date(to).getTime() <= Date.now() ? Infinity : LIVE_SHIFT_STALE_TIME;
    },
  });
}

function useDowntimeReasons(params: ReasonBreakdownQuery | undefined) {
  return useQuery(downtimeReasonsQueryOptions(params));
}

// Derives the downtime request from a report at ANY grain. Shared by the detail
// route's prefetch and each card's own subscription so the two cannot key
// differently and fetch twice.
//
// RENAMED FROM shiftTimelineParams when the day and month screens arrived, and
// the old name was worth losing: it now feeds the timeline strip, the Downtime
// Details table AND the Losses Paretos, at three grains. A name asserting one
// screen and one grain is the kind of thing a reader trusts and should not.
//
// FOUR SUBJECTS, ONE COMPOSER. A machine report resolves to `scope: "work-unit"`,
// a line report to `scope: "work-center"`, an area report to `scope: "area"`, and
// a SKU report to `scope: "work-center"` PLUS a product predicate; core-api's
// SCOPE_COLUMN maps the three scopes, so the timeline, the Downtime Details table
// and the Availability Paretos serve all four with no API change at all beyond
// mapping `area_id` — a column migration 0007 added in August.
//
// A SECOND FUNCTION BESIDE THIS ONE WAS THE OBVIOUS MOVE AND IS THE WRONG ONE.
// The paragraph above exists because the loader and the card must key identically;
// a `lineWindowParams` sitting next to it is a second place for the scope half to
// drift, and the symptom — a skeleton flash on a page that had already fetched —
// is the quietest failure in this feature.
//
// The subject is read off the report's own TAG rather than passed in.
//
// IT USED TO BE READ OFF THE SHAPE — `"workUnitId" in report` — and that was the
// same latent bug the dispatch hooks above carried: sound while there are two
// subjects, silently wrong at three, because a SKU report has no `workUnitId`
// either and would have fallen into the `work-center` arm.
//
// A SKU IS SCOPE **PLUS A PREDICATE**, AND THAT IS THE WHOLE POINT OF ITS ARM.
// `scope: "work-center"` is not even wrong for a SKU — a SKU report IS scoped to
// one line — which is exactly what made the old shape-sniffing dangerous, and it
// is why this arm shipped once with the scope right and `productId` missing: the
// strip, the Downtime Details table and the Availability Paretos all drew the
// WHOLE LINE's day under a SKU heading, and nothing in the types could see it
// because the field is optional. A stop belongs to whichever SKU was running
// (migration 0020), and no scope can derive that.
//
// `productId` also lands IN THE CACHE KEY, since these params ARE the key — which
// is what stops a SKU's timeline colliding with its own line's day report on the
// same date, where whichever screen mounted second would render the other's stops.
//
// A SWITCH WITH NO `default`, per reportSubject's instruction: a FIFTH subject must
// be a build error here rather than a silent fall-through into "work-center". Adding
// the area one WAS that build error, which is the mechanism working.
//
// IT TAKES `WindowedReport`, NOT `AnyReport`, SINCE `0027`. The year payloads are
// deliberately NOT members of `AnyReport` — see lib/types.ts's YearReportDetail —
// so this widens its PARAMETER instead. Nothing inside changes: the switch is on
// SUBJECT and a year report carries one, and the `grain !== "shift"` branch below
// swallows `"year"` unchanged, which is what lets all three downtime Paretos and
// Pareto Actions serve a year screen with no new arithmetic anywhere.
function reportWindowParams(report: WindowedReport): ShiftTimelineParams | undefined {
  const subject: { scope: TimelineScope; scopeId: number; productId?: number } = (() => {
    switch (report.subject) {
      case "machine":
        return { scope: "work-unit" as const, scopeId: report.workUnitId };
      case "line":
        return { scope: "work-center" as const, scopeId: report.workCenterId };
      case "sku":
        return {
          scope: "work-center" as const,
          scopeId: report.workCenterId,
          productId: report.productId,
        };
      // AN AREA IS A SCOPE OF ITS OWN, which is what makes this arm one line where
      // the SKU's is four. oee.downtime_reports has carried `area_id` since
      // migration 0007 and core-api's SCOPE_COLUMN now maps it — CONTAINMENT, so a
      // stop on a machine IS a stop on its area and no predicate beside the scope
      // is involved. That is the whole contrast 0020's header draws with SKU, which
      // is OCCUPANCY OVER TIME and therefore needs `productId` as well.
      case "area":
        return { scope: "area" as const, scopeId: report.areaId };
    }
  })();

  if (report.grain !== "shift") {
    // NOTHING IS DERIVED HERE, and that is the point of migration 0013: the day
    // and month rows carry `business_date` as a real date, so the browser reads
    // it rather than reducing an instant through a zone. Undefined when the
    // pipeline has not written it — the same "cannot be looked up" state the
    // shift path reaches when the zone does not resolve, and the cards already
    // render a sentence for it.
    if (report.businessDate === null) return undefined;

    return {
      ...subject,
      grain: report.grain,
      date: report.businessDate,
      // Deliberately absent: core-api ignores a shift at these grains, and
      // sending one would put a value in the cache key that means nothing.
    };
  }

  // A LINE SHIFT NEEDS NO CONVERSION EITHER. Its row has `businessDate` and no
  // `date` column at all, so the instant-through-a-zone reduction below is
  // reached only by a machine report. Returned before it for exactly that reason.
  if (report.subject !== "machine") {
    return { ...subject, grain: "shift", date: report.businessDate, shift: String(report.shift) };
  }

  // `report.date` is the shift's start instant, so the business day only falls out
  // of it in the plant's zone — which is why the report carries `timeZone`.
  const date = toBusinessDay(report.date, report.timeZone);
  if (date === undefined) return undefined;

  // `report.shift` is a number (smallint upstream); /downtimes takes it as one of
  // the literal strings "1" | "2" | "3", because query params are strings and
  // core-api's SHIFT_WINDOWS is keyed by them. Converting here — rather than
  // retyping that contract — keeps the conversion to a single explicit spot.
  return { ...subject, grain: "shift", date, shift: String(report.shift) };
}

// The breakdown request for one report and one loss tab.
//
// ONE COMPOSER, because the Losses page's loader prefetches and the card
// subscribes, and they must key identically. If the two ever drift — the loader
// forgetting `category`, say — the prefetch writes an entry nobody reads and the
// card fires a second request, and the only symptom is a skeleton flash on a page
// that had already fetched. That is the quietest failure in this whole feature,
// so neither side is allowed to build the object by hand.
function reasonBreakdownParams(
  report: WindowedReport,
  category: DowntimeCategory,
): ReasonBreakdownParams | undefined {
  const shift = reportWindowParams(report);
  return shift === undefined ? undefined : { ...shift, category };
}

// The measure the Pareto opens on, and the one its loader prefetches.
//
// A CONSTANT SHARED BY BOTH SIDES rather than a literal written twice. The card's
// initial toggle state and the loader's prefetch have to agree or the first paint
// misses the cache and refetches — the same skeleton-flash failure the composer
// above exists to prevent, one parameter over. It also matches the endpoint's own
// default, so the prefetched URL is the plain one.
const DEFAULT_REASON_MEASURE: ReasonMeasure = "duration";

// The breakdown request WITH its ranking measure — which is what actually gets
// fetched and cached.
//
// SEPARATE FROM reasonBreakdownParams above, because the drill-down and the
// history build on that one and neither ranks anything: a `measure` on the shared
// object would be sent to endpoints that no longer accept it.
//
// THE MEASURE IS IN THE KEY, and it has to be. The response is the top N by this
// measure, so the top ten by duration and the top ten by frequency are different
// ten buckets — one cache entry serving both would show whichever was fetched
// first, re-ranked, which is a chart of the wrong bars under a plausible line.
function reasonBreakdownQuery(
  params: ReasonBreakdownParams | undefined,
  measure: ReasonMeasure = DEFAULT_REASON_MEASURE,
): ReasonBreakdownQuery | undefined {
  return params === undefined ? undefined : { ...params, measure };
}

// Pareto Actions, on the OEE Performance dashboard.
//
// SAME staleTime CLOSURE as the reason breakdown's, and for its reason: once the
// window has passed the payload is immutable, so it caches forever.
//
// THE MEASURE IS IN THE KEY, exactly as it is for /by-reason: the response is the
// top N BY that measure, so the top twenty by duration are a different twenty from
// the top twenty by frequency, and one cache entry serving both would draw the
// wrong bars under a plausible cumulative line.
function downtimeActionsQueryOptions(params: ActionBreakdownQuery | undefined) {
  return queryOptions({
    queryKey: ["downtime-actions", params] as const,
    queryFn: () => getDowntimeActions(params as ActionBreakdownQuery),
    enabled: params !== undefined,
    staleTime: (query) => {
      const to = query.state.data?.to;
      if (to === undefined) return LIVE_SHIFT_STALE_TIME;
      return new Date(to).getTime() <= Date.now() ? Infinity : LIVE_SHIFT_STALE_TIME;
    },
  });
}

function useDowntimeActions(params: ActionBreakdownQuery | undefined) {
  return useQuery(downtimeActionsQueryOptions(params));
}

// The action breakdown's request, from a report at any grain — the twin of
// reasonBreakdownQuery, minus the category the endpoint does not take.
function actionBreakdownQuery(
  report: WindowedReport | undefined,
  measure: ReasonMeasure = DEFAULT_REASON_MEASURE,
): ActionBreakdownQuery | undefined {
  if (report === undefined) return undefined;
  const window = reportWindowParams(report);

  return window === undefined ? undefined : { ...window, measure };
}

// The key for the report's audit trail, exported so mutations.ts can invalidate
// it without hand-writing the string — the same reason meKey and areasKey are.
const shiftReportActivityKey = (id: number) => ["shift-report-activity", id] as const;

// The report's audit trail, behind the "…" menu's Log Activity item.
//
// `enabled: isOpen` for the reason shiftReportPerformanceQueryOptions has it: an
// opt-in panel most visits never open should cost nothing. Note the KEY does not
// contain `isOpen`, so the approve mutation can invalidate one entry whether or
// not the sheet happens to be mounted.
//
// THE CONSEQUENCE THE SHEET HAS TO KNOW: a gated useQuery reports
// `status: "pending"` FOREVER, so its state ladder must read `open` before
// `isPending` or it renders skeletons for a panel nobody opened.
//
// LIVE_SHIFT_STALE_TIME, NOT REFERENCE_STALE_TIME, and not window-aware either.
// Every other payload on this screen is a function of the shift, so a closed
// shift makes it immutable. This one is not: an approval — or a downtime edit —
// can land against a shift that closed weeks ago. It is also the ONLY payload
// here that this app can change itself, which is the same argument
// reasonHistoryQueryOptions makes for its own flat stale time.
function shiftReportActivityQueryOptions(id: number, isOpen: boolean) {
  return queryOptions({
    queryKey: shiftReportActivityKey(id),
    queryFn: () => getShiftReportActivity(id),
    enabled: isOpen,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useShiftReportActivity(id: number, isOpen: boolean) {
  return useQuery(shiftReportActivityQueryOptions(id, isOpen));
}

// The same feed at day or month grain.
//
// Its own key prefix per grain, for the reason every other period query has one:
// the three report tables have independent id sequences, so a shared key would
// serve one sheet another report's history.
//
// LIVE_SHIFT_STALE_TIME here too. The argument is if anything stronger at these
// grains: a day's feed changes whenever ANY of its three child shift reports is
// approved, so it goes stale from three directions rather than one.
const periodReportActivityKey = (grain: PeriodGrain, id: number) =>
  [`${grain}-report-activity`, id] as const;

function periodReportActivityQueryOptions(grain: PeriodGrain, id: number, isOpen: boolean) {
  return queryOptions({
    queryKey: periodReportActivityKey(grain, id),
    queryFn: () => getPeriodReportActivity(grain, id),
    enabled: isOpen,
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function usePeriodReportActivity(grain: PeriodGrain, id: number, isOpen: boolean) {
  return useQuery(periodReportActivityQueryOptions(grain, id, isOpen));
}

// The key for the stale-metrics signal, exported so mutations.ts can invalidate
// it — a category edit is exactly what changes the answer.
const metricsStalenessKey = (id: number) => ["metrics-staleness", id] as const;

// When a stop in this shift last had its CATEGORY edited, which is what the
// banner above the report renders.
//
// NOT GATED, unlike the activity feed beside it, and prefetched WITHOUT being
// awaited in the detail route's loader — the pattern shiftTimelineQueryOptions
// already uses. The reasoning is the whole reason this is its own endpoint: the
// loader awaits the report, so folding this into that payload would put a scan of
// the shift's downtime rows on the blocking path of every page view. Off the
// critical path, the banner simply appears a beat later, and it renders NOTHING
// while pending rather than a skeleton so the page does not jump.
//
// LIVE_SHIFT_STALE_TIME and deliberately not window-aware, for the reason
// reasonHistoryQueryOptions gives: an operator can edit a stop belonging to a
// shift that closed weeks ago, so a closed shift does not make this immutable.
// It is also, like the activity feed, one of the only payloads on this screen
// that this app can change itself.
function metricsStalenessQueryOptions(id: number) {
  return queryOptions({
    queryKey: metricsStalenessKey(id),
    queryFn: () => getMetricsStaleness(id),
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

function useMetricsStaleness(id: number) {
  return useQuery(metricsStalenessQueryOptions(id));
}

// THE SAME BANNER AT THE OTHER FIVE REPORT ADDRESSES (TODOS §50).
//
// One key per subject AND grain, on the rule this file states at length: six
// report tables, seven independent id sequences. `["metrics-staleness", 7]` shared
// between them would let a day screen render the shift report 7's answer — and
// because the answer is usually `null`, the symptom is a banner that fails to
// appear, which nobody notices.
const periodMetricsStalenessKey = (grain: PeriodGrain, id: number) =>
  [`${grain}-metrics-staleness`, id] as const;

function periodMetricsStalenessQueryOptions(grain: PeriodGrain, id: number) {
  return queryOptions({
    queryKey: periodMetricsStalenessKey(grain, id),
    queryFn: () => getPeriodMetricsStaleness(grain, id),
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

const lineMetricsStalenessKey = (id: number) =>
  ["work-center-shift-metrics-staleness", id] as const;

function lineMetricsStalenessQueryOptions(id: number) {
  return queryOptions({
    queryKey: lineMetricsStalenessKey(id),
    queryFn: () => getLineMetricsStaleness(id),
    staleTime: LIVE_SHIFT_STALE_TIME,
  });
}

export {
  areaActivityKey,
  areaActivityQueryOptions,
  areaDowntimeEventsQueryOptions,
  areaProductionUnitsQueryOptions,
  areaProductsQueryOptions,
  areaRejectsQueryOptions,
  areaReportQueryOptions,
  areaReportsQueryOptions,
  skuDowntimeEventsQueryOptions,
  skuRejectsQueryOptions,
  skuReportQueryOptions,
  skuReportsQueryOptions,
  useSkuDowntimeEvents,
  useSkuRejects,
  useSkuReport,
  useSkuReports,
  areasKey,
  lineMetricsStalenessKey,
  lineMetricsStalenessQueryOptions,
  metricsStalenessKey,
  periodMetricsStalenessKey,
  periodMetricsStalenessQueryOptions,
  metricsStalenessQueryOptions,
  areasQueryOptions,
  downtimeActionOptionsKey,
  downtimeActionOptionsQueryOptions,
  downtimeReasonOptionsQueryOptions,
  DEFAULT_REASON_MEASURE,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  downtimeReasonsQueryOptions,
  downtimesQueryOptions,
  reasonDetailQueryOptions,
  reasonHistoryQueryOptions,
  useReasonDetail,
  useReasonHistory,
  useDowntimeReasons,
  useDowntimes,
  meKey,
  meQueryOptions,
  shiftReportActivityKey,
  shiftReportActivityQueryOptions,
  shiftReportDowntimeEventsQueryOptions,
  shiftReportPerformanceQueryOptions,
  shiftReportProductsQueryOptions,
  shiftReportRejectsQueryOptions,
  monthReportHourProfileQueryOptions,
  periodReportActivityKey,
  periodReportActivityQueryOptions,
  periodReportDowntimeEventsQueryOptions,
  periodReportPerformanceQueryOptions,
  periodReportRejectsQueryOptions,
  periodReportProductsQueryOptions,
  periodReportQueryOptions,
  lineActivityKey,
  lineDowntimeEventsQueryOptions,
  lineMachinesQueryOptions,
  lineProductsQueryOptions,
  lineRejectsQueryOptions,
  useLineDowntimeEvents,
  useReportApproved,
  useReportDowntimeEvents,
  useReportProducts,
  useReportRejects,
  useLineMachines,
  useLineProducts,
  useLineRejects,
  lineActivityQueryOptions,
  lineApprovalKey,
  lineApprovalQueryOptions,
  lineReportQueryOptions,
  lineReportsQueryOptions,
  useLineActivity,
  useLineApproval,
  useLineReport,
  periodReportsQueryOptions,
  shiftReportQueryOptions,
  shiftReportsQueryOptions,
  reportWindowParams,
  shiftTimelineQueryOptions,
  useAreaActivity,
  useAreaDowntimeEvents,
  useAreaProductionUnits,
  useAreaProducts,
  useAreaRejects,
  useAreaReport,
  useAreaReports,
  useAreas,
  useLineReports,
  useMe,
  usePeriodReport,
  useMonthReportHourProfile,
  usePeriodReportActivity,
  usePeriodReportDowntimeEvents,
  usePeriodReportPerformance,
  usePeriodReportRejects,
  usePeriodReportProducts,
  usePeriodReports,
  useShiftReport,
  useMetricsStaleness,
  useShiftReportActivity,
  useShiftReportDowntimeEvents,
  useShiftReportPerformance,
  useShiftReportProducts,
  useShiftReportRejects,
  useShiftReports,
  useShiftTimeline,
  useWorkCenters,
  useWorkUnits,
  useMachineMonthOeeTrend,
  useMachineYearOeeTrend,
  useLineYearOeeTrend,
  useAreaYearOeeTrend,
  useMachineYearReports,
  useLineYearReports,
  useAreaYearReports,
  useMachineYearReport,
  useLineYearReport,
  useAreaYearReport,
  useMachineYearRejects,
  useLineYearRejects,
  useAreaYearRejects,
  useLineMonthOeeTrend,
  useAreaMonthOeeTrend,
  useDowntimeActions,
  actionBreakdownQuery,
  useDowntimeActionOptions,
  useDowntimeReasonOptions,
  useLineHourProfile,
  useLinePerformance,
  useLineProductOptions,
  useProductDetail,
  useQualityEntries,
  useRejectReasonOptions,
  qualityEntriesKey,
  qualityEntriesPrefix,
  skuActivityKey,
  skuActivityQueryOptions,
  useSkuActivity,
  useSkuMachines,
  qualityEntriesQueryOptions,
  workCentersQueryOptions,
  workUnitsQueryOptions,
  machineMonthOeeTrendQueryOptions,
  machineYearOeeTrendQueryOptions,
  lineYearOeeTrendQueryOptions,
  areaYearOeeTrendQueryOptions,
  lineMonthOeeTrendQueryOptions,
  areaMonthOeeTrendQueryOptions,
  downtimeActionsQueryOptions,
};
