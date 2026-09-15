import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  changedThreadComputerStates,
  computerPreviewAgentActive,
  computerPreviewBudgetPx,
  computerPreviewCardCaps,
  computerPreviewCardOpen,
  computerPreviewFrameSource,
  computerPreviewPhaseOnAgentEdge,
  computerPreviewPhaseOnHide,
  computerPreviewPhaseOnSurfaceRequest,
  computerPreviewPhaseOnViewed,
  computerPreviewStatusLabel,
} from "./ComputerPreviewPopover.logic";

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

describe("computerPreviewAgentActive", () => {
  it("is active for the thread that owns the lease", () => {
    expect(computerPreviewAgentActive(threadState({ controlOwnerThreadId: THREAD_A }))).toBe(true);
  });

  it("is active while a drive call is in flight before the lease shows", () => {
    expect(computerPreviewAgentActive(threadState({ agentActive: true }))).toBe(true);
  });

  it("is not active for a bystander thread that only sees the owner named", () => {
    // Every thread's snapshot names the lease holder; a thread that is not the
    // holder must not arm its own preview.
    expect(
      computerPreviewAgentActive(
        threadState({
          threadId: THREAD_B,
          controlOwnerThreadId: THREAD_A,
          controlledByOtherThread: true,
        }),
      ),
    ).toBe(false);
  });

  it("is not active for a refused call on another thread's lease", () => {
    expect(
      computerPreviewAgentActive(threadState({ agentActive: true, controlledByOtherThread: true })),
    ).toBe(false);
  });

  it("is not active for an idle thread", () => {
    expect(computerPreviewAgentActive(threadState())).toBe(false);
  });
});

describe("computerPreviewPhaseOnSurfaceRequest", () => {
  it("arms a missing, ended, or dismissed session", () => {
    expect(computerPreviewPhaseOnSurfaceRequest(undefined)).toBe("armed");
    expect(computerPreviewPhaseOnSurfaceRequest("ended")).toBe("armed");
    expect(computerPreviewPhaseOnSurfaceRequest("hidden-for-task")).toBe("armed");
  });

  it("leaves an already surfaced session alone", () => {
    expect(computerPreviewPhaseOnSurfaceRequest("armed")).toBe("armed");
    expect(computerPreviewPhaseOnSurfaceRequest("live")).toBe("live");
  });
});

describe("computerPreviewPhaseOnAgentEdge", () => {
  it("re-arms on a rising edge, including a dismissed preview from last turn", () => {
    expect(computerPreviewPhaseOnAgentEdge(undefined, "rose")).toBe("armed");
    expect(computerPreviewPhaseOnAgentEdge("ended", "rose")).toBe("armed");
    expect(computerPreviewPhaseOnAgentEdge("hidden-for-task", "rose")).toBe("armed");
    expect(computerPreviewPhaseOnAgentEdge("armed", "rose")).toBe("armed");
  });

  it("keeps a live session live on a rising edge instead of reopening it", () => {
    expect(computerPreviewPhaseOnAgentEdge("live", "rose")).toBe("live");
  });

  it("ends every phase on a falling edge and creates none", () => {
    expect(computerPreviewPhaseOnAgentEdge("armed", "fell")).toBe("ended");
    expect(computerPreviewPhaseOnAgentEdge("live", "fell")).toBe("ended");
    expect(computerPreviewPhaseOnAgentEdge("hidden-for-task", "fell")).toBe("ended");
    expect(computerPreviewPhaseOnAgentEdge("ended", "fell")).toBe("ended");
    expect(computerPreviewPhaseOnAgentEdge(undefined, "fell")).toBeUndefined();
  });
});

describe("computerPreviewPhaseOnViewed", () => {
  it("takes an armed session live and leaves the rest alone", () => {
    expect(computerPreviewPhaseOnViewed("armed")).toBe("live");
    expect(computerPreviewPhaseOnViewed("live")).toBe("live");
    expect(computerPreviewPhaseOnViewed("hidden-for-task")).toBe("hidden-for-task");
    expect(computerPreviewPhaseOnViewed("ended")).toBe("ended");
    expect(computerPreviewPhaseOnViewed(undefined)).toBeUndefined();
  });
});

describe("computerPreviewPhaseOnHide", () => {
  it("hides the visible phases and ignores the rest", () => {
    expect(computerPreviewPhaseOnHide("armed")).toBe("hidden-for-task");
    expect(computerPreviewPhaseOnHide("live")).toBe("hidden-for-task");
    expect(computerPreviewPhaseOnHide("hidden-for-task")).toBe("hidden-for-task");
    expect(computerPreviewPhaseOnHide("ended")).toBe("ended");
    expect(computerPreviewPhaseOnHide(undefined)).toBeUndefined();
  });
});

describe("computerPreviewCardOpen", () => {
  it("is open only while live", () => {
    expect(computerPreviewCardOpen("live")).toBe(true);
    expect(computerPreviewCardOpen("armed")).toBe(false);
    expect(computerPreviewCardOpen("hidden-for-task")).toBe(false);
    expect(computerPreviewCardOpen("ended")).toBe(false);
    expect(computerPreviewCardOpen(undefined)).toBe(false);
  });
});

describe("computerPreviewStatusLabel", () => {
  it("names the current action, then Live, then the last action, then nothing", () => {
    expect(computerPreviewStatusLabel({ agentActive: true, lastActionLabel: "Click" })).toBe(
      "Click",
    );
    expect(computerPreviewStatusLabel({ agentActive: true, lastActionLabel: null })).toBe("Live");
    expect(computerPreviewStatusLabel({ agentActive: false, lastActionLabel: "Click" })).toBe(
      "Click",
    );
    expect(computerPreviewStatusLabel({ agentActive: false, lastActionLabel: null })).toBeNull();
  });
});

describe("computerPreviewFrameSource", () => {
  it("prefers the native tap while it keeps producing frames", () => {
    expect(computerPreviewFrameSource({ streamWanted: true, tapActive: true })).toBe("tap");
  });

  it("falls back to the stills stream when the tap is quiet or absent", () => {
    // tapActive false covers both a silent tap and a browser without the
    // desktop bridge channel at all.
    expect(computerPreviewFrameSource({ streamWanted: true, tapActive: false })).toBe("stills");
  });

  it("keeps both sources off when the preview does not want frames", () => {
    // A live tap for a hidden or ended session must not keep the canvas (or
    // the stills subscription) alive.
    expect(computerPreviewFrameSource({ streamWanted: false, tapActive: true })).toBe("none");
    expect(computerPreviewFrameSource({ streamWanted: false, tapActive: false })).toBe("none");
  });
});

describe("changedThreadComputerStates", () => {
  it("returns only the entries whose snapshot object changed", () => {
    const kept = threadState();
    const updated = threadState({ version: 2 });
    const added = threadState({ threadId: THREAD_B });
    const next = {
      "thread-a": updated,
      "thread-b": added,
      "thread-c": undefined,
    } as Record<string, ThreadComputerState | undefined>;
    const previous = {
      "thread-a": kept,
      "thread-b": kept,
      "thread-c": kept,
    } as Record<string, ThreadComputerState | undefined>;

    expect(changedThreadComputerStates(next, previous)).toEqual([updated, added]);
    expect(changedThreadComputerStates(next, next)).toEqual([]);
  });
});

describe("computerPreviewCardCaps", () => {
  it("keeps the default compact footprint glanceable but readable", () => {
    expect(computerPreviewCardCaps("compact")).toEqual({ minWidthPx: 240, maxWidthPx: 400 });
  });

  it("restores the wide card for the large footprint", () => {
    expect(computerPreviewCardCaps("large")).toEqual({ minWidthPx: 240, maxWidthPx: 560 });
  });
});

describe("computerPreviewBudgetPx", () => {
  const compact = { minWidthPx: 240, maxWidthPx: 400 };

  it("caps at the footprint max on wide layouts", () => {
    expect(
      computerPreviewBudgetPx({ mainContentWidthPx: 1600, environmentInsetPx: 0, caps: compact }),
    ).toBe(400);
  });

  it("shrinks with the content width on narrow windows and zoom-ins", () => {
    expect(
      computerPreviewBudgetPx({ mainContentWidthPx: 900, environmentInsetPx: 0, caps: compact }),
    ).toBe(900 - 520 - 24);
  });

  it("subtracts the environment sidebar inset before budgeting", () => {
    const large = { minWidthPx: 240, maxWidthPx: 560 };
    const without = computerPreviewBudgetPx({
      mainContentWidthPx: 1100,
      environmentInsetPx: 0,
      caps: large,
    });
    const withEnv = computerPreviewBudgetPx({
      mainContentWidthPx: 1100,
      environmentInsetPx: 200,
      caps: large,
    });
    expect(without).toBe(556);
    expect(withEnv).toBe(without - 200);
  });

  it("floors instead of collapsing on tiny layouts", () => {
    expect(
      computerPreviewBudgetPx({ mainContentWidthPx: 500, environmentInsetPx: 0, caps: compact }),
    ).toBe(200);
  });
});
