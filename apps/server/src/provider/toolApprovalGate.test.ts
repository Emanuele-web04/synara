import { describe, expect, it } from "vitest";
import { ThreadId, TurnId, type ProviderRuntimeEvent } from "@synara/contracts";
import { ToolApprovalGate } from "./toolApprovalGate";

function setup() {
  const events: ProviderRuntimeEvent[] = [];
  const gate = new ToolApprovalGate({
    provider: "pi",
    threadId: ThreadId.makeUnsafe("thread"),
    lifecycleGeneration: "generation",
    emit: (event) => events.push(event),
  });
  const input = {
    turnId: TurnId.makeUnsafe("turn"),
    requestId: "request",
    toolName: "write",
    input: { path: "a", content: "exact content\n" },
  };
  return { gate, events, input };
}
describe("host tool approval gate", () => {
  it("holds a tool until the matching response and resolves it only once", async () => {
    const { gate, events, input } = setup();
    const result = gate.request(input);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "request.opened",
      turnId: "turn",
      lifecycleGeneration: "generation",
      payload: { args: { input: input.input, sessionApprovalAvailable: false } },
    });
    expect(gate.respond("stale", "accept")).toBe(false);
    expect(gate.respond("request", "accept")).toBe(true);
    await expect(result).resolves.toBe("accept");
    expect(gate.respond("request", "accept")).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "request.resolved", payload: { decision: "accept" } });
  });
  it("cancels on abort without letting a late approval execute", async () => {
    const { gate, events, input } = setup();
    const controller = new AbortController();
    const result = gate.request({ ...input, signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBe("cancel");
    expect(gate.respond("request", "accept")).toBe(false);
    await expect(gate.request({ ...input, signal: controller.signal })).resolves.toBe("cancel");
    expect(events).toHaveLength(2);
  });
  it("does not replace duplicate requests and cancels only the requested turn", async () => {
    const { gate, events, input } = setup();
    const first = gate.request(input);
    await expect(gate.request(input)).resolves.toBe("cancel");
    const second = gate.request({
      ...input,
      requestId: "second",
      turnId: TurnId.makeUnsafe("next"),
    });
    gate.cancel(input.turnId);
    await expect(first).resolves.toBe("cancel");
    expect(events.filter((event) => event.type === "request.resolved")).toHaveLength(1);
    gate.cancel();
    await expect(second).resolves.toBe("cancel");
  });
});
