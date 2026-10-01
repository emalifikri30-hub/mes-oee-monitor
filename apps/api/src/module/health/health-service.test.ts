import { describe, it, expect, vi } from "vite-plus/test";

import { KeycloakProbe, PostgresProbe } from "./health-service.js";

import type { PostgresDB } from "../../shared/database/postgres.js";

const OIDC_BASE = "http://keycloak.test/realms/test";
const JWKS_URL = `${OIDC_BASE}/protocol/openid-connect/certs`;

function fetchReturning(impl: () => Response | Promise<Response>) {
  return vi.fn(() => Promise.resolve(impl())) as unknown as typeof fetch;
}

describe("KeycloakProbe", () => {
  it("reports ok and hits the JWKS endpoint when the response is 2xx", async () => {
    const fetchImpl = fetchReturning(() => new Response(null, { status: 200 }));
    const probe = new KeycloakProbe({ oidcBase: OIDC_BASE, fetchImpl });

    expect(await probe.execute()).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      JWKS_URL,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("reports the status code when the response is not ok", async () => {
    const fetchImpl = fetchReturning(() => new Response(null, { status: 503 }));
    const probe = new KeycloakProbe({ oidcBase: OIDC_BASE, fetchImpl });

    expect(await probe.execute()).toEqual({ ok: false, error: "keycloak_jwks returned 503" });
  });

  it("reports the error message when fetch throws", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error("network down")),
    ) as unknown as typeof fetch;
    const probe = new KeycloakProbe({ oidcBase: OIDC_BASE, fetchImpl });

    expect(await probe.execute()).toEqual({ ok: false, error: "network down" });
  });
});

// The probe calls the postgres.js client as a tagged template (`db`SELECT 1``),
// so the stand-in is a plain function, not an object with an `execute` method.
function dbReturning(impl: () => Promise<unknown>) {
  return vi.fn(impl) as unknown as PostgresDB;
}

describe("PostgresProbe", () => {
  it("reports ok when SELECT 1 resolves", async () => {
    const db = dbReturning(() => Promise.resolve([{ "?column?": 1 }]));
    const probe = new PostgresProbe({ db });

    expect(await probe.execute()).toEqual({ ok: true });
  });

  it("reports the error message when the query rejects", async () => {
    const db = dbReturning(() => Promise.reject(new Error("conn refused")));
    const probe = new PostgresProbe({ db });

    expect(await probe.execute()).toEqual({ ok: false, error: "conn refused" });
  });

  it("reports a timeout when the query hangs past the deadline", async () => {
    const db = dbReturning(() => new Promise(() => {}));
    const probe = new PostgresProbe({ db, probeTimeoutMs: 10 });

    expect(await probe.execute()).toEqual({ ok: false, error: "postgres probe timed out" });
  });

  it("names the tier in the timeout so gold and silver are distinguishable", async () => {
    const hang = () => new Promise(() => {});
    const gold = new PostgresProbe({ db: dbReturning(hang), probeTimeoutMs: 10, label: "gold" });
    const silver = new PostgresProbe({
      db: dbReturning(hang),
      probeTimeoutMs: 10,
      label: "silver",
    });

    expect(await gold.execute()).toEqual({ ok: false, error: "gold probe timed out" });
    expect(await silver.execute()).toEqual({ ok: false, error: "silver probe timed out" });
  });
});
