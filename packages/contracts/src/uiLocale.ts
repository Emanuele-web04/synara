/** The interface is English-only; catalogs live under `packages/shared/src/locales/en`. */
export const UI_LOCALES = ["en"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
