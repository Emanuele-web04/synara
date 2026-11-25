import { type ModelSelection, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelSelection } from "../../composerDraftStoreTestFixtures";
import {
  createThreadModelSelectionSync,
  threadModelSelectionToPersist,
  type ThreadModelSelectionView,
} from "./threadModelSelectionSync";

describe("threadModelSelectionToPersist", () => {
  const stored = modelSelection("codex", "gpt-5.5", { reasoningEffort: "high" }, "codex");

  it("stores an effort or speed change on the thread's own provider", () => {
    const composer = modelSelection("codex", "gpt-5.5", { fastMode: true }, "codex");
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: stored,
        composerModelSelection: composer,
      }),
    ).toBe(composer);
  });

  it("leaves another provider to the send-time handoff", () => {
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: stored,
        composerModelSelection: modelSelection(
          "claudeAgent",
          "claude-opus-4-8",
          undefined,
          "claudeAgent",
        ),
      }),
    ).toBeNull();
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: stored,
        composerModelSelection: modelSelection("codex", "gpt-5.5", undefined, "codex_work"),
      }),
    ).toBeNull();
  });

  it("skips an unchanged selection and a chat not created yet", () => {
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: stored,
        composerModelSelection: { ...stored },
      }),
    ).toBeNull();
    expect(
      threadModelSelectionToPersist({
        serverModelSelection: undefined,
        composerModelSelection: stored,
      }),
    ).toBeNull();
  });
});

describe("createThreadModelSelectionSync", () => {
  const threadA = ThreadId.makeUnsafe("thread-a");
  const threadB = ThreadId.makeUnsafe("thread-b");
  const high = modelSelection("codex", "gpt-5.5", { reasoningEffort: "high" }, "codex");
  const low = modelSelection("codex", "gpt-5.5", { reasoningEffort: "low" }, "codex");
  const fast = modelSelection("codex", "gpt-5.5", { fastMode: true }, "codex");

  let persisted: Array<{ threadId: ThreadId; modelSelection: ModelSelection }>;
  let shown: Array<{ threadId: ThreadId; modelSelection: ModelSelection }>;
  let resolvePersist: () => void;
  let sending: boolean;
  let sendListeners: Set<() => void>;

  const makeSync = () =>
    createThreadModelSelectionSync({
      persist: (threadId, selection) => {
        persisted.push({ threadId, modelSelection: selection });
        return new Promise<void>((resolve) => {
          resolvePersist = resolve;
        });
      },
      showSelection: (threadId, selection) => shown.push({ threadId, modelSelection: selection }),
      reportFailure: () => undefined,
      isSending: () => sending,
      subscribeSends: (listener) => {
        sendListeners.add(listener);
        return () => sendListeners.delete(listener);
      },
      now: () => Date.now(),
    });

  const view = (
    threadId: ThreadId,
    serverModelSelection: ModelSelection,
    composerModelSelection: ModelSelection,
    queuedModelSelections: ModelSelection[] = [],
  ): ThreadModelSelectionView => ({
    threadId,
    serverModelSelection,
    composerModelSelection,
    queuedModelSelections,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    persisted = [];
    shown = [];
    resolvePersist = () => undefined;
    sending = false;
    sendListeners = new Set();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a pick after a pause and shows a remote change held back meanwhile", async () => {
    const sync = makeSync();
    sync.updateView(view(threadA, high, low));
    sync.committed(threadA);
    await vi.advanceTimersByTimeAsync(300);
    expect(persisted).toEqual([{ threadId: threadA, modelSelection: low }]);

    // The phone changes the speed while our write is in flight: held back...
    sync.updateView(view(threadA, fast, low));
    sync.serverChanged(threadA);
    expect(shown).toEqual([]);

    // ...and shown once the write settles, with no later server change needed.
    resolvePersist();
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([{ threadId: threadA, modelSelection: fast }]);
  });

  it("stores a pick right away when the composer leaves the chat", async () => {
    const sync = makeSync();
    sync.updateView(view(threadA, high, low));
    sync.committed(threadA);
    // The pane moves to another chat before the pause ends.
    sync.updateView(view(threadB, high, high));
    sync.flush(threadA);
    expect(persisted).toEqual([{ threadId: threadA, modelSelection: low }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(persisted).toHaveLength(1);
  });

  it("stores the later pick again when a queued turn starts with its older selection", async () => {
    const sync = makeSync();
    sync.updateView(view(threadA, high, high, [high]));
    // The user picks low while the queued turn (on high) waits.
    sync.updateView(view(threadA, high, low, [high]));
    sync.committed(threadA);
    await vi.advanceTimersByTimeAsync(300);
    resolvePersist();
    await vi.advanceTimersByTimeAsync(0);
    sync.updateView(view(threadA, low, low, [high]));
    sync.serverChanged(threadA);
    persisted = [];
    shown = [];

    // The queue drains: the turn starts on high and the thread is repainted.
    sync.updateView(view(threadA, high, low, []));
    sync.serverChanged(threadA);
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(persisted).toEqual([{ threadId: threadA, modelSelection: low }]);
  });

  it("waits for a send in progress before storing a pick", async () => {
    const sync = makeSync();
    sending = true;
    sync.updateView(view(threadA, high, low));
    sync.committed(threadA);
    await vi.advanceTimersByTimeAsync(300);
    expect(persisted).toEqual([]);

    sending = false;
    for (const listener of sendListeners) listener();
    expect(persisted).toEqual([{ threadId: threadA, modelSelection: low }]);
  });

  it("shows a remote change when nothing of ours is pending", () => {
    const sync = makeSync();
    sync.updateView(view(threadA, fast, high));
    sync.serverChanged(threadA);
    expect(shown).toEqual([{ threadId: threadA, modelSelection: fast }]);
  });
});
