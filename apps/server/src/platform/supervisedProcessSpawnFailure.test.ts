import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnProcess } from "@synara/shared/processRuntime";
import { describe, expect, it, vi } from "vitest";

import { teardownChildProcessTree } from "./supervisedProcessTeardown";

describe("failed-spawn teardown", () => {
  it("settles a proven missing-cwd spawn failure without killing any PID", async () => {
    const child = spawnProcess(process.execPath, ["-e", ""], {
      cwd: join(tmpdir(), `synara-missing-cwd-${crypto.randomUUID()}`),
    });
    const teardown = vi.fn(async () => ({ escalated: false, signalErrors: [] }));
    // Teardown is deliberately requested from the first ordinary error handler,
    // matching the SDK race that originally quarantined the thread.
    const result = await new Promise((resolve, reject) => {
      child.once("error", () => {
        void teardownChildProcessTree(child, teardown).then(resolve, reject);
      });
    });
    expect(result).toEqual({ escalated: false, signalErrors: [] });
    expect(teardown).not.toHaveBeenCalled();
  });

  it("continues to fail closed for an unknown handle with no PID", async () => {
    await expect(
      teardownChildProcessTree({
        pid: undefined,
        exitCode: null,
        signalCode: null,
        once: vi.fn(),
        removeListener: vi.fn(),
      }),
    ).rejects.toThrow("Cannot prove process exit");
  });
});
