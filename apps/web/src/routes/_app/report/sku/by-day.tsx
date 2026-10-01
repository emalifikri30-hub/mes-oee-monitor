import { createFileRoute } from "@tanstack/react-router";

import { SkuReportTable } from "@/components/report/sku-report-table";
import { validatePeriodSearch } from "@/lib/period-search";

import type { PeriodSearch } from "@/lib/period-search";

// The SKU By Day list. Everything on screen lives in SkuReportTable.
//
// validatePeriodSearch is reused VERBATIM from the machine and line coarse
// grains: the URL contract is identical, because none of them carries a shift and
// none carries a status. It is the same function, not a copy — see
// lib/period-search.ts.
export const Route = createFileRoute("/_app/report/sku/by-day")({
  validateSearch: validatePeriodSearch,
  component: SkuByDayRoute,
  staticData: {
    title: "nav.byDay",
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.sku" }, { label: "nav.byDay" }],
  },
});

function SkuByDayRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <SkuReportTable
      search={search}
      onFilter={(patch: Partial<PeriodSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
