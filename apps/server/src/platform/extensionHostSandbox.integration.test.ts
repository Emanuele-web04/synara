import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSandboxedExtensionHost } from "./extensionHostSandbox";

/** Opt-in Linux acceptance uses the actual production launcher, not mocked argv. */
describe.skipIf(process.env.SYNARA_TEST_EXTENSION_SANDBOX !== "1")("real extension sandbox", () => {
  it("keeps workspace/package files read-only, hides control-plane state and preserves the private protocol pipe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synara-sandbox-"));
    const workspace = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const packages = path.join(stateDir, "editor-extensions/packages");
    const storage = path.join(stateDir, "editor-extensions/storage/test");
    const runtimeDir = path.join(root, "runtime");
    for (const directory of [workspace, packages, storage, runtimeDir])
      await mkdir(directory, { recursive: true });
    await writeFile(path.join(workspace, "draft.txt"), "untouched draft");
    await writeFile(path.join(packages, "package.txt"), "untouched package");
    await writeFile(path.join(stateDir, "control-plane-secret.txt"), "must not be readable");
    const runtime = path.join(runtimeDir, "probe.mjs");
    await writeFile(
      runtime,
      `import { readFile, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
const probe = async (file) => { try { await writeFile(file, "forbidden"); return false; } catch { return true; } };
const result = {
  workspaceBlocked: await probe(${JSON.stringify(path.join(workspace, "draft.txt"))}),
  packagesBlocked: await probe(${JSON.stringify(path.join(packages, "package.txt"))}),
  controlPlaneHidden: await readFile(${JSON.stringify(path.join(stateDir, "control-plane-secret.txt"))}).then(() => false, () => true),
  ambientCredentialsAbsent: process.env.GITHUB_TOKEN === undefined && process.env.NODE_OPTIONS === undefined,
};
await writeFile(${JSON.stringify(path.join(storage, "owned.txt"))}, "allowed");
writeSync(3, JSON.stringify(result) + "\\n");
`,
    );
    let child: Awaited<ReturnType<typeof spawnSandboxedExtensionHost>> | undefined;
    try {
      child = await spawnSandboxedExtensionHost({
        workspace,
        stateDir,
        packages,
        storage,
        runtime,
        node: process.execPath,
      });
      let output = "",
        errors = "";
      child.stdio[3]?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", resolve);
      });
      expect(code, errors).toBe(0);
      expect(JSON.parse(output)).toEqual({
        workspaceBlocked: true,
        packagesBlocked: true,
        controlPlaneHidden: true,
        ambientCredentialsAbsent: true,
      });
      expect(await readFile(path.join(workspace, "draft.txt"), "utf8")).toBe("untouched draft");
      expect(await readFile(path.join(packages, "package.txt"), "utf8")).toBe("untouched package");
      expect(await readFile(path.join(storage, "owned.txt"), "utf8")).toBe("allowed");
      console.log("REAL_EXTENSION_SANDBOX", output.trim());
    } finally {
      // This probe cannot create descendants. The normal extension lifecycle
      // uses capture-before-disconnect process-tree teardown instead.
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
