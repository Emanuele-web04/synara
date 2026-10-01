import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { RemoteAgentCall, RemoteAgentResult } from "./remoteAgentGateway";

describe("remote gateway wire contracts", () => {
  it("preserves nested tool arguments through the RPC JSON codec", () => {
    const value = {
      environmentId: "mini",
      caller: {
        environmentId: "book",
        threadId: "thread",
        turnId: "turn",
        provider: "codex",
        runtimeMode: "approval-required",
        envMode: "worktree",
        capabilities: ["thread:read", "thread:write"],
      },
      tool: "synara_create_threads",
      arguments: {
        requestId: "create",
        threads: [
          {
            projectId: "same-project",
            target: { provider: "codex", model: "fixture", options: { reasoningEffort: "high" } },
            prompt: "fixture",
            notifyCreatorOnComplete: false,
          },
        ],
        timeoutMs: 0,
      },
    };
    const codec = Schema.toCodecJson(RemoteAgentCall);
    const decoded = Schema.decodeUnknownSync(codec)(value);
    expect(Schema.encodeSync(codec)(decoded)).toEqual(value);
  });
  it("preserves structured results and rejects delegated computer capability", () => {
    const result = {
      content: [{ type: "text", text: "fixture" }],
      structuredContent: { threadId: "thread", nested: [1, true, null] },
    };
    expect(Schema.decodeUnknownSync(Schema.toCodecJson(RemoteAgentResult))(result)).toEqual(result);
    expect(() =>
      Schema.decodeUnknownSync(RemoteAgentCall)({
        environmentId: "mini",
        caller: {
          environmentId: "book",
          threadId: "thread",
          turnId: null,
          provider: "codex",
          runtimeMode: "full-access",
          envMode: "local",
          capabilities: ["computer:control"],
        },
        tool: "computer_click",
        arguments: {},
      }),
    ).toThrow();
  });
});
