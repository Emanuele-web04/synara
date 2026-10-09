import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { partializeComposerDraftStoreState, useComposerDraftStore } from "./composerDraftStore";
import { toHydratedThreadDraft } from "./composerDraftPersistence";
import {
  makeBrowserAnnotation,
  makeImage,
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

  it("adds an annotation and its image atomically and refuses both at the attachment limit", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({
      id: "annotation-image",
      previewUrl: "blob:annotation-image",
      name: "annotation.png",
    });
    expect(
      store.addBrowserAnnotation(threadId, makeBrowserAnnotation({ id: "with-image" }), image),
    ).toBe(true);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      browserAnnotations: [{ id: "with-image", imageId: image.id }],
      images: [{ id: image.id }],
    });
    store.addImages(
      threadId,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, i) =>
        makeImage({ id: `filler-${i}`, previewUrl: `blob:filler-${i}`, name: `filler-${i}.png` }),
      ),
    );
    expect(
      store.addBrowserAnnotation(
        threadId,
        makeBrowserAnnotation({ id: "rejected" }),
        makeImage({ id: "rejected-image", previewUrl: "blob:rejected" }),
      ),
    ).toBe(false);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.browserAnnotations,
    ).toHaveLength(1);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.images).toHaveLength(
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    );
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
    const live = { ...makeBrowserAnnotation({ id: "live" }), imageId: "image-live" };
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
      { id: "live", ordinal: 1, documentKey: live.documentKey, imageId: "image-live" },
    ]);
    expect(persisted?.queuedTurns?.[0]).toMatchObject({
      kind: "chat",
      browserAnnotations: [{ id: "queued", ordinal: 4 }],
    });

    const hydrated = toHydratedThreadDraft(threadId, persisted!);
    expect(hydrated.browserAnnotations).toMatchObject([
      { id: "live", ordinal: 1, documentKey: live.documentKey, imageId: "image-live" },
    ]);
    expect(hydrated.queuedTurns[0]).toMatchObject({
      kind: "chat",
      browserAnnotations: [{ id: "queued", ordinal: 4 }],
    });
  });
});
