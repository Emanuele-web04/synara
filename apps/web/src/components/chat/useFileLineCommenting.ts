// FILE: useFileLineCommenting.ts
// Purpose: Hover "+" gutter affordance + inline "Local comment" box state and
//          geometry for the read-only file preview, mirroring Codex's per-line
//          comment flow. Tracks the hovered line under the pointer and the line
//          a comment box is currently open against, both in scroll-container
//          content space so absolute overlays stay anchored while scrolling.
// Layer: Chat file-preview interaction controller

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

// A line's geometry in the scroll container's content space (independent of the
// current scroll offset), used to position the absolute "+" button, the blue
// highlight band, and the anchored comment box.
export interface FileLineGeometry {
  lineNumber: number;
  top: number;
  height: number;
  left: number;
  containerWidth: number;
}

interface UseFileLineCommentingOptions {
  enabled: boolean;
  // Closes any open box / clears hover when the previewed file changes, so a
  // stale geometry from the previous file never leaks into the new one.
  resetKey: string | null;
}

export interface UseFileLineCommentingResult {
  hoveredLine: FileLineGeometry | null;
  activeLine: FileLineGeometry | null;
  onContainerMouseMove: (event: ReactMouseEvent<HTMLElement>) => void;
  onContainerMouseLeave: () => void;
  openComment: (line: FileLineGeometry) => void;
  closeComment: () => void;
}

// 1-based line number of a `.line` span: count preceding `.line` siblings rather
// than its child index, so the math holds even if the highlighter emits stray
// non-line element siblings inside <code>.
function lineNumberOf(lineEl: Element): number {
  let count = 1;
  for (let node = lineEl.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.classList.contains("line")) {
      count += 1;
    }
  }
  return count;
}

function measureLine(container: HTMLElement, lineEl: HTMLElement): FileLineGeometry {
  const containerRect = container.getBoundingClientRect();
  const lineRect = lineEl.getBoundingClientRect();
  return {
    lineNumber: lineNumberOf(lineEl),
    top: lineRect.top - containerRect.top + container.scrollTop,
    height: lineRect.height,
    left: lineRect.left - containerRect.left + container.scrollLeft,
    containerWidth: container.clientWidth,
  };
}

export function useFileLineCommenting(
  options: UseFileLineCommentingOptions,
): UseFileLineCommentingResult {
  const { enabled, resetKey } = options;
  const [lineState, setLineState] = useState<{
    enabled: boolean;
    resetKey: string | null;
    hoveredLine: FileLineGeometry | null;
    activeLine: FileLineGeometry | null;
  }>(() => ({ enabled, resetKey, hoveredLine: null, activeLine: null }));
  const scopeIsCurrent = lineState.enabled === enabled && lineState.resetKey === resetKey;
  if (!scopeIsCurrent) {
    // Reset before committing the new file/mode. Hiding state behind a key would
    // let A→B→A or Source→Markdown→Source revive the old overlay later.
    setLineState({ enabled, resetKey, hoveredLine: null, activeLine: null });
  }
  const hoveredLine = scopeIsCurrent && enabled ? lineState.hoveredLine : null;
  const activeLine = scopeIsCurrent && enabled ? lineState.activeLine : null;
  const setHoveredLine = (line: FileLineGeometry | null) =>
    setLineState((current) => ({ ...current, hoveredLine: line }));
  const setActiveLine = (line: FileLineGeometry | null) =>
    setLineState((current) => ({ ...current, activeLine: line }));
  // The element behind the current hover (deduped so a mousemove that stays on
  // the same line never triggers a re-render) and whether a box is open (read
  // synchronously from the move handler without it depending on render state).
  const hoveredElRef = useRef<Element | null>(null);
  const isActiveRef = useRef(false);

  const clearHover = () => {
    hoveredElRef.current = null;
    setHoveredLine(null);
  };

  const onContainerMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    // Suppress the affordance while disabled, while a box is open, and while a
    // button is held (a drag-selection): the gutter "+" must not flicker as
    // the user sweeps a text selection.
    if (!enabled || isActiveRef.current || event.buttons !== 0) {
      return;
    }
    const container = event.currentTarget;
    const target = event.target instanceof Element ? event.target : null;
    // The floating "+" is positioned on top of the gutter of the very line it
    // belongs to. Without this guard, moving the pointer onto it resolves to
    // "no line" (the button is not inside a `.line`), tears the button down,
    // re-exposes the line underneath, re-shows the button, and flickers in a
    // tight mount/unmount loop — a re-render storm felt as lag. The button is
    // only ever rendered for the already-hovered line, so a hover on it is a
    // hover on that line: keep the current state untouched.
    if (target?.closest(".editor-file-viewer__comment-add")) {
      return;
    }
    const lineEl = target ? target.closest<HTMLElement>(".line") : null;
    if (!lineEl || !container.contains(lineEl)) {
      if (hoveredElRef.current) {
        clearHover();
      }
      return;
    }
    if (lineEl === hoveredElRef.current) {
      return;
    }
    hoveredElRef.current = lineEl;
    setHoveredLine(measureLine(container, lineEl));
  };

  const onContainerMouseLeave = () => {
    if (hoveredElRef.current) {
      clearHover();
    }
  };

  const openComment = (line: FileLineGeometry) => {
    isActiveRef.current = true;
    setActiveLine(line);
    clearHover();
  };

  const closeComment = () => {
    isActiveRef.current = false;
    setActiveLine(null);
  };

  // Keep the synchronous event-handler mirrors aligned with the state reset above.
  useEffect(() => {
    if (enabled) {
      return;
    }
    isActiveRef.current = false;
    hoveredElRef.current = null;
  }, [enabled]);

  useEffect(() => {
    isActiveRef.current = false;
    hoveredElRef.current = null;
  }, [resetKey]);

  return {
    hoveredLine,
    activeLine,
    onContainerMouseMove,
    onContainerMouseLeave,
    openComment,
    closeComment,
  };
}
