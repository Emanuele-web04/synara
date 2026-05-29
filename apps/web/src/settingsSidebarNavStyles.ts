// FILE: settingsSidebarNavStyles.ts
// Purpose: Shared layout tokens for the settings sidebar navigation (section labels, rows, icons).
// Layer: UI styling helper
// Exports: class name constants for settings sidebar nav

/** Subtle row fill — reference uses ~#eee on ~#f9f9f9, not sidebar-accent. */
export const SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME =
  "hover:bg-[color-mix(in_srgb,var(--foreground)_2.5%,transparent)]";

export const SETTINGS_SIDEBAR_ROW_FILL_ACTIVE_CLASS_NAME =
  "bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]";

/** Wrapper for each settings group — generous break before the next header. */
export const SETTINGS_SIDEBAR_SECTION_CLASS_NAME = "flex flex-col not-first:mt-7";

/** Section labels ("App", "DP Code") — light gray, spaced from items below. */
export const SETTINGS_SIDEBAR_SECTION_LABEL_CLASS_NAME =
  "px-2 pb-2 text-[length:var(--app-font-size-ui,11px)] font-normal text-muted-foreground/50";

/** Nav row — compact; radius one step below rounded-lg (reference ~8px). */
export const SETTINGS_SIDEBAR_ITEM_CLASS_NAME =
  "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-0.5 text-[length:var(--app-font-size-ui,12px)] font-normal leading-5 text-foreground/88 outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring/30";

export const SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME = "truncate";

/** Icons inherit row text color (same weight as labels). */
export const SETTINGS_SIDEBAR_ICON_CLASS_NAME = "size-[15px] shrink-0 text-inherit";
