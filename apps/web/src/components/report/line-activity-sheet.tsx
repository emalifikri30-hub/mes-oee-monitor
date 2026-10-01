import { useTranslation } from "react-i18next";

import { useLineActivity } from "@/lib/queries";
import { ActivityLogView } from "@/components/report/activity-log-view";

import type { FeedEntry } from "@/components/report/activity-log-view";
import type { LineGrain } from "@/lib/types";

// Everything recorded against this LINE report, newest first.
//
// ALL THREE GRAINS, and the two coarse ones were a PRODUCT decision rather than a
// build. TODOS §60 held them open on density — a line day feed reports ~3N
// machine-shift transitions, "which may be a log rather than a feed" — and the
// answer, once the machine day feed and the area day feed had both shipped, is
// that it is a feed. What makes the density readable is the LABEL, which is why
// `lineContext` below now names two axes instead of one.
//
// `useLineActivity`, NOT `useShiftReportActivity` or `usePeriodReportActivity`.
// The two take an id from a different sequence and hit a different path, and the
// failure mode of confusing them is a panel full of some MACHINE's history
// rendered without a warning — so the endpoint choice lives at this call site,
// where line-report-actions.test.tsx can assert it.
function LineActivitySheet({
  grain,
  reportId,
  timeZone,
  open,
  onOpenChange,
}: {
  // WHICH OF THE THREE TABLES the id belongs to. Not a display concern: it selects
  // the endpoint AND the cache key, and the three have independent identity
  // sequences — so a wrong grain is a panel full of another period's history,
  // rendered without a warning. The same reason AreaActivitySheet takes one.
  grain: LineGrain;
  reportId: number;
  timeZone: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = useLineActivity(grain, reportId, open);

  return (
    <ActivityLogView
      open={open}
      onOpenChange={onOpenChange}
      description={
        grain === "shift"
          ? t("report.activityLineShift")
          : grain === "day"
            ? t("report.activityLineDay")
            : t("report.activityLineMonth")
      }
      emptyNote={
        grain === "shift"
          ? t("report.activityEmptyLineShift")
          : grain === "day"
            ? t("report.activityEmptyLineDay")
            : t("report.activityEmptyLineMonth")
      }
      data={data}
      // `open &&` FIRST. A gated useQuery reports pending FOREVER, so passing
      // isPending straight through would render skeletons in a sheet nobody opened.
      isPending={open && isPending}
      isError={isError}
      timeZone={timeZone}
      contextOf={(entry) => lineContext(entry, t)}
    />
  );
}

// A TOTAL MAP OVER THE GRAIN rather than a ternary, so a fourth grain would not
// compile without somebody writing its sentence. The wording differs because the
// SPAN differs, and a reader deciding whether an empty panel is surprising needs
// to know which span they are looking at.
// WHICH ONE — and the answer grew a second half when the coarse grains landed.
//
// The rule the panel states is that the suffix disambiguates along the axis the
// feed SPANS. A line SHIFT feed spans one shift and N machines, so the MACHINE was
// the whole answer. A line DAY feed spans three shifts AND N machines — the SKU
// feed's problem with an extra axis — so neither alone disambiguates, and both
// ship.
//
// THE SHIFT IS NULL AT SHIFT GRAIN, sent that way by the server rather than
// suppressed here: whether a shift is worth SAYING is a property of the feed, and
// the feed is what knows its own grain. So this function needs no grain of its
// own, which is the point — a `grain` parameter here would be a second place for
// the same decision to be made differently.
//
// Each half falls back to the id rather than to nothing: a numbered machine is
// still an answer, where three unlabelled "Approved" rows are not.
function lineContext(
  entry: FeedEntry,
  t: (key: string, opts?: { n?: number; id?: number }) => string,
): string | null {
  const machine = "workUnitId" in entry ? (entry.workUnitName ?? machineLabel(entry, t)) : null;
  // BOTH AN `in` CHECK AND A `typeof`, each doing a different job. `contextOf` is
  // handed the panel's WIDE FeedEntry — every subject's feed — so `in` proves the
  // field is present at all, and `typeof` proves it is a number rather than the
  // null this arm sends at shift grain. Without the second, "shift null" reaches
  // the DOM.
  const shift =
    "shift" in entry && typeof entry.shift === "number"
      ? t("report.shiftN", { n: entry.shift })
      : null;

  if (machine !== null && shift !== null) return `${machine} · ${shift}`;
  return machine ?? shift;
}

// `workUnitId` is `number | null` on the quality arm — a rework names no machine —
// so the id fallback has to admit that and produce nothing rather than
// "machine null".
function machineLabel(
  entry: FeedEntry & { workUnitId: number | null },
  t: (key: string, opts?: { id: number }) => string,
): string | null {
  return entry.workUnitId === null ? null : t("report.machineId", { id: entry.workUnitId });
}

export { LineActivitySheet };
