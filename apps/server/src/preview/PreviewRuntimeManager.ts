import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type {
  PreviewRuntimeEvent,
  PreviewRuntimeInput,
  PreviewRuntimeState,
  PreviewStartInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalWriteInput,
} from "@t3tools/contracts";
import { Effect } from "effect";

import type { TerminalManagerShape } from "../terminal/Services/Manager";

const DEFAULT_PREVIEW_PORT = 5173;
const PREVIEW_HEALTH_TIMEOUT_MS = 1_500;
const PREVIEW_START_DEADLINE_MS = 45_000;
const PREVIEW_MONITOR_INTERVAL_MS = 5_000;
const PREVIEW_MONITOR_FAILURE_LIMIT = 3;
const PREVIEW_SCRIPT_PRIORITY = ["dev", "start", "serve", "preview"] as const;

type PreviewPackageManager = "bun" | "pnpm" | "yarn" | "npm";

interface PreviewRuntimeRecord {
  state: PreviewRuntimeState;
  failures: number;
  monitor: ReturnType<typeof setInterval> | null;
  startPoll: ReturnType<typeof setTimeout> | null;
}

interface PackageJsonShape {
  packageManager?: string;
  scripts?: Record<string, string>;
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

function normalizeLocalUrl(url: string): string {
  return url.replace("://0.0.0.0", "://127.0.0.1").replace("://[::]", "://127.0.0.1");
}

function extractLocalUrl(output: string): string | null {
  const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?[^\s'")<>]*/i);
  return match ? normalizeLocalUrl(match[0]) : null;
}

function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function packageManagerFromPackageJson(value: string | undefined): PreviewPackageManager | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("bun@")) return "bun";
  if (normalized.startsWith("pnpm@")) return "pnpm";
  if (normalized.startsWith("yarn@")) return "yarn";
  if (normalized.startsWith("npm@")) return "npm";
  return null;
}

async function detectPackageManager(
  cwd: string,
  packageJson: PackageJsonShape | null,
): Promise<PreviewPackageManager> {
  const declaredManager = packageManagerFromPackageJson(packageJson?.packageManager);
  if (declaredManager) return declaredManager;
  if (await fileExists(path.join(cwd, "bun.lockb"))) return "bun";
  if (await fileExists(path.join(cwd, "bun.lock"))) return "bun";
  if (await fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(cwd, "package-lock.json"))) return "npm";
  return "npm";
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

function commandForPackageManager(manager: PreviewPackageManager, scriptName: string): string {
  switch (manager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "npm":
      return `npm run ${scriptName}`;
  }
}

async function resolvePreviewCommand(input: {
  cwd: string;
  port: number;
  command?: string;
}): Promise<string> {
  if (input.command && input.command.trim().length > 0) {
    return input.command.trim();
  }

  const packageJson = await readJsonFile<PackageJsonShape>(path.join(input.cwd, "package.json"));
  const scripts = packageJson?.scripts ?? {};
  const scriptName = PREVIEW_SCRIPT_PRIORITY.find((candidate) => scripts[candidate]);
  if (!scriptName) {
    throw new Error("No package.json preview script found. Expected one of: dev, start, serve, preview.");
  }

  const manager = await detectPackageManager(input.cwd, packageJson);
  const baseCommand = commandForPackageManager(manager, scriptName);
  const scriptCommand = scripts[scriptName] ?? "";
  const shouldForceVitePort =
    /\bvite\b/i.test(scriptCommand) || scriptName === "dev" || scriptName === "preview";
  if (!shouldForceVitePort || /(?:^|\s)--port(?:\s|=|$)/.test(scriptCommand)) {
    return baseCommand;
  }

  return `${baseCommand} -- --host 127.0.0.1 --port ${input.port} --strictPort`;
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

  constructor(private readonly terminalManager: TerminalManagerShape) {}

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

      const port = yield* Effect.tryPromise({
        try: () => reservePort(input.preferredPort ?? DEFAULT_PREVIEW_PORT),
        catch: (cause) => new Error("Unable to reserve a preview port.", { cause }),
      });
      const command = yield* Effect.tryPromise({
        try: () => resolvePreviewCommand({ cwd, port, command: input.command }),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error("Unable to resolve preview command.", { cause }),
      });
      const terminalId = terminalIdForCwd(cwd);
      const url = `http://127.0.0.1:${port}/`;
      const startedAt = nowIso();

      self.updateRecord(record, {
        ...record.state,
        cwd,
        status: "starting",
        url,
        port,
        command,
        terminalId,
        ownedBySynara: true,
        lastError: null,
        startedAt,
        updatedAt: startedAt,
      });

      const openInput: TerminalOpenInput = {
        threadId: input.threadId,
        terminalId,
        cwd,
        cols: 120,
        rows: 30,
        env: {
          BROWSER: "none",
          HOST: "127.0.0.1",
          PORT: String(port),
          T3CODE_NO_BROWSER: "1",
          VITE_HOST: "127.0.0.1",
          VITE_PORT: String(port),
        },
      };
      yield* self.terminalManager.open(openInput);
      const writeInput: TerminalWriteInput = {
        threadId: input.threadId,
        terminalId,
        data: `${command}\r`,
      };
      yield* self.terminalManager.write(writeInput);

      self.scheduleStartPoll(record, url);
      return record.state;
    });
  }

  stop(input: PreviewRuntimeInput): Effect.Effect<PreviewRuntimeState, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const cwd = runtimeKey(input.cwd);
      const record = self.getOrCreateRecord({ ...input, cwd });
      self.clearTimers(record);

      if (record.state.ownedBySynara && record.state.terminalId) {
        yield* self.terminalManager.close({
          threadId: input.threadId,
          terminalId: record.state.terminalId,
          deleteHistory: false,
        });
      }

      self.updateRecord(record, {
        ...record.state,
        status: "stopped",
        lastError: null,
        updatedAt: nowIso(),
      });
      return record.state;
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
    };
    this.records.set(key, record);
    return record;
  }

  private updateRecord(record: PreviewRuntimeRecord, nextState: PreviewRuntimeState): void {
    record.state = nextState;
    const key = runtimeKey(nextState.cwd);
    this.records.set(key, record);
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
    record.failures = 0;
  }
}
