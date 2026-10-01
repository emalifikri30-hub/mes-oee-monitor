import { Hono } from "hono";

import type { DependencyState, Probe } from "./health-service.js";

type HealthHandlerDeps = {
  keycloakProbe: Probe;
  goldProbe: Probe;
  silverProbe: Probe;
  // Overrides for tests.
  cacheTtlMs?: number;
  now?: () => number;
};

type ReadinessSnapshot = {
  expiresAt: number;
  ok: boolean;
  dependencies: Record<string, DependencyState>;
};

const DEFAULT_CACHE_TTL_MS = 5_000;

function createHealthHandler({
  keycloakProbe,
  goldProbe,
  silverProbe,
  cacheTtlMs,
  now,
}: HealthHandlerDeps) {
  const app = new Hono();

  const ttl = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = now ?? (() => Date.now());
  let snapshot: ReadinessSnapshot | null = null;
  let inflight: Promise<ReadinessSnapshot> | null = null;

  async function refresh(current: number): Promise<ReadinessSnapshot> {
    const [keycloak, gold, silver] = await Promise.all([
      keycloakProbe.execute(),
      goldProbe.execute(),
      silverProbe.execute(),
    ]);
    return {
      expiresAt: current + ttl,
      // Silver gates readiness: a monitor that cannot read telemetry is not
      // serving its purpose. The cost is that an outage of the shared
      // TimescaleDB takes this API out of rotation entirely — drop `silver.ok`
      // from this conjunction if you would rather report it without gating.
      ok: keycloak.ok && gold.ok && silver.ok,
      dependencies: { keycloak, gold, silver },
    };
  }

  app.get("/liveness", (c) => {
    return c.json(
      {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      200,
    );
  });

  app.get("/readiness", async (c) => {
    const current = clock();

    let snap = snapshot;
    if (!snap || snap.expiresAt <= current) {
      inflight ??= refresh(current).then((s) => {
        snapshot = s;
        inflight = null;
        return s;
      });
      snap = await inflight;
    }

    return c.json(
      {
        status: snap.ok ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        dependencies: snap.dependencies,
      },
      snap.ok ? 200 : 503,
    );
  });

  return app;
}

export { createHealthHandler };
export type { HealthHandlerDeps };
