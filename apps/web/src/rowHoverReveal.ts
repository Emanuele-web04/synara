// FILE: rowHoverReveal.ts
// Purpose: One rule for rows whose trailing hover actions replace resting content.
// Layer: UI styling tokens
// Exports: HoverRevealGroup, HoverActionsGroup, hoverRevealShowClassName, hoverRevealHideClassName

/**
 * Row groups with a hover action strip. Each needs an ancestor carrying the matching
 * `group/<row>` marker. Sidebar rows reveal on pointer hover and focus; menu rows
 * (`picker-row`) reveal while Base UI highlights them, which covers pointer and keyboard.
 */
export type HoverRevealGroup = "activity-row" | "project-header" | "thread-row" | "picker-row";

/** Groups that render a trailing action strip through `RowHoverActions`. */
export type HoverActionsGroup = Extract<HoverRevealGroup, "thread-row" | "picker-row">;

/*
 * Tailwind only emits utilities it can read as complete literals, so each group's classes
 * are spelled out in full rather than interpolating the `group/<row>` token. Keep a group's
 * show and hide rules on the same signals so the actions replace the resting content.
 */
const HOVER_REVEAL_SHOW_CLASS_NAME: Record<HoverActionsGroup, string> = {
  "thread-row":
    "pointer-events-none opacity-0 transition-opacity group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100",
  "picker-row":
    "pointer-events-none opacity-0 transition-opacity group-data-highlighted/picker-row:pointer-events-auto group-data-highlighted/picker-row:opacity-100",
};

/**
 * Fade a resting element out the moment its row reveals the hover actions, so the actions
 * replace it instead of stacking on top. The faded element also drops pointer events so it
 * never intercepts clicks meant for the revealed strip.
 *
 * Apply this to a *static* element. If the element animates its own `opacity` (e.g.
 * `animate-pulse`), the running animation overrides this `opacity-0`; put the class on a
 * wrapper instead so the parent's collapsed opacity hides the subtree.
 */
const HOVER_REVEAL_HIDE_CLASS_NAME: Record<HoverRevealGroup, string> = {
  "activity-row":
    "transition-opacity group-hover/activity-row:pointer-events-none group-hover/activity-row:opacity-0 group-focus-within/activity-row:pointer-events-none group-focus-within/activity-row:opacity-0",
  "project-header":
    "transition-opacity group-hover/project-header:pointer-events-none group-hover/project-header:opacity-0 project-header-focus:pointer-events-none project-header-focus:opacity-0",
  "thread-row":
    "transition-opacity group-hover/thread-row:pointer-events-none group-hover/thread-row:opacity-0 group-focus-within/thread-row:pointer-events-none group-focus-within/thread-row:opacity-0",
  "picker-row":
    "transition-opacity group-data-highlighted/picker-row:pointer-events-none group-data-highlighted/picker-row:opacity-0",
};

export function hoverRevealShowClassName(group: HoverActionsGroup): string {
  return HOVER_REVEAL_SHOW_CLASS_NAME[group];
}

export function hoverRevealHideClassName(group: HoverRevealGroup): string {
  return HOVER_REVEAL_HIDE_CLASS_NAME[group];
}
