import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { HTTPException } from "hono/http-exception";

import { MasterDataError } from "./master-data-error.js";
import { FAILURE_BACKOFF_MS, MasterDataService, TTL_MS } from "./master-data-service.js";

import type { Logger } from "@molca/utils";
import type { MasterDataClientContract } from "@molca/contract-client";

// The behaviour TODOS.md §7 asked for, and the reason it needed a service at all.
//
// The MECHANISM — ttl, single-flight, backoff, LRU — is shared with
// TimeZoneResolver through shared/stale-cache.ts and is exercised in depth by
// that resolver's fifteen tests. What is asserted HERE is this caller's POLICY:
// that both lists are cached, that they are keyed apart, that a work-center
// lookup is keyed per area, and that an outage serves the last known good list
// rather than a 502 — which was §7's one open design question.

const AREA = { id: 1, code: "AJINEX-H7", name: "H7" };
const OTHER_AREA = { id: 2, code: "AJINEX-H8", name: "H8" };
const WORK_CENTER = { id: 13, code: "H7-PB", name: "Line PB" };
const OTHER_CENTER = { id: 14, code: "H8-PC", name: "Line PC" };

// Fake timers rather than an injectable clock, for the reason
// time-zone-resolver.test.ts records: Awilix resolves in PROXY mode with
// strict: true, so an optional `now` dependency would be destructured and throw
// at resolve time for not being registered.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeLogger() {
  const warn = vi.fn();
  const logger = { withMetadata: vi.fn(() => ({ warn })) } as unknown as Logger;
  return { logger, warn };
}

function setup(
  findAllArea = vi.fn().mockResolvedValue([AREA]),
  findAllWorkCenterByAreaId = vi.fn().mockResolvedValue([WORK_CENTER]),
) {
  const { logger, warn } = fakeLogger();
  const service = new MasterDataService({
    masterDataClient: {
      findAllArea,
      findAllWorkCenterByAreaId,
    } as unknown as MasterDataClientContract,
    logger,
  });
  return { service, findAllArea, findAllWorkCenterByAreaId, warn };
}

const timeout = () =>
  new MasterDataError({ cause: "timeout", operation: "op", message: "timed out" });

describe("MasterDataService caching", () => {
  it("returns what upstream returned", async () => {
    const { service } = setup();

    await expect(service.listAreas()).resolves.toEqual([AREA]);
  });

  it("serves a second call inside the ttl without touching upstream", async () => {
    const { service, findAllArea } = setup();

    await service.listAreas();
    await service.listAreas();

    expect(findAllArea).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the ttl has passed", async () => {
    const { service, findAllArea } = setup();

    await service.listAreas();
    vi.advanceTimersByTime(TTL_MS + 1);
    await service.listAreas();

    expect(findAllArea).toHaveBeenCalledTimes(2);
  });

  // Two caches, not one keyed union — so this cannot collide even in principle.
  // Asserted anyway, because the alternative implementation (one cache over a
  // union type) would have been a cast away from silently returning areas for a
  // work-center lookup.
  it("keys areas and work centers apart", async () => {
    const { service } = setup();

    await expect(service.listAreas()).resolves.toEqual([AREA]);
    await expect(service.listWorkCenters(1)).resolves.toEqual([WORK_CENTER]);
  });

  // Per area, so one area's list cannot be served for another — the bug a single
  // "work-centers" key would have produced, and one that looks like real data.
  it("keys work centers per area", async () => {
    const findAllWorkCenterByAreaId = vi
      .fn()
      .mockImplementation((areaId: number) =>
        Promise.resolve(areaId === 1 ? [WORK_CENTER] : [OTHER_CENTER]),
      );
    const { service } = setup(undefined, findAllWorkCenterByAreaId);

    await expect(service.listWorkCenters(1)).resolves.toEqual([WORK_CENTER]);
    await expect(service.listWorkCenters(2)).resolves.toEqual([OTHER_CENTER]);
    expect(findAllWorkCenterByAreaId).toHaveBeenCalledTimes(2);

    // ...and each is then cached independently.
    await service.listWorkCenters(1);
    expect(findAllWorkCenterByAreaId).toHaveBeenCalledTimes(2);
  });

  // §7's one open design question, decided: a slightly stale option list beats a
  // 502 in a dropdown. Same answer TimeZoneResolver already gives for the same
  // upstream, which is why both now share one mechanism.
  it("serves the last known good list when upstream fails", async () => {
    const findAllArea = vi.fn().mockResolvedValue([AREA]);
    const { service, warn } = setup(findAllArea);

    await service.listAreas();
    vi.advanceTimersByTime(TTL_MS + 1);
    findAllArea.mockRejectedValue(timeout());

    await expect(service.listAreas()).resolves.toEqual([AREA]);
    // The serve is logged, because a 200 built from known-old data is otherwise
    // invisible: no error status, nothing in the request log.
    expect(warn).toHaveBeenCalledWith("master_data_stale_served");
  });

  it("suppresses re-fetching while the backoff is armed", async () => {
    const findAllArea = vi.fn().mockResolvedValue([AREA]);
    const { service } = setup(findAllArea);

    await service.listAreas();
    vi.advanceTimersByTime(TTL_MS + 1);
    findAllArea.mockRejectedValue(timeout());
    await service.listAreas();
    const afterFirstFailure = findAllArea.mock.calls.length;

    // Every call inside the backoff window is served from memory. Without this a
    // "degraded" system would pay the full 5s upstream timeout per request, which
    // is a broken one.
    await service.listAreas();
    await service.listAreas();

    expect(findAllArea).toHaveBeenCalledTimes(afterFirstFailure);
  });

  it("recovers to fresh values once upstream comes back", async () => {
    const findAllArea = vi.fn().mockResolvedValue([AREA]);
    const { service } = setup(findAllArea);

    await service.listAreas();
    vi.advanceTimersByTime(TTL_MS + 1);
    findAllArea.mockRejectedValue(timeout());
    await service.listAreas();

    vi.advanceTimersByTime(FAILURE_BACKOFF_MS + 1);
    findAllArea.mockResolvedValue([AREA, OTHER_AREA]);

    await expect(service.listAreas()).resolves.toEqual([AREA, OTHER_AREA]);
  });

  // Nothing was ever cached, so there is no list to fall back to. This is the one
  // path that still 502s, and the message must be unchanged from what the handler
  // raised before the service existed — a cache is not an excuse to reword an
  // operator-facing error.
  it("502s when upstream fails and nothing was ever cached", async () => {
    const { service } = setup(vi.fn().mockRejectedValue(timeout()));

    const err = await service.listAreas().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(502);
    expect((err as HTTPException).message).toBe(
      "master data unavailable: could not list areas (timeout)",
    );
  });

  it("names the work-centers operation in its own 502", async () => {
    const { service } = setup(undefined, vi.fn().mockRejectedValue(timeout()));

    const err = await service.listWorkCenters(1).catch((e: unknown) => e);

    expect((err as HTTPException).message).toBe(
      "master data unavailable: could not list work centers (timeout)",
    );
  });

  // The reload-storm case §7 was written for: every open tab asks at once after a
  // deploy, and react-query's staleTime cannot help across users.
  it("coalesces a burst of concurrent misses into one upstream call", async () => {
    const findAllArea = vi.fn().mockResolvedValue([AREA]);
    const { service } = setup(findAllArea);

    const all = await Promise.all([service.listAreas(), service.listAreas(), service.listAreas()]);

    expect(findAllArea).toHaveBeenCalledTimes(1);
    expect(all).toEqual([[AREA], [AREA], [AREA]]);
  });

  // An empty list is a real answer — an area with no work centers — and it is
  // cached like any other. That is what stops a caller walking ?areaId=1..1e6
  // from becoming upstream traffic.
  it("caches an empty list rather than re-asking for it", async () => {
    const findAllWorkCenterByAreaId = vi.fn().mockResolvedValue([]);
    const { service } = setup(undefined, findAllWorkCenterByAreaId);

    await expect(service.listWorkCenters(99)).resolves.toEqual([]);
    await service.listWorkCenters(99);

    expect(findAllWorkCenterByAreaId).toHaveBeenCalledTimes(1);
  });
});

// The downtime catalogues, added for mes-oee-monitor's downtime edit dialog.
//
// Their caching policy is the same as the two lists above and is not re-asserted
// here. What IS asserted is the one behaviour unique to them: a CREATE has to
// invalidate the list it just changed, which is the only place this service
// deletes a cache entry at all.
const REASON = { id: 41, code: "MCH_BRK", name: "Machine Breakdown", category: "UNPLANNED" };
const ACTION = { id: 7, code: "replace_belt", name: "Replace Belt", color: "#f43f5e" };
const NEW_ACTION = { id: 8, code: "oil", name: "Oil", color: "#f43f5e" };

function setupDowntime() {
  const findAllDowntimeReasonByWorkCenterId = vi.fn().mockResolvedValue([REASON]);
  const findAllDowntimeAction = vi.fn().mockResolvedValue([ACTION]);
  const createDowntimeAction = vi.fn().mockResolvedValue(NEW_ACTION);
  const { logger } = fakeLogger();

  const service = new MasterDataService({
    masterDataClient: {
      findAllDowntimeReasonByWorkCenterId,
      findAllDowntimeAction,
      createDowntimeAction,
    } as unknown as MasterDataClientContract,
    logger,
  });

  return {
    service,
    findAllDowntimeReasonByWorkCenterId,
    findAllDowntimeAction,
    createDowntimeAction,
  };
}

describe("MasterDataService downtime catalogues", () => {
  it("caches the action catalogue across calls", async () => {
    const { service, findAllDowntimeAction } = setupDowntime();

    await service.listDowntimeActions();
    await service.listDowntimeActions();

    expect(findAllDowntimeAction).toHaveBeenCalledTimes(1);
  });

  // KEYED PER LINE. The reason catalogue is scoped by
  // `downtime_reasons_work_centers`, so one line's list says nothing about
  // another's — a shared key would serve the filler's reasons on the palletiser,
  // and reason[0] is what the Availability Pareto groups a stop under.
  it("keys the reason catalogue per work center", async () => {
    const { service, findAllDowntimeReasonByWorkCenterId } = setupDowntime();

    await service.listDowntimeReasons(13);
    await service.listDowntimeReasons(14);
    await service.listDowntimeReasons(13);

    expect(findAllDowntimeReasonByWorkCenterId).toHaveBeenCalledTimes(2);
    expect(findAllDowntimeReasonByWorkCenterId).toHaveBeenNthCalledWith(1, 13);
    expect(findAllDowntimeReasonByWorkCenterId).toHaveBeenNthCalledWith(2, 14);
  });

  // THE POINT OF StaleCache.invalidate. Without it the cached list keeps
  // answering for the full ttl, so the action the operator just created is
  // missing from the picker they created it in — which is indistinguishable from
  // the create having failed, and invites them to type it again (a duplicate the
  // server answers 409).
  it("re-reads the action catalogue after a create", async () => {
    const { service, findAllDowntimeAction, createDowntimeAction } = setupDowntime();

    await service.listDowntimeActions();
    expect(findAllDowntimeAction).toHaveBeenCalledTimes(1);

    findAllDowntimeAction.mockResolvedValue([ACTION, NEW_ACTION]);
    await service.createDowntimeAction({ code: "oil", name: "Oil", color: "#f43f5e" });

    expect(createDowntimeAction).toHaveBeenCalledTimes(1);
    await expect(service.listDowntimeActions()).resolves.toEqual([ACTION, NEW_ACTION]);
    expect(findAllDowntimeAction).toHaveBeenCalledTimes(2);
  });

  // A create that failed changed nothing upstream, so the cached list is not
  // stale and must survive — otherwise a flaky network costs every open dialog a
  // fresh round trip for a catalogue that never moved.
  it("leaves the cached catalogue alone when the create fails", async () => {
    const { service, findAllDowntimeAction, createDowntimeAction } = setupDowntime();
    createDowntimeAction.mockRejectedValue(timeout());

    await service.listDowntimeActions();
    await expect(
      service.createDowntimeAction({ code: "oil", name: "Oil", color: "#f43f5e" }),
    ).rejects.toBeInstanceOf(HTTPException);

    await service.listDowntimeActions();
    expect(findAllDowntimeAction).toHaveBeenCalledTimes(1);
  });

  // 502, matching the reads. The create has no cache to carry `wrapError`, so it
  // wraps by hand — and a raw MasterDataError escaping to the app mapper would
  // become a 500, blaming this service for someone else's outage.
  it("502s rather than 500s when the create fails upstream", async () => {
    const { service, createDowntimeAction } = setupDowntime();
    createDowntimeAction.mockRejectedValue(timeout());

    await expect(
      service.createDowntimeAction({ code: "oil", name: "Oil", color: "#f43f5e" }),
    ).rejects.toMatchObject({ status: 502 });
  });

  // The action catalogue is regional and the reason catalogue is per line: an
  // invalidation of one must not evict the other, or every create would cost a
  // refetch of every open line's reasons.
  it("does not disturb the reason cache when an action is created", async () => {
    const { service, findAllDowntimeReasonByWorkCenterId } = setupDowntime();

    await service.listDowntimeReasons(13);
    await service.createDowntimeAction({ code: "oil", name: "Oil", color: "#f43f5e" });
    await service.listDowntimeReasons(13);

    expect(findAllDowntimeReasonByWorkCenterId).toHaveBeenCalledTimes(1);
  });
});

// TODOS §58. This was the one master-data call the service did not cover, and the
// Line report made it hot: the approval summary reads it on EVERY Line shift
// detail page view, and approve, reopen, the activity feed and the stale-metrics
// banner each need it too.
describe("MasterDataService.listWorkUnitIds", () => {
  const ROSTER = [{ id: 901 }, { id: 902 }];

  function setupRoster(findAllWorkUnitByWorkCenterId = vi.fn().mockResolvedValue(ROSTER)) {
    const { logger, warn } = fakeLogger();
    const service = new MasterDataService({
      masterDataClient: {
        findAllWorkUnitByWorkCenterId,
      } as unknown as MasterDataClientContract,
      logger,
    });
    return { service, findAllWorkUnitByWorkCenterId, warn };
  }

  it("returns what upstream returned", async () => {
    const { service } = setupRoster();

    await expect(service.listWorkUnitIds(11, "op")).resolves.toEqual(ROSTER);
  });

  // THE POINT OF THE CHANGE, asserted rather than described: five callers per page
  // view now share one round trip.
  it("calls upstream once for repeated reads of the same line", async () => {
    const { service, findAllWorkUnitByWorkCenterId } = setupRoster();

    await service.listWorkUnitIds(11, "op");
    await service.listWorkUnitIds(11, "op");
    await service.listWorkUnitIds(11, "op");

    expect(findAllWorkUnitByWorkCenterId).toHaveBeenCalledTimes(1);
  });

  // KEYED PER LINE, mirroring listWorkCenters and listDowntimeReasons: one line's
  // roster says nothing about another's, and a shared key would approve the wrong
  // machines.
  it("keys per line, so one line's roster cannot serve another", async () => {
    const findAll = vi
      .fn()
      .mockResolvedValueOnce([{ id: 901 }])
      .mockResolvedValueOnce([{ id: 902 }]);
    const { service } = setupRoster(findAll);

    await expect(service.listWorkUnitIds(11, "op")).resolves.toEqual([{ id: 901 }]);
    await expect(service.listWorkUnitIds(12, "op")).resolves.toEqual([{ id: 902 }]);
    expect(findAll).toHaveBeenCalledTimes(2);
  });

  it("re-reads upstream once the ttl has passed", async () => {
    const { service, findAllWorkUnitByWorkCenterId } = setupRoster();

    await service.listWorkUnitIds(11, "op");
    vi.advanceTimersByTime(TTL_MS + 1);
    await service.listWorkUnitIds(11, "op");

    expect(findAllWorkUnitByWorkCenterId).toHaveBeenCalledTimes(2);
  });

  // `operation` REACHES THE ERROR, which is why it is a parameter at all: the two
  // callers ask genuinely different questions, and the operator reads this string.
  it("names the caller's operation in a cold-cache failure", async () => {
    const { service } = setupRoster(vi.fn().mockRejectedValue(timeout()));

    await expect(service.listWorkUnitIds(11, "resolve the line roster")).rejects.toThrow(
      /resolve the line roster/,
    );
  });

  // A STALE ROSTER CHANGES AN APPROVAL DENOMINATOR, so a stale serve has to be
  // recorded rather than silent — the Line Status tile turns the disagreement it
  // causes into "Roster disagrees", and this log is what explains that afterwards.
  it("serves a stale roster rather than failing, and says so", async () => {
    const findAll = vi.fn().mockResolvedValueOnce(ROSTER).mockRejectedValue(timeout());
    const { service, warn } = setupRoster(findAll);

    await service.listWorkUnitIds(11, "op");
    vi.advanceTimersByTime(TTL_MS + 1);

    await expect(service.listWorkUnitIds(11, "op")).resolves.toEqual(ROSTER);
    expect(warn).toHaveBeenCalledWith("master_data_stale_served");
  });
});

// The same roster with its labels, for the OEE Performance dashboard's machine
// picker. ONE cache entry behind both getters, which is the property worth pinning:
// two caches over one upstream call would double the traffic and could disagree
// about a line's membership for up to a ttl.
describe("MasterDataService.listWorkUnits", () => {
  const UNITS = [
    {
      id: 901,
      code: "WU-901",
      name: "Vertical Packer N",
      workCenter: { id: 11, code: "WC", name: "Line 1" },
    },
    {
      id: 902,
      code: "WU-902",
      name: "Vertical Packer L",
      workCenter: { id: 11, code: "WC", name: "Line 1" },
    },
  ];

  function setupUnits(findAllWorkUnitByWorkCenterId = vi.fn().mockResolvedValue(UNITS)) {
    const { logger } = fakeLogger();
    const service = new MasterDataService({
      masterDataClient: { findAllWorkUnitByWorkCenterId } as unknown as MasterDataClientContract,
      logger,
    });
    return { service, findAllWorkUnitByWorkCenterId };
  }

  // `workCenter` is dropped on the way out: the caller already knows the line, and
  // carrying it would be a second source of truth for the line's name.
  it("returns id, code and name, and not the nested work center", async () => {
    const { service } = setupUnits();

    await expect(service.listWorkUnits(11)).resolves.toEqual([
      { id: 901, code: "WU-901", name: "Vertical Packer N" },
      { id: 902, code: "WU-902", name: "Vertical Packer L" },
    ]);
  });

  // THE SHARED-CACHE PROPERTY. The dashboard's picker and the report list's
  // work-center filter ask the same upstream question; if these ever became two
  // caches, the picker could offer a machine the filter had already dropped.
  it("serves the picker and the id filter from ONE upstream call", async () => {
    const { service, findAllWorkUnitByWorkCenterId } = setupUnits();

    await service.listWorkUnits(11);
    await service.listWorkUnitIds(11, "op");

    expect(findAllWorkUnitByWorkCenterId).toHaveBeenCalledTimes(1);
  });

  it("narrows the same cached rows to bare ids for the filter", async () => {
    const { service } = setupUnits();

    await expect(service.listWorkUnitIds(11, "op")).resolves.toEqual([{ id: 901 }, { id: 902 }]);
  });

  it("keys per line, so one line's machines cannot populate another's picker", async () => {
    const findAll = vi.fn().mockResolvedValueOnce([UNITS[0]]).mockResolvedValueOnce([UNITS[1]]);
    const { service } = setupUnits(findAll);

    await expect(service.listWorkUnits(11)).resolves.toEqual([
      { id: 901, code: "WU-901", name: "Vertical Packer N" },
    ]);
    await expect(service.listWorkUnits(12)).resolves.toEqual([
      { id: 902, code: "WU-902", name: "Vertical Packer L" },
    ]);
    expect(findAll).toHaveBeenCalledTimes(2);
  });
});
