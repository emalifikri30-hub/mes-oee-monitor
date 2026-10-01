import { useTranslation } from "react-i18next";

import { ActivityLogView } from "@/components/report/activity-log-view";
import { useAreaActivity } from "@/lib/queries";

import type { FeedEntry } from "@/components/report/activity-log-view";
import type { AreaGrain } from "@/lib/types";

// Everything recorded against this area's period, newest first.
//
// SERVES BOTH GRAINS UNCHANGED, unlike the LINE feed, which is shift-only because
// both its arms scope by a shift window over the line's machine reports (§60).
// These two arms scope by a business-DATE RANGE, so a month is the same query with
// a wider end — one endpoint, one shape, and a `contextOf` that already names the
// line because a day feed needed it.
//
// THE FOURTH THIN CALLER of ActivityLogView, beside activity-log-sheet.tsx
// (machine), line-activity-sheet.tsx and sku-activity-sheet.tsx. The panel needs NO
// change to serve a fourth subject, because AreaActivityEntry is a NARROWING of the
// line's entry union with two fields added rather than a new shape — which is the
// payoff of that component having been written to take data instead of a report.
//
// `useAreaActivity`, NOT any of the other three. All four take an id from a
// different sequence and hit a different path, and the failure mode of confusing
// them is a panel full of some other subject's history rendered without a warning —
// so the endpoint choice lives at this call site, where a test can assert it.
//
// TWO LIVE ARMS AND A NAMED THIRD. There is no approval arm in the entries at all
// (oee.work_unit_shift_report_approval_events is keyed (work_unit_id, date, shift),
// and an area day has neither), but `sources` still reports it as `not-applicable`.
//
// AND THAT ABSENCE NEEDS THE STRONGER ARGUMENT, unlike the SKU one. A SKU day has
// nothing to count; an area day DOES have child records it could report — a machine
// DAY feed reports its three child SHIFT reports' transitions, so "a coarse grain
// can still show approvals" is demonstrably true one subject over, and a reader who
// knows that will look for them here. The answer is that AN AREA REPORT IS NOT
// APPROVABLE: there is nothing to sign at this grain and no cascade defined for it,
// so the transitions that exist belong to the machine and line screens that can act
// on them. Three shifts' worth of sign-offs across every machine in an area would
// be a chronology nobody can act on from the page they are reading.
function AreaActivitySheet({
  grain,
  reportId,
  timeZone,
  open,
  onOpenChange,
}: {
  // WHICH OF THE TWO TABLES the id belongs to. Not a display concern: it selects
  // the endpoint AND the cache key, and the two have independent identity
  // sequences — so a missing grain is a panel full of another period's history,
  // rendered without a warning.
  grain: AreaGrain;
  reportId: number;
  timeZone: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = useAreaActivity(grain, reportId, open);

  return (
    <ActivityLogView
      open={open}
      onOpenChange={onOpenChange}
      description={grain === "day" ? t("report.activityAreaDay") : t("report.activityAreaMonth")}
      emptyNote={t("report.activityEmptyArea")}
      data={data}
      // `open &&` FIRST. A gated useQuery reports pending FOREVER, so passing
      // isPending straight through would render skeletons in a sheet nobody opened.
      isPending={open && isPending}
      isError={isError}
      timeZone={timeZone}
      contextOf={(entry) => areaContext(entry, t)}
    />
  );
}

// WHICH ONE — and this is the FOURTH distinct answer to the same question, so the
// reason belongs here rather than being assumed copied.
//
// The rule the panel states is that the suffix disambiguates along the axis the
// feed SPANS. A machine day feed spans three shifts, so it labels with the shift; a
// line shift feed spans N machines, so it labels with the machine; a SKU day feed
// spans both and falls back to whatever each ARM can carry.
//
// AN AREA DAY FEED SPANS THE MOST OF ANY OF THEM — three shifts, N lines, and every
// machine on them — and one axis is not enough. So each arm names the LINE first,
// because that is the coarsest thing that distinguishes two otherwise identical
// entries ("the filler" is a name several lines have), and adds the axis its own
// row can carry:
//
//   downtime  LINE and MACHINE. A stop is an event in time on a machine, and
//             carries no shift on this payload.
//   quality   LINE and SHIFT. An entry is shift-keyed, the shift varies across the
//             day, and a REWORK carries no work_unit_id at all — so a machine is
//             not a total answer here.
//
// Falls back to the id rather than to nothing: a numbered line is still an answer,
// where three unlabelled "Reject" rows are not.
function areaContext(
  entry: FeedEntry,
  t: (key: string, opts?: { n?: number; id?: number }) => string,
): string | null {
  // AN `in` CHECK *AND* A `typeof` ON EVERY FIELD, and both do a different job.
  // `contextOf` is handed the panel's WIDE FeedEntry — every subject's feed,
  // machine included — so `in` is what proves a field is present at all, and
  // `typeof` is what proves it is the type this feed sends rather than another
  // arm's. Without the second, the MACHINE approval arm's `shift: number | null`
  // interpolates as "shift null", and a field narrowed only by `in` widens to `{}`
  // and stringifies as "[object Object]". `numberOf` and `stringOf` below are those
  // two checks, once each.
  const line = labelOf(numberOf(entry, "workCenterId"), stringOf(entry, "workCenterName"), (id) =>
    t("report.lineId", { id }),
  );

  if (entry.kind === "quality") {
    const shift = numberOf(entry, "shift");
    return join(line, shift === null ? null : t("report.shiftN", { n: shift }));
  }

  if (entry.kind === "downtime") {
    const machine = labelOf(numberOf(entry, "workUnitId"), stringOf(entry, "workUnitName"), (id) =>
      t("report.machineId", { id }),
    );
    return join(line, machine);
  }

  return null;
}

// The NAME if there is one, else the noun and the id, else nothing. Falling back to
// the id rather than to nothing is deliberate: a numbered line is still an answer,
// where three unlabelled "Reject" rows are not.
function labelOf(
  id: number | null,
  name: string | null,
  fallback: (id: number) => string,
): string | null {
  if (name !== null) return name;
  return id === null ? null : fallback(id);
}

function numberOf(entry: FeedEntry, key: string): number | null {
  if (!(key in entry)) return null;
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function stringOf(entry: FeedEntry, key: string): string | null {
  if (!(key in entry)) return null;
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

// Both halves when both are known, whichever is known when only one is, and null
// when neither — rather than a string with a dangling separator in it.
function join(a: string | null, b: string | null): string | null {
  if (a !== null && b !== null) return `${a} · ${b}`;
  return a ?? b;
}

export { AreaActivitySheet };
