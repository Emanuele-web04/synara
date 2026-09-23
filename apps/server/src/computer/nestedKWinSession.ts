/**
 * A private KWin this server owns, in one of two modes.
 *
 * A nested session is a dedicated session bus plus a `kwin_wayland` on it.
 * `virtual` is the default: a headless compositor with no display of its own,
 * with the Computer pane as its only screen. `window` is a debugging opt-in:
 * the same compositor running as an ordinary Wayland client of the host, so
 * the isolated desktop is a window on a desktop KWin does not otherwise run. Nothing about the desktop backend
 * changes in either mode: the same KWin plugin loads into the private
 * compositor, and `KWinComputerBackend` reaches it through the same D-Bus
 * surface, only pointed at the private bus.
 *
 * Both modes are opt-in and neither is ever a fallback, including for each
 * other — a nested compositor standing in for a broken desktop would hand an
 * agent an invisible screen and report it as healthy, and a virtual compositor
 * standing in for a windowed one would hand the operator an isolated desktop
 * that is nowhere on screen.
 *
 * The compositor is never restarted behind anyone's back if it dies — in
 * windowed mode the desktop is an ordinary window of the host session, so "it
 * died" is usually "the human closed it", and a window that respawns on its
 * own is a haunting. The session only *reports* that its processes have ended
 * (`exited`); `NestedComputerBackend` reaps a dead session and boots a
 * replacement the next time a user or agent actually uses the desktop,
 * exactly like first use did.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import {
  desktopApplicationEnvironment,
  singleInstanceLaunch,
  withIsolatedProfile,
  type AgentLaunch,
} from "./desktopAppEnvironment.ts";
import {
  createNestedSessionDirectory,
  currentServerIdentity,
  describeNestedSessionProcess,
  newNestedSessionId,
  prepareNestedStateDirectory,
  readChildPids,
  readProcessCommand,
  reapStaleNestedSessions,
  removeNestedSessionMarker,
  writeNestedSessionMarker,
  type NestedSessionMarker,
  type NestedSessionProcess,
  type NestedSessionProcessRole,
  type NestedSessionRegistryDependencies,
} from "./nestedSessionRegistry.ts";
import { teardownChildProcessTree } from "../platform/supervisedProcessTeardown.ts";
import { asRecord, parseJsonPayload } from "./computerGeometry.ts";
import {
  assertServiceOwnerPresent,
  resolveSynaraPluginLoad,
  scanInstalledPluginIds,
  SYSTEM_QT_PLUGIN_ROOTS,
  type DesktopSpawnOptions,
  type KWinComputerBackendOptions,
} from "./KWinComputerBackend.ts";
import { resolveInstallTarget } from "./kwinPluginProvisioning.ts";
import {
  COMPUTER_SERVICE,
  createSessionKWinComputerDbus,
  KWIN_SERVICE,
  waitForSessionBusName,
  type KWinComputerDbus,
} from "./kwinDbus.ts";
import {
  describeProcessError,
  spawnSupervisedProcess,
  startSupervisedProcess,
  type ProcessTreeTeardown,
  type SupervisedProcess,
  type SupervisedSpawn,
} from "./supervisedProcess.ts";
import { spawnClipboardCommand, type ClipboardCommandRunner } from "./wlClipboard.ts";

const DBUS_DAEMON_COMMAND = "dbus-daemon";
const BUS_CONFIG_FILE = "bus.conf";
/** Where distributions install the accessibility bus launcher; it is never on PATH. */
const ATSPI_BUS_LAUNCHER_PATHS = [
  "/usr/libexec/at-spi-bus-launcher",
  "/usr/lib/at-spi-bus-launcher",
  "/usr/lib/at-spi2-core/at-spi-bus-launcher",
  "/usr/libexec/at-spi2-core/at-spi-bus-launcher",
  `/usr/lib/${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-gnu/at-spi2-core/at-spi-bus-launcher`,
];
const ATSPI_BUS_NAME = "org.a11y.Bus";
/** The AT-SPI registry daemon; distributions install it beside the launcher. */
const ATSPI_REGISTRY_COMMAND = "at-spi2-registryd";
const ATSPI_READY_TIMEOUT_MS = 5_000;
/** How long a just-spawned process may take to become itself before the marker gives up. */
const MARKER_RECORD_RETRY_MS = 10;
const MARKER_RECORD_ATTEMPTS = 200;
const KWIN_COMMAND = "kwin_wayland";
const XWAYLAND_COMMAND = "Xwayland";
const DEFAULT_NESTED_WIDTH = 1_920;
const DEFAULT_NESTED_HEIGHT = 1_080;
const MIN_NESTED_DIMENSION = 64;
const MAX_NESTED_DIMENSION = 16_384;
const BUS_ADDRESS_TIMEOUT_MS = 10_000;
const KWIN_READY_TIMEOUT_MS = 30_000;
const NESTED_SIZE_PATTERN = /^(\d+)x(\d+)$/i;
const INSTALL_SCRIPT_PATH = "apps/server/native/computer-use-kwin/scripts/install-and-load.sh";

export interface NestedSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How the private compositor is displayed.
 *
 * `virtual` has no output a human can see, which is the point on a CI runner or
 * a headless host. `window` nests the compositor inside the host session as an
 * ordinary Wayland client, which is the only difference between the two — the
 * bus, the plugin, the seat, and the backend are identical.
 */
export type NestedSessionMode = "virtual" | "window";

export interface NestedKWinSessionOptions {
  readonly mode?: NestedSessionMode;
  readonly size?: NestedSize;
  /**
   * Wayland socket name inside the session's private runtime directory;
   * generated per session, so it is unique even where a consumer forgets the
   * directory and looks for it beside the human's display.
   */
  readonly socketName?: string;
  readonly readyTimeoutMs?: number;
  /** The server's own environment, injected so tests do not read the host display. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  /** Replaced in tests, which must never spawn a compositor. */
  readonly spawnProcess?: SupervisedSpawn;
  /** The process-tree teardown; replaced in tests, which own no real pids. */
  readonly teardownProcessTree?: ProcessTreeTeardown;
  /** Spawns one agent-launched application; a test seam for the same reason. */
  readonly spawnApplication?: (
    app: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcess;
  readonly connectDbus?: (busAddress: string) => Promise<KWinComputerDbus>;
  readonly waitForBusName?: typeof waitForSessionBusName;
  /** Where session markers are written and swept; a test seam for both. */
  readonly registry?: NestedSessionRegistryDependencies;
  /**
   * Start an accessibility bus inside the session, so AT-SPI perception reads
   * this desktop's applications. Off unless the backend's AT-SPI mode is on.
   */
  readonly accessibility?: boolean;
  /**
   * The `at-spi-bus-launcher` to run, or explicitly `undefined` for none;
   * found in the usual places when the key is absent.
   */
  readonly accessibilityLauncher?: string | undefined;
  /**
   * The `at-spi2-registryd` to run beside it, or explicitly `undefined` for
   * none; the one next to the launcher when the key is absent.
   */
  readonly accessibilityRegistry?: string | undefined;
}

export interface NestedKWinSession {
  /**
   * The session's private XDG runtime directory, holding its Wayland and bus
   * sockets. Optional only so test doubles can leave it out.
   */
  readonly runtimeDirectory?: string;
  readonly busAddress: string;
  readonly waylandDisplay: string;
  readonly size: NestedSize;
  /** The plugin id explicitly loaded, after every shadowing id was unloaded. */
  readonly pluginId: string;
  /**
   * The nested Xwayland's display name, so X11 clients can be launched into
   * this session. Undefined only if the compositor started without one.
   */
  readonly xDisplay: string | undefined;
  /**
   * The cookie file KWin wrote for that Xwayland, so X11 clients can
   * authenticate to it. Undefined when the loaded plugin does not report one.
   */
  readonly xAuthority?: string | undefined;
  /**
   * Whether the session runs its own accessibility bus. Without one, nothing
   * answers `org.a11y.Bus` on the private bus — no service is ever activated
   * there — so AT-SPI perception must not be attempted at all.
   */
  readonly accessibility?: boolean;
  /**
   * How one of the session's own processes ended, or `undefined` while both
   * still run. The session's bus address dies with them and never comes back,
   * so a non-`undefined` answer means this session is gone for good — reap it
   * and boot a new one; reconnecting to it can only fail.
   */
  readonly exited: () => string | undefined;
  /**
   * Calls `listener` with that same reason the moment the session ends —
   * once, whichever process went first — so a holder of its bus connection can
   * drop it then rather than learn it from the next call. Returns the
   * unsubscribe. Optional only so test doubles can leave it out.
   */
  readonly onExit?: (listener: (reason: string) => void) => () => void;
  /**
   * How many applications the agent launched here are still running. A
   * session with any is never shut down for being idle: the app is the
   * agent's work in progress. Optional only so test doubles can leave it out.
   */
  readonly liveApplicationCount?: () => number;
  /**
   * Launches an application into this session and keeps it, so the app dies
   * with the desktop it was launched into rather than outliving it as an
   * orphan nothing can find.
   */
  readonly spawnApp: (
    app: string,
    args: readonly string[],
    options?: Partial<DesktopSpawnOptions>,
  ) => ChildProcess;
  readonly dispose: () => Promise<void>;
}

/**
 * Boots the private bus and compositor, then leaves exactly one Synara plugin
 * loaded in it. Rejects with a message naming the step that failed, because
 * that message is all the availability card can show an operator.
 */
export async function startNestedKWinSession(
  options: NestedKWinSessionOptions = {},
): Promise<NestedKWinSession> {
  const spawnProcess = options.spawnProcess ?? spawnSupervisedProcess;
  const connectDbus =
    options.connectDbus ?? ((busAddress: string) => createSessionKWinComputerDbus({ busAddress }));
  const waitForBusName = options.waitForBusName ?? waitForSessionBusName;
  const installedPluginIds = options.installedPluginIds ?? (() => scanInstalledPluginIds());
  const mode = options.mode ?? "virtual";
  const hostEnv = options.hostEnv ?? process.env;
  const size = normalizeNestedSize(options.size);
  const sessionId = newNestedSessionId();
  // Short, because a Unix socket path has 107 bytes and this one sits three
  // directories deep in a home cache on hosts without a runtime directory; and
  // never a generic `wayland-0`, so a consumer that forgets the session's
  // runtime directory finds nothing rather than the human's display.
  const waylandDisplay = options.socketName ?? `synara-${sessionId.split("-").at(-1)}`;
  const children: SupervisedProcess[] = [];
  const launchedApps = new Set<ChildProcess>();
  // Profiles made for Flatpak apps inside their own ~/.var/app; everything
  // else lives in the runtime directory and goes with it.
  const agentProfiles = new Set<string>();
  // Resolved from the ambient runtime directory, before this session invents
  // one of its own: a marker written inside a private directory that this
  // session's own teardown deletes is a marker only a live server can find,
  // which is exactly the server that does not need it.
  const registry: NestedSessionRegistryDependencies = { hostEnv, ...options.registry };
  let runtimeDirectory: string | undefined;
  let marker: SessionMarkerWriter | undefined;
  let firstExit: string | undefined;
  const exitListeners = new Set<(reason: string) => void>();
  let disposal: Promise<void> | undefined;
  const disposeHandle = Symbol(waylandDisplay);
  const dispose = () => (disposal ??= disposeSession());
  const disposeSession = async () => {
    // Applications first: they are clients of this compositor, and reaping the
    // compositor out from under them turns an orderly exit into a crash — and
    // leaves whatever ignored the broken socket running with nothing to draw
    // on. Each goes down as a tree, because an app that forked a helper is the
    // ordinary case, not the exotic one.
    await Promise.all(
      [...launchedApps].map((child) =>
        teardownChildProcessTree(child, options.teardownProcessTree).catch(() => undefined),
      ),
    );
    launchedApps.clear();
    forgetLiveSession(disposeHandle);
    // Newest first: the compositor is torn down before the bus it announced
    // itself on, which keeps its exit from racing a dead bus.
    for (const child of children.toReversed()) await child.terminate();
    await marker?.remove();
    if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
    for (const profile of agentProfiles) await rm(profile, { recursive: true, force: true });
    agentProfiles.clear();
  };

  try {
    // Before anything of this session's own exists: a server that was killed
    // rather than shut down left a whole desktop running, and this is the only
    // thing that will ever end it.
    await reapStaleNestedSessions(registry).catch(() => undefined);
    if (mode === "window" && !hostEnv.WAYLAND_DISPLAY) {
      throw new ComputerBackendError(
        "A windowed nested session needs a running Wayland session to nest into, and " +
          `WAYLAND_DISPLAY is not set for this server. Start Synara from the desktop session, or ` +
          "use SYNARA_COMPUTER_NESTED=1 for a headless virtual session.",
      );
    }
    // The session's own XDG runtime directory, private to it: its sockets, the
    // compositor's Xwayland cookie, and every app it launches live there, not
    // in the human's runtime directory beside their own display and bus.
    const stateDirectory = await prepareNestedStateDirectory(registry);
    runtimeDirectory = await createNestedSessionDirectory(stateDirectory, sessionId, registry);
    // Written before the first process exists and kept current as each one is
    // spawned, so a server killed mid-boot still leaves a marker naming
    // everything it started.
    marker = new SessionMarkerWriter(
      {
        ...currentServerIdentity(registry),
        sessionId,
        startedAt: Date.now(),
        waylandDisplay,
        runtimeDirectory,
      },
      registry,
    );

    // Never the stock session.conf: its service directories would let any app
    // on this bus activate a portal, a notification daemon or an a11y bus —
    // started by the bus daemon, outside this session's control, on whatever
    // display the daemon's environment names.
    const busConfig = join(runtimeDirectory, BUS_CONFIG_FILE);
    await writeFile(busConfig, nestedBusConfig(runtimeDirectory), { mode: 0o600 });
    const bus = start(
      spawnProcess,
      options.teardownProcessTree,
      children,
      DBUS_DAEMON_COMMAND,
      ["--config-file", busConfig, "--print-address=1", "--nofork"],
      nestedHelperEnvironment(hostEnv, { XDG_RUNTIME_DIR: runtimeDirectory }),
    );
    marker.record(bus.pid, "bus");
    const busAddress = await bus.readFirstStdoutLine(BUS_ADDRESS_TIMEOUT_MS);
    if (!busAddress.startsWith("unix:")) {
      throw new ComputerBackendError(
        `${DBUS_DAEMON_COMMAND} printed no usable bus address for the nested session.`,
      );
    }

    const kwin = start(
      spawnProcess,
      options.teardownProcessTree,
      children,
      KWIN_COMMAND,
      compositorArgs(mode, waylandDisplay, size),
      compositorEnv(busAddress, mode, hostEnv, runtimeDirectory),
      // stdout is the undrained-buffer hazard; stderr stays piped because its
      // diagnostics are what a failed session's error names.
      ["ignore", "ignore", "pipe"],
    );
    marker.record(kwin.pid, "compositor");

    const timeoutMs = options.readyTimeoutMs ?? KWIN_READY_TIMEOUT_MS;
    const ready = await waitForBusName({
      busAddress,
      name: KWIN_SERVICE,
      timeoutMs,
      abort: () => kwin.exitDiagnostic() !== undefined,
    });
    if (!ready) throw kwinNotReadyError(kwin, mode, timeoutMs);

    const dbus = await connectDbus(busAddress);
    let pluginId: string;
    let xServer: NestedXServer;
    try {
      pluginId = await loadNestedPlugin(dbus, await installedPluginIds());
      xServer = await readXServer(dbus);
    } finally {
      await dbus.close().catch(() => undefined);
    }
    // KWin forks its Xwayland itself; recorded so a sweep can end an Xwayland
    // that outlived a compositor killed without its tree.
    for (const pid of readChildPids(kwin.pid)) {
      if (basename(readProcessCommand(pid)?.split(" ")[0] ?? "") === XWAYLAND_COMMAND)
        marker.record(pid, "xwayland");
    }
    const coordinates = { runtimeDirectory, busAddress, waylandDisplay, ...xServer };
    const launcher =
      "accessibilityLauncher" in options ? options.accessibilityLauncher : findAtspiBusLauncher();
    const accessibility = options.accessibility
      ? await startAccessibilityBus({
          launcher,
          registry:
            "accessibilityRegistry" in options
              ? options.accessibilityRegistry
              : findAtspiRegistry(launcher),
          env: nestedHelperEnvironment(hostEnv, nestedSessionEnv(coordinates)),
          busAddress,
          spawnProcess,
          teardownProcessTree: options.teardownProcessTree,
          children,
          marker,
          waitForBusName,
        })
      : false;
    const sessionMarker = marker;
    const session: NestedKWinSession = {
      ...coordinates,
      size,
      pluginId,
      accessibility,
      // The compositor is what the human can close; the bus daemon only dies
      // with the server or a crash. Either one ending ends the session, and
      // the *first* ending is the reason worth reporting: the second is this
      // module's own teardown signal.
      exited: () => firstExit ?? kwin.exitDiagnostic() ?? bus.exitDiagnostic(),
      onExit: (listener) => {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      liveApplicationCount: () => launchedApps.size,
      spawnApp: (app, args, spawnOptions) =>
        spawnIntoSession(
          session,
          launchedApps,
          agentProfiles,
          sessionMarker,
          app,
          args,
          spawnOptions,
          options.spawnApplication,
        ),
      dispose,
    };
    // The self-heal the whole reconnect path depends on. The private bus
    // outlives the compositor by default, so a dead kwin_wayland leaves every
    // D-Bus client holding a connection that is open and useless: no
    // disconnect ever fires, nothing invalidates, and the next action fails
    // with NameHasNoOwner instead of the backend reporting a dormant desktop.
    // Ending the whole session — the bus included — makes that disconnect real.
    // The last resort, for an exit no finalizer gets to run for — an uncaught
    // exception, an explicit process.exit. Synchronous because an `exit`
    // handler is the last synchronous moment this process has: a promise
    // scheduled here never resolves.
    registerLiveSession(disposeHandle, () => [
      kwin.pid,
      bus.pid,
      // Read when the hook fires, not when the session booted: every app the
      // agent launches after this point belongs to the session too.
      ...[...launchedApps].map((child) => child.pid),
    ]);
    const endSession = (reason: string) => {
      if (firstExit === undefined) {
        firstExit = reason;
        for (const listener of exitListeners) {
          try {
            listener(reason);
          } catch {
            // One holder's failure must not keep the session from ending.
          }
        }
        exitListeners.clear();
      }
      void dispose().catch(() => undefined);
    };
    kwin.onExit(endSession);
    bus.onExit(endSession);
    return session;
  } catch (error) {
    await dispose();
    throw error instanceof ComputerBackendError
      ? error
      : new ComputerBackendError(describeProcessError(error), {
          cause: error,
        });
  }
}

/**
 * The session's marker, rewritten whenever it gains or loses a process.
 *
 * Writes are chained so two updates can never land out of order, and each one
 * is best effort: a marker that could not be written costs a crashed server's
 * cleanup, never the desktop itself.
 */
class SessionMarkerWriter {
  private readonly processes = new Map<number, NestedSessionProcess>();
  private readonly retries = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly ownCommand: string | undefined;
  private chain: Promise<void> = Promise.resolve();
  private path: string | undefined;
  private removed = false;

  constructor(
    private readonly base: Omit<NestedSessionMarker, "processes">,
    private readonly registry: NestedSessionRegistryDependencies,
  ) {
    this.ownCommand = (registry.processCommand ?? readProcessCommand)(
      registry.serverPid ?? process.pid,
    );
    this.flush();
  }

  /**
   * Records a process as soon as it is the program it was spawned as. A
   * runtime that spawns through vfork (Bun does) can return before the exec,
   * when the child's cmdline is still this server's own or momentarily empty;
   * such a child is retried briefly rather than recorded under the wrong name
   * or not at all.
   */
  record(pid: number | undefined, role: NestedSessionProcessRole, attempt = 0): void {
    if (pid === undefined || this.removed) return;
    const entry = describeNestedSessionProcess(pid, role, this.registry);
    if (entry && entry.command !== this.ownCommand) {
      this.processes.set(entry.pid, entry);
      this.flush();
      return;
    }
    if (attempt >= MARKER_RECORD_ATTEMPTS) return;
    const retry = setTimeout(() => {
      this.retries.delete(pid);
      this.record(pid, role, attempt + 1);
    }, MARKER_RECORD_RETRY_MS);
    retry.unref?.();
    this.retries.set(pid, retry);
  }

  forget(pid: number | undefined): void {
    if (pid === undefined) return;
    const retry = this.retries.get(pid);
    if (retry !== undefined) clearTimeout(retry);
    this.retries.delete(pid);
    if (this.processes.delete(pid)) this.flush();
  }

  async remove(): Promise<void> {
    this.removed = true;
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
    await this.chain;
    if (this.path) await removeNestedSessionMarker(this.path);
  }

  private flush(): void {
    if (this.removed) return;
    const marker: NestedSessionMarker = { ...this.base, processes: [...this.processes.values()] };
    this.chain = this.chain
      .then(() => writeNestedSessionMarker(marker, this.registry))
      .then(
        (path) => {
          this.path = path;
        },
        () => undefined,
      );
  }
}

/** Environment that puts a child process inside the nested session. */
export function nestedSessionEnv(session: {
  readonly runtimeDirectory?: string;
  readonly busAddress: string;
  readonly waylandDisplay: string;
  readonly xDisplay?: string | undefined;
  readonly xAuthority?: string | undefined;
}): Record<string, string> {
  return {
    // A KWin that generates a cookie for its Xwayland refuses an X11 client
    // holding the human's XAUTHORITY instead, so the plugin's report of that
    // cookie wins. With no report — KWin started directly runs Xwayland without
    // a cookie and admits its own user by si:localuser — the caller's value is
    // left as it was.
    ...(session.xAuthority ? { XAUTHORITY: session.xAuthority } : {}),
    ...(session.runtimeDirectory ? { XDG_RUNTIME_DIR: session.runtimeDirectory } : {}),
    WAYLAND_DISPLAY: session.waylandDisplay,
    DBUS_SESSION_BUS_ADDRESS: session.busAddress,
    // Always set, never merely omitted. A child inherits the server's own
    // environment underneath this one, so an absent key leaves the human's
    // DISPLAY in place and an X11 client opens on their screen while the agent
    // drives the nested one. Empty is a display name Xlib rejects, so a client
    // with nowhere to go fails instead of going somewhere wrong.
    DISPLAY: session.xDisplay ?? "",
    // Qt defaults to whatever platform plugin the ambient session suggests, and
    // an app that picks xcb here would never reach the nested compositor.
    QT_QPA_PLATFORM: "wayland",
  };
}

/**
 * Whether the nested session's own accessibility perception is used.
 *
 * `session` starts an accessibility bus inside the session (the private bus
 * activates nothing, so it never appears on its own), which keeps both the
 * applications and the AT-SPI helper on the nested desktop rather than the
 * human's. `off` stays the default: perception on a nested desktop reads only
 * applications that enable accessibility, and costs a bus daemon and a
 * registry per session.
 */
export type NestedAtspiMode = "off" | "session";

export interface NestedBackendOptions {
  readonly mode?: NestedSessionMode;
  readonly atspiMode?: NestedAtspiMode;
  /** Dials a session's private bus; a test seam. */
  readonly connectDbus?: (busAddress: string) => Promise<KWinComputerDbus>;
  /**
   * Builds the AT-SPI client for one nested session's environment. A test
   * seam: the default spawns the Python helper against that session's bus.
   */
  readonly createAtspiClient?: (env: NodeJS.ProcessEnv) => AtspiTreeReader;
  /**
   * The server's environment, scrubbed into what the session's AT-SPI helper
   * starts with (see `nestedAtspiEnvironment`). Defaults to `process.env`.
   */
  readonly hostEnv?: NodeJS.ProcessEnv;
}

/**
 * Backend options that bind a `KWinComputerBackend` to a nested session.
 *
 * The session is resolved on every use rather than captured, because the
 * backend that owns these options is built before its session exists and
 * outlives each one: a compositor that dies is replaced on the next real use,
 * and options holding the dead session's bus address would point the
 * replacement at an address nothing listens on. This is the one description of
 * how a nested session is driven — the lazily-booting backend composes it, so
 * the integration test that boots a real compositor validates the same
 * configuration production runs.
 */
export function nestedKWinBackendOptions(
  resolveSession: () => NestedKWinSession | undefined,
  options: NestedBackendOptions = {},
): KWinComputerBackendOptions {
  const mode = options.mode ?? "virtual";
  const connectDbus =
    options.connectDbus ?? ((busAddress: string) => createSessionKWinComputerDbus({ busAddress }));
  return {
    // Dialled per connect, never captured: a fixed address would keep pointing
    // a reconnect at the bus of a session that has since been replaced.
    dbusFactory: async () => await connectDbus(requireSession(resolveSession).busAddress),
    // The private bus is born owned by a compositor this process started; the
    // ambient session bus the default check would ask knows nothing about it.
    busNamesHaveOwners: async (names) => names.map(() => true),
    // The compositor here is spawned with the plugin root already on its
    // QT_PLUGIN_PATH, so a fresh install loads without anyone logging out; the
    // default check reads the server's session environment and would tell the
    // user to relogin a session this plugin never loads into.
    compositorSeesPluginRoot: () => true,
    // A windowed nested compositor is an ordinary window of the host session,
    // so its desktop genuinely is on screen; the headless one has no output at
    // all and the Computer pane is the only view onto it.
    visibleDesktop: mode === "window",
    // Nobody watches a headless pointer move: the pane shows stills a couple
    // of times a second, so a glide there is only latency on every action.
    ...(mode === "window" ? {} : { glideDurationMs: 0 }),
    // The nested compositor is a Wayland session even when the server was
    // started from a tty or a CI runner with no session at all, so the platform
    // gate must not read the ambient session type.
    sessionType: "wayland",
    spawnProcess: (app, args, spawnOptions) =>
      requireSession(resolveSession).spawnApp(app, args, spawnOptions),
    runClipboardCommand: (spec) =>
      nestedClipboardRunner(nestedSessionEnv(requireSession(resolveSession)))(spec),
    atspi: nestedAtspiReader(resolveSession, options),
  };
}

/**
 * Launches one application into a nested session.
 *
 * Never detached. A detached app is a process group of its own that survives
 * the session it was launched into, which is how an agent's `kcalc` ends up
 * still running an hour after the desktop it belonged to was torn down, with
 * nothing left that knows its pid. Keeping it a child means the session's
 * teardown can end it, and the marker a crashed server leaves behind names it.
 *
 * The environment is the scrubbed desktop environment, not this server's:
 * the executable is chosen by the agent, so handing it the server's tokens and
 * process knobs would make one app launch worth every secret this process has.
 */
function spawnIntoSession(
  session: NestedKWinSession,
  launchedApps: Set<ChildProcess>,
  agentProfiles: Set<string>,
  marker: SessionMarkerWriter,
  requestedApp: string,
  requestedArgs: readonly string[],
  spawnOptions: Partial<DesktopSpawnOptions> | undefined,
  spawnApplication?: NestedKWinSessionOptions["spawnApplication"],
): ChildProcess {
  const { command: app, args } = isolatedFromHostInstances(
    { command: requestedApp, args: requestedArgs },
    session,
    spawnOptions?.env?.HOME ?? process.env.HOME ?? homedir(),
    agentProfiles,
  );
  // The caller's environment has already been scrubbed once by the backend;
  // scrubbing again is idempotent and keeps this safe for any other caller.
  // The session's own coordinates go on top, because a launch into the nested
  // desktop that inherited the human's WAYLAND_DISPLAY would open on theirs.
  const env = desktopApplicationEnvironment(spawnOptions?.env ?? process.env, {
    ...nestedSessionEnv(session),
  });
  const cwd = spawnOptions?.cwd;
  const child = spawnApplication
    ? spawnApplication(app, [...args], env)
    : spawn(app, [...args], {
        stdio: "ignore",
        env,
        ...(cwd ? { cwd } : {}),
      });
  launchedApps.add(child);
  // Recorded as the session's own, so a server that dies without disposing
  // the session still leaves a marker that names the app for the next sweep.
  marker.record(child.pid, "app");
  const forget = () => {
    launchedApps.delete(child);
    marker.forget(child.pid);
  };
  child.once("exit", forget);
  child.once("error", forget);
  return child;
}

/**
 * A single-instance program launched into the nested desktop with a profile
 * of its own. The nested session shares the human's home, so Chromium, an
 * Electron app or LibreOffice started with the default profile finds the
 * human's running instance through that profile (or the temp directory it
 * derives its pipe from), hands it the launch and exits — and the window
 * opens on the human's desktop. With a profile of its own it can only find
 * instances the agent started in this session. The profile is per session:
 * in the session's runtime directory, or for a Flatpak app, which sees only
 * its own `~/.var/app/<id>`, under that app's cache (removed with the
 * session). A desktop entry launched through `gio` takes no arguments, so
 * such a program is refused there rather than launched unbound.
 */
function isolatedFromHostInstances(
  launch: AgentLaunch,
  session: NestedKWinSession,
  home: string,
  agentProfiles: Set<string>,
): AgentLaunch {
  const program = singleInstanceLaunch(launch);
  if (!program) return launch;
  const refuse = (why: string) =>
    new ComputerBackendError(
      `${program.name} keeps one running instance per profile, and ${why}, so it would open ` +
        "on the human's desktop instead of the agent's. It was not started.",
    );
  if (program.desktopEntry) {
    throw refuse(
      "its desktop entry cannot be given a separate profile; launch the program by name instead",
    );
  }
  const sessionDirectory = session.runtimeDirectory;
  if (!sessionDirectory) throw refuse("this desktop has no private directory to keep one in");
  const profileName = program.name.replace(/[^A-Za-z0-9._-]/g, "_");
  let profile: string;
  if (program.flatpakAppId) {
    profile = join(
      home,
      ".var",
      "app",
      program.flatpakAppId,
      "cache",
      "synara-agent-profiles",
      basename(sessionDirectory),
    );
    agentProfiles.add(profile);
  } else {
    profile = join(sessionDirectory, "profiles", profileName);
  }
  return withIsolatedProfile(launch, program, profile);
}

function requireSession(resolveSession: () => NestedKWinSession | undefined): NestedKWinSession {
  const session = resolveSession();
  if (!session) {
    throw new ComputerBackendError("The agent's isolated desktop is not running.");
  }
  return session;
}

/**
 * Session-mode AT-SPI has to wait for a session to exist, so the reader is a
 * shell that builds the real client on first use. Off remains the default —
 * see the note on `NestedAtspiMode` for why a per-user registry makes
 * "session" an opt-in for hosts that actually run one on the nested bus.
 *
 * The client carries one session's private bus address in its environment, so
 * it is only as alive as that session. A compositor that died and was replaced
 * gets a replacement client too; the old one is disposed rather than left
 * answering from a bus that is gone.
 */
function nestedAtspiReader(
  resolveSession: () => NestedKWinSession | undefined,
  options: NestedBackendOptions,
): AtspiTreeReader {
  if ((options.atspiMode ?? "off") !== "session") return unavailableAtspiReader();
  const createClient =
    options.createAtspiClient ??
    ((env: NodeJS.ProcessEnv) => new AtspiHelperClient({ env, inheritEnv: false }));
  const hostEnv = options.hostEnv ?? process.env;
  let current:
    | { readonly session: NestedKWinSession; readonly client: AtspiTreeReader }
    | undefined;
  const ready = async (): Promise<AtspiTreeReader | undefined> => {
    const session = resolveSession();
    if (current && current.session !== session) {
      const stale = current;
      current = undefined;
      await stale.client.dispose().catch(() => undefined);
    }
    // No accessibility bus in the session means nothing answers org.a11y.Bus,
    // and a helper asked to read trees there has nothing to read.
    if (!session || session.accessibility === false) return undefined;
    current ??= { session, client: createClient(nestedAtspiEnvironment(session, hostEnv)) };
    return current.client;
  };
  return {
    readTrees: async (windows, readOptions) =>
      (await (await ready())?.readTrees(windows, readOptions)) ?? [],
    setText: async (write) => (await (await ready())?.setText(write)) ?? false,
    validateNode: async (check) => {
      const client = await ready();
      return (await client?.validateNode?.(check)) ?? { ok: false, reason: "unavailable" };
    },
    probe: async () => {
      await (await ready())?.probe?.();
    },
    // Only the current session's client can have latched; a replaced session
    // starts over with a fresh one.
    unavailableReason: () => current?.client.unavailableReason?.(),
    // A client belongs to one session: letting the desktop go (idle shutdown,
    // a desktop that ended) ends its helper too, and the next read builds a
    // client for whatever session is current then.
    release: async () => {
      const stale = current;
      current = undefined;
      await stale?.client.dispose();
    },
    dispose: async () => {
      const stale = current;
      current = undefined;
      await stale?.client.dispose();
    },
  };
}

/**
 * The AT-SPI helper's whole environment for one nested session: the session
 * helpers' allowlist of the server's own (`nestedHelperEnvironment`: no
 * tokens, no host `AT_SPI_BUS_ADDRESS`, which would point it at the human's
 * accessibility bus) with the session's coordinates on top, plus the Python
 * and helper knobs it reads.
 */
export function nestedAtspiEnvironment(
  session: Parameters<typeof nestedSessionEnv>[0],
  hostEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const helperKnobs: Record<string, string> = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (name === "PYTHONPATH" || name === "PYTHONHOME" || name.startsWith("SYNARA_ATSPI_")) {
      helperKnobs[name] = value;
    }
  }
  return nestedHelperEnvironment(hostEnv, { ...helperKnobs, ...nestedSessionEnv(session) });
}

/** wl-clipboard against the nested compositor's own seat rather than seat0. */
export function nestedClipboardRunner(env: NodeJS.ProcessEnv): ClipboardCommandRunner {
  return (spec) => spawnClipboardCommand(spec, env);
}

/**
 * Semantic perception turned off. Reporting no trees is what the backend
 * already handles for an application without accessibility support, so
 * coordinate actions, window listing, and capture stay fully usable.
 */
export function unavailableAtspiReader(): AtspiTreeReader {
  return {
    readTrees: async () => [],
    setText: async () => false,
    dispose: async () => undefined,
  };
}

/**
 * `SYNARA_COMPUTER_NESTED` is the only way a nested session is ever booted, and
 * it names the mode: `1` for virtual, `window` for windowed. Anything else, a
 * typo included, leaves the real desktop backend in place rather than guessing a
 * mode — booting the wrong one is either an invisible desktop or a window the
 * operator never asked for.
 */
export function nestedSessionMode(
  env: NodeJS.ProcessEnv = process.env,
): NestedSessionMode | undefined {
  switch (env.SYNARA_COMPUTER_NESTED) {
    case "1":
      return "virtual";
    case "window":
      return "window";
    default:
      return undefined;
  }
}

/** The mode as it reads in a failure message an operator has to act on. */
export function nestedModeLabel(mode: NestedSessionMode): string {
  return mode === "window" ? "windowed" : "virtual";
}

export function nestedAtspiMode(env: NodeJS.ProcessEnv = process.env): NestedAtspiMode {
  return env.SYNARA_COMPUTER_NESTED_ATSPI === "1" ? "session" : "off";
}

/**
 * `SYNARA_COMPUTER_NESTED_SIZE` is an operator override, so a typo must neither
 * crash the server nor boot a compositor of some accidental size: anything that
 * is not `WxH` within the supported range is dropped and the default applies.
 */
export function parseNestedSizeEnv(value: string | undefined): NestedSize | undefined {
  const match = value === undefined ? null : NESTED_SIZE_PATTERN.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!inNestedDimensionRange(width) || !inNestedDimensionRange(height)) return undefined;
  return { width, height };
}

/**
 * KWin auto-loads every installed plugin version at compositor startup, so the
 * fresh nested session almost always begins with several stale generations
 * loaded. `resolveSynaraPluginLoad` owns the unload-all-then-load-newest
 * doctrine; this only adds the nested session's error sentences.
 */
/** The nested Xwayland, as the plugin inside the compositor reports it. */
interface NestedXServer {
  readonly xDisplay: string | undefined;
  readonly xAuthority: string | undefined;
}

/**
 * The nested Xwayland's display name and cookie file, which only the plugin
 * can answer.
 *
 * KWin picks the number for the Xwayland it starts, generates the cookie
 * file, and publishes both by setenv on itself: nothing appears on the bus and
 * nothing usable appears in its output. The plugin runs inside that process,
 * so it reads the variables and reports them. A failure here is not fatal -
 * Wayland clients need neither.
 */
async function readXServer(dbus: KWinComputerDbus): Promise<NestedXServer> {
  try {
    const plugin = await dbus.connectPlugin();
    const health = asRecord(parseJsonPayload(await plugin.healthJson()));
    return {
      xDisplay: nonEmptyString(health.xDisplay),
      xAuthority: nonEmptyString(health.xAuthority),
    };
  } catch {
    return { xDisplay: undefined, xAuthority: undefined };
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function loadNestedPlugin(
  dbus: KWinComputerDbus,
  installed: readonly string[],
): Promise<string> {
  // Who owns the well-known name before anything is loaded, so a load that
  // leaves the previous holder in place is refused rather than driven. The
  // nested session owns its bus, so a mismatch here means an unload race
  // against this process's own previous generation.
  const ownerBefore = await dbus.nameOwner(COMPUTER_SERVICE);
  const instanceBefore = ownerBefore
    ? await dbus
        .connectPlugin()
        .then((plugin) => plugin.instanceId)
        .catch(() => undefined)
    : undefined;
  const plan = resolveSynaraPluginLoad({ loaded: await dbus.listLoadedPluginIds(), installed });
  if (!plan) {
    throw new ComputerBackendError(
      "No installed SynaraComputerUsePluginVn was found for the nested KWin session. " +
        `Build and install it with ${INSTALL_SCRIPT_PATH}.`,
    );
  }
  if (plan.kind === "replace") {
    for (const pluginId of plan.unload) await dbus.unloadPlugin(pluginId);
    if (!(await dbus.loadPlugin(plan.pluginId))) {
      throw new NestedPluginLoadRefusedError(
        plan.pluginId,
        `The nested KWin session refused to load ${plan.pluginId}: a KWin plugin only loads into ` +
          `the exact KWin version it was built against. Rebuild it with ${INSTALL_SCRIPT_PATH}.`,
      );
    }
    assertServiceOwnerPresent(await dbus.nameOwner(COMPUTER_SERVICE));
    const instanceAfter = (await dbus.connectPlugin()).instanceId;
    if (instanceBefore !== undefined && instanceBefore === instanceAfter)
      throw new ComputerBackendError(
        "The nested compositor did not replace the previous computer plugin instance.",
      );
  } else {
    assertServiceOwnerPresent(await dbus.nameOwner(COMPUTER_SERVICE));
  }
  return plan.pluginId;
}

/**
 * The compositor refused the plugin it was told to load.
 *
 * Its own type, not a message to match: a KWin plugin is a binary module bound
 * to the exact KWin version it was compiled against, so this is the one boot
 * failure a *reinstall* can fix, and the caller has to be able to tell it apart
 * from every other reason a session did not come up without reading English.
 */
export class NestedPluginLoadRefusedError extends ComputerBackendError {
  readonly pluginId: string;

  constructor(pluginId: string, message: string) {
    super(message);
    this.name = "NestedPluginLoadRefusedError";
    this.pluginId = pluginId;
  }
}

/** Names which of the two ways the compositor can fail to appear happened. */
function kwinNotReadyError(
  kwin: SupervisedProcess,
  mode: NestedSessionMode,
  timeoutMs: number,
): ComputerBackendError {
  const exit = kwin.exitDiagnostic();
  // The one failure every non-KDE machine hits first, so it names the package
  // instead of the errno: the nested desktop is KWin running as a window of the
  // host session, whichever compositor that session runs, and installing kwin
  // does not switch anyone's desktop.
  if (exit?.includes("ENOENT")) {
    return new ComputerBackendError(
      `${KWIN_COMMAND} is not installed, and the agent's isolated desktop is KWin running as ` +
        "a window of this session. Open Settings → Computer use and click Set up to install " +
        "it, or install the kwin package (kwin-wayland on Debian and Ubuntu) yourself; it " +
        "will not change which desktop this machine runs.",
    );
  }
  const nested = `The nested ${KWIN_COMMAND} (${nestedModeLabel(mode)} mode)`;
  return new ComputerBackendError(
    exit === undefined
      ? `${nested} did not take ${KWIN_SERVICE} within ${timeoutMs} ms.${kwin.diagnostic()}`
      : `${nested} exited before it was ready (${exit}).${kwin.diagnostic()}`,
  );
}

/** `--virtual` is the whole difference: without it the compositor nests as a client. */
function compositorArgs(
  mode: NestedSessionMode,
  socketName: string,
  size: NestedSize,
): readonly string[] {
  return [
    ...(mode === "virtual" ? ["--virtual"] : []),
    // X11 clients are one of the two families the agent's dedicated seat on the
    // human's desktop cannot reach, and this session is where they are supposed
    // to be driven instead, so it has to be able to run them at all.
    "--xwayland",
    "--no-global-shortcuts",
    // The agent's desktop is not the human's seat: without this, KWin joins
    // the logind session it was started from and locks with the human's
    // screen, and every call is refused with SessionLocked until they unlock.
    "--no-lockscreen",
    "--socket",
    socketName,
    "--width",
    String(size.width),
    "--height",
    String(size.height),
  ];
}

/**
 * The compositor's environment: the helper allowlist plus the session's own
 * bus and runtime directory. A virtual compositor must not inherit the ambient
 * display: with WAYLAND_DISPLAY or DISPLAY set, kwin_wayland can attach to the
 * very session a nested one exists to stay independent of. A windowed one is the exact
 * opposite — the host WAYLAND_DISPLAY is the socket it nests through, and
 * without it there is no window; it is resolved to a path because the
 * compositor's runtime directory is the session's own, not the host's. DISPLAY
 * goes in both modes, because an X11 attach is never what either was asked for.
 */
function compositorEnv(
  busAddress: string,
  mode: NestedSessionMode,
  hostEnv: NodeJS.ProcessEnv,
  runtimeDirectory: string,
): NodeJS.ProcessEnv {
  return nestedHelperEnvironment(hostEnv, {
    XDG_RUNTIME_DIR: runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: busAddress,
    // Nobody but the agent uses this compositor, so the plugin drives its one
    // seat as an ordinary input device instead of adding a second seat nothing
    // has to bind. That is what lets Chromium, Electron, and every X11 client
    // behind Xwayland be driven here: they each keep only the first seat, and
    // here the first seat is the one being driven.
    SYNARA_COMPUTER_USE_OWNS_COMPOSITOR: "1",
    // Provisioning installs the plugin under the user's home Qt plugin root
    // and teaches the *Plasma* session about it through an env script sourced
    // at login. This compositor is spawned by the server on hosts that mostly
    // are not Plasma, so the same root has to ride the environment here or the
    // freshly installed plugin is invisible to the very KWin booted to load it.
    QT_PLUGIN_PATH: prependQtPluginRoot(hostEnv.QT_PLUGIN_PATH),
    // The helper environment never carries a display; the windowed mode is
    // the one deliberate exception, because nesting is what it was asked for.
    ...(mode === "window" ? { WAYLAND_DISPLAY: hostWaylandSocket(hostEnv) } : {}),
  });
}

/** Exact variable names the session's own helpers inherit from the server. */
const HELPER_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "XCURSOR_THEME",
  "XCURSOR_SIZE",
  "XCURSOR_PATH",
  "DRI_PRIME",
]);

/** Locale and graphics-driver selection, which the compositor needs to render at all. */
const HELPER_ENVIRONMENT_PREFIXES: readonly string[] = [
  "LC_",
  "MESA_",
  "LIBGL_",
  "__GLX_",
  "__EGL_",
  "VK_",
];

/**
 * The environment of the session's own processes — its bus daemon, its
 * compositor, its accessibility bus — as an allowlist over the server's.
 *
 * Narrower than what a launched application gets, because these processes
 * start others on their own (KWin starts Xwayland; a bus could start anything)
 * and whatever they inherit, those inherit too. The server's environment
 * carries the human's display (`WAYLAND_DISPLAY`, `DISPLAY`, `XAUTHORITY`),
 * their compositor's signature (`HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`),
 * their session bus and session identity, and Synara's own secrets; none of
 * that may reach a process whose whole job is to be somewhere else.
 * `overrides` are the session's own coordinates and are applied verbatim.
 */
export function nestedHelperEnvironment(
  hostEnv: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (
      HELPER_ENVIRONMENT_NAMES.has(name) ||
      HELPER_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * The private bus's configuration: a session bus listening only inside the
 * session's own runtime directory, authenticating by uid, and with no service
 * directories at all — so nothing is ever activated on it. A call to a name
 * nobody owns (a portal, a notification daemon, `org.a11y.Bus`) fails with
 * `ServiceUnknown` instead of starting a process with this bus's environment.
 */
export function nestedBusConfig(runtimeDirectory: string): string {
  const address = xmlEscape(`unix:dir=${escapeDbusAddressValue(runtimeDirectory)}`);
  return [
    '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
    "<busconfig>",
    "  <type>session</type>",
    "  <keep_umask/>",
    `  <listen>${address}</listen>`,
    "  <auth>EXTERNAL</auth>",
    '  <policy context="default">',
    '    <allow send_destination="*" eavesdrop="true"/>',
    '    <allow eavesdrop="true"/>',
    '    <allow own="*"/>',
    "  </policy>",
    "</busconfig>",
    "",
  ].join("\n");
}

/** A D-Bus address value: bytes outside the optionally-escaped set become %XX. */
function escapeDbusAddressValue(value: string): string {
  let escaped = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    escaped += /[-0-9A-Za-z_/.*]/.test(character)
      ? character
      : `%${byte.toString(16).padStart(2, "0")}`;
  }
  return escaped;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The installed `at-spi-bus-launcher`, if any. */
function findAtspiBusLauncher(exists: (path: string) => boolean = existsSync): string | undefined {
  return ATSPI_BUS_LAUNCHER_PATHS.find((path) => exists(path));
}

/** The `at-spi2-registryd` installed beside `launcher`, if any. */
function findAtspiRegistry(
  launcher: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (!launcher) return undefined;
  const registry = join(dirname(launcher), ATSPI_REGISTRY_COMMAND);
  return exists(registry) ? registry : undefined;
}

/**
 * Starts an accessibility bus inside the session and reports whether it came
 * up. Explicitly, because the private bus activates nothing: this launcher is
 * the one `org.a11y.Bus` the session's applications and the AT-SPI helper will
 * find, and it runs with the session's display, bus and runtime directory, so
 * its own bus (and `$XDG_RUNTIME_DIR/at-spi/bus`) lives inside the session too.
 *
 * The registry is started here as well, as a child of the session. Left to
 * activation, it never came up: a launcher built for dbus-broker runs the
 * accessibility bus through `dbus-broker-launch`, which activates services as
 * units of the user's systemd manager — outside the session, with the human's
 * bus and runtime directory — and that activation fails. The launcher is told
 * to use `dbus-daemon` (which the session already requires), so anything else
 * the accessibility bus activates stays in the session's environment.
 *
 * Never fatal. A desktop without perception is still a desktop; the session
 * reports `accessibility: false` and the reader stays off rather than asking a
 * bus that is not there.
 */
async function startAccessibilityBus(options: {
  readonly launcher: string | undefined;
  readonly registry: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly busAddress: string;
  readonly spawnProcess: SupervisedSpawn;
  readonly teardownProcessTree: ProcessTreeTeardown | undefined;
  readonly children: SupervisedProcess[];
  readonly marker: SessionMarkerWriter;
  readonly waitForBusName: typeof waitForSessionBusName;
}): Promise<boolean> {
  if (!options.launcher) return false;
  let launcher: SupervisedProcess;
  try {
    launcher = start(
      options.spawnProcess,
      options.teardownProcessTree,
      options.children,
      options.launcher,
      ["--launch-immediately"],
      { ...options.env, ATSPI_DBUS_IMPLEMENTATION: "dbus-daemon" },
      ["ignore", "ignore", "pipe"],
    );
  } catch {
    return false;
  }
  options.marker.record(launcher.pid, "accessibility");
  const up = await options
    .waitForBusName({
      busAddress: options.busAddress,
      name: ATSPI_BUS_NAME,
      timeoutMs: ATSPI_READY_TIMEOUT_MS,
      abort: () => launcher.exitDiagnostic() !== undefined,
    })
    .catch(() => false);
  if (!up || !options.registry) return up;
  // It finds the accessibility bus through org.a11y.Bus on the session's bus.
  // No --use-gnome-session: there is no session manager here to register with.
  try {
    const registry = start(
      options.spawnProcess,
      options.teardownProcessTree,
      options.children,
      options.registry,
      [],
      options.env,
      ["ignore", "ignore", "pipe"],
    );
    options.marker.record(registry.pid, "accessibility-registry");
  } catch {
    // Without it the accessibility bus still activates one on first use.
  }
  return true;
}

/** The host's Wayland socket as a path, which libwayland accepts in WAYLAND_DISPLAY. */
function hostWaylandSocket(hostEnv: NodeJS.ProcessEnv): string | undefined {
  const display = hostEnv.WAYLAND_DISPLAY;
  if (!display || isAbsolute(display)) return display;
  return hostEnv.XDG_RUNTIME_DIR ? join(hostEnv.XDG_RUNTIME_DIR, display) : display;
}

function prependQtPluginRoot(existing: string | undefined): string {
  const root = resolveInstallTarget(SYSTEM_QT_PLUGIN_ROOTS).qtPluginRoot;
  if (!existing) return root;
  return existing.split(":").includes(root) ? existing : `${root}:${existing}`;
}

/**
 * Starts one child and registers it for disposal. Both nested processes are
 * ordinary children so a signal to the server's process group reaches them too,
 * and both are unref'd so they never keep the server alive. Dispose is what
 * reliably ends them.
 */
function start(
  spawnProcess: NonNullable<NestedKWinSessionOptions["spawnProcess"]>,
  teardownProcessTree: ProcessTreeTeardown | undefined,
  children: SupervisedProcess[],
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  /**
   * Non-piped streams for this child. kwin_wayland's stdout is chatty and
   * nobody reads it: left piped and undrained it fills its ~64 KiB buffer and
   * blocks the compositor mid-frame while health still reports connected.
   */
  stdio?: StdioOptions,
): SupervisedProcess {
  const supervised = startSupervisedProcess({
    command,
    args,
    env,
    ...(stdio ? { stdio } : {}),
    ...(teardownProcessTree ? { teardownProcessTree } : {}),
    spawnProcess,
  });
  children.push(supervised);
  return supervised;
}

function normalizeNestedSize(size: NestedSize | undefined): NestedSize {
  return {
    width: normalizeNestedDimension(size?.width, DEFAULT_NESTED_WIDTH),
    height: normalizeNestedDimension(size?.height, DEFAULT_NESTED_HEIGHT),
  };
}

function normalizeNestedDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_NESTED_DIMENSION, Math.min(MAX_NESTED_DIMENSION, Math.floor(value)));
}

function inNestedDimensionRange(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_NESTED_DIMENSION && value <= MAX_NESTED_DIMENSION;
}

/**
 * Sessions this process currently owns, and the one `exit` hook that kills them.
 *
 * The orderly paths are elsewhere: `dispose()` ends a session, and the server's
 * shutdown disposes the backend that owns it. This covers only what those
 * cannot — an uncaught exception, an explicit `process.exit` — where the last
 * synchronous moment of the process is the last chance anything has to stop a
 * compositor from outliving it. A crash that takes the process without running
 * handlers at all is covered by the session marker instead, which the next
 * server sweeps.
 */
type LiveSessionPids = () => ReadonlyArray<number | undefined>;

const LIVE_SESSIONS = new Map<symbol, LiveSessionPids>();
let exitHookInstalled = false;

function registerLiveSession(handle: symbol, pids: LiveSessionPids): void {
  LIVE_SESSIONS.set(handle, pids);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const owned of LIVE_SESSIONS.values()) {
      for (const pid of owned()) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone, or never ours to signal. Either way there is nothing
          // left to do and nothing left to report it to.
        }
      }
    }
    LIVE_SESSIONS.clear();
  });
}

function forgetLiveSession(handle: symbol): void {
  LIVE_SESSIONS.delete(handle);
}
