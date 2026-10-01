import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDownIcon } from "lucide-react";

import { CURRENT_APP, CURRENT_APP_KEY, MES_APPS } from "@/lib/mes-apps";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * Sidebar switcher that jumps between the MES apps. Each app is a separate
 * deployment, so selecting one navigates to its URL. The current app is
 * highlighted; apps without a URL show Soon and do not navigate.
 */
export function AppSwitcher() {
  const { isMobile } = useSidebar();
  const { t } = useTranslation("oee");
  const CurrentIcon = CURRENT_APP.icon;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <CurrentIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {t(`apps.names.${CURRENT_APP_KEY}`, { defaultValue: CURRENT_APP.name })}
                </span>
                <span className="truncate text-xs">{t("apps.suite")}</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-56"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("apps.label")}
            </DropdownMenuLabel>
            {MES_APPS.map((app) => {
              const isCurrent = app.key === CURRENT_APP_KEY;
              const href = app.url;
              const available = Boolean(href) || isCurrent;
              return (
                <DropdownMenuItem
                  key={app.key}
                  disabled={!available}
                  onSelect={() => {
                    if (!isCurrent && href) window.location.href = href;
                  }}
                  className="gap-2 p-2"
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    <app.icon className="size-4 shrink-0" />
                  </div>
                  <span className="flex-1 truncate">
                    {t(`apps.names.${app.key}`, { defaultValue: app.name })}
                  </span>
                  {isCurrent ? (
                    <Check className="size-4" />
                  ) : !href ? (
                    <span className="text-xs text-muted-foreground">{t("apps.soon")}</span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={cn("gap-2 p-2 font-medium")}
              disabled={!MES_APPS.find((app) => app.key === "portal")?.url}
              onSelect={() => {
                const portalUrl = MES_APPS.find((app) => app.key === "portal")?.url;
                if (portalUrl) window.location.href = portalUrl;
              }}
            >
              <LayoutGridDot />
              {t("apps.openPortal")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function LayoutGridDot() {
  return (
    <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
      <span className="grid grid-cols-2 gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="size-1 rounded-[1px] bg-muted-foreground" />
        ))}
      </span>
    </div>
  );
}
