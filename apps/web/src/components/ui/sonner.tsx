import * as React from "react";
import { Toaster as Sonner } from "sonner";

import { readTheme, type Theme } from "@/lib/theme";

import type { ComponentProps } from "react";

function Toaster({ ...props }: ComponentProps<typeof Sonner>) {
  const [theme, setTheme] = React.useState<Theme>("light");

  React.useEffect(() => {
    const sync = () => setTheme(readTheme());
    sync();
    window.addEventListener("themechange", sync);
    return () => window.removeEventListener("themechange", sync);
  }, []);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
