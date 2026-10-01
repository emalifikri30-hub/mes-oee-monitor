import { createFileRoute } from "@tanstack/react-router";

import { AreaReportTable } from "@/components/report/area-report-table";
import { validateAreaMonthSearch } from "@/lib/area-search";

import type { AreaMonthSearch } from "@/lib/area-search";

// The Area By Monthly list. Everything on screen lives in AreaReportTable, which
// serves both area grains off a discriminated `search` union.
//
// `validateAreaMonthSearch`, NOT `validateAreaDaySearch` and NOT the
// `validatePeriodSearch` the six other coarse lists share. It carries YEAR, page,
// size and hide-zero — and NO MONTH, which is the requirement in as many words:
// "Monthly Report (Show all month on selected year)". A month filter would
// contradict the screen's own heading, core-api's month list refuses the param
// outright, and dropping it from the URL contract is what stops a `?month=9`
// bookmarked from the By Day screen surviving into this one and looking like a
// filter that applied.
//
// ITS DEFAULT PAGE SIZE IS 12 rather than 10, so a year fits on one page. See
// lib/area-search.ts.
//
// THE AREA ITSELF IS NOT IN THE URL. It comes from the header picker through
// context, which is area-context.tsx's decision rather than this route's.
export const Route = createFileRoute("/_app/report/area/by-monthly")({
  validateSearch: validateAreaMonthSearch,
  component: AreaByMonthlyRoute,
  staticData: {
    title: "nav.byMonthly",
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.area" }, { label: "nav.byMonthly" }],
  },
});

function AreaByMonthlyRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <AreaReportTable
      grain="month"
      search={search}
      onFilter={(patch: Partial<AreaMonthSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
