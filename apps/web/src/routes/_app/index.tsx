import { createFileRoute, redirect } from "@tanstack/react-router";

// `/` RENDERS NOTHING — IT IS A REDIRECT, FOR THE DEMO.
//
// The placeholder dashboard that used to live here was hidden rather than
// deleted, and the route file stays for the same reason its old comment gave:
// `/` is what every post-login redirect falls back to. `DEFAULT_RETURN_PATH` in
// apps/bff/src/module/auth/auth-service.ts is `/`, /login's own beforeLoad uses
// `search.redirect ?? "/"`, and both ErrorState and NotFoundState link "Back to
// home" here. Deleting the route would 404 all four; redirecting from it sends
// all four to the same screen with no other file to keep in step.
//
// So the post-login destination is set HERE, not in the BFF: the BFF decides
// only which deep links are allowed back (ALLOWED_PREFIXES), and `/` staying its
// default is what routes a plain sign-in through this redirect.
//
// `beforeLoad` rather than a component that navigates, so no frame of an empty
// dashboard renders first. The _app layout route above already ran requireAuth,
// and it runs BEFORE this: an unauthenticated visitor is still bounced to
// /login, not to the dashboard behind it.
//
// To give `/` a landing page again, replace the redirect with a `component`.
export const Route = createFileRoute("/_app/")({
  beforeLoad: () => {
    throw redirect({ to: "/oee-performance/machine/monthly", replace: true });
  },
});
