/**
 * Tier 1 on a Hyprland desktop: the agent drives the human's **real** desktop
 * — real apps, real files, the same session — with a dedicated seat of its
 * own. The Synara Hyprland plugin draws the agent's ghost cursor and injects
 * input directly on target clients' own wl_pointer/wl_keyboard resources; the
 * human's cursor, focus, and seat state are never touched.
 *
 * Everything below the plugin-management layer is `KWinComputerBackend`: the
 * plugin speaks the identical `org.synara.ComputerUse` D-Bus surface, so this
 * class only swaps in what actually differs, through the same option seams the
 * nested backend established —
 *
 * - plugins are managed with `hyprctl` by path instead of KWin's D-Bus plugin
 *   manager (`hyprlandPluginHost.ts`),
 * - installs go to a user-owned data directory and load live, with no env
 *   script and never a relogin (`hyprlandPluginProvisioning.ts`),
 * - availability is gated on a live Hyprland session (instance signature plus
 *   its runtime socket), not on `org.kde.KWin` having a bus owner.
 *
 * The release hotkey story is KWin's: the plugin binds the same Meta+Shift+Esc
 * chord, and `visibleDesktop` stays true, so the panel advertises it.
 */
import { readdir } from "node:fs/promises";

import { COMPUTER_HYPRLAND_BACKEND, type ComputerAvailability } from "@synara/contracts";

import { ComputerBackendError } from "./ComputerBackend.ts";
import {
  detectRunningHyprlandVersion,
  hyprlandInstanceEnvironment,
  makeHyprctlRunner,
  resolveHyprlandInstance,
  type HyprlandInstanceResolution,
  unloadHyprlandPlugin,
  type HyprctlRunner,
} from "./hyprctl.ts";
import {
  createSessionHyprlandComputerDbus,
  type HyprlandComputerDbus,
} from "./hyprlandPluginHost.ts";
import {
  buildHyprlandPluginFromSource,
  detectHyprlandHeadersVersion,
  HYPRLAND_INSTALL_SCRIPT_PATH,
  hyprlandBuildToolingPresent,
  hyprlandInstallIsCurrent,
  hyprlandPluginDirectory,
  hyprlandPluginSourceHash,
  hyprlandStateRoot,
  provisionHyprlandPlugin,
  readHyprlandInstallStamp,
  retireSupersededHyprlandPlugins,
} from "./hyprlandPluginProvisioning.ts";
import { installStampPath } from "./kwinPluginProvisioning.ts";
import { KWinComputerBackend, type KWinComputerBackendOptions } from "./KWinComputerBackend.ts";
import { COMPUTER_SERVICE } from "./kwinDbus.ts";
import { sessionBusNameHasOwner } from "./sessionBusNames.ts";

const NO_HYPRLAND_MESSAGE =
  "No Hyprland session is running (no instance signature with a live socket), " +
  "so there is no Hyprland desktop to drive.";
function ambiguousInstanceMessage(state: { readonly candidates: readonly string[] }): string {
  return (
    `${state.candidates.length} Hyprland sessions are running and none is the one this server ` +
    "was started in, so Synara does not guess which to drive. Set " +
    "SYNARA_HYPRLAND_INSTANCE_SIGNATURE to pick one, or restart Synara inside the session."
  );
}

const NO_PLUGIN_ANYWHERE_MESSAGE =
  "Hyprland is running, but this machine has no Synara computer-use plugin: none is installed, " +
  "and the compiler and Hyprland development headers needed to build one are not present. " +
  `Install them, or build the plugin with ${HYPRLAND_INSTALL_SCRIPT_PATH}.`;

export interface HyprlandComputerBackendOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
  /**
   * An explicit compositor instance, for driving the dev-test nested one.
   * Defaults to `SYNARA_HYPRLAND_INSTANCE_SIGNATURE`, then to the instance this
   * process was started in — so pointing the server at a nested Hyprland is an
   * environment variable rather than a code change.
   */
  readonly signature?: string;
  readonly runHyprctl?: HyprctlRunner;
  /**
   * The live instance to drive right now (see `resolveHyprlandInstance`),
   * replaced in tests to avoid touching the host. A plain signature or
   * `undefined` stands for a live instance or none.
   */
  readonly resolveInstance?: () => Promise<string | HyprlandInstanceResolution | undefined>;
  readonly pluginDirectory?: string;
  readonly stateRoot?: string;
  readonly installStampPath?: string;
  readonly pruneSuperseded?: KWinComputerBackendOptions["pruneSuperseded"];
  readonly buildToolingPresent?: () => boolean;
  /** Whether a name is owned on the ambient session bus; the passive probe. */
  readonly busNameHasOwner?: (name: string) => Promise<boolean>;
  readonly provisionPlugin?: KWinComputerBackendOptions["provisionPlugin"];
  /** See `KWinComputerBackendOptions.idleReleaseMs`. */
  readonly idleReleaseMs?: number;
  /** The Hyprland the installed headers are for; replaced in tests. */
  readonly headersVersion?: () => Promise<string | undefined>;
  readonly dbusFactory?: KWinComputerBackendOptions["dbusFactory"];
  readonly atspi?: KWinComputerBackendOptions["atspi"];
}

/** Mutable box shared with the closures handed to the base constructor. */
interface HyprlandDbusRef {
  dbus: HyprlandComputerDbus | undefined;
  /**
   * The instance the newest resolution found, which every hyprctl call is
   * addressed to. Re-resolved on every connect: a Hyprland restart replaces
   * the instance, and a signature fixed at construction would address the
   * dead one forever.
   */
  instance: string | undefined;
}

export class HyprlandComputerBackend extends KWinComputerBackend {
  private readonly ref: HyprlandDbusRef;
  private readonly hyprlandPlatform: string;
  private readonly hyprlandEnv: NodeJS.ProcessEnv;
  private readonly resolveState: () => Promise<HyprlandInstanceResolution>;
  private readonly hyprlandBusNameHasOwner: (name: string) => Promise<boolean>;
  private readonly pluginDirectory: string;
  private readonly hyprlandBuildToolingPresent: () => boolean;

  constructor(options: HyprlandComputerBackendOptions = {}) {
    const ref: HyprlandDbusRef = { dbus: undefined, instance: undefined };
    const env = options.env ?? process.env;
    const pluginDirectory = options.pluginDirectory ?? hyprlandPluginDirectory(env);
    const stateRoot = options.stateRoot ?? hyprlandStateRoot(env);
    const stampPath = options.installStampPath ?? installStampPath(stateRoot);
    // One resolution of "which compositor is this backend driving", shared by
    // the liveness check, every hyprctl call, and the plugin host: they must
    // never disagree, or the backend reports a live desktop it is not talking
    // to — or worse, talks to the human's while reporting the nested one.
    const resolve =
      options.resolveInstance ??
      (() =>
        resolveHyprlandInstance({
          env,
          ...(options.signature ? { signature: options.signature } : {}),
        }));
    const resolveState = async (): Promise<HyprlandInstanceResolution> => {
      const answer = await resolve();
      const state: HyprlandInstanceResolution =
        typeof answer === "string"
          ? { kind: "live", signature: answer }
          : (answer ?? { kind: "none" });
      ref.instance = state.kind === "live" ? state.signature : undefined;
      return state;
    };
    const runHyprctl = options.runHyprctl ?? makeHyprctlRunner({ signature: () => ref.instance });
    // Memoized per instance, like the base's KWin probe per connection: a
    // compositor cannot change version while it runs, and this runs inside
    // connect retries. A failed read is not memoized, and a new instance —
    // a restart, possibly into an upgraded Hyprland — is asked afresh.
    type VersionMemo = {
      readonly instance: string | undefined;
      readonly promise: Promise<string | undefined>;
    };
    let versionMemo: VersionMemo | undefined;
    const hyprlandVersion = () => {
      const instance = ref.instance;
      if (versionMemo === undefined || versionMemo.instance !== instance) {
        const memo: VersionMemo = {
          instance,
          promise: detectRunningHyprlandVersion(runHyprctl).then((answer) => {
            if (answer === undefined && versionMemo === memo) versionMemo = undefined;
            return answer;
          }),
        };
        versionMemo = memo;
      }
      return versionMemo.promise;
    };
    const headersVersion = options.headersVersion ?? detectHyprlandHeadersVersion;
    const innerDbusFactory =
      options.dbusFactory ??
      (async () =>
        createSessionHyprlandComputerDbus({
          pluginDirectory,
          runHyprctl,
        }));
    super({
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.atspi ? { atspi: options.atspi } : {}),
      ...(options.idleReleaseMs !== undefined ? { idleReleaseMs: options.idleReleaseMs } : {}),
      integrationName: "Hyprland",
      installHint: HYPRLAND_INSTALL_SCRIPT_PATH,
      // A live Hyprland instance is a Wayland session by construction, even
      // when this server was started from a tty that predates it; the gate
      // that matters is the session-presence check in the overrides below.
      sessionType: "wayland",
      pluginDirectories: [pluginDirectory],
      stateRoot,
      installStampPath: stampPath,
      installStampVersionKey: "hyprland_version",
      runningKwinVersion: hyprlandVersion,
      // What a build compiles against: the headers, which run ahead of the
      // compositor between a package upgrade and its restart.
      installedKwinVersion: headersVersion,
      // hyprctl loads by absolute path into the live compositor; there is no
      // session-start search path a relogin would be needed for.
      compositorSeesPluginRoot: () => true,
      // The base clears its own reference on every reconnect and calls the
      // factory fresh; the ref-box keeps the newest adapter reachable so
      // `describeLoadRefusal` can quote Hyprland's actual refusal text.
      dbusFactory: async (context) => {
        const dbus = await innerDbusFactory(context);
        ref.dbus = "lastLoadRefusal" in dbus ? (dbus as HyprlandComputerDbus) : undefined;
        // The instance is what the engine compares across connects: gone is
        // a desktop that may be gone for good, and a different one is a
        // restarted compositor the plugin is loaded into again.
        return {
          ...dbus,
          compositorInstance: async () => {
            const state = await resolveState();
            // Several live instances and no way to pick is "cannot tell", not
            // "none running": the engine must not call the desktop gone (and
            // re-select away from Hyprland) while one is plainly there.
            // hyprctl refuses to run unaddressed, so the connect still fails
            // and the reconnect loop keeps asking.
            if (state.kind === "ambiguous") throw new Error(ambiguousInstanceMessage(state));
            return state.kind === "live" ? state.signature : undefined;
          },
        };
      },
      provisionPlugin:
        options.provisionPlugin ??
        (({ force, signal, onStage }) =>
          provisionHyprlandPlugin({
            ...(signal ? { signal } : {}),
            ...(onStage ? { onStage } : {}),
            force,
            pluginDirectory,
            listInstalled: () => readdir(pluginDirectory).catch(() => [] as string[]),
            hyprlandVersion,
            headersVersion,
            // Provisioning runs again whenever connecting finds nothing
            // loadable — a failed first attempt, a Hyprland upgrade, a Synara
            // update — so "current" is read off the machine. Without it every
            // one of those retries recompiles the plugin for minutes.
            isCurrent: async (running) => {
              const [stamp, files, sourceHash] = await Promise.all([
                readHyprlandInstallStamp(stampPath),
                readdir(pluginDirectory).catch(() => [] as string[]),
                hyprlandPluginSourceHash(),
              ]);
              return hyprlandInstallIsCurrent(stamp, files, running, sourceHash);
            },
            buildFromSource: buildHyprlandPluginFromSource,
            stateRoot,
          })),
      // The engine prunes superseded builds once the new one has loaded and
      // answered its health check. Deleting the file is not enough on
      // Hyprland: it unloads by the path it loaded from, matched against what
      // is on disk, so a still-loaded build whose file is gone can never be
      // unloaded again and keeps the org.synara.ComputerUse name away from its
      // replacement. This hook unloads first and deletes only what that
      // answered for.
      pruneSuperseded:
        options.pruneSuperseded ??
        (async (loadedPluginId) => {
          await retireSupersededHyprlandPlugins({
            pluginDirectory,
            keepPluginId: loadedPluginId,
            unload: (path) => unloadHyprlandPlugin(runHyprctl, path),
          });
        }),
    });
    this.ref = ref;
    this.hyprlandEnv = env;
    this.hyprlandPlatform = options.platform ?? process.platform;
    this.resolveState = resolveState;
    this.hyprlandBusNameHasOwner =
      options.busNameHasOwner ?? ((name) => sessionBusNameHasOwner(name));
    this.pluginDirectory = pluginDirectory;
    this.hyprlandBuildToolingPresent = options.buildToolingPresent ?? hyprlandBuildToolingPresent;
  }

  /**
   * "Could this machine drive Hyprland?", answered without touching the
   * compositor at all — the same contract as the KWin probe, with three ways
   * to be available: a plugin is answering on the bus, one is installed on
   * disk, or this machine could build one.
   *
   * There is no shipped-binary branch, and deliberately so: a Hyprland plugin
   * loads only into the exact commit of Hyprland it was compiled against, and
   * Hyprland ships its own development headers with the compositor package —
   * so a machine running Hyprland can almost always build, and a binary built
   * elsewhere almost never loads. See the note in hyprlandPluginProvisioning.
   */
  override async probeAvailability(): Promise<ComputerAvailability> {
    if (this.hyprlandPlatform !== "linux") {
      return { kind: "unsupported-platform", platform: this.hyprlandPlatform };
    }
    const instance = await this.instanceOrReason();
    if ("reason" in instance) return { kind: "backend-unavailable", message: instance.reason };
    if (await this.hyprlandBusNameHasOwner(COMPUTER_SERVICE).catch(() => false)) {
      return this.availableAsHyprland();
    }
    if ((await this.installedHyprlandPluginFiles()).length > 0) return this.availableAsHyprland();
    try {
      if (this.hyprlandBuildToolingPresent()) return this.availableAsHyprland();
    } catch {
      // An unanswerable question is a "no", not an error.
    }
    return { kind: "backend-unavailable", message: NO_PLUGIN_ANYWHERE_MESSAGE };
  }

  /**
   * The KWin setup gate asks whether this distribution ships KWin 6 and
   * whether the installed KWin is one the plugin builds against — two
   * questions with no bearing on a Hyprland host, where the answer to both is
   * routinely "no" on a machine the Hyprland plugin runs perfectly well on.
   * Hyprland's own version gate is the load itself: `hyprctl plugin load`
   * refuses a build for another Hyprland and says so, and
   * `describeLoadRefusal` passes those words on.
   */
  protected override async assertSetupSupported(): Promise<void> {}

  /** The establishing read, with the backend named as what it actually is. */
  override async availability(): Promise<ComputerAvailability> {
    if (this.hyprlandPlatform === "linux") {
      const instance = await this.instanceOrReason();
      if ("reason" in instance) return { kind: "backend-unavailable", message: instance.reason };
    }
    const availability = await super.availability();
    return availability.kind === "available" ? this.availableAsHyprland() : availability;
  }

  protected override get compositorMissingMessage(): string {
    return NO_HYPRLAND_MESSAGE;
  }

  /**
   * Launched apps and wl-clipboard go to the instance this backend drives —
   * the one resolved now, not the one this process inherited — so after a
   * Hyprland restart they reach the new compositor, and with a pinned
   * dev-test instance they never reach the human's.
   */
  protected override async desktopSessionEnvironment(): Promise<
    Readonly<Record<string, string | undefined>>
  > {
    const instance = await this.instanceOrReason();
    if ("reason" in instance) {
      throw new ComputerBackendError(instance.reason, { retryable: true });
    }
    return await hyprlandInstanceEnvironment(instance.signature, this.hyprlandEnv);
  }

  /** The instance to drive, or why none can be named. */
  private async instanceOrReason(): Promise<
    { readonly signature: string } | { readonly reason: string }
  > {
    const state = await this.resolveState();
    if (state.kind === "live") return { signature: state.signature };
    return {
      reason: state.kind === "ambiguous" ? ambiguousInstanceMessage(state) : NO_HYPRLAND_MESSAGE,
    };
  }

  /**
   * Unlike KWin's wordless `false`, `hyprctl plugin load` names its reason —
   * an ABI mismatch, a missing symbol — so the refusal message leads with
   * Hyprland's own words when the adapter captured them.
   */
  protected override async describeLoadRefusal(pluginId: string): Promise<string> {
    const refusal = this.ref.dbus?.lastLoadRefusal()?.replace(/\.\s*$/, "");
    const cause =
      refusal ??
      "a Hyprland plugin only loads into the exact Hyprland version it was built against";
    return (
      `Hyprland refused to load ${pluginId}: ${cause}. ` +
      `If Hyprland was upgraded, rebuild and reload the plugin with ${HYPRLAND_INSTALL_SCRIPT_PATH}.`
    );
  }

  private availableAsHyprland(): ComputerAvailability {
    return { kind: "available", backend: COMPUTER_HYPRLAND_BACKEND };
  }

  private async installedHyprlandPluginFiles(): Promise<readonly string[]> {
    const entries = await readdir(this.pluginDirectory).catch(() => [] as string[]);
    return entries.filter((name) => /^SynaraComputerUsePluginV\d+\.so$/.test(name));
  }
}
