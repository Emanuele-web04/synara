export class ToolGuidanceCadence {
  private readonly usesByThread = new Map<string, number>();

  constructor(
    private readonly interval: number,
    private readonly maximumThreads: number,
  ) {
    if (!Number.isInteger(interval) || interval < 1) {
      throw new TypeError("Tool guidance interval must be a positive integer.");
    }
    if (!Number.isInteger(maximumThreads) || maximumThreads < 1) {
      throw new TypeError("Tool guidance thread limit must be a positive integer.");
    }
  }

  shouldRefresh(threadId: string): boolean {
    const uses = (this.usesByThread.get(threadId) ?? 0) + 1;
    this.usesByThread.delete(threadId);
    this.usesByThread.set(threadId, uses);
    while (this.usesByThread.size > this.maximumThreads) {
      this.usesByThread.delete(this.usesByThread.keys().next().value!);
    }
    return uses === 1 || (uses - 1) % this.interval === 0;
  }
}
