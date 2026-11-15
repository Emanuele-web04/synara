// FILE: backendCompileCache.ts
// Purpose: Keeps the desktop's backend-only Node compile cache out of child processes.
// Layer: Server process startup

import * as Module from "node:module";

/** Set by the desktop with NODE_COMPILE_CACHE; see apps/desktop/src/backendCompileCache.ts. */
const BACKEND_COMPILE_CACHE_ENV = "SYNARA_BACKEND_COMPILE_CACHE";

/**
 * Node reads NODE_COMPILE_CACHE when the process starts, so removing it afterwards keeps
 * this process's cache while the provider CLIs, MCP servers and terminals it starts stop
 * inheriting it. A compile cache the user configured themselves is left alone.
 *
 * Returns whether this process runs on the desktop's cache.
 */
export function releaseBackendCompileCacheEnvironment(env: NodeJS.ProcessEnv): boolean {
  const owned = env[BACKEND_COMPILE_CACHE_ENV];
  if (owned === undefined) return false;
  delete env[BACKEND_COMPILE_CACHE_ENV];
  if (owned.length > 0 && env.NODE_COMPILE_CACHE === owned) {
    delete env.NODE_COMPILE_CACHE;
    return true;
  }
  return false;
}

/** Long enough for startup to finish, short enough that most sessions reach it. */
export const BACKEND_COMPILE_CACHE_FLUSH_DELAY_MS = 10_000;

interface CompileCacheFlushDependencies {
  readonly flush: (() => void) | undefined;
  readonly schedule: (run: () => void, delayMs: number) => { unref?: () => unknown };
}

/**
 * Node writes a new compile cache when the process exits, which made the first quit
 * after an app update slower. Writing it once startup has settled moves that cost off
 * the quit path; the exit write then only covers modules loaded later. With a cache
 * that is already on disk there is nothing to write. The timer never keeps the process
 * alive, and a failed write only means the next launch compiles again.
 */
export function scheduleBackendCompileCacheFlush(
  ownsCache: boolean,
  dependencies: CompileCacheFlushDependencies = {
    flush: (Module as { flushCompileCache?: () => void }).flushCompileCache,
    schedule: setTimeout,
  },
): boolean {
  const { flush } = dependencies;
  if (!ownsCache || typeof flush !== "function") return false;
  const timer = dependencies.schedule(() => {
    try {
      flush();
    } catch {
      // Best effort: Node retries at exit.
    }
  }, BACKEND_COMPILE_CACHE_FLUSH_DELAY_MS);
  timer.unref?.();
  return true;
}
