import {
  DEFAULT_SERVER_SETTINGS,
  type NewThreadDefaults,
  ProjectId,
  type ProviderInstanceId,
  ThreadId,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { modelSelection, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import {
  createNewThreadDefaultsSync,
  type NewThreadDefaultsPatch,
  type NewThreadDefaultsSync,
} from "./newThreadDefaultsSync";

const codexHigh = modelSelection("codex", "gpt-5.5", { reasoningEffort: "high" }, "codex");
const codexFast = modelSelection("codex", "gpt-5.5", { fastMode: true }, "codex");
const claudeOpus = modelSelection("claudeAgent", "claude-opus-4-8", undefined, "claudeAgent");

function serverDefaults(input: Partial<NewThreadDefaults> = {}): NewThreadDefaults {
  return { ...DEFAULT_SERVER_SETTINGS.newThreadDefaults, ...input };
}

describe("createNewThreadDefaultsSync", () => {
  let sync: NewThreadDefaultsSync | null = null;
  let writes: NewThreadDefaultsPatch[];
  let respond: (patch: NewThreadDefaultsPatch) => NewThreadDefaults;

  const start = () => {
    sync = createNewThreadDefaultsSync({
      store: useComposerDraftStore,
      write: async (patch) => {
        writes.push(patch);
        return respond(patch);
      },
    });
    return sync;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetComposerDraftStore();
    writes = [];
    respond = () => serverDefaults();
  });

  // A server that stores each write over the copy it was last given.
  const serveFrom = (initial: NewThreadDefaults) => {
    let stored = initial;
    respond = (patch) => {
      stored = {
        modelSelectionByProvider: {
          ...stored.modelSelectionByProvider,
          ...patch.modelSelectionByProvider,
        },
        activeProvider:
          patch.activeProvider !== undefined ? patch.activeProvider : stored.activeProvider,
        runtimeMode: patch.runtimeMode !== undefined ? patch.runtimeMode : stored.runtimeMode,
      };
      return stored;
    };
    return initial;
  };

  afterEach(() => {
    sync?.dispose();
    sync = null;
    vi.useRealTimers();
  });

  it("adopts the server's copy on the first read", () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: { codex: codexFast },
      stickyActiveProvider: "codex" as ProviderInstanceId,
    });
    start().receive(
      serverDefaults({
        modelSelectionByProvider: { codex: codexHigh, claudeAgent: claudeOpus },
        activeProvider: "claudeAgent" as ProviderInstanceId,
        runtimeMode: "approval-required",
      }),
    );

    const state = useComposerDraftStore.getState();
    expect(state.stickyModelSelectionByProvider).toEqual({
      codex: codexHigh,
      claudeAgent: claudeOpus,
    });
    expect(state.stickyActiveProvider).toBe("claudeAgent");
    expect(state.stickyRuntimeMode).toBe("approval-required");
    expect(writes).toEqual([]);
  });

  it("migrates this browser's choices once when the server has none", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: { codex: codexHigh },
      stickyActiveProvider: "codex" as ProviderInstanceId,
    });
    start().receive(serverDefaults());
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([
      { modelSelectionByProvider: { codex: codexHigh }, activeProvider: "codex" },
    ]);
  });

  it("migrates only what the server has not shared yet", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: { codex: codexHigh },
      stickyActiveProvider: "codex" as ProviderInstanceId,
      stickyRuntimeMode: "approval-required",
    });
    start().receive(serveFrom(serverDefaults({ runtimeMode: "auto" })));
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([
      { modelSelectionByProvider: { codex: codexHigh }, activeProvider: "codex" },
    ]);
    expect(useComposerDraftStore.getState().stickyRuntimeMode).toBe("auto");
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({
      codex: codexHigh,
    });
  });

  it("writes only the fields the user changed, after a pause", async () => {
    start().receive(
      serverDefaults({
        modelSelectionByProvider: { codex: codexHigh },
        activeProvider: "codex" as ProviderInstanceId,
      }),
    );

    useComposerDraftStore.getState().setStickyModelSelection(codexFast);
    useComposerDraftStore.getState().setStickyRuntimeMode("auto");
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);

    expect(writes).toEqual([
      { modelSelectionByProvider: { codex: codexFast }, runtimeMode: "auto" },
    ]);
  });

  it("keeps a pending local change while adopting other fields from the server", async () => {
    start().receive(
      serverDefaults({
        modelSelectionByProvider: { codex: codexHigh },
        activeProvider: "codex" as ProviderInstanceId,
      }),
    );
    useComposerDraftStore.getState().setStickyRuntimeMode("approval-required");

    sync?.receive(
      serverDefaults({
        modelSelectionByProvider: { codex: codexHigh, claudeAgent: claudeOpus },
        activeProvider: "claudeAgent" as ProviderInstanceId,
        runtimeMode: "full-access",
      }),
    );
    const state = useComposerDraftStore.getState();
    expect(state.stickyActiveProvider).toBe("claudeAgent");
    expect(state.stickyModelSelectionByProvider.claudeAgent).toEqual(claudeOpus);
    expect(state.stickyRuntimeMode).toBe("approval-required");

    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toEqual([{ runtimeMode: "approval-required" }]);
  });

  it("moves an open new-chat draft along with a change made on another client", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("draft-1");
    useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId, {
      runtimeMode: "full-access",
    });
    useComposerDraftStore.getState().setModelSelection(threadId, codexHigh);
    start().receive(
      serverDefaults({
        modelSelectionByProvider: { codex: codexHigh },
        activeProvider: "codex" as ProviderInstanceId,
      }),
    );

    sync?.receive(
      serverDefaults({
        modelSelectionByProvider: { codex: codexFast, claudeAgent: claudeOpus },
        activeProvider: "claudeAgent" as ProviderInstanceId,
        runtimeMode: "approval-required",
      }),
    );

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.activeProvider).toBe("claudeAgent");
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.codex).toEqual(codexFast);
    expect(state.draftThreadsByThreadId[threadId]?.runtimeMode).toBe("approval-required");
    expect(writes).toEqual([]);
  });

  it("lets only the latest write release a field and ignores an answer without defaults", async () => {
    const answers: Array<(reply: NewThreadDefaults | undefined) => void> = [];
    sync = createNewThreadDefaultsSync({
      store: useComposerDraftStore,
      write: (patch) => {
        writes.push(patch);
        return new Promise((resolve) => answers.push(resolve));
      },
    });
    sync.receive(serverDefaults());

    useComposerDraftStore.getState().setStickyRuntimeMode("auto");
    await vi.advanceTimersByTimeAsync(300);
    useComposerDraftStore.getState().setStickyRuntimeMode("approval-required");
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toEqual([{ runtimeMode: "auto" }, { runtimeMode: "approval-required" }]);

    // The first write lands (its echo and its answer); the second still owns the field.
    sync.receive(serverDefaults({ runtimeMode: "auto" }));
    answers[0]?.(serverDefaults({ runtimeMode: "auto" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(useComposerDraftStore.getState().stickyRuntimeMode).toBe("approval-required");

    // An answer without defaults (an older server) changes nothing.
    answers[1]?.(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(useComposerDraftStore.getState().stickyRuntimeMode).toBe("auto");
    sync.receive(serverDefaults({ runtimeMode: "approval-required" }));
    expect(useComposerDraftStore.getState().stickyRuntimeMode).toBe("approval-required");
  });
});
