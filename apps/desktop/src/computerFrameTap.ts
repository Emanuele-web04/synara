import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  cuaComputerTaskKey,
  type CuaComputerTask,
  type CuaPreviewTarget,
} from "@synara/shared/cuaDriverProtocol";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { stopNativeHelper } from "./stopNativeHelper";

/** Channel carrying live JPEG frames to the renderer: {windowId, seq, jpeg}. */
export const COMPUTER_PREVIEW_FRAME_CHANNEL = DESKTOP_IPC_CHANNELS.computerPreviewFrame;

const FRAME_TAP_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_DEAD_TARGETS = 256;

export interface ComputerPreviewFrame {
  windowId: number;
  seq: number;
  jpeg: Uint8Array;
}

export interface ComputerFrameTapHost {
  update(target: CuaPreviewTarget): void;
  endTask(task: CuaComputerTask): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

interface ActiveTap {
  child: ChildProcess;
  server: Server;
  socketPath: string;
  lines: Interface;
  connection: Socket | undefined;
  task: CuaComputerTask;
  key: string;
  windowId: number;
  exited: boolean;
  retiring: boolean;
}

function tapTargetKey(target: CuaPreviewTarget): string {
  return `${cuaComputerTaskKey(target.task)}:${target.pid}:${target.windowId}`;
}

/**
 * One task, one target, one helper process. Frames travel helper -> unix
 * socket -> renderer; they never enter the driver request path or its
 * operation queue. A dead tap stays dead for its target: update() for the
 * same key never respawns it.
 */
export class ComputerFrameTap implements ComputerFrameTapHost {
  private desired: CuaPreviewTarget | undefined;
  private active: ActiveTap | undefined;
  private reconciling: Promise<void> | undefined;
  private failure: unknown;
  private revision = 0;
  private appliedRevision = -1;
  private sequence = 0;
  private directory: string | undefined;
  private directoryPromise: Promise<string> | undefined;
  private readonly deadTargets = new Set<string>();

  constructor(
    private readonly options: {
      helperPath: string;
      send: (channel: string, frame: ComputerPreviewFrame) => void;
      onError: (error: unknown) => void;
      spawn?: typeof spawn;
    },
  ) {}

  update(target: CuaPreviewTarget): void {
    if (this.deadTargets.has(tapTargetKey(target))) return;
    this.desired = target;
    this.revision += 1;
    void this.reconcile().catch(this.options.onError);
  }

  async endTask(task: CuaComputerTask): Promise<void> {
    const matches = (candidate: CuaComputerTask) =>
      candidate.threadId === task.threadId &&
      (task.turnId === undefined || candidate.turnId === task.turnId);
    if (this.desired && !matches(this.desired.task)) return;
    if (!this.desired && this.active && !matches(this.active.task)) return;
    // The task formally ended; its failure memory ends with it. Without a
    // turnId the end covers every turn of the thread.
    const deadPrefix =
      task.turnId === undefined
        ? `[${JSON.stringify(task.threadId)},`
        : `${cuaComputerTaskKey(task)}:`;
    for (const key of this.deadTargets) {
      if (key.startsWith(deadPrefix)) this.deadTargets.delete(key);
    }
    await this.stop();
  }

  async stop(): Promise<void> {
    this.desired = undefined;
    this.revision += 1;
    await this.reconcile();
  }

  async dispose(): Promise<void> {
    await this.stop();
    const directory = this.directory;
    this.directory = undefined;
    this.directoryPromise = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const work = Promise.resolve().then(() => this.run());
    const tracked = work.finally(() => {
      if (this.reconciling === tracked) this.reconciling = undefined;
      if (!this.failure && this.appliedRevision !== this.revision) return this.reconcile();
    });
    this.reconciling = tracked;
    return tracked;
  }

  private async run(): Promise<void> {
    for (;;) {
      const current = this.active;
      const target = this.desired;
      if (current && (!target || current.exited || current.key !== tapTargetKey(target))) {
        try {
          await this.retire(current);
          if (this.active === current) this.active = undefined;
          this.failure = undefined;
        } catch (error) {
          this.failure = error;
          throw error;
        }
        continue;
      }
      if (!target) {
        this.failure = undefined;
        this.appliedRevision = this.revision;
        return;
      }
      if (this.failure) throw this.failure;
      if (!current) {
        try {
          this.active = await this.start(target);
        } catch (error) {
          this.failure = error;
          throw error;
        }
      }
      if (target === this.desired) {
        this.appliedRevision = this.revision;
        return;
      }
    }
  }

  private async socketDirectory(): Promise<string> {
    if (this.directory) return this.directory;
    if (!this.directoryPromise) {
      const pending = (async () => {
        const directory = await mkdtemp(join(tmpdir(), "synara-frames-"));
        await chmod(directory, 0o700);
        this.directory = directory;
        return directory;
      })();
      this.directoryPromise = pending;
      pending.catch(() => {
        if (this.directoryPromise === pending) this.directoryPromise = undefined;
      });
    }
    return this.directoryPromise;
  }

  private async start(target: CuaPreviewTarget): Promise<ActiveTap> {
    const directory = await this.socketDirectory();
    const socketPath = join(directory, `tap-${randomUUID().slice(0, 8)}.sock`);
    let state: ActiveTap | undefined;
    const server = createServer((socket) => {
      if (state) this.attach(state, socket);
      else socket.destroy();
    });
    server.on("error", (error) => {
      if (state) this.kill(state, error);
      else this.options.onError(error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
    } catch (error) {
      server.close(() => undefined);
      await rm(socketPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const child = (this.options.spawn ?? spawn)(
      this.options.helperPath,
      [
        "--computer-frames",
        "--window-id",
        String(target.windowId),
        "--pid",
        String(target.pid),
        "--out",
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.stdout) {
      server.close(() => undefined);
      await rm(socketPath, { force: true }).catch(() => undefined);
      throw new Error("Computer frame tap helper has no output channel.");
    }
    const lines = createInterface({ input: child.stdout });
    state = {
      child,
      server,
      socketPath,
      lines,
      connection: undefined,
      task: target.task,
      key: tapTargetKey(target),
      windowId: target.windowId,
      exited: false,
      retiring: false,
    };
    const tap = state;
    child.on("error", (error) => this.kill(tap, error));
    // Helper exit ends the tap no matter the cause: the protocol has no
    // graceful-stop event, so every exit is terminal for this target.
    child.once("exit", () => this.kill(tap, undefined));
    child.once("close", () => lines.close());
    child.stderr?.resume();
    lines.on("line", (line) => this.helperLine(tap, line));
    // Claim the slot before returning: a helper connect racing the caller's
    // own assignment would otherwise be rejected as an unknown peer.
    this.active = tap;
    return tap;
  }

  private attach(state: ActiveTap, socket: Socket): void {
    if (state.connection || state.retiring || this.active !== state) {
      socket.destroy();
      return;
    }
    state.connection = socket;
    socket.on("error", () => undefined);
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (pending.length < 4) return;
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > FRAME_TAP_MAX_FRAME_BYTES) {
          this.kill(state, new Error("Computer frame tap sent a malformed frame."));
          return;
        }
        if (pending.length < 4 + length) return;
        const jpeg = pending.subarray(4, 4 + length);
        pending = pending.subarray(4 + length);
        this.deliver(state, jpeg);
      }
    });
    socket.once("close", () => {
      if (state.connection === socket) state.connection = undefined;
    });
  }

  private deliver(state: ActiveTap, jpeg: Uint8Array): void {
    if (this.active !== state || state.retiring || state.exited) return;
    this.sequence += 1;
    try {
      this.options.send(COMPUTER_PREVIEW_FRAME_CHANNEL, {
        windowId: state.windowId,
        seq: this.sequence,
        jpeg,
      });
    } catch (error) {
      this.options.onError(error);
    }
  }

  private helperLine(state: ActiveTap, line: string): void {
    if (line.length > 4096 || this.active !== state) return;
    try {
      const message = JSON.parse(line) as { type?: string; code?: string };
      if (message.type === "error") {
        this.kill(state, new Error(`Computer frame tap: ${message.code ?? "capture failed"}`));
      }
    } catch {
      /* Only protocol lines emitted by the owned helper are consumed. */
    }
  }

  /** Unexpected helper death poisons only this target; retire() kills are exempt. */
  private kill(state: ActiveTap, error: unknown): void {
    const wasExited = state.exited;
    state.exited = true;
    if (error !== undefined) this.options.onError(error);
    if (this.active !== state || state.retiring || wasExited) return;
    this.rememberDead(state.key);
    if (this.desired && tapTargetKey(this.desired) === state.key) {
      this.desired = undefined;
      this.revision += 1;
    }
    void this.reconcile().catch(this.options.onError);
  }

  private rememberDead(key: string): void {
    this.deadTargets.add(key);
    while (this.deadTargets.size > MAX_DEAD_TARGETS)
      this.deadTargets.delete(this.deadTargets.values().next().value!);
  }

  private async retire(state: ActiveTap): Promise<void> {
    state.retiring = true;
    state.connection?.destroy();
    state.connection = undefined;
    try {
      await stopNativeHelper(state.child, () => state.exited);
    } finally {
      state.lines.close();
      if (state.server.listening) {
        await new Promise<void>((resolve) => state.server.close(() => resolve()));
      }
      await rm(state.socketPath, { force: true });
    }
  }
}
