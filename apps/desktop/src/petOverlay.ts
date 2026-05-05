// FILE: petOverlay.ts
// Purpose: Owns the transparent always-on-top Electron pet overlay window.
// Layer: Desktop main process window runtime
// Exports: DesktopPetOverlayController for renderer-driven pet state and dragging

import { BrowserWindow, screen } from "electron";
import type {
  DesktopPetOverlayDragStartInput,
  DesktopPetOverlayMoveDelta,
  DesktopPetOverlayPointerInteractionInput,
  DesktopPetOverlayState,
} from "@t3tools/contracts";

export const PET_OVERLAY_SET_STATE_CHANNEL = "desktop:pet-overlay-set-state";
export const PET_OVERLAY_HIDE_CHANNEL = "desktop:pet-overlay-hide";
export const PET_OVERLAY_CLOSE_CHANNEL = "desktop:pet-overlay-close";
export const PET_OVERLAY_MOVE_BY_CHANNEL = "desktop:pet-overlay-move-by";
export const PET_OVERLAY_MOVED_CHANNEL = "desktop:pet-overlay-moved";
export const PET_OVERLAY_DRAG_START_CHANNEL = "desktop:pet-overlay-drag-start";
export const PET_OVERLAY_DRAG_MOVE_CHANNEL = "desktop:pet-overlay-drag-move";
export const PET_OVERLAY_DRAG_END_CHANNEL = "desktop:pet-overlay-drag-end";
export const PET_OVERLAY_POINTER_INTERACTION_CHANNEL = "desktop:pet-overlay-pointer-interaction";

type ResolveAssetUrl = (url: string) => string;
type OnMoved = (position: { x: number; y: number }) => void;

interface OverlayDragState {
  pointerAnchorX: number;
  pointerAnchorY: number;
  hasMoved: boolean;
}

interface PetOverlayLayout {
  windowWidth: number;
  windowHeight: number;
  petLeft: number;
}

const MAX_PET_WINDOW_SIZE = 320;
const MIN_PET_WINDOW_SIZE = 16;
// Tiny vertical padding so the soft ground shadow under the pet isn't clipped at the window edge.
const PET_GROUND_PADDING = 8;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteIntegerInRange(value: unknown, min: number, max: number): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizePetState(
  input: unknown,
  resolveAssetUrl: ResolveAssetUrl,
): DesktopPetOverlayState | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const rawState = input as Partial<DesktopPetOverlayState>;

  const spritesheetUrl =
    typeof rawState.spritesheetUrl === "string" ? resolveAssetUrl(rawState.spritesheetUrl) : "";
  const displayName = typeof rawState.displayName === "string" ? rawState.displayName : "Codex pet";
  const description = typeof rawState.description === "string" ? rawState.description : "";
  const animation = typeof rawState.animation === "string" ? rawState.animation : "idle";
  const activity =
    typeof rawState.activity === "object" &&
    rawState.activity !== null &&
    (rawState.activity.kind === "input-needed" ||
      rawState.activity.kind === "working" ||
      rawState.activity.kind === "connecting") &&
    typeof rawState.activity.label === "string" &&
    typeof rawState.activity.title === "string"
      ? {
          kind: rawState.activity.kind,
          label: rawState.activity.label.slice(0, 80),
          title: rawState.activity.title.slice(0, 120),
        }
      : null;
  const width = finiteIntegerInRange(rawState.width, MIN_PET_WINDOW_SIZE, MAX_PET_WINDOW_SIZE);
  const height = finiteIntegerInRange(rawState.height, MIN_PET_WINDOW_SIZE, MAX_PET_WINDOW_SIZE);
  const columns = finiteIntegerInRange(rawState.columns, 1, 32);
  const rows = finiteIntegerInRange(rawState.rows, 1, 32);
  const row = finiteIntegerInRange(rawState.row, 0, 31);
  const frames = finiteIntegerInRange(rawState.frames, 1, 32);
  const durationMs = finiteIntegerInRange(rawState.durationMs, 0, 5_000);
  const x = finiteIntegerInRange(rawState.x, -100_000, 100_000);
  const y = finiteIntegerInRange(rawState.y, -100_000, 100_000);

  if (!spritesheetUrl || width === null || height === null || columns === null || rows === null) {
    return null;
  }
  if (row === null || frames === null || durationMs === null || x === null || y === null) {
    return null;
  }

  return {
    visible: rawState.visible === true,
    spritesheetUrl,
    displayName,
    description,
    animation,
    activity,
    row,
    frames,
    durationMs,
    width,
    height,
    columns,
    rows,
    x,
    y,
  };
}

function resolveOverlayLayout(state: DesktopPetOverlayState): PetOverlayLayout {
  // Desktop overlay shows the bare pet sprite — no dock, no boundaries, just the floating character.
  return {
    windowWidth: state.width,
    windowHeight: state.height + PET_GROUND_PADDING,
    petLeft: 0,
  };
}

function buildPetOverlayHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https: t3:; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
  <style>
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: transparent;
    }
    #root {
      position: relative;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }
    #pet {
      position: absolute;
      top: 0;
      left: var(--pet-left, 0px);
      width: var(--pet-width, 100vw);
      height: var(--pet-height, 100vh);
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      overflow: hidden;
      contain: layout paint style;
      filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.32));
      transition: transform 120ms ease;
    }
    #pet-strip {
      height: 100%;
      background-repeat: no-repeat;
      image-rendering: pixelated;
      transform: translate3d(0, 0, 0);
    }
    #pet-ground {
      position: absolute;
      left: calc(var(--pet-left, 0px) + var(--pet-width, 100vw) / 2);
      top: calc(var(--pet-height, 100vh) - 4px);
      width: calc(var(--pet-width, 100vw) * 0.7);
      height: 10px;
      transform: translateX(-50%);
      border-radius: 50%;
      background: radial-gradient(
        ellipse at center,
        rgba(0, 0, 0, 0.55) 0%,
        rgba(0, 0, 0, 0.32) 38%,
        rgba(0, 0, 0, 0) 72%
      );
      pointer-events: none;
      filter: blur(0.5px);
    }
    #pet.dragging {
      cursor: grabbing;
      transform: scale(1.03);
    }
    #pet.tap {
      transform: translateY(-8px);
    }
    /* Subtle pulse on the pet sprite when there's background activity, since the dock is intentionally hidden outside the app. */
    #pet.has-activity {
      animation: pet-activity-pulse 1800ms ease-in-out infinite;
    }
    #pet.has-activity[data-activity-kind="input-needed"] {
      animation-duration: 1100ms;
    }
    @keyframes pet-activity-pulse {
      0%,
      100% {
        filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.32));
      }
      50% {
        filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.32))
          drop-shadow(0 0 10px rgba(56, 189, 248, 0.55));
      }
    }
    #pet.has-activity[data-activity-kind="input-needed"] {
      animation-name: pet-activity-pulse-alert;
    }
    @keyframes pet-activity-pulse-alert {
      0%,
      100% {
        filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.32));
      }
      50% {
        filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.32))
          drop-shadow(0 0 12px rgba(245, 158, 11, 0.7));
      }
    }
    #pet-strip.animating {
      animation: pet-sprite-steps var(--pet-duration) steps(var(--pet-frames)) var(--pet-iterations);
      animation-fill-mode: var(--pet-fill-mode, none);
      will-change: transform;
    }
    @keyframes pet-sprite-steps {
      from {
        transform: translate3d(0, 0, 0);
      }
      to {
        transform: translate3d(var(--pet-sprite-x-end), 0, 0);
      }
    }
  </style>
</head>
<body>
  <div id="root">
    <div id="pet" role="img" aria-label="Codex pet"><div id="pet-strip"></div></div>
    <div id="pet-ground" aria-hidden="true"></div>
  </div>
  <script>
    const root = document.getElementById("root");
    const pet = document.getElementById("pet");
    const strip = document.getElementById("pet-strip");
    let state = null;
    let drag = null;
    let tapTimeout = 0;
    let animationKey = "";
    let dragFrame = 0;
    let pointerInteractive = true;

    function isLoopingAnimation(animation) {
      return animation !== "jumping" && animation !== "waving";
    }

    function flushDragMove() {
      dragFrame = 0;
      window.desktopBridge?.petOverlay?.dragMove();
    }

    function setPointerInteractive(nextInteractive) {
      if (pointerInteractive === nextInteractive) return;
      pointerInteractive = nextInteractive;
      window.desktopBridge?.petOverlay?.setPointerInteraction({ interactive: nextInteractive });
    }

    function isInsidePet(event) {
      const bounds = root.getBoundingClientRect();
      return (
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom
      );
    }

    async function showPetMenu(event) {
      event.preventDefault();
      event.stopPropagation();
      const clicked = await window.desktopBridge?.showContextMenu?.([
        { id: "close-pet", label: "Close Pet", destructive: true },
      ]);
      if (clicked === "close-pet") {
        await window.desktopBridge?.petOverlay?.close();
      }
    }

    function render() {
      if (!state) return;
      pet.setAttribute("aria-label", state.displayName + ": " + state.description);
      pet.title = state.displayName;
      pet.dataset.petAnimation = state.animation;
      root.style.setProperty("--pet-width", state.width + "px");
      root.style.setProperty("--pet-height", state.height + "px");
      root.style.setProperty("--pet-left", "0px");
      const hasActivity = state.activity != null;
      pet.classList.toggle("has-activity", hasActivity);
      if (hasActivity) {
        pet.dataset.activityKind = state.activity.kind;
      } else {
        pet.removeAttribute("data-activity-kind");
      }
      const loops = isLoopingAnimation(state.animation);
      const steps = loops ? state.frames : Math.max(1, state.frames - 1);
      strip.style.width = (state.width * state.columns) + "px";
      strip.style.backgroundImage = "url(" + JSON.stringify(state.spritesheetUrl) + ")";
      strip.style.backgroundSize = (state.width * state.columns) + "px " + (state.height * state.rows) + "px";
      strip.style.backgroundPosition = "0px " + (-state.row * state.height) + "px";
      strip.style.setProperty("--pet-duration", (state.frames * state.durationMs) + "ms");
      strip.style.setProperty("--pet-frames", String(steps));
      strip.style.setProperty("--pet-iterations", loops ? "infinite" : "1");
      strip.style.setProperty("--pet-fill-mode", loops ? "none" : "forwards");
      strip.style.setProperty("--pet-sprite-x-end", (-(loops ? state.frames : state.frames - 1) * state.width) + "px");

      const nextAnimationKey = [
        state.animation,
        state.row,
        state.frames,
        state.durationMs,
        state.width,
      ].join(":");
      if (nextAnimationKey === animationKey) return;
      animationKey = nextAnimationKey;
      strip.classList.remove("animating");
      if (state.durationMs <= 0 || state.frames <= 1) {
        strip.style.removeProperty("will-change");
        return;
      }
      void strip.offsetWidth;
      strip.classList.add("animating");
    }

    window.__setPetOverlayState = (nextState) => {
      state = nextState;
      render();
    };

    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setPointerInteractive(true);
      drag = {
        screenX: event.screenX,
        screenY: event.screenY,
        moved: 0,
      };
      pet.classList.add("dragging");
      pet.setPointerCapture(event.pointerId);
      window.desktopBridge?.petOverlay?.dragStart({
        pointerWindowX: event.clientX,
        pointerWindowY: event.clientY,
      });
    });

    pet.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const dx = Math.round(event.screenX - drag.screenX);
      const dy = Math.round(event.screenY - drag.screenY);
      if (dx === 0 && dy === 0) return;
      drag.screenX = event.screenX;
      drag.screenY = event.screenY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4 && !dragFrame) {
        dragFrame = window.requestAnimationFrame(flushDragMove);
      }
    });

    function finishPointer() {
      if (!drag) return;
      const wasTap = drag.moved <= 8;
      drag = null;
      pet.classList.remove("dragging");
      if (dragFrame) {
        window.cancelAnimationFrame(dragFrame);
        dragFrame = 0;
        window.desktopBridge?.petOverlay?.dragMove();
      }
      window.desktopBridge?.petOverlay?.dragEnd();
      if (!wasTap) return;
      window.clearTimeout(tapTimeout);
      pet.classList.add("tap");
      tapTimeout = window.setTimeout(() => pet.classList.remove("tap"), 180);
    }

    pet.addEventListener("pointerup", finishPointer);
    pet.addEventListener("pointercancel", finishPointer);
    pet.addEventListener("contextmenu", showPetMenu);
    pet.addEventListener("dblclick", showPetMenu);
    activity.addEventListener("contextmenu", showPetMenu);
    pet.addEventListener("pointerenter", () => setPointerInteractive(true));
    pet.addEventListener("pointerleave", () => {
      if (!drag) setPointerInteractive(false);
    });
    document.addEventListener("mousemove", (event) => {
      if (drag) return;
      setPointerInteractive(isInsidePet(event));
    });
  </script>
</body>
</html>`;
}

export class DesktopPetOverlayController {
  private window: BrowserWindow | null = null;
  private loadPromise: Promise<void> | null = null;
  private lastState: DesktopPetOverlayState | null = null;
  private lastEmittedPosition: { x: number; y: number } | null = null;
  private dragState: OverlayDragState | null = null;
  private pointerInteractive = true;
  private mousePassthroughEnabled = false;

  constructor(
    private readonly input: {
      preloadPath: string;
      resolveAssetUrl: ResolveAssetUrl;
      onMoved: OnMoved;
    },
  ) {}

  async setState(input: unknown): Promise<void> {
    const state = normalizePetState(input, this.input.resolveAssetUrl);
    if (!state || !state.visible) {
      if (state) {
        this.lastState = state;
      }
      this.hide();
      return;
    }

    this.lastState = state;
    await this.showState(state);
  }

  async showLastState(): Promise<void> {
    if (!this.lastState) return;
    await this.showState({ ...this.lastState, visible: true });
  }

  private async showState(state: DesktopPetOverlayState): Promise<void> {
    const window = this.ensureWindow();
    const layout = resolveOverlayLayout(state);
    const wasVisible = window.isVisible();
    const nextBounds = {
      x: state.x - layout.petLeft,
      y: state.y,
      width: layout.windowWidth,
      height: layout.windowHeight,
    };
    const currentBounds = window.getBounds();
    this.lastEmittedPosition = { x: state.x, y: state.y };
    if (
      currentBounds.x !== nextBounds.x ||
      currentBounds.y !== nextBounds.y ||
      currentBounds.width !== nextBounds.width ||
      currentBounds.height !== nextBounds.height
    ) {
      window.setBounds(nextBounds);
    }
    if (!wasVisible) {
      window.setAlwaysOnTop(true, "floating", 1);
      this.makeVisibleOnEveryWorkspace(window);
      this.pointerInteractive = true;
      this.applyPointerInteractivityPolicy();
      window.moveTop();
      window.showInactive();
    }

    await this.waitForLoad();
    if (window.isDestroyed()) return;
    await window.webContents
      .executeJavaScript(`window.__setPetOverlayState(${JSON.stringify(state)})`, true)
      .catch(() => undefined);
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide();
    }
  }

  close(): void {
    this.lastState = this.lastState ? { ...this.lastState, visible: false } : null;
    this.hide();
  }

  moveBy(input: DesktopPetOverlayMoveDelta | null | undefined): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (typeof input !== "object" || input === null) return;
    const dx = finiteIntegerInRange(input.dx, -2_000, 2_000) ?? 0;
    const dy = finiteIntegerInRange(input.dy, -2_000, 2_000) ?? 0;
    if (dx === 0 && dy === 0) return;
    const bounds = window.getBounds();
    window.setPosition(bounds.x + dx, bounds.y + dy);
  }

  startDrag(input: DesktopPetOverlayDragStartInput | null | undefined): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    if (typeof input !== "object" || input === null) return;
    const pointerWindowX = finiteIntegerInRange(
      input.pointerWindowX,
      -MAX_PET_WINDOW_SIZE,
      MAX_PET_WINDOW_SIZE,
    );
    const pointerWindowY = finiteIntegerInRange(
      input.pointerWindowY,
      -MAX_PET_WINDOW_SIZE,
      MAX_PET_WINDOW_SIZE,
    );
    if (pointerWindowX === null || pointerWindowY === null) return;
    this.dragState = {
      pointerAnchorX: pointerWindowX,
      pointerAnchorY: pointerWindowY,
      hasMoved: false,
    };
    this.pointerInteractive = true;
    this.applyPointerInteractivityPolicy();
    window.moveTop();
  }

  moveDrag(): void {
    const dragState = this.dragState;
    if (!dragState) return;
    dragState.hasMoved = true;
    this.moveDragToCurrentCursor(dragState);
  }

  endDrag(): void {
    const dragState = this.dragState;
    if (dragState?.hasMoved) {
      this.moveDragToCurrentCursor(dragState);
    }
    this.dragState = null;
    this.applyPointerInteractivityPolicy();
  }

  setPointerInteraction(input: DesktopPetOverlayPointerInteractionInput | null | undefined): void {
    if (typeof input !== "object" || input === null) return;
    const nextInteractive = input.interactive === true;
    if (this.pointerInteractive === nextInteractive) return;
    this.pointerInteractive = nextInteractive;
    this.applyPointerInteractivityPolicy();
  }

  isCursorOverOverlay(): boolean {
    const window = this.window;
    if (!window || window.isDestroyed() || !window.isVisible()) return false;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    return (
      cursor.x >= bounds.x &&
      cursor.x <= bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y <= bounds.y + bounds.height
    );
  }

  dispose(): void {
    this.dragState = null;
    this.pointerInteractive = true;
    this.mousePassthroughEnabled = false;
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.loadPromise = null;
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const window = new BrowserWindow({
      width: 96,
      height: 104,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: true,
      title: "Codex Pet",
      backgroundColor: "#00000000",
      webPreferences: {
        preload: this.input.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.setMenu(null);
    window.setAlwaysOnTop(true, "floating", 1);
    this.makeVisibleOnEveryWorkspace(window);
    window.on("move", () => {
      const bounds = window.getBounds();
      const state = this.lastState;
      const petLeft = state ? resolveOverlayLayout(state).petLeft : 0;
      this.emitMoved({ x: bounds.x + petLeft, y: bounds.y });
    });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.loadPromise = null;
        this.dragState = null;
      }
    });

    this.window = window;
    this.loadPromise = new Promise((resolve) => {
      window.webContents.once("did-finish-load", () => resolve());
    });
    void window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(buildPetOverlayHtml())}`,
    );
    return window;
  }

  private makeVisibleOnEveryWorkspace(window: BrowserWindow): void {
    if (process.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      } as Electron.VisibleOnAllWorkspacesOptions);
      return;
    }
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  private moveDragToCurrentCursor(dragState: OverlayDragState): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;

    // Follow the OS cursor from the main process, matching Codex's overlay drag model.
    const cursor = screen.getCursorScreenPoint();
    const nextX = Math.round(cursor.x - dragState.pointerAnchorX);
    const nextY = Math.round(cursor.y - dragState.pointerAnchorY);
    const bounds = window.getBounds();
    if (bounds.x === nextX && bounds.y === nextY) return;
    window.setPosition(nextX, nextY);
  }

  private emitMoved(position: { x: number; y: number }): void {
    if (this.lastEmittedPosition?.x === position.x && this.lastEmittedPosition?.y === position.y) {
      return;
    }
    this.lastEmittedPosition = position;
    this.input.onMoved(position);
  }

  private applyPointerInteractivityPolicy(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;

    const shouldPassThrough = !this.pointerInteractive && this.dragState === null;
    if (this.mousePassthroughEnabled === shouldPassThrough) return;
    this.mousePassthroughEnabled = shouldPassThrough;
    if (shouldPassThrough) {
      window.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    window.setIgnoreMouseEvents(false);
  }

  private async waitForLoad(): Promise<void> {
    await this.loadPromise;
  }
}
