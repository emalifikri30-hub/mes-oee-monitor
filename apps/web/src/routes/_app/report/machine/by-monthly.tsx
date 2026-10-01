import { createFileRoute } from "@tanstack/react-router";

import { validatePeriodSearch } from "@/lib/period-search";
import { PeriodReportTable } from "@/components/report/period-report-table";

import type { PeriodSearch } from "@/lib/period-search";

// The By Monthly list. Everything on screen lives in PeriodReportTable, which By
// Day renders too — see that file for why the two screens are one component.
//
// This route owns only what belongs to a URL: the search contract, the
// breadcrumb, and the navigation callbacks.
export const Route = createFileRoute("/_app/report/machine/by-monthly")({
  validateSearch: validatePeriodSearch,
  component: ByMonthlyRoute,
  staticData: {
    title: "nav.byMonthly",
    // A real breadcrumbs array, not the `description` string this route carried
    // while it was a placeholder — that renders as a flat subtitle rather than a
    // trail. "Report" and "Machine" are grouping levels with no page of their
    // own, so they carry no `to`.
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.machine" }, { label: "nav.byMonthly" }],
  },
});

function ByMonthlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <PeriodReportTable
      grain="month"
      search={search}
      onFilter={(patch: Partial<PeriodSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
      detailTo="/report/machine/by-monthly/$reportId"
    />
  );
}
