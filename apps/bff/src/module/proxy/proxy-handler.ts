// DO NOT ADD BODY-READING MIDDLEWARE ABOVE THIS ROUTE.
// This handler forwards c.req.raw.body as a ReadableStream. Any upstream
// middleware that calls c.req.json() / .text() / .parseBody() will consume
// the stream and either buffer uploads in memory (OOM risk) or break
// proxying entirely. Keep this sub-app's middleware stack minimal: auth only.
//
//
// Request flow:
//
//   client                BFF proxy sub-app                core-api
//     |                         |                             |
//     |-- /api/proxy/<rest> --->|                             |
//     |                         | authMiddleware (401/403)    |
//     |                         | path validation             |
//     |                         |   (allowlist + .. + %2f)    |
//     |                         | method allowlist            |
//     |                         | filter request headers      |
//     |                         | inject Authorization: Bearer|
//     |                         | AbortSignal.any([client,    |
//     |                         |   upstreamTimeout])         |
//     |                         | fetch(streaming body) ----> |
//     |                         |                             | response
//     |                         | filter response headers     |
//     |                         |   (drop Set-Cookie etc.)    |
//     |                         | return Response(stream) --->|
//     | <--------- streaming response --------                |

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "../../shared/config/config.js";
import type { AuthEnv } from "@molca/mes";
import { WebResponse } from "@molca/network";
import { REQUEST_DROP, RESPONSE_DROP, filterHeaders } from "./proxy-headers.js";
import { baseLogger, getRequestContext } from "@molca/observability";

type ProxyHandlerDeps = {
  config: AppConfig;
  authMw: MiddlewareHandler<AuthEnv>;
};

const PROXY_MOUNT = "/api/proxy";

const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const METHODS_WITHOUT_BODY: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

// Percent-encoded slashes or backslashes must never pass through, since the
// upstream may interpret them differently from the allowlist check.
const DENIED_ENCODED = /%2f|%2F|%5c|%5C|%00/;

type PathValidationResult =
  | { ok: true; upstreamPath: string }
  | { ok: false; status: 400 | 403; error: string };

function validateUpstreamPath(
  rawPath: string,
  allowedPrefixes: readonly string[],
): PathValidationResult {
  if (rawPath === "" || rawPath === "/") {
    return { ok: false, status: 403, error: "path not allowed" };
  }
  if (DENIED_ENCODED.test(rawPath)) {
    return { ok: false, status: 400, error: "invalid path encoding" };
  }
  // Segment-level traversal check.
  for (const segment of rawPath.split("/")) {
    if (segment === ".." || segment === ".") {
      return { ok: false, status: 400, error: "invalid path" };
    }
  }
  if (!allowedPrefixes.some((p) => rawPath.startsWith(p))) {
    return { ok: false, status: 403, error: "path not allowed" };
  }
  return { ok: true, upstreamPath: rawPath };
}

function createProxyHandler({ config, authMw }: ProxyHandlerDeps) {
  const app = new Hono<AuthEnv>();
  const cookieName = config.cookie.name;
  const accessTokenCookieName = `${cookieName}_access_token`;

  app.use("*", authMw);

  app.all("*", async (c) => {
    const method = c.req.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      return c.json(WebResponse.builder<string>().error("method not allowed").build(), 405);
    }

    // Parse the raw, unresolved request URL so percent-encoded slashes are
    // visible (Hono's c.req.path may normalize them away).
    const incoming = new URL(c.req.raw.url);
    if (!incoming.pathname.startsWith(PROXY_MOUNT)) {
      return c.json(WebResponse.builder<string>().error("path not allowed").build(), 403);
    }
    const rest = incoming.pathname.slice(PROXY_MOUNT.length);

    const validation = validateUpstreamPath(rest, config.proxy.allowedPrefixes);
    if (!validation.ok) {
      return c.json(
        WebResponse.builder<string>().error(validation.error).build(),
        validation.status,
      );
    }

    const accessToken = getCookie(c, accessTokenCookieName);
    if (!accessToken) {
      // authMw should have caught this; defense in depth.
      return c.json(WebResponse.builder<string>().error("token not found").build(), 401);
    }

    // Preserve the raw query string (including + vs %20 and repeated keys)
    // by string-concatenating incoming.search instead of going through
    // URLSearchParams which would normalize.
    const upstreamUrl = config.coreApi.baseUrl + validation.upstreamPath + incoming.search;

    const requestHeaders = filterHeaders(c.req.raw.headers, REQUEST_DROP);
    requestHeaders.set("authorization", `Bearer ${accessToken}`);
    // Forward the correlation id the BFF actually used (the observability
    // middleware mints one when the client omits x-trace-id). The raw incoming
    // headers wouldn't carry a BFF-generated id, so set it explicitly. The
    // W3C traceparent is injected automatically by the OTel undici instrumentation.
    const ctx = getRequestContext();
    if (ctx) requestHeaders.set("x-trace-id", ctx.traceId);

    const body = METHODS_WITHOUT_BODY.has(method) ? undefined : c.req.raw.body;

    const upstreamSignal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(config.proxy.upstreamTimeoutMs),
    ]);

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method,
        headers: requestHeaders,
        body,
        signal: upstreamSignal,
        redirect: "manual",
        // @ts-expect-error duplex is required by the Fetch spec when sending
        // a streaming request body; supported by Bun and undici.
        duplex: "half",
      });
    } catch (err) {
      // Client already disconnected — nothing to send.
      if (c.req.raw.signal.aborted) {
        return c.body(null, 499 as 200);
      }
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError") {
        return c.json(WebResponse.builder<string>().error("upstream timeout").build(), 504);
      }
      (getRequestContext()?.logger ?? baseLogger)
        .withMetadata({ upstreamUrl })
        .withError(err)
        .error("proxy_upstream_failed");
      return c.json(WebResponse.builder<string>().error("upstream unavailable").build(), 502);
    }

    const responseHeaders = filterHeaders(upstream.headers, RESPONSE_DROP);

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  });

  return app;
}

export { createProxyHandler, validateUpstreamPath, PROXY_MOUNT };
export type { ProxyHandlerDeps };
