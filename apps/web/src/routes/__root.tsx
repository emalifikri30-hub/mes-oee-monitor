import { useEffect } from "react";
import { Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";

import { onSessionExpired } from "@/lib/http";
import { meKey } from "@/lib/queries";
import { applyStoredLanguage, i18n, registerMessages } from "@/lib/i18n";
import en from "@/lib/locales/en.json";
import id from "@/lib/locales/id.json";
import { ErrorState } from "@/components/ErrorState";
import { NotFoundState } from "@/components/NotFoundState";

import type { QueryClient } from "@tanstack/react-query";

registerMessages("oee", { en, id });

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
  errorComponent: ErrorState,
  notFoundComponent: NotFoundState,
});

function RootLayout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  // The axios refresh interceptor lives outside React; when a refresh fails it
  // broadcasts here. Drop every cached response, then bounce to /login carrying
  // the current URL so signing back in returns the user to it.
  //
  // `clear()` rather than removing named keys: everything in the cache was
  // fetched as the now-expired user, and on shared hardware the next person to
  // sign in must not see any of it. It also means a new resource is covered
  // automatically instead of silently surviving logout until someone remembers
  // to add its key here.
  useEffect(() => {
    return onSessionExpired(() => {
      queryClient.clear();
      // After clear(), so `me` is authoritatively null rather than absent —
      // requireAuth distinguishes the two.
      queryClient.setQueryData(meKey, null);

      const { pathname, href } = router.state.location;
      // Load-bearing: without it, a 401 fired while already on /login nests the
      // redirect into itself (/login?redirect=%2Flogin%3Fredirect%3D…).
      if (pathname === "/login") return;
      void router.navigate({
        to: "/login",
        search: { redirect: href, reason: "expired" },
        replace: true,
      });
    });
  }, [queryClient, router]);

  useEffect(() => {
    applyStoredLanguage();
  }, []);

  // No chrome here. The sidebar shell belongs to the _app layout route, which is
  // gated by requireAuth — /login is a sibling and must render bare.
  return (
    <I18nextProvider i18n={i18n}>
      <Outlet />
    </I18nextProvider>
  );
}
