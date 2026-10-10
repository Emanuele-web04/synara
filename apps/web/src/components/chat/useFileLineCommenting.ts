import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

// line geometry in scroll-container content space (independent of scroll offset), used to position the "+", highlight band, and comment box
export interface FileLineGeometry {
  lineNumber: number;
  top: number;
  height: number;
  left: number;
  containerWidth: number;
}

interface UseFileLineCommentingOptions {
  enabled: boolean;
  // close any open box / clear hover when the file changes so stale geometry never leaks into the new one
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

// 1-based line number of a `.line` span via preceding `.line` siblings, so the math holds if the highlighter emits stray siblings inside <code>
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
    // reset before committing the new file/mode — hiding state behind a key would let A→B→A revive the old overlay
    setLineState({ enabled, resetKey, hoveredLine: null, activeLine: null });
  }
  const hoveredLine = scopeIsCurrent && enabled ? lineState.hoveredLine : null;
  const activeLine = scopeIsCurrent && enabled ? lineState.activeLine : null;
  const setHoveredLine = (line: FileLineGeometry | null) =>
    setLineState((current) => ({ ...current, hoveredLine: line }));
  const setActiveLine = (line: FileLineGeometry | null) =>
    setLineState((current) => ({ ...current, activeLine: line }));
  // the hover element (deduped so same-line mousemove doesn't re-render) and whether a box is open, read synchronously from the move handler
  const hoveredElRef = useRef<Element | null>(null);
  const isActiveRef = useRef(false);

  const clearHover = () => {
    hoveredElRef.current = null;
    setHoveredLine(null);
  };

  const onContainerMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    // suppress the affordance while disabled, while a box is open, and while a button is held (drag-selection) — the gutter "+" must not flicker during a sweep
    if (!enabled || isActiveRef.current || event.buttons !== 0) {
      return;
    }
    const container = event.currentTarget;
    const target = event.target instanceof Element ? event.target : null;
    // the "+" sits on the hovered line's own gutter — without this guard, hovering it resolves to "no line", tears it down, re-shows it, flickering in a mount/unmount loop
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
