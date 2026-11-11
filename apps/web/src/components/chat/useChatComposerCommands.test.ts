// Tab on a composer prediction: the branch runs after the menus and before prompt history
// and Enter, re-reads the editor at key time, and otherwise leaves Tab alone.

import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Module-level components in the import graph still need the real React exports.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  ...(await import("../../test/reactHookHarness")).reactHookHarnessMock,
}));

import { reactHookHarness } from "../../test/reactHookHarness";
import type { ComposerPredictionController } from "../../hooks/useComposerPrediction";
import type { ComposerPredictionEntry } from "../../lib/composerPrediction";
import { useChatComposerCommands } from "./useChatComposerCommands";

const SUGGESTION = "Fix the fixture and rerun that test.";
const PREDICTION = { key: "prediction-key", suggestion: SUGGESTION };

function tab(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 9,
    ...overrides,
  } as KeyboardEvent;
}

const ref = <T>(current: T) => ({ current });

function setup(options: { menuOpen?: boolean; editorValue?: string; focused?: boolean } = {}) {
  let entry: ComposerPredictionEntry = { status: "ready", suggestion: SUGGESTION };
  const editorValue = options.editorValue ?? "";
  const editor = {
    isFocused: vi.fn(() => options.focused ?? true),
    readSnapshot: vi.fn(() => ({
      value: editorValue,
      cursor: editorValue.length,
      expandedCursor: editorValue.length,
      selectionCollapsed: true,
      terminalContextIds: [] as string[],
    })),
  };
  const composerPrediction: ComposerPredictionController = {
    readVisible: vi.fn(() => PREDICTION),
    readEntry: vi.fn(() => entry),
    accept: vi.fn(() => {
      entry = { status: "done" };
    }),
  };
  const promptRef = { current: editorValue };
  const setPrompt = vi.fn();
  const setComposerCursor = vi.fn();
  const setComposerTrigger = vi.fn();
  const onSend = vi.fn(async () => true);
  const menuItem = { id: "menu-item", type: "fork-target", target: "local" } as never;
  const handleForkTargetSelection = vi.fn();
  const applyComposerTriggerReplacement = vi.fn(() => 0);

  reactHookHarness.beginRender();
  const commands = useChatComposerCommands({
    threadId: ThreadId.makeUnsafe("thread-1"),
    composerSelectLockRef: ref(false),
    setComposerCommandPicker: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    handleForkTargetSelection,
    handleReviewTargetSelection: vi.fn(),
    resolveActiveComposerTrigger: () => ({
      snapshot: {
        value: editorValue,
        cursor: editorValue.length,
        expandedCursor: editorValue.length,
        selectionCollapsed: true,
      },
      trigger: null,
    }),
    applyComposerTriggerReplacement,
    handleNavigateLocalFolder: vi.fn(),
    localFolderBrowseRootPath: null,
    handleSlashCommandSelection: vi.fn(),
    selectedProvider: "codex",
    scheduleComposerFocus: vi.fn(),
    updateSelectedComposerSkills: vi.fn(),
    updateSelectedComposerMentions: vi.fn(),
    onProviderModelSelect: vi.fn(),
    composerMenuItems: [menuItem],
    composerHighlightedItemId: null,
    activePendingQuestion: null,
    activePendingUserInput: null,
    promptHistoryNavigationRef: ref(null),
    restoreComposerDraftPromptHistorySavedDraft: vi.fn(),
    promptRef,
    setPrompt,
    expectedPromptHistoryPromptRef: ref(null),
    onChangeActivePendingUserInputCustomAnswer: vi.fn(),
    setComposerDraftPromptHistorySavedDraft: vi.fn(),
    applyingPromptHistoryNavigationRef: ref(false),
    promptHistory: ["An older prompt"],
    promptHistoryAppliedPromptRef: ref(null),
    restoredQueuedSourceProposedPlanRef: ref(null),
    setRestoredQueuedSourceProposedPlan: vi.fn(),
    composerCommandPicker: null,
    composerTerminalContexts: [],
    setComposerDraftTerminalContexts: vi.fn(),
    setComposerCursor,
    setComposerTrigger,
    clearComposerSlashDraft: vi.fn(),
    composerMenuOpenRef: ref(options.menuOpen ?? false),
    onSend,
    settings: { followUpBehavior: "queue" } as never,
    hasLiveTurn: false,
    isLocalFolderBrowserOpen: false,
    localDirectoryMenuRef: ref(null),
    composerMenuItemsRef: ref([menuItem]),
    activeComposerMenuItemRef: ref(menuItem),
    activePendingProgress: null,
    isComposerApprovalState: false,
    pendingUserInputs: [],
    composerDraft: undefined as never,
    composerEditorRef: ref(editor) as never,
    composerPrediction,
  } as unknown as Parameters<typeof useChatComposerCommands>[0]);

  return {
    commands,
    composerPrediction,
    promptRef,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    onSend,
    handleForkTargetSelection,
  };
}

describe("useChatComposerCommands Tab on a composer prediction", () => {
  beforeEach(() => {
    reactHookHarness.reset();
    vi.unstubAllGlobals();
  });

  it("inserts the suggestion as an editable draft with the cursor at the end", () => {
    const harness = setup();

    expect(harness.commands.onComposerCommandKey("Tab", tab())).toBe(true);
    expect(harness.composerPrediction.accept).toHaveBeenCalledWith(PREDICTION);
    expect(harness.promptRef.current).toBe(SUGGESTION);
    expect(harness.setPrompt).toHaveBeenCalledWith(SUGGESTION);
    expect(harness.setComposerCursor).toHaveBeenCalledWith(SUGGESTION.length);
    expect(harness.setComposerTrigger).toHaveBeenCalledWith(null);
    expect(harness.onSend).not.toHaveBeenCalled();
  });

  it("leaves an open menu in charge of Tab", () => {
    // Menu selection locks itself for one frame.
    vi.stubGlobal("window", { requestAnimationFrame: vi.fn() });
    const harness = setup({ menuOpen: true });

    expect(harness.commands.onComposerCommandKey("Tab", tab())).toBe(true);
    expect(harness.handleForkTargetSelection).toHaveBeenCalledWith("local");
    expect(harness.composerPrediction.accept).not.toHaveBeenCalled();
    expect(harness.setPrompt).not.toHaveBeenCalledWith(SUGGESTION);
  });

  it.each([
    ["Shift+Tab", tab({ shiftKey: true })],
    ["Alt+Tab", tab({ altKey: true })],
    ["Ctrl+Tab", tab({ ctrlKey: true })],
    ["Meta+Tab", tab({ metaKey: true })],
    ["Tab during IME composition", tab({ isComposing: true })],
    ["Tab with IME keyCode 229", tab({ keyCode: 229 })],
  ])("keeps the default for %s", (_label, event) => {
    const harness = setup();

    expect(harness.commands.onComposerCommandKey("Tab", event)).toBe(false);
    expect(harness.composerPrediction.accept).not.toHaveBeenCalled();
    expect(harness.setPrompt).not.toHaveBeenCalled();
  });

  it("keeps the default when the editor already holds text or lost focus", () => {
    for (const harness of [setup({ editorValue: "draft" }), setup({ focused: false })]) {
      expect(harness.commands.onComposerCommandKey("Tab", tab())).toBe(false);
      expect(harness.setPrompt).not.toHaveBeenCalled();
    }
  });

  it("keeps the default once the prediction was used", () => {
    const harness = setup();
    expect(harness.commands.onComposerCommandKey("Tab", tab())).toBe(true);
    harness.setPrompt.mockClear();

    expect(harness.commands.onComposerCommandKey("Tab", tab())).toBe(false);
    expect(harness.setPrompt).not.toHaveBeenCalled();
  });

  it("does not turn Enter into an accept", () => {
    const harness = setup();

    harness.commands.onComposerCommandKey("Enter", tab());

    expect(harness.composerPrediction.accept).not.toHaveBeenCalled();
    expect(harness.onSend).toHaveBeenCalled();
  });
});
