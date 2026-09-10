import { afterEach, expect, it, vi } from "vitest";
import { ComputerPermissionGate } from "./computerPermissionGate";
afterEach(() => vi.useRealTimers());

it("revokes running and queued calls before stopping, and fences new reads", async () => {
  const gate = new ComputerPermissionGate();
  let finish!: () => void;
  let aborted = false;
  const active = gate.run(
    "thread",
    undefined,
    (signal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  );
  await Promise.resolve();
  let stopped = false;
  const change = gate.change("thread", false, async () => {
    stopped = true;
  });
  expect(aborted).toBe(true);
  await expect(gate.run("thread", undefined, async () => 1)).rejects.toThrow("revoked");
  expect(stopped).toBe(true);
  finish();
  await active;
  await change;
  expect(stopped).toBe(true);
  await expect(gate.run("thread", undefined, async () => 1)).rejects.toThrow("revoked");
  expect(await gate.run("other", undefined, async () => 1)).toBe(1);
});

it("bounds teardown failure and never grants when an expired stop finally completes", async () => {
  vi.useFakeTimers();
  const gate = new ComputerPermissionGate(100);
  let finish!: () => void;
  const change = gate.change(
    "thread",
    true,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = expect(change).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  finish();
  await Promise.resolve();
  await expect(gate.run("thread", undefined, async () => 1)).rejects.toThrow("revoked");
  gate.close();
  await expect(gate.run("another-thread", undefined, async () => 1)).rejects.toThrow();
});

it("cancels an admitted call before it reaches the desktop", async () => {
  const gate = new ComputerPermissionGate();
  const action = vi.fn().mockResolvedValue(1);
  const queued = gate.run("thread", undefined, action);
  const rejected = expect(queued).rejects.toThrow();
  await gate.change("thread", false, async () => undefined);
  await rejected;
  expect(action).not.toHaveBeenCalled();
});

it("does not grant after failed runtime teardown and permits an explicit retry", async () => {
  const gate = new ComputerPermissionGate();
  await expect(
    gate.change("thread", true, async () => {
      throw new Error("stop failed");
    }),
  ).rejects.toThrow("stop failed");
  await expect(gate.run("thread", undefined, async () => 1)).rejects.toThrow("revoked");
  await gate.change("thread", true, async () => undefined);
  expect(await gate.run("thread", undefined, async () => 1)).toBe(1);
});
