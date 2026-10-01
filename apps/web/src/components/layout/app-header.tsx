import { Link, useMatches, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AreaSelect } from "@/components/layout/area-select";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LanguageSwitcher } from "@/components/switcher/language-switcher";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

import type { FileRouteTypes } from "@/routeTree.gen";

// Pulls the page title/breadcrumbs from the deepest matched route's staticData
// (declared per route file, typed by the StaticDataRouteOption augmentation in
// router.ts), so the header follows the current path with no prop drilling.
function useRouteMeta() {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const data = matches[i]?.staticData;
    if (data?.title) return data;
  }
  return undefined;
}

// `to` is the literal union from the generated route tree, NOT `string`, so the
// <Link> below is checked against the same type router.ts's
// StaticDataRouteOption declares. That declaration was already narrow, so a
// renamed route has always broken the build at the staticData site; widening
// here meant the call site itself accepted any string, which made this component
// the one place a crumb built outside staticData could go stale unnoticed.
//
// PARAMS COME FROM THE ACTIVE MATCH, not from the crumb — staticData is
// evaluated once per route file and cannot know a $reportId. Every parametrised
// crumb targets a path-ANCESTOR of the current route, so the active match's
// params are always a superset of what any crumb in the trail needs. A crumb
// wanting a param the current route lacks would be a crumb unreachable from
// here: a bug in the trail, not something to type around. TanStack ignores
// params a given `to` does not use, which is what lets one object serve them
// all.
function Breadcrumbs({
  crumbs,
  params,
}: {
  crumbs: { label: string; to?: FileRouteTypes["to"] }[];
  params: Record<string, string | undefined>;
}) {
  const { t } = useTranslation("oee");

  return (
    <nav aria-label={t("common.breadcrumb")} className="text-muted-foreground truncate text-sm">
      {crumbs.map((crumb, i) => {
        const label = t(crumb.label, { defaultValue: crumb.label });
        return (
          <span key={`${crumb.label}-${i}`}>
            {i > 0 ? <span className="px-1.5">›</span> : null}
            {crumb.to ? (
              <Link
                to={crumb.to}
                params={params}
                className="hover:text-foreground transition-colors"
              >
                {label}
              </Link>
            ) : (
              label
            )}
          </span>
        );
      })}
    </nav>
  );
}

function AppHeader() {
  const { t } = useTranslation("oee");
  const meta = useRouteMeta();
  // `strict: false` because this component is mounted above every route and so
  // belongs to none of them: it gets whatever the active match happens to carry.
  const params = useParams({ strict: false });

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 h-4" />
        <div className="min-w-0">
          <h1 className="truncate text-sm leading-tight font-semibold">
            {meta?.title ? t(meta.title, { defaultValue: meta.title }) : ""}
          </h1>
          {meta?.breadcrumbs?.length ? (
            <Breadcrumbs crumbs={meta.breadcrumbs} params={params} />
          ) : meta?.description ? (
            <p className="text-muted-foreground truncate text-sm">
              {t(meta.description, { defaultValue: meta.description })}
            </p>
          ) : null}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div className="hidden items-center gap-1 sm:flex">
          <AreaSelect />
        </div>
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}

export { AppHeader };
