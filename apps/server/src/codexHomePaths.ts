// FILE: codexHomePaths.ts
// Purpose: Pure helpers that mirror how codexAppServerManager.ts decides which
//          CODEX_HOME directory the codex app-server child process runs against.
//          Centralizing this lets consumers outside the manager (the local image
//          allowlist, image-path predictions, etc.) stay in sync with the actual
//          runtime so they don't 404 paths Codex legitimately wrote.
// Layer: Server utility (no IO; safe to import from anywhere)
// Exports: overlay constants, base/overlay home resolvers, write-home + allowlist helpers.

import { homedir } from "node:os";
import path from "node:path";

export const SYNARA_CODEX_HOME_OVERLAY_DIR = "codex-home-overlay";

export interface CodexHomePathsInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
}

export function resolveBaseCodexHomePath(
  env: NodeJS.ProcessEnv,
  explicitHomePath?: string,
): string {
  return explicitHomePath?.trim() || env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

export function resolveSynaraCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
): string {
  const runtimeHome = env.SYNARA_HOME?.trim();
  const overlayRoot = runtimeHome || path.join(path.dirname(sourceHomePath), ".synara", "runtime");
  return path.join(overlayRoot, SYNARA_CODEX_HOME_OVERLAY_DIR);
}

/**
 * Returns the home directory that the codex app-server child process actually
 * writes under. Synara keeps its generated config isolated from the user's
 * source Codex home while linking shared state such as authentication.
 */
export function resolveActiveCodexHomeWritePath(input: CodexHomePathsInput = {}): string {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const overlay = resolveSynaraCodexHomeOverlayPath(env, source);
  return path.resolve(source) === path.resolve(overlay) ? source : overlay;
}

/**
 * Returns every Codex home directory we should treat as legitimate when
 * allowlisting locally-generated image files: the source home and the overlay
 * home if they are distinct. Callers pre-`realpath`-resolve these as needed.
 *
 * The overlay candidate remains included so generated images from earlier
 * sessions stay serveable until they are removed.
 */
export function resolveCodexHomeAllowlistCandidates(
  input: CodexHomePathsInput = {},
): readonly string[] {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const overlay = resolveSynaraCodexHomeOverlayPath(env, source);
  const sourceResolved = path.resolve(source);
  const overlayResolved = path.resolve(overlay);
  return sourceResolved === overlayResolved ? [source] : [source, overlay];
}
