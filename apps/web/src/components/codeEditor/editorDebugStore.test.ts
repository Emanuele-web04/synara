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
