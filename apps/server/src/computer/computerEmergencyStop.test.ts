import type { ComputerEvent } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { desktopOperationSignal } from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Records the OS-level stop relay the manager hands to its backend. */
class StopInputBackend extends FakeComputerBackend {
  stopCalls = 0;
  async stopInput(): Promise<void> {
    this.stopCalls += 1;
  }
}

describe("computer emergency stop", () => {
  it("interrupts live work once and the next action succeeds without a re-arm", async () => {
    const backend = new StopInputBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const events: ComputerEvent[] = [];
    manager.onEvent((event) => events.push(event));
    // Seed a thread record so the state read has somewhere to land.
    await manager.getThreadState("esc-thread");

    // Input is open before the press.
    await manager.click("esc-thread", { x: 10, y: 10 });

    // A live operation observes the stop through its operation signal, the
    // same cancellation an ordinary stop delivers.
    const entered = deferred();
    const live = manager.withAgentActivity("esc-thread", async () => {
      entered.resolve();
      const signal = desktopOperationSignal();
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "unreachable";
    });
    await entered.promise;
    const liveRejected = expect(live).rejects.toMatchObject({ controlRevoked: true });

    await manager.emergencyStopInput();
    expect(backend.stopCalls).toBe(1);
    await liveRejected;
    // The interrupt is announced and closed out: one stopped, one cleared.
    expect(
      events.filter((event) => event.type === "computer.input-stopped" && event.stopped),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "computer.input-stopped" && !event.stopped),
    ).toHaveLength(1);

    // Momentary: the very next admission dispatches, with no re-arm step and
    // no stopped state left in any surface.
    await expect(manager.click("esc-thread", { x: 11, y: 11 })).resolves.toBeDefined();
    expect(backend.callsFor("click")).toHaveLength(2);
    expect((await manager.getStatus()).inputStopped).toBeUndefined();
    expect((await manager.getThreadState("esc-thread")).inputStopped).toBeUndefined();
    await manager.dispose();
  });

  it("fails queued work at its wait, then admits the next call", async () => {
    const backend = new StopInputBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const entered = deferred();
    const release = deferred();
    const active = manager.withAgentActivity("esc-queued", async () => {
      entered.resolve();
      await release.promise;
      return "active-finished";
    });
    await entered.promise;
    const queuedWork = vi.fn(async () => "queued");
    const queued = manager.withAgentActivity("esc-queued", queuedWork);
    const queuedRejected = expect(queued).rejects.toThrow("Escape");
    await manager.emergencyStopInput();
    release.resolve();
    await queuedRejected;
    // The already-admitted work is untouched; the queued admission dies at
    // its wait rather than dispatching after the press.
    await expect(active).resolves.toBe("active-finished");
    expect(queuedWork).not.toHaveBeenCalled();
    expect(backend.callsFor("click")).toHaveLength(0);
    // The aborted broadcast does not poison later calls: a fresh admission
    // after the press dispatches normally.
    await expect(manager.click("esc-queued", { x: 1, y: 1 })).resolves.toBeDefined();
    expect(backend.callsFor("click")).toHaveLength(1);
    await manager.dispose();
  });

  it("does not latch when the backend stop relay fails", async () => {
    class FailingStopBackend extends FakeComputerBackend {
      stopCalls = 0;
      async stopInput(): Promise<void> {
        this.stopCalls += 1;
        // Only the first stop fails, so dispose()'s own stop is clean.
        if (this.stopCalls === 1) throw new Error("backend wedged");
      }
    }
    const backend = new FailingStopBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(manager.emergencyStopInput()).rejects.toThrow("backend wedged");
    // Momentary by contract: a failed delivery is reported to the caller, but
    // no latch survives it — the next admitted action tries again instead of
    // demanding a manual re-arm.
    await expect(manager.click("esc-thread", { x: 1, y: 1 })).resolves.toBeDefined();
    expect(backend.callsFor("click")).toHaveLength(1);
    await manager.dispose();
  });

  it("treats a pane Escape as ordinary input, never as a stop", async () => {
    const backend = new StopInputBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const events: ComputerEvent[] = [];
    manager.onEvent((event) => events.push(event));

    await expect(manager.pressKey(undefined, "escape")).resolves.toBeDefined();
    expect(backend.callsFor("pressKey").map((call) => call.args[0])).toEqual(["escape"]);
    // No stop relay, no interrupt event: the key the pane sent is a keystroke.
    expect(backend.stopCalls).toBe(0);
    expect(events.filter((event) => event.type === "computer.input-stopped")).toHaveLength(0);
    await manager.dispose();
  });

  it("keeps reads open through the interrupt", async () => {
    const backend = new StopInputBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await manager.emergencyStopInput();
    await expect(manager.listWindows()).resolves.toBeDefined();
    await expect(manager.getStatus()).resolves.toBeDefined();
    await manager.dispose();
  });
});
