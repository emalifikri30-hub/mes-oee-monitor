import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { http } from "@/lib/http";

// EVERY core-api CALL MUST CARRY THE PROXY PREFIX, and this file exists because
// three of them did not.
//
// `PROXY_PREFIX` in api.ts is a CONSTANT THAT PATHS ARE BUILT FROM — it is not an
// axios `baseURL`. So `http.get("/master-data/products")` compiles, type-checks,
// and requests a path the BFF never sees. The browser then falls through to the
// SPA's own index.html and the call resolves with **200 and an HTML body**, which
// axios hands back as a successful response.
//
// That is the worst shape a mistake can take here: not a 404, not a thrown error,
// but a resolved promise whose `data.data` is undefined — so the caller renders
// an empty picker and nothing anywhere reports a failure. It shipped that way and
// was found by a user looking at an empty SKU dropdown.
//
// A URL assertion is the only thing that catches it. The functions below are the
// ones added most recently; the guard generalises to any new call.
const PROXY_PREFIX = "/api/proxy/api/v1";

const get = vi.spyOn(http, "get");
const post = vi.spyOn(http, "post");

afterEach(() => {
  vi.clearAllMocks();
});

function ok<T>(data: T) {
  return { data: { data, error: null, meta: null } } as never;
}

describe("api paths reach the BFF proxy", () => {
  it.each([
    [
      "getRejectReasonOptions",
      async () => {
        const { getRejectReasonOptions } = await import("@/lib/api");
        await getRejectReasonOptions(9);
      },
    ],
    [
      "getLineProductOptions",
      async () => {
        const { getLineProductOptions } = await import("@/lib/api");
        await getLineProductOptions(9);
      },
    ],
    [
      "getProductDetail",
      async () => {
        const { getProductDetail } = await import("@/lib/api");
        await getProductDetail(4);
      },
    ],
    [
      "getQualityEntries",
      async () => {
        const { getQualityEntries } = await import("@/lib/api");
        await getQualityEntries({ subject: "line", grain: "shift", id: 7 });
      },
    ],
    [
      "getLinePerformance",
      async () => {
        const { getLinePerformance } = await import("@/lib/api");
        await getLinePerformance("shift", 7);
      },
    ],
  ])("%s requests a proxied path", async (_name, call) => {
    get.mockResolvedValue(ok([]));

    await call();

    const url = get.mock.calls[0]?.[0];
    expect(url).toBeTypeOf("string");
    // THE ASSERTION. A path missing this prefix resolves against the SPA and
    // returns HTML with a 200 — see the header. Sanity-checked against the exact
    // shape that shipped: "/master-data/products" must NOT satisfy it.
    expect("/master-data/products").not.toMatch(new RegExp(`^${PROXY_PREFIX}/`));
    expect(url as string).toMatch(new RegExp(`^${PROXY_PREFIX}/`));
  });

  it("createQualityEntry posts to a proxied path", async () => {
    post.mockResolvedValue(ok({ id: 1 }));

    const { createQualityEntry } = await import("@/lib/api");
    await createQualityEntry(
      { subject: "line", grain: "shift", id: 7 },
      {
        kind: "reject",
        productId: 4,
        quantity: 1,
        shift: 1,
        reasonId: 2,
        requestId: "00000000-0000-4000-8000-000000000000",
      },
    );

    expect(post.mock.calls[0]?.[0] as string).toMatch(new RegExp(`^${PROXY_PREFIX}/`));
  });

  // THE ADDRESS DECIDES THE PREFIX, and this is the assertion the type alone
  // cannot make: `QualityAddress` stops a machine report reaching these functions,
  // but a line and a SKU address are both admissible and must not resolve to the
  // same path. A SKU report id under /work-centers/day-reports names a table with
  // an independent identity sequence and answers with another line's ledger.
  it.each([
    [{ subject: "line", grain: "day", id: 7 } as const, "/work-centers/day-reports/7/"],
    [{ subject: "sku", grain: "day", id: 7 } as const, "/products/day-reports/7/"],
  ])("getQualityEntries sends %o to its own subject's path", async (address, fragment) => {
    get.mockResolvedValue(ok([]));

    const { getQualityEntries } = await import("@/lib/api");
    await getQualityEntries(address);

    expect(get.mock.calls[0]?.[0] as string).toContain(fragment);
  });

  it.each([
    [{ subject: "line", grain: "day", id: 7 } as const, "/work-centers/day-reports/7/"],
    [{ subject: "sku", grain: "day", id: 7 } as const, "/products/day-reports/7/"],
  ])("voidQualityEntry sends %o to its own subject's path", async (address, fragment) => {
    post.mockResolvedValue(ok({ id: 1 }));

    const { voidQualityEntry } = await import("@/lib/api");
    await voidQualityEntry(address, 12, "miskeyed");

    const url = post.mock.calls[0]?.[0] as string;
    expect(url).toContain(fragment);
    expect(url).toContain("/quality-entries/12/void");
  });

  // The one path that deliberately does NOT carry it: /api/me is the BFF's own
  // session probe, not a core-api resource, so it is proxied by nothing.
  it("still reaches the BFF's own session probe directly", async () => {
    get.mockResolvedValue(ok({ sub: "kc-1" }));

    const { getMe } = await import("@/lib/api");
    await getMe();

    expect(get.mock.calls[0]?.[0]).toBe("/api/me");
  });
});
