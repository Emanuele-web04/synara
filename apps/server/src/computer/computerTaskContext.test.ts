import { describe, expect, it } from "vitest";
import { currentComputerTask, withComputerTask } from "./computerTaskContext";

describe("computer task attribution", () => {
  it("is absent in ordinary work and expires in detached continuations", async () => {
    expect(currentComputerTask()).toBeUndefined();
    let readLater!: () => ReturnType<typeof currentComputerTask>;
    let wake!: () => void;
    const gate = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const task = { threadId: "thread", turnId: "turn" };
    let detached!: Promise<ReturnType<typeof currentComputerTask>>;
    await withComputerTask(task, async () => {
      expect(currentComputerTask()).toEqual(task);
      readLater = currentComputerTask;
      detached = gate.then(() => currentComputerTask());
    });
    wake();
    expect(readLater()).toBeUndefined();
    expect(await detached).toBeUndefined();
  });
});
