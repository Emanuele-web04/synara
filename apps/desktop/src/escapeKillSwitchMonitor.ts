import * as ChildProcess from "node:child_process";
import * as Readline from "node:readline";

import { parseAppSnapHelperMessage, type AppSnapHelperMessage } from "./appSnapManager";

const RESPAWN_BASE_DELAY_MS = 1_000;
const RESPAWN_MAX_DELAY_MS = 30_000;
const MAX_HELPER_STDERR_CHARS = 4_000;

export interface EscapeKillSwitchMonitorOptions {
  helperPath: string;
  /**
   * Called for every physical, unmodified Escape the armed helper observed.
   * The callback owns all kill semantics — this class only transports the
   * event and tracks which side of the arm gate the helper is on.
   */
  onEscape: () => void;
  onError?: (message: string) => void;
  /** Injectable for tests. */
  spawn?: typeof ChildProcess.spawn;
}

/**
 * Owns the dedicated `--escape-monitor` helper process for the desktop.
 *
 * The helper's listen-only event tap observes physical Escape keypresses and
 * reports them without consuming them. It only reports while armed, so this
 * class forwards `setArmed` (driven by the computer host's live driver
 * generation) as `arm`/`disarm` stdin lines. An unexpected helper exit is
 * retried with exponential backoff; the armed flag is replayed after every
 * respawn so a restarted helper resumes on the same side of the gate.
 *
 * A helper that never gains Input Monitoring permission simply reports no
 * events — the kill switch degrades to the ordinary visible-stop paths rather
 * than breaking Escape itself, because the tap is listen-only.
 */
export class EscapeKillSwitchMonitor {
  #options: EscapeKillSwitchMonitorOptions;
  #spawn: typeof ChildProcess.spawn;
  #child: ChildProcess.ChildProcess | null = null;
  #disposed = false;
  #armed = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #consecutiveFailures = 0;

  constructor(options: EscapeKillSwitchMonitorOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? ChildProcess.spawn;
  }

  get isRunning(): boolean {
    return this.#child !== null;
  }

  start(): void {
    if (this.#disposed || this.#child) return;
    this.#spawnHelper();
  }

  setArmed(armed: boolean): void {
    this.#armed = armed;
    if (armed) this.#writeCommand("arm");
    else this.#writeCommand("disarm");
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    this.#child = null;
    try {
      child?.kill("SIGTERM");
    } catch {
      // Best effort; the helper also exits itself once its parent is gone.
    }
  }

  #spawnHelper(): void {
    const child = this.#spawn(this.#options.helperPath, ["--escape-monitor"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    const lines = Readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = parseAppSnapHelperMessage(line);
      if (message) this.#handleMessage(message);
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length >= MAX_HELPER_STDERR_CHARS) return;
      stderr = `${stderr}${chunk}`.slice(0, MAX_HELPER_STDERR_CHARS);
    });

    child.once("error", () => {
      if (this.#child === child) this.#child = null;
      this.#reportError("The Escape monitor helper could not start.");
      if (!this.#disposed) this.#scheduleRestart();
    });
    child.once("close", (code) => {
      if (this.#child === child) this.#child = null;
      const diagnostic = stderr.trim();
      if (code !== 0 && diagnostic.length > 0) {
        this.#reportError(`Escape monitor helper: ${diagnostic}`);
      }
      if (!this.#disposed) this.#scheduleRestart();
    });

    // A fresh helper starts disarmed; replay the armed side of the gate so a
    // respawn does not silently widen the window where Escape is inert.
    if (this.#armed) this.#writeCommand("arm");
  }

  #handleMessage(message: AppSnapHelperMessage): void {
    switch (message.type) {
      case "ready":
        this.#consecutiveFailures = 0;
        return;
      case "escape":
        this.#options.onEscape();
        return;
      case "escape-monitor-state":
        return;
      case "error":
        this.#reportError(message.message);
        return;
      default:
        return;
    }
  }

  #writeCommand(command: "arm" | "disarm"): void {
    try {
      this.#child?.stdin?.write(`${command}\n`);
    } catch {
      // The close handler owns recovery; a lost arm update is corrected on
      // the next respawn because the armed flag is replayed.
    }
  }

  #scheduleRestart(): void {
    if (this.#disposed || this.#restartTimer) return;
    const delay = Math.min(
      RESPAWN_BASE_DELAY_MS * 2 ** this.#consecutiveFailures,
      RESPAWN_MAX_DELAY_MS,
    );
    this.#consecutiveFailures += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#disposed) return;
      this.#spawnHelper();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #reportError(message: string): void {
    try {
      this.#options.onError?.(message);
    } catch {
      // Diagnostics must never take the monitor down.
    }
  }
}
