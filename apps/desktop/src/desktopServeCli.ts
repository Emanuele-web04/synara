// FILE: desktopServeCli.ts
// Purpose: Detects and dispatches `synara serve` invocations from the desktop binary.
// Layer: Desktop process startup helper
// Depends on: Node child_process/path and shared desktop identity/runtime constants.

import * as ChildProcess from "node:child_process";
import * as Path from "node:path";

import { SYNARA_DESKTOP_BUNDLE_ID_ENV } from "@synara/shared/desktopIdentity";
import { DEVICE_HELPER_SOURCE_DIR_ENV } from "@synara/shared/deviceHelperCache";
import { MIGRATION_RUNTIME_SOURCE_DIGEST_ENV } from "@synara/shared/migrationRecovery";

const ROOT_VALUE_FLAGS = new Set([
  "--mode",
  "--port",
  "--host",
  "--home-dir",
  "--dev-url",
  "--public-url",
  "--ssh-forward-port",
  "--auth-token",
  "--token",
]);

const ROOT_BOOLEAN_FLAGS = new Set([
  "--allow-insecure-remote",
  "--no-allow-insecure-remote",
  "--no-browser",
  "--browser",
  "--auto-bootstrap-project-from-cwd",
  "--no-auto-bootstrap-project-from-cwd",
  "--log-provider-events",
  "--no-log-provider-events",
  "--log-websocket-events",
  "--no-log-websocket-events",
  "--log-ws-events",
]);

const DESKTOP_GUI_ONLY_ENV_KEYS = [
  "SYNARA_DESKTOP_PARENT_STDIN",
  "SYNARA_DESKTOP_SHUTDOWN_TOKEN",
] as const;

function stripDesktopGuiOnlyEnvKeys(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  for (const key of DESKTOP_GUI_ONLY_ENV_KEYS) {
    if (platform === "win32") {
      const target = key.toUpperCase();
      for (const existingKey of Object.keys(env)) {
        if (existingKey.toUpperCase() === target) {
          delete env[existingKey];
        }
      }
    } else {
      delete env[key];
    }
  }
}

function userArgsFromElectronArgv(
  argv: ReadonlyArray<string>,
  isPackaged: boolean,
): ReadonlyArray<string> {
  if (isPackaged) {
    return argv.slice(1);
  }

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (token === "--") {
      return [];
    }
    if (token.startsWith("-")) {
      continue;
    }
    return argv.slice(index + 1);
  }

  return [];
}

/**
 * Extracts CLI arguments when the desktop executable is invoked as `synara serve ...`.
 *
 * Returns `null` for ordinary GUI launches, Chromium flags, or non-`serve` arguments so
 * normal desktop startup is unaffected.
 */
export function extractDesktopServeCliArgs(
  argv: ReadonlyArray<string>,
  isPackaged: boolean,
): ReadonlyArray<string> | null {
  const userArgs = userArgsFromElectronArgv(argv, isPackaged);
  if (userArgs.length === 0) {
    return null;
  }

  let index = 0;
  while (index < userArgs.length) {
    const token = userArgs[index];
    if (token === undefined) {
      return null;
    }
    if (token === "serve") {
      return userArgs;
    }
    if (token === "--" || !token.startsWith("-")) {
      return null;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      const flagName = token.slice(0, equalsIndex);
      if (ROOT_VALUE_FLAGS.has(flagName)) {
        index += 1;
        continue;
      }
      return null;
    }

    if (ROOT_BOOLEAN_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (ROOT_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    return null;
  }

  return null;
}

export interface BuildDesktopServeEnvInput {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly backendEntry: string;
  readonly defaultHomeDir: string;
  readonly desktopBundleId: string;
  readonly isPackaged: boolean;
  readonly platform?: NodeJS.Platform;
  readonly resourcesPath?: string;
  readonly staticDir?: string | null;
  readonly migrationSourceDigest?: string | null;
  readonly compileCacheEnv?: NodeJS.ProcessEnv;
}

export function buildDesktopServeEnv(input: BuildDesktopServeEnvInput): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    ...input.compileCacheEnv,
    ELECTRON_RUN_AS_NODE: "1",
    SYNARA_SERVER_ENTRY: input.backendEntry,
    UV_THREADPOOL_SIZE: input.baseEnv.UV_THREADPOOL_SIZE?.trim() || "16",
    SYNARA_HOME: input.baseEnv.SYNARA_HOME?.trim() || input.defaultHomeDir,
    [SYNARA_DESKTOP_BUNDLE_ID_ENV]:
      input.baseEnv[SYNARA_DESKTOP_BUNDLE_ID_ENV]?.trim() || input.desktopBundleId,
  };

  if (!input.baseEnv.SYNARA_STATIC_DIR?.trim() && input.staticDir) {
    env.SYNARA_STATIC_DIR = input.staticDir;
  }

  if (input.migrationSourceDigest && !input.baseEnv[MIGRATION_RUNTIME_SOURCE_DIGEST_ENV]?.trim()) {
    env[MIGRATION_RUNTIME_SOURCE_DIGEST_ENV] = input.migrationSourceDigest;
  }

  if (input.isPackaged && input.resourcesPath) {
    if (!input.baseEnv[DEVICE_HELPER_SOURCE_DIR_ENV]?.trim()) {
      env[DEVICE_HELPER_SOURCE_DIR_ENV] = Path.join(input.resourcesPath, "device-helper");
    }
    if (!input.baseEnv.SYNARA_CLOUDFLARED_PATH?.trim()) {
      env.SYNARA_CLOUDFLARED_PATH = Path.join(
        input.resourcesPath,
        "cloudflared",
        platform === "win32" ? "cloudflared.exe" : "cloudflared",
      );
    }
  }

  stripDesktopGuiOnlyEnvKeys(env, platform);
  return env;
}

export function resolveDesktopServeExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (typeof code === "number") {
    return code;
  }
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

export interface RunDesktopServeCliInput {
  readonly execPath: string;
  readonly nodeArgs: ReadonlyArray<string>;
  readonly backendEntry: string;
  readonly serveArgs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onExit: (exitCode: number) => void;
  readonly onErrorMessage?: (message: string) => void;
}

export function runDesktopServeCli(input: RunDesktopServeCliInput): ChildProcess.ChildProcess {
  const child = ChildProcess.spawn(
    input.execPath,
    [...input.nodeArgs, input.backendEntry, ...input.serveArgs],
    {
      cwd: input.cwd,
      env: input.env,
      stdio: "inherit",
    },
  );

  let settled = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // Child exited concurrently.
      }
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");

  const cleanup = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    input.onErrorMessage?.(`Failed to start Synara server: ${error.message}`);
    input.onExit(1);
  });

  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    cleanup();
    input.onExit(resolveDesktopServeExitCode(code, signal));
  });

  return child;
}
