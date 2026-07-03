import { ThreadId, TurnId, type ModelSlug } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appendVoiceTranscriptToPrompt,
  buildComposerMenuSelectionKey,
  filterSidechatTranscriptMessages,
  type LocalDispatchSnapshot,
  deriveComposerSendState,
  deriveComposerVoiceState,
  describeVoiceRecordingStartError,
  hasServerAcknowledgedLocalDispatch,
  isVoiceAuthExpiredMessage,
  resolveActiveThreadTitle,
  resolveActiveTurnLiveDiffState,
  resolveCommittedProviderModel,
  resolveDefaultEnvironmentPanelOpen,
  resolveEnvironmentPanelOpen,
  resolveEnvironmentPanelVisible,
  resolveProjectScriptTerminalTarget,
  resolveQueuedSteerGateTransition,
  resolveRuntimeModeAfterApprovalDecision,
  QUEUED_STEER_GATE_TIMEOUT_MS,
  sanitizeVoiceErrorMessage,
  buildExpiredTerminalContextToastCopy,
  shouldAutoDeleteTerminalThreadOnLastClose,
  shouldConsumePendingCustomBinaryConfirmation,
  shouldEnableComposerPastedTextCollapse,
  shouldRenderProviderHealthBanner,
  shouldShowComposerModelBootstrapSkeleton,
  shouldStartActiveTurnLayoutGrace,
  shouldRenderTerminalWorkspace,
} from "./ChatView.logic";

describe("composer menu selection", () => {
  const items = [{ id: "skill:check-code" }, { id: "skill:sanity-check" }] as const;

  it("builds a stable key from query and displayed item order", () => {
    const baseKey = buildComposerMenuSelectionKey({
      menuOpen: true,
      picker: null,
      triggerKind: "slash-command",
      triggerQuery: "check",
      items,
    });

    expect(
      buildComposerMenuSelectionKey({
        menuOpen: true,
        picker: null,
        triggerKind: "slash-command",
        triggerQuery: "check",
        items: [...items],
      }),
    ).toBe(baseKey);
    expect(
      buildComposerMenuSelectionKey({
        menuOpen: true,
        picker: null,
        triggerKind: "slash-command",
        triggerQuery: "chec",
        items,
      }),
    ).not.toBe(baseKey);
    expect(
      buildComposerMenuSelectionKey({
        menuOpen: true,
        picker: null,
        triggerKind: "slash-command",
        triggerQuery: "check",
        items: [...items].reverse(),
      }),
    ).not.toBe(baseKey);
  });

  it("returns null while the menu is closed", () => {
    expect(
      buildComposerMenuSelectionKey({
        menuOpen: false,
        picker: null,
        triggerKind: "slash-command",
        triggerQuery: "check",
        items,
      }),
    ).toBeNull();
  });
});

describe("composer pasted text collapse", () => {
  it("is enabled only for regular chat sends", () => {
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: false,
        hasPendingUserInput: false,
        showPlanFollowUpPrompt: false,
      }),
    ).toBe(true);
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: false,
        hasPendingUserInput: true,
        showPlanFollowUpPrompt: false,
      }),
    ).toBe(false);
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: false,
        hasPendingUserInput: false,
        showPlanFollowUpPrompt: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableComposerPastedTextCollapse({
        isComposerApprovalState: true,
        hasPendingUserInput: false,
        showPlanFollowUpPrompt: false,
      }),
    ).toBe(false);
  });
});

describe("voice helpers", () => {
  it("keeps manual titles visible for empty home chats", () => {
    expect(
      resolveActiveThreadTitle({
        title: "Roadmap scratchpad",
        subagentTitle: null,
        isHomeChat: true,
        isEmpty: true,
      }),
    ).toBe("Roadmap scratchpad");
  });

  it("maps untouched empty home chats to the friendly header label", () => {
    expect(
      resolveActiveThreadTitle({
        title: "New thread",
        subagentTitle: null,
        isHomeChat: true,
        isEmpty: true,
      }),
    ).toBe("New Chat");
  });

  it("prefers the resolved subagent label when present", () => {
    expect(
      resolveActiveThreadTitle({
        title: "Ignored raw title",
        subagentTitle: "Reviewer / Fix follow-up",
        isHomeChat: false,
        isEmpty: false,
      }),
    ).toBe("Reviewer / Fix follow-up");
  });

  it("hides fork-imported transcript rows only for sidechats", () => {
    const messages = [
      {
        id: "message-imported" as never,
        role: "assistant",
        text: "Previous context",
        turnId: null,
        streaming: false,
        source: "fork-import",
        createdAt: "2026-05-02T10:00:00.000Z",
        completedAt: "2026-05-02T10:00:00.000Z",
      },
      {
        id: "message-native" as never,
        role: "user",
        text: "Fresh side question",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-05-02T10:01:00.000Z",
        completedAt: "2026-05-02T10:01:00.000Z",
      },
    ] as const;

    expect(filterSidechatTranscriptMessages(messages, true).map((message) => message.id)).toEqual([
      "message-native",
    ]);
    expect(filterSidechatTranscriptMessages(messages, false).map((message) => message.id)).toEqual([
      "message-imported",
      "message-native",
    ]);
  });

  it("appends a transcript to the existing prompt without disturbing spacing", () => {
    expect(appendVoiceTranscriptToPrompt("Hello there   ", "  next line  ")).toBe(
      "Hello there\nnext line",
    );
  });

  it("returns null when the transcript is empty", () => {
    expect(appendVoiceTranscriptToPrompt("Hello", "   ")).toBeNull();
  });

  it("sanitizes inline stack traces from voice errors", () => {
    expect(
      sanitizeVoiceErrorMessage(
        "Your ChatGPT login has expired. Sign in again. at file:///Users/test/app.mjs:12:3",
      ),
    ).toBe("Your ChatGPT login has expired. Sign in again.");
  });

  it("strips desktop bridge wrappers from voice errors", () => {
    expect(
      sanitizeVoiceErrorMessage(
        "Error invoking remote method 'desktop:server-transcribe-voice': Error: The transcription response did not include any text.",
      ),
    ).toBe("The transcription response did not include any text.");
  });

  it("detects auth-expired copy in sanitized voice errors", () => {
    expect(isVoiceAuthExpiredMessage("Sign in again to ChatGPT")).toBe(true);
    expect(isVoiceAuthExpiredMessage("The microphone could not be opened.")).toBe(false);
  });

  it("maps microphone permission errors to clearer copy", () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";

    expect(describeVoiceRecordingStartError(error)).toContain("Microphone access was denied");
  });

  it("derives voice-note availability from provider auth and runtime state", () => {
    expect(
      deriveComposerVoiceState({
        authStatus: "authenticated",
        voiceTranscriptionAvailable: true,
        isRecording: false,
        isTranscribing: false,
      }),
    ).toEqual({
      canRenderVoiceNotes: true,
      canStartVoiceNotes: true,
      showVoiceNotesControl: true,
    });

    expect(
      deriveComposerVoiceState({
        authStatus: "unauthenticated",
        voiceTranscriptionAvailable: true,
        isRecording: true,
        isTranscribing: false,
      }),
    ).toEqual({
      canRenderVoiceNotes: false,
      canStartVoiceNotes: false,
      showVoiceNotesControl: true,
    });
  });
});

describe("environment panel visibility", () => {
  it("opens normal chat threads by default", () => {
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: false,
      }),
    ).toBe(true);
  });

  it("keeps empty landing, terminal-primary, and constrained layouts closed by default", () => {
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: true,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: false,
      }),
    ).toBe(false);
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: true,
        isConstrainedChatLayout: false,
      }),
    ).toBe(false);
    expect(
      resolveDefaultEnvironmentPanelOpen({
        environmentEnabled: true,
        isCenteredEmptyLanding: false,
        isTerminalPrimarySurface: false,
        isConstrainedChatLayout: true,
      }),
    ).toBe(false);
  });

  it("lets a manual preference override the default while switching chats", () => {
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        actionDismissed: false,
        userPreferenceOpen: null,
      }),
    ).toBe(true);
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        actionDismissed: false,
        userPreferenceOpen: false,
      }),
    ).toBe(false);
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: false,
        actionDismissed: false,
        userPreferenceOpen: true,
      }),
    ).toBe(true);
  });

  it("treats action dismissals as transient closes instead of stored preferences", () => {
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        actionDismissed: true,
        userPreferenceOpen: null,
      }),
    ).toBe(false);
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: true,
        actionDismissed: false,
        userPreferenceOpen: null,
      }),
    ).toBe(true);
    expect(
      resolveEnvironmentPanelOpen({
        defaultOpen: false,
        actionDismissed: true,
        userPreferenceOpen: true,
      }),
    ).toBe(false);
  });

  it("renders the panel when the user toggles it open on empty landing", () => {
    expect(
      resolveEnvironmentPanelVisible({
        environmentEnabled: true,
        environmentPanelOpen: true,
      }),
    ).toBe(true);
  });

  it("keeps the panel hidden when environment controls are disabled or closed", () => {
    expect(
      resolveEnvironmentPanelVisible({
        environmentEnabled: false,
        environmentPanelOpen: true,
      }),
    ).toBe(false);
    expect(
      resolveEnvironmentPanelVisible({
        environmentEnabled: true,
        environmentPanelOpen: false,
      }),
    ).toBe(false);
  });
});

describe("resolveActiveTurnLiveDiffState", () => {
  it("uses only the diff summary for the active turn", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-previous"),
            completedAt: "2026-06-13T10:00:00.000Z",
            files: [{ path: "old.ts", additions: 100, deletions: 50 }],
          },
          {
            turnId: activeTurnId,
            completedAt: "2026-06-13T10:01:00.000Z",
            files: [
              { path: "src/a.ts", additions: 2, deletions: 1 },
              { path: "src/b.ts", additions: 3, deletions: 0 },
            ],
          },
        ],
      }),
    ).toEqual({
      turnId: activeTurnId,
      fileCount: 2,
      additions: 5,
      deletions: 1,
      hasChanges: true,
    });
  });

  it("returns zero totals before the active turn has a diff summary or file-edit work", () => {
    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: TurnId.makeUnsafe("turn-active"),
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-previous"),
            completedAt: "2026-06-13T10:00:00.000Z",
            files: [{ path: "old.ts", additions: 100, deletions: 50 }],
          },
        ],
      }),
    ).toEqual({
      turnId: null,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      hasChanges: false,
    });
  });

  it("treats an empty active turn diff summary as authoritative over tool-log file hints", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [
          {
            turnId: activeTurnId,
            completedAt: "2026-06-13T10:01:00.000Z",
            files: [],
          },
        ],
        workLogEntries: [
          {
            turnId: activeTurnId,
            itemType: "file_change",
            changedFiles: ["src/a.ts"],
          },
        ],
      }),
    ).toEqual({
      turnId: null,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      hasChanges: false,
    });
  });

  it("falls back to in-turn file-edit work before the diff summary lands", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [],
        workLogEntries: [
          // Other turn / non-edit work is ignored.
          { turnId: TurnId.makeUnsafe("turn-previous"), itemType: "file_change" },
          { turnId: activeTurnId, requestKind: "command" },
          {
            turnId: activeTurnId,
            itemType: "file_change",
            changedFiles: ["src/a.ts", "src/b.ts"],
          },
          { turnId: activeTurnId, itemType: "file_change", changedFiles: ["src/a.ts"] },
        ],
      }),
    ).toEqual({
      turnId: null,
      fileCount: 2,
      additions: 0,
      deletions: 0,
      hasChanges: true,
    });
  });

  it("surfaces a stat-less strip when file-edit work has no changed paths yet", () => {
    const activeTurnId = TurnId.makeUnsafe("turn-active");

    expect(
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeTurnId,
        turnDiffSummaries: [],
        workLogEntries: [{ turnId: activeTurnId, itemType: "file_change" }],
      }),
    ).toEqual({
      turnId: null,
      fileCount: null,
      additions: 0,
      deletions: 0,
      hasChanges: true,
    });
  });
});

describe("shouldShowComposerModelBootstrapSkeleton", () => {
  it("shows a skeleton while a provider requires runtime-discovered models", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "cursor",
        selectedModel: "auto",
        persistedModelSelection: null,
        draftModelSelection: null,
        providerModelsLoading: true,
        requiresDiscoveredModels: true,
      }),
    ).toBe(true);
  });

  it("hides the skeleton for a provider requiring discovered models after loading completes", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "cursor",
        selectedModel: "auto",
        persistedModelSelection: null,
        draftModelSelection: null,
        providerModelsLoading: false,
        requiresDiscoveredModels: true,
      }),
    ).toBe(false);
  });

  it("shows a skeleton while provider discovery is still resolving a persisted thread model", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "opencode",
        selectedModel: "openai/gpt-5-codex",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: null,
        providerModelsLoading: true,
      }),
    ).toBe(true);
  });

  it("hides the skeleton once the persisted thread model is already selected", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "opencode",
        selectedModel: "openai/gpt-5.4",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: null,
        providerModelsLoading: true,
      }),
    ).toBe(false);
  });

  it("prefers an explicit draft selection over persisted thread state", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "opencode",
        selectedModel: "opencode/minimax-m2.5-free",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: {
          provider: "opencode",
          model: "opencode/minimax-m2.5-free",
        },
        providerModelsLoading: true,
      }),
    ).toBe(false);
  });

  it("shows a skeleton when the provisional provider does not match the persisted thread provider", () => {
    expect(
      shouldShowComposerModelBootstrapSkeleton({
        selectedProvider: "codex",
        selectedModel: "gpt-5.4",
        persistedModelSelection: {
          provider: "opencode",
          model: "openai/gpt-5.4",
        },
        draftModelSelection: null,
        providerModelsLoading: false,
      }),
    ).toBe(true);
  });
});

describe("resolveCommittedProviderModel", () => {
  it("preserves the exact runtime-discovered slug when the picker selected it", () => {
    expect(
      resolveCommittedProviderModel({
        selectedModel: "grok-code-fast-1-0825" as ModelSlug,
        availableOptions: [
          {
            slug: "grok-code-fast-1-0825" as ModelSlug,
            name: "Grok Code Fast 1 0825",
          },
        ],
        fallback: () => "grok-build-0.1",
      }),
    ).toBe("grok-code-fast-1-0825");
  });

  it("falls back to static alias resolution when the selected slug is not in the options", () => {
    expect(
      resolveCommittedProviderModel({
        selectedModel: "code-fast" as ModelSlug,
        availableOptions: [],
        fallback: () => "grok-build-0.1",
      }),
    ).toBe("grok-build-0.1");
  });
});

describe("shouldConsumePendingCustomBinaryConfirmation", () => {
  it("still processes a pending path for a session that was already checked", () => {
    expect(
      shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: true,
        pendingCustomBinaryPath: "/custom/bin/opencode",
      }),
    ).toBe(true);
  });

  it("skips already checked sessions when there is no pending path to confirm", () => {
    expect(
      shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: true,
        pendingCustomBinaryPath: null,
      }),
    ).toBe(false);
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      fileCommentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
      pastedTexts: [],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      fileCommentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
      pastedTexts: [],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats assistant selections as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 1,
      fileCommentCount: 0,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });

  it("treats file comments as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 0,
      assistantSelectionCount: 0,
      fileCommentCount: 1,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });

  it("treats file attachments as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      fileCount: 1,
      assistantSelectionCount: 0,
      fileCommentCount: 0,
      terminalContexts: [],
      pastedTexts: [],
    });

    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("shouldRenderTerminalWorkspace", () => {
  it("renders the workspace shell before the active project has hydrated", () => {
    expect(
      shouldRenderTerminalWorkspace({
        presentationMode: "workspace",
        terminalOpen: true,
      }),
    ).toBe(true);
  });

  it("renders only for an open workspace terminal", () => {
    expect(
      shouldRenderTerminalWorkspace({
        presentationMode: "workspace",
        terminalOpen: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderTerminalWorkspace({
        presentationMode: "drawer",
        terminalOpen: true,
      }),
    ).toBe(false);
  });
});

describe("resolveProjectScriptTerminalTarget", () => {
  it("reuses the base terminal only when no terminal is open or running", () => {
    const target = resolveProjectScriptTerminalTarget({
      baseTerminalId: "default",
      createTerminalId: () => "new-terminal",
      hasRunningTerminal: false,
      terminalOpen: false,
    });

    expect(target).toEqual({
      shouldCreateNewTerminal: false,
      terminalId: "default",
    });
  });

  it("creates a fresh terminal when a live terminal could keep stale cwd or env", () => {
    expect(
      resolveProjectScriptTerminalTarget({
        baseTerminalId: "default",
        createTerminalId: () => "visible-script-terminal",
        hasRunningTerminal: false,
        terminalOpen: true,
      }),
    ).toEqual({
      shouldCreateNewTerminal: true,
      terminalId: "visible-script-terminal",
    });

    expect(
      resolveProjectScriptTerminalTarget({
        baseTerminalId: "default",
        createTerminalId: () => "running-script-terminal",
        hasRunningTerminal: true,
        terminalOpen: false,
      }),
    ).toEqual({
      shouldCreateNewTerminal: true,
      terminalId: "running-script-terminal",
    });
  });

  it("honors explicit requests for a new terminal", () => {
    const target = resolveProjectScriptTerminalTarget({
      baseTerminalId: "default",
      createTerminalId: () => "forced-script-terminal",
      hasRunningTerminal: false,
      preferNewTerminal: true,
      terminalOpen: false,
    });

    expect(target).toEqual({
      shouldCreateNewTerminal: true,
      terminalId: "forced-script-terminal",
    });
  });
});

describe("shouldRenderProviderHealthBanner", () => {
  it("does not show chat provider health while a terminal thread is active", () => {
    expect(
      shouldRenderProviderHealthBanner({
        threadEntryPoint: "terminal",
        terminalWorkspaceTerminalTabActive: false,
      }),
    ).toBe(false);
  });

  it("does not show chat provider health while the terminal workspace tab is active", () => {
    expect(
      shouldRenderProviderHealthBanner({
        threadEntryPoint: "chat",
        terminalWorkspaceTerminalTabActive: true,
      }),
    ).toBe(false);
  });

  it("shows chat provider health only on the chat surface", () => {
    expect(
      shouldRenderProviderHealthBanner({
        threadEntryPoint: "chat",
        terminalWorkspaceTerminalTabActive: false,
      }),
    ).toBe(true);
  });
});

describe("shouldStartActiveTurnLayoutGrace", () => {
  it("starts the grace window when a live turn just became settled", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: true,
        currentTurnLayoutLive: false,
        latestTurnStartedAt: "2026-04-13T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("does not start the grace window for already-idle threads", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: false,
        currentTurnLayoutLive: false,
        latestTurnStartedAt: "2026-04-13T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not start the grace window while work is still live", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: true,
        currentTurnLayoutLive: true,
        latestTurnStartedAt: "2026-04-13T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not start the grace window when the turn never started", () => {
    expect(
      shouldStartActiveTurnLayoutGrace({
        previousTurnLayoutLive: true,
        currentTurnLayoutLive: false,
        latestTurnStartedAt: null,
      }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const localDispatch: LocalDispatchSnapshot = {
    startedAt: "2026-04-13T00:00:00.000Z",
    preparingWorktree: false,
    latestTurnTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionOrchestrationStatus: "ready",
    sessionUpdatedAt: "2026-04-13T00:00:00.000Z",
  };
  const firstTurnLocalDispatch: LocalDispatchSnapshot = {
    startedAt: "2026-04-13T00:00:00.000Z",
    preparingWorktree: false,
    latestTurnTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionOrchestrationStatus: null,
    sessionUpdatedAt: null,
  };

  it("stays pending until the server-side thread/session snapshot changes", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: null,
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges the local send once the latest turn snapshot changes", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: "2026-04-13T00:00:01.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("keeps the first-turn optimistic timer alive through a null-to-ready session bootstrap", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: firstTurnLocalDispatch,
        phase: "ready",
        latestTurn: null,
        session: {
          provider: "claudeAgent",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("still acknowledges non-ready session transitions without a latest turn snapshot", () => {
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: firstTurnLocalDispatch,
        phase: "disconnected",
        latestTurn: null,
        session: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: "provider failed",
      }),
    ).toBe(true);
  });
});

describe("shouldAutoDeleteTerminalThreadOnLastClose", () => {
  it("deletes untouched terminal-first placeholder threads when the last terminal closes", () => {
    expect(
      shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: true,
        isServerThread: true,
        terminalEntryPoint: "terminal",
        thread: {
          title: "New terminal",
          messages: [],
          latestTurn: null,
          session: null,
          activities: [],
          proposedPlans: [],
        },
      }),
    ).toBe(true);
  });

  it("keeps non-placeholder or already-used threads", () => {
    expect(
      shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: true,
        isServerThread: true,
        terminalEntryPoint: "terminal",
        thread: {
          title: "Manual rename",
          messages: [],
          latestTurn: null,
          session: null,
          activities: [],
          proposedPlans: [],
        },
      }),
    ).toBe(false);

    expect(
      shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: true,
        isServerThread: true,
        terminalEntryPoint: "terminal",
        thread: {
          title: "New terminal",
          messages: [
            {
              id: "msg-1" as never,
              role: "user",
              text: "hello",
              createdAt: "2026-04-06T12:00:00.000Z",
              streaming: false,
            },
          ],
          latestTurn: null,
          session: null,
          activities: [],
          proposedPlans: [],
        },
      }),
    ).toBe(false);
  });
});

describe("resolveRuntimeModeAfterApprovalDecision", () => {
  it("switches approval-required threads to full-access on acceptForSession", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("approval-required", "acceptForSession")).toBe(
      "full-access",
    );
  });

  it("does not change a thread already in full-access", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("full-access", "acceptForSession")).toBeNull();
  });

  it("leaves runtime mode untouched for one-off accept and decline decisions", () => {
    expect(resolveRuntimeModeAfterApprovalDecision("approval-required", "accept")).toBeNull();
    expect(resolveRuntimeModeAfterApprovalDecision("approval-required", "decline")).toBeNull();
  });
});

describe("resolveQueuedSteerGateTransition", () => {
  const armedGate = {
    sawInterruptGap: false,
    gapStartedAt: null,
    armedActiveTurnId: "turn-original",
  };
  const now = 1_000_000;

  it("holds without expiry while the original turn is still running", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: armedGate,
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-original",
      now,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: armedGate,
      expiresInMs: null,
    });
  });

  it("adopts the live turn id when the gate was armed before the projection caught up", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { sawInterruptGap: false, gapStartedAt: null, armedActiveTurnId: null },
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-original",
      now,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: armedGate,
      expiresInMs: null,
    });
  });

  it("clears when the active turn id flips without an observed idle gap", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: armedGate,
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-steered",
      now,
    });
    expect(transition).toEqual({ kind: "clear" });
  });

  it("starts the gap timer when the interrupt lands and the phase leaves running", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: armedGate,
      phase: "ready",
      sessionErrored: false,
      activeTurnId: null,
      now,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      expiresInMs: QUEUED_STEER_GATE_TIMEOUT_MS,
    });
  });

  it("keeps counting down from the original gap start on re-evaluation", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      phase: "ready",
      sessionErrored: false,
      activeTurnId: null,
      now: now + 5_000,
    });
    expect(transition).toEqual({
      kind: "hold",
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      expiresInMs: QUEUED_STEER_GATE_TIMEOUT_MS - 5_000,
    });
  });

  it("clears once the steered turn starts running after the gap", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      phase: "running",
      sessionErrored: false,
      activeTurnId: "turn-steered",
      now: now + 1_000,
    });
    expect(transition).toEqual({ kind: "clear" });
  });

  it("fails open when the steered turn never starts within the timeout", () => {
    const transition = resolveQueuedSteerGateTransition({
      gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
      phase: "ready",
      sessionErrored: false,
      activeTurnId: null,
      now: now + QUEUED_STEER_GATE_TIMEOUT_MS,
    });
    expect(transition).toEqual({ kind: "clear" });
  });

  it("clears on session error or disconnect so the queue cannot stall", () => {
    expect(
      resolveQueuedSteerGateTransition({
        gate: armedGate,
        phase: "ready",
        sessionErrored: true,
        activeTurnId: null,
        now,
      }),
    ).toEqual({ kind: "clear" });
    expect(
      resolveQueuedSteerGateTransition({
        gate: { ...armedGate, sawInterruptGap: true, gapStartedAt: now },
        phase: "disconnected",
        sessionErrored: false,
        activeTurnId: null,
        now,
      }),
    ).toEqual({ kind: "clear" });
  });
});
