// FILE: backendSupervisionPolicy.ts
// Purpose: Pure crash-supervision policy for the desktop backend: restart backoff,
//          the give-up circuit breaker, and the output tail used to explain it.
// Layer: Desktop backend supervision
// Exports: BackendSupervisionPolicy, BackendOutputTailDetector, summarizeBackendFailureOutput

/** First backoff step; doubles per consecutive failed start. */
export const BACKEND_RESTART_BASE_DELAY_MS = 500;
export const BACKEND_RESTART_MAX_DELAY_MS = 10_000;

/**
 * Consecutive failed backend starts — with no readiness signal in between — after
 * which the desktop stops respawning and asks the user what to do.
 *
 * A backend that dies *during* startup can do expensive work before it fails
 * (v0.6.0 wrote a full pre-migration database backup on every attempt), so an
 * unbounded respawn loop turns one broken start into gigabytes of disk churn.
 * Five attempts spans ~7.5s of backoff: long enough to ride out a transient port
 * or filesystem race, short enough that a deterministic startup failure is
 * reported to the user almost immediately instead of never.
 */
export const BACKEND_MAX_CONSECUTIVE_START_FAILURES = 5;

/** Retained backend output used to explain a give-up; bounded so a chatty crash loop cannot grow it. */
export const BACKEND_FAILURE_OUTPUT_TAIL_CHARS = 8_192;
const BACKEND_FAILURE_SUMMARY_MAX_LINES = 8;

export function backendRestartDelayMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt)) - 1;
  return Math.min(BACKEND_RESTART_BASE_DELAY_MS * 2 ** step, BACKEND_RESTART_MAX_DELAY_MS);
}

export type BackendCrashResponse =
  /** Shutting down, or a restart is already armed: the caller does nothing. */
  | { readonly kind: "ignore" }
  /**
   * A migration-recovery marker appeared (usually written mid-session by the very
   * migration that just killed the backend). Recovery owns the process from here.
   */
  | { readonly kind: "recover-migration" }
  | { readonly kind: "retry"; readonly delayMs: number; readonly attempt: number }
  | { readonly kind: "give-up"; readonly failures: number };

export interface BackendStartFailureInput {
  readonly quitting: boolean;
  /** A restart timer is already armed for an earlier failure in this cycle. */
  readonly restartPending: boolean;
  /** The server-owned migration-recovery marker exists right now. */
  readonly migrationRecoveryMarkerPresent: boolean;
}

/**
 * Tracks consecutive backend start failures.
 *
 * Spawning a child process practically always succeeds — the failures we care
 * about happen afterwards, while the backend boots — so the counter is cleared by
 * readiness (or by a deliberate lifecycle start), never by a successful spawn.
 * Clearing it on spawn is what pins the backoff at its first step forever.
 */
export class BackendSupervisionPolicy {
  private failures = 0;
  private givenUp = false;
  // Deliberately not cleared by reset(): the recovery prompt is shown once per app
  // run, not once per restart attempt.
  private migrationRecoveryPrompted = false;

  get consecutiveFailures(): number {
    return this.failures;
  }

  get hasGivenUp(): boolean {
    return this.givenUp;
  }

  get hasPromptedMigrationRecovery(): boolean {
    return this.migrationRecoveryPrompted;
  }

  /** Clears the backoff and the breaker for a deliberate (non-crash) backend start. */
  reset(): void {
    this.failures = 0;
    this.givenUp = false;
  }

  /** The backend actually reached readiness, so the previous failures are history. */
  recordReadiness(): void {
    this.reset();
  }

  respondToStartFailure(input: BackendStartFailureInput): BackendCrashResponse {
    if (input.quitting || input.restartPending) {
      return { kind: "ignore" };
    }

    // Re-checked on every crash: the marker is written mid-session by the first
    // failing migration, long after desktop bootstrap read it.
    if (input.migrationRecoveryMarkerPresent && !this.migrationRecoveryPrompted) {
      this.migrationRecoveryPrompted = true;
      return { kind: "recover-migration" };
    }

    if (this.givenUp) {
      return { kind: "give-up", failures: this.failures };
    }

    this.failures += 1;
    if (this.failures >= BACKEND_MAX_CONSECUTIVE_START_FAILURES) {
      this.givenUp = true;
      return { kind: "give-up", failures: this.failures };
    }

    return {
      kind: "retry",
      delayMs: backendRestartDelayMs(this.failures),
      attempt: this.failures,
    };
  }
}

/** Keeps the tail of a backend session's output so a give-up can quote the real error. */
export class BackendOutputTailDetector {
  // Rolling window of decoded chunks, joined only when a crash reads it, so a
  // long-lived backend does not rebuild an 8 KB string for every chunk.
  private chunks: string[] = [];
  private head = 0;
  private length = 0;

  push(chunk: unknown): void {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const text = raw.includes("\r") ? raw.replace(/\r/g, "") : raw;
    if (text.length === 0) return;
    if (text.length >= BACKEND_FAILURE_OUTPUT_TAIL_CHARS) {
      this.chunks = [text.slice(-BACKEND_FAILURE_OUTPUT_TAIL_CHARS)];
      this.head = 0;
      this.length = BACKEND_FAILURE_OUTPUT_TAIL_CHARS;
      return;
    }
    this.chunks.push(text);
    this.length += text.length;
    // Drop whole chunks that fall entirely outside the window.
    while (
      this.length - (this.chunks[this.head]?.length ?? 0) >=
      BACKEND_FAILURE_OUTPUT_TAIL_CHARS
    ) {
      this.length -= this.chunks[this.head]?.length ?? 0;
      // Release the dropped text now; the slot itself is compacted below.
      this.chunks[this.head] = "";
      this.head += 1;
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  read(): string {
    const tail = this.chunks.slice(this.head).join("");
    return tail.length > BACKEND_FAILURE_OUTPUT_TAIL_CHARS
      ? tail.slice(-BACKEND_FAILURE_OUTPUT_TAIL_CHARS)
      : tail;
  }
}

/**
 * Reduces captured backend output to the few lines worth putting in a dialog:
 * the last reported error and whatever followed it, else the final lines.
 */
export function summarizeBackendFailureOutput(
  output: string,
  maxLines: number = BACKEND_FAILURE_SUMMARY_MAX_LINES,
): string {
  const lines = output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }

  let errorIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && /error/i.test(line)) {
      errorIndex = index;
      break;
    }
  }

  const start = errorIndex >= 0 ? errorIndex : Math.max(0, lines.length - maxLines);
  return lines.slice(start, start + maxLines).join("\n");
}
