import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  canShowComposerPrediction,
  COMPOSER_PREDICTION_SETTLED_LIMIT,
  COMPOSER_PREDICTION_STORE_LIMIT,
  composerPredictionKey,
  composerPredictionStore,
  fitComposerPredictionText,
  nextComposerPredictionRequest,
  resolveComposerPredictionTarget,
  shouldAcceptComposerPredictionOnTab,
  shouldDiscardComposerPredictionAfterEdit,
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

describe("shouldAcceptComposerPredictionOnTab", () => {
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

  it("accepts on a plain Tab in the focused, empty composer", () => {
    expect(shouldAcceptComposerPredictionOnTab(accepted)).toBe(true);
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
        entry: { status: "pending" as const, controller: new AbortController(), retry: false },
      },
    ],
  ])("keeps normal Tab with %s", (_label, overrides) => {
    expect(shouldAcceptComposerPredictionOnTab({ ...accepted, ...overrides })).toBe(false);
  });
});

describe("shouldDiscardComposerPredictionAfterEdit", () => {
  const ready = { status: "ready" as const, suggestion: "Ship it" };

  it("discards a pending or shown prediction once the user types", () => {
    expect(
      shouldDiscardComposerPredictionAfterEdit({
        previous: { key: "a", prompt: "" },
        next: { key: "a", prompt: "S" },
        entry: ready,
      }),
    ).toBe(true);
    expect(
      shouldDiscardComposerPredictionAfterEdit({
        previous: { key: "a", prompt: "" },
        next: { key: "a", prompt: "S" },
        entry: { status: "pending", controller: new AbortController(), retry: false },
      }),
    ).toBe(true);
  });

  it("ignores a chat or turn switch and an unchanged prompt", () => {
    expect(
      shouldDiscardComposerPredictionAfterEdit({
        previous: { key: "a", prompt: "" },
        next: { key: "b", prompt: "Other chat draft" },
        entry: ready,
      }),
    ).toBe(false);
    expect(
      shouldDiscardComposerPredictionAfterEdit({
        previous: { key: "a", prompt: "" },
        next: { key: "a", prompt: "" },
        entry: ready,
      }),
    ).toBe(false);
  });
});

describe("composerPredictionStore", () => {
  beforeEach(() => {
    composerPredictionStore.setState({ entries: new Map(), settledKeys: new Set() });
  });

  it("forgets the oldest keys past its limit and aborts an evicted request", () => {
    const controller = new AbortController();
    composerPredictionStore
      .getState()
      .setEntry("first", { status: "pending", controller, retry: false });
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
      composerPredictionStore.getState().setEntry(`key-${index}`, { status: "failed" });
    }

    const state = composerPredictionStore.getState();
    expect(state.entries.has("used")).toBe(false);
    expect(state.settledKeys.has("used")).toBe(true);
    expect(
      nextComposerPredictionRequest({ entry: state.entries.get("used"), settled: true }),
    ).toBeNull();
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
  it("asks once for a new key and once more after a failure", () => {
    expect(nextComposerPredictionRequest({ entry: undefined, settled: false })).toEqual({
      retry: false,
    });
    expect(nextComposerPredictionRequest({ entry: { status: "failed" }, settled: false })).toEqual({
      retry: true,
    });
  });

  it("does not ask while a request runs, after a result, or for a settled key", () => {
    const pending = { status: "pending", controller: new AbortController(), retry: false } as const;
    expect(nextComposerPredictionRequest({ entry: pending, settled: false })).toBeNull();
    expect(
      nextComposerPredictionRequest({
        entry: { status: "ready", suggestion: "Ship it" },
        settled: false,
      }),
    ).toBeNull();
    expect(nextComposerPredictionRequest({ entry: { status: "done" }, settled: false })).toBeNull();
    expect(nextComposerPredictionRequest({ entry: undefined, settled: true })).toBeNull();
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
