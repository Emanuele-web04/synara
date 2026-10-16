import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBoundedNodeProcess } from "./boundedNodeProcess";

describe("bounded Node process temp workspace", () => {
  it("removes its private temp workspace after an aborted child closes", async () => {
    const home = await mkdtemp(join(tmpdir(), "synara-bounded-node-fixture-"));
    const markerPathFile = join(home, "child-temp-path");
    const controller = new AbortController();
    let processResult: Promise<string> | undefined;
    const script = `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      const marker = join(tmpdir(), "worker-owned-temp-file");
      await writeFile(marker, "fixture");
      await writeFile(join(process.env.HOME, "child-temp-path"), marker);
      setInterval(() => {}, 1000);
    `;

    try {
      processResult = runBoundedNodeProcess(script, Buffer.alloc(0), {
        home,
        signal: controller.signal,
        timeoutMs: 30_000,
        maxInputBytes: 64,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
      });

      let markerPath: string | undefined;
      const deadline = Date.now() + 10_000;
      while (!markerPath && Date.now() < deadline) {
        try {
          markerPath = await readFile(markerPathFile, "utf8");
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(markerPath).toBeDefined();
      expect(existsSync(markerPath!)).toBe(true);

      controller.abort();
      await expect(processResult).rejects.toMatchObject({ name: "AbortError" });
      expect(existsSync(markerPath!)).toBe(false);
      expect(existsSync(dirname(markerPath!))).toBe(false);
    } finally {
      controller.abort();
      await processResult?.catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });
});
