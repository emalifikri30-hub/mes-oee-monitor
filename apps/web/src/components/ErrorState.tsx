import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AlertCircleIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// Root errorComponent. Reached when a loader or guard *throws* — which, thanks to
// getMe() mapping 401/403 to null, means something is actually broken rather than
// "the user isn't signed in".
function ErrorState({ error, reset }: { error: Error; reset?: () => void }) {
  const { t } = useTranslation("oee");

  return (
    // Centers itself: this is the root errorComponent, and __root renders a bare
    // <Outlet />, so nothing above supplies a container.
    <div className="flex min-h-svh w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="font-display text-7xl font-bold tracking-tight text-primary">500</span>
      <Alert variant="destructive" className="max-w-md text-left">
        <AlertCircleIcon />
        <AlertTitle>{t("common.somethingWrong")}</AlertTitle>
        <AlertDescription>{error.message || t("common.serverUnreachable")}</AlertDescription>
      </Alert>
      <div className="flex gap-2">
        {reset ? (
          <Button variant="outline" size="sm" onClick={reset}>
            {t("common.tryAgain")}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">{t("common.backHome")}</Link>
        </Button>
      </div>
    </div>
  );
}

export { ErrorState };
