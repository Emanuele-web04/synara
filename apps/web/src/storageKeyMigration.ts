// FILE: storageKeyMigration.ts
// Purpose: Migrates legacy browser storage keys to the Synara namespace.
// Layer: Web bootstrap utility
// Exports: migrateSynaraLocalStorageKeys

const STORAGE_KEY_MIGRATIONS = [
  ["dpcode:renderer-state:v8", "synara:renderer-state:v8"],
  ["t3code:renderer-state:v8", "synara:renderer-state:v8"],
  ["dpcode:composer-drafts:v1", "synara:composer-drafts:v1"],
  ["t3code:composer-drafts:v1", "synara:composer-drafts:v1"],
  ["dpcode:split-view-state:v1", "synara:split-view-state:v1"],
  ["t3code:split-view-state:v1", "synara:split-view-state:v1"],
  ["dpcode:sidebar-ui:v1", "synara:sidebar-ui:v1"],
  ["t3code:sidebar-ui:v1", "synara:sidebar-ui:v1"],
  ["dpcode:single-chat-panel-state:v1", "synara:single-chat-panel-state:v1"],
  ["t3code:single-chat-panel-state:v1", "synara:single-chat-panel-state:v1"],
  ["dpcode:terminal-state:v1", "synara:terminal-state:v1"],
  ["t3code:terminal-state:v1", "synara:terminal-state:v1"],
  ["dpcode:latest-project:v1", "synara:latest-project:v1"],
  ["t3code:latest-project:v1", "synara:latest-project:v1"],
  ["dpcode:app-settings:v1", "synara:app-settings:v1"],
  ["t3code:app-settings:v1", "synara:app-settings:v1"],
  ["dpcode:pinned-threads:v1", "synara:pinned-threads:v1"],
  ["t3code:pinned-threads:v1", "synara:pinned-threads:v1"],
  ["dpcode:browser-state:v1", "synara:browser-state:v1"],
  ["t3code:browser-state:v1", "synara:browser-state:v1"],
  ["dpcode:workspace-pages:v2", "synara:workspace-pages:v2"],
  ["t3code:workspace-pages:v2", "synara:workspace-pages:v2"],
  ["dpcode:theme", "synara:theme"],
  ["t3code:theme", "synara:theme"],
  ["dpcode:last-editor", "synara:last-editor"],
  ["t3code:last-editor", "synara:last-editor"],
  ["dpcode:last-invoked-script-by-project", "synara:last-invoked-script-by-project"],
  ["t3code:last-invoked-script-by-project", "synara:last-invoked-script-by-project"],
  ["dpcode:right-dock-state:v1", "synara:right-dock-state:v1"],
  ["dpcode:repo-diff-scope:v1", "synara:repo-diff-scope:v1"],
  ["dpcode:feature-flags", "synara:feature-flags"],
  ["dpcode:whats-new:v1", "synara:whats-new:v1"],
  ["dpcode:dismissed-provider-health-banners", "synara:dismissed-provider-health-banners"],
  ["dpcode:show-debug-feature-flags-menu", "synara:show-debug-feature-flags-menu"],
  ["dpcode:cursor-favourite-models:v1", "synara:cursor-favourite-models:v1"],
  ["dpcode:kilo-favourite-models:v1", "synara:kilo-favourite-models:v1"],
  ["dpcode:opencode-favourite-models:v1", "synara:opencode-favourite-models:v1"],
  ["dpcode:pi-favourite-models:v1", "synara:pi-favourite-models:v1"],
  ["dpcode:browser-perf", "synara:browser-perf"],
  ["t3code:browser-perf", "synara:browser-perf"],
] as const;

export function migrateSynaraLocalStorageKeys(): void {
  // Prefer globalThis.localStorage so this works identically in browsers (where
  // globalThis === window) and in node-based unit tests that stub the global.
  let storage: Storage | null = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    return;
  }
  if (!storage) {
    return;
  }

  try {
    for (const [legacyKey, nextKey] of STORAGE_KEY_MIGRATIONS) {
      if (storage.getItem(nextKey) !== null) {
        continue;
      }
      const legacyValue = storage.getItem(legacyKey);
      if (legacyValue !== null) {
        storage.setItem(nextKey, legacyValue);
      }
    }
  } catch {
    // Storage can be unavailable in private/sandboxed contexts; the app should still boot.
  }
}

// Run during bootstrap before stores hydrate from localStorage.
migrateSynaraLocalStorageKeys();
