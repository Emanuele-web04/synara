// FILE: threadDrag.ts
// Purpose: Shared native drag contract for dragging a thread row (sidebar, activity view) onto chat surfaces.
// Layer: Web UI helpers
// Exports: THREAD_DRAG_MIME, ThreadDragPayload, beginThreadDrag, endThreadDrag, getActiveThreadDragId, isThreadDragTransfer, readThreadDragPayload, THREAD_MENTION_DROPZONE_ATTRIBUTE, isWithinThreadMentionDropzone, resolveSidebarFolderDropTarget, SIDEBAR_FOLDER_ROOT_GUTTER_PX

import { type ThreadId } from "@synara/contracts";

// Custom MIME so external file drops on the composer (which listen for `Files`) cannot trigger us.
export const THREAD_DRAG_MIME = "application/x-synara-thread";

// Marks the composer region where a thread drop becomes an @mention instead of a split.
export const THREAD_MENTION_DROPZONE_ATTRIBUTE = "data-thread-mention-dropzone";

export interface ThreadDragPayload {
  threadId: ThreadId;
}

// Browsers hide drag data until `drop`, so hover feedback that depends on which
// thread is being dragged reads it from here instead.
let activeThreadDragId: ThreadId | null = null;

export function getActiveThreadDragId(): ThreadId | null {
  return activeThreadDragId;
}

export function endThreadDrag(): void {
  activeThreadDragId = null;
}

export function beginThreadDrag(
  event: {
    readonly dataTransfer: DataTransfer;
    readonly currentTarget: EventTarget | null;
    readonly clientX: number;
    readonly clientY: number;
  },
  threadId: ThreadId,
): void {
  activeThreadDragId = threadId;
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(THREAD_DRAG_MIME, JSON.stringify({ threadId }));
  const dragImage = event.currentTarget;
  if (dragImage instanceof HTMLElement) {
    const rect = dragImage.getBoundingClientRect();
    event.dataTransfer.setDragImage(
      dragImage,
      Math.max(0, event.clientX - rect.left),
      Math.max(0, event.clientY - rect.top),
    );
  }
}

export function isThreadDragTransfer(dataTransfer: Pick<DataTransfer, "types">): boolean {
  const types = dataTransfer.types;
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === THREAD_DRAG_MIME) return true;
  }
  return false;
}

export function readThreadDragPayload(
  dataTransfer: Pick<DataTransfer, "getData">,
): ThreadDragPayload | null {
  try {
    const raw = dataTransfer.getData(THREAD_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThreadDragPayload>;
    if (typeof parsed.threadId === "string" && parsed.threadId.length > 0) {
      return { threadId: parsed.threadId as ThreadId };
    }
  } catch {
    return null;
  }
  return null;
}

export function isWithinThreadMentionDropzone(target: unknown): boolean {
  if (typeof Node === "undefined" || !(target instanceof Node)) return false;
  // Drag events can target a text node inside the editor.
  const element = target instanceof Element ? target : target.parentElement;
  if (!element) return false;
  return element.closest(`[${THREAD_MENTION_DROPZONE_ATTRIBUTE}="true"]`) !== null;
}

// Dropping a thread inside the project row's leading gutter means "move to the
// project root"; past the gutter the pointer is over a folder row.
export const SIDEBAR_FOLDER_ROOT_GUTTER_PX = 20;

export function resolveSidebarFolderDropTarget(input: {
  clientX: number;
  containerLeft: number;
  folderId: string;
}): string | null {
  return input.clientX <= input.containerLeft + SIDEBAR_FOLDER_ROOT_GUTTER_PX
    ? null
    : input.folderId;
}
