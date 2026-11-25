// FILE: backendCompileCache.ts
// Purpose: Node's on-disk compile cache for the desktop backend child, kept under the
//          flavor's own data home and scoped to one app version.
// Layer: Desktop process startup helper
// Exports: cache directory, backend env, and pruning of other versions' caches.

import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Marks NODE_COMPILE_CACHE as set by the desktop for the backend alone. The backend
 * removes both variables at startup (Node has read them by then), so the provider CLIs,
 * MCP servers and terminals it starts never write compile caches into the data home.
 * The backend reads the same literal in apps/server/src/backendCompileCache.ts.
 */
export const BACKEND_COMPILE_CACHE_ENV = "SYNARA_BACKEND_COMPILE_CACHE";

const CACHE_PARENT = Path.join("cache", "backend-compile");

/**
 * One directory per app version: an update never reads another build's cache, and the
 * caches of older versions can be removed. Node nests its own Node-version directory
 * inside and checks each module's source hash before using an entry.
 */
export function resolveBackendCompileCacheDir(stateDir: string, appVersion: string): string {
  const version = appVersion.trim().replace(/[^A-Za-z0-9._-]+/g, "-") || "unknown";
  return Path.join(stateDir, CACHE_PARENT, version);
}

/** Environment for the backend child. A compile cache the user configured stays theirs. */
export function backendCompileCacheEnv(
  inherited: NodeJS.ProcessEnv,
  cacheDir: string,
): NodeJS.ProcessEnv {
  if (inherited.NODE_COMPILE_CACHE?.trim()) {
    return { [BACKEND_COMPILE_CACHE_ENV]: undefined };
  }
  return { NODE_COMPILE_CACHE: cacheDir, [BACKEND_COMPILE_CACHE_ENV]: cacheDir };
}

/** Removes the compile caches other app versions left behind. Best effort. */
export async function pruneBackendCompileCaches(cacheDir: string): Promise<void> {
  const parent = Path.dirname(cacheDir);
  const current = Path.basename(cacheDir);
  let entries: FS.Dirent[];
  try {
    entries = await FS.promises.readdir(parent, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== current)
      .map((entry) =>
        FS.promises
          .rm(Path.join(parent, entry.name), { recursive: true, force: true })
          .catch(() => undefined),
      ),
  );
}
