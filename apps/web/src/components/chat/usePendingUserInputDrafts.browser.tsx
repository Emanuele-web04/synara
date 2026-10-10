import {
  ApprovalRequestId,
  ThreadId,
  type OrchestrationPendingInteraction,
} from "@synara/contracts";
import {
  buildStalePendingRequestFailureDetail,
  pendingRequestInstanceKey,
} from "@synara/shared/threadSummary";
import { afterEach, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import {
  makeActivity,
  makeDomainEvent,
  makeState,
  makeThread,
  threadsOf,
} from "../../storeTestFixtures";
import { applyOrchestrationEvents } from "../../storeEventReducer";
import { capThreadActivities } from "../../storeNormalization";
import { usePendingUserInputDrafts } from "./usePendingUserInputDrafts";

afterEach(() => resetComposerDraftStore());

it.each(["stale", "pruned-stale", "delivered", "old-generation-resolution"])(
  "handles saved answers after %s",
  async (scenario) => {
    const threadId = ThreadId.makeUnsafe("draft-thread");
    const requestId = ApprovalRequestId.makeUnsafe("draft-request");
    const createdAt = "2026-10-06T19:53:00.000Z";
    const resolvedAt = "2026-10-06T22:16:27.000Z";
    const lifecycleGeneration = "draft-generation";
    const key = pendingRequestInstanceKey(requestId, lifecycleGeneration);
    const draft = {
      request: {
        requestId,
        lifecycleGeneration,
        createdAt,
        questions: [{ id: "next", header: "Next", question: "Continue?", options: [] }],
      },
      answers: { next: { customAnswer: "Keep my answer" } },
    };
    const settlement: OrchestrationPendingInteraction = {
      interactionKind: "userInput",
      requestId,
      threadId,
      lifecycleGeneration,
      turnId: null,
      status: "confirmed",
      decision: null,
      responseCommandId: null,
      responseRequestedAt: null,
      createdAt,
      resolvedAt,
    };
    const stale = scenario === "stale" || scenario === "pruned-stale";
    const requested = makeActivity({
      kind: "user-input.requested",
      createdAt,
      payload: draft.request,
    });
    const resolution = makeActivity({
      id: "resolution",
      kind: stale ? "provider.user-input.respond.failed" : "user-input.resolved",
      createdAt: resolvedAt,
      payload: {
        requestId,
        lifecycleGeneration:
          scenario === "old-generation-resolution" ? "older-generation" : lifecycleGeneration,
        ...(stale
          ? { detail: buildStalePendingRequestFailureDetail("user-input", requestId) }
          : {}),
      },
    });
    const next = applyOrchestrationEvents(
      makeState(
        makeThread({
          id: threadId,
          activities: [requested],
          pendingInteractions: [{ ...settlement, status: "pending", resolvedAt: null }],
        }),
      ),
      [makeDomainEvent("thread.activity-appended", { threadId, activity: resolution })],
    );
    const thread = threadsOf(next)[0]!;
    const activities =
      scenario === "pruned-stale"
        ? capThreadActivities([
            ...thread.activities,
            ...Array.from({ length: 2001 }, (_, index) =>
              makeActivity({ id: `after-expiration-${index}`, kind: "tool.completed" }),
            ),
          ])
        : thread.activities;
    if (scenario === "pruned-stale")
      expect(
        activities.some((activity) => activity.kind === "provider.user-input.respond.failed"),
      ).toBe(false);
    if (scenario === "delivered") expect(thread.pendingInteractions).toEqual([]);
    useComposerDraftStore.getState().setPendingUserInputDrafts(threadId, { [key]: draft });
    const hook = await renderHook(() => usePendingUserInputDrafts(threadId, [], activities));
    try {
      await expect
        .poll(
          () =>
            useComposerDraftStore.getState().draftsByThreadId[threadId]?.pendingUserInputDrafts?.[
              key
            ],
        )
        .toEqual(scenario === "delivered" ? undefined : draft);
    } finally {
      await hook.unmount();
    }
  },
);
