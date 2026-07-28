// FILE: settingsPanelStyles.ts
// Purpose: Shared layout tokens for the settings content panel (page bg, bordered cards, rows).
// Layer: Settings UI styling
// Exports: border, surface, card, row, and inset list class names

import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "./sidebarRowStyles";
import { SOFT_SURFACE_FILL_CLASS_NAME } from "./surfaceStyles";

/** Corner radius for top-level settings boxes: cards, empty states, dropdown panels. */
export const SETTINGS_RADIUS_CLASS_NAME = "rounded-xl";

/** One step inside {@link SETTINGS_RADIUS_CLASS_NAME}, for anything that sits within a card
 *  (inset lists, rows) or is too small to carry the card radius (chips, drag handles) — a
 *  24px control with the card's 12px radius would read as a circle. */
export const SETTINGS_INSET_RADIUS_CLASS_NAME = "rounded-lg";

/** The inset radius forced over a component's own default (Select triggers, segmented chips,
 *  inputs, menu options all ship a radius of their own). */
export const SETTINGS_CONTROL_RADIUS_CLASS_NAME = `!${SETTINGS_INSET_RADIUS_CLASS_NAME}`;

/** Same border token as Button `outline` / `chrome-outline` variants. */
export const SETTINGS_CONTROL_BORDER_CLASS_NAME = "border border-[color:var(--color-border)]";

/** Main settings shell — opaque and matched to the chat surface (see `--app-settings-surface`),
 *  so cards/rows read as outline-only on the same background as the chat. */
export const SETTINGS_PAGE_BACKGROUND_CLASS_NAME = "app-settings-surface";

/** Section label above a settings card — same tone as sidebar "Threads"/"Pinned". */
export const SETTINGS_SECTION_LABEL_CLASS_NAME = `px-2 py-1 ${SIDEBAR_SECTION_LABEL_CLASS_NAME}`;

/** Vertical rhythm between stacked settings groups in the content panel. */
export const SETTINGS_PANEL_SECTION_CLASS_NAME = "flex flex-col gap-1.5 not-first:mt-4";

/** Grouped settings card: the same faint fill as a `soft` input (the settings search
 *  field), so cards read as one material lifted just off the page surface. */
export const SETTINGS_CARD_CLASS_NAME = [
  "overflow-hidden",
  SOFT_SURFACE_FILL_CLASS_NAME,
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
].join(" ");

/** Row padding inside a settings card. */
export const SETTINGS_CARD_ROW_CLASS_NAME =
  "px-3 py-[var(--app-density-settings-row-padding-y,0.625rem)]";

/** Row title — same UI font/size as the description; weight and color differ. */
export const SETTINGS_CARD_ROW_TITLE_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground";

/** Row description — standard app UI typography. */
export const SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] text-muted-foreground";

/** Divider between stacked rows inside one card. */
export const SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME = "border-t border-[color:var(--color-border)]";

/** Hairlines between the stacked children of a card or inset list. Applied by
 *  {@link SETTINGS_CARD_CLASS_NAME} consumers (`SettingsCard`) and by any surface that
 *  stacks rows itself, so every settings group separates its rows the same way. */
export const SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME =
  "divide-y divide-[color:var(--color-border)]";

/** Outlined block nested inside a settings group (a reorderable row, a bordered panel).
 *  Outline-only: it already sits on a filled card, and stacking a second fill would read as
 *  a darker/lighter panel instead of the same material. */
export const SETTINGS_OUTLINED_SURFACE_CLASS_NAME = [
  "bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
].join(" ");

/** Nested list/table inside a row (provider installs, updates, etc.) — an outlined surface
 *  that clips its stacked children so their corners follow the list's. */
export const SETTINGS_INSET_LIST_CLASS_NAME = `overflow-hidden ${SETTINGS_OUTLINED_SURFACE_CLASS_NAME}`;

/** Empty / placeholder blocks. */
export const SETTINGS_EMPTY_STATE_CLASS_NAME = [
  "bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
  "border-dashed",
].join(" ");
