import { describe, it, expect } from "vite-plus/test";

import { createHealthHandler } from "./health-handler.js";

const CORE_API = "http://core-api.test";
const OIDC_BASE = "http://keycloak.test/realms/test";
const CORE_READY = `${CORE_API}/health/readiness`;
const JWKS = `${OIDC_BASE}/protocol/openid-connect/certs`;

function buildFetch(map: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return ((url: string | URL | Request) => {
    // eslint-disable-next-line no-base-to-string
    const key = String(url);
    const handler = map[key];
    if (!handler) throw new Error(`unexpected fetch for ${key}`);
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;
}

describe("createHealthHandler (bff)", () => {
  it("L1: GET /liveness returns 200 + does not touch downstream deps", async () => {
    const fetchImpl = (() => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;

    const app = createHealthHandler({
      coreApiBaseUrl: CORE_API,
      oidcBaseUri: OIDC_BASE,
      fetchImpl,
    });
    const res = await app.request("/liveness");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  it("R1: GET /readiness returns 200 with both deps ok", async () => {
    const fetchImpl = buildFetch({
      [CORE_READY]: () => new Response("{}", { status: 200 }),
      [JWKS]: () => new Response("{}", { status: 200 }),
    });

    const app = createHealthHandler({
      coreApiBaseUrl: CORE_API,
      oidcBaseUri: OIDC_BASE,
      fetchImpl,
    });
    const res = await app.request("/readiness");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.dependencies.coreApi).toEqual({ ok: true });
    expect(body.dependencies.keycloak).toEqual({ ok: true });
  });

  it("R2: GET /readiness returns 503 when core-api readiness is degraded", async () => {
    const fetchImpl = buildFetch({
      [CORE_READY]: () => new Response("{}", { status: 503 }),
      [JWKS]: () => new Response("{}", { status: 200 }),
    });

    const app = createHealthHandler({
      coreApiBaseUrl: CORE_API,
      oidcBaseUri: OIDC_BASE,
      fetchImpl,
    });
    const res = await app.request("/readiness");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.dependencies.coreApi.ok).toBe(false);
    expect(body.dependencies.coreApi.error).toContain("503");
    expect(body.dependencies.keycloak.ok).toBe(true);
  });

  it("R3: GET /readiness returns 503 when JWKS is unreachable", async () => {
    const fetchImpl = buildFetch({
      [CORE_READY]: () => new Response("{}", { status: 200 }),
      [JWKS]: () => {
        throw new Error("ENOTFOUND");
      },
    });

    const app = createHealthHandler({
      coreApiBaseUrl: CORE_API,
      oidcBaseUri: OIDC_BASE,
      fetchImpl,
    });
    const res = await app.request("/readiness");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.dependencies.keycloak.ok).toBe(false);
    expect(body.dependencies.keycloak.error).toContain("ENOTFOUND");
  });

  it("R4: probes are cached for ~5s — subsequent requests reuse snapshot", async () => {
    let coreCalls = 0;
    let jwksCalls = 0;
    const fetchImpl = buildFetch({
      [CORE_READY]: () => {
        coreCalls += 1;
        return new Response("{}", { status: 200 });
      },
      [JWKS]: () => {
        jwksCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    let nowMs = 1_000;
    const app = createHealthHandler({
      coreApiBaseUrl: CORE_API,
      oidcBaseUri: OIDC_BASE,
      fetchImpl,
      now: () => nowMs,
    });

    await app.request("/readiness");
    await app.request("/readiness");
    expect(coreCalls).toBe(1);
    expect(jwksCalls).toBe(1);

    nowMs += 6_000;
    await app.request("/readiness");
    expect(coreCalls).toBe(2);
    expect(jwksCalls).toBe(2);
  });
});
