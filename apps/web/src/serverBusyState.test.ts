import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerRuntimeStatus } from "@synara/contracts";
import { ServerBusyController } from "./serverBusyState";

const healthy: ServerRuntimeStatus = {
  available: true,
  sampleWindowMs: 30000,
  sampleCount: 1500,
  delayP50Ms: 0,
  delayP99Ms: 5,
  delayMaxMs: 10,
  utilization: 0.1,
  stallWindowCount: 0,
  maxStallMs: 0,
  lastStall: null,
};
let visible = true;
let controller: ServerBusyController;
beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  controller = new ServerBusyController({ isVisible: () => visible });
});
afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
});

it("shows busy after a missed heartbeat, with only one request in flight, then recovers", async () => {
  let respond: ((status: ServerRuntimeStatus) => void) | undefined;
  let calls = 0;
  controller.startHeartbeat(() => {
    calls++;
    return new Promise((resolve) => {
      respond = resolve;
    });
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(controller.getSnapshot().reason).toBe("unresponsive");
  await vi.advanceTimersByTimeAsync(20000);
  expect(calls).toBe(1);
  respond?.(healthy);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().reason).toBe(null);
});

it("explains slow requests without claiming a responsive server is blocked", async () => {
  controller.startHeartbeat(async () => healthy);
  const finish = controller.trackRequest("projects.searchEntries");
  await vi.advanceTimersByTimeAsync(15000);
  expect(controller.getSnapshot()).toMatchObject({
    reason: null,
    pendingRequests: 1,
    slowRequests: 1,
  });
  finish();
  finish();
  expect(controller.getSnapshot().slowRequests).toBe(0);
});

it("derives long-request thresholds from caller options and ignores subscriptions", async () => {
  controller.trackRequest("provider.compactThread", { timeoutMs: null });
  controller.trackRequest("orchestration.subscribeThread");
  await vi.advanceTimersByTimeAsync(15000);
  expect(controller.getSnapshot()).toMatchObject({ pendingRequests: 1, slowRequests: 0 });
  await vi.advanceTimersByTimeAsync(105000);
  expect(controller.getSnapshot().slowRequests).toBe(1);
});

it("explains an extended request before its explicit timeout expires", async () => {
  controller.trackRequest("custom.longOperation", { timeoutMs: 180_000 });
  await vi.advanceTimersByTimeAsync(134_999);
  expect(controller.getSnapshot().slowRequests).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.getSnapshot().slowRequests).toBe(1);
});

it("lets a queued heartbeat response settle before declaring a late renderer timer busy", async () => {
  const changes = vi.fn();
  controller.dispose();
  controller = new ServerBusyController({ onChange: changes });
  controller.startHeartbeat(
    () => new Promise((resolve) => setTimeout(() => resolve(healthy), 3000)),
  );
  const clock = vi.spyOn(performance, "now").mockReturnValue(4000);
  await vi.advanceTimersByTimeAsync(3001);
  expect(changes.mock.calls.some(([snapshot]) => snapshot.reason === "unresponsive")).toBe(false);
  expect(controller.getSnapshot().reason).toBe(null);
  clock.mockRestore();
});

it("reports a recent recovered stall and expires it without relying on clock synchronization", async () => {
  controller.startHeartbeat(async () => ({
    ...healthy,
    lastStall: { durationMs: 5200, ageMs: 29000 },
  }));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot()).toMatchObject({ reason: "recent-stall", lastStallMs: 5200 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(controller.getSnapshot().reason).toBe(null);
});

it("ignores hidden-tab and stale-session heartbeat results", async () => {
  let respond: ((status: ServerRuntimeStatus) => void) | undefined;
  controller.startHeartbeat(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  visible = false;
  controller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(20000);
  expect(controller.getSnapshot().reason).toBe(null);
  visible = true;
  controller.visibilityChanged();
  const oldRespond = respond;
  const stop = controller.startHeartbeat(async () => healthy);
  oldRespond?.({ ...healthy, lastStall: { durationMs: 5200, ageMs: 0 } });
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().reason).toBe(null);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears pending request timers on dispose", () => {
  controller.trackRequest("git.status");
  controller.startHeartbeat(() => new Promise(() => {}));
  controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(controller.getSnapshot()).toMatchObject({
    reason: null,
    pendingRequests: 0,
    slowRequests: 0,
  });
});

it("the heartbeat owner can stop after visibility changes", async () => {
  const stop = controller.startHeartbeat(async () => healthy);
  await vi.advanceTimersByTimeAsync(0);
  visible = false;
  controller.visibilityChanged();
  visible = true;
  controller.visibilityChanged();
  await vi.advanceTimersByTimeAsync(0);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not mistake a suspended renderer timer for a missed server heartbeat", async () => {
  let calls = 0;
  controller.startHeartbeat(() => {
    calls++;
    return new Promise(() => {});
  });
  const clock = vi.spyOn(performance, "now").mockReturnValue(30000);
  await vi.advanceTimersByTimeAsync(3000);
  expect(controller.getSnapshot().reason).toBe(null);
  expect(calls).toBe(2);
  clock.mockRestore();
});

it("retries only the heartbeat after its cancellation and clears busy on a later answer", async () => {
  let calls = 0;
  controller.startHeartbeat((signal) => {
    calls++;
    if (calls > 1) return Promise.resolve(healthy);
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("heartbeat aborted")), {
        once: true,
      }),
    );
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(controller.getSnapshot()).toMatchObject({ reason: "unresponsive", pendingRequests: 0 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(calls).toBe(2);
  expect(controller.getSnapshot().reason).toBe(null);
});
