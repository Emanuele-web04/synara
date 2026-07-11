import * as Schema from "effect/Schema";
import {
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelOptions,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type QueuedComposerTurn,
  captureComposerPromptHistorySavedDraft,
  deriveEffectiveComposerModelState,
  markPromotedDraftThreads,
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { createDebouncedStorage } from "./lib/storage";
import { buildModelSelection, type ProviderOptions } from "./providerModelOptions";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeFile(input: {
  id: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerFileAttachment {
  const name = input.name ?? "notes.txt";
  const mimeType = input.mimeType ?? "text/plain";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(2)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "file",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.makeUnsafe("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

function makeQueuedTurn(id: string): QueuedComposerTurn {
  return {
    id,
    kind: "plan-follow-up",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: `queued ${id}`,
    text: `queued ${id}`,
    interactionMode: "plan",
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
  };
}

function makeQueuedChatTurn(id: string, image?: ComposerImageAttachment): QueuedComposerTurn {
  return {
    id,
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: `queued chat ${id}`,
    prompt: "queued chat prompt",
    images: image ? [image] : [],
    files: [],
    assistantSelections: [],
    terminalContexts: [makeTerminalContext({ id: `ctx-${id}` })],
    fileComments: [],
    pastedTexts: [],
    skills: [{ name: "check-code", path: "/skills/check-code" }],
    mentions: [{ name: "repo", path: "/mentions/repo" }],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      instanceId: "codex",
      model: "gpt-5",
    },
    sourceProposedPlan: {
      threadId: ThreadId.makeUnsafe("thread-source-plan"),
      planId: "plan-1",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function modelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions,
  instanceId?: string,
): ModelSelection {
  return buildModelSelection(provider, model, options, { instanceId });
}

function providerInstanceId(value: string): ProviderInstanceId {
  return value as ProviderInstanceId;
}

function providerModelOptions(options: ProviderModelOptions): ProviderModelOptions {
  return options;
}

describe("resolvePreferredComposerModelSelection", () => {
  it("prefers the active draft provider selection over thread and project defaults", () => {
    expect(
      resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: {
            claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", {
              effort: "max",
            }),
          },
          activeProvider: "claudeAgent",
        },
        threadModelSelection: modelSelection("codex", "gpt-5"),
        projectModelSelection: modelSelection("codex", "gpt-5.4"),
      }),
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );
  });

  it("can prefer Grok draft selections", () => {
    expect(
      resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: {
            grok: modelSelection("grok", "grok-build"),
          },
          activeProvider: "grok",
        },
        threadModelSelection: modelSelection("codex", "gpt-5"),
        projectModelSelection: modelSelection("codex", "gpt-5.4"),
      }),
    ).toEqual(modelSelection("grok", "grok-build"));
  });

  it("prefers the exact active draft provider instance selection", () => {
    expect(
      resolvePreferredComposerModelSelection({
        draft: {
          modelSelectionByProvider: {
            claude_work: modelSelection(
              "claudeAgent",
              "claude-sonnet-work",
              { effort: "max" },
              "claude_work",
            ),
          },
          activeProvider: providerInstanceId("claude_work"),
        },
        threadModelSelection: modelSelection("claudeAgent", "claude-sonnet-default"),
        projectModelSelection: modelSelection("codex", "gpt-5"),
      }),
    ).toEqual(
      modelSelection("claudeAgent", "claude-sonnet-work", { effort: "max" }, "claude_work"),
    );
  });

  it("does not infer an active instance from arbitrary same-provider draft selections", () => {
    const resolved = resolvePreferredComposerModelSelection({
      draft: {
        modelSelectionByProvider: {
          claude_work: modelSelection(
            "claudeAgent",
            "claude-sonnet-work",
            undefined,
            "claude_work",
          ),
          claude_personal: modelSelection(
            "claudeAgent",
            "claude-sonnet-personal",
            undefined,
            "claude_personal",
          ),
        },
        activeProvider: null,
      },
      threadModelSelection: null,
      projectModelSelection: null,
      defaultProvider: "claudeAgent",
      resolveProviderForInstanceId: (instanceId) =>
        instanceId === providerInstanceId("claude_work") ||
        instanceId === providerInstanceId("claude_personal")
          ? "claudeAgent"
          : null,
    });

    expect(resolved).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
    });
  });

  it("falls back to the exact active draft provider instance when no draft model exists", () => {
    const resolved = resolvePreferredComposerModelSelection({
      draft: {
        modelSelectionByProvider: {},
        activeProvider: providerInstanceId("claude_work"),
      },
      threadModelSelection: null,
      projectModelSelection: null,
    });

    expect(resolved.instanceId).toBe("claude_work");
  });

  it("uses configured provider instances for opaque active draft instance ids", () => {
    const resolved = resolvePreferredComposerModelSelection({
      draft: {
        modelSelectionByProvider: {},
        activeProvider: providerInstanceId("work"),
      },
      threadModelSelection: modelSelection("codex", "gpt-5"),
      projectModelSelection: null,
      resolveProviderForInstanceId: (instanceId) =>
        instanceId === providerInstanceId("work") ? "claudeAgent" : null,
    });

    expect(resolved).toEqual({
      instanceId: providerInstanceId("work"),
      model: "claude-sonnet-5",
    });
  });
});

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(threadId, first);
    useComposerDraftStore.getState().addImage(threadId, duplicateLater);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicateSameUrl]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("revokes blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-clear",
      previewUrl: "blob:clear",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
  });

  it("can preserve blob preview URLs for optimistic message handoff", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId, { preservePreviewUrls: true });

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });

  it("clears selected provider references with composer content", () => {
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadId, "Use @linear and /check-code");
    store.setSkills(threadId, [{ name: "check-code", path: "/skills/check-code" }]);
    store.setMentions(threadId, [{ name: "linear", path: "plugin://linear" }]);
    store.clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("composerDraftStore prompt history saved draft", () => {
  const threadId = ThreadId.makeUnsafe("thread-prompt-history-attachments");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("moves composer attachments into the prompt-history snapshot while browsing", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-history", previewUrl: "blob:history" });
    const file = makeFile({ id: "file-history" });
    const persistedAttachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };

    store.setPrompt(threadId, "draft with attachments");
    store.addImage(threadId, image);
    store.addFiles(threadId, [file]);
    store.syncPersistedAttachments(threadId, [persistedAttachment]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;

    useComposerDraftStore.getState().setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    const browsingDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(browsingDraft.images).toHaveLength(0);
    expect(browsingDraft.files).toHaveLength(0);
    expect(browsingDraft.persistedAttachments).toHaveLength(0);
    expect(browsingDraft.promptHistorySavedDraft?.prompt).toBe("draft with attachments");
    expect(browsingDraft.promptHistorySavedDraft?.images.map((entry) => entry.id)).toEqual([
      "img-history",
    ]);
    expect(browsingDraft.promptHistorySavedDraft?.files.map((entry) => entry.id)).toEqual([
      "file-history",
    ]);
    expect(
      browsingDraft.promptHistorySavedDraft?.persistedAttachments.map((entry) => entry.id),
    ).toEqual(["img-history"]);
  });

  it("restores prompt-history snapshot text and attachments together", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-restore", previewUrl: "blob:restore" });
    const file = makeFile({ id: "file-restore" });

    store.setPrompt(threadId, "draft before history");
    store.addImage(threadId, image);
    store.addFiles(threadId, [file]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );
    store.setPrompt(threadId, "recalled history prompt");

    useComposerDraftStore.getState().restorePromptHistorySavedDraft(threadId);

    const restoredDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(restoredDraft.prompt).toBe("draft before history");
    expect(restoredDraft.promptHistorySavedDraft).toBeNull();
    expect(restoredDraft.images.map((entry) => entry.id)).toEqual(["img-restore"]);
    expect(restoredDraft.files.map((entry) => entry.id)).toEqual(["file-restore"]);
  });

  it("moves and restores structured composer context with the prompt-history snapshot", () => {
    const store = useComposerDraftStore.getState();
    const assistantSelection = {
      type: "assistant-selection" as const,
      id: "sel-history",
      assistantMessageId: "assistant-1",
      text: "Use this assistant answer",
    };
    const terminalContext = makeTerminalContext({
      id: "ctx-history",
      text: "bun run check",
    });
    const fileComment = {
      id: "comment-history",
      path: "apps/web/src/App.tsx",
      startLine: 4,
      endLine: 6,
      text: "Please update this range.",
    };
    const pastedText = {
      id: "paste-history",
      createdAt: "2026-03-13T12:00:00.000Z",
      text: "large pasted content",
      lineCount: 1,
      charCount: "large pasted content".length,
    };
    const selectedSkill = { name: "check-code", path: "/skills/check-code" };
    const selectedMention = { name: "linear", path: "plugin://linear" };

    store.setPrompt(threadId, "draft with structured context");
    store.addAssistantSelection(threadId, assistantSelection);
    store.addTerminalContext(threadId, terminalContext);
    store.addFileComment(threadId, fileComment);
    store.addPastedTexts(threadId, [pastedText]);
    store.setSkills(threadId, [selectedSkill]);
    store.setMentions(threadId, [selectedMention]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;

    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    const browsingDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(browsingDraft.assistantSelections).toHaveLength(0);
    expect(browsingDraft.terminalContexts).toHaveLength(0);
    expect(browsingDraft.fileComments).toHaveLength(0);
    expect(browsingDraft.pastedTexts).toHaveLength(0);
    expect(browsingDraft.skills).toHaveLength(0);
    expect(browsingDraft.mentions).toHaveLength(0);
    expect(
      browsingDraft.promptHistorySavedDraft?.assistantSelections.map((entry) => entry.id),
    ).toEqual(["sel-history"]);
    expect(
      browsingDraft.promptHistorySavedDraft?.terminalContexts.map((entry) => entry.id),
    ).toEqual(["ctx-history"]);
    expect(browsingDraft.promptHistorySavedDraft?.fileComments.map((entry) => entry.id)).toEqual([
      "comment-history",
    ]);
    expect(browsingDraft.promptHistorySavedDraft?.pastedTexts.map((entry) => entry.id)).toEqual([
      "paste-history",
    ]);
    expect(browsingDraft.promptHistorySavedDraft?.skills).toEqual([selectedSkill]);
    expect(browsingDraft.promptHistorySavedDraft?.mentions).toEqual([selectedMention]);

    store.setPrompt(threadId, "recalled history prompt");
    store.restorePromptHistorySavedDraft(threadId);

    const restoredDraft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    expect(restoredDraft.prompt).toBe(draftBeforeBrowse.prompt);
    expect(restoredDraft.assistantSelections.map((entry) => entry.id)).toEqual(["sel-history"]);
    expect(restoredDraft.terminalContexts.map((entry) => entry.id)).toEqual(["ctx-history"]);
    expect(restoredDraft.fileComments.map((entry) => entry.id)).toEqual(["comment-history"]);
    expect(restoredDraft.pastedTexts.map((entry) => entry.id)).toEqual(["paste-history"]);
    expect(restoredDraft.skills).toEqual([selectedSkill]);
    expect(restoredDraft.mentions).toEqual([selectedMention]);
  });

  it("persists and hydrates prompt-history snapshot images and structured context", () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-persist-history", previewUrl: "blob:persist-history" });
    const persistedAttachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };
    const terminalContext = makeTerminalContext({
      id: "ctx-persist-history",
      text: "bun run test",
    });
    const pastedText = {
      id: "paste-persist-history",
      createdAt: "2026-03-13T12:00:00.000Z",
      text: "persisted paste",
      lineCount: 1,
      charCount: "persisted paste".length,
    };
    const selectedSkill = { name: "check-code", path: "/skills/check-code" };

    store.setPrompt(threadId, "persist me before history");
    store.addImage(threadId, image);
    store.syncPersistedAttachments(threadId, [persistedAttachment]);
    store.addTerminalContext(threadId, terminalContext);
    store.addPastedTexts(threadId, [pastedText]);
    store.setSkills(threadId, [selectedSkill]);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<string, { promptHistorySavedDraft?: Record<string, unknown> }>;
    };

    expect(
      persistedState.draftsByThreadId?.[threadId]?.promptHistorySavedDraft?.attachments,
    ).toEqual([persistedAttachment]);
    const persistedSnapshot = persistedState.draftsByThreadId?.[threadId]?.promptHistorySavedDraft;
    const persistedTerminalContexts = persistedSnapshot?.terminalContexts as
      | Array<Record<string, unknown>>
      | undefined;
    expect(persistedTerminalContexts?.[0]).toMatchObject({
      id: "ctx-persist-history",
    });
    expect(persistedTerminalContexts?.[0]).not.toHaveProperty("text");
    expect(persistedSnapshot?.pastedTexts).toEqual([
      {
        id: "paste-persist-history",
        createdAt: "2026-03-13T12:00:00.000Z",
        text: "persisted paste",
      },
    ]);
    expect(persistedSnapshot?.skills).toEqual([selectedSkill]);

    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());
    const restoredSnapshot = mergedState.draftsByThreadId[threadId]?.promptHistorySavedDraft;

    expect(restoredSnapshot?.images.map((entry) => entry.id)).toEqual(["img-persist-history"]);
    expect(restoredSnapshot?.files).toEqual([]);
    expect(restoredSnapshot?.terminalContexts).toEqual([
      expect.objectContaining({
        id: "ctx-persist-history",
        text: "",
      }),
    ]);
    expect(restoredSnapshot?.pastedTexts.map((entry) => entry.id)).toEqual([
      "paste-persist-history",
    ]);
    expect(restoredSnapshot?.skills).toEqual([selectedSkill]);
  });

  it("syncs persisted images into an existing prompt-history snapshot", async () => {
    const store = useComposerDraftStore.getState();
    const image = makeImage({ id: "img-sync-history", previewUrl: "blob:sync-history" });
    const persistedAttachment = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: "data:image/png;base64,aGk=",
    };

    store.setPrompt(threadId, "draft before async image persistence");
    store.addImage(threadId, image);
    const draftBeforeBrowse = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    store.setPromptHistorySavedDraft(
      threadId,
      captureComposerPromptHistorySavedDraft({
        threadId,
        draft: draftBeforeBrowse,
        prompt: draftBeforeBrowse.prompt,
      }),
    );

    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 5,
        state: {
          draftsByThreadId: {
            [threadId]: {
              prompt: "recalled history prompt",
              promptHistorySavedDraft: {
                prompt: "draft before async image persistence",
                attachments: [persistedAttachment],
              },
              attachments: [],
            },
          },
          draftThreadsByThreadId: {},
          projectDraftThreadIdByProjectId: {},
        },
      },
      Schema.Unknown,
    );
    store.syncPromptHistorySavedDraftPersistedAttachments(threadId, [persistedAttachment]);
    await Promise.resolve();

    const savedDraft =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.promptHistorySavedDraft;
    expect(savedDraft?.persistedAttachments.map((entry) => entry.id)).toEqual(["img-sync-history"]);
    expect(savedDraft?.nonPersistedImageIds).toEqual([]);
  });
});

describe("composerDraftStore restored source proposed plan", () => {
  const threadId = ThreadId.makeUnsafe("thread-restored-source");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("persists restored plan source metadata with composer drafts", () => {
    const restoredSource = {
      threadId,
      restoredPrompt: "Implement the accepted plan",
      sourceProposedPlan: {
        threadId,
        planId: OrchestrationProposedPlanId.makeUnsafe("plan-restored-source"),
      },
    };
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadId, restoredSource.restoredPrompt);
    store.setRestoredSourceProposedPlan(threadId, restoredSource);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<
        string,
        {
          restoredSourceProposedPlan?: unknown;
        }
      >;
    };

    expect(persistedState.draftsByThreadId?.[threadId]?.restoredSourceProposedPlan).toEqual(
      restoredSource,
    );

    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());

    expect(mergedState.draftsByThreadId[threadId]?.restoredSourceProposedPlan).toEqual(
      restoredSource,
    );
  });
});

describe("composerDraftStore copyTransferableComposerState", () => {
  const sourceThreadId = ThreadId.makeUnsafe("thread-source");
  const targetThreadId = ThreadId.makeUnsafe("thread-target");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("copies the prompt and terminal contexts to the target thread", () => {
    const sourceContext = makeTerminalContext({
      id: "ctx-source",
      text: "pnpm lint",
    });
    const copiedPrompt = insertInlineTerminalContextPlaceholder(
      "Please reuse this context",
      24,
    ).prompt;

    useComposerDraftStore.getState().setPrompt(sourceThreadId, copiedPrompt);
    useComposerDraftStore.getState().setTerminalContexts(sourceThreadId, [sourceContext]);
    useComposerDraftStore
      .getState()
      .setSkills(sourceThreadId, [{ name: "check-code", path: "/skills/check-code" }]);
    useComposerDraftStore
      .getState()
      .setMentions(sourceThreadId, [{ name: "linear", path: "plugin://linear" }]);

    useComposerDraftStore.getState().copyTransferableComposerState(sourceThreadId, targetThreadId);

    const sourceDraft = useComposerDraftStore.getState().draftsByThreadId[sourceThreadId];
    const targetDraft = useComposerDraftStore.getState().draftsByThreadId[targetThreadId];

    expect(targetDraft).toMatchObject({
      prompt: sourceDraft?.prompt,
      terminalContexts: [
        expect.objectContaining({
          id: sourceContext.id,
          threadId: targetThreadId,
          terminalId: sourceContext.terminalId,
          terminalLabel: sourceContext.terminalLabel,
          text: sourceContext.text,
        }),
      ],
      skills: [{ name: "check-code", path: "/skills/check-code" }],
      mentions: [{ name: "linear", path: "plugin://linear" }],
    });
  });

  it("copies image attachments with fresh preview URLs", () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:target-copy");
    try {
      const sourceImage = makeImage({
        id: "img-source",
        previewUrl: "blob:source-preview",
      });

      useComposerDraftStore.getState().addImages(sourceThreadId, [sourceImage]);
      useComposerDraftStore.setState((state) => ({
        draftsByThreadId: {
          ...state.draftsByThreadId,
          [sourceThreadId]: {
            ...state.draftsByThreadId[sourceThreadId]!,
            nonPersistedImageIds: ["img-source"],
          },
        },
      }));
      useComposerDraftStore
        .getState()
        .copyTransferableComposerState(sourceThreadId, targetThreadId);

      const targetDraft = useComposerDraftStore.getState().draftsByThreadId[targetThreadId];
      expect(targetDraft?.images).toEqual([
        expect.objectContaining({
          id: "img-source",
          file: sourceImage.file,
          previewUrl: "blob:target-copy",
        }),
      ]);
      expect(targetDraft?.nonPersistedImageIds).toEqual(["img-source"]);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
    }
  });

  it("preserves unrelated target draft state while replacing transferred composer content", () => {
    useComposerDraftStore.getState().setPrompt(sourceThreadId, "follow-up for the other provider");
    useComposerDraftStore.getState().setModelSelection(
      targetThreadId,
      modelSelection("claudeAgent", "claude-sonnet-4-6", {
        effort: "high",
      }),
    );

    useComposerDraftStore.getState().copyTransferableComposerState(sourceThreadId, targetThreadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[targetThreadId]).toMatchObject({
      prompt: "follow-up for the other provider",
      modelSelectionByProvider: {
        claudeAgent: modelSelection("claudeAgent", "claude-sonnet-4-6", {
          effort: "high",
        }),
      },
      activeProvider: "claudeAgent",
    });
  });

  it("does not transfer thread-bound restored plan source metadata", () => {
    useComposerDraftStore.getState().setPrompt(sourceThreadId, "Implement the accepted plan");
    useComposerDraftStore.getState().setRestoredSourceProposedPlan(sourceThreadId, {
      threadId: sourceThreadId,
      restoredPrompt: "Implement the accepted plan",
      sourceProposedPlan: {
        threadId: sourceThreadId,
        planId: OrchestrationProposedPlanId.makeUnsafe("plan-source-transfer"),
      },
    });

    useComposerDraftStore.getState().copyTransferableComposerState(sourceThreadId, targetThreadId);

    expect(
      useComposerDraftStore.getState().draftsByThreadId[targetThreadId]?.restoredSourceProposedPlan,
    ).toBeNull();
  });
});

describe("composerDraftStore provider references", () => {
  const threadId = ThreadId.makeUnsafe("thread-provider-refs");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("persists selected plugin mentions with regular composer drafts", () => {
    const selectedSkill = { name: "check-code", path: "/skills/check-code" };
    const selectedMention = { name: "linear", path: "plugin://linear" };
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadId, "Use @linear with /check-code");
    store.setSkills(threadId, [selectedSkill]);
    store.setMentions(threadId, [selectedMention]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<
        string,
        {
          skills?: Array<Record<string, unknown>>;
          mentions?: Array<Record<string, unknown>>;
        }
      >;
    };

    expect(persistedState.draftsByThreadId?.[threadId]?.skills).toEqual([selectedSkill]);
    expect(persistedState.draftsByThreadId?.[threadId]?.mentions).toEqual([selectedMention]);

    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());

    expect(mergedState.draftsByThreadId[threadId]?.skills).toEqual([selectedSkill]);
    expect(mergedState.draftsByThreadId[threadId]?.mentions).toEqual([selectedMention]);
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.makeUnsafe("thread-sync-persisted");

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(threadId, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    useComposerDraftStore.getState().syncPersistedAttachments(threadId, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    await Promise.resolve();

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments,
    ).toEqual([]);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.nonPersistedImageIds,
    ).toEqual([image.id]);
  });
});

describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadId, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadId,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadId,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("omits terminal context text from persisted drafts", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadId, makeTerminalContext({ id: "ctx-persist" }));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByThreadId?.[threadId]?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(
      persistedState.draftsByThreadId?.[threadId]?.terminalContexts?.[0]?.text,
    ).toBeUndefined();
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                threadId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftThreadsByThreadId: "not-an-object",
        projectDraftThreadIdByProjectId: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]).toBeUndefined();
    expect(mergedState.draftThreadsByThreadId).toEqual({});
    expect(mergedState.projectDraftThreadIdByProjectId).toEqual({});
  });

  it("drops unsupported restored Grok reasoning efforts from legacy draft storage", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            provider: "grok",
            model: "grok-build",
            modelOptions: {
              grok: {
                reasoningEffort: "xhigh",
              },
            },
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]?.modelSelectionByProvider.grok).toEqual(
      modelSelection("grok", "grok-build"),
    );
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectId(projectId)).toBeNull();
    expect(store.getDraftThread(threadId)).toBeNull();

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId,
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual({
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
  });

  it("tracks temporary draft metadata and lets context updates clear it", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { isTemporary: true });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBe(true);

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/preserve-temp",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBe(true);

    store.setDraftThreadContext(threadId, { isTemporary: false });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBeUndefined();
  });

  it("registers a mapping-less temporary terminal draft for staged navigation", () => {
    const store = useComposerDraftStore.getState();

    store.registerDraftThread(threadId, {
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal")).toBe(
      null,
    );
  });

  it("tracks chat and terminal draft threads independently for the same project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { entryPoint: "chat" });
    store.setProjectDraftThreadId(projectId, otherThreadId, { entryPoint: "terminal" });

    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "chat"),
    ).toMatchObject({
      threadId,
      projectId,
      entryPoint: "chat",
    });
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal"),
    ).toMatchObject({
      threadId: otherThreadId,
      projectId,
      entryPoint: "terminal",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.entryPoint).toBe("chat");
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)?.entryPoint).toBe(
      "terminal",
    );
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");

    store.clearProjectDraftThreadById(projectId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectId, threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when clearing a draft by project and thread id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-project-delete",
        makeImage({ id: "queued-image-delete", previewUrl: "blob:queued-project-delete" }),
      ),
    );

    store.clearProjectDraftThreadById(projectId, threadId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-project-delete");
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");
    store.clearProjectDraftThreadId(projectId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when clearing a project draft by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-project-clear",
        makeImage({ id: "queued-image-clear", previewUrl: "blob:queued-project-clear" }),
      ),
    );

    store.clearProjectDraftThreadId(projectId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-project-clear");
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "orphan me");

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-remap",
        makeImage({ id: "queued-image-remap", previewUrl: "blob:queued-remap" }),
      ),
    );

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-remap");
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setProjectDraftThreadId(otherProjectId, threadId);
    store.setPrompt(threadId, "keep me");
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-kept-thread",
        makeImage({ id: "queued-image-kept", previewUrl: "blob:queued-kept-thread" }),
      ),
    );

    store.clearProjectDraftThreadId(projectId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.queuedTurns).toHaveLength(
      1,
    );
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:queued-kept-thread");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "remove me");
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("marks promoted drafts without deleting composer state until finalization", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "keep me while server thread hydrates");

    markPromotedDraftThreads(new Set([threadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep me while server thread hydrates",
    );

    useComposerDraftStore.getState().finalizePromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(threadId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("moves an empty draft to another project while preserving composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(threadId, "keep this draft");

    store.moveDraftThreadToProject(threadId, otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId,
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep this draft",
    );
  });

  it("clears the replaced target draft when moving a draft to another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(threadId, "move this draft");
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);
    store.setPrompt(otherThreadId, "replace this draft");
    store.enqueueQueuedTurn(
      otherThreadId,
      makeQueuedChatTurn(
        "queued-target-replaced",
        makeImage({ id: "queued-target-replaced", previewUrl: "blob:queued-target-replaced" }),
      ),
    );

    store.moveDraftThreadToProject(threadId, otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId,
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "move this draft",
    );
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-target-replaced");
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });
});

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model-options");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.4"));
  });

  it("preserves provider instance ids when reusing existing model options", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection(
        "codex",
        "gpt-5.3-codex",
        {
          reasoningEffort: "xhigh",
        },
        "codex_work",
      ),
    );

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4", undefined, "codex_work"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .codex_work,
    ).toEqual(
      modelSelection(
        "codex",
        "gpt-5.4",
        {
          reasoningEffort: "xhigh",
        },
        "codex_work",
      ),
    );
  });

  it("keeps same-provider instance selections in separate draft slots", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-sonnet-personal", undefined, "claude_personal"),
    );
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-sonnet-work", { effort: "max" }, "claude_work"),
    );

    const selections =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider;
    expect(selections?.claude_personal).toEqual(
      modelSelection("claudeAgent", "claude-sonnet-personal", undefined, "claude_personal"),
    );
    expect(selections?.claude_work).toEqual(
      modelSelection("claudeAgent", "claude-sonnet-work", { effort: "max" }, "claude_work"),
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.activeProvider).toBe(
      "claude_work",
    );
  });

  it("keeps sticky selections scoped to the exact provider instance", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-sonnet-work", { effort: "max" }, "claude_work"),
    );

    const state = useComposerDraftStore.getState();
    expect(state.stickyModelSelectionByProvider.claude_work).toEqual(
      modelSelection("claudeAgent", "claude-sonnet-work", { effort: "max" }, "claude_work"),
    );
    expect(state.stickyActiveProvider).toBe("claude_work");
  });

  it("stores Grok selections instead of dropping them during normalization", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("grok", "grok-build"));
    store.setStickyModelSelection(modelSelection("grok", "grok-build"));

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.grok).toEqual(
      modelSelection("grok", "grok-build"),
    );
    expect(state.draftsByThreadId[threadId]?.activeProvider).toBe("grok");
    expect(state.stickyModelSelectionByProvider.grok).toEqual(modelSelection("grok", "grok-build"));
    expect(state.stickyActiveProvider).toBe("grok");
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: true },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  it("persists provider option changes to the targeted provider instance", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-sonnet-work", { effort: "max" }, "claude_work"),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { fastMode: true },
      {
        instanceId: providerInstanceId("claude_work"),
        model: "claude-sonnet-work",
        persistSticky: true,
      },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claude_work,
    ).toEqual(
      modelSelection("claudeAgent", "claude-sonnet-work", { fastMode: true }, "claude_work"),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claude_work).toEqual(
      modelSelection("claudeAgent", "claude-sonnet-work", { fastMode: true }, "claude_work"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("claude_work");
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: true,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(threadId, "codex", {
      reasoningEffort: "high",
      fastMode: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadId, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
    ]);
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual([
      { id: "effort", value: "max" },
    ]);
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadId, modelSelection("claudeAgent", "claude-opus-4-6"));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual([
      { id: "fastMode", value: true },
    ]);
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    store.setProviderModelOptions(
      threadId,
      "codex",
      {
        fastMode: true,
      },
      { persistSticky: true },
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("prefers the active OpenCode thread model over a stale draft default when runtime models are available", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          opencode: modelSelection("opencode", "openai/gpt-5"),
        },
        activeProvider: "opencode",
      },
      selectedProvider: "opencode",
      threadModelSelection: modelSelection("opencode", "opencode/gpt-5-nano"),
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        gemini: [],
        grok: [],
        kilo: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        opencode: [{ slug: "opencode/gpt-5-nano", name: "GPT-5 Nano" }],
      },
    });

    expect(state.selectedModel).toBe("opencode/gpt-5-nano");
  });

  it("preserves the persisted OpenCode thread model when discovery omits it", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {},
        activeProvider: "opencode",
      },
      selectedProvider: "opencode",
      threadModelSelection: modelSelection("opencode", "openai/gpt-5.4"),
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        gemini: [],
        grok: [],
        kilo: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        opencode: [
          { slug: "openai/gpt-5-codex", name: "GPT-5-Codex" },
          { slug: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
        ],
      },
    });

    expect(state.selectedModel).toBe("openai/gpt-5.4");
  });

  it("falls back to the first exposed OpenCode runtime model when the draft selection is stale", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          opencode: modelSelection("opencode", "openai/gpt-5"),
        },
        activeProvider: "opencode",
      },
      selectedProvider: "opencode",
      threadModelSelection: null,
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        gemini: [],
        grok: [],
        kilo: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        opencode: [
          { slug: "opencode/gpt-5-nano", name: "GPT-5 Nano" },
          { slug: "opencode/big-pickle", name: "Big Pickle" },
        ],
      },
    });

    expect(state.selectedModel).toBe("opencode/gpt-5-nano");
  });

  it("ignores same-provider draft models and options from a different provider instance", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          codex_personal: modelSelection(
            "codex",
            "gpt-5-personal",
            { effort: "high" },
            "codex_personal",
          ),
        },
        activeProvider: "codex",
      },
      selectedProvider: "codex",
      selectedProviderInstanceId: "codex_work",
      threadModelSelection: null,
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        gemini: [],
        grok: [],
        kilo: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        codex: [
          { slug: "gpt-5-work", name: "GPT-5 Work" },
          { slug: "gpt-5-personal", name: "GPT-5 Personal" },
        ],
      },
    });

    expect(state.selectedModel).toBe("gpt-5-work");
    expect(state.modelOptions?.codex).toBeUndefined();
  });

  it("preserves a selected Pi custom model when discovery omits it", () => {
    const state = deriveEffectiveComposerModelState({
      draft: {
        modelSelectionByProvider: {
          pi: modelSelection("pi", "openai/gpt-5.5"),
        },
        activeProvider: "pi",
      },
      selectedProvider: "pi",
      threadModelSelection: null,
      projectModelSelection: null,
      customModelsByProvider: {
        codex: [],
        claudeAgent: [],
        cursor: [],
        gemini: [],
        grok: [],
        kilo: [],
        opencode: [],
        pi: [],
      },
      availableModelOptionsByProvider: {
        pi: [
          { slug: "openai/gpt-5.1", name: "GPT-5.1" },
          { slug: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        ],
      },
    });

    expect(state.selectedModel).toBe("openai/gpt-5.5");
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: false },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });
});

describe("composerDraftStore queued follow-ups", () => {
  const threadId = ThreadId.makeUnsafe("thread-queue");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores queued turns per thread so route switches can rehydrate them", () => {
    const store = useComposerDraftStore.getState();

    store.enqueueQueuedTurn(threadId, makeQueuedTurn("queued-1"));

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.queuedTurns).toEqual([
      makeQueuedTurn("queued-1"),
    ]);
  });

  it("keeps queued turns when the live composer draft is cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadId, "temporary prompt");
    store.setSkills(threadId, [{ name: "check-code", path: "/skills/check-code" }]);
    store.setMentions(threadId, [{ name: "linear", path: "plugin://linear" }]);
    store.enqueueQueuedTurn(threadId, makeQueuedTurn("queued-1"));
    store.clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      prompt: "",
      skills: [],
      mentions: [],
      queuedTurns: [makeQueuedTurn("queued-1")],
    });
  });

  it("drops the draft entry once the last queued turn is removed", () => {
    const store = useComposerDraftStore.getState();

    store.enqueueQueuedTurn(threadId, makeQueuedTurn("queued-1"));
    store.removeQueuedTurn(threadId, "queued-1");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("persists queued chat turns for refresh and restart rehydration", () => {
    const queuedImage = makeImage({
      id: "queued-image-persisted",
      previewUrl: "data:image/png;base64,AA==",
      name: "queued.png",
    });
    const store = useComposerDraftStore.getState();
    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("queued-chat-1", queuedImage));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<string, { queuedTurns?: Array<Record<string, unknown>> }>;
    };

    expect(persistedState.draftsByThreadId?.[threadId]?.queuedTurns).toHaveLength(1);

    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());

    expect(mergedState.draftsByThreadId[threadId]?.queuedTurns).toMatchObject([
      {
        id: "queued-chat-1",
        kind: "chat",
        prompt: "queued chat prompt",
        images: [{ name: "queued.png" }],
        sourceProposedPlan: {
          threadId: "thread-source-plan",
          planId: "plan-1",
        },
        terminalContexts: [{ text: "git status\nOn branch main" }],
      },
    ]);
  });

  it("persists restored proposed-plan source for edited queued sends", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "implement the queued plan");
    store.setRestoredSourceProposedPlan(threadId, {
      threadId,
      restoredPrompt: "implement the queued plan",
      sourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source-plan"),
        planId: "plan-1",
      },
    });

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadId?: Record<string, { restoredSourceProposedPlan?: unknown }>;
    };

    expect(persistedState.draftsByThreadId?.[threadId]?.restoredSourceProposedPlan).toEqual({
      threadId,
      restoredPrompt: "implement the queued plan",
      sourceProposedPlan: {
        threadId: "thread-source-plan",
        planId: "plan-1",
      },
    });

    const mergedState = persistApi
      .getOptions()
      .merge(persistedState, useComposerDraftStore.getInitialState());

    expect(mergedState.draftsByThreadId[threadId]?.restoredSourceProposedPlan).toEqual({
      threadId,
      restoredPrompt: "implement the queued plan",
      sourceProposedPlan: {
        threadId: "thread-source-plan",
        planId: "plan-1",
      },
    });
  });

  it("revokes queued chat image blob URLs when a queued turn is removed", () => {
    const queuedImage = makeImage({
      id: "queued-image-blob",
      previewUrl: "blob:queued-image-blob",
    });
    const store = useComposerDraftStore.getState();

    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("queued-chat-blob", queuedImage));
    store.removeQueuedTurn(threadId, "queued-chat-blob");

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-image-blob");
  });

  it("revokes queued chat image blob URLs when a draft thread is cleared", () => {
    const queuedImage = makeImage({
      id: "queued-image-thread-clear",
      previewUrl: "blob:queued-image-thread-clear",
    });
    const store = useComposerDraftStore.getState();

    store.setProjectDraftThreadId(ProjectId.makeUnsafe("queue-project"), threadId);
    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("queued-chat-thread-clear", queuedImage));
    store.clearDraftThread(threadId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-image-thread-clear");
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.3-codex"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.3-codex"));
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("preserves current sticky model fields during storage-version migration", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        migrate: (persistedState: unknown, version: number) => unknown;
      };
    };
    const migratedState = persistApi.getOptions().migrate(
      {
        draftsByThreadId: {},
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModelSelectionByProvider: {
          claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", {
            effort: "max",
          }),
        },
        stickyActiveProvider: "claudeAgent",
        stickyProvider: "codex",
        stickyModel: "gpt-5",
      },
      4,
    ) as {
      stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
      stickyActiveProvider: ProviderKind | null;
    };

    expect(migratedState.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );
    expect(migratedState.stickyActiveProvider).toBe("claudeAgent");
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-active-provider");

    store.setStickyModelSelection(modelSelection("claudeAgent", "claude-opus-4-6"));
    store.applyStickyState(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });

  it("strips the Claude context window from sticky selections", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        contextWindow: "1m",
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });

  it("drops sticky Claude options entirely when only the context window was set", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { contextWindow: "1m" }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6"),
    );
  });

  it("does not persist Claude context window changes through sticky provider options", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-context-window");

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { effort: "xhigh", contextWindow: "1m" },
      { persistSticky: true, model: "claude-opus-4-7" },
    );

    const state = useComposerDraftStore.getState();
    // The thread keeps its own context window choice.
    expect(state.draftsByThreadId[threadId]?.modelSelectionByProvider.claudeAgent?.options).toEqual(
      [
        { id: "effort", value: "xhigh" },
        { id: "contextWindow", value: "1m" },
      ],
    );
    // The sticky snapshot only carries options that are safe to inherit.
    expect(state.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-7", { effort: "xhigh" }),
    );
  });

  it("sanitizes a persisted sticky Claude context window during hydration", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (persistedState: unknown, currentState: unknown) => unknown;
      };
    };
    const merged = persistApi.getOptions().merge(
      {
        draftsByThreadId: {},
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModelSelectionByProvider: {
          claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6", {
            effort: "max",
            contextWindow: "1m",
          }),
        },
        stickyActiveProvider: "claudeAgent",
      },
      useComposerDraftStore.getState(),
    ) as {
      stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
    };

    expect(merged.stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.makeUnsafe("thread-provider");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadId, "claudeAgent", { effort: "max" });
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual([
      { id: "effort", value: "max" },
    ]);
    expect(draft?.activeProvider).toBe("codex");
  });

  it("retains Claude xhigh effort in provider-scoped options", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      { effort: "xhigh" },
      { model: "claude-opus-4-7" },
    );

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-7", {
        effort: "xhigh",
      }),
    );
  });

  it("retains Grok reasoning effort in provider-scoped options", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadId,
      "grok",
      { reasoningEffort: "high" },
      { model: "grok-build" },
    );

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.grok).toEqual(
      modelSelection("grok", "grok-build", {
        reasoningEffort: "high",
      }),
    );
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadId, "plan");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "plan",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setInteractionMode(threadId, "plan");
    store.setRuntimeMode(threadId, null);
    store.setInteractionMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("createDebouncedStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates getItem immediately", () => {
    const base = createMockStorage();
    base.getItem.mockReturnValueOnce("value");
    const storage = createDebouncedStorage(base);

    expect(storage.getItem("key")).toBe("value");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("does not write to base storage until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");
  });

  it("only writes the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v3");
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v2");
  });
});
