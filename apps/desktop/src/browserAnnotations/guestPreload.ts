import { ipcRenderer } from "electron";
import type {
  BrowserAnnotation,
  BrowserAnnotationMarker,
  BrowserAnnotationSource,
  BrowserAnnotationTheme,
} from "@synara/contracts";
import { sanitizeBrowserAnnotationUrl } from "@synara/shared/browserAnnotations";

import { BROWSER_ANNOTATION_GUEST_COMMAND_CHANNEL, BROWSER_IPC_CHANNELS } from "../ipcChannels";
import { createGuestIdentifier } from "./guestIdentity";
import {
  GUEST_ANNOTATION_MAX_COMMENT_LENGTH,
  GUEST_ANNOTATION_MAX_NAME_LENGTH,
  GUEST_ANNOTATION_MAX_PAGE_TITLE_LENGTH,
  GUEST_ANNOTATION_MAX_SELECTOR_LENGTH,
  GUEST_ANNOTATION_MAX_TEXT_LENGTH,
  GUEST_ANNOTATION_MAX_URL_LENGTH,
  GUEST_ANNOTATION_PROTOCOL_VERSION,
  isGuestAnnotationCommand,
} from "./guestProtocol";

const HOST_ATTRIBUTE = "data-synara-browser-annotations";
const documentToken = createGuestIdentifier(globalThis.crypto);

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let outline: HTMLElement | null = null;
let popover: HTMLElement | null = null;
let textarea: HTMLTextAreaElement | null = null;
let badgeLayer: HTMLElement | null = null;
let submitButton: HTMLButtonElement | null = null;
let activeSession: { sessionId: string } | null = null;
let hoveredElement: Element | null = null;
let selectedElement: Element | null = null;
let projectedMarkers: readonly BrowserAnnotationMarker[] = [];
let projectionVersion = 0;
let projectionAckPending = false;
let renderQueued = false;
let markerResizeObserver: ResizeObserver | null = null;
let observedMarkerTargets = new Set<Element>();
let interactionListenersInstalled = false;
const suppressedKeyups = new Set<string>();

function normalizedText(value: string, maximumLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function currentSource(): BrowserAnnotationSource {
  return {
    url: sanitizeBrowserAnnotationUrl(new URL(globalThis.location.href).href),
    pageTitle: normalizedText(document.title, GUEST_ANNOTATION_MAX_PAGE_TITLE_LENGTH),
  };
}

function sendReady(): void {
  ipcRenderer.send(BROWSER_IPC_CHANNELS.annotations.guestMessage, {
    version: GUEST_ANNOTATION_PROTOCOL_VERSION,
    kind: "ready",
    documentToken,
    source: currentSource(),
  });
}

function cssEscape(value: string): string {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (character, leadingDigit) =>
    leadingDigit ? `\\3${character} ` : `\\${character}`,
  );
}

function looksSensitiveLocator(value: string): boolean {
  return (
    /\b(?:authorization|password|passwd|secret|api[-_]?key|auth|session|token|credential)\b/i.test(
      value,
    ) ||
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
    /(?:^|[-_:])[A-Za-z0-9_-]{24,}(?:$|[-_:])/.test(value)
  );
}

function uniqueSelector(element: Element): string | null {
  if (element.id && !looksSensitiveLocator(element.id)) {
    const byId = `#${cssEscape(element.id)}`;
    try {
      if (
        byId.length <= GUEST_ANNOTATION_MAX_SELECTOR_LENGTH &&
        document.querySelectorAll(byId).length === 1
      ) {
        return byId;
      }
    } catch {
      // Fall through to the structural selector.
    }
  }
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    const parent: Element | null = current.parentElement;
    const tag = current.tagName.toLowerCase();
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (candidate) => candidate.tagName === current?.tagName,
    );
    const index = siblings.indexOf(current) + 1;
    segments.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
    current = parent;
  }
  segments.unshift("html");
  const selector = segments.join(" > ");
  return selector.length <= GUEST_ANNOTATION_MAX_SELECTOR_LENGTH ? selector : null;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function implicitRole(element: Element): string {
  const tagName = element.tagName;
  if (tagName === "BUTTON") return "button";
  if (tagName === "A" && element.hasAttribute("href")) return "link";
  if (tagName === "TEXTAREA") return "textbox";
  if (tagName === "SELECT") {
    return element instanceof HTMLSelectElement && (element.multiple || element.size > 1)
      ? "listbox"
      : "combobox";
  }
  if (tagName === "INPUT" && element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type !== "hidden") return "textbox";
  }
  if (tagName === "IMG") return "img";
  if (tagName === "MAIN") return "main";
  if (tagName === "NAV") return "navigation";
  if (tagName === "FORM") return "form";
  if (tagName === "TABLE") return "table";
  if (tagName === "LI") return "listitem";
  if (tagName === "UL" || tagName === "OL") return "list";
  return "";
}

function labelledByText(element: Element): string {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean);
  if (!ids || ids.length === 0) return "";
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

function associatedLabelText(element: Element): string {
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLButtonElement
    )
  ) {
    return "";
  }
  return Array.from(element.labels ?? [])
    .map((label) => label.innerText)
    .join(" ");
}

function elementAccessibleName(element: Element): string {
  const directName =
    element.getAttribute("aria-label") ||
    labelledByText(element) ||
    associatedLabelText(element) ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    "";
  if (directName) return normalizedText(directName, GUEST_ANNOTATION_MAX_NAME_LENGTH);
  if (
    element instanceof HTMLInputElement &&
    ["button", "submit", "reset"].includes(element.type.toLowerCase())
  ) {
    return normalizedText(element.value, GUEST_ANNOTATION_MAX_NAME_LENGTH);
  }
  if (
    element instanceof HTMLElement &&
    ["BUTTON", "A", "SUMMARY", "OPTION"].includes(element.tagName)
  ) {
    return normalizedText(element.innerText, GUEST_ANNOTATION_MAX_NAME_LENGTH);
  }
  return "";
}

function elementFingerprint(element: Element): string {
  const structuralParts: string[] = [];
  let current: Element | null = element;
  let depth = 0;
  while (current && depth < 16) {
    const parent: Element | null = current.parentElement;
    const sameTagIndex = parent
      ? Array.from(parent.children)
          .filter((candidate) => candidate.tagName === current?.tagName)
          .indexOf(current)
      : 0;
    structuralParts.unshift(`${current.tagName.toLowerCase()}:${Math.max(0, sameTagIndex)}`);
    current = parent;
    depth += 1;
  }
  structuralParts.push(
    `role:${normalizedText(element.getAttribute("role") ?? implicitRole(element), 64)}`,
  );
  return fnv1a64(structuralParts.join("\u001f"));
}

function isSensitiveElement(element: Element): boolean {
  const tag = element.tagName;
  return (
    (element instanceof HTMLInputElement &&
      !["button", "submit", "reset", "image"].includes(element.type.toLowerCase())) ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "OPTION" ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    element.matches("[autocomplete*='password' i], [autocomplete*='cc-' i]") ||
    element.querySelector("input[type='password'], [autocomplete*='cc-' i]") !== null
  );
}

function describeElement(element: Element, comment: string): BrowserAnnotation | null {
  const sensitive = isSensitiveElement(element);
  const role = normalizedText(element.getAttribute("role") ?? implicitRole(element), 64) || null;
  const name = sensitive ? null : elementAccessibleName(element) || null;
  const rawText = element instanceof HTMLElement ? element.innerText : element.textContent;
  const text = sensitive
    ? null
    : normalizedText(rawText ?? "", GUEST_ANNOTATION_MAX_TEXT_LENGTH) || null;
  const source = currentSource();
  const selector = uniqueSelector(element);
  if (source.url.length > GUEST_ANNOTATION_MAX_URL_LENGTH || !selector) return null;
  return {
    id: createGuestIdentifier(globalThis.crypto),
    source,
    selector,
    tagName: element.tagName,
    role,
    name,
    text,
    fingerprint: elementFingerprint(element),
    comment:
      normalizedText(comment, GUEST_ANNOTATION_MAX_COMMENT_LENGTH).trim().length > 0
        ? normalizedText(comment, GUEST_ANNOTATION_MAX_COMMENT_LENGTH)
        : null,
    capturedAt: new Date().toISOString(),
  };
}

function isOverlayTarget(target: EventTarget | null): boolean {
  return target instanceof Node && host?.contains(target) === true;
}

function isolateInteractionEvent(event: Event, preventPageDefault = true): boolean {
  const overlayTarget = isOverlayTarget(event.target);
  if (!overlayTarget && preventPageDefault && event.cancelable) {
    event.preventDefault();
  }
  event.stopImmediatePropagation();
  event.stopPropagation();
  return overlayTarget;
}

function keyboardEventIdentity(event: KeyboardEvent): string {
  return event.code || event.key;
}

function targetAtPoint(x: number, y: number): Element | null {
  const candidate = document.elementFromPoint(x, y);
  if (!candidate || candidate === host || candidate.closest(`[${HOST_ATTRIBUTE}]`)) return null;
  return candidate;
}

function selectTarget(target: Element): void {
  selectedElement = target;
  hoveredElement = target;
  // Open and focus synchronously so the first keystroke after selection
  // cannot land in the page while waiting for the next animation frame.
  renderOverlay();
  textarea?.focus({ preventScroll: true });
}

function eventHitsElement(event: MouseEvent, element: Element | null): boolean {
  if (!element?.isConnected) return false;
  const bounds = element.getBoundingClientRect();
  return (
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom
  );
}

function positionBox(element: HTMLElement, target: Element | null): void {
  if (!target || !target.isConnected) {
    element.hidden = true;
    return;
  }
  const bounds = target.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.style.left = `${bounds.left}px`;
  element.style.top = `${bounds.top}px`;
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
}

function applyVisualTheme(theme: BrowserAnnotationTheme): void {
  if (!host) return;
  host.setAttribute("data-theme", theme.mode);
  host.style.setProperty("--annotation-accent", theme.accent);
  host.style.setProperty("--annotation-surface", theme.surface);
  host.style.setProperty("--annotation-text", theme.text);
  host.style.setProperty("--annotation-muted-text", theme.mutedText);
  host.style.setProperty("--annotation-border", theme.border);
  host.style.setProperty("--annotation-focus-border", theme.focusBorder);
  host.style.setProperty("--annotation-primary", theme.primary);
  host.style.setProperty("--annotation-primary-text", theme.primaryText);
}

function renderOverlay(): void {
  renderQueued = false;
  if (!outline || !popover || !badgeLayer) return;
  if (host && !host.isConnected && document.documentElement) {
    document.documentElement.append(host);
  }
  if (selectedElement && !selectedElement.isConnected) {
    selectedElement = null;
    hoveredElement = null;
    if (textarea) textarea.value = "";
  }
  positionBox(outline, activeSession ? (selectedElement ?? hoveredElement) : null);
  if (activeSession && selectedElement?.isConnected) {
    const bounds = selectedElement.getBoundingClientRect();
    const width = Math.min(300, Math.max(220, globalThis.innerWidth - 24));
    const left = Math.min(
      Math.max(12, bounds.left),
      Math.max(12, globalThis.innerWidth - width - 12),
    );
    popover.hidden = false;
    popover.style.visibility = "hidden";
    popover.style.width = `${width}px`;
    const measuredHeight = popover.getBoundingClientRect().height || 104;
    const below = bounds.bottom + 10;
    const top =
      below + measuredHeight <= globalThis.innerHeight
        ? below
        : Math.max(12, bounds.top - measuredHeight - 10);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.visibility = "";
  } else {
    popover.hidden = true;
  }

  badgeLayer.replaceChildren();
  const source = currentSource();
  const projectedIds: string[] = [];
  const nextObservedTargets = new Set<Element>();
  for (const marker of projectedMarkers) {
    if (marker.source.url !== source.url) continue;
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(marker.selector);
    } catch {
      continue;
    }
    if (matches.length !== 1) continue;
    const target = matches[0];
    if (!target || elementFingerprint(target) !== marker.fingerprint) continue;
    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (
      bounds.right <= 0 ||
      bounds.bottom <= 0 ||
      bounds.left >= globalThis.innerWidth ||
      bounds.top >= globalThis.innerHeight
    ) {
      continue;
    }
    nextObservedTargets.add(target);
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = String(marker.ordinal);
    badge.style.left = `${bounds.right}px`;
    badge.style.top = `${bounds.top}px`;
    badgeLayer.append(badge);
    projectedIds.push(marker.id);
  }
  if (
    markerResizeObserver &&
    (nextObservedTargets.size !== observedMarkerTargets.size ||
      [...nextObservedTargets].some((target) => !observedMarkerTargets.has(target)))
  ) {
    markerResizeObserver.disconnect();
    markerResizeObserver.observe(document.documentElement);
    for (const target of nextObservedTargets) markerResizeObserver.observe(target);
    observedMarkerTargets = nextObservedTargets;
  }
  if (projectionAckPending) {
    projectionAckPending = false;
    ipcRenderer.send(BROWSER_IPC_CHANNELS.annotations.guestMessage, {
      version: GUEST_ANNOTATION_PROTOCOL_VERSION,
      kind: "markers-projected",
      documentToken,
      projectionVersion,
      projectedMarkerIds: projectedIds,
    });
  }
}

function queueRender(): void {
  if (!activeSession && projectedMarkers.length === 0 && !projectionAckPending) return;
  if (renderQueued) return;
  renderQueued = true;
  globalThis.requestAnimationFrame(renderOverlay);
}

function endInteractiveSession(notifyHost: boolean): void {
  const session = activeSession;
  activeSession = null;
  resetSelection();
  host?.removeAttribute("data-interactive");
  if (notifyHost && session) {
    ipcRenderer.send(BROWSER_IPC_CHANNELS.annotations.guestMessage, {
      version: GUEST_ANNOTATION_PROTOCOL_VERSION,
      kind: "cancelled",
      documentToken,
      sessionId: session.sessionId,
    });
  }
}

function resetSelection(): void {
  hoveredElement = null;
  selectedElement = null;
  if (textarea) textarea.value = "";
  renderOverlay();
}

function submitAnnotation(): void {
  const session = activeSession;
  const target = selectedElement;
  if (!session || !target || !target.isConnected) return;
  const annotation = describeElement(target, textarea?.value ?? "");
  if (!annotation) {
    endInteractiveSession(true);
    return;
  }
  resetSelection();
  ipcRenderer.send(BROWSER_IPC_CHANNELS.annotations.guestMessage, {
    version: GUEST_ANNOTATION_PROTOCOL_VERSION,
    kind: "committed",
    documentToken,
    sessionId: session.sessionId,
    annotation,
  });
}

function installInteractionListeners(): void {
  if (interactionListenersInstalled) return;
  interactionListenersInstalled = true;

  globalThis.addEventListener(
    "pointermove",
    (event) => {
      if (!activeSession) return;
      if (!isOverlayTarget(event.target) && !selectedElement) {
        hoveredElement = targetAtPoint(event.clientX, event.clientY);
        queueRender();
      }
      isolateInteractionEvent(event);
    },
    true,
  );
  globalThis.addEventListener(
    "pointerdown",
    (event) => {
      if (!activeSession) return;
      if (isolateInteractionEvent(event)) return;
      if (!event.isTrusted) return;
      const target = targetAtPoint(event.clientX, event.clientY);
      if (!target) return;
      selectTarget(target);
    },
    true,
  );
  globalThis.addEventListener(
    "click",
    (event) => {
      if (!activeSession) return;
      if (isolateInteractionEvent(event)) {
        if (
          event.isTrusted &&
          submitButton !== null &&
          (eventHitsElement(event, submitButton) || shadow?.activeElement === submitButton)
        ) {
          submitAnnotation();
        }
        return;
      }
      // Keyboard and assistive-technology activation can produce a trusted
      // click without a pointerdown. Keep that path selectable while ignoring
      // synthetic page-script clicks.
      if (!selectedElement && event.isTrusted && event.target instanceof Element) {
        selectTarget(event.target);
      }
    },
    true,
  );
  globalThis.addEventListener(
    "keydown",
    (event) => {
      if (!activeSession) return;
      suppressedKeyups.add(keyboardEventIdentity(event));
      if (isOverlayTarget(event.target)) {
        isolateInteractionEvent(event, false);
        if (event.key === "Escape") {
          event.preventDefault();
          endInteractiveSession(true);
          return;
        }
        if (
          (event.key === "Enter" && (event.metaKey || event.ctrlKey)) ||
          (submitButton !== null &&
            shadow?.activeElement === submitButton &&
            (event.key === "Enter" || event.key === " "))
        ) {
          event.preventDefault();
          submitAnnotation();
        }
        return;
      }
      isolateInteractionEvent(event);
      if (event.key === "Escape") {
        endInteractiveSession(true);
      }
    },
    true,
  );

  globalThis.addEventListener(
    "keyup",
    (event) => {
      const identity = keyboardEventIdentity(event);
      const startedInsidePicker = suppressedKeyups.delete(identity);
      if (!activeSession && !startedInsidePicker) return;
      isolateInteractionEvent(event, !isOverlayTarget(event.target));
    },
    true,
  );

  // Prevent the selected page from observing any later phase of the trusted
  // pointer/mouse/touch gesture. Overlay controls keep their native defaults
  // (focus, text selection, and scrolling) while their composed events remain
  // private to the closed shadow root.
  for (const eventType of [
    "pointerup",
    "pointercancel",
    "pointerrawupdate",
    "pointerover",
    "pointerout",
    "pointerenter",
    "pointerleave",
    "mousedown",
    "mousemove",
    "mouseup",
    "mouseover",
    "mouseout",
    "mouseenter",
    "mouseleave",
    "auxclick",
    "dblclick",
    "contextmenu",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "dragstart",
    "drag",
    "dragend",
    "dragenter",
    "dragleave",
    "dragover",
    "drop",
  ]) {
    globalThis.addEventListener(
      eventType,
      (event) => {
        if (!activeSession) return;
        isolateInteractionEvent(event);
      },
      true,
    );
  }

  // Register the keyboard/input boundary before page scripts run. Overlay
  // controls keep native editing defaults; page targets are cancelled, and
  // wheel propagation is hidden while native scrolling remains available.
  for (const eventType of [
    "keypress",
    "beforeinput",
    "input",
    "textInput",
    "paste",
    "copy",
    "cut",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "focusin",
    "focusout",
    "wheel",
  ]) {
    globalThis.addEventListener(
      eventType,
      (event) => {
        if (!activeSession) return;
        isolateInteractionEvent(event, eventType !== "wheel" && !isOverlayTarget(event.target));
      },
      true,
    );
  }
  document.addEventListener("scroll", queueRender, true);
  globalThis.addEventListener("resize", queueRender);
}

function initializeOverlay(): void {
  if (host || !document.documentElement) return;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, "");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style paint;";
  shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host {
        --annotation-accent:rgb(82,111,255);
        --annotation-surface:rgb(255,255,255);
        --annotation-text:rgb(23,23,23);
        --annotation-muted-text:rgb(115,115,115);
        --annotation-border:rgb(212,212,212);
        --annotation-focus-border:rgb(82,111,255);
        --annotation-primary:rgb(23,23,23);
        --annotation-primary-text:rgb(255,255,255);
      }
      * { box-sizing:border-box; }
      .outline {
        position:fixed;
        border:2px solid var(--annotation-accent);
        border-radius:6px;
        background:color-mix(in srgb,var(--annotation-accent) 7%,transparent);
        box-shadow:0 0 0 1px rgb(255 255 255 / .5);
        pointer-events:none;
        transition:transform 150ms ease-out,opacity 150ms ease-out;
      }
      .popover {
        position:fixed;
        padding:10px 10px 8px;
        overflow:hidden;
        border:1px solid var(--annotation-border);
        border-radius:16px;
        background:var(--annotation-surface);
        color:var(--annotation-text);
        box-shadow:0 6px 24px -10px rgb(0 0 0 / .34);
        backdrop-filter:blur(16px);
        -webkit-backdrop-filter:blur(16px);
        font:400 12px/1.625 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        pointer-events:auto;
        transition:border-color 150ms ease-out,box-shadow 150ms ease-out;
      }
      .popover:focus-within {
        border-color:var(--annotation-focus-border);
        box-shadow:
          0 0 0 1px color-mix(in srgb,var(--annotation-focus-border) 24%,transparent),
          0 6px 24px -10px rgb(0 0 0 / .34);
      }
      textarea {
        display:block;
        width:100%;
        min-height:50px;
        max-height:112px;
        resize:none;
        padding:2px 2px 8px;
        border:0;
        background:transparent;
        color:var(--annotation-text);
        font:inherit;
        outline:none;
      }
      textarea::placeholder { color:color-mix(in srgb,var(--annotation-muted-text) 58%,transparent); opacity:1; }
      .footer { display:flex; min-height:28px; align-items:center; justify-content:space-between; gap:8px; }
      .hint { padding-left:2px; color:var(--annotation-muted-text); font-size:10px; font-weight:400; }
      button {
        min-height:28px;
        border:0;
        border-radius:8px;
        padding:0 10px;
        background:var(--annotation-primary);
        color:var(--annotation-primary-text);
        font:500 11px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        cursor:pointer;
        transition:background-color 150ms ease-out,transform 100ms ease-out;
      }
      button:hover { background:color-mix(in srgb,var(--annotation-primary) 90%,transparent); }
      button:active { transform:scale(.98); }
      button:focus-visible { outline:1px solid var(--annotation-focus-border); outline-offset:2px; }
      .badges { position:fixed; inset:0; pointer-events:none; }
      .badge {
        position:fixed;
        display:grid;
        place-items:center;
        min-width:22px;
        height:22px;
        padding:0 6px;
        transform:translate(-50%,-50%);
        border:2px solid var(--annotation-surface);
        border-radius:999px;
        background:var(--annotation-accent);
        color:rgb(255 255 255);
        box-shadow:0 2px 8px rgb(0 0 0 / .24);
        font:700 11px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      [hidden] { display:none !important; }
      @media (prefers-reduced-motion:reduce) {
        .outline,.popover,button { transition:none; }
      }
    </style>
    <div class="badges"></div>
    <div class="outline" hidden></div>
    <section class="popover" role="dialog" aria-label="Annotate element" hidden>
      <textarea maxlength="${GUEST_ANNOTATION_MAX_COMMENT_LENGTH}" placeholder="Add an optional note…"></textarea>
      <div class="footer"><span class="hint">⌘/Ctrl + Enter</span><button type="button">Annotate</button></div>
    </section>
  `;
  outline = shadow.querySelector(".outline");
  popover = shadow.querySelector(".popover");
  textarea = shadow.querySelector("textarea");
  badgeLayer = shadow.querySelector(".badges");
  submitButton = shadow.querySelector("button");
  document.documentElement.append(host);
  markerResizeObserver = new ResizeObserver(queueRender);
  markerResizeObserver.observe(document.documentElement);
  new MutationObserver((records) => {
    if (!activeSession && projectedMarkers.length === 0) return;
    if (
      records.every(
        (record) =>
          record.target === host || (shadow !== null && record.target.getRootNode() === shadow),
      )
    ) {
      return;
    }
    queueRender();
  }).observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  globalThis.addEventListener("popstate", sendReady);
  globalThis.addEventListener("hashchange", sendReady);
  sendReady();
}

ipcRenderer.on(BROWSER_ANNOTATION_GUEST_COMMAND_CHANNEL, (_event, rawCommand: unknown) => {
  if (!isGuestAnnotationCommand(rawCommand) || rawCommand.documentToken !== documentToken) return;
  initializeOverlay();
  if (rawCommand.kind === "start") {
    activeSession = { sessionId: rawCommand.sessionId };
    applyVisualTheme(rawCommand.theme);
    host?.setAttribute("data-interactive", "");
    resetSelection();
    queueRender();
    return;
  }
  if (rawCommand.kind === "cancel") {
    if (activeSession?.sessionId === rawCommand.sessionId) endInteractiveSession(false);
    return;
  }
  if (rawCommand.kind === "refresh-document") {
    if (activeSession) endInteractiveSession(false);
    sendReady();
    return;
  }
  projectionVersion = rawCommand.projectionVersion;
  projectedMarkers = rawCommand.markers;
  projectionAckPending = true;
  queueRender();
});

// Preloads execute before page scripts. Install the capture boundary now,
// rather than at DOMContentLoaded, so an untrusted page cannot register an
// earlier listener for picker clicks or private comment input.
installInteractionListeners();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeOverlay, { once: true });
} else {
  initializeOverlay();
}
