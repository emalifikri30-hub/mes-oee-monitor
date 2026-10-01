import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vite-plus/test";
import { setupServer } from "msw/node";
import { http, HttpResponse, delay } from "msw";

import { MasterDataClient, IDS_PER_REQUEST, MAX_WORK_UNIT_PAGES } from "./master-data-client.js";
import { MasterDataError } from "./master-data-error.js";
import { workUnitListEnvelopeSchema } from "./master-data-schema.js";
import fixture from "./fixtures/work-units-by-ids.json" with { type: "json" };

import type { Logger } from "@molca/utils";
import type { ServiceTokenProvider } from "@molca/mes";

const BASE = "http://master-data.test";
const WORK_UNITS = `${BASE}/v1/work-units`;
const WORK_CENTERS = `${BASE}/v1/work-centers`;
const AREAS = `${BASE}/v1/areas`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function fakeLogger() {
  const warn = vi.fn();
  const logger = { withMetadata: vi.fn(() => ({ warn })) } as unknown as Logger;
  return { logger, warn };
}

function fakeTokenProvider(tokens: string[] = ["tok-1", "tok-2", "tok-3"]) {
  let i = 0;
  const getToken = vi.fn(async () => tokens[Math.min(i, tokens.length - 1)]!);
  const invalidate = vi.fn(() => {
    i += 1;
  });
  return { getToken, invalidate } as unknown as ServiceTokenProvider & {
    getToken: typeof getToken;
    invalidate: typeof invalidate;
  };
}

function setup(overrides: { timeoutMs?: number; tokens?: string[] } = {}) {
  const tokenProvider = fakeTokenProvider(overrides.tokens);
  const { logger, warn } = fakeLogger();
  const client = new MasterDataClient({
    masterDataBaseUrl: BASE,
    masterDataTimeoutMs: overrides.timeoutMs ?? 5_000,
    serviceTokenProvider: tokenProvider,
    logger,
  });
  return { client, tokenProvider, warn };
}

// Records every inbound request so URL construction and auth headers can be
// asserted, not just the parsed result.
function record(url: string, responder: (attempt: number, req: Request) => unknown) {
  const seen: { url: URL; auth: string | null }[] = [];
  let attempt = 0;

  server.use(
    http.get(url, ({ request }) => {
      attempt += 1;
      seen.push({
        url: new URL(request.url),
        auth: request.headers.get("Authorization"),
      });
      return responder(attempt, request) as Response;
    }),
  );

  return {
    calls: () => seen.length,
    at: (i: number) => seen[i]!,
    last: () => seen[seen.length - 1]!,
  };
}

function envelope(data: unknown, meta?: Record<string, unknown>) {
  return HttpResponse.json({ data, ...(meta ? { meta } : {}), error: null });
}

function page(items: unknown[], pageNo: number, totalPages: number) {
  return envelope(items, {
    page: pageNo,
    size: IDS_PER_REQUEST,
    totalElements: totalPages * IDS_PER_REQUEST,
    totalPages,
    first: pageNo === 1,
    last: pageNo === totalPages,
  });
}

const unit = (id: number, workCenter: unknown = { id: 12, code: "WC-03", name: "Line 3" }) => ({
  id,
  code: `WU-${id}`,
  name: `Unit ${id}`,
  workCenter,
});

// `extra` stands in for the fields upstream actually sends and this service never
// contracted for — siteId, region, oeeMode, createdAt.
const summary = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  code: `C-${id}`,
  name: `Name ${id}`,
  ...extra,
});

async function causeOf(run: () => Promise<unknown>) {
  const err = await run().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MasterDataError);
  return err as MasterDataError;
}

describe("MasterDataClient — request plumbing", () => {
  it("sends the service token as a bearer header", async () => {
    const seen = record(WORK_UNITS, () => envelope([unit(1)]));
    const { client } = setup();

    await client.findAllWorkUnitByWorkUnitIds([1]);

    expect(seen.last().auth).toBe("Bearer tok-1");
  });

  it("builds ?ids= as a comma-separated list", async () => {
    const seen = record(WORK_UNITS, () => envelope([unit(1), unit(2)]));
    const { client } = setup();

    await client.findAllWorkUnitByWorkUnitIds([1, 2]);

    expect(seen.last().url.searchParams.get("ids")).toBe("1,2");
  });

  it("times out and reports the cause as timeout", async () => {
    record(WORK_UNITS, async () => {
      await delay(200);
      return envelope([]);
    });
    const { client } = setup({ timeoutMs: 20 });

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));
    expect(err.errorCause).toBe("timeout");
  });

  it("reports an unreachable upstream as network_error", async () => {
    record(WORK_UNITS, () => HttpResponse.error());
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));
    expect(err.errorCause).toBe("network_error");
  });

  it("reports a 500 as http_error carrying the status", async () => {
    record(WORK_UNITS, () => new HttpResponse(null, { status: 500 }));
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));
    expect(err.errorCause).toBe("http_error");
    expect(err.status).toBe(500);
  });

  it("reports a non-JSON body as parse_error", async () => {
    record(WORK_UNITS, () => new HttpResponse("<html>gateway</html>", { status: 200 }));
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));
    expect(err.errorCause).toBe("parse_error");
  });

  it("reports a shape mismatch as parse_error", async () => {
    // `id` as a string is exactly the drift the narrow schema exists to catch.
    record(WORK_UNITS, () => envelope([{ id: "44", code: "x", name: "y", workCenter: null }]));
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));
    expect(err.errorCause).toBe("parse_error");
  });

  it("carries the operation name on every error", async () => {
    record(WORK_UNITS, () => new HttpResponse(null, { status: 500 }));
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));
    expect(err.operation).toBe("findAllWorkUnitByWorkUnitIds");
    expect(err.toMetadata()).toMatchObject({
      master_data_operation: "findAllWorkUnitByWorkUnitIds",
      master_data_cause: "http_error",
      master_data_status: 500,
    });
  });
});

// A rotated client secret or a Keycloak signing-key roll leaves a cached token
// that upstream rejects. Without this path every request fails until the token
// expires naturally.
describe("MasterDataClient — 401 recovery", () => {
  it("invalidates the token and retries once on a 401", async () => {
    const seen = record(WORK_UNITS, (attempt) =>
      attempt === 1 ? new HttpResponse(null, { status: 401 }) : envelope([unit(1)]),
    );
    const { client, tokenProvider } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds([1]);

    expect(seen.calls()).toBe(2);
    expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(seen.at(0).auth).toBe("Bearer tok-1");
    expect(seen.at(1).auth).toBe("Bearer tok-2"); // a genuinely fresh token
    expect(result.found).toHaveLength(1);
  });

  it("treats a 403 the same way", async () => {
    const seen = record(WORK_UNITS, (attempt) =>
      attempt === 1 ? new HttpResponse(null, { status: 403 }) : envelope([unit(1)]),
    );
    const { client } = setup();

    await client.findAllWorkUnitByWorkUnitIds([1]);

    expect(seen.calls()).toBe(2);
  });

  it("gives up as auth_error when the retry is also rejected", async () => {
    const seen = record(WORK_UNITS, () => new HttpResponse(null, { status: 401 }));
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));

    expect(err.errorCause).toBe("auth_error");
    expect(err.status).toBe(401);
    // Exactly one retry — never a loop against a permanently rejecting upstream.
    expect(seen.calls()).toBe(2);
  });

  it("does not retry a non-auth failure", async () => {
    const seen = record(WORK_UNITS, () => new HttpResponse(null, { status: 500 }));
    const { client, tokenProvider } = setup();

    await causeOf(() => client.findAllWorkUnitByWorkUnitIds([1]));

    expect(seen.calls()).toBe(1);
    expect(tokenProvider.invalidate).not.toHaveBeenCalled();
  });
});

describe("MasterDataClient.findAllWorkUnitByWorkUnitIds", () => {
  it("makes NO request at all for an empty id list", async () => {
    const seen = record(WORK_UNITS, () => envelope([]));
    const { client, tokenProvider } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds([]);

    expect(result).toEqual({ found: [], missingIds: [] });
    expect(seen.calls()).toBe(0);
    expect(tokenProvider.getToken).not.toHaveBeenCalled();
  });

  it("deduplicates ids before requesting them", async () => {
    const seen = record(WORK_UNITS, () => envelope([unit(1)]));
    const { client } = setup();

    await client.findAllWorkUnitByWorkUnitIds([1, 1, 1]);

    expect(seen.last().url.searchParams.get("ids")).toBe("1");
  });

  it("reports ids the upstream did not return as missingIds", async () => {
    record(WORK_UNITS, () => envelope([unit(1), unit(3)]));
    const { client } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds([1, 2, 3, 4]);

    expect(result.found.map((w) => w.id)).toEqual([1, 3]);
    expect(result.missingIds).toEqual([2, 4]);
  });

  it("keeps a null workCenter as null rather than dropping the unit", async () => {
    record(WORK_UNITS, () => envelope([unit(1, null)]));
    const { client } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds([1]);

    expect(result.found[0]).toEqual({
      id: 1,
      code: "WU-1",
      name: "Unit 1",
      workCenter: null,
    });
  });

  it(`splits more than ${IDS_PER_REQUEST} ids across requests`, async () => {
    const ids = Array.from({ length: IDS_PER_REQUEST + 5 }, (_, i) => i + 1);
    const seen = record(WORK_UNITS, (attempt) =>
      envelope(attempt === 1 ? ids.slice(0, IDS_PER_REQUEST).map((i) => unit(i)) : [unit(101)]),
    );
    const { client } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds(ids);

    expect(seen.calls()).toBe(2);
    expect(seen.at(0).url.searchParams.get("ids")!.split(",")).toHaveLength(IDS_PER_REQUEST);
    expect(seen.at(1).url.searchParams.get("ids")!.split(",")).toHaveLength(5);
    expect(result.found).toHaveLength(IDS_PER_REQUEST + 1);
  });

  it("tolerates a null data field", async () => {
    record(WORK_UNITS, () => HttpResponse.json({ data: null, error: null }));
    const { client } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds([1]);

    expect(result).toEqual({ found: [], missingIds: [1] });
  });
});

describe("MasterDataClient.findAllWorkUnitByWorkCenterId", () => {
  // WHOLE ROWS, not bare ids. The OEE Performance dashboard's machine picker
  // renders `name`, and this method used to parse it and throw it away.
  it("returns the work units from a single page, with their labels", async () => {
    record(WORK_UNITS, () => page([unit(1), unit(2)], 1, 1));
    const { client } = setup();

    await expect(client.findAllWorkUnitByWorkCenterId(12)).resolves.toEqual([unit(1), unit(2)]);
  });

  it("scopes the request by workCenterId", async () => {
    const seen = record(WORK_UNITS, () => page([], 1, 1));
    const { client } = setup();

    await client.findAllWorkUnitByWorkCenterId(12);

    expect(seen.last().url.searchParams.get("workCenterId")).toBe("12");
    expect(seen.last().url.searchParams.get("size")).toBe(String(IDS_PER_REQUEST));
  });

  it("walks every page and concatenates the work units", async () => {
    const seen = record(WORK_UNITS, (attempt) => page([unit(attempt)], attempt, 3));
    const { client } = setup();

    const units = await client.findAllWorkUnitByWorkCenterId(12);

    expect(seen.calls()).toBe(3);
    expect(units).toEqual([unit(1), unit(2), unit(3)]);
    expect(seen.at(2).url.searchParams.get("page")).toBe("3");
  });

  it("returns an empty list for a work center with no units", async () => {
    record(WORK_UNITS, () => page([], 1, 0));
    const { client } = setup();

    await expect(client.findAllWorkUnitByWorkCenterId(12)).resolves.toEqual([]);
  });

  // Truncating the id list quietly shortens the report, so the cap must be both
  // counted and logged. This asserts the log; the counter is the same call site.
  it(`stops at ${MAX_WORK_UNIT_PAGES} pages and WARNs instead of looping`, async () => {
    const seen = record(WORK_UNITS, (attempt) => page([unit(attempt)], attempt, 9999));
    const { client, warn } = setup();

    const units = await client.findAllWorkUnitByWorkCenterId(12);

    expect(seen.calls()).toBe(MAX_WORK_UNIT_PAGES);
    expect(units).toHaveLength(MAX_WORK_UNIT_PAGES);
    expect(warn).toHaveBeenCalledWith("master_data_page_cap_reached");
  });

  it("does not warn when the pages end naturally", async () => {
    record(WORK_UNITS, () => page([unit(1)], 1, 1));
    const { client, warn } = setup();

    await client.findAllWorkUnitByWorkCenterId(12);

    expect(warn).not.toHaveBeenCalled();
  });

  it("propagates an upstream failure rather than returning a partial list", async () => {
    record(WORK_UNITS, (attempt) =>
      attempt === 1 ? page([unit(1)], 1, 2) : new HttpResponse(null, { status: 503 }),
    );
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkUnitByWorkCenterId(12));
    expect(err.errorCause).toBe("http_error");
  });
});

// These two are option sets for a filter, NOT datasets to walk. Every suite here
// asserts exactly one upstream call — that is the behaviour under test, because a
// page loop would turn opening a dropdown into up to 20 sequential round-trips.
describe("MasterDataClient.findAllArea", () => {
  it("asks for exactly one page at the upstream maximum", async () => {
    const seen = record(AREAS, () => page([summary(1)], 1, 1));
    const { client } = setup();

    await client.findAllArea();

    expect(seen.calls()).toBe(1);
    expect(seen.last().url.pathname).toBe("/v1/areas");
    expect(seen.last().url.searchParams.get("page")).toBe("1");
    expect(seen.last().url.searchParams.get("size")).toBe(String(IDS_PER_REQUEST));
  });

  it("returns the summaries", async () => {
    record(AREAS, () => page([summary(1), summary(2)], 1, 1));
    const { client } = setup();

    await expect(client.findAllArea()).resolves.toEqual([
      { id: 1, code: "C-1", name: "Name 1" },
      { id: 2, code: "C-2", name: "Name 2" },
    ]);
  });

  // The schema is `looseObject`, so unknown keys SURVIVE parsing — the projection
  // in fetchSummaryList is what stops them reaching the browser.
  it("drops upstream fields this service does not contract for", async () => {
    record(AREAS, () =>
      page([summary(1, { siteId: 4, region: "ID", createdAt: "2026-01-01T00:00:00Z" })], 1, 1),
    );
    const { client } = setup();

    const areas = await client.findAllArea();

    expect(areas).toEqual([{ id: 1, code: "C-1", name: "Name 1" }]);
    expect(Object.keys(areas[0]!)).toEqual(["id", "code", "name"]);
  });

  it("returns an empty list when upstream sends a null payload", async () => {
    record(AREAS, () => envelope(null));
    const { client } = setup();

    await expect(client.findAllArea()).resolves.toEqual([]);
  });

  // A short option list hides choices from the user with no visible error, so the
  // overflow has to be both counted and logged. This asserts the log; the counter
  // is the same call site.
  it("WARNs instead of paging when the list does not fit one page", async () => {
    const seen = record(AREAS, () => page([summary(1)], 1, 3));
    const { client, warn } = setup();

    const areas = await client.findAllArea();

    expect(seen.calls()).toBe(1);
    expect(areas).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("master_data_list_truncated");
  });

  it("does not warn when the whole list fits", async () => {
    record(AREAS, () => page([summary(1)], 1, 1));
    const { client, warn } = setup();

    await client.findAllArea();

    expect(warn).not.toHaveBeenCalled();
  });

  // `meta` is optional in the schema; its absence must read as "one page", not as
  // an overflow that warns on every call.
  it("treats a missing meta as a single page", async () => {
    record(AREAS, () => envelope([summary(1)]));
    const { client, warn } = setup();

    await expect(client.findAllArea()).resolves.toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("propagates an upstream failure rather than an empty list", async () => {
    record(AREAS, () => new HttpResponse(null, { status: 503 }));
    const { client } = setup();

    const err = await causeOf(() => client.findAllArea());
    expect(err.errorCause).toBe("http_error");
    expect(err.status).toBe(503);
  });

  it("fails loudly when the summary shape drifts", async () => {
    record(AREAS, () => envelope([{ id: 1, name: "Name 1" }]));
    const { client } = setup();

    const err = await causeOf(() => client.findAllArea());
    expect(err.errorCause).toBe("parse_error");
  });
});

describe("MasterDataClient.findAllWorkCenterByAreaId", () => {
  it("scopes the request by areaId and asks for one page", async () => {
    const seen = record(WORK_CENTERS, () => page([summary(1)], 1, 1));
    const { client } = setup();

    await client.findAllWorkCenterByAreaId(7);

    expect(seen.calls()).toBe(1);
    expect(seen.last().url.pathname).toBe("/v1/work-centers");
    expect(seen.last().url.searchParams.get("areaId")).toBe("7");
    expect(seen.last().url.searchParams.get("page")).toBe("1");
    expect(seen.last().url.searchParams.get("size")).toBe(String(IDS_PER_REQUEST));
  });

  it("returns the summaries", async () => {
    record(WORK_CENTERS, () => page([summary(13, { oeeMode: "AUTO", areaId: 7 })], 1, 1));
    const { client } = setup();

    await expect(client.findAllWorkCenterByAreaId(7)).resolves.toEqual([
      { id: 13, code: "C-13", name: "Name 13" },
    ]);
  });

  // An area with no lines is an empty option list, not a failure — and upstream
  // answers an unknown areaId the same way, so neither can become a 404 here.
  it("returns an empty list for an area with no work centers", async () => {
    record(WORK_CENTERS, () => page([], 1, 0));
    const { client } = setup();

    await expect(client.findAllWorkCenterByAreaId(999)).resolves.toEqual([]);
  });

  it("WARNs instead of paging when the list does not fit one page", async () => {
    const seen = record(WORK_CENTERS, () => page([summary(1)], 1, 5));
    const { client, warn } = setup();

    await client.findAllWorkCenterByAreaId(7);

    expect(seen.calls()).toBe(1);
    expect(warn).toHaveBeenCalledWith("master_data_list_truncated");
  });

  it("propagates an upstream failure rather than an empty list", async () => {
    record(WORK_CENTERS, () => new HttpResponse(null, { status: 500 }));
    const { client } = setup();

    const err = await causeOf(() => client.findAllWorkCenterByAreaId(7));
    expect(err.errorCause).toBe("http_error");
  });
});

describe("MasterDataClient.existsWorkCenter", () => {
  it("is true when the work center is found", async () => {
    record(`${WORK_CENTERS}/:id`, () => envelope({ id: 12, code: "WC-03", name: "Line 3" }));
    const { client } = setup();

    await expect(client.existsWorkCenter(12)).resolves.toBe(true);
  });

  // A 404 is the ANSWER here, not a failure — it is how upstream says "no such
  // work center", which is what turns an empty report into a 404 for the user.
  it("is false on a 404 rather than throwing", async () => {
    record(`${WORK_CENTERS}/:id`, () => new HttpResponse(null, { status: 404 }));
    const { client } = setup();

    await expect(client.existsWorkCenter(999)).resolves.toBe(false);
  });

  it("still throws on a 500", async () => {
    record(`${WORK_CENTERS}/:id`, () => new HttpResponse(null, { status: 500 }));
    const { client } = setup();

    const err = await causeOf(() => client.existsWorkCenter(12));
    expect(err.errorCause).toBe("http_error");
  });

  it("requests the work center by id", async () => {
    const seen = record(`${WORK_CENTERS}/:id`, () => envelope({ id: 7, code: "c", name: "n" }));
    const { client } = setup();

    await client.existsWorkCenter(7);

    expect(seen.last().url.pathname).toBe("/v1/work-centers/7");
  });
});

// Guards the contract between the two repos. If mes-master-data changes the
// work-unit payload, refresh the fixture from a real response — if this then
// fails, the client needs updating too.
describe("mes-master-data response fixture", () => {
  it("parses against the narrow schema", () => {
    const parsed = workUnitListEnvelopeSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
  });

  it("survives fields this service does not read", async () => {
    record(WORK_UNITS, () => HttpResponse.json(fixture));
    const { client } = setup();

    const result = await client.findAllWorkUnitByWorkUnitIds([44, 45, 46]);

    // position / telemetryTags / class / region / createdAt are all discarded.
    expect(result.found).toEqual([
      {
        id: 44,
        code: "WU-P1",
        name: "Molca Packer P",
        workCenter: { id: 12, code: "WC-03", name: "Molca Line 3" },
      },
      {
        id: 45,
        code: "WU-P2",
        name: "Molca Filler F",
        workCenter: { id: 12, code: "WC-03", name: "Molca Line 3" },
      },
      { id: 46, code: "WU-S1", name: "Molca Store S", workCenter: null },
    ]);
    expect(result.missingIds).toEqual([]);
  });
});

describe("MasterDataClient.findTimeZoneByScope", () => {
  const zone = (extra: Record<string, unknown> = {}) => ({
    siteId: 1,
    siteCode: "PLANT-A",
    timezone: "Asia/Jakarta",
    ...extra,
  });

  it("reads the work-unit sub-resource with a bearer token", async () => {
    const seen = record(`${WORK_UNITS}/42/timezone`, () => envelope(zone()));
    const { client } = setup();

    await client.findTimeZoneByScope("work-unit", 42);

    expect(seen.last().url.pathname).toBe("/v1/work-units/42/timezone");
    expect(seen.last().auth).toBe("Bearer tok-1");
  });

  it("reads the work-center sub-resource for the other scope", async () => {
    const seen = record(`${WORK_CENTERS}/7/timezone`, () => envelope(zone()));
    const { client } = setup();

    await client.findTimeZoneByScope("work-center", 7);

    expect(seen.last().url.pathname).toBe("/v1/work-centers/7/timezone");
  });

  it("projects only the three fields it contracted for", async () => {
    record(`${WORK_UNITS}/42/timezone`, () =>
      envelope(zone({ region: "ap3", createdAt: "2026-01-01T00:00:00Z" })),
    );
    const { client } = setup();

    const result = await client.findTimeZoneByScope("work-unit", 42);

    expect(result).toEqual({ siteId: 1, siteCode: "PLANT-A", timezone: "Asia/Jakarta" });
  });

  // The status has to survive: the resolver maps a 404 to a 404 and everything
  // else to a 503, because only one of the two is worth retrying.
  it("preserves a 404 as the status on the error", async () => {
    record(`${WORK_UNITS}/999999/timezone`, () => new HttpResponse(null, { status: 404 }));
    const { client } = setup();

    const err = await causeOf(() => client.findTimeZoneByScope("work-unit", 999999));

    expect(err.errorCause).toBe("http_error");
    expect(err.status).toBe(404);
  });

  // Upstream's sites.timezone is a plain varchar with no CHECK, so "WIB" is
  // writable there. Catching it here keeps it out of Postgres' AT TIME ZONE,
  // where it would become a 500 instead of an ordinary upstream failure.
  it("rejects a zone the IANA database does not know", async () => {
    record(`${WORK_UNITS}/42/timezone`, () => envelope(zone({ timezone: "WIB" })));
    const { client } = setup();

    const err = await causeOf(() => client.findTimeZoneByScope("work-unit", 42));

    expect(err.errorCause).toBe("parse_error");
  });

  it.for([
    ["a missing timezone", { siteId: 1, siteCode: "PLANT-A" }],
    ["a non-numeric siteId", { siteId: "1", siteCode: "PLANT-A", timezone: "Asia/Jakarta" }],
  ])("rejects %s as a parse error", async ([, payload]) => {
    record(`${WORK_UNITS}/42/timezone`, () => envelope(payload));
    const { client } = setup();

    const err = await causeOf(() => client.findTimeZoneByScope("work-unit", 42));

    expect(err.errorCause).toBe("parse_error");
  });

  // `data: null` parses against the envelope, so without an explicit guard it
  // would reach the resolver as `undefined.timezone`.
  it("rejects an envelope carrying no data", async () => {
    record(`${WORK_UNITS}/42/timezone`, () => envelope(null));
    const { client } = setup();

    const err = await causeOf(() => client.findTimeZoneByScope("work-unit", 42));

    expect(err.errorCause).toBe("parse_error");
  });

  it("reports a 500 as an http error", async () => {
    record(`${WORK_UNITS}/42/timezone`, () => new HttpResponse(null, { status: 500 }));
    const { client } = setup();

    const err = await causeOf(() => client.findTimeZoneByScope("work-unit", 42));

    expect(err.errorCause).toBe("http_error");
    expect(err.status).toBe(500);
  });
});
