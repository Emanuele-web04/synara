export const BACKEND_RESTART_BASE_DELAY_MS = 500;
export const BACKEND_RESTART_MAX_DELAY_MS = 10_000;

// breaker for consecutive failed starts: an unbounded respawn loop turns one broken start into gigabytes of disk churn (v0.6.0 wrote a full db backup per attempt); five tries spans ~7.5s backoff
export const BACKEND_MAX_CONSECUTIVE_START_FAILURES = 5;

// bounded output tail retained to explain a give-up — a chatty crash loop can't grow it
export const BACKEND_FAILURE_OUTPUT_TAIL_CHARS = 8_192;
const BACKEND_FAILURE_SUMMARY_MAX_LINES = 8;

export function backendRestartDelayMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt)) - 1;
  return Math.min(BACKEND_RESTART_BASE_DELAY_MS * 2 ** step, BACKEND_RESTART_MAX_DELAY_MS);
}

export type BackendCrashResponse =
  | { readonly kind: "ignore" }
  // a migration-recovery marker (usually written mid-session by the migration that just killed the backend) means recovery owns the process from here
  | { readonly kind: "recover-migration" }
  | { readonly kind: "retry"; readonly delayMs: number; readonly attempt: number }
  | { readonly kind: "give-up"; readonly failures: number };

export interface BackendStartFailureInput {
  readonly quitting: boolean;
  readonly restartPending: boolean;
  readonly migrationRecoveryMarkerPresent: boolean;
}

// failures that matter happen after spawn while the backend boots — the counter is cleared by readiness, never by spawn, or the backoff pins at step 1 forever
export class BackendSupervisionPolicy {
  private failures = 0;
  private givenUp = false;
  // deliberately survives reset(): the recovery prompt shows once per app run, not once per restart attempt
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

  reset(): void {
    this.failures = 0;
    this.givenUp = false;
  }

  recordReadiness(): void {
    this.reset();
  }

  respondToStartFailure(input: BackendStartFailureInput): BackendCrashResponse {
    if (input.quitting || input.restartPending) {
      return { kind: "ignore" };
    }

    // re-checked every crash — the marker is written mid-session by the first failing migration, long after bootstrap read it
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

export class BackendOutputTailDetector {
  private tail = "";

  push(chunk: unknown): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.tail = `${this.tail}${text.replace(/\r/g, "")}`;
    if (this.tail.length > BACKEND_FAILURE_OUTPUT_TAIL_CHARS) {
      this.tail = this.tail.slice(-BACKEND_FAILURE_OUTPUT_TAIL_CHARS);
    }
  }

  read(): string {
    return this.tail;
  }
}

// reduces captured output to the last reported error plus what followed it, else the final lines
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
