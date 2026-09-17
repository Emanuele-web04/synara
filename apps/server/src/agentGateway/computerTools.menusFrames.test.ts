import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderKind } from "@synara/contracts";

import { ComputerBackendError } from "../computer/ComputerBackend.ts";
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

const THREAD = "thread-gap4";

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
      sessionKey: "gateway-session:gap4",
      threadId,
      provider,
      turnId: "turn-gap4",
    },
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:gap4",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-gap4",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(
  backend = new FakeComputerBackend(),
  authorizeAction?: AgentGatewayComputerToolsOptions["authorizeAction"],
) {
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerTools({
    manager,
    ...(authorizeAction ? { authorizeAction } : {}),
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

/** A backend that never implemented the optional app/frame/menu methods. */
function withoutGapFour(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "listApps" || property === "setWindowFrame" || property === "invokeMenu"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

describe("computer_list_apps", () => {
  it("lists apps with the metadata the driver reports, without an approval gate", async () => {
    const approval = vi.fn(async () => true);
    const { call, byName } = await setup(
      new FakeComputerBackend({
        apps: [
          {
            pid: 42,
            name: "TextEdit",
            bundleId: "com.apple.TextEdit",
            running: true,
            active: true,
            launchPath: "/System/Applications/TextEdit.app",
            windowCount: 1,
          },
          {
            pid: 0,
            name: "Chess",
            bundleId: "com.apple.Chess",
            running: false,
            active: false,
            launchPath: "/System/Applications/Chess.app",
          },
        ],
      }),
      approval,
    );
    const definition = byName.get("computer_list_apps")?.definition;
    expect(definition?.annotations).toMatchObject({ readOnlyHint: true });
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_list_apps")).toBe(false);

    const result = await call("computer_list_apps", {});
    expect(result.isError).not.toBe(true);
    const payload = resultJson(result) as {
      apps: Array<Record<string, unknown>>;
      availability: { kind: string };
      computerId: string;
    };
    expect(payload.computerId).toBe("desktop");
    expect(payload.availability.kind).toBe("available");
    expect(payload.apps).toEqual([
      expect.objectContaining({
        pid: 42,
        name: "TextEdit",
        bundleId: "com.apple.TextEdit",
        running: true,
        active: true,
        launchPath: "/System/Applications/TextEdit.app",
        windowCount: 1,
      }),
      // Installed-but-not-running rows survive: "is X installed?" is the tool's
      // other half, and the driver reports those with pid 0.
      expect.objectContaining({ pid: 0, name: "Chess", running: false, active: false }),
    ]);
    expect(approval).not.toHaveBeenCalled();
  });

  it("refuses cleanly on a backend that cannot enumerate applications", async () => {
    const { call } = await setup(withoutGapFour(new FakeComputerBackend()));
    const result = await call("computer_list_apps", {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("cannot enumerate applications");
  });

  it("surfaces the unavailable backend's own message", async () => {
    const { call } = await setup(
      new UnavailableComputerBackend("the display link is gone") as never,
    );
    const result = await call("computer_list_apps", {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("the display link is gone");
  });
});

describe("computer_set_window_frame", () => {
  it("is approval-gated and moves the exact window, reporting a verified result", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_set_window_frame")).toBe(true);

    const result = await call("computer_set_window_frame", {
      window_id: "fake-calculator",
      x: 200,
      y: 300,
      width: 800,
      height: 600,
    });
    expect(approval).toHaveBeenCalledWith(
      "computer_set_window_frame",
      expect.objectContaining({ window_id: "fake-calculator" }),
      expect.anything(),
      expect.anything(),
    );
    expect(result.isError).not.toBe(true);
    const payload = resultJson(result) as {
      action: string;
      windowId: string;
      delivery?: { verified: string; effect?: string };
    };
    expect(payload.action).toBe("computer_set_window_frame");
    expect(payload.windowId).toBe("fake-calculator");
    expect(payload.delivery).toMatchObject({ verified: "confirmed", effect: "verified" });
    // The fake's own window list is the readback the result stands on.
    const windows = await backend.listWindows();
    expect(windows.find((window) => window.id === "fake-calculator")?.bounds).toEqual({
      x: 200,
      y: 300,
      width: 800,
      height: 600,
    });
  });

  it("reports dispatched-unknown when the readback does not show the frame", async () => {
    const backend = new FakeComputerBackend();
    backend.setFrameApplies(false);
    const { call } = await setup(backend);
    const result = await call("computer_set_window_frame", {
      window_id: "fake-calculator",
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
    expect(result.isError).not.toBe(true);
    const payload = resultJson(result) as { delivery?: { verified: string; effect?: string } };
    expect(payload.delivery).toMatchObject({
      verified: "unconfirmed",
      effect: "dispatched-unknown",
    });
  });

  it("refuses a nonpositive frame and an unknown window before dispatch", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);

    const badSize = await call("computer_set_window_frame", {
      window_id: "fake-calculator",
      x: 0,
      y: 0,
      width: 0,
      height: 480,
    });
    expect(badSize.isError).toBe(true);
    const missingWindow = await call("computer_set_window_frame", {
      window_id: "no-such-window",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(missingWindow.isError).toBe(true);
    const missingId = await call("computer_set_window_frame", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(missingId.isError).toBe(true);
    expect(backend.callsFor("setWindowFrame")).toEqual([]);
  });

  it("dispatches nothing when approval is refused", async () => {
    const approval = vi.fn(async () => false);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_set_window_frame", {
      window_id: "fake-calculator",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("setWindowFrame")).toEqual([]);
    expect(
      (await backend.listWindows()).find((window) => window.id === "fake-calculator")?.bounds,
    ).toEqual({ x: 1_050, y: 120, width: 420, height: 620 });
  });
});

describe("computer_invoke_menu", () => {
  it("is approval-gated and invokes the exact path on the window's app", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_invoke_menu")).toBe(true);

    const result = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["File", "Save"],
    });
    expect(result.isError).not.toBe(true);
    const payload = resultJson(result) as {
      action: string;
      windowId: string;
      delivery?: { verified: string };
    };
    expect(payload.action).toBe("computer_invoke_menu");
    expect(payload.windowId).toBe("fake-terminal");
    expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
      "fake-terminal",
      ["File", "Save"],
    ]);
  });

  it("bounds the path the same way the schema advertises", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);

    const empty = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: [],
    });
    expect(empty.isError).toBe(true);
    const tooDeep = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["1", "2", "3", "4", "5", "6", "7"],
    });
    expect(tooDeep.isError).toBe(true);
    const blank = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["File", "   "],
    });
    expect(blank.isError).toBe(true);
    expect(backend.callsFor("invokeMenu")).toEqual([]);
  });

  it("preserves a disabled-item refusal instead of falling back to pixels", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    backend.refuseMenuPath(
      ["Edit", "Undo"],
      new ComputerBackendError("The menu item is disabled.", {
        rejectedOperation: "invokeMenu",
      }),
    );
    const { call } = await setup(backend, approval);
    const result = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["Edit", "Undo"],
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("disabled");
    // The refusal is persistent state, not a one-off: a replay is refused too.
    const replay = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["Edit", "Undo"],
    });
    expect(replay.isError).toBe(true);
  });

  it("requires second-app consent before driving another app's menus", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { manager, call } = await setup(backend, approval);
    manager.setSecondAppApprovalHandler(async () => false);
    // First call admits the terminal's app; the calculator is the second app.
    const first = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["File"],
    });
    expect(first.isError).not.toBe(true);
    const second = await call("computer_invoke_menu", {
      window_id: "fake-calculator",
      path: ["File"],
    });
    expect(second.isError).toBe(true);
    expect(resultText(second)).toContain("second app");
    expect(backend.callsFor("invokeMenu").length).toBe(1);
  });

  it("dispatches nothing when approval is refused", async () => {
    const approval = vi.fn(async () => false);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_invoke_menu", {
      window_id: "fake-terminal",
      path: ["File", "Quit"],
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("invokeMenu")).toEqual([]);
  });
});

describe("tool-name registry", () => {
  it("owns every served tool name in all three provider spellings", async () => {
    const { byName } = await setup();
    for (const name of [
      "computer_list_apps",
      "computer_set_window_frame",
      "computer_invoke_menu",
      "computer_verify_state",
      "computer_zoom",
      "computer_kill_app",
    ]) {
      // A served tool that the registry does not own dies two ways: the
      // denial card cannot route it and the provider permission path treats
      // it as foreign.
      expect(byName.has(name), `gateway serves ${name}`).toBe(true);
      expect(SYNARA_COMPUTER_TOOL_NAMES).toContain(name);
      expect(canonicalSynaraComputerToolName(`synara_${name}`)).toBe(name);
      expect(canonicalSynaraComputerToolName(`mcp__synara__${name}`)).toBe(name);
      expect(isSynaraComputerToolFamilyName(name)).toBe(true);
    }
  });
});

describe("computer_run step coverage", () => {
  it("runs frame and menu steps in order inside one approved sequence", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const result = await call("computer_run", {
      steps: [
        {
          type: "set_window_frame",
          window_id: "fake-calculator",
          x: 10,
          y: 10,
          width: 500,
          height: 400,
        },
        { type: "invoke_menu", window_id: "fake-terminal", path: ["File"] },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("setWindowFrame").at(-1)?.args).toEqual([
      "fake-calculator",
      { x: 10, y: 10, width: 500, height: 400 },
    ]);
    expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual(["fake-terminal", ["File"]]);
  });

  it("refuses a run step missing its window or a menu path that is too deep", async () => {
    const approval = vi.fn(async () => true);
    const backend = new FakeComputerBackend();
    const { call } = await setup(backend, approval);
    const missingWindow = await call("computer_run", {
      steps: [{ type: "set_window_frame", x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(missingWindow.isError).toBe(true);
    const deepMenu = await call("computer_run", {
      steps: [
        {
          type: "invoke_menu",
          window_id: "fake-terminal",
          path: ["1", "2", "3", "4", "5", "6", "7"],
        },
      ],
    });
    expect(deepMenu.isError).toBe(true);
    expect(backend.callsFor("invokeMenu")).toEqual([]);
  });
});
