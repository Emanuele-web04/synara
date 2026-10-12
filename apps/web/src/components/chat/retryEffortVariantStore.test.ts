import { beforeEach, describe, expect, it } from "vitest";
import { MessageId, ThreadId, TurnId } from "@synara/contracts";

import { getRetryEffortVariantGroup, useRetryEffortVariantStore } from "./retryEffortVariantStore";
import type { RetryEffortVariant } from "./retryWithDifferentEffort.logic";

const threadId = ThreadId.makeUnsafe("retry-thread");
const userMessageId = MessageId.makeUnsafe("same-user-message");
const variant: RetryEffortVariant = {
  id: "old-attempt",
  assistantMessageId: MessageId.makeUnsafe("old-answer"),
  turnId: TurnId.makeUnsafe("old-turn"),
  text: "Answer to the old prompt",
  effort: "high",
  effortLabel: "High",
  provider: "codex",
  model: "gpt-5.4",
  createdAt: "2026-10-11T00:00:00.000Z",
  checkpointTurnCount: 1,
  changedFileCount: 0,
};

beforeEach(() => useRetryEffortVariantStore.setState({ groups: {} }));

describe("retry variants follow the prompt revision", () => {
  it("pages a durable attempt on a client that has no local archive yet", () => {
    useRetryEffortVariantStore.getState().setActiveIndex({
      threadId,
      userMessageId,
      userMessageText: "same prompt",
      archivedVariants: [variant],
      activeIndex: 0,
    });
    expect(
      getRetryEffortVariantGroup(
        useRetryEffortVariantStore.getState(),
        threadId,
        userMessageId,
        "same prompt",
      ),
    ).toMatchObject({ activeIndex: 0, variants: [variant] });
    useRetryEffortVariantStore.getState().setActiveIndex({
      threadId,
      userMessageId,
      userMessageText: "same prompt",
      archivedVariants: [variant],
      activeIndex: 1,
    });
    expect(
      getRetryEffortVariantGroup(
        useRetryEffortVariantStore.getState(),
        threadId,
        userMessageId,
        "same prompt",
      )?.activeIndex,
    ).toBe(1);
  });

  it("ignores a non-integer page index without corrupting the selected attempt", () => {
    const store = useRetryEffortVariantStore.getState();
    store.archiveVariant({ threadId, userMessageId, userMessageText: "same prompt", variant });
    store.setActiveIndex({
      threadId,
      userMessageId,
      userMessageText: "same prompt",
      archivedVariants: [variant],
      activeIndex: Number.NaN,
    });
    expect(
      getRetryEffortVariantGroup(
        useRetryEffortVariantStore.getState(),
        threadId,
        userMessageId,
        "same prompt",
      )?.activeIndex,
    ).toBe(1);
  });

  it("does not display old answers when another client edits the same user message", () => {
    useRetryEffortVariantStore.getState().archiveVariant({
      threadId,
      userMessageId,
      userMessageText: "old prompt",
      variant,
    });
    expect(
      getRetryEffortVariantGroup(
        useRetryEffortVariantStore.getState(),
        threadId,
        userMessageId,
        "old prompt",
      )?.variants,
    ).toEqual([variant]);
    expect(
      getRetryEffortVariantGroup(
        useRetryEffortVariantStore.getState(),
        threadId,
        userMessageId,
        "new prompt",
      ),
    ).toBeNull();
  });

  it("starts a separate attempt group for a new revision instead of mixing answers", () => {
    const store = useRetryEffortVariantStore.getState();
    store.archiveVariant({ threadId, userMessageId, userMessageText: "old prompt", variant });
    const next = {
      ...variant,
      id: "new-attempt",
      assistantMessageId: MessageId.makeUnsafe("new-answer"),
      text: "Answer to the new prompt",
    };
    store.archiveVariant({ threadId, userMessageId, userMessageText: "new prompt", variant: next });
    expect(
      getRetryEffortVariantGroup(
        useRetryEffortVariantStore.getState(),
        threadId,
        userMessageId,
        "new prompt",
      )?.variants,
    ).toEqual([next]);
  });
});
