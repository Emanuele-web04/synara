import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputerApprovalGate } from "./ComputerApprovalGate.ts";

const EXPIRY_MS = 5 * 60_000;

function fixture() {
  const gate = new ComputerApprovalGate();
  const opened: string[] = [];
  const dismissed: string[] = [];
  const input = {
    threadId: "thread",
    turnId: "turn",
    signal: new AbortController().signal,
    publish: async (id: string, decision?: string) => {
      if (decision === undefined) opened.push(id);
      else dismissed.push(`${id}:${decision}`);
    },
  };
  return { gate, input, opened, dismissed };
}

describe("Computer approval expiry", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["requestTask", "requestForegroundTask"] as const)(
    "%s does not cache an unanswered card as a decline",
    async (method) => {
      vi.useFakeTimers();
      const { gate, input, opened, dismissed } = fixture();
      const pending = gate[method](input);
      const expired = expect(pending).rejects.toMatchObject({
        code: "approval_expired",
        effect: "not-dispatched",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(EXPIRY_MS);
      await expired;
      expect(dismissed).toEqual([`${opened[0]}:cancel`]);
      expect(gate.hasForegroundGrant("thread", "turn")).toBe(false);
      expect(gate.respond("thread", opened[0]!, "accept")).toBe(false);

      const retry = gate[method](input);
      expect(opened).toHaveLength(2);
      expect(gate.respond("thread", opened[1]!, "accept")).toBe(true);
      await expect(retry).resolves.toBe(true);
      await expect(gate[method](input)).resolves.toBe(true);
      expect(opened).toHaveLength(2);
    },
  );

  it("expires concurrent waiters together and shares one replacement prompt", async () => {
    vi.useFakeTimers();
    const { gate, input, opened } = fixture();
    const first = expect(gate.requestForegroundTask(input)).rejects.toMatchObject({
      code: "approval_expired",
    });
    const second = expect(gate.requestForegroundTask(input)).rejects.toMatchObject({
      code: "approval_expired",
    });
    expect(opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(EXPIRY_MS);
    await Promise.all([first, second]);
    const retry = gate.requestForegroundTask(input);
    const follower = gate.requestForegroundTask(input);
    expect(opened).toHaveLength(2);
    gate.respond("thread", opened[1]!, "decline");
    await expect(retry).resolves.toBe(false);
    await expect(follower).resolves.toBe(false);
  });

  it.each(["decline", "cancel", "acceptForSession"] as const)(
    "keeps an explicit %s binding instead of re-prompting",
    async (decision) => {
      vi.useFakeTimers();
      const { gate, input, opened } = fixture();
      const request = gate.requestForegroundTask(input);
      gate.respond("thread", opened[0]!, decision);
      await expect(request).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(EXPIRY_MS);
      await expect(gate.requestForegroundTask(input)).resolves.toBe(false);
      expect(opened).toHaveLength(1);
      expect(gate.hasForegroundGrant("thread", "turn")).toBe(false);
    },
  );

  it("releases an expired slot even when publishing the card never completes", async () => {
    vi.useFakeTimers();
    const { gate, input, opened } = fixture();
    let staleId = "";
    const expired = expect(
      gate.requestForegroundTask({
        ...input,
        publish: (id, decision) => {
          if (decision !== undefined) return Promise.resolve();
          staleId = id;
          return new Promise(() => {});
        },
      }),
    ).rejects.toMatchObject({ code: "approval_expired" });
    await vi.advanceTimersByTimeAsync(EXPIRY_MS);
    await expired;
    expect(gate.respond("thread", staleId, "accept")).toBe(false);
    const retry = gate.requestForegroundTask(input);
    gate.respond("thread", opened[0]!, "accept");
    await expect(retry).resolves.toBe(true);
  });

  it("does not turn a cancelled turn into an expiry or retain a late grant", async () => {
    vi.useFakeTimers();
    const { gate, input, opened } = fixture();
    const controller = new AbortController();
    const cancelled = expect(
      gate.requestForegroundTask({ ...input, signal: controller.signal }),
    ).rejects.toThrow("turn stopped");
    controller.abort(new Error("turn stopped"));
    await cancelled;
    await vi.advanceTimersByTimeAsync(EXPIRY_MS);
    expect(gate.respond("thread", opened[0]!, "accept")).toBe(false);
    expect(gate.hasForegroundGrant("thread", "turn")).toBe(false);
    expect(opened).toHaveLength(1);
  });
});
