import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { persistTheme, readTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { t } = useTranslation("oee");
  const [dark, setDark] = React.useState(false);

  React.useEffect(() => {
    setDark(readTheme() === "dark");
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    persistTheme(next ? "dark" : "light");
  };

  return (
    <Button variant="outline" size="icon" onClick={toggle} aria-label={t("theme.toggle")}>
      {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}
