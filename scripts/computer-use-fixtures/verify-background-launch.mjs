// macOS live fixture: cold launch, reuse, hidden recovery and URL handoff.
// It never activates an app or writes to user windows. Temporary apps must live
// outside the system temp directory: LaunchServices excludes those from bundle
// lookup. The unique ignored build directory and its registration are removed.
// Usage: node scripts/computer-use-fixtures/verify-background-launch.mjs /absolute/cua-driver
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const driverPath = process.argv[2];
if (process.platform !== "darwin" || !driverPath || !isAbsolute(driverPath)) {
  throw new Error("Supply an absolute patched driver path on macOS.");
}
const source = dirname(fileURLToPath(import.meta.url));
const build = join(source, "..", "..", "build");
await mkdir(build, { recursive: true });
const directory = await mkdtemp(join(build, "cua-launch-proof-"));
const appPath = join(directory, "Target.app");
const executable = join(directory, "fixture");
const focusProbe = join(directory, "focus-probe");
const bundleId = `app.synara.fixture.background-launch.${randomUUID()}`;
const socketPath = join(directory, "driver.sock");
const register =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const children = [];
const report = { cases: [], calls: [], focusSamples: 0, focusExcursions: 0 };
let driver,
  sampler,
  targetPid,
  registered = false;

function launch(path, args, options = {}) {
  const child = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"], ...options });
  children.push(child);
  child.lines = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      child.lines.push(JSON.parse(line));
    } catch {}
  });
  // Consume diagnostics without persisting user window titles or payloads.
  child.stderr.resume();
  return child;
}
function front() {
  return execFileSync(focusProbe, ["--once"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((row) => typeof row.t === "number");
}
function control(command) {
  return execFileSync(executable, [command, String(targetPid), appPath], { encoding: "utf8" });
}
async function state() {
  return JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
}
async function waitFor(get, timeout = 5000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = await get();
    if (value) return value;
    await delay(30);
  }
  throw new Error("Timed out waiting for the owned fixture.");
}
function request(value, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setTimeout(timeout, () => socket.destroy(new Error("Native request timed out.")));
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) return socket.destroy(new Error("Unexpected response size."));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
async function call(args = {}) {
  const start = performance.now();
  const response = await request({
    method: "call",
    name: "launch_app",
    args: { bundle_id: bundleId, hidden: false, ...args },
    expected_input_epoch: 0,
  });
  report.calls.push({ milliseconds: +(performance.now() - start).toFixed(2) });
  assert.equal(response.ok, true);
  assert.notEqual(response.result?.isError, true);
  const result = response.result.structuredContent;
  if (Number.isInteger(result.pid)) targetPid ??= result.pid;
  return result;
}
async function check(name, run) {
  await run();
  report.cases.push({ name, passed: true });
}
function assertBackground() {
  const current = front();
  assert.notEqual(current.pid, targetPid, "The target must not take focus.");
  assert.notEqual(current.pid, driver.pid, "The driver must not take focus.");
}

try {
  execFileSync("xcrun", [
    "clang",
    "-fobjc-arc",
    "-framework",
    "AppKit",
    join(source, "BackgroundLaunchFixture.m"),
    "-o",
    executable,
  ]);
  execFileSync("xcrun", [
    "clang",
    "-fobjc-arc",
    "-O2",
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "CoreGraphics",
    join(source, "focus_probe.m"),
    "-o",
    focusProbe,
  ]);
  const initial = front();
  assert.ok(
    initial?.pid > 0 && initial.app !== "loginwindow",
    "An unlocked user desktop is required.",
  );
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await copyFile(executable, join(appPath, "Contents", "MacOS", "fixture"));
  await writeFile(
    join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Synara Background Launch Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>`,
  );
  execFileSync(register, ["-f", appPath]);
  registered = true;
  sampler = launch(focusProbe, [
    "--stdin",
    "--duration",
    "45",
    "--hz",
    "50",
    "--top-win-every",
    "1",
  ]);
  driver = launch(driverPath, ["serve", "--embedded", "--no-overlay", "--socket", socketPath], {
    env: {
      ...process.env,
      CUA_DRIVER_EMBEDDED: "1",
      CUA_DRIVER_PERMISSION_MODE: "standard",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
      CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid),
      CUA_DRIVER_RS_HOME: join(directory, "driver-state"),
    },
  });
  await waitFor(async () => {
    try {
      return await request({ method: "metadata" }, 150);
    } catch {
      return null;
    }
  });
  let cold;
  await check("cold background launch", async () => {
    cold = await call();
    assert.equal(cold.hidden, false);
    assert.equal(cold.window_status, "ready");
    assert.equal(cold.launch_state.window_ready, true);
    assert.equal(cold.windows.length, 1);
    await delay(200);
    assertBackground();
  });
  const windowIds = (result) => result.windows.map((window) => window.window_id);
  await check("reuse without reopening", async () => {
    const repeated = await call();
    assert.equal(repeated.pid, cold.pid);
    assert.deepEqual(windowIds(repeated), windowIds(cold));
    assert.equal((await state()).reopenCount, 0);
    assertBackground();
  });
  await check("hidden recovery without activation", async () => {
    control("--hide");
    await waitFor(() => JSON.parse(control("--state")).hidden);
    const unhidden = await call();
    assert.equal(unhidden.pid, cold.pid);
    assert.equal(unhidden.hidden, false);
    assert.equal(unhidden.window_status, "ready");
    assert.deepEqual(windowIds(unhidden), windowIds(cold));
    assert.equal((await state()).reopenCount, 0);
    assertBackground();
  });
  await check("background URL handoff", async () => {
    const payload = join(directory, "payload.txt");
    await writeFile(payload, "Owned background launch verification.\n");
    assert.equal((await call({ urls: [payload] })).pid, cold.pid);
    assertBackground();
  });
  await delay(8500);
  await check("no immediate or delayed focus takeover", async () => {
    const rows = sampler.lines.filter((row) => typeof row.t === "number");
    report.focusSamples = rows.length;
    report.focusExcursions = rows.filter(
      (row) =>
        row.pid === targetPid ||
        row.pid === driver.pid ||
        row.focusedPid === targetPid ||
        row.focusedPid === driver.pid,
    ).length;
    assert.ok(report.focusSamples > 200);
    assert.equal(report.focusExcursions, 0);
  });
} catch (error) {
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  if (sampler) sampler.stdin.end();
  if (driver?.pid) {
    try {
      await request({ method: "shutdown_if_pid", args: { expected_pid: driver.pid } }, 1000);
    } catch {}
    driver.stdin.end();
  }
  if (targetPid) {
    try {
      control("--terminate");
    } catch {}
  }
  if (registered) {
    // A timed-out OS launch can still have started a process without returning
    // its PID. Cleanup is bound to both our unique identity and exact bundle.
    try {
      execFileSync(executable, ["--terminate-bundle", bundleId, appPath]);
    } catch {}
    try {
      execFileSync(register, ["-u", appPath]);
    } catch {}
  }
  await delay(300);
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
