/**
 * Getting the Hyprland plugin onto a machine that has never seen it.
 *
 * Structurally the KWin story (`kwinPluginProvisioning.ts`) minus its three
 * hardest parts. There is no env script and no relogin: Hyprland loads a
 * plugin by absolute path through `hyprctl plugin load`, live, from anywhere
 * on disk — so the install directory needs no compositor-visible search path,
 * and the very first install works in the session it happened in. What remains
 * shared — the `V<n>` generation numbering, the copy-install — is imported from
 * the KWin module rather than restated, because "how a versioned binary lands
 * in the user's home" should have one definition.
 *
 * The third missing part is shipped binaries, and their absence is a decision
 * rather than an omission. A Hyprland plugin is validated against the exact
 * commit of Hyprland it was compiled against, on a compositor whose users are
 * overwhelmingly on rolling distributions — so a binary built in CI matches
 * almost nobody by the time it ships, and when it does match it still has to
 * agree with the host's `sdbus-c++`, `cairo` and `libstdc++` sonames. The
 * inverse of KWin also holds: Hyprland ships its development headers *in the
 * compositor package itself*, so a machine running Hyprland can nearly always
 * compile, which is exactly the population a prebuilt would have served. An
 * operator who does want to ship a binary drops it in
 * `SYNARA_HYPRLAND_PLUGIN_DIR`, where it is loaded or refused by Hyprland with
 * its own words — no manifest, no version matrix, nothing to go stale.
 *
 * The `V<n>` naming still matters here even without KWin's plugin pinning:
 * overwriting a `.so` that a live compositor has dlopened corrupts the mapped
 * image, so every install must be a new file. Retiring old ones is the subtle
 * part — see `retireSupersededHyprlandPlugins`.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { withProvisioningFileLock } from "./provisioning/fileLock.ts";
import { buildPluginFromSource } from "./provisioning/sourceBuild.ts";
import {
  commandOnPath,
  pkgConfigModulePresent,
  type PathExists,
} from "./provisioning/buildToolingProbe.ts";
import {
  allocatePluginId,
  installPluginBytes,
  installStampPath,
  pluginIdNumber,
  type ProvisionAction,
  type ProvisionResult,
  type ProvisionStage,
} from "./kwinPluginProvisioning.ts";

export const HYPRLAND_INSTALL_SCRIPT_PATH =
  "apps/server/native/computer-use-hyprland/scripts/install-and-load.sh";

/**
 * The pkg-config modules the plugin Makefile compiles and links through (its
 * `PKGS`; keep the two lists in sync). `pkg-config --cflags` fails outright
 * when any one of them is missing, so each one's `.pc` file is part of the
 * "could a source build proceed" signal, not just Hyprland's own.
 */
const HYPRLAND_BUILD_PKGCONFIG_MODULES = [
  "hyprland",
  "pixman-1",
  "libdrm",
  "sdbus-c++",
  "cairo",
  "xkbcommon",
  "libturbojpeg",
  "libpng",
] as const;
const HYPRLAND_BUILD_COMMANDS = ["g++", "make", "pkg-config"] as const;

/** The sources the built `.so` is a function of; see `hyprlandPluginSourceHash`. */
const HYPRLAND_PLUGIN_SOURCE_FILES = [
  "Makefile",
  "synarahyprlandplugin.cpp",
  "capturetransform.h",
  "sessionauth.h",
] as const;

const INSTALLED_PLUGIN_FILE = /^SynaraComputerUsePluginV(\d+)\.so$/;

/** Where installed plugin generations live; user-owned, no sudo anywhere. */
export function hyprlandPluginDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.SYNARA_HYPRLAND_PLUGIN_DIR;
  if (configured) return resolve(configured);
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "synara", "hyprland-computer-use", "plugins");
}

/**
 * `STATE_ROOT` in scripts/install-and-load.sh: the install stamp a later load
 * refusal reads back, and the plugin id counter the script shares with the
 * server. Same role and same layout as the KWin state root, one directory over.
 */
export function hyprlandStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return (
    env.SYNARA_HYPRLAND_STATE_ROOT ??
    join(
      env.XDG_STATE_HOME || join(home, ".local", "state"),
      "synara",
      "hyprland-computer-use-plugin",
    )
  );
}

/** Mirrors the KWin stamp's role: what was installed, for refusal messages. */
export function hyprlandInstallStampPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return installStampPath(hyprlandStateRoot(env, home));
}

/**
 * Whether this machine could compile the plugin: every pkg-config module the
 * Makefile resolves, and the commands it runs. Only existence checks, like the
 * KWin probe. Modules hyprland.pc itself `Requires:` (aquamarine, hyprutils,
 * libinput, ...) are not followed, since that would mean reading it; they ship
 * with Hyprland's own packages, and the install script reports each missing
 * package by name when it actually runs.
 */
export function hyprlandBuildToolingPresent(
  exists: PathExists = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    HYPRLAND_BUILD_PKGCONFIG_MODULES.every((module) =>
      pkgConfigModulePresent(module, exists, env),
    ) && HYPRLAND_BUILD_COMMANDS.every((command) => commandOnPath(command, exists, env))
  );
}

/** The plugin sources on disk, bundled beside this module or up in native/. */
export function resolveHyprlandSourceDirectory(
  moduleDirectory: string = import.meta.dirname,
  configuredDirectory: string | undefined = process.env.SYNARA_HYPRLAND_SOURCE_DIR,
  sourceExists: (candidate: string) => boolean = existsSync,
): string {
  const candidates = [
    ...(configuredDirectory ? [resolve(configuredDirectory)] : []),
    join(moduleDirectory, "computer-use-hyprland"),
  ];
  return (
    candidates.find((candidate) => sourceExists(join(candidate, "Makefile"))) ??
    join(moduleDirectory, "..", "..", "native", "computer-use-hyprland")
  );
}

/** The installer script on disk, bundled beside this module or up in native/. */
export function resolveHyprlandInstallScriptPath(
  moduleDirectory: string = import.meta.dirname,
  configuredDirectory: string | undefined = process.env.SYNARA_HYPRLAND_SOURCE_DIR,
  sourceExists: (candidate: string) => boolean = existsSync,
): string {
  const relative = join("scripts", "install-and-load.sh");
  const candidates = [
    ...(configuredDirectory ? [join(resolve(configuredDirectory), relative)] : []),
    join(moduleDirectory, "computer-use-hyprland", relative),
  ];
  return (
    candidates.find(sourceExists) ??
    join(moduleDirectory, "..", "..", "native", "computer-use-hyprland", relative)
  );
}

/**
 * What the installed `.so` is a function of, on the source side.
 *
 * Without it, "is the install current" can only ask whether Hyprland changed —
 * so a Synara update that rewrites the plugin would be answered with the
 * previous build until the compositor happened to be upgraded. `undefined`
 * means the sources are not on this machine (a packaged build), which is also
 * the case where no source build could happen anyway, so the version check
 * stands alone rather than forcing a rebuild that cannot run.
 */
export async function hyprlandPluginSourceHash(
  directory: string = resolveHyprlandSourceDirectory(),
): Promise<string | undefined> {
  const digest = createHash("sha256");
  for (const name of HYPRLAND_PLUGIN_SOURCE_FILES) {
    const bytes = await readFile(join(directory, name)).catch(() => undefined);
    if (!bytes) return undefined;
    digest.update(name);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

export async function readHyprlandInstallStamp(path: string): Promise<string | undefined> {
  return await readFile(path, "utf8").catch(() => undefined);
}

function stampField(stamp: string | undefined, field: string): string | undefined {
  const value = stamp
    ?.split("\n")
    .find((line) => line.startsWith(`${field}=`))
    ?.slice(field.length + 1)
    .trim();
  return value || undefined;
}

/**
 * Whether the stamp describes a plugin this machine still has and the running
 * Hyprland can still load.
 *
 * This is the gate that keeps a failed connect cheap. Provisioning runs again
 * on every reconnect that finds nothing loadable, and a source build is minutes
 * of compilation, so without an answer here a compositor that refuses the
 * plugin for any other reason recompiles it on a loop.
 *
 * Current means: the stamped file is still there, it was built for the running
 * Hyprland when both versions are readable, and it was built from the plugin
 * sources this checkout has. A stamp too old to carry a source hash is not
 * current — it is rebuilt once, and every stamp after it carries one.
 */
export function hyprlandInstallIsCurrent(
  stamp: string | undefined,
  installedFiles: readonly string[],
  runningHyprlandVersion: string | undefined,
  sourceHash: string | undefined,
): boolean {
  const pluginId = stampField(stamp, "plugin_id");
  if (!pluginId) return false;
  if (!installedFiles.includes(`${pluginId}.so`)) return false;
  const builtFor = stampField(stamp, "hyprland_version");
  if (builtFor && runningHyprlandVersion && builtFor !== runningHyprlandVersion) return false;
  if (sourceHash && stampField(stamp, "source_hash") !== sourceHash) return false;
  return true;
}

export interface HyprlandProvisionDependencies {
  readonly signal?: AbortSignal;
  /** Install again even when the stamp calls the install current. */
  readonly force?: boolean;
  readonly pluginDirectory: string;
  /** Files already in the plugin directory, for the version suffix. */
  readonly listInstalled: () => Promise<readonly string[]>;
  /** The Hyprland actually running, or undefined if it cannot be read. */
  readonly hyprlandVersion: () => Promise<string | undefined>;
  /**
   * The Hyprland the installed development headers describe (`pkg-config
   * --modversion hyprland`), which is what a build compiles against. Absent
   * or unreadable, the build goes ahead as before.
   */
  readonly headersVersion?: () => Promise<string | undefined>;
  /** Whether an install for this exact Hyprland and these sources is in place. */
  readonly isCurrent: (hyprlandVersion: string | undefined) => Promise<boolean>;
  /** Builds against the local headers and resolves the built `.so`. */
  readonly buildFromSource: (signal: AbortSignal | undefined) => Promise<string>;
  /**
   * The state directory shared with scripts/install-and-load.sh: the install
   * stamp and the plugin id counter live here. See `hyprlandStateRoot`.
   */
  readonly stateRoot: string;
  readonly sourceHash?: () => Promise<string | undefined>;
  readonly writeStamp?: (path: string, record: HyprlandInstallRecord) => Promise<void>;
  /** Told each stage as the run reaches it; see `ProvisionStage`. */
  readonly onStage?: (stage: ProvisionStage) => void;
  readonly now?: () => Date;
}

export interface HyprlandInstallRecord {
  readonly pluginId: string;
  readonly pluginPath: string;
  readonly hyprlandVersion: string | undefined;
  readonly sourceHash: string | undefined;
  readonly installedAt: string;
}

/**
 * Install the plugin if it is not already installed and current.
 *
 * Deliberately does not load it — loading is the backend's job, exactly as in
 * the KWin flow. It does *unload* the generations it is about to delete, which
 * is not the same thing: see `retireSupersededHyprlandPlugins`.
 */
export async function provisionHyprlandPlugin(
  deps: HyprlandProvisionDependencies,
): Promise<ProvisionResult> {
  return withProvisioningFileLock(
    join(deps.pluginDirectory, ".synara-provision.lock"),
    (signal) => {
      deps.onStage?.("installing");
      return provisionHyprlandPluginLocked({ ...deps, signal });
    },
    deps.signal,
    { onLockRequested: () => deps.onStage?.("waiting-for-lock") },
  );
}

async function provisionHyprlandPluginLocked(
  deps: HyprlandProvisionDependencies,
): Promise<ProvisionResult> {
  deps.signal?.throwIfAborted();
  const pluginDirectory = deps.pluginDirectory;
  const version = await deps.hyprlandVersion();
  if (!deps.force && (await deps.isCurrent(version))) {
    return {
      action: "already-current" satisfies ProvisionAction,
      pluginDirectory,
      requiresRelogin: false,
      summary: "The computer-use plugin is installed and current.",
    };
  }

  // R13: a Hyprland upgraded on disk but not restarted refuses a plugin
  // built against the new headers, and building one costs minutes for a
  // load that cannot succeed. Only the restart helps, so that is the answer.
  const headers = await deps.headersVersion?.().catch(() => undefined);
  if (headers !== undefined && version !== undefined && headers !== version) {
    return {
      action: "already-current" satisfies ProvisionAction,
      pluginDirectory,
      requiresRelogin: true,
      summary:
        `Hyprland ${headers} is installed, but Hyprland ${version} is still running, and a ` +
        "plugin built now would only load into the new one. Restart Hyprland (log out and back " +
        "in), then use the computer again.",
    };
  }

  // Bytes, not a path: the file that was read is the file that lands, and
  // `installPluginBytes` fsyncs and renames it into place so a compositor
  // scanning the directory can never see a half-written `.so`.
  deps.onStage?.("building");
  const bytes = await readFile(await deps.buildFromSource(deps.signal));
  deps.signal?.throwIfAborted();

  const pluginId = await allocatePluginId({
    stateRoot: deps.stateRoot,
    existingFiles: [
      ...(await deps.listInstalled()),
      ...(await readdir(pluginDirectory).catch(() => [] as string[])),
    ],
  });
  deps.signal?.throwIfAborted();
  const pluginPath = await installPluginBytes(bytes, pluginDirectory, pluginId);
  // Superseded builds stay on disk here, exactly as in the KWin flow: until
  // the new id has loaded and answered its health check, the old file is the
  // build the user is running. The backend retires them afterwards, through
  // `retireSupersededHyprlandPlugins`.
  await (deps.writeStamp ?? writeHyprlandInstallStamp)(installStampPath(deps.stateRoot), {
    pluginId,
    pluginPath,
    hyprlandVersion: version,
    sourceHash: await (deps.sourceHash ?? hyprlandPluginSourceHash)(),
    installedAt: (deps.now?.() ?? new Date()).toISOString(),
  });

  return {
    action: "installed-from-source",
    pluginId,
    pluginDirectory,
    // hyprctl loads by absolute path into the live compositor; there is no
    // session-start search path, so no install ever needs a relogin.
    requiresRelogin: false,
    summary: "The computer-use plugin is installed and ready.",
  };
}

export interface RetiredHyprlandPlugins {
  readonly removed: readonly string[];
  /** Paths whose load state Hyprland would not answer for; left on disk. */
  readonly stuck: readonly string[];
}

/**
 * Unload every superseded generation, then delete the ones that are proven * gone — in that order, and never the other way round.
 *
 * Hyprland unloads a plugin by the path string it loaded it from, and matches
 * it against what is on disk. Deleting first therefore strands the running
 * generation permanently: it is still mapped, still registered, still holding
 * the `org.synara.ComputerUse` name the new build needs, and there is no longer
 * any path that names it. That is a desktop only a compositor restart can
 * recover, produced by a routine update — which is why the KWin engine's plain
 * `pruneSupersededPlugins` is not enough here and the backend hands this in as
 * its prune hook instead.
 *
 * Called by the backend once the new build has loaded and passed its health
 * check, never by provisioning: before that, the old file is the build the user
 * is running. Only builds numbered below the loaded one are touched, matching
 * `pruneSupersededPlugins`.
 */
export async function retireSupersededHyprlandPlugins(options: {
  readonly pluginDirectory: string;
  readonly keepPluginId: string;
  readonly unload?: (pluginPath: string) => Promise<boolean>;
}): Promise<RetiredHyprlandPlugins> {
  const keep = pluginIdNumber(options.keepPluginId);
  const entries = await readdir(options.pluginDirectory).catch(() => [] as string[]);
  const candidates = entries
    .filter((name) => {
      const match = INSTALLED_PLUGIN_FILE.exec(name);
      return match?.[1] !== undefined && Number(match[1]) < keep;
    })
    .map((name) => join(options.pluginDirectory, name));

  const removed: string[] = [];
  const stuck: string[] = [];
  for (const path of candidates) {
    if (options.unload) {
      try {
        await options.unload(path);
      } catch {
        // Hyprland answered something neither "ok" nor "not loaded", so
        // whether this build is still running is unknown. Keeping the file is
        // the recoverable half of that: it stays addressable, and the next
        // install tries again.
        stuck.push(path);
        continue;
      }
    }
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed, stuck };
}

/**
 * The Hyprland version the installed development headers describe, read the
 * way the plugin's Makefile resolves them. A spawn of `pkg-config`, which
 * reads files and touches no compositor; undefined when it cannot answer.
 */
export function detectHyprlandHeadersVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "pkg-config",
      ["--modversion", "hyprland"],
      {
        timeout: 5_000,
        // A scrubbed environment, but not one that forgets where this
        // machine's .pc files are: a Hyprland built into a prefix is found
        // only through these, the same way the Makefile's pkg-config finds it.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...pickDefined(process.env, [
            "PKG_CONFIG_PATH",
            "PKG_CONFIG_LIBDIR",
            "PKG_CONFIG_SYSROOT_DIR",
          ]),
        },
      },
      (error, stdout) => {
        const version = stdout.trim();
        resolve(error || !/^\d+(?:\.\d+)+$/.test(version) ? undefined : version);
      },
    );
  });
}

function pickDefined(env: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/**
 * Builds the plugin against the local Hyprland headers and resolves the built
 * `.so`, through the same cancellable runner the KWin build uses: this is a
 * `make` above a `g++` above `cc1plus`, and an abort that only kills the shell
 * leaves the compiler running for minutes on a machine whose user cancelled —
 * or past the server's own `dispose()`.
 */
export async function buildHyprlandPluginFromSource(
  signal: AbortSignal | undefined,
): Promise<string> {
  return buildPluginFromSource({ scriptPath: resolveHyprlandInstallScriptPath(), signal });
}

/** The stamp the install script also writes, keyed by Hyprland version. */
export async function writeHyprlandInstallStamp(
  path: string,
  record: HyprlandInstallRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Temp-plus-rename, matching install-and-load.sh: a crash mid-write would
  // leave a half-read stamp answering "is this current" wrongly forever.
  const staged = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(
      staged,
      [
        `plugin_id=${record.pluginId}`,
        `installed_at=${record.installedAt}`,
        `plugin_path=${record.pluginPath}`,
        `hyprland_version=${record.hyprlandVersion ?? ""}`,
        `source_hash=${record.sourceHash ?? ""}`,
        "",
      ].join("\n"),
    );
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
}
