import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";
import type { ProxyObject as DbusProxyObject } from "dbus-next";

import { ComputerBackendError } from "./ComputerBackend.ts";
import {
  type DbusConnectionWatch,
  unwrapDbusValue,
  watchDbusConnection,
  withDbusTimeout,
} from "./dbusPlumbing.ts";
import { COMPUTER_SERVER_OWNER, createComputerSessionAuth } from "./computerSessionAuth.ts";

export const KWIN_SERVICE = "org.kde.KWin";
export const KWIN_PLUGINS_PATH = "/Plugins";
export const KWIN_PLUGINS_INTERFACE = "org.kde.KWin.Plugins";
export const KWIN_OBJECT_PATH = "/KWin";
export const KWIN_INTERFACE = "org.kde.KWin";
export const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
export const DBUS_SERVICE = "org.freedesktop.DBus";
export const DBUS_OBJECT_PATH = "/org/freedesktop/DBus";
export const DBUS_INTERFACE = "org.freedesktop.DBus";
export const COMPUTER_SERVICE = "org.synara.ComputerUse";
export const COMPUTER_OBJECT_PATH = "/org/synara/ComputerUse";
export const COMPUTER_INTERFACE = "org.synara.ComputerUse1";
export const KWIN_DBUS_DEFAULT_TIMEOUT_MS = 5_000;
/** The floor for a capture; `captureTimeoutMs` raises it with the pixel count. */
export const KWIN_DBUS_CAPTURE_TIMEOUT_MS = 10_000;
export const KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS = 60_000;
/** A liveness ping is answered by the peer's event loop, not by any rendering. */
export const KWIN_DBUS_PING_TIMEOUT_MS = 2_000;
const DBUS_PEER_INTERFACE = "org.freedesktop.DBus.Peer";
const DBUS_NAME_POLL_MS = 100;

/**
 * How long a capture may take before it is called lost. Rendering a region and
 * encoding it as PNG scales with its area, and a 4K-plus multi-monitor
 * workspace legitimately takes longer than a single window; one fixed ten
 * second budget was both too short for the former and pointlessly long for a
 * failure on the latter. Roughly two seconds per million source pixels on top
 * of the floor, capped so a nonsense request still fails in bounded time.
 */
export function captureTimeoutMs(pixels: number | undefined): number {
  if (pixels === undefined || !Number.isFinite(pixels) || pixels <= 0) {
    return KWIN_DBUS_CAPTURE_TIMEOUT_MS;
  }
  const scaled = KWIN_DBUS_CAPTURE_TIMEOUT_MS + (pixels / 1_000_000) * 2_000;
  return Math.min(KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS, Math.ceil(scaled));
}

/**
 * A call that never answered. `methodName` is what lets the backend tell a slow
 * capture (per-call, retryable) from a plugin that has stopped answering at all
 * (probe liveness, then reconnect): the type alone does not decide that.
 */
export class KWinDbusTimeoutError extends Error {
  readonly methodName: string;
  readonly timeoutMs: number;

  constructor(methodName: string, timeoutMs: number) {
    super(`D-Bus call ${methodName} timed out after ${timeoutMs} ms.`);
    this.name = "KWinDbusTimeoutError";
    this.methodName = methodName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The plugin methods this proxy calls, with the D-Bus signatures the plugin
 * declares for them (`in` is the concatenated argument signature, `out` the
 * reply). Kept as data so a test can hold the TypeScript surface against the
 * plugin's introspection XML: a method renamed or re-typed on one side and not
 * the other otherwise only fails at runtime, inside the compositor.
 */
export const COMPUTER_PLUGIN_METHOD_SIGNATURES: Readonly<
  Record<string, { readonly in: string; readonly out: string }>
> = {
  authenticate: { in: "s", out: "s" },
  healthJson: { in: "", out: "s" },
  stateJson: { in: "", out: "s" },
  windowsJson: { in: "", out: "s" },
  windowsStateJson: { in: "", out: "s" },
  start: { in: "", out: "b" },
  stop: { in: "", out: "b" },
  setIdleTimeout: { in: "u", out: "b" },
  setHumanActiveGuardMs: { in: "u", out: "b" },
  setAgentName: { in: "s", out: "b" },
  focusWindow: { in: "s", out: "b" },
  raiseWindow: { in: "s", out: "b" },
  clearFocusWindow: { in: "", out: "b" },
  resetInputDelivery: { in: "", out: "b" },
  movePointer: { in: "dd", out: "b" },
  button: { in: "ub", out: "b" },
  axis: { in: "dd", out: "b" },
  key: { in: "ub", out: "b" },
  keys: { in: "a(ub)", out: "u" },
  waitForSettle: { in: "suu", out: "bu" },
  captureWindow: { in: "su", out: "ay" },
  captureRegion: { in: "iiuuu", out: "ay" },
  captureWindowEx: { in: "suu", out: "ays" },
  captureRegionEx: { in: "iiuuuu", out: "ays" },
};

/** The plugin clamps a `waitForSettle` timeout to this. */
const SETTLE_MAX_TIMEOUT_MS = 30_000;

/**
 * `flags` for `captureWindowEx`/`captureRegionEx` (feature `captureEx`). Luma
 * outranks JPEG; without either the bytes are a PNG. Unknown bits are ignored.
 */
export const COMPUTER_CAPTURE_FLAGS = {
  /** An observer's frame: not agent activity, so the idle deadline and badge are untouched. */
  passive: 1,
  /** JPEG at quality 85, `image/jpeg`. */
  jpeg: 2,
  /** Raw 8-bit luma, row-major and unpadded: `image/x-luma8; width=<w>; height=<h>`. */
  luma: 4,
} as const;

export interface KWinComputerPluginApi {
  readonly instanceId?: string;
  /** The unique bus name the proxy is pinned to, for liveness pings. */
  readonly owner?: string;
  readonly healthJson: () => Promise<unknown>;
  readonly stateJson: () => Promise<unknown>;
  readonly windowsJson: () => Promise<unknown>;
  /**
   * Interface version 2, feature `windowsStateJson`: `{windows, targetWindowId,
   * workspace, locked}` in one call, answering rather than refusing while
   * locked. Call only when `healthJson().features` lists it.
   */
  readonly windowsStateJson?: () => Promise<unknown>;
  readonly start: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly setIdleTimeout: (milliseconds: number) => Promise<unknown>;
  /**
   * How recently the human's own seat must have been active for the plugin to
   * refuse a mutating action aimed at the window they are focused on. `0`
   * disables the guard. Absent on plugin builds older than Phase 4.
   */
  readonly setHumanActiveGuardMs: (milliseconds: number) => Promise<unknown>;
  /** Names the thread driving the ghost cursor, for the on-screen badge. */
  readonly setAgentName: (name: string) => Promise<unknown>;
  readonly focusWindow: (windowId: string) => Promise<unknown>;
  readonly raiseWindow: (windowId: string) => Promise<unknown>;
  readonly clearFocusWindow: () => Promise<unknown>;
  /**
   * Hands every shared client object back to the human seat: clears the
   * explicit focus/aim target, drops any cached direct-injection enter
   * bookkeeping, and releases held buttons and keys. Called whenever the
   * desktop lease changes owner. Absent on plugin builds older than this method.
   */
  readonly resetInputDelivery: () => Promise<unknown>;
  readonly movePointer: (x: number, y: number) => Promise<unknown>;
  readonly button: (code: number, pressed: boolean) => Promise<unknown>;
  /**
   * Scroll distance in logical pixels on each axis, the same unit as pointer
   * coordinates and window bounds — not wheel notches or lines. One unit is one
   * pixel of content, so a wheel notch is on the order of a hundred. The plugin
   * consumes the same unit, and the agent tool surface documents it, so a delta
   * means the same thing at every hop.
   */
  readonly axis: (horizontal: number, vertical: number) => Promise<unknown>;
  readonly key: (code: number, pressed: boolean) => Promise<unknown>;
  /**
   * Interface version 2, feature `keys`: up to 256 `[code, pressed]` strokes in
   * one call, each checked as `key` checks one. Answers how many were
   * delivered; it stops at the first that was not, and a refusal of the first
   * is an error exactly as from `key`.
   */
  readonly keys?: (
    strokes: readonly (readonly [code: number, pressed: boolean])[],
  ) => Promise<unknown>;
  /**
   * Interface version 2, feature `waitForSettle`: answers `[settled,
   * elapsedMs]` once the window (any window for `""`) has committed new
   * content after the agent's last input and then stayed quiet for
   * `quietMs`, or `[false, elapsedMs]` at `timeoutMs` (the plugin clamps it to
   * 30 s), and `[false, 0]` at once with no session running or no such
   * window. The call's own deadline outlasts `timeoutMs`.
   */
  readonly waitForSettle?: (
    windowId: string,
    quietMs: number,
    timeoutMs: number,
  ) => Promise<unknown>;
  /**
   * `pixels` is the source area the caller expects the capture to render, used
   * only to size the call's deadline; it is not sent to the plugin.
   */
  readonly captureWindow: (
    windowId: string,
    maxDimension: number,
    pixels?: number,
  ) => Promise<unknown>;
  readonly captureRegion: (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => Promise<unknown>;
  /**
   * Interface version 2, feature `captureEx`: the captures above with
   * `COMPUTER_CAPTURE_FLAGS`, answering `[bytes, mime]`. Call only when
   * `healthJson().features` lists it.
   */
  readonly captureWindowEx?: (
    windowId: string,
    maxDimension: number,
    flags: number,
    pixels?: number,
  ) => Promise<unknown>;
  readonly captureRegionEx?: (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
    flags: number,
  ) => Promise<unknown>;
}

export interface KWinComputerDbus {
  readonly listLoadedPluginIds: () => Promise<readonly string[]>;
  readonly loadPlugin: (pluginId: string) => Promise<boolean>;
  /** `false` only when KWin reports the id was not loaded to begin with. */
  readonly unloadPlugin: (pluginId: string) => Promise<boolean>;
  /**
   * The unique bus name of whoever owns `name`, or `undefined` when nothing
   * does. This is how a well-known name is pinned to the process that answered
   * it *now*: talking to whichever process holds `org.synara.ComputerUse`
   * without checking means a stale duplicate instance silently receives every
   * pointer, key, and capture call.
   */
  readonly nameOwner: (name: string) => Promise<string | undefined>;
  readonly connectPlugin: () => Promise<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  /**
   * `org.freedesktop.DBus.Peer.Ping` on a unique name: true when the peer's
   * event loop answered in time, false when it did not. A slow reply to a
   * real method is not proof the plugin is gone; this is the cheap question
   * that settles it before a connection is torn down.
   */
  readonly pingOwner?: (owner: string) => Promise<boolean>;
  /**
   * Fires when the well-known plugin service changes owner — a plugin unload,
   * reload, or compositor restart — with the new unique name, or undefined when
   * the name became ownerless. This is how the backend learns its pinned proxy
   * is a stale generation without waiting for a call to fail.
   */
  readonly onServiceOwnerChanged?: (listener: (owner: string | undefined) => void) => () => void;
  /**
   * The version of the compositor that is running, read off the compositor
   * itself (`supportInformation`). After a package upgrade the binary on disk
   * is newer than this until the next login, and a plugin has to match this
   * one to load today.
   */
  readonly kwinVersion?: () => Promise<string | undefined>;
  /**
   * Which compositor instance is running right now — KWin's unique bus name,
   * the live Hyprland instance — or `undefined` when none is. A plugin gone
   * from an instance that is still the same one was unloaded on purpose, and
   * is not loaded again behind the human's back; one gone with its instance
   * is reloaded into the new one.
   */
  readonly compositorInstance?: () => Promise<string | undefined>;
  readonly close: () => Promise<void>;
}

export interface KWinComputerDbusOptions {
  /**
   * A private bus to use instead of the ambient session bus, as the nested
   * Tier 3 compositor runs on one. Absent, this is the user's own session bus,
   * which is the only bus a real desktop's KWin is reachable on.
   */
  readonly busAddress?: string;
  /** Tests inject a fake here; production resolves the real dbus-next. */
  readonly dbusModule?: Pick<typeof dbusModule, "sessionBus"> &
    Partial<Pick<typeof dbusModule, "Message">>;
  /** Waits between throttled authentication attempts; tests make it instant. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * The plugin answers a repeated `authenticate` from the same peer inside its
 * cooldown with this error rather than a verdict. It is neither a stale
 * generation nor a refusal: wait out the cooldown and ask again.
 */
export const COMPUTER_AUTH_THROTTLED_ERROR = "org.synara.ComputerUse.Error.Throttled";
/**
 * `org.synara.ComputerUse` answered from a process that is not the one it has
 * to be — on KWin, anything but KWin's own bus connection, which is where the
 * plugin registers it. A server-side verdict, never sent by a plugin.
 */
export const COMPUTER_SERVICE_OWNER_MISMATCH_ERROR =
  "org.synara.ComputerUse.Error.ServiceOwnerMismatch";
const AUTH_THROTTLE_RETRY_DELAY_MS = 1_100;
const AUTH_THROTTLE_MAX_ATTEMPTS = 3;

function isThrottledAuthError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly type?: unknown }).type === COMPUTER_AUTH_THROTTLED_ERROR
  );
}

async function authenticateWithCooldown(
  plugin: unknown,
  token: string,
  sleep: (milliseconds: number) => Promise<void>,
  call: DbusInvoke,
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return unwrapDbusValue(await call(plugin, "authenticate", token));
    } catch (error) {
      if (attempt >= AUTH_THROTTLE_MAX_ATTEMPTS || !isThrottledAuthError(error)) throw error;
      await sleep(AUTH_THROTTLE_RETRY_DELAY_MS);
    }
  }
}

/**
 * The half of a plugin-host connection that is the same for every compositor:
 * the session bus itself and the Synara plugin proxy on it. The KWin host adds
 * KWin's D-Bus plugin manager on top; the Hyprland host adds `hyprctl`.
 */
export interface ComputerSessionBus {
  /** Resolves a proxy object, with the shared connection-level timeout. */
  readonly getProxyObject: (service: string, path: string) => Promise<DbusProxyObject>;
  /** The unique bus name owning `name`, or undefined when nobody does. */
  readonly nameOwner: (name: string) => Promise<string | undefined>;
  /**
   * Connects to the Synara plugin by its owner's *unique* name, never the
   * well-known one; requires the service to be owned right now.
   */
  readonly connectPlugin: () => Promise<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  readonly pingOwner: (owner: string) => Promise<boolean>;
  readonly onServiceOwnerChanged: (listener: (owner: string | undefined) => void) => () => void;
  readonly close: () => Promise<void>;
}

/**
 * Connect to a session bus, wired for plugin-host use: disconnect fan-out, the
 * Synara plugin proxy, and idempotent close. The plugin proxy is resolved only
 * after the backend has selected and loaded an installed plugin, because no
 * compositor owns the Synara service until a plugin has been loaded.
 */
export async function openComputerSessionBus(
  options: KWinComputerDbusOptions = {},
): Promise<ComputerSessionBus> {
  return (await openWatchedSessionBus(options)).session;
}

/**
 * `openComputerSessionBus`, plus the watch on its connection, for a host in
 * this module whose own calls on the bus must fail with it too.
 */
async function openWatchedSessionBus(options: KWinComputerDbusOptions): Promise<{
  readonly session: ComputerSessionBus;
  readonly call: DbusInvoke;
}> {
  // Keep the optional Linux runtime out of test imports. The production path
  // resolves it only when the backend has passed the Linux/Wayland gate.
  const require = createRequire(import.meta.url);
  const dbus = options.dbusModule ?? (require("dbus-next") as typeof dbusModule);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds).unref?.();
      }));
  const bus = options.busAddress
    ? dbus.sessionBus({ busAddress: options.busAddress })
    : dbus.sessionBus();
  let closed = false;
  const disconnectListeners = new Set<() => void>();
  // The watch's listeners stay attached for the life of the bus object,
  // including through `disconnect()`. dbus-next emits a failure on the bus
  // object itself, and a bus with no `error` listener turns that into an
  // uncaught exception that ends the server process. The window this closes is
  // real: a release write from a `finally` after a timed-out call lands on the
  // socket after `close()` has run, and the ECONNRESET it produces arrives
  // after close.
  const connection = watchDbusConnection(bus);
  connection.onClosed(() => {
    for (const listener of disconnectListeners) listener();
  });
  const call: DbusInvoke = (iface, methodName, ...args) =>
    invokeKWinDbusMethodOn(connection, iface, methodName, ...args);
  const proxyObject = (service: string, path: string) =>
    withTimeout(
      connection.guard(() => bus.getProxyObject(service, path)),
      KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      "getProxyObject",
    );
  const abandon = () => {
    connection.release(() => releasedConnectionError());
    bus.disconnect();
  };
  let busDaemon: DbusProxyObject;
  try {
    busDaemon = await proxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH);
  } catch (error) {
    abandon();
    throw error;
  }
  const daemon = busDaemon.getInterface(DBUS_INTERFACE);
  let authentication: Awaited<ReturnType<typeof createComputerSessionAuth>>;
  try {
    const ownership = unwrapDbusValue(await call(daemon, "RequestName", COMPUTER_SERVER_OWNER, 4));
    if (ownership !== 1)
      throw new Error(
        "Another Synara server owns this desktop. Stop its computer session before using this server.",
      );
    authentication = await createComputerSessionAuth(
      String(unwrapDbusValue(await call(daemon, "GetId"))),
    );
  } catch (error) {
    abandon();
    throw error;
  }
  const resolveNameOwner = async (name: string): Promise<string | undefined> => {
    try {
      const owner = await call(daemon, "GetNameOwner", name);
      return typeof unwrapDbusValue(owner) === "string"
        ? (unwrapDbusValue(owner) as string)
        : undefined;
    } catch (error) {
      // "Nobody owns it" is an answer, not a failure: the caller is the
      // one deciding whether an owner was required.
      if (isUnownedNameError(error)) return undefined;
      throw error;
    }
  };
  const ownerListeners = new Set<(owner: string | undefined) => void>();
  const onNameOwnerChanged = (name: unknown, _old: unknown, next: unknown) => {
    if (name !== COMPUTER_SERVICE) return;
    const owner = typeof next === "string" && next.length > 0 ? next : undefined;
    for (const listener of ownerListeners) listener(owner);
  };
  const daemonEvents = daemon as unknown as Partial<EventEmitter>;
  daemonEvents.on?.("NameOwnerChanged", onNameOwnerChanged);
  const pingOwner = async (owner: string): Promise<boolean> => {
    const Message = dbus.Message;
    if (!Message) return true;
    try {
      await withTimeout(
        connection.guard(() =>
          bus.call(
            new Message({
              destination: owner,
              path: COMPUTER_OBJECT_PATH,
              interface: DBUS_PEER_INTERFACE,
              member: "Ping",
            }),
          ),
        ),
        KWIN_DBUS_PING_TIMEOUT_MS,
        "Ping",
      );
      return true;
    } catch {
      return false;
    }
  };
  const session: ComputerSessionBus = {
    getProxyObject: proxyObject,
    nameOwner: resolveNameOwner,
    pingOwner,
    onServiceOwnerChanged: (listener) => {
      ownerListeners.add(listener);
      return () => ownerListeners.delete(listener);
    },
    connectPlugin: async () => {
      // Address the proxy by the owner's *unique* name, not the well-known
      // one. dbus-next routes every later call by the proxy's destination, so
      // a proxy addressed as `org.synara.ComputerUse` follows the name to
      // whoever owns it next — a stale generation or a same-session squatter
      // taking the name after the backend's ownership check would silently
      // receive every pointer, key, and capture call. Pinned to the unique
      // name, a replaced owner makes calls fail loudly instead, and the
      // reconnect path re-resolves the fresh owner from scratch.
      const owner = await resolveNameOwner(COMPUTER_SERVICE);
      if (owner === undefined) {
        throw new Error(
          `Nothing on the session bus owns ${COMPUTER_SERVICE}, so the plugin cannot be connected.`,
        );
      }
      const object = await proxyObject(owner, COMPUTER_OBJECT_PATH);
      const plugin = object.getInterface(COMPUTER_INTERFACE);
      const instanceId = await authenticateWithCooldown(plugin, authentication.token, sleep, call);
      if (typeof instanceId !== "string" || instanceId.length === 0)
        throw new Error("Computer plugin authentication failed; rebuild the plugin.");
      return { ...makePluginApi(plugin, connection), instanceId, owner };
    },
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // Fan-out stops, the listeners do not: see the note where they attach.
      disconnectListeners.clear();
      ownerListeners.clear();
      daemonEvents.off?.("NameOwnerChanged", onNameOwnerChanged);
      // Settled now, before anything awaits: a call still waiting on this
      // connection must not outlive it into whatever connection replaces it.
      connection.release(() => releasedConnectionError());
      await authentication.close();
      bus.disconnect();
    },
  };
  return { session, call };
}

/**
 * What a call still waiting on a connection this side closed rejects with.
 * Retryable, and deliberately not connection-level: the closer is already
 * replacing the connection, and a late failure read as a dropped bus would
 * tear down the replacement too.
 */
function releasedConnectionError(): ComputerBackendError {
  return new ComputerBackendError(
    "The D-Bus call was abandoned: Synara released the connection it was waiting on.",
    { retryable: true },
  );
}

/**
 * Connect to a session bus and KWin's plugin manager.
 */
export async function createSessionKWinComputerDbus(
  options: KWinComputerDbusOptions = {},
): Promise<KWinComputerDbus> {
  const { session, call } = await openWatchedSessionBus(options);
  try {
    const pluginsObject = await session.getProxyObject(KWIN_SERVICE, KWIN_PLUGINS_PATH);
    const plugins = pluginsObject.getInterface(KWIN_PLUGINS_INTERFACE);
    // KWin exposes the loaded plugin list as the LoadedPlugins property (KWin 6
    // has no loadedPlugins method); keep the method as a fallback for variants
    // that only offer it.
    let properties: unknown;
    try {
      properties = pluginsObject.getInterface(DBUS_PROPERTIES_INTERFACE);
    } catch {
      properties = undefined;
    }
    return {
      nameOwner: session.nameOwner,
      listLoadedPluginIds: async () => {
        const result = properties
          ? await call(properties, "Get", KWIN_PLUGINS_INTERFACE, "LoadedPlugins")
          : await call(plugins, "loadedPlugins");
        return readStringArray(result);
      },
      loadPlugin: async (pluginId) => {
        const result = await call(plugins, "LoadPlugin", pluginId);
        return readBoolean(result);
      },
      unloadPlugin: async (pluginId) => {
        // KWin's UnloadPlugin reply differs by version: older builds answer
        // `b`, newer ones are void. A void reply means the call succeeded, so
        // only an explicit `false` reports "was not loaded".
        const result = await call(plugins, "UnloadPlugin", pluginId);
        return readOptionalBoolean(result) ?? true;
      },
      connectPlugin: async () => {
        // The plugin lives inside KWin and registers the service on KWin's
        // own bus connection, so the service's owner and KWin's are one
        // unique name. Any other owner is a process pretending to be the
        // plugin, and it is never sent the session token.
        const [serviceOwner, kwinOwner] = await Promise.all([
          session.nameOwner(COMPUTER_SERVICE),
          session.nameOwner(KWIN_SERVICE),
        ]);
        if (serviceOwner !== undefined && serviceOwner !== kwinOwner) {
          throw Object.assign(
            new Error(
              `${COMPUTER_SERVICE} is owned by ${serviceOwner}, which is not KWin's bus connection ` +
                `(${kwinOwner ?? "KWin has none"}), so it was not trusted with the session.`,
            ),
            { type: COMPUTER_SERVICE_OWNER_MISMATCH_ERROR },
          );
        }
        return await session.connectPlugin();
      },
      onDisconnect: session.onDisconnect,
      pingOwner: session.pingOwner,
      onServiceOwnerChanged: session.onServiceOwnerChanged,
      kwinVersion: async () => {
        const object = await session.getProxyObject(KWIN_SERVICE, KWIN_OBJECT_PATH);
        const info = unwrapDbusValue(
          await call(object.getInterface(KWIN_INTERFACE), "supportInformation"),
        );
        return typeof info === "string" ? parseKwinSupportVersion(info) : undefined;
      },
      // A restarted KWin re-registers under a new unique name on the same bus.
      compositorInstance: () => session.nameOwner(KWIN_SERVICE),
      close: session.close,
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

/** The `KWin version: X.Y.Z` line of KWin's support information, if present. */
export function parseKwinSupportVersion(info: string): string | undefined {
  return /^KWin version:\s*(\d+(?:\.\d+)+)/m.exec(info)?.[1];
}

/**
 * Waits for `name` to be owned on a bus, and reports whether it appeared.
 *
 * One connection polls `NameHasOwner` rather than reconnecting per attempt: a
 * connect/disconnect cycle per poll would churn the bus, and a failed connect
 * can emit a late error on a bus nobody is listening to any more. A bus that
 * dies during the wait — the daemon it is waiting on crashed — rejects at once
 * with `DbusConnectionClosedError`, not at the end of the timeout.
 */
export async function waitForSessionBusName(options: {
  readonly busAddress: string;
  readonly name: string;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  /** Ends the wait early, for a caller that knows the name will never appear. */
  readonly abort?: () => boolean;
  /** Tests inject a fake here; production resolves the real dbus-next. */
  readonly dbusModule?: KWinComputerDbusOptions["dbusModule"];
}): Promise<boolean> {
  const require = createRequire(import.meta.url);
  const dbus = options.dbusModule ?? (require("dbus-next") as typeof dbusModule);
  const bus = dbus.sessionBus({ busAddress: options.busAddress });
  // Never detached: the bus is dropped after this, and a late socket error on
  // a bus with no `error` listener would be an uncaught exception.
  const connection = watchDbusConnection(bus);
  try {
    const daemon = await withTimeout(
      connection.guard(() => bus.getProxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH)),
      KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      "getProxyObject",
    );
    const iface = daemon.getInterface(DBUS_INTERFACE);
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      if (options.abort?.() === true) return false;
      const owned = await invokeKWinDbusMethodOn(connection, iface, "NameHasOwner", options.name);
      if (owned === true) return true;
      if (Date.now() >= deadline) return false;
      await connection.guard(
        () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.pollMs ?? DBUS_NAME_POLL_MS);
            timer.unref?.();
          }),
      );
    }
  } finally {
    connection.release(() => new Error("The bus-name wait is over."));
    bus.disconnect();
  }
}

function isUnownedNameError(error: unknown): boolean {
  // dbus-next keeps the D-Bus error name in `type`; `message` contains only
  // the human-readable text and need not mention NameHasNoOwner at all.
  const type = (error as { type?: unknown } | null)?.type;
  if (
    type === "org.freedesktop.DBus.Error.NameHasNoOwner" ||
    type === "org.freedesktop.DBus.Error.ServiceUnknown"
  )
    return true;
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("NameHasNoOwner") || text.includes("ServiceUnknown");
}

function makePluginApi(
  iface: unknown,
  connection: DbusConnectionWatch | undefined,
): KWinComputerPluginApi {
  const invoke: DbusInvoke = (target, methodName, ...args) =>
    invokeKWinDbusMethodOn(connection, target, methodName, ...args);
  const invokeWithTimeout = (
    target: unknown,
    methodName: string,
    timeoutMs: number,
    ...args: readonly unknown[]
  ) => invokeOn(connection, target, methodName, timeoutMs, args);
  return {
    healthJson: () => invoke(iface, "healthJson"),
    stateJson: () => invoke(iface, "stateJson"),
    windowsJson: () => invoke(iface, "windowsJson"),
    windowsStateJson: () => invoke(iface, "windowsStateJson"),
    start: () => invoke(iface, "start"),
    stop: () => invoke(iface, "stop"),
    setIdleTimeout: (milliseconds) => invoke(iface, "setIdleTimeout", milliseconds),
    setHumanActiveGuardMs: (milliseconds) => invoke(iface, "setHumanActiveGuardMs", milliseconds),
    setAgentName: (name) => invoke(iface, "setAgentName", name),
    focusWindow: (windowId) => invoke(iface, "focusWindow", windowId),
    raiseWindow: (windowId) => invoke(iface, "raiseWindow", windowId),
    clearFocusWindow: () => invoke(iface, "clearFocusWindow"),
    resetInputDelivery: () => invoke(iface, "resetInputDelivery"),
    movePointer: (x, y) => invoke(iface, "movePointer", x, y),
    button: (code, pressed) => invoke(iface, "button", code, pressed),
    axis: (horizontal, vertical) => invoke(iface, "axis", horizontal, vertical),
    key: (code, pressed) => invoke(iface, "key", code, pressed),
    keys: (strokes) => invoke(iface, "keys", strokes),
    waitForSettle: (windowId, quietMs, timeoutMs) =>
      invokeWithTimeout(
        iface,
        "waitForSettle",
        Math.min(timeoutMs, SETTLE_MAX_TIMEOUT_MS) + KWIN_DBUS_DEFAULT_TIMEOUT_MS,
        windowId,
        quietMs,
        timeoutMs,
      ),
    captureWindow: (windowId, maxDimension, pixels) =>
      invokeWithTimeout(iface, "captureWindow", captureTimeoutMs(pixels), windowId, maxDimension),
    captureRegion: (x, y, width, height, maxDimension) =>
      invokeWithTimeout(
        iface,
        "captureRegion",
        captureTimeoutMs(width * height),
        x,
        y,
        width,
        height,
        maxDimension,
      ),
    captureWindowEx: (windowId, maxDimension, flags, pixels) =>
      invokeWithTimeout(
        iface,
        "captureWindowEx",
        captureTimeoutMs(pixels),
        windowId,
        maxDimension,
        flags,
      ),
    captureRegionEx: (x, y, width, height, maxDimension, flags) =>
      invokeWithTimeout(
        iface,
        "captureRegionEx",
        captureTimeoutMs(width * height),
        x,
        y,
        width,
        height,
        maxDimension,
        flags,
      ),
  };
}

/** A method call on a proxy interface, with its deadline and, if bound, its connection's. */
type DbusInvoke = (
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
) => Promise<unknown>;

export async function invokeKWinDbusMethod(
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  return await invokeKWinDbusMethodOn(undefined, iface, methodName, ...args);
}

/**
 * `invokeKWinDbusMethod` on a watched connection: the call also rejects the
 * moment that connection ends, rather than at its deadline.
 */
export async function invokeKWinDbusMethodOn(
  connection: DbusConnectionWatch | undefined,
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  return await invokeOn(
    connection,
    iface,
    methodName,
    isCaptureMethod(methodName) ? KWIN_DBUS_CAPTURE_TIMEOUT_MS : KWIN_DBUS_DEFAULT_TIMEOUT_MS,
    args,
  );
}

async function invokeOn(
  connection: DbusConnectionWatch | undefined,
  iface: unknown,
  methodName: string,
  timeoutMs: number,
  args: readonly unknown[],
): Promise<unknown> {
  if (typeof iface !== "object" || iface === null) {
    throw new Error(`D-Bus interface ${methodName} is unavailable.`);
  }
  const method = (iface as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`D-Bus method ${methodName} is unavailable.`);
  }
  const start = (): unknown => Reflect.apply(method, iface, args);
  const result = connection ? connection.guard(start) : Promise.resolve(start());
  return await withTimeout(result, timeoutMs, methodName);
}

export function isCaptureMethod(methodName: string): boolean {
  return (
    methodName === "captureWindow" ||
    methodName === "captureRegion" ||
    methodName === "captureWindowEx" ||
    methodName === "captureRegionEx"
  );
}

/**
 * A KWin call that never answers rejects with `KWinDbusTimeoutError`, which the
 * backend reads to decide between a slow call and a gone plugin, so the type
 * matters as much as the message. Failures KWin does report travel untouched,
 * being already about the call rather than the connection.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, methodName: string): Promise<T> {
  return withDbusTimeout(promise, timeoutMs, {
    onTimeout: () => new KWinDbusTimeoutError(methodName, timeoutMs),
  });
}

/**
 * A `b` reply, strictly. The plugin answers every input and session method
 * with a boolean, so anything else is a protocol fault worth failing on rather
 * than reading as "refused" — one reader for KWin's plugin manager and for the
 * plugin itself, so the two cannot disagree about what a non-boolean means.
 */
export function readPluginBoolean(value: unknown): boolean {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped !== "boolean") {
    throw new Error("KWin returned a non-boolean plugin result.");
  }
  return unwrapped;
}

const readBoolean = readPluginBoolean;

/** `undefined` for the void reply a KWin build without a return value sends. */
export function readOptionalBoolean(value: unknown): boolean | undefined {
  const unwrapped = unwrapDbusValue(value);
  return typeof unwrapped === "boolean" ? unwrapped : undefined;
}

export function readStringArray(value: unknown): readonly string[] {
  const unwrapped = unwrapDbusValue(value);
  if (!Array.isArray(unwrapped) || !unwrapped.every((item) => typeof item === "string")) {
    throw new Error("KWin returned an invalid loaded plugin list.");
  }
  return unwrapped;
}
