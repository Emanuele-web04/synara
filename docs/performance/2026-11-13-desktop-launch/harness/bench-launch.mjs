#!/usr/bin/env node
// Measures Synara desktop "launch to typing accepted" on this machine.
//
// Timed region: from just before the Electron process is spawned until a character
// inserted into the composer is present in the composer's DOM text.
// Counts errors and prints every sample. One launch at a time (caller holds the flock).
//
// Usage:
//   node bench-launch.mjs --app <worktree> --home <SYNARA_HOME> --runs 7 --mode warm|cold \
//        --label <name> --out <file.json> [--port 9400]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const appDir = resolve(args.get("--app"));
const home = resolve(args.get("--home"));
const runs = Number(args.get("--runs") ?? "5");
const mode = args.get("--mode") ?? "warm";
const label = args.get("--label") ?? "unnamed";
const outFile = args.get("--out");
const basePort = Number(args.get("--port") ?? "9400");
let port = basePort;
const timeoutMs = Number(args.get("--timeout-ms") ?? "60000");
const settleMs = Number(args.get("--settle-ms") ?? "1500");

const desktopDir = join(appDir, "apps/desktop");
const require = createRequire(join(desktopDir, "package.json"));
const electronPath = require("electron");
const { spawnSourceDesktop } = await import(join(desktopDir, "scripts/source-desktop-launch.mjs"));
const { SYNARA_DESKTOP_SMOKE_USER_DATA_ENV } = await import(
  join(appDir, "packages/shared/src/desktopIdentity.ts")
);

function gitHead() {
  try {
    return execFileSync("git", ["-C", appDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
function gitDirty() {
  try {
    return (
      execFileSync("git", ["-C", appDir, "status", "--porcelain"], { encoding: "utf8" }).trim()
        .length > 0
    );
  } catch {
    return null;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Evict clean page-cache pages of a file without root (posix_fadvise DONTNEED through dd).
function evictFile(path) {
  try {
    execFileSync("dd", [`of=${path}`, "oflag=nocache", "conv=notrunc,fdatasync", "count=0"], {
      stdio: "ignore",
    });
    return 1;
  } catch {
    return 0;
  }
}
function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}
function evictColdSet() {
  let files = 0;
  const visit = (file) => {
    files += evictFile(file);
  };
  walk(join(electronPath, ".."), visit);
  walk(join(desktopDir, "dist-electron"), visit);
  walk(join(appDir, "apps/server/dist"), visit);
  walk(join(appDir, "apps/web/dist"), visit);
  walk(home, visit);
  return files;
}

async function cdpTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(500),
  });
  const targets = await response.json();
  return (
    targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://")) ??
    null
  );
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
    this.closed = false;
    const failAll = (why) => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`cdp socket ${why}`));
      this.pending.clear();
    };
    this.socket.addEventListener("close", () => failAll("closed"));
    this.socket.addEventListener("error", () => failAll("error"));
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("cdp socket closed"));
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) =>
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend }),
    );
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

const PROBE = `(() => {
  const editor = document.querySelector('[data-testid="composer-editor"]');
  if (!editor) return { state: "no-editor" };
  if (editor.getAttribute("contenteditable") !== "true") return { state: "not-editable" };
  return {
    state: "editable",
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    focused: document.activeElement === editor,
    text: editor.textContent ?? "",
    path: location.pathname + location.hash,
  };
})()`;

async function portBusy(candidate) {
  try {
    await fetch(`http://127.0.0.1:${candidate}/json/version`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch {
    return false;
  }
}

async function oneRun(index) {
  const sample = { index, mode, ok: false, error: null };
  // A fresh debugging port per sample, so a stale app can never be mistaken for this launch.
  port = basePort + Math.floor(Math.random() * 400);
  while (await portBusy(port)) port += 1;
  sample.port = port;
  if (mode === "cold") {
    sample.evictedFiles = evictColdSet();
    await delay(500);
  }
  const environment = {
    ...process.env,
    SYNARA_HOME: home,
    SYNARA_DESKTOP_FLAVOR: "dev",
    [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: join(home, "electron-user-data"),
    SYNARA_DISABLE_AUTO_UPDATE: "1",
  };
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.SYNARA_AUTH_TOKEN;
  delete environment.ELECTRON_RUN_AS_NODE;

  const logFd = openSync(join(home, `bench-run-${label}-${index}.log`), "w");
  let t0 = performance.now();
  let wallStart = Date.now();
  const child = spawnSourceDesktop({
    desktopDirectory: desktopDir,
    electronPath,
    spawnProcess: (command, argv, options) => {
      // The timer starts here, after the launcher's own file checks.
      t0 = performance.now();
      wallStart = Date.now();
      return spawn(command, [...argv, `--remote-debugging-port=${port}`], {
        ...options,
        detached: true,
      });
    },
    stdio: ["ignore", logFd, logFd],
    environment,
  });
  closeSync(logFd);
  const pgid = child.pid;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  let cdp = null;
  try {
    const deadline = t0 + timeoutMs;
    let target = null;
    while (performance.now() < deadline && !exited) {
      try {
        target = await cdpTarget();
        if (target) break;
      } catch {}
      await delay(5);
    }
    if (!target)
      throw new Error(exited ? "app exited before a page target appeared" : "no page target");
    sample.pageTargetMs = performance.now() - t0;
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.opened;

    // The app only focuses the composer when its window has focus. Emulate a focused window so
    // the result does not depend on what else is in front on the desktop during the run.
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const probeChars = "ademarkqz";
    let sent = 0;
    while (performance.now() < deadline && !exited) {
      let probe;
      try {
        probe = await cdp.evaluate(PROBE);
      } catch (error) {
        if (cdp.closed)
          throw new Error(
            `renderer debugging socket closed before typing was accepted (${error.message})`,
          );
        await delay(5);
        continue;
      }
      if (probe.state === "editable") {
        if (sample.editorEditableMs === undefined) sample.editorEditableMs = performance.now() - t0;
        if (probe.dialogs > 0) sample.dialogSeen = true;
        if (probe.focused) {
          if (sample.editorFocusedMs === undefined) sample.editorFocusedMs = performance.now() - t0;
          // Same rule as ademark: ready when two probe characters are in the composer.
          if (sample.textBeforeFirstKey === undefined) sample.textBeforeFirstKey = probe.text;
          if (
            sent >= 2 &&
            sample.textBeforeFirstKey === "" &&
            probe.text.length >= 2 &&
            probeChars.includes(probe.text.slice(0, 2))
          ) {
            sample.typingAcceptedMs = performance.now() - t0;
            // Diagnostic: two animation frames after the text is in the DOM, so a frame holding it was produced.
            await cdp.send("Runtime.evaluate", {
              awaitPromise: true,
              expression:
                "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
            });
            sample.twoAnimationFramesAfterDomMs = performance.now() - t0;
            sample.path = probe.path;
            sample.keysSent = sent;
            sample.ok = true;
            break;
          }
          const ch = probeChars[sent % probeChars.length];
          const code = ch.toUpperCase().charCodeAt(0);
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: ch,
            code: "Key" + ch.toUpperCase(),
            text: ch,
            unmodifiedText: ch,
            windowsVirtualKeyCode: code,
          });
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: ch,
            code: "Key" + ch.toUpperCase(),
            windowsVirtualKeyCode: code,
          });
          sent += 1;
          if (sample.firstKeyMs === undefined) sample.firstKeyMs = performance.now() - t0;
        }
      }
      await delay(4);
    }
    if (!sample.ok) {
      throw new Error(
        exited
          ? "app exited before typing was accepted"
          : `timeout: editable=${sample.editorEditableMs !== undefined} focused=${sample.editorFocusedMs !== undefined} dialog=${sample.dialogSeen === true}`,
      );
    }

    // Diagnostics only, outside the timed region.
    await delay(settleMs);
    sample.renderer = await cdp.evaluate(`(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paint = Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, Math.round(e.startTime)]));
      const marks = performance.getEntriesByType("mark").map((e) => [e.name, Math.round(e.startTime)]);
      const resources = performance.getEntriesByType("resource");
      return {
        timeOriginEpochMs: performance.timeOrigin,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
        paint,
        marks,
        resourceCount: resources.length,
        scriptCount: resources.filter((r) => r.initiatorType === "script" || r.name.endsWith(".js")).length,
        threadRows: document.querySelectorAll('[data-thread-id], [data-testid^="thread-row"]').length,
        composerText: document.querySelector('[data-testid="composer-editor"]')?.textContent ?? null,
      };
    })()`);
    sample.rendererStartAfterLaunchMs = Math.round(sample.renderer.timeOriginEpochMs - wallStart);
    // Remove the typed characters so the next run starts from an empty draft.
    for (let i = 0; i < 12; i += 1) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
    }
    await delay(700);
    sample.composerTextAfterCleanup = await cdp.evaluate(
      `document.querySelector('[data-testid="composer-editor"]')?.textContent ?? null`,
    );
  } catch (error) {
    sample.error = String(error?.message ?? error);
  } finally {
    cdp?.close();
    // Graceful quit: Synara handles SIGTERM as a normal shutdown.
    if (!exited) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
    const quitStart = performance.now();
    while (groupAlive(pgid) && performance.now() - quitStart < 30000) await delay(50);
    sample.quitMs = Math.round(performance.now() - quitStart);
    if (groupAlive(pgid)) {
      sample.forcedKill = true;
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
      await delay(500);
    }
  }
  if (
    sample.ok &&
    (sample.composerTextAfterCleanup !== "" ||
      sample.forcedKill ||
      sample.textBeforeFirstKey !== "")
  ) {
    sample.ok = false;
    sample.error = `invalid: leftover=${JSON.stringify(sample.composerTextAfterCleanup)} forcedKill=${sample.forcedKill === true} textBefore=${JSON.stringify(sample.textBeforeFirstKey)}`;
  }
  try {
    const log = readFileSync(join(home, "userdata/logs/desktop-main.log"), "utf8");
    const lines = log.split("\n").filter((line) => line.includes("[desktop run="));
    const lastRun = lines.at(-1)?.match(/run=([0-9a-f]+)/)?.[1];
    sample.desktopLog = lines
      .filter((line) => line.includes(`run=${lastRun}`))
      .map((line) => {
        const match = line.match(/^\[([^\]]+)\] \[desktop run=[0-9a-f]+\] (.*)$/);
        return match ? [Date.parse(match[1]) - wallStart, match[2].slice(0, 90)] : null;
      })
      .filter(Boolean)
      .slice(0, 14);
  } catch {}
  return sample;
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const keepAlive = setInterval(() => {}, 1000);
mkdirSync(home, { recursive: true });
const loadBefore = readFileSync("/proc/loadavg", "utf8").trim();
const samples = [];
for (let index = 1; index <= runs; index += 1) {
  const sample = await oneRun(index);
  samples.push(sample);
  console.error(
    `[${label}] run ${index}/${runs} ${sample.ok ? `typing=${sample.typingAcceptedMs.toFixed(0)}ms focused=${sample.editorFocusedMs.toFixed(0)}ms editable=${sample.editorEditableMs.toFixed(0)}ms keys=${sample.keysSent} leftover=${JSON.stringify(sample.composerTextAfterCleanup)} target=${sample.pageTargetMs.toFixed(0)}ms fcp=${sample.renderer?.paint?.["first-contentful-paint"]}ms quit=${sample.quitMs}ms` : `ERROR ${sample.error}`}`,
  );
  await delay(1500);
}
const good = samples.filter((sample) => sample.ok).map((sample) => sample.typingAcceptedMs);
const summary = {
  label,
  mode,
  app: appDir,
  commit: gitHead(),
  dirty: gitDirty(),
  home,
  runs,
  ok: good.length,
  errors: samples.length - good.length,
  dirtyDraftAfterCleanup: samples.filter(
    (sample) => sample.ok && sample.composerTextAfterCleanup !== "",
  ).length,
  typingAcceptedMs: good.length
    ? {
        median: Math.round(median(good)),
        min: Math.round(Math.min(...good)),
        max: Math.round(Math.max(...good)),
      }
    : null,
  loadBefore,
  loadAfter: readFileSync("/proc/loadavg", "utf8").trim(),
  date: new Date().toISOString(),
};
console.log(JSON.stringify(summary));
if (outFile) writeFileSync(outFile, JSON.stringify({ summary, samples }, null, 1));
clearInterval(keepAlive);
process.exitCode = summary.errors > 0 ? 1 : 0;
