import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vite-plus/test";
import { Hono } from "hono";
import { SignJWT, generateKeyPair } from "jose";
import { createProxyHandler, validateUpstreamPath } from "./proxy-handler.js";
import { createAuthMiddleware, cookieToken } from "@molca/mes";
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
    baseUrl: "http://core-api.test",
  },
  proxy: {
    allowedPrefixes: ["/v1/", "/resources/"],
    upstreamTimeoutMs: 50,
  },
  region: "sea",
};

async function createToken(): Promise<string> {
  return new SignJWT({
    sub: "user-123",
    preferred_username: "john",
    resource_access: {},
  })
    .setProtectedHeader({ alg: "RS256" })
    .setExpirationTime("1h")
    .setIssuer(ISSUER)
    .setSubject("user-123")
    .sign(privateKey);
}

function createTestApp() {
  const authMw = createAuthMiddleware({
    issuer: ISSUER,
    getKey: publicKey,
    getToken: cookieToken(TEST_CONFIG.cookie.name),
  });
  const proxyApp = createProxyHandler({
    config: TEST_CONFIG,
    authMw,
  });
  const app = new Hono();
  app.route("/api/proxy", proxyApp);
  return app;
}

type FetchCall = {
  url: string;
  init: RequestInit & { duplex?: string };
};

function stubFetch(impl: (call: FetchCall) => Promise<Response> | Response): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
      init: (init ?? {}) as RequestInit & { duplex?: string },
    };
    calls.push(call);
    return await impl(call);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("validateUpstreamPath", () => {
  const prefixes = ["/v1/", "/resources/"];

  it("accepts an allowed prefix", () => {
    expect(validateUpstreamPath("/v1/users", prefixes)).toEqual({
      ok: true,
      upstreamPath: "/v1/users",
    });
  });

  it("rejects a disallowed prefix with 403", () => {
    expect(validateUpstreamPath("/internal/secrets", prefixes)).toEqual({
      ok: false,
      status: 403,
      error: "path not allowed",
    });
  });

  it("rejects empty path with 403", () => {
    expect(validateUpstreamPath("", prefixes).ok).toBe(false);
    expect(validateUpstreamPath("/", prefixes).ok).toBe(false);
  });

  it("rejects a traversal segment with 400", () => {
    const result = validateUpstreamPath("/v1/../admin", prefixes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("rejects encoded slash with 400", () => {
    const result = validateUpstreamPath("/v1/a%2Fb", prefixes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);

    const upper = validateUpstreamPath("/v1/a%2fb", prefixes);
    expect(upper.ok).toBe(false);
  });
});

describe("proxy-handler", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch(() => new Response("upstream-body", { status: 200 }));
  });

  afterEach(() => {
    stub.restore();
  });

  it("returns 401 without access token cookie", async () => {
    const app = createTestApp();
    const res = await app.request("/api/proxy/v1/users");
    expect(res.status).toBe(401);
    expect(stub.calls.length).toBe(0);
  });

  it("proxies an allowed GET to the upstream base URL", async () => {
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-body");
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe("http://core-api.test/v1/users");
    expect(stub.calls[0].init.method).toBe("GET");
  });

  it("rejects a disallowed prefix with 403 and does not call upstream", async () => {
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/internal/secrets", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(403);
    expect(stub.calls.length).toBe(0);
  });

  it("rejects /internal/v1 proxy attempts with 403 (inter-service endpoints are not browser-facing)", async () => {
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/internal/v1/tenants/abc", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(403);
    expect(stub.calls.length).toBe(0);
  });

  it("blocks path traversal and does not reach upstream", async () => {
    const app = createTestApp();
    const token = await createToken();

    // URL parsing collapses `..` before our handler sees it, so this normalizes
    // to /api/proxy/admin and falls out of the allowlist (403). The segment
    // check in validateUpstreamPath is defense-in-depth for encoded variants.
    const res = await app.request("/api/proxy/v1/../admin", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect([400, 403]).toContain(res.status);
    expect(stub.calls.length).toBe(0);
  });

  it("rejects encoded slash with 400", async () => {
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/a%2Fb", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(400);
    expect(stub.calls.length).toBe(0);
  });

  it("preserves the raw query string (repeated keys, + and %20)", async () => {
    const app = createTestApp();
    const token = await createToken();

    await app.request("/api/proxy/v1/search?tag=a&tag=b&q=hello+world&name=John%20Doe", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(stub.calls[0].url).toBe(
      "http://core-api.test/v1/search?tag=a&tag=b&q=hello+world&name=John%20Doe",
    );
  });

  it("strips client-supplied Authorization and injects Bearer from cookie", async () => {
    const app = createTestApp();
    const token = await createToken();

    await app.request("/api/proxy/v1/users", {
      headers: {
        Cookie: `test_sess_access_token=${token}`,
        Authorization: "Bearer client-supplied",
      },
    });

    const headers = stub.calls[0].init.headers as Headers;
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  it("does not forward the client Cookie header to upstream", async () => {
    const app = createTestApp();
    const token = await createToken();

    await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}; other=1` },
    });

    const headers = stub.calls[0].init.headers as Headers;
    expect(headers.get("cookie")).toBeNull();
  });

  it("strips upstream Set-Cookie from the response", async () => {
    stub.restore();
    stub = stubFetch(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "set-cookie": "upstream=1; Path=/" },
        }),
    );
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("preserves multipart Content-Type including boundary", async () => {
    const app = createTestApp();
    const token = await createToken();

    const ct = "multipart/form-data; boundary=----WebKitFormBoundaryXYZ";
    await app.request("/api/proxy/v1/upload", {
      method: "POST",
      headers: {
        Cookie: `test_sess_access_token=${token}`,
        "Content-Type": ct,
      },
      body: "not-actually-multipart-but-unparsed",
    });

    const headers = stub.calls[0].init.headers as Headers;
    expect(headers.get("content-type")).toBe(ct);
  });

  it("forwards a POST body as a stream (not a parsed object)", async () => {
    const app = createTestApp();
    const token = await createToken();

    await app.request("/api/proxy/v1/upload", {
      method: "POST",
      headers: {
        Cookie: `test_sess_access_token=${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: "raw-bytes",
    });

    const init = stub.calls[0].init;
    // Body is present and not consumed by any middleware.
    expect(init.body).not.toBeUndefined();
    expect(init.body).not.toBeNull();
    // Duplex is required by the Fetch spec for streaming request bodies.
    expect(init.duplex).toBe("half");
    // Signal is wired through so client-abort can cancel upstream.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits the body for GET/HEAD/OPTIONS", async () => {
    const app = createTestApp();
    const token = await createToken();

    await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });
    expect(stub.calls[0].init.body).toBeUndefined();
  });

  it("forwards Range header and passes 206 through", async () => {
    stub.restore();
    stub = stubFetch(
      () =>
        new Response("partial", {
          status: 206,
          headers: {
            "content-range": "bytes 0-6/100",
            "accept-ranges": "bytes",
          },
        }),
    );
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/files/big.bin", {
      headers: {
        Cookie: `test_sess_access_token=${token}`,
        Range: "bytes=0-6",
      },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-6/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const upstreamHeaders = stub.calls[0].init.headers as Headers;
    expect(upstreamHeaders.get("range")).toBe("bytes=0-6");
  });

  it("passes through 302 redirect and preserves Location", async () => {
    stub.restore();
    stub = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://core-api.test/v1/other" },
        }),
    );
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/users", {
      redirect: "manual",
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://core-api.test/v1/other");
    // The upstream call itself was made with redirect=manual so we don't
    // chase redirects inside the BFF.
    expect((stub.calls[0].init as RequestInit).redirect).toBe("manual");
  });

  it("returns 504 on upstream timeout", async () => {
    stub.restore();
    stub = stubFetch(() => {
      const err = new Error("timeout") as Error & { name: string };
      err.name = "TimeoutError";
      return Promise.reject(err);
    });
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body.error).toBe("upstream timeout");
  });

  it("returns 502 on upstream connect error", async () => {
    stub.restore();
    stub = stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("upstream unavailable");
  });

  it("passes a 401 from upstream through unchanged", async () => {
    stub.restore();
    stub = stubFetch(
      () =>
        new Response(JSON.stringify({ error: "upstream-says-no" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const app = createTestApp();
    const token = await createToken();

    const res = await app.request("/api/proxy/v1/users", {
      headers: { Cookie: `test_sess_access_token=${token}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("upstream-says-no");
  });
});
