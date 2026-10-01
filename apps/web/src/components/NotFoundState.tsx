import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

// Root notFoundComponent: an unmatched URL, or a loader that threw notFound()
// because core-api answered 404.
function NotFoundState() {
  const { t } = useTranslation("oee");

  return (
    <div className="flex min-h-svh w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="font-display text-7xl font-bold tracking-tight text-primary">404</span>
      <div className="space-y-1">
        <h1 className="font-display text-xl font-bold">{t("errors.notFound")}</h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{t("errors.notFoundBody")}</p>
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" asChild>
          <Link to="/">{t("common.backHome")}</Link>
        </Button>
      </div>
    </div>
  );
}

export { NotFoundState };
