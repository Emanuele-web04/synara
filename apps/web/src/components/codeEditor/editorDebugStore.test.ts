import { QueryClient } from "@tanstack/react-query";
import type { EditorDebugActionInput } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: { editor: { debugStart: vi.fn(), debugAction: vi.fn(), debugPoll: vi.fn() } },
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("~/lib/workspaceEditorSession", () => ({
  flushWorkspaceEditors: vi.fn().mockResolvedValue(true),
}));
import { EditorDebugStore } from "./editorDebugStore";

afterEach(() => vi.useRealTimers());

async function pausedSession() {
  vi.useFakeTimers();
  let acknowledge!: (value: object) => void;
  const response = new Promise<object>((resolve) => {
    acknowledge = resolve;
  });
  let polls = 0;
  api.editor.debugStart.mockReset().mockResolvedValue({ sessionId: "session" });
  api.editor.debugPoll.mockReset().mockImplementation(async () => ({
    sequence: ++polls,
    terminated: false,
    connections: [{ id: "target", name: "Node", ready: true }],
    events:
      polls === 1
        ? [{ event: "stopped", connectionId: "target", threadId: 1 }]
        : [
            { event: "continued", connectionId: "target", threadId: 1 },
            { event: "stopped", connectionId: "target", threadId: 1 },
          ],
  }));
  api.editor.debugAction.mockReset().mockImplementation(async (input: EditorDebugActionInput) => {
    if (["continue", "next", "stepIn", "stepOut"].includes(input.action)) return response;
    if (input.action === "threads") return { threads: [{ id: 1, name: "Main" }] };
    if (input.action === "stackTrace")
      return { frames: [{ id: 1, name: "frame", relativePath: "index.js", line: 2, column: 1 }] };
    if (input.action === "scopes")
      return { scopes: [{ name: "Local", variablesReference: 1, expensive: false }] };
    return {};
  });
  const client = new QueryClient();
  const store = new EditorDebugStore(client, "/qa");
  await store.start({
    request: "launch",
    program: "index.js",
    args: [],
    port: 9229,
    stopOnEntry: true,
  });
  await vi.waitFor(() => expect(store.getSnapshot().scopes).toHaveLength(1));
  return { store, client, acknowledge };
}

it.each(["continue", "next", "stepIn", "stepOut"] as const)(
  "retains a newer stopped event when %s is acknowledged later",
  async (action) => {
    const { store, client, acknowledge } = await pausedSession();
    try {
      const pending = store.control(action);
      await vi.advanceTimersByTimeAsync(300);
      expect(store.getSnapshot().pauseVersion).toBe(2);
      expect(store.getSnapshot().phase).toBe("paused");
      acknowledge({});
      await pending;
      expect(store.getSnapshot()).toMatchObject({ phase: "paused", busy: false, frameId: 1 });
      expect(store.getSnapshot().frames).toHaveLength(1);
      expect(store.getSnapshot().scopes).toHaveLength(1);
    } finally {
      await store.stop();
      client.clear();
    }
  },
);

it("clears the old pause when the control acknowledgement precedes new events", async () => {
  const { store, client, acknowledge } = await pausedSession();
  try {
    const pending = store.control("next");
    acknowledge({});
    await pending;
    expect(store.getSnapshot()).toMatchObject({
      phase: "running",
      busy: false,
      frames: [],
      scopes: [],
    });
  } finally {
    await store.stop();
    client.clear();
  }
});

it.each(["stop", "terminated"] as const)(
  "does not revive the session after %s while a step response is pending",
  async (ending) => {
    const { store, client, acknowledge } = await pausedSession();
    try {
      const pending = store.control("next");
      if (ending === "stop") await store.stop();
      else {
        api.editor.debugPoll.mockResolvedValue({
          sequence: 2,
          terminated: true,
          connections: [],
          events: [],
        });
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(store.getSnapshot().phase).toBe("ended");
      acknowledge({});
      await pending;
      expect(store.getSnapshot()).toMatchObject({
        phase: "ended",
        busy: false,
        frames: [],
        scopes: [],
      });
    } finally {
      await store.stop();
      client.clear();
    }
  },
);

it("ignores a previous session's pending frame and control after connection loss and restart", async () => {
  const { store, client, acknowledge } = await pausedSession();
  let completeScopes!: (value: object) => void;
  const scopes = new Promise<object>((resolve) => {
    completeScopes = resolve;
  });
  const originalAction = api.editor.debugAction.getMockImplementation()!;
  api.editor.debugAction.mockImplementation((input: EditorDebugActionInput) =>
    input.action === "scopes" && input.frameId === 2 ? scopes : originalAction(input),
  );
  try {
    const control = store.control("next");
    const selection = store.selectFrame(2);
    api.editor.debugPoll.mockRejectedValue(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(3_300);
    expect(store.getSnapshot().phase).toBe("ended");
    api.editor.debugStart.mockResolvedValue({ sessionId: "replacement" });
    api.editor.debugPoll.mockResolvedValue({
      sequence: 1,
      terminated: false,
      connections: [{ id: "new-target", name: "Node", ready: true }],
      events: [],
    });
    await store.start({
      request: "launch",
      program: "index.js",
      args: [],
      port: 9229,
      stopOnEntry: true,
    });
    completeScopes({ scopes: [{ name: "Old frame", variablesReference: 99, expensive: false }] });
    await selection;
    acknowledge({});
    await control;
    expect(store.getSnapshot()).toMatchObject({
      phase: "running",
      sessionId: "replacement",
      frameId: null,
      scopes: [],
      busy: false,
    });
  } finally {
    acknowledge({});
    await store.stop();
    client.clear();
  }
});

it("publishes the stopped target before selecting its frames", async () => {
  vi.useFakeTimers();
  api.editor.debugStart.mockReset().mockResolvedValue({ sessionId: "session" });
  api.editor.debugAction.mockReset().mockResolvedValue({ threads: [] });
  api.editor.debugPoll.mockReset().mockResolvedValue({
    sequence: 1,
    terminated: false,
    connections: [
      { id: "first-target", name: "First", ready: true },
      { id: "stopped-target", name: "Stopped", ready: true },
    ],
    events: [{ event: "stopped", connectionId: "stopped-target", threadId: 2 }],
  });
  const client = new QueryClient();
  const store = new EditorDebugStore(client, "/qa");
  const pausedTargets: (string | null)[] = [];
  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().phase === "paused")
      pausedTargets.push(store.getSnapshot().connectionId);
  });
  try {
    await store.start({
      request: "launch",
      program: "index.js",
      args: [],
      port: 9229,
      stopOnEntry: true,
    });
    expect(pausedTargets.length).toBeGreaterThan(0);
    expect(pausedTargets.every((target) => target === "stopped-target")).toBe(true);
  } finally {
    unsubscribe();
    await store.stop();
    client.clear();
  }
});

it("preserves watch edits while an earlier frame evaluation is pending", async () => {
  const { store, client } = await pausedSession();
  const originalAction = api.editor.debugAction.getMockImplementation()!;
  const pending = new Map<string, (value: object) => void>();
  let holdEvaluations = true;
  try {
    await store.addWatch("removed");
    await store.addWatch("retained");
    api.editor.debugAction.mockImplementation((input: EditorDebugActionInput) => {
      if (input.action !== "evaluate") return originalAction(input);
      if (holdEvaluations)
        return new Promise<object>((resolve) => pending.set(input.expression!, resolve));
      return Promise.resolve({ evaluation: { value: "current", variablesReference: 0 } });
    });
    const refresh = store.selectFrame(1);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    store.removeWatch("removed");
    holdEvaluations = false;
    await store.addWatch("added");
    for (const expression of ["removed", "retained"])
      pending.get(expression)!({ evaluation: { value: "stale", variablesReference: 99 } });
    await refresh;
    expect(store.getSnapshot().watches).toEqual([
      { expression: "retained", value: "current", variablesReference: 0 },
      { expression: "added", value: "current", variablesReference: 0 },
    ]);
  } finally {
    await store.stop();
    client.clear();
  }
});

it.each(["terminated", "removed"] as const)(
  "selects a live target after the paused target is %s without a new stop event",
  async (ending) => {
    const { store, client } = await pausedSession();
    let completeScopes!: (value: object) => void;
    const scopes = new Promise<object>((resolve) => {
      completeScopes = resolve;
    });
    const originalAction = api.editor.debugAction.getMockImplementation()!;
    api.editor.debugAction.mockImplementation((input: EditorDebugActionInput) =>
      input.action === "scopes" && input.frameId === 2 ? scopes : originalAction(input),
    );
    try {
      const selection = store.selectFrame(2);
      api.editor.debugPoll.mockResolvedValue({
        sequence: 2,
        terminated: false,
        connections: [
          ...(ending === "terminated" ? [{ id: "target", name: "Old", ready: false }] : []),
          { id: "replacement", name: "Live", ready: true },
        ],
        events:
          ending === "terminated"
            ? [{ event: "terminated", connectionId: "target", text: "finished" }]
            : [],
      });
      await vi.advanceTimersByTimeAsync(300);
      completeScopes({ scopes: [{ name: "Old frame", variablesReference: 99, expensive: false }] });
      await selection;
      expect(store.getSnapshot()).toMatchObject({
        phase: "running",
        connectionId: "replacement",
        frameId: null,
        frames: [],
        scopes: [],
        threadId: null,
      });
      await store.command({ action: "threads" });
      expect(api.editor.debugAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ connectionId: "replacement" }),
      );
    } finally {
      await store.stop();
      client.clear();
    }
  },
);
