import { createInstance } from "i18next";
import { nativeLocalizationResources } from "@synara/shared/nativeLocalizationResources";
import { UI_LOCALES, isUiMessageKey } from "@synara/shared/uiLocale";

// The interface is English-only: native copy always reads the English catalog.
const instance = createInstance();
void instance.init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: [...UI_LOCALES],
  resources: nativeLocalizationResources,
  ns: ["desktop"],
  defaultNS: "desktop",
  initAsync: false,
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
});

export function t(message: string, values?: Record<string, unknown>): string {
  if (!isUiMessageKey(message, nativeLocalizationResources.en)) return message;
  return instance.t(message, { ...values, returnObjects: false });
}
