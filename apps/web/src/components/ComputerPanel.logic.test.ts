import {
  type ComputerFrameHeader,
  type ComputerHealth,
  type ThreadComputerState,
  type ThreadId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  computerActionLabel,
  computerActionStatusLabel,
  computerCanvasLabel,
  computerStatusNeedsSetup,
  createComputerFrameGateState,
  resolveComputerAvailabilityView,
  shouldSubscribeToComputerStream,
  stepComputerFrameGate,
} from "./ComputerPanel.logic";

const COMPUTER_ID = "desktop";

function header(sequence: number, computerId = COMPUTER_ID): ComputerFrameHeader {
  return {
    computerId,
    sequence,
    timestampMs: 1,
    keyframe: true,
    codecConfig: false,
  };
}

function state(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return {
    threadId: "thread-1" as ThreadId,
    version: 1,
    computerId: COMPUTER_ID,
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
    health: connectedHealth(),
    lastError: null,
    ...overrides,
  };
}

function connectedHealth(): ComputerHealth {
  return { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true };
}

describe("computer frame gate", () => {
  it("accepts the first frame and rejects frames for another computer", () => {
    const initial = createComputerFrameGateState();
    const wrong = stepComputerFrameGate(initial, header(1, "other"), COMPUTER_ID);
    expect(wrong.action).toBe("ignore");
    expect(wrong.state).toEqual(initial);

    const first = stepComputerFrameGate(initial, header(7), COMPUTER_ID);
    expect(first.action).toBe("decode");
    expect(first.requestResync).toBe(false);
    expect(first.state.lastSequence).toBe(7);
  });

  it("drops duplicates and stale sequence numbers", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const duplicate = stepComputerFrameGate(current.state, header(10), COMPUTER_ID);
    const stale = stepComputerFrameGate(current.state, header(9), COMPUTER_ID);

    expect(duplicate.action).toBe("drop-stale");
    expect(stale.action).toBe("drop-stale");
    expect(duplicate.requestResync).toBe(false);
    expect(stale.requestResync).toBe(false);
  });

  it("accepts standalone frames after a gap and asks the source to resync", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const next = stepComputerFrameGate(current.state, header(13), COMPUTER_ID);

    expect(next.action).toBe("decode");
    expect(next.requestResync).toBe(true);
    expect(next.state.lastSequence).toBe(13);
  });

  it("handles uint32 sequence wraparound", () => {
    const current = stepComputerFrameGate(
      createComputerFrameGateState(),
      header(0xffff_fffe),
      COMPUTER_ID,
    );
    const wrapped = stepComputerFrameGate(current.state, header(1), COMPUTER_ID);

    expect(wrapped.action).toBe("decode");
    expect(wrapped.requestResync).toBe(true);
  });
});

describe("computer panel state helpers", () => {
  it("maps availability into ready, checking, and blocked views", () => {
    expect(resolveComputerAvailabilityView(undefined).kind).toBe("checking");
    expect(resolveComputerAvailabilityView({ kind: "available" }).kind).toBe("ready");
    expect(
      resolveComputerAvailabilityView({ kind: "backend-unavailable", message: "Backend is off" }),
    ).toMatchObject({ kind: "blocked", description: "Backend is off" });
  });

  it("calls an idle helper ready only when the OS confirms every grant", () => {
    const idle = { ...connectedHealth(), status: "unavailable" as const, captureAvailable: false };
    expect(
      resolveComputerAvailabilityView({ kind: "available", backend: "mac" }, idle, true),
    ).toMatchObject({ kind: "ready", title: "All permissions granted" });
    // A helper that already failed is not idle, whatever the grants say.
    expect(
      resolveComputerAvailabilityView(
        { kind: "available", backend: "mac" },
        {
          ...idle,
          consecutiveFailures: 1,
          lastFailure: { at: "2026-01-01T00:00:00.000Z", message: "helper exited" },
        },
        true,
      ),
    ).toMatchObject({ kind: "checking", title: "Computer access has not been checked" });
  });

  it("does not claim full desktop readiness when capture is denied", () => {
    expect(
      resolveComputerAvailabilityView(
        { kind: "available", backend: "mac" },
        { ...connectedHealth(), captureAvailable: false },
      ),
    ).toMatchObject({ kind: "blocked", title: "Screen capture is unavailable" });
  });

  it("shows a reconnecting backend as checking rather than blocked", () => {
    expect(
      resolveComputerAvailabilityView(
        { kind: "backend-unavailable", message: "Reconnecting to the desktop. Last failure: boom" },
        {
          ...connectedHealth(),
          status: "reconnecting",
          consecutiveFailures: 2,
          lastFailure: { message: "boom", at: "2026-08-16T10:00:00.000Z" },
        },
      ),
    ).toMatchObject({ kind: "checking", description: "boom" });
  });

  it("subscribes only for a visible live available thread", () => {
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: state(),
      }),
    ).toBe(true);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "preview",
        isVisible: true,
        threadState: state(),
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: state({ availability: { kind: "backend-unavailable", message: "off" } }),
      }),
    ).toBe(false);
  });
});

describe("computerStatusNeedsSetup", () => {
  it("says no when there is no state yet, so no surface offers Set up on a guess", () => {
    expect(computerStatusNeedsSetup(undefined)).toBe(false);
  });

  it("says no on a host that could never have a desktop backend", () => {
    // "Set up" on Windows would install nothing and explain nothing; the
    // unsupported-platform message is the whole answer.
    expect(
      computerStatusNeedsSetup(
        state({ availability: { kind: "unsupported-platform", platform: "win32" } }),
      ),
    ).toBe(false);
  });

  it("says yes on a withheld grant and on a backend that is not there", () => {
    expect(
      computerStatusNeedsSetup(
        state({
          availability: {
            kind: "permission-required",
            missing: ["screenRecording"],
            message: "needs Screen Recording",
            buildSignature: "adhoc",
          },
        }),
      ),
    ).toBe(true);
    expect(
      computerStatusNeedsSetup(
        state({ availability: { kind: "backend-unavailable", message: "no helper" } }),
      ),
    ).toBe(true);
  });

  it("asks for setup on an idle backend unless the OS confirms every grant", () => {
    const idle = {
      ...state({
        health: { ...connectedHealth(), status: "unavailable", captureAvailable: false },
      }),
      provisionable: true,
    };
    expect(computerStatusNeedsSetup(idle)).toBe(true);
    expect(computerStatusNeedsSetup(idle, true)).toBe(false);
  });

  it("says yes when the backend has not been provisioned into existence yet", () => {
    // The nested backend reports the empty capability set until its compositor
    // and plugin exist, which is what routes a first-time user to Set up.
    expect(
      computerStatusNeedsSetup(
        state({
          capabilities: { ...state().capabilities, input: false, capture: false },
        }),
      ),
    ).toBe(true);
  });
});

describe("computerCanvasLabel", () => {
  it("names the backend it is actually a picture of", () => {
    // It said "Linux desktop" on every backend, macOS included — and whether the
    // agent is driving a sandbox or the user's own machine is the single most
    // important fact about this surface.
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "mac" },
        visibleDesktop: true,
      }),
    ).toBe("This Mac's desktop");
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "nested-kwin" },
        visibleDesktop: false,
      }),
    ).toBe("The agent's own desktop");
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "kwin" },
        visibleDesktop: true,
      }),
    ).toBe("This computer's desktop");
    expect(computerCanvasLabel({ availability: undefined, visibleDesktop: false })).toBe(
      "The agent's desktop",
    );
  });
});

describe("computerActionLabel", () => {
  it("keeps a failure's own message, which is the part worth the space", () => {
    expect(
      computerActionLabel({ action: "computer_click", ok: false, message: "window moved" }),
    ).toBe("Click failed: window moved");
    expect(computerActionLabel({ action: "computer_click", ok: false })).toBe("Click failed");
  });
});

describe("computerActionStatusLabel", () => {
  it("describes delivery without implying a foreground action kept focus", () => {
    expect(
      computerActionStatusLabel(
        {
          type: "computer.action",
          action: "computer_type_text",
          ok: true,
          windowId: "window-1",
          delivery: { path: "cua-foreground", verified: "confirmed" },
        },
        [
          {
            id: "window-1",
            appName: "TextEdit",
            title: "Untitled",
            focused: false,
            minimized: false,
            visible: true,
          },
        ],
      ),
    ).toBe("Type · TextEdit · Temporary foreground");
  });
});
