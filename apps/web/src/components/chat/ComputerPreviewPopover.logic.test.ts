import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  changedThreadComputerStates,
  clampComputerPreviewFloat,
  computerPreviewAgentActive,
  computerPreviewBudgetPx,
  computerPreviewCardCaps,
  computerPreviewCardFitWidth,
  computerPreviewFloatWidthPx,
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

describe("computerPreviewStatusLabel", () => {
  it("names live activity, then the last action, then Live, then nothing", () => {
    expect(
      computerPreviewStatusLabel({
        agentActive: true,
        currentActivity: "Reading clipboard",
        lastActionLabel: "Click",
      }),
    ).toBe("Reading clipboard");
    expect(
      computerPreviewStatusLabel({
        agentActive: true,
        currentActivity: null,
        lastActionLabel: "Click",
      }),
    ).toBe("Click");
    expect(
      computerPreviewStatusLabel({
        agentActive: true,
        currentActivity: null,
        lastActionLabel: null,
      }),
    ).toBe("Live");
    expect(
      computerPreviewStatusLabel({
        agentActive: false,
        currentActivity: "Thinking",
        lastActionLabel: "Click",
      }),
    ).toBe("Click");
    expect(
      computerPreviewStatusLabel({
        agentActive: false,
        currentActivity: null,
        lastActionLabel: null,
      }),
    ).toBeNull();
  });

  it("reports the Escape stop ahead of any live activity", () => {
    // Frames may keep arriving after the physical kill, so the chip must not
    // keep claiming activity while input admission is closed.
    expect(
      computerPreviewStatusLabel({
        agentActive: true,
        inputStopped: true,
        currentActivity: "Clicking",
        lastActionLabel: "Click",
      }),
    ).toBe("Stopped via Escape");
    expect(
      computerPreviewStatusLabel({
        agentActive: false,
        inputStopped: true,
        currentActivity: null,
        lastActionLabel: null,
      }),
    ).toBe("Stopped via Escape");
    expect(
      computerPreviewStatusLabel({
        agentActive: true,
        inputStopped: false,
        currentActivity: "Clicking",
        lastActionLabel: null,
      }),
    ).toBe("Clicking");
  });
});

describe("computerPreviewFrameSource", () => {
  it("prefers the native tap while it keeps producing frames", () => {
    expect(computerPreviewFrameSource({ streamWanted: true, tapActive: true })).toBe("tap");
  });

  it("falls back to the window/tab stills stream when no tap frame exists yet", () => {
    // tapActive false with no frame covers a silent tap that never painted
    // and a browser without the desktop bridge channel at all. The stills are
    // window/tab-scoped: the server publishes nothing when no window or tab
    // is the target, so the pane shows its waiting state — never a
    // desktop-wide picture.
    expect(computerPreviewFrameSource({ streamWanted: true, tapActive: false })).toBe("stills");
    expect(
      computerPreviewFrameSource({ streamWanted: true, tapActive: false, tapHasFrame: false }),
    ).toBe("stills");
  });

  it("holds the last window frame instead of swapping in a still", () => {
    // The tap keeps its last window frame on the canvas through the quiet
    // window by design; enabling stills there could swap the canvas to a
    // different target's still while the tap recovers.
    expect(
      computerPreviewFrameSource({ streamWanted: true, tapActive: false, tapHasFrame: true }),
    ).toBe("none");
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

describe("clampComputerPreviewFloat", () => {
  const card = { cardWidthPx: 320, cardHeightPx: 200 };
  const viewport = { viewportWidthPx: 1280, viewportHeightPx: 800 };

  it("keeps an in-bounds position untouched", () => {
    expect(clampComputerPreviewFloat({ x: 400, y: 300, ...card, ...viewport })).toEqual({
      x: 400,
      y: 300,
    });
  });

  it("clamps each edge back to the margin", () => {
    expect(clampComputerPreviewFloat({ x: -50, y: 2, ...card, ...viewport })).toEqual({
      x: 8,
      y: 8,
    });
    expect(clampComputerPreviewFloat({ x: 2000, y: 900, ...card, ...viewport })).toEqual({
      x: 1280 - 320 - 8,
      y: 800 - 200 - 8,
    });
  });

  it("still anchors the origin edge when the card outgrows the viewport", () => {
    expect(
      clampComputerPreviewFloat({
        x: 500,
        y: 500,
        cardWidthPx: 2000,
        cardHeightPx: 2000,
        ...viewport,
      }),
    ).toEqual({ x: 8, y: 8 });
  });
});

describe("computerPreviewFloatWidthPx", () => {
  const compact = { minWidthPx: 240, maxWidthPx: 400 };
  const viewport = { viewportWidthPx: 1600, viewportHeightPx: 1000, frameAspect: 16 / 10 };

  it("expands past the footprint cap on wide viewports", () => {
    expect(computerPreviewFloatWidthPx({ caps: compact, ...viewport })).toBe(600);
  });

  it("shrinks to the viewport minus margins on narrow windows", () => {
    expect(computerPreviewFloatWidthPx({ caps: compact, ...viewport, viewportWidthPx: 300 })).toBe(
      284,
    );
  });

  it("shrinks so a tall frame still fits the viewport height", () => {
    // Portrait content at 8:16: 384 of height budget buys only 192 of width.
    expect(
      computerPreviewFloatWidthPx({
        caps: compact,
        ...viewport,
        viewportHeightPx: 400,
        frameAspect: 0.5,
      }),
    ).toBe(240);
  });
});

describe("computerPreviewCardFitWidth", () => {
  const compact = { minWidthPx: 240, maxWidthPx: 400 };
  const base = {
    caps: compact,
    railBudgetPx: undefined,
    slotWidthPx: 432,
    slotHeightPx: 616,
    frameAspect: 16 / 10,
    viewportWidthPx: 1600,
    viewportHeightPx: 1000,
  };

  it("docked: fills the slot width budget at the footprint cap", () => {
    // 432 - 32 margin = 400 basis; height budget 480 * 1.6 = 768 → cap wins.
    expect(computerPreviewCardFitWidth({ ...base, floating: false })).toBe(400);
  });

  it("docked: narrows for tall content instead of overflowing the slot", () => {
    // Portrait phone aspect: height budget 480 * 0.5 = 240 < width basis.
    expect(computerPreviewCardFitWidth({ ...base, floating: false, frameAspect: 0.5 })).toBe(240);
  });

  it("docked: the rail budget overrides the measured slot", () => {
    expect(computerPreviewCardFitWidth({ ...base, floating: false, railBudgetPx: 300 })).toBe(300);
  });

  it("floating: ignores the slot and caps at the viewport footprint", () => {
    expect(
      computerPreviewCardFitWidth({
        ...base,
        floating: true,
        slotWidthPx: 50,
        slotHeightPx: 50,
      }),
    ).toBe(600);
  });

  // The pop-out control is drawn with expand arrows and detaches the card in
  // place: when the detached width matched the docked one (it did, because both
  // stopped at the same footprint cap), the card re-rendered at the identical
  // rect and clicking expand looked like nothing happened.
  it("floating: is wider than the docked card at every footprint", () => {
    for (const size of ["compact", "large"] as const) {
      const caps = computerPreviewCardCaps(size);
      const railBudgetPx = caps.maxWidthPx;
      const docked = computerPreviewCardFitWidth({ ...base, caps, railBudgetPx, floating: false });
      const floated = computerPreviewCardFitWidth({ ...base, caps, railBudgetPx, floating: true });
      expect(docked).toBe(caps.maxWidthPx);
      expect(floated).toBeGreaterThan(docked);
    }
  });
});
