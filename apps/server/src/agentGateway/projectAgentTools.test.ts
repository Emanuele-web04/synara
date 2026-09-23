import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ProjectAgentServiceShape } from "../projectAgent/Services/ProjectAgentService.ts";
import { makeProjectAgentTools } from "./projectAgentTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const stubService = {
  resolvePrincipalForThread: () => Effect.succeed({ kind: "coordinator" as const }),
} as unknown as ProjectAgentServiceShape;

const tools = makeProjectAgentTools({ projectAgent: stubService });
const byName = new Map(tools.map((tool) => [tool.definition.name, tool] as const));

describe("project agent tool surface", () => {
  it("keeps every pre-groups tool name and capability unchanged", () => {
    const expected = [
      "synara_project_get_overview",
      "synara_project_list_tasks",
      "synara_project_read_document",
      "synara_project_write_document",
      "synara_project_report_result",
      "synara_project_context",
    ] as const;
    for (const name of expected) {
      expect(byName.has(name), `missing ${name}`).toBe(true);
    }
    expect(byName.get("synara_project_write_document")?.requiresActiveTurn).toBe(true);
    expect(byName.get("synara_project_report_result")?.requiresActiveTurn).toBe(true);
    expect(byName.get("synara_project_get_overview")?.requiredCapability).toBe("thread:read");
    expect(byName.get("synara_project_list_tasks")?.requiredCapability).toBe("thread:read");
    expect(byName.get("synara_project_read_document")?.requiredCapability).toBe("thread:read");
    expect(byName.get("synara_project_context")?.requiredCapability).toBe("thread:read");
    expect(byName.get("synara_project_write_document")?.requiredCapability).toBe("thread:write");
    expect(byName.get("synara_project_report_result")?.requiredCapability).toBe("thread:write");
  });

  it("adds the six group tools with the right capabilities", () => {
    const expected: Record<string, { capability: string; activeTurn: boolean | undefined }> = {
      synara_project_remember: { capability: "thread:write", activeTurn: true },
      synara_project_forget: { capability: "thread:write", activeTurn: true },
      synara_project_link_repository: { capability: "thread:write", activeTurn: true },
      synara_project_library_list: { capability: "thread:read", activeTurn: undefined },
      synara_project_library_add: { capability: "thread:write", activeTurn: true },
      synara_project_list_threads: { capability: "thread:read", activeTurn: undefined },
    };
    for (const [name, { capability, activeTurn }] of Object.entries(expected)) {
      const tool = byName.get(name);
      expect(tool, `missing ${name}`).toBeDefined();
      expect(tool?.requiredCapability).toBe(capability);
      expect(tool?.requiresActiveTurn).toBe(activeTurn);
    }
    expect(tools.length).toBe(12);
  });

  it("declares the documented inputs for each new tool", () => {
    const required = (name: string) =>
      (
        (byName.get(name)?.definition.inputSchema as { required?: string[] } | undefined)
          ?.required ?? []
      )
        .slice()
        .sort();
    expect(required("synara_project_remember")).toEqual(["note", "projectId"]);
    expect(required("synara_project_forget")).toEqual(["path", "projectId"]);
    // Exactly one of linkedProjectId / workspacePath is enforced at runtime.
    expect(required("synara_project_link_repository")).toEqual(["projectId"]);
    expect(required("synara_project_library_list")).toEqual(["projectId"]);
    expect(required("synara_project_library_add")).toEqual(["projectId", "sourcePath"]);
    expect(required("synara_project_list_threads")).toEqual(["projectId"]);
  });

  it("rejects link_repository calls that pass both selectors or neither", async () => {
    const tool = byName.get("synara_project_link_repository");
    const context = {
      principal: { kind: "provider-session" as const },
      callerThreadId: "thread-1",
      callerThreadLabel: null,
      callerSessionKey: "session-1",
      callerProvider: "codex" as const,
      callerCapabilities: new Set(["thread:read", "thread:write"]),
      callerTurnId: "turn-1",
      assertCallerTurnActive: () => Effect.void,
      jsonRpcRequestId: 1,
    } as unknown as ToolContext;
    const run = (args: Record<string, unknown>) => tool!.handler(args, context);
    const both = await Effect.runPromise(
      run({ projectId: "p", linkedProjectId: "a", workspacePath: "/x" }),
    );
    expect(JSON.stringify(both)).toContain("exactly one");
    const neither = await Effect.runPromise(run({ projectId: "p" }));
    expect(JSON.stringify(neither)).toContain("exactly one");
  });
});
