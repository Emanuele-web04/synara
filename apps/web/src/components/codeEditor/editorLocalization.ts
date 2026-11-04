// Monaco's NLS packs must run before any editor module is evaluated. Keep this
// gate outside the engine graph so importing an editor shell or Settings does
// not load the engine, its workers, or a language pack.
import { i18n } from "~/i18n";
import type { UiLocale } from "@synara/contracts";
import { resolveLocale } from "~/i18n/locale";

let preparedLanguage: Promise<UiLocale> | undefined;
let loadedLanguage: UiLocale | null = null;
const listeners = new Set<() => void>();

async function prepareLanguage(language: UiLocale): Promise<UiLocale> {
  if (language === "zh-CN") {
    await import("monaco-editor/nls/lang/zh-cn");
  } else if (language === "es") {
    await import("monaco-editor/nls/lang/es");
  }
  // English uses the engine's original messages; no pack or extra request.
  return language;
}

/** The sole application entry to the editor graph, behind React.lazy. */
export async function loadLocalizedEditorSurface() {
  // Lock one language for this document. Monaco registers translated action
  // labels and caches UI strings during module evaluation; changing its global
  // table afterwards cannot update those strings and would mix languages.
  preparedLanguage ??= prepareLanguage(resolveLocale("system", [i18n.language]));
  const language = await preparedLanguage;
  const surface = await import("./MonacoEditorSurface");
  if (loadedLanguage !== language) {
    loadedLanguage = language;
    for (const listener of listeners) listener();
  }
  return surface;
}

export function getLoadedEditorLanguage(): UiLocale | null {
  return loadedLanguage;
}

export function subscribeToEditorLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
