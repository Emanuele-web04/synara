import {
  UI_LOCALES,
  UI_LOCALE_REGISTRY,
  UI_LANGUAGE_PREFERENCES,
  type UiLanguagePreference,
  type UiLocale,
} from "@synara/contracts";

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

const registeredLocales = UI_LOCALES.map((id) => ({
  id,
  locale: new Intl.Locale(id),
  aliases: UI_LOCALE_REGISTRY[id].aliases.map((alias) => new Intl.Locale(alias).baseName),
}));

/** Match canonical identities first, then registered aliases without crossing writing systems. */
export function resolveUiLocale(
  preference: UiLanguagePreference,
  languages: readonly string[],
): UiLocale {
  if (preference !== "system") return preference;
  for (const candidate of languages) {
    try {
      const locale = new Intl.Locale(candidate);
      const exact = registeredLocales.find((entry) => entry.locale.baseName === locale.baseName);
      if (exact) return exact.id;
      const script = locale.maximize().script;
      const alias = registeredLocales.find(
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
