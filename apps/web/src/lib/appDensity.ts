export const UI_DENSITY_MODES = ["compact", "comfortable", "spacious"] as const;
export type UiDensity = (typeof UI_DENSITY_MODES)[number];

export const DEFAULT_UI_DENSITY: UiDensity = "comfortable";

const DENSITY_SCALE_BY_MODE: Record<UiDensity, number> = {
  compact: 0.85,
  comfortable: 1,
  spacious: 1.15,
};

const BASE_ROW_HEIGHT_REM = 1.75;
const BASE_ROW_PADDING_Y_REM = 0.125;
const BASE_ROW_GAP_REM = 0.5;
const BASE_SETTINGS_ROW_PADDING_Y_REM = 0.625;
const BASE_CHAT_GUTTER_X_REM = 0.75;
const BASE_CHAT_GUTTER_X_LG_REM = 1.25;
const BASE_COMPOSER_EDITOR_PADDING_TOP_REM = 0.75;
const BASE_COMPOSER_EDITOR_PADDING_BOTTOM_REM = 0.5;
const BASE_COMPOSER_EDITOR_PADDING_X_REM = 0.75;
const BASE_COMPOSER_EDITOR_PADDING_X_END_REM = 0.875;
const BASE_COMPOSER_FOOTER_PADDING_REM = 0.375;
const BASE_COMPOSER_FOOTER_PADDING_END_REM = 0.5;

function scaleRem(baseRem: number, scale: number): string {
  return `${baseRem * scale}rem`;
}

export function isUiDensity(value: unknown): value is UiDensity {
  return typeof value === "string" && (UI_DENSITY_MODES as readonly string[]).includes(value);
}

export function normalizeUiDensity(value: unknown, fallback = DEFAULT_UI_DENSITY): UiDensity {
  return isUiDensity(value) ? value : fallback;
}

export function getDensityScale(mode: UiDensity = DEFAULT_UI_DENSITY): number {
  return DENSITY_SCALE_BY_MODE[mode];
}

export function getDensityCssVariables(mode: UiDensity = DEFAULT_UI_DENSITY) {
  const scale = getDensityScale(mode);

  return {
    "--density-scale": String(scale),
    "--app-density-row-height": scaleRem(BASE_ROW_HEIGHT_REM, scale),
    "--app-density-row-padding-y": scaleRem(BASE_ROW_PADDING_Y_REM, scale),
    "--app-density-row-gap": scaleRem(BASE_ROW_GAP_REM, scale),
    "--app-density-settings-row-padding-y": scaleRem(BASE_SETTINGS_ROW_PADDING_Y_REM, scale),
    "--app-density-chat-gutter-x": scaleRem(BASE_CHAT_GUTTER_X_REM, scale),
    "--app-density-chat-gutter-x-lg": scaleRem(BASE_CHAT_GUTTER_X_LG_REM, scale),
    "--app-density-composer-editor-min-height": `calc(2lh * ${scale})`,
    "--app-density-composer-editor-padding-top": scaleRem(
      BASE_COMPOSER_EDITOR_PADDING_TOP_REM,
      scale,
    ),
    "--app-density-composer-editor-padding-bottom": scaleRem(
      BASE_COMPOSER_EDITOR_PADDING_BOTTOM_REM,
      scale,
    ),
    "--app-density-composer-editor-padding-x": scaleRem(BASE_COMPOSER_EDITOR_PADDING_X_REM, scale),
    "--app-density-composer-editor-padding-x-end": scaleRem(
      BASE_COMPOSER_EDITOR_PADDING_X_END_REM,
      scale,
    ),
    "--app-density-composer-footer-padding": scaleRem(BASE_COMPOSER_FOOTER_PADDING_REM, scale),
    "--app-density-composer-footer-padding-end": scaleRem(
      BASE_COMPOSER_FOOTER_PADDING_END_REM,
      scale,
    ),
  } as const;
}

export type DensityCssVariable = keyof ReturnType<typeof getDensityCssVariables>;
