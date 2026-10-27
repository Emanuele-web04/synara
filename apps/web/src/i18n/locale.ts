import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";

import { normalizeLanguagePreference } from "@synara/shared/uiLocale";
import type { UiLanguagePreference as LanguagePreference } from "@synara/contracts";
export {
  UI_LANGUAGE_PREFERENCES as LANGUAGE_PREFERENCES,
  UI_LOCALE_REGISTRY,
  UI_LOCALES,
  normalizeLanguagePreference,
  resolveUiLocale as resolveLocale,
} from "@synara/shared/uiLocale";
export type {
  UiLanguagePreference as LanguagePreference,
  UiLocale as SupportedLocale,
} from "@synara/contracts";

export function readLanguagePreference(storage?: Pick<Storage, "getItem">): LanguagePreference {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(APP_SETTINGS_STORAGE_KEY);
    const settings: unknown = raw ? JSON.parse(raw) : null;
    return typeof settings === "object" && settings !== null && "language" in settings
      ? normalizeLanguagePreference(settings.language)
      : "system";
  } catch {
    return "system";
  }
}
