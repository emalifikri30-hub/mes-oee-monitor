import type { PostgresDB } from "../../shared/database/postgres.js";

type DependencyState = {
  ok: boolean;
  error?: string;
};

type Probe = {
  execute: () => Promise<DependencyState>;
};

type KeycloakProbeDeps = {
  oidcBase: string;
  fetchImpl?: typeof fetch;
  probeTimeoutMs?: number;
};

type PostgresProbeDeps = {
  db: PostgresDB;
  probeTimeoutMs?: number;
  // Names the tier in the timeout message, so a Silver outage does not report
  // itself as a generic "postgres" failure. One class serves both tiers.
  label?: string;
};

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

class KeycloakProbe implements Probe {
  private oidcBase: string;
  private fetchFn: typeof fetch;
  private probeTimeoutMs: number;
  private DEFAULT_PROBE_TIMEOUT_MS = 2_000;

  constructor({ fetchImpl, probeTimeoutMs, oidcBase }: KeycloakProbeDeps) {
    this.oidcBase = oidcBase;
    this.fetchFn = fetchImpl ?? fetch;
    this.probeTimeoutMs = probeTimeoutMs ?? this.DEFAULT_PROBE_TIMEOUT_MS;
  }

  async execute(): Promise<DependencyState> {
    return await probeUrl(
      `${this.oidcBase}/protocol/openid-connect/certs`,
      this.fetchFn,
      this.probeTimeoutMs,
      "keycloak_jwks",
    );
  }
}

class PostgresProbe implements Probe {
  private db: PostgresDB;
  private probeTimeoutMs: number;
  private label: string;
  private DEFAULT_PROBE_TIMEOUT_MS = 5_000;

  constructor({ probeTimeoutMs, db, label }: PostgresProbeDeps) {
    this.db = db;
    this.probeTimeoutMs = probeTimeoutMs ?? this.DEFAULT_PROBE_TIMEOUT_MS;
    this.label = label ?? "postgres";
  }

  async execute(): Promise<DependencyState> {
    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${this.label} probe timed out`)),
        this.probeTimeoutMs,
      );
    });
    try {
      await Promise.race([this.db`SELECT 1`, timeout]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: shortError(err) };
    } finally {
      clearTimeout(timeoutId!);
    }
  }
}

export { KeycloakProbe, PostgresProbe };
export type { DependencyState, Probe, KeycloakProbeDeps, PostgresProbeDeps };
