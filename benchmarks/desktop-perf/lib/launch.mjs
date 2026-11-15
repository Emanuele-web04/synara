// Launches a source desktop build against an isolated data home and Electron profile.
// Never points at ~/.synara or ~/.synara-beta: the home must live under the bench root.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { CdpSession, listTargets, sleep, waitFor } from "./cdp.mjs";

export const BENCH_ROOT = resolve(
  process.env.SYNARA_PERF_BENCH_ROOT ?? join(homedir(), "synara-perf-bench"),
);

/** Refuses any data home that is not inside the bench root. */
export function assertIsolatedHome(home) {
  const resolved = resolve(home);
  const forbidden = [
    ".synara",
    ".synara-beta",
    ".synara-dev",
    ".synara-canary",
    ".synara-remote",
    ".synara-cua",
  ].map((name) => join(homedir(), name));
  if (
    !resolved.startsWith(BENCH_ROOT + sep) ||
    forbidden.some((path) => resolved === path || resolved.startsWith(path + sep))
  ) {
    throw new Error(`Refusing to use a data home outside ${BENCH_ROOT}: ${resolved}`);
  }
  return resolved;
}

export function resolveElectronBinary(buildDir) {
  const require = createRequire(join(buildDir, "apps/desktop/package.json"));
  const binary = require("electron");
  if (typeof binary !== "string" || !existsSync(binary)) {
    throw new Error(`Electron binary not found for build ${buildDir}`);
  }
  return binary;
}

function sourceBuildMarker(buildDir) {
  const source = readFileSync(join(buildDir, "packages/shared/src/desktopIdentity.ts"), "utf8");
  const match = source.match(/SYNARA_SOURCE_DESKTOP_BUILD_MARKER\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("Could not read the source desktop build marker from the build");
  return match[1];
}

export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * A clean environment: nothing from the launching shell that names another Synara
 * instance, a provider config directory, or an agent session may leak into the app.
 */
export function isolatedEnvironment({ buildDir, home, profile }) {
  const keep = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TERM",
    "__CF_USER_TEXT_ENCODING",
    "SSH_AUTH_SOCK",
  ];
  const environment = {};
  for (const name of keep)
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return {
    ...environment,
    SYNARA_HOME: home,
    SYNARA_DESKTOP_FLAVOR: "dev",
    SYNARA_DESKTOP_SMOKE_USER_DATA: profile,
    SYNARA_SOURCE_DESKTOP_BUILD_MARKER: sourceBuildMarker(buildDir),
    SYNARA_DISABLE_AUTO_UPDATE: "1",
  };
}

function readRuntimeState(home) {
  try {
    return JSON.parse(readFileSync(join(home, "userdata/server-runtime.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Every process descended from `rootPid`, from one `ps` snapshot. */
export function processTree(rootPid) {
  const output = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,cputime=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  const rows = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      cpuSeconds: parseCpuTime(match[4]),
      command: match[5],
    });
  }
  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const tree = [];
  const queue = rows.filter((row) => row.pid === rootPid);
  while (queue.length) {
    const row = queue.shift();
    tree.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return tree;
}

function parseCpuTime(text) {
  // [[dd-]hh:]mm:ss.cc
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Number(days) * 86_400 + seconds;
}

export function classifyProcess(row, { rootPid, backendPid }) {
  const command = row.command;
  if (row.pid === rootPid) return "main";
  if (row.pid === backendPid) return "backend";
  const type = command.match(/--type=([\w-]+)/)?.[1];
  if (type === "renderer") return "renderer";
  if (type === "gpu-process") return "gpu";
  if (type === "utility")
    return `utility:${
      command
        .match(/--utility-sub-type=([\w.]+)/)?.[1]
        ?.split(".")
        .at(-1) ?? "other"
    }`;
  if (type) return type;
  if (/appsnap-helper/.test(command)) return "appsnap-helper";
  if (/\bclaude\b|claude-code|claude\.app/.test(command)) return "provider:claude";
  if (/\bcodex\b/.test(command)) return "provider:codex";
  if (/opencode/.test(command)) return "provider:opencode";
  return "other";
}

/**
 * Starts the desktop build and returns as soon as the process is spawned.
 * `spawnedAtEpochMs` is the start of every startup timing.
 */
export function launchDesktop({ buildDir, home, profile, debugPort, extraEnv = {} }) {
  assertIsolatedHome(home);
  assertIsolatedHome(profile);
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  const desktopDir = join(buildDir, "apps/desktop");
  const electron = resolveElectronBinary(buildDir);
  const env = {
    ...isolatedEnvironment({ buildDir, home: realpathSync(home), profile: realpathSync(profile) }),
    ...extraEnv,
  };
  const spawnedAtEpochMs = performance.timeOrigin + performance.now();
  const child = spawn(electron, [`--remote-debugging-port=${debugPort}`, "dist-electron/main.js"], {
    cwd: desktopDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output = (output + chunk).slice(-200_000)));
  child.stderr.on("data", (chunk) => (output = (output + chunk).slice(-200_000)));
  let exited = null;
  child.on("exit", (code, signal) => (exited = { code, signal }));
  return {
    child,
    pid: child.pid,
    home,
    profile,
    debugPort,
    spawnedAtEpochMs,
    output: () => output,
    exited: () => exited,
    backendState: () => readRuntimeState(home),
  };
}

/** Attaches to the main window's page target (the app shell, not a guest webview). */
export async function attachMainPage(app, { timeoutMs = 60_000 } = {}) {
  const target = await waitFor(
    async () => {
      if (app.exited())
        throw new Error(
          `App exited during startup: ${JSON.stringify(app.exited())}\n${app.output().slice(-2000)}`,
        );
      const targets = await listTargets(app.debugPort);
      return targets.find(
        (entry) =>
          entry.type === "page" &&
          !entry.url.startsWith("devtools://") &&
          entry.url !== "about:blank",
      );
    },
    { timeoutMs, intervalMs: 10, label: "main window target" },
  );
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  return { session, target };
}

/** Normal quit (SIGTERM is the app's own quit path), then waits for the whole tree to leave. */
export async function quitDesktop(app, { timeoutMs = 30_000 } = {}) {
  const before = processTree(app.pid).map((row) => row.pid);
  if (!app.exited()) app.child.kill("SIGTERM");
  const startedAt = Date.now();
  let survivors = before;
  while (Date.now() - startedAt < timeoutMs) {
    survivors = before.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (survivors.length === 0 && app.exited())
      return { quitMs: Date.now() - startedAt, survivors: [], forced: false };
    await sleep(100);
  }
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return { quitMs: Date.now() - startedAt, survivors, forced: true };
}

/**
 * Whether the app under test is the frontmost application. Someone using the Mac
 * during a run puts another window in front, which throttles rendering and changes
 * CPU, GPU and frame readings; such a sample is recorded as failed, never kept.
 */
export function isFrontmost(app) {
  const front = spawnSync("lsappinfo", ["front"], { encoding: "utf8" }).stdout.trim();
  if (!front) return null;
  const info = spawnSync("lsappinfo", ["info", "-only", "pid", front], { encoding: "utf8" }).stdout;
  const pid = Number(info.match(/pid\s*=\s*"?(\d+)/)?.[1]);
  return Number.isFinite(pid) && pid > 0 ? pid === app.pid : null;
}

/** Seconds since the last keyboard or mouse input from the person at the Mac. */
export function secondsSinceUserInput() {
  const output =
    spawnSync("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8" }).stdout ?? "";
  const match = output.match(/"HIDIdleTime" = (\d+)/);
  return match ? Number(match[1]) / 1e9 : null;
}

/**
 * Waits until nobody has touched the Mac for `quietSeconds`, so a sample does not start
 * under someone's hands. Gives up after `maxWaitSeconds` and lets the sample's own
 * frontmost check decide whether it is valid.
 */
export async function waitForQuietMac({
  quietSeconds = 45,
  maxWaitSeconds = 1800,
  log = () => {},
} = {}) {
  const startedAt = Date.now();
  let announced = false;
  while ((Date.now() - startedAt) / 1000 < maxWaitSeconds) {
    const idle = secondsSinceUserInput();
    if (idle === null || idle >= quietSeconds)
      return { waitedSeconds: Math.round((Date.now() - startedAt) / 1000), quiet: true };
    if (!announced) {
      log(`waiting for the Mac to be untouched for ${quietSeconds} s before the next sample`);
      announced = true;
    }
    await sleep(5000);
  }
  return { waitedSeconds: maxWaitSeconds, quiet: false };
}

/** Whether the macOS session is locked (login window in front, nothing of the app visible). */
export function screenLocked() {
  const output =
    spawnSync("ioreg", ["-n", "Root", "-d", "1", "-a"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).stdout ?? "";
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(output);
}

/**
 * A sample needs the app window in front and on screen. With `--allow-locked-screen`
 * (BENCH_ALLOW_LOCKED_SCREEN=1) a locked screen is accepted and stamped on the sample:
 * process-level readings (backend CPU, wake-ups, memory, process counts, log timings)
 * stay meaningful, anything that depends on drawing frames does not.
 */
export function frontmostProblem(app, when) {
  if (isFrontmost(app) !== false) return null;
  if (screenLocked()) {
    return process.env.BENCH_ALLOW_LOCKED_SCREEN === "1"
      ? null
      : `invalid sample: the screen was locked ${when}`;
  }
  return `invalid sample: the app window was not frontmost ${when} (another app was in use)`;
}
