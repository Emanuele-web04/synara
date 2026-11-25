import { Schema } from "effect";

/**
 * Shared UI-language metadata. This is a presentation contract, never a provider option.
 * The set follows the interface languages shipped by DeltaMod Community.
 */
export const UI_LOCALES = [
  "en",
  "it",
  "pl",
  "es",
  "fr",
  "de",
  "pt-BR",
  "ja",
  "ru",
  "zh-CN",
  "zh-TW",
  "ko",
  "tr",
  "es-419",
  "uk",
  "th",
  "ar",
] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export const UI_LANGUAGE_PREFERENCES = ["system", ...UI_LOCALES] as const;
export const UiLanguagePreference = Schema.Literals(UI_LANGUAGE_PREFERENCES);
export type UiLanguagePreference = typeof UiLanguagePreference.Type;

export const UI_LOCALE_REGISTRY: Readonly<
  Record<
    UiLocale,
    {
      nativeName: string;
      englishName: string;
      direction: "ltr" | "rtl";
      aliases: readonly string[];
    }
  >
> = {
  en: { nativeName: "English", englishName: "English", direction: "ltr", aliases: ["en"] },
  it: { nativeName: "Italiano", englishName: "Italian", direction: "ltr", aliases: ["it"] },
  pl: { nativeName: "Polski", englishName: "Polish", direction: "ltr", aliases: ["pl"] },
  es: { nativeName: "Español", englishName: "Spanish", direction: "ltr", aliases: ["es-ES"] },
  fr: { nativeName: "Français", englishName: "French", direction: "ltr", aliases: ["fr"] },
  de: { nativeName: "Deutsch", englishName: "German", direction: "ltr", aliases: ["de"] },
  "pt-BR": {
    nativeName: "Português (Brasil)",
    englishName: "Brazilian Portuguese",
    direction: "ltr",
    aliases: ["pt", "pt-BR"],
  },
  ja: { nativeName: "日本語", englishName: "Japanese", direction: "ltr", aliases: ["ja"] },
  ru: { nativeName: "Русский", englishName: "Russian", direction: "ltr", aliases: ["ru"] },
  "zh-CN": {
    nativeName: "简体中文",
    englishName: "Simplified Chinese",
    direction: "ltr",
    aliases: ["zh", "zh-Hans", "zh-CN", "zh-SG"],
  },
  "zh-TW": {
    nativeName: "繁體中文",
    englishName: "Traditional Chinese",
    direction: "ltr",
    aliases: ["zh-Hant", "zh-TW", "zh-HK", "zh-MO"],
  },
  ko: { nativeName: "한국어", englishName: "Korean", direction: "ltr", aliases: ["ko"] },
  tr: { nativeName: "Türkçe", englishName: "Turkish", direction: "ltr", aliases: ["tr"] },
  "es-419": {
    nativeName: "Español (Latinoamérica)",
    englishName: "Latin American Spanish",
    direction: "ltr",
    aliases: ["es-419", "es-MX", "es-AR", "es-CL", "es-CO", "es-PE", "es-VE"],
  },
  uk: { nativeName: "Українська", englishName: "Ukrainian", direction: "ltr", aliases: ["uk"] },
  th: { nativeName: "ไทย", englishName: "Thai", direction: "ltr", aliases: ["th"] },
  ar: {
    nativeName: "العربية",
    englishName: "Arabic",
    direction: "rtl",
    aliases: ["ar"],
  },
};
