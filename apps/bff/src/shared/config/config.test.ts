import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import { loadConfig } from "./config.js";

const VALID_ENV = {
  OIDC_CLIENT_ID: "portal-bff",
  OIDC_CLIENT_SECRET: "test-secret",
  OIDC_BASE_URI: "http://localhost:9099/realms/test",
  OIDC_REDIRECT_URI: "http://localhost:3003/api/callback",
  OIDC_CLIENT_SCOPE: "openid profile email",
  COOKIE_NAME: "portal_session",
  COOKIE_SECRET: "supersecretvalue1234567890abcdef",
  CLIENT_BASE_REDIRECT_URI: "http://localhost:3003",
  CORE_API_BASE_URL: "http://localhost:4000",
  PROXY_ALLOWED_PREFIXES: "/v1/,/resources/",
  REGION_CODE: "AP3",
};

describe("loadConfig", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const [key, value] of Object.entries(VALID_ENV)) {
      process.env[key] = value;
    }
    delete process.env.PROXY_UPSTREAM_TIMEOUT_MS;
    delete process.env.COOKIE_DOMAIN;
    delete process.env.COOKIE_SAMESITE;
    delete process.env.COOKIE_SECURE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should load all config values from environment", () => {
    const config = loadConfig();

    expect(config.oidc.clientId).toBe("portal-bff");
    expect(config.oidc.clientSecret).toBe("test-secret");
    expect(config.oidc.baseUri).toBe("http://localhost:9099/realms/test");
    expect(config.oidc.redirectUri).toBe("http://localhost:3003/api/callback");
    expect(config.oidc.scope).toBe("openid profile email");
    expect(config.cookie.name).toBe("portal_session");
    expect(config.cookie.secret).toBe("supersecretvalue1234567890abcdef");
    expect(config.clientBaseRedirectUri).toBe("http://localhost:3003");
    expect(config.coreApi.baseUrl).toBe("http://localhost:4000");
    expect(config.proxy.allowedPrefixes).toEqual(["/v1/", "/resources/"]);
    expect(config.proxy.upstreamTimeoutMs).toBe(30_000);
    expect(config.region).toBe("AP3");
  });

  it("should default the cookie to host-only, lax, and insecure over http", () => {
    const config = loadConfig();

    expect(config.cookie.domain).toBeUndefined();
    expect(config.cookie.sameSite).toBe("lax");
    expect(config.cookie.secure).toBe(false);
  });

  it("should mark the cookie secure when CLIENT_BASE_REDIRECT_URI is https", () => {
    process.env.CLIENT_BASE_REDIRECT_URI = "https://master-data.mes.molca.id";
    const config = loadConfig();
    expect(config.cookie.secure).toBe(true);
  });

  it("should share the cookie across subdomains via COOKIE_DOMAIN", () => {
    process.env.COOKIE_DOMAIN = ".mes.molca.id";
    const config = loadConfig();
    expect(config.cookie.domain).toBe(".mes.molca.id");
  });

  it("should reject a COOKIE_DOMAIN carrying a scheme, port or path", () => {
    process.env.COOKIE_DOMAIN = "https://mes.molca.id";
    expect(() => loadConfig()).toThrow(/without scheme, port or path/);

    process.env.COOKIE_DOMAIN = "mes.molca.id:3001";
    expect(() => loadConfig()).toThrow(/without scheme, port or path/);
  });

  it("should reject a COOKIE_DOMAIN the browser would discard", () => {
    process.env.COOKIE_DOMAIN = "localhost";
    expect(() => loadConfig()).toThrow(/dotted domain/);
  });

  it("should parse COOKIE_SAMESITE case-insensitively", () => {
    process.env.COOKIE_SAMESITE = "Strict";
    expect(loadConfig().cookie.sameSite).toBe("strict");
  });

  it("should reject an unknown COOKIE_SAMESITE", () => {
    process.env.COOKIE_SAMESITE = "sometimes";
    expect(() => loadConfig()).toThrow(/COOKIE_SAMESITE must be one of/);
  });

  it("should reject COOKIE_SAMESITE=none without secure cookies", () => {
    process.env.COOKIE_SAMESITE = "none";
    expect(() => loadConfig()).toThrow(/requires secure cookies/);
  });

  it("should allow COOKIE_SAMESITE=none once cookies are secure", () => {
    process.env.COOKIE_SAMESITE = "none";
    process.env.COOKIE_SECURE = "true";
    const config = loadConfig();
    expect(config.cookie.sameSite).toBe("none");
    expect(config.cookie.secure).toBe(true);
  });

  it("should let COOKIE_SECURE override the protocol-derived default", () => {
    process.env.CLIENT_BASE_REDIRECT_URI = "https://master-data.mes.molca.id";
    process.env.COOKIE_SECURE = "false";
    expect(loadConfig().cookie.secure).toBe(false);
  });

  it("should reject a non-boolean COOKIE_SECURE", () => {
    process.env.COOKIE_SECURE = "yes-please";
    expect(() => loadConfig()).toThrow(/COOKIE_SECURE must be true or false/);
  });

  it("should throw when CLIENT_BASE_REDIRECT_URI is not an absolute URL", () => {
    process.env.CLIENT_BASE_REDIRECT_URI = "/level-configuration";
    expect(() => loadConfig()).toThrow(/must be an absolute URL/);
  });

  it("should throw if REGION_CODE is missing", () => {
    delete process.env.REGION_CODE;

    expect(() => loadConfig()).toThrow("Missing required environment variables: REGION_CODE");
  });

  it("should trim trailing slashes from CORE_API_BASE_URL", () => {
    process.env.CORE_API_BASE_URL = "http://localhost:4000///";
    const config = loadConfig();
    expect(config.coreApi.baseUrl).toBe("http://localhost:4000");
  });

  it("should parse PROXY_UPSTREAM_TIMEOUT_MS when provided", () => {
    process.env.PROXY_UPSTREAM_TIMEOUT_MS = "15000";
    const config = loadConfig();
    expect(config.proxy.upstreamTimeoutMs).toBe(15_000);
  });

  it("should throw on non-positive PROXY_UPSTREAM_TIMEOUT_MS", () => {
    process.env.PROXY_UPSTREAM_TIMEOUT_MS = "0";
    expect(() => loadConfig()).toThrow(/PROXY_UPSTREAM_TIMEOUT_MS/);

    process.env.PROXY_UPSTREAM_TIMEOUT_MS = "-1";
    expect(() => loadConfig()).toThrow(/PROXY_UPSTREAM_TIMEOUT_MS/);

    process.env.PROXY_UPSTREAM_TIMEOUT_MS = "not-a-number";
    expect(() => loadConfig()).toThrow(/PROXY_UPSTREAM_TIMEOUT_MS/);
  });

  it("should throw when PROXY_ALLOWED_PREFIXES entry does not start with '/'", () => {
    process.env.PROXY_ALLOWED_PREFIXES = "v1/,/resources/";
    expect(() => loadConfig()).toThrow(/must start with '\/'/);
  });

  it("should throw when PROXY_ALLOWED_PREFIXES is empty or whitespace-only", () => {
    process.env.PROXY_ALLOWED_PREFIXES = " , , ";
    expect(() => loadConfig()).toThrow(/at least one prefix/);
  });

  it("should throw if a single required variable is missing", () => {
    delete process.env.OIDC_CLIENT_SECRET;

    expect(() => loadConfig()).toThrow(
      "Missing required environment variables: OIDC_CLIENT_SECRET",
    );
  });

  it("should list all missing variables in the error message", () => {
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.COOKIE_NAME;
    delete process.env.CLIENT_BASE_REDIRECT_URI;

    expect(() => loadConfig()).toThrow(
      "Missing required environment variables: OIDC_CLIENT_SECRET, COOKIE_NAME, CLIENT_BASE_REDIRECT_URI",
    );
  });

  it("should list proxy-related missing variables", () => {
    delete process.env.CORE_API_BASE_URL;
    delete process.env.PROXY_ALLOWED_PREFIXES;

    expect(() => loadConfig()).toThrow(/CORE_API_BASE_URL.*PROXY_ALLOWED_PREFIXES/);
  });

  it("should throw when all variables are missing", () => {
    for (const key of Object.keys(VALID_ENV)) {
      delete process.env[key];
    }

    expect(() => loadConfig()).toThrow("Missing required environment variables:");
  });
});
