import { useState } from "react";
import { Undo2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EM_DASH, formatDateTime, formatQuantity } from "@/lib/format";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useQualityEntries } from "@/lib/queries";
import { useVoidQualityEntry } from "@/lib/mutations";

import type { QualityAddress } from "@/lib/report-subject";
import type { QualityEntry } from "@/lib/types";

// Every reject and rework entered by hand against this report, and the only place
// one can be corrected.
//
// INCLUDES THE VOIDED ONES, and that is the point of the sheet rather than an
// oversight. The card's ledger line shows what COUNTS; this shows what HAPPENED.
// A trail that hid the retraction would show the 500 and not the correction,
// which is the one thing an audit trail exists to prevent — so it reads "500, then
// that was wrong, then 50" rather than "50".
//
// THERE IS NO EDIT, only a void and a re-entry. Migration 0017's trigger enforces
// that against every writer, not just this one: a wrong figure sat on a report for
// however long it sat there, and an edit would erase that fact.
// TAKES AN ADDRESS, NOT A REPORT, and the whole sheet is then subject-agnostic
// with ZERO branches in it — it read only `report.grain` and `report.id` to begin
// with, so one value replaces both and serves a line report or a SKU one.
//
// A `subject` prop would have been the alternative and is how this sheet comes to
// void an entry on another report: seven report tables with seven independent id
// sequences, and `useVoidQualityEntry` posts to whichever path the value names.
function QualityEntriesSheet({
  address,
  open,
  onOpenChange,
}: {
  address: QualityAddress;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  // `includeVoided` is IN THE QUERY KEY, so this read and the card's live one are
  // separate cache entries. Sharing a key would make opening this sheet rewrite
  // the card's figure with a set that includes voided rows.
  const { data, isPending, isError } = useQualityEntries(address, true);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t("report.qualityEntries")}</SheetTitle>
          <SheetDescription>{t("report.entriesSheetBody")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
          {open && isPending ? <Skeleton className="h-24 w-full" /> : null}

          {isError ? (
            <p className="text-muted-foreground text-sm">{t("report.loadEntries")}</p>
          ) : null}

          {data !== undefined && data.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("report.noHandEntries")}</p>
          ) : null}

          {(data?.items ?? []).map((entry) => (
            <EntryRow key={entry.id} entry={entry} address={address} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EntryRow({ entry, address }: { entry: QualityEntry; address: QualityAddress }) {
  const { t } = useTranslation("oee");
  const [confirming, setConfirming] = useState(false);
  const voidEntry = useVoidQualityEntry(address);
  const voided = entry.voidedAt !== null;

  return (
    <div className={voided ? "rounded-lg border p-3 opacity-60" : "rounded-lg border p-3"}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            {entry.kind === "reject" ? t("report.reject") : t("report.rework")}
            {voided ? <Badge variant="secondary">{t("report.voided")}</Badge> : null}
            {/* "We could not check", never "we checked and it was fine". The
                server accepts an entry whose shift the pipeline has not reached,
                and the join decides in the end — so this says which case it is
                rather than implying the figure is confirmed. */}
            {entry.unitCheck === "unverified" && !voided ? (
              <Badge variant="outline">{t("report.unitUnconfirmed")}</Badge>
            ) : null}
          </p>

          {/* BOTH QUANTITIES. The operator recognises what they typed; the report
              moves by what it converted to. Showing only the second makes an
              entry unfindable to the person who wrote it. The two collapse into
              one line when the units already agree, which is the common case. */}
          <p className="mt-0.5 text-sm tabular-nums">
            {entry.enteredUomCode === entry.targetUomCode ? (
              formatQuantity(entry.targetQty, entry.targetUomCode)
            ) : (
              <>
                {formatQuantity(entry.enteredQty, entry.enteredUomCode)}
                <span className="text-muted-foreground">
                  {" = "}
                  {formatQuantity(entry.targetQty, entry.targetUomCode)}
                </span>
              </>
            )}
          </p>

          <p className="text-muted-foreground mt-1 text-xs">
            {[
              entry.productName,
              entry.reasonName,
              // Provenance. Named, but it does not mean the machine's own report
              // moved — see 0017's column comment.
              entry.workUnitName,
              t("report.shiftN", { n: entry.shift }),
            ]
              .filter((part) => part !== null && part !== "")
              .join(" · ")}
          </p>

          <p className="text-muted-foreground mt-1 text-xs">
            {entry.enteredByName ?? entry.enteredBy} ·{" "}
            {formatDateTime(entry.enteredAt, entry.timeZone)}
          </p>

          {voided ? (
            <p className="text-muted-foreground mt-1 text-xs">
              {t("report.voidedByName", { name: entry.voidedByName ?? entry.voidedBy ?? EM_DASH })}
              {entry.voidReason === null ? "" : ` — ${entry.voidReason}`}
            </p>
          ) : null}
        </div>

        {/* TWO PRESSES, because a void is not reversible from here: the row stays
            voided forever and the correction is a NEW entry. A single-click
            destructive action beside a list of similar rows is the shape a
            mis-click takes. */}
        {voided ? null : confirming ? (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={voidEntry.isPending}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="xs"
              disabled={voidEntry.isPending}
              onClick={() => voidEntry.mutate({ entryId: entry.id })}
            >
              {voidEntry.isPending ? t("common.voiding") : t("common.confirm")}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={() => setConfirming(true)}
          >
            <Undo2Icon className="size-3.5" />
            {t("report.void")}
          </Button>
        )}
      </div>

      {voidEntry.error !== null ? (
        <p className="text-destructive mt-2 text-xs">{t("report.voidFailed")}</p>
      ) : null}
    </div>
  );
}

export { QualityEntriesSheet };
