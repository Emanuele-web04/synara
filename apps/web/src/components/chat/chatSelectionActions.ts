// FILE: chatSelectionActions.ts
// Purpose: Helpers for reading assistant text selections from the transcript without re-render churn.
// Layer: Chat transcript interaction helpers

export interface TranscriptAssistantSelection {
  assistantMessageId: string;
  text: string;
}

export interface TranscriptSelectionActionLayout {
  left: number;
  top: number;
  placement: "top" | "bottom";
}

const TRANSCRIPT_SELECTION_ACTION_WIDTH_PX = 108;
const TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX = 32;
const TRANSCRIPT_SELECTION_ACTION_GAP_PX = 8;

function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }
  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

function selectionContainerForNode(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-assistant-message-id]") ?? null;
}

export function readTranscriptAssistantSelection(input: {
  container: HTMLElement | null;
}): { selection: TranscriptAssistantSelection; selectionRect: DOMRect | null } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const anchorContainer = selectionContainerForNode(selection.anchorNode);
  const focusContainer = selectionContainerForNode(selection.focusNode);
  if (!anchorContainer || !focusContainer || anchorContainer !== focusContainer) {
    return null;
  }
  const { container } = input;
  if (!container || !container.contains(anchorContainer)) {
    return null;
  }

  const assistantMessageId = anchorContainer.dataset.assistantMessageId?.trim() ?? "";
  const text = selection
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
  if (assistantMessageId.length === 0 || text.length === 0) {
    return null;
  }

  return {
    selection: {
      assistantMessageId,
      text,
    },
    selectionRect: getSelectionRect(selection),
  };
}

export function resolveTranscriptSelectionActionLayout(input: {
  selectionRect: DOMRect | null;
  pointer: { x: number; y: number };
  viewport?: { width: number; height: number } | null;
}): TranscriptSelectionActionLayout {
  const viewportWidth =
    input.viewport?.width ??
    (typeof window === "undefined" ? input.pointer.x + 8 : window.innerWidth);
  const viewportHeight =
    input.viewport?.height ??
    (typeof window === "undefined" ? input.pointer.y + 8 : window.innerHeight);

  const anchorCenterX =
    input.selectionRect !== null
      ? input.selectionRect.left + input.selectionRect.width / 2
      : input.pointer.x;
  const selectionTop = input.selectionRect?.top ?? input.pointer.y;
  const selectionBottom = input.selectionRect?.bottom ?? input.pointer.y;
  const availableAbove = selectionTop;
  const availableBelow = viewportHeight - selectionBottom;
  const placement =
    availableAbove >= TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX + TRANSCRIPT_SELECTION_ACTION_GAP_PX ||
    availableAbove >= availableBelow
      ? "top"
      : "bottom";
  const unclampedTop =
    placement === "top"
      ? selectionTop - TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX - TRANSCRIPT_SELECTION_ACTION_GAP_PX
      : selectionBottom + TRANSCRIPT_SELECTION_ACTION_GAP_PX;

  return {
    left: Math.max(
      8,
      Math.min(
        Math.round(anchorCenterX - TRANSCRIPT_SELECTION_ACTION_WIDTH_PX / 2),
        Math.max(viewportWidth - TRANSCRIPT_SELECTION_ACTION_WIDTH_PX - 8, 8),
      ),
    ),
    top: Math.max(
      8,
      Math.min(
        Math.round(unclampedTop),
        Math.max(viewportHeight - TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX - 8, 8),
      ),
    ),
    placement,
  };
}
