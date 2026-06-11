// FILE: theme.logic.ts
// Purpose: Owns the Codex-style theme model, share-string parsing, and derived CSS token math.
// Layer: Web appearance domain logic
// Exports: Theme types, normalization helpers, import/export utilities, and CSS variable builders.

import { THEME_SEED_CATALOG } from "./theme.seed.generated";
import {
  isRecord,
  normalizeFontSelection,
  normalizeHexColor,
  normalizeRequiredString,
  normalizeStoredContrast,
  parseNullableString,
  parseRequiredBoolean,
  parseRequiredContrast,
  parseRequiredHexColor,
} from "./theme.logic.parse";
import { DEFAULT_CHROME_THEME_BY_VARIANT } from "./theme.logic.tokens";

export {
  buildResolvedThemeTokens,
  buildThemeCssVariables,
  DEFAULT_CHROME_THEME_BY_VARIANT,
} from "./theme.logic.tokens";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeVariant = "light" | "dark";
export type WindowMaterial = "opaque" | "translucent";

export interface ThemeFonts {
  ui: string | null;
  code: string | null;
}

export interface ThemeSemanticColors {
  diffAdded: string;
  diffRemoved: string;
  skill: string;
}

export interface ChromeTheme {
  accent: string;
  contrast: number;
  fonts: ThemeFonts;
  ink: string;
  opaqueWindows: boolean;
  semanticColors: ThemeSemanticColors;
  surface: string;
}

export interface ThemePack {
  codeThemeId: string;
  theme: ChromeTheme;
}

export interface ThemeState {
  chromeThemes: Record<ThemeVariant, ChromeTheme>;
  codeThemeIds: Record<ThemeVariant, string>;
  mode: ThemeMode;
}

export interface CodeThemeOption {
  id: string;
  label: string;
  variants: readonly ThemeVariant[];
}

export interface ThemeSharePayload {
  codeThemeId: string;
  theme: ChromeTheme;
  variant: ThemeVariant;
}

export interface ThemeCssVariableBuild {
  material: WindowMaterial;
  variables: Record<string, string>;
}

export interface ThemeDerivedTokens {
  accentBackground: string;
  accentBackgroundActive: string;
  accentBackgroundHover: string;
  border: string;
  borderFocus: string;
  borderHeavy: string;
  borderLight: string;
  buttonPrimaryBackground: string;
  buttonPrimaryBackgroundActive: string;
  buttonPrimaryBackgroundHover: string;
  buttonPrimaryBackgroundInactive: string;
  buttonSecondaryBackground: string;
  buttonSecondaryBackgroundActive: string;
  buttonSecondaryBackgroundHover: string;
  buttonSecondaryBackgroundInactive: string;
  buttonTertiaryBackground: string;
  buttonTertiaryBackgroundActive: string;
  buttonTertiaryBackgroundHover: string;
  controlBackground: string;
  controlBackgroundOpaque: string;
  elevatedPrimary: string;
  elevatedPrimaryOpaque: string;
  elevatedSecondary: string;
  elevatedSecondaryOpaque: string;
  iconAccent: string;
  iconPrimary: string;
  iconSecondary: string;
  iconTertiary: string;
  simpleScrim: string;
  textAccent: string;
  textButtonPrimary: string;
  textButtonSecondary: string;
  textButtonTertiary: string;
  textForeground: string;
  textForegroundSecondary: string;
  textForegroundTertiary: string;
}

export interface ResolvedThemeTokens {
  aliases: Record<string, string>;
  codexVariables: Record<string, string>;
  computed: {
    contrast: number;
    editorBackground: string;
    panel: string;
    surfaceUnder: string;
  };
  derived: ThemeDerivedTokens;
}

type ChromeThemeSeedPatch = Partial<
  Pick<ChromeTheme, "accent" | "contrast" | "ink" | "opaqueWindows" | "surface">
> & {
  fonts?: Partial<ThemeFonts>;
  semanticColors?: Partial<ThemeSemanticColors>;
};

type CodeThemeSeedPatchMetadata = {
  contrast?: true;
  fonts?: Partial<Record<keyof ThemeFonts, true>>;
  opaqueWindows?: true;
};

const THEME_SHARE_PREFIX = "codex-theme-v1:";
const CODE_THEME_SEED_PATCH_METADATA: Partial<
  Record<string, Partial<Record<ThemeVariant, CodeThemeSeedPatchMetadata>>>
> = {
  linear: {
    dark: { fonts: { ui: true }, opaqueWindows: true },
    light: { fonts: { ui: true }, opaqueWindows: true },
  },
  lobster: {
    dark: { fonts: { ui: true } },
  },
  matrix: {
    dark: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  notion: {
    dark: { fonts: { code: true, ui: true }, opaqueWindows: true },
    light: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  proof: {
    light: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  raycast: {
    dark: { fonts: { code: true, ui: true }, opaqueWindows: true },
    light: { fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  sentry: {
    dark: { fonts: { code: true, ui: true } },
  },
  vercel: {
    dark: { contrast: true, fonts: { code: true, ui: true }, opaqueWindows: true },
    light: { contrast: true, fonts: { code: true, ui: true }, opaqueWindows: true },
  },
  "dp-code": {
    dark: { contrast: true },
    light: { contrast: true },
  },
};

// Mirror the packaged Codex catalog closely enough that share-string validation
// can preserve the "known theme + variant availability" behavior.
export const CODE_THEME_OPTIONS: readonly CodeThemeOption[] = [
  { id: "absolutely", label: "Absolutely", variants: ["light", "dark"] },
  { id: "ayu", label: "Ayu", variants: ["dark"] },
  { id: "catppuccin", label: "Catppuccin", variants: ["light", "dark"] },
  { id: "codex", label: "Codex", variants: ["light", "dark"] },
  { id: "dp-code", label: "Synara", variants: ["light", "dark"] },
  { id: "dracula", label: "Dracula", variants: ["dark"] },
  { id: "everforest", label: "Everforest", variants: ["light", "dark"] },
  { id: "github", label: "GitHub", variants: ["light", "dark"] },
  { id: "gruvbox", label: "Gruvbox", variants: ["light", "dark"] },
  { id: "linear", label: "Linear", variants: ["light", "dark"] },
  { id: "lobster", label: "Lobster", variants: ["dark"] },
  { id: "material", label: "Material", variants: ["dark"] },
  { id: "matrix", label: "Matrix", variants: ["dark"] },
  { id: "monokai", label: "Monokai", variants: ["dark"] },
  { id: "night-owl", label: "Night Owl", variants: ["dark"] },
  { id: "nord", label: "Nord", variants: ["dark"] },
  { id: "notion", label: "Notion", variants: ["light", "dark"] },
  { id: "one", label: "One", variants: ["light", "dark"] },
  { id: "oscurange", label: "Oscurange", variants: ["dark"] },
  { id: "proof", label: "Proof", variants: ["light"] },
  { id: "raycast", label: "Raycast", variants: ["light", "dark"] },
  { id: "rose-pine", label: "Rose Pine", variants: ["light", "dark"] },
  { id: "sentry", label: "Sentry", variants: ["dark"] },
  { id: "solarized", label: "Solarized", variants: ["light", "dark"] },
  { id: "temple", label: "Temple", variants: ["dark"] },
  { id: "tokyo-night", label: "Tokyo Night", variants: ["dark"] },
  { id: "vercel", label: "Vercel", variants: ["light", "dark"] },
  { id: "vscode-plus", label: "VS Code Plus", variants: ["light", "dark"] },
] as const;

export const DEFAULT_THEME_STATE: ThemeState = {
  chromeThemes: {
    dark: getCodeThemeSeed("codex", "dark"),
    light: getCodeThemeSeed("codex", "light"),
  },
  codeThemeIds: {
    dark: "codex",
    light: "codex",
  },
  mode: "system",
};

// ─── Theme catalog helpers ────────────────────────────────────────────────

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function isThemeVariant(value: unknown): value is ThemeVariant {
  return value === "light" || value === "dark";
}

export function getThemeSharePrefix(): string {
  return THEME_SHARE_PREFIX;
}

export function getAvailableCodeThemes(variant: ThemeVariant): readonly CodeThemeOption[] {
  return CODE_THEME_OPTIONS.filter((option) => option.variants.includes(variant));
}

export function isCodeThemeAvailable(codeThemeId: string, variant: ThemeVariant): boolean {
  const normalizedCodeThemeId = codeThemeId.trim().toLowerCase();
  return CODE_THEME_OPTIONS.some(
    (option) => option.id === normalizedCodeThemeId && option.variants.includes(variant),
  );
}

export function normalizeCodeThemeId(
  codeThemeId: unknown,
  variant: ThemeVariant,
  fallback = DEFAULT_THEME_STATE.codeThemeIds[variant],
): string {
  const normalizedCodeThemeId =
    typeof codeThemeId === "string" ? codeThemeId.trim().toLowerCase() : "";
  return isCodeThemeAvailable(normalizedCodeThemeId, variant) ? normalizedCodeThemeId : fallback;
}

// ─── Theme normalization ──────────────────────────────────────────────────

export function normalizeThemeFonts(value: unknown): ThemeFonts {
  const fonts = isRecord(value) ? value : {};
  return {
    code: normalizeFontSelection(fonts.code),
    ui: normalizeFontSelection(fonts.ui),
  };
}

export function normalizeSemanticColors(
  value: unknown,
  fallback: ThemeSemanticColors,
): ThemeSemanticColors {
  const semanticColors = isRecord(value) ? value : {};
  return {
    diffAdded: normalizeHexColor(semanticColors.diffAdded) ?? fallback.diffAdded,
    diffRemoved: normalizeHexColor(semanticColors.diffRemoved) ?? fallback.diffRemoved,
    skill: normalizeHexColor(semanticColors.skill) ?? fallback.skill,
  };
}

export function normalizeChromeTheme(value: unknown, variant: ThemeVariant): ChromeTheme {
  const fallback = DEFAULT_CHROME_THEME_BY_VARIANT[variant];
  const theme = isRecord(value) ? value : {};

  return {
    accent: normalizeHexColor(theme.accent) ?? fallback.accent,
    contrast: normalizeStoredContrast(theme.contrast, fallback.contrast),
    fonts: normalizeThemeFonts(theme.fonts),
    ink: normalizeHexColor(theme.ink) ?? fallback.ink,
    opaqueWindows:
      theme.opaqueWindows === true || theme.opaqueWindows === false
        ? theme.opaqueWindows
        : fallback.opaqueWindows,
    semanticColors: normalizeSemanticColors(theme.semanticColors, fallback.semanticColors),
    surface: normalizeHexColor(theme.surface) ?? fallback.surface,
  };
}

export function normalizeThemePack(value: unknown, variant: ThemeVariant): ThemePack {
  const pack = isRecord(value) ? value : {};
  return {
    codeThemeId: normalizeCodeThemeId(pack.codeThemeId, variant),
    theme: normalizeChromeTheme(pack.theme, variant),
  };
}

export function normalizeThemeState(value: unknown): ThemeState {
  const state = isRecord(value) ? value : {};
  const codeThemeIds = isRecord(state.codeThemeIds) ? state.codeThemeIds : {};
  const chromeThemes = isRecord(state.chromeThemes) ? state.chromeThemes : {};
  const packs = isRecord(state.packs) ? state.packs : {};
  const legacyDarkPack = normalizeThemePack(packs.dark, "dark");
  const legacyLightPack = normalizeThemePack(packs.light, "light");
  return {
    chromeThemes: {
      dark: isRecord(chromeThemes.dark)
        ? normalizeChromeTheme(chromeThemes.dark, "dark")
        : isRecord(packs.dark)
          ? legacyDarkPack.theme
          : DEFAULT_THEME_STATE.chromeThemes.dark,
      light: isRecord(chromeThemes.light)
        ? normalizeChromeTheme(chromeThemes.light, "light")
        : isRecord(packs.light)
          ? legacyLightPack.theme
          : DEFAULT_THEME_STATE.chromeThemes.light,
    },
    codeThemeIds: {
      dark: normalizeCodeThemeId(codeThemeIds.dark ?? legacyDarkPack.codeThemeId, "dark"),
      light: normalizeCodeThemeId(codeThemeIds.light ?? legacyLightPack.codeThemeId, "light"),
    },
    mode: isThemeMode(state.mode) ? state.mode : DEFAULT_THEME_STATE.mode,
  };
}

export function parseStoredThemeState(rawValue: string | null | undefined): ThemeState {
  if (!rawValue) {
    return DEFAULT_THEME_STATE;
  }
  if (isThemeMode(rawValue)) {
    return {
      ...DEFAULT_THEME_STATE,
      mode: rawValue,
    };
  }

  try {
    return normalizeThemeState(JSON.parse(rawValue));
  } catch {
    return DEFAULT_THEME_STATE;
  }
}

export function serializeThemeState(state: ThemeState): string {
  return JSON.stringify(state);
}

// ─── Share-string import / export ─────────────────────────────────────────

export function createThemeShareString(variant: ThemeVariant, pack: ThemePack): string {
  return `${THEME_SHARE_PREFIX}${JSON.stringify({
    codeThemeId: pack.codeThemeId,
    theme: pack.theme,
    variant,
  })}`;
}

export function parseThemeShareString(rawValue: string): ThemeSharePayload {
  const value = rawValue.trim();
  if (!value.startsWith(THEME_SHARE_PREFIX)) {
    throw new Error("Theme share string must start with codex-theme-v1:");
  }

  const payloadText = value.slice(THEME_SHARE_PREFIX.length);
  const jsonText = payloadText.startsWith("{") ? payloadText : decodeURIComponent(payloadText);
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error("Theme share string does not contain valid JSON.");
  }

  const themeShare = parseThemeSharePayload(payload);
  if (!isCodeThemeAvailable(themeShare.codeThemeId, themeShare.variant)) {
    throw new Error(
      `Code theme "${themeShare.codeThemeId}" is not available for ${themeShare.variant}.`,
    );
  }

  return {
    codeThemeId: themeShare.codeThemeId,
    theme: normalizeChromeTheme(themeShare.theme, themeShare.variant),
    variant: themeShare.variant,
  };
}

export function canParseThemeShareString(value: string, targetVariant?: ThemeVariant): boolean {
  try {
    parseThemeShareStringForVariant(value, targetVariant);
    return true;
  } catch {
    return false;
  }
}

export function parseThemeShareStringForVariant(
  value: string,
  targetVariant?: ThemeVariant,
): ThemeSharePayload {
  const payload = parseThemeShareString(value);
  if (targetVariant && payload.variant !== targetVariant) {
    throw new Error(
      `Theme variant mismatch. Expected ${targetVariant}, received ${payload.variant}.`,
    );
  }
  return payload;
}

export function updateThemePackFromShareString(
  state: ThemeState,
  value: string,
  targetVariant: ThemeVariant,
): ThemeState {
  const payload = parseThemeShareStringForVariant(value, targetVariant);
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [targetVariant]: payload.theme,
    },
    codeThemeIds: {
      ...state.codeThemeIds,
      [targetVariant]: payload.codeThemeId,
    },
  };
}

// ─── Granular pack mutators ───────────────────────────────────────────────

export function updateChromeTheme(
  state: ThemeState,
  variant: ThemeVariant,
  patch: Partial<ChromeTheme>,
): ThemeState {
  const previousTheme = state.chromeThemes[variant];
  const nextPatch: ChromeThemeSeedPatch = { ...patch };
  if (patch.fonts) {
    nextPatch.fonts = patch.fonts;
  }
  if (patch.semanticColors) {
    nextPatch.semanticColors = patch.semanticColors;
  }
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: normalizeChromeTheme(mergeThemeSeedPatch(previousTheme, nextPatch), variant),
    },
  };
}

export function setThemeCodeThemeId(
  state: ThemeState,
  variant: ThemeVariant,
  codeThemeId: string,
): ThemeState {
  const normalized = normalizeCodeThemeId(codeThemeId, variant);
  const previousTheme = resolveThemePack(state, variant).theme;
  const nextTheme = normalizeChromeTheme(
    mergeThemeSeedPatch(previousTheme, getCodeThemeSeedPatch(normalized, variant)),
    variant,
  );
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: nextTheme,
    },
    codeThemeIds: {
      ...state.codeThemeIds,
      [variant]: normalized,
    },
  };
}

export function getCodeThemeSeed(codeThemeId: string, variant: ThemeVariant): ChromeTheme {
  const fallback = DEFAULT_CHROME_THEME_BY_VARIANT[variant];
  const themeSeed = THEME_SEED_CATALOG[codeThemeId]?.[variant];
  return themeSeed ? normalizeChromeTheme(themeSeed, variant) : fallback;
}

export function getCodeThemeSeedPatch(
  codeThemeId: string,
  variant: ThemeVariant,
): ChromeThemeSeedPatch {
  const themeSeed = THEME_SEED_CATALOG[codeThemeId]?.[variant];
  if (!themeSeed) {
    return {};
  }

  const normalizedSeed = normalizeChromeTheme(themeSeed, variant);
  const metadata = CODE_THEME_SEED_PATCH_METADATA[codeThemeId]?.[variant];
  const patch: ChromeThemeSeedPatch = {
    accent: normalizedSeed.accent,
    ink: normalizedSeed.ink,
    semanticColors: normalizedSeed.semanticColors,
    surface: normalizedSeed.surface,
  };

  if (metadata?.contrast) {
    patch.contrast = normalizedSeed.contrast;
  }

  if (metadata?.opaqueWindows) {
    patch.opaqueWindows = normalizedSeed.opaqueWindows;
  }

  if (metadata?.fonts) {
    const fontPatch: Partial<ThemeFonts> = {};
    if (metadata.fonts.code) {
      fontPatch.code = normalizedSeed.fonts.code;
    }
    if (metadata.fonts.ui) {
      fontPatch.ui = normalizedSeed.fonts.ui;
    }
    if (Object.keys(fontPatch).length > 0) {
      patch.fonts = fontPatch;
    }
  }

  return patch;
}

function mergeThemeSeedPatch(
  currentTheme: ChromeTheme,
  seedPatch: ChromeThemeSeedPatch,
): ChromeThemeSeedPatch {
  return {
    ...currentTheme,
    ...seedPatch,
    fonts: seedPatch.fonts ? { ...currentTheme.fonts, ...seedPatch.fonts } : currentTheme.fonts,
    semanticColors: seedPatch.semanticColors
      ? { ...currentTheme.semanticColors, ...seedPatch.semanticColors }
      : currentTheme.semanticColors,
  };
}

export function setThemeFonts(
  state: ThemeState,
  variant: ThemeVariant,
  patch: Partial<ThemeFonts>,
): ThemeState {
  const previousTheme = state.chromeThemes[variant];
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: normalizeChromeTheme(
        {
          ...previousTheme,
          fonts: { ...previousTheme.fonts, ...patch },
        },
        variant,
      ),
    },
  };
}

export function resetThemeVariant(state: ThemeState, variant: ThemeVariant): ThemeState {
  return {
    ...state,
    chromeThemes: {
      ...state.chromeThemes,
      [variant]: DEFAULT_THEME_STATE.chromeThemes[variant],
    },
    codeThemeIds: {
      ...state.codeThemeIds,
      [variant]: DEFAULT_THEME_STATE.codeThemeIds[variant],
    },
  };
}

export function resolveThemePack(state: ThemeState, variant: ThemeVariant): ThemePack {
  return {
    codeThemeId: normalizeCodeThemeId(state.codeThemeIds[variant], variant),
    theme: normalizeChromeTheme(state.chromeThemes[variant], variant),
  };
}

export function areThemePacksEqual(left: ThemePack, right: ThemePack): boolean {
  return (
    left.codeThemeId === right.codeThemeId &&
    left.theme.accent === right.theme.accent &&
    left.theme.contrast === right.theme.contrast &&
    left.theme.fonts.code === right.theme.fonts.code &&
    left.theme.fonts.ui === right.theme.fonts.ui &&
    left.theme.ink === right.theme.ink &&
    left.theme.opaqueWindows === right.theme.opaqueWindows &&
    left.theme.semanticColors.diffAdded === right.theme.semanticColors.diffAdded &&
    left.theme.semanticColors.diffRemoved === right.theme.semanticColors.diffRemoved &&
    left.theme.semanticColors.skill === right.theme.semanticColors.skill &&
    left.theme.surface === right.theme.surface
  );
}

// ─── Theme derivation ─────────────────────────────────────────────────────

export function resolveThemeVariant(mode: ThemeMode, systemDark: boolean): ThemeVariant {
  if (mode === "system") {
    return systemDark ? "dark" : "light";
  }
  return mode;
}

// ─── Parsing helpers ──────────────────────────────────────────────────────

function parseThemeSharePayload(value: unknown): ThemeSharePayload {
  if (!isRecord(value)) {
    throw new Error("Theme share payload must be an object.");
  }

  const codeThemeId = normalizeRequiredString(value.codeThemeId, "Theme share codeThemeId");
  const variant = value.variant;
  if (!isThemeVariant(variant)) {
    throw new Error("Theme share variant must be either light or dark.");
  }

  const theme = parseStrictChromeTheme(value.theme);
  return {
    codeThemeId: codeThemeId.toLowerCase(),
    theme,
    variant,
  };
}

function parseStrictChromeTheme(value: unknown): ChromeTheme {
  if (!isRecord(value)) {
    throw new Error("Theme share theme must be an object.");
  }

  return {
    accent: parseRequiredHexColor(value.accent, "Theme accent"),
    contrast: parseRequiredContrast(value.contrast),
    fonts: parseStrictThemeFonts(value.fonts),
    ink: parseRequiredHexColor(value.ink, "Theme ink"),
    opaqueWindows: parseRequiredBoolean(value.opaqueWindows, "Theme opaqueWindows"),
    semanticColors: parseStrictSemanticColors(value.semanticColors),
    surface: parseRequiredHexColor(value.surface, "Theme surface"),
  };
}

function parseStrictThemeFonts(value: unknown): ThemeFonts {
  if (!isRecord(value)) {
    throw new Error("Theme fonts must be an object.");
  }

  return {
    code: parseNullableString(value.code, "Theme code font"),
    ui: parseNullableString(value.ui, "Theme UI font"),
  };
}

function parseStrictSemanticColors(value: unknown): ThemeSemanticColors {
  if (!isRecord(value)) {
    throw new Error("Theme semanticColors must be an object.");
  }

  return {
    diffAdded: parseRequiredHexColor(value.diffAdded, "Theme diffAdded"),
    diffRemoved: parseRequiredHexColor(value.diffRemoved, "Theme diffRemoved"),
    skill: parseRequiredHexColor(value.skill, "Theme skill"),
  };
}
