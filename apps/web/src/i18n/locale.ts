import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";

export const LANGUAGE_PREFERENCES = ["system", "en", "es"] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];
export type SupportedLocale = Exclude<LanguagePreference, "system">;

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return value === "en" || value === "es" ? value : "system";
}

export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[],
): SupportedLocale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "en" || base === "es") return base;
  }
  return "en";
}

export function readLanguagePreference(storage?: Pick<Storage, "getItem">): LanguagePreference {
  try {
    const raw = storage?.getItem(APP_SETTINGS_STORAGE_KEY);
    const settings: unknown = raw ? JSON.parse(raw) : null;
    return typeof settings === "object" && settings !== null && "language" in settings
      ? normalizeLanguagePreference(settings.language)
      : "system";
  } catch {
    return "system";
  }
}
