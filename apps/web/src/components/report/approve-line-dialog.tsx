import { useTranslation } from "react-i18next";

import { useApproveLineReport } from "@/lib/mutations";
import { ConfirmWriteDialog } from "@/components/report/confirm-write-dialog";

import type { StatusMessages } from "@/components/report/confirm-write-dialog";

// Confirm, then approve a LINE shift report — which approves every machine on it.
//
// THE COPY NAMES THE CASCADE, AND THAT IS THE POINT OF THIS FILE EXISTING.
// A line has no approval row of its own; the click closes N machine shift reports
// in oee.work_unit_shift_report_approvals. An operator who reads "approve this
// report" and gets three signatures has been misled by the dialog, so the count
// is in the sentence and comes from the same summary the Status tile renders.
//
// `useApproveLineReport`, NOT `useApproveShiftReport`. Nothing in
// ConfirmWriteDialog distinguishes them — the mutation is a prop precisely so this
// pairing sits here, where a test can assert it. The wrong hook would POST a
// line's id to /work-units/shift-reports/:id/approve, which has its own id
// sequence: either a 404, or somebody else's machine report signed off.
function ApproveLineDialog({
  reportId,
  machinesOpen,
  open,
  onOpenChange,
}: {
  reportId: number;
  // How many machines the click will actually close. From the approval summary,
  // so the dialog and the Status tile cannot disagree. Null while the summary is
  // still loading, and the copy then stays honest by not naming a number.
  machinesOpen: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const mutation = useApproveLineReport(reportId);

  // The server 404s when no machine on the line reported this shift — there is
  // nothing to sign rather than nothing to find.
  const messages: StatusMessages = {
    403: t("report.approveLineForbidden"),
    404: t("report.approveLineGone"),
    409: t("report.approveLineConflict"),
  };

  const scope =
    machinesOpen === null
      ? t("report.approveLineScopeUnknown")
      : machinesOpen === 1
        ? t("report.approveLineScopeOne")
        : t("report.approveLineScopeMany", { count: machinesOpen });

  return (
    <ConfirmWriteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("report.approveLineTitle")}
      description={t("report.approveLineBody", { scope })}
      confirmLabel={t("report.approve")}
      pendingLabel={t("common.approving")}
      successMessage={t("report.approveLineSuccess")}
      messages={messages}
      fallback={t("report.approveLineFallback")}
      mutation={mutation}
    />
  );
}

export { ApproveLineDialog };
