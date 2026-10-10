// FILE: threadContextMenu.ts
// Purpose: Lets a surface outside the sidebar (the open-thread tabs) open the sidebar's own
//          thread context menu, optionally with rows of its own.
// Layer: web UI utility
// Exports: registerThreadContextMenu, showThreadContextMenu, ThreadContextMenuOptions
// Why: A thread has one menu wherever it is right-clicked. Its actions (rename, pin, handoff,
//      fork, archive, delete) live in the sidebar, which is mounted next to every chat, so
//      other surfaces call into it instead of rebuilding the menu.

import type { ContextMenuItem, ThreadId } from "@synara/contracts";

export interface ThreadContextMenuOptions {
  /** Rows the calling surface adds to the thread's menu, such as a tab's close actions. */
  extraItems?: readonly ContextMenuItem[] | undefined;
  /** Runs when one of {@link extraItems} (or one of their submenu rows) is chosen. */
  onExtraAction?: ((itemId: string) => Promise<void> | void) | undefined;
}

type ThreadContextMenuHandler = (
  threadId: ThreadId,
  position: { x: number; y: number },
  options?: ThreadContextMenuOptions,
) => Promise<void>;

let activeThreadContextMenuHandler: ThreadContextMenuHandler | null = null;

export function registerThreadContextMenu(handler: ThreadContextMenuHandler): () => void {
  activeThreadContextMenuHandler = handler;
  return () => {
    if (activeThreadContextMenuHandler === handler) {
      activeThreadContextMenuHandler = null;
    }
  };
}

/**
 * Opens the thread's menu at `position`. Returns false when no sidebar is mounted to show
 * it (a phone with the sidebar sheet closed), so the caller can fall back to its own rows.
 */
export function showThreadContextMenu(
  threadId: ThreadId,
  position: { x: number; y: number },
  options?: ThreadContextMenuOptions,
): boolean {
  if (!activeThreadContextMenuHandler) {
    return false;
  }
  void activeThreadContextMenuHandler(threadId, position, options);
  return true;
}
