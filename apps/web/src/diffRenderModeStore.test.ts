// FILE: diffRenderModeStore.test.ts
// Purpose: Pins per-thread diff layout persistence separate from the Settings default.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_SAVED_THREAD_DIFF_LAYOUTS,
  THREAD_DIFF_RENDER_MODE_STORAGE_KEY,
  useDiffRenderModeStore,
} from "./diffRenderModeStore";
import { DIFF_RENDER_MODE_STORAGE_KEY } from "./diffRenderMode";

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

describe("useDiffRenderModeStore", () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    useDiffRenderModeStore.setState({ modeByThreadId: {} });
  });

  afterEach(() => {
    globalThis.localStorage = ORIGINAL_LOCAL_STORAGE;
  });

  it("falls back to the settings default when a thread has no override", () => {
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-a", "split")).toBe("split");
    expect(useDiffRenderModeStore.getState().getModeForThread(null, "stacked")).toBe("stacked");
  });

  it("remembers a per-thread override without affecting other threads", () => {
    useDiffRenderModeStore.getState().setModeForThread("thread-a", "stacked");

    expect(useDiffRenderModeStore.getState().getModeForThread("thread-a", "split")).toBe("stacked");
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-b", "split")).toBe("split");
  });

  it("rehydrates saved thread choices without overwriting the existing global default", async () => {
    localStorage.setItem(DIFF_RENDER_MODE_STORAGE_KEY, JSON.stringify("stacked"));
    useDiffRenderModeStore.getState().setModeForThread("thread-a", "split");
    const saved = localStorage.getItem(THREAD_DIFF_RENDER_MODE_STORAGE_KEY)!;
    useDiffRenderModeStore.setState({ modeByThreadId: {} });
    localStorage.setItem(THREAD_DIFF_RENDER_MODE_STORAGE_KEY, saved);
    await useDiffRenderModeStore.persist.rehydrate();
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-a", "stacked")).toBe("split");
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-b", "stacked")).toBe(
      "stacked",
    );
    expect(localStorage.getItem(DIFF_RENDER_MODE_STORAGE_KEY)).toBe(JSON.stringify("stacked"));
  });

  it("bounds old persisted choices and removes a deleted thread without changing its neighbor", async () => {
    const modeByThreadId = Object.fromEntries(
      Array.from({ length: MAX_SAVED_THREAD_DIFF_LAYOUTS + 2 }, (_, index) => [
        `thread-${index}`,
        "stacked",
      ]),
    );
    localStorage.setItem(
      THREAD_DIFF_RENDER_MODE_STORAGE_KEY,
      JSON.stringify({
        state: { modeByThreadId: { ...modeByThreadId, corrupt: "sideways" } },
        version: 0,
      }),
    );
    await useDiffRenderModeStore.persist.rehydrate();
    expect(Object.keys(useDiffRenderModeStore.getState().modeByThreadId)).toHaveLength(
      MAX_SAVED_THREAD_DIFF_LAYOUTS,
    );
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-0", "split")).toBe("split");
    expect(useDiffRenderModeStore.getState().getModeForThread("corrupt", "split")).toBe("split");
    useDiffRenderModeStore.getState().setModeForThread("new-thread", "split");
    expect(Object.keys(useDiffRenderModeStore.getState().modeByThreadId)).toHaveLength(
      MAX_SAVED_THREAD_DIFF_LAYOUTS,
    );
    useDiffRenderModeStore.getState().removeThread("new-thread");
    expect(useDiffRenderModeStore.getState().getModeForThread("new-thread", "stacked")).toBe(
      "stacked",
    );
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-4", "split")).toBe("stacked");
    expect(
      JSON.parse(localStorage.getItem(THREAD_DIFF_RENDER_MODE_STORAGE_KEY)!).state.modeByThreadId,
    ).not.toHaveProperty("new-thread");
  });

  it("keeps layout changes usable when persistent storage refuses a write", () => {
    globalThis.localStorage = {
      ...createMemoryStorage(),
      setItem: () => {
        throw new Error("storage quota exceeded");
      },
    };
    expect(() =>
      useDiffRenderModeStore.getState().setModeForThread("thread-a", "stacked"),
    ).not.toThrow();
    expect(useDiffRenderModeStore.getState().getModeForThread("thread-a", "split")).toBe("stacked");
    expect(() => useDiffRenderModeStore.getState().removeThread("thread-a")).not.toThrow();
  });
});
