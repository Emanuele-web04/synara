// Regression coverage for the chat/terminal shortcut chord ownership (#1984):
// mod+w in a regular chat tab closes the active thread tab (not the window), mod+w
// with a dock-terminal pane focused closes that pane, and ctrl+1/ctrl+2 keep
// switching the full-width workspace between Terminal and Chat.

import { describe, expect, it, vi } from "vitest";
import type { ResolvedKeybindingsConfig } from "@synara/contracts";

// --- Minimal React hook harness (mirrors useChatTerminalController.test.ts) ---
function depsEqual(left: readonly unknown[] | undefined, right: readonly unknown[]) {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const index = cursor;
    cursor += 1;
    slots[index] ??= {};
    return slots[index]!;
  };
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = callback;
      }
      return slot.value as T;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react")>();
  return {
    ...mod,
    useCallback: reactHarness.useCallback,
    useEffect: reactHarness.useEffect,
    useState: reactHarness.useState,
  };
});

// --- Minimal DOM stubs for the node test environment ---
class FakeElement {
  isConnected = true;
  constructor(
    private readonly classNames: readonly string[] = [],
    private readonly closestMap: Readonly<
      Record<string, { getAttribute(name: string): string | null } | null>
    > = {},
  ) {}
  classList = { contains: (name: string) => this.classNames.includes(name) };
  closest(selector: string) {
    return this.closestMap[selector] ?? null;
  }
  contains() {
    return false;
  }
}
class FakeKeyboardEvent extends Event {
  key = "";
  code = "";
  metaKey = false;
  ctrlKey = false;
  shiftKey = false;
  altKey = false;
  repeat = false;
  isComposing = false;
  constructor(init: Partial<FakeKeyboardEvent>) {
    super("keydown", { bubbles: true, cancelable: true });
    Object.assign(this, init);
  }
}
const fakeWindow = new EventTarget();
const fakeDocument = { activeElement: null as unknown };
vi.stubGlobal("window", fakeWindow);
vi.stubGlobal("document", fakeDocument);
vi.stubGlobal("Element", FakeElement);
vi.stubGlobal("Node", FakeElement);
vi.stubGlobal("HTMLElement", FakeElement);
vi.stubGlobal("HTMLInputElement", class extends FakeElement {});
vi.stubGlobal("HTMLTextAreaElement", class extends FakeElement {});
vi.stubGlobal("navigator", { platform: "MacIntel" });
vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

// Quiet heavy deps the hook imports but this suite does not exercise.
vi.mock("~/lib/starredModels", () => ({ readStarredModelSlugs: () => [] }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/projectScripts", () => ({ projectScriptIdFromCommand: () => null }));
vi.mock("../ChatView.logic", () => ({ resolveCycledModelSlug: () => null }));
vi.mock("./ComposerSubagentStrip.logic", () => ({
  collectForegroundRunningSubagentStripItems: () => [],
}));
vi.mock("./threadFind.logic", () => ({
  eventTargetsInAppBrowser: () => false,
  shouldCaptureChatFindShortcut: () => false,
}));
vi.mock("./ComposerModelPicker.logic", () => ({ MODEL_PICKER_POPUP_ATTRIBUTE: "data-x" }));
vi.mock("./useChatProjectScripts", () => ({}));
vi.mock("./useChatProviderModels", () => ({}));
vi.mock("./useChatTerminalController", () => ({}));
vi.mock("./useChatWorkLog", () => ({}));
vi.mock("./useComposerVoiceController", () => ({}));
vi.mock("../../lib/utils", () => ({
  isMacNavigatorPlatform: () => true,
  isMacPlatform: () => true,
  isWindowsPlatform: () => false,
}));

const { useChatKeyboardShortcuts } = await import("./useChatKeyboardShortcuts");
const { DEFAULT_SHORTCUT_FALLBACKS } = await import("../../keybindings");
const { useTerminalStateStore, selectThreadTerminalState } =
  await import("../../terminalStateStore");
const { useRightDockStore } = await import("../../rightDockStore");

type When =
  | { type: "identifier"; name: string }
  | { type: "not"; node: When }
  | { type: "and"; left: When; right: When };
const id = (name: string): When => ({ type: "identifier", name });
const not = (node: When): When => ({ type: "not", node });
const and = (left: When, right: When): When => ({ type: "and", left, right });
const shortcut = (key: string, mod = true, ctrl = false) => ({
  key,
  metaKey: false,
  ctrlKey: ctrl,
  shiftKey: false,
  altKey: false,
  modKey: mod,
});

// Mirror of the shipped defaults for the chords under test (server-side
// DEFAULT_KEYBINDINGS), in declaration order — last match wins at resolve time.
const KEYBINDINGS: ResolvedKeybindingsConfig = [
  { command: "terminal.close", shortcut: shortcut("w"), whenAst: id("terminalFocus") },
  {
    command: "terminal.workspace.closeActive",
    shortcut: shortcut("w"),
    whenAst: id("terminalWorkspaceOpen"),
  },
  {
    command: "threadTab.close",
    shortcut: shortcut("w"),
    whenAst: and(not(id("terminalFocus")), not(id("terminalWorkspaceOpen"))) as never,
  },
  {
    command: "terminal.workspace.terminal",
    shortcut: shortcut("1", false, true),
    whenAst: id("terminalWorkspaceOpen"),
  },
  {
    command: "terminal.workspace.chat",
    shortcut: shortcut("2", false, true),
    whenAst: id("terminalWorkspaceOpen"),
  },
  ...DEFAULT_SHORTCUT_FALLBACKS,
];

function keydown(key: string, opts: { ctrl?: boolean; meta?: boolean } = {}) {
  const event = new FakeKeyboardEvent({
    key,
    code: `Digit${key}`,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
  });
  fakeWindow.dispatchEvent(event);
  return event;
}

interface HarnessOptions {
  terminalOpen?: boolean;
  workspaceLayout?: "both" | "terminal-only";
  workspaceActiveTab?: "terminal" | "chat";
}

function mountHarness(options: HarnessOptions = {}) {
  const threadId = "thread-1" as never;
  const terminalOpen = options.terminalOpen ?? false;
  const workspaceLayout = options.workspaceLayout ?? "both";
  const workspaceActiveTab = options.workspaceActiveTab ?? "terminal";
  const terminalWorkspaceOpen = terminalOpen;
  const calls = {
    closeTerminal: vi.fn(),
    closeActiveWorkspaceView: vi.fn(),
    setTerminalWorkspaceTab: vi.fn(),
    onCloseActiveThreadTab: vi.fn(() => true),
    onCloseDockTerminalPane: vi.fn(),
  };
  const render = () => {
    reactHarness.beginRender();
    useChatKeyboardShortcuts({
      onToggleDevicePanel: undefined,
      onSplitSurface: undefined,
      surfaceMode: "single",
      isFocusedPane: true,
      activeThreadId: threadId,
      hasLiveTurn: false,
      composerFormRef: { current: null },
      onInterruptFromStopControl: vi.fn(),
      composerSubagentStripItems: [],
      onBackgroundAllForegroundSubagentStripItems: vi.fn(async () => {}),
      isVoiceRecording: false,
      isVoiceTranscribing: false,
      onVoiceRecordingEnter: vi.fn(),
      isComposerApprovalState: false,
      terminalState: {
        terminalOpen,
        workspaceLayout,
        workspaceActiveTab,
        activeTerminalId: "term-1",
      } as never,
      terminalWorkspaceOpen,
      terminalWorkspaceTerminalTabActive:
        terminalWorkspaceOpen &&
        (workspaceLayout === "terminal-only" || workspaceActiveTab === "terminal"),
      terminalWorkspaceChatTabActive:
        terminalWorkspaceOpen && workspaceLayout === "both" && workspaceActiveTab === "chat",
      keybindings: KEYBINDINGS,
      toggleComposerFocus: vi.fn(),
      shouldRenderChatPaneContent: true,
      setThreadFindOpen: vi.fn(),
      setThreadFindFocusNonce: vi.fn(),
      handleModelPickerOpenChange: vi.fn(),
      scheduleComposerFocus: vi.fn(),
      modelOptionsByProvider: {} as never,
      modelOptionsByProviderInstance: {} as never,
      selectedProvider: "codex" as never,
      selectedProviderInstanceId: "" as never,
      selectedModel: "x",
      onProviderModelSelect: vi.fn(async () => {}),
      handleTraitsPickerOpenChange: vi.fn(),
      cycleEffort: vi.fn(() => false),
      toggleTerminalVisibility: vi.fn(),
      setTerminalOpen: vi.fn(),
      closeTerminal: calls.closeTerminal,
      createTerminalFromShortcut: vi.fn(),
      openNewFullWidthTerminal: vi.fn(),
      closeActiveWorkspaceView: calls.closeActiveWorkspaceView,
      setTerminalWorkspaceTab: calls.setTerminalWorkspaceTab,
      onCloseActiveThreadTab: calls.onCloseActiveThreadTab,
      onCloseDockTerminalPane: calls.onCloseDockTerminalPane,
      onToggleDiff: vi.fn(),
      commitAndPushTriggerRef: { current: null },
      showGitActions: false,
      isGitRepo: false,
      onToggleBrowser: vi.fn(),
      copyThreadIdToClipboard: vi.fn(),
      activeProject: undefined,
      runProjectScript: vi.fn(),
      activeThread: undefined,
    });
  };
  render();
  return { calls, render, threadId };
}

describe("mod+w chord ownership", () => {
  it("closes the active thread tab on a regular chat surface", () => {
    const { calls } = mountHarness();
    const event = keydown("w", { meta: true });
    expect(calls.onCloseActiveThreadTab).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(calls.closeTerminal).not.toHaveBeenCalled();
  });

  it("leaves the chord alone when no thread tab can close", () => {
    const { calls } = mountHarness();
    calls.onCloseActiveThreadTab.mockReturnValue(false);
    const event = keydown("w", { meta: true });
    expect(calls.onCloseActiveThreadTab).toHaveBeenCalledTimes(1);
    // Untouched, so the desktop window-close role still sees it — same as before the fix.
    expect(event.defaultPrevented).toBe(false);
    expect(calls.closeTerminal).not.toHaveBeenCalled();
  });

  it("ignores a dock marker whose pane is not a terminal", () => {
    const paneMarker = {
      getAttribute: (name: string) => (name === "data-dock-pane-id" ? "pane-files" : null),
    };
    fakeDocument.activeElement = new FakeElement(["xterm-helper-textarea"], {
      "[data-dock-pane-id]": paneMarker,
    });
    const { calls, threadId } = mountHarness();
    useRightDockStore.setState({
      dockStateByThreadId: {
        [threadId as string]: {
          open: true,
          activePaneId: "pane-files",
          panes: [
            {
              id: "pane-files",
              kind: "file",
              threadId: null,
              diffTurnId: null,
              diffFilePath: null,
              filePath: "README.md",
              pullRequestProjectId: null,
              pullRequestRepository: null,
              pullRequestNumber: null,
              pullRequestInitialTab: null,
            },
          ],
        },
      },
    });
    const event = keydown("w", { meta: true });
    expect(calls.onCloseDockTerminalPane).not.toHaveBeenCalled();
    expect(calls.onCloseActiveThreadTab).not.toHaveBeenCalled();
    expect(calls.closeTerminal).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    fakeDocument.activeElement = null;
  });

  it("closes the focused dock-terminal pane instead of bailing on the drawer state", () => {
    const paneMarker = {
      getAttribute: (name: string) => (name === "data-dock-pane-id" ? "pane-1" : null),
    };
    fakeDocument.activeElement = new FakeElement(["xterm-helper-textarea"], {
      "[data-dock-pane-id]": paneMarker,
    });
    const { calls, threadId } = mountHarness({ terminalOpen: false });
    useRightDockStore.setState({
      dockStateByThreadId: {
        [threadId as string]: {
          open: true,
          activePaneId: "pane-1",
          panes: [
            {
              id: "pane-1",
              kind: "terminal",
              threadId: null,
              diffTurnId: null,
              diffFilePath: null,
              filePath: null,
              pullRequestProjectId: null,
              pullRequestRepository: null,
              pullRequestNumber: null,
              pullRequestInitialTab: null,
            },
          ],
        },
      },
    });
    keydown("w", { meta: true });
    expect(calls.onCloseDockTerminalPane).toHaveBeenCalledWith("pane-1");
    expect(calls.onCloseActiveThreadTab).not.toHaveBeenCalled();
    expect(calls.closeTerminal).not.toHaveBeenCalled();
    fakeDocument.activeElement = null;
  });

  it("still closes the active workspace view while the workspace is open", () => {
    // The full-width workspace terminal reports focus but is not inside a dock pane.
    fakeDocument.activeElement = new FakeElement(["xterm-helper-textarea"]);
    const { calls } = mountHarness({ terminalOpen: true, workspaceLayout: "terminal-only" });
    keydown("w", { meta: true });
    expect(calls.closeActiveWorkspaceView).toHaveBeenCalledTimes(1);
    expect(calls.onCloseActiveThreadTab).not.toHaveBeenCalled();
    fakeDocument.activeElement = null;
  });
});

describe("workspace tab switching (issue #1984)", () => {
  it("Ctrl+2 then Ctrl+1 round-trips through the real terminalStateStore", () => {
    const threadId = "thread-real" as never;
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    useTerminalStateStore.getState().openNewFullWidthTerminal(threadId);

    const readState = () =>
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, threadId);

    const render = () => {
      const terminalState = readState();
      const terminalWorkspaceOpen =
        terminalState.presentationMode === "workspace" && terminalState.terminalOpen;
      reactHarness.beginRender();
      useChatKeyboardShortcuts({
        onToggleDevicePanel: undefined,
        onSplitSurface: undefined,
        surfaceMode: "single",
        isFocusedPane: true,
        activeThreadId: threadId,
        hasLiveTurn: false,
        composerFormRef: { current: null },
        onInterruptFromStopControl: vi.fn(),
        composerSubagentStripItems: [],
        onBackgroundAllForegroundSubagentStripItems: vi.fn(async () => {}),
        isVoiceRecording: false,
        isVoiceTranscribing: false,
        onVoiceRecordingEnter: vi.fn(),
        isComposerApprovalState: false,
        terminalState: terminalState as never,
        terminalWorkspaceOpen,
        terminalWorkspaceTerminalTabActive:
          terminalWorkspaceOpen &&
          (terminalState.workspaceLayout === "terminal-only" ||
            terminalState.workspaceActiveTab === "terminal"),
        terminalWorkspaceChatTabActive:
          terminalWorkspaceOpen &&
          terminalState.workspaceLayout === "both" &&
          terminalState.workspaceActiveTab === "chat",
        keybindings: KEYBINDINGS,
        toggleComposerFocus: vi.fn(),
        shouldRenderChatPaneContent: true,
        setThreadFindOpen: vi.fn(),
        setThreadFindFocusNonce: vi.fn(),
        handleModelPickerOpenChange: vi.fn(),
        scheduleComposerFocus: vi.fn(),
        modelOptionsByProvider: {} as never,
        modelOptionsByProviderInstance: {} as never,

        selectedProvider: "codex" as never,
        selectedProviderInstanceId: "" as never,
        selectedModel: "x",
        onProviderModelSelect: vi.fn(async () => {}),
        handleTraitsPickerOpenChange: vi.fn(),
        cycleEffort: vi.fn(() => false),
        toggleTerminalVisibility: vi.fn(),
        setTerminalOpen: vi.fn(),
        closeTerminal: vi.fn(),
        createTerminalFromShortcut: vi.fn(),
        openNewFullWidthTerminal: vi.fn(),
        closeActiveWorkspaceView: vi.fn(),
        setTerminalWorkspaceTab: (tab: "terminal" | "chat") => {
          useTerminalStateStore.getState().setTerminalWorkspaceTab(threadId, tab);
        },
        onCloseActiveThreadTab: vi.fn(() => true),
        onCloseDockTerminalPane: vi.fn(),
        onToggleDiff: vi.fn(),
        commitAndPushTriggerRef: { current: null },
        showGitActions: false,
        isGitRepo: false,
        onToggleBrowser: vi.fn(),
        copyThreadIdToClipboard: vi.fn(),
        activeProject: undefined,
        runProjectScript: vi.fn(),
        activeThread: undefined,
      });
    };
    render();

    expect(readState().workspaceLayout).toBe("terminal-only");
    expect(readState().workspaceActiveTab).toBe("terminal");

    keydown("2", { ctrl: true });
    expect(readState().workspaceActiveTab).toBe("chat");
    expect(readState().workspaceLayout).toBe("both");

    render(); // the React re-render driven by the store update

    keydown("1", { ctrl: true });
    expect(readState().workspaceActiveTab).toBe("terminal");
  });
});
