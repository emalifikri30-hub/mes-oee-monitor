// One tier of the medallion database layout. Gold is this service's own
// read-write store; Silver is the shared TimescaleDB telemetry store, which this
// service only ever reads (its schema is owned by the virtual-factory repo).
type DbTierConfig = {
  url: string;
  logger: boolean;
  maxConnection: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
};

type AppConfig = {
  applicationAlias: string;
  region: string;
  database: {
    gold: DbTierConfig;
    silver: DbTierConfig;
  };
  oidc: {
    host: string;
    baseUri: string;
    tokenUri: string;
    clientId: string;
    clientSecret: string;
  };
  cors: {
    allowedOrigins: string[];
  };
  keycloak: {
    realms: string;
    timeout: number;
  };
  // The mes-master-data service. Work-unit and work-center records live there,
  // not in either of this service's database tiers.
  masterData: {
    baseUrl: string;
    timeoutMs: number;
    // Audience to REQUEST when minting the outbound service token — i.e. who we
    // are calling. Distinct from `auth.audience`, which is who WE expect to be
    // named in tokens presented to us. Optional: Keycloak only honours it when
    // the client has a matching audience mapper.
    audience?: string;
  };
  // Opt-in inbound token checks. Both undefined by default, which reproduces the
  // pre-existing behaviour exactly — see TODO-2 for the rollout order, and note
  // that enabling `audience` before the realm has an audience mapper 401s every
  // caller, browser sessions included.
  auth: {
    audience?: string;
    allowedAzp?: string[];
    // One optional role name per operator mutation. Undefined means "do not
    // check", which is the default and reproduces the pre-gate behaviour exactly
    // — the same opt-in shape as `audience` above, and for a sharper version of
    // the same reason: a role name Keycloak does not emit 403s every operator,
    // where a wrong audience only 401s them.
    //
    // ONE VAR PER MUTATION RATHER THAN ONE FOR ALL, and that is a policy decision
    // deliberately pushed out of the code. Collapsing them would assert that
    // whoever may approve a shift report may also undo somebody else's sign-off,
    // and work-unit-service.ts is explicit that those are different claims. Which
    // roles map to which mutation belongs to whoever administers the realm.
    //
    // The next two are the LINE cascade, which is a third and fourth authority
    // again: approving a line closes every machine shift report on it in one
    // click. That is not the permission "approve the shift you worked" grants.
    //
    // The sixth is a fifth authority, and the argument is the same one more time:
    // entering a reject changes a REPORTED FIGURE that a supervisor and a customer
    // may both read, and that is not what "may approve the shift you worked"
    // grants either. Separate, so a realm administrator can grant one without
    // the other in whichever direction the plant wants.
    roles: {
      approve?: string;
      reopen?: string;
      editDowntime?: string;
      approveLine?: string;
      reopenLine?: string;
      enterQuality?: string;
    };
  };
};

const DEFAULT_KEYCLOAK_TIMEOUT = 30_000;
const DEFAULT_MASTER_DATA_TIMEOUT_MS = 5_000;
const DEFAULT_DB_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_DB_MAX_CONN = 20;
const DEFAULT_DB_CONN_TIMEOUT_MS = 5_000;

// The env var name is a parameter so the two database tiers can share one
// implementation and still report the variable the operator actually set.
function parsePositiveInt(raw: string | undefined, varName: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${varName} must be a positive number: got "${raw}"`);
  }
  return Math.floor(n);
}

// Reads one tier from `<PREFIX>_DATABASE_*`. Both tiers go through here so their
// knobs cannot drift apart as new ones are added.
function readDbTier(prefix: string): DbTierConfig {
  const env = (suffix: string) => process.env[`${prefix}_DATABASE_${suffix}`];
  const name = (suffix: string) => `${prefix}_DATABASE_${suffix}`;

  return {
    url: env("URL")!,
    logger: process.env.NODE_ENV === "development",
    maxConnection: parsePositiveInt(env("MAX_CONN"), name("MAX_CONN"), DEFAULT_DB_MAX_CONN),
    idleTimeoutMs: parsePositiveInt(
      env("IDLE_TIMEOUT_MS"),
      name("IDLE_TIMEOUT_MS"),
      DEFAULT_DB_IDLE_TIMEOUT_MS,
    ),
    connectTimeoutMs: parsePositiveInt(
      env("CONN_TIMEOUT_MS"),
      name("CONN_TIMEOUT_MS"),
      DEFAULT_DB_CONN_TIMEOUT_MS,
    ),
  };
}

function parseListUrl(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseCorsUrl(raw?: string): string[] {
  const corsUrls = parseListUrl(raw ?? "");
  const allowedOrigins = corsUrls.length === 0 ? ["http://localhost:3000"] : corsUrls;
  return allowedOrigins;
}

const REQUIRED_VARS = [
  "OIDC_HOST",
  "OIDC_BASE_URI",
  "OIDC_TOKEN_URI",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "GOLD_DATABASE_URL",
  "SILVER_DATABASE_URL",
  "KEYCLOAK_REALMS",
  "REGION_CODE",
  "APPLICATION_ALIAS",
  // Required, not defaulted: a wrong-but-plausible default (localhost) would
  // fail at request time as an opaque connection error rather than at boot.
  "MASTER_DATA_BASE_URL",
] as const;

// NOTE: there is deliberately no PLANT_TIMEZONE here any more. A plant-wide zone
// cannot be right for more than one site, so shift windows now resolve theirs
// per scope through the master-data hierarchy (work unit -> work center -> area
// -> site.timezone). The IANA validation this file used to do at boot moved to
// master-data-schema.ts, which is where the value enters now.

// Trailing slashes would produce `//v1/work-units` when joined with a path.
function parseBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

// An unset or blank value must stay undefined rather than becoming [], because
// an empty allowlist would reject every caller instead of checking nothing.
function parseOptionalList(raw?: string): string[] | undefined {
  const items = parseListUrl(raw ?? "");
  return items.length === 0 ? undefined : items;
}

function parseOptional(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function loadConfig(): AppConfig {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    applicationAlias: process.env.APPLICATION_ALIAS!,
    database: {
      gold: readDbTier("GOLD"),
      silver: readDbTier("SILVER"),
    },
    oidc: {
      host: process.env.OIDC_HOST!,
      baseUri: process.env.OIDC_BASE_URI!,
      clientId: process.env.OIDC_CLIENT_ID!,
      clientSecret: process.env.OIDC_CLIENT_SECRET!,
      tokenUri: process.env.OIDC_TOKEN_URI!,
    },
    cors: {
      allowedOrigins: parseCorsUrl(process.env.CORS_ALLOWED_ORIGINS),
    },
    keycloak: {
      realms: process.env.KEYCLOAK_REALMS!,
      timeout: parsePositiveInt(
        process.env.KEYCLOAK_TIMEOUT,
        "KEYCLOAK_TIMEOUT",
        DEFAULT_KEYCLOAK_TIMEOUT,
      ),
    },
    masterData: {
      baseUrl: parseBaseUrl(process.env.MASTER_DATA_BASE_URL!),
      timeoutMs: parsePositiveInt(
        process.env.MASTER_DATA_TIMEOUT_MS,
        "MASTER_DATA_TIMEOUT_MS",
        DEFAULT_MASTER_DATA_TIMEOUT_MS,
      ),
      audience: parseOptional(process.env.MASTER_DATA_AUDIENCE),
    },
    auth: {
      audience: parseOptional(process.env.AUTH_AUDIENCE),
      allowedAzp: parseOptionalList(process.env.AUTH_ALLOWED_AZP),
      roles: {
        approve: parseOptional(process.env.APPROVE_ROLE),
        reopen: parseOptional(process.env.REOPEN_ROLE),
        editDowntime: parseOptional(process.env.EDIT_DOWNTIME_ROLE),
        // FIVE NOW, NOT THREE, and the two new ones are separate for the reason
        // §34 gives for the first three rather than by symmetry. Approving a LINE
        // closes every machine shift report on it in one click — that is a
        // different authority from signing off the shift you worked, and
        // collapsing it into APPROVE_ROLE would assert that whoever may do the
        // second may do the first. Same argument again between the two: undoing a
        // whole line's sign-off is not what granting one permits.
        approveLine: parseOptional(process.env.APPROVE_LINE_ROLE),
        reopenLine: parseOptional(process.env.REOPEN_LINE_ROLE),
        // SIX. Entering a reject moves a reported figure, which is its own
        // authority — see the type above.
        enterQuality: parseOptional(process.env.ENTER_QUALITY_ROLE),
      },
    },
    region: process.env.REGION_CODE!,
  };
}

// DERIVED from AppConfig rather than declared beside it, so the Cradle entry and
// the two services that consume it cannot drift from what loadConfig actually
// builds — adding a fourth gated mutation is then one edit, not four.
type OperatorRoles = AppConfig["auth"]["roles"];

export { loadConfig };
export type { AppConfig, DbTierConfig, OperatorRoles };
