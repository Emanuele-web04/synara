import { EXTERNAL_MCP_MAX_PROMPT_CHARS, ExternalMcpCreateTaskInput } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { filterExternalMcpTools } from "./Layers/ExternalMcpGateway.ts";
import { resolveExternalMcpRuntimePolicy } from "./runtimePolicy.ts";

describe("external MCP runtime policy", () => {
  it("rejects prompts above the external integration limit", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExternalMcpCreateTaskInput)({
        requestId: "prompt-limit",
        projectId: "project-limit",
        provider: "codex",
        model: "gpt-5.5",
        prompt: "x".repeat(EXTERNAL_MCP_MAX_PROMPT_CHARS + 1),
      }),
    ).toThrow();
  });

  it("defaults creation to a managed worktree and approval-required execution", () => {
    expect(resolveExternalMcpRuntimePolicy({ capabilities: new Set(["tasks:create"]) })).toEqual({
      environment: "worktree",
      runtimeMode: "approval-required",
    });
  });

  it("rejects local and full-access execution without their independent scopes", () => {
    expect(() =>
      resolveExternalMcpRuntimePolicy({
        requestedEnvironment: "local",
        capabilities: new Set(["tasks:create"]),
      }),
    ).toThrow(/runtime:local/);
    expect(() =>
      resolveExternalMcpRuntimePolicy({
        requestedRuntimeMode: "full-access",
        capabilities: new Set(["tasks:create"]),
      }),
    ).toThrow(/runtime:full-access/);
  });

  it("allows each elevated runtime choice only with the matching scope", () => {
    expect(
      resolveExternalMcpRuntimePolicy({
        requestedEnvironment: "local",
        requestedRuntimeMode: "full-access",
        capabilities: new Set(["runtime:local", "runtime:full-access"]),
      }),
    ).toEqual({ environment: "local", runtimeMode: "full-access" });
  });
});

describe("external MCP tools/list filtering", () => {
  it("omits tools whose server-side capability was not granted", () => {
    const tools = [
      { requiredCapability: "projects:read", definition: { name: "projects" } },
      { requiredCapability: "tasks:create", definition: { name: "create" } },
      { requiredCapability: "tasks:read", definition: { name: "read" } },
    ] as never;
    expect(
      filterExternalMcpTools(tools, new Set(["projects:read", "tasks:read"])).map(
        (tool) => tool.definition.name,
      ),
    ).toEqual(["projects", "read"]);
  });
});
