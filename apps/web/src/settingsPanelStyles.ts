// FILE: settingsPanelStyles.ts
// Purpose: Shared layout tokens for the settings content panel (page bg, bordered cards, rows).
// Layer: Settings UI styling
// Exports: border, surface, card, row, and inset list class names

import { COMPOSER_PICKER_RADIUS_CLASS_NAME } from "./components/chat/composerPickerStyles";

/** Same border token as Button `outline` / `chrome-outline` variants. */
export const SETTINGS_CONTROL_BORDER_CLASS_NAME =
  "border border-[color:var(--color-border)]";

/** Main settings scroll surface — follows the active theme Background. */
export const SETTINGS_PAGE_BACKGROUND_CLASS_NAME =
  "bg-[var(--color-background-surface)]";

/** Section label above a bordered card group. */
export const SETTINGS_SECTION_LABEL_CLASS_NAME =
  "px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground";

/** Grouped settings card: theme surface fill + button border, no shadow. */
export const SETTINGS_CARD_CLASS_NAME = [
  "overflow-hidden bg-[var(--color-background-surface)]",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
].join(" ");

/** Row padding inside a settings card. */
export const SETTINGS_CARD_ROW_CLASS_NAME = "px-4 py-3.5";

/** Divider between stacked rows inside one card. */
export const SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME =
  "border-t border-[color:var(--color-border)]";

/** Nested list/table inside a row (provider installs, updates, etc.). */
export const SETTINGS_INSET_LIST_CLASS_NAME = SETTINGS_CARD_CLASS_NAME;

/** Empty / placeholder blocks. */
export const SETTINGS_EMPTY_STATE_CLASS_NAME = [
  "bg-[var(--color-background-surface)]",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
  "border-dashed",
].join(" ");
