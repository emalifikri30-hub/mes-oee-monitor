import { useTranslation } from "react-i18next";

import { CATEGORY_TEXT_CLASS } from "@/lib/downtime";
import { EM_DASH, formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { DowntimeListItem, TimelineSegmentKind } from "@/lib/types";
import type { ReactNode } from "react";

function categoryLabel(t: (key: string) => string, category: TimelineSegmentKind): string {
  switch (category) {
    case "RUN_TIME":
      return t("report.categoryRuntime");
    case "SMALL_STOP":
      return t("report.categorySmallStop");
    case "PLANNED":
      return t("report.categoryPlanned");
    case "UNPLANNED":
      return t("report.categoryUnplanned");
    default: {
      const unhandled: never = category;
      return unhandled;
    }
  }
}

// One downtime record, in full.
//
// SHARED BY BOTH DETAIL TABLES — the Downtime Details card on the shift report
// and the Availability Loss detail page. That is the point: the same record must
// not describe itself differently depending on which screen it was opened from,
// and a second copy of this field list is how that happens. Both tables project
// the same columns server-side (`detailColumns` in downtime-repository.ts) so
// this component can assume every field is present on either.
//
// NO FETCH. The row is already in the calling table's page, so opening the
// drawer is free and cannot fail — which is why there is no loading or error
// state here and no query key for one.
//
// Half these fields are null on every row today: the pipeline that would write
// `areaName`, `detailReason`, `inputBy` and `maintainedBy` does not exist yet.
// They render as em dashes rather than being hidden, because a field the
// operator expects and cannot see is a question, while a blank one is an answer.
function DowntimeDetailSheet({
  row,
  open,
  onOpenChange,
}: {
  row: DowntimeListItem | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useTranslation("oee");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-1">
          <SheetTitle className="text-base">{t("report.detailDowntime")}</SheetTitle>
          <SheetDescription>{t("report.detailDowntimeBody")}</SheetDescription>
        </SheetHeader>

        {row === null ? null : (
          <dl className="flex flex-col gap-4 px-4 pb-6">
            <Pair label={t("report.areaName")} value={row.areaName} />
            <Pair label={t("report.lineName")} value={row.workCenterName} />
            <Pair label={t("report.machineName")} value={row.workUnitName} />

            <Pair label={t("report.downtimeCategory")}>
              <span className={cn("font-medium", CATEGORY_TEXT_CLASS[row.category])}>
                {categoryLabel(t, row.category)}
              </span>
            </Pair>

            {/* Every reason, not just the primary one. The Pareto groups on the
                first element; this drawer is where the rest of them are
                readable, which is the whole reason the row menu exists. */}
            <Pair label={t("report.reason")}>
              {row.reason.length === 0 ? (
                <Muted />
              ) : (
                <span className="flex flex-col gap-0.5">
                  {row.reason.map((reason, i) => (
                    <span key={`${reason}-${i}`}>{reason}</span>
                  ))}
                </span>
              )}
            </Pair>

            <Pair label={t("report.startTime")} value={formatDateTime(row.startAt, row.timeZone)} />
            {/* Null while a stop is still open, which is a normal state — the em
                dash reads as "still running" where a blank would read as missing. */}
            <Pair
              label={t("report.endTime")}
              value={row.endAt === null ? null : formatDateTime(row.endAt, row.timeZone)}
            />
            <Pair label={t("common.duration")} value={formatDuration(row.durationMs)} />

            <Pair label={t("report.detailReasonTitle")} value={row.detailReason} />

            <Pair label={t("report.actions")}>
              {row.actions.length === 0 ? (
                <Muted />
              ) : (
                <span className="flex flex-wrap gap-1">
                  {row.actions.map((action, i) => (
                    <Badge key={`${action}-${i}`} variant="action">
                      {action}
                    </Badge>
                  ))}
                </span>
              )}
            </Pair>

            <Pair label={t("report.inputBy")} value={row.inputBy} />
            <Pair label={t("report.maintainedBy")} value={row.maintainedBy} />
          </dl>
        )}
      </SheetContent>
    </Sheet>
  );
}

// A label over its value. `value` covers the common case; `children` is for the
// three fields that render something other than a string.
function Pair({
  label,
  value,
  children,
}: {
  label: string;
  value?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children ?? (value == null || value === "" ? <Muted /> : value)}</dd>
    </div>
  );
}

function Muted() {
  return <span className="text-muted-foreground">{EM_DASH}</span>;
}

export { DowntimeDetailSheet };
