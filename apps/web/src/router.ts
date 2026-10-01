import { createRouter } from "@tanstack/react-router";

import { queryClient } from "@/lib/query-client";
import { routeTree } from "@/routeTree.gen";

import type { FileRouteTypes } from "@/routeTree.gen";

// Kept JSX-free (.ts, not .tsx) so oxlint's react/only-export-components never
// applies here — it only scans .tsx/.jsx.
const router = createRouter({
  routeTree,
  context: { queryClient },
  // Preload on hover/focus. React Query already owns data freshness, so don't add
  // a second staleness layer on top of the query cache.
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

// Registers this router's types globally, so <Link to>, useSearch, useParams and
// redirect() are all checked against the real route tree.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }

  // Per-route page metadata surfaced in the header. Each page route sets
  // `staticData`, and components/layout/app-header.tsx reads it off the deepest
  // match, so the title/description follow the path with no prop drilling.
  //
  // `breadcrumbs` is the trail under the title. A crumb with no `to` renders as
  // plain text — that is how the current page, and unreachable grouping levels
  // like "Machine", stay non-clickable. `to` is drawn from the generated route
  // tree rather than typed `string`, so a renamed route breaks the build instead
  // of shipping a dead crumb.
  //
  // A crumb deliberately carries NO `params`. staticData is evaluated once per
  // route file, so it cannot know a `$reportId`; components/layout/app-header.tsx
  // supplies them from the active match instead, which works because every
  // parametrised crumb targets a path-ancestor of the current route. Keep `to`
  // narrow on both sides of that boundary — the header widened it to `string`
  // for a while, which let its <Link> accept a path the route tree does not have.
  interface StaticDataRouteOption {
    title?: string;
    description?: string;
    breadcrumbs?: { label: string; to?: FileRouteTypes["to"] }[];
  }
}

export { router };
