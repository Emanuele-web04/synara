import { expect, it } from "vitest";
import { ComputerPermissionGate } from "./computerPermissionGate";

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
  expect(stopped).toBe(false);
  finish();
  await active;
  await change;
  expect(stopped).toBe(true);
  await expect(gate.run("thread", undefined, async () => 1)).rejects.toThrow("revoked");
  expect(await gate.run("other", undefined, async () => 1)).toBe(1);
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
