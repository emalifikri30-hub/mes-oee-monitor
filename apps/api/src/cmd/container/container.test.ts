import { describe, it, expect, afterEach } from "vite-plus/test";

import { createContainer } from "./container.js";

import type { AppConfig } from "../../shared/config/config.js";
import type { AwilixContainer } from "awilix";
import type { Cradle } from "./container.js";

// Awilix runs in PROXY mode with `strict: true`, which means two whole classes of
// wiring bug are invisible to every other test in this repo and only surface at
// BOOT — app.ts resolves each handler at module load:
//
//   1. a name a constructor destructures that was never registered
//   2. a singleton depending on something shorter-lived ("Dependency 'x' has a
//      shorter lifetime than its ancestor 'y'")
//
// The second one is why TimeZoneResolver and MasterDataClient are both
// singletons: the resolver's cache lives on the instance, so a scoped client
// underneath it would refuse to resolve at all. Unit tests construct these
// classes directly and so can never catch it.
//
// No I/O happens here: postgres.js does not connect until a query, the Keycloak
// JWKS is fetched lazily, and the service token provider mints on first use.
const CONFIG: AppConfig = {
  applicationAlias: "container-test",
  region: "sea",
  database: {
    gold: {
      url: "postgresql://user:password@localhost:5432/gold",
      logger: false,
      maxConnection: 1,
      idleTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    },
    silver: {
      url: "postgresql://user:password@localhost:5433/silver",
      logger: false,
      maxConnection: 1,
      idleTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    },
  },
  oidc: {
    host: "http://localhost:9099/realms/test",
    baseUri: "http://localhost:9099/realms/test",
    tokenUri: "http://localhost:9099/realms/test/token",
    clientId: "clientId",
    clientSecret: "clientSecret",
  },
  cors: { allowedOrigins: ["http://localhost:3000"] },
  keycloak: { realms: "lnd", timeout: 30_000 },
  masterData: { baseUrl: "http://master-data.test", timeoutMs: 5_000 },
  auth: { roles: {} },
};

// Every name app.ts resolves at boot. If a handler starts resolving something
// new, add it here — that is the point.
const BOOT_RESOLUTIONS = [
  "keycloakProbe",
  "goldProbe",
  "silverProbe",
  "authMw",
  "workUnitReportService",
  "downtimeTimelineService",
  "masterDataClient",
] as const satisfies readonly (keyof Cradle)[];

let container: AwilixContainer<Cradle> | undefined;

afterEach(async () => {
  await container?.dispose();
  container = undefined;
});

describe("createContainer", () => {
  it.for(BOOT_RESOLUTIONS)("resolves %s the way app.ts does at boot", (name) => {
    container = createContainer(CONFIG);

    expect(() => container!.resolve(name)).not.toThrow();
  });

  // The specific trap this guards: a cache on a singleton is useless if the
  // container hands out a new instance per request, and Awilix will not even
  // allow the registration if the client beneath it is shorter-lived.
  it("shares one TimeZoneResolver across resolutions, so its cache survives", () => {
    container = createContainer(CONFIG);

    expect(container.resolve("timeZoneResolver")).toBe(container.resolve("timeZoneResolver"));
  });

  it("gives the downtime service the same resolver instance", () => {
    container = createContainer(CONFIG);

    const service = container.resolve("downtimeTimelineService") as unknown as {
      timeZoneResolver: unknown;
    };

    expect(service.timeZoneResolver).toBe(container.resolve("timeZoneResolver"));
  });
});
