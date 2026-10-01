import { describe, it, expect, vi } from "vite-plus/test";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { createDowntimeHandler } from "./downtime-handler.js";

import type { AuthEnv, AuthMiddleware } from "@molca/mes";
import type { TDowntimeTimelineService } from "./downtime-service.js";

const TIMELINE = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-09T08:00:00.000Z"),
  timeZone: "Asia/Jakarta",
  segments: [],
};

// Auth itself is covered by @molca/mes's own tests; this only has to let the
// request through so query parsing and the envelope can be asserted.
const passthroughAuth = createMiddleware<AuthEnv>(async (c, next) => {
  c.set("jwtPayload", { sub: "u1" });
  await next();
});

const rejectingAuth = createMiddleware<AuthEnv>(async (c) =>
  c.json({ error: "invalid token" }, 401),
);

const PAGE_META = {
  page: 1,
  size: 5,
  totalElements: 50,
  totalPages: 10,
  first: true,
  last: false,
};

// One reason bucket plus its totals, enough for the handler to prove it returns
// the service's answer inside the envelope. The shapes are asserted properly in
// the service and repository tests.
const BREAKDOWN = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-09T08:00:00.000Z"),
  timeZone: "Asia/Jakarta",
  category: "UNPLANNED" as const,
  buckets: [{ reason: "Mlipit", workUnitNames: ["Packer"], frequency: 3, durationMs: 2_844_000 }],
  totalFrequency: 3,
  totalDurationMs: 2_844_000,
  loadedThrough: "2026-08-10",
};

// The drill-down's payload: the SAME bucket shape as BREAKDOWN carries, plus the
// records inside it. Identical shape is the point — see the reconciliation test
// in downtime-repository.integration.test.ts.
const REASON_DETAIL = {
  from: new Date("2026-08-09T00:00:00.000Z"),
  to: new Date("2026-08-09T08:00:00.000Z"),
  timeZone: "Asia/Jakarta",
  category: "UNPLANNED" as const,
  bucket: { reason: "Mlipit", workUnitNames: ["Packer"], frequency: 3, durationMs: 2_844_000 },
  items: [],
  loadedThrough: "2026-08-10",
};

const REASON_HISTORY = { entries: [], totalMembers: 2, trackedMembers: 0 };

// The four editable fields, in the shape the body carries them. Reused as both
// halves of a request so a test only has to state what it is changing.
const EDIT = {
  category: "UNPLANNED",
  reason: ["Machine_Stop"],
  detailReason: "belt slipped",
  actions: ["Realigned"],
};

const EDIT_RESULT = { item: { id: 7, sourceEventId: "evt-1" }, changed: ["category"] };

function setup(authMw: AuthMiddleware = passthroughAuth as AuthMiddleware) {
  const getTimeline = vi.fn().mockResolvedValue(TIMELINE);
  const getPagedDowntime = vi.fn().mockResolvedValue({ items: [], meta: PAGE_META });
  const getReasonBreakdown = vi.fn().mockResolvedValue(BREAKDOWN);
  // The action breakdown is BREAKDOWN without its category — see
  // DowntimeActionBreakdown for why the two payloads are otherwise identical.
  const getActionBreakdown = vi.fn().mockResolvedValue(BREAKDOWN);
  const getReasonDetail = vi.fn().mockResolvedValue({ detail: REASON_DETAIL, meta: PAGE_META });
  const getReasonHistory = vi.fn().mockResolvedValue(REASON_HISTORY);
  const editDowntime = vi.fn().mockResolvedValue(EDIT_RESULT);

  const app = createDowntimeHandler({
    downtimeTimelineService: {
      getTimeline,
      getPagedDowntime,
      getReasonBreakdown,
      getActionBreakdown,
      getReasonDetail,
      getReasonHistory,
      editDowntime,
    } satisfies Record<keyof TDowntimeTimelineService, ReturnType<typeof vi.fn>>,
    authMw,
  });

  // The handler throws HTTPException directly; the real app.onError maps it.
  // Reproduced here so status assertions reflect what a client actually sees.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: "internal" }, 500);
  });

  return {
    app,
    getTimeline,
    getPagedDowntime,
    getReasonBreakdown,
    getActionBreakdown,
    getReasonDetail,
    getReasonHistory,
    editDowntime,
  };
}

// A PATCH with a JSON body and its Content-Type. jsonValidator REJECTS a request
// without the header — which is what makes the approve route bodyless — so
// omitting it here would 4xx for a reason that has nothing to do with the body.
function patch(id: string, body: unknown): Request {
  return new Request(`http://local/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OK = "/timeline?scope=work-unit&scopeId=42&date=2026-08-09&shift=1";

describe("GET /timeline", () => {
  it("T-H1: answers with the WebResponse envelope and the parsed query", async () => {
    const { app, getTimeline } = setup();

    const res = await app.request(OK);

    expect(res.status).toBe(200);
    expect(getTimeline).toHaveBeenCalledWith({
      scope: "work-unit",
      scopeId: 42,
      // Defaulted by the schema — no caller sends it, and every shift-grain
      // request must keep behaving exactly as it did before `grain` existed.
      grain: "shift",
      date: "2026-08-09",
      shift: "1",
    });

    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.timeZone).toBe("Asia/Jakarta");
  });

  it("T-H1: serves work-center scope too", async () => {
    const { app, getTimeline } = setup();

    const res = await app.request("/timeline?scope=work-center&scopeId=7&date=2026-08-09&shift=3");

    expect(res.status).toBe(200);
    expect(getTimeline).toHaveBeenCalledWith(expect.objectContaining({ scope: "work-center" }));
  });

  // AND AREA, for the Area report's timeline strip. oee.downtime_reports has
  // carried `area_id` since migration 0007 — 0007's own COMMENT recorded that it
  // was "NOT yet accepted by SCOPE_COLUMN", which stopped being true when the
  // Area report shipped.
  it("T-H1b: serves area scope too", async () => {
    const { app, getTimeline } = setup();

    const res = await app.request("/timeline?scope=area&scopeId=2&date=2026-08-09&shift=3");

    expect(res.status).toBe(200);
    expect(getTimeline).toHaveBeenCalledWith(expect.objectContaining({ scope: "area" }));
  });

  // `factory` is in the contract and still not served — there is no factory_id
  // column on oee.downtime_reports, so SCOPE_COLUMN cannot map it. A 400 naming
  // the limitation beats a 200 with a silently empty timeline.
  //
  // ONE SCOPE HERE, NOT TWO. This was `it.each(["area", "factory"])` until the
  // Area report shipped; `area` moved up to the serving case above rather than
  // being deleted from this list, because a scope silently dropping out of a
  // rejection list is how one comes to be neither served nor refused.
  it("T-H4: rejects factory scope with a 400", async () => {
    const { app, getTimeline } = setup();

    const res = await app.request(`/timeline?scope=factory&scopeId=1&date=2026-08-09&shift=1`);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not supported yet") });
    expect(getTimeline).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown scope", "/timeline?scope=cell&scopeId=1&date=2026-08-09&shift=1"],
    ["missing scopeId", "/timeline?scope=work-unit&date=2026-08-09&shift=1"],
    ["non-numeric scopeId", "/timeline?scope=work-unit&scopeId=abc&date=2026-08-09&shift=1"],
    ["zero scopeId", "/timeline?scope=work-unit&scopeId=0&date=2026-08-09&shift=1"],
    ["malformed date", "/timeline?scope=work-unit&scopeId=1&date=09-08-2026&shift=1"],
    ["missing date", "/timeline?scope=work-unit&scopeId=1&shift=1"],
    ["unknown shift", "/timeline?scope=work-unit&scopeId=1&date=2026-08-09&shift=4"],
    ["missing shift", "/timeline?scope=work-unit&scopeId=1&date=2026-08-09"],
  ])("T-H2: rejects %s with a 400", async (_label, url) => {
    const { app, getTimeline } = setup();

    const res = await app.request(url);

    expect(res.status).toBe(400);
    expect(getTimeline).not.toHaveBeenCalled();
  });

  it("T-H3: rejects an unauthenticated request before touching the service", async () => {
    const { app, getTimeline } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request(OK);

    expect(res.status).toBe(401);
    expect(getTimeline).not.toHaveBeenCalled();
  });
});

const LIST_OK = "/?scope=work-unit&scopeId=42&date=2026-08-09&shift=1";

describe("GET / (downtime list)", () => {
  it("answers with the paged envelope, meta carrying the frequency count", async () => {
    const { app } = setup();

    const res = await app.request(LIST_OK);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toEqual([]);
    // The card renders meta.totalElements as "Downtime Frequency".
    expect(body.meta.totalElements).toBe(50);
  });

  it("applies the shared pagination defaults and sorts newest first", async () => {
    const { app, getPagedDowntime } = setup();

    await app.request(LIST_OK);

    expect(getPagedDowntime).toHaveBeenCalledWith(
      1,
      10,
      { scope: "work-unit", scopeId: 42, grain: "shift", date: "2026-08-09", shift: "1" },
      { sortBy: "startAt", sortDir: "desc" },
    );
  });

  it("passes paging and sorting through", async () => {
    const { app, getPagedDowntime } = setup();

    await app.request(`${LIST_OK}&page=3&size=5&sortBy=duration&sortDir=asc`);

    expect(getPagedDowntime).toHaveBeenCalledWith(3, 5, expect.any(Object), {
      sortBy: "duration",
      sortDir: "asc",
    });
  });

  it.each([
    ["unsortable column", `${LIST_OK}&sortBy=reason`],
    ["injected column", `${LIST_OK}&sortBy=id;drop`],
    ["unknown direction", `${LIST_OK}&sortDir=sideways`],
    ["size over the cap", `${LIST_OK}&size=500`],
    ["zero page", `${LIST_OK}&page=0`],
  ])("rejects %s with a 400", async (_label, url) => {
    const { app, getPagedDowntime } = setup();

    const res = await app.request(url);

    expect(res.status).toBe(400);
    expect(getPagedDowntime).not.toHaveBeenCalled();
  });

  // The same guard as /timeline, shared so the two routes cannot disagree — which
  // is also why `area` moved from refused to served on both at once.
  it("serves area scope, for the Area report's Downtime Details table", async () => {
    const { app, getPagedDowntime } = setup();

    const res = await app.request("/?scope=area&scopeId=2&date=2026-08-09&shift=1");

    expect(res.status).toBe(200);
    expect(getPagedDowntime).toHaveBeenCalledWith(
      1,
      10,
      expect.objectContaining({ scope: "area", scopeId: 2 }),
      expect.anything(),
    );
  });

  it("rejects factory scope with a 400", async () => {
    const { app, getPagedDowntime } = setup();

    const res = await app.request(`/?scope=factory&scopeId=1&date=2026-08-09&shift=1`);

    expect(res.status).toBe(400);
    expect(getPagedDowntime).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    const { app, getPagedDowntime } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request(LIST_OK);

    expect(res.status).toBe(401);
    expect(getPagedDowntime).not.toHaveBeenCalled();
  });
});

describe("GET /by-action", () => {
  const BY_ACTION_OK = "/by-action?scope=work-unit&scopeId=42&date=2026-08-09&shift=1";

  it("answers with the WebResponse envelope and the parsed query", async () => {
    const { app, getActionBreakdown } = setup();

    const res = await app.request(BY_ACTION_OK);

    expect(res.status).toBe(200);
    expect(getActionBreakdown).toHaveBeenCalledWith({
      scope: "work-unit",
      scopeId: 42,
      grain: "shift",
      date: "2026-08-09",
      shift: "1",
      measure: "duration",
      limit: 20,
    });
  });

  // THE DIFFERENCE BETWEEN THE TWO PARETOS, pinned at the contract boundary. An
  // action is what somebody DID about a stop, and "Replace Belt" is the same
  // action whether the stop was planned or not — so this route takes no category,
  // and one supplied must not reach the service as a silent filter.
  it("takes NO category, and ignores one a caller supplies", async () => {
    const { app, getActionBreakdown } = setup();

    const res = await app.request(`${BY_ACTION_OK}&category=PLANNED`);

    expect(res.status).toBe(200);
    expect(getActionBreakdown).toHaveBeenCalledWith(
      expect.not.objectContaining({ category: expect.anything() }),
    );
  });

  it("carries the measure and limit through when given", async () => {
    const { app, getActionBreakdown } = setup();

    await app.request(`${BY_ACTION_OK}&measure=frequency&limit=5`);

    expect(getActionBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ measure: "frequency", limit: 5 }),
    );
  });

  it.each([
    ["an unsupported scope", "/by-action?scope=factory&scopeId=1&date=2026-08-09&shift=1"],
    ["a shift grain with no shift", "/by-action?scope=work-unit&scopeId=42&date=2026-08-09"],
    ["a limit above the cap", `${BY_ACTION_OK}&limit=500`],
  ])("400s %s", async (_label, url) => {
    const { app, getActionBreakdown } = setup();

    const res = await app.request(url);

    expect(res.status).toBe(400);
    expect(getActionBreakdown).not.toHaveBeenCalled();
  });
});

describe("GET /by-reason", () => {
  const BY_REASON_OK = "/by-reason?scope=work-unit&scopeId=42&date=2026-08-09&shift=1";

  it("answers with the WebResponse envelope and the parsed query", async () => {
    const { app, getReasonBreakdown } = setup();

    const res = await app.request(BY_REASON_OK);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { category: "UNPLANNED" } });
    expect(getReasonBreakdown).toHaveBeenCalledWith({
      scope: "work-unit",
      scopeId: 42,
      grain: "shift",
      date: "2026-08-09",
      shift: "1",
      category: "UNPLANNED",
      // Both defaulted by the schema. Asserted in the EXACT call rather than only
      // in the two cases below, so a knob added later cannot reach the service
      // undeclared.
      measure: "duration",
      limit: 20,
    });
  });

  // Availability loss is UNPLANNED and only UNPLANNED: PLANNED time is
  // subtracted from planned production time rather than lost against it, and
  // SMALL_STOP is its own enum value the availability tab must not absorb. This
  // is where that decision is pinned at the contract boundary.
  it("defaults the category to UNPLANNED when the caller omits it", async () => {
    const { app, getReasonBreakdown } = setup();

    await app.request(BY_REASON_OK);

    expect(getReasonBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ category: "UNPLANNED" }),
    );
  });

  it.each(["PLANNED", "SMALL_STOP"])("accepts %s as an explicit category", async (category) => {
    const { app, getReasonBreakdown } = setup();

    const res = await app.request(`${BY_REASON_OK}&category=${category}`);

    expect(res.status).toBe(200);
    expect(getReasonBreakdown).toHaveBeenCalledWith(expect.objectContaining({ category }));
  });

  // Unpaged and unsorted by design: the browser holds the whole response and
  // re-ranks for its own measure toggle, so these parameters do not exist.
  // Sending them must not silently change the answer.
  it.each([
    ["unknown category", `${BY_REASON_OK}&category=RUN_TIME`],
    // The enum values are SQL-facing, so case matters.
    ["lowercased category", `${BY_REASON_OK}&category=unplanned`],
    ["missing scopeId", "/by-reason?scope=work-unit&date=2026-08-09&shift=1"],
    ["non-numeric scopeId", "/by-reason?scope=work-unit&scopeId=abc&date=2026-08-09&shift=1"],
    ["zero scopeId", "/by-reason?scope=work-unit&scopeId=0&date=2026-08-09&shift=1"],
    ["malformed date", "/by-reason?scope=work-unit&scopeId=1&date=09-08-2026&shift=1"],
    ["missing date", "/by-reason?scope=work-unit&scopeId=1&shift=1"],
    ["unknown shift", "/by-reason?scope=work-unit&scopeId=1&date=2026-08-09&shift=4"],
    ["missing shift", "/by-reason?scope=work-unit&scopeId=1&date=2026-08-09"],
  ])("rejects %s with a 400", async (_label, url) => {
    const { app, getReasonBreakdown } = setup();

    const res = await app.request(url);

    expect(res.status).toBe(400);
    expect(getReasonBreakdown).not.toHaveBeenCalled();
  });

  // NOW THE SAME TWO SCOPES AS ITS SIBLINGS. This endpoint used to admit
  // work-unit alone, from the schema rather than from requireSupported, because
  // it was unpaged and the browser held the whole response — bounded at one
  // machine over one shift and unbounded above it. It is truncated now
  // (`limit` + an "Other" tail), so the reason for the narrowing is gone.
  it("accepts work-center scope, for the Line report's Losses screen", async () => {
    const { app, getReasonBreakdown } = setup();

    const res = await app.request("/by-reason?scope=work-center&scopeId=7&date=2026-08-09&shift=1");

    expect(res.status).toBe(200);
    expect(getReasonBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "work-center", scopeId: 7 }),
    );
  });

  // AND AREA, for the Area report's Losses screen. TODOS.md §25 held the wide
  // scopes back on COST and named four changes that had to land together first — a
  // server-side LIMIT, an "Other" tail bucket, server-side ranking and a paged
  // drill-down. All four shipped with the line grain, which is why this is a
  // widening rather than a re-opening of that question.
  it("accepts area scope, for the Area report's Losses screen", async () => {
    const { app, getReasonBreakdown } = setup();

    const res = await app.request("/by-reason?scope=area&scopeId=2&date=2026-08-09&shift=1");

    expect(res.status).toBe(200);
    expect(getReasonBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "area", scopeId: 2 }),
    );
  });

  // `factory` is still refused, and now by requireSupported rather than by the
  // schema — oee.downtime_reports has no factory_id, so SCOPE_COLUMN cannot map
  // it. Same 400 as the two sibling routes give.
  it("rejects factory scope with a 400", async () => {
    const { app, getReasonBreakdown } = setup();

    const res = await app.request(`/by-reason?scope=factory&scopeId=7&date=2026-08-09&shift=1`);

    expect(res.status).toBe(400);
    expect(getReasonBreakdown).not.toHaveBeenCalled();
  });

  // THE TWO KNOBS THAT DECIDE WHAT COMES BACK, defaulted so every shipped caller
  // is unaffected.
  it("defaults the ranking measure and the limit", async () => {
    const { app, getReasonBreakdown } = setup();

    await app.request(BY_REASON_OK);

    expect(getReasonBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ measure: "duration", limit: 20 }),
    );
  });

  it("forwards an explicit measure and limit", async () => {
    const { app, getReasonBreakdown } = setup();

    await app.request(`${BY_REASON_OK}&measure=frequency&limit=5`);

    expect(getReasonBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ measure: "frequency", limit: 5 }),
    );
  });

  // Capped, not clamped: a caller asking for 5000 is asking for the unpaged
  // endpoint this replaced, and a silent clamp would answer a different question
  // than the one asked.
  it.each([
    ["an unknown measure", `${BY_REASON_OK}&measure=quantity`],
    ["a limit above the cap", `${BY_REASON_OK}&limit=5000`],
    ["a zero limit", `${BY_REASON_OK}&limit=0`],
  ])("rejects %s with a 400", async (_label, url) => {
    const { app, getReasonBreakdown } = setup();

    expect((await app.request(url)).status).toBe(400);
    expect(getReasonBreakdown).not.toHaveBeenCalled();
  });

  it("requires auth before touching the service", async () => {
    const { app, getReasonBreakdown } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request(BY_REASON_OK);

    expect(res.status).toBe(401);
    expect(getReasonBreakdown).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /by-reason/detail — the per-reason drill-down.
//
// The one thing worth testing hardest at this layer is the SELECTOR. `reason`
// and `unlabelled` are two params expressing one choice, and the schema is the
// only thing standing between a mistyped link and an endpoint that quietly
// answers a different question. TODOS.md §27.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /by-reason/detail", () => {
  const BASE = "/by-reason/detail?scope=work-unit&scopeId=3&date=2026-08-09&shift=1";

  it("passes a labelled selector through and returns the envelope with paging meta", async () => {
    const { app, getReasonDetail } = setup();

    const res = await app.request(`${BASE}&reason=Mlipit`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown; meta: unknown };
    expect(body.data).toMatchObject({ bucket: { reason: "Mlipit" } });
    expect(body.meta).toMatchObject({ page: 1, totalPages: 10 });

    expect(getReasonDetail).toHaveBeenCalledWith(
      1,
      10,
      expect.objectContaining({ selector: { kind: "labelled", reason: "Mlipit" } }),
    );
  });

  // The unlabelled bucket is `reason IS NULL` in SQL. It must NOT arrive as the
  // browser's "Unspecified" label, which a genuine reason of that text would
  // collide with.
  it("maps unlabelled=true to the null-reason selector, not to a label", async () => {
    const { app, getReasonDetail } = setup();

    const res = await app.request(`${BASE}&unlabelled=true`);
    expect(res.status).toBe(200);
    expect(getReasonDetail).toHaveBeenCalledWith(
      1,
      10,
      expect.objectContaining({ selector: { kind: "unlabelled" } }),
    );
  });

  it("defaults to UNPLANNED and oldest-first, the order a shift is reconstructed in", async () => {
    const { app, getReasonDetail } = setup();

    await app.request(`${BASE}&reason=Mlipit`);
    expect(getReasonDetail).toHaveBeenCalledWith(
      1,
      10,
      expect.objectContaining({ category: "UNPLANNED", sortBy: "startAt", sortDir: "asc" }),
    );
  });

  it.each([
    ["neither selector", BASE],
    ["both selectors", `${BASE}&reason=Mlipit&unlabelled=true`],
    ["an empty reason", `${BASE}&reason=`],
    ["unlabelled=false alone", `${BASE}&unlabelled=false`],
    ["a truthy-looking unlabelled", `${BASE}&unlabelled=1`],
    [
      "a scope the breakdown cannot serve",
      `/by-reason/detail?scope=factory&scopeId=1&date=2026-08-09&shift=1&reason=X`,
    ],
    ["a bad shift", `/by-reason/detail?scope=work-unit&scopeId=3&date=2026-08-09&shift=4&reason=X`],
    ["a bad date", `/by-reason/detail?scope=work-unit&scopeId=3&date=09-08-2026&shift=1&reason=X`],
  ])("rejects %s with 400 and never reaches the service", async (_label, url) => {
    const { app, getReasonDetail } = setup();

    const res = await app.request(url);
    expect(res.status).toBe(400);
    expect(getReasonDetail).not.toHaveBeenCalled();
  });

  it("requires a token", async () => {
    const { app, getReasonDetail } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request(`${BASE}&reason=Mlipit`)).status).toBe(401);
    expect(getReasonDetail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /by-reason/history — the Changes History panel.
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /by-reason/history", () => {
  const BASE = "/by-reason/history?scope=work-unit&scopeId=3&date=2026-08-09&shift=1";

  // The distinction the whole payload exists for: an empty `entries` means
  // "nothing was edited" ONLY when something could have been. With
  // trackedMembers 0 it means "these stops cannot be tracked at all", which is
  // every stop until the DAG writes source_event_id.
  it("reports trackedMembers alongside the entries, so empty is not ambiguous", async () => {
    const { app } = setup();

    const res = await app.request(`${BASE}&reason=Mlipit`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown };
    expect(body.data).toEqual({ entries: [], totalMembers: 2, trackedMembers: 0 });
  });

  it("takes the same selector rules as the detail route", async () => {
    const { app, getReasonHistory } = setup();

    await app.request(`${BASE}&unlabelled=true`);
    expect(getReasonHistory).toHaveBeenCalledWith(
      expect.objectContaining({ selector: { kind: "unlabelled" } }),
    );

    const bad = await app.request(BASE);
    expect(bad.status).toBe(400);
  });

  it("requires a token", async () => {
    const { app, getReasonHistory } = setup(rejectingAuth as AuthMiddleware);

    expect((await app.request(`${BASE}&reason=Mlipit`)).status).toBe(401);
    expect(getReasonHistory).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /:sourceEventId — the edit route
// ─────────────────────────────────────────────────────────────────────────────
//
// What these tests can and cannot reach. The route's whole job is to decode the
// path segment, validate the body, extract the actor and hand four values over,
// so that is what is asserted here. The DIFF, the freeze and the concurrency
// guard live in the service and the repository and are tested there — a handler
// test that stubbed the service could only assert its own stub.
describe("PATCH /:sourceEventId", () => {
  it("passes the id, both halves of the body and the actor to the service", async () => {
    const { app, editDowntime } = setup();

    const res = await app.request(patch("evt-1", { next: EDIT, baseline: EDIT }));

    expect(res.status).toBe(200);
    expect(editDowntime).toHaveBeenCalledWith({
      sourceEventId: "evt-1",
      next: EDIT,
      baseline: EDIT,
      // `sub` off the token, never a body field — a client must not be able to
      // name who made an edit.
      // roles is part of Actor now (TODOS.md §34) and this assertion is an
      // exact match, so the empty array is the shape a token with no
      // realm_access produces — not a placeholder.
      actor: { subject: "u1", name: null, roles: [] },
    });
    // No `meta`: the envelope omits it for an unpaged response, unlike the
    // list routes above.
    expect(await res.json()).toEqual({ data: EDIT_RESULT, error: null });
  });

  // The stop's public identity is free text from Silver, so the path segment
  // arrives percent-encoded. Decoding it wrong would address a different row —
  // or, more likely, no row at all, which 404s and looks like a missing stop.
  it("percent-decodes the id", async () => {
    const { app, editDowntime } = setup();

    await app.request(patch(encodeURIComponent("evt 1/a"), { next: EDIT, baseline: EDIT }));

    expect(editDowntime).toHaveBeenCalledWith(
      expect.objectContaining({ sourceEventId: "evt 1/a" }),
    );
  });

  // A whitespace-only segment would otherwise reach the repository as a value
  // matching no row, and 404 — the same answer as a genuinely unknown id, for a
  // completely different reason.
  it("400s a blank id without reaching the service", async () => {
    const { app, editDowntime } = setup();

    const res = await app.request(patch("%20%20", { next: EDIT, baseline: EDIT }));

    expect(res.status).toBe(400);
    expect(editDowntime).not.toHaveBeenCalled();
  });

  // The DTO's rules, asserted through the route because that is the only place
  // jsonValidator runs. Each row is a value the database would accept and the
  // screens would then render wrongly — see downtime-dto.ts.
  it.each([
    ["a missing half", { next: EDIT }],
    ["an unknown category", { next: { ...EDIT, category: "MAINTENANCE" }, baseline: EDIT }],
    ["a blank reason element", { next: { ...EDIT, reason: ["  "] }, baseline: EDIT }],
    ["an over-long label", { next: { ...EDIT, reason: ["x".repeat(256)] }, baseline: EDIT }],
    [
      "too many labels",
      { next: { ...EDIT, actions: Array.from({ length: 21 }, (_, i) => `a${i}`) }, baseline: EDIT },
    ],
    [
      "an over-long detail reason",
      { next: { ...EDIT, detailReason: "x".repeat(2001) }, baseline: EDIT },
    ],
    [
      "a missing detailReason key",
      { next: { category: "UNPLANNED", reason: [], actions: [] }, baseline: EDIT },
    ],
  ])("rejects %s without reaching the service", async (_label, body) => {
    const { app, editDowntime } = setup();

    const res = await app.request(patch("evt-1", body));

    expect(res.status).toBe(400);
    expect(editDowntime).not.toHaveBeenCalled();
  });

  // Trim, dedupe and the empty-string-to-null collapse all happen in the schema,
  // so the SERVICE must never see the raw values — the baseline it binds into the
  // UPDATE's WHERE has to match a row whose value was normalised on the way in,
  // or every edit 412s with no explanation.
  it("normalises both halves before the service sees them", async () => {
    const { app, editDowntime } = setup();

    await app.request(
      patch("evt-1", {
        next: {
          category: "PLANNED",
          reason: [" Machine_Stop ", "Machine_Stop", "Material_Jam"],
          detailReason: "   ",
          actions: [],
        },
        baseline: EDIT,
      }),
    );

    expect(editDowntime).toHaveBeenCalledWith(
      expect.objectContaining({
        next: {
          category: "PLANNED",
          // Trimmed, then deduped, FIRST occurrence kept — element 0 is the
          // Pareto's grouping key, so reordering would move the stop's bar.
          reason: ["Machine_Stop", "Material_Jam"],
          // '' would be a second representation of "nothing here" beside null,
          // and the drawer renders an em dash only for null.
          detailReason: null,
          actions: [],
        },
      }),
    );
  });

  it("requires a token", async () => {
    const { app, editDowntime } = setup(rejectingAuth as AuthMiddleware);

    const res = await app.request(patch("evt-1", { next: EDIT, baseline: EDIT }));

    expect(res.status).toBe(401);
    expect(editDowntime).not.toHaveBeenCalled();
  });

  // The one case requireActor exists for: a token that authenticated but carries
  // no subject. changed_by is NOT NULL, so this is the single place in the
  // codebase where an undefined would reach a NOT NULL text column.
  it("401s a token with no subject", async () => {
    const noSubject = createMiddleware<AuthEnv>(async (c, next) => {
      c.set("jwtPayload", {});
      await next();
    });
    const { app, editDowntime } = setup(noSubject as AuthMiddleware);

    const res = await app.request(patch("evt-1", { next: EDIT, baseline: EDIT }));

    expect(res.status).toBe(401);
    expect(editDowntime).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `grain` — the parameter that lets the day and month screens reuse this module
// ─────────────────────────────────────────────────────────────────────────────
//
// Covered at the HANDLER rather than against the schemas directly, because the
// property that matters is per-ROUTE: downtime-dto.ts has to apply
// `shiftRequiredForShiftGrain` at four separate leaf schemas — zod refuses to
// let a refined object schema have a key overwritten, and
// reasonBreakdownInputSchema narrows `scope` — so the refinement genuinely can
// be forgotten on one route while the other three keep it. A schema-level test
// would not notice; this table does.
describe("grain", () => {
  // Every route, with a query that names no grain and no shift respectively.
  // `scope=work-unit` throughout because /by-reason admits nothing else.
  const ROUTES: [name: string, path: string][] = [
    ["timeline", "/timeline?scope=work-unit&scopeId=42&date=2026-08-09"],
    ["list", "/?scope=work-unit&scopeId=42&date=2026-08-09"],
    ["by-reason", "/by-reason?scope=work-unit&scopeId=42&date=2026-08-09"],
    [
      "by-reason/detail",
      "/by-reason/detail?scope=work-unit&scopeId=42&date=2026-08-09&unlabelled=true",
    ],
    [
      "by-reason/history",
      "/by-reason/history?scope=work-unit&scopeId=42&date=2026-08-09&unlabelled=true",
    ],
  ];

  // THE REGRESSION GUARD FOR EVERY SHIPPED CALLER. The browser's shift-report
  // screens send no `grain` at all; if the default were ever dropped or made
  // required, every one of them would start 400ing.
  it.each(ROUTES)("%s defaults grain to shift when a shift is given", async (_name, path) => {
    const { app } = setup();

    const res = await app.request(`${path}&shift=1`);

    expect(res.status).toBe(200);
  });

  // The whole point of the parameter: a day or month window has no shift, and
  // asking for one would make these routes unusable from the new screens.
  it.each(ROUTES)("%s accepts grain=day with no shift", async (_name, path) => {
    const { app } = setup();

    const res = await app.request(`${path}&grain=day`);

    expect(res.status).toBe(200);
  });

  it.each(ROUTES)("%s accepts grain=month with no shift", async (_name, path) => {
    const { app } = setup();

    const res = await app.request(`${path}&grain=month`);

    expect(res.status).toBe(200);
  });

  // 400 rather than a silent fallback. Defaulting a missing shift to "1" would
  // return an eight-hour slice under the guise of a whole report, and a quiet
  // machine renders identically either way.
  it.each(ROUTES)("%s rejects grain=shift with no shift", async (_name, path) => {
    const { app } = setup();

    const res = await app.request(`${path}&grain=shift`);

    expect(res.status).toBe(400);
  });

  it.each(ROUTES)("%s rejects an unknown grain", async (_name, path) => {
    const { app } = setup();

    const res = await app.request(`${path}&grain=quarter&shift=1`);

    expect(res.status).toBe(400);
  });

  // The grain has to REACH the service, not merely pass validation — it is what
  // picks the window, and a dropped one is an eight-hour report labelled as a
  // month.
  it("passes the parsed grain through to the service", async () => {
    const { app, getTimeline } = setup();

    await app.request("/timeline?scope=work-unit&scopeId=42&date=2026-08-01&grain=month");

    expect(getTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ grain: "month", shift: undefined }),
    );
  });
});
