import { describe, expect, it, vi } from "vitest";
import { CuaComputerBackend } from "./CuaComputerBackend.ts";
import { ComputerAvailability, ComputerScreenshot, ComputerState } from "@synara/contracts";
import { Schema } from "effect";
import {
  CuaTransportError,
  CUA_SETUP_TIMEOUT_MS,
  type cuaRequest,
} from "@synara/shared/cuaDriverProtocol";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { withDesktopDeliveryMode } from "./DesktopOperationQueue.ts";
import { withModelDesktopObservation } from "./modelDesktopObservation.ts";
import { withComputerTask } from "./computerTaskContext.ts";

const isTyping = (name?: string) => name === "type_text";

function fixture(options?: {
  readonly semanticTextLaneHoldMs?: number;
  readonly semanticTextLaneGapMs?: number;
}) {
  const calls: Array<{
    name?: string;
    args?: Record<string, unknown>;
    modelObservation?: boolean;
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
  const request = vi.fn(async (_endpoint, request) => {
    calls.push(request);
    const responseEpoch = desktopEpoch;
    if (request.method === "probe" || request.method === "stop")
      return { ok: true, desktopEpoch: responseEpoch };
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
      if (target && typeof written === "string") target.value = written;
    }
    if (isTyping(request.name)) data = actionResult;
    const toolHandler = request.name ? toolHandlers[request.name] : undefined;
    if (toolHandler)
      return {
        ok: true,
        result: toolHandler(request.args ?? {}),
        desktopEpoch: responseEpoch,
      };
    return {
      ok: true,
      result: { structuredContent: data },
      desktopEpoch: responseEpoch,
    };
  }) as unknown as typeof cuaRequest;
  const backend = new CuaComputerBackend({
    endpoint: "/fixture-only",
    request,
    ...(options?.semanticTextLaneHoldMs !== undefined
      ? { semanticTextLaneHoldMs: options.semanticTextLaneHoldMs }
      : {}),
    ...(options?.semanticTextLaneGapMs !== undefined
      ? { semanticTextLaneGapMs: options.semanticTextLaneGapMs }
      : {}),
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
    waitForPermission: (wait: Promise<void>) => {
      permissionWait = wait;
    },
    failOverview: () => {
      overviewFailure = true;
    },
  };
}

describe("Cua native boundary", () => {
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
    });
    expect(f.calls.find((call) => call.name === "type_text")?.args).not.toHaveProperty(
      "force_synthetic",
    );

    await f.backend.typeText("keyboard", "cua:10:20");
    expect(f.calls.filter((call) => call.name === "type_text")[1]?.args).toMatchObject({
      text: "keyboard",
      force_synthetic: true,
    });
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
    expect(result).toMatchObject({ verified: "unconfirmed", effect: "dispatched-unknown" });
  });

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
    const state = await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
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

  it("semantic text lane times out a stuck write honestly", async () => {
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
    await expect(f.backend.typeText("alpha", "cua:10:20", target)).rejects.toThrow(
      /partially dispatched/,
    );
    releaseGate();
    await expect(f.backend.typeText("beta", "cua:10:20", target)).resolves.toMatchObject({
      windowId: "cua:10:20",
    });
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
  it("marks only scoped model state reads and keeps inherited preview captures unmarked", async () => {
    const f = fixture();
    try {
      await f.backend.captureScreenshot({
        kind: "window",
        windowId: "cua:10:20",
      });
      expect(f.calls.find((call) => call.name === "get_window_state")?.modelObservation).toBe(
        false,
      );
      f.calls.length = 0;
      await withModelDesktopObservation(async () => {
        await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
        await f.backend.getState({ includeScreenshot: true });
        await f.backend.attachStream(() => undefined);
      });
      expect(f.calls.find((call) => call.name === "get_window_state")?.modelObservation).toBe(true);
      expect(
        f.calls
          .filter((call) => call.name === "get_desktop_state")
          .map((call) => call.modelObservation),
      ).toEqual([true, false]);
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
      code: "desktop_input_paused",
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
      f.backend.setWindowFrame!("cua:10:20", { x: 0, y: 0, width: 640, height: 480 }),
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
      f.backend.setWindowFrame!("cua:10:20", { x: 0, y: 0, width: 640, height: 480 }),
    ).resolves.toMatchObject({ verified: "unconfirmed", effect: "dispatched-unknown" });
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
    await expect(f.backend.invokeMenu!("cua:10:20", ["File", "Save"])).resolves.toMatchObject({
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
        refusal: { code: "menu_path_unavailable", message: "The menu item is disabled." },
      },
      content: [{ type: "text", text: "The menu item is disabled." }],
    }));
    await expect(f.backend.invokeMenu!("cua:10:20", ["Edit", "Undo"])).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "menu_path_unavailable",
    });
  });
  it("verifies window state from the driver's per-predicate outcome", async () => {
    const f = fixture();
    const predicates = [
      { index: 0, status: "satisfied", unknown_reason: null, observed_json: "{}" },
    ];
    f.onTool("verify_state", () => ({
      structuredContent: { status: "satisfied", stable: true, samples: 2, predicates },
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
          { index: 0, status: "unsatisfied", unknown_reason: null, observed_json: "{}" },
        ],
      },
    }));
    await expect(
      f.backend.verifyState!("cua:10:20", [{ window: { bounds: { x: 0 } } }]),
    ).resolves.toMatchObject({ status: "unsatisfied", stable: true });
    // An unparseable status is "unknown", never collapsed to unsatisfied.
    f.onTool("verify_state", () => ({ structuredContent: { status: "weird" } }));
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
      f.backend.zoomWindow!("cua:10:20", { x: 150, y: 0, width: 100, height: 50 }),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "invalid_geometry" });
  });
  it("reports a killed app verified only once it leaves the app list", async () => {
    const f = fixture();
    let apps: Array<Record<string, unknown>> = [
      { pid: 10, name: "TextEdit", bundle_id: "com.apple.TextEdit", active: true },
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
    expect(f.calls.find((call) => call.name === "kill_app")?.args).toEqual({ pid: 10 });
    f.onTool("kill_app", () => ({
      content: [{ type: "text", text: "Sent SIGKILL to pid 10." }],
    }));
    apps = [{ pid: 10, name: "TextEdit", active: true }];
    await expect(f.backend.killApp!(10)).resolves.toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
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
          { window_id: 21, pid: 10, app_name: "TextEdit", title: "Second", is_on_screen: false },
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
        { id: "cua:10:21", pid: 10, appName: "TextEdit", title: "Second", onScreen: false },
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
        { id: "cua:10:21", pid: 10, appName: "TextEdit", title: "Second", onScreen: false },
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
    f.onTool("get_accessibility_tree", () => ({ structuredContent: { windows: [] } }));
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
    f.onTool("get_cursor_position", () => ({ structuredContent: { x: -200, y: 60 } }));
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
    f.onTool("get_cursor_position", () => ({ structuredContent: { x: 50, y: 60 } }));
    await expect(f.backend.getCursorPosition!("cua:10:20")).resolves.toMatchObject({
      insideWindow: false,
    });
    f.onTool("get_cursor_position", () => ({ structuredContent: { x: "left", y: 60 } }));
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
      delta_y: 2,
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
      delta_x: -1,
      delta_y: 2,
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
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
    await expect(
      f.backend.scroll({ x: -275, y: 30 }, 61 * 120, 0, "cua:10:20"),
    ).rejects.toMatchObject({ effect: "not-dispatched", code: "unsupported_operation" });
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
    const state = await f.backend.getState({ windowId: "cua:10:20", includeTree: true });
    const node = state.root!.children[0]!;
    const target = {
      target: { label: "Content", windowId: "cua:10:20" },
      node,
      point: node.activationPoint!,
    };
    // The point path is geometry-gated: a wheel scroll at a point still needs
    // a fresh observation of the window it lands in.
    await f.backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
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
      delta_x: -1,
      delta_y: 2,
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
      force_synthetic: true,
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
  it("refuses background drag before reaching Cua", async () => {
    const f = fixture();
    await expect(
      f.backend.drag({ x: 0, y: 0 }, { x: 10, y: 10 }, 500, "cua:10:20"),
    ).rejects.toMatchObject({
      effect: "not-dispatched",
      code: "foreground_required",
    });
    expect(f.calls).toHaveLength(0);
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

describe("Cua preview image lifetime", () => {
  const retainedImage = (backend: CuaComputerBackend) =>
    (backend as unknown as { cachedImage: ComputerScreenshot | undefined }).cachedImage;
  it("releases cached pixels when a new desktop epoch arrives on a metadata read", async () => {
    const f = fixture();
    try {
      await f.backend.attachStream(() => undefined);
      expect(retainedImage(f.backend)).toBeDefined();
      f.changeDesktop();
      await f.backend.checkInputReady("cua:10:20");
      expect(retainedImage(f.backend)).toBeUndefined();
    } finally {
      await f.backend.dispose();
    }
  });
  it("retains no image for model-only perception and releases a detached preview", async () => {
    const f = fixture();
    await f.backend.getState({ includeScreenshot: true });
    expect(retainedImage(f.backend)).toBeUndefined();
    await f.backend.attachStream(() => undefined);
    expect(retainedImage(f.backend)).toBeDefined();
    await f.backend.detachStream();
    expect(retainedImage(f.backend)).toBeUndefined();
    await f.backend.dispose();
  });
  it.each(["detachStream", "stopInput", "dispose"] as const)(
    "late overview cannot repopulate cache after %s",
    async (boundary) => {
      const f = fixture();
      let resolve!: () => void;
      f.delayOverview(
        new Promise<void>((r) => {
          resolve = r;
        }),
      );
      const attaching = f.backend.attachStream(() => undefined);
      await vi.waitFor(() =>
        expect(f.calls.some((c) => c.name === "get_desktop_state")).toBe(true),
      );
      await f.backend[boundary]();
      resolve();
      await attaching;
      expect(retainedImage(f.backend)).toBeUndefined();
      await f.backend.dispose();
    },
  );
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
