// FILE: storeNormalization.test.ts
// Purpose: pins the incremental activity accumulator to the `normalizeActivities` fold it
// replaces, and locks the legacy session provider-name → ProviderKind mapping.

import { EventId, MessageId, TurnId, type PendingClaudeCacheReview } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ProviderKind } from "@synara/contracts";

import {
  capThreadActivities,
  createThreadActivityAccumulator,
  mergeReadModelThreadDetailWithLiveHotPath,
  normalizeActivities,
  normalizeChatMessage,
  normalizeThreadFromReadModel,
  normalizeThreadSession,
  normalizeThreadShellSnapshot,
  threadShellsEqual,
  toLegacyProvider,
  type ThreadActivityAccumulator,
} from "./storeNormalization";
import { makeActivity, makeReadModelThread, makeThread } from "./storeTestFixtures";
import type { Thread } from "./types";
import { derivePendingUserInputs } from "./pendingInteractionDerivation";

type ThreadActivity = Thread["activities"][number];

describe("pending interaction activity retention", () => {
  const request = makeActivity({
    id: "expired-question",
    kind: "user-input.requested",
    sequence: 2_479_474,
    createdAt: "2026-10-06T19:53:00.000Z",
    payload: {
      requestId: "expired-request",
      lifecycleGeneration: "expired-generation",
      questions: [{ id: "next", header: "Next", question: "Continue?", options: [] }],
    },
  });
  const failure = makeActivity({
    id: "expired-question-failure",
    kind: "provider.user-input.respond.failed",
    sequence: 874_284,
    createdAt: "2026-10-06T22:16:27.000Z",
    payload: {
      requestId: "expired-request",
      lifecycleGeneration: "expired-generation",
      detail: "Stale pending user-input request: expired-request. Restart the turn to continue.",
    },
  });
  const filler = Array.from({ length: 2005 }, (_, index) =>
    makeActivity({ id: `retention-${index}`, sequence: 1_000_000 + index }),
  );

  it("does not retain an expired request outside the window when its failure sorts first", () => {
    const retained = capThreadActivities([failure, request, ...filler]);
    expect(retained).not.toContain(request);
    expect(derivePendingUserInputs(retained)).toEqual([]);
  });

  it.each(["provider.user-input.respond.failed", "user-input.resolved"])(
    "keeps %s evidence for a request retained in the window",
    (kind) => {
      const settlement = {
        ...failure,
        kind,
        sequence: kind === "user-input.resolved" ? request.sequence! + 1 : failure.sequence,
      };
      const retained = capThreadActivities([settlement, ...filler, request]);
      expect(retained).toContain(request);
      expect(retained).toContain(settlement);
      expect(derivePendingUserInputs(retained)).toEqual([]);
    },
  );

  it("preserves a reused request ID when only the previous generation expired", () => {
    const freshRequest = {
      ...request,
      id: EventId.makeUnsafe("fresh-question"),
      createdAt: "2026-10-06T22:17:00.000Z",
      payload: {
        ...(request.payload as Record<string, unknown>),
        lifecycleGeneration: "fresh-generation",
      },
    };
    const retained = capThreadActivities([failure, freshRequest, ...filler]);
    expect(derivePendingUserInputs(retained).map((input) => input.lifecycleGeneration)).toEqual([
      "fresh-generation",
    ]);
  });

  it("does not retain all settled generations of a reused request ID", () => {
    const settledGenerations = Array.from({ length: 1500 }, (_, index) => [
      makeActivity({
        id: `old-request-${index}`,
        kind: "user-input.requested",
        sequence: index * 2,
        payload: { requestId: "reused-request", lifecycleGeneration: `old-${index}` },
      }),
      makeActivity({
        id: `old-resolution-${index}`,
        kind: "user-input.resolved",
        sequence: index * 2 + 1,
        payload: { requestId: "reused-request", lifecycleGeneration: `old-${index}` },
      }),
    ]).flat();
    const current = makeActivity({
      id: "current-request",
      kind: "user-input.requested",
      sequence: 3000,
      payload: { requestId: "reused-request", lifecycleGeneration: "current" },
    });
    const retained = capThreadActivities([...settledGenerations, current]);
    expect(retained).toHaveLength(2000);
    expect(retained).toContain(current);
    expect(retained).not.toContain(settledGenerations[0]);
  });

  it.each([false, true])("bounds delivery failure history (expired=%s)", (expired) => {
    const retries = Array.from({ length: 3000 }, (_, index) => ({
      ...failure,
      id: EventId.makeUnsafe(`retry-${index}`),
      sequence: failure.sequence! + index + 1,
      createdAt: new Date(Date.parse(failure.createdAt) + index + 1).toISOString(),
      payload: {
        ...(failure.payload as Record<string, unknown>),
        detail: "Provider transport unavailable; try again.",
        settlementStatus: "retryable",
      },
    }));
    const retained = capThreadActivities(
      expired ? [failure, ...retries, ...filler, request] : [request, ...retries],
    );
    expect(retained).toHaveLength(expired ? 2002 : 2001);
    expect(retained).toContain(request);
    expect(retained).toContain(retries.at(-1));
    expect(retained).not.toContain(retries[0]);
    if (expired) expect(retained).toContain(failure);
    expect(derivePendingUserInputs(retained)).toHaveLength(expired ? 0 : 1);
  });

  it.each([true, false])(
    "retains legacy failures only after the retained request (later=%s)",
    (later) => {
      const legacy = {
        ...failure,
        createdAt: later ? failure.createdAt : "2026-10-06T19:52:00.000Z",
        payload: {
          requestId: "expired-request",
          detail: "Stale pending user-input request: expired-request.",
        },
      };
      const retained = capThreadActivities([legacy, ...filler, request]);
      expect(retained.includes(legacy)).toBe(later);
      expect(derivePendingUserInputs(retained)).toHaveLength(later ? 0 : 1);
    },
  );
});

const cacheReview: PendingClaudeCacheReview = {
  reviewId: "cache-review-1",
  messageId: MessageId.makeUnsafe("held-message"),
  sourceEventSequence: 8,
  assessment: {
    observedAt: "2026-09-16T10:00:00.000Z",
    contextTokens: 800_000,
    state: "likely-expired",
    source: "session-start",
  },
  status: "pending",
  createdAt: "2026-09-16T10:00:00.000Z",
};

describe("Claude cache review normalization", () => {
  it("reuses equivalent reviews and updates reviews when only their status changes", () => {
    const incoming = makeReadModelThread({ claudeCacheReview: cacheReview });
    const initial = normalizeThreadFromReadModel(incoming, undefined);
    const replay = normalizeThreadFromReadModel(structuredClone(incoming), initial);
    expect(replay).toBe(initial);
    expect(replay.claudeCacheReview).toBe(initial.claudeCacheReview);

    const changed = normalizeThreadFromReadModel(
      { ...incoming, claudeCacheReview: { ...cacheReview, status: "compacting" } },
      initial,
    );
    expect(changed).not.toBe(initial);
    expect(changed.claudeCacheReview?.status).toBe("compacting");
    const cleared = normalizeThreadFromReadModel({ ...incoming, claudeCacheReview: null }, changed);
    expect(cleared.claudeCacheReview).toBeNull();
  });

  it("includes the durable review in shell equality without invalidating equivalent snapshots", () => {
    const incoming = makeReadModelThread({ claudeCacheReview: cacheReview });
    const thread = normalizeThreadFromReadModel(incoming, undefined);
    const initial = normalizeThreadShellSnapshot(incoming, thread).shell;
    const replay = normalizeThreadShellSnapshot(structuredClone(incoming), thread).shell;
    expect(replay.claudeCacheReview).toBe(initial.claudeCacheReview);
    expect(threadShellsEqual(initial, replay)).toBe(true);
    expect(threadShellsEqual(initial, { ...replay, claudeCacheReview: null })).toBe(false);
    expect(
      threadShellsEqual(initial, {
        ...replay,
        claudeCacheReview: { ...cacheReview, status: "failed", error: "Compaction failed" },
      }),
    ).toBe(false);
  });

  it.each([cacheReview, null])(
    "preserves live review state across older detail hydration (%j)",
    (review) => {
      const previous = makeThread({
        claudeCacheReview: review,
        updatedAt: "2026-09-16T10:01:00.000Z",
      });
      const stale = makeReadModelThread({
        claudeCacheReview: review === null ? cacheReview : null,
        updatedAt: "2026-09-16T10:00:00.000Z",
      });
      const merged = mergeReadModelThreadDetailWithLiveHotPath(stale, previous);
      expect(merged.claudeCacheReview).toBe(review);

      const current = { ...stale, updatedAt: "2026-09-16T10:02:00.000Z" };
      expect(mergeReadModelThreadDetailWithLiveHotPath(current, previous).claudeCacheReview).toBe(
        current.claudeCacheReview,
      );
    },
  );
});

interface FoldStep {
  readonly changed: boolean;
}

/**
 * The pre-optimisation batch fold: one full `normalizeActivities` call per appended activity.
 * Kept here (and only here) as the oracle the accumulator must reproduce exactly.
 */
function foldWithNormalizeActivities(
  previous: Thread["activities"],
  batch: readonly ThreadActivity[],
): { readonly result: Thread["activities"]; readonly steps: FoldStep[] } {
  let current = previous;
  const steps: FoldStep[] = [];
  for (const activity of batch) {
    const next = normalizeActivities([...current, activity], current);
    steps.push({ changed: next !== current });
    current = next;
  }
  return { result: current, steps };
}

function foldWithAccumulator(
  previous: Thread["activities"],
  batch: readonly ThreadActivity[],
): { readonly result: Thread["activities"]; readonly steps: FoldStep[] } {
  const accumulator: ThreadActivityAccumulator = createThreadActivityAccumulator(previous);
  const steps = batch.map((activity) => ({ changed: accumulator.append(activity) }));
  return { result: accumulator.result(), steps };
}

function expectEquivalent(previous: Thread["activities"], batch: readonly ThreadActivity[]): void {
  const oracle = foldWithNormalizeActivities(previous, batch);
  const accumulated = foldWithAccumulator(previous, batch);

  expect(accumulated.steps).toEqual(oracle.steps);
  expect(accumulated.result).toEqual(oracle.result);
  expect(accumulated.result.map((activity) => activity.id)).toEqual(
    oracle.result.map((activity) => activity.id),
  );
  // reference-identity contract: both must fall back to `previous` when nothing changed — the reducer uses `next === thread.activities` to decide whether to write at all
  expect(accumulated.result === previous).toBe(oracle.result === previous);
}

const richPayload = {
  itemType: "command_execution",
  title: "Ran command",
  detail: "echo hello",
  data: { item: { type: "commandExecution", command: "echo hello" } },
};

const KNOWN_PROVIDERS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "devin",
  "opencode",
  "pi",
  "omp",
];

describe("createThreadActivityAccumulator", () => {
  it("matches the normalizeActivities fold for appends, in-place merges and exact duplicates", () => {
    const existing = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: richPayload,
      sequence: 1,
    });
    const previous = [makeActivity({ id: "activity-seed", sequence: 0 }), existing];
    const batch: ThreadActivity[] = [
      makeActivity({ id: "activity-new", sequence: 2 }),
      makeActivity({
        id: "activity-command",
        kind: existing.kind,
        summary: existing.summary,
        createdAt: existing.createdAt,
        payload: { title: "Ran command" },
        sequence: 1,
      }),
      { ...existing },
      makeActivity({ id: "activity-seed", payload: richPayload, sequence: 0 }),
      makeActivity({ id: "activity-last", sequence: 3 }),
    ];

    expectEquivalent(previous, batch);
  });

  it("matches the fold across the activity cap, including pending-request retention", () => {
    const pendingApproval = makeActivity({
      id: "activity-approval",
      kind: "approval.requested",
      summary: "Approve?",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: { requestId: "request-1" },
      sequence: 0,
    });
    const resolvedApproval = makeActivity({
      id: "activity-approval-resolved",
      kind: "approval.requested",
      summary: "Approve?",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: { requestId: "request-2" },
      sequence: 1,
    });
    const previous: ThreadActivity[] = [
      pendingApproval,
      resolvedApproval,
      makeActivity({
        id: "activity-approval-resolution",
        kind: "approval.resolved",
        payload: { requestId: "request-2" },
        sequence: 2,
      }),
      ...Array.from({ length: 2100 }, (_, index) =>
        makeActivity({ id: `activity-bulk-${index}`, sequence: 10 + index }),
      ),
    ];
    const batch = Array.from({ length: 25 }, (_, index) =>
      makeActivity({ id: `activity-batch-${index}`, sequence: 10_000 + index }),
    );

    expectEquivalent(previous, batch);

    const accumulated = foldWithAccumulator(previous, batch).result;
    expect(accumulated.some((activity) => activity.id === pendingApproval.id)).toBe(true);
    expect(accumulated.some((activity) => activity.id === resolvedApproval.id)).toBe(false);
  });

  it("returns the previous array by reference when the whole batch is a no-op", () => {
    const previous = [
      makeActivity({ id: "activity-a", sequence: 0 }),
      makeActivity({ id: "activity-b", sequence: 1 }),
    ];
    const accumulator = createThreadActivityAccumulator(previous);

    expect(accumulator.append({ ...previous[0]! })).toBe(false);
    expect(accumulator.append({ ...previous[1]! })).toBe(false);
    expect(accumulator.result()).toBe(previous);
  });

  it("never mutates the caller's previous array", () => {
    const previous = [makeActivity({ id: "activity-a", sequence: 0 })];
    const snapshot = [...previous];
    const accumulator = createThreadActivityAccumulator(previous);

    accumulator.append(makeActivity({ id: "activity-b", sequence: 1 }));
    accumulator.append(makeActivity({ id: "activity-a", payload: richPayload, sequence: 0 }));

    expect(previous).toEqual(snapshot);
    expect(accumulator.result()).not.toBe(previous);
  });
});

describe("dedupeActivitiesByIdAfterAppend", () => {
  const byIdOf = (activities: readonly ThreadActivity[]) =>
    Object.fromEntries(activities.map((activity) => [activity.id, activity]));
});

describe("mergeReadModelThreadDetailWithLiveHotPath", () => {
  it("takes snapshot text when a completed local message is longer than the server twin", () => {
    const assistantId = MessageId.makeUnsafe("assistant-completed-duplicate");
    const turnId = TurnId.makeUnsafe("turn-completed-duplicate");
    const serverText = "Final reply text from the server.";
    const localText = `${serverText}${serverText}`;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const previousThread = makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:05.000Z",
          assistantMessageId: assistantId,
        },
        messages: [
          {
            id: assistantId,
            role: "assistant",
            text: localText,
            turnId,
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:05.000Z",
            streaming: false,
            source: "native",
          },
        ],
      });

      const incoming = makeReadModelThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:05.000Z",
          assistantMessageId: assistantId,
        },
        messages: [
          {
            id: assistantId,
            role: "assistant",
            text: serverText,
            turnId,
            streaming: false,
            source: "native",
            createdAt: "2026-02-27T00:00:01.000Z",
            updatedAt: "2026-02-27T00:00:05.000Z",
            attachments: [],
          },
        ],
      });

      const merged = mergeReadModelThreadDetailWithLiveHotPath(incoming, previousThread);

      expect(merged.messages.find((message) => message.id === assistantId)?.text).toBe(serverText);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prefers longer local assistant text while the live message is still streaming", () => {
    const assistantId = MessageId.makeUnsafe("assistant-still-streaming");
    const turnId = TurnId.makeUnsafe("turn-still-streaming");
    const localText = "I'll start by scanning the repo. Then I'll summarize.";
    const snapshotText = "I'll start by scanning the repo.";
    const previousThread = makeThread({
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      },
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: assistantId,
      },
      messages: [
        {
          id: assistantId,
          role: "assistant",
          text: localText,
          turnId,
          createdAt: "2026-02-27T00:00:01.000Z",
          streaming: true,
          source: "native",
        },
      ],
    });

    const incoming = makeReadModelThread({
      session: {
        threadId: previousThread.id,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: "2026-02-27T00:00:02.000Z",
      },
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: assistantId,
      },
      messages: [
        {
          id: assistantId,
          role: "assistant",
          text: snapshotText,
          turnId,
          streaming: false,
          source: "native",
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
          attachments: [],
        },
      ],
    });

    const merged = mergeReadModelThreadDetailWithLiveHotPath(incoming, previousThread);

    expect(merged.messages.find((message) => message.id === assistantId)?.text).toBe(localText);
    expect(merged.messages.find((message) => message.id === assistantId)?.streaming).toBe(true);
  });
});

describe("accounting activity retention", () => {
  it("keeps 3000 accounting turns within the existing transcript cap", () => {
    const activities = Array.from({ length: 6000 }, (_, index) =>
      makeActivity({
        id: "accounting-" + index,
        turnId: TurnId.makeUnsafe("turn-" + Math.floor(index / 2)),
        kind: index % 2 === 0 ? "context-window.updated" : "turn.completed",
        sequence: index + 1,
      }),
    );
    const normalized = normalizeActivities(activities, undefined);
    expect(normalized).toHaveLength(2000);
    const accumulator = createThreadActivityAccumulator(normalized);
    accumulator.append(
      makeActivity({ id: "new-tool", turnId: TurnId.makeUnsafe("new-turn"), sequence: 6001 }),
    );
    expect(accumulator.result()).toHaveLength(1999);
  });
});

it("keeps the source-message signal stable for equivalent snapshots and work-only changes", () => {
  const incoming = makeReadModelThread({
    messages: [
      {
        id: MessageId.makeUnsafe("signal-message"),
        source: "native",
        role: "assistant",
        text: "Hello",
        turnId: TurnId.makeUnsafe("signal-turn"),
        streaming: true,
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
        textSegments: [
          {
            text: "Hello",
            sequence: 1,
            startedAt: "2026-09-13T00:00:00.000Z",
            endedAt: "2026-09-13T00:00:00.000Z",
          },
        ],
      },
    ],
  });
  const initial = normalizeThreadFromReadModel(incoming, undefined);
  const replay = normalizeThreadFromReadModel(structuredClone(incoming), initial);
  expect(replay.messages).toBe(initial.messages);
  const workOnly = normalizeThreadFromReadModel(
    { ...structuredClone(incoming), activities: [makeActivity({ id: "tool-status" })] },
    replay,
  );
  expect(workOnly.messages).toBe(initial.messages);
  const textDelta = normalizeThreadFromReadModel(
    { ...incoming, messages: [{ ...incoming.messages[0]!, text: "Hello world" }] },
    workOnly,
  );
  expect(textDelta.messages).not.toBe(initial.messages);
  expect(textDelta.messages[0]?.text).toBe("Hello world");
});

describe("asynchronous question hydration", () => {
  it("keeps the accepted answer when a lagging snapshot still has a pending question", () => {
    const createdAt = "2026-09-15T00:00:00.000Z";
    const pending = {
      id: MessageId.makeUnsafe("question"),
      role: "assistant" as const,
      text: "When does it happen?",
      streaming: false,
      source: "native" as const,
      turnId: null,
      createdAt,
      updatedAt: createdAt,
      asyncUserInput: { questions: [{ title: "When does it happen?" }] },
    };
    const response = { messageId: MessageId.makeUnsafe("answer"), answers: ["On reconnect"] };
    const answered = normalizeChatMessage(
      { ...pending, asyncUserInput: { ...pending.asyncUserInput, response } },
      undefined,
    );
    const restored = normalizeChatMessage(pending, answered);
    expect(restored.asyncUserInput?.response).toEqual(response);
    expect(restored.completedAt).toBe(createdAt);
  });
});

describe("toLegacyProvider", () => {
  it("maps each known provider name to itself", () => {
    for (const provider of KNOWN_PROVIDERS) {
      expect(toLegacyProvider(provider)).toBe(provider);
    }
  });

  it("maps omp to omp (regression: omp threads were coerced to codex)", () => {
    // The server stamps providerName "omp" for OMP threads; before the fix this
    // fell through to "codex", mislabeling every OMP thread across the UI
    // (ChatHeader, Sidebar, ChatView activeProvider, kanban, threadDisplay).
    expect(toLegacyProvider("omp")).toBe("omp");
  });

  it("falls back to codex for an unknown provider name", () => {
    expect(toLegacyProvider("unknown-provider")).toBe("codex");
  });

  it("falls back to codex for null", () => {
    expect(toLegacyProvider(null)).toBe("codex");
  });
});

describe("session approval mode", () => {
  it("keeps the active session mode independently of the saved thread mode", () => {
    const thread = makeReadModelThread({ runtimeMode: "full-access" });
    const session = {
      threadId: thread.id,
      status: "running" as const,
      providerName: "codex" as const,
      runtimeMode: "approval-required" as const,
      activeTurnId: TurnId.makeUnsafe("active-approval-turn"),
      lastError: null,
      updatedAt: thread.updatedAt,
    };
    const normalized = normalizeThreadSession(session, null);
    expect(normalized?.runtimeMode).toBe("approval-required");
    const updated = normalizeThreadSession({ ...session, runtimeMode: "full-access" }, normalized);
    expect(updated?.runtimeMode).toBe("full-access");
    expect(updated).not.toBe(normalized);
  });
});
