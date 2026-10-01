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

import { useLineApproval } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApproveLineDialog } from "@/components/report/approve-line-dialog";
import { DownloadReportDialog } from "@/components/report/download-report-dialog";
import { LineActivitySheet } from "@/components/report/line-activity-sheet";
import { ReopenLineDialog } from "@/components/report/reopen-line-dialog";

import type { LineReportDetail } from "@/lib/types";

// The Line report's actions: Approve, and the overflow menu beside it.
//
// A SEPARATE FILE FROM report-actions.tsx RATHER THAN A `subject` PROP, and this
// is the one place in this feature where duplication is the right call. What the
// two files share is a menu layout; what they differ in is WHICH MUTATION, WHICH
// SHEET and WHICH QUERY — and the seven report tables have seven independent id
// sequences, so a prop that picked between them is a prop that can pick wrong and
// sign off an unrelated MACHINE report. The shared parts (the confirm ladder, the
// panel) are shared as components; the wiring stays explicit and testable.
//
// APPROVE IS SHIFT GRAIN ONLY, and NOT because a line's day cannot be signed in
// principle. oee.work_unit_shift_report_approvals is keyed
// (work_unit_id, date, shift), so a line DAY approval would cascade over three
// shifts as well as N machines — the question TODOS §48 holds. Hidden entirely at
// the coarse grains rather than disabled: a disabled button says "not now", where
// here the action does not exist.
//
// WHAT THE BUTTON SAYS, AND WHY IT IS THREE STATES RATHER THAN TWO
//
//   some machines open   "Approve", enabled. It closes ONLY the open ones, which
//                        is what the server does — a partially approved line is
//                        reachable the moment somebody approves one machine from
//                        the machine screen, and refusing there would leave a line
//                        permanently un-approvable from its own page.
//   all closed           "Approved", disabled. The clearest statement that this
//                        line has been signed off; removing the button would leave
//                        the reader looking for it.
//   summary not loaded   "Approve", enabled. The summary is prefetched but not
//                        awaited, so it can be in flight on first paint. Enabled
//                        is the safe default: the server answers 409 if there is
//                        nothing to do, and the dialog shows that.
//
// NO ROLE CHECK HERE. /api/me returns { sub, preferredUsername, email } and no
// roles, so the browser cannot know whether this user may approve a line. The
// server is the only authority — APPROVE_LINE_ROLE, unset by default — and a 403
// surfaces inside the confirm dialog.
function LineReportActions({ report }: { report: LineReportDetail }) {
  const { t } = useTranslation("oee");
  const [approveOpen, setApproveOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  // Narrowed once, so every branch below reads a plain value instead of
  // re-testing the discriminant.
  const shiftReport = report.grain === "shift" ? report : null;

  // ONE SUBSCRIPTION, GATED, rather than a hook inside the shift-only branch.
  // React forbids a conditional hook, and `enabled` is how this codebase says
  // "call it anyway, ask for nothing" — the same shape as useShiftReportActivity.
  // A day or month screen therefore issues no request and reads `data` as
  // undefined, which every branch below treats as "not known yet".
  //
  // Sharing it between the button, the menu and both dialogs is what stops them
  // naming different counts: they read one cache entry, and the route loader has
  // already prefetched it.
  const { data: approval } = useLineApproval(report.id, shiftReport !== null);

  const machinesOpen =
    approval === undefined ? null : approval.machinesFound - approval.machinesClosed;
  // `machinesFound > 0` guards the 0-of-0 case: a line whose machines never
  // reported has nothing to approve, and the server 404s it — so it must not read
  // as fully approved.
  const allClosed =
    approval !== undefined &&
    approval.machinesFound > 0 &&
    approval.machinesClosed === approval.machinesFound;

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t("common.moreActions")}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Enabled at every grain — the dialog says the export is still being
              built, which is equally true whichever report you are on. That is
              report-actions.tsx's rule for a committed feature with a known
              shape, as against Regenerate below. */}
          <DropdownMenuItem onSelect={() => setDownloadOpen(true)}>
            <DownloadIcon />
            {t("report.download")}
          </DropdownMenuItem>
          {/* ENABLED AT EVERY GRAIN. It was shift-only while /activity was, on the
              argument that "both arms of the feed are scoped by a shift window over
              the line's machine reports" — which was half true: the downtime arm was
              always a plain instant window that never read a shift, and only the
              approval join narrowed by one. TODOS §60 held the rest as a PRODUCT
              question about density, and the answer is that a day feed is a feed.

              NOTE THIS IS NOT THE APPROVE BLOCK'S RULE, which stays shift-only
              below. Reading what happened over a window grants nothing; signing off
              a day would cascade over three shifts as well as N machines, which is
              an authority nobody has granted (§48). Two questions that look alike
              and have different answers. */}
          <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
            <ScrollTextIcon />
            {t("report.logActivity")}
          </DropdownMenuItem>
          {/* IN THE MENU, NOT BESIDE APPROVE, and shown only when there is
              something to withdraw. Approve is this screen's primary action;
              undoing several people's sign-offs at once is a correction, and
              giving it equal weight would invite it. Hidden rather than disabled
              on a line with nothing approved, because "reopen" over an unapproved
              line is not a state worth rendering — unlike Approve, whose disabled
              form is the clearest statement that the line is signed off. */}
          {shiftReport !== null && (approval?.machinesClosed ?? 0) > 0 && (
            <DropdownMenuItem onSelect={() => setReopenOpen(true)}>
              <LockOpenIcon />
              {t("report.reopen")}
            </DropdownMenuItem>
          )}
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

      {shiftReport !== null && (
        <Button
          variant={allClosed ? "secondary" : "default"}
          disabled={allClosed}
          onClick={() => setApproveOpen(true)}
        >
          <CheckIcon />
          {allClosed ? t("table.approved") : t("report.approve")}
        </Button>
      )}

      {shiftReport !== null && (
        <>
          <ApproveLineDialog
            reportId={shiftReport.id}
            machinesOpen={machinesOpen}
            open={approveOpen}
            onOpenChange={setApproveOpen}
          />
          <ReopenLineDialog
            reportId={shiftReport.id}
            machinesClosed={approval?.machinesClosed ?? null}
            open={reopenOpen}
            onOpenChange={setReopenOpen}
          />
        </>
      )}

      <DownloadReportDialog open={downloadOpen} onOpenChange={setDownloadOpen} />

      {/* OUTSIDE the shift-only block: every line grain has a feed now. `grain`
          comes off the report rather than being implied, because the three
          work_center_* tables have independent identity sequences — the sheet
          picks both its endpoint and its cache key from it. */}
      <LineActivitySheet
        grain={report.grain}
        reportId={report.id}
        timeZone={report.timeZone}
        open={activityOpen}
        onOpenChange={setActivityOpen}
      />
    </div>
  );
}

export { LineReportActions };
