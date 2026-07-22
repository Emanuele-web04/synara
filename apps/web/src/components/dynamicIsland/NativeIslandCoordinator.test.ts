import { describe, expect, it, vi } from "vitest";

import {
  HIDDEN_NATIVE_ISLAND_SNAPSHOT,
  NativeIslandActionDispatcher,
  NativeIslandRevisionGate,
  nativeIslandSnapshotKey,
  providerDecisionForNativeAction,
  resolveNativeIslandPublication,
  type NativeIslandBridgeState,
} from "~/components/dynamicIsland/NativeIslandCoordinator";
import type {
  IslandViewModel,
  NativeIslandSessionSnapshot,
  NativeIslandSnapshot,
} from "~/components/dynamicIsland/islandViewModel";

function session(id: string): NativeIslandSessionSnapshot {
  return {
    id,
    title: `Thread ${id}`,
    provider: "Codex",
    elapsed: "1m",
    activity: "Reading file",
    detail: "Read MessagesTimeline.tsx 219 lines",
    status: "working",
    changeSummary: "+2 −1",
  };
}

function activitySnapshot(threadId = "thread-1"): NativeIslandSnapshot {
  return {
    version: 1,
    mode: "activity",
    primaryThreadId: threadId,
    sessions: [session(threadId)],
  };
}

function approvalSnapshot(): NativeIslandSnapshot {
  return {
    version: 1,
    mode: "approval",
    primaryThreadId: "thread-approval",
    sessions: [
      {
        ...session("thread-approval"),
        activity: "Waiting for permission",
        status: "approval",
      },
    ],
    approval: {
      threadId: "thread-approval",
      requestId: "request-1",
      requestKind: "command",
    },
  };
}

function bridgeState(overrides: Partial<NativeIslandBridgeState> = {}): NativeIslandBridgeState {
  return {
    status: "ready",
    nativeActive: false,
    restartCount: 0,
    renderedRevision: null,
    failure: null,
    ...overrides,
  };
}

describe("NativeIslandRevisionGate", () => {
  it("activates only after the exact desired publication revision is rendered", () => {
    const gate = new NativeIslandRevisionGate();
    gate.setDesiredSnapshot("snapshot-a");
    gate.setBridgeState(bridgeState({ nativeActive: true, renderedRevision: 4 }));
    expect(gate.activeSnapshotKey()).toBeNull();

    gate.setPublishedRevision("snapshot-a", 4);
    expect(gate.activeSnapshotKey()).toBe("snapshot-a");

    gate.setDesiredSnapshot("snapshot-b");
    expect(gate.activeSnapshotKey()).toBeNull();
    gate.setPublishedRevision("snapshot-b", 5);
    expect(gate.activeSnapshotKey()).toBeNull();

    gate.setBridgeState(bridgeState({ nativeActive: true, renderedRevision: 5 }));
    expect(gate.activeSnapshotKey()).toBe("snapshot-b");
  });

  it("falls back immediately when the helper crashes or becomes unavailable", () => {
    const gate = new NativeIslandRevisionGate();
    gate.setDesiredSnapshot("snapshot-a");
    gate.setPublishedRevision("snapshot-a", 3);
    gate.setBridgeState(bridgeState({ nativeActive: true, renderedRevision: 3 }));
    expect(gate.activeSnapshotKey()).toBe("snapshot-a");

    gate.setBridgeState(
      bridgeState({
        status: "fallback",
        nativeActive: false,
        renderedRevision: null,
        failure: { code: "helper-crashed", message: "Helper stopped" },
      }),
    );
    expect(gate.activeSnapshotKey()).toBeNull();
  });
});

describe("native island publication policy", () => {
  it("publishes native snapshots while enabled and focused", () => {
    const snapshot = activitySnapshot();
    const viewModel: IslandViewModel = { target: "native", snapshot };

    expect(resolveNativeIslandPublication(viewModel, true, true)).toEqual({
      snapshot,
      snapshotKey: nativeIslandSnapshotKey(snapshot),
    });
  });

  it("publishes the hidden snapshot for React-only modes, settings-off, and blur", () => {
    const nativeViewModel: IslandViewModel = { target: "native", snapshot: activitySnapshot() };
    const reactViewModel: IslandViewModel = {
      target: "react",
      reason: "user-input",
      threadId: "thread-1",
    };

    expect(resolveNativeIslandPublication(reactViewModel, true, true)).toEqual({
      snapshot: HIDDEN_NATIVE_ISLAND_SNAPSHOT,
      snapshotKey: null,
    });
    expect(resolveNativeIslandPublication(nativeViewModel, false, true)).toEqual({
      snapshot: HIDDEN_NATIVE_ISLAND_SNAPSHOT,
      snapshotKey: null,
    });
    expect(resolveNativeIslandPublication(nativeViewModel, true, false)).toEqual({
      snapshot: HIDDEN_NATIVE_ISLAND_SNAPSHOT,
      snapshotKey: null,
    });
  });
});

describe("NativeIslandActionDispatcher", () => {
  it("opens only threads present in the rendered revision and deduplicates action ids", async () => {
    const openThread = vi.fn(async () => undefined);
    const respondToApproval = vi.fn(async () => undefined);
    const dispatcher = new NativeIslandActionDispatcher({ openThread, respondToApproval });
    const context = { revision: 8, snapshot: activitySnapshot() };
    const action = {
      actionId: "open-1",
      revision: 8,
      kind: "open-thread" as const,
      threadId: "thread-1",
    };

    await Promise.all([dispatcher.dispatch(action, context), dispatcher.dispatch(action, context)]);
    expect(openThread).toHaveBeenCalledOnce();
    expect(openThread).toHaveBeenCalledWith("thread-1");
    expect(respondToApproval).not.toHaveBeenCalled();

    await expect(
      dispatcher.dispatch({ ...action, actionId: "stale", revision: 7 }, context),
    ).resolves.toBe(false);
    await expect(
      dispatcher.dispatch({ ...action, actionId: "unknown", threadId: "thread-2" }, context),
    ).resolves.toBe(false);
    expect(openThread).toHaveBeenCalledOnce();
  });

  it("maps each native approval action to the existing provider decision exactly once", async () => {
    const respondToApproval = vi.fn(async () => undefined);
    const dispatcher = new NativeIslandActionDispatcher({
      openThread: vi.fn(async () => undefined),
      respondToApproval,
    });
    const context = { revision: 12, snapshot: approvalSnapshot() };

    for (const [index, kind] of (["deny", "allow-once", "always-allow"] as const).entries()) {
      await dispatcher.dispatch(
        {
          actionId: `approval-${index}`,
          revision: 12,
          kind,
          threadId: "thread-approval",
          requestId: "request-1",
        },
        context,
      );
    }

    expect(respondToApproval).toHaveBeenNthCalledWith(1, {
      threadId: "thread-approval",
      requestId: "request-1",
      decision: "decline",
    });
    expect(respondToApproval).toHaveBeenNthCalledWith(2, {
      threadId: "thread-approval",
      requestId: "request-1",
      decision: "accept",
    });
    expect(respondToApproval).toHaveBeenNthCalledWith(3, {
      threadId: "thread-approval",
      requestId: "request-1",
      decision: "acceptForSession",
    });
    expect(providerDecisionForNativeAction("deny")).toBe("decline");
    expect(providerDecisionForNativeAction("allow-once")).toBe("accept");
    expect(providerDecisionForNativeAction("always-allow")).toBe("acceptForSession");
  });
});
