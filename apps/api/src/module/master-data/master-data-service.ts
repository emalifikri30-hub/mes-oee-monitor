// The reference lists, cached.
//
// WHY THIS FILE NOW EXISTS, having deliberately not existed
//
// master-data-handler.ts's header stated the rule and its own expiry: "There is
// no master-data-service.ts. The repo convention is handler -> service ->
// repository, but the port IS the data source and this is a pure passthrough, so
// a service would be a bare forwarder. The moment a rule appears — scoping areas
// to the caller's site, hiding work centers with no OEE data, CACHING — it earns
// a service and this comment goes away."
//
// Caching is that rule. TODOS.md §7.
//
// WHAT IT BUYS, WHICH IS NOT LATENCY
//
// Areas and work centers change on the order of WEEKS — upstream holds 3 and 13.
// Every request for them went over the wire uncached inside a 5 s budget.
// React-query's staleTime already covers one browser session, so the win here is
// the two cases it cannot reach: N concurrent users, and a reload storm after a
// deploy, when every open tab asks at once.
//
// SERVING STALE WHEN UPSTREAM IS DOWN IS A DECIDED POLICY, not a side effect.
// §7 named it as the question to settle first, and the answer matches what
// TimeZoneResolver already does for the same upstream: a slightly stale option
// list beats a 502 in a dropdown. Both now go through shared/stale-cache.ts, so
// this service and the resolver cannot drift into two different answers.
//
// THE COST, stated because it is real: during an outage a filter can offer a
// work center that has since been renamed or removed, with nothing on screen to
// say so. That is bounded by the ttl below and reported as
// master_data_cache_total{list, outcome="stale"} — which is the signal to look
// at, not the request counter, because these requests SUCCEED.

import { StaleCache } from "../../shared/stale-cache.js";
import { getMasterDataCacheCounter } from "../../shared/observability/metrics.js";
import { upstreamUnavailable } from "./master-data-error.js";
import { baseLogger, getRequestContext } from "@molca/observability";

import type { GetOptions } from "../../shared/stale-cache.js";
import type { Logger } from "@molca/utils";
import type {
  AreaSummary,
  CreateDowntimeActionInput,
  DowntimeActionSummary,
  DowntimeReasonSummary,
  MasterDataClientContract,
  ProductDetail,
  RejectReasonSummary,
  WorkCenterSummary,
  WorkUnitSummary,
  WorkUnitWithCenter,
} from "@molca/contract-client";

// Five minutes, and the number is chosen for CORRECTION LATENCY rather than for
// load. These lists change on the order of weeks, so freshness buys almost
// nothing — what a short ttl buys is a bounded window in which a renamed work
// center still shows its old name. Resilience is carried by the stale fallback,
// not by a long ttl, which is the same argument TTL_MS makes in
// time-zone-resolver.ts.
//
// It matches REFERENCE_STALE_TIME in apps/web/src/lib/queries.ts on purpose: two
// caches in series with different ttls make "how old can this be" the sum of two
// numbers nobody wrote down.
const TTL_MS = 5 * 60_000;

// Long enough that an outage does not have every key paying the 5 s upstream
// timeout, short enough that recovery is not perceptible. Same value and same
// reasoning as the resolver's.
const FAILURE_BACKOFF_MS = 10_000;

// One key for areas plus one per area for work centers. Upstream holds 3 areas,
// so the real universe is 4. The cap exists only so a caller walking
// ?areaId=1..1e6 cannot grow the map without bound.
const MAX_ENTRIES = 200;

const AREAS_KEY = "areas";
const DOWNTIME_ACTIONS_KEY = "downtime-actions";

type MasterDataServiceDeps = {
  masterDataClient: MasterDataClientContract;
  logger?: Logger;
};

type MasterDataServiceContract = {
  listAreas: () => Promise<AreaSummary[]>;
  listWorkCenters: (areaId: number) => Promise<WorkCenterSummary[]>;
  listDowntimeReasons: (workCenterId: number) => Promise<DowntimeReasonSummary[]>;
  listDowntimeActions: () => Promise<DowntimeActionSummary[]>;
  listWorkUnitIds: (workCenterId: number, operation: string) => Promise<{ id: number }[]>;
  // The same roster, with its labels — the OEE Performance dashboard's machine
  // picker. ONE cache entry behind both; see listWorkUnits.
  listWorkUnits: (workCenterId: number) => Promise<WorkUnitSummary[]>;
  createDowntimeAction: (input: CreateDowntimeActionInput) => Promise<DowntimeActionSummary>;
  // Part 3's three, for the quality-entry dialog. `getProduct` is the odd one:
  // it is the only read on this port that is NOT cached, because its factor is
  // frozen onto an operator's record — see the method.
  listRejectReasons: (workCenterId: number) => Promise<RejectReasonSummary[]>;
  listLineProducts: (workCenterId: number) => Promise<AreaSummary[]>;
  getProduct: (productId: number) => Promise<ProductDetail | undefined>;
};

class MasterDataService implements MasterDataServiceContract {
  // TWO TYPED CACHES SHARING ONE OPTIONS OBJECT, rather than one cache over a
  // union of both list types. The union version needs an `as` cast at each getter
  // to narrow on the way out, and a cast is exactly the wrong tool here: it would
  // compile just as happily if the two key prefixes ever collided.
  //
  // Sharing the options object is what keeps the three constants in one place,
  // which was the only real argument for a single instance. The cost is two
  // separate maxEntries budgets — irrelevant at 3 areas and 13 work centers, and
  // noted so nobody "unifies" them back.
  private static readonly OPTIONS = {
    ttlMs: TTL_MS,
    failureBackoffMs: FAILURE_BACKOFF_MS,
    maxEntries: MAX_ENTRIES,
  };

  private areas = new StaleCache<AreaSummary[]>(MasterDataService.OPTIONS);
  private workCenters = new StaleCache<WorkCenterSummary[]>(MasterDataService.OPTIONS);
  private downtimeReasons = new StaleCache<DowntimeReasonSummary[]>(MasterDataService.OPTIONS);
  private downtimeActions = new StaleCache<DowntimeActionSummary[]>(MasterDataService.OPTIONS);
  private rejectReasons = new StaleCache<RejectReasonSummary[]>(MasterDataService.OPTIONS);
  private lineProducts = new StaleCache<AreaSummary[]>(MasterDataService.OPTIONS);
  // ONE cache for the roster, keyed per line, serving BOTH listWorkUnitIds and
  // listWorkUnits. Two caches over the same upstream call would double the
  // traffic and, worse, could disagree about a line's membership for up to a ttl —
  // the OEE Performance picker offering a machine the report filter had already
  // dropped.
  private workUnits = new StaleCache<WorkUnitWithCenter[]>(MasterDataService.OPTIONS);
  private client: MasterDataClientContract;
  private fallbackLogger: Logger;

  constructor({ masterDataClient, logger }: MasterDataServiceDeps) {
    this.client = masterDataClient;
    this.fallbackLogger = logger ?? baseLogger;
  }

  private get logger(): Logger {
    return getRequestContext()?.logger ?? this.fallbackLogger;
  }

  async listAreas(): Promise<AreaSummary[]> {
    return await this.areas.get({
      key: AREAS_KEY,
      fetch: () => this.client.findAllArea(),
      ...this.policy("areas", "list areas"),
    });
  }

  // Keyed per area, so one area's outage or emptiness cannot mask another's.
  async listWorkCenters(areaId: number): Promise<WorkCenterSummary[]> {
    return await this.workCenters.get({
      key: `work-centers:${areaId}`,
      fetch: () => this.client.findAllWorkCenterByAreaId(areaId),
      ...this.policy("work-centers", "list work centers"),
    });
  }

  // Keyed per line, mirroring listWorkCenters: the reason catalogue is scoped by
  // `downtime_reasons_work_centers`, so one line's list says nothing about
  // another's and a shared key would serve the filler's reasons on the palletiser.
  async listDowntimeReasons(workCenterId: number): Promise<DowntimeReasonSummary[]> {
    return await this.downtimeReasons.get({
      key: `downtime-reasons:${workCenterId}`,
      fetch: () => this.client.findAllDowntimeReasonByWorkCenterId(workCenterId),
      ...this.policy("downtime-reasons", "list downtime reasons"),
    });
  }

  // ONE key, because the action catalogue has no scope upstream — see
  // DowntimeActionSummary in @molca/contract-client.
  async listDowntimeActions(): Promise<DowntimeActionSummary[]> {
    return await this.downtimeActions.get({
      key: DOWNTIME_ACTIONS_KEY,
      fetch: () => this.client.findAllDowntimeAction(),
      ...this.policy("downtime-actions", "list downtime actions"),
    });
  }

  // The REJECT catalogue for one line, serving both the Reject and the Rework
  // picker — the requirement is explicit that they are the same catalogue.
  //
  // Keyed per line for the reason listDowntimeReasons gives, one catalogue over:
  // `reject_reasons_work_centers` scopes it, so a shared key would offer one
  // line's reasons on another and the reason is what the Quality Pareto groups a
  // reject under.
  async listRejectReasons(workCenterId: number): Promise<RejectReasonSummary[]> {
    return await this.rejectReasons.get({
      key: `reject-reasons:${workCenterId}`,
      fetch: () => this.client.findAllRejectReasonByWorkCenterId(workCenterId),
      ...this.policy("reject-reasons", "list reject reasons"),
    });
  }

  // The SKUs assigned to one line — the entry dialog's product picker.
  //
  // A CATALOGUE, NOT A MEASUREMENT, and that distinction is why this exists at
  // all. SKU View reads oee.product_count_wc_*, which records what actually RAN
  // and currently ships empty; sourcing a picklist from it would leave the dialog
  // unusable until Airflow runs, and would make the picker's contents a claim
  // about production. This is a claim about setup, which is what a picker wants.
  async listLineProducts(workCenterId: number): Promise<AreaSummary[]> {
    return await this.lineProducts.get({
      key: `line-products:${workCenterId}`,
      fetch: () => this.client.findAllProductByWorkCenterId(workCenterId),
      ...this.policy("line-products", "list the products for this line"),
    });
  }

  // ONE product with its packages — the conversion basis for an entry.
  //
  // DELIBERATELY NOT CACHED, unlike every other read on this service, and the
  // reason is specific rather than a scruple about cardinality. `factorToBase` is
  // SNAPSHOTTED onto the entry row and never re-resolved (migration 0017), so
  // whatever this returns is frozen into an operator's record permanently. A
  // five-minute-stale factor would be a five-minute window in which entries are
  // written against a superseded conversion, with nothing afterwards able to tell
  // them apart from correct ones.
  //
  // It is one round trip on a dialog submission, not on a page view.
  // WRAPPED IN upstreamUnavailable BY HAND, for createDowntimeAction's reason:
  // there is no cache on this path to carry the policy's `wrapError`, and without
  // this the raw MasterDataError escapes and the app's mapper answers 500 — which
  // reads as a bug in THIS service over an outage in someone else's.
  //
  // `undefined` passes through untouched: the client already turned upstream's
  // 404 into it, and that is an ANSWER (a stale picker sent an id that names
  // nothing), not a failure.
  async getProduct(productId: number): Promise<ProductDetail | undefined> {
    try {
      return await this.client.findProductById(productId);
    } catch (err) {
      throw upstreamUnavailable(err, "read this product");
    }
  }

  // THE LINE'S ROSTER — which machines belong to a work center (TODOS §58).
  //
  // WHY IT IS HERE NOW. This was the one master-data call in the service that went
  // straight through the client on every request, and the Line report made that
  // expensive: the approval summary is read on EVERY Line shift detail page view,
  // and approve, reopen, the activity feed and the stale-metrics banner each need
  // the roster too. Five callers, one uncached round trip each.
  //
  // Keyed per line, mirroring listWorkCenters and listDowntimeReasons: one line's
  // roster says nothing about another's.
  //
  // `operation` IS A PARAMETER, which none of the other getters need, and it is
  // not decoration. `wrapError` turns a cold-cache failure into a 502 whose
  // message the operator reads, and the two callers are asking genuinely different
  // questions — "resolve the work center filter" on a list screen versus "resolve
  // the line roster" before signing off a shift. A single shared sentence would be
  // wrong for one of them, and the alternative (each caller re-wrapping the 502
  // this already produced) double-wraps an HTTPException.
  //
  // A STALE ROSTER CHANGES AN APPROVAL DENOMINATOR, which is the one thing to know
  // before raising the TTL. The Line Status tile compares the machine reports it
  // FOUND against the line row's own work_unit_count and abstains when they
  // disagree, so a stale roster surfaces as "Roster disagrees" rather than as a
  // wrong fraction — the right failure, and still a visibly broken tile for as
  // long as the entry lives. Five minutes is fine; a longer TTL is a decision.
  async listWorkUnitIds(workCenterId: number, operation: string): Promise<{ id: number }[]> {
    const units = await this.roster(workCenterId, operation);

    return units.map(({ id }) => ({ id }));
  }

  // The same roster with its labels, for the OEE Performance dashboard's machine
  // picker.
  //
  // A CATALOGUE, NOT A MEASUREMENT — the same call listLineProducts makes above,
  // one axis over. Sourcing the picker from the month-report list instead would
  // have cost no endpoint at all, and was rejected for what it does to the screen:
  // the option set would change every time the month changed, and a machine with
  // no report for the month selected could not be picked at all, so "this machine
  // has no report for August" would be unreachable — the one answer the screen most
  // needs to give.
  //
  // `workCenter` is dropped on the way out. The caller already knows the line — it
  // is the filter above this one in the bar — and carrying it would invite a second
  // source of truth for the line's name.
  async listWorkUnits(workCenterId: number): Promise<WorkUnitSummary[]> {
    const units = await this.roster(workCenterId, "list work units");

    return units.map(({ id, code, name }) => ({ id, code, name }));
  }

  private async roster(workCenterId: number, operation: string): Promise<WorkUnitWithCenter[]> {
    return await this.workUnits.get({
      key: `work-units:${workCenterId}`,
      fetch: () => this.client.findAllWorkUnitByWorkCenterId(workCenterId),
      ...this.policy("work-units", operation),
    });
  }

  // The one write, and the only method here that is NOT cached.
  //
  // IT INVALIDATES THE LIST IT JUST CHANGED, and that is load-bearing rather than
  // tidy. The operator creates an action from the downtime dialog and expects to
  // see it in the picker immediately; without this, the cached list would keep
  // answering for up to the full ttl, so the action they just created would look
  // like it had not been. Five minutes of that is indistinguishable from a bug.
  //
  // INVALIDATE, NOT WRITE-THROUGH. Appending the created row to the cached array
  // would keep a list this process has not re-read from upstream, and every other
  // replica would still be stale anyway — so the write-through buys one process
  // a guess. The next read pays one round trip and gets the truth.
  //
  // A FAILED CREATE LEAVES THE CACHE ALONE: the throw propagates before this
  // line, which is correct — nothing changed upstream, so nothing here is stale.
  //
  // WRAPPED IN upstreamUnavailable BY HAND, because there is no cache on this
  // path to carry `wrapError` for it. Without this the raw MasterDataError
  // escapes and the app's mapper answers 500 — which reads as a bug in THIS
  // service over what is an outage in someone else's. The reads all answer 502
  // for the same failure, and a write that disagrees with them about whose fault
  // it is sends whoever is on call to the wrong service.
  //
  // A 4xx from upstream lands here too, as an `http_error` cause. That is
  // acceptable rather than ideal: this service validates the body first, so the
  // realistic 4xx left is the 409 on a duplicate (code, region) — which the
  // dialog already words as "it may already exist".
  async createDowntimeAction(input: CreateDowntimeActionInput): Promise<DowntimeActionSummary> {
    let created: DowntimeActionSummary;
    try {
      created = await this.client.createDowntimeAction(input);
    } catch (err) {
      throw upstreamUnavailable(err, "create downtime action");
    }

    this.downtimeActions.invalidate(DOWNTIME_ACTIONS_KEY);
    return created;
  }

  // The policy every list shares: which counter, what a stale serve logs, and
  // what a total failure becomes. The mechanism is the cache's.
  //
  // Generic over the element type so it can be spread into either getter without
  // widening what that getter returns — which is what makes the two typed caches
  // above cost nothing in duplication.
  //
  // `operation` is the phrase upstreamUnavailable puts in the operator-facing
  // message, passed through unchanged from what the handler used to supply — so
  // the 502 body did not change when the cache went in front of it.
  private policy<T extends { length: number }>(
    list: string,
    operation: string,
  ): Pick<GetOptions<T>, "onOutcome" | "onStale" | "wrapError"> {
    return {
      onOutcome: (outcome) => getMasterDataCacheCounter().add(1, { list, outcome }),
      // A stale serve answers 200 with a list that may name something no longer
      // there, so it records how old it was and how many entries it had — the
      // count is what makes "the dropdown looked wrong" checkable afterwards.
      onStale: (value, ageMs) =>
        this.logger
          .withMetadata({
            event: "master_data_stale_served",
            list,
            age_ms: ageMs,
            entries: value.length,
          })
          .warn("master_data_stale_served"),
      // Nothing cached and upstream is down: there is no list to fall back to.
      // The same 502 the handler raised before this service existed.
      wrapError: (err) => upstreamUnavailable(err, operation),
    };
  }
}

export { FAILURE_BACKOFF_MS, MasterDataService, MAX_ENTRIES, TTL_MS };
export type { MasterDataServiceContract, MasterDataServiceDeps };
