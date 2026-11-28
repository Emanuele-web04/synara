import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [mode] = process.argv.slice(2);
assert.ok(process.platform === "darwin", "Requires macOS");
assert.ok(
  process.argv.length <= 3 &&
    (mode === undefined || ["--phone", "--simulate-focus"].includes(mode)),
  "Expected --phone, --simulate-focus or no arguments",
);
const phone = mode === "--phone";
const project = fileURLToPath(new URL("../", import.meta.url));
const override = process.env.SYNARA_HYBRID_ELECTRON_DIST ?? process.env.ELECTRON_OVERRIDE_DIST_PATH;
const bundle = override
  ? join(resolve(override), "Electron.app")
  : resolve(dirname(createRequire(import.meta.url)("electron")), "../..");
const home = await mkdtemp(join(tmpdir(), "synara-phone-smoke-"));
const worker = join(home, "browser-hybrid-passkey.mjs");
try {
  // The worker uses the same external browser/network dependencies as the app.
  await symlink(join(project, "node_modules"), join(home, "node_modules"), "dir");
  execFileSync(
    "bun",
    [
      "build",
      "scripts/browser-hybrid-passkey-smoke.ts",
      "--target=node",
      "--external=electron",
      "--external=betterwright",
      `--outfile=${worker}`,
    ],
    { cwd: project, stdio: "inherit" },
  );
  if (!phone) {
    execFileSync(
      "swiftc",
      [
        join(project, "scripts/browser-hybrid-passkey-smoke-decode.swift"),
        "-o",
        join(home, "decode"),
      ],
      { stdio: "inherit" },
    );
  }
  const runtime = spawn(
    join(bundle, "Contents/MacOS/Electron"),
    [
      worker,
      `--user-data-dir=${join(home, "profile")}`,
      `--smoke-home=${home}`,
      ...(mode ? [mode] : []),
    ],
    { stdio: "ignore" },
  );
  const closed = once(runtime, "close");
  let result;
  try {
    const deadline = Date.now() + (phone ? 510_000 : 100_000);
    do {
      result = await readFile(join(home, "result"), "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (result) break;
      assert.ok(
        runtime.exitCode === null && runtime.signalCode === null,
        "Runtime exited before reporting a result",
      );
      await Promise.race([closed, delay(200)]);
    } while (Date.now() < deadline);
    assert.ok(result, "Runtime timed out");
  } finally {
    // A native Bluetooth teardown can block even after Electron has released the
    // views and reported its result. Only this launcher's own child is signalled.
    await Promise.race([closed, delay(3000)]);
    if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill("SIGKILL");
    await closed;
  }
  if (!result.startsWith("PASS ")) throw new Error(result);
  console.log(result);
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
}
