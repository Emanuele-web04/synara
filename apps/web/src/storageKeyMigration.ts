// FILE: storageKeyMigration.ts
// Purpose: Hands canonical Synara browser state across desktop renderer-origin upgrades.
// Layer: Web bootstrap utility

import type { SynaraStorageSnapshot } from "@t3tools/contracts";

interface DesktopStorageMigrationBridge {
  readonly readSnapshot: () => SynaraStorageSnapshot | null;
  readonly saveSnapshot: (snapshot: SynaraStorageSnapshot) => Promise<boolean>;
  readonly acknowledgeSnapshot: () => Promise<void>;
}

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
  ["dpcode:confirmed-custom-binary-paths:v1", "synara:confirmed-custom-binary-paths:v1"],
  ["t3code.openUsage.enabled", "synara.openUsage.enabled"],
  ["t3code:server-settings-migrated:v1", "synara:server-settings-migrated:v1"],
] as const;

const MAX_SNAPSHOT_ENTRIES = 2_048;
const MAX_SNAPSHOT_KEY_LENGTH = 512;
const MAX_SNAPSHOT_VALUE_LENGTH = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function isCanonicalStorageKey(key: string): boolean {
  return key.startsWith("synara:") || key.startsWith("synara.");
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function migrateSynaraLocalStorageKeys(storage = getLocalStorage()): void {
  if (!storage) return;
  try {
    for (const [legacyKey, nextKey] of STORAGE_KEY_MIGRATIONS) {
      if (storage.getItem(nextKey) !== null) continue;
      const legacyValue = storage.getItem(legacyKey);
      if (legacyValue !== null) storage.setItem(nextKey, legacyValue);
    }
  } catch {
    // Storage may be unavailable in private or sandboxed contexts.
  }
}

export function createSynaraStorageSnapshot(
  storage = getLocalStorage(),
  exportedAt = new Date().toISOString(),
): SynaraStorageSnapshot | null {
  if (!storage) return null;
  try {
    const entries: Record<string, string> = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !isCanonicalStorageKey(key)) continue;
      const value = storage.getItem(key);
      if (value === null) continue;
      if (
        Object.keys(entries).length >= MAX_SNAPSHOT_ENTRIES ||
        key.length > MAX_SNAPSHOT_KEY_LENGTH ||
        value.length > MAX_SNAPSHOT_VALUE_LENGTH
      ) {
        return null;
      }
      entries[key] = value;
    }
    const snapshot: SynaraStorageSnapshot = { version: 1, exportedAt, entries };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function importSynaraStorageSnapshot(
  snapshot: SynaraStorageSnapshot | null,
  storage = getLocalStorage(),
): boolean {
  if (!snapshot || !storage || snapshot.version !== 1 || !snapshot.entries) return false;
  const entries = Object.entries(snapshot.entries);
  if (entries.length > MAX_SNAPSHOT_ENTRIES) return false;
  try {
    if (
      !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES
    ) {
      return false;
    }
    for (const [key, value] of entries) {
      if (
        !isCanonicalStorageKey(key) ||
        key.length > MAX_SNAPSHOT_KEY_LENGTH ||
        typeof value !== "string" ||
        value.length > MAX_SNAPSHOT_VALUE_LENGTH
      ) {
        return false;
      }
    }
    for (const [key, value] of entries) {
      if (storage.getItem(key) === null) storage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
}

export async function flushSynaraStorageSnapshot(): Promise<boolean> {
  const bridge = globalThis.window?.desktopBridge?.storageMigration;
  if (!bridge) return false;
  const snapshot = createSynaraStorageSnapshot();
  if (!snapshot) return false;
  try {
    return await bridge.saveSnapshot(snapshot);
  } catch {
    return false;
  }
}

function readLocationProtocol(): string | undefined {
  try {
    return globalThis.location?.protocol;
  } catch {
    return undefined;
  }
}

export function importSynaraDesktopStorageSnapshot(input: {
  readonly protocol: string | undefined;
  readonly bridge: DesktopStorageMigrationBridge | null | undefined;
  readonly storage?: Storage | null;
}): boolean {
  if (input.protocol !== "synara:" || !input.bridge) return false;
  try {
    const snapshot = input.bridge.readSnapshot();
    if (!snapshot || !importSynaraStorageSnapshot(snapshot, input.storage ?? getLocalStorage())) {
      return false;
    }
    void input.bridge.acknowledgeSnapshot().catch(() => undefined);
    return true;
  } catch {
    // Keep the snapshot for a later retry if preload or storage is unavailable.
    return false;
  }
}

export function bootstrapSynaraStorageOriginMigration(): void {
  const storage = getLocalStorage();
  const bridge = globalThis.window?.desktopBridge?.storageMigration;
  const protocol = readLocationProtocol();
  const importingAtSynaraOrigin = protocol === "synara:";
  importSynaraDesktopStorageSnapshot({ protocol, bridge, storage });

  migrateSynaraLocalStorageKeys(storage);
  if (importingAtSynaraOrigin) return;

  void flushSynaraStorageSnapshot();

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => void flushSynaraStorageSnapshot());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flushSynaraStorageSnapshot();
    });
  }
}

bootstrapSynaraStorageOriginMigration();
