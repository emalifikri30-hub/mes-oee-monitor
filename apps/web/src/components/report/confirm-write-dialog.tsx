import { isAxiosError } from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

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

import type { ReactNode } from "react";

// Confirm, then write. The shell behind every write this app makes.
//
// EXTRACTED FROM approve-report-dialog.tsx and reopen-report-dialog.tsx, which
// were 119 and 110 lines and differed only in their copy, their status map and
// which mutation they called. The Line detail screen needs two more of them, and
// four copies of this ladder is four places for the two rules below to drift.
//
// THE TWO RULES, WHICH ARE THE WHOLE REASON THIS IS A COMPONENT AND NOT A LAYOUT
//
//   1. THE DIALOG STAYS OPEN ON FAILURE. The user is about to press the button
//      again, so the message has to stay on screen next to that button. A toast
//      would fade out from under someone reading it, and a banner on the card
//      behind would render BEHIND this dialog's overlay.
//   2. BOTH BUTTONS ARE DISABLED IN FLIGHT. Cancel would otherwise close the
//      dialog over a write that is still going to land.
//
// Success is the opposite kind of message — nothing to act on, and the badge
// behind the dialog has already flipped — so it is a toast and the dialog closes.
//
// THE MUTATION ARRIVES AS A RESULT, NOT A HOOK. The caller invokes its own hook
// and hands the object over. Hooks cannot be called conditionally, the caller is
// the only one that knows the id, and — the part that matters — it keeps WHICH
// WRITE THIS IS at the call site, where a test can assert it. A `subject` prop
// that picked the mutation in here is how a Line dialog ends up approving a
// MACHINE report: the seven report tables have seven independent id sequences, so
// that call would succeed against an unrelated row and look entirely normal.
type ConfirmMutation = {
  mutate: (variables: undefined, options?: { onSuccess?: () => void }) => void;
  isPending: boolean;
  error: unknown;
  reset: () => void;
};

// Per-status copy. A shared fallback would be wrong here: "already approved by
// someone else" and "already open" are different recoveries, and 409 is the one
// status where "try again" is actively bad advice.
type StatusMessages = Record<number, string>;

function messageFor(error: unknown, messages: StatusMessages, fallback: string): string {
  if (!isAxiosError(error)) return fallback;
  const status = error.response?.status;
  return (status === undefined ? undefined : messages[status]) ?? fallback;
}

function ConfirmWriteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  successMessage,
  messages,
  fallback,
  mutation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  // A node rather than a string: the reopen copy interpolates the approver's
  // name, and the line copy names how many machines a cascade will touch.
  description: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  successMessage: string;
  messages: StatusMessages;
  fallback: string;
  mutation: ConfirmMutation;
}) {
  const { t } = useTranslation("oee");
  const { mutate, isPending, error, reset } = mutation;

  // Clearing the error on close is what makes reopening the dialog a fresh
  // attempt rather than one that starts by showing the last failure.
  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleConfirm(): void {
    mutate(undefined, {
      onSuccess: () => {
        toast.success(successMessage);
        onOpenChange(false);
      },
      // No onError: the error lands on the mutation's own state and renders
      // below. Closing here would take the message with it.
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {error === null || error === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{messageFor(error, messages, fallback)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => handleOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={isPending} onClick={handleConfirm}>
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmWriteDialog };
export type { ConfirmMutation, StatusMessages };
