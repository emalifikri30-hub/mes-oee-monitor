import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LossesCardShell } from "@/components/report/losses-card-shell";
import { QualityAction } from "@/components/report/quality-action";
import { QualityEntriesSheet } from "@/components/report/quality-entries-sheet";
import { SkuQualityEntryDialog } from "@/components/report/sku-quality-entry-dialog";
import { formatQuantity } from "@/lib/format";
import { qualityAddress } from "@/lib/report-subject";
import { useQualityEntries } from "@/lib/queries";

import type { QualityEntryKind, SkuReportDetail } from "@/lib/types";

// The SKU's six loss durations, its reject and its rework.
//
// THE SHELL FORMATS NOTHING, which is why the two counts arrive already formatted
// here. Both are on the INFEED side — the same side the line's are on — and the
// shell has no way to know that; handing it raw numbers would let it label
// cartons as bags. `losses={report}` passes a report where a `Pick` of six
// durations is wanted, which is safe by structural typing and keeps the shell
// unable to reach a unit, an id or a grain.
//
// NO HOURLY AFFORDANCE. The requirement excludes an hourly production chart from
// this screen, so there is no "View" button and no LinePerformanceDialog. That is
// a fact about this subject rather than about the layout, which is exactly why the
// shell takes `hourly` as a SLOT and not a boolean.
//
// ---------------------------------------------------------------------------
// Add Reject / Add Rework — THE CONSTRAINT IS ANSWERED, NOT WAIVED
// ---------------------------------------------------------------------------
//
// oee.work_center_quality_entries is keyed (work_center_id, business_date, SHIFT).
// That has not changed and must not: every entry is shift-keyed whatever screen
// produced it, which is what lets contract §18 be ONE dbt join. What this screen
// does is reach that key the way the line's COARSE dialogs already do — the report
// supplies the line and the business date, and the operator NAMES the shift.
//
// THE SKU IS FIXED, NOT PICKED, which is the one thing this subject adds. The
// report IS one product, so the field is read-only and the server refuses an entry
// naming a different one (resolveProductId 400s a mismatch, for the same reason it
// refuses a mismatched business date). A per-SKU entry is still not a per-SKU ROW:
// it is the same shift-keyed row with product_id filled in.
//
// AND THE EARLIER WORRY RESOLVED THE OTHER WAY. This card previously said an entry
// "would have to carry the SKU into an entry whose product_id is nullable" — and
// it is nullable in 0017, but the create dto REQUIRES it, so every row this
// service writes carries one. The per-SKU ledger therefore loses nothing and its
// totals reconcile to the line's.
//
// TODOS §62 is still open — the Quality Pareto reads a counter table and does not
// include hand-entered rejects — and it now applies to this screen too. That is a
// divergence between two cards, filed, and not a reason to withhold the write.
//
// The ledger line beneath each tile, and the argument for why the tile itself does
// not move, live in quality-action.tsx — one place, shared with the line card, so
// the two screens cannot tell an operator different things about the same DAG run.
function SkuLossesCard({ report }: { report: SkuReportDetail }) {
  const { t } = useTranslation("oee");
  const [adding, setAdding] = useState<QualityEntryKind | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const address = qualityAddress(report);
  const ledger = useQualityEntries(address);

  // Live totals per kind, in the entry's TARGET unit — which is the LINE's infeed
  // unit, the same one the tile is denominated in. Bucketed per unit upstream, so
  // a second bucket here means the line's unit changed between two entries; each
  // renders on its own rather than being added, for the §16.4 reason.
  const pending = (kind: QualityEntryKind) =>
    (ledger.data?.totals ?? []).filter((total) => total.kind === kind);

  return (
    <>
      <LossesCardShell
        losses={report}
        reject={formatQuantity(report.reject, report.infeedUomName)}
        rework={formatQuantity(report.rework, report.infeedUomName)}
        detailLink={
          <Button asChild variant="ghost" size="icon-sm">
            {/* A ROUTE LITERAL, not a template. TanStack can only check a literal,
              and the machine and line ones COMPILE here because the param name is
              the same — they would open an unrelated report at another subject,
              with a populated header and no warning. */}
            <Link to="/report/sku/by-day/$reportId/losses" params={{ reportId: String(report.id) }}>
              <ExternalLinkIcon />
              <span className="sr-only">{t("report.openLosses")}</span>
            </Link>
          </Button>
        }
        hourly={null}
        rejectAction={
          <QualityAction
            kind="reject"
            totals={pending("reject")}
            onAdd={() => setAdding("reject")}
            onBrowse={() => setBrowsing(true)}
          />
        }
        reworkAction={
          <QualityAction
            kind="rework"
            totals={pending("rework")}
            onAdd={() => setAdding("rework")}
            onBrowse={() => setBrowsing(true)}
          />
        }
      />

      {/* Mounted only while open, so the two catalogue queries inside it cost
          nothing on a page view — and so its per-open `requestId` is genuinely
          per-open rather than per-mount. */}
      {adding !== null ? (
        <SkuQualityEntryDialog
          report={report}
          kind={adding}
          open
          onOpenChange={(next) => {
            if (!next) setAdding(null);
          }}
        />
      ) : null}

      {/* THE ONLY PLACE AN ENTRY CAN BE CORRECTED. Mounted only while open, like
          the dialog: it reads the ledger WITH voided rows, which is a second cache
          entry, and a closed copy would fetch it on every page view. */}
      {browsing ? <QualityEntriesSheet address={address} open onOpenChange={setBrowsing} /> : null}
    </>
  );
}

export { SkuLossesCard };
