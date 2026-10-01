import { useTranslation } from "react-i18next";

import { formatDateTime } from "@/lib/format";
import { renderValue } from "@/lib/activity";
import { useReasonHistory } from "@/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { ReasonSelectorParams } from "@/lib/api";
import type { DowntimeHistoryEntry, ReasonHistory } from "@/lib/types";

// What has been changed about the stops behind one reason.
//
// EMPTY EVERYWHERE TODAY, and the interesting design problem is saying so
// honestly. An empty list has two causes that look identical on screen and mean
// opposite things:
//
//   trackedMembers > 0  ->  these stops can be tracked; nobody has edited them
//   trackedMembers = 0  ->  none of them carries a source_event_id, so NOTHING
//                           about them could ever have been recorded
//
// Every row in the reporting database is the second case, because the pipeline
// does not write that key yet. "No history data available" over untracked data
// is a claim about the data that this panel is not entitled to make — the same
// silent-failure shape the watermark exists to prevent one card over.
//
// Gated on `open`, like performance-dialog.tsx: the panel is opt-in, so the
// request is too. A gated query reports pending forever, which is why the state
// ladder below reads `isOpen` before `isPending`.
function ChangesHistorySheet({
  params,
  open,
  onOpenChange,
  timeZone,
}: {
  params: ReasonSelectorParams | undefined;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  timeZone: string;
}) {
  const { t } = useTranslation("oee");
  const { data, isPending, isError } = useReasonHistory(params, open);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-1">
          <SheetTitle className="text-base">{t("report.changesHistory")}</SheetTitle>
          <SheetDescription>{t("report.historyDescription")}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6">
          <Body
            data={data}
            isPending={open && isPending}
            isError={isError}
            hasParams={params !== undefined}
            timeZone={timeZone}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Body({
  data,
  isPending,
  isError,
  hasParams,
  timeZone,
}: {
  data: ReasonHistory | undefined;
  isPending: boolean;
  isError: boolean;
  hasParams: boolean;
  timeZone: string;
}) {
  const { t } = useTranslation("oee");
  if (!hasParams) return <Note>{t("report.historyNoShift")}</Note>;
  if (isError) return <Note>{t("report.historyLoadError")}</Note>;
  if (isPending || data === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  // The distinction this whole payload exists for. Checked BEFORE the empty
  // case, because "not tracked" is the stronger statement and every stop is
  // currently in it.
  if (data.trackedMembers === 0) {
    return <Note>{t("report.historyNotTracked")}</Note>;
  }

  if (data.entries.length === 0) return <Note>{t("report.noHistory")}</Note>;

  return (
    <ol className="flex flex-col gap-3">
      {data.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} timeZone={timeZone} />
      ))}
    </ol>
  );
}

function Entry({ entry, timeZone }: { entry: DowntimeHistoryEntry; timeZone: string }) {
  const { t } = useTranslation("oee");
  return (
    <li className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{entry.field}</span>
        <span className="text-muted-foreground text-xs">
          {formatDateTime(entry.changedAt, timeZone)}
        </span>
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">{renderValue(entry.oldValue)}</span>
        {" → "}
        <span>{renderValue(entry.newValue)}</span>
      </p>
      <p className="text-muted-foreground text-xs">
        {t("common.byActor", { name: entry.changedBy })}
      </p>
    </li>
  );
}

function Note({ children }: { children: string }) {
  return (
    <div className="bg-muted text-muted-foreground flex min-h-9 items-center justify-center rounded-sm px-3 py-2 text-center text-xs">
      {children}
    </div>
  );
}

export { ChangesHistorySheet };
