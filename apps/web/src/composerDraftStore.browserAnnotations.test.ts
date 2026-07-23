import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";
import { toHydratedThreadDraft } from "./composerDraftPersistence";
import {
  makeBrowserAnnotation,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

describe("composerDraftStore browser annotations", () => {
  const threadId = ThreadId.makeUnsafe("thread-annotations");
  const otherThreadId = ThreadId.makeUnsafe("thread-other-annotations");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("isolates batches by thread and keeps ordinals stable after removal", () => {
    const store = useComposerDraftStore.getState();
    expect(store.addBrowserAnnotation(threadId, makeBrowserAnnotation({ id: "a" }))).toBe(true);
    expect(store.addBrowserAnnotation(threadId, makeBrowserAnnotation({ id: "b" }))).toBe(true);
    expect(store.addBrowserAnnotation(otherThreadId, makeBrowserAnnotation({ id: "other" }))).toBe(
      true,
    );

    store.removeBrowserAnnotation(threadId, "a");
    store.addBrowserAnnotation(threadId, makeBrowserAnnotation({ id: "c" }));

    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]?.browserAnnotations.map(({ id, ordinal }) => ({
          id,
          ordinal,
        })),
    ).toEqual([
      { id: "b", ordinal: 2 },
      { id: "c", ordinal: 3 },
    ]);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[otherThreadId]?.browserAnnotations,
    ).toMatchObject([{ id: "other", ordinal: 1 }]);
  });

  it("resets numbering after the batch is emptied", () => {
    const store = useComposerDraftStore.getState();
    store.addBrowserAnnotation(threadId, makeBrowserAnnotation({ id: "a" }));
    store.clearBrowserAnnotations(threadId);
    store.addBrowserAnnotation(threadId, makeBrowserAnnotation({ id: "b", ordinal: 99 }));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.browserAnnotations[0]?.ordinal,
    ).toBe(1);
  });

  it("preserves ids and sparse ordinals when restoring a queued turn", () => {
    const queuedTurn = makeQueuedChatTurn("queued");
    if (queuedTurn.kind !== "chat") {
      throw new Error("Expected chat turn");
    }
    queuedTurn.browserAnnotations = [
      makeBrowserAnnotation({ id: "a", ordinal: 1 }),
      makeBrowserAnnotation({ id: "c", ordinal: 3 }),
    ];

    const store = useComposerDraftStore.getState();
    store.addBrowserAnnotations(threadId, queuedTurn.browserAnnotations);

    expect(
      useComposerDraftStore
        .getState()
        .draftsByThreadId[threadId]?.browserAnnotations.map(({ id, ordinal }) => ({
          id,
          ordinal,
        })),
    ).toEqual([
      { id: "a", ordinal: 1 },
      { id: "c", ordinal: 3 },
    ]);
  });

  it("persists and hydrates live and queued annotations", () => {
    const store = useComposerDraftStore.getState();
    const live = makeBrowserAnnotation({ id: "live" });
    const queued = makeQueuedChatTurn("queued");
    if (queued.kind !== "chat") {
      throw new Error("Expected chat turn");
    }
    queued.browserAnnotations = [makeBrowserAnnotation({ id: "queued", ordinal: 4 })];
    store.addBrowserAnnotation(threadId, live);
    store.enqueueQueuedTurn(threadId, queued);

    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState())
      .draftsByThreadId[threadId];
    expect(persisted?.browserAnnotations).toMatchObject([
      { id: "live", ordinal: 1, documentKey: live.documentKey },
    ]);
    expect(persisted?.queuedTurns?.[0]).toMatchObject({
      kind: "chat",
      browserAnnotations: [{ id: "queued", ordinal: 4 }],
    });

    const hydrated = toHydratedThreadDraft(threadId, persisted!);
    expect(hydrated.browserAnnotations).toMatchObject([
      { id: "live", ordinal: 1, documentKey: live.documentKey },
    ]);
    expect(hydrated.queuedTurns[0]).toMatchObject({
      kind: "chat",
      browserAnnotations: [{ id: "queued", ordinal: 4 }],
    });
  });
});
