import { describe, it, expect } from "vite-plus/test";
import { HOP_BY_HOP, REQUEST_DROP, RESPONSE_DROP, filterHeaders } from "./proxy-headers.js";

describe("proxy-headers", () => {
  describe("list integrity", () => {
    it("HOP_BY_HOP contains the RFC 7230 hop-by-hop header names", () => {
      for (const name of [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ]) {
        expect(HOP_BY_HOP).toContain(name);
      }
    });

    it("REQUEST_DROP strips client authorization, cookie, host, and content-length", () => {
      expect(REQUEST_DROP).toContain("authorization");
      expect(REQUEST_DROP).toContain("cookie");
      expect(REQUEST_DROP).toContain("host");
      expect(REQUEST_DROP).toContain("content-length");
      // And still covers hop-by-hop.
      for (const name of HOP_BY_HOP) {
        expect(REQUEST_DROP).toContain(name);
      }
    });

    it("RESPONSE_DROP strips upstream set-cookie", () => {
      expect(RESPONSE_DROP).toContain("set-cookie");
      for (const name of HOP_BY_HOP) {
        expect(RESPONSE_DROP).toContain(name);
      }
    });

    it("REQUEST_DROP does NOT strip x-tenant-id", () => {
      // Contract for TODO #25: core-api's tenantMiddleware reads X-Tenant-Id
      // from the proxied request to resolve the active tenant. Adding this
      // header to REQUEST_DROP would silently break every authenticated API
      // call.
      expect(REQUEST_DROP).not.toContain("x-tenant-id");

      const source = new Headers();
      source.set("X-Tenant-Id", "tenant-acme");
      const filtered = filterHeaders(source, REQUEST_DROP);
      expect(filtered.get("x-tenant-id")).toBe("tenant-acme");
    });
  });

  describe("filterHeaders", () => {
    it("drops names case-insensitively", () => {
      const source = new Headers();
      source.set("Authorization", "Bearer abc");
      source.set("Content-Type", "application/json");
      source.set("X-Request-Id", "r1");

      const filtered = filterHeaders(source, ["authorization"]);

      expect(filtered.get("authorization")).toBeNull();
      expect(filtered.get("content-type")).toBe("application/json");
      expect(filtered.get("x-request-id")).toBe("r1");
    });

    it("preserves multi-value headers that are not dropped", () => {
      const source = new Headers();
      source.append("accept", "text/html");
      source.append("accept", "application/json");

      const filtered = filterHeaders(source, ["authorization"]);

      const accept = filtered.get("accept");
      expect(accept).toContain("text/html");
      expect(accept).toContain("application/json");
    });

    it("returns an empty Headers when all entries are dropped", () => {
      const source = new Headers({ cookie: "s=1" });
      const filtered = filterHeaders(source, ["cookie"]);
      expect([...filtered.keys()]).toEqual([]);
    });
  });
});
