import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  DownloadIcon,
  EllipsisIcon,
  LockOpenIcon,
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
import { ActivityLogSheet } from "@/components/report/activity-log-sheet";
import { ApproveReportDialog } from "@/components/report/approve-report-dialog";
import { DownloadReportDialog } from "@/components/report/download-report-dialog";
import { ReopenReportDialog } from "@/components/report/reopen-report-dialog";

import type { ReportDetail } from "@/lib/types";

// The report's actions: Approve, and the overflow menu beside it.
//
// SPLIT OUT OF report-header.tsx, which stays an identity strip. Folding a
// menu, two dialogs, a sheet and a mutation into that file would take a 40-line
// layout component past 200 and mix "what this report is" with "what you may do
// to it".
//
// TWO KINDS OF NOT-YET-BUILT, AND THE RULE THAT SEPARATES THEM
//
//   Regenerate / Adjust calculation  DISABLED. Neither is designed, so a dialog
//     would have nothing truthful to say. This is downtime-row-menu.tsx's
//     convention for an action whose write path does not exist.
//   Download                         ENABLED, opening a dialog that says the
//     export is still being built. It is a committed feature with a known shape,
//     and the honest answer to a click is a sentence, not a dead item.
//
// Write that rule down rather than leaving it implied — otherwise the next
// person makes all four consistent in the wrong direction.
//
// NO ROLE CHECK, AND ITS ABSENCE IS DELIBERATE. Any authenticated user may
// approve today. It could not be enforced here in any case: /api/me returns
// { sub, preferredUsername, email } and no roles, so the browser cannot know
// whether this user is permitted. The server is the only authority, and a 403
// surfaces inside the confirm dialog. TODOS.md §34 holds the gate.
//
// WHAT DAY AND MONTH REPORTS DO NOT GET, AND WHY EACH IS ABSENT
//
//   Approve / Reopen  There is nothing to write. Approval is keyed
//     (work_unit_id, date, shift) in the database, so a day sign-off has no row
//     to live in — and one operator closing three shifts with a single click is
//     a different authority from closing the shift they worked, which is a
//     product decision nobody has taken. TODOS.md §48 holds it.
//   Log Activity      ENABLED AT EVERY GRAIN. It was disabled here while
//     /activity was shift-only; the day and month endpoints exist now. What the
//     feed can honestly SHOW still differs by grain — see getPeriodActivity — but
//     that is the payload's business rather than the menu's.
//
// Download stays enabled at every grain — its dialog says the export is being
// built, which is equally true whichever report you are on.
function ReportActions({ report }: { report: ReportDetail }) {
  const { t } = useTranslation("oee");
  const [approveOpen, setApproveOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  // Narrowed once, here, so every branch below reads a plain boolean instead of
  // re-testing the discriminant. `shiftReport` is the report itself when there
  // is one, which is what the shift-only dialogs need.
  const shiftReport = report.grain === "shift" ? report : null;
  const isClosed = shiftReport?.approval.status === "closed";

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t("common.moreActions")}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        {/* The menu does NOT narrow when a report closes: reading what happened
            to a report, and exporting it, are exactly what you do to a closed
            one. */}
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDownloadOpen(true)}>
            <DownloadIcon />
            {t("report.download")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
            <ScrollTextIcon />
            {t("report.logActivity")}
          </DropdownMenuItem>
          {/* IN THE MENU, NOT BESIDE APPROVE, and shown only when there is
              something to reopen. Approve is the primary action of this screen;
              withdrawing somebody's sign-off is a correction, and giving it equal
              weight would invite it. Hidden rather than disabled on an open
              report because "reopen" over an already-open one is not a state
              worth rendering — unlike Approve, whose disabled form is the
              clearest statement that the report is closed. */}
          {isClosed && (
            <DropdownMenuItem onSelect={() => setReopenOpen(true)}>
              <LockOpenIcon />
              {t("report.reopen")}
            </DropdownMenuItem>
          )}
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

      {/* HIDDEN ENTIRELY at day and month grain, not disabled. A disabled
          Approve says "you cannot do this now"; here the action does not exist
          at all, and rendering it greyed would invite somebody to ask why it
          never enables.

          At shift grain it is disabled rather than hidden once closed, for the
          opposite reason: the button is the clearest statement that this report
          has already been approved, and removing it would leave the reader
          looking for it. */}
      {shiftReport !== null && (
        <Button
          variant={isClosed ? "secondary" : "default"}
          disabled={isClosed}
          onClick={() => setApproveOpen(true)}
        >
          <CheckIcon />
          {isClosed ? t("table.approved") : t("report.approve")}
        </Button>
      )}

      {shiftReport !== null && (
        <>
          <ApproveReportDialog
            reportId={shiftReport.id}
            open={approveOpen}
            onOpenChange={setApproveOpen}
          />
          <ReopenReportDialog
            reportId={shiftReport.id}
            // The display name if one was recorded, else the subject, else null
            // for a system close — the same fallback the header's status badge
            // uses, so the two cannot name the approver differently.
            closedByName={shiftReport.approval.closedByName ?? shiftReport.approval.closedBy}
            open={reopenOpen}
            onOpenChange={setReopenOpen}
          />
        </>
      )}

      <DownloadReportDialog open={downloadOpen} onOpenChange={setDownloadOpen} />

      {/* OUTSIDE the shift-only block: every grain has a feed now. `timeZone` is
          nullable at the coarse grains, because the pipeline has not backfilled
          the column, and the sheet needs a string to format instants with — so an
          unresolved zone falls back to UTC rather than blocking the panel. The
          server sends the same fallback for the same reason. */}
      <ActivityLogSheet
        reportId={report.id}
        grain={report.grain}
        timeZone={report.timeZone ?? "UTC"}
        open={activityOpen}
        onOpenChange={setActivityOpen}
      />
    </div>
  );
}

export { ReportActions };
