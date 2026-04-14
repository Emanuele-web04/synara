import { describe, expect, it } from "vitest";

import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  decodeSubagentReceiverAgents,
  extractSubagentIdentityHints,
  resolveSubagentIdentityHint,
} from "./subagents";

describe("collectSubagentProviderThreadIds", () => {
  it("includes thread ids discovered from receiverAgents, agentStates, and source thread_spawn payloads", () => {
    expect(
      collectSubagentProviderThreadIds({
        receiverAgents: [
          {
            threadId: "child-provider-1",
            agentNickname: "Locke",
          },
        ],
        agentStates: {
          "child-provider-2": {
            status: "completed",
          },
        },
        source: {
          subAgent: {
            thread_spawn: {
              threadId: "child-provider-3",
            },
          },
        },
      }),
    ).toEqual(["child-provider-1", "child-provider-2", "child-provider-3"]);
  });
});

describe("decodeSubagentReceiverAgents", () => {
  it("marks top-level requested model values as hints for child rows", () => {
    expect(
      decodeSubagentReceiverAgents(
        {
          receiverAgents: [
            {
              threadId: "child-provider-1",
              agentNickname: "Locke",
            },
          ],
          requestedModel: "gpt-5.4-mini",
          prompt: "Inspect the sidebar tree",
        },
        ["child-provider-1"],
      ),
    ).toEqual([
      {
        providerThreadId: "child-provider-1",
        nickname: "Locke",
        model: "gpt-5.4-mini",
        modelIsRequestedHint: true,
        prompt: "Inspect the sidebar tree",
      },
    ]);
  });
});

describe("extractSubagentIdentityHints", () => {
  it("extracts identity metadata from nested source.subAgent thread_spawn payloads", () => {
    expect(
      extractSubagentIdentityHints({
        source: {
          subAgent: {
            thread_spawn: {
              threadId: "child-provider-1",
              agentId: "agent-1",
              name: "Locke",
              agentType: "explorer",
            },
          },
        },
      }),
    ).toContainEqual({
      providerThreadId: "child-provider-1",
      agentId: "agent-1",
      nickname: "Locke",
      role: "explorer",
    });
  });
});

describe("resolveSubagentIdentityHint", () => {
  it("preserves richer nickname and role metadata when later hints only include status updates", () => {
    const hints = extractSubagentIdentityHints({
      receiverAgents: [
        {
          threadId: "child-provider-1",
          agentId: "agent-1",
          agentNickname: "Locke",
          agentRole: "explorer",
        },
      ],
      agentStates: {
        "child-provider-1": {
          status: "completed",
          summary: "Done",
        },
      },
    });

    expect(
      resolveSubagentIdentityHint({
        hints,
        providerThreadId: "child-provider-1",
      }),
    ).toMatchObject({
      providerThreadId: "child-provider-1",
      agentId: "agent-1",
      nickname: "Locke",
      role: "explorer",
      status: "completed",
      message: "Done",
    });
  });

  it("links thread and agent identifiers through the same merged directory entry", () => {
    const directory = buildSubagentIdentityDirectory([
      {
        providerThreadId: "child-provider-1",
        agentId: "agent-1",
        nickname: "Harper",
      },
      {
        agentId: "agent-1",
        role: "reviewer",
      },
    ]);

    expect(directory.byProviderThreadId.get("child-provider-1")).toMatchObject({
      providerThreadId: "child-provider-1",
      agentId: "agent-1",
      nickname: "Harper",
      role: "reviewer",
    });
  });
});
