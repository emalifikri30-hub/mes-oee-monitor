import { QualityEntryView } from "@/components/report/quality-entry-view";
import { qualityAddress } from "@/lib/report-subject";
import { useCreateQualityEntry } from "@/lib/mutations";
import { useLineMachines, useReportProducts } from "@/lib/queries";

import type { LineReportDetail, QualityEntryKind } from "@/lib/types";

// Recording reject or rework against a LINE report, at any of its three grains.
//
// A THIN CALLER OF QualityEntryView, which is the form and knows nothing about
// subjects. What lives HERE is the wiring: which machines endpoint answers, which
// products list, and which write. That split is line-report-actions.tsx's rule
// ("what the two differ in is WHICH MUTATION, WHICH SHEET and WHICH QUERY") and
// activity-log-view.tsx's — the choice stays at the call site where a test can
// assert it.
//
// `useLineMachines`, NOT `useSkuMachines`. The two take an id from a different
// sequence and hit a different path, and the failure mode of confusing them is a
// picker full of another line's machines rendered without a warning.
function LineQualityEntryDialog({
  report,
  kind,
  open,
  onOpenChange,
}: {
  report: LineReportDetail;
  kind: QualityEntryKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const machines = useLineMachines(report.grain, report.id);
  // WHAT ACTUALLY RAN, from the same source SKU View reads — see the view's
  // skuOptions comment for why this comes before the catalogue.
  const ran = useReportProducts(report);
  const mutation = useCreateQualityEntry(qualityAddress(report));

  return (
    <QualityEntryView
      kind={kind}
      open={open}
      onOpenChange={onOpenChange}
      workCenterId={report.workCenterId}
      infeedUomCode={report.infeedUomCode}
      sku={{
        kind: "pick",
        ran: (ran.data?.items ?? []).map((item) => ({
          productId: item.productId,
          productName: item.productName,
        })),
      }}
      // NARROWED HERE, not in the view. LineMachineBreakdown carries a `reportId`
      // — a MACHINE report's id — and the form has no business being able to reach
      // one.
      machines={(machines.data?.machines ?? []).map((machine) => ({
        workUnitId: machine.workUnitId,
        workUnitName: machine.workUnitName,
      }))}
      // A shift report names its own shift; a day or month one spans three and the
      // operator names it. Not a grain, because "is the shift already known" is
      // the question the field is actually asking.
      fixedShift={report.grain === "shift" ? report.shift : null}
      // A month spans ~30 business dates, so a shift alone does not identify one.
      // Bounded to the report's own month; the server re-checks it.
      datePicker={report.grain === "month" ? { min: report.businessDate } : null}
      mutation={mutation}
    />
  );
}

export { LineQualityEntryDialog };
