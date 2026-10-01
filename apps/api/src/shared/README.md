# `shared/` — cross-cutting infrastructure

Code here is feature-agnostic and may be imported by any `module/<feature>/`.
Feature-specific code belongs in its module, not here.

## Layout

| Folder            | Holds                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/`         | Environment loading and the `AppConfig` type.                                                                                                                                                                                                                                                                          |
| `database/`       | Postgres connections and query tracing (`postgres.ts`) plus the Gold-tier DDL in `migration/`. Two tiers: `goldDb` (DDL ours, **bulk writes are Airflow/dbt's**, this service writes only operator mutations — see `docs/gold-write-contract.md`) and `silverDb` (TimescaleDB telemetry, read-only, written by Flink). |
| `helper/`         | **Framework/HTTP-aware** helpers — depend on Hono/Zod/`WebResponse` (`error.ts`, `validator.ts`).                                                                                                                                                                                                                      |
| `middleware/`     | Hono middleware (`jwt.ts`) and the claim/context types it sets (`claims.ts`).                                                                                                                                                                                                                                          |
| `network/`        | The HTTP response envelope (`response.ts` → `WebResponse`, `buildPageMeta`) and pagination types (`page.ts` → `PageMeta`, `Paged`, `PagedResult`).                                                                                                                                                                     |
| `util/`           | **Pure, framework-agnostic** utilities — no Hono/HTTP imports (`constant.ts`, `serializer.ts`, `logger.ts`).                                                                                                                                                                                                           |
| `infra-module.ts` | Awilix `registerInfra` — the shared analog of each feature's `*-module.ts`.                                                                                                                                                                                                                                            |
| `stale-cache.ts`  | A TTL cache that serves the **last known good** value when its source is down — single-flight, failure backoff, LRU cap. Owns the mechanism and none of the policy: each caller supplies its own metric, log and error mapping. Used by `TimeZoneResolver` and `MasterDataService` (TODOS.md §7).                      |

## `helper/` vs `util/`

The single distinction: **does it know about the web framework?**

- `helper/` may import Hono, Zod, `WebResponse`, `HTTPException`, etc.
- `util/` is pure — given the same inputs it returns the same outputs, with no
  framework dependency. Anything in `util/` could be lifted into another project
  unchanged.

When adding a file, place it by that rule rather than by "it's a small helper".
