#!/usr/bin/env bun
/**
 * Multi-thread RAM, CPU, renderer heap, listener/timer, and switch-back benchmark for Synara Desktop.
 *
 * Launches an isolated Synara Electron build (fresh SYNARA_HOME + Electron userData),
 * drives N = 1, 5, 10 threads in both idle and multi-thread streaming states (with active
 * terminals, git diffs, provider CLIs, and agent-spawned children), and prints a detailed
 * per-process-role breakdown.
 *
 * Usage:
 *   bun scripts/benchmark-multi-thread.ts [--counts 1,5,10] [--sample-ms 5000] [--out results.json]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_QUERY,
  WsBootstrapNegotiateResult,
} from "@synara/contracts";
import {
  SYNARA_DESKTOP_SMOKE_USER_DATA_ENV,
  SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
} from "@synara/shared/desktopIdentity";
import { Schema } from "effect";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const desktopDir = join(repoRoot, "apps/desktop");
const fixtureSource = join(__dirname, "lib/benchmark-codex-fixture.mjs");

// --- CLI args ---------------------------------------------------------------

function parseArgs(argv: string[]) {
  let counts = [1, 5, 10];
  let sampleMs = 5_000;
  let settleMs = 3_000;
  let outPath: string | null = null;
  let label = "run";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--counts" && argv[i + 1]) {
      counts = argv[++i]!.split(",")
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } else if (arg === "--sample-ms" && argv[i + 1]) {
      sampleMs = Number(argv[++i]);
    } else if (arg === "--settle-ms" && argv[i + 1]) {
      settleMs = Number(argv[++i]);
    } else if (arg === "--out" && argv[i + 1]) {
      outPath = resolve(argv[++i]!);
    } else if (arg === "--label" && argv[i + 1]) {
      label = argv[++i]!;
    }
  }
  return { counts, sampleMs, settleMs, outPath, label };
}

// --- Network & Electron helpers ---------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not allocate ephemeral port")));
        return;
      }
      const { port } = addr;
      server.close(() => resolvePort(port));
    });
  });
}

async function resolveElectronBinary(): Promise<string> {
  const mod = await import(join(desktopDir, "scripts/electron-launcher.mjs"));
  return mod.resolveElectronPath();
}

// --- Minimal CDP client -----------------------------------------------------

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
          } else {
            entry.resolve(msg.result);
          }
        }
      }
    });
  }

  static async connect(port: number): Promise<CdpClient> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (resp.ok) {
          const targets = (await resp.json()) as Array<{
            type: string;
            url: string;
            webSocketDebuggerUrl?: string;
          }>;
          const page = targets.find(
            (t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"),
          );
          if (page?.webSocketDebuggerUrl) {
            const ws = new WebSocket(page.webSocketDebuggerUrl);
            await new Promise<void>((res, rej) => {
              ws.addEventListener("open", () => res(), { once: true });
              ws.addEventListener("error", (err) => rej(err), { once: true });
            });
            const client = new CdpClient(ws);
            await client.send("Runtime.enable");
            await client.send("Performance.enable");
            await client.send("Page.enable");
            return client;
          }
        }
      } catch {
        // retry
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for Electron CDP target on port ${port}`);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP ${method} timed out`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          res(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `CDP eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result?.value as T;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

// --- Workspace WS RPC client ------------------------------------------------

async function connectWorkspaceRpc(origin: string, bootstrapCredential?: string) {
  const { controllerProtocol } = await import(
    join(repoRoot, "apps/server/src/hostConnections/dialer.ts")
  );
  let bearerToken: string | undefined;
  if (bootstrapCredential) {
    const exchange = await fetch(new URL("/api/auth/bootstrap/bearer", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: bootstrapCredential }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!exchange.ok) {
      throw new Error(`Bootstrap bearer exchange failed: ${exchange.status}`);
    }
    const body = (await exchange.json()) as { sessionToken?: string };
    bearerToken = body.sessionToken;
  }
  let wsToken: string | undefined;
  if (bearerToken) {
    const wsTokenResp = await fetch(new URL("/api/auth/ws-token", origin), {
      method: "POST",
      headers: { authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!wsTokenResp.ok) {
      throw new Error(`WebSocket token issue failed: ${wsTokenResp.status}`);
    }
    const wsBody = (await wsTokenResp.json()) as { token?: string };
    wsToken = wsBody.token;
  }
  const authHeaders: Record<string, string> = bearerToken
    ? { authorization: `Bearer ${bearerToken}` }
    : {};
  const url = new URL("/ws/negotiate", origin);
  const negotiateParams = new URLSearchParams({
    [WS_NEGOTIATE_QUERY.clientBuild]: controllerProtocol.clientBuild,
    [WS_NEGOTIATE_QUERY.protocolEpoch]: String(controllerProtocol.protocolEpoch),
    [WS_NEGOTIATE_QUERY.minRevision]: String(controllerProtocol.minRevision),
    [WS_NEGOTIATE_QUERY.maxRevision]: String(controllerProtocol.maxRevision),
  });
  for (const cap of controllerProtocol.requiredCapabilities) {
    negotiateParams.append(WS_NEGOTIATE_QUERY.requiredCapability, cap);
  }
  url.search = negotiateParams.toString();
  const resp = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Negotiate failed: ${resp.status}`);
  const peer = Schema.decodeUnknownSync(WsBootstrapNegotiateResult)(await resp.json());
  url.protocol = "ws:";
  url.pathname = "/ws";
  const wsParams = new URLSearchParams({
    [WS_COMPATIBILITY_QUERY.clientBuild]: controllerProtocol.clientBuild,
    [WS_COMPATIBILITY_QUERY.protocolEpoch]: String(peer.protocolEpoch),
    [WS_COMPATIBILITY_QUERY.protocolRevision]: String(peer.negotiatedRevision),
    [WS_COMPATIBILITY_QUERY.serverInstanceId]: peer.serverInstanceId,
  });
  if (wsToken) wsParams.set("wsToken", wsToken);
  url.search = wsParams.toString();
  const socket = new WebSocket(url.toString());
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame._tag !== "Exit") return;
    const req = pending.get(String(frame.requestId));
    pending.delete(String(frame.requestId));
    if (frame.exit._tag === "Success") req?.resolve(frame.exit.value);
    else req?.reject(new Error(`RPC failed: ${JSON.stringify(frame.exit)}`));
  });
  await new Promise<void>((res, rej) => {
    socket.addEventListener("open", () => res(), { once: true });
    socket.addEventListener("error", (err) => rej(err), { once: true });
  });
  let seq = 0;
  return {
    request<T = any>(tag: string, payload: unknown = {}): Promise<T> {
      const requestId = String(++seq);
      return new Promise<T>((res, rej) => {
        const t = setTimeout(() => {
          pending.delete(requestId);
          rej(new Error(`RPC ${tag} timed out`));
        }, 25_000);
        pending.set(requestId, {
          resolve: (v) => {
            clearTimeout(t);
            res(v);
          },
          reject: (e) => {
            clearTimeout(t);
            rej(e);
          },
        });
        socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
      });
    },
    close() {
      socket.close();
    },
  };
}

// --- Process-tree & memory/CPU sampling -------------------------------------

type ProcessRole =
  | "electronMain"
  | "electronRenderer"
  | "electronGpu"
  | "electronOther"
  | "synaraBackend"
  | "providerCli"
  | "agentSpawned";

interface ProcessInfo {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuSec: number;
  command: string;
  role: ProcessRole;
}

interface RoleMetrics {
  count: number;
  rssMb: number;
  pssMb: number;
  cpuPct: number;
}

function parsePsTimeToSeconds(raw: string): number {
  // macOS ps `time=` formats: MM:SS.cc or H:MM:SS or D-HH:MM:SS
  const trimmed = raw.trim();
  let days = 0;
  let rest = trimmed;
  if (rest.includes("-")) {
    const [d, r] = rest.split("-");
    days = Number(d) || 0;
    rest = r ?? "0:00";
  }
  const parts = rest.split(":").map((p) => Number(p));
  if (parts.length === 2) {
    return days * 86400 + (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  }
  if (parts.length === 3) {
    return days * 86400 + (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  }
  return 0;
}

function snapshotProcessTree(
  rootPid: number,
  backendPid: number,
  benchHome: string,
  fixtureBinaryPath: string,
): Map<number, ProcessInfo> {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows: Array<{
    pid: number;
    ppid: number;
    rssKb: number;
    cpuSec: number;
    command: string;
  }> = [];
  const childrenByPpid = new Map<number, number[]>();
  const byPid = new Map<number, (typeof rows)[number]>();

  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const cpuSec = parsePsTimeToSeconds(match[4]!);
    const command = match[5]!;
    const row = { pid, ppid, rssKb, cpuSec, command };
    rows.push(row);
    byPid.set(pid, row);
    const list = childrenByPpid.get(ppid);
    if (list) list.push(pid);
    else childrenByPpid.set(ppid, [pid]);
  }

  // BFS from rootPid + backendPid + any detached processes referencing benchHome or fixtureBinary
  const included = new Set<number>();
  const queue: number[] = [];
  const enqueue = (pid: number) => {
    if (!included.has(pid) && byPid.has(pid)) {
      included.add(pid);
      queue.push(pid);
    }
  };
  enqueue(rootPid);
  enqueue(backendPid);
  for (const row of rows) {
    if (
      row.pid !== process.pid &&
      (row.command.includes(benchHome) || row.command.includes(fixtureBinaryPath))
    ) {
      enqueue(row.pid);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenByPpid.get(cur) ?? []) {
      enqueue(child);
    }
  }

  const classify = (row: (typeof rows)[number]): ProcessRole => {
    if (row.pid === rootPid) return "electronMain";
    if (row.pid === backendPid) return "synaraBackend";
    const cmd = row.command;
    if (cmd.includes(fixtureBinaryPath) || /\bcodex\b.*app-server/.test(cmd)) {
      return "providerCli";
    }
    if (cmd.includes("--type=renderer")) return "electronRenderer";
    if (cmd.includes("--type=gpu-process")) return "electronGpu";
    if (
      cmd.includes("--type=utility") ||
      cmd.includes("Electron Helper") ||
      cmd.includes("Synara Helper")
    ) {
      return "electronOther";
    }
    if (cmd.includes("server/dist/index.mjs")) return "synaraBackend";
    return "agentSpawned";
  };

  const result = new Map<number, ProcessInfo>();
  for (const pid of included) {
    const row = byPid.get(pid)!;
    result.set(pid, { ...row, role: classify(row) });
  }
  return result;
}

function measureFootprintBytesByPid(pids: number[]): Map<number, number> {
  const map = new Map<number, number>();
  if (pids.length === 0 || process.platform !== "darwin") return map;
  const tmpJson = join(tmpdir(), `synara-fp-${randomUUID()}.json`);
  try {
    const args = ["-f", "bytes", "-j", tmpJson];
    for (const pid of pids) {
      args.push("-p", String(pid));
    }
    execFileSync("footprint", args, {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
    const parsed = JSON.parse(readFileSync(tmpJson, "utf8")) as {
      processes?: Array<{ pid?: number; footprint?: number }>;
    };
    for (const proc of parsed.processes ?? []) {
      if (typeof proc.pid === "number" && typeof proc.footprint === "number") {
        map.set(proc.pid, proc.footprint);
      }
    }
  } catch {
    // Fallback per-pid if a transient child exited mid-call
    for (const pid of pids) {
      try {
        const text = execFileSync("footprint", ["-f", "bytes", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        const m = text.match(/Footprint:\s+(\d+)\s+B/);
        if (m) map.set(pid, Number(m[1]));
      } catch {
        // exited
      }
    }
  } finally {
    try {
      unlinkSync(tmpJson);
    } catch {
      // ignore
    }
  }
  return map;
}

async function sampleProcessTreeWindow(
  rootPid: number,
  backendPid: number,
  benchHome: string,
  fixtureBinaryPath: string,
  windowMs: number,
): Promise<{
  byRole: Record<ProcessRole, RoleMetrics>;
  total: RoleMetrics;
  processes: Array<{
    pid: number;
    role: ProcessRole;
    rssMb: number;
    pssMb: number;
    cpuPct: number;
    cmd: string;
  }>;
}> {
  const t0 = performance.now();
  const snap0 = snapshotProcessTree(rootPid, backendPid, benchHome, fixtureBinaryPath);
  await delay(windowMs);
  const t1 = performance.now();
  const snap1 = snapshotProcessTree(rootPid, backendPid, benchHome, fixtureBinaryPath);
  const elapsedSec = Math.max(0.05, (t1 - t0) / 1000);

  const pids = [...snap1.keys()];
  const footprints = measureFootprintBytesByPid(pids);

  const roles: ProcessRole[] = [
    "electronMain",
    "electronRenderer",
    "electronGpu",
    "electronOther",
    "synaraBackend",
    "providerCli",
    "agentSpawned",
  ];
  const byRole = Object.fromEntries(
    roles.map((r) => [r, { count: 0, rssMb: 0, pssMb: 0, cpuPct: 0 }]),
  ) as Record<ProcessRole, RoleMetrics>;
  const total: RoleMetrics = { count: 0, rssMb: 0, pssMb: 0, cpuPct: 0 };
  const processes: Array<{
    pid: number;
    role: ProcessRole;
    rssMb: number;
    pssMb: number;
    cpuPct: number;
    cmd: string;
  }> = [];

  for (const [pid, info] of snap1) {
    const prev = snap0.get(pid);
    const deltaCpu = prev ? Math.max(0, info.cpuSec - prev.cpuSec) : 0;
    const cpuPct = (deltaCpu / elapsedSec) * 100;
    const rssMb = info.rssKb / 1024;
    const fpBytes = footprints.get(pid);
    const pssMb = fpBytes !== undefined ? fpBytes / (1024 * 1024) : rssMb;

    const bucket = byRole[info.role];
    bucket.count += 1;
    bucket.rssMb += rssMb;
    bucket.pssMb += pssMb;
    bucket.cpuPct += cpuPct;

    total.count += 1;
    total.rssMb += rssMb;
    total.pssMb += pssMb;
    total.cpuPct += cpuPct;

    processes.push({
      pid,
      role: info.role,
      rssMb: Number(rssMb.toFixed(1)),
      pssMb: Number(pssMb.toFixed(1)),
      cpuPct: Number(cpuPct.toFixed(1)),
      cmd: info.command.slice(0, 140),
    });
  }

  for (const r of roles) {
    byRole[r].rssMb = Number(byRole[r].rssMb.toFixed(1));
    byRole[r].pssMb = Number(byRole[r].pssMb.toFixed(1));
    byRole[r].cpuPct = Number(byRole[r].cpuPct.toFixed(1));
  }
  total.rssMb = Number(total.rssMb.toFixed(1));
  total.pssMb = Number(total.pssMb.toFixed(1));
  total.cpuPct = Number(total.cpuPct.toFixed(1));

  return { byRole, total, processes };
}

// --- Renderer CDP telemetry & switch-back timing ----------------------------

const TIMER_HOOK_SCRIPT = `
(() => {
  if (window.__synaraBenchTimersInstalled) return;
  window.__synaraBenchTimersInstalled = true;
  const activeIntervals = new Set();
  const activeTimeouts = new Set();
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  window.setInterval = (...args) => {
    const id = origSetInterval(...args);
    activeIntervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    activeIntervals.delete(id);
    return origClearInterval(id);
  };
  window.setTimeout = (fn, delay, ...rest) => {
    let id;
    const wrapped = (...cbArgs) => {
      activeTimeouts.delete(id);
      if (typeof fn === "function") return fn(...cbArgs);
    };
    id = origSetTimeout(wrapped, delay, ...rest);
    activeTimeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => {
    activeTimeouts.delete(id);
    return origClearTimeout(id);
  };
  window.__synaraBenchTimerCounts = () => ({
    intervals: activeIntervals.size,
    timeouts: activeTimeouts.size,
  });
})();
`;

interface RendererMetrics {
  jsHeapUsedMb: number;
  jsHeapTotalMb: number;
  domNodes: number;
  jsEventListeners: number;
  activeIntervals: number;
  activeTimeouts: number;
  parkedTerminals: number;
  taskDurationMsPerSec: number;
  scriptDurationMsPerSec: number;
  layoutDurationMsPerSec: number;
}

async function readCdpMetricsMap(cdp: CdpClient): Promise<Map<string, number>> {
  const res = await cdp.send<{ metrics: Array<{ name: string; value: number }> }>(
    "Performance.getMetrics",
  );
  return new Map(res.metrics.map((m) => [m.name, m.value]));
}

async function sampleRendererMetrics(cdp: CdpClient, sampleMs: number): Promise<RendererMetrics> {
  const m0 = await readCdpMetricsMap(cdp);
  const t0 = performance.now();
  await delay(sampleMs);
  const t1 = performance.now();
  const m1 = await readCdpMetricsMap(cdp);
  const elapsedSec = Math.max(0.05, (t1 - t0) / 1000);

  const probe = await cdp.eval<{
    intervals: number;
    timeouts: number;
    parkedTerminals: number;
  }>(`(() => {
    const timers = typeof window.__synaraBenchTimerCounts === "function"
      ? window.__synaraBenchTimerCounts()
      : { intervals: -1, timeouts: -1 };
    const parking = document.getElementById("synara-terminal-parking");
    return {
      intervals: timers.intervals,
      timeouts: timers.timeouts,
      parkedTerminals: parking ? parking.children.length : 0,
    };
  })()`);

  const deltaMsPerSec = (name: string) =>
    Number(
      ((Math.max(0, (m1.get(name) ?? 0) - (m0.get(name) ?? 0)) * 1000) / elapsedSec).toFixed(1),
    );

  return {
    jsHeapUsedMb: Number(((m1.get("JSHeapUsedSize") ?? 0) / (1024 * 1024)).toFixed(1)),
    jsHeapTotalMb: Number(((m1.get("JSHeapTotalSize") ?? 0) / (1024 * 1024)).toFixed(1)),
    domNodes: Math.round(m1.get("Nodes") ?? 0),
    jsEventListeners: Math.round(m1.get("JSEventListeners") ?? 0),
    activeIntervals: probe.intervals,
    activeTimeouts: probe.timeouts,
    parkedTerminals: probe.parkedTerminals,
    taskDurationMsPerSec: deltaMsPerSec("TaskDuration"),
    scriptDurationMsPerSec: deltaMsPerSec("ScriptDuration"),
    layoutDurationMsPerSec: deltaMsPerSec("LayoutDuration"),
  };
}

async function navigateToThreadAndMeasure(
  cdp: CdpClient,
  threadTitle: string,
  expectedMarker: string,
): Promise<number> {
  return await cdp.eval<number>(`new Promise((resolve, reject) => {
    const findSidebarRow = () => {
      const target = ${JSON.stringify(threadTitle)};
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      for (const el of candidates) {
        const text = (el.textContent ?? "").trim();
        if (text === target) return el;
        if (text.startsWith(target)) {
          const next = text.charAt(target.length);
          if (!next || !/[0-9]/.test(next)) return el;
        }
      }
      return null;
    };
    const deadline = performance.now() + 15000;
    let clicked = false;
    let start = performance.now();
    const afterPaint = (cb) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cb();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 80);
    };
    const check = () => {
      if (!clicked) {
        const row = findSidebarRow();
        if (row) {
          start = performance.now();
          row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
          row.click();
          clicked = true;
        }
      }
      const text = document.body?.innerText ?? "";
      if (clicked && text.includes(${JSON.stringify(expectedMarker)})) {
        afterPaint(() => resolve(Number((performance.now() - start).toFixed(1))));
        return;
      }
      if (performance.now() > deadline) {
        reject(
          new Error(
            "Timed out waiting for thread marker " +
              ${JSON.stringify(expectedMarker)} +
              " (clicked=" +
              clicked +
              ") at " +
              window.location.href +
              " | vis=" +
              document.visibilityState +
              " | body=" +
              JSON.stringify(text.slice(0, 400)),
          ),
        );
        return;
      }
      setTimeout(check, 16);
    };
    setTimeout(check, 0);
  })`);
}

async function openTerminalInCurrentThread(cdp: CdpClient): Promise<boolean> {
  // Press Cmd+J / Ctrl+J to open the thread's real xterm.js terminal session
  const modifiers = process.platform === "darwin" ? 4 /* Meta */ : 2 /* Control */;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "j",
    code: "KeyJ",
    windowsVirtualKeyCode: 74,
    modifiers,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "j",
    code: "KeyJ",
    windowsVirtualKeyCode: 74,
    modifiers,
  });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const mounted = await cdp.eval<boolean>(`Boolean(document.querySelector(".xterm-screen"))`);
    if (mounted) return true;
    await delay(100);
  }
  return false;
}

async function ensureChatTabVisible(cdp: CdpClient): Promise<void> {
  await cdp.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll("button, [role='tab']"));
    const chatBtn = buttons.find((b) => {
      const label = (b.getAttribute("title") ?? b.textContent ?? "").trim();
      const rect = b.getBoundingClientRect();
      return label === "Chat" && rect.width > 0 && rect.height > 0;
    });
    if (chatBtn) chatBtn.click();
  })()`);
}

// --- Backend readiness & workspace setup ------------------------------------

async function waitForBackend(benchHome: string, electronPid: number) {
  const runtimePath = join(benchHome, "userdata/server-runtime.json");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(runtimePath, "utf8")) as {
        pid: number;
        port: number;
        host?: string;
      };
      if (Number.isSafeInteger(state.pid) && state.pid > 1 && state.pid !== electronPid) {
        const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (res.ok) return state;
      }
    } catch {
      // retry
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for isolated Synara backend");
}

function createSampleGitWorkspace(workspaceDir: string) {
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  execFileSync("git", ["init", "--initial-branch", "main", workspaceDir], { stdio: "ignore" });
  for (let i = 0; i < 6; i += 1) {
    const lines = Array.from(
      { length: 80 },
      (_, l) => `export const value_${i}_${l} = ${i * 100 + l}; // sample module ${i}`,
    ).join("\n");
    writeFileSync(join(workspaceDir, "src", `module${i}.ts`), `${lines}\n`);
  }
  execFileSync("git", ["-C", workspaceDir, "add", "."], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      workspaceDir,
      "-c",
      "user.name=Synara Bench",
      "-c",
      "user.email=bench@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "Initial benchmark repo",
    ],
    { stdio: "ignore" },
  );
  // Create realistic uncommitted changes so DiffPanel renders real syntax-highlighted diffs
  for (let i = 0; i < 4; i += 1) {
    const filePath = join(workspaceDir, "src", `module${i}.ts`);
    const existing = readFileSync(filePath, "utf8");
    writeFileSync(
      filePath,
      existing.replace(`value_${i}_10 = ${i * 100 + 10}`, `value_${i}_10 = ${i * 100 + 999}`) +
        `\nexport function helper_${i}(n: number) { return n * ${i + 2}; }\n`,
    );
  }
}

// --- Scenario runner --------------------------------------------------------

interface ScenarioResult {
  threadCount: number;
  state: "idle" | "streaming";
  streamingCount: number;
  processTree: {
    byRole: Record<ProcessRole, RoleMetrics>;
    total: RoleMetrics;
  };
  renderer: RendererMetrics;
  switchBackMs: { median: number; samples: number[] };
}

async function runBenchmark() {
  const opts = parseArgs(process.argv.slice(2));
  const benchHome = mkdtempSync(join(tmpdir(), "synara-perf-bench-"));
  const signalDir = join(benchHome, "signals");
  const workspaceDir = join(benchHome, "workspace");
  const binDir = join(benchHome, "bin");
  const fixtureBinary = join(binDir, "codex");
  const userDataDir = join(benchHome, "electron-user-data");
  mkdirSync(signalDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(benchHome, "userdata"), { recursive: true });

  copyFileSync(fixtureSource, fixtureBinary);
  chmodSync(fixtureBinary, 0o755);
  createSampleGitWorkspace(workspaceDir);

  writeFileSync(
    join(benchHome, "userdata/settings.json"),
    JSON.stringify(
      {
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
        providers: {
          codex: {
            binaryPath: fixtureBinary,
            homePath: join(benchHome, "codex-home"),
          },
        },
      },
      null,
      2,
    ),
  );

  const cdpPort = await findFreePort();
  const electronPath = await resolveElectronBinary();
  const benchRunId = randomUUID();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SYNARA_HOME: benchHome,
    SYNARA_DESKTOP_FLAVOR: "dev",
    SYNARA_SOURCE_DESKTOP_BUILD_MARKER,
    SYNARA_BENCH_RUN_ID: benchRunId,
    SYNARA_BENCH_SIGNAL_DIR: signalDir,
    [SYNARA_DESKTOP_SMOKE_USER_DATA_ENV]: userDataDir,
    ELECTRON_ENABLE_LOGGING: "0",
  };
  delete childEnv.VITE_DEV_SERVER_URL;
  delete childEnv.SYNARA_AUTH_TOKEN;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  console.log(`[bench] Launching isolated Electron (CDP=${cdpPort}, home=${benchHome})...`);
  const electronProc: ChildProcess = spawn(
    electronPath,
    [`--remote-debugging-port=${cdpPort}`, "dist-electron/main.js"],
    {
      cwd: desktopDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let electronStderr = "";
  electronProc.stderr?.on("data", (chunk) => {
    electronStderr += chunk.toString();
  });

  let cdp: CdpClient | null = null;
  let rpc: Awaited<ReturnType<typeof connectWorkspaceRpc>> | null = null;
  const results: ScenarioResult[] = [];

  try {
    const backend = await waitForBackend(benchHome, electronProc.pid!);
    const origin = `http://127.0.0.1:${backend.port}`;
    console.log(`[bench] Backend ready on ${origin} (pid=${backend.pid}), connecting CDP...`);

    cdp = await CdpClient.connect(cdpPort);
    await cdp.send("Page.bringToFront");
    // Dismiss Safari & AppSnap onboarding dialogs & install lightweight timer tracker on reload
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        try {
          localStorage.setItem("synara:safari-access-onboarding:v1", JSON.stringify("later"));
          localStorage.setItem("synara:appsnap-welcome:v1", JSON.stringify({ acknowledged: true }));
        } catch {}
        ${TIMER_HOOK_SCRIPT}
      `,
    });
    await cdp.send("Page.reload");
    await delay(2_500);

    const desktopWsUrl = await cdp.eval<string>(`window.desktopBridge?.getWsUrl?.() ?? ""`);
    let authToken: string | undefined;
    if (desktopWsUrl) {
      try {
        authToken = new URL(desktopWsUrl).searchParams.get("token") ?? undefined;
      } catch {
        // ignore
      }
    }
    rpc = await connectWorkspaceRpc(origin, authToken);
    const projectId = randomUUID();
    await rpc.request("orchestration.dispatchCommand", {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: "Benchmark Workspace",
      workspaceRoot: workspaceDir,
      createdAt: new Date().toISOString(),
    });

    const threads: Array<{ id: string; title: string; marker: string; terminalId: string }> = [];
    const maxN = Math.max(...opts.counts);
    const sortedCounts = [...opts.counts].sort((a, b) => a - b);

    const openDiffInCurrentThread = async () => {
      const modifiers = process.platform === "darwin" ? 4 /* Meta */ : 2 /* Control */;
      await cdp!.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "d",
        code: "KeyD",
        windowsVirtualKeyCode: 68,
        modifiers,
      });
      await cdp!.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "d",
        code: "KeyD",
        windowsVirtualKeyCode: 68,
        modifiers,
      });
    };

    const ensureThreadCount = async (targetN: number) => {
      while (threads.length < targetN) {
        const idx = threads.length + 1;
        const threadId = randomUUID();
        const title = `Benchmark Thread ${idx}`;
        const marker = `BENCH_T${idx}`;
        await rpc!.request("orchestration.dispatchCommand", {
          type: "thread.create",
          commandId: randomUUID(),
          threadId,
          projectId,
          title,
          modelSelection: { provider: "codex", model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        });

        // Run an initial seed turn first so Chat surface is primary
        await rpc!.request("orchestration.dispatchCommand", {
          type: "thread.turn.start",
          commandId: randomUUID(),
          threadId,
          message: {
            messageId: randomUUID(),
            role: "user",
            text: `BENCH_IDLE_SEED MARKER:${marker}`,
            attachments: [],
          },
          modelSelection: { provider: "codex", model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          createdAt: new Date().toISOString(),
        });

        // Verify backend completed/started the seed turn with our fixture
        const turnDeadline = Date.now() + 15_000;
        let seeded = false;
        let lastSnap: unknown = null;
        while (Date.now() < turnDeadline) {
          const snap = await rpc!.request<any>("orchestration.getThreadDetailSnapshot", {
            threadId,
          });
          lastSnap = snap;
          if (JSON.stringify(snap).includes(`[${marker}]`)) {
            seeded = true;
            break;
          }
          await delay(150);
        }
        if (!seeded) {
          throw new Error(
            `Seed turn for ${marker} did not emit marker in backend snapshot: ${JSON.stringify(lastSnap).slice(0, 800)}`,
          );
        }

        // Click the thread in the sidebar and wait for seeded response marker to render
        const navMs = await navigateToThreadAndMeasure(cdp!, title, `[${marker}]`);
        console.log(`[bench]   thread ${idx} seeded & rendered (${navMs}ms)`);
        await delay(200);

        // Open the thread's terminal via Cmd+J, seed 120 lines of PTY output, then switch back to Chat tab
        const termOpened = await openTerminalInCurrentThread(cdp!);
        if (!termOpened) {
          console.warn(`[bench]   thread ${idx}: terminal pane did not mount .xterm-screen`);
        }
        await delay(250);
        const activeTermId = "default";
        await rpc!
          .request("terminal.write", {
            threadId,
            terminalId: activeTermId,
            data: `for i in $(seq 1 120); do echo "thread-${idx} build-log line $i status=ok"; done\n`,
          })
          .catch(() => undefined);
        await delay(300);
        await ensureChatTabVisible(cdp!);
        await delay(200);
        // Also toggle diff panel open via Cmd+D
        await openDiffInCurrentThread();
        await delay(250);
        threads.push({ id: threadId, title, marker, terminalId: activeTermId });
      }
    };

    const measureSwitchBack = async (frontIdx: number, backIdx: number) => {
      if (frontIdx === backIdx) {
        return { median: 0, samples: [0] };
      }
      const samples: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        const ms = await navigateToThreadAndMeasure(
          cdp!,
          threads[backIdx]!.title,
          `[${threads[backIdx]!.marker}]`,
        );
        samples.push(ms);
        await delay(250);
        await navigateToThreadAndMeasure(
          cdp!,
          threads[frontIdx]!.title,
          `[${threads[frontIdx]!.marker}]`,
        );
        await delay(250);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      return { median: sorted[Math.floor(sorted.length / 2)]!, samples };
    };

    for (const n of sortedCounts) {
      if (n > maxN) continue;
      console.log(`\n[bench] === Preparing N = ${n} threads ===`);
      await ensureThreadCount(n);

      // Focus newest thread (index n-1) if not already on it
      const frontIdx = n - 1;
      const backIdx = 0;
      const onFront = await cdp.eval<boolean>(
        `(document.body?.innerText ?? "").includes(${JSON.stringify(`[${threads[frontIdx]!.marker}]`)})`,
      );
      if (!onFront) {
        await navigateToThreadAndMeasure(
          cdp,
          threads[frontIdx]!.title,
          `[${threads[frontIdx]!.marker}]`,
        );
      }

      // --- IDLE PHASE ---
      console.log(
        `[bench] N=${n} IDLE: settling ${opts.settleMs}ms, sampling ${opts.sampleMs}ms...`,
      );
      await delay(opts.settleMs);
      const [idleProcs, idleRenderer] = await Promise.all([
        sampleProcessTreeWindow(
          electronProc.pid!,
          backend.pid,
          benchHome,
          fixtureBinary,
          opts.sampleMs,
        ),
        sampleRendererMetrics(cdp, opts.sampleMs),
      ]);
      const idleSwitch = await measureSwitchBack(frontIdx, backIdx);
      results.push({
        threadCount: n,
        state: "idle",
        streamingCount: 0,
        processTree: { byRole: idleProcs.byRole, total: idleProcs.total },
        renderer: idleRenderer,
        switchBackMs: idleSwitch,
      });

      // --- STREAMING PHASE ---
      const stopFile = join(signalDir, "stop-streaming");
      if (existsSync(stopFile)) unlinkSync(stopFile);
      const streamingCount = n === 1 ? 1 : n <= 5 ? Math.min(n, 3) : Math.min(n, 4);
      // Stream on frontmost thread + (streamingCount - 1) oldest background threads
      const streamingIndices = new Set<number>([frontIdx]);
      for (let i = 0; i < n && streamingIndices.size < streamingCount; i += 1) {
        streamingIndices.add(i);
      }

      console.log(
        `[bench] N=${n} STREAMING (${streamingIndices.size} active threads: ${[...streamingIndices].map((i) => i + 1).join(",")})...`,
      );
      for (const idx of streamingIndices) {
        const t = threads[idx]!;
        await rpc.request("orchestration.dispatchCommand", {
          type: "thread.turn.start",
          commandId: randomUUID(),
          threadId: t.id,
          message: {
            messageId: randomUUID(),
            role: "user",
            text: `BENCH_STREAM_CONTINUOUS BENCH_WITH_CHILD MARKER:${t.marker} STOP_FILE:${stopFile}`,
            attachments: [],
          },
          modelSelection: { provider: "codex", model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          createdAt: new Date().toISOString(),
        });
      }

      // Also drive periodic PTY terminal output on streaming threads (simulating agent terminal activity)
      let stopTermFeed = false;
      const termFeedPromise = (async () => {
        let tick = 0;
        while (!stopTermFeed) {
          tick += 1;
          for (const idx of streamingIndices) {
            await rpc!
              .request("terminal.write", {
                threadId: threads[idx]!.id,
                terminalId: threads[idx]!.terminalId,
                data: `echo "stream-tick-${tick} thread-${idx + 1}"\n`,
              })
              .catch(() => undefined);
          }
          await delay(300);
        }
      })();

      await delay(opts.settleMs);
      const [streamProcs, streamRenderer] = await Promise.all([
        sampleProcessTreeWindow(
          electronProc.pid!,
          backend.pid,
          benchHome,
          fixtureBinary,
          opts.sampleMs,
        ),
        sampleRendererMetrics(cdp, opts.sampleMs),
      ]);
      const streamSwitch = await measureSwitchBack(frontIdx, backIdx);

      // Cleanly finish streaming turns
      stopTermFeed = true;
      writeFileSync(stopFile, "stop\n");
      await termFeedPromise;
      await delay(1_200);
      if (existsSync(stopFile)) unlinkSync(stopFile);

      results.push({
        threadCount: n,
        state: "streaming",
        streamingCount: streamingIndices.size,
        processTree: { byRole: streamProcs.byRole, total: streamProcs.total },
        renderer: streamRenderer,
        switchBackMs: streamSwitch,
      });
    }

    // --- Print summary table ---
    console.log(`\n=== Synara Multi-Thread Benchmark (${opts.label}) ===\n`);
    console.log(
      "| N | State | Total RSS (MB) | Total PSS (MB) | Total CPU% | Main PSS/CPU | Renderer PSS/CPU | GPU PSS/CPU | Backend PSS/CPU | Providers (#/PSS/CPU) | Children (#/PSS/CPU) | JS Heap (MB) | DOM Nodes | Listeners | Timers (int/to) | Parked Terms | Switch (ms) |",
    );
    console.log("|---:|---|---:|---:|---:|---|---|---|---|---|---|---:|---:|---:|---|---:|---:|");
    for (const r of results) {
      const b = r.processTree.byRole;
      const fmt = (m: RoleMetrics) => `${m.pssMb}MB/${m.cpuPct}%`;
      const fmtC = (m: RoleMetrics) => `${m.count}/${m.pssMb}MB/${m.cpuPct}%`;
      console.log(
        `| ${r.threadCount} | ${r.state}${r.streamingCount ? ` (${r.streamingCount})` : ""} | ${r.processTree.total.rssMb} | ${r.processTree.total.pssMb} | ${r.processTree.total.cpuPct}% | ${fmt(b.electronMain)} | ${fmt(b.electronRenderer)} | ${fmt(b.electronGpu)} | ${fmt(b.synaraBackend)} | ${fmtC(b.providerCli)} | ${fmtC(b.agentSpawned)} | ${r.renderer.jsHeapUsedMb}/${r.renderer.jsHeapTotalMb} | ${r.renderer.domNodes} | ${r.renderer.jsEventListeners} | ${r.renderer.activeIntervals}/${r.renderer.activeTimeouts} | ${r.renderer.parkedTerminals} | ${r.switchBackMs.median} |`,
      );
    }

    if (opts.outPath) {
      writeFileSync(
        opts.outPath,
        JSON.stringify(
          {
            label: opts.label,
            timestamp: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch,
            results,
          },
          null,
          2,
        ),
      );
      console.log(`\nSaved JSON report to ${opts.outPath}`);
    }
  } catch (err) {
    console.error("[bench] Failed:", err);
    if (electronStderr.trim()) {
      console.error("[bench] Electron stderr tail:\n", electronStderr.slice(-2000));
    }
    process.exitCode = 1;
  } finally {
    rpc?.close();
    cdp?.close();
    try {
      electronProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    await delay(1_500);
    if (electronProc.exitCode === null) {
      try {
        electronProc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    rmSync(benchHome, { recursive: true, force: true });
  }
}

await runBenchmark();
