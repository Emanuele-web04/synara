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
  it("reserves space for a first-frame error without claiming a frame", () => {
    const store = useComputerPreviewStore.getState();
    store.notePreviewLayout(THREAD_A, { hasFrame: false, hasVisibleStatus: false, width: 288 });
    store.notePreviewLayout(THREAD_A, { hasFrame: false, hasVisibleStatus: true, width: 288 });
    const errorLayout = useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A];
    expect(errorLayout).toEqual({ hasFrame: false, hasVisibleStatus: true, width: 288 });
    store.notePreviewLayout(THREAD_A, { hasFrame: false, hasVisibleStatus: true, width: 288 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A]).toBe(errorLayout);
    store.notePreviewLayout(THREAD_A, { hasFrame: true, hasVisibleStatus: false, width: 288 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadId[THREAD_A]).toEqual({
      hasFrame: true,
      hasVisibleStatus: false,
      width: 288,
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

describe("preview floating", () => {
  const floatingOf = (threadId: ThreadId) =>
    useComputerPreviewStore.getState().floatingByThreadId[threadId];

  it("detaches, drags, and re-docks per thread", () => {
    const store = useComputerPreviewStore.getState();
    store.setPreviewFloating(THREAD_A, { x: 100, y: 60 });
    store.setPreviewFloating(THREAD_B, { x: 700, y: 40 });
    expect(floatingOf(THREAD_A)).toEqual({ x: 100, y: 60 });
    store.movePreviewFloating(THREAD_A, { x: 140, y: 92 });
    expect(floatingOf(THREAD_A)).toEqual({ x: 140, y: 92 });
    expect(floatingOf(THREAD_B)).toEqual({ x: 700, y: 40 });
    store.setPreviewFloating(THREAD_A, null);
    expect(floatingOf(THREAD_A)).toBeUndefined();
    expect(floatingOf(THREAD_B)).toEqual({ x: 700, y: 40 });
  });

  it("preserves identity on no-op writes and ignores docked drags", () => {
    const store = useComputerPreviewStore.getState();
    store.movePreviewFloating(THREAD_A, { x: 10, y: 10 });
    expect(floatingOf(THREAD_A)).toBeUndefined();
    store.setPreviewFloating(THREAD_A, { x: 100, y: 60 });
    const first = floatingOf(THREAD_A);
    store.setPreviewFloating(THREAD_A, { x: 100, y: 60 });
    store.movePreviewFloating(THREAD_A, { x: 100, y: 60 });
    expect(floatingOf(THREAD_A)).toBe(first);
    store.setPreviewFloating(THREAD_A, null);
    store.setPreviewFloating(THREAD_A, null);
    expect(floatingOf(THREAD_A)).toBeUndefined();
  });

  it("drops the floating position with the session and on clear", () => {
    const store = useComputerPreviewStore.getState();
    store.setPreviewFloating(THREAD_A, { x: 1, y: 2 });
    store.setPreviewFloating(THREAD_B, { x: 3, y: 4 });
    store.removePreviewSession(THREAD_A);
    expect(floatingOf(THREAD_A)).toBeUndefined();
    expect(floatingOf(THREAD_B)).toEqual({ x: 3, y: 4 });
    store.clear();
    expect(useComputerPreviewStore.getState().floatingByThreadId).toEqual({});
  });
});
