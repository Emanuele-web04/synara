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

export interface ComposerDropzoneFileSplit {
  readonly imageFiles: File[];
  readonly genericFiles: File[];
}

export function splitComposerDropzoneFiles(files: Iterable<File>): ComposerDropzoneFileSplit {
  const imageFiles: File[] = [];
  const genericFiles: File[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
    } else {
      genericFiles.push(file);
    }
  }
  return { imageFiles, genericFiles };
}

export type ComposerDropzoneGenericFileMode = "accept" | "reject" | "fallthrough";

export function shouldHandleComposerDropzoneFiles(
  files: ComposerDropzoneFileSplit,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  if (files.imageFiles.length > 0) {
    return true;
  }
  if (files.genericFiles.length > 0) {
    return genericFiles !== "fallthrough";
  }
  return false;
}

export function shouldResetComposerDropzoneAfterUnhandledFileDrop(
  files: ComposerDropzoneFileSplit,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  return !shouldHandleComposerDropzoneFiles(files, genericFiles);
}

export function shouldPreventDefaultForUnhandledFileDrop(
  files: ComposerDropzoneFileSplit,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  return (
    shouldResetComposerDropzoneAfterUnhandledFileDrop(files, genericFiles) &&
    genericFiles !== "fallthrough"
  );
}

function isComposerHandledDragForMode(
  dataTransfer: DataTransfer,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  if (dataTransfer.types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE)) {
    return true;
  }
  if (!dataTransfer.types.includes("Files")) {
    return false;
  }
  if (genericFiles !== "fallthrough") {
    return true;
  }
  const items = Array.from(dataTransfer.items);
  if (items.length === 0) {
    return true;
  }
  return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

export function useComposerDropzone(input: {
  readonly addImages: (files: readonly File[]) => void;
  readonly fileSupport:
    | {
        readonly genericFiles: "accept";
        readonly addFiles: (files: readonly File[]) => void;
      }
    | {
        readonly genericFiles: "reject";
        readonly onUnsupportedFiles: (files: readonly File[]) => void;
      }
    | {
        readonly genericFiles: "fallthrough";
      };
  readonly appendReferenceText?: ((text: string) => void) | undefined;
  readonly focusComposer?: (() => void) | undefined;
  readonly dragDepthRef?: { current: number } | undefined;
  readonly setIsDragOverComposer: (dragging: boolean) => void;
}) {
  const { addImages, fileSupport, appendReferenceText, focusComposer, setIsDragOverComposer } =
    input;
  const internalDragDepthRef = useRef(0);
  const dragDepthRef = input.dragDepthRef ?? internalDragDepthRef;

  const handleSplitFiles = useCallback(
    (files: ComposerDropzoneFileSplit): boolean => {
      if (!shouldHandleComposerDropzoneFiles(files, fileSupport.genericFiles)) {
        return false;
      }
      if (files.imageFiles.length > 0) {
        addImages(files.imageFiles);
      }
      if (files.genericFiles.length > 0) {
        if (fileSupport.genericFiles === "accept") {
          fileSupport.addFiles(files.genericFiles);
        } else if (fileSupport.genericFiles === "reject") {
          fileSupport.onUnsupportedFiles(files.genericFiles);
        }
      }
      return true;
    },
    [addImages, fileSupport],
  );

  const resetComposerDragState = useCallback(() => {
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [dragDepthRef, setIsDragOverComposer]);

  const onComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const handled = handleSplitFiles(splitComposerDropzoneFiles(event.clipboardData.files));
      if (handled) event.preventDefault();
    },
    [handleSplitFiles],
  );

  const onComposerDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDragForMode(event.dataTransfer, fileSupport.genericFiles)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragOverComposer(true);
    },
    [dragDepthRef, fileSupport.genericFiles, setIsDragOverComposer],
  );

  const onComposerDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDragForMode(event.dataTransfer, fileSupport.genericFiles)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragOverComposer(true);
    },
    [fileSupport.genericFiles, setIsDragOverComposer],
  );

  const onComposerDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!isComposerHandledDragForMode(event.dataTransfer, fileSupport.genericFiles)) return;
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
    [dragDepthRef, fileSupport.genericFiles, setIsDragOverComposer],
  );

  const onComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const referenceText = event.dataTransfer.getData(CHAT_FILE_REFERENCE_DRAG_TYPE);
      if (referenceText) {
        event.preventDefault();
        resetComposerDragState();
        appendReferenceText?.(referenceText);
        return;
      }
      if (!event.dataTransfer.types.includes("Files")) {
        return;
      }
      const splitFiles = splitComposerDropzoneFiles(event.dataTransfer.files);
      if (shouldResetComposerDropzoneAfterUnhandledFileDrop(splitFiles, fileSupport.genericFiles)) {
        if (shouldPreventDefaultForUnhandledFileDrop(splitFiles, fileSupport.genericFiles)) {
          event.preventDefault();
        }
        resetComposerDragState();
        return;
      }
      event.preventDefault();
      resetComposerDragState();
      handleSplitFiles(splitFiles);
      focusComposer?.();
    },
    [
      appendReferenceText,
      fileSupport.genericFiles,
      focusComposer,
      handleSplitFiles,
      resetComposerDragState,
    ],
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
