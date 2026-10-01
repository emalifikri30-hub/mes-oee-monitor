import { useTranslation } from "react-i18next";

import { useReopenLineReport } from "@/lib/mutations";
import { ConfirmWriteDialog } from "@/components/report/confirm-write-dialog";

import type { StatusMessages } from "@/components/report/confirm-write-dialog";

// Confirm, then reopen a LINE shift report — withdrawing every machine's approval
// on it.
//
// A STRONGER ACT THAN APPROVING, twice over: it undoes sign-offs, and it may undo
// several people's at once. The machine dialog names the single approver it is
// overriding; a line's cannot, because N machines may have been closed by N
// different operators at different times. So the copy names the COUNT and points
// at the activity log, which is where the individual names are — rather than
// picking one to display, which would be a claim about who is being overridden.
function ReopenLineDialog({
  reportId,
  machinesClosed,
  open,
  onOpenChange,
}: {
  reportId: number;
  // How many approvals the click will withdraw. From the same summary the Status
  // tile reads; null while it is loading, and the copy then names no number.
  machinesClosed: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const mutation = useReopenLineReport(reportId);

  const messages: StatusMessages = {
    403: t("report.reopenLineForbidden"),
    404: t("report.reopenLineGone"),
    409: t("report.reopenLineConflict"),
  };

  const scope =
    machinesClosed === null
      ? t("report.reopenLineScopeUnknown")
      : machinesClosed === 1
        ? t("report.reopenLineScopeOne")
        : t("report.reopenLineScopeMany", { count: machinesClosed });

  return (
    <ConfirmWriteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("report.reopenLineTitle")}
      description={t("report.reopenLineBody", { scope })}
      confirmLabel={t("report.reopen")}
      pendingLabel={t("common.reopening")}
      successMessage={t("report.reopenLineSuccess")}
      messages={messages}
      fallback={t("report.reopenLineFallback")}
      mutation={mutation}
    />
  );
}

export { ReopenLineDialog };
