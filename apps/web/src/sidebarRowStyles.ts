// FILE: sidebarRowStyles.ts
// Purpose: Shared layout and interaction tokens for sidebar header/thread rows.
// Layer: Sidebar UI styling
// Exports: row dimension, radius, hover/active, header + thread row class names

import { hoverRevealHideClassName, type HoverRevealGroup } from "./rowHoverReveal";

/** Compact sidebar row height shared by projects, threads, chats, and settings nav. */
export const SIDEBAR_ROW_HEIGHT_CLASS_NAME =
  "min-h-[var(--app-density-row-height,1.75rem)] h-[var(--app-density-row-height,1.75rem)]";

export const SIDEBAR_ROW_RADIUS_CLASS_NAME = "rounded-md";

export const SIDEBAR_ROW_PADDING_CLASS_NAME = "px-2 py-[var(--app-density-row-padding-y,0.125rem)]";

export const SIDEBAR_ROW_GAP_CLASS_NAME = "gap-[var(--app-density-row-gap,0.5rem)]";

export const SIDEBAR_ROW_TEXT_CLASS_NAME = "text-ui font-normal";

export const SIDEBAR_ROW_FOCUS_CLASS_NAME =
  "outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export const SIDEBAR_ROW_HOVER_CLASS_NAME =
  "hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)]";

export const SIDEBAR_ROW_ACTIVE_CLASS_NAME =
  "bg-[var(--sidebar-selected)] text-[var(--sidebar-accent-foreground)] hover:bg-[var(--sidebar-selected)] hover:text-[var(--sidebar-accent-foreground)]";

export const SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME = "text-foreground/89";

/** A chat back from snooze and not yet opened: outlined so it stands out until read. */
export const SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME = "bg-info/8 ring-1 ring-info/50 ring-inset";

/**
 * Resting foreground for primary sidebar item labels and their accompanying
 * leading/pin icons (inactive thread name, project/folder name, folder + pin
 * glyphs). Sits just below the full-foreground active row so resting items read
 * clearly without competing with the selected thread.
 */
export const SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME = "text-foreground/95";

/** A project's display name in sidebar project rows and headers. */
export const SIDEBAR_PROJECT_NAME_CLASS_NAME = [
  "min-w-0 flex-1 truncate font-system-ui text-ui font-normal",
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
].join(" ");

/**
 * A control that takes over a header row's leading glyph slot (the project pin, a hub's
 * thread disclosure). Pair it with `sidebarHoverRevealHideClassName("project-header")` on
 * the resting glyph so the two swap in place.
 */
export const SIDEBAR_HEADER_LEADING_ACTION_CLASS_NAME =
  "sidebar-icon-button absolute left-2 top-1/2 z-20 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm transition-opacity hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

/** Keeps a leading-slot action hidden until its `group/project-header` row is hovered or focused. */
export const SIDEBAR_HEADER_LEADING_ACTION_REVEAL_CLASS_NAME =
  "pointer-events-none opacity-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:project-header-focus:pointer-events-auto md:project-header-focus:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100";

/** Section label ("Threads"/"Pinned" and settings "App"/"Synara"). */
/** Soft grey of section labels ("Projects", "Chats"); also the rail's resting glyph tone. */
export const SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME = "text-muted-foreground/58";

export const SIDEBAR_SECTION_LABEL_CLASS_NAME = `text-ui font-normal ${SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME}`;

/** Project/chat/settings header rows and settings sidebar nav items. */
export const SIDEBAR_HEADER_ROW_CLASS_NAME = [
  "flex w-full min-w-0 cursor-pointer items-center text-left select-none",
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_GAP_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  SIDEBAR_ROW_PADDING_CLASS_NAME,
  SIDEBAR_ROW_TEXT_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
].join(" ");

/** Thread rows nested under a project. */
export const SIDEBAR_THREAD_ROW_BASE_CLASS_NAME = [
  "w-full translate-x-0 cursor-pointer justify-start text-left select-none",
  SIDEBAR_ROW_HEIGHT_CLASS_NAME,
  SIDEBAR_ROW_RADIUS_CLASS_NAME,
  "pl-8 text-ui-lg",
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
].join(" ");

/** Left padding of a thread row (`pl-8` above), where its provider glyph starts. */
export const SIDEBAR_THREAD_ROW_PADDING_PX = 32;

/** Centres an absolutely placed control on a thread row's first line, at any row height. */
export const SIDEBAR_THREAD_ROW_FIRST_LINE_CENTER_CLASS_NAME =
  "top-[calc(var(--app-density-row-height,1.75rem)/2)]";

/** A parent's stem: one hairline hung from the glyph centre, never covering row content. */
export const SIDEBAR_CHILD_STEM_CLASS_NAME =
  "pointer-events-none absolute z-10 border-foreground/14";

/** Width of the child-count chip (`SidebarChildThreadsChip`) at one digit. */
export const SIDEBAR_CHILD_CHIP_WIDTH_PX = 18;

/** Gap between the child-count chip and the provider glyph it precedes. */
export const SIDEBAR_CHILD_CHIP_GAP_PX = 4;

/** Indent per level for agent-created child threads, under the parent's title. */
export const SIDEBAR_CHILD_INDENT_PX = 24;

/** Centre of a thread row's leading glyph from the row's content edge; stems hang from here. */
export const SIDEBAR_THREAD_GLYPH_CENTER_PX = 6;

/** Spacing between a header row and its nested thread list, and between thread rows. */
export const SIDEBAR_NESTED_LIST_GAP_CLASS_NAME = "gap-0.5";

export const SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME = "pt-0.5";

/** Sidebar row groups whose resting status fades to yield its slot to a hover toolbar. */
export type SidebarHoverRevealGroup = Exclude<HoverRevealGroup, "picker-row">;

/**
 * Fade a resting glyph out the moment its row reveals the hover action toolbar. A project
 * header (folder icon + run-status dot) and a thread row (meta chips, timestamp/status
 * slot, jump hint) both follow the shared rule in `rowHoverReveal.ts`; project headers
 * reveal on keyboard `focus-visible`, thread rows on any `focus-within`.
 */
export function sidebarHoverRevealHideClassName(group: SidebarHoverRevealGroup): string {
  return hoverRevealHideClassName(group);
}

export const SIDEBAR_HEADER_LABEL_CLASS_NAME = "truncate";
