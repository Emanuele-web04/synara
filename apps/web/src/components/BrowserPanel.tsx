// FILE: BrowserPanel.tsx
// Purpose: Renders the in-app browser chrome and mirrors the native Electron view.
// Layer: Desktop-only React component
// Depends on: browserStateStore, nativeApi browser bridge, DiffPanelShell
//
// Note: raw <button>s for autocomplete-suggestion rows and tab-title activate
// regions are intentional — list-row and tab semantics, not shadcn Buttons.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore as useZustandStore } from "zustand";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type BrowserCaptureScreenshotResult,
  type ServerLocalServerProcess,
  type ThreadId,
} from "@t3tools/contracts";
import {
  AdjustmentsIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  EllipsisIcon,
  EraserIcon,
  ExternalLinkIcon,
  EyeIcon,
  GlobeIcon,
  LinkIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  type LucideIcon,
  PlusIcon,
  RefreshCwIcon,
  StopIcon,
  TextIcon,
  Undo2Icon,
  XIcon,
} from "~/lib/icons";

import { localServerPrimaryLabel } from "@t3tools/shared/localServers";
import {
  BROWSER_BLANK_URL,
  isBlankBrowserTabUrl,
  resolveCopyableBrowserTabUrl,
} from "@t3tools/shared/browserSession";
import {
  BROWSER_COPY_LINK_TOAST_TITLE,
  isBrowserCopyLinkChord,
} from "@t3tools/shared/browserShortcuts";

import { isElectron } from "~/env";
import { readNativeApi } from "~/nativeApi";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { IMAGE_SIZE_LIMIT_LABEL } from "~/lib/composerSend";
import { APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME } from "./chat/composerPickerStyles";
import { Kbd } from "./ui/kbd";
import { PANEL_RESIZE_OVERLAY_SYNC_EVENT } from "~/lib/panelResize";
import { serverLocalServersQueryOptions } from "~/lib/serverReactQuery";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";

import {
  useBrowserStateStore,
  selectThreadBrowserHistory,
  selectThreadBrowserState,
} from "../browserStateStore";
import {
  type ComposerBrowserContextAttachment,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore as useAppStore } from "../store";
import { createProjectSelector, createThreadSelector } from "../storeSelectors";
import { selectPreviewState, usePreviewStateStore } from "../previewStateStore";
import { anchoredToastManager } from "./ui/toast";
import {
  BROWSER_ANNOTATION_SCREENSHOT_NAME,
  composerImageFromBrowserScreenshot,
  screenshotAttachmentName,
} from "../lib/browserPromptContext";
import {
  liveEditPreviewRouteKey,
  openLiveEditPreviewTab,
  stopLiveEditPreview,
} from "../lib/liveEditPreviewTabs";
import {
  buildBrowserDrawingPromptBlock,
  buildBrowserSelectionPromptBlock,
  buildBrowserStyleEditPromptBlock,
  cdpElementHoverContextExpression,
  cdpElementContextExpression,
  isBrowserElementEditorContext,
  isBrowserElementHoverContext,
  normalizeBrowserElementStylePatch,
  readBrowserElementContextFromDocumentAtPoint,
  readBrowserElementHoverContextFromDocumentAtPoint,
  removeBrowserAnnotationContextPrompt,
  type BrowserAnnotationArrow,
  type BrowserAnnotationArrowHandle,
  type BrowserDrawingPoint,
  type BrowserDrawingStroke,
  type BrowserElementEditorContext,
  type BrowserElementStylePatch,
  type BrowserTextAnnotation,
  type BrowserViewport,
} from "../lib/browserEditorContext";
import {
  convertBrowserOverlayAnnotationsToViewport,
  browserOverlayPointToViewportPoint,
  type BrowserAnnotationCoordinateGeometry,
} from "../lib/browserAnnotationGeometry";
import {
  applyBrowserStylePreviewToDocument,
  browserStylePreviewInstallExpression,
  browserStylePreviewInvokeExpression,
  type BrowserStylePreviewMode,
} from "../lib/browserStylePreview";
import {
  browserAddressDisplayValue,
  buildBrowserAddressSuggestions,
  normalizeBrowserAddressInput,
  resolveBrowserChromeStatus,
  resolveBrowserAddressSync,
  type BrowserAddressSuggestion,
} from "./BrowserPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { LocalServerIdentity } from "./LocalServerIdentity";
import { Button } from "./ui/button";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Skeleton } from "./ui/skeleton";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ElementPropertiesPanel } from "./browser/ElementPropertiesPanel";

interface BrowserPanelProps {
  mode: DiffPanelMode;
  threadId: ThreadId;
  onClosePanel: () => void;
  runtimeMode?: DockPaneRuntimeMode;
  onRequestLive?: () => void;
  variant?: "browser" | "live-editor";
}

const BROWSER_BOUNDS_SYNC_BURST_FRAMES = 30;
const BROWSER_BOUNDS_SYNC_STABLE_FRAME_TARGET = 2;
const BROWSER_WEBVIEW_PARTITION = "persist:synara-browser";
const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
const SYNARA_BROWSER_LABEL = "Synara browser";
// The address field and tab pills share one chrome-control surface so the whole row reads
// as a single cohesive control: matching height, radius, border width, and type scale.
const BROWSER_CHROME_CONTROL_CLASS_NAME = "h-8 rounded-lg border text-xs";
// The address field's filled look, reused by the active tab so the selected tab visually
// matches the search input (same border tone + faint fill).
const BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME = "border-border bg-background/70";
const BROWSER_ACTION_MENU_PANEL_CLASS_NAME = "w-52 min-w-52";
const BROWSER_ACTION_MENU_ITEM_CLASS_NAME =
  "text-[var(--color-text-foreground)] data-highlighted:text-[var(--color-text-foreground)]";
const BROWSER_ACTION_MENU_ICON_CLASS_NAME =
  "inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--color-text-foreground-secondary)] [&>svg]:size-3.5 [&>[data-slot=central-icon]]:size-3.5";
const NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR = [
  "[data-slot='dialog-backdrop']",
  "[data-slot='dialog-popup']",
  "[data-slot='dialog-viewport']",
  "[data-slot='alert-dialog-backdrop']",
  "[data-slot='alert-dialog-popup']",
  "[data-slot='alert-dialog-viewport']",
  "[data-slot='command-dialog-backdrop']",
  "[data-slot='command-dialog-popup']",
  "[data-slot='command-dialog-viewport']",
  "[data-slot='toast-popup']",
  "[role='dialog'][aria-modal='true']",
].join(", ");

function BrowserActionMenuIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={BROWSER_ACTION_MENU_ICON_CLASS_NAME}>
      <Icon aria-hidden="true" />
    </span>
  );
}

// The browser itself lives inside a sheet, and toast portals/positioners are just
// layout containers. Treating either as blockers hides the WebContentsView.
const NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR = [
  "[data-panel-resize-overlay='true']",
  "[data-slot='sheet-backdrop']",
  "[data-slot='sheet-popup']",
  "[data-slot='toast-portal']",
  "[data-slot='toast-portal-anchored']",
  "[data-slot='toast-viewport']",
  "[data-slot='toast-viewport-anchored']",
  "[data-slot='toast-positioner']",
  "[data-browser-editor-overlay='true']",
].join(", ");
const BROWSER_EDITOR_CHROME_SELECTOR = [
  "[data-browser-editor-chrome='true']",
  "[data-browser-editor-overlay='true']",
].join(", ");
const BROWSER_EDITOR_SURFACE_SELECTOR = "[data-browser-editor-surface='true']";
const LIVE_EDITOR_CONTEXT_PREVIEW_SELECTOR = "[data-live-editor-context-preview='true']";

interface BrowserViewportPerfCounters {
  syncAttempts: number;
  syncSkips: number;
  syncSends: number;
  resizeSchedules: number;
  resizeScheduleSkips: number;
  burstStarts: number;
  burstExtensions: number;
  burstFrames: number;
  transitionSignals: number;
  ignoredTransitionSignals: number;
}

interface BrowserWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  getURL?: () => string;
  loadURL?: (url: string, options?: { extraHeaders?: string }) => Promise<void>;
  reload?: () => void;
  reloadIgnoringCache?: () => void;
}

const BROWSER_NO_CACHE_HEADERS = "pragma: no-cache\ncache-control: no-cache\n";

function isLoopbackPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.port.length > 0 &&
      (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1")
    );
  } catch {
    return false;
  }
}

function liveEditorPreviewLabel(value: string | null | undefined): string {
  if (!value || value === BROWSER_BLANK_URL) {
    return "Localhost";
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return url.port ? `Localhost: ${url.port}` : "Localhost";
    }
    return url.port ? `${url.hostname}: ${url.port}` : url.hostname;
  } catch {
    return "Localhost";
  }
}

// Identifies "the same page" for style-preview reapplication: origin + path + search,
// ignoring the hash so in-page anchors do not drop an active preview.
function stylePreviewPageKey(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    return `${url.origin}${pathname}${url.search}`;
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function livePreviewOriginsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left.trim().replace(/\/$/, "") === right.trim().replace(/\/$/, "");
  }
}

function loadBrowserWebviewUrl(webview: BrowserWebviewElement, url: string): void {
  const nextUrl = url.length > 0 ? url : BROWSER_BLANK_URL;
  const shouldBypassCache = isLoopbackPreviewUrl(nextUrl);
  const previousSrc = webview.getAttribute("src") ?? "";
  let currentUrl = previousSrc;
  try {
    currentUrl = webview.getURL?.() ?? previousSrc;
  } catch {
    // Some webview methods are unavailable before the guest is ready.
  }

  if (shouldBypassCache) {
    try {
      const loadPromise = webview.loadURL?.(nextUrl, { extraHeaders: BROWSER_NO_CACHE_HEADERS });
      if (loadPromise) {
        void loadPromise.catch(() => undefined);
      } else {
        webview.setAttribute("src", nextUrl);
        window.requestAnimationFrame(() => webview.reloadIgnoringCache?.());
      }
      return;
    } catch {
      webview.setAttribute("src", nextUrl);
      window.requestAnimationFrame(() => webview.reloadIgnoringCache?.());
      return;
    }
  }

  webview.setAttribute("src", nextUrl);
  if (nextUrl === BROWSER_BLANK_URL || (previousSrc !== nextUrl && currentUrl !== nextUrl)) {
    return;
  }

  try {
    if (webview.reloadIgnoringCache) {
      webview.reloadIgnoringCache();
      return;
    }
    if (webview.reload) {
      webview.reload();
      return;
    }
    void webview.loadURL?.(nextUrl).catch(() => undefined);
  } catch {
    // Native navigation will still be attempted through the browser manager.
  }
}

type BrowserEditorMode = "browse" | "inspect" | "draw" | "text";
type BrowserToolOptionsPanel = "draw" | "text";

const LIVE_EDITOR_MODE_SHORTCUTS = [
  { mode: "browse", key: "b", label: "⌘B" },
  { mode: "inspect", key: "i", label: "⌘I" },
  { mode: "draw", key: "d", label: "⌘D" },
  { mode: "text", key: "t", label: "⌘T" },
] as const satisfies readonly { mode: BrowserEditorMode; key: string; label: string }[];

interface BrowserToolbarAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BrowserStylePanelPosition {
  left: number;
  top: number;
}

interface BrowserInlineTextEditorState {
  selector: string;
  sourceElement: Pick<BrowserElementEditorContext, "attributes" | "outerHTML" | "tagName" | "text">;
  tabId: string;
  originalText: string;
}

type BrowserInlineTextEditMode = "begin" | "commit" | "cancel" | "read";
type BrowserInlineTextEditResultAction = "commit" | "cancel";

interface BrowserInlineTextEditInput {
  selector: string;
  mode: BrowserInlineTextEditMode;
  text?: string;
}

interface BrowserInlineTextEditResult {
  ok: boolean;
  action?: BrowserInlineTextEditResultAction | null;
  text?: string;
  outerHTML?: string;
}

type BrowserInlineTextEditWindow = Window &
  typeof globalThis & {
    __synaraInlineTextEdit?: {
      selector: string;
      element: HTMLElement;
      cleanup: (
        action: BrowserInlineTextEditResultAction,
        options?: { silent?: boolean; restoreText?: boolean },
      ) => void;
    };
  };

function applyBrowserInlineTextEditRuntime(
  input: BrowserInlineTextEditInput,
  runtimeDocument: Document = document,
): BrowserInlineTextEditResult {
  const doc = runtimeDocument;
  const runtimeWindow = (doc.defaultView ?? window) as BrowserInlineTextEditWindow;
  const HTMLElementCtor = runtimeWindow.HTMLElement;
  const resultActionAttr = "data-synara-inline-text-edit-result";
  const resultSelectorAttr = "data-synara-inline-text-edit-selector";
  const editAttr = "data-synara-inline-text-edit";
  const styleId = "synara-inline-text-edit-style";
  const stateKey = "__synaraInlineTextEdit";
  const root = doc.documentElement;

  const clearResult = () => {
    root.removeAttribute(resultActionAttr);
    root.removeAttribute(resultSelectorAttr);
  };
  const readElement = (selector: string) => {
    const element = doc.querySelector(selector);
    if (!(element instanceof HTMLElementCtor)) {
      return null;
    }
    return element;
  };
  const readPayload = (
    element: HTMLElement | null,
    action?: BrowserInlineTextEditResultAction | null,
  ): BrowserInlineTextEditResult => ({
    ok: element !== null,
    ...(action !== undefined ? { action } : {}),
    ...(element ? { text: element.textContent ?? "", outerHTML: element.outerHTML } : {}),
  });

  if (input.mode === "read") {
    const action = root.getAttribute(resultActionAttr) as BrowserInlineTextEditResultAction | null;
    if (action !== "commit" && action !== "cancel") {
      return { ok: true, action: null };
    }
    const selector = root.getAttribute(resultSelectorAttr) || input.selector;
    const element = readElement(selector);
    clearResult();
    return readPayload(element, action);
  }

  const element = readElement(input.selector);
  if (!element) {
    return { ok: false };
  }

  const active = runtimeWindow[stateKey];
  if (active && active.selector !== input.selector) {
    active.cleanup("cancel", { silent: true, restoreText: true });
  }

  if (input.mode === "commit") {
    if (runtimeWindow[stateKey]?.selector === input.selector) {
      runtimeWindow[stateKey]?.cleanup("commit", { silent: true });
    }
    clearResult();
    return readPayload(element);
  }

  if (input.mode === "cancel") {
    if (typeof input.text === "string") {
      element.textContent = input.text;
    }
    if (runtimeWindow[stateKey]?.selector === input.selector) {
      runtimeWindow[stateKey]?.cleanup("cancel", { silent: true });
    }
    clearResult();
    return readPayload(element);
  }

  if (runtimeWindow[stateKey]?.selector === input.selector) {
    runtimeWindow[stateKey]?.cleanup("cancel", { silent: true, restoreText: true });
  }
  clearResult();

  let style = doc.getElementById(styleId);
  if (!style) {
    style = doc.createElement("style");
    style.id = styleId;
    style.textContent = `
      [${editAttr}="true"] {
        outline: 2px solid rgba(96, 165, 250, 0.82) !important;
        outline-offset: 2px !important;
        caret-color: rgb(59, 130, 246) !important;
        cursor: text !important;
        -webkit-user-modify: read-write-plaintext-only;
      }
    `;
    doc.head.appendChild(style);
  }

  const originalText = element.textContent ?? "";
  const originalContentEditable = element.getAttribute("contenteditable");
  const originalSpellcheck = element.getAttribute("spellcheck");
  const originalTabIndex = element.getAttribute("tabindex");
  let disposed = false;

  const restoreAttribute = (name: string, original: string | null) => {
    if (original === null) {
      element.removeAttribute(name);
      return;
    }
    element.setAttribute(name, original);
  };
  const cleanup = (
    action: BrowserInlineTextEditResultAction,
    options: { silent?: boolean; restoreText?: boolean } = {},
  ) => {
    if (disposed) {
      return;
    }
    disposed = true;
    element.removeEventListener("keydown", onKeyDown, true);
    element.removeEventListener("blur", onBlur, true);
    if (options.restoreText) {
      element.textContent = originalText;
    }
    element.removeAttribute(editAttr);
    restoreAttribute("contenteditable", originalContentEditable);
    restoreAttribute("spellcheck", originalSpellcheck);
    restoreAttribute("tabindex", originalTabIndex);
    doc.getElementById(styleId)?.remove();
    if (!options.silent) {
      root.setAttribute(resultActionAttr, action);
      root.setAttribute(resultSelectorAttr, input.selector);
    }
    if (runtimeWindow[stateKey]?.selector === input.selector) {
      delete runtimeWindow[stateKey];
    }
  };
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup("cancel", { restoreText: true });
      element?.blur();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      cleanup("commit");
      element?.blur();
    }
  }
  function onBlur() {
    cleanup("commit");
  }

  element.setAttribute(editAttr, "true");
  element.setAttribute("contenteditable", "plaintext-only");
  if (element.contentEditable !== "plaintext-only") {
    element.setAttribute("contenteditable", "true");
  }
  element.setAttribute("spellcheck", "false");
  if (originalTabIndex === null) {
    element.setAttribute("tabindex", "-1");
  }
  element.addEventListener("keydown", onKeyDown, true);
  element.addEventListener("blur", onBlur, true);
  runtimeWindow[stateKey] = { selector: input.selector, element, cleanup };

  element.focus({ preventScroll: true });
  const selection = runtimeWindow.getSelection?.();
  if (selection) {
    const range = doc.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return readPayload(element);
}

function browserInlineTextEditExpression(input: BrowserInlineTextEditInput) {
  return `(${applyBrowserInlineTextEditRuntime.toString()})(${JSON.stringify(input)})`;
}

interface BrowserEditorVisibleStateSnapshot {
  editorMode: BrowserEditorMode;
  drawStrokes: BrowserDrawingStroke[];
  textAnnotations: BrowserTextAnnotation[];
  annotationArrows: BrowserAnnotationArrow[];
  selectedElementContext: BrowserElementEditorContext | null;
  selectedTextAnnotationId: string | null;
  selectedAnnotationArrowId: string | null;
  stylePropertiesPanelOpen: boolean;
  stylePanelPositionOverride: BrowserStylePanelPosition | null;
  styleEditorInitialPatch: BrowserElementStylePatch | null;
}

interface BrowserInspectHoverBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  viewport?: BrowserViewport | undefined;
}

function browserInspectBoxesMatch(
  first: BrowserInspectHoverBox,
  second: BrowserInspectHoverBox,
): boolean {
  return (
    first.label === second.label &&
    Math.abs(first.x - second.x) < 0.5 &&
    Math.abs(first.y - second.y) < 0.5 &&
    Math.abs(first.width - second.width) < 0.5 &&
    Math.abs(first.height - second.height) < 0.5
  );
}

function browserViewportBoxToOverlayBox(
  box: BrowserInspectHoverBox,
  geometry: BrowserAnnotationCoordinateGeometry,
): BrowserInspectHoverBox {
  const xScale =
    Number.isFinite(geometry.overlayWidth) && geometry.viewportWidth > 0
      ? geometry.overlayWidth / geometry.viewportWidth
      : 1;
  const yScale =
    Number.isFinite(geometry.overlayHeight) && geometry.viewportHeight > 0
      ? geometry.overlayHeight / geometry.viewportHeight
      : 1;
  return {
    ...box,
    x: box.x * xScale,
    y: box.y * yScale,
    width: box.width * xScale,
    height: box.height * yScale,
  };
}

function BrowserAnnotationBoxOverlay({
  box,
  variant = "inspect",
}: {
  box: BrowserInspectHoverBox;
  variant?: "inspect" | "selected";
}) {
  const isSelected = variant === "selected";
  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute rounded-[2px] border",
          isSelected
            ? "border-blue-400 bg-transparent shadow-[inset_0_0_0_1px_rgba(37,99,235,0.9),0_0_0_1px_rgba(0,0,0,0.48)]"
            : "border-cyan-200/90 bg-cyan-300/[0.24] shadow-[inset_0_0_0_1px_rgba(8,145,178,0.62),0_0_0_1px_rgba(0,0,0,0.5),0_0_24px_rgba(34,211,238,0.42)]",
        )}
        style={{
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
        }}
      />
      <div
        className={cn(
          "pointer-events-none absolute rounded-[2px] border-2 mix-blend-difference",
          isSelected
            ? "border-blue-400 bg-blue-400/[0.18] shadow-[0_0_0_1px_rgba(96,165,250,0.85)]"
            : "border-white bg-white/[0.18] shadow-[0_0_0_1px_rgba(255,255,255,0.85)]",
        )}
        style={{
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
        }}
      />
      <div
        className={cn(
          "pointer-events-none absolute max-w-72 truncate rounded px-2 py-1 text-[11px] font-medium text-white shadow-[0_0_0_1px_rgba(255,255,255,0.24),0_8px_20px_rgba(0,0,0,0.32)]",
          isSelected
            ? "border border-blue-300/80 bg-blue-950/[0.9]"
            : "border border-cyan-200/75 bg-black/[0.88]",
        )}
        style={{
          left: Math.max(8, box.x),
          top: Math.max(8, box.y - 28),
        }}
      >
        {box.label}
      </div>
    </>
  );
}

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
}

const BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[active=true]:bg-cyan-500/14 data-[active=true]:text-cyan-950 data-[active=true]:shadow-[inset_0_0_0_1px_rgba(6,182,212,0.42)] dark:data-[active=true]:bg-cyan-300/14 dark:data-[active=true]:text-cyan-100 dark:data-[active=true]:shadow-[inset_0_0_0_1px_rgba(103,232,249,0.34)]";
const BROWSER_TOOLBAR_STRIP_CLASS_NAME =
  "flex min-w-0 items-center gap-2 rounded-lg border border-border/25 bg-background/45 px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur dark:border-border/50";
const BROWSER_TOOLBAR_SECTION_CLASS_NAME = "flex shrink-0 items-center gap-0.5";
const BROWSER_TOOLBAR_DIVIDER_CLASS_NAME = "h-5 w-px shrink-0 bg-border/60";
const BROWSER_ELEMENT_EDIT_BUTTON_CLASS_NAME =
  "flex h-6 w-7 items-center justify-center rounded-[5px] border border-black/10 bg-white/62 text-slate-950 shadow-[0_8px_24px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.62)] backdrop-blur-xl transition hover:bg-white/76 dark:border-white/18 dark:bg-slate-950/82 dark:text-white dark:shadow-[0_8px_24px_rgba(0,0,0,0.22)] dark:hover:bg-slate-900";
// Tool flyouts are pickers, so they wear the app's shared translucent popup shell
// instead of a bespoke glass surface.
const BROWSER_TOOL_OPTIONS_PANEL_CLASS_NAME = `pointer-events-auto fixed z-[80] w-48 rounded-xl p-2.5 shadow-xl ${APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME}`;
// Floating shortcut chips reuse the shared <Kbd> chrome; this only shrinks it and
// adds a border + blur so the chip stays legible over arbitrary page content.
const BROWSER_SHORTCUT_HINT_CLASS_NAME =
  "pointer-events-none h-4 min-w-4 rounded-[4px] border border-border bg-popover/80 px-[5px] text-[8.5px] shadow-md backdrop-blur-xl";
const BROWSER_TOOL_OPTIONS_RANGE_CLASS_NAME =
  "mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full border border-black/15 shadow-[inset_0_1px_2px_rgba(15,23,42,0.22)] outline-none [&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-white/90 [&::-moz-range-thumb]:bg-slate-50 [&::-moz-range-thumb]:shadow-[0_1px_4px_rgba(15,23,42,0.32)] [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white/90 [&::-webkit-slider-thumb]:bg-slate-50 [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(15,23,42,0.32)] dark:border-white/18 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.45)] dark:[&::-moz-range-thumb]:border-white/75 dark:[&::-moz-range-thumb]:bg-slate-100 dark:[&::-webkit-slider-thumb]:border-white/75 dark:[&::-webkit-slider-thumb]:bg-slate-100";
const BROWSER_EDITOR_SWITCH_CLASS_NAME =
  "relative h-4 w-7 rounded-full border p-0 transition-[background,border-color]";
const BROWSER_EDITOR_SWITCH_THUMB_CLASS_NAME =
  "absolute top-1/2 size-3 -translate-y-1/2 rounded-full border border-white/85 bg-slate-50 shadow-[0_1px_4px_rgba(15,23,42,0.35)] transition-[left,background-color]";
const BROWSER_STYLE_PANEL_WIDTH = 352;
const BROWSER_STYLE_PANEL_MAX_HEIGHT = 672;
const BROWSER_STYLE_PANEL_GAP = 12;
const BROWSER_STYLE_PANEL_VIEWPORT_PADDING = 8;
const BROWSER_DRAWING_CONTRAST_STROKE_COLOR = "#ffffff";
const BROWSER_DRAWING_GRADIENT_COLOR_SETS = [
  ["#ff2d55", "#ffcc00", "#00e5ff", "#7c3aed", "#39ff14"],
  ["#00e5ff", "#39ff14", "#ffcc00", "#ff2d55", "#7c3aed"],
  ["#ffcc00", "#7c3aed", "#ff2d55", "#39ff14", "#00e5ff"],
] as const;
const BROWSER_ANNOTATION_ARROW_HANDLES = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
] as const satisfies readonly BrowserAnnotationArrowHandle[];
const BROWSER_DRAWING_CONTRAST_STROKE_WIDTH = 6;
const BROWSER_DRAWING_GRADIENT_STROKE_WIDTH = 3.5;
const BROWSER_DRAWING_GLINT_STROKE_WIDTH = 1;
const BROWSER_DRAWING_MIN_STROKE_WIDTH = 2;
const BROWSER_DRAWING_MAX_STROKE_WIDTH = 8;
const BROWSER_DRAWING_MIN_POINT_DISTANCE = 1.5;
const BROWSER_TOOL_OPTIONS_HOVER_DELAY_MS = 500;
const BROWSER_TOOL_OPTIONS_CLOSE_DELAY_MS = 120;
const BROWSER_TEXT_ANNOTATION_BOX_MIN_WIDTH = 84;
const BROWSER_TEXT_ANNOTATION_BOX_MAX_WIDTH = 360;
const BROWSER_TEXT_ANNOTATION_BOX_MIN_HEIGHT = 30;
const BROWSER_TEXT_ANNOTATION_BOX_MAX_HEIGHT = 180;
const BROWSER_TEXT_ANNOTATION_FONT_WEIGHT = 600;
const BROWSER_TEXT_ANNOTATION_FONT_SIZE = 12;
const BROWSER_TEXT_ANNOTATION_LINE_HEIGHT = 16;
const BROWSER_TEXT_ANNOTATION_MIN_FONT_SIZE = 10;
const BROWSER_TEXT_ANNOTATION_MAX_FONT_SIZE = 24;
const BROWSER_TEXT_ANNOTATION_PADDING_X = 10;
const BROWSER_TEXT_ANNOTATION_PADDING_Y = 6;
const BROWSER_TEXT_ANNOTATION_OFFSET_X = 10;
const BROWSER_TEXT_ANNOTATION_ANCHOR_GAP = 4;
const BROWSER_TEXT_ANNOTATION_PLACEHOLDER = "Add note";
const BROWSER_ARROW_MIN_LENGTH = 8;
const BROWSER_ANNOTATION_ARROW_HEAD_LENGTH = 11;
const BROWSER_ANNOTATION_ARROW_HEAD_ANGLE = Math.PI / 7;
const BROWSER_ANNOTATION_ATTACHMENT_SOURCE = "browser-annotation";
const BROWSER_ANNOTATION_SCREENSHOT_DEBOUNCE_MS = 450;
const BROWSER_ANNOTATION_SCREENSHOT_MAX_DIMENSION = 4096;
const BROWSER_ANNOTATION_FULL_PAGE_MAX_DIMENSION = 2400;
const BROWSER_ANNOTATION_FULL_PAGE_MAX_AREA = 3_500_000;
const BROWSER_ANNOTATION_REGION_PADDING = 96;
const BROWSER_FALLBACK_CAPTURE_MAX_NODES = 4_000;

let textAnnotationMeasureContext: CanvasRenderingContext2D | null | undefined;

const VIEWPORT_TRANSITION_PROPERTIES = new Set([
  "transform",
  "translate",
  "scale",
  "rotate",
  "width",
  "max-width",
  "min-width",
  "height",
  "max-height",
  "min-height",
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
]);
function closeButtonClassName(isActive: boolean) {
  return cn(
    "ml-1 size-5 shrink-0 rounded-sm p-0 text-muted-foreground/70 hover:bg-background/80 hover:text-foreground",
    isActive ? "hover:bg-background" : "hover:bg-card",
  );
}

function formatBrowserActionError(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return "Couldn't complete that browser action.";
  }
  if (/ERR_ABORTED|\(-3\)/i.test(error.message)) {
    return null;
  }
  return "Couldn't complete that browser action.";
}

function ignoreBrowserBoundsSyncError(): void {
  // Bounds sync is best-effort plumbing between the React shell and the native
  // browser surface. Avoid surfacing transient geometry-sync failures as user-facing
  // browser errors because they do not reflect page navigation health.
}

// One error-to-message rule for editor actions: surface the real message when the
// failure carries one, otherwise fall back to the action-specific copy.
function formatEditorActionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function isBrowserEditorChromeEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(BROWSER_EDITOR_CHROME_SELECTOR));
}

function isBrowserEditorSurfaceEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(BROWSER_EDITOR_SURFACE_SELECTOR));
}

function liveEditorContextPreviewIsOpen(): boolean {
  return (
    typeof document !== "undefined" &&
    document.querySelector(LIVE_EDITOR_CONTEXT_PREVIEW_SELECTOR) !== null
  );
}

function liveEditorShortcutForEvent(event: KeyboardEvent): BrowserEditorMode | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return null;
  }
  return liveEditorModeForShortcutKey(event.key);
}

function liveEditorModeForShortcutKey(key: string): BrowserEditorMode | null {
  const shortcut = LIVE_EDITOR_MODE_SHORTCUTS.find((item) => item.key === key.toLowerCase());
  return shortcut?.mode ?? null;
}

function consumeBrowserEditorShortcutEvent(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function pointFromOverlayEvent(
  event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>,
): BrowserDrawingPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
  };
}

function pointFromOverlayClientPoint(
  overlay: HTMLElement | null,
  clientX: number,
  clientY: number,
): BrowserDrawingPoint {
  const rect = overlay?.getBoundingClientRect();
  if (!rect) {
    return { x: 0, y: 0 };
  }
  return {
    x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
  };
}

function pointFromOverlayRect(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height"> | null,
  clientX: number,
  clientY: number,
): BrowserDrawingPoint {
  if (!rect) {
    return { x: 0, y: 0 };
  }
  return {
    x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
  };
}

interface BrowserTextAnnotationBoxMetrics {
  width: number;
  height: number;
  lines: string[];
  hasOverflow: boolean;
}

const TEXT_ANNOTATION_METRICS_CACHE_MAX = 240;
const textAnnotationMetricsCache = new Map<string, BrowserTextAnnotationBoxMetrics>();

function browserDrawingStrokeSize(
  stroke?: Pick<BrowserDrawingStroke, "strokeSize"> | null,
): number {
  const value =
    typeof stroke?.strokeSize === "number"
      ? stroke.strokeSize
      : BROWSER_DRAWING_GRADIENT_STROKE_WIDTH;
  return Math.max(
    BROWSER_DRAWING_MIN_STROKE_WIDTH,
    Math.min(BROWSER_DRAWING_MAX_STROKE_WIDTH, value),
  );
}

function browserDrawingStrokeWidths(stroke?: Pick<BrowserDrawingStroke, "strokeSize"> | null): {
  contrast: number;
  gradient: number;
  glint: number;
} {
  const gradient = browserDrawingStrokeSize(stroke);
  return {
    contrast: Math.max(gradient + 2.5, gradient * 1.65),
    gradient,
    glint: Math.max(0.8, gradient * 0.28),
  };
}

function browserTextAnnotationFontSize(
  annotation?: Pick<BrowserTextAnnotation, "fontSize"> | null,
): number {
  const value =
    typeof annotation?.fontSize === "number"
      ? annotation.fontSize
      : BROWSER_TEXT_ANNOTATION_FONT_SIZE;
  return Math.max(
    BROWSER_TEXT_ANNOTATION_MIN_FONT_SIZE,
    Math.min(BROWSER_TEXT_ANNOTATION_MAX_FONT_SIZE, value),
  );
}

function browserTextAnnotationLineHeight(fontSize: number): number {
  return Math.max(
    14,
    Math.round(
      fontSize * (BROWSER_TEXT_ANNOTATION_LINE_HEIGHT / BROWSER_TEXT_ANNOTATION_FONT_SIZE),
    ),
  );
}

function estimateTextAnnotationTextWidth(
  text: string,
  fontSize = BROWSER_TEXT_ANNOTATION_FONT_SIZE,
): number {
  const scale = fontSize / BROWSER_TEXT_ANNOTATION_FONT_SIZE;
  let width = 0;
  for (const character of text) {
    if (character === " ") {
      width += 3.5;
    } else if (/[ilI1.,'`|:;!]/.test(character)) {
      width += 3.6;
    } else if (/[mwMW@#%&]/.test(character)) {
      width += 9;
    } else if (/[A-Z]/.test(character)) {
      width += 7.4;
    } else {
      width += 6.6;
    }
  }
  return width * scale;
}

function textAnnotationMeasureFont(fontSize = BROWSER_TEXT_ANNOTATION_FONT_SIZE): string {
  return `${BROWSER_TEXT_ANNOTATION_FONT_WEIGHT} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
}

function getTextAnnotationMeasureContext(): CanvasRenderingContext2D | null {
  if (textAnnotationMeasureContext !== undefined) {
    return textAnnotationMeasureContext;
  }
  if (typeof document === "undefined") {
    textAnnotationMeasureContext = null;
    return null;
  }
  try {
    textAnnotationMeasureContext = document.createElement("canvas").getContext("2d");
  } catch {
    textAnnotationMeasureContext = null;
  }
  return textAnnotationMeasureContext;
}

function measureTextAnnotationTextWidth(
  text: string,
  fontSize = BROWSER_TEXT_ANNOTATION_FONT_SIZE,
): number {
  const context = getTextAnnotationMeasureContext();
  if (!context) {
    return estimateTextAnnotationTextWidth(text, fontSize);
  }
  context.font = textAnnotationMeasureFont(fontSize);
  return context.measureText(text).width;
}

function normalizeTextAnnotationText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function maxVisibleTextAnnotationLines(fontSize = BROWSER_TEXT_ANNOTATION_FONT_SIZE): number {
  const lineHeight = browserTextAnnotationLineHeight(fontSize);
  return Math.max(
    1,
    Math.floor(
      (BROWSER_TEXT_ANNOTATION_BOX_MAX_HEIGHT - BROWSER_TEXT_ANNOTATION_PADDING_Y * 2) / lineHeight,
    ),
  );
}

function textAnnotationLines(
  rawText: string,
  maxWidth: number,
  input: {
    maxLines?: number;
    measureText?: (text: string) => number;
  } = {},
): { lines: string[]; hasOverflow: boolean } {
  const text = normalizeTextAnnotationText(rawText);
  if (text.length === 0) {
    return { lines: [""], hasOverflow: false };
  }

  const measureText = input.measureText ?? measureTextAnnotationTextWidth;
  const maxLines = input.maxLines ?? Number.POSITIVE_INFINITY;
  const lines: string[] = [];
  let hasOverflow = false;
  let current = "";
  let currentWidth = 0;
  const spaceWidth = measureText(" ");

  const pushLine = (line: string): boolean => {
    if (lines.length >= maxLines) {
      hasOverflow = true;
      return false;
    }
    lines.push(line);
    return true;
  };

  const splitLongWordIntoLines = (word: string): { remainder: string; width: number } | null => {
    let remainder = "";
    let remainderWidth = 0;

    for (const character of Array.from(word)) {
      const characterWidth = Math.min(measureText(character), maxWidth);
      if (remainder.length > 0 && remainderWidth + characterWidth > maxWidth) {
        if (!pushLine(remainder)) {
          return null;
        }
        remainder = character;
        remainderWidth = characterWidth;
        continue;
      }
      remainder += character;
      remainderWidth += characterWidth;
    }

    return { remainder, width: remainderWidth };
  };

  for (const word of text.split(" ")) {
    if (word.length === 0) {
      continue;
    }

    const wordWidth = measureText(word);
    const candidateWidth = current.length > 0 ? currentWidth + spaceWidth + wordWidth : wordWidth;

    if (candidateWidth <= maxWidth) {
      current = current.length > 0 ? `${current} ${word}` : word;
      currentWidth = candidateWidth;
      continue;
    }

    if (current.length > 0) {
      if (!pushLine(current)) {
        break;
      }
      current = "";
      currentWidth = 0;
    }

    if (wordWidth <= maxWidth) {
      current = word;
      currentWidth = wordWidth;
      continue;
    }

    const splitWord = splitLongWordIntoLines(word);
    if (!splitWord) {
      break;
    }
    current = splitWord.remainder;
    currentWidth = splitWord.width;
  }

  if (!hasOverflow && current.length > 0) {
    pushLine(current);
  }

  if (lines.length === 0) {
    return { lines: [text], hasOverflow };
  }
  return { lines, hasOverflow };
}

function textAnnotationBoxMetrics(
  text: string,
  fontSize = BROWSER_TEXT_ANNOTATION_FONT_SIZE,
): BrowserTextAnnotationBoxMetrics {
  const cacheKey = `${fontSize}:${text}`;
  const cached = textAnnotationMetricsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const displayText = text.trim().length > 0 ? text : BROWSER_TEXT_ANNOTATION_PLACEHOLDER;
  const maxContentWidth =
    BROWSER_TEXT_ANNOTATION_BOX_MAX_WIDTH - BROWSER_TEXT_ANNOTATION_PADDING_X * 2;
  const lineWrap = textAnnotationLines(displayText, maxContentWidth, {
    maxLines: maxVisibleTextAnnotationLines(fontSize),
    measureText: (line) => measureTextAnnotationTextWidth(line, fontSize),
  });
  const lines = lineWrap.hasOverflow
    ? [...lineWrap.lines.slice(0, Math.max(0, lineWrap.lines.length - 1)), "… more text"]
    : lineWrap.lines;
  const contentWidth = lineWrap.hasOverflow
    ? maxContentWidth
    : lines.reduce(
        (maxWidth, line) => Math.max(maxWidth, measureTextAnnotationTextWidth(line, fontSize)),
        0,
      );
  const width = Math.ceil(
    Math.max(
      BROWSER_TEXT_ANNOTATION_BOX_MIN_WIDTH,
      Math.min(
        BROWSER_TEXT_ANNOTATION_BOX_MAX_WIDTH,
        contentWidth + BROWSER_TEXT_ANNOTATION_PADDING_X * 2,
      ),
    ),
  );
  const rawHeight = Math.max(
    BROWSER_TEXT_ANNOTATION_BOX_MIN_HEIGHT,
    lines.length * browserTextAnnotationLineHeight(fontSize) +
      BROWSER_TEXT_ANNOTATION_PADDING_Y * 2,
  );
  const height = Math.ceil(
    Math.max(
      BROWSER_TEXT_ANNOTATION_BOX_MIN_HEIGHT,
      Math.min(BROWSER_TEXT_ANNOTATION_BOX_MAX_HEIGHT, rawHeight),
    ),
  );
  const metrics = { width, height, lines, hasOverflow: lineWrap.hasOverflow };
  if (textAnnotationMetricsCache.size >= TEXT_ANNOTATION_METRICS_CACHE_MAX) {
    const oldestKey = textAnnotationMetricsCache.keys().next().value;
    if (oldestKey !== undefined) {
      textAnnotationMetricsCache.delete(oldestKey);
    }
  }
  textAnnotationMetricsCache.set(cacheKey, metrics);
  return metrics;
}

function browserTextAnnotationMetrics(
  annotation: BrowserTextAnnotation,
): BrowserTextAnnotationBoxMetrics {
  return textAnnotationBoxMetrics(annotation.text, browserTextAnnotationFontSize(annotation));
}

function textAnnotationBoxPosition(
  annotation: BrowserTextAnnotation,
  metrics = browserTextAnnotationMetrics(annotation),
): BrowserDrawingPoint {
  return {
    x: annotation.boxX ?? Math.max(8, annotation.x + BROWSER_TEXT_ANNOTATION_OFFSET_X),
    y:
      annotation.boxY ??
      Math.max(8, annotation.y - metrics.height - BROWSER_TEXT_ANNOTATION_ANCHOR_GAP),
  };
}

function clampTextAnnotationBoxPosition(
  position: BrowserDrawingPoint,
  overlay: HTMLElement | null,
  metrics: BrowserTextAnnotationBoxMetrics = textAnnotationBoxMetrics(""),
): BrowserDrawingPoint {
  const rect = overlay?.getBoundingClientRect();
  const maxX = rect ? Math.max(8, rect.width - metrics.width - 8) : position.x;
  const maxY = rect ? Math.max(8, rect.height - metrics.height - 8) : position.y;
  return {
    x: Math.max(8, Math.min(maxX, position.x)),
    y: Math.max(8, Math.min(maxY, position.y)),
  };
}

function textAnnotationHandlePoint(
  annotation: BrowserTextAnnotation,
  handle: BrowserAnnotationArrowHandle,
): BrowserDrawingPoint {
  const metrics = browserTextAnnotationMetrics(annotation);
  const position = textAnnotationBoxPosition(annotation, metrics);
  const left = position.x;
  const top = position.y;
  const centerX = left + metrics.width / 2;
  const centerY = top + metrics.height / 2;
  const right = left + metrics.width;
  const bottom = top + metrics.height;
  switch (handle) {
    case "top-left":
      return { x: left, y: top };
    case "top":
      return { x: centerX, y: top };
    case "top-right":
      return { x: right, y: top };
    case "right":
      return { x: right, y: centerY };
    case "bottom-right":
      return { x: right, y: bottom };
    case "bottom":
      return { x: centerX, y: bottom };
    case "bottom-left":
      return { x: left, y: bottom };
    case "left":
      return { x: left, y: centerY };
  }
  return { x: centerX, y: centerY };
}

function closestTextAnnotationHandle(
  annotation: BrowserTextAnnotation,
  point: BrowserDrawingPoint,
): BrowserAnnotationArrowHandle {
  let bestHandle: BrowserAnnotationArrowHandle = "top-left";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const handle of BROWSER_ANNOTATION_ARROW_HANDLES) {
    const handlePoint = textAnnotationHandlePoint(annotation, handle);
    const distance = Math.hypot(handlePoint.x - point.x, handlePoint.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestHandle = handle;
    }
  }
  return bestHandle;
}

function browserAnnotationArrowLength(arrow: BrowserAnnotationArrow): number {
  return Math.hypot(arrow.to.x - arrow.from.x, arrow.to.y - arrow.from.y);
}

function isBrowserAnnotationDeleteEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  if (event.key !== "Delete" && event.key !== "Backspace") {
    return false;
  }
  return !isEditableKeyboardEventTarget(event.target);
}

function isEditableKeyboardEventTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

function isBrowserEditorRestoreEvent(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.key.toLowerCase() === "z" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

function browserAnnotationArrowHeadPoints(
  arrow: BrowserAnnotationArrow,
  headLength = BROWSER_ANNOTATION_ARROW_HEAD_LENGTH,
): { left: BrowserDrawingPoint; right: BrowserDrawingPoint } {
  const angle = Math.atan2(arrow.to.y - arrow.from.y, arrow.to.x - arrow.from.x);
  return {
    left: {
      x: arrow.to.x - headLength * Math.cos(angle - BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
      y: arrow.to.y - headLength * Math.sin(angle - BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
    },
    right: {
      x: arrow.to.x - headLength * Math.cos(angle + BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
      y: arrow.to.y - headLength * Math.sin(angle + BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
    },
  };
}

interface BrowserAnnotationArrowSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function resolveBrowserAnnotationArrowSource(
  arrow: BrowserAnnotationArrow,
  textAnnotations: BrowserTextAnnotation[],
): BrowserAnnotationArrow {
  if (!arrow.sourceTextAnnotationId || !arrow.sourceHandle) {
    return arrow;
  }
  const sourceAnnotation = textAnnotations.find(
    (annotation) => annotation.id === arrow.sourceTextAnnotationId,
  );
  if (!sourceAnnotation) {
    return arrow;
  }
  return {
    ...arrow,
    from: textAnnotationHandlePoint(sourceAnnotation, arrow.sourceHandle),
  };
}

function resolveBrowserAnnotationArrowSources(
  arrows: BrowserAnnotationArrow[],
  textAnnotations: BrowserTextAnnotation[],
): BrowserAnnotationArrow[] {
  return arrows.map((arrow) => resolveBrowserAnnotationArrowSource(arrow, textAnnotations));
}

function browserAnnotationArrowSegments(
  arrow: BrowserAnnotationArrow,
): BrowserAnnotationArrowSegment[] {
  const head = browserAnnotationArrowHeadPoints(arrow);
  return [
    {
      x1: arrow.from.x,
      y1: arrow.from.y,
      x2: arrow.to.x,
      y2: arrow.to.y,
    },
    {
      x1: arrow.to.x,
      y1: arrow.to.y,
      x2: head.left.x,
      y2: head.left.y,
    },
    {
      x1: arrow.to.x,
      y1: arrow.to.y,
      x2: head.right.x,
      y2: head.right.y,
    },
  ];
}

function unionBrowserCaptureRect(
  current: BrowserCaptureRect | null,
  rect: BrowserCaptureRect,
): BrowserCaptureRect | null {
  if (rect.width < 0 || rect.height < 0) {
    return current;
  }
  if (!current) {
    return rect;
  }
  const left = Math.min(current.x, rect.x);
  const top = Math.min(current.y, rect.y);
  const right = Math.max(current.x + current.width, rect.x + rect.width);
  const bottom = Math.max(current.y + current.height, rect.y + rect.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function browserAnnotationViewportBounds(input: {
  selectedBox: BrowserInspectHoverBox | null;
  strokes: BrowserDrawingStroke[];
  textAnnotations: BrowserTextAnnotation[];
  arrows: BrowserAnnotationArrow[];
}): BrowserCaptureRect | null {
  let bounds: BrowserCaptureRect | null = null;
  const addRect = (rect: BrowserCaptureRect) => {
    bounds = unionBrowserCaptureRect(bounds, rect);
  };
  const addPoint = (point: BrowserDrawingPoint) => {
    addRect({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  if (input.selectedBox) {
    addRect(input.selectedBox);
  }
  for (const stroke of input.strokes) {
    for (const point of stroke.points) {
      addPoint(point);
    }
  }
  for (const annotation of input.textAnnotations) {
    const metrics = browserTextAnnotationMetrics(annotation);
    const position = textAnnotationBoxPosition(annotation, metrics);
    addPoint(annotation);
    addRect({ x: position.x, y: position.y, width: metrics.width, height: metrics.height });
  }
  for (const arrow of input.arrows) {
    if (browserAnnotationArrowLength(arrow) >= BROWSER_ARROW_MIN_LENGTH) {
      addPoint(arrow.from);
      addPoint(arrow.to);
    }
  }
  return bounds;
}

function clampBrowserNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function browserNeutralRangeStyle(value: number, min: number, max: number): CSSProperties {
  const percent = clampBrowserNumber(((value - min) / (max - min)) * 100, 0, 100);
  return {
    background: `linear-gradient(to right, rgba(248,250,252,0.96) 0%, rgba(226,232,240,0.92) ${percent}%, rgba(17,24,39,0.58) ${percent}%, rgba(17,24,39,0.58) 100%)`,
  };
}

function browserToolbarAnchorRectFromElement(
  element: HTMLElement | null,
): BrowserToolbarAnchorRect | null {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function browserToolbarAnchorRectsMatch(
  first: BrowserToolbarAnchorRect | null,
  second: BrowserToolbarAnchorRect | null,
): boolean {
  if (first === null || second === null) {
    return first === second;
  }
  return (
    Math.abs(first.left - second.left) < 0.5 &&
    Math.abs(first.top - second.top) < 0.5 &&
    Math.abs(first.width - second.width) < 0.5 &&
    Math.abs(first.height - second.height) < 0.5
  );
}

function browserToolbarFloatingPosition(
  rect: BrowserToolbarAnchorRect,
  input: {
    width: number;
    height: number;
    gap?: number;
  },
): { left: number; top: number } {
  const gap = input.gap ?? 8;
  const viewportWidth = typeof window === "undefined" ? rect.left + rect.width : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? rect.top + rect.height : window.innerHeight;
  const halfWidth = input.width / 2;
  const left = clampBrowserNumber(
    rect.left + rect.width / 2,
    8 + halfWidth,
    Math.max(8 + halfWidth, viewportWidth - 8 - halfWidth),
  );
  const preferredTop = rect.top + rect.height + gap;
  const top =
    preferredTop + input.height <= viewportHeight - 8
      ? preferredTop
      : Math.max(8, rect.top - input.height - gap);
  return { left, top };
}

function rectContainsBrowserRect(
  outer: BrowserCaptureRect,
  inner: BrowserCaptureRect,
  tolerance = 0,
): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function roundBrowserCaptureRect(
  rect: BrowserCaptureRect,
  documentWidth: number,
  documentHeight: number,
): BrowserCaptureRect {
  const width = Math.max(1, Math.min(documentWidth, Math.ceil(rect.width)));
  const height = Math.max(1, Math.min(documentHeight, Math.ceil(rect.height)));
  return {
    x: clampBrowserNumber(Math.floor(rect.x), 0, Math.max(0, documentWidth - width)),
    y: clampBrowserNumber(Math.floor(rect.y), 0, Math.max(0, documentHeight - height)),
    width,
    height,
  };
}

function browserAnnotationCaptureRect(input: {
  annotationBounds: BrowserCaptureRect | null;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
}): BrowserCaptureRect {
  const documentWidth = Math.max(1, Math.ceil(input.documentWidth));
  const documentHeight = Math.max(1, Math.ceil(input.documentHeight));
  const viewportWidth = Math.max(1, Math.min(documentWidth, Math.ceil(input.viewportWidth)));
  const viewportHeight = Math.max(1, Math.min(documentHeight, Math.ceil(input.viewportHeight)));
  const viewportRect = roundBrowserCaptureRect(
    {
      x: input.scrollX,
      y: input.scrollY,
      width: viewportWidth,
      height: viewportHeight,
    },
    documentWidth,
    documentHeight,
  );
  const fullPageIsSmall =
    documentWidth <= BROWSER_ANNOTATION_FULL_PAGE_MAX_DIMENSION &&
    documentHeight <= BROWSER_ANNOTATION_FULL_PAGE_MAX_DIMENSION &&
    documentWidth * documentHeight <= BROWSER_ANNOTATION_FULL_PAGE_MAX_AREA;

  if (fullPageIsSmall) {
    return { x: 0, y: 0, width: documentWidth, height: documentHeight };
  }
  if (!input.annotationBounds) {
    return viewportRect;
  }

  const pageBounds = {
    x: input.annotationBounds.x + input.scrollX,
    y: input.annotationBounds.y + input.scrollY,
    width: input.annotationBounds.width,
    height: input.annotationBounds.height,
  };
  if (rectContainsBrowserRect(viewportRect, pageBounds, 1)) {
    return viewportRect;
  }

  const padded = roundBrowserCaptureRect(
    {
      x: pageBounds.x - BROWSER_ANNOTATION_REGION_PADDING,
      y: pageBounds.y - BROWSER_ANNOTATION_REGION_PADDING,
      width: pageBounds.width + BROWSER_ANNOTATION_REGION_PADDING * 2,
      height: pageBounds.height + BROWSER_ANNOTATION_REGION_PADDING * 2,
    },
    documentWidth,
    documentHeight,
  );
  const width = Math.min(documentWidth, Math.max(padded.width, viewportWidth));
  const height = Math.min(documentHeight, Math.max(padded.height, viewportHeight));
  return roundBrowserCaptureRect(
    {
      x: padded.x + padded.width / 2 - width / 2,
      y: padded.y + padded.height / 2 - height / 2,
      width,
      height,
    },
    documentWidth,
    documentHeight,
  );
}

function drawCanvasAnnotationArrowPath(
  context: CanvasRenderingContext2D,
  input: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    headLength: number;
  },
): void {
  const angle = Math.atan2(input.toY - input.fromY, input.toX - input.fromX);
  context.beginPath();
  context.moveTo(input.fromX, input.fromY);
  context.lineTo(input.toX, input.toY);
  context.moveTo(input.toX, input.toY);
  context.lineTo(
    input.toX - input.headLength * Math.cos(angle - BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
    input.toY - input.headLength * Math.sin(angle - BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
  );
  context.moveTo(input.toX, input.toY);
  context.lineTo(
    input.toX - input.headLength * Math.cos(angle + BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
    input.toY - input.headLength * Math.sin(angle + BROWSER_ANNOTATION_ARROW_HEAD_ANGLE),
  );
}

function svgFragmentId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function gradientColorsForStroke(index: number): readonly string[] {
  return BROWSER_DRAWING_GRADIENT_COLOR_SETS[index % BROWSER_DRAWING_GRADIENT_COLOR_SETS.length]!;
}

const BROWSER_GRADIENT_STOP_OFFSETS = ["0%", "24%", "48%", "72%", "100%"] as const;

function closedGradientColors(colors: readonly string[]): string {
  const firstColor = colors[0];
  return firstColor ? [...colors, firstColor].join(";") : "";
}

function shiftedClosedGradientColors(colors: readonly string[], shift: number): string {
  return closedGradientColors(colors.map((_, index) => colors[(index + shift) % colors.length]!));
}

function browserGradientStopColorValues(colors: readonly string[]): string[] {
  return BROWSER_GRADIENT_STOP_OFFSETS.map((_, index) =>
    shiftedClosedGradientColors(colors, index),
  );
}

interface BrowserGradientRenderData {
  gradientId: string;
  colors: readonly string[];
  stopColorValues: string[];
  animationBegin: string;
}

interface BrowserDrawStrokeRenderItem extends BrowserGradientRenderData {
  stroke: BrowserDrawingStroke;
  points: string;
  isActive: boolean;
  animated: boolean;
  contrastStrokeWidth: number;
  gradientStrokeWidth: number;
  glintStrokeWidth: number;
}

interface BrowserAnnotationArrowRenderItem extends BrowserGradientRenderData {
  arrow: BrowserAnnotationArrow;
  segments: BrowserAnnotationArrowSegment[];
}

function drawingStrokePoints(stroke: BrowserDrawingStroke): string {
  return stroke.points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

function appendDrawingPoint(
  stroke: BrowserDrawingStroke,
  point: BrowserDrawingPoint,
  minDistance = BROWSER_DRAWING_MIN_POINT_DISTANCE,
): boolean {
  const previousPoint = stroke.points.at(-1);
  if (
    previousPoint &&
    Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y) < minDistance
  ) {
    return false;
  }
  stroke.points.push(point);
  return true;
}

function revokeComposerImagePreviewUrl(previewUrl: string): void {
  if (previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(previewUrl);
  }
}

function imageFromBytes(bytes: Uint8Array, mimeType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const bytesCopy = new Uint8Array(bytes.byteLength);
    bytesCopy.set(bytes);
    const url = URL.createObjectURL(new Blob([bytesCopy.buffer], { type: mimeType }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read the browser screenshot."));
    };
    image.src = url;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Couldn't encode the annotated browser screenshot."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function screenshotResultFromBytes(input: {
  bytes: Uint8Array;
  name: string;
}): BrowserCaptureScreenshotResult {
  return {
    name: input.name,
    mimeType: "image/png",
    sizeBytes: input.bytes.byteLength,
    bytes: input.bytes,
  };
}

interface BrowserPageScreenshot {
  screenshot: BrowserCaptureScreenshotResult;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  captureX: number;
  captureY: number;
  captureWidth: number;
  captureHeight: number;
}

interface BrowserCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CdpLayoutMetricsResult {
  cssContentSize?: {
    width?: number;
    height?: number;
  };
  contentSize?: {
    width?: number;
    height?: number;
  };
  visualViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
    width?: number;
    height?: number;
  };
  cssVisualViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
    width?: number;
    height?: number;
  };
}

interface BrowserPageMetrics {
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pageMetricsFromCdp(value: unknown): {
  documentWidth: number | null;
  documentHeight: number | null;
  scrollX: number;
  scrollY: number;
  viewportWidth: number | null;
  viewportHeight: number | null;
} {
  const metrics = value as CdpLayoutMetricsResult | null;
  const visualViewport = metrics?.cssVisualViewport ?? metrics?.visualViewport;
  return {
    documentWidth:
      readPositiveNumber(metrics?.cssContentSize?.width) ??
      readPositiveNumber(metrics?.contentSize?.width),
    documentHeight:
      readPositiveNumber(metrics?.cssContentSize?.height) ??
      readPositiveNumber(metrics?.contentSize?.height),
    scrollX: readPositiveNumber(visualViewport?.pageX) ?? 0,
    scrollY: readPositiveNumber(visualViewport?.pageY) ?? 0,
    viewportWidth:
      readPositiveNumber(visualViewport?.clientWidth) ?? readPositiveNumber(visualViewport?.width),
    viewportHeight:
      readPositiveNumber(visualViewport?.clientHeight) ??
      readPositiveNumber(visualViewport?.height),
  };
}

function browserPageMetricsExpression(): string {
  return `(() => {
    const root = document.documentElement;
    const body = document.body;
    const visual = window.visualViewport;
    const positive = (value) => Number.isFinite(value) && value > 0 ? value : null;
    const finite = (value) => Number.isFinite(value) ? value : null;
    const viewportWidth = positive(visual && visual.width) || positive(window.innerWidth) || positive(root && root.clientWidth) || 1;
    const viewportHeight = positive(visual && visual.height) || positive(window.innerHeight) || positive(root && root.clientHeight) || 1;
    const scrollX = finite(visual && visual.pageLeft) ?? finite(window.scrollX) ?? finite(root && root.scrollLeft) ?? 0;
    const scrollY = finite(visual && visual.pageTop) ?? finite(window.scrollY) ?? finite(root && root.scrollTop) ?? 0;
    const documentWidth = Math.max(
      viewportWidth,
      positive(root && root.scrollWidth) || 0,
      positive(root && root.clientWidth) || 0,
      positive(body && body.scrollWidth) || 0,
      positive(body && body.clientWidth) || 0
    );
    const documentHeight = Math.max(
      viewportHeight,
      positive(root && root.scrollHeight) || 0,
      positive(root && root.clientHeight) || 0,
      positive(body && body.scrollHeight) || 0,
      positive(body && body.clientHeight) || 0
    );
    return { documentWidth, documentHeight, scrollX, scrollY, viewportWidth, viewportHeight };
  })()`;
}

function pageMetricsFromRuntimeValue(value: unknown): BrowserPageMetrics | null {
  const metrics = value as Partial<BrowserPageMetrics> | null;
  const viewportWidth = readPositiveNumber(metrics?.viewportWidth);
  const viewportHeight = readPositiveNumber(metrics?.viewportHeight);
  if (!viewportWidth || !viewportHeight) {
    return null;
  }
  return {
    documentWidth: Math.max(
      viewportWidth,
      readPositiveNumber(metrics?.documentWidth) ?? viewportWidth,
    ),
    documentHeight: Math.max(
      viewportHeight,
      readPositiveNumber(metrics?.documentHeight) ?? viewportHeight,
    ),
    scrollX: readFiniteNumber(metrics?.scrollX) ?? 0,
    scrollY: readFiniteNumber(metrics?.scrollY) ?? 0,
    viewportWidth,
    viewportHeight,
  };
}

function fallbackDocumentPageMetrics(input: {
  document: Document;
  window: Window;
}): BrowserPageMetrics {
  const element = input.document.documentElement;
  const body = input.document.body;
  const viewportWidth = input.window.innerWidth || element.clientWidth;
  const viewportHeight = input.window.innerHeight || element.clientHeight;
  return {
    documentWidth: Math.ceil(Math.max(element.scrollWidth, viewportWidth, body?.scrollWidth ?? 0)),
    documentHeight: Math.ceil(
      Math.max(element.scrollHeight, viewportHeight, body?.scrollHeight ?? 0),
    ),
    scrollX: input.window.scrollX,
    scrollY: input.window.scrollY,
    viewportWidth,
    viewportHeight,
  };
}

function browserAnnotationOverlaySize(input: {
  overlay: HTMLElement | null;
  viewport: HTMLElement | null;
  fallbackWidth: number;
  fallbackHeight: number;
}): { width: number; height: number } {
  const overlayRect = input.overlay?.getBoundingClientRect();
  const viewportRect = input.viewport?.getBoundingClientRect();
  return {
    width: Math.max(1, overlayRect?.width ?? viewportRect?.width ?? input.fallbackWidth),
    height: Math.max(1, overlayRect?.height ?? viewportRect?.height ?? input.fallbackHeight),
  };
}

function browserAnnotationGeometryFromMetrics(input: {
  overlay: HTMLElement | null;
  viewport: HTMLElement | null;
  metrics: BrowserPageMetrics;
}): BrowserAnnotationCoordinateGeometry {
  const overlaySize = browserAnnotationOverlaySize({
    overlay: input.overlay,
    viewport: input.viewport,
    fallbackWidth: input.metrics.viewportWidth,
    fallbackHeight: input.metrics.viewportHeight,
  });
  return {
    overlayWidth: overlaySize.width,
    overlayHeight: overlaySize.height,
    viewportWidth: Math.max(1, input.metrics.viewportWidth),
    viewportHeight: Math.max(1, input.metrics.viewportHeight),
  };
}

function browserAnnotationGeometryFromViewport(input: {
  overlay: HTMLElement | null;
  viewport: HTMLElement | null;
  viewportSize: BrowserViewport;
}): BrowserAnnotationCoordinateGeometry {
  const viewportWidth = Math.max(1, input.viewportSize.width);
  const viewportHeight = Math.max(1, input.viewportSize.height);
  const overlaySize = browserAnnotationOverlaySize({
    overlay: input.overlay,
    viewport: input.viewport,
    fallbackWidth: viewportWidth,
    fallbackHeight: viewportHeight,
  });
  return {
    overlayWidth: overlaySize.width,
    overlayHeight: overlaySize.height,
    viewportWidth,
    viewportHeight,
  };
}

function resolveFallbackCaptureDocument(frame: HTMLIFrameElement): {
  document: Document;
  window: Window;
  cleanup: () => void;
} {
  if (frame.contentDocument && frame.contentWindow) {
    return {
      document: frame.contentDocument,
      window: frame.contentWindow,
      cleanup: () => {},
    };
  }

  throw new Error(
    "Fallback annotation screenshots need a same-origin page. Use the desktop browser for cross-origin pages.",
  );
}

function cssColorHasPaint(value: string): boolean {
  if (!value || value === "transparent") {
    return false;
  }
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return !normalized.endsWith(",0)") && !normalized.endsWith("/0)") && !normalized.endsWith("/0");
}

function parseCssPixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fallbackCanvasRect(input: { rect: DOMRect; window: Window }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: input.rect.left + input.window.scrollX,
    y: input.rect.top + input.window.scrollY,
    width: input.rect.width,
    height: input.rect.height,
  };
}

function roundedCanvasPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const nextRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  const roundedContext = context as CanvasRenderingContext2D & {
    roundRect?: (
      x: number,
      y: number,
      width: number,
      height: number,
      radii?: number | DOMPointInit | Iterable<number | DOMPointInit>,
    ) => void;
  };
  if (typeof roundedContext.roundRect === "function") {
    roundedContext.roundRect(x, y, width, height, nextRadius);
    return;
  }
  context.moveTo(x + nextRadius, y);
  context.lineTo(x + width - nextRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + nextRadius);
  context.lineTo(x + width, y + height - nextRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - nextRadius, y + height);
  context.lineTo(x + nextRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - nextRadius);
  context.lineTo(x, y + nextRadius);
  context.quadraticCurveTo(x, y, x + nextRadius, y);
}

function fillFallbackRect(
  context: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
  color: string,
): void {
  context.save();
  context.fillStyle = color;
  roundedCanvasPath(context, rect.x, rect.y, rect.width, rect.height, radius);
  context.fill();
  context.restore();
}

function strokeFallbackRect(
  context: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
  width: number,
  color: string,
): void {
  if (width <= 0 || !cssColorHasPaint(color)) {
    return;
  }
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  roundedCanvasPath(
    context,
    rect.x + width / 2,
    rect.y + width / 2,
    Math.max(0, rect.width - width),
    Math.max(0, rect.height - width),
    Math.max(0, radius - width / 2),
  );
  context.stroke();
  context.restore();
}

function elementLooksRenderable(style: CSSStyleDeclaration, rect: DOMRect): boolean {
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    Number.parseFloat(style.opacity || "1") > 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function fallbackElementShouldBeSkipped(element: Element): boolean {
  return [
    "AREA",
    "BASE",
    "BR",
    "HEAD",
    "LINK",
    "META",
    "NOSCRIPT",
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    "TITLE",
  ].includes(element.tagName);
}

function drawFallbackElementBox(input: {
  context: CanvasRenderingContext2D;
  element: Element;
  window: Window;
}): void {
  if (fallbackElementShouldBeSkipped(input.element)) {
    return;
  }
  const style = input.window.getComputedStyle(input.element);
  const rect = input.element.getBoundingClientRect();
  if (!elementLooksRenderable(style, rect)) {
    return;
  }
  const canvasRect = fallbackCanvasRect({ rect, window: input.window });
  const radius = parseCssPixel(style.borderTopLeftRadius);
  const backgroundColor = style.backgroundColor;
  if (cssColorHasPaint(backgroundColor)) {
    fillFallbackRect(input.context, canvasRect, radius, backgroundColor);
  }

  const borderWidth = Math.max(
    parseCssPixel(style.borderTopWidth),
    parseCssPixel(style.borderRightWidth),
    parseCssPixel(style.borderBottomWidth),
    parseCssPixel(style.borderLeftWidth),
  );
  const borderColor = style.borderTopColor || style.borderColor;
  strokeFallbackRect(input.context, canvasRect, radius, borderWidth, borderColor);

  const ownerWindow = input.element.ownerDocument.defaultView;
  if (
    ownerWindow &&
    input.element instanceof ownerWindow.HTMLImageElement &&
    input.element.complete &&
    input.element.naturalWidth > 0
  ) {
    try {
      const imageUrl = new URL(
        input.element.currentSrc || input.element.src,
        ownerWindow.location.href,
      );
      const canDrawImage =
        imageUrl.origin === ownerWindow.location.origin ||
        imageUrl.protocol === "data:" ||
        imageUrl.protocol === "blob:";
      if (canDrawImage) {
        input.context.drawImage(
          input.element,
          canvasRect.x,
          canvasRect.y,
          canvasRect.width,
          canvasRect.height,
        );
      }
    } catch {
      // Ignore decorative image failures; the fallback painter must remain exportable.
    }
  }
}

function cssFontForText(style: CSSStyleDeclaration): string {
  return [
    style.fontStyle || "normal",
    style.fontVariant || "normal",
    style.fontWeight || "400",
    style.fontSize || "16px",
    style.fontFamily || "sans-serif",
  ].join(" ");
}

function transformFallbackText(text: string, transform: string): string {
  if (transform === "uppercase") {
    return text.toUpperCase();
  }
  if (transform === "lowercase") {
    return text.toLowerCase();
  }
  if (transform === "capitalize") {
    return text.replace(/\b\p{L}/gu, (character) => character.toUpperCase());
  }
  return text;
}

function drawFallbackTextNode(input: {
  context: CanvasRenderingContext2D;
  node: Text;
  window: Window;
}): void {
  const rawText = input.node.nodeValue ?? "";
  const normalizedText = rawText.replace(/\s+/g, " ").trim();
  const parent = input.node.parentElement;
  if (!normalizedText || !parent || fallbackElementShouldBeSkipped(parent)) {
    return;
  }

  const style = input.window.getComputedStyle(parent);
  const parentRect = parent.getBoundingClientRect();
  if (!elementLooksRenderable(style, parentRect) || !cssColorHasPaint(style.color)) {
    return;
  }

  const range = input.node.ownerDocument.createRange();
  range.selectNodeContents(input.node);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  range.detach();
  if (rects.length === 0) {
    return;
  }

  input.context.save();
  input.context.font = cssFontForText(style);
  input.context.fillStyle = style.color;
  input.context.textBaseline = "alphabetic";

  const words = transformFallbackText(normalizedText, style.textTransform).split(/\s+/);
  let wordIndex = 0;
  for (const rect of rects) {
    if (wordIndex >= words.length) {
      break;
    }
    const canvasRect = fallbackCanvasRect({ rect, window: input.window });
    const maxWidth = Math.max(0, canvasRect.width + 2);
    let line = "";
    while (wordIndex < words.length) {
      const nextWord = words[wordIndex]!;
      const candidate = line ? `${line} ${nextWord}` : nextWord;
      if (line && input.context.measureText(candidate).width > maxWidth) {
        break;
      }
      line = candidate;
      wordIndex += 1;
      if (input.context.measureText(line).width >= maxWidth) {
        break;
      }
    }
    if (!line) {
      continue;
    }
    const fontSize = parseCssPixel(style.fontSize) || Math.max(10, canvasRect.height * 0.72);
    const baselineY =
      canvasRect.y + Math.min(canvasRect.height - 1, (canvasRect.height + fontSize) / 2);
    input.context.fillText(line, canvasRect.x, baselineY, maxWidth);
  }

  input.context.restore();
}

function drawFallbackDomNode(input: {
  context: CanvasRenderingContext2D;
  node: Node;
  window: Window;
  visited: { count: number };
}): void {
  if (input.visited.count > BROWSER_FALLBACK_CAPTURE_MAX_NODES) {
    return;
  }
  input.visited.count += 1;

  if (input.node.nodeType === Node.TEXT_NODE) {
    drawFallbackTextNode({
      context: input.context,
      node: input.node as Text,
      window: input.window,
    });
    return;
  }

  if (input.node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  const element = input.node as Element;
  drawFallbackElementBox({
    context: input.context,
    element,
    window: input.window,
  });

  for (const child of Array.from(element.childNodes)) {
    drawFallbackDomNode({
      context: input.context,
      node: child,
      window: input.window,
      visited: input.visited,
    });
  }
}

function fallbackPageBackground(document: Document, window: Window): string {
  const bodyColor = document.body ? window.getComputedStyle(document.body).backgroundColor : "";
  if (cssColorHasPaint(bodyColor)) {
    return bodyColor;
  }
  const rootColor = window.getComputedStyle(document.documentElement).backgroundColor;
  return cssColorHasPaint(rootColor) ? rootColor : "#ffffff";
}

async function captureFallbackFramePageScreenshot(
  frame: HTMLIFrameElement,
  annotationBounds: BrowserCaptureRect | null,
): Promise<BrowserPageScreenshot> {
  const captureDocument = resolveFallbackCaptureDocument(frame);
  try {
    const metrics = fallbackDocumentPageMetrics(captureDocument);
    const captureRect = browserAnnotationCaptureRect({
      annotationBounds,
      documentWidth: metrics.documentWidth,
      documentHeight: metrics.documentHeight,
      scrollX: metrics.scrollX,
      scrollY: metrics.scrollY,
      viewportWidth: metrics.viewportWidth || frame.clientWidth || metrics.documentWidth,
      viewportHeight: metrics.viewportHeight || frame.clientHeight || metrics.documentHeight,
    });
    const fitScale = Math.min(
      1,
      BROWSER_ANNOTATION_SCREENSHOT_MAX_DIMENSION / captureRect.width,
      BROWSER_ANNOTATION_SCREENSHOT_MAX_DIMENSION / captureRect.height,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(captureRect.width * fitScale));
    canvas.height = Math.max(1, Math.round(captureRect.height * fitScale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Couldn't compose the fallback page screenshot.");
    }

    context.save();
    context.scale(fitScale, fitScale);
    context.translate(-captureRect.x, -captureRect.y);
    context.fillStyle = fallbackPageBackground(captureDocument.document, captureDocument.window);
    context.fillRect(captureRect.x, captureRect.y, captureRect.width, captureRect.height);
    drawFallbackDomNode({
      context,
      node: captureDocument.document.documentElement,
      window: captureDocument.window,
      visited: { count: 0 },
    });
    context.restore();

    const bytes = await blobToBytes(await canvasToPngBlob(canvas));
    return {
      screenshot: screenshotResultFromBytes({
        bytes,
        name: BROWSER_ANNOTATION_SCREENSHOT_NAME,
      }),
      ...metrics,
      captureX: captureRect.x,
      captureY: captureRect.y,
      captureWidth: captureRect.width,
      captureHeight: captureRect.height,
    };
  } finally {
    captureDocument.cleanup();
  }
}

function drawCanvasPolyline(
  context: CanvasRenderingContext2D,
  stroke: BrowserDrawingStroke,
  input: {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
  },
): void {
  const firstPoint = stroke.points[0];
  if (!firstPoint || stroke.points.length < 2) {
    return;
  }
  context.beginPath();
  context.moveTo(
    (firstPoint.x + input.offsetX) * input.scaleX,
    (firstPoint.y + input.offsetY) * input.scaleY,
  );
  for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
    const point = stroke.points[pointIndex]!;
    context.lineTo(
      (point.x + input.offsetX) * input.scaleX,
      (point.y + input.offsetY) * input.scaleY,
    );
  }
}

function browserCanvasTextAnnotationPalette(): {
  fill: string;
  stroke: string;
  text: string;
  overflowText: string;
  shadow: string;
} {
  const isDark = document.documentElement.classList.contains("dark");
  return isDark
    ? {
        fill: "rgba(15, 23, 42, 0.78)",
        stroke: "rgba(255, 255, 255, 0.18)",
        text: "#ffffff",
        overflowText: "rgba(255, 255, 255, 0.68)",
        shadow: "rgba(0, 0, 0, 0.24)",
      }
    : {
        fill: "rgba(255, 255, 255, 0.62)",
        stroke: "rgba(15, 23, 42, 0.12)",
        text: "rgb(15, 23, 42)",
        overflowText: "rgba(15, 23, 42, 0.62)",
        shadow: "rgba(15, 23, 42, 0.18)",
      };
}

function drawCanvasTextAnnotation(
  context: CanvasRenderingContext2D,
  annotation: BrowserTextAnnotation,
  input: {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    fitScale: number;
  },
): void {
  const text = annotation.text.trim();
  if (text.length === 0) {
    return;
  }
  const metrics = browserTextAnnotationMetrics(annotation);
  const baseFontSize = browserTextAnnotationFontSize(annotation);
  const fontSize = Math.max(10, baseFontSize * input.scaleY);
  const paddingX = BROWSER_TEXT_ANNOTATION_PADDING_X * input.scaleX;
  const lineHeight = browserTextAnnotationLineHeight(baseFontSize) * input.scaleY;
  const radius = Math.max(6, 7 * input.fitScale);
  const boxPosition = textAnnotationBoxPosition(annotation, metrics);
  const boxWidth = metrics.width * input.scaleX;
  const boxHeight = metrics.height * input.scaleY;
  const boxX = (boxPosition.x + input.offsetX) * input.scaleX;
  const boxY = (boxPosition.y + input.offsetY) * input.scaleY;

  context.save();
  const palette = browserCanvasTextAnnotationPalette();
  context.font = `${BROWSER_TEXT_ANNOTATION_FONT_WEIGHT} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;

  context.globalCompositeOperation = "source-over";
  context.fillStyle = palette.fill;
  context.shadowColor = palette.shadow;
  context.shadowBlur = 24 * input.fitScale;
  context.shadowOffsetY = 10 * input.fitScale;
  roundedCanvasPath(context, boxX, boxY, boxWidth, boxHeight, radius);
  context.fill();
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetY = 0;
  context.strokeStyle = palette.stroke;
  context.lineWidth = Math.max(1, 1.5 * input.fitScale);
  context.stroke();

  context.fillStyle = palette.text;
  context.textBaseline = "top";
  const textBlockHeight = metrics.lines.length * lineHeight;
  const textY = boxY + Math.max(0, (boxHeight - textBlockHeight) / 2);
  for (const [lineIndex, line] of metrics.lines.entries()) {
    context.fillStyle =
      metrics.hasOverflow && lineIndex === metrics.lines.length - 1
        ? palette.overflowText
        : palette.text;
    context.fillText(
      line,
      boxX + paddingX,
      textY + lineIndex * lineHeight,
      Math.max(24, boxWidth - paddingX * 2),
    );
  }
  context.restore();
}

function drawCanvasAnnotationArrow(
  context: CanvasRenderingContext2D,
  arrow: BrowserAnnotationArrow,
  input: {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    fitScale: number;
    gradientIndex: number;
  },
): void {
  if (browserAnnotationArrowLength(arrow) < BROWSER_ARROW_MIN_LENGTH) {
    return;
  }
  const fromX = (arrow.from.x + input.offsetX) * input.scaleX;
  const fromY = (arrow.from.y + input.offsetY) * input.scaleY;
  const toX = (arrow.to.x + input.offsetX) * input.scaleX;
  const toY = (arrow.to.y + input.offsetY) * input.scaleY;
  const headLength = Math.max(7, BROWSER_ANNOTATION_ARROW_HEAD_LENGTH * input.fitScale);
  const colors = gradientColorsForStroke(input.gradientIndex);
  const gradient = context.createLinearGradient(fromX, fromY, toX || fromX + 1, toY || fromY + 1);
  colors.forEach((color, colorIndex) => {
    gradient.addColorStop(colors.length === 1 ? 0 : colorIndex / (colors.length - 1), color);
  });

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalCompositeOperation = "difference";
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(2, BROWSER_DRAWING_CONTRAST_STROKE_WIDTH * input.fitScale);
  drawCanvasAnnotationArrowPath(context, { fromX, fromY, toX, toY, headLength });
  context.stroke();
  context.restore();

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = gradient;
  context.lineWidth = Math.max(1.5, BROWSER_DRAWING_GRADIENT_STROKE_WIDTH * input.fitScale);
  drawCanvasAnnotationArrowPath(context, { fromX, fromY, toX, toY, headLength });
  context.stroke();
  context.restore();

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.globalCompositeOperation = "difference";
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(1, BROWSER_DRAWING_GLINT_STROKE_WIDTH * input.fitScale);
  context.globalAlpha = 0.72;
  drawCanvasAnnotationArrowPath(context, { fromX, fromY, toX, toY, headLength });
  context.stroke();
  context.restore();
}

async function composeAnnotatedBrowserScreenshot(input: {
  page: BrowserPageScreenshot;
  strokes: BrowserDrawingStroke[];
  textAnnotations: BrowserTextAnnotation[];
  arrows: BrowserAnnotationArrow[];
  selectedBox: BrowserInspectHoverBox | null;
}): Promise<BrowserCaptureScreenshotResult> {
  const pageImage = await imageFromBytes(
    input.page.screenshot.bytes,
    input.page.screenshot.mimeType,
  );
  const fitScale = Math.min(
    1,
    BROWSER_ANNOTATION_SCREENSHOT_MAX_DIMENSION / pageImage.naturalWidth,
    BROWSER_ANNOTATION_SCREENSHOT_MAX_DIMENSION / pageImage.naturalHeight,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pageImage.naturalWidth * fitScale));
  canvas.height = Math.max(1, Math.round(pageImage.naturalHeight * fitScale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Couldn't compose the annotated browser screenshot.");
  }

  context.drawImage(pageImage, 0, 0, canvas.width, canvas.height);
  const cssWidth = input.page.captureWidth || input.page.documentWidth || pageImage.naturalWidth;
  const cssHeight =
    input.page.captureHeight || input.page.documentHeight || pageImage.naturalHeight;
  const scaleX = canvas.width / cssWidth;
  const scaleY = canvas.height / cssHeight;
  const offsetX = input.page.scrollX - input.page.captureX;
  const offsetY = input.page.scrollY - input.page.captureY;

  if (input.selectedBox) {
    const boxX = (input.selectedBox.x + offsetX) * scaleX;
    const boxY = (input.selectedBox.y + offsetY) * scaleY;
    const boxWidth = input.selectedBox.width * scaleX;
    const boxHeight = input.selectedBox.height * scaleY;
    context.save();
    context.fillStyle = "rgba(34, 211, 238, 0.24)";
    context.strokeStyle = "rgba(8, 145, 178, 0.95)";
    context.lineWidth = Math.max(1, 1.5 * fitScale);
    context.fillRect(boxX, boxY, boxWidth, boxHeight);
    context.strokeRect(boxX, boxY, boxWidth, boxHeight);
    context.globalCompositeOperation = "difference";
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(2, 3 * fitScale);
    context.strokeRect(boxX, boxY, boxWidth, boxHeight);
    context.restore();
  }

  for (const [strokeIndex, stroke] of input.strokes.entries()) {
    if (stroke.points.length < 2) {
      continue;
    }
    const colors = gradientColorsForStroke(strokeIndex);
    const widths = browserDrawingStrokeWidths(stroke);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of stroke.points) {
      const x = (point.x + offsetX) * scaleX;
      const y = (point.y + offsetY) * scaleY;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const gradient = context.createLinearGradient(minX, minY, maxX || minX + 1, maxY || minY + 1);
    colors.forEach((color, colorIndex) => {
      gradient.addColorStop(colors.length === 1 ? 0 : colorIndex / (colors.length - 1), color);
    });

    context.save();
    drawCanvasPolyline(context, stroke, { offsetX, offsetY, scaleX, scaleY });
    context.globalCompositeOperation = "difference";
    context.strokeStyle = BROWSER_DRAWING_CONTRAST_STROKE_COLOR;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(2, widths.contrast * fitScale);
    context.stroke();
    context.restore();

    context.save();
    drawCanvasPolyline(context, stroke, { offsetX, offsetY, scaleX, scaleY });
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = gradient;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1.5, widths.gradient * fitScale);
    context.stroke();
    context.restore();

    context.save();
    drawCanvasPolyline(context, stroke, { offsetX, offsetY, scaleX, scaleY });
    context.globalCompositeOperation = "difference";
    context.strokeStyle = BROWSER_DRAWING_CONTRAST_STROKE_COLOR;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1, widths.glint * fitScale);
    context.globalAlpha = 0.72;
    context.stroke();
    context.restore();
  }

  for (const [arrowIndex, arrow] of input.arrows.entries()) {
    drawCanvasAnnotationArrow(context, arrow, {
      offsetX,
      offsetY,
      scaleX,
      scaleY,
      fitScale,
      gradientIndex: input.strokes.length + arrowIndex,
    });
  }

  for (const annotation of input.textAnnotations) {
    drawCanvasTextAnnotation(context, annotation, {
      offsetX,
      offsetY,
      scaleX,
      scaleY,
      fitScale,
    });
  }

  const bytes = await blobToBytes(await canvasToPngBlob(canvas));
  return screenshotResultFromBytes({
    bytes,
    name: BROWSER_ANNOTATION_SCREENSHOT_NAME,
  });
}

function ignoreBrowserWebviewDetachError(): void {
  // Renderer webview detach is best-effort cleanup; a stale/destroyed guest is already gone.
}

function setBrowserWebviewOverlayOcclusion(
  webview: BrowserWebviewElement | null,
  occluded: boolean,
): void {
  if (!webview) {
    return;
  }
  webview.style.visibility = occluded ? "hidden" : "visible";
  webview.style.pointerEvents = occluded ? "none" : "auto";
}

function isVisibleOverlayElement(element: HTMLElement): boolean {
  const styles = window.getComputedStyle(element);
  if (styles.display === "none" || styles.visibility === "hidden" || styles.opacity === "0") {
    return false;
  }
  return element.getClientRects().length > 0;
}

function isNativeBrowserNonObscuringOverlayElement(element: HTMLElement): boolean {
  return (
    element.closest("[data-slot='toast-popup']") === null &&
    element.closest(NATIVE_BROWSER_NON_OBSCURING_OVERLAY_SELECTOR) !== null
  );
}

const NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
] as const;

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function candidateObscuresNativeBrowser(candidate: HTMLElement, element: HTMLElement): boolean {
  if (candidate === element || candidate.contains(element) || element.contains(candidate)) {
    return false;
  }
  if (!isVisibleOverlayElement(candidate)) {
    return false;
  }

  const elementRect = element.getBoundingClientRect();
  const candidateRects = candidate.getClientRects();
  for (const candidateRect of candidateRects) {
    if (rectsIntersect(elementRect, candidateRect)) {
      return true;
    }
  }

  return false;
}

function hasTopLayerDomObstruction(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  for (const [xRatio, yRatio] of NATIVE_BROWSER_OVERLAY_SAMPLE_POINTS) {
    const x = rect.left + rect.width * xRatio;
    const y = rect.top + rect.height * yRatio;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      continue;
    }

    const hitElements = document.elementsFromPoint(x, y);
    for (const hitElement of hitElements) {
      if (!(hitElement instanceof HTMLElement)) {
        continue;
      }
      if (hitElement === element || element.contains(hitElement) || hitElement.contains(element)) {
        continue;
      }
      if (isNativeBrowserNonObscuringOverlayElement(hitElement)) {
        continue;
      }
      if (!isVisibleOverlayElement(hitElement)) {
        continue;
      }
      return true;
    }
  }

  return false;
}

function hasNativeBrowserObscuringOverlay(element: HTMLElement): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR,
  );
  for (const candidate of candidates) {
    if (candidateObscuresNativeBrowser(candidate, element)) {
      return true;
    }
  }

  return hasTopLayerDomObstruction(element);
}

function isNativeBrowserTransitionSignalTarget(
  target: EventTarget | null,
  viewportElement: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (viewportElement.contains(target) || target.contains(viewportElement)) {
    return true;
  }

  return (
    target.closest(NATIVE_BROWSER_OBSCURING_OVERLAY_SELECTOR) !== null ||
    target.closest("[data-slot='sidebar-container']") !== null ||
    target.closest("[data-slot='sheet-popup']") !== null
  );
}

function isBrowserPerfLoggingEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return (
      window.localStorage.getItem("synara:browser-perf") === "1" ||
      window.localStorage.getItem("dpcode:browser-perf") === "1" ||
      window.localStorage.getItem("t3code:browser-perf") === "1"
    );
  } catch {
    return false;
  }
}

// Keeps a restored browser pane visually occupied while the live webview hydrates.
function BrowserRuntimePreview(props: { title: string; detail: string }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background/35 p-6"
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3 rounded-full" />
            <Skeleton className="h-2.5 w-full rounded-full" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-lg" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-8 rounded-md" />
            <Skeleton className="h-8 rounded-md" />
            <Skeleton className="h-8 rounded-md" />
          </div>
        </div>
        <div className="mt-4 min-w-0 text-center">
          <p className="text-xs font-medium text-foreground">Restoring browser</p>
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={props.detail}>
            {props.title}
          </p>
        </div>
      </div>
    </div>
  );
}

function browserLocalServerUrl(server: ServerLocalServerProcess): string | null {
  const addressWithUrl = server.addresses.find((address) => address.url);
  if (addressWithUrl?.url) {
    return addressWithUrl.url;
  }

  const port = server.ports[0];
  if (!port) {
    return null;
  }
  return `http://localhost:${port}/`;
}

// Paints a tiny browser-preview tile without fetching screenshots or adding network work.
// The page name and address are rendered into the tile so it reads as a real preview.
function BrowserLocalServerThumbnail({ server }: { server: ServerLocalServerProcess }) {
  const label = localServerPrimaryLabel(server);
  const port = server.ports[0];

  return (
    <span
      aria-hidden="true"
      className="flex h-12 w-[4.5rem] shrink-0 flex-col gap-1 overflow-hidden rounded-md border border-white/12 bg-[#f7f7f2] p-1.5 shadow-[0_4px_12px_rgba(0,0,0,0.28)]"
    >
      <span className="flex gap-[3px]">
        <span className="size-[3px] rounded-full bg-[#ff6b65]" />
        <span className="size-[3px] rounded-full bg-[#f4c047]" />
        <span className="size-[3px] rounded-full bg-[#45cf77]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="truncate text-[7px] font-bold leading-none text-[#2a2a2a]">{label}</span>
        {port ? (
          <span className="truncate text-[6px] font-medium leading-none text-[#9a9a9a]">
            localhost:{port}
          </span>
        ) : null}
      </span>
    </span>
  );
}

// Replaces about:blank with a local-server launcher so the browser never opens to white.
function BrowserLocalServersHome({
  activeTabId,
  loading,
  onNavigate,
  onRefresh,
  servers,
}: {
  activeTabId: string | null;
  loading: boolean;
  onNavigate: (url: string, tabId: string | null) => void;
  onRefresh: () => void;
  servers: readonly ServerLocalServerProcess[];
}) {
  const hasServers = servers.length > 0;

  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-[#0d0d0d] text-white">
      <div className="mx-auto flex h-full w-full max-w-[52rem] flex-col px-8 py-9">
        <div className="flex shrink-0 items-center justify-between">
          <p className="text-[15px] font-medium text-white/35">Local</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 text-white/35 hover:bg-white/[0.06] hover:text-white/70"
            disabled={loading}
            onClick={onRefresh}
            aria-label="Refresh local servers"
            title="Refresh local servers"
          >
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>

        {!hasServers ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
            {loading ? (
              <>
                <RefreshCwIcon className="mb-4 size-12 animate-spin text-white/20" />
                <p className="text-base font-semibold text-white">Scanning local servers</p>
                <p className="mt-2 text-sm text-white/35">Checking localhost ports</p>
              </>
            ) : (
              <>
                <GlobeIcon className="mb-4 size-16 stroke-[1.5] text-white/30" />
                <p className="text-base font-semibold text-white">No local servers</p>
                <p className="mt-2 text-sm text-white/35">Try another browser URL</p>
              </>
            )}
          </div>
        ) : (
          <div className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-6">
            {servers.map((server) => {
              const url = browserLocalServerUrl(server);

              return (
                <button
                  key={server.id}
                  type="button"
                  disabled={!url}
                  onClick={() => {
                    if (url) {
                      onNavigate(url, activeTabId);
                    }
                  }}
                  className="group grid w-full shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl border border-white/[0.07] px-3 py-2.5 text-left transition-colors hover:border-white/[0.14] hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <BrowserLocalServerThumbnail server={server} />
                  <LocalServerIdentity server={server} tone="browser" />
                  <span
                    className="mr-1 size-2 rounded-full bg-[#36d07b] shadow-[0_0_0_2.5px_rgba(54,208,123,0.16)]"
                    aria-hidden
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function BrowserPanel({
  mode,
  threadId,
  onClosePanel,
  runtimeMode = "live",
  onRequestLive,
  variant = "browser",
}: BrowserPanelProps) {
  const api = readNativeApi();
  const isLiveRuntime = runtimeMode === "live";
  const isLiveEditorVariant = variant === "live-editor";
  const threadBrowserState = useZustandStore(
    useBrowserStateStore,
    selectThreadBrowserState(threadId),
  );
  const recentHistory = useZustandStore(useBrowserStateStore, selectThreadBrowserHistory(threadId));
  const upsertThreadState = useBrowserStateStore((store) => store.upsertThreadState);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const composerDraftImageCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.images.length ?? 0,
  );
  const composerDraftFileCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.files.length ?? 0,
  );
  const composerDraftAssistantSelectionCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.assistantSelections.length ?? 0,
  );
  const composerBrowserContextCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.browserContexts.length ?? 0,
  );
  const serverThread = useAppStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useAppStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const previewCwd =
    serverThread?.worktreePath ?? draftThread?.worktreePath ?? activeProject?.cwd ?? null;
  const previewState = usePreviewStateStore(selectPreviewState(previewCwd));
  const upsertPreviewState = usePreviewStateStore((store) => store.upsertState);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const browserTabsBarRef = useRef<HTMLDivElement>(null);
  const browserViewportRef = useRef<HTMLDivElement>(null);
  const browserFallbackFrameRef = useRef<HTMLIFrameElement>(null);
  const browserWebviewRef = useRef<BrowserWebviewElement | null>(null);
  const browserWebviewTabIdRef = useRef<string | null>(null);
  const browserWebviewAttachKeyRef = useRef<string | null>(null);
  const copyScreenshotButtonRef = useRef<HTMLButtonElement>(null);
  const addressDraftsByTabIdRef = useRef(new Map<string, string>());
  const lastSyncedAddressByTabIdRef = useRef(new Map<string, string>());
  const previousActiveTabIdRef = useRef<string | null>(null);
  const previousComposerBrowserContextCountRef = useRef(composerBrowserContextCount);
  const browserHadTabsRef = useRef(false);
  const lastSentBoundsRef = useRef<string | null>(null);
  const lastMeasuredBoundsKeyRef = useRef<string | null>(null);
  const lastOverlayObscuredRef = useRef(false);
  const isAddressEditingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const boundsBurstFrameRef = useRef<number | null>(null);
  const inspectFrameRef = useRef<number | null>(null);
  const inspectPointRef = useRef<{ x: number; y: number } | null>(null);
  const inspectHoverInFlightRef = useRef(false);
  const inspectHoverQueuedRef = useRef(false);
  const inspectHoverRequestIdRef = useRef(0);
  const editorModeRef = useRef<BrowserEditorMode>("browse");
  const activeDrawStrokeRef = useRef<BrowserDrawingStroke | null>(null);
  const activeDrawPointerIdRef = useRef<number | null>(null);
  const activeDrawOverlayRectRef = useRef<DOMRect | null>(null);
  const activeDrawContrastPolylineRef = useRef<SVGPolylineElement | null>(null);
  const activeDrawGradientPolylineRef = useRef<SVGPolylineElement | null>(null);
  const activeDrawGlintPolylineRef = useRef<SVGPolylineElement | null>(null);
  const drawStrokesRef = useRef<BrowserDrawingStroke[]>([]);
  const textAnnotationsRef = useRef<BrowserTextAnnotation[]>([]);
  const annotationArrowsRef = useRef<BrowserAnnotationArrow[]>([]);
  const selectedElementContextRef = useRef<BrowserElementEditorContext | null>(null);
  const browserEditorOverlayRef = useRef<HTMLDivElement>(null);
  const textAnnotationInputRef = useRef<HTMLTextAreaElement>(null);
  const editTextAnnotationInputRef = useRef<HTMLTextAreaElement>(null);
  const textAnnotationDragRef = useRef<{
    id: string;
    pointerId: number;
    metrics: BrowserTextAnnotationBoxMetrics;
    startClientX: number;
    startClientY: number;
    startBoxX: number;
    startBoxY: number;
    pendingBoxX: number;
    pendingBoxY: number;
    frameId: number | null;
  } | null>(null);
  const arrowDraftDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const arrowTargetDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const arrowSourceDragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const annotationArrowDraftRef = useRef<BrowserAnnotationArrow | null>(null);
  const annotationArrowDraftFrameRef = useRef<number | null>(null);
  const textAnnotationEditCancelledRef = useRef(false);
  const hoveredTextAnnotationIdRef = useRef<string | null>(null);
  const textAnnotationHoverHideTimeoutRef = useRef<number | null>(null);
  const annotationArrowHoverHideTimeoutRef = useRef<number | null>(null);
  const toolOptionsHoverTimeoutRef = useRef<number | null>(null);
  const toolOptionsCloseTimeoutRef = useRef<number | null>(null);
  const editorToolbarButtonRefs = useRef<Record<BrowserEditorMode, HTMLButtonElement | null>>({
    browse: null,
    inspect: null,
    draw: null,
    text: null,
  });
  const liveEditorToolbarStripRef = useRef<HTMLDivElement | null>(null);
  const annotationUpdateTimeoutRef = useRef<number | null>(null);
  const annotationUpdateRequestIdRef = useRef(0);
  const annotationUpdateRunningRef = useRef(false);
  const annotationUpdateQueuedRef = useRef(false);
  const annotationUpdateDisposedRef = useRef(false);
  const annotationStateInitializedRef = useRef(false);
  const editorClearUndoSnapshotRef = useRef<BrowserEditorVisibleStateSnapshot | null>(null);
  const stylePreviewRuntimeKeysByTabRef = useRef(new Map<string, string>());
  const stylePreviewTargetRef = useRef<{ selector: string; tabId: string; url: string } | null>(
    null,
  );
  const previousStyleTargetKeyRef = useRef<string>("");
  const editorPageKeyRef = useRef<string>("");
  const previewAutoStartedCwdRef = useRef<string | null>(null);
  const previewLastRoutedKeyRef = useRef<string | null>(null);
  const previewPendingNavigationUrlRef = useRef<string | null>(null);
  const previewSourceReloadTimeoutRef = useRef<number | null>(null);
  const burstFramesRemainingRef = useRef(0);
  const burstStableFramesRef = useRef(0);
  const perfCountersRef = useRef<BrowserViewportPerfCounters>({
    syncAttempts: 0,
    syncSkips: 0,
    syncSends: 0,
    resizeSchedules: 0,
    resizeScheduleSkips: 0,
    burstStarts: 0,
    burstExtensions: 0,
    burstFrames: 0,
    transitionSignals: 0,
    ignoredTransitionSignals: 0,
  });
  const [addressValue, setAddressValue] = useState("");
  const [isAddressFocused, setIsAddressFocused] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<BrowserEditorMode>("browse");
  const [inspectHoverBox, setInspectHoverBox] = useState<BrowserInspectHoverBox | null>(null);
  const [drawStrokes, setDrawStrokes] = useState<BrowserDrawingStroke[]>([]);
  const [activeDrawStroke, setActiveDrawStroke] = useState<BrowserDrawingStroke | null>(null);
  const [textAnnotations, setTextAnnotations] = useState<BrowserTextAnnotation[]>([]);
  const [annotationArrows, setAnnotationArrows] = useState<BrowserAnnotationArrow[]>([]);
  const [annotationArrowDraft, setAnnotationArrowDraft] = useState<BrowserAnnotationArrow | null>(
    null,
  );
  const [selectedTextAnnotationId, setSelectedTextAnnotationId] = useState<string | null>(null);
  const [selectedAnnotationArrowId, setSelectedAnnotationArrowId] = useState<string | null>(null);
  const [hoveredTextAnnotationId, setHoveredTextAnnotationId] = useState<string | null>(null);
  const [hoveredAnnotationArrowId, setHoveredAnnotationArrowId] = useState<string | null>(null);
  const [draggingTextAnnotationId, setDraggingTextAnnotationId] = useState<string | null>(null);
  const [editingTextAnnotationId, setEditingTextAnnotationId] = useState<string | null>(null);
  const [editingTextAnnotationValue, setEditingTextAnnotationValue] = useState("");
  const [textAnnotationDraft, setTextAnnotationDraft] = useState<BrowserTextAnnotation | null>(
    null,
  );
  const [selectedElementContext, setSelectedElementContext] =
    useState<BrowserElementEditorContext | null>(null);
  const [stylePropertiesPanelOpen, setStylePropertiesPanelOpen] = useState(false);
  const [inlineTextEditor, setInlineTextEditor] = useState<BrowserInlineTextEditorState | null>(
    null,
  );
  const [stylePanelPositionOverride, setStylePanelPositionOverride] =
    useState<BrowserStylePanelPosition | null>(null);
  const [styleEditorInitialPatch, setStyleEditorInitialPatch] =
    useState<BrowserElementStylePatch | null>(null);
  const [stylePanelDragging, setStylePanelDragging] = useState(false);
  const stylePanelElementRef = useRef<HTMLDivElement | null>(null);
  const stylePreviewFrameRef = useRef<number | null>(null);
  const stylePreviewPendingPatchRef = useRef<BrowserElementStylePatch | null>(null);
  const stylePreviewApplyingRef = useRef(false);
  const stylePreviewLastRequestedKeyRef = useRef("");
  const stylePreviewActivePatchRef = useRef<BrowserElementStylePatch | null>(null);
  const stylePreviewReapplyFrameRef = useRef<number | null>(null);
  const stylePanelDragPositionRef = useRef<BrowserStylePanelPosition | null>(null);
  const inlineTextEditorRef = useRef<BrowserInlineTextEditorState | null>(null);
  const browserEditorFocusedRef = useRef(false);
  const browserEditorPointerInsideRef = useRef(false);
  const [autoAttachAnnotationScreenshot, setAutoAttachAnnotationScreenshot] = useState(true);
  const [browserEditorFocused, setBrowserEditorFocused] = useState(false);
  const [browserEditorPointerInside, setBrowserEditorPointerInside] = useState(false);
  const [showEditorShortcutHints, setShowEditorShortcutHints] = useState(false);
  const [openToolOptions, setOpenToolOptions] = useState<BrowserToolOptionsPanel | null>(null);
  const [editorToolbarAnchorRects, setEditorToolbarAnchorRects] = useState<
    Record<BrowserEditorMode, BrowserToolbarAnchorRect | null>
  >({
    browse: null,
    inspect: null,
    draw: null,
    text: null,
  });
  const [editorToolbarStripRect, setEditorToolbarStripRect] =
    useState<BrowserToolbarAnchorRect | null>(null);
  const [drawStrokeSize, setDrawStrokeSize] = useState(BROWSER_DRAWING_GRADIENT_STROKE_WIDTH);
  const [drawStrokeAnimated, setDrawStrokeAnimated] = useState(true);
  const [textAnnotationFontSize, setTextAnnotationFontSize] = useState(
    BROWSER_TEXT_ANNOTATION_FONT_SIZE,
  );
  const [previewActionPending, setPreviewActionPending] = useState(false);
  const hasNativeBrowserBridge =
    typeof window !== "undefined" && window.desktopBridge !== undefined;
  const canUseNativeBrowserSurface = isLiveRuntime && hasNativeBrowserBridge;
  const runtimeReady = isLiveRuntime ? workspaceReady : true;
  const activeTab =
    threadBrowserState?.tabs.find((tab) => tab.id === threadBrowserState.activeTabId) ??
    threadBrowserState?.tabs[0] ??
    null;
  const loading = activeTab?.isLoading ?? false;
  const activeTabIsBlank = isBlankBrowserTabUrl(activeTab);
  const showLocalServersHome = isLiveRuntime && workspaceReady && (!activeTab || activeTabIsBlank);
  const localServersQuery = useQuery(serverLocalServersQueryOptions(showLocalServersHome));
  const activeTabStatus = activeTab?.status ?? "suspended";
  const browserChromeStatus = resolveBrowserChromeStatus({
    localError,
    threadLastError: threadBrowserState?.lastError,
    activeTabStatus: showLocalServersHome ? "live" : activeTabStatus,
    hasActiveTab: activeTab !== null,
    workspaceReady: runtimeReady,
  });
  const browserAddressSuggestions = buildBrowserAddressSuggestions({
    query: addressValue,
    activeTabId: activeTab?.id ?? null,
    tabs: threadBrowserState?.tabs ?? [],
    recentHistory,
  });
  const showBrowserAddressSuggestions =
    isLiveRuntime && isAddressFocused && browserAddressSuggestions.length > 0 && runtimeReady;

  const requestLiveRuntime = useCallback(() => {
    onRequestLive?.();
  }, [onRequestLive]);

  const ensureLiveRuntime = useCallback(() => {
    if (isLiveRuntime) {
      return true;
    }
    requestLiveRuntime();
    return false;
  }, [isLiveRuntime, requestLiveRuntime]);

  const runBrowserAction = useCallback(async <T,>(action: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await action();
      setLocalError(null);
      return result;
    } catch (error) {
      setLocalError(formatBrowserActionError(error));
      return null;
    }
  }, []);

  const navigateBrowserToPreviewUrl = useCallback(
    async (url: string, targetCwd?: string | null) => {
      if (!api || !previewCwd) {
        return;
      }
      const target = {
        threadId,
        cwd: previewCwd,
        projectId: activeProjectId,
        targetCwd: targetCwd ?? previewState?.targetCwd ?? null,
        url,
      };
      previewLastRoutedKeyRef.current = liveEditPreviewRouteKey(target);
      const state = await openLiveEditPreviewTab(api, target);
      upsertThreadState(state);
    },
    [activeProjectId, api, previewCwd, previewState?.targetCwd, threadId, upsertThreadState],
  );

  const routeCurrentProjectPreview = useCallback(
    async (url: string, targetCwd?: string | null) => {
      if (!api || !previewCwd) {
        return;
      }
      const target = {
        threadId,
        cwd: previewCwd,
        projectId: activeProjectId,
        targetCwd: targetCwd ?? null,
        url,
      };
      const routeKey = liveEditPreviewRouteKey(target);
      if (previewLastRoutedKeyRef.current === routeKey) {
        return;
      }
      previewLastRoutedKeyRef.current = routeKey;
      const state = await openLiveEditPreviewTab(api, target);
      upsertThreadState(state);
    },
    [activeProjectId, api, previewCwd, threadId, upsertThreadState],
  );

  const startPreview = useCallback(
    async (options: { autoNavigate?: boolean; silentIfUnavailable?: boolean } = {}) => {
      if (!api || !previewCwd) {
        return null;
      }
      setPreviewActionPending(true);
      try {
        const state = await api.preview.start({
          threadId,
          cwd: previewCwd,
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
        });
        upsertPreviewState(state);
        setLocalError(null);
        if (options.autoNavigate !== false && state.url) {
          previewPendingNavigationUrlRef.current = state.url;
          await navigateBrowserToPreviewUrl(state.url, state.targetCwd ?? null);
        }
        return state;
      } catch (error) {
        const message = formatEditorActionError(error, "Couldn't complete that preview action.");
        const shouldSuppressUnavailableError =
          options.silentIfUnavailable === true &&
          (message.includes("No package.json preview script found") ||
            message.includes("No frontend preview target found"));
        if (!shouldSuppressUnavailableError) {
          setLocalError(message);
        }
        return null;
      } finally {
        setPreviewActionPending(false);
      }
    },
    [activeProjectId, api, navigateBrowserToPreviewUrl, previewCwd, threadId, upsertPreviewState],
  );

  const stopPreview = useCallback(async () => {
    if (!api || !previewCwd) {
      return;
    }
    setPreviewActionPending(true);
    try {
      const { previewStates, closedStates } = await stopLiveEditPreview(api, {
        threadId,
        cwds: [previewCwd],
        projectId: activeProjectId,
      });
      const state = previewStates.at(-1);
      if (state) {
        upsertPreviewState(state);
      }
      for (const closedState of closedStates) {
        upsertThreadState(closedState);
      }
      setLocalError(null);
    } catch (error) {
      setLocalError(formatEditorActionError(error, "Couldn't complete that preview action."));
    } finally {
      setPreviewActionPending(false);
    }
  }, [activeProjectId, api, previewCwd, threadId, upsertPreviewState, upsertThreadState]);

  const restartPreview = useCallback(async () => {
    if (!api || !previewCwd) {
      return;
    }
    setPreviewActionPending(true);
    try {
      const state = await api.preview.restart({
        threadId,
        cwd: previewCwd,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      });
      upsertPreviewState(state);
      setLocalError(null);
      if (state.url) {
        previewPendingNavigationUrlRef.current = state.url;
        await navigateBrowserToPreviewUrl(state.url, state.targetCwd ?? null);
      }
    } catch (error) {
      setLocalError(formatEditorActionError(error, "Couldn't complete that preview action."));
    } finally {
      setPreviewActionPending(false);
    }
  }, [activeProjectId, api, navigateBrowserToPreviewUrl, previewCwd, threadId, upsertPreviewState]);

  const readBrowserPageMetrics = useCallback(async (): Promise<BrowserPageMetrics> => {
    if (!api || !activeTab) {
      throw new Error("No browser tab is available.");
    }

    if (hasNativeBrowserBridge) {
      const viewportRect = browserViewportRef.current?.getBoundingClientRect();
      const viewportWidth = Math.ceil(viewportRect?.width ?? window.innerWidth);
      const viewportHeight = Math.ceil(viewportRect?.height ?? window.innerHeight);
      const fallbackMetrics: BrowserPageMetrics = {
        documentWidth: viewportWidth,
        documentHeight: viewportHeight,
        scrollX: 0,
        scrollY: 0,
        viewportWidth,
        viewportHeight,
      };
      try {
        const runtimeResponse = (await api.browser.executeCdp({
          threadId,
          tabId: activeTab.id,
          method: "Runtime.evaluate",
          params: {
            expression: browserPageMetricsExpression(),
            returnByValue: true,
            awaitPromise: false,
          },
        })) as RuntimeEvaluateResult;
        const runtimeMetrics = pageMetricsFromRuntimeValue(runtimeResponse.result?.value);
        if (runtimeMetrics) {
          return runtimeMetrics;
        }
      } catch {
        // Fall back to Page.getLayoutMetrics below; some pages can block Runtime evaluation.
      }
      try {
        const metricsResponse = await api.browser.executeCdp({
          threadId,
          tabId: activeTab.id,
          method: "Page.getLayoutMetrics",
        });
        const cdpMetrics = pageMetricsFromCdp(metricsResponse);
        return {
          documentWidth: cdpMetrics.documentWidth ?? viewportWidth,
          documentHeight: cdpMetrics.documentHeight ?? viewportHeight,
          scrollX: cdpMetrics.scrollX,
          scrollY: cdpMetrics.scrollY,
          viewportWidth: cdpMetrics.viewportWidth ?? viewportWidth,
          viewportHeight: cdpMetrics.viewportHeight ?? viewportHeight,
        };
      } catch {
        return fallbackMetrics;
      }
    }

    const frame = browserFallbackFrameRef.current;
    if (!frame) {
      throw new Error("No browser fallback frame is available.");
    }
    const captureDocument = resolveFallbackCaptureDocument(frame);
    try {
      return fallbackDocumentPageMetrics(captureDocument);
    } finally {
      captureDocument.cleanup();
    }
  }, [activeTab, api, hasNativeBrowserBridge, threadId]);

  const captureBrowserPageScreenshot = useCallback(
    async (
      annotationBounds: BrowserCaptureRect | null,
      pageMetrics?: BrowserPageMetrics,
    ): Promise<BrowserPageScreenshot> => {
      if (!api || !activeTab) {
        throw new Error("No browser tab is available to capture.");
      }

      if (hasNativeBrowserBridge) {
        const metrics = pageMetrics ?? (await readBrowserPageMetrics());
        const viewportScreenshot = await api.browser.captureScreenshot({
          threadId,
          tabId: activeTab.id,
        });
        const captureRect = roundBrowserCaptureRect(
          {
            x: metrics.scrollX,
            y: metrics.scrollY,
            width: metrics.viewportWidth,
            height: metrics.viewportHeight,
          },
          metrics.documentWidth,
          metrics.documentHeight,
        );
        return {
          screenshot: {
            ...viewportScreenshot,
            name: BROWSER_ANNOTATION_SCREENSHOT_NAME,
          },
          documentWidth: metrics.documentWidth,
          documentHeight: metrics.documentHeight,
          scrollX: metrics.scrollX,
          scrollY: metrics.scrollY,
          viewportWidth: metrics.viewportWidth,
          viewportHeight: metrics.viewportHeight,
          captureX: captureRect.x,
          captureY: captureRect.y,
          captureWidth: captureRect.width,
          captureHeight: captureRect.height,
        };
      }

      const frame = browserFallbackFrameRef.current;
      if (!frame) {
        throw new Error("No browser fallback frame is available to capture.");
      }
      return captureFallbackFramePageScreenshot(frame, annotationBounds);
    },
    [activeTab, api, hasNativeBrowserBridge, readBrowserPageMetrics, threadId],
  );

  const runBrowserAnnotationAttachmentUpdate = useCallback(
    async (requestId: number) => {
      const usableStrokes = drawStrokesRef.current.filter((stroke) => stroke.points.length > 1);
      const usableTextAnnotations = textAnnotationsRef.current.filter(
        (annotation) => annotation.text.trim().length > 0,
      );
      const usableArrows = resolveBrowserAnnotationArrowSources(
        annotationArrowsRef.current,
        usableTextAnnotations,
      ).filter((arrow) => browserAnnotationArrowLength(arrow) >= BROWSER_ARROW_MIN_LENGTH);
      const selectedContext = selectedElementContextRef.current;
      const hasVisualAnnotations =
        usableStrokes.length > 0 || usableTextAnnotations.length > 0 || usableArrows.length > 0;
      if (!hasVisualAnnotations && !selectedContext) {
        return;
      }

      const draftStore = useComposerDraftStore.getState();
      const currentDraft = draftStore.draftsByThreadId[threadId];
      const existingAnnotationImages = (currentDraft?.images ?? []).filter(
        (image) => image.source === BROWSER_ANNOTATION_ATTACHMENT_SOURCE,
      );
      if (!hasVisualAnnotations && selectedContext) {
        for (const image of existingAnnotationImages) {
          draftStore.removeImage(threadId, image.id);
        }
        draftStore.clearBrowserContexts(threadId);
        const promptBlock = buildBrowserSelectionPromptBlock(selectedContext);
        const context = {
          id: randomUUID(),
          type: "browser-context",
          source: "browser-selection",
          promptBlock,
          title: selectedContext.title || activeTab?.title || "Browser selection",
          url:
            selectedContext.url ||
            activeTab?.lastCommittedUrl ||
            activeTab?.url ||
            BROWSER_BLANK_URL,
          strokeCount: 0,
          textCount: 0,
          ...(selectedContext.selector ? { selectedSelector: selectedContext.selector } : {}),
        } satisfies ComposerBrowserContextAttachment;
        draftStore.addBrowserContext(threadId, context);
        draftStore.setPrompt(
          threadId,
          removeBrowserAnnotationContextPrompt(currentDraft?.prompt ?? ""),
        );
        setLocalError(null);
        return;
      }
      if (!api || !activeTab) {
        setLocalError("Live editor context will attach after the browser tab is ready.");
        return;
      }
      const effectiveAttachmentCount =
        (currentDraft?.images.length ?? 0) -
        existingAnnotationImages.length +
        (currentDraft?.files.length ?? 0) +
        (currentDraft?.browserContexts.length ?? 0) +
        composerDraftAssistantSelectionCount;
      if (
        existingAnnotationImages.length === 0 &&
        effectiveAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        setLocalError(
          `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
        );
        return;
      }

      try {
        if (
          annotationUpdateDisposedRef.current ||
          annotationUpdateRequestIdRef.current !== requestId
        ) {
          return;
        }
        const selectedBox = selectedContext
          ? {
              x: selectedContext.rect.x,
              y: selectedContext.rect.y,
              width: selectedContext.rect.width,
              height: selectedContext.rect.height,
              label: selectedContext.selector || selectedContext.tagName.toLowerCase(),
            }
          : null;
        const pageMetrics = await readBrowserPageMetrics();
        const annotationGeometry = browserAnnotationGeometryFromMetrics({
          overlay: browserEditorOverlayRef.current,
          viewport: browserViewportRef.current,
          metrics: pageMetrics,
        });
        const viewportAnnotations = convertBrowserOverlayAnnotationsToViewport({
          geometry: annotationGeometry,
          strokes: usableStrokes,
          textAnnotations: usableTextAnnotations,
          arrows: usableArrows,
        });
        const annotationBounds = browserAnnotationViewportBounds({
          selectedBox,
          strokes: viewportAnnotations.strokes,
          textAnnotations: viewportAnnotations.textAnnotations,
          arrows: viewportAnnotations.arrows,
        });
        const page = await captureBrowserPageScreenshot(annotationBounds, pageMetrics);
        if (
          annotationUpdateDisposedRef.current ||
          annotationUpdateRequestIdRef.current !== requestId
        ) {
          return;
        }
        const annotatedScreenshot = await composeAnnotatedBrowserScreenshot({
          page,
          strokes: viewportAnnotations.strokes,
          textAnnotations: viewportAnnotations.textAnnotations,
          arrows: viewportAnnotations.arrows,
          selectedBox,
        });
        if (
          annotationUpdateDisposedRef.current ||
          annotationUpdateRequestIdRef.current !== requestId
        ) {
          return;
        }
        if (annotatedScreenshot.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          setLocalError(
            `'${BROWSER_ANNOTATION_SCREENSHOT_NAME}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`,
          );
          return;
        }
        const annotationUrl = activeTab.lastCommittedUrl ?? activeTab.url ?? BROWSER_BLANK_URL;
        const annotationTitle = activeTab.title ?? "";
        const metadataBlock = buildBrowserDrawingPromptBlock({
          source: BROWSER_ANNOTATION_ATTACHMENT_SOURCE,
          url: annotationUrl,
          title: annotationTitle,
          viewport: {
            width: pageMetrics.viewportWidth,
            height: pageMetrics.viewportHeight,
            devicePixelRatio: window.devicePixelRatio,
          },
          document: {
            width: page.documentWidth,
            height: page.documentHeight,
          },
          scroll: {
            x: page.scrollX,
            y: page.scrollY,
          },
          capture: {
            x: page.captureX,
            y: page.captureY,
            width: page.captureWidth,
            height: page.captureHeight,
          },
          selectedSelector: selectedContext?.selector ?? null,
          selectedElement: selectedContext,
          strokes: viewportAnnotations.strokes,
          textAnnotations: viewportAnnotations.textAnnotations,
          arrows: viewportAnnotations.arrows,
        });
        const image = composerImageFromBrowserScreenshot(annotatedScreenshot, {
          name: BROWSER_ANNOTATION_SCREENSHOT_NAME,
          source: BROWSER_ANNOTATION_ATTACHMENT_SOURCE,
          browserAnnotation: {
            promptBlock: metadataBlock,
            title: annotationTitle,
            url: annotationUrl,
            strokeCount: usableStrokes.length,
            textCount: usableTextAnnotations.length,
            arrowCount: usableArrows.length,
            ...(selectedContext?.selector ? { selectedSelector: selectedContext.selector } : {}),
          },
        });
        if (
          annotationUpdateDisposedRef.current ||
          annotationUpdateRequestIdRef.current !== requestId
        ) {
          revokeComposerImagePreviewUrl(image.previewUrl);
          return;
        }

        const latestStore = useComposerDraftStore.getState();
        const latestDraft = latestStore.draftsByThreadId[threadId];
        for (const existingImage of latestDraft?.images ?? []) {
          if (existingImage.source === BROWSER_ANNOTATION_ATTACHMENT_SOURCE) {
            latestStore.removeImage(threadId, existingImage.id);
          }
        }
        latestStore.addImage(threadId, image);
        latestStore.setPrompt(
          threadId,
          removeBrowserAnnotationContextPrompt(latestDraft?.prompt ?? ""),
        );
        setLocalError(null);
      } catch (error) {
        if (
          annotationUpdateDisposedRef.current ||
          annotationUpdateRequestIdRef.current !== requestId
        ) {
          return;
        }
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : (formatBrowserActionError(error) ?? "Couldn't attach the live editor context.");
        setLocalError(message);
      }
    },
    [
      activeTab,
      api,
      captureBrowserPageScreenshot,
      composerDraftAssistantSelectionCount,
      readBrowserPageMetrics,
      threadId,
    ],
  );

  const queueBrowserAnnotationAttachmentUpdate = useCallback(async () => {
    annotationUpdateQueuedRef.current = true;
    if (annotationUpdateRunningRef.current) {
      return;
    }
    annotationUpdateRunningRef.current = true;
    try {
      while (annotationUpdateQueuedRef.current && !annotationUpdateDisposedRef.current) {
        annotationUpdateQueuedRef.current = false;
        await runBrowserAnnotationAttachmentUpdate(annotationUpdateRequestIdRef.current);
      }
    } finally {
      annotationUpdateRunningRef.current = false;
    }
  }, [runBrowserAnnotationAttachmentUpdate]);

  const updateBrowserAnnotationAttachment = useCallback(async () => {
    annotationUpdateRequestIdRef.current += 1;
    if (annotationUpdateTimeoutRef.current !== null) {
      window.clearTimeout(annotationUpdateTimeoutRef.current);
      annotationUpdateTimeoutRef.current = null;
    }
    await queueBrowserAnnotationAttachmentUpdate();
  }, [queueBrowserAnnotationAttachmentUpdate]);

  const scheduleBrowserAnnotationAttachmentUpdate = useCallback(
    (delay = BROWSER_ANNOTATION_SCREENSHOT_DEBOUNCE_MS) => {
      annotationUpdateRequestIdRef.current += 1;
      if (annotationUpdateTimeoutRef.current !== null) {
        window.clearTimeout(annotationUpdateTimeoutRef.current);
        annotationUpdateTimeoutRef.current = null;
      }
      if (!autoAttachAnnotationScreenshot) {
        return;
      }
      annotationUpdateTimeoutRef.current = window.setTimeout(() => {
        annotationUpdateTimeoutRef.current = null;
        void queueBrowserAnnotationAttachmentUpdate();
      }, delay);
    },
    [autoAttachAnnotationScreenshot, queueBrowserAnnotationAttachmentUpdate],
  );

  const readElementHoverContextAtPoint = useCallback(
    async (point: BrowserDrawingPoint): Promise<BrowserInspectHoverBox | null> => {
      if (!api || !activeTab) {
        return null;
      }
      if (!hasNativeBrowserBridge) {
        const frame = browserFallbackFrameRef.current;
        if (!frame) {
          return null;
        }
        try {
          const frameDocument = frame.contentDocument;
          const frameWindow = frame.contentWindow;
          if (!frameDocument || !frameWindow) {
            return null;
          }
          const frameMetrics = fallbackDocumentPageMetrics({
            document: frameDocument,
            window: frameWindow,
          });
          const pagePoint = browserOverlayPointToViewportPoint(
            point,
            browserAnnotationGeometryFromMetrics({
              overlay: browserEditorOverlayRef.current,
              viewport: browserViewportRef.current,
              metrics: frameMetrics,
            }),
          );
          const context = readBrowserElementHoverContextFromDocumentAtPoint({
            document: frameDocument,
            point: pagePoint,
          });
          return context
            ? {
                x: context.rect.x,
                y: context.rect.y,
                width: context.rect.width,
                height: context.rect.height,
                label: context.selector || context.tagName.toLowerCase(),
                viewport: context.viewport,
              }
            : null;
        } catch {
          setLocalError(
            "Inspect needs the desktop app for cross-origin pages. Same-origin mock pages still work here.",
          );
          return null;
        }
      }
      const overlaySize = browserAnnotationOverlaySize({
        overlay: browserEditorOverlayRef.current,
        viewport: browserViewportRef.current,
        fallbackWidth: window.innerWidth,
        fallbackHeight: window.innerHeight,
      });
      const response = (await api.browser.executeCdp({
        threadId,
        tabId: activeTab.id,
        method: "Runtime.evaluate",
        params: {
          expression: cdpElementHoverContextExpression(point.x, point.y, {
            overlayWidth: overlaySize.width,
            overlayHeight: overlaySize.height,
          }),
          returnByValue: true,
          awaitPromise: false,
        },
      })) as RuntimeEvaluateResult;
      const value = response.result?.value;
      if (!isBrowserElementHoverContext(value)) {
        return null;
      }
      return {
        x: value.rect.x,
        y: value.rect.y,
        width: value.rect.width,
        height: value.rect.height,
        label: value.selector || value.tagName.toLowerCase(),
        viewport: value.viewport,
      };
    },
    [activeTab, api, hasNativeBrowserBridge, threadId],
  );

  const readElementContextAtPoint = useCallback(
    async (point: BrowserDrawingPoint): Promise<BrowserElementEditorContext | null> => {
      if (!api || !activeTab) {
        return null;
      }
      if (!hasNativeBrowserBridge) {
        const frame = browserFallbackFrameRef.current;
        if (!frame) {
          return null;
        }
        try {
          const frameDocument = frame.contentDocument;
          const frameWindow = frame.contentWindow;
          if (!frameDocument || !frameWindow) {
            return null;
          }
          const frameMetrics = fallbackDocumentPageMetrics({
            document: frameDocument,
            window: frameWindow,
          });
          const pagePoint = browserOverlayPointToViewportPoint(
            point,
            browserAnnotationGeometryFromMetrics({
              overlay: browserEditorOverlayRef.current,
              viewport: browserViewportRef.current,
              metrics: frameMetrics,
            }),
          );
          return readBrowserElementContextFromDocumentAtPoint({
            document: frameDocument,
            point: pagePoint,
          });
        } catch {
          setLocalError(
            "Inspect needs the desktop app for cross-origin pages. Same-origin mock pages still work here.",
          );
          return null;
        }
      }
      const overlaySize = browserAnnotationOverlaySize({
        overlay: browserEditorOverlayRef.current,
        viewport: browserViewportRef.current,
        fallbackWidth: window.innerWidth,
        fallbackHeight: window.innerHeight,
      });
      const response = (await api.browser.executeCdp({
        threadId,
        tabId: activeTab.id,
        method: "Runtime.evaluate",
        params: {
          expression: cdpElementContextExpression(point.x, point.y, {
            overlayWidth: overlaySize.width,
            overlayHeight: overlaySize.height,
          }),
          returnByValue: true,
          awaitPromise: false,
        },
      })) as RuntimeEvaluateResult;
      const value = response.result?.value;
      return isBrowserElementEditorContext(value) ? value : null;
    },
    [activeTab, api, hasNativeBrowserBridge, threadId],
  );

  const runStylePreviewAction = useCallback(
    async (input: {
      selector: string;
      patch: BrowserElementStylePatch;
      mode: BrowserStylePreviewMode;
      tabId?: string;
    }): Promise<boolean> => {
      if (!api || !activeTab) {
        return false;
      }
      const tabId = input.tabId ?? activeTab.id;
      if (!hasNativeBrowserBridge) {
        const frameDocument = browserFallbackFrameRef.current?.contentDocument;
        if (!frameDocument) {
          return false;
        }
        return applyBrowserStylePreviewToDocument({
          document: frameDocument,
          selector: input.selector,
          patch: input.patch,
          mode: input.mode,
        });
      }

      const runtimeKey = `${tabId}\u0000${activeTab.lastCommittedUrl ?? activeTab.url ?? ""}`;
      const ensurePreviewRuntime = async () => {
        if (stylePreviewRuntimeKeysByTabRef.current.get(tabId) === runtimeKey) {
          return true;
        }
        const installResponse = (await api.browser.executeCdp({
          threadId,
          tabId,
          method: "Runtime.evaluate",
          params: {
            expression: browserStylePreviewInstallExpression(),
            returnByValue: true,
            awaitPromise: false,
          },
        })) as RuntimeEvaluateResult;
        const installValue = installResponse.result?.value as { ok?: unknown } | undefined;
        const ok = installValue?.ok === true;
        if (ok) {
          stylePreviewRuntimeKeysByTabRef.current.set(tabId, runtimeKey);
        }
        return ok;
      };
      const invokePreviewRuntime = async () => {
        const response = (await api.browser.executeCdp({
          threadId,
          tabId,
          method: "Runtime.evaluate",
          params: {
            expression: browserStylePreviewInvokeExpression(input),
            returnByValue: true,
            awaitPromise: false,
          },
        })) as RuntimeEvaluateResult;
        return response.result?.value as { ok?: unknown; missingRuntime?: unknown } | undefined;
      };

      if (!(await ensurePreviewRuntime())) {
        return false;
      }
      let value = await invokePreviewRuntime();
      if (value?.missingRuntime === true) {
        stylePreviewRuntimeKeysByTabRef.current.delete(tabId);
        if (!(await ensurePreviewRuntime())) {
          return false;
        }
        value = await invokePreviewRuntime();
      }
      return value?.ok === true;
    },
    [activeTab, api, hasNativeBrowserBridge, threadId],
  );

  const runInlineTextEditAction = useCallback(
    async (
      input: BrowserInlineTextEditInput & { tabId?: string },
    ): Promise<BrowserInlineTextEditResult> => {
      if (!api || !activeTab) {
        return { ok: false };
      }
      const tabId = input.tabId ?? activeTab.id;
      if (!hasNativeBrowserBridge) {
        const frameDocument = browserFallbackFrameRef.current?.contentDocument;
        if (!frameDocument) {
          return { ok: false };
        }
        return applyBrowserInlineTextEditRuntime(input, frameDocument);
      }
      const response = (await api.browser.executeCdp({
        threadId,
        tabId,
        method: "Runtime.evaluate",
        params: {
          expression: browserInlineTextEditExpression(input),
          returnByValue: true,
          awaitPromise: false,
        },
      })) as RuntimeEvaluateResult;
      const value = response.result?.value as
        | { ok?: unknown; action?: unknown; text?: unknown; outerHTML?: unknown }
        | undefined;
      return {
        ok: value?.ok === true,
        ...(value?.action === "commit" || value?.action === "cancel"
          ? { action: value.action }
          : value?.action === null
            ? { action: null }
            : {}),
        ...(typeof value?.text === "string" ? { text: value.text } : {}),
        ...(typeof value?.outerHTML === "string" ? { outerHTML: value.outerHTML } : {}),
      };
    },
    [activeTab, api, hasNativeBrowserBridge, threadId],
  );

  const clearBrowserStylePreview = useCallback(async () => {
    if (stylePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(stylePreviewFrameRef.current);
      stylePreviewFrameRef.current = null;
    }
    if (stylePreviewReapplyFrameRef.current !== null) {
      window.cancelAnimationFrame(stylePreviewReapplyFrameRef.current);
      stylePreviewReapplyFrameRef.current = null;
    }
    stylePreviewPendingPatchRef.current = null;
    stylePreviewActivePatchRef.current = null;
    stylePreviewLastRequestedKeyRef.current = "";
    const target = stylePreviewTargetRef.current;
    if (!target) {
      return;
    }
    stylePreviewTargetRef.current = null;
    await runStylePreviewAction({
      selector: target.selector,
      tabId: target.tabId,
      patch: {},
      mode: "clear",
    }).catch(() => false);
  }, [runStylePreviewAction]);

  const applySelectedStylePreview = useCallback(
    async (patch: BrowserElementStylePatch, mode: BrowserStylePreviewMode = "preview") => {
      if (!selectedElementContext || !activeTab) {
        return false;
      }
      const normalizedPatch = normalizeBrowserElementStylePatch(patch);
      const hasPatch = Object.keys(normalizedPatch).length > 0;
      if (!hasPatch && mode === "preview") {
        await clearBrowserStylePreview();
        return true;
      }
      const ok = await runStylePreviewAction({
        selector: selectedElementContext.selector,
        patch: normalizedPatch,
        mode,
      });
      if (ok && mode !== "clear") {
        stylePreviewTargetRef.current = {
          selector: selectedElementContext.selector,
          tabId: activeTab.id,
          url: activeTab.lastCommittedUrl ?? activeTab.url,
        };
        stylePreviewActivePatchRef.current = mode === "preview" ? normalizedPatch : null;
      }
      if (ok && mode === "commit") {
        stylePreviewTargetRef.current = null;
        stylePreviewActivePatchRef.current = null;
      }
      return ok;
    },
    [activeTab, clearBrowserStylePreview, runStylePreviewAction, selectedElementContext],
  );

  const updateSelectedElementTextContext = useCallback(
    (selector: string, text: string, outerHTML?: string) => {
      setSelectedElementContext((current) => {
        if (!current || current.selector !== selector) {
          return current;
        }
        const next = {
          ...current,
          text,
          outerHTML: outerHTML ?? current.outerHTML,
        };
        selectedElementContextRef.current = next;
        return next;
      });
      scheduleBrowserAnnotationAttachmentUpdate(0);
    },
    [scheduleBrowserAnnotationAttachmentUpdate],
  );

  const saveInlineTextEditToSource = useCallback(
    async (
      originalText: string,
      nextText: string,
      sourceElement: BrowserInlineTextEditorState["sourceElement"],
    ) => {
      if (originalText === nextText) {
        return;
      }
      const cwd = previewState?.targetCwd ?? previewCwd;
      if (!api || !cwd) {
        setLocalError("Could not save the text edit because no project source is active.");
        return;
      }
      if (originalText.trim().length === 0) {
        setLocalError("Could not save text into an empty source location automatically.");
        return;
      }

      try {
        const result = await api.projects.applyTextEdit({
          cwd,
          originalText,
          nextText,
          element: {
            ...sourceElement,
            text: originalText,
          },
        });
        toastManager.add({
          type: "success",
          title: "Text edit saved",
          description: `Updated ${result.relativePath}.`,
        });
        if (activeTab) {
          window.setTimeout(() => {
            void runBrowserAction(() => api.browser.reload({ threadId, tabId: activeTab.id })).then(
              (state) => {
                if (state) {
                  upsertThreadState(state);
                }
              },
            );
          }, 120);
        }
        setLocalError(null);
      } catch (error) {
        setLocalError(formatEditorActionError(error, "Could not save the text edit to source."));
      }
    },
    [
      activeTab,
      api,
      previewCwd,
      previewState?.targetCwd,
      runBrowserAction,
      threadId,
      upsertThreadState,
    ],
  );

  const finishInlineTextEditingCommit = useCallback(
    (editor: BrowserInlineTextEditorState, result: BrowserInlineTextEditResult) => {
      const nextText = result.text ?? editor.originalText;
      updateSelectedElementTextContext(editor.selector, nextText, result.outerHTML);
      void saveInlineTextEditToSource(editor.originalText, nextText, editor.sourceElement);
    },
    [saveInlineTextEditToSource, updateSelectedElementTextContext],
  );

  const startInlineTextEditing = useCallback(() => {
    const selectedContext = selectedElementContextRef.current;
    if (!selectedContext || !activeTab) {
      return;
    }
    void clearBrowserStylePreview();
    setStylePropertiesPanelOpen(false);
    setStylePanelPositionOverride(null);
    setEditorMode("browse");
    const initialText = selectedContext.text || selectedContext.accessibleName || "";
    const selector = selectedContext.selector;
    const tabId = activeTab.id;
    void runInlineTextEditAction({
      selector,
      tabId,
      mode: "begin",
      text: initialText,
    }).then((result) => {
      if (!result.ok) {
        inlineTextEditorRef.current = null;
        setInlineTextEditor(null);
        setLocalError("Could not edit text for the selected element.");
        return;
      }
      if (selectedElementContextRef.current?.selector !== selector) {
        void runInlineTextEditAction({
          selector,
          tabId,
          mode: "cancel",
          text: result.text ?? initialText,
        });
        return;
      }
      const nextEditor = {
        selector,
        sourceElement: {
          attributes: selectedContext.attributes,
          outerHTML: selectedContext.outerHTML,
          tagName: selectedContext.tagName,
          text: selectedContext.text,
        },
        tabId,
        originalText: result.text ?? initialText,
      };
      inlineTextEditorRef.current = nextEditor;
      setInlineTextEditor(nextEditor);
    });
  }, [activeTab, clearBrowserStylePreview, runInlineTextEditAction]);

  const commitInlineTextEditing = useCallback(() => {
    const editor = inlineTextEditorRef.current;
    if (!editor) {
      return;
    }
    inlineTextEditorRef.current = null;
    setInlineTextEditor(null);
    void runInlineTextEditAction({
      selector: editor.selector,
      tabId: editor.tabId,
      mode: "commit",
    }).then((result) => {
      if (!result.ok) {
        setLocalError("Could not edit text for the selected element.");
        return;
      }
      finishInlineTextEditingCommit(editor, result);
    });
  }, [finishInlineTextEditingCommit, runInlineTextEditAction]);

  const cancelInlineTextEditing = useCallback(() => {
    const editor = inlineTextEditorRef.current;
    if (!editor) {
      return;
    }
    inlineTextEditorRef.current = null;
    setInlineTextEditor(null);
    void runInlineTextEditAction({
      selector: editor.selector,
      tabId: editor.tabId,
      mode: "cancel",
      text: editor.originalText,
    });
  }, [runInlineTextEditAction]);

  useEffect(() => {
    inlineTextEditorRef.current = inlineTextEditor;
  }, [inlineTextEditor]);

  useEffect(() => {
    if (!inlineTextEditor) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void runInlineTextEditAction({
        selector: inlineTextEditor.selector,
        tabId: inlineTextEditor.tabId,
        mode: "read",
      }).then((result) => {
        if (!result.ok || !result.action) {
          return;
        }
        if (
          inlineTextEditorRef.current?.selector !== inlineTextEditor.selector ||
          inlineTextEditorRef.current?.tabId !== inlineTextEditor.tabId
        ) {
          return;
        }
        inlineTextEditorRef.current = null;
        setInlineTextEditor(null);
        if (result.action === "commit") {
          finishInlineTextEditingCommit(inlineTextEditor, result);
        }
      });
    }, 120);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [finishInlineTextEditingCommit, inlineTextEditor, runInlineTextEditAction]);

  const scheduleSelectedStylePreview = useCallback(
    (patch: BrowserElementStylePatch) => {
      const normalizedPatch = normalizeBrowserElementStylePatch(patch);
      const previewKey = JSON.stringify(normalizedPatch);
      if (stylePreviewLastRequestedKeyRef.current === previewKey) {
        return;
      }
      stylePreviewLastRequestedKeyRef.current = previewKey;
      stylePreviewPendingPatchRef.current = normalizedPatch;
      if (stylePreviewFrameRef.current !== null || stylePreviewApplyingRef.current) {
        return;
      }
      const scheduleFrame = () => {
        stylePreviewFrameRef.current = window.requestAnimationFrame(() => {
          stylePreviewFrameRef.current = null;
          const nextPatch = stylePreviewPendingPatchRef.current;
          if (!nextPatch) {
            return;
          }
          stylePreviewPendingPatchRef.current = null;
          stylePreviewApplyingRef.current = true;
          void applySelectedStylePreview(nextPatch)
            .then((ok) => {
              if (!ok) {
                setLocalError("Could not preview style changes for the selected element.");
              }
            })
            .finally(() => {
              stylePreviewApplyingRef.current = false;
              if (stylePreviewPendingPatchRef.current) {
                scheduleFrame();
              }
            });
        });
      };
      scheduleFrame();
    },
    [applySelectedStylePreview],
  );

  const scheduleStylePreviewReapply = useCallback(() => {
    const target = stylePreviewTargetRef.current;
    const patch = stylePreviewActivePatchRef.current;
    if (!target || !patch || !activeTab || target.tabId !== activeTab.id) {
      return;
    }
    // Only reapply onto the page the preview was captured on. After a navigation the
    // same selector can match an unrelated element, so drop the stale preview instead
    // of silently mutating the new page.
    const currentPageUrl = activeTab.lastCommittedUrl ?? activeTab.url;
    if (stylePreviewPageKey(currentPageUrl) !== stylePreviewPageKey(target.url)) {
      stylePreviewTargetRef.current = null;
      stylePreviewActivePatchRef.current = null;
      return;
    }
    if (stylePreviewReapplyFrameRef.current !== null) {
      window.cancelAnimationFrame(stylePreviewReapplyFrameRef.current);
    }
    stylePreviewReapplyFrameRef.current = window.requestAnimationFrame(() => {
      stylePreviewReapplyFrameRef.current = null;
      void runStylePreviewAction({
        selector: target.selector,
        tabId: target.tabId,
        patch,
        mode: "preview",
      }).then((ok) => {
        if (!ok) {
          setLocalError("The selected element could not be found after the page updated.");
        }
      });
    });
  }, [activeTab, runStylePreviewAction]);

  useEffect(() => {
    if (!activeTab || activeTab.isLoading) {
      return;
    }
    scheduleStylePreviewReapply();
  }, [activeTab, activeTab?.isLoading, activeTab?.lastCommittedUrl, scheduleStylePreviewReapply]);

  useEffect(() => {
    if (previewState?.status === "running") {
      scheduleStylePreviewReapply();
    }
  }, [previewState?.status, previewState?.url, scheduleStylePreviewReapply]);

  useEffect(() => {
    const targetKey = `${activeTab?.id ?? ""}\u0000${selectedElementContext?.selector ?? ""}`;
    if (previousStyleTargetKeyRef.current === "") {
      previousStyleTargetKeyRef.current = targetKey;
      return;
    }
    if (previousStyleTargetKeyRef.current === targetKey) {
      return;
    }
    previousStyleTargetKeyRef.current = targetKey;
    void clearBrowserStylePreview();
    setStylePropertiesPanelOpen(false);
    setStylePanelPositionOverride(null);
    setStyleEditorInitialPatch(null);
    cancelInlineTextEditing();
  }, [
    activeTab?.id,
    cancelInlineTextEditing,
    clearBrowserStylePreview,
    selectedElementContext?.selector,
  ]);

  const setInspectHoverBoxIfChanged = useCallback((nextBox: BrowserInspectHoverBox | null) => {
    setInspectHoverBox((currentBox) => {
      if (nextBox === null) {
        return currentBox === null ? currentBox : null;
      }
      return currentBox && browserInspectBoxesMatch(currentBox, nextBox) ? currentBox : nextBox;
    });
  }, []);

  const scheduleInspectHover = useCallback(
    (point: BrowserDrawingPoint) => {
      if (!browserEditorFocusedRef.current || !browserEditorPointerInsideRef.current) {
        setInspectHoverBoxIfChanged(null);
        return;
      }
      inspectPointRef.current = point;
      inspectHoverRequestIdRef.current += 1;
      if (inspectHoverInFlightRef.current) {
        inspectHoverQueuedRef.current = true;
        return;
      }
      if (inspectFrameRef.current !== null) {
        return;
      }

      const runFrame = () => {
        inspectFrameRef.current = null;
        const nextPoint = inspectPointRef.current;
        if (
          !nextPoint ||
          editorModeRef.current !== "inspect" ||
          !browserEditorFocusedRef.current ||
          !browserEditorPointerInsideRef.current
        ) {
          return;
        }

        const requestId = inspectHoverRequestIdRef.current;
        inspectHoverInFlightRef.current = true;
        void readElementHoverContextAtPoint(nextPoint)
          .then((nextBox) => {
            if (
              requestId !== inspectHoverRequestIdRef.current ||
              editorModeRef.current !== "inspect" ||
              !browserEditorFocusedRef.current ||
              !browserEditorPointerInsideRef.current
            ) {
              return;
            }
            setInspectHoverBoxIfChanged(nextBox);
          })
          .catch(() => {
            if (requestId === inspectHoverRequestIdRef.current) {
              setInspectHoverBoxIfChanged(null);
            }
          })
          .finally(() => {
            inspectHoverInFlightRef.current = false;
            if (!inspectHoverQueuedRef.current || editorModeRef.current !== "inspect") {
              inspectHoverQueuedRef.current = false;
              return;
            }
            inspectHoverQueuedRef.current = false;
            if (inspectFrameRef.current === null) {
              inspectFrameRef.current = window.requestAnimationFrame(runFrame);
            }
          });
      };

      inspectFrameRef.current = window.requestAnimationFrame(runFrame);
    },
    [readElementHoverContextAtPoint, setInspectHoverBoxIfChanged],
  );

  // Renderer-owned <webview>s are adopted by the desktop manager. Always detach before
  // removing the DOM node so main never keeps a stale webContents runtime.
  const detachRendererBrowserWebview = useCallback(() => {
    const webview = browserWebviewRef.current;
    const tabId = browserWebviewTabIdRef.current;

    if (webview && api && isLiveRuntime && tabId) {
      let webContentsId: number | undefined;
      try {
        webContentsId = webview.getWebContentsId?.();
      } catch {
        webContentsId = undefined;
      }
      if (webContentsId && webContentsId > 0) {
        void api.browser
          .detachWebview({ threadId, tabId, webContentsId })
          .catch(ignoreBrowserWebviewDetachError);
      }
    }

    webview?.remove();
    browserWebviewRef.current = null;
    browserWebviewTabIdRef.current = null;
    browserWebviewAttachKeyRef.current = null;
  }, [api, isLiveRuntime, threadId]);

  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    return api.browser.onState((state) => {
      upsertThreadState(state);
    });
  }, [api, isLiveRuntime, upsertThreadState]);

  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    return api.preview.onState((event) => {
      upsertPreviewState(event.state);
      if (
        event.type !== "source-changed" ||
        !isLiveEditorVariant ||
        !activeTab ||
        !event.state.url ||
        event.state.cwd !== previewCwd ||
        (activeProjectId && event.state.projectId !== activeProjectId)
      ) {
        return;
      }
      const activeUrl = activeTab.lastCommittedUrl ?? activeTab.url;
      if (!livePreviewOriginsMatch(activeUrl, event.state.url)) {
        return;
      }
      if (previewSourceReloadTimeoutRef.current !== null) {
        window.clearTimeout(previewSourceReloadTimeoutRef.current);
      }
      previewSourceReloadTimeoutRef.current = window.setTimeout(() => {
        previewSourceReloadTimeoutRef.current = null;
        void runBrowserAction(() => api.browser.reload({ threadId, tabId: activeTab.id })).then(
          (state) => {
            if (state) {
              upsertThreadState(state);
              scheduleStylePreviewReapply();
            }
          },
        );
      }, 650);
    });
  }, [
    activeProjectId,
    activeTab,
    api,
    isLiveEditorVariant,
    isLiveRuntime,
    previewCwd,
    runBrowserAction,
    scheduleStylePreviewReapply,
    threadId,
    upsertPreviewState,
    upsertThreadState,
  ]);

  useEffect(() => {
    if (!api || !isLiveRuntime || !previewCwd) {
      return;
    }

    let cancelled = false;
    void api.preview
      .getState({
        threadId,
        cwd: previewCwd,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      })
      .then((state) => {
        if (!cancelled) {
          upsertPreviewState(state);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalError("Couldn't read preview state.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, api, isLiveRuntime, previewCwd, threadId, upsertPreviewState]);

  useEffect(() => {
    previewLastRoutedKeyRef.current = null;
  }, [activeProjectId, previewCwd]);

  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    let cancelled = false;
    setWorkspaceReady(false);
    setLocalError(null);

    void runBrowserAction(() => api.browser.open({ threadId })).then((state) => {
      if (cancelled) {
        return;
      }
      if (!state) {
        setWorkspaceReady(true);
        return;
      }
      upsertThreadState(state);
      setWorkspaceReady(true);
    });

    return () => {
      cancelled = true;
      void api.browser.hide({ threadId });
    };
  }, [api, isLiveRuntime, runBrowserAction, threadId, upsertThreadState]);

  useEffect(() => {
    if (
      !api ||
      !isLiveRuntime ||
      !workspaceReady ||
      !previewCwd ||
      previewAutoStartedCwdRef.current === previewCwd
    ) {
      return;
    }
    const status = previewState?.status ?? "idle";
    if (status !== "idle") {
      return;
    }

    previewAutoStartedCwdRef.current = previewCwd;
    void startPreview({ autoNavigate: true, silentIfUnavailable: true });
  }, [api, isLiveRuntime, previewCwd, previewState?.status, startPreview, workspaceReady]);

  useEffect(() => {
    if (
      !api ||
      !isLiveRuntime ||
      !workspaceReady ||
      previewState?.status !== "running" ||
      !previewState.url
    ) {
      return;
    }

    void routeCurrentProjectPreview(previewState.url, previewState.targetCwd ?? null).catch(
      (error) => {
        setLocalError(formatBrowserActionError(error));
      },
    );
  }, [
    api,
    isLiveRuntime,
    previewState?.status,
    previewState?.targetCwd,
    previewState?.url,
    routeCurrentProjectPreview,
    workspaceReady,
  ]);

  const updateActiveDrawStrokeElements = useCallback((stroke: BrowserDrawingStroke) => {
    const points = drawingStrokePoints(stroke);
    activeDrawContrastPolylineRef.current?.setAttribute("points", points);
    activeDrawGradientPolylineRef.current?.setAttribute("points", points);
    activeDrawGlintPolylineRef.current?.setAttribute("points", points);
  }, []);

  const resetActiveDrawStroke = useCallback(() => {
    activeDrawStrokeRef.current = null;
    activeDrawPointerIdRef.current = null;
    activeDrawOverlayRectRef.current = null;
    activeDrawContrastPolylineRef.current = null;
    activeDrawGradientPolylineRef.current = null;
    activeDrawGlintPolylineRef.current = null;
    setActiveDrawStroke(null);
  }, []);

  const setBrowserEditorFocusState = useCallback((next: boolean) => {
    browserEditorFocusedRef.current = next;
    setBrowserEditorFocused(next);
    if (!next) {
      setShowEditorShortcutHints(false);
    }
  }, []);

  useEffect(() => {
    if (!isLiveRuntime || !workspaceReady) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        !isBrowserEditorSurfaceEventTarget(event.target) &&
        !isBrowserEditorChromeEventTarget(event.target)
      ) {
        setBrowserEditorFocusState(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isLiveRuntime, setBrowserEditorFocusState, workspaceReady]);

  const setBrowserEditorPointerInsideState = useCallback(
    (next: boolean) => {
      browserEditorPointerInsideRef.current = next;
      setBrowserEditorPointerInside(next);
      if (!next) {
        setInspectHoverBoxIfChanged(null);
      }
    },
    [setInspectHoverBoxIfChanged],
  );

  const clearToolOptionsHoverTimeout = useCallback(() => {
    if (toolOptionsHoverTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(toolOptionsHoverTimeoutRef.current);
    toolOptionsHoverTimeoutRef.current = null;
  }, []);

  const clearToolOptionsCloseTimeout = useCallback(() => {
    if (toolOptionsCloseTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(toolOptionsCloseTimeoutRef.current);
    toolOptionsCloseTimeoutRef.current = null;
  }, []);

  const measureEditorToolbarAnchors = useCallback(() => {
    const nextStripRect = browserToolbarAnchorRectFromElement(liveEditorToolbarStripRef.current);
    const next = {
      browse: browserToolbarAnchorRectFromElement(editorToolbarButtonRefs.current.browse),
      inspect: browserToolbarAnchorRectFromElement(editorToolbarButtonRefs.current.inspect),
      draw: browserToolbarAnchorRectFromElement(editorToolbarButtonRefs.current.draw),
      text: browserToolbarAnchorRectFromElement(editorToolbarButtonRefs.current.text),
    } satisfies Record<BrowserEditorMode, BrowserToolbarAnchorRect | null>;
    setEditorToolbarStripRect((current) =>
      browserToolbarAnchorRectsMatch(current, nextStripRect) ? current : nextStripRect,
    );
    setEditorToolbarAnchorRects((current) =>
      browserToolbarAnchorRectsMatch(current.browse, next.browse) &&
      browserToolbarAnchorRectsMatch(current.inspect, next.inspect) &&
      browserToolbarAnchorRectsMatch(current.draw, next.draw) &&
      browserToolbarAnchorRectsMatch(current.text, next.text)
        ? current
        : next,
    );
  }, []);

  const scheduleToolOptionsOpen = useCallback(
    (panel: BrowserToolOptionsPanel) => {
      clearToolOptionsHoverTimeout();
      clearToolOptionsCloseTimeout();
      toolOptionsHoverTimeoutRef.current = window.setTimeout(() => {
        toolOptionsHoverTimeoutRef.current = null;
        measureEditorToolbarAnchors();
        setOpenToolOptions(panel);
      }, BROWSER_TOOL_OPTIONS_HOVER_DELAY_MS);
    },
    [clearToolOptionsCloseTimeout, clearToolOptionsHoverTimeout, measureEditorToolbarAnchors],
  );

  const closeToolOptions = useCallback(() => {
    clearToolOptionsHoverTimeout();
    clearToolOptionsCloseTimeout();
    setOpenToolOptions(null);
  }, [clearToolOptionsCloseTimeout, clearToolOptionsHoverTimeout]);

  const scheduleToolOptionsClose = useCallback(() => {
    clearToolOptionsHoverTimeout();
    clearToolOptionsCloseTimeout();
    toolOptionsCloseTimeoutRef.current = window.setTimeout(() => {
      toolOptionsCloseTimeoutRef.current = null;
      setOpenToolOptions(null);
    }, BROWSER_TOOL_OPTIONS_CLOSE_DELAY_MS);
  }, [clearToolOptionsCloseTimeout, clearToolOptionsHoverTimeout]);

  const keepToolOptionsOpen = useCallback(() => {
    clearToolOptionsCloseTimeout();
  }, [clearToolOptionsCloseTimeout]);

  const hasAttachableBrowserEditorContext = useCallback(
    () =>
      drawStrokesRef.current.some((stroke) => stroke.points.length > 1) ||
      selectedElementContextRef.current !== null ||
      textAnnotationsRef.current.length > 0 ||
      annotationArrowsRef.current.length > 0,
    [],
  );

  useEffect(() => {
    const requestedUrl = previewPendingNavigationUrlRef.current;
    if (
      !requestedUrl ||
      !previewState?.url ||
      previewState.status !== "running" ||
      previewState.url !== requestedUrl ||
      !isLiveRuntime ||
      !workspaceReady
    ) {
      return;
    }

    previewPendingNavigationUrlRef.current = null;
    void navigateBrowserToPreviewUrl(requestedUrl, previewState.targetCwd ?? null).catch(
      (error) => {
        setLocalError(formatBrowserActionError(error));
      },
    );
  }, [
    isLiveRuntime,
    navigateBrowserToPreviewUrl,
    previewState?.status,
    previewState?.targetCwd,
    previewState?.url,
    workspaceReady,
  ]);

  useEffect(() => {
    editorModeRef.current = editorMode;
    if (editorMode !== "inspect") {
      inspectHoverRequestIdRef.current += 1;
      inspectHoverQueuedRef.current = false;
      inspectPointRef.current = null;
      setInspectHoverBox(null);
      if (inspectFrameRef.current !== null) {
        window.cancelAnimationFrame(inspectFrameRef.current);
        inspectFrameRef.current = null;
      }
    }
    if (editorMode !== "draw") {
      resetActiveDrawStroke();
    }
  }, [editorMode, resetActiveDrawStroke]);

  useEffect(() => {
    drawStrokesRef.current = drawStrokes;
    textAnnotationsRef.current = textAnnotations;
    annotationArrowsRef.current = annotationArrows;
    selectedElementContextRef.current = selectedElementContext;
    if (!annotationStateInitializedRef.current) {
      annotationStateInitializedRef.current = true;
      return;
    }
    scheduleBrowserAnnotationAttachmentUpdate();
  }, [
    annotationArrows,
    drawStrokes,
    scheduleBrowserAnnotationAttachmentUpdate,
    selectedElementContext,
    textAnnotations,
  ]);

  useLayoutEffect(() => {
    if (!textAnnotationDraft) {
      return;
    }
    textAnnotationInputRef.current?.focus();
  }, [textAnnotationDraft]);

  useEffect(() => {
    hoveredTextAnnotationIdRef.current = hoveredTextAnnotationId;
  }, [hoveredTextAnnotationId]);

  useLayoutEffect(() => {
    if (!editingTextAnnotationId) {
      return;
    }
    editTextAnnotationInputRef.current?.focus();
    editTextAnnotationInputRef.current?.select();
  }, [editingTextAnnotationId]);

  useEffect(() => {
    if (!autoAttachAnnotationScreenshot || !hasAttachableBrowserEditorContext()) {
      return;
    }
    scheduleBrowserAnnotationAttachmentUpdate(0);
  }, [
    autoAttachAnnotationScreenshot,
    hasAttachableBrowserEditorContext,
    scheduleBrowserAnnotationAttachmentUpdate,
    threadId,
  ]);

  useEffect(() => {
    if (!autoAttachAnnotationScreenshot || !hasAttachableBrowserEditorContext()) {
      return;
    }
    scheduleBrowserAnnotationAttachmentUpdate();
  }, [
    activeTab?.id,
    activeTab?.lastCommittedUrl,
    activeTab?.url,
    autoAttachAnnotationScreenshot,
    hasAttachableBrowserEditorContext,
    scheduleBrowserAnnotationAttachmentUpdate,
  ]);

  useEffect(() => {
    annotationUpdateDisposedRef.current = false;
    return () => {
      if (textAnnotationHoverHideTimeoutRef.current !== null) {
        window.clearTimeout(textAnnotationHoverHideTimeoutRef.current);
        textAnnotationHoverHideTimeoutRef.current = null;
      }
      if (annotationArrowHoverHideTimeoutRef.current !== null) {
        window.clearTimeout(annotationArrowHoverHideTimeoutRef.current);
        annotationArrowHoverHideTimeoutRef.current = null;
      }
      if (inspectFrameRef.current !== null) {
        window.cancelAnimationFrame(inspectFrameRef.current);
        inspectFrameRef.current = null;
      }
      inspectHoverRequestIdRef.current += 1;
      inspectHoverQueuedRef.current = false;
      activeDrawStrokeRef.current = null;
      activeDrawPointerIdRef.current = null;
      activeDrawOverlayRectRef.current = null;
      inlineTextEditorRef.current = null;
      if (annotationUpdateTimeoutRef.current !== null) {
        window.clearTimeout(annotationUpdateTimeoutRef.current);
        annotationUpdateTimeoutRef.current = null;
      }
      annotationUpdateQueuedRef.current = false;
      annotationUpdateDisposedRef.current = true;
      annotationUpdateRequestIdRef.current += 1;
    };
  }, []);

  const syncFallbackFrameLoad = useCallback(() => {
    if (canUseNativeBrowserSurface || !threadBrowserState || !activeTab) {
      return;
    }

    const frame = browserFallbackFrameRef.current;
    let nextUrl = activeTab.url;
    let nextTitle = activeTab.title;
    try {
      const frameWindow = frame?.contentWindow;
      const frameDocument = frame?.contentDocument;
      nextUrl = frameWindow?.location.href ?? nextUrl;
      nextTitle = frameDocument?.title || nextTitle || nextUrl;
    } catch {
      nextTitle = activeTab.title || activeTab.url;
    }

    const nextTabs = threadBrowserState.tabs.map((tab) =>
      tab.id === activeTab.id
        ? {
            ...tab,
            url: nextUrl,
            title: nextTitle,
            lastCommittedUrl: nextUrl,
            isLoading: false,
            lastError: null,
            status: "live" as const,
          }
        : tab,
    );
    const nextActiveTab = nextTabs.find((tab) => tab.id === activeTab.id);
    if (
      !nextActiveTab ||
      (nextActiveTab.url === activeTab.url &&
        nextActiveTab.title === activeTab.title &&
        nextActiveTab.lastCommittedUrl === activeTab.lastCommittedUrl &&
        nextActiveTab.isLoading === activeTab.isLoading &&
        nextActiveTab.lastError === activeTab.lastError &&
        nextActiveTab.status === activeTab.status)
    ) {
      return;
    }

    upsertThreadState({
      ...threadBrowserState,
      version: threadBrowserState.version + 1,
      tabs: nextTabs,
      lastError: null,
    });
  }, [activeTab, canUseNativeBrowserSurface, threadBrowserState, upsertThreadState]);

  useEffect(() => {
    const activeTabId = activeTab?.id ?? null;
    const nextDisplayValue = browserAddressDisplayValue(activeTab);
    const decision = resolveBrowserAddressSync({
      activeTabId,
      previousActiveTabId: previousActiveTabIdRef.current,
      savedDraft: activeTabId ? addressDraftsByTabIdRef.current.get(activeTabId) : undefined,
      nextDisplayValue,
      lastSyncedValue: activeTabId
        ? lastSyncedAddressByTabIdRef.current.get(activeTabId)
        : undefined,
      isEditing: isAddressEditingRef.current,
    });

    if (decision.type === "replace") {
      setAddressValue(decision.value);
      if (activeTabId) {
        addressDraftsByTabIdRef.current.set(activeTabId, decision.value);
        if (decision.syncedValue !== undefined) {
          lastSyncedAddressByTabIdRef.current.set(activeTabId, decision.syncedValue);
        }
      }
    }

    previousActiveTabIdRef.current = activeTabId;
  }, [activeTab]);

  useLayoutEffect(() => {
    if (!api || !canUseNativeBrowserSurface || !workspaceReady || !activeTab) {
      return;
    }

    if (showLocalServersHome) {
      detachRendererBrowserWebview();
      return;
    }

    const host = browserViewportRef.current;
    if (!host) {
      return;
    }

    let webview = browserWebviewRef.current;
    if (!webview) {
      webview = document.createElement("webview") as BrowserWebviewElement;
      webview.className = "h-full w-full";
      webview.style.display = "flex";
      webview.style.width = "100%";
      webview.style.height = "100%";
      webview.style.backgroundColor = "#0d0d0d";
      webview.setAttribute("partition", BROWSER_WEBVIEW_PARTITION);
      webview.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=yes");
      // A <webview> blocks window.open() unless `allowpopups` is set. Without it, clicking
      // "Continue with Google" (and any OAuth/popup flow) is silently dropped before the main
      // process's window-open handler ever runs. Enabling it lets the popup classifier in
      // browserManager decide popup-vs-tab and keep the OAuth `window.opener` handshake alive.
      webview.setAttribute("allowpopups", "true");
      // No `useragent` attribute on purpose: the desktop main process spoofs a desktop Chrome
      // UA on the shared persistent partition, so this webview (and OAuth popups) inherit the
      // same identity. This keeps in-app Google/OAuth sign-in working without duplicating the
      // UA string into the renderer.
      browserWebviewRef.current = webview;
      host.append(webview);
    } else if (webview.parentElement !== host) {
      host.append(webview);
    }

    const initialUrl = activeTab.lastCommittedUrl ?? activeTab.url ?? BROWSER_BLANK_URL;
    if (browserWebviewTabIdRef.current !== activeTab.id) {
      browserWebviewTabIdRef.current = activeTab.id;
      browserWebviewAttachKeyRef.current = null;
      loadBrowserWebviewUrl(webview, initialUrl);
    }

    const attachVisibleWebview = () => {
      let webContentsId: number | undefined;
      try {
        webContentsId = webview.getWebContentsId?.();
      } catch {
        return;
      }
      if (!webContentsId || webContentsId <= 0) {
        return;
      }

      const attachKey = `${activeTab.id}:${webContentsId}`;
      if (browserWebviewAttachKeyRef.current === attachKey) {
        return;
      }
      browserWebviewAttachKeyRef.current = attachKey;
      void runBrowserAction(() =>
        api.browser.attachWebview({
          threadId,
          tabId: activeTab.id,
          webContentsId,
        }),
      ).then((state) => {
        if (state) {
          upsertThreadState(state);
          scheduleStylePreviewReapply();
        }
      });
    };

    webview.addEventListener("dom-ready", attachVisibleWebview);
    webview.addEventListener("did-start-loading", attachVisibleWebview);
    window.requestAnimationFrame(attachVisibleWebview);

    return () => {
      webview.removeEventListener("dom-ready", attachVisibleWebview);
      webview.removeEventListener("did-start-loading", attachVisibleWebview);
    };
  }, [
    activeTab,
    api,
    canUseNativeBrowserSurface,
    detachRendererBrowserWebview,
    runBrowserAction,
    scheduleStylePreviewReapply,
    showLocalServersHome,
    threadId,
    upsertThreadState,
    workspaceReady,
  ]);

  useEffect(() => {
    if (activeTab || !canUseNativeBrowserSurface) {
      return;
    }
    detachRendererBrowserWebview();
    browserWebviewAttachKeyRef.current = null;
    if (api) {
      void api.browser
        .setPanelBounds({ threadId, bounds: null, surface: "renderer" })
        .catch(ignoreBrowserBoundsSyncError);
    }
  }, [activeTab, api, canUseNativeBrowserSurface, detachRendererBrowserWebview, threadId]);

  useEffect(() => {
    const tabCount = threadBrowserState?.tabs.length ?? 0;
    if (tabCount > 0) {
      browserHadTabsRef.current = true;
      return;
    }
    if (
      !isLiveEditorVariant ||
      !isLiveRuntime ||
      !workspaceReady ||
      !browserHadTabsRef.current ||
      threadBrowserState?.open !== false
    ) {
      return;
    }
    browserHadTabsRef.current = false;
    onClosePanel();
  }, [
    isLiveEditorVariant,
    isLiveRuntime,
    onClosePanel,
    threadBrowserState?.open,
    threadBrowserState?.tabs.length,
    workspaceReady,
  ]);

  useEffect(() => {
    return () => {
      if (previewSourceReloadTimeoutRef.current !== null) {
        window.clearTimeout(previewSourceReloadTimeoutRef.current);
        previewSourceReloadTimeoutRef.current = null;
      }
      detachRendererBrowserWebview();
    };
  }, [detachRendererBrowserWebview]);

  useEffect(() => {
    const liveTabIds = new Set(threadBrowserState?.tabs.map((tab) => tab.id) ?? []);
    for (const tabId of addressDraftsByTabIdRef.current.keys()) {
      if (!liveTabIds.has(tabId)) {
        addressDraftsByTabIdRef.current.delete(tabId);
        lastSyncedAddressByTabIdRef.current.delete(tabId);
      }
    }
  }, [threadBrowserState?.tabs]);

  useEffect(() => {
    if (!isLiveRuntime || !isBrowserPerfLoggingEnabled()) {
      return;
    }

    const intervalId = window.setInterval(() => {
      console.info(`[${SYNARA_BROWSER_LABEL} panel perf]`, {
        threadId,
        ...perfCountersRef.current,
      });
    }, BROWSER_PERF_SAMPLE_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLiveRuntime, threadId]);

  useLayoutEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }

    const element = browserViewportRef.current;
    if (!element) {
      return;
    }

    const syncBounds = () => {
      perfCountersRef.current.syncAttempts += 1;
      // While the local-servers home is up, force the browser surface hidden instead of
      // trusting the obscuring-overlay heuristic. The native/inline webview otherwise paints
      // about:blank white over our dark DOM home — the "always white" empty state.
      const obscuredByOverlay = showLocalServersHome || hasNativeBrowserObscuringOverlay(element);
      lastOverlayObscuredRef.current = obscuredByOverlay;
      setBrowserWebviewOverlayOcclusion(browserWebviewRef.current, obscuredByOverlay);
      const rect = element.getBoundingClientRect();
      const bounds =
        obscuredByOverlay || !activeTab
          ? null
          : (() => {
              if (rect.width <= 0 || rect.height <= 0) {
                return null;
              }
              return {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              };
            })();
      const nextKey = bounds
        ? `renderer:${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}`
        : "renderer:hidden";
      lastMeasuredBoundsKeyRef.current = nextKey;
      if (lastSentBoundsRef.current === nextKey) {
        perfCountersRef.current.syncSkips += 1;
        return;
      }
      lastSentBoundsRef.current = nextKey;
      perfCountersRef.current.syncSends += 1;
      void api.browser
        .setPanelBounds({ threadId, bounds, surface: "renderer" })
        .catch(ignoreBrowserBoundsSyncError);
    };

    // The panel can slide horizontally without resizing. A short burst keeps the
    // native browser view in lockstep without paying for a long frame-by-frame loop.
    const syncBoundsBurst = (frames = BROWSER_BOUNDS_SYNC_BURST_FRAMES) => {
      if (boundsBurstFrameRef.current !== null) {
        perfCountersRef.current.burstExtensions += 1;
        burstFramesRemainingRef.current = Math.max(burstFramesRemainingRef.current, frames);
        burstStableFramesRef.current = 0;
        return;
      }

      perfCountersRef.current.burstStarts += 1;
      burstFramesRemainingRef.current = frames;
      burstStableFramesRef.current = 0;
      const tick = () => {
        perfCountersRef.current.burstFrames += 1;
        const previousMeasuredKey = lastMeasuredBoundsKeyRef.current;
        syncBounds();
        const measuredHidden = lastMeasuredBoundsKeyRef.current?.endsWith(":hidden") ?? false;
        if (!measuredHidden && lastMeasuredBoundsKeyRef.current === previousMeasuredKey) {
          burstStableFramesRef.current += 1;
        } else {
          burstStableFramesRef.current = 0;
        }
        burstFramesRemainingRef.current -= 1;
        if (
          burstFramesRemainingRef.current > 0 &&
          burstStableFramesRef.current < BROWSER_BOUNDS_SYNC_STABLE_FRAME_TARGET
        ) {
          boundsBurstFrameRef.current = window.requestAnimationFrame(tick);
          return;
        }
        boundsBurstFrameRef.current = null;
        burstFramesRemainingRef.current = 0;
        burstStableFramesRef.current = 0;
      };

      boundsBurstFrameRef.current = window.requestAnimationFrame(tick);
    };

    const scheduleSyncBounds = () => {
      perfCountersRef.current.resizeSchedules += 1;
      if (resizeFrameRef.current !== null) {
        perfCountersRef.current.resizeScheduleSkips += 1;
        return;
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        syncBounds();
      });
    };

    const handleTransitionBounds = (event: TransitionEvent) => {
      if (!isNativeBrowserTransitionSignalTarget(event.target, element)) {
        perfCountersRef.current.ignoredTransitionSignals += 1;
        return;
      }

      if (
        event.propertyName.length > 0 &&
        !VIEWPORT_TRANSITION_PROPERTIES.has(event.propertyName)
      ) {
        perfCountersRef.current.ignoredTransitionSignals += 1;
        return;
      }

      perfCountersRef.current.transitionSignals += 1;
      scheduleSyncBounds();
      if (event.type === "transitionrun") {
        syncBoundsBurst();
      }
    };

    syncBounds();
    syncBoundsBurst();
    const observer = new ResizeObserver(() => {
      scheduleSyncBounds();
    });
    observer.observe(element);
    window.addEventListener("resize", scheduleSyncBounds);
    window.addEventListener(PANEL_RESIZE_OVERLAY_SYNC_EVENT, scheduleSyncBounds);
    document.addEventListener("transitionrun", handleTransitionBounds, true);
    document.addEventListener("transitionend", handleTransitionBounds, true);
    document.addEventListener("transitioncancel", handleTransitionBounds, true);

    return () => {
      setBrowserWebviewOverlayOcclusion(browserWebviewRef.current, false);
      observer.disconnect();
      window.removeEventListener("resize", scheduleSyncBounds);
      window.removeEventListener(PANEL_RESIZE_OVERLAY_SYNC_EVENT, scheduleSyncBounds);
      document.removeEventListener("transitionrun", handleTransitionBounds, true);
      document.removeEventListener("transitionend", handleTransitionBounds, true);
      document.removeEventListener("transitioncancel", handleTransitionBounds, true);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (boundsBurstFrameRef.current !== null) {
        cancelAnimationFrame(boundsBurstFrameRef.current);
        boundsBurstFrameRef.current = null;
      }
      burstFramesRemainingRef.current = 0;
      burstStableFramesRef.current = 0;
    };
  }, [activeTab, api, isLiveRuntime, showLocalServersHome, threadId]);

  const onSubmitAddress = useCallback(() => {
    if (!ensureLiveRuntime()) {
      return;
    }
    if (!api || !activeTab) {
      return;
    }
    isAddressEditingRef.current = false;
    setIsAddressFocused(false);
    const normalizedAddress = normalizeBrowserAddressInput(addressValue);
    addressDraftsByTabIdRef.current.set(activeTab.id, normalizedAddress);
    setAddressValue(normalizedAddress);
    void runBrowserAction(() =>
      api.browser.navigate({
        threadId,
        tabId: activeTab.id,
        url: normalizedAddress,
      }),
    ).then((state) => {
      if (state) {
        upsertThreadState(state);
      }
    });
  }, [
    activeTab,
    addressValue,
    api,
    ensureLiveRuntime,
    runBrowserAction,
    threadId,
    upsertThreadState,
  ]);

  const onChooseSuggestion = useCallback(
    (suggestion: BrowserAddressSuggestion) => {
      if (!api) {
        return;
      }
      if (!ensureLiveRuntime()) {
        return;
      }

      isAddressEditingRef.current = false;
      setIsAddressFocused(false);
      setAddressValue(suggestion.url);

      const tabId = suggestion.tabId;
      if (suggestion.kind === "tab" && typeof tabId === "string") {
        void runBrowserAction(() => api.browser.selectTab({ threadId, tabId })).then((state) => {
          if (state) {
            upsertThreadState(state);
          }
          window.requestAnimationFrame(() => {
            addressInputRef.current?.focus();
            addressInputRef.current?.select();
          });
        });
        return;
      }

      if (activeTab) {
        addressDraftsByTabIdRef.current.set(activeTab.id, suggestion.url);
      }

      void runBrowserAction(() =>
        api.browser.navigate({
          threadId,
          url: suggestion.url,
          ...(activeTab ? { tabId: activeTab.id } : {}),
        }),
      ).then((state) => {
        if (state) {
          upsertThreadState(state);
        }
      });
    },
    [activeTab, api, ensureLiveRuntime, runBrowserAction, threadId, upsertThreadState],
  );

  const onOpenLocalServer = useCallback(
    (url: string, tabId: string | null) => {
      if (!api) {
        return;
      }
      if (!ensureLiveRuntime()) {
        return;
      }

      isAddressEditingRef.current = false;
      setIsAddressFocused(false);
      setAddressValue(url);
      if (tabId) {
        addressDraftsByTabIdRef.current.set(tabId, url);
      }

      void runBrowserAction(() =>
        api.browser.navigate({
          threadId,
          url,
          ...(tabId ? { tabId } : {}),
        }),
      ).then((state) => {
        if (state) {
          upsertThreadState(state);
        }
      });
    },
    [api, ensureLiveRuntime, runBrowserAction, threadId, upsertThreadState],
  );

  const onCreateTab = useCallback(() => {
    if (!ensureLiveRuntime()) {
      return;
    }
    if (!api) {
      return;
    }
    void runBrowserAction(() => api.browser.newTab({ threadId, activate: true })).then((state) => {
      if (state) {
        upsertThreadState(state);
      }
      window.requestAnimationFrame(() => {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      });
    });
  }, [api, ensureLiveRuntime, runBrowserAction, threadId, upsertThreadState]);

  const onCaptureScreenshot = useCallback(() => {
    if (!ensureLiveRuntime()) {
      return;
    }
    if (!api || !activeTab) {
      return;
    }

    const attachmentCount =
      composerDraftImageCount + composerDraftFileCount + composerDraftAssistantSelectionCount;
    if (attachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setLocalError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
      );
      return;
    }

    void runBrowserAction(() =>
      api.browser.captureScreenshot({ threadId, tabId: activeTab.id }),
    ).then((screenshot) => {
      if (!screenshot) {
        return;
      }
      if (screenshot.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        setLocalError(
          `'${screenshotAttachmentName(screenshot)}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`,
        );
        return;
      }

      addComposerDraftImage(threadId, composerImageFromBrowserScreenshot(screenshot));
      setLocalError(null);
    });
  }, [
    activeTab,
    addComposerDraftImage,
    api,
    composerDraftAssistantSelectionCount,
    composerDraftFileCount,
    composerDraftImageCount,
    ensureLiveRuntime,
    runBrowserAction,
    threadId,
  ]);

  const onCopyScreenshotToClipboard = useCallback(() => {
    if (!ensureLiveRuntime()) {
      return;
    }
    if (!api || !activeTab) {
      return;
    }

    void runBrowserAction(() =>
      api.browser.copyScreenshotToClipboard({ threadId, tabId: activeTab.id }),
    ).then((result) => {
      if (result === null) {
        return;
      }
      const anchor = copyScreenshotButtonRef.current;
      if (anchor) {
        anchoredToastManager.add({
          data: {
            tooltipStyle: true,
          },
          positionerProps: {
            anchor,
          },
          timeout: 1_200,
          title: "Browser screenshot copied",
        });
        return;
      }

      toastManager.add({
        type: "success",
        title: "Browser screenshot copied",
      });
    });
  }, [activeTab, api, ensureLiveRuntime, runBrowserAction, threadId]);

  const copyActiveTabLink = useCallback(() => {
    if (!activeTab) {
      return;
    }
    // Desktop: copy through the native Electron clipboard. navigator.clipboard can reject
    // with "Document is not focused" while the native browser view holds focus, so this
    // mirrors the keyboard chord — main writes the URL and emits onCopyLink, which surfaces
    // the toast in the listener below.
    if (isElectron && api) {
      void runBrowserAction(() => api.browser.copyLink({ threadId, tabId: activeTab.id }));
      return;
    }
    const url = resolveCopyableBrowserTabUrl(activeTab);
    if (!url) {
      return;
    }
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      return;
    }
    void clipboard.writeText(url).then(
      () => {
        toastManager.add({ type: "success", title: BROWSER_COPY_LINK_TOAST_TITLE });
      },
      () => {
        // Clipboard writes can reject without user gesture; nothing actionable to surface.
      },
    );
  }, [activeTab, api, runBrowserAction, threadId]);

  // React chrome focus path: the native page handles the chord through the desktop main
  // process, so this only fires when the address bar/tab strip (not the page) is focused.
  useEffect(() => {
    if (!isLiveRuntime) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const matches = isBrowserCopyLinkChord(
        {
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          key: event.key,
        },
        isMacPlatform(navigator.platform),
      );
      if (!matches) {
        return;
      }
      event.preventDefault();
      copyActiveTabLink();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [copyActiveTabLink, isLiveRuntime]);

  // Native page focus path: main already wrote the URL to the clipboard, so just toast.
  useEffect(() => {
    if (!api || !isLiveRuntime) {
      return;
    }
    return api.browser.onCopyLink((event) => {
      if (event.threadId !== threadId) {
        return;
      }
      toastManager.add({ type: "success", title: BROWSER_COPY_LINK_TOAST_TITLE });
    });
  }, [api, isLiveRuntime, threadId]);

  const onCloseTab = useCallback(
    (tabId: string) => {
      if (!ensureLiveRuntime()) {
        return;
      }
      if (!api) {
        return;
      }
      void runBrowserAction(() => api.browser.closeTab({ threadId, tabId })).then((state) => {
        if (!state) {
          return;
        }
        upsertThreadState(state);
        if (!state.open && state.tabs.length === 0) {
          onClosePanel();
        }
      });
    },
    [api, ensureLiveRuntime, onClosePanel, runBrowserAction, threadId, upsertThreadState],
  );

  const onInspectPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (editorMode !== "inspect") {
        return;
      }
      scheduleInspectHover(pointFromOverlayEvent(event));
    },
    [editorMode, scheduleInspectHover],
  );

  const onInspectClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (editorMode !== "inspect") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const point = pointFromOverlayEvent(event);
      void readElementContextAtPoint(point)
        .then((context) => {
          if (!context) {
            setLocalError("No inspectable element found at that point.");
            return;
          }
          selectedElementContextRef.current = context;
          setSelectedElementContext(context);
          scheduleBrowserAnnotationAttachmentUpdate(0);
          setLocalError(null);
        })
        .catch((error) => {
          setLocalError(formatBrowserActionError(error));
        });
    },
    [editorMode, readElementContextAtPoint, scheduleBrowserAnnotationAttachmentUpdate],
  );

  const commitTextAnnotationDraft = useCallback(
    (draft = textAnnotationDraft) => {
      if (!draft) {
        return;
      }
      setTextAnnotationDraft(null);
      const text = draft.text.trim();
      if (text.length === 0) {
        return;
      }
      const metrics = textAnnotationBoxMetrics(text, browserTextAnnotationFontSize(draft));
      const boxPosition = clampTextAnnotationBoxPosition(
        textAnnotationBoxPosition({ ...draft, text }, metrics),
        browserEditorOverlayRef.current,
        metrics,
      );
      const annotation = { ...draft, text, boxX: boxPosition.x, boxY: boxPosition.y };
      setTextAnnotations((current) => {
        const next = [...current, annotation];
        textAnnotationsRef.current = next;
        return next;
      });
      scheduleBrowserAnnotationAttachmentUpdate(0);
    },
    [scheduleBrowserAnnotationAttachmentUpdate, textAnnotationDraft],
  );

  const onTextAnnotationClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (editorMode !== "text") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitTextAnnotationDraft();
      setSelectedAnnotationArrowId(null);
      setSelectedTextAnnotationId(null);
    },
    [commitTextAnnotationDraft, editorMode],
  );

  const onTextAnnotationDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (editorMode !== "text") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitTextAnnotationDraft();
      setSelectedAnnotationArrowId(null);
      setSelectedTextAnnotationId(null);
      setTextAnnotationDraft({
        id: crypto.randomUUID(),
        ...pointFromOverlayEvent(event),
        text: "",
        fontSize: textAnnotationFontSize,
      });
    },
    [commitTextAnnotationDraft, editorMode, textAnnotationFontSize],
  );

  const clearTextAnnotationHoverHideTimeout = useCallback(() => {
    if (textAnnotationHoverHideTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(textAnnotationHoverHideTimeoutRef.current);
    textAnnotationHoverHideTimeoutRef.current = null;
  }, []);

  const showTextAnnotationControls = useCallback(
    (annotationId: string) => {
      clearTextAnnotationHoverHideTimeout();
      if (hoveredTextAnnotationIdRef.current === annotationId) {
        return;
      }
      hoveredTextAnnotationIdRef.current = annotationId;
      setHoveredTextAnnotationId(annotationId);
    },
    [clearTextAnnotationHoverHideTimeout],
  );

  const scheduleHideTextAnnotationControls = useCallback(
    (annotationId: string) => {
      clearTextAnnotationHoverHideTimeout();
      textAnnotationHoverHideTimeoutRef.current = window.setTimeout(() => {
        textAnnotationHoverHideTimeoutRef.current = null;
        if (hoveredTextAnnotationIdRef.current !== annotationId) {
          return;
        }
        hoveredTextAnnotationIdRef.current = null;
        setHoveredTextAnnotationId((current) => (current === annotationId ? null : current));
      }, 140);
    },
    [clearTextAnnotationHoverHideTimeout],
  );

  const clearAnnotationArrowHoverHideTimeout = useCallback(() => {
    if (annotationArrowHoverHideTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(annotationArrowHoverHideTimeoutRef.current);
    annotationArrowHoverHideTimeoutRef.current = null;
  }, []);

  const showAnnotationArrowControls = useCallback(
    (arrowId: string) => {
      clearAnnotationArrowHoverHideTimeout();
      setHoveredAnnotationArrowId((current) => (current === arrowId ? current : arrowId));
    },
    [clearAnnotationArrowHoverHideTimeout],
  );

  const scheduleHideAnnotationArrowControls = useCallback(
    (arrowId: string) => {
      clearAnnotationArrowHoverHideTimeout();
      annotationArrowHoverHideTimeoutRef.current = window.setTimeout(() => {
        annotationArrowHoverHideTimeoutRef.current = null;
        setHoveredAnnotationArrowId((current) => (current === arrowId ? null : current));
      }, 140);
    },
    [clearAnnotationArrowHoverHideTimeout],
  );

  const moveTextAnnotationBox = useCallback(
    (annotationId: string, position: BrowserDrawingPoint) => {
      const previousAnnotation = textAnnotationsRef.current.find(
        (annotation) => annotation.id === annotationId,
      );
      if (!previousAnnotation) {
        return;
      }
      const previousPosition = textAnnotationBoxPosition(previousAnnotation);
      if (
        Math.abs(position.x - previousPosition.x) < 0.25 &&
        Math.abs(position.y - previousPosition.y) < 0.25
      ) {
        return;
      }
      const updatedAnnotations = textAnnotationsRef.current.map((annotation) =>
        annotation.id === annotationId
          ? { ...annotation, boxX: position.x, boxY: position.y }
          : annotation,
      );
      const movedAnnotation = updatedAnnotations.find(
        (annotation) => annotation.id === annotationId,
      );
      textAnnotationsRef.current = updatedAnnotations;
      setTextAnnotations(updatedAnnotations);

      if (!movedAnnotation || annotationArrowsRef.current.length === 0) {
        return;
      }

      const deltaX = position.x - previousPosition.x;
      const deltaY = position.y - previousPosition.y;
      let didMoveArrow = false;
      const updatedArrows = annotationArrowsRef.current.map((arrow) => {
        if (arrow.sourceTextAnnotationId !== annotationId) {
          return arrow;
        }
        didMoveArrow = true;
        if (arrow.sourceHandle) {
          return {
            ...arrow,
            from: textAnnotationHandlePoint(movedAnnotation, arrow.sourceHandle),
          };
        }
        return {
          ...arrow,
          from: {
            x: arrow.from.x + deltaX,
            y: arrow.from.y + deltaY,
          },
        };
      });
      const draftArrow = annotationArrowDraftRef.current;
      if (draftArrow?.sourceTextAnnotationId === annotationId) {
        const updatedDraft =
          draftArrow.sourceHandle !== undefined
            ? {
                ...draftArrow,
                from: textAnnotationHandlePoint(movedAnnotation, draftArrow.sourceHandle),
              }
            : {
                ...draftArrow,
                from: {
                  x: draftArrow.from.x + deltaX,
                  y: draftArrow.from.y + deltaY,
                },
              };
        annotationArrowDraftRef.current = updatedDraft;
        setAnnotationArrowDraft(updatedDraft);
      }
      if (!didMoveArrow) {
        return;
      }
      annotationArrowsRef.current = updatedArrows;
      setAnnotationArrows(updatedArrows);
    },
    [],
  );

  const scheduleTextAnnotationDragPosition = useCallback(
    (drag: NonNullable<typeof textAnnotationDragRef.current>, position: BrowserDrawingPoint) => {
      drag.pendingBoxX = position.x;
      drag.pendingBoxY = position.y;
      if (drag.frameId !== null) {
        return;
      }
      drag.frameId = window.requestAnimationFrame(() => {
        const activeDrag = textAnnotationDragRef.current;
        if (!activeDrag || activeDrag.id !== drag.id) {
          return;
        }
        activeDrag.frameId = null;
        moveTextAnnotationBox(activeDrag.id, {
          x: activeDrag.pendingBoxX,
          y: activeDrag.pendingBoxY,
        });
      });
    },
    [moveTextAnnotationBox],
  );

  const beginTextAnnotationEdit = useCallback(
    (annotation: BrowserTextAnnotation, event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      commitTextAnnotationDraft();
      setSelectedAnnotationArrowId(null);
      textAnnotationEditCancelledRef.current = false;
      setSelectedTextAnnotationId(annotation.id);
      setEditingTextAnnotationId(annotation.id);
      setEditingTextAnnotationValue(annotation.text);
    },
    [commitTextAnnotationDraft],
  );

  const cancelTextAnnotationEdit = useCallback(() => {
    textAnnotationEditCancelledRef.current = true;
    setEditingTextAnnotationId(null);
    setEditingTextAnnotationValue("");
  }, []);

  const commitTextAnnotationEdit = useCallback(() => {
    const annotationId = editingTextAnnotationId;
    if (!annotationId) {
      return;
    }
    if (textAnnotationEditCancelledRef.current) {
      textAnnotationEditCancelledRef.current = false;
      return;
    }

    const text = editingTextAnnotationValue.trim();
    setEditingTextAnnotationId(null);
    setEditingTextAnnotationValue("");

    if (text.length === 0) {
      const updatedAnnotations = textAnnotationsRef.current.filter(
        (annotation) => annotation.id !== annotationId,
      );
      const removedArrowIds = new Set(
        annotationArrowsRef.current
          .filter((arrow) => arrow.sourceTextAnnotationId === annotationId)
          .map((arrow) => arrow.id),
      );
      const updatedArrows = annotationArrowsRef.current.filter(
        (arrow) => arrow.sourceTextAnnotationId !== annotationId,
      );
      textAnnotationsRef.current = updatedAnnotations;
      annotationArrowsRef.current = updatedArrows;
      setTextAnnotations(updatedAnnotations);
      setAnnotationArrows(updatedArrows);
      setSelectedTextAnnotationId((current) => (current === annotationId ? null : current));
      setSelectedAnnotationArrowId((current) =>
        current && removedArrowIds.has(current) ? null : current,
      );
      scheduleBrowserAnnotationAttachmentUpdate(0);
      return;
    }

    const previousAnnotation = textAnnotationsRef.current.find(
      (annotation) => annotation.id === annotationId,
    );
    if (previousAnnotation?.text === text) {
      return;
    }
    const metrics = textAnnotationBoxMetrics(
      text,
      browserTextAnnotationFontSize(previousAnnotation),
    );
    let updatedAnnotation: BrowserTextAnnotation | null = null;
    const updatedAnnotations = textAnnotationsRef.current.map((annotation) => {
      if (annotation.id !== annotationId) {
        return annotation;
      }
      const position = clampTextAnnotationBoxPosition(
        textAnnotationBoxPosition({ ...annotation, text }, metrics),
        browserEditorOverlayRef.current,
        metrics,
      );
      updatedAnnotation = {
        ...annotation,
        text,
        boxX: position.x,
        boxY: position.y,
      };
      return updatedAnnotation;
    });
    textAnnotationsRef.current = updatedAnnotations;
    setTextAnnotations(updatedAnnotations);

    const sourceAnnotation = updatedAnnotation;
    if (sourceAnnotation) {
      const updatedArrows = annotationArrowsRef.current.map((arrow) =>
        arrow.sourceTextAnnotationId === annotationId && arrow.sourceHandle
          ? {
              ...arrow,
              from: textAnnotationHandlePoint(sourceAnnotation, arrow.sourceHandle),
            }
          : arrow,
      );
      annotationArrowsRef.current = updatedArrows;
      setAnnotationArrows(updatedArrows);
    }

    scheduleBrowserAnnotationAttachmentUpdate(0);
  }, [
    editingTextAnnotationId,
    editingTextAnnotationValue,
    scheduleBrowserAnnotationAttachmentUpdate,
  ]);

  const beginTextAnnotationDrag = useCallback(
    (annotation: BrowserTextAnnotation, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitTextAnnotationDraft();
      setSelectedAnnotationArrowId(null);
      setSelectedTextAnnotationId(annotation.id);
      const metrics = browserTextAnnotationMetrics(annotation);
      const boxPosition = textAnnotationBoxPosition(annotation, metrics);
      textAnnotationDragRef.current = {
        id: annotation.id,
        pointerId: event.pointerId,
        metrics,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startBoxX: boxPosition.x,
        startBoxY: boxPosition.y,
        pendingBoxX: boxPosition.x,
        pendingBoxY: boxPosition.y,
        frameId: null,
      };
      setDraggingTextAnnotationId(annotation.id);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [commitTextAnnotationDraft],
  );

  const moveTextAnnotationDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = textAnnotationDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      const next = clampTextAnnotationBoxPosition(
        {
          x: drag.startBoxX + event.clientX - drag.startClientX,
          y: drag.startBoxY + event.clientY - drag.startClientY,
        },
        browserEditorOverlayRef.current,
        drag.metrics,
      );
      scheduleTextAnnotationDragPosition(drag, next);
    },
    [scheduleTextAnnotationDragPosition],
  );

  const finishTextAnnotationDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = textAnnotationDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const next = clampTextAnnotationBoxPosition(
        {
          x: drag.startBoxX + event.clientX - drag.startClientX,
          y: drag.startBoxY + event.clientY - drag.startClientY,
        },
        browserEditorOverlayRef.current,
        drag.metrics,
      );
      if (drag.frameId !== null) {
        window.cancelAnimationFrame(drag.frameId);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      textAnnotationDragRef.current = null;
      setDraggingTextAnnotationId(null);
      moveTextAnnotationBox(drag.id, next);
      if (Math.abs(next.x - drag.startBoxX) >= 0.5 || Math.abs(next.y - drag.startBoxY) >= 0.5) {
        scheduleBrowserAnnotationAttachmentUpdate(0);
      }
    },
    [moveTextAnnotationBox, scheduleBrowserAnnotationAttachmentUpdate],
  );

  const cancelAnnotationArrowDraftFrame = useCallback(() => {
    if (annotationArrowDraftFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(annotationArrowDraftFrameRef.current);
    annotationArrowDraftFrameRef.current = null;
  }, []);

  const flushAnnotationArrowDraftRender = useCallback(() => {
    cancelAnnotationArrowDraftFrame();
    setAnnotationArrowDraft(annotationArrowDraftRef.current);
  }, [cancelAnnotationArrowDraftFrame]);

  const scheduleAnnotationArrowDraftRender = useCallback(() => {
    if (annotationArrowDraftFrameRef.current !== null) {
      return;
    }
    annotationArrowDraftFrameRef.current = window.requestAnimationFrame(() => {
      annotationArrowDraftFrameRef.current = null;
      setAnnotationArrowDraft(annotationArrowDraftRef.current);
    });
  }, []);

  const updateAnnotationArrowDraftTarget = useCallback(
    (clientX: number, clientY: number, options?: { flush?: boolean }) => {
      const draft = annotationArrowDraftRef.current;
      if (!draft) {
        return;
      }
      const point = pointFromOverlayClientPoint(browserEditorOverlayRef.current, clientX, clientY);
      if (Math.abs(point.x - draft.to.x) < 0.25 && Math.abs(point.y - draft.to.y) < 0.25) {
        return;
      }
      annotationArrowDraftRef.current = { ...draft, to: point };
      if (options?.flush) {
        flushAnnotationArrowDraftRender();
        return;
      }
      scheduleAnnotationArrowDraftRender();
    },
    [flushAnnotationArrowDraftRender, scheduleAnnotationArrowDraftRender],
  );

  const updateAnnotationArrowDraftSourceHandle = useCallback(
    (clientX: number, clientY: number, options?: { flush?: boolean }) => {
      const draft = annotationArrowDraftRef.current;
      if (!draft?.sourceTextAnnotationId) {
        return;
      }
      const sourceAnnotation = textAnnotationsRef.current.find(
        (annotation) => annotation.id === draft.sourceTextAnnotationId,
      );
      if (!sourceAnnotation) {
        return;
      }
      const point = pointFromOverlayClientPoint(browserEditorOverlayRef.current, clientX, clientY);
      const sourceHandle = closestTextAnnotationHandle(sourceAnnotation, point);
      const from = textAnnotationHandlePoint(sourceAnnotation, sourceHandle);
      if (
        draft.sourceHandle === sourceHandle &&
        Math.abs(from.x - draft.from.x) < 0.25 &&
        Math.abs(from.y - draft.from.y) < 0.25
      ) {
        return;
      }
      annotationArrowDraftRef.current = { ...draft, from, sourceHandle };
      if (options?.flush) {
        flushAnnotationArrowDraftRender();
        return;
      }
      scheduleAnnotationArrowDraftRender();
    },
    [flushAnnotationArrowDraftRender, scheduleAnnotationArrowDraftRender],
  );

  useEffect(() => cancelAnnotationArrowDraftFrame, [cancelAnnotationArrowDraftFrame]);

  const beginAnnotationArrowDraft = useCallback(
    (
      annotation: BrowserTextAnnotation,
      handle: BrowserAnnotationArrowHandle,
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const from = textAnnotationHandlePoint(annotation, handle);
      const id = crypto.randomUUID();
      const arrow = {
        id,
        from,
        to: pointFromOverlayClientPoint(
          browserEditorOverlayRef.current,
          event.clientX,
          event.clientY,
        ),
        sourceTextAnnotationId: annotation.id,
        sourceHandle: handle,
      } satisfies BrowserAnnotationArrow;
      setSelectedAnnotationArrowId(null);
      setSelectedTextAnnotationId(annotation.id);
      arrowDraftDragRef.current = { id, pointerId: event.pointerId };
      cancelAnnotationArrowDraftFrame();
      annotationArrowDraftRef.current = arrow;
      setAnnotationArrowDraft(arrow);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [cancelAnnotationArrowDraftFrame],
  );

  const moveAnnotationArrowDraft = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = arrowDraftDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      updateAnnotationArrowDraftTarget(event.clientX, event.clientY);
    },
    [updateAnnotationArrowDraftTarget],
  );

  const finishAnnotationArrowDraft = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = arrowDraftDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateAnnotationArrowDraftTarget(event.clientX, event.clientY, { flush: true });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      arrowDraftDragRef.current = null;
      const draft = annotationArrowDraftRef.current;
      annotationArrowDraftRef.current = null;
      setAnnotationArrowDraft(null);
      if (
        draft &&
        draft.id === drag.id &&
        browserAnnotationArrowLength(draft) >= BROWSER_ARROW_MIN_LENGTH
      ) {
        setAnnotationArrows((existing) => {
          const next = [...existing, draft];
          annotationArrowsRef.current = next;
          return next;
        });
        setSelectedAnnotationArrowId(draft.id);
        setSelectedTextAnnotationId(null);
        showAnnotationArrowControls(draft.id);
      }
    },
    [showAnnotationArrowControls, updateAnnotationArrowDraftTarget],
  );

  const beginAnnotationArrowTargetDrag = useCallback(
    (arrow: BrowserAnnotationArrow, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedAnnotationArrowId(arrow.id);
      setSelectedTextAnnotationId(null);
      arrowTargetDragRef.current = { id: arrow.id, pointerId: event.pointerId };
      cancelAnnotationArrowDraftFrame();
      annotationArrowDraftRef.current = arrow;
      setAnnotationArrowDraft(arrow);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [cancelAnnotationArrowDraftFrame],
  );

  const moveAnnotationArrowTargetDrag = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = arrowTargetDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      updateAnnotationArrowDraftTarget(event.clientX, event.clientY);
    },
    [updateAnnotationArrowDraftTarget],
  );

  const finishAnnotationArrowTargetDrag = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = arrowTargetDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateAnnotationArrowDraftTarget(event.clientX, event.clientY, { flush: true });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      arrowTargetDragRef.current = null;
      const draft = annotationArrowDraftRef.current;
      annotationArrowDraftRef.current = null;
      setAnnotationArrowDraft(null);
      if (
        draft &&
        draft.id === drag.id &&
        browserAnnotationArrowLength(draft) >= BROWSER_ARROW_MIN_LENGTH
      ) {
        setAnnotationArrows((existing) => {
          const next = existing.map((arrow) => (arrow.id === draft.id ? draft : arrow));
          annotationArrowsRef.current = next;
          return next;
        });
        setSelectedAnnotationArrowId(draft.id);
        setSelectedTextAnnotationId(null);
        showAnnotationArrowControls(draft.id);
      }
    },
    [showAnnotationArrowControls, updateAnnotationArrowDraftTarget],
  );

  const beginAnnotationArrowSourceDrag = useCallback(
    (arrow: BrowserAnnotationArrow, event: ReactPointerEvent<SVGCircleElement>) => {
      if (event.button !== 0 || !arrow.sourceTextAnnotationId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedAnnotationArrowId(arrow.id);
      setSelectedTextAnnotationId(null);
      arrowSourceDragRef.current = { id: arrow.id, pointerId: event.pointerId };
      cancelAnnotationArrowDraftFrame();
      annotationArrowDraftRef.current = arrow;
      setAnnotationArrowDraft(arrow);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [cancelAnnotationArrowDraftFrame],
  );

  const moveAnnotationArrowSourceDrag = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = arrowSourceDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      updateAnnotationArrowDraftSourceHandle(event.clientX, event.clientY);
    },
    [updateAnnotationArrowDraftSourceHandle],
  );

  const finishAnnotationArrowSourceDrag = useCallback(
    (event: ReactPointerEvent<Element>) => {
      const drag = arrowSourceDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      updateAnnotationArrowDraftSourceHandle(event.clientX, event.clientY, { flush: true });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      arrowSourceDragRef.current = null;
      const draft = annotationArrowDraftRef.current;
      annotationArrowDraftRef.current = null;
      setAnnotationArrowDraft(null);
      if (
        draft &&
        draft.id === drag.id &&
        browserAnnotationArrowLength(draft) >= BROWSER_ARROW_MIN_LENGTH
      ) {
        setAnnotationArrows((existing) => {
          const next = existing.map((arrow) => (arrow.id === draft.id ? draft : arrow));
          annotationArrowsRef.current = next;
          return next;
        });
        setSelectedAnnotationArrowId(draft.id);
        setSelectedTextAnnotationId(null);
        showAnnotationArrowControls(draft.id);
        scheduleBrowserAnnotationAttachmentUpdate(0);
      }
    },
    [
      scheduleBrowserAnnotationAttachmentUpdate,
      showAnnotationArrowControls,
      updateAnnotationArrowDraftSourceHandle,
    ],
  );

  const selectAnnotationArrow = useCallback(
    (arrow: BrowserAnnotationArrow) => {
      setSelectedAnnotationArrowId(arrow.id);
      setSelectedTextAnnotationId(null);
      showAnnotationArrowControls(arrow.id);
    },
    [showAnnotationArrowControls],
  );

  const deleteAnnotationArrowById = useCallback(
    (arrowId: string): boolean => {
      if (!annotationArrowsRef.current.some((arrow) => arrow.id === arrowId)) {
        return false;
      }

      if (annotationArrowDraftRef.current?.id === arrowId) {
        cancelAnnotationArrowDraftFrame();
        annotationArrowDraftRef.current = null;
        arrowDraftDragRef.current = null;
        arrowTargetDragRef.current = null;
        arrowSourceDragRef.current = null;
        setAnnotationArrowDraft(null);
      }

      const nextAnnotationArrows = annotationArrowsRef.current.filter(
        (arrow) => arrow.id !== arrowId,
      );
      annotationArrowsRef.current = nextAnnotationArrows;
      setAnnotationArrows(nextAnnotationArrows);
      setSelectedAnnotationArrowId((current) => (current === arrowId ? null : current));
      setHoveredAnnotationArrowId((current) => (current === arrowId ? null : current));
      scheduleBrowserAnnotationAttachmentUpdate(0);
      return true;
    },
    [cancelAnnotationArrowDraftFrame, scheduleBrowserAnnotationAttachmentUpdate],
  );

  const deleteTextAnnotationById = useCallback(
    (annotationId: string): boolean => {
      if (!textAnnotationsRef.current.some((annotation) => annotation.id === annotationId)) {
        return false;
      }

      const activeTextAnnotationDrag = textAnnotationDragRef.current;
      if (activeTextAnnotationDrag?.id === annotationId) {
        if (activeTextAnnotationDrag.frameId !== null) {
          window.cancelAnimationFrame(activeTextAnnotationDrag.frameId);
        }
        textAnnotationDragRef.current = null;
        setDraggingTextAnnotationId(null);
      }

      if (annotationArrowDraftRef.current?.sourceTextAnnotationId === annotationId) {
        cancelAnnotationArrowDraftFrame();
        annotationArrowDraftRef.current = null;
        arrowDraftDragRef.current = null;
        arrowTargetDragRef.current = null;
        arrowSourceDragRef.current = null;
        setAnnotationArrowDraft(null);
      }

      const nextTextAnnotations = textAnnotationsRef.current.filter(
        (annotation) => annotation.id !== annotationId,
      );
      const removedArrowIds = new Set(
        annotationArrowsRef.current
          .filter((arrow) => arrow.sourceTextAnnotationId === annotationId)
          .map((arrow) => arrow.id),
      );
      const nextAnnotationArrows = annotationArrowsRef.current.filter(
        (arrow) => arrow.sourceTextAnnotationId !== annotationId,
      );

      textAnnotationsRef.current = nextTextAnnotations;
      annotationArrowsRef.current = nextAnnotationArrows;
      setTextAnnotations(nextTextAnnotations);
      setAnnotationArrows(nextAnnotationArrows);
      setSelectedTextAnnotationId((current) => (current === annotationId ? null : current));
      setHoveredTextAnnotationId((current) => (current === annotationId ? null : current));
      setEditingTextAnnotationId((current) => (current === annotationId ? null : current));
      setHoveredAnnotationArrowId((current) =>
        current && removedArrowIds.has(current) ? null : current,
      );
      setSelectedAnnotationArrowId((current) =>
        current && removedArrowIds.has(current) ? null : current,
      );
      scheduleBrowserAnnotationAttachmentUpdate(0);
      return true;
    },
    [scheduleBrowserAnnotationAttachmentUpdate],
  );

  useEffect(() => {
    if (
      !isLiveRuntime ||
      !workspaceReady ||
      editorMode === "browse" ||
      (!selectedAnnotationArrowId && !selectedTextAnnotationId) ||
      editingTextAnnotationId ||
      textAnnotationDraft
    ) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (liveEditorContextPreviewIsOpen()) {
        return;
      }
      if (!isBrowserAnnotationDeleteEvent(event)) {
        return;
      }
      const didDelete = selectedAnnotationArrowId
        ? deleteAnnotationArrowById(selectedAnnotationArrowId)
        : selectedTextAnnotationId
          ? deleteTextAnnotationById(selectedTextAnnotationId)
          : false;
      if (!didDelete) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [
    deleteAnnotationArrowById,
    deleteTextAnnotationById,
    editingTextAnnotationId,
    editorMode,
    isLiveRuntime,
    selectedAnnotationArrowId,
    selectedTextAnnotationId,
    textAnnotationDraft,
    workspaceReady,
  ]);

  const onBrowserEditorOverlayClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (editorMode === "inspect") {
        onInspectClick(event);
        return;
      }
      if (editorMode === "text") {
        onTextAnnotationClick(event);
      }
    },
    [editorMode, onInspectClick, onTextAnnotationClick],
  );

  const onBrowserEditorOverlayDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (editorMode === "text") {
        onTextAnnotationDoubleClick(event);
      }
    },
    [editorMode, onTextAnnotationDoubleClick],
  );

  const onDrawPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (editorMode !== "draw" || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resetActiveDrawStroke();
      event.currentTarget.setPointerCapture(event.pointerId);
      const strokeId = crypto.randomUUID();
      const overlayRect = event.currentTarget.getBoundingClientRect();
      const stroke = {
        id: strokeId,
        points: [pointFromOverlayRect(overlayRect, event.clientX, event.clientY)],
        strokeSize: drawStrokeSize,
        animated: drawStrokeAnimated,
      };
      activeDrawPointerIdRef.current = event.pointerId;
      activeDrawOverlayRectRef.current = overlayRect;
      activeDrawStrokeRef.current = stroke;
      setActiveDrawStroke(stroke);
    },
    [drawStrokeAnimated, drawStrokeSize, editorMode, resetActiveDrawStroke],
  );

  const onDrawPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (editorMode !== "draw") {
        return;
      }
      const stroke = activeDrawStrokeRef.current;
      if (!stroke || activeDrawPointerIdRef.current !== event.pointerId) {
        return;
      }
      event.preventDefault();
      const nativeEvent = event.nativeEvent as PointerEvent & {
        getCoalescedEvents?: () => PointerEvent[];
      };
      let changed = false;
      for (const pointerEvent of nativeEvent.getCoalescedEvents?.() ?? [nativeEvent]) {
        changed =
          appendDrawingPoint(
            stroke,
            pointFromOverlayRect(
              activeDrawOverlayRectRef.current,
              pointerEvent.clientX,
              pointerEvent.clientY,
            ),
          ) || changed;
      }
      if (changed) {
        updateActiveDrawStrokeElements(stroke);
      }
    },
    [editorMode, updateActiveDrawStrokeElements],
  );

  const onDrawPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const stroke = activeDrawStrokeRef.current;
      if (!stroke || activeDrawPointerIdRef.current !== event.pointerId) {
        return;
      }
      event.preventDefault();
      appendDrawingPoint(
        stroke,
        pointFromOverlayRect(activeDrawOverlayRectRef.current, event.clientX, event.clientY),
        0.5,
      );
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const committedStroke =
        stroke.points.length > 1 ? { ...stroke, points: stroke.points.slice() } : null;
      resetActiveDrawStroke();
      if (!committedStroke) {
        return;
      }
      const nextDrawStrokes = [...drawStrokesRef.current, committedStroke];
      drawStrokesRef.current = nextDrawStrokes;
      setDrawStrokes(nextDrawStrokes);
      scheduleBrowserAnnotationAttachmentUpdate(0);
    },
    [resetActiveDrawStroke, scheduleBrowserAnnotationAttachmentUpdate],
  );

  const onBrowserEditorOverlayPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (textAnnotationDragRef.current) {
        moveTextAnnotationDrag(event);
        return;
      }
      if (arrowDraftDragRef.current) {
        moveAnnotationArrowDraft(event);
        return;
      }
      if (arrowTargetDragRef.current) {
        moveAnnotationArrowTargetDrag(event);
        return;
      }
      if (arrowSourceDragRef.current) {
        moveAnnotationArrowSourceDrag(event);
        return;
      }
      if (editorMode === "inspect") {
        onInspectPointerMove(event);
        return;
      }
      if (editorMode === "draw") {
        onDrawPointerMove(event);
      }
    },
    [
      editorMode,
      moveAnnotationArrowDraft,
      moveAnnotationArrowSourceDrag,
      moveAnnotationArrowTargetDrag,
      moveTextAnnotationDrag,
      onDrawPointerMove,
      onInspectPointerMove,
    ],
  );

  const onBrowserEditorOverlayPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (textAnnotationDragRef.current) {
        finishTextAnnotationDrag(event);
        return;
      }
      if (arrowDraftDragRef.current) {
        finishAnnotationArrowDraft(event);
        return;
      }
      if (arrowTargetDragRef.current) {
        finishAnnotationArrowTargetDrag(event);
        return;
      }
      if (arrowSourceDragRef.current) {
        finishAnnotationArrowSourceDrag(event);
        return;
      }
      onDrawPointerUp(event);
    },
    [
      finishAnnotationArrowDraft,
      finishAnnotationArrowSourceDrag,
      finishAnnotationArrowTargetDrag,
      finishTextAnnotationDrag,
      onDrawPointerUp,
    ],
  );

  const clearDrawingAnnotations = useCallback(() => {
    cancelInlineTextEditing();
    resetActiveDrawStroke();
    drawStrokesRef.current = [];
    textAnnotationsRef.current = [];
    annotationArrowsRef.current = [];
    cancelAnnotationArrowDraftFrame();
    annotationArrowDraftRef.current = null;
    arrowDraftDragRef.current = null;
    arrowTargetDragRef.current = null;
    arrowSourceDragRef.current = null;
    clearTextAnnotationHoverHideTimeout();
    clearAnnotationArrowHoverHideTimeout();
    const activeTextAnnotationDrag = textAnnotationDragRef.current;
    if (
      activeTextAnnotationDrag?.frameId !== null &&
      activeTextAnnotationDrag?.frameId !== undefined
    ) {
      window.cancelAnimationFrame(activeTextAnnotationDrag.frameId);
    }
    textAnnotationDragRef.current = null;
    selectedElementContextRef.current = null;
    inlineTextEditorRef.current = null;
    setDrawStrokes([]);
    setTextAnnotations([]);
    setAnnotationArrows([]);
    setAnnotationArrowDraft(null);
    setSelectedTextAnnotationId(null);
    setSelectedAnnotationArrowId(null);
    setHoveredTextAnnotationId(null);
    setHoveredAnnotationArrowId(null);
    setDraggingTextAnnotationId(null);
    setEditingTextAnnotationId(null);
    setEditingTextAnnotationValue("");
    setTextAnnotationDraft(null);
    setSelectedElementContext(null);
    setInlineTextEditor(null);
    setLocalError(null);
  }, [
    clearAnnotationArrowHoverHideTimeout,
    clearTextAnnotationHoverHideTimeout,
    cancelAnnotationArrowDraftFrame,
    cancelInlineTextEditing,
    resetActiveDrawStroke,
  ]);

  // Selection boxes, strokes, text annotations, and arrows are all positioned
  // against the page they were captured on. Drop them whenever the page changes -
  // tab switch or same-tab navigation (address bar, back/forward, reload) - so
  // stale overlays never float over unrelated content.
  const editorPageKey = `${activeTab?.id ?? ""} ${stylePreviewPageKey(
    activeTab ? (activeTab.lastCommittedUrl ?? activeTab.url) : null,
  )}`;
  useEffect(() => {
    if (editorPageKeyRef.current === "") {
      editorPageKeyRef.current = editorPageKey;
      return;
    }
    if (editorPageKeyRef.current === editorPageKey) {
      return;
    }
    editorPageKeyRef.current = editorPageKey;
    clearDrawingAnnotations();
  }, [clearDrawingAnnotations, editorPageKey]);

  const undoLastDrawingStroke = useCallback(() => {
    resetActiveDrawStroke();
    if (annotationArrowsRef.current.length > 0) {
      const removedArrowId = annotationArrowsRef.current.at(-1)?.id ?? null;
      setAnnotationArrows((current) => {
        const next = current.slice(0, -1);
        annotationArrowsRef.current = next;
        return next;
      });
      if (removedArrowId) {
        setHoveredAnnotationArrowId((current) => (current === removedArrowId ? null : current));
        setSelectedAnnotationArrowId((current) => (current === removedArrowId ? null : current));
      }
    } else if (drawStrokesRef.current.some((stroke) => stroke.points.length > 1)) {
      setDrawStrokes((current) => {
        const next = current.slice(0, -1);
        drawStrokesRef.current = next;
        return next;
      });
    } else {
      const removedTextAnnotationId = textAnnotationsRef.current.at(-1)?.id ?? null;
      setTextAnnotations((current) => {
        const next = current.slice(0, -1);
        textAnnotationsRef.current = next;
        return next;
      });
      if (removedTextAnnotationId) {
        const removedArrowIds = new Set(
          annotationArrowsRef.current
            .filter((arrow) => arrow.sourceTextAnnotationId === removedTextAnnotationId)
            .map((arrow) => arrow.id),
        );
        setSelectedTextAnnotationId((current) =>
          current === removedTextAnnotationId ? null : current,
        );
        setEditingTextAnnotationId((current) =>
          current === removedTextAnnotationId ? null : current,
        );
        setHoveredTextAnnotationId((current) =>
          current === removedTextAnnotationId ? null : current,
        );
        setSelectedAnnotationArrowId((current) =>
          current && removedArrowIds.has(current) ? null : current,
        );
        setHoveredAnnotationArrowId((current) =>
          current && removedArrowIds.has(current) ? null : current,
        );
        setAnnotationArrows((current) => {
          const next = current.filter(
            (arrow) => arrow.sourceTextAnnotationId !== removedTextAnnotationId,
          );
          annotationArrowsRef.current = next;
          return next;
        });
      }
    }
    scheduleBrowserAnnotationAttachmentUpdate(0);
  }, [resetActiveDrawStroke, scheduleBrowserAnnotationAttachmentUpdate]);

  const closeStylePropertiesPanel = useCallback(() => {
    void clearBrowserStylePreview();
    setStylePropertiesPanelOpen(false);
    setStylePanelDragging(false);
  }, [clearBrowserStylePreview]);

  const resetStylePropertiesPreview = useCallback(() => {
    void clearBrowserStylePreview();
  }, [clearBrowserStylePreview]);

  const snapshotVisibleBrowserEditorState = useCallback(
    (options?: {
      stylePatch?: BrowserElementStylePatch | null;
    }): BrowserEditorVisibleStateSnapshot => {
      const normalizedStylePatch = normalizeBrowserElementStylePatch(
        options?.stylePatch ?? styleEditorInitialPatch ?? stylePreviewActivePatchRef.current ?? {},
      );
      return {
        editorMode,
        drawStrokes: drawStrokesRef.current.map((stroke) => ({
          ...stroke,
          points: stroke.points.slice(),
        })),
        textAnnotations: textAnnotationsRef.current.map((annotation) => ({ ...annotation })),
        annotationArrows: annotationArrowsRef.current.map((arrow) => ({
          ...arrow,
          from: { ...arrow.from },
          to: { ...arrow.to },
        })),
        selectedElementContext: selectedElementContextRef.current,
        selectedTextAnnotationId,
        selectedAnnotationArrowId,
        stylePropertiesPanelOpen,
        stylePanelPositionOverride,
        styleEditorInitialPatch:
          Object.keys(normalizedStylePatch).length > 0 ? normalizedStylePatch : null,
      };
    },
    [
      editorMode,
      selectedAnnotationArrowId,
      selectedTextAnnotationId,
      styleEditorInitialPatch,
      stylePanelPositionOverride,
      stylePropertiesPanelOpen,
    ],
  );

  const clearVisibleBrowserEditorState = useCallback(() => {
    cancelInlineTextEditing();
    resetActiveDrawStroke();
    drawStrokesRef.current = [];
    textAnnotationsRef.current = [];
    annotationArrowsRef.current = [];
    cancelAnnotationArrowDraftFrame();
    annotationArrowDraftRef.current = null;
    arrowDraftDragRef.current = null;
    arrowTargetDragRef.current = null;
    arrowSourceDragRef.current = null;
    clearTextAnnotationHoverHideTimeout();
    clearAnnotationArrowHoverHideTimeout();
    const activeTextAnnotationDrag = textAnnotationDragRef.current;
    if (
      activeTextAnnotationDrag?.frameId !== null &&
      activeTextAnnotationDrag?.frameId !== undefined
    ) {
      window.cancelAnimationFrame(activeTextAnnotationDrag.frameId);
    }
    textAnnotationDragRef.current = null;
    selectedElementContextRef.current = null;
    inlineTextEditorRef.current = null;
    setDrawStrokes([]);
    setTextAnnotations([]);
    setAnnotationArrows([]);
    setAnnotationArrowDraft(null);
    setSelectedTextAnnotationId(null);
    setSelectedAnnotationArrowId(null);
    setHoveredTextAnnotationId(null);
    setHoveredAnnotationArrowId(null);
    setDraggingTextAnnotationId(null);
    setEditingTextAnnotationId(null);
    setEditingTextAnnotationValue("");
    setTextAnnotationDraft(null);
    setInspectHoverBox(null);
    setSelectedElementContext(null);
    setInlineTextEditor(null);
    setStylePropertiesPanelOpen(false);
    setStylePanelPositionOverride(null);
    setStyleEditorInitialPatch(null);
    void clearBrowserStylePreview();
    setLocalError(null);
  }, [
    clearAnnotationArrowHoverHideTimeout,
    clearBrowserStylePreview,
    clearTextAnnotationHoverHideTimeout,
    cancelAnnotationArrowDraftFrame,
    cancelInlineTextEditing,
    resetActiveDrawStroke,
  ]);

  const clearVisibleBrowserEditorStateWithUndo = useCallback(
    (options?: { stylePatch?: BrowserElementStylePatch | null }) => {
      editorClearUndoSnapshotRef.current = snapshotVisibleBrowserEditorState(options);
      clearVisibleBrowserEditorState();
    },
    [clearVisibleBrowserEditorState, snapshotVisibleBrowserEditorState],
  );

  const restoreVisibleBrowserEditorState = useCallback((): boolean => {
    const snapshot = editorClearUndoSnapshotRef.current;
    if (!snapshot) {
      return false;
    }
    editorClearUndoSnapshotRef.current = null;
    resetActiveDrawStroke();
    drawStrokesRef.current = snapshot.drawStrokes;
    textAnnotationsRef.current = snapshot.textAnnotations;
    annotationArrowsRef.current = snapshot.annotationArrows;
    selectedElementContextRef.current = snapshot.selectedElementContext;
    setEditorMode(snapshot.editorMode);
    setDrawStrokes(snapshot.drawStrokes);
    setTextAnnotations(snapshot.textAnnotations);
    setAnnotationArrows(snapshot.annotationArrows);
    setSelectedElementContext(snapshot.selectedElementContext);
    setSelectedTextAnnotationId(snapshot.selectedTextAnnotationId);
    setSelectedAnnotationArrowId(snapshot.selectedAnnotationArrowId);
    setStylePropertiesPanelOpen(snapshot.stylePropertiesPanelOpen);
    setStylePanelPositionOverride(snapshot.stylePanelPositionOverride);
    setStyleEditorInitialPatch(snapshot.styleEditorInitialPatch);
    setLocalError(null);
    if (
      snapshot.selectedElementContext &&
      snapshot.styleEditorInitialPatch &&
      Object.keys(snapshot.styleEditorInitialPatch).length > 0 &&
      activeTab
    ) {
      const selector = snapshot.selectedElementContext.selector;
      const patch = snapshot.styleEditorInitialPatch;
      const tabId = activeTab.id;
      const tabPageUrl = activeTab.lastCommittedUrl ?? activeTab.url;
      window.requestAnimationFrame(() => {
        void runStylePreviewAction({
          selector,
          tabId,
          patch,
          mode: "preview",
        }).then((ok) => {
          if (!ok) {
            setLocalError("Could not restore the style preview for the selected element.");
            return;
          }
          stylePreviewTargetRef.current = { selector, tabId, url: tabPageUrl };
          stylePreviewActivePatchRef.current = patch;
        });
      });
    }
    return true;
  }, [activeTab, resetActiveDrawStroke, runStylePreviewAction]);

  useEffect(() => {
    if (!isLiveRuntime || !workspaceReady) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (liveEditorContextPreviewIsOpen()) {
        return;
      }
      if (!isBrowserEditorRestoreEvent(event) || isEditableKeyboardEventTarget(event.target)) {
        return;
      }
      if (!restoreVisibleBrowserEditorState()) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isLiveRuntime, restoreVisibleBrowserEditorState, workspaceReady]);

  useEffect(() => {
    if (!isLiveRuntime || !workspaceReady) {
      return;
    }
    const isEditorShortcutSurfaceActive = (event: KeyboardEvent) => {
      if (browserEditorFocusedRef.current) {
        return true;
      }
      if (
        isBrowserEditorSurfaceEventTarget(event.target) ||
        isBrowserEditorChromeEventTarget(event.target)
      ) {
        return true;
      }
      const activeElement = document.activeElement;
      return (
        activeElement instanceof Element &&
        (Boolean(activeElement.closest(BROWSER_EDITOR_SURFACE_SELECTOR)) ||
          Boolean(activeElement.closest(BROWSER_EDITOR_CHROME_SELECTOR)))
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isEditorShortcutSurfaceActive(event)) {
        return;
      }
      if (event.metaKey && !isEditableKeyboardEventTarget(event.target)) {
        setShowEditorShortcutHints(true);
      }
      if (event.defaultPrevented || isEditableKeyboardEventTarget(event.target)) {
        return;
      }
      const mode = liveEditorShortcutForEvent(event);
      if (!mode) {
        return;
      }
      setEditorMode(mode);
      consumeBrowserEditorShortcutEvent(event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.metaKey) {
        setShowEditorShortcutHints(false);
      }
    };
    const onBlur = () => {
      setShowEditorShortcutHints(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [isLiveRuntime, workspaceReady]);

  useEffect(() => {
    if (!api || !isLiveRuntime || !isLiveEditorVariant || !workspaceReady) {
      return;
    }
    void api.browser.setEditorShortcutsEnabled({ threadId, enabled: true });
    return () => {
      void api.browser.setEditorShortcutsEnabled({ threadId, enabled: false });
    };
  }, [api, isLiveEditorVariant, isLiveRuntime, threadId, workspaceReady]);

  useEffect(() => {
    if (!api || !isLiveRuntime || !isLiveEditorVariant || !workspaceReady) {
      return;
    }
    return api.browser.onEditorShortcut((event) => {
      if (event.threadId !== threadId || event.tabId !== activeTab?.id) {
        return;
      }
      setBrowserEditorFocusState(true);
      if (event.type === "modifier") {
        setShowEditorShortcutHints(Boolean(event.down));
        return;
      }
      const mode = liveEditorModeForShortcutKey(event.key);
      if (mode) {
        setEditorMode(mode);
      }
    });
  }, [
    activeTab?.id,
    api,
    isLiveEditorVariant,
    isLiveRuntime,
    setBrowserEditorFocusState,
    threadId,
    workspaceReady,
  ]);

  useLayoutEffect(() => {
    if (showEditorShortcutHints || openToolOptions) {
      measureEditorToolbarAnchors();
    }
  }, [measureEditorToolbarAnchors, openToolOptions, showEditorShortcutHints]);

  useEffect(() => {
    if (!showEditorShortcutHints && !openToolOptions) {
      return;
    }
    const updateAnchors = () => {
      measureEditorToolbarAnchors();
    };
    window.addEventListener("resize", updateAnchors);
    window.addEventListener("scroll", updateAnchors, true);
    return () => {
      window.removeEventListener("resize", updateAnchors);
      window.removeEventListener("scroll", updateAnchors, true);
    };
  }, [measureEditorToolbarAnchors, openToolOptions, showEditorShortcutHints]);

  useEffect(
    () => () => {
      clearToolOptionsHoverTimeout();
      clearToolOptionsCloseTimeout();
    },
    [clearToolOptionsCloseTimeout, clearToolOptionsHoverTimeout],
  );

  useEffect(() => {
    if (liveEditorContextPreviewIsOpen()) {
      return;
    }
    const previousCount = previousComposerBrowserContextCountRef.current;
    previousComposerBrowserContextCountRef.current = composerBrowserContextCount;
    if (previousCount === 0 || composerBrowserContextCount !== 0) {
      return;
    }
    const hasVisualAnnotations =
      drawStrokesRef.current.some((stroke) => stroke.points.length > 1) ||
      textAnnotationsRef.current.length > 0 ||
      annotationArrowsRef.current.length > 0 ||
      annotationArrowDraftRef.current !== null;
    if (hasVisualAnnotations) {
      return;
    }
    const hasVisibleEditorState =
      selectedElementContextRef.current !== null || drawStrokesRef.current.length > 0;
    if (hasVisibleEditorState) {
      clearVisibleBrowserEditorStateWithUndo();
    }
  }, [clearVisibleBrowserEditorStateWithUndo, composerBrowserContextCount]);

  useEffect(() => {
    if (!isLiveRuntime || !workspaceReady) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (liveEditorContextPreviewIsOpen()) {
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.closest("[data-browser-properties-popover='true']") ||
        target?.closest("[data-browser-text-annotation-input='true']")
      ) {
        return;
      }
      const hasVisibleEditorState =
        selectedElementContextRef.current !== null ||
        drawStrokesRef.current.length > 0 ||
        textAnnotationsRef.current.length > 0 ||
        annotationArrowsRef.current.length > 0 ||
        annotationArrowDraftRef.current !== null ||
        textAnnotationDraft !== null ||
        inspectHoverBox !== null ||
        selectedTextAnnotationId !== null ||
        selectedAnnotationArrowId !== null;

      if (openToolOptions) {
        closeToolOptions();
      } else if (inlineTextEditorRef.current) {
        cancelInlineTextEditing();
      } else if (stylePropertiesPanelOpen) {
        closeStylePropertiesPanel();
      } else if (hasVisibleEditorState) {
        clearVisibleBrowserEditorState();
      } else if (editorMode !== "browse") {
        setEditorMode("browse");
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [
    cancelInlineTextEditing,
    clearVisibleBrowserEditorState,
    closeToolOptions,
    closeStylePropertiesPanel,
    editorMode,
    inspectHoverBox,
    isLiveRuntime,
    openToolOptions,
    selectedAnnotationArrowId,
    selectedTextAnnotationId,
    stylePropertiesPanelOpen,
    textAnnotationDraft,
    workspaceReady,
  ]);

  const attachStyleEditContext = useCallback(
    (patch: BrowserElementStylePatch, manualOverride: boolean) => {
      const selectedContext = selectedElementContextRef.current;
      if (!selectedContext) {
        setLocalError("Select an element before attaching style context.");
        return;
      }
      const previewStyle = normalizeBrowserElementStylePatch(patch);
      const promptBlock = buildBrowserStyleEditPromptBlock({
        element: selectedContext,
        currentStyle: selectedContext.style ?? null,
        previewStyle,
        manualOverride,
      });
      const draftStore = useComposerDraftStore.getState();
      const currentDraft = draftStore.draftsByThreadId[threadId];
      draftStore.setBrowserContexts(threadId, [
        {
          id: randomUUID(),
          type: "browser-context",
          source: "browser-selection",
          promptBlock,
          title: selectedContext.title || activeTab?.title || "Browser style edit",
          url:
            selectedContext.url ||
            activeTab?.lastCommittedUrl ||
            activeTab?.url ||
            BROWSER_BLANK_URL,
          strokeCount: 0,
          textCount: 0,
          ...(selectedContext.selector ? { selectedSelector: selectedContext.selector } : {}),
        } satisfies ComposerBrowserContextAttachment,
      ]);
      draftStore.setPrompt(
        threadId,
        removeBrowserAnnotationContextPrompt(currentDraft?.prompt ?? ""),
      );
      toastManager.add({
        type: "success",
        title: "Style context attached",
        description: Object.keys(previewStyle).length
          ? "Previewed style changes were added to Live Editor Context."
          : "Current element styles were added to Live Editor Context.",
      });
      setLocalError(null);
    },
    [activeTab, threadId],
  );

  const applyStyleEditToSource = useCallback(
    (patch: BrowserElementStylePatch) => {
      void (async () => {
        const selectedContext = selectedElementContextRef.current;
        const cwd = previewState?.targetCwd ?? previewCwd;
        const normalizedPatch = normalizeBrowserElementStylePatch(patch);
        if (!selectedContext) {
          setLocalError("Select an element before applying a source style edit.");
          return;
        }
        if (!api || !cwd) {
          setLocalError("Could not apply the style edit because no project source is active.");
          return;
        }
        if (Object.keys(normalizedPatch).length === 0) {
          setLocalError("Change a style value before applying it to source.");
          return;
        }

        try {
          const result = await api.projects.applyStyleEdit({
            cwd,
            element: {
              tagName: selectedContext.tagName,
              text: selectedContext.text.slice(0, 4_000),
              outerHTML: selectedContext.outerHTML.slice(0, 12_000),
              attributes: selectedContext.attributes,
            },
            patch: normalizedPatch,
          });
          toastManager.add({
            type: "success",
            title: "Source style edit applied",
            description: `Updated ${result.relativePath}.`,
          });
          setStylePropertiesPanelOpen(false);
          setLocalError(null);
          window.setTimeout(() => {
            void clearBrowserStylePreview();
          }, 250);
        } catch (error) {
          setLocalError(
            formatEditorActionError(error, "Could not apply the style edit to source."),
          );
        }
      })();
    },
    [api, clearBrowserStylePreview, previewCwd, previewState?.targetCwd],
  );

  const addDrawingToPrompt = useCallback(() => {
    const usableStrokes = drawStrokesRef.current.filter((stroke) => stroke.points.length > 1);
    if (
      usableStrokes.length === 0 &&
      textAnnotationsRef.current.length === 0 &&
      annotationArrowsRef.current.length === 0 &&
      !selectedElementContextRef.current
    ) {
      setLocalError("Annotate the page before adding live editor context.");
      return;
    }
    void updateBrowserAnnotationAttachment().then(() => {
      toastManager.add({
        type: "success",
        title: "Live editor context attached",
      });
      clearVisibleBrowserEditorStateWithUndo();
      setLocalError(null);
    });
  }, [clearVisibleBrowserEditorStateWithUndo, updateBrowserAnnotationAttachment]);

  const browserSvgIdPrefix = useMemo(() => svgFragmentId(threadId), [threadId]);
  const usableDrawStrokeCount = useMemo(
    () => drawStrokes.reduce((count, stroke) => count + (stroke.points.length > 1 ? 1 : 0), 0),
    [drawStrokes],
  );
  const hasTextAnnotations = textAnnotations.length > 0;
  const hasAnnotationArrows = annotationArrows.length > 0;
  const canUndoAnnotation = usableDrawStrokeCount > 0 || hasTextAnnotations || hasAnnotationArrows;
  const hasBrowserAnnotation =
    usableDrawStrokeCount > 0 ||
    hasTextAnnotations ||
    hasAnnotationArrows ||
    selectedElementContext !== null;
  const renderedDrawStrokes = useMemo(
    () => (activeDrawStroke ? [...drawStrokes, activeDrawStroke] : drawStrokes),
    [activeDrawStroke, drawStrokes],
  );
  const renderedDrawStrokeItems = useMemo<BrowserDrawStrokeRenderItem[]>(
    () =>
      renderedDrawStrokes.map((stroke, strokeIndex) => {
        const colors = gradientColorsForStroke(strokeIndex);
        const widths = browserDrawingStrokeWidths(stroke);
        return {
          stroke,
          points: drawingStrokePoints(stroke),
          isActive: activeDrawStroke?.id === stroke.id,
          animated: stroke.animated !== false,
          contrastStrokeWidth: widths.contrast,
          gradientStrokeWidth: widths.gradient,
          glintStrokeWidth: widths.glint,
          gradientId: `browser-drawing-gradient-${browserSvgIdPrefix}-${svgFragmentId(stroke.id)}`,
          colors,
          stopColorValues: browserGradientStopColorValues(colors),
          animationBegin: `${strokeIndex * 0.13}s`,
        };
      }),
    [
      activeDrawStroke?.id,
      activeDrawStroke?.points.length,
      browserSvgIdPrefix,
      renderedDrawStrokes,
    ],
  );
  const selectedAnnotationViewportBox = useMemo(
    () =>
      selectedElementContext
        ? {
            x: selectedElementContext.rect.x,
            y: selectedElementContext.rect.y,
            width: selectedElementContext.rect.width,
            height: selectedElementContext.rect.height,
            label: selectedElementContext.selector || selectedElementContext.tagName.toLowerCase(),
            viewport: selectedElementContext.viewport,
          }
        : null,
    [selectedElementContext],
  );
  const selectedAnnotationBox =
    selectedAnnotationViewportBox && selectedAnnotationViewportBox.viewport
      ? browserViewportBoxToOverlayBox(
          selectedAnnotationViewportBox,
          browserAnnotationGeometryFromViewport({
            overlay: browserEditorOverlayRef.current,
            viewport: browserViewportRef.current,
            viewportSize: selectedAnnotationViewportBox.viewport,
          }),
        )
      : selectedAnnotationViewportBox;
  const inspectHoverOverlayBox =
    inspectHoverBox && inspectHoverBox.viewport
      ? browserViewportBoxToOverlayBox(
          inspectHoverBox,
          browserAnnotationGeometryFromViewport({
            overlay: browserEditorOverlayRef.current,
            viewport: browserViewportRef.current,
            viewportSize: inspectHoverBox.viewport,
          }),
        )
      : inspectHoverBox;
  const selectedStyleEditorAnchor = useMemo(
    () =>
      selectedAnnotationBox && selectedElementContext
        ? (() => {
            const overlayGeometry = browserAnnotationGeometryFromViewport({
              overlay: browserEditorOverlayRef.current,
              viewport: browserViewportRef.current,
              viewportSize: selectedElementContext.viewport,
            });
            const viewportWidth = Math.max(1, overlayGeometry.overlayWidth);
            const viewportHeight = Math.max(1, overlayGeometry.overlayHeight);
            const panelHeight = Math.min(
              BROWSER_STYLE_PANEL_MAX_HEIGHT,
              Math.max(240, viewportHeight - BROWSER_STYLE_PANEL_VIEWPORT_PADDING * 2),
            );
            const panelMaxLeft = Math.max(
              BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
              viewportWidth - BROWSER_STYLE_PANEL_WIDTH - BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
            );
            const panelMaxTop = Math.max(
              BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
              viewportHeight - panelHeight - BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
            );
            const buttonWidth = 28;
            const buttonHeight = 24;
            const buttonGap = 2;
            const buttonGroupWidth = buttonWidth * 2 + buttonGap;
            const buttonTop = selectedAnnotationBox.y - buttonHeight - buttonGap;
            const buttonBottom = selectedAnnotationBox.y + selectedAnnotationBox.height + buttonGap;
            const boxRight = selectedAnnotationBox.x + selectedAnnotationBox.width;
            const boxBottom = selectedAnnotationBox.y + selectedAnnotationBox.height;
            const panelCandidates = [
              {
                left: boxRight + BROWSER_STYLE_PANEL_GAP,
                top: selectedAnnotationBox.y + selectedAnnotationBox.height / 2 - panelHeight / 2,
              },
              {
                left: selectedAnnotationBox.x - BROWSER_STYLE_PANEL_WIDTH - BROWSER_STYLE_PANEL_GAP,
                top: selectedAnnotationBox.y + selectedAnnotationBox.height / 2 - panelHeight / 2,
              },
              {
                left: boxRight - BROWSER_STYLE_PANEL_WIDTH,
                top: boxBottom + BROWSER_STYLE_PANEL_GAP,
              },
              {
                left: boxRight - BROWSER_STYLE_PANEL_WIDTH,
                top: selectedAnnotationBox.y - panelHeight - BROWSER_STYLE_PANEL_GAP,
              },
            ];
            const panel = panelCandidates
              .map((candidate, priority) => {
                const left = clampBrowserNumber(
                  candidate.left,
                  BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
                  panelMaxLeft,
                );
                const top = clampBrowserNumber(
                  candidate.top,
                  BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
                  panelMaxTop,
                );
                const overlapWidth = Math.max(
                  0,
                  Math.min(left + BROWSER_STYLE_PANEL_WIDTH, boxRight) -
                    Math.max(left, selectedAnnotationBox.x),
                );
                const overlapHeight = Math.max(
                  0,
                  Math.min(top + panelHeight, boxBottom) - Math.max(top, selectedAnnotationBox.y),
                );
                const clampDistance =
                  Math.abs(left - candidate.left) + Math.abs(top - candidate.top);
                return {
                  left,
                  top,
                  score: overlapWidth * overlapHeight * 1000 + clampDistance + priority / 100,
                };
              })
              .reduce((best, candidate) => (candidate.score < best.score ? candidate : best));
            return {
              button: {
                left: clampBrowserNumber(
                  selectedAnnotationBox.x + selectedAnnotationBox.width - buttonGroupWidth,
                  8,
                  Math.max(8, viewportWidth - buttonGroupWidth - 8),
                ),
                top: clampBrowserNumber(
                  buttonTop >= 8 ? buttonTop : buttonBottom,
                  8,
                  Math.max(8, viewportHeight - buttonHeight - 8),
                ),
              },
              panel: {
                left: panel.left,
                top: panel.top,
              },
            };
          })()
        : null,
    [selectedAnnotationBox, selectedElementContext],
  );
  const stylePropertiesPanelPosition =
    stylePanelPositionOverride ?? selectedStyleEditorAnchor?.panel ?? null;
  const beginStylePropertiesPanelDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !selectedElementContext || !selectedStyleEditorAnchor) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const dragElement = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        dragElement.setPointerCapture(pointerId);
      } catch {
        // Some embedded-browser pointer paths do not expose capture consistently.
      }
      const startPosition = stylePanelPositionOverride ?? selectedStyleEditorAnchor.panel;
      const viewportWidth = Math.max(1, selectedElementContext.viewport.width);
      const viewportHeight = Math.max(1, selectedElementContext.viewport.height);
      const panelHeight = Math.min(
        BROWSER_STYLE_PANEL_MAX_HEIGHT,
        Math.max(240, viewportHeight - BROWSER_STYLE_PANEL_VIEWPORT_PADDING * 2),
      );
      const minLeft = BROWSER_STYLE_PANEL_VIEWPORT_PADDING;
      const maxLeft = Math.max(
        minLeft,
        viewportWidth - BROWSER_STYLE_PANEL_WIDTH - BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
      );
      const minTop = BROWSER_STYLE_PANEL_VIEWPORT_PADDING;
      const maxTop = Math.max(
        minTop,
        viewportHeight - panelHeight - BROWSER_STYLE_PANEL_VIEWPORT_PADDING,
      );
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const applyDragPosition = (nextPosition: BrowserStylePanelPosition) => {
        stylePanelDragPositionRef.current = nextPosition;
        const panelElement = stylePanelElementRef.current;
        if (panelElement) {
          panelElement.style.transform = `translate3d(${nextPosition.left}px, ${nextPosition.top}px, 0)`;
        }
      };
      setStylePanelDragging(true);
      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        applyDragPosition({
          left: clampBrowserNumber(
            startPosition.left + moveEvent.clientX - startClientX,
            minLeft,
            maxLeft,
          ),
          top: clampBrowserNumber(
            startPosition.top + moveEvent.clientY - startClientY,
            minTop,
            maxTop,
          ),
        });
      };
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        window.removeEventListener("blur", onPointerUp);
        try {
          if (dragElement.hasPointerCapture(pointerId)) {
            dragElement.releasePointerCapture(pointerId);
          }
        } catch {
          // Pointer capture may already be gone if the drag crossed a native view.
        }
        if (stylePanelDragPositionRef.current) {
          setStylePanelPositionOverride(stylePanelDragPositionRef.current);
          stylePanelDragPositionRef.current = null;
        }
        setStylePanelDragging(false);
      };
      stylePanelDragPositionRef.current = null;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
      window.addEventListener("pointercancel", onPointerUp, { once: true });
      window.addEventListener("blur", onPointerUp, { once: true });
    },
    [selectedElementContext, selectedStyleEditorAnchor, stylePanelPositionOverride],
  );
  const visibleInspectHoverBox =
    editorMode === "inspect" &&
    browserEditorFocused &&
    browserEditorPointerInside &&
    !stylePropertiesPanelOpen &&
    inspectHoverOverlayBox &&
    (!selectedAnnotationViewportBox ||
      !inspectHoverBox ||
      !browserInspectBoxesMatch(inspectHoverBox, selectedAnnotationViewportBox))
      ? inspectHoverOverlayBox
      : null;
  const annotationArrowsForRender = useMemo(
    () =>
      annotationArrowDraft
        ? [
            ...annotationArrows.filter((arrow) => arrow.id !== annotationArrowDraft.id),
            annotationArrowDraft,
          ]
        : annotationArrows,
    [annotationArrowDraft, annotationArrows],
  );
  const visibleAnnotationArrows = useMemo(
    () => resolveBrowserAnnotationArrowSources(annotationArrowsForRender, textAnnotations),
    [annotationArrowsForRender, textAnnotations],
  );
  const visibleAnnotationArrowItems = useMemo<BrowserAnnotationArrowRenderItem[]>(
    () =>
      visibleAnnotationArrows.map((arrow, arrowIndex) => {
        const colors = gradientColorsForStroke(drawStrokes.length + arrowIndex);
        return {
          arrow,
          segments: browserAnnotationArrowSegments(arrow),
          gradientId: `browser-annotation-arrow-gradient-${browserSvgIdPrefix}-${svgFragmentId(arrow.id)}`,
          colors,
          stopColorValues: browserGradientStopColorValues(colors),
          animationBegin: `${arrowIndex * 0.13}s`,
        };
      }),
    [browserSvgIdPrefix, drawStrokes.length, visibleAnnotationArrows],
  );
  const previewStatusLabel =
    previewState?.status === "running"
      ? "Preview running"
      : previewState?.status === "starting"
        ? "Starting preview"
        : previewState?.status === "error"
          ? "Preview error"
          : previewState?.status === "stopped"
            ? "Preview stopped"
            : "Preview";
  const previewIsRunning = previewState?.status === "running";
  const previewIsStarting = previewState?.status === "starting";
  const previewCanStart =
    Boolean(previewCwd) && !previewActionPending && !previewIsRunning && !previewIsStarting;
  const previewCanStop = Boolean(previewCwd) && !previewActionPending && previewIsRunning;
  const previewCanRestart = Boolean(previewCwd) && !previewActionPending && Boolean(previewState);
  const editorToolbar = isLiveRuntime ? (
    <>
      <div className={BROWSER_TOOLBAR_SECTION_CLASS_NAME}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={(node) => {
                  editorToolbarButtonRefs.current.browse = node;
                }}
                type="button"
                className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                data-active={editorMode === "browse"}
                onClick={() => {
                  setEditorMode("browse");
                }}
              >
                <GlobeIcon className="size-3.5" />
                <span className="sr-only">Browse</span>
              </button>
            }
          />
          <TooltipPopup side="bottom">Browse (⌘B)</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={(node) => {
                  editorToolbarButtonRefs.current.inspect = node;
                }}
                type="button"
                className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                data-active={editorMode === "inspect"}
                onClick={() => {
                  setEditorMode("inspect");
                }}
              >
                <EyeIcon className="size-3.5" />
                <span className="sr-only">Inspect</span>
              </button>
            }
          />
          <TooltipPopup side="bottom">Inspect (⌘I)</TooltipPopup>
        </Tooltip>
        <div
          className="flex items-center"
          onPointerEnter={() => scheduleToolOptionsOpen("draw")}
          onPointerLeave={scheduleToolOptionsClose}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={(node) => {
                    editorToolbarButtonRefs.current.draw = node;
                  }}
                  type="button"
                  className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                  data-active={editorMode === "draw"}
                  onClick={() => {
                    setEditorMode("draw");
                  }}
                >
                  <PencilIcon className="size-3.5" />
                  <span className="sr-only">Draw</span>
                </button>
              }
            />
            <TooltipPopup side="bottom">Draw (⌘D)</TooltipPopup>
          </Tooltip>
        </div>
        <div
          className="flex items-center"
          onPointerEnter={() => scheduleToolOptionsOpen("text")}
          onPointerLeave={scheduleToolOptionsClose}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={(node) => {
                    editorToolbarButtonRefs.current.text = node;
                  }}
                  type="button"
                  className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                  data-active={editorMode === "text"}
                  onClick={() => {
                    setEditorMode("text");
                  }}
                >
                  <TextIcon className="size-3.5" />
                  <span className="sr-only">Text annotation</span>
                </button>
              }
            />
            <TooltipPopup side="bottom">Text annotation (⌘T)</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <div aria-hidden="true" className={BROWSER_TOOLBAR_DIVIDER_CLASS_NAME} />
      <div className={BROWSER_TOOLBAR_SECTION_CLASS_NAME}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                disabled={!canUndoAnnotation}
                onClick={undoLastDrawingStroke}
              >
                <Undo2Icon className="size-3.5" />
                <span className="sr-only">Undo annotation</span>
              </button>
            }
          />
          <TooltipPopup side="bottom">Undo annotation</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                disabled={!hasBrowserAnnotation}
                onClick={clearDrawingAnnotations}
              >
                <EraserIcon className="size-3.5" />
                <span className="sr-only">Clear annotation</span>
              </button>
            }
          />
          <TooltipPopup side="bottom">Clear annotation</TooltipPopup>
        </Tooltip>
      </div>
      <div aria-hidden="true" className={BROWSER_TOOLBAR_DIVIDER_CLASS_NAME} />
      <div className={BROWSER_TOOLBAR_SECTION_CLASS_NAME}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME, "gap-1.5")}
                aria-pressed={autoAttachAnnotationScreenshot}
                aria-label={autoAttachAnnotationScreenshot ? "AUTO camera" : "MANUAL camera"}
                onClick={() => {
                  setAutoAttachAnnotationScreenshot((current) => !current);
                }}
              >
                <span className="text-[10px] font-semibold uppercase">
                  {autoAttachAnnotationScreenshot ? "AUTO" : "MANUAL"}
                </span>
                <CameraIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="bottom">
            {autoAttachAnnotationScreenshot
              ? "Switch annotation capture to manual"
              : "Switch annotation capture to auto"}
          </TooltipPopup>
        </Tooltip>
        {!autoAttachAnnotationScreenshot ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                  disabled={!hasBrowserAnnotation}
                  onClick={addDrawingToPrompt}
                >
                  <PlusIcon className="size-3.5" />
                  <span className="sr-only">Attach live editor context</span>
                </button>
              }
            />
            <TooltipPopup side="bottom">Attach live editor context</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </>
  ) : null;
  const previewToolbar = previewCwd ? (
    <>
      <span
        className={cn(
          "max-w-28 truncate px-1.5 text-[11px] text-muted-foreground",
          previewState?.status === "error" ? "text-destructive" : "",
        )}
        title={previewState?.lastError ?? previewState?.url ?? previewCwd}
      >
        {previewStatusLabel}
      </span>
      <div className={BROWSER_TOOLBAR_SECTION_CLASS_NAME}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                disabled={!previewCanStart}
                onClick={() => {
                  void startPreview({ autoNavigate: true });
                }}
              >
                {previewActionPending || previewIsStarting ? (
                  <LoaderCircleIcon className="size-3 animate-spin" />
                ) : (
                  <PlayIcon className="size-3" />
                )}
                <span className="sr-only">Start preview</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">Start preview</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                disabled={!previewCanStop}
                onClick={() => {
                  void stopPreview();
                }}
              >
                <StopIcon className="size-3" />
                <span className="sr-only">Stop preview</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">Stop preview</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                disabled={!previewCanRestart}
                onClick={() => {
                  void restartPreview();
                }}
              >
                <RefreshCwIcon className="size-3" />
                <span className="sr-only">Restart preview</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">Restart preview</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                disabled={!previewState?.url}
                onClick={() => {
                  if (previewState?.url) {
                    void navigateBrowserToPreviewUrl(
                      previewState.url,
                      previewState.targetCwd ?? null,
                    );
                  }
                }}
              >
                <ExternalLinkIcon className="size-3" />
                <span className="sr-only">Open preview</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">Open preview</TooltipPopup>
        </Tooltip>
      </div>
    </>
  ) : null;
  const editorToolbarShortcutItems = LIVE_EDITOR_MODE_SHORTCUTS;
  const editorToolbarShortcutHints = showEditorShortcutHints
    ? editorToolbarShortcutItems.flatMap((item) => {
        const rect = editorToolbarAnchorRects[item.mode];
        if (!rect) {
          return [];
        }
        const position = browserToolbarFloatingPosition(rect, {
          width: 24,
          height: 14,
          gap: 4,
        });
        const toolbarBottom = editorToolbarStripRect
          ? editorToolbarStripRect.top + editorToolbarStripRect.height
          : null;
        return [
          <div
            key={item.mode}
            className="pointer-events-none fixed z-[80] flex justify-center"
            style={{
              left: position.left,
              top: toolbarBottom ? Math.max(position.top, toolbarBottom + 3) : position.top,
              transform: "translateX(-50%)",
            }}
          >
            <Kbd className={BROWSER_SHORTCUT_HINT_CLASS_NAME}>{item.label}</Kbd>
          </div>,
        ];
      })
    : null;
  const openToolOptionsAnchor = openToolOptions ? editorToolbarAnchorRects[openToolOptions] : null;
  const openToolOptionsPosition =
    openToolOptionsAnchor && openToolOptions
      ? browserToolbarFloatingPosition(openToolOptionsAnchor, {
          width: 192,
          height: openToolOptions === "draw" ? 116 : 70,
          gap: 9,
        })
      : null;
  const editorToolbarToolOptions =
    openToolOptions && openToolOptionsPosition ? (
      <div
        className={BROWSER_TOOL_OPTIONS_PANEL_CLASS_NAME}
        style={{
          left: openToolOptionsPosition.left,
          top: openToolOptionsPosition.top,
          transform: "translateX(-50%)",
        }}
        onPointerEnter={keepToolOptionsOpen}
        onPointerLeave={scheduleToolOptionsClose}
      >
        {openToolOptions === "draw" ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-muted-foreground">Stroke</span>
              <span className="text-[11px] font-semibold text-foreground">
                {drawStrokeSize.toFixed(1)}px
              </span>
            </div>
            <input
              type="range"
              min={BROWSER_DRAWING_MIN_STROKE_WIDTH}
              max={BROWSER_DRAWING_MAX_STROKE_WIDTH}
              step="0.5"
              value={drawStrokeSize}
              className={BROWSER_TOOL_OPTIONS_RANGE_CLASS_NAME}
              style={browserNeutralRangeStyle(
                drawStrokeSize,
                BROWSER_DRAWING_MIN_STROKE_WIDTH,
                BROWSER_DRAWING_MAX_STROKE_WIDTH,
              )}
              onChange={(event) => {
                setDrawStrokeSize(Number(event.currentTarget.value));
              }}
            />
            <button
              type="button"
              className="mt-2 flex w-full items-center justify-between rounded-lg border border-black/10 bg-white/42 px-2 py-1.5 text-[11px] font-medium text-slate-950 transition hover:bg-white/58 dark:border-white/10 dark:bg-white/[0.04] dark:text-foreground dark:hover:bg-white/[0.08]"
              aria-pressed={drawStrokeAnimated}
              onClick={() => setDrawStrokeAnimated((current) => !current)}
            >
              <span>Animated color</span>
              <span
                className={cn(
                  BROWSER_EDITOR_SWITCH_CLASS_NAME,
                  drawStrokeAnimated
                    ? "border-black/20 bg-gradient-to-r from-slate-50/95 to-slate-200/88 dark:border-white/22 dark:from-white/26 dark:to-white/14"
                    : "border-black/15 bg-slate-200/72 dark:border-white/16 dark:bg-white/10",
                )}
              >
                <span
                  className={cn(
                    BROWSER_EDITOR_SWITCH_THUMB_CLASS_NAME,
                    drawStrokeAnimated
                      ? "left-[13px] dark:border-white/80 dark:bg-slate-100"
                      : "left-[3px] bg-slate-400 dark:border-white/65 dark:bg-white/66",
                  )}
                />
              </span>
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-muted-foreground">Font size</span>
              <span className="text-[11px] font-semibold text-foreground">
                {textAnnotationFontSize}px
              </span>
            </div>
            <input
              type="range"
              min={BROWSER_TEXT_ANNOTATION_MIN_FONT_SIZE}
              max={BROWSER_TEXT_ANNOTATION_MAX_FONT_SIZE}
              step="1"
              value={textAnnotationFontSize}
              className={BROWSER_TOOL_OPTIONS_RANGE_CLASS_NAME}
              style={browserNeutralRangeStyle(
                textAnnotationFontSize,
                BROWSER_TEXT_ANNOTATION_MIN_FONT_SIZE,
                BROWSER_TEXT_ANNOTATION_MAX_FONT_SIZE,
              )}
              onChange={(event) => {
                setTextAnnotationFontSize(Number(event.currentTarget.value));
              }}
            />
          </>
        )}
      </div>
    ) : null;
  const editorToolbarFloatingLayer = isLiveRuntime ? (
    <>
      {editorToolbarShortcutHints}
      {editorToolbarToolOptions}
    </>
  ) : null;
  const activePreviewUrl =
    previewState?.url ?? activeTab?.lastCommittedUrl ?? activeTab?.url ?? BROWSER_BLANK_URL;
  const canOpenActivePreviewUrl = activePreviewUrl !== BROWSER_BLANK_URL && Boolean(previewCwd);
  const liveEditorHeader = (
    <div
      data-browser-editor-chrome="true"
      data-browser-editor-surface="true"
      className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]"
      onPointerDownCapture={() => setBrowserEditorFocusState(true)}
      onFocusCapture={() => setBrowserEditorFocusState(true)}
    >
      <div
        ref={liveEditorToolbarStripRef}
        className={cn(
          BROWSER_TOOLBAR_STRIP_CLASS_NAME,
          "group/live-editor-toolbar max-w-full overflow-x-auto",
        )}
      >
        {editorToolbar}
        {editorToolbar && previewToolbar ? (
          <div aria-hidden="true" className={BROWSER_TOOLBAR_DIVIDER_CLASS_NAME} />
        ) : null}
        {previewToolbar}
        <div aria-hidden="true" className={BROWSER_TOOLBAR_DIVIDER_CLASS_NAME} />
        <button
          type="button"
          className="max-w-[16rem] shrink-0 truncate rounded-sm px-1.5 text-left text-[11px] text-muted-foreground outline-none transition-[background-color,color,text-decoration-color] hover:bg-accent/45 hover:text-foreground hover:underline hover:decoration-foreground/50 focus-visible:bg-accent/55 focus-visible:text-foreground focus-visible:underline focus-visible:decoration-foreground/60 disabled:pointer-events-none disabled:opacity-60"
          title={activePreviewUrl}
          disabled={!canOpenActivePreviewUrl}
          onClick={() => {
            if (canOpenActivePreviewUrl) {
              void navigateBrowserToPreviewUrl(activePreviewUrl, previewState?.targetCwd ?? null);
            }
          }}
        >
          {liveEditorPreviewLabel(activePreviewUrl)}
        </button>
      </div>
      {editorToolbarFloatingLayer}
    </div>
  );
  const browserEditorOverlayEnabled =
    isLiveEditorVariant &&
    isLiveRuntime &&
    workspaceReady &&
    activeTab !== null &&
    editorMode !== "browse";
  const browserEditorOverlayInteractive = browserEditorOverlayEnabled && !stylePropertiesPanelOpen;
  const fallbackDemoUrl =
    typeof window === "undefined"
      ? BROWSER_BLANK_URL
      : new URL("/browser-editor-demo/index.html", window.location.origin).toString();
  const shouldShowFallbackDemoPrompt =
    import.meta.env.DEV &&
    !canUseNativeBrowserSurface &&
    activeTab !== null &&
    (activeTab.url === BROWSER_BLANK_URL || activeTab.lastCommittedUrl === BROWSER_BLANK_URL);
  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* Keep the browser chrome interactive inside Electron's draggable titlebar. */}
      <div className="relative flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
        <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            disabled={!activeTab?.canGoBack}
            onClick={() => {
              if (!ensureLiveRuntime()) return;
              if (!api || !activeTab) return;
              void runBrowserAction(() =>
                api.browser.goBack({ threadId, tabId: activeTab.id }),
              ).then((state) => {
                if (state) {
                  upsertThreadState(state);
                }
              });
            }}
          >
            <ArrowLeftIcon className="size-3.5" />
            <span className="sr-only">Go back</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            disabled={!activeTab?.canGoForward}
            onClick={() => {
              if (!ensureLiveRuntime()) return;
              if (!api || !activeTab) return;
              void runBrowserAction(() =>
                api.browser.goForward({ threadId, tabId: activeTab.id }),
              ).then((state) => {
                if (state) {
                  upsertThreadState(state);
                }
              });
            }}
          >
            <ArrowRightIcon className="size-3.5" />
            <span className="sr-only">Go forward</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0"
            disabled={!activeTab}
            onClick={() => {
              if (!ensureLiveRuntime()) return;
              if (!api || !activeTab) return;
              void runBrowserAction(() =>
                api.browser.reload({ threadId, tabId: activeTab.id }),
              ).then((state) => {
                if (state) {
                  upsertThreadState(state);
                }
              });
            }}
          >
            {loading ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            <span className="sr-only">Reload</span>
          </Button>
        </div>
        <form
          className="min-w-0 flex-1 [-webkit-app-region:no-drag]"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitAddress();
          }}
        >
          <Input
            ref={addressInputRef}
            value={addressValue}
            onChange={(event) => {
              if (!isLiveRuntime) {
                requestLiveRuntime();
              }
              const nextValue = event.target.value;
              isAddressEditingRef.current = true;
              setAddressValue(nextValue);
              if (activeTab) {
                addressDraftsByTabIdRef.current.set(activeTab.id, nextValue);
              }
            }}
            onFocus={() => {
              if (!isLiveRuntime) {
                requestLiveRuntime();
              }
              isAddressEditingRef.current = true;
              setIsAddressFocused(true);
            }}
            onBlur={() => {
              isAddressEditingRef.current = false;
              setIsAddressFocused(false);
            }}
            placeholder="Search or enter a URL"
            className={cn(
              "font-mono min-w-0 [-webkit-app-region:no-drag]",
              BROWSER_CHROME_CONTROL_CLASS_NAME,
              BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME,
            )}
          />
        </form>
        {showBrowserAddressSuggestions ? (
          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-lg border border-border bg-popover shadow-lg [-webkit-app-region:no-drag]">
            <div className="max-h-64 overflow-auto p-1">
              {browserAddressSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onChooseSuggestion(suggestion);
                  }}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-background/80">
                    {suggestion.kind === "navigate" ? (
                      <ExternalLinkIcon className="size-3 text-muted-foreground" />
                    ) : suggestion.faviconUrl ? (
                      <img alt="" src={suggestion.faviconUrl} className="size-3 rounded-[2px]" />
                    ) : (
                      <GlobeIcon className="size-3 text-muted-foreground" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{suggestion.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {suggestion.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={copyScreenshotButtonRef}
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7"
                disabled={!activeTab}
                aria-label="Copy screenshot"
                onClick={onCopyScreenshotToClipboard}
              >
                <CameraIcon className="size-3.5" />
                <span className="sr-only">Copy screenshot</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">Copy screenshot</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7"
                disabled={!activeTab}
                aria-label="Copy link"
                onClick={copyActiveTabLink}
              >
                <LinkIcon className="size-3.5" />
                <span className="sr-only">Copy link</span>
              </Button>
            }
          />
          <TooltipPopup side="bottom">Copy link</TooltipPopup>
        </Tooltip>
        <Menu modal={false}>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7"
                aria-label="Browser actions"
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <ComposerPickerMenuPopup
            align="end"
            side="bottom"
            className={BROWSER_ACTION_MENU_PANEL_CLASS_NAME}
          >
            <MenuItem className={BROWSER_ACTION_MENU_ITEM_CLASS_NAME} onClick={onCreateTab}>
              <BrowserActionMenuIcon icon={PlusIcon} />
              <span>New tab</span>
            </MenuItem>
            <MenuItem
              className={BROWSER_ACTION_MENU_ITEM_CLASS_NAME}
              disabled={!activeTab}
              onClick={onCaptureScreenshot}
            >
              <BrowserActionMenuIcon icon={CameraIcon} />
              <span>Capture screenshot</span>
            </MenuItem>
            <MenuItem
              className={BROWSER_ACTION_MENU_ITEM_CLASS_NAME}
              disabled={!activeTab}
              onClick={() => {
                if (!ensureLiveRuntime()) return;
                if (!api || !activeTab) return;
                void api.shell.openExternal(activeTab.url);
              }}
            >
              <BrowserActionMenuIcon icon={ExternalLinkIcon} />
              <span>Open externally</span>
            </MenuItem>
            <MenuSeparator />
            <MenuItem className={BROWSER_ACTION_MENU_ITEM_CLASS_NAME} onClick={onClosePanel}>
              <BrowserActionMenuIcon icon={XIcon} />
              <span>{isLiveEditorVariant ? "Close editor panel" : "Close browser panel"}</span>
            </MenuItem>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
    </div>
  );

  if (!api && isLiveRuntime) {
    return (
      <DiffPanelShell mode={mode} header={header}>
        <DiffPanelLoadingState label="Browser is unavailable." />
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell
      mode={mode}
      header={isLiveEditorVariant ? liveEditorHeader : header}
      {...(isLiveEditorVariant ? { headerRowClassName: "px-1.5" } : {})}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {!isLiveEditorVariant ? (
          <div
            ref={browserTabsBarRef}
            className={cn(
              "border-b border-border px-2 py-1.5",
              // Extend the frameless window drag region across the tab strip's empty space so
              // the panel is easy to grab; interactive children stay no-drag via global CSS.
              isElectron && mode !== "sheet" && "drag-region",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                {threadBrowserState?.tabs.map((tab) => {
                  const isActive = tab.id === activeTab?.id;
                  const tabIsBlank = isBlankBrowserTabUrl(tab);
                  return (
                    <div
                      key={tab.id}
                      className={cn(
                        "group flex min-w-0 max-w-[14rem] items-center px-2.5 text-left transition-colors",
                        BROWSER_CHROME_CONTROL_CLASS_NAME,
                        isActive
                          ? cn(BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME, "text-foreground")
                          : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-background/40 hover:text-foreground",
                        tab.status === "suspended" && !tabIsBlank ? "opacity-75" : "",
                      )}
                    >
                      <span className="mr-2 flex size-4 shrink-0 items-center justify-center rounded-sm">
                        {tab.faviconUrl ? (
                          <img alt="" src={tab.faviconUrl} className="size-3 rounded-[2px]" />
                        ) : (
                          <GlobeIcon className="size-3 text-muted-foreground" />
                        )}
                      </span>
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => {
                          if (!ensureLiveRuntime()) return;
                          if (!api) return;
                          void runBrowserAction(() =>
                            api.browser.selectTab({ threadId, tabId: tab.id }),
                          ).then((state) => {
                            if (state) {
                              upsertThreadState(state);
                            }
                          });
                        }}
                      >
                        {tab.title || "Untitled"}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={closeButtonClassName(isActive)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                      >
                        <XIcon className="size-3" />
                        <span className="sr-only">Close tab</span>
                      </Button>
                    </div>
                  );
                })}
              </div>
              {!hasNativeBrowserBridge ? (
                <div
                  className="max-w-[12rem] shrink-0 truncate rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] leading-none text-muted-foreground"
                  title="Web fallback: browse and draw work here; inspect works for same-origin pages. Use Synara desktop for full CDP automation."
                >
                  Web fallback
                </div>
              ) : null}
              {browserChromeStatus ? (
                <div
                  className={cn(
                    "max-w-[13rem] shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px] leading-none sm:max-w-[16rem]",
                    browserChromeStatus.tone === "error"
                      ? "border-destructive/25 bg-destructive/8 text-destructive"
                      : "border-border/60 bg-background/80 text-muted-foreground",
                  )}
                  title={browserChromeStatus.label}
                >
                  {browserChromeStatus.label}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-transparent">
          {!isLiveRuntime ? (
            <BrowserRuntimePreview
              title={activeTab?.title || "Browser is sleeping"}
              detail={activeTab?.lastCommittedUrl ?? activeTab?.url ?? "Restoring cached browser"}
            />
          ) : !workspaceReady ? (
            <div className="absolute inset-0 z-10">
              <DiffPanelLoadingState label="Starting browser..." />
            </div>
          ) : null}
          {isLiveRuntime ? (
            <div
              ref={browserViewportRef}
              data-browser-editor-surface="true"
              tabIndex={-1}
              className="absolute inset-0 bg-transparent outline-none"
              onFocusCapture={(event) => {
                if (
                  isBrowserEditorSurfaceEventTarget(event.target) ||
                  isBrowserEditorChromeEventTarget(event.target)
                ) {
                  setBrowserEditorFocusState(true);
                }
              }}
              onBlurCapture={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  setBrowserEditorFocusState(false);
                }
              }}
              onPointerDownCapture={() => {
                setBrowserEditorFocusState(true);
                browserViewportRef.current?.focus({ preventScroll: true });
              }}
              onPointerEnter={() => {
                setBrowserEditorPointerInsideState(true);
              }}
              onPointerLeave={() => {
                setBrowserEditorPointerInsideState(false);
              }}
            >
              {!canUseNativeBrowserSurface && activeTab ? (
                <iframe
                  ref={browserFallbackFrameRef}
                  key={activeTab.id}
                  title={activeTab.title || "Browser preview"}
                  src={activeTab.lastCommittedUrl ?? activeTab.url ?? BROWSER_BLANK_URL}
                  className="absolute inset-0 h-full w-full border-0 bg-white"
                  onLoad={syncFallbackFrameLoad}
                />
              ) : null}
              {shouldShowFallbackDemoPrompt ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/92 p-6 text-center backdrop-blur-sm">
                  <div className="max-w-sm rounded-lg border border-border/70 bg-card p-5 shadow-sm">
                    <GlobeIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">Browser fallback ready</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Open the mock landing page to test browse, inspect, and draw in the web
                      fallback.
                    </p>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="mt-4"
                      onClick={() => {
                        void navigateBrowserToPreviewUrl(fallbackDemoUrl);
                      }}
                    >
                      Open demo page
                    </Button>
                  </div>
                </div>
              ) : null}
              {!activeTab ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6 text-center">
                  <div className="max-w-sm">
                    <GlobeIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">No browser tab open</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Enter a URL or start a preview to open a page here.
                    </p>
                  </div>
                </div>
              ) : null}
              {isLiveEditorVariant &&
              selectedAnnotationBox &&
              !stylePropertiesPanelOpen &&
              !inlineTextEditor ? (
                <div className="pointer-events-none absolute inset-0 z-20">
                  <BrowserAnnotationBoxOverlay box={selectedAnnotationBox} variant="selected" />
                </div>
              ) : null}
              {browserEditorOverlayEnabled ? (
                <div
                  ref={browserEditorOverlayRef}
                  data-browser-editor-overlay="true"
                  className={cn(
                    "absolute inset-0 z-30 select-none",
                    browserEditorOverlayInteractive
                      ? editorMode === "text"
                        ? "cursor-text"
                        : "cursor-crosshair"
                      : "pointer-events-none cursor-default",
                  )}
                  onPointerMove={
                    browserEditorOverlayInteractive ? onBrowserEditorOverlayPointerMove : undefined
                  }
                  onPointerDown={browserEditorOverlayInteractive ? onDrawPointerDown : undefined}
                  onPointerUp={
                    browserEditorOverlayInteractive ? onBrowserEditorOverlayPointerUp : undefined
                  }
                  onPointerCancel={
                    browserEditorOverlayInteractive ? onBrowserEditorOverlayPointerUp : undefined
                  }
                  onClick={
                    browserEditorOverlayInteractive ? onBrowserEditorOverlayClick : undefined
                  }
                  onDoubleClick={
                    browserEditorOverlayInteractive ? onBrowserEditorOverlayDoubleClick : undefined
                  }
                >
                  {visibleInspectHoverBox ? (
                    <BrowserAnnotationBoxOverlay box={visibleInspectHoverBox} />
                  ) : null}
                  {renderedDrawStrokeItems.length > 0 ? (
                    <svg
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      aria-hidden="true"
                    >
                      <defs>
                        {renderedDrawStrokeItems.map((item) => (
                          <linearGradient
                            key={item.gradientId}
                            id={item.gradientId}
                            x1="0%"
                            y1="0%"
                            x2="100%"
                            y2="100%"
                          >
                            {item.animated ? (
                              <animateTransform
                                attributeName="gradientTransform"
                                type="rotate"
                                values="0 0.5 0.5;360 0.5 0.5"
                                dur="12s"
                                repeatCount="indefinite"
                              />
                            ) : null}
                            {BROWSER_GRADIENT_STOP_OFFSETS.map((offset, stopIndex) => (
                              <stop
                                key={offset}
                                offset={offset}
                                stopColor={item.colors[stopIndex]!}
                              >
                                {item.animated ? (
                                  <animate
                                    attributeName="stop-color"
                                    values={item.stopColorValues[stopIndex]}
                                    dur="8s"
                                    begin={item.animationBegin}
                                    repeatCount="indefinite"
                                  />
                                ) : null}
                              </stop>
                            ))}
                          </linearGradient>
                        ))}
                      </defs>
                      {renderedDrawStrokeItems.map((item) => {
                        const { stroke } = item;

                        return (
                          <g key={stroke.id}>
                            <polyline
                              ref={item.isActive ? activeDrawContrastPolylineRef : undefined}
                              className="mix-blend-difference"
                              fill="none"
                              points={item.points}
                              stroke={BROWSER_DRAWING_CONTRAST_STROKE_COLOR}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={item.contrastStrokeWidth}
                              opacity="0.94"
                            />
                            <polyline
                              ref={item.isActive ? activeDrawGradientPolylineRef : undefined}
                              fill="none"
                              points={item.points}
                              stroke={`url(#${item.gradientId})`}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={item.gradientStrokeWidth}
                            />
                            <polyline
                              ref={item.isActive ? activeDrawGlintPolylineRef : undefined}
                              className="mix-blend-difference"
                              fill="none"
                              points={item.points}
                              stroke={BROWSER_DRAWING_CONTRAST_STROKE_COLOR}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={item.glintStrokeWidth}
                              opacity="0.72"
                            />
                          </g>
                        );
                      })}
                    </svg>
                  ) : null}
                  {visibleAnnotationArrowItems.length > 0 ? (
                    <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
                      <defs>
                        {visibleAnnotationArrowItems.map((item) => (
                          <linearGradient
                            key={item.gradientId}
                            id={item.gradientId}
                            x1="0%"
                            y1="0%"
                            x2="100%"
                            y2="100%"
                          >
                            <animateTransform
                              attributeName="gradientTransform"
                              type="rotate"
                              values="0 0.5 0.5;360 0.5 0.5"
                              dur="12s"
                              repeatCount="indefinite"
                            />
                            {BROWSER_GRADIENT_STOP_OFFSETS.map((offset, stopIndex) => (
                              <stop
                                key={offset}
                                offset={offset}
                                stopColor={item.colors[stopIndex]!}
                              >
                                <animate
                                  attributeName="stop-color"
                                  values={item.stopColorValues[stopIndex]}
                                  dur="8s"
                                  begin={item.animationBegin}
                                  repeatCount="indefinite"
                                />
                              </stop>
                            ))}
                          </linearGradient>
                        ))}
                      </defs>
                      {visibleAnnotationArrowItems.map((item) => {
                        const { arrow, segments } = item;
                        const isArrowSelected = selectedAnnotationArrowId === arrow.id;
                        const showArrowEndpointHandles =
                          arrow.id === annotationArrowDraft?.id ||
                          hoveredAnnotationArrowId === arrow.id;
                        const showSourceHandle =
                          Boolean(arrow.sourceTextAnnotationId && arrow.sourceHandle) &&
                          (showArrowEndpointHandles ||
                            hoveredTextAnnotationId === arrow.sourceTextAnnotationId);
                        return (
                          <g key={arrow.id}>
                            <line
                              x1={arrow.from.x}
                              y1={arrow.from.y}
                              x2={arrow.to.x}
                              y2={arrow.to.y}
                              stroke="transparent"
                              strokeLinecap="round"
                              strokeWidth="14"
                              pointerEvents="stroke"
                              onPointerEnter={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onPointerMove={(event) => {
                                showAnnotationArrowControls(arrow.id);
                                moveAnnotationArrowTargetDrag(event);
                              }}
                              onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                selectAnnotationArrow(arrow);
                              }}
                              onPointerLeave={() => {
                                scheduleHideAnnotationArrowControls(arrow.id);
                              }}
                              onMouseEnter={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onMouseMove={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onMouseLeave={() => {
                                scheduleHideAnnotationArrowControls(arrow.id);
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                selectAnnotationArrow(arrow);
                              }}
                            />
                            {isArrowSelected
                              ? segments.map((segment, segmentIndex) => (
                                  <line
                                    key={`selected-${segmentIndex}`}
                                    className="pointer-events-none"
                                    x1={segment.x1}
                                    y1={segment.y1}
                                    x2={segment.x2}
                                    y2={segment.y2}
                                    stroke="rgba(125, 211, 252, 0.88)"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={BROWSER_DRAWING_CONTRAST_STROKE_WIDTH + 3}
                                    opacity="0.55"
                                  />
                                ))
                              : null}
                            {segments.map((segment, segmentIndex) => (
                              <line
                                key={`contrast-${segmentIndex}`}
                                className="pointer-events-none mix-blend-difference"
                                x1={segment.x1}
                                y1={segment.y1}
                                x2={segment.x2}
                                y2={segment.y2}
                                stroke="#ffffff"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={BROWSER_DRAWING_CONTRAST_STROKE_WIDTH}
                                opacity="0.94"
                              />
                            ))}
                            {segments.map((segment, segmentIndex) => (
                              <line
                                key={`gradient-${segmentIndex}`}
                                className="pointer-events-none"
                                x1={segment.x1}
                                y1={segment.y1}
                                x2={segment.x2}
                                y2={segment.y2}
                                stroke={`url(#${item.gradientId})`}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={BROWSER_DRAWING_GRADIENT_STROKE_WIDTH}
                              />
                            ))}
                            {segments.map((segment, segmentIndex) => (
                              <line
                                key={`glint-${segmentIndex}`}
                                className="pointer-events-none mix-blend-difference"
                                x1={segment.x1}
                                y1={segment.y1}
                                x2={segment.x2}
                                y2={segment.y2}
                                stroke="#ffffff"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={BROWSER_DRAWING_GLINT_STROKE_WIDTH}
                                opacity="0.72"
                              />
                            ))}
                            {arrow.sourceTextAnnotationId && arrow.sourceHandle ? (
                              <circle
                                className={cn(
                                  "cursor-grab fill-black/80 stroke-cyan-200 transition-opacity duration-150 ease-out active:cursor-grabbing",
                                  showSourceHandle
                                    ? "pointer-events-auto opacity-100"
                                    : "pointer-events-none opacity-0",
                                )}
                                cx={arrow.from.x}
                                cy={arrow.from.y}
                                r="4"
                                strokeWidth="1.5"
                                onPointerEnter={() => {
                                  showAnnotationArrowControls(arrow.id);
                                }}
                                onPointerMove={(event) => {
                                  showAnnotationArrowControls(arrow.id);
                                  moveAnnotationArrowSourceDrag(event);
                                }}
                                onPointerLeave={() => {
                                  scheduleHideAnnotationArrowControls(arrow.id);
                                }}
                                onMouseEnter={() => {
                                  showAnnotationArrowControls(arrow.id);
                                }}
                                onMouseMove={() => {
                                  showAnnotationArrowControls(arrow.id);
                                }}
                                onMouseLeave={() => {
                                  scheduleHideAnnotationArrowControls(arrow.id);
                                }}
                                onPointerDown={(event) =>
                                  beginAnnotationArrowSourceDrag(arrow, event)
                                }
                                onPointerUp={finishAnnotationArrowSourceDrag}
                                onPointerCancel={finishAnnotationArrowSourceDrag}
                                onClick={(event) => {
                                  event.stopPropagation();
                                }}
                              />
                            ) : null}
                            <circle
                              className={cn(
                                "cursor-crosshair fill-black/80 stroke-cyan-200 transition-opacity duration-150 ease-out",
                                showArrowEndpointHandles
                                  ? "pointer-events-auto opacity-100"
                                  : "pointer-events-none opacity-0",
                              )}
                              cx={arrow.to.x}
                              cy={arrow.to.y}
                              r="5"
                              strokeWidth="1.5"
                              onPointerEnter={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onPointerMove={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onPointerLeave={() => {
                                scheduleHideAnnotationArrowControls(arrow.id);
                              }}
                              onMouseEnter={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onMouseMove={() => {
                                showAnnotationArrowControls(arrow.id);
                              }}
                              onMouseLeave={() => {
                                scheduleHideAnnotationArrowControls(arrow.id);
                              }}
                              onPointerDown={(event) =>
                                beginAnnotationArrowTargetDrag(arrow, event)
                              }
                              onPointerUp={finishAnnotationArrowTargetDrag}
                              onPointerCancel={finishAnnotationArrowTargetDrag}
                              onClick={(event) => {
                                event.stopPropagation();
                              }}
                            />
                          </g>
                        );
                      })}
                    </svg>
                  ) : null}
                  {textAnnotations.map((annotation) => {
                    const isSelected = selectedTextAnnotationId === annotation.id;
                    const isEditing = editingTextAnnotationId === annotation.id;
                    const visibleText = isEditing ? editingTextAnnotationValue : annotation.text;
                    const annotationFontSize = browserTextAnnotationFontSize(annotation);
                    const annotationLineHeight =
                      browserTextAnnotationLineHeight(annotationFontSize);
                    const boxMetrics = textAnnotationBoxMetrics(visibleText, annotationFontSize);
                    const boxPosition = textAnnotationBoxPosition(annotation, boxMetrics);
                    const showSourceHandles =
                      !isEditing &&
                      (hoveredTextAnnotationId === annotation.id ||
                        draggingTextAnnotationId === annotation.id ||
                        annotationArrowDraft?.sourceTextAnnotationId === annotation.id);

                    return (
                      <div key={annotation.id} className="pointer-events-none absolute inset-0">
                        <div
                          className="group pointer-events-auto absolute"
                          style={{
                            left: boxPosition.x,
                            top: boxPosition.y,
                            width: boxMetrics.width,
                            height: boxMetrics.height,
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                        >
                          <div
                            className={cn(
                              "box-border h-full w-full whitespace-pre-wrap rounded-lg border border-black/10 bg-white/56 px-2.5 py-1.5 font-semibold text-slate-950 shadow-[0_12px_36px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.62)] backdrop-blur-2xl dark:border-white/18 dark:bg-slate-950/78 dark:text-white dark:shadow-[0_12px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.08)]",
                              isEditing
                                ? "cursor-text ring-2 ring-cyan-300/80"
                                : "cursor-grab active:cursor-grabbing",
                              isSelected && !isEditing ? "ring-2 ring-cyan-300/80" : "",
                            )}
                            style={{
                              fontSize: `${annotationFontSize}px`,
                              lineHeight: `${annotationLineHeight}px`,
                              overflowWrap: "anywhere",
                              overflowX: "hidden",
                              overflowY: "auto",
                              wordBreak: "break-word",
                            }}
                            onDoubleClick={(event) => beginTextAnnotationEdit(annotation, event)}
                            onPointerEnter={() => {
                              showTextAnnotationControls(annotation.id);
                            }}
                            onPointerLeave={() => {
                              scheduleHideTextAnnotationControls(annotation.id);
                            }}
                            onPointerDown={(event) => {
                              if (isEditing) {
                                event.stopPropagation();
                                return;
                              }
                              beginTextAnnotationDrag(annotation, event);
                            }}
                            onPointerMove={(event) => {
                              showTextAnnotationControls(annotation.id);
                              moveTextAnnotationDrag(event);
                            }}
                            onPointerUp={finishTextAnnotationDrag}
                            onPointerCancel={finishTextAnnotationDrag}
                          >
                            {isEditing ? (
                              <textarea
                                ref={editTextAnnotationInputRef}
                                data-browser-text-annotation-input="true"
                                value={editingTextAnnotationValue}
                                rows={1}
                                className="h-full w-full resize-none bg-transparent p-0 font-semibold text-slate-950 outline-none dark:text-white"
                                style={{
                                  fontSize: `${annotationFontSize}px`,
                                  lineHeight: `${annotationLineHeight}px`,
                                  overflowWrap: "anywhere",
                                  overflowX: "hidden",
                                  overflowY: "auto",
                                  wordBreak: "break-word",
                                }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                }}
                                onDoubleClick={(event) => {
                                  event.stopPropagation();
                                }}
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                }}
                                onChange={(event) => {
                                  setEditingTextAnnotationValue(event.currentTarget.value);
                                }}
                                onBlur={commitTextAnnotationEdit}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitTextAnnotationEdit();
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    cancelTextAnnotationEdit();
                                  }
                                }}
                              />
                            ) : (
                              annotation.text
                            )}
                          </div>
                          {isSelected
                            ? BROWSER_ANNOTATION_ARROW_HANDLES.map((handle) => {
                                const point = textAnnotationHandlePoint(annotation, handle);
                                return (
                                  <div
                                    key={handle}
                                    className={cn(
                                      "absolute z-10 flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full transition-[opacity,transform] duration-150 ease-out hover:scale-110",
                                      showSourceHandles
                                        ? "pointer-events-auto opacity-100"
                                        : "pointer-events-none opacity-0",
                                    )}
                                    style={{
                                      left: point.x - boxPosition.x,
                                      top: point.y - boxPosition.y,
                                    }}
                                    title={`Draw arrow from ${handle}`}
                                    onPointerEnter={() => {
                                      showTextAnnotationControls(annotation.id);
                                    }}
                                    onPointerMove={(event) => {
                                      showTextAnnotationControls(annotation.id);
                                      moveAnnotationArrowDraft(event);
                                    }}
                                    onPointerLeave={() => {
                                      scheduleHideTextAnnotationControls(annotation.id);
                                    }}
                                    onPointerDown={(event) =>
                                      beginAnnotationArrowDraft(annotation, handle, event)
                                    }
                                    onPointerUp={finishAnnotationArrowDraft}
                                    onPointerCancel={finishAnnotationArrowDraft}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                    }}
                                  >
                                    <span className="size-1.5 rounded-full border border-cyan-100/90 bg-black/90 shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_0_10px_rgba(34,211,238,0.55)]" />
                                  </div>
                                );
                              })
                            : null}
                        </div>
                      </div>
                    );
                  })}
                  {textAnnotationDraft
                    ? (() => {
                        const draftFontSize = browserTextAnnotationFontSize(textAnnotationDraft);
                        const draftLineHeight = browserTextAnnotationLineHeight(draftFontSize);
                        const draftMetrics = textAnnotationBoxMetrics(
                          textAnnotationDraft.text,
                          draftFontSize,
                        );
                        const draftPosition = clampTextAnnotationBoxPosition(
                          textAnnotationBoxPosition(textAnnotationDraft, draftMetrics),
                          browserEditorOverlayRef.current,
                          draftMetrics,
                        );
                        return (
                          <textarea
                            ref={textAnnotationInputRef}
                            data-browser-text-annotation-input="true"
                            value={textAnnotationDraft.text}
                            rows={1}
                            className="absolute z-10 box-border resize-none whitespace-pre-wrap rounded-lg border border-black/10 bg-white/58 px-2.5 py-1.5 font-semibold text-slate-950 shadow-[0_12px_36px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.62)] outline-none backdrop-blur-2xl placeholder:text-slate-500 focus:ring-2 focus:ring-cyan-300/70 dark:border-white/18 dark:bg-slate-950/82 dark:text-white dark:placeholder:text-muted-foreground dark:shadow-[0_12px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.08)]"
                            placeholder={BROWSER_TEXT_ANNOTATION_PLACEHOLDER}
                            style={{
                              left: draftPosition.x,
                              top: draftPosition.y,
                              width: draftMetrics.width,
                              height: draftMetrics.height,
                              fontSize: `${draftFontSize}px`,
                              lineHeight: `${draftLineHeight}px`,
                              overflowWrap: "anywhere",
                              overflowX: "hidden",
                              overflowY: "auto",
                              wordBreak: "break-word",
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                            onChange={(event) => {
                              const text = event.currentTarget.value;
                              setTextAnnotationDraft((current) =>
                                current ? { ...current, text } : current,
                              );
                            }}
                            onBlur={() => {
                              commitTextAnnotationDraft();
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitTextAnnotationDraft();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                setTextAnnotationDraft(null);
                              }
                            }}
                          />
                        );
                      })()
                    : null}
                </div>
              ) : null}
              {stylePanelDragging ? (
                <div
                  className="absolute inset-0 z-[45] cursor-move bg-transparent"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                />
              ) : null}
              {selectedStyleEditorAnchor && selectedElementContext ? (
                <>
                  <div
                    data-browser-editor-chrome="true"
                    className="absolute z-40 flex items-center gap-0.5"
                    style={selectedStyleEditorAnchor.button}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className={BROWSER_ELEMENT_EDIT_BUTTON_CLASS_NAME}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void startInlineTextEditing();
                            }}
                          >
                            <PencilIcon className="size-3.5" />
                            <span className="sr-only">Edit text inline</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="bottom">Edit text inline</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className={BROWSER_ELEMENT_EDIT_BUTTON_CLASS_NAME}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (inlineTextEditorRef.current) {
                                commitInlineTextEditing();
                              }
                              setStylePropertiesPanelOpen((current) => !current);
                            }}
                          >
                            <AdjustmentsIcon className="size-3.5" />
                            <span className="sr-only">Edit element properties</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="bottom">Edit element properties</TooltipPopup>
                    </Tooltip>
                  </div>
                  {stylePropertiesPanelOpen && stylePropertiesPanelPosition ? (
                    <div
                      data-browser-editor-chrome="true"
                      ref={stylePanelElementRef}
                      className="absolute left-0 top-0 z-50 will-change-transform"
                      style={{
                        transform: `translate3d(${stylePropertiesPanelPosition.left}px, ${stylePropertiesPanelPosition.top}px, 0)`,
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <ElementPropertiesPanel
                        element={selectedElementContext}
                        initialPatch={styleEditorInitialPatch ?? undefined}
                        onPreviewPatch={scheduleSelectedStylePreview}
                        onAttachContext={attachStyleEditContext}
                        onApplySourceEdit={applyStyleEditToSource}
                        onResetPreview={resetStylePropertiesPreview}
                        onClose={closeStylePropertiesPanel}
                        onDragHandlePointerDown={beginStylePropertiesPanelDrag}
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          {showLocalServersHome ? (
            <BrowserLocalServersHome
              activeTabId={activeTab?.id ?? null}
              loading={localServersQuery.isLoading || localServersQuery.isFetching}
              onNavigate={onOpenLocalServer}
              onRefresh={() => void localServersQuery.refetch()}
              servers={localServersQuery.data?.servers ?? []}
            />
          ) : null}
        </div>
      </div>
    </DiffPanelShell>
  );
}

export default BrowserPanel;
