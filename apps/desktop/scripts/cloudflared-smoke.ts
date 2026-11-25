import { app } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CLOUDFLARED_VERSION } from "@synara/shared/cloudflared";
import { spawnProcess, spawnProcessSync } from "@synara/shared/processRuntime";
import { teardownChildProcessTree } from "../../server/src/platform/supervisedProcessTeardown";

const directory = mkdtempSync(path.join(os.tmpdir(), "synara-connector-electron-"));
app.setPath("userData", path.join(directory, "profile"));
async function smoke() {
  try {
    assert.ok(app.getAppPath().endsWith("app.asar"), "Run the smoke from its isolated archive");
    const binary = path.join(
      path.dirname(app.getAppPath()),
      "cloudflared",
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    const version = spawnProcessSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(version.status, 0);
    assert.ok(version.stdout.includes(CLOUDFLARED_VERSION));
    // This local Access listener does not contact an edge until a client connects.
    // No client connects, no credentials are supplied and no tunnel is provisioned.
    const child = spawnProcess(
      binary,
      ["access", "tcp", "--hostname", "unused.invalid", "--url", "127.0.0.1:0"],
      { env: { PATH: process.env.PATH }, stdio: "ignore", ownProcessGroup: true },
    );
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    try {
      await delay(300);
      assert.equal(failed, false);
      assert.equal(child.exitCode, null, "The actual connector must stay alive before teardown");
      assert.ok(child.pid);
    } finally {
      await teardownChildProcessTree(child);
    }
    assert.throws(() => process.kill(child.pid!, 0));
    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        node: process.versions.node,
        cloudflared: CLOUDFLARED_VERSION,
        archive: true,
        executableStarted: true,
        teardownVerified: true,
        liveCloudflare: false,
      }),
    );
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    app.quit();
  }
}
void app.whenReady().then(smoke);
setTimeout(() => app.exit(2), 20_000).unref();
