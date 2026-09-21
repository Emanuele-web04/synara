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

/** the home the codex app-server child actually writes under — isolated from the user's source home while linking shared state like auth */
export function resolveActiveCodexHomeWritePath(input: CodexHomePathsInput = {}): string {
  const env = input.env ?? process.env;
  const source = resolveBaseCodexHomePath(env, input.homePath);
  const overlay = resolveSynaraCodexHomeOverlayPath(env, source);
  return path.resolve(source) === path.resolve(overlay) ? source : overlay;
}

/** the overlay candidate stays included so images from earlier sessions remain serveable until removed */
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
