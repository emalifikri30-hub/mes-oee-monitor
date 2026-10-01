import { createFileRoute } from "@tanstack/react-router";

import { LineReportTable } from "@/components/report/line-report-table";
import { validatePeriodSearch } from "@/lib/period-search";

import type { PeriodSearch } from "@/lib/period-search";

// The Line By Day list. Everything on screen lives in LineReportTable.
//
// validatePeriodSearch is reused VERBATIM from the machine coarse grains: the URL
// contract is identical, because neither carries a shift and neither carries a
// status. It is the same function, not a copy — see lib/period-search.ts.
export const Route = createFileRoute("/_app/report/line/by-day")({
  validateSearch: validatePeriodSearch,
  component: LineByDayRoute,
  staticData: {
    title: "nav.byDay",
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.line" }, { label: "nav.byDay" }],
  },
});

function LineByDayRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <LineReportTable
      grain="day"
      detailTo="/report/line/by-day/$reportId"
      search={search}
      onFilter={(patch: Partial<PeriodSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
