import type { ComputerEvent } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class StopRearmBackend extends FakeComputerBackend {
  stopCalls = 0;
  rearmCalls = 0;
  rearmError: Error | null = null;
  async stopInput(): Promise<void> {
    this.stopCalls += 1;
  }
  async rearmInput(): Promise<void> {
    this.rearmCalls += 1;
    if (this.rearmError) throw this.rearmError;
  }
}

describe("computer emergency stop", () => {
  it("latches host-wide, refuses mutating admission on every thread, and re-arms explicitly", async () => {
    const backend = new StopRearmBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const events: ComputerEvent[] = [];
    manager.onEvent((event) => events.push(event));
    // Seed a thread record so the republish has somewhere to land.
    await manager.getThreadState("esc-thread");

    await manager.emergencyStopInput();
    expect(backend.stopCalls).toBe(1);
    expect(events.some((event) => event.type === "computer.input-stopped" && event.stopped)).toBe(
      true,
    );
    // Every mutating admission refuses — this thread, another thread, and
    // the human's own pane input (undefined thread) alike.
    await expect(manager.click("esc-thread", { x: 10, y: 10 })).rejects.toThrow("Escape");
    await expect(manager.typeText("other-thread", "x")).rejects.toThrow("Escape");
    await expect(manager.click(undefined, { x: 10, y: 10 })).rejects.toThrow("Escape");
    // Reads are not input: state reads still answer so the re-arm gate and
    // the panels have something to show.
    await expect(manager.listWindows()).resolves.toBeDefined();
    // Status and every thread snapshot carry the latch for surfaces that
    // missed the event.
    expect((await manager.getStatus()).inputStopped).toBe(true);
    expect((await manager.getThreadState("esc-thread")).inputStopped).toBe(true);
    // A second press is idempotent: the latch is already held, so no second
    // host-wide event and no second republish storm.
    await manager.emergencyStopInput();
    expect(events.filter((event) => event.type === "computer.input-stopped")).toHaveLength(1);

    const result = await manager.rearmInput();
    expect(result).toEqual({ rearmed: true, wasStopped: true });
    expect(backend.rearmCalls).toBe(1);
    expect(events.some((event) => event.type === "computer.input-stopped" && !event.stopped)).toBe(
      true,
    );
    expect((await manager.getStatus()).inputStopped).toBe(false);
    await manager.dispose();
  });

  it("fails queued work at its wait instead of dispatching after the press", async () => {
    const backend = new StopRearmBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const entered = deferred();
    const release = deferred();
    const active = manager.withAgentActivity("esc-queued", async () => {
      entered.resolve();
      await release.promise;
      // Post-release work goes through the stopped gate and throws.
      await manager.click("esc-queued", { x: 10, y: 10 });
      return "active-finished";
    });
    await entered.promise;
    const queuedWork = vi.fn(async () => "queued");
    const queued = manager.withAgentActivity("esc-queued", queuedWork);
    const queuedRejected = expect(queued).rejects.toThrow("Escape");
    const activeRejected = expect(active).rejects.toThrow("Escape");
    await manager.emergencyStopInput();
    release.resolve();
    await queuedRejected;
    await activeRejected;
    expect(queuedWork).not.toHaveBeenCalled();
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("keeps the latch when the backend stop fails — fail closed, not silent", async () => {
    class FailingStopBackend extends FakeComputerBackend {
      stopCalls = 0;
      async stopInput(): Promise<void> {
        this.stopCalls += 1;
        // Only the first stop fails, so dispose()'s own stop does not mask
        // the assertion that the latch outlived the failure.
        if (this.stopCalls === 1) throw new Error("backend wedged");
      }
    }
    const backend = new FailingStopBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(manager.emergencyStopInput()).rejects.toThrow("backend wedged");
    expect((await manager.getStatus()).inputStopped).toBe(true);
    await expect(manager.click("esc-thread", { x: 1, y: 1 })).rejects.toThrow("Escape");
    await manager.dispose();
  });

  it("a press landing mid-rearm wins — the stale re-arm cannot clear the latch", async () => {
    const pending = deferred();
    class DeferredRearmBackend extends StopRearmBackend {
      override async rearmInput(): Promise<void> {
        this.rearmCalls += 1;
        await pending.promise;
      }
    }
    const backend = new DeferredRearmBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const events: ComputerEvent[] = [];
    manager.onEvent((event) => events.push(event));

    await manager.emergencyStopInput();
    const rearm = manager.rearmInput();
    await vi.waitFor(() => expect(backend.rearmCalls).toBe(1));
    // The operator presses Escape again while the host re-arm is in flight.
    await manager.emergencyStopInput();
    pending.resolve();
    await expect(rearm).resolves.toEqual({ rearmed: true, wasStopped: true });
    // Without the epoch check this re-arm would clear a latch it never saw:
    // the second press must keep input stopped and emit no re-arm event.
    expect((await manager.getStatus()).inputStopped).toBe(true);
    await expect(manager.click("esc-thread", { x: 1, y: 1 })).rejects.toThrow("Escape");
    expect(events.some((event) => event.type === "computer.input-stopped" && !event.stopped)).toBe(
      false,
    );
    await manager.dispose();
  });

  it("keeps the latch when the backend re-arm relay fails", async () => {
    const backend = new StopRearmBackend();
    backend.rearmError = new Error("host unreachable");
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await manager.emergencyStopInput();
    await expect(manager.rearmInput()).rejects.toThrow("host unreachable");
    expect(backend.rearmCalls).toBe(1);
    // The host never confirmed, so the manager-side latch must still be held
    // rather than reporting authority the driver does not have.
    expect((await manager.getStatus()).inputStopped).toBe(true);
    await expect(manager.click("esc-thread", { x: 1, y: 1 })).rejects.toThrow("Escape");
    // A retry that reaches the host clears normally.
    backend.rearmError = null;
    await expect(manager.rearmInput()).resolves.toEqual({ rearmed: true, wasStopped: true });
    expect((await manager.getStatus()).inputStopped).toBe(false);
    await manager.dispose();
  });

  it("clears unconditionally for a backend with no re-arm route", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await manager.emergencyStopInput();
    expect((await manager.getStatus()).inputStopped).toBe(true);
    // The manager latch is the only one this backend has: clearing it is the
    // correct re-arm because nothing else can still be refusing input.
    await expect(manager.rearmInput()).resolves.toEqual({ rearmed: true, wasStopped: true });
    expect((await manager.getStatus()).inputStopped).toBe(false);
    await manager.dispose();
  });

  it("re-arm with nothing stopped is a no-op that still relays to the host", async () => {
    const backend = new StopRearmBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const events: ComputerEvent[] = [];
    manager.onEvent((event) => events.push(event));
    await expect(manager.rearmInput()).resolves.toEqual({ rearmed: true, wasStopped: false });
    expect(backend.rearmCalls).toBe(1);
    expect(events.some((event) => event.type === "computer.input-stopped")).toBe(false);
    await manager.dispose();
  });
});
