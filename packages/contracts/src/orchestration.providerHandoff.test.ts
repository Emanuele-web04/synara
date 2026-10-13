import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ClientOrchestrationCommand, OrchestrationCommand } from "./orchestration";

const createdAt = "2026-10-11T12:00:00.000Z";
const sourceModelSelection = { provider: "codex", model: "gpt-5.4" };
const targetModelSelection = { provider: "pi", instanceId: "pi-work", model: "vendor/model" };
const append = (kind: string, id = "ordinary") => ({
  type: "thread.activity.append",
  commandId: "append",
  threadId: "thread-1",
  createdAt,
  activity: { id, kind, tone: "info", summary: "Activity", payload: {}, turnId: null, createdAt },
});

describe("provider handoff command ownership", () => {
  // The server union's first member is the normalized dispatchable-client
  // boundary; its second member deliberately also admits trusted server writes.
  for (const [name, schema] of [
    ["client", ClientOrchestrationCommand],
    ["dispatchable client", OrchestrationCommand.members[0]],
  ] as const) {
    const decode = Schema.decodeUnknownSync(schema);
    it.each([
      "provider.handoff.requested",
      "provider.handoff",
      "provider.handoff.completed",
      "provider.handoff.failed",
      "provider.handoff.future",
    ])(`${name} refuses public %s activity`, (kind) =>
      expect(() => decode(append(kind))).toThrow(),
    );
    it.each([
      "provider-handoff-requested:cmd",
      "provider-handoff:cmd",
      "provider-handoff-failed:cmd",
    ])(`${name} refuses an ordinary-kind overwrite of %s`, (id) =>
      expect(() => decode(append("tool.completed", id))).toThrow(),
    );
    it(`${name} preserves ordinary activity appends and the existing handoff intent`, () => {
      expect(decode(append("tool.completed"))).toEqual(append("tool.completed"));
      const intent = {
        type: "thread.meta.update",
        commandId: "handoff",
        threadId: "thread-1",
        modelSelection: targetModelSelection,
        providerHandoff: true,
      };
      expect(decode(intent)).toEqual(intent);
    });
  }
  it("keeps atomic outcome settlement server-only", () => {
    const command = {
      type: "thread.provider.handoff.settle",
      commandId: "settle",
      threadId: "thread-1",
      handoffCommandId: "handoff",
      sourceModelSelection,
      targetModelSelection,
      outcome: "completed",
      contextText: "recap",
      createdAt,
    };
    expect(Schema.decodeUnknownSync(OrchestrationCommand)(command)).toEqual({
      ...command,
      sourceModelSelection: { ...sourceModelSelection, instanceId: "codex" },
    });
    expect(() => Schema.decodeUnknownSync(ClientOrchestrationCommand)(command)).toThrow();
    expect(() => Schema.decodeUnknownSync(OrchestrationCommand.members[0])(command)).toThrow();
  });
});
