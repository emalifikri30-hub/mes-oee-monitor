import { useTranslation } from "react-i18next";

import { usePeriodReportActivity, useShiftReportActivity } from "@/lib/queries";
import { ActivityLogView } from "@/components/report/activity-log-view";

import type { FeedEntry } from "@/components/report/activity-log-view";

// Everything recorded against this MACHINE report, newest first.
//
// The panel itself lives in activity-log-view.tsx, shared with the Line screen.
// What stays here is the part that is about a machine: which endpoint answers, and
// what disambiguates an entry.
//
// Gated on `open`, like performance-dialog.tsx: the panel is opt-in, so the
// request is too. A gated query reports pending FOREVER, which is why `open` is
// folded into `isPending` below rather than read after it.
function ActivityLogSheet({
  reportId,
  grain,
  timeZone,
  open,
  onOpenChange,
}: {
  reportId: number;
  // Which report family the id belongs to. The three tables have independent id
  // sequences, so this is not cosmetic — it picks the endpoint and the cache key.
  grain: "shift" | "day" | "month";
  timeZone: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  // Two hooks, one picked. React forbids calling a hook conditionally, so the
  // one whose grain is not in play is gated off with `enabled: false` and costs
  // nothing.
  const isShift = grain === "shift";
  const shiftQuery = useShiftReportActivity(reportId, open && isShift);
  const periodQuery = usePeriodReportActivity(isShift ? "day" : grain, reportId, open && !isShift);
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = isShift ? shiftQuery : periodQuery;
  const grainLabel =
    grain === "shift"
      ? t("report.grainShift")
      : grain === "day"
        ? t("report.grainDay")
        : t("report.grainMonth");

  return (
    <ActivityLogView
      open={open}
      onOpenChange={onOpenChange}
      description={t("report.activityMachine", { grain: grainLabel })}
      emptyNote={t("report.activityEmptyShift")}
      data={data}
      isPending={open && isPending}
      isError={isError}
      timeZone={timeZone}
      contextOf={(entry) => machineContext(entry, t)}
    />
  );
}

// WHICH SHIFT, and only when there is more than one to confuse. `shift` is null on
// a shift report's own feed — naming it there would be noise — and a number on a
// day's or a month's, where the feed spans three reports or ~90. Without it, three
// approvals in a day's feed read as three approvals of the same thing.
//
// BOTH ARMS THAT CARRY THE FIELD, not just the approval one — and this used to test
// `entry.kind !== "approval"` and return early. That was correct while the day and
// month feeds had no quality arm (TODOS §64); it silently stopped being correct
// when they got one, because the browser's own `ActivityEntry` type did not declare
// a quality member either, so nothing failed. The result on screen was two 120 BAG
// rejects against one machine on different shifts rendering as one entry twice.
//
// The DOWNTIME arm still gets nothing: a stop is an event in time and carries no
// shift on this payload.
function machineContext(
  entry: FeedEntry,
  t: (key: string, opts?: { n: number }) => string,
): string | null {
  if (entry.kind === "downtime") return null;
  // BOTH AN `in` CHECK AND A `typeof`, each doing a different job. `contextOf` is
  // handed the panel's WIDE FeedEntry — every subject's feed — so `in` proves the
  // field is present at all, and `typeof` proves it is a number rather than the
  // null this feed sends at shift grain. Without the second, "shift null" reaches
  // the DOM.
  if (!("shift" in entry) || typeof entry.shift !== "number") return null;
  return t("report.shiftN", { n: entry.shift });
}

export { ActivityLogSheet };
