// FILE: settingsSidebarNavStyles.ts
// Purpose: Settings sidebar navigation layout tokens (section labels, groups).
// Layer: UI styling helper
// Exports: settings-specific section tokens; row tokens re-exported from sidebarRowStyles

import {
  SIDEBAR_HEADER_ICON_CLASS_NAME,
  SIDEBAR_HEADER_LABEL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "./sidebarRowStyles";

/** Wrapper for each settings group — generous break before the next header. */
export const SETTINGS_SIDEBAR_SECTION_CLASS_NAME = "flex flex-col not-first:mt-7";

/** Section labels ("App", "DP Code") — light gray, spaced from items below. */
export const SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME =
  "px-2 pb-2 text-[length:var(--app-font-size-ui,11px)] font-normal text-muted-foreground/50";

/** Nav row — same chrome as project/chat sidebar header rows. */
export const SETTINGS_SIDEBAR_ITEM_CLASS_NAME = SIDEBAR_HEADER_ROW_CLASS_NAME;

export const SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME = SIDEBAR_HEADER_LABEL_CLASS_NAME;

export const SETTINGS_SIDEBAR_ICON_CLASS_NAME = SIDEBAR_HEADER_ICON_CLASS_NAME;

export const SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME = [
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
].join(" ");

export const SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME = SIDEBAR_ROW_ACTIVE_CLASS_NAME;

export const SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME = SIDEBAR_NESTED_LIST_GAP_CLASS_NAME;
