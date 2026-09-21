import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ComputerApprovalGate, computerApprovalGate } from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { makeAgentGatewayComputerTools } from "../agentGateway/computerTools.ts";
import { GatewayToolError, type ToolContext } from "../agentGateway/toolRuntime.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function context(threadId: string, turnId: string): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:approval-lease",
      threadId,
      provider: "claudeAgent",
      turnId,
    },
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:approval-lease",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: turnId,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

describe("computer approval lease", () => {
  it("a turn-end accept for the previous turn settles false and dispatches nothing", async () => {
    const gate = new ComputerApprovalGate();
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "approval-lease-thread";
    const opened = deferred();
    let previousRequestId = "";
    const tools = makeAgentGatewayComputerTools({
      manager,
      authorizeAction: (_name, _args, ctx, signal) =>
        gate.requestTask({
          threadId: ctx.callerThreadId,
          turnId: ctx.callerTurnId ?? "",
          signal,
          publish: async (id, decision) => {
            if (decision !== undefined) return;
            previousRequestId = id;
            opened.resolve();
          },
        }),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_type_text")!;
    try {
      // Turn one opens its consent prompt and waits for the user.
      const first = Effect.runPromise(
        tool.handler({ text: "late", include_screenshot: false }, context(threadId, "turn-1")),
      );
      await opened.promise;
      // The turn ends and a new one prompts: the boundary cancels the old
      // prompt, so the user's late accept for turn one settles false.
      const next = gate.requestTask({
        threadId,
        turnId: "turn-2",
        signal: new AbortController().signal,
        publish: async (id, decision) => {
          if (decision === undefined) gate.respond(threadId, id, "accept");
        },
      });
      expect(gate.respond(threadId, previousRequestId, "accept")).toBe(false);
      expect(await next).toBe(true);
      const result = await first;
      expect(result.isError).toBe(true);
      expect(backend.callsFor("typeText")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("an approval that expired before the user answered dispatches nothing", async () => {
    const gate = new ComputerApprovalGate();
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "approval-expiry-thread";
    const expired = new AbortController();
    expired.abort(new Error("approval window expired"));
    let publishes = 0;
    const tools = makeAgentGatewayComputerTools({
      manager,
      authorizeAction: (_name, _args, ctx) =>
        gate
          .request({
            threadId: ctx.callerThreadId,
            signal: expired.signal,
            publish: async () => {
              publishes += 1;
            },
          })
          .catch(() => false),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_type_text")!;
    try {
      const result = await Effect.runPromise(
        tool.handler({ text: "expired", include_screenshot: false }, context(threadId, "turn-1")),
      );
      // Expired approval reads as denied, the prompt never even opened, and no
      // input was dispatched.
      expect(result.isError).toBe(true);
      expect(publishes).toBe(0);
      expect(backend.callsFor("typeText")).toHaveLength(0);
      // The gate is unpoisoned: a fresh prompt still works.
      const live = gate.request({
        threadId,
        signal: new AbortController().signal,
        publish: async (id, decision) => {
          if (decision === undefined) gate.respond(threadId, id, "accept");
        },
      });
      expect(await live).toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  it("a turn that ended before dispatch approves nothing and dispatches nothing", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "approval-pause-thread";
    const failingCaller = (active: boolean): ToolContext => ({
      ...context(threadId, "turn-1"),
      assertCallerTurnActive: () =>
        active
          ? Effect.void
          : Effect.fail(new GatewayToolError("caller_turn_inactive", "original turn ended")),
    });
    const tools = makeAgentGatewayComputerTools({ manager });
    const tool = tools.find((entry) => entry.definition.name === "computer_type_text")!;
    try {
      // A late accept after the turn ended dispatches nothing even though the
      // approval itself would have been granted.
      const denied = await Effect.runPromise(
        tool.handler({ text: "late", include_screenshot: false }, failingCaller(false)),
      );
      expect(denied.isError).toBe(true);
      expect(backend.callsFor("typeText")).toHaveLength(0);
      // The same turn still live dispatches exactly once.
      const accepted = await Effect.runPromise(
        tool.handler({ text: "live", include_screenshot: false }, failingCaller(true)),
      );
      expect(accepted.isError).not.toBe(true);
      expect(backend.callsFor("typeText")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("a desktop interruption revokes standing consent before the next mutating call", async () => {
    // The manager wires the backend's interruption report into the shared
    // gate, so this runs through the real authorize path: the answer that
    // carried the pre-lock turn does not authorize the post-lock call.
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "interruption-consent-thread";
    const prompts: string[] = [];
    const tools = makeAgentGatewayComputerTools({
      manager,
      authorizeAction: (_name, _args, ctx, signal) =>
        computerApprovalGate.requestTask({
          threadId: ctx.callerThreadId,
          turnId: ctx.callerTurnId ?? "",
          signal,
          publish: async (id, decision) => {
            if (decision === undefined) prompts.push(id);
          },
        }),
    });
    const tool = tools.find((entry) => entry.definition.name === "computer_type_text")!;
    const ctx = context(threadId, "turn-1");
    try {
      const first = Effect.runPromise(
        tool.handler({ text: "before", include_screenshot: false }, ctx),
      );
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      computerApprovalGate.respond(threadId, prompts[0]!, "accept");
      await first;
      expect(backend.callsFor("typeText")).toHaveLength(1);
      // The screen locked and unlocked between calls: the host's
      // interruption count advanced, the backend announced it, and the
      // standing grant is gone — the same tool republishes its prompt
      // instead of riding the pre-interruption answer.
      backend.emitDesktopInterrupted(["screen-lock"]);
      const second = Effect.runPromise(
        tool.handler({ text: "after", include_screenshot: false }, ctx),
      );
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      computerApprovalGate.respond(threadId, prompts[1]!, "accept");
      await second;
      expect(backend.callsFor("typeText")).toHaveLength(2);
    } finally {
      computerApprovalGate.cancelThread(threadId);
      await manager.dispose();
    }
  });
});
