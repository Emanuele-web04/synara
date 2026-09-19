/**
 * The `hyprctl` surface the Hyprland backend depends on, isolated because the
 * tool's contract is easy to misread: **hyprctl always exits 0**, success and
 * failure alike, so every answer here is parsed out of the reply text rather
 * than the exit code. `plugin load /path.so` answers `ok` on success and
 * `Plugin <path> could not be loaded: <reason>` on failure — same exit code
 * both ways. This module owns that parsing so nothing else in the tree ever
 * looks at an exit status and draws the wrong conclusion.
 *
 * Verified against Hyprland 0.56 (`src/debug/HyprCtl.cpp`): `plugin list -j`
 * reports `{name, author, handle, version, description}` per plugin — no path —
 * while `plugin load`/`plugin unload` address plugins **by absolute path**
 * (unload matches via `getPluginByPath`). That asymmetry is why the Synara
 * plugin self-reports its module path in `healthJson`: the name in the list
 * cannot tell the server which installed `.so` is the one answering the bus.
 */
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";

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
  if (!signature || !isSignature(signature)) return false;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (!runtimeDir) return false;
  return connects(join(runtimeDir, "hypr", signature, ".socket.sock"));
}

/** The instance this environment resolves to, and whether it is live. */
export async function hyprlandSessionPresent(
  env: NodeJS.ProcessEnv = process.env,
  connects: (path: string) => boolean | Promise<boolean> = socketAcceptsConnections,
): Promise<boolean> {
  return hyprlandInstancePresent(hyprlandInstanceSignature(env), env, connects);
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
   * An explicit instance signature (`hyprctl -i`), for driving a compositor
   * other than the one this process inherited — the dev-test nested instance.
   * Absent, the instance is resolved from the environment (`env` below), which
   * still prefers the Synara override over the inherited signature.
   */
  readonly signature?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Every call is addressed to a named instance rather than left to hyprctl's own
 * environment lookup: the two disagree exactly when the override is set, and a
 * call that silently lands on the human's compositor instead of the dev-test
 * one is the failure this whole module exists to prevent.
 */
export function makeHyprctlRunner(options: HyprctlOptions = {}): HyprctlRunner {
  const signature = options.signature ?? hyprlandInstanceSignature(options.env ?? process.env);
  return (args) =>
    new Promise((resolve, reject) => {
      const fullArgs = signature ? ["-i", signature, ...args] : [...args];
      execFile(
        "hyprctl",
        fullArgs,
        { timeout: HYPRCTL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          // hyprctl itself never exits non-zero; an error here means the binary
          // is missing, was killed by the timeout, or the socket write failed.
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
