import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { TerminalSessionSnapshot } from "@t3tools/contracts";

import type { TerminalManagerShape } from "../terminal/Services/Manager";
import { PreviewRuntimeManager } from "./PreviewRuntimeManager";

const terminalSnapshot = {} as TerminalSessionSnapshot;

const terminalManager: TerminalManagerShape = {
  open: () => Effect.succeed(terminalSnapshot),
  write: () => Effect.void,
  ackOutput: () => Effect.void,
  resize: () => Effect.void,
  clear: () => Effect.void,
  restart: () => Effect.succeed(terminalSnapshot),
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => {}),
  dispose: Effect.void,
};

describe("PreviewRuntimeManager", () => {
  it("stops command-backed Live Edit previews", async () => {
    const manager = new PreviewRuntimeManager(terminalManager);
    const input = {
      threadId: "thread-1",
      cwd: process.cwd(),
      command: "echo ready",
      preferredPort: 39998,
    };

    await Effect.runPromise(manager.start(input));
    const result = await Effect.runPromise(manager.stopAll({ threadId: "thread-1" }));
    const state = await Effect.runPromise(manager.getState(input));

    expect(result.stoppedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.urls).toContain("http://127.0.0.1:39998/");
    expect(state.status).toBe("stopped");
  });

  it("nukes explicit-url Live Edit previews that Synara did not spawn", async () => {
    const manager = new PreviewRuntimeManager(terminalManager);
    const input = {
      threadId: "thread-1",
      cwd: process.cwd(),
      url: "http://127.0.0.1:39999",
    };

    await Effect.runPromise(manager.start(input));
    const result = await Effect.runPromise(manager.stopAll({ threadId: "thread-1" }));
    const state = await Effect.runPromise(manager.getState(input));

    expect(result.stoppedCount).toBe(1);
    expect(result.urls).toContain("http://127.0.0.1:39999");
    expect(state.status).toBe("stopped");
  });

  it("emits debounced source-change events for running previews", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-preview-watch-"));
    try {
      await fs.writeFile(path.join(tmpDir, "index.html"), "<main>Hello</main>");
      const manager = new PreviewRuntimeManager(terminalManager);
      const sourceChanged = new Promise<unknown>((resolve) => {
        let unsubscribe = () => {};
        unsubscribe = manager.subscribe((event) => {
          if (event.type === "source-changed") {
            unsubscribe();
            resolve(event);
          }
        });
      });

      await Effect.runPromise(
        manager.start({
          threadId: "thread-1",
          cwd: tmpDir,
          url: "http://127.0.0.1:39997",
        }),
      );
      await fs.writeFile(path.join(tmpDir, "index.html"), "<main>Updated</main>");

      const timedSourceChanged = Promise.race([
        sourceChanged,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for source change event")), 3_000);
        }),
      ]);

      await expect(timedSourceChanged).resolves.toMatchObject({
        type: "source-changed",
        changedCount: expect.any(Number),
        state: {
          cwd: tmpDir,
          status: "running",
        },
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
