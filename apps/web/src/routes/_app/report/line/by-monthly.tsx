import { createFileRoute } from "@tanstack/react-router";

import { LineReportTable } from "@/components/report/line-report-table";
import { validatePeriodSearch } from "@/lib/period-search";

import type { PeriodSearch } from "@/lib/period-search";

// The Line By Monthly list. Everything on screen lives in LineReportTable.
//
// The month/year filter means the same thing here as at day grain: it filters
// `business_date`, which is the first of the month at this grain. So August
// selected shows August's month reports, one per line.
export const Route = createFileRoute("/_app/report/line/by-monthly")({
  validateSearch: validatePeriodSearch,
  component: LineByMonthlyRoute,
  staticData: {
    title: "nav.byMonthly",
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.line" }, { label: "nav.byMonthly" }],
  },
});

function LineByMonthlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <LineReportTable
      grain="month"
      detailTo="/report/line/by-monthly/$reportId"
      search={search}
      onFilter={(patch: Partial<PeriodSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
