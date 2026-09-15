import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "./computerPreviewStore";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;

function threadState(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return {
    threadId: THREAD_A,
    version: 1,
    computerId: "desktop",
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
    windows: [],
    screenSize: { width: 5120, height: 2520 },
    agentActive: false,
    controlledByOtherThread: false,
    availability: { kind: "available" },
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    lastError: null,
    ...overrides,
  };
}

function session(threadId: ThreadId = THREAD_A) {
  return selectThreadComputerPreviewSession(threadId)(useComputerPreviewStore.getState());
}

beforeEach(() => {
  useComputerPreviewStore.getState().clear();
});

describe("computerPreviewStore surface requests", () => {
  it("arms the owning thread's session on a pane request", () => {
    useComputerPreviewStore.getState().requestPreviewSurface(THREAD_A);
    expect(session()?.phase).toBe("armed");
  });

  it("re-arms a dismissed session when a new lease requests the surface", () => {
    const store = useComputerPreviewStore.getState();
    store.requestPreviewSurface(THREAD_A);
    store.markPreviewLive(THREAD_A);
    store.hidePreviewForTask(THREAD_A);
    expect(session()?.phase).toBe("hidden-for-task");

    useComputerPreviewStore.getState().requestPreviewSurface(THREAD_A);
    expect(session()?.phase).toBe("armed");
  });
});

describe("computerPreviewStore agent-activity edges", () => {
  it("arms on a drive turn's rising edge and ends on the falling edge", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(threadState({ agentActive: true }));
    expect(session()?.phase).toBe("armed");

    store.noteThreadComputerState(threadState({ version: 2, agentActive: false }));
    expect(session()?.phase).toBe("ended");
  });

  it("stays hidden for the rest of the task while the same turn keeps driving", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(threadState({ agentActive: true }));
    store.markPreviewLive(THREAD_A);
    store.hidePreviewForTask(THREAD_A);
    expect(session()?.phase).toBe("hidden-for-task");

    // Same turn still active: no edge, so the dismissal stands.
    store.noteThreadComputerState(threadState({ version: 2, agentActive: true }));
    expect(session()?.phase).toBe("hidden-for-task");
  });

  it("re-arms on the next turn after a dismissed session", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(threadState({ agentActive: true }));
    store.markPreviewLive(THREAD_A);
    store.hidePreviewForTask(THREAD_A);
    store.noteThreadComputerState(threadState({ version: 2, agentActive: false }));
    expect(session()?.phase).toBe("ended");

    store.noteThreadComputerState(threadState({ version: 3, agentActive: true }));
    expect(session()?.phase).toBe("armed");
  });

  it("treats lease ownership as active across the gaps between tool calls", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(
      threadState({ agentActive: false, controlOwnerThreadId: THREAD_A }),
    );
    expect(session()?.phase).toBe("armed");
  });

  it("does not arm a bystander thread that only sees the owner named", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(
      threadState({
        threadId: THREAD_B,
        controlOwnerThreadId: THREAD_A,
        controlledByOtherThread: true,
      }),
    );
    expect(session(THREAD_B)).toBeUndefined();
  });
});

describe("computerPreviewStore session details", () => {
  it("takes an armed session live only once it is viewed", () => {
    const store = useComputerPreviewStore.getState();
    store.requestPreviewSurface(THREAD_A);
    store.markPreviewLive(THREAD_A);
    expect(session()?.phase).toBe("live");

    // A second mark or a mark on a dismissed session changes nothing.
    store.hidePreviewForTask(THREAD_A);
    store.markPreviewLive(THREAD_A);
    expect(session()?.phase).toBe("hidden-for-task");
  });

  it("keeps the newest spoken action label on the session", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadActionLabel(THREAD_A, "Click");
    expect(session()?.lastActionLabel).toBe("Click");
    expect(session()?.phase).toBe("armed");

    store.markPreviewLive(THREAD_A);
    store.noteThreadActionLabel(THREAD_A, "Type text");
    expect(session()?.lastActionLabel).toBe("Type text");
    expect(session()?.phase).toBe("live");
  });

  it("drops a removed session and clears all state", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(threadState({ agentActive: true }));
    store.removePreviewSession(THREAD_A);
    expect(session()).toBeUndefined();

    store.requestPreviewSurface(THREAD_A);
    store.requestPreviewSurface(THREAD_B);
    store.clear();
    expect(useComputerPreviewStore.getState().sessionsByThreadId).toEqual({});
    expect(useComputerPreviewStore.getState().agentActiveByThreadId).toEqual({});
  });
});

describe("notePreviewLayout", () => {
  it("publishes the card footprint and preserves identity when unchanged", () => {
    const store = useComputerPreviewStore.getState();
    store.notePreviewLayout(THREAD_A, { hasFrame: false, width: 448 });
    const first = useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A];
    expect(first).toEqual({ hasFrame: false, width: 448 });
    store.notePreviewLayout(THREAD_A, { hasFrame: false, width: 448 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A]).toBe(first);
    store.notePreviewLayout(THREAD_A, { hasFrame: true, width: 448 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A]).toEqual({
      hasFrame: true,
      width: 448,
    });
  });

  it("drops layout with the session and on clear", () => {
    const store = useComputerPreviewStore.getState();
    store.notePreviewLayout(THREAD_A, { hasFrame: true, width: 300 });
    store.notePreviewLayout(THREAD_B, { hasFrame: true, width: 300 });
    store.removePreviewSession(THREAD_A);
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A]).toBeUndefined();
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_B]).toEqual({
      hasFrame: true,
      width: 300,
    });
    store.clear();
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId).toEqual({});
  });
});
