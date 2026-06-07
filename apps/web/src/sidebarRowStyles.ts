// FILE: sidebarRowStyles.ts
// Purpose: Shared layout and interaction tokens for sidebar header/thread rows.
// Layer: Sidebar UI styling
// Exports: row dimension, radius, hover/active, header + thread row class names

/** Compact sidebar row height shared by projects, threads, chats, and settings nav. */
export const SIDEBAR_ROW_HEIGHT_CLASS_NAME = "h-7";

export const SIDEBAR_ROW_RADIUS_CLASS_NAME = "rounded-md";

export const SIDEBAR_ROW_PADDING_CLASS_NAME = "px-2 py-0.5";

export const SIDEBAR_ROW_GAP_CLASS_NAME = "gap-2";

export const SIDEBAR_ROW_TEXT_CLASS_NAME = "text-[length:var(--app-font-size-ui,12px)] font-normal";

export const SIDEBAR_ROW_FOCUS_CLASS_NAME =
  "outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export const SIDEBAR_ROW_HOVER_CLASS_NAME =
  "hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-accent-foreground)]";

export const SIDEBAR_ROW_ACTIVE_CLASS_NAME =
  "bg-[var(--sidebar-accent-active)] text-[var(--sidebar-accent-foreground)] hover:bg-[var(--sidebar-accent-active)] hover:text-[var(--sidebar-accent-foreground)]";

export const SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME = "text-foreground/89";

/** Dimmer idle label color shared by project header rows, thread rows, and settings nav rows. */
export const SIDEBAR_ROW_MUTED_TEXT_CLASS_NAME = "text-muted-foreground/79";

/** Section label ("Threads"/"Pinned"/"Workspace" and settings "App"/"Synara"). */
export const SIDEBAR_SECTION_LABEL_CLASS_NAME =
  "text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/58";

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
  "pl-8 text-[13px]",
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
].join(" ");

/** Spacing between a header row and its nested thread list, and between thread rows. */
export const SIDEBAR_NESTED_LIST_GAP_CLASS_NAME = "gap-0.5";

export const SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME = "pt-0.5";

export const SIDEBAR_HEADER_ICON_CLASS_NAME = "size-4 shrink-0 text-inherit";

export const SIDEBAR_HEADER_LABEL_CLASS_NAME = "truncate";
