// FILE: AssistantSelectionInlineMarkers.tsx
// Purpose: Marks composer quotes inside the assistant messages they came from: the quoted text is
//   highlighted, a numbered label sits at its end, and clicking either opens the comment editor.
// Layer: Chat transcript interaction UI

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ComposerAssistantSelectionAttachment } from "../../composerDraftStore";
import {
  findTextRangeInElement,
  resolveTranscriptSelectionActionLayout,
} from "./chatSelectionActions";
import { SelectionNewChatComposer } from "./SelectionNewChatComposer";
import type { PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";

const HIGHLIGHT_NAME = "synara-assistant-selection";

// One registry entry is shared by every mounted chat pane, so each pane contributes its own ranges.
const rangesByOwner = new Map<object, Range[]>();

function syncHighlightRegistry() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const ranges = [...rangesByOwner.values()].flat();
  if (ranges.length === 0) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

function lastVisibleRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
  return rects[rects.length - 1] ?? null;
}

function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  return Array.from(range.getClientRects()).some(
    (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  );
}

interface MarkerPosition {
  id: string;
  ordinal: number;
  left: number;
  top: number;
}

function sameMarkers(a: ReadonlyArray<MarkerPosition>, b: ReadonlyArray<MarkerPosition>) {
  return (
    a.length === b.length &&
    a.every(
      (marker, index) =>
        marker.id === b[index]!.id &&
        marker.ordinal === b[index]!.ordinal &&
        marker.left === b[index]!.left &&
        marker.top === b[index]!.top,
    )
  );
}

interface AssistantSelectionInlineMarkersProps {
  // Positioned, overflow-clipped transcript pane; labels render inside it so they scroll and clip with it.
  container: HTMLElement | null;
  selections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
  onUpdateComment: (selectionId: string, comment: string) => void;
  onRemove: (selectionId: string) => void;
}

export function AssistantSelectionInlineMarkers(props: AssistantSelectionInlineMarkersProps) {
  const { container, selections } = props;
  const [markers, setMarkers] = useState<MarkerPosition[]>([]);
  const [editing, setEditing] = useState<{
    selectionId: string;
    action: PendingTranscriptSelectionAction;
  } | null>(null);
  const rangesRef = useRef(new Map<string, Range>());
  const ownerRef = useRef({});

  useLayoutEffect(() => {
    const owner = ownerRef.current;
    if (!container || selections.length === 0) {
      rangesRef.current.clear();
      rangesByOwner.delete(owner);
      syncHighlightRegistry();
      setMarkers((current) => (current.length === 0 ? current : []));
      return;
    }

    // Ranges are rebuilt from scratch: streaming and list virtualization replace message DOM.
    const locate = () => {
      const ranges = new Map<string, Range>();
      for (const selection of selections) {
        const message = container.querySelector(
          `[data-assistant-message-id="${CSS.escape(selection.assistantMessageId)}"]`,
        );
        const range = message ? findTextRangeInElement(message, selection.text) : null;
        if (range) ranges.set(selection.id, range);
      }
      rangesRef.current = ranges;
      rangesByOwner.set(owner, [...ranges.values()]);
      syncHighlightRegistry();
    };

    const place = () => {
      const paneRect = container.getBoundingClientRect();
      const next: MarkerPosition[] = [];
      selections.forEach((selection, index) => {
        const range = rangesRef.current.get(selection.id);
        const rect = range ? lastVisibleRect(range) : null;
        if (!rect) return;
        next.push({
          id: selection.id,
          ordinal: index + 1,
          left: Math.round(rect.right - paneRect.left),
          // Footnote position: raised to the line's top edge so it barely covers the next word.
          top: Math.round(rect.top + 2 - paneRect.top),
        });
      });
      setMarkers((current) => (sameMarkers(current, next) ? current : next));
    };

    let frame: number | null = null;
    let needsLocate = true;
    const schedule = (relocate: boolean) => {
      needsLocate ||= relocate;
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (needsLocate) {
          needsLocate = false;
          locate();
        }
        place();
      });
    };

    locate();
    needsLocate = false;
    place();

    const mutationObserver = new MutationObserver((records) => {
      // Our own labels live in the pane; their updates must not trigger another pass.
      if (
        records.every(
          (record) =>
            record.target instanceof Node &&
            (record.target instanceof Element
              ? record.target
              : record.target.parentElement
            )?.closest("[data-assistant-selection-markers]"),
        )
      ) {
        return;
      }
      schedule(true);
    });
    mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });
    const resizeObserver = new ResizeObserver(() => schedule(false));
    resizeObserver.observe(container);
    const onScroll = () => schedule(false);
    container.addEventListener("scroll", onScroll, { capture: true, passive: true });

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      container.removeEventListener("scroll", onScroll, { capture: true });
      rangesByOwner.delete(owner);
      syncHighlightRegistry();
    };
  }, [container, selections]);

  const openEditor = (selectionId: string, pointer: { x: number; y: number }) => {
    const selection = selections.find((entry) => entry.id === selectionId);
    const range = rangesRef.current.get(selectionId);
    if (!selection || !range) return;
    const layout = resolveTranscriptSelectionActionLayout({
      selectionRect: lastVisibleRect(range),
      pointer,
    });
    setEditing({
      selectionId,
      action: {
        selection: { assistantMessageId: selection.assistantMessageId, text: selection.text },
        ...layout,
      },
    });
  };
  const openEditorFromTextClick = useEffectEvent(openEditor);

  // Clicking the highlighted text opens its editor, unless the click lands on a link or button
  // or ends a new text selection.
  useEffect(() => {
    if (!container) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || rangesRef.current.size === 0) return;
      if (!window.getSelection()?.isCollapsed) return;
      if (event.target instanceof Element && event.target.closest("a, button, input, textarea")) {
        return;
      }
      for (const [selectionId, range] of rangesRef.current) {
        if (rangeContainsPoint(range, event.clientX, event.clientY)) {
          openEditorFromTextClick(selectionId, { x: event.clientX, y: event.clientY });
          return;
        }
      }
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [container]);

  const editingSelection = editing
    ? selections.find((entry) => entry.id === editing.selectionId)
    : undefined;

  return (
    <>
      {markers.length > 0 ? (
        <div
          data-assistant-selection-markers
          className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
        >
          {markers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              aria-label={`Edit comment for selection ${marker.ordinal}`}
              className="pointer-events-auto absolute flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--color-text-accent)] text-ui-xs font-semibold leading-none text-[var(--color-background-surface)] shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: marker.left, top: marker.top }}
              onClick={(event) => {
                event.stopPropagation();
                openEditor(marker.id, { x: event.clientX, y: event.clientY });
              }}
            >
              {marker.ordinal}
            </button>
          ))}
        </div>
      ) : null}
      {editing && editingSelection
        ? createPortal(
            <SelectionNewChatComposer
              key={editing.selectionId}
              variant="edit-comment"
              action={editing.action}
              initialComment={editingSelection.comment ?? ""}
              onSaveComment={(comment) => props.onUpdateComment(editing.selectionId, comment)}
              onRemove={() => props.onRemove(editing.selectionId)}
              onClose={() => setEditing(null)}
            />,
            document.body,
          )
        : null}
    </>
  );
}
