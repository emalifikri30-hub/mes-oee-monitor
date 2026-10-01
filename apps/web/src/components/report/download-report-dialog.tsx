import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// The "…" menu's Download item, which does not download anything yet.
//
// WHY THIS IS A DIALOG AND NOT A DISABLED MENU ITEM
//
// Regenerate and Adjust calculation next to it ARE disabled, following
// downtime-row-menu.tsx's convention for an action whose write path does not
// exist. The rule that separates them is worth stating, because the next person
// will otherwise make all four consistent in the wrong direction:
//
//   disabled  — nobody has designed this yet, so a dialog would have nothing
//               truthful to say beyond "no".
//   enabled   — this is a committed feature with a known shape, and the honest
//               thing is to say so when asked.
//
// Export is the second case. There is no export code anywhere in the repo yet —
// no columns chosen, no decision between a server-streamed file and a
// client-built one — so this states the position rather than pretending the item
// is broken.
//
// NO QUERY AND NO MUTATION. This component issues no request of any kind, and
// its test asserts that: a stub that quietly called something would be worse
// than the stub.
function DownloadReportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("oee");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("report.downloadTitle")}</DialogTitle>
          <DialogDescription>{t("report.downloadBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DownloadReportDialog };
