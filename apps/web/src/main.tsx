import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";

import "./index.css";
import { i18n } from "@/lib/i18n";
import { queryClient } from "@/lib/query-client";
import { Toaster } from "@/components/ui/sonner";
import { router } from "@/router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        {/* Mounted at the root rather than inside the authenticated shell. With
          autoCodeSplitting off (see vite.config.ts) the position makes no
          difference to the bundle — sonner is in the entry chunk either way —
          so it goes where every route can reach it. */}
        <Toaster />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
