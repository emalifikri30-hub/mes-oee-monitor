import { useTranslation } from "react-i18next";

import {
  entryActor,
  entryLabel,
  NOT_TRACKED_BODY,
  renderValue,
  SOURCE_TITLE,
} from "@/lib/activity";
import { EM_DASH, formatDateTime, formatQuantity } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import type { ActivityEntry, ActivitySource, LineActivityEntry } from "@/lib/types";

// The Log Activity panel, for any subject.
//
// EXTRACTED FROM activity-log-sheet.tsx when the Line detail screen needed the
// same panel over a different feed. What it does NOT do is pick its own query:
// the caller passes the result, so which endpoint answered stays at the call site
// where a test can assert it. SEVEN report tables have seven independent id
// sequences, and a `subject` prop choosing the query in here is how a Line panel
// ends up showing a MACHINE report's history.
//
// THREE CALLERS NOW, and this file needed NO CHANGE for the third. SkuActivityEntry
// is an `Extract` of the line's entry union — the two kinds a SKU day can carry —
// so it is assignable to FeedEntry below without widening anything. That is what
// "takes data" bought.
//
// THE HARD PART IS NOT THE LIST, IT IS SAYING WHAT IS MISSING. Three sources feed
// this panel and not all of them can carry a row, so an empty chronology has
// several causes that look identical on screen and mean different things.
// `sources` is the payload that separates them.
//
// ONE ENTRY TYPE PER SUBJECT, MERGED HERE AS A UNION, because the feeds label an
// entry with different context: a machine's names the SHIFT (its day feed spans
// three reports), a line's names the MACHINE (its shift spans N of them), and a
// SKU's names WHICHEVER THE ARM CAN CARRY (its day spans both axes at once — see
// skuContext). That difference is passed in as `contextOf` rather than branched on
// here: the panel has no way to know which subject it is looking at, and should
// not. The SKU union is a NARROWING of the line's, so it needs no member here.
type FeedEntry = ActivityEntry | LineActivityEntry;

type Feed = {
  timeZone: string;
  entries: FeedEntry[];
  sources: ActivitySource[];
};

function ActivityLogView({
  open,
  onOpenChange,
  description,
  emptyNote,
  data,
  isPending,
  isError,
  timeZone,
  contextOf,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  description: string;
  // "No activity recorded for this shift yet." / "…for this line shift yet."
  emptyNote: string;
  data: Feed | undefined;
  isPending: boolean;
  isError: boolean;
  timeZone: string;
  // The suffix beside an entry's label — " · shift 2" or " · Vertical Packer".
  // Null when there is nothing worth naming.
  contextOf: (entry: FeedEntry) => string | null;
}) {
  const { t } = useTranslation("oee");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-1">
          <SheetTitle className="text-base">{t("report.logActivity")}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 px-4 pb-6">
          <Body
            data={data}
            isPending={isPending}
            isError={isError}
            timeZone={timeZone}
            emptyNote={emptyNote}
            contextOf={contextOf}
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
  timeZone,
  emptyNote,
  contextOf,
}: {
  data: Feed | undefined;
  isPending: boolean;
  isError: boolean;
  timeZone: string;
  emptyNote: string;
  contextOf: (entry: FeedEntry) => string | null;
}) {
  const { t } = useTranslation("oee");
  if (isError) return <Note>{t("report.activityLoadError")}</Note>;
  if (isPending || data === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const untracked = data.sources.filter((source) => !source.tracked);
  // "No activity recorded" is a claim about the DATA, and it is only ours to
  // make when at least one arm could have carried something. With every arm
  // untracked the truth is that nothing about this report could ever have been
  // recorded — the same reason changes-history-sheet.tsx checks trackedMembers
  // BEFORE its empty case.
  const anyTracked = data.sources.some((source) => source.tracked);

  return (
    <>
      {data.entries.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {data.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} timeZone={timeZone} context={contextOf(entry)} />
          ))}
        </ol>
      ) : anyTracked ? (
        <Note>{emptyNote}</Note>
      ) : null}

      {/* RENDERED REGARDLESS OF WHETHER THE LIST ABOVE HAS ROWS, and this is the
          rule to defend hardest in this file. A populated chronology can sit
          beside an arm that is missing entirely — so an untracked arm must never
          be hidden by a populated one, or the panel begins lying on the day it
          starts working. */}
      {untracked.length > 0 ? <NotTracked sources={untracked} /> : null}
    </>
  );
}

function NotTracked({ sources }: { sources: ActivitySource[] }) {
  const { t } = useTranslation("oee");

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("common.notTracked")}
      </h3>
      <ul className="flex flex-col gap-2">
        {sources.map((source) => (
          <li key={source.kind} className="bg-muted rounded-sm px-3 py-2">
            <p className="text-xs font-medium">{SOURCE_TITLE[source.kind]}</p>
            <p className="text-muted-foreground text-xs">
              {source.untrackedReason === null ? null : NOT_TRACKED_BODY[source.untrackedReason]}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Entry({
  entry,
  timeZone,
  context,
}: {
  entry: FeedEntry;
  timeZone: string;
  context: string | null;
}) {
  const { t } = useTranslation("oee");

  return (
    <li className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          {entryLabel(entry)}
          {/* WHICH ONE, and only when there is more than one to confuse. Supplied
              by the caller, because what disambiguates an entry depends on what
              the feed spans: a machine day's feed covers three shifts, a line
              shift's covers N machines. Without it, three approvals in either
              read as three approvals of the same thing. */}
          {context === null ? null : (
            <span className="text-muted-foreground font-normal"> · {context}</span>
          )}
        </span>
        <span className="text-muted-foreground text-xs">{formatDateTime(entry.at, timeZone)}</span>
      </div>

      {/* THREE VOCABULARIES, because these are three kinds of event, and the
          third arm is a bug fix. This was "approval, else downtime", so a
          QUALITY entry fell into the downtime arm and rendered its oldValue and
          newValue — fields it does not have — as "— → —" under the heading
          "Downtime · undefined".

          An approval moves between states; a downtime edit changes a field's
          value; a quality entry RECORDS A QUANTITY, which is neither. */}
      <p className="text-sm">
        {entry.kind === "approval" ? (
          <>
            <span className="text-muted-foreground capitalize">{entry.fromStatus}</span>
            {" → "}
            <span className="capitalize">{entry.toStatus}</span>
          </>
        ) : entry.kind === "quality" ? (
          <QualityEntryLine entry={entry} timeZone={timeZone} />
        ) : (
          <>
            <span className="text-muted-foreground">{renderValue(entry.oldValue)}</span>
            {" → "}
            <span>{renderValue(entry.newValue)}</span>
          </>
        )}
      </p>

      {/* entryActor, never entry.by: that field is the Keycloak SUBJECT, and
          rendering it puts a UUID in front of an operator. The name-with-
          fallback lives in lib/activity.ts so this and the header badge cannot
          disagree about who approved a report. */}
      <p className="text-muted-foreground text-xs">
        {t("common.byActor", { name: entryActor(entry) })}
      </p>
    </li>
  );
}

// What an operator recorded, in the words they recorded it in.
//
// BOTH QUANTITIES WHEN THEY DIFFER — an operator who typed 10 cartons has to
// recognise their own entry in a feed otherwise denominated in bags — and one
// when the units agree, which is the common case and would otherwise read as
// "180 BAG = 180 BAG".
//
// A VOID IS SHOWN ON THE SAME ENTRY rather than as a second event: one action,
// one row, matching how a downtime edit reads. A feed that dropped the
// retraction would show the 500 and not the correction, which is the one thing
// an audit trail exists to prevent.
function QualityEntryLine({
  entry,
  timeZone,
}: {
  entry: Extract<FeedEntry, { kind: "quality" }>;
  timeZone: string;
}) {
  const { t } = useTranslation("oee");
  const sameUnit = entry.enteredUomCode === entry.targetUomCode;

  return (
    <>
      <span className={entry.voidedAt === null ? undefined : "line-through"}>
        {sameUnit
          ? formatQuantity(entry.targetQty, entry.targetUomCode)
          : `${formatQuantity(entry.enteredQty, entry.enteredUomCode)} = ${formatQuantity(entry.targetQty, entry.targetUomCode)}`}
      </span>
      {[entry.productName, entry.reasonName]
        .filter((part): part is string => part !== null && part !== "")
        .map((part) => (
          <span key={part} className="text-muted-foreground">
            {" · "}
            {part}
          </span>
        ))}
      {entry.voidedAt === null ? null : (
        <span className="text-muted-foreground block text-xs">
          {t("report.voidedBy", {
            name: entry.voidedByName ?? entry.voidedBy ?? EM_DASH,
            when: formatDateTime(entry.voidedAt, timeZone),
          })}
          {entry.voidReason === null ? "" : ` — ${entry.voidReason}`}
        </span>
      )}
    </>
  );
}

function Note({ children }: { children: string }) {
  return (
    <div className="bg-muted text-muted-foreground flex min-h-9 items-center justify-center rounded-sm px-3 py-2 text-center text-xs">
      {children}
    </div>
  );
}

export { ActivityLogView };
export type { Feed, FeedEntry };
