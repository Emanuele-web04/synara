import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type {
  PreviewRuntimeEvent,
  PreviewRuntimeInput,
  PreviewRuntimeState,
  PreviewStartInput,
  PreviewStopAllInput,
  PreviewStopAllResult,
  TerminalEvent,
  TerminalOpenInput,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { Effect, Exit } from "effect";

import type { TerminalManagerShape } from "../terminal/Services/Manager";
import { extractLocalUrl, resolvePreviewTarget } from "./PreviewTargetResolver";

const DEFAULT_PREVIEW_PORT = 5173;
const PREVIEW_HEALTH_TIMEOUT_MS = 1_500;
const PREVIEW_START_DEADLINE_MS = 45_000;
const PREVIEW_MONITOR_INTERVAL_MS = 5_000;
const PREVIEW_MONITOR_FAILURE_LIMIT = 3;
const PREVIEW_PORT_KILL_GRACE_MS = 500;
const PREVIEW_SOURCE_CHANGE_DEBOUNCE_MS = 450;
const SAFE_PREVIEW_TERMINAL_PREFIX = "_cHJldmlldy0";
const LOG_SAMPLE_BYTES = 96 * 1024;

interface PreviewRuntimeRecord {
  state: PreviewRuntimeState;
  failures: number;
  monitor: ReturnType<typeof setInterval> | null;
  startPoll: ReturnType<typeof setTimeout> | null;
  sourceWatcher: FSWatcher | null;
  sourceChangeTimer: ReturnType<typeof setTimeout> | null;
  sourceChangeCount: number;
  sourceChangePath: string | null;
}

interface PreviewRuntimeManagerOptions {
  terminalLogsDir?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function previewIdForCwd(cwd: string): string {
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return `preview-${hash}`;
}

function runtimeKey(cwd: string): string {
  return path.resolve(cwd.trim());
}

function terminalIdForCwd(cwd: string): string {
  return previewIdForCwd(cwd);
}

function safeTerminalId(terminalId: string): string {
  return Buffer.from(terminalId, "utf8").toString("base64url");
}

function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port =
      parsed.port.length > 0
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

function localPreviewKillPort(state: PreviewRuntimeState): number | null {
  if (!state.url) {
    return state.command && state.port ? state.port : null;
  }
  try {
    const parsed = new URL(state.url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") {
      return null;
    }
    if (!parsed.port && !state.command) {
      return null;
    }
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : state.port;
    return port && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listeningPidsForPort(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 1_000 },
      (_error, stdout) => {
        const pids = stdout
          .split(/\s+/)
          .map((value) => Number.parseInt(value, 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
        resolve([...new Set(pids)]);
      },
    );
  });
}

async function killLocalPreviewPort(port: number): Promise<number> {
  const pids = await listeningPidsForPort(port);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited or cannot be signaled.
    }
  }
  if (pids.length > 0) {
    await delay(PREVIEW_PORT_KILL_GRACE_MS);
  }
  for (const pid of pids) {
    if (!processIsAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited or cannot be signaled.
    }
  }
  return pids.length;
}

function parsePreviewPorts(text: string): number[] {
  const stripped = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const ports = new Set<number>();
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{2,5})/gi,
    /\bpython3?\s+-m\s+http\.server\s+(\d{2,5})\b/gi,
    /(?:^|\s)(?:--port|-p)\s+(\d{2,5})\b/gi,
    /\b(?:PORT|VITE_PORT)=(\d{2,5})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const port = Number.parseInt(match[1] ?? "", 10);
      if (port > 0 && port <= 65_535) {
        ports.add(port);
      }
    }
  }
  return [...ports];
}

function shouldIgnoreSourceChange(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    /(^|\/)(node_modules|\.git|\.turbo|\.next|\.nuxt|\.svelte-kit|dist|build|coverage|out)(\/|$)/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\.(log|tmp|swp|map)$/i.test(normalized);
}

async function readLogSample(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size <= LOG_SAMPLE_BYTES * 2) {
    return fs.readFile(filePath, "utf8");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(LOG_SAMPLE_BYTES);
    const tail = Buffer.alloc(LOG_SAMPLE_BYTES);
    await handle.read(head, 0, LOG_SAMPLE_BYTES, 0);
    await handle.read(tail, 0, LOG_SAMPLE_BYTES, stat.size - LOG_SAMPLE_BYTES);
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

async function liveEditPortsFromLogs(input: {
  terminalLogsDir: string | undefined;
  terminalId?: string;
}): Promise<number[]> {
  if (!input.terminalLogsDir) {
    return [];
  }
  const terminalMarker = input.terminalId ? `_${safeTerminalId(input.terminalId)}` : null;
  try {
    const entries = await fs.readdir(input.terminalLogsDir, { withFileTypes: true });
    const ports = new Set<number>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) {
        continue;
      }
      const matchesTerminal = terminalMarker
        ? entry.name.includes(terminalMarker)
        : entry.name.includes(SAFE_PREVIEW_TERMINAL_PREFIX);
      if (!matchesTerminal) {
        continue;
      }
      const sample = await readLogSample(path.join(input.terminalLogsDir, entry.name)).catch(
        () => "",
      );
      for (const port of parsePreviewPorts(sample)) {
        ports.add(port);
      }
    }
    return [...ports];
  } catch {
    return [];
  }
}

async function reservePort(preferredPort: number): Promise<number> {
  const requestedPort = preferredPort > 0 ? preferredPort : 0;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (requestedPort !== 0) {
        reservePort(0).then(resolve, reject);
        return;
      }
      reject(error);
    });
    server.listen({ host: "127.0.0.1", port: requestedPort }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : requestedPort;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function checkPreviewUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREVIEW_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export class PreviewRuntimeManager {
  private readonly records = new Map<string, PreviewRuntimeRecord>();
  private readonly listeners = new Set<(event: PreviewRuntimeEvent) => void>();
  private readonly terminalIds = new Map<string, string>();

  constructor(
    private readonly terminalManager: TerminalManagerShape,
    private readonly options: PreviewRuntimeManagerOptions = {},
  ) {}

  getState(input: PreviewRuntimeInput): Effect.Effect<PreviewRuntimeState> {
    return Effect.sync(() => this.getOrCreateRecord(input).state);
  }

  start(input: PreviewStartInput): Effect.Effect<PreviewRuntimeState, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const cwd = runtimeKey(input.cwd);
      const record = self.getOrCreateRecord({ ...input, cwd });

      if (input.reuseOnly === true) {
        return record.state;
      }

      if (record.state.status === "running" || record.state.status === "starting") {
        return record.state;
      }

      const previewPort = input.url
        ? (input.preferredPort ?? DEFAULT_PREVIEW_PORT)
        : yield* Effect.tryPromise({
            try: () => reservePort(input.preferredPort ?? DEFAULT_PREVIEW_PORT),
            catch: (cause) => new Error("Unable to reserve a preview port.", { cause }),
          });
      const target = yield* Effect.tryPromise({
        try: () =>
          resolvePreviewTarget({
            cwd,
            port: previewPort,
            ...(input.command ? { command: input.command } : {}),
            ...(input.target ? { target: input.target } : {}),
            ...(input.url ? { url: input.url } : {}),
          }),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Unable to resolve preview target.", { cause }),
      });
      const terminalId = target.command ? terminalIdForCwd(cwd) : null;
      const startedAt = nowIso();

      self.updateRecord(record, {
        ...record.state,
        cwd,
        targetCwd: target.runCwd,
        status: target.command ? "starting" : "running",
        url: target.url,
        port: portFromUrl(target.url) ?? previewPort,
        command: target.command,
        resolverKind: target.resolverKind,
        framework: target.framework,
        scriptName: target.scriptName,
        diagnostics: target.diagnostics,
        terminalId,
        ownedBySynara: Boolean(target.command),
        lastError: null,
        startedAt,
        updatedAt: startedAt,
      });
      self.ensureSourceWatcher(record, target.runCwd);

      if (!target.command || !terminalId) {
        return record.state;
      }

      const openInput: TerminalOpenInput = {
        threadId: input.threadId,
        terminalId,
        cwd: target.runCwd,
        cols: 120,
        rows: 30,
        env: {
          BROWSER: "none",
          HOST: "127.0.0.1",
          PORT: String(previewPort),
          T3CODE_NO_BROWSER: "1",
          VITE_HOST: "127.0.0.1",
          VITE_PORT: String(previewPort),
        },
      };
      yield* self.terminalManager.open(openInput);
      const writeInput: TerminalWriteInput = {
        threadId: input.threadId,
        terminalId,
        data: `${target.command}\r`,
      };
      yield* self.terminalManager.write(writeInput);

      self.scheduleStartPoll(record, target.url);
      return record.state;
    });
  }

  stop(input: PreviewRuntimeInput): Effect.Effect<PreviewRuntimeState, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const cwd = runtimeKey(input.cwd);
      const record = self.getOrCreateRecord({ ...input, cwd });
      yield* self.stopRecord(record, { killPort: false });
      return record.state;
    });
  }

  stopAll(input: PreviewStopAllInput): Effect.Effect<PreviewStopAllResult> {
    const self = this;
    return Effect.gen(function* () {
      let stoppedCount = 0;
      let killedPortCount = 0;
      let failedCount = 0;
      const urls = new Set<string>();
      for (const record of self.records.values()) {
        if (record.state.status === "idle" || record.state.status === "stopped") {
          continue;
        }
        if (record.state.url) {
          urls.add(record.state.url);
        }
        const result = yield* self.stopRecord(record, {
          fallbackThreadId: input.threadId,
          killPort: true,
        });
        stoppedCount += 1;
        killedPortCount += result.killedPortCount;
        failedCount += result.failedCount;
      }
      const orphanPorts = yield* Effect.promise(() =>
        liveEditPortsFromLogs({ terminalLogsDir: self.options.terminalLogsDir }),
      );
      for (const port of orphanPorts) {
        const killedForPort = yield* Effect.promise(() =>
          killLocalPreviewPort(port).catch(() => 0),
        );
        killedPortCount += killedForPort;
        urls.add(`http://127.0.0.1:${port}`);
      }
      return { stoppedCount, killedPortCount, failedCount, urls: Array.from(urls) };
    });
  }

  restart(input: PreviewStartInput): Effect.Effect<PreviewRuntimeState, unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.stop(input);
      return yield* self.start({ ...input, reuseOnly: false });
    });
  }

  subscribe(listener: (event: PreviewRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    for (const record of this.records.values()) {
      listener({ type: "state", state: record.state });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  handleTerminalEvent(event: TerminalEvent): void {
    const key = this.terminalIds.get(event.terminalId);
    if (!key) {
      return;
    }
    const record = this.records.get(key);
    if (!record) {
      return;
    }

    if (event.type === "output") {
      const url = extractLocalUrl(event.data);
      if (url) {
        this.updateRecord(record, {
          ...record.state,
          url,
          port: portFromUrl(url),
          updatedAt: nowIso(),
        });
      }
      return;
    }

    if (event.type === "exited") {
      this.clearTimers(record);
      this.updateRecord(record, {
        ...record.state,
        status: record.state.status === "stopped" ? "stopped" : "error",
        lastError:
          record.state.status === "stopped"
            ? null
            : `Preview process exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}.`,
        updatedAt: nowIso(),
      });
      return;
    }

    if (event.type === "error") {
      this.clearTimers(record);
      this.updateRecord(record, {
        ...record.state,
        status: "error",
        lastError: event.message,
        updatedAt: nowIso(),
      });
    }
  }

  private getOrCreateRecord(input: PreviewRuntimeInput): PreviewRuntimeRecord {
    const cwd = runtimeKey(input.cwd);
    const key = runtimeKey(cwd);
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const timestamp = nowIso();
    const state: PreviewRuntimeState = {
      id: previewIdForCwd(cwd),
      threadId: input.threadId as PreviewRuntimeState["threadId"],
      projectId: (input.projectId ?? null) as PreviewRuntimeState["projectId"],
      cwd,
      status: "idle",
      url: null,
      port: null,
      command: null,
      terminalId: null,
      ownedBySynara: false,
      lastError: null,
      startedAt: null,
      updatedAt: timestamp,
    };
    const record: PreviewRuntimeRecord = {
      state,
      failures: 0,
      monitor: null,
      startPoll: null,
      sourceWatcher: null,
      sourceChangeTimer: null,
      sourceChangeCount: 0,
      sourceChangePath: null,
    };
    this.records.set(key, record);
    return record;
  }

  private updateRecord(record: PreviewRuntimeRecord, nextState: PreviewRuntimeState): void {
    const previousTerminalId = record.state.terminalId;
    record.state = nextState;
    const key = runtimeKey(nextState.cwd);
    this.records.set(key, record);
    if (previousTerminalId && previousTerminalId !== nextState.terminalId) {
      this.terminalIds.delete(previousTerminalId);
    }
    if (nextState.terminalId) {
      this.terminalIds.set(nextState.terminalId, key);
    }
    if (nextState.status === "running") {
      this.ensureMonitor(record);
    }
    const event: PreviewRuntimeEvent = { type: "state", state: nextState };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private ensureSourceWatcher(record: PreviewRuntimeRecord, root: string): void {
    this.clearSourceWatcher(record);
    const rootPath = path.resolve(root);
    const scheduleSourceChange = (changedPath: string | null) => {
      if (changedPath && shouldIgnoreSourceChange(changedPath)) {
        return;
      }
      record.sourceChangeCount += 1;
      record.sourceChangePath = changedPath;
      if (record.sourceChangeTimer !== null) {
        clearTimeout(record.sourceChangeTimer);
      }
      record.sourceChangeTimer = setTimeout(() => {
        record.sourceChangeTimer = null;
        if (record.state.status !== "running") {
          record.sourceChangeCount = 0;
          record.sourceChangePath = null;
          return;
        }
        const event: PreviewRuntimeEvent = {
          type: "source-changed",
          state: record.state,
          changedPath: record.sourceChangePath,
          changedCount: record.sourceChangeCount,
        };
        record.sourceChangeCount = 0;
        record.sourceChangePath = null;
        for (const listener of this.listeners) {
          listener(event);
        }
      }, PREVIEW_SOURCE_CHANGE_DEBOUNCE_MS);
    };

    try {
      record.sourceWatcher = watch(
        rootPath,
        { recursive: process.platform === "darwin" || process.platform === "win32" },
        (_eventType, filename) => {
          const changedPath = filename ? path.join(rootPath, filename.toString()) : null;
          scheduleSourceChange(changedPath);
        },
      );
      record.sourceWatcher.on("error", () => {
        this.clearSourceWatcher(record);
      });
    } catch {
      record.sourceWatcher = null;
    }
  }

  private clearSourceWatcher(record: PreviewRuntimeRecord): void {
    if (record.sourceChangeTimer !== null) {
      clearTimeout(record.sourceChangeTimer);
      record.sourceChangeTimer = null;
    }
    record.sourceChangeCount = 0;
    record.sourceChangePath = null;
    record.sourceWatcher?.close();
    record.sourceWatcher = null;
  }

  private stopRecord(
    record: PreviewRuntimeRecord,
    options: {
      fallbackThreadId?: PreviewStopAllInput["threadId"];
      killPort: boolean;
    },
  ): Effect.Effect<{ killedPortCount: number; failedCount: number }> {
    const self = this;
    return Effect.gen(function* () {
      let failedCount = 0;
      self.clearTimers(record);

      if (record.state.terminalId) {
        const closeResult = yield* Effect.exit(
          self.terminalManager.close({
            threadId: record.state.threadId ?? options.fallbackThreadId,
            terminalId: record.state.terminalId,
            deleteHistory: false,
          }),
        );
        if (Exit.isFailure(closeResult)) {
          failedCount += 1;
        }
      }

      const port = localPreviewKillPort(record.state);
      let killedPortCount = 0;
      if (options.killPort && port) {
        killedPortCount = yield* Effect.promise(() => killLocalPreviewPort(port).catch(() => 0));
      }

      self.updateRecord(record, {
        ...record.state,
        status: "stopped",
        lastError:
          failedCount > 0 ? "Live Edit stopped, but terminal cleanup reported an error." : null,
        updatedAt: nowIso(),
      });
      return { killedPortCount, failedCount };
    });
  }

  private scheduleStartPoll(record: PreviewRuntimeRecord, url: string): void {
    this.clearStartPoll(record);
    const startedAt = Date.now();
    const poll = () => {
      void checkPreviewUrl(record.state.url ?? url).then((healthy) => {
        if (record.state.status !== "starting") {
          return;
        }
        if (healthy) {
          this.updateRecord(record, {
            ...record.state,
            status: "running",
            lastError: null,
            updatedAt: nowIso(),
          });
          return;
        }
        if (Date.now() - startedAt >= PREVIEW_START_DEADLINE_MS) {
          this.updateRecord(record, {
            ...record.state,
            status: "error",
            lastError: "Preview did not become reachable before the startup timeout.",
            updatedAt: nowIso(),
          });
          return;
        }
        record.startPoll = setTimeout(poll, 1_000);
      });
    };
    record.startPoll = setTimeout(poll, 500);
  }

  private ensureMonitor(record: PreviewRuntimeRecord): void {
    if (record.monitor !== null) {
      return;
    }
    record.failures = 0;
    record.monitor = setInterval(() => {
      const url = record.state.url;
      if (record.state.status !== "running" || !url) {
        return;
      }
      void checkPreviewUrl(url).then((healthy) => {
        if (record.state.status !== "running") {
          return;
        }
        if (healthy) {
          record.failures = 0;
          return;
        }
        record.failures += 1;
        if (record.failures < PREVIEW_MONITOR_FAILURE_LIMIT) {
          return;
        }
        this.clearTimers(record);
        this.updateRecord(record, {
          ...record.state,
          status: "error",
          lastError: "Preview is no longer reachable.",
          updatedAt: nowIso(),
        });
      });
    }, PREVIEW_MONITOR_INTERVAL_MS);
  }

  private clearStartPoll(record: PreviewRuntimeRecord): void {
    if (record.startPoll !== null) {
      clearTimeout(record.startPoll);
      record.startPoll = null;
    }
  }

  private clearTimers(record: PreviewRuntimeRecord): void {
    this.clearStartPoll(record);
    if (record.monitor !== null) {
      clearInterval(record.monitor);
      record.monitor = null;
    }
    this.clearSourceWatcher(record);
    record.failures = 0;
  }
}
