import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CheckIcon } from "lucide-react";
import { MetricTile } from "@/components/report/metric-tile";

import type { MetricSpec } from "@/components/report/metrics-card";
import type { ReactNode } from "react";

// The identity strip's LAYOUT: what this report is on the left, what you may do
// to it on the right. Nothing else.
//
// EXTRACTED FROM report-header.tsx when the Line detail screen arrived. It takes
// tiles and an actions node rather than a report, for the reason metrics-card.tsx
// records: the two callers do not differ by a flag, they differ by which facts
// exist. A machine header names a Machine and can show an Open/Closed badge; a
// line header names a Line and cannot — nothing in Gold holds a line's signature,
// so its status is a COUNT of other records.
//
// Keeping this file ignorant of both is what stops a `subject` prop from growing
// here and quietly deciding which badge a report gets.
function ReportHeaderShell({ tiles, actions }: { tiles: MetricSpec[]; actions: ReactNode }) {
  return (
    <Card className="flex-row flex-wrap items-center justify-between gap-4 px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
        {tiles.map((tile) => (
          <MetricTile key={tile.label} label={tile.label} value={tile.value} />
        ))}
      </div>

      {actions}
    </Card>
  );
}

// A STATUS TILE THAT COUNTS OTHER RECORDS, AND CANNOT BE MISREAD AS A SIGNATURE.
//
// Shared by the machine DAY header ("2 of 3 shifts approved") and the LINE SHIFT
// header ("4 of 5 machines approved"). Both are in the same position: there is no
// approval row for the thing on screen, because oee.work_unit_shift_report_approvals
// is keyed (work_unit_id, date, shift) — a day has three of those and a line has
// one per machine, and neither has one of its own.
//
// Reusing the Open/Closed badge would have matched the machine shift header and
// asserted a sign-off nobody gave. A fraction cannot be misread that way, and it
// tells the supervisor the thing they would ask next: what is still outstanding.
//
// The full-house case says "Approved" rather than "3 of 3" because at that point
// the count adds nothing — but it stays `secondary`, the same quiet treatment a
// closed shift gets, so nobody reads it as an action.
//
// `noun` and `emptyLabel` are the only things that differ between the two
// callers, and they are passed rather than derived: "shifts"/"machines" is not
// something this component can work out, and guessing would put the wrong word
// in front of a supervisor.
function DerivedApprovalBadge({
  total,
  closed,
  noun,
  emptyLabel,
}: {
  total: number;
  closed: number;
  noun: string;
  emptyLabel: string;
}) {
  const { t } = useTranslation("oee");

  // Nothing in the window at all. "0 of 0 approved" reads as a real answer about
  // a real period; this says the pipeline has not filled it in.
  if (total === 0) {
    return (
      <Badge variant="outline" className="font-normal">
        {emptyLabel}
      </Badge>
    );
  }

  if (closed === total) {
    return (
      <Badge variant="secondary" className="font-normal">
        <CheckIcon />
        {t("table.approved")}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="font-normal">
      {t("common.ofApproved", { closed, total, noun })}
    </Badge>
  );
}

export { DerivedApprovalBadge, ReportHeaderShell };
