// FILE: updateStallSuppression.ts
// Purpose: Track expected updater cancellation errors after a stalled-download cancel, with a time-bounded count.
// Layer: Desktop main process
// Exports: StalledDownloadCancellationSuppression.

export class StalledDownloadCancellationSuppression {
  private remaining = 0;
  private expiresAtMs = 0;

  constructor(private readonly windowMs: number) {}

  clear(): void {
    this.remaining = 0;
    this.expiresAtMs = 0;
  }

  arm(): void {
    this.remaining += 1;
    this.expiresAtMs = Date.now() + this.windowMs;
  }

  isArmed(): boolean {
    if (this.remaining <= 0) {
      return false;
    }
    if (Date.now() <= this.expiresAtMs) {
      return true;
    }
    this.clear();
    return false;
  }

  consume(): void {
    this.remaining = Math.max(0, this.remaining - 1);
    if (this.remaining === 0) {
      this.expiresAtMs = 0;
    }
  }
}
