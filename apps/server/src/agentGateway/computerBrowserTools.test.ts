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

/** A driver reply that binds target bt-1 with the given tabs. */
function bindingResult(tabs: ReadonlyArray<Record<string, unknown>>) {
  return {
    content: [
      {
        type: "text",
        text: `bound target bt-1 (exact) with ${tabs.length} tab(s)`,
      },
    ],
    structuredContent: {
      status: "ok",
      mode: "bind",
      binding_quality: "exact",
      native_title: "about:blank",
      target_id: "bt-1",
      tabs,
    },
  };
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

  it("states the rev-30/31 browser contract: headless default, pid-only bind, isolated_named", () => {
    const tools = makeAgentGatewayComputerBrowserTools({
      manager: new ComputerManager({ backend: new FakeComputerBackend({ browser: true }) }),
    });
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    const prepare = byName.get("computer_browser_prepare");
    expect(prepare?.definition.description).toContain("headless by default");
    expect(prepare?.definition.description).toContain("windowed:true");
    expect(prepare?.definition.description).toContain("isolated_named");
    // The existing-profile attach wording stays the consent-gated contract.
    expect(prepare?.definition.description).toContain("browser_consent_required");
    const prepareSchema = prepare?.definition.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(prepareSchema.properties?.windowed).toBeDefined();
    const state = byName.get("computer_browser_state");
    expect(state?.definition.description).toContain("driver_owned_headless");
    const stateSchema = state?.definition.inputSchema as {
      properties?: { window_id?: { description?: string } };
    };
    expect(stateSchema.properties?.window_id?.description).toContain(
      "Omit it for a driver-owned headless browser",
    );
    expect(stateSchema.properties?.window_id?.description).not.toContain("required with pid");
    const type = byName.get("computer_browser_type");
    const typeSchema = type?.definition.inputSchema as {
      properties?: { input_route?: { enum?: readonly string[] } };
    };
    expect(typeSchema.properties?.input_route?.enum).toEqual(["trusted", "dom_event"]);
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

describe("browser id ergonomics", () => {
  const oneTab = [{ tab_id: "tab-1", active: true, title: "about:blank", url: "about:blank" }];

  it("labels target_id and tab_id in the bind result instead of leaving the model to guess", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "get_browser_state"
          ? bindingResult(oneTab)
          : { structuredContent: { status: "ok" } },
    });
    const { call } = await setup({ backend });
    const result = await call("computer_browser_state", { pid: 33_526, window_id: 8_196 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ target_id: "bt-1", tab_id: "tab-1" });
    expect(textOf(result)).toContain("target_id=bt-1");
    expect(textOf(result)).toContain("tab_id=tab-1");
  });

  it("resolves an omitted tab_id in navigate from the last bind", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "get_browser_state"
          ? bindingResult(oneTab)
          : { structuredContent: { status: "ok" } },
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    await call("computer_browser_state", { pid: 33_526, window_id: 8_196 });
    const result = await call("computer_browser_navigate", {
      target_id: "bt-1",
      url: "https://www.newegg.com/",
    });
    expect(result.isError).not.toBe(true);
    const navigations = backend.callsFor("browser.browser_navigate");
    expect(navigations).toHaveLength(1);
    expect(navigations[0]?.args[0]).toMatchObject({ target_id: "bt-1", tab_id: "tab-1" });
  });

  it("resolves an omitted tab_id in a snapshot from the same bind", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "get_browser_state"
          ? bindingResult(oneTab)
          : { structuredContent: { status: "ok" } },
    });
    const { call } = await setup({ backend });
    await call("computer_browser_state", { pid: 33_526, window_id: 8_196 });
    await call("computer_browser_state", { target_id: "bt-1" });
    const states = backend.callsFor("browser.get_browser_state");
    expect(states).toHaveLength(2);
    expect(states[1]?.args[0]).toMatchObject({ target_id: "bt-1", tab_id: "tab-1" });
  });

  it("defaults to the single active tab when several are open", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "get_browser_state"
          ? bindingResult([
              { tab_id: "tab-a", active: false },
              { tab_id: "tab-b", active: true },
            ])
          : { structuredContent: { status: "ok" } },
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    const bound = await call("computer_browser_state", { pid: 1, window_id: 2 });
    expect(bound.structuredContent).toMatchObject({ tab_id: "tab-b" });
    await call("computer_browser_navigate", { target_id: "bt-1", url: "https://example.com/" });
    expect(backend.callsFor("browser.browser_navigate")[0]?.args[0]).toMatchObject({
      tab_id: "tab-b",
    });
  });

  it("refuses an ambiguous target with its tab listing and dispatches nothing", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "get_browser_state"
          ? bindingResult([
              { tab_id: "tab-a", active: false },
              { tab_id: "tab-b", active: false },
            ])
          : { structuredContent: { status: "ok" } },
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    await call("computer_browser_state", { pid: 1, window_id: 2 });
    const result = await call("computer_browser_navigate", {
      target_id: "bt-1",
      url: "https://example.com/",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { code: "browser_tab_required" },
    });
    expect(textOf(result)).toContain("tab-a");
    expect(textOf(result)).toContain("tab-b");
    expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
  });

  it("refuses an omitted tab_id for a target this thread never bound", async () => {
    const backend = new FakeComputerBackend({ browser: true });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    const result = await call("computer_browser_navigate", {
      target_id: "bt-never-bound",
      url: "https://example.com/",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { code: "browser_tab_required" },
    });
    expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
  });

  it("does not resolve a target that belongs to another thread", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "get_browser_state"
          ? bindingResult(oneTab)
          : { structuredContent: { status: "ok" } },
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    await call("computer_browser_state", { pid: 1, window_id: 2 }, THREAD);
    const result = await call(
      "computer_browser_navigate",
      { target_id: "bt-1", url: "https://example.com/" },
      "other-thread",
    );
    expect(result.structuredContent).toMatchObject({ refusal: { code: "browser_tab_required" } });
    expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
  });

  it("explains a swapped target/tab id when the driver cannot find the tab", async () => {
    const backend = new FakeComputerBackend({
      browser: () => ({
        structuredContent: {
          status: "refused",
          refusal: {
            code: "browser_tab_not_found",
            message: "tab bt-85991064 is not known for target bt-85991064",
          },
        },
      }),
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    const result = await call("computer_browser_navigate", {
      target_id: "bt-85991064",
      tab_id: "bt-85991064",
      url: "https://example.com/",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { code: "browser_tab_not_found" },
    });
    expect(textOf(result)).toContain("is a target id, not a tab id");
    expect(textOf(result)).toContain("tab-");
  });

  it("labels the bind key on a prepare result and leaves tab_id optional on target tools", async () => {
    const backend = new FakeComputerBackend({
      browser: (call) =>
        call.name === "browser_prepare"
          ? {
              structuredContent: {
                status: "ok",
                prepared: true,
                prepared_pid: 33_526,
                action: "launched_isolated_browser",
              },
            }
          : { structuredContent: { status: "ok" } },
    });
    const { call, byName } = await setup({ backend, authorizeAction: async () => true });
    const prepared = await call("computer_browser_prepare", {
      allow_launch: true,
      profile: { mode: "isolated_new" },
    });
    expect(textOf(prepared)).toContain("prepared_pid=33526");
    expect(textOf(prepared)).toContain("computer_browser_state");
    expect(textOf(prepared)).toContain("takes pid alone");
    for (const name of [
      "computer_browser_navigate",
      "computer_browser_click",
      "computer_browser_type",
      "computer_browser_dialog",
      "computer_browser_upload",
      "computer_browser_download",
      "computer_browser_pointer",
      "computer_browser_press",
    ]) {
      const required = byName.get(name)?.definition.inputSchema.required as string[];
      expect(required).toContain("target_id");
      expect(required).not.toContain("tab_id");
    }
  });
});
