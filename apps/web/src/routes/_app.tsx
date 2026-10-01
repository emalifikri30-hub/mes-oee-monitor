import { Outlet, createFileRoute } from "@tanstack/react-router";

import { requireAuth } from "@/lib/auth-guard";
import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AreaProvider } from "@/components/layout/area-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pathless layout route (the `_` prefix contributes no URL segment) holding the
// authenticated app shell. Two jobs, both of which it does exactly once for every
// page underneath it:
//
//   1. `beforeLoad: requireAuth` gates the whole subtree. Because it runs before
//      the component mounts, an unauthenticated visitor never renders a frame of
//      protected UI — no loader flash, no chrome around an empty page. That is
//      why there is no <RequireAuth> wrapper component here.
//   2. Its `{ me }` return merges into the router context, so child routes read
//      `Route.useRouteContext().me` instead of each calling useMe().
//
// /login is a sibling of this route, not a child, so it stays reachable and
// renders without the sidebar.
export const Route = createFileRoute("/_app")({
  beforeLoad: requireAuth,
  component: AppLayout,
});

function AppLayout() {
  return (
    // AreaProvider wraps both the header (which sets the area) and the outlet
    // (whose pages scope their line filter to it), so it has to sit above both.
    <TooltipProvider delayDuration={0}>
      <AreaProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <AppHeader />
            <main className="flex-1 p-4 md:p-6">
              <Outlet />
            </main>
          </SidebarInset>
        </SidebarProvider>
      </AreaProvider>
    </TooltipProvider>
  );
}
