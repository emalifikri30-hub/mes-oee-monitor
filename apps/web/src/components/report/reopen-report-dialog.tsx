import { useTranslation } from "react-i18next";

import { useReopenShiftReport } from "@/lib/mutations";
import { ConfirmWriteDialog } from "@/components/report/confirm-write-dialog";

import type { StatusMessages } from "@/components/report/confirm-write-dialog";

// Confirm, then reopen a MACHINE shift report. The mirror of ApproveReportDialog,
// over the same shell in confirm-write-dialog.tsx.
//
// WHY THIS EXISTS, which is not "symmetry". Editing a downtime on an approved
// report is refused with a 409. Without a reopen, an operator who finds a genuine
// mistake on a signed-off report has no path at all — the freeze would be a trap
// rather than a control. So this is what makes the freeze defensible.
//
// WHY A CONFIRM STEP. Reopening withdraws somebody's sign-off, which is a
// stronger act than granting one — and it may not be the current user's sign-off.
// The body says whose it was, because "are you sure" without a name is not a
// question anybody can answer.
//
// NO ROLE GATE, and it is worth being explicit that this is known rather than
// overlooked. "Anyone may approve" is defensible; "anyone may undo somebody
// else's approval" is a different claim. The gate is filed (TODOS.md §34) and
// covers both routes, and shipping this ungated was the alternative to shipping
// the freeze with no escape hatch.
function ReopenReportDialog({
  reportId,
  closedByName,
  open,
  onOpenChange,
}: {
  reportId: number;
  // The approver's display name, or their subject if no name was recorded. Null
  // for a system close, which has no person behind it.
  closedByName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const mutation = useReopenShiftReport(reportId);

  // Somebody else reopened it between the page load and the click, so the
  // recovery is not "try again" — the badge on screen is out of date.
  const messages: StatusMessages = {
    403: t("report.reopenForbidden"),
    404: t("report.reopenGone"),
    409: t("report.reopenConflict"),
  };

  return (
    <ConfirmWriteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("report.reopenReportTitle")}
      description={
        <>
          {closedByName === null
            ? t("report.reopenAuto")
            : t("report.reopenNamed", { name: closedByName })}{" "}
          {t("report.reopenLogNote")}
        </>
      }
      confirmLabel={t("report.reopen")}
      pendingLabel={t("common.reopening")}
      successMessage={t("report.reopenReportSuccess")}
      messages={messages}
      fallback={t("report.reopenReportFallback")}
      mutation={mutation}
    />
  );
}

export { ReopenReportDialog };
