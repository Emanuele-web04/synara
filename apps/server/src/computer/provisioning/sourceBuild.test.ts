import { watch } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isProcessRunning } from "../../platform/processTreeController.ts";
import { ComputerBackendError } from "../ComputerBackend.ts";
import { buildPluginFromSource } from "./sourceBuild.ts";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in installer script; the real one is never run here. */
async function fakeScript(body: string): Promise<{ dir: string; scriptPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "synara-source-build-"));
  temps.push(dir);
  const scriptPath = join(dir, "install-and-load.sh");
  await writeFile(scriptPath, `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  return { dir, scriptPath };
}

function whenFileAppears(dir: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dir, (_event, filename) => {
      if (filename === name) {
        watcher.close();
        resolve();
      }
    });
  });
}

describe("buildPluginFromSource", () => {
  it("passes --build-only and returns the last stdout line as the built path", async () => {
    const { scriptPath } = await fakeScript(
      '[[ "$1" == "--build-only" ]] || exit 9\necho "[synara-kwin-plugin] configuring"\necho "/tmp/build/kwin/plugins/SynaraComputerUsePlugin.so"',
    );
    await expect(buildPluginFromSource({ scriptPath })).resolves.toBe(
      "/tmp/build/kwin/plugins/SynaraComputerUsePlugin.so",
    );
  });

  it("refuses an empty answer instead of installing nothing", async () => {
    const { scriptPath } = await fakeScript("exit 0");
    await expect(buildPluginFromSource({ scriptPath })).rejects.toBeInstanceOf(
      ComputerBackendError,
    );
  });

  it("surfaces the toolchain's own words when the build fails", async () => {
    const { scriptPath } = await fakeScript(
      'echo "-- Configuring" \necho "CMake Error: Could not find KWin" >&2\nexit 1',
    );
    const error = await buildPluginFromSource({ scriptPath }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerBackendError);
    expect((error as Error).message).toContain("Could not find KWin");
  });

  it("rejects with the abort reason and leaves no build process behind", async () => {
    const { dir, scriptPath } = await fakeScript(
      'sleep 600 &\necho "$!" > "$(dirname "$0")/child.pid.tmp"\nmv "$(dirname "$0")/child.pid.tmp" "$(dirname "$0")/child.pid"\nwait',
    );
    const ready = whenFileAppears(dir, "child.pid");
    const controller = new AbortController();
    const reason = new Error("setup cancelled");
    const build = buildPluginFromSource({ scriptPath, signal: controller.signal });
    await ready;
    const sleepPid = Number(await readFile(join(dir, "child.pid"), "utf8"));
    expect(await isProcessRunning(sleepPid)).toBe(true);
    controller.abort(reason);
    await expect(build).rejects.toBe(reason);
    // The script's own child, not just the script: a cancel that leaves a
    // compiler running is the failure this module exists to prevent.
    expect(await isProcessRunning(sleepPid)).toBe(false);
  });
});
