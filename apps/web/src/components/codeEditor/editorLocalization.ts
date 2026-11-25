// Monaco's NLS packs must run before any editor module is evaluated. Keep this
// gate outside the engine graph so importing an editor shell or Settings does
// not load the engine, its workers, or a language pack.
import { UI_LOCALES, type UiLocale } from "@synara/contracts";

import { i18n } from "~/i18n";

type MonacoNlsLocale =
  | "en"
  | "de"
  | "es"
  | "fr"
  | "it"
  | "ja"
  | "ko"
  | "pl"
  | "pt-br"
  | "ru"
  | "tr"
  | "zh-cn"
  | "zh-tw";

const MONACO_NLS_LOCALES: Readonly<Record<UiLocale, MonacoNlsLocale>> = {
  en: "en",
  it: "it",
  pl: "pl",
  es: "es",
  fr: "fr",
  de: "de",
  "pt-BR": "pt-br",
  ja: "ja",
  ru: "ru",
  "zh-CN": "zh-cn",
  "zh-TW": "zh-tw",
  ko: "ko",
  tr: "tr",
  "es-419": "es",
  uk: "en",
  th: "en",
  ar: "en",
};

let preparedLanguage: Promise<MonacoNlsLocale> | undefined;
let loadedLanguage: MonacoNlsLocale | null = null;
const listeners = new Set<() => void>();

export function editorNlsLocale(language: UiLocale): MonacoNlsLocale {
  return MONACO_NLS_LOCALES[language];
}

async function prepareLanguage(language: MonacoNlsLocale): Promise<MonacoNlsLocale> {
  if (language === "zh-cn") await import("monaco-editor/nls/lang/zh-cn");
  else if (language === "zh-tw") await import("monaco-editor/nls/lang/zh-tw");
  else if (language === "de") await import("monaco-editor/nls/lang/de");
  else if (language === "it") await import("monaco-editor/nls/lang/it");
  else if (language === "ja") await import("monaco-editor/nls/lang/ja");
  else if (language === "ko") await import("monaco-editor/nls/lang/ko");
  else if (language === "pl") await import("monaco-editor/nls/lang/pl");
  else if (language === "tr") await import("monaco-editor/nls/lang/tr");
  else if (language === "es") await import("monaco-editor/nls/lang/es");
  else if (language === "fr") await import("monaco-editor/nls/lang/fr");
  else if (language === "pt-br") await import("monaco-editor/nls/lang/pt-br");
  else if (language === "ru") await import("monaco-editor/nls/lang/ru");
  // English and the interface languages Monaco does not ship use the engine's
  // original messages; no pack or extra request.
  return language;
}

/** The sole application entry to the editor graph, behind React.lazy. */
export async function loadLocalizedEditorSurface() {
  // Lock one language for this document. Monaco registers translated action
  // labels and caches UI strings during module evaluation; changing its global
  // table afterwards cannot update those strings and would mix languages.
  const uiLocale = UI_LOCALES.includes(i18n.language as UiLocale)
    ? (i18n.language as UiLocale)
    : "en";
  preparedLanguage ??= prepareLanguage(editorNlsLocale(uiLocale));
  const language = await preparedLanguage;
  const surface = await import("./MonacoEditorSurface");
  if (loadedLanguage !== language) {
    loadedLanguage = language;
    for (const listener of listeners) listener();
  }
  return surface;
}

export function getLoadedEditorLanguage(): MonacoNlsLocale | null {
  return loadedLanguage;
}

export function subscribeToEditorLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
