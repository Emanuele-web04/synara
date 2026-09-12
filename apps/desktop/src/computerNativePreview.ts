import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  cuaComputerTaskKey,
  type CuaComputerTask,
  type CuaPreviewTarget,
} from "@synara/shared/cuaDriverProtocol";
import { stopNativeHelper } from "./stopNativeHelper";

export interface ComputerNativePreviewHost {
  update(target: CuaPreviewTarget): void;
  endTask(task: CuaComputerTask): Promise<void>;
  stop(): Promise<void>;
}

interface PreviewProcess {
  child: ChildProcess;
  lines: Interface;
  task: CuaComputerTask;
  exited: boolean;
  sent: string | undefined;
}

/** Native video stays in the AppSnap helper. Only small target changes use IPC. */
export class ComputerNativePreview implements ComputerNativePreviewHost {
  private desired: CuaPreviewTarget | undefined;
  private process: PreviewProcess | undefined;
  private reconciling: Promise<void> | undefined;
  private failure: unknown;
  private revision = 0;
  private appliedRevision = -1;

  constructor(
    private readonly options: {
      helperPath: string;
      onUserStop(task: CuaComputerTask): void;
      onError(error: unknown): void;
      spawn?: typeof spawn;
    },
  ) {}

  update(target: CuaPreviewTarget): void {
    this.desired = target;
    this.revision += 1;
    void this.reconcile().catch(this.options.onError);
  }

  async endTask(task: CuaComputerTask): Promise<void> {
    const matches = (candidate: CuaComputerTask) =>
      candidate.threadId === task.threadId &&
      (task.turnId === undefined || candidate.turnId === task.turnId);
    if (this.desired && !matches(this.desired.task)) return;
    if (!this.desired && this.process && !matches(this.process.task)) return;
    await this.stop();
  }

  async stop(): Promise<void> {
    this.desired = undefined;
    this.revision += 1;
    await this.reconcile();
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
      const current = this.process;
      const target = this.desired;
      if (
        current &&
        (!target ||
          current.exited ||
          cuaComputerTaskKey(current.task) !== cuaComputerTaskKey(target.task))
      ) {
        try {
          await stopNativeHelper(current.child, () => current.exited);
          current.lines.close();
          if (this.process === current) this.process = undefined;
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
      let active: PreviewProcess;
      try {
        active = current ?? this.start(target.task);
      } catch (error) {
        this.failure = error;
        throw error;
      }
      const command = JSON.stringify({
        taskKey: cuaComputerTaskKey(target.task),
        windowId: target.windowId,
        pid: target.pid,
        label: target.task.label ?? "Computer Use",
        ...(target.cursor ? { cursor: target.cursor } : {}),
      });
      if (active.sent !== command) {
        if (
          !active.child.stdin ||
          active.child.stdin.destroyed ||
          active.child.stdin.writableLength > 16_384
        ) {
          this.desired = undefined;
          this.options.onError(
            new Error("Computer preview helper disconnected or stopped reading."),
          );
          continue;
        }
        active.child.stdin.write(command + "\n");
        active.sent = command;
      }
      // update() coalesces targets while retirement is pending; no queue of frames.
      if (target === this.desired) {
        this.appliedRevision = this.revision;
        return;
      }
    }
  }

  private start(task: CuaComputerTask): PreviewProcess {
    const child = (this.options.spawn ?? spawn)(this.options.helperPath, ["--computer-preview"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdout) throw new Error("Computer preview helper has no output channel.");
    const lines = createInterface({ input: child.stdout });
    const state: PreviewProcess = { child, lines, task, exited: false, sent: undefined };
    this.process = state;
    const failed = (error: unknown) => {
      if (this.process !== state) return;
      this.options.onError(error);
      if (this.desired && cuaComputerTaskKey(this.desired.task) === cuaComputerTaskKey(task)) {
        this.desired = undefined;
        this.revision += 1;
      }
      void this.reconcile().catch(this.options.onError);
    };
    child.on("error", (error) => {
      state.exited = true;
      failed(error);
    });
    child.stdin?.on("error", failed);
    child.stderr?.resume();
    child.once("exit", () => {
      state.exited = true;
      // A crashed helper cannot reopen itself in a capture loop.
      if (
        this.process === state &&
        this.desired &&
        cuaComputerTaskKey(this.desired.task) === cuaComputerTaskKey(task)
      ) {
        this.desired = undefined;
        this.revision += 1;
      }
    });
    child.once("close", () => lines.close());
    lines.on("line", (line) => {
      if (line.length > 4096 || this.process !== state) return;
      try {
        const message = JSON.parse(line) as { type?: string; taskKey?: string; code?: string };
        if (message.taskKey !== cuaComputerTaskKey(task)) return;
        if (message.type === "user-stopped") {
          if (this.desired && cuaComputerTaskKey(this.desired.task) === cuaComputerTaskKey(task)) {
            this.desired = undefined;
            this.revision += 1;
          }
          this.options.onUserStop(task);
        } else if (message.type === "preview-error") {
          this.options.onError(new Error(`Computer preview: ${message.code ?? "capture failed"}`));
        }
      } catch {
        /* Only protocol lines emitted by the owned helper are consumed. */
      }
    });
    return state;
  }
}
