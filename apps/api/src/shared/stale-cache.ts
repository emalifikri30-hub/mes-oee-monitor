// A TTL cache that serves the last known good value when the source is down.
//
// WHY THIS EXISTS AS ITS OWN FILE
//
// It was `TimeZoneResolver`'s private cache, and it moved here the moment a
// SECOND caller needed the same behaviour — caching the master-data reference
// lists (TODOS.md §7). That is the same bar `shared/shift-window.ts` records for
// itself, and the reason is stronger here than there: this is a state machine
// with four outcomes and two timers, and a second hand-rolled copy would not
// diverge loudly. It would diverge in the failure path, which is the path nobody
// exercises by hand.
//
// WHAT IT IS NOT. Not an LRU with a TTL bolted on, and not a memoiser. The
// interesting behaviour is what happens when `fetch` REJECTS, and that is the
// half a plain cache leaves to the caller:
//
//   get(key)
//     │
//     ├─ fresh in cache             -> touch (LRU); "hit"
//     ├─ stale, backoff still armed -> "stale_backoff"   (no upstream call)
//     └─ otherwise: singleFlight(fetch)
//          ├─ resolved              -> store; "miss"
//          └─ rejected
//               ├─ a value exists   -> arm backoff; "stale"  (old value, no throw)
//               └─ never had one    -> "failed"              (throws)
//
// THE ENTRY IS NEVER DELETED ON A FAILURE, and that omission IS the fallback. A
// value has to outlive the failure that would otherwise evict it, which is why
// there is no `catch` that clears the key.
//
// SERVING STALE IS A POLICY WITH A COST — a silently frozen value — so every
// caller states its own: `onOutcome` meters it, `onStale` logs what was served
// and how old it was, and `wrapError` decides what a total failure becomes. This
// file owns the mechanism and none of the policy.

// Which branch a `get` took. Reported to `onOutcome` verbatim so a caller's
// metric labels stay comparable across both users of this cache.
type CacheOutcome = "hit" | "miss" | "stale" | "stale_backoff" | "failed";

type StaleCacheOptions = {
  // How long a value stays FRESH. Short is fine: resilience comes from the stale
  // fallback below, not from a long ttl — so this can be sized for "how quickly
  // must a correction upstream become visible" rather than for availability.
  ttlMs: number;
  // How long to stop re-trying after a failure.
  //
  // WITHOUT THIS, every request during an outage waits the full upstream timeout
  // before falling back, and a "degraded" system that answers in five seconds is
  // a broken one. With it, one request per key per window pays that cost and the
  // rest are served from memory immediately.
  failureBackoffMs: number;
  // A ceiling on the key space, so a caller walking ids 1..1e6 cannot grow the
  // map without bound. Eviction destroys a last-known-good value, which is why
  // the victim is the least recently USED rather than the oldest inserted.
  maxEntries: number;
};

type GetOptions<T> = {
  key: string;
  fetch: () => Promise<T>;
  onOutcome: (outcome: CacheOutcome) => void;
  // Called only on the "stale" branch, with the value being served and its age.
  // Separate from onOutcome because a metric wants a label and a log wants the
  // payload — and this is the one branch that answers 200 with something known
  // to be wrong.
  onStale?: (value: T, ageMs: number, err: unknown) => void;
  // What a failure with nothing cached should throw. Defaults to rethrowing, so a
  // caller that has no domain error to map to does not have to invent one.
  wrapError?: (err: unknown) => unknown;
};

type Entry<T> = {
  value: T;
  // When the value stops being fresh.
  expiresAt: number;
  // When a re-fetch may next be attempted. Only ever moved forward by a failure;
  // 0 while the entry is healthy.
  nextAttemptAt: number;
  // When the value was last fetched successfully, so a stale-serve can say HOW
  // stale rather than merely that it was stale.
  fetchedAt: number;
};

class StaleCache<T> {
  // Map iteration order is insertion order, which is what makes plain
  // delete-then-set an LRU with no bookkeeping.
  private entries = new Map<string, Entry<T>>();
  private inFlight = new Map<string, Promise<T>>();
  private options: StaleCacheOptions;

  constructor(options: StaleCacheOptions) {
    this.options = options;
  }

  async get({ key, fetch, onOutcome, onStale, wrapError }: GetOptions<T>): Promise<T> {
    const entry = this.entries.get(key);
    const now = Date.now();

    if (entry !== undefined && now < entry.expiresAt) {
      this.touch(key, entry);
      onOutcome("hit");
      return entry.value;
    }

    // Deliberately does NOT touch: a key being hammered during an outage should
    // not be able to protect itself from eviction on the strength of failed
    // lookups alone.
    if (entry !== undefined && now < entry.nextAttemptAt) {
      onOutcome("stale_backoff");
      return entry.value;
    }

    try {
      const fresh = await this.fetchOnce(key, fetch);

      this.entries.delete(key);
      this.entries.set(key, {
        value: fresh,
        expiresAt: Date.now() + this.options.ttlMs,
        nextAttemptAt: 0,
        fetchedAt: Date.now(),
      });
      this.evictOverflow();

      onOutcome("miss");
      return fresh;
    } catch (err) {
      // NOTHING is deleted here, and that is the fallback rather than an
      // oversight — see the header.
      if (entry !== undefined) {
        entry.nextAttemptAt = Date.now() + this.options.failureBackoffMs;
        onOutcome("stale");
        onStale?.(entry.value, Date.now() - entry.fetchedAt, err);
        return entry.value;
      }

      onOutcome("failed");
      throw wrapError === undefined ? err : wrapError(err);
    }
  }

  // Drops one key so the next `get` re-reads upstream.
  //
  // FOR A WRITE THAT INVALIDATED ITS OWN LIST, and for nothing else. The caller
  // has just changed the thing this key caches, so the cached value is known to
  // be wrong rather than merely old.
  //
  // THIS IS THE ONE PLACE AN ENTRY IS DELETED, and it deliberately contradicts
  // the header's "nothing is deleted on a failure" — because the two situations
  // are opposites. A value kept through a failure is the best answer available;
  // a value kept through a successful write is a WRONG answer that would be
  // served as the fallback for the whole backoff window if upstream then went
  // down. Between "no fallback" and "a fallback known to be missing the row the
  // operator just created", the former fails visibly and the latter does not.
  //
  // An in-flight fetch for this key is left alone on purpose: it was started
  // before the write, so coalescing a later `get` onto it would return
  // pre-write data. It clears its own slot in `fetchOnce`'s `finally`, and the
  // entry it stores is then itself replaced by the next miss.
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  // Single-flight per key. Two concurrent misses on ONE key is the common case
  // rather than a corner one — a page that fires two requests for the same scope
  // guarantees it on a cold cache.
  //
  // Only the FETCH is coalesced. The stale fallback stays in `get` above, so
  // waiters on a rejected promise each fall back to the same cached value
  // instead of each starting a fresh attempt.
  private async fetchOnce(key: string, fetch: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return await pending;

    // The `finally` must clear the slot on rejection too, or one failure pins a
    // rejected promise to the key and every later call replays it.
    const attempt = fetch().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, attempt);
    return await attempt;
  }

  // Re-insertion moves the key to the tail, so the head is always the
  // least-recently-USED entry rather than the oldest-inserted one. That matters
  // because eviction destroys a last-known-good value, and the entries worth
  // protecting are the ones actually being asked for.
  private touch(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }
}

export { StaleCache };
export type { CacheOutcome, GetOptions, StaleCacheOptions };
