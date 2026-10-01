import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BarChart2Icon, ChevronDownIcon, ChevronLeftIcon, ClipboardListIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { UserMenu } from "@/components/layout/user-menu";
import { AppSwitcher } from "@/components/switcher/app-switcher";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

import type { LucideIcon } from "lucide-react";

// Single source for the nav. A node is exactly one of three things:
//   `to`       -> a link; the route must exist in src/routes or the build fails
//   `children` -> a collapsible group
//   neither    -> a disabled placeholder for a screen that isn't built yet
//
// Adding a real route means adding the file under src/routes/_app/ AND, if it
// introduces a new top-level path segment, allow-listing that segment in
// ALLOWED_PREFIXES in apps/bff/src/module/auth/auth-service.ts — otherwise
// signing in from a deep link silently lands on the dashboard instead.
// `/oee-performance` is the worked example: it was the third case above for
// months, and shipping its first screen meant touching this file AND that one.
type NavNode = {
  label: string;
  icon?: LucideIcon;
  to?: string;
  children?: NavNode[];
};

// FACTORY is sliced three ways, has no routes and no endpoints, and so carries no
// `to` and renders greyed out. A greyed row is a PROMISE — "this is coming" — which
// is exactly what it means there.
//
// THIS CONSTANT USED TO BE SHARED WITH AREA AND IS NOT ANY MORE, and the reason is
// not that Area shipped. Area is sliced TWO ways, not three: the requirement is
// explicit that it "only have 2 type of report on the Area — daily and monthly", so
// By Shift is not a promise there, it is a row that would never be filled. Factory
// keeps all three, and gains a fourth eventually — contract §23.2 says factory is
// the only subject that needs a YEAR grain, and nothing in the schema or the grain
// plumbing admits one yet (TODOS.md §74).
//
// SKU DOES NOT SHARE IT EITHER, AND ITS OTHER TWO GRAINS ARE GONE RATHER THAN GREY.
// SKU HAS ONE GRAIN. oee.product_report_wc_day (migration 0023) is a day table
// with no shift or month sibling: a shift-grain SKU report would need a table that
// does not exist, and a month is this one widened over an interval, which nothing
// has asked for. There is nothing to promise, so there is no row to promise it —
// the previous version greyed them out and spent nine lines explaining that this
// grey meant something different from Area's, which is a distinction no operator
// can see.
//
// Stated here rather than left as a diff so the next person does not "finish" SKU
// by adding By Shift and By Monthly back, or "finish" Area by adding By Shift,
// pointed at routes that cannot exist.
// const PERIODS: NavNode[] = [{ label: "By Shift" }, { label: "By Day" }, { label: "By Monthly" }];

const NAV: NavNode[] = [
  // DASHBOARD IS HIDDEN FOR THE DEMO, and the row is commented out rather than
  // deleted because `/` still exists — it redirects to the first OEE Performance
  // screen (src/routes/_app/index.tsx). Restoring the row is uncommenting it AND
  // giving that route a component again; doing only the first points an operator
  // at a row that bounces them somewhere else.
  // { label: "Dashboard", to: "/", icon: HouseIcon },
  // OEE PERFORMANCE — THREE SUBJECTS, AND THE ONE THAT IS ABSENT IS THE RULE.
  //
  // Machine, Line and Area each have a Gold table at BOTH coarse grains, so each is
  // a group of two real links. "Machine is a group of one so the second subject is a
  // sibling rather than a restructure" is how this node shipped; it was, twice —
  // once for the subjects and once for the grain, neither costing a restructure.
  //
  // FACTORY STILL CARRIES NO GREYED ROW, and that is the same call this file makes
  // for SKU below. A greyed row is a PROMISE — "this is coming" — and factory is not
  // one promise away: `oee.factory_*` does not exist, and `SCOPE_COLUMN` has no
  // `factory_id` to map, so its three downtime Paretos could not be drawn even if a
  // tile list were invented for it. (`oee.downtime_reports` would need its own
  // column; contract §3.2 asked for both and only `area_*` landed.) TODOS.md §74
  // holds both halves.
  //
  // THE GRAIN HALF OF §74 IS ANSWERED and this comment used to say otherwise. It
  // read "factory needs a YEAR grain REPORT_GRAINS does not admit". What remains for
  // factory is a table and an answer from the pipeline owner — not a grain.
  //
  // LEAF LABELS REPEAT THE SUBJECT ("Line Monthly", not "Monthly") because each must
  // match its destination's `staticData.title` and its last breadcrumb — the only
  // thing connecting a row an operator clicked to the page that opened.
  {
    label: "nav.oeePerformance",
    icon: BarChart2Icon,
    children: [
      {
        label: "nav.machine",
        children: [
          { label: "nav.byMonth", to: "/oee-performance/machine/monthly" },
          { label: "nav.byYear", to: "/oee-performance/machine/yearly" },
        ],
      },
      {
        label: "nav.line",
        children: [
          { label: "nav.byMonth", to: "/oee-performance/line/monthly" },
          { label: "nav.byYear", to: "/oee-performance/line/yearly" },
        ],
      },
      {
        label: "nav.area",
        children: [
          { label: "nav.byMonth", to: "/oee-performance/area/monthly" },
          { label: "nav.byYear", to: "/oee-performance/area/yearly" },
        ],
      },
    ],
  },
  {
    label: "nav.report",
    icon: ClipboardListIcon,
    children: [
      {
        label: "nav.machine",
        children: [
          { label: "nav.byShift", to: "/report/machine/by-shift" },
          { label: "nav.byDay", to: "/report/machine/by-day" },
          { label: "nav.byMonthly", to: "/report/machine/by-monthly" },
        ],
      },
      {
        label: "nav.line",
        children: [
          { label: "nav.byShift", to: "/report/line/by-shift" },
          { label: "nav.byDay", to: "/report/line/by-day" },
          { label: "nav.byMonthly", to: "/report/line/by-monthly" },
        ],
      },
      // ONE CHILD, AND IT STAYS A GROUP. Kept collapsible rather than promoted to
      // a bare "SKU" link so it reads as the same kind of thing as Machine and
      // Line, and so a second grain — if one is ever asked for — is a line added
      // here rather than a node re-shaped. See PERIODS above for why there is
      // only one.
      // REPORT SKU HIDDEN FOR DEMO PURPOSE
      // { label: "SKU", children: [{ label: "By Day", to: "/report/sku/by-day" }] },
      // TWO GRAINS, BOTH LIVE, AND NO THIRD ROW — which is why Area does not share
      // `PERIODS` with Factory. The requirement is explicit that it "only have 2
      // type of report on the Area", so a By Shift row here would be a promise
      // nothing intends to keep, and this file's greyed-placeholder kind exists for
      // rows that ARE coming.
      //
      // By Monthly was that grey promise for one PR — `oee.area_month_reports` is a
      // separate migration because a month's rates cannot be got by widening a
      // day's — and `0025` filled it.
      {
        label: "nav.area",
        children: [
          { label: "nav.byDay", to: "/report/area/by-day" },
          { label: "nav.byMonthly", to: "/report/area/by-monthly" },
        ],
      },
      // { label: "Factory", children: PERIODS },
    ],
  },
];

// Exact match for "/" — a `startsWith` test there would light up a row pointing
// at "/" on every page in the app. No nav row points there while Dashboard is
// hidden, but the guard stays: it is a property of the path, not of that row.
function isActivePath(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function containsActivePath(node: NavNode, pathname: string): boolean {
  if (node.to) return isActivePath(pathname, node.to);
  return node.children?.some((child) => containsActivePath(child, pathname)) ?? false;
}

// Rows are full-bleed: the tint on the active row has to reach both edges of the
// sidebar, as it does in the design. That means stripping the padding and the
// guide rail that SidebarGroup/SidebarMenuSub add by default and re-creating the
// indentation as `pl-*` on the buttons, so nesting shifts the label without
// insetting its background.
const INDENT = ["px-6", "pl-14", "pl-[4.5rem]"] as const;

// `border-r-transparent` rather than no border at all, so gaining/losing the
// active bar doesn't shift the label by 2px.
const ACTIVE_BAR =
  "rounded-none border-r-2 border-r-transparent data-[active=true]:border-r-primary";

function indent(depth: number): string {
  return INDENT[Math.min(depth, INDENT.length - 1)]!;
}

function NavLeaf({ node, depth, pathname }: { node: NavNode; depth: number; pathname: string }) {
  const { t } = useTranslation("oee");
  const name = t(node.label);
  const isActive = node.to ? isActivePath(pathname, node.to) : false;
  const className = cn(indent(depth), ACTIVE_BAR);

  // Top level keeps the icon and the tooltip that shows once the rail collapses.
  if (depth === 0) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild={Boolean(node.to)}
          size="lg"
          isActive={isActive}
          aria-disabled={node.to ? undefined : true}
          tooltip={name}
          className={cn(className, "gap-4")}
        >
          {node.to ? (
            <Link to={node.to}>
              {node.icon ? <node.icon /> : null}
              <span>{name}</span>
            </Link>
          ) : (
            <>
              {node.icon ? <node.icon /> : null}
              <span>{name}</span>
            </>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isActive}
        aria-disabled={node.to ? undefined : true}
        className={cn(className, "h-11 translate-x-0")}
      >
        {/* A placeholder renders as a <span>, never an <a>: it must not be
            clickable and must stay out of the tab order. */}
        {node.to ? <Link to={node.to}>{name}</Link> : <span>{name}</span>}
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function NavGroup({ node, depth, pathname }: { node: NavNode; depth: number; pathname: string }) {
  const { t } = useTranslation("oee");
  const name = t(node.label);
  const holdsActive = containsActivePath(node, pathname);
  const [open, setOpen] = useState(holdsActive);

  // Force the branch open when the active route moves into it — a deep link or a
  // <Link> from a page body would otherwise land on a collapsed tree with no
  // visible indication of where the user is. Opening only (never closing) leaves
  // the user's own collapse/expand of unrelated branches alone.
  useEffect(() => {
    if (holdsActive) setOpen(true);
  }, [holdsActive]);

  // The chevron follows the design: `<` collapsed, `v` expanded. Deliberately not
  // shadcn's rotating ChevronRight.
  const Chevron = open ? ChevronDownIcon : ChevronLeftIcon;
  const label = (
    <>
      {depth === 0 && node.icon ? <node.icon /> : null}
      <span className="flex-1 truncate">{name}</span>
      {/* `!` is load-bearing. SidebarMenuSubButton's base styles include
          `[&>svg]:text-sidebar-accent-foreground` — a descendant selector, so it
          outranks a plain utility on the child and would paint every sub-group
          chevron rose. The design wants them grey at every depth. */}
      <Chevron className="ml-auto shrink-0 text-muted-foreground!" />
    </>
  );

  const children = (
    <CollapsibleContent>
      <NavList nodes={node.children ?? []} depth={depth + 1} pathname={pathname} />
    </CollapsibleContent>
  );

  if (depth === 0) {
    return (
      <Collapsible asChild open={open} onOpenChange={setOpen}>
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={name}
              className={cn(indent(depth), ACTIVE_BAR, "gap-4")}
            >
              {label}
            </SidebarMenuButton>
          </CollapsibleTrigger>
          {children}
        </SidebarMenuItem>
      </Collapsible>
    );
  }

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <SidebarMenuSubItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton className={cn(indent(depth), ACTIVE_BAR, "h-11 translate-x-0")}>
            {label}
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        {children}
      </SidebarMenuSubItem>
    </Collapsible>
  );
}

function NavList({
  nodes,
  depth,
  pathname,
}: {
  nodes: NavNode[];
  depth: number;
  pathname: string;
}) {
  const rows = nodes.map((node) =>
    node.children ? (
      <NavGroup key={node.label} node={node} depth={depth} pathname={pathname} />
    ) : (
      <NavLeaf key={node.label} node={node} depth={depth} pathname={pathname} />
    ),
  );

  if (depth === 0) return <SidebarMenu className="gap-0">{rows}</SidebarMenu>;

  // Drops the inset and the vertical guide line SidebarMenuSub ships with; the
  // indentation lives on the buttons instead (see INDENT).
  return (
    <SidebarMenuSub className="mx-0 translate-x-0 gap-0 border-l-0 px-0">{rows}</SidebarMenuSub>
  );
}

function AppSidebar() {
  const { pathname } = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <AppSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {/* p-0 so the active row's tint runs edge to edge. The padding comes back
            in icon mode: there the buttons are a fixed size-8 and rely on the
            group's px-2 to sit centred in the 3rem rail. */}
        <SidebarGroup className="p-0 group-data-[collapsible=icon]:px-2">
          <NavList nodes={NAV} depth={0} pathname={pathname} />
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

export { AppSidebar };
