import {
  UI_LOCALES,
  UI_LOCALE_REGISTRY,
  UI_LANGUAGE_PREFERENCES,
  type UiLanguagePreference,
  type UiLocale,
} from "@synara/contracts";
import { CHINESE_UI_BETA_FEATURE, isBetaFeatureEnabled } from "./betaFeatures";
import type { SynaraDesktopFlavor } from "./desktopIdentity";

export { UI_LOCALES, UI_LOCALE_REGISTRY, UI_LANGUAGE_PREFERENCES };
export type { UiLanguagePreference, UiLocale };

/** Only catalog identities may reach a namespace-aware translator; other strings are data. */
export function isUiMessageKey(
  message: string,
  namespaces: Readonly<Record<string, unknown>>,
): boolean {
  const match = /^([a-z][A-Za-z0-9_-]*):[A-Za-z0-9_][A-Za-z0-9_.-]*$/.exec(message);
  return match !== null && Object.hasOwn(namespaces, match[1]!);
}

export function normalizeLanguagePreference(value: unknown): UiLanguagePreference {
  return typeof value === "string" &&
    UI_LANGUAGE_PREFERENCES.includes(value as UiLanguagePreference)
    ? (value as UiLanguagePreference)
    : "system";
}

function isUiLocaleAvailable(locale: UiLocale, flavor: SynaraDesktopFlavor | "unknown"): boolean {
  return locale !== "zh-CN" || isBetaFeatureEnabled(CHINESE_UI_BETA_FEATURE, flavor);
}

/** Entry points and runtime resolution share the same host policy; catalogs remain additive. */
export function availableUiLocales(
  flavor: SynaraDesktopFlavor | "unknown" = "unknown",
): UiLocale[] {
  return UI_LOCALES.filter((locale) => isUiLocaleAvailable(locale, flavor));
}

/** A disabled preference remains stored but follows supported System languages while inert. */
export function resolveUiLanguagePreference(
  preference: UiLanguagePreference,
  flavor: SynaraDesktopFlavor | "unknown" = "unknown",
): UiLanguagePreference {
  return preference === "system" || isUiLocaleAvailable(preference, flavor) ? preference : "system";
}

const registeredLocales = UI_LOCALES.map((id) => ({
  id,
  locale: new Intl.Locale(id),
  aliases: UI_LOCALE_REGISTRY[id].aliases.map((alias) => new Intl.Locale(alias).baseName),
}));

/** Match canonical identities first, then registered aliases without crossing writing systems. */
export function resolveUiLocale(
  preference: UiLanguagePreference,
  languages: readonly string[],
  flavor: SynaraDesktopFlavor | "unknown" = "unknown",
): UiLocale {
  const selected = resolveUiLanguagePreference(preference, flavor);
  if (selected !== "system") return selected;
  const available = registeredLocales.filter((entry) => isUiLocaleAvailable(entry.id, flavor));
  for (const candidate of languages) {
    try {
      const locale = new Intl.Locale(candidate);
      const exact = available.find((entry) => entry.locale.baseName === locale.baseName);
      if (exact) return exact.id;
      const script = locale.maximize().script;
      const alias = available.find(
        (entry) =>
          entry.locale.maximize().script === script &&
          (entry.aliases.includes(locale.baseName) || entry.aliases.includes(locale.language)),
      );
      if (alias) return alias.id;
    } catch {
      // One malformed platform candidate must not suppress the next preferred language.
    }
  }
  return "en";
}
