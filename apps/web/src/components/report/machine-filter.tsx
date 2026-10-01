import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EM_DASH } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { ReportDetail } from "@/lib/types";

// The "showing result by" control above every Loss tab's card.
//
// SCOPED TO THIS REPORT'S MACHINE, and inert as a result.
//
// A work unit IS one machine, so "All Machine" and the machine itself select
// exactly the same rows. It is here because the design shows it, and because the
// same control will serve the work-center scope /downtimes already accepts — at
// which point the second option becomes a real filter and the Machine Name column
// starts varying. Rendering it disabled would suggest something is broken;
// rendering it live and equivalent is honest about a one-machine report.
//
// Extracted from reason-pareto-card.tsx when the Quality Loss tab needed the same
// control. `useState` stays local: which machine is selected is a view preference
// on one card, which is the line by-shift_.$reportId_.losses.tsx draws between
// what belongs in the URL and what does not.
function MachineFilter({ report }: { report: ReportDetail }) {
  const { t } = useTranslation("oee");
  const [value, setValue] = useState("all");
  const machineId = String(report.workUnitId);

  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground shrink-0 text-sm">{t("report.showingResultBy")}</span>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger size="sm" className="w-56" aria-label={t("table.filterByMachine")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("table.allMachines")}</SelectItem>
          <SelectItem value={machineId}>{report.workUnitName ?? EM_DASH}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export { MachineFilter };
