// FILE: executableLookup.ts
// Purpose: One definition of how a command name becomes a concrete file on disk — PATH
//          splitting, PATHEXT candidate naming, and executability — plus a cheap identity
//          fingerprint for callers that cache a per-binary verdict.
// Layer: Server utility
// Depends on: node:fs and node:path only.
//
// This used to live in three places (editor discovery, terminal wrappers, provider
// maintenance), each with its own PATHEXT fallback list, its own idea of whether PATH
// entries could be quoted, and its own separator handling — so the same command could be
// found by one and missed by another. The probe itself legitimately differs per caller
// (sync executability here, an Effect `FileSystem` existence check in provider
// maintenance), which is why enumeration and probing are split: `executableCandidates`
// yields the paths to try, in order, and each caller applies its own predicate.

import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface ExecutableLookupOptions {
  /** Defaults to `process.platform`. Injectable so PATHEXT behaviour is testable off Windows. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * win32 only: also yield the command with no extension appended.
   *
   * Off by default, because a Windows shell will not run an extensionless file, so treating
   * one as a hit reports a command as available that cannot actually be launched. Callers
   * that are locating an installation rather than something to spawn can opt in.
   */
  readonly allowExtensionlessOnWindows?: boolean;
}

export interface ExecutableCandidate {
  /** The PATH entry this candidate came from, or the command's own directory when qualified. */
  readonly directory: string;
  readonly path: string;
}

/**
 * Windows' own default PATHEXT prefix, in its real precedence order.
 *
 * The order is load-bearing and deliberately not "alphabetical" or "most common first": when a
 * directory holds both `x.bat` and `x.cmd`, this is the one Windows would run. One of the lists
 * this module replaced used `["", ".exe", ".cmd", ".bat"]`, which resolved that pair the wrong
 * way round.
 */
const DEFAULT_WINDOWS_PATH_EXTENSIONS: readonly string[] = [".COM", ".EXE", ".BAT", ".CMD"];

/** Windows exposes PATH under any capitalization; the first key present is the live one. */
export function envPathKeyFor(env: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if ("PATH" in env) return "PATH";
  if ("Path" in env) return "Path";
  return "path";
}

/** True when the command already names a location, in which case PATH is not consulted. */
export function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

export function windowsPathExtensions(env: NodeJS.ProcessEnv): readonly string[] {
  const rawValue = env.PATHEXT;
  if (!rawValue) return DEFAULT_WINDOWS_PATH_EXTENSIONS;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

/**
 * PATH split into directories, in search order.
 *
 * Entries are trimmed and unquoted because Windows tolerates `"C:\Program Files\x"` in PATH
 * and a raw split would leave the quotes glued to the directory name.
 */
export function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathValue.length === 0) return [];
  return pathValue
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * The file names to try for `command`, in order.
 *
 * Outside Windows this is just the command. On Windows the shell appends PATHEXT, so a bare
 * `code` has to be probed as `code.EXE`, `code.CMD` and so on; both cases are generated
 * because the injected-platform tests run on case-sensitive filesystems. A command that
 * already ends in a known extension is probed as written first, then case-normalized.
 */
export function executableNameCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  allowExtensionless = false,
): readonly string[] {
  if (platform !== "win32") return [command];

  const pathExtensions = windowsPathExtensions(env);
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && pathExtensions.includes(normalizedExtension)) {
    const stem = command.slice(0, -extension.length);
    return [
      ...new Set([
        command,
        `${stem}${normalizedExtension}`,
        `${stem}${normalizedExtension.toLowerCase()}`,
      ]),
    ];
  }

  const candidates = allowExtensionless ? [command] : [];
  for (const pathExtension of pathExtensions) {
    candidates.push(`${command}${pathExtension}`, `${command}${pathExtension.toLowerCase()}`);
  }
  return [...new Set(candidates)];
}

/**
 * The directory part of a path, honouring both separators regardless of host.
 *
 * `node:path`'s `dirname` only understands the host's separator, so on a POSIX host it reports
 * `"."` for `C:\bin\codex.exe`. A caller can ask for an injected `win32` platform from a POSIX
 * test host, so the split has to look for whichever separator the command actually uses.
 */
function directoryOf(commandPath: string): string {
  const lastIndex = Math.max(commandPath.lastIndexOf("/"), commandPath.lastIndexOf("\\"));
  if (lastIndex < 0) return ".";
  if (lastIndex === 0) return commandPath.slice(0, 1);
  return commandPath.slice(0, lastIndex);
}

/**
 * The options resolved once per lookup.
 *
 * PATHEXT parsing is not free (split, trim, case-normalize, dedupe) and a Windows lookup probes
 * up to `PATH entries × PATHEXT entries` candidates, so parsing it per probe meant re-deriving
 * the same list dozens of times per call.
 */
interface ExecutableLookupContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Empty off Windows, where PATHEXT carries no meaning. */
  readonly pathExtensions: readonly string[];
}

function resolveLookupContext(options: ExecutableLookupOptions): ExecutableLookupContext {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  return {
    platform,
    env,
    pathExtensions: platform === "win32" ? windowsPathExtensions(env) : [],
  };
}

function* candidatesIn(
  command: string,
  context: ExecutableLookupContext,
  allowExtensionless: boolean,
): Generator<ExecutableCandidate> {
  const names = executableNameCandidates(
    command,
    context.platform,
    context.env,
    allowExtensionless,
  );

  if (hasPathSeparator(command)) {
    for (const name of names) {
      yield { directory: directoryOf(name), path: name };
    }
    return;
  }

  for (const directory of pathEntries(context.env, context.platform)) {
    for (const name of names) {
      yield { directory, path: join(directory, name) };
    }
  }
}

/**
 * Every path a spawn of `command` could resolve to, in the order the shell would try them.
 *
 * Candidates are joined with the host separator rather than the requested platform's, so an
 * injected `platform: "win32"` still addresses real files when the test host is POSIX. Only
 * the PATH delimiter, PATHEXT rules and the qualified-command split follow the command itself.
 */
export function executableCandidates(
  command: string,
  options: ExecutableLookupOptions = {},
): Generator<ExecutableCandidate> {
  return candidatesIn(
    command,
    resolveLookupContext(options),
    options.allowExtensionlessOnWindows ?? false,
  );
}

function isExecutableFileIn(filePath: string, context: ExecutableLookupContext): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (context.platform === "win32") {
      // Windows has no executable bit and `accessSync(X_OK)` succeeds for anything readable,
      // so PATHEXT membership is the only signal that this file is something a shell can run.
      const extension = extname(filePath).toUpperCase();
      return extension.length > 0 && context.pathExtensions.includes(extension);
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isExecutableFile(filePath: string, options: ExecutableLookupOptions = {}): boolean {
  return isExecutableFileIn(filePath, resolveLookupContext(options));
}

/** The file spawning `command` would actually run, or null when nothing matches. */
export function resolveExecutable(
  command: string,
  options: ExecutableLookupOptions = {},
): string | null {
  const context = resolveLookupContext(options);
  for (const candidate of candidatesIn(
    command,
    context,
    options.allowExtensionlessOnWindows ?? false,
  )) {
    if (isExecutableFileIn(candidate.path, context)) {
      return candidate.path;
    }
  }
  return null;
}

/**
 * A cheap fingerprint of the file at `filePath`, or null when it cannot be stat'ed.
 *
 * Size and mtime both change on any real reinstall, downgrade or rebuild, which is what
 * callers caching a per-binary verdict need in order to notice that the binary under a stable
 * path is no longer the one they inspected. Deliberately not a content hash: the cost has to
 * stay negligible on paths that run per session start.
 */
export function executableIdentity(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}
