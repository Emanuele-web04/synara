// FILE: storageKeyMigration.test.ts
// Purpose: Verify legacy t3code/dpcode localStorage keys copy into Synara without overwriting
// existing Synara values, so app boot never silently loses persisted state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_LOCAL_STORAGE = globalThis.localStorage;

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage;
}

async function importMigrationFresh() {
  vi.resetModules();
  return await import("./storageKeyMigration");
}

describe("storageKeyMigration", () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
  });

  afterEach(() => {
    globalThis.localStorage = ORIGINAL_LOCAL_STORAGE;
    vi.resetModules();
  });

  it("copies a legacy t3code value to the Synara key when missing", async () => {
    globalThis.localStorage.setItem(
      "t3code:split-view-state:v1",
      JSON.stringify({ state: {}, version: 2 }),
    );

    await importMigrationFresh();

    expect(globalThis.localStorage.getItem("synara:split-view-state:v1")).toBe(
      JSON.stringify({ state: {}, version: 2 }),
    );
    // Legacy key is intentionally left in place so a downgrade still has its data.
    expect(globalThis.localStorage.getItem("t3code:split-view-state:v1")).toBe(
      JSON.stringify({ state: {}, version: 2 }),
    );
  });

  it("copies a legacy dpcode value to the Synara key when missing", async () => {
    globalThis.localStorage.setItem("dpcode:theme", "dark");

    await importMigrationFresh();

    expect(globalThis.localStorage.getItem("synara:theme")).toBe("dark");
    expect(globalThis.localStorage.getItem("dpcode:theme")).toBe("dark");
  });

  it("does not overwrite an existing Synara value when legacy keys still hold data", async () => {
    globalThis.localStorage.setItem("t3code:theme", "dark");
    globalThis.localStorage.setItem("dpcode:theme", "light");
    globalThis.localStorage.setItem("synara:theme", "current");

    await importMigrationFresh();

    expect(globalThis.localStorage.getItem("synara:theme")).toBe("current");
    expect(globalThis.localStorage.getItem("dpcode:theme")).toBe("light");
    expect(globalThis.localStorage.getItem("t3code:theme")).toBe("dark");
  });

  it("prefers dpcode values over older t3code values when both exist", async () => {
    globalThis.localStorage.setItem("t3code:theme", "old");
    globalThis.localStorage.setItem("dpcode:theme", "newer");

    await importMigrationFresh();

    expect(globalThis.localStorage.getItem("synara:theme")).toBe("newer");
  });

  it("is a no-op when the legacy key is absent", async () => {
    globalThis.localStorage.setItem("synara:renderer-state:v8", '{"projectNamesByCwd":{}}');

    await importMigrationFresh();

    expect(globalThis.localStorage.getItem("synara:renderer-state:v8")).toBe(
      '{"projectNamesByCwd":{}}',
    );
    expect(globalThis.localStorage.getItem("t3code:renderer-state:v8")).toBeNull();
  });

  it("migrates several keys in one pass", async () => {
    globalThis.localStorage.setItem("t3code:composer-drafts:v1", "drafts");
    globalThis.localStorage.setItem("t3code:pinned-threads:v1", "pinned");
    globalThis.localStorage.setItem("t3code:last-editor", "vscode");

    await importMigrationFresh();

    expect(globalThis.localStorage.getItem("synara:composer-drafts:v1")).toBe("drafts");
    expect(globalThis.localStorage.getItem("synara:pinned-threads:v1")).toBe("pinned");
    expect(globalThis.localStorage.getItem("synara:last-editor")).toBe("vscode");
  });

  it("swallows storage errors so the app can still boot", async () => {
    const failingStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      clear: () => {
        throw new Error("denied");
      },
      key: () => null,
      length: 0,
    } as Storage;
    globalThis.localStorage = failingStorage;

    await expect(importMigrationFresh()).resolves.toBeDefined();
  });
});
