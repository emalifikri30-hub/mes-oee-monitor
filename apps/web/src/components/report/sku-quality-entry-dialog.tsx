import { QualityEntryView } from "@/components/report/quality-entry-view";
import { qualityAddress } from "@/lib/report-subject";
import { useCreateQualityEntry } from "@/lib/mutations";
import { useSkuMachines } from "@/lib/queries";

import type { QualityEntryKind, SkuReportDetail } from "@/lib/types";

// Recording reject or rework against a SKU day report.
//
// A THIN CALLER OF QualityEntryView, beside line-quality-entry-dialog.tsx. Three
// of its props differ from the line's, and each is a fact about this subject:
//
//   sku          FIXED. The report IS one SKU, so it is a read-only field rather
//                than a picker — and the server refuses an entry naming a
//                different product (resolveProductId), so a picker would offer
//                choices that 400.
//   fixedShift   NULL, so the operator names one. oee.work_center_quality_entries
//                is keyed (work_center_id, business_date, SHIFT) whatever screen
//                produced the row, and a SKU day spans three. This is the LINE DAY
//                dialog's arrangement exactly.
//   datePicker   NULL. The report covers one business date and the server takes it
//                off the row, refusing a client that sends a different one — so
//                there is nothing to ask and nothing to get wrong.
//
// `useSkuMachines`, NOT `useLineMachines`. The two take an id from a different
// sequence and hit a different path, and the failure mode is a picker full of
// another line's machines rendered without a warning — so the endpoint choice
// lives at this call site, where a test can assert it.
function SkuQualityEntryDialog({
  report,
  kind,
  open,
  onOpenChange,
}: {
  report: SkuReportDetail;
  kind: QualityEntryKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const machines = useSkuMachines(report.id);
  const mutation = useCreateQualityEntry(qualityAddress(report));

  return (
    <QualityEntryView
      kind={kind}
      open={open}
      onOpenChange={onOpenChange}
      workCenterId={report.workCenterId}
      // The LINE's infeed unit, which is what the entry converts INTO — 0023
      // carries it on the SKU row, so there is no second read for it.
      infeedUomCode={report.infeedUomCode}
      sku={{ kind: "fixed", id: report.productId, name: report.productName }}
      machines={machines.data?.machines ?? []}
      fixedShift={null}
      datePicker={null}
      mutation={mutation}
    />
  );
}

export { SkuQualityEntryDialog };
