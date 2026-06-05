// FILE: settingsPanelStyles.ts
// Purpose: Shared layout tokens for the settings content panel (page bg, bordered cards, rows).
// Layer: Settings UI styling
// Exports: border, surface, card, row, and inset list class names

import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "./sidebarRowStyles";

/** Shared corner radius for settings cards and dropdown panels. */
export const SETTINGS_RADIUS_CLASS_NAME = "rounded-lg";

/** Select triggers, segmented chips, inputs, and menu options (one step above app defaults). */
export const SETTINGS_CONTROL_RADIUS_CLASS_NAME = "!rounded-lg";

/** Same border token as Button `outline` / `chrome-outline` variants. */
export const SETTINGS_CONTROL_BORDER_CLASS_NAME = "border border-[color:var(--color-border)]";

/** Main settings shell — opaque and matched to the chat surface (see `--app-settings-surface`),
 *  so cards/rows read as outline-only on the same background as the chat. */
export const SETTINGS_PAGE_BACKGROUND_CLASS_NAME = "app-settings-surface";

/** Section label above a settings card — same tone as sidebar "Threads"/"Pinned". */
export const SETTINGS_SECTION_LABEL_CLASS_NAME = `px-2 py-1 ${SIDEBAR_SECTION_LABEL_CLASS_NAME}`;

/** Vertical rhythm between stacked settings groups in the content panel. */
export const SETTINGS_PANEL_SECTION_CLASS_NAME = "flex flex-col gap-1.5 not-first:mt-4";

/** Grouped settings card: transparent so it shares the page (chat) surface and reads
 *  as outline-only — just the button border, no fill, no shadow. */
export const SETTINGS_CARD_CLASS_NAME = [
  "overflow-hidden bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
].join(" ");

/** Row padding inside a settings card. */
export const SETTINGS_CARD_ROW_CLASS_NAME = "px-3 py-2.5";

/** Row title — same UI font/size as the description; weight and color differ. */
export const SETTINGS_CARD_ROW_TITLE_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground";

/** Row description — standard app UI typography. */
export const SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] text-muted-foreground";

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
