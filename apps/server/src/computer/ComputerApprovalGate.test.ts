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

  it("re-prompts a declined task next turn without leaking the decision into clipboard", async () => {
    const gate = new ComputerApprovalGate();
    const taskPrompts: string[] = [];
    const clipboardPrompts: string[] = [];
    const taskInput = (turnId: string) => ({
      threadId: "a",
      turnId,
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) taskPrompts.push(id);
      },
    });
    const clipboardInput = () => ({
      threadId: "a",
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) clipboardPrompts.push(id);
      },
    });
    // Turn one declines the task prompt.
    const first = gate.requestTask(taskInput("turn-1"));
    gate.respond("a", taskPrompts[0]!, "decline");
    expect(await first).toBe(false);
    // A clipboard approval is a separate per-call consent: the task decline
    // neither answers it nor suppresses its prompt.
    const clipboardFirst = gate.request(clipboardInput());
    expect(clipboardPrompts).toHaveLength(1);
    gate.respond("a", clipboardPrompts[0]!, "decline");
    expect(await clipboardFirst).toBe(false);
    // Turn two re-prompts instead of replaying the decline, and can accept.
    const second = gate.requestTask(taskInput("turn-2"));
    expect(taskPrompts).toHaveLength(2);
    gate.respond("a", taskPrompts[1]!, "accept");
    expect(await second).toBe(true);
    // The clipboard decline never touched the task grant: the turn stays approved.
    expect(await gate.requestTask(taskInput("turn-2"))).toBe(true);
    expect(taskPrompts).toHaveLength(2);
    // And the task grant never answers a clipboard prompt either.
    const clipboardSecond = gate.request(clipboardInput());
    expect(clipboardPrompts).toHaveLength(2);
    gate.respond("a", clipboardPrompts[1]!, "accept");
    expect(await clipboardSecond).toBe(true);
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

  it("refuses a full per-thread queue retryably while other chats still prompt", async () => {
    const gate = new ComputerApprovalGate();
    const quiet = {
      threadId: "busy",
      signal: new AbortController().signal,
      publish: async () => {},
    };
    for (let i = 0; i < 8; i++) void gate.request(quiet);
    await expect(gate.request(quiet)).rejects.toMatchObject({
      code: "approval_queue_full",
      retryable: true,
    });
    // The thread cap is per chat: an uninvolved thread still gets its prompt.
    let otherId = "";
    const other = gate.request({
      threadId: "other",
      signal: new AbortController().signal,
      publish: async (id) => {
        otherId = id;
      },
    });
    gate.respond("other", otherId, "accept");
    expect(await other).toBe(true);
    gate.cancelThread("busy");
  });

  it("refuses past the shared queue cap with the same retryable code", async () => {
    const gate = new ComputerApprovalGate();
    const threads = Array.from({ length: 16 }, (_, i) => `thread-${i}`);
    for (const threadId of threads) {
      for (let i = 0; i < 8; i++) {
        void gate.request({
          threadId,
          signal: new AbortController().signal,
          publish: async () => {},
        });
      }
    }
    await expect(
      gate.request({
        threadId: "overflow",
        signal: new AbortController().signal,
        publish: async () => {},
      }),
    ).rejects.toMatchObject({ code: "approval_queue_full", retryable: true });
    for (const threadId of threads) gate.cancelThread(threadId);
  });

  it("an abort releases a consent whose publish never resolves", async () => {
    const gate = new ComputerApprovalGate();
    const abort = new AbortController();
    const request = gate.request({
      threadId: "stuck",
      signal: abort.signal,
      publish: () => new Promise(() => {}),
    });
    abort.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    // The slot was released: the thread can prompt again.
    const next = gate.request({
      threadId: "stuck",
      signal: new AbortController().signal,
      publish: async () => {},
    });
    gate.cancelThread("stuck");
    await expect(next).resolves.toBe(false);
  });

  it("a dismissal publish failure cannot convert an accepted consent into a rejection", async () => {
    const gate = new ComputerApprovalGate();
    let requestId = "";
    const decision = gate.request({
      threadId: "dismiss",
      signal: new AbortController().signal,
      publish: async (id, resolved) => {
        if (resolved === undefined) requestId = id;
        else throw new Error("socket gone");
      },
    });
    gate.respond("dismiss", requestId, "accept");
    await expect(decision).resolves.toBe(true);
  });

  it("a desktop interruption revokes grants but keeps declines and live prompts", async () => {
    const gate = new ComputerApprovalGate();
    const prompts = new Map<string, string[]>();
    const input = (threadId: string) => ({
      threadId,
      turnId: "turn",
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) {
          const ids = prompts.get(threadId) ?? [];
          ids.push(id);
          prompts.set(threadId, ids);
        }
      },
    });
    // One thread holds a standing grant, another holds a standing decline,
    // and a third's prompt is still open when the interruption lands.
    const granted = gate.requestTask(input("granted"));
    gate.respond("granted", prompts.get("granted")![0]!, "accept");
    expect(await granted).toBe(true);
    const declined = gate.requestTask(input("declined"));
    gate.respond("declined", prompts.get("declined")![0]!, "decline");
    expect(await declined).toBe(false);
    const pending = gate.requestTask(input("pending"));
    expect(prompts.get("pending")).toHaveLength(1);
    gate.revokeTaskGrants();
    // The grant is gone: the next call republishes the prompt instead of
    // riding the pre-interruption answer.
    const reprompted = gate.requestTask(input("granted"));
    expect(prompts.get("granted")).toHaveLength(2);
    gate.respond("granted", prompts.get("granted")![1]!, "accept");
    expect(await reprompted).toBe(true);
    // The decline stays declined without a new prompt: a refusal is not the
    // authority a lock needs to break.
    expect(await gate.requestTask(input("declined"))).toBe(false);
    expect(prompts.get("declined")).toHaveLength(1);
    // The still-open prompt survives: its answer can only postdate the
    // interruption, so accepting it now is the re-auth itself.
    gate.respond("pending", prompts.get("pending")![0]!, "accept");
    expect(await pending).toBe(true);
    expect(await gate.requestTask(input("pending"))).toBe(true);
    expect(prompts.get("pending")).toHaveLength(1);
  });

  it("keeps visible-use consent separate from routine consent and scoped to the turn", async () => {
    const gate = new ComputerApprovalGate();
    const ids: string[] = [];
    const input = (turnId: string) => ({
      threadId: "a",
      turnId,
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) ids.push(id);
      },
    });
    const routine = gate.requestTask(input("turn-1"));
    // A visible-use prompt in the same turn must not cancel the routine one.
    const foreground = gate.requestForegroundTask(input("turn-1"));
    expect(ids).toHaveLength(2);
    gate.respond("a", ids[0]!, "accept");
    expect(await routine).toBe(true);
    expect(gate.hasForegroundGrant("a", "turn-1")).toBe(false);
    gate.respond("a", ids[1]!, "accept");
    expect(await foreground).toBe(true);
    expect(gate.hasForegroundGrant("a", "turn-1")).toBe(true);
    expect(await gate.requestForegroundTask(input("turn-1"))).toBe(true);
    expect(ids).toHaveLength(2);
    expect(gate.hasForegroundGrant("a", "turn-2")).toBe(false);
    gate.revokeTaskGrants();
    expect(gate.hasForegroundGrant("a", "turn-1")).toBe(false);
  });

  it("remembers a visible-use decline for the turn without nagging", async () => {
    const gate = new ComputerApprovalGate();
    let prompts = 0;
    const input = {
      threadId: "a",
      turnId: "turn",
      signal: new AbortController().signal,
      publish: async (id: string, decision?: string) => {
        if (decision === undefined) {
          prompts++;
          gate.respond("a", id, "decline");
        }
      },
    };
    expect(await gate.requestForegroundTask(input)).toBe(false);
    expect(await gate.requestForegroundTask(input)).toBe(false);
    expect(prompts).toBe(1);
  });
});
