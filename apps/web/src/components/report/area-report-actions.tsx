import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DownloadIcon,
  EllipsisIcon,
  PencilIcon,
  RefreshCwIcon,
  ScrollTextIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AreaActivitySheet } from "@/components/report/area-activity-sheet";
import { DownloadReportDialog } from "@/components/report/download-report-dialog";

import type { AreaReportDetail } from "@/lib/types";

// The AREA report's header actions: the overflow menu, and nothing beside it.
//
// A "…" MENU RATHER THAN A BUTTON, WHICH IS THE OPPOSITE CALL FROM THE SKU
// SCREEN'S — and the requirement is the reason. It names both items: "Action button
// (3 dot icon; for download and log activity)". Two items is a menu; the SKU
// screen's ONE live item is not, and sku-report-actions.tsx argues that at length
// ("a dropdown whose sole live item is that action is a menu of one: a control that
// looks like a choice and is not").
//
// Download is still the placeholder it is on every other screen (TODOS.md §67) —
// the dialog says the export is being built — and it is ENABLED here for the reason
// report-actions.tsx gives: a committed feature with a known shape gets a dialog
// that says so, where an undesigned one gets a disabled row.
//
// ---------------------------------------------------------------------------
// NO APPROVE, AND IT IS THE STRONGEST ABSENCE OF THE FOUR SUBJECTS
// ---------------------------------------------------------------------------
//
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift).
//
//   machine shift  has a real approval row.
//   line shift     has none and CASCADES over its machines — one click, N machine
//                  shift reports, its own role variable (APPROVE_LINE_ROLE).
//   line day/mo    could cascade over three shifts as well and declines to
//                  (TODOS §48).
//   SKU day        has neither a work unit nor a shift and no children to count.
//   AREA day       has no key either, and its cascade would be the widest of all:
//                  approving an area would close every machine shift report in it.
//                  That is not a permission any of the six role variables grants,
//                  and it is not one this screen should invent — a line approval is
//                  already "not the permission 'approve the shift you worked'
//                  grants" (AGENTS.md), and an area's is that argument again one
//                  level up. So there is nothing to sign, nothing to reopen and
//                  nothing to badge.
//
// The feed says so too, as its third source — see AreaActivitySheet.
//
// ITS OWN FILE rather than a `subject` prop on line-report-actions.tsx, following
// that file's own rule: what they differ in is WHICH MUTATION, WHICH SHEET and
// WHICH QUERY, and a prop that picks between them is a prop that can pick wrong and
// sign off an unrelated MACHINE report.
function AreaReportActions({ report }: { report: AreaReportDetail }) {
  const { t } = useTranslation("oee");
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t("common.moreActions")}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDownloadOpen(true)}>
            <DownloadIcon />
            {t("report.download")}
          </DropdownMenuItem>
          {/* NOT GATED BY GRAIN, unlike the line menu's. That one hides Log
              Activity at day and month because both its arms are scoped by a SHIFT
              window over the line's machine reports, so there is no coarse endpoint
              to open. This grain's feed is day-scoped by construction — both arms
              widen over the three shifts — so the endpoint exists and the item is
              always live. */}
          <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
            <ScrollTextIcon />
            {t("report.logActivity")}
          </DropdownMenuItem>
          {/* DISABLED, not hidden: neither is designed, so a dialog would have
              nothing truthful to say. downtime-row-menu.tsx's convention for an
              action whose write path does not exist. */}
          <DropdownMenuItem disabled>
            <RefreshCwIcon />
            {t("common.regenerate")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <PencilIcon />
            {t("common.adjustCalculation")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rendered unconditionally rather than only while open, matching the other
          three report screens: the sheet's own query is gated on `open`, so a
          closed panel costs a mount and no request. */}
      <AreaActivitySheet
        // BOTH HALVES OF THE ADDRESS. The two area tables have independent identity
        // sequences, so an id without its grain names two different reports — and
        // the panel would open the other period's chronology under this heading.
        grain={report.grain}
        reportId={report.id}
        timeZone={report.timeZone}
        open={activityOpen}
        onOpenChange={setActivityOpen}
      />

      <DownloadReportDialog open={downloadOpen} onOpenChange={setDownloadOpen} />
    </div>
  );
}

export { AreaReportActions };
