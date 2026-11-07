// FILE: notchIsland.ts
// Purpose: Notch island (macOS, Beta) — the persisted on/off preference, the
//          host for the AppSnap helper's long-running `--island` mode, and the
//          controller that keeps the helper running exactly while the island
//          is supported and on.
// Layer: Desktop main process
// Depends on: filesystem for the preference file; the helper process is
//             spawned through an injectable `spawn` so the host is testable.

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";

import type { DesktopNotchIslandState } from "@synara/contracts";

import { parseAppSnapHelperMessage, type AppSnapHelperMessage } from "./appSnapManager";
import { stopNativeHelper } from "./stopNativeHelper";

const RESPAWN_BASE_DELAY_MS = 1_000;
const RESPAWN_MAX_DELAY_MS = 30_000;
const READY_TIMEOUT_MS = 10_000;
const MAX_HELPER_STDERR_CHARS = 4_000;
const MAX_LABEL_LENGTH = 80;

// ── Preference ──────────────────────────────────────────────────────────────

export interface PersistedNotchIslandPreference {
  readonly version: 1;
  readonly enabled: boolean;
}

/** On by default: the island only exists where the Beta gate already allows it. */
const DEFAULT_PREFERENCE: PersistedNotchIslandPreference = { version: 1, enabled: true };

export function parseNotchIslandPreference(value: unknown): PersistedNotchIslandPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.enabled !== "boolean") return null;
  return { version: 1, enabled: candidate.enabled };
}

export function readNotchIslandPreference(filePath: string): PersistedNotchIslandPreference {
  try {
    return (
      parseNotchIslandPreference(JSON.parse(FS.readFileSync(filePath, "utf8"))) ??
      DEFAULT_PREFERENCE
    );
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function writeNotchIslandPreference(
  filePath: string,
  preference: PersistedNotchIslandPreference,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(preference, null, 2)}\n`, "utf8");
}

// ── Helper host ─────────────────────────────────────────────────────────────

/** Visible island text, localized by desktop main. */
export interface NotchIslandLabels {
  readonly empty: string;
  readonly openApp: string;
}

export interface NotchIslandHostOptions {
  readonly helperPath: string;
  readonly labels: () => NotchIslandLabels;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenApp: () => void;
  readonly onError?: (message: string) => void;
  /** Injectable for tests. */
  readonly spawn?: typeof ChildProcess.spawn;
}

function clampLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
}

/** One stdin line for the helper; JSON keeps titles with spaces intact. */
export function encodeNotchIslandLabelsCommand(labels: NotchIslandLabels): string {
  return `${JSON.stringify({
    type: "labels",
    empty: clampLabel(labels.empty),
    openApp: clampLabel(labels.openApp),
  })}\n`;
}

/**
 * Owns the `--island` helper process. While wanted it keeps one running:
 * an unexpected exit, or a helper that never reports `ready`, is replaced
 * with exponential backoff, and the labels are replayed into every new
 * process. The helper exits on its own when stdin closes or Synara dies.
 */
export class NotchIslandHost {
  readonly #options: NotchIslandHostOptions;
  readonly #spawn: typeof ChildProcess.spawn;
  #child: ChildProcess.ChildProcess | null = null;
  #wanted = false;
  #disposed = false;
  #ready = false;
  #consecutiveFailures = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #readyTimer: NodeJS.Timeout | null = null;

  constructor(options: NotchIslandHostOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? ChildProcess.spawn;
  }

  get isRunning(): boolean {
    return this.#child !== null;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  setWanted(wanted: boolean): void {
    if (this.#disposed) return;
    this.#wanted = wanted;
    if (wanted) {
      if (!this.#child && !this.#restartTimer) this.#spawnHelper();
      return;
    }
    this.#clearTimers();
    this.#consecutiveFailures = 0;
    this.#stopChild();
  }

  /** Re-sends the labels, e.g. after the UI language changed. */
  refreshLabels(): void {
    this.#write(encodeNotchIslandLabelsCommand(this.#options.labels()));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#wanted = false;
    this.#clearTimers();
    this.#stopChild();
  }

  #spawnHelper(): void {
    this.#ready = false;
    const child = this.#spawn(this.#options.helperPath, ["--island"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    const lines = Readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (this.#child !== child || this.#disposed) return;
      const message = parseAppSnapHelperMessage(line);
      if (message) this.#handleMessage(message);
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length >= MAX_HELPER_STDERR_CHARS) return;
      stderr = `${stderr}${chunk}`.slice(0, MAX_HELPER_STDERR_CHARS);
    });
    // A helper that dies mid-write must not surface as an unhandled EPIPE.
    child.stdin?.on("error", () => {});

    child.once("error", () => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#ready = false;
      this.#reportError("The notch island helper could not start.");
      this.#scheduleRestart();
    });
    child.once("close", (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#ready = false;
      const diagnostic = stderr.trim();
      if (code !== 0 && diagnostic.length > 0) {
        this.#reportError(`Notch island helper: ${diagnostic}`);
      }
      this.#scheduleRestart();
    });

    this.#write(encodeNotchIslandLabelsCommand(this.#options.labels()));
    this.#watchReadiness(child);
  }

  #watchReadiness(child: ChildProcess.ChildProcess): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (this.#child !== child || this.#ready || this.#disposed) return;
      this.#child = null;
      this.#reportError("The notch island helper did not report ready; restarting.");
      void stopNativeHelper(
        child,
        () => child.exitCode !== null || child.signalCode !== null,
      ).catch(() => {});
      this.#scheduleRestart();
    }, READY_TIMEOUT_MS);
    this.#readyTimer.unref?.();
  }

  #handleMessage(message: AppSnapHelperMessage): void {
    switch (message.type) {
      case "ready":
        this.#ready = true;
        this.#consecutiveFailures = 0;
        if (this.#readyTimer) {
          clearTimeout(this.#readyTimer);
          this.#readyTimer = null;
        }
        return;
      case "island-open-thread":
        this.#options.onOpenThread(message.threadId);
        return;
      case "island-open-app":
        this.#options.onOpenApp();
        return;
      case "error":
        this.#reportError(message.message);
        return;
      default:
        return;
    }
  }

  #write(line: string): void {
    const stdin = this.#child?.stdin;
    if (!stdin || !stdin.writable) return;
    try {
      stdin.write(line);
    } catch {
      // The close handler owns recovery; the next helper gets the replayed state.
    }
  }

  #scheduleRestart(): void {
    if (this.#disposed || !this.#wanted || this.#restartTimer) return;
    const delay = Math.min(
      RESPAWN_BASE_DELAY_MS * 2 ** this.#consecutiveFailures,
      RESPAWN_MAX_DELAY_MS,
    );
    this.#consecutiveFailures += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#disposed || !this.#wanted || this.#child) return;
      this.#spawnHelper();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #stopChild(): void {
    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    if (!child) return;
    try {
      // Closing stdin is the helper's own exit signal; the signals back it up.
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    void stopNativeHelper(child, () => child.exitCode !== null || child.signalCode !== null).catch(
      (error: unknown) => this.#reportError(error instanceof Error ? error.message : String(error)),
    );
  }

  #clearTimers(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#restartTimer = null;
    this.#readyTimer = null;
  }

  #reportError(message: string): void {
    try {
      this.#options.onError?.(message);
    } catch {
      // Diagnostics must never take the island down.
    }
  }
}

// ── Controller ──────────────────────────────────────────────────────────────

export interface NotchIslandController {
  getState(): DesktopNotchIslandState;
  setEnabled(enabled: boolean): DesktopNotchIslandState;
  /** Re-sends the island text after the UI language changed. */
  refreshLabels(): void;
  dispose(): void;
}

/**
 * `supported` is the authoritative gate (macOS and the Beta feature list).
 * When it is false the preference file is never read or written and the
 * helper never starts, so a Stable build leaves Beta's saved choice inert.
 */
export function createNotchIslandController(input: {
  readonly supported: boolean;
  readonly host: Pick<NotchIslandHost, "setWanted" | "refreshLabels" | "dispose">;
  readonly load: () => PersistedNotchIslandPreference;
  readonly save: (preference: PersistedNotchIslandPreference) => void;
  readonly onError?: (error: unknown) => void;
}): NotchIslandController {
  let preference = input.supported ? input.load() : { version: 1 as const, enabled: false };

  const state = (): DesktopNotchIslandState => ({
    supported: input.supported,
    enabled: input.supported && preference.enabled,
  });
  const reconcile = () => input.host.setWanted(input.supported && preference.enabled);

  reconcile();

  return {
    getState: state,
    setEnabled: (enabled) => {
      if (!input.supported) return state();
      if (enabled !== preference.enabled) {
        preference = { version: 1, enabled };
        try {
          input.save(preference);
        } catch (error) {
          // The live island still follows the new value; only persistence failed.
          input.onError?.(error);
        }
      }
      reconcile();
      return state();
    },
    refreshLabels: () => input.host.refreshLabels(),
    dispose: () => input.host.dispose(),
  };
}
