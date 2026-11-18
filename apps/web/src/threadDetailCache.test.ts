import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "./store";
import { initialState } from "./storeState";
import {
  buildCachedThreadDetailEntry,
  hydrateThreadDetailFromCache,
  mergeCachedThreadDetailIntoState,
  resetThreadDetailCacheForTests,
  THREAD_DETAIL_CACHE_MAX_ACTIVITIES,
  THREAD_DETAIL_CACHE_MAX_MESSAGES,
  trackThreadDetailCache,
  untrackThreadDetailCache,
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

  it("clears the streaming flag so a rolled-back row cannot linger as streaming", () => {
    const entry = buildCachedThreadDetailEntry(
      stateWithDetail([makeMessage("m-1", { streaming: true })]),
      THREAD_ID,
    );
    expect(entry?.messages[0]?.streaming).toBe(false);
  });
});

describe("mergeCachedThreadDetailIntoState", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
  });

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

  it("injects into the live store only while empty", () => {
    useStore.setState({
      messageIdsByThreadId: { [THREAD_ID]: ["live-1" as MessageId] },
      messageByThreadId: { [THREAD_ID]: { ["live-1" as MessageId]: makeMessage("live-1") } },
    });
    const next = mergeCachedThreadDetailIntoState(useStore.getState(), THREAD_ID, {
      messages: [makeMessage("m-1")],
      activities: [],
    });
    expect(next.messageIdsByThreadId?.[THREAD_ID]).toEqual(["live-1"]);
  });
});

describe("trackThreadDetailCache", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    resetThreadDetailCacheForTests();
  });

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
});
