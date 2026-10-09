// FILE: useTheme.ts
// Purpose: Persists the Codex-style theme store and projects the active pack into DOM CSS variables.
// Layer: Web appearance state hook
// Exports: useTheme for mode, resolved variant, theme-pack import/export, and active theme metadata.

import { useEffect, useSyncExternalStore } from "react";
import { isDesktopPresentation } from "~/lib/hosts/workspacePresentation";
import { isMacNavigatorPlatform } from "../lib/utils";
import {
  DEFAULT_THEME_STATE,
  type ChromeTheme,
  type ThemeFonts,
  type ThemeMode,
  type ThemePack,
  type ThemeState,
  type ThemeVariant,
  type WindowMaterial,
  type WindowTranslucency,
  areThemePacksEqual,
  areWindowTranslucenciesEqual,
  buildThemeCssVariables,
  canParseThemeShareString,
  createThemeShareString,
  parseStoredThemeState,
  resetThemeVariant as resetThemeVariantState,
  resolveThemePack,
  resolveProfileThemeAccent,
  resolveThemeVariant,
  serializeThemeState,
  setThemeCodeThemeId,
  setThemeFonts,
  setWindowTranslucency as setWindowTranslucencyState,
  updateChromeTheme,
  updateThemePackFromShareString,
} from "../theme/theme.logic";

type ThemeSnapshot = {
  state: ThemeState;
  systemDark: boolean;
  /** The desktop refused the last custom blur and fell back to vibrancy. */
  desktopBlurUnavailable: boolean;
};

const STORAGE_KEY = "synara:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners: Array<() => void> = [];
// Refreshed only when the store actually changes (a write, a cross-tab storage
// event, or a media-query flip) so `getSnapshot` is a plain field read.
// React re-reads the snapshot after a listener fires, which is exactly when
// this cache is rebuilt, so the tearing guarantee holds. Reading and parsing
// localStorage on every render of every theme consumer was measurable during
// transcript streaming.
let currentSnapshot: ThemeSnapshot | null = null;
let lastDesktopTheme: ThemeMode | null = null;
let lastDesktopWindowMaterial: string | null = null;
let desktopBlurUnavailable = false;

// ─── Store wiring ─────────────────────────────────────────────────────────

function emitChange() {
  refreshSnapshot();
  for (const listener of listeners) {
    listener();
  }
}

function hasThemeStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function getSystemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MEDIA_QUERY).matches;
}

function readStoredThemeState(): ThemeState {
  if (!hasThemeStorage()) {
    return DEFAULT_THEME_STATE;
  }

  try {
    return parseStoredThemeState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_STATE;
  }
}

function writeStoredThemeState(state: ThemeState) {
  if (!hasThemeStorage()) {
    return;
  }

  localStorage.setItem(STORAGE_KEY, serializeThemeState(state));
}

function computeSnapshot(): ThemeSnapshot {
  const state = readStoredThemeState();
  const systemDark = state.mode === "system" ? getSystemDark() : false;
  return { state, systemDark, desktopBlurUnavailable };
}

function refreshSnapshot(): ThemeSnapshot {
  const next = computeSnapshot();
  // Keep the previous object when nothing changed so consumers' memoization
  // and `useSyncExternalStore` see a stable reference.
  if (
    currentSnapshot &&
    currentSnapshot.systemDark === next.systemDark &&
    currentSnapshot.desktopBlurUnavailable === next.desktopBlurUnavailable &&
    serializeThemeState(currentSnapshot.state) === serializeThemeState(next.state)
  ) {
    return currentSnapshot;
  }
  currentSnapshot = next;
  return next;
}

function getSnapshot(): ThemeSnapshot {
  return currentSnapshot ?? refreshSnapshot();
}

function updateStoredThemeState(update: (state: ThemeState) => ThemeState) {
  const nextState = update(readStoredThemeState());
  writeStoredThemeState(nextState);
  applyThemeState(nextState, true);
  emitChange();
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  listeners.push(listener);

  const mediaQuery = window.matchMedia(MEDIA_QUERY);
  const handleMediaChange = () => {
    const state = readStoredThemeState();
    if (state.mode === "system") {
      applyThemeState(state, true);
    }
    emitChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) {
      return;
    }
    applyThemeState(readStoredThemeState(), true);
    emitChange();
  };

  mediaQuery.addEventListener("change", handleMediaChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((currentListener) => currentListener !== listener);
    mediaQuery.removeEventListener("change", handleMediaChange);
    window.removeEventListener("storage", handleStorage);
  };
}

// ─── DOM projection ───────────────────────────────────────────────────────

function applyThemeState(state: ThemeState, suppressTransitions = false) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const root = document.documentElement;
  // Some server-rendered tests stub only the tiny DOM surface they need.
  if (
    typeof root.classList?.toggle !== "function" ||
    typeof root.style?.setProperty !== "function" ||
    typeof root.style?.removeProperty !== "function"
  ) {
    return;
  }

  if (suppressTransitions) {
    root.classList.add("no-transitions");
  }

  const variant = resolveThemeVariant(state.mode, getSystemDark());
  const activeTheme = resolveThemePack(state, variant);
  const translucency = state.translucency[variant];
  const cssVariableBuild = buildThemeCssVariables(activeTheme, variant, {
    electron: isDesktopPresentation,
    isMac: isMacNavigatorPlatform(),
    systemUiFont: state.systemUiFont,
    translucency,
  });

  root.classList.toggle("dark", variant === "dark");
  root.setAttribute("data-code-theme-id", activeTheme.codeThemeId);
  root.setAttribute("data-theme-mode", state.mode);
  root.setAttribute("data-theme-variant", variant);
  root.setAttribute("data-window-material", cssVariableBuild.material);
  root.setAttribute("data-window-translucency", cssVariableBuild.translucencyScope);

  for (const [name, value] of Object.entries(cssVariableBuild.variables)) {
    if (value.trim().length === 0) {
      root.style.removeProperty(name);
      continue;
    }
    root.style.setProperty(name, value);
  }

  syncDesktopTheme(state.mode);
  syncDesktopWindowMaterial(cssVariableBuild.material, translucency.blur);

  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal.
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => {
      root.classList.remove("no-transitions");
    });
  }
}

function syncDesktopTheme(theme: ThemeMode) {
  if (typeof window === "undefined") {
    return;
  }

  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

// Only the macOS desktop implements this; the material there is "translucent" only on macOS.
// Without a chosen blur the window keeps vibrancy, which is the desktop's "opaque" backing.
function syncDesktopWindowMaterial(cssMaterial: WindowMaterial, blur: number | null) {
  const setWindowMaterial =
    typeof window === "undefined" ? undefined : window.desktopBridge?.setWindowMaterial;
  const material: WindowMaterial =
    cssMaterial === "translucent" && blur !== null ? "translucent" : "opaque";
  const blurRadius = material === "translucent" && blur !== null ? blur : 0;
  const key = `${material}:${blurRadius}`;
  if (!setWindowMaterial || lastDesktopWindowMaterial === key) {
    return;
  }

  lastDesktopWindowMaterial = key;
  void setWindowMaterial({ material, blurRadius }).then(
    (applied) => {
      // Vibrancy always applies; only a custom blur can be refused by the window server.
      const unavailable = material === "translucent" && !applied;
      if (lastDesktopWindowMaterial !== key || desktopBlurUnavailable === unavailable) return;
      desktopBlurUnavailable = unavailable;
      emitChange();
    },
    () => {
      if (lastDesktopWindowMaterial === key) {
        lastDesktopWindowMaterial = null;
      }
    },
  );
}

// Apply immediately on module load to minimize flash before React mounts.
if (typeof document !== "undefined") {
  applyThemeState(readStoredThemeState());
}

// ─── Public hook ──────────────────────────────────────────────────────────

function setTheme(nextTheme: ThemeMode) {
  updateStoredThemeState((state) => ({
    ...state,
    mode: nextTheme,
  }));
}

function setSystemUiFont(enabled: boolean) {
  updateStoredThemeState((state) => ({
    ...state,
    systemUiFont: enabled,
  }));
}

function resetThemeVariant(variant: ThemeVariant) {
  updateStoredThemeState((state) => resetThemeVariantState(state, variant));
}

function resetAllThemes() {
  updateStoredThemeState(() => DEFAULT_THEME_STATE);
}

function updateThemePack(variant: ThemeVariant, patch: Partial<ChromeTheme>) {
  updateStoredThemeState((state) => updateChromeTheme(state, variant, patch));
}

function updateThemeFonts(variant: ThemeVariant, patch: Partial<ThemeFonts>) {
  updateStoredThemeState((state) => setThemeFonts(state, variant, patch));
}

function setWindowTranslucency(variant: ThemeVariant, patch: Partial<WindowTranslucency>) {
  updateStoredThemeState((state) => setWindowTranslucencyState(state, variant, patch));
}

function setCodeThemeId(variant: ThemeVariant, codeThemeId: string) {
  updateStoredThemeState((state) => setThemeCodeThemeId(state, variant, codeThemeId));
}

/** Read at mutation time so every profile writer publishes the current selection. */
export function readProfileThemeAccent() {
  return resolveProfileThemeAccent(readStoredThemeState());
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => ({
    state: DEFAULT_THEME_STATE,
    systemDark: false,
    desktopBlurUnavailable: false,
  }));
  const theme = snapshot.state.mode;
  const resolvedTheme = resolveThemeVariant(theme, snapshot.systemDark);
  const activeTheme = resolveThemePack(snapshot.state, resolvedTheme);
  const darkTheme = resolveThemePack(snapshot.state, "dark");
  const lightTheme = resolveThemePack(snapshot.state, "light");
  const defaultActiveTheme = resolveThemePack(DEFAULT_THEME_STATE, resolvedTheme);
  const isDefaultActiveTheme =
    areThemePacksEqual(activeTheme, defaultActiveTheme) &&
    areWindowTranslucenciesEqual(
      snapshot.state.translucency[resolvedTheme],
      DEFAULT_THEME_STATE.translucency[resolvedTheme],
    );

  const canImportThemeString = (value: string, variant: ThemeVariant = resolvedTheme) =>
    canParseThemeShareString(value, variant);

  const importThemeString = (value: string, variant: ThemeVariant = resolvedTheme) => {
    updateStoredThemeState((state) => updateThemePackFromShareString(state, value, variant));
  };

  const exportThemeString = (variant: ThemeVariant = resolvedTheme) =>
    createThemeShareString(variant, resolveThemePack(snapshot.state, variant));

  const resetActiveTheme = () => {
    updateStoredThemeState((state) => resetThemeVariantState(state, resolvedTheme));
  };

  const isDefaultThemePack = (variant: ThemeVariant) =>
    areThemePacksEqual(
      resolveThemePack(snapshot.state, variant),
      resolveThemePack(DEFAULT_THEME_STATE, variant),
    ) &&
    areWindowTranslucenciesEqual(
      snapshot.state.translucency[variant],
      DEFAULT_THEME_STATE.translucency[variant],
    );

  // Keep the DOM synced if something bypassed the immediate module-load apply.
  useEffect(() => {
    applyThemeState(snapshot.state);
  }, [snapshot.state]);

  return {
    activeTheme,
    canImportThemeString,
    systemUiFont: snapshot.state.systemUiFont,
    setSystemUiFont,
    darkTheme,
    defaultActiveTheme,
    desktopBlurUnavailable: snapshot.desktopBlurUnavailable,
    exportThemeString,
    importThemeString,
    isDefaultActiveTheme,
    isDefaultThemePack,
    lightTheme,
    resetActiveTheme,
    resetAllThemes,
    resetThemeVariant,
    resolvedTheme,
    setCodeThemeId,
    setTheme,
    setWindowTranslucency,
    theme,
    themeState: snapshot.state,
    translucency: snapshot.state.translucency,
    updateThemeFonts,
    updateThemePack,
  } as const;
}

export type {
  ChromeTheme,
  ThemeFonts,
  ThemeMode,
  ThemePack,
  ThemeState,
  ThemeVariant,
  WindowTranslucency,
};
