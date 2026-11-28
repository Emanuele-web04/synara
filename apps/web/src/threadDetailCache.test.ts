import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "./store";
import { initialState } from "./storeState";
import {
  buildCachedThreadDetailEntry,
  clearThreadDetailCache,
  hydrateThreadDetailFromCache,
  mergeCachedThreadDetailIntoState,
  resetThreadDetailCacheForTests,
  THREAD_DETAIL_CACHE_MAX_ACTIVITIES,
  THREAD_DETAIL_CACHE_MAX_MESSAGES,
  trackThreadDetailCache,
  untrackThreadDetailCache,
  warmThreadDetailFromCache,
} from "./threadDetailCache";
import type { ChatMessage, Thread } from "./types";
import type { MessageId, ThreadId } from "@synara/contracts";

const THREAD_ID = "thread-cache-test" as ThreadId;

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: id as MessageId,
    role: "assistant",
    text: `text ${id}`,
    createdAt: "2026-11-18T10:00:00.000Z",
    streaming: false,
    ...overrides,
  };
}

function makeActivity(id: string): Thread["activities"][number] {
  return {
    id,
    tone: "info",
    kind: "tool-call",
    summary: `activity ${id}`,
    payload: {},
    turnId: null,
    createdAt: "2026-11-18T10:00:00.000Z",
  } as Thread["activities"][number];
}

function stateWithDetail(
  messages: ChatMessage[],
  activities: Thread["activities"] = [],
): typeof initialState {
  return {
    ...initialState,
    messageIdsByThreadId: { [THREAD_ID]: messages.map((m) => m.id) },
    messageByThreadId: {
      [THREAD_ID]: Object.fromEntries(messages.map((m) => [m.id, m])),
    },
    activityIdsByThreadId: { [THREAD_ID]: activities.map((a) => a.id) },
    activityByThreadId: {
      [THREAD_ID]: Object.fromEntries(activities.map((a) => [a.id, a])),
    },
  };
}

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  resetThreadDetailCacheForTests();
  vi.restoreAllMocks();
});

describe("buildCachedThreadDetailEntry", () => {
  it("returns null when the thread has no detail slices", () => {
    expect(buildCachedThreadDetailEntry(initialState, THREAD_ID)).toBeNull();
  });

  it("keeps only the newest messages and activities within the bounds", () => {
    const messages = Array.from({ length: 400 }, (_, i) => makeMessage(`m-${i}`));
    const activities = Array.from({ length: 400 }, (_, i) => makeActivity(`a-${i}`));
    const entry = buildCachedThreadDetailEntry(stateWithDetail(messages, activities), THREAD_ID);
    expect(entry?.messages.length).toBe(THREAD_DETAIL_CACHE_MAX_MESSAGES);
    expect(entry?.activities.length).toBe(THREAD_DETAIL_CACHE_MAX_ACTIVITIES);
    expect(entry?.messages.at(-1)?.id).toBe("m-399");
    expect(entry?.activities.at(-1)?.id).toBe("a-399");
  });

  it("drops mid-stream rows instead of persisting them flagged as settled", () => {
    const entry = buildCachedThreadDetailEntry(
      stateWithDetail([
        makeMessage("m-1"),
        makeMessage("m-2", { streaming: true }),
        makeMessage("m-3"),
      ]),
      THREAD_ID,
    );
    expect(entry?.messages.map((m) => m.id)).toEqual(["m-1", "m-3"]);
    expect(entry?.messages.every((m) => !m.streaming)).toBe(true);
  });
});

describe("mergeCachedThreadDetailIntoState", () => {
  it("injects cached slices into an empty thread", () => {
    const entry = {
      messages: [makeMessage("m-1"), makeMessage("m-2")],
      activities: [makeActivity("a-1")],
    };
    const next = mergeCachedThreadDetailIntoState(initialState, THREAD_ID, entry);
    expect(next.messageIdsByThreadId?.[THREAD_ID]).toEqual(["m-1", "m-2"]);
    expect(next.messageByThreadId?.[THREAD_ID]?.["m-1" as MessageId]?.text).toBe("text m-1");
    expect(next.activityIdsByThreadId?.[THREAD_ID]).toEqual(["a-1"]);
  });

  it("does not overwrite detail the live stream already delivered", () => {
    const state = stateWithDetail([makeMessage("live-1")]);
    const next = mergeCachedThreadDetailIntoState(state, THREAD_ID, {
      messages: [makeMessage("m-1")],
      activities: [],
    });
    expect(next).toBe(state);
    expect(next.messageIdsByThreadId?.[THREAD_ID]).toEqual(["live-1"]);
  });

  it("skips tombstoned threads", () => {
    const state = {
      ...initialState,
      deletedThreadIdsById: { [THREAD_ID]: 7 },
    };
    const next = mergeCachedThreadDetailIntoState(state, THREAD_ID, {
      messages: [makeMessage("m-1")],
      activities: [],
    });
    expect(next).toBe(state);
  });
});

describe("trackThreadDetailCache", () => {
  it("tracks and untracks without throwing", () => {
    expect(() => {
      trackThreadDetailCache(THREAD_ID);
      untrackThreadDetailCache(THREAD_ID);
    }).not.toThrow();
  });

  it("hydrates a reopened thread from the same-session mirror", async () => {
    trackThreadDetailCache(THREAD_ID);
    useStore.setState(stateWithDetail([makeMessage("m-1"), makeMessage("m-2")]));
    untrackThreadDetailCache(THREAD_ID);
    useStore.setState(useStore.getInitialState(), true);

    await expect(hydrateThreadDetailFromCache(THREAD_ID)).resolves.toBe(true);
    expect(useStore.getState().messageIdsByThreadId?.[THREAD_ID]).toEqual(["m-1", "m-2"]);
  });

  it("evicts the mirror when a tracked thread's detail leaves the store", async () => {
    trackThreadDetailCache(THREAD_ID);
    useStore.setState(stateWithDetail([makeMessage("m-1")]));
    untrackThreadDetailCache(THREAD_ID);
    // Warm path confirms the mirror holds the tail now.
    expect(await warmThreadDetailFromCache(THREAD_ID)).not.toBeNull();

    // The thread's detail is reverted or evicted while tracked: the pending
    // persist flushes an eviction instead of a write.
    trackThreadDetailCache(THREAD_ID);
    useStore.setState(useStore.getInitialState(), true);
    untrackThreadDetailCache(THREAD_ID);

    expect(await warmThreadDetailFromCache(THREAD_ID)).toBeNull();
    useStore.setState(useStore.getInitialState(), true);
    await expect(hydrateThreadDetailFromCache(THREAD_ID)).resolves.toBe(false);
  });
});

describe("warmThreadDetailFromCache", () => {
  it("warms the mirror for a hovered thread without writing the store", async () => {
    trackThreadDetailCache(THREAD_ID);
    useStore.setState(stateWithDetail([makeMessage("m-1")]));
    untrackThreadDetailCache(THREAD_ID);
    useStore.setState(useStore.getInitialState(), true);

    const warmed = await warmThreadDetailFromCache(THREAD_ID);
    expect(warmed?.messages.map((m) => m.id)).toEqual(["m-1"]);
    // The hover path must not inject unowned detail into the shared store.
    expect(useStore.getState().messageIdsByThreadId?.[THREAD_ID]).toBeUndefined();
    // A later real open paints synchronously from that mirror.
    await expect(hydrateThreadDetailFromCache(THREAD_ID)).resolves.toBe(true);
    expect(useStore.getState().messageIdsByThreadId?.[THREAD_ID]).toEqual(["m-1"]);
  });
});

describe("clearThreadDetailCache", () => {
  it("drops every mirrored tail so a signed-out session leaves nothing to paint", async () => {
    trackThreadDetailCache(THREAD_ID);
    useStore.setState(stateWithDetail([makeMessage("m-1")]));
    untrackThreadDetailCache(THREAD_ID);

    await clearThreadDetailCache();
    useStore.setState(useStore.getInitialState(), true);
    await expect(hydrateThreadDetailFromCache(THREAD_ID)).resolves.toBe(false);
  });
});
