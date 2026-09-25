import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ProviderKind } from "@synara/contracts";

import { DeviceBackendError } from "../device/DeviceBackend.ts";
import { DeviceManager } from "../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../device/FakeDeviceBackend.ts";
import { makeAgentGatewayDeviceTools } from "./deviceTools.ts";
import { PROVIDERS_WITHOUT_APPROVAL_GATE } from "./approvalGate.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const THREAD = "thread-a";
const DEVICE = "FAKE-0001";

function makeContext(provider: ProviderKind = "claudeAgent"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:test",
      threadId: THREAD,
      provider,
      turnId: "turn-a",
    },
    callerThreadId: THREAD,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:test",
    callerProvider: provider,
    callerCapabilities: new Set(["device:control"]),
    callerTurnId: "turn-a",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(options?: {
  readonly authorizeAction?:
    | ((
        name: string,
        args: Record<string, unknown>,
        context: ToolContext,
        signal: AbortSignal,
      ) => Promise<boolean>)
    | undefined;
}) {
  const backend = new FakeDeviceBackend();
  const manager = new DeviceManager({ backend });
  await manager.boot(DEVICE);
  const authorizeAction =
    options && "authorizeAction" in options ? options.authorizeAction : async () => true;
  const tools = authorizeAction
    ? makeAgentGatewayDeviceTools({ manager, authorizeAction })
    : makeAgentGatewayDeviceTools({ manager });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider)));
  };
  const structured = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
  ): Promise<unknown> => {
    const result = await call(name, args, provider);
    const text = result.content.find((entry) => entry.type === "text");
    return text && text.type === "text" ? JSON.parse(text.text) : null;
  };
  return { backend, manager, tools, byName, call, structured };
}

function collectOpenPaneRequests(manager: DeviceManager): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  manager.onEvent((event) => {
    if (event.type === "device.open-pane-requested") events.push(event);
  });
  return events;
}

/** Every tool that drives or reads the device the user is watching. */
const INTERACTION_CALLS = [
  ["device_tap", { udid: DEVICE, x: 10, y: 10 }],
  ["device_swipe", { udid: DEVICE, fromX: 0, fromY: 0, toX: 10, toY: 10 }],
  ["device_type", { udid: DEVICE, text: "hello" }],
  ["device_press_button", { udid: DEVICE, button: "home" }],
  ["device_scroll_to_element", { udid: DEVICE, label: "Deep Row" }],
  ["device_describe_ui", { udid: DEVICE }],
  ["device_screenshot", { udid: DEVICE }],
] as const;

describe("agent gateway device tools surface", () => {
  it("exposes the full device tool set behind the device:control capability", async () => {
    const { tools } = await setup();

    expect(tools.map((tool: ToolEntry) => tool.definition.name)).toEqual([
      "device_list",
      "device_boot",
      "device_install",
      "device_launch",
      "device_open_url",
      "device_tap",
      "device_swipe",
      "device_type",
      "device_press_button",
      "device_screenshot",
      "device_describe_ui",
      "device_scroll_to_element",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "device:control")).toBe(true);
    // Every tool, the read-only ones included, needs a live caller turn.
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
  });
});

describe("agent gateway device tool handlers", () => {
  it("publishes the operational rules on the tools that need them", async () => {
    const { byName } = await setup();
    const description = (name: string) => byName.get(name)?.definition.description ?? "";

    expect(description("device_list")).toContain("use an already-booted device");
    expect(description("device_boot")).toContain("only when device_list finds nothing booted");
    expect(description("device_boot")).toContain("boot-limit-reached");
    expect(description("device_install")).toContain("Synara never builds");
    expect(description("device_install")).toContain("xcodebuild");
    expect(description("device_launch")).toContain("com.apple.Preferences");
    expect(description("device_open_url")).toContain("exp://127.0.0.1:8081");
    expect(description("device_open_url")).toContain("start it detached");
    expect(description("device_open_url")).toContain("expo start --ios");
    expect(description("device_tap")).toContain("Tap by label");
    expect(description("device_tap")).toContain("activationPoint");
    expect(description("device_tap")).toContain("screenshot pixels");
    expect(description("device_tap")).toContain("HID events were not delivered");
    expect(description("device_tap")).toContain("unchanged tree");
    expect(description("device_swipe")).toContain("gesture itself is the goal");
    expect(description("device_swipe")).toContain("Never write a swipe loop");
    expect(description("device_screenshot")).toContain("showing the user a result");
    expect(description("device_describe_ui")).toContain('value "1" means on and "0" means off');
    expect(description("device_describe_ui")).toContain("rather than using a screenshot");
    expect(description("device_describe_ui")).toContain("hardware-backed panes");
    expect(description("device_scroll_to_element")).toContain("instead of a device_swipe loop");

    for (const name of [
      "device_boot",
      "device_install",
      "device_launch",
      "device_open_url",
      "device_tap",
      "device_swipe",
      "device_type",
      "device_press_button",
      "device_scroll_to_element",
    ]) {
      expect(description(name)).toContain("DeviceApprovalRequired");
      expect(description(name)).toContain("do not retry");
    }
  });

  it("lists devices with their availability", async () => {
    const { structured } = await setup();

    const result = (await structured("device_list", {})) as {
      devices: readonly { udid: string; bootSource: string }[];
      availability: { kind: string };
    };

    expect(result.availability).toEqual({ kind: "available" });
    expect(result.devices.find((device) => device.udid === DEVICE)?.bootSource).toBe("synara");
  });

  it("taps a label at the control's own point and reports its prior state", async () => {
    const { backend, structured } = await setup();

    const result = (await structured("device_tap", {
      udid: DEVICE,
      label: "Fake Toggle",
    })) as { x: number; element: { subrole: string; valueBeforeTap: string } };

    // The switch, not the row centre at x=196.
    expect(result.x).toBe(340);
    expect(result.element).toMatchObject({ subrole: "Switch", valueBeforeTap: "0" });
    expect(backend.callsOfKind("tap")[0]).toMatchObject({ x: 340, y: 222 });
  });

  it("scrolls a below-the-fold element into view without the agent swiping", async () => {
    const { backend, structured } = await setup();

    const result = (await structured("device_scroll_to_element", {
      udid: DEVICE,
      label: "Deep Row",
    })) as { element: { label: string }; tapPoint: { y: number } };

    expect(result.element.label).toBe("Deep Row");
    expect(backend.callsOfKind("swipe").length).toBeGreaterThan(0);
    // Landed somewhere tappable rather than merely on screen.
    expect(result.tapPoint.y).toBeGreaterThan(0);
    expect(result.tapPoint.y).toBeLessThan(852);
  });

  it("reports the labels on screen when a scroll target does not exist", async () => {
    const { call } = await setup();

    const result = await call("device_scroll_to_element", { udid: DEVICE, label: "Nope" });

    const entry = result.content.find((item) => item.type === "text");
    const message = entry && entry.type === "text" ? entry.text : "";
    expect(result.isError).toBe(true);
    // A dead-end error is one that names no alternative; the real labels have
    // to survive into the message the agent reads.
    expect(message).toMatch(/No element labelled/);
    expect(message).toMatch(/Fake Toggle/);
  });

  it("returns the screenshot bytes as image content beside the metadata", async () => {
    const { call } = await setup();

    const result = await call("device_screenshot", { udid: DEVICE });

    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    const image = result.content.find((entry) => entry.type === "image");
    expect(image && image.type === "image" ? image.mimeType : null).toBe("image/png");
  });

  it("opens the pane when the agent installs an app", async () => {
    const { manager, structured } = await setup();
    const events = collectOpenPaneRequests(manager);

    await structured("device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" });

    expect(events).toEqual([
      {
        type: "device.open-pane-requested",
        threadId: THREAD,
        udid: DEVICE,
        reason: "agent-install",
      },
    ]);
  });

  it("opens the pane when the agent launches an app", async () => {
    const { manager, structured } = await setup();
    const events = collectOpenPaneRequests(manager);

    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    expect(events).toEqual([
      {
        type: "device.open-pane-requested",
        threadId: THREAD,
        udid: DEVICE,
        reason: "agent-launch",
      },
    ]);
  });

  it("reports the boot-limit refusal to the agent rather than failing", async () => {
    const { structured } = await setup();
    await structured("device_boot", { udid: "FAKE-0002" });
    await structured("device_boot", { udid: "FAKE-0003" });

    const result = (await structured("device_boot", { udid: "FAKE-0004" })) as { kind: string };

    expect(result.kind).toBe("boot-limit-reached");
  });

  it("surfaces a backend failure as a tool error and records it on the thread", async () => {
    const { manager, call } = await setup();

    const result = await call("device_tap", { udid: "FAKE-0002", x: 1, y: 1 });

    expect(result.isError).toBe(true);
    expect((await manager.getThreadState(THREAD)).lastError).toContain("not booted");
  });

  it("rejects malformed arguments without touching the device", async () => {
    const { backend, call } = await setup();

    const missingUdid = await call("device_tap", { x: 1, y: 1 });
    const badCoordinate = await call("device_tap", { udid: DEVICE, x: -5, y: 1 });

    expect(missingUdid.isError).toBe(true);
    expect(badCoordinate.isError).toBe(true);
    expect(backend.callsOfKind("tap")).toHaveLength(0);
  });

  it("enforces contract bounds for swipe duration and scroll budget", async () => {
    const { backend, call } = await setup();

    const fractionalDuration = await call("device_swipe", {
      udid: DEVICE,
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 10,
      durationMs: 10.5,
    });
    const excessiveDuration = await call("device_swipe", {
      udid: DEVICE,
      fromX: 0,
      fromY: 0,
      toX: 10,
      toY: 10,
      durationMs: 10_001,
    });
    const excessiveScrolls = await call("device_scroll_to_element", {
      udid: DEVICE,
      label: "Deep Row",
      maxSwipes: 33,
    });

    expect(fractionalDuration.isError).toBe(true);
    expect(excessiveDuration.isError).toBe(true);
    expect(excessiveScrolls.isError).toBe(true);
    expect(backend.callsOfKind("swipe")).toHaveLength(0);
  });
});

describe("agent gateway device tools approval surface", () => {
  const MUTATING_CALLS = [
    ["device_tap", { udid: DEVICE, x: 1, y: 1 }],
    ["device_swipe", { udid: DEVICE, fromX: 0, fromY: 0, toX: 10, toY: 10 }],
    ["device_type", { udid: DEVICE, text: "hello" }],
    ["device_press_button", { udid: DEVICE, button: "home" }],
    ["device_open_url", { udid: DEVICE, url: "https://example.com" }],
    ["device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" }],
    ["device_launch", { udid: DEVICE, bundleId: "com.example.Demo" }],
    ["device_boot", { udid: "FAKE-0002" }],
  ] as const;

  it.each(["codex", "omp", ...PROVIDERS_WITHOUT_APPROVAL_GATE] as const)(
    "refuses input and open_url for %s when no authorize surface exists",
    async (provider) => {
      const { backend, call } = await setup({ authorizeAction: undefined });

      for (const [name, args] of MUTATING_CALLS) {
        const result = await call(name, args, provider);
        expect(result.isError, `${name} should be refused`).toBe(true);
        const text = result.content.find((entry) => entry.type === "text");
        expect(text && text.type === "text" ? text.text : "").toContain("DeviceApprovalRequired");
      }

      expect(backend.calls.filter((entry) => entry.kind !== "attachStream")).toEqual([
        { kind: "boot", udid: DEVICE },
      ]);
    },
  );

  it("asks authorizeAction before running a mutating tool, for every provider kind", async () => {
    const asked: string[] = [];
    const { call } = await setup({
      authorizeAction: async (name) => {
        asked.push(name);
        return true;
      },
    });

    for (const provider of ["codex", "omp", "antigravity"] as const) {
      const result = await call("device_tap", { udid: DEVICE, x: 5, y: 5 }, provider);
      expect(result.isError).toBeUndefined();
    }

    expect(asked).toEqual(["device_tap", "device_tap", "device_tap"]);
  });

  it("does not ask authorizeAction for the read-only tools", async () => {
    let asked = 0;
    const { call } = await setup({
      authorizeAction: async () => {
        asked += 1;
        return true;
      },
    });

    for (const name of ["device_list", "device_describe_ui", "device_screenshot"] as const) {
      const result = await call(name, { udid: DEVICE }, "omp");
      expect(result.isError).toBeUndefined();
    }

    expect(asked).toBe(0);
  });

  it("denies the action without touching the device when authorizeAction refuses", async () => {
    const { backend, call } = await setup({ authorizeAction: async () => false });

    const result = await call("device_tap", { udid: DEVICE, x: 5, y: 5 }, "omp");

    expect(result.isError).toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    expect(text && text.type === "text" ? text.text : "").toContain("denied or cancelled");
    expect(backend.calls.filter((entry) => entry.kind !== "attachStream")).toEqual([
      { kind: "boot", udid: DEVICE },
    ]);
  });
});

describe("agent gateway device tools auto-attach", () => {
  it("attaches the caller thread to the device it launches on", async () => {
    const { manager, structured } = await setup();

    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    // The open-pane request is only useful if the pane has a device to stream.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
  });

  it("attaches on install too", async () => {
    const { manager, structured } = await setup();

    await structured("device_install", { udid: DEVICE, appPath: "/tmp/Demo.app" });

    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
  });

  it("attaches on boot without opening the pane", async () => {
    const { manager, structured } = await setup();
    const opened = collectOpenPaneRequests(manager);

    await structured("device_boot", { udid: "FAKE-0002" });

    // Booting alone has nothing to watch yet, and the first real interaction
    // surfaces the pane anyway.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe("FAKE-0002");
    expect(opened).toHaveLength(0);
  });

  it("leaves a thread already watching another device alone", async () => {
    const { backend, manager, structured } = await setup();
    await backend.boot("FAKE-0002");
    await manager.attach(THREAD, "FAKE-0002");

    await structured("device_launch", { udid: DEVICE, bundleId: "com.example.Demo" });

    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe("FAKE-0002");
  });

  it("still returns the launch result when attaching cannot stream", async () => {
    const { backend, structured } = await setup();
    backend.failNext("attachStream", new DeviceBackendError("helper is not built"));

    const result = (await structured("device_launch", {
      udid: DEVICE,
      bundleId: "com.example.Demo",
    })) as { bundleId?: string };

    // A stream failure must not turn a successful launch into a tool error.
    expect(result.bundleId).toBe("com.example.Demo");
  });
});

describe("agent gateway device tools surface the pane on any interaction", () => {
  // The demo failure: an Expo app already running on a booted simulator, so the
  // agent never installs or launches and goes straight to describe/tap.
  for (const [name, args] of INTERACTION_CALLS) {
    it(`attaches and opens the pane on ${name}`, async () => {
      const { manager, call } = await setup();
      const opened = collectOpenPaneRequests(manager);

      const result = await call(name, { ...args });

      expect(result.isError, `${name} should succeed`).not.toBe(true);
      expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
      expect(opened).toEqual([
        {
          type: "device.open-pane-requested",
          threadId: THREAD,
          udid: DEVICE,
          reason: "agent-tool",
        },
      ]);
    });
  }

  // Idempotency and non-stealing live in the one shared surfacing wrapper
  // (handleInteraction -> manager.surfaceDeviceForAgent), so one tool proves them.
  const [tapName, tapArgs] = INTERACTION_CALLS[0];

  it("asks the pane to open only once across repeated device_tap calls", async () => {
    const { manager, call } = await setup();
    const opened = collectOpenPaneRequests(manager);

    await call(tapName, { ...tapArgs });
    await call(tapName, { ...tapArgs });
    await call(tapName, { ...tapArgs });

    // An agent taps every few seconds; re-requesting per call would spam the
    // UI and could yank back a user who navigated away.
    expect(opened).toHaveLength(1);
  });

  it("never steals a thread already watching another device on device_tap", async () => {
    const { backend, manager, call } = await setup();
    await backend.boot("FAKE-0002");
    await manager.attach(THREAD, "FAKE-0002");
    const opened = collectOpenPaneRequests(manager);

    await call(tapName, { ...tapArgs });

    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe("FAKE-0002");
    // The attachment the user chose survives; the request names the agent's
    // device, which stays reachable from the picker.
    expect(opened.map((event) => event.udid)).toEqual([DEVICE]);
  });

  it("does not surface the pane for device_list", async () => {
    const { manager, structured } = await setup();
    const opened = collectOpenPaneRequests(manager);

    await structured("device_list", { includeShutdown: true });

    // Pure discovery, usually called before the agent has picked a device.
    expect(opened).toHaveLength(0);
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBeNull();
  });

  it("does not surface the pane when the interaction fails", async () => {
    const { manager, call } = await setup();
    const opened = collectOpenPaneRequests(manager);

    const result = await call("device_tap", { udid: "FAKE-0002", x: 1, y: 1 });

    expect(result.isError).toBe(true);
    expect(opened).toHaveLength(0);
  });

  it("keeps the pane request idempotent across different interaction tools", async () => {
    const { manager, call } = await setup();
    const opened = collectOpenPaneRequests(manager);

    for (const [name, args] of INTERACTION_CALLS) await call(name, { ...args });

    expect(opened).toHaveLength(1);
    // One attach, so no duplicate stream for the pane to reconcile.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(DEVICE);
  });
});
