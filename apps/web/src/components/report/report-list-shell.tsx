import { CircleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";

import type { ReactNode } from "react";

// The chrome every report list screen wears: the ETL banner, and the card the
// filters and table sit in.
//
// Extracted on the third caller. Before this the banner's PROSE was written out
// twice, which is the part that matters — two screens telling operators
// different update hours is a support ticket nobody can reproduce, and nothing
// in the type system or the test suite would have noticed the drift.
//
// Presentational only: no query, no context, no filter state. Everything that
// varies is a slot.

function ReportListShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation("oee");

  return (
    <div className="flex flex-col gap-4">
      <Alert className="border-primary/20 bg-accent text-accent-foreground">
        <CircleAlertIcon />
        {/* Each time is a shift end plus 15 minutes — the ETL's grace period for
            closing the shift. A day or month roll-up cannot be complete before
            its last shift has closed, which is why the 23:15 run is the one that
            finishes a day. The boundaries themselves (07:00 / 15:00 / 23:00) are
            core-api's SHIFT_WINDOWS; this string is prose about them, and nothing
            parses it. */}
        <AlertDescription className="text-accent-foreground">
          {t("table.updateHours")}
        </AlertDescription>
      </Alert>

      <div className="bg-card flex flex-col gap-4 rounded-lg border p-4">{children}</div>
    </div>
  );
}

// The two-group filter row: the period on the left, everything that narrows the
// set on the right.
//
// SLOTS RATHER THAN FLAGS, and that is the whole design. The machine By Shift
// screen orders its right group Shift -> Line -> Status -> hide-zero; no
// `showStatus?: boolean` reproduces that without deciding where Status goes for
// every other screen too. An order that is configuration is an order somebody
// gets wrong, and the symptom is a visual change on a shipped screen.
function ReportListFilterBar({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-2">{left}</div>
      <div className="flex flex-wrap items-center gap-3">{right}</div>
    </div>
  );
}

export { ReportListFilterBar, ReportListShell };
