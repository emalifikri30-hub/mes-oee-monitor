import { createFileRoute } from "@tanstack/react-router";

import { LineReportTable } from "@/components/report/line-report-table";
import { validateShiftSearch } from "@/lib/shift-search";

import type { ShiftGrainSearch } from "@/lib/shift-search";

// The Line By Shift list. Everything on screen lives in LineReportTable, which
// serves all three Line grains — see that file for why one component covers three
// here where the machine screens need two for their three.
//
// validateShiftSearch, NOT validateMachineShiftSearch: this URL carries `shift`
// and deliberately carries no `status`. A line has no approval to filter on, and a
// URL that claimed one would be asking the server for a filter it ignores.
export const Route = createFileRoute("/_app/report/line/by-shift")({
  validateSearch: validateShiftSearch,
  component: LineByShiftRoute,
  staticData: {
    title: "nav.byShift",
    // "Report" and "Line" are grouping levels with no page of their own, so they
    // carry no `to` and render as plain text.
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.line" }, { label: "nav.byShift" }],
  },
});

function LineByShiftRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <LineReportTable
      grain="shift"
      detailTo="/report/line/by-shift/$reportId"
      search={search}
      onFilter={(patch: Partial<ShiftGrainSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
