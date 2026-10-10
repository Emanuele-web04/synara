import { afterEach, expect, it, vi } from "vitest";
import { EventId, MessageId, type OrchestrationThreadDetailSnapshot } from "@synara/contracts";
const api = vi.hoisted(() => ({ getThreadDetailSnapshot: vi.fn() }));
vi.mock("./nativeApi", () => ({ ensureNativeApi: () => ({ orchestration: api }) }));
import { useStore } from "./store";
import { removeDeletedThreadFromClientState } from "./storeProjection";
import { initialState } from "./storeState";
import { makeReadModelThread, makeState, makeThread, makeDomainEvent } from "./storeTestFixtures";
import { adoptVerifiedThreadCacheIdentity } from "./threadDetailCacheIdentity";
import { loadThreadHistoryPage, ensureThreadHistoryLoaded } from "./threadHistory";
const cursor = {
  messageId: MessageId.makeUnsafe("current"),
  createdAt: "2026-02-27T00:00:00.000Z",
  sequence: 10,
};
const older = {
  id: MessageId.makeUnsafe("older"),
  turnId: null,
  role: "user" as const,
  text: "first",
  source: "native" as const,
  streaming: false,
  createdAt: cursor.createdAt,
  updatedAt: cursor.createdAt,
};
const thread = makeThread({ messages: [{ ...older, id: cursor.messageId, text: "latest" }] });
const seed = () =>
  useStore.setState({
    ...makeState(thread),
    threadDetailSyncById: { [thread.id]: "synced" },
    threadDetailAppliedSequenceById: { [thread.id]: 20 },
    threadHistoryById: { [thread.id]: { totalMessageCount: 2, olderCursor: cursor } },
  });
const page = () => ({
  snapshotSequence: 19,
  thread: makeReadModelThread({ messages: [older] }),
  history: { totalMessageCount: 2, olderCursor: null },
});
afterEach(() => {
  useStore.setState(initialState);
  api.getThreadDetailSnapshot.mockReset();
});
it.each(["identity", "eviction", "resnapshot", "deletion"])(
  "rejects a late page after %s invalidates its owner",
  async (change) => {
    seed();
    adoptVerifiedThreadCacheIdentity("history-owner");
    let finish!: (value: OrchestrationThreadDetailSnapshot) => void;
    api.getThreadDetailSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = loadThreadHistoryPage(thread.id);
    await Promise.resolve();
    if (change === "identity") adoptVerifiedThreadCacheIdentity("other-owner");
    if (change === "eviction") useStore.getState().evictThreadDetails([thread.id]);
    if (change === "resnapshot")
      useStore.setState({
        threadHistoryById: { [thread.id]: { totalMessageCount: 2, olderCursor: cursor } },
      });
    if (change === "deletion")
      useStore.setState((state) => removeDeletedThreadFromClientState(state, thread.id, 21));
    finish(page());
    expect(await pending).toBe(false);
    expect(useStore.getState().messageByThreadId?.[thread.id]?.[older.id]).toBeUndefined();
  },
);
it("retries a synchronous API failure and stops explicit navigation when cancelled", async () => {
  seed();
  api.getThreadDetailSnapshot
    .mockImplementationOnce(() => {
      throw new Error("offline");
    })
    .mockResolvedValue(page());
  expect(await loadThreadHistoryPage(thread.id)).toBe(false);
  await ensureThreadHistoryLoaded(thread.id, undefined, () => true);
  expect(api.getThreadDetailSnapshot).toHaveBeenCalledTimes(1);
  expect(await loadThreadHistoryPage(thread.id)).toBe(true);
  expect(useStore.getState().messageIdsByThreadId?.[thread.id]).toEqual([
    older.id,
    cursor.messageId,
  ]);
  expect(useStore.getState().threadDetailAppliedSequenceById?.[thread.id]).toBe(20);
});

it("stops tool-only navigation when the server returns the same activity cursor", async () => {
  seed();
  const activityCursor = {
    activityId: EventId.makeUnsafe("tool-only"),
    createdAt: cursor.createdAt,
  };
  const history = { totalMessageCount: 0, olderCursor: null, olderActivityCursor: activityCursor };
  useStore.setState({ threadHistoryById: { [thread.id]: history } });
  api.getThreadDetailSnapshot.mockResolvedValue({ ...page(), history });
  expect(await loadThreadHistoryPage(thread.id)).toBe(false);
  expect(api.getThreadDetailSnapshot).toHaveBeenCalledTimes(1);
  expect(useStore.getState().threadHistoryById?.[thread.id]).toBe(history);
});

it("accepts an older page when a new live message changes only the count", async () => {
  seed();
  adoptVerifiedThreadCacheIdentity("history-owner");
  let finish!: (value: OrchestrationThreadDetailSnapshot) => void;
  api.getThreadDetailSnapshot.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = loadThreadHistoryPage(thread.id);
  await Promise.resolve();
  useStore.getState().applyOrchestrationEvents([
    makeDomainEvent(
      "thread.message-sent",
      {
        threadId: thread.id,
        messageId: MessageId.makeUnsafe("live-new"),
        role: "assistant",
        text: "new live answer",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      },
      { sequence: 21 },
    ),
  ]);
  expect(useStore.getState().threadHistoryById?.[thread.id]?.totalMessageCount).toBe(3);
  expect(useStore.getState().threadHistoryById?.[thread.id]?.olderCursor).toEqual(cursor);
  finish(page());
  expect(await pending).toBe(true);
  expect(useStore.getState().messageIdsByThreadId?.[thread.id]).toEqual([
    older.id,
    cursor.messageId,
    MessageId.makeUnsafe("live-new"),
  ]);
});
