import { LanguagesIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_LANGUAGES, persistLanguage, type LanguageCode } from "@/lib/i18n";

/** Header dropdown that switches the app-shell language and persists the choice. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation("oee");
  const current = i18n.resolvedLanguage ?? i18n.language;
  const activeFlag = SUPPORTED_LANGUAGES.find((l) => l.code === current)?.flag;

  function change(code: LanguageCode) {
    void i18n.changeLanguage(code);
    persistLanguage(code);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("language.label")}
        >
          <LanguagesIcon className="size-4" />
          {activeFlag ? <span className="text-sm leading-none">{activeFlag}</span> : null}
          <span className="text-xs font-medium uppercase">{current}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SUPPORTED_LANGUAGES.map((lang) => (
          <DropdownMenuCheckboxItem
            key={lang.code}
            checked={current === lang.code}
            onCheckedChange={() => change(lang.code)}
          >
            <span className="mr-2 text-base leading-none">{lang.flag}</span>
            {lang.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
