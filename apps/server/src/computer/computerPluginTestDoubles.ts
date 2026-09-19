/**
 * The plugin and bus doubles every compositor-backend suite drives.
 *
 * They are doubles of a *contract*, not of KWin: `KWinComputerPluginApi` and
 * `KWinComputerDbus` are the surface the Synara plugin serves on both KWin and
 * Hyprland, and the backend engine is the same class on both. Keeping one pair
 * here is what stops the Hyprland suite from growing a second copy that drifts
 * away from the interface the first one tracks.
 */
import type { ComputerWindow } from "@synara/contracts";

import type { KWinComputerDbus, KWinComputerPluginApi } from "./kwinDbus.ts";

export const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

/**
 * A PNG header carrying the requested dimensions. Only the IHDR size fields are
 * read back, which is what the region/scale mapping is derived from.
 */
export function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export class FakePlugin implements KWinComputerPluginApi {
  instanceId = "initial-instance";
  owner = ":1.42";
  /** `null` mirrors a plugin whose shortcut registration failed. */
  releaseShortcut: string | null | undefined;
  keyboardLayout: string | undefined;
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  capture = true;
  captureBytes: Uint8Array = PNG_1X1;
  running = false;
  workspace:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  captureFailure: Error | undefined;
  releasedByUser = false;
  idleTimeoutMs: number | undefined;
  idleTimeoutFailure: Error | undefined;
  position: { readonly x: number; readonly y: number } = { x: 0, y: 0 };
  /** Mirrors KWin clamping a pointer move to the nearest output. */
  clampPointer: ((x: number, y: number) => { readonly x: number; readonly y: number }) | undefined;
  windows: readonly ComputerWindow[] = [
    {
      id: "window-1",
      title: "Terminal",
      appName: "org.kde.konsole",
      pid: 123,
      bounds: { x: 956, y: 1519, width: 648, height: 518 },
      focused: true,
      minimized: false,
      visible: true,
    },
  ];

  healthJson = async () =>
    JSON.stringify({
      ok: true,
      running: this.running,
      capture: this.capture,
      releasedByUser: this.releasedByUser,
      idleTimeoutMs: this.idleTimeoutMs ?? 300_000,
      kwinVersion: "6.7.3",
      ...(this.releaseShortcut === undefined ? {} : { releaseShortcut: this.releaseShortcut }),
      ...(this.workspace ? { workspaceGeometry: this.workspace } : {}),
    });
  /** The plugin's human-active introspection, absent until a test sets it. */
  humanState:
    | {
        readonly humanFocusWindowId?: string;
        readonly msSinceHumanInput?: number;
        readonly ownsCompositor?: boolean;
      }
    | undefined;
  /** Which window the plugin says the agent seat is aimed at. */
  targetWindowId: string | null = "window-1";
  stateJson = async () =>
    JSON.stringify({
      position: this.position,
      targetWindowId: this.targetWindowId,
      ...(this.keyboardLayout === undefined ? {} : { keyboardLayout: this.keyboardLayout }),
      ...this.humanState,
    });
  windowsJson = async () => JSON.stringify(this.windows);
  start = async () => {
    this.calls.push({ method: "start", args: [] });
    if (this.releasedByUser) {
      throw dbusError(
        "org.synara.ComputerUse.Error.ControlReleased",
        "computer control was released with Meta+Shift+Esc",
      );
    }
    this.running = true;
    return true;
  };
  stop = async () => {
    this.running = false;
    this.releasedByUser = false;
    return this.recordResult("stop");
  };
  setIdleTimeout = async (milliseconds: number) => {
    this.calls.push({ method: "setIdleTimeout", args: [milliseconds] });
    if (this.idleTimeoutFailure) throw this.idleTimeoutFailure;
    this.idleTimeoutMs = milliseconds;
    return true;
  };
  humanActiveGuardMs: number | undefined;
  humanActiveGuardFailure: Error | undefined;
  setHumanActiveGuardMs = async (milliseconds: number) => {
    this.calls.push({ method: "setHumanActiveGuardMs", args: [milliseconds] });
    if (this.humanActiveGuardFailure) throw this.humanActiveGuardFailure;
    this.humanActiveGuardMs = milliseconds;
    return true;
  };
  agentName: string | undefined;
  agentNameFailure: Error | undefined;
  setAgentName = async (name: string) => {
    this.calls.push({ method: "setAgentName", args: [name] });
    if (this.agentNameFailure) throw this.agentNameFailure;
    this.agentName = name;
    return true;
  };
  focusWindow = async (windowId: string) => this.recordInput("focusWindow", windowId);
  raiseWindowFailure: Error | undefined;
  raiseWindow = async (windowId: string) => {
    if (this.raiseWindowFailure) {
      this.calls.push({ method: "raiseWindow", args: [windowId] });
      throw this.raiseWindowFailure;
    }
    return this.recordInput("raiseWindow", windowId);
  };
  clearFocusWindow = async () => this.recordInput("clearFocusWindow");
  resetInputDeliveryFailure: Error | undefined;
  resetInputDelivery = async () => {
    if (this.resetInputDeliveryFailure) {
      this.calls.push({ method: "resetInputDelivery", args: [] });
      throw this.resetInputDeliveryFailure;
    }
    return this.recordInput("resetInputDelivery");
  };
  movePointer = async (x: number, y: number) => {
    if (this.running) this.position = this.clampPointer?.(x, y) ?? { x, y };
    return this.recordInput("movePointer", x, y);
  };
  /** Fails one input method, the way the plugin refuses an unreachable client. */
  inputFailure: { readonly method: string; readonly error: Error } | undefined;
  button = async (code: number, pressed: boolean) => this.recordInput("button", code, pressed);
  axis = async (horizontal: number, vertical: number) =>
    this.recordInput("axis", horizontal, vertical);
  key = async (code: number, pressed: boolean) => this.recordInput("key", code, pressed);
  captureWindow = async (windowId: string, maxDimension: number) => {
    this.calls.push({ method: "captureWindow", args: [windowId, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? this.captureBytes : Uint8Array.of();
  };
  captureRegion = async (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => {
    this.calls.push({ method: "captureRegion", args: [x, y, width, height, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? this.captureBytes : Uint8Array.of();
  };

  private recordResult(method: string, ...args: readonly unknown[]): true {
    this.calls.push({ method, args });
    return true;
  }

  /** Mirrors the plugin refusing every input while the session is stopped. */
  private recordInput(method: string, ...args: readonly unknown[]): boolean {
    this.calls.push({ method, args });
    if (this.inputFailure?.method === method) throw this.inputFailure.error;
    return this.running;
  }
}

export class FakeDbus implements KWinComputerDbus {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  readonly plugin: FakePlugin;
  loaded: readonly string[] = [];
  /**
   * The unique bus name currently owning org.synara.ComputerUse, mimicking how
   * every freshly loaded generation registers under a new unique name.
   */
  serviceOwner: string | undefined;
  /** Answer to a liveness ping; undefined means the fake offers no ping. */
  pingAnswer: boolean | undefined = true;
  private ownerCounter = 42;
  private disconnectListener: (() => void) | undefined;
  private ownerListener: ((owner: string | undefined) => void) | undefined;

  constructor(plugin = new FakePlugin()) {
    this.plugin = plugin;
  }

  nameOwner = async (name: string) => {
    this.calls.push({ method: "GetNameOwner", args: [name] });
    if (this.serviceOwner !== undefined) return this.serviceOwner;
    return this.loaded.some((id) => id.startsWith("SynaraComputerUsePlugin")) ? ":1.42" : undefined;
  };
  listLoadedPluginIds = async () => {
    this.calls.push({ method: "loadedPlugins", args: [] });
    return this.loaded;
  };
  loadPlugin = async (pluginId: string) => {
    this.calls.push({ method: "LoadPlugin", args: [pluginId] });
    this.loaded = [pluginId];
    this.plugin.instanceId = `instance-${pluginId}`;
    if (pluginId.startsWith("SynaraComputerUsePlugin")) {
      // A new registration takes a new unique name; that change across the
      // LoadPlugin boundary is exactly what the backend asserts on.
      this.serviceOwner = `:1.${(this.ownerCounter += 1)}`;
    }
    return true;
  };
  unloadPlugin = async (pluginId: string) => {
    this.calls.push({ method: "UnloadPlugin", args: [pluginId] });
    const wasLoaded = this.loaded.includes(pluginId);
    this.loaded = this.loaded.filter((id) => id !== pluginId);
    return wasLoaded;
  };
  connectPlugin = async () => {
    this.calls.push({ method: "connectPlugin", args: [] });
    return this.plugin;
  };
  onDisconnect = (listener: () => void) => {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) this.disconnectListener = undefined;
    };
  };
  pingOwner = async (owner: string) => {
    this.calls.push({ method: "Ping", args: [owner] });
    return this.pingAnswer === true;
  };
  onServiceOwnerChanged = (listener: (owner: string | undefined) => void) => {
    this.ownerListener = listener;
    return () => {
      if (this.ownerListener === listener) this.ownerListener = undefined;
    };
  };
  close = async () => {
    this.calls.push({ method: "close", args: [] });
  };
  disconnect = () => this.disconnectListener?.();
  /** The bus daemon announcing a new owner for the plugin service. */
  changeServiceOwner = (owner: string | undefined) => this.ownerListener?.(owner);
}

export function dbusError(type: string, message: string): Error {
  const error = new Error(message) as Error & { type: string };
  error.name = "DBusError";
  error.type = type;
  return error;
}
