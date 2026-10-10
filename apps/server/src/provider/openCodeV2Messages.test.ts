import type { OpenCodeEvent } from "@opencode/client";
import type { Part } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeV2EventMapper,
  openCodeV2Message,
  type NormalizedOpenCodeEvent,
} from "./openCodeV2Messages.ts";

function emitter() {
  const map = createOpenCodeV2EventMapper("/workspace");
  let sequence = 0;
  return (type: OpenCodeEvent["type"], data: unknown) =>
    map({ id: `evt_${++sequence}`, created: sequence, type, data } as OpenCodeEvent);
}

function fixture() {
  const emit = emitter();
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

describe("OpenCode V2 assistant blocks", () => {
  const step = { sessionID: "ses_v2", assistantMessageID: "msg_step" };
  // As OpenCode V2 stores a step: reasoning and text ordinals each start at 0,
  // and blocks keep their arrival order around tools.
  const recovered = openCodeV2Message(
    step.sessionID,
    {
      id: step.assistantMessageID,
      type: "assistant",
      agent: "build",
      model: { providerID: "local", id: "fixture" },
      time: { created: 1, completed: 9 },
      content: [
        { type: "reasoning", text: "Plan" },
        { type: "text", text: "Listing files." },
        {
          type: "tool",
          id: "call_ls",
          name: "shell",
          state: { status: "streaming", input: "" },
          time: { created: 4 },
        },
        { type: "text", text: "Done." },
      ],
    },
    "/workspace",
  )!;
  const blocksById = (parts: Part[]) =>
    Object.fromEntries(
      parts.map((part) => [
        part.id,
        { type: part.type, ...("text" in part ? { text: part.text } : {}) },
      ]),
    );
  const emittedParts = (events: NormalizedOpenCodeEvent[]) =>
    events.flatMap((event) =>
      event.type === "message.part.updated" ? [event.properties.part] : [],
    );
  const block = (
    emit: ReturnType<typeof emitter>,
    kind: "text" | "reasoning",
    ordinal: number,
    text: string,
  ) => [
    ...emit(`session.${kind}.started`, { ...step, ordinal }),
    ...emit(`session.${kind}.delta`, { ...step, ordinal, delta: text }),
    ...emit(`session.${kind}.ended`, { ...step, ordinal, text }),
  ];

  it("streams each block under the part ID its recovered snapshot uses", () => {
    const emit = emitter();
    emit("session.step.started", {
      ...step,
      started: 1,
      agent: "build",
      model: { providerID: "local", id: "fixture" },
    });
    const live = [
      ...block(emit, "reasoning", 0, "Plan"),
      ...block(emit, "text", 0, "Listing files."),
      ...emit("session.tool.input.started", { ...step, id: "call_ls", name: "shell" }),
      ...block(emit, "text", 1, "Done."),
    ];
    const settled = emit("session.step.ended", { ...step, finish: "stop" });

    expect(blocksById(emittedParts(live))).toEqual(
      blocksById(recovered.parts.filter((part) => part.type !== "tool")),
    );
    expect(blocksById(emittedParts(settled))).toEqual(blocksById(recovered.parts));
  });

  it("keeps a block's part ID when a reconnected mapper missed earlier blocks", () => {
    const emit = emitter();
    const events = [
      ...block(emit, "text", 1, "Done."),
      ...emit("session.step.ended", { ...step, finish: "stop" }),
    ];

    expect(blocksById(recovered.parts)).toMatchObject(blocksById(emittedParts(events)));
  });
});
