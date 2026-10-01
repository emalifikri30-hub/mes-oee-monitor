// Unit coverage for the actor helpers, and in particular for the ONE decision in
// them that can lock every operator out of the application: requireRole's
// treatment of an unset role.
//
// TODOS.md §34's whole shape is "ship it dark" — three optional variables, each
// meaning "do not check this mutation" when absent. The value of that default is
// entirely in it being impossible to get wrong, so it is asserted here rather
// than being left to the three services that depend on it.
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vite-plus/test";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono";

import { requireActor, requireRole } from "./actor.js";

import type { Actor } from "./actor.js";
import type { AppJwtPayload, AuthEnv } from "@molca/mes";

// requireActor takes a Hono Context, so the cheapest honest way to exercise it is
// through a one-route app whose middleware sets the payload — the same technique
// the handler suites use, and it keeps the Context real rather than a cast.
async function actorFrom(jwt: AppJwtPayload): Promise<{ status: number; body: unknown }> {
  const app = new Hono<AuthEnv>();
  app.use(
    "*",
    createMiddleware<AuthEnv>(async (c, next) => {
      c.set("jwtPayload", jwt);
      await next();
    }),
  );
  app.get("/", (c) => c.json(requireActor(c)));
  app.onError((err, c) =>
    err instanceof HTTPException
      ? c.json({ message: err.message }, err.status)
      : c.json({ message: "unexpected" }, 500),
  );

  const res = await app.request("/");
  return { status: res.status, body: await res.json() };
}

describe("requireActor", () => {
  it("reads subject, display name and realm roles off the token", async () => {
    const { status, body } = await actorFrom({
      sub: "kc-sub-1",
      preferred_username: "dewi",
      realm_access: { roles: ["oee-approver", "offline_access"] },
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      subject: "kc-sub-1",
      name: "dewi",
      roles: ["oee-approver", "offline_access"],
    });
  });

  // The durable identity is `sub`; the name is display-only and denormalised at
  // write time, so an absent one costs a label rather than a record.
  it("falls back preferred_username -> name -> null", async () => {
    expect((await actorFrom({ sub: "s", name: "Dewi Lestari" })).body).toMatchObject({
      name: "Dewi Lestari",
    });
    expect((await actorFrom({ sub: "s" })).body).toMatchObject({ name: null });
  });

  // ALWAYS an array, never undefined. A caller that had to handle both would
  // eventually handle only one, and the one it skipped would be the unroled token
  // — which is the case that must fail a check rather than skip it.
  it("yields [] rather than undefined when the token carries no roles", async () => {
    expect((await actorFrom({ sub: "s" })).body).toMatchObject({ roles: [] });
    expect((await actorFrom({ sub: "s", realm_access: { roles: [] } })).body).toMatchObject({
      roles: [],
    });
  });

  // 401 and not 400: a token that verified but carries no subject is an
  // authentication problem. It is also the single place in the codebase where an
  // undefined could reach a NOT NULL text column, which is why it is a guard and
  // never a `!`.
  it("401s a token with no usable subject", async () => {
    expect((await actorFrom({})).status).toBe(401);
    expect((await actorFrom({ sub: "" })).status).toBe(401);
  });

  // CLIENT ROLES ARE NOT READ, and this pins the reasoning in actor.ts rather
  // than restating it. `resource_access` would have to be keyed on a client id,
  // and the only one this service holds is its own service account — absent from
  // an operator's browser token, so the gate would have refused everyone.
  it("ignores resource_access roles", async () => {
    const { body } = await actorFrom({
      sub: "s",
      resource_access: { "mes-oee-monitor": { roles: ["oee-approver"] } },
    });

    expect(body).toMatchObject({ roles: [] });
  });
});

describe("requireRole", () => {
  const gate = { metric: "approve", message: "approve this shift report" };
  const actor = (roles: string[]): Actor => ({ subject: "s", name: null, roles });

  // THE ASSERTION THIS FILE EXISTS FOR. Every deployment today runs with all
  // three variables unset, so if this ever became a refusal, the gate would 403
  // every operator on every write path the moment it shipped — with reads still
  // working, so nothing else would look wrong.
  it("does nothing when no role is configured, even for an unroled actor", () => {
    expect(() => requireRole(actor([]), undefined, gate)).not.toThrow();
  });

  it("allows an actor holding the configured role", () => {
    expect(() => requireRole(actor(["oee-approver"]), "oee-approver", gate)).not.toThrow();
  });

  it("403s an actor without it", () => {
    expect(() => requireRole(actor(["something-else"]), "oee-approver", gate)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  // 403 rather than 401: the token is valid and the caller is known. A 401 would
  // send the browser to re-login, which cannot fix a missing role and loses
  // whatever was on screen.
  it("refuses with 403 and the operator-facing message, not the metric slug", () => {
    try {
      requireRole(actor([]), "oee-approver", gate);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).status).toBe(403);
      expect((err as HTTPException).message).toBe(
        "you are not permitted to approve this shift report",
      );
    }
  });

  // Exact membership, not a prefix or substring match — `oee-approver-readonly`
  // must not satisfy `oee-approver`.
  it("matches a role exactly", () => {
    expect(() => requireRole(actor(["oee-approver-readonly"]), "oee-approver", gate)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});
