import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { cuaComputerTaskKey, type CuaComputerTask } from "@synara/shared/cuaDriverProtocol";
import { stopNativeHelper } from "./stopNativeHelper";

/**
 * Masked activation shield host: owns the AppSnap `--shield` helper process
 * the way {@link ComputerFrameTap} owns its frame helper — lazily spawned on
 * the first engage, terminated on stop/dispose, and every live shield is
 * tracked so a task end or host teardown can drop it.
 *
 * The helper keeps the deeper guarantees: it watches its parent pid, stdin
 * EOF, a per-shield TTL, and Space/display notifications, and WindowServer
 * tears its windows down outright if the process dies. This class adds the
 * host-side half: command writes, engage confirmation, and attribution so
 * `end_task` and `stop` can release what a generation still has up.
 */

export interface ComputerShieldEngagement {
  /** Caller-minted id — survives a lost engage reply as the cleanup handle. */
  readonly shieldId: string;
  /** Screen rect to cover, top-left-origin points (CGWindowList space). */
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly windowId: number;
  readonly pid: number;
  /** Painted on the shield; already sanitized by the protocol parser. */
  readonly label?: string;
}

export interface ComputerShieldHost {
  /**
   * Present `request`'s shield and resolve once the helper confirms it is on
   * screen. Rejects when the helper cannot engage — the caller treats that
   * as `mask_unavailable` and refuses the activation rather than degrading
   * to an unmasked excursion.
   */
  engage(request: ComputerShieldEngagement, task?: CuaComputerTask): Promise<void>;
  /** Idempotent; resolves after the command is written. */
  release(shieldId: string): Promise<void>;
  /** The forced-release path; resolves with how many live shields it dropped. */
  releaseAll(): Promise<number>;
  /** Release every shield attributed to `task` (thread, or thread+turn). */
  endTask(task: CuaComputerTask): Promise<void>;
  /** Drop every shield and terminate the helper process. */
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

interface LiveShield {
  readonly taskKey: string | undefined;
  readonly threadId: string | undefined;
}

interface ActiveHelper {
  child: ChildProcess;
  lines: Interface;
  exited: boolean;
}

/** An engage that never hears back is a wedged helper, not a slow one. */
const SHIELD_ENGAGE_TIMEOUT_MS = 5_000;

const log = (message: string) => console.info(`[desktop-cua] ${message}`);

export class ComputerShield implements ComputerShieldHost {
  private helper: ActiveHelper | undefined;
  private readonly live = new Map<string, LiveShield>();
  private readonly pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly endedTasks = new Set<string>();
  private closed = false;
  private spawning: Promise<ActiveHelper> | undefined;

  constructor(
    private readonly options: {
      helperPath: string;
      onError?: (error: unknown) => void;
      /** Test seam for a fake helper. */
      spawn?: typeof spawn;
      /** Test seam: bound on a single engage's confirmation wait. */
      engageTimeoutMs?: number;
    },
  ) {}

  async engage(request: ComputerShieldEngagement, task?: CuaComputerTask): Promise<void> {
    if (this.closed) throw new Error("The activation shield host is closed.");
    const taskKey = task ? cuaComputerTaskKey(task) : undefined;
    const helper = await this.ensureStarted();
    const labelPart = request.label !== undefined ? ` ${request.label}` : "";
    const line =
      `engage ${request.shieldId} ${request.frame.x} ${request.frame.y} ` +
      `${request.frame.width} ${request.frame.height}${labelPart}\n`;
    const confirmation = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.shieldId);
        reject(new Error("The activation shield did not confirm in time."));
      }, this.options.engageTimeoutMs ?? SHIELD_ENGAGE_TIMEOUT_MS);
      this.pending.set(request.shieldId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
    });
    // The pending entry exists before the write so a helper that answers
    // within the same tick still finds it.
    if (!this.write(helper, line)) {
      const pending = this.pending.get(request.shieldId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(request.shieldId);
      }
      throw new Error("The activation shield helper is not listening.");
    }
    try {
      await confirmation;
    } catch (error) {
      // The task may have ended mid-engage: nothing to clean — a confirmed
      // shield would already be live, an unconfirmed one is the helper's
      // TTL/EOF problem.
      if (taskKey !== undefined && this.endedTasks.has(taskKey)) {
        await this.release(request.shieldId).catch(() => undefined);
      }
      throw error;
    }
    this.live.set(request.shieldId, {
      taskKey,
      threadId: task?.threadId,
    });
    // A shield confirmed after its task ended must not linger: release it
    // now rather than waiting out the helper's TTL.
    if (taskKey !== undefined && this.endedTasks.has(taskKey)) {
      await this.release(request.shieldId).catch(() => undefined);
    }
  }

  async release(shieldId: string): Promise<void> {
    this.live.delete(shieldId);
    const helper = this.helper;
    if (!helper || helper.exited) return;
    this.write(helper, `release ${shieldId}\n`);
  }

  async releaseAll(): Promise<number> {
    const released = this.live.size;
    this.live.clear();
    const helper = this.helper;
    if (helper && !helper.exited) this.write(helper, "release-all\n");
    return released;
  }

  async endTask(task: CuaComputerTask): Promise<void> {
    this.rememberEnded(task);
    const releases: Promise<void>[] = [];
    for (const [shieldId, shield] of this.live) {
      if (shield.threadId !== task.threadId) continue;
      if (task.turnId !== undefined && shield.taskKey !== cuaComputerTaskKey(task)) continue;
      releases.push(this.release(shieldId));
    }
    // A shield still mid-engage when its task ends is released on
    // confirmation by the endedTasks check in engage() above.
    await Promise.all(releases);
  }

  async stop(): Promise<void> {
    const helper = this.helper;
    this.helper = undefined;
    this.spawning = undefined;
    const released = this.live.size;
    this.live.clear();
    this.failPending(new Error("The activation shield host stopped."));
    if (!helper) return;
    try {
      if (!helper.exited) {
        // Graceful first: `quit` lets the helper drop every shield itself
        // before the signal ladder below. The flush must land before SIGTERM
        // or the command never reaches it.
        const flushed = await new Promise<boolean>((resolve) => {
          if (helper.child.stdin?.writable !== true) return resolve(false);
          helper.child.stdin.write("quit\n", (error) => resolve(error == null));
        });
        if (flushed && !helper.exited) {
          const exited = new Promise<boolean>((resolve) =>
            helper.child.once("exit", () => resolve(true)),
          );
          const deadline = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150));
          await Promise.race([exited, deadline]);
        }
      }
      await stopNativeHelper(helper.child, () => helper.exited);
    } finally {
      helper.lines.close();
    }
    if (released > 0) log(`activation shield stop released ${released} live shield(s)`);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.stop();
  }

  private rememberEnded(task: CuaComputerTask): void {
    this.endedTasks.add(cuaComputerTaskKey(task));
    while (this.endedTasks.size > 256)
      this.endedTasks.delete(this.endedTasks.values().next().value!);
  }

  private write(helper: ActiveHelper, line: string): boolean {
    if (helper.exited || helper.child.stdin?.writable !== true) return false;
    try {
      helper.child.stdin.write(line);
      return true;
    } catch (error) {
      this.options.onError?.(error);
      return false;
    }
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ensureStarted(): Promise<ActiveHelper> {
    const existing = this.helper;
    if (existing && !existing.exited) return Promise.resolve(existing);
    if (this.spawning) return this.spawning;
    const pending = Promise.resolve().then(() => this.start());
    this.spawning = pending;
    pending.catch(() => {
      if (this.spawning === pending) this.spawning = undefined;
    });
    return pending;
  }

  private start(): ActiveHelper {
    const child = (this.options.spawn ?? spawn)(this.options.helperPath, ["--shield"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stdin) {
      child.kill("SIGKILL");
      throw new Error("The activation shield helper has no command channel.");
    }
    const state: ActiveHelper = {
      child,
      lines: createInterface({ input: child.stdout }),
      exited: false,
    };
    child.on("error", (error) => this.helperDied(state, error));
    // Helper exit is terminal for every shield it owned: WindowServer has
    // already torn the windows down, so what remains is bookkeeping — fail
    // the pending engages and drop the live set.
    child.once("exit", () => this.helperDied(state, undefined));
    child.once("close", () => state.lines.close());
    child.stderr?.resume();
    state.lines.on("line", (line) => this.helperLine(line));
    this.helper = state;
    return state;
  }

  private helperDied(state: ActiveHelper, error: unknown): void {
    state.exited = true;
    if (error !== undefined) this.options.onError?.(error);
    if (this.helper === state) this.helper = undefined;
    this.live.clear();
    this.failPending(new Error("The activation shield helper exited."));
  }

  private helperLine(line: string): void {
    if (line.length > 4096) return;
    let message: {
      type?: string;
      id?: unknown;
      state?: unknown;
      code?: unknown;
      message?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "shield" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.state === "engaged") {
        pending.resolve();
      } else {
        pending.reject(
          new Error(
            `The activation shield was refused (${String(message.state ?? "unknown")}${
              typeof message.code === "string" ? `: ${message.code}` : ""
            }).`,
          ),
        );
      }
      return;
    }
    if (message.type === "error") {
      const id = typeof message.id === "string" ? message.id : undefined;
      const pending = id !== undefined ? this.pending.get(id) : undefined;
      if (pending && id !== undefined) {
        this.pending.delete(id);
        pending.reject(
          new Error(`The activation shield failed: ${String(message.message ?? "unknown")}`),
        );
      } else {
        log(`activation shield helper error: ${String(message.message ?? "unknown")}`);
      }
    }
  }
}
