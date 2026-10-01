import { useTranslation } from "react-i18next";

import { ActivityLogView } from "@/components/report/activity-log-view";
import { useSkuActivity } from "@/lib/queries";

import type { FeedEntry } from "@/components/report/activity-log-view";

// Everything recorded against this SKU's day, newest first.
//
// THE THIRD THIN CALLER of ActivityLogView, beside activity-log-sheet.tsx (machine)
// and line-activity-sheet.tsx. The panel needs NO change to serve a third subject,
// because SkuActivityEntry is a NARROWING of the line's entry union rather than a
// new shape — which is the payoff of that component having been written to take
// data instead of a report.
//
// `useSkuActivity`, NOT `useLineActivity` and NOT `useShiftReportActivity`. All
// three take an id from a different sequence and hit a different path, and the
// failure mode of confusing them is a panel full of some other subject's history
// rendered without a warning — so the endpoint choice lives at this call site,
// where sku-report-actions.test.tsx can assert it.
//
// TWO LIVE ARMS AND A NAMED THIRD. There is no approval arm in the entries at all
// (oee.work_unit_shift_report_approval_events is keyed (work_unit_id, date, shift),
// and this grain has neither), but `sources` still reports it as
// `not-applicable` — the panel exists to separate "nothing was recorded" from
// "nothing COULD be recorded", and a reader who knows the other six screens carry
// approvals is answered rather than left to guess.
function SkuActivitySheet({
  reportId,
  timeZone,
  open,
  onOpenChange,
}: {
  reportId: number;
  timeZone: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = useSkuActivity(reportId, open);

  return (
    <ActivityLogView
      open={open}
      onOpenChange={onOpenChange}
      description={t("report.activitySku")}
      emptyNote={t("report.activityEmptySku")}
      data={data}
      // `open &&` FIRST. A gated useQuery reports pending FOREVER, so passing
      // isPending straight through would render skeletons in a sheet nobody opened.
      isPending={open && isPending}
      isError={isError}
      timeZone={timeZone}
      contextOf={skuContext}
    />
  );
}

// WHICH ONE — and this is the THIRD distinct answer to the same question, so the
// reason belongs here rather than being assumed copied.
//
// The rule the panel states is that the suffix disambiguates along the axis the
// feed SPANS. A machine day feed spans three shifts, so it labels with the shift; a
// line shift feed spans N machines, so it labels with the machine. A SKU DAY FEED
// SPANS BOTH — three shifts and N machines — so no single axis serves it, and the
// answer falls out of what each ARM can carry:
//
//   quality   labelled with its SHIFT. An entry is shift-keyed, the shift varies
//             across the day, and a REWORK carries no work_unit_id at all — so a
//             machine is not a total answer here.
//   downtime  labelled with its MACHINE. A stop is an event in time on a machine
//             and carries no shift on this payload.
//
// Falls back to the id rather than to nothing: a numbered machine is still an
// answer, where three unlabelled "Reject" rows are not.
function skuContext(entry: FeedEntry): string | null {
  // BOTH AN `in` CHECK AND A `typeof`, and each does a different job. `contextOf`
  // is handed the panel's WIDE FeedEntry — every subject's feed, machine included
  // — so `in` is what proves the field is present at all, the way lineContext's
  // does. `typeof === "number"` is what proves it is not the MACHINE approval
  // arm's `shift: number | null`, which would otherwise interpolate as "shift
  // null".
  if (entry.kind === "quality") {
    return "shift" in entry && typeof entry.shift === "number" ? `shift ${entry.shift}` : null;
  }
  if (entry.kind === "downtime" && "workUnitId" in entry) {
    return entry.workUnitName ?? `machine ${entry.workUnitId}`;
  }
  return null;
}

export { SkuActivitySheet };
