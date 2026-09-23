import type {
  ComputerAccessibilityTreeApp,
  ComputerAccessibilityTreeWindow,
  ComputerApp,
  ComputerAvailability,
  ComputerBuildSignature,
  ComputerCapabilities,
  ComputerCursorPosition,
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
  type ComputerAgentDialect,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
  type ComputerBackendEventListener,
  type ComputerBrowserBackend,
  type ComputerBrowserCall,
  type ComputerBrowserCallResult,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerMenuBackendTarget,
  type ComputerResolvedTarget,
  type ComputerShieldTarget,
  type ComputerStreamFrame,
  type ComputerTextRange,
} from "./ComputerBackend.ts";
import { requireWindowBounds } from "./computerGeometry.ts";
import { ComputerTargetError } from "./uiTreeTargeting.ts";

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
  /**
   * Opts the fake into the browser surface. `true` uses the built-in handler
   * (a minted `target_id` for `get_browser_state`, `status:"completed"` for
   * everything else); a function answers calls itself. Absent or `false`
   * means the fake speaks no browser tools — `browser` stays undefined, which
   * is how a desktop-only backend truthfully reports that.
   */
  readonly browser?:
    | boolean
    | ((
        call: ComputerBrowserCall,
      ) => ComputerBrowserCallResult | void | Promise<ComputerBrowserCallResult | void>);
  /**
   * Opts the fake into driver-observed settling. `true` answers every
   * `waitForSettle` call `{settled:true}` immediately; a function answers
   * itself, so a test can return a busy surface or throw the
   * "Unknown tool:" refusal an older driver produces. Absent or `false`
   * means the backend truthfully has no observer — the method stays
   * undefined and callers must take the fixed-settle fallback.
   */
  readonly waitForSettle?:
    | boolean
    | ((options: {
        readonly windowId: string;
        readonly timeoutMs: number;
        readonly quietMs: number;
      }) =>
        | { readonly settled: boolean; readonly waitedMs: number; readonly eventsSeen?: number }
        | Promise<{
            readonly settled: boolean;
            readonly waitedMs: number;
            readonly eventsSeen?: number;
          }>);
  /**
   * Opts the fake into the activation-shield surface. `true` answers every
   * `engageShield` with the caller's id; a function answers engages itself,
   * so a test can refuse or wedge the way a real host can. Absent or `false`
   * means the backend has no shield surface — the methods stay undefined,
   * which is what makes an armed masked-activation flag fail closed.
   */
  readonly shield?: boolean | ((target: ComputerShieldTarget) => void | Promise<void>);
  /**
   * What the fake reports as its input dialect. The real CUA backend reports
   * `"macos"`; the fake defaults to absent (the manager reads that as
   * `"linux"`) so existing fixtures keep their dialect-gated behavior, and a
   * test that needs the macOS paths — masked activation among them — opts in.
   */
  readonly agentDialect?: ComputerAgentDialect;
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
  private cursorPosition: ComputerPoint = { x: 0, y: 0 };
  private disposed = false;
  readonly browser?: ComputerBrowserBackend;
  /**
   * Present only when `options.waitForSettle` opted the fake into the
   * observer capability — exactly like a real backend that either exposes
   * the driver's `wait_for_settle` read or does not. `NonNullable` because
   * `exactOptionalPropertyTypes` makes the interface's optional member
   * present-or-absent, never undefined.
   */
  readonly waitForSettle?: NonNullable<ComputerBackend["waitForSettle"]>;
  /**
   * Present only when `options.shield` opted the fake into the shield
   * surface — exactly like a real backend that either exposes the host's
   * shield command or does not. Engage still echoes the caller's id back:
   * the manager mints it, so a fake that "lost the reply" is simulated with
   * `failNext("engageShield")`, not by withholding the id.
   */
  readonly engageShield?: NonNullable<ComputerBackend["engageShield"]>;
  readonly releaseShield?: NonNullable<ComputerBackend["releaseShield"]>;
  readonly releaseAllShields?: NonNullable<ComputerBackend["releaseAllShields"]>;
  private liveShields = new Set<string>();
  readonly agentDialect?: ComputerAgentDialect;

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
    if (options.agentDialect) this.agentDialect = options.agentDialect;
    if (options.browser) {
      const handler = typeof options.browser === "function" ? options.browser : undefined;
      this.browser = {
        call: async (call) => {
          this.throwIfFailed(`browser.${call.name}`);
          const result = (await handler?.(call)) ?? {
            content: [{ type: "text", text: `fake browser ${call.name}` }],
            structuredContent:
              call.name === "get_browser_state"
                ? { target_id: `fake-browser-${call.task.threadId}`, tabs: [] }
                : { status: "completed" },
          };
          this.record(`browser.${call.name}`, call.args);
          return result;
        },
        endThread: async (threadId) => {
          this.record("browser.endThread", threadId);
        },
      };
    }
    if (options.waitForSettle) {
      const handler =
        typeof options.waitForSettle === "function" ? options.waitForSettle : undefined;
      this.waitForSettle = async (settleOptions) => {
        this.record("waitForSettle", settleOptions);
        this.throwIfFailed("waitForSettle");
        const window = this.currentWindows.find((entry) => entry.id === settleOptions.windowId);
        if (!window)
          throw new ComputerTargetError({
            code: "computer_target_not_found",
            message: `No desktop window has id ${JSON.stringify(settleOptions.windowId)}.`,
          });
        return (await handler?.(settleOptions)) ?? { settled: true, waitedMs: 0 };
      };
    }
    if (options.shield) {
      const handler = typeof options.shield === "function" ? options.shield : undefined;
      this.engageShield = async (target) => {
        this.record("engageShield", target);
        this.throwIfFailed("engageShield");
        await handler?.(target);
        this.liveShields.add(target.shieldId);
        return target.shieldId;
      };
      this.releaseShield = async (shieldId) => {
        this.record("releaseShield", shieldId);
        this.throwIfFailed("releaseShield");
        this.liveShields.delete(shieldId);
      };
      this.releaseAllShields = async () => {
        this.record("releaseAllShields");
        this.liveShields.clear();
      };
    }
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

  async launchApp(
    app: string,
    args: readonly string[],
    options?: { readonly hidden?: boolean },
  ): Promise<ComputerLaunchAppResult> {
    // Recorded only when present, so every existing assertion on a plain
    // launch keeps matching its two-argument shape.
    if (options !== undefined) this.record("launchApp", app, args, options);
    else this.record("launchApp", app, args);
    this.throwIfFailed("launchApp");
    const hidden = options?.hidden === true;
    const id = `fake-window-${this.currentWindows.length + 1}`;
    const window: ComputerWindow = {
      id,
      title: app,
      appName: app,
      pid: this.nextPid++,
      bounds: { x: 120, y: 80, width: 900, height: 700 },
      // A hidden launch renders nothing and takes no focus: frontmost is
      // unchanged, which the fake models by leaving every existing flag alone.
      focused: false,
      minimized: false,
      visible: !hidden,
    };
    this.currentWindows = [...this.currentWindows, window];
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
    target: ComputerMenuBackendTarget,
    path: readonly string[],
  ): Promise<ComputerBackendActionResult> {
    this.record("invokeMenu", target, path);
    this.throwIfFailed("invokeMenu");
    if ("windowId" in target) {
      if (!this.currentWindows.some((window) => window.id === target.windowId)) {
        throw new ComputerBackendError(
          `No desktop window has id ${JSON.stringify(target.windowId)}.`,
        );
      }
    } else if (!this.currentApps.some((app) => app.pid === target.pid && app.running)) {
      // The windowless form proves the process, not a window — the same
      // refusal the real driver raises for a pid that is not running.
      throw new ComputerBackendError(`No running application has pid ${target.pid}.`);
    }
    if (path.length === 0 || path.some((segment) => segment.trim().length === 0)) {
      throw new ComputerBackendError("A menu path needs at least one non-empty title.");
    }
    const refusal = this.refusedMenuPaths.get(path.join(""));
    if (refusal) throw refusal;
    return {
      ...("windowId" in target ? { windowId: target.windowId } : {}),
      deliveryPath: "fake-menu",
      verified: "confirmed",
      effect: "verified",
    };
  }

  async setWindowMinimized(
    windowId: string,
    minimized: boolean,
  ): Promise<ComputerBackendActionResult> {
    this.record("setWindowMinimized", windowId, minimized);
    this.throwIfFailed("setWindowMinimized");
    const index = this.currentWindows.findIndex((window) => window.id === windowId);
    if (index === -1) {
      throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
    }
    // A minimized window renders nothing; a restored one shows again. The
    // window stays in the list either way — like the real driver, the fake
    // keeps it addressable for semantic reads while it is off screen.
    const window = this.currentWindows[index]!;
    this.currentWindows[index] = { ...window, minimized, visible: !minimized };
    this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
    this.emit({ type: "windows-changed", windows: this.currentWindows });
    return {
      windowId,
      deliveryPath: "fake-minimize",
      verified: "confirmed",
      effect: "verified",
    };
  }

  async setAppVisibility(pid: number, hidden: boolean): Promise<ComputerBackendActionResult> {
    this.record("setAppVisibility", pid, hidden);
    this.throwIfFailed("setAppVisibility");
    const app = this.currentApps.find((candidate) => candidate.pid === pid && candidate.running);
    if (!app) {
      throw new ComputerBackendError(`No running application has pid ${pid}.`);
    }
    // A hidden app renders none of its windows; unhiding restores whatever
    // is not still minimized.
    this.currentWindows = this.currentWindows.map((window) =>
      window.pid === pid ? { ...window, visible: !hidden && !window.minimized } : window,
    );
    this.currentRoot = defaultRoot(this.currentScreenSize, this.currentWindows);
    this.emit({ type: "windows-changed", windows: this.currentWindows });
    return {
      deliveryPath: "fake-app-visibility",
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

  /**
   * Mirrors the driver's grant-free snapshot: only running apps and the
   * on-screen window subset appear there, so minimized and hidden windows are
   * filtered out rather than reported as a different "not visible" flag.
   */
  async getAccessibilityTree(windowId?: string): Promise<{
    readonly apps: readonly ComputerAccessibilityTreeApp[];
    readonly windows: readonly ComputerAccessibilityTreeWindow[];
    readonly truncated: boolean;
  }> {
    if (windowId === undefined) this.record("getAccessibilityTree");
    else this.record("getAccessibilityTree", windowId);
    this.throwIfFailed("getAccessibilityTree");
    let scopedPid: number | undefined;
    if (windowId !== undefined) {
      const window = this.currentWindows.find((candidate) => candidate.id === windowId);
      if (!window) {
        throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
      }
      scopedPid = window.pid;
    }
    const apps = this.currentApps
      .filter(
        (app) => app.running && app.pid > 0 && (scopedPid === undefined || app.pid === scopedPid),
      )
      .map(
        (app): ComputerAccessibilityTreeApp => ({
          pid: app.pid,
          name: app.name,
          ...(app.bundleId ? { bundleId: app.bundleId } : {}),
        }),
      )
      .slice(0, 1_024);
    const windows = this.currentWindows
      .filter(
        (window) =>
          window.visible &&
          !window.minimized &&
          window.pid !== undefined &&
          window.pid > 0 &&
          (scopedPid === undefined || window.pid === scopedPid),
      )
      .map(
        (window): ComputerAccessibilityTreeWindow => ({
          id: window.id,
          pid: window.pid!,
          ...(window.appName ? { appName: window.appName } : {}),
          title: window.title,
          ...(window.bounds ? { bounds: { ...window.bounds } } : {}),
          onScreen: true,
          ...(window.stackingIndex !== undefined ? { zIndex: window.stackingIndex } : {}),
        }),
      )
      .slice(0, 512);
    return { apps, windows, truncated: false };
  }

  /**
   * The fake tracks where its own pointer actions last left the cursor, so a
   * `moveCursor` followed by this read round-trips the way the real driver
   * does.
   */
  async getCursorPosition(
    windowId?: string,
  ): Promise<Omit<ComputerCursorPosition, "computerId" | "availability">> {
    if (windowId === undefined) this.record("getCursorPosition");
    else this.record("getCursorPosition", windowId);
    this.throwIfFailed("getCursorPosition");
    const window =
      windowId === undefined
        ? undefined
        : this.currentWindows.find((candidate) => candidate.id === windowId);
    if (windowId !== undefined && !window) {
      throw new ComputerBackendError(`No desktop window has id ${JSON.stringify(windowId)}.`);
    }
    const { x, y } = this.cursorPosition;
    const bounds = window?.bounds;
    return {
      x,
      y,
      capturedAt: this.now(),
      ...(window ? { windowId: window.id } : {}),
      ...(bounds
        ? {
            insideWindow:
              x >= bounds.x &&
              x < bounds.x + bounds.width &&
              y >= bounds.y &&
              y < bounds.y + bounds.height,
          }
        : {}),
    };
  }

  /** Places the fake cursor directly, for tests that need a known point. */
  setCursorPosition(point: ComputerPoint): void {
    this.cursorPosition = { ...point };
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
    _windowId?: string,
  ): Promise<ComputerBackendActionResult> {
    this.record("drag", from, to, durationMs);
    this.throwIfFailed("drag");
    this.validatePoint(from);
    this.validatePoint(to);
    this.cursorPosition = { ...to };
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

  /**
   * The fake's selection is the slice of the element's own value: its
   * "read-back" is exactly the substring the requested range covers, which
   * is the honest emulation of a driver that confirmed the write.
   */
  async selectText(
    target: ComputerResolvedTarget,
    range: ComputerTextRange,
  ): Promise<ComputerBackendActionResult> {
    this.record("selectText", target, range);
    this.throwIfFailed("selectText");
    return {
      point: target.point,
      value: (target.node.value ?? "").slice(range.start, range.start + range.length),
    };
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

  emitFrame(
    keyframe = false,
    codecConfig = false,
    data = Uint8Array.of(0x01),
    mimeType?: ComputerStreamFrame["mimeType"],
  ): void {
    if (!this.frameListener || this.disposed) return;
    const frame: ComputerStreamFrame = {
      sequence: this.nextSequence++,
      timestampMs: Date.now(),
      keyframe,
      codecConfig,
      data,
      ...(mimeType !== undefined ? { mimeType } : {}),
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

  /**
   * Reports a desktop lock/sleep/session interruption the way the real
   * backend does when a reply's `desktopInterruptions` count advances —
   * `pauses` are the reasons still active at observation time, empty when
   * the cycle already ended.
   */
  emitDesktopInterrupted(pauses: readonly string[] = []): void {
    this.emit({ type: "desktop-interrupted", pauses });
  }

  /** Reports a changed capability set, as a reconnect or a slot swap does. */
  emitCapabilitiesChanged(): void {
    this.emit({ type: "capabilities-changed", capabilities: this.currentCapabilities });
  }

  /** Reports that the desktop this backend drove has ended for good. */
  emitDesktopGone(message = "The fake desktop exited."): void {
    this.emit({ type: "desktop-gone", message });
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

  /**
   * The shield ids the fake still considers up: engage adds, release removes.
   * Lets a test prove a stranded shield was actually cleaned rather than
   * trusting the call log alone.
   */
  activeShields(): readonly string[] {
    return [...this.liveShields];
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
    this.cursorPosition = { ...point };
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
