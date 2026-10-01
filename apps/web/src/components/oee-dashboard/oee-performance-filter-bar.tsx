import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DownloadReportDialog } from "@/components/report/download-report-dialog";
import { Button } from "@/components/ui/button";
import { SummaryFilter } from "@/components/report/report-list-filters";
import { ReportListFilterBar } from "@/components/report/report-list-shell";

import type { ReactNode } from "react";
import type { WorkCenterSummary, WorkUnitSummary } from "@/lib/types";

// The dashboard's filter bar: CHROME PLUS A SLOT, shared by all six screens.
//
// ─────────────────────────────────────────────────────────────────────────────
// A SLOT, NOT FIVE BOOLEANS — and the six control sets are why
// ─────────────────────────────────────────────────────────────────────────────
//
//   machine monthly   Year  Month  Line  Machine
//   machine yearly    Year         Line  Machine
//   line    monthly   Year  Month  Line
//   line    yearly    Year         Line
//   area    monthly   Year  Month
//   area    yearly    Year
//
// A `showMonth` / `showLine` / `showMachine` triple would make the ORDER of the row
// configuration, and report-list-shell.tsx already states the rule that follows from
// that: an order that is configuration is an order somebody gets wrong. Six separate
// components would instead be six copies of the Download button, its dialog state
// and the `Filter :` label — prose and an action placeholder, which is the cheapest
// thing in this app to let drift.
//
// So this keeps what every screen shares and takes the pickers as children, in the
// order the route writes them. `ReportListFilterBar`'s own `left`/`right` split is
// reused rather than re-laid-out, so these controls sit exactly where every report
// list's do.
//
// EVERY CONTROL IS DUMB. Options come in, changes go out; nothing here fetches and
// nothing here knows about a URL. The cascade (area -> line -> machine) lives in the
// route, which is the only place that can write a search param.
//
// THE TWO AREA SCREENS PASS NO AREA PICKER AT ALL. They read the HEADER's selection
// (`useSelectedArea`), because the requirement says to use it and a second picker
// would either duplicate it or disagree with it — the same call `Report > Area`
// already makes.
//
// THE DOWNLOAD BUTTON IS THE SHIPPED PLACEHOLDER, reused verbatim rather than
// reimplemented. TODOS.md §67 records the position it takes: Download is ENABLED and
// answers honestly, because it is a committed feature with a known shape, where
// Regenerate and Adjust calculation next to it on the report screens are DISABLED
// because nobody has designed them. It is a BUTTON rather than a "…" menu item for
// the reason the SKU screen's header gives: one live action does not earn a dropdown
// of one.
function OeePerformanceFilterBar({ children }: { children: ReactNode }) {
  const { t } = useTranslation("oee");
  const [downloadOpen, setDownloadOpen] = useState(false);

  return (
    <>
      <ReportListFilterBar
        left={
          <>
            <span className="text-muted-foreground shrink-0 text-sm">{t("common.filter")}</span>
            {children}
          </>
        }
        right={
          <Button variant="default" size="sm" onClick={() => setDownloadOpen(true)}>
            <DownloadIcon />
            {t("common.download")}
          </Button>
        }
      />
      <DownloadReportDialog open={downloadOpen} onOpenChange={setDownloadOpen} />
    </>
  );
}

// The two pickers this surface has, as named wrappers rather than four raw
// `SummaryFilter` call sites.
//
// WHAT THEY OWN IS THE ABSENCE OF AN "ALL" OPTION, and that is the rule worth a
// wrapper. The report lists' `LineFilter` passes an `allLabel`, because a list can
// meaningfully show every line at once. THIS SURFACE CANNOT: it draws ONE subject's
// period, so "All Lines" selects nothing it can render, and an item that resolves to
// an empty screen reads as a page still loading — which is exactly how the machine
// screen shipped first. `placeholder` is what an unset picker says instead.
//
// Four call sites across six routes would be four chances to pass an `allLabel` back
// in, and nothing would fail: the dropdown would simply offer a state the screen
// cannot draw.
function DashboardLineFilter({
  options,
  value,
  onChange,
}: {
  options: readonly WorkCenterSummary[];
  value: number | undefined;
  onChange: (id: number | undefined) => void;
}) {
  const { t } = useTranslation("oee");
  return (
    <SummaryFilter
      label={t("table.line")}
      placeholder={t("dashboard.noLines")}
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}

function DashboardMachineFilter({
  options,
  value,
  onChange,
}: {
  options: readonly WorkUnitSummary[];
  value: number | undefined;
  onChange: (id: number | undefined) => void;
}) {
  const { t } = useTranslation("oee");
  return (
    <SummaryFilter
      label={t("table.machine")}
      placeholder={t("dashboard.noMachines")}
      className="w-52"
      options={options}
      value={value}
      onChange={onChange}
    />
  );
}

export { DashboardLineFilter, DashboardMachineFilter, OeePerformanceFilterBar };
