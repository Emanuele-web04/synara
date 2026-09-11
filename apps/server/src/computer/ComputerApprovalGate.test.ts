import { describe, expect, it } from "vitest";
import { ComputerApprovalGate } from "./ComputerApprovalGate.ts";

describe("ComputerApprovalGate", () => {
  it("cancels a concurrent waiter without approving or cancelling another call", async () => {
    const gate = new ComputerApprovalGate();
    let id = "";
    const input = {
      threadId: "a",
      turnId: "turn",
      signal: new AbortController().signal,
      publish: async (requestId: string) => {
        id = requestId;
      },
    };
    const first = gate.requestTask(input);
    const controller = new AbortController();
    const follower = gate.requestTask({ ...input, signal: controller.signal });
    const rejected = expect(follower).rejects.toThrow("follower cancelled");
    controller.abort(new Error("follower cancelled"));
    await rejected;
    gate.respond("a", id, "accept");
    expect(await first).toBe(true);
  });

  it("does not reuse task consent for a separate clipboard approval", async () => {
    const gate = new ComputerApprovalGate();
    let prompts = 0;
    const input = {
      threadId: "a",
      turnId: "turn",
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) {
          prompts++;
          gate.respond("a", id, "accept");
        }
      },
    };
    expect(await gate.requestTask(input)).toBe(true);
    expect(await gate.requestTask(input)).toBe(true);
    expect(await gate.request(input)).toBe(true);
    expect(await gate.request(input)).toBe(true);
    expect(prompts).toBe(3);
  });
  it("shares one consent across concurrent and later routine actions in the same turn", async () => {
    const gate = new ComputerApprovalGate();
    const ids: string[] = [];
    const input = {
      threadId: "a",
      turnId: "turn-1",
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) ids.push(id);
      },
    };
    const first = gate.requestTask(input);
    const concurrent = gate.requestTask(input);
    expect(ids).toHaveLength(1);
    gate.respond("a", ids[0]!, "accept");
    expect(await first).toBe(true);
    expect(await concurrent).toBe(true);
    expect(await gate.requestTask(input)).toBe(true);
    expect(ids).toHaveLength(1);
    gate.cancelThread("a", "old-turn");
    expect(await gate.requestTask(input)).toBe(true);
    gate.cancelThread("a", "turn-1");
    const next = gate.requestTask({ ...input, turnId: "turn-2" });
    expect(ids).toHaveLength(2);
    gate.respond("a", ids[1]!, "decline");
    expect(await next).toBe(false);
    expect(await gate.requestTask({ ...input, turnId: "turn-2" })).toBe(false);
    expect(ids).toHaveLength(2);
  });

  it("cannot retain consent when Stop races an accepted response", async () => {
    const gate = new ComputerApprovalGate();
    const input = {
      threadId: "a",
      turnId: "turn",
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) {
          gate.respond("a", id, "accept");
          gate.cancelThread("a");
        }
      },
    };
    expect(await gate.requestTask(input)).toBe(false);
  });

  it("settles only the disabled conversation's live prompt", async () => {
    const gate = new ComputerApprovalGate();
    const ids = new Map<string, string>();
    const request = (threadId: string) =>
      gate.request({
        threadId,
        signal: new AbortController().signal,
        publish: async (id) => {
          ids.set(threadId, id);
        },
      });
    const a = request("a"),
      b = request("b");
    gate.cancelThread("a");
    expect(await a).toBe(false);
    expect(gate.respond("a", ids.get("a")!, "accept")).toBe(false);
    expect(gate.respond("b", ids.get("b")!, "accept")).toBe(true);
    expect(await b).toBe(true);
  });
  it.each(["accept", "decline", "cancel", "acceptForSession"] as const)(
    "binds %s to the requesting conversation and one call",
    async (decision) => {
      const gate = new ComputerApprovalGate();
      const signal = new AbortController().signal;
      let requestId = "";
      const events: unknown[] = [];
      const result = gate.request({
        threadId: "a",
        signal,
        publish: async (id, resolved) => {
          events.push(resolved ?? "opened");
          requestId = id;
          if (resolved === undefined) {
            expect(gate.respond("b", id, "accept")).toBe(false);
            expect(gate.respond("a", id, decision)).toBe(true);
          }
        },
      });
      expect(await result).toBe(decision === "accept");
      expect(gate.respond("a", requestId, "accept")).toBe(false);
      expect(events).toEqual(["opened", decision === "acceptForSession" ? "decline" : decision]);
    },
  );

  it("cancels a pending prompt and rejects late decisions", async () => {
    const gate = new ComputerApprovalGate();
    const controller = new AbortController();
    let requestId = "";
    const resolved: unknown[] = [];
    const result = gate.request({
      threadId: "a",
      signal: controller.signal,
      publish: async (id, decision) => {
        requestId = id;
        resolved.push(decision);
        if (decision === undefined) controller.abort();
      },
    });
    await expect(result).rejects.toThrow();
    expect(resolved).toEqual([undefined, "cancel"]);
    expect(gate.respond("a", requestId, "accept")).toBe(false);
  });
});
