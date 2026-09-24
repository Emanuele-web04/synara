import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPUTER_BROWSER_TOOL_NAMES } from "@synara/contracts";

import type { ComputerBrowserCall } from "../computer/ComputerBackend.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { desktopDeliveryMode } from "../computer/DesktopOperationQueue.ts";
import { isModelDesktopObservationActive } from "../computer/modelDesktopObservation.ts";
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
  resolveForegroundAuthorization?: AgentGatewayComputerBrowserToolsOptions["resolveForegroundAuthorization"];
  resolveWorkspaceRoot?: AgentGatewayComputerBrowserToolsOptions["resolveWorkspaceRoot"];
}) {
  const backend = options?.backend ?? new FakeComputerBackend({ browser: true });
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerBrowserTools({
    manager,
    ...(options?.authorizeAction ? { authorizeAction: options.authorizeAction } : {}),
    ...(options?.resolveForegroundAuthorization
      ? { resolveForegroundAuthorization: options.resolveForegroundAuthorization }
      : {}),
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
  it("authorizes fresh browser observations only while the model state call runs", async () => {
    const { backend, call } = await setup({ authorizeAction: async () => true });
    const scopes: boolean[] = [];
    const originalCall = backend.browser!.call;
    vi.spyOn(backend.browser!, "call").mockImplementation((request) => {
      scopes.push(isModelDesktopObservationActive());
      return originalCall(request);
    });
    await call("computer_browser_state", { pid: 123 });
    await call("computer_browser_prepare", { allow_launch: true });
    expect(scopes).toEqual([true, false]);
    expect(isModelDesktopObservationActive()).toBe(false);
  });
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

  it.each(["missing", "not requested", "failed"] as const)(
    "refuses a visible browser launch despite full action access when visibility is %s",
    async (state) => {
      const authorizeAction = vi.fn(async () => true);
      const { backend, manager, call } = await setup({
        authorizeAction,
        ...(state !== "missing"
          ? {
              resolveForegroundAuthorization: async () => {
                if (state === "failed") throw new Error("Thread state unavailable");
                return { userRequestedVisibleUse: false };
              },
            }
          : {}),
      });
      const audit = vi.spyOn(manager, "recordComputerAudit");
      const result = await call("computer_browser_prepare", {
        allow_launch: true,
        windowed: true,
        profile: { mode: "isolated_new" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("foreground_not_requested");
      expect(authorizeAction).not.toHaveBeenCalled();
      expect(backend.callsFor("browser.browser_prepare")).toHaveLength(0);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          effect: "not-dispatched",
          code: "foreground_not_requested",
        }),
      );
    },
  );

  it("allows an explicitly requested visible browser and checks the next call again", async () => {
    let userRequestedVisibleUse = true;
    const visibility = vi.fn(async () => ({ userRequestedVisibleUse }));
    const { backend, call } = await setup({
      authorizeAction: async () => true,
      resolveForegroundAuthorization: visibility,
    });
    const modes: string[] = [];
    const originalCall = backend.browser!.call;
    vi.spyOn(backend.browser!, "call").mockImplementation((request) => {
      modes.push(desktopDeliveryMode());
      return originalCall(request);
    });
    const args = { allow_launch: true, windowed: true, profile: { mode: "isolated_new" } };
    const allowed = await call("computer_browser_prepare", args);
    expect(allowed.isError).not.toBe(true);
    expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
    expect(visibility).toHaveBeenCalledWith(
      expect.objectContaining({ callerThreadId: THREAD, callerTurnId: "turn-browser" }),
    );

    userRequestedVisibleUse = false;
    const revoked = await call("computer_browser_prepare", args);
    expect(textOf(revoked)).toContain("foreground_not_requested");
    expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
    expect(visibility).toHaveBeenCalledTimes(3);
    expect(modes).toEqual(["foreground"]);
    await call("computer_browser_prepare", { ...args, windowed: false });
    expect(modes).toEqual(["foreground", "background"]);
  });

  it("refuses when visible-use authorization changes while ordinary approval is pending", async () => {
    let userRequestedVisibleUse = true;
    const approval = Promise.withResolvers<boolean>();
    const approvalStarted = Promise.withResolvers<void>();
    const visibility = vi.fn(async () => ({ userRequestedVisibleUse }));
    const { backend, call } = await setup({
      authorizeAction: async () => {
        approvalStarted.resolve();
        return approval.promise;
      },
      resolveForegroundAuthorization: visibility,
    });
    const pending = call("computer_browser_prepare", {
      allow_launch: true,
      windowed: true,
      profile: { mode: "isolated_new" },
    });
    await approvalStarted.promise;
    userRequestedVisibleUse = false;
    approval.resolve(true);

    const result = await pending;
    expect(textOf(result)).toContain("foreground_not_requested");
    expect(backend.callsFor("browser.browser_prepare")).toHaveLength(0);
    expect(visibility).toHaveBeenCalledTimes(2);
  });

  it("keeps a headless launch independent of visibility", async () => {
    const visibility = vi.fn(async () => ({ userRequestedVisibleUse: false }));
    const { backend, call } = await setup({
      authorizeAction: async () => true,
      resolveForegroundAuthorization: visibility,
    });
    const result = await call("computer_browser_prepare", {
      allow_launch: true,
      profile: { mode: "isolated_new" },
    });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
    expect(visibility).not.toHaveBeenCalled();
  });

  it("refuses a visible launch when its authorization changes in the browser queue", async () => {
    let userRequestedVisibleUse = true;
    const visibility = vi.fn(async () => ({ userRequestedVisibleUse }));
    const firstEntered = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const browser = vi.fn(async (call: ComputerBrowserCall) => {
      if (call.name === "get_browser_state") {
        firstEntered.resolve();
        await firstRelease.promise;
      }
      return { structuredContent: { status: "ok" } };
    });
    const { manager, call } = await setup({
      backend: new FakeComputerBackend({ browser }),
      authorizeAction: async () => true,
      resolveForegroundAuthorization: visibility,
    });
    const queued = vi.spyOn(manager, "browserCall");
    const first = call("computer_browser_state", { target_id: "t", tab_id: "tab" });
    await firstEntered.promise;
    const visible = call("computer_browser_prepare", {
      allow_launch: true,
      windowed: true,
      profile: { mode: "isolated_new" },
    });
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
    expect(visibility).toHaveBeenCalledTimes(1);
    userRequestedVisibleUse = false;
    firstRelease.resolve();

    await first;
    const result = await visible;
    expect(textOf(result)).toContain("foreground_not_requested");
    expect(visibility).toHaveBeenCalledTimes(2);
    expect(browser.mock.calls.map(([call]) => call.name)).toEqual(["get_browser_state"]);
  });

  it("does not dispatch after cancellation during the admitted browser check", async () => {
    const checkEntered = Promise.withResolvers<void>();
    const checkRelease = Promise.withResolvers<void>();
    const browser = vi.fn(async () => ({ structuredContent: { status: "ok" } }));
    const { manager } = await setup({ backend: new FakeComputerBackend({ browser }) });
    const controller = new AbortController();
    const pending = manager.browserCall(
      THREAD,
      "turn-browser",
      "browser_prepare",
      { windowed: true },
      controller.signal,
      async () => {
        checkEntered.resolve();
        await checkRelease.promise;
      },
    );
    const rejected = expect(pending).rejects.toThrow("Caller cancelled");
    await checkEntered.promise;
    controller.abort(new Error("Caller cancelled"));
    checkRelease.resolve();
    await rejected;
    expect(browser).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "nested refusal code",
      reply: { structuredContent: { status: "refused", refusal: { code: "browser_ref_stale" } } },
      expected: { effect: "refused", code: "browser_ref_stale" },
    },
    {
      label: "DOM readback without application effect proof",
      reply: {
        structuredContent: {
          status: "ok",
          effect: "unverifiable",
          route: "dom_event",
          dispatched: true,
          readback: "matched",
        },
      },
      expected: { effect: "dispatched-unknown" },
    },
  ])("audits $label without upgrading its effect", async ({ reply, expected }) => {
    const backend = new FakeComputerBackend({ browser: () => reply });
    const { manager, call } = await setup({ backend, authorizeAction: async () => true });
    const audit = vi.spyOn(manager, "recordComputerAudit");
    const result = await call("computer_browser_type", {
      target_id: "t",
      tab_id: "tab",
      ref: "p1:0",
      text: "private text",
    });
    expect(result.structuredContent).toEqual(reply.structuredContent);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "computer_browser_type", ...expected }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain("private text");
  });

  it("records a proven navigation without issuing another browser call", async () => {
    const args = { target_id: "bt-1", tab_id: "tab-1", url: "https://example.test/" };
    const backend = new FakeComputerBackend({
      browser: () => ({
        structuredContent: {
          status: "ok",
          ...args,
          verification: { scope: "navigation", method: "page_frame_tree", status: "confirmed" },
        },
      }),
    });
    const { manager, call } = await setup({ backend, authorizeAction: async () => true });
    const audit = vi.spyOn(manager, "recordComputerAudit");
    await call("computer_browser_navigate", args);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "computer_browser_navigate",
        effect: "verified",
      }),
    );
    expect(backend.calls.filter((entry) => entry.method.startsWith("browser."))).toHaveLength(1);
  });

  it("reports field readback without claiming submission succeeded", async () => {
    const structuredContent = {
      effect: "unverifiable",
      route: "dom",
      evidence: [{ kind: "value_readback" }],
    };
    const backend = new FakeComputerBackend({
      browser: () => ({
        structuredContent,
        content: [{ type: "text", text: "legacy dispatch summary" }],
      }),
    });
    const { manager, call } = await setup({ backend, authorizeAction: async () => true });
    const audit = vi.spyOn(manager, "recordComputerAudit");
    const result = await call("computer_browser_type", {
      target_id: "bt-1",
      tab_id: "tab-1",
      ref: "p1:2",
      text: "private value",
      input_route: "dom_event",
      replace: true,
    });
    expect(result.structuredContent).toEqual(structuredContent);
    expect(textOf(result)).toContain("Field value matched; application effect unverified");
    expect(textOf(result)).not.toContain("private value");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ effect: "dispatched-unknown" }));
  });

  it("offers one honest next step after unsupported profile attachment without launching it", async () => {
    const backend = new FakeComputerBackend({
      browser: () => ({
        structuredContent: {
          status: "refused",
          refusal: {
            code: "browser_consent_required",
            message: "consent provider absent",
          },
        },
      }),
    });
    const { call } = await setup({ backend, authorizeAction: async () => true });
    const result = await call("computer_browser_prepare", { pid: 42 });
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { code: "browser_consent_required" },
    });
    expect(textOf(result)).toContain("cannot attach to your existing browser profile");
    expect(textOf(result)).toContain(
      'computer_browser_prepare({allow_launch:true,profile:{mode:"isolated_new"',
    );
    expect(textOf(result)).toContain("without your cookies");
    expect(textOf(result)).toContain(
      "Do not substitute it when the task requires your existing profile",
    );
    expect(backend.callsFor("browser.browser_prepare")).toHaveLength(1);
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

  it.each([
    { pid: 42, window_id: 99 },
    { target_id: "", tab_id: "tab-1" },
    { target_id: "bt-1", tab_id: "tab-1", pid: 42, window_id: 99 },
  ])(
    "refuses native window identities on browser actions before approval or dispatch",
    async (scope) => {
      const authorizeAction = vi.fn(async () => true);
      const { backend, call, manager } = await setup({ authorizeAction });
      const audit = vi.spyOn(manager, "recordComputerAudit");
      const result = await call("computer_browser_navigate", {
        ...scope,
        url: "https://example.com/",
      });
      expect(result.structuredContent).toMatchObject({
        status: "refused",
        refusal: { code: "browser_target_required" },
      });
      expect(textOf(result)).toContain("If the bind was refused");
      expect(textOf(result)).not.toContain("computer_browser_prepare");
      expect(authorizeAction).not.toHaveBeenCalled();
      expect(backend.callsFor("browser.browser_navigate")).toHaveLength(0);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ effect: "refused", code: "browser_target_required" }),
      );
    },
  );

  it("explains a pid-only bind refusal without suggesting an invalid navigation scope", async () => {
    const backend = new FakeComputerBackend({
      browser: () => ({
        structuredContent: {
          status: "refused",
          refusal: {
            code: "browser_wrong_target_refused",
            detail: { headless_driver_owned: false },
          },
        },
      }),
    });
    const { call } = await setup({ backend });
    const result = await call("computer_browser_state", { pid: 42 });
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: {
        code: "browser_wrong_target_refused",
        detail: { headless_driver_owned: false },
      },
    });
    expect(textOf(result)).toContain("computer_browser_state({pid,window_id})");
    expect(textOf(result)).toContain("Only a successful bind returns target_id");
    expect(textOf(result)).toContain("do not send pid/window_id to browser actions");
    expect(textOf(result)).not.toContain("computer_browser_prepare");
  });

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
