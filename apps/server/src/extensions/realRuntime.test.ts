import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtensionRuntime } from "./extensionRuntime";
import { applyHostEditFixture } from "./hostEditFixture";

const runtimeFile = process.env.SYNARA_TEST_CODE_OSS_HOST;
const enabled = Boolean(runtimeFile) && process.env.SYNARA_TEST_EXTENSION_SANDBOX === "1";
const hostState = z.object({
  providers: z.array(z.object({ kind: z.string(), handle: z.number() })),
  active: z.array(z.string()),
});
const editsSchema = z.array(
  z.object({
    text: z.string(),
    range: z.object({
      startLineNumber: z.number(),
      startColumn: z.number(),
      endLineNumber: z.number(),
      endColumn: z.number(),
    }),
  }),
);

describe.skipIf(!enabled)("production extension runtime", () => {
  it("installs, approves, sandboxes, formats and stops the actual Prettier extension without changing workspace files", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "synara-extension-runtime-"));
    const cwd = path.join(temporary, "workspace"),
      stateDir = path.join(temporary, "state");
    await mkdir(cwd);
    await mkdir(stateDir);
    const contents = "const fixture={answer:42}";
    await writeFile(path.join(cwd, "fixture.js"), contents);
    const runtime = new ExtensionRuntime(stateDir, runtimeFile);
    const owner = "runtime-fixture-owner";
    try {
      expect((await runtime.request(owner, { operation: "list" })).runtime).toBe("stopped");
      await expect(runtime.runtimeRequest(owner, { operation: "start", cwd })).rejects.toThrow(
        "not trusted",
      );
      const installed = await runtime.request(owner, {
        operation: "install",
        id: "esbenp.prettier-vscode",
        version: "12.4.0",
      });
      expect(installed.extensions).toHaveLength(1);
      expect(installed.extensions[0]).toMatchObject({ enabled: false, approved: false });
      await runtime.request(owner, { operation: "setTrust", cwd, trusted: true });
      await expect(runtime.runtimeRequest(owner, { operation: "start", cwd })).rejects.toThrow(
        "No approved",
      );
      await runtime.request(owner, {
        operation: "setEnabled",
        id: "esbenp.prettier-vscode",
        enabled: true,
        consent: installed.extensions.map((entry) => ({ id: entry.id, digest: entry.digest })),
      });
      const started = await runtime.runtimeRequest(owner, {
        operation: "start",
        cwd,
        documents: [{ relativePath: "fixture.js", contents, version: 1 }],
      });
      const hostId = started.hostId;
      await expect(
        runtime.runtimeRequest("another-owner", { operation: "poll", cwd, hostId }),
      ).rejects.toThrow("not owned");
      await expect
        .poll(
          async () => {
            const result = await runtime.runtimeRequest(owner, { operation: "poll", cwd, hostId });
            if (result.status === "failed") throw new Error(JSON.stringify(result.events));
            return result.status;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("running");
      await runtime.runtimeRequest(owner, {
        operation: "request",
        cwd,
        hostId,
        method: "activate",
        paramsJson: JSON.stringify({ id: "esbenp.prettier-vscode" }),
      });
      const result = await runtime.runtimeRequest(owner, {
        operation: "request",
        cwd,
        hostId,
        method: "state",
      });
      const state = hostState.parse(JSON.parse(result.resultJson!));
      expect(state.active).toContain("esbenp.prettier-vscode");
      const formatter = state.providers.find((provider) => provider.kind === "format");
      expect(formatter).toBeDefined();
      const formatted = await runtime.runtimeRequest(owner, {
        operation: "request",
        cwd,
        hostId,
        method: "language",
        paramsJson: JSON.stringify({ handle: formatter!.handle, relativePath: "fixture.js" }),
      });
      expect(
        applyHostEditFixture(contents, editsSchema.parse(JSON.parse(formatted.resultJson!))),
      ).toBe("const fixture = { answer: 42 };\n");
      expect(await readFile(path.join(cwd, "fixture.js"), "utf8")).toBe(contents);
      await runtime.request(owner, { operation: "setTrust", cwd, trusted: false });
      expect(await runtime.runtimeRequest(owner, { operation: "stop", cwd, hostId })).toMatchObject(
        { status: "stopped" },
      );
      console.log(
        "REAL_SANDBOXED_PRETTIER",
        JSON.stringify({
          extension: installed.extensions[0]!.id,
          digest: installed.extensions[0]!.digest,
          nativeRuntime: true,
          guardedTrust: true,
          ownerIsolation: true,
          unchangedDisk: true,
          trustRevocationCleanup: true,
        }),
      );
    } finally {
      await runtime.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
