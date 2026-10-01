import { MinusIcon, PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// One named, collapsible band on the Losses page.
//
// It exists because Performance Loss is TWO things — Small Stop and Reduce Speed
// — and the design stacks them as titled bars. Only the second half is one
// today: the first is <ReasonParetoCard />, which carries its own title and is
// shared with the Availability Loss and Schedule Loss tabs, so wrapping it would
// have meant a band inside a card inside a tab saying "Small Stop" three times.
// This stays a component rather than markup inlined in one file because the next
// loss tab that needs a named band should not reinvent the plus/minus affordance
// or the border geometry.
//
// UNCONTROLLED, with `defaultOpen`. Which band is open is a glance, not page
// identity — the URL already carries the tab and the view, and putting a
// disclosure in it would make "share this link" mean "share which panels I had
// folded". Same line downtime-details-card.tsx draws for its own view state.
function LossSection({
  label,
  value,
  valueClassName,
  defaultOpen = false,
  children,
}: {
  label: string;
  // A figure stated ON the band header, so the fold can hide the caveat and never
  // the number. Rework carries one; Reduce Speed does not, because its total is
  // the first line of its own body.
  //
  // A STRING, not a ReactNode: the trigger is a <button>, and a node prop is an
  // invitation to nest a link or another button inside one. The colour arrives as
  // a class instead, which is the shape MetricTile already uses.
  value?: string;
  valueClassName?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-xl border">
      <CollapsibleTrigger className="group bg-muted/40 flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium data-[state=open]:rounded-b-none">
        {/* `mr-auto` rather than the trigger's old `justify-between`, so the value
            sits beside the icons rather than being pushed against the label. With
            no value the layout is unchanged. */}
        <span className="mr-auto">{label}</span>
        {value === undefined ? null : (
          <span className={cn("tabular-nums", valueClassName)}>{value}</span>
        )}
        {/* Plus / minus rather than a chevron, matching the design. The trigger
            carries the aria-expanded state itself, so these are decorative. */}
        <PlusIcon className="text-muted-foreground size-4 group-data-[state=open]:hidden" />
        <MinusIcon className="text-muted-foreground size-4 group-data-[state=closed]:hidden" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export { LossSection };
