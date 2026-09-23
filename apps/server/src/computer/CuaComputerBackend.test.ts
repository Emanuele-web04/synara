import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaActionError, CuaComputerBackend } from "./CuaComputerBackend.ts";
import { ComputerAvailability, ComputerScreenshot, ComputerState } from "@synara/contracts";
import { Effect, Schema } from "effect";
import {
  CuaTransportError,
  CUA_SETUP_TIMEOUT_MS,
  type cuaRequest,
} from "@synara/shared/cuaDriverProtocol";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { withDesktopDeliveryMode, withDesktopOperationSignal } from "./DesktopOperationQueue.ts";
import { withModelDesktopObservation } from "./modelDesktopObservation.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import { makeAgentGatewayComputerTools } from "../agentGateway/computerTools.ts";
import type { ToolContext } from "../agentGateway/toolRuntime.ts";

const isTyping = (name?: string) => name === "type_text";

function fixture(options?: {
  readonly semanticTextLaneHoldMs?: number;
  readonly semanticTextLaneGapMs?: number;
  readonly stillIntervalMs?: number;
  readonly hostPlatform?: string;
  readonly nativeRevision?: number | null;
}) {
  const calls: Array<{
    name?: string;
    args?: Record<string, unknown>;
    modelObservation?: boolean;
    deliveryMode?: string;
  }> = [];
  let bounds = { x: -300, y: 20, width: 200, height: 100 };
  let live = true;
  let elements: Record<string, unknown>[] = [];
  let failure: Error | undefined;
  let nativeRefusal = false;
  let desktopPaused = false;
  let desktopEpoch = 0;
  let missingPermissions = false;
  let screenRecordingMissing = false;
  let monitorPermissions: Record<string, unknown> = {};
  let permissionWait: Promise<void> | undefined;
  let overviewFailure = false;
  let captureWindowId = 20;
  let capturePid = 10;
  let captureFrameValid = true;
  let captureFrameFreshness = "captured_current_space";
  let visible = true;
  let ready: Record<string, unknown> = { ready: true, pid: 10, window_id: 20 };
  let afterCapture: (() => void) | undefined;
  let overviewWait: Promise<void> | undefined;
  let windowStateWait: Promise<void> | undefined;
  let typeGate: Promise<void> | undefined;
  // type_text requests the fake driver is holding at once, so lane tests can
  // prove writes overlapped at the native boundary rather than merely
  // resolving in some order.
  let typingInFlight = 0;
  let typingMaxInFlight = 0;
  let extraWindows: Array<Record<string, unknown>> = [];
  let toolHandlers: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {};
  let setValueSwallowed = false;
  let actionResult: Record<string, unknown> = {
    route: "synthetic_events",
    delivery: { mode: "background" },
    effect: "unverifiable",
  };
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  const respond = async (
    _endpoint: unknown,
    request: (typeof calls)[number] & { method?: string },
  ) => {
    calls.push(request);
    const responseEpoch = desktopEpoch;
    if (request.method === "probe" || request.method === "stop")
      return {
        ok: true,
        desktopEpoch: responseEpoch,
        hostPlatform: options?.hostPlatform ?? "darwin",
      };
    if (desktopPaused && (request.name === "click" || isTyping(request.name)))
      return {
        ok: true,
        desktopEpoch: responseEpoch,
        result: {
          isError: true,
          structuredContent: {
            effect: "refused",
            code: "desktop_input_paused",
            message: "Desktop is locked.",
          },
        },
      };
    if (isTyping(request.name)) {
      typingInFlight += 1;
      typingMaxInFlight = Math.max(typingMaxInFlight, typingInFlight);
      try {
        if (failure) throw failure;
        if (typeGate) await typeGate;
      } finally {
        typingInFlight -= 1;
      }
      if (nativeRefusal)
        return {
          ok: true,
          desktopEpoch: responseEpoch,
          result: {
            isError: true,
            structuredContent: {
              effect: "refused",
              code: "same_pid_keyboard_ambiguity",
            },
            content: [{ type: "text", text: "No actuator ran." }],
          },
        };
    }
    let data: unknown = {};
    if (request.name === "check_permissions") {
      data = {
        accessibility: !missingPermissions,
        screen_recording: !missingPermissions && !screenRecordingMissing,
        ...monitorPermissions,
        source: { host_bundle_id: "com.synara.test" },
      };
      await permissionWait;
    }
    if (request.name === "list_windows")
      data = {
        windows: live
          ? [
              {
                pid: 10,
                window_id: 20,
                title: "Owned fixture",
                bounds,
                is_on_screen: visible,
                on_current_space: visible,
                z_index: 1,
              },
              ...extraWindows,
              {
                pid: 20,
                window_id: 30,
                bounds: { x: 0, y: 0, width: 0, height: 0 },
              },
            ]
          : [],
      };
    if (request.name === "check_input_ready") data = ready;
    if (request.name === "get_screen_size") data = { width: 1000, height: 800, scale_factor: 2 };
    if (request.name === "get_desktop_state") {
      if (overviewFailure) throw new Error("Capture denied before permission recovery");
      await overviewWait;
      return {
        ok: true,
        desktopEpoch: responseEpoch,
        result: {
          structuredContent: { screen_width: 200, screen_height: 100 },
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: header.toString("base64"),
            },
          ],
        },
      };
    }
    if (request.name === "get_window_state") {
      if (windowStateWait) await windowStateWait;
      const result = {
        structuredContent: {
          pid: capturePid,
          window_id: captureWindowId,
          window_bounds: bounds,
          screenshot_frame_valid: captureFrameValid,
          screenshot_frame_freshness: captureFrameFreshness,
          elements,
        },
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: header.toString("base64"),
          },
        ],
      };
      afterCapture?.();
      return { ok: true, result, desktopEpoch: responseEpoch };
    }
    if (request.name === "set_value" && !setValueSwallowed) {
      const token = (request.args as Record<string, unknown> | undefined)?.element_token;
      const written = (request.args as Record<string, unknown> | undefined)?.value;
      const target = elements.find((element) => element.element_token === token);
      if (target && typeof written === "string")
        target.value = request.args?.append === true ? `${target.value ?? ""}${written}` : written;
    }
    if (isTyping(request.name)) data = actionResult;
    const toolHandler = request.name ? toolHandlers[request.name] : undefined;
    if (toolHandler)
      return {
        ok: true,
        result: toolHandler(request.args ?? {}),
        desktopEpoch: responseEpoch,
        hostPlatform: options?.hostPlatform ?? "darwin",
      };
    return {
      ok: true,
      result: { structuredContent: data },
      desktopEpoch: responseEpoch,
      hostPlatform: options?.hostPlatform ?? "darwin",
    };
  };
  const request = vi.fn(async (...args: Parameters<typeof respond>) => ({
    ...(await respond(...args)),
    ...(options?.nativeRevision === null
      ? {}
      : { driverNativeRevision: options?.nativeRevision ?? 34 }),
  })) as unknown as typeof cuaRequest;
  const backend = new CuaComputerBackend({
    endpoint: "/fixture-only",
    request,
    ...(options?.semanticTextLaneHoldMs !== undefined
      ? { semanticTextLaneHoldMs: options.semanticTextLaneHoldMs }
      : {}),
    ...(options?.semanticTextLaneGapMs !== undefined
      ? { semanticTextLaneGapMs: options.semanticTextLaneGapMs }
      : {}),
    ...(options?.stillIntervalMs !== undefined ? { stillIntervalMs: options.stillIntervalMs } : {}),
  });
  return {
    backend,
    setElements: (value: Record<string, unknown>[]) => {
      elements = value;
    },
    swallowSetValue: () => {
      setValueSwallowed = true;
    },
    setWindows: (value: Array<Record<string, unknown>>) => {
      extraWindows = value;
    },
    setBounds: (value: typeof bounds) => {
      bounds = value;
    },
    onTool: (name: string, handler: (args: Record<string, unknown>) => Record<string, unknown>) => {
      toolHandlers[name] = handler;
    },
    gateTypeText: (wait: Promise<void> | undefined) => {
      typeGate = wait;
    },
    typingMaxInFlight: () => typingMaxInFlight,
    pauseDesktop: (paused: boolean) => {
      desktopPaused = paused;
    },
    changeDesktop: () => {
      desktopEpoch += 1;
    },
    calls,
    delayOverview: (wait: Promise<void>) => {
      overviewWait = wait;
    },
    delayWindowState: (wait: Promise<void> | undefined) => {
      windowStateWait = wait;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    readiness: (value: Record<string, unknown>) => {
      ready = value;
    },
    moveAfterCapture: () => {
      afterCapture = () => {
        bounds = { ...bounds, x: -250 };
      };
    },
    captureWindow: (value: number, pid = 10) => {
      captureWindowId = value;
      capturePid = pid;
    },
    invalidateCapture: () => {
      captureFrameValid = false;
    },
    markOffSpaceCaptureUnverified: () => {
      captureFrameFreshness = "unverified_off_space";
    },
    actionResult: (value: Record<string, unknown>) => {
      actionResult = value;
    },
    move: () => {
      bounds = { ...bounds, x: -250 };
    },
    close: () => {
      live = false;
    },
    fail: (error: Error) => {
      failure = error;
    },
    unfail: () => {
      failure = undefined;
    },
    refuse: () => {
      nativeRefusal = true;
    },
    denyPermissions: () => {
      missingPermissions = true;
    },
    grantPermissions: () => {
      missingPermissions = false;
      screenRecordingMissing = false;
    },
    denyScreenRecording: () => {
      screenRecordingMissing = true;
    },
    setInputMonitor: (granted: boolean, ready: boolean) => {
      monitorPermissions = { input_monitoring: granted, input_monitor_ready: ready };
    },
    waitForPermission: (wait: Promise<void>) => {
      permissionWait = wait;
    },
    failOverview: () => {
      overviewFailure = true;
    },
  };
}

function gatewayFixture(f: ReturnType<typeof fixture>) {
  const manager = new ComputerManager({ backend: f.backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerTools({ manager });
  const context: ToolContext = {
    principal: {
      kind: "provider-session",
      sessionKey: "test-session",
      threadId: "test-thread",
      turnId: "test-turn",
      provider: "claudeAgent",
    },
    callerThreadId: "test-thread",
    callerThreadLabel: null,
    callerSessionKey: "test-session",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "test-turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
  const call = (name: string, args: Record<string, unknown>) =>
    Effect.runPromise(tools.find((tool) => tool.definition.name === name)!.handler(args, context));
  const list = async () => {
    const result = await call("computer_get_state", {
      window_id: "cua:10:20",
      include_screenshot: false,
    });
    expect(result.isError).not.toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    return JSON.parse(text?.type === "text" ? text.text : "{}").elements as Array<{
      ref: number;
      label: string;
      value?: string;
    }>;
  };
  return { manager, call, list };
}

describe("Cua native boundary", () => {
  it("requests AX keyboard focus only for explicit observations, not input revalidation", async () => {
    const f = fixture({ nativeRevision: 37 });
    await withModelDesktopObservation(() =>
      f.backend.getState({ windowId: "cua:10:20", includeTree: true }),
    );
    expect(f.calls.find((call) => call.name === "list_windows")?.args).toEqual({
      include_keyboard_focus: true,
    });
    f.calls.length = 0;
    await withModelDesktopObservation(() => f.backend.pressKey("enter", "cua:10:20"));
    expect(f.calls.find((call) => call.name === "list_windows")?.args).toEqual({});
  });
  it("carries a provider's observed field ref through the gateway and manager to native Return", async () => {
    const f = fixture({ nativeRevision: 37 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Address",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "address-token",
      },
    ]);
    const { manager, call } = gatewayFixture(f);
    try {
      const state = await call("computer_get_state", { window_id: "cua:10:20" });
      expect(state.isError).not.toBe(true);
      const content = state.content.find((entry) => entry.type === "text")!;
      const payload = JSON.parse(content.type === "text" ? content.text : "{}");
      const field = payload.elements.find(
        (element: { label: string }) => element.label === "Address",
      );
      expect(field.ref).toEqual(expect.any(Number));
      const result = await call("computer_press_key", {
        key: "enter",
        ref: field.ref,
        include_screenshot: false,
      });
      expect(result.isError).not.toBe(true);
      expect(f.calls.findLast((call) => call.name === "press_key")?.args).toMatchObject({
        key: "enter",
        element_token: "address-token",
        pid: 10,
        window_id: 20,
      });
      const batch = await call("computer_run", {
        steps: [{ type: "press_key", key: "enter", ref: field.ref }],
        include_screenshot: false,
      });
      expect(batch.isError).not.toBe(true);
      expect(f.calls.filter((call) => call.name === "press_key")).toHaveLength(2);
      expect(f.calls.findLast((call) => call.name === "press_key")?.args).toHaveProperty(
        "element_token",
        "address-token",
      );
    } finally {
      await manager.dispose();
    }
  });

  it.each(["press_key", "click", "set_value", "type_text"] as const)(
    "keeps the original native identity after identical-label controls reorder for %s",
    async (action) => {
      const f = fixture({ nativeRevision: 37 });
      const first = {
        role: action === "click" ? "AXButton" : "AXTextField",
        label: "Duplicate",
        value: "first",
        frame: { x: -290, y: 30, width: 70, height: 20 },
        element_token: "original-first-token",
        actions: ["AXPress"],
        in_web_content: true,
      };
      const second = {
        ...first,
        value: "second",
        frame: { ...first.frame, x: -200 },
        element_token: "original-second-token",
      };
      f.setElements([first, second]);
      f.onTool("set_value", () => ({
        structuredContent: { effect: "confirmed", evidence: [{ kind: "value_readback" }] },
      }));
      const { manager, call, list } = gatewayFixture(f);
      try {
        const original = await list();
        const firstRef = original[0]!.ref;
        expect(JSON.stringify(original)).not.toContain("original-first-token");
        f.setElements([second, first]);
        const reordered = await list();
        expect(reordered.map((element) => element.ref)).toEqual([original[1]!.ref, firstRef]);
        const beforeAction = f.calls.length;
        const result = await call(`computer_${action}`, {
          ref: firstRef,
          include_screenshot: false,
          ...(action === "press_key" ? { key: "enter" } : {}),
          ...(action === "set_value" ? { value: "updated" } : {}),
          ...(action === "type_text" ? { text: " appended" } : {}),
        });
        expect(result.isError).not.toBe(true);
        const nativeAction = action === "type_text" ? "set_value" : action;
        expect(f.calls.findLast((call) => call.name === nativeAction)?.args).toHaveProperty(
          "element_token",
          "original-first-token",
        );
        const actionCalls = f.calls.slice(beforeAction);
        const writeIndex = actionCalls.findIndex((call) => call.name === nativeAction);
        expect(
          actionCalls.slice(0, writeIndex).some((call) => call.name === "get_window_state"),
        ).toBe(false);
        if (action === "type_text") {
          expect(actionCalls[writeIndex]?.args).toMatchObject({ append: true, value: " appended" });
          expect(first.value).toBe("first appended");
          expect(second.value).toBe("second");
        }
      } finally {
        await manager.dispose();
      }
    },
  );

  it("refuses a retained web append when an identical replacement occupies the same geometry", async () => {
    const f = fixture({ nativeRevision: 37 });
    const field = {
      role: "AXTextField",
      label: "Search",
      value: "old",
      frame: { x: -290, y: 30, width: 120, height: 20 },
      element_token: "original-token",
      in_web_content: true,
    };
    f.setElements([field]);
    const { manager, call, list } = gatewayFixture(f);
    try {
      const original = (await list())[0]!;
      f.setElements([{ ...field, value: "replacement", element_token: "replacement-token" }]);
      await list();
      f.onTool("set_value", () => ({
        isError: true,
        structuredContent: {
          effect: "not-dispatched",
          code: "stale_target",
          message: "The original token expired.",
        },
      }));
      const beforeAction = f.calls.length;
      const result = await call("computer_type_text", {
        ref: original.ref,
        text: " appended",
        include_screenshot: false,
      });
      expect(result.isError).toBe(true);
      const writes = f.calls
        .slice(beforeAction)
        .filter((call) => call.name === "set_value" || call.name === "type_text");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.args).toMatchObject({ element_token: "original-token", append: true });
      expect(f.calls.slice(beforeAction).some((call) => call.name === "get_window_state")).toBe(
        false,
      );
    } finally {
      await manager.dispose();
    }
  });

  it("refuses retained web append on older native revisions without a snapshot or write", async () => {
    const f = fixture({ nativeRevision: 36 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Search",
        value: "old",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "original-token",
        in_web_content: true,
      },
    ]);
    const { manager, call, list } = gatewayFixture(f);
    try {
      const original = (await list())[0]!;
      const beforeAction = f.calls.length;
      const result = await call("computer_type_text", {
        ref: original.ref,
        text: " appended",
        include_screenshot: false,
      });
      expect(result.isError).toBe(true);
      expect(
        f.calls
          .slice(beforeAction)
          .filter((call) =>
            ["get_window_state", "set_value", "type_text"].includes(call.name ?? ""),
          ),
      ).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a native retained ref without a semantic click instead of using its stale coordinates", async () => {
    const f = fixture({ nativeRevision: 37 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Search",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "original-token",
      },
    ]);
    const { manager, call, list } = gatewayFixture(f);
    try {
      const original = (await list())[0]!;
      const result = await call("computer_click", { ref: original.ref, include_screenshot: false });
      expect(result.isError).toBe(true);
      expect(f.calls.filter((call) => call.name === "click")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("never recycles a native ref when its bounded table is evicted", async () => {
    const f = fixture({ nativeRevision: 37 });
    const { manager, call, list } = gatewayFixture(f);
    try {
      let firstRef: number | undefined;
      let latestRefs: number[] = [];
      for (let batch = 0; batch < 9; batch += 1) {
        f.setElements(
          Array.from({ length: 60 }, (_, index) => ({
            role: "AXButton",
            label: `Button ${batch}-${index}`,
            frame: { x: -290, y: 30, width: 20, height: 20 },
            element_token: `token-${batch}-${index}`,
            actions: ["AXPress"],
          })),
        );
        latestRefs = (await list()).map((element) => element.ref);
        firstRef ??= latestRefs[0];
      }
      expect(Math.min(...latestRefs)).toBeGreaterThan(firstRef!);
      const stale = await call("computer_click", { ref: firstRef, include_screenshot: false });
      expect(stale.isError).toBe(true);
      expect(f.calls.filter((call) => call.name === "click")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("keeps advertised retained AX actions available off-Space without dispatching pointer input", async () => {
    const f = fixture({ nativeRevision: 37 });
    f.setElements([
      {
        role: "AXButton",
        label: "Import",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "import-token",
        actions: ["AXPress"],
      },
    ]);
    const state = await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    const node = state.root!.children[0]!;
    f.setVisible(false);
    await f.backend.performAction(
      { target: { label: "Import" }, node, point: node.activationPoint! },
      "AXPress",
    );
    expect(f.calls.findLast((call) => call.name === "click")?.args).toMatchObject({
      element_token: "import-token",
      action: "press",
      delivery_mode: "background",
    });
    expect(f.calls.findLast((call) => call.name === "click")?.args).not.toHaveProperty("x");
    await expect(f.backend.pressKey("enter", "cua:10:20")).rejects.toMatchObject({
      code: "target_not_on_active_space",
      effect: "not-dispatched",
    });
  });

  it("preserves actual native keyboard focus independently of the selected target", async () => {
    const f = fixture();
    f.setWindows([
      {
        pid: 10,
        window_id: 21,
        title: "Sheet",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        is_on_screen: true,
        keyboard_focused: true,
      },
    ]);
    await f.backend.focusWindow("cua:10:20");
    const windows = await f.backend.listWindows();
    expect(windows.find((window) => window.id === "cua:10:20")).toMatchObject({ focused: true });
    expect(windows.find((window) => window.id === "cua:10:20")).not.toHaveProperty(
      "keyboardFocused",
    );
    expect(windows.find((window) => window.id === "cua:10:21")).toMatchObject({
      focused: false,
      keyboardFocused: true,
    });
  });

  it("preserves app-initiated focus changes during a requested background launch", async () => {
    const f = fixture();
    f.onTool("launch_app", () => ({
      structuredContent: { pid: 10, focus_changed_during_launch: true },
    }));
    expect(await f.backend.launchApp("Resolve")).toMatchObject({
      pid: 10,
      focusChangedDuringLaunch: true,
    });
    expect(f.calls.filter((call) => call.name === "launch_app")).toHaveLength(1);
  });

  it.each([
    ["down", 0, 240, 0, -2],
    ["up", 0, -240, 0, 2],
    ["right", 240, 0, -2, 0],
    ["left", -240, 0, 2, 0],
  ] as const)(
    "maps public %s scrolling to Core Graphics wheel signs",
    async (direction, dx, dy, nativeX, nativeY) => {
      const f = fixture();
      await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      const result = await f.backend.scroll({ x: -275, y: 30 }, dx, dy, "cua:10:20");
      expect(result.scrollDelta).toEqual({ deltaX: dx, deltaY: dy });
      expect(f.calls.find((call) => call.name === "scroll")?.args).toMatchObject({
        direction,
        delta_x: nativeX,
        delta_y: nativeY,
      });
    },
  );

  it("uses advertised AX actions and retains a fresh check at input dispatch", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXButton",
        label: "Equals",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
        actions: ["AXPress"],
      },
      {
        role: "AXButton",
        label: "Canvas",
        frame: { x: -270, y: 30, width: 20, height: 20 },
        element_token: "canvas-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Equals" },
      node,
      point: node.activationPoint!,
    };
    expect(f.calls.filter((c) => c.name === "list_windows")).toHaveLength(1);
    expect(state.windows).toHaveLength(1);
    expect(f.backend.supportsAction(target, "AXPress")).toBe(true);
    expect(f.backend.supportsAction({ ...target, node: state.root!.children[1]! }, "AXPress")).toBe(
      false,
    );
    await f.backend.focusWindow("cua:10:20");
    expect(f.calls.filter((c) => c.name === "list_windows")).toHaveLength(1);
    await f.backend.performAction(target, "AXPress");
    expect(f.calls.filter((c) => c.name === "list_windows")).toHaveLength(2);
    expect(f.calls.find((c) => c.name === "click")?.args).toMatchObject({
      element_token: "fresh-token",
      pid: 10,
      window_id: 20,
    });
    expect(f.calls.find((c) => c.name === "click")?.args).not.toHaveProperty("force_synthetic");
    f.close();
    await expect(f.backend.performAction(target, "AXPress")).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    expect(f.calls.filter((c) => c.name === "click")).toHaveLength(1);
  });

  it("dispatches named secondary actions through the click element recipe", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXRow",
        label: "Document.txt",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "open-token",
        actions: ["AXPress", "AXOpen"],
      },
      {
        role: "AXButton",
        label: "Menu",
        frame: { x: -270, y: 30, width: 20, height: 20 },
        element_token: "menu-token",
        actions: ["AXPress", "AXShowMenu", "AXPick", "AXConfirm", "AXCancel"],
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const openNode = state.root!.children[0]!;
    const menuNode = state.root!.children[1]!;
    const openTarget = {
      target: { label: "Document.txt" },
      node: openNode,
      point: openNode.activationPoint!,
    };
    const menuTarget = {
      target: { label: "Menu" },
      node: menuNode,
      point: menuNode.activationPoint!,
    };

    expect(f.backend.supportsAction(openTarget, "open")).toBe(true);
    expect(f.backend.supportsAction(openTarget, "show_menu")).toBe(false);
    expect(f.backend.supportsAction(menuTarget, "menu")).toBe(true);
    expect(f.backend.supportsAction(menuTarget, "activate")).toBe(false);

    await f.backend.performAction(openTarget, "open");
    for (const action of ["press", "show_menu", "menu", "pick", "confirm", "cancel"]) {
      await f.backend.performAction(menuTarget, action);
    }
    // Each admitted name lands on the token as the driver's `click` action
    // recipe; `menu` is the Synara-side alias for the same AXShowMenu call.
    const dispatched = f.calls
      .filter((c) => c.name === "click")
      .map((c) => [c.args?.element_token, c.args?.action]);
    expect(dispatched).toEqual([
      ["open-token", "open"],
      ["menu-token", "press"],
      ["menu-token", "show_menu"],
      ["menu-token", "show_menu"],
      ["menu-token", "pick"],
      ["menu-token", "confirm"],
      ["menu-token", "cancel"],
    ]);
    // The legacy AXPress spelling rides the same recipe.
    await f.backend.performAction(openTarget, "AXPress");
    expect(f.calls.findLast((c) => c.name === "click")?.args).toMatchObject({
      element_token: "open-token",
      action: "press",
    });
  });

  it("refuses a secondary action the element does not advertise, without dispatching", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXButton",
        label: "Plain",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "plain-token",
        actions: ["AXPress"],
      },
      {
        role: "AXStaticText",
        label: "Passive",
        frame: { x: -270, y: 30, width: 20, height: 20 },
        element_token: "passive-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const target = {
      target: { label: "Plain" },
      node: state.root!.children[0]!,
      point: state.root!.children[0]!.activationPoint!,
    };
    const passive = {
      target: { label: "Passive" },
      node: state.root!.children[1]!,
      point: state.root!.children[1]!.activationPoint!,
    };

    for (const action of ["open", "show_menu", "menu", "pick", "confirm", "cancel"]) {
      await expect(f.backend.performAction(target, action)).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "unsupported_operation",
      });
    }
    // An element that reported no action list at all refuses the same way.
    await expect(f.backend.performAction(passive, "open")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "unsupported_operation",
    });
    // And a name the integration never mapped never reaches the driver.
    await expect(f.backend.performAction(target, "toggle")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "unsupported_operation",
    });
    expect(f.calls.filter((c) => c.name === "click")).toHaveLength(0);

    // AXPress keeps its historical dispatch on unadvertised elements — the
    // driver degrades it to a verified AXSelected write, so it is not gated.
    await f.backend.performAction(target, "press");
    expect(f.calls.filter((c) => c.name === "click")).toHaveLength(1);
  });

  it("writes through a live token and refuses a stale one without a second dispatch", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXTextField",
        label: "Display",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Display" },
      node,
      point: node.activationPoint!,
    };
    await f.backend.setValue(target, "1");
    expect(f.calls.find((c) => c.name === "set_value")?.args).toMatchObject({
      element_token: "fresh-token",
      value: "1",
    });
    f.close();
    await expect(f.backend.setValue(target, "2")).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    expect(f.calls.filter((c) => c.name === "set_value")).toHaveLength(1);
  });

  it("selects an exact text range on a live element and trusts only native read-back", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXTextField",
        label: "Display",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Display" },
      node,
      point: node.activationPoint!,
    };

    // Only the driver's confirmed effect backed by read-back evidence marks
    // the selection verified; anything weaker is reported honestly.
    f.onTool("select_text", () => ({
      structuredContent: {
        route: "ax_semantic",
        delivery: { mode: "background" },
        effect: "confirmed",
        evidence: [{ kind: "value_readback" }],
      },
    }));
    await expect(f.backend.selectText(target, { start: 2, length: 4 })).resolves.toMatchObject({
      verified: "confirmed",
      effect: "verified",
    });
    const call = f.calls.find((c) => c.name === "select_text");
    expect(call?.args).toMatchObject({
      pid: 10,
      window_id: 20,
      element_token: "fresh-token",
      start: 2,
      length: 4,
    });
    // An AX attribute write has no foreground/background delivery split.
    expect(call?.args).not.toHaveProperty("delivery_mode");

    // A structured refusal is the driver's proof nothing was written.
    f.onTool("select_text", () => ({
      isError: true,
      structuredContent: { effect: "refused", code: "attribute_not_settable" },
      content: [{ type: "text", text: "AXSelectedTextRange is not settable." }],
    }));
    await expect(f.backend.selectText(target, { start: 0, length: 1 })).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "attribute_not_settable",
    });

    // An inconclusive write reports dispatched-unknown exactly once — an
    // uncertain AX write is never replayed by the backend.
    f.onTool("select_text", () => ({
      structuredContent: {
        route: "ax_semantic",
        delivery: { mode: "background" },
        effect: "unconfirmed",
      },
    }));
    await expect(f.backend.selectText(target, { start: 0, length: 1 })).resolves.toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
    expect(f.calls.filter((c) => c.name === "select_text")).toHaveLength(3);

    // A node the backend never observed has no token: refuse before dispatch
    // rather than sending the driver a token it does not own.
    const unobserved = {
      target: { label: "Display" },
      node: { ...node, children: [] },
      point: node.activationPoint!,
    };
    await expect(f.backend.selectText(unobserved, { start: 0, length: 1 })).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_target",
    });

    f.close();
    await expect(f.backend.selectText(target, { start: 0, length: 1 })).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    expect(f.calls.filter((c) => c.name === "select_text")).toHaveLength(3);
  });

  it("uses semantic-only text delivery for an exact live control", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };

    await f.backend.typeText("hello", "cua:10:20", target);
    expect(f.calls.find((call) => call.name === "type_text")?.args).toMatchObject({
      text: "hello",
      pid: 10,
      window_id: 20,
      element_token: "message-token",
      semantic_only: true,
      // Overrides the driver's 30ms-per-character default pacing.
      delay_ms: 0,
    });
    expect(f.calls.find((call) => call.name === "type_text")?.args).not.toHaveProperty(
      "force_synthetic",
    );

    await f.backend.typeText("keyboard", "cua:10:20");
    // No element: the driver's atomic focused-field insertion runs first, so
    // key events are not forced.
    const focusedFieldCall = f.calls.filter((call) => call.name === "type_text")[1]?.args;
    expect(focusedFieldCall).toMatchObject({ text: "keyboard", delay_ms: 10 });
    expect(focusedFieldCall).not.toHaveProperty("force_synthetic");
    expect(focusedFieldCall).not.toHaveProperty("semantic_only");
  });

  it("types into web content through a composed set_value and verifies on re-read", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "web-token",
        element_index: 2,
        in_web_content: true,
        value: "seed",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };

    const result = await f.backend.typeText("-typed", "cua:10:20", target);
    // Chromium-family fields never honour AXSelectedText: the write must be a
    // composed AXValue set, not a semantic insert.
    expect(f.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
    const write = f.calls.find((call) => call.name === "set_value");
    expect(write?.args).toMatchObject({
      element_token: "web-token",
      element_index: 2,
      value: "seed-typed",
      pid: 10,
      window_id: 20,
    });
    // The independent re-read saw the DOM value land.
    expect(result).toMatchObject({ verified: "confirmed", effect: "verified" });
    const reads = f.calls.filter((call) => call.name === "get_window_state");
    expect(reads).toHaveLength(3);
    for (const read of reads) expect(read.args?.include_screenshot).toBe(false);
  });

  it("refuses a stale semantic field when fresh state has two matching controls", async () => {
    const f = fixture();
    const field = {
      role: "AXTextField",
      label: "Message",
      frame: { x: -290, y: 30, width: 120, height: 20 },
      element_token: "one",
      element_index: 2,
      in_web_content: true,
      value: "seed",
    };
    f.setElements([field]);
    const state = await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    const node = state.root!.children[0]!;
    f.setElements([field, { ...field, element_token: "two", element_index: 3 }]);
    await expect(
      f.backend.setValue(
        { target: { label: "Message", windowId: "cua:10:20" }, node, point: node.activationPoint! },
        "replacement",
      ),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "stale_target" });
    expect(f.calls.filter((call) => call.name === "set_value")).toHaveLength(0);
  });

  it("reports dispatched-unknown when a web set_value does not land", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "web-token",
        element_index: 2,
        in_web_content: true,
        value: "seed",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };

    // The driver accepts the write but the element's value never changes —
    // the re-read must catch that and refuse to call it verified.
    f.swallowSetValue();
    const result = await f.backend.typeText("-typed", "cua:10:20", target);
    expect(result).toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
    const reads = f.calls.filter((call) => call.name === "get_window_state");
    expect(reads).toHaveLength(3);
    for (const read of reads) expect(read.args?.include_screenshot).toBe(false);
  });

  it.each([
    { action: "typeText", interruption: "timeout" },
    { action: "typeText", interruption: "cancellation" },
    { action: "typeText", interruption: "elapsed deadline" },
    { action: "setValue", interruption: "timeout" },
    { action: "setValue", interruption: "cancellation" },
    { action: "setValue", interruption: "elapsed deadline" },
  ] as const)(
    "never sends web $action after $interruption while its field read was pending",
    async ({ action, interruption }) => {
      const f = fixture({
        semanticTextLaneGapMs: 0,
        semanticTextLaneHoldMs: interruption === "timeout" ? 80 : 1_000,
      });
      f.setElements([
        {
          role: "AXTextField",
          label: "Message",
          frame: { x: -290, y: 30, width: 120, height: 20 },
          element_token: "web-token",
          element_index: 2,
          in_web_content: true,
          value: "seed",
        },
      ]);
      const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
        .children[0]!;
      const target = {
        target: { label: "Message", windowId: "cua:10:20" },
        node,
        point: node.activationPoint!,
      };
      const read = Promise.withResolvers<void>();
      f.delayWindowState(read.promise);
      const controller = new AbortController();
      const pending = withDesktopOperationSignal(controller.signal, () =>
        action === "typeText"
          ? f.backend.typeText("expired", "cua:10:20", target)
          : f.backend.setValue(target, "expired"),
      );
      const rejected =
        interruption === "cancellation"
          ? expect(pending).rejects.toThrow("Caller cancelled")
          : expect(pending).rejects.toMatchObject({ effect: "not-dispatched" });
      await vi.waitFor(() =>
        expect(f.calls.filter((call) => call.name === "get_window_state")).toHaveLength(2),
      );
      if (interruption === "cancellation") controller.abort(new Error("Caller cancelled"));
      if (interruption === "elapsed deadline") {
        // Model a blocked event loop: the pre-read completion can resume
        // before the budget timer gets its overdue turn.
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
        read.resolve();
        try {
          await rejected;
        } finally {
          clock.mockRestore();
        }
      } else await rejected;
      expect(f.calls.filter((call) => call.name === "set_value")).toHaveLength(0);

      // Let the abandoned read finish after its operation scope is closed.
      // A later write must drain that continuation without replaying its input.
      f.delayWindowState(undefined);
      read.resolve();
      await expect(f.backend.setValue(target, "allowed")).resolves.toMatchObject({
        effect: "verified",
      });
      expect(
        f.calls.filter((call) => call.name === "set_value").map((call) => call.args?.value),
      ).toEqual(["allowed"]);
      expect(f.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
    },
  );

  it("semantic text lane serializes same-window writes", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    // Two distinct elements in one window still share the lane: the native
    // semantic lease is per (pid, window), so a second concurrent write to the
    // window would be refused outright rather than queued.
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
      {
        role: "AXTextField",
        label: "Notes",
        frame: { x: -290, y: 60, width: 120, height: 20 },
        element_token: "notes-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const firstNode = state.root!.children[0]!;
    const secondNode = state.root!.children[1]!;
    const firstTarget = {
      target: { label: "Message", windowId: "cua:10:20" },
      node: firstNode,
      point: firstNode.activationPoint!,
    };
    const secondTarget = {
      target: { label: "Notes", windowId: "cua:10:20" },
      node: secondNode,
      point: secondNode.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));
    const typeTexts = () => f.calls.filter((call) => call.name === "type_text");

    const first = f.backend.typeText("alpha", "cua:10:20", firstTarget);
    await vi.waitFor(() => expect(typeTexts()).toHaveLength(1));
    const second = f.backend.typeText("bravo", "cua:10:20", secondTarget);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(typeTexts()).toHaveLength(1);
    expect(f.typingMaxInFlight()).toBe(1);
    releaseGate!();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(typeTexts().map((call) => call.args?.text)).toEqual(["alpha", "bravo"]);
  });

  it("semantic text lane holds select_text behind a same-window write", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));

    const typing = f.backend.typeText("alpha", "cua:10:20", target);
    await vi.waitFor(() => expect(f.calls.some((c) => c.name === "type_text")).toBe(true));
    const selecting = f.backend.selectText(target, { start: 0, length: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The native semantic lease is per (pid, window): the selection must not
    // reach the driver while the same-window write is still held.
    expect(f.calls.some((c) => c.name === "select_text")).toBe(false);
    releaseGate!();

    await expect(Promise.all([typing, selecting])).resolves.toHaveLength(2);
    const order = f.calls
      .filter((c) => c.name === "type_text" || c.name === "select_text")
      .map((c) => c.name);
    expect(order).toEqual(["type_text", "select_text"]);
  });

  it("semantic text lane holds set_value behind a same-window write", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));

    const typing = f.backend.typeText("alpha", "cua:10:20", target);
    await vi.waitFor(() => expect(f.calls.some((c) => c.name === "type_text")).toBe(true));
    const writing = f.backend.setValue(target, "beta");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The native semantic lease is per (pid, window) and set_value takes the
    // same concurrent lease as type_text/select_text: it must not reach the
    // driver while the same-window write is still held, or the lease refuses
    // the second action outright (native_input_busy).
    expect(f.calls.some((c) => c.name === "set_value")).toBe(false);
    releaseGate!();

    await expect(Promise.all([typing, writing])).resolves.toHaveLength(2);
    const order = f.calls
      .filter((c) => c.name === "type_text" || c.name === "set_value")
      .map((c) => c.name);
    expect(order).toEqual(["type_text", "set_value"]);
  });

  it("set_value dispatches to a window that is not on the current Space", async () => {
    const f = fixture();
    // A pure AX attribute write is exactly the mutation the driver's
    // StableMembership policy admits on a hidden, minimized or off-Space
    // window — the same admission semantic type_text and select_text get.
    // Only pointer, synthetic keyboard and generic window actions carry the
    // visibility requirement.
    f.setVisible(false);
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    await expect(f.backend.setValue(target, "beta")).resolves.toBeDefined();
    expect(f.calls.some((c) => c.name === "set_value")).toBe(true);
    // The driver still sees the element-addressed semantic write shape.
    expect(f.calls.find((c) => c.name === "set_value")?.args).toMatchObject({
      element_token: "message-token",
      pid: 10,
      window_id: 20,
    });
  });

  it("semantic text lane overlaps same-pid writes to different windows", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    f.setWindows([
      {
        pid: 10,
        window_id: 21,
        title: "Owned fixture B",
        bounds: { x: 100, y: 20, width: 200, height: 100 },
        is_on_screen: true,
        on_current_space: true,
        z_index: 0,
      },
    ]);
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const firstNode = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    f.captureWindow(21);
    const secondNode = (await f.backend.getState({ windowId: "cua:10:21", includeTree: true }))
      .root!.children[0]!;
    const firstTarget = {
      target: { label: "Message", windowId: "cua:10:20" },
      node: firstNode,
      point: firstNode.activationPoint!,
    };
    const secondTarget = {
      target: { label: "Message", windowId: "cua:10:21" },
      node: secondNode,
      point: secondNode.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));
    const typeTexts = () => f.calls.filter((call) => call.name === "type_text");

    const first = f.backend.typeText("alpha", "cua:10:20", firstTarget);
    const second = f.backend.typeText("bravo", "cua:10:21", secondTarget);
    // Both writes reach the driver while the gate is still held — in flight
    // together at the native boundary, not queued one behind the other.
    await vi.waitFor(() => expect(typeTexts()).toHaveLength(2));
    expect(f.typingMaxInFlight()).toBe(2);
    releaseGate!();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("semantic text lane overlaps different-pid writes", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    f.setWindows([
      {
        pid: 11,
        window_id: 21,
        title: "Owned fixture B",
        bounds: { x: 100, y: 20, width: 200, height: 100 },
        is_on_screen: true,
        on_current_space: true,
        z_index: 0,
      },
    ]);
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const firstNode = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    f.captureWindow(21, 11);
    const secondNode = (await f.backend.getState({ windowId: "cua:11:21", includeTree: true }))
      .root!.children[0]!;
    const firstTarget = {
      target: { label: "Message", windowId: "cua:10:20" },
      node: firstNode,
      point: firstNode.activationPoint!,
    };
    const secondTarget = {
      target: { label: "Message", windowId: "cua:11:21" },
      node: secondNode,
      point: secondNode.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));
    const typeTexts = () => f.calls.filter((call) => call.name === "type_text");

    const first = f.backend.typeText("alpha", "cua:10:20", firstTarget);
    const second = f.backend.typeText("bravo", "cua:11:21", secondTarget);
    await vi.waitFor(() => expect(typeTexts()).toHaveLength(2));
    expect(f.typingMaxInFlight()).toBe(2);
    releaseGate!();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("semantic text lane interleaves three same-pid windows truly concurrently", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    // The three-window fixture case: three exact text targets in three windows
    // of one Electron pid. The lane must let all three reach the driver at
    // once — only same-window writes serialize.
    f.setWindows([
      {
        pid: 10,
        window_id: 21,
        title: "Owned fixture B",
        bounds: { x: 100, y: 20, width: 200, height: 100 },
        is_on_screen: true,
        on_current_space: true,
        z_index: 0,
      },
      {
        pid: 10,
        window_id: 22,
        title: "Owned fixture C",
        bounds: { x: 500, y: 20, width: 200, height: 100 },
        is_on_screen: true,
        on_current_space: true,
        z_index: 0,
      },
    ]);
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const firstNode = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    f.captureWindow(21);
    const secondNode = (await f.backend.getState({ windowId: "cua:10:21", includeTree: true }))
      .root!.children[0]!;
    f.captureWindow(22);
    const thirdNode = (await f.backend.getState({ windowId: "cua:10:22", includeTree: true })).root!
      .children[0]!;
    const firstTarget = {
      target: { label: "Message", windowId: "cua:10:20" },
      node: firstNode,
      point: firstNode.activationPoint!,
    };
    const secondTarget = {
      target: { label: "Message", windowId: "cua:10:21" },
      node: secondNode,
      point: secondNode.activationPoint!,
    };
    const thirdTarget = {
      target: { label: "Message", windowId: "cua:10:22" },
      node: thirdNode,
      point: thirdNode.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));
    const typeTexts = () => f.calls.filter((call) => call.name === "type_text");

    const writes = [
      f.backend.typeText("alpha", "cua:10:20", firstTarget),
      f.backend.typeText("bravo", "cua:10:21", secondTarget),
      f.backend.typeText("charlie", "cua:10:22", thirdTarget),
    ];
    // All three writes arrive while the gate is still held: three semantic
    // writes to one pid in flight at once, not a serialized queue.
    await vi.waitFor(() => expect(typeTexts()).toHaveLength(3));
    expect(f.typingMaxInFlight()).toBe(3);
    releaseGate!();

    await expect(Promise.all(writes)).resolves.toHaveLength(3);
    expect(typeTexts().map((call) => call.args?.window_id)).toEqual([20, 21, 22]);
  });

  it("semantic text lane leaves synthetic keyboard writes alone", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));
    const typeTexts = () => f.calls.filter((call) => call.name === "type_text");

    const first = f.backend.typeText("a", "cua:10:20");
    const second = f.backend.typeText("b", "cua:10:20");
    await vi.waitFor(() => expect(typeTexts()).toHaveLength(2));
    releaseGate!();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it.each(["success", "failure"])(
    "keeps a timed-out semantic write in its lane until late %s",
    async (outcome) => {
      const f = fixture({ semanticTextLaneGapMs: 0, semanticTextLaneHoldMs: 80 });
      f.setElements([
        {
          role: "AXTextField",
          label: "Message",
          frame: { x: -290, y: 30, width: 120, height: 20 },
          element_token: "message-token",
        },
      ]);
      const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
        .children[0]!;
      const target = {
        target: { label: "Message", windowId: "cua:10:20" },
        node,
        point: node.activationPoint!,
      };
      let releaseGate!: () => void;
      let rejectGate!: (error: Error) => void;
      f.gateTypeText(
        new Promise<void>((resolve, reject) => {
          releaseGate = resolve;
          rejectGate = reject;
        }),
      );
      const typeTexts = () => f.calls.filter((call) => call.name === "type_text");

      await expect(f.backend.typeText("alpha", "cua:10:20", target)).rejects.toMatchObject({
        effect: "dispatched-unknown",
      });
      const second = f.backend.typeText("beta", "cua:10:20", target);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(typeTexts()).toHaveLength(1);
      expect(f.typingMaxInFlight()).toBe(1);

      f.gateTypeText(undefined);
      if (outcome === "success") releaseGate();
      else rejectGate(new Error("Late native failure"));
      await expect(second).resolves.toMatchObject({ windowId: "cua:10:20" });
      expect(typeTexts().map((call) => call.args?.text)).toEqual(["alpha", "beta"]);
      expect(f.typingMaxInFlight()).toBe(1);
    },
  );

  it("expires a queued semantic write without dispatching it after the lane drains", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0, semanticTextLaneHoldMs: 40 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));

    await expect(f.backend.typeText("alpha", "cua:10:20", target)).rejects.toMatchObject({
      effect: "dispatched-unknown",
      code: "cua_action_failed",
    });
    await expect(f.backend.typeText("expired", "cua:10:20", target)).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    expect(f.calls.filter((call) => call.name === "type_text")).toHaveLength(1);
    f.gateTypeText(undefined);
    releaseGate();
    await expect(f.backend.typeText("beta", "cua:10:20", target)).resolves.toMatchObject({
      windowId: "cua:10:20",
    });
    expect(
      f.calls.filter((call) => call.name === "type_text").map((call) => call.args?.text),
    ).toEqual(["alpha", "beta"]);
    expect(f.typingMaxInFlight()).toBe(1);
  });

  it("cancels a queued semantic write without waiting for or bypassing its predecessor", async () => {
    const f = fixture({ semanticTextLaneGapMs: 0 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    let releaseGate!: () => void;
    f.gateTypeText(new Promise<void>((resolve) => (releaseGate = resolve)));
    const typeTexts = () => f.calls.filter((call) => call.name === "type_text");
    const first = f.backend.typeText("alpha", "cua:10:20", target);
    await vi.waitFor(() => expect(typeTexts()).toHaveLength(1));

    const controller = new AbortController();
    const second = withDesktopOperationSignal(controller.signal, () =>
      f.backend.typeText("cancelled", "cua:10:20", target),
    );
    const cancelled = expect(second).rejects.toThrow("Caller cancelled");
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("Caller cancelled"));
    await cancelled;
    expect(typeTexts()).toHaveLength(1);

    f.gateTypeText(undefined);
    releaseGate();
    await first;
    await expect(f.backend.typeText("beta", "cua:10:20", target)).resolves.toBeDefined();
    expect(typeTexts().map((call) => call.args?.text)).toEqual(["alpha", "beta"]);
    expect(f.typingMaxInFlight()).toBe(1);
  });

  it("semantic text lane holds the gap between consecutive writes", async () => {
    const f = fixture({ semanticTextLaneGapMs: 60 });
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const node = (await f.backend.getState({ windowId: "cua:10:20", includeTree: true })).root!
      .children[0]!;
    // Consecutive writes to the same exact element: the second cannot start
    // until the first's settle gap has elapsed.
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    const started = Date.now();
    await Promise.all([
      f.backend.typeText("alpha", "cua:10:20", target),
      f.backend.typeText("bravo", "cua:10:20", target),
    ]);
    expect(f.calls.filter((call) => call.name === "type_text")).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("keeps retained semantic text available after its exact window moves off-Space", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXTextField",
        label: "Message",
        frame: { x: -290, y: 30, width: 120, height: 20 },
        element_token: "message-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Message", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    f.setVisible(false);

    await expect(f.backend.typeText("hello", "cua:10:20", target)).resolves.toMatchObject({
      windowId: "cua:10:20",
    });
    expect(f.calls.findLast((call) => call.name === "type_text")?.args).toMatchObject({
      pid: 10,
      window_id: 20,
      text: "hello",
      element_token: "message-token",
      semantic_only: true,
    });
  });

  it("serves internal target resolution from a recent tree instead of walking again", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXButton",
        label: "Equals",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
      },
    ]);
    const observed = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    expect(f.calls.filter((c) => c.name === "get_window_state")).toHaveLength(1);

    const resolved = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
      reuseRecentTree: true,
    });
    expect(f.calls.filter((c) => c.name === "get_window_state")).toHaveLength(1);
    expect(resolved.root).toBe(observed.root);

    // The freshness requirement stands on the agent-facing path: a second
    // observation without the reuse flag still pays for the walk.
    await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    expect(f.calls.filter((c) => c.name === "get_window_state")).toHaveLength(2);
  });

  it("scopes the recent tree to its window and re-walks after it ages out", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXButton",
        label: "Equals",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
      },
    ]);
    await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    expect(f.calls.filter((c) => c.name === "get_window_state")).toHaveLength(1);

    // A window the cache never saw cannot borrow another window's tree: the
    // fresh identity check runs before any cached state is served.
    await expect(
      f.backend.getState({
        windowId: "cua:30:40",
        includeTree: true,
        reuseRecentTree: true,
      }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    expect(f.calls.filter((c) => c.name === "get_window_state")).toHaveLength(1);

    const now = vi.spyOn(Date, "now");
    try {
      let clock = Date.now();
      now.mockImplementation(() => clock);
      clock += 10_000;
      await f.backend.getState({
        windowId: "cua:10:20",
        includeTree: true,
        reuseRecentTree: true,
      });
      expect(f.calls.filter((c) => c.name === "get_window_state")).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });

  it("allows the bounded native permission request to finish without extending action deadlines", async () => {
    const requests: Array<{ method: string; timeoutMs: number | undefined }> = [];
    const request: typeof cuaRequest = async (_endpoint, request, options) => {
      requests.push({
        method: (request as { method: string }).method,
        timeoutMs: options?.timeoutMs,
      });
      return {
        ok: true,
        result: {
          structuredContent: { accessibility: false, screen_recording: false },
        },
      } as never;
    };
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request,
    });
    await backend.provision();
    expect(requests.find((request) => request.method === "setup")?.timeoutMs).toBe(
      CUA_SETUP_TIMEOUT_MS,
    );
    expect(
      requests
        .filter((request) => request.method === "call")
        .every((request) => request.timeoutMs === 35_000),
    ).toBe(true);
  });

  it("reports only the current missing permission and the responsible app", async () => {
    const f = fixture();
    f.denyScreenRecording();
    const availability = await f.backend.availability();
    expect(availability).toMatchObject({
      kind: "permission-required",
      missing: ["screenRecording"],
      bundleId: "com.synara.test",
    });
    expect(availability.kind === "permission-required" && availability.message).not.toContain(
      "Accessibility",
    );
    expect(await f.backend.provision()).toContain("Allow Screen Recording");
  });

  it("an explicit status refresh consumes a newly granted permission without waiting for the action cache", async () => {
    const f = fixture();
    f.denyPermissions();
    expect(await f.backend.availability()).toMatchObject({ kind: "permission-required" });
    f.grantPermissions();
    expect(await f.backend.availability()).toMatchObject({ kind: "permission-required" });
    expect(await f.backend.availability({ refresh: true })).toMatchObject({ kind: "available" });
  });

  it("does not reuse an in-flight permission denial for a grant-triggered status refresh", async () => {
    const f = fixture();
    f.denyPermissions();
    await f.backend.availability();
    const previousChecks = f.calls.filter((call) => call.name === "check_permissions").length;
    let release!: () => void;
    f.waitForPermission(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const old = f.backend.availability({ refresh: true });
    await vi.waitFor(() =>
      expect(f.calls.filter((call) => call.name === "check_permissions")).toHaveLength(
        previousChecks + 1,
      ),
    );
    const updated = f.backend.availability({ refresh: true });
    f.grantPermissions();
    release();
    expect(await old).toMatchObject({ kind: "permission-required" });
    expect(await updated).toMatchObject({ kind: "available" });
  });

  it("refreshes after a pre-setup check settles and reports granted permissions accurately", async () => {
    const f = fixture();
    f.denyPermissions();
    let release!: () => void;
    f.waitForPermission(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const previous = f.backend.availability();
    const provision = f.backend.provision();
    f.grantPermissions();
    release();
    await previous;
    expect(await provision).toContain("permissions are ready");
    expect(await f.backend.availability()).toMatchObject({ kind: "available" });
  });

  it("names Input Monitoring when the physical interruption listener lacks its grant", async () => {
    const f = fixture({ hostPlatform: "darwin" });
    f.setInputMonitor(false, false);
    const availability = await f.backend.availability();
    expect(availability).toMatchObject({
      kind: "permission-required",
      missing: ["inputMonitoring"],
      message: expect.stringContaining("Input Monitoring"),
    });
    expect(Schema.decodeUnknownSync(ComputerAvailability)(availability)).toEqual(availability);
    expect(await f.backend.provision()).toContain("Allow Input Monitoring");
  });

  it("reports a failed listener separately from permissions and recovers after it starts", async () => {
    const f = fixture({ hostPlatform: "darwin" });
    f.setInputMonitor(true, false);
    expect(await f.backend.availability()).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("Escape and human-input listener"),
    });
    expect(f.backend.health()).toMatchObject({ status: "unavailable", captureAvailable: true });
    expect(await f.backend.provision()).not.toContain("permissions are ready");
    f.setInputMonitor(true, true);
    expect(await f.backend.provision()).toContain("permissions are ready");
    expect(await f.backend.availability()).toMatchObject({ kind: "available" });
    expect(f.backend.health().status).toBe("connected");
  });

  it("does not impose macOS Input Monitoring on a remote Linux host", async () => {
    const f = fixture({ hostPlatform: "linux" });
    f.setInputMonitor(false, false);
    expect(await f.backend.availability()).toMatchObject({ kind: "available" });
  });

  it("recognizes native Linux display and AT-SPI prerequisites without inventing TCC grants", async () => {
    const f = fixture({ hostPlatform: "linux" });
    f.onTool("check_permissions", () => ({
      structuredContent: { atspi: true, x11: true, wayland: false, wayland_enabled: false },
    }));
    expect(await f.backend.availability()).toMatchObject({ kind: "available" });
    expect(await f.backend.missingPermissions()).toEqual([]);
    expect(f.backend.health().captureAvailable).toBe(true);
    expect(f.backend.capabilities()).toMatchObject({
      input: false,
      focus: false,
      raise: false,
      capture: true,
      windows: true,
    });
  });

  it("reports unavailable Wayland geometry without failing status or concealing it behind a live socket", async () => {
    const f = fixture({ hostPlatform: "linux" });
    f.onTool("check_permissions", () => ({
      structuredContent: { atspi: true, x11: false, wayland: true, wayland_enabled: true },
    }));
    f.onTool("get_screen_size", () => {
      throw new Error("$DISPLAY variable not set and no value was provided explicitly");
    });
    const unavailable = await f.backend.availability();
    expect(unavailable).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("$DISPLAY"),
    });
    expect(f.backend.health()).toMatchObject({ status: "unavailable", captureAvailable: false });
    const beforeProbe = f.calls.length;
    expect(await f.backend.probeAvailability()).toEqual(unavailable);
    expect(f.calls.slice(beforeProbe).some((call) => call.name === "get_screen_size")).toBe(false);
    await expect(f.backend.getScreenSize()).rejects.toThrow("$DISPLAY");
    f.onTool("get_screen_size", () => ({ structuredContent: { width: 1280, height: 800 } }));
    expect(await f.backend.availability()).toMatchObject({ kind: "available" });
    expect(await f.backend.getScreenSize()).toMatchObject({ width: 1280, height: 800 });
  });

  it("recovers Linux capture only after real pixels, not a compositor permission probe", async () => {
    const f = fixture({ hostPlatform: "linux" });
    f.onTool("check_permissions", () => ({
      structuredContent: { atspi: true, x11: true, wayland: false, wayland_enabled: false },
    }));
    await f.backend.availability();
    f.failOverview();
    await expect(f.backend.getState({ includeScreenshot: true })).rejects.toThrow("Capture denied");
    expect(f.backend.health().captureAvailable).toBe(false);
    await f.backend.provision();
    expect(f.backend.health().captureAvailable).toBe(false);
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
      consecutiveFailures: 0,
    });
  });

  it("re-probes a transient missing report before publishing availability", async () => {
    const f = fixture();
    f.denyPermissions();
    let release!: () => void;
    f.waitForPermission(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = f.backend.availability();
    // Park the first check_permissions on the gate long enough to have read
    // "missing", then flip to granted so the delayed re-probe sees the truth.
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.grantPermissions();
    release();
    expect(await pending).toMatchObject({ kind: "available" });
  });

  it("keeps re-probing until a delayed grant lands", async () => {
    const f = fixture();
    f.denyPermissions();
    const gates: Array<() => void> = [];
    const arm = () =>
      f.waitForPermission(
        new Promise<void>((resolve) => {
          gates.push(resolve);
        }),
      );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    arm();
    const pending = f.backend.availability();
    await tick();
    // Initial check reads missing; probe one reads missing too; the grant only
    // exists by probe two — matching the multi-second transient seen live.
    gates.shift()!();
    await tick();
    arm();
    await tick();
    gates.shift()!();
    await tick();
    arm();
    f.grantPermissions();
    await tick();
    gates.shift()!();
    expect(await pending).toMatchObject({ kind: "available" });
  });

  it("clears an old capture failure after explicit setup so recovery can be retried", async () => {
    const f = fixture();
    f.failOverview();
    await expect(f.backend.getState({ includeScreenshot: true })).rejects.toThrow("Capture denied");
    expect(f.backend.health().captureAvailable).toBe(false);
    await f.backend.provision();
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
    });
    // Readiness recovery does not itself capture the screen to prove pixels.
    expect(f.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(1);
  });
  it("marks scoped model state reads and never marks a pane still as a model observation", async () => {
    const f = fixture();
    try {
      await f.backend.captureScreenshot({
        kind: "window",
        windowId: "cua:10:20",
      });
      expect(f.calls.find((call) => call.name === "get_window_state")?.modelObservation).toBe(
        false,
      );
      await f.backend.focusWindow("cua:10:20");
      f.calls.length = 0;
      await withModelDesktopObservation(async () => {
        await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
        await f.backend.getState({ includeScreenshot: true });
        await f.backend.attachStream(() => undefined);
      });
      // The scoped read is the model's picture; the pane still of the same
      // window is a preview leg and stays unmarked.
      expect(
        f.calls
          .filter((call) => call.name === "get_window_state")
          .map((call) => call.modelObservation),
      ).toEqual([true, false]);
      // The unscoped read is the model's overview — and the only desktop
      // capture in the whole sequence.
      expect(
        f.calls
          .filter((call) => call.name === "get_desktop_state")
          .map((call) => call.modelObservation),
      ).toEqual([true]);
      expect(
        f.calls
          .filter((call) => !["get_window_state", "get_desktop_state"].includes(call.name ?? ""))
          .every((call) => call.modelObservation === undefined),
      ).toBe(true);
    } finally {
      await f.backend.dispose();
    }
  });
  it("invalidates old coordinate grounding when lock and resume occurred between requests", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.changeDesktop();
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_geometry",
    });
    expect(f.calls.some((call) => call.name === "click")).toBe(false);
    await withModelDesktopObservation(() =>
      f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
    );
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).resolves.toBeDefined();
  });
  it("rejects a delayed observation from before a known desktop interruption", async () => {
    const f = fixture();
    let finish!: () => void;
    f.delayOverview(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const observing = f.backend.getState({ includeScreenshot: true });
    const failure = expect(observing).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_desktop_epoch",
    });
    await vi.waitFor(() =>
      expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(true),
    );
    f.changeDesktop();
    await f.backend.checkInputReady("cua:10:20");
    finish();
    await failure;
  });
  it("checks exact native input readiness without capturing or dispatching input", async () => {
    const f = fixture();
    await expect(f.backend.checkInputReady("cua:10:20")).resolves.toBeUndefined();
    expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "check_input_ready"]);
    expect(f.calls[1]?.args).toEqual({ pid: 10, window_id: 20 });
    f.readiness({ ready: true, pid: 10, window_id: 21 });
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      code: "invalid_readiness",
      effect: "not-dispatched",
    });
    f.readiness({ ready: false });
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      code: "invalid_readiness",
    });
  });
  it("refreshes Linux readiness from exact visible window identity without a missing native tool", async () => {
    const f = fixture({ hostPlatform: "linux" });
    await expect(f.backend.checkInputReady("cua:10:20")).resolves.toBeUndefined();
    expect(f.calls.map((call) => call.name)).toEqual(["list_windows"]);
    f.setVisible(false);
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      code: "target_not_on_active_space",
      effect: "not-dispatched",
    });
    f.close();
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      code: "stale_target",
      effect: "not-dispatched",
    });
    expect(f.calls.every((call) => call.name === "list_windows")).toBe(true);
  });
  it("asks the driver to observe settle for the exact window without touching input", async () => {
    const f = fixture();
    f.onTool("wait_for_settle", (args) => ({
      structuredContent: {
        settled: true,
        waited_ms: 120,
        events_seen: 3,
        pid: args.pid,
        window_id: args.window_id,
        scope: "window",
      },
    }));
    await expect(
      f.backend.waitForSettle({
        windowId: "cua:10:20",
        timeoutMs: 5_000,
        quietMs: 1_000,
      }),
    ).resolves.toEqual({ settled: true, waitedMs: 120, eventsSeen: 3 });
    expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "wait_for_settle"]);
    expect(f.calls[1]?.args).toEqual({
      pid: 10,
      window_id: 20,
      timeout_ms: 5_000,
      quiet_ms: 1_000,
    });
  });
  it("clamps the settle bounds the driver caps, and refuses a malformed verdict", async () => {
    const f = fixture();
    f.onTool("wait_for_settle", () => ({
      structuredContent: { settled: false, waited_ms: 30_000, events_seen: 41 },
    }));
    await expect(
      f.backend.waitForSettle({
        windowId: "cua:10:20",
        timeoutMs: 999_999,
        quietMs: 999_999,
      }),
    ).resolves.toMatchObject({ settled: false, eventsSeen: 41 });
    expect(f.calls[1]?.args).toMatchObject({
      timeout_ms: 30_000,
      quiet_ms: 5_000,
    });
    f.onTool("wait_for_settle", () => ({
      structuredContent: { waited_ms: 5 },
    }));
    await expect(
      f.backend.waitForSettle({
        windowId: "cua:10:20",
        timeoutMs: 1_000,
        quietMs: 100,
      }),
    ).rejects.toMatchObject({
      code: "invalid_settle_read",
      effect: "not-dispatched",
    });
    f.onTool("wait_for_settle", () => ({
      isError: true,
      content: [{ type: "text", text: "Unknown tool: wait_for_settle" }],
    }));
    await expect(
      f.backend.waitForSettle({
        windowId: "cua:10:20",
        timeoutMs: 1_000,
        quietMs: 100,
      }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
  });
  it("pauses input on another Space while leaving observation available", async () => {
    const f = fixture();
    f.setVisible(false);
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "target_not_on_active_space",
      inputPause: { windowId: "cua:10:20" },
    });
    expect(f.calls.some((call) => isTyping(call.name))).toBe(false);
    await expect(f.backend.getState({ windowId: "cua:10:20" })).resolves.toMatchObject({
      computerId: "desktop",
    });
  });
  it("preserves a native off-Space refusal during read-only readiness", async () => {
    const f = fixture();
    f.readiness({
      ready: false,
      effect: "refused",
      code: "target_not_on_active_space",
      pid: 10,
      window_id: 20,
      reason: "The target is on another Space.",
    });
    await expect(f.backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "target_not_on_active_space",
      inputPause: {
        windowId: "cua:10:20",
        message: "The target is on another Space.",
      },
    });
    expect(f.calls.map((call) => call.name)).toEqual(["list_windows", "check_input_ready"]);
  });
  it("maps only proven native Space refusals to recoverable pause", async () => {
    const f = fixture();
    f.actionResult({
      effect: "refused",
      code: "target_not_on_active_space",
      message: "Target is on another Space.",
    });
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      inputPause: { windowId: "cua:10:20" },
    });
    f.fail(new CuaTransportError("Space changed after dispatch", "dispatched-unknown"));
    const error = await f.backend.typeText("abc", "cua:10:20").catch((error) => error);
    expect(error.effect).toBe("dispatched-unknown");
    expect(error.inputPause).toBeUndefined();
    expect(f.calls.filter((call) => isTyping(call.name))).toHaveLength(2);
  });
  it("rejects a drag if its prepared window moves before input admission", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.move();
    await expect(
      withDesktopDeliveryMode("foreground", () =>
        f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
      ),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_geometry",
    });
    expect(f.calls.some((call) => call.name === "drag")).toBe(false);
  });
  it("binds foreground drag pixels to the exact observed native bounds", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await withDesktopDeliveryMode("foreground", () =>
      f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
    );
    expect(f.calls.filter((call) => call.name === "drag")).toEqual([
      expect.objectContaining({
        args: {
          pid: 10,
          window_id: 20,
          delivery_mode: "foreground",
          from_x: 25,
          from_y: 10,
          to_x: 75,
          to_y: 30,
          coordinate_space: "window_points",
          duration_ms: 500,
          expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
        },
      }),
    ]);
  });
  it("preserves capture identity and rejects a different native window", async () => {
    const f = fixture();
    const image = await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    expect(Schema.decodeUnknownSync(ComputerScreenshot)(image)).toMatchObject({
      windowId: "cua:10:20",
    });
    expect(
      await f.backend.getState({
        windowId: "cua:10:20",
        includeScreenshot: true,
      }),
    ).toMatchObject({ screenshot: { windowId: "cua:10:20" } });
    f.captureWindow(21);
    await expect(
      f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    await expect(
      f.backend.getState({ windowId: "cua:10:20", includeTree: true }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    expect(f.calls.some((call) => call.name === "click")).toBe(false);
  });
  it("clears targeting after desktop pause and requires a fresh observation", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.pauseDesktop(true);
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "computer_input_paused",
      layer: "driver-host",
      inputPause: { windowId: "cua:10:20" },
    });
    f.pauseDesktop(false);
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      code: "stale_geometry",
    });
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).resolves.toBeDefined();
  });
  it("dispatches logical coordinate input without a preparation PNG", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.calls.length = 0;
    await f.backend.click({ x: -275, y: 30 }, "cua:10:20");
    await f.backend.scroll({ x: -275, y: 30 }, 0, 120, "cua:10:20");
    await withDesktopDeliveryMode("foreground", () =>
      f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
    );
    expect(f.calls.some((c) => c.name === "get_window_state")).toBe(false);
    for (const call of f.calls.filter((c) => ["click", "scroll", "drag"].includes(c.name ?? ""))) {
      expect(call.args).toMatchObject({
        pid: 10,
        window_id: 20,
        coordinate_space: "window_points",
        expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
      });
    }
  });
  it("permits advertised AXPress for plain clicks and preserves physical click gestures", async () => {
    const f = fixture();
    const point = { x: -275, y: 30 };
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    await f.backend.click(point, "cua:10:20");
    await f.backend.click(point, "cua:10:20", ["shift"]);
    await f.backend.doubleClick(point, "cua:10:20");
    await f.backend.tripleClick(point, "cua:10:20");
    await f.backend.rightClick(point, "cua:10:20");
    const clicks = f.calls.filter((call) => call.name === "click");
    expect(clicks).toHaveLength(5);
    expect(clicks[0]?.args).not.toHaveProperty("force_synthetic");
    for (const click of clicks.slice(1)) expect(click.args?.force_synthetic).toBe(true);
    expect(clicks[1]?.args).toMatchObject({ modifier: ["shift"] });
    expect(clicks[2]?.args).toMatchObject({ count: 2 });
    expect(clicks[3]?.args).toMatchObject({ count: 3 });
    expect(clicks[4]?.args).toMatchObject({ button: "right" });
  });
  it.each([0, 33, null])(
    "keeps plain clicks synthetic for older or unknown native revision %s",
    async (nativeRevision) => {
      const f = fixture({ nativeRevision });
      await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      await f.backend.click({ x: -275, y: 30 }, "cua:10:20");
      expect(f.calls.find((call) => call.name === "click")?.args).toMatchObject({
        force_synthetic: true,
      });
    },
  );
  it("carries safe actuator diagnostics for uncertain clicks without replaying", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    f.onTool("click", () => ({
      isError: true,
      structuredContent: {
        diagnostics: {
          delivery_path: "ax",
          actuator: "ax_press",
          error_code: "ax_dispatch_failed",
          ax_error: -25202,
          message: "private focused content",
          text: "private typed text",
        },
      },
    }));
    const failure = await f.backend.click({ x: -275, y: 30 }, "cua:10:20").catch((error) => error);
    expect(failure).toBeInstanceOf(CuaActionError);
    expect(failure).toMatchObject({
      code: "cua_action_failed",
      effect: "dispatched-unknown",
      diagnostics: {
        delivery_path: "ax",
        actuator: "ax_press",
        error_code: "ax_dispatch_failed",
        ax_error: -25202,
      },
    });
    expect(JSON.stringify(failure.diagnostics)).not.toContain("private");
    expect(f.calls.filter((call) => call.name === "click")).toHaveLength(1);
  });
  it("preserves an explicit not-dispatched error and retains usable observation geometry", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    f.onTool("click", () => ({
      isError: true,
      structuredContent: {
        effect: "not-dispatched",
        code: "ax_action_refused",
        diagnostics: { error_code: "ax_action_refused", delivery_path: "ax" },
      },
    }));
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "ax_action_refused",
    });
    f.onTool("click", () => ({ structuredContent: { effect: "unverifiable" } }));
    // Nothing was sent, so a corrected target may use the same observation.
    await expect(f.backend.click({ x: -270, y: 30 }, "cua:10:20")).resolves.toMatchObject({
      effect: "dispatched-unknown",
    });
    expect(f.calls.filter((call) => call.name === "click")).toHaveLength(2);
  });
  it.each(["dispatched-unknown", "unverifiable", "confirmed"])(
    "never downgrades explicit %s input to a legacy status refusal",
    async (effect) => {
      const f = fixture();
      f.onTool("press_key", () => ({
        isError: true,
        structuredContent: { effect, status: "refused", code: "ax_action_refused" },
      }));
      await expect(f.backend.pressKey("enter", "cua:10:20")).rejects.toMatchObject({
        effect: "dispatched-unknown",
      });
      expect(f.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
    },
  );
  it("keeps explicitly approved foreground text on the native foreground tool", async () => {
    const f = fixture();
    await withDesktopDeliveryMode("foreground", () => f.backend.typeText("abc", "cua:10:20"));
    expect(f.calls.find((call) => isTyping(call.name))).toMatchObject({
      name: "type_text",
      args: { delivery_mode: "foreground", force_synthetic: true },
    });
  });
  it("sends background hotkey by default and keeps approved foreground hotkey", async () => {
    const f = fixture();
    await f.backend.hotkey(["meta", "a"], "cua:10:20");
    expect(f.calls.find((call) => call.name === "hotkey")?.args).toMatchObject({
      delivery_mode: "background",
      keys: ["command", "a"],
    });
    f.calls.length = 0;
    await withDesktopDeliveryMode("foreground", () => f.backend.hotkey(["meta", "a"], "cua:10:20"));
    expect(f.calls.find((call) => call.name === "hotkey")?.args).toMatchObject({
      delivery_mode: "foreground",
      keys: ["command", "a"],
    });
  });
  it("keeps moveCursor as background overlay-only and unverifiable", async () => {
    const f = fixture();
    const result = await withDesktopDeliveryMode("background", () =>
      f.backend.moveCursor({ x: 10, y: 20 }, "cua:10:20"),
    );
    expect(result).toMatchObject({
      point: { x: 10, y: 20 },
      deliveryPath: "cua-overlay-only",
      verified: "unverifiable",
    });
    expect(f.calls.find((call) => call.name === "move_cursor")?.args).toEqual({
      x: 10,
      y: 20,
    });
  });
  it("launches by name or bundle id without a delivery mode", async () => {
    const f = fixture();
    await expect(f.backend.launchApp("Calculator")).resolves.toMatchObject({
      app: "Calculator",
      window: null,
    });
    expect(f.calls.find((call) => call.name === "launch_app")?.args).toEqual({
      name: "Calculator",
    });
    // The launch goes through the driver's background `launch_app` only —
    // never an activation tool that would make the app frontmost.
    expect(
      f.calls.filter((call) => call.name === "bring_to_front" || call.name === "activate"),
    ).toHaveLength(0);
    f.calls.length = 0;
    await expect(
      f.backend.launchApp("com.apple.Calculator", ["--new-window"]),
    ).resolves.toMatchObject({ app: "com.apple.Calculator", window: null });
    expect(f.calls.find((call) => call.name === "launch_app")?.args).toEqual({
      bundle_id: "com.apple.Calculator",
      additional_arguments: ["--new-window"],
    });
    await expect(f.backend.launchApp("/Applications/Calculator.app")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "unsupported_operation",
    });
  });

  it("preserves native launch readiness failures instead of polling a hidden window again", async () => {
    const f = fixture();
    f.onTool("launch_app", () => ({
      structuredContent: {
        pid: 321,
        window_status: "no_usable_window",
        window_reason: "hidden",
      },
    }));
    await expect(f.backend.launchApp("TextEdit")).resolves.toMatchObject({
      pid: 321,
      window: null,
      windowStatus: "no_usable_window",
      windowReason: "hidden",
    });
  });

  it("pauses after focus restoration failure without laundering uncertain delivery", async () => {
    const f = fixture();
    f.onTool("press_key", () => ({
      isError: true,
      structuredContent: {
        effect: "unverifiable",
        code: "focus_restore_failed",
        diagnostics: {
          focus_mutation: "without_raise",
          restore_status: "unobservable",
          error_code: "focus_restore_failed",
        },
      },
    }));
    await expect(f.backend.pressKey("enter", "cua:10:20")).rejects.toMatchObject({
      code: "focus_restore_failed",
      effect: "dispatched-unknown",
      inputPause: { windowId: "cua:10:20", pid: 10 },
      diagnostics: { restore_status: "unobservable" },
    });
    expect(f.calls.filter((c) => c.name === "press_key")).toHaveLength(1);
  });
  it("preserves bounded cooldown hints and scopes native pause recovery to the app", async () => {
    const f = fixture();
    f.onTool("press_key", () => ({
      isError: true,
      structuredContent: {
        effect: "refused",
        code: "computer_input_paused",
        layer: "driver-host",
        wait_seconds: 0.75,
      },
    }));
    await expect(f.backend.pressKey("enter", "cua:10:20")).rejects.toMatchObject({
      code: "computer_input_paused",
      waitSeconds: 0.75,
      inputPause: { windowId: "cua:10:20", pid: 10 },
      effect: "not-dispatched",
    });
  });
  it("preserves the launched process identity without claiming window readiness", async () => {
    const f = fixture();
    f.onTool("launch_app", () => ({
      structuredContent: { pid: 10, launch_state: { process_running: true, window_ready: false } },
    }));
    expect(await f.backend.launchApp("com.apple.Calculator")).toMatchObject({
      pid: 10,
      window: null,
      windowStatus: "not_checked",
    });
  });
  it("uses the Linux launch schema after discovering a remote host's platform", async () => {
    const request = vi.fn(async (_endpoint: string, _request: unknown) => ({
      ok: true,
      hostPlatform: "linux",
      driverNativeRevision: 0,
      result: { structuredContent: {} },
    }));
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request: request as unknown as typeof cuaRequest,
    });
    await backend.launchApp("/usr/bin/gnome-calculator", ["--mode=basic"], { hidden: false });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "probe" });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      name: "launch_app",
      args: { launch_path: "/usr/bin/gnome-calculator", additional_arguments: ["--mode=basic"] },
    });
    await backend.launchApp("org.gnome.Calculator.desktop", [], { hidden: false });
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      name: "launch_app",
      args: { name: "org.gnome.Calculator.desktop" },
    });
    expect(
      (request.mock.calls.at(-1)?.[1] as { args: Record<string, unknown> }).args,
    ).not.toHaveProperty("hidden");
    expect(
      request.mock.calls.filter(([, call]) => (call as { method: string }).method === "probe"),
    ).toHaveLength(1);
  });
  it("refuses unsupported Linux hidden launches and ambiguous executable paths before dispatch", async () => {
    const request = vi.fn(async (_endpoint: string, _request: unknown) => ({
      ok: true,
      hostPlatform: "linux",
      driverNativeRevision: 0,
    }));
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request: request as unknown as typeof cuaRequest,
    });
    for (const options of [undefined, { hidden: true }]) {
      await expect(backend.launchApp("org.gnome.Calculator", [], options)).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "unsupported_operation",
      });
    }
    await expect(
      backend.launchApp("/opt/My App/bin/calculator", [], { hidden: false }),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "probe" });
  });
  it("lists apps with pid, name, bundle id, running and active state", async () => {
    const f = fixture();
    f.onTool("list_apps", () => ({
      structuredContent: {
        apps: [
          {
            pid: 42,
            name: "TextEdit",
            bundle_id: "com.apple.TextEdit",
            active: true,
            running: true,
            launch_path: "/System/Applications/TextEdit.app",
            windows: [{}, {}],
            last_used: "2026-09-17T00:00:00Z",
          },
          { pid: 43, name: "NoBundle", active: false, running: true },
          // Installed but not running: pid 0 is the "is X installed?" row the
          // tool exists for, so it must survive rather than be filtered out.
          {
            pid: 0,
            name: "Chess",
            bundle_id: "com.apple.Chess",
            running: false,
            active: false,
            launch_path: "/System/Applications/Chess.app",
          },
          { pid: -1, name: "bogus" },
          { pid: 44 },
        ],
      },
    }));
    await expect(f.backend.listApps!()).resolves.toEqual([
      {
        pid: 42,
        name: "TextEdit",
        bundleId: "com.apple.TextEdit",
        active: true,
        running: true,
        launchPath: "/System/Applications/TextEdit.app",
        windowCount: 2,
        lastUsed: "2026-09-17T00:00:00Z",
      },
      { pid: 43, name: "NoBundle", active: false, running: true },
      {
        pid: 0,
        name: "Chess",
        bundleId: "com.apple.Chess",
        running: false,
        active: false,
        launchPath: "/System/Applications/Chess.app",
      },
    ]);
  });
  it("verifies a moved window through an independent list_windows readback", async () => {
    const f = fixture();
    // The driver claims the move landed — but Synara only reports verified
    // once its own list_windows re-read shows the requested frame.
    f.onTool("set_window_frame", (args) => {
      f.setBounds({
        x: Number(args.x),
        y: Number(args.y),
        width: Number(args.width),
        height: Number(args.height),
      });
      return {
        structuredContent: {
          effect: "confirmed",
          route: "ax_window_frame",
          delivery: { mode: "background" },
          evidence: [{ kind: "value_readback" }],
        },
      };
    });
    await expect(
      f.backend.setWindowFrame!("cua:10:20", {
        x: 0,
        y: 0,
        width: 640,
        height: 480,
      }),
    ).resolves.toMatchObject({
      windowId: "cua:10:20",
      verified: "confirmed",
      effect: "verified",
    });
    expect(f.calls.find((call) => call.name === "set_window_frame")?.args).toEqual({
      pid: 10,
      window_id: 20,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
    // The driver reports its own readback confirmed, but the independent
    // window list disagrees — the mutation is reported unknown, never
    // silently promoted to verified on the driver's word alone.
    f.setBounds({ x: -300, y: 20, width: 200, height: 100 });
    f.onTool("set_window_frame", () => ({
      structuredContent: {
        effect: "confirmed",
        route: "ax_window_frame",
        evidence: [{ kind: "value_readback" }],
      },
    }));
    await expect(
      f.backend.setWindowFrame!("cua:10:20", {
        x: 0,
        y: 0,
        width: 640,
        height: 480,
      }),
    ).resolves.toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
  });
  it("invokes a menu path and preserves the status-coded refusal dialect", async () => {
    const f = fixture();
    f.onTool("invoke_menu", () => ({
      structuredContent: {
        effect: "unverifiable",
        route: "ax_action",
        delivery: { mode: "foreground" },
      },
    }));
    await expect(
      f.backend.invokeMenu!({ windowId: "cua:10:20" }, ["File", "Save"]),
    ).resolves.toMatchObject({
      windowId: "cua:10:20",
      verified: "unverifiable",
      effect: "dispatched-unknown",
    });
    expect(f.calls.find((call) => call.name === "invoke_menu")?.args).toEqual({
      pid: 10,
      window_id: 20,
      path: ["File", "Save"],
    });
    f.onTool("invoke_menu", () => ({
      isError: true,
      structuredContent: {
        status: "refused",
        refusal: {
          code: "menu_path_unavailable",
          message: "The menu item is disabled.",
        },
      },
      content: [{ type: "text", text: "The menu item is disabled." }],
    }));
    await expect(
      f.backend.invokeMenu!({ windowId: "cua:10:20" }, ["Edit", "Undo"]),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "menu_path_unavailable",
    });
  });
  it("invokes the application-level menu on a windowless app with no window id", async () => {
    const f = fixture();
    f.onTool("invoke_menu", () => ({
      structuredContent: {
        effect: "confirmed",
        route: "ax_menu_bar",
        delivery: { mode: "background" },
      },
    }));
    await expect(f.backend.invokeMenu!({ pid: 44 }, ["File", "New Window"])).resolves.toMatchObject(
      {
        verified: "confirmed",
        effect: "verified",
      },
    );
    const call = f.calls.find((entry) => entry.name === "invoke_menu");
    // The driver's windowless contract: pid and path, and no window_id to
    // misread as an exact-window request.
    expect(call?.args).toEqual({ pid: 44, path: ["File", "New Window"] });
    // No window took part, so the result must not fabricate one.
    const result = await f.backend.invokeMenu!({ pid: 44 }, ["File", "New Window"]);
    expect(result).not.toHaveProperty("windowId");
    // The pid form fails closed on a malformed pid before any dispatch.
    await expect(f.backend.invokeMenu!({ pid: 0 }, ["File"])).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  });
  it("verifies window state from the driver's per-predicate outcome", async () => {
    const f = fixture();
    const predicates = [
      {
        index: 0,
        status: "satisfied",
        unknown_reason: null,
        observed_json: "{}",
      },
    ];
    f.onTool("verify_state", () => ({
      structuredContent: {
        status: "satisfied",
        stable: true,
        samples: 2,
        predicates,
      },
    }));
    await expect(
      f.backend.verifyState!("cua:10:20", [
        { element: { selector: { role: "AXButton" }, exists: true } },
      ]),
    ).resolves.toEqual({
      status: "satisfied",
      stable: true,
      samples: 2,
      elapsedMs: 0,
      predicates,
    });
    expect(f.calls.find((call) => call.name === "verify_state")?.args).toEqual({
      pid: 10,
      window_id: 20,
      expect: [{ element: { selector: { role: "AXButton" }, exists: true } }],
    });
    f.onTool("verify_state", () => ({
      structuredContent: {
        status: "unsatisfied",
        stable: true,
        samples: 1,
        predicates: [
          {
            index: 0,
            status: "unsatisfied",
            unknown_reason: null,
            observed_json: "{}",
          },
        ],
      },
    }));
    await expect(
      f.backend.verifyState!("cua:10:20", [{ window: { bounds: { x: 0 } } }]),
    ).resolves.toMatchObject({ status: "unsatisfied", stable: true });
    // An unparseable status is "unknown", never collapsed to unsatisfied.
    f.onTool("verify_state", () => ({
      structuredContent: { status: "weird" },
    }));
    await expect(
      f.backend.verifyState!("cua:10:20", [{ window: { bounds: { x: 0 } } }]),
    ).resolves.toMatchObject({ status: "unknown" });
  });
  it("captures a zoom region in window-local points scaled to pixels", async () => {
    const f = fixture();
    f.onTool("zoom", () => ({
      structuredContent: { width: 168, height: 140, mime_type: "image/jpeg" },
      content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" }],
    }));
    const zoom = await f.backend.zoomWindow!("cua:10:20", {
      x: 10,
      y: 20,
      width: 50,
      height: 50,
    });
    expect(zoom).toMatchObject({
      mimeType: "image/jpeg",
      width: 168,
      height: 140,
      windowId: "cua:10:20",
      bytesBase64: "/9j/4AAQ",
    });
    // scale_factor 2 in the fixture: window-local points become screenshot px.
    expect(f.calls.find((call) => call.name === "zoom")?.args).toEqual({
      pid: 10,
      window_id: 20,
      x1: 20,
      y1: 40,
      x2: 120,
      y2: 140,
    });
    await expect(
      f.backend.zoomWindow!("cua:10:20", {
        x: 150,
        y: 0,
        width: 100,
        height: 50,
      }),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "invalid_geometry",
    });
  });
  it("reports a killed app verified only once it leaves the app list", async () => {
    const f = fixture();
    let apps: Array<Record<string, unknown>> = [
      {
        pid: 10,
        name: "TextEdit",
        bundle_id: "com.apple.TextEdit",
        active: true,
      },
    ];
    f.onTool("list_apps", () => ({ structuredContent: { apps } }));
    f.onTool("kill_app", () => {
      apps = [];
      return { content: [{ type: "text", text: "Sent SIGKILL to pid 10." }] };
    });
    await expect(f.backend.killApp!(10)).resolves.toMatchObject({
      verified: "confirmed",
      effect: "verified",
    });
    expect(f.calls.find((call) => call.name === "kill_app")?.args).toEqual({
      pid: 10,
    });
    f.onTool("kill_app", () => ({
      content: [{ type: "text", text: "Sent SIGKILL to pid 10." }],
    }));
    apps = [{ pid: 10, name: "TextEdit", active: true }];
    await expect(f.backend.killApp!(10)).resolves.toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
  });
  it("sends the hidden launch flag only when the caller asks for it", async () => {
    const f = fixture();
    await f.backend.launchApp("TextEdit", [], { hidden: true });
    expect(f.calls.find((call) => call.name === "launch_app")?.args).toEqual({
      name: "TextEdit",
      hidden: true,
    });
    f.calls.length = 0;
    // Absent or false is the ordinary background launch — no flag on the wire.
    await f.backend.launchApp("TextEdit", [], { hidden: false });
    expect(f.calls.find((call) => call.name === "launch_app")?.args).toEqual({
      name: "TextEdit",
    });
    f.calls.length = 0;
    await f.backend.launchApp("TextEdit");
    expect(f.calls.find((call) => call.name === "launch_app")?.args).toEqual({
      name: "TextEdit",
    });
  });
  it("minimizes the exact window and trusts only the driver's readback evidence", async () => {
    const f = fixture();
    f.onTool("set_window_minimized", () => ({
      structuredContent: {
        effect: "confirmed",
        route: "ax_window_minimized",
        delivery: { mode: "background" },
        evidence: [{ kind: "value_readback" }],
      },
    }));
    await expect(f.backend.setWindowMinimized!("cua:10:20", true)).resolves.toMatchObject({
      windowId: "cua:10:20",
      verified: "confirmed",
      effect: "verified",
    });
    expect(f.calls.find((call) => call.name === "set_window_minimized")?.args).toEqual({
      pid: 10,
      window_id: 20,
      minimized: true,
    });
    // The same bare confirmed claim without the readback row is not evidence.
    f.onTool("set_window_minimized", () => ({
      structuredContent: { effect: "confirmed", route: "ax_window_minimized" },
    }));
    await expect(f.backend.setWindowMinimized!("cua:10:20", true)).resolves.toMatchObject({
      verified: "unverifiable",
      effect: "dispatched-unknown",
    });
    f.onTool("set_window_minimized", () => ({
      structuredContent: { effect: "unconfirmed" },
    }));
    await expect(f.backend.setWindowMinimized!("cua:10:20", false)).resolves.toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
  });
  it("hides and unhides an app by pid on the driver's own readback", async () => {
    const f = fixture();
    f.onTool("set_app_visibility", () => ({
      structuredContent: {
        effect: "confirmed",
        route: "ax_app_visibility",
        delivery: { mode: "background" },
        evidence: [{ kind: "value_readback" }],
      },
    }));
    await expect(f.backend.setAppVisibility!(10, true)).resolves.toMatchObject({
      verified: "confirmed",
      effect: "verified",
    });
    expect(f.calls.find((call) => call.name === "set_app_visibility")?.args).toEqual({
      pid: 10,
      hidden: true,
    });
    f.onTool("set_app_visibility", () => ({
      structuredContent: { effect: "suspected_noop" },
    }));
    await expect(f.backend.setAppVisibility!(10, false)).resolves.toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
    // A target that is not a live pid, or a flag that is not a boolean, fails
    // closed before the driver is ever asked.
    await expect(f.backend.setAppVisibility!(0, true)).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "invalid_arguments",
    });
    await expect(
      f.backend.setAppVisibility!(10, "yes" as unknown as boolean),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "invalid_arguments",
    });
    expect(f.calls.filter((call) => call.name === "set_app_visibility")).toHaveLength(2);
  });
  it("reads the desktop inventory and scopes it to the scoped window's app", async () => {
    const f = fixture();
    f.onTool("get_accessibility_tree", () => ({
      structuredContent: {
        apps: [
          { pid: 10, name: "TextEdit", bundle_id: "com.apple.TextEdit" },
          { pid: 20, name: "Finder" },
          { pid: -3, name: "bogus" },
          { pid: 30 },
        ],
        windows: [
          {
            window_id: 20,
            pid: 10,
            app_name: "TextEdit",
            title: "Untitled",
            bounds: { x: -300, y: 20, width: 200, height: 100 },
            is_on_screen: true,
            z_index: 0,
          },
          {
            window_id: 21,
            pid: 10,
            app_name: "TextEdit",
            title: "Second",
            is_on_screen: false,
          },
          { window_id: 40, pid: 20, app_name: "Finder", title: "" },
          { window_id: 0, pid: 10, title: "bogus" },
        ],
      },
    }));
    await expect(f.backend.getAccessibilityTree!()).resolves.toEqual({
      apps: [
        { pid: 10, name: "TextEdit", bundleId: "com.apple.TextEdit" },
        { pid: 20, name: "Finder" },
      ],
      windows: [
        {
          id: "cua:10:20",
          pid: 10,
          appName: "TextEdit",
          title: "Untitled",
          bounds: { x: -300, y: 20, width: 200, height: 100 },
          onScreen: true,
          zIndex: 0,
        },
        {
          id: "cua:10:21",
          pid: 10,
          appName: "TextEdit",
          title: "Second",
          onScreen: false,
        },
        { id: "cua:20:40", pid: 20, appName: "Finder", title: "" },
      ],
      truncated: false,
    });
    // The driver call is argument-free: window scoping is Synara-side, to the
    // app that owns the exact window resolved through list_windows.
    await expect(f.backend.getAccessibilityTree!("cua:10:20")).resolves.toEqual({
      apps: [{ pid: 10, name: "TextEdit", bundleId: "com.apple.TextEdit" }],
      windows: [
        {
          id: "cua:10:20",
          pid: 10,
          appName: "TextEdit",
          title: "Untitled",
          bounds: { x: -300, y: 20, width: 200, height: 100 },
          onScreen: true,
          zIndex: 0,
        },
        {
          id: "cua:10:21",
          pid: 10,
          appName: "TextEdit",
          title: "Second",
          onScreen: false,
        },
      ],
      truncated: false,
    });
    expect(f.calls.find((call) => call.name === "get_accessibility_tree")?.args).toEqual({});
  });
  it("caps the inventory rows and refuses a malformed snapshot", async () => {
    const f = fixture();
    const manyWindows = Array.from({ length: 600 }, (_, i) => ({
      window_id: i + 1,
      pid: 10,
      app_name: "TextEdit",
      title: `w${i}`,
    }));
    f.onTool("get_accessibility_tree", () => ({
      structuredContent: {
        apps: [{ pid: 10, name: "TextEdit" }],
        windows: manyWindows,
      },
    }));
    const capped = await f.backend.getAccessibilityTree!();
    expect(capped.windows).toHaveLength(512);
    expect(capped.truncated).toBe(true);
    // A snapshot without the row arrays is a malformed driver response, not an
    // empty desktop — fail closed rather than report nothing.
    f.onTool("get_accessibility_tree", () => ({
      structuredContent: { windows: [] },
    }));
    await expect(f.backend.getAccessibilityTree!()).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "invalid_response",
    });
    // A scoped read for a dead window refuses before the driver is asked.
    f.onTool("get_accessibility_tree", () => ({
      structuredContent: { apps: [], windows: [] },
    }));
    await expect(f.backend.getAccessibilityTree!("cua:999:1")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_target",
    });
  });
  it("reads the cursor position in desktop points and reports window containment", async () => {
    const f = fixture();
    f.onTool("get_cursor_position", () => ({
      structuredContent: { x: -200, y: 60 },
    }));
    await expect(f.backend.getCursorPosition!()).resolves.toEqual({
      x: -200,
      y: 60,
      capturedAt: expect.any(String),
    });
    // The fixture window spans x -300..-100, y 20..120: (-200, 60) is inside.
    await expect(f.backend.getCursorPosition!("cua:10:20")).resolves.toMatchObject({
      x: -200,
      y: 60,
      windowId: "cua:10:20",
      insideWindow: true,
    });
    f.onTool("get_cursor_position", () => ({
      structuredContent: { x: 50, y: 60 },
    }));
    await expect(f.backend.getCursorPosition!("cua:10:20")).resolves.toMatchObject({
      insideWindow: false,
    });
    f.onTool("get_cursor_position", () => ({
      structuredContent: { x: "left", y: 60 },
    }));
    await expect(f.backend.getCursorPosition!()).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "invalid_response",
    });
    expect(f.calls.find((call) => call.name === "get_cursor_position")?.args).toEqual({});
  });
  it("reads the published action route and requires public verification evidence", async () => {
    const f = fixture();
    f.actionResult({
      route: "accessibility",
      delivery: { mode: "background" },
      effect: "confirmed",
    });
    expect(await f.backend.typeText("abc", "cua:10:20")).toMatchObject({
      effect: "dispatched-unknown",
      deliveryPath: "cua-accessibility-background",
    });
    f.actionResult({
      route: "accessibility",
      delivery: { mode: "background" },
      effect: "confirmed",
      evidence: [{ kind: "value_readback" }],
    });
    expect(await f.backend.typeText("def", "cua:10:20")).toMatchObject({
      effect: "verified",
      verified: "confirmed",
    });
  });
  it("preserves public action refusals even without the outer error flag", async () => {
    const f = fixture();
    f.actionResult({ route: "accessibility", effect: "refused" });
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
  });
  it("preserves status refusals and gives a semantic recovery route for keyboard ambiguity", async () => {
    const f = fixture();
    f.onTool("press_key", () => ({
      structuredContent: {
        status: "refused",
        refusal: { code: "same_pid_keyboard_ambiguity" },
      },
    }));
    const failure = await f.backend.pressKey("enter", "cua:10:20").catch((error) => error);
    expect(failure).toMatchObject({
      effect: "not-dispatched",
      code: "same_pid_keyboard_ambiguity",
    });
    expect(failure.message).toContain("computer_type_text with an observed ref");
    expect(failure.message).toContain("do not send keydown/keyup");
    expect(f.calls.filter((call) => call.name === "press_key")).toHaveLength(1);
  });
  it("encodes missing grants with the public permission schema", async () => {
    const f = fixture();
    f.denyPermissions();
    const availability = await f.backend.availability();
    expect(Schema.decodeUnknownSync(ComputerAvailability)(availability)).toMatchObject({
      kind: "permission-required",
      missing: ["accessibility", "screenRecording"],
    });
  });
  it("ignores non-actionable zero-area windows", async () => {
    const f = fixture();
    expect(await f.backend.listWindows()).toHaveLength(1);
  });
  it("reports minimized and hidden workspace windows honestly", async () => {
    const f = fixture();
    const rect = { x: 10, y: 10, width: 200, height: 100 };
    f.setWindows([
      {
        pid: 10,
        window_id: 21,
        title: "Minimized",
        bounds: rect,
        is_on_screen: false,
        on_current_space: true,
        space_ids: [3],
        z_index: 2,
      },
      {
        pid: 11,
        window_id: 22,
        title: "Hidden app window",
        bounds: rect,
        is_on_screen: false,
        on_current_space: null,
        space_ids: null,
        z_index: 3,
      },
    ]);
    const windows = await f.backend.listWindows();
    const byId = new Map(windows.map((w) => [w.id, w]));
    // Minimized: off the screen list but still claimed by its Space.
    expect(byId.get("cua:10:21")).toMatchObject({
      minimized: true,
      visible: false,
    });
    // Hidden-app windows are detached from every Space — not minimized, but
    // still listed so the hidden workspace remains targetable.
    expect(byId.get("cua:11:22")).toMatchObject({
      minimized: false,
      visible: false,
    });
  });
  it("preserves observed Space membership without inventing missing or unsafe identifiers", async () => {
    const f = fixture();
    const base = {
      pid: 10,
      bounds: { x: 10, y: 10, width: 200, height: 100 },
      is_on_screen: false,
    };
    f.setWindows([
      { ...base, window_id: 21, space_ids: [3, 8], current_space_id: 8, on_current_space: true },
      { ...base, window_id: 22, space_ids: [3], current_space_id: 8, on_current_space: false },
      { ...base, window_id: 23, space_ids: null, current_space_id: null, on_current_space: null },
      { ...base, window_id: 24, space_ids: [3, Number.MAX_SAFE_INTEGER + 1], current_space_id: 0 },
      { ...base, window_id: 25, space_ids: [], current_space_id: 8, on_current_space: false },
    ]);
    const byId = new Map((await f.backend.listWindows()).map((window) => [window.id, window]));
    expect(byId.get("cua:10:21")).toMatchObject({
      spaceIds: [3, 8],
      currentSpaceId: 8,
      onCurrentSpace: true,
    });
    expect(byId.get("cua:10:22")).toMatchObject({
      spaceIds: [3],
      currentSpaceId: 8,
      onCurrentSpace: false,
    });
    for (const window of [byId.get("cua:10:23"), byId.get("cua:10:24")]) {
      expect(window).not.toHaveProperty("spaceIds");
      expect(window).not.toHaveProperty("currentSpaceId");
      expect(window).not.toHaveProperty("onCurrentSpace");
    }
    expect(byId.get("cua:10:25")).toMatchObject({
      spaceIds: [],
      currentSpaceId: 8,
      onCurrentSpace: false,
    });
  });
  it("distinguishes a native admission refusal from an uncertain delivery", async () => {
    const f = fixture();
    f.refuse();
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "same_pid_keyboard_ambiguity",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
  });
  it("translates DOM key names without turning Delete into Backspace", async () => {
    const f = fixture();
    await f.backend.pressKey("Delete", "cua:10:20");
    await f.backend.hotkey(["meta", "arrowleft"], "cua:10:20");
    expect(f.calls.find((c) => c.name === "press_key")?.args).toMatchObject({
      key: "forward_delete",
    });
    expect(f.calls.find((c) => c.name === "hotkey")?.args).toMatchObject({
      keys: ["command", "left"],
    });
    expect(() => f.backend.hotkey(["meta", "a", "s"], "cua:10:20")).toThrow("exactly one");
  });
  it("maps xdotool-style key spellings onto driver keynames", async () => {
    const f = fixture();
    const mapped: Array<readonly [string, string]> = [
      ["Page_Up", "pageup"],
      ["Prior", "pageup"],
      ["pgup", "pageup"],
      ["Page_Down", "pagedown"],
      ["Next", "pagedown"],
      ["pgdn", "pagedown"],
      ["Caps_Lock", "capslock"],
      ["Super_L", "command"],
      ["Win", "command"],
      ["Shift_L", "shift"],
      ["Control_L", "ctrl"],
      ["Alt_L", "alt"],
      ["Option_L", "alt"],
    ];
    for (const [name, driver] of mapped) {
      f.calls.length = 0;
      await f.backend.pressKey(name, "cua:10:20");
      expect(f.calls.find((c) => c.name === "press_key")?.args).toMatchObject({
        key: driver,
      });
    }
    // Names the pinned keymap lacks pass through untouched so the driver's own
    // "Unknown key name" refusal stays the gate until the keymap revision
    // lands them (native-keymap.diff: kp_*, f13-f20, menu, help).
    for (const name of ["kp_5", "KP_Enter", "F13", "Menu", "Help", "Shift_R"]) {
      f.calls.length = 0;
      await f.backend.pressKey(name, "cua:10:20");
      expect(f.calls.find((c) => c.name === "press_key")?.args).toMatchObject({
        key: name.toLowerCase(),
      });
    }
    f.calls.length = 0;
    await f.backend.hotkey(["meta", "Page_Up"], "cua:10:20");
    expect(f.calls.find((c) => c.name === "hotkey")?.args).toMatchObject({
      keys: ["command", "pageup"],
    });
    f.calls.length = 0;
    await f.backend.hotkey(["Control_L", "c"], "cua:10:20");
    expect(f.calls.find((c) => c.name === "hotkey")?.args).toMatchObject({
      keys: ["ctrl", "c"],
    });
  });
  it("refuses Insert spellings and still refuses modifier-only chords", async () => {
    const f = fixture();
    for (const name of ["insert", "Insert", "ins"])
      expect(() => f.backend.pressKey(name, "cua:10:20")).toThrow("no Insert key mapping");
    expect(() => f.backend.hotkey(["meta", "ins"], "cua:10:20")).toThrow("no Insert key mapping");
    // A chord of nothing but modifiers still has no base key, whether the
    // modifier arrives under a driver or a left-side spelling.
    expect(() => f.backend.hotkey(["meta", "shift"], "cua:10:20")).toThrow("exactly one");
    expect(() => f.backend.hotkey(["meta", "shift_l"], "cua:10:20")).toThrow("exactly one");
    expect(f.calls.filter((c) => c.name === "press_key" || c.name === "hotkey")).toHaveLength(0);
  });
  it("converts pixel deltas to one bounded wheel operation", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    const result = await f.backend.scroll({ x: -275, y: 30 }, 0, 250, "cua:10:20");
    expect(result.scrollDelta).toEqual({ deltaX: 0, deltaY: 240 });
    expect(f.calls.filter((c) => c.name === "scroll")).toHaveLength(1);
    expect(f.calls.find((c) => c.name === "scroll")?.args).toMatchObject({
      delta_x: 0,
      delta_y: -2,
      direction: "down",
    });
  });
  it("carries both axes and modifiers in one wheel gesture", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    const result = await f.backend.scroll({ x: -275, y: 30 }, -140, 250, "cua:10:20", [
      "meta",
      "shift",
    ]);
    expect(result.scrollDelta).toEqual({ deltaX: -120, deltaY: 240 });
    expect(f.calls.filter((c) => c.name === "scroll")).toHaveLength(1);
    expect(f.calls.find((c) => c.name === "scroll")?.args).toMatchObject({
      delta_x: 1,
      delta_y: -2,
      direction: "down",
      modifiers: ["command", "shift"],
    });
  });
  it("refuses a single axis beyond the 50-notch bound before dispatch", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await expect(
      f.backend.scroll({ x: -275, y: 30 }, 0, 61 * 120, "cua:10:20"),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "unsupported_operation",
    });
    await expect(
      f.backend.scroll({ x: -275, y: 30 }, 61 * 120, 0, "cua:10:20"),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "unsupported_operation",
    });
    expect(f.calls.filter((c) => c.name === "scroll")).toHaveLength(0);
  });
  it("prefers the AX scroll-bar route for an unmodified vertical element scroll", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXScrollArea",
        label: "Content",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "scroll-token",
      },
    ]);
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
    });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Content", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    // The point path is geometry-gated: a wheel scroll at a point still needs
    // a fresh observation of the window it lands in.
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await f.backend.scroll(target.point, 0, 250, "cua:10:20", undefined, target);
    expect(f.calls.find((c) => c.name === "scroll")?.args).toMatchObject({
      element_token: "scroll-token",
      direction: "down",
      amount: 2,
      by: "line",
    });
    // A horizontal or modified request cannot ride the vertical AX rung.
    await f.backend.scroll(target.point, -140, 250, "cua:10:20", undefined, target);
    expect(f.calls.filter((c) => c.name === "scroll")[1]?.args).toMatchObject({
      delta_x: 1,
      delta_y: -2,
    });
    expect(f.calls.filter((c) => c.name === "scroll")[1]?.args).not.toHaveProperty("element_token");
  });
  it("coalesces physical state across concurrent thread projections", async () => {
    const f = fixture();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        Promise.all([f.backend.availability(), f.backend.listWindows(), f.backend.getScreenSize()]),
      ),
    );
    expect(f.calls.map((c) => c.name)).toEqual([
      "check_permissions",
      "list_windows",
      "get_screen_size",
    ]);
  });
  it("does not replay identical text when native readback is unverifiable", async () => {
    const f = fixture();
    await f.backend.availability();
    await f.backend.focusWindow("cua:10:20");
    expect(await f.backend.typeText("abc")).toMatchObject({
      verified: "unverifiable",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
    expect(f.calls.find((c) => isTyping(c.name))?.args).toMatchObject({
      delivery_mode: "background",
      text: "abc",
      pid: 10,
      window_id: 20,
    });
  });
  it("preserves unknown dispatch on transport timeout without retry", async () => {
    const f = fixture();
    await f.backend.availability();
    f.fail(new CuaTransportError("timeout", "dispatched-unknown"));
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "dispatched-unknown",
    });
    expect(f.calls.filter((c) => isTyping(c.name))).toHaveLength(1);
  });
  it("maps negative desktop coordinates using the captured geometry and scale", async () => {
    const f = fixture();
    await f.backend.availability();
    const image = await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    expect(image).toMatchObject({
      width: 400,
      height: 200,
      scale: 2,
      region: { x: -300, y: 20 },
    });
    await f.backend.click({ x: -275, y: 30 }, "cua:10:20");
    expect(f.calls.find((c) => c.name === "click")?.args).toMatchObject({
      x: 25,
      y: 10,
      coordinate_space: "window_points",
      expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
    });
  });
  it("refuses a moved or closed window without injecting", async () => {
    const f = fixture();
    await f.backend.availability();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.move();
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_geometry",
    });
    f.close();
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_target",
    });
    expect(f.calls.filter((c) => c.name === "click" || isTyping(c.name))).toHaveLength(0);
  });
  it("sends an exact-target background drag as window-local points", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20");
    expect(f.calls.filter((call) => call.name === "drag")).toEqual([
      expect.objectContaining({
        args: {
          pid: 10,
          window_id: 20,
          delivery_mode: "background",
          from_x: 25,
          from_y: 10,
          to_x: 75,
          to_y: 30,
          coordinate_space: "window_points",
          duration_ms: 500,
          expected_window_bounds: { x: -300, y: 20, width: 200, height: 100 },
        },
      }),
    ]);
  });
  it("refuses a background drag when no fresh observation grounds the frame", async () => {
    const f = fixture();
    // No captureScreenshot: the backend has no observed geometry to convert
    // screen points against, so the drag refuses rather than guess a frame.
    await expect(
      f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "stale_geometry",
    });
    expect(f.calls.some((call) => call.name === "drag")).toBe(false);
  });
  it("refuses a background drag whose endpoint leaves the exact window", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await expect(
      f.backend.drag({ x: -275, y: 30 }, { x: -90, y: 50 }, 500, "cua:10:20"),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    expect(f.calls.some((call) => call.name === "drag")).toBe(false);
  });
  it("refuses a drag that names no exact window before reaching Cua", async () => {
    const f = fixture();
    await expect(f.backend.drag({ x: 0, y: 0 }, { x: 10, y: 10 }, 500)).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "window_required",
    });
    expect(f.calls.some((call) => call.name === "drag")).toBe(false);
  });
  it("propagates the native background admission refusal without replay", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    // A driver that cannot admit the gesture (older builds report
    // `background_unavailable`; a stale target reports a WindowPointer refusal)
    // answers with a structured refusal. Synara surfaces it as not-dispatched
    // and never replays — one native call, one rejection.
    f.onTool("drag", () => ({
      isError: true,
      structuredContent: {
        effect: "refused",
        code: "background_unavailable",
        pid: 10,
        window_id: 20,
      },
      content: [
        {
          type: "text",
          text: 'Background drag is unavailable on this driver; use delivery_mode:"foreground".',
        },
      ],
    }));
    await expect(
      f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "background_unavailable",
    });
    expect(f.calls.filter((call) => call.name === "drag")).toHaveLength(1);
  });
  it("still sends a foreground drag as window-local points", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await withDesktopDeliveryMode("foreground", () =>
      f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20"),
    );
    expect(f.calls.filter((call) => call.name === "drag")).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({
          delivery_mode: "foreground",
          from_x: 25,
          from_y: 10,
          to_x: 75,
          to_y: 30,
        }),
      }),
    ]);
  });
});

describe("Cua hardening", () => {
  it("reports a stable build signature on the backend and its availability", async () => {
    const f = fixture();
    expect(f.backend.buildSignature()).toBe("unknown");
    expect(f.backend.buildSignature()).toBe(f.backend.buildSignature());
    f.denyPermissions();
    const availability = await f.backend.availability();
    expect(availability.kind === "permission-required" && availability.buildSignature).toBe(
      "unknown",
    );
  });
  it("pauses input while an auth sheet holds focus, keeping observation available", async () => {
    const f = fixture();
    f.actionResult({
      effect: "refused",
      code: "auth_sheet_focused",
      message: "An authentication sheet has focus.",
    });
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "auth_sheet_focused",
      inputPause: { windowId: "cua:10:20" },
    });
    await expect(f.backend.getState({ windowId: "cua:10:20" })).resolves.toMatchObject({
      computerId: "desktop",
    });
  });
  it("flips health on capture failure without blocking input, and heals on refresh", async () => {
    const f = fixture();
    f.captureWindow(21);
    await expect(
      f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
    ).rejects.toMatchObject({ effect: "not-dispatched" });
    expect(f.backend.health()).toMatchObject({
      status: "unavailable",
      captureAvailable: false,
    });
    expect(f.backend.health().consecutiveFailures).toBeGreaterThan(0);
    // Inputs keep working: health never gates dispatch.
    f.captureWindow(20);
    await expect(f.backend.typeText("abc", "cua:10:20")).resolves.toBeDefined();
    // The next refresh re-reads the grants and heals.
    expect(await f.backend.availability()).toMatchObject({ kind: "available" });
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
    });
  });
  it("keeps capture health when a tree-only observation fails", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXButton",
        label: "Equals",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
      },
    ]);
    await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    expect(f.backend.health()).toMatchObject({ status: "connected", captureAvailable: true });
    // The observation answers a different window: a call-level failure past
    // the target, the same shape an AX walk timeout produces.
    f.captureWindow(999);
    // A tree-only read never asked for pixels: its failure is not a capture
    // failure and must not mark capture unavailable.
    await expect(f.backend.getState({ windowId: "cua:10:20", includeTree: true })).rejects.toThrow(
      "belongs to a different window",
    );
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
      consecutiveFailures: 0,
    });
    // The same failure on a read that asked for pixels still flips health.
    await expect(
      f.backend.getState({
        windowId: "cua:10:20",
        includeTree: true,
        includeScreenshot: true,
      }),
    ).rejects.toThrow("belongs to a different window");
    expect(f.backend.health()).toMatchObject({
      status: "unavailable",
      captureAvailable: false,
    });
  });
  it("returns a preview note instead of failing the observation on preview-only failure", async () => {
    const f = fixture();
    f.setElements([
      {
        role: "AXButton",
        label: "Equals",
        frame: { x: -290, y: 30, width: 20, height: 20 },
        element_token: "fresh-token",
        actions: ["AXPress"],
      },
    ]);
    f.invalidateCapture();
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
      includeScreenshot: true,
    });
    expect(state.screenshot).toBeUndefined();
    expect(state.previewNote).toContain("Reselect the window to resume");
    expect(state.root?.children).toHaveLength(1);
    expect(Schema.decodeUnknownSync(ComputerState)(state)).toMatchObject({
      previewNote: state.previewNote,
    });
    // Input is unaffected: targeting data survived the preview failure.
    await expect(f.backend.typeText("abc", "cua:10:20")).resolves.toBeDefined();
    await f.backend.dispose();
  });
  it("pauses off-Space pixels instead of presenting freshness-unverified capture as live", async () => {
    const f = fixture();
    f.markOffSpaceCaptureUnverified();
    const state = await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
      includeScreenshot: true,
    });
    expect(state.screenshot).toBeUndefined();
    expect(state.previewNote).toContain("another macOS Space");
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
    });
    await expect(
      f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
    ).rejects.toMatchObject({
      code: "off_space_capture_unverified",
      effect: "not-dispatched",
    });
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
    });
  });
  it("clears window grounding when the owning task ends", async () => {
    const f = fixture();
    const task = { threadId: "thread", turnId: "turn" };
    await withComputerTask(task, () =>
      f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" }),
    );
    await withComputerTask(task, () =>
      expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).resolves.toBeDefined(),
    );
    await f.backend.endTask("thread", "turn");
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      code: "stale_geometry",
    });
    await f.backend.dispose();
  });
  it("degrades blind on a mid-task Screen Recording revoke without replaying input", async () => {
    const f = fixture();
    // Grounded and driving before the revoke lands.
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).resolves.toBeDefined();
    const clicks = f.calls.filter((call) => call.name === "click").length;

    // The revoke lands mid-task: the probe reports the grant missing...
    f.denyScreenRecording();
    expect(await f.backend.availability()).toMatchObject({
      kind: "permission-required",
      missing: ["screenRecording"],
    });
    // ...perception goes blind but stays available: no pixels, no throw, tree intact...
    const blind = await f.backend.getState({ includeScreenshot: true });
    expect(blind.screenshot).toBeUndefined();
    await expect(
      f.backend.getState({ windowId: "cua:10:20", includeTree: true }),
    ).resolves.toMatchObject({ computerId: "desktop" });
    expect(f.backend.health().captureAvailable).toBe(false);
    // ...and the desktop stays driveable: exactly one native input, never a replay.
    await expect(f.backend.typeText("abc", "cua:10:20")).resolves.toBeDefined();
    expect(f.calls.filter((call) => call.name === "click")).toHaveLength(clicks);
    expect(f.calls.filter((call) => isTyping(call.name))).toHaveLength(1);
    await f.backend.dispose();
  });
  it("requires a fresh granted observation to recover from a failed capture", async () => {
    const f = fixture();
    // A capture that fails native-side flips health while dispatching zero input...
    f.failOverview();
    await expect(f.backend.getState({ includeScreenshot: true })).rejects.toThrow();
    expect(f.backend.health()).toMatchObject({
      status: "unavailable",
      captureAvailable: false,
    });
    const overviews = f.calls.filter((call) => call.name === "get_desktop_state").length;
    expect(f.calls.some((call) => call.name === "click" || isTyping(call.name))).toBe(false);
    // ...inputs keep working through the outage...
    await expect(f.backend.typeText("abc", "cua:10:20")).resolves.toBeDefined();
    // ...and a latched heal is not enough: only a fresh successful observation
    // recovers, so a still-failing capture flips health right back.
    f.grantPermissions();
    await f.backend.provision();
    expect(f.backend.health()).toMatchObject({
      status: "connected",
      captureAvailable: true,
    });
    await expect(f.backend.getState({ includeScreenshot: true })).rejects.toThrow();
    expect(f.backend.health()).toMatchObject({
      status: "unavailable",
      captureAvailable: false,
    });
    expect(f.calls.filter((call) => call.name === "get_desktop_state")).toHaveLength(overviews + 1);
    await f.backend.dispose();
  });
  it("drops grounding after uncertain delivery but keeps it after a clean refusal", async () => {
    const f = fixture();
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.fail(new CuaTransportError("timeout", "dispatched-unknown"));
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "dispatched-unknown",
    });
    // Uncertain delivery may have moved the window: re-observe first.
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).rejects.toMatchObject({
      code: "stale_geometry",
    });
    await f.backend.captureScreenshot({
      kind: "window",
      windowId: "cua:10:20",
    });
    f.refuse();
    f.unfail();
    await expect(f.backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
    });
    // A clean refusal dispatched nothing, so the grounding still stands.
    await expect(f.backend.click({ x: -275, y: 30 }, "cua:10:20")).resolves.toBeDefined();
    await f.backend.dispose();
  });
});

describe("Computer authority", () => {
  it("restores archived admission without reviving work or an explicit user revocation", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    await manager.setControlEnabled("fixture", false);
    await manager.handleThreadRemoved("fixture");
    await manager.handleThreadRestored("fixture");
    await expect(manager.withAgentActivity("fixture", async () => undefined)).rejects.toThrow(
      "revoked",
    );
    await manager.setControlEnabled("fixture", true);
    await expect(manager.withAgentActivity("fixture", async () => "new call")).resolves.toBe(
      "new call",
    );
    await manager.dispose();
  });
  it("ignores an older turn ending after the same thread took a new lease", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    await manager.withAgentActivity(
      "fixture",
      () => manager.click("fixture", { x: 5, y: 5 }),
      undefined,
      "turn-new",
    );
    await manager.releaseDesktopControl("fixture", "turn-old");
    await expect(manager.click("other", { x: 5, y: 5 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
    });
    await manager.releaseDesktopControl("fixture", "turn-new");
    await expect(manager.click("other", { x: 5, y: 5 })).resolves.toBeDefined();
    await manager.dispose();
  });
  it("revokes queued admission and aborts the active operation", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.withAgentActivity("fixture", async () => {
      entered();
      await blocked;
      return "ended";
    });
    await ready;
    const work = vi.fn(async () => "input");
    const queued = manager.withAgentActivity("fixture", work);
    const rejected = expect(queued).rejects.toThrow("revoked");
    await manager.setControlEnabled("fixture", false);
    await manager.setControlEnabled("fixture", true);
    release();
    await first;
    await rejected;
    expect(work).not.toHaveBeenCalled();
    await expect(manager.withAgentActivity("fixture", work)).resolves.toBe("input");
    await manager.dispose();
  });
});

describe("native preview task lifetime", () => {
  it("does no host work when an ordinary turn ends", async () => {
    const f = fixture();
    await f.backend.endTask("ordinary", "turn");
    expect(f.calls).toHaveLength(0);
  });
  it("attributes observations and ends only the matching turn", async () => {
    const f = fixture();
    const task = { threadId: "thread", turnId: "turn" };
    await withComputerTask(task, () =>
      withModelDesktopObservation(() =>
        f.backend.getState({ windowId: "cua:10:20", includeScreenshot: true }),
      ),
    );
    expect(f.calls).toContainEqual(
      expect.objectContaining({
        name: "get_window_state",
        task,
        modelObservation: true,
      }),
    );
    const before = f.calls.length;
    await f.backend.endTask("thread", "old");
    expect(f.calls).toHaveLength(before);
    await f.backend.endTask("thread", "turn");
    expect(f.calls.at(-1)).toMatchObject({ method: "end_task", task });
    await f.backend.endTask("thread", "turn");
    expect(f.calls).toHaveLength(before + 1);
  });
});

describe("preview stills target scope", () => {
  const task = { threadId: "thread", turnId: "turn" };
  const signal = () => new AbortController().signal;

  it("publishes nothing when no window or tab is the target", async () => {
    // No target means no frame: the pane shows its waiting state instead of a
    // whole-desktop picture.
    const f = fixture();
    const frames: Array<unknown> = [];
    await f.backend.attachStream((frame) => frames.push(frame));
    expect(frames).toHaveLength(0);
    expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
    expect(f.calls.some((call) => call.name === "get_window_state")).toBe(false);
    await f.backend.dispose();
  });

  it("captures the exact window the task aims at, never the desktop", async () => {
    const f = fixture();
    await f.backend.focusWindow("cua:10:20");
    f.calls.length = 0;
    const frames: Array<unknown> = [];
    await f.backend.attachStream((frame) => frames.push(frame));
    expect(frames).toHaveLength(1);
    expect(f.calls.find((call) => call.name === "get_window_state")?.args).toMatchObject({
      pid: 10,
      window_id: 20,
      include_screenshot: true,
      include_accessibility_tree: false,
    });
    expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
    await f.backend.dispose();
  });

  it("captures a bound browser tab through the driver's screenshot route", async () => {
    const f = fixture();
    f.onTool("get_browser_state", (args) =>
      args.pid !== undefined
        ? {
            structuredContent: {
              status: "ok",
              target_id: "bt-1",
              tabs: [{ tab_id: "tab-1", active: true }],
            },
          }
        : {
            structuredContent: { status: "ok" },
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from([1, 2, 3]).toString("base64"),
              },
            ],
          },
    );
    await f.backend.browser!.call({
      name: "get_browser_state",
      args: { pid: 42 },
      task,
      mutation: false,
      signal: signal(),
    });
    f.calls.length = 0;
    const frames: Array<unknown> = [];
    await f.backend.attachStream((frame) => frames.push(frame));
    expect(frames).toHaveLength(1);
    // The bind minted the target and its one active tab; the still snapshots
    // exactly that tab, and the desktop is never captured.
    expect(f.calls.at(-1)).toMatchObject({
      method: "call",
      name: "get_browser_state",
      args: { target_id: "bt-1", tab_id: "tab-1", include_screenshot: true },
      task,
    });
    expect(f.calls.some((call) => call.name === "get_desktop_state")).toBe(false);
    await f.backend.dispose();
  });

  it("drops the browser still target when its task ends", async () => {
    const f = fixture();
    f.onTool("get_browser_state", () => ({
      structuredContent: { status: "ok", target_id: "bt-1", tabs: [{ tab_id: "tab-1" }] },
    }));
    await f.backend.browser!.call({
      name: "get_browser_state",
      args: { pid: 42 },
      task,
      mutation: false,
      signal: signal(),
    });
    await f.backend.endTask("thread", "turn");
    f.calls.length = 0;
    const frames: Array<unknown> = [];
    await f.backend.attachStream((frame) => frames.push(frame));
    // A pane still must never revive an ended browser session.
    expect(frames).toHaveLength(0);
    expect(f.calls.some((call) => call.name === "get_browser_state")).toBe(false);
    await f.backend.dispose();
  });

  it("registers a browser task so endTask reaches the host", async () => {
    const f = fixture();
    await f.backend.browser!.call({
      name: "get_browser_state",
      args: { pid: 10, window_id: 20 },
      task,
      mutation: false,
      signal: signal(),
    });
    // The bound window releases the driver-side task surface: endTask
    // reaches the host instead of early-returning on an unknown task.
    await f.backend.endTask("thread", "turn");
    expect(f.calls.at(-1)).toMatchObject({ method: "end_task", task });
    await f.backend.dispose();
  });

  it("a refused browser call still ends its task cleanly", async () => {
    const f = fixture();
    f.onTool("get_browser_state", () => ({
      structuredContent: {
        status: "refused",
        refusal: { code: "browser_requires_setup", message: "Prepare a browser first." },
      },
      content: [{ type: "text", text: "refused (browser_requires_setup)" }],
    }));
    await f.backend.browser!.call({
      name: "get_browser_state",
      args: { pid: 10, window_id: 20 },
      task,
      mutation: false,
      signal: signal(),
    });
    // The task registered at dispatch, so its end still reaches the host —
    // anything the refused call did touch releases with it.
    await f.backend.endTask("thread", "turn");
    expect(f.calls.at(-1)).toMatchObject({ method: "end_task", task });
    await f.backend.dispose();
  });
});

describe("Cua workstream-C speed flags", () => {
  const ENV = ["SYNARA_CUA_PREVIEW_STILL_MS"] as const;
  const savedEnv = new Map<string, string | undefined>();

  afterEach(() => {
    for (const name of ENV) {
      if (savedEnv.has(name)) {
        const value = savedEnv.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    savedEnv.clear();
    vi.restoreAllMocks();
  });

  const setEnv = (name: (typeof ENV)[number], value: string | undefined) => {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const windowStateArgs = (f: ReturnType<typeof fixture>) =>
    f.calls.find((call) => call.name === "get_window_state")?.args ?? {};

  it("sends explicit include_screenshot:false on a tree-only get_state", async () => {
    // The driver treats an absent include_screenshot as true, so the
    // no-capture contract has to be pinned explicitly on the wire.
    const f = fixture();
    const state = await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    expect(windowStateArgs(f)).toMatchObject({
      include_screenshot: false,
      max_dimension: 1536,
      include_accessibility_tree: true,
    });
    expect(state.screenshot).toBeUndefined();
    await f.backend.dispose();
  });

  it("keeps the capture arguments a pixel read needs", async () => {
    const f = fixture();
    await f.backend.getState({
      windowId: "cua:10:20",
      includeTree: true,
      includeScreenshot: true,
    });
    expect(windowStateArgs(f)).toMatchObject({
      include_screenshot: true,
      max_dimension: 1536,
      include_accessibility_tree: true,
    });
    await f.backend.dispose();
  });

  it("arms the still publisher at the compiled 1000 ms cadence by default", async () => {
    setEnv("SYNARA_CUA_PREVIEW_STILL_MS", undefined);
    const f = fixture();
    const intervals = vi.spyOn(globalThis, "setInterval");
    await f.backend.attachStream(() => undefined);
    expect(intervals.mock.calls.some((call) => call[1] === 1_000)).toBe(true);
    await f.backend.dispose();
  });

  it("SYNARA_CUA_PREVIEW_STILL_MS overrides the still cadence", async () => {
    setEnv("SYNARA_CUA_PREVIEW_STILL_MS", "4000");
    const f = fixture();
    const intervals = vi.spyOn(globalThis, "setInterval");
    await f.backend.attachStream(() => undefined);
    expect(intervals.mock.calls.some((call) => call[1] === 4_000)).toBe(true);
    expect(intervals.mock.calls.some((call) => call[1] === 1_000)).toBe(false);
    await f.backend.dispose();
  });

  it("an unparsable SYNARA_CUA_PREVIEW_STILL_MS falls back to the default", async () => {
    setEnv("SYNARA_CUA_PREVIEW_STILL_MS", "fast");
    const f = fixture();
    const intervals = vi.spyOn(globalThis, "setInterval");
    await f.backend.attachStream(() => undefined);
    expect(intervals.mock.calls.some((call) => call[1] === 1_000)).toBe(true);
    await f.backend.dispose();
  });

  it("the constructor's stillIntervalMs wins and stays above the publisher floor", async () => {
    setEnv("SYNARA_CUA_PREVIEW_STILL_MS", "4000");
    const f = fixture({ stillIntervalMs: 750 });
    const intervals = vi.spyOn(globalThis, "setInterval");
    await f.backend.attachStream(() => undefined);
    expect(intervals.mock.calls.some((call) => call[1] === 750)).toBe(true);
    await f.backend.dispose();

    const floored = fixture({ stillIntervalMs: 5 });
    await floored.backend.attachStream(() => undefined);
    // MIN_STILL_INTERVAL_MS keeps an aggressive value from queueing captures
    // faster than one encode can finish.
    expect(intervals.mock.calls.some((call) => call[1] === 100)).toBe(true);
    await floored.backend.dispose();
  });
});

describe("driver browser surface", () => {
  const signal = () => new AbortController().signal;
  it("exposes a browser route whenever the backend exists", () => {
    const f = fixture();
    expect(f.backend.browser).toBeDefined();
  });
  it("forwards the driver's reply verbatim — a deliberate refusal is a result, not an error", async () => {
    const f = fixture();
    f.onTool("get_browser_state", () => ({
      content: [{ type: "text", text: "refused (browser_requires_setup)" }],
      structuredContent: {
        status: "refused",
        refusal: {
          code: "browser_requires_setup",
          message: "Prepare a browser first.",
        },
      },
    }));
    const result = await f.backend.browser!.call({
      name: "get_browser_state",
      args: { target_id: "bt-1", tab_id: "tab-1" },
      task: { threadId: "thread", turnId: "turn" },
      mutation: false,
      signal: signal(),
    });
    // The desktop path converts the same payload into a thrown CuaActionError;
    // the browser path must not — the refusal IS the result the model reads.
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { code: "browser_requires_setup" },
    });
    expect(f.calls.at(-1)).toMatchObject({
      method: "call",
      name: "get_browser_state",
      args: { target_id: "bt-1", tab_id: "tab-1" },
      task: { threadId: "thread", turnId: "turn" },
    });
  });
  it("fails closed without a GUI host instead of fabricating a route", async () => {
    const backend = new CuaComputerBackend({ endpoint: "" });
    await expect(
      backend.browser!.call({
        name: "browser_click",
        args: {},
        task: { threadId: "thread" },
        mutation: true,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ code: "gui_host_required" });
  });
  it("ends the thread's driver browser session through the host", async () => {
    const f = fixture();
    await f.backend.browser!.endThread!("thread-1");
    expect(f.calls.at(-1)).toMatchObject({
      method: "end_browser_thread",
      task: { threadId: "thread-1" },
    });
  });
});

describe("host-reported platform and native revision", () => {
  const hostReply = (reply: Record<string, unknown>) =>
    (async () => ({ ok: true, ...reply })) as unknown as typeof cuaRequest;

  it("keeps pane input out of its observations: the host serves one request at a time", async () => {
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request: hostReply({ hostPlatform: "darwin", driverNativeRevision: 34 }),
    });
    await backend.probeAvailability();
    expect("concurrentObservationInput" in backend).toBe(false);
  });

  it("adopts the host platform and narrows patched-only capabilities for an unpatched driver", async () => {
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request: hostReply({ hostPlatform: "win32", driverNativeRevision: 0 }),
    });
    expect(backend.agentDialect).toBe(process.platform === "darwin" ? "macos" : "linux");
    expect(backend.focusNeutralSemanticText).toBe(process.platform === "darwin");
    expect(backend.capabilities().ghostCursor).toBe(process.platform === "darwin");

    await backend.probeAvailability();
    // The first reply teaches the backend what actually runs on the other
    // end: a Windows host speaks the generic desktop dialect, and an
    // unpatched upstream driver carries none of the Synara-native surface.
    expect(backend.agentDialect).toBe("linux");
    expect(backend.focusNeutralSemanticText).toBe(false);
    expect(backend.capabilities().ghostCursor).toBe(false);
  });

  it("keeps the patched surface for a driver that reports its revision", async () => {
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request: hostReply({ hostPlatform: "darwin", driverNativeRevision: 20 }),
    });
    await backend.probeAvailability();
    expect(backend.agentDialect).toBe("macos");
    expect(backend.focusNeutralSemanticText).toBe(true);
    expect(backend.capabilities().ghostCursor).toBe(true);
  });

  it("does not advertise macOS input guarantees for a patched Linux browser driver", async () => {
    const backend = new CuaComputerBackend({
      endpoint: "/fixture-only",
      request: hostReply({ hostPlatform: "linux", driverNativeRevision: 32 }),
    });
    await backend.probeAvailability();
    expect(backend.focusNeutralSemanticText).toBe(false);
    expect(backend.capabilities()).toMatchObject({
      input: false,
      focus: false,
      raise: false,
      ghostCursor: false,
    });
  });
});

describe("Linux native input dialect", () => {
  it("uses the strict upstream pixel and keyboard schemas only in authorized foreground mode", async () => {
    const f = fixture({ hostPlatform: "linux" });
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    await withDesktopDeliveryMode("foreground", async () => {
      await f.backend.click({ x: -275, y: 30 }, "cua:10:20");
      await f.backend.typeText("visible input", "cua:10:20");
      await f.backend.drag({ x: -275, y: 30 }, { x: -225, y: 50 }, 500, "cua:10:20");
    });
    expect(f.calls.find((call) => call.name === "click")).toMatchObject({
      deliveryMode: "foreground",
      args: { pid: 10, window_id: 20, delivery_mode: "foreground", count: 1, x: 25, y: 10 },
    });
    expect(f.calls.find((call) => call.name === "type_text")?.args).toEqual({
      pid: 10,
      window_id: 20,
      delivery_mode: "foreground",
      text: "visible input",
    });
    expect(f.calls.find((call) => call.name === "drag")?.args).toEqual({
      pid: 10,
      window_id: 20,
      delivery_mode: "foreground",
      from_x: 25,
      from_y: 10,
      to_x: 75,
      to_y: 30,
      duration_ms: 500,
    });
    for (const call of f.calls.filter((call) =>
      ["click", "type_text", "drag"].includes(call.name ?? ""),
    )) {
      expect(call.args).not.toHaveProperty("force_synthetic");
      expect(call.args).not.toHaveProperty("coordinate_space");
      expect(call.args).not.toHaveProperty("expected_window_bounds");
    }
  });

  it("refuses default background input without dispatching a relaxed Linux request", async () => {
    const f = fixture({ hostPlatform: "linux" });
    await expect(f.backend.typeText("must not type", "cua:10:20")).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "linux_background_unavailable",
    });
    expect(f.calls.some((call) => call.name === "type_text")).toBe(false);
    expect(f.calls.every((call) => call.deliveryMode === "background")).toBe(true);
  });

  it("translates an unmodified single-axis scroll without dropping unsupported gesture semantics", async () => {
    const f = fixture({ hostPlatform: "linux" });
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
    await withDesktopDeliveryMode("foreground", () =>
      f.backend.scroll({ x: -275, y: 30 }, 0, 240, "cua:10:20"),
    );
    expect(f.calls.find((call) => call.name === "scroll")?.args).toEqual({
      pid: 10,
      window_id: 20,
      delivery_mode: "foreground",
      direction: "down",
      amount: 2,
      by: "line",
      x: 25,
      y: 10,
    });
    await expect(
      withDesktopDeliveryMode("foreground", () =>
        f.backend.scroll({ x: -275, y: 30 }, 120, 240, "cua:10:20"),
      ),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "unsupported_linux_operation" });
    await expect(
      withDesktopDeliveryMode("foreground", () =>
        f.backend.scroll({ x: -275, y: 30 }, 0, 240, "cua:10:20", ["ctrl"]),
      ),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "unsupported_linux_operation" });
    expect(f.calls.filter((call) => call.name === "scroll")).toHaveLength(1);
  });

  it("does not downgrade an exact semantic text target to focused Linux typing", async () => {
    const f = fixture({ hostPlatform: "linux" });
    f.setElements([
      {
        role: "AXTextField",
        label: "Fixture input",
        element_token: "snapshot-token",
        frame: { x: -290, y: 30, width: 20, height: 20 },
      },
    ]);
    const state = await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    const node = state.root!.children[0]!;
    const target = { target: { label: "Fixture input" }, node, point: node.activationPoint! };
    await expect(
      withDesktopDeliveryMode("foreground", () =>
        f.backend.typeText("must preserve identity", "cua:10:20", target),
      ),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "linux_semantic_target_unproven" });
    expect(f.calls.some((call) => call.name === "type_text" || call.name === "set_value")).toBe(
      false,
    );
  });

  it("keeps native arguments separate from the server's delivery authorization envelope", async () => {
    const f = fixture({ hostPlatform: "linux" });
    await f.backend.browser!.call({
      name: "browser_click",
      args: { target_id: "fixture", delivery_mode: "foreground", deliveryMode: "foreground" },
      task: { threadId: "linux-envelope-test" },
      mutation: true,
      signal: new AbortController().signal,
    });
    expect(f.calls.at(-1)).toMatchObject({
      deliveryMode: "background",
      args: { delivery_mode: "foreground", deliveryMode: "foreground" },
    });
  });

  it("marks only active model browser observations as eligible for interruption recovery", async () => {
    const f = fixture();
    const observe = () =>
      f.backend.browser!.call({
        name: "get_browser_state",
        args: { target_id: "fixture", tab_id: "tab" },
        task: { threadId: "observation-test" },
        mutation: false,
        signal: new AbortController().signal,
      });
    await observe();
    expect(f.calls.at(-1)?.modelObservation).toBe(false);
    await withModelDesktopObservation(observe);
    expect(f.calls.at(-1)?.modelObservation).toBe(true);
    await observe();
    expect(f.calls.at(-1)?.modelObservation).toBe(false);
  });
});
