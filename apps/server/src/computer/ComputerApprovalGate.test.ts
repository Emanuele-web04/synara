import { describe, expect, it } from "vitest";
import {
  COMPUTER_SESSION_APPROVAL_UNAVAILABLE_REASON,
  ComputerApprovalGate,
  computerApprovalActivity,
} from "./ComputerApprovalGate.ts";

describe("ComputerApprovalGate", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "binds %s to the requesting conversation and one call",
    async (decision) => {
      const gate = new ComputerApprovalGate();
      const signal = new AbortController().signal;
      let requestId = "";
      const events: unknown[] = [];
      const result = gate.request({
        threadId: "a",
        signal,
        publish: async (id, outcome) => {
          events.push(outcome ?? "opened");
          requestId = id;
          if (outcome === undefined) {
            expect(gate.respond("b", id, "accept")).toBe(false);
            expect(gate.respond("a", id, decision)).toBe(true);
          }
        },
      });
      expect(await result).toEqual({ decision });
      expect(gate.respond("a", requestId, "accept")).toBe(false);
      expect(events).toEqual(["opened", { decision }]);
    },
  );

  it("declines a session-wide grant explicitly, with the reason on the outcome", async () => {
    const gate = new ComputerApprovalGate();
    const outcomes: unknown[] = [];
    const result = await gate.request({
      threadId: "a",
      signal: new AbortController().signal,
      publish: async (id, outcome) => {
        outcomes.push(outcome);
        if (outcome === undefined) expect(gate.respond("a", id, "acceptForSession")).toBe(true);
      },
    });
    expect(result).toEqual({
      decision: "decline",
      reason: COMPUTER_SESSION_APPROVAL_UNAVAILABLE_REASON,
    });
    expect(outcomes).toEqual([undefined, result]);
  });

  it("cancels a pending prompt and rejects late decisions", async () => {
    const gate = new ComputerApprovalGate();
    const controller = new AbortController();
    let requestId = "";
    const resolved: unknown[] = [];
    const result = gate.request({
      threadId: "a",
      signal: controller.signal,
      publish: async (id, outcome) => {
        requestId = id;
        resolved.push(outcome);
        if (outcome === undefined) controller.abort();
      },
    });
    await expect(result).rejects.toThrow();
    expect(resolved).toEqual([undefined, { decision: "cancel" }]);
    expect(gate.respond("a", requestId, "accept")).toBe(false);
  });
});

describe("computerApprovalActivity", () => {
  it("publishes the arguments as the name/value rows the approval card reads", () => {
    const opened = computerApprovalActivity({
      requestId: "computer:1",
      toolName: "computer_click",
      args: { x: 10, y: 20, label: "Save", modifiers: ["shift"] },
      turnId: "turn-1",
      createdAt: "2026-09-16T00:00:00.000Z",
    });
    expect(opened.eventKey).toBe("computer:1:open");
    expect(opened.activity).toMatchObject({
      kind: "approval.requested",
      turnId: "turn-1",
      payload: {
        requestId: "computer:1",
        requestKind: "tool",
        toolName: "computer_click",
        toolParamsDisplay: [
          { name: "x", value: "10" },
          { name: "y", value: "20" },
          { name: "label", value: "Save" },
          { name: "modifiers", value: '["shift"]' },
        ],
        sessionApprovalAvailable: false,
      },
    });

    const resolved = computerApprovalActivity({
      requestId: "computer:1",
      toolName: "computer_read_clipboard",
      args: {},
      outcome: { decision: "decline", reason: "why" },
      turnId: null,
      createdAt: "2026-09-16T00:00:00.000Z",
    });
    expect(resolved.eventKey).toBe("computer:1:resolved");
    expect(resolved.activity).toMatchObject({
      kind: "approval.resolved",
      turnId: null,
      payload: { decision: "decline", reason: "why" },
    });
    expect(resolved.activity.payload).not.toHaveProperty("toolParamsDisplay");
  });
});
