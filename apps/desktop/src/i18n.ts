import { createInstance } from "i18next";
import type { DesktopLanguagePreference } from "@synara/contracts";
import spanish from "./locales/es.json";

let preference: DesktopLanguagePreference = "system";
let systemLocale = () => "en";
const instance = createInstance();
void instance.init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "es"],
  resources: { en: { translation: {} }, es: { translation: spanish } },
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

function currentLocale(): "en" | "es" {
  if (preference !== "system") return preference;
  try {
    return systemLocale().toLowerCase().split(/[-_]/)[0] === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

export function initializeDesktopI18n(
  initial: DesktopLanguagePreference,
  getSystemLocale: () => string,
): void {
  systemLocale = getSystemLocale;
  setDesktopLanguagePreference(initial);
}

export function setDesktopLanguagePreference(next: DesktopLanguagePreference): boolean {
  const previous = preference;
  preference = next;
  const locale = currentLocale();
  const changed = previous !== next || instance.language !== locale;
  if (changed) void instance.changeLanguage(locale);
  return changed;
}

export function t(message: string, values?: Record<string, unknown>): string {
  const locale = currentLocale();
  if (instance.language !== locale) void instance.changeLanguage(locale);
  return instance.t(message, { ...values, defaultValue: message, returnObjects: false });
}

// Applied after Electron expands native edit/window menus, preserving its roles and shortcuts.
const ROLE_LABEL_SOURCES: Readonly<Record<string, string>> = {
  about: "About {{app}}",
  quit: "Quit {{app}}",
  close: "Close Window",
  services: "Services",
  hide: "Hide {{app}}",
  hideOthers: "Hide Others",
  unhide: "Show All",
  editMenu: "Edit",
  windowMenu: "Window",
  help: "Help",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteAndMatchStyle: "Paste and Match Style",
  delete: "Delete",
  selectAll: "Select All",
  reload: "Reload",
  forceReload: "Force Reload",
  toggleDevTools: "Developer Tools",
  resetZoom: "Reset Zoom",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  togglefullscreen: "Toggle Full Screen",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring All to Front",
  startSpeaking: "Start Speaking",
  stopSpeaking: "Stop Speaking",
  toggleSpellChecker: "Check Spelling",
  showSubstitutions: "Show Substitutions",
  toggleSmartQuotes: "Smart Quotes",
  toggleSmartDashes: "Smart Dashes",
  toggleTextReplacement: "Text Replacement",
};
const ROLE_LABELS = new Map(
  Object.entries(ROLE_LABEL_SOURCES).map(([role, label]) => [role.toLowerCase(), label]),
);

interface NativeMenuItem {
  label: string;
  role?: string | undefined;
  submenu?: NativeMenu | null | undefined;
}
interface NativeMenu {
  items: readonly NativeMenuItem[];
}

export function translateNativeMenuRoles(menu: NativeMenu, appName: string): void {
  for (const item of menu.items) {
    const source = item.role === undefined ? undefined : ROLE_LABELS.get(item.role.toLowerCase());
    if (source) item.label = t(source, { app: appName });
    if (item.submenu) translateNativeMenuRoles(item.submenu, appName);
  }
}
