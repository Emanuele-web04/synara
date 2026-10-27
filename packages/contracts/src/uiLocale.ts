import { Schema } from "effect";

/** Shared UI-language metadata. This is a presentation contract, never a provider option. */
export const UI_LOCALES = ["en", "zh-CN", "es"] as const;
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
    englishName: "Simplified Chinese",
    direction: "ltr",
    aliases: ["zh", "zh-Hans", "zh-CN", "zh-SG"],
  },
  es: { nativeName: "Español", englishName: "Spanish", direction: "ltr", aliases: ["es"] },
};
