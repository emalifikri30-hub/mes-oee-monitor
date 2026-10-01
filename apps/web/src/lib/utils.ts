import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

import type { ClassValue } from "clsx";

// Merges conditional class lists and lets later Tailwind utilities win over
// earlier conflicting ones, so a `className` prop can override a variant.
function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export { cn };
