import { useTranslation } from "react-i18next";

import {
  areaDowntimeEventsQueryOptions,
  areaRejectsQueryOptions,
  skuDowntimeEventsQueryOptions,
  skuRejectsQueryOptions,
  downtimeReasonsQueryOptions,
  lineDowntimeEventsQueryOptions,
  lineRejectsQueryOptions,
  periodReportDowntimeEventsQueryOptions,
  periodReportRejectsQueryOptions,
  reasonBreakdownParams,
  reasonBreakdownQuery,
  shiftReportDowntimeEventsQueryOptions,
  shiftReportRejectsQueryOptions,
} from "@/lib/queries";
import { DEFAULT_VIEW, PerformanceLossTab, VIEWS } from "@/components/report/performance-loss-tab";
import { OthersParetoCard } from "@/components/report/others-pareto-card";
import { QualityLossTab } from "@/components/report/quality-loss-tab";
import { ReasonParetoCard } from "@/components/report/reason-pareto-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { QueryClient } from "@tanstack/react-query";
import type { SearchSchemaInput } from "@tanstack/react-router";
import type { DowntimeCategory } from "@/lib/types";
import type { LossesDetailTo, AnyReport } from "@/lib/report-subject";
import type { LossView } from "@/components/report/performance-loss-tab";

// The Losses page's five tabs, its URL contract, and its per-tab prefetch —
// shared by all three grains.
//
// WHY THIS IS ONE FILE AND NOT THREE ROUTES WITH THE SAME BODY
//
// The dispatch below is the most intricate piece of routing in this app, and its
// intricacy is load-bearing rather than incidental: the order of the checks is
// what makes `item.category` provably defined in the last arm, and the `never`
// in the prefetch switch is what stops a sixth tab shipping without one. Three
// copies of that would be three places for the ordering to drift, and a drift
// does not fail — it silently loses Performance Loss's sub-tab bar.
//
// The routes keep `validateSearch` (TanStack requires it there) and their own
// breadcrumbs, skeleton and empty states, which is where they genuinely differ.

// Which endpoint a tab reads.
type TabSource = "downtime" | "rejects" | "downtime-events";

// `source` IS THE SOURCE OF TRUTH FOR WHICH ENDPOINT A TAB READS — the loader
// prefetches from it and the tab body renders from it, so a tab cannot render a
// breakdown the loader never warmed. `category` means ONE thing: which downtime
// category, on the three tabs that have one.
//
// `satisfies` rather than a bare annotation, so the literals stay narrow enough
// for TabValue while a category the endpoint's own enum would reject cannot be
// written here. It buys one more thing: because `others` and `quality` OMIT
// `category` rather than setting it to `undefined`, narrowing on `source`
// narrows the element union to the members that actually have the key — which is
// what lets both the prefetch and the body read `tab.category` with no `!`, no
// default and no runtime check.
const TABS = [
  { value: "others", label: "Others", source: "downtime-events" },
  { value: "schedule", label: "Schedule Loss", source: "downtime", category: "PLANNED" },
  { value: "availability", label: "Availability Loss", source: "downtime", category: "UNPLANNED" },
  { value: "performance", label: "Performance Loss", source: "downtime", category: "SMALL_STOP" },
  { value: "quality", label: "Quality Loss", source: "rejects" },
] as const satisfies readonly {
  value: string;
  label: string;
  source: TabSource;
  category?: DowntimeCategory;
}[];

type TabValue = (typeof TABS)[number]["value"];

const DEFAULT_TAB: TabValue = "availability";

type LossesSearch = { tab: TabValue; view: LossView };

// Hand-rolled rather than zod, matching every other search contract here.
//
// The tab is in the URL because it is which loss factor the page is ABOUT — page
// identity, so a shared link reopens the same view. Everything below it (the
// machine filter, the ranking measure, the table's sort and page) is a view
// preference on one card and stays in useState.
//
// An unknown value degrades to the default rather than erroring: a hand-edited
// or stale URL should land somewhere useful.
function validateLossesSearch(search: Partial<LossesSearch> & SearchSchemaInput): LossesSearch {
  const tab = TABS.find((candidate) => candidate.value === search.tab)?.value;
  const view = VIEWS.find((candidate) => candidate.value === search.view)?.value;
  return { tab: tab ?? DEFAULT_TAB, view: view ?? DEFAULT_VIEW };
}

// Warm the ACTIVE tab's breakdown, and only that one.
//
// Warming all five was the alternative and is rejected: each is a per-reason
// aggregate over the report's window, whose cost TODOS.md §25 is an open item
// about, and most visits read one tab. The route's `loaderDeps` is what re-runs
// this on a tab switch, so the gate stays right rather than pinning the page to
// whichever tab it was entered on.
//
// Nothing here is awaited. An unawaited rejection cannot reject the loader,
// which is what keeps a breakdown failure card-local instead of replacing the
// page.
function prefetchLossTab({
  queryClient,
  report,
  tab: tabValue,
  view,
}: {
  queryClient: QueryClient;
  report: AnyReport;
  tab: TabValue;
  view: LossView;
}): void {
  // The Trendline view reads no breakdown at all — it renders the hourly profile,
  // which its own card gates on being selected, and at LINE grain renders an empty
  // state because no such endpoint exists. The SKU and AREA grains render an empty
  // state too, for their own reasons (see performance-loss-tab.tsx). Warming a
  // Pareto for a reader who landed on the other sub-tab is the same wasted
  // aggregate this gate exists to avoid.
  if (tabValue === "performance" && view === "trendline") return;

  const tab = TABS.find((candidate) => candidate.value === tabValue);
  // validateLossesSearch has already narrowed this. The check is what lets the
  // switch below be exhaustive rather than carrying a default arm that would
  // swallow a fourth source in silence.
  if (tab === undefined) return;

  switch (tab.source) {
    case "rejects":
      // No params composer for this prefetch and the card to disagree about: the
      // report id IS the cache key, so a warmed entry cannot be one nobody reads.
      //
      // The BRANCH is on the call, not on the options object. A ternary would
      // produce a union of two option types whose queryKey literals differ, and
      // prefetchQuery does not take a union — which is the type system noticing
      // that these really are two distinct cache entries.
      // THREE SUBJECTS NOW, and the branch is on the CALL rather than on an
      // options object for the reason stated above: a ternary would produce a
      // union of option types whose queryKey literals differ, which is the type
      // system noticing that these really are distinct cache entries.
      //
      // NO `default` ARM. Adding the SKU subject turned this switch into a
      // TS7029 "fallthrough case" error at both sites, and adding the AREA one did
      // it again — which is exactly what it is for: a fifth subject cannot ship
      // without a prefetch, and there is no way to grep for "switches that assumed
      // there were three".
      //
      // SWITCHED ON `report.subject` DIRECTLY, not through reportSubject(): only a
      // switch on the discriminant PROPERTY narrows `report` for the arms below,
      // and the machine arm needs that narrowing to read `report.grain` as a
      // machine grain. NO `default` — a fourth subject must fail to build here.
      switch (report.subject) {
        // FOUR ARMS NOW, and adding this one WAS a TS7029 "fallthrough case" error
        // at both switches — which is exactly what they are for. A fifth subject
        // cannot ship without a prefetch, and there is no way to grep for
        // "switches that assumed there were three".
        case "area":
          // THE GRAIN IS PART OF THE CACHE KEY, so warming the wrong one leaves the
          // card fetching on mount — a skeleton flash on a page that had already
          // loaded, which is the quietest failure in this feature.
          void queryClient.prefetchQuery(areaRejectsQueryOptions(report.grain, report.id));
          return;
        case "sku":
          void queryClient.prefetchQuery(skuRejectsQueryOptions(report.id));
          return;
        case "line":
          void queryClient.prefetchQuery(lineRejectsQueryOptions(report.grain, report.id));
          return;
        case "machine":
          // STILL TWO CALLS, not one call with a ternary argument. Folding these
          // into `prefetchQuery(cond ? a : b)` fails to compile, exactly as the
          // note above says it should: the two option objects carry different
          // queryKey literals, so their union is not a FetchQueryOptions. Tried on
          // 2026-09-02 while switching this dispatch; the compiler was right.
          if (report.grain === "shift") {
            void queryClient.prefetchQuery(shiftReportRejectsQueryOptions(report.id));
          } else {
            void queryClient.prefetchQuery(
              periodReportRejectsQueryOptions(report.grain, report.id),
            );
          }
          return;
      }
    case "downtime-events":
      // See the rejects arm above for why this switches on the property.
      switch (report.subject) {
        case "area":
          void queryClient.prefetchQuery(areaDowntimeEventsQueryOptions(report.grain, report.id));
          return;
        case "sku":
          void queryClient.prefetchQuery(skuDowntimeEventsQueryOptions(report.id));
          return;
        case "line":
          void queryClient.prefetchQuery(lineDowntimeEventsQueryOptions(report.grain, report.id));
          return;
        case "machine":
          // Two calls, for the reason the rejects arm records.
          if (report.grain === "shift") {
            void queryClient.prefetchQuery(shiftReportDowntimeEventsQueryOptions(report.id));
          } else {
            void queryClient.prefetchQuery(
              periodReportDowntimeEventsQueryOptions(report.grain, report.id),
            );
          }
          return;
      }
      return;
    case "downtime": {
      // ONE COMPOSER for every grain — `reasonBreakdownParams` carries the grain
      // into the params, and therefore into the cache key, so this prefetch and
      // the card's own subscription cannot key differently and fetch twice.
      //
      // AND THE MEASURE IS IN THE KEY TOO, since the endpoint started returning
      // the top N by it. Prefetched at the DEFAULT, which is the measure the card
      // opens on — `reasonBreakdownQuery`'s own default, shared rather than
      // written twice, so the first paint hits the entry this warmed. A user who
      // then toggles pays for one request, once.
      const request = reasonBreakdownQuery(reasonBreakdownParams(report, tab.category));
      if (request !== undefined) {
        void queryClient.prefetchQuery(downtimeReasonsQueryOptions(request));
      }
      return;
    }
    default: {
      // A FOURTH SOURCE MUST NOT COMPILE until it has a prefetch. This function
      // returns void, so a missing case would otherwise be entirely silent: the
      // tab would render, fetch on mount, and flash a skeleton on a page that had
      // already loaded.
      const unhandled: never = tab;
      return unhandled;
    }
  }
}

// THE FIVE TABS SERVE ALL FOUR SUBJECTS, AND THE AREA ONE IS ONE TAB SHORT IN
// PRACTICE RATHER THAN IN SHAPE.
//
// The requirement asks for the area's Losses page "same as machine/line but without
// performance loss -> trendline tab". The SUB-TAB still renders — with an empty
// state naming why — rather than disappearing, which is §61's argument applied a
// fourth time: the tab bar must not change shape between subjects, or a reader
// moving from a line to an area sees a control vanish and reads it as a bug. What
// changes is what the view says, not whether it is there.
function LossesTabs({
  report,
  detailTo,
  tab,
  view,
  onTabChange,
  onViewChange,
}: {
  // EITHER SUBJECT. The five tabs are the same five for both; which endpoint each
  // reads is decided once in lib/queries.ts, by the report's own shape.
  report: AnyReport;
  detailTo: LossesDetailTo;
  tab: TabValue;
  view: LossView;
  onTabChange: (next: TabValue) => void;
  onViewChange: (next: LossView) => void;
}) {
  const { t } = useTranslation("oee");
  const tabLabel: Record<TabValue, string> = {
    others: t("report.others"),
    schedule: t("report.scheduleLoss"),
    availability: t("report.availabilityLoss"),
    performance: t("report.performanceLoss"),
    quality: t("report.qualityLoss"),
  };
  return (
    <Tabs value={tab} onValueChange={(next) => onTabChange(next as TabValue)}>
      <TabsList className="self-center">
        {TABS.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {tabLabel[item.value]}
          </TabsTrigger>
        ))}
      </TabsList>

      {TABS.map((item) => (
        <TabsContent key={item.value} value={item.value}>
          {/* Radix unmounts the inactive tab, so exactly one card is mounted and
              exactly one breakdown is ever in flight. The cost is that the
              measure radio, the table's sort and its page reset on a tab switch —
              which is right: those are view preferences on one card, and the card
              that comes back is a different dataset. */}
          {/* ORDER MATTERS, and the first check is not on `source`.
              `performance` has to be checked on its VALUE first, because its
              source IS "downtime" — it shares that with two tabs that are nothing
              more than their Pareto. Moved below the source ladder it would fall
              into the last arm and silently lose its sub-tab bar and its Reduce
              Speed band, which is the only regression in this dispatch a human
              would have to notice.
              The compensating safety is real: the last arm's `item.category` is
              provably defined ONLY because the three arms above it removed every
              member that lacks the key. Reorder the chain and `item.category`
              becomes `DowntimeCategory | undefined`, so it fails type-check
              rather than rendering wrong. */}
          {item.value === "performance" ? (
            <PerformanceLossTab
              report={report}
              detailTo={detailTo}
              view={view}
              onViewChange={onViewChange}
            />
          ) : item.source === "rejects" ? (
            <QualityLossTab report={report} />
          ) : item.source === "downtime-events" ? (
            <OthersParetoCard report={report} />
          ) : (
            <ReasonParetoCard report={report} category={item.category} detailTo={detailTo} />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export { DEFAULT_TAB, LossesTabs, prefetchLossTab, TABS, validateLossesSearch };
export type { LossesSearch, TabValue };
