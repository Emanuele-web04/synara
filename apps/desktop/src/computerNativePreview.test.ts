import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { cuaComputerTaskKey, type CuaPreviewTarget } from "@synara/shared/cuaDriverProtocol";
import { ComputerNativePreview } from "./computerNativePreview";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const target = (turnId = "one", windowId = 10): CuaPreviewTarget => ({
  task: { threadId: "thread", turnId, label: "Calculator" },
  pid: 42,
  windowId,
});

function fixture() {
  function makeChild() {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      commands: [] as Array<Record<string, unknown>>,
      autoExit: true,
      kill: vi.fn(() => {
        if (child.autoExit) queueMicrotask(() => child.emit("exit", 0));
        return true;
      }),
    });
    child.stdin.on("data", (bytes) => child.commands.push(JSON.parse(bytes.toString())));
    return child;
  }
  const children: Array<ReturnType<typeof makeChild>> = [];
  const spawnHelper = vi.fn(() => {
    const child = makeChild();
    children.push(child);
    return child;
  });
  const onUserStop = vi.fn(),
    onError = vi.fn();
  const preview = new ComputerNativePreview({
    helperPath: "/fixture/helper",
    spawn: spawnHelper as unknown as typeof spawn,
    onUserStop,
    onError,
  });
  return { preview, children, spawnHelper, onUserStop, onError };
}

describe("native Computer preview", () => {
  it("spawns only on actual use and coalesces targets without transporting images", async () => {
    const f = fixture();
    await tick();
    expect(f.spawnHelper).not.toHaveBeenCalled();
    for (let id = 1; id <= 100; id++) f.preview.update(target("one", id));
    await tick();
    expect(f.children).toHaveLength(1);
    expect(f.children[0]!.commands).toEqual([
      {
        taskKey: cuaComputerTaskKey(target().task),
        windowId: 100,
        pid: 42,
        label: "Calculator",
      },
    ]);
    f.preview.update(target("one", 100));
    await tick();
    expect(f.children[0]!.commands).toHaveLength(1);
    await f.preview.stop();
  });

  it("does not spawn if stopped while startup is pending", async () => {
    const f = fixture();
    f.preview.update(target());
    await f.preview.stop();
    expect(f.children).toHaveLength(0);
  });

  it("waits for the old capture to exit and keeps the newest target", async () => {
    const f = fixture();
    f.preview.update(target());
    await tick();
    const first = f.children[0]!;
    first.autoExit = false;
    f.preview.update(target("two", 20));
    await tick();
    f.preview.update(target("two", 30));
    expect(f.children).toHaveLength(1);
    first.emit("exit", 0);
    await tick();
    expect(f.children).toHaveLength(2);
    expect(f.children[1]!.commands[0]?.windowId).toBe(30);
    await f.preview.endTask(target("one").task);
    expect(f.children[1]!.kill).not.toHaveBeenCalled();
    await f.preview.endTask(target("two").task);
    expect(f.children[1]!.kill).toHaveBeenCalledTimes(1);
  });

  it("forwards Stop only from the owned helper and matching task", async () => {
    const f = fixture();
    f.preview.update(target());
    await tick();
    const child = f.children[0]!;
    child.stdout.write(JSON.stringify({ type: "user-stopped", taskKey: "wrong" }) + "\n");
    expect(f.onUserStop).not.toHaveBeenCalled();
    child.stdout.write(
      JSON.stringify({ type: "user-stopped", taskKey: cuaComputerTaskKey(target().task) }) + "\n",
    );
    expect(f.onUserStop).toHaveBeenCalledWith(target().task);
    await f.preview.stop();
  });

  it.each(["user-stopped", "pipe-error"])(
    "keeps a new task after an old helper's %s",
    async (event) => {
      const f = fixture();
      f.preview.update(target());
      await tick();
      const first = f.children[0]!;
      first.autoExit = false;
      f.preview.update(target("two", 20));
      await tick();
      if (event === "user-stopped") {
        first.stdout.write(
          JSON.stringify({ type: event, taskKey: cuaComputerTaskKey(target().task) }) + "\n",
        );
      } else {
        first.stdin.emit("error", new Error("Old pipe closed"));
      }
      first.emit("exit", 0);
      await tick();
      expect(f.children).toHaveLength(2);
      expect(f.children[1]!.commands[0]?.windowId).toBe(20);
      await f.preview.stop();
    },
  );

  it("does not restart a crashed helper without another explicit operation", async () => {
    const f = fixture();
    f.preview.update(target());
    await tick();
    f.children[0]!.emit("exit", 1);
    await tick();
    expect(f.children).toHaveLength(1);
    await f.preview.stop();
  });
});
