// FILE: theme.logic.tokens.ts
// Purpose: Computes Codex-style derived CSS tokens and the app CSS variable map from a resolved theme pack.
// Layer: Web appearance domain logic
// Exports: DEFAULT_CHROME_THEME_BY_VARIANT plus the CSS variable / resolved-token builders.

import { normalizeFontFamilyCssValue } from "../lib/fontFamily";
import {
  BLACK,
  formatHex,
  formatOpaqueRgb,
  formatRgba,
  mixHex,
  mixRgb,
  parseHexColor,
  type RgbColor,
  WHITE,
} from "./theme.logic.colors";
import type {
  ChromeTheme,
  ResolvedThemeTokens,
  ThemeCssVariableBuild,
  ThemePack,
  ThemeVariant,
  WindowMaterial,
} from "./theme.logic";

const CONTRAST_CURVE_BELOW_BASELINE = 0.7;
const CONTRAST_CURVE_ABOVE_BASELINE = 2;
const SURFACE_UNDER_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.16,
  light: 0.04,
};
const SURFACE_UNDER_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.0015,
  light: 0.0012,
};
const PANEL_BASE_ALPHA: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.18,
};
const PANEL_CONTRAST_STEP: Record<ThemeVariant, number> = {
  dark: 0.03,
  light: 0.008,
};

export const DEFAULT_CHROME_THEME_BY_VARIANT: Record<ThemeVariant, ChromeTheme> = {
  dark: {
    accent: "#339cff",
    contrast: 60,
    fonts: { code: null, ui: null },
    ink: "#ffffff",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#40c977",
      diffRemoved: "#fa423e",
      skill: "#ad7bf9",
    },
    surface: "#181818",
  },
  light: {
    accent: "#339cff",
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: "#1a1c1f",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#00a240",
      diffRemoved: "#ba2623",
      skill: "#924ff7",
    },
    surface: "#ffffff",
  },
};

export function buildThemeCssVariables(
  pack: ThemePack,
  variant: ThemeVariant,
  options?: { electron?: boolean; isMac?: boolean },
): ThemeCssVariableBuild {
  const resolvedTokens = buildResolvedThemeTokens(pack, variant);
  const codexVariables = resolvedTokens.codexVariables;
  const readCodexVariable = (name: string) => getRequiredVariable(codexVariables, name);
  // The translucent shell relies on macOS window vibrancy as its backing
  // material. Windows/Linux have no equivalent, so a translucent shell there
  // leaves the transparent body and backdrop-filter surfaces bleeding through
  // and (on fractional DPI) rendering blurry. Restrict translucency to macOS.
  const material: WindowMaterial =
    options?.electron === true && options?.isMac === true && !pack.theme.opaqueWindows
      ? "translucent"
      : "opaque";
  const warningColor = variant === "dark" ? "#f5b44a" : "#d97706";
  const sidebarSurfaceUnder = readCodexVariable("--color-background-surface-under");
  const sidebarRaisedSurface = readCodexVariable("--color-background-elevated-primary");
  const settingsSurface = readCodexVariable("--color-background-surface");
  const composerSurface =
    variant === "dark"
      ? readCodexVariable("--color-background-control-opaque")
      : "color-mix(in oklab, var(--color-background-control) 90%, transparent)";
  // Mirrors Codex Electron's [cmdk-root] dropdown shell: thin the dropdown-background
  // token by 5% in oklab over the existing backdrop blur. Light vs dark is already
  // handled by --color-background-control-opaque (white in light, dark control in dark).
  const composerPickerMenuSurface = "color-mix(in oklab, var(--popover) 70%, transparent)";
  const composerFocusBorder = buildComposerFocusBorder(
    pack,
    variant,
    resolvedTokens.computed.panel,
  );
  // Shared surface for the user message bubble and fenced code blocks so both
  // read as the same "input/source" affordance inside the transcript. Sourced
  // from the user-message token so code blocks pick up the bubble's color.
  const chatCodeSurface = readCodexVariable("--color-background-user-message");
  const appVariables: Record<string, string> = {
    "--accent": readCodexVariable("--color-background-accent"),
    "--accent-foreground": readCodexVariable("--color-text-foreground"),
    "--app-shell-background":
      material === "translucent"
        ? "transparent"
        : readCodexVariable("--color-background-surface-under"),
    "--app-composer-focus-border": composerFocusBorder,
    // Frosted blur only when the shell is translucent (macOS). On an opaque
    // shell these promote the surface to a GPU layer that Chromium rasterizes at
    // the wrong scale on fractional DPI (Windows), so text reads blurry until a
    // repaint. Keep them "none" off macOS.
    "--app-composer-backdrop-filter": material === "translucent" ? "blur(16px)" : "none",
    "--app-composer-picker-backdrop-filter": material === "translucent" ? "blur(32px)" : "none",
    "--app-composer-picker-surface": composerPickerMenuSurface,
    "--app-chat-code-surface": chatCodeSurface,
    "--app-user-message-background": chatCodeSurface,
    "--app-sidebar-backdrop-filter":
      material === "translucent" ? "blur(8px) saturate(135%)" : "none",
    // Settings mirrors the chat surface (opaque --color-background-surface) so every
    // settings element reads as outline-only. With an opaque page there is nothing to
    // frost, so we skip the backdrop blur (and its compositing cost) entirely.
    "--app-settings-backdrop-filter": "none",
    "--app-sidebar-shadow":
      material === "translucent"
        ? variant === "dark"
          ? "inset 0 1px 0 rgba(255,255,255,0.024)"
          : "inset 0 1px 0 rgba(0,0,0,0.025)"
        : variant === "dark"
          ? "inset 0 1px 0 rgba(255,255,255,0.025)"
          : "inset 0 1px 0 rgba(0,0,0,0.03)",
    "--app-sidebar-surface":
      material === "translucent"
        ? variant === "dark"
          ? `color-mix(in srgb, ${sidebarSurfaceUnder} 72%, transparent)`
          : `color-mix(in srgb, ${sidebarSurfaceUnder} 64%, transparent)`
        : sidebarSurfaceUnder,
    // Always opaque so the settings page background matches the chat surface exactly,
    // regardless of window material.
    "--app-settings-surface": settingsSurface,
    "--background": readCodexVariable("--color-background-surface-under"),
    "--border": readCodexVariable("--color-border"),
    "--card": readCodexVariable("--color-background-panel"),
    "--card-foreground": readCodexVariable("--color-text-foreground"),
    "--composer-surface": composerSurface,
    "--destructive": pack.theme.semanticColors.diffRemoved,
    "--destructive-foreground": pack.theme.surface,
    "--foreground": readCodexVariable("--color-text-foreground"),
    "--info": pack.theme.accent,
    // Keep legacy app-level "info" consumers on Codex's accent-text path so
    // links, file labels, and similar affordances inherit the real light/dark logic.
    "--info-foreground": readCodexVariable("--color-text-accent"),
    "--input": readCodexVariable("--color-background-control-opaque"),
    "--muted": readCodexVariable("--color-background-elevated-secondary"),
    "--muted-foreground": readCodexVariable("--color-text-foreground-secondary"),
    "--popover": readCodexVariable("--color-background-elevated-primary-opaque"),
    "--popover-foreground": readCodexVariable("--color-text-foreground"),
    "--primary": readCodexVariable("--color-background-button-primary"),
    "--primary-foreground": readCodexVariable("--color-text-button-primary"),
    "--ring": readCodexVariable("--color-border-focus"),
    "--secondary": readCodexVariable("--color-background-button-secondary"),
    "--secondary-foreground": readCodexVariable("--color-text-button-secondary"),
    "--sidebar": readCodexVariable("--color-background-surface-under"),
    "--sidebar-accent": readCodexVariable("--color-background-button-secondary-hover"),
    "--sidebar-accent-active": readCodexVariable("--color-background-button-secondary-hover"),
    "--sidebar-accent-foreground": readCodexVariable("--color-text-foreground"),
    "--sidebar-border": readCodexVariable("--color-border"),
    "--sidebar-foreground": readCodexVariable("--color-text-foreground"),
    "--success": pack.theme.semanticColors.diffAdded,
    "--success-foreground": pack.theme.semanticColors.diffAdded,
    "--theme-font-code-family": normalizeFontFamilyCssValue(pack.theme.fonts.code) ?? "",
    "--theme-font-ui-family": normalizeFontFamilyCssValue(pack.theme.fonts.ui) ?? "",
    "--warning": warningColor,
    "--warning-foreground": warningColor,
  };

  return {
    material,
    variables: {
      ...codexVariables,
      ...resolvedTokens.aliases,
      ...appVariables,
    },
  };
}

export function buildResolvedThemeTokens(
  pack: ThemePack,
  variant: ThemeVariant,
): ResolvedThemeTokens {
  const computedTheme = buildComputedTheme(pack.theme, variant);
  const derived =
    variant === "light"
      ? buildLightDerivedTokens(computedTheme)
      : buildDarkDerivedTokens(computedTheme);
  const panel = buildPanelBackground(computedTheme);
  const codexVariables = buildCodexCssVariables(computedTheme, derived, panel);

  return {
    aliases: buildThemeTokenAliases(codexVariables),
    codexVariables,
    computed: {
      contrast: computedTheme.contrast,
      editorBackground: formatOpaqueRgb(computedTheme.editorBackground),
      panel,
      surfaceUnder: computedTheme.surfaceUnder,
    },
    derived,
  };
}

function buildComputedTheme(theme: ChromeTheme, variant: ThemeVariant) {
  const contrast = normalizeContrastStrength(theme.contrast, variant);
  const surface = parseHexColor(theme.surface);
  const ink = parseHexColor(theme.ink);

  return {
    accent: parseHexColor(theme.accent),
    contrast,
    editorBackground:
      variant === "light" ? mixRgb(surface, WHITE, 0.12) : mixRgb(surface, ink, 0.07),
    ink,
    surface,
    surfaceUnder: buildSurfaceUnder(theme, surface, ink, variant),
    theme,
    variant,
  };
}

function buildCodexCssVariables(
  theme: ReturnType<typeof buildComputedTheme>,
  derivedTokens:
    | ReturnType<typeof buildLightDerivedTokens>
    | ReturnType<typeof buildDarkDerivedTokens>,
  panelBackground: string,
) {
  return {
    "--codex-base-accent": theme.theme.accent,
    "--codex-base-contrast": String(theme.theme.contrast),
    "--codex-base-ink": theme.theme.ink,
    "--codex-base-surface": theme.theme.surface,
    "--color-accent-blue": theme.theme.accent,
    "--color-accent-purple": theme.theme.semanticColors.skill,
    "--color-background-accent": derivedTokens.accentBackground,
    "--color-background-accent-active": derivedTokens.accentBackgroundActive,
    "--color-background-accent-hover": derivedTokens.accentBackgroundHover,
    "--color-background-button-primary": derivedTokens.buttonPrimaryBackground,
    "--color-background-button-primary-active": derivedTokens.buttonPrimaryBackgroundActive,
    "--color-background-button-primary-hover": derivedTokens.buttonPrimaryBackgroundHover,
    "--color-background-button-primary-inactive": derivedTokens.buttonPrimaryBackgroundInactive,
    "--color-background-button-secondary": derivedTokens.buttonSecondaryBackground,
    "--color-background-button-secondary-active": derivedTokens.buttonSecondaryBackgroundActive,
    "--color-background-button-secondary-hover": derivedTokens.buttonSecondaryBackgroundHover,
    "--color-background-button-secondary-inactive": derivedTokens.buttonSecondaryBackgroundInactive,
    "--color-background-button-tertiary": derivedTokens.buttonTertiaryBackground,
    "--color-background-button-tertiary-active": derivedTokens.buttonTertiaryBackgroundActive,
    "--color-background-button-tertiary-hover": derivedTokens.buttonTertiaryBackgroundHover,
    "--color-background-control": derivedTokens.controlBackground,
    "--color-background-control-opaque": derivedTokens.controlBackgroundOpaque,
    "--color-background-editor-opaque": formatOpaqueRgb(theme.editorBackground),
    "--color-background-elevated-primary": derivedTokens.elevatedPrimary,
    "--color-background-elevated-primary-opaque": derivedTokens.elevatedPrimaryOpaque,
    "--color-background-elevated-secondary": derivedTokens.elevatedSecondary,
    "--color-background-elevated-secondary-opaque": derivedTokens.elevatedSecondaryOpaque,
    "--color-background-panel": panelBackground,
    "--color-background-surface": theme.theme.surface,
    "--color-background-surface-under": theme.surfaceUnder,
    // The user message bubble has always reused the subtle secondary surface
    // (theme ink at ~4% over the background); keep it sourced from there.
    "--color-background-user-message": derivedTokens.buttonSecondaryBackground,
    "--color-border": derivedTokens.border,
    "--color-border-focus": derivedTokens.borderFocus,
    "--color-border-heavy": derivedTokens.borderHeavy,
    "--color-border-light": derivedTokens.borderLight,
    "--color-decoration-added": theme.theme.semanticColors.diffAdded,
    "--color-decoration-deleted": theme.theme.semanticColors.diffRemoved,
    "--color-editor-added": formatRgba(
      parseHexColor(theme.theme.semanticColors.diffAdded),
      theme.variant === "light" ? 0.15 : 0.23,
    ),
    "--color-editor-deleted": formatRgba(
      parseHexColor(theme.theme.semanticColors.diffRemoved),
      theme.variant === "light" ? 0.15 : 0.23,
    ),
    "--color-icon-accent": derivedTokens.iconAccent,
    "--color-icon-primary": derivedTokens.iconPrimary,
    "--color-icon-secondary": derivedTokens.iconSecondary,
    "--color-icon-tertiary": derivedTokens.iconTertiary,
    "--color-simple-scrim": derivedTokens.simpleScrim,
    "--color-text-accent": derivedTokens.textAccent,
    "--color-text-button-primary": derivedTokens.textButtonPrimary,
    "--color-text-button-secondary": derivedTokens.textButtonSecondary,
    "--color-text-button-tertiary": derivedTokens.textButtonTertiary,
    "--color-text-foreground": derivedTokens.textForeground,
    "--color-text-foreground-secondary": derivedTokens.textForegroundSecondary,
    "--color-text-foreground-tertiary": derivedTokens.textForegroundTertiary,
  };
}

function buildThemeTokenAliases(codexVariables: Record<string, string>): Record<string, string> {
  const readCodexVariable = (name: string) => getRequiredVariable(codexVariables, name);

  return {
    "--color-token-badge-background": readCodexVariable("--color-background-accent"),
    "--color-token-badge-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-border": readCodexVariable("--color-border"),
    "--color-token-border-default": readCodexVariable("--color-border"),
    "--color-token-border-heavy": readCodexVariable("--color-border-heavy"),
    "--color-token-border-light": readCodexVariable("--color-border-light"),
    "--color-token-button-background": readCodexVariable("--color-background-button-primary"),
    "--color-token-button-border": readCodexVariable("--color-border"),
    "--color-token-button-foreground": readCodexVariable("--color-text-button-primary"),
    "--color-token-button-secondary-hover-background": readCodexVariable(
      "--color-background-button-secondary-hover",
    ),
    "--color-token-checkbox-active-background": readCodexVariable(
      "--color-background-accent-hover",
    ),
    "--color-token-checkbox-active-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-description-foreground": readCodexVariable("--color-text-foreground-secondary"),
    "--color-token-disabled-foreground": readCodexVariable("--color-text-foreground-tertiary"),
    "--color-token-dropdown-background": readCodexVariable("--color-background-control-opaque"),
    "--color-token-focus-border": readCodexVariable("--color-border-focus"),
    "--color-token-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-input-background": readCodexVariable("--color-background-control"),
    "--color-token-input-border": readCodexVariable("--color-border"),
    "--color-token-input-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-input-placeholder-foreground": readCodexVariable(
      "--color-text-foreground-tertiary",
    ),
    "--color-token-link": readCodexVariable("--color-text-accent"),
    "--color-token-list-active-selection-background": readCodexVariable(
      "--color-background-button-secondary",
    ),
    "--color-token-list-active-selection-foreground": readCodexVariable("--color-text-foreground"),
    "--color-token-list-active-selection-icon-foreground":
      readCodexVariable("--color-icon-primary"),
    "--color-token-list-hover-background": readCodexVariable(
      "--color-background-button-secondary-hover",
    ),
    "--color-token-main-surface-primary": readCodexVariable("--color-background-surface"),
    "--color-token-menu-background": readCodexVariable("--color-background-elevated-primary"),
    "--color-token-menu-border": readCodexVariable("--color-border"),
    "--color-token-progress-bar-background": readCodexVariable("--color-background-accent"),
    "--color-token-radio-active-foreground": readCodexVariable("--color-icon-accent"),
    "--color-token-scrollbar-slider-active-background": readCodexVariable("--color-border-heavy"),
    "--color-token-scrollbar-slider-background": readCodexVariable("--color-border-light"),
    "--color-token-scrollbar-slider-hover-background": readCodexVariable("--color-border"),
    "--color-token-side-bar-background": readCodexVariable("--color-background-surface-under"),
    "--color-token-text-code-block-background": readCodexVariable(
      "--color-background-elevated-secondary-opaque",
    ),
    "--color-token-text-link-active-foreground": readCodexVariable("--color-text-accent"),
    "--color-token-text-link-foreground": readCodexVariable("--color-text-accent"),
    "--color-token-text-primary": readCodexVariable("--color-text-foreground"),
    "--color-token-text-secondary": readCodexVariable("--color-text-foreground-secondary"),
    "--color-token-text-tertiary": readCodexVariable("--color-text-foreground-tertiary"),
    "--color-token-toolbar-hover-background": readCodexVariable(
      "--color-background-button-tertiary-hover",
    ),
    "--color-token-editor-background": readCodexVariable("--color-background-editor-opaque"),
    "--color-token-editor-foreground": readCodexVariable("--color-text-foreground"),
  };
}

function getRequiredVariable(variables: Record<string, string>, name: string): string {
  const value = variables[name];
  if (typeof value !== "string") {
    throw new Error(`Missing required theme variable: ${name}`);
  }
  return value;
}

function buildLightDerivedTokens(theme: ReturnType<typeof buildComputedTheme>) {
  // Mirrors Codex Electron's light chrome derivation from chrome-theme-C3NmvE0H.js.
  const controlBase = mixRgb(theme.surface, WHITE, 0.09 + theme.contrast * 0.04);
  const elevatedSecondaryBase = mixRgb(theme.surface, WHITE, 0.08 + theme.contrast * 0.08);
  const elevatedPrimaryBase = mixRgb(theme.surface, WHITE, 0.16 + theme.contrast * 0.12);

  return {
    accentBackground: mixHex(theme.theme.surface, theme.theme.accent, 0.11 + theme.contrast * 0.04),
    accentBackgroundActive: mixHex(
      theme.theme.surface,
      theme.theme.accent,
      0.13 + theme.contrast * 0.05,
    ),
    accentBackgroundHover: mixHex(
      theme.theme.surface,
      theme.theme.accent,
      0.12 + theme.contrast * 0.045,
    ),
    // Light borders run slightly stronger than Codex's base derivation so the chat
    // seam (--color-border) and chat/header dividers (--color-border-light) read
    // clearly on white surfaces. Keep the bump small; don't exceed borderHeavy.
    border: formatRgba(theme.ink, 0.09 + theme.contrast * 0.04),
    borderFocus: theme.theme.accent,
    borderHeavy: formatRgba(theme.ink, 0.09 + theme.contrast * 0.06),
    borderLight: formatRgba(theme.ink, 0.07 + theme.contrast * 0.02),
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: formatRgba(theme.ink, 0.1 + theme.contrast * 0.12),
    buttonPrimaryBackgroundHover: formatRgba(theme.ink, 0.05 + theme.contrast * 0.06),
    buttonPrimaryBackgroundInactive: formatRgba(theme.ink, 0.18 + theme.contrast * 0.14),
    buttonSecondaryBackground: formatRgba(theme.ink, 0.04),
    buttonSecondaryBackgroundActive: formatRgba(theme.ink, 0.03 + theme.contrast * 0.02),
    buttonSecondaryBackgroundHover: formatRgba(theme.ink, 0.04),
    buttonSecondaryBackgroundInactive: formatRgba(theme.ink, 0.01 + theme.contrast * 0.02),
    buttonTertiaryBackground: formatRgba(theme.ink, 0),
    buttonTertiaryBackgroundActive: formatRgba(theme.ink, 0.16 + theme.contrast * 0.08),
    buttonTertiaryBackgroundHover: formatRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    controlBackground: formatRgba(controlBase, 0.96),
    controlBackgroundOpaque: formatOpaqueRgb(controlBase),
    elevatedPrimary: formatRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: formatOpaqueRgb(elevatedPrimaryBase),
    elevatedSecondary: formatRgba(theme.ink, 0.04),
    elevatedSecondaryOpaque: formatOpaqueRgb(elevatedSecondaryBase),
    iconAccent: theme.theme.accent,
    iconPrimary: theme.theme.ink,
    iconSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: formatRgba(BLACK, 0.08 + theme.contrast * 0.04),
    textAccent: theme.theme.accent,
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: theme.theme.ink,
    textButtonTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
  };
}

function buildDarkDerivedTokens(theme: ReturnType<typeof buildComputedTheme>) {
  // Mirrors Codex Electron's dark chrome derivation from chrome-theme-C3NmvE0H.js.
  const controlBase = mixRgb(theme.surface, theme.ink, 0.06 + theme.contrast * 0.05);
  const focusBase = mixRgb(theme.accent, WHITE, 0.3 + theme.contrast * 0.15);
  const elevatedPrimaryBase = mixRgb(theme.surface, theme.ink, 0.08 + theme.contrast * 0.08);

  return {
    accentBackground: mixHex("#000000", theme.theme.accent, 0.2 + theme.contrast * 0.08),
    accentBackgroundActive: mixHex("#000000", theme.theme.accent, 0.22 + theme.contrast * 0.12),
    accentBackgroundHover: mixHex("#000000", theme.theme.accent, 0.21 + theme.contrast * 0.1),
    border: formatRgba(theme.ink, 0.1 + theme.contrast * 0.04),
    borderFocus: formatRgba(focusBase, 0.7 + theme.contrast * 0.1),
    borderHeavy: formatRgba(theme.ink, 0.16 + theme.contrast * 0.06),
    borderLight: formatRgba(theme.ink, 0.06 + theme.contrast * 0.02),
    // High-contrast primary button (white-on-dark) mirroring the light-mode
    // derivation (bg = ink, text = surface). Intentionally diverges from Codex
    // Electron's dark elevated primary so the primary action reads as filled.
    buttonPrimaryBackground: theme.theme.ink,
    buttonPrimaryBackgroundActive: formatRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonPrimaryBackgroundHover: formatRgba(theme.ink, 0.04 + theme.contrast * 0.03),
    buttonPrimaryBackgroundInactive: formatRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    buttonSecondaryBackground: formatRgba(theme.ink, 0.04 + theme.contrast * 0.02),
    buttonSecondaryBackgroundActive: formatRgba(theme.ink, 0.09 + theme.contrast * 0.05),
    buttonSecondaryBackgroundHover: formatRgba(theme.ink, 0.06 + theme.contrast * 0.03),
    buttonSecondaryBackgroundInactive: formatRgba(theme.ink, 0.02 + theme.contrast * 0.03),
    buttonTertiaryBackground: formatRgba(theme.ink, 0.02 + theme.contrast * 0.015),
    buttonTertiaryBackgroundActive: formatRgba(theme.ink, 0.07 + theme.contrast * 0.05),
    buttonTertiaryBackgroundHover: formatRgba(theme.ink, 0.05 + theme.contrast * 0.03),
    controlBackground: formatRgba(controlBase, 0.96),
    controlBackgroundOpaque: formatOpaqueRgb(controlBase),
    elevatedPrimary: formatRgba(elevatedPrimaryBase, 0.96),
    elevatedPrimaryOpaque: formatOpaqueRgb(elevatedPrimaryBase),
    elevatedSecondary: formatRgba(theme.ink, 0.02 + theme.contrast * 0.02),
    elevatedSecondaryOpaque: mixHex(
      theme.theme.surface,
      theme.theme.ink,
      0.04 + theme.contrast * 0.05,
    ),
    iconAccent: formatOpaqueRgb(focusBase),
    iconPrimary: formatRgba(theme.ink, 0.82 + theme.contrast * 0.14),
    iconSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    iconTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    simpleScrim: formatRgba(theme.ink, 0.08 + theme.contrast * 0.04),
    // Codex brightens dark accent affordances through the same focus mix used
    // for the border, rather than using the raw accent directly.
    textAccent: formatOpaqueRgb(focusBase),
    textButtonPrimary: theme.theme.surface,
    textButtonSecondary: mixHex(theme.theme.ink, theme.theme.surface, 0.7 + theme.contrast * 0.1),
    textButtonTertiary: formatRgba(theme.ink, 0.45 + theme.contrast * 0.1),
    textForeground: theme.theme.ink,
    textForegroundSecondary: formatRgba(theme.ink, 0.65 + theme.contrast * 0.1),
    textForegroundTertiary: formatRgba(theme.ink, 0.42 + theme.contrast * 0.13),
  };
}

function buildSurfaceUnder(
  theme: ChromeTheme,
  surface: RgbColor,
  ink: RgbColor,
  variant: ThemeVariant,
): string {
  const baseline = DEFAULT_CHROME_THEME_BY_VARIANT[variant].contrast;
  const mixAmount =
    SURFACE_UNDER_BASE_ALPHA[variant] +
    (theme.contrast - baseline) * SURFACE_UNDER_CONTRAST_STEP[variant];
  return variant === "light"
    ? mixHex(formatHex(surface), formatHex(ink), mixAmount)
    : mixHex(formatHex(surface), "#000000", mixAmount);
}

function buildPanelBackground(theme: ReturnType<typeof buildComputedTheme>): string {
  const anchor = theme.variant === "light" ? WHITE : theme.ink;
  return mixHex(
    theme.theme.surface,
    formatHex(anchor),
    PANEL_BASE_ALPHA[theme.variant] + theme.contrast * PANEL_CONTRAST_STEP[theme.variant],
  );
}

function buildComposerFocusBorder(
  pack: ThemePack,
  variant: ThemeVariant,
  panelBackground: string,
): string {
  const panel = parseHexColor(panelBackground);
  const anchor = variant === "dark" ? WHITE : parseHexColor(pack.theme.ink);
  const contrast = normalizeContrastStrength(pack.theme.contrast, variant);
  const mixAmount = variant === "dark" ? 0.12 + contrast * 0.06 : 0.1 + contrast * 0.05;
  return mixHex(formatHex(panel), formatHex(anchor), mixAmount);
}

export function normalizeContrastStrength(value: number, variant: ThemeVariant): number {
  const baseline = DEFAULT_CHROME_THEME_BY_VARIANT[variant].contrast;
  const baselineRatio = baseline / 100;
  const curvedValue = value / 100 + ((value - baseline) / 60) * CONTRAST_CURVE_BELOW_BASELINE;

  if (value <= baseline) {
    return curvedValue;
  }

  return baselineRatio + (curvedValue - baselineRatio) * CONTRAST_CURVE_ABOVE_BASELINE;
}
