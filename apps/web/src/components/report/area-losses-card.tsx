import { ExternalLinkIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LossesCardShell } from "@/components/report/losses-card-shell";
import { formatQuantity } from "@/lib/format";

import type { AreaReportDetail } from "@/lib/types";

// The AREA's six loss durations, its reject and its rework.
//
// THE SHELL FORMATS NOTHING, which is why the two counts arrive already formatted
// here. Both are MASSES, in the area's single `weightUomName` — a line's two counts
// there are both infeed-side in the line's own unit, and a machine's are in its
// one. The shell has no way to know which, and handing it raw numbers is how a
// figure gets rendered under the wrong label.
//
// `losses={report}` passes a report where a `Pick` of six durations is wanted,
// which is safe by structural typing and keeps the shell unable to reach a unit,
// an id or a grain.
//
// ---------------------------------------------------------------------------
// NO ADD REJECT, NO ADD REWORK, AND NO LEDGER — BY REQUIREMENT *AND* BY SCHEMA
// ---------------------------------------------------------------------------
//
// The requirement is explicit: "no add reject/rework" on an area report. The schema
// agrees, and it is worth saying why rather than only that, because the line and
// SKU cards both DO offer it:
//
// oee.work_center_quality_entries is keyed (work_center_id, business_date, SHIFT).
// The line's coarse dialogs reach that key by having the report supply the line and
// the business date while the operator names the shift; the SKU dialog does the
// same with the product fixed. AN AREA REPORT CANNOT SUPPLY THE LINE — it spans N
// of them — so an area-level Add button would have to make the operator pick one,
// which is a choice they are already making on the line screen it would send them
// to. A control that exists only to redirect is worse than its absence.
//
// So `rejectAction` and `reworkAction` are omitted entirely rather than passed as
// disabled buttons: the shell takes them as optional SLOTS precisely so a subject
// with nothing to put there says nothing. `quality-action.tsx`'s "+140 BAG entered"
// ledger line goes with them — the tile has nothing pending against it, because
// nothing can be entered here.
//
// NO HOURLY AFFORDANCE either. There is no `product_perf_area_hour` table, and an
// area-summed curve off the LINE hourly table would be the roll-up contract §19.1
// refuses one grain down: it would not integrate to the totals in the card above.
// So there is no "View" button and no dialog. That is a fact about this subject
// rather than about the layout, which is exactly why the shell takes `hourly` as a
// SLOT and not a boolean.
function AreaLossesCard({ report }: { report: AreaReportDetail }) {
  const { t } = useTranslation("oee");
  return (
    <LossesCardShell
      losses={report}
      // ONE UNIT FOR BOTH, and it is a mass. See area-overview-card.tsx for why an
      // area has one unit where a line has two — and why a single local is safe
      // here and forbidden there.
      reject={formatQuantity(report.reject, report.weightUomName)}
      rework={formatQuantity(report.rework, report.weightUomName)}
      detailLink={
        <Button asChild variant="ghost" size="icon-sm">
          {/* TWO ROUTE LITERALS PICKED BY GRAIN, not a template. TanStack can only
              check a literal, and the machine, line and SKU ones all COMPILE here
              because the param name is the same — any of them would open an
              unrelated report at another subject, with a populated header and no
              warning. The two AREA ones compile in each other's place too, and
              that is worse rather than better: the two tables have independent
              identity sequences, so a day id opened at month grain lands on a real
              MONTH report about a different period. */}
          {report.grain === "day" ? (
            <Link
              to="/report/area/by-day/$reportId/losses"
              params={{ reportId: String(report.id) }}
            >
              <ExternalLinkIcon />
              <span className="sr-only">{t("report.openLosses")}</span>
            </Link>
          ) : (
            <Link
              to="/report/area/by-monthly/$reportId/losses"
              params={{ reportId: String(report.id) }}
            >
              <ExternalLinkIcon />
              <span className="sr-only">{t("report.openLosses")}</span>
            </Link>
          )}
        </Button>
      }
      hourly={null}
    />
  );
}

export { AreaLossesCard };
