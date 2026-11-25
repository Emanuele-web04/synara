import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeComputerAttachmentTools, inspectAttachmentFiles } from "./computerAttachmentTools.ts";
import { GatewayToolError, type ToolContext, type ToolEntry } from "./toolRuntime.ts";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import { canonicalSynaraComputerToolName } from "./computerToolPermission.ts";

let base: string;
let workspace: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "synara-attachment-"));
  workspace = join(base, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "file.txt"), "hello");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["computer:control", "browser:control"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
const resultText = (result: McpToolCallResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
const integratedArgs = {
  action: "attach",
  files: ["file.txt"],
  surface: "integrated_browser",
  tab_id: "tab",
  selector: "#file",
};
const computerArgs = {
  action: "attach",
  files: ["file.txt"],
  surface: "computer_browser",
  tab_id: "tab-1",
  target_id: "bt-1",
  ref: "e1",
};

function setup() {
  const browserHandler = vi.fn(
    (): Effect.Effect<McpToolCallResult> =>
      Effect.succeed({
        ...mcpToolResultJson({ selected: true }),
        structuredContent: {
          selectionVerified: true,
          files: [{ name: "file.txt", byteLength: 5 }],
        },
      }),
  );
  const computerHandler = vi.fn(
    (): Effect.Effect<McpToolCallResult> =>
      Effect.succeed({
        ...mcpToolResultJson({ status: "ok" }),
        structuredContent: { status: "ok" },
      }),
  );
  const browser: ToolEntry = {
    requiredCapability: "browser:control",
    definition: {
      name: "browser_upload",
      description: "Integrated upload fixture",
      inputSchema: { type: "object" },
    },
    handler: browserHandler,
  };
  const computer: ToolEntry = {
    requiredCapability: "computer:control",
    definition: {
      name: "computer_browser_upload",
      description: "Driver upload fixture",
      inputSchema: { type: "object" },
    },
    handler: computerHandler,
  };
  const tool = makeComputerAttachmentTools({
    browserTools: [browser],
    computerBrowserTools: [computer],
    resolveWorkspaceRoot: () => Effect.succeed(workspace),
  })[0]!;
  const call = (args: Record<string, unknown>, caller = context) =>
    Effect.runPromise(tool.handler(args, caller));
  return { tool, browserHandler, computerHandler, call };
}

describe("workspace attachment admission and routing", () => {
  it("preflights names/sizes without dispatch or returning absolute paths", async () => {
    const { call, browserHandler, computerHandler, tool } = setup();
    const result = await call({ action: "inspect", files: ["file.txt"] });
    expect(JSON.parse(resultText(result))).toMatchObject({
      effect: "not-dispatched",
      files: [{ name: "file.txt", byteLength: 5 }],
    });
    expect(resultText(result)).not.toContain(workspace);
    expect(browserHandler).not.toHaveBeenCalled();
    expect(computerHandler).not.toHaveBeenCalled();
    expect(tool.discoveryOnly).toBe(true);
    expect(canonicalSynaraComputerToolName("mcp__synara__computer_attach_files")).toBe(
      "computer_attach_files",
    );
  });

  it.each([
    { files: ["../outside.txt"] },
    { files: ["file.txt", "./file.txt"] },
    { files: ["."] },
    { files: ["file\0.txt"] },
    { files: [] },
    { files: Array(33).fill("file.txt") },
  ])("refuses invalid files without calling a browser: %j", async ({ files }) => {
    await writeFile(join(base, "outside.txt"), "private");
    const { call, browserHandler, computerHandler } = setup();
    expect((await call({ ...integratedArgs, files })).isError).toBe(true);
    expect(browserHandler).not.toHaveBeenCalled();
    expect(computerHandler).not.toHaveBeenCalled();
  });

  it("rejects symlink files and symlink directory components", async () => {
    await symlink(join(workspace, "file.txt"), join(workspace, "link"));
    await mkdir(join(workspace, "dir"));
    await writeFile(join(workspace, "dir", "f"), "data");
    await symlink(join(workspace, "dir"), join(workspace, "alias"));
    await expect(inspectAttachmentFiles(workspace, ["link"])).rejects.toThrow(/Symlink/);
    await expect(inspectAttachmentFiles(workspace, ["alias/f"])).rejects.toThrow(/Symlink/);
  });

  it("accepts empty and unicode files; bounds total bytes before file reads or dispatch", async () => {
    await writeFile(join(workspace, "空.txt"), "");
    expect(await inspectAttachmentFiles(workspace, ["空.txt"])).toMatchObject([
      { name: "空.txt", byteLength: 0 },
    ]);
    await truncate(join(workspace, "file.txt"), 256 * 1024 * 1024 + 1);
    await expect(inspectAttachmentFiles(workspace, ["file.txt"])).rejects.toThrow(/256 MiB/);
  });

  it("routes integrated files once with workspace-relative paths and the original caller", async () => {
    const { call, browserHandler, computerHandler } = setup();
    const result = await call({ ...integratedArgs, files: [join(workspace, "file.txt")] });
    expect(browserHandler).toHaveBeenCalledExactlyOnceWith(
      {
        tabId: "tab",
        target: { selector: "#file" },
        paths: ["file.txt"],
      },
      context,
    );
    expect(computerHandler).not.toHaveBeenCalled();
    expect(resultText(result)).toContain("verified-file-input");
    expect(resultText(result)).toContain('"applicationAcceptance":"unverified"');
  });

  it("keeps driver IDs opaque and cannot upgrade an unverified driver result", async () => {
    const { call, computerHandler, browserHandler } = setup();
    const result = await call(computerArgs);
    expect(computerHandler).toHaveBeenCalledExactlyOnceWith(
      {
        target_id: "bt-1",
        tab_id: "tab-1",
        ref: "e1",
        files: [join(workspace, "file.txt")],
      },
      context,
    );
    expect(browserHandler).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('"selection":"unverified"');
  });

  it("does not infer verification from old hosts' successful metadata", async () => {
    const { call, browserHandler } = setup();
    browserHandler.mockReturnValue(
      Effect.succeed({
        ...mcpToolResultJson({ files: [{ name: "file.txt", byteLength: 5 }] }),
        structuredContent: {},
      }) as ReturnType<typeof browserHandler>,
    );
    expect(resultText(await call(integratedArgs))).toContain('"selection":"unverified"');
  });

  it("preserves delegate refusal and errors verbatim without fallback or replay", async () => {
    const { call, browserHandler, computerHandler } = setup();
    const refused = {
      ...mcpToolResultJson({ status: "refused" }),
      structuredContent: { status: "refused" },
    };
    computerHandler.mockReturnValue(Effect.succeed(refused));
    expect(await call(computerArgs)).toEqual(refused);
    expect(computerHandler).toHaveBeenCalledTimes(1);
    expect(browserHandler).not.toHaveBeenCalled();
    const denied = {
      ...mcpToolResultJson({ error: "approval denied" }),
      isError: true,
      structuredContent: {},
    };
    browserHandler.mockReturnValue(Effect.succeed(denied) as ReturnType<typeof browserHandler>);
    expect(await call(integratedArgs)).toEqual(denied);
    expect(browserHandler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...integratedArgs, ref: "wrong-dialect" },
    { ...computerArgs, selector: "#wrong" },
    { ...integratedArgs, tab_id: undefined },
    { ...integratedArgs, surface: "native" },
    { ...integratedArgs, session: "injected" },
    { action: "inspect", files: ["file.txt"], surface: "integrated_browser" },
  ])("refuses ambiguous or forged arguments before dispatch", async (args) => {
    const { call, browserHandler, computerHandler } = setup();
    expect((await call(args)).isError).toBe(true);
    expect(browserHandler).not.toHaveBeenCalled();
    expect(computerHandler).not.toHaveBeenCalled();
  });

  it("requires the delegated capability as well as computer control", async () => {
    const { call, browserHandler } = setup();
    expect(
      (
        await call(integratedArgs, {
          ...context,
          callerCapabilities: new Set(["computer:control"]),
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call(computerArgs, { ...context, callerCapabilities: new Set(["browser:control"]) }))
        .isError,
    ).toBe(true);
    expect(browserHandler).not.toHaveBeenCalled();
  });

  it("rechecks turn liveness after asynchronous preflight", async () => {
    const { call, browserHandler } = setup();
    const active = vi
      .fn()
      .mockReturnValueOnce(Effect.void)
      .mockReturnValue(Effect.fail(new GatewayToolError("turn_inactive", "Turn ended.")));
    expect(
      (await call(integratedArgs, { ...context, assertCallerTurnActive: active })).isError,
    ).toBe(true);
    expect(browserHandler).not.toHaveBeenCalled();
  });

  it("aborts a metadata preflight before reading files", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectAttachmentFiles(workspace, ["file.txt"], controller.signal),
    ).rejects.toThrow();
  });
});
