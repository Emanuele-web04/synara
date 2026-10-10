import { spawn } from "node:child_process";
import { errorMonitor } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { didProcessFailToSpawn, trackProcessSpawn } from "./processSpawnOutcome";

describe("process spawn outcome", () => {
  it("records a missing cwd before ordinary error handlers run", async () => {
    const child = trackProcessSpawn(
      spawn(process.execPath, ["-e", ""], {
        cwd: join(tmpdir(), `synara-missing-cwd-${crypto.randomUUID()}`),
      }),
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        try {
          expect(error.code).toBe("ENOENT");
          expect(child.pid).toBeUndefined();
          expect(didProcessFailToSpawn(child)).toBe(true);
          expect(child.listenerCount("spawn")).toBe(0);
          resolve();
        } catch (cause) {
          reject(cause);
        }
      });
    });
  });

  it("records a missing executable without swallowing the original error", async () => {
    const child = trackProcessSpawn(
      spawn(join(tmpdir(), `synara-missing-executable-${crypto.randomUUID()}`), []),
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        try {
          expect(error.code).toBe("ENOENT");
          expect(didProcessFailToSpawn(child)).toBe(true);
          resolve();
        } catch (cause) {
          reject(cause);
        }
      });
    });
  });

  it("does not classify a successful spawn or its later errors as a failed spawn", async () => {
    const child = trackProcessSpawn(spawn(process.execPath, ["-e", ""]));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    expect(didProcessFailToSpawn(child)).toBe(false);
    expect(child.listenerCount(errorMonitor)).toBe(0);
    expect(child.listenerCount("spawn")).toBe(0);
    child.on("error", () => undefined);
    child.emit("error", new Error("a later transport error"));
    expect(didProcessFailToSpawn(child)).toBe(false);
  });

  it("does not trust an arbitrary PID-less handle", () => {
    expect(didProcessFailToSpawn({ pid: undefined })).toBe(false);
  });
});
