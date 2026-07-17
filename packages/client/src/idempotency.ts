export type CompanionRequestIdGenerator = () => string;

interface PendingRequestId {
  readonly fingerprint: string;
  readonly requestId: string;
}

/**
 * Keeps one request id for one logical mutation until the server acknowledges it.
 * The tracker is intentionally memory-only: Companion commands are never queued or
 * recovered after the client process exits.
 */
export class CompanionRequestIdTracker {
  private readonly pending = new Map<string, PendingRequestId>();

  constructor(private readonly generate: CompanionRequestIdGenerator) {}

  acquire(operation: string, fingerprint: string): string {
    const current = this.pending.get(operation);
    if (current?.fingerprint === fingerprint) return current.requestId;
    const requestId = this.generate();
    this.pending.set(operation, { fingerprint, requestId });
    return requestId;
  }

  acknowledge(operation: string, requestId: string): void {
    if (this.pending.get(operation)?.requestId === requestId) {
      this.pending.delete(operation);
    }
  }

  clear(operation?: string): void {
    if (operation === undefined) this.pending.clear();
    else this.pending.delete(operation);
  }
}
