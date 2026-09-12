// FILE: useLocalStorage.browser.tsx
// Purpose: Verifies fresh schema-validated storage reads and cross-window hook synchronization.

import * as Schema from "effect/Schema";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";

const STORAGE_KEY = "synara:test:use-local-storage-clear";

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("useLocalStorage cross-window synchronization", () => {
  it("keeps each schema's encode/decode transformations when a storage key is shared", () => {
    const numeric = Schema.NumberFromString.check(Schema.isFinite());
    setLocalStorageItem(STORAGE_KEY, 42, numeric);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('"42"');
    expect(getLocalStorageItem(STORAGE_KEY, numeric)).toBe(42);
    expect(getLocalStorageItem(STORAGE_KEY, Schema.String)).toBe("42");

    setLocalStorageItem(STORAGE_KEY, "updated", Schema.String);
    expect(getLocalStorageItem(STORAGE_KEY, Schema.String)).toBe("updated");
    expect(() => getLocalStorageItem(STORAGE_KEY, numeric)).toThrow();
  });

  it("reads and validates current storage rather than reusing decoded objects", () => {
    const schema = Schema.Struct({ count: Schema.Number });
    setLocalStorageItem(STORAGE_KEY, { count: 1 }, schema);
    const first = getLocalStorageItem(STORAGE_KEY, schema);
    const second = getLocalStorageItem(STORAGE_KEY, schema);
    expect(second).toEqual({ count: 1 });
    expect(second).not.toBe(first);

    window.localStorage.setItem(STORAGE_KEY, '{"count":2}');
    expect(getLocalStorageItem(STORAGE_KEY, schema)).toEqual({ count: 2 });
    window.localStorage.setItem(STORAGE_KEY, '{"count":"invalid"}');
    expect(() => getLocalStorageItem(STORAGE_KEY, schema)).toThrow();
    window.localStorage.removeItem(STORAGE_KEY);
    expect(getLocalStorageItem(STORAGE_KEY, schema)).toBeNull();
  });

  it("synchronizes same-window subscribers after an updater writes through a shared codec", async () => {
    const first = await renderHook(() => useLocalStorage(STORAGE_KEY, 0, Schema.NumberFromString));
    const second = await renderHook(() => useLocalStorage(STORAGE_KEY, 0, Schema.NumberFromString));
    try {
      flushSync(() => first.result.current[1]((previous) => previous + 1));
      await vi.waitFor(() => expect(second.result.current[0]).toBe(1));
      flushSync(() => second.result.current[1]((previous) => previous + 1));
      await vi.waitFor(() => expect(first.result.current[0]).toBe(2));
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('"2"');
    } finally {
      await first.unmount();
      await second.unmount();
    }
  });

  it("falls back on corrupt cross-window data and recovers on the next valid value", async () => {
    setLocalStorageItem(STORAGE_KEY, "initial", Schema.String);
    const hook = await renderHook(() => useLocalStorage(STORAGE_KEY, "fallback", Schema.String));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const invalid of ['{"broken":', "123"]) {
        window.localStorage.setItem(STORAGE_KEY, invalid);
        window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
        await vi.waitFor(() => expect(hook.result.current[0]).toBe("fallback"));
      }
      window.localStorage.setItem(STORAGE_KEY, '"recovered"');
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
      await vi.waitFor(() => expect(hook.result.current[0]).toBe("recovered"));
    } finally {
      error.mockRestore();
      await hook.unmount();
    }
  });

  it("returns to its fallback after another window clears localStorage", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify("persisted"));
    const hook = await renderHook(() => useLocalStorage(STORAGE_KEY, "fallback", Schema.String));
    expect(hook.result.current[0]).toBe("persisted");

    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    await vi.waitFor(() => expect(hook.result.current[0]).toBe("fallback"));
    await hook.unmount();
  });
});
