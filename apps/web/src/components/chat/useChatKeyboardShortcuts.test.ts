// FILE: useChatKeyboardShortcuts.test.ts
// Purpose: Covers composer voice-note toggle dispatch, guards, and chord consumption.
// Layer: Chat composer hook tests

import { ThreadId, type ResolvedKeybindingsConfig } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalFocusState = vi.hoisted(() => ({ focused: false }));

vi.mock("../../lib/terminalFocus", () => ({
  isTerminalFocused: () => terminalFocusState.focused,
}));

const reactHarness = vi.hoisted(() => {
  interface EffectSlot {
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  const slot: EffectSlot = {};
  return {
    reset() {
      slot.cleanup?.();
      delete slot.deps;
      delete slot.cleanup;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const same =
        slot.deps !== undefined &&
        slot.deps.length === deps.length &&
        slot.deps.every((value, index) => Object.is(value, deps[index]));
      if (same) return;
      slot.cleanup?.();
      slot.deps = deps;
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: reactHarness.useEffect,
  };
});

const windowHarness = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown) => void>>(),
}));

import { useChatKeyboardShortcuts } from "./useChatKeyboardShortcuts";

type HookProps = Parameters<typeof useChatKeyboardShortcuts>[0];

const VOICE_BINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "composer.voice.toggle",
    shortcut: {
      key: "m",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
      modKey: false,
    },
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  },
];

function makeProps(overrides: Partial<HookProps> = {}): HookProps {
  return {
    onToggleDevicePanel: undefined,
    onSplitSurface: undefined,
    surfaceMode: "single",
    isFocusedPane: true,
    activeThreadId: ThreadId.makeUnsafe("thread-a"),
    hasLiveTurn: false,
    composerFormRef: { current: null },
    onInterruptFromStopControl: vi.fn(),
    composerSubagentStripItems: [] as unknown as HookProps["composerSubagentStripItems"],
    onBackgroundAllForegroundSubagentStripItems: vi.fn(),
    isVoiceRecording: false,
    isVoiceTranscribing: false,
    onToggleVoiceNote: vi.fn(),
    isComposerApprovalState: false,
    terminalState: {
      terminalOpen: false,
      workspaceLayout: "single",
      activeTerminalId: null,
    } as unknown as HookProps["terminalState"],
    terminalWorkspaceOpen: false,
    terminalWorkspaceTerminalTabActive: false,
    terminalWorkspaceChatTabActive: false,
    keybindings: VOICE_BINDINGS,
    toggleComposerFocus: vi.fn(),
    shouldRenderChatPaneContent: true,
    setThreadFindOpen: vi.fn(),
    setThreadFindFocusNonce: vi.fn(),
    handleModelPickerOpenChange: vi.fn(),
    scheduleComposerFocus: vi.fn(),
    modelOptionsByProvider: {} as unknown as HookProps["modelOptionsByProvider"],
    selectedProvider: "codex" as HookProps["selectedProvider"],
    selectedModel: "model-a",
    onProviderModelSelect: vi.fn(),
    handleTraitsPickerOpenChange: vi.fn(),
    toggleTerminalVisibility: vi.fn(),
    setTerminalOpen: vi.fn(),
    splitTerminalRight: vi.fn(),
    splitTerminalLeft: vi.fn(),
    splitTerminalDown: vi.fn(),
    splitTerminalUp: vi.fn(),
    closeTerminal: vi.fn(),
    createTerminalFromShortcut: vi.fn(),
    openNewFullWidthTerminal: vi.fn(),
    closeActiveWorkspaceView: vi.fn(),
    setTerminalWorkspaceTab: vi.fn(),
    onToggleDiff: vi.fn(),
    commitAndPushTriggerRef: { current: null },
    showGitActions: false,
    isGitRepo: false,
    onToggleBrowser: vi.fn(),
    copyThreadIdToClipboard: vi.fn(),
    activeProject: undefined,
    runProjectScript: vi.fn(),
    activeThread: undefined,
    ...overrides,
  };
}

function voiceToggleEvent() {
  return {
    key: "m",
    code: "KeyM",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    target: null,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function dispatchKeydown(event: unknown) {
  const listeners = windowHarness.listeners.get("keydown") ?? new Set();
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener(event);
}

describe("useChatKeyboardShortcuts composer voice toggle", () => {
  beforeEach(() => {
    reactHarness.reset();
    windowHarness.listeners.clear();
    terminalFocusState.focused = false;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const listeners = windowHarness.listeners.get(type) ?? new Set();
        listeners.add(listener);
        windowHarness.listeners.set(type, listeners);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        windowHarness.listeners.get(type)?.delete(listener);
      },
    });
    vi.stubGlobal("navigator", { platform: "MacIntel" });
  });

  afterEach(() => {
    reactHarness.reset();
    vi.unstubAllGlobals();
  });

  it("toggles once per press and consumes the chord", () => {
    const onToggleVoiceNote = vi.fn();
    useChatKeyboardShortcuts(makeProps({ onToggleVoiceNote }));

    const event = voiceToggleEvent();
    dispatchKeydown(event);

    expect(onToggleVoiceNote).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("still fires while recording so a second press stops it", () => {
    const onToggleVoiceNote = vi.fn();
    useChatKeyboardShortcuts(makeProps({ onToggleVoiceNote, isVoiceRecording: true }));

    const event = voiceToggleEvent();
    dispatchKeydown(event);

    expect(onToggleVoiceNote).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("is a no-op while transcribing but still consumes the chord", () => {
    const onToggleVoiceNote = vi.fn();
    useChatKeyboardShortcuts(makeProps({ onToggleVoiceNote, isVoiceTranscribing: true }));

    const event = voiceToggleEvent();
    dispatchKeydown(event);

    expect(onToggleVoiceNote).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the when-clause context is false", () => {
    terminalFocusState.focused = true;
    const onToggleVoiceNote = vi.fn();
    useChatKeyboardShortcuts(makeProps({ onToggleVoiceNote }));

    const event = voiceToggleEvent();
    dispatchKeydown(event);

    expect(onToggleVoiceNote).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
