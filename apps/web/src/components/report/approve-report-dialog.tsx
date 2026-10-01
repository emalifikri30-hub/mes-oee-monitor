import { useTranslation } from "react-i18next";

import { useApproveShiftReport } from "@/lib/mutations";
import { ConfirmWriteDialog } from "@/components/report/confirm-write-dialog";

import type { StatusMessages } from "@/components/report/confirm-write-dialog";

// Confirm, then approve a MACHINE shift report.
//
// The ladder — stay open on failure, disable both buttons in flight, toast on
// success — lives in confirm-write-dialog.tsx, shared with reopen and with the
// Line screen's two writes. What stays here is the part that is about approving a
// machine: the copy, the status map, and WHICH MUTATION.
//
// WHY A CONFIRM STEP AT ALL. Approving closes the shift and stamps a person's
// name on it, and it now also FREEZES the shift's downtime: the edit endpoint
// refuses a stop belonging to an approved report. That is the consequence worth
// confirming, and it is what the body says.
//
// It is no longer one-way. Reopen shipped alongside the downtime edit — precisely
// because a freeze with no escape hatch is a trap — so the copy names the
// recovery instead of claiming there is none.
//
// `useApproveShiftReport` IS THE MACHINE WRITE, and the line's dialog calls a
// different hook. Nothing about the shell distinguishes them, so the pairing of
// this file's copy with this file's mutation is what a test has to assert.
function ApproveReportDialog({
  reportId,
  open,
  onOpenChange,
}: {
  reportId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const mutation = useApproveShiftReport(reportId);

  // The one worth naming. Somebody else approved it between the page load and
  // the click, so the recovery is not "try again" — it is "the badge you are
  // looking at is out of date". The mutation's onSuccess never ran, so the
  // caller refetches on close.
  const messages: StatusMessages = {
    403: t("report.approveForbidden"),
    404: t("report.approveGone"),
    409: t("report.approveConflict"),
  };

  return (
    <ConfirmWriteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("report.approveReportTitle")}
      description={t("report.approveReportBody")}
      confirmLabel={t("report.approve")}
      pendingLabel={t("common.approving")}
      successMessage={t("report.approveReportSuccess")}
      messages={messages}
      fallback={t("report.approveReportFallback")}
      mutation={mutation}
    />
  );
}

export { ApproveReportDialog };
