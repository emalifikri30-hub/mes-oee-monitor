// Resolves the time zone a scope's shifts are defined in, through the
// master-data hierarchy (work unit -> work center -> area -> site.timezone),
// with a TTL cache in front and the last known good value behind.
//
// Why this is a class and not two lines inside DowntimeTimelineService:
//
//   1. Every downtime request needs a zone, and a shift window is meaningless
//      without one — so a bare per-request fetch would put an HTTP round trip in
//      front of every timeline, and an upstream blip would take the page down.
//   2. Serving the LAST KNOWN GOOD zone during an outage is a policy decision
//      with a real cost (a silently frozen zone), so it belongs somewhere it can
//      be named, tested and metered — not scattered across two call sites.
//
// It lives beside MasterDataClient rather than inside it because the client is
// the transport implementation of a port; caching, staleness and HTTP-status
// mapping are not transport.
//
// The cache mechanism moved to shared/stale-cache.ts when the master-data
// reference lists needed the same behaviour (TODOS.md §7) — that file carries the
// state machine and its diagram. What stays here is the policy this scope wants:
// which counter, what a stale serve logs, and that a total failure becomes
// `timeZoneUnresolvable` so a 404 upstream is not reported as unavailable.

import { baseLogger, getRequestContext } from "@molca/observability";

import { StaleCache } from "../../shared/stale-cache.js";

import { timeZoneUnresolvable } from "./master-data-error.js";
import { getTimeZoneResolutionsCounter } from "../../shared/observability/metrics.js";

import type { Logger } from "@molca/utils";
import type { MasterDataClientContract, SiteTimeZone, TimeZoneScope } from "@molca/contract-client";

// A site's zone effectively never changes, so freshness buys almost nothing here.
// What a SHORT ttl buys is a bounded blast radius when someone CORRECTS a wrong
// one: 15 minutes rather than a working day of plausible-but-shifted timelines.
// It can afford to be short because resilience is carried by the stale fallback
// below, not by the ttl.
const TTL_MS = 15 * 60_000;

// Without this, every request during an outage waits the full master-data
// timeout (5s) before falling back — a "degraded" system that answers in five
// seconds is a broken one. With it, one request per key per 10s pays that cost
// and everything else is served from memory instantly.
const FAILURE_BACKOFF_MS = 10_000;

// The real universe is the plant's work units plus its work centers — tens to
// low hundreds — so this should never fire. It exists so a caller walking
// scopeId=1..1e6 cannot grow the map without bound.
const MAX_ENTRIES = 500;

type TimeZoneResolverDeps = {
  masterDataClient: MasterDataClientContract;
  logger?: Logger;
};

type TimeZoneResolverContract = {
  resolve: (scope: TimeZoneScope, scopeId: number) => Promise<string>;
};

class TimeZoneResolver implements TimeZoneResolverContract {
  // The TTL / single-flight / stale-on-failure state machine lives in
  // shared/stale-cache.ts. It was this class's private cache until the
  // master-data reference lists needed the identical behaviour (TODOS.md §7);
  // what stays here is the POLICY — which metric, which log, which error.
  private cache = new StaleCache<SiteTimeZone>({
    ttlMs: TTL_MS,
    failureBackoffMs: FAILURE_BACKOFF_MS,
    maxEntries: MAX_ENTRIES,
  });
  private client: MasterDataClientContract;
  private fallbackLogger: Logger;

  constructor({ masterDataClient, logger }: TimeZoneResolverDeps) {
    this.client = masterDataClient;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  async resolve(scope: TimeZoneScope, scopeId: number): Promise<string> {
    const resolved = await this.cache.get({
      key: `${scope}:${scopeId}`,
      fetch: () => this.client.findTimeZoneByScope(scope, scopeId),
      onOutcome: (outcome) => getTimeZoneResolutionsCounter().add(1, { scope, outcome }),
      // The one branch that answers 200 with a value known to be wrong, so it
      // says WHICH zone and HOW old — a "stale" counter alone cannot be acted on.
      onStale: (value, ageMs, err) =>
        this.logger
          .withMetadata({
            event: "time_zone_stale_served",
            scope,
            scope_id: scopeId,
            site_id: value.siteId,
            time_zone: value.timezone,
            age_ms: ageMs,
            ...metadataOf(err),
          })
          .warn("time_zone_stale_served"),
      // Nothing was ever cached, so there is no zone to fall back to and a shift
      // window cannot be built at all. `timeZoneUnresolvable` preserves a 404
      // from upstream rather than reporting it as unavailable.
      wrapError: (err) => {
        this.logger
          .withMetadata({
            event: "time_zone_resolution_failed",
            scope,
            scope_id: scopeId,
            ...metadataOf(err),
          })
          .error("time_zone_resolution_failed");
        return timeZoneUnresolvable(err, scope, scopeId);
      },
    });

    return resolved.timezone;
  }
}

// MasterDataError already carries the operator-facing breakdown; anything else
// gets a message so a log line is never empty.
function metadataOf(err: unknown): Record<string, string | number> {
  if (err !== null && typeof err === "object" && "toMetadata" in err) {
    const withMetadata = err as { toMetadata: () => Record<string, string | number> };
    return withMetadata.toMetadata();
  }
  return { error_message: err instanceof Error ? err.message : String(err) };
}

export { FAILURE_BACKOFF_MS, MAX_ENTRIES, TimeZoneResolver, TTL_MS };
export type { TimeZoneResolverContract, TimeZoneResolverDeps };
