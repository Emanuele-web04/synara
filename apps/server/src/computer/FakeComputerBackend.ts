import type {
  ComputerApp,
  ComputerAvailability,
  ComputerBuildSignature,
  ComputerCapabilities,
  ComputerHealth,
  ComputerId,
  ComputerInputModifier,
  ComputerLaunchAppResult,
  ComputerPermission,
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerScreenshot,
  ComputerState,
  ComputerUiNode,
  ComputerVerifyStateResult,
  ComputerWindow,
  ComputerZoomResult,
} from "@synara/contracts";

import {
  ComputerBackendError,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  intersectComputerRects,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
  type ComputerBackendEventListener,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
  type ComputerStreamFrame,
} from "./ComputerBackend.ts";
import { requireWindowBounds } from "./computerGeometry.ts";

const FAKE_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** A real 1×1 JPEG: zoom returns JPEG, not the PNG the ordinary captures carry. */
const FAKE_ZOOM_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKwA//9k=";

/**
 * How many calls the fake remembers. A long-running server that leaves the
 * fake wired in would otherwise grow this array for the life of the process;
 * tests only ever look at recent calls, so the oldest entries are dropped.
 */
const MAX_RECORDED_CALLS = 1_000;

/**
 * What the fake actually simulates. It enumerates windows with bounds and a
 * stacking order, captures, takes input, holds a clipboard, and focuses and
 * raises — so those are all true. `ghostCursor` is true because the fake moves
 * a pointer nothing else shares. `visibleDesktop` is false — a fake desktop
 * renders nowhere, so the pane is its only view, which also keeps the pane
 * auto-open path exercised under this backend.
 */
const DEFAULT_FAKE_CAPABILITIES: ComputerCapabilities = {
  windows: true,
  windowBounds: true,
  stacking: true,
  capture: true,
  input: true,
  clipboard: true,
  focus: true,
  raise: true,
  ghostCursor: true,
  visibleDesktop: false,
};

export interface FakeComputerCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeComputerBackendOptions {
  readonly computerId?: string;
  readonly availability?: ComputerAvailability;
  readonly health?: ComputerHealth;
  /**
   * Overrides what the fake claims to be able to do, so a test can drive the
   * capability-gated refusals a less capable backend produces without
   * standing up a real display server.
   */
  readonly capabilities?: ComputerCapabilities;
  readonly screenSize?: ComputerScreenSize;
  readonly windows?: readonly ComputerWindow[];
  /**
   * The process list `listApps` answers. Defaults to one running app per
   * default window, so the fixture mirrors what the real driver reports
   * without a test having to name any.
   */
  readonly apps?: readonly ComputerApp[];
  readonly root?: ComputerUiNode;
  readonly now?: () => string;
}

export class FakeComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;
  readonly calls: FakeComputerCall[] = [];

  private currentAvailability: ComputerAvailability;
  private currentMissingPermissions: readonly ComputerPermission[] = [];
  private currentBuildSignature: ComputerBuildSignature | undefined;
  private currentHealth: ComputerHealth;
  private readonly currentCapabilities: ComputerCapabilities;
  private currentScreenSize: ComputerScreenSize;
  private currentWindows: ComputerWindow[];
  private currentApps: ComputerApp[];
  private currentRoot: ComputerUiNode;
  private readonly now: () => string;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();
  private frameListener: ComputerFrameListener | null = null;
  private nextSequence = 1;
  private nextPid = 5_000;
  private clipboardText = "";
  private failures = new Map<string, Error>();
  private readonly queuedScreenshots: string[] = [];
  /**
   * When false the frame call still succeeds but the window keeps its old
   * bounds — the readback-mismatch shape a driver that dispatched without the
   * move landing produces.
   */
  private frameApplies = true;
  private readonly refusedMenuPaths = new Map<string, Error>();
  private verifySatisfied = true;
  private disposed = false;

  constructor(options: FakeComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? "desktop") as ComputerId;
    this.currentAvailability = options.availability ?? {
      kind: "available",
      backend: "fake",
    };
    this.currentHealth = options.health ?? {
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 0,
      captureAvailable: true,
    };
    this.currentCapabilities = options.capabilities ?? DEFAULT_FAKE_CAPABILITIES;
    this.currentScreenSize = options.screenSize ?? { width: 1_920, height: 1_080, scale: 1 };
    this.currentWindows = [...(options.windows ?? defaultWindows())];
    this.currentApps = [...(options.apps ?? defaultApps(this.currentWindows))];
    this.currentRoot = options.root ?? defaultRoot(this.currentScreenSize, this.currentWindows);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async availability(): Promise<ComputerAvailability> {
    this.record("availability");
    this.throwIfFailed("availability");
    return this.currentAvailability;
  }

  /**
   * Recorded under its own name so a test can prove which of the two a caller
   * used: the whole point of the passive probe is that the paths which must not
   * touch the display server can be shown not to.
   */
  async probeAvailability(): Promise<ComputerAvailability> {
    this.record("probeAvailability");
    this.throwIfFailed("probeAvailability");
    return this.currentAvailability;
  }

  /** Not recorded as a call: reading health is a getter, not a backend operation. */
  health(): ComputerHealth {
    return this.currentHealth;
  }

  /** Not recorded either, and for the same reason. */
  capabilities(): ComputerCapabilities {
    return this.currentCapabilities;
  }

  /**
   * No OS withholds anything from the fake. Declared rather than omitted so a
   * test can substitute a backend that *is* missing a grant without the type
   * complaining about a property the interface only optionally has.
   */
  async missingPermissions(): Promise<readonly ComputerPermission[]> {
    return this.currentMissingPermissions;
  }

  setMissingPermissions(permissions: readonly ComputerPermission[]): void {
    this.currentMissingPermissions = [...permissions];
  }

  /**
   * Undefined by default: the fake is not a signed binary and has no signature
   * to report, and reporting `signed` would be a lie a card could act on.
   * Declared for the same reason `missingPermissions` is — so a test can
   * substitute a build that *is* ad-hoc.
   */
  buildSignature(): ComputerBuildSignature | undefined {
    return this.currentBuildSignature;
  }

  setBuildSignature(signature: ComputerBuildSignature | undefined): void {
    this.currentBuildSignature = signature;
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    this.record("listWindows");
    this.throwIfFailed("listWindows");
    return this.currentWindows.map((window) => ({
      ...window,
      ...(window.bounds ? { bounds: { ...window.bounds } } : {}),
    }));
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    this.record("getScreenSize");
    this.throwIfFailed("getScreenSize");
    return { ...this.currentScreenSize };
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeTree?: boolean;
  }): Promise<ComputerState> {
    this.record("getState", options);
    this.throwIfFailed("getState");
    const screenshot = options.includeScreenshot
      ? this.screenshotOfRegion(this.workspaceRect())
      : undefined;
    return {
      computerId: this.computerId,
      windows: await this.listWindows(),
      screenSize: { ...this.currentScreenSize },
      root: this.currentRoot,
      ...(screenshot ? { screenshot } : {}),
      capturedAt: this.now(),
    } as ComputerState;
  }

  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    this.record("captureScreenshot", request);
    this.throwIfFailed("captureScreenshot");
    const region = intersectComputerRects(this.captureRect(request), this.workspaceRect());
    if (!region) {
      throw new ComputerBackendError("The capture request does not overlap the fake workspace.");
    }
    return this.screenshotOfRegion(region, request.maxDimension);
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    this.record("launchApp", app, args);
    this.throwIfFailed("launchApp");
    const id = `fake-window-${this.currentWindows.length + 1}`;
    const window: ComputerWindow = {
      id,
      title: app,
      appName: app,
      pid: this.nextPid++,
      bounds: { x: 120, y: 80, width: 900, height: 700 },
      focused: true,
      minimized: false,
      visible: true,
    };
    this.currentWindows = [
      ...this.currentWindows.map((item) => ({ ...item, focused: false })),
      window,
    ];
    this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
    this.emit({ type: "windows-changed", windows: this.currentWindows });
    return { computerId: this.computerId, app, window } as ComputerLaunchAppResult;
  }

  async listApps(): Promise<readonly ComputerApp[]> {
    this.record("listApps");
    this.throwIfFailed("listApps");
    return this.currentApps.map((app) => ({ ...app }));
  }

  /**
   * The fake's readback is its own window list: applying the frame is what a
   * confirmed verification looks like, and `setFrameApplies(false)` produces
   * the dispatched-but-unverified result a real backend reports when the move
   * did not land.
   */
  async setWindowFrame(
    windowId: string,
    frame: ComputerRect,
  ): Promise<ComputerBackendActionResult> {
    this.record("setWindowFrame", windowId, frame);
    this.throwIfFailed("setWindowFrame");
    if (!Object.values(frame).every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) {
      throw new ComputerBackendError("Window frame needs finite geometry and positive size.");
    }
    const index = this.currentWindows.findIndex((window) => window.id === windowId);
    if (index === -1) {
      throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
    }
    if (!this.frameApplies) {
      return {
        windowId,
        deliveryPath: "fake-frame",
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      };
    }
    this.currentWindows[index] = { ...this.currentWindows[index]!, bounds: { ...frame } };
    this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
    this.emit({ type: "windows-changed", windows: this.currentWindows });
    return {
      windowId,
      deliveryPath: "fake-frame",
      verified: "confirmed",
      effect: "verified",
    };
  }

  async invokeMenu(
    windowId: string,
    path: readonly string[],
  ): Promise<ComputerBackendActionResult> {
    this.record("invokeMenu", windowId, path);
    this.throwIfFailed("invokeMenu");
    if (!this.currentWindows.some((window) => window.id === windowId)) {
      throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
    }
    if (path.length === 0 || path.some((segment) => segment.trim().length === 0)) {
      throw new ComputerBackendError("A menu path needs at least one non-empty title.");
    }
    const refusal = this.refusedMenuPaths.get(path.join(""));
    if (refusal) throw refusal;
    return {
      windowId,
      deliveryPath: "fake-menu",
      verified: "confirmed",
      effect: "verified",
    };
  }

  async verifyState(
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ): Promise<ComputerVerifyStateResult> {
    this.record("verifyState", windowId, expect);
    this.throwIfFailed("verifyState");
    if (!this.currentWindows.some((window) => window.id === windowId)) {
      throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
    }
    return {
      status: this.verifySatisfied ? "satisfied" : "unsatisfied",
      stable: true,
      samples: 1,
      elapsedMs: 0,
      predicates: expect.map((_, index) => ({
        index,
        status: this.verifySatisfied ? "satisfied" : "unsatisfied",
        unknown_reason: null,
        observed_json: "{}",
      })),
    };
  }

  async zoomWindow(windowId: string, region: ComputerRect): Promise<ComputerZoomResult> {
    this.record("zoomWindow", windowId, region);
    this.throwIfFailed("zoomWindow");
    const window = this.currentWindows.find((candidate) => candidate.id === windowId);
    if (!window) {
      throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
    }
    const bounds = requireWindowBounds(window, "a zoom capture");
    if (
      !Object.values(region).every(Number.isFinite) ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.width > bounds.width ||
      region.y + region.height > bounds.height
    ) {
      throw new ComputerBackendError("The zoom region lies outside the target window.");
    }
    return {
      mimeType: "image/jpeg",
      width: 1,
      height: 1,
      sizeBytes: Buffer.from(FAKE_ZOOM_BASE64, "base64").byteLength,
      bytesBase64: FAKE_ZOOM_BASE64,
      windowId,
      capturedAt: this.now(),
    };
  }

  async killApp(pid: number): Promise<ComputerBackendActionResult> {
    this.record("killApp", pid);
    this.throwIfFailed("killApp");
    const owned = this.currentWindows.filter((window) => window.pid === pid);
    if (owned.length === 0) {
      throw new ComputerBackendError(`No desktop window belongs to pid ${pid}.`);
    }
    this.currentWindows = this.currentWindows.filter((window) => window.pid !== pid);
    this.currentApps = this.currentApps.map((app) =>
      app.pid === pid ? { ...app, running: false, active: false, pid: 0 } : app,
    );
    this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
    this.emit({ type: "windows-changed", windows: this.currentWindows });
    return {
      windowId: owned[0]!.id,
      deliveryPath: "fake-kill",
      verified: "confirmed",
      effect: "verified",
    };
  }

  /** Makes the next setWindowFrame report the dispatched-unverified shape. */
  setFrameApplies(applies: boolean): void {
    this.frameApplies = applies;
  }

  /** Configures a persistent refusal for one menu path, like a disabled item. */
  refuseMenuPath(path: readonly string[], error: Error): void {
    this.refusedMenuPaths.set(path.join(""), error);
  }

  setVerifySatisfied(satisfied: boolean): void {
    this.verifySatisfied = satisfied;
  }

  async raiseWindow(windowId: string): Promise<void> {
    this.record("raiseWindow", windowId);
    this.throwIfFailed("raiseWindow");
  }

  async focusWindow(windowId: string): Promise<void> {
    this.record("focusWindow", windowId);
    this.throwIfFailed("focusWindow");
    // The pinned target is the only window that
    // reports focused, so clearing and re-pinning behave like the real seat.
    this.currentWindows = this.currentWindows.map((item) => ({
      ...item,
      focused: item.id === windowId,
    }));
  }

  async clearFocusWindow(): Promise<void> {
    this.record("clearFocusWindow");
    this.throwIfFailed("clearFocusWindow");
    // No pinned target means no window reports
    // focused — the blind spot behind the untargeted-scroll regression.
    this.currentWindows = this.currentWindows.map((item) => ({ ...item, focused: false }));
  }

  async click(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction("click", point, modifiers);
  }

  async doubleClick(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction("doubleClick", point, modifiers);
  }

  async tripleClick(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction("tripleClick", point, modifiers);
  }

  async rightClick(
    point: ComputerPoint,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    return await this.pointerAction("rightClick", point, modifiers);
  }

  async moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.pointerAction("moveCursor", point);
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult> {
    this.record("drag", from, to, durationMs);
    this.throwIfFailed("drag");
    this.validatePoint(from);
    this.validatePoint(to);
    return { point: to };
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
    _windowId?: string,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    // Recorded only when present, so every existing assertion on a plain
    // scroll keeps matching its three-argument shape.
    if (modifiers && modifiers.length > 0) this.record("scroll", point, deltaX, deltaY, modifiers);
    else this.record("scroll", point, deltaX, deltaY);
    this.throwIfFailed("scroll");
    if (point) this.validatePoint(point);
    return point ? { point } : {};
  }

  async typeText(text: string): Promise<ComputerBackendActionResult> {
    this.record("typeText", text);
    this.throwIfFailed("typeText");
    return { value: text };
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    this.record("pressKey", key);
    this.throwIfFailed("pressKey");
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    this.record("hotkey", keys);
    this.throwIfFailed("hotkey");
    return {};
  }

  /** One in-memory string stands in for the shared system clipboard. */
  async readClipboard(): Promise<string> {
    this.record("readClipboard");
    this.throwIfFailed("readClipboard");
    return this.clipboardText;
  }

  async writeClipboard(text: string): Promise<void> {
    this.record("writeClipboard", text);
    this.throwIfFailed("writeClipboard");
    this.clipboardText = text;
  }

  async setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    this.record("setValue", target, value);
    this.throwIfFailed("setValue");
    this.currentRoot = replaceNodeValue(this.currentRoot, target.node, value);
    return { point: target.point, value };
  }

  async performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult> {
    this.record("performAction", target, action);
    this.throwIfFailed("performAction");
    return { point: target.point, value: action };
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    this.record("attachStream");
    this.throwIfFailed("attachStream");
    this.frameListener = listener;
    this.emitFrame(true, true);
    this.emitFrame(true, false);
  }

  async detachStream(): Promise<void> {
    this.record("detachStream");
    this.throwIfFailed("detachStream");
    this.frameListener = null;
  }

  async requestKeyframe(): Promise<void> {
    this.record("requestKeyframe");
    this.throwIfFailed("requestKeyframe");
    if (this.frameListener) {
      this.emitFrame(true, true);
      this.emitFrame(true, false);
    }
  }

  async dispose(): Promise<void> {
    this.record("dispose");
    this.disposed = true;
    this.frameListener = null;
    this.eventListeners.clear();
  }

  emitFrame(keyframe = false, codecConfig = false, data = Uint8Array.of(0x01)): void {
    if (!this.frameListener || this.disposed) return;
    const frame: ComputerStreamFrame = {
      sequence: this.nextSequence++,
      timestampMs: Date.now(),
      keyframe,
      codecConfig,
      data,
    };
    this.frameListener(frame);
  }

  emitWindowsChanged(windows: readonly ComputerWindow[]): void {
    this.currentWindows = [...windows];
    this.emit({ type: "windows-changed", windows: this.currentWindows });
  }

  /** Drives a supervision transition for tests. */
  emitHealthChanged(health: ComputerHealth): void {
    this.currentHealth = health;
    this.emit({ type: "health-changed", health });
  }

  setAvailability(availability: ComputerAvailability): void {
    this.currentAvailability = availability;
  }

  setScreenSize(screenSize: ComputerScreenSize): void {
    this.currentScreenSize = screenSize;
  }

  failNext(method: string, error: Error = new ComputerBackendError(`${method} failed`)): void {
    this.failures.set(method, error);
  }

  /**
   * Hands the next captures these exact PNG bytes, in order, so a test can make
   * two captures of one window differ — which is what any before/after
   * comparison needs and what the single fixed fixture cannot express. Captures
   * past the end of the queue return the fixture again.
   */
  queueScreenshots(bytesBase64List: readonly string[]): void {
    this.queuedScreenshots.push(...bytesBase64List);
  }

  callsFor(method: string): readonly FakeComputerCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private captureRect(request: ComputerCaptureRequest): ComputerRect {
    if (request.kind !== "window") return request.region;
    const window = this.currentWindows.find((candidate) => candidate.id === request.windowId);
    if (!window) {
      throw new ComputerBackendError(
        `No desktop window has id ${JSON.stringify(request.windowId)}.`,
      );
    }
    return requireWindowBounds(window, "a window screenshot");
  }

  private workspaceRect(): ComputerRect {
    return {
      x: 0,
      y: 0,
      width: this.currentScreenSize.width,
      height: this.currentScreenSize.height,
    };
  }

  /**
   * Mirrors the real backend's contract: the reported region is the rect that
   * was captured, and the scale is the screenshot's pixels per logical pixel
   * after `maxDimension` downscaling.
   */
  private screenshotOfRegion(region: ComputerRect, maxDimension?: number): ComputerScreenshot {
    const limit = maxDimension ?? DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION;
    const scale = Math.min(1, limit / Math.max(region.width, region.height));
    const bytesBase64 = this.queuedScreenshots.shift() ?? FAKE_SCREENSHOT_BASE64;
    return {
      mimeType: "image/png",
      width: Math.max(1, Math.round(region.width * scale)),
      height: Math.max(1, Math.round(region.height * scale)),
      sizeBytes: Buffer.from(bytesBase64, "base64").byteLength,
      bytesBase64,
      region,
      scale,
      capturedAt: this.now(),
    };
  }

  private async pointerAction(
    method: "click" | "doubleClick" | "tripleClick" | "rightClick" | "moveCursor",
    point: ComputerPoint,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    // Recorded only when present, so every existing assertion on a plain
    // pointer call keeps matching its two-argument shape.
    if (modifiers && modifiers.length > 0) this.record(method, point, modifiers);
    else this.record(method, point);
    this.throwIfFailed(method);
    this.validatePoint(point);
    return { point };
  }

  private validatePoint(point: ComputerPoint): void {
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x >= this.currentScreenSize.width ||
      point.y >= this.currentScreenSize.height
    ) {
      throw new ComputerBackendError(`Point (${point.x}, ${point.y}) is outside the fake screen`);
    }
  }

  private record(method: string, ...args: readonly unknown[]): void {
    this.calls.push({ method, args });
    if (this.calls.length > MAX_RECORDED_CALLS) {
      this.calls.splice(0, this.calls.length - MAX_RECORDED_CALLS);
    }
  }

  private throwIfFailed(method: string): void {
    const error = this.failures.get(method);
    if (!error) return;
    this.failures.delete(method);
    throw error;
  }

  private emit(event: ComputerBackendEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // One observer cannot prevent the backend's remaining observers.
      }
    }
  }
}

function defaultWindows(): ComputerWindow[] {
  return [
    {
      id: "fake-terminal",
      title: "Terminal",
      appName: "org.kde.konsole",
      pid: 1_001,
      bounds: { x: 40, y: 40, width: 960, height: 720 },
      focused: true,
      minimized: false,
      visible: true,
    },
    {
      id: "fake-calculator",
      title: "Calculator",
      appName: "org.kde.kcalc",
      pid: 1_002,
      bounds: { x: 1_050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
    },
  ];
}

function defaultApps(windows: readonly ComputerWindow[]): ComputerApp[] {
  return windows.flatMap((window) => {
    if (window.pid === undefined || !window.appName) return [];
    return [
      {
        pid: window.pid,
        name: window.title || window.appName,
        bundleId: window.appName,
        running: true,
        active: window.focused,
        windowCount: 1,
      },
    ];
  });
}

function defaultRoot(
  screenSize: ComputerScreenSize,
  windows: readonly ComputerWindow[],
): ComputerUiNode {
  const calculator = windows.find((window) => window.id === "fake-calculator") ?? windows[0];
  const windowId = calculator?.id ?? null;
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "Fake desktop",
    frame: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children: [
      {
        role: "window",
        label: calculator?.title ?? "Calculator",
        value: null,
        description: null,
        frame: calculator?.bounds ?? { x: 20, y: 20, width: 400, height: 400 },
        activationPoint: null,
        onScreen: true,
        windowId,
        children: [
          {
            role: "button",
            label: "Calculate",
            value: null,
            description: "Calculate",
            frame: {
              x: (calculator?.bounds?.x ?? 20) + 40,
              y: (calculator?.bounds?.y ?? 20) + 80,
              width: 180,
              height: 56,
            },
            activationPoint: null,
            onScreen: true,
            windowId,
            children: [],
          },
          {
            role: "text-field",
            label: "Display",
            value: "0",
            description: "Calculator display",
            frame: {
              x: (calculator?.bounds?.x ?? 20) + 40,
              y: (calculator?.bounds?.y ?? 20) + 20,
              width: 280,
              height: 48,
            },
            activationPoint: {
              x: (calculator?.bounds?.x ?? 20) + 180,
              y: (calculator?.bounds?.y ?? 20) + 44,
            },
            onScreen: true,
            windowId,
            children: [],
          },
        ],
      },
    ],
  };
}

function replaceNodeValue(
  root: ComputerUiNode,
  target: ComputerUiNode,
  value: string,
): ComputerUiNode {
  return {
    ...root,
    value: root === target ? value : root.value,
    children: root.children.map((child) => replaceNodeValue(child, target, value)),
  };
}
