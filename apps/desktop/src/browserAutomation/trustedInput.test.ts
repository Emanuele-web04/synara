import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFocusedWebContents = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents },
}));

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import {
  dispatchTrustedClick,
  dispatchTrustedDrag,
  dispatchTrustedKeySequence,
  dispatchTrustedScroll,
  dispatchTrustedText,
} from "./trustedInput";

const makeRuntime = (
  sendCommand = vi.fn(
    async (
      _method: string,
      _params?: Record<string, unknown>,
    ): Promise<Record<string, never>> => ({}),
  ),
) => {
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const expectAgentInput = vi.fn(() => {
    const dispose = vi.fn();
    disposers.push(dispose);
    return dispose;
  });
  const debuggerEvents = new EventEmitter();
  const webContents = {
    isDestroyed: () => false,
    debugger: Object.assign(debuggerEvents, {
      isAttached: () => true,
      sendCommand,
    }),
    focus: vi.fn(),
    insertText: vi.fn(async () => undefined),
    sendInputEvent: vi.fn(),
  } as unknown as WebContents;
  return {
    runtime: {
      threadId: "thread-trusted" as BrowserAutomationVisibleRuntime["threadId"],
      tabId: "tab-trusted",
      webContents,
      expectAgentInput,
    } satisfies BrowserAutomationVisibleRuntime,
    webContents,
    expectAgentInput,
    debuggerEvents,
    disposers,
    sendCommand,
  };
};

describe("trusted browser input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFocusedWebContents.mockReturnValue(null);
  });

  it("dispatches a CDP click in the guest and classifies every native mouse signal as agent-owned", async () => {
    const { runtime, sendCommand, expectAgentInput, disposers } = makeRuntime();

    await dispatchTrustedClick(
      runtime,
      { x: 80, y: 45 },
      {
        button: "right",
        clickCount: 1,
      },
    );

    expect(sendCommand).toHaveBeenNthCalledWith(1, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 80,
      y: 45,
      button: "none",
      modifiers: 0,
    });
    expect(sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({
        type: "mousePressed",
        x: 80,
        y: 45,
        button: "right",
        buttons: 2,
      }),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({
        type: "mouseReleased",
        x: 80,
        y: 45,
        button: "right",
        buttons: 0,
      }),
    );
    expect(expectAgentInput).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mouse",
        type: "mouseDown",
        button: "right",
        x: 80,
        y: 45,
      }),
    );
    expect(expectAgentInput).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mouse",
        type: "contextMenu",
        button: "right",
        x: 80,
        y: 45,
      }),
    );
    expect(disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("uses Chromium drag interception so HTML drag data reaches the drop target", async () => {
    const harness = makeRuntime();
    const dragData = {
      items: [{ mimeType: "text/plain", data: "synara-drag", title: "", baseURL: "" }],
      dragOperationsMask: 1,
    };
    let intercepted = false;
    harness.sendCommand.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (
          !intercepted &&
          method === "Input.dispatchMouseEvent" &&
          params?.type === "mouseMoved" &&
          params.buttons === 1
        ) {
          intercepted = true;
          harness.debuggerEvents.emit("message", {}, "Input.dragIntercepted", { data: dragData });
        }
        return {};
      },
    );

    await dispatchTrustedDrag(harness.runtime, { x: 10, y: 20 }, { x: 100, y: 200 });

    expect(harness.sendCommand).toHaveBeenCalledWith("Input.setInterceptDrags", { enabled: true });
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      expect(harness.sendCommand).toHaveBeenCalledWith("Input.dispatchDragEvent", {
        type,
        x: 100,
        y: 200,
        data: dragData,
        modifiers: 0,
      });
    }
    expect(harness.sendCommand).toHaveBeenCalledWith("Input.setInterceptDrags", { enabled: false });
  });

  it("cancels interception and releases a pressed drag pointer when drop dispatch fails", async () => {
    const harness = makeRuntime();
    let intercepted = false;
    harness.sendCommand.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (
          !intercepted &&
          method === "Input.dispatchMouseEvent" &&
          params?.type === "mouseMoved" &&
          params.buttons === 1
        ) {
          intercepted = true;
          harness.debuggerEvents.emit("message", {}, "Input.dragIntercepted", {
            data: { items: [], dragOperationsMask: 1 },
          });
        }
        if (method === "Input.dispatchDragEvent" && params?.type === "dragOver") {
          throw new Error("renderer changed");
        }
        return {};
      },
    );

    await expect(
      dispatchTrustedDrag(harness.runtime, { x: 10, y: 20 }, { x: 100, y: 200 }),
    ).rejects.toThrow();

    expect(harness.sendCommand).toHaveBeenCalledWith("Input.cancelDragging");
    expect(harness.sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({
        type: "mouseReleased",
        x: 100,
        y: 200,
        button: "left",
        buttons: 0,
      }),
    );
    expect(harness.sendCommand).toHaveBeenCalledWith("Input.setInterceptDrags", {
      enabled: false,
    });
  });

  it("uses a trusted wheel event rather than mutating the page scroll position", async () => {
    const { runtime, sendCommand, expectAgentInput } = makeRuntime();

    await dispatchTrustedScroll(runtime, { x: 12, y: 34 }, 0, 640);

    expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 12,
      y: 34,
      deltaX: 0,
      deltaY: 640,
    });
    expect(expectAgentInput).toHaveBeenCalledWith({
      kind: "mouse",
      type: "mouseWheel",
      x: 12,
      y: 34,
    });
  });

  it("inserts text through the scoped guest instead of the embedder-focused CDP target", async () => {
    const { runtime, webContents, sendCommand } = makeRuntime();

    await dispatchTrustedText(runtime, "guest-only");

    expect(
      (webContents as unknown as { insertText: ReturnType<typeof vi.fn> }).insertText,
    ).toHaveBeenCalledWith("guest-only");
    expect(sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("confines keys to the guest, disables unhandled redispatch, and restores prior focus", async () => {
    const previous = { id: 99, isDestroyed: () => false, focus: vi.fn() };
    getFocusedWebContents.mockReturnValue(previous);
    const { runtime, webContents, expectAgentInput, sendCommand } = makeRuntime();

    await dispatchTrustedKeySequence(runtime, ["Control+A", "Backspace"]);

    const primaryModifierMask = process.platform === "darwin" ? 4 : 2;
    expect(webContents.focus).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({
        expression: expect.stringContaining("active.select()"),
        userGesture: true,
      }),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({
        type: "rawKeyDown",
        modifiers: primaryModifierMask,
        commands: ["selectAll"],
      }),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({
        type: "keyUp",
        modifiers: primaryModifierMask,
      }),
    );
    expect(
      (webContents as unknown as { sendInputEvent: ReturnType<typeof vi.fn> }).sendInputEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "keyUp",
        keyCode: "Backspace",
        modifiers: [],
        skipIfUnhandled: true,
      }),
    );
    expect(expectAgentInput).toHaveBeenCalledTimes(2);
    expect(previous.focus).toHaveBeenCalledOnce();
  });
});
