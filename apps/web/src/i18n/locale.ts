import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";

import {
  UI_LANGUAGE_PREFERENCES,
  availableUiLocales,
  normalizeLanguagePreference,
  resolveUiLocale,
  resolveUiLanguagePreference,
} from "@synara/shared/uiLocale";
import type { UiLanguagePreference as LanguagePreference } from "@synara/contracts";
import { DESKTOP_FLAVOR } from "../betaFeatures";
export {
  UI_LANGUAGE_PREFERENCES as LANGUAGE_PREFERENCES,
  UI_LOCALE_REGISTRY,
  normalizeLanguagePreference,
} from "@synara/shared/uiLocale";
export type {
  UiLanguagePreference as LanguagePreference,
  UiLocale as SupportedLocale,
} from "@synara/contracts";

// Raw preference identifiers above remain valid in storage even when unavailable in this app.
export const UI_LOCALES = availableUiLocales(DESKTOP_FLAVOR);
export const AVAILABLE_LANGUAGE_PREFERENCES = UI_LANGUAGE_PREFERENCES.filter(
  (preference) => resolveUiLanguagePreference(preference, DESKTOP_FLAVOR) === preference,
);

export function resolveLanguagePreference(preference: LanguagePreference): LanguagePreference {
  return resolveUiLanguagePreference(preference, DESKTOP_FLAVOR);
}

export function resolveLocale(preference: LanguagePreference, languages: readonly string[]) {
  return resolveUiLocale(preference, languages, DESKTOP_FLAVOR);
}

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
