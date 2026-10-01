import { createInstance, type ResourceKey } from "i18next";
import { initReactI18next } from "react-i18next";

/** Languages the Molca blocks ship with. Add an entry + register strings to extend. */
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "id", label: "Bahasa Indonesia", flag: "🇮🇩" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

const STORAGE_KEY = "molca-lang";

function initialLanguage(): LanguageCode {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LANGUAGES.some((l) => l.code === saved)) {
      return saved as LanguageCode;
    }
  }
  return "en";
}

/**
 * A single shared i18next instance for all Molca blocks — created via
 * `createInstance` so it never collides with a host app's own global i18n.
 * Each block registers its own namespace with {@link registerMessages}.
 */
export const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: {},
  lng: "en",
  fallbackLng: "en",
  defaultNS: "oee",
  ns: ["oee"],
  interpolation: { escapeValue: false },
});

export function applyStoredLanguage() {
  const code = initialLanguage();
  if (code !== i18n.language) void i18n.changeLanguage(code);
}

export function registerMessages(
  namespace: string,
  messages: Partial<Record<LanguageCode, ResourceKey>>,
) {
  for (const [lng, resource] of Object.entries(messages)) {
    if (resource) i18n.addResourceBundle(lng, namespace, resource, true, true);
  }
}

export function persistLanguage(code: LanguageCode) {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, code);
  }
}
