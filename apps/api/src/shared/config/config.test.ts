import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { loadConfig } from "./config.js";

const VALID_ENV = {
  OIDC_HOST: "http://localhost:9099/realms/test",
  OIDC_BASE_URI: "http://localhost:9099/realms/test",
  OIDC_TOKEN_URI: "http://localhost:9099/realms/test",
  OIDC_CLIENT_ID: "clientId",
  OIDC_CLIENT_SECRET: "clientSecret",
  GOLD_DATABASE_URL: "postgresql://user:password@localhost:5432/gold",
  SILVER_DATABASE_URL: "postgresql://user:password@localhost:5433/silver",
  KEYCLOAK_TIMEOUT: "30000",
  KEYCLOAK_REALMS: "lnd",
  REGION_CODE: "sea",
  APPLICATION_ALIAS: "library-test",
  MASTER_DATA_BASE_URL: "http://master-data.test",
};

// Optional vars must be cleared between tests, or a value set by one case leaks
// into the next and makes the "unset means undefined" assertions pass falsely.
const OPTIONAL_VARS = [
  "PROXY_UPSTREAM_TIMEOUT_MS",
  "MASTER_DATA_TIMEOUT_MS",
  "MASTER_DATA_AUDIENCE",
  "AUTH_AUDIENCE",
  "AUTH_ALLOWED_AZP",
  "APPROVE_ROLE",
  "REOPEN_ROLE",
  "EDIT_DOWNTIME_ROLE",
];

describe("loadConfig", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const [key, value] of Object.entries(VALID_ENV)) {
      process.env[key] = value;
    }
    for (const key of OPTIONAL_VARS) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should load all config values from environment", () => {
    const config = loadConfig();

    expect(config.oidc.baseUri).toBe("http://localhost:9099/realms/test");
    expect(config.region).toBe("sea");
  });

  // Shift windows resolve their zone per scope through mes-master-data now, so a
  // plant-wide one is not merely unused — requiring it would refuse to boot a
  // correctly configured deployment. This pins the removal against someone
  // adding it back to REQUIRED_VARS.
  it("should not require a plant-wide time zone", () => {
    delete process.env.PLANT_TIMEZONE;

    expect(() => loadConfig()).not.toThrow();
  });

  it("should throw if a single required variable is missing", () => {
    delete process.env.OIDC_BASE_URI;

    expect(() => loadConfig()).toThrow("Missing required environment variables: OIDC_BASE_URI");
  });

  it("should throw if REGION_CODE is missing", () => {
    delete process.env.REGION_CODE;

    expect(() => loadConfig()).toThrow("Missing required environment variables: REGION_CODE");
  });

  it("should throw when all variables are missing", () => {
    for (const key of Object.keys(VALID_ENV)) {
      delete process.env[key];
    }

    expect(() => loadConfig()).toThrow("Missing required environment variables:");
  });

  it("should require both database tiers", () => {
    delete process.env.SILVER_DATABASE_URL;

    expect(() => loadConfig()).toThrow(
      "Missing required environment variables: SILVER_DATABASE_URL",
    );
  });

  it("should read the two database tiers independently", () => {
    process.env.GOLD_DATABASE_MAX_CONN = "5";
    process.env.SILVER_DATABASE_MAX_CONN = "50";
    process.env.SILVER_DATABASE_IDLE_TIMEOUT_MS = "1000";

    const { database } = loadConfig();

    expect(database.gold.url).toContain("/gold");
    expect(database.silver.url).toContain("/silver");
    expect(database.gold.maxConnection).toBe(5);
    expect(database.silver.maxConnection).toBe(50);
    // A knob set on one tier must not leak into the other.
    expect(database.silver.idleTimeoutMs).toBe(1000);
    expect(database.gold.idleTimeoutMs).toBe(30_000);
  });

  it("should name the offending tier variable on a bad value", () => {
    process.env.SILVER_DATABASE_MAX_CONN = "-1";

    expect(() => loadConfig()).toThrow(
      'SILVER_DATABASE_MAX_CONN must be a positive number: got "-1"',
    );
  });
});

describe("loadConfig masterData", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const [key, value] of Object.entries(VALID_ENV)) process.env[key] = value;
    for (const key of OPTIONAL_VARS) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("requires the base url rather than defaulting to localhost", () => {
    delete process.env.MASTER_DATA_BASE_URL;

    expect(() => loadConfig()).toThrow(
      "Missing required environment variables: MASTER_DATA_BASE_URL",
    );
  });

  // A trailing slash would produce `//v1/work-units` once a path is appended.
  it("strips trailing slashes from the base url", () => {
    process.env.MASTER_DATA_BASE_URL = "http://master-data.test///";

    expect(loadConfig().masterData.baseUrl).toBe("http://master-data.test");
  });

  it("defaults the timeout to 5s", () => {
    expect(loadConfig().masterData.timeoutMs).toBe(5_000);
  });

  it("honours an explicit timeout", () => {
    process.env.MASTER_DATA_TIMEOUT_MS = "1500";

    expect(loadConfig().masterData.timeoutMs).toBe(1500);
  });

  it("rejects a non-positive timeout", () => {
    process.env.MASTER_DATA_TIMEOUT_MS = "0";

    expect(() => loadConfig()).toThrow("MASTER_DATA_TIMEOUT_MS must be a positive number");
  });

  it("leaves the outbound audience undefined when unset", () => {
    expect(loadConfig().masterData.audience).toBeUndefined();
  });

  it("reads the outbound audience when set", () => {
    process.env.MASTER_DATA_AUDIENCE = "mes-master-data";

    expect(loadConfig().masterData.audience).toBe("mes-master-data");
  });
});

// These two gate the inbound token checks. Their DEFAULT matters most: unset
// must mean "check nothing", because an empty allowlist would reject everyone
// and an enforced audience 401s every caller until Keycloak has a mapper.
describe("loadConfig auth", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const [key, value] of Object.entries(VALID_ENV)) process.env[key] = value;
    for (const key of OPTIONAL_VARS) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("leaves both checks off by default", () => {
    const { auth } = loadConfig();

    expect(auth.audience).toBeUndefined();
    expect(auth.allowedAzp).toBeUndefined();
  });

  // TODOS.md §34's gate, and these four cases guard the property the whole
  // "ship it dark" rollout rests on: unset must mean "do not check". If any of
  // them ever came back a string, the gate would 403 every operator on that
  // route the moment the service booted — with every read still working, so
  // nothing else would look wrong.
  it("leaves all three operator roles unset by default", () => {
    const { roles } = loadConfig().auth;

    expect(roles).toEqual({
      approve: undefined,
      reopen: undefined,
      editDowntime: undefined,
    });
  });

  it("reads each operator role from its own variable", () => {
    process.env.APPROVE_ROLE = "oee-approver";
    process.env.REOPEN_ROLE = "oee-supervisor";
    process.env.EDIT_DOWNTIME_ROLE = "oee-downtime-editor";

    expect(loadConfig().auth.roles).toEqual({
      approve: "oee-approver",
      reopen: "oee-supervisor",
      editDowntime: "oee-downtime-editor",
    });
  });

  // Setting one must not gate the other two — the separation §34 ships three
  // variables for, asserted at the config layer as well as the service layer.
  it("gates only the mutation whose variable is set", () => {
    process.env.APPROVE_ROLE = "oee-approver";

    const { roles } = loadConfig().auth;

    expect(roles.approve).toBe("oee-approver");
    expect(roles.reopen).toBeUndefined();
    expect(roles.editDowntime).toBeUndefined();
  });

  // A blank value is how this arrives in practice — an unset variable in a
  // Kubernetes manifest or a `.env` line with nothing after the `=`. It must read
  // as "not configured", never as a role named "".
  it("treats a blank or whitespace role as unset", () => {
    process.env.APPROVE_ROLE = "";
    process.env.REOPEN_ROLE = "   ";

    const { roles } = loadConfig().auth;

    expect(roles.approve).toBeUndefined();
    expect(roles.reopen).toBeUndefined();
  });

  it("treats a blank audience as unset, not as an empty audience", () => {
    process.env.AUTH_AUDIENCE = "   ";

    expect(loadConfig().auth.audience).toBeUndefined();
  });

  it("reads the expected audience when set", () => {
    process.env.AUTH_AUDIENCE = "mes-master-data";

    expect(loadConfig().auth.audience).toBe("mes-master-data");
  });

  it("parses a comma-separated azp allowlist", () => {
    process.env.AUTH_ALLOWED_AZP = "mes-bff, mes-oee-monitor-svc";

    expect(loadConfig().auth.allowedAzp).toEqual(["mes-bff", "mes-oee-monitor-svc"]);
  });

  // An empty list would reject every caller — far worse than checking nothing.
  it("treats a blank allowlist as unset rather than as an empty list", () => {
    process.env.AUTH_ALLOWED_AZP = "  ,  ";

    expect(loadConfig().auth.allowedAzp).toBeUndefined();
  });
});
