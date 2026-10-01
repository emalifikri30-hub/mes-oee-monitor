import { cn } from "@/lib/utils";

import type { ComponentProps } from "react";

// Text wordmark placeholder until a real molca logo asset is supplied. Swapping
// this for an <svg> later needs no changes at the call sites.
function MolcaLogo({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-foreground text-2xl font-semibold tracking-tight lowercase select-none",
        className,
      )}
      {...props}
    >
      {/* Molca */}
      {/* For Demo Purpose */}
      Efortech
    </span>
  );
}

export { MolcaLogo };
