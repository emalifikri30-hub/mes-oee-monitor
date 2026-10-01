import { createFileRoute } from "@tanstack/react-router";

import { ShiftReportTable } from "@/components/report/shift-report-table";
import { validateMachineShiftSearch } from "@/lib/shift-search";

import type { MachineShiftSearch } from "@/lib/shift-search";

// The By Shift list. Everything on screen lives in ShiftReportTable, which was
// lifted out of this file so it can be rendered in a test without mounting a
// route — see that file's header.
//
// This route owns only what belongs to a URL: the search contract, the
// breadcrumb, and the navigation callbacks.
export const Route = createFileRoute("/_app/report/machine/by-shift")({
  validateSearch: validateMachineShiftSearch,
  component: ByShiftRoute,
  staticData: {
    title: "nav.byShift",
    // "Report" and "Machine" are grouping levels with no page of their own, so
    // they carry no `to` and render as plain text.
    breadcrumbs: [{ label: "nav.report" }, { label: "nav.machine" }, { label: "nav.byShift" }],
  },
});

function ByShiftRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <ShiftReportTable
      search={search}
      onFilter={(patch: Partial<MachineShiftSearch>) => {
        void navigate({ search: (prev) => ({ ...prev, ...patch, page: 1 }) });
      }}
      onPageChange={(page) => void navigate({ search: (prev) => ({ ...prev, page }) })}
    />
  );
}
