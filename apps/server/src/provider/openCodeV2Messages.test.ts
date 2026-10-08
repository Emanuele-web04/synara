import type { OpenCodeEvent } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { createOpenCodeV2EventMapper } from "./openCodeV2Messages.ts";

function fixture() {
  const map = createOpenCodeV2EventMapper("/workspace");
  let sequence = 0;
  const emit = (type: OpenCodeEvent["type"], data: unknown) =>
    map({ id: `evt_${++sequence}`, created: sequence, type, data } as OpenCodeEvent);
  const tool = { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child" };
  emit("session.step.started", {
    ...tool,
    started: 1,
    agent: "build",
    model: { providerID: "local", id: "fixture" },
  });
  emit("session.tool.input.started", { ...tool, name: "subagent" });
  emit("session.tool.called", { ...tool, input: { agent: "explore", description: "Inspect" } });
  return {
    emit,
    background: () =>
      emit("session.tool.success", {
        ...tool,
        content: [{ type: "text", text: "Working in background" }],
        metadata: { sessionID: "ses_child", status: "running" },
      }),
  };
}

describe("OpenCode V2 background lifecycle", () => {
  it("replays an early child terminal after registering its background task and clears it on restart", () => {
    const { emit, background } = fixture();
    const terminal = emit("session.execution.succeeded", { sessionID: "ses_child" })[0];
    const events = background();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          tool: "task",
          state: {
            input: { subagent_type: "explore" },
            metadata: { background: true, sessionID: "ses_child" },
          },
        },
      },
    });
    expect(events[1]).toEqual(terminal);
    emit("session.execution.started", { sessionID: "ses_child" });
    expect(background()).toHaveLength(1);
  });

  it.each([
    ["completed", "succeeded"],
    ["error", "failed"],
    ["cancelled", "interrupted"],
  ])("settles native %s subagent reports without completing the parent", (state, outcome) => {
    const { emit, background } = fixture();
    background();
    expect(
      emit("session.inbox.enqueued", {
        sessionID: "ses_parent",
        inboxID: "inbox_report",
        item: {
          type: "synthetic",
          delivery: "queue",
          payload: {
            text: "Subagent report",
            metadata: { source: "subagent", childID: "ses_child", state },
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "synara.opencode.execution",
        properties: { sessionID: "ses_child", outcome },
      }),
    ]);
  });
});
