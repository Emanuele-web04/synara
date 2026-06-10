// FILE: main.backendProcess.ts
// Purpose: Own the backend child-process lifecycle — spawn, output capture, crash restart, teardown.
// Layer: Desktop main process
// Exports: BackendProcessController, BackendProcessControllerDeps.

import type * as ChildProcess from "node:child_process";

import type { ServerListeningDetector } from "./serverListeningDetector";

export interface BackendProcessControllerDeps {
  readonly spawn: typeof ChildProcess.spawn;
  readonly execPath: string;
  readonly resolveBackendEntry: () => string;
  readonly resolveBackendCwd: () => string;
  readonly backendEntryExists: (entry: string) => boolean;
  readonly buildEnv: () => NodeJS.ProcessEnv;
  readonly getBackendPort: () => number;
  readonly createListeningDetector: () => ServerListeningDetector;
  readonly captureBackendLogs: () => boolean;
  readonly writeBackendLog: (buffer: Buffer) => void;
  readonly writeSessionBoundary: (phase: "START" | "END", details: string) => void;
  readonly getIsQuitting: () => boolean;
  readonly cancelReadinessWait: () => void;
  readonly reserveEndpoint: (reason: string) => Promise<void>;
  readonly ensureInitialWindowOpen: () => void;
  readonly formatErrorMessage: (error: unknown) => string;
  readonly forceKillDelayMs: number;
  readonly shutdownTimeoutMs: number;
}

// Manages a single backend Node child process plus its crash-restart backoff and the
// ServerListeningDetector tied to its current incarnation. Behavior mirrors the original
// inline lifecycle in main.ts exactly (same spawn flags, restart cadence, kill timing).
export class BackendProcessController {
  private backendProcess: ChildProcess.ChildProcess | null = null;
  private listeningDetector: ServerListeningDetector | null = null;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: BackendProcessControllerDeps) {}

  getListeningPromise(): Promise<void> | null {
    return this.listeningDetector?.promise ?? null;
  }

  captureBackendOutput(child: ChildProcess.ChildProcess): void {
    const attachStream = (stream: NodeJS.ReadableStream | null | undefined): void => {
      stream?.on("data", (chunk: unknown) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
        this.deps.writeBackendLog(buffer);
        this.listeningDetector?.push(buffer);
      });
    };

    attachStream(child.stdout);
    attachStream(child.stderr);
  }

  scheduleRestart(reason: string): void {
    if (this.deps.getIsQuitting() || this.restartTimer) return;

    const delayMs = Math.min(500 * 2 ** this.restartAttempt, 10_000);
    this.restartAttempt += 1;
    console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartAfterCrash(reason);
    }, delayMs);
  }

  private async restartAfterCrash(reason: string): Promise<void> {
    if (this.deps.getIsQuitting() || this.backendProcess) {
      return;
    }

    this.deps.cancelReadinessWait();
    try {
      await this.deps.reserveEndpoint("backend restart");
    } catch (error) {
      this.scheduleRestart(
        `failed to reserve restart port after ${reason}: ${this.deps.formatErrorMessage(error)}`,
      );
      return;
    }

    this.start();
    this.deps.ensureInitialWindowOpen();
  }

  start(): void {
    if (this.deps.getIsQuitting() || this.backendProcess) return;

    const backendEntry = this.deps.resolveBackendEntry();
    if (!this.deps.backendEntryExists(backendEntry)) {
      this.scheduleRestart(`missing server entry at ${backendEntry}`);
      return;
    }

    const captureBackendLogs = this.deps.captureBackendLogs();
    const child = this.deps.spawn(this.deps.execPath, [backendEntry], {
      cwd: this.deps.resolveBackendCwd(),
      // In Electron main, process.execPath points to the Electron binary.
      // Run the child in Node mode so this backend process does not become a GUI app instance.
      env: {
        ...this.deps.buildEnv(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: captureBackendLogs ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const listeningDetector = this.deps.createListeningDetector();
    this.listeningDetector = listeningDetector;
    this.backendProcess = child;
    let backendSessionClosed = false;
    const closeBackendSession = (details: string) => {
      if (backendSessionClosed) return;
      backendSessionClosed = true;
      this.deps.writeSessionBoundary("END", details);
    };
    this.deps.writeSessionBoundary(
      "START",
      `pid=${child.pid ?? "unknown"} port=${this.deps.getBackendPort()} cwd=${this.deps.resolveBackendCwd()}`,
    );
    this.captureBackendOutput(child);

    child.once("spawn", () => {
      this.restartAttempt = 0;
    });

    child.on("error", (error) => {
      if (this.listeningDetector === listeningDetector) {
        listeningDetector.fail(error);
        this.listeningDetector = null;
      }
      if (this.backendProcess === child) {
        this.backendProcess = null;
      }
      closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
      this.scheduleRestart(error.message);
    });

    child.on("exit", (code, signal) => {
      if (this.listeningDetector === listeningDetector) {
        listeningDetector.fail(
          new Error(
            `backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`,
          ),
        );
        this.listeningDetector = null;
      }
      if (this.backendProcess === child) {
        this.backendProcess = null;
      }
      closeBackendSession(
        `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (this.deps.getIsQuitting()) return;
      const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.scheduleRestart(reason);
    });
  }

  stop(): void {
    this.deps.cancelReadinessWait();
    this.listeningDetector = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.backendProcess;
    this.backendProcess = null;
    if (!child) return;

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, this.deps.forceKillDelayMs).unref();
    }
  }

  async stopAndWaitForExit(timeoutMs = this.deps.shutdownTimeoutMs): Promise<void> {
    this.deps.cancelReadinessWait();
    this.listeningDetector = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.backendProcess;
    this.backendProcess = null;
    if (!child) return;
    const backendChild = child;
    if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

      function settle(): void {
        if (settled) return;
        settled = true;
        backendChild.off("exit", onExit);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        if (exitTimeoutTimer) {
          clearTimeout(exitTimeoutTimer);
        }
        resolve();
      }

      function onExit(): void {
        settle();
      }

      backendChild.once("exit", onExit);
      backendChild.kill("SIGTERM");

      const forceKillDelayMs = Math.min(this.deps.forceKillDelayMs, Math.max(1, timeoutMs - 500));
      forceKillTimer = setTimeout(() => {
        if (backendChild.exitCode === null && backendChild.signalCode === null) {
          backendChild.kill("SIGKILL");
        }
      }, forceKillDelayMs);
      forceKillTimer.unref();

      exitTimeoutTimer = setTimeout(() => {
        settle();
      }, timeoutMs);
      exitTimeoutTimer.unref();
    });
  }
}
