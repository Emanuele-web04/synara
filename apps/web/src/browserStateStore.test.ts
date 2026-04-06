import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { selectThreadBrowserHistory } from "./browserStateStore";

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
