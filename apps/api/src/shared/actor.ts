import { HTTPException } from "hono/http-exception";

import {
  getOperatorAuthorizationDenialsCounter,
  getOperatorAuthorizationGrantsCounter,
} from "./observability/metrics.js";

import type { AppJwtPayload, AuthEnv } from "@molca/mes";
import type { Context } from "hono";

// WHO is behind an operator mutation, as read off the verified token.
//
// WHY THIS IS IN shared/ AND NOT IN module/work-unit/
//
// It started as `requireApprover` in work-unit-handler.ts, because approving a
// shift report was the first write this service had. It moved here the moment a
// SECOND handler needed it: the downtime edit stamps
// oee.downtime_report_history.changed_by from the same claim, by the same rule.
//
// A second copy would be worse than most duplication. The `sub` guard below is
// the ONE place in the codebase where an undefined would reach a NOT NULL text
// column, and a copy that drifted into `jwt.sub!` would insert the string
// "undefined" as an operator's identity — into an audit trail, which is the one
// place a wrong answer is worse than no answer.
//
// RENAMED FROM Approver / requireApprover. The old name described one of its two
// callers, and a helper in the auth path whose name misstates its scope is the
// kind of thing this codebase's comments exist to prevent.

// `subject` is the Keycloak `sub` and is what lands in the database; `name` is
// preferred_username for display and may be absent. The handler is responsible
// for proving `subject` exists — see requireActor — because a missing one is an
// authentication problem, not a domain one.
type Actor = {
  subject: string;
  name: string | null;
  // Realm roles off the verified token, for the gate in TODOS.md §34. Always an
  // array, never undefined, so a caller cannot forget the absent case — an
  // unroled token yields [] and fails every check rather than skipping them.
  roles: string[];
};

// The name of the role a mutation requires, or undefined for "not gated".
type RequiredRole = string | undefined;

// REALM ROLES ONLY, and the alternative was not merely harder — it was WRONG.
//
// A Keycloak token carries roles in two places: `realm_access.roles`, which is
// realm-wide, and `resource_access[<client>].roles`, which is per client. The
// obvious implementation reads the second one keyed on `config.oidc.clientId`,
// and that key is the wrong value: it is consumed in exactly one place
// (infra-module.ts, `createServiceTokenProvider`) as THIS SERVICE'S OWN service
// account for calling master-data. `.env.example` says so outright — "It must be
// THIS service's own client — not the callee's". The operator's browser token is
// issued to the BFF's client, so `resource_access[oidc.clientId]` is absent on
// every real request and the gate would 403 every operator the moment it was
// enabled. That is precisely the failure §34 exists to avoid.
//
// So the check is realm-scoped, where there is no key to get wrong. If the realm
// turns out to define these as CLIENT roles instead, the fix needs a new config
// value naming the browser-facing client — a known question with a known answer,
// asked before enabling anything rather than discovered in production.
function actorRoles(jwt: AppJwtPayload): string[] {
  return jwt.realm_access?.roles ?? [];
}

// `sub` is `string | undefined` on jose's JWTPayload, and this is the ONE place
// in the codebase where an undefined would reach a NOT NULL text column — so it
// is a guard and never a `!`. A token that authenticated but carries no subject
// is an authentication problem, not a domain one, hence 401 rather than 400.
//
// `preferred_username` falls back to `name` and then to null: it is display-only
// and denormalised at write time, so an absent one costs a label, not a record.
// The durable identity is always `sub`.
function requireActor(c: Context<AuthEnv>): Actor {
  const jwt = c.get("jwtPayload");
  const subject = jwt.sub;
  if (subject === undefined || subject === "") {
    throw new HTTPException(401, { message: "token carries no subject" });
  }
  return {
    subject,
    name: jwt.preferred_username ?? jwt.name ?? null,
    roles: actorRoles(jwt),
  };
}

// The gate, and the ONE place the opt-in default lives.
//
// That centralisation is the whole point rather than tidiness. If each service
// wrote `if (role !== undefined && !actor.roles.includes(role))` for itself, the
// first one to drop the undefined check would 403 every operator on that route
// the moment ANY of the three vars was set — a rollout failure caused by a
// mutation nobody was rolling out. Here the unset case is impossible to forget.
//
// 403 and not 401: the token is valid and the caller is known. Saying
// "unauthenticated" would send the browser to re-login, which cannot help and
// loses whatever they had on screen.
//
// TWO STRINGS, deliberately, because they answer to different readers and one
// cannot serve both. `metric` is a bounded slug and becomes a Prometheus label
// (prose there would be unusable as a series name and unstable across edits);
// `message` goes straight into the response envelope via app.onError, so an
// operator reads "you are not permitted to approve this shift report" and learns
// what was refused rather than which constant failed.
//
// An object rather than two positional strings: they are both strings and both
// describe the same action, so a swap would typecheck and produce a metric
// labelled with a sentence.
type RoleGate = { metric: string; message: string };

function requireRole(actor: Actor, required: RequiredRole, gate: RoleGate): void {
  if (required === undefined) {
    return;
  }

  if (!actor.roles.includes(required)) {
    // Counted BEFORE the throw, not in a catch upstream: app.onError sees an
    // HTTPException and cannot tell a role refusal from any other 403 without
    // re-inspecting the message, which is exactly the coupling this avoids.
    getOperatorAuthorizationDenialsCounter().add(1, { action: gate.metric });
    throw new HTTPException(403, { message: `you are not permitted to ${gate.message}` });
  }

  // Only reached when a gate is ENABLED and satisfied — the undefined case
  // returned above. That is deliberate: it makes a non-zero grant rate mean "this
  // gate is on and working", which is what the misconfiguration alert subtracts
  // against, and what tells an operator mid-rollout that the variable took effect.
  getOperatorAuthorizationGrantsCounter().add(1, { action: gate.metric });
}

export { requireActor, requireRole };
export type { Actor, RequiredRole, RoleGate };
