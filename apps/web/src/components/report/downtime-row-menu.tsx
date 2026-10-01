import { MoreVerticalIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// The per-row kebab on both downtime tables.
//
// "View detail" is live and needs no request: the row is already on screen.
//
// "EDIT" IS NOW REAL, BUT NOT ALWAYS AVAILABLE, and the difference from every
// other disabled item in this app matters enough to state. `report-actions`
// establishes the rule: disabled means NOBODY DESIGNED IT, enabled means a
// committed feature that can explain itself. This is neither — the feature exists
// and works, and it is unavailable for a reason specific to THIS ROW. So the
// disabled item carries a tooltip naming which reason applies, rather than sitting
// there greyed out and unexplained.
//
// The two reasons, and both are real states of live data:
//
//   no stable id   the stop has no source_event_id. The Gold table is loaded
//                  DELETE-then-INSERT, so its surrogate id is re-minted on every
//                  pipeline run — an edit keyed on that would eventually address
//                  a different stop, and the audit trail keys on the stable id
//                  too. This is EVERY row until the pipeline writes the column.
//   report approved somebody signed off the shift this stop belongs to. Reopen it
//                  from the report header first; the edit endpoint refuses
//                  otherwise, and the refusal is the point of approving.

type UnavailableReason = "no-stable-id" | "report-approved";

const REASON_COPY: Record<UnavailableReason, string> = {
  "no-stable-id":
    "This stop has no stable id yet, so changes to it could not be recorded. It will become editable once the pipeline assigns one.",
  "report-approved":
    "This shift report has been approved. Reopen it from the report header before editing its downtime.",
};

function DowntimeRowMenu({
  onViewDetail,
  onEdit,
  unavailableReason = null,
}: {
  onViewDetail: () => void;
  // Absent on tables that do not offer editing. The Availability Loss detail
  // table and the report's Downtime Details card both do.
  onEdit?: () => void;
  // null means editable. A reason means the item renders disabled, with that
  // reason as its tooltip.
  unavailableReason?: UnavailableReason | null;
}) {
  const { t } = useTranslation("oee");
  const editable = onEdit !== undefined && unavailableReason === null;
  const reasonKeys = {
    "no-stable-id": "report.editNoId",
    "report-approved": "report.editApproved",
  } as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={t("report.rowActions")}>
          <MoreVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {editable ? (
          <DropdownMenuItem onSelect={onEdit}>{t("common.edit")}</DropdownMenuItem>
        ) : (
          <Tooltip>
            {/* asChild onto a span, not onto the menu item: a disabled item is
                pointer-events:none, so a tooltip bound directly to it never
                fires and the explanation would be unreachable — which is the
                whole reason it exists. */}
            <TooltipTrigger asChild>
              <span className="block">
                <DropdownMenuItem
                  disabled
                  // Kept in the tab order so the reason is reachable by keyboard
                  // and by a screen reader, not only by hovering a mouse.
                  aria-describedby="downtime-edit-unavailable"
                >
                  {t("common.edit")}
                </DropdownMenuItem>
              </span>
            </TooltipTrigger>
            <TooltipContent id="downtime-edit-unavailable" className="max-w-xs">
              {unavailableReason === null
                ? t("report.editingUnavailable")
                : t(reasonKeys[unavailableReason])}
            </TooltipContent>
          </Tooltip>
        )}
        <DropdownMenuItem onSelect={onViewDetail}>{t("report.viewDetail")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { DowntimeRowMenu, REASON_COPY };
export type { UnavailableReason };
