import { asClass, type AwilixContainer } from "awilix";
import { MasterDataClient } from "./master-data-client.js";
import { MasterDataService } from "./master-data-service.js";
import { TimeZoneResolver } from "./time-zone-resolver.js";

function registerMasterData(container: AwilixContainer) {
  container.register({
    // All THREE must be singletons, and the facts are linked.
    //
    // MasterDataService joined this list with TODOS.md §7 for exactly the reason
    // stated below: it holds a StaleCache on the instance, so a scoped
    // registration would hand every request an empty cache and the whole point of
    // the change would be silently undone — no error, no failing test, just a
    // 100% miss rate and the upstream traffic the cache was added to remove.
    //
    // TimeZoneResolver's cache lives on the instance, so a scoped registration
    // would hand every request an empty one and the cache would never hit.
    // Awilix `strict: true` then refuses to let a singleton depend on anything
    // shorter-lived, so the client it consumes has to be a singleton too — a
    // scoped one throws "shorter lifetime than its ancestor" at resolve time,
    // which happens at boot.
    //
    // This is behaviour-preserving today: nothing calls container.createScope(),
    // so a `.scoped()` registration resolved on the root container was already a
    // de-facto singleton. Saying it explicitly is what stops a future scoping
    // middleware from silently emptying the cache.
    //
    // MasterDataClient is safe to share: its only state is the base url, the
    // timeout and the (already singleton) token provider, and its per-request
    // logger comes from AsyncLocalStorage rather than from DI.
    masterDataClient: asClass(MasterDataClient).singleton(),
    masterDataService: asClass(MasterDataService).singleton(),
    timeZoneResolver: asClass(TimeZoneResolver).singleton(),
  });
}

export { registerMasterData };
