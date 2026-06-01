// FILE: settingsPanelStyles.ts
// Purpose: Shared layout tokens for the settings content panel (page bg, bordered cards, rows).
// Layer: Settings UI styling
// Exports: border, surface, card, row, and inset list class names

/** Shared corner radius for settings cards, controls, and select popups. */
export const SETTINGS_RADIUS_CLASS_NAME = "rounded-xl";

/** Same border token as Button `outline` / `chrome-outline` variants. */
export const SETTINGS_CONTROL_BORDER_CLASS_NAME = "border border-[color:var(--color-border)]";

/** Main settings shell — opaque and matched to the chat surface (see `--app-settings-surface`),
 *  so cards/rows read as outline-only on the same background as the chat. */
export const SETTINGS_PAGE_BACKGROUND_CLASS_NAME = "app-settings-surface";

/** Section label above a bordered card group. */
export const SETTINGS_SECTION_LABEL_CLASS_NAME =
  "px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground";

/** Grouped settings card: transparent so it shares the page (chat) surface and reads
 *  as outline-only — just the button border, no fill, no shadow. */
export const SETTINGS_CARD_CLASS_NAME = [
  "overflow-hidden bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
].join(" ");

/** Row padding inside a settings card. */
export const SETTINGS_CARD_ROW_CLASS_NAME = "px-4 py-3.5";

/** Divider between stacked rows inside one card. */
export const SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME = "border-t border-[color:var(--color-border)]";

/** Nested list/table inside a row (provider installs, updates, etc.). */
export const SETTINGS_INSET_LIST_CLASS_NAME = SETTINGS_CARD_CLASS_NAME;

/** Empty / placeholder blocks. */
export const SETTINGS_EMPTY_STATE_CLASS_NAME = [
  "bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
  "border-dashed",
].join(" ");
