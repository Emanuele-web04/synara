// FILE: useComposerDropzone.ts
// Purpose: Share composer paste/drop handling for image attachments and file references.
// Layer: Web composer hook
// Exports: useComposerDropzone, isComposerHandledDrag

import { useCallback, useRef, type ClipboardEvent, type DragEvent } from "react";

import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";

export function isComposerHandledDrag(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes("Files") ||
    dataTransfer.types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE)
  );
}

export function useComposerDropzone(input: {
  readonly addImages: (files: readonly File[]) => void;
  readonly appendReferenceText?: ((text: string) => void) | undefined;
  readonly focusComposer?: (() => void) | undefined;
  readonly dragDepthRef?: { current: number } | undefined;
  readonly setIsDragOverComposer: (dragging: boolean) => void;
}) {
  const { addImages, appendReferenceText, focusComposer, setIsDragOverComposer } = input;
  const internalDragDepthRef = useRef(0);
  const dragDepthRef = input.dragDepthRef ?? internalDragDepthRef;

  const resetComposerDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [dragDepthRef, setIsDragOverComposer]);

  const onComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      addImages(imageFiles);
    },
    [addImages],
  );

  const onComposerDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDrag(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOverComposer(true);
    },
    [dragDepthRef, setIsDragOverComposer],
  );

  const onComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragOverComposer(true);
    },
    [setIsDragOverComposer],
  );

  const onComposerDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDrag(event.dataTransfer)) return;
      event.preventDefault();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragOverComposer(false);
      }
    },
    [dragDepthRef, setIsDragOverComposer],
  );

  const onComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDrag(event.dataTransfer)) return;
      event.preventDefault();
      resetComposerDragState();
      const referenceText = event.dataTransfer.getData(CHAT_FILE_REFERENCE_DRAG_TYPE);
      if (referenceText) {
        appendReferenceText?.(referenceText);
        return;
      }
      addImages(Array.from(event.dataTransfer.files));
      focusComposer?.();
    },
    [addImages, appendReferenceText, focusComposer, resetComposerDragState],
  );

  return {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    resetComposerDragState,
  };
}
