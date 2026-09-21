import { useEffect, useState, type DragEvent } from "react";
import { type ThreadId } from "@synara/contracts";

import { isComposerDropzoneInternalDragTransition } from "./useComposerDropzone";
import {
  getActiveThreadDragId,
  isThreadDragTransfer,
  readThreadDragPayload,
  THREAD_MENTION_DROPZONE_ATTRIBUTE,
} from "~/lib/threadDrag";

// A chat cannot mention itself, so its own row must not light the composer up.
export function canDropThreadMention(input: {
  readonly disabled: boolean;
  readonly currentThreadId: ThreadId | null;
  readonly draggedThreadId: ThreadId | null;
}): boolean {
  if (input.disabled) return false;
  return input.draggedThreadId === null || input.draggedThreadId !== input.currentThreadId;
}

export function useComposerThreadMentionDrop(input: {
  readonly disabled?: boolean;
  readonly currentThreadId: ThreadId | null;
  readonly onDropThread: (threadId: ThreadId) => void;
}) {
  const { disabled = false, currentThreadId, onDropThread } = input;
  const [isThreadDragOverComposer, setIsThreadDragOverComposer] = useState(false);

  const acceptsDrag = (event: DragEvent<HTMLElement>): boolean =>
    isThreadDragTransfer(event.dataTransfer) &&
    canDropThreadMention({
      disabled,
      currentThreadId,
      draggedThreadId: getActiveThreadDragId(),
    });

  const onDragEnterOrOver = (event: DragEvent<HTMLElement>) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsThreadDragOverComposer(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!isThreadDragTransfer(event.dataTransfer)) return;
    if (isComposerDropzoneInternalDragTransition(event.currentTarget, event.relatedTarget)) {
      return;
    }
    setIsThreadDragOverComposer(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!isThreadDragTransfer(event.dataTransfer)) return;
    setIsThreadDragOverComposer(false);
    const payload = readThreadDragPayload(event.dataTransfer);
    if (
      !payload ||
      !canDropThreadMention({ disabled, currentThreadId, draggedThreadId: payload.threadId })
    ) {
      return;
    }
    event.preventDefault();
    onDropThread(payload.threadId);
  };

  useEffect(() => {
    if (disabled) setIsThreadDragOverComposer(false);
  }, [disabled]);

  return {
    isThreadDragOverComposer,
    threadMentionDropzoneProps: {
      [THREAD_MENTION_DROPZONE_ATTRIBUTE]: "true",
      onDragEnter: onDragEnterOrOver,
      onDragOver: onDragEnterOrOver,
      onDragLeave,
      onDrop,
    },
  };
}
