import { describe, expect, it, vi } from "vitest";

import { computerApprovalGate } from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("computer revoke", () => {
  it("off revokes queued admission, aborts the active operation, and lands no click", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const entered = deferred();
    const release = deferred();
    const active = manager.withAgentActivity("revoke-thread", async () => {
      entered.resolve();
      await release.promise;
      await manager.click("revoke-thread", { x: 10, y: 10 });
      return "active-finished";
    });
    await entered.promise;
    const queuedWork = vi.fn(async () => "queued");
    const queued = manager.withAgentActivity("revoke-thread", queuedWork);
    const queuedRejected = expect(queued).rejects.toThrow("revoked");
    const activeRejected = expect(active).rejects.toThrow("revoked");
    await manager.setControlEnabled("revoke-thread", false);
    release.resolve();
    await queuedRejected;
    await activeRejected;
    expect(queuedWork).not.toHaveBeenCalled();
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("a late accept for a prompt open at revoke settles false", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "revoke-gate-thread";
    const opened = deferred();
    let requestId = "";
    const pending = computerApprovalGate.request({
      threadId,
      signal: new AbortController().signal,
      publish: async (id, decision) => {
        if (decision === undefined) {
          requestId = id;
          opened.resolve();
        }
      },
    });
    const settledFalse = expect(pending).resolves.toBe(false);
    await opened.promise;
    // Off settles pending prompts synchronously through the shared gate.
    await manager.setControlEnabled(threadId, false);
    expect(computerApprovalGate.respond(threadId, requestId, "accept")).toBe(false);
    await settledFalse;
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("revoke still stops input while the first of two overlapping calls is active", async () => {
    class StopCountingBackend extends FakeComputerBackend {
      stopInputCalls = 0;
      async stopInput(): Promise<void> {
        this.stopInputCalls++;
      }
    }
    const backend = new StopCountingBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const entered = deferred();
    const release = deferred();
    const first = manager.withAgentActivity("overlap-thread", async () => {
      entered.resolve();
      // A nested overlapping authority on the same thread runs immediately
      // (same transaction) and completes while the outer call is active: its
      // cleanup must not drop the outer call's authority entry.
      await manager.withAgentActivity("overlap-thread", async () => "inner");
      await release.promise;
      // Post-release work goes through the revoked gate and throws.
      await manager.click("overlap-thread", { x: 10, y: 10 });
      return "first-finished";
    });
    await entered.promise;
    // Let the nested call finish while the outer call is still blocked.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const firstRejected = expect(first).rejects.toThrow("revoked");
    await manager.setControlEnabled("overlap-thread", false);
    expect(backend.stopInputCalls).toBe(1);
    release.resolve();
    await firstRejected;
    await manager.dispose();
  });
});
