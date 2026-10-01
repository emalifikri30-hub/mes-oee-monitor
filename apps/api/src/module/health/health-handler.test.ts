import { describe, it, expect, vi } from "vite-plus/test";

import { createHealthHandler } from "./health-handler.js";

import type { DependencyState, Probe } from "./health-service.js";

function probe(state: DependencyState): Probe & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn().mockResolvedValue(state) };
}

// All three dependencies healthy, overridable per test.
function healthyDeps(overrides: Partial<Record<"keycloak" | "gold" | "silver", Probe>> = {}) {
  return {
    keycloakProbe: overrides.keycloak ?? probe({ ok: true }),
    goldProbe: overrides.gold ?? probe({ ok: true }),
    silverProbe: overrides.silver ?? probe({ ok: true }),
  };
}

describe("GET /liveness", () => {
  it("returns 200 without touching the probes", async () => {
    const keycloakProbe = probe({ ok: true });
    const goldProbe = probe({ ok: true });
    const silverProbe = probe({ ok: true });
    const app = createHealthHandler({ keycloakProbe, goldProbe, silverProbe });

    const res = await app.request("/liveness");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(keycloakProbe.execute).not.toHaveBeenCalled();
    expect(goldProbe.execute).not.toHaveBeenCalled();
    expect(silverProbe.execute).not.toHaveBeenCalled();
  });
});

describe("GET /readiness", () => {
  it("returns 200 and ok when all dependencies are healthy", async () => {
    const app = createHealthHandler(healthyDeps());

    const res = await app.request("/readiness");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.dependencies).toEqual({
      keycloak: { ok: true },
      gold: { ok: true },
      silver: { ok: true },
    });
  });

  it("returns 503 and degraded when the gold tier is down", async () => {
    const app = createHealthHandler(
      healthyDeps({ gold: probe({ ok: false, error: "conn refused" }) }),
    );

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.dependencies.gold).toEqual({ ok: false, error: "conn refused" });
    expect(body.dependencies.silver).toEqual({ ok: true });
  });

  it("returns 503 and reports only silver when the timescale tier is down", async () => {
    const app = createHealthHandler(
      healthyDeps({ silver: probe({ ok: false, error: "silver probe timed out" }) }),
    );

    const res = await app.request("/readiness");
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("degraded");
    // The two tiers report independently — a Silver outage must not be
    // attributed to Gold.
    expect(body.dependencies.silver).toEqual({ ok: false, error: "silver probe timed out" });
    expect(body.dependencies.gold).toEqual({ ok: true });
    expect(body.dependencies.keycloak).toEqual({ ok: true });
  });

  it("caches the snapshot within the TTL and refreshes after it expires", async () => {
    let clock = 1_000;
    const deps = healthyDeps();
    const app = createHealthHandler({ ...deps, cacheTtlMs: 5_000, now: () => clock });

    const executions = () =>
      [deps.keycloakProbe, deps.goldProbe, deps.silverProbe].map(
        (p) => (p.execute as ReturnType<typeof vi.fn>).mock.calls.length,
      );

    await app.request("/readiness");
    await app.request("/readiness");
    expect(executions()).toEqual([1, 1, 1]);

    clock = 7_000; // past expiresAt (1000 + 5000)
    await app.request("/readiness");
    expect(executions()).toEqual([2, 2, 2]);
  });
});
