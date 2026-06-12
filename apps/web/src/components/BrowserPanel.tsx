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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useStore as useZustandStore } from "zustand";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type BrowserCaptureScreenshotResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CameraIcon,
  CopyIcon,
  EllipsisIcon,
  EraserIcon,
  ExternalLinkIcon,
  EyeIcon,
  GlobeIcon,
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

import { readNativeApi } from "~/nativeApi";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { PANEL_RESIZE_OVERLAY_SYNC_EVENT } from "~/lib/panelResize";
import { cn, randomUUID } from "~/lib/utils";

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
  buildBrowserDrawingPromptBlock,
  buildBrowserSelectionPromptBlock,
  cdpElementContextExpression,
  isBrowserElementEditorContext,
  readBrowserElementContextFromDocumentAtPoint,
  removeBrowserAnnotationContextPrompt,
  type BrowserAnnotationArrow,
  type BrowserAnnotationArrowHandle,
  type BrowserDrawingPoint,
  type BrowserDrawingStroke,
  type BrowserElementEditorContext,
  type BrowserTextAnnotation,
} from "../lib/browserEditorContext";
import {
  browserAddressDisplayValue,
  buildBrowserAddressSuggestions,
  normalizeBrowserAddressInput,
  resolveBrowserChromeStatus,
  resolveBrowserAddressSync,
  type BrowserAddressSuggestion,
} from "./BrowserPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Skeleton } from "./ui/skeleton";
import { toastManager } from "./ui/toast";

interface BrowserPanelProps {
  mode: DiffPanelMode;
  threadId: ThreadId;
  onClosePanel: () => void;
  runtimeMode?: DockPaneRuntimeMode;
  onRequestLive?: () => void;
}

const BROWSER_BOUNDS_SYNC_BURST_FRAMES = 30;
const BROWSER_BOUNDS_SYNC_STABLE_FRAME_TARGET = 2;
const BROWSER_WEBVIEW_PARTITION = "persist:synara-browser";
const BROWSER_BLANK_URL = "about:blank";
const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
const SYNARA_BROWSER_LABEL = "Synara browser";
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
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
}

type BrowserEditorMode = "browse" | "inspect" | "draw" | "text";

interface BrowserInspectHoverBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
}

const BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-background/80 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[active=true]:bg-background data-[active=true]:text-foreground";
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
const BROWSER_DRAWING_MIN_POINT_DISTANCE = 1.5;
const BROWSER_TEXT_ANNOTATION_BOX_MIN_WIDTH = 84;
const BROWSER_TEXT_ANNOTATION_BOX_MAX_WIDTH = 360;
const BROWSER_TEXT_ANNOTATION_BOX_MIN_HEIGHT = 30;
const BROWSER_TEXT_ANNOTATION_BOX_MAX_HEIGHT = 180;
const BROWSER_TEXT_ANNOTATION_FONT_WEIGHT = 600;
const BROWSER_TEXT_ANNOTATION_FONT_SIZE = 12;
const BROWSER_TEXT_ANNOTATION_LINE_HEIGHT = 16;
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

function formatPreviewActionError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Couldn't complete that preview action.";
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

function estimateTextAnnotationTextWidth(text: string): number {
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
  return width;
}

function textAnnotationMeasureFont(): string {
  return `${BROWSER_TEXT_ANNOTATION_FONT_WEIGHT} ${BROWSER_TEXT_ANNOTATION_FONT_SIZE}px ui-sans-serif, system-ui, sans-serif`;
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

function measureTextAnnotationTextWidth(text: string): number {
  const context = getTextAnnotationMeasureContext();
  if (!context) {
    return estimateTextAnnotationTextWidth(text);
  }
  context.font = textAnnotationMeasureFont();
  return context.measureText(text).width;
}

function normalizeTextAnnotationText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function maxVisibleTextAnnotationLines(): number {
  return Math.max(
    1,
    Math.floor(
      (BROWSER_TEXT_ANNOTATION_BOX_MAX_HEIGHT - BROWSER_TEXT_ANNOTATION_PADDING_Y * 2) /
        BROWSER_TEXT_ANNOTATION_LINE_HEIGHT,
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
    const candidateWidth =
      current.length > 0 ? currentWidth + spaceWidth + wordWidth : wordWidth;

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

function textAnnotationBoxMetrics(text: string): BrowserTextAnnotationBoxMetrics {
  const displayText = text.trim().length > 0 ? text : BROWSER_TEXT_ANNOTATION_PLACEHOLDER;
  const maxContentWidth =
    BROWSER_TEXT_ANNOTATION_BOX_MAX_WIDTH - BROWSER_TEXT_ANNOTATION_PADDING_X * 2;
  const lineWrap = textAnnotationLines(displayText, maxContentWidth, {
    maxLines: maxVisibleTextAnnotationLines(),
  });
  const lines = lineWrap.hasOverflow
    ? [
        ...lineWrap.lines.slice(0, Math.max(0, lineWrap.lines.length - 1)),
        "… more text",
      ]
    : lineWrap.lines;
  const contentWidth = lineWrap.hasOverflow
    ? maxContentWidth
    : lines.reduce(
        (maxWidth, line) => Math.max(maxWidth, measureTextAnnotationTextWidth(line)),
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
    lines.length * BROWSER_TEXT_ANNOTATION_LINE_HEIGHT +
      BROWSER_TEXT_ANNOTATION_PADDING_Y * 2,
  );
  const height = Math.ceil(
    Math.max(
      BROWSER_TEXT_ANNOTATION_BOX_MIN_HEIGHT,
      Math.min(BROWSER_TEXT_ANNOTATION_BOX_MAX_HEIGHT, rawHeight),
    ),
  );
  return { width, height, lines, hasOverflow: lineWrap.hasOverflow };
}

function browserTextAnnotationMetrics(
  annotation: BrowserTextAnnotation,
): BrowserTextAnnotationBoxMetrics {
  return textAnnotationBoxMetrics(annotation.text);
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
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return true;
  }
  return (
    target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") ===
    null
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

function closedGradientColors(colors: readonly string[]): string {
  const firstColor = colors[0];
  return firstColor ? [...colors, firstColor].join(";") : "";
}

function shiftedClosedGradientColors(colors: readonly string[], shift: number): string {
  return closedGradientColors(colors.map((_, index) => colors[(index + shift) % colors.length]!));
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

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function imageFromBytes(bytes: Uint8Array, mimeType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
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
  };
}

interface CdpCaptureScreenshotResult {
  data?: unknown;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function pageMetricsFromCdp(value: unknown): {
  documentWidth: number | null;
  documentHeight: number | null;
  scrollX: number;
  scrollY: number;
} {
  const metrics = value as CdpLayoutMetricsResult | null;
  return {
    documentWidth:
      readPositiveNumber(metrics?.cssContentSize?.width) ??
      readPositiveNumber(metrics?.contentSize?.width),
    documentHeight:
      readPositiveNumber(metrics?.cssContentSize?.height) ??
      readPositiveNumber(metrics?.contentSize?.height),
    scrollX: readPositiveNumber(metrics?.visualViewport?.pageX) ?? 0,
    scrollY: readPositiveNumber(metrics?.visualViewport?.pageY) ?? 0,
  };
}

function fallbackDocumentPageMetrics(input: {
  document: Document;
  window: Window;
}): {
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
} {
  const element = input.document.documentElement;
  const body = input.document.body;
  return {
    documentWidth: Math.ceil(
      Math.max(element.scrollWidth, element.clientWidth, body?.scrollWidth ?? 0),
    ),
    documentHeight: Math.ceil(
      Math.max(element.scrollHeight, element.clientHeight, body?.scrollHeight ?? 0),
    ),
    scrollX: input.window.scrollX,
    scrollY: input.window.scrollY,
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
  return (
    !normalized.endsWith(",0)") &&
    !normalized.endsWith("/0)") &&
    !normalized.endsWith("/0")
  );
}

function parseCssPixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fallbackCanvasRect(input: {
  rect: DOMRect;
  window: Window;
}): { x: number; y: number; width: number; height: number } {
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
  if ("roundRect" in context) {
    context.roundRect(x, y, width, height, nextRadius);
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
      const imageUrl = new URL(input.element.currentSrc || input.element.src, ownerWindow.location.href);
      const canDrawImage =
        imageUrl.origin === ownerWindow.location.origin ||
        imageUrl.protocol === "data:" ||
        imageUrl.protocol === "blob:";
      if (canDrawImage) {
        input.context.drawImage(input.element, canvasRect.x, canvasRect.y, canvasRect.width, canvasRect.height);
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
    const baselineY = canvasRect.y + Math.min(canvasRect.height - 1, (canvasRect.height + fontSize) / 2);
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
      viewportWidth: captureDocument.window.innerWidth || frame.clientWidth || metrics.documentWidth,
      viewportHeight:
        captureDocument.window.innerHeight || frame.clientHeight || metrics.documentHeight,
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
  context.moveTo((firstPoint.x + input.offsetX) * input.scaleX, (firstPoint.y + input.offsetY) * input.scaleY);
  for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
    const point = stroke.points[pointIndex]!;
    context.lineTo((point.x + input.offsetX) * input.scaleX, (point.y + input.offsetY) * input.scaleY);
  }
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
  const anchorX = (annotation.x + input.offsetX) * input.scaleX;
  const anchorY = (annotation.y + input.offsetY) * input.scaleY;
  const metrics = browserTextAnnotationMetrics(annotation);
  const fontSize = Math.max(10, BROWSER_TEXT_ANNOTATION_FONT_SIZE * input.scaleY);
  const paddingX = BROWSER_TEXT_ANNOTATION_PADDING_X * input.scaleX;
  const lineHeight = BROWSER_TEXT_ANNOTATION_LINE_HEIGHT * input.scaleY;
  const radius = Math.max(6, 7 * input.fitScale);
  const boxPosition = textAnnotationBoxPosition(annotation, metrics);
  const boxWidth = metrics.width * input.scaleX;
  const boxHeight = metrics.height * input.scaleY;
  const boxX = (boxPosition.x + input.offsetX) * input.scaleX;
  const boxY = (boxPosition.y + input.offsetY) * input.scaleY;

  context.save();
  context.font = `${BROWSER_TEXT_ANNOTATION_FONT_WEIGHT} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;

  context.globalCompositeOperation = "source-over";
  context.fillStyle = "rgba(15, 23, 42, 0.92)";
  roundedCanvasPath(context, boxX, boxY, boxWidth, boxHeight, radius);
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, 0.86)";
  context.lineWidth = Math.max(1, 1.5 * input.fitScale);
  context.stroke();

  context.fillStyle = "#ffffff";
  context.textBaseline = "top";
  const textBlockHeight = metrics.lines.length * lineHeight;
  const textY = boxY + Math.max(0, (boxHeight - textBlockHeight) / 2);
  for (const [lineIndex, line] of metrics.lines.entries()) {
    context.fillStyle =
      metrics.hasOverflow && lineIndex === metrics.lines.length - 1
        ? "rgba(255, 255, 255, 0.68)"
        : "#ffffff";
    context.fillText(
      line,
      boxX + paddingX,
      textY + lineIndex * lineHeight,
      Math.max(24, boxWidth - paddingX * 2),
    );
  }

  context.globalCompositeOperation = "difference";
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(anchorX, anchorY, Math.max(4, 4.5 * input.fitScale), 0, Math.PI * 2);
  context.fill();
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
  const pageImage = await imageFromBytes(input.page.screenshot.bytes, input.page.screenshot.mimeType);
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
    context.lineWidth = Math.max(2, BROWSER_DRAWING_CONTRAST_STROKE_WIDTH * fitScale);
    context.stroke();
    context.restore();

    context.save();
    drawCanvasPolyline(context, stroke, { offsetX, offsetY, scaleX, scaleY });
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = gradient;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1.5, BROWSER_DRAWING_GRADIENT_STROKE_WIDTH * fitScale);
    context.stroke();
    context.restore();

    context.save();
    drawCanvasPolyline(context, stroke, { offsetX, offsetY, scaleX, scaleY });
    context.globalCompositeOperation = "difference";
    context.strokeStyle = BROWSER_DRAWING_CONTRAST_STROKE_COLOR;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1, BROWSER_DRAWING_GLINT_STROKE_WIDTH * fitScale);
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

export function BrowserPanel({
  mode,
  threadId,
  onClosePanel,
  runtimeMode = "live",
  onRequestLive,
}: BrowserPanelProps) {
  const api = readNativeApi();
  const isLiveRuntime = runtimeMode === "live";
  const threadBrowserState = useZustandStore(
    useBrowserStateStore,
    selectThreadBrowserState(threadId),
  );
  const recentHistory = useZustandStore(
    useBrowserStateStore,
    selectThreadBrowserHistory(threadId),
  );
  const upsertThreadState = useBrowserStateStore((store) => store.upsertThreadState);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const composerDraftImageCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.images.length ?? 0,
  );
  const browserAnnotationAttachment = useComposerDraftStore(
    (store) =>
      store.draftsByThreadId[threadId]?.images.find(
        (image) => image.source === BROWSER_ANNOTATION_ATTACHMENT_SOURCE,
      ) ?? null,
  );
  const composerDraftAssistantSelectionCount = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.assistantSelections.length ?? 0,
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
  const lastSentBoundsRef = useRef<string | null>(null);
  const lastMeasuredBoundsKeyRef = useRef<string | null>(null);
  const lastOverlayObscuredRef = useRef(false);
  const isAddressEditingRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const boundsBurstFrameRef = useRef<number | null>(null);
  const inspectFrameRef = useRef<number | null>(null);
  const inspectPointRef = useRef<{ x: number; y: number } | null>(null);
  const activeDrawStrokeRef = useRef<BrowserDrawingStroke | null>(null);
  const activeDrawPointerIdRef = useRef<number | null>(null);
  const activeDrawFrameRef = useRef<number | null>(null);
  const activeDrawOverlayRectRef = useRef<DOMRect | null>(null);
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
  const annotationArrowDraftRef = useRef<BrowserAnnotationArrow | null>(null);
  const textAnnotationEditCancelledRef = useRef(false);
  const textAnnotationHoverHideTimeoutRef = useRef<number | null>(null);
  const annotationArrowHoverHideTimeoutRef = useRef<number | null>(null);
  const annotationUpdateTimeoutRef = useRef<number | null>(null);
  const annotationUpdateRequestIdRef = useRef(0);
  const annotationUpdateRunningRef = useRef(false);
  const annotationUpdateQueuedRef = useRef(false);
  const annotationUpdateDisposedRef = useRef(false);
  const annotationStateInitializedRef = useRef(false);
  const previewAutoStartedCwdRef = useRef<string | null>(null);
  const previewPendingNavigationUrlRef = useRef<string | null>(null);
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
  const [annotationArrowDraft, setAnnotationArrowDraft] =
    useState<BrowserAnnotationArrow | null>(null);
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
  const [autoAttachAnnotationScreenshot, setAutoAttachAnnotationScreenshot] = useState(true);
  const [, setAnnotationAttachmentStatus] = useState<
    "idle" | "capturing" | "attached" | "error"
  >("idle");
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
  const activeTabStatus = activeTab?.status ?? "suspended";
  const browserChromeStatus = resolveBrowserChromeStatus({
    localError,
    threadLastError: threadBrowserState?.lastError,
    activeTabStatus,
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
    async (url: string) => {
      if (!api) {
        return;
      }
      if (activeTab) {
        const state = await api.browser.navigate({
          threadId,
          tabId: activeTab.id,
          url,
        });
        upsertThreadState(state);
        return;
      }
      const state = await api.browser.open({ threadId, initialUrl: url });
      upsertThreadState(state);
    },
    [activeTab, api, threadId, upsertThreadState],
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
          await navigateBrowserToPreviewUrl(state.url);
        }
        return state;
      } catch (error) {
        const message = formatPreviewActionError(error);
        const shouldSuppressUnavailableError =
          options.silentIfUnavailable === true &&
          message.includes("No package.json preview script found");
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
      const state = await api.preview.stop({
        threadId,
        cwd: previewCwd,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      });
      upsertPreviewState(state);
      setLocalError(null);
    } catch (error) {
      setLocalError(formatPreviewActionError(error));
    } finally {
      setPreviewActionPending(false);
    }
  }, [activeProjectId, api, previewCwd, threadId, upsertPreviewState]);

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
        await navigateBrowserToPreviewUrl(state.url);
      }
    } catch (error) {
      setLocalError(formatPreviewActionError(error));
    } finally {
      setPreviewActionPending(false);
    }
  }, [activeProjectId, api, navigateBrowserToPreviewUrl, previewCwd, threadId, upsertPreviewState]);

  const clearBrowserAnnotationContext = useCallback(() => {
    annotationUpdateRequestIdRef.current += 1;
    annotationUpdateQueuedRef.current = false;
    if (annotationUpdateTimeoutRef.current !== null) {
      window.clearTimeout(annotationUpdateTimeoutRef.current);
      annotationUpdateTimeoutRef.current = null;
    }
    const draftStore = useComposerDraftStore.getState();
    const currentDraft = draftStore.draftsByThreadId[threadId];
    for (const image of currentDraft?.images ?? []) {
      if (image.source === BROWSER_ANNOTATION_ATTACHMENT_SOURCE) {
        draftStore.removeImage(threadId, image.id);
      }
    }
    draftStore.clearBrowserContexts(threadId);
    draftStore.setPrompt(
      threadId,
      removeBrowserAnnotationContextPrompt(currentDraft?.prompt ?? ""),
    );
    setAnnotationAttachmentStatus("idle");
  }, [threadId]);

  const captureBrowserPageScreenshot = useCallback(async (
    annotationBounds: BrowserCaptureRect | null,
  ): Promise<BrowserPageScreenshot> => {
    if (!api || !activeTab) {
      throw new Error("No browser tab is available to capture.");
    }

    if (hasNativeBrowserBridge) {
      const viewportRect = browserViewportRef.current?.getBoundingClientRect();
      const viewportWidth = Math.ceil(viewportRect?.width ?? window.innerWidth);
      const viewportHeight = Math.ceil(viewportRect?.height ?? window.innerHeight);
      let metrics = {
        documentWidth: viewportWidth,
        documentHeight: viewportHeight,
        scrollX: 0,
        scrollY: 0,
      };
      try {
        const metricsResponse = await api.browser.executeCdp({
          threadId,
          tabId: activeTab.id,
          method: "Page.getLayoutMetrics",
        });
        const cdpMetrics = pageMetricsFromCdp(metricsResponse);
        metrics = {
          documentWidth: cdpMetrics.documentWidth ?? viewportWidth,
          documentHeight: cdpMetrics.documentHeight ?? viewportHeight,
          scrollX: cdpMetrics.scrollX,
          scrollY: cdpMetrics.scrollY,
        };
        const captureRect = browserAnnotationCaptureRect({
          annotationBounds,
          ...metrics,
          viewportWidth,
          viewportHeight,
        });
        const captureResponse = (await api.browser.executeCdp({
          threadId,
          tabId: activeTab.id,
          method: "Page.captureScreenshot",
          params: {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: true,
            clip: {
              x: captureRect.x,
              y: captureRect.y,
              width: captureRect.width,
              height: captureRect.height,
              scale: 1,
            },
          },
        })) as CdpCaptureScreenshotResult;
        if (typeof captureResponse.data !== "string" || captureResponse.data.length === 0) {
          throw new Error("CDP did not return screenshot data.");
        }
        return {
          screenshot: screenshotResultFromBytes({
            bytes: bytesFromBase64(captureResponse.data),
            name: BROWSER_ANNOTATION_SCREENSHOT_NAME,
          }),
          documentWidth: metrics.documentWidth,
          documentHeight: metrics.documentHeight,
          scrollX: metrics.scrollX,
          scrollY: metrics.scrollY,
          captureX: captureRect.x,
          captureY: captureRect.y,
          captureWidth: captureRect.width,
          captureHeight: captureRect.height,
        };
      } catch {
        const viewportScreenshot = await api.browser.captureScreenshot({
          threadId,
          tabId: activeTab.id,
        });
        const captureRect = roundBrowserCaptureRect(
          {
            x: metrics.scrollX,
            y: metrics.scrollY,
            width: viewportWidth,
            height: viewportHeight,
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
          captureX: captureRect.x,
          captureY: captureRect.y,
          captureWidth: captureRect.width,
          captureHeight: captureRect.height,
        };
      }
    }

    const frame = browserFallbackFrameRef.current;
    if (!frame) {
      throw new Error("No browser fallback frame is available to capture.");
    }
    return captureFallbackFramePageScreenshot(frame, annotationBounds);
  }, [activeTab, api, hasNativeBrowserBridge, threadId]);

  const runBrowserAnnotationAttachmentUpdate = useCallback(async (requestId: number) => {
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
      clearBrowserAnnotationContext();
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
      setAnnotationAttachmentStatus("attached");
      setLocalError(null);
      return;
    }
    if (!api || !activeTab) {
      setAnnotationAttachmentStatus("error");
      setLocalError("Live editor context will attach after the browser tab is ready.");
      return;
    }
    const effectiveAttachmentCount =
      (currentDraft?.images.length ?? 0) -
      existingAnnotationImages.length +
      composerDraftAssistantSelectionCount;
    if (
      existingAnnotationImages.length === 0 &&
      effectiveAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      setLocalError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
      );
      setAnnotationAttachmentStatus("error");
      return;
    }

    setAnnotationAttachmentStatus("capturing");
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
      const annotationBounds = browserAnnotationViewportBounds({
        selectedBox,
        strokes: usableStrokes,
        textAnnotations: usableTextAnnotations,
        arrows: usableArrows,
      });
      const page = await captureBrowserPageScreenshot(annotationBounds);
      if (
        annotationUpdateDisposedRef.current ||
        annotationUpdateRequestIdRef.current !== requestId
      ) {
        return;
      }
      const annotatedScreenshot = await composeAnnotatedBrowserScreenshot({
        page,
        strokes: usableStrokes,
        textAnnotations: usableTextAnnotations,
        arrows: usableArrows,
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
        setAnnotationAttachmentStatus("error");
        return;
      }
      const viewportRect = browserViewportRef.current?.getBoundingClientRect();
      const annotationUrl = activeTab.lastCommittedUrl ?? activeTab.url ?? BROWSER_BLANK_URL;
      const annotationTitle = activeTab.title ?? "";
      const metadataBlock = buildBrowserDrawingPromptBlock({
        source: BROWSER_ANNOTATION_ATTACHMENT_SOURCE,
        url: annotationUrl,
        title: annotationTitle,
        viewport: {
          width: viewportRect?.width ?? 0,
          height: viewportRect?.height ?? 0,
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
        strokes: usableStrokes,
        textAnnotations: usableTextAnnotations,
        arrows: usableArrows,
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
      latestStore.clearBrowserContexts(threadId);
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
      setAnnotationAttachmentStatus("attached");
      setLocalError(null);
    } catch (error) {
      if (
        annotationUpdateDisposedRef.current ||
        annotationUpdateRequestIdRef.current !== requestId
      ) {
        return;
      }
      setAnnotationAttachmentStatus("error");
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : (formatBrowserActionError(error) ?? "Couldn't attach the live editor context.");
      setLocalError(message);
    }
  }, [
    activeTab,
    api,
    captureBrowserPageScreenshot,
    clearBrowserAnnotationContext,
    composerDraftAssistantSelectionCount,
    threadId,
  ]);

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
          if (!frameDocument) {
            return null;
          }
          return readBrowserElementContextFromDocumentAtPoint({
            document: frameDocument,
            point,
          });
        } catch {
          setLocalError(
            "Inspect needs the desktop app for cross-origin pages. Same-origin mock pages still work here.",
          );
          return null;
        }
      }
      const response = (await api.browser.executeCdp({
        threadId,
        tabId: activeTab.id,
        method: "Runtime.evaluate",
        params: {
          expression: cdpElementContextExpression(point.x, point.y),
          returnByValue: true,
          awaitPromise: false,
        },
      })) as RuntimeEvaluateResult;
      const value = response.result?.value;
      return isBrowserElementEditorContext(value) ? value : null;
    },
    [activeTab, api, hasNativeBrowserBridge, threadId],
  );

  const scheduleInspectHover = useCallback(
    (point: BrowserDrawingPoint) => {
      inspectPointRef.current = point;
      if (inspectFrameRef.current !== null) {
        return;
      }
      inspectFrameRef.current = window.requestAnimationFrame(() => {
        inspectFrameRef.current = null;
        const nextPoint = inspectPointRef.current;
        if (!nextPoint || editorMode !== "inspect") {
          return;
        }
        void readElementContextAtPoint(nextPoint)
          .then((context) => {
            if (!context) {
              setInspectHoverBox(null);
              return;
            }
            setInspectHoverBox({
              x: context.rect.x,
              y: context.rect.y,
              width: context.rect.width,
              height: context.rect.height,
              label: context.selector || context.tagName.toLowerCase(),
            });
          })
          .catch(() => {
            setInspectHoverBox(null);
          });
      });
    },
    [editorMode, readElementContextAtPoint],
  );

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
    });
  }, [api, isLiveRuntime, upsertPreviewState]);

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
    if (status !== "idle" && status !== "stopped") {
      return;
    }

    previewAutoStartedCwdRef.current = previewCwd;
    void startPreview({ autoNavigate: true, silentIfUnavailable: true });
  }, [api, isLiveRuntime, previewCwd, previewState?.status, startPreview, workspaceReady]);

  const scheduleActiveDrawStrokeRender = useCallback(() => {
    if (activeDrawFrameRef.current !== null) {
      return;
    }
    activeDrawFrameRef.current = window.requestAnimationFrame(() => {
      activeDrawFrameRef.current = null;
      const stroke = activeDrawStrokeRef.current;
      setActiveDrawStroke(stroke ? { ...stroke, points: stroke.points.slice() } : null);
    });
  }, []);

  const resetActiveDrawStroke = useCallback(() => {
    if (activeDrawFrameRef.current !== null) {
      window.cancelAnimationFrame(activeDrawFrameRef.current);
      activeDrawFrameRef.current = null;
    }
    activeDrawStrokeRef.current = null;
    activeDrawPointerIdRef.current = null;
    activeDrawOverlayRectRef.current = null;
    setActiveDrawStroke(null);
  }, []);

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
    void navigateBrowserToPreviewUrl(requestedUrl);
  }, [
    isLiveRuntime,
    navigateBrowserToPreviewUrl,
    previewState?.status,
    previewState?.url,
    workspaceReady,
  ]);

  useEffect(() => {
    if (editorMode !== "inspect") {
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
    if (!isLiveRuntime || !workspaceReady || editorMode !== "inspect") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setEditorMode("browse");
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [editorMode, isLiveRuntime, workspaceReady]);

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

  useLayoutEffect(() => {
    if (!editingTextAnnotationId) {
      return;
    }
    editTextAnnotationInputRef.current?.focus();
    editTextAnnotationInputRef.current?.select();
  }, [editingTextAnnotationId]);

  useEffect(() => {
    if (
      autoAttachAnnotationScreenshot &&
      hasAttachableBrowserEditorContext()
    ) {
      scheduleBrowserAnnotationAttachmentUpdate(0);
    }
  }, [
    autoAttachAnnotationScreenshot,
    hasAttachableBrowserEditorContext,
    scheduleBrowserAnnotationAttachmentUpdate,
  ]);

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
    if (
      !autoAttachAnnotationScreenshot ||
      !hasAttachableBrowserEditorContext()
    ) {
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
      if (activeDrawFrameRef.current !== null) {
        window.cancelAnimationFrame(activeDrawFrameRef.current);
        activeDrawFrameRef.current = null;
      }
      activeDrawStrokeRef.current = null;
      activeDrawPointerIdRef.current = null;
      activeDrawOverlayRectRef.current = null;
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
      webview.style.backgroundColor = "#fff";
      webview.setAttribute("partition", BROWSER_WEBVIEW_PARTITION);
      webview.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=yes");
      browserWebviewRef.current = webview;
      host.append(webview);
    } else if (webview.parentElement !== host) {
      host.append(webview);
    }

    const initialUrl = activeTab.lastCommittedUrl ?? activeTab.url ?? BROWSER_BLANK_URL;
    if (browserWebviewTabIdRef.current !== activeTab.id) {
      browserWebviewTabIdRef.current = activeTab.id;
      browserWebviewAttachKeyRef.current = null;
      webview.setAttribute("src", initialUrl.length > 0 ? initialUrl : BROWSER_BLANK_URL);
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
    runBrowserAction,
    threadId,
    upsertThreadState,
    workspaceReady,
  ]);

  useEffect(() => {
    return () => {
      browserWebviewRef.current?.remove();
      browserWebviewRef.current = null;
      browserWebviewTabIdRef.current = null;
      browserWebviewAttachKeyRef.current = null;
    };
  }, []);

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
      const obscuredByOverlay = hasNativeBrowserObscuringOverlay(element);
      lastOverlayObscuredRef.current = obscuredByOverlay;
      setBrowserWebviewOverlayOcclusion(browserWebviewRef.current, obscuredByOverlay);
      const rect = element.getBoundingClientRect();
      const bounds = obscuredByOverlay
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
  }, [api, canUseNativeBrowserSurface, threadId]);

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

    const attachmentCount = composerDraftImageCount + composerDraftAssistantSelectionCount;
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
      const metrics = textAnnotationBoxMetrics(text);
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
      setTextAnnotationDraft({
        id: crypto.randomUUID(),
        ...pointFromOverlayEvent(event),
        text: "",
      });
    },
    [commitTextAnnotationDraft, editorMode],
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
      setHoveredTextAnnotationId((current) => (current === annotationId ? current : annotationId));
    },
    [clearTextAnnotationHoverHideTimeout],
  );

  const scheduleHideTextAnnotationControls = useCallback(
    (annotationId: string) => {
      clearTextAnnotationHoverHideTimeout();
      textAnnotationHoverHideTimeoutRef.current = window.setTimeout(() => {
        textAnnotationHoverHideTimeoutRef.current = null;
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
    (
      drag: NonNullable<typeof textAnnotationDragRef.current>,
      position: BrowserDrawingPoint,
    ) => {
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
    const metrics = textAnnotationBoxMetrics(text);
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
      const boxPosition = textAnnotationBoxPosition(annotation);
      textAnnotationDragRef.current = {
        id: annotation.id,
        pointerId: event.pointerId,
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
      const annotation = textAnnotationsRef.current.find(
        (candidate) => candidate.id === drag.id,
      );
      const next = clampTextAnnotationBoxPosition(
        {
          x: drag.startBoxX + event.clientX - drag.startClientX,
          y: drag.startBoxY + event.clientY - drag.startClientY,
        },
        browserEditorOverlayRef.current,
        annotation ? browserTextAnnotationMetrics(annotation) : undefined,
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
      const annotation = textAnnotationsRef.current.find(
        (candidate) => candidate.id === drag.id,
      );
      const next = clampTextAnnotationBoxPosition(
        {
          x: drag.startBoxX + event.clientX - drag.startClientX,
          y: drag.startBoxY + event.clientY - drag.startClientY,
        },
        browserEditorOverlayRef.current,
        annotation ? browserTextAnnotationMetrics(annotation) : undefined,
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
      if (
        Math.abs(next.x - drag.startBoxX) >= 0.5 ||
        Math.abs(next.y - drag.startBoxY) >= 0.5
      ) {
        scheduleBrowserAnnotationAttachmentUpdate(0);
      }
    },
    [moveTextAnnotationBox, scheduleBrowserAnnotationAttachmentUpdate],
  );

  const updateAnnotationArrowDraftTarget = useCallback((clientX: number, clientY: number) => {
    const point = pointFromOverlayClientPoint(browserEditorOverlayRef.current, clientX, clientY);
    setAnnotationArrowDraft((current) => {
      const next = current ? { ...current, to: point } : current;
      annotationArrowDraftRef.current = next;
      return next;
    });
  }, []);

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
        to: pointFromOverlayClientPoint(browserEditorOverlayRef.current, event.clientX, event.clientY),
        sourceTextAnnotationId: annotation.id,
        sourceHandle: handle,
      } satisfies BrowserAnnotationArrow;
      setSelectedAnnotationArrowId(null);
      setSelectedTextAnnotationId(annotation.id);
      arrowDraftDragRef.current = { id, pointerId: event.pointerId };
      annotationArrowDraftRef.current = arrow;
      setAnnotationArrowDraft(arrow);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
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

  const finishAnnotationArrowDraft = useCallback((event: ReactPointerEvent<Element>) => {
    const drag = arrowDraftDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    arrowDraftDragRef.current = null;
    const draft = annotationArrowDraftRef.current;
    annotationArrowDraftRef.current = null;
    setAnnotationArrowDraft(null);
    if (draft && draft.id === drag.id && browserAnnotationArrowLength(draft) >= BROWSER_ARROW_MIN_LENGTH) {
      setAnnotationArrows((existing) => {
        const next = [...existing, draft];
        annotationArrowsRef.current = next;
        return next;
      });
      setSelectedAnnotationArrowId(draft.id);
      setSelectedTextAnnotationId(null);
      showAnnotationArrowControls(draft.id);
    }
  }, [showAnnotationArrowControls]);

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
      annotationArrowDraftRef.current = arrow;
      setAnnotationArrowDraft(arrow);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
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

  const finishAnnotationArrowTargetDrag = useCallback((event: ReactPointerEvent<Element>) => {
    const drag = arrowTargetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    arrowTargetDragRef.current = null;
    const draft = annotationArrowDraftRef.current;
    annotationArrowDraftRef.current = null;
    setAnnotationArrowDraft(null);
    if (draft && draft.id === drag.id && browserAnnotationArrowLength(draft) >= BROWSER_ARROW_MIN_LENGTH) {
      setAnnotationArrows((existing) => {
        const next = existing.map((arrow) => (arrow.id === draft.id ? draft : arrow));
        annotationArrowsRef.current = next;
        return next;
      });
      setSelectedAnnotationArrowId(draft.id);
      setSelectedTextAnnotationId(null);
      showAnnotationArrowControls(draft.id);
    }
  }, [showAnnotationArrowControls]);

  const selectAnnotationArrow = useCallback((arrow: BrowserAnnotationArrow) => {
    setSelectedAnnotationArrowId(arrow.id);
    setSelectedTextAnnotationId(null);
    showAnnotationArrowControls(arrow.id);
  }, [showAnnotationArrowControls]);

  const deleteAnnotationArrowById = useCallback(
    (arrowId: string): boolean => {
      if (!annotationArrowsRef.current.some((arrow) => arrow.id === arrowId)) {
        return false;
      }

      if (annotationArrowDraftRef.current?.id === arrowId) {
        annotationArrowDraftRef.current = null;
        arrowDraftDragRef.current = null;
        arrowTargetDragRef.current = null;
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
    [scheduleBrowserAnnotationAttachmentUpdate],
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
        annotationArrowDraftRef.current = null;
        arrowDraftDragRef.current = null;
        arrowTargetDragRef.current = null;
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
      };
      activeDrawPointerIdRef.current = event.pointerId;
      activeDrawOverlayRectRef.current = overlayRect;
      activeDrawStrokeRef.current = stroke;
      setActiveDrawStroke(stroke);
    },
    [editorMode, resetActiveDrawStroke],
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
        scheduleActiveDrawStrokeRender();
      }
    },
    [editorMode, scheduleActiveDrawStrokeRender],
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
      onDrawPointerUp(event);
    },
    [
      finishAnnotationArrowDraft,
      finishAnnotationArrowTargetDrag,
      finishTextAnnotationDrag,
      onDrawPointerUp,
    ],
  );

  const clearDrawingAnnotations = useCallback(() => {
    resetActiveDrawStroke();
    drawStrokesRef.current = [];
    textAnnotationsRef.current = [];
    annotationArrowsRef.current = [];
    annotationArrowDraftRef.current = null;
    arrowDraftDragRef.current = null;
    arrowTargetDragRef.current = null;
    clearTextAnnotationHoverHideTimeout();
    clearAnnotationArrowHoverHideTimeout();
    const activeTextAnnotationDrag = textAnnotationDragRef.current;
    if (activeTextAnnotationDrag?.frameId !== null && activeTextAnnotationDrag?.frameId !== undefined) {
      window.cancelAnimationFrame(activeTextAnnotationDrag.frameId);
    }
    textAnnotationDragRef.current = null;
    selectedElementContextRef.current = null;
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
    clearBrowserAnnotationContext();
    setLocalError(null);
  }, [
    clearAnnotationArrowHoverHideTimeout,
    clearBrowserAnnotationContext,
    clearTextAnnotationHoverHideTimeout,
    resetActiveDrawStroke,
  ]);

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
    void updateBrowserAnnotationAttachment();
    toastManager.add({
      type: "success",
      title: "Live editor context attached",
    });
    setLocalError(null);
  }, [updateBrowserAnnotationAttachment]);

  const usableDrawStrokeCount = drawStrokes.filter((stroke) => stroke.points.length > 1).length;
  const hasTextAnnotations = textAnnotations.length > 0;
  const hasAnnotationArrows = annotationArrows.length > 0;
  const canUndoAnnotation = usableDrawStrokeCount > 0 || hasTextAnnotations || hasAnnotationArrows;
  const hasBrowserAnnotation =
    usableDrawStrokeCount > 0 ||
    hasTextAnnotations ||
    hasAnnotationArrows ||
    selectedElementContext !== null;
  const renderedDrawStrokes = activeDrawStroke
    ? [...drawStrokes, activeDrawStroke]
    : drawStrokes;
  const visibleAnnotationBox =
    editorMode === "inspect" && inspectHoverBox
      ? inspectHoverBox
      : selectedElementContext
        ? {
            x: selectedElementContext.rect.x,
            y: selectedElementContext.rect.y,
            width: selectedElementContext.rect.width,
            height: selectedElementContext.rect.height,
            label: selectedElementContext.selector || selectedElementContext.tagName.toLowerCase(),
          }
        : null;
  const visibleAnnotationArrows = resolveBrowserAnnotationArrowSources(
    [
      ...annotationArrows.filter(
        (arrow) => !annotationArrowDraft || arrow.id !== annotationArrowDraft.id,
      ),
      ...(annotationArrowDraft ? [annotationArrowDraft] : []),
    ],
    textAnnotations,
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
  const browserEditorOverlayEnabled = isLiveRuntime && workspaceReady && editorMode !== "browse";
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
            className="font-mono h-8 min-w-0 bg-background/70 text-xs [-webkit-app-region:no-drag]"
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
        <Menu modal={false}>
          <MenuTrigger
            render={
              <Button
                ref={copyScreenshotButtonRef}
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
              onClick={onCopyScreenshotToClipboard}
            >
              <BrowserActionMenuIcon icon={CopyIcon} />
              <span>Copy screenshot</span>
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
              <span>Close browser panel</span>
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
    <DiffPanelShell mode={mode} header={header}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={browserTabsBarRef}
          className="border-b border-border px-2 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {threadBrowserState?.tabs.map((tab) => {
                const isActive = tab.id === activeTab?.id;
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      "group flex h-8 min-w-0 max-w-[14rem] items-center rounded-md border px-2 text-left text-xs transition-colors",
                      isActive
                        ? "border-border/70 text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border/50 hover:text-foreground",
                      tab.status === "suspended" ? "opacity-75" : "",
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
          {isLiveRuntime || previewCwd ? (
            <div className="mt-1.5 flex min-w-0 items-center gap-1 overflow-x-auto">
              {isLiveRuntime ? (
                <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-background/60 p-0.5">
                  <button
                    type="button"
                    className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                    data-active={editorMode === "browse"}
                    title="Browse"
                    onClick={() => {
                      setEditorMode("browse");
                    }}
                  >
                    <GlobeIcon className="size-3.5" />
                    <span className="sr-only">Browse</span>
                  </button>
                  <button
                    type="button"
                    className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                    data-active={editorMode === "inspect"}
                    title="Inspect"
                    onClick={() => {
                      setEditorMode("inspect");
                    }}
                  >
                    <EyeIcon className="size-3.5" />
                    <span className="sr-only">Inspect</span>
                  </button>
                  <button
                    type="button"
                    className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                    data-active={editorMode === "draw"}
                    title="Draw"
                    onClick={() => {
                      setEditorMode("draw");
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                    <span className="sr-only">Draw</span>
                  </button>
                  <button
                    type="button"
                    className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                    data-active={editorMode === "text"}
                    title="Text annotation"
                    onClick={() => {
                      setEditorMode("text");
                    }}
                  >
                    <TextIcon className="size-3.5" />
                    <span className="sr-only">Text annotation</span>
                  </button>
                  <button
                    type="button"
                    className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                    disabled={!canUndoAnnotation}
                    title="Undo annotation"
                    onClick={undoLastDrawingStroke}
                  >
                    <Undo2Icon className="size-3.5" />
                    <span className="sr-only">Undo annotation</span>
                  </button>
                  <button
                    type="button"
                    className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                    disabled={!hasBrowserAnnotation}
                    title="Clear annotation"
                    onClick={clearDrawingAnnotations}
                  >
                    <EraserIcon className="size-3.5" />
                    <span className="sr-only">Clear annotation</span>
                  </button>
                  <button
                    type="button"
                    className={cn(BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME, "gap-1.5")}
                    aria-pressed={autoAttachAnnotationScreenshot}
                    aria-label={autoAttachAnnotationScreenshot ? "AUTO camera" : "MANUAL camera"}
                    title={
                      autoAttachAnnotationScreenshot
                        ? "Switch annotation capture to manual"
                        : "Switch annotation capture to auto"
                    }
                    onClick={() => {
                      setAutoAttachAnnotationScreenshot((current) => !current);
                    }}
                  >
                    <span className="text-[10px] font-semibold uppercase">
                      {autoAttachAnnotationScreenshot ? "AUTO" : "MANUAL"}
                    </span>
                    <CameraIcon className="size-3.5" />
                  </button>
                  {!autoAttachAnnotationScreenshot ? (
                    <button
                      type="button"
                      className={BROWSER_EDITOR_MODE_BUTTON_CLASS_NAME}
                      disabled={!hasBrowserAnnotation}
                      title="Attach live editor context"
                      onClick={addDrawingToPrompt}
                    >
                      <PlusIcon className="size-3.5" />
                      <span className="sr-only">Attach live editor context</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
              {previewCwd ? (
                <div className="flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-background/60 px-1 py-0.5">
                  <span
                    className={cn(
                      "max-w-28 truncate px-1.5 text-[11px] text-muted-foreground",
                      previewState?.status === "error" ? "text-destructive" : "",
                    )}
                    title={previewState?.lastError ?? previewState?.url ?? previewCwd}
                  >
                    {previewStatusLabel}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={!previewCanStart}
                    title="Start preview"
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={!previewCanStop}
                    title="Stop preview"
                    onClick={() => {
                      void stopPreview();
                    }}
                  >
                    <StopIcon className="size-3" />
                    <span className="sr-only">Stop preview</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={!previewCanRestart}
                    title="Restart preview"
                    onClick={() => {
                      void restartPreview();
                    }}
                  >
                    <RefreshCwIcon className="size-3" />
                    <span className="sr-only">Restart preview</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    disabled={!previewState?.url}
                    title="Open preview"
                    onClick={() => {
                      if (previewState?.url) {
                        void navigateBrowserToPreviewUrl(previewState.url);
                      }
                    }}
                  >
                    <ExternalLinkIcon className="size-3" />
                    <span className="sr-only">Open preview</span>
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
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
            <div ref={browserViewportRef} className="absolute inset-0 bg-transparent">
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
              {!canUseNativeBrowserSurface && !activeTab ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background p-6 text-center">
                  <div className="max-w-sm">
                    <GlobeIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">No browser tab open</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Enter a URL or start a preview to open a page here.
                    </p>
                  </div>
                </div>
              ) : null}
              {browserEditorOverlayEnabled ? (
                <div
                  ref={browserEditorOverlayRef}
                  data-browser-editor-overlay="true"
                  className={cn(
                    "absolute inset-0 z-20 select-none",
                    editorMode === "text" ? "cursor-text" : "cursor-crosshair",
                  )}
                  onPointerMove={onBrowserEditorOverlayPointerMove}
                  onPointerDown={onDrawPointerDown}
                  onPointerUp={onBrowserEditorOverlayPointerUp}
                  onPointerCancel={onBrowserEditorOverlayPointerUp}
                  onClick={onBrowserEditorOverlayClick}
                >
                  {visibleAnnotationBox ? (
                    <>
                      <div
                        className="pointer-events-none absolute rounded-[2px] border border-cyan-200/90 bg-cyan-300/[0.24] shadow-[inset_0_0_0_1px_rgba(8,145,178,0.62),0_0_0_1px_rgba(0,0,0,0.5),0_0_24px_rgba(34,211,238,0.42)]"
                        style={{
                          left: visibleAnnotationBox.x,
                          top: visibleAnnotationBox.y,
                          width: visibleAnnotationBox.width,
                          height: visibleAnnotationBox.height,
                        }}
                      />
                      <div
                        className="pointer-events-none absolute rounded-[2px] border-2 border-white bg-white/[0.18] shadow-[0_0_0_1px_rgba(255,255,255,0.85)] mix-blend-difference"
                        style={{
                          left: visibleAnnotationBox.x,
                          top: visibleAnnotationBox.y,
                          width: visibleAnnotationBox.width,
                          height: visibleAnnotationBox.height,
                        }}
                      />
                      <div
                        className="pointer-events-none absolute max-w-72 truncate rounded border border-cyan-200/75 bg-black/[0.88] px-2 py-1 text-[11px] font-medium text-white shadow-[0_0_0_1px_rgba(255,255,255,0.24),0_8px_20px_rgba(0,0,0,0.32)]"
                        style={{
                          left: Math.max(8, visibleAnnotationBox.x),
                          top: Math.max(8, visibleAnnotationBox.y - 28),
                        }}
                      >
                        {visibleAnnotationBox.label}
                      </div>
                    </>
                  ) : null}
                  {renderedDrawStrokes.length > 0 ? (
                    <svg
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      aria-hidden="true"
                    >
                      <defs>
                        {renderedDrawStrokes.map((stroke, strokeIndex) => {
                          const gradientId = `browser-drawing-gradient-${svgFragmentId(threadId)}-${svgFragmentId(stroke.id)}`;
                          const colors = gradientColorsForStroke(strokeIndex);

                          return (
                            <linearGradient
                              key={gradientId}
                              id={gradientId}
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
                              <stop offset="0%" stopColor={colors[0]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 0)}
                                  dur="8s"
                                  begin={`${strokeIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="24%" stopColor={colors[1]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 1)}
                                  dur="8s"
                                  begin={`${strokeIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="48%" stopColor={colors[2]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 2)}
                                  dur="8s"
                                  begin={`${strokeIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="72%" stopColor={colors[3]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 3)}
                                  dur="8s"
                                  begin={`${strokeIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="100%" stopColor={colors[4]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 4)}
                                  dur="8s"
                                  begin={`${strokeIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                            </linearGradient>
                          );
                        })}
                      </defs>
                      {renderedDrawStrokes.map((stroke) => {
                        const points = drawingStrokePoints(stroke);
                        const gradientId = `browser-drawing-gradient-${svgFragmentId(threadId)}-${svgFragmentId(stroke.id)}`;

                        return (
                          <g key={stroke.id}>
                            <polyline
                              className="mix-blend-difference"
                              fill="none"
                              points={points}
                              stroke={BROWSER_DRAWING_CONTRAST_STROKE_COLOR}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={BROWSER_DRAWING_CONTRAST_STROKE_WIDTH}
                              opacity="0.94"
                            />
                            <polyline
                              fill="none"
                              points={points}
                              stroke={`url(#${gradientId})`}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={BROWSER_DRAWING_GRADIENT_STROKE_WIDTH}
                            />
                            <polyline
                              className="mix-blend-difference"
                              fill="none"
                              points={points}
                              stroke={BROWSER_DRAWING_CONTRAST_STROKE_COLOR}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={BROWSER_DRAWING_GLINT_STROKE_WIDTH}
                              opacity="0.72"
                            />
                          </g>
                        );
                      })}
                    </svg>
                  ) : null}
                  {visibleAnnotationArrows.length > 0 ? (
                    <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
                      <defs>
                        {visibleAnnotationArrows.map((arrow, arrowIndex) => {
                          const gradientId = `browser-annotation-arrow-gradient-${svgFragmentId(threadId)}-${svgFragmentId(arrow.id)}`;
                          const colors = gradientColorsForStroke(drawStrokes.length + arrowIndex);

                          return (
                            <linearGradient
                              key={gradientId}
                              id={gradientId}
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
                              <stop offset="0%" stopColor={colors[0]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 0)}
                                  dur="8s"
                                  begin={`${arrowIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="24%" stopColor={colors[1]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 1)}
                                  dur="8s"
                                  begin={`${arrowIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="48%" stopColor={colors[2]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 2)}
                                  dur="8s"
                                  begin={`${arrowIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="72%" stopColor={colors[3]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 3)}
                                  dur="8s"
                                  begin={`${arrowIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                              <stop offset="100%" stopColor={colors[4]!}>
                                <animate
                                  attributeName="stop-color"
                                  values={shiftedClosedGradientColors(colors, 4)}
                                  dur="8s"
                                  begin={`${arrowIndex * 0.13}s`}
                                  repeatCount="indefinite"
                                />
                              </stop>
                            </linearGradient>
                          );
                        })}
                      </defs>
                      {visibleAnnotationArrows.map((arrow) => {
                        const isArrowSelected = selectedAnnotationArrowId === arrow.id;
                        const showTargetHandle =
                          isArrowSelected ||
                          arrow.id === annotationArrowDraft?.id ||
                          hoveredAnnotationArrowId === arrow.id ||
                          (arrow.sourceTextAnnotationId !== undefined &&
                            hoveredTextAnnotationId === arrow.sourceTextAnnotationId);
                        const gradientId = `browser-annotation-arrow-gradient-${svgFragmentId(threadId)}-${svgFragmentId(arrow.id)}`;
                        const head = browserAnnotationArrowHeadPoints(arrow);
                        const segments = [
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
                                stroke={`url(#${gradientId})`}
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
                            <circle
                              className={cn(
                                "cursor-crosshair fill-black/80 stroke-cyan-200 transition-opacity duration-150 ease-out",
                                showTargetHandle
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
                    const visibleText = isEditing
                      ? editingTextAnnotationValue
                      : annotation.text;
                    const boxMetrics = textAnnotationBoxMetrics(visibleText);
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
                              "box-border h-full w-full whitespace-pre-wrap rounded-md border border-white/80 bg-slate-950/90 px-2.5 py-1.5 text-xs font-semibold text-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_8px_20px_rgba(0,0,0,0.26)]",
                              isEditing
                                ? "cursor-text ring-2 ring-cyan-300/80"
                                : "cursor-grab active:cursor-grabbing",
                              isSelected && !isEditing ? "ring-2 ring-cyan-300/80" : "",
                            )}
                            style={{
                              lineHeight: `${BROWSER_TEXT_ANNOTATION_LINE_HEIGHT}px`,
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
                            onMouseEnter={() => {
                              showTextAnnotationControls(annotation.id);
                            }}
                            onMouseMove={() => {
                              showTextAnnotationControls(annotation.id);
                            }}
                            onMouseLeave={() => {
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
                                value={editingTextAnnotationValue}
                                rows={1}
                                className="h-full w-full resize-none bg-transparent p-0 text-xs font-semibold text-white outline-none"
                                style={{
                                  lineHeight: `${BROWSER_TEXT_ANNOTATION_LINE_HEIGHT}px`,
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
                                    onMouseEnter={() => {
                                      showTextAnnotationControls(annotation.id);
                                    }}
                                    onMouseMove={() => {
                                      showTextAnnotationControls(annotation.id);
                                    }}
                                    onMouseLeave={() => {
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
                        const draftMetrics = textAnnotationBoxMetrics(textAnnotationDraft.text);
                        const draftPosition = clampTextAnnotationBoxPosition(
                          textAnnotationBoxPosition(textAnnotationDraft, draftMetrics),
                          browserEditorOverlayRef.current,
                          draftMetrics,
                        );
                        return (
                          <textarea
                            ref={textAnnotationInputRef}
                            value={textAnnotationDraft.text}
                            rows={1}
                            className="absolute z-10 box-border resize-none whitespace-pre-wrap rounded-md border border-white/80 bg-slate-950/92 px-2.5 py-1.5 text-xs font-semibold text-white shadow-[0_0_0_1px_rgba(0,0,0,0.35),0_8px_20px_rgba(0,0,0,0.28)] outline-none placeholder:text-white/55 focus:ring-2 focus:ring-cyan-300/70"
                            placeholder={BROWSER_TEXT_ANNOTATION_PLACEHOLDER}
                            style={{
                              left: draftPosition.x,
                              top: draftPosition.y,
                              width: draftMetrics.width,
                              height: draftMetrics.height,
                              lineHeight: `${BROWSER_TEXT_ANNOTATION_LINE_HEIGHT}px`,
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
                                setTextAnnotationDraft(null);
                              }
                            }}
                          />
                        );
                      })()
                    : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </DiffPanelShell>
  );
}

export default BrowserPanel;
