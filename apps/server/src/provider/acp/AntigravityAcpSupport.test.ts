import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  buildAntigravityAcpSpawnInput,
  chooseAntigravityAcpModel,
  normalizeAntigravityToolCallUpdate,
  readAntigravityAcpModels,
  resolveAntigravityAcpAuthMethodId,
  resolveAntigravityAcpModelId,
  withAntigravityToolSummary,
} from "./AntigravityAcpSupport.ts";

const toolUpdate = (update: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s1", update },
});

const updateOf = (message: unknown) =>
  (message as { params: { update: Record<string, unknown> } }).params.update;

describe("Antigravity ACP support", () => {
  it("starts the official ACP runtime with native permissions enabled", () => {
    const spawn = buildAntigravityAcpSpawnInput({ binaryPath: "/opt/agy" }, "/repo");
    expect(spawn.command).toBe("/opt/agy");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.cwd).toBe("/repo");
  });

  it("passes guest paths to agy while retaining the WSL cwd for process launch", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      const cwd = "\\\\wsl.localhost\\Ubuntu\\repos\\primary";
      const spawn = buildAntigravityAcpSpawnInput(undefined, cwd, [
        "\\\\wsl$\\Ubuntu\\repos\\api",
        "\\\\wsl.localhost\\Ubuntu\\repos\\shared package",
      ]);
      expect(spawn.args).toEqual([
        "acp",
        "--add-dir",
        "/repos/api",
        "--add-dir",
        "/repos/shared package",
      ]);
      expect(spawn.cwd).toBe(cwd);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names MCP calls server__tool using the session's server names", () => {
    const update = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          name: "mcp_probe_notes_connector_read_ideas",
          kind: "other",
          title: "Run mcp_probe_notes_connector_read_ideas",
          rawInput: { toolSummary: "Read saved ideas" },
        }),
        ["synara", "probe_notes", "probe_notes_connector"],
      ),
    );
    expect(update.title).toBe("mcp__probe_notes_connector__read_ideas");
    expect(update.rawInput).toEqual({
      toolSummary: "Read saved ideas",
      _toolName: "mcp__probe_notes_connector__read_ideas",
    });
  });

  it("names lazy call_mcp_tool calls and Synara tools the same way", () => {
    const lazy = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-2",
          name: "call_mcp_tool",
          title: "Run call_mcp_tool",
          rawInput: { ServerName: "notion", ToolName: "notion-search", Arguments: {} },
        }),
      ),
    );
    expect(lazy.title).toBe("mcp__notion__notion-search");
    const synara = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-3",
          name: "mcp_synara_computer_click",
          title: "Run mcp_synara_computer_click",
        }),
        ["synara"],
      ),
    );
    expect(synara.rawInput).toEqual({ _toolName: "mcp__synara__computer_click" });
  });

  it("exposes run_command lines and drops 'File' titles on located calls", () => {
    const command = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-4",
          name: "run_command",
          kind: "execute",
          title: "ls -la",
          rawInput: { CommandLine: "ls -la", toolSummary: "List files" },
        }),
      ),
    );
    expect(command.title).toBe("ls -la");
    expect(command.rawInput).toMatchObject({ CommandLine: "ls -la", command: "ls -la" });
    const read = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-5",
          name: "read_file",
          kind: "read",
          title: "File README.md",
          locations: [{ path: "/repo/README.md" }],
          rawInput: { Path: "/repo/README.md" },
        }),
      ),
    );
    expect(read).not.toHaveProperty("title");
    const chunk = toolUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } });
    expect(normalizeAntigravityToolCallUpdate(chunk)).toBe(chunk);
  });

  it("previews a call with its toolSummary only when nothing better exists", () => {
    const base = {
      toolCallId: "call-6",
      title: "mcp__notion__notion-search",
      detail: "mcp__notion__notion-search",
      data: { rawInput: { toolSummary: "Search Notion for app ideas" } },
    };
    expect(withAntigravityToolSummary(base).detail).toBe("Search Notion for app ideas");
    expect(withAntigravityToolSummary({ ...base, detail: "3 results" }).detail).toBe("3 results");
  });

  it("reads the session model list and resolves CLI labels to model ids", () => {
    const models = readAntigravityAcpModels({
      sessionId: "s1",
      models: {
        currentModelId: "gemini-4-neon-high",
        availableModels: [
          { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        ],
      },
    });
    expect(models.currentModelId).toBe("gemini-4-neon-high");
    expect(resolveAntigravityAcpModelId(models.availableModels, "gemini 4 neon (high)")).toBe(
      "gemini-4-neon-high",
    );
    expect(resolveAntigravityAcpModelId(models.availableModels, "Orchestrator (Neon)")).toBe(
      "gemini-pro-orchestrator-neon",
    );
    expect(resolveAntigravityAcpModelId(models.availableModels, "Gemini 9")).toBeUndefined();
    expect(readAntigravityAcpModels({}).availableModels).toEqual([]);
  });

  it("keeps or defers the thinking level when a selection has none", () => {
    const models = [
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    ];
    expect(chooseAntigravityAcpModel(models, "Gemini 3.8 Flash (Low)", undefined)).toEqual({
      kind: "model",
      modelId: "gemini-3.8-flash-low",
    });
    expect(chooseAntigravityAcpModel(models, "Gemini 3.8 Flash", "gemini-3.8-flash-low")).toEqual({
      kind: "model",
      modelId: "gemini-3.8-flash-low",
    });
    expect(chooseAntigravityAcpModel(models, "Gemini 3.8 Flash", "gemini-4-neon-high")).toEqual({
      kind: "base",
      baseName: "Gemini 3.8 Flash",
    });
    expect(chooseAntigravityAcpModel(models, "Gemini 9 Ultra", undefined)).toEqual({
      kind: "unavailable",
    });
  });

  it("resolves a saved Orchestrator selection without substituting another planner", () => {
    const models = [{ modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" }];
    expect(chooseAntigravityAcpModel(models, "Orchestrator (Carbon)", models[0]!.modelId)).toEqual({
      kind: "unavailable",
    });
    expect(chooseAntigravityAcpModel(models, "Orchestrator", undefined)).toEqual({
      kind: "model",
      modelId: "gemini-pro-orchestrator-neon",
    });
  });

  it("authenticates with a Gemini API key and otherwise asks for sign-in", () => {
    const initialize = {
      protocolVersion: 1,
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google" },
        { id: "gemini-api-key", name: "Gemini API key" },
      ],
    } as Acp.InitializeResponse;
    expect(
      Effect.runSync(resolveAntigravityAcpAuthMethodId(initialize, { GEMINI_API_KEY: "key" })),
    ).toBe("gemini-api-key");
    const exit = Effect.runSyncExit(resolveAntigravityAcpAuthMethodId(initialize, {}));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
