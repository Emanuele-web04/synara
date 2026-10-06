import { describe, expect, it } from "vitest";
import { normalizeOpenCodeV2Messages, normalizeOpenCodeV2Session } from "./openCodeV2Data.ts";

describe("OpenCode v2 sessions and messages", () => {
  it("preserves session location, timestamps, selected model and staged revert", () => {
    expect(
      normalizeOpenCodeV2Session({
        data: {
          id: "ses_1",
          projectID: "prj_1",
          location: { directory: "/repo" },
          model: { id: "chat-model", providerID: "provider-a" },
          time: { created: 1, updated: 2, archived: 3 },
          revert: { messageID: "msg_1", snapshot: "snap" },
          outcome: "failed",
          permissions: [{ action: "bash", resource: "*", effect: "deny" }],
        },
      }),
    ).toMatchObject({
      id: "ses_1",
      directory: "/repo",
      time: { created: 1, updated: 2, archived: 3 },
      revert: { messageID: "msg_1", snapshot: "snap" },
      metadata: { opencodeOutcome: "failed" },
      permission: [{ permission: "bash", pattern: "*", action: "deny" }],
    });
  });

  it("recovers transcript parts, tool ownership and assistant failure details", () => {
    const entries = normalizeOpenCodeV2Messages(
      {
        sessionID: "ses_1",
        data: [
          { type: "model-switched", model: { id: "chat-model", providerID: "provider-a" } },
          { type: "agent-switched", agent: "build" },
          {
            id: "msg_u",
            type: "user",
            time: { created: 1 },
            text: "Fix it",
            files: [
              { data: "abc", mime: "image/png", source: { type: "inline" }, name: "image.png" },
            ],
          },
          {
            id: "msg_a",
            type: "assistant",
            time: { created: 2, completed: 9 },
            agent: "build",
            model: { id: "chat-model", providerID: "provider-a" },
            finish: "error",
            cost: 0.25,
            tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
            error: {
              type: "rate_limit",
              message: "Too many requests",
              status: 429,
              response: { body: "retry later" },
            },
            content: [
              { type: "text", text: "Trying" },
              { type: "reasoning", text: "Think", time: { created: 2, completed: 3 } },
              {
                type: "tool",
                id: "call_1",
                name: "bash",
                time: { created: 3, ran: 4, completed: 5 },
                state: {
                  status: "completed",
                  input: { command: "ls" },
                  content: [
                    { type: "text", text: "ok" },
                    { type: "file", uri: "file:///tmp/output.png", mime: "image/png" },
                  ],
                  metadata: {},
                },
              },
            ],
          },
        ],
      },
      { directory: "/repo" },
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.info).toMatchObject({
      role: "user",
      agent: "build",
      model: { modelID: "chat-model" },
    });
    expect(entries[0]?.parts[1]).toMatchObject({
      type: "file",
      url: "data:image/png;base64,abc",
      filename: "image.png",
    });
    expect(entries[1]?.info).toMatchObject({
      parentID: "msg_u",
      time: { completed: 9 },
      cost: 0.25,
      tokens: { input: 10 },
      error: {
        name: "APIError",
        data: {
          statusCode: 429,
          isRetryable: true,
          responseBody: "retry later",
          metadata: { opencodeType: "rate_limit" },
        },
      },
    });
    expect(entries[1]?.parts.map((part) => part.id)).toEqual([
      "msg_a:t0",
      "msg_a:r0",
      "ses_1:msg_a:call_1",
    ]);
    expect(entries[1]?.parts[2]).toMatchObject({
      callID: "call_1",
      state: {
        status: "completed",
        output: "ok",
        time: { start: 4, end: 5 },
        attachments: [{ url: "file:///tmp/output.png" }],
      },
    });
  });

  it("requires explicit session ownership when data has been unwrapped", () => {
    expect(() => normalizeOpenCodeV2Messages([])).toThrow("messages.sessionID");
    expect(normalizeOpenCodeV2Messages([], { sessionID: "ses_1" })).toEqual([]);
  });
});
