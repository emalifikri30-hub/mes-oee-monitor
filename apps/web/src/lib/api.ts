import { isAxiosError } from "axios";

import { http } from "@/lib/http";

import type {
  AreaSummary,
  CreateDowntimeActionInput,
  DowntimeActionOption,
  DowntimeCategory,
  DowntimeEditResult,
  DowntimeEventReasonBreakdown,
  DowntimeListItem,
  DowntimeReasonBreakdown,
  DowntimeReasonOption,
  DowntimeSortBy,
  DowntimeSortDir,
  EditDowntimePayload,
  HourOfDayProfile,
  LineActivity,
  LineApprovalSummary,
  LineGrain,
  LineMachineList,
  LinePerformance,
  LineReportDetail,
  LineReportListItem,
  Me,
  MetricsStaleness,
  PageMeta,
  PeriodReportDetail,
  PeriodReportListItem,
  ProductDetail,
  QualityEntry,
  QualityEntryDraft,
  QualityEntryList,
  ReasonDetail,
  ReasonHistory,
  ReasonMeasure,
  RejectReasonBreakdown,
  RejectReasonOption,
  ShiftActivity,
  ShiftPerformance,
  ShiftProductCounts,
  ShiftReportApproval,
  ShiftReportDetail,
  ShiftReportListItem,
  ShiftTimeline,
  WebResponse,
  WorkCenterSummary,
  WorkUnitSummary,
  MonthOeeTrend,
  MachineYearReportDetail,
  MachineYearReportListItem,
  LineYearReportDetail,
  LineYearReportListItem,
  AreaYearReportDetail,
  AreaYearReportListItem,
  DowntimeActionBreakdown,
  AreaActivity,
  AreaGrain,
  AreaProductCounts,
  AreaProductionUnits,
  AreaReportDetail,
  AreaReportListItem,
  SkuActivity,
  SkuDowntimeEventBreakdown,
  SkuMachineRoster,
  SkuReportDetail,
  SkuReportListItem,
} from "@/lib/types";
import type { QualityAddress } from "@/lib/report-subject";

// core-api resources are reached through the BFF proxy, which prefixes them with
// /api/proxy and swaps the session cookie for a bearer token. New resource calls
// belong on this prefix rather than hitting core-api directly — the browser has
// no token to present, and core-api's CORS only admits the BFF.
//
// Note the prefix must also be allow-listed in the BFF's PROXY_ALLOWED_PREFIXES.
const PROXY_PREFIX = "/api/proxy/api/v1";

const SHIFT_REPORTS = `${PROXY_PREFIX}/work-units/shift-reports`;
// The coarse grains. Separate paths rather than one with a `grain` param,
// mirroring core-api — a URL in a network tab should say what it returned.
const PERIOD_REPORTS = {
  day: `${PROXY_PREFIX}/work-units/day-reports`,
  month: `${PROXY_PREFIX}/work-units/month-reports`,
} as const;
// The LINE grains. Three separate paths rather than one with a `grain` param,
// mirroring core-api and the work-unit pair above — a URL in a network tab should
// say what it returned.
//
// `/work-centers`, beside `/master-data/work-centers` rather than under it: that
// is the upstream catalogue, this is Gold's reports about the lines in it.
const WORK_CENTER_REPORTS = {
  shift: `${PROXY_PREFIX}/work-centers/shift-reports`,
  day: `${PROXY_PREFIX}/work-centers/day-reports`,
  month: `${PROXY_PREFIX}/work-centers/month-reports`,
} as const;
// The SKU grain. Beside the other two subjects, and NOT the same thing as
// `${MASTER_DATA}/products`: that is the SKU CATALOGUE (what a line is set up to
// run), this is a MEASUREMENT of what it did run — the distinction
// `/master-data/work-centers` and `/work-centers` already keep one subject over.
//
// New prefixes must also be allow-listed in the BFF's PROXY_ALLOWED_PREFIXES, or
// every call 404s at the proxy with nothing in the browser to say why.
const SKU_REPORTS = `${PROXY_PREFIX}/products/day-reports`;
// The AREA grains. Beside the other three subjects, and NOT the same thing as
// `${MASTER_DATA}/areas`: that is the area CATALOGUE (which areas exist — it backs
// the header picker), this is a MEASUREMENT of what they did. Same distinction one
// level down.
//
// TWO SEPARATE PATHS rather than one with a `grain` param, mirroring core-api and
// the two pairs above — a URL in a network tab should say what it returned. The day
// grain shipped first as a single constant with a note that the month would be "a
// second constant beside this one rather than a parameter"; this is that, as a map,
// because six fetchers now index it.
//
// TWO PATHS AND NOT THREE. There is no shift grain on this subject and there will
// not be one, so `AreaGrain` is a two-member union and this map cannot be indexed
// with anything else.
const AREA_REPORTS = {
  day: `${PROXY_PREFIX}/areas/day-reports`,
  month: `${PROXY_PREFIX}/areas/month-reports`,
} as const satisfies Record<AreaGrain, string>;
// THE YEAR GRAIN — three BARE constants, never a fourth member of the three maps
// above.
//
// `PERIOD_REPORTS`, `WORK_CENTER_REPORTS` and `AREA_REPORTS` are indexed by grain
// unions that gate shipped routes: an `AreaGrain` admitting "year" would make
// `/report/area/by-monthly` compile with a year grain and `useAreaProducts("year",
// id)` compile and 404. Bare constants, like SKU_REPORTS, mean no index expression
// exists that could take a variable. getMachineMonthOeeTrend's header states the
// same rule one level down.
const WORK_UNIT_YEAR_REPORTS = `${PROXY_PREFIX}/work-units/year-reports`;
const WORK_CENTER_YEAR_REPORTS = `${PROXY_PREFIX}/work-centers/year-reports`;
const AREA_YEAR_REPORTS = `${PROXY_PREFIX}/areas/year-reports`;
const MASTER_DATA = `${PROXY_PREFIX}/master-data`;
// Not nested under work-units: a downtime belongs to a work unit, a work center,
// an area or the factory, so the resource is scoped by query param instead.
const DOWNTIMES = `${PROXY_PREFIX}/downtimes`;

// Returns the current user, or null when not authenticated.
async function getMe(): Promise<Me | null> {
  try {
    const { data } = await http.get<WebResponse<Me>>("/api/me", { authProbe: true });
    return data.data;
  } catch (err) {
    if (isAxiosError(err) && (err.response?.status === 401 || err.response?.status === 403)) {
      return null;
    }
    throw err;
  }
}

// Full-page navigations: the BFF responds with redirects (to the IdP / back to
// the app), so these must not go through axios — and must never become router
// <Link>s or navigate() calls either, since a client-side navigation cannot
// follow a cross-origin 302.
function login(returnTo = "/"): void {
  globalThis.location.href = `/api/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function logout(): void {
  globalThis.location.href = "/api/logout";
}

type ShiftReportListParams = {
  page: number;
  size: number;
  month?: number;
  year?: number;
  shift?: string;
  workCenterId?: number;
  // THE HEADER PICKER'S SELECTION, AND IT IS A REQUEST FILTER ON EVERY LIST NOW.
  //
  // It used to decide only which LINES a page could OFFER — hooks/use-work-center-filter.ts
  // said so in as many words, and the AREA lists were the sole exception because
  // there the area IS the subject. The requirement changed that: every report
  // screen opens filtered to the area selected in the header, so this is sent on
  // every list request and `area_id` is a column on every report table as of
  // migration 0028.
  //
  // OPTIONAL, because the picker is undefined until the area list resolves.
  // Sending nothing means EVERY area, which is a page rather than a 400 — so the
  // first paint shows data and narrows a tick later. It must never be sent as an
  // empty string either; `stripUndefined` and axios both drop the key.
  areaId?: number;
  hideZero: boolean;
  // Approval state, filtered SERVER-SIDE. Absent means both.
  //
  // Undefined rather than a third "all" literal: `stripUndefined` below drops it,
  // and core-api reads an absent param as "no predicate". A sentinel value would
  // have to be translated back to absence on both sides.
  status?: "open" | "closed";
};

// One page of the By Shift report. `meta` carries the paging totals; it is
// optional on the envelope, so callers must tolerate its absence.
async function getShiftReports(
  params: ShiftReportListParams,
): Promise<{ items: ShiftReportListItem[]; meta: PageMeta | undefined }> {
  const { hideZero, ...rest } = params;
  const query: Record<string, string | number> = { ...stripUndefined(rest) };

  // core-api only treats the literal string "true" as "hide zero-OEE rows";
  // sending "false" would be indistinguishable from sending nothing, so omit it.
  if (hideZero) query.isHideZero = "true";

  const { data } = await http.get<WebResponse<ShiftReportListItem[]>>(SHIFT_REPORTS, {
    params: query,
  });
  return { items: data.data ?? [], meta: data.meta };
}

// DISTRIBUTIVE Omit, and the distribution is the entire point.
//
// A bare `Omit<LineReportDetail, "subject">` COLLAPSES the union: LineReportDetail
// is `LineShiftReportDetail | LinePeriodReportDetail`, and Omit over a union
// produces one object whose `grain` is `"shift" | "day" | "month"` and whose
// `shift` is `number | null` — the two arms merged, so the discriminant no longer
// discriminates and the result stops being assignable back. The `T extends unknown`
// makes it distribute over each member first, preserving the pairing between
// `grain` and `shift` that LineReportDetail exists to express.
type WithoutSubject<T> = T extends unknown ? Omit<T, "subject"> : never;

// One shift report in full. The envelope types `data` as nullable, so a null
// here would otherwise surface as a crash on the first field access downstream.
//
// `grain` IS STAMPED HERE, not sent by the server. It is the discriminant of the
// ReportDetail union, and this function is the one place that knows for certain
// which endpoint answered — the day and month endpoints send their own, because
// they were built after the union existed and one of them has to read a table
// name off a route. Adding it to the shift response would have changed a shipped
// contract to tell the browser something it already knew.
async function getShiftReport(id: number): Promise<ShiftReportDetail> {
  const { data } = await http.get<WebResponse<Omit<ShiftReportDetail, "grain" | "subject">>>(
    `${SHIFT_REPORTS}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, grain: "shift", subject: "machine" };
}

// One page of By Day or By Monthly.
//
// No `shift` and no `status`, unlike its shift sibling, and both absences are
// the server's contract rather than an oversight: there is no shift at these
// grains and no day or month sign-off to filter on. Sending either would be
// ignored, which is worse than not offering it.
async function getPeriodReports(
  grain: PeriodGrain,
  params: PeriodReportListParams,
): Promise<{ items: PeriodReportListItem[]; meta: PageMeta | undefined }> {
  const { hideZero, ...rest } = params;
  const query: Record<string, string | number> = { ...stripUndefined(rest) };

  // Same rule as the shift list: only the literal "true" hides zero-OEE rows,
  // and "false" would be indistinguishable from sending nothing.
  if (hideZero) query.isHideZero = "true";

  const { data } = await http.get<WebResponse<PeriodReportListItem[]>>(PERIOD_REPORTS[grain], {
    params: query,
  });
  return { items: data.data ?? [], meta: data.meta };
}

type LineReportListParams = {
  page: number;
  size: number;
  month?: number;
  year?: number;
  // SHIFT GRAIN ONLY, and getLineReports enforces that rather than trusting it.
  // Not modelled as a union because this object is also the react-query cache key,
  // and a union key is one more shape that has to stay stable.
  shift?: string;
  workCenterId?: number;
  // The header picker, as on every other list — see ShiftReportListParams.areaId.
  areaId?: number;
  hideZero: boolean;
};

// One page of a Line report at any of the three grains.
//
// No `status` at ANY grain, unlike the machine shift list: there is no line
// approval to filter on. Sending it would be ignored, which is worse than not
// offering it.
async function getLineReports(
  grain: LineGrain,
  params: LineReportListParams,
): Promise<{ items: LineReportListItem[]; meta: PageMeta | undefined }> {
  const { hideZero, shift, ...rest } = params;
  const query: Record<string, string | number> = { ...stripUndefined(rest) };

  // The two coarse endpoints have no shift predicate — core-api's schema drops
  // the key rather than rejecting it, so sending one would answer a filtered
  // request with an unfiltered page. Dropped here as well, and not merely left
  // undefined: a stray `shift: undefined` in the params object is a SECOND cache
  // key for an identical server page, which shows up only as a double fetch.
  if (grain === "shift" && shift !== undefined) query.shift = shift;

  // Same translation as the two work-unit lists: core-api treats only the literal
  // "true" as "hide zero-OEE rows", and "false" is indistinguishable from absence.
  if (hideZero) query.isHideZero = "true";

  const { data } = await http.get<WebResponse<LineReportListItem[]>>(WORK_CENTER_REPORTS[grain], {
    params: query,
  });
  return { items: data.data ?? [], meta: data.meta };
}

// One day or month report in full. `grain` arrives ON the payload here, unlike
// the shift endpoint — see getShiftReport for why that one is stamped instead.
async function getPeriodReport(grain: PeriodGrain, id: number): Promise<PeriodReportDetail> {
  const { data } = await http.get<WebResponse<Omit<PeriodReportDetail, "subject">>>(
    `${PERIOD_REPORTS[grain]}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "machine" };
}

// ONE LINE REPORT, AT ANY OF THE THREE GRAINS.
//
// GRAIN *AND* SUBJECT PICK THE PATH, and both halves are load-bearing. There are
// seven report tables with seven INDEPENDENT identity sequences — three work_unit_*
// and three work_center_* — so an id is meaningful only against the one table it
// came from. Calling getShiftReport with a line report's id has two outcomes and
// the quiet one is the dangerous half: a 404, or a MACHINE's report for another
// date rendered without a warning.
//
// No `grain` stamp on the way out, unlike getShiftReport: all three of these
// endpoints postdate the field and send it themselves.
//
// `subject` IS stamped, here and on every sibling fetcher, and that asymmetry with
// `grain` is deliberate. A grain is a fact about the row; a SUBJECT is a fact about
// WHICH ENDPOINT ANSWERED, which is knowledge this function has and the row does
// not. Stamping it here means no shipped response shape changed to tell the browser
// something it already knew — the argument getShiftReport makes about `grain`,
// applied to all six endpoints at once.
async function getLineReport(grain: LineGrain, id: number): Promise<LineReportDetail> {
  const { data } = await http.get<WebResponse<WithoutSubject<LineReportDetail>>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "line" };
}

// The Status tile's counts. SHIFT GRAIN ONLY — there is no day or month line
// approval, for the same reason there is no machine one.
//
// A separate request from the report itself, and the route loader prefetches it
// WITHOUT awaiting: answering it means two COUNT queries over the line's machine
// reports and their approvals, and folding that into the report payload would put
// the scan on the awaited path of every page view.
async function getLineApproval(id: number): Promise<LineApprovalSummary> {
  const { data } = await http.get<WebResponse<LineApprovalSummary>>(
    `${WORK_CENTER_REPORTS.shift}/${id}/approval`,
  );
  if (!data.data) throw new Error(data.error ?? "approval summary not found");
  return data.data;
}

// The Log Activity feed, AT ANY OF THE THREE LINE GRAINS.
//
// `grain` IS NOT COSMETIC HERE, and it was hardcoded to `shift` until TODOS §60
// was answered. The three work_center_* tables have INDEPENDENT identity
// sequences, so a day report's id sent to the shift path resolves against a real
// line SHIFT report about another period — a populated, plausible panel with
// nothing on screen to say so. The grain is in the URL for exactly that reason,
// and `queries.ts` puts it in the cache key for the same one.
async function getLineActivity(grain: LineGrain, id: number): Promise<LineActivity> {
  const { data } = await http.get<WebResponse<LineActivity>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}/activity`,
  );
  if (!data.data) throw new Error(data.error ?? "activity not found");
  return data.data;
}

// SKU View's rows, at line grain.
//
// SAME ENVELOPE as the machine version, so sku-view-card.tsx renders both through
// one component and `skuTiles` needs no change: the per-SKU row shape is identical
// (shared/product-count.ts on the server), and `loadedThrough` carries the same
// meaning. It will be EMPTY until Airflow fills the 0016 tables, which is exactly
// why the empty-state ladder matters more here than on the machine card.
async function getLineProducts(grain: LineGrain, id: number): Promise<ShiftProductCounts> {
  const { data } = await http.get<WebResponse<ShiftProductCounts>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}/products`,
  );
  if (!data.data) throw new Error(data.error ?? "product counts not found");
  return data.data;
}

// ---------------------------------------------------------------------------
// Part 3 — the quality-entry ledger and its three catalogues
// ---------------------------------------------------------------------------

// Reject reasons for one line. SERVES BOTH the Reject and the Rework picker —
// the requirement is explicit that a rework reason is a reject reason.
async function getRejectReasonOptions(workCenterId: number): Promise<RejectReasonOption[]> {
  const { data } = await http.get<WebResponse<RejectReasonOption[]>>(
    `${MASTER_DATA}/reject-reasons`,
    { params: { workCenterId } },
  );
  return data.data ?? [];
}

// The SKUs a line is set up to run — a catalogue, not a measurement. See the
// handler for why this is not SKU View's source.
async function getLineProductOptions(workCenterId: number): Promise<AreaSummary[]> {
  const { data } = await http.get<WebResponse<AreaSummary[]>>(`${MASTER_DATA}/products`, {
    params: { workCenterId },
  });
  return data.data ?? [];
}

// One product WITH its packages — the unit picker's options and their conversion
// factors. Fetched on SKU selection rather than up front: it is one call per
// choice, and pre-fetching every product's packages for a line would be dozens.
async function getProductDetail(productId: number): Promise<ProductDetail> {
  const { data } = await http.get<WebResponse<ProductDetail>>(
    `${MASTER_DATA}/products/${productId}`,
  );
  if (!data.data) throw new Error(data.error ?? "product not found");
  return data.data;
}

// The ledger for a report's window. `includeVoided` is the sheet's read; the
// card's ledger line uses the default, which is live only.
// WHERE A QUALITY ENTRY'S ROUTES LIVE, per subject.
//
// ONE BUILDER RATHER THAN AN INTERPOLATION AT EACH OF THE THREE CALL SITES, and
// the type is why: `QualityAddress` admits only a line or a SKU, so a SKU id can
// only ever reach a /products path and a machine address cannot be passed at all.
// The three functions below took `(grain, id)` before this existed, which let a
// SKU report's id be interpolated into /work-centers/day-reports — a table with an
// independent identity sequence, answering with another line's ledger.
function qualityEntriesBase(address: QualityAddress): string {
  return address.subject === "sku"
    ? `${SKU_REPORTS}/${String(address.id)}`
    : `${WORK_CENTER_REPORTS[address.grain]}/${String(address.id)}`;
}

async function getQualityEntries(
  address: QualityAddress,
  includeVoided = false,
): Promise<QualityEntryList> {
  const { data } = await http.get<WebResponse<QualityEntryList>>(
    `${qualityEntriesBase(address)}/quality-entries`,
    { params: includeVoided ? { includeVoided: "true" } : undefined },
  );
  if (!data.data) throw new Error(data.error ?? "quality entries not found");
  return data.data;
}

// RETURNS THE ROW, and the caller needs it rather than an id: the converted
// quantity is computed by the database from factors the server resolved, so this
// response is the only place the browser can learn what the operator's 10 cartons
// actually became.
async function createQualityEntry(
  address: QualityAddress,
  draft: QualityEntryDraft,
): Promise<QualityEntry> {
  const { data } = await http.post<WebResponse<QualityEntry>>(
    `${qualityEntriesBase(address)}/quality-entries`,
    draft,
  );
  if (!data.data) throw new Error(data.error ?? "the entry could not be recorded");
  return data.data;
}

// A POST, not a DELETE: nothing is deleted — the table's trigger refuses that
// outright — and a void carries a reason, which a DELETE has nowhere to put.
async function voidQualityEntry(
  address: QualityAddress,
  entryId: number,
  reason?: string,
): Promise<QualityEntry> {
  const { data } = await http.post<WebResponse<QualityEntry>>(
    `${qualityEntriesBase(address)}/quality-entries/${String(entryId)}/void`,
    { reason },
  );
  if (!data.data) throw new Error(data.error ?? "the entry could not be voided");
  return data.data;
}

// The line's hourly production. TWO PATHS, matching /work-units: a shift or day
// returns buckets keyed on an INSTANT, a month returns 24 hour-of-day buckets
// keyed on a clock hour that occurred ~30 times. The payloads genuinely differ.
async function getLinePerformance(grain: "shift" | "day", id: number): Promise<LinePerformance> {
  const { data } = await http.get<WebResponse<LinePerformance>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}/performance`,
  );
  if (!data.data) throw new Error(data.error ?? "hourly production not found");
  return data.data;
}

async function getLineHourProfile(id: number): Promise<LinePerformance> {
  const { data } = await http.get<WebResponse<LinePerformance>>(
    `${WORK_CENTER_REPORTS.month}/${id}/hour-profile`,
  );
  if (!data.data) throw new Error(data.error ?? "hour profile not found");
  return data.data;
}

// Machine View's rows.
async function getLineMachines(grain: LineGrain, id: number): Promise<LineMachineList> {
  const { data } = await http.get<WebResponse<LineMachineList>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}/machines`,
  );
  if (!data.data) throw new Error(data.error ?? "machines not found");
  return data.data;
}

// The Losses page's Quality Loss tab, at line grain. Same payload shape as the
// machine version — the aggregate is shared server-side — so quality-pareto-card
// needs no second model.
async function getLineRejects(grain: LineGrain, id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "reject breakdown not found");
  return data.data;
}

// The Losses page's Others tab, on the same terms.
async function getLineDowntimeEvents(
  grain: LineGrain,
  id: number,
): Promise<DowntimeEventReasonBreakdown> {
  const { data } = await http.get<WebResponse<DowntimeEventReasonBreakdown>>(
    `${WORK_CENTER_REPORTS[grain]}/${id}/downtime-events`,
  );
  if (!data.data) throw new Error(data.error ?? "downtime event breakdown not found");
  return data.data;
}

// APPROVING A LINE APPROVES ITS MACHINES. The server closes every machine shift
// report on the line for this business date and shift, and answers with the
// resulting counts — there is no line approval row to return, because approvals
// are keyed (work_unit_id, date, shift).
//
// A DIFFERENT FUNCTION FROM approveShiftReport, not a parameterised one. The two
// take an id from a different sequence and hit a different path, and the failure
// mode of confusing them is that a Line screen signs off an unrelated MACHINE
// report and reports success.
async function approveLineReport(id: number): Promise<LineApprovalSummary> {
  const { data } = await http.post<WebResponse<LineApprovalSummary>>(
    `${WORK_CENTER_REPORTS.shift}/${id}/approve`,
  );
  if (!data.data) throw new Error(data.error ?? "approve failed");
  return data.data;
}

async function reopenLineReport(id: number): Promise<LineApprovalSummary> {
  const { data } = await http.post<WebResponse<LineApprovalSummary>>(
    `${WORK_CENTER_REPORTS.shift}/${id}/reopen`,
  );
  if (!data.data) throw new Error(data.error ?? "reopen failed");
  return data.data;
}

// The SKU View card's rows, at day or month grain. Same envelope and same
// empty-is-legitimate reasoning as the shift version below.
async function getPeriodReportProducts(
  grain: PeriodGrain,
  id: number,
): Promise<ShiftProductCounts> {
  const { data } = await http.get<WebResponse<ShiftProductCounts>>(
    `${PERIOD_REPORTS[grain]}/${id}/products`,
  );
  if (!data.data) throw new Error(data.error ?? "product counts not found");
  return data.data;
}

// The daily OEE curve behind the OEE Performance dashboard's trend chart, for each
// of the three subjects that has a month table.
//
// MONTH GRAIN ONLY — core-api registers no day-grain route, because a day has no
// days inside it to trend. The literal `month` in each rather than a
// `*_REPORTS[grain]` lookup is deliberate: a grain parameter would compile at day
// grain and 404 at runtime.
//
// THREE FETCHERS AND NOT ONE TAKING A SUBJECT, and this is the whole reason they
// are spelled out. `shared/oee-trend.ts` upstream is parameterised by a table pair
// and a scope column, so the three endpoints return an IDENTICAL envelope — which
// is exactly what makes a wrong pick invisible here: a line's curve rendered on a
// machine screen is twelve plausible points about another subject, with nothing on
// screen to say so. Naming each one is what lets a test assert WHICH ran, the only
// thing that catches it (apps/web/AGENTS.md's dispatch rule).
//
// The MACHINE one is `getMachineMonthOeeTrend`, not `getMonthOeeTrend`. It shipped
// under the shorter name while it was the only one; at three siblings a name that
// omits the subject is a name a route picks wrong.
async function getMachineMonthOeeTrend(id: number): Promise<MonthOeeTrend> {
  const { data } = await http.get<WebResponse<MonthOeeTrend>>(
    `${PERIOD_REPORTS.month}/${id}/oee-trend`,
  );
  if (!data.data) throw new Error(data.error ?? "oee trend not found");
  return data.data;
}

async function getLineMonthOeeTrend(id: number): Promise<MonthOeeTrend> {
  const { data } = await http.get<WebResponse<MonthOeeTrend>>(
    `${WORK_CENTER_REPORTS.month}/${id}/oee-trend`,
  );
  if (!data.data) throw new Error(data.error ?? "oee trend not found");
  return data.data;
}

async function getAreaMonthOeeTrend(id: number): Promise<MonthOeeTrend> {
  const { data } = await http.get<WebResponse<MonthOeeTrend>>(
    `${AREA_REPORTS.month}/${id}/oee-trend`,
  );
  if (!data.data) throw new Error(data.error ?? "oee trend not found");
  return data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE YEAR GRAIN — four reads per subject, and nothing else answers at it
// ─────────────────────────────────────────────────────────────────────────────
//
// core-api registers the list, the detail, the OEE trend and the reject breakdown
// at year grain and NOTHING ELSE — no products, no activity, no performance, no
// approval. That is why these are twelve named functions rather than a grain
// parameter on the existing ones: a grain argument would compile for reads the
// server does not serve.
//
// THE YEAR LIST TAKES NO `month`. The server refuses one outright, so there is no
// field to send — and a year list narrowed to a month is a different question.
type YearReportListParams = {
  page: number;
  size: number;
  year?: number;
  // Machine and line only — an area year list has no line to narrow to.
  workCenterId?: number;
  // ALL THREE SUBJECTS NOW, which is a change worth naming because this field
  // used to be the AREA list's alone. On the area year list it is the grain KEY;
  // on the machine and line ones it is the header picker narrowing the page, the
  // same lens every other list carries since migration `0028` put `area_id` on
  // `oee.{work_unit,work_center}_year_reports`.
  areaId?: number;
  hideZero: boolean;
};

async function getYearReportList<T>(
  base: string,
  params: YearReportListParams,
): Promise<{ items: T[]; meta: PageMeta | undefined }> {
  const { hideZero, ...rest } = params;
  const { data } = await http.get<WebResponse<T[]>>(base, {
    // `isHideZero` only when true: core-api coerces the string "true", and sending
    // "false" would be a filter that reads as set and does nothing.
    params: { ...stripUndefined(rest), ...(hideZero ? { isHideZero: "true" } : {}) },
  });
  return { items: data.data ?? [], meta: data.meta };
}

function getMachineYearReports(params: YearReportListParams) {
  return getYearReportList<MachineYearReportListItem>(WORK_UNIT_YEAR_REPORTS, params);
}
function getLineYearReports(params: YearReportListParams) {
  return getYearReportList<LineYearReportListItem>(WORK_CENTER_YEAR_REPORTS, params);
}
function getAreaYearReports(params: YearReportListParams) {
  return getYearReportList<AreaYearReportListItem>(AREA_YEAR_REPORTS, params);
}

// The three DETAIL reads. Each stamps its own `subject`, for getShiftReport's
// reason: no endpoint can know its own subject, and this function is the one place
// that knows which one answered.
async function getMachineYearReport(id: number): Promise<MachineYearReportDetail> {
  const { data } = await http.get<WebResponse<Omit<MachineYearReportDetail, "subject">>>(
    `${WORK_UNIT_YEAR_REPORTS}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "machine" };
}

async function getLineYearReport(id: number): Promise<LineYearReportDetail> {
  const { data } = await http.get<WebResponse<Omit<LineYearReportDetail, "subject">>>(
    `${WORK_CENTER_YEAR_REPORTS}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "line" };
}

async function getAreaYearReport(id: number): Promise<AreaYearReportDetail> {
  const { data } = await http.get<WebResponse<Omit<AreaYearReportDetail, "subject">>>(
    `${AREA_YEAR_REPORTS}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "area" };
}

// The three YEAR trends. TWELVE MONTHLY POINTS, not ~365 daily ones — the inner
// table is always one grain finer than the outer.
async function getMachineYearOeeTrend(id: number): Promise<MonthOeeTrend> {
  const { data } = await http.get<WebResponse<MonthOeeTrend>>(
    `${WORK_UNIT_YEAR_REPORTS}/${id}/oee-trend`,
  );
  if (!data.data) throw new Error(data.error ?? "oee trend not found");
  return data.data;
}

async function getLineYearOeeTrend(id: number): Promise<MonthOeeTrend> {
  const { data } = await http.get<WebResponse<MonthOeeTrend>>(
    `${WORK_CENTER_YEAR_REPORTS}/${id}/oee-trend`,
  );
  if (!data.data) throw new Error(data.error ?? "oee trend not found");
  return data.data;
}

async function getAreaYearOeeTrend(id: number): Promise<MonthOeeTrend> {
  const { data } = await http.get<WebResponse<MonthOeeTrend>>(
    `${AREA_YEAR_REPORTS}/${id}/oee-trend`,
  );
  if (!data.data) throw new Error(data.error ?? "oee trend not found");
  return data.data;
}

// The three YEAR reject breakdowns — the Six Big Losses card's quality arm and the
// Pareto Quality Losses card.
async function getMachineYearRejects(id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${WORK_UNIT_YEAR_REPORTS}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "reject breakdown not found");
  return data.data;
}

async function getLineYearRejects(id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${WORK_CENTER_YEAR_REPORTS}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "reject breakdown not found");
  return data.data;
}

async function getAreaYearRejects(id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${AREA_YEAR_REPORTS}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "reject breakdown not found");
  return data.data;
}

// The hourly profile behind the Losses card's View button, at DAY grain.
//
// Day only. core-api 404s a month request on purpose — ~720 hourly points is not
// a line chart — and the browser does not render the button there either, so
// this is a second statement of the same rule rather than a fallback.
async function getPeriodReportPerformance(id: number): Promise<ShiftPerformance> {
  const { data } = await http.get<WebResponse<ShiftPerformance>>(
    `${PERIOD_REPORTS.day}/${id}/performance`,
  );
  if (!data.data) throw new Error(data.error ?? "performance not found");
  return data.data;
}

// The Losses page's Quality and Others tabs at day or month grain.
//
// Same envelope and same empty-is-legitimate reasoning as their shift siblings.
// The one thing worth knowing is that over a 30-day window the server's
// single-unit guards trip far more often, so `counterUnit` and `convertedUnit`
// arrive null more often too — the screen already renders an em dash for that.
async function getPeriodReportRejects(
  grain: PeriodGrain,
  id: number,
): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${PERIOD_REPORTS[grain]}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "reject breakdown not found");
  return data.data;
}

async function getPeriodReportDowntimeEvents(
  grain: PeriodGrain,
  id: number,
): Promise<DowntimeEventReasonBreakdown> {
  const { data } = await http.get<WebResponse<DowntimeEventReasonBreakdown>>(
    `${PERIOD_REPORTS[grain]}/${id}/downtime-events`,
  );
  if (!data.data) throw new Error(data.error ?? "downtime event breakdown not found");
  return data.data;
}

// The MONTH report's hour-of-day profile — its own path, because the payload
// genuinely differs from /performance's. See HourOfDayProfile.
async function getMonthReportHourProfile(id: number): Promise<HourOfDayProfile> {
  const { data } = await http.get<WebResponse<HourOfDayProfile>>(
    `${PERIOD_REPORTS.month}/${id}/hour-profile`,
  );
  if (!data.data) throw new Error(data.error ?? "hour profile not found");
  return data.data;
}

// The "…" menu's Log Activity feed at day or month grain.
//
// Same payload shape as the shift version, with one field populated that is null
// there: each approval entry carries the SHIFT it belongs to, because a day's
// feed spans three reports and a month's ~90.
async function getPeriodReportActivity(grain: PeriodGrain, id: number): Promise<ShiftActivity> {
  const { data } = await http.get<WebResponse<ShiftActivity>>(
    `${PERIOD_REPORTS[grain]}/${id}/activity`,
  );
  if (!data.data) throw new Error(data.error ?? "activity not found");
  return data.data;
}

type PeriodGrain = "day" | "month";

type PeriodReportListParams = {
  page: number;
  size: number;
  month?: number;
  year?: number;
  workCenterId?: number;
  // The header picker, as on every other list — see ShiftReportListParams.areaId.
  areaId?: number;
  hideZero: boolean;
};

// The per-SKU output breakdown of one report. A sub-resource of the report rather
// than a scoped collection of its own: the rows are keyed by the report's work
// unit, business day and shift, so sending the id lets core-api join the two
// tables — the browser never has to round-trip three values it read off one of
// them, and the two ETLs cannot drift into a silently empty card.
//
// Unpaged. An empty `items` is a legitimate answer — a machine can run no product
// in a shift — which is exactly why the payload is an OBJECT and not a bare array:
// see ShiftProductCounts.
async function getShiftReportProducts(id: number): Promise<ShiftProductCounts> {
  const { data } = await http.get<WebResponse<ShiftProductCounts>>(
    `${SHIFT_REPORTS}/${id}/products`,
  );
  // THROWS on a null payload now, where this used to substitute `[]` — and the
  // substitution was the bug. An empty list is a legitimate answer, but it is only
  // legitimate WITH the watermark beside it: `[]` alone cannot say whether the
  // machine ran nothing or the pipeline has not reached this day, and defaulting
  // discarded exactly the field that decides. Matches getShiftReportPerformance.
  if (!data.data) throw new Error(data.error ?? "product counts not found");
  return data.data;
}

// The hourly per-SKU production profile of one report — the drill-down behind the
// Losses card's View button. A sub-resource for the same reason products is.
//
// Unlike products this MUST throw on a null payload rather than substituting an
// empty value. The response is an object whose `timeZone` and `loadedThrough` are
// what make an empty bucket list interpretable; defaulting to
// `{ buckets: [], loadedThrough: null }` would fabricate "never loaded" out of a
// transport failure, and the modal would confidently show the wrong explanation.
// An empty `buckets` inside a real payload is still a legitimate answer.
async function getShiftReportPerformance(id: number): Promise<ShiftPerformance> {
  const { data } = await http.get<WebResponse<ShiftPerformance>>(
    `${SHIFT_REPORTS}/${id}/performance`,
  );
  if (!data.data) throw new Error(data.error ?? "performance not found");
  return data.data;
}

// The per-counter reject breakdown behind the Losses page's Quality Loss Pareto.
// A sub-resource for the same reason products and performance are.
//
// NO PARAMS TYPE, and that is worth naming rather than merely noticing: the
// report id is the whole request. So this endpoint has no equivalent of
// `reasonBreakdownParams`, and therefore none of its quietest failure mode —
// there is no params object for the route's loader and the card to build
// differently, which is how a prefetch comes to write a cache entry nobody reads.
//
// THROWS on a null payload, like getShiftReportPerformance and unlike
// getShiftReportProducts. `loadedThrough` is what makes an empty `buckets`
// interpretable, so defaulting would fabricate "never loaded" out of a transport
// failure. An empty `buckets` inside a real payload is legitimate — and until the
// pipeline writes oee.reject_count_wu_shift it is the only answer there is.
async function getShiftReportRejects(id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${SHIFT_REPORTS}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "reject breakdown not found");
  return data.data;
}

// The per-reason downtime EVENT COUNT behind the Losses page's Others Pareto. A
// report sub-resource for the reason /products, /performance and /rejects are.
//
// NO PARAMS TYPE, and that is load-bearing rather than merely simpler — the same
// argument getShiftReportRejects makes above. The report id is the whole request,
// so there is no equivalent of `reasonBreakdownParams` for the route's loader and
// the card to build differently, which is how a prefetch comes to warm a cache
// entry nobody reads.
//
// THROWS on a null payload, like getShiftReportRejects. `loadedThrough` is what
// makes an empty `buckets` interpretable, so defaulting would fabricate "never
// loaded" out of a transport failure. An empty `buckets` inside a real payload is
// legitimate — and until the pipeline writes oee.downtime_log_events it is the
// only answer there is.
async function getShiftReportDowntimeEvents(id: number): Promise<DowntimeEventReasonBreakdown> {
  const { data } = await http.get<WebResponse<DowntimeEventReasonBreakdown>>(
    `${SHIFT_REPORTS}/${id}/downtime-events`,
  );
  if (!data.data) throw new Error(data.error ?? "downtime event breakdown not found");
  return data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// The SKU grain
// ─────────────────────────────────────────────────────────────────────────────

type SkuReportListParams = {
  page: number;
  size: number;
  month?: number;
  year?: number;
  workCenterId?: number;
  // The header picker. It STACKS with `productId` rather than competing with it:
  // the two narrow along different axes — an area is CONTAINMENT, a SKU is
  // OCCUPANCY OVER TIME (migration 0020) — so "SKU A, in Filling 2" is one
  // question with one answer. See ShiftReportListParams.areaId.
  areaId?: number;
  productId?: number;
  hideZero: boolean;
};

// NO GRAIN PARAMETER ON ANY OF THESE. There is one table, so a grain argument
// would be a parameter with one legal value — the shape a caller assumes is
// meaningful and then passes wrongly.
async function getSkuReports(
  params: SkuReportListParams,
): Promise<{ items: SkuReportListItem[]; meta: PageMeta | undefined }> {
  const { hideZero, ...rest } = params;
  const { data } = await http.get<WebResponse<SkuReportListItem[]>>(SKU_REPORTS, {
    // `isHideZero` only when true: core-api coerces the string "true", and
    // sending "false" would be a filter that reads as set and does nothing.
    params: { ...rest, ...(hideZero ? { isHideZero: "true" } : {}) },
  });
  return { items: data.data ?? [], meta: data.meta };
}

// One SKU report. `subject` is stamped here for the reason getShiftReport stamps
// `grain`: this function is the one place that knows which endpoint answered.
async function getSkuReport(id: number): Promise<SkuReportDetail> {
  const { data } = await http.get<WebResponse<Omit<SkuReportDetail, "subject">>>(
    `${SKU_REPORTS}/${id}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "sku" };
}

async function getSkuRejects(id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${SKU_REPORTS}/${id}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "rejects not found");
  return data.data;
}

// THE ONLY BREAKDOWN THAT CARRIES A COUNT OF WHAT IT COULD NOT SHOW.
// `unattributed` is stops on this line, in this window, with no SKU attributed —
// excluded from every bucket above by construction. Non-zero means the screen is
// showing an incomplete picture and has to say so; see migration 0020 for why
// that is the live state until the pipeline writes downtime_reports.product_id.
async function getSkuDowntimeEvents(id: number): Promise<SkuDowntimeEventBreakdown> {
  const { data } = await http.get<WebResponse<SkuDowntimeEventBreakdown>>(
    `${SKU_REPORTS}/${id}/downtime-events`,
  );
  if (!data.data) throw new Error(data.error ?? "downtime events not found");
  return data.data;
}

// The SKU day report's Log Activity panel. ITS OWN FUNCTION beside
// getLineActivity, never a parameterised one — the id spaces are different and
// naming the endpoint here is what lets a test assert which one answered.
//
// Throws on a null payload rather than defaulting to an empty feed, like every
// other read in this file: an empty chronology is a claim about the data, and this
// module must not make one on the server's behalf.
async function getSkuActivity(id: number): Promise<SkuActivity> {
  const { data } = await http.get<WebResponse<SkuActivity>>(`${SKU_REPORTS}/${id}/activity`);
  if (!data.data) throw new Error(data.error ?? "activity not found");
  return data.data;
}

// The reject dialog's Machine picker — a ROSTER, and a different payload from the
// line's /machines, which returns a per-machine measures breakdown carrying a
// machine REPORT id. See ProductMachineRoster on the API side.
async function getSkuMachines(id: number): Promise<SkuMachineRoster> {
  const { data } = await http.get<WebResponse<SkuMachineRoster>>(`${SKU_REPORTS}/${id}/machines`);
  if (!data.data) throw new Error(data.error ?? "machines not found");
  return data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// The AREA grain
// ─────────────────────────────────────────────────────────────────────────────

type AreaReportListParams = {
  page: number;
  size: number;
  // DAY GRAIN ONLY. core-api's month list does not declare the param, so sending
  // one from a month screen would be a filter that reads as set and does nothing —
  // and the requirement is "Monthly Report (Show all month on selected year)". The
  // month table component never passes it; this stays optional rather than being
  // split into two param types, because the divergence is one field and the six
  // fetchers below share one signature.
  month?: number;
  year?: number;
  // THE HEADER PICKER'S SELECTION. EVERY LIST TAKES ONE NOW, AND THIS ONE STILL
  // MEANS SOMETHING DIFFERENT FROM THE OTHER FOUR.
  //
  // Elsewhere the area is a LENS over rows keyed by something else — a machine, a
  // line, a SKU — and narrows which of them the page shows. HERE THE AREA IS THE
  // SUBJECT: this parameter picks WHICH REPORT, not which slice of one. The wire
  // shape is identical, which is why one validator serves both upstream, and the
  // meanings must not be conflated: `area_id` is this table's grain KEY and a
  // denormalised LABEL on the other four, so a NULL is impossible here and
  // ordinary (TODOS §78) there.
  //
  // OPTIONAL, because the picker is undefined until the area list resolves. Sending
  // nothing means every area, which is a page rather than a 400 — so a first paint
  // shows data instead of an error, and narrows a tick later.
  areaId?: number;
  hideZero: boolean;
};

// EVERY FETCHER TAKES THE GRAIN FIRST, and it is not ceremony: the two area tables
// have INDEPENDENT identity sequences, so `getAreaReport("day", 3)` and
// `getAreaReport("month", 3)` are two different reports. Nine report tables across
// four subjects, and the quiet failure is the dangerous half — a 404 if no row has
// that id, or another period's forty measures rendered without a warning if one
// does.
async function getAreaReports(
  grain: AreaGrain,
  params: AreaReportListParams,
): Promise<{ items: AreaReportListItem[]; meta: PageMeta | undefined }> {
  const { hideZero, ...rest } = params;
  const { data } = await http.get<WebResponse<AreaReportListItem[]>>(AREA_REPORTS[grain], {
    // `isHideZero` only when true: core-api coerces the string "true", and sending
    // "false" would be a filter that reads as set and does nothing.
    params: { ...rest, ...(hideZero ? { isHideZero: "true" } : {}) },
  });
  return { items: data.data ?? [], meta: data.meta };
}

// One area report.
//
// `subject` IS STAMPED HERE AND `grain` IS NOT, which is the one asymmetry worth
// knowing. No endpoint can know its own subject — that is why getShiftReport stamps
// it too — but both area endpoints DO send their grain, from the table they read.
// Stamping it here as well would be a second source for one fact.
async function getAreaReport(grain: AreaGrain, id: number): Promise<AreaReportDetail> {
  const { data } = await http.get<WebResponse<Omit<AreaReportDetail, "subject">>>(
    `${AREA_REPORTS[grain]}/${String(id)}`,
  );
  if (!data.data) throw new Error(data.error ?? "report not found");
  return { ...data.data, subject: "area" };
}

// SKU View at area grain — a roll-up over the area's lines, which is legitimate
// here and forbidden one grain down (see AreaProductCounts).
async function getAreaProducts(grain: AreaGrain, id: number): Promise<AreaProductCounts> {
  const { data } = await http.get<WebResponse<AreaProductCounts>>(
    `${AREA_REPORTS[grain]}/${String(id)}/products`,
  );
  if (!data.data) throw new Error(data.error ?? "product counts not found");
  return data.data;
}

// The Input/Output Production KPI. THROWS on a null payload rather than defaulting
// to empty buckets, like every other read in this file: `loadedThrough` and the two
// residuals are what make empty buckets interpretable, so defaulting would
// fabricate "no production" out of a transport failure.
async function getAreaProductionUnits(grain: AreaGrain, id: number): Promise<AreaProductionUnits> {
  const { data } = await http.get<WebResponse<AreaProductionUnits>>(
    `${AREA_REPORTS[grain]}/${String(id)}/production-units`,
  );
  if (!data.data) throw new Error(data.error ?? "production units not found");
  return data.data;
}

async function getAreaRejects(grain: AreaGrain, id: number): Promise<RejectReasonBreakdown> {
  const { data } = await http.get<WebResponse<RejectReasonBreakdown>>(
    `${AREA_REPORTS[grain]}/${String(id)}/rejects`,
  );
  if (!data.data) throw new Error(data.error ?? "rejects not found");
  return data.data;
}

// The Others tab. NO `unattributed` ON THIS ONE, unlike the SKU version — an area
// read narrows by `area_id`, which is CONTAINMENT rather than attribution, so a
// NULL there is a missing label and the fix is a backfill upstream. See
// AreaActivity for the full contrast.
async function getAreaDowntimeEvents(
  grain: AreaGrain,
  id: number,
): Promise<DowntimeEventReasonBreakdown> {
  const { data } = await http.get<WebResponse<DowntimeEventReasonBreakdown>>(
    `${AREA_REPORTS[grain]}/${String(id)}/downtime-events`,
  );
  if (!data.data) throw new Error(data.error ?? "downtime events not found");
  return data.data;
}

// The area day report's Log Activity panel. ITS OWN FUNCTION beside the other
// three, never a parameterised one — the id spaces are different and naming the
// endpoint here is what lets a test assert which one answered.
async function getAreaActivity(grain: AreaGrain, id: number): Promise<AreaActivity> {
  const { data } = await http.get<WebResponse<AreaActivity>>(
    `${AREA_REPORTS[grain]}/${String(id)}/activity`,
  );
  if (!data.data) throw new Error(data.error ?? "activity not found");
  return data.data;
}

// WHICH LEVEL OF THE PLANT a downtime read is scoped to.
//
// core-api accepts `factory` too and answers it with a 400 until
// oee.downtime_reports carries a factory_id. Narrowed here so a screen cannot ask
// for a scope that is guaranteed to fail.
//
// `area` JOINED THE LIST WITH THE AREA REPORT. The column has existed since
// migration 0007 — 0007's own COMMENT recorded that it was "NOT yet accepted by
// SCOPE_COLUMN" — and adding it there is what lets the Area screens reuse the
// timeline strip, the Downtime Details table and all three downtime Paretos with
// no new arithmetic anywhere.
type TimelineScope = "work-unit" | "work-center" | "area";

type ShiftTimelineParams = {
  scope: TimelineScope;
  scopeId: number;
  // Which window the date names. Sent on every request, including shift ones:
  // core-api defaults it to "shift" so it could be omitted, but a params object
  // that is the CACHE KEY must state it — otherwise a day and a shift request
  // for the same date collide in the query cache and one screen renders the
  // other's stops.
  //
  // FOUR MEMBERS SINCE `0027`, and the widening reaches more endpoints than the one
  // screen that asked for it. `timelineInputBase` upstream carries the grain enum
  // and FOUR schemas extend it — the timeline strip, the paginated Downtime Details
  // list, and both breakdowns — so `grain: "year"` is acceptable to all four. Only
  // the two BREAKDOWNS have a year consumer (the OEE Performance dashboard's three
  // Paretos and Pareto Actions); nothing asks the other two for a year, and nothing
  // refuses them either. A card handed a year report would fetch a 365-day
  // "timeline strip" — accepted deliberately, because the alternative is splitting
  // `reportWindowParams` in two, and its own header explains why one composer is
  // worth more than that refusal.
  grain: "shift" | "day" | "month" | "year";
  // The report's business day, YYYY-MM-DD. At shift grain it is derived from the
  // report's `date`, the instant the shift STARTED (`timestamptz` upstream) — so
  // it has to be reduced through the plant's zone with toBusinessDay, never by
  // slicing the ISO string. Slicing reads the UTC date, which agrees with the
  // plant's only at UTC+7 and is a day out for a late shift anywhere west of
  // Greenwich. At day and month grain the server sends `businessDate` directly
  // and there is nothing to derive.
  date: string;
  // Shift grain only. core-api 400s a shift-grain request without it, and
  // ignores it otherwise — so it is omitted rather than sent empty.
  shift?: string;
  // A FILTER ALONGSIDE THE SCOPE, NEVER A SCOPE OF ITS OWN. A SKU report is
  // always "this SKU, ON THIS LINE" — scope work-center PLUS product — because a
  // stop belongs to whichever SKU was running, and no scope can derive that
  // (migration 0020).
  //
  // IN THE CACHE KEY BY CONSTRUCTION, since these params ARE the key. Omitting it
  // would collide a SKU's timeline with its line's on the same date, and whichever
  // screen mounted second would render the other's stops — the same failure the
  // `grain` note above describes.
  productId?: number;
};

// The merged downtime timeline for one shift. Already flat and non-overlapping;
// the strip only turns durations into widths.
async function getShiftTimeline(params: ShiftTimelineParams): Promise<ShiftTimeline> {
  const { data } = await http.get<WebResponse<ShiftTimeline>>(`${DOWNTIMES}/timeline`, { params });
  if (!data.data) throw new Error(data.error ?? "timeline not found");
  return data.data;
}

type DowntimeListParams = ShiftTimelineParams & {
  page: number;
  size: number;
  sortBy: DowntimeSortBy;
  sortDir: DowntimeSortDir;
};

// One page of the raw downtime records behind the timeline. `meta.totalElements`
// is the count of records in the shift window — what the card labels "Downtime
// Frequency" — so callers need the meta even when they only render one page.
async function getDowntimes(
  params: DowntimeListParams,
): Promise<{ items: DowntimeListItem[]; meta: PageMeta | undefined }> {
  const { data } = await http.get<WebResponse<DowntimeListItem[]>>(DOWNTIMES, { params });
  return { items: data.data ?? [], meta: data.meta };
}

// The per-reason unplanned-downtime aggregate behind the Losses page's Pareto.
//
// Takes the same scope/scopeId/date/shift as /downtimes and /downtimes/timeline,
// reusing their param type rather than declaring a parallel one — the three
// endpoints must agree on which records belong to a shift, and two types would
// drift. `category` defaults to UNPLANNED server-side; it is the parameter that
// will let the other Loss tabs reuse this endpoint.
//
// THROWS on a null payload, like getShiftReportPerformance and unlike
// getShiftReportProducts. `loadedThrough` is what makes an empty `buckets`
// interpretable, so defaulting to `{ buckets: [], loadedThrough: null }` would
// fabricate "never loaded" out of a transport failure and the page would
// confidently show the wrong explanation. An empty `buckets` inside a real
// payload is still a legitimate answer.
// `category` is REQUIRED, unlike on the wire where it defaults to UNPLANNED.
// The default belongs to the endpoint; here it would be a way to key two
// different breakdowns identically in the query cache — see
// downtimeReasonsQueryOptions.
type ReasonBreakdownParams = ShiftTimelineParams & { category: DowntimeCategory };

// The WHOLE-WINDOW breakdown's extra knob. Its own type rather than a field on
// ReasonBreakdownParams, which the drill-down and the history extend — neither
// ranks anything, and a `measure` they sent would be a parameter the endpoint no
// longer accepts and would quietly ignore.
//
// `measure` DECIDES WHICH BUCKETS COME BACK, not merely how they are ordered: the
// response is the top N, so the top ten by duration are a different ten from the
// top ten by frequency. That is why it is a request parameter at all, and why it
// belongs in the cache key.
type ReasonBreakdownQuery = ReasonBreakdownParams & { measure: ReasonMeasure };

async function getDowntimeReasons(params: ReasonBreakdownQuery): Promise<DowntimeReasonBreakdown> {
  const { data } = await http.get<WebResponse<DowntimeReasonBreakdown>>(`${DOWNTIMES}/by-reason`, {
    params,
  });
  if (!data.data) throw new Error(data.error ?? "downtime reason breakdown not found");
  return data.data;
}

// Pareto Actions' request. ShiftTimelineParams plus a ranking measure, and NO
// category — an action is not an operation type, so core-api's /by-action takes
// none and would ignore one.
type ActionBreakdownQuery = ShiftTimelineParams & { measure: ReasonMeasure };

async function getDowntimeActions(params: ActionBreakdownQuery): Promise<DowntimeActionBreakdown> {
  const { data } = await http.get<WebResponse<DowntimeActionBreakdown>>(`${DOWNTIMES}/by-action`, {
    params,
  });
  if (!data.data) throw new Error(data.error ?? "downtime action breakdown not found");
  return data.data;
}

// WHICH BUCKET, as a discriminated union rather than `string | null`.
//
// The union is what makes the unlabelled case unrepresentable as an empty
// string, which is the trap the wire format has to be protected from. See
// toSelectorParams below.
type ReasonSelector = { kind: "labelled"; reason: string } | { kind: "unlabelled" };

type ReasonSelectorParams = ReasonBreakdownParams & {
  selector: ReasonSelector;
};

type ReasonDetailParams = ReasonSelectorParams & {
  page: number;
  size: number;
  sortBy?: DowntimeSortBy;
  sortDir?: DowntimeSortDir;
};

// GET /downtimes/by-reason/detail — the stops behind ONE reason.
//
// The selector is two params, not one, and that is the whole point. Over the
// wire the unlabelled bucket is `reason IS NULL`; "Unspecified" is a label
// lib/pareto.ts applies here in the browser so a genuine reason of that text
// cannot merge into it. `?reason=` and no `reason` at all are the same absence
// to every HTTP stack in the path, so an explicit `unlabelled=true` is what
// keeps "the unlabelled bucket" and "no filter" from collapsing together.
//
// THROWS on a null payload, for the reason getDowntimeReasons does: an absent
// `bucket` would render as a reason with no stops rather than as a failure.
// Returns the envelope's `meta` alongside, because this endpoint is paged.
async function getReasonDetail(
  params: ReasonDetailParams,
): Promise<{ detail: ReasonDetail; meta: PageMeta | undefined }> {
  const { data } = await http.get<WebResponse<ReasonDetail>>(`${DOWNTIMES}/by-reason/detail`, {
    params: toSelectorParams(params),
  });
  if (!data.data) throw new Error(data.error ?? "downtime reason detail not found");
  return { detail: data.data, meta: data.meta };
}

// GET /downtimes/by-reason/history — the Changes History panel.
//
// Empty everywhere today, and `trackedMembers` is what says why. Throws on a
// null payload rather than defaulting: `{ entries: [] }` invented from a
// transport failure would render as "nothing has changed", which is a claim
// about the data rather than about the request.
async function getReasonHistory(params: ReasonSelectorParams): Promise<ReasonHistory> {
  const { data } = await http.get<WebResponse<ReasonHistory>>(`${DOWNTIMES}/by-reason/history`, {
    params: toSelectorParams(params),
  });
  if (!data.data) throw new Error(data.error ?? "downtime history not found");
  return data.data;
}

// The browser models the selector as a discriminated union; the wire wants two
// flat params. One conversion, here, so no caller can send both or neither.
function toSelectorParams<T extends ReasonSelectorParams>({ selector, ...rest }: T) {
  return {
    ...rest,
    ...(selector.kind === "unlabelled" ? { unlabelled: "true" } : { reason: selector.reason }),
  };
}

// Areas for the header's area picker. Reference data — cached long, see queries.ts.
async function getAreas(): Promise<AreaSummary[]> {
  const { data } = await http.get<WebResponse<AreaSummary[]>>(`${MASTER_DATA}/areas`);
  return data.data ?? [];
}

// Work centers (lines) within one area. `areaId` is required upstream — a
// request without it is a 400, so callers must gate on a chosen area.
async function getWorkCenters(areaId: number): Promise<WorkCenterSummary[]> {
  const { data } = await http.get<WebResponse<WorkCenterSummary[]>>(`${MASTER_DATA}/work-centers`, {
    params: { areaId },
  });
  return data.data ?? [];
}

// The machines on one line, backing the OEE Performance dashboard's machine
// picker.
//
// `workCenterId` is REQUIRED upstream — a request without it is a 400 — so
// callers gate on a chosen line, exactly as getWorkCenters gates on an area.
// Reference data; see queries.ts for how long it is cached.
async function getWorkUnits(workCenterId: number): Promise<WorkUnitSummary[]> {
  const { data } = await http.get<WebResponse<WorkUnitSummary[]>>(`${MASTER_DATA}/work-units`, {
    params: { workCenterId },
  });
  return data.data ?? [];
}

// The reason catalogue for one line, backing the edit dialog's Reason picker.
//
// `workCenterId` is REQUIRED upstream — a request without it is a 400 — so
// callers gate on a report that has resolved its line. Reference data; see
// queries.ts for how long it is cached.
async function getDowntimeReasonOptions(workCenterId: number): Promise<DowntimeReasonOption[]> {
  const { data } = await http.get<WebResponse<DowntimeReasonOption[]>>(
    `${MASTER_DATA}/downtime-reasons`,
    { params: { workCenterId } },
  );
  return data.data ?? [];
}

// The action catalogue. No scope param — actions are regional upstream.
async function getDowntimeActionOptions(): Promise<DowntimeActionOption[]> {
  const { data } = await http.get<WebResponse<DowntimeActionOption[]>>(
    `${MASTER_DATA}/downtime-actions`,
  );
  return data.data ?? [];
}

// Appends to that catalogue, so an operator can record an action the catalogue
// does not have yet without leaving the dialog.
//
// THE ONLY WRITE THIS APP MAKES THAT IS NOT A GOLD MUTATION. It goes to
// mes-master-data through core-api rather than to `oee`, which is why it lives
// beside the reads here and its hook lives in mutations.ts with the other three.
//
// Returns the created row: the caller needs the NAME back, because that is what
// gets written into the downtime's `actions[]`.
async function createDowntimeAction(
  body: CreateDowntimeActionInput,
): Promise<DowntimeActionOption> {
  const { data } = await http.post<WebResponse<DowntimeActionOption>>(
    `${MASTER_DATA}/downtime-actions`,
    body,
  );
  // A 201 that parsed always carries the row; the envelope types `data` as
  // nullable, so this narrows rather than casts.
  if (data.data === null || data.data === undefined) {
    throw new Error("create downtime action returned no data");
  }
  return data.data;
}

// Axios serialises `undefined` params away already, but dropping them here keeps
// them out of the query key too, so "no shift" and "shift: undefined" cache as one.
function stripUndefined(input: Record<string, string | number | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Record<
    string,
    string | number
  >;
}

// The report's audit trail — approval transitions and downtime edits for this
// shift's stops, merged newest-first by the server.
//
// A sub-resource for the reason /products, /performance, /rejects and
// /downtime-events are: the report id is the whole request, so there is no
// params object a loader and a component could build differently.
//
// THROWS on a null payload, and it matters more here than on its siblings.
// `sources` is what explains WHY `entries` is empty — permanently, for the
// quality arm — so defaulting to `{ entries: [] }` would manufacture "nothing
// has ever happened to this report" out of a transport failure. An empty
// `entries` INSIDE a real payload is legitimate, and today it is the usual answer.
async function getShiftReportActivity(id: number): Promise<ShiftActivity> {
  const { data } = await http.get<WebResponse<ShiftActivity>>(`${SHIFT_REPORTS}/${id}/activity`);
  if (!data.data) throw new Error(data.error ?? "activity not found");
  return data.data;
}

// THE FIRST WRITE IN THIS APP. Everything above this line is http.get.
//
// POST /:id/approve rather than PATCH /:id with a status, because this is a
// NAMED OPERATOR MUTATION — the vocabulary docs/gold-write-contract.md §1 rule 2
// uses — and not a partial update of a report. A general state setter would
// publish `{"status":"open"}` as a request the moment it existed, forcing the
// server to either implement reopen or refuse the only other value in its own
// vocabulary. Reopen arrives as its own route (TODOS.md §33).
//
// BODYLESS. Deliberately no payload and deliberately no Content-Type: the server
// has no jsonValidator on this route, and sending an empty JSON object would be
// the thing most likely to make it add one.
//
// RETURNS THE UPDATED APPROVAL, which is a requirement on the endpoint rather
// than a convenience: gold-write-contract.md §8 records that approvals need
// read-after-write, and the header's badge flips from this payload instead of
// waiting a round trip for a refetch.
async function approveShiftReport(id: number): Promise<ShiftReportApproval> {
  const { data } = await http.post<WebResponse<ShiftReportApproval>>(
    `${SHIFT_REPORTS}/${id}/approve`,
  );
  if (!data.data) throw new Error(data.error ?? "approve failed");
  return data.data;
}

// closed -> open. The other half of the state machine, and bodyless for the same
// two reasons approve is.
//
// It exists because editing a downtime on an APPROVED report is refused with a
// 409. Without a reopen, an operator who spots a real mistake on a signed-off
// report cannot correct it at all — the freeze would be a trap rather than a
// control.
async function reopenShiftReport(id: number): Promise<ShiftReportApproval> {
  const { data } = await http.post<WebResponse<ShiftReportApproval>>(
    `${SHIFT_REPORTS}/${id}/reopen`,
  );
  if (!data.data) throw new Error(data.error ?? "reopen failed");
  return data.data;
}

// When a stop in this shift last had its CATEGORY edited. See MetricsStaleness
// for why there is no boolean in the payload.
//
// ITS OWN ENDPOINT rather than a field on the report, because the detail route
// AWAITS the report — anything folded into that payload lands on the blocking
// loader, and this read scans the downtime table for the shift's stops.
async function getMetricsStaleness(id: number): Promise<MetricsStaleness> {
  const { data } = await http.get<WebResponse<MetricsStaleness>>(
    `${SHIFT_REPORTS}/${id}/metrics-staleness`,
  );
  if (!data.data) throw new Error(data.error ?? "staleness not found");
  return data.data;
}

// The same question at day and month grain (TODOS §50). Those tables roll up the
// same time a shift report does, so a category edit makes them stale identically —
// and until this shipped only the shift screen said so.
//
// A SEPARATE FUNCTION PER SUBJECT AND GRAIN, never one with a parameterised path,
// for the reason stated on getLineReport: three of these seven report tables have
// independent id sequences, so the wrong endpoint answers 200 about a different
// report entirely. And "nothing was edited" is the REASSURING answer, which makes
// this the worst place in the app to resolve an id against the wrong table.
async function getPeriodMetricsStaleness(
  grain: PeriodGrain,
  id: number,
): Promise<MetricsStaleness> {
  const { data } = await http.get<WebResponse<MetricsStaleness>>(
    `${PERIOD_REPORTS[grain]}/${id}/metrics-staleness`,
  );
  if (!data.data) throw new Error(data.error ?? "staleness not found");
  return data.data;
}

// And at LINE shift grain. Shift only: the window it needs is a shift's.
async function getLineMetricsStaleness(id: number): Promise<MetricsStaleness> {
  const { data } = await http.get<WebResponse<MetricsStaleness>>(
    `${WORK_CENTER_REPORTS.shift}/${id}/metrics-staleness`,
  );
  if (!data.data) throw new Error(data.error ?? "staleness not found");
  return data.data;
}

// Edit one downtime's category, reasons, detail reason and actions.
//
// PATCH, unlike the two named actions above, and the difference is real. `approve`
// and `reopen` are TRANSITIONS in a state machine, where a general setter would
// publish the opposite one the moment it existed. This is an update of four named
// fields on a resource — no state machine, no second verb hiding in it.
//
// KEYED ON sourceEventId, NEVER `id`. Gold loads that table DELETE-then-INSERT, so
// the surrogate id is re-minted on every pipeline run and a URL built from it
// would come to address a different stop. encodeURIComponent because the value is
// free text carried from Silver.
//
// SENDS BOTH HALVES. `baseline` is what the dialog was showing; the server binds
// it into the UPDATE's WHERE so a second operator cannot silently revert the
// first. A 412 comes back instead, and its MESSAGE says which writer got there
// first — which is why the dialog renders the server's text for that status
// rather than its own.
//
// RETURNS THE UPDATED ROW, so the table writes it through the cache instead of
// refetching the page it is standing on.
async function editDowntime(
  sourceEventId: string,
  payload: EditDowntimePayload,
): Promise<DowntimeEditResult> {
  const { data } = await http.patch<WebResponse<DowntimeEditResult>>(
    `${DOWNTIMES}/${encodeURIComponent(sourceEventId)}`,
    payload,
  );
  if (!data.data) throw new Error(data.error ?? "edit failed");
  return data.data;
}

export {
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
  approveShiftReport,
  createDowntimeAction,
  editDowntime,
  getAreas,
  getDowntimeActionOptions,
  // NOT the same thing as getDowntimeReasonOptions below: this one is the
  // Availability Pareto's breakdown of THIS shift's stops, the other is
  // mes-master-data's catalogue of reasons that may be picked. The names are
  // spelled apart on purpose — they were one letter apart in review.
  getDowntimeReasons,
  getDowntimeActions,
  getDowntimeReasonOptions,
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
  getDowntimes,
  getMe,
  getMetricsStaleness,
  getReasonDetail,
  getReasonHistory,
  approveLineReport,
  getLineActivity,
  getLineDowntimeEvents,
  getLineMachines,
  getLineMetricsStaleness,
  createQualityEntry,
  getLineHourProfile,
  getLinePerformance,
  getLineProductOptions,
  getProductDetail,
  getRejectReasonOptions,
  getQualityEntries,
  voidQualityEntry,
  getLineProducts,
  getLineRejects,
  getLineApproval,
  getLineReport,
  getPeriodMetricsStaleness,
  getPeriodReport,
  reopenLineReport,
  getMonthReportHourProfile,
  getPeriodReportActivity,
  getPeriodReportDowntimeEvents,
  getPeriodReportPerformance,
  getPeriodReportRejects,
  getPeriodReportProducts,
  getWorkUnits,
  getPeriodReports,
  getShiftReport,
  getShiftReportActivity,
  getShiftReportDowntimeEvents,
  getShiftReportPerformance,
  getShiftReportProducts,
  getShiftReportRejects,
  getShiftReports,
  getLineReports,
  getShiftTimeline,
  reopenShiftReport,
  getWorkCenters,
  login,
  logout,
  PROXY_PREFIX,
};
export type {
  ActionBreakdownQuery,
  AreaReportListParams,
  SkuReportListParams,
  DowntimeListParams,
  LineReportListParams,
  ReasonBreakdownParams,
  ReasonBreakdownQuery,
  ReasonDetailParams,
  ReasonSelector,
  ReasonSelectorParams,
  PeriodGrain,
  PeriodReportListParams,
  YearReportListParams,
  ShiftReportListParams,
  ShiftTimelineParams,
  TimelineScope,
};
