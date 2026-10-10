import { SINGLE_CHAT_PANE_SCOPE_ID } from "./chatPaneScope";
import { findNearestMeasurableAncestor } from "./domLayout";
import { notifyNativeSurfaceOcclusionChange } from "./nativeSurfaceOcclusion";

// intentionally lean soft buffer — the real overflow checks still block clipping; a smaller value lets panes resize across a wider range before the probe stops the drag
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 160;

// apply the width, measure, reset — callers own the real commit
export function canComposerHandlePanelWidth(input: {
  nextWidth: number;
  paneScopeId?: string;
  applyWidth: (width: number) => void;
  resetWidth: () => void;
}): boolean {
  const paneScopeId = input.paneScopeId ?? SINGLE_CHAT_PANE_SCOPE_ID;
  const composerForm = findComposerForm(paneScopeId);
  if (!composerForm) return true;

  // the form can sit inside boxless wrappers (display:contents landing wrapper); measuring those as viewport would reject every width and freeze resizing
  const composerViewport = findNearestMeasurableAncestor(composerForm);
  if (!composerViewport) return true;

  input.applyWidth(input.nextWidth);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

  input.resetWidth();

  return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
}

function findComposerForm(paneScopeId: string): HTMLElement | null {
  const composerForms = document.querySelectorAll<HTMLElement>("[data-chat-composer-form='true']");
  for (const composerForm of composerForms) {
    if (composerForm.dataset.chatPaneScope === paneScopeId) {
      return composerForm;
    }
  }
  return null;
}

// Electron <webview> can swallow pointermove during drag — keeps resizing in the React layer
export function createPanelResizeOverlay(cursor = "col-resize"): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-panel-resize-overlay", "true");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "2147483647";
  overlay.style.cursor = cursor;
  overlay.style.background = "transparent";
  document.body.append(overlay);
  notifyNativeSurfaceOcclusionChange();
  return overlay;
}

export function removePanelResizeOverlay(overlay: HTMLDivElement): void {
  overlay.remove();
  notifyNativeSurfaceOcclusionChange();
}

export function attachPanelPointerOverlaySession(
  overlay: HTMLElement,
  handlers: {
    onMove: (event: PointerEvent) => void;
    onRelease: () => void;
    onAbort: () => void;
  },
): () => void {
  const onMove = (event: PointerEvent) => {
    if (event.buttons === 0) {
      handlers.onAbort();
      return;
    }
    handlers.onMove(event);
  };
  const onRelease = () => handlers.onRelease();
  const onAbort = () => handlers.onAbort();

  overlay.addEventListener("pointermove", onMove);
  overlay.addEventListener("pointerup", onRelease);
  overlay.addEventListener("pointercancel", onAbort);
  window.addEventListener("blur", onAbort);
  document.addEventListener("mouseleave", onAbort);

  return () => {
    overlay.removeEventListener("pointermove", onMove);
    overlay.removeEventListener("pointerup", onRelease);
    overlay.removeEventListener("pointercancel", onAbort);
    window.removeEventListener("blur", onAbort);
    document.removeEventListener("mouseleave", onAbort);
  };
}
