// FILE: settingsSidebarNavStyles.ts
// Purpose: Settings sidebar navigation layout tokens (section labels, groups).
// Layer: UI styling helper
// Exports: settings-specific section tokens; row tokens re-exported from sidebarRowStyles

import {
  SIDEBAR_HEADER_LABEL_CLASS_NAME,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_MUTED_TEXT_CLASS_NAME,
} from "./sidebarRowStyles";
import { SETTINGS_SECTION_LABEL_CLASS_NAME } from "./settingsPanelStyles";

/** Wrapper for each settings group — break before the next header matches the project list rhythm. */
export const SETTINGS_SIDEBAR_SECTION_CLASS_NAME = "flex flex-col not-first:mt-3";

/** Section labels ("App", "Synara") — shared with the settings content panel. */
export const SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME = SETTINGS_SECTION_LABEL_CLASS_NAME;

/** Nav row — same chrome as project/chat sidebar header rows. */
export const SETTINGS_SIDEBAR_ITEM_CLASS_NAME = SIDEBAR_HEADER_ROW_CLASS_NAME;

export const SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME = SIDEBAR_HEADER_LABEL_CLASS_NAME;

/** Inner glyph size; tone comes from the SidebarLeadingIcon wrapper (same as project rows). */
export const SETTINGS_SIDEBAR_ICON_CLASS_NAME = "size-4";

/** Names the row a hover group so the leading icon can follow the row's text color. */
export const SETTINGS_SIDEBAR_ROW_GROUP_CLASS_NAME = "group/settings-nav-row";

/**
 * Lets the leading icon inherit the row's text color on hover. Pairs with the active state's
 * `tone="text-inherit"` so the glyph matches the label in every interactive state instead of
 * staying muted when the row lights up.
 */
export const SETTINGS_SIDEBAR_ICON_HOVER_TONE_CLASS_NAME =
  "group-hover/settings-nav-row:text-inherit";

export const SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME = [
  SIDEBAR_ROW_MUTED_TEXT_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
].join(" ");

export const SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME = SIDEBAR_ROW_ACTIVE_CLASS_NAME;

export const SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME = SIDEBAR_NESTED_LIST_GAP_CLASS_NAME;
