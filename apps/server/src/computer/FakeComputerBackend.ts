import type {
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
  ComputerWindow,
} from "@synara/contracts";

import {
  ComputerBackendError,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  intersectComputerRects,
  type ComputerAgentDialect,
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
import { fakeDefaultWindows } from "./computerTestFixtures.ts";
import {
  assertHotkeyChord,
  assertKeyName,
  assertSemanticAction,
  assertTypeableText,
} from "./inputVocabulary.ts";

const FAKE_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

/** What a real backend reports before anything has connected it. */
const UNCONNECTED_HEALTH: ComputerHealth = {
  status: "unavailable",
  consecutiveFailures: 0,
  reconnects: 0,
  captureAvailable: false,
};

const CONNECTED_HEALTH: ComputerHealth = {
  status: "connected",
  consecutiveFailures: 0,
  reconnects: 0,
  captureAvailable: true,
};

export interface FakeComputerBackendOptions {
  readonly computerId?: string;
  readonly availability?: ComputerAvailability;
  /**
   * Pins health for the fake's whole life. Without it the fake behaves like
   * a real backend: `unavailable` until the first establishing call connects
   * it, then `connected`, announced through `health-changed`.
   */
  readonly health?: ComputerHealth;
  /** Which desktop family's vocabulary the fake refuses input outside of. Defaults to linux. */
  readonly agentDialect?: ComputerAgentDialect;
  /**
   * Overrides what the fake claims to be able to do, so a test can drive the
   * capability-gated refusals a less capable backend produces without
   * standing up a real display server.
   */
  readonly capabilities?: ComputerCapabilities;
  readonly screenSize?: ComputerScreenSize;
  readonly windows?: readonly ComputerWindow[];
  readonly root?: ComputerUiNode;
  readonly now?: () => string;
}

export class FakeComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;
  readonly agentDialect: ComputerAgentDialect;
  readonly calls: FakeComputerCall[] = [];

  private currentAvailability: ComputerAvailability;
  private readonly pinnedHealth: boolean;
  /** Set by the first establishing call; later health is whatever a test drives. */
  private connected = false;
  private currentMissingPermissions: readonly ComputerPermission[] = [];
  private currentBuildSignature: ComputerBuildSignature | undefined;
  private currentHealth: ComputerHealth;
  private readonly currentCapabilities: ComputerCapabilities;
  private currentScreenSize: ComputerScreenSize;
  private currentWindows: ComputerWindow[];
  private currentRoot: ComputerUiNode;
  private readonly now: () => string;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();
  private frameListener: ComputerFrameListener | null = null;
  private nextSequence = 1;
  private clipboardText = "";
  private failures = new Map<string, Error>();
  private readonly queuedScreenshots: string[] = [];
  private disposed = false;

  constructor(options: FakeComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? "desktop") as ComputerId;
    this.currentAvailability = options.availability ?? {
      kind: "available",
      backend: "fake",
    };
    this.pinnedHealth = options.health !== undefined;
    this.currentHealth = options.health ?? UNCONNECTED_HEALTH;
    this.agentDialect = options.agentDialect ?? "linux";
    this.currentCapabilities = options.capabilities ?? DEFAULT_FAKE_CAPABILITIES;
    this.currentScreenSize = options.screenSize ?? { width: 1_920, height: 1_080, scale: 1 };
    this.currentWindows = [...(options.windows ?? fakeDefaultWindows())];
    this.currentRoot = options.root ?? defaultRoot(this.currentScreenSize, this.currentWindows);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async availability(): Promise<ComputerAvailability> {
    this.engage("availability");
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
    this.engage("listWindows");
    return this.currentWindows.map((window) => ({
      ...window,
      ...(window.bounds ? { bounds: { ...window.bounds } } : {}),
    }));
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    this.engage("getScreenSize");
    return { ...this.currentScreenSize };
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeTree?: boolean;
  }): Promise<ComputerState> {
    this.engage("getState", options);
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
    this.engage("captureScreenshot", request);
    const region = intersectComputerRects(this.captureRect(request), this.workspaceRect());
    if (!region) {
      throw new ComputerBackendError("The capture request does not overlap the fake workspace.");
    }
    return this.screenshotOfRegion(region, request.maxDimension);
  }

  /**
   * Launches like a real backend: the process is started and its window turns
   * up a moment later through `windows-changed`, so the result carries no
   * window. A caller that wants it waits for it, as the manager does.
   */
  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    this.engage("launchApp", app, args);
    const id = `fake-window-${this.currentWindows.length + 1}`;
    const window: ComputerWindow = {
      id,
      title: app,
      appName: app,
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
    return { computerId: this.computerId, app, window: null } as ComputerLaunchAppResult;
  }

  async raiseWindow(windowId: string): Promise<void> {
    this.engage("raiseWindow", windowId);
  }

  async focusWindow(windowId: string): Promise<void> {
    this.engage("focusWindow", windowId);
    // The pinned target is the only window that
    // reports focused, so clearing and re-pinning behave like the real seat.
    this.currentWindows = this.currentWindows.map((item) => ({
      ...item,
      focused: item.id === windowId,
    }));
  }

  async clearFocusWindow(): Promise<void> {
    this.engage("clearFocusWindow");
    // No pinned target means no window reports
    // focused — the blind spot behind the untargeted-scroll regression.
    this.currentWindows = this.currentWindows.map((item) => ({ ...item, focused: false }));
  }

  /**
   * Recorded under its own name, so a test can prove the lease handoff reset
   * the seat rather than merely clearing focus. Its visible effect on the fake
   * is the same as a clear: nothing is aimed afterwards.
   */
  async resetInputDelivery(): Promise<void> {
    this.engage("resetInputDelivery");
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
    this.engage("drag", from, to, durationMs);
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
    if (modifiers && modifiers.length > 0) this.engage("scroll", point, deltaX, deltaY, modifiers);
    else this.engage("scroll", point, deltaX, deltaY);
    if (point) this.validatePoint(point);
    return point ? { point } : {};
  }

  /** Validated through the same vocabulary the real backends refuse against. */
  async typeText(text: string): Promise<ComputerBackendActionResult> {
    this.engage("typeText", text);
    assertTypeableText(text);
    return { value: text };
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    this.engage("pressKey", key);
    assertKeyName(key);
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    this.engage("hotkey", keys);
    assertHotkeyChord(keys);
    return {};
  }

  /** One in-memory string stands in for the shared system clipboard. */
  async readClipboard(): Promise<string> {
    this.engage("readClipboard");
    return this.clipboardText;
  }

  async writeClipboard(text: string): Promise<void> {
    this.engage("writeClipboard", text);
    this.clipboardText = text;
  }

  async setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    this.engage("setValue", target, value);
    this.currentRoot = replaceNodeValue(this.currentRoot, target.node, value);
    return { point: target.point, value };
  }

  async performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult> {
    this.engage("performAction", target, action);
    assertSemanticAction(this.agentDialect, action);
    return { point: target.point, value: action };
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Attaching only opens the tap, as on a real backend: frames arrive when the
   * compositor produces them, or when a keyframe is asked for. A test that
   * wants frames asks with `requestKeyframe` or emits them itself.
   */
  async attachStream(listener: ComputerFrameListener): Promise<void> {
    this.engage("attachStream");
    this.frameListener = listener;
  }

  async detachStream(): Promise<void> {
    this.engage("detachStream");
    this.frameListener = null;
  }

  async requestKeyframe(): Promise<void> {
    this.engage("requestKeyframe");
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
    method: "click" | "doubleClick" | "rightClick" | "moveCursor",
    point: ComputerPoint,
    modifiers?: readonly ComputerInputModifier[],
  ): Promise<ComputerBackendActionResult> {
    // Recorded only when present, so every existing assertion on a plain
    // pointer call keeps matching its two-argument shape.
    if (modifiers && modifiers.length > 0) this.engage(method, point, modifiers);
    else this.engage(method, point);
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

  /**
   * An establishing call: recorded, connected, and failed if a test asked for
   * that. Everything but the passive probe and the synchronous getters goes
   * through here, because on a real backend that is what first touches the
   * desktop and turns health from unavailable to connected.
   */
  private engage(method: string, ...args: readonly unknown[]): void {
    this.record(method, ...args);
    if (!this.pinnedHealth && !this.connected) {
      this.connected = true;
      this.currentHealth = CONNECTED_HEALTH;
      this.emit({ type: "health-changed", health: this.currentHealth });
    }
    this.throwIfFailed(method);
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
