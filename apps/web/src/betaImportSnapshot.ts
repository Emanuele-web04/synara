// FILE: betaImportSnapshot.ts
// Purpose: Curates stable's browser-profile settings for the Stable→Beta handoff.
// Layer: Web renderer snapshot collection
// Exports: collectBetaImportStorageSnapshot

import type { SynaraStorageSnapshot } from "@synara/contracts";

const EXCLUDED_STORAGE_KEY_BY_KEY: Record<string, true> = {
  "synara:beta-welcome:v1": true,
  "synara:server-settings-migrated:v1": true,
};

// Caps mirror the consumer (`importSynaraStorageSnapshot` in
// storageOriginMigration.ts, validated again desktop-side by
// `validateSynaraStorageSnapshot`). Over-cap input returns null rather than a
// silently truncated snapshot: the caller then falls back to a bare
// `importAndLaunch()` so the server/db import still proceeds instead of
// handing beta a partial browser profile.
const MAX_SNAPSHOT_ENTRIES = 2_048;
const MAX_SNAPSHOT_KEY_LENGTH = 512;
const MAX_SNAPSHOT_VALUE_LENGTH = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

// Collects the curated browser-profile slice beta cannot get elsewhere: theme
// (`synara:theme`), app settings incl. `followUpBehavior`
// (`synara:app-settings:v1`), project instructions/environment prefs,
// renderer state, starred/favourite models, pins, profile, composer drafts.
// Known gap: IndexedDB `synara-composer-images` (composer image blobs) cannot
// ride a localStorage snapshot.
export function collectBetaImportStorageSnapshot(
  storage?: Storage | null,
): SynaraStorageSnapshot | null {
  let resolvedStorage: Storage | null;
  if (storage === undefined) {
    try {
      resolvedStorage = globalThis.localStorage ?? null;
    } catch (localStorageAccessError) {
      // Renderer storage can be blocked (private mode, disabled cookies).
      // Null keeps the handoff on the server/db path via bare importAndLaunch.
      void localStorageAccessError;
      return null;
    }
  } else {
    resolvedStorage = storage;
  }
  if (resolvedStorage === null) return null;

  const curatedEntries: Record<string, string> = {};
  const snapshotEncoder = new TextEncoder();
  let curatedEntryCount = 0;
  let estimatedSnapshotBytes = 0;
  try {
    for (let index = 0; index < resolvedStorage.length; index += 1) {
      const storageKey = resolvedStorage.key(index);
      if (storageKey === null) continue;
      if (!(storageKey.startsWith("synara:") || storageKey.startsWith("synara."))) continue;
      if (EXCLUDED_STORAGE_KEY_BY_KEY[storageKey]) continue;
      if (storageKey.includes("storage-origin")) continue;
      if (storageKey.length > MAX_SNAPSHOT_KEY_LENGTH) return null;
      const storedValue = resolvedStorage.getItem(storageKey);
      if (storedValue === null) continue;
      if (storedValue.length > MAX_SNAPSHOT_VALUE_LENGTH) return null;
      curatedEntryCount += 1;
      if (curatedEntryCount > MAX_SNAPSHOT_ENTRIES) return null;
      estimatedSnapshotBytes +=
        snapshotEncoder.encode(storageKey).byteLength +
        snapshotEncoder.encode(storedValue).byteLength;
      if (estimatedSnapshotBytes > MAX_SNAPSHOT_BYTES) return null;
      curatedEntries[storageKey] = storedValue;
    }
  } catch (storageScanError) {
    // Quota or security errors mid-scan mean the profile cannot be read
    // atomically; null avoids handing beta a partial slice.
    void storageScanError;
    return null;
  }
  if (curatedEntryCount === 0) return null;
  const snapshot: SynaraStorageSnapshot = {
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: curatedEntries,
  };
  try {
    if (snapshotEncoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
      return null;
    }
  } catch (snapshotEncodeError) {
    // Unserializable values cannot cross the bridge; fall back to bare import.
    void snapshotEncodeError;
    return null;
  }
  return snapshot;
}
