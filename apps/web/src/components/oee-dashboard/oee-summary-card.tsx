import { useTranslation } from "react-i18next";

import { MetricsCard } from "@/components/report/metrics-card";

import type { MetricSpec } from "@/components/report/metrics-card";

// The dashboard's KPI row.
//
// TAKES TILES, NOT A REPORT — apps/web/AGENTS.md's shared-component rule, and the
// reason is sharper here than on most cards: the subject registry already owns
// which tiles exist (an area has no TEEP, because 0024 has no such column), so a
// `report` prop would put that decision in two places and let this file decide it
// second.
//
// A THIN WRAPPER OVER MetricsCard rather than a use of it at the call site, and it
// earns its file with one thing: the title and the collapse noun. Both are prose
// this screen owns, and the next subject's dashboard must render the SAME words —
// a supervisor comparing a machine's month to its line's should not find one
// called "Summary" and the other "Overview".
function OeeSummaryCard({ tiles }: { tiles: MetricSpec[] }) {
  const { t } = useTranslation("oee");
  return (
    <MetricsCard
      title={t("dashboard.oeeSummary")}
      collapseLabel={t("dashboard.oeeSummary")}
      tiles={tiles}
      // Six across on a wide screen, so the row reads as one band the way the mock
      // draws it. Not derived from tiles.length: an area's four tiles should sit in
      // the same columns as a machine's six, not stretch to fill them.
      //
      // `grid` AND THE SPACING ARE PART OF THIS STRING, not supplied by MetricsCard.
      // That component sets `className={gridClassName}` on its CardContent verbatim,
      // so a value carrying only `grid-cols-*` silently does nothing — the columns
      // are inert without `grid` and the tiles stack in normal flow. It shipped that
      // way once and looked like a broken card rather than a missing class. Every
      // other caller passes the same four leading utilities; keep them.
      gridClassName="grid grid-cols-2 gap-x-6 gap-y-4 pb-5 sm:grid-cols-3 lg:grid-cols-6"
    />
  );
}

export { OeeSummaryCard };
