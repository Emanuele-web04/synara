import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { createDedupedBrowserStateStorage, selectThreadBrowserHistory } from "./browserStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("browserStateStore selectors", () => {
  it("reuses the same empty history snapshot for unknown threads", () => {
    const selector = selectThreadBrowserHistory(THREAD_ID);
    const store = {
      threadStatesByThreadId: {},
      recentHistoryByThreadId: {},
      upsertThreadState: () => undefined,
      removeThreadState: () => undefined,
    };

    const first = selector(store);
    const second = selector(store);

    expect(first).toBe(second);
    expect(first).toEqual([]);
  });
});

describe("createDedupedBrowserStateStorage", () => {
  it("skips repeated writes of the same serialized browser-history payload", () => {
    const values = new Map<string, string>();
    const writes: Array<{ name: string; value: string }> = [];
    const storage = createDedupedBrowserStateStorage(() => ({
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => {
        writes.push({ name, value });
        values.set(name, value);
      },
      removeItem: (name) => {
        values.delete(name);
      },
    }));

    storage.setItem("browser", '{"history":[]}');
    storage.setItem("browser", '{"history":[]}');
    storage.setItem("browser", '{"history":["https://example.com"]}');

    expect(writes).toEqual([
      { name: "browser", value: '{"history":[]}' },
      { name: "browser", value: '{"history":["https://example.com"]}' },
    ]);
  });

  it("forgets the last written value when a key is removed", () => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const storage = createDedupedBrowserStateStorage(() => ({
      getItem: (name) => values.get(name) ?? null,
      setItem: (name, value) => {
        writes.push(value);
        values.set(name, value);
      },
      removeItem: (name) => {
        values.delete(name);
      },
    }));

    storage.setItem("browser", "same");
    storage.removeItem("browser");
    storage.setItem("browser", "same");

    expect(writes).toEqual(["same", "same"]);
  });
});
