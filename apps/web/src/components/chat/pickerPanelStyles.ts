// FILE: pickerPanelStyles.ts
// Purpose: Class tokens for the dense ("plain") PickerPanelShell variant — the borderless
//          search row, thin option rows, quiet group labels, and footer action rows.
// Layer: Chat picker UI styling helper
// Depends on: radius / scroll tokens from composerPickerStyles, hover token from surfaceStyles.
//
// Kept separate from composerPickerStyles.ts on purpose: those tokens describe the composer's
// own popup chrome, while these describe the panel *inside* a picker popup (search + rows), so
// any picker panel can opt into the same density without pulling in composer chrome.

import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import {
  COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
  COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME,
} from "./composerPickerStyles";

/**
 * Search row of a plain picker panel: no field chrome at all — a leading magnifier, the
 * transparent input, and a single hairline separating it from the list below.
 */
export const PICKER_PANEL_PLAIN_SEARCH_HEADER_CLASS_NAME =
  "sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-border bg-transparent px-2.5 py-0 *:min-w-0";

/** Leading magnifier in the plain search row. */
export const PICKER_PANEL_PLAIN_SEARCH_ICON_CLASS_NAME =
  "size-3.5 shrink-0 text-muted-foreground/55";

/**
 * Transparent, borderless search field for the plain search row. Pair with the `unstyled`
 * Input prop so no border/ring/fill is emitted; the child selector strips the field's own
 * horizontal padding because the magnifier already owns the left gutter.
 */
export const PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME =
  "flex min-h-8 w-full items-center bg-transparent shadow-none [&>[data-slot=input]]:px-0 [&>[data-slot=input]]:placeholder:text-muted-foreground/55";

/** Row height, padding, gap, and radius shared by plain option rows and footer action rows. */
export const PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME = `min-h-7 gap-2 px-1.5 py-0.5 sm:min-h-7 ${COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME}`;

/** Leading icon (folder, plus, dismiss) inside a plain picker row. */
export const PICKER_PANEL_ROW_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground/70";

/** Subtle fill marking the currently selected option row. */
export const PICKER_PANEL_ROW_SELECTED_CLASS_NAME =
  "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]";

/** Quiet section header above a plain picker list group. */
export const PICKER_PANEL_GROUP_LABEL_CLASS_NAME =
  "px-1.5 py-1 font-normal text-muted-foreground/60 text-[length:var(--app-font-size-ui-xs,10px)]";

/** Footer actions share the app UI size used by ComboboxItem (add project, reset to home). */
export const PICKER_PANEL_ACTION_ROW_CLASS_NAME = `flex w-full items-center text-left text-[length:var(--app-font-size-ui,12px)] ${PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME} ${ELEVATED_HOVER_SURFACE_CLASS_NAME} hover:text-[var(--color-text-foreground)]`;

/** Scroll chrome for the plain panel body; list chrome supplies its own 4px padding. */
export const PICKER_PANEL_PLAIN_BODY_CLASS_NAME = COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME;
