import { describe, it, expect, beforeAll, vi } from "vite-plus/test";
import { Hono } from "hono";
import { SignJWT, generateKeyPair } from "jose";
import { createAuthHandler } from "./auth-handler.js";
import { createAuthMiddleware, cookieToken } from "@molca/mes";
import type { AuthService, TokenSet } from "./auth-service.js";
import type { AppConfig } from "../../shared/config/config.js";

const ISSUER = "http://localhost:9099/realms/test";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey;
  publicKey = keyPair.publicKey;
});

const TEST_CONFIG: AppConfig = {
  oidc: {
    clientId: "portal-bff",
    clientSecret: "secret",
    baseUri: ISSUER,
    redirectUri: "http://localhost:3003/api/callback",
    scope: "openid profile email",
  },
  cookie: {
    name: "test_sess",
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

async function createToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: "user-123",
    preferred_username: "john",
    email: "john@example.com",
    resource_access: { portal: { roles: ["admin"] } },
    organization: { org1: { id: "org-1", name: "Org One" } },
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setExpirationTime("1h")
    .setIssuer(ISSUER)
    .setSubject((claims.sub as string) ?? "user-123")
    .sign(privateKey);
}

function createMockAuthService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    getConfig: vi.fn(() => Promise.resolve({} as any)),
    buildLoginUrl: vi.fn(() =>
      Promise.resolve(new URL("http://localhost:9099/auth?redirect=test")),
    ),
    exchangeCode: vi.fn(() =>
      Promise.resolve({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        idToken: "new-id-token",
      } as TokenSet),
    ),
    refreshToken: vi.fn(() =>
      Promise.resolve({
        accessToken: "refreshed-access-token",
        refreshToken: "refreshed-refresh-token",
        idToken: "refreshed-id-token",
      } as TokenSet),
    ),
    buildLogoutUrl: vi.fn(() => Promise.resolve(new URL("http://localhost:9099/logout"))),
    sanitizeReturnPath: vi.fn((returnTo: string | null | undefined) => {
      if (!returnTo || returnTo.startsWith("//")) return "/";
      return returnTo;
    }),
    buildClientRedirectUri: vi.fn((baseUri: string, returnTo: string) => {
      const base = baseUri.replace(/\/$/, "");
      if (returnTo === "/") return base;
      return `${base}${returnTo}`;
    }),
    ...overrides,
  };
}

function createTestApp(authService?: AuthService, config: AppConfig = TEST_CONFIG) {
  const svc = authService ?? createMockAuthService();
  const authMw = createAuthMiddleware({
    issuer: ISSUER,
    getKey: publicKey,
    getToken: cookieToken(config.cookie.name),
  });
  const handler = createAuthHandler({
    authService: svc,
    config,
    authMw,
  });
  const app = new Hono();
  app.route("/", handler);
  return { app, authService: svc };
}

// The deployed shape: SPA and BFF on sibling hosts under one parent domain, so
// the session cookie has to be widened past the BFF's own host to be sent at all.
const CROSS_DOMAIN_CONFIG: AppConfig = {
  ...TEST_CONFIG,
  cookie: {
    ...TEST_CONFIG.cookie,
    domain: ".mes.molca.id",
    secure: true,
  },
};

describe("auth-handler cookie scoping", () => {
  it("should scope session cookies to the shared domain when configured", async () => {
    const { app } = createTestApp(undefined, CROSS_DOMAIN_CONFIG);
    const res = await app.request("/api/callback?code=abc&state=xyz", {
      headers: {
        cookie:
          "test_sess_code_verifier=verifier; test_sess_state=xyz; test_sess_nonce=nonce-value",
      },
      redirect: "manual",
    });

    const accessCookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("test_sess_access_token="));

    expect(accessCookie).toContain("Domain=.mes.molca.id");
    expect(accessCookie).toContain("Secure");
    expect(accessCookie).toContain("SameSite=Lax");
  });

  it("should omit Domain when the BFF owns the only origin", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/login", { redirect: "manual" });

    const stateCookie = res.headers.getSetCookie().find((c) => c.startsWith("test_sess_state="));

    expect(stateCookie).not.toContain("Domain=");
  });

  // A Set-Cookie only overwrites an existing cookie when name, path AND domain
  // all match. Clearing with bare `{ path: "/" }` against a domain-scoped cookie
  // writes a second host-only cookie and leaves the real session intact — the
  // user stays logged in after pressing log out.
  it("should clear cookies on the same domain they were set on", async () => {
    const { app } = createTestApp(undefined, CROSS_DOMAIN_CONFIG);
    const res = await app.request("/api/logout", {
      headers: { cookie: `test_sess_access_token=${await createToken()}` },
      redirect: "manual",
    });

    const cleared = res.headers
      .getSetCookie()
      .filter(
        (c) => c.startsWith("test_sess_access_token=") || c.startsWith("test_sess_id_token="),
      );

    expect(cleared.length).toBeGreaterThan(0);
    for (const cookie of cleared) {
      expect(cookie).toContain("Domain=.mes.molca.id");
    }
  });
});

describe("auth-handler", () => {
  describe("GET /api/login", () => {
    it("should redirect to the Keycloak authorization URL", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/login", { redirect: "manual" });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:9099/auth?redirect=test");
    });

    it("should set PKCE temporary cookies", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/login", { redirect: "manual" });

      const cookies = res.headers.getSetCookie();
      const cookieNames = cookies.map((c) => c.split("=")[0]);

      expect(cookieNames).toContain("test_sess_code_verifier");
      expect(cookieNames).toContain("test_sess_state");
      expect(cookieNames).toContain("test_sess_nonce");
      expect(cookieNames).toContain("test_sess_return_to");
    });

    it("should store sanitized returnTo cookie from query", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/login?returnTo=%2Fwork-units%2F42", {
        redirect: "manual",
      });

      const cookies = res.headers.getSetCookie();
      const returnToCookie = cookies.find((c) => c.startsWith("test_sess_return_to="));
      expect(returnToCookie).toBeDefined();
      expect(returnToCookie).toContain("test_sess_return_to=%2Fwork-units%2F42");
    });

    it("should fall back to root returnTo for malicious paths", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/login?returnTo=%2F%2Fevil.com", { redirect: "manual" });

      const cookies = res.headers.getSetCookie();
      const returnToCookie = cookies.find((c) => c.startsWith("test_sess_return_to="));
      expect(returnToCookie).toContain("test_sess_return_to=%2F");
    });

    it("should return 503 when auth service fails", async () => {
      const svc = createMockAuthService({
        buildLoginUrl: vi.fn(() => Promise.reject(new Error("discovery failed"))),
      });
      const { app } = createTestApp(svc);
      const res = await app.request("/api/login");

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("failed to initiate login");
    });
  });

  describe("GET /api/callback", () => {
    it("should exchange code and set token cookies", async () => {
      const { app } = createTestApp();

      const res = await app.request("/api/callback?code=authcode&state=s1", {
        redirect: "manual",
        headers: {
          Cookie: [
            "test_sess_code_verifier=verifier123",
            "test_sess_state=s1",
            "test_sess_nonce=n1",
          ].join("; "),
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3003");

      const cookies = res.headers.getSetCookie();
      const cookieStr = cookies.join("; ");
      expect(cookieStr).toContain("test_sess_access_token=new-access-token");
      expect(cookieStr).toContain("test_sess_refresh_token=new-refresh-token");
      expect(cookieStr).toContain("test_sess_id_token=new-id-token");
    });

    it("should redirect to client base URI plus returnTo path", async () => {
      const { app } = createTestApp();

      const res = await app.request("/api/callback?code=authcode&state=s1", {
        redirect: "manual",
        headers: {
          Cookie: [
            "test_sess_code_verifier=verifier123",
            "test_sess_state=s1",
            "test_sess_nonce=n1",
            "test_sess_return_to=%2Fwork-units%2F42",
          ].join("; "),
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3003/work-units/42");
    });

    it("should ignore invalid returnTo cookie on callback", async () => {
      const { app } = createTestApp();

      const res = await app.request("/api/callback?code=authcode&state=s1", {
        redirect: "manual",
        headers: {
          Cookie: [
            "test_sess_code_verifier=verifier123",
            "test_sess_state=s1",
            "test_sess_nonce=n1",
            "test_sess_return_to=%2F%2Fevil.com",
          ].join("; "),
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3003");
    });

    it("should return 400 when PKCE cookies are missing", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/callback?code=authcode&state=s1");

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("session expired, please login again");
    });

    it("should return 403 when keycloak returns error", async () => {
      const { app } = createTestApp();
      const res = await app.request(
        "/api/callback?error=access_denied&error_description=User+denied+access",
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("User denied access");
    });

    it("should return 500 when token exchange fails", async () => {
      const svc = createMockAuthService({
        exchangeCode: vi.fn(() => Promise.reject(new Error("exchange failed"))),
      });
      const { app } = createTestApp(svc);

      const res = await app.request("/api/callback?code=authcode&state=s1", {
        headers: {
          Cookie: ["test_sess_code_verifier=v", "test_sess_state=s1", "test_sess_nonce=n1"].join(
            "; ",
          ),
        },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("token exchange failed");
    });
  });

  describe("GET /api/me", () => {
    it("should return user info from JWT payload", async () => {
      const { app } = createTestApp();
      const token = await createToken();

      const res = await app.request("/api/me", {
        headers: {
          Cookie: `test_sess_access_token=${token}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.sub).toBe("user-123");
      expect(body.data.preferredUsername).toBe("john");
      expect(body.data.email).toBe("john@example.com");
      expect(body.data.resourceAccess).toEqual({
        portal: { roles: ["admin"] },
      });
      expect(body.data.organization).toEqual({ "Org One": { id: "org-1" } });
    });

    it("should return 401 when no token cookie is present", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/me");

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("token not found");
    });
  });

  describe("GET /api/me/status", () => {
    it("should return success message for authenticated user", async () => {
      const { app } = createTestApp();
      const token = await createToken();

      const res = await app.request("/api/me/status", {
        headers: {
          Cookie: `test_sess_access_token=${token}`,
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.message).toBe("success");
    });

    it("should return 401 when not authenticated", async () => {
      const { app } = createTestApp();
      const res = await app.request("/api/me/status");

      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/token/refresh", () => {
    it("should refresh tokens and set new cookies", async () => {
      const { app } = createTestApp();
      const token = await createToken();

      const res = await app.request("/api/token/refresh", {
        method: "POST",
        headers: {
          Cookie: [`test_sess_access_token=${token}`, `test_sess_refresh_token=old-refresh`].join(
            "; ",
          ),
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.message).toBe("token refreshed");

      const cookies = res.headers.getSetCookie();
      const cookieStr = cookies.join("; ");
      expect(cookieStr).toContain("test_sess_access_token=refreshed-access-token");
    });

    it("should return 401 when refresh token cookie is missing", async () => {
      const { app } = createTestApp();
      const token = await createToken();

      const res = await app.request("/api/token/refresh", {
        method: "POST",
        headers: {
          Cookie: `test_sess_access_token=${token}`,
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("session expired");
    });

    it("should clear cookies and return 401 when refresh grant fails", async () => {
      const svc = createMockAuthService({
        refreshToken: vi.fn(() => Promise.reject(new Error("revoked"))),
      });
      const { app } = createTestApp(svc);
      const token = await createToken();

      const res = await app.request("/api/token/refresh", {
        method: "POST",
        headers: {
          Cookie: [`test_sess_access_token=${token}`, `test_sess_refresh_token=old-refresh`].join(
            "; ",
          ),
        },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("session expired");
    });
  });

  describe("GET /api/logout", () => {
    it("should clear cookies and redirect to keycloak logout", async () => {
      const { app } = createTestApp();
      const token = await createToken();

      const res = await app.request("/api/logout", {
        method: "GET",
        redirect: "manual",
        headers: {
          Cookie: [`test_sess_access_token=${token}`, `test_sess_id_token=id-tok`].join("; "),
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:9099/logout");
    });
  });

  describe("POST /api/logout", () => {
    it("should clear cookies and redirect to keycloak logout", async () => {
      const { app } = createTestApp();
      const token = await createToken();

      const res = await app.request("/api/logout", {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: [`test_sess_access_token=${token}`, `test_sess_id_token=id-tok`].join("; "),
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:9099/logout");

      const cookies = res.headers.getSetCookie();
      const deletedCookies = cookies.filter(
        (c) => c.includes("Max-Age=0") || c.includes("max-age=0"),
      );
      expect(deletedCookies.length).toBeGreaterThanOrEqual(3);
    });

    it("should redirect to client base URI when logout URL build fails", async () => {
      const svc = createMockAuthService({
        buildLogoutUrl: vi.fn(() => Promise.reject(new Error("fail"))),
      });
      const { app } = createTestApp(svc);
      const token = await createToken();

      const res = await app.request("/api/logout", {
        method: "POST",
        redirect: "manual",
        headers: {
          Cookie: `test_sess_access_token=${token}`,
        },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://localhost:3003");
    });
  });
});
