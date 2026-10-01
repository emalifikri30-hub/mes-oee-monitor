import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { HTTPException } from "hono/http-exception";

import { MasterDataError } from "./master-data-error.js";
import { FAILURE_BACKOFF_MS, MAX_ENTRIES, TimeZoneResolver, TTL_MS } from "./time-zone-resolver.js";

import type { Logger } from "@molca/utils";
import type { MasterDataClientContract } from "@molca/contract-client";

const JAKARTA = { siteId: 1, siteCode: "PLANT-A", timezone: "Asia/Jakarta" };
const MAKASSAR = { siteId: 2, siteCode: "PLANT-B", timezone: "Asia/Makassar" };

// Fake timers rather than an injectable clock: Awilix resolves in PROXY mode
// with strict: true, so an optional `now` dependency would still be destructured
// and would throw at resolve time for not being registered.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeLogger() {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = { withMetadata: vi.fn(() => ({ warn, error })) } as unknown as Logger;
  return { logger, warn, error };
}

function setup(findTimeZoneByScope = vi.fn().mockResolvedValue(JAKARTA)) {
  const { logger, warn, error } = fakeLogger();
  const resolver = new TimeZoneResolver({
    masterDataClient: { findTimeZoneByScope } as unknown as MasterDataClientContract,
    logger,
  });
  return { resolver, findTimeZoneByScope, warn, error };
}

describe("TimeZoneResolver caching", () => {
  it("returns the zone upstream resolved", async () => {
    const { resolver, findTimeZoneByScope } = setup();

    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
    expect(findTimeZoneByScope).toHaveBeenCalledWith("work-unit", 42);
  });

  it("serves a second call inside the ttl without touching upstream", async () => {
    const { resolver, findTimeZoneByScope } = setup();

    await resolver.resolve("work-unit", 42);
    await resolver.resolve("work-unit", 42);

    expect(findTimeZoneByScope).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the ttl has passed", async () => {
    const { resolver, findTimeZoneByScope } = setup();

    await resolver.resolve("work-unit", 42);
    vi.advanceTimersByTime(TTL_MS + 1);
    await resolver.resolve("work-unit", 42);

    expect(findTimeZoneByScope).toHaveBeenCalledTimes(2);
  });

  // Ids are only unique WITHIN a level upstream, so work-unit 42 and work-center
  // 42 are different rows — and can sit under different sites.
  it("keys work units and work centers separately", async () => {
    const findTimeZoneByScope = vi
      .fn()
      .mockImplementation(async (scope: string) => (scope === "work-unit" ? JAKARTA : MAKASSAR));
    const { resolver } = setup(findTimeZoneByScope);

    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
    await expect(resolver.resolve("work-center", 42)).resolves.toBe("Asia/Makassar");
    expect(findTimeZoneByScope).toHaveBeenCalledTimes(2);
  });
});

describe("TimeZoneResolver stale fallback", () => {
  it("serves the last known good zone when upstream fails", async () => {
    const findTimeZoneByScope = vi
      .fn()
      .mockResolvedValueOnce(JAKARTA)
      .mockRejectedValue(new Error("upstream down"));
    const { resolver, warn } = setup(findTimeZoneByScope);

    await resolver.resolve("work-unit", 42);
    vi.advanceTimersByTime(TTL_MS + 1);

    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
    expect(warn).toHaveBeenCalledWith("time_zone_stale_served");
  });

  // The whole mechanism is that NOTHING deletes an entry on a failure path. A
  // single-failure test would still pass if the entry were evicted and refilled.
  it("keeps serving stale across repeated failures", async () => {
    const findTimeZoneByScope = vi
      .fn()
      .mockResolvedValueOnce(JAKARTA)
      .mockRejectedValue(new Error("upstream down"));
    const { resolver } = setup(findTimeZoneByScope);

    await resolver.resolve("work-unit", 42);

    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(Math.max(TTL_MS, FAILURE_BACKOFF_MS) + 1);
      await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
    }
  });

  // Without the backoff every request during an outage waits the full
  // master-data timeout before falling back, so a "degraded" page would take
  // seconds per load.
  it("suppresses re-fetching while the backoff is armed", async () => {
    const findTimeZoneByScope = vi
      .fn()
      .mockResolvedValueOnce(JAKARTA)
      .mockRejectedValue(new Error("upstream down"));
    const { resolver } = setup(findTimeZoneByScope);

    await resolver.resolve("work-unit", 42);
    vi.advanceTimersByTime(TTL_MS + 1);
    await resolver.resolve("work-unit", 42); // fails, arms the backoff
    const callsAfterFailure = findTimeZoneByScope.mock.calls.length;

    vi.advanceTimersByTime(FAILURE_BACKOFF_MS - 1);
    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
    expect(findTimeZoneByScope).toHaveBeenCalledTimes(callsAfterFailure);

    vi.advanceTimersByTime(2);
    await resolver.resolve("work-unit", 42);
    expect(findTimeZoneByScope).toHaveBeenCalledTimes(callsAfterFailure + 1);
  });

  it("recovers to fresh values once upstream comes back", async () => {
    const findTimeZoneByScope = vi
      .fn()
      .mockResolvedValueOnce(JAKARTA)
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValue(MAKASSAR);
    const { resolver } = setup(findTimeZoneByScope);

    await resolver.resolve("work-unit", 42);
    vi.advanceTimersByTime(TTL_MS + 1);
    await resolver.resolve("work-unit", 42);

    vi.advanceTimersByTime(FAILURE_BACKOFF_MS + 1);
    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Makassar");
  });
});

describe("TimeZoneResolver hard failures", () => {
  it("503s when upstream fails and nothing was ever cached", async () => {
    const { resolver, error } = setup(vi.fn().mockRejectedValue(new Error("upstream down")));

    await expect(resolver.resolve("work-unit", 42)).rejects.toSatisfy(
      (err: unknown) => err instanceof HTTPException && err.status === 503,
    );
    expect(error).toHaveBeenCalledWith("time_zone_resolution_failed");
  });

  // A 404 is the caller's error, not an outage: retrying will never help, so it
  // must not be dressed up as a temporary condition.
  it("passes a 404 through rather than reporting it as unavailable", async () => {
    const notFound = new MasterDataError({
      cause: "http_error",
      operation: "findTimeZoneByScope",
      message: "upstream returned 404",
      status: 404,
    });
    const { resolver } = setup(vi.fn().mockRejectedValue(notFound));

    await expect(resolver.resolve("work-unit", 999999)).rejects.toSatisfy(
      (err: unknown) => err instanceof HTTPException && err.status === 404,
    );
  });

  it("still prefers a stale value over a 404", async () => {
    const notFound = new MasterDataError({
      cause: "http_error",
      operation: "findTimeZoneByScope",
      message: "upstream returned 404",
      status: 404,
    });
    const { resolver } = setup(vi.fn().mockResolvedValueOnce(JAKARTA).mockRejectedValue(notFound));

    await resolver.resolve("work-unit", 42);
    vi.advanceTimersByTime(TTL_MS + 1);

    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
  });
});

describe("TimeZoneResolver single-flight", () => {
  // The downtime page fires /downtimes/timeline and /downtimes concurrently for
  // the same scope, so a cold cache GUARANTEES two simultaneous misses on one key.
  it("coalesces concurrent misses on the same key into one call", async () => {
    let release: (value: typeof JAKARTA) => void = () => {};
    const findTimeZoneByScope = vi.fn(
      () =>
        new Promise<typeof JAKARTA>((resolve) => {
          release = resolve;
        }),
    );
    const { resolver } = setup(findTimeZoneByScope);

    const both = Promise.all([
      resolver.resolve("work-unit", 42),
      resolver.resolve("work-unit", 42),
    ]);
    release(JAKARTA);

    await expect(both).resolves.toEqual(["Asia/Jakarta", "Asia/Jakarta"]);
    expect(findTimeZoneByScope).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce across different keys", async () => {
    const { resolver, findTimeZoneByScope } = setup();

    await Promise.all([resolver.resolve("work-unit", 1), resolver.resolve("work-unit", 2)]);

    expect(findTimeZoneByScope).toHaveBeenCalledTimes(2);
  });

  // If the in-flight slot were not cleared on rejection, one failure would pin a
  // rejected promise to the key and every later call would replay it forever.
  it("does not poison a key with a rejected in-flight attempt", async () => {
    const findTimeZoneByScope = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValue(JAKARTA);
    const { resolver } = setup(findTimeZoneByScope);

    await expect(resolver.resolve("work-unit", 42)).rejects.toThrow();

    await expect(resolver.resolve("work-unit", 42)).resolves.toBe("Asia/Jakarta");
  });
});

describe("TimeZoneResolver eviction", () => {
  // Eviction destroys a last-known-good value, so the entries worth protecting
  // are the ones actually being asked for — not merely the ones added recently.
  it("evicts the least recently used entry, sparing a touched early one", async () => {
    const findTimeZoneByScope = vi.fn().mockResolvedValue(JAKARTA);
    const { resolver } = setup(findTimeZoneByScope);

    for (let id = 1; id <= MAX_ENTRIES; id += 1) await resolver.resolve("work-unit", id);

    // Re-reading id 1 moves it to the tail; id 2 becomes the head.
    await resolver.resolve("work-unit", 1);
    const callsBefore = findTimeZoneByScope.mock.calls.length;

    await resolver.resolve("work-unit", MAX_ENTRIES + 1); // overflows, evicts id 2

    await resolver.resolve("work-unit", 1);
    expect(findTimeZoneByScope).toHaveBeenCalledTimes(callsBefore + 1); // id 1 still cached

    await resolver.resolve("work-unit", 2);
    expect(findTimeZoneByScope).toHaveBeenCalledTimes(callsBefore + 2); // id 2 was evicted
  });
});
