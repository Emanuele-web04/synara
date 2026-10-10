import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  sanitizePersistedTerminalStateByThreadId,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState).toMatchObject({
      entryPoint: "chat",
      terminalOpen: false,
      presentationMode: "workspace",
      workspaceLayout: "both",
      workspaceActiveTab: "terminal",
      terminalIds: ["default"],
      terminalLabelsById: { default: "Terminal 1" },
      terminalTitleOverridesById: {},
      terminalCliKindsById: {},
      terminalAttentionStatesById: {},
      runningTerminalIds: [],
      activeTerminalId: "default",
    });
  });

  it("marks chat-first threads without forcing open terminal UI", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.openChatThreadPage(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("chat");
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("opens terminal-first threads in the workspace terminal tab", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("restores the last-used presentation mode when reopened", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalOpen(THREAD_ID, false);
    store.setTerminalOpen(THREAD_ID, true);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
  });

  it("enters workspace mode on the terminal tab by default", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");
    store.setTerminalPresentationMode(THREAD_ID, "drawer");
    store.setTerminalPresentationMode(THREAD_ID, "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("opens a new full-width terminal in terminal-only workspace mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.activeTerminalId).toBe("default");
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("restores chat when selecting the chat workspace tab from terminal-only mode", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID);
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.workspaceLayout).toBe("both");
    expect(terminalState.workspaceActiveTab).toBe("chat");
  });

  it("closes workspace chat into terminal-only mode without closing terminals", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalPresentationMode(THREAD_ID, "workspace");
    store.setTerminalWorkspaceTab(THREAD_ID, "chat");
    store.closeWorkspaceChat(THREAD_ID);

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
    expect(terminalState.terminalIds).toEqual(["default"]);
  });

  it("maps legacy drawer requests to the single workspace panel", () => {
    const store = useTerminalStateStore.getState();
    store.openNewFullWidthTerminal(THREAD_ID);
    store.setTerminalPresentationMode(THREAD_ID, "drawer");
    store.setTerminalPresentationMode(THREAD_ID, "workspace");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.presentationMode).toBe("workspace");
    expect(terminalState.workspaceLayout).toBe("terminal-only");
    expect(terminalState.workspaceActiveTab).toBe("terminal");
  });

  it("reuses the single terminal when opened repeatedly", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID);
    store.openNewFullWidthTerminal(THREAD_ID);
    store.newTerminal(THREAD_ID, "also-unused");
    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalIds).toEqual(["default"]);
    expect(state.activeTerminalId).toBe("default");
  });

  it("retains the session while hidden and reuses it on another open request", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.setTerminalOpen(THREAD_ID, false);
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]?.hasSession).toBe(
      true,
    );
    store.newTerminal(THREAD_ID, "unused");
    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.activeTerminalId).toBe("default");
    expect(state.terminalIds).toEqual(["default"]);
  });

  it("restores only the active legacy session and retains other ids until cleanup succeeds", () => {
    const initial = selectThreadTerminalState({}, THREAD_ID);
    const state = sanitizePersistedTerminalStateByThreadId({
      [THREAD_ID]: {
        ...initial,
        terminalOpen: true,
        terminalIds: ["old-left", "old-right"],
        activeTerminalId: "old-right",
        terminalLabelsById: { "old-left": "Left", "old-right": "Right" },
      },
    });
    expect(state[THREAD_ID]?.terminalIds).toEqual(["old-right"]);
    expect(state[THREAD_ID]?.activeTerminalId).toBe("old-right");
    expect(state[THREAD_ID]?.retiredTerminalIds).toEqual(["old-left"]);
    useTerminalStateStore.setState({ terminalStateByThreadId: state });
    useTerminalStateStore.getState().forgetRetiredTerminal(THREAD_ID, "old-left");
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]?.retiredTerminalIds,
    ).toEqual([]);
  });

  it("stores terminal labels and removes them when a terminal closes", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });

    let terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById).toEqual({
      "terminal-2": "Codex 1",
    });
    expect(terminalState.terminalCliKindsById).toEqual({ "terminal-2": "codex" });

    store.closeTerminal(THREAD_ID, "terminal-2");

    terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById).toEqual({
      [terminalState.activeTerminalId]: "Terminal 1",
    });
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("clears terminal provider identity when metadata cliKind is null", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: "codex",
      label: "Codex CLI",
    });
    store.setTerminalMetadata(THREAD_ID, "terminal-2", {
      cliKind: null,
      label: "bun dev",
    });

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalLabelsById["terminal-2"]).toBe("bun dev");
    expect(terminalState.terminalCliKindsById).toEqual({});
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: true,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: false,
      agentState: null,
    });
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual([]);
  });

  it("strips volatile runtime flags from persisted terminal state", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "terminal-2");
    store.setTerminalTitleOverride(THREAD_ID, "terminal-2", "New keybinds set");
    store.setTerminalActivity(THREAD_ID, "terminal-2", {
      hasRunningSubprocess: false,
      agentState: "attention",
    });

    const sanitized = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );

    expect(sanitized[THREAD_ID]?.terminalTitleOverridesById).toEqual({
      "terminal-2": "New keybinds set",
    });
    expect(sanitized[THREAD_ID]?.terminalAttentionStatesById).toEqual({});
    expect(sanitized[THREAD_ID]?.runningTerminalIds).toEqual([]);
  });

  it("drops retired standalone workspace terminal scopes", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );

    expect(
      sanitizePersistedTerminalStateByThreadId({
        ["workspace:legacy" as ThreadId]: {
          ...terminalState,
          terminalOpen: true,
        },
      }),
    ).toEqual({});
  });

  it("reserves a fresh identity without opening a replacement when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    const state = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(state.terminalOpen).toBe(false);
    expect(state.hasSession).toBe(false);
    expect(state.activeTerminalId).not.toBe("default");
    expect(state.terminalIds).toEqual([state.activeTerminalId]);
  });

  it("uses a new identity after close, including hydration, and ignores the old exit", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.closeTerminal(THREAD_ID, "default");
    const hydrated = sanitizePersistedTerminalStateByThreadId(
      useTerminalStateStore.getState().terminalStateByThreadId,
    );
    useTerminalStateStore.setState({ terminalStateByThreadId: hydrated });
    store.setTerminalOpen(THREAD_ID, true);
    const reopened = useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]!;
    expect(reopened.activeTerminalId).not.toBe("default");
    expect(store.closeExitedTerminal(THREAD_ID, "default")).toBe("ignored");
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]?.terminalOpen).toBe(
      true,
    );
  });

  it("keeps terminal-first threads terminal-first after closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.openTerminalThreadPage(THREAD_ID, { terminalOnly: true });
    store.closeTerminal(THREAD_ID, "default");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeDefined();
    expect(terminalState.entryPoint).toBe("terminal");
    expect(terminalState.terminalOpen).toBe(false);
    expect(terminalState.terminalIds).toEqual([terminalState.activeTerminalId]);
    expect(terminalState.activeTerminalId).not.toBe("default");
  });

  it("closes the only session without replacing it and ignores late exits", () => {
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "session");
    expect(store.closeExitedTerminal(THREAD_ID, "session")).toBe("final");
    expect(store.closeExitedTerminal(THREAD_ID, "session")).toBe("ignored");
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalOpen,
    ).toBe(false);
  });
});

describe("dock terminal sessions", () => {
  it("adopts the existing session once, persists independent pane sessions, and closes only the target", () => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    const scopeId = ThreadId.makeUnsafe("dock-terminal:host");
    const store = useTerminalStateStore.getState();
    store.newTerminal(scopeId, "legacy-session");
    store.ensureDockTerminal(scopeId, "pane-a");
    store.ensureDockTerminal(scopeId, "pane-b");
    const state = () => useTerminalStateStore.getState().terminalStateByThreadId[scopeId]!;
    const first = state().dockTerminalIdsByPaneId!["pane-a"]!;
    const second = state().dockTerminalIdsByPaneId!["pane-b"]!;
    expect(first).toBe("legacy-session");
    expect(second).not.toBe(first);
    store.setTerminalActivity(scopeId, first, { hasRunningSubprocess: true, agentState: null });
    store.setTerminalTitleOverride(scopeId, second, "Server");
    store.ensureDockTerminal(scopeId, "pane-a");
    expect(state().terminalIds).toEqual([first, second]);
    expect(state().runningTerminalIds).toEqual([first]);

    useTerminalStateStore.setState({
      terminalStateByThreadId: sanitizePersistedTerminalStateByThreadId(
        useTerminalStateStore.getState().terminalStateByThreadId,
      ),
    });
    expect(state().dockTerminalIdsByPaneId).toEqual({ "pane-a": first, "pane-b": second });
    expect(state().terminalTitleOverridesById[second]).toBe("Server");
    expect(state().retiredTerminalIds ?? []).toEqual([]);
    store.closeTerminal(scopeId, first);
    expect(state().terminalIds).toEqual([second]);
    expect(state().dockTerminalIdsByPaneId).toEqual({ "pane-b": second });
    expect(state().terminalOpen).toBe(true);
    expect(store.closeExitedTerminal(scopeId, first)).toBe("ignored");
    expect(store.closeExitedTerminal(scopeId, second)).toBe("final");
    expect(state().terminalOpen).toBe(false);
  });
});
