import { PlusIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatQuantity } from "@/lib/format";

import type { QualityEntryKind } from "@/lib/types";

// The Add button, and the ledger line under it.
//
// EXTRACTED FROM line-losses-card.tsx WHEN THE SKU CARD NEEDED THE SAME THING, and
// the reason it moved rather than being copied is that IT IS MOSTLY PROSE. The
// tooltip explains why the tile above did not move; two copies drifting means two
// screens telling operators different things about the same pipeline run, which is
// the failure report-list-shell.tsx exists to prevent and which nothing would fail
// loudly on.
//
// PURE DATA — a kind, some totals, two callbacks. It cannot reach a report, an id
// or a grain, so it cannot pick a query and cannot open the wrong subject's sheet.
//
// ---------------------------------------------------------------------------
// THE TILE ABOVE DOES NOT MOVE, AND THIS LINE IS WHY THAT IS SURVIVABLE
// ---------------------------------------------------------------------------
//
// The reported reject and rework figures are composed by the PIPELINE, through the
// override join in contract §18 — so after a successful entry the tile is exactly
// what the last DAG run wrote, and stays that way until the next one.
//
// An operator who typed 140 and saw nothing change would type it again. So the
// entries are shown immediately, on their own line beneath the figure, labelled as
// not yet included. That DISPLAYS the ledger; it must never add into the figure, or
// there are two definitions of the composed number and they disagree for as long
// as the DAG has not run. line-losses-card.test.tsx pins 5000 + 140 rendering as
// 5000 and a separate 140, never 5140.
function QualityAction({
  kind,
  totals,
  onAdd,
  onBrowse,
}: {
  kind: QualityEntryKind;
  // PER UNIT, never summed across units. A second bucket means the line's infeed
  // unit changed between two entries, and adding them would produce a figure in
  // neither — the §16.4 rule everywhere else in this feature.
  totals: { uomCode: string; qty: number; entries: number }[];
  onAdd: () => void;
  // Opens the entries sheet, which is the only route to a void. Reached from the
  // ledger line rather than from a menu, because the line is what an operator
  // looks at when they notice their own mistake.
  onBrowse: () => void;
}) {
  const { t } = useTranslation("oee");
  const label = kind === "reject" ? t("report.addReject") : t("report.addRework");

  return (
    <div className="mt-2 flex flex-col items-start gap-1">
      <Button variant="outline" size="xs" onClick={onAdd}>
        {label}
        <PlusIcon className="size-3.5" />
      </Button>

      {/* NOT ADDED INTO THE TILE — see the header. The wording has to carry that
          without being alarming: the entry landed, it is recorded, and the
          reported figure will include it after the next pipeline run. */}
      {totals.map((total) => (
        <Tooltip key={total.uomCode}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBrowse}
              className="text-muted-foreground hover:text-foreground text-xs tabular-nums underline decoration-dotted underline-offset-2"
            >
              {t("report.entered", { qty: formatQuantity(total.qty, total.uomCode) })}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {total.entries === 1
              ? t("report.entriesTooltipOne")
              : t("report.entriesTooltipMany", { count: total.entries })}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export { QualityAction };
