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

export const DPCODE_CODEX_HOME_OVERLAY_DIR = "codex-home-overlay";
export const DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN_ENV =
  "DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN";

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

export function shouldDisableDpCodeBrowserPlugin(env: NodeJS.ProcessEnv): boolean {
  // The plugin is disabled by default; the only way to opt out is the explicit "0" sentinel.
  return env[DPCODE_DISABLE_CODEX_DPCODE_BROWSER_PLUGIN_ENV] !== "0";
}

export function resolveDpCodeCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
): string {
  const runtimeHome = env.DPCODE_HOME?.trim() || env.T3CODE_HOME?.trim();
  const overlayRoot = runtimeHome || path.join(path.dirname(sourceHomePath), ".dpcode", "runtime");
  return path.join(overlayRoot, DPCODE_CODEX_HOME_OVERLAY_DIR);
}

/**
 * Returns the home directory that the codex app-server child process actually
 * writes under. This is the overlay home when DP Code wraps Codex with the
 * dpcode-browser plugin disabled (the production default), otherwise the
 * caller-supplied or env-provided home.
 */
export function resolveActiveCodexHomeWritePath(input: CodexHomePathsInput = {}): string {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  if (!shouldDisableDpCodeBrowserPlugin(env)) {
    return source;
  }
  const overlay = resolveDpCodeCodexHomeOverlayPath(env, source);
  return path.resolve(source) === path.resolve(overlay) ? source : overlay;
}

/**
 * Returns every Codex home directory we should treat as legitimate when
 * allowlisting locally-generated image files: the source home and the overlay
 * home if they are distinct. Callers pre-`realpath`-resolve these as needed.
 *
 * The overlay candidate is included even when the plugin is currently
 * "enabled" (no overlay active) so that images Codex wrote under the overlay
 * during a previous session remain serveable until they are removed.
 */
export function resolveCodexHomeAllowlistCandidates(
  input: CodexHomePathsInput = {},
): readonly string[] {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const overlay = resolveDpCodeCodexHomeOverlayPath(env, source);
  const sourceResolved = path.resolve(source);
  const overlayResolved = path.resolve(overlay);
  return sourceResolved === overlayResolved ? [source] : [source, overlay];
}
