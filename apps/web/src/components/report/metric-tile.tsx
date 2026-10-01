import { InfoIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { ReactNode } from "react";

// One label-over-value figure. Used by both the Summary OEE row and the Losses
// breakdown, which is why the accent colours are caller-supplied classes rather
// than something derived here.
//
// `labelClassName` is optional and most callers leave it off: a muted label is
// the default, and only the Losses card colour-codes its labels to match its
// values. `cn` is twMerge(clsx(...)), so a passed text colour simply beats the
// default rather than needing a branch.
function MetricTile({
  label,
  value,
  labelClassName,
  valueClassName,
  className,
  hint,
  children,
}: {
  label: string;
  value: ReactNode;
  labelClassName?: string;
  valueClassName?: string;
  className?: string;
  // An explanation of the figure, beside its label. Optional and rare — see
  // MetricSpec.hint for the shape of case it exists for.
  hint?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation("oee");

  return (
    <div className={cn("min-w-0", className)}>
      {/* `truncate` MOVES TO THE LABEL TEXT when there is a hint, not to the row:
          the icon must not be the thing that gets clipped, and a flex row whose
          child truncates keeps the icon pinned beside whatever fits. Without a
          hint the shape is unchanged, so no shipped tile moves by a pixel. */}
      {hint === undefined ? (
        <p className={cn("text-muted-foreground truncate text-xs", labelClassName)}>{label}</p>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <p className={cn("text-muted-foreground truncate text-xs", labelClassName)}>{label}</p>
          <Tooltip>
            <TooltipTrigger className="shrink-0" aria-label={t("common.about", { label })}>
              <InfoIcon className="text-muted-foreground size-3" />
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        </div>
      )}
      <p className={cn("mt-1 truncate text-sm font-semibold tabular-nums", valueClassName)}>
        {value}
      </p>
      {children}
    </div>
  );
}

export { MetricTile };
