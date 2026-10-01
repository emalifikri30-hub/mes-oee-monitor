import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import type { AppConfig } from "../../shared/config/config.js";

const TEST_CONFIG: AppConfig = {
  oidc: {
    clientId: "portal-bff",
    clientSecret: "secret",
    baseUri: "http://localhost:9099/realms/test",
    redirectUri: "http://localhost:3003/api/callback",
    scope: "openid profile email",
  },
  cookie: {
    name: "portal_session",
    secret: "supersecretvalue1234567890abcdef",
    sameSite: "lax",
    secure: false,
  },
  clientBaseRedirectUri: "http://localhost:3003",
  cors: {
    allowedOrigins: ["http://localhost:3003"],
  },
  coreApi: {
    baseUrl: "http://localhost:4000",
  },
  proxy: {
    allowedPrefixes: ["/v1/"],
    upstreamTimeoutMs: 30_000,
  },
  region: "sea",
};

const mockDiscoveryConfig = vi.hoisted(() => ({}) as any);
const mockAuthUrl = vi.hoisted(() => new URL("http://localhost:9099/auth?test=1"));
const mockEndSessionUrl = vi.hoisted(() => new URL("http://localhost:9099/logout?test=1"));
const mockTokenResponse = vi.hoisted(() => ({
  access_token: "mock-access-token",
  refresh_token: "mock-refresh-token",
  id_token: "mock-id-token",
}));

vi.mock("openid-client", () => ({
  discovery: vi.fn(() => Promise.resolve(mockDiscoveryConfig)),
  allowInsecureRequests: vi.fn(() => {}),
  buildAuthorizationUrl: vi.fn(() => mockAuthUrl),
  authorizationCodeGrant: vi.fn(() => Promise.resolve(mockTokenResponse)),
  refreshTokenGrant: vi.fn(() => Promise.resolve(mockTokenResponse)),
  buildEndSessionUrl: vi.fn(() => mockEndSessionUrl),
}));

import { createAuthService, resetCachedConfig, ALLOWED_PREFIXES } from "./auth-service.js";
import * as oidc from "openid-client";

describe("AuthService", () => {
  beforeEach(() => {
    resetCachedConfig();
    vi.clearAllMocks();
  });

  describe("getConfig", () => {
    it("should call discovery on first invocation", async () => {
      const service = createAuthService(TEST_CONFIG);
      await service.getConfig();

      expect(oidc.discovery).toHaveBeenCalledTimes(1);
    });

    it("should cache discovery config on subsequent calls", async () => {
      const service = createAuthService(TEST_CONFIG);
      await service.getConfig();
      await service.getConfig();

      expect(oidc.discovery).toHaveBeenCalledTimes(1);
    });

    it("should register allowInsecureRequests with discovery for http URLs", async () => {
      const service = createAuthService(TEST_CONFIG);
      await service.getConfig();

      expect(oidc.discovery).toHaveBeenCalledWith(
        new URL(TEST_CONFIG.oidc.baseUri),
        TEST_CONFIG.oidc.clientId,
        TEST_CONFIG.oidc.clientSecret,
        undefined,
        { execute: [oidc.allowInsecureRequests] },
      );
    });
  });

  describe("buildLoginUrl", () => {
    it("should return the authorization URL from openid-client", async () => {
      const service = createAuthService(TEST_CONFIG);
      const url = await service.buildLoginUrl("challenge", "state1", "nonce1");

      expect(url.toString()).toBe(mockAuthUrl.toString());
      expect(oidc.buildAuthorizationUrl).toHaveBeenCalledWith(mockDiscoveryConfig, {
        redirect_uri: TEST_CONFIG.oidc.redirectUri,
        scope: TEST_CONFIG.oidc.scope,
        code_challenge: "challenge",
        code_challenge_method: "S256",
        state: "state1",
        nonce: "nonce1",
      });
    });
  });

  describe("exchangeCode", () => {
    it("should return a normalized token set", async () => {
      const service = createAuthService(TEST_CONFIG);
      const callbackUrl = new URL("http://localhost:3003/api/callback?code=abc&state=s1");

      const result = await service.exchangeCode(callbackUrl, "verifier", "s1", "n1");

      expect(result.accessToken).toBe("mock-access-token");
      expect(result.refreshToken).toBe("mock-refresh-token");
      expect(result.idToken).toBe("mock-id-token");
      expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(mockDiscoveryConfig, callbackUrl, {
        pkceCodeVerifier: "verifier",
        expectedState: "s1",
        expectedNonce: "n1",
      });
    });
  });

  describe("refreshToken", () => {
    it("should return a normalized token set from refresh grant", async () => {
      const service = createAuthService(TEST_CONFIG);
      const result = await service.refreshToken("old-refresh-token");

      expect(result.accessToken).toBe("mock-access-token");
      expect(oidc.refreshTokenGrant).toHaveBeenCalledWith(mockDiscoveryConfig, "old-refresh-token");
    });
  });

  describe("buildLogoutUrl", () => {
    it("should build end session URL with id_token_hint", async () => {
      const service = createAuthService(TEST_CONFIG);
      const url = await service.buildLogoutUrl("my-id-token");

      expect(url.toString()).toBe(mockEndSessionUrl.toString());
      expect(oidc.buildEndSessionUrl).toHaveBeenCalledWith(mockDiscoveryConfig, {
        post_logout_redirect_uri: TEST_CONFIG.clientBaseRedirectUri,
        id_token_hint: "my-id-token",
      });
    });

    it("should build end session URL without id_token_hint when not provided", async () => {
      const service = createAuthService(TEST_CONFIG);
      await service.buildLogoutUrl();

      expect(oidc.buildEndSessionUrl).toHaveBeenCalledWith(mockDiscoveryConfig, {
        post_logout_redirect_uri: TEST_CONFIG.clientBaseRedirectUri,
      });
    });
  });

  // This is the open-redirect boundary for post-login navigation.
  //
  // The allow-path cases are DERIVED from ALLOWED_PREFIXES rather than hard-coded,
  // so they cannot rot the way the template's old /posts cases did.
  //
  // THEY ITERATE EVERY PREFIX, not just the first, and that is the correction
  // worth keeping. While there was only one prefix, sampling `[0]` and covering
  // "the allow-list" looked like the same thing — so when `/oee-performance` was
  // added for the OEE Performance dashboard, the suite kept passing without ever
  // exercising it. The failure that hides is silent and user-visible: a prefix
  // missing here means signing in from a deep link lands the operator on `/` with
  // nothing on screen to say why.
  describe("sanitizeReturnPath", () => {
    // `[...]` because `it.each` over a readonly tuple needs a mutable array, and
    // an empty allow-list must register no cases rather than throw.
    const prefixes = [...ALLOWED_PREFIXES];

    it("should always keep the root path", () => {
      const service = createAuthService(TEST_CONFIG);
      expect(service.sanitizeReturnPath("/")).toBe("/");
    });

    it("should cover every allow-listed prefix", () => {
      // The guard on the three cases below: if the constant is ever emptied, they
      // would silently register nothing and this suite would pass having asserted
      // no allow-path behaviour at all.
      expect(prefixes.length).toBeGreaterThan(0);
    });

    it.each(prefixes)("should keep the allow-listed prefix %s", (prefix) => {
      const service = createAuthService(TEST_CONFIG);
      expect(service.sanitizeReturnPath(prefix)).toBe(prefix);
      expect(service.sanitizeReturnPath(`${prefix}/42`)).toBe(`${prefix}/42`);
    });

    it.each(prefixes)("should drop the query string and fragment on %s", (prefix) => {
      const service = createAuthService(TEST_CONFIG);
      expect(service.sanitizeReturnPath(`${prefix}/42?tab=x#top`)).toBe(`${prefix}/42`);
    });

    it.each(prefixes)("should decode before applying the allow-list on %s", (prefix) => {
      const service = createAuthService(TEST_CONFIG);
      const encoded = `${prefix}/42`.replace(/\//g, "%2F");
      expect(service.sanitizeReturnPath(encoded)).toBe(`${prefix}/42`);
    });

    // Always active, regardless of the allow-list: these are the cases that must
    // never be honoured even once real prefixes exist.
    it.each([
      [undefined],
      [null],
      [""],
      ["   "],
      // Off-origin destinations.
      ["//evil.com"],
      ["https://evil.com"],
      ["evil.com"],
      // Traversal and encoded separators.
      ["/a/../admin"],
      ["/a%2f.."],
      ["/a%5cadmin"],
      ["/a/b:c"],
      // Never bounce back to the sign-in page itself.
      ["/login"],
      // Regression guards: neither the template's routes nor another project's
      // stale allow-list may be honoured.
      ["/posts"],
      ["/posts/01JB2K"],
      ["/group-organization"],
      ["/my-organization/x"],
    ])("should fall back to / for %s", (input) => {
      const service = createAuthService(TEST_CONFIG);
      expect(service.sanitizeReturnPath(input)).toBe("/");
    });

    // Pins the CURRENT posture explicitly, so emptying the list stays a decision
    // rather than something that happens by accident.
    it("rejects every non-root path while the allow-list is empty", () => {
      const service = createAuthService(TEST_CONFIG);
      if (ALLOWED_PREFIXES.length > 0) return;
      for (const path of ["/work-units", "/shift-reports", "/anything"]) {
        expect(service.sanitizeReturnPath(path)).toBe("/");
      }
    });
  });

  describe("buildClientRedirectUri", () => {
    it("should strip the trailing slash for the root path", () => {
      const service = createAuthService(TEST_CONFIG);
      expect(service.buildClientRedirectUri("http://localhost:3003/", "/")).toBe(
        "http://localhost:3003",
      );
    });

    it.skipIf(ALLOWED_PREFIXES.length === 0)("should append an allowed path", () => {
      const prefix = ALLOWED_PREFIXES[0]!;
      const service = createAuthService(TEST_CONFIG);
      expect(service.buildClientRedirectUri("http://localhost:3003", `${prefix}/42`)).toBe(
        `http://localhost:3003${prefix}/42`,
      );
    });

    // buildClientRedirectUri re-sanitizes rather than trusting its caller, so a
    // path that slipped past one layer still cannot become an off-site redirect.
    it.each([["/group-organization"], ["/posts/01JB2K"], ["//evil.com"]])(
      "should re-sanitize the disallowed path %s down to the base",
      (path) => {
        const service = createAuthService(TEST_CONFIG);
        expect(service.buildClientRedirectUri("http://localhost:3003", path)).toBe(
          "http://localhost:3003",
        );
      },
    );
  });
});
