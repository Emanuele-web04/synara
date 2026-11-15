// FILE: backendCompileCache.ts
// Purpose: Keeps the desktop's backend-only Node compile cache out of child processes.
// Layer: Server process startup

/** Set by the desktop with NODE_COMPILE_CACHE; see apps/desktop/src/backendCompileCache.ts. */
const BACKEND_COMPILE_CACHE_ENV = "SYNARA_BACKEND_COMPILE_CACHE";

/**
 * Node reads NODE_COMPILE_CACHE when the process starts, so removing it afterwards keeps
 * this process's cache while the provider CLIs, MCP servers and terminals it starts stop
 * inheriting it. A compile cache the user configured themselves is left alone.
 */
export function releaseBackendCompileCacheEnvironment(env: NodeJS.ProcessEnv): void {
  const owned = env[BACKEND_COMPILE_CACHE_ENV];
  if (owned === undefined) return;
  delete env[BACKEND_COMPILE_CACHE_ENV];
  if (owned.length > 0 && env.NODE_COMPILE_CACHE === owned) {
    delete env.NODE_COMPILE_CACHE;
  }
}
