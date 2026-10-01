import { createFileRoute, redirect } from "@tanstack/react-router";

import { meQueryOptions } from "@/lib/queries";
import { Welcome } from "@/components/Welcome";

type LoginSearch = {
  redirect?: string;
  reason?: "expired";
};

// Hand-rolled rather than zod: this is the client-side open-redirect guard and it
// deliberately mirrors sanitizeReturnPath in apps/bff/src/module/auth/auth-service.ts.
// A handful of explicit checks a reviewer can diff against the BFF beats a schema,
// and it keeps a validation library out of the browser bundle.
function validateSearch(search: Record<string, unknown>): LoginSearch {
  const raw = search.redirect;
  const safe =
    typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes(":");

  return {
    redirect: safe ? raw : undefined,
    reason: search.reason === "expired" ? "expired" : undefined,
  };
}

export const Route = createFileRoute("/login")({
  validateSearch,
  // Already signed in? Don't show a sign-in page. `.catch(() => null)` so an
  // unreachable BFF still renders the card rather than the error boundary.
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions).catch(() => null);
    if (me) throw redirect({ href: search.redirect ?? "/", replace: true });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect: returnTo, reason } = Route.useSearch();

  // This route owns its own centering. __root deliberately renders a bare
  // <Outlet /> so the _app layout can take the full viewport for the sidebar
  // shell, which means /login gets no container from above.
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4 pb-20">
      <Welcome returnTo={returnTo ?? "/"} reason={reason} />
    </main>
  );
}
