import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-xl font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      // Figma `Type` → shadcn variant
      variant: {
        // Primary (#231f20). Selected == default.
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        // Secondary (#f5f5f5). Selected darkens to accent (#e5e5e5).
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent data-[state=selected]:bg-accent",
        // Tertiary (Border Only): transparent + 2px border. Selected darkens border.
        outline:
          "border-2 border-border bg-transparent text-foreground hover:bg-accent/50 data-[state=selected]:border-muted-foreground",
        // No Bg + Border: no fill, no border. Selected == default.
        ghost: "bg-transparent text-foreground hover:bg-accent",
        // Destructive: red fill + 2px red border; focus → outlined red.
        destructive:
          "border-2 border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:bg-transparent focus-visible:text-destructive focus-visible:ring-destructive",
      },
      // Figma `Size` → height (xs32 sm36 md40 lg48 xl56)
      size: {
        xs: "h-8 px-2.5 text-xs",
        sm: "h-9 px-3 text-sm",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        xl: "h-14 px-7 text-base",
        "icon-xs": "size-8",
        "icon-sm": "size-9",
        icon: "size-10",
        "icon-lg": "size-12",
        "icon-xl": "size-14",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
