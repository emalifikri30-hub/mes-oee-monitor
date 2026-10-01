import { asFunction, asValue, type AwilixContainer } from "awilix";
import {
  createAuthMiddleware,
  createKeycloakJwks,
  bearerToken,
  createServiceTokenProvider,
} from "@molca/mes";
import type { AppConfig, DbTierConfig } from "./config/config.js";
import { createPostgresDb } from "./database/postgres.js";

// Both medallion tiers are built the same way; only the connection details, the
// application_name and the read-only flag differ.
function tierPool(tier: DbTierConfig, applicationName: string, readOnly: boolean) {
  return createPostgresDb({
    connectionString: tier.url,
    max: tier.maxConnection,
    connectionTimeoutMillis: tier.connectTimeoutMs,
    idleTimeoutMillis: tier.idleTimeoutMs,
    debug: tier.logger,
    applicationName,
    readOnly,
  });
}

function registerInfra(container: AwilixContainer, config: AppConfig) {
  container.register({
    // Gold — COLD aggregated reports. Read-write, but the two halves of "owning"
    // this store belong to different parties: the DDL is ours (database/migration/,
    // applied by scripts/migrate.mjs) while every BULK write is Apache Airflow ->
    // dbt writing directly to the database. This service writes only named operator
    // mutations — approving a shift report, editing a downtime's category, reasons
    // or actions. See docs/gold-write-contract.md.
    goldDb: asFunction(() =>
      tierPool(config.database.gold, `${config.applicationAlias}-gold`, false),
    )
      .singleton()
      .disposer((conn) => conn.end()),
    // Silver — the shared TimescaleDB telemetry store, and the HOT tier the
    // near-realtime dashboard reads. Read-only here: it is written by Apache Flink
    // (Telegraf writes Bronze, one tier below), and its DDL is owned by neither this
    // repo nor, despite the tier below it, virtual-factory's timescale-schema.sql —
    // that file creates the Bronze `machine_metrics` hypertable only.
    silverDb: asFunction(() =>
      tierPool(config.database.silver, `${config.applicationAlias}-silver`, true),
    )
      .singleton()
      .disposer((conn) => conn.end()),
    authMw: asFunction(() =>
      createAuthMiddleware({
        issuer: config.oidc.baseUri,
        getKey: createKeycloakJwks(config.oidc.baseUri),
        getToken: bearerToken(),
        // Both undefined unless an operator sets AUTH_AUDIENCE / AUTH_ALLOWED_AZP,
        // in which case the middleware behaves exactly as it did before these
        // existed. Enabling `audience` needs a Keycloak audience mapper first —
        // Keycloak emits `aud: ["account"]` by default, so turning it on against
        // an unconfigured realm 401s every caller.
        audience: config.auth.audience,
        allowedAzp: config.auth.allowedAzp,
      }),
    ).singleton(),
    // MUST be a singleton: the token cache and the single-flight guard live on
    // the instance, so a scoped registration would mint a token per request and
    // defeat both.
    serviceTokenProvider: asFunction(() =>
      createServiceTokenProvider({
        tokenUri: config.oidc.tokenUri,
        clientId: config.oidc.clientId,
        clientSecret: config.oidc.clientSecret,
        audience: config.masterData.audience,
      }),
    ).singleton(),
    // Primitives the master-data client destructures by name. Registered as
    // values rather than read from config inside the client, so the client stays
    // testable without constructing an AppConfig.
    // TODOS.md §34's gate, and it ships DARK: every field is undefined unless an
    // operator sets APPROVE_ROLE / REOPEN_ROLE / EDIT_DOWNTIME_ROLE, in which
    // case requireRole checks nothing and the three mutations behave exactly as
    // they did before the gate existed.
    //
    // The rollout trap is sharper than AUTH_AUDIENCE's above. A wrong audience
    // 401s callers, which looks like an auth problem and gets diagnosed as one; a
    // role name Keycloak does not emit 403s only the three write paths, so reads
    // keep working and the screen looks healthy right up to the moment somebody
    // tries to sign a shift off. Set one, have a real operator exercise that one
    // route, and watch operator_authorization_denials_total before setting the
    // next.
    operatorRoles: asValue(config.auth.roles),
    masterDataBaseUrl: asValue(config.masterData.baseUrl),
    masterDataTimeoutMs: asValue(config.masterData.timeoutMs),
  });
}

export { registerInfra };
