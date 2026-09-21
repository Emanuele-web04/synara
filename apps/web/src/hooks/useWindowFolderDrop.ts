// a stray drop outside a small zone would vanish silently — listeners bind on `window` in the capture phase

import { useEffect, useRef, useState } from "react";

import { isFileDrag, resolveDroppedFolder } from "../lib/folderDrop";

export function useWindowFolderDrop(options: {
  readonly enabled: boolean;
  readonly onFolder: (path: string) => void;
  readonly onError: (message: string) => void;
}): boolean {
  const [isDropTarget, setIsDropTarget] = useState(false);
  const onFolderRef = useRef(options.onFolder);
  const onErrorRef = useRef(options.onError);
  onFolderRef.current = options.onFolder;
  onErrorRef.current = options.onError;

  useEffect(() => {
    if (!options.enabled) return;
    let dragDepth = 0;
    const handleDragEnter = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth += 1;
      setIsDropTarget(true);
    };
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const handleDragLeave = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDropTarget(false);
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      setIsDropTarget(false);
      const dropped = event.dataTransfer ? resolveDroppedFolder(event.dataTransfer) : null;
      if (!dropped) return;
      if ("error" in dropped) {
        onErrorRef.current(dropped.error);
        return;
      }
      onFolderRef.current(dropped.path);
    };
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      setIsDropTarget(false);
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", handleDrop, true);
    };
  }, [options.enabled]);

  return isDropTarget;
}
