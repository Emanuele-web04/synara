import { describe, expect, it, vi } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { computerApprovalGate } from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { assertDesktopOperationActive } from "./DesktopOperationQueue.ts";
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

  it("a stale generation cannot revive control after stop, and re-enable mints a fresh one", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "stale-generation-thread";
    // The turn admitted control at generation 0.
    expect(await manager.admitControl(threadId, "chat", 0, true)).toBe(true);
    // Stop latches: the generation bumps immediately, before any cleanup.
    const stopped = await manager.setControlEnabled(threadId, false);
    expect(stopped.enabled).toBe(false);
    expect(stopped.generation).toBe(1);
    // A request queued before Stop still carries generation 0: it must not
    // re-arm the thread or authorize anything.
    expect(await manager.admitControl(threadId, "request", 0, true)).toBe(false);
    expect(manager.canActivateControl(threadId, 0)).toBe(false);
    expect(manager.canContinueChatControl(threadId)).toBe(false);
    // The user's explicit re-enable is the only way back...
    const reenabled = await manager.setControlEnabled(threadId, true);
    expect(reenabled.enabled).toBe(true);
    // ...and it does not resurrect the stale generation: an old queued
    // request still answers false while the current one answers true.
    expect(await manager.admitControl(threadId, "request", 0, true)).toBe(false);
    expect(await manager.admitControl(threadId, "request", 1, true)).toBe(true);
    // Stop again and the current generation goes stale the same way.
    const stoppedAgain = await manager.setControlEnabled(threadId, false);
    expect(stoppedAgain.generation).toBe(2);
    expect(await manager.admitControl(threadId, "request", 1, true)).toBe(false);
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("a queued invocation cannot slip the gap between the stop latch and the generation bump", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const threadId = "stop-race-thread";
    expect(await manager.admitControl(threadId, "chat", 0, true)).toBe(true);
    // Stop without awaiting: the in-memory latch is held synchronously, but
    // the durable generation bump lands behind the control-state write chain.
    const stopping = manager.setControlEnabled(threadId, false);
    // A request queued before Stop carries generation 0. Between the latch
    // and the bump it looks identical to a fresh invocation — only waiting
    // out the pending write keeps it from re-arming the thread.
    expect(await manager.admitControl(threadId, "request", 0, true)).toBe(false);
    const stopped = await stopping;
    expect(stopped.enabled).toBe(false);
    expect(stopped.generation).toBe(1);
    // The thread stayed disabled through the whole race: generation 1 is the
    // current one and it still answers no.
    expect(manager.canActivateControl(threadId, 0)).toBe(false);
    expect(manager.canActivateControl(threadId, 1)).toBe(false);
    await manager.dispose();
  });

  it("revocation aborts live work with a control-revoked reason, not a bare abort", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const entered = deferred();
    const release = deferred();
    const active = manager.withAgentActivity("reason-thread", async () => {
      entered.resolve();
      await release.promise;
      // The abort is only visible where the operation observes its signal —
      // this throws the reason the controller was aborted with.
      assertDesktopOperationActive();
    });
    await entered.promise;
    // The disable's revoke aborts the live authority synchronously; the stop
    // it queues drains once the call settles.
    const disabling = manager.setControlEnabled("reason-thread", false);
    release.resolve();
    await disabling;
    const rejection = await active.catch((error: unknown) => error);
    // A bare AbortError classifies as retryable; the reason must carry the
    // revocation flag the gateway's do-not-retry logic reads.
    expect(rejection).toBeInstanceOf(ComputerBackendError);
    expect((rejection as ComputerBackendError).controlRevoked).toBe(true);
    await manager.dispose();
  });
});
