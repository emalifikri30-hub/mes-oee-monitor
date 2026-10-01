import { Hono } from "hono";

type HealthDeps = {
  coreApiBaseUrl: string;
  oidcBaseUri: string;
  // Overrides for tests.
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
};

type DependencyState = {
  ok: boolean;
  error?: string;
};

type ReadinessSnapshot = {
  expiresAt: number;
  ok: boolean;
  dependencies: Record<string, DependencyState>;
};

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

function createHealthHandler(deps: HealthDeps) {
  const app = new Hono();
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchFn = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const coreApiBase = deps.coreApiBaseUrl.replace(/\/+$/, "");
  const oidcBase = deps.oidcBaseUri.replace(/\/+$/, "");
  let snapshot: ReadinessSnapshot | null = null;

  app.get("/liveness", (c) => {
    return c.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/readiness", async (c) => {
    const current = now();

    if (!snapshot || snapshot.expiresAt <= current) {
      const [coreApi, keycloak] = await Promise.all([
        probeUrl(`${coreApiBase}/health/readiness`, fetchFn, probeTimeoutMs, "core-api"),
        probeUrl(
          `${oidcBase}/protocol/openid-connect/certs`,
          fetchFn,
          probeTimeoutMs,
          "keycloak jwks",
        ),
      ]);
      const dependencies = { coreApi, keycloak };
      snapshot = {
        expiresAt: current + cacheTtlMs,
        ok: coreApi.ok && keycloak.ok,
        dependencies,
      };
    }

    return c.json(
      {
        status: snapshot.ok ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        dependencies: snapshot.dependencies,
      },
      snapshot.ok ? 200 : 503,
    );
  });

  return app;
}

async function probeUrl(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  label: string,
): Promise<DependencyState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `${label} returned ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: shortError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export { createHealthHandler };
export type { HealthDeps };
