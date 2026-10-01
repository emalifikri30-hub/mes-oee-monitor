import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollTextIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SkuActivitySheet } from "@/components/report/sku-activity-sheet";

import type { SkuReportDetail } from "@/lib/types";

// The SKU report's header actions: ONE BUTTON.
//
// ---------------------------------------------------------------------------
// A BUTTON RATHER THAN A "…" MENU, AND THE OLD ARGUMENT SURVIVES IT
// ---------------------------------------------------------------------------
//
// sku-report-header.tsx used to pass `actions={null}`, reasoning that the "…"
// menu's only live item is Download — which downloads nothing on any of the six
// other screens (TODOS.md §67) — and that a seventh copy of a placeholder would
// make the feature look more shipped than it is. THAT IS STILL TRUE. Download is
// still a placeholder, and Regenerate and Adjust calculation are still undesigned.
//
// What changed is that this screen now has exactly ONE live action. A dropdown
// whose sole live item is that action is a menu of one: a control that looks like
// a choice and is not, which is the objection quality-entry-view.tsx makes two
// files over about a unit picker with one option. So: one button, no Download, no
// Regenerate, no Adjust.
//
// WHEN §67 SHIPS, this screen grows the menu and this button moves into it.
//
// ---------------------------------------------------------------------------
// AND NO APPROVE, WHICH IS A STRONGER ABSENCE THAN THE LINE'S
// ---------------------------------------------------------------------------
//
// oee.work_unit_shift_report_approvals is keyed (work_unit_id, date, shift). A
// LINE report has no approval row either, but it has child machine reports it can
// cascade over — which is what its Approve button does. A SKU report has neither a
// work unit nor a shift and no children to count, so there is nothing to sign and
// nothing to derive a badge from. The feed says so too, as its third source.
//
// ITS OWN FILE rather than a `subject` prop on line-report-actions.tsx, following
// that file's own rule: what the two differ in is WHICH MUTATION, WHICH SHEET and
// WHICH QUERY, and a prop that picks between them is a prop that can pick wrong.
function SkuReportActions({ report }: { report: SkuReportDetail }) {
  const { t } = useTranslation("oee");
  const [activityOpen, setActivityOpen] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={() => setActivityOpen(true)}>
        <ScrollTextIcon />
        {t("report.logActivity")}
      </Button>

      {/* Rendered unconditionally rather than only while open, matching the other
          two report screens: the sheet's own query is gated on `open`, so a closed
          panel costs a mount and no request. */}
      <SkuActivitySheet
        reportId={report.id}
        timeZone={report.timeZone}
        open={activityOpen}
        onOpenChange={setActivityOpen}
      />
    </div>
  );
}

export { SkuReportActions };
