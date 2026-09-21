import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderKind } from "@synara/contracts";

import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import { UnavailableComputerBackend } from "../computer/UnavailableComputerBackend.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  makeAgentGatewayComputerTools,
  type AgentGatewayComputerToolsOptions,
} from "./computerTools.ts";
import {
  canonicalSynaraComputerToolName,
  isSynaraComputerToolFamilyName,
  SYNARA_COMPUTER_TOOL_NAMES,
} from "./computerToolPermission.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-visibility";

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
}

function resultText(result: McpToolCallResult): string {
  return result.content.map((entry) => (entry.type === "text" ? entry.text : "")).join("\n");
}

function makeContext(provider: ProviderKind = "claudeAgent", threadId = THREAD): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:visibility",
      threadId,
      provider,
      turnId: "turn-visibility",
    },
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:visibility",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-visibility",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(
  backend = new FakeComputerBackend(),
  authorizeAction?: AgentGatewayComputerToolsOptions["authorizeAction"],
  /** Defaults to the user having asked to see the screen; the gate's own tests override it. */
  resolveForegroundAuthorization: AgentGatewayComputerToolsOptions["resolveForegroundAuthorization"] = async () => ({
    userRequestedVisibleUse: true,
  }),
) {
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerTools({
    manager,
    ...(authorizeAction ? { authorizeAction } : {}),
    resolveForegroundAuthorization,
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
    threadId?: string,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider, threadId)));
  };
  return { backend, manager, tools, byName, call };
}

/** A backend that never implemented the visibility lifecycle methods. */
function withoutVisibility(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "setWindowMinimized" || property === "setAppVisibility"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

describe("computer_set_window_minimized", () => {
  it("is approval-gated and minimizes the exact window without activating it", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_set_window_minimized")).toBe(true);

    const result = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: true,
    });
    expect(approval).toHaveBeenCalledWith(
      "computer_set_window_minimized",
      expect.objectContaining({ window_id: "fake-calculator", minimized: true }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.isError).not.toBe(true);
    const payload = resultJson(result) as {
      action: string;
      windowId: string;
      delivery?: { verified: string; effect?: string };
    };
    expect(payload.action).toBe("computer_set_window_minimized");
    expect(payload.windowId).toBe("fake-calculator");
    expect(payload.delivery).toMatchObject({ verified: "confirmed", effect: "verified" });
    // Off screen but still listed — the semantic tools keep it addressable.
    const window = (await backend.listWindows()).find(
      (candidate) => candidate.id === "fake-calculator",
    );
    expect(window).toMatchObject({ minimized: true, visible: false });
    // Nothing activated and nothing was aimed: the window-level visibility
    // write never reaches the raise/focus actuators. (`focused` on the fake is
    // the agent's input aim, which the lease claim itself clears — it is not
    // frontmost state.)
    expect(
      (await backend.listWindows()).find((candidate) => candidate.id === "fake-terminal"),
    ).toMatchObject({ visible: true });
    expect(backend.callsFor("raiseWindow")).toEqual([]);
    expect(backend.callsFor("focusWindow")).toEqual([]);
  });

  it("restores the same window in place", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: true,
    });
    const restored = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: false,
    });
    expect(restored.isError).not.toBe(true);
    const window = (await backend.listWindows()).find(
      (candidate) => candidate.id === "fake-calculator",
    );
    expect(window).toMatchObject({ minimized: false, visible: true });
  });

  it("refuses bad arguments and a foreground mode it cannot honor before dispatch", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);

    const foreground = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: true,
      delivery_mode: "foreground",
    });
    expect(foreground.isError).toBe(true);
    expect(resultText(foreground)).toContain("never activates");
    const missingWindow = await call("computer_set_window_minimized", {
      window_id: "no-such-window",
      minimized: true,
    });
    expect(missingWindow.isError).toBe(true);
    const missingFlag = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
    });
    expect(missingFlag.isError).toBe(true);
    const wrongType = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: "yes",
    });
    expect(wrongType.isError).toBe(true);
    const missingId = await call("computer_set_window_minimized", { minimized: true });
    expect(missingId.isError).toBe(true);
    expect(backend.callsFor("setWindowMinimized")).toEqual([]);
  });

  it("hides another app's window without asking", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { manager, call } = await setup(backend, approval);
    try {
      // Both windows minimize: only the denylist can refuse a drive.
      const first = await call("computer_set_window_minimized", {
        window_id: "fake-terminal",
        minimized: true,
      });
      expect(first.isError).not.toBe(true);
      const second = await call("computer_set_window_minimized", {
        window_id: "fake-calculator",
        minimized: true,
      });
      expect(second.isError).not.toBe(true);
      expect(backend.callsFor("setWindowMinimized").length).toBe(2);
    } finally {
      await manager.dispose();
    }
  });

  it("dispatches nothing when approval is refused", async () => {
    const approval = vi.fn(async () => false);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: true,
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("setWindowMinimized")).toEqual([]);
    expect(
      (await backend.listWindows()).find((window) => window.id === "fake-calculator"),
    ).toMatchObject({ minimized: false, visible: true });
  });

  it("refuses cleanly on a backend without the write and carries the unavailable message", async () => {
    const approval = vi.fn(async () => true);
    const { call } = await setup(withoutVisibility(new FakeComputerBackend()), approval);
    const result = await call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: true,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("cannot minimize or restore windows");

    const unavailable = await setup(
      new UnavailableComputerBackend("the display link is gone") as never,
      approval,
    );
    const refused = await unavailable.call("computer_set_window_minimized", {
      window_id: "fake-calculator",
      minimized: true,
    });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toContain("the display link is gone");
  });
});

describe("computer_set_app_visibility", () => {
  it("is approval-gated and hides a running app by pid without activating it", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_set_app_visibility")).toBe(true);

    const result = await call("computer_set_app_visibility", { pid: 1_002, hidden: true });
    expect(approval).toHaveBeenCalledWith(
      "computer_set_app_visibility",
      expect.objectContaining({ pid: 1_002, hidden: true }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.isError).not.toBe(true);
    const payload = resultJson(result) as {
      action: string;
      delivery?: { verified: string; effect?: string };
    };
    expect(payload.action).toBe("computer_set_app_visibility");
    expect(payload.delivery).toMatchObject({ verified: "confirmed", effect: "verified" });
    // Every window of that pid leaves the screen; the other app's stays.
    const windows = await backend.listWindows();
    expect(windows.find((window) => window.id === "fake-calculator")).toMatchObject({
      visible: false,
    });
    expect(windows.find((window) => window.id === "fake-terminal")).toMatchObject({
      visible: true,
    });
    expect(backend.callsFor("raiseWindow")).toEqual([]);
    expect(backend.callsFor("focusWindow")).toEqual([]);
  });

  it("unhides the app's windows in place", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    await call("computer_set_app_visibility", { pid: 1_002, hidden: true });
    const restored = await call("computer_set_app_visibility", { pid: 1_002, hidden: false });
    expect(restored.isError).not.toBe(true);
    expect(
      (await backend.listWindows()).find((window) => window.id === "fake-calculator"),
    ).toMatchObject({ visible: true });
  });

  it("refuses a bad pid, a missing flag, and foreground delivery before dispatch", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);

    for (const args of [
      { pid: 0, hidden: true },
      { pid: -3, hidden: true },
      { pid: 1.5, hidden: true },
      { pid: "1002", hidden: true },
      { pid: 1_002 },
      { pid: 1_002, hidden: "yes" },
      { hidden: true },
      { pid: 1_002, hidden: true, delivery_mode: "foreground" },
    ]) {
      const result = await call("computer_set_app_visibility", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(backend.callsFor("setAppVisibility")).toEqual([]);
  });

  it("hides the app a pid resolves to without asking", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { manager, call } = await setup(backend, approval);
    try {
      const first = await call("computer_set_window_minimized", {
        window_id: "fake-terminal",
        minimized: true,
      });
      expect(first.isError).not.toBe(true);
      // pid 1002 resolves to the calculator: an ordinary drive, so it hides.
      const second = await call("computer_set_app_visibility", { pid: 1_002, hidden: true });
      expect(second.isError).not.toBe(true);
      expect(backend.callsFor("setAppVisibility")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("reaches the backend refusal for a pid that names no running app", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    // A pid nothing resolves to still admits under the stable pid key — the
    // boundary is never skipped for want of a name — then the backend's own
    // "no such app" refusal is what surfaces.
    const result = await call("computer_set_app_visibility", { pid: 9_999, hidden: true });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("No running application has pid 9999");
    expect(backend.callsFor("setAppVisibility")).toHaveLength(1);
  });

  it("dispatches nothing when approval is refused", async () => {
    const approval = vi.fn(async () => false);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_set_app_visibility", { pid: 1_002, hidden: true });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("setAppVisibility")).toEqual([]);
  });

  it("refuses cleanly on a backend without the write and carries the unavailable message", async () => {
    const approval = vi.fn(async () => true);
    const { call } = await setup(withoutVisibility(new FakeComputerBackend()), approval);
    const result = await call("computer_set_app_visibility", { pid: 1_002, hidden: true });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("cannot hide or unhide applications");

    const unavailable = await setup(
      new UnavailableComputerBackend("the display link is gone") as never,
      approval,
    );
    const refused = await unavailable.call("computer_set_app_visibility", {
      pid: 1_002,
      hidden: true,
    });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toContain("the display link is gone");
  });
});

describe("computer_launch_app hidden", () => {
  it("launches the app off-screen — created but never rendered, never focused", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_launch_app", {
      app: "TextEdit",
      hidden: true,
      wait_for_window: false,
    });
    expect(result.isError).not.toBe(true);
    // The option arrives as the third argument only when asked for.
    expect(backend.callsFor("launchApp").at(-1)?.args).toEqual(["TextEdit", [], { hidden: true }]);
    const windows = await backend.listWindows();
    const launched = windows.find((window) => window.appName === "TextEdit");
    expect(launched).toMatchObject({ focused: false, visible: false });
    // The other windows' flags are untouched: a hidden launch takes no focus
    // and renders nothing over them.
    expect(windows.find((window) => window.id === "fake-terminal")).toMatchObject({
      visible: true,
    });
    expect(backend.callsFor("raiseWindow")).toEqual([]);
  });

  it("creates an available background window without foreground authorization", async () => {
    const backend = new FakeComputerBackend({ agentDialect: "macos" });
    const { call } = await setup(
      backend,
      vi.fn(async () => true),
      async () => ({
        userRequestedVisibleUse: false,
      }),
    );
    const before = await backend.listWindows();
    for (const options of [{}, { hidden: false }]) {
      const result = await call("computer_launch_app", {
        app: "TextEdit",
        wait_for_window: false,
        ...options,
      });
      expect(result.isError).not.toBe(true);
    }
    expect(backend.callsFor("launchApp").map((call) => call.args)).toEqual([
      ["TextEdit", []],
      ["TextEdit", [], { hidden: false }],
    ]);
    const after = await backend.listWindows();
    expect(after.filter((window) => window.appName === "TextEdit")).toEqual([
      expect.objectContaining({ focused: false, visible: true }),
      expect.objectContaining({ focused: false, visible: true }),
    ]);
    for (const existing of before) {
      expect(after.find((window) => window.id === existing.id)?.visible).toBe(existing.visible);
    }
    expect(backend.callsFor("raiseWindow")).toEqual([]);
    expect(backend.callsFor("focusWindow")).toEqual([]);
  });
});

describe("hidden-workspace run steps", () => {
  it("runs the visibility lifecycle steps in order inside one approved sequence", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_run", {
      steps: [
        { type: "launch_app", app: "org.kde.konsole", hidden: true, wait_for_window: false },
        { type: "set_window_minimized", window_id: "fake-terminal", minimized: true },
        { type: "set_app_visibility", pid: 1_002, hidden: true },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("launchApp").at(-1)?.args).toEqual([
      "org.kde.konsole",
      [],
      { hidden: true },
    ]);
    expect(backend.callsFor("setWindowMinimized").at(-1)?.args).toEqual(["fake-terminal", true]);
    expect(backend.callsFor("setAppVisibility").at(-1)?.args).toEqual([1_002, true]);
  });

  it("refuses a malformed visibility step before anything dispatches", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    for (const steps of [
      [{ type: "set_window_minimized", minimized: true }],
      [{ type: "set_window_minimized", window_id: "fake-terminal" }],
      [{ type: "set_app_visibility", hidden: true }],
      [{ type: "set_app_visibility", pid: 1_002 }],
      [{ type: "set_app_visibility", pid: -1, hidden: true }],
    ]) {
      const result = await call("computer_run", { steps });
      expect(result.isError, JSON.stringify(steps)).toBe(true);
    }
    expect(backend.callsFor("setWindowMinimized")).toEqual([]);
    expect(backend.callsFor("setAppVisibility")).toEqual([]);
  });
});

describe("tool-name registry", () => {
  it("owns the visibility lifecycle names in all three provider spellings", async () => {
    const { byName } = await setup();
    for (const name of ["computer_set_window_minimized", "computer_set_app_visibility"]) {
      expect(byName.has(name), `gateway serves ${name}`).toBe(true);
      expect(SYNARA_COMPUTER_TOOL_NAMES).toContain(name);
      expect(canonicalSynaraComputerToolName(`synara_${name}`)).toBe(name);
      expect(canonicalSynaraComputerToolName(`mcp__synara__${name}`)).toBe(name);
      expect(isSynaraComputerToolFamilyName(name)).toBe(true);
    }
  });
});
