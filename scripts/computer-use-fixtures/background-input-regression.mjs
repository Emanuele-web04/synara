// Live regression runner: real native transport, owned two-window Chromium
// target, independent DOM and passive focus evidence. An owned AppKit sentinel
// is optional; normal runs leave the user's foreground application alone.
// Does not unlock macOS or send input to any non-fixture window.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { mkdir, writeFile, readFile, mkdtemp, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const [driverPath, electronPath, outputDirectory, ...options] = process.argv.slice(2);
const ownedSentinel = options.includes("--owned-sentinel");
if (
  !driverPath ||
  !electronPath ||
  !outputDirectory ||
  options.some((option) => !["--enter-only", "--owned-sentinel"].includes(option))
) {
  throw new Error(
    "Usage: node background-input-regression.mjs <driver> <Electron executable> <output directory> [--enter-only] [--owned-sentinel]",
  );
}
await mkdir(resolve(outputDirectory), { recursive: true });
const directory = await mkdtemp(join(resolve(outputDirectory), "background-input-"));
const targetDirectory = join(directory, "target");
const sentinelPath =
  process.env.SYNARA_CUA_FIXTURE_NATIVE_TARGET || join(directory, "native-sentinel");
const focusProbe = process.env.SYNARA_CUA_FOCUS_PROBE || join(directory, "focus-probe");
const reportPath = join(directory, "report.json");
if (!process.env.SYNARA_CUA_FOCUS_PROBE)
  execFileSync("/usr/bin/clang", [
    "-fobjc-arc",
    "-O2",
    "-o",
    focusProbe,
    join(sourceDirectory, "focus_probe.m"),
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    "-framework",
    "CoreGraphics",
  ]);
const initialRows = execFileSync(focusProbe, ["--once"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const focusIdentity = (row) =>
  row && {
    t: row.t,
    pid: row.pid,
    app: row.app,
    keyWin: row.keyWin,
    focusedPid: row.focusedPid,
  };
const initial = focusIdentity(initialRows.find((row) => typeof row.t === "number"));
const report = {
  startedAt: new Date().toISOString(),
  initial,
  cases: [],
  calls: [],
  samples: [],
  targetPid: null,
  sentinelPid: null,
  focusVerification: ownedSentinel ? "exact-sentinel" : "no-owned-process-activation",
  setupMode: ownedSentinel ? "controlled-owned-activation" : "inactive",
};
if (!initial || initial.app === "loginwindow" || initial.pid <= 0) {
  report.blocked =
    "Desktop locked or no current user desktop. No fixture input or activation attempted.";
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ blocked: report.blocked, initial }));
  process.exit(2);
}
if (ownedSentinel && !process.env.SYNARA_CUA_FIXTURE_NATIVE_TARGET)
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-module-cache-path",
    join(resolve(outputDirectory), "swift-module-cache"),
    join(sourceDirectory, "NativeFixture.swift"),
    "-o",
    sentinelPath,
  ]);
await mkdir(targetDirectory);
await copyFile(
  join(sourceDirectory, "background-input-target.cjs"),
  join(targetDirectory, "main.cjs"),
);
await writeFile(
  join(targetDirectory, "package.json"),
  JSON.stringify({ name: "synara-background-input-fixture", main: "main.cjs" }),
);
const children = [];
let driver, target, sentinel, sampler;
let interrupted = false;
let ownedTarget;
let primaryLabel = "A";
let siblingLabel = "B";
const ownedWindows = new Set();
const socketPath = join(directory, "driver.sock");
function focusViolation(sample) {
  if (!sample || sample.app === "loginwindow") return true;
  if (ownedSentinel)
    return (
      sample.pid !== report.baseline.pid ||
      sample.keyWin !== report.baseline.keyWin ||
      (sample.focusedPid && sample.focusedPid !== report.baseline.pid)
    );
  return [target?.pid, driver?.pid]
    .filter(Boolean)
    .some((pid) => sample.pid === pid || sample.focusedPid === pid);
}
function launch(path, args, options = {}) {
  const child = spawn(resolve(path), args, { stdio: ["pipe", "pipe", "pipe"], ...options });
  children.push(child);
  child.lines = [];
  child.diagnostics = "";
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      child.lines.push(JSON.parse(line));
    } catch {}
  });
  child.stderr.on("data", (bytes) => {
    child.diagnostics = (child.diagnostics + bytes).slice(-16384);
  });
  child.on("error", (error) => {
    child.launchError = String(error);
  });
  return child;
}
async function waitFor(get, timeout = 8000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const value = get();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for owned fixture state.");
}
let commandId = 0;
async function targetCommand(command) {
  const id = ++commandId;
  target.stdin.write(JSON.stringify({ id, command }) + "\n");
  const response = await waitFor(() => target.lines.find((row) => row.id === id));
  return response.states
    ? {
        ...response,
        states: { A: response.states[primaryLabel], B: response.states[siblingLabel] },
      }
    : response;
}
function request(value, timeout = 10000) {
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.setTimeout(timeout, () => socket.destroy(new Error("Native request timeout")));
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 4000000)
        return socket.destroy(new Error("Unexpected large native response"));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.end();
      try {
        resolveRequest(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
async function call(name, args) {
  const start = performance.now();
  if (["set_value", "press_key", "scroll"].includes(name)) {
    assert.equal(
      args.pid,
      ownedTarget,
      "Input must name the independently identified fixture PID.",
    );
    assert.ok(
      ownedWindows.has(args.window_id),
      "Input must name an independently identified fixture window.",
    );
    const latest = sampler?.lines.findLast((row) => typeof row.t === "number");
    if (focusViolation(latest)) interrupted = true;
    if (interrupted)
      throw new Error("Fixture interrupted by a focus change; no further input dispatched.");
  }
  const response = await request({ method: "call", name, args, expected_input_epoch: 0 });
  report.calls.push({
    name,
    milliseconds: +(performance.now() - start).toFixed(2),
    args,
    response,
  });
  return response;
}
async function runCase(name, run) {
  const start = performance.now();
  try {
    await run();
    report.cases.push({
      name,
      passed: true,
      milliseconds: +(performance.now() - start).toFixed(2),
    });
  } catch (error) {
    report.cases.push({
      name,
      passed: false,
      error: String(error),
      milliseconds: +(performance.now() - start).toFixed(2),
    });
  }
}
function structured(response) {
  return response?.result?.structuredContent ?? {};
}
function exactField(snapshot, label = primaryLabel) {
  const matches =
    snapshot.elements?.filter(
      (element) => element.role === "AXTextField" && element.label === `Fixture query ${label}`,
    ) ?? [];
  assert.equal(matches.length, 1, "One exact owned input must be discoverable.");
  const field = matches[0];
  return {
    element_index: field.element_index,
    ...(field.element_token ? { element_token: field.element_token } : {}),
    ...(snapshot.snapshot_id ? { snapshot_id: snapshot.snapshot_id } : {}),
  };
}
try {
  report.driverSha256 = createHash("sha256")
    .update(await readFile(driverPath))
    .digest("hex");
  target = launch(electronPath, [targetDirectory], {
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      SYNARA_BACKGROUND_FIXTURE_DIRECTORY: directory,
    },
  });
  const ready = await waitFor(() => target.lines.find((row) => row.event === "ready"), 15000);
  report.targetPid = ready.pid;
  ownedTarget = ready.pid;
  assert.equal(target.pid, ready.pid);
  // Passive setup never calls BrowserWindow.focus or activates an application.
  // An explicitly requested sentinel replaces the passive user-focus baseline.
  if (ownedSentinel) {
    await targetCommand("controlled-focus-a");
    sentinel = launch(sentinelPath, []);
    await waitFor(() => sentinel.lines.find((row) => row.ready));
    report.sentinelPid = sentinel.pid;
    sentinel.stdin.write("focus-a\n");
    await delay(200);
  }
  const beforeRows = execFileSync(focusProbe, ["--once"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const baseline = focusIdentity(beforeRows.find((row) => typeof row.t === "number"));
  if (ownedSentinel) {
    assert.equal(baseline.pid, sentinel.pid, "The sentinel must be frontmost before measurement.");
    assert.ok(baseline.keyWin, "The sentinel must have an observable key window.");
  } else {
    assert.notEqual(baseline.pid, target.pid, "Fixture setup must not activate its target.");
    assert.notEqual(baseline.app, "loginwindow", "Desktop became unavailable during setup.");
  }
  report.baseline = baseline;
  sampler = launch(focusProbe, [
    "--stdin",
    "--duration",
    "90",
    "--hz",
    "50",
    "--top-win-every",
    "1",
    "--label",
    "background-regression",
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
  let metadata;
  for (let i = 0; i < 80 && !metadata; i++) {
    try {
      metadata = await request({ method: "metadata" }, 200);
    } catch {
      await delay(100);
    }
  }
  assert.equal(metadata?.result?.pid, driver.pid);
  report.metadata = metadata.result;
  report.permissions = structured(await call("check_permissions", { prompt: false }));
  const windowReply = structured(await call("list_windows", { pid: target.pid }));
  const windows = windowReply.windows?.filter((window) => window.pid === target.pid) ?? [];
  const snapshots = new Map();
  let selectedWindow;
  for (const label of ["A", "B"]) {
    const matches = windows.filter(
      (window) => window.title === `Synara Background Fixture ${target.pid} ${label}`,
    );
    assert.equal(matches.length, 1, "Target must match PID and unique fixture title.");
    const candidate = matches[0];
    const observed = structured(
      await call("get_window_state", {
        pid: target.pid,
        window_id: candidate.window_id ?? candidate.id,
        include_screenshot: false,
        max_elements: 250,
        query: "Fixture",
      }),
    );
    snapshots.set(label, observed);
    if (
      observed.background_input?.routes?.some(
        (route) => route.route === "focused_window_keyboard" && route.status === "available",
      )
    ) {
      primaryLabel = label;
      siblingLabel = label === "A" ? "B" : "A";
      selectedWindow = candidate;
      break;
    }
  }
  assert.ok(
    selectedWindow,
    "Fresh fixture must expose a naturally app-focused window; no activation is used to manufacture one.",
  );
  report.primaryWindowLabel = primaryLabel;
  const owned = [selectedWindow];
  const a = { pid: target.pid, window_id: owned[0].window_id ?? owned[0].id };
  assert.ok(Number.isInteger(a.window_id));
  report.windows = windows;
  for (const window of windows)
    if (window.title?.startsWith(`Synara Background Fixture ${target.pid} `))
      ownedWindows.add(window.window_id ?? window.id);
  const snapshot = async () =>
    structured(
      await call("get_window_state", {
        ...a,
        include_screenshot: false,
        max_elements: 250,
        query: "Fixture",
      }),
    );
  let state = snapshots.get(primaryLabel);
  const initialState = await targetCommand("state");
  report.initialFixture = initialState;
  await runCase("semantic-text-then-enter-exact-window", async () => {
    await call("set_value", { ...a, ...exactField(state), value: "background-enter-proof" });
    const afterText = await targetCommand("state");
    assert.equal(
      afterText.states.A.value,
      "background-enter-proof",
      "DOM readback must match the semantic write.",
    );
    assert.deepEqual(
      afterText.states.B,
      initialState.states.B,
      "Sibling window must stay untouched.",
    );
    state = await snapshot();
    const response = await call("press_key", {
      ...a,
      ...exactField(state),
      key: "return",
      delivery_mode: "background",
    });
    assert.notEqual(structured(response).effect, "refused", "Enter must actually dispatch.");
    await delay(100);
    const after = await targetCommand("state");
    report.afterEnter = after;
    assert.equal(after.states.A.enters, 1, "Target renderer must receive exactly one Enter.");
    assert.equal(after.states.A.submits, 1, "Target form must submit exactly once.");
    assert.deepEqual(
      after.states.B,
      initialState.states.B,
      "Sibling renderer must remain untouched.",
    );
  });
  await runCase("enter-to-nonkey-sibling-refused-before-dispatch", async () => {
    const sibling = windows.filter(
      (window) => window.title === `Synara Background Fixture ${target.pid} ${siblingLabel}`,
    );
    assert.equal(sibling.length, 1);
    const b = { pid: target.pid, window_id: sibling[0].window_id ?? sibling[0].id };
    const before = (await targetCommand("state")).states;
    const siblingSnapshot = structured(
      await call("get_window_state", {
        ...b,
        include_screenshot: false,
        max_elements: 250,
        query: "Fixture",
      }),
    );
    const response = await call("press_key", {
      ...b,
      ...exactField(siblingSnapshot, siblingLabel),
      key: "return",
      delivery_mode: "background",
    });
    assert.equal(structured(response).effect, "refused");
    assert.equal(structured(response).code, "same_pid_keyboard_ambiguity");
    await delay(100);
    const after = (await targetCommand("state")).states;
    report.afterSiblingRefusal = after;
    assert.deepEqual(after, before, "Refused key must change neither target nor sibling.");
  });
  function coordinates(fixtureState, rect) {
    const bounds = state.window_bounds ?? owned[0].bounds;
    assert.ok(bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y));
    return {
      coordinate_space: "window_points",
      expected_window_bounds: bounds,
      x: fixtureState.contentBounds.x - bounds.x + rect.x,
      y: fixtureState.contentBounds.y - bounds.y + rect.y,
    };
  }
  if (!options.includes("--enter-only")) {
    await runCase("nested-scroll-has-independent-positive-delta", async () => {
      const before = (await targetCommand("state")).states;
      const rect = before.A.nestedRect;
      await call("scroll", {
        ...a,
        ...coordinates(before.A, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }),
        direction: "down",
        delta_x: 0,
        delta_y: -3,
        delivery_mode: "background",
      });
      await delay(150);
      const after = (await targetCommand("state")).states;
      report.afterNestedScroll = after;
      assert.ok(after.A.nestedScroll > before.A.nestedScroll, "Nested scrollTop must increase.");
      assert.equal(
        after.A.documentScroll,
        before.A.documentScroll,
        "Nested scroll must not move the page.",
      );
      assert.deepEqual(after.B, before.B, "Sibling renderer must remain untouched.");
    });
    await runCase("document-scroll-has-independent-positive-delta", async () => {
      const before = (await targetCommand("state")).states;
      await call("scroll", {
        ...a,
        ...coordinates(before.A, { x: 460, y: 320 }),
        direction: "down",
        delta_x: 0,
        delta_y: -3,
        delivery_mode: "background",
      });
      await delay(150);
      const after = (await targetCommand("state")).states;
      report.afterDocumentScroll = after;
      assert.ok(
        after.A.documentScroll > before.A.documentScroll,
        "Document scrollY must increase.",
      );
      assert.deepEqual(after.B, before.B, "Sibling renderer must remain untouched.");
    });
  }
  await delay(200);
  sampler.stdin.end();
  await waitFor(() => sampler.exitCode !== null);
  report.samples = sampler.lines.filter((row) => typeof row.t === "number").map(focusIdentity);
  report.externalFocusChanges = [];
  let previousFocus = baseline;
  for (const sample of report.samples) {
    if (
      !focusViolation(sample) &&
      (sample.pid !== previousFocus.pid || sample.keyWin !== previousFocus.keyWin)
    )
      report.externalFocusChanges.push(sample);
    previousFocus = sample;
  }
  await runCase(
    ownedSentinel ? "user-focus-and-key-window-never-move" : "fixture-never-takes-user-focus",
    async () => {
      assert.ok(report.samples.length >= 5);
      const stolen = report.samples.filter(focusViolation);
      report.focusExcursions = stolen;
      assert.equal(
        stolen.length,
        0,
        "Every measured sample must preserve the chosen focus invariant.",
      );
    },
  );
} catch (error) {
  report.failure = String(error);
} finally {
  if (sampler && !sampler.killed) sampler.stdin.end();
  if (driver?.pid) {
    try {
      await request({ method: "shutdown_if_pid", args: { expected_pid: driver.pid } }, 1000);
    } catch {}
    driver.stdin.end();
  }
  if (target) {
    try {
      target.stdin.write(JSON.stringify({ command: "quit" }) + "\n");
      target.stdin.end();
    } catch {}
  }
  if (sentinel) {
    try {
      sentinel.stdin.write("quit\n");
      sentinel.stdin.end();
    } catch {}
  }
  await delay(300);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await delay(100);
  report.interrupted = interrupted;
  report.diagnostics = children.map((child) => ({
    pid: child.pid,
    text: child.diagnostics,
    launchError: child.launchError,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  }));
  await rm(join(directory, "target-profile"), { recursive: true, force: true });
  await rm(targetDirectory, { recursive: true, force: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        file: reportPath,
        cases: report.cases,
        failure: report.failure,
        samples: report.samples.length,
        calls: report.calls.map((call) => ({ name: call.name, milliseconds: call.milliseconds })),
      },
      null,
      2,
    ),
  );
  if (report.failure || report.cases.some((test) => !test.passed)) process.exitCode = 1;
}
