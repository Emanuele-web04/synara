import { Schema } from "effect";

/**
 * Shared UI-language metadata. This is a presentation contract, never a provider option.
 * The set follows Ethnologue's ten most spoken languages by total speakers.
 */
export const UI_LOCALES = ["en", "zh-CN", "hi", "es", "fr", "ar", "bn", "pt", "ru", "ur"] as const;
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
  "zh-CN": {
    nativeName: "简体中文",
    englishName: "Mandarin Chinese (Simplified)",
    direction: "ltr",
    aliases: ["zh", "zh-Hans", "zh-CN", "zh-SG"],
  },
  hi: { nativeName: "हिन्दी", englishName: "Hindi", direction: "ltr", aliases: ["hi"] },
  es: { nativeName: "Español", englishName: "Spanish", direction: "ltr", aliases: ["es"] },
  fr: { nativeName: "Français", englishName: "French", direction: "ltr", aliases: ["fr"] },
  ar: {
    nativeName: "العربية",
    englishName: "Standard Arabic",
    direction: "rtl",
    aliases: ["ar"],
  },
  bn: { nativeName: "বাংলা", englishName: "Bengali", direction: "ltr", aliases: ["bn"] },
  pt: { nativeName: "Português", englishName: "Portuguese", direction: "ltr", aliases: ["pt"] },
  ru: { nativeName: "Русский", englishName: "Russian", direction: "ltr", aliases: ["ru"] },
  ur: { nativeName: "اردو", englishName: "Urdu", direction: "rtl", aliases: ["ur"] },
};
