import { createFileRoute } from "@tanstack/react-router";

import { AreaReportTable } from "@/components/report/area-report-table";
import { validateAreaDaySearch } from "@/lib/area-search";

import type { AreaDaySearch } from "@/lib/area-search";

// The Area By Day list. Everything on screen lives in AreaReportTable.
//
// `validateAreaDaySearch`, NOT the `validatePeriodSearch` the other six lists
// share, and that is the one interesting line in this file. Those six carry
// `workCenterId`; an area report is not scoped by a line, and accepting a filter
// the server ignores lets a bookmarked `?workCenterId=3` come back with the whole
// area looking filtered. lib/area-search.ts carries the argument, and reuses
// `coerceInt` so the two contracts cannot drift about what "an integer in range"
// means.
//
// THE AREA ITSELF IS NOT IN THE URL. It comes from the header picker through
// context, which is area-context.tsx's decision rather than this route's — see
// lib/area-search.ts.
export const Route = createFileRoute("/_app/report/area/by-day")({
  validateSearch: validateAreaDaySearch,
  component: AreaByDayRoute,
  staticData: {
    title: "nav.byDay",
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.area" }, { label: "nav.byDay" }],
  },
});

function AreaByDayRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <AreaReportTable
      grain="day"
      search={search}
      onFilter={(patch: Partial<AreaDaySearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
