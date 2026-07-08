const BASE_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 10_000;

export const BACKEND_STABLE_UPTIME_MS = 30_000;

export class BackendRestartBackoff {
  private attempt = 0;

  nextDelayMs(): number {
    const delayMs = Math.min(BASE_RESTART_DELAY_MS * 2 ** this.attempt, MAX_RESTART_DELAY_MS);
    this.attempt += 1;
    return delayMs;
  }

  reset(): void {
    this.attempt = 0;
  }

  resetAfterStableRun(uptimeMs: number): void {
    if (uptimeMs >= BACKEND_STABLE_UPTIME_MS) {
      this.reset();
    }
  }
}
