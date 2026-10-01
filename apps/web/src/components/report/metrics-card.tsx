import { ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MetricTile } from "@/components/report/metric-tile";

import type { ReactNode } from "react";

// The collapsible KPI row, with the tiles supplied by the caller.
//
// EXTRACTED FROM summary-oee-card.tsx when the Line detail screen needed the same
// card with different figures. The alternative was a second collapsible MetricTile
// grid, and the reason that is not what happened is the one report-list-shell.tsx
// already records: four rules were duplicated across the report screens before it
// existed, "and none failed loudly when a copy drifted."
//
// TILES, NOT FLAGS — the same call ReportListFilterBar makes. The two callers do
// not differ by a boolean; they differ by which figures exist at all. A machine
// has one unit and nine tiles; a line has TWO units (migration 0014: bags in,
// cartons out) and eleven. A `variant="line"` prop would put that whole divergence
// inside this file, where the unit pairing is exactly the thing that must stay
// beside the figure it labels.
//
// SO THIS COMPONENT KNOWS NOTHING ABOUT A REPORT. It has no `report` prop, reads
// no measure and formats nothing — every value arrives already formatted, by a
// caller that knows which unit belongs to it. That is what stops this file from
// becoming the place a carton gets labelled as a bag.
type MetricSpec = {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  // AN EXPLANATION OF THE FIGURE, as an info icon beside its label.
  //
  // A STRING, WHICH IS DATA, NOT A FLAG — the distinction this file's header draws.
  // It says nothing about which subject is rendering; the caller supplies the
  // sentence, and this component does not know what a report is.
  //
  // ADDED FOR THE AREA OVERVIEW'S Run Time TILE, and that is the shape of case it
  // is for: a figure whose correct value looks like a bug. An area has no clock of
  // its own, so its durations are summed across its lines and a five-line day reads
  // "~120 h" — the intended figure, and one a supervisor will otherwise report.
  // Every other subject's Run Time is bounded by a wall clock and needs no note,
  // which is why this is per-tile and optional rather than a card-level caption.
  hint?: string;
};

function MetricsCard({
  title,
  collapseLabel,
  tiles,
  gridClassName,
}: {
  title: string;
  // The noun in "Collapse …" / "Expand …". Explicit rather than derived from
  // `title`, because the two callers' titles read badly in that sentence
  // ("Collapse Summary OEE") and the machine card's label is already shipped.
  collapseLabel: string;
  tiles: MetricSpec[];
  // The responsive column counts, which genuinely differ: nine tiles and eleven
  // do not want the same breakpoints.
  gridClassName: string;
}) {
  const { t } = useTranslation("oee");
  const [open, setOpen] = useState(true);

  return (
    <Card className="gap-0 py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="py-4">
          <CardTitle className="text-sm">{title}</CardTitle>
          <CollapsibleTrigger
            className="text-muted-foreground hover:text-foreground col-start-2 row-start-1 justify-self-end transition-colors"
            aria-label={
              open
                ? t("report.collapse", { label: collapseLabel })
                : t("report.expand", { label: collapseLabel })
            }
          >
            <ChevronUpIcon className={open ? "size-4" : "size-4 rotate-180"} />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className={gridClassName}>
            {tiles.map((tile) => (
              <MetricTile
                key={tile.label}
                label={tile.label}
                value={tile.value}
                valueClassName={tile.valueClassName}
                hint={tile.hint}
              />
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export { MetricsCard };
export type { MetricSpec };
