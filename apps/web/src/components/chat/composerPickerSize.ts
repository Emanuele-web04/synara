// FILE: composerPickerSize.ts
// Purpose: Size variant for composer picker open panels (density + opt-in fixed width).
// Layer: UI styling config
// Change COMPOSER_PICKER_SIZE to switch every composer picker between "small" and "normal".
// Width is content-sized by default; only model/effort/provider pickers opt into a fixed width.

export type ComposerPickerSize = "small" | "normal";

/** Global picker menu density — set to "small" or "normal". */
export const COMPOSER_PICKER_SIZE: ComposerPickerSize = "normal";

export function resolveComposerPickerSize(
  size: ComposerPickerSize | undefined,
): ComposerPickerSize {
  return size ?? COMPOSER_PICKER_SIZE;
}

// Density-only shell. Panels shrink to their content (or honor an explicit
// caller width) so non-model menus like git/header keep their own sizing.
export function composerPickerMenuShellClassName(
  size: ComposerPickerSize | undefined = COMPOSER_PICKER_SIZE,
): string {
  const resolved = resolveComposerPickerSize(size);
  return `composer-picker-menu composer-picker-menu--${resolved}`;
}

// Density shell + opt-in fixed width for the composer model/effort/provider pickers.
export function composerPickerMenuFixedShellClassName(
  size: ComposerPickerSize | undefined = COMPOSER_PICKER_SIZE,
): string {
  return `${composerPickerMenuShellClassName(size)} composer-picker-menu-fixed`;
}
