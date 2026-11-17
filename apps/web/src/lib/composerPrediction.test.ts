import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canShowComposerPrediction,
  COMPOSER_PREDICTION_RETRY_DELAYS_MS,
  COMPOSER_PREDICTION_SETTLED_LIMIT,
  COMPOSER_PREDICTION_STORE_LIMIT,
  composerPredictionEntryForResult,
  composerPredictionKey,
  composerPredictionStore,
  fitComposerPredictionText,
  nextComposerPredictionRequest,
  resolveComposerPredictionInstanceId,
  resolveComposerPredictionTarget,
  shouldAcceptComposerPrediction,
} from "./composerPrediction";

const THREAD = ThreadId.makeUnsafe("thread-1");
const TURN = TurnId.makeUnsafe("turn-1");
const NOW = "2026-11-10T10:00:00.000Z";

const settledTargetInput = {
  enabled: true,
  hostId: '["local","env_1"]',
  threadId: THREAD,
  providerInstanceId: "claude_work",
  latestTurn: {
    turnId: TURN,
    state: "completed" as const,
    completedAt: NOW,
    assistantMessageId: MessageId.makeUnsafe("assistant-1"),
  },
  latestTurnSettled: true,
  hasStreamingAssistant: false,
};

describe("composerPredictionKey", () => {
  it("separates hosts, accounts, threads, and turns", () => {
    const base = { hostId: "host-a", providerInstanceId: "codex", threadId: THREAD, turnId: TURN };
    const keys = new Set([
      composerPredictionKey(base),
      composerPredictionKey({ ...base, hostId: "host-b" }),
      composerPredictionKey({ ...base, providerInstanceId: "codex_work" }),
      composerPredictionKey({ ...base, threadId: ThreadId.makeUnsafe("thread-2") }),
      composerPredictionKey({ ...base, turnId: TurnId.makeUnsafe("turn-2") }),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe("resolveComposerPredictionInstanceId", () => {
  const claudeChat = { provider: "claudeAgent" as const, model: "claude-opus-4-8" };

  it("uses the live session's instance first", () => {
    expect(
      resolveComposerPredictionInstanceId({
        session: { providerInstanceId: "claude_work" },
        modelSelection: { ...claudeChat, instanceId: "other" },
      }),
    ).toBe("claude_work");
  });

  it("falls back to the chat's model selection instance", () => {
    expect(
      resolveComposerPredictionInstanceId({
        session: null,
        modelSelection: { ...claudeChat, instanceId: "claude_work" },
      }),
    ).toBe("claude_work");
  });

  it("gives an older chat with no instance id anywhere its provider, like the server", () => {
    expect(resolveComposerPredictionInstanceId({ session: null, modelSelection: claudeChat })).toBe(
      "claudeAgent",
    );
    expect(resolveComposerPredictionInstanceId({ session: {}, modelSelection: claudeChat })).toBe(
      "claudeAgent",
    );
    expect(
      resolveComposerPredictionTarget({
        ...settledTargetInput,
        providerInstanceId: resolveComposerPredictionInstanceId({
          session: null,
          modelSelection: claudeChat,
        }),
      }),
    ).not.toBeNull();
  });

  it("is null without a thread", () => {
    expect(resolveComposerPredictionInstanceId(null)).toBeNull();
  });
});

describe("resolveComposerPredictionTarget", () => {
  it("targets a completed, settled turn with its final reply", () => {
    expect(resolveComposerPredictionTarget(settledTargetInput)).toEqual({
      key: composerPredictionKey({
        hostId: settledTargetInput.hostId,
        providerInstanceId: "claude_work",
        threadId: THREAD,
        turnId: TURN,
      }),
      threadId: THREAD,
      turnId: TURN,
    });
  });

  it.each([
    ["predictions are off", { enabled: false }],
    ["there is no thread", { threadId: null }],
    ["the account is unknown", { providerInstanceId: undefined }],
    ["there is no turn", { latestTurn: null }],
    [
      "the turn is running",
      { latestTurn: { ...settledTargetInput.latestTurn, state: "running" as const } },
    ],
    [
      "the turn was interrupted",
      { latestTurn: { ...settledTargetInput.latestTurn, state: "interrupted" as const } },
    ],
    [
      "the turn has no completion",
      { latestTurn: { ...settledTargetInput.latestTurn, completedAt: null } },
    ],
    [
      "there is no final reply",
      { latestTurn: { ...settledTargetInput.latestTurn, assistantMessageId: null } },
    ],
    ["the turn is not settled", { latestTurnSettled: false }],
    ["the reply is still streaming", { hasStreamingAssistant: true }],
  ])("returns null when %s", (_label, overrides) => {
    expect(resolveComposerPredictionTarget({ ...settledTargetInput, ...overrides })).toBeNull();
  });
});

describe("canShowComposerPrediction", () => {
  const idle = {
    prompt: "",
    hasAttachments: false,
    menuOpen: false,
    hasLiveTurn: false,
    hasQueuedTurns: false,
    hasPendingUserInput: false,
    isApprovalState: false,
    isReadOnly: false,
  };

  it("shows in an empty, idle, writable composer", () => {
    expect(canShowComposerPrediction(idle)).toBe(true);
  });

  it.each([
    ["draft text", { prompt: " " }],
    ["an attachment or context chip", { hasAttachments: true }],
    ["an open menu", { menuOpen: true }],
    ["a live turn", { hasLiveTurn: true }],
    ["queued turns", { hasQueuedTurns: true }],
    ["a pending user-input request", { hasPendingUserInput: true }],
    ["an approval", { isApprovalState: true }],
    ["a read-only composer", { isReadOnly: true }],
  ])("hides with %s", (_label, overrides) => {
    expect(canShowComposerPrediction({ ...idle, ...overrides })).toBe(false);
  });
});

describe("shouldAcceptComposerPrediction", () => {
  const prediction = { key: "key-1", suggestion: "Rerun the failing test" };
  const accepted = {
    event: {
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      keyCode: 9,
    },
    editorFocused: true,
    snapshot: { value: "", terminalContextIds: [] },
    prediction,
    entry: { status: "ready" as const, suggestion: prediction.suggestion },
  };

  it("accepts on a plain Tab or Right Arrow in the focused, empty composer", () => {
    expect(shouldAcceptComposerPrediction(accepted)).toBe(true);
    expect(
      shouldAcceptComposerPrediction({ ...accepted, event: { ...accepted.event, keyCode: 39 } }),
    ).toBe(true);
  });

  it.each([
    ["Shift", { event: { ...accepted.event, shiftKey: true } }],
    ["Alt", { event: { ...accepted.event, altKey: true } }],
    ["Control", { event: { ...accepted.event, ctrlKey: true } }],
    ["Meta", { event: { ...accepted.event, metaKey: true } }],
    ["an IME composition", { event: { ...accepted.event, isComposing: true } }],
    ["an IME keyCode 229", { event: { ...accepted.event, keyCode: 229 } }],
    ["an unfocused editor", { editorFocused: false }],
    ["text in the editor", { snapshot: { value: "f", terminalContextIds: [] } }],
    ["a terminal context chip", { snapshot: { value: "", terminalContextIds: ["ctx"] } }],
    ["no visible prediction", { prediction: null }],
    ["a consumed prediction", { entry: { status: "done" as const } }],
    ["a replaced suggestion", { entry: { status: "ready" as const, suggestion: "Other" } }],
    [
      "a prediction still pending",
      {
        entry: { status: "pending" as const, controller: new AbortController(), attempt: 1 },
      },
    ],
    ["a prediction without an answer", { entry: { status: "unavailable" as const, attempts: 1 } }],
  ])("keeps the key's normal behavior with %s", (_label, overrides) => {
    expect(shouldAcceptComposerPrediction({ ...accepted, ...overrides })).toBe(false);
  });
});

describe("composerPredictionEntryForResult", () => {
  it("shows a suggestion", () => {
    expect(
      composerPredictionEntryForResult({ suggestion: "Ship it", outcome: "suggested" }, 1),
    ).toEqual({ status: "ready", suggestion: "Ship it" });
    expect(composerPredictionEntryForResult({ suggestion: "Ship it" }, 1)).toEqual({
      status: "ready",
      suggestion: "Ship it",
    });
  });

  it("settles the turn only on the model's own none", () => {
    expect(composerPredictionEntryForResult({ suggestion: null, outcome: "none" }, 2)).toEqual({
      status: "done",
    });
  });

  it("keeps an unavailable answer retryable, counting the attempt", () => {
    expect(
      composerPredictionEntryForResult({ suggestion: null, outcome: "unavailable" }, 2),
    ).toEqual({ status: "unavailable", attempts: 2 });
  });

  it("treats a bare null from an older server as unavailable, not as an answer", () => {
    expect(composerPredictionEntryForResult({ suggestion: null }, 1)).toEqual({
      status: "unavailable",
      attempts: 1,
      limitRetries: true,
    });
  });
});

describe("composerPredictionStore", () => {
  beforeEach(() => {
    composerPredictionStore.setState({ entries: new Map(), settledKeys: new Set() });
  });

  it("recovers turns muted by v1 storage and preserves v2 settlements on reload", async () => {
    const storage = new Map<string, string>([
      ["synara:composer-prediction-settled:v1", JSON.stringify(["old-turn"])],
    ]);
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    try {
      vi.resetModules();
      const current = (await import("./composerPrediction")).composerPredictionStore.getState();
      expect(
        nextComposerPredictionRequest({
          entry: undefined,
          settled: current.settledKeys.has("old-turn"),
        }),
      ).toEqual({ attempt: 1, delayMs: 0 });
      current.setEntry("new-turn", { status: "done" });

      vi.resetModules();
      const reloaded = (await import("./composerPrediction")).composerPredictionStore.getState();
      expect(reloaded.settledKeys).toEqual(new Set(["new-turn"]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forgets the oldest keys past its limit and aborts an evicted request", () => {
    const controller = new AbortController();
    composerPredictionStore
      .getState()
      .setEntry("first", { status: "pending", controller, attempt: 1 });
    for (let index = 0; index < COMPOSER_PREDICTION_STORE_LIMIT; index += 1) {
      composerPredictionStore.getState().setEntry(`key-${index}`, { status: "done" });
    }

    const entries = composerPredictionStore.getState().entries;
    expect(entries.size).toBe(COMPOSER_PREDICTION_STORE_LIMIT);
    expect(entries.has("first")).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it("remembers a settled key after its entry was evicted", () => {
    composerPredictionStore.getState().setEntry("used", { status: "done" });
    for (let index = 0; index < COMPOSER_PREDICTION_STORE_LIMIT; index += 1) {
      composerPredictionStore
        .getState()
        .setEntry(`key-${index}`, { status: "unavailable", attempts: 1 });
    }

    const state = composerPredictionStore.getState();
    expect(state.entries.has("used")).toBe(false);
    expect(state.settledKeys.has("used")).toBe(true);
    expect(
      nextComposerPredictionRequest({ entry: state.entries.get("used"), settled: true }),
    ).toBeNull();
  });

  it("settles only done keys, never ready or unavailable ones", () => {
    const store = composerPredictionStore.getState();
    store.setEntry("ready", { status: "ready", suggestion: "Ship it" });
    store.setEntry("unavailable", { status: "unavailable", attempts: 3 });
    store.setEntry("done", { status: "done" });

    expect([...composerPredictionStore.getState().settledKeys]).toEqual(["done"]);
  });

  it("bounds the settled keys, dropping the oldest first", () => {
    for (let index = 0; index <= COMPOSER_PREDICTION_SETTLED_LIMIT; index += 1) {
      composerPredictionStore.getState().setEntry(`key-${index}`, { status: "done" });
    }

    const { settledKeys } = composerPredictionStore.getState();
    expect(settledKeys.size).toBe(COMPOSER_PREDICTION_SETTLED_LIMIT);
    expect(settledKeys.has("key-0")).toBe(false);
    expect(settledKeys.has(`key-${COMPOSER_PREDICTION_SETTLED_LIMIT}`)).toBe(true);
  });
});

describe("nextComposerPredictionRequest", () => {
  it("asks at once for a new key", () => {
    expect(nextComposerPredictionRequest({ entry: undefined, settled: false })).toEqual({
      attempt: 1,
      delayMs: 0,
    });
  });

  it("retries an unanswered key after 2, 5, and 15 seconds, then stops", () => {
    expect(COMPOSER_PREDICTION_RETRY_DELAYS_MS).toEqual([2_000, 5_000, 15_000]);
    const after = (attempts: number) =>
      nextComposerPredictionRequest({ entry: { status: "unavailable", attempts }, settled: false });
    expect(after(1)).toEqual({ attempt: 2, delayMs: 2_000 });
    expect(after(2)).toEqual({ attempt: 3, delayMs: 5_000 });
    expect(after(3)).toEqual({ attempt: 4, delayMs: 15_000 });
    expect(after(4)).toBeNull();
  });

  it("does not ask while a request runs, after a result, or for a settled key", () => {
    const pending = { status: "pending", controller: new AbortController(), attempt: 1 } as const;
    expect(nextComposerPredictionRequest({ entry: pending, settled: false })).toBeNull();
    expect(
      nextComposerPredictionRequest({
        entry: { status: "ready", suggestion: "Ship it" },
        settled: false,
      }),
    ).toBeNull();
    expect(nextComposerPredictionRequest({ entry: { status: "done" }, settled: false })).toBeNull();
    expect(nextComposerPredictionRequest({ entry: undefined, settled: true })).toBeNull();
    expect(
      nextComposerPredictionRequest({
        entry: { status: "unavailable", attempts: 1 },
        settled: true,
      }),
    ).toBeNull();
  });
});

// A stand-in for the rendered rows: at most `limit` characters fit.
const fitsWithin = (limit: number) => (candidate: string) => candidate.length <= limit;

describe("fitComposerPredictionText", () => {
  const suggestion = "Go ahead with the first two steps, but leave the third out for now.";

  it("keeps a suggestion that fits whole", () => {
    expect(fitComposerPredictionText(suggestion, fitsWithin(200))).toBe(suggestion);
  });

  it("cuts at the last whole word that fits and ends with an ellipsis", () => {
    expect(fitComposerPredictionText(suggestion, fitsWithin(36))).toBe(
      "Go ahead with the first two steps\u2026",
    );
  });

  it("cuts a single overlong word by characters", () => {
    expect(fitComposerPredictionText("abcdefghijklmnop rest", fitsWithin(6))).toBe("abcde\u2026");
  });

  it("asks only about candidates no longer than the suggestion", () => {
    const asked: string[] = [];
    fitComposerPredictionText(suggestion, (candidate) => {
      asked.push(candidate);
      return candidate.length <= 20;
    });
    expect(asked.every((candidate) => candidate.length <= suggestion.length)).toBe(true);
    expect(asked.length).toBeLessThan(10);
  });
});
