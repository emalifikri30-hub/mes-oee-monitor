// HTTP implementation of MasterDataClientContract.
//
// One private request<T>() carries everything every call needs, so the five
// public methods stay thin and no policy is implemented once per call site:
//
//   request<T>(operation, path, query, schema, body?)   body -> POST, else GET
//     │
//     ├─ token = serviceTokenProvider.getToken()        cached, single-flight
//     ├─ fetch(url, Bearer token, AbortSignal(timeout))
//     │    ├─ aborted        -> MasterDataError timeout
//     │    └─ threw          -> MasterDataError network_error
//     ├─ 401/403 on attempt 1 -> invalidate() + retry ONCE ──┐
//     │    └─ 401/403 again  -> MasterDataError auth_error   │ (self-heals a
//     ├─ other !ok           -> MasterDataError http_error   │  rotated secret
//     ├─ body not JSON       -> MasterDataError parse_error  │  or key roll)
//     ├─ schema mismatch     -> MasterDataError parse_error  │
//     └─ ok                  -> parsed data  ◀───────────────┘
//
// Two shapes of read sit on top of it:
//
//   findAllWorkUnitByWorkCenterId  walks every page  — a dataset to traverse
//   findAllArea / ...WorkCenterByAreaId  ONE page       — a filter's option set
//   findAllDowntimeReason... / ...Action ONE page       — a picker's option set
//
// And ONE write, createDowntimeAction, which is the only reason `request` knows
// about a body at all. See the note on the retry inside it: the 401/403 retry is
// safe for a POST precisely because upstream refuses before its handler runs.
//
// Spans are NOT created here: UndiciInstrumentation is always installed
// (see @molca/observability otel.ts), so every fetch already emits a CLIENT span
// with url, status and error. Only the metric and the typed cause are added.

import type { Logger } from "@molca/utils";
import type {
  AreaSummary,
  CreateDowntimeActionInput,
  DowntimeActionSummary,
  DowntimeReasonSummary,
  MasterDataClientContract,
  ProductDetail,
  RejectReasonSummary,
  SiteTimeZone,
  TimeZoneScope,
  WorkCenterSummary,
  WorkUnitPartialFetch,
  WorkUnitWithCenter,
} from "@molca/contract-client";
import type { ServiceTokenProvider } from "@molca/mes";
import type { ZodType } from "zod";

import * as z from "zod";
import { baseLogger, getRequestContext } from "@molca/observability";
import { chunk } from "@molca/helper";

import { MasterDataError } from "./master-data-error.js";
import {
  createdIdEnvelopeSchema,
  pagedDowntimeActionListEnvelopeSchema,
  pagedDowntimeReasonListEnvelopeSchema,
  pagedSummaryListEnvelopeSchema,
  pagedWorkUnitListEnvelopeSchema,
  siteTimeZoneEnvelopeSchema,
  workCenterEnvelopeSchema,
  workUnitListEnvelopeSchema,
  pagedRejectReasonListEnvelopeSchema,
  productDetailEnvelopeSchema,
} from "./master-data-schema.js";
import {
  getMasterDataDurationHistogram,
  getMasterDataRequestsCounter,
} from "../../shared/observability/metrics.js";

// Matches the `?ids=` cap upstream enforces (its MAX_PAGE_SIZE). Sending more
// would be rejected with a 400, so the id list is chunked at exactly this size.
// A chunk size for a REMOTE call is bounded by the callee's page limit and by
// URL length — unlike an in-process client, which can batch far more freely.
//
// Doubles as the page size for every read here, since it IS upstream's largest
// servable page — asking for more is a 400, not a bigger page.
const IDS_PER_REQUEST = 100;

// Bounds the work-unit page loop. 20 pages x 100 = 2000 work units, far above
// any real work center, but finite: an upstream bug in `totalPages` must not be
// able to spin this loop until the caller times out.
const MAX_WORK_UNIT_PAGES = 20;

const WORK_UNITS_PATH = "/v1/work-units";
const WORK_CENTERS_PATH = "/v1/work-centers";
const AREA_PATH = "/v1/areas";
const DOWNTIME_REASONS_PATH = "/v1/downtime-reasons";
const DOWNTIME_ACTIONS_PATH = "/v1/downtime-actions";
const REJECT_REASONS_PATH = "/v1/reject-reasons";
const PRODUCTS_PATH = "/v1/products";

// Sub-resource on both of the above: upstream walks the rest of the hierarchy
// (-> area -> site) server-side and answers with the site's zone.
const TIMEZONE_SEGMENT = "timezone";

type MasterDataClientDeps = {
  masterDataBaseUrl: string;
  masterDataTimeoutMs: number;
  serviceTokenProvider: ServiceTokenProvider;
  logger?: Logger;
};

class MasterDataClient implements MasterDataClientContract {
  private baseUrl: string;
  private timeoutMs: number;
  private tokenProvider: ServiceTokenProvider;
  private fallbackLogger: Logger;

  constructor({
    masterDataBaseUrl,
    masterDataTimeoutMs,
    serviceTokenProvider,
    logger,
  }: MasterDataClientDeps) {
    this.baseUrl = masterDataBaseUrl;
    this.timeoutMs = masterDataTimeoutMs;
    this.tokenProvider = serviceTokenProvider;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  async existsWorkCenter(workCenterId: number): Promise<boolean> {
    const operation = "existsWorkCenter";
    try {
      await this.request(
        operation,
        `${WORK_CENTERS_PATH}/${workCenterId}`,
        undefined,
        workCenterEnvelopeSchema,
      );
      return true;
    } catch (err) {
      // A 404 is the answer, not a failure: it is precisely how upstream says
      // "no such work center". Every other cause still propagates.
      if (err instanceof MasterDataError && err.status === 404) return false;
      throw err;
    }
  }

  // The line's machine roster, WHOLE ROWS rather than bare ids.
  //
  // IT USED TO RETURN `{ id }[]` AND THE WIDENING COST NOTHING: the response was
  // already being parsed as workUnitWithCenterSchema and the name and code thrown
  // away. The OEE Performance dashboard's machine picker needs those labels, and a
  // second method would have meant a second copy of the page loop and the
  // truncation warning below — the exact duplication watermark.ts's header
  // describes as failing quietly.
  //
  // Callers that only want ids map them; MasterDataService caches this ONCE and
  // serves both shapes from the one entry, so widening it added no upstream traffic.
  async findAllWorkUnitByWorkCenterId(workCenterId: number): Promise<WorkUnitWithCenter[]> {
    const operation = "findAllWorkUnitByWorkCenterId";
    const units: WorkUnitWithCenter[] = [];

    for (let page = 1; page <= MAX_WORK_UNIT_PAGES; page += 1) {
      const body = await this.request(
        operation,
        WORK_UNITS_PATH,
        {
          workCenterId: String(workCenterId),
          page: String(page),
          size: String(IDS_PER_REQUEST),
        },
        pagedWorkUnitListEnvelopeSchema,
      );

      for (const item of body.data ?? []) {
        units.push({ id: item.id, code: item.code, name: item.name, workCenter: item.workCenter });
      }

      const totalPages = body.meta?.totalPages ?? 1;
      if (page >= totalPages) return units;

      // Truncation must never be silent: the caller uses this list as a filter,
      // so dropping ids quietly shortens the report with no visible error.
      if (page === MAX_WORK_UNIT_PAGES) {
        this.count(operation, "truncated");
        this.logger
          .withMetadata({
            event: "master_data_page_cap_reached",
            master_data_operation: operation,
            work_center_id: workCenterId,
            pages_fetched: MAX_WORK_UNIT_PAGES,
            total_pages: totalPages,
            ids_returned: units.length,
          })
          .warn("master_data_page_cap_reached");
      }
    }

    return units;
  }

  async findAllWorkUnitByWorkUnitIds(
    workUnitIds: number[],
  ): Promise<WorkUnitPartialFetch<WorkUnitWithCenter>> {
    const operation = "findAllWorkUnitByWorkUnitIds";
    const unique = [...new Set(workUnitIds)];

    // Short-circuit before any I/O. An empty `?ids=` would be dropped upstream
    // as "no filter" and return the entire catalogue — the opposite of intent.
    if (unique.length === 0) return { found: [], missingIds: [] };

    const found: WorkUnitWithCenter[] = [];

    // In practice this is a single chunk: a report page is capped at 100 rows,
    // so it can hold at most 100 distinct work-unit ids. The loop is here so a
    // future page-size increase cannot silently start returning partial labels.
    for (const batch of chunk(unique, IDS_PER_REQUEST)) {
      const body = await this.request(
        operation,
        WORK_UNITS_PATH,
        { ids: batch.join(","), size: String(IDS_PER_REQUEST) },
        workUnitListEnvelopeSchema,
      );

      for (const item of body.data ?? []) {
        found.push({
          id: item.id,
          code: item.code,
          name: item.name,
          workCenter: item.workCenter,
        });
      }
    }

    const foundIds = new Set(found.map((w) => w.id));
    const missingIds = unique.filter((id) => !foundIds.has(id));

    return { found, missingIds };
  }

  async findAllArea(): Promise<AreaSummary[]> {
    return await this.fetchSummaryList("findAllArea", AREA_PATH);
  }

  // Unlike every other read here, a failure is NOT tolerable at the call site:
  // a shift window cannot be computed without a zone, and inventing one would
  // silently shift every timeline by the plant's offset. Caching and the
  // last-known-good fallback that make this survivable live in TimeZoneResolver,
  // not here — this method just fetches.
  async findTimeZoneByScope(scope: TimeZoneScope, id: number): Promise<SiteTimeZone> {
    const operation = "findTimeZoneByScope";

    // AN AREA HAS NO UPSTREAM ENDPOINT, so it resolves in TWO HOPS through one of
    // its work centers. See TimeZoneScope for the full argument; the short version
    // is that mes-master-data's own walk passes through `area` on its way to
    // `sites.timezone` but exposes no entry point there, and TODOS.md carries the
    // ask for one.
    //
    // WHY PICKING "ONE OF ITS WORK CENTERS" IS NOT ARBITRARY. A work center
    // belongs to exactly one area and therefore one site, which is the property
    // upstream's own timezone-repository comment states for the work-unit and
    // work-center entry points ("the two entry points can never disagree"). Every
    // line in an area resolves to the same zone, so the FIRST is as good as any
    // and there is nothing for a caller to get wrong by not choosing.
    //
    // AN EMPTY AREA IS UNRESOLVABLE, AND THAT IS THE RIGHT ANSWER. An area with no
    // work centers has no site and therefore no zone; inventing one would silently
    // shift every timeline on the area screen by the plant's offset, which is the
    // failure this whole path exists to prevent. `http_error` with a 404 keeps
    // TimeZoneResolver's distinction intact — `timeZoneUnresolvable` preserves a
    // 404 rather than reporting it as unavailable.
    //
    // THE COST IS PAID ONCE PER AREA PER TTL, not per request: TimeZoneResolver
    // caches on `area:<id>` with the same 15-minute policy and the same
    // last-known-good fallback as the other two scopes.
    if (scope === "area") {
      const workCenters = await this.findAllWorkCenterByAreaId(id);
      const first = workCenters[0];
      if (first === undefined) {
        throw this.fail(
          operation,
          "http_error",
          `area ${String(id)} has no work centers, so it resolves to no site`,
          404,
        );
      }
      return await this.findTimeZoneByScope("work-center", first.id);
    }

    const base = scope === "work-unit" ? WORK_UNITS_PATH : WORK_CENTERS_PATH;

    const body = await this.request(
      operation,
      `${base}/${id}/${TIMEZONE_SEGMENT}`,
      undefined,
      siteTimeZoneEnvelopeSchema,
    );

    // The envelope types `data` as nullable, and a null here would otherwise
    // reach the resolver as `undefined.timezone`.
    if (body.data === null) {
      throw this.fail(operation, "parse_error", "response carried no data");
    }

    // Projected rather than passed through, for the reason spelled out in
    // fetchSummaryList: `z.looseObject` KEEPS unknown keys.
    return {
      siteId: body.data.siteId,
      siteCode: body.data.siteCode,
      timezone: body.data.timezone,
    };
  }

  async findAllWorkCenterByAreaId(areaId: number): Promise<WorkCenterSummary[]> {
    return await this.fetchSummaryList("findAllWorkCenterByAreaId", WORK_CENTERS_PATH, {
      areaId: String(areaId),
    });
  }

  // ONE page, for the reason fetchSummaryList gives: this is a picker's option
  // set, not a dataset. Not routed THROUGH fetchSummaryList because that one is
  // typed to the three-field summary and these rows carry `category` — the
  // truncation warning is duplicated rather than the projection being widened,
  // since widening it would let an area or work-center list quietly start
  // carrying fields nothing declared.
  async findAllDowntimeReasonByWorkCenterId(
    workCenterId: number,
  ): Promise<DowntimeReasonSummary[]> {
    const operation = "findAllDowntimeReasonByWorkCenterId";
    const body = await this.request(
      operation,
      DOWNTIME_REASONS_PATH,
      { workCenterId: String(workCenterId), page: "1", size: String(IDS_PER_REQUEST) },
      pagedDowntimeReasonListEnvelopeSchema,
    );

    this.warnIfTruncated(operation, body.meta?.totalPages ?? 1, body.data?.length ?? 0, {
      workCenterId: String(workCenterId),
    });

    // Projected, never passed through: `z.looseObject` KEEPS unknown keys, and
    // these rows carry upstream's junction arrays and timestamps.
    return (body.data ?? []).map(({ id, code, name, category }) => ({
      id,
      code,
      name,
      category,
    }));
  }

  // The reject catalogue for one line — the quality-entry dialog's Reason picker,
  // for BOTH kinds. Structurally identical to the downtime one above; separate
  // because the two catalogues are separate tables upstream and their payloads
  // are free to diverge.
  async findAllRejectReasonByWorkCenterId(workCenterId: number): Promise<RejectReasonSummary[]> {
    const operation = "findAllRejectReasonByWorkCenterId";
    const body = await this.request(
      operation,
      REJECT_REASONS_PATH,
      { workCenterId: String(workCenterId), page: "1", size: String(IDS_PER_REQUEST) },
      pagedRejectReasonListEnvelopeSchema,
    );

    this.warnIfTruncated(operation, body.meta?.totalPages ?? 1, body.data?.length ?? 0, {
      workCenterId: String(workCenterId),
    });

    // Projected, never passed through: z.looseObject KEEPS unknown keys, and
    // these rows carry upstream's three junction arrays and its timestamps.
    return (body.data ?? []).map(({ id, code, name }) => ({ id, code, name }));
  }

  // The SKUs assigned to one line. Its own method rather than fetchSummaryList
  // with a query, only because the truncation warning wants the scope in its
  // metadata — the projection is the same.
  async findAllProductByWorkCenterId(workCenterId: number): Promise<AreaSummary[]> {
    return await this.fetchSummaryList("findAllProductByWorkCenterId", PRODUCTS_PATH, {
      workCenterId: String(workCenterId),
    });
  }

  // ONE product, WITH its packages — the conversion basis for a quality entry.
  //
  // UNDEFINED RATHER THAN A THROW ON 404, because a product id that names nothing
  // is a bad request from the browser (a stale picker), not an upstream fault,
  // and the service turns it into a 400 naming the field. Every other status
  // still throws through `request`.
  async findProductById(productId: number): Promise<ProductDetail | undefined> {
    let body;
    try {
      body = await this.request(
        "findProductById",
        `${PRODUCTS_PATH}/${String(productId)}`,
        undefined,
        productDetailEnvelopeSchema,
      );
    } catch (err) {
      // A 404 is the ANSWER, not a failure — the same call existsWorkCenter
      // makes and for the same reason. Here it means the browser sent a product
      // id that names nothing, which is a stale picker rather than an upstream
      // fault, and the service turns it into a 400 naming the field. Every other
      // cause still propagates as a 502.
      if (err instanceof MasterDataError && err.status === 404) return undefined;
      throw err;
    }

    if (body.data === undefined || body.data === null) return undefined;

    const { id, code, name, packages } = body.data;
    return {
      id,
      code,
      name,
      // A PACKAGE WITHOUT A UOM CANNOT DENOMINATE A QUANTITY, so it is dropped
      // rather than offered — an option the operator could pick and the service
      // would then have to refuse. Dropping one package is not a reason to fail
      // the whole product: the others are still usable.
      packages: packages
        .filter((pkg) => pkg.uom !== null)
        .map(({ id: pkgId, main, sortOrder, factorToBase, uom }) => ({
          id: pkgId,
          main,
          sortOrder,
          factorToBase,
          uom,
        })),
    };
  }

  async findAllDowntimeAction(): Promise<DowntimeActionSummary[]> {
    const operation = "findAllDowntimeAction";
    const body = await this.request(
      operation,
      DOWNTIME_ACTIONS_PATH,
      { page: "1", size: String(IDS_PER_REQUEST) },
      pagedDowntimeActionListEnvelopeSchema,
    );

    this.warnIfTruncated(operation, body.meta?.totalPages ?? 1, body.data?.length ?? 0, {});

    return (body.data ?? []).map(({ id, code, name, color }) => ({ id, code, name, color }));
  }

  // The only write on this client.
  //
  // WHY THE RESPONSE IS RE-PROJECTED FROM THE REQUEST. Upstream answers a create
  // with `{ id }` alone. The caller needs the name — it is what lands in the
  // downtime's `actions[]` — so the alternative would be a follow-up GET to read
  // back three fields we just sent. Upstream stores them verbatim (no
  // normalisation, no defaulting), so the projection is exact; the day it starts
  // transforming them, this must become a read-back and not a guess.
  async createDowntimeAction(input: CreateDowntimeActionInput): Promise<DowntimeActionSummary> {
    const operation = "createDowntimeAction";
    const body = await this.request(
      operation,
      DOWNTIME_ACTIONS_PATH,
      undefined,
      createdIdEnvelopeSchema,
      input,
    );

    if (body.data === null) {
      throw this.fail(operation, "parse_error", "response carried no data");
    }

    return { id: body.data.id, code: input.code, name: input.name, color: input.color };
  }

  // Shared by the two list reads above. A list that outgrows one page is
  // REPORTED, never silently shortened — it is a picker's option set, so a short
  // one hides choices from the operator with no visible error anywhere.
  private warnIfTruncated(
    operation: string,
    totalPages: number,
    itemsReturned: number,
    query: Record<string, string>,
  ): void {
    if (totalPages <= 1) return;

    this.count(operation, "truncated");
    this.logger
      .withMetadata({
        event: "master_data_list_truncated",
        master_data_operation: operation,
        master_data_query: query,
        page_size: IDS_PER_REQUEST,
        total_pages: totalPages,
        items_returned: itemsReturned,
      })
      .warn("master_data_list_truncated");
  }

  // One page of options for a filter's select box — deliberately NOT a page walk
  // like findAllWorkUnitByWorkCenterId.
  //
  // These lists are small and bounded by the physical factory: upstream holds 3
  // areas and 13 work centers today, against a page size of 100. Walking pages
  // would trade ~30x headroom for up to 20 sequential round-trips every time a
  // dropdown opens, which is the worse failure of the two. mes-master-data's own
  // web app fetches these same two lists as a single page=1&size=100 call.
  //
  // A list that outgrows one page is reported, not silently shortened.
  private async fetchSummaryList(
    operation: string,
    path: string,
    query: Record<string, string> = {},
  ): Promise<AreaSummary[]> {
    const body = await this.request(
      operation,
      path,
      { ...query, page: "1", size: String(IDS_PER_REQUEST) },
      pagedSummaryListEnvelopeSchema,
    );

    const totalPages = body.meta?.totalPages ?? 1;
    if (totalPages > 1) {
      // Truncation must never be silent: this list IS a filter's option set, so a
      // short one hides choices from the user with no visible error anywhere.
      this.count(operation, "truncated");
      this.logger
        .withMetadata({
          event: "master_data_list_truncated",
          master_data_operation: operation,
          // Nested rather than spread: the filter's keys are upstream's camelCase
          // (`areaId`), and every other field in these payloads is snake_case.
          master_data_query: query,
          page_size: IDS_PER_REQUEST,
          total_pages: totalPages,
          items_returned: body.data?.length ?? 0,
        })
        .warn("master_data_list_truncated");
    }

    // Projected rather than passed through: `z.looseObject` KEEPS unknown keys,
    // and these rows carry upstream fields this service never contracted for
    // (siteId, region, oeeMode, createdAt...). Same reason
    // findAllWorkUnitByWorkUnitIds builds its own objects.
    return (body.data ?? []).map(({ id, code, name }) => ({ id, code, name }));
  }

  // The single place that knows about URLs, auth, timeouts, envelopes,
  // validation, retry and metrics.
  //
  // `body` is what makes this a POST. Absent -> GET, which is every read here.
  // A method parameter was considered and rejected: there is exactly one write,
  // and "has a body" is the only distinction it needs — a `method` string would
  // admit combinations (a GET with a body, a POST without one) that nothing here
  // means.
  private async request<T extends ZodType>(
    operation: string,
    path: string,
    query: Record<string, string> | undefined,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    const startedAt = Date.now();
    try {
      // `false` = first attempt. A 401/403 here means the cached token was
      // rejected, so drop it and try once more with a freshly minted one.
      //
      // SAFE FOR THE POST TOO, and this is the one place worth checking before
      // adding a second write. A 401/403 is refused at upstream's auth
      // middleware, BEFORE any handler runs, so nothing was created and the
      // retry cannot duplicate a row. That is not true of a 5xx or a timeout —
      // neither of which is retried here, deliberately.
      let res = await this.send(operation, url, false, body);
      if (res.status === 401 || res.status === 403) {
        this.tokenProvider.invalidate();
        res = await this.send(operation, url, true, body);
      }

      if (res.status === 401 || res.status === 403) {
        throw this.fail(operation, "auth_error", `upstream rejected the token`, res.status);
      }
      if (!res.ok) {
        throw this.fail(operation, "http_error", `upstream returned ${res.status}`, res.status);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        throw this.fail(operation, "parse_error", `response was not JSON: ${shortError(err)}`);
      }

      const parsed = z.safeParse(schema, json);
      if (!parsed.success) {
        throw this.fail(
          operation,
          "parse_error",
          `response did not match the expected shape: ${parsed.error.message}`,
        );
      }

      this.count(operation, "ok");
      return parsed.data;
    } finally {
      // Recorded for successes and failures alike — a timeout's duration is the
      // most interesting one.
      getMasterDataDurationHistogram().record(Date.now() - startedAt, { operation });
    }
  }

  private async send(
    operation: string,
    url: URL,
    isRetry = false,
    body?: unknown,
  ): Promise<Response> {
    const token = await this.tokenProvider.getToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          // Only on a write: a GET carrying Content-Type is at best noise and at
          // worst something a proxy decides to act on.
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Distinguishing these two matters operationally: a timeout points at
      // upstream latency, a network error at DNS, routing or a dead pod.
      if (controller.signal.aborted) {
        throw this.fail(
          operation,
          "timeout",
          `request timed out after ${this.timeoutMs}ms${isRetry ? " (on retry)" : ""}`,
        );
      }
      throw this.fail(operation, "network_error", shortError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  // Counting here rather than at each throw site guarantees no failure path can
  // return without incrementing the metric.
  private fail(
    operation: string,
    cause: Parameters<typeof buildError>[0]["cause"],
    message: string,
    status?: number,
  ): MasterDataError {
    this.count(operation, cause);
    return buildError({ cause, operation, message, status });
  }

  private count(operation: string, outcome: string): void {
    getMasterDataRequestsCounter().add(1, { operation, outcome });
  }
}

function buildError(options: ConstructorParameters<typeof MasterDataError>[0]): MasterDataError {
  return new MasterDataError(options);
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export { MasterDataClient, IDS_PER_REQUEST, MAX_WORK_UNIT_PAGES };
export type { MasterDataClientDeps };
