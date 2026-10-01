import { isAxiosError } from "axios";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCreateDowntimeAction, useEditDowntime } from "@/lib/mutations";
import { useDowntimeActionOptions, useDowntimeReasonOptions } from "@/lib/queries";
import { slugifyCode } from "@/lib/slug";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OptionTagInput } from "@/components/ui/option-tag-input";
import { Textarea } from "@/components/ui/textarea";

import type { AutocompleteOption } from "@/components/ui/option-tag-input";
import type { DowntimeCategory, DowntimeEdit, DowntimeListItem } from "@/lib/types";
import type { ReportAddress } from "@/lib/report-subject";

// Edit one downtime's category, reasons, detail reason and actions.
//
// WHAT THIS DIALOG IS RESPONSIBLE FOR, and what it deliberately is not.
//
// It owns the four inputs, the dirty check, and the error surface. It does NOT
// validate: the server's Zod schema trims, rejects blanks, dedupes and caps, and
// a 422 renders here like any other failure. OptionTagInput mirrors those rules
// so the operator hears about a blank at the keyboard, but the authority stays on
// one side — two validators that could disagree would be worse than one that is
// occasionally late.
//
// REASON AND ACTION COME FROM MES-MASTER-DATA'S CATALOGUES, and the two pickers
// are NOT symmetric. That asymmetry is the design, not an inconsistency:
//
//   Reason  scoped to this report's LINE, and CLOSED. An unmatched search yields
//           nothing and Enter does nothing. Element 0 of `reason` is the key the
//           Availability Pareto groups on, so inventing one here would put a bar
//           on that chart which no line's catalogue owns and nobody maintains.
//           A reason that is genuinely missing is a master-data change.
//   Action  regional (upstream has no per-line scoping for actions) and OPEN: an
//           unmatched name is CREATED on Enter, code slugified, colour rose. An
//           operator recording what they did about a stop will not stop to open
//           another app, so a closed list here would be answered with a
//           near-miss from the list — which is worse data than a new row.
//
// BOTH STORE THE NAME. See ui/option-tag-input.tsx: these columns are jsonb
// string arrays the pipeline also writes into, so there is no id to store.
//
// WHY THE ERROR IS INLINE AND SUCCESS IS A TOAST is settled in
// approve-report-dialog.tsx and holds for the same reasons: the user is about to
// press the button again, so the message has to stay next to it.
//
// THE BASELINE IS CAPTURED WHEN THE DIALOG OPENS, not read live from the row.
// That is the whole optimistic-concurrency story: the server matches these values
// in the UPDATE's WHERE, so if the row has moved since — another operator, or the
// nightly pipeline run — the write is refused rather than silently reverting
// somebody. Reading `row` live here would defeat it, because the row prop
// refreshes when the table refetches.

function messageByStatus(t: (key: string) => string): Record<number, string> {
  return {
    400: t("report.downtimeNoId"),
    404: t("report.downtimeGone"),
    422: t("report.downtimeRejected"),
  };
}

// TWO STATUSES WHERE THE SERVER'S TEXT BEATS LOCAL COPY, and this is the only
// place in the app that makes that choice — so it is a named list rather than a
// condition buried in the function below.
//
//   409  the freeze. The message names WHICH SHIFT is approved, and it has to: a
//        stop straddling midnight can be frozen by a shift that is not its own,
//        so "reopen the report" alone would send somebody to the wrong one.
//   412  the row moved. The message says whether another OPERATOR or the
//        PIPELINE got there first — a distinction a status code cannot carry, and
//        one where guessing would name a colleague for what a DAG did.
const SERVER_WORDS_IT_BETTER = new Set([409, 412]);

const FALLBACK_KEY = "report.downtimeSaveFallback";

// The error envelope is `{ data, meta, error }`, so the message is already on the
// wire — narrowed rather than cast, because a non-2xx body is not typed.
function servedMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const served = (body as { error?: unknown }).error;
  return typeof served === "string" && served.length > 0 ? served : undefined;
}

function messageFor(error: unknown, t: (key: string) => string): string {
  if (!isAxiosError(error)) return t(FALLBACK_KEY);

  const status = error.response?.status;
  if (status !== undefined && SERVER_WORDS_IT_BETTER.has(status)) {
    const served = servedMessage(error.response?.data);
    if (served !== undefined) return served;
  }

  return (status === undefined ? undefined : messageByStatus(t)[status]) ?? t(FALLBACK_KEY);
}

function categoryLabel(t: (key: string) => string, category: DowntimeCategory): string {
  switch (category) {
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

const CATEGORIES: DowntimeCategory[] = ["UNPLANNED", "PLANNED", "SMALL_STOP"];

// Tailwind rose-500, the colour an action created from THIS dialog is born with.
//
// A fixed default rather than a picker: the operator is mid-way through recording
// a stop, and asking them to choose a colour for a taxonomy they did not know they
// were extending is a question with no right answer at that moment. The colour is
// editable afterwards in the master-data app, which is where the catalogue is
// actually curated.
const NEW_ACTION_COLOR = "#f43f5e";

// The create is its own request with its own failure, so it gets its own message
// rather than borrowing the save error's. 409 is the one worth naming: it means
// somebody else created the same action between the search and the Enter.
const CREATE_ACTION_FAILED_KEY = "report.actionCreateFailed";

// Projects a row down to the four editable fields.
//
// `category` is narrowed from TimelineSegmentKind: RUN_TIME is what a GAP between
// records is called and is never stored, so a row can never actually carry it —
// but the row type admits it because the timeline shares that union.
function editOf(row: DowntimeListItem): DowntimeEdit {
  return {
    category: row.category === "RUN_TIME" ? "UNPLANNED" : row.category,
    reason: row.reason,
    detailReason: row.detailReason,
    actions: row.actions,
  };
}

// Matches the server's diff, so Save is disabled exactly when the server would
// answer "unchanged". Arrays compare element-wise AND order-sensitively, because
// element 0 of `reason` is the key the Pareto groups on — a reorder is a real
// change, and treating it as a no-op here would leave Save greyed out over an
// edit the server would happily accept.
function isDirty(a: DowntimeEdit, b: DowntimeEdit): boolean {
  return (
    a.category !== b.category ||
    a.detailReason !== b.detailReason ||
    !sameList(a.reason, b.reason) ||
    !sameList(a.actions, b.actions)
  );
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function DowntimeEditDialog({
  row,
  address,
  workCenterId,
  open,
  onOpenChange,
}: {
  row: DowntimeListItem | null;
  // WHERE THE REPORT ON SCREEN LIVES — subject, grain and id in one value. Not
  // cosmetic: it selects the cache keys the successful edit invalidates, and all
  // three coordinates are needed because there are seven report tables with seven
  // independent sequences. Derived from the report with `reportAddress`, never
  // assembled at a call site.
  address: ReportAddress;
  // The line whose Reason catalogue applies to this stop.
  //
  // TAKEN FROM THE REPORT WHERE THE REPORT HAS ONE, AND FROM THE ROW WHERE IT DOES
  // NOT — which is a change, and the reason is the AREA subject.
  //
  // This used to read "taken from the REPORT, not from the row", on the grounds
  // that `DowntimeListItem` carried `workCenterName` and no id. That was true and
  // it stopped being the whole story: an AREA report spans N lines, so there is no
  // single report-level line to take, and the only thing that knows which
  // catalogue applies to a given stop is the stop. The row now carries
  // `workCenterId` for exactly that (see DowntimeListItem), and the two call sites
  // read it for an area report and the report's own for every other subject.
  //
  // The old objection still stands for the other three subjects and is why they
  // were NOT switched over: the row's line is whatever the pipeline denormalised,
  // which is null on plenty of rows, while a machine, line or SKU report always
  // knows its own.
  //
  // NULLABLE EITHER WAY — the machine day and month reports carry `work_center_id`
  // as a column 0013 added and the pipeline does not fill yet, and an area row's
  // line can be null for the same reason. Null means the Reason picker cannot be
  // scoped to a line, which the code below handles explicitly: it must not become
  // a spinner that never resolves.
  workCenterId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");
  const { mutate, isPending, error, reset } = useEditDowntime(row?.sourceEventId ?? null, address);

  // Both catalogues load with the dialog rather than on first keystroke: they are
  // REFERENCE_STALE_TIME-cached and shared across every row on the report, so
  // after the first open they are already in the cache and the picker opens with
  // its list rather than with a spinner.
  // `?? undefined` because the query GATES on undefined: core-api 400s an
  // unscoped reason request, so nothing may fire without a line.
  const reasonQuery = useDowntimeReasonOptions(workCenterId ?? undefined);

  // THE GATED-QUERY TRAP, and the one place in this dialog it can bite. A
  // useQuery with `enabled: false` reports `status: "pending"` FOREVER — so
  // passing reasonQuery.isPending straight through would render a Reason picker
  // that spins for as long as the dialog is open, with no error and no empty
  // state, on every day and month report until the pipeline writes the column.
  //
  // Unscoped is not broken: the control still renders every chip the stop
  // already carries, and the operator can still edit the rest of the form. It
  // simply has no catalogue to search.
  const unscoped = workCenterId === null;
  const actionQuery = useDowntimeActionOptions();
  const createAction = useCreateDowntimeAction();

  // The baseline, frozen at open. `row.id` in the deps rather than `row`: the
  // table refetches after any edit, which hands down a new object for the same
  // stop — and re-running this on that would quietly replace the baseline with
  // post-edit values, disarming the concurrency guard.
  const baseline = React.useMemo(
    () => (row === null ? null : editOf(row)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row?.sourceEventId, open],
  );

  const [draft, setDraft] = React.useState<DowntimeEdit | null>(baseline);

  // Re-seed the form when the dialog opens on a different stop. Keyed on the same
  // pair as the baseline so the two can never describe different rows.
  React.useEffect(() => {
    setDraft(baseline);
  }, [baseline]);

  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleSave(): void {
    if (draft === null || baseline === null) return;
    mutate(
      { next: draft, baseline },
      {
        onSuccess: (result) => {
          // Names what moved rather than saying "saved", because the consequence
          // differs: a category change makes the report's OEE tiles stale and the
          // banner is about to appear to say so.
          toast.success(
            result.changed.includes("category")
              ? t("report.downtimeUpdatedRefresh")
              : t("report.downtimeUpdated"),
          );
          onOpenChange(false);
        },
      },
    );
  }

  // Projected into the picker's shape here rather than in the picker, so the
  // component stays ignorant of both catalogues. `hint` shows the catalogue's own
  // category beside a reason — informational only; it does not drive the Category
  // select above it, which is the operator's call about THIS stop.
  const reasonOptions: AutocompleteOption[] = React.useMemo(
    () =>
      (reasonQuery.data ?? []).map((option) => ({
        id: option.id,
        name: option.name,
        hint: categoryLabel(t, option.category),
      })),
    [reasonQuery.data, t],
  );

  const actionOptions: AutocompleteOption[] = React.useMemo(
    () =>
      (actionQuery.data ?? []).map((option) => ({
        id: option.id,
        name: option.name,
        color: option.color,
      })),
    [actionQuery.data],
  );

  // Creates the action upstream, then adds it to THIS stop — the operator pressed
  // Enter to use it, not merely to file it in the catalogue.
  //
  // ADDED IN onSuccess, off the row the server returned, rather than optimistically
  // off `name`: a create that 409s or 422s must not leave a chip standing for an
  // action that does not exist, which the operator would then save onto the stop.
  function handleCreateAction(name: string): void {
    if (draft === null) return;
    createAction.mutate(
      { name, code: slugifyCode(name), color: NEW_ACTION_COLOR },
      {
        onSuccess: (created) => {
          // Read through the setter rather than closing over `draft`: the create
          // is a round trip, and the operator may have edited another field while
          // it was in flight.
          setDraft((current) =>
            current === null || current.actions.includes(created.name)
              ? current
              : { ...current, actions: [...current.actions, created.name] },
          );
        },
      },
    );
  }

  const dirty = draft !== null && baseline !== null && isDirty(baseline, draft);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{t("report.editDowntime")}</DialogTitle>
          <DialogDescription>{t("report.editDowntimeBody")}</DialogDescription>
        </DialogHeader>

        {draft === null ? null : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="downtime-category">{t("report.category")}</Label>
              <Select
                value={draft.category}
                disabled={isPending}
                onValueChange={(value) =>
                  setDraft({ ...draft, category: value as DowntimeCategory })
                }
              >
                <SelectTrigger id="downtime-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {categoryLabel(t, category)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Stated at the point of change rather than in a banner nobody
                  reads: this is the ONLY one of the four fields that makes the
                  report's precomputed totals wrong. */}
              <p className="text-xs text-muted-foreground">{t("report.categoryMovesTime")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="downtime-reason">{t("report.reason")}</Label>
              <OptionTagInput
                id="downtime-reason"
                itemLabel="reason"
                value={draft.reason}
                options={reasonOptions}
                isPending={!unscoped && reasonQuery.isPending}
                isError={reasonQuery.isError}
                disabled={isPending}
                placeholder={t("report.searchReasons")}
                onChange={(reason) => setDraft({ ...draft, reason })}
                // NO onCreate. The reason catalogue is closed here — see the
                // header. A missing reason is a master-data change, not something
                // to invent while filing a stop.
                //
                // The order rule is said out loud because nothing on screen would
                // otherwise reveal it.
                helpText={unscoped ? t("report.noLineCatalogue") : t("report.reasonsFromLine")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="downtime-detail-reason">{t("report.detailReason")}</Label>
              <Textarea
                id="downtime-detail-reason"
                rows={3}
                disabled={isPending}
                // `?? ""` because the column is nullable and a null value would
                // make this an uncontrolled input for one render.
                value={draft.detailReason ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    // '' back to null, matching the server: two representations
                    // of "nothing here" is how a field renders as blank instead
                    // of as an em dash.
                    detailReason: event.target.value.length === 0 ? null : event.target.value,
                  })
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="downtime-actions">{t("report.actions")}</Label>
              <OptionTagInput
                id="downtime-actions"
                itemLabel="action"
                value={draft.actions}
                options={actionOptions}
                isPending={actionQuery.isPending}
                isError={actionQuery.isError}
                disabled={isPending}
                creating={createAction.isPending}
                placeholder={t("report.searchActions")}
                onChange={(actions) => setDraft({ ...draft, actions })}
                onCreate={handleCreateAction}
                helpText={t("report.newActionHint")}
              />
              {/* The create's own error, next to the field that raised it and
                  separate from the save error below — they are two different
                  requests, and one having failed says nothing about the other. */}
              {createAction.isError && (
                <p className="text-xs text-destructive">{t(CREATE_ACTION_FAILED_KEY)}</p>
              )}
            </div>
          </div>
        )}

        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{messageFor(error, t)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {/* Disabled when nothing moved: the server would answer 200 having
              written nothing, and a toast saying "updated" over an unchanged row
              is a claim the UI should not make. */}
          <Button disabled={isPending || !dirty} onClick={handleSave}>
            {isPending ? t("common.saving") : t("common.saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DowntimeEditDialog };
