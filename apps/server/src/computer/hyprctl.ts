/**
 * The `hyprctl` surface the Hyprland backend depends on, isolated because the
 * tool's contract is easy to misread: **a command the compositor answered
 * exits 0 whatever the answer was**, so every verdict here is parsed out of
 * the reply text rather than the exit code. `plugin load /path.so` answers
 * `ok` on success and `Plugin <path> could not be loaded: <reason>` on
 * failure — same exit code both ways. A non-zero exit means hyprctl never got
 * an answer at all: the instance it was pointed at is gone (`-i <dead>` exits
 * 4 on 0.56) or the binary is missing. This module owns that parsing so
 * nothing else in the tree ever looks at an exit status and draws the wrong
 * conclusion.
 *
 * Verified against Hyprland 0.56 (`src/debug/HyprCtl.cpp`): `plugin list -j`
 * reports `{name, author, handle, version, description}` per plugin — no path —
 * while `plugin load`/`plugin unload` address plugins **by absolute path**
 * (unload matches via `getPluginByPath`). That asymmetry is why the Synara
 * plugin self-reports its module path in `healthJson`: the name in the list
 * cannot tell the server which installed `.so` is the one answering the bus.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import { ComputerBackendError } from "./ComputerBackend.ts";

/** Set by Hyprland in every process of the session; names the instance. */
export const HYPRLAND_SIGNATURE_ENV = "HYPRLAND_INSTANCE_SIGNATURE";

/**
 * Names the instance Synara should drive, overriding the one this process
 * inherited. Set it to a nested dev-test compositor's signature and every
 * `hyprctl` call, the liveness check, and the backend selection follow it —
 * which is what keeps dev-testing off the human's own desktop without a code
 * edit. `scripts/dev-instance.sh` prints the value to use.
 */
export const SYNARA_HYPRLAND_SIGNATURE_ENV = "SYNARA_HYPRLAND_INSTANCE_SIGNATURE";

/** The name the Synara plugin registers with Hyprland's plugin system. */
export const HYPRLAND_PLUGIN_NAME = "synara-computer-use";

const HYPRCTL_TIMEOUT_MS = 10_000;

/**
 * The instance every part of the Hyprland backend addresses: the explicit
 * override when one is set, otherwise the one this process was started in.
 *
 * A signature is a directory name under `$XDG_RUNTIME_DIR/hypr`, so anything
 * that could escape that directory is not a signature at all and is rejected
 * here rather than at each of the places that join it onto a path.
 */
export function hyprlandInstanceSignature(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of [SYNARA_HYPRLAND_SIGNATURE_ENV, HYPRLAND_SIGNATURE_ENV]) {
    const value = env[name]?.trim();
    if (value) return isSignature(value) ? value : undefined;
  }
  return undefined;
}

function isSignature(value: string): boolean {
  return !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Whether the named Hyprland instance is live right now.
 *
 * The signature alone is not enough: it survives into terminals spawned before
 * a compositor crash, and into nested sessions this process started itself. The
 * instance's runtime directory is the liveness check — Hyprland creates
 * `$XDG_RUNTIME_DIR/hypr/<signature>/` at startup and its `.socket.sock` is how
 * `hyprctl` itself reaches the compositor.
 */
export async function hyprlandInstancePresent(
  signature: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  connects: (path: string) => boolean | Promise<boolean> = socketAcceptsConnections,
): Promise<boolean> {
  const directory = hyprlandInstanceDirectory(signature, env);
  return directory === undefined ? false : connects(join(directory, ".socket.sock"));
}

/** `$XDG_RUNTIME_DIR/hypr/<signature>`, when both are there to name it. */
function hyprlandInstanceDirectory(
  signature: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!signature || !isSignature(signature)) return undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  return runtimeDir ? join(runtimeDir, "hypr", signature) : undefined;
}

/**
 * The environment a process started for `signature` needs to land on that
 * compositor: its signature, and the Wayland socket Hyprland records on the
 * second line of the instance's `hyprland.lock` (what `hyprctl instances`
 * reports as `wl_socket`).
 *
 * The inherited `WAYLAND_DISPLAY` and `DISPLAY` are right only for the
 * instance this process was started in. For another one — the compositor that
 * replaced it after a restart, or a pinned dev-test instance — they name a
 * dead socket or, worse, the human's own desktop, where a launched window
 * must never appear. So for another instance `WAYLAND_DISPLAY` comes from its
 * lock, and `DISPLAY` (whose Xwayland no file names) is removed: an X11-only
 * app then fails to start rather than opening somewhere else. A lock that
 * cannot be read or names no socket is a refusal: removing `WAYLAND_DISPLAY`
 * is not neutral, because a Wayland client without it connects to
 * `wayland-0`, which is usually the human's session.
 */
export async function hyprlandInstanceEnvironment(
  signature: string,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Readonly<Record<string, string | undefined>>> {
  const directory = hyprlandInstanceDirectory(signature, env);
  const lock = directory
    ? await read(join(directory, "hyprland.lock")).catch(() => undefined)
    : undefined;
  const socket = lock?.split("\n")[1]?.trim();
  const waylandDisplay = socket && !socket.includes("/") ? socket : undefined;
  if (env[HYPRLAND_SIGNATURE_ENV]?.trim() === signature) {
    return {
      [HYPRLAND_SIGNATURE_ENV]: signature,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {}),
    };
  }
  if (!waylandDisplay) {
    throw new ComputerBackendError(
      `The Wayland socket of Hyprland instance ${signature} could not be read from its ` +
        "hyprland.lock, so nothing is started there: without it an app would open on the " +
        "default Wayland display instead.",
      { retryable: true },
    );
  }
  return {
    [HYPRLAND_SIGNATURE_ENV]: signature,
    WAYLAND_DISPLAY: waylandDisplay,
    DISPLAY: undefined,
  };
}

export interface LiveHyprlandInstanceOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** An explicit instance, as the backend's `signature` option names one. */
  readonly signature?: string;
  readonly connects?: (path: string) => boolean | Promise<boolean>;
  /** The instance directories under `$XDG_RUNTIME_DIR/hypr`; tests replace it. */
  readonly listInstances?: (directory: string) => Promise<readonly string[]>;
}

/**
 * What resolving the instance to drive found: the one, none at all, or several
 * live instances with nothing to choose between them (the inherited one died
 * and more than one other is running — a restarted session beside a dev-test
 * instance). Ambiguous is not none: a desktop is there, this module just does
 * not guess which, so nothing may call it gone.
 */
export type HyprlandInstanceResolution =
  | { readonly kind: "live"; readonly signature: string }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

/**
 * The Hyprland instance to drive right now, or `undefined` when there is none
 * or several are candidates; see `resolveHyprlandInstance`.
 */
export async function resolveLiveHyprlandInstance(
  options: LiveHyprlandInstanceOptions = {},
): Promise<string | undefined> {
  const resolution = await resolveHyprlandInstance(options);
  return resolution.kind === "live" ? resolution.signature : undefined;
}

/**
 * The Hyprland instance to drive right now.
 *
 * Resolved per use rather than once at startup, because the signature this
 * process inherited dies with the compositor: after a Hyprland restart every
 * `hyprctl -i <old>` fails and nothing recovers until the server restarts.
 *
 * - A pinned instance (the backend's `signature`, or
 *   `SYNARA_HYPRLAND_INSTANCE_SIGNATURE`) is the only candidate. Pinning is
 *   how dev-testing is kept on a nested compositor, so it never falls back to
 *   another instance — least of all the human's.
 * - Otherwise the inherited `HYPRLAND_INSTANCE_SIGNATURE`, while it is live.
 * - Once it is not, the instance that replaced it: the one live instance under
 *   the same runtime directory. Several to choose between is `ambiguous`, not
 *   an answer. A process that inherited no signature at all was not started
 *   in a Hyprland session and does not go looking for one.
 */
export async function resolveHyprlandInstance(
  options: LiveHyprlandInstanceOptions = {},
): Promise<HyprlandInstanceResolution> {
  const none = { kind: "none" } as const;
  const env = options.env ?? process.env;
  const connects = options.connects ?? socketAcceptsConnections;
  const pinned = options.signature ?? env[SYNARA_HYPRLAND_SIGNATURE_ENV]?.trim();
  if (pinned) {
    return (await hyprlandInstancePresent(pinned, env, connects))
      ? { kind: "live", signature: pinned }
      : none;
  }
  const inherited = env[HYPRLAND_SIGNATURE_ENV]?.trim();
  if (!inherited || !isSignature(inherited)) return none;
  if (await hyprlandInstancePresent(inherited, env, connects)) {
    return { kind: "live", signature: inherited };
  }
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (!runtimeDir) return none;
  const list =
    options.listInstances ??
    ((directory: string) => readdir(directory).catch(() => [] as string[]));
  const live: string[] = [];
  for (const candidate of await list(join(runtimeDir, "hypr"))) {
    if (candidate === inherited || !isSignature(candidate)) continue;
    if (await hyprlandInstancePresent(candidate, env, connects)) live.push(candidate);
  }
  const [only, ...others] = live;
  if (only === undefined) return none;
  return others.length === 0
    ? { kind: "live", signature: only }
    : { kind: "ambiguous", candidates: live };
}

/** Whether this environment resolves to a live instance; see `resolveLiveHyprlandInstance`. */
export async function hyprlandSessionPresent(
  env: NodeJS.ProcessEnv = process.env,
  connects: (path: string) => boolean | Promise<boolean> = socketAcceptsConnections,
  listInstances?: (directory: string) => Promise<readonly string[]>,
): Promise<boolean> {
  return (
    (await resolveLiveHyprlandInstance({
      env,
      connects,
      ...(listInstances ? { listInstances } : {}),
    })) !== undefined
  );
}

export function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Runs `hyprctl` with the given arguments and resolves its stdout. */
export type HyprctlRunner = (args: readonly string[]) => Promise<string>;

export interface HyprctlOptions {
  /**
   * The instance signature (`hyprctl -i`) every call is addressed to: a fixed
   * one, or a function asked per call — the backend's, which follows the live
   * instance across compositor restarts. Absent, the instance is resolved from
   * the environment (`env` below), which prefers the Synara override over the
   * inherited signature.
   */
  readonly signature?: string | (() => string | undefined);
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Every call is addressed to a named instance rather than left to hyprctl's own
 * environment lookup: the two disagree exactly when the override is set, and a
 * call that silently lands on the human's compositor instead of the dev-test
 * one is the failure this whole module exists to prevent. With no instance to
 * name, nothing is run at all.
 */
export function makeHyprctlRunner(options: HyprctlOptions = {}): HyprctlRunner {
  const fixed =
    options.signature === undefined
      ? hyprlandInstanceSignature(options.env ?? process.env)
      : options.signature;
  return (args) =>
    new Promise((resolve, reject) => {
      const signature = typeof fixed === "function" ? fixed() : fixed;
      if (!signature) {
        reject(
          new Error(`hyprctl ${args.join(" ")} was not run: no live Hyprland instance to address.`),
        );
        return;
      }
      execFile(
        "hyprctl",
        ["-i", signature, ...args],
        { timeout: HYPRCTL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          // A reply, whatever it says, exits 0. An error here means no reply:
          // the instance is gone (a non-zero exit), the binary is missing, or
          // the timeout killed it.
          if (error) reject(new Error(`hyprctl ${args.join(" ")} failed: ${error.message}`));
          else resolve(stdout);
        },
      );
    });
}

export interface LoadedHyprlandPlugin {
  readonly name: string;
}

/** The plugins the compositor has loaded right now, by registered name. */
export async function listLoadedHyprlandPlugins(
  run: HyprctlRunner,
): Promise<readonly LoadedHyprlandPlugin[]> {
  const raw = await run(["-j", "plugin", "list"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Older Hyprland answers `plugin list -j` requests with plain text; treat
    // an unparseable reply as "none visible" and let the load path decide.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? [{ name }] : [];
  });
}

export interface HyprlandPluginLoadResult {
  readonly ok: boolean;
  /** Hyprland's own reason on refusal — it names ABI mismatches precisely. */
  readonly message: string;
}

export async function loadHyprlandPlugin(
  run: HyprctlRunner,
  pluginPath: string,
): Promise<HyprlandPluginLoadResult> {
  const reply = (await run(["plugin", "load", pluginPath])).trim();
  return { ok: reply === "ok", message: reply };
}

/** `false` only when Hyprland reports the path was not loaded to begin with. */
export async function unloadHyprlandPlugin(
  run: HyprctlRunner,
  pluginPath: string,
): Promise<boolean> {
  const reply = (await run(["plugin", "unload", pluginPath])).trim();
  if (reply === "ok") return true;
  if (reply.includes("not loaded")) return false;
  throw new Error(`hyprctl plugin unload ${pluginPath}: ${reply}`);
}

/** The running compositor's version (`0.56.2`), or undefined if unreadable. */
export async function detectRunningHyprlandVersion(
  run: HyprctlRunner,
): Promise<string | undefined> {
  try {
    const raw = await run(["-j", "version"]);
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : undefined;
  } catch {
    return undefined;
  }
}
