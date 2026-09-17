import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { COMPUTER_BROWSER_DRIVER_NAMES, COMPUTER_BROWSER_TOOL_NAMES } from "@synara/contracts";

import type { ComputerBrowserCall } from "../computer/ComputerBackend.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";
import {
  computerBrowserToolRequiresApproval,
  makeAgentGatewayComputerBrowserTools,
  type AgentGatewayComputerBrowserToolsOptions,
} from "./computerBrowserTools.ts";

const THREAD = "thread-browser";
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function makeContext(threadId = THREAD, turnId: string | null = "turn-browser"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:browser",
      threadId,
      provider: "claudeAgent",
      turnId,
    },
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:browser",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: turnId,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "synara-browser-ws-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function setup(options?: {
  backend?: FakeComputerBackend;
  authorizeAction?: AgentGatewayComputerBrowserToolsOptions["authorizeAction"];
  resolveWorkspaceRoot?: AgentGatewayComputerBrowserToolsOptions["resolveWorkspaceRoot"];
}) {
  const backend = options?.backend ?? new FakeComputerBackend({ browser: true });
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerBrowserTools({
    manager,
    ...(options?.authorizeAction ? { authorizeAction: options.authorizeAction } : {}),
    ...(options?.resolveWorkspaceRoot
      ? { resolveWorkspaceRoot: options.resolveWorkspaceRoot }
      : {}),
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    threadId = THREAD,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(threadId)));
  };
  return { backend, manager, byName, call };
}

function textOf(result: McpToolCallResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("computer_browser_* gateway tools", () => {
  it("registers the whole family on the computer:control capability with active-turn dispatch", () => {
    const tools = makeAgentGatewayComputerBrowserTools({
      manager: new ComputerManager({ backend: new FakeComputerBackend({ browser: true }) }),
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual([...COMPUTER_BROWSER_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.requiredCapability).toBe("computer:control");
      expect(tool.requiresActiveTurn).toBe(true);
    }
    const state = tools.find((tool) => tool.definition.name === "computer_browser_state");
    expect(state?.definition.annotations?.readOnlyHint).toBe(true);
    for (const tool of tools) {
      if (tool === state) continue;
      expect(tool.definition.annotations?.readOnlyHint).toBe(false);
    }
  });

  it("covers every gateway name with a driver name", () => {
    expect(Object.keys(COMPUTER_BROWSER_DRIVER_NAMES).toSorted()).toEqual(
      [...COMPUTER_BROWSER_TOOL_NAMES].toSorted(),
    );
  });

  it("requires approval for everything except state and dialog inspect", () => {
    expect(computerBrowserToolRequiresApproval("computer_browser_state", {})).toBe(false);
    expect(
      computerBrowserToolRequiresApproval("computer_browser_dialog", { action: "inspect" }),
    ).toBe(false);
    expect(
      computerBrowserToolRequiresApproval("computer_browser_dialog", { action: "accept" }),
    ).toBe(true);
    for (const name of COMPUTER_BROWSER_TOOL_NAMES) {
      if (name === "computer_browser_state" || name === "computer_browser_dialog") continue;
      expect(computerBrowserToolRequiresApproval(name, {})).toBe(true);
    }
  });

  it("binds and snapshots without an approval gate, passing the driver reply through", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_browser_state", {
      target_id: "t-1",
      tab_id: "tab-1",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ target_id: `fake-browser-${THREAD}` });
    expect(backend.callsFor("browser.get_browser_state")).toHaveLength(1);
  });

  it("refuses mutating calls before dispatch when the session has no approval gate", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_browser_click", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ComputerApprovalRequired");
    expect(backend.calls.filter((entry) => entry.method.startsWith("browser."))).toHaveLength(0);
  });

  it("surfaces a denial without dispatching", async () => {
    const { backend, call } = await setup({ authorizeAction: async () => false });
    const result = await call("computer_browser_type", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      text: "hello",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("denied");
    expect(backend.callsFor("browser.browser_type")).toHaveLength(0);
  });

  it("asks the gate once per mutating call and dispatches the mapped driver name", async () => {
    const seen: ComputerBrowserCall[] = [];
    const backend = new FakeComputerBackend({
      browser: (call) => {
        seen.push(call);
        return { structuredContent: { status: "ok" } };
      },
    });
    const asked: string[] = [];
    const { call } = await setup({
      backend,
      authorizeAction: async (name) => {
        asked.push(name);
        return true;
      },
    });
    const result = await call("computer_browser_click", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
    });
    expect(result.isError).not.toBe(true);
    expect(asked).toEqual(["computer_browser_click"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("browser_click");
    expect(seen[0]?.task).toMatchObject({ threadId: THREAD, turnId: "turn-browser" });
    expect(seen[0]?.mutation).toBe(true);
  });

  it("treats a driver refusal as a result, never a tool error", async () => {
    const backend = new FakeComputerBackend({
      browser: () => ({
        structuredContent: {
          status: "refused",
          refusal: { code: "browser_requires_setup", message: "Prepare a browser first." },
        },
        content: [{ type: "text", text: "refused (browser_requires_setup)" }],
      }),
    });
    const { call } = await setup({ backend });
    const result = await call("computer_browser_state", {
      target_id: "t",
      tab_id: "tab",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { code: "browser_requires_setup" },
    });
  });

  it("marks get_browser_state non-mutating on the wire but mutating otherwise", async () => {
    const seen: ComputerBrowserCall[] = [];
    const backend = new FakeComputerBackend({
      browser: (call) => {
        seen.push(call);
        return {};
      },
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    await call("computer_browser_state", { target_id: "t", tab_id: "tab" });
    await call("computer_browser_dialog", {
      target_id: "t",
      tab_id: "tab",
      action: "inspect",
    });
    await call("computer_browser_navigate", {
      target_id: "t",
      tab_id: "tab",
      url: "https://example.com/",
    });
    expect(seen.map((entry) => [entry.name, entry.mutation])).toEqual([
      ["get_browser_state", false],
      ["browser_dialog", true],
      ["browser_navigate", true],
    ]);
  });

  it("refuses an upload that resolves outside the workspace before it reaches the driver", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "synara-browser-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const file = join(outside, "secret.txt");
    await writeFile(file, "x");
    const { backend, call } = await setup({
      authorizeAction: async () => true,
      resolveWorkspaceRoot: () => Effect.succeed(root),
    });
    const result = await call("computer_browser_upload", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      files: [file],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("outside the active workspace");
    expect(backend.callsFor("browser.browser_set_input_files")).toHaveLength(0);
  });

  it("canonicalizes workspace upload paths before dispatch", async () => {
    const root = await workspace();
    const file = join(root, "attach.txt");
    await writeFile(file, "x");
    const seen: ComputerBrowserCall[] = [];
    const backend = new FakeComputerBackend({
      browser: (call) => {
        seen.push(call);
        return { structuredContent: { status: "ok" } };
      },
    });
    const { call } = await setup({
      backend,
      authorizeAction: async () => true,
      resolveWorkspaceRoot: () => Effect.succeed(root),
    });
    const result = await call("computer_browser_upload", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      files: [file],
    });
    expect(result.isError).not.toBe(true);
    expect(seen[0]?.name).toBe("browser_set_input_files");
    // The driver receives the canonical path — /var resolves to /private/var
    // on macOS — so a symlink can never widen the approved set.
    expect(seen[0]?.args.files).toEqual([await realpath(file)]);
  });

  it("refuses file transfer tools outright when no workspace boundary exists", async () => {
    const { backend, call } = await setup({ authorizeAction: async () => true });
    const upload = await call("computer_browser_upload", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      files: ["/tmp/anything.txt"],
    });
    expect(upload.isError).toBe(true);
    expect(textOf(upload)).toContain("No canonical workspace");
    const download = await call("computer_browser_download", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      destination_root: "/tmp",
    });
    expect(download.isError).toBe(true);
    expect(backend.calls.filter((entry) => entry.method.startsWith("browser."))).toHaveLength(0);
  });

  it("bounds the download destination to the workspace", async () => {
    const root = await workspace();
    const seen: ComputerBrowserCall[] = [];
    const backend = new FakeComputerBackend({
      browser: (call) => {
        seen.push(call);
        return { structuredContent: { status: "ok" } };
      },
    });
    const { call } = await setup({
      backend,
      authorizeAction: async () => true,
      resolveWorkspaceRoot: () => Effect.succeed(root),
    });
    const denied = await call("computer_browser_download", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      destination_root: tmpdir(),
    });
    expect(denied.isError).toBe(true);
    const allowed = await call("computer_browser_download", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      destination_root: root,
    });
    expect(allowed.isError).not.toBe(true);
    expect(seen.map((entry) => entry.name)).toEqual(["browser_download"]);
  });

  it("reports no browser route on a desktop-only backend", async () => {
    const backend = new FakeComputerBackend();
    const { manager, call } = await setup({ backend });
    expect(manager.supportsBrowser).toBe(false);
    const result = await call("computer_browser_state", { target_id: "t", tab_id: "tab" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not provide browser automation");
  });

  it("ends the driver browser session when the thread is removed", async () => {
    const backend = new FakeComputerBackend({ browser: true });
    const { manager, call } = await setup({ backend });
    await call("computer_browser_state", { target_id: "t", tab_id: "tab" });
    await manager.handleThreadRemoved(THREAD);
    expect(backend.callsFor("browser.endThread").map((entry) => entry.args[0])).toEqual([THREAD]);
  });
});
