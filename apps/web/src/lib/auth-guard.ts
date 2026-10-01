import { redirect } from "@tanstack/react-router";

import { meQueryOptions } from "@/lib/queries";

import type { QueryClient } from "@tanstack/react-query";
import type { Me } from "@/lib/types";

// Typed structurally rather than against the router's own beforeLoad argument type,
// so one guard drops into every authenticated route without naming each route id.
type GuardArgs = {
  context: { queryClient: QueryClient };
  location: { href: string };
};

// getMe() maps 401/403 -> null, which lets us keep two failures apart:
//   null  => not signed in       -> bounce to /login, remembering where we were
//   throw => BFF/IdP unreachable -> propagate to the route errorComponent
async function requireAuth({ context, location }: GuardArgs): Promise<{ me: Me }> {
  const me = await context.queryClient.ensureQueryData(meQueryOptions);
  if (!me) {
    throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
  }
  return { me };
}

export { requireAuth };
