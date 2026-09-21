import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "./sidebarRowStyles";
import { SOFT_SURFACE_FILL_CLASS_NAME } from "./surfaceStyles";

export const SETTINGS_RADIUS_CLASS_NAME = "rounded-xl";

/** One step inside {@link SETTINGS_RADIUS_CLASS_NAME}, for anything that sits within a card
 *  (inset lists, rows) or is too small to carry the card radius (chips, drag handles) — a
 *  24px control with the card's 12px radius would read as a circle. */
export const SETTINGS_INSET_RADIUS_CLASS_NAME = "rounded-lg";

/** The inset radius forced over a component's own default (Select triggers, segmented chips,
 *  inputs, menu options all ship a radius of their own). Written as a literal because Tailwind
 *  scans source text for candidates — a template-built `!${...}` class emits no CSS at all. */
export const SETTINGS_CONTROL_RADIUS_CLASS_NAME = "rounded-lg!";

export const SETTINGS_CONTROL_BORDER_CLASS_NAME = "border border-[color:var(--color-border)]";

export const SETTINGS_PAGE_BACKGROUND_CLASS_NAME = "app-settings-surface";

export const SETTINGS_SECTION_LABEL_CLASS_NAME = `px-2 py-1 ${SIDEBAR_SECTION_LABEL_CLASS_NAME}`;

export const SETTINGS_PANEL_SECTION_CLASS_NAME = "flex flex-col gap-1.5 not-first:mt-4";

export const SETTINGS_CARD_CLASS_NAME = [
  "overflow-hidden",
  SOFT_SURFACE_FILL_CLASS_NAME,
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
].join(" ");

export const SETTINGS_CARD_ROW_CLASS_NAME =
  "px-3 py-[var(--app-density-settings-row-padding-y,0.625rem)]";

export const SETTINGS_CARD_ROW_TITLE_CLASS_NAME = "text-ui font-medium text-foreground";

export const SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME = "text-ui text-muted-foreground";

export const SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME = "border-t border-[color:var(--color-border)]";

export const SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME =
  "divide-y divide-[color:var(--color-border)]";

// outline-only: it already sits on a filled card — a second fill would read as a different panel, not the same material
export const SETTINGS_OUTLINED_SURFACE_CLASS_NAME = [
  "bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
].join(" ");

export const SETTINGS_INSET_LIST_CLASS_NAME = `overflow-hidden ${SETTINGS_OUTLINED_SURFACE_CLASS_NAME}`;

export const SETTINGS_EMPTY_STATE_CLASS_NAME = [
  "bg-transparent",
  SETTINGS_CONTROL_BORDER_CLASS_NAME,
  SETTINGS_RADIUS_CLASS_NAME,
  "border-dashed",
].join(" ");
