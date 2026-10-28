import { createInstance } from "i18next";
import type { DesktopLanguagePreference } from "@synara/contracts";
import { nativeLocalizationResources } from "@synara/shared/nativeLocalizationResources";
import { UI_LOCALES, resolveUiLocale, isUiMessageKey } from "@synara/shared/uiLocale";
import type { UiLocale } from "@synara/contracts";
import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";

let preference: DesktopLanguagePreference = "system";
let desktopFlavor: SynaraDesktopFlavor | "unknown" = "unknown";
let systemLocale: () => string | readonly string[] = () => ["en"];
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

function currentLocale(): UiLocale {
  try {
    const candidates = systemLocale();
    return resolveUiLocale(
      preference,
      typeof candidates === "string" ? [candidates] : candidates,
      desktopFlavor,
    );
  } catch {
    return resolveUiLocale(preference, [], desktopFlavor);
  }
}

export function initializeDesktopI18n(
  initial: DesktopLanguagePreference,
  getSystemLocale: () => string | readonly string[],
  flavor: SynaraDesktopFlavor | "unknown" = "unknown",
): void {
  desktopFlavor = flavor;
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
  if (!isUiMessageKey(message, nativeLocalizationResources.en)) return message;
  const locale = currentLocale();
  if (instance.language !== locale) void instance.changeLanguage(locale);
  return instance.t(message, { ...values, returnObjects: false });
}

// Applied after Electron expands native edit/window menus, preserving its roles and shortcuts.
const ROLE_LABEL_SOURCES: Readonly<Record<string, string>> = {
  about: "desktop:about",
  quit: "desktop:quit2",
  close: "desktop:closeWindow",
  services: "desktop:services",
  hide: "desktop:hide",
  hideOthers: "desktop:hideOthers",
  unhide: "desktop:showAll",
  editMenu: "desktop:profile_edit",
  windowMenu: "desktop:sessionStatus_window",
  help: "desktop:help",
  undo: "desktop:toast_undo",
  redo: "desktop:redo",
  cut: "desktop:cut",
  copy: "desktop:share_copy",
  paste: "desktop:paste",
  pasteAndMatchStyle: "desktop:pasteAndMatchStyle",
  delete: "desktop:detail_delete",
  selectAll: "desktop:selectAll",
  reload: "desktop:panel_reload",
  forceReload: "desktop:forceReload",
  toggleDevTools: "desktop:developerTools",
  resetZoom: "desktop:resetZoom",
  zoomIn: "desktop:zoomIn",
  zoomOut: "desktop:zoomOut",
  togglefullscreen: "desktop:toggleFullScreen",
  minimize: "desktop:app_minimize",
  zoom: "desktop:zoom",
  front: "desktop:bringAllToFront",
  startSpeaking: "desktop:startSpeaking",
  stopSpeaking: "desktop:stopSpeaking",
  toggleSpellChecker: "desktop:checkSpelling",
  showSubstitutions: "desktop:showSubstitutions",
  toggleSmartQuotes: "desktop:smartQuotes",
  toggleSmartDashes: "desktop:smartDashes",
  toggleTextReplacement: "desktop:textReplacement",
};
const ROLE_LABELS = new Map(
  Object.entries(ROLE_LABEL_SOURCES).map(([role, label]) => [role.toLowerCase(), label]),
);

interface NativeMenuItem {
  label: string;
  role?: string | null | undefined;
  submenu?: NativeMenu | null | undefined;
}
interface NativeMenu {
  items: readonly NativeMenuItem[];
}

export function translateNativeMenuRoles(menu: NativeMenu, appName: string): void {
  for (const item of menu.items) {
    const source =
      typeof item.role === "string" ? ROLE_LABELS.get(item.role.toLowerCase()) : undefined;
    if (source) item.label = t(source, { app: appName });
    // Electron's default Edit groups have no role of their own. Identify these
    // app-owned groups by their native actions, never by English display text.
    if (item.role?.toLowerCase() === "editmenu" && item.submenu) {
      for (const group of item.submenu.items) {
        if (group.role != null || !group.submenu) continue;
        const roles = new Set(group.submenu.items.map((child) => child.role?.toLowerCase()));
        if (roles.has("showsubstitutions")) group.label = t("desktop:substitutions");
        else if (roles.has("startspeaking") && roles.has("stopspeaking"))
          group.label = t("desktop:speech");
      }
    }
    if (item.submenu) translateNativeMenuRoles(item.submenu, appName);
  }
}
