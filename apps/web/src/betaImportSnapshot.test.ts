import { describe, expect, it } from "vitest";

import { collectBetaImportStorageSnapshot } from "./betaImportSnapshot";
import { importSynaraStorageSnapshot } from "./storageOriginMigration";

function createMemoryStorage(initialEntries: Readonly<Record<string, string>> = {}): Storage {
  const storedValues = new Map<string, string>(Object.entries(initialEntries));
  return {
    getItem: (key: string): string | null => storedValues.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storedValues.set(key, value);
    },
    removeItem: (key: string): void => {
      storedValues.delete(key);
    },
    clear: (): void => {
      storedValues.clear();
    },
    key: (index: number): string | null => [...storedValues.keys()][index] ?? null,
    get length(): number {
      return storedValues.size;
    },
  };
}

function collectOrThrow(storage: Storage) {
  const snapshot = collectBetaImportStorageSnapshot(storage);
  if (snapshot === null) throw new Error("expected a storage snapshot, got null");
  return snapshot;
}

describe("betaImportSnapshot", () => {
  it("keeps ordinary synara settings keys with the snapshot shape", () => {
    const snapshot = collectOrThrow(
      createMemoryStorage({
        "synara:theme": JSON.stringify({ mode: "dark" }),
        "synara:app-settings:v1": JSON.stringify({ followUpBehavior: "steer" }),
        "synara.editor.sidebarVisible": "true",
        "synara:composer-drafts:v1": "draft",
      }),
    );

    expect(snapshot.version).toBe(1);
    expect(Number.isFinite(Date.parse(snapshot.exportedAt))).toBe(true);
    expect(snapshot.entries).toEqual({
      "synara:theme": JSON.stringify({ mode: "dark" }),
      "synara:app-settings:v1": JSON.stringify({ followUpBehavior: "steer" }),
      "synara.editor.sidebarVisible": "true",
      "synara:composer-drafts:v1": "draft",
    });
  });

  it("drops the curated exclusion keys while keeping neighbours", () => {
    const snapshot = collectOrThrow(
      createMemoryStorage({
        "synara:theme": "dark",
        "synara:beta-welcome:v1": JSON.stringify({ acknowledged: true }),
        "synara:server-settings-migrated:v1": "true",
        "synara:storage-origin:v1": "desktop",
        "synara:legacy-storage-origin-flag": "1",
      }),
    );

    expect(snapshot.entries).toEqual({ "synara:theme": "dark" });
  });

  it("drops non-synara keys and returns null when nothing curated survives", () => {
    expect(
      collectBetaImportStorageSnapshot(
        createMemoryStorage({
          "unrelated-theme": "dark",
          "other:synara:theme": "dark",
          "synara:beta-welcome:v1": JSON.stringify({ acknowledged: true }),
        }),
      ),
    ).toBeNull();
  });

  it("returns null when storage is unavailable", () => {
    expect(collectBetaImportStorageSnapshot(null)).toBeNull();
  });

  it("produces snapshots the existing storage-migration import accepts", () => {
    const snapshot = collectOrThrow(
      createMemoryStorage({
        "synara:theme": "dark",
        "synara:composer-drafts:v1": "draft",
      }),
    );
    const target = createMemoryStorage({ "synara:theme": "current" });

    expect(importSynaraStorageSnapshot(snapshot, target)).toBe(true);
    expect(target.getItem("synara:theme")).toBe("current");
    expect(target.getItem("synara:composer-drafts:v1")).toBe("draft");
  });
});
